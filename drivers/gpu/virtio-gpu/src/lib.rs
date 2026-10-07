//! Focused VirtIO GPU protocol core for the TGOSKits display, virgl and venus
//! paths.
//!
//! The crate implements the part of the virtio-gpu control protocol that the
//! current display stack drives:
//!
//! * the 2D display path: `GET_DISPLAY_INFO`, `RESOURCE_CREATE_2D`,
//!   `RESOURCE_ATTACH_BACKING` / `RESOURCE_DETACH_BACKING`, `SET_SCANOUT`,
//!   `TRANSFER_TO_HOST_2D`, `RESOURCE_FLUSH` and `RESOURCE_UNREF`,
//! * the virgl 3D path: `GET_CAPSET_INFO`, `GET_CAPSET`, `CTX_CREATE` /
//!   `CTX_DESTROY` / `CTX_ATTACH_RESOURCE` / `CTX_DETACH_RESOURCE`,
//!   `RESOURCE_CREATE_3D`, `TRANSFER_TO_HOST_3D`, `TRANSFER_FROM_HOST_3D`,
//!   `SUBMIT_3D` and `RESOURCE_CREATE_BLOB`, and
//! * the venus 3D surface: `RESOURCE_MAP_BLOB` / `RESOURCE_UNMAP_BLOB` against
//!   the host-visible shared memory BAR, `SET_SCANOUT_BLOB`, and fenced
//!   submissions whose responses the host defers until the fence retires.
//!
//! Everything else the upstream GPU driver carries — EDID, the cursor queue
//! and its shapes, multi-scanout helpers — is deliberately absent: nothing in
//! this workspace calls it, and the display stack above this crate owns those
//! semantics.
//!
//! Transport access, virtqueue handling and DMA mapping are not reimplemented
//! here. The device is built on the published `virtio-drivers` 0.13.0 surface
//! ([`virtio_drivers::Hal`], [`virtio_drivers::Transport`],
//! [`virtio_drivers::queue::VirtQueue`], the config-space macros and
//! [`virtio_drivers::Error`]); this crate adds the virtio-gpu domain types, the
//! wire encoding and the response validation on top of it.
//!
//! # Two faces, one device
//!
//! OS kernels drive the 2D/virgl commands through their display adapter, and
//! the venus surface through the [`VirtioGpu3D`] handle the probe publishes
//! with [`register_global_3d`]. Both reach the same control queue: a second
//! driver on the same device would keep private avail/used indices and corrupt
//! the queue, so the crate owns one transport and serializes on it.
//!
//! The crate is `#![no_std]` and only needs `alloc`. It has no dependency on
//! `rdrive`, `rdif-display`, StarryOS, ArceOS or the Linux DRM UAPI: mapping
//! those onto the types below is the adapter's job.
//!
//! # Safety
//!
//! Commands that hand a raw guest-physical address to the device are `unsafe`.
//! The compiler cannot prove that such a range stays allocated, stays exclusive
//! and is large enough while the device owns it, so the caller has to. The exact
//! contract is documented on each method.

#![no_std]
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(missing_docs)]

extern crate alloc;

use alloc::sync::Arc;

use virtio_drivers::{Hal, transport::Transport};
use zerocopy::{FromBytes, Immutable, IntoBytes, KnownLayout};

mod device;
mod dma;
mod error;
mod wire;

pub use device::{BlobParams, GpuInfo, HostMemRegion, ScanoutBlobParams, VirtIoGpu};
pub use error::Error;

// --- Scanout formats and map cache hints (`VIRTIO_GPU_FORMAT_*`,
// `VIRTIO_GPU_MAP_CACHE_*`) ---

/// `VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM`: the memory-order match for DRM's
/// little-endian `ARGB8888`.
pub const FORMAT_B8G8R8A8_UNORM: u32 = 0x1;
/// `VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM`: the memory-order match for DRM's
/// little-endian `XRGB8888`.
pub const FORMAT_B8G8R8X8_UNORM: u32 = 0x2;
/// `VIRTIO_GPU_MAP_CACHE_MASK`: the cache bits of a `RESOURCE_MAP_BLOB` reply.
pub const MAP_CACHE_MASK: u32 = 0x0f;
/// `VIRTIO_GPU_MAP_CACHE_CACHED`: the mapping may be mapped cacheable.
pub const MAP_CACHE_CACHED: u32 = 0x1;

// --- Blob resource protocol values (`VIRTIO_GPU_BLOB_MEM_*`) ---

/// `VIRTIO_GPU_BLOB_MEM_GUEST`: backing lives in guest memory.
pub const BLOB_MEM_GUEST: u32 = 0x1;
/// `VIRTIO_GPU_BLOB_MEM_HOST3D`: backing lives in host 3D memory.
pub const BLOB_MEM_HOST3D: u32 = 0x2;
/// `VIRTIO_GPU_BLOB_MEM_HOST3D_GUEST`: host 3D memory with a guest mapping.
pub const BLOB_MEM_HOST3D_GUEST: u32 = 0x3;

// --- Blob resource protocol values (`VIRTGPU_BLOB_FLAG_USE_*`) ---

/// `VIRTGPU_BLOB_FLAG_USE_MAPPABLE`: the blob may be mapped from userspace.
pub const BLOB_FLAG_USE_MAPPABLE: u32 = 0x1;
/// `VIRTGPU_BLOB_FLAG_USE_SHAREABLE`: the blob may be shared.
pub const BLOB_FLAG_USE_SHAREABLE: u32 = 0x2;
/// `VIRTGPU_BLOB_FLAG_USE_CROSS_DEVICE`: the blob is shared across devices.
///
/// Cross-device blobs need `VIRTIO_GPU_F_RESOURCE_UUID` and
/// `RESOURCE_ASSIGN_UUID`, neither of which this crate negotiates or
/// implements. The flag is rejected with [`Error::Unsupported`] instead of
/// being sent to a device that cannot honour it.
pub const BLOB_FLAG_USE_CROSS_DEVICE: u32 = 0x4;
/// Mask of the defined `VIRTGPU_BLOB_FLAG_USE_*` bits (the low three bits).
pub const BLOB_FLAG_USE_MASK: u32 =
    BLOB_FLAG_USE_MAPPABLE | BLOB_FLAG_USE_SHAREABLE | BLOB_FLAG_USE_CROSS_DEVICE;

/// A rectangle in pixels, used by the 2D display commands.
///
/// The layout is the `struct virtio_gpu_rect` wire format, so the type derives
/// the `zerocopy` traits that let the encoder copy it into a command buffer.
#[repr(C)]
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, FromBytes, Immutable, IntoBytes, KnownLayout,
)]
pub struct Rect {
    /// X offset in pixels.
    pub x: u32,
    /// Y offset in pixels.
    pub y: u32,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

/// A 3D sub-region inside a resource, used by the `TRANSFER_*_HOST_3D` commands.
///
/// The field names follow the virtio-gpu wire format: `w`, `h` and `d` are the
/// extents of the box rather than a second corner.
///
/// The layout is the `struct virtio_gpu_box` wire format, so the type derives
/// the `zerocopy` traits that let the encoder copy it into a command buffer.
#[repr(C)]
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, FromBytes, Immutable, IntoBytes, KnownLayout,
)]
pub struct GpuBox {
    /// X offset within the resource.
    pub x: u32,
    /// Y offset within the resource.
    pub y: u32,
    /// Z offset within the resource.
    pub z: u32,
    /// Width of the sub-region.
    pub w: u32,
    /// Height of the sub-region.
    pub h: u32,
    /// Depth of the sub-region.
    pub d: u32,
}

/// One guest-physical range backing a blob resource.
///
/// The device reads and writes this memory directly, so the range must stay
/// valid for as long as the blob resource exists. See
/// [`VirtIoGpu::resource_create_blob`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobMemory {
    /// Guest-physical base address of the range.
    pub paddr: u64,
    /// Length of the range in bytes.
    pub length: u32,
}

/// Parameters for creating a 3D resource (`RESOURCE_CREATE_3D`).
///
/// `target`, `format`, `bind` and `flags` are pipe-level constants from the
/// Gallium/Mesa headers; this crate passes them through unchanged and does not
/// define them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceCreate3d {
    /// Rendering context that owns the resource.
    pub ctx_id: u32,
    /// Resource ID assigned by the caller.
    pub resource_id: u32,
    /// Pipe texture target (`PIPE_TEXTURE_*`).
    pub target: u32,
    /// Pipe format (`PIPE_FORMAT_*`).
    pub format: u32,
    /// Pipe bind flags (`PIPE_BIND_*`).
    pub bind: u32,
    /// Width in pixels (or bytes for buffers).
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Depth for 3D textures.
    pub depth: u32,
    /// Number of array layers.
    pub array_size: u32,
    /// Number of mipmap levels, minus one.
    pub last_level: u32,
    /// Number of MSAA samples.
    pub nr_samples: u32,
    /// `VIRTIO_GPU_RESOURCE_FLAG_*` from the Linux UAPI.
    pub flags: u32,
}

/// Parameters for a 3D transfer (`TRANSFER_TO_HOST_3D` / `TRANSFER_FROM_HOST_3D`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transfer3d {
    /// Rendering context that owns the resource.
    pub ctx_id: u32,
    /// Resource to transfer.
    pub resource_id: u32,
    /// Sub-region to transfer.
    pub box_: GpuBox,
    /// Byte offset within the resource.
    pub offset: u64,
    /// Mipmap level.
    pub level: u32,
    /// Row stride in bytes.
    pub stride: u32,
    /// Layer stride in bytes (array and 3D textures).
    pub layer_stride: u32,
}

/// Parameters for creating a blob resource (`RESOURCE_CREATE_BLOB`).
///
/// The type carries no command stream: the Linux ioctl ordering (submit the
/// virgl commands on the same context first, then create the blob) belongs to
/// the adapter above this crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceCreateBlob<'a> {
    /// Rendering context for `HOST3D` blobs; 0 for plain guest blobs.
    pub ctx_id: u32,
    /// Resource ID assigned by the caller.
    pub resource_id: u32,
    /// `VIRTIO_GPU_BLOB_MEM_GUEST` (0x1), `HOST3D` (0x2) or `HOST3D_GUEST` (0x3).
    pub blob_mem: u32,
    /// `VIRTIO_GPU_BLOB_FLAG_*` bits.
    pub blob_flags: u32,
    /// Resource size in bytes.
    pub size: u64,
    /// Host-side resource ID for `HOST3D` blobs, 0 otherwise.
    pub blob_id: u64,
    /// Guest-physical backing ranges.
    ///
    /// `GUEST` and `HOST3D_GUEST` blobs pass the ranges that cover `size`
    /// bytes; `HOST3D` blobs must pass an empty slice, because virglrenderer
    /// rejects a nonzero `num_iovs`.
    pub mem_entries: &'a [BlobMemory],
}

/// Capset metadata returned by [`VirtIoGpu::get_capset_info`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapsetInfo {
    /// Capset ID (1 = VIRGL, 2 = VIRGL2).
    pub capset_id: u32,
    /// Highest capset version the device supports.
    pub max_version: u32,
    /// Maximum size in bytes of one capset data blob.
    pub max_size: u32,
}

/// Interrupts acknowledged from the device, decoupled from the transport.
///
/// This is the crate's own view of an interrupt: an adapter maps it onto its
/// platform event type instead of depending on the virtio transport type.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IrqEvent {
    /// The device completed one or more virtqueue buffers.
    pub queue: bool,
    /// The device configuration, such as the display state, changed.
    pub configuration: bool,
    /// A `VIRTIO_GPU_EVENT_DISPLAY` config event was pending, so the display
    /// configuration changed. Only meaningful while `configuration` is set; the
    /// device reports it separately from the transport's status bits, and an
    /// unreadable `events_read` register conservatively sets it.
    pub display_changed: bool,
}

impl IrqEvent {
    /// An event with nothing to report.
    pub const fn none() -> Self {
        Self {
            queue: false,
            configuration: false,
            display_changed: false,
        }
    }

    /// Whether the acknowledged status carries no information at all.
    ///
    /// Only `queue` and `configuration` decide this. A configuration interrupt
    /// is handled even when it carried no display event, so an unrelated or
    /// unknown config bit must not make the driver report the interrupt as
    /// unhandled.
    pub const fn is_empty(&self) -> bool {
        !self.queue && !self.configuration
    }
}

/// Kernel-facing 3D operations of a virtio-gpu device.
///
/// Implemented by [`VirtIoGpu`] and published through [`register_global_3d`],
/// so a kernel's DRM layer can implement the `VIRTGPU_*` ioctl family without
/// naming the transport or HAL type. Resource and context ids are allocated by
/// the caller (the DRM layer); 3D resource ids must stay clear of the fixed low
/// ids the 2D scanout path occupies.
pub trait VirtioGpu3D: Send + Sync {
    /// Device capability summary taken at probe time.
    fn info(&self) -> GpuInfo;

    /// `GET_CAPSET_INFO` for the capset at `index`:
    /// returns `(capset_id, max_version, max_size)`.
    fn capset_info(&self, index: u32) -> Result<(u32, u32, u32), Error>;

    /// `GET_CAPSET` for `(id, version)`. Fills up to `out.len()` bytes and
    /// returns the total capset size the host reported.
    fn capset(&self, id: u32, version: u32, out: &mut [u8]) -> Result<usize, Error>;

    /// `CTX_CREATE` with the capset id in `context_init`'s low byte.
    fn ctx_create(
        &self,
        ctx_id: u32,
        capset_id: u32,
        context_init: u32,
        debug_name: &str,
    ) -> Result<(), Error>;

    /// `CTX_DESTROY`.
    fn ctx_destroy(&self, ctx_id: u32) -> Result<(), Error>;

    /// `RESOURCE_CREATE_BLOB`, preceded by the optional initialization command
    /// stream exactly as Linux orders it.
    fn resource_create_blob(&self, params: BlobParams, init_cmd: &[u8]) -> Result<(), Error>;

    /// `RESOURCE_UNREF`.
    fn resource_unref(&self, res_id: u32) -> Result<(), Error>;

    /// `RESOURCE_MAP_BLOB` into the host-visible BAR at `bar_offset`; returns
    /// the host's `map_info` cache hint.
    fn map_blob(&self, res_id: u32, bar_offset: u64) -> Result<u32, Error>;

    /// `RESOURCE_UNMAP_BLOB`.
    fn unmap_blob(&self, res_id: u32) -> Result<(), Error>;

    /// `SUBMIT_3D`. With `fence` the command carries the fence flag and the
    /// call returns as soon as the command is queued — the host retires a
    /// fenced response on its own schedule, so waiting for it would stall the
    /// control queue. Without a fence the host answers immediately and the call
    /// waits for that answer.
    fn submit_3d(
        &self,
        ctx_id: u32,
        cmd: &[u8],
        ring_idx: Option<u8>,
        fence: bool,
    ) -> Result<(), Error>;

    /// `SET_SCANOUT_BLOB` — display a blob resource on a scanout. The host
    /// references the blob's backing memory in place (zero copy). `res_id == 0`
    /// disables the scanout.
    fn set_scanout_blob(&self, params: ScanoutBlobParams) -> Result<(), Error>;

    /// Rebinds the fixed 2D scanout resource to scanout 0, restoring the
    /// surface a blob scanout replaced. Fails with [`Error::NotReady`] when no
    /// 2D surface was set up.
    fn bind_2d_scanout(&self) -> Result<(), Error>;

    /// Stops displaying whatever resource is bound to `scanout_id`.
    fn disable_scanout(&self, scanout_id: u32) -> Result<(), Error>;
}

impl<H: Hal + 'static, T: Transport + 'static> VirtioGpu3D for VirtIoGpu<H, T> {
    fn info(&self) -> GpuInfo {
        VirtIoGpu::info(self)
    }

    fn capset_info(&self, index: u32) -> Result<(u32, u32, u32), Error> {
        let info = VirtIoGpu::get_capset_info(self, index)?;
        Ok((info.capset_id, info.max_version, info.max_size))
    }

    fn capset(&self, id: u32, version: u32, out: &mut [u8]) -> Result<usize, Error> {
        let data = VirtIoGpu::get_capset(self, id, version, out.len() as u32)?;
        let n = out.len().min(data.len());
        out[..n].copy_from_slice(&data[..n]);
        Ok(data.len())
    }

    fn ctx_create(
        &self,
        ctx_id: u32,
        capset_id: u32,
        context_init: u32,
        debug_name: &str,
    ) -> Result<(), Error> {
        // `VIRTIO_GPU_CONTEXT_INIT_CAPSET_ID_MASK`: the low byte names the
        // capset, which is how the host selects the context protocol.
        VirtIoGpu::ctx_create(self, ctx_id, debug_name, context_init | (capset_id & 0xff))
    }

    fn ctx_destroy(&self, ctx_id: u32) -> Result<(), Error> {
        VirtIoGpu::ctx_destroy(self, ctx_id)
    }

    fn resource_create_blob(&self, params: BlobParams, init_cmd: &[u8]) -> Result<(), Error> {
        // Linux order: the initialization stream runs on the context before the
        // blob resource exists (`virtio_gpu_resource_create_blob_ioctl`).
        if !init_cmd.is_empty() {
            VirtIoGpu::submit_3d_unfenced(self, params.ctx_id, init_cmd)?;
        }
        // SAFETY: host-allocated blobs carry no guest ranges, so nothing is
        // shared with the device beyond the resource itself.
        unsafe {
            VirtIoGpu::resource_create_blob(
                self,
                ResourceCreateBlob {
                    ctx_id: params.ctx_id,
                    resource_id: params.res_id,
                    blob_mem: params.blob_mem,
                    blob_flags: params.blob_flags,
                    size: params.size,
                    blob_id: params.blob_id,
                    mem_entries: &[],
                },
            )
        }
    }

    fn resource_unref(&self, res_id: u32) -> Result<(), Error> {
        VirtIoGpu::resource_unref(self, res_id)
    }

    fn map_blob(&self, res_id: u32, bar_offset: u64) -> Result<u32, Error> {
        VirtIoGpu::map_blob(self, res_id, bar_offset)
    }

    fn unmap_blob(&self, res_id: u32) -> Result<(), Error> {
        VirtIoGpu::unmap_blob(self, res_id)
    }

    fn submit_3d(
        &self,
        ctx_id: u32,
        cmd: &[u8],
        ring_idx: Option<u8>,
        fence: bool,
    ) -> Result<(), Error> {
        if fence {
            VirtIoGpu::submit_3d_deferred(self, ctx_id, cmd, ring_idx).map(|_| ())
        } else {
            VirtIoGpu::submit_3d_unfenced(self, ctx_id, cmd)
        }
    }

    fn set_scanout_blob(&self, params: ScanoutBlobParams) -> Result<(), Error> {
        VirtIoGpu::set_scanout_blob(self, params)
    }

    fn bind_2d_scanout(&self) -> Result<(), Error> {
        VirtIoGpu::bind_2d_scanout(self)
    }

    fn disable_scanout(&self, scanout_id: u32) -> Result<(), Error> {
        VirtIoGpu::disable_scanout(self, scanout_id)
    }
}

static GLOBAL_3D: spinning_top::Spinlock<Option<Arc<dyn VirtioGpu3D>>> =
    spinning_top::Spinlock::new(None);

/// Publishes the 3D face of the probed virtio-gpu device for the kernel's
/// `VIRTGPU_*` ioctl layer. The first registration wins; later probes
/// (multiple GPUs) are ignored.
pub fn register_global_3d(dev: Arc<dyn VirtioGpu3D>) {
    let mut slot = GLOBAL_3D.lock();
    if slot.is_some() {
        log::warn!("virtio-gpu 3D face already registered; ignoring later device");
        return;
    }
    *slot = Some(dev);
}

/// Returns the registered 3D face, if any device was probed.
pub fn global_3d() -> Option<Arc<dyn VirtioGpu3D>> {
    GLOBAL_3D.lock().clone()
}
