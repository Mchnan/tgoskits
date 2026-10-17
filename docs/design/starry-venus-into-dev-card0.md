# Venus face on the portable GPU stack (`card0`)

The venus (capset 4) 3D face as implemented on this branch. This file
replaces the 2026-10-07 edition, which described a first porting round
against symbols that no longer exist (`pseudofs/dev/vgpu.rs`,
`VirtioGpu3D`, `register_global_3d`, `VgpuBlobFd`); the face has since
been re-landed on the portable GPU stack and its retire semantics inverted
(out-syncobjs signal at host retire, not at submit). Symbol anchors; lines
drift.

## 1. Background and goal

Upstream `dev` carries a portable GPU stack — rdif `VirglOps`, an async
control queue, `card0` with per-fd GEM semantics — whose 3D face is
virgl-only: `CONTEXT_INIT` refuses capset 4, `GETPARAM(HOST_VISIBLE)` is
0, and there is no syncobj family, hostmem window or `MAP_BLOB`, so
Mesa's venus ICD cannot initialize. This branch adds the venus face as
an increment on top of it:

- `drivers/gpu/virtio-gpu` negotiates `RESOURCE_BLOB`, `CONTEXT_INIT` and
  `BLOB_ALIGNMENT`, and drives `MAP_BLOB` / `UNMAP_BLOB` and ring-based
  fenced submissions against the PCI hostmem window.
- `drivers/interface/rdif-gpu` grows `VirglOps` default methods
  (`submit_ring`, `map_blob`, `unmap_blob`, `host_memory_region`,
  `blob_alignment`); existing implementors are unaffected.
- StarryOS `card0` admits venus contexts by the host's capset list, maps
  venus blobs into recyclable hostmem BAR slots, and serves the syncobj
  family with retire-accurate semantics. The virgl path (classic contexts,
  guest-backed blobs, `FENCE_FD_IN/OUT` execbuffers) is unchanged and
  shares the same per-fd context-id space.

## 2. Overall structure

```
 Mesa venus ICD --DRM ioctls--> /dev/dri/card0
   card0.rs ............. GEM/KMS/lifecycle, BAR slots, blob mmap routing
   card0/virtgpu.rs ..... VIRTGPU_* handlers, venus branch per ioctl
   card0/syncobj.rs ..... syncobj family + retire pump
   card0/virtgpu_uapi.rs  UAPI layouts and constants
   | axgpu::with_gpu -> GpuDevice::virgl() -> &mut dyn VirglOps
   v axgpu (os/arceos/modules/axgpu): MAIN_GPU, wait-queue outside lock
   v VirtIoGpuDevice (virtio-gpu/src/rdif.rs): VirglOps impl
   v VirtIoGpu / ControlQueue ({device,ctrl,wire}.rs): one control virtqueue
```

- **Driver crate** (`drivers/gpu/virtio-gpu/src/`, `no_std` + `alloc`):
  - `wire.rs` — `Features` (incl. `BLOB_ALIGNMENT`, bit 5); config tail
    field `Config::blob_alignment`, read only once that feature was
    negotiated; `CtrlHeader::with_fence_ring` (`FENCE`+`INFO_RING_IDX`,
    the Linux `virtio_gpu_fence_emit` shape); `MAP_BLOB` (0x0208) /
    `UNMAP_BLOB` (0x0209) with `OK_MAP_INFO`; ABI size asserts.
  - `ctrl.rs` — `ControlQueue`, the Linux virtio_gpu submission model:
    strict-FIFO used ring; fire-and-forget `enqueue` that never kicks and
    the boundary `notify` (= `virtio_gpu_notify()`) that delivers;
    blocking `request_sync`; bounded waits (`WAIT_TIMEOUT_NS` = 5 s);
    fence bookkeeping = the contiguous watermark `completed_fence_id` plus
    the out-of-order set `completed_fences` (§3).
  - `device.rs` — `VirtIoGpu`: `submit_3d_ring`; `map_blob` (blocking,
    returns the host `map_info` cache bits); `unmap_blob`; `attach_hostmem`;
    `blob_alignment()`. `rdif.rs` implements `VirglOps` incl. these.
- **Interface crate** (`drivers/interface/rdif-gpu/src/lib.rs`): the
  `VirglOps` trait and `HostMemoryRegion`; all venus additions are defaults.
- **OS adapters**: `os/arceos/modules/axgpu` publishes the one registered
  device behind `MAIN_GPU` (`with_gpu`, `wait_gpu_condition` +
  `GPU_WAIT_QUEUE` for sleeps outside the device lock, `service_irq_work`).
  `drivers/ax-driver/src/pci/mod.rs::parse_virtio_shm_cap` resolves the
  PCI `SHARED_MEMORY_CFG` capability into `VirtioShmRegion`;
  `virtio/display.rs::probe_pci` filters shm_id 1
  (`VIRTIO_GPU_SHM_ID_HOST_VISIBLE`) and injects it with `attach_hostmem`
  before registration; plain 2D devices degrade to "no mappable blobs".
- **Kernel** (`os/StarryOS/kernel/src/pseudofs/dev/card0.rs` + `card0/`):
  per-fd GEM handles, KMS, lifecycle. `GpuResource` carries `mapped_blob:
  Option<MappedBlobBar>`; PRIME exports wrap the same `Arc`
  (`HostResourceDmaBuf`) and same-device imports alias it under
  `blob_aliases`, so mmap and fb lookups resolve to one host resource
  (zero-copy, the `virtgpu_prime.c` shape). `ADDFB2` binds a blob handle
  to `FbBacking::Gpu3d`; presenting reaches rdif `bind_scanout`, which
  uses `set_scanout_blob` for blobs.

## 3. Fence / retire model

Core property: **an out-syncobj signals when the host retires the
submission's fence, never at submit time** — early signalling lets the
guest lap the venus ring and corrupt the host command stream.

1. A venus `EXECBUFFER` submits a fenced `SUBMIT_3D` via
   `VirglOps::submit_ring` (the ring index rides the fence header, so the
   host retires the fence on that ring's timeline); the fence id comes from
   the monotonic counter shared with every fenced command.
2. The host defers a ring batch's used-ring response until its renderer
   retires the batch, while later empty ring kicks complete immediately —
   completions arrive **out of order**. `pump_completions` folds a pop
   into `completed_fence_id` only when it extends the contiguous prefix;
   out-of-order pops park in `completed_fences` until the hole fills, and
   `fence_completed` accepts either. A single max-popped watermark would
   let a later id subsume an earlier still-running batch — observed as
   `vkWaitForFences` returning early and readbacks arriving zeroed.
3. card0 registers each submit's out-syncobjs as a `PendingRetire`
   (`pending_retires`). `pump_retired_fences` runs first in every
   syncobj-observing entry point (wait, query, export): it asks the device
   `fence_completed` (which itself delivers the batch and pumps the queue),
   then advances each `signaled_point` watermark and wakes the registered
   waiters — eventfds signalled, sync-file exports bound to the retiring
   fence (`pending_fence_for`) flip.
4. In-syncobjs are waited **inline before the submit**
   (`wait_syncobj_dependency`) — a real wait, not a FIFO assumption, since
   ring batches retire out of order (Linux `virtio_gpu_parse_deps` +
   `virtio_gpu_do_fence_wait`).
5. Delivery is boundary-based: every card0 ioctl ends with
   `VirglOps::ctrl_notify`. A ring kick that carries no out-syncobj has no
   other delivery path — without the boundary notify the doorbell sits in
   the avail ring with the host idle and every waiter sleeps forever.
   `GpuResource::drop` uses the same contract: fire-and-forget
   `UNMAP_BLOB` plus one boundary notify ahead of the fenced UNREF.
6. All waits are bounded: the 5 s `WAIT_TIMEOUT_NS` unwedges a stalled
   host with a typed error; the inline dependency wait warns past 1 s but
   never fails the submit; fenced UNREF observations go to the
   `gpu-release-reaper` kernel thread, which retries forever (a slow host
   costs retries, not a freeze — nothing is freed there).

## 4. Hostmem BAR and slot management

- The window: `VirglOps::host_memory_region()`; `GETPARAM(HOST_VISIBLE)`
  reports 1 only when it exists (`venus_available`).
- Slots: `reserve_bar_slot(region_len, size, granularity)` — first-fit over
  `BAR_SLOTS` (offset → padded length) at granularity
  `max(negotiated alignment, BAR_SLOT_ALIGN)`; `BAR_SLOT_ALIGN` is 16 KiB
  because macOS hosts back QEMU with 16 KiB pages and a sub-16K-aligned
  hostmem subsection makes the hvf memory listener skip the EPT mapping.
  The wire size rounds up to the granularity; the userspace-visible size
  stays the requested one (`MappedBlobBar`: `phys`, `size`, `bar_offset`,
  `slot_len`, `mmap_key`, `map_info`). Exhaustion is `ENOSPC`.
- Recycling: `release_bar_slot` runs in `GpuResource::drop` right after the
  `UNMAP_BLOB` is enqueued, not after it completes — safe because the
  strict-FIFO control queue makes any later `MAP_BLOB` at the same offset
  execute after the unmap, so create/destroy cycles cannot exhaust the
  window. That is what lets `CREATE_BLOB` map eagerly (§5).
- Userspace mapping: `VIRTGPU_MAP` returns the resource's synthetic
  `mmap_key` (page-strided from `BLOB_MMAP_KEY_BASE = 1 << 40`, disjoint
  from the dumb-offset key space). `device_mmap` routes keys at or above
  the base through `blob_mmap_target` (creator fd or a `blob_aliases`
  PRIME clone — a guessed key must not map another client's blob) to
  `DeviceMmap::PhysicalCachedResolved` — cacheability follows the host's
  `map_info` — with the resource `Arc` pinned for the VMA's lifetime.

## 5. UAPI surface

`card0/virtgpu_uapi.rs` pins the layouts, `card0/virtgpu.rs` and
`card0/syncobj.rs` the semantics. Version notes: `EXECBUFFER` is the
64-byte v6.6 layout with the syncobj tail, the handle↔fd `TIMELINE` flag
is the v6.16 point form, and `CREATE_BLOB` is 56 bytes with the
`blob_hints` tail — **linux master, post-v7.1**: the ioctl number encodes
the struct size, so the 48-byte pre-hints layout is unreachable to
current Mesa.

| ioctl | Acceptance on the venus face |
| --- | --- |
| `CONTEXT_INIT` | Once per fd (repeat → `EEXIST`). `CAPSET_ID` validated against the host capset mask (`device_capset_mask`): capset 4 admitted exactly when the host lists it; id > 6 → `EINVAL`. `NUM_RINGS` 1..=64. `POLL_RINGS_MASK` accepted, ignored. Unknown param → `EINVAL`. |
| `GETPARAM` | `3D_FEATURES`, `CAPSET_QUERY_FIX` (=1), `RESOURCE_BLOB`, `CONTEXT_INIT` per negotiation; `HOST_VISIBLE` per hostmem presence; `CROSS_DEVICE` = 0; `SUPPORTED_CAPSET_IDS` = host mask; `BLOB_ALIGNMENT` = negotiated value or `ENOENT`. Unknown → `EINVAL`. |
| `GET_CAPS` | v7.1 semantics: `size==0` → `EINVAL`; missing or too-old capset → `EINVAL`; copy clamped to `min(size, host_size)`; cached per (id, ver). |
| `RESOURCE_CREATE_BLOB` | Requires a venus context and `HOST3D`; `pad != 0` or hint bits beyond `DEFER_MAPPING` → `EINVAL`; size a multiple of the negotiated alignment, ≤ window; no guest shadow (virgl keeps one). Every mappable blob is **mapped eagerly** — `DEFER_MAPPING` is accepted but not honored: Linux defers to save hostmem, here slot recycling (§4) bounds that cost instead and no lazy-map path exists. Slot exhaustion → `ENOSPC`. |
| `EXECBUFFER` | Flags ⊆ `RING_IDX` (size 0 = ring kick, legal; `FENCE_FD_IN/OUT` rejected — venus uses syncobjs); `ring_idx < num_rings`; ≤ 256 bo handles; ≤ 1024 syncobj entries each direction, `syncobj_stride` ≥ 16; out-entry flags must be 0, in-entry flags may carry `RESET` (applied after the submit, Linux cleanup stage); unknown in-handle → `ENOENT`, unknown out-handle → `EINVAL`. In-syncobjs waited inline (§3.4); out-syncobjs enter `pending_retires`. |
| `MAP` | Blob handle → its `mmap_key`; dumb handles keep the dumb-offset space. |
| `WAIT` | Waits/probes the resource's `last_fence`; expiry and NOWAIT-busy both `EBUSY`. |
| `TRANSFER_TO/FROM_HOST` | From-host waits its own fence outside the device lock, then syncs the backing for the CPU; to-host is fire-and-forget at the boundary. |
| `RESOURCE_CREATE/INFO` | Classic virgl 3D path, unchanged. |
| syncobj family (`0xBF..0xCF`) | `CREATE/DESTROY/RESET/SIGNAL/QUERY/TIMELINE_SIGNAL/WAIT/TIMELINE_WAIT/EVENTFD/HANDLE_TO_FD/FD_TO_HANDLE`. One timeline watermark per syncobj; binary userspace is point 1. `TIMELINE_WAIT`: absolute `CLOCK_MONOTONIC` deadline, expiry `ETIME`; `WAIT_AVAILABLE` legal only on the timeline form; `WAIT_DEADLINE` accepted as a hint; empty handle list succeeds; a point neither reached nor backed by a pending retire, without `WAIT_FOR_SUBMIT` (or `WAIT_AVAILABLE` on the timeline form) → `EINVAL`. `HANDLE_TO_FD`: unknown handle `ENOENT`, bad fd / non-sync-file `EINVAL`; an already-reached point exports a signaled file; a future point binds to its retiring device fence. `EVENTFD` waiters are signalled by `TIMELINE_SIGNAL` and by the retire pump. `SYNCOBJ_TRANSFER` is not implemented. |
| `GET_CAP` | `DRM_CAP_SYNCOBJ` (0x13) and `DRM_CAP_SYNCOBJ_TIMELINE` (0x14) = 1 — what makes Mesa's DRM sync provider pick the kernel path; the values must match the UAPI headers userspace was built against. |

## 6. Verification matrix

- **Host unit tests** (`drivers/gpu/virtio-gpu`, fake transport): boundary
  notify, queue-full parking, bounded waits, fence watermark advance.
- **QEMU system regressions** (`cargo xtask starry test qemu -c
  test-suit/starryos/qemu/system/...`): `drm-test-drm-atomic` (KMS +
  deferred-release path) and the new `drm-test-syncobj` conformance suite
  (53 checks against Linux `drm_syncobj.c` semantics, host-3D-free),
  validated bidirectionally — the predecessor implementation failed 14
  checks before the UAPI alignment fixes.
- **venus e2e** needs the darwin-venus host stack (venus-enabled QEMU with
  blob hostmem and a MoltenVK renderer); CI cannot cover it. There the
  21-step `vkprobe` (Vulkan init, BAR round-trip, timeline fence, fenced
  compute readback 4/4) passes, and the desktop e2e four criteria hold —
  flip counter growing, screendump distinct-pixel count ≈ 61k at 1280×800,
  cross-time pixel diffs, `unavailable_output_ticks = 0`.

## 7. Known limitations

- `FENCE_FD_IN/OUT` are rejected on a venus `EXECBUFFER`; virgl keeps them.
- `DEFER_MAPPING` does not defer anything (§5 tradeoff).
- The retire pump is ioctl-driven: a client that registers an eventfd and
  never issues another syncobj ioctl may wait on a completion nobody
  pumps. Mesa keeps querying and waiting, so it is unaffected; a pure
  eventfd client would stall.
- No cross-device blobs (`CROSS_DEVICE` rejected, `GETPARAM` = 0; needs
  `RESOURCE_UUID`/`RESOURCE_ASSIGN_UUID`), no EDID, no cursor queue, single
  scanout driven by the driver (`SCANOUT_ID` 0 boot path).
- `DRM_IOCTL_SYNCOBJ_TRANSFER` is not implemented; `unmap_blob` is
  fire-and-forget, so a host rejection is only logged while the guest slot
  is still recycled (§4 ordering argument).
