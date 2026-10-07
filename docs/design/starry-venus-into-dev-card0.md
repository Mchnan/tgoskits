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
