import {
  Stack, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider, CodeBlock, Grid, Row,
  useHostTheme,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

const hostHeaders = ["组件", "macOS 上的现状", "影响"];
const hostAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const hostRows: Array<[string, string, string, TableRowTone]> = [
  [
    "qemu-system-aarch64",
    "brew install qemu 直接拿到，CI 要求 ≥10.2.1，homebrew 版本满足",
    "无",
    "success",
  ],
  [
    "gen_ksym / mkimage / rust-nm / rust-objcopy",
    "PATH 查找：cargo install ksym；brew install u-boot-tools；cargo install cargo-binutils",
    "StarryOS kallsyms/uImage 必备",
    "info",
  ],
  [
    "debugfs / e2fsck / resize2fs",
    "brew install e2fsprogs；resize.rs 已留 /opt/homebrew/opt/e2fsprogs/sbin/ fallback",
    "需 export PATH=/opt/homebrew/opt/e2fsprogs/sbin:$PATH",
    "info",
  ],
  [
    "fakeroot",
    "inject.rs 在非 Linux 上 effective_uid!=0 即强制 fakeroot；brew install fakeroot 即可",
    "rootfs overlay 注入必备",
    "info",
  ],
  [
    "aarch64-linux-musl 交叉工具链",
    "brew install messense/macos-cross-toolchains/aarch64-unknown-linux-musl",
    "freestanding 路径用不到；ax-std / app-c 路径触发",
    "info",
  ],
  [
    "OVMF（仅 x86_64 UEFI）",
    "AArch64 路径不走 UEFI",
    "无",
    "success",
  ],
  [
    "systemd-nspawn / losetup / debootstrap",
    "macOS 不存在；仅 scripts/{prepare-selfhost-rootfs,self-compile,run-selfbuilt-kernel}.sh 依赖",
    "自编译脚本不可跑；xtask/星 QEMU 路径无影响",
    "info",
  ],
];
const hostRowTone: Array<TableRowTone | undefined> = hostRows.map((r) => r[3]);
const hostTableRows = hostRows.map(([a, b, c]) => [a, b, c]);

const xtaskHeaders = ["命令", "macOS host 可执行", "备注"];
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
    "scripts/test/std_crates.csv 内 std crate",
    "success",
  ],
  [
    "cargo arceos defconfig qemu-aarch64 && cargo arceos qemu",
    "✅",
    "freestanding target；不调 cc；只需 qemu-system-aarch64",
    "success",
  ],
  [
    "cargo arceos build --package arceos-helloworld --target aarch64-unknown-none-softfloat",
    "✅",
    "纯 rustc，macOS 直跑",
    "success",
  ],
  [
    "cargo arceos build --package arceos-httpserver --target aarch64-unknown-none-softfloat --net",
    "✅",
    "同上",
    "success",
  ],
  [
    "cargo starry defconfig qemu-aarch64 && cargo starry qemu",
    "✅",
    "freestanding + kallsyms；需 gen_ksym + mkimage",
    "success",
  ],
  [
    "cargo starry rootfs --arch aarch64",
    "✅",
    "走 debugfs + e2fsck + resize2fs；装好 e2fsprogs 后能跑",
    "success",
  ],
  [
    "cargo starry test qemu --target aarch64-unknown-none-softfloat",
    "✅",
    "test-suit 用例；内部驱动 QEMU",
    "success",
  ],
  [
    "cargo axvisor defconfig qemu-aarch64 && cargo axvisor qemu",
    "✅",
    "freestanding；无 LVZ 限制",
    "success",
  ],
  [
    "cargo axvisor test qemu --arch aarch64",
    "✅",
    "aarch64 无 LVZ 依赖；与 CI 一致",
    "success",
  ],
  [
    "cargo xtask starry kmod build --module <path>",
    "✅",
    "macOS host 需装 aarch64-linux-gnu-gcc（apt 不可用；用 brew messense/macos-cross-toolchains/aarch64-unknown-linux-gnu）",
    "warning",
  ],
  [
    "scripts/prepare-selfhost-rootfs.sh --arch aarch64",
    "❌",
    "losetup / systemd-nspawn / debootstrap / chroot；走容器或 lima VM",
    "danger",
  ],
  [
    "scripts/self-compile.sh --arch aarch64",
    "❌",
    "sudo losetup + expect + debugfs -w",
    "danger",
  ],
  [
    "cargo xtask board *",
    "❌",
    "macOS 无 /dev/ttyUSB*；物理板需 Linux",
    "danger",
  ],
];
const xtaskRowTone: Array<TableRowTone | undefined> = xtaskRows.map((r) => r[3]);
const xtaskTableRows = xtaskRows.map(([a, b, c]) => [a, b, c]);

const matrixHeaders = ["系统", "推荐路径", "覆盖"];
const matrixAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const matrixRows: Array<[string, string, string, TableRowTone]> = [
  [
    "ArceOS (aarch64)",
    "路径 2（macOS host）+ brew install qemu",
    "✅ build/qemu/test 全闭环",
    "success",
  ],
  [
    "StarryOS (aarch64)",
    "路径 2 + cargo install ksym + brew install u-boot-tools e2fsprogs fakeroot",
    "✅ build/qemu/rootfs/test 全闭环",
    "success",
  ],
  [
    "Axvisor (aarch64)",
    "路径 2",
    "✅ build/qemu/test 全闭环；无 LVZ 限制",
    "success",
  ],
  [
    "kmod build (aarch64)",
    "macOS host 装 aarch64-linux-gnu-gcc",
    "✅ host-arch 一致时",
    "warning",
  ],
  [
    "prepare-selfhost-rootfs.sh (aarch64)",
    "路径 1（容器）或路径 3（lima VM）",
    "⚠️ macOS host 不可行",
    "warning",
  ],
  [
    "物理板 / ostool-server",
    "Linux 主机",
    "❌ macOS 无 /dev/ttyUSB*",
    "danger",
  ],
];
const matrixRowTone: Array<TableRowTone | undefined> = matrixRows.map((r) => r[3]);
const matrixTableRows = matrixRows.map(([a, b, c]) => [a, b, c]);

export default function TgoskitsArm64MacosBuild(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={20} style={{ padding: 28 }}>
      <Stack gap={6}>
        <H1>M5 arm64 macOS 上 TGOSKits AArch64 构建/测试精简方案</H1>
        <Text style={{ color: theme.text.secondary }}>
          仅覆盖 aarch64（aarch64-unknown-none-softfloat 与 aarch64-unknown-linux-musl）。项目未在 macOS 上做过端到端验证，本方案为源码静态评估。
        </Text>
      </Stack>

      <Callout tone="info" title="范围">
        <Text>
          去掉 riscv64 / x86_64 / loongarch64 三架构。AArch64 是 M5 host 的 native 架构，路径最直接，没有 KVM、没有 LVZ、没有 homebrew 缺包。
        </Text>
      </Callout>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="1" label="唯一目标 target：aarch64-unknown-none-softfloat" tone="info" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="homebrew" label="QEMU 主来源，无额外二进制" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="2" label="受限脚本：prepare-selfhost-rootfs.sh / self-compile.sh" tone="warning" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="0" label="物理板路径，无 /dev/ttyUSB*" tone="danger" />
          </CardBody>
        </Card>
      </Grid>

      <Divider />

      <Card>
        <CardHeader>
          <H2>1. macOS host 依赖清单</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              AArch64 路径在 macOS host 上只依赖标准 homebrew + cargo 生态，无需容器、无需 lima VM。
            </Text>
            <Table
              headers={hostHeaders}
              rows={hostTableRows}
              columnAlign={hostAlign}
              rowTone={hostRowTone}
            />
            <CodeBlock
              language="bash"
              code={`# 一键装齐 AArch64 路径依赖
brew install qemu e2fsprogs u-boot-tools fakeroot \\
          messense/macos-cross-toolchains/aarch64-unknown-linux-musl

rustup component add llvm-tools-preview rustfmt clippy rust-src
cargo install cargo-binutils ksym

export PATH="/opt/homebrew/opt/e2fsprogs/sbin:$PATH"
# 写入 ~/.zshrc 持久化`}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>2. axbuild/xtask 可执行性矩阵</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              按当前源码静态判断：AArch64 路径下，绝大多数 xtask 命令在 macOS host 上直接 ✅；仅自编译脚本与物理板路径 ❌。
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
          <H2>3. 最短闭环命令</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <H3>ArceOS</H3>
            <CodeBlock
              language="bash"
              code={`cargo arceos defconfig qemu-aarch64
cargo arceos qemu

# 跑测试
cargo xtask arceos test qemu \\
  --target aarch64-unknown-none-softfloat \\
  --test-group rust`}
            />
            <H3>StarryOS</H3>
            <CodeBlock
              language="bash"
              code={`cargo starry defconfig qemu-aarch64
cargo starry qemu

# 跑测试
cargo xtask starry test qemu \\
  --target aarch64-unknown-none-softfloat

# 修改 rootfs（先确保 /opt/homebrew/opt/e2fsprogs/sbin 在 PATH）
cargo xtask starry rootfs --arch aarch64`}
            />
            <H3>Axvisor</H3>
            <CodeBlock
              language="bash"
              code={`cargo axvisor defconfig qemu-aarch64
cargo axvisor qemu

# 跑测试
cargo xtask axvisor test qemu --arch aarch64`}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>4. 最低可执行矩阵</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              系统 × 场景的最低可行性结论。AArch64 路径在 macOS host 上是三架构中**最干净**的一条。
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
          <H2>5. 落地顺序</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Row gap={10} align="start">
              <Pill tone="success">1</Pill>
              <Text>
                装齐依赖（上方 CodeBlock），确认 <Code>qemu-system-aarch64 --version</Code> ≥ 10.2.1、<Code>debugfs</Code> 可执行。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">2</Pill>
              <Text>
                跑 <Code>cargo arceos defconfig qemu-aarch64 && cargo arceos qemu</Code>，验证最简闭环。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">3</Pill>
              <Text>
                跑 <Code>cargo starry defconfig qemu-aarch64 && cargo starry qemu</Code>，验证 kallsyms / mkimage 链路。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">4</Pill>
              <Text>
                跑 <Code>cargo axvisor defconfig qemu-aarch64 && cargo axvisor qemu</Code>，验证 Guest 启动路径。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="warning">5</Pill>
              <Text>
                <Code>cargo xtask test</Code> + <Code>cargo xtask clippy --package &lt;crate&gt;</Code>，覆盖 host-only 验证。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="danger">6</Pill>
              <Text>
                自编译脚本（prepare-selfhost-rootfs.sh / self-compile.sh）和物理板流程在 macOS 上跳过；如需，落到 lima VM 或 CI 容器。
              </Text>
            </Row>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>6. 关键证据文件</H2>
        </CardHeader>
        <CardBody>
          <CodeBlock
            language="text"
            code={`docs/introduction/platform.md            AArch64 target 与外部依赖
docs/build/ci.md                          CI 矩阵（aarch64 列）
docs/quickstart/arceos.md                 ArceOS qemu-aarch64 命令
docs/quickstart/starryos.md               StarryOS qemu-aarch64 + rootfs
docs/development/components.md            组件改动验证路径
scripts/axbuild/src/build/std_build.rs    aarch64 → aarch64-unknown-linux-musl
scripts/axbuild/src/rootfs/inject.rs      debugfs + fakeroot
scripts/axbuild/src/rootfs/resize.rs      macOS e2fsprogs fallback
scripts/axbuild/src/starry/build.rs       gen_ksym / mkimage
.cargo/config.toml                       cargo arceos/starry/axvisor 别名`}
          />
        </CardBody>
      </Card>

      <Divider />

      <Stack gap={4}>
        <Text style={{ color: theme.text.tertiary }}>
          本文档基于 TGOSKits 仓库 docs/、scripts/axbuild/ 当前源码静态评估生成；未在 macOS M5 arm64 host 上做过端到端验证，建议以最新源文档与 CI 镜像为准。
        </Text>
      </Stack>
    </Stack>
  );
}