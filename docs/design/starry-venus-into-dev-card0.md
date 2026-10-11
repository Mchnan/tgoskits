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

## 复测闭环补记（2026-10-07，Phase 42 收尾）

四项遗留待办在本轮收敛三项半：

1. **deniald 桌面 panic 根因修复（venus-only 下 axdisplay 全入口守卫）**。
   桌面级 e2e 首跑发现 deniald 启动即把内核打 panic（`LazyInit<RawSpinLock
   <ErasedDisplayDevice>>` 未初始化解引用，ax-lazyinit lib.rs:241）——不是
   上一轮收敛的"引擎/合成器握手停摆"，而是 venus-only 探测（2D 面不可用、
   display 设备不注册）下 `MAIN_DISPLAY` 永不初始化，而 axdisplay 的
   `framebuffer_*`/`gpu3d_*` 转发全部直接 `lock_irqsave()` 解引用，任何
   userspace 触发路径（deniald 经 smithay/gbm 的任意调用序）都能打死内核。
   修复：axdisplay 28 个入口全部改为 `MAIN_DISPLAY.get()` 判空降级——
   `framebuffer_info` 返回零尺寸占位、`framebuffer_flush` 返回 false、
   `DisplayResult` 系返回 `NotAvailable`、`has_virgl`/`has_resource_blob`/
   `has_context_init` 返回 false。fb0 的 `FrameBuffer::new` 另加断言防回归。
   修复后 deniald 在 venus 栈上稳定运行（Volition output scheduler 每 2s
   一拍、presentations=1、missed_vblanks=0、无 backing-store 错误循环），
   Dart 引擎 `frames=0`（shell 内容未上屏）是**引擎 raster 层的下一个独立
   问题**，内核面已闭环。
2. **syncobj 语义对齐 Linux + 补 `DRM_IOCTL_SYNCOBJ_EVENTFD`**。实测抓到
   两个 UAPI 偏差：(a) syncobj 原挂在 `VgpuFd`（CONTEXT_INIT 才存在），
   任何无 context 的 fd 上 CREATE 都 EINVAL——Linux 里 syncobj 是 per-fd
   GEM 级对象、与 context 无关；现挪为 `Vgpu` 的独立 per-fd 表
   `(file_id, handle)` 键控，CREATE/DESTROY/WAIT/QUERY/SIGNAL 全族不再
   要求 context，`close_fd` 无条件回收（Linux `drm_release` 语义）。
   (b) mesa 25.2 的 `util_sync_provider_drm` 用 `SYNCOBJ_EVENTFD`（0xCF，
   v6.7 UAPI）注册完成唤醒，此前落入 unsupported 分支返回 ENOSYS；现已
   实现（点已 signal 立即 `signal_kernel(1)`，未到点登记进 `SyncobjState.
   eventfds`，EXECBUFFER/TIMELINE_SIGNAL 推进水位时统一唤醒）。
3. **grouped system 等效回归 + 无跨用例状态泄漏**。`cargo xtask starry
   test qemu -c qemu/system` 在 macOS 缺 qemu-user 跑不起来（上一轮已
   确认的环境限制），按上轮口径把四个 DRM 用例交叉编译注入干净 guest
   直跑：modeset 85/0、atomic 125/0、version 14/0、perbuf-dumb 41/0
   （合计 265/0；与接装分支首跑记录合计一致，modeset/atomic 数值为同一
   套件的两次统计口径差），**换装分支的 69/16、90/35、40/1 缺口全部为
   零**——dev card0 per-fd/属性/KMS 语义完整保留的实证；modeset 复跑
   85/0 一致，无跨用例状态泄漏。
4. **换装分支 `local/venus-dev-0923` 正式退役**：其研究文档
   （`docs/research-host-vulkan-acceleration.md`）§9.11/§9.11.1 与 §9
   的对照数据保留作历史证据，不再作为 venus 进 dev 的载体；后续 venus
   工作全部基于本分支的接装形态。
5. **仍遗留**：fence 完成语义（内核 submit 即置位 + 宿主 vkr ring 解析
   即推进，两端都不等 Metal 完成——上一轮 §9.11 的账，本轮的 EVENTFD
   唤醒链为未来接入真实 retire 事件留好了口子）；deniald Dart 引擎
   `frames=0`（skia/Impeller raster 层，独立问题）。

## zink 加速推进补记（2026-10-08，第三轮）

目标「加速桌面到 60Hz」的内核侧路径在本轮打通到 Flutter output pools
导入，剩余阻塞收敛到 deniald 用户态。

**内核四组增量（9 文件 +288/−20）**：

1. **legacy `DRM_IOCTL_MODE_ADDFB`（0xAE，28B `drm_mode_fb_cmd`）**。
   zink 分配的 gbm buffer 让 smithay 走 legacy ADDFB 入口，此前只有
   ADDFB2，命令字 0xc01c64ae 落 unsupported 返回 ENOTSUP(95) 直接打死
   deniald。实现为 28B 结构到 ADDFB2 核心的合成（bpp/depth 映射到
   fourcc，未知组合按 Linux 语义 EINVAL），`add_fb2_core` 与两条入口
   共用一套注册路径；命令字有单元断言。
2. **PRIME 跨 fd 导入别名（Linux per-fd 句柄语义）**。`PRIME_FD_TO_
   HANDLE` 此前把创建者的 bo_handle 原样返回给导入方，而 vgpu 资源表按
   `owner`（file_id）过滤，跨 fd 导入必落「no backing」EINVAL。现改为
   在导入方名下克隆资源条目（同宿主资源、同 BAR 窗口、新 GEM 句柄，
   `imported` 标记），GEM_CLOSE/close_fd 对导入条目只释放本地引用、
   不 unmap 宿主 BAR 槽不 unref 宿主资源——与 Linux dma-buf 导入引用
   语义一致（perbuf-dumb "handle is private to one open file
   description" 正是这条语义）。
3. **`SYNCOBJ_HANDLE_TO_FD` sync file 导出/导入**。zink 的 EGL
   native-fence 路径经 mesa venus 用 **24 字节（带 timeline point 的
   `drm_syncobj_handle`）** 导出 sync file（0xc01864c1），旧 16B 结构
   因 ioctl 号编码结构大小而根本路由不进；无此导出时 deniald 的
   output-pool buffer 生命周期失去 fence，present 目标耗尽、屏幕全黑。
   实现于 vgpu syncobj：已到点导出立即 signaled，未来点登记
   `SyncobjState.sync_files`、水位推进时统一 `mark_signaled`；
   `FD_TO_HANDLE` 支持已 signaled 的导出文件导入（pending 文件按
   Linux 无异步完成路径的语义拒绝）。
4. **栈环境考古**：QEMU 宿主侧需要 `qstart-alpine.sh` 的三件套
   （`VK_DRIVER_FILES`/`VK_ICD_FILENAMES` 指向 MoltenVK ICD、
   `DYLD_LIBRARY_PATH=/opt/homebrew/lib:.../prefix/lib`），否则
   virgl_render_server `dlopen(libMoltenVK.dylib)` 失败，guest 侧
   venus 一律 VK_ERROR_OUT_OF_HOST_MEMORY——vkprobe/deniald 全灭。
   guest 侧需要上一轮 venus 分支脚本集（venus-stack/mirror/
   start-denial-zink*.sh）里的 `MESA_GLES_VERSION_OVERRIDE=3.2`、
   `GALLIUM_DRIVER=zink`+`MESA_LOADER_DRIVER_OVERRIDE=zink` 双开关、
   `/root/.drirc` 的 `venus_implicit_fencing=true`。

**验证**：vkprobe 21 步 PASS；DRM 四用例干净 guest 直跑 265/0
（modeset 85/0、atomic 125/0、version 14/0、perbuf-dumb 41/0，
modeset 复跑一致）——三组 UAPI 增量对 dev card0 语义零回归；
clippy aarch64 18/18、fmt 干净（loongarch/riscv 仍是 lwprintf 需
Linux gcc 的已知环境缺口）。

**zink 桌面推进与剩余阻塞**：`GL Renderer: "zink Vulkan 1.4
(Virtio-GPU Venus (Apple M4) (MOLTENVK))"` 全部四个 GLES 3.2 上下文
（compositor/screencopy/Flutter raster/resource）创建成功，
linux-dmabuf v4 + native fence 上线，Flutter output pools（buffers=3）
成功导入 Flutter EGL 上下文——**这是 dev card0 内核上加速桌面第一次
走到这一步**。剩余阻塞全部在 deniald 用户态：(1) shell 子进程在
VA:0x15c SIGSEGV（llvmpipe 时期同形态，非本轮引入，但 zink 下死得更
早，`render_requests` 恒 0）；(2) output target unavailable，池状态
`[(Free,1),(Rendering,0),(Free,0)]` 有一个 buffer 卡 Rendering；
(3) 屏幕未出画，60Hz 帧率无法测量。Impeller 路径另有
`GL_FRAMEBUFFER_UNSUPPORTED`（status 0x8CD6，Apple GPU/MoltenVK 不支持
D24_UNORM_S8_UINT——宿主直查 `vkGetPhysicalDeviceFormatProperties`
为 0——Impeller stencil 附加失败）；`--flutter-offscreen-blit` 模式被
gbm modifier=Invalid 卡住（`gbm_bo_create_with_modifiers2` 在本栈
EINVAL）；`--flutter-renderer skia` 模式走通 pools 导入后死于上述
shell 子进程崩溃。下一手是 deniald 侧：mini-strace/ptrace 取
0x15c 崩溃栈，以及排查 Rendering 池 buffer 的 fence 释放路径。

## 引擎 present 跳过根因闭合（2026-10-08，第五轮，denial 源码到位）

用户指认 deniald 源码在 `~/denial`（main@85b2303，工作树带本地诊断仪表与
open_gl.rs 软件 fence 兜底）；tgoskits 其他分支（local/venus-dev-0923）的
AGENTS.md §3 含 9-24 时代的完整调试记忆。基于源码把黑屏根因闭合：

1. **输出槽状态机**（`output_pipeline.rs`）：`Free→Rendering→Ready→Pending
   →Free`；`target_available()` 要求授权空闲 + **全部 slot Free** + 存在
   `output_refs==0` 的 Free——单个卡 Rendering 的 slot 即永久断供；
   `mark_ready` 盖当前事务号，`finish_transaction`（raster_idle 哨兵）只收
   集戳号相等者；`begin_transaction` 只回收 Rendering+无引用。
2. **volition-kms 的 futex 停等是正常空闲**：它是 sync_channel 作业
   worker，`recv()` 阻塞属预期——9-24 记忆「volition-kms 卡 futex」的
   死锁结论修正为「空闲误读」；判定基准是 llvmpipe 对照。
3. **实测定锤**：`output target authorized: 12`（授权在发）、
   `present_callback_avg_us=0.0`（llvmpipe 790µs——引擎从未调用 root
   present）、一次 `nested Flutter output presentation`（ext-view 在
   pending 未消费时再触发→返回 false→引擎放弃出帧）、槽稳态
   `(Rendering,0)`（每 tick 重授权重 acquire、present 永不来）、
   mark_ready 零失败、fence 导出全部 signaled、真实 ATOMIC 成功。
   **deniald 状态机与内核 UAPI 全部正常；断点在引擎内部：ext-view 之后、
   present-with-info 之前被跳过。**
4. **待验证假设**：引擎在 zink 上的 FBO/外部纹理校验静默失败（与 Impeller
   的 `GL_FRAMEBUFFER_UNSUPPORTED` 同族——MoltenVK/Apple M4 无
   D24_UNORM_S8_UINT，Impeller stencil 附加失败的 skia 静默版），使引擎
   丢弃帧而不调 present。验证需 instrument Flutter fork 的
   present-with-info 路径——fork 在 Linux 构建机
   `/mnt/exty/denial-flutter-fork-3.44.7`，本机不可达；远端验证主机
   192.168.1.18/.183 可作部署目标。
5. **60Hz 结论**：llvmpipe 4 线程 raster 实测 20–32ms/帧超 16.6ms 预算
   （上限 <40fps），60Hz 必须 zink；调度节拍 60Hz、管线与内核链路均就绪，
   引擎 present 链修复后立即可测。

## 端到端复测：present 链复活与 Rendering 卡槽复发（2026-10-08，第六轮）

第六轮在 StarryOS dev card0 + venus + zink + skia 全栈上端到端复测了
Phase 42 的 `--denial-gl-fbo-zero-is-no-target` 无条件传递修复。结论：
**修复生效，引擎 present 链五轮以来首次复活；但出帧 3 秒共 3 次后，
(output, buffer 1) 卡 `(Rendering,0)` 复发，授权断供停摆**。

### 复测证据（全部来自 deniald 自身 render_audit）

- **present 回调复活**：`present_callback_avg_us=1271.5`
  （第一轮 audit 16455.8 是首个首帧冷启动值；第五轮记录的基线是 0.0——
  引擎从不调用 root present）。presented_outputs=2。
- **输出管线全链路活跃**：`ready_published=3 ready_with_fence=3
  fence_signals=3 real_submissions=3 volition_scheduled_submissions=3
  presentations=3`；`missed_vblanks=0`。
- **zink GPU raster 真实出力**：`gpu_render_samples=1
  gpu_flutter_render_avg_us=7.4 gpu_scanout_blit_avg_us=4.3
  gpu_frame_avg_us=11.7 gpu_timer_disjoint=1`。
- **活动窗口内帧率**：`presentation_interval_p50=79188µs`（≈12.6fps），
  `deadline_to_presentation_p50=28–37ms`，`target_late_p99=282ms`
  ——离 16.6ms 预算还有约 5 倍差距，且是事件驱动的稀疏帧。

### 停摆形态（00:22:23–25 活动约 3 秒后）

- 00:22:23.358 起 pools 稳态 `[(Free,1),(Rendering,0),(Free,0)]`
  （第 2 个 buffer 借出后永不归还）；`target unavailable` 共 40 次；
  `backing store acquire failed reason="no authorization"`
  （`target_blocked_exhausted`）；`stale_ready: 2`；
  dd.log 在 00:22:25.813 后零增长（六分钟观察）。
- 附带：Xwayland SIGABRT（llvmpipe 时期同形态，非本轮引入）；
  compositor 线程超实时预算被降级一次。

### 根因收敛

第四轮「deniald 状态机与内核 UAPI 全部正常」的结论要加边界：**在
present 从不发生的前提下**成立。present 复活后暴露出新的断点：
**present 后的 buffer release/fence 归还路径**——第 2 个 buffer 在
raster 提交后永卡 Rendering，`target_available()` 的「全部 Free」
条件永久失效。头号嫌疑是内核 syncobj fence 完成语义（submit 即置位
out-syncobj、不等宿主 Metal 完成，§9.11 旧账）与 vkr release fence
未回流 deniald 的组合：deniald 等的 buffer-fence 信号要么永不来、
要么来得太早使回收判据失真。下一手：在 deniald 侧 dump 每个池
buffer 的 fence fd 与 poll 结果时间线，对照内核 vgpu syncobj 的
水位推进记录。

### 栈环境考古（本轮新增，给下一轮）

- **denial-full rootfs 镜像注入的 journal 回滚坑**：镜像带未回放
  ext4 journal 时，debugfs `rm`+`write` 的写入会在下次挂载时被日志
  回放吞掉（表现为「注入成功、引导后回旧」）。先 `e2fsck -fy` 清日志；
  彻底方案 `tune2fs -O ^has_journal` 移除 journal 后注入即稳定。
- **denial-full 镜像缺 mesa vulkan 栈**：zink 需要
  `libvulkan.so.1`（vulkan-loader 1.4.360）+ `libvulkan_virtio.so`
  + `virtio_icd.aarch64.json`（mesa-vulkan-virtio）+ `libgallium`
  26.2.3 + `libLLVM.so.23.1` + libdrm 2.4.134 + `libdisplay-info.so.3`
  ——全部可从 `~/venus-stack/mirror/aarch64/*.apk` 解包注入
  （`tar -xzf` apk 即可）。libdrm 覆盖时注意镜像内文件名是
  `.so.1.131.0` 而 symlink 指向它：把 134 内容写到 131 文件名上，
  别新增 134 文件名。
- **e2e 直启形态**：`init=/root/e2e-run.sh`（镜像内脚本：设
  HOME/zink 环境变量、写 /root/.drirc、后台起 deniald skia、
  watcher 每 30s 把 dd.log 快照 POST 到 10.0.2.2:8000）——绕开
  串口丢字，取证全走 HTTP。
- **arm64 构建 VM（SSH 隧道 :2222）重启命令**（无现成启动脚本，本轮逆向还原）：
  `cd ~/arm64-buildVM && qemu-system-aarch64 -machine virt,highmem=on -cpu host
  -accel hvf -smp 8 -m 12G -drive file=vm.qcow2,if=virtio,format=qcow2
  -drive if=virtio,format=raw,file=seed.iso
  -bios /opt/homebrew/share/qemu/edk2-aarch64-code.fd
  -device virtio-net-pci,netdev=net0
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22
  -display none -serial file:serial-relaunch.log -pidfile vm.pid`，
  SSH 用 `ssh -i ~/.ssh/arm64build -p 2222 build@127.0.0.1`。修复版
  deniald 在 `~/denial/compositor/target/release/deniald`（构建机内），
  拉回后经 staging/guest 树 + `inject-denial-full.py` + debugfs 注入镜像。

## 端到端闭环推进：ring 死亡根因闭合与持续存活（2026-10-10，第七轮）

第六轮的「present 后 Rendering 卡槽」在本轮收敛为**下游症状**；真正的断点是
**宿主 vkr ring 线程在 ~3 秒处死亡**（`vkCreateGraphicsPipelines CS error →
vn_dispatch_command failed → ring exiting ret=-22`），GPU 通道死后 deniald
全线静默。本轮把这一链路修到**桌面持续存活 5 分钟以上**（此前 3–10 秒必停）。

### 根因链（逐环实证）

1. **MoltenVK 偶发拒绝对象创建**：`vkCreatePipelineCache`/
   `vkCreateGraphicsPipelines` 在运行 ~4 秒处以 `VK_ERROR_INITIALIZATION_
   FAILED`（-3）失败（vkr 侧加日志实锤：`id=311 NOT added (ret=-3)`）。
   同型失败的 cache 与引用它的 pipeline 总在同批出现——怀疑 cache 的
   initialData 毒化两者（去 cache 重试路径已备，但失败本身是时序相关的
   偶发，非每轮复现）。
2. **mesa venus 异步创建不读响应**：guest 对 cache 走
   `vn_async_vkCreatePipelineCache`（pipeline 在 target_ring==primary_ring
   时同样 async）——宿主失败对 guest 完全不可见，guest 继续引用幽灵句柄。
3. **宿主查表失败即 fatal**：`vkr_cs_decoder_lookup_object` 落空 →
   `vkr_cs_decoder_set_fatal` → ring 线程退出 → GPU 通道死亡。
4. **deniald 全线静默**：GPU 等待永不完成 → raster 卡死（内核侧
   `syncobj wait spinning timeout=i64::MAX` 实锤）→ 合成器在 phase 51
   （runtime 调用，等引擎锁）停住 → 主循环冻结。心跳线程（独立
   sleep+文件追加）活到进程被人为停止——「日志全停」≠「进程死亡」。

### 修复（两层）

**vkr 兼容层**（`~/venus-stack/src/virglrenderer`，darwin 本地栈）：
- 对象创建失败不再静默：cache 失败绑 `VK_NULL_HANDLE` stub（null cache
  传给 pipeline 创建合法）；graphics/compute pipeline 失败先**去 cache
  重试一次**（疑似 initialData 毒化的针对性处置），仍失败则按捕获的
  guest id 绑 null stub（必须**先捕获 id**——生成的失败路径会把
  `args->pPipelines` 槽位清零，用 0 注册会触发对象表 fatal）。
- `vkCmdBindPipeline` 遇 null 跳过驱动调用并记录绑定状态；
  `vkCmdDraw*`/`vkCmdDispatch*` 在对应 bind point 无 pipeline 时跳过
  转发（防止无效 draw 毒化 command buffer）。
- TEMP-INSTR 日志保留（`vkr-instr:` 前缀）。

**内核 fence 语义**（`local/venus-into-dev-0924` 新增，9 文件之外）：
- §9.11 旧账的正确闭合：`handle_execbuffer` 不再 submit 即置位
  out-syncobj——登记到 `pending_retires`（按设备 fence_id 键控），
  设备层新增 `take_retired_fences()`（drain_completed 弹出 fenced 项时
  收集 retire 的 fence_id），pump 在 execbuffer/wait/query/export 各入口
  统一推进水位并唤醒 eventfds/sync_files。
- **orphan retire 竞态修复**：submit 返回 fence_id 与注册表 push 之间，
  并发 pump 可能先消费该 fence 的 retire 响应——pump 不丢弃未匹配 id，
  暂存 `orphan_ids`，注册时命中立即置位（实测 orphans 里全是 ring kick
  的 fence，属正常无主 retirement）。
- WAIT 循环加 >1s 停滞告警（TEMP-PROBE，含队列/orphan/水位快照）。

### 验证

- ring 存活：`exiting ret=-22` 从每轮必现 → 0；vkr-instr 显示 stub 生效。
- 持续性：心跳从 10 秒级 → **5 分钟+** 连续；dd.log 持续增长；初始帧
  present、flip/release 循环健康；`missed_vblanks=0`。
- 活动窗口帧测量（修复后首轮审计）：`deadline_to_presentation_p50=
  22.2ms`（≈1.3×16.6ms 预算）、`presentation_interval_p50=648ms`——
  事件驱动稀疏帧（无输入无动画的静态桌面），与 llvmpipe 基线同形态。

### 剩余前沿（下一手）

MoltenVK 队列在 ~4 秒后**停止完成 GPU 工作**：vkr-queue sync 线程
`WaitForFences(3s)` 无限重试、fence 131/109/111/113 一代永不 retire
（宿主侧 20/20 seqno wait done 正常、os_log 无 MVK 痕迹）→ guest raster
在 `SYNCOBJ_WAIT(timeout=i64::MAX)` 永旋（内核 TEMP-PROBE 实锤）→
引擎锁被持有 → 合成器 phase=51 冻结。嫌疑集中在该时刻提交的 GPU 工作
引用了失败/替换的对象（stub 前后行为一致，draw 守卫未解开），或
vkr-queue sync 线程与 ring 线程并发进 MoltenVK 的线程安全问题。
下一手：在 vkr-queue sync 线程的 WaitForFences 重试处加日志定位卡住的
fence 所属 queue 与当时在途工作；对照宿主 MoltenVK 直测复现脚本。

### 工程备忘（本轮新增）

- **构建机 lwprintf 环境缺口消失条件**：内核 aarch64 构建需
  `BINDGEN_EXTRA_CLANG_ARGS=--sysroot=<musl sysroot>`（Homebrew musl
  工具链的 sysroot 头文件在 `usr/include`，lwprintf build.rs 传的
  `-I{sysroot}/include/` 落空）；starry-kernel clippy 仍在 loongarch64
  的 lwprintf 处 fail-fast（已知基线缺口，aarch64 由 axbuild 全量编译
  deny-warnings 覆盖）。
- **内核日志级别是编译期参数**：cmdline `log=` 不生效（banner 原样打印
  但无效），由 board toml `log` 字段经 AX_LOG 编译进去；log=Info 会用
  `Enter user space`/task-exit 洪泛串口，取证后记得回 Warn。
- **e2e 取证形态升级**：`init=/root/e2e-run.sh` + 20s watcher HTTP POST
  （dd.log 快照 + 心跳行数 + 审计尾部 + e2e.log/exit.txt）；deniald
  心跳双通道（tracing + `/tmp/deniald-alive.log` 独立文件）+ 主循环
  phase 相位码（10/11/12/13/20/21/22/30/31/40/41/42/51/1000，phase=51
  即 runtime 段互斥等待）。StarryOS procfs 不枚举 `/proc` 根，但
  `/proc/1/comm` 直读可用；`/proc/<pid>` 需已知 pid。
- debugfs 注入后必须回读校验 MD5；`inject-denial-full.py` 的 stdout
  摘要不是命令清单（清单固定写在 `/tmp/debugfs-denial-full.txt`）。

## 黑屏归因与 MoltenVK 内部卡点（2026-10-10，第八轮，Cocoa 现场呈现轮）

第八轮按用户现场提示（Cocoa 窗口黑屏 + llvmpipe 对照组窗口 1280x800、图标不同）
用 Cocoa 直显复现并逐层归因。环境事实先记：对照组是 brew QEMU（图标不同源）
+ 2D virtio-gpu EDID 的 1280x800 模式；venus 栈是自建 QEMU（`~/venus-stack/src/
qemu/build`），venus 模式 640x480——窗口尺寸与图标差异只是二进制与模式集不同。

### 黑屏逐层归因（全部实证）

1. **monitor `screendump` 像素分析**：修复前 100% 纯黑；各修复轮后稳定为
   684 个纯灰 rgb(170,170,170) 像素（固定位置、跨配置不变）——QEMU 的
   blob scanout 零拷贝直读资源内存（`virtio-gpu-virgl.c` 非 GL console 路径），
   所以这就是 scanout 资源的真实内容。
2. **MVK shader 编译失败实锤**：`MVK_CONFIG_LOG_LEVEL=3 +
   MVK_CONFIG_REDIRECT_LOGGING_TO_STDERR=1` 后当场抓获——
   `[mvk-error] VK_ERROR_INITIALIZATION_FAILED: Shader library compile failed`，
   Metal 报 `texture2d<float> sampler [[id(0)]]` 遮蔽 MSL `sampler` 类型，
   下一行 `sampler samplerSmplr [[id(1)]]` 编译失败。skia 的 GLSL uniform
   就叫 "sampler"，旧 SPIRV-Cross 未把 "sampler" 列入 MSL 保留字。
3. **名字来源排除**：vkr 侧对 `vkCreateShaderModule` 做 SPIR-V 调试名剥离
   （OpName/OpMemberName/OpLine 原地压缩，18 个 module 生效）与首字母改写
   （136 处生效）、落盘 SPIR-V 用 python 解析确认失败 module 内 **零处
   "sampler"**、`MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=0` 关参数缓冲——
   错误原样。结论：1.4.2 捆绑的 SPIRV-Cross 对 combined image sampler
   **内部生成** "sampler"/"samplerSmplr" 名字，与 OpName 无关；上游 main
   的 `CompilerMSL::get_reserved_keyword_set()` 已把 "sampler" 与全部
   texture 类型名列入保留字（注释与本轮错误一字不差），**1.4.2 未包含**。
4. **撤掉去 cache 重试**：第二次 `vkCreatePipelineCache` 会把 ring 线程
   卡死在驱动调用内部（失败日志后零解析行、零 retry 日志），比 stub 更
   危险，已回退为直接 null stub 并留注释。
5. **更深的冻结点**：每轮 ~6 秒合成器 phase=1000（dispatch 内）冻结、
   内核 stall 告警 `syncobj 11 等待 queue=[122,124] 永不 retire`，而宿主
   vkr sync 线程**零 3s 超时日志**（dylib 已含日志）→ ring 解析行在冻结
   时刻停止 → **ring 线程卡死在某个 ring 分发的 MoltenVK 调用内部、持有
   queue vk_mutex**，堵死 sync 线程与 fence retire。已排除：跨队列信号量
   风格（`MVK_CONFIG_VK_SEMAPHORE_SUPPORT_STYLE=0` SINGLE_QUEUE 无效）、
   参数缓冲模式。lldb 附加被 macOS 安全策略拒绝，调用级卡点待下轮。

### 本轮落地的 vkr 改动（darwin-venus 本地栈，未提交前状态）

- SPIR-V 调试名剥离 + 首字母改写（保留两种模式待上 with-Xcode 机器复验）
- 小 module SPIR-V 落盘探针（/tmp/spv/）+ OpName 字符串日志
- `vkCreatePipelineCache`/`vkCreateGraphicsPipelines` 失败 null stub 与
  「禁止 retry」注释；`vkCmdBindPipeline` null 跳过；无 pipeline draw/
  dispatch 跳过转发；vkr-queue sync 线程 3s 超时停滞日志
- 结论性修复路径：**在带完整 Xcode 的机器上用上游 main 的 SPIRV-Cross
  构建 MoltenVK**（fetchDependencies 拉取含修复的版本），预期同时消除
  shader 编译失败与（若卡点在被拒 shader 的下游）ring 内部阻塞。

### 现场状态（第八轮收官）

Cocoa 窗口呈现：denial 桌面初始帧（684 灰像素的 shell 起步帧），ring
存活、pipeline 全真（stub=0 的轮次）、初始帧 deadline 17.4ms；内容帧被
MoltenVK 内部卡点挡住。全部仪表（monitor screendump / MVK 日志 / 内核
TEMP-PROBE / vkr-instr / SPIR-V 落盘）就位，第八轮已把黑屏从「不明」
收敛为「上游 SPIRV-Cross 保留字缺失 + MoltenVK 内部阻塞」两件事。

## MoltenVK 重建与 ring 卡点闭合（2026-10-11，第九轮，Xcode 重建轮）

用户装好完整 Xcode 26.3 后按第八轮修复路径执行：clone MoltenVK main
（`67b2682`）→ `fetchDependencies --macos`（SPIRV-Cross pin `aa217aeb`，
L16923 确认 `"sampler"` 在 `get_reserved_keyword_set()`，注释与本轮错误
一字不差）→ 构建 universal dylib。**首轮 e2e 报错与第八轮逐字节相同，
追查出一个比 shader 更深的部署 bug**：

### ICD 部署劫持（本轮最重要的新发现）

独立 ICD json（`VK_DRIVER_FILES` 指向）写出后，render server 仍加载
brew 1.4.2（日志 `MoltenVK version 1.4.2` 实锤，同环境宿主探针却是
1.4.3）。`VK_LOADER_DEBUG=all` 抓到 loader 的 WARNING：**dlopen 绝对
路径时 dyld 把 `@rpath/libMoltenVK.dylib` 标识符解析落到
`/opt/homebrew/lib/libMoltenVK.dylib`（brew 1.4.2）**——触发条件是
DYLD_LIBRARY_PATH 含 `/opt/homebrew/lib`（vkr `dlopen("libvulkan.dylib")`
找 loader 需要它）。A/B 对照：去掉该变量连 loader 都打不开；保留变量则
ICD 绝对路径被劫持。**修复：dylib 复制到 prefix/lib 并
`install_name_tool -id` 改唯一 install name + ad-hoc codesign，json 指向
它**，与 brew 完全脱钩后 1.4.3 正常装载。**教训：本轮之前的「vkprobe
全绿」全部跑在被劫持的 1.4.2 上，不构成 1.4.3 的证据**；换装验证必须
核对日志里的版本行。

### 复测判定（真 1.4.3，uptime 11:18 收官）

- **shader 编译失败归零**：`Shader library compile failed` 第八轮每轮
  必现 → 0；pipeline 全真（`vkCreateGraphicsPipelines` 全部 `added`，
  stub=0）。
- **ring 内部卡点未复现**：第八轮「大概率同源」假设成立——卡点是被拒
  shader 的下游。~6 秒冻结（phase=1000 停摆 + 内核 syncobj stall 告警 +
  vkr sync 线程 3s 超时）全部消失；`vkWaitVirtqueueSeqnoMESA waiting→
  done` 正常 retire，flip 循环（set_scanout_blob res 3↔4）健康。
- **存活**：心跳持续 11 分钟+（第八轮 5 分钟+），`exiting ret=-22` = 0，
  dispatch_seq 780 万持续增长（stale_ms=1，非冻结）。
- **帧预算**：`deadline_to_presentation_p50=14.96ms` **首次进入 16.6ms
  预算**（第七轮 22.2ms）；`presentation_interval_p50≈2.0s`、
  `missed_vblanks=0`——事件驱动稀疏帧形态（无输入静态桌面，与 llvmpipe
  基线同形态），`engine_over_budget=0`。
- **vkprobe 21 步 PASS**（真 1.4.3 重跑）：BAR pattern 往返 MATCH、
  compute 读回 4/4——hostmem blob 路径无回归。

### 黑屏的下一手（重新归因）

scanout 在 1.4.3 上读出 100% 纯黑（第八轮是 684 灰像素的 shell 起步
帧）：**shell 进程本轮 3.5s 处 `SIGSEGV memory fault at VA:0x15c`**
（pid 17，与第三轮记录同址同形态），死在首个 present 之前——空桌面
背景即纯黑，compositor 自身 alive 且在出帧。0x15c 是 pre-existing
guest 侧问题（第三轮 next-step：deniald 侧 mini-strace 取崩溃栈），
与 MoltenVK 无关，成为桌面内容上屏的新阻塞。Flutter 引擎线程
（io.flutter.rast 等）存活，rasterizer 在跑。

### 换装与工具链备忘

- 产物：`~/venus-stack/prefix/lib/libMoltenVK-main.dylib`（unique
  install name）+ `prefix/share/vulkan/icd.d/MoltenVK-main_icd.json`；
  源树 `~/venus-stack/src/MoltenVK`（main@67b2682，含 R9-PROBE 仪表：
  fresh-spv/cache-msl 构造器与 readData initialData/UUID/条目数日志）。
- `qstart-alpine-mvkmain.sh`（vkprobe 用）与 `qstart-denial-e2e.sh`
  （Cocoa e2e 用）均指向新 ICD；后者已修「预删重定向目标」坑（脚本内
  `rm` 会把 launch shell 已打开的 MVK 日志文件变成已删除 inode）。
- e2e watcher 的 POST：busybox `wget --post-file` 会把 URL 基名当响应
  体落盘，`/tmp/snap` 残留后后续 POST 全部 `File exists` 失败——每轮
  实际只有前 1-2 个快照送达，取证读 `/tmp/pulled/snap.*` 即可。
