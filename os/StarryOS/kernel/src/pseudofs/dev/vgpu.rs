//! `/dev/dri/card0` — the `VIRTGPU_*` DRM ioctl family (3D face).
//!
//! This module turns card0 into the guest-side counterpart of Linux's
//! `drivers/gpu/drm/virtio` for the subset the mesa venus Vulkan driver
//! exercises: GETPARAM / GET_CAPS / CONTEXT_INIT / RESOURCE_CREATE_BLOB /
//! RESOURCE_INFO / MAP / EXECBUFFER / GEM_CLOSE, plus the generic-DRM
//! syncobj family venus uses for fences (CREATE / DESTROY / QUERY /
//! SIGNAL / RESET / TIMELINE_SIGNAL / TIMELINE_WAIT).
//!
//! All device work goes through the 3D face published by the virtio-gpu
//! driver ([`ax_driver::vgpu::global_3d`]). On a device without the 3D
//! features (plain 2D virtio-gpu), the handle is `None` and every ioctl
//! here reports `ENOSYS`, matching this driver's behaviour before the
//! 3D face existed.
//!
//! v1 modelling notes (documented deviations from Linux):
//! - Context and buffer state is keyed by process identity, not by
//!   drm_file: the device ops layer has no per-fd hook. venus opens one
//!   fd per process, so this is behaviourally equivalent for the
//!   consumers we target.
//! - Every control command completes synchronously inside the driver's
//!   queue lock, so an EXECBUFFER fence is "signalled when the ioctl
//!   returns" and TIMELINE_WAIT observes already-signalled points.
//!   An async submit + IRQ-event path is future work.
//! - `DRM_IOCTL_SYNCOBJ_EVENTFD` and sync_file import/export stay
//!   ENOSYS; venus uses the timeline path exclusively.

use alloc::{
    borrow::Cow,
    collections::BTreeMap,
    format,
    string::String,
    sync::Arc,
    vec,
    vec::Vec,
};
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use ax_alloc::GlobalPage;
use ax_memory_addr::{PAGE_SIZE_4K, PhysAddr, PhysAddrRange};
use axpoll::{IoEvents, Pollable};
use linux_raw_sys::general::O_RDWR;
use bytemuck::{AnyBitPattern, NoUninit};

use super::drm::{
    DRM_FORMAT_ARGB8888, DRM_FORMAT_XRGB8888, DRM_TYPE, DrmPrimeHandle, iow, iowr,
};
use crate::{
    file::{FileLike, Kstat, add_file_like, get_file_like},
    mm::{vm_load, vm_write_slice},
    pseudofs::DeviceMmap,
    sync::Mutex,
    task::UserTaskRef,
};
use axfs_ng_vfs::VfsError;

type VfsResult<T = ()> = Result<T, VfsError>;

/// Maps a driver-side errno onto the VFS error the ioctl layer reports.
fn vfs_err(err: ax_driver::vgpu::Gpu3DError) -> VfsError {
    match err {
        ax_driver::vgpu::Gpu3DError::UNSUPPORTED => VfsError::OperationNotSupported,
        ax_driver::vgpu::Gpu3DError::NO_DEVICE => VfsError::NoSuchDevice,
        ax_driver::vgpu::Gpu3DError::NO_MEMORY => VfsError::NoMemory,
        ax_driver::vgpu::Gpu3DError::INVALID => VfsError::InvalidInput,
        ax_driver::vgpu::Gpu3DError::TIMEOUT => VfsError::TimedOut,
        _ => VfsError::Io,
    }
}

// ---- UAPI: include/uapi/drm/virtgpu_drm.h ----
//
// The VIRTGPU ioctl nrs are `DRM_COMMAND_BASE (0x40) + <family nr>`:
// 0x41..0x4B sits inside the driver-specific range and stays clear of
// both the core ioctls (<0x40) and the MODE_* ioctls (>=0xA0). GEM_CLOSE
// (core 0x09) and the syncobj family (core 0xBF..0xCF) encode their
// plain nrs without the base, exactly as drm.h defines them.

pub const DRM_IOCTL_VIRTGPU_MAP: u32 = iowr::<DrmVirtgpuMap>(DRM_TYPE, 0x41);
pub const DRM_IOCTL_VIRTGPU_EXECBUFFER: u32 = iowr::<DrmVirtgpuExecbuffer>(DRM_TYPE, 0x42);
pub const DRM_IOCTL_VIRTGPU_GETPARAM: u32 = iowr::<DrmVirtgpuGetparam>(DRM_TYPE, 0x43);
pub const DRM_IOCTL_VIRTGPU_RESOURCE_INFO: u32 = iowr::<DrmVirtgpuResourceInfo>(DRM_TYPE, 0x45);
pub const DRM_IOCTL_VIRTGPU_GET_CAPS: u32 = iowr::<DrmVirtgpuGetCaps>(DRM_TYPE, 0x49);
pub const DRM_IOCTL_VIRTGPU_RESOURCE_CREATE_BLOB: u32 =
    iowr::<DrmVirtgpuResourceCreateBlob>(DRM_TYPE, 0x4a);
pub const DRM_IOCTL_VIRTGPU_CONTEXT_INIT: u32 = iowr::<DrmVirtgpuContextInit>(DRM_TYPE, 0x4b);

/// `DRM_IOCTL_GEM_CLOSE` — generic GEM handle teardown (core nr 0x09,
/// no conflict with the driver-specific VIRTGPU nrs on the base).
pub const DRM_IOCTL_GEM_CLOSE: u32 = iow::<DrmGemClose>(DRM_TYPE, 0x09);

// Generic-DRM syncobj family (core nrs 0xBF..0xCF; the card0 MODE_*
// consts stop at 0xBE so nothing collides).
pub const DRM_IOCTL_SYNCOBJ_CREATE: u32 = iowr::<DrmSyncobjCreate>(DRM_TYPE, 0xBF);
pub const DRM_IOCTL_SYNCOBJ_DESTROY: u32 = iowr::<DrmSyncobjDestroy>(DRM_TYPE, 0xC0);
pub const DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD: u32 = iowr::<DrmSyncobjHandle>(DRM_TYPE, 0xC1);
pub const DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE: u32 = iowr::<DrmSyncobjHandle>(DRM_TYPE, 0xC2);
pub const DRM_IOCTL_SYNCOBJ_WAIT: u32 = iowr::<DrmSyncobjWait>(DRM_TYPE, 0xC3);
pub const DRM_IOCTL_SYNCOBJ_RESET: u32 = iowr::<DrmSyncobjArray>(DRM_TYPE, 0xC4);
pub const DRM_IOCTL_SYNCOBJ_SIGNAL: u32 = iowr::<DrmSyncobjArray>(DRM_TYPE, 0xC5);
pub const DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT: u32 = iowr::<DrmSyncobjTimelineWait>(DRM_TYPE, 0xCA);
pub const DRM_IOCTL_SYNCOBJ_QUERY: u32 = iowr::<DrmSyncobjTimelineArray>(DRM_TYPE, 0xCB);
pub const DRM_IOCTL_SYNCOBJ_TIMELINE_SIGNAL: u32 =
    iowr::<DrmSyncobjTimelineArray>(DRM_TYPE, 0xCD);

// ---- UAPI structs ----

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmVirtgpuMap {
    pub offset: u64,
    pub handle: u32,
    pub pad: u32,
}

pub const VIRTGPU_EXECBUF_FENCE_FD_IN: u32 = 0x01;
pub const VIRTGPU_EXECBUF_FENCE_FD_OUT: u32 = 0x02;
pub const VIRTGPU_EXECBUF_RING_IDX: u32 = 0x04;

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmVirtgpuExecbuffer {
    pub flags: u32,
    pub size: u32,
    pub command: u64,
    pub bo_handles: u64,
    pub num_bo_handles: u32,
    pub fence_fd: i32,
    pub ring_idx: u32,
    pub syncobj_stride: u32,
    pub num_in_syncobjs: u32,
    pub num_out_syncobjs: u32,
    pub in_syncobjs: u64,
    pub out_syncobjs: u64,
}

pub const VIRTGPU_PARAM_3D_FEATURES: u64 = 1;
pub const VIRTGPU_PARAM_CAPSET_QUERY_FIX: u64 = 2;
pub const VIRTGPU_PARAM_RESOURCE_BLOB: u64 = 3;
pub const VIRTGPU_PARAM_HOST_VISIBLE: u64 = 4;
pub const VIRTGPU_PARAM_CROSS_DEVICE: u64 = 5;
pub const VIRTGPU_PARAM_CONTEXT_INIT: u64 = 6;
pub const VIRTGPU_PARAM_SUPPORTED_CAPSET_IDS: u64 = 7;
pub const VIRTGPU_PARAM_EXPLICIT_DEBUG_NAME: u64 = 8;
pub const VIRTGPU_PARAM_BLOB_ALIGNMENT: u64 = 9;

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmVirtgpuGetparam {
    pub param: u64,
    pub value: u64,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmVirtgpuResourceInfo {
    pub bo_handle: u32,
    pub res_handle: u32,
    pub size: u32,
    pub blob_mem: u32,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmVirtgpuGetCaps {
    pub cap_set_id: u32,
    pub cap_set_ver: u32,
    pub addr: u64,
    pub size: u32,
    pub pad: u32,
}

pub const VIRTGPU_BLOB_MEM_HOST3D: u32 = 0x0002;
/// `VIRTIO_GPU_MAP_CACHE_CACHED` — the cache hint the host reports for
/// hostmem blob mappings; decides cacheable vs uncached user mappings.
pub const VIRTGPU_MAP_CACHE_CACHED: u32 = 0x1;

pub const VIRTGPU_BLOB_FLAG_USE_MAPPABLE: u32 = 0x0001;
pub const VIRTGPU_BLOB_FLAG_USE_SHAREABLE: u32 = 0x0002;
pub const VIRTGPU_BLOB_FLAG_USE_CROSS_DEVICE: u32 = 0x0004;
pub const VIRTGPU_BLOB_FLAG_USE_MASK: u32 = VIRTGPU_BLOB_FLAG_USE_MAPPABLE
    | VIRTGPU_BLOB_FLAG_USE_SHAREABLE
    | VIRTGPU_BLOB_FLAG_USE_CROSS_DEVICE;

pub const DRM_VIRTGPU_BLOB_FLAG_HINT_DEFER_MAPPING: u32 = 0x0001;

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmVirtgpuResourceCreateBlob {
    pub blob_mem: u32,
    pub blob_flags: u32,
    pub bo_handle: u32,
    pub res_handle: u32,
    pub size: u64,
    pub pad: u32,
    pub cmd_size: u32,
    pub cmd: u64,
    pub blob_id: u64,
    pub blob_hints: u32,
    pub pad2: u32,
}

pub const VIRTGPU_CONTEXT_PARAM_CAPSET_ID: u64 = 0x0001;
pub const VIRTGPU_CONTEXT_PARAM_NUM_RINGS: u64 = 0x0002;
pub const VIRTGPU_CONTEXT_PARAM_POLL_RINGS_MASK: u64 = 0x0003;
pub const VIRTGPU_CONTEXT_PARAM_DEBUG_NAME: u64 = 0x0004;

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmVirtgpuContextSetParam {
    pub param: u64,
    pub value: u64,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmVirtgpuContextInit {
    pub num_params: u32,
    pub pad: u32,
    pub ctx_set_params: u64,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmGemClose {
    pub handle: u32,
    pub pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmVirtgpuExecbufferSyncobj {
    pub handle: u32,
    pub flags: u32,
    pub point: u64,
}

// ---- UAPI: include/uapi/drm/drm.h syncobj family ----

pub const DRM_SYNCOBJ_CREATE_SIGNALED: u32 = 1 << 0;
pub const DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL: u32 = 1 << 0;
pub const DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT: u32 = 1 << 1;

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmSyncobjCreate {
    pub handle: u32,
    pub flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmSyncobjDestroy {
    pub handle: u32,
    pub pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmSyncobjHandle {
    pub handle: u32,
    pub flags: u32,
    pub fd: i32,
    pub pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmSyncobjWait {
    pub handles: u64,
    pub timeout_nsec: i64,
    pub count_handles: u32,
    pub flags: u32,
    pub first_signaled: u32,
    pub pad: u32,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmSyncobjArray {
    pub handles: u64,
    pub count_handles: u32,
    pub flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmSyncobjTimelineArray {
    pub handles: u64,
    pub points: u64,
    pub count_handles: u32,
    pub flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy, AnyBitPattern, NoUninit)]
pub struct DrmSyncobjTimelineWait {
    pub handles: u64,
    pub points: u64,
    pub timeout_nsec: u64,
    pub count_handles: u32,
    pub flags: u32,
    pub first_signaled: u32,
    pub pad: u32,
    pub deadlines_nsec: u64,
}

// ---- card-side state ----

/// Upper bound for one EXECBUFFER command buffer: contiguous DMA pages,
/// kept well below what the contiguous allocator can satisfy.
const MAX_EXECBUF_BYTES: usize = 2 * 1024 * 1024;
/// Maximum CONTEXT_INIT parameter count, mirroring Linux.
const MAX_CONTEXT_PARAMS: usize = 4;
/// Maximum rings per context, mirroring Linux `MAX_RINGS`.
const MAX_RINGS: u32 = 64;

/// mmap offset keys for host-visible blobs start here so they can never
/// collide with the dumb-buffer offset keys (an 8 MiB stride counter
/// would need ~131k live allocations to reach this range). Keys are
/// handed out page-strided: the mmap file offset must be page-aligned
/// (`sys_mmap` rejects unaligned offsets with EINVAL), and the key *is*
/// the file offset for blob mappings.
pub(crate) const BLOB_MMAP_KEY_BASE: u64 = 1 << 40;
/// Stride between consecutive blob mmap keys (`sys_mmap` requires the
/// file offset to be `PAGE_SIZE_4K`-aligned).
const BLOB_MMAP_KEY_STRIDE: u64 = PAGE_SIZE_4K as u64;
/// Guest-visible granularity of the hostmem BAR. Slots and the wire
/// (host-side) blob size are aligned to this: the macOS host backs QEMU
/// with 16 KiB pages, and a sub-16K-aligned hostmem subsection makes the
/// hvf memory listener skip the EPT mapping (stalling the guest on the
/// first BAR access). The tail between `size` and the rounded wire size
/// is unused padding on the guest side.
const BAR_SLOT_ALIGN: u64 = 0x4000;

/// A blob resource's host-visible mapping.
struct BlobMapping {
    /// Guest-physical start of the mapping (hostmem base + bar_offset).
    phys: u64,
    size: u64,
    /// Synthetic mmap offset handed back by VIRTGPU_MAP.
    mmap_key: u64,
    /// Host cache hint (`virtio_gpu_resp_map_info.map_info`).
    map_info: u32,
}

struct VgpuResource {
    res_handle: u32,
    size: u64,
    blob_mem: u32,
    map: Option<BlobMapping>,
}

#[derive(Clone, Copy)]
struct VgpuContext {
    ctx_id: u32,
    num_rings: u32,
}

/// v1 syncobjs are pure timelines (the only form venus exercises);
/// binary syncobj userspace is emulated on top: "signaled" means
/// `signaled_point >= 1`.
struct SyncobjState {
    /// Timeline watermark: every point `<= signaled_point` is complete.
    signaled_point: u64,
}

/// Cached GET_CAPSET payloads keyed by `(capset_id, version)`.
type CapsetCache = BTreeMap<(u32, u32), Arc<[u8]>>;

/// Per-card VIRTGPU state. Cheap to construct; all device access happens
/// lazily through [`ax_driver::vgpu::global_3d`].
pub(crate) struct VgpuCard {
    /// GEM-style handles for 3D blobs, range-split from dumb handles.
    next_bo_handle: AtomicU32,
    next_ctx_id: AtomicU32,
    next_res_id: AtomicU32,
    next_syncobj: AtomicU32,
    next_mmap_key: AtomicU64,
    next_bar_offset: AtomicU64,
    resources: Mutex<BTreeMap<u32, VgpuResource>>,
    contexts: Mutex<BTreeMap<u64, VgpuContext>>,
    syncobjs: Mutex<BTreeMap<u32, Arc<Mutex<SyncobjState>>>>,
    /// Lazily enumerated `(capset_id, max_version, max_size)` list.
    capsets: Mutex<Option<Vec<(u32, u32, u32)>>>,
    /// Cached GET_CAPSET payloads keyed by `(id, version)`.
    capset_cache: Mutex<CapsetCache>,
}

impl VgpuCard {
    pub(crate) const fn new() -> Self {
        Self {
            // Start well above the dumb-handle range so userspace sees
            // one numeric handle namespace.
            next_bo_handle: AtomicU32::new(0x0100_0000),
            next_ctx_id: AtomicU32::new(1),
            next_res_id: AtomicU32::new(0x1000),
            next_syncobj: AtomicU32::new(1),
            next_mmap_key: AtomicU64::new(BLOB_MMAP_KEY_BASE),
            next_bar_offset: AtomicU64::new(0),
            resources: Mutex::new(BTreeMap::new()),
            contexts: Mutex::new(BTreeMap::new()),
            syncobjs: Mutex::new(BTreeMap::new()),
            capsets: Mutex::new(None),
            capset_cache: Mutex::new(BTreeMap::new()),
        }
    }

    fn dev(&self) -> VfsResult<Arc<dyn ax_driver::vgpu::VirtioGpu3D>> {
        ax_driver::vgpu::global_3d().ok_or(VfsError::OperationNotSupported)
    }

    /// Removes all state for a closing client. card0 calls this on the
    /// last fd close (Linux drm_release semantics).
    pub(crate) fn reset(&self) {
        if let Ok(dev) = self.dev() {
            for res in self.resources.lock().values() {
                if res.map.is_some() {
                    let _ = dev.unmap_blob(res.res_handle);
                }
                let _ = dev.resource_unref(res.res_handle);
            }
            for ctx in self.contexts.lock().values() {
                let _ = dev.ctx_destroy(ctx.ctx_id);
            }
        }
        self.resources.lock().clear();
        self.contexts.lock().clear();
        self.syncobjs.lock().clear();
        *self.capsets.lock() = None;
        self.capset_cache.lock().clear();
    }

    // ---- ioctl handlers ----

    pub(crate) fn handle_getparam(&self, current: &UserTaskRef, arg: usize) -> VfsResult<usize> {
        let args: DrmVirtgpuGetparam = load_arg(current, arg)?;
        let info = self.dev()?.info();
        let value: i32 = match args.param {
            VIRTGPU_PARAM_3D_FEATURES => info.has_3d as i32,
            // The capset-query fix (copy min(user, host) size) is always
            // implemented in this driver.
            VIRTGPU_PARAM_CAPSET_QUERY_FIX => 1,
            VIRTGPU_PARAM_RESOURCE_BLOB => info.has_resource_blob as i32,
            VIRTGPU_PARAM_HOST_VISIBLE => info.has_host_visible as i32,
            VIRTGPU_PARAM_CROSS_DEVICE => 0,
            VIRTGPU_PARAM_CONTEXT_INIT => info.has_context_init as i32,
            VIRTGPU_PARAM_SUPPORTED_CAPSET_IDS => self.capset_id_mask()? as i32,
            VIRTGPU_PARAM_EXPLICIT_DEBUG_NAME => info.has_context_init as i32,
            VIRTGPU_PARAM_BLOB_ALIGNMENT if info.has_blob_alignment => info.blob_alignment as i32,
            VIRTGPU_PARAM_BLOB_ALIGNMENT => return Err(VfsError::NotFound),
            _ => return Err(VfsError::InvalidInput),
        };
        // Linux writes a 4-byte int, not the full u64.
        vm_write_slice(current, args.value as *mut i32, &[value])
            .map_err(|_| VfsError::BadAddress)?;
        Ok(0)
    }

    pub(crate) fn handle_get_caps(&self, current: &UserTaskRef, arg: usize) -> VfsResult<usize> {
        let args: DrmVirtgpuGetCaps = load_arg(current, arg)?;
        if args.size == 0 {
            return Err(VfsError::InvalidInput);
        }
        let dev = self.dev()?;
        let info = dev.info();
        if info.num_capsets == 0 {
            warn!("vgpu GET_CAPS: no capsets");
            return Err(VfsError::OperationNotSupported);
        }

        let capsets = self.enumerate_capsets(&dev)?;
        warn!("vgpu GET_CAPS: want={} capsets={capsets:?}", args.cap_set_id);
        let mut found = None;
        for entry in &capsets {
            warn!("vgpu GET_CAPS: compare entry {entry:?} with want {}", args.cap_set_id);
            if entry.0 == args.cap_set_id {
                found = Some(*entry);
                break;
            }
        }
        let Some((_, max_version, max_size)) = found else {
            warn!("vgpu GET_CAPS: capset {} not in list", args.cap_set_id);
            return Err(VfsError::InvalidInput);
        };
        if max_version < args.cap_set_ver {
            warn!("vgpu GET_CAPS: version {} > max {max_version}", args.cap_set_ver);
            return Err(VfsError::InvalidInput);
        }

        // Fetch (or reuse) the capset payload.
        let payload = {
            let mut cache = self.capset_cache.lock();
            match cache.get(&(args.cap_set_id, args.cap_set_ver)) {
                Some(hit) => hit.clone(),
                None => {
                    let mut buf = vec![0u8; max_size as usize];
                    let total = dev.capset(args.cap_set_id, args.cap_set_ver, &mut buf).map_err(vfs_err)?;
                    buf.truncate(total);
                    let arc: Arc<[u8]> = buf.into();
                    cache.insert((args.cap_set_id, args.cap_set_ver), arc.clone());
                    arc
                }
            }
        };

        let n = (args.size as usize).min(payload.len());
        vm_write_slice(current, args.addr as *mut u8, &payload[..n])
            .map_err(|_| VfsError::BadAddress)?;
        Ok(0)
    }

    pub(crate) fn handle_context_init(&self, current: &UserTaskRef, arg: usize) -> VfsResult<usize> {
        let args: DrmVirtgpuContextInit = load_arg(current, arg)?;
        let info = self.dev()?.info();
        if !info.has_context_init || !info.has_3d {
            return Err(VfsError::InvalidInput);
        }
        if args.num_params as usize > MAX_CONTEXT_PARAMS {
            return Err(VfsError::InvalidInput);
        }
        let params: Vec<DrmVirtgpuContextSetParam> =
            vm_load(current, args.ctx_set_params as *const DrmVirtgpuContextSetParam, args.num_params as usize)
                .map_err(|_| VfsError::BadAddress)?;

        let pid = process_key(current);
        let mut contexts = self.contexts.lock();

        let mut capset_id = 0u32;
        let mut num_rings = 1u32;
        let mut ring_mask = 0u64;
        let mut debug_name = String::new();
        for param in &params {
            match param.param {
                VIRTGPU_CONTEXT_PARAM_CAPSET_ID => {
                    if capset_id != 0 {
                        return Err(VfsError::InvalidInput);
                    }
                    let id = param.value as u32;
                    let capsets = self.enumerate_capsets(&self.dev()?)?;
                    if !capsets.iter().any(|&(cid, _, _)| cid == id) {
                        return Err(VfsError::InvalidInput);
                    }
                    capset_id = id;
                }
                VIRTGPU_CONTEXT_PARAM_NUM_RINGS => {
                    if param.value == 0 || param.value > MAX_RINGS as u64 {
                        return Err(VfsError::InvalidInput);
                    }
                    num_rings = param.value as u32;
                }
                VIRTGPU_CONTEXT_PARAM_POLL_RINGS_MASK => {
                    // Accepted but unused: v1 delivers fence completion
                    // synchronously; no drm_events are generated.
                    ring_mask = param.value;
                }
                VIRTGPU_CONTEXT_PARAM_DEBUG_NAME => {
                    debug_name = load_debug_name(current, param.value)?;
                }
                _ => return Err(VfsError::InvalidInput),
            }
        }
        // A poll-rings mask must only reference declared rings.
        if ring_mask != 0 {
            let valid = if num_rings >= 64 {
                u64::MAX
            } else {
                (1u64 << num_rings) - 1
            };
            if ring_mask & !valid != 0 {
                return Err(VfsError::InvalidInput);
            }
        }

        let ctx_id = self.next_ctx_id.fetch_add(1, Ordering::Relaxed);
        // The renderer rejects empty debug names (the Linux driver always
        // sends the task comm), so fall back to a stable default.
        let debug_name = if debug_name.is_empty() {
            format!("starry-vgpu-{pid}")
        } else {
            debug_name
        };
        self.dev()?.ctx_create(ctx_id, capset_id, capset_id, &debug_name).map_err(vfs_err)?;

        // Linux replaces the drm file's context on a second CONTEXT_INIT
        // instead of failing. A process may also die without close(2)
        // reaching us (fatal exit while another fd keeps the device busy),
        // so a stale entry for a recycled pid must never wedge the next
        // owner: the new context replaces the old, which is destroyed.
        if let Some(stale) = contexts.remove(&pid) {
            warn!(
                "vgpu CONTEXT_INIT replaces stale context pid={pid} ctx_id={}",
                stale.ctx_id
            );
            let _ = self.dev()?.ctx_destroy(stale.ctx_id);
        }
        contexts.insert(pid, VgpuContext { ctx_id, num_rings });
        Ok(0)
    }

    pub(crate) fn handle_resource_create_blob(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmVirtgpuResourceCreateBlob = load_arg(current, arg)?;
        let info = self.dev()?.info();
        if !info.has_resource_blob {
            return Err(VfsError::InvalidInput);
        }
        if args.blob_flags & !VIRTGPU_BLOB_FLAG_USE_MASK != 0 {
            return Err(VfsError::InvalidInput);
        }
        if args.blob_flags & VIRTGPU_BLOB_FLAG_USE_CROSS_DEVICE != 0 {
            return Err(VfsError::InvalidInput);
        }
        // v1 supports host-allocated 3D blobs only; GUEST/HOST3D_GUEST
        // would need backing-store attach commands.
        if args.blob_mem != VIRTGPU_BLOB_MEM_HOST3D {
            return Err(VfsError::InvalidInput);
        }
        if !info.has_3d {
            return Err(VfsError::InvalidInput);
        }
        if !args.cmd_size.is_multiple_of(4) {
            return Err(VfsError::InvalidInput);
        }
        if info.has_blob_alignment
            && info.blob_alignment != 0
            && !args.size.is_multiple_of(info.blob_alignment as u64)
        {
            return Err(VfsError::InvalidInput);
        }

        let pid = process_key(current);
        let ctx = self.contexts.lock().get(&pid).copied();
        let Some(ctx) = ctx else {
            return Err(VfsError::InvalidInput);
        };

        let dev = self.dev()?;

        // Optional initialization command stream, submitted before the
        // blob is created (Linux ordering).
        let init_cmd: Vec<u8> = if args.cmd_size > 0 {
            vm_load::<u8>(current, args.cmd as *const u8, args.cmd_size as usize)
                .map_err(|_| VfsError::BadAddress)?
        } else {
            Vec::new()
        };

        let res_id = self.next_res_id.fetch_add(1, Ordering::Relaxed);
        // TEMP-PROBE(vkprobe): identify which blob the ICD creates.
        warn!(
            "vgpu TEMP-PROBE create_blob res={res_id} blob_mem={:#x} blob_flags={:#x} blob_id={:#x} size={:#x} cmd={}",
            args.blob_mem,
            args.blob_flags,
            args.blob_id,
            args.size,
            args.cmd_size
        );
        // The wire size is rounded up to the BAR slot granularity so the
        // host-side subregion (and every EPT subsection the hvf listener
        // derives from it) stays 16 KiB-aligned; see [`BAR_SLOT_ALIGN`].
        let wire_size = args.size.max(1).div_ceil(BAR_SLOT_ALIGN) * BAR_SLOT_ALIGN;
        dev.resource_create_blob(
            ax_driver::vgpu::BlobParams {
                ctx_id: ctx.ctx_id,
                res_id,
                blob_mem: args.blob_mem,
                blob_flags: args.blob_flags,
                blob_id: args.blob_id,
                size: wire_size,
            },
            &init_cmd,
        )
        .map_err(vfs_err)?;

        // Map mappable blobs into the hostmem BAR right away unless the
        // caller deferred mapping (Linux vram_create behaviour).
        let mut map = if args.blob_flags & VIRTGPU_BLOB_FLAG_USE_MAPPABLE != 0
            && args.blob_hints & DRM_VIRTGPU_BLOB_FLAG_HINT_DEFER_MAPPING == 0
        {
            let Some(hostmem) = info.hostmem else {
                let _ = dev.resource_unref(res_id);
                return Err(VfsError::InvalidInput);
            };
            match self.reserve_bar_slot(hostmem.length, wire_size) {
                Ok(bar_offset) => match dev.map_blob(res_id, bar_offset) {
                    Ok(map_info) => Some(BlobMapping {
                        phys: hostmem.phys_base + bar_offset,
                        size: args.size,
                        mmap_key: 0,
                        map_info,
                    }),
                    Err(err) => {
                        let _ = dev.resource_unref(res_id);
                        warn!("vgpu map_blob failed: {err:?}");
                        return Err(VfsError::Io);
                    }
                },
                Err(err) => {
                    let _ = dev.resource_unref(res_id);
                    return Err(err);
                }
            }
        } else {
            None
        };

        let bo_handle = self.next_bo_handle.fetch_add(1, Ordering::Relaxed);
        if let Some(m) = map.as_mut() {
            m.mmap_key = self
                .next_mmap_key
                .fetch_add(BLOB_MMAP_KEY_STRIDE, Ordering::Relaxed);
        }

        self.resources.lock().insert(
            bo_handle,
            VgpuResource {
                res_handle: res_id,
                size: args.size,
                blob_mem: args.blob_mem,
                map,
            },
        );

        let out = DrmVirtgpuResourceCreateBlob {
            bo_handle,
            res_handle: res_id,
            ..args
        };
        store_arg(current, arg, &out)?;
        Ok(0)
    }

    pub(crate) fn handle_resource_info(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmVirtgpuResourceInfo = load_arg(current, arg)?;
        let resources = self.resources.lock();
        let Some(res) = resources.get(&args.bo_handle) else {
            return Err(VfsError::NotFound);
        };
        let out = DrmVirtgpuResourceInfo {
            bo_handle: args.bo_handle,
            res_handle: res.res_handle,
            size: res.size as u32,
            blob_mem: res.blob_mem,
        };
        store_arg(current, arg, &out)?;
        Ok(0)
    }

    pub(crate) fn handle_map(&self, current: &UserTaskRef, arg: usize) -> VfsResult<usize> {
        let args: DrmVirtgpuMap = load_arg(current, arg)?;
        let resources = self.resources.lock();
        let Some(res) = resources.get(&args.handle) else {
            return Err(VfsError::NotFound);
        };
        let Some(map) = &res.map else {
            return Err(VfsError::InvalidInput);
        };
        let out = DrmVirtgpuMap {
            offset: map.mmap_key,
            handle: args.handle,
            pad: 0,
        };
        store_arg(current, arg, &out)?;
        Ok(0)
    }

    pub(crate) fn handle_gem_close(&self, current: &UserTaskRef, arg: usize) -> VfsResult<usize> {
        let args: DrmGemClose = load_arg(current, arg)?;
        let Some(res) = self.resources.lock().remove(&args.handle) else {
            return Err(VfsError::NotFound);
        };
        let dev = self.dev()?;
        if res.map.is_some() {
            let _ = dev.unmap_blob(res.res_handle);
        }
        let _ = dev.resource_unref(res.res_handle);
        Ok(0)
    }

    /// `DRM_IOCTL_PRIME_HANDLE_TO_FD` for a mapped HOST3D blob: installs a
    /// kernel-local dma-buf stand-in fd that names the blob's GEM handle.
    /// Mesa's gbm/EGL paths export render buffers this way before feeding
    /// the fd back through `FD_TO_HANDLE` + `ADDFB2`; the memory itself is
    /// the blob's hostmem BAR mapping, so no data moves.
    pub(crate) fn handle_prime_handle_to_fd(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let mut args: DrmPrimeHandle = load_arg(current, arg)?;
        let resources = self.resources.lock();
        let res = resources.get(&args.handle).ok_or(VfsError::NotFound)?;
        let Some(map) = &res.map else {
            return Err(VfsError::InvalidInput);
        };
        let file: Arc<dyn FileLike> = Arc::new(VgpuBlobFd {
            bo_handle: args.handle,
            phys: map.phys,
            size: map.size,
            cached: map.map_info == VIRTGPU_MAP_CACHE_CACHED,
        });
        args.fd = add_file_like(file, true).map_err(|_| VfsError::Io)?;
        store_arg(current, arg, &args)?;
        Ok(0)
    }

    /// `DRM_IOCTL_PRIME_FD_TO_HANDLE`: resolves a fd installed by
    /// [`Self::handle_prime_handle_to_fd`] (possibly after SCM_RIGHTS
    /// sharing) back to its GEM handle.
    pub(crate) fn handle_prime_fd_to_handle(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let mut args: DrmPrimeHandle = load_arg(current, arg)?;
        let file = get_file_like(args.fd).map_err(|_| VfsError::InvalidInput)?;
        let blob = file
            .downcast_arc::<VgpuBlobFd>()
            .map_err(|_| VfsError::InvalidInput)?;
        args.handle = blob.bo_handle;
        store_arg(current, arg, &args)?;
        Ok(0)
    }

    pub(crate) fn handle_execbuffer(&self, current: &UserTaskRef, arg: usize) -> VfsResult<usize> {
        let args: DrmVirtgpuExecbuffer = load_arg(current, arg)?;
        const KNOWN_FLAGS: u32 =
            VIRTGPU_EXECBUF_FENCE_FD_IN | VIRTGPU_EXECBUF_FENCE_FD_OUT | VIRTGPU_EXECBUF_RING_IDX;
        if args.flags & !KNOWN_FLAGS != 0
            || args.flags & (VIRTGPU_EXECBUF_FENCE_FD_IN | VIRTGPU_EXECBUF_FENCE_FD_OUT) != 0
        {
            // In/out fence FDs (sync_file) are not modelled in v1; the
            // syncobj path covers venus's needs.
            return Err(VfsError::OperationNotSupported);
        }
        // size == 0 is legal for ring-based contexts: the commands live in
        // the ring buffer and the EXECBUFFER only kicks the host (Linux
        // passes the empty stream through to SUBMIT_3D verbatim).
        if args.size as usize > MAX_EXECBUF_BYTES {
            return Err(VfsError::InvalidInput);
        }

        let pid = process_key(current);
        let ctx = self.contexts.lock().get(&pid).copied();
        let Some(ctx) = ctx else {
            return Err(VfsError::InvalidInput);
        };

        let ring_idx = if args.flags & VIRTGPU_EXECBUF_RING_IDX != 0 {
            if args.ring_idx >= ctx.num_rings {
                return Err(VfsError::InvalidInput);
            }
            Some(args.ring_idx as u8)
        } else {
            None
        };

        // Validate referenced bo handles (Linux uses them for
        // reservations; the host attaches blobs via the context).
        if args.num_bo_handles > 0 {
            let handles: Vec<u32> = vm_load(
                current,
                args.bo_handles as *const u32,
                args.num_bo_handles as usize,
            )
            .map_err(|_| VfsError::BadAddress)?;
            let resources = self.resources.lock();
            for handle in handles {
                if !resources.contains_key(&handle) {
                    return Err(VfsError::NotFound);
                }
            }
        }

        // Copy the command stream into contiguous kernel pages so the
        // device layer can DMA it as one descriptor. Empty streams (ring
        // kicks) skip this entirely. The GlobalPage binding must live at
        // this scope: the slice handed to the submit borrows its pages.
        let cmd_page = if args.size == 0 {
            None
        } else {
            let page_count = args.size.div_ceil(PAGE_SIZE_4K as u32) as usize;
            Some(GlobalPage::alloc_contiguous(page_count, PAGE_SIZE_4K).map_err(|_| VfsError::NoMemory)?)
        };
        if let Some(cmd_page) = &cmd_page {
            // TEMP-PROBE(csblob3): pre-copy read straight off the user VA.
            if let Ok(pre) = vm_load::<u8>(current, args.command as *const u8, 16) {
                warn!(
                    "vgpu TEMP-PROBE pre-copy cs = {:02x}{:02x}{:02x}{:02x} {:02x}{:02x}{:02x}{:02x} {:02x}{:02x}{:02x}{:02x} {:02x}{:02x}{:02x}{:02x}",
                    pre[0], pre[1], pre[2], pre[3], pre[4], pre[5], pre[6], pre[7],
                    pre[8], pre[9], pre[10], pre[11], pre[12], pre[13], pre[14], pre[15]
                );
            }
            let loaded = vm_load::<u8>(current, args.command as *const u8, args.size as usize)
                .map_err(|_| VfsError::BadAddress)?;
            // SAFETY: `cmd_page` is `page_count` pages long and
            // `loaded.len() == args.size` fits inside it.
            let dst = unsafe {
                core::slice::from_raw_parts_mut(
                    cmd_page.start_vaddr().as_usize() as *mut u8,
                    args.size as usize,
                )
            };
            dst.copy_from_slice(&loaded);
        }
        let empty_cmd: [u8; 0] = [];
        let cmd: &[u8] = match &cmd_page {
            // SAFETY: `cmd_page` stays alive for the synchronous submit
            // below, its pages are contiguous (GlobalPage contract), and the
            // device layer only reads them during the round-trip.
            Some(cmd_page) => unsafe {
                core::slice::from_raw_parts(
                    cmd_page.start_vaddr().as_usize() as *const u8,
                    args.size as usize,
                )
            },
            None => &empty_cmd,
        };

        // Read the out-syncobj list before submitting; their points get
        // signalled once the fence retires — synchronously in v1.
        let mut out_syncobjs: Vec<(u32, u64)> = Vec::new();
        if args.num_out_syncobjs > 0 {
            let stride = if args.syncobj_stride == 0 {
                core::mem::size_of::<DrmVirtgpuExecbufferSyncobj>()
            } else {
                args.syncobj_stride as usize
            };
            if stride < core::mem::size_of::<DrmVirtgpuExecbufferSyncobj>() {
                return Err(VfsError::InvalidInput);
            }
            for i in 0..args.num_out_syncobjs as usize {
                let addr = args.out_syncobjs + (i * stride) as u64;
                let entry: DrmVirtgpuExecbufferSyncobj = load_arg(current, addr as usize)
                    .map_err(|_| VfsError::BadAddress)?;
                out_syncobjs.push((entry.handle, entry.point));
            }
        }

        // Linux fences EVERY execbuffer (virtio_gpu_execbuffer_ioctl always
        // allocates an out-fence, and the ring idx rides on it). For a
        // venus context the host defers the SUBMIT_3D response to fence
        // retire regardless, so an unfenced submit would block forever on
        // the synchronous round-trip.
        let fence = true;

        // TEMP-PROBE(vkprobe): surface the wire-level failure reason.
        if let Err(err) = self.dev()?.submit_3d(ctx.ctx_id, cmd, ring_idx, fence) {
            warn!(
                "vgpu TEMP-PROBE submit_3d failed: {err:?} (ctx={} size={} ring={ring_idx:?} fence={fence} out={}",
                ctx.ctx_id,
                args.size,
                out_syncobjs.len()
            );
            return Err(vfs_err(err));
        }
        warn!(
            "vgpu TEMP-PROBE submit ok size={} bo={} in={} out={} cs0={:02x}{:02x}{:02x}{:02x} cs4={:02x}{:02x}{:02x}{:02x}",
            args.size,
            args.num_bo_handles,
            args.num_in_syncobjs,
            out_syncobjs.len(),
            cmd.first().copied().unwrap_or(0),
            cmd.get(1).copied().unwrap_or(0),
            cmd.get(2).copied().unwrap_or(0),
            cmd.get(3).copied().unwrap_or(0),
            cmd.get(4).copied().unwrap_or(0),
            cmd.get(5).copied().unwrap_or(0),
            cmd.get(6).copied().unwrap_or(0),
            cmd.get(7).copied().unwrap_or(0),
        );

        for (handle, point) in out_syncobjs {
            let syncobjs = self.syncobjs.lock();
            let Some(state) = syncobjs.get(&handle) else {
                return Err(VfsError::NotFound);
            };
            let mut state = state.lock();
            state.signaled_point = state.signaled_point.max(point);
        }
        Ok(0)
    }

    /// Resolves a blob mmap key to `(phys, size, cache_hint)` for the
    /// mmap hook.
    pub(crate) fn blob_physical_range(&self, offset: u64) -> Option<(u64, u64, u32)> {
        let resources = self.resources.lock();
        resources.values().find_map(|res| {
            res.map
                .as_ref()
                .filter(|m| m.mmap_key == offset)
                .map(|m| (m.phys, m.size, m.map_info))
        })
    }

    /// TEMP-PROBE(csblob3): dump every mapped blob's BAR range (no
    /// physical dereference — an EL1 read of MMIO phys without the
    /// exception table crashed the kernel last round).
    pub(crate) fn temp_probe_dump_blobs(&self) {
        let resources = self.resources.lock();
        for (bo, res) in resources.iter() {
            let Some(m) = &res.map else { continue };
            warn!(
                "vgpu TEMP-PROBE blob bo={bo} res={} phys={:#x} size={:#x} map_info={:#x}",
                res.res_handle, m.phys, m.size, m.map_info
            );
        }
    }

    // ---- KMS present side (blob scanout) ----

    /// Resolves a GEM handle to a 3D blob resource for the KMS side:
    /// `(res_handle, blob_size)` when `bo_handle` names a blob, `None`
    /// for dumb-buffer handles (card0 handles those directly).
    pub(crate) fn lookup_blob(&self, bo_handle: u32) -> Option<(u32, u64)> {
        let resources = self.resources.lock();
        resources.get(&bo_handle).map(|res| (res.res_handle, res.size))
    }

    /// Displays a blob resource on the host scanout — the zero-copy KMS
    /// present path. The host references the blob's backing memory in
    /// place, so guest writes to the mapped resource are visible without
    /// any transfer command.
    pub(crate) fn set_scanout_blob(&self, params: ax_driver::vgpu::ScanoutBlobParams) -> VfsResult {
        self.dev()?.set_scanout_blob(params).map_err(vfs_err)
    }

    /// Stops displaying the blob bound to the scanout (client released
    /// the scanned-out fb / last card0 fd closed).
    pub(crate) fn disable_scanout(&self) -> VfsResult {
        self.dev()?.disable_scanout(0).map_err(vfs_err)
    }

    /// Restores the 2D scanout surface after a blob scanout replaced it,
    /// so a dumb-buffer present is visible again on mixed 2D+3D devices.
    pub(crate) fn bind_2d_scanout(&self) -> VfsResult {
        self.dev()?.bind_2d_scanout().map_err(vfs_err)
    }

    // ---- syncobj family ----

    pub(crate) fn handle_syncobj_create(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjCreate = load_arg(current, arg)?;
        if args.flags & !DRM_SYNCOBJ_CREATE_SIGNALED != 0 {
            return Err(VfsError::InvalidInput);
        }
        let handle = self.next_syncobj.fetch_add(1, Ordering::Relaxed);
        self.syncobjs.lock().insert(
            handle,
            Arc::new(Mutex::new(SyncobjState {
                signaled_point: u64::from(args.flags & DRM_SYNCOBJ_CREATE_SIGNALED != 0),
            })),
        );
        store_arg(current, arg, &DrmSyncobjCreate {
            handle,
            flags: args.flags,
        })?;
        Ok(0)
    }

    pub(crate) fn handle_syncobj_destroy(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjDestroy = load_arg(current, arg)?;
        self.syncobjs
            .lock()
            .remove(&args.handle)
            .ok_or(VfsError::NotFound)?;
        Ok(0)
    }

    pub(crate) fn handle_syncobj_query(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjTimelineArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(current, args.handles as *const u32, args.count_handles as usize)
            .map_err(|_| VfsError::BadAddress)?;
        let syncobjs = self.syncobjs.lock();
        for (i, handle) in handles.iter().enumerate() {
            let state = syncobjs
                .get(handle)
                .ok_or(VfsError::NotFound)?
                .lock();
            let point = state.signaled_point;
            vm_write_slice(current, (args.points + i as u64 * 8) as *mut u64, &[point])
                .map_err(|_| VfsError::BadAddress)?;
        }
        Ok(0)
    }

    pub(crate) fn handle_syncobj_reset(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(current, args.handles as *const u32, args.count_handles as usize)
            .map_err(|_| VfsError::BadAddress)?;
        let syncobjs = self.syncobjs.lock();
        for handle in handles {
            syncobjs
                .get(&handle)
                .ok_or(VfsError::NotFound)?
                .lock()
                .signaled_point = 0;
        }
        Ok(0)
    }

    pub(crate) fn handle_syncobj_signal(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(current, args.handles as *const u32, args.count_handles as usize)
            .map_err(|_| VfsError::BadAddress)?;
        let syncobjs = self.syncobjs.lock();
        for handle in handles {
            let mut state = syncobjs.get(&handle).ok_or(VfsError::NotFound)?.lock();
            state.signaled_point = state.signaled_point.max(1);
        }
        Ok(0)
    }

    pub(crate) fn handle_syncobj_timeline_signal(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjTimelineArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(current, args.handles as *const u32, args.count_handles as usize)
            .map_err(|_| VfsError::BadAddress)?;
        let points: Vec<u64> = vm_load(current, args.points as *const u64, args.count_handles as usize)
            .map_err(|_| VfsError::BadAddress)?;
        let syncobjs = self.syncobjs.lock();
        for (handle, point) in handles.iter().zip(points) {
            let mut state = syncobjs
                .get(handle)
                .ok_or(VfsError::NotFound)?
                .lock();
            state.signaled_point = state.signaled_point.max(point);
        }
        Ok(0)
    }

    pub(crate) fn handle_syncobj_timeline_wait(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjTimelineWait = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(current, args.handles as *const u32, args.count_handles as usize)
            .map_err(|_| VfsError::BadAddress)?;
        let points: Vec<u64> = vm_load(current, args.points as *const u64, args.count_handles as usize)
            .map_err(|_| VfsError::BadAddress)?;

        let check = |syncobjs: &BTreeMap<u32, Arc<Mutex<SyncobjState>>>| -> VfsResult<bool> {
            let mut any = false;
            let mut all = true;
            for (i, handle) in handles.iter().enumerate() {
                let Some(state) = syncobjs.get(handle) else {
                    return Err(VfsError::NotFound);
                };
                let done = state.lock().signaled_point >= points[i];
                any |= done;
                all &= done;
            }
            Ok(if args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL != 0 {
                all
            } else {
                any
            })
        };

        // v1: fence completion is synchronous with EXECBUFFER, so any
        // unsatisfied wait can only reference a future point. Honour
        // WAIT_FOR_SUBMIT by sleeping until the timeout lapses; without
        // the flag Linux rejects unknown-future waits with EINVAL.
        let allow_block = args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT != 0;
        let start = ax_runtime::hal::time::monotonic_time_nanos();
        loop {
            let syncobjs = self.syncobjs.lock();
            if check(&syncobjs)? {
                return Ok(0);
            }
            drop(syncobjs);
            if !allow_block {
                return Err(VfsError::InvalidInput);
            }
            if ax_runtime::hal::time::monotonic_time_nanos().saturating_sub(start)
                >= args.timeout_nsec
            {
                return Err(VfsError::TimedOut);
            }
            crate::task::yield_now();
        }
    }

    /// Binary `DRM_IOCTL_SYNCOBJ_WAIT` — same predicate as the timeline
    /// wait but every handle is checked at point 1. Shares the watermark
    /// sleep policy: unsatisfied waits only reference future points, so
    /// they block to the timeout only when `WAIT_FOR_SUBMIT` is set.
    pub(crate) fn handle_syncobj_wait(&self, current: &UserTaskRef, arg: usize) -> VfsResult<usize> {
        let args: DrmSyncobjWait = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(current, args.handles as *const u32, args.count_handles as usize)
            .map_err(|_| VfsError::BadAddress)?;

        let check = |syncobjs: &BTreeMap<u32, Arc<Mutex<SyncobjState>>>| -> VfsResult<bool> {
            let mut any = false;
            let mut all = true;
            for handle in &handles {
                let Some(state) = syncobjs.get(handle) else {
                    return Err(VfsError::NotFound);
                };
                let done = state.lock().signaled_point >= 1;
                any |= done;
                all &= done;
            }
            Ok(if args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL != 0 {
                all
            } else {
                any
            })
        };

        let allow_block = args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT != 0;
        let start = ax_runtime::hal::time::monotonic_time_nanos();
        loop {
            let syncobjs = self.syncobjs.lock();
            if check(&syncobjs)? {
                return Ok(0);
            }
            drop(syncobjs);
            if !allow_block {
                return Err(VfsError::InvalidInput);
            }
            if ax_runtime::hal::time::monotonic_time_nanos().saturating_sub(start)
                >= args.timeout_nsec.unsigned_abs()
            {
                return Err(VfsError::TimedOut);
            }
            crate::task::yield_now();
        }
    }

    // ---- helpers ----

    fn enumerate_capsets(
        &self,
        dev: &Arc<dyn ax_driver::vgpu::VirtioGpu3D>,
    ) -> VfsResult<Vec<(u32, u32, u32)>> {
        {
            let cached = self.capsets.lock();
            if let Some(list) = &*cached {
                return Ok(list.clone());
            }
        }
        let info = dev.info();
        let mut list = Vec::new();
        for index in 0..info.num_capsets {
            let entry = dev.capset_info(index).map_err(vfs_err)?;
            list.push(entry);
        }
        *self.capsets.lock() = Some(list.clone());
        Ok(list)
    }

    fn capset_id_mask(&self) -> VfsResult<u64> {
        let dev = self.dev()?;
        let capsets = self.enumerate_capsets(&dev)?;
        let mut mask = 0u64;
        for &(id, _, _) in &capsets {
            if id < 64 {
                mask |= 1u64 << id;
            }
        }
        Ok(mask)
    }

    /// Reserves a slot of `size` bytes in the hostmem region. Slots are
    /// 16 KiB-aligned: macOS hosts back QEMU with 16 KiB pages, and a
    /// smaller-granularity MAP_BLOB offset would force the renderer's
    /// fallback mapping path (or break outright on HVF). v1 uses a
    /// monotonic bump allocator: slots are never reused, which wastes
    /// address space on churn but keeps the lifecycle trivially correct
    /// (hostmem regions are sized generously for exactly this reason).
    fn reserve_bar_slot(&self, region_len: u64, size: u64) -> VfsResult<u64> {
        let size = size.max(1).div_ceil(BAR_SLOT_ALIGN) * BAR_SLOT_ALIGN;
        loop {
            let cur = self.next_bar_offset.load(Ordering::Acquire);
            let next = cur.checked_add(size).ok_or(VfsError::InvalidInput)?;
            if next > region_len {
                return Err(VfsError::StorageFull);
            }
            if self
                .next_bar_offset
                .compare_exchange(cur, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(cur);
            }
        }
    }
}

// ---- small helpers ----

/// Maps a DRM fourcc onto the `VIRTIO_GPU_FORMAT_*` value the
/// `SET_SCANOUT_BLOB` command carries; `None` for formats the 3D scanout
/// path cannot display. The B8G8R8* values are the memory-order matches
/// for DRM's little-endian fourccs (same table as the Linux virtio-gpu
/// driver); the X8R8G8B8/A8R8G8B8 spellings have the opposite byte order.
pub(crate) fn virtio_format_of(drm: u32) -> Option<u32> {
    match drm {
        DRM_FORMAT_XRGB8888 => Some(ax_driver::vgpu::FORMAT_B8G8R8X8_UNORM),
        DRM_FORMAT_ARGB8888 => Some(ax_driver::vgpu::FORMAT_B8G8R8A8_UNORM),
        _ => None,
    }
}

/// A kernel-local dma-buf stand-in naming a mapped HOST3D blob.
///
/// Linux exports virtio-gpu blobs as real dma-buf fds so gbm/EGL can move
/// render buffers between processes and into KMS. StarryOS has no
/// cross-process dma-buf object, but every consumer here talks to this
/// kernel anyway: the fd identifies the blob (its GEM handle plus the
/// hostmem BAR mapping), `FD_TO_HANDLE` round-trips it (also across
/// SCM_RIGHTS, which duplicates the `FileLike`), and `mmap` resolves to
/// the same physical range the BAR slice covers.
pub(crate) struct VgpuBlobFd {
    bo_handle: u32,
    phys: u64,
    size: u64,
    cached: bool,
}

impl Pollable for VgpuBlobFd {
    fn poll(&self) -> IoEvents {
        IoEvents::IN | IoEvents::OUT
    }

    unsafe fn register_shared(
        &self,
        _sink: &mut dyn axpoll::SharedRegistrationSink,
        _events: IoEvents,
    ) {
    }
}

impl FileLike for VgpuBlobFd {
    fn stat(&self) -> crate::StarryResult<Kstat> {
        Ok(Kstat {
            size: self.size,
            ..Default::default()
        })
    }

    fn path(&self) -> Cow<'_, str> {
        Cow::Borrowed("/dev/dri/gem-blob-fd")
    }

    fn open_flags(&self) -> u32 {
        O_RDWR
    }

    fn device_mmap(&self, _offset: u64, length: u64) -> crate::StarryResult<DeviceMmap> {
        let range = PhysAddrRange::from_start_size(
            PhysAddr::from(self.phys as usize),
            (length.min(self.size)).max(1) as usize,
        );
        if self.cached {
            Ok(DeviceMmap::PhysicalCached(range, None))
        } else {
            Ok(DeviceMmap::Physical(range, None))
        }
    }
}

fn process_key(current: &UserTaskRef) -> u64 {
    current.as_thread().proc_data.identity().id().get()
}
fn load_arg<T: AnyBitPattern>(current: &UserTaskRef, arg: usize) -> VfsResult<T> {
    let loaded = vm_load::<T>(current, arg as *const T, 1).map_err(|_| VfsError::BadAddress)?;
    Ok(loaded[0])
}

fn store_arg<T: NoUninit>(current: &UserTaskRef, arg: usize, value: &T) -> VfsResult {
    vm_write_slice(current, arg as *mut T, core::slice::from_ref(value))
        .map_err(|_| VfsError::BadAddress)
}

fn load_debug_name(current: &UserTaskRef, addr: u64) -> VfsResult<String> {
    let buf =
        vm_load::<u8>(current, addr as *const u8, 64).map_err(|_| VfsError::BadAddress)?;
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Ok(String::from_utf8_lossy(&buf[..len]).into_owned())
}
