# 设计契约验证工具：需求清单（Design Contract Verifier）

- 状态：需求清单（v0.1，2026-08-04）
- 定位：在构建 / CI 场景快速验证「代码实现逻辑 / 编译中间件 / 最终二进制」与「设计契约」一致
- 关联：`book/guideline/feature-development.md`（新功能前置研究）、`project/tgoskits-design-philosophy-moat`（配置组合验证是最薄环节）

## 1. 背景与问题

tgoskits 的设计哲学是「充分解耦、按需配置」，核心难点与护城河是**配置工程**。当前最薄的一环是**配置组合空间的可验证性**：

- **实证（#1803 GIC 回归）**：`arm-gic-driver` 模块逻辑本身符合硬件手册，但放到 QEMU 特定配置组合下启动挂死；CI 只覆盖了 `cargo xtask arceos test qemu`（test 套件路径）一个角落，漏掉 `cargo arceos qemu`（普通 app 启动路径）。
- **现状调研结论**：
  - 已有代码内契约校验（`scripts/axbuild/src/build/tests/checked_configs.rs` 遍历全部 checked-in toml、`build/info.rs` 的 `validate_features()` 互斥校验、TOML 根字段拒绝）——**但没有 CI job 显式运行它们**；
  - defconfig 是 xtask 子命令（由 board TOML 生成 build TOML）；构建配置为 TOML（`os/<system>/configs/board/*.toml`），无 JSON schema / 契约声明文件；
  - 启动验证雏形已有：qemu TOML 的 `success_regex`/`fail_regex`、`scripts/visual-test/` golden（CI 中注释）、backtrace symbolize；
  - `ktest` 未接入 CI；无「defconfig 组合冲突检查」job；
  - CI 矩阵（`.github/workflows/reusable-command.yml`）是现成的插入新 job 的位置。

**问题**：设计契约（配置组合合法性、能力依赖、产物结构、启动行为）分散在代码、config、CI 与测试中，没有单一事实源（SOT），也没有在构建/CI 的固定时点机械校验「实现是否符合契约」。

## 2. 目标与非目标

### 2.1 目标

一个 `contract-verify` 工具（xtask 子命令 + CI job），在构建/CI 场景分层校验：

| 层 | 校验对象 | 成本 |
|----|---------|------|
| L1 静态 | 配置/契约声明的一致性（defconfig 组合合法性、字段/feature 约束） | 毫秒级 |
| L2 编译期 | 中间产物（ELF symbol/section、kallsyms、rootfs 注入结果） | 秒级 |
| L3 运行 | 最终二进制行为（启动路径矩阵、差分对比） | 分钟级（矩阵裁剪） |

### 2.2 非目标

- 不做 seL4 级形式化证明（成本不可承受，无适用工具链）；
- 不替代功能测试（test-suit / LTP）；
- 不验证运行期动态语义（调度并发、锁序）——归运行测试；
- 不在第一个版本覆盖全部三层，按第 7 节优先级推进。

## 3. 契约表达（R1）

**R1.1 载体**：优先在现有 board/app TOML 中增加 `[contract]` 段（就近声明、复用现有复制/Snapshot 机制）；当同一契约被多系统共享时，允许独立 `contract/*.toml` 文件。注意：仓库无 `defconfig.toml` 文件——`defconfig` 是 xtask 子命令（由 board TOML 生成 build TOML）；内核运行时参数在 `configs/qemu/*.toml`（内含 `success_regex`/`fail_regex`），与 build config / 契约区分，不混入。

**R1.2 契约内容分类**（每个类别独立可裁剪）：

- **C1 配置契约**：feature 组合合法性——依赖（`requires`）、互斥（`conflicts`）、板级必需（`board_required`）、必选字段、未知字段/未知 feature 拒绝。语义复用并扩展现有 `validate_features()`。
- **C2 能力契约**：模块声明「我消费哪些能力」——以 rdif trait、`mmio-api`、`dma-api` 为能力标识；构建时校验消费方声明的能力在该 feature 组合下真实存在（从 ax-driver feature 树机械提取能力清单，避免手写漂移）。
- **C3 产物契约**：ELF 必须/禁止符号、section 存在性、kallsyms 注入结果、rootfs 必含文件、既有 `uefi → to_bin` 联动规则。
- **C4 行为契约**：启动路径 `success_regex`/`fail_regex`（扩展现有 qemu TOML 字段）、golden 日志/视觉快照（复用 visual-test 资产）。

**R1.3 表达语言**：TOML（与现有 config 一致），有限表达式仅支持布尔组合（如 `features.any(["nvme","virtio-blk"])`），不引入新 DSL。

**R1.4 单向来源**：契约是 SOT。代码/config 改动若违反契约，由校验器在构建时报错；契约本身纳入 review 门槛（改契约需独立 review，类似 feature-development 的接口审核）。

## 4. 验证层次与执行点（R2–R5）

**R2 静态校验（L1）**：xtask 子命令 `cargo xtask contract-check --config <toml>`，校验：
- C1：feature 组合合法性（依赖/互斥/板级必需）、未知字段/feature；
- C2：能力依赖在 feature 组合下存在；
- 遍历所有 checked-in config（复用 `checked_configs.rs` 的遍历模式，扩展检查项）。
进 static_checks（CI）。

**R3 编译期校验（L2）**：build 后置步骤：
- C3：对 ELF 做 symbol/section 断言（扩展 `rust-nm`/`objcopy` 既有链路）、kallsyms 注入成功、rootfs 注入结果符合契约；
- 失败即构建失败（非 warning）。

**R4 运行行为校验（L3）**：
- 启动路径矩阵：从契约自动生成「配置组合 × 架构」的最小启动用例集，每个用例跑 `success_regex`（保证 #1803 类问题被抓住：**每个组合必须含普通 app 启动路径**，不能只有 test 套件路径）；
- 差分：同一契约输入在 Linux（host 或 QEMU）与 StarryOS 上对比用户态可观察结果（遵循 `book/guideline/starry/syscall.md` 的差分要求）；
- 矩阵裁剪：按变更影响面（detect_changes 的 paths-filter 结果）只跑受影响组合，控制分钟级成本。

**R5 矩阵生成**：`contract-check --generate-matrix` 从契约声明产出测试矩阵 YAML（配置组合 × 架构 × 板级），带冲突检测与裁剪；输出可直接被 CI matrix include 消费。

## 5. CI 集成（R6）

- **接入既有资产**：
  1. `checked_configs.rs` 从「axbuild 单元测试」提升为显式 CI job（当前 CI 无 job 运行它）——最低成本的第一步；
  2. `ktest` 接入 CI（当前未接入）；
  3. `visual-test` golden 取消注释恢复（按需，P2）。
- **新增 job**：`contract-check`（静态，进 static_checks，与既有 sync-lint/spin-lint 并行、职责正交：lint 查代码风格/同步性，contract-check 查配置组合与契约一致性）；`contract-check --generate-matrix` 的输出喂给 reusable-command.yml 矩阵（进 test_checks）。`ktest` 接入 CI 属于运行行为验证（kernel 测试框架），与「不替代功能测试」不冲突——功能测试用 test-suit 覆盖完整语义，ktest/契约矩阵只做最小启动与契约断言。
- **约定**：self-hosted runner 的 matrix 项保持 `cache_key: ""`（遵循仓库既有约定，避免 rust-cache 破坏 runner 状态）。

## 6. 成功标准（R7）

1. **#1803 回归可被抓住**：若契约声明「qemu-aarch64 配置必须通过普通 app 启动路径」，则回归在 contract-check（L3 最小矩阵）下 CI 变红；
2. 所有 checked-in board config 通过静态校验（R2）；
3. 新板卡/新 feature 合入必须附契约声明，缺失或违反则 CI 失败；
4. 校验成本约束：L1+L2 总耗时 < 对应构建耗时；L3 只跑受影响组合；
5. 契约文件被 git 追踪且变更需 review。

## 7. 优先级

| 优先级 | 需求 | 说明 |
|--------|------|------|
| P0 | R1.1–R1.4 契约格式、R2 静态校验、R6-1（checked_configs 提升为 CI job）、**最小 L3**（复用 qemu TOML `success_regex` 跑普通 app 启动路径——#1803 验收用例） | 最小可行闭环，成本最低、收益最大 |
| P1 | R3 产物契约（symbol/section/kallsyms/rootfs）、R5 矩阵生成 | 覆盖中间件与矩阵自动化 |
| P2 | R4 运行行为（启动路径矩阵 + 差分）、ktest 接入 CI、visual-test 恢复 | 覆盖最终二进制，成本最高 |

## 8. 开放问题

1. 契约载体（board TOML `[contract]` 段）与行为契约数据所在（`configs/qemu/*.toml`）是两层文件：跨 TOML 的引用/归属未定义，而 #1803 恰发生在 qemu 组合层——需定规则（qemu TOML 的行为契约如何归属/被 board 契约引用）；
2. C2 能力契约如何从 rdif trait + ax-driver feature 树「机械提取」，避免手写清单漂移？需调研提取机制（宏/trait 反射）；
3. L3 差分测试的基线管理：锁定哪个 Linux 版本/commit 作比对基准（遵循 syscall.md 的版本记录要求）；
4. 工具落点：xtask 子命令（复用 axbuild config 解析）vs 独立 crate（可独立测试）？倾向 xtask 内先做，规模扩大再拆；
5. C4 行为契约与现有 `success_regex`/test-suit 的关系：是合并还是分层（契约=最小启动保证，test-suit=完整功能）？倾向分层。

## 9. 参考文献（prior art）

**内部（已核实，见调研记录）**：
- `scripts/axbuild/src/build/tests/checked_configs.rs`——遍历全部 checked-in toml 的校验模式
- `scripts/axbuild/src/build/info.rs`（`validate_features`）、`build/config_file.rs`（TOML 根字段拒绝）
- `os/<system>/configs/board/*.toml`、`os/arceos/configs/README.md`（board/qemu/defconfig 语义）
- `drivers/interface/rdif-*`、`memory/{mmio-api,dma-api}`（能力契约源）
- qemu TOML `success_regex`/`fail_regex`、`scripts/visual-test/`、`.github/workflows/reusable-command.yml`
- `book/guideline/starry/syscall.md`（差分验证与版本记录要求）

**外部（类别级，实现阶段需核版本）**：
- 配置契约：Linux Kconfig 依赖解析、Tock / RTIC 编译期配置验证
- 产物契约：libabigail（ABI 差分）、cargo-semver-checks（Rust crate 契约）、readelf/objdump 断言
- 源码契约：seL4 形式化证明（成本标杆，非目标）、Rust 类型/trait 契约
- 行为契约：差分测试（differential testing）、Linux Test Project（LTP）、golden 快照

## 10. 下一步建议

1. 启动 P0：起草 `[contract]` 段 TOML 草案（C1 起步）→ 扩展 `checked_configs.rs` 为通用静态校验器 → 加 CI job；
2. 用 #1803 的 qemu-aarch64 配置作为第一个验收用例（契约声明 app 启动路径，验证校验器能抓住回归）；
3. 调研 C2 能力提取机制（rdif/feature 树），与 P0 并行。
