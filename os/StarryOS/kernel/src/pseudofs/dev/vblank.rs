//! Synthesized 60 Hz vblank clock for the emulated `/dev/dri/card0`.
//!
//! The card has no real scanout engine — presentation is a synchronous
//! memcpy — so there is no hardware counter to latch vblank edges from.
//! Linux DRM userspace (libdrm, compositors) nevertheless expects a
//! monotonic per-CRTC sequence advancing at the mode's refresh rate,
//! plus timestamps of the most recent edge (`CRTC_GET_SEQUENCE`,
//! `CRTC_QUEUE_SEQUENCE`, `WAIT_VBLANK`, and flip-completion events).
//! The clock here derives that sequence from elapsed monotonic time
//! anchored at card creation, mirroring Linux's
//! `vblank_disable_immediate` mode where the counter is computed from
//! timestamps rather than latched by an interrupt
//! (`drivers/gpu/drm/drm_vblank.c`, `drm_vblank_count_and_time`).
//!
//! Each open file owns its queued events and a deadline worker wakes readers
//! at the next edge; only the monotonic clock is shared by the device.

use core::sync::atomic::{AtomicU64, Ordering};

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

/// Sequence counter derived from elapsed monotonic time. Sequence 0 is
/// the card-creation anchor; edge *N* occurs at
/// `anchor_ns + N * VBLANK_PERIOD_NS`.
pub(super) struct VblankClock {
    anchor_ns: AtomicU64,
}

impl VblankClock {
    pub(super) fn new(now_ns: u64) -> Self {
        Self {
            anchor_ns: AtomicU64::new(now_ns),
        }
    }

    /// The most recent completed edge's sequence number at `now_ns`.
    pub(super) fn sequence_at(&self, now_ns: u64) -> u64 {
        let anchor = self.anchor_ns.load(Ordering::Relaxed);
        now_ns.saturating_sub(anchor) / VBLANK_PERIOD_NS
    }

    /// Monotonic timestamp (nanoseconds) of edge `sequence`. Saturates
    /// instead of overflowing for far-future targets.
    pub(super) fn edge_ns_of(&self, sequence: u64) -> u64 {
        let anchor = self.anchor_ns.load(Ordering::Relaxed);
        anchor.saturating_add(sequence.saturating_mul(VBLANK_PERIOD_NS))
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
        assert_eq!(clock.sequence_at(1_000), 0);
        // Just before the first edge.
        assert_eq!(clock.sequence_at(1_000 + VBLANK_PERIOD_NS - 1), 0);
        // On the first edge.
        assert_eq!(clock.sequence_at(1_000 + VBLANK_PERIOD_NS), 1);
        // Three and a half periods later.
        assert_eq!(
            clock.sequence_at(1_000 + VBLANK_PERIOD_NS * 7 / 2),
            3
        );
        // Edge timestamps round-trip through the sequence computation.
        assert_eq!(clock.edge_ns_of(4), 1_000 + VBLANK_PERIOD_NS * 4);
    }
}
