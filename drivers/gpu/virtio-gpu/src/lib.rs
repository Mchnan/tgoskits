//! VirtIO GPU driver: one transport, one control queue, both faces.
//!
//! The upstream [`virtio_drivers`] GPU driver only covers the 2D scanout
//! surface. Venus (and any other 3D capset) additionally needs the 3D
//! control-plane: capability-set queries, contexts, blob resources,
//! host-visible BAR mapping and command submission. All of those travel
//! over the *same* control virtqueue as the 2D commands, so they must be
//! driven by a single owner of the transport — two drivers on one device
//! would each keep private avail/used indices and corrupt the queue.
//!
//! This crate therefore provides [`VirtioGpuDevice`], a merged driver:
//!
//! - the 2D surface (framebuffer setup / flush / resolution), a faithful
//!   port of `virtio-drivers`' `VirtIOGpu` minus the cursor path (unused
//!   by the ArceOS display stack);
//! - the 3D face behind the [`VirtioGpu3D`] trait, which an OS kernel can
//!   reach through the process-global [`global_3d`] registry to implement
//!   the `VIRTGPU_*` DRM ioctl family.
//!
//! All control-queue traffic serializes on one internal spin mutex and
//! every command is a synchronous round-trip (single in-flight request,
//! matching `VirtQueue::add_notify_wait_pop`'s contract). Fences are
//! therefore "signalled when the ioctl returns"; an IRQ-driven
//! completion path is future work.

#![cfg_attr(not(test), no_std)]
extern crate alloc;

mod device;
pub mod protocol;

use alloc::sync::Arc;

pub use device::{Gpu3DError, Gpu3DInfo, HostMemRegion, VirtioGpuDevice};
pub use protocol::{
    BLOB_FLAG_USE_CROSS_DEVICE, BLOB_FLAG_USE_MAPPABLE, BLOB_FLAG_USE_SHAREABLE, BLOB_MEM_GUEST,
    BLOB_MEM_HOST3D, BLOB_MEM_HOST3D_GUEST, CAPSET_VENUS, MAP_CACHE_CACHED, MAP_CACHE_MASK,
    PARAM_3D_FEATURES, PARAM_BLOB_ALIGNMENT, PARAM_CAPSET_QUERY_FIX, PARAM_CONTEXT_INIT,
    PARAM_CROSS_DEVICE, PARAM_HOST_VISIBLE, PARAM_SUPPORTED_CAPSET_IDS,
};

/// Kernel-facing 3D operations of a virtio-gpu device.
///
/// Implemented by the device registered through [`register_global_3d`].
/// Resource and context IDs are allocated by the caller (the DRM layer);
/// resource IDs must not collide with the 2D scanout resource (which
/// occupies the low IDs) — the DRM layer starts at
/// [`FIRST_3D_RESOURCE_ID`].
pub trait VirtioGpu3D: Send + Sync {
    /// Device capability summary snapshot taken at probe time.
    fn info(&self) -> Gpu3DInfo;

    /// `GET_CAPSET_INFO` for the capset at `index`:
    /// returns `(capset_id, max_version, max_size)`.
    fn capset_info(&self, index: u32) -> Result<(u32, u32, u32), Gpu3DError>;

    /// `GET_CAPSET` for `(id, version)`. Fills up to `out.len()` bytes and
    /// returns the total capset size reported by the host.
    fn capset(&self, id: u32, version: u32, out: &mut [u8]) -> Result<usize, Gpu3DError>;

    /// `CTX_CREATE` with the capset id in `context_init`'s low byte.
    fn ctx_create(
        &self,
        ctx_id: u32,
        capset_id: u32,
        context_init: u32,
        debug_name: &str,
    ) -> Result<(), Gpu3DError>;

    fn ctx_destroy(&self, ctx_id: u32) -> Result<(), Gpu3DError>;

    /// `RESOURCE_CREATE_BLOB`. `init_cmd` (the optional pre-blob
    /// initialization command stream) and `cmd` must be physically
    /// contiguous and DMA-capable kernel memory.
    fn resource_create_blob(&self, params: BlobParams, init_cmd: &[u8]) -> Result<(), Gpu3DError>;

    fn resource_unref(&self, res_id: u32) -> Result<(), Gpu3DError>;

    /// `RESOURCE_MAP_BLOB` into the host-visible BAR at `bar_offset`;
    /// returns the host's `map_info` cache hint.
    fn map_blob(&self, res_id: u32, bar_offset: u64) -> Result<u32, Gpu3DError>;

    fn unmap_blob(&self, res_id: u32) -> Result<(), Gpu3DError>;

    /// `SUBMIT_3D`. `cmd` must be physically contiguous and DMA-capable.
    /// With `fence` the command carries `VIRTIO_GPU_FLAG_FENCE` and the
    /// device's response (and hence this call) returns once the host has
    /// retired the fence; without it the response is awaited too — this
    /// synchronous mode serializes every submission. `ring_idx` selects
    /// the command ring/timeline and is encoded alongside the fence like
    /// the Linux driver does.
    fn submit_3d(
        &self,
        ctx_id: u32,
        cmd: &[u8],
        ring_idx: Option<u8>,
        fence: bool,
    ) -> Result<(), Gpu3DError>;
}

/// Wire parameters of a `RESOURCE_CREATE_BLOB` request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobParams {
    pub ctx_id: u32,
    pub res_id: u32,
    pub blob_mem: u32,
    pub blob_flags: u32,
    pub blob_id: u64,
    pub size: u64,
}

/// First resource id the 3D layer may allocate; keeps clear of the fixed
/// low ids the 2D scanout path uses (framebuffer / cursor resources).
pub const FIRST_3D_RESOURCE_ID: u32 = 0x1000;

static GLOBAL_3D: spinning_top::Spinlock<Option<Arc<dyn VirtioGpu3D>>> =
    spinning_top::Spinlock::new(None);

/// Publishes the 3D face of the probed virtio-gpu device. The first
/// registration wins; later probes (multiple GPUs) are ignored.
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
