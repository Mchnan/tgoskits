//! VirtIO GPU wire protocol types (subset of Linux
//! `include/uapi/linux/virtio_gpu.h` needed by the 2D scanout surface and
//! the venus-capable 3D face).
//!
//! All structs are `repr(C)` with explicit padding and bytemuck `Pod`;
//! the guest targets are little-endian, matching the wire format.

use bytemuck::{Pod, Zeroable};

// ---- control-queue commands ----

pub const CMD_GET_DISPLAY_INFO: u32 = 0x0100;
pub const CMD_RESOURCE_CREATE_2D: u32 = 0x0101;
pub const CMD_RESOURCE_UNREF: u32 = 0x0102;
pub const CMD_SET_SCANOUT: u32 = 0x0103;
pub const CMD_RESOURCE_FLUSH: u32 = 0x0104;
pub const CMD_TRANSFER_TO_HOST_2D: u32 = 0x0105;
pub const CMD_RESOURCE_ATTACH_BACKING: u32 = 0x0106;
pub const CMD_RESOURCE_DETACH_BACKING: u32 = 0x0107;
pub const CMD_GET_CAPSET_INFO: u32 = 0x0108;
pub const CMD_GET_CAPSET: u32 = 0x0109;
pub const CMD_GET_EDID: u32 = 0x010a;
pub const CMD_RESOURCE_CREATE_BLOB: u32 = 0x010c;
pub const CMD_CTX_CREATE: u32 = 0x0200;
pub const CMD_CTX_DESTROY: u32 = 0x0201;
pub const CMD_SUBMIT_3D: u32 = 0x0207;
pub const CMD_RESOURCE_MAP_BLOB: u32 = 0x0208;
pub const CMD_RESOURCE_UNMAP_BLOB: u32 = 0x0209;

pub const RESP_OK_NODATA: u32 = 0x1100;
pub const RESP_OK_DISPLAY_INFO: u32 = 0x1101;
pub const RESP_OK_CAPSET_INFO: u32 = 0x1102;
pub const RESP_OK_CAPSET: u32 = 0x1103;
pub const RESP_OK_MAP_INFO: u32 = 0x1106;
pub const RESP_ERR_UNSPEC: u32 = 0x1200;
pub const RESP_ERR_OUT_OF_MEMORY: u32 = 0x1201;
pub const RESP_ERR_INVALID_SCANOUT_ID: u32 = 0x1202;
pub const RESP_ERR_INVALID_RESOURCE_ID: u32 = 0x1203;
pub const RESP_ERR_INVALID_CONTEXT_ID: u32 = 0x1204;
pub const RESP_ERR_INVALID_PARAMETER: u32 = 0x1205;

/// Device feature bits (virtio_gpu.h `VIRTIO_GPU_F_*` plus the generic
/// virtio transport bits).
pub const F_VIRGL: u64 = 1 << 0;
pub const F_EDID: u64 = 1 << 1;
pub const F_RESOURCE_BLOB: u64 = 1 << 3;
pub const F_CONTEXT_INIT: u64 = 1 << 4;
pub const F_BLOB_ALIGNMENT: u64 = 1 << 5;
pub const F_RING_INDIRECT_DESC: u64 = 1 << 28;
pub const F_RING_EVENT_IDX: u64 = 1 << 29;
pub const F_VERSION_1: u64 = 1 << 32;

/// `virtio_gpu_ctrl_hdr` — shared by every control-queue command and
/// response.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct CtrlHeader {
    pub ty: u32,
    pub flags: u32,
    pub fence_id: u64,
    pub ctx_id: u32,
    pub ring_idx: u8,
    pub padding: [u8; 3],
}

pub const HDR_FLAG_FENCE: u32 = 1 << 0;
pub const HDR_FLAG_INFO_RING_IDX: u32 = 1 << 1;

impl CtrlHeader {
    pub const fn with_type(ty: u32) -> Self {
        Self {
            ty,
            flags: 0,
            fence_id: 0,
            ctx_id: 0,
            ring_idx: 0,
            padding: [0; 3],
        }
    }
}

// ---- 2D scanout surface ----

pub const FORMAT_B8G8R8A8_UNORM: u32 = 1;

/// `virtio_gpu_rect` — the scanout/flush rectangle (x/y/w/h packed as
/// four u32s; the header's `depth`..`flags` tail is unused padding).
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ResourceCreate2D {
    pub header: CtrlHeader,
    pub resource_id: u32,
    pub format: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ResourceUnref {
    pub header: CtrlHeader,
    pub resource_id: u32,
    pub padding: u32,
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct SetScanout {
    pub header: CtrlHeader,
    pub rect: Rect,
    pub scanout_id: u32,
    pub resource_id: u32,
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ResourceFlush {
    pub header: CtrlHeader,
    pub rect: Rect,
    pub resource_id: u32,
    pub padding: u32,
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct TransferToHost2D {
    pub header: CtrlHeader,
    pub rect: Rect,
    pub offset: u64,
    pub resource_id: u32,
    pub padding: u32,
}

/// One `virtio_gpu_mem_entry` — single contiguous backing entry.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct MemEntry {
    pub addr: u64,
    pub length: u32,
    pub padding: u32,
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ResourceAttachBacking {
    pub header: CtrlHeader,
    pub resource_id: u32,
    pub nr_entries: u32,
    pub entry: MemEntry,
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ResourceDetachBacking {
    pub header: CtrlHeader,
    pub resource_id: u32,
    pub padding: u32,
}

/// `virtio_gpu_resp_display_info` — one scanout's preferred mode.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct RespDisplayInfo {
    pub header: CtrlHeader,
    pub rect: Rect,
    pub enabled: u32,
    pub flags: u32,
}

// ---- 3D face ----

pub const SCANOUT_ID: u32 = 0;

/// `VIRTGPU_PARAM_*` values surfaced by the DRM layer's GETPARAM.
pub const PARAM_3D_FEATURES: u64 = 1;
pub const PARAM_CAPSET_QUERY_FIX: u64 = 2;
pub const PARAM_RESOURCE_BLOB: u64 = 3;
pub const PARAM_HOST_VISIBLE: u64 = 4;
pub const PARAM_CROSS_DEVICE: u64 = 5;
pub const PARAM_CONTEXT_INIT: u64 = 6;
pub const PARAM_SUPPORTED_CAPSET_IDS: u64 = 7;
pub const PARAM_BLOB_ALIGNMENT: u64 = 9;

pub const BLOB_MEM_GUEST: u32 = 0x0001;
pub const BLOB_MEM_HOST3D: u32 = 0x0002;
pub const BLOB_MEM_HOST3D_GUEST: u32 = 0x0003;

pub const BLOB_FLAG_USE_MAPPABLE: u32 = 0x0001;
pub const BLOB_FLAG_USE_SHAREABLE: u32 = 0x0002;
pub const BLOB_FLAG_USE_CROSS_DEVICE: u32 = 0x0004;

pub const MAP_CACHE_MASK: u32 = 0x0f;
pub const MAP_CACHE_CACHED: u32 = 0x01;

pub const CAPSET_VIRGL: u32 = 1;
pub const CAPSET_VIRGL2: u32 = 2;
pub const CAPSET_GFXSTREAM_VULKAN: u32 = 3;
pub const CAPSET_VENUS: u32 = 4;
pub const CAPSET_CROSS_DOMAIN: u32 = 5;
pub const CAPSET_DRM: u32 = 6;

/// `virtio_gpu_ctx_create`.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct CtxCreate {
    pub header: CtrlHeader,
    pub nlen: u32,
    pub context_init: u32,
    pub debug_name: [u8; 64],
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct CtxDestroy {
    pub header: CtrlHeader,
}

/// `virtio_gpu_get_capset_info`.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct GetCapsetInfo {
    pub header: CtrlHeader,
    pub capset_index: u32,
    pub padding: u32,
}

/// `virtio_gpu_resp_capset_info`.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct RespCapsetInfo {
    pub header: CtrlHeader,
    pub capset_id: u32,
    pub capset_max_version: u32,
    pub capset_max_size: u32,
    pub padding: u32,
}

/// `virtio_gpu_get_capset`.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct GetCapset {
    pub header: CtrlHeader,
    pub capset_id: u32,
    pub capset_version: u32,
}

/// `virtio_gpu_resource_create_blob` (no mem entries follow — the 3D
/// layer only creates host-allocated blobs, `nr_entries = 0`).
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ResourceCreateBlob {
    pub header: CtrlHeader,
    pub resource_id: u32,
    pub blob_mem: u32,
    pub blob_flags: u32,
    pub nr_entries: u32,
    pub blob_id: u64,
    pub size: u64,
}

const _: () = assert!(core::mem::size_of::<ResourceCreateBlob>() == 56);

/// `virtio_gpu_resource_map_blob`.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ResourceMapBlob {
    pub header: CtrlHeader,
    pub resource_id: u32,
    pub padding: u32,
    pub offset: u64,
}

/// `virtio_gpu_resp_map_info`.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct RespMapInfo {
    pub header: CtrlHeader,
    pub map_info: u32,
    pub padding: u32,
}

/// `virtio_gpu_resource_unmap_blob`.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ResourceUnmapBlob {
    pub header: CtrlHeader,
    pub resource_id: u32,
    pub padding: u32,
}

/// `virtio_gpu_cmd_submit`.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct CmdSubmit {
    pub header: CtrlHeader,
    pub size: u32,
    pub padding: u32,
}
