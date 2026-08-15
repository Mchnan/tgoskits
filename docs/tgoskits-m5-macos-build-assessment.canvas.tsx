import {
  Stack, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider, CodeBlock, Grid, Row,
  useHostTheme,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

const hostHeaders = ["组件", "来源", "macOS 上的现状", "影响面"];
const hostAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const hostRows: Array<[string, string, string, string, TableRowTone]> = [
  [
    "QEMU ≥ 10.2.1",
    "docs/introduction/platform.md",
    "homebrew qemu 提供 aarch64/riscv64/x86_64；不提供 loongarch64",
    "LoongArch 路径需额外来源",
    "warning",
  ],
  [
    "gen_ksym / rust-nm / rust-objcopy / mkimage",
    "axbuild/src/starry/build.rs",
    "PATH 查找；rust-nm/-objcopy 由 cargo-binutils 装；gen_ksym 由 cargo install ksym；mkimage 在 u-boot-tools",
    "StarryOS kallsyms/uImage 必备",
    "info",
  ],
  [
    "debugfs / e2fsck / resize2fs",
    "axbuild/src/rootfs/{inject.rs,resize.rs}",
    "resize.rs 已经为 macOS 写 /opt/homebrew/opt/e2fsprogs/sbin/ fallback；inject.rs 默认调 debugfs",
    "homebrew e2fsprogs 提供 debugfs；overlay 写语义未在 macOS 验证",
    "info",
  ],
  [
    "fakeroot",
    "axbuild/src/rootfs/inject.rs",
    "cfg(target_os=linux) 决定何时启用 fakeroot；非 Linux 走 effective_uid!=0 强制 fakeroot",
    "需 brew install fakeroot",
    "info",
  ],
  [
    "systemd-nspawn / losetup / mount / debootstrap / chroot",
    "scripts/prepare-selfhost-rootfs.sh",
    "macOS 不存在；自编译脚本整体不可用",
    "scripts/{prepare-selfhost-rootfs,self-compile,run-selfbuilt-kernel}.sh 不能跑",
    "danger",
  ],
  [
    "expect / debugfs（脚本侧）",
    "scripts/self-compile.sh",
    "expect 可装；debugfs 见上",
    "自编译路径阻塞",
    "warning",
  ],
  [
    "musl 交叉工具链",
    "axbuild/src/build/std_build.rs、container/Dockerfile",
    "容器内预装 aarch64/riscv64/x86_64/loongarch64-musl；macOS host 需手工配",
    "loongarch64 唯一可靠来源是容器",
    "warning",
  ],
  [
    "OVMF",
    "scripts/run-selfbuilt-kernel.sh",
    "homebrew 不提供；可 brew install edk2-ovmf",
    "x86_64 UEFI 自编译必备",
    "warning",
  ],
  [
    "Linux 内核工具 (losetup 等)",
    "scripts/prepare-selfhost-rootfs.sh",
    "macOS 不存在",
    "自编译三脚本整体 fail",
    "danger",
  ],
];
const hostRowTone: Array<TableRowTone | undefined> = hostRows.map((r) => r[4]);
const hostTableRows = hostRows.map(([a, b, c, d]) => [a, b, c, d]);

const qemuHeaders = ["架构", "路径来源", "难度", "备注"];
const qemuAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const qemuRows: Array<[string, string, string, string, TableRowTone]> = [
  [
    "qemu-system-aarch64",
    "brew install qemu",
    "低",
    "homebrew 版本 ≥10.2.1，满足最低要求",
    "success",
  ],
  [
    "qemu-system-riscv64",
    "brew install qemu",
    "低",
    "同上",
    "success",
  ],
  [
    "qemu-system-x86_64",
    "brew install qemu",
    "低",
    "macOS 无 /dev/kvm；脚本 -enable-kvm 分支落回 TCG（self-compile.sh:67-76）",
    "warning",
  ],
  [
    "qemu-system-loongarch64",
    "homebrew-core 不提供；LoongArch 团队单独分发 + OVMF-LA",
    "中",
    "从 loongson/la32r-qemu 或社区二进制安装",
    "warning",
  ],
  [
    "qemu-system-loongarch64（LVZ）",
    "仅 ghcr.io/rcore-os/tgoskits-container-axvisor-lvz:latest",
    "中-高",
    "macOS 上 docker cp 拉出来用；或直接在容器内跑（方案 B）",
    "danger",
  ],
];
const qemuRowTone: Array<TableRowTone | undefined> = qemuRows.map((r) => r[4]);
const qemuTableRows = qemuRows.map(([a, b, c, d]) => [a, b, c, d]);

const toolchainHeaders = ["方案", "覆盖架构", "获取方式", "风险"];
const toolchainAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const toolchainRows: Array<[string, string, string, string, TableRowTone]> = [
  [
    "A. lima/colima Ubuntu VM",
    "全部",
    "brew install lima；装 musl + qemu + e2fsprogs + mkimage + gen_ksym",
    "接近 native Linux；脚本能跑；I/O 经 9p/virtiofs，比裸 Linux 慢",
    "info",
  ],
  [
    "B. Podman/OrbStack 容器（推荐）",
    "全部",
    "brew install orbstack；启动 ghcr.io/rcore-os/tgoskits-container:latest",
    "与 CI 字节级一致；不修改 host；走 Docker mount，guest rootfs 注入需在容器内做",
    "success",
  ],
  [
    "C. macOS host 直跑",
    "aarch64/riscv64/x86_64",
    "brew install qemu e2fsprogs u-boot-tools；cargo install cargo-binutils ksym；手工装 musl 交叉工具链",
    "LoongArch 必装自编译 QEMU；不跑自编译脚本",
    "warning",
  ],
  [
    "D. colima + lima Ubuntu VM",
    "全部",
    "同 A，共享 host 仓库目录",
    "与 A 几乎一致；共享目录性能比 9p 略好",
    "info",
  ],
];
const toolchainRowTone: Array<TableRowTone | undefined> = toolchainRows.map((r) => r[4]);
const toolchainTableRows = toolchainRows.map(([a, b, c, d]) => [a, b, c, d]);

const xtaskHeaders = ["命令", "macOS host 是否可执行", "备注"];
const xtaskAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const xtaskRows: Array<[string, string, string, TableRowTone]> = [
  [
    "cargo xtask clippy --package <crate>",
    "✅",
    "纯 host Rust",
    "success",
  ],
  [
    "cargo xtask test (host-only)",
    "✅",
    "仅 scripts/test/std_crates.csv 内的纯 std crate",
    "success",
  ],
  [
    "cargo xtask arceos build/qemu --target {aarch64,riscv64,x86_64}",
    "✅",
    "freestanding target；不调 cc；只需 QEMU",
    "success",
  ],
  [
    "cargo xtask arceos build/qemu --target loongarch64",
    "⚠️",
    "需 qemu-system-loongarch64 和 musl 工具链（若用 std）",
    "warning",
  ],
  [
    "cargo xtask starry build/qemu --target {aarch64,riscv64,x86_64}",
    "✅",
    "freestanding；需 cargo install ksym + brew install u-boot-tools",
    "success",
  ],
  [
    "cargo xtask starry qemu --target loongarch64",
    "⚠️",
    "同上 + qemu-system-loongarch64",
    "warning",
  ],
  [
    "cargo xtask starry rootfs --arch <arch>",
    "✅",
    "走 debugfs + e2fsck + resize2fs；装好 e2fsprogs 后能跑；overlay 注入未在 macOS debugfs 验证",
    "warning",
  ],
  [
    "cargo xtask starry test qemu",
    "✅",
    "内部驱动 QEMU；不依赖 Linux-only 工具",
    "success",
  ],
  [
    "cargo xtask starry test qemu --arch loongarch64",
    "⚠️",
    "同上",
    "warning",
  ],
  [
    "cargo xtask axvisor build/qemu --arch {aarch64,riscv64,x86_64}",
    "✅",
    "freestanding 路径",
    "success",
  ],
  [
    "cargo xtask axvisor build/qemu --arch loongarch64",
    "❌",
    "必须用 tgoskits-container-axvisor-lvz（LVZ）；纯 macOS host 不可行",
    "danger",
  ],
  [
    "cargo xtask axvisor test qemu",
    "✅",
    "按架构降级",
    "success",
  ],
  [
    "cargo xtask starry kmod build --module <path>",
    "✅",
    "kmod.rs 调 host 的 make 和 cc；若 host 没装 gcc 或对应 arch 工具链会 fail",
    "warning",
  ],
  [
    "cargo xtask board ...",
    "❌",
    "macOS 没有 /dev/ttyUSB*；走 ostool-server + Linux 网络栈",
    "danger",
  ],
  [
    "scripts/prepare-selfhost-rootfs.sh",
    "❌",
    "调 losetup / systemd-nspawn / debootstrap / chroot / debugfs -w",
    "danger",
  ],
  [
    "scripts/self-compile.sh",
    "❌",
    "同上 + sudo losetup",
    "danger",
  ],
  [
    "scripts/run-selfbuilt-kernel.sh",
    "❌",
    "同上 + x86_64 路径还要 OVMF",
    "danger",
  ],
];
const xtaskRowTone: Array<TableRowTone | undefined> = xtaskRows.map((r) => r[4]);
const xtaskTableRows = xtaskRows.map(([a, b, c]) => [a, b, c]);

const gapHeaders = ["缺失能力", "影响脚本/命令", "缓解"];
const gapAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const gapRows: Array<[string, string, string, TableRowTone]> = [
  [
    "systemd-nspawn",
    "prepare-selfhost-rootfs.sh",
    "docker run --privileged 替代；或在 lima VM 里",
    "warning",
  ],
  [
    "losetup + 写 ext4 mount",
    "prepare-selfhost-rootfs.sh / self-compile.sh",
    "macOS hdiutil attach -imagekey diskimage-class=CRawDiskImage -nomount 可挂 raw ext4，但写语义不一致；不推荐",
    "danger",
  ],
  [
    "/dev/kvm",
    "run-selfbuilt-kernel.sh --arch x86_64 的 -enable-kvm",
    "脚本已降级到 IvyBridge + TCG，会慢",
    "warning",
  ],
  [
    "fakeroot / Linux capabilities",
    "axbuild/src/rootfs/inject.rs:188",
    "非 Linux 走 effective_uid!=0 → 强制 fakeroot；brew install fakeroot 后即可",
    "info",
  ],
  [
    "OVMF 路径",
    "run-selfbuilt-kernel.sh:188-200",
    "brew install edk2-ovmf 装到 /opt/homebrew/share/edk2-ovmf/；需在脚本里加 fallback 或临时修改脚本",
    "warning",
  ],
  [
    "musl 工具链 prefix",
    "std_build.rs:96",
    "messense/macos-cross-toolchains（aarch64/x86_64）；riscv64/loongarch64 走 embecosm 或容器提取",
    "warning",
  ],
  [
    "docker socket",
    "CI 镜像",
    "OrbStack / Docker Desktop / colima 任选",
    "info",
  ],
  [
    "glibc 不兼容的预编译 binary",
    "部分 rootfs/镜像里的二进制",
    "容器路径回避",
    "info",
  ],
];
const gapRowTone: Array<TableRowTone | undefined> = gapRows.map((r) => r[4]);
const gapTableRows = gapRows.map(([a, b, c]) => [a, b, c]);

const matrixHeaders = ["系统", "架构", "推荐路径", "覆盖"];
const matrixAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const matrixRows: Array<[string, string, string, string, TableRowTone]> = [
  [
    "ArceOS",
    "riscv64 / aarch64 / x86_64",
    "路径 2（macOS host）+ homebrew qemu",
    "✅",
    "success",
  ],
  [
    "ArceOS",
    "loongarch64",
    "路径 1（容器）",
    "✅",
    "info",
  ],
  [
    "StarryOS",
    "riscv64 / aarch64 / x86_64",
    "路径 2 + cargo install ksym + brew install u-boot-tools e2fsprogs",
    "✅",
    "success",
  ],
  [
    "StarryOS",
    "loongarch64",
    "路径 1",
    "✅",
    "info",
  ],
  [
    "Axvisor",
    "aarch64 / riscv64 / x86_64",
    "路径 2",
    "✅",
    "success",
  ],
  [
    "Axvisor",
    "loongarch64（LVZ）",
    "路径 1 + axvisor-lvz 镜像",
    "✅",
    "info",
  ],
  [
    "kmod build",
    "任意",
    "macOS host 装好 gcc + arch 工具链",
    "✅ host-arch 一致时",
    "warning",
  ],
  [
    "prepare-selfhost-rootfs.sh + self-compile.sh",
    "riscv64/x86_64/aarch64",
    "路径 3（lima VM）或路径 1 容器内跑",
    "⚠️ macOS host 不可行",
    "warning",
  ],
  [
    "cargo xtask board *",
    "物理板",
    "macOS 没 /dev/ttyUSB*；物理板流程无意义",
    "❌",
    "danger",
  ],
];
const matrixRowTone: Array<TableRowTone | undefined> = matrixRows.map((r) => r[4]);
const matrixTableRows = matrixRows.map(([a, b, c, d]) => [a, b, c, d]);

export default function TgoskitsM5BuildAssessment(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={20} style={{ padding: 28 }}>
      <Stack gap={6}>
        <H1>M5 arm64 macOS 上 TGOSKits 构建/测试方案集</H1>
        <Text style={{ color: theme.text.secondary }}>
          基于 docs/、scripts/axbuild/、scripts/ 三处源码静态评估；项目未在 macOS 上做过端到端验证。
        </Text>
      </Stack>

      <Callout tone="warning" title="评估前提">
        <Text>
          本方案集是源码静态评估，不是实测结论。axbuild 的 host 抽象大部分假设 Linux（losetup、mount、systemd-nspawn、fakeroot capabilities、/dev/kvm）；macOS 路径上每打通一个组件都需要单独验证。
        </Text>
      </Callout>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="184" label="workspace 成员 crate" tone="info" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="4" label="目标架构（aarch64/riscv64/x86_64/loongarch64）" tone="info" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="17" label="scripts/prepare-selfhost-rootfs.sh 缺失的 Linux 工具" tone="danger" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="2" label="容器镜像（base + axvisor-lvz）覆盖 loongarch64-LVZ" tone="warning" />
          </CardBody>
        </Card>
      </Grid>

      <Divider />

      <Card>
        <CardHeader>
          <H2>1. 宿主硬性约束</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              先认清 axbuild 与 scripts/ 在 macOS 上的硬性边界。下面这张表列出所有外部依赖、来源、macOS 上的现状与影响面，是后续路径选择的依据。
            </Text>
            <Table
              headers={hostHeaders}
              rows={hostTableRows}
              columnAlign={hostAlign}
              rowTone={hostRowTone}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>2. QEMU 方案（按架构分类）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              标准 QEMU 通过 homebrew-core 装即可拿到三架构；LoongArch 走 LoongArch 社区二进制或自编译；LVZ 扩展唯一保真来源是 CI 容器。
            </Text>
            <Table
              headers={qemuHeaders}
              rows={qemuTableRows}
              columnAlign={qemuAlign}
              rowTone={qemuRowTone}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>3. 交叉编译工具链方案</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              axbuild/src/build/std_build.rs 用 CC_&lt;TARGET&gt; / AR_&lt;TARGET&gt; / CFLAGS_&lt;TARGET&gt; 选择交叉 C 工具链。freestanding 路径只调 rustc，不调 cc；只有 ax-std / app-c 触发 musl 工具链检查。下面四个方案按"贴近 CI"到"贴近 host"排列。
            </Text>
            <Table
              headers={toolchainHeaders}
              rows={toolchainTableRows}
              columnAlign={toolchainAlign}
              rowTone={toolchainRowTone}
            />
            <Callout tone="info" title="好消息">
              <Text>
                StarryOS 内核、Axvisor 镜像、ArceOS no-std 子模块都是 freestanding target，只走 rustc，不需要外部 cc 工具链。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>4. axbuild/xtask 在 macOS 的可执行性矩阵</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              按当前源码静态判断每个命令在 macOS host 上是否能直接执行。结果用 ✅ / ⚠️ / ❌ 三档：✅ = 装齐依赖即可；⚠️ = 需要额外 QEMU 或镜像；❌ = 必须走容器或 Linux VM。
            </Text>
            <Table
              headers={xtaskHeaders}
              rows={xtaskTableRows}
              columnAlign={xtaskAlign}
              rowTone={xtaskRowTone}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>5. 按风险最小排序的三条落地路径</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <H3>路径 1：CI 容器一致路径（推荐，先跑通）</H3>
            <CodeBlock
              language="bash"
              code={`brew install orbstack   # 或 colima / Docker Desktop
docker pull ghcr.io/rcore-os/tgoskits-container:latest

# 容器内
cargo starry defconfig qemu-riscv64 && cargo starry qemu
cargo arceos defconfig qemu-aarch64 && cargo arceos qemu
cargo xtask clippy --package axerrno
cargo xtask test                # host-only std crate 测试`}
            />
            <Text>
              预期：所有架构走通，除了 LoongArch（容器自带 qemu-system-loongarch64 但缺 LVZ）。LoongArch-LVZ 路径换 tgoskits-container-axvisor-lvz 镜像。
            </Text>

            <H3>路径 2：纯 macOS host（最快反馈，但要装一堆工具）</H3>
            <CodeBlock
              language="bash"
              code={`brew install qemu e2fsprogs u-boot-tools rustup-init
rustup-init
rustup component add llvm-tools-preview rustfmt clippy rust-src
cargo install cargo-binutils ksym

brew install messense/macos-cross-toolchains/aarch64-unknown-linux-musl \\
                 messense/macos-cross-toolchains/x86_64-unknown-linux-musl

# riscv64 musl：从 embecosm 预编译或自建
# loongarch64 musl：唯一来源是容器内提取

export PATH="/opt/homebrew/opt/e2fsprogs/sbin:$PATH"`}
            />
            <Text>
              完成后跑与路径 1 相同的 xtask 命令（除 LVZ）。优势是没有 mount/namespace 抽象层，反馈最快。
            </Text>

            <H3>路径 3：Lima VM（最贴近 native Linux）</H3>
            <CodeBlock
              language="bash"
              code={`brew install lima
limactl start --arch=aarch64 --cpus=8 --memory=16 template://ubuntu-24.04

# VM 内装齐 musl + e2fsprogs + qemu-system-loongarch64 + expect
# 共享仓库目录
scripts/prepare-selfhost-rootfs.sh --arch x86_64
scripts/self-compile.sh --arch x86_64
scripts/run-selfbuilt-kernel.sh --arch x86_64`}
            />
            <Text>
              走路径 3 是唯一能在 macOS 上跑 prepare-selfhost-rootfs.sh / self-compile.sh / run-selfbuilt-kernel.sh 三脚本的方案。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>6. macOS host 上要"自己实现"的差异点</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              这些点 axbuild 与脚本都默认 Linux 行为，macOS 上需要手动补齐或绕开。
            </Text>
            <Table
              headers={gapHeaders}
              rows={gapTableRows}
              columnAlign={gapAlign}
              rowTone={gapRowTone}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>7. 最低可执行矩阵（仅验证 xtask 闭环，不做板级）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              这一节给出三套系统 × 四架构的最低可行性结论。✅ 表示有现成路径；⚠️ 需要降级或换镜像；❌ 在 macOS host 上不可行。
            </Text>
            <Table
              headers={matrixHeaders}
              rows={matrixTableRows}
              columnAlign={matrixAlign}
              rowTone={matrixRowTone}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>8. 建议的"先求稳"落地顺序</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Row gap={10} align="start">
              <Pill tone="success">1</Pill>
              <Text>
                先走路径 1（容器镜像），把 cargo starry defconfig qemu-riscv64 && cargo starry qemu 跑通；与 CI 字节级一致，能跑出"今天能不能改 axbuild"的最小信号。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">2</Pill>
              <Text>
                再走路径 2（macOS host），把 riscv64/aarch64/x86_64 三架构的 StarryOS/ArceOS/Axvisor 全部跑成；验证 host-only 路径不依赖容器。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">3</Pill>
              <Text>
                物理板和自编译脚本走路径 3（lima VM）或继续在容器里。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="danger">4</Pill>
              <Text>
                不要在 macOS host 上尝试 LoongArch64 LVZ 路径，唯一靠谱来源是 tgoskits-container-axvisor-lvz:latest，容器内运行最稳。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">5</Pill>
              <Text>
                把"macOS homebrew + 容器"的差异写进 .claude/skills/arch-platform-porting/SKILL.md 的本地补充；与 AGENTS.md 中"维护 arch-platform-porting 时与变更一起更新"的约束对齐。
              </Text>
            </Row>
          </Stack>
        </CardBody>
      </Card>

      <Divider />

      <Card>
        <CardHeader>
          <H2>9. 关键证据文件（点击跳转）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>
              本评估引用了以下文件，所有判断都以这些位置为准：
            </Text>
            <CodeBlock
              language="text"
              code={`docs/introduction/platform.md         QEMU 与容器镜像基线
docs/build/ci.md                       CI 三层架构 + 自编译 runner 矩阵
docs/quickstart/overview.md            推荐的容器启动命令
docs/quickstart/starryos.md            StarryOS QEMU/板级快速上手
docs/development/components.md         组件改动验证矩阵
scripts/axbuild/src/build/std_build.rs musl 工具链与 rust-lld 包装器
scripts/axbuild/src/rootfs/inject.rs   debugfs + fakeroot 注入路径
scripts/axbuild/src/rootfs/resize.rs   e2fsprogs 路径（已留 macOS fallback）
scripts/axbuild/src/starry/build.rs    gen_ksym / mkimage / rust-objcopy 调用点
scripts/prepare-selfhost-rootfs.sh     losetup / systemd-nspawn / debootstrap
scripts/self-compile.sh                expect + sudo losetup + 循环控制
scripts/run-selfbuilt-kernel.sh        OVMF 路径探测 + self-compile 输出提取
.cargo/config.toml                     cargo xtask / arceos / starry / axvisor 别名
container/Dockerfile                   CI 镜像构建起点
.claude/skills/arch-platform-porting/  平台移植相关维护约定（建议同步补充）`}
            />
          </Stack>
        </CardBody>
      </Card>

      <Divider />

      <Stack gap={4}>
        <Text style={{ color: theme.text.tertiary }}>
          本文档基于 TGOSKits 仓库 docs/、scripts/axbuild/、scripts/ 当前源码静态评估生成；项目处于积极开发中，未在 macOS M5 arm64 host 上做过端到端验证，建议以最新源文档与 CI 镜像为准。
        </Text>
      </Stack>
    </Stack>
  );
}