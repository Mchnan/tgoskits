# 调研：macOS 宿主 Vulkan 渲染加速（denial 桌面帧率下一手）

状态：2026-09-14 调研定稿；2026-09-15 Phase 1 端到端实测通过（见 §6），
同日修复 fence retire 缺口（§6.5），Phase 2 前置条件全部就绪。
背景：`local/dev-desktop-0913` 验证栈已终锤帧率根因——动画期 Dart 帧审计 `raster_avg≈87–127ms`
（guest 内 llvmpipe 软件光栅化，占帧生产 97%），内核全链 <10ms 无责。下一手是
**宿主 GPU 加速**：把 guest 的 3D 渲染转发到宿主 GPU（M4 的 Metal），即 virtio-gpu 3D 加速
（VIRTGPU_* 族）。本文回答"macOS（HVF）上哪条路径可行、三端各缺什么、怎么分阶段验证"。

## 0. 结论（TL;DR）

**在 macOS 宿主上唯一现实的加速路径是 Venus（guest Vulkan → 宿主 Vulkan/MoltenVK），
经 `virglrenderer` 的 darwin 后端落地。** virgl（宿主 GL）与 gfxstream（rutabaga）两条路
在 macOS 上都不成立或成本显著更高。

| 路径 | macOS 可行性 | 一句话理由 |
|------|-------------|-----------|
| **Venus（Vulkan passthrough）** | ✅ 可行，唯一推荐 | virglrenderer 上游显式支持 darwin：`vkr_metal_helpers.m`（2026-04 新增）用 `vkExportMetalObjectsEXT` + shm mmap + `MTLBuffer` 导入解决外部内存；MoltenVK 已支持 `VK_EXT_external_memory_metal` |
| virgl（OpenGL passthrough） | ❌ 不可行 | libepoxy 在 darwin 上禁用 EGL/GLX（`meson.build` 显式排除）；brew 的 virglrenderer 在 macOS 只能建 `NO_VIRGL` 空壳上下文；Apple GL 已弃用且上限 4.1，virgl GL 后端没有可用宿主 GL 窗口系统 |
| gfxstream（rutabaga 后端） | ⚠️ 不推荐 | QEMU `virtio-gpu-rutabaga` 需 `rutabaga_gfx_ffi`（macOS 构建支持不明）；guest 需 mesa `gfxstream` 驱动（Alpine 无包，须自编）；仅剩 Linux/Android 生态 |
| DRM native context | ❌ 不适用 | 上游仅面向 Linux 宿主的具体 DRM 驱动（amdgpu/i915/panfrost…），macOS 无对应 DRM 驱动 |

## 1. 证据链（逐条可复核）

### 1.1 virglrenderer 上游明确支持 darwin 且专为 Venus 做了 Metal 互操作

- `virglrenderer meson.build`：`with_host_darwin = host_machine.system() == 'darwin'`；
  EGL 分支在 darwin 上不需要 gbm（Linux 才要求）。
- `src/meson.build`：`if with_venus … if with_host_darwin: virgl_sources += ['venus/vkr_metal_helpers.m']`
  —— 专门为 macOS 编入 Objective-C Metal 帮助层。
- `src/venus/vkr_metal_helpers.m`（2026-04，作者 Lucas Amaral）：
  - `vkr_metal_get_device()`：`vkExportMetalObjectsEXT` 取 `MTLDevice`；
  - `vkr_mtl_shm_alloc()`：`os_create_anonymous_file` + mmap，再
    `[device newBufferWithBytesNoCopy:shm_ptr]` 把同一块共享内存包成 `MTLBuffer`
    （MTLStorageShared，host CPU 与 GPU 看同一页——正是 Venus host-visible 内存需要的语义）。
- `src/venus/vkr_device_memory.c`：host-visible 内存分配时若宿主支持
  `VK_EXT_external_memory_metal`，走"shm + MTLBuffer 导入"
  （`VK_EXTERNAL_MEMORY_HANDLE_TYPE_MTLBUFFER_BIT_EXT`），不需要 dma-buf/opaque-fd。

⇒ Venus 的宿主侧两大拦路虎（外部内存导出、共享内存一致性）在 macOS 上都有上游实现。

### 1.2 MoltenVK（宿主 Vulkan）具备所需扩展

MoltenVK `Docs/Whats_New.md` 明确包含 `VK_EXT_external_memory_metal`（另有
`VK_EXT_external_memory_host`、`vkExportMetalObjectsEXT`、`VK_KHR_external_memory_*`）。
Homebrew 有 `molten-vk` formula；brew 的 mesa formula 甚至以 `-Dmoltenvk-dir` 引用它，
属受维护的常规依赖。

### 1.3 QEMU 侧：设备存在但 brew 包没编进去，且加速后端官方宿主支持表只写了 Linux

- QEMU 11 文档（system/devices/virtio/virtio-gpu）：3D 后端只有两种——
  `virtio-gpu-gl`（virglrenderer：virgl GL / venus / DRM native context）与
  `virtio-gpu-rutabaga`（gfxstream）。Venus 的 QEMU 形态：
  `-device virtio-gpu-gl,hostmem=…,blob=true,venus=true`。
- blob 的 guest 侧映射（`RESOURCE_MAP`）在 `hw/display/virtio-gpu-virgl.c` 走
  `virgl_renderer_resource_map` + QEMU memory region——底层是 POSIX mmap/shm，
  不绑定 KVM 专有机制，darwin/HVF 原则上可行（文档宿主要求表只列 Linux 6.13+，
  属"上游只测了 Linux"，不是机制性排除；这是本项目要自证的点）。
- 本机 brew QEMU 11.0.3：`-device help` 只有 `virtio-gpu-pci/device`（2D），
  **无 virtio-gpu-gl、无 rutabaga**；brew qemu formula 不依赖 virglrenderer。
  → 需要源码构建 QEMU（`-Dvirglrenderer=enabled -Dopengl=enabled`，opengl=epoxy，
  darwin 上 epoxy 仅 GL 也可满足 meson 依赖）。
- brew 的 virglrenderer 1.3.0 formula 有 macOS bottle（可装），但未开 `-Dvenus`
  且本机 libepoxy 无 EGL → 该包对本任务没用，**宿主 virglrenderer 必须源码构建
  `-Dvenus=true`**（需要 Objective-C 编译器 + Metal framework + 动态加载的 Vulkan
  loader/MoltenVK）。

### 1.4 Guest 侧现状（rootfs 实测，debugfs 只读检查）

- `rootfs-aarch64-denial-full.img` = Alpine 系（gcompat 垫片跑 glibc deniald），
  **mesa 25.2.7 纯 GL 栈**：`libgallium-25.2.7.so`、`/usr/lib/dri/libdril_dri.so`、
  libEGL/libGL/libGLESv2、libgbm。
- **没有任何 Vulkan ICD**（`/usr/share/vulkan` 为空，无 libvulkan）——Flutter 的
  "Impeller rendering backend" 目前实际跑在 GL（llvmpipe）上。
- Alpine **edge 有现成 aarch64 包 `mesa-vulkan-virtio`**（venus ICD）；
  v3.22 没有。要么换 edge 包，要么自编 mesa `-Dvulkan-drivers=virtio`。
- venus 驱动还要求 guest 内核 virtio-gpu 驱动宣称 5 个 param：
  `3D_FEATURES / CAPSET_QUERY_FIX / RESOURCE_BLOB / HOST_VISIBLE / CONTEXT_INIT`
  （mesa 文档口径，对应 Linux ≥5.16 的 virtio_gpu 驱动能力集）。

### 1.5 Guest 内核侧现状（StarryOS，本仓库）

- `os/StarryOS/kernel/src/pseudofs/dev/card0.rs` 是 **simpledrm 类 KMS 仿真**：
  CREATE_DUMB/ADDFB2/SETCRTC/PAGE_FLIP/MODE_ATOMIC + 合成 vblank，present 是
  memcpy 进 axdisplay scanout（再由 virtio-drivers 的 2D 协议刷给 QEMU）。
  **全仓库没有 VIRTGPU_* 用户态 ioctl 族**（上轮审计的三条 ENOSYS 探针即此）。
- 2D virtio-gpu 协议在外部 `virtio-drivers` crate（`VirtIOGpu` 2D：transfer_to_host_2d /
  resource_flush），axdisplay 仅消费其 framebuffer。
- ⇒ guest 内核侧缺的是一整套**真实 virtio-gpu DRM 驱动的 3D 面**：
  VIRTGPU_GETPARAM / GET_CAPS / RESOURCE_CREATE_BLOB / MAP / UNMAP /
  CONTEXT_INIT / EXECBUFFER（命令提交）、hostmem BAR 的 ioremapp+userspace 映射、
  blob 资源生命周期与 fence/事件队列。这是本项目最大的一块工程量，但范围清晰
  （Linux `drivers/gpu/drm/virtio/` 的一个子集）。

## 2. Venus 端到端链路（目标形态）

```
deniald(Flutter/Impeller, Vulkan) ── mesa venus ICD ── VIRTGPU_EXECBUFFER
  │                                                        │
  │ StarryOS 内核: virtio-gpu DRM 驱动（3D ioctls + blob + hostmem BAR 映射）
  │                                                        │
  ▼                                                        ▼
QEMU virtio-gpu-gl(venus=true,blob=true,hostmem=…) ── virglrenderer(-Dvenus=true)
  │                                                        │
  ▼                                                        ▼
  cocoa 显示（2D scanout 不变）                MoltenVK → Metal(GPU) 渲染
  （vkr: shm mmap ⇄ MTLBuffer(bytesNoCopy)，渲染结果页级共享回 guest）
```

呈现路径保持现有 2D KMS/scanout（venus surfaceless 模式渲染进共享内存，再经现有
present 链刷屏）——与现在 card0 的"提交即同步呈现"语义吻合，显示管线不动。

## 3. 分阶段验证路线（关键：vtest 免内核先验）

1. **Phase 0（宿主纯本机，半天级）**：`brew install molten-vk`，`vulkaninfo`
   确认 `VK_EXT_external_memory_metal`、`vkExportMetalObjectsEXT`、Vulkan 1.2+。
2. **Phase 1（宿主 renderer + guest vtest，免 guest 内核）**：
   - 源码构建 virglrenderer `-Dvenus=true`（darwin）；构建带 `virtio-gpu-gl` 的 QEMU。
   - 宿主跑 `virgl_test_server --venus`；guest 装 Alpine edge `mesa-vulkan-virtio`，
     `VK_DRIVER_FILES` 指向 venus ICD + `VN_DEBUG=vtest` 走 socket 到宿主 server，
     在 guest 内 `vulkaninfo`/`vkcube`——**完全绕过 guest 内核驱动**，先定锤
     "宿主渲染 + guest ICD"两端可用性与 MoltenVK 兼容性。
   - vtest 与内核路径共享同一 venus driver 与 renderer 协议，Phase 1 失败则尽早止损。
3. **Phase 2（guest 内核 virtio-gpu 3D 面）**：StarryOS 实现上述 VIRTGPU_* 子集
   （GETPARAM/GET_CAPS/RESOURCE_CREATE_BLOB/MAP/CONTEXT_INIT/EXECBUFFER +
   hostmem BAR 映射 + 事件队列），QEMU 侧切
   `-device virtio-gpu-gl,hostmem=…,blob=true,venus=true`，`vulkaninfo` 走真设备。
4. **Phase 3（deniald 集成 + 帧率审计）**：deniald 的 Flutter embedder 在检测到
   Vulkan ICD 后应自动走 Impeller-Vulkan；用现成「动画 + 即取 dd.log 审计」流程对比
   `raster_avg_us`（目标从 87–127ms 进入 <5ms 量级）与 HMP screendump 差分帧率。

## 4. 风险与未定项

- **QEMU virtio-gpu-gl 在 darwin/HVF 无官方宿主支持记录**（文档表只有 Linux 行）；
  virglrenderer 的 darwin Venus 支持是 2026-04 新代码，成熟度未经验证。Phase 1 就能
  暴露此类问题（renderer 在 darwin 的稳定性）。
- **Venus 的"违规假设"**：mesa 文档自述 renderer 依赖 host-visible 内存可导出并 mmap
  的 spec 违规假设；macOS 路径用 shm/MTLBuffer 绕开 dma-buf，但 MoltenVK 对
  `VK_MEMORY_PROPERTY_HOST_COHERENT_BIT` 的行为需实测。
- **guest 内核工程量**：blob 生命周期、hostmem BAR 映射、CONTEXT_INIT/EXECBUFFER
  队列协议、fence/事件；与现有 card0 KMS 仿真的共存策略（建议演进为"同一设备的
  真实 virtio-gpu 驱动 + 保留 KMS 接口"，避免两个 GPU 设备并存）。
- **deniald 是外部二进制**：其 Flutter embedder 是否接受 venus ICD、Impeller-Vulkan
  所需的 WSI（Wayland surface）在 surfaceless+共享内存语义下的适配，要实测。
- **兜底**：若 Phase 1 失败，可评估（a）lavapipe（仍是软件，收益有限）、
  （b）gfxstream 自编（成本高）、（c）仅优化 llvmpipe 使用方式（内容简化/分块）。

## 5. 建议

按 §3 的 Phase 0→1 先做**宿主与 guest ICD 的免内核先验**（工作量小、可证伪快），
通过后再投入 Phase 2 的 guest 内核 virtio-gpu DRM 3D 面实现；Phase 2 是唯一的大项，
建议在 #2365/#2393 上游合并、验证栈收敛后单独立项。

## 6. Phase 1 实测结果（2026-09-15，端到端 PASS）

### 6.1 Phase 1 改道：vtest 跨 QEMU 边界不可行

原 Phase 1 计划"guest venus ICD + `VN_DEBUG=vtest` 直连宿主 `virgl_test_server`"。
实测发现 vtest 协议**双向依赖 SCM_RIGHTS fd 传递**（blob/shmem/fence，mesa 侧无条件
断言 blob），而 fd 是内核局部资源——"guest socket → 宿主 server"在 QEMU 边界处死路，
TCP relay 也救不了。改走 **`-device virtio-gpu-gl,venus=true`**：renderer 与 MoltenVK
同在宿主 QEMU 进程侧，blob 映射走 QEMU memory API；guest 用真实 Linux（Alpine edge
diskless netboot，6.18.42-lts）参与先验，StarryOS 内核零改动。这正是 Phase 2 的目标
形态，只是 guest 换成 Linux。

### 6.2 验证栈与构建修复（全部落在 darwin fork 分支）

栈：`~/venus-stack`（src/qemu=v11.0.3 浅克隆 darwin-venus 分支、src/virglrenderer=
GitLab clone darwin-venus 分支、prefix=安装前缀、mirror=Alpine 本地 apk 镜像）。
Alpine guest 启动脚本 `qstart-alpine.sh`（默认 TCG，`QEMU_ACCEL=hvf` 可切 HVF）。

四层修复（按遭遇顺序）：

1. **QEMU `virtio-gpu-gl` 未注册**（Mchnan/qemu `c9ce8a2`）：910b803 补丁只删了
   `opengl` 的内层依赖，外层 `if virgl.found() and opengl.found()` 门控没改；本机
   epoxy 无 EGL → `opengl.found()=NO` → gl 设备源集整个被跳过。修法：门控放宽到
   `virgl.found()`；另外 `virtio-gpu-gl.c` 的 `module_dep("ui-opengl")` 必须
   `#ifdef CONFIG_OPENGL` 守卫——`module_load()` 对缺失的依赖模块直接放弃加载，
   不守卫则设备照样注册不上。
2. **HVF 16K 对齐崩 VM**（Mchnan/qemu `7109d5e`）：1MB blob 的 guest 分配 offset 是
   4K 粒度，`MAP_FIXED` mmap 非对齐 → virglrenderer 返回 `-EOPNOTSUPP`（8107032
   已修）→ QEMU fallback 用 memory region 子区域，落在非 16K 对齐 GPA →
   `hvf_set_phys_mem` 走"不映射"分支，但 `hv_vm_unmap` 同样要求 16K 对齐，
   `assert_hvf_ok` 直接杀死整个 VM（`HV_BAD_ARGUMENT at hvf-all.c`）。修法：不对齐
   段改为 warn+skip（RAM 外围映射保持活跃）。探针默认 TCG 彻底绕开该约束。
3. **virglrenderer MAP_FIXED 16K 对齐**（Mchnan/virglrenderer-darwin `8107032`，
   前一会话已落）。
4. **`vkr_ring_start` 的 `thrd_create` 静默失败**：首两次 vulkaninfo 运行 ring 消费
   完全部命令后停摆（guest 等 ring 响应、render server 4 线程全眠、trace 冻结），
   症状与 ring 线程未创建完全吻合，而 `thrd_create` 失败路径只静默复位 `started`。
   在 `vkr_ring_start`/`vkr_ring_thread`/传输命令加 `vkr_log` 后复跑，ring 线程创建
   成功且此后未再复现——疑似 fork/exec 后的瞬态或旧库缓存残留；失败路径的日志已留
   在 darwin-venus 分支便于再诊。

工具链：`vkr_metal_helpers.m` 的 `venus-protocol/vulkan_metal.h` include 用 shim 目录
（链接 brew vulkan-headers）+ objc_args 注入；QEMU darwin/venus 补丁 4 文件见前一会话
记录（meson 门控、virtio-gpu-virgl.c EGL 守卫 + `VIRGL_RENDERER_NO_VIRGL`、
virtio-gpu-gl.c 无头降级、ui/console.c dpy_gl_* NULL 容忍）。

### 6.3 Guest 侧验证（Alpine edge diskless，mesa 26.2.2）

- capset 确认：guest dmesg `cap set 2: id 4`（VENUS）+ `features: +context_init`。
- 包：`mesa-vulkan-virtio vulkan-loader vulkan-tools`（本地 apk 镜像，diskless 重启后
  重装 ~1 分钟）。
- **`vulkaninfo --summary` 枚举成功**：
  `GPU0: Virtio-GPU Venus (Apple M4)`（vendorID 0x106b，apiVersion 1.4.343，
  driverID=DRIVER_ID_MESA_VENUS，driverVersion 26.2.2，25 个实例扩展）。
  已知问题：vulkaninfo 在**输出完整 summary 之后**的 teardown 阶段挂死
  （`vkDestroyRingMESA` 处理完成后 guest 阻塞在后续 fence ioctl）——枚举结论不受
  影响，但撕裂出 fence 语义缺口（§6.5）。
- **offscreen compute 渲染回读 PASS**：交叉编译探针（aarch64-linux-musl-gcc +
  vulkan-loader apk 解包取 `libvulkan.so.1` + Alpine vulkan-headers apk；shader 用
  glslangValidator 编 SPIR-V 嵌入；完整管线 instance→device→buffer→descriptor→
  pipeline→dispatch(4,1,1)，跑完 `_exit()` 跳过 teardown）：
  全链 API `VK_SUCCESS`，host-visible SSBO 读回 `0xc0de0000-0xc0de0003` 全部匹配。
  **Apple M4 真实执行了 guest 提交的 compute shader**。

### 6.4 环境坑（复现必读）

- guest 必须 `export XDG_RUNTIME_DIR=/tmp/xdg`（vulkaninfo surface 探测硬性要求）。
- guest 串口双向丢字严重：**QEMU chardev `logfile=` 直写通道（alp_console.log）可靠**，
  socket 交互通道只用于注入命令；结构化输出走 `wget --post-file` 回传宿主 TCP 服务
  （pull/ 目录）。
- 探针/wget 挂前台时后续命令只是回显不执行：先发 `\x03`（SIGINT）解堵再注入。

### 6.5 新缺口：ring-based fence retire 链未通 → 已修复（2026-09-15）

`vkWaitForFences` 5s 超时（探针实测），与 vulkaninfo teardown 挂死同族：ring 命令
**执行**正常（读回数据已写好），但 fence 的 retire 通知没有抵达 guest。

**根因（2026-09-15 定锤，两层叠加）**：

1. **macOS 无 eventfd**：`virgl_util.c` 的 `create_eventfd` 在 `HAVE_EVENTFD_H`
   未定义时恒返回 -1；`virgl_renderer_init` 又会因 `has_eventfd()==false`
   **静默剥离 QEMU 传来的 `VIRGL_RENDERER_THREAD_SYNC`**（"a hint and can be
   silently ignored"）。于是 client proxy 只剩 `ASYNC_FENCE_CB`——上游代码里
   这是一个死配置：`proxy_context_init_fencing` 见无 THREAD_SYNC 直接 return，
   sync 线程不创建，而同步 `retire_fences` 路径又被
   `assert(!ASYNC_FENCE_CB)` + `virgl_context_foreach_retire_fences` 的
   capset 守卫双重排除，**fence 在 client 侧永远无人退休**（render server
   进程内 vkr sync 线程正常退休，但 proxy 协议的 shmem timeline 无人轮询）。
2. **链路事实核查**（插桩 + QEMU trace 定位）：guest 内核确实发出
   `CONTEXT_CREATE_FENCE`（fence_ctrl trace）、server 侧 vkr submit_fence/
   queue_sync_retire 正常执行，断点精确落在「server `render_context_update_timeline`
   写共享内存+eventfd → client 无人消费」一环。

**修复**（virglrenderer `b056c0d1`，proxy_context.c）：`ASYNC_FENCE_CB` 置位即创建
sync 线程；线程在 eventfd 存在时等 eventfd（Linux 行为不变），否则以 2ms 周期
轮询 fence shmem timeline；context destroy 不再以 eventfd 存在为线程停止/_join
的前提。回归：探针 `vkWaitForFences: VK_SUCCESS`、fence_ctrl/fence_resp 完整往返、
vulkaninfo --summary 干净退出（teardown 不再挂死）、读回 4/4 不变。

### 6.6 结论

Phase 1 核心目标达成：**guest mesa venus ICD → QEMU virtio-gpu-gl(venus) → 宿主
virglrenderer render server → MoltenVK → Apple M4 Metal** 全链打通，compute 渲染
+ host memory 回读可验证，fence 同步语义已修复（§6.5）。Phase 2（StarryOS card0
增 VIRTGPU_* 3D ioctl 族 + hostmem BAR 映射）的前提条件全部就绪。

## 7. Phase 2 实测结果（2026-09-16，StarryOS 内核 3D 面端到端 PASS）

### 7.1 交付物（本仓库三个改动面）

1. **新 crate `drivers/gpu/virtio-gpu`**（0.1.0，no_std）：2D+3D 合并 virtio-gpu
   驱动。单 transport、单控制队列、进程级全局 3D 注册表
   （`global_3d()`）。2D 面是 `virtio-drivers` `VirtIOGpu` 的忠实移植
   （去 cursor）；3D 面实现 venus 所需的控制面子集
   （capset_info/capset、ctx_create/destroy、resource_create_blob、
   map/unmap_blob、submit_3d）。关键设计：
   - **fenced SUBMIT_3D 必须 fire-and-forget**：宿主把 fenced 命令的
     响应推迟到 fence retire（任意晚），同步等待会卡死 guest。驱动内
     用 pending FIFO（owned DMA 头+载荷）+ 严格按序 drain 的完成队列
     解决 2D 同步命令与 3D 异步提交共用一条 virtqueue 的乱序问题。
   - **命令头一律拷入驱动自有缓冲**再提交：曾出现 guest 栈内存 DMA
     地址在设备读取时失效（type=0 未知命令），owned copy 后消失。
2. **ax-driver**：PCI `SHARED_MEMORY_CFG` vendor cap 解析（`cap64`
   扩展、BAR 物理地址重建）→ hostmem region 传给驱动；GPU probe 改走
   `take_virtio_transport_masked_with_shm`；`pub use virtio_gpu as vgpu`
   re-export。**2D 不可用时降级 3D-only**：darwin venus-only renderer
   没有 vrend，guest 2D 资源必然失败（SET_SCANOUT 报 0x1203），display
   设备不注册（axdisplay 适配器要求有效 framebuffer，否则内核 panic），
   但 3D 面照常发布。
3. **starry-kernel `pseudofs/dev/vgpu.rs`**：card0 增 VIRTGPU_* ioctl 族
   （GETPARAM/GET_CAPS/CONTEXT_INIT/RESOURCE_CREATE_BLOB/
   RESOURCE_INFO/MAP/EXECBUFFER/GEM_CLOSE）+ 通用 syncobj 族
   （CREATE/DESTROY/QUERY/RESET/SIGNAL/TIMELINE_WAIT/
   TIMELINE_SIGNAL）。状态按进程 identity 键控（device ops 无 per-fd
   钩子，venus 每进程一 fd，行为等价）。mmap：MAP_DUMB offset key 空间
   与 blob key（1<<40 起）隔离；blob 走 `DeviceMmap::PhysicalCached`
   （hostmem 是宿主 RAM），BAR slot 按 **16 KiB** 对齐（HVF/macOS 宿主
   页粒度）。卡级 state 挂进 card0 既有 `reset_kms_state()`（最后一个
   fd 关闭时清空，延续 #2393 语义）。

### 7.2 端到端验证（venus QEMU + StarryOS，raw ioctl 探针）

探针 `tmp/vgpu-probe/vgprobe.c`（musl 静态编译，debugfs 注入 rootfs
APFS clone 副本，串口 holder 注入），21 步全绿（`=== VGPROBE PASS ===`）：

GETPARAM（3d/blob/host_visible/ctx_init/capset_fix 全 1，capset_mask=0x10
→ venus 位）→ GET_CAPS(venus, 160B) → CONTEXT_INIT（第二次 EEXIST 语义
正确）→ RESOURCE_CREATE_BLOB（HOST3D+MAPPABLE，132 KiB）→
RESOURCE_INFO → MAP（offset=0x1_0000_0000_0000）→ **mmap 直写 hostmem
BAR 且回读一致**（0xc0de0000-3）→ SYNC Timeline signal/query →
EXECBUFFER（unfenced 提交成功）→ TIMELINE_WAIT 未来点 → EINVAL（语义
正确）→ GEM_CLOSE → SYNC DESTROY。

2D 回归：grouped `qemu/system` 1/1（drm-modeset 75/75 含
drm-atomic→modeset 跨进程顺序）不受影响；clippy/fmt 全绿（bare-metal
aarch64 target 手工匹配参数）。

### 7.3 排障路上踩掉的三个坑（复现必读）

1. **QEMU `VIRGL_VERSION_MAJOR` 宏改名**（本轮最隐蔽）：virglrenderer
   1.3+ 把版本宏改成 `VIRGL_MAJOR_VERSION`（virgl-version.h），QEMU
   `virtio-gpu-virgl.c` 仍用旧名——未定义标识符在 `#if` 里求值 0，
   **RESOURCE_CREATE_BLOB/MAP_BLOB/SET_SCANOUT_BLOB/fence-info 整段
   case 被静默裁掉**（0x111 命令落 default → 0x1200）。Phase 1 的
   QEMU 是 brew 头还在时构建的所以能跑；后来 brew 头被删、patch 触发
   重编才暴露。修复 = 源文件头部桥接宏名
   （`VIRGL_VERSION_MAJOR → VIRGL_MAJOR_VERSION`），已落 darwin fork。
2. **wire 命令号手抄错误**：`RESOURCE_CREATE_BLOB=0x10c`（非 0x111）、
   `SUBMIT_3D=0x207`、`MAP_BLOB=0x208`、`UNMAP_BLOB=0x209`。用 QEMU
   枚举/`process_cmd` trace 打点定位（default-hit 诊断）。
3. **vkr shm blob 语义**：blob_id=0 走宿主 shm 分配要求
   `blob_flags == 精确的 MAPPABLE`（多一个 SHAREABLE 就不匹配）；
   CONTEXT_CREATE 空 debug_name 会被 renderer 拒绝（Linux 总发 task
   comm）→ 内核补默认名。SYNC 语义 v1 定案：全 timeline watermark
   （binary 用 0/1 塌缩），EXECBUFFER 的 out_syncobj 在同步返回时
   signal。

### 7.4 遗留与下一步

- 同步 single-flight 模型下 fence 在 ioctl 返回时视为 signaled——
  `vkWaitForFences` 语义正确但 GPU 并行度未打开；async submit +
  fence-event 唤醒（内核事件队列已有 poll 基建）是下一手。
- GUEST/HOST3D_GUEST blob（guest backing attach）与
  `SYNCOBJ_EVENTFD`/sync_file 导入导出未实现（前者 Phase 3 再说，
  后者保持 ENOSYS 是诚实语义，见 §6.5 的 fence 分析）。
- 2D/3D 共存：venus-only 设备无 2D 面，denial 桌面要跑起来需要把
  card0 的 KMS present 路径接到 3D blob 资源（SET_SCANOUT_BLOB +
  DMA-BUF 导出链），这是 Phase 3 的核心工作。
- deniald 集成验证（Phase 3）：rootfs 需 Alpine edge 的
  `mesa-vulkan-virtio`（venus ICD），Flutter Impeller-Vulkan 走
  `/dev/dri/card0` 的 VIRTGPU_* 面。

## 8. Phase 3 实测结果（2026-09-16，SET_SCANOUT_BLOB 接 KMS present 端到端 PASS）

### 8.1 交付物（本仓库两个改动面）

1. **新 crate `drivers/gpu/virtio-gpu`**：控制面补
   `CMD_SET_SCANOUT_BLOB (0x010d)`（`SetScanoutBlob` wire 结构，96 字节
   布局断言）+ `VIRTIO_GPU_FORMAT_*` 常量；`VirtioGpu3D` trait 新增
   `set_scanout_blob` / `bind_2d_scanout` / `disable_scanout` 三个同步
   命令（scanout 命令无 fence，同步往返安全）。
2. **starry-kernel card0**：KMS present 路径按 fb backing 分流——
   `Framebuffer` 增 `FbBacking::{Dumb, Blob}`，`ADDFB2` 的 GEM handle
   先查 dumb 表、再查 vgpu blob 表（blob fb 记录 res_handle/几何/格式）；
   `present_fb` 的 blob 分支发 `SET_SCANOUT_BLOB`（零拷贝：宿主 surface
   直接引用 blob 内存，无 memcpy 无 flush），dumb 分支保持 memcpy + 若
   blob scanout 曾活跃则先 `bind_2d_scanout` 重绑 2D 资源（混合 2D+3D
   设备的表面恢复语义）；`reset_kms_state` 在资源拆除前先
   `disable_scanout`。修 Phase 2 遗留 bug：blob mmap key 由 +1 递增改为
   `PAGE_SIZE_4K` 步进（`sys_mmap` 硬性要求文件偏移页对齐，第二个及以后
   的 blob 一律 EINVAL，Phase 2 只 map 一个 blob 所以没暴露）；线上
   blob 尺寸向上取整到 16 KiB（`BAR_SLOT_ALIGN`，见 §8.3 第 3 条）。
3. 探针 `tmp/vgpu-probe/vgprobe.c` 扩到 15 组（含 4 个负例：关柄
   ADDFB2、小于几何 ADDFB2、伪造 handle、垃圾 EXECBUFFER），host 侧
   校验 `tmp/vgpu-probe/scanout-check.py` 盯 console.log 的 MARKER 行、
   HMP `screendump` 抓 QEMU console surface 并逐像素比对 guest 写入
   blob 的图案。

### 8.2 端到端验证（venus QEMU + StarryOS，HVF）

- `=== VGPROBE PASS ===`（全步绿）：3D 面 21 步 + scanout 段——
  RESOURCE_CREATE_BLOB(640×480×4) → MAP → mmap BAR 直写渐变图案 →
  ADDFB2(blob handle) → SETCRTC → `CRTC_GET_SEQUENCE active=1` →
  MARKER₁ → RESOURCE_CREATE_BLOB(B) → PAGE_FLIP(A→B) → MARKER₂ →
  RMFB/GEM_CLEAN 双 blob → 垃圾 EXECBUFFER（文档化：vkr 对未知
  venus opcode 报 CS error 并拆 context 连接，之后只允许 guest 本地
  步骤）→ TIMELINE_WAIT 语义复查 → 收尾清理。
- `=== SCANOUT-CHECK PASS ===`：宿主 `screendump` 像素级比对——
  SETCRTC 后 console surface 呈现 guest 写入 blob A 的渐变（5 个探针
  点逐一匹配 `(r,g,b)=(x·255/639, y·255/479, 0x40)`），PAGE_FLIP 后
  呈现 blob B 的纯品红（4 点匹配）。guest 用户态 mmap BAR 写入 →
  guest 物理内存 → EPT → 渲染器/surface 同一块宿主页，全程零拷贝
  得到字节级证明。
- 回归：grouped `qemu/system` 全绿（dumb 路径不变，blob fb 只在
  VIRTGPU_* 面存在时可达）；clippy（virtio-gpu + starry-kernel 板卡
  特性 aarch64）/fmt 全绿。

### 8.3 本轮踩掉的四个坑（复现必读）

1. **HVF EPT 陈旧（最深的一坑）**：virgl 的 `MAP_FIXED` 快路径在 QEMU
   的 hostmem RAM 区块底下用 `mmap(MAP_FIXED)` 换页，hvf 内存监听器
   无感知 → EPT 仍指向旧匿名页 → guest BAR 写进孤儿页、渲染器与
   surface 读到全零（KVM 上游无此问题：mmu_notifier 兜底；Phase 1 端
   到端能通是因为跑的 TCG 软 MMU）。修复：darwin fork 禁用 MAP_FIXED
   快路径，恒走 `virgl_renderer_resource_map` + MR 子区域
   （`add_subregion_overlap`），让内存监听器每次映射/解映射都更新
   stage-2——与 Linux 上游 fallback 语义一致。
2. **shm fd 被当 dmabuf**：proxy 架构下 `virgl_renderer_resource_get_info`
   返回的 `info.fd` 对 venus blob 是 **shm fd（≥0）**，QEMU 把它存进
   `res->base.dmabuf_fd`，导致「dmabuf_fd<0 才回退」的条件永不成立，
   命令落进 darwin stub `update_dmabuf`（返回 0 假成功）→ console 一直是
   "Display output is not active." 占位 surface。修复：非 GL console
   无条件走 pixman 直显路径（map = MR ram_ptr），GL console 保持
   Linux dmabuf 语义。
3. **blob 尺寸 16 KiB 对齐**：宿主页 16K，`RESOURCE_MAP_BLOB` 的 MR
   子区域尺寸 = blob 原始尺寸；`0x21000`（8.25×16K）这类 4K 对齐尺寸
   会让 hvf 监听器切出的 subsection 不对齐而被
   `accel/hvf` 的 skip-guard 跳过 → 该 gpa 段 EPT 缺失 → guest 首次
   BAR 访问卡死。修复：驱动把线上 blob 尺寸与 BAR slot 统一向上取整
   到 16 KiB（渲染器 shm 本就按宿主页向上取整，语义安全）。
4. **验证工具链三坑**：(a) `debugfs rm` 后 `write` 复用 extent 会产出
   截断镜像（必须 `kill_file`+`unlink`+`write` 且 dump 逐字节校验）；
   (b) guest 运行中改 rootfs 镜像 = 无效注入 + unmount 时缓存写回覆盖，
   必须「关机→注入→校验→开机」；(c) holder 的 ctl 处理线程与 reader
   线程竞争同一串口 socket，探针前 7s 输出（含 MARKER₁）被 ctl 响应
   窗口吃掉——校验器必须盯 QEMU chardev `logfile`（console.log）而非
   holder 的 live.log，且 marker 匹配必须带日志偏移量基线（否则历史
   轮次的 marker 秒匹配造成假证据）。

### 8.4 遗留与下一步

- **deniald venus ICD 集成（Phase 4）**：rootfs 装 Alpine edge
  `mesa-vulkan-virtio`，Flutter Impeller-Vulkan 走 card0 的
  VIRTGPU_* 面 + 本 Phase 的 blob scanout 上屏；链路两端已各自闭环。
- fence 异步唤醒（GPU 并行度）与 GUEST/HOST3D_GUEST blob 仍是
  Phase 2 遗留（§7.4），优先级让位于 Phase 4。
- PRIME 导出 blob handle / DMA-BUF 导出链未做：SET_SCANOUT_BLOB 直接
  吃 resource id，compositor 直连路径不需要 dma-buf；跨进程共享场景
  未来再补。
- 混合 2D+3D 设备的 blob↔dumb 表面切换已实现（`bind_2d_scanout` 重
  绑），但仅在 3D-only 设备上验证过；2D 存在时的行为等价 Linux 的
  set_scanout 语义，待有 2D+3D 组合的宿主环境再实测。
