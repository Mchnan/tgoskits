//! Synthesized 60 Hz vblank clock for the emulated `/dev/dri/card0`.
//!
//! The card has no real scanout engine — presentation is a synchronous
//! memcpy — so there is no hardware counter to latch vblank edges from.
//! Linux DRM userspace (libdrm, compositors) nevertheless expects a
//! monotonic per-CRTC sequence advancing at the mode's refresh rate,
//! plus timestamps of the most recent edge (`CRTC_GET_SEQUENCE`,
//! `CRTC_QUEUE_SEQUENCE`, `WAIT_VBLANK`, and flip-completion events).
//! The clock derives that sequence from elapsed monotonic time while
//! scanout is active. Disabling the CRTC freezes the counter; re-enabling
//! starts a new epoch without counting the disabled interval.
//!
//! Each open file owns its queued events and a deadline worker wakes readers
//! at the next edge; the clock and deadline-change notification are shared.

use crate::sync::RawSpinLock;

/// Nanoseconds between synthesized vblank edges (60 Hz, matching the
/// mode's `DEFAULT_VREFRESH` advertised by the card).
pub const VBLANK_PERIOD_NS: u64 = 1_000_000_000 / 60;

/// Wrap-aware "has the counter reached `target`" test on u64 sequences.
/// Mirrors Linux's `vblank_passed()` in `drivers/gpu/drm/drm_vblank.c`:
/// the comparison survives counter wraparound by interpreting the
/// difference as signed. The u32 userspace view is covered by casting
/// truncated values back to u64, which preserves the wrap semantics the
/// ABI hands out.
pub const fn vblank_passed(current: u64, target: u64) -> bool {
    current == target || (current.wrapping_sub(target) as i64) > 0
}

/// Linux's `widen_32_to_64()` (`drm_vblank.c`): reconstructs the full
/// u64 sequence a u32 counter value refers to, given a nearby full-width
/// reference. Low values just above a wrap resolve to the next cycle;
/// values on either side of the reference resolve to the nearest wrap.
pub const fn widen_32_to_64(low: u32, reference: u64) -> u64 {
    reference.wrapping_add(low.wrapping_sub(reference as u32) as i32 as i64 as u64)
}

/// An event queued for a future vblank edge by `CRTC_QUEUE_SEQUENCE` or
/// the `_DRM_VBLANK_EVENT` variant of `WAIT_VBLANK`.
#[derive(Debug)]
pub(super) enum QueuedVblankEvent {
    /// `DRM_EVENT_VBLANK` — `WAIT_VBLANK` with `_DRM_VBLANK_EVENT`.
    Vblank { user_data: u64 },
    /// `DRM_EVENT_CRTC_SEQUENCE` — `CRTC_QUEUE_SEQUENCE`.
    CrtcSequence { user_data: u64 },
}

#[derive(Debug)]
pub(super) struct PendingVblankEvent {
    pub event: QueuedVblankEvent,
    /// Full-width sequence the event fires at.
    pub target_sequence: u64,
}

/// Sequence counter and the current active scanout epoch.
pub(super) struct VblankClock {
    state: RawSpinLock<VblankState>,
}

struct VblankState {
    active: bool,
    anchor_ns: u64,
    base_sequence: u64,
    last_edge_ns: u64,
}

impl VblankState {
    fn at(&self, now_ns: u64) -> (u64, u64) {
        let elapsed = if self.active {
            now_ns.saturating_sub(self.anchor_ns) / VBLANK_PERIOD_NS
        } else {
            0
        };
        let edge_ns = if elapsed == 0 {
            self.last_edge_ns
        } else {
            self.anchor_ns
                .saturating_add(elapsed.saturating_mul(VBLANK_PERIOD_NS))
        };
        (self.base_sequence.saturating_add(elapsed), edge_ns)
    }

    fn edge_ns_of(&self, sequence: u64) -> u64 {
        if sequence <= self.base_sequence {
            self.last_edge_ns
        } else {
            self.anchor_ns.saturating_add(
                sequence
                    .saturating_sub(self.base_sequence)
                    .saturating_mul(VBLANK_PERIOD_NS),
            )
        }
    }
}

impl VblankClock {
    pub(super) fn new(now_ns: u64) -> Self {
        Self {
            state: RawSpinLock::new(VblankState {
                active: false,
                anchor_ns: now_ns,
                base_sequence: 0,
                last_edge_ns: now_ns,
            }),
        }
    }

    /// Called under the device's modeset lock. Returns whether workers
    /// must recompute their deadlines after the transition.
    pub(super) fn set_active(&self, active: bool, now_ns: u64) -> bool {
        let mut state = self.state.lock();
        if state.active == active {
            return false;
        }
        if active {
            state.anchor_ns = now_ns;
            if state.base_sequence == 0 {
                state.last_edge_ns = now_ns;
            }
        } else {
            (state.base_sequence, state.last_edge_ns) = state.at(now_ns);
        }
        state.active = active;
        true
    }

    pub(super) fn active_at(&self, now_ns: u64) -> Option<(u64, u64)> {
        let state = self.state.lock();
        state.active.then(|| state.at(now_ns))
    }

    pub(super) fn snapshot_at(&self, now_ns: u64) -> (u64, u64) {
        self.state.lock().at(now_ns)
    }

    pub(super) fn status_at(&self, now_ns: u64) -> (bool, u64, u64) {
        let state = self.state.lock();
        let (sequence, edge_ns) = state.at(now_ns);
        (state.active, sequence, edge_ns)
    }

    pub(super) fn deadline_ns(&self, sequence: u64) -> Option<u64> {
        let state = self.state.lock();
        state.active.then(|| state.edge_ns_of(sequence))
    }
}

#[cfg(all(test, not(axtest)))]
mod tests {
    use super::*;

    #[test]
    fn vblank_passed_tracks_order_and_wrap() {
        // Equal counts as passed (the event fires on its own edge).
        assert!(vblank_passed(5, 5));
        assert!(!vblank_passed(4, 5));
        assert!(vblank_passed(6, 5));
        // Wrap boundary: a counter that wrapped to 0 has passed a target
        // just below u64::MAX.
        assert!(vblank_passed(u64::MAX, u64::MAX - 1));
        assert!(vblank_passed(0, u64::MAX));
        // A nearby target just before wrap has passed; a future target has not.
        assert!(vblank_passed(1, u64::MAX));
        assert!(!vblank_passed(1, 2));
    }

    #[test]
    fn widen_resolves_low_values_near_reference() {
        // Plain small value near a small counter: unchanged.
        assert_eq!(widen_32_to_64(5, 0), 5);
        // Value in the same high-word neighborhood as the reference.
        assert_eq!(widen_32_to_64(5, 0x1_0000_0005), 0x1_0000_0005);
        // Values resolve to the closest wrap on either side of the reference.
        assert_eq!(widen_32_to_64(0xffff_fff0, 0), u64::MAX - 15);
        assert_eq!(widen_32_to_64(5, 0xffff_fff0), 0x1_0000_0005);
        assert_eq!(widen_32_to_64(0xffff_fff0, 0x2_0000_0000), 0x1_ffff_fff0);
    }

    #[test]
    fn clock_sequences_track_elapsed_periods() {
        let clock = VblankClock::new(1_000);
        assert_eq!(clock.snapshot_at(1_000 + VBLANK_PERIOD_NS * 3).0, 0);
        clock.set_active(true, 1_000);
        assert_eq!(clock.snapshot_at(1_000).0, 0);
        // Just before the first edge.
        assert_eq!(clock.snapshot_at(1_000 + VBLANK_PERIOD_NS - 1).0, 0);
        // On the first edge.
        assert_eq!(clock.snapshot_at(1_000 + VBLANK_PERIOD_NS).0, 1);
        // Three and a half periods later.
        assert_eq!(
            clock.snapshot_at(1_000 + VBLANK_PERIOD_NS * 7 / 2).0,
            3
        );
        // Edge timestamps round-trip through the sequence computation.
        assert_eq!(clock.deadline_ns(4), Some(1_000 + VBLANK_PERIOD_NS * 4));

        clock.set_active(false, 1_000 + VBLANK_PERIOD_NS * 7 / 2);
        assert_eq!(clock.snapshot_at(1_000 + VBLANK_PERIOD_NS * 30).0, 3);
        assert_eq!(clock.deadline_ns(4), None);
        clock.set_active(true, 1_000 + VBLANK_PERIOD_NS * 30);
        assert_eq!(clock.snapshot_at(1_000 + VBLANK_PERIOD_NS * 30).0, 3);
        assert_eq!(clock.snapshot_at(1_000 + VBLANK_PERIOD_NS * 30).1, 1_000 + VBLANK_PERIOD_NS * 3);
        assert_eq!(clock.deadline_ns(4), Some(1_000 + VBLANK_PERIOD_NS * 31));
        assert_eq!(clock.snapshot_at(1_000 + VBLANK_PERIOD_NS * 31).0, 4);
    }
}
