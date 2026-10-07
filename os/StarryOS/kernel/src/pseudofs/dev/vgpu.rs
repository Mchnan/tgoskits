//! `/dev/dri/card0` — the venus `VIRTGPU_*` DRM ioctl family (3D face).
//!
//! This module turns card0 into the guest-side counterpart of Linux's
//! `drivers/gpu/drm/virtio` for the subset the mesa venus Vulkan driver
//! exercises: GETPARAM / GET_CAPS / CONTEXT_INIT / RESOURCE_CREATE_BLOB /
//! RESOURCE_INFO / MAP / EXECBUFFER / GEM_CLOSE, plus the generic-DRM syncobj
//! family venus uses for fences (CREATE / DESTROY / QUERY / SIGNAL / RESET /
//! TIMELINE_SIGNAL / TIMELINE_WAIT).
//!
//! All device work goes through the 3D face published by the virtio-gpu
//! driver ([`virtio_gpu::global_3d`]). On a device without the 3D
//! features (plain 2D virtio-gpu), the handle is `None` and every ioctl here
//! reports `ENOSYS`, matching this driver's behaviour before the 3D face
//! existed.
//!
//! Modelling notes (documented deviations from Linux):
//! - State is keyed by open file description (`file_id`), matching the
//!   per-fd GEM handle model the rest of card0 implements and Linux's
//!   `struct drm_file`. venus opens one fd per device, so sharing across a
//!   process needs the fd anyway.
//! - Every control command completes synchronously inside the driver's queue
//!   lock; a fenced EXECBUFFER returns as soon as the command is queued and
//!   signals its out-syncobjs immediately. "Fence completion" therefore means
//!   "the host accepted the stream", not "the GPU retired it" — an IRQ-driven
//!   completion path is future work.
//! - `DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD` / `FD_TO_HANDLE` (sync_file export) and
//!   `VIRTGPU_EXECBUF_FENCE_FD_IN/OUT` stay `ENOSYS`; venus uses the timeline
//!   path exclusively.

use alloc::{collections::BTreeMap, sync::Arc, vec, vec::Vec};
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use ax_memory_addr::{PAGE_SIZE_4K, PhysAddr, PhysAddrRange};
use axpoll::IoEvents;
use bytemuck::{AnyBitPattern, NoUninit};
use linux_raw_sys::general::O_RDWR;

use super::drm::{
    DRM_FORMAT_ARGB8888, DRM_FORMAT_XRGB8888, DRM_SYNCOBJ_CREATE_SIGNALED,
    DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT, DrmGemClose,
    DrmPrimeHandle, DrmSyncobjArray, DrmSyncobjCreate, DrmSyncobjDestroy,
    DrmSyncobjTimelineArray, DrmSyncobjTimelineWait, DrmSyncobjWait, DrmVirtgpuExecbuffer,
    DrmVirtgpuExecbufferSyncobj, DrmVirtgpuGetCaps, DrmVirtgpuGetparam, DrmVirtgpuMap,
    DrmVirtgpuResourceCreateBlob, DrmVirtgpuResourceInfo,
    DRM_VIRTGPU_BLOB_FLAG_HINT_DEFER_MAPPING, VIRTGPU_BLOB_FLAG_USE_MASK,
    VIRTGPU_BLOB_FLAG_USE_MAPPABLE, VIRTGPU_BLOB_MEM_HOST3D, VIRTGPU_MAP_CACHE_CACHED,
    VIRTGPU_MAP_CACHE_MASK, VIRTGPU_PARAM_3D_FEATURES, VIRTGPU_PARAM_BLOB_ALIGNMENT,
    VIRTGPU_PARAM_CAPSET_QUERY_FIX, VIRTGPU_PARAM_CONTEXT_INIT, VIRTGPU_PARAM_CROSS_DEVICE,
    VIRTGPU_PARAM_EXPLICIT_DEBUG_NAME, VIRTGPU_PARAM_HOST_VISIBLE, VIRTGPU_PARAM_RESOURCE_BLOB,
    VIRTGPU_PARAM_SUPPORTED_CAPSET_IDS, VIRTGPU_DRM_CAPSET_VENUS, VIRTGPU_EXECBUF_FENCE_FD_IN,
    VIRTGPU_EXECBUF_FENCE_FD_OUT, VIRTGPU_EXECBUF_RING_IDX,
};
use crate::{
    file::{FileLike, Kstat, add_file_like, dma_buf_seek, get_file_like},
    mm::{vm_load, vm_write_slice},
    pseudofs::DeviceMmap,
    sync::Mutex,
    task::{UserTaskRef, yield_now},
};

type VfsResult<T = ()> = Result<T, axfs_ng_vfs::VfsError>;

use axfs_ng_vfs::VfsError;

/// Maps a driver-side errno onto the VFS error the ioctl layer reports.
fn vfs_err(err: virtio_gpu::Error) -> VfsError {
    use virtio_gpu::Error as E;
    match err {
        E::Unsupported => VfsError::OperationNotSupported,
        E::NotReady => VfsError::NoSuchDevice,
        E::InvalidParam | E::ResponseTooLarge | E::RequestTooLarge | E::Overflow => {
            VfsError::InvalidInput
        }
        E::DmaError | E::QueueFull | E::OutOfMemory => VfsError::NoMemory,
        E::InvalidResponse | E::DeviceError(_) | E::DeviceFault | E::VirtIo(_) => VfsError::Io,
        _ => VfsError::Io,
    }
}

/// Upper bound for one EXECBUFFER command buffer: contiguous DMA pages,
/// kept well below what the contiguous allocator can satisfy.
const MAX_EXECBUF_BYTES: usize = 2 * 1024 * 1024;
/// mmap offset keys for host-visible blobs start here so they can never
/// collide with the dumb-buffer offset keys (an 8 MiB stride counter would
/// need ~131k live allocations to reach this range). Keys are handed out
/// page-strided: the mmap file offset must be page-aligned (`sys_mmap`
/// rejects unaligned offsets with EINVAL), and the key *is* the file offset
/// for blob mappings.
pub(crate) const BLOB_MMAP_KEY_BASE: u64 = 1 << 40;
/// Stride between consecutive blob mmap keys.
const BLOB_MMAP_KEY_STRIDE: u64 = PAGE_SIZE_4K as u64;
/// Guest-visible granularity of the hostmem BAR. Slots and the wire (host
/// side) blob size are aligned to this: the macOS host backs QEMU with 16 KiB
/// pages, and a sub-16K-aligned hostmem subsection makes the hvf memory
/// listener skip the EPT mapping (stalling the guest on the first BAR
/// access). The tail between `size` and the rounded wire size is unused
/// padding on the guest side.
const BAR_SLOT_ALIGN: u64 = 0x4000;

/// First GEM handle the venus face hands out, far above the dumb-handle
/// range card0 allocates from, so userspace sees one numeric namespace.
const FIRST_VGPU_HANDLE: u32 = 0x0100_0000;

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

/// A blob resource created through the venus face.
struct VgpuResource {
    owner: u64,
    res_handle: u32,
    size: u64,
    blob_mem: u32,
    map: Option<BlobMapping>,
}

/// v1 syncobjs are pure timelines (the only form venus exercises); binary
/// syncobj userspace is emulated on top: "signaled" means
/// `signaled_point >= 1`.
struct SyncobjState {
    /// Timeline watermark: every point `<= signaled_point` is complete.
    signaled_point: u64,
}

/// Per-open-file venus state: the rendering context and its syncobjs.
struct VgpuFd {
    ctx_id: u32,
    num_rings: u32,
    /// Syncobjs keyed by handle, per open file description like Linux's
    /// `drm_file.syncobj_idr`.
    syncobjs: Mutex<BTreeMap<u32, Arc<Mutex<SyncobjState>>>>,
}

/// Cached GET_CAPSET payloads keyed by `(capset_id, version)`.
type CapsetCache = BTreeMap<(u32, u32), Arc<[u8]>>;

/// Per-card venus state. Cheap to construct; all device access happens
/// lazily through [`virtio_gpu::global_3d`].
pub(crate) struct Vgpu {
    next_bo_handle: AtomicU32,
    next_mmap_key: AtomicU64,
    next_bar_offset: AtomicU64,
    /// Per-fd state keyed by card0's stable `file_id`.
    fds: Mutex<BTreeMap<u64, VgpuFd>>,
    /// Blob resources keyed by GEM handle. Device-global so the KMS present
    /// path can resolve an fb's backing after the creating ioctl returned;
    /// lookups still check `owner`.
    resources: Mutex<BTreeMap<u32, VgpuResource>>,
    /// Lazily enumerated `(capset_id, max_version, max_size)` list.
    capsets: Mutex<Option<Vec<(u32, u32, u32)>>>,
    /// Cached GET_CAPSET payloads keyed by `(id, version)`.
    capset_cache: Mutex<CapsetCache>,
}

impl Vgpu {
    pub(crate) const fn new() -> Self {
        Self {
            next_bo_handle: AtomicU32::new(FIRST_VGPU_HANDLE),
            next_mmap_key: AtomicU64::new(BLOB_MMAP_KEY_BASE),
            next_bar_offset: AtomicU64::new(0),
            fds: Mutex::new(BTreeMap::new()),
            resources: Mutex::new(BTreeMap::new()),
            capsets: Mutex::new(None),
            capset_cache: Mutex::new(BTreeMap::new()),
        }
    }

    /// The registered 3D face, if a device with 3D support was probed.
    fn dev(&self) -> VfsResult<Arc<dyn virtio_gpu::VirtioGpu3D>> {
        virtio_gpu::global_3d().ok_or(VfsError::OperationNotSupported)
    }

    /// Whether a 3D face is registered and card0 should route the venus
    /// ioctls here instead of the virgl handlers.
    pub(crate) fn available(&self) -> bool {
        virtio_gpu::global_3d().is_some()
    }

    /// Removes all state for a closing file description. card0 calls this on
    /// `Card0File::drop` (Linux `drm_release` semantics).
    pub(crate) fn close_fd(&self, owner: u64) {
        // Best-effort host cleanup: the fd's state goes away regardless, so
        // a device that is gone cannot leak anything userspace can reach.
        let dev = self.dev().ok();
        let mut fds = self.fds.lock();
        if let Some(dev) = dev.as_ref() {
            if let Some(fd) = fds.remove(&owner) {
                let _ = dev.ctx_destroy(fd.ctx_id);
            }
        } else {
            fds.remove(&owner);
        }
        // Drop the fd's blob resources: unmap and unref them on the host.
        let mut resources = self.resources.lock();
        let owned: Vec<u32> = resources
            .iter()
            .filter(|(_, res)| res.owner == owner)
            .map(|(&handle, _)| handle)
            .collect();
        if let Some(dev) = dev.as_ref() {
            for handle in &owned {
                let res = resources.get(handle).unwrap();
                if res.map.is_some() {
                    let _ = dev.unmap_blob(res.res_handle);
                }
                let _ = dev.resource_unref(res.res_handle);
            }
        }
        for handle in owned {
            resources.remove(&handle);
        }
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
        // Linux writes a 4-byte int, not the full u64 (mesa zeroes its u64
        // because "kernel only writes the lower 32 bits").
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
            return Err(VfsError::OperationNotSupported);
        }

        let capsets = self.enumerate_capsets(&dev)?;
        let found = capsets
            .iter()
            .find(|&&(id, _, _)| id == args.cap_set_id)
            .copied();
        let Some((_, max_version, max_size)) = found else {
            return Err(VfsError::InvalidInput);
        };
        if max_version < args.cap_set_ver {
            return Err(VfsError::InvalidInput);
        }

        // Fetch (or reuse) the capset payload.
        let payload = {
            let mut cache = self.capset_cache.lock();
            match cache.get(&(args.cap_set_id, args.cap_set_ver)) {
                Some(hit) => hit.clone(),
                None => {
                    let mut buf = vec![0u8; max_size as usize];
                    let total = dev
                        .capset(args.cap_set_id, args.cap_set_ver, &mut buf)
                        .map_err(vfs_err)?;
                    buf.truncate(total);
                    let arc: Arc<[u8]> = buf.into();
                    cache.insert((args.cap_set_id, args.cap_set_ver), arc.clone());
                    arc
                }
            }
        };

        // Linux copies `min(args->size, host_caps_size)` bytes.
        let n = (args.size as usize).min(payload.len());
        vm_write_slice(current, args.addr as *mut u8, &payload[..n])
            .map_err(|_| VfsError::BadAddress)?;
        Ok(0)
    }

    /// CONTEXT_INIT for a venus (`capset_id == 4`) context. `ctx_id` comes
    /// from card0's shared context-id allocator so the two faces never hand
    /// the host colliding ids.
    pub(crate) fn open_context(
        &self,
        owner: u64,
        ctx_id: u32,
        num_rings: u32,
        debug_name: &str,
    ) -> VfsResult<()> {
        let dev = self.dev()?;
        dev.ctx_create(ctx_id, VIRTGPU_DRM_CAPSET_VENUS, VIRTGPU_DRM_CAPSET_VENUS, debug_name)
            .map_err(vfs_err)?;
        self.fds.lock().insert(
            owner,
            VgpuFd {
                ctx_id,
                num_rings,
                syncobjs: Mutex::new(BTreeMap::new()),
            },
        );
        Ok(())
    }

    /// Whether `owner` holds a venus context (routes EXECBUFFER and blob
    /// creation to this face).
    pub(crate) fn has_context(&self, owner: u64) -> bool {
        self.fds.lock().contains_key(&owner)
    }

    /// Whether the device can host a venus (capset 4) context: 3D support
    /// and the context-init protocol negotiated, and the host's capset list
    /// actually contains the venus capset.
    pub(crate) fn venus_context_supported(&self) -> bool {
        let Ok(dev) = self.dev() else {
            return false;
        };
        let info = dev.info();
        if !info.has_3d || !info.has_context_init {
            return false;
        }
        self.enumerate_capsets(&dev)
            .map(|list| list.iter().any(|&(id, _, _)| id == VIRTGPU_DRM_CAPSET_VENUS))
            .unwrap_or(false)
    }

    pub(crate) fn handle_resource_create_blob(
        &self,
        owner: u64,
        res_id: u32,
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
        // v1 supports host-allocated 3D blobs only; GUEST/HOST3D_GUEST would
        // need backing-store attach commands (the virgl face owns those).
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

        let fds = self.fds.lock();
        let Some(fd) = fds.get(&owner) else {
            return Err(VfsError::InvalidInput);
        };
        let ctx_id = fd.ctx_id;
        drop(fds);

        let dev = self.dev()?;

        // Optional initialization command stream, submitted before the blob
        // is created (Linux ordering).
        let init_cmd: Vec<u8> = if args.cmd_size > 0 {
            vm_load::<u8>(current, args.cmd as *const u8, args.cmd_size as usize)
                .map_err(|_| VfsError::BadAddress)?
        } else {
            Vec::new()
        };

        // The wire size is rounded up to the BAR slot granularity so the
        // host-side subregion (and every EPT subsection the hvf listener
        // derives from it) stays 16 KiB-aligned; see [`BAR_SLOT_ALIGN`].
        let wire_size = args.size.max(1).div_ceil(BAR_SLOT_ALIGN) * BAR_SLOT_ALIGN;
        dev.resource_create_blob(
            virtio_gpu::BlobParams {
                ctx_id,
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
                        return Err(vfs_err(err));
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
                owner,
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
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> Option<VfsResult<usize>> {
        let args: DrmVirtgpuResourceInfo = load_arg(current, arg).ok()?;
        let resources = self.resources.lock();
        let res = resources
            .get(&args.bo_handle)
            .filter(|res| res.owner == owner)?;
        let out = DrmVirtgpuResourceInfo {
            bo_handle: args.bo_handle,
            res_handle: res.res_handle,
            size: res.size as u32,
            blob_mem: res.blob_mem,
        };
        Some(store_arg(current, arg, &out).map(|_| 0))
    }

    pub(crate) fn handle_map(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> Option<VfsResult<usize>> {
        let args: DrmVirtgpuMap = load_arg(current, arg).ok()?;
        let resources = self.resources.lock();
        let res = resources
            .get(&args.handle)
            .filter(|res| res.owner == owner)?;
        let Some(map) = &res.map else {
            return Some(Err(VfsError::InvalidInput));
        };
        let out = DrmVirtgpuMap {
            offset: map.mmap_key,
            handle: args.handle,
            pad: 0,
        };
        Some(store_arg(current, arg, &out).map(|_| 0))
    }

    pub(crate) fn handle_gem_close(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> Option<VfsResult<usize>> {
        let args: DrmGemClose = load_arg(current, arg).ok()?;
        let removed = {
            let resources = self.resources.lock();
            resources
                .get(&args.handle)
                .filter(|res| res.owner == owner)
                .map(|res| (res.res_handle, res.map.is_some()))
        }?;
        let (res_handle, mapped) = removed;
        self.resources.lock().remove(&args.handle);
        if let Ok(dev) = self.dev() {
            if mapped {
                let _ = dev.unmap_blob(res_handle);
            }
            let _ = dev.resource_unref(res_handle);
        }
        Some(Ok(0))
    }

    pub(crate) fn handle_execbuffer(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
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

        let fds = self.fds.lock();
        let Some(fd) = fds.get(&owner) else {
            return Err(VfsError::InvalidInput);
        };
        let ctx_id = fd.ctx_id;
        let num_rings = fd.num_rings;
        drop(fds);

        let ring_idx = if args.flags & VIRTGPU_EXECBUF_RING_IDX != 0 {
            if args.ring_idx >= num_rings {
                return Err(VfsError::InvalidInput);
            }
            Some(args.ring_idx as u8)
        } else {
            None
        };

        // Validate referenced bo handles (Linux uses them for reservations;
        // the host attaches blobs via the context).
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

        // Copy the command stream into contiguous kernel pages so the device
        // layer can DMA it as one descriptor. Empty streams (ring kicks) skip
        // this entirely. The GlobalPage binding must live at this scope: the
        // slice handed to the submit borrows its pages.
        let cmd_page = if args.size == 0 {
            None
        } else {
            let page_count = args.size.div_ceil(PAGE_SIZE_4K as u32) as usize;
            Some(
                ax_alloc::GlobalPage::alloc_contiguous(page_count, PAGE_SIZE_4K)
                    .map_err(|_| VfsError::NoMemory)?,
            )
        };
        if let Some(cmd_page) = &cmd_page {
            let loaded =
                vm_load::<u8>(current, args.command as *const u8, args.size as usize)
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
            // SAFETY: `cmd_page` stays alive for the submit below, its pages
            // are contiguous (GlobalPage contract), and the device layer only
            // reads them while the chain is in flight.
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
        // allocates an out-fence, and the ring idx rides on it). For a venus
        // context the host defers the SUBMIT_3D response to fence retire
        // regardless, so an unfenced submit would block forever on the
        // synchronous round-trip.
        let fence = true;
        if let Err(err) = self.dev()?.submit_3d(ctx_id, cmd, ring_idx, fence) {
            warn!(
                "vgpu: submit_3d failed: {err:?} (ctx={ctx_id} size={} ring={ring_idx:?} out={})",
                args.size,
                out_syncobjs.len()
            );
            return Err(vfs_err(err));
        }

        let fds = self.fds.lock();
        for (handle, point) in out_syncobjs {
            let Some(state) = fds.get(&owner).and_then(|fd| fd.syncobjs.lock().get(&handle).cloned())
            else {
                return Err(VfsError::NotFound);
            };
            let mut state = state.lock();
            state.signaled_point = state.signaled_point.max(point);
        }
        Ok(0)
    }

    /// `DRM_IOCTL_PRIME_HANDLE_TO_FD` for a mapped HOST3D blob: installs a
    /// kernel-local dma-buf stand-in fd that names the blob's GEM handle.
    /// Mesa's gbm/EGL paths export render buffers this way before feeding
    /// the fd back through `FD_TO_HANDLE` + `ADDFB2`; the memory itself is
    /// the blob's hostmem BAR mapping, so no data moves.
    pub(crate) fn handle_prime_handle_to_fd(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> Option<VfsResult<usize>> {
        let args: DrmPrimeHandle = load_arg(current, arg).ok()?;
        let found = {
            let resources = self.resources.lock();
            resources
                .get(&args.handle)
                .filter(|res| res.owner == owner)
                .and_then(|res| res.map.as_ref())
                .map(|map| (map.phys, map.size, map.map_info))
        }?;
        let (phys, size, map_info) = found;
        let file: Arc<dyn FileLike> = Arc::new(VgpuBlobFd {
            bo_handle: args.handle,
            phys,
            size,
            cached: map_info & VIRTGPU_MAP_CACHE_MASK == VIRTGPU_MAP_CACHE_CACHED,
        });
        let mut out = args;
        out.fd = match add_file_like(file, true) {
            Ok(fd) => fd,
            Err(_) => return Some(Err(VfsError::Io)),
        };
        Some(store_arg(current, arg, &out).map(|_| 0))
    }

    /// `DRM_IOCTL_PRIME_FD_TO_HANDLE`: resolves a fd installed by
    /// [`Self::handle_prime_handle_to_fd`] (possibly after SCM_RIGHTS
    /// sharing) back to its GEM handle. `None` when the fd is not one of
    /// ours, so card0 can try its own import paths.
    pub(crate) fn handle_prime_fd_to_handle(
        &self,
        current: &UserTaskRef,
        arg: usize,
    ) -> Option<VfsResult<usize>> {
        let args: DrmPrimeHandle = load_arg(current, arg).ok()?;
        let file = get_file_like(args.fd).ok()?;
        let blob = file.downcast_arc::<VgpuBlobFd>().ok()?;
        let out = DrmPrimeHandle {
            handle: blob.bo_handle,
            ..args
        };
        Some(store_arg(current, arg, &out).map(|_| 0))
    }

    /// Resolves a blob mmap key to `(phys, size, cached)` for the mmap hook.
    /// Card0 routes mmap offsets at or above [`BLOB_MMAP_KEY_BASE`] here
    /// before its own dumb-buffer lookup; `cached` follows the host's
    /// map_info (venus hostmem is normal RAM the CPU may cache).
    pub(crate) fn blob_physical_range(&self, offset: u64) -> Option<(u64, u64, bool)> {
        let resources = self.resources.lock();
        resources.values().find_map(|res| {
            res.map.as_ref().filter(|m| m.mmap_key == offset).map(|m| {
                (
                    m.phys,
                    m.size,
                    m.map_info & VIRTGPU_MAP_CACHE_MASK == VIRTGPU_MAP_CACHE_CACHED,
                )
            })
        })
    }

    /// Resolves a GEM handle to a 3D blob resource for the KMS side:
    /// `(res_handle, blob_size)` when `bo_handle` names one of `owner`'s
    /// blobs, `None` for dumb-buffer handles (card0 handles those directly).
    pub(crate) fn lookup_blob(&self, owner: u64, bo_handle: u32) -> Option<(u32, u64)> {
        let resources = self.resources.lock();
        resources
            .get(&bo_handle)
            .filter(|res| res.owner == owner)
            .map(|res| (res.res_handle, res.size))
    }

    // ---- KMS present side (blob scanout) ----

    /// Displays a blob resource on the host scanout — the zero-copy KMS
    /// present path. The host references the blob's backing memory in place,
    /// so guest writes to the mapped resource are visible without any
    /// transfer command.
    pub(crate) fn set_scanout_blob(
        &self,
        params: virtio_gpu::ScanoutBlobParams,
    ) -> VfsResult {
        self.dev()?.set_scanout_blob(params).map_err(vfs_err)
    }

    /// Stops displaying the blob bound to the scanout (client released the
    /// scanned-out fb / last card0 fd closed).
    pub(crate) fn disable_scanout(&self) -> VfsResult {
        self.dev()?.disable_scanout(0).map_err(vfs_err)
    }

    /// Restores the 2D scanout surface after a blob scanout replaced it, so
    /// a dumb-buffer present is visible again on mixed 2D+3D devices.
    pub(crate) fn bind_2d_scanout(&self) -> VfsResult {
        self.dev()?.bind_2d_scanout().map_err(vfs_err)
    }

    // ---- syncobj family ----

    pub(crate) fn handle_syncobj_create(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjCreate = load_arg(current, arg)?;
        if args.flags & !DRM_SYNCOBJ_CREATE_SIGNALED != 0 {
            return Err(VfsError::InvalidInput);
        }
        let handle = self.next_syncobj_handle();
        let fds = self.fds.lock();
        let Some(fd) = fds.get(&owner) else {
            return Err(VfsError::InvalidInput);
        };
        fd.syncobjs.lock().insert(
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
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjDestroy = load_arg(current, arg)?;
        let fds = self.fds.lock();
        let Some(fd) = fds.get(&owner) else {
            return Err(VfsError::NotFound);
        };
        fd.syncobjs
            .lock()
            .remove(&args.handle)
            .ok_or(VfsError::NotFound)?;
        Ok(0)
    }

    pub(crate) fn handle_syncobj_query(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjTimelineArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        let states = self.lookup_syncobjs(owner, &handles)?;
        for (i, state) in states.iter().enumerate() {
            let point = state.lock().signaled_point;
            vm_write_slice(current, (args.points + i as u64 * 8) as *mut u64, &[point])
                .map_err(|_| VfsError::BadAddress)?;
        }
        Ok(0)
    }

    pub(crate) fn handle_syncobj_reset(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        for state in self.lookup_syncobjs(owner, &handles)? {
            state.lock().signaled_point = 0;
        }
        Ok(0)
    }

    pub(crate) fn handle_syncobj_signal(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        for state in self.lookup_syncobjs(owner, &handles)? {
            let mut state = state.lock();
            state.signaled_point = state.signaled_point.max(1);
        }
        Ok(0)
    }

    pub(crate) fn handle_syncobj_timeline_signal(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjTimelineArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        let points: Vec<u64> =
            vm_load(current, args.points as *const u64, args.count_handles as usize)
                .map_err(|_| VfsError::BadAddress)?;
        let states = self.lookup_syncobjs(owner, &handles)?;
        for (state, point) in states.iter().zip(points) {
            let mut state = state.lock();
            state.signaled_point = state.signaled_point.max(point);
        }
        Ok(0)
    }

    pub(crate) fn handle_syncobj_timeline_wait(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjTimelineWait = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        let points: Vec<u64> =
            vm_load(current, args.points as *const u64, args.count_handles as usize)
                .map_err(|_| VfsError::BadAddress)?;

        // Snapshot the syncobjs once: the wait may sleep, and the fd's
        // syncobj table must not stay locked across that.
        let states = self.lookup_syncobjs(owner, &handles)?;

        let check = || -> VfsResult<bool> {
            let mut any = false;
            let mut all = true;
            for (i, state) in states.iter().enumerate() {
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
            if check()? {
                return Ok(0);
            }
            if !allow_block {
                return Err(VfsError::InvalidInput);
            }
            if ax_runtime::hal::time::monotonic_time_nanos().saturating_sub(start)
                >= args.timeout_nsec
            {
                return Err(VfsError::TimedOut);
            }
            yield_now();
        }
    }

    /// Binary `DRM_IOCTL_SYNCOBJ_WAIT` — same predicate as the timeline wait
    /// but every handle is checked at point 1. Shares the watermark sleep
    /// policy: unsatisfied waits only reference future points, so they block
    /// to the timeout only when `WAIT_FOR_SUBMIT` is set.
    pub(crate) fn handle_syncobj_wait(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjWait = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        let states = self.lookup_syncobjs(owner, &handles)?;

        let check = || -> VfsResult<bool> {
            let mut any = false;
            let mut all = true;
            for state in &states {
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
            if check()? {
                return Ok(0);
            }
            if !allow_block {
                return Err(VfsError::InvalidInput);
            }
            if ax_runtime::hal::time::monotonic_time_nanos().saturating_sub(start)
                >= args.timeout_nsec.unsigned_abs()
            {
                return Err(VfsError::TimedOut);
            }
            yield_now();
        }
    }

    // ---- helpers ----

    fn next_syncobj_handle(&self) -> u32 {
        // Syncobj handles live in each fd's table, so a device-wide counter
        // keeps them unique across fds without colliding with GEM handles
        // (which start at `FIRST_VGPU_HANDLE`, far above any plausible
        // syncobj count).
        static NEXT: AtomicU32 = AtomicU32::new(1);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    /// Resolves handles to their per-fd syncobj states, failing with
    /// `NotFound` when any handle is unknown.
    fn lookup_syncobjs(
        &self,
        owner: u64,
        handles: &[u32],
    ) -> VfsResult<Vec<Arc<Mutex<SyncobjState>>>> {
        let fds = self.fds.lock();
        let Some(fd) = fds.get(&owner) else {
            return Err(VfsError::NotFound);
        };
        let table = fd.syncobjs.lock();
        handles
            .iter()
            .map(|handle| table.get(handle).cloned().ok_or(VfsError::NotFound))
            .collect()
    }

    fn enumerate_capsets(
        &self,
        dev: &Arc<dyn virtio_gpu::VirtioGpu3D>,
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
    /// fallback mapping path (or break outright on HVF). v1 uses a monotonic
    /// bump allocator: slots are never reused, which wastes address space on
    /// churn but keeps the lifecycle trivially correct (hostmem regions are
    /// sized generously for exactly this reason).
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
        DRM_FORMAT_XRGB8888 => Some(virtio_gpu::FORMAT_B8G8R8X8_UNORM),
        DRM_FORMAT_ARGB8888 => Some(virtio_gpu::FORMAT_B8G8R8A8_UNORM),
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
struct VgpuBlobFd {
    bo_handle: u32,
    phys: u64,
    size: u64,
    cached: bool,
}

impl axpoll::Pollable for VgpuBlobFd {
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
    fn seek(&self, pos: ax_io::SeekFrom) -> crate::StarryResult<u64> {
        dma_buf_seek(self.size, pos)
    }

    fn validate_write_access(&self) -> crate::StarryResult {
        Err(crate::StarryError::InvalidInput)
    }

    fn stat(&self) -> crate::StarryResult<Kstat> {
        Ok(Kstat {
            size: self.size,
            ..Default::default()
        })
    }

    fn path(&self) -> alloc::borrow::Cow<'_, str> {
        alloc::borrow::Cow::Borrowed("/dev/dri/gem-blob-fd")
    }

    fn open_flags(&self) -> u32 {
        O_RDWR
    }

    fn device_mmap(&self, offset: u64, length: u64) -> crate::StarryResult<DeviceMmap> {
        // Validate that the requested sub-range fits within the blob.
        let end = offset
            .checked_add(length)
            .ok_or(crate::StarryError::InvalidInput)?;
        if end > self.size {
            return Err(crate::StarryError::InvalidInput);
        }
        let range = PhysAddrRange::from_start_size(
            PhysAddr::from(self.phys as usize),
            self.size as usize,
        );
        if self.cached {
            Ok(DeviceMmap::PhysicalCached(range, None))
        } else {
            Ok(DeviceMmap::Physical(range, None))
        }
    }
}

fn load_arg<T: AnyBitPattern>(current: &UserTaskRef, arg: usize) -> VfsResult<T> {
    let loaded = vm_load::<T>(current, arg as *const T, 1).map_err(|_| VfsError::BadAddress)?;
    Ok(loaded[0])
}

fn store_arg<T: NoUninit>(current: &UserTaskRef, arg: usize, value: &T) -> VfsResult {
    vm_write_slice(current, arg as *mut T, core::slice::from_ref(value))
        .map_err(|_| VfsError::BadAddress)
}
