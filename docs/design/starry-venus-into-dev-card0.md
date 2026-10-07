# venus 面接进 dev card0：增量移植与端到端复测（2026-10-07）

## 背景与结论

9-24 轮把 venus 面整体换装到 dev tip（分支 `local/venus-dev-0923`），内核面闭环
（vkprobe PASS、2D 桌面无回归），但换装的代价被 dev 自带 DRM 用例量化：modeset
69/16、atomic 90/35、perbuf-dumb 40/1 —— 失败项全是 dev 新 card0 的语义
（per-fd GEM 句柄、更新的属性/校验语义）。当时给出的结论是：venus 要进 dev，
应当反过来把 venus 面接进 dev 的 card0，而不是整体换装。

本轮做的就是这件事，并且闭环验证了：

- **vkprobe 21 步全绿**（含 BAR pattern round-trip、compute 读回 4/4），在
  dev tip + 增量 venus 面的内核上；
- **dev 自带 DRM 用例全绿**：modeset 125/0、atomic 85/0、version 14/0、
  perbuf-dumb 41/0 —— 换装路线丢掉的语义全部保住了；
- **2D 桌面无回归**：1280x800 锁屏 100% 非黑，两次截图相差 8313 字节（时钟在走）。

## 改动清单（全部为增量，无整体替换）

### 驱动 crate `drivers/gpu/virtio-gpu`（dev 原驱动上扩展）

- `wire.rs`：新增 `SET_SCANOUT_BLOB`、`RESOURCE_MAP_BLOB`、
  `RESOURCE_UNMAP_BLOB`、`OK_MAP_INFO`、错误响应码、
  `CtrlHeader::with_fence_ring`（`INFO_RING_IDX` 与 fence 同置，ring fence 的
  Linux 语义）、`command()` 访问器；`BLOB_ALIGNMENT` 特性位；ABI 尺寸断言。
- `device.rs`：控制队列从“单请求同步往返”改为 **pending FIFO + 按 token 匹配
  响应**——fenced 提交的响应宿主会推迟到 fence retire，队列必须能容纳失序
  完成。fenced `SUBMIT_3D` 为 fire-and-forget（条目持有自己的 header/payload/
  recv DMA 缓冲），同步命令继续走 scratch page。新增 hostmem 区域、
  `map_blob`/`unmap_blob`/`set_scanout_blob`/`disable_scanout`/
  `bind_2d_scanout`、`submit_3d_deferred`/`submit_3d_unfenced`、`info()` 快照。
  所有方法改 `&self` + 内部 Spinlock，一个设备可经 `Arc` 同时发布给显示适配器
  与内核 `VIRTGPU_*` 面。dev 的 2D/virgl 全部 API（framebuffer、逐资源 scanout、
  capset、context、transfer、guest-backed blob）原样保留。
- `lib.rs`：新增 `VirtioGpu3D` trait 与 `register_global_3d`/`global_3d`
  进程级注册表——内核 DRM 层经 trait 句柄工作，不感知 transport/HAL 类型。
- `error.rs`：补 `QueueFull`/`OutOfMemory`/`DeviceError(u32)`/`DeviceFault`，
  承载失序队列与宿主错误响应。

### 探针与适配层

- `drivers/ax-driver/src/pci/mod.rs`：解析 PCI `SHARED_MEMORY_CFG`（cap64）
  厂商能力，重建 BAR 物理地址，新增
  `take_virtio_transport_masked_with_shm`（shm_id 过滤）。
- `drivers/ax-driver/src/virtio/display.rs`：`VirtIoGpu` 改持有 `Arc`；
  probe 时把 hostmem 交给 3D 面并 `register_global_3d`；2D scanout 不可用时
  （venus-only darwin renderer 无 vrend，`Gpu3DError(22)`）降级 3D-only、不注册
  display 设备（否则 axdisplay 适配器 panic），3D 面照常发布。

### 内核 `os/StarryOS/kernel`

- 新模块 `pseudofs/dev/vgpu.rs`（1213 行）：venus `VIRTGPU_*` 家族
  （GETPARAM/GET_CAPS/RESOURCE_CREATE_BLOB/RESOURCE_INFO/MAP/EXECBUFFER/
  GEM_CLOSE/PRIME）+ 通用 syncobj 家族（CREATE/DESTROY/WAIT/RESET/SIGNAL/
  TIMELINE_WAIT/QUERY/TIMELINE_SIGNAL），状态按 **file_id**（per-fd，与 dev
  card0 的 per-fd GEM 模型一致）；blob 直接映射 hostmem BAR（16 KiB 槽位对齐，
  适配 macOS 宿主 16K 页/hvf EPT 子区约束）；fenced EXECBUFFER 提交后即置位
  out-syncobj（v1 同步语义，fence=完成 的缺口记录在案）；`VgpuBlobFd`
  dma-buf 替身 fd 供 PRIME/gbm 走通。
- `pseudofs/dev/drm.rs`：UAPI 补齐——syncobj 全族 ioctl 号与结构、
  `DRM_CAP_SYNCOBJ(0x13)`/`DRM_CAP_SYNCOBJ_TIMELINE`(**0x14**，必须与用户态
  编译所对的 UAPI 头一致，写错值 mesa 会静默降级 sync-file 路径)、
  `DRM_VIRTGPU_BLOB_FLAG_HINT_DEFER_MAPPING`、`MAP_CACHE_*`、
  blob 结构的 v6.15 `blob_hints` 尾部（ioctl 号编码结构大小，48B 旧布局的
  编号永远落不进 handler）。
- `pseudofs/dev/card0.rs`：增量接线——CONTEXT_INIT 识别 capset 4 并走 vgpu 面
  （VIRGL/VIRGL2 继续 axdisplay virgl 路径，两条 face 共享 ctx-id 分配器）；
  capset 查询/GETPARAM 在 3D 设备在位时路由到 vgpu（venus-only 宿主没有
  display 设备，axdisplay 的 has_virgl() 会误报）；blob 句柄进 ADDFB2 得到
  `FbBacking::Blob`，present 走 `SET_SCANOUT_BLOB` 零拷贝路径；dumb present
  先重绑 2D scanout（混装设备）；`clear_scanout`/Drop 清理 blob 面状态；
  `PhysicalCachedResolved` mmap 变体承载 BAR 映射（blob mmap 键从 2^40 起，
  与 dumb offset 键空间不相交）。
- `syscall/mm/mmap.rs` + `pseudofs/device.rs`：`DeviceMmap::PhysicalCachedResolved`
  （offset 是选择器、内存可缓存——venus hostmem 上要跑原子 RMW 环形缓冲）。

## 验证

- `cargo xtask starry build -c os/StarryOS/configs/board/qemu-aarch64.toml --smp 4`
  全绿；`cargo xtask clippy --package starry-kernel` 18/18 aarch64 检查通过
  （loongarch/riscv 的 `lwprintf-rs` build.rs 需要 Linux `gcc`，基线分支同样
  失败，属 macOS 宿主环境缺口）；`cargo fmt` 已跑。
- venus 栈（自建 QEMU + `virtio-gpu-gl,blob=true,venus=true,hostmem=256M`，
  MoltenVK 渲染服务端）：注入版 vkprobe `=== VKPROBE PASS ===`——枚举
  `Virtio-GPU Venus (Apple M4)`、HOST3D blob + BAR mmap + pattern 往返 MATCH、
  compute 提交、timeline fence 等待、fence 后窗口内读回 4/4。
- 2D 栈（brew QEMU + cocoa）：四个 DRM 用例干净 guest 实跑
  modeset 125/0、atomic 85/0、version 14/0、perbuf-dumb 41/0；deniald + llvmpipe
  桌面 1280x800 100% 非黑、跨截图 8313 字节时钟差。
- A/B 对照：venus 换装分支内核在同一栈上同样 PASS，排除“本轮改动引入回归”的
  可能。（排查期间一度 FAIL 的真实原因是 rootfs 里旧的 `/opt/vgpu/vkprobe`
  没有窗口钩子——失败读数是已知 fence 提前 retire 缺口的旧形态，不是本轮回归。）

## 排查记录（给下一轮的坑）

1. **GET_CAP 值必须对齐用户态头文件**。本仓库 musl sysroot 的
   `drm.h` 里 `DRM_CAP_SYNCOBJ_TIMELINE` 是 **0x14**；凭记忆写 0x1a 会让
   mesa 的 `util_sync_provider_drm` 拿不到 timeline 能力，EXECBUFFER 静默改走
   `FENCE_FD_OUT` 同步路径，在 venus 上直接 DEVICE_LOST（宿主把 fenced 响应
   推迟到 retire，同步等待必卡）。
2. **blob 结构要用 v6.15 布局**（56B 带 `blob_hints`）：ioctl 号编码结构大小。
3. **栈文件会过期**：venus 栈脚本 grep 的 `root@starry` 提示符在 dev tip 的
   `init=/bin/sh` 直启下是 `/ #`；`/tmp` 探针工具在会话间会被清掉，脚本是
   可重建的（本文件 + §9.11 的记录足够）。
4. **对照实验要控制变量**：先怀疑自己的内核之前，先确认栈上其他组件
   （QEMU、rootfs 里的探针二进制）没有漂移。QEMU 源树带本地提交
   （darwin-venus 分支，含 pixman blob scanout / hvf unaligned 段跳过），
   重建 QEMU 前先 `git status`。

## 遗留

- fence 语义缺口不变：内核在 submit 返回即置位 out-syncobj，宿主 vkr 在 ring
  解析时逐命令推进 seqno，两端都不覆盖 Metal 完成（上一轮 §9.11 的账）。
- 桌面级 venus e2e（deniald + zink）未跑：本轮交付的是内核面接装 + 内核面
  验证；桌面握手停摆是上一轮收敛出的独立问题（引擎/合成器握手，非内核）。
- TEMP-PROBE 仪表已全部拆除（本轮排查用的 ioctl trace 在提交前移除）。
