//! [ArceOS](https://github.com/arceos-org/arceos) input module.

#![no_std]

extern crate alloc;

mod device;
mod event;
mod id;
pub mod rdif;

use alloc::vec::Vec;
use core::mem;

use ax_lazyinit::LazyInit;
use ax_task::sync::SpinLock as Mutex;
pub use device::{ErasedInputDevice, InputDevice, InputError, InputIrqEvent, InputResult};
pub use event::{AbsInfo, Event, EventType};
pub use id::InputDeviceId;

static DEVICES: LazyInit<Mutex<Vec<ErasedInputDevice>>> = LazyInit::new();

/// Initializes the input subsystem by underlayer devices.
pub fn init_input(input_devs: impl IntoIterator<Item = ErasedInputDevice>) {
    log::info!("Initialize input subsystem...");

    let mut devices = Vec::new();
    for dev in input_devs {
        log::info!("  registered a new input device: {}", dev.name());
        devices.push(dev);
    }
    DEVICES.init_once(Mutex::new(devices));
}

/// Takes the initialized input devices.
pub fn take_inputs() -> Vec<ErasedInputDevice> {
    mem::take(&mut DEVICES.lock())
}

/// Returns whether an evdev polling fallback should actively drain the device
/// queue.
///
/// The fallback must keep draining while any reader is blocked waiting for
/// events (`has_waiters`), even if the demand-driven `polling_requested` flag
/// was already cleared by an earlier empty-drain window: otherwise events that
/// arrive after the wind-down are never delivered and the blocked reader sleeps
/// forever. When the device IRQ is known to be alive, delivery is the IRQ
/// path's job and the fallback stays idle.
pub fn input_polling_fallback_should_drain(
    polling_requested: bool,
    has_waiters: bool,
    now_ns: u64,
    last_irq_event_ns: u64,
    irq_alive_ns: u64,
) -> bool {
    let irq_stale = now_ns.wrapping_sub(last_irq_event_ns) > irq_alive_ns;
    irq_stale && (polling_requested || has_waiters)
}

#[cfg(test)]
mod tests {
    use super::input_polling_fallback_should_drain;

    const IRQ_ALIVE_NS: u64 = 1_000_000_000;

    #[test]
    fn polling_fallback_stays_idle_without_user_interest_even_when_irq_is_stale() {
        assert!(!input_polling_fallback_should_drain(
            false,
            false,
            IRQ_ALIVE_NS + 1,
            0,
            IRQ_ALIVE_NS
        ));
    }

    #[test]
    fn polling_fallback_drains_after_user_interest_when_irq_is_stale() {
        assert!(input_polling_fallback_should_drain(
            true,
            false,
            IRQ_ALIVE_NS + 1,
            0,
            IRQ_ALIVE_NS
        ));
    }

    #[test]
    fn polling_fallback_stays_idle_while_irq_is_recent() {
        assert!(!input_polling_fallback_should_drain(
            true,
            false,
            IRQ_ALIVE_NS,
            0,
            IRQ_ALIVE_NS
        ));
    }

    #[test]
    fn polling_fallback_keeps_draining_while_a_reader_is_blocked() {
        // Regression: a blocked reader's waker stays registered after the
        // demand-driven window winds down. Events arriving afterwards must
        // still be drained and used to wake the reader.
        assert!(input_polling_fallback_should_drain(
            false,
            true,
            IRQ_ALIVE_NS + 1,
            0,
            IRQ_ALIVE_NS
        ));
    }

    #[test]
    fn polling_fallback_keeps_draining_while_blocked_even_when_flag_was_set() {
        assert!(input_polling_fallback_should_drain(
            true,
            true,
            IRQ_ALIVE_NS + 1,
            0,
            IRQ_ALIVE_NS
        ));
    }

    #[test]
    fn polling_fallback_stays_idle_while_blocked_but_irq_is_alive() {
        // With a healthy IRQ the IRQ path owns delivery; the fallback must not
        // compete with it even when a reader is parked.
        assert!(!input_polling_fallback_should_drain(
            false,
            true,
            IRQ_ALIVE_NS,
            IRQ_ALIVE_NS,
            IRQ_ALIVE_NS
        ));
    }
}
