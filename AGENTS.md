# AGENTS.md

## 1. 项目级约束

以下约束适用于整个仓库；具体设计、实现和审查规则由任务语义命中的项目技能提供，不在本文件重复维护。

- 仓库中的 Python 脚本统一使用 `python3` 运行；系统自带的 `python` 是 Python 2。
- 使用仓库固定的 Rust 2024 夜间工具链和 `rustfmt` 配置作为格式化事实来源。
- 可复用的内核、组件、内存、虚拟化和可移植驱动软件包优先使用 `#![no_std]`；只有软件包边界确实需要时才增加 `alloc`、`std` 或受功能开关控制的支持。
- 软件包和模块边界应与 TGOSKits 分层一致：可复用逻辑放在 `components/`、`drivers/`、`memory/` 或 `virtualization/`，操作系统适配代码放在使用它的 ArceOS、StarryOS、Axvisor 或平台层附近。
- 公共接口和共享代码中的注释使用英文；面向项目的文档、拉取请求、议题、审查回复和讨论使用中文说明技术逻辑，命令、路径、代码标识符和标准正式名称可以保留原文。
- 判断项目技能是否适用时以行为语义为准，不以文件路径、拉取请求标题或作者声明代替判断。上下文被压缩或无法确信仍完整记得适用技能时，继续前重新读取相应技能。

## 2. 项目工作流

以下规则约束验证、持续集成、拉取请求和项目协作流程。

### 2.1 本地验证

项目任务工具负责展开软件包选择、功能组合和目标矩阵，并统一汇总失败结果；本地验证应使用这些稳定入口。

- 按实际改动选择能覆盖受影响行为、功能组合和目标的验证，完成本节及适用技能要求的检查。检查通过后，仅在新增改动、失败或未解决风险需要时扩大或重复验证；纯文档或技能说明修改只检查差异、引用及适用的文档或技能校验，不运行 Rust 构建和测试。
- 修改 Rust 代码后使用项目适配的 `cargo xtask clippy` 执行静态检查。定向检查使用 `cargo xtask clippy --package <软件包>`，全工作区检查使用 `cargo xtask clippy` 或 `cargo xtask clippy --all`，增量检查使用 `cargo xtask clippy --since <引用>`；不得用原生 `cargo clippy` 命令代替。
- 修改 `scripts/test/std_crates.csv` 白名单覆盖的软件包后，使用 `cargo xtask test` 执行标准库测试；增量验证使用 `cargo xtask test --since <引用>`。该入口不支持按软件包选择，不得用原生 `cargo test` 命令代替。
- 不得通过增加 `allow` 属性来回避静态检查警告；除非用户明确要求，否则应修复根因。
- 编辑 Rust 代码后运行 `cargo fmt`。
- 测试设计、必要性、去重和 Rust 测试布局统一遵循 [`test-quality`](.agents/skills/test-quality/SKILL.md)。以最少且充分的测试证明完整通用功能；新增配置、参数取值、平台实例或历史问题不自动要求新增测试。
- 修复错误时，优先复用已有通用功能测试，必要时增强其判定；只有缺少独立行为证明时才新增。先确认同一测试在错误实现上必然失败，再实现或恢复修复，最后验证通过。不得只依赖修复后的证明、概率性复现程序或放宽后的测试。
- 构建、测试或运行 ArceOS、StarryOS 和 Axvisor 时，使用 `cargo xtask` 命令族，不直接使用 `cargo build`、`cargo test` 或 `cargo run`。
- 只有项目任务工具没有相应入口且任务明确需要特殊配置时，才检查 `xtask` 实现并使用原生 Cargo 命令手工匹配参数；不得把任务工具内部调用的原生命令当作项目验证入口。
- 解决变基或合并冲突时，不得手工合并发生冲突的 `Cargo.lock` 内容。先解决其他冲突，再用 Cargo 重新生成 `Cargo.lock` 并验证生成的锁文件。

### 2.2 持续集成与审查

持续集成配置和拉取请求审查使用仓库定义的证据链，不以临时本地命令或宽松检查替代项目门禁。

- `.github/workflows/ci.yml` 中自托管持续集成矩阵项的 `cache_key` 必须保持为空字符串（`cache_key: ""`）。非空值会在自托管运行器上启用 `rust-cache` 步骤，可能删除 Rust 或 Cargo 状态并破坏后续任务。
- 单项拉取请求审查执行 `review-single-pr`，批量审查执行 `review-open-prs`。在作出审查结论前，必须完整执行相应技能规定的持续集成前置门禁、技能路由、证据清单和当前提交复核。
- 执行拉取请求审查时不得运行本地格式化、构建、静态检查、测试、QEMU 测试、元数据、打包或发布验证命令。唯一运行时例外是技能明确允许的直接变更 `apps/**` 可运行应用，而且相同应用与目标缺少等价持续集成运行。
- 审查流程中的 `CI_DEFERRED` 和 `CI_SKIPPED` 是前置门禁状态，不是审查结论，不得发布到拉取请求。

### 2.3 拉取请求

面向项目的提交应保持中性、可追溯，并让标题、正文、验证记录和分支实际内容一致。

- 拉取请求标题遵循约定式提交的 `type(scope): content` 格式。一个软件包明显占主导时，优先把该软件包名作为 `scope`；跨领域或基础设施改动可以使用 `ci`、`repo` 或 `docs` 等较宽范围。
- 提交拉取请求时，标题使用英文，正文使用中文。正文必须说明要解决的问题、实际改动以及每一步方案背后的逻辑。
- 提交拉取请求前尽可能在本地验证持续集成流程；除非用户明确要求，只有实体板卡测试和自托管测试流程可以排除。只修改文档且不影响构建或测试时，不要求本地持续集成验证。
- 分支新增或修改提交后，更新拉取请求描述，使其与已提交改动保持同步。
- 除非用户明确要求，不得加入与代理相关的标签、签名、品牌或宣传性措辞，例如 `codex`、`agent`、`AI`。
- 修改体系结构启动逻辑、someboot 启动顺序、统一可扩展固件接口交接、对称多处理启动、动态平台契约、目标描述文件假设或推荐调试流程时，在同一改动中更新 `arch-platform-porting` 技能或其参考资料。

### 2.4 授权与完成条件

从当前请求和会话中已有约定确定任务范围与交付物。用户明确指令优先于项目技能指引，但不绕过上层规则、工具权限或平台限制；读取技能本身不增加任务权限。

- “帮我修改”“修复”等行动请求授权连续完成范围内的读取、实现、必要验证和结果说明；“修复并提 PR”还包括提交、推送和创建拉取请求。阶段切换不重复询问“是否继续”；只读分析请求在给出结论和证据后结束。
- 优先从上下文和可读取资料补足信息，普通实现选择自行判断并说明必要假设。只有无法推断且会改变正确性、范围或交付目标的信息，或尚未获授权的破坏性、不可逆及外部写入操作，才需要询问。先完成不依赖该答案的已授权准备工作，再针对具体缺口询问；未获授权的合并、部署、发布和删除不由修复或提 PR 请求自动授权。
- 技能导致询问、暂停或交付不完整时，给出实际读取的 `SKILL.md` 路径、相关原文和适用原因，区分明确要求与自己的解释。业务规则冲突无法判断时保留原条款，说明冲突和影响，只暂停依赖该决定的步骤。
- 只修改授权范围内的文件，保留用户已有改动；范围外问题列为建议。通用授权与验证规则由本文件维护，技能只补充领域条件，避免重复规定不同的确认流程。
- 完成意味着请求的交付物已实现、必要检查已通过、最终差异已核对，并说明改动、验证证据和剩余限制。必要检查失败或受阻时明确报告未完成项及原因，不把计划、局部通过或运行中的 CI 当作整体完成；用户只要求检查点时按该边界交付。

## 3. 项目记忆

- zink 桌面黑屏根因闭合（2026-10-08 第四轮，`local/venus-into-dev-0924` + `~/denial` 工作树）：**Denial Flutter 引擎在 zink 上从不调用 root present 回调**。证据链：(1) denial 源码（~/denial，main@85b2303 + 本地未提交仪表/fence 兜底）读出输出槽状态机 `Free→Rendering→Ready→Pending→Free`，`target_available()` 要求 `authorized_request 无 && 全部 slot Free && 存在 output_refs==0 的 Free`——一个卡 Rendering 的 slot 就永久断供授权；`begin_transaction`（make_current 时）只救 Rendering+无引用 的 slot；`mark_ready` 盖当前事务号、`finish_transaction`（raster_idle 哨兵）只收集戳号相等者；volition-kms 线程是 sync_channel 作业 worker，其 futex recv 停等属正常空闲（9-24 的「volition-kms 卡 futex」结论需修正）。(2) 实测：`output target authorized: 12`（授权在发）+ `present_callback_avg_us=0.0`（llvmpipe 为 790µs——**引擎从未调用 root present-with-info**）+ 一次 `nested Flutter output presentation`（ext-view 在 pending 未消费时再次触发→返回 false→引擎整体放弃出帧，frames=0 永久）+ 槽稳态 `(Rendering,0)`（每 tick 重授权→重 acquire→present 永不来）+ mark_ready 零失败记录 + fence 导出全部 signaled + 真实 ATOMIC(flags=0x400) 成功——**deniald 侧状态机与内核 UAPI 全部正常，断点在引擎内部：ext-view 之后、present 之前被跳过**。(3) tidsig 修正：线程 futex WAIT_BITSET 停等要区分「作业队列 worker 正常空闲」与「真死锁」，llvmpipe 对照（present_callback 790µs、调度器审计每 2s）是判定基准；串口取证通道脆弱（tidsig SIGSTOP 后未 CONT 会把整进程冻死），每次 ptrace 轮后必须确认进程活性。(4) Impeller 路径的 `GL_FRAMEBUFFER_UNSUPPORTED`(0x8CD6) 根因是 MoltenVK/Apple M4 无 `D24_UNORM_S8_UINT`（宿主 vkGetPhysicalDeviceFormatProperties 直查 optimal=0，Impeller stencil 附加失败）；skia 路径的引擎跳 present 与 FBO 完整性失败（Impeller 同族静默版）是当前最强假设，待在 Flutter fork（`/mnt/exty/denial-flutter-fork-3.44.7`，在 Linux 构建机，本机不可达）instrument present-with-info 验证。(5) 60Hz 结论不变：llvmpipe 4 线程 raster 实测 20–32ms/帧超预算（上限 <40fps），60Hz 必须 zink；管线条件就绪，等引擎 present 链修复即可测量。
- venus zink 加速推进（2026-10-08 第三轮，`local/venus-into-dev-0924`）：**内核侧加速路径打通到 Flutter output pools 导入，剩余阻塞收敛到 deniald 用户态**。内核四组增量（9 文件 +288/−20）：(1) legacy `DRM_IOCTL_MODE_ADDFB`（0xAE，28B `drm_mode_fb_cmd`）——zink 的 gbm buffer 让 smithay 走 legacy 入口，命令字 0xc01c64ae 曾落 ENOTSUP 直接打死 deniald；实现为合成 ADDFB2 走同一核心（bpp/depth→fourcc，未知组合 EINVAL），`add_fb2_core` 两条入口共用。(2) PRIME 跨 fd 导入别名：`PRIME_FD_TO_HANDLE` 此前把创建者 bo_handle 原样返回，跨 fd 必落 "no backing" EINVAL；现在导入方名下克隆资源条目（同宿主资源/同 BAR 窗口/新 GEM 句柄，`imported` 标记），GEM_CLOSE/close_fd 对导入条目只释放本地引用不碰宿主 BAR——Linux dma-buf 导入引用语义，perbuf-dumb 的 per-fd 断言正是这条。(3) `SYNCOBJ_HANDLE_TO_FD` sync file 导出/导入：zink EGL native-fence 经 mesa venus 用 **24 字节带 point 的 drm_syncobj_handle**（0xc01864c1）导出，旧 16B 结构因 ioctl 号编码结构大小路由不进，deniald 的 output-pool fence 生命周期因此全断（present 目标耗尽、黑屏）；已到点导出立即 signaled，未来点登记 `SyncobjState.sync_files` 水位推进统一唤醒，`FD_TO_HANDLE` 支持已 signaled 文件导入。(4) 栈环境考古：QEMU 宿主侧必须带 `qstart-alpine.sh` 三件套（VK_DRIVER_FILES/VK_ICD_FILENAMES 指向 MoltenVK ICD + DYLD_LIBRARY_PATH=/opt/homebrew/lib:venus-stack/prefix/lib，否则 virgl_render_server dlopen 失败、guest 全体 OUT_OF_HOST_MEMORY）；guest 侧要上一轮脚本集的 `MESA_GLES_VERSION_OVERRIDE=3.2` + `GALLIUM_DRIVER=zink`/`MESA_LOADER_DRIVER_OVERRIDE=zink` 双开 + `/root/.drirc` `venus_implicit_fencing=true`。**验证**：vkprobe 21 步 PASS、DRM 四用例干净 guest 265/0（85/125/14/41，modeset 复跑一致）零回归、clippy 18/18 aarch64、fmt 干净。**zink 桌面里程碑**：GL Renderer="zink Vulkan 1.4(Virtio-GPU Venus (Apple M4) (MOLTENVK))"、四个 GLES 3.2 上下文全建、linux-dmabuf v4+native fence 上线、output pools(buffers=3) 导入 Flutter EGL——dev card0 内核上第一次走到这一步。**剩余阻塞全在 deniald 用户态**：shell 子进程 SIGSEGV@VA:0x15c（llvmpipe 时期同形态，zink 下死得更早致 render_requests 恒 0）、池 buffer 卡 Rendering `[(Free,1),(Rendering,0),(Free,0)]`、Impeller FBO GL_FRAMEBUFFER_UNSUPPORTED(0x8CD6) 系 MoltenVK 无 D24_UNORM_S8_UINT（宿主 vkGetPhysicalDeviceFormatProperties 直查为 0，Impeller stencil 附加失败）、offscreen-blit 模式被 gbm modifier=Invalid 卡（create_with_modifiers2 本栈 EINVAL）；skia 模式走通 pools 导入后死于 shell 崩溃。**60Hz 结论：加速桌面暂不上屏，无法测量帧率**；下一手 deniald 侧 mini-strace 取 0x15c 崩溃栈 + Rendering fence 释放路径。补记在 `docs/design/starry-venus-into-dev-card0.md` §zink 加速推进补记。
- venus 复测闭环（2026-10-07 第二轮，`local/venus-into-dev-0924`）：四项遗留待办收敛三项半。(1) **桌面级 venus e2e 的真实形态是内核 panic，不是握手停摆**：deniald 启动即把内核打死（`LazyInit<RawSpinLock<ErasedDisplayDevice>>` 未初始化解引用）——venus-only 探测下 display 设备不注册、`MAIN_DISPLAY` 永不初始化，而 axdisplay 的 `framebuffer_*`/`gpu3d_*` 全部裸 `lock_irqsave()` 解引用，任何 userspace 调用序都能触发；修复为 axdisplay 28 个入口全部 `MAIN_DISPLAY.get()` 判空降级（info 返回零尺寸占位、flush 返回 false、DisplayResult 系返回 NotAvailable、has_virgl 等返回 false），fb0 构造另加断言。修复后 deniald 在 venus 栈稳定运行（Volition scheduler 2s 拍、presentations=1、missed_vblanks=0），Dart 引擎 frames=0（shell 不上屏）是 skia/Impeller raster 层的下一个独立问题。(2) **syncobj 对齐 Linux 语义 + 补 SYNCOBJ_EVENTFD**：syncobj 原挂 VgpuFd（要 CONTEXT_INIT）导致无 context fd CREATE 必 EINVAL，现挪 Vgpu 独立 per-fd 表 `(file_id, handle)` 键控、close_fd 无条件回收（drm_release 语义）；mesa 25.2 sync provider 用的 `DRM_IOCTL_SYNCOBJ_EVENTFD`（0xCF，v6.7 UAPI，`struct drm_syncobj_eventfd` 24B）从 ENOSYS 落洞补成真实现（点已到立即 signal_kernel(1)，未到点登记 SyncobjState.eventfds，EXECBUFFER/TIMELINE_SIGNAL 推水位时统一唤醒）。(3) **DRM 四用例 265/0 + 无泄漏**：modeset 85/0、atomic 125/0、version 14/0、perbuf-dumb 41/0（换装分支为 69/16、90/35、14/0、40/1，缺口全消），modeset 复跑一致；`cargo xtask starry test qemu -c qemu/system` 在 macOS 缺 qemu-user 仍跑不起来，维持交叉编译注入 guest 直跑口径。clippy 18/18 aarch64（loongarch/riscv lwprintf 环境缺口照旧）、fmt 干净。换装分支 local/venus-dev-0923 正式退役，文档证据保留。复测记录在 `docs/design/starry-venus-into-dev-card0.md` §复测闭环补记。
- venus 面接进 dev card0：增量移植完成并三路验证全绿（2026-10-07，`local/venus-into-dev-0924`，提交 `6678a8b2a`）。**这是 9-24「venus 进 dev 应反向接装」结论的落地**：全部为 dev 原驱动的增量扩展，无任何整体替换。(1) 驱动 `drivers/gpu/virtio-gpu`：控制队列改 pending FIFO + 按 token 匹配响应（fenced SUBMIT_3D 的响应宿主推迟到 fence retire，单请求同步往返模型容纳不了失序完成）；fenced 提交 fire-and-forget（条目自带 header/payload/recv DMA 缓冲）；新增 hostmem BAR、MAP/UNMAP_BLOB、SET_SCANOUT_BLOB、with_fence_ring、submit_3d_deferred/unfenced、info()；全方法 `&self` + 内部 Spinlock，经 Arc 同时服务显示适配器与 `VirtioGpu3D`/`register_global_3d` 全局句柄；2D/virgl API 原样保留。(2) ax-driver PCI 解析 SHARED_MEMORY_CFG（cap64）重建 BAR；display 探针 2D 不可用（venus-only 无 vrend）降级 3D-only 不注册 display 设备。(3) 内核新模块 `pseudofs/dev/vgpu.rs`（venus VIRTGPU_* + syncobj 全族，**状态按 file_id 与 dev card0 per-fd GEM 模型一致**）；card0 按 capset 分流（capset 4→vgpu 面，VIRGL/VIRGL2→axdisplay 路径，共享 ctx-id 分配器）；blob 句柄进 ADDFB2 走 SET_SCANOUT_BLOB 零拷贝 present；mmap 新增 `DeviceMmap::PhysicalCachedResolved`（mmap 键是选择器且内存可缓存——hostmem 上要跑原子 RMW 环形缓冲）。drm.rs 补 syncobj 全族 ioctl/结构与 **DRM_CAP_SYNCOBJ_TIMELINE=0x14**（必须与用户态编译所对的 UAPI 头一致，凭记忆写 0x1a 会让 mesa 静默降级 sync-file 路径、EXECBUFFER 走 FENCE_FD_OUT 同步路径在 venus 上必 DEVICE_LOST）、blob 结构 v6.15 `blob_hints` 尾部（ioctl 号编码结构大小，旧 48B 布局的编号落不进 handler）。**验证**：vkprobe 21 步 PASS（含 BAR pattern 往返、读回 4/4）；干净 guest DRM 用例 modeset 125/0、atomic 85/0、version 14/0、perbuf-dumb 41/0 全绿（换装路线为 69/16、90/35、14/0、40/1——dev card0 语义全部保住）；2D 桌面 1280x800 100% 非黑跨截图时钟差 8313 字节；clippy 18/18 aarch64 检查过（loongarch/riscv 的 lwprintf-rs build.rs 依赖 Linux gcc，基线同样失败，环境缺口）。设计与排查坑全集在 `docs/design/starry-venus-into-dev-card0.md`。
- venus 栈排查方法论补充（2026-10-07）：**对照实验先控变量再怀疑自己的代码**。本轮 DEVICE_LOST 逐层仪表（内核 ioctl trace + QEMU submit trace + A/B 换装分支内核）后定位两个栈侧事实：根因一是 DRM_CAP_SYNCOBJ_TIMELINE 值错（见上条），二是**失败读数来自 rootfs 里旧的 `/opt/vgpu/vkprobe` 二进制**——注入带窗口钩子的 `vkprobe-fast`（venus-stack/mirror/）后新旧内核同样 PASS；fence 后读回需要窗口（VKPROBE_WINDOWS=1）是已知 early-retire 缺口的旧形态，不是回归。QEMU 源树（venus-stack/src/qemu，darwin-venus 分支）带本地提交（pixman blob scanout、hvf unaligned 段跳过），重建 QEMU 前先 `git status` 确认漂移；`/tmp` 探针工具（probesrv HTTP 8100、收集器 8000、hold/ctl 脚本）会话间会被清掉，按 `docs/design/starry-venus-into-dev-card0.md` §排查记录可重建。
