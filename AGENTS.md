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
- 修改 Rust 代码后使用项目适配的 `cargo xtask clippy` 检查受影响的软件包及功能组合。未提交的改动使用 `cargo xtask clippy --package <软件包>`；`cargo xtask clippy --since <引用>` 只选择相对引用已提交的差异，使用前须确认本次改动已提交且选中受影响软件包。只有改动范围确实涉及全工作区时才使用 `cargo xtask clippy` 或 `cargo xtask clippy --all`，不得用原生 `cargo clippy` 命令代替。
- 改动需要标准库测试证明行为时，使用 `cargo xtask test --since <引用>` 验证受影响的软件包，并确认本次改动已提交且相应软件包被选中。直接修改 `scripts/test/std_crates.csv` 白名单时，白名单路径本身不会被 `--since` 选中；按 `update-std-tests` 验证变更条目。该入口不支持按软件包选择，不得用原生 `cargo test` 命令代替。
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
- 提交拉取请求前，按本次改动选择受影响软件包的 `cargo xtask clippy`，以及覆盖受影响行为与目标的定向 QEMU 或板卡测试；没有对应运行时影响时不强制运行 QEMU 或板卡。无需在本地复跑完整持续集成流程、全工作区 Clippy 或无关的架构与用例矩阵。
- 实体板卡或自托管环境无法本地执行时，在拉取请求中说明受影响而未验证的目标及原因。只修改文档或技能且不影响构建或测试时，按 2.1 节检查差异和引用即可。开发过程中由 2.1 节及适用技能要求的格式化、标准库测试和确定性回归证明仍按改动需要执行，不因提交拉取请求额外扩大范围。
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

- 六仓关系（Mchnan GitHub 总图，2026-10-11 第十二轮更新，可视版 `docs/starry-venus-repo-map.canvas.tsx`）：全部 venus 栈工作落在六个仓，本地目录 ↔ 远端一一对应——(1) **Mchnan/tgoskits**（fork rcore-os/tgoskits，remote 名 `Mchnan` HTTPS）：主线分支 `venus-into-dev-1011`（本地名 `local/venus-into-dev-1011`，第十二轮重落地轮，基线 origin/dev `ea1212b92`，HEAD `本分支顶端`，venus 面已按上游可移植 GPU 栈重落地）；旧验证态分支 `venus-into-dev-0924` 保留作十/十一轮证据；含 guest 内核 card0 venus 面、崩溃取证、设计文档与缺陷总账画布；构建入口 `cargo xtask starry build --arch aarch64 --target aarch64-unknown-none-softfloat --config os/StarryOS/configs/board/qemu-aarch64.toml`（需 `BINDGEN_EXTRA_CLANG_ARGS=--sysroot=<musl sysroot>`，sysroot=/opt/homebrew/Cellar/aarch64-unknown-linux-musl/15.2.0/toolchain/aarch64-unknown-linux-musl/sysroot），产物 `target/aarch64-unknown-none-softfloat/release/starryos.bin`。
(5) **Mchnan/denial**（API fork denialwm/denial）：第十二轮起跟进分支 `venus-into-upstream-1011`（本地 `~/denial`，基线 origin/main `c56aa2d`，present 修复按新基线重写落地 `eeaa548`）；旧验证态 `venus-stack-e2e`（3cab163）保留。其余四仓（virglrenderer-darwin `0b8b4914`、qemu darwin-venus `1961a80`、MoltenVK `fd31714`、venus-stack-scripts `94657db`）不变，本地路径与构建口径照旧。凭据与 GitHub 操作口径：gh CLI 不存在；`git credential fill`（osxkeychain 的 gho_ token，api user=Mchnan）+ curl REST API 可 fork/建仓/提 issue；推送直接 `git push <remote>`。
- 上游跟进与 venus 面重落地（2026-10-11 第十二轮，`local/venus-into-dev-1011`，基线 origin/dev `ea1212b92`）：**上游 dev 自 #2483/#2506/#2536/#2557 重构出可移植 GPU 栈（rdif VirglOps + async ctrl 队列 + card0/{virtgpu,virtgpu_uapi}），并合入我们的 PR #2284/#2365；上游今日是 virgl 面——CONTEXT_INIT 拒 capset 4、HOST_VISIBLE 恒 0、EXECBUFFER 拒 syncobj、无 hostmem/MAP_BLOB/DRM_CAP_SYNCOBJ_TIMELINE，mesa venus 完全跑不起来**。本轮把十一轮前的 venus 面按新架构重写落地（提交 `ffb3fed43`）：(a) 驱动层 wire/DEVICE/rdif/axgpu 全链加 MAP/UNMAP_BLOB（0x0208/0x0209）、`with_fence_ring`（INFO_RING_IDX）、`HostMemRegion.attach_hostmem`、`VirglOps` 扩 `map_blob/unmap_blob/submit_ring/host_memory_region`（带默认实现向后兼容）、ax-driver PCI 解析 SHARED_MEMORY_CFG 后探针注入；(b) 内核层新模块 `card0/syncobj.rs`（syncobj 全族 + watermark 模型 + eventfd/sync-file 等待者 + **retire 改 `fence_completed` 轮询泵**——orphan 注册表竞态随轮询模型天然消失）；card0/virtgpu.rs 加 venus 分支（CONTEXT_INIT 按宿主 capset 列表放行、GETPARAM HOST_VISIBLE 随 hostmem 真实上报、CREATE_BLOB venus 路径 = HOST3D 无 guest shadow/16KiB BAR 槽位/即时映射/DEFER_MAPPING 提示、EXECBUFFER = RING_IDX + out/in syncobj + `submit_ring`）；card0.rs 接 syncobj 分发 + GET_CAP 上报 0x13/0x14（无条件，与旧验证行为一致）+ legacy ADDFB(0xAE) 合成 + blob mmap 键 1<<40 起路由 `PhysicalCachedResolved`（上游已备好该变体）+ GpuResource 挂 `mapped_blob`（Drop 先 UNMAP 再 UNREF）+ PRIME 别名经 blob_aliases 共享映射；virtgpu_uapi.rs 补 v6.15 `blob_hints` 56B 尾部。**上游吸收判定**：connector pmode 来源（display 控制器总以宿主 pmode 注册）与 axdisplay 判空降级（`DisplayResult` 错误域）、fb0 门禁（`has_display()`）均被上游结构性取代，不再携带。随行修复：ax-net unix 自旋锁内命名空间解析（cherry-pick）、崩溃取证四件套（cherry-pick）、**MODE_ATOMIC 无界 vm_load 加 1024/8192 上限（上游今日真实内核 DoS，审计发现）**。验证：`cargo xtask starry build`（aarch64 deny-warnings）过、clippy {virtio-gpu,rdif-gpu,starry-kernel} 过、fmt 干净、ioctl 字回归测试随端口带入；ax-driver 宿主 clippy 的 link_section Mach-O 报错为上游基线缺口。**未验证：vkprobe/桌面 e2e 需 venus 栈 QEMU 复测**。
- Linux 构建机验证（2026-10-11 第十二轮补记）：**「本机不可达」的旧判断作废——构建机就是本机 QEMU arm64 VM**（`~/arm64-buildVM`，`vm.qcow2` 41G，记忆口径逆向还原：`qemu-system-aarch64 -machine virt,highmem=on -cpu host -accel hvf -smp 8 -m 12G ... -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 -display none`，SSH `ssh -i ~/.ssh/arm64build -p 2222 build@127.0.0.1`，VM 内 rust 1.98、cargo 缓存热）。VM 内浅克隆 `venus-into-upstream-1011` 后 `cargo build --release --features flutter` 通过（deniald 18M、2m22s，0 error；两条 dead-code 警告恰证 fence 降级补丁语义生效——**`FatalRender` 变体成零构造点**；deniald 需要 `--features flutter`（含 kms+control），裸 `cargo build` 只出 lib）。产物就绪待 e2e 注入（staging/ + inject-denial-full.py + debugfs + MD5 回读）。汇报画布：`docs/starry-round12-upstream-follow-report.canvas.tsx`（lint 三门全过）。
- denial 上游跟进与 present 修复重落地（2026-10-11 第十二轮，`~/denial` 分支 `venus-into-upstream-1011`，基线 origin/main `c56aa2d`）：**上游 main 领先本地 187 提交（Flutter fork 推进 offscreen-target 复用/Slimpeller 默认/输出管线重构），但 present 链三处 R6 级缺陷原样存在**：(1) `--denial-gl-fbo-zero-is-no-target` 仍只对 Impeller 传，Skia 路径（文档化支持路径）root present 被静默丢弃；(2) native fence create/export 失败 → FatalRender → `std::process::abort()`，无 EGL_ANDROID_native_fence_sync 的栈第一帧即死（发布链本就有 None 分支）；(3) 渲染期无 FBO 完整性复检（KNOWN_ISSUES 自认 live scale 改变 36054 崩溃终结会话）。修复按重构后代码重写落 `eeaa548`：标志提升出 impeller 分支、每帧 `check_framebuffer_status`（失败跳帧，broker 下一事务回收 Rendering 槽）、fence 失败降级 glFinish + 无 fence 发布。验证：`cargo check -p denial-flutter-engine` 过；denial 主包因上游依赖 reis 的 Linux-only socket API 在 macOS 无法整包编译（符号经核对：check_framebuffer_status 在 gl.rs 加载器、None 分支在 publish 链、无死代码）。**3cab163 的第 4 部分（liveness_probe/生命周期诊断）未移植**——上游 flutter_event_loop.rs 重写 3125 行，接线点全变，需按新循环重写，列为待办。
- denial pure Wayland 画布按新基线校准（2026-10-11 第十二轮，`docs/starryos-denial-pure-wayland.canvas.tsx`，lint 三门全过）：**上游 a974c10「Make Xwayland optional」已落 `--no-xwayland` CLI 开关**（options.rs:297 解析、:355 usage、默认值 `cfg!(feature = "xwayland")` 且 feature 仍在 default 集），spawn 按 `xwayland_enabled` 门控、禁用路径 xwayland.rs:82 提前返回 `active: None` 不碰 socket，`XWaylandState.active` 整体 Option 化（旧基线「xwayland_client 非可选需 guard」的退路问题消失）；画板论断由「无条件 spawn、需自补开关」校准为「上游开关已备好，落地收敛为启动参数验证 + 启动流程去 mkdir」，证据锚点全部重定位并附 8 位 lineSha 内容指纹（行号漂移可自动发现），清除不存在的 `sop-run-starryos-denial-qemu.md` 幽灵引用，补缺陷总账/汇报画板交叉链接。
- 上游今日缺陷总账（2026-10-11 第十二轮审计，可视版 `docs/starry-upstream-defects-ledger.canvas.tsx`）：**tgoskits origin/dev**（14 缺陷 + 7 能力缺口）：D1 MODE_ATOMIC 无界分配（高，本轮已修）；D2 CREATE_BLOB UAPI 48B 缺 v6.15 尾部（中，本轮已修）；D3 create_blob 命令顺序与 Linux sg 语义相反（中，virgl e2e 未覆盖）；D4 dumb/ADDFB2 双 resource-id 计数器同键空间重叠（中，结构性地雷）；D5 in-fence 只 downcast 不等待、reset 换代后误判完成（中低）；D6 ctrl QueueFull 重试槽泄漏（低）；D7 restore_framebuffer_scanout 不交付（低）；D8 blob 8MiB 一刀切/shadow 浪费/pad 未校验（低，venus 分支本轮已修）；D9 GET_CAPS 一页硬顶（低）；D10 ADDFB2 校验缺口（低）；D11 out-fence fd install 顺序反（低）；D12 WAIT_VBLANK EINTR/上限偏差（低）；D13 fb.rs expect 群 + refresh_task 永久 60Hz 持锁（低）；D14 device_mmap 超长静默截断（低）。能力缺口 = syncobj 全族、SHARED_MEMORY_CFG/hostmem、MAP/UNMAP_BLOB、venus capset、EDID、cross-device、cursor/多 scanout（前三者本轮重落地）。**denial origin/main**（9 项）：Skia 缺 fbo-zero 标志（高）、软件 EGL 无 fence 即 abort（高）、渲染期无 FBO 复检（中高）、pending_output_presentation 卡死无恢复（中）、finish_transaction/Xwayland/kms_pipeline 的 expect 群（低-中低）、surface 销毁与窗口驱逐非原子（中，上游唯一 TODO）、KNOWN_ISSUES 自认未解项（中）。上游缺陷审计方法论：以我们缺陷总账的已知模式为清单对上游新代码逐项 grep + 读路径，区分「真实缺陷（做了但有错）」与「能力缺口（刻意未做）」。
