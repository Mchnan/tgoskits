extern crate alloc;

use alloc::{format, sync::Arc};

use rdif_display::{
    CapsetInfo, DisplayError, DisplayInfo, Event, FrameBuffer, PixelFormat, ResourceCreate3d,
    ResourceCreateBlob, Transfer3d,
};
use rdrive::{DriverGeneric, PlatformDevice, probe::OnProbeError};
#[cfg(feature = "pci")]
use virtio_drivers::transport::DeviceType;
use virtio_drivers::transport::Transport;
use virtio_gpu::{IrqEvent, VirtIoGpu};

use crate::{BindingInfo, display::PlatformDeviceDisplay, virtio::VirtIoHalImpl};
#[cfg(feature = "pci")]
use crate::{PciIrqRequirement, binding_info_from_pci};

#[cfg(feature = "pci")]
crate::model_register!(
    name: "VirtIO GPU",
    level: ProbeLevel::PostKernel,
    priority: ProbePriority::DEFAULT,
    probe_kinds: &[ProbeKind::Pci {
        on_probe: probe_pci,
    }],
);

#[cfg(feature = "pci")]
fn probe_pci(mut probe: rdrive::probe::pci::ProbePci<'_>) -> Result<(), OnProbeError> {
    // The hostmem shared-memory region (VIRTIO_GPU_SHM_ID_HOST_VISIBLE) backs
    // mappable blob resources; absent on plain 2D devices, in which case the
    // 3D face degrades to "unavailable".
    let (transport, shm) = crate::pci::take_virtio_transport_masked_with_shm(
        probe.endpoint_mut(),
        DeviceType::GPU,
        1,
    )?;
    let info = binding_info_from_pci(probe.info(), PciIrqRequirement::Optional)?;
    register_transport_with_shm(probe.into_platform_device(), transport, shm, info)
}

pub fn register_transport<T: Transport + 'static>(
    plat_dev: PlatformDevice,
    transport: T,
) -> Result<(), OnProbeError> {
    register_transport_with_info(plat_dev, transport, BindingInfo::empty())
}

pub fn register_transport_with_info<T: Transport + 'static>(
    plat_dev: PlatformDevice,
    transport: T,
    info: BindingInfo,
) -> Result<(), OnProbeError> {
    register_transport_with_shm(plat_dev, transport, None, info)
}

/// Registers a probed virtio-gpu device together with its shared memory
/// region, when the PCI capabilities carry one.
///
/// The 3D face is published for the kernel's card0 `VIRTGPU_*` ioctls in every
/// case; a display device is only registered when the 2D scanout surface came
/// up. On a venus-only renderer (no vrend on the host) guest 2D resources
/// fail, and registering a display device without a working scanout would
/// panic the axdisplay adapter — so the probe degrades to 3D-only instead.
pub fn register_transport_with_shm<T: Transport + 'static>(
    plat_dev: PlatformDevice,
    transport: T,
    shm: Option<crate::pci::VirtioShmRegion>,
    info: BindingInfo,
) -> Result<(), OnProbeError> {
    let irq_num = info.irq_num();
    let (dev, fb_available) = VirtIoDisplay::new(transport, shm, irq_num)
        .map_err(|err| OnProbeError::other(format!("failed to initialize virtio-gpu: {err:?}")))?;
    if !fb_available {
        log::warn!("virtio-gpu: no 2D scanout; display device not registered");
        return Ok(());
    }
    let irq = plat_dev.register_display_with_info(dev, info);
    log::info!("registered virtio GPU device irq={irq:?}");
    Ok(())
}

struct VirtIoDisplay<T: Transport + 'static> {
    raw: Arc<VirtIoGpu<VirtIoHalImpl, T>>,
    info: DisplayInfo,
    /// Scanout DMA base, or null when the 2D surface is unavailable
    /// (venus-only renderers have no vrend, so guest 2D resources fail; the
    /// 3D face stays fully functional).
    fb_base: *mut u8,
    irq_num: Option<usize>,
    irq_enabled: bool,
}

unsafe impl<T: Transport + 'static> Send for VirtIoDisplay<T> {}

impl<T: Transport + 'static> VirtIoDisplay<T> {
    fn new(
        transport: T,
        shm: Option<crate::pci::VirtioShmRegion>,
        irq_num: Option<usize>,
    ) -> Result<(Self, bool), virtio_gpu::Error> {
        let hostmem = shm.map(|region| virtio_gpu::HostMemRegion {
            phys_base: region.phys,
            length: region.length,
        });
        log::info!("virtio-gpu: creating device (hostmem={hostmem:?})");
        let raw = Arc::new(VirtIoGpu::new(transport, hostmem)?);
        // Publish the 3D face for the kernel's card0 VIRTGPU_* ioctls.
        virtio_gpu::register_global_3d(raw.clone());
        // The 2D surface may be unavailable on venus-only renderers (no vrend
        // on the darwin host): degrade to 3D-only instead of failing the probe.
        let (fb_base, fb_size) = match raw.setup_framebuffer() {
            Ok((base, size)) => (base.as_ptr(), size),
            Err(err) => {
                log::warn!("virtio-gpu: 2D scanout unavailable ({err:?}); continuing 3D-only");
                (core::ptr::null_mut(), 0)
            }
        };
        let fb_available = !fb_base.is_null();
        let (width, height) = raw.resolution()?;
        let info = DisplayInfo {
            width,
            height,
            stride: width as usize * 4,
            format: PixelFormat::Xrgb8888,
            fb_size,
        };
        let _ = raw.ack_interrupt();
        Ok((
            Self {
                raw,
                info,
                fb_base,
                irq_num,
                irq_enabled: false,
            },
            fb_available,
        ))
    }
}

impl<T: Transport + 'static> DriverGeneric for VirtIoDisplay<T> {
    fn name(&self) -> &str {
        "virtio-gpu"
    }
}

impl<T: Transport + 'static> rdif_display::Interface for VirtIoDisplay<T> {
    fn info(&self) -> DisplayInfo {
        self.info
    }

    fn framebuffer(&mut self) -> Result<FrameBuffer<'_>, DisplayError> {
        if self.fb_base.is_null() {
            return Err(DisplayError::NotSupported);
        }
        Ok(unsafe { FrameBuffer::from_raw_parts_mut(self.fb_base, self.info.fb_size) })
    }

    fn irq_num(&self) -> Option<usize> {
        self.irq_num
    }

    fn need_flush(&self) -> bool {
        true
    }

    fn flush(&mut self) -> Result<(), DisplayError> {
        if self.fb_base.is_null() {
            return Err(DisplayError::NotSupported);
        }
        self.raw.flush().map_err(map_display_err)
    }

    fn restore_framebuffer_scanout(&mut self) -> Result<(), DisplayError> {
        self.raw
            .restore_framebuffer_scanout()
            .map_err(map_display_err)
    }

    fn enable_irq(&mut self) {
        self.irq_enabled = true;
    }

    fn disable_irq(&mut self) {
        self.irq_enabled = false;
    }

    fn is_irq_enabled(&self) -> bool {
        self.irq_enabled
    }

    fn handle_irq(&mut self) -> Event {
        let irq = self.raw.ack_interrupt();
        display_irq_event(self.irq_enabled, irq)
    }

    // --- 2D resource / scanout primitives ---

    fn resource_create_2d(
        &mut self,
        resource_id: u32,
        width: u32,
        height: u32,
    ) -> Result<(), DisplayError> {
        self.raw
            .resource_create_2d(resource_id, width, height)
            .map_err(map_gpu3d_err)
    }

    fn resource_attach_backing(
        &mut self,
        resource_id: u32,
        paddr: u64,
        length: u32,
    ) -> Result<(), DisplayError> {
        // SAFETY: this is the adapter edge for a raw guest-physical range. The
        // rdif-display contract puts ownership of `paddr..paddr + length` on the
        // caller — the DRM layer registers a GEM object's backing and keeps it
        // allocated and unshared until the matching resource is unreferenced —
        // so the range stays valid, unaliased and large enough for as long as
        // the device holds the mapping.
        unsafe { self.raw.resource_attach_backing(resource_id, paddr, length) }
            .map_err(map_gpu3d_err)
    }

    fn set_scanout(
        &mut self,
        scanout_id: u32,
        resource_id: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<(), DisplayError> {
        self.raw
            .set_scanout(
                virtio_gpu::Rect {
                    x,
                    y,
                    width: w,
                    height: h,
                },
                scanout_id,
                resource_id,
            )
            .map_err(map_gpu3d_err)
    }

    fn transfer_to_host_2d(
        &mut self,
        resource_id: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<(), DisplayError> {
        self.raw
            .transfer_to_host_2d(
                virtio_gpu::Rect {
                    x,
                    y,
                    width: w,
                    height: h,
                },
                0,
                resource_id,
            )
            .map_err(map_gpu3d_err)
    }

    fn resource_flush(
        &mut self,
        resource_id: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<(), DisplayError> {
        self.raw
            .resource_flush(
                virtio_gpu::Rect {
                    x,
                    y,
                    width: w,
                    height: h,
                },
                resource_id,
            )
            .map_err(map_gpu3d_err)
    }

    // --- 3D methods ---

    fn has_virgl(&self) -> bool {
        self.raw.has_virgl()
    }

    fn has_resource_blob(&self) -> bool {
        self.raw.has_resource_blob()
    }

    fn has_context_init(&self) -> bool {
        self.raw.has_context_init()
    }

    fn ctx_create(
        &mut self,
        ctx_id: u32,
        name: &str,
        context_init: u32,
    ) -> Result<(), DisplayError> {
        self.raw
            .ctx_create(ctx_id, name, context_init)
            .map_err(map_gpu3d_err)
    }

    fn ctx_destroy(&mut self, ctx_id: u32) -> Result<(), DisplayError> {
        self.raw.ctx_destroy(ctx_id).map_err(map_gpu3d_err)
    }

    fn ctx_attach_resource(&mut self, ctx_id: u32, resource_id: u32) -> Result<(), DisplayError> {
        self.raw
            .ctx_attach_resource(ctx_id, resource_id)
            .map_err(map_gpu3d_err)
    }

    fn ctx_detach_resource(&mut self, ctx_id: u32, resource_id: u32) -> Result<(), DisplayError> {
        self.raw
            .ctx_detach_resource(ctx_id, resource_id)
            .map_err(map_gpu3d_err)
    }

    fn resource_create_3d(&mut self, params: ResourceCreate3d) -> Result<(), DisplayError> {
        self.raw
            .resource_create_3d(virtio_gpu::ResourceCreate3d {
                ctx_id: params.ctx_id,
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
            })
            .map_err(map_gpu3d_err)
    }

    fn resource_unref(&mut self, resource_id: u32) -> Result<(), DisplayError> {
        self.raw.resource_unref(resource_id).map_err(map_gpu3d_err)
    }

    fn resource_create_blob(&mut self, params: ResourceCreateBlob<'_>) -> Result<(), DisplayError> {
        // Linux order (`virtio_gpu_resource_create_blob_ioctl`, virtgpu_ioctl.c):
        // submit the virgl cmd stream first, then send RESOURCE_CREATE_BLOB —
        // both go on the same virtqueue and execute in order on the host.
        if !params.cmd.is_empty() {
            self.submit_cmd(params.ctx_id, params.cmd)?;
        }
        let entry = params.backing.map(|memory| virtio_gpu::BlobMemory {
            paddr: memory.paddr,
            length: memory.length,
        });
        let entries = entry.as_slice();
        // SAFETY: the DRM GEM object owns `backing` until RESOURCE_UNREF.
        // Guest-backed modes pass one range covering `size`; HOST3D passes
        // no range, as required by the virtio-gpu blob memory contract.
        unsafe {
            self.raw
                .resource_create_blob(virtio_gpu::ResourceCreateBlob {
                    ctx_id: params.ctx_id,
                    resource_id: params.resource_id,
                    blob_mem: params.blob_mem,
                    blob_flags: params.blob_flags,
                    size: params.size,
                    blob_id: params.blob_id,
                    mem_entries: entries,
                })
        }
        .map_err(map_gpu3d_err)
    }

    fn transfer_to_host_3d(&mut self, params: Transfer3d) -> Result<(), DisplayError> {
        self.raw
            .transfer_to_host_3d(to_core_transfer(params))
            .map_err(map_gpu3d_err)
    }

    fn transfer_from_host_3d(&mut self, params: Transfer3d) -> Result<(), DisplayError> {
        self.raw
            .transfer_from_host_3d(to_core_transfer(params))
            .map_err(map_gpu3d_err)
    }

    fn submit_cmd(&mut self, ctx_id: u32, cmds: &[u8]) -> Result<u64, DisplayError> {
        self.raw.submit_3d(ctx_id, cmds).map_err(map_gpu3d_err)
    }

    fn get_capset_info(&mut self, index: u32) -> Result<CapsetInfo, DisplayError> {
        let info = self.raw.get_capset_info(index).map_err(map_gpu3d_err)?;
        Ok(CapsetInfo {
            capset_id: info.capset_id,
            max_version: info.max_version,
            max_size: info.max_size,
        })
    }

    fn get_capset(
        &mut self,
        id: u32,
        ver: u32,
        size: u32,
    ) -> Result<alloc::vec::Vec<u8>, DisplayError> {
        self.raw.get_capset(id, ver, size).map_err(map_gpu3d_err)
    }
}

/// Translates the core crate's interrupt summary into the display event type.
///
/// Interrupts are ignored until the display layer enables them: the driver is
/// polled for setup and only takes over event delivery afterwards.
///
/// `handled` is `!irq.is_empty()`, so a configuration interrupt that carried no
/// display event is still claimed; `changed` comes from the core's
/// `display_changed`, not from the transport's configuration bit.
fn display_irq_event(irq_enabled: bool, irq: IrqEvent) -> Event {
    if !irq_enabled {
        return Event::none();
    }
    Event {
        handled: !irq.is_empty(),
        changed: irq.display_changed,
    }
}

/// Converts the rdif 3D transfer parameters into the core crate's parameter set.
fn to_core_transfer(params: Transfer3d) -> virtio_gpu::Transfer3d {
    virtio_gpu::Transfer3d {
        ctx_id: params.ctx_id,
        resource_id: params.resource_id,
        box_: virtio_gpu::GpuBox {
            x: params.box_.x,
            y: params.box_.y,
            z: params.box_.z,
            w: params.box_.w,
            h: params.box_.h,
            d: params.box_.d,
        },
        offset: params.offset,
        level: params.level,
        stride: params.stride,
        layer_stride: params.layer_stride,
    }
}

fn map_display_err(err: virtio_gpu::Error) -> DisplayError {
    match err {
        virtio_gpu::Error::Unsupported => DisplayError::NotSupported,
        virtio_gpu::Error::NotReady => DisplayError::NotAvailable,
        _ => DisplayError::Other(alloc::boxed::Box::new(err)),
    }
}

fn map_gpu3d_err(err: virtio_gpu::Error) -> DisplayError {
    use rdif_display::Gpu3dErrorKind;
    let kind = match err {
        virtio_gpu::Error::Unsupported => Gpu3dErrorKind::Unsupported,
        virtio_gpu::Error::NotReady => Gpu3dErrorKind::NotReady,
        virtio_gpu::Error::InvalidParam => Gpu3dErrorKind::InvalidParam,
        virtio_gpu::Error::VirtIo(virtio_drivers::Error::IoError) => Gpu3dErrorKind::IoError,
        _ => Gpu3dErrorKind::Other,
    };
    DisplayError::Gpu3dError(kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_irq_is_ignored_until_driver_enables_it() {
        let irq = IrqEvent {
            queue: true,
            configuration: true,
            display_changed: true,
        };

        assert_eq!(display_irq_event(false, irq), Event::none());
    }

    #[test]
    fn display_irq_reports_display_changes() {
        assert_eq!(
            display_irq_event(
                true,
                IrqEvent {
                    queue: false,
                    configuration: true,
                    display_changed: true,
                }
            ),
            Event {
                handled: true,
                changed: true,
            }
        );
    }

    #[test]
    fn display_irq_configuration_without_display_event_is_handled_only() {
        // A configuration interrupt that cleared no display event still has to
        // be claimed, but it must not report a display change.
        assert_eq!(
            display_irq_event(
                true,
                IrqEvent {
                    queue: false,
                    configuration: true,
                    display_changed: false,
                }
            ),
            Event {
                handled: true,
                changed: false,
            }
        );
    }

    #[test]
    fn display_irq_reports_queue_interrupt_as_handled_only() {
        assert_eq!(
            display_irq_event(
                true,
                IrqEvent {
                    queue: true,
                    configuration: false,
                    display_changed: false,
                }
            ),
            Event {
                handled: true,
                changed: false,
            }
        );
    }

    #[test]
    fn display_irq_empty_status_is_not_claimed() {
        assert_eq!(display_irq_event(true, IrqEvent::none()), Event::none());
    }
}
