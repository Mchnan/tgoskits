extern crate alloc;

use alloc::{format, sync::Arc};

use rdif_display::{DisplayError, DisplayInfo, Event, FrameBuffer, PixelFormat};
use rdrive::{DriverGeneric, PlatformDevice, probe::OnProbeError};
#[cfg(feature = "pci")]
use virtio_drivers::transport::DeviceType;
use virtio_drivers::transport::InterruptStatus;

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
    // The hostmem shared-memory region (VIRTIO_GPU_SHM_ID_HOST_VISIBLE)
    // backs mappable blob resources; absent on plain 2D devices, in
    // which case the 3D face degrades to "unavailable".
    let (transport, shm) = crate::pci::take_virtio_transport_masked_with_shm(
        probe.endpoint_mut(),
        DeviceType::GPU,
        1,
    )?;
    let info = binding_info_from_pci(probe.info(), PciIrqRequirement::Optional)?;
    register_transport_with_shm(probe.into_platform_device(), transport, shm, info)
}

pub fn register_transport<T: virtio_drivers::transport::Transport + 'static>(
    plat_dev: PlatformDevice,
    transport: T,
) -> Result<(), OnProbeError> {
    register_transport_with_shm(plat_dev, transport, None, BindingInfo::empty())
}

pub fn register_transport_with_shm<T: virtio_drivers::transport::Transport + 'static>(
    plat_dev: PlatformDevice,
    transport: T,
    shm: Option<crate::pci::VirtioShmRegion>,
    info: BindingInfo,
) -> Result<(), OnProbeError> {
    let irq_num = info.irq_num();
    let (dev, fb_available) = VirtIoDisplay::new(transport, shm, irq_num)
        .map_err(|err| OnProbeError::other(format!("failed to initialize virtio-gpu: {err:?}")))?;
    if !fb_available {
        // 3D-only device (e.g. venus-only darwin renderer): the 3D face
        // is already published for the kernel; do not register a display
        // device without a working scanout surface.
        log::warn!("virtio-gpu: no 2D scanout; display device not registered");
        return Ok(());
    }
    let irq = plat_dev.register_display_with_info(dev, info);
    log::info!("registered virtio GPU device irq={irq:?}");
    Ok(())
}

struct VirtIoDisplay<T: virtio_drivers::transport::Transport + 'static> {
    gpu: Arc<virtio_gpu::VirtioGpuDevice<VirtIoHalImpl, T>>,
    info: DisplayInfo,
    /// Scanout DMA base, or null when the 2D surface is unavailable
    /// (venus-only renderers have no vrend, so guest 2D resources fail;
    /// the 3D face stays fully functional).
    fb_base: *mut u8,
    irq_num: Option<usize>,
    irq_enabled: bool,
}

unsafe impl<T: virtio_drivers::transport::Transport + 'static> Send for VirtIoDisplay<T> {}

impl<T: virtio_drivers::transport::Transport + 'static> VirtIoDisplay<T> {
    fn new(
        transport: T,
        shm: Option<crate::pci::VirtioShmRegion>,
        irq_num: Option<usize>,
    ) -> Result<(Self, bool), virtio_drivers::Error> {
        let hostmem = shm.map(|region| virtio_gpu::HostMemRegion {
            phys_base: region.phys,
            length: region.length,
        });
        log::info!("virtio-gpu: creating device (hostmem={hostmem:?})");
        let gpu = Arc::new(virtio_gpu::VirtioGpuDevice::new(transport, hostmem)?);
        // Publish the 3D face for the kernel's card0 VIRTGPU_* ioctls.
        virtio_gpu::register_global_3d(gpu.clone());
        log::info!("virtio-gpu: device created, setting up 2D scanout");
        // The 2D surface may be unavailable on venus-only renderers (no
        // vrend on darwin): degrade to 3D-only instead of failing the
        // probe, which would panic the kernel.
        let (fb_base, fb_size) = match gpu.setup_framebuffer() {
            Ok((base, size)) => (base.as_ptr(), size),
            Err(err) => {
                log::warn!("virtio-gpu: 2D scanout unavailable ({err:?}); continuing 3D-only");
                (core::ptr::null_mut(), 0)
            }
        };
        let fb_available = !fb_base.is_null();
        let (width, height) = gpu.resolution().map_err(|err| {
            log::error!("virtio-gpu: resolution failed: {err:?}");
            virtio_drivers::Error::NotReady
        })?;
        log::info!("virtio-gpu: init complete ({width}x{height})");
        let info = DisplayInfo {
            width,
            height,
            stride: width as usize * 4,
            format: PixelFormat::Xrgb8888,
            fb_size,
        };
        let _ = gpu.ack_interrupt();
        Ok((
            Self {
                gpu,
                info,
                fb_base,
                irq_num,
                irq_enabled: false,
            },
            fb_available,
        ))
    }
}

impl<T: virtio_drivers::transport::Transport + 'static> DriverGeneric for VirtIoDisplay<T> {
    fn name(&self) -> &str {
        "virtio-gpu"
    }
}

impl<T: virtio_drivers::transport::Transport + 'static> rdif_display::Interface
    for VirtIoDisplay<T>
{
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
        self.gpu.flush().map_err(map_display_err)
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
        let status = self.gpu.ack_interrupt();
        display_irq_event(self.irq_enabled, status)
    }
}

fn display_irq_event(irq_enabled: bool, status: InterruptStatus) -> Event {
    if !irq_enabled {
        return Event::none();
    }
    Event {
        handled: !status.is_empty(),
        changed: status.contains(InterruptStatus::DEVICE_CONFIGURATION_INTERRUPT),
    }
}

fn map_display_err(err: virtio_gpu::Gpu3DError) -> DisplayError {
    match err {
        virtio_gpu::Gpu3DError::UNSUPPORTED => DisplayError::NotSupported,
        virtio_gpu::Gpu3DError::NO_DEVICE => DisplayError::NotAvailable,
        _ => DisplayError::Other(alloc::boxed::Box::new(err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_irq_is_ignored_until_driver_enables_it() {
        let status =
            InterruptStatus::QUEUE_INTERRUPT | InterruptStatus::DEVICE_CONFIGURATION_INTERRUPT;

        assert_eq!(display_irq_event(false, status), Event::none());
    }

    #[test]
    fn display_irq_reports_configuration_changes() {
        assert_eq!(
            display_irq_event(true, InterruptStatus::DEVICE_CONFIGURATION_INTERRUPT),
            Event {
                handled: true,
                changed: true,
            }
        );
    }

    #[test]
    fn display_irq_reports_non_configuration_interrupt_as_handled_only() {
        assert_eq!(
            display_irq_event(true, InterruptStatus::QUEUE_INTERRUPT),
            Event {
                handled: true,
                changed: false,
            }
        );
    }

    #[test]
    fn display_irq_empty_status_is_not_claimed() {
        assert_eq!(
            display_irq_event(true, InterruptStatus::empty()),
            Event::none()
        );
    }
}
