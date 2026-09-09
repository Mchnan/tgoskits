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
- 修复错误时，先增加一个在错误实现上必然失败的确定性回归测试并验证失败，再实现或恢复修复，最后验证同一测试通过。不得只依赖修复后的证明、概率性复现程序或放宽后的测试。
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

## 3. denial 桌面 QEMU 速查（macOS arm64；完整步骤与坑见 docs/sop-run-starryos-denial-qemu.md，改启动方式或板卡假设时同步更新该 SOP）

- 编译：先设 musl 工具链 PATH 与 `BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl`（lwprintf-rs 的 bindgen 需要，配方在 SOP §1），再 `cargo xtask starry build -c os/StarryOS/configs/board/qemu-aarch64.toml --smp 4`；跑完 unset 该环境变量。
- 启动：HVF + `-smp 4` + virtio-gpu/input + nvme rootfs + cocoa 显示（SOP §2），登录后 deniald 命令必须带 `--flutter-bundle /opt/denial/shell-bundle` 与 `LD_PRELOAD=/usr/lib/libdenialshim.so`（SOP §3）。
- 关键坑：漏 `--flutter-bundle` 会静默降级诊断模式（蓝闪→永远黑屏+光标，唯一线索是 dd.log 的 `presentation="diagnostic-atlas"`）；不能硬杀 QEMU（guest ext4 数据块丢失、文件变全零），关机用 guest 内 `sync; poweroff`；同一 rootfs 镜像不能双开（写锁）。
- 性能基线（旧调度器快照树）：LP_NUM_THREADS=1 锁屏约 t50s，默认多线程约 t90–150s（多线程 llvmpipe 反而慢约 3 倍）；根因是唤醒/派生永远本地放置、无负载均衡，上游 PR #1775（2026-09-08 调度器重建）已修复，repatch 后更新基线。
- 诊断工具（2026-09-09 实战验证）：QEMU 加 `-gdb unix:/tmp/prof/gdb.sock,server=on,wait=off`，串口用 `-chardev socket,...,server=on,wait=off,logfile=console.log` 并由常驻进程持有连接（chardev socket 断开后重连会被饿死，gdbstub 有独立监听不受影响）；采样循环 `vCont;t → ? 确认 T05 → 逐 vCPU g 包读 PC/CPSR（CPSR.M[3:2] 区分 EL0/EL1）→ vCont;c`，符号化用同目录 `starryos` ELF。脚本在会话 /tmp/prof/{probe,flame,guesthold}.py。
- 已证实结论：快照树 `/proc/stat` 的 sys 包含线程阻塞期间的 off-CPU 时间（`TimeManager.poll` 在下次切换补记全量 delta），top 的 99% sys 是记账幻象，以采样器为准；真实瓶颈是老调度器把全部用户任务放在 CPU0（采样 34/34 个用户态样本全在 tid1）、三核空转，内核侧非空闲热点为 `AddrSpace::can_access_range` 逐页探测与 epoll 扫描（上游 #2261/#2302 已针对性优化）。
- 根因链与实验结论（2026-09-09）：deniald/flutter 存在用户态时钟轮询（Linux 上走 vDSO 零成本），StarryOS 无 vDSO 使每次时钟读成为真系统调用并走 `prepare_user_memory` 慢路径拿 aspace 全局锁，自旋线程近乎垄断该锁导致同进程全部线程的系统调用饿死（采样可见 26% busy 全部集中在 tid1 的 `can_access_range`/procfs 路径）。启用 `starry-kernel/user-access-fastpath`（board 配置 feature）可使风暴消失、busy 分散多核，但在快照树上桌面黑屏不渲染（A/B 验证：回退后 +30s 锁屏出画），故回退保持 baseline；最终修复依赖上游 #2261/#2302 重写的 UserAccess/VMA 路径，随 repatch 落地。另：串口 chardev 在 guest 忙时输入饿死、>4KB 输出冻死，诊断用 gdbstub 采样 + HMP screedump 亮度代替。
- 诊断证据与现状补充（2026-09-09）：自旋证据 20s 窗口 44/172 busy 全在 tid1、x2=0x10（16 字节 timespec）、LR=prepare_user_memory+0x27c；fastpath A/B 用 HMP screendump 亮像素做指标（回退后 +30s 出画 16.5% 稳定 vs 开启永黑）。工具坑补遗：僵尸串口守护进程会偷 FIFO 命令行（重启实例先 pkill）；串口积压以分钟级消化，仅 boot 阶段可靠。当前 baseline QEMU（无 fastpath）保持运行、锁屏可见供观测；关机优先 guest `sync; poweroff`，串口失联时退 HMP system_powerdown+quit（rootfs 活跃写极少、有备份兜底）。repatch 范围：上游 #1775+#2313（调度器）、#2261+#2302（UserAccess/VMA 重写，根治锁饥饿）、移植 #2295/#2296/#2284。

- 上游吸收结果（2026-09-09）：repatch 完成于 merge c4a00deee（origin/dev 终态，26 个提交，含 #1775+#2313 调度器重建、#2261+#2302 UserAccess/VMA 重写）+ 接缝修复 fa91fc。结构剧变：axtask→components/ax-task（cpu/remote 远程调度器、PI 互斥体、safe-point 校验），axpoll 重写为类型化就绪能力、唤醒注册表移入新 crate axpoll-set，evdev 改为专用 evdev-irq-service 线程（register-before-park）——本地 #2296 兜底轮询随之作废未再移植，键鼠由上游 IRQ 路径负责（待 cocoa 实测）。本地保留：#2295（display/rtc board）、#2284 IN_FENCE_FD、dma-buf lseek、KMS 活跃状态回读（handle_get_plane 已改 Card0 方法以适配 #2313 UserTaskRef 签名）。
- 新树 panic 排障（2026-09-09）：deniald 启动即 `validate PI mutex blocking context failed`（上游 open bug #1709 同类）。诊断法：临时把 axruntime panic_shutdown 改 wfi 挂死 → gdbstub 事后抓栈；再在 axruntime validate_schedule_context 加临时 GUARD-DEBUG（guard 状态读数）+ 内核栈扫描（无 FP，扫 SP 起 2KB 内核态字，宿主 nm 符号化）。定锤：irq=0、baton=Finished、hard_irq=false、**arch_preempt_depth=1**；栈 = sys_connect → ax_net UnixSocket::start_connect（持 remote_addr SpinLock=禁抢占 guard）→ UnixNamespace::resolve → ext4 Inode::lookup_locked 争用 SleepMutex → 阻塞校验拒绝。根修 73293a874：bind/start_connect 在锁内仅占位地址，namespace 操作移出 SpinLock 临界区、失败回滚（上游 stream.rs 注释本就声明该锁层级意图）。红→绿：恐慌栈 → 修复后零恐慌 + 完整桌面。
- 新树基线（2026-09-09，待多次复核）：LP_NUM_THREADS=1 锁屏出画 <35s（旧树 t50s）；锁屏右上角 CPU 1%（旧树 99% sys 记账幻象消失）；空闲采样 248 样本 88.3% 为 WFI idle、零 can_access_range/prepare_user_memory 热点、零锁自旋——aspace 锁饥饿随 #2261/#2302 根治（AT 探测快路径已默认开启，无需 user-access-fastpath feature）。
- 工具坑补遗（2026-09-09）：QEMU 接 gdbstub 后 vCPU WFI 会推停机帧，断点监听须「停机→查 PC→非目标则 vCont;c 续跑」循环，且轮询停机流会把 guest 串口饿死——诊断用「panic 后挂死再附加」，不要全程附带 gdb。release 内核无帧指针，panic 内建 backtrace 输出 BT_ERROR unsupported，栈扫描+宿主符号化是可靠替代。ax-net clippy 在 macOS 宿主因 cpu-local 的 `.percpu.*` section 名不合法而失败，属环境限制（上游 CI 在 Linux ELF）。X11 目录现象：/tmp/.X11-unix 偶发在 mkdir 后、deniald 启动前消失（smithay 只删文件不删目录，机制未明），重跑 mkdir 再启动即可绕过；SOP §2 的 mkdir 步骤后应加存在性确认。
