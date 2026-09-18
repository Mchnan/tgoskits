//! Merged 2D + 3D virtio-gpu device driver.
//!
//! Everything below shares one control virtqueue behind a single spin
//! mutex. Two command flows exist:
//!
//! - *synchronous* control commands (2D surface, capsets, contexts,
//!   blobs, map/unmap, unfenced submits) block until the device's
//!   response lands in the used ring;
//! - *fenced* `SUBMIT_3D` commands return immediately — the host defers
//!   the response until the guest-provided venus command stream retires
//!   the fence, which can be arbitrarily later, so blocking there would
//!   stall (or hang) the guest.
//!
//! Both flows interleave over one queue through a FIFO of pending
//! chains (`Inner::pending`); responses are consumed strictly in order,
//! and completed chains are drained opportunistically by every later
//! operation. The 2D surface is a faithful port of `virtio-drivers`'
//! `VirtIOGpu` (minus the cursor path); the 3D face implements the
//! subset of the Linux virtio-gpu driver's control plane that the
//! `VIRTGPU_*` DRM ioctls and the venus capset need.

use alloc::{boxed::Box, collections::VecDeque, vec};
use core::{
    marker::PhantomData,
    ptr::NonNull,
    sync::atomic::{AtomicU64, Ordering},
};

use bitflags::bitflags;
use bytemuck::{Pod, Zeroable, bytes_of, try_from_bytes};
use spinning_top::Spinlock;
use virtio_drivers::{
    BufferDirection, Error as VirtIoError, Hal, PhysAddr,
    queue::VirtQueue,
    transport::{InterruptStatus, Transport},
};

use crate::{BlobParams, ScanoutBlobParams, VirtioGpu3D, protocol::*};

/// Control virtqueue depth. Indirect descriptors let each command chain
/// occupy a single slot, so this bounds the number of in-flight (fenced)
/// submits.
const QUEUE_SIZE: u16 = 64;
/// Control virtqueue index.
const QUEUE_CTRL: u16 = 0;
/// Driver-side DMA page size.
const PAGE_SIZE: usize = 0x1000;
/// Largest wire command struct (`virtio_gpu_ctx_create`).
const MAX_CMD_BYTES: usize = 128;
/// Spin budget for a synchronous response wait before declaring the
/// device unresponsive. Purely an error path — responses normally land
/// in microseconds. The venus host can take tens of milliseconds to
/// respond to RING-blob creation (it spawns the ring worker thread), so
/// the budget has to cover host-side latency spikes on macOS.
const SPIN_BUDGET: u64 = 8_000_000_000;

/// Fixed 2D scanout resource id (same value `VirtIOGpu` uses); 3D
/// resource ids live in a disjoint range so the two faces never collide
/// on the host.
const RESOURCE_ID_FB: u32 = 0xbabe;

// Negotiated feature set — see the field docs on `Features`.
bitflags! {
    /// Features this driver negotiates: the generic ring bits, EDID for
    /// the 2D surface, and every 3D face feature the device may offer.
    #[derive(Copy, Clone, Debug, PartialEq, Eq)]
    pub struct Features: u64 {
        /// 3D acceleration is present (virgl/venus backend behind the device).
        const VIRGL = 1 << 0;
        /// EDID is available for scanout configuration.
        const EDID = 1 << 1;
        /// Blob resources (`RESOURCE_CREATE_BLOB`) are supported.
        const RESOURCE_BLOB = 1 << 3;
        /// Explicit contexts (`CTX_CREATE` with a capset id) are supported.
        const CONTEXT_INIT = 1 << 4;
        /// The device config advertises a blob alignment requirement.
        const BLOB_ALIGNMENT = 1 << 5;
        const RING_INDIRECT_DESC = 1 << 28;
        const RING_EVENT_IDX = 1 << 29;
        const VERSION_1 = 1 << 32;
    }
}

const SUPPORTED_FEATURES: Features = Features::RING_EVENT_IDX
    .union(Features::RING_INDIRECT_DESC)
    .union(Features::VERSION_1)
    .union(Features::EDID)
    .union(Features::VIRGL)
    .union(Features::RESOURCE_BLOB)
    .union(Features::CONTEXT_INIT)
    .union(Features::BLOB_ALIGNMENT);

/// errno-style failure of a GPU operation; the kernel DRM layer maps
/// this straight onto its error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gpu3DError(pub u32);

impl Gpu3DError {
    pub const UNSUPPORTED: Self = Self(0x5c); // ENOSYS
    pub const NO_DEVICE: Self = Self(0x13); // ENODEV
    pub const NO_MEMORY: Self = Self(0xc); // ENOMEM
    pub const INVALID: Self = Self(0x16); // EINVAL
    pub const IO: Self = Self(0x5); // EIO
    pub const TIMEOUT: Self = Self(0x3e); // ETIMEDOUT
}

impl core::fmt::Display for Gpu3DError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "virtio-gpu error {} ({:#x})", self.0, self.0)
    }
}

impl core::error::Error for Gpu3DError {}

impl From<VirtIoError> for Gpu3DError {
    fn from(err: VirtIoError) -> Self {
        match err {
            VirtIoError::Unsupported => Self::UNSUPPORTED,
            VirtIoError::NotReady => Self::IO,
            VirtIoError::QueueFull => Self::NO_MEMORY,
            _ => Self::IO,
        }
    }
}

/// The host-visible (hostmem) shared memory region backing mappable blob
/// resources, discovered from the PCI `SHARED_MEMORY_CFG` capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostMemRegion {
    /// Guest-physical base address (PCI BAR + capability offset).
    pub phys_base: u64,
    pub length: u64,
}

/// Capability snapshot of the 3D face taken at probe time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gpu3DInfo {
    pub has_3d: bool,
    pub has_resource_blob: bool,
    pub has_host_visible: bool,
    pub has_context_init: bool,
    pub has_blob_alignment: bool,
    pub blob_alignment: u32,
    pub num_capsets: u32,
    pub hostmem: Option<HostMemRegion>,
}

/// Round a byte size up to whole driver pages.
const fn page_count(size: usize) -> usize {
    size.div_ceil(PAGE_SIZE)
}

/// A physically-contiguous DMA buffer allocated through the [`Hal`]
/// trait. The `virtio-drivers` `Dma` helper is crate-private, so this is
/// the same thing with the exact subset we need.
struct DmaBuffer<H: Hal> {
    paddr: PhysAddr,
    ptr: NonNull<u8>,
    page_count: usize,
    _hal: PhantomData<H>,
}

impl<H: Hal> DmaBuffer<H> {
    fn new(size: usize, direction: BufferDirection) -> Result<Self, Gpu3DError> {
        let page_count = page_count(size);
        let (paddr, ptr) = H::dma_alloc(page_count, direction);
        if paddr == 0 {
            return Err(Gpu3DError::NO_MEMORY);
        }
        Ok(Self {
            paddr,
            ptr,
            page_count,
            _hal: PhantomData,
        })
    }

    fn paddr(&self) -> u64 {
        self.paddr
    }

    fn base(&self) -> NonNull<u8> {
        self.ptr
    }

    fn slice(&self, len: usize) -> &[u8] {
        // SAFETY: the buffer holds `page_count * PAGE_SIZE` bytes.
        unsafe { core::slice::from_raw_parts(self.ptr.as_ptr(), len) }
    }

    fn write(&self, src: &[u8]) {
        // SAFETY: the buffer holds at least `src.len()` bytes and no
        // aliasing reference exists (device reads start only after the
        // chain is notified).
        unsafe { core::slice::from_raw_parts_mut(self.ptr.as_ptr(), src.len()) }
            .copy_from_slice(src);
    }
}

impl<H: Hal> Drop for DmaBuffer<H> {
    fn drop(&mut self) {
        // The Hal contract returns `0` on failure; there is nothing to
        // recover here either way.
        let _ = unsafe { H::dma_dealloc(self.paddr, self.ptr, self.page_count) };
    }
}

// SAFETY: `VirtioGpuDevice` owns its transport and DMA memory through the
// inner spin mutex; transports are MMIO wrappers over device state and all
// shared access is serialized, so the device handle is both `Send` and
// `Sync` (mirroring `VirtIoDisplay` in ax-driver). `DmaBuffer` is only
// reachable through that mutex and its `paddr` is valid for `Send`.
unsafe impl<H: Hal, T: Transport> Send for VirtioGpuDevice<H, T> {}
unsafe impl<H: Hal, T: Transport> Sync for VirtioGpuDevice<H, T> {}
unsafe impl<H: Hal> Send for DmaBuffer<H> {}

/// A 4 KiB-aligned page for the persistent receive buffer so wire-struct
/// field accesses are correctly aligned.
#[repr(C, align(4096))]
struct AlignedPage([u8; PAGE_SIZE]);

impl AlignedPage {
    fn zeroed() -> Box<Self> {
        Box::new(AlignedPage([0u8; PAGE_SIZE]))
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.0
    }

    fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

/// Buffers retained by an in-flight control chain. The header is always
/// driver-owned; `payload` is `Some` only for fenced submits, which
/// outlive their caller and therefore own a DMA copy of the command
/// stream. Synchronous entries borrow the payload instead
/// ([`Pending::payload_borrow`]) and are consumed before the caller's
/// frame ends; their responses land in the scratch page.
enum PendingBuffers<H: Hal> {
    Owned {
        header: Box<[u8; MAX_CMD_BYTES]>,
        payload: Option<DmaBuffer<H>>,
        payload_len: usize,
    },
}

struct Pending<H: Hal> {
    token: u16,
    send_len: usize,
    /// Borrowed payload for synchronous commands (kept alive by the
    /// caller's frame until the response is consumed).
    payload_borrow: Option<(*const u8, usize)>,
    buffers: PendingBuffers<H>,
}

struct Inner<H: Hal, T: Transport> {
    transport: T,
    control_queue: VirtQueue<H, { QUEUE_SIZE as usize }>,
    queue_buf_recv: Box<AlignedPage>,
    /// FIFO of in-flight chains; responses are consumed in this order.
    pending: VecDeque<Pending<H>>,
    /// Set when the device stops responding: every later op fails fast
    /// instead of racing a dead queue.
    broken: bool,
    framebuffer_dma: Option<DmaBuffer<H>>,
    framebuffer_size: usize,
    rect: Option<Rect>,
}

impl<H: Hal, T: Transport> Inner<H, T> {
    /// Adds a control chain of `[header, payload?]` -> `[recv]`.
    ///
    /// # Safety
    ///
    /// `header`, `payload` and `recv` must stay valid until this chain's
    /// response is consumed.
    unsafe fn add_chain(
        &mut self,
        header: (*const u8, usize),
        payload: Option<(*const u8, usize)>,
        recv: (*mut u8, usize),
    ) -> Result<u16, Gpu3DError> {
        // SAFETY: caller guarantees buffer validity per the fn contract.
        let (inputs, input_count, mut outputs) = unsafe {
            let mut inputs: [&[u8]; 2] = [core::slice::from_raw_parts(header.0, header.1), &[]];
            let mut input_count = 1usize;
            if let Some((ptr, len)) = payload {
                inputs[1] = core::slice::from_raw_parts(ptr, len);
                input_count += 1;
            }
            let outputs = [core::slice::from_raw_parts_mut(recv.0, recv.1)];
            (inputs, input_count, outputs)
        };

        // SAFETY: buffers are live per the fn contract; the queue lock is
        // held by the caller.
        let token = unsafe {
            self.control_queue
                .add(&inputs[..input_count], &mut outputs)?
        };
        if self.control_queue.should_notify() {
            self.transport.notify(QUEUE_CTRL);
        }
        Ok(token)
    }

    /// Consumes every completed chain at the head of the used ring,
    /// releasing its buffers.
    fn drain_completed(&mut self) {
        while self.control_queue.can_pop() {
            let Some(front) = self.pending.pop_front() else {
                break;
            };
            let PendingBuffers::Owned {
                header: h,
                payload: pl,
                payload_len,
            } = &front.buffers;
            let header: (*const u8, usize) = (h.as_ptr(), front.send_len);
            let payload = match pl {
                Some(d) => Some((d.slice(*payload_len).as_ptr(), *payload_len)),
                // Synchronous entry: payload is borrowed from the caller.
                None => front.payload_borrow,
            };
            let recv: (*mut u8, usize) = (
                self.queue_buf_recv.as_slice().as_ptr() as *mut u8,
                PAGE_SIZE,
            );

            // SAFETY: the pending entry guarantees header/payload are
            // alive until its response is consumed (now), and `recv` is
            // either the caller's live buffer or the scratch page.
            let popped = unsafe {
                let inputs = [
                    core::slice::from_raw_parts(header.0, header.1),
                    core::slice::from_raw_parts(
                        payload
                            .map(|p| p.0)
                            .unwrap_or(core::ptr::NonNull::dangling().as_ptr()),
                        payload.map(|p| p.1).unwrap_or(0),
                    ),
                ];
                let input_count = if payload.is_some() { 2 } else { 1 };
                let mut outputs = [core::slice::from_raw_parts_mut(recv.0, recv.1)];
                self.control_queue
                    .pop_used(front.token, &inputs[..input_count], &mut outputs)
            };
            match popped {
                Ok(_) => {}
                // Not ours yet / nothing usable: put it back and stop.
                Err(VirtIoError::WrongToken | VirtIoError::NotReady) => {
                    self.pending.push_front(front);
                    break;
                }
                Err(_) => {
                    self.pending.push_front(front);
                    self.broken = true;
                    break;
                }
            }
        }
    }

    /// Adds a synchronous control chain and spins until its response is
    /// consumed. `recv` must have room for the response.
    fn request_sync(
        &mut self,
        cmd: &[u8],
        payload: Option<&[u8]>,
        recv: (*mut u8, usize),
    ) -> Result<(), Gpu3DError> {
        if self.broken {
            return Err(Gpu3DError::IO);
        }
        self.drain_completed();
        if self.pending.len() >= QUEUE_SIZE as usize {
            return Err(Gpu3DError::NO_MEMORY);
        }

        // The command header is copied into driver-owned memory so the
        // device never DMA-addresses caller stack frames.
        let mut owned_header: Box<[u8; MAX_CMD_BYTES]> = Box::new([0; MAX_CMD_BYTES]);
        owned_header[..cmd.len()].copy_from_slice(cmd);
        let payload_ptr = payload.map(|p| (p.as_ptr(), p.len()));
        // SAFETY: `payload` lives for this call, and `recv` lives at
        // least until the entry is consumed or the device is declared
        // broken (which stops all further access).
        let token =
            unsafe { self.add_chain((owned_header.as_ptr(), cmd.len()), payload_ptr, recv)? };
        self.pending.push_back(Pending {
            token,
            send_len: cmd.len(),
            buffers: PendingBuffers::Owned {
                header: owned_header,
                payload: None,
                payload_len: 0,
            },
            payload_borrow: payload_ptr,
        });

        let mut budget = SPIN_BUDGET;
        loop {
            self.drain_completed();
            if !self.pending.iter().any(|p| p.token == token) {
                return Ok(());
            }
            if budget == 0 {
                // The device stopped responding; fail every later op and
                // drop the caller-borrowed buffers.
                self.broken = true;
                self.pending.clear();
                return Err(Gpu3DError::TIMEOUT);
            }
            budget -= 1;
            core::hint::spin_loop();
        }
    }

    /// Synchronous single-response round-trip: send the command struct,
    /// interpret the response prefix from the scratch page as `Rsp`.
    fn request<Req: Pod, Rsp: Pod>(&mut self, req: &Req) -> Result<Rsp, Gpu3DError> {
        let rsp_size = core::mem::size_of::<Rsp>();
        let recv = (self.queue_buf_recv.as_mut_slice().as_mut_ptr(), PAGE_SIZE);
        self.request_sync(bytes_of(req), None, recv)?;
        Ok(
            *try_from_bytes::<Rsp>(&self.queue_buf_recv.as_slice()[..rsp_size])
                .map_err(|_| Gpu3DError::IO)?,
        )
    }

    /// Like [`Self::request`] but the response lands in a caller-sized
    /// buffer (oversized responses such as capsets).
    fn request_into<Req: Pod>(&mut self, req: &Req, recv: &mut [u8]) -> Result<(), Gpu3DError> {
        self.request_sync(bytes_of(req), None, (recv.as_mut_ptr(), recv.len()))
    }

    /// Synchronous submit (unfenced): the host responds right away.
    fn request_with_payload<Req: Pod>(
        &mut self,
        req: &Req,
        payload: &[u8],
    ) -> Result<(), Gpu3DError> {
        let recv = (self.queue_buf_recv.as_mut_slice().as_mut_ptr(), PAGE_SIZE);
        self.request_sync(bytes_of(req), Some(payload), recv)
    }

    /// Fire-and-forget fenced submit: takes ownership of the header and
    /// payload so they outlive this call, and returns without waiting.
    /// An empty payload (ring kick) contributes no descriptor at all.
    fn submit_fenced(&mut self, header: &[u8], payload: &[u8]) -> Result<(), Gpu3DError> {
        if self.broken {
            return Err(Gpu3DError::IO);
        }
        self.drain_completed();
        if self.pending.len() >= QUEUE_SIZE as usize {
            return Err(Gpu3DError::NO_MEMORY);
        }

        let mut owned_header: Box<[u8; MAX_CMD_BYTES]> = Box::new([0; MAX_CMD_BYTES]);
        owned_header[..header.len()].copy_from_slice(header);
        let payload_dma = if payload.is_empty() {
            None
        } else {
            let payload_dma = DmaBuffer::<H>::new(payload.len(), BufferDirection::DriverToDevice)?;
            payload_dma.write(payload);
            Some(payload_dma)
        };

        let recv = (self.queue_buf_recv.as_mut_slice().as_mut_ptr(), PAGE_SIZE);
        // SAFETY: the header and payload buffers are owned by the pending
        // entry pushed below, which keeps them alive until the response is
        // consumed; the receive side is the scratch page.
        let token = unsafe {
            self.add_chain(
                (owned_header.as_ptr(), header.len()),
                payload_dma
                    .as_ref()
                    .map(|dma| (dma.slice(payload.len()).as_ptr(), payload.len())),
                recv,
            )?
        };
        self.pending.push_back(Pending {
            token,
            send_len: header.len(),
            payload_borrow: None,
            buffers: PendingBuffers::Owned {
                header: owned_header,
                payload: payload_dma,
                payload_len: payload.len(),
            },
        });
        Ok(())
    }
}

fn check_ok(rsp: &CtrlHeader) -> Result<(), Gpu3DError> {
    if rsp.ty != RESP_OK_NODATA {
        return Err(map_resp_err(rsp.ty));
    }
    Ok(())
}

fn map_resp_err(ty: u32) -> Gpu3DError {
    match ty {
        RESP_ERR_OUT_OF_MEMORY => Gpu3DError::NO_MEMORY,
        RESP_ERR_INVALID_SCANOUT_ID
        | RESP_ERR_INVALID_RESOURCE_ID
        | RESP_ERR_INVALID_CONTEXT_ID
        | RESP_ERR_INVALID_PARAMETER => Gpu3DError::INVALID,
        _ => Gpu3DError::IO,
    }
}

/// Merged 2D + 3D virtio-gpu device. All methods serialize on the inner
/// spin mutex.
pub struct VirtioGpuDevice<H: Hal, T: Transport> {
    inner: Spinlock<Inner<H, T>>,
    negotiated: Features,
    num_capsets: u32,
    blob_alignment: u32,
    hostmem: Option<HostMemRegion>,
    /// Monotonic fence id allocator (0 is invalid on the wire).
    next_fence_id: AtomicU64,
    _hal: PhantomData<H>,
}

impl<H: Hal, T: Transport> VirtioGpuDevice<H, T> {
    /// Takes ownership of the transport, negotiates features and sets up
    /// the control queue. `hostmem` is the shared-memory region the
    /// probe discovered from the PCI capabilities (`None` on devices
    /// without one — mappable blobs then fail with `ENODEV`).
    pub fn new(mut transport: T, hostmem: Option<HostMemRegion>) -> Result<Self, VirtIoError> {
        let negotiated = transport.begin_init(SUPPORTED_FEATURES);

        // `virtio_gpu_config`: events_read @0, events_clear @4,
        // num_scanouts @8, num_capsets @12, blob_alignment @16.
        let num_capsets = transport.read_config_space::<u32>(12).unwrap_or(0);
        let blob_alignment = transport.read_config_space::<u32>(16).unwrap_or(0);

        let control_queue = VirtQueue::new(
            &mut transport,
            QUEUE_CTRL,
            negotiated.contains(Features::RING_INDIRECT_DESC),
            negotiated.contains(Features::RING_EVENT_IDX),
        )?;

        transport.finish_init();

        Ok(Self {
            inner: Spinlock::new(Inner {
                transport,
                control_queue,
                queue_buf_recv: AlignedPage::zeroed(),
                pending: VecDeque::new(),
                broken: false,
                framebuffer_dma: None,
                framebuffer_size: 0,
                rect: None,
            }),
            negotiated,
            num_capsets,
            blob_alignment,
            hostmem,
            next_fence_id: AtomicU64::new(1),
            _hal: PhantomData,
        })
    }

    pub fn info(&self) -> Gpu3DInfo {
        Gpu3DInfo {
            has_3d: self.negotiated.contains(Features::VIRGL),
            has_resource_blob: self.negotiated.contains(Features::RESOURCE_BLOB),
            has_host_visible: self.hostmem.is_some(),
            has_context_init: self.negotiated.contains(Features::CONTEXT_INIT),
            has_blob_alignment: self.negotiated.contains(Features::BLOB_ALIGNMENT),
            blob_alignment: self.blob_alignment,
            num_capsets: self.num_capsets,
            hostmem: self.hostmem,
        }
    }

    // ---- 2D surface ----

    /// Acknowledge a device interrupt.
    pub fn ack_interrupt(&self) -> InterruptStatus {
        self.inner.lock().transport.ack_interrupt()
    }

    /// Query the display's preferred resolution.
    pub fn resolution(&self) -> Result<(u32, u32), Gpu3DError> {
        let info = self.get_display_info()?;
        Ok((info.rect.width, info.rect.height))
    }

    /// Set up the scanout framebuffer at the display's preferred
    /// resolution. Returns the base pointer and size of the DMA backing
    /// (kept alive by the device until the next resolution change).
    pub fn setup_framebuffer(&self) -> Result<(NonNull<u8>, usize), Gpu3DError> {
        let info = self.get_display_info()?;
        self.change_resolution(info.rect.width, info.rect.height)
    }

    /// Create a new 2D scanout resource at `width` x `height` and bind it
    /// to scanout 0, replacing any previous one.
    pub fn change_resolution(
        &self,
        width: u32,
        height: u32,
    ) -> Result<(NonNull<u8>, usize), Gpu3DError> {
        let rect = Rect {
            x: 0,
            y: 0,
            width,
            height,
        };
        let size = width as usize * height as usize * 4;

        let mut inner = self.inner.lock();
        if inner.framebuffer_dma.is_some() {
            let rsp: CtrlHeader = inner.request(&SetScanout {
                header: CtrlHeader::with_type(CMD_SET_SCANOUT),
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
                scanout_id: SCANOUT_ID,
                resource_id: 0,
            })?;
            check_ok(&rsp)?;
            let rsp: CtrlHeader = inner.request(&ResourceDetachBacking {
                header: CtrlHeader::with_type(CMD_RESOURCE_DETACH_BACKING),
                resource_id: RESOURCE_ID_FB,
                padding: 0,
            })?;
            check_ok(&rsp)?;
            let rsp: CtrlHeader = inner.request(&ResourceUnref {
                header: CtrlHeader::with_type(CMD_RESOURCE_UNREF),
                resource_id: RESOURCE_ID_FB,
                padding: 0,
            })?;
            check_ok(&rsp)?;
            inner.framebuffer_dma = None;
        }

        let rsp: CtrlHeader = inner.request(&ResourceCreate2D {
            header: CtrlHeader::with_type(CMD_RESOURCE_CREATE_2D),
            resource_id: RESOURCE_ID_FB,
            format: FORMAT_B8G8R8A8_UNORM,
            width,
            height,
        })?;
        check_ok(&rsp)?;

        let framebuffer_dma = DmaBuffer::<H>::new(size, BufferDirection::DriverToDevice)?;

        let rsp: CtrlHeader = inner.request(&ResourceAttachBacking {
            header: CtrlHeader::with_type(CMD_RESOURCE_ATTACH_BACKING),
            resource_id: RESOURCE_ID_FB,
            nr_entries: 1,
            entry: MemEntry {
                addr: framebuffer_dma.paddr(),
                length: size as u32,
                padding: 0,
            },
        })?;
        check_ok(&rsp)?;
        let rsp: CtrlHeader = inner.request(&SetScanout {
            header: CtrlHeader::with_type(CMD_SET_SCANOUT),
            rect,
            scanout_id: SCANOUT_ID,
            resource_id: RESOURCE_ID_FB,
        })?;
        check_ok(&rsp)?;

        let base = framebuffer_dma.base();
        inner.framebuffer_size = size;
        inner.framebuffer_dma = Some(framebuffer_dma);
        inner.rect = Some(rect);
        Ok((base, size))
    }

    /// Flush the whole scanout rect to the host (copy + flip).
    pub fn flush(&self) -> Result<(), Gpu3DError> {
        let rect = { self.inner.lock().rect };
        let Some(rect) = rect else {
            return Err(Gpu3DError::NO_DEVICE);
        };
        let mut inner = self.inner.lock();
        let rsp: CtrlHeader = inner.request(&TransferToHost2D {
            header: CtrlHeader::with_type(CMD_TRANSFER_TO_HOST_2D),
            rect,
            offset: 0,
            resource_id: RESOURCE_ID_FB,
            padding: 0,
        })?;
        check_ok(&rsp)?;
        let rsp: CtrlHeader = inner.request(&ResourceFlush {
            header: CtrlHeader::with_type(CMD_RESOURCE_FLUSH),
            rect,
            resource_id: RESOURCE_ID_FB,
            padding: 0,
        })?;
        check_ok(&rsp)?;
        Ok(())
    }

    fn get_display_info(&self) -> Result<RespDisplayInfo, Gpu3DError> {
        let mut inner = self.inner.lock();
        let info: RespDisplayInfo = inner.request(&CtrlHeader::with_type(CMD_GET_DISPLAY_INFO))?;
        if info.header.ty != RESP_OK_DISPLAY_INFO {
            return Err(Gpu3DError::IO);
        }
        Ok(info)
    }

    /// Size of the live scanout framebuffer, for adapters that expose
    /// the framebuffer slice themselves.
    pub fn framebuffer_size(&self) -> usize {
        self.inner.lock().framebuffer_size
    }
}

impl<H: Hal, T: Transport> VirtioGpu3D for VirtioGpuDevice<H, T> {
    fn info(&self) -> Gpu3DInfo {
        VirtioGpuDevice::info(self)
    }

    fn capset_info(&self, index: u32) -> Result<(u32, u32, u32), Gpu3DError> {
        if index >= self.num_capsets {
            return Err(Gpu3DError::INVALID);
        }
        let mut inner = self.inner.lock();
        let rsp: RespCapsetInfo = inner.request(&GetCapsetInfo {
            header: CtrlHeader::with_type(CMD_GET_CAPSET_INFO),
            capset_index: index,
            padding: 0,
        })?;
        if rsp.header.ty != RESP_OK_CAPSET_INFO {
            return Err(map_resp_err(rsp.header.ty));
        }
        Ok((rsp.capset_id, rsp.capset_max_version, rsp.capset_max_size))
    }

    fn capset(&self, id: u32, version: u32, out: &mut [u8]) -> Result<usize, Gpu3DError> {
        let req = GetCapset {
            header: CtrlHeader::with_type(CMD_GET_CAPSET),
            capset_id: id,
            capset_version: version,
        };
        // Response = ctrl header + capset data; size it generously.
        let hdr_size = core::mem::size_of::<CtrlHeader>();
        let mut recv = vec![0u8; PAGE_SIZE + hdr_size];
        let mut inner = self.inner.lock();
        inner.request_into(&req, &mut recv)?;
        if recv.len() < hdr_size || &recv[..4] != bytes_of(&RESP_OK_CAPSET) {
            return Err(Gpu3DError::IO);
        }
        let data = &recv[hdr_size..];
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
    ) -> Result<(), Gpu3DError> {
        let mut req = CtxCreate {
            header: CtrlHeader::with_type(CMD_CTX_CREATE),
            nlen: debug_name.len() as u32,
            context_init,
            debug_name: [0; 64],
        };
        let name = &debug_name.as_bytes()[..debug_name.len().min(64)];
        req.debug_name[..name.len()].copy_from_slice(name);
        // context_init carries the capset id in its low byte per the
        // VIRTIO_GPU_CONTEXT_INIT_CAPSET_ID_MASK contract.
        req.context_init |= capset_id & 0xff;
        req.header.ctx_id = ctx_id;

        let mut inner = self.inner.lock();
        let rsp: CtrlHeader = inner.request(&req)?;
        check_ok(&rsp)
    }

    fn ctx_destroy(&self, ctx_id: u32) -> Result<(), Gpu3DError> {
        let mut req = CtxDestroy {
            header: CtrlHeader::with_type(CMD_CTX_DESTROY),
        };
        req.header.ctx_id = ctx_id;
        let mut inner = self.inner.lock();
        let rsp: CtrlHeader = inner.request(&req)?;
        check_ok(&rsp)
    }

    fn resource_create_blob(&self, params: BlobParams, init_cmd: &[u8]) -> Result<(), Gpu3DError> {
        // Linux order: the optional initialization command stream is
        // submitted first (unfenced), then the blob resource is created
        // with the context id so the host attaches it.
        if !init_cmd.is_empty() {
            VirtioGpu3D::submit_3d(self, params.ctx_id, init_cmd, None, false)?;
        }
        let mut req = ResourceCreateBlob {
            header: CtrlHeader::with_type(CMD_RESOURCE_CREATE_BLOB),
            resource_id: params.res_id,
            blob_mem: params.blob_mem,
            blob_flags: params.blob_flags,
            nr_entries: 0,
            blob_id: params.blob_id,
            size: params.size,
        };
        req.header.ctx_id = params.ctx_id;

        let mut inner = self.inner.lock();
        let rsp: CtrlHeader = inner.request(&req)?;
        check_ok(&rsp)
    }

    fn resource_unref(&self, res_id: u32) -> Result<(), Gpu3DError> {
        let mut inner = self.inner.lock();
        let rsp: CtrlHeader = inner.request(&ResourceUnref {
            header: CtrlHeader::with_type(CMD_RESOURCE_UNREF),
            resource_id: res_id,
            padding: 0,
        })?;
        check_ok(&rsp)
    }

    fn map_blob(&self, res_id: u32, bar_offset: u64) -> Result<u32, Gpu3DError> {
        let mut inner = self.inner.lock();
        let rsp: RespMapInfo = inner.request(&ResourceMapBlob {
            header: CtrlHeader::with_type(CMD_RESOURCE_MAP_BLOB),
            resource_id: res_id,
            padding: 0,
            offset: bar_offset,
        })?;
        if rsp.header.ty != RESP_OK_MAP_INFO {
            return Err(map_resp_err(rsp.header.ty));
        }
        Ok(rsp.map_info & MAP_CACHE_MASK)
    }

    fn unmap_blob(&self, res_id: u32) -> Result<(), Gpu3DError> {
        let mut inner = self.inner.lock();
        let rsp: CtrlHeader = inner.request(&ResourceUnmapBlob {
            header: CtrlHeader::with_type(CMD_RESOURCE_UNMAP_BLOB),
            resource_id: res_id,
            padding: 0,
        })?;
        check_ok(&rsp)
    }

    fn submit_3d(
        &self,
        ctx_id: u32,
        cmd: &[u8],
        ring_idx: Option<u8>,
        fence: bool,
    ) -> Result<(), Gpu3DError> {
        let mut req = CmdSubmit {
            header: CtrlHeader::with_type(CMD_SUBMIT_3D),
            size: cmd.len() as u32,
            padding: 0,
        };
        req.header.ctx_id = ctx_id;
        if fence {
            req.header.flags |= HDR_FLAG_FENCE;
            req.header.fence_id = self.next_fence_id.fetch_add(1, Ordering::Relaxed);
            // Ring info rides along only on fenced commands, mirroring
            // the Linux driver's `virtio_gpu_fence_emit`.
            if let Some(idx) = ring_idx {
                req.header.flags |= HDR_FLAG_INFO_RING_IDX;
                req.header.ring_idx = idx;
            }
        }

        let mut inner = self.inner.lock();
        if fence {
            // The host defers the response until the guest-provided
            // stream retires the fence, so this must not block; the
            // entry owns its buffers until the response is drained.
            inner.submit_fenced(bytes_of(&req), cmd)?;
        } else if cmd.is_empty() {
            // Ring kicks carry no stream; skip the zero-length payload
            // descriptor entirely.
            let recv = (inner.queue_buf_recv.as_mut_slice().as_mut_ptr(), PAGE_SIZE);
            inner.request_sync(bytes_of(&req), None, recv)?;
        } else {
            // Unfenced submits respond immediately; a synchronous
            // round-trip is safe (and matches Linux's single-fence
            // ordering for the ioctls that need completion).
            inner.request_with_payload(&req, cmd)?;
        }
        Ok(())
    }

    fn set_scanout_blob(&self, params: ScanoutBlobParams) -> Result<(), Gpu3DError> {
        let req = SetScanoutBlob {
            header: CtrlHeader::with_type(CMD_SET_SCANOUT_BLOB),
            rect: Rect {
                x: params.x,
                y: params.y,
                width: params.scanout_width,
                height: params.scanout_height,
            },
            scanout_id: params.scanout_id,
            resource_id: params.res_id,
            width: params.width,
            height: params.height,
            format: params.format,
            padding: 0,
            strides: [params.stride, 0, 0, 0],
            offsets: [params.offset, 0, 0, 0],
        };
        let mut inner = self.inner.lock();
        let rsp: CtrlHeader = inner.request(&req)?;
        check_ok(&rsp)
    }

    fn bind_2d_scanout(&self) -> Result<(), Gpu3DError> {
        let rect = { self.inner.lock().rect }.ok_or(Gpu3DError::NO_DEVICE)?;
        let mut inner = self.inner.lock();
        let rsp: CtrlHeader = inner.request(&SetScanout {
            header: CtrlHeader::with_type(CMD_SET_SCANOUT),
            rect,
            scanout_id: SCANOUT_ID,
            resource_id: RESOURCE_ID_FB,
        })?;
        check_ok(&rsp)
    }

    fn disable_scanout(&self, scanout_id: u32) -> Result<(), Gpu3DError> {
        let req = SetScanoutBlob {
            header: CtrlHeader::with_type(CMD_SET_SCANOUT_BLOB),
            rect: Rect::zeroed(),
            scanout_id,
            resource_id: 0,
            width: 0,
            height: 0,
            format: 0,
            padding: 0,
            strides: [0; 4],
            offsets: [0; 4],
        };
        let mut inner = self.inner.lock();
        let rsp: CtrlHeader = inner.request(&req)?;
        check_ok(&rsp)
    }
}

impl<H: Hal, T: Transport> Drop for VirtioGpuDevice<H, T> {
    fn drop(&mut self) {
        // Tell the device the queue is gone so it stops touching the
        // (freed) ring memory.
        let mut inner = self.inner.lock();
        inner.transport.queue_unset(QUEUE_CTRL);
    }
}
