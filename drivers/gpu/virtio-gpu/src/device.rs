//! The virtio-gpu control device.
//!
//! One transport, one control queue, both faces of the device:
//!
//! * the display path the OS adapters drive — framebuffer setup, the
//!   per-resource 2D scanout commands and the virgl 3D commands, and
//! * the venus-facing 3D surface — capability sets, contexts, host-visible blob
//!   resources mapped through the PCI shared-memory BAR, and fenced
//!   submissions on per-ring timelines.
//!
//! All control-queue traffic serializes on one internal spin mutex. Commands
//! the host answers right away are synchronous round-trips; a fenced
//! `SUBMIT_3D` on a ring-based (venus) context is *not* one — the host defers
//! its response until the fence retires, which can be arbitrarily late — so
//! those submissions own their buffers and are matched to their responses by
//! descriptor token instead of arrival order.

use alloc::{boxed::Box, collections::VecDeque, vec, vec::Vec};
use core::{
    marker::PhantomData,
    mem::size_of,
    ptr::NonNull,
    sync::atomic::{AtomicU64, Ordering},
};

use spinning_top::Spinlock;
use virtio_drivers::{
    BufferDirection, Hal, PAGE_SIZE,
    queue::VirtQueue,
    read_config,
    transport::{DeviceStatus, InterruptStatus, Transport},
    write_config,
};
use zerocopy::{FromBytes, Immutable, IntoBytes};

use crate::{
    BLOB_FLAG_USE_CROSS_DEVICE, BLOB_FLAG_USE_MASK, BLOB_MEM_GUEST, BLOB_MEM_HOST3D,
    BLOB_MEM_HOST3D_GUEST, CapsetInfo, Error, IrqEvent, Rect, ResourceCreate3d, ResourceCreateBlob,
    Transfer3d,
    dma::Dma,
    wire::{
        CmdCtxCreate, CmdCtxResource, CmdGetCapset, CmdGetCapsetInfo, CmdResourceCreate3D,
        CmdResourceCreateBlob, CmdResourceMapBlob, CmdResourceUnmapBlob, CmdSetScanoutBlob,
        CmdSubmit3D, CmdTransferHost3D, Command, Config, CtrlHeader, Features, Format, MemEntry,
        ResourceAttachBacking, ResourceCreate2D, ResourceDetachBacking, ResourceFlush,
        ResourceUnref, RespCapsetInfo, RespDisplayInfo, RespMapInfo, SUPPORTED_FEATURES,
        SetScanout, TransferToHost2D, VIRTIO_GPU_EVENT_DISPLAY,
    },
};

/// Control queue index (the device also has a cursor queue, which this driver
/// does not use).
const CONTROL_QUEUE: u16 = 0;

/// Descriptors per virtqueue.
///
/// Indirect descriptors let one command chain occupy a single slot, so this
/// bounds how many fenced submissions may be in flight at once. 64 leaves room
/// for a venus ring of outstanding work plus the synchronous commands the
/// display path interleaves.
const CONTROL_QUEUE_SIZE: u16 = 64;

/// Largest wire command struct this driver sends (`CmdCtxCreate`).
const MAX_CMD_BYTES: usize = 128;

/// Receive buffer for control responses.
const RECV_BUF_SIZE: usize = PAGE_SIZE;

/// Spin budget for a synchronous response wait before declaring the device
/// unresponsive. Purely an error path — responses normally land in
/// microseconds. A venus host can take tens of milliseconds for the first
/// commands of a ring (it starts worker threads on demand), so the budget has
/// to cover host-side latency spikes.
const SPIN_BUDGET: u64 = 8_000_000_000;

/// Scanout driven by this driver.
const SCANOUT_ID: u32 = 0;

/// Resource backing the default framebuffer.
const FRAMEBUFFER_RESOURCE_ID: u32 = 0xbabe;

/// Config-space offset of `num_capsets`.
///
/// [`Config`] does not model the field: it only exists on devices that report
/// capsets, and the 2D/virgl paths this driver grew out of never iterate them.
/// The 3D face does, so the register is read directly and defaults to zero.
const CONFIG_NUM_CAPSETS: usize = 12;
/// Config-space offset of `blob_alignment` (`VIRTIO_GPU_F_BLOB_ALIGNMENT`).
const CONFIG_BLOB_ALIGNMENT: usize = 16;

/// The host-visible shared memory region backing mappable blob resources,
/// resolved from the PCI `SHARED_MEMORY_CFG` capability at probe time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostMemRegion {
    /// Guest-physical base address (PCI BAR value + capability offset).
    pub phys_base: u64,
    /// Length in bytes.
    pub length: u64,
}

/// Capability snapshot of the device, taken once at probe time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GpuInfo {
    /// 3D support (virgl, or a venus-only renderer behind the same feature).
    pub has_3d: bool,
    /// `VIRTIO_GPU_F_RESOURCE_BLOB` was negotiated.
    pub has_resource_blob: bool,
    /// A host-visible shared memory region exists, so blobs can be mapped.
    pub has_host_visible: bool,
    /// `VIRTIO_GPU_F_CONTEXT_INIT` was negotiated.
    pub has_context_init: bool,
    /// The device advertises a blob alignment requirement.
    pub has_blob_alignment: bool,
    /// The advertised alignment in bytes (only meaningful with
    /// `has_blob_alignment`).
    pub blob_alignment: u32,
    /// Number of capability sets the device reports.
    pub num_capsets: u32,
    /// The shared memory region, when the device has one.
    pub hostmem: Option<HostMemRegion>,
}

/// Wire parameters of a `RESOURCE_CREATE_BLOB` request from the 3D face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobParams {
    /// Rendering context the blob is created on.
    pub ctx_id: u32,
    /// Resource ID assigned by the caller.
    pub res_id: u32,
    /// `VIRTIO_GPU_BLOB_MEM_*`.
    pub blob_mem: u32,
    /// `VIRTIO_GPU_BLOB_FLAG_*`.
    pub blob_flags: u32,
    /// Host-side blob identity (0 for host-allocated blobs).
    pub blob_id: u64,
    /// Size in bytes.
    pub size: u64,
}

/// Wire parameters of a `SET_SCANOUT_BLOB` request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanoutBlobParams {
    /// Blob resource to display; 0 disables the scanout.
    pub res_id: u32,
    /// Scanout to bind.
    pub scanout_id: u32,
    /// Visible sub-rect inside the framebuffer: X and Y offsets.
    pub x: u32,
    /// Visible sub-rect inside the framebuffer: Y offset.
    pub y: u32,
    /// Visible sub-rect width in pixels.
    pub scanout_width: u32,
    /// Visible sub-rect height in pixels.
    pub scanout_height: u32,
    /// Full framebuffer geometry: width in pixels.
    pub width: u32,
    /// Full framebuffer geometry: height in pixels.
    pub height: u32,
    /// `VIRTIO_GPU_FORMAT_*` of plane 0.
    pub format: u32,
    /// Plane-0 byte stride.
    pub stride: u32,
    /// Plane-0 byte offset into the blob.
    pub offset: u32,
}

/// One in-flight control command.
///
/// The buffers are owned here (the header is always copied into driver-owned
/// memory so the device never DMA-addresses a caller stack frame) and stay
/// alive until the matching response has been consumed.
struct Pending<H: Hal> {
    /// Descriptor token the response is matched against.
    token: u16,
    /// Bytes of `header` handed to the device.
    send_len: usize,
    header: Box<[u8; MAX_CMD_BYTES]>,
    /// Device-readable payload of a deferred submission, when any.
    payload: Option<Dma<H>>,
    payload_len: usize,
    /// Payload borrowed from the caller's frame, for synchronous commands
    /// (kept alive by the caller until this entry is consumed).
    payload_borrow: Option<(*const u8, usize)>,
    /// Private receive buffer for a deferred response. A fenced response may
    /// land at any time, so it must not share the scratch page a synchronous
    /// waiter is about to read.
    recv: Option<Dma<H>>,
}

/// Queue state behind the device's mutex.
struct Inner<H: Hal, T: Transport> {
    transport: T,
    control_queue: VirtQueue<H, { CONTROL_QUEUE_SIZE as usize }>,
    /// Scratch receive buffer for synchronous requests.
    queue_buf_recv: Box<[u8]>,
    /// FIFO of in-flight chains; responses are consumed in this order.
    pending: VecDeque<Pending<H>>,
    /// `(token, used length)` of the most recently consumed response.
    last_completed: Option<(u16, u32)>,
    /// Set when the device stops responding: every later op fails fast
    /// instead of racing a dead queue.
    broken: bool,
    framebuffer_dma: Option<Dma<H>>,
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
    ) -> Result<u16, Error> {
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
            self.transport.notify(CONTROL_QUEUE);
        }
        Ok(token)
    }

    /// Consumes at most one completed chain from the used ring, releasing its
    /// buffers.
    ///
    /// Responses may complete out of order: fenced submissions are retired by
    /// the host at its discretion while synchronous requests complete
    /// immediately. Entries are therefore matched by descriptor token, rotating
    /// past submissions whose responses have not landed yet.
    fn drain_completed(&mut self) {
        if !self.control_queue.can_pop() {
            return;
        }
        let count = self.pending.len();
        for _ in 0..count {
            let Some(front) = self.pending.pop_front() else {
                return;
            };
            let header: (*const u8, usize) = (front.header.as_ptr(), front.send_len);
            let payload = match &front.payload {
                Some(dma) => Some((dma.slice(front.payload_len).as_ptr(), front.payload_len)),
                // Synchronous entry: the payload is borrowed from the caller.
                None => front.payload_borrow,
            };
            let recv: (*mut u8, usize) = match &front.recv {
                Some(dma) => (dma.raw_slice().cast::<u8>().as_ptr(), PAGE_SIZE),
                None => (
                    self.queue_buf_recv.as_ptr() as *mut u8,
                    self.queue_buf_recv.len(),
                ),
            };

            // SAFETY: the pending entry guarantees header/payload are alive
            // until its response is consumed (now), and `recv` is either the
            // entry's private buffer or the scratch page owned by this queue.
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
                Ok(used_len) => {
                    self.last_completed = Some((front.token, used_len));
                    // The entry's buffers drop here, after the device is done
                    // with them.
                    return;
                }
                // Not ours yet: keep it (order preserved) and try the next
                // pending entry against the same used-ring head.
                Err(virtio_drivers::Error::WrongToken | virtio_drivers::Error::NotReady) => {
                    self.pending.push_back(front);
                }
                Err(err) => {
                    log::warn!("virtio-gpu: drain_completed hard error {err:?}; declaring broken");
                    self.pending.push_front(front);
                    self.broken = true;
                    return;
                }
            }
        }
    }

    /// Adds a synchronous control chain and spins until its response is
    /// consumed. `recv` must have room for the response. Returns the number of
    /// bytes the device wrote into `recv`.
    ///
    /// # Safety
    ///
    /// `recv` must stay valid for the duration of this call.
    unsafe fn request_sync(
        &mut self,
        cmd: &[u8],
        payload: Option<&[u8]>,
        recv: (*mut u8, usize),
    ) -> Result<u32, Error> {
        if self.broken {
            return Err(Error::DeviceFault);
        }
        self.drain_completed();
        if self.pending.len() >= CONTROL_QUEUE_SIZE as usize {
            return Err(Error::QueueFull);
        }

        // The command header is copied into driver-owned memory so the device
        // never DMA-addresses caller stack frames.
        let mut owned_header: Box<[u8; MAX_CMD_BYTES]> = Box::new([0; MAX_CMD_BYTES]);
        owned_header[..cmd.len()].copy_from_slice(cmd);
        let payload_ptr = payload.map(|p| (p.as_ptr(), p.len()));
        // SAFETY: `payload` lives for this call, and `recv` lives at least
        // until the entry is consumed or the device is declared broken (which
        // stops all further access).
        let token =
            unsafe { self.add_chain((owned_header.as_ptr(), cmd.len()), payload_ptr, recv)? };
        self.pending.push_back(Pending {
            token,
            send_len: cmd.len(),
            header: owned_header,
            payload: None,
            payload_len: 0,
            payload_borrow: payload_ptr,
            recv: None,
        });

        let mut budget = SPIN_BUDGET;
        loop {
            self.drain_completed();
            if !self.pending.iter().any(|p| p.token == token) {
                return Ok(self.last_completed.map(|(_, len)| len).unwrap_or(0));
            }
            if budget == 0 {
                // The device stopped responding; fail every later op and drop
                // the caller-borrowed buffers.
                log::warn!(
                    "virtio-gpu: request_sync budget exhausted (pending={}); declaring broken",
                    self.pending.len()
                );
                self.broken = true;
                self.pending.clear();
                return Err(Error::DeviceFault);
            }
            budget -= 1;
            core::hint::spin_loop();
        }
    }

    /// Synchronous single-response round-trip: send `req`, parse the response
    /// prefix as `Rsp`.
    fn request<Req: IntoBytes + Immutable, Rsp: FromBytes>(
        &mut self,
        req: &Req,
    ) -> Result<Rsp, Error> {
        // SAFETY: the scratch page is owned by this queue and outlives the
        // call.
        let used_len = unsafe {
            let recv = (self.queue_buf_recv.as_mut_ptr(), self.queue_buf_recv.len());
            self.request_sync(req.as_bytes(), None, recv)?
        };
        parse_response(&self.queue_buf_recv, used_len)
    }

    /// Synchronous command with a second device-readable buffer.
    ///
    /// An empty `data` contributes no descriptor at all: the virtqueue API
    /// rejects zero-length buffers, and a ring kick or an empty submit has
    /// nothing to send beyond its header.
    fn request_with_data<Req: IntoBytes + Immutable, Rsp: FromBytes>(
        &mut self,
        req: &Req,
        data: &[u8],
    ) -> Result<Rsp, Error> {
        // SAFETY: the scratch page is owned by this queue and outlives the
        // call; `data` is borrowed by the caller for the whole call.
        let used_len = unsafe {
            let recv = (self.queue_buf_recv.as_mut_ptr(), self.queue_buf_recv.len());
            self.request_sync(req.as_bytes(), (!data.is_empty()).then_some(data), recv)?
        };
        parse_response(&self.queue_buf_recv, used_len)
    }

    /// `GET_CAPSET`: the payload follows the response header, so the whole
    /// round-trip and the slice of the receive buffer stay in one lock scope.
    fn request_capset(
        &mut self,
        capset_id: u32,
        version: u32,
        size: u32,
    ) -> Result<Vec<u8>, Error> {
        let header_len = size_of::<CtrlHeader>();
        let capacity = self.queue_buf_recv.len().saturating_sub(header_len);
        if size as usize > capacity {
            return Err(Error::ResponseTooLarge);
        }
        let req = CmdGetCapset {
            header: CtrlHeader::with_type(Command::GET_CAPSET),
            capset_id,
            capset_version: version,
        };
        // SAFETY: the scratch page is owned by this queue and outlives the
        // call.
        let used_len = unsafe {
            let recv = (self.queue_buf_recv.as_mut_ptr(), self.queue_buf_recv.len());
            self.request_sync(req.as_bytes(), None, recv)?
        };
        let header: CtrlHeader = parse_response(&self.queue_buf_recv, used_len)?;
        header.check_type(Command::OK_CAPSET)?;
        // `size` is only an upper bound: slice by the bytes the device actually
        // wrote so stale receive-buffer contents never leak into the blob.
        let start = header_len;
        let end = (used_len as usize).clamp(start, start + size as usize);
        Ok(self.queue_buf_recv[start..end].to_vec())
    }

    /// Fire-and-forget fenced submit: takes ownership of the header and
    /// payload so they outlive this call, and returns without waiting. An
    /// empty payload (ring kick) contributes no descriptor at all.
    fn submit_fenced(&mut self, header: &[u8], payload: &[u8]) -> Result<(), Error> {
        if self.broken {
            log::warn!("virtio-gpu: submit_fenced on broken device");
            return Err(Error::DeviceFault);
        }
        self.drain_completed();
        if self.pending.len() >= CONTROL_QUEUE_SIZE as usize {
            return Err(Error::QueueFull);
        }

        let mut owned_header: Box<[u8; MAX_CMD_BYTES]> = Box::new([0; MAX_CMD_BYTES]);
        owned_header[..header.len()].copy_from_slice(header);
        let payload_dma = if payload.is_empty() {
            None
        } else {
            let mut payload_dma = Dma::<H>::new(payload.len(), BufferDirection::DriverToDevice)?;
            payload_dma.write(payload);
            Some(payload_dma)
        };
        // The response lands whenever the host retires the fence, which may be
        // long after later synchronous responses were written; give the entry
        // its own receive buffer instead of the shared scratch page.
        let recv_dma = Dma::<H>::new(PAGE_SIZE, BufferDirection::DeviceToDriver)?;

        let recv = (recv_dma.raw_slice().cast::<u8>().as_ptr(), PAGE_SIZE);
        // SAFETY: the header, payload and receive buffers are owned by the
        // pending entry pushed below, which keeps them alive until the response
        // is consumed (or the device is declared broken, which stops the host
        // from ever writing again).
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
            header: owned_header,
            payload: payload_dma,
            payload_len: payload.len(),
            payload_borrow: None,
            recv: Some(recv_dma),
        });
        Ok(())
    }
}

/// Parses `Rsp` from exactly the bytes the device wrote.
///
/// A response larger than the buffer or smaller than `Rsp` is rejected before
/// any parsing, so stale bytes left over in the buffer are never interpreted as
/// a response.
fn parse_response<Rsp: FromBytes>(buf: &[u8], used_len: u32) -> Result<Rsp, Error> {
    let used_len = used_len as usize;
    if used_len > buf.len() {
        return Err(Error::ResponseTooLarge);
    }
    if used_len < size_of::<Rsp>() {
        return Err(Error::InvalidResponse);
    }
    let (response, _) =
        Rsp::read_from_prefix(&buf[..used_len]).map_err(|_| Error::InvalidResponse)?;
    Ok(response)
}

/// Accepts the response only if it carries no error code.
fn check_ok(rsp: &CtrlHeader) -> Result<(), Error> {
    if rsp.command() == Command::OK_NODATA {
        Ok(())
    } else {
        Err(map_resp_err(rsp.command()))
    }
}

/// Maps a virtio-gpu error response onto a driver error.
fn map_resp_err(ty: Command) -> Error {
    match ty {
        Command::ERR_OUT_OF_MEMORY => Error::OutOfMemory,
        Command::ERR_INVALID_SCANOUT_ID
        | Command::ERR_INVALID_RESOURCE_ID
        | Command::ERR_INVALID_CONTEXT_ID
        | Command::ERR_INVALID_PARAMETER => Error::InvalidParam,
        other => Error::DeviceError(other.0),
    }
}

/// The merged 2D + virgl + venus virtio-gpu device.
///
/// Every method takes `&self` and serializes on the internal mutex, so one
/// device can be published to several consumers (the display adapter and the
/// kernel's `VIRTGPU_*` ioctl face) through a shared `Arc`.
pub struct VirtIoGpu<H: Hal, T: Transport> {
    inner: Spinlock<Inner<H, T>>,
    negotiated: Features,
    num_capsets: u32,
    blob_alignment: u32,
    hostmem: Option<HostMemRegion>,
    /// Monotonic fence id allocator (0 is invalid on the wire).
    next_fence_id: AtomicU64,
    _hal: PhantomData<H>,
}

impl<H: Hal, T: Transport> VirtIoGpu<H, T> {
    /// Initialises the device over `transport` and negotiates the feature set.
    ///
    /// `hostmem` is the shared memory region the probe discovered from the PCI
    /// capabilities (`None` on devices without one — mappable blobs then fail).
    pub fn new(transport: T, hostmem: Option<HostMemRegion>) -> Result<Self, Error> {
        let mut transport = transport;
        let negotiated = transport.begin_init(SUPPORTED_FEATURES);

        let events_read = read_config!(transport, Config, events_read)?;
        let num_scanouts = read_config!(transport, Config, num_scanouts)?;
        log::debug!(
            "virtio-gpu config: events_read={events_read:#x}, num_scanouts={num_scanouts:#x}"
        );
        let num_capsets = transport
            .read_config_space::<u32>(CONFIG_NUM_CAPSETS)
            .unwrap_or(0);
        let blob_alignment = transport
            .read_config_space::<u32>(CONFIG_BLOB_ALIGNMENT)
            .unwrap_or(0);

        let control_queue = VirtQueue::new(
            &mut transport,
            CONTROL_QUEUE,
            negotiated.contains(Features::RING_INDIRECT_DESC),
            negotiated.contains(Features::RING_EVENT_IDX),
        )?;

        let queue_buf_recv = vec![0u8; RECV_BUF_SIZE].into_boxed_slice();

        transport.finish_init();

        log::info!(
            "virtio-gpu features: negotiated={negotiated:?}, capsets={num_capsets}, \
             blob_alignment={blob_alignment}, hostmem={hostmem:?}"
        );

        Ok(Self {
            inner: Spinlock::new(Inner {
                transport,
                control_queue,
                queue_buf_recv,
                pending: VecDeque::new(),
                last_completed: None,
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

    /// Capability snapshot taken at probe time.
    pub fn info(&self) -> GpuInfo {
        GpuInfo {
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

    /// Whether the device negotiated virgl 3D support.
    pub fn has_virgl(&self) -> bool {
        self.negotiated.contains(Features::VIRGL)
    }

    /// Whether the device negotiated `VIRTIO_GPU_F_RESOURCE_BLOB`.
    ///
    /// Blob resources are what makes host-visible memory and dma-buf sharing
    /// (PRIME) possible. Note that a plain `GUEST` blob only needs this
    /// feature, not VIRGL; only `HOST3D` blobs need a rendering context.
    pub fn has_resource_blob(&self) -> bool {
        self.negotiated.contains(Features::RESOURCE_BLOB)
    }

    /// Whether the device negotiated `VIRTIO_GPU_F_CONTEXT_INIT`.
    ///
    /// Linux reports this as `has_context_init` in `virtgpu_getparam_ioctl()`;
    /// Mesa uses it to decide between the context-init protocol (a capset ID in
    /// `CTX_CREATE`) and the legacy VIRGL path. This is the actual negotiation
    /// result and is independent of [`Self::has_virgl`].
    pub fn has_context_init(&self) -> bool {
        self.negotiated.contains(Features::CONTEXT_INIT)
    }

    /// Rejects 3D commands when virgl was not negotiated.
    ///
    /// Every 3D command is undefined without the feature and the host would
    /// reject it, so the driver fails early with a domain error.
    fn require_virgl(&self) -> Result<(), Error> {
        if self.has_virgl() {
            Ok(())
        } else {
            Err(Error::Unsupported)
        }
    }

    /// Acknowledges the pending interrupt and reports what it carried.
    ///
    /// A device-configuration interrupt is read out of the config space, as
    /// Linux does in `virtio_gpu_config_changed_work_func()`: only the pending
    /// `VIRTIO_GPU_EVENT_DISPLAY` bit sets `display_changed`, and it is cleared
    /// through `events_clear`. Config-space reads and writes cannot fail the
    /// interrupt: an unreadable `events_read` conservatively reports
    /// `display_changed`, a failed clear is ignored, and the configuration
    /// interrupt stays reported as handled either way, because the status bit
    /// was already acknowledged.
    pub fn ack_interrupt(&self) -> IrqEvent {
        let mut inner = self.inner.lock();
        let status = inner.transport.ack_interrupt();
        let queue = status.contains(InterruptStatus::QUEUE_INTERRUPT);
        let configuration = status.contains(InterruptStatus::DEVICE_CONFIGURATION_INTERRUPT);
        let mut display_changed = false;
        if configuration {
            match read_config!(inner.transport, Config, events_read) {
                Ok(events) => {
                    if events & VIRTIO_GPU_EVENT_DISPLAY != 0 {
                        display_changed = true;
                        // A failed clear is not fatal: the event stays
                        // reported and a later interrupt re-reads the same
                        // register.
                        let _ = write_config!(
                            inner.transport,
                            Config,
                            events_clear,
                            VIRTIO_GPU_EVENT_DISPLAY
                        );
                    }
                }
                // The events register is unreadable, so the pending event
                // cannot be classified. Report a display change rather than
                // dropping the interrupt.
                Err(_) => display_changed = true,
            }
        }
        IrqEvent {
            queue,
            configuration,
            display_changed,
        }
    }

    /// Returns the device's current display resolution in pixels.
    pub fn resolution(&self) -> Result<(u32, u32), Error> {
        let info = self.get_display_info()?;
        Ok((info.rect.width, info.rect.height))
    }

    /// Sets up a scanout framebuffer at the device's preferred resolution.
    ///
    /// Returns the base pointer and size of the DMA backing, which the device
    /// keeps alive until the next resolution change.
    pub fn setup_framebuffer(&self) -> Result<(NonNull<u8>, usize), Error> {
        let info = self.get_display_info()?;
        self.change_resolution(info.rect.width, info.rect.height)
    }

    /// Recreates the framebuffer resource with the given size and binds it to
    /// the scanout.
    ///
    /// An existing framebuffer is torn down first, telling the device to stop
    /// using its backing before that backing is released. The framebuffer is
    /// only published (as `rect` and `framebuffer_dma`) after the resource is
    /// created, its backing is attached and the scanout is bound, so a failure
    /// part-way leaves no state claiming a framebuffer the device is not
    /// actually scanning out.
    pub fn change_resolution(
        &self,
        width: u32,
        height: u32,
    ) -> Result<(NonNull<u8>, usize), Error> {
        let rect = Rect {
            x: 0,
            y: 0,
            width,
            height,
        };
        let size = framebuffer_size(width, height)?;
        let size_bytes = size as usize;

        let mut inner = self.inner.lock();

        // Stop any existing framebuffer before touching the device again.
        if inner.framebuffer_dma.is_some() {
            teardown_framebuffer(&mut inner)?;
        }

        // Create the resource first: a failure leaves nothing to roll back.
        let rsp: CtrlHeader = inner.request(&ResourceCreate2D {
            header: CtrlHeader::with_type(Command::RESOURCE_CREATE_2D),
            resource_id: FRAMEBUFFER_RESOURCE_ID,
            format: Format::B8G8R8A8Unorm,
            width,
            height,
        })?;
        check_ok(&rsp)?;

        // Allocate the backing after the resource exists and before attaching
        // it, so a DMA failure drops the resource instead of a live mapping.
        let framebuffer_dma = Dma::<H>::new(size_bytes, BufferDirection::DriverToDevice)?;
        let paddr = framebuffer_dma.paddr();

        // SAFETY: `framebuffer_dma` owns a live, zeroed, at least `size` byte
        // DMA region (the allocation is rounded up to whole pages). On the
        // success path the value is moved into `inner.framebuffer_dma`, and it
        // is only released by the teardown path after `detach_backing` and
        // `unref_resource`, so the device stops using the range before it is
        // freed. Nothing else in this driver hands the same range to the device
        // or aliases it.
        if let Err(err) =
            unsafe { attach_backing(&mut inner, FRAMEBUFFER_RESOURCE_ID, paddr, size) }
        {
            // The resource exists but has no backing; release it so a failed
            // attach does not leak a host resource.
            let _ = unref_resource(&mut inner, FRAMEBUFFER_RESOURCE_ID);
            return Err(err);
        }

        // Bind the resource to the scanout. If that fails we must stop the
        // device from using the backing before freeing it: detach first, then
        // unref. Only a confirmed detach lets the DMA be released; otherwise it
        // is kept so a later retry, or the `Drop` device reset, can release it
        // once the device is known to be done.
        let bound: Result<(), Error> = inner
            .request(&SetScanout {
                header: CtrlHeader::with_type(Command::SET_SCANOUT),
                rect,
                scanout_id: SCANOUT_ID,
                resource_id: FRAMEBUFFER_RESOURCE_ID,
            })
            .and_then(|rsp| check_ok(&rsp));
        if let Err(err) = bound {
            let detached = detach_backing(&mut inner, FRAMEBUFFER_RESOURCE_ID).is_ok();
            let _ = unref_resource(&mut inner, FRAMEBUFFER_RESOURCE_ID);
            if !detached {
                // Keep the DMA alive: the device may still be writing into it.
                inner.framebuffer_dma = Some(framebuffer_dma);
            }
            return Err(err);
        }

        let base = framebuffer_dma.raw_slice().cast::<u8>();
        inner.framebuffer_size = size_bytes;
        inner.framebuffer_dma = Some(framebuffer_dma);
        inner.rect = Some(rect);
        Ok((base, size_bytes))
    }

    /// Bind the driver's own 2D framebuffer after another scanout was in use.
    pub fn restore_framebuffer_scanout(&self) -> Result<(), Error> {
        let mut inner = self.inner.lock();
        let rect = inner.rect.ok_or(Error::NotReady)?;
        let rsp: CtrlHeader = inner.request(&SetScanout {
            header: CtrlHeader::with_type(Command::SET_SCANOUT),
            rect,
            scanout_id: SCANOUT_ID,
            resource_id: FRAMEBUFFER_RESOURCE_ID,
        })?;
        check_ok(&rsp)
    }

    /// Transfers the framebuffer to the host and flushes it to the scanout.
    pub fn flush(&self) -> Result<(), Error> {
        let mut inner = self.inner.lock();
        let rect = inner.rect.ok_or(Error::NotReady)?;
        let rsp: CtrlHeader = inner.request(&TransferToHost2D {
            header: CtrlHeader::with_type(Command::TRANSFER_TO_HOST_2D),
            rect,
            offset: 0,
            resource_id: FRAMEBUFFER_RESOURCE_ID,
            _padding: 0,
        })?;
        check_ok(&rsp)?;
        let rsp: CtrlHeader = inner.request(&ResourceFlush {
            header: CtrlHeader::with_type(Command::RESOURCE_FLUSH),
            rect,
            resource_id: FRAMEBUFFER_RESOURCE_ID,
            _padding: 0,
        })?;
        check_ok(&rsp)
    }

    /// Size of the live scanout framebuffer.
    pub fn framebuffer_size(&self) -> usize {
        self.inner.lock().framebuffer_size
    }

    // --- 2D resource and scanout commands ---

    /// Creates a 2D resource in `B8G8R8A8_UNORM` format.
    pub fn resource_create_2d(
        &self,
        resource_id: u32,
        width: u32,
        height: u32,
    ) -> Result<(), Error> {
        let rsp: CtrlHeader = self.inner.lock().request(&ResourceCreate2D {
            header: CtrlHeader::with_type(Command::RESOURCE_CREATE_2D),
            resource_id,
            format: Format::B8G8R8A8Unorm,
            width,
            height,
        })?;
        check_ok(&rsp)
    }

    /// Binds `resource_id` to `scanout_id` for the given display area.
    pub fn set_scanout(&self, rect: Rect, scanout_id: u32, resource_id: u32) -> Result<(), Error> {
        let rsp: CtrlHeader = self.inner.lock().request(&SetScanout {
            header: CtrlHeader::with_type(Command::SET_SCANOUT),
            rect,
            scanout_id,
            resource_id,
        })?;
        check_ok(&rsp)
    }

    /// Refreshes `rect` of `resource_id` on the display.
    pub fn resource_flush(&self, rect: Rect, resource_id: u32) -> Result<(), Error> {
        let rsp: CtrlHeader = self.inner.lock().request(&ResourceFlush {
            header: CtrlHeader::with_type(Command::RESOURCE_FLUSH),
            rect,
            resource_id,
            _padding: 0,
        })?;
        check_ok(&rsp)
    }

    /// Transfers `rect` of a 2D resource from guest memory to the host.
    pub fn transfer_to_host_2d(
        &self,
        rect: Rect,
        offset: u64,
        resource_id: u32,
    ) -> Result<(), Error> {
        let rsp: CtrlHeader = self.inner.lock().request(&TransferToHost2D {
            header: CtrlHeader::with_type(Command::TRANSFER_TO_HOST_2D),
            rect,
            offset,
            resource_id,
            _padding: 0,
        })?;
        check_ok(&rsp)
    }

    /// Attaches one guest-physical memory range to a resource.
    ///
    /// The device reads and writes `paddr..paddr + length` directly for as long
    /// as the resource exists, so the caller must guarantee that the range is
    /// device-accessible guest memory and stays allocated, unaliased and free of
    /// concurrent access until the matching [`Self::resource_unref`] (after a
    /// detach, when the caller drives the teardown itself).
    ///
    /// A zero `length` is rejected with [`Error::InvalidParam`] and a range that
    /// would wrap the 64-bit address space with [`Error::Overflow`], before
    /// anything is sent. These are protocol and arithmetic checks only; they do
    /// not weaken the ownership contract below.
    ///
    /// # Safety
    ///
    /// `paddr..paddr + length` must be valid device-accessible memory that
    /// outlives this mapping and is not accessed by anyone else while the device
    /// may touch it. `length` must not exceed the region actually owned by the
    /// caller.
    pub unsafe fn resource_attach_backing(
        &self,
        resource_id: u32,
        paddr: u64,
        length: u32,
    ) -> Result<(), Error> {
        // SAFETY: delegated to the caller's contract above.
        unsafe { attach_backing(&mut self.inner.lock(), resource_id, paddr, length) }
    }

    /// Releases a resource.
    ///
    /// The protocol has a single `RESOURCE_UNREF` for 2D and 3D resources, so
    /// this is also the only way to destroy a 3D resource. Once it returns, the
    /// guest memory previously attached to the resource may be freed by its
    /// owner.
    pub fn resource_unref(&self, resource_id: u32) -> Result<(), Error> {
        unref_resource(&mut self.inner.lock(), resource_id)
    }

    // --- 3D (virgl) commands ---

    /// Queries capset metadata by index, starting at 0.
    pub fn get_capset_info(&self, capset_index: u32) -> Result<CapsetInfo, Error> {
        self.require_virgl()?;
        let rsp: RespCapsetInfo = self.inner.lock().request(&CmdGetCapsetInfo {
            header: CtrlHeader::with_type(Command::GET_CAPSET_INFO),
            capset_index,
            _padding: 0,
        })?;
        rsp.header.check_type(Command::OK_CAPSET_INFO)?;
        Ok(CapsetInfo {
            capset_id: rsp.capset_id,
            max_version: rsp.capset_max_version,
            max_size: rsp.capset_max_size,
        })
    }

    /// Retrieves the capset data for `capset_id` and `version`.
    ///
    /// `size` is the upper bound from [`Self::get_capset_info`]. Only the bytes
    /// the device actually wrote are returned, and a `size` that cannot fit the
    /// receive buffer is rejected with [`Error::ResponseTooLarge`] rather than
    /// truncated.
    pub fn get_capset(&self, capset_id: u32, version: u32, size: u32) -> Result<Vec<u8>, Error> {
        self.require_virgl()?;
        self.inner.lock().request_capset(capset_id, version, size)
    }

    /// Creates a 3D rendering context.
    ///
    /// `context_init` carries the capset ID that selects the context protocol
    /// (0 for virgl1, 2 for virgl2, 4 for venus). `name` is a debug label the
    /// host may show; it is truncated to 64 bytes.
    ///
    /// The context-init protocol is only available when the device negotiated
    /// `VIRTIO_GPU_F_CONTEXT_INIT`, so a non-zero `context_init` on a device
    /// without it is rejected with [`Error::Unsupported`] instead of being
    /// sent. The legacy `context_init == 0` path still works whenever VIRGL was
    /// negotiated.
    pub fn ctx_create(&self, ctx_id: u32, name: &str, context_init: u32) -> Result<(), Error> {
        self.require_virgl()?;
        if context_init != 0 && !self.has_context_init() {
            return Err(Error::Unsupported);
        }
        let mut cmd = CmdCtxCreate {
            header: CtrlHeader::with_type_and_ctx(Command::CTX_CREATE, ctx_id),
            nlen: 0,
            context_init,
            debug_name: [0u8; 64],
        };
        let bytes = name.as_bytes();
        let nlen = bytes.len().min(cmd.debug_name.len());
        cmd.debug_name[..nlen].copy_from_slice(&bytes[..nlen]);
        cmd.nlen = nlen as u32;

        let rsp: CtrlHeader = self.inner.lock().request(&cmd)?;
        check_ok(&rsp)
    }

    /// Destroys a 3D rendering context.
    pub fn ctx_destroy(&self, ctx_id: u32) -> Result<(), Error> {
        self.require_virgl()?;
        let rsp: CtrlHeader = self
            .inner
            .lock()
            .request(&CtrlHeader::with_type_and_ctx(Command::CTX_DESTROY, ctx_id))?;
        check_ok(&rsp)
    }

    /// Attaches a resource to a rendering context.
    pub fn ctx_attach_resource(&self, ctx_id: u32, resource_id: u32) -> Result<(), Error> {
        self.require_virgl()?;
        let rsp: CtrlHeader = self.inner.lock().request(&CmdCtxResource {
            header: CtrlHeader::with_type_and_ctx(Command::CTX_ATTACH_RESOURCE, ctx_id),
            resource_id,
            _padding: 0,
        })?;
        check_ok(&rsp)
    }

    /// Detaches a resource from a rendering context.
    pub fn ctx_detach_resource(&self, ctx_id: u32, resource_id: u32) -> Result<(), Error> {
        self.require_virgl()?;
        let rsp: CtrlHeader = self.inner.lock().request(&CmdCtxResource {
            header: CtrlHeader::with_type_and_ctx(Command::CTX_DETACH_RESOURCE, ctx_id),
            resource_id,
            _padding: 0,
        })?;
        check_ok(&rsp)
    }

    /// Creates a 3D resource such as a texture, render target or buffer.
    pub fn resource_create_3d(&self, params: ResourceCreate3d) -> Result<(), Error> {
        self.require_virgl()?;
        let rsp: CtrlHeader = self.inner.lock().request(&CmdResourceCreate3D {
            header: CtrlHeader::with_type_and_ctx(Command::RESOURCE_CREATE_3D, params.ctx_id),
            resource_id: params.resource_id,
            target: params.target,
            format: params.format,
            bind: params.bind,
            width: params.width,
            height: params.height,
            depth: params.depth,
            array_size: params.array_size,
            last_level: params.last_level,
            nr_samples: params.nr_samples,
            flags: params.flags,
            _padding: 0,
        })?;
        check_ok(&rsp)
    }

    /// Transfers a 3D resource from guest memory to the host.
    pub fn transfer_to_host_3d(&self, params: Transfer3d) -> Result<(), Error> {
        self.require_virgl()?;
        let rsp: CtrlHeader = self.inner.lock().request(&CmdTransferHost3D {
            header: CtrlHeader::with_type_and_ctx(Command::TRANSFER_TO_HOST_3D, params.ctx_id),
            box_: params.box_,
            offset: params.offset,
            resource_id: params.resource_id,
            level: params.level,
            stride: params.stride,
            layer_stride: params.layer_stride,
        })?;
        check_ok(&rsp)
    }

    /// Transfers a 3D resource from the host to guest memory.
    pub fn transfer_from_host_3d(&self, params: Transfer3d) -> Result<(), Error> {
        self.require_virgl()?;
        let rsp: CtrlHeader = self.inner.lock().request(&CmdTransferHost3D {
            header: CtrlHeader::with_type_and_ctx(Command::TRANSFER_FROM_HOST_3D, params.ctx_id),
            box_: params.box_,
            offset: params.offset,
            resource_id: params.resource_id,
            level: params.level,
            stride: params.stride,
            layer_stride: params.layer_stride,
        })?;
        check_ok(&rsp)
    }

    /// Submits a virgl command stream to a rendering context and waits for the
    /// device to retire it. Returns the fence id the device retired.
    ///
    /// `cmds` is the encoded stream produced by the Mesa virgl Gallium driver
    /// in userspace and is sent as a second buffer next to the `SUBMIT_3D`
    /// header. The stream length must be a multiple of four, because the host
    /// passes `size / 4` dwords to virglrenderer. The fence id comes from this
    /// device's own allocator: the host tracks fence ids device-wide, so two
    /// independent allocators (adapter and 3D face) must not race on them.
    pub fn submit_3d(&self, ctx_id: u32, cmds: &[u8]) -> Result<u64, Error> {
        self.require_virgl()?;
        if !cmds.len().is_multiple_of(size_of::<u32>()) {
            return Err(Error::InvalidParam);
        }
        let size = u32::try_from(cmds.len()).map_err(|_| Error::Overflow)?;
        let fence_id = self.next_fence_id.fetch_add(1, Ordering::Relaxed);
        let rsp: CtrlHeader = self.inner.lock().request_with_data(
            &CmdSubmit3D {
                header: CtrlHeader::with_fence(Command::SUBMIT_3D, ctx_id, fence_id),
                size,
                _padding: 0,
            },
            cmds,
        )?;
        check_ok(&rsp)?;
        Ok(fence_id)
    }

    /// Submits a command stream without a fence and waits for the host to
    /// answer.
    ///
    /// An unfenced `SUBMIT_3D` is answered as soon as the host has queued the
    /// stream, so the round-trip is safe on every renderer. Linux uses it for
    /// the command stream that precedes a blob creation, where nothing waits on
    /// completion.
    pub fn submit_3d_unfenced(&self, ctx_id: u32, cmds: &[u8]) -> Result<(), Error> {
        self.require_virgl()?;
        if !cmds.len().is_multiple_of(size_of::<u32>()) {
            return Err(Error::InvalidParam);
        }
        let size = u32::try_from(cmds.len()).map_err(|_| Error::Overflow)?;
        let rsp: CtrlHeader = self.inner.lock().request_with_data(
            &CmdSubmit3D {
                header: CtrlHeader::with_type_and_ctx(Command::SUBMIT_3D, ctx_id),
                size,
                _padding: 0,
            },
            cmds,
        )?;
        check_ok(&rsp)
    }

    /// Submits a command stream on a ring-based context and returns without
    /// waiting for the fence.
    ///
    /// The host defers the response of a fenced `SUBMIT_3D` until the stream
    /// retires, and a venus ring retires at its own pace — waiting here would
    /// block the control queue (and every other client) behind GPU work. The
    /// fence id is returned so the caller can name the completion on a
    /// timeline; an empty `cmds` is the ring-kick form, where the commands are
    /// already in the ring buffer.
    pub fn submit_3d_deferred(
        &self,
        ctx_id: u32,
        cmds: &[u8],
        ring_idx: Option<u8>,
    ) -> Result<u64, Error> {
        self.require_virgl()?;
        if !cmds.len().is_multiple_of(size_of::<u32>()) {
            return Err(Error::InvalidParam);
        }
        let size = u32::try_from(cmds.len()).map_err(|_| Error::Overflow)?;
        let fence_id = self.next_fence_id.fetch_add(1, Ordering::Relaxed);
        let header = match ring_idx {
            Some(idx) => CtrlHeader::with_fence_ring(Command::SUBMIT_3D, ctx_id, fence_id, idx),
            None => CtrlHeader::with_fence(Command::SUBMIT_3D, ctx_id, fence_id),
        };
        self.inner.lock().submit_fenced(
            (CmdSubmit3D {
                header,
                size,
                _padding: 0,
            })
            .as_bytes(),
            cmds,
        )?;
        Ok(fence_id)
    }

    /// Creates a blob resource such as host-visible memory or a dma-buf.
    ///
    /// A plain `GUEST` blob only needs `VIRTIO_GPU_F_RESOURCE_BLOB`; `HOST3D`
    /// and `HOST3D_GUEST` blobs additionally need VIRGL, because the host 3D
    /// memory they name belongs to a rendering context.
    ///
    /// The parameters are validated before anything is sent:
    ///
    /// * `blob_mem` must be one of [`BLOB_MEM_GUEST`], [`BLOB_MEM_HOST3D`] or
    ///   [`BLOB_MEM_HOST3D_GUEST`];
    /// * `size` must be non-zero;
    /// * `blob_flags` may only set the low three, defined
    ///   `VIRTGPU_BLOB_FLAG_USE_*` bits, and cross-device blobs are rejected
    ///   because the required UUID feature is not negotiated
    ///   ([`Error::Unsupported`]);
    /// * `GUEST` and `HOST3D_GUEST` blobs must pass a non-empty `mem_entries`
    ///   whose lengths are each non-zero, whose `paddr + length` ranges do not
    ///   wrap the 64-bit address space, and whose lengths sum (checked) to at
    ///   least `size`;
    /// * `HOST3D` blobs must pass no guest backing at all.
    ///
    /// # Safety
    ///
    /// For `GUEST` and `HOST3D_GUEST` blobs the device reads and writes the
    /// guest memory at the addresses in [`ResourceCreateBlob::mem_entries`].
    /// The caller must guarantee that every range is valid device-accessible
    /// memory and stays allocated and free of concurrent access for as long as
    /// the blob resource exists, that is until the matching
    /// [`Self::resource_unref`]. The ranges must also cover `size` bytes in
    /// total: a blob larger than its backing would let the device reach past the
    /// end of the provided ranges. `HOST3D` blobs must pass no entries at all.
    pub unsafe fn resource_create_blob(&self, params: ResourceCreateBlob<'_>) -> Result<(), Error> {
        if !self.has_resource_blob() {
            return Err(Error::Unsupported);
        }

        // Only the low three `VIRTGPU_BLOB_FLAG_USE_*` bits are defined; any
        // other bit is a caller bug, not something the device should see.
        if params.blob_flags & !BLOB_FLAG_USE_MASK != 0 {
            return Err(Error::InvalidParam);
        }
        // This crate neither negotiates `VIRTIO_GPU_F_RESOURCE_UUID` nor
        // implements `RESOURCE_ASSIGN_UUID`, so a cross-device blob cannot be
        // honoured. Reject it instead of forwarding a flag the device would
        // accept without the guest ever being able to name the host blob.
        if params.blob_flags & BLOB_FLAG_USE_CROSS_DEVICE != 0 {
            return Err(Error::Unsupported);
        }
        if params.size == 0 {
            return Err(Error::InvalidParam);
        }

        let guest_backed = match params.blob_mem {
            BLOB_MEM_GUEST => true,
            BLOB_MEM_HOST3D_GUEST => true,
            BLOB_MEM_HOST3D => false,
            _ => return Err(Error::InvalidParam),
        };
        let host3d = matches!(params.blob_mem, BLOB_MEM_HOST3D | BLOB_MEM_HOST3D_GUEST);
        if host3d && !self.has_virgl() {
            return Err(Error::Unsupported);
        }

        if guest_backed {
            let mut total: u64 = 0;
            for entry in params.mem_entries {
                if entry.length == 0 {
                    return Err(Error::InvalidParam);
                }
                // The device reads and writes `paddr..paddr + length`; a wrapped
                // extent would name a range unrelated to the caller's backing.
                entry
                    .paddr
                    .checked_add(u64::from(entry.length))
                    .ok_or(Error::Overflow)?;
                total = total
                    .checked_add(u64::from(entry.length))
                    .ok_or(Error::Overflow)?;
            }
            // A blob larger than its backing would let the device reach past
            // the end of the provided ranges, so require the ranges to cover
            // `size` bytes. An empty slice sums to zero and fails this check.
            if total < params.size {
                return Err(Error::InvalidParam);
            }
        } else if !params.mem_entries.is_empty() {
            // `HOST3D` blobs are backed by host memory and must carry no guest
            // ranges; virglrenderer rejects a nonzero `num_iovs`.
            return Err(Error::InvalidParam);
        }

        let nr_entries = u32::try_from(params.mem_entries.len()).map_err(|_| Error::Overflow)?;
        let capacity = params
            .mem_entries
            .len()
            .checked_mul(size_of::<MemEntry>())
            .ok_or(Error::Overflow)?;
        let mut data = Vec::with_capacity(capacity);
        for entry in params.mem_entries {
            data.extend_from_slice(
                MemEntry {
                    addr: entry.paddr,
                    length: entry.length,
                    padding: 0,
                }
                .as_bytes(),
            );
        }

        let rsp: CtrlHeader = self.inner.lock().request_with_data(
            &CmdResourceCreateBlob {
                header: CtrlHeader::with_type_and_ctx(Command::RESOURCE_CREATE_BLOB, params.ctx_id),
                resource_id: params.resource_id,
                blob_mem: params.blob_mem,
                blob_flags: params.blob_flags,
                nr_entries,
                blob_id: params.blob_id,
                size: params.size,
            },
            &data,
        )?;
        check_ok(&rsp)
    }

    // --- venus 3D surface ---

    /// `RESOURCE_MAP_BLOB`: maps a blob into the host-visible BAR at
    /// `bar_offset` and returns the host's cache hint.
    pub fn map_blob(&self, res_id: u32, bar_offset: u64) -> Result<u32, Error> {
        let rsp: RespMapInfo = self.inner.lock().request(&CmdResourceMapBlob {
            header: CtrlHeader::with_type_and_ctx(Command::RESOURCE_MAP_BLOB, 0),
            resource_id: res_id,
            _padding: 0,
            offset: bar_offset,
        })?;
        if rsp.header.command() != Command::OK_MAP_INFO {
            return Err(map_resp_err(rsp.header.command()));
        }
        Ok(rsp.map_info)
    }

    /// `RESOURCE_UNMAP_BLOB`.
    pub fn unmap_blob(&self, res_id: u32) -> Result<(), Error> {
        let rsp: CtrlHeader = self.inner.lock().request(&CmdResourceUnmapBlob {
            header: CtrlHeader::with_type(Command::RESOURCE_UNMAP_BLOB),
            resource_id: res_id,
            _padding: 0,
        })?;
        check_ok(&rsp)
    }

    /// `SET_SCANOUT_BLOB`: displays a blob resource on a scanout.
    ///
    /// The host references the blob's backing memory in place, so guest writes
    /// to a mapped blob become visible without any transfer command.
    pub fn set_scanout_blob(&self, params: ScanoutBlobParams) -> Result<(), Error> {
        let rsp: CtrlHeader = self.inner.lock().request(&CmdSetScanoutBlob {
            header: CtrlHeader::with_type(Command::SET_SCANOUT_BLOB),
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
            _padding: 0,
            strides: [params.stride, 0, 0, 0],
            offsets: [params.offset, 0, 0, 0],
        })?;
        check_ok(&rsp)
    }

    /// Rebinds the fixed 2D scanout resource to scanout 0 at its live geometry,
    /// restoring the surface a blob scanout replaced. Only meaningful after a
    /// successful 2D surface setup; fails with [`Error::NotReady`] otherwise.
    pub fn bind_2d_scanout(&self) -> Result<(), Error> {
        let mut inner = self.inner.lock();
        let rect = inner.rect.ok_or(Error::NotReady)?;
        let rsp: CtrlHeader = inner.request(&SetScanout {
            header: CtrlHeader::with_type(Command::SET_SCANOUT),
            rect,
            scanout_id: SCANOUT_ID,
            resource_id: FRAMEBUFFER_RESOURCE_ID,
        })?;
        check_ok(&rsp)
    }

    /// Stops displaying whatever resource is bound to `scanout_id`
    /// (`SET_SCANOUT_BLOB` with resource 0, mirroring SET_SCANOUT's disable
    /// idiom). Used when a client releases the scanned-out framebuffer.
    pub fn disable_scanout(&self, scanout_id: u32) -> Result<(), Error> {
        let rsp: CtrlHeader = self.inner.lock().request(&CmdSetScanoutBlob {
            header: CtrlHeader::with_type(Command::SET_SCANOUT_BLOB),
            rect: Rect::default(),
            scanout_id,
            resource_id: 0,
            width: 0,
            height: 0,
            format: 0,
            _padding: 0,
            strides: [0; 4],
            offsets: [0; 4],
        })?;
        check_ok(&rsp)
    }

    /// `GET_DISPLAY_INFO`, validated.
    fn get_display_info(&self) -> Result<RespDisplayInfo, Error> {
        let info: RespDisplayInfo = self
            .inner
            .lock()
            .request(&CtrlHeader::with_type(Command::GET_DISPLAY_INFO))?;
        info.header.check_type(Command::OK_DISPLAY_INFO)?;
        Ok(info)
    }
}

/// Tells the device to stop using the current framebuffer and releases its
/// backing.
///
/// The scanout is stopped first, then the backing is detached and the resource
/// released, and only then is the DMA freed. On any failure the DMA stays owned
/// by `inner`, so the device never keeps a pointer to freed memory and a later
/// retry can finish the teardown.
fn teardown_framebuffer<H: Hal, T: Transport>(inner: &mut Inner<H, T>) -> Result<(), Error> {
    let rsp: CtrlHeader = inner.request(&SetScanout {
        header: CtrlHeader::with_type(Command::SET_SCANOUT),
        rect: Rect::default(),
        scanout_id: SCANOUT_ID,
        resource_id: 0,
    })?;
    check_ok(&rsp)?;
    // The scanout is stopped, so any previously published framebuffer is no
    // longer live.
    inner.rect = None;
    detach_backing(inner, FRAMEBUFFER_RESOURCE_ID)?;
    unref_resource(inner, FRAMEBUFFER_RESOURCE_ID)?;
    inner.framebuffer_dma = None;
    Ok(())
}

/// Sends `RESOURCE_ATTACH_BACKING` for one guest-physical range.
///
/// # Safety
///
/// `paddr..paddr + length` must be valid device-accessible memory that outlives
/// the mapping and is not accessed by anyone else while the device may touch
/// it. `length` must not exceed the region actually owned by the caller.
unsafe fn attach_backing<H: Hal, T: Transport>(
    inner: &mut Inner<H, T>,
    resource_id: u32,
    paddr: u64,
    length: u32,
) -> Result<(), Error> {
    if length == 0 {
        return Err(Error::InvalidParam);
    }
    // The device walks `paddr..paddr + length`; a wrapped extent would hand it
    // a range that has nothing to do with the caller's allocation.
    paddr
        .checked_add(u64::from(length))
        .ok_or(Error::Overflow)?;
    let rsp: CtrlHeader = inner.request(&ResourceAttachBacking {
        header: CtrlHeader::with_type(Command::RESOURCE_ATTACH_BACKING),
        resource_id,
        nr_entries: 1,
        addr: paddr,
        length,
        _padding: 0,
    })?;
    check_ok(&rsp)
}

/// Sends `RESOURCE_DETACH_BACKING`.
///
/// After this returns, the device no longer reads or writes the ranges that
/// were attached.
fn detach_backing<H: Hal, T: Transport>(
    inner: &mut Inner<H, T>,
    resource_id: u32,
) -> Result<(), Error> {
    let rsp: CtrlHeader = inner.request(&ResourceDetachBacking {
        header: CtrlHeader::with_type(Command::RESOURCE_DETACH_BACKING),
        resource_id,
        _padding: 0,
    })?;
    check_ok(&rsp)
}

/// Sends `RESOURCE_UNREF`.
fn unref_resource<H: Hal, T: Transport>(
    inner: &mut Inner<H, T>,
    resource_id: u32,
) -> Result<(), Error> {
    let rsp: CtrlHeader = inner.request(&ResourceUnref {
        header: CtrlHeader::with_type(Command::RESOURCE_UNREF),
        resource_id,
        _padding: 0,
    })?;
    check_ok(&rsp)
}

/// Size in bytes of a `width * height` `B8G8R8A8_UNORM` framebuffer.
fn framebuffer_size(width: u32, height: u32) -> Result<u32, Error> {
    width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(Error::Overflow)
}

// SAFETY: the transport, the virtqueue and the DMA helpers only touch
// memory-mapped registers and caller-owned buffers, neither of which is bound
// to a thread, and every access to the mutable state goes through the spin
// mutex. This matches the OS adapters, which already move a `Transport` across
// threads behind their own `unsafe impl Send` (the probe runs on one CPU and
// the display device is later driven from another).
unsafe impl<H: Hal, T: Transport> Send for VirtIoGpu<H, T> {}
unsafe impl<H: Hal, T: Transport> Sync for VirtIoGpu<H, T> {}

impl<H: Hal, T: Transport> Drop for VirtIoGpu<H, T> {
    fn drop(&mut self) {
        // Reset the device before any field is released. Writing an empty
        // status tells the device to drop its driver state, which stops the
        // scanout and tears down the host-side resource backing, so the device
        // stops issuing DMA. Without this the device could keep scanning out of
        // (or writing into) the framebuffer DMA that `framebuffer_dma` frees
        // when the fields below are dropped, a use-after-free from the device's
        // point of view. A status write is a single register or PCI capability
        // write, so it cannot block on the control queue; no control command is
        // sent here.
        let mut inner = self.inner.lock();
        inner.transport.set_status(DeviceStatus::empty());
        // Clear the queue registration so the device cannot keep reading the
        // descriptor rings after the transport and its DMA are released.
        inner.transport.queue_unset(CONTROL_QUEUE);
    }
}
