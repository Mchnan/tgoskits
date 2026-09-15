# 调研：macOS 宿主 Vulkan 渲染加速（denial 桌面帧率下一手）

状态：2026-09-14 调研定稿；2026-09-15 Phase 1 端到端实测通过（见 §6）。
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

### 6.5 新缺口：ring-based fence retire 链未通

`vkWaitForFences` 5s 超时（探针实测），与 vulkaninfo teardown 挂死同族：ring 命令
**执行**正常（读回数据已写好），但 fence 的 retire 通知（vkr 的
`on_ring_seqno_update` → sync queue → proxy `retire_fence` → QEMU → guest IRQ 链）
没有抵达 guest。影响：依赖 fence/同步语义的负载（deniald 的 per-frame fence）会挂。
Phase 2 立项前需修：优先排查 vkr sync queue 的 fence retire 通知路径在
render-server（多进程）模式下的接线（单进程 vtest 模式不受影响）。

### 6.6 结论

Phase 1 核心目标达成：**guest mesa venus ICD → QEMU virtio-gpu-gl(venus) → 宿主
virglrenderer render server → MoltenVK → Apple M4 Metal** 全链打通，compute 渲染
+ host memory 回读可验证。Phase 2（StarryOS card0 增 VIRTGPU_* 3D ioctl 族 +
hostmem BAR 映射）的前提条件全部就绪，外加一项前置修复（§6.5 fence retire）。
