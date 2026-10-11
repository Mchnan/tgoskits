//! Generic-DRM syncobj family for `/dev/dri/card0`.
//!
//! Mesa's venus ICD tracks GPU completion through timeline syncobjs
//! (`util_sync_provider_drm` selects the kernel path once
//! `DRM_CAP_SYNCOBJ_TIMELINE` is reported), so card0 serves the family
//! alongside the `VIRTGPU_*` ioctls. v1 syncobjs are pure timelines (the only
//! form venus exercises); binary syncobj userspace is emulated on top:
//! "signaled" means `signaled_point >= 1`.
//!
//! Fence completion is observed through the device's completion view
//! ([`rdif_gpu::VirglOps::fence_completed`], which pumps the control queue as
//! a side effect). Out-syncobjs of a fenced EXECBUFFER advance only when the
//! host retired the submission's fence — signalling at submit time instead
//! would let the guest lap the venus ring and corrupt the host command
//! stream, so every reader (wait, query, export) drains the pending-retire
//! registry first.

use alloc::{sync::Arc, vec::Vec};
use core::sync::atomic::{AtomicU32, Ordering};

use bytemuck::{AnyBitPattern, NoUninit};

use super::super::drm::{
    DrmSyncobjArray, DrmSyncobjCreate, DrmSyncobjDestroy, DrmSyncobjEventfd, DrmSyncobjHandle,
    DrmSyncobjTimelineArray, DrmSyncobjTimelineWait, DrmSyncobjWait,
    DRM_SYNCOBJ_CREATE_SIGNALED, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL,
    DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE, DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT,
};
use super::super::sync_file::SyncFile;
use super::Card0;
use crate::{
    file::{add_file_like, get_file_like},
    mm::{vm_load, vm_write_slice},
    sync::Mutex,
    task::{UserTaskRef, yield_now},
};

type VfsResult<T = ()> = Result<T, axfs_ng_vfs::VfsError>;
use axfs_ng_vfs::VfsError;

/// A syncobj's completion state: a timeline watermark plus the registered
/// waiters (eventfds and sync-file exports) waiting on future points.
pub(super) struct SyncobjState {
    /// Timeline watermark: every point `<= signaled_point` is complete.
    pub(super) signaled_point: u64,
    /// Eventfds registered via `DRM_IOCTL_SYNCOBJ_EVENTFD`, with the point
    /// each waits for.
    pub(super) eventfds: Vec<(u64, Arc<crate::file::event::EventFd>)>,
    /// Sync-file exports registered via `DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD`,
    /// each with the point it represents. The file is bound to the retiring
    /// device fence when the watermark reaches its point; an already-reached
    /// point exports an immediately-signaled file (fence id 0 completes on
    /// the first refresh).
    pub(super) sync_files: Vec<(u64, Arc<SyncFile>)>,
}

/// Out-syncobjs registered against one fenced EXECBUFFER. The fence id comes
/// from the device's monotonic counter; the entries advance when the device
/// reports that fence complete.
pub(super) struct PendingRetire {
    pub(super) fence_id: u64,
    pub(super) owner: u64,
    pub(super) syncobjs: Vec<(u32, u64)>,
}

/// Per-fd syncobj table: `(file_id, handle)` → shared state. Lives on
/// [`Card0`] rather than the per-fd context so syncobjs exist on
/// context-less fds (Linux creates them in `drm_syncobj_create_ioctl`
/// without any rendering context, and reaps them in `drm_release`).
pub(super) type SyncobjTable = Mutex<alloc::collections::BTreeMap<(u64, u32), Arc<Mutex<SyncobjState>>>>;

/// One drained retire entry: `(fence_id, owner, out-syncobjs)`.
type RetiredFence = (u64, u64, Vec<(u32, u64)>);

fn load_arg<T: AnyBitPattern>(current: &UserTaskRef, arg: usize) -> VfsResult<T> {
    let loaded = vm_load::<T>(current, arg as *const T, 1).map_err(|_| VfsError::BadAddress)?;
    Ok(loaded[0])
}

fn store_arg<T: NoUninit>(current: &UserTaskRef, arg: usize, value: &T) -> VfsResult {
    vm_write_slice(current, arg as *mut T, core::slice::from_ref(value))
        .map_err(|_| VfsError::BadAddress)
}

impl Card0 {
    /// Drains completed fences and advances the out-syncobjs whose
    /// submissions they retire. Every syncobj-observing entry point calls
    /// this first so a query or wait observes the current watermark; a
    /// response nobody drains would leave waiters spinning forever.
    pub(super) fn pump_retired_fences(&self) {
        // Snapshot the fence ids under the registry lock, then ask the device
        // outside every card0 lock: `fence_completed` takes the GPU lock and
        // pumps the control queue.
        let fence_ids: Vec<RetiredFence> = {
            let pending = self.pending_retires.lock();
            pending
                .iter()
                .map(|entry| (entry.fence_id, entry.owner, entry.syncobjs.clone()))
                .collect()
        };
        if fence_ids.is_empty() {
            return;
        }
        let mut retired: Vec<RetiredFence> = Vec::new();
        for (fence_id, owner, syncobjs_list) in fence_ids {
            let done = ax_gpu::with_gpu(|device| {
                device
                    .virgl()
                    .ok_or(rdif_gpu::GpuError::Unsupported)?
                    .fence_completed(fence_id)
            })
            .ok()
            .and_then(|result| result.ok())
            .unwrap_or(false);
            if done {
                retired.push((fence_id, owner, syncobjs_list));
            }
        }
        if retired.is_empty() {
            return;
        }
        {
            let mut pending = self.pending_retires.lock();
            for (fence_id, _, _) in &retired {
                pending.retain(|entry| entry.fence_id != *fence_id);
            }
        }
        // Advance the watermarks and collect the waiters to wake, all under
        // the syncobj table lock; signals happen after it is released.
        let table = self.syncobjs.lock();
        let mut woken: Vec<Arc<crate::file::event::EventFd>> = Vec::new();
        for (_, owner, syncobjs_list) in retired {
            for (handle, point) in syncobjs_list {
                let Some(state) = table.get(&(owner, handle)).cloned() else {
                    // The fd's syncobj was destroyed while the submit was in
                    // flight (Linux: a destroyed syncobj's fences still
                    // retire; nobody observes them).
                    continue;
                };
                let mut state = state.lock();
                if state.signaled_point >= point {
                    continue;
                }
                state.signaled_point = point;
                Self::collect_reached_waiters(&mut state, &mut woken);
            }
        }
        drop(table);
        for eventfd in woken {
            let _ = eventfd.signal_kernel(1);
        }
    }

    /// Collects the eventfds and sync-files whose registered points the
    /// watermark now covers. Sync-files bind to fence id 0 (complete on the
    /// first refresh) — the caller advances the watermark only after the
    /// device fence already retired, so no per-file device fence is needed.
    fn collect_reached_waiters(
        state: &mut SyncobjState,
        woken: &mut Vec<Arc<crate::file::event::EventFd>>,
    ) {
        let mut i = 0;
        while i < state.eventfds.len() {
            if state.signaled_point >= state.eventfds[i].0 {
                woken.push(state.eventfds.swap_remove(i).1);
            } else {
                i += 1;
            }
        }
        let mut j = 0;
        while j < state.sync_files.len() {
            if state.signaled_point >= state.sync_files[j].0 {
                let (file_point, file) = state.sync_files.swap_remove(j);
                let _ = file_point;
                file.bind_fence_id(0);
                file.register();
            } else {
                j += 1;
            }
        }
    }

    /// The device fence id of the outstanding submission that will advance
    /// `handle` to `point` on `owner`'s fd, if one is still pending.
    fn pending_fence_for(&self, owner: u64, handle: u32, point: u64) -> Option<u64> {
        let pending = self.pending_retires.lock();
        pending
            .iter()
            .find(|entry| {
                entry.owner == owner
                    && entry.syncobjs.iter().any(|&(h, p)| h == handle && p == point)
            })
            .map(|entry| entry.fence_id)
    }

    /// Advances one syncobj's watermark on behalf of an explicit
    /// `TIMELINE_SIGNAL` (or binary SIGNAL) and wakes its waiters.
    fn signal_syncobj_point(
        &self,
        owner: u64,
        handle: u32,
        point: u64,
        woken: &mut Vec<Arc<crate::file::event::EventFd>>,
    ) {
        let table = self.syncobjs.lock();
        let Some(state) = table.get(&(owner, handle)).cloned() else {
            return;
        };
        drop(table);
        let mut state = state.lock();
        if state.signaled_point >= point {
            return;
        }
        state.signaled_point = point;
        Self::collect_reached_waiters(&mut state, woken);
    }

    /// Resolves handles to their per-fd syncobj states, failing with
    /// `NotFound` when any handle is unknown.
    fn lookup_syncobjs(
        &self,
        owner: u64,
        handles: &[u32],
    ) -> VfsResult<Vec<Arc<Mutex<SyncobjState>>>> {
        let table = self.syncobjs.lock();
        handles
            .iter()
            .map(|handle| {
                table
                    .get(&(owner, *handle))
                    .cloned()
                    .ok_or(VfsError::NotFound)
            })
            .collect()
    }

    // ---- ioctl handlers ----

    pub(super) fn handle_syncobj_create(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjCreate = load_arg(current, arg)?;
        if args.flags & !DRM_SYNCOBJ_CREATE_SIGNALED != 0 {
            return Err(VfsError::InvalidInput);
        }
        let handle = self.next_syncobj_handle();
        // Syncobjs are GEM-level objects: any drm fd may create them, with
        // or without a rendering context (Linux has no context check in
        // `drm_syncobj_create`).
        self.syncobjs.lock().insert(
            (owner, handle),
            Arc::new(Mutex::new(SyncobjState {
                signaled_point: u64::from(args.flags & DRM_SYNCOBJ_CREATE_SIGNALED != 0),
                eventfds: Vec::new(),
                sync_files: Vec::new(),
            })),
        );
        store_arg(current, arg, &DrmSyncobjCreate {
            handle,
            flags: args.flags,
        })?;
        Ok(0)
    }

    pub(super) fn handle_syncobj_destroy(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjDestroy = load_arg(current, arg)?;
        self.syncobjs
            .lock()
            .remove(&(owner, args.handle))
            .ok_or(VfsError::NotFound)?;
        Ok(0)
    }

    pub(super) fn handle_syncobj_query(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjTimelineArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        // Retire responses may have landed since the last submit; drain them
        // so a query observes the current watermark.
        self.pump_retired_fences();
        let states = self.lookup_syncobjs(owner, &handles)?;
        for (i, state) in states.iter().enumerate() {
            let point = state.lock().signaled_point;
            vm_write_slice(current, (args.points + i as u64 * 8) as *mut u64, &[point])
                .map_err(|_| VfsError::BadAddress)?;
        }
        Ok(0)
    }

    pub(super) fn handle_syncobj_reset(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        for state in self.lookup_syncobjs(owner, &handles)? {
            state.lock().signaled_point = 0;
        }
        Ok(0)
    }

    pub(super) fn handle_syncobj_signal(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        let mut woken = Vec::new();
        for handle in handles {
            self.signal_syncobj_point(owner, handle, 1, &mut woken);
        }
        drop(woken);
        Ok(0)
    }

    pub(super) fn handle_syncobj_timeline_signal(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjTimelineArray = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        let points: Vec<u64> =
            vm_load(current, args.points as *const u64, args.count_handles as usize)
                .map_err(|_| VfsError::BadAddress)?;
        let mut woken = Vec::new();
        for (handle, point) in handles.iter().zip(points) {
            self.signal_syncobj_point(owner, *handle, point, &mut woken);
        }
        drop(woken);
        Ok(0)
    }

    /// `DRM_IOCTL_SYNCOBJ_EVENTFD` (v6.7 UAPI): registers an eventfd that
    /// the kernel signals when a syncobj point completes. Mesa's DRM sync
    /// provider uses this as its completion wakeup, so a missing handler
    /// makes every Vulkan fence wait fall back to polling or fail outright.
    pub(super) fn handle_syncobj_eventfd(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjEventfd = load_arg(current, arg)?;
        if args.pad != 0 || args.flags & !DRM_SYNCOBJ_WAIT_FLAGS_WAIT_AVAILABLE != 0 {
            return Err(VfsError::InvalidInput);
        }
        let file = get_file_like(args.fd).map_err(|_| VfsError::BadFileDescriptor)?;
        let eventfd = file
            .downcast_arc::<crate::file::event::EventFd>()
            .map_err(|_| VfsError::InvalidInput)?;

        let state = self
            .syncobjs
            .lock()
            .get(&(owner, args.handle))
            .cloned()
            .ok_or(VfsError::NotFound)?;
        let mut state = state.lock();
        // WAIT_AVAILABLE asks to be woken when a fence *attaches* to the
        // point; with the watermark model the point is always backed by a
        // fence the moment it is signaled, so the two conditions coincide.
        if state.signaled_point >= args.point {
            drop(state);
            let _ = eventfd.signal_kernel(1);
        } else {
            state.eventfds.push((args.point, eventfd));
        }
        Ok(0)
    }

    /// `DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD`: exports the syncobj's fence as a
    /// sync_file fd — the EGL native-fence path (zink/venus export per-frame
    /// completion this way to drive the output-pool buffer lifecycle). An
    /// already-reached point exports a signaled file; a future point fires
    /// when the watermark passes it.
    pub(super) fn handle_syncobj_handle_to_fd(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> Option<VfsResult<usize>> {
        const EXPORT_SYNC_FILE: u32 = 1;
        let args: DrmSyncobjHandle = load_arg(current, arg).ok()?;
        if args.flags & !EXPORT_SYNC_FILE != 0 {
            return Some(Err(VfsError::InvalidInput));
        }
        // Drain retire responses first: exporting a point the host already
        // retired must produce a signaled file, not a pending registration.
        self.pump_retired_fences();
        let state = self
            .syncobjs
            .lock()
            .get(&(owner, args.handle))
            .cloned()?;
        let file = Arc::new(SyncFile::new(0));
        {
            let mut state = state.lock();
            if state.signaled_point >= args.point {
                // Fence id 0 completes on the first refresh, so a registered
                // file over a reached point signals right away.
                file.register();
            } else if let Some(fence_id) =
                self.pending_fence_for(owner, args.handle, args.point)
            {
                // The point belongs to an outstanding submission: bind the
                // export to that submission's device fence and hand it to
                // the completion refresher. The file then signals exactly
                // when the host retires the batch — without this, signaling
                // depends on somebody else issuing another syncobj ioctl to
                // run the retire pump, and a client parked on the exported
                // fd would stall forever.
                drop(state);
                file.bind_fence_id(fence_id);
                file.register();
            } else {
                state.sync_files.push((args.point, file.clone()));
            }
        }
        let fd = match add_file_like(file, true) {
            Ok(fd) => fd,
            Err(_) => return Some(Err(VfsError::Io)),
        };
        let out = DrmSyncobjHandle { fd, ..args };
        Some(store_arg(current, arg, &out).map(|_| 0))
    }

    /// `DRM_IOCTL_SYNCOBJ_FD_TO_HANDLE`: imports a sync_file fd — the other
    /// half of the native-fence round trip. Only files this kernel exported
    /// are honored: an already-signaled file turns into the binary-signaled
    /// syncobj view; a still-pending file has no async completion path here
    /// and is rejected rather than left silently stuck.
    pub(super) fn handle_syncobj_fd_to_handle(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> Option<VfsResult<usize>> {
        let args: DrmSyncobjHandle = load_arg(current, arg).ok()?;
        let file = get_file_like(args.fd).ok()?;
        let file = file.downcast_arc::<SyncFile>().ok()?;
        if !file.refresh() {
            return Some(Err(VfsError::InvalidInput));
        }
        let handle = self.next_syncobj_handle();
        self.syncobjs.lock().insert(
            (owner, handle),
            Arc::new(Mutex::new(SyncobjState {
                signaled_point: 1,
                eventfds: Vec::new(),
                sync_files: Vec::new(),
            })),
        );
        let out = DrmSyncobjHandle { handle, ..args };
        Some(store_arg(current, arg, &out).map(|_| 0))
    }

    pub(super) fn handle_syncobj_timeline_wait(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjTimelineWait = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        let points: Vec<u64> =
            vm_load(current, args.points as *const u64, args.count_handles as usize)
                .map_err(|_| VfsError::BadAddress)?;
        let states = self.lookup_syncobjs(owner, &handles)?;

        let check = || -> VfsResult<bool> {
            let mut any = false;
            let mut all = true;
            for (i, state) in states.iter().enumerate() {
                let done = state.lock().signaled_point >= points[i];
                any |= done;
                all &= done;
            }
            Ok(if args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL != 0 {
                all
            } else {
                any
            })
        };

        // Any unsatisfied wait references a future point. Honour
        // WAIT_FOR_SUBMIT by sleeping until the timeout lapses; without the
        // flag Linux rejects unknown-future waits with EINVAL.
        let allow_block = args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT != 0;
        let start = ax_runtime::hal::time::monotonic_time_nanos();
        let mut stall_warned = false;
        loop {
            // Drain host retire responses so a parked wait can observe
            // progress made while this thread slept between checks.
            self.pump_retired_fences();
            if check()? {
                return Ok(0);
            }
            if !allow_block {
                return Err(VfsError::InvalidInput);
            }
            let now = ax_runtime::hal::time::monotonic_time_nanos();
            if now.saturating_sub(start) >= args.timeout_nsec {
                return Err(VfsError::TimedOut);
            }
            // A wait spinning past one second means the retire responses for
            // its fence are not arriving — the signature of a venus-side
            // fence stall.
            if !stall_warned && now.saturating_sub(start) > 1_000_000_000 {
                stall_warned = true;
                warn!(
                    "card0: timeline syncobj wait pending >1s (handles={:?})",
                    handles
                );
            }
            yield_now();
        }
    }

    /// Binary `DRM_IOCTL_SYNCOBJ_WAIT` — the timeline predicate with every
    /// handle checked at point 1.
    pub(super) fn handle_syncobj_wait(
        &self,
        owner: u64,
        current: &UserTaskRef,
        arg: usize,
    ) -> VfsResult<usize> {
        let args: DrmSyncobjWait = load_arg(current, arg)?;
        let handles: Vec<u32> = vm_load(
            current,
            args.handles as *const u32,
            args.count_handles as usize,
        )
        .map_err(|_| VfsError::BadAddress)?;
        let states = self.lookup_syncobjs(owner, &handles)?;

        let check = || -> VfsResult<bool> {
            let mut any = false;
            let mut all = true;
            for state in &states {
                let done = state.lock().signaled_point >= 1;
                any |= done;
                all &= done;
            }
            Ok(if args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_ALL != 0 {
                all
            } else {
                any
            })
        };

        let allow_block = args.flags & DRM_SYNCOBJ_WAIT_FLAGS_WAIT_FOR_SUBMIT != 0;
        let start = ax_runtime::hal::time::monotonic_time_nanos();
        loop {
            self.pump_retired_fences();
            if check()? {
                return Ok(0);
            }
            if !allow_block {
                return Err(VfsError::InvalidInput);
            }
            let now = ax_runtime::hal::time::monotonic_time_nanos();
            if now.saturating_sub(start) >= args.timeout_nsec.unsigned_abs() {
                return Err(VfsError::TimedOut);
            }
            yield_now();
        }
    }

    /// Removes all syncobjs of a closing file description
    /// (Linux `drm_release` reaps the fd's syncobj table).
    pub(super) fn close_syncobjs(&self, owner: u64) {
        self.syncobjs.lock().retain(|&(fd_owner, _), _| fd_owner != owner);
    }

    // ---- helpers ----

    fn next_syncobj_handle(&self) -> u32 {
        // Syncobj handles live in the per-fd tables, so a device-wide counter
        // keeps them unique across fds without colliding with GEM handles
        // (which start at the venus face's reserved range).
        static NEXT: AtomicU32 = AtomicU32::new(1);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }
}
