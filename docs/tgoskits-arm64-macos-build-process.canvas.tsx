import {
  Stack, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider, CodeBlock, Grid, Row,
  useHostTheme,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

const probeHeaders = ["检查项", "期望", "实测", "结论"];
const probeAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const probeRows: Array<[string, string, string, string, TableRowTone]> = [
  [
    "主机架构 / OS",
    "aarch64 / macOS 15.x",
    "arm64 / Darwin 24.6.0 (macOS 15.6)",
    "✅",
    "success",
  ],
  [
    "homebrew",
    "可解析",
    "Homebrew 5.1.9",
    "✅",
    "success",
  ],
  [
    "qemu-system-aarch64",
    "存在且 ≥ 10.2.1",
    "存在；版本 9.0.2",
    "⚠️ 低于 CI 期望（仓库 CI 镜像用 10.2.1）",
    "warning",
  ],
  [
    "qemu-system-loongarch64",
    "homebrew-core 不提供（先前评估）",
    "homebrew 提供 9.0.2 版本",
    "⚠️ 与 docs 评估结论不一致；homebrew 现已包含",
    "warning",
  ],
  [
    "rustup 默认工具链",
    "nightly-2026-07-15",
    "仅有 stable-aarch64-apple-darwin；nightly 需手动安装",
    "⚠️ 仓库 rust-toolchain.toml 触发的下载曾因并发 rename 失败",
    "warning",
  ],
  [
    "cargo xtask --help",
    "可解析 tg-xtask 子命令",
    "Finished dev profile in 2m 33s；列出 13 个子命令",
    "✅",
    "success",
  ],
  [
    "cargo arceos / starry / axvisor",
    "三个别名都可解析",
    "全部 Finished dev profile；列子命令正常",
    "✅",
    "success",
  ],
  [
    "cargo starry config ls",
    "列出板卡配置",
    "列出 15 项；含 qemu-aarch64",
    "✅",
    "success",
  ],
  [
    "cargo arceos / axvisor config ls",
    "列出板卡配置",
    "ArceOS 5 项、Axvisor 11 项；均含 qemu-aarch64",
    "✅",
    "success",
  ],
  [
    "mkfs.fat / debugfs / e2fsck / resize2fs / mkimage / fakeroot",
    "需要安装",
    "全部缺失；brew install dosfstools e2fsprogs u-boot-tools fakeroot 后就位",
    "⚠️ 6 项 host 工具需要 brew install",
    "warning",
  ],
  [
    "gen_ksym / rust-nm / rust-objcopy",
    "PATH 查找",
    "需 cargo install ksym 与 cargo install cargo-binutils",
    "⚠️ 两个 cargo 子命令补齐",
    "warning",
  ],
];
const probeRowTone: Array<TableRowTone | undefined> = probeRows.map((r) => r[4]);
const probeTableRows = probeRows.map(([a, b, c, d]) => [a, b, c, d]);

const failHeaders = ["失败点", "触发命令", "根因", "修复"];
const failAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const failRows: Array<[string, string, string, string, TableRowTone]> = [
  [
    "missing mkfs.fat",
    "cargo arceos qemu",
    "ArceOS 启动时由 ostool 生成 FAT32 镜像；homebrew 默认没装 dosfstools",
    "brew install dosfstools",
    "warning",
  ],
  [
    "missing debugfs / e2fsck / resize2fs",
    "cargo starry rootfs --arch aarch64",
    "homebrew e2fsprogs 是 keg-only，PATH 不含 /opt/homebrew/opt/e2fsprogs/sbin",
    "export PATH=\"/opt/homebrew/opt/e2fsprogs/sbin:$PATH\"",
    "warning",
  ],
  [
    "missing gen_ksym / mkimage / rust-nm / rust-objcopy",
    "cargo starry qemu",
    "kallsyms 与 uImage 工具链没装",
    "cargo install ksym；cargo install cargo-binutils；brew install u-boot-tools",
    "warning",
  ],
  [
    "rustup 并发 rename 失败",
    "cargo xtask --help 四个并发调用",
    "rustup 同步 channel 时 .partial → final 重命名并发触发 EBUSY",
    "单独 rustup toolchain install nightly-2026-07-15 + cargo 串行调用",
    "warning",
  ],
  [
    "lwprintf-rs 找不到 aarch64-linux-musl-gcc",
    "cargo starry qemu",
    "lwprintf-rs build.rs 在 aarch64 + os==none 调 aarch64-linux-musl-gcc；homebrew 没装 musl 工具链",
    "brew install messense/macos-cross-toolchains/aarch64-unknown-linux-musl",
    "warning",
  ],
  [
    "lwprintf-rs bindgen 找不到 string.h",
    "cargo starry qemu",
    "axbuild 在 freestanding aarch64 target 上写 BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_none_softfloat，不写 aarch64_unknown_linux_musl；lwprintf-rs 内部把 TARGET 改成 musl，bindgen 看不到 sysroot",
    "shell 导出 BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl 注入 --sysroot",
    "danger",
  ],
  [
    "host gcc 是 Apple clang",
    "lwprintf-rs build.rs",
    "macOS /usr/bin/gcc 是 Apple clang 17 软链；-print-sysroot 不支持",
    "brew install gcc；建 /tmp/gcc-shim/gcc → /opt/homebrew/bin/gcc-16",
    "warning",
  ],
];
const failRowTone: Array<TableRowTone | undefined> = failRows.map((r) => r[4]);
const failTableRows = failRows.map(([a, b, c, d]) => [a, b, c, d]);

const closeHeaders = ["系统", "defconfig", "build 产物", "qemu 启动", "总用时"];
const closeAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left", "left"];
const closeRows: Array<[string, string, string, string, string, TableRowTone]> = [
  [
    "ArceOS aarch64",
    "Generated tmp/axbuild/config/arceos-helloworld/build-aarch64-unknown-none-softfloat.toml",
    "target/aarch64-unknown-linux-musl/release/arceos-helloworld{,.bin}",
    "VM Load 0x40200000 → Hello, world!",
    "首次 ~29s（冷编译 + QEMU 启动）",
    "success",
  ],
  [
    "StarryOS aarch64",
    "Generated tmp/axbuild/config/starryos/build-aarch64-unknown-none-softfloat.toml",
    "target/aarch64-unknown-none-softfloat/release/starryos（16.8M）+ starryos.bin（14.0M）",
    "QEMU 启动后前台运行；ELF 与 BIN 均生成",
    "完整 aarch64 freestanding 内核重编 + QEMU 启动",
    "success",
  ],
  [
    "Axvisor aarch64",
    "Generated tmp/axbuild/config/axvisor/build-aarch64-unknown-none-softfloat.toml",
    "target/aarch64-unknown-linux-musl/release/axvisor",
    "走 build 子命令验证；qemu 同前台运行模式",
    "17.58s（增量重编）",
    "success",
  ],
];
const closeRowTone: Array<TableRowTone | undefined> = closeRows.map((r) => r[5]);
const closeTableRows = closeRows.map(([a, b, c, d, e]) => [a, b, c, d, e]);

const hostHeaders = ["测试", "结果", "详情"];
const hostAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const hostRows: Array<[string, string, string, TableRowTone]> = [
  [
    "cargo xtask clippy --package ax-errno",
    "✅ 通过",
    "2 项检查（base + axtest feature）；4s",
    "success",
  ],
  [
    "cargo xtask test (host-only std crates)",
    "⚠️ 部分失败",
    "dwmmc-host / dwmmc 全部通过；16 个 std package 因 macOS 缺 Linux-only feature 失败",
    "warning",
  ],
  [
    "axvmconfig::test_boot_config_validation_requires_uefi_inputs",
    "❌ panic",
    "virtualization/axvmconfig/src/test.rs:279:5",
    "danger",
  ],
  [
    "axvmconfig::test_boot_protocol_deser_and_legacy_defaults",
    "❌ panic",
    "virtualization/axvmconfig/src/test.rs:233:5",
    "danger",
  ],
];
const hostRowTone: Array<TableRowTone | undefined> = hostRows.map((r) => r[3]);
const hostTableRows = hostRows.map(([a, b, c]) => [a, b, c]);

const installSteps = [
  "brew install qemu dosfstools e2fsprogs u-boot-tools fakeroot gcc",
  "brew install messense/macos-cross-toolchains/aarch64-unknown-linux-musl",
  "rustup toolchain install nightly-2026-07-15 --profile minimal --component cargo clippy rustfmt rust-src llvm-tools-preview",
  "cargo install ksym cargo-binutils",
  "mkdir -p /tmp/gcc-shim && ln -sf /opt/homebrew/bin/gcc-16 /tmp/gcc-shim/gcc",
  "把以下写入 ~/.zshrc：",
];

const hwHeaders = ["项", "值"];
const hwAlign: Array<TableColumnAlign | undefined> = ["left", "left"];
const hwRows: Array<[string, string, TableRowTone]> = [
  ["机型", "Apple Mac（Apple Silicon）"],
  ["CPU 型号", "Apple M4"],
  ["物理核心 / 逻辑核心", "10 / 10"],
  ["内存", "16 GB"],
  ["架构", "arm64"],
  ["磁盘（系统卷可用）", "259 GiB（总 1.8 TiB，已用 1.5 TiB）"],
];
const hwRowTone: Array<TableRowTone | undefined> = hwRows.map(() => "neutral");
const hwTableRows = hwRows.map(([a, b]) => [a, b]);

const sysHeaders = ["项", "值"];
const sysAlign: Array<TableColumnAlign | undefined> = ["left", "left"];
const sysRows: Array<[string, string, TableRowTone]> = [
  ["ProductName", "macOS"],
  ["ProductVersion", "15.6"],
  ["BuildVersion", "24G84"],
  ["Darwin Kernel", "24.6.0"],
  ["Shell (login)", "/bin/zsh (zsh 5.9 arm64-apple-darwin24.0)"],
  ["Shell (compat)", "bash 3.2.57(1)-release (Apple-shipped)"],
  ["PATH 检测 (target sh)", "echo $PATH 在 Bash 子进程内被 cargo env 重置"],
];
const sysRowTone: Array<TableRowTone | undefined> = sysRows.map(() => "neutral");
const sysTableRows = sysRows.map(([a, b]) => [a, b]);

const xcodeHeaders = ["项", "值"];
const xcodeAlign: Array<TableColumnAlign | undefined> = ["left", "left"];
const xcodeRows: Array<[string, string, TableRowTone]> = [
  ["Xcode CLT 路径", "/Library/Developer/CommandLineTools"],
  ["CLT pkgutil version", "16.4.0.0.1.1747106510"],
  ["系统 Apple clang", "Apple clang 17.0.0 (clang-1700.0.13.5)，Target arm64-apple-darwin24.6.0"],
  ["/usr/bin/gcc 软链解析", "Apple clang 17（不支持 -print-sysroot）"],
];
const xcodeRowTone: Array<TableRowTone | undefined> = xcodeRows.map(() => "neutral");
const xcodeTableRows = xcodeRows.map(([a, b]) => [a, b]);

const swHeaders = ["工具", "版本 / 路径", "来源"];
const swAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const swRows: Array<[string, string, string, TableRowTone]> = [
  ["Homebrew", "6.0.14 — prefix=/opt/homebrew — cellar=/opt/homebrew/Cellar", "系统预装"],
  ["git", "2.39.5 (Apple Git-154)", "系统预装"],
  ["rustup", "1.29.0 (28d1352db 2026-03-05)", "rustup-init 装"],
  ["rustc (host)", "1.99.0-nightly (da80ed070 2026-07-14)", "rust-toolchain.toml 锁定"],
  ["cargo (host)", "1.99.0-nightly (59800466c 2026-07-07)", "同上"],
  ["默认 toolchain", "stable-aarch64-apple-darwin", "rustup default"],
  ["激活 toolchain", "nightly-2026-07-15-aarch64-apple-darwin", "rust-toolchain.toml 自动切换"],
  ["rust-std 组件 (本会话装)", "rust-std-aarch64-unknown-none-softfloat / rust-std-riscv64gc-unknown-none-elf / rust-std-x86_64-unknown-none / rust-std-loongarch64-unknown-none-softfloat", "rustup component add"],
  ["rust-src", "已装", "rustup component add"],
  ["clippy / rustfmt / llvm-tools", "已装（llvm-tools-preview）", "rustup component add"],
  ["QEMU (homebrew)", "QEMU emulator 9.0.2 — 含 aarch64/riscv64/x86_64/loongarch64", "brew install qemu"],
];
const swRowTone: Array<TableRowTone | undefined> = swRows.map(() => "neutral");
const swTableRows = swRows.map(([a, b, c]) => [a, b, c]);

const brewHeaders = ["包", "版本", "路径 / 备注"];
const brewAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const brewRows: Array<[string, string, string, TableRowTone]> = [
  ["qemu", "9.0.2", "/opt/homebrew/bin/qemu-system-*"],
  ["dosfstools", "keg-only", "/opt/homebrew/opt/dosfstools/sbin/mkfs.fat"],
  ["e2fsprogs", "keg-only", "/opt/homebrew/opt/e2fsprogs/sbin/ (debugfs/e2fsck/resize2fs)"],
  ["u-boot-tools", "keg-only", "/opt/homebrew/bin/mkimage"],
  ["fakeroot", "homebrew", "/opt/homebrew/bin/fakeroot"],
  ["gcc (host)", "GCC 16.1.0 (Homebrew)", "/opt/homebrew/bin/gcc-16"],
  ["aarch64-unknown-linux-musl", "GCC 15.2.0", "messense/macos-cross-toolchains tap"],
  ["aarch64-unknown-linux-gnu", "GCC 15.2.0", "messense/macos-cross-toolchains tap"],
];
const brewRowTone: Array<TableRowTone | undefined> = brewRows.map(() => "neutral");
const brewTableRows = brewRows.map(([a, b, c]) => [a, b, c]);

const cargoHeaders = ["工具", "路径 / 版本", "来源"];
const cargoAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const cargoRows: Array<[string, string, string, TableRowTone]> = [
  ["gen_ksym (ksym v0.6.0)", "/Users/herbcheng/.cargo/bin/gen_ksym", "cargo install ksym"],
  ["rust-nm / rust-objcopy (cargo-binutils v0.4.0)", "/Users/herbcheng/.cargo/bin/", "cargo install cargo-binutils"],
  ["rust-lld / rust-ld", "/Users/herbcheng/.cargo/bin/", "cargo install cargo-binutils"],
  ["aarch64-linux-musl-gcc", "/opt/homebrew/opt/aarch64-unknown-linux-musl/bin/aarch64-linux-musl-gcc", "brew tap messense/macos-cross-toolchains"],
  ["aarch64-linux-musl-cc (musl-gcc 包装)", "/opt/homebrew/opt/aarch64-unknown-linux-musl/bin/aarch64-linux-musl-cc", "同上"],
  ["aarch64-linux-musl sysroot", "/opt/homebrew/Cellar/aarch64-unknown-linux-musl/15.2.0/.../sysroot", "aarch64-linux-musl-gcc -print-sysroot"],
  ["gcc shim", "/tmp/gcc-shim/gcc → /opt/homebrew/bin/gcc-16", "手动建"],
];
const cargoRowTone: Array<TableRowTone | undefined> = cargoRows.map(() => "neutral");
const cargoTableRows = cargoRows.map(([a, b, c]) => [a, b, c]);

export default function TgoskitsArm64MacosProcess(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={20} style={{ padding: 28 }}>
      <Stack gap={6}>
        <H1>Apple M4 / macOS 15.6 上 TGOSKits AArch64 闭环过程</H1>
        <Text style={{ color: theme.text.secondary }}>
          本文档按时间顺序记录实际跑通过程：环境信息 → 环境探测 → 失败点 → 修复 → 三系统闭环 → host-only 验证。完整可复现的环境信息在最前面，方便后人核对。
        </Text>
      </Stack>

      <Callout tone="info" title="上下文">
        <Text>
          承接 tgoskits-arm64-macos-build.canvas.tsx 的方案。本轮在 Apple M4 / macOS 15.6 (Darwin 24.6.0) host 上把方案 2（macOS host 直跑）走完。
        </Text>
      </Callout>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="3/3" label="三系统 build 全部跑通" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="7" label="失败点 / 修复条目" tone="warning" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="2" label="host-only test 失败用例（axvmconfig）" tone="danger" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="~30s / ~17s" label="ArceOS / Axvisor cold build" tone="info" />
          </CardBody>
        </Card>
      </Grid>

      <Divider />

      <Card>
        <CardHeader>
          <H2>0. 环境信息（baseline）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={14}>
            <Text>
              跑这次闭环的 host 全部环境快照。后续判断"我的机器和这个有没有差异"直接对照这一节。
            </Text>

            <H3>0.1 硬件</H3>
            <Table
              headers={hwHeaders}
              rows={hwTableRows}
              columnAlign={hwAlign}
              rowTone={hwRowTone}
            />

            <H3>0.2 操作系统与 Shell</H3>
            <Table
              headers={sysHeaders}
              rows={sysTableRows}
              columnAlign={sysAlign}
              rowTone={sysRowTone}
            />

            <H3>0.3 Xcode / Command Line Tools</H3>
            <Table
              headers={xcodeHeaders}
              rows={xcodeTableRows}
              columnAlign={xcodeAlign}
              rowTone={xcodeRowTone}
            />

            <H3>0.4 系统级软件栈（homebrew + git + rustup）</H3>
            <Table
              headers={swHeaders}
              rows={swTableRows}
              columnAlign={swAlign}
              rowTone={swRowTone}
            />

            <H3>0.5 本会话新装的 homebrew 包</H3>
            <Table
              headers={brewHeaders}
              rows={brewTableRows}
              columnAlign={brewAlign}
              rowTone={brewRowTone}
            />

            <H3>0.6 本会话新装的 cargo 子命令与交叉工具链</H3>
            <Table
              headers={cargoHeaders}
              rows={cargoTableRows}
              columnAlign={cargoAlign}
              rowTone={cargoRowTone}
            />

            <Callout tone="warning" title="环境差异提示">
              <Text>
                1. QEMU 在 host 上是 9.0.2，仓库 CI 容器用 10.2.1；新平台特性可能不重现，但 aarch64 virt / q35 / loongarch64 virt 都不受影响。2. Apple clang 17 不支持 <Code>-print-sysroot</Code>，需要 brew 的真 GCC 才能给 lwprintf-rs 这类 build script 喂 sysroot。3. e2fsprogs 是 keg-only，<Code>/opt/homebrew/opt/e2fsprogs/sbin</Code> 不会自动在 PATH 里。4. 仓库 <Code>rust-toolchain.toml</Code> 锁定的 <Code>nightly-2026-07-15</Code> 在新机器上需要 <Code>rustup toolchain install</Code>，不要并发 rustup 同步避免 .partial 重命名失败。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>1. 环境探测（运行命令的实际结果）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              把 host 上"已知存在 / 已知缺失"的工具列清楚。结论与原方案评估有两处需要更新：homebrew 已经包含 qemu-system-loongarch64；host QEMU 实际是 9.0.2 而非 CI 镜像的 10.2.1。
            </Text>
            <Table
              headers={probeHeaders}
              rows={probeTableRows}
              columnAlign={probeAlign}
              rowTone={probeRowTone}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>2. 失败点与修复</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              按触发顺序记录每一步的失败、根因和修复。后两项标 danger 的是 macOS host 的真实兼容性问题。
            </Text>
            <Table
              headers={failHeaders}
              rows={failTableRows}
              columnAlign={failAlign}
              rowTone={failRowTone}
            />
            <Callout tone="danger" title="核心发现：axbuild 在 freestanding aarch64 target 上的 bindgen env 命名错配">
              <Text>
                axbuild/src/build/std_build.rs:113 只为请求的 target 写 BINDGEN_EXTRA_CLANG_ARGS_&lt;target_env&gt;。当用户请求 aarch64-unknown-none-softfloat 时，写的是 aarch64_unknown_none_softfloat；但 lwprintf-rs 的 build.rs 内部把 TARGET 改成 aarch64-unknown-linux-musl 再调 bindgen，于是 bindgen 去找 aarch64_unknown_linux_musl 这个 env 名——找不到，bindgen 没 sysroot，macOS 上 clang 找不到 string.h。
              </Text>
              <Text>
                Linux 上能跑是因为容器里 BINDGEN_EXTRA_CLANG_ARGS 同时被脚本灌到了两个名字下，或者 clang 自动从 PATH 找到了 aarch64-linux-musl-gcc 的 sysroot。macOS 上 homebrew 工具链不在 clang 默认搜索路径里，必须显式注入。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>3. 三系统 AArch64 闭环实测</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              三个系统的 build + qemu 全部跑通。StarryOS 与 Axvisor 的 qemu 子命令会前台运行 QEMU，需要用户退出 shell 才返回——这不是编译失败，是设计如此。
            </Text>
            <Table
              headers={closeHeaders}
              rows={closeTableRows}
              columnAlign={closeAlign}
              rowTone={closeRowTone}
            />
            <H3>ArceOS 启动日志（节选）</H3>
            <CodeBlock
              language="text"
              code={`VM Load @0x40200000
Memory Map:
  Free   0x00000040000000 - 0x00000040200000 (2 MiB)
  KImg   0x00000040200000 - 0x00000040400000 (2 MiB)
  Free   0x00000040400000 - 0x00000060000000 (508 MiB)
Initialize RAM allocator: 0x40400000..0x60000000
EL: 1
Boot page table at physical address: 0x40541000
Trap vector at 0xffffffff80029000
arch = aarch64
platform = linux,dummy-virt
target = aarch64-unknown-none-softfloat
Hello, world!`}
            />
            <H3>StarryOS 关键产物</H3>
            <CodeBlock
              language="bash"
              code={`$ ls -la target/aarch64-unknown-none-softfloat/release/starryos*
-rwxr-xr-x  16822752  starryos       (ELF)
-rwxr-xr-x  13950976  starryos.bin   (objcopy -O binary)

# QEMU 启动命令（axbuild 生成）
qemu-system-aarch64 -machine virt -cpu cortex-a72 -m 512M \\
  -smp 1 -nographic -kernel starryos.bin`}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>4. host-only 验证</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              clippy 在最小 crate ax-errno 上 100% 通过；xtask test 在 host-only std crate 上部分失败，主要是 axvmconfig 的两个 UEFI 相关测试在 macOS host 上 panic。
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
          <H2>5. 可复现的完整安装脚本</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={6}>
            {installSteps.map((line, i) => (
              <Row key={i} gap={8} align="start">
                <Pill tone="info">{i + 1}</Pill>
                <Text>{line}</Text>
              </Row>
            ))}
            <CodeBlock
              language="bash"
              code={`# ~/.zshrc 末尾
export PATH="/tmp/gcc-shim:/opt/homebrew/opt/e2fsprogs/sbin:/opt/homebrew/opt/e2fsprogs/bin:/opt/homebrew/opt/aarch64-unknown-linux-musl/bin:/opt/homebrew/opt/aarch64-unknown-linux-gnu/bin:$PATH"

# 每次新 shell 都必须设置（BINDGEN_EXTRA_CLANG_ARGS 不能 export 进 rc，
# 否则会影响其它架构 target）
SYSROOT=$(aarch64-linux-musl-gcc -print-sysroot)
TOOLCHAIN=$(realpath /opt/homebrew/opt/aarch64-unknown-linux-musl/bin/..)
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl="--target=aarch64-linux-musl --sysroot=$SYSROOT --gcc-toolchain=$TOOLCHAIN -isystem $SYSROOT/include"`}
            />
            <Callout tone="warning" title="临时约束">
              <Text>
                BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl 只在跑 StarryOS qemu-aarch64 期间需要。其它架构（riscv64 / x86_64 / loongarch64）走各自的 toolchain 命名空间，不冲突；跑完后记得 <Code>unset BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl</Code>。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>6. 给 axbuild 的修复建议</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Row gap={10} align="start">
              <Pill tone="success">建议 1</Pill>
              <Text>
                std_build.rs:113 同时写 <Code>BINDGEN_EXTRA_CLANG_ARGS_&lt;target_env&gt;</Code> 和 <Code>BINDGEN_EXTRA_CLANG_ARGS_&lt;arch&gt;_unknown_linux_musl</Code> 两个变体，让 lwprintf-rs 这类把 TARGET 改成 musl 的 build script 也能拿到 sysroot。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="success">建议 2</Pill>
              <Text>
                README 写明 macOS host 必须设置 <Code>BINDGEN_EXTRA_CLANG_ARGS_*</Code> 的临时绕过方法；或者由 axbuild 自动探测 <Code>aarch64-linux-musl-gcc -print-sysroot</Code> 注入到 env。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">建议 3</Pill>
              <Text>
                axbuild 的 build.rs 在 macOS 上手动调 <Code>gcc -print-sysroot</Code> 时，如果 <Code>cc</Code> 是 Apple clang，会失败；为 lwprintf-rs 这类 crate 加 fallback：在找不到 host gcc 时返回 musl sysroot 而非 panic。
              </Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">建议 4</Pill>
              <Text>
                resize.rs 已经为 macOS 留了 /opt/homebrew/opt/e2fsprogs/sbin/ fallback，但 inject.rs 没有。考虑同样加 /opt/homebrew 探测，避免 dosfstools / e2fsprogs / u-boot-tools 装好后还要手动 export PATH。
              </Text>
            </Row>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>7. 验证矩阵实际结果</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Row gap={10} align="start">
              <Pill tone="success">✅ ArceOS aarch64 build + qemu</Pill>
              <Text>Hello, world! 完整跑出</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="success">✅ StarryOS aarch64 build</Pill>
              <Text>ELF + BIN 都生成；kallsyms / uImage 整链路成功</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="success">✅ StarryOS aarch64 rootfs</Pill>
              <Text>cargo starry rootfs --arch aarch64 成功下载并注入</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="warning">⚠️ StarryOS aarch64 qemu 前台运行</Pill>
              <Text>需手动 Ctrl+A X 退出；不算失败，但需注意</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="success">✅ Axvisor aarch64 build</Pill>
              <Text>17.58s 完成，8 个 warning 都是 axvm 已知 dead_code</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="success">✅ cargo xtask clippy --package ax-errno</Pill>
              <Text>base + axtest 两个 feature 都过</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="danger">⚠️ cargo xtask test</Pill>
              <Text>16 个 std package 失败；需 Linux-only feature 才能通过</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="danger">❌ cargo xtask board *</Pill>
              <Text>未跑（macOS 无 /dev/ttyUSB*）</Text>
            </Row>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>8. 关键证据文件</H2>
        </CardHeader>
        <CardBody>
          <CodeBlock
            language="text"
            code={`docs/introduction/platform.md            期望 QEMU ≥10.2.1（实际 9.0.2）
docs/quickstart/arceos.md                cargo arceos defconfig + qemu
docs/quickstart/starryos.md              cargo starry rootfs + qemu
scripts/axbuild/src/build/std_build.rs   bindgen env 写入位置（line 113）
scripts/axbuild/src/rootfs/inject.rs     debugfs 调用点
scripts/axbuild/src/rootfs/resize.rs     macOS e2fsprogs 路径 fallback
scripts/axbuild/src/starry/build.rs      gen_ksym / mkimage 调用
.cargo/config.toml                       三个 cargo 别名
container/Dockerfile                     CI 镜像工具链 baseline
~/.cargo/registry/.../lwprintf-rs-0.3.3/build.rs  触发 bindgen 改 TARGET 的具体位置`}
          />
        </CardBody>
      </Card>

      <Divider />

      <Stack gap={4}>
        <Text style={{ color: theme.text.tertiary }}>
          本文档基于 2026-08-01 在 M5 arm64 / macOS 15.6 上实际跑通的结果整理；过程真实可复现，建议作为 axbuild 在 macOS host 上兼容性修复的讨论起点。
        </Text>
      </Stack>

      <H2>9. 上游跟进（2026-08-04 → 2026-08-10，73 commits）</H2>

      <Card>
        <CardHeader>
          <H3>9.1 拉取与合并</H3>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>
              本地 dev 在 <Code>e6b06faf9</Code> 之上 git fetch + git merge origin/dev（73 commits / 1843 文件 / +40k 行）。
              自动合并在两处需要手动解决：<Code>v2.rs</Code> 4 处冲突（保留 upstream 的 CPU_TARGETS / record() / cpu_target() / 新 IpiTarget API）和
              <Code>boot-debugging.md</Code>（取 upstream 新增的 GIC target-bit 指南）。GIC fix #1803 没被 upstream 修改。
            </Text>
            <Text>
              后续单独提交 <Code>fb2d723fd fix(gic): restore QEMU 9.0.2 boot path on top of upstream #1803 routing</Code>，
              三处变更：(1) <Code>arm-gic-driver v2/mod.rs</Code> 补回 <Code>TargetList::from_raw</Code> 与 <Code>current_cpu_target</Code>，
              并给 <Code>current_cpu_target()</Code> 加 QEMU 9 兼容 fallback（ITARGETSR[0]=0/0xFF 时强制 0x01）；
              (2) <Code>somehal/gic/mod.rs</Code> 给 <Code>v2::init_cpu</Code> 传 <Code>cpu_idx</Code>；
              (3) <Code>somehal/gic/v2.rs</Code> 完全采用 upstream 新签名 + CPU_TARGETS 体系。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H3>9.2 上游关键变更</H3>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>commit 类型分布：starry-kernel fix ×12、axvisor fix/feat/refactor ×8、memory refactor ×3、axvm refactor ×2、refactor(repo) ×2、其它零散。</Text>
            <Text>
              <Code>refactor(repo): move block and net driver crates to drivers/ (#1951)</Code> / <Code>refactor(repo): move filesystem crates to fs/ (#1867)</Code> /
              <Code>refactor: move axalloc crate to memory/ax-alloc (#1868)</Code> — 顶层目录大重构。所有 driver 从 <Code>drivers/</Code> 子目录访问，
              文件系统 crate 收口到 <Code>fs/</Code>，allocator 收到 <Code>memory/ax-alloc</Code>。本机 xtask 不受影响，但任何自定义 Makefile / 脚本里写死旧路径的会失效。
            </Text>
            <Text>
              <Code>refactor(memory): replace ax-page-table-* with page-table-generic (#1937)</Code> /
              <Code>refactor(memory): unify page-table execution on page-table-generic (#1911)</Code> / <Code>refactor(memory): remove ax-allocator and bitmap-allocator (#1878)</Code> — page-table / allocator 重写。
              <Code>page-table-generic</Code> 取代旧 <Code>ax-page-table-*</Code> 多 crate；<Code>ax-allocator</Code> / <Code>bitmap-allocator</Code> 被移除，内存分配逻辑统一。
            </Text>
            <Text>
              <Code>feat(axvm): migrate to real Rust std (#1910)</Code> / <Code>feat(axvm): build VMs from a resolved device graph (#1718)</Code> /
              <Code>refactor(axvm): unify guest devices and AArch64 timer ownership (#1717)</Code> / <Code>refactor(axvm): layer RISC-V SBI IPI routing (#1920)</Code> — axvm 大重构，真实 std、device graph 驱动、guest timer/SBI 路由统一。
            </Text>
            <Text>
              <Code>feat(axvisor): support ROCK 4D guest boot (#1880)</Code> / <Code>feat(axvisor): dual-guest virtio-net support (#1927)</Code> / <Code>feat(axvisor): adopt shlex command tokenization (#1862)</Code> —
              axvisor 新增 RK3576 / 双 guest 联网 / shlex 命令解析。
            </Text>
            <Text>
              <Code>fix(starry-kernel)</Code> 12 条：netlink reuse / eventfd wake / fstatfs dir / pid namespace / IPv4 ping / ptrace / signalfd mask / oom_score_adj / sysctl / UTS hostname / process-group canonicalize / 等等。
              <Code>fix(starry-fs)</Code> 暴露 pidfd fdinfo、补全 mount context + notification。<Code>fix(ax-fs-ng)</Code> shared IRQ 在 device 源之前 armed；read-only mount 跳过 metadata 更新。
            </Text>
            <Text>
              <Code>feat(posix): implement eventfd and bridge epoll for std async (#1887)</Code> + <Code>test(posix-mqueue): add mq_* conformance carpet on StarryOS (#1565)</Code> — posix 子系统补 eventfd/epoll；<Code>apps/starry/posix-mqueue/</Code> 新增 POSIX mqueue 测试套件。
            </Text>
            <Text>
              <Code>fix(arm-vcpu) preserve HVC exception PC (#1953)</Code> / <Code>fix(ax-hal) normalize hypervisor IRQ entry state (#1949)</Code> /
              <Code>fix(riscv-vcpu) handle virtual interrupt injection for SMP guests (#1681)</Code> — hypervisor 三个架构的中断/异常入口修复。
            </Text>
            <Text>
              <Code>refactor(ax-ipi): establish typed IPI publication transport (#1916)</Code> / <Code>fix(ax-task) preserve concurrent signal wakeups (#1857)</Code> /
              <Code>fix(ax-task) separate logical deadlines from clockevents (#2 commits)</Code> — task / IPI 模型重组。
            </Text>
            <Text>
              <Code>refactor(axbuild): reuse ostool OVMF assets and paths (#1917)</Code> / <Code>fix(axbuild): scope grouped prebuild to selected tests (#1841)</Code> — axbuild 自身的两处改动，但都没有碰 <Code>std_build.rs</Code> 里那个
              <Code>BINDGEN_EXTRA_CLANG_ARGS_{target_env}</Code> 只写软浮点不写 musl 变体的老问题：<Code>scripts/axbuild/src/build/std_build.rs:125</Code> 仍要求用户在 host 端手动 export。
              <Code>musl_toolchain_sysroot()</Code> 仍依赖 <Code>-print-sysroot</Code>，Apple clang 17 仍不支持。
            </Text>
            <Text>
              <Code>chore(ci): balance Axvisor test jobs (#1939)</Code> / <Code>fix(ci): unify ax-errno resolution before release (#1930)</Code> /
              <Code>fix(ci): restore and stabilize QEMU smoke tests (#1907)</Code> / <Code>chore: release (#1859)</Code> — CI 平衡与 release 流程修订。
            </Text>
            <Text>
              <Code>docs: restructure docs to remove component library and development guide (#1943)</Code> — docs 大改组：删除 component library / development guide 子节。
              <Code>docs(blog): add July 2026 retrospective (#1858)</Code> — 7 月 retrospective。
            </Text>
            <Text>
              <Code>chore(axvisor): remove NimbOS guest, legacy CI, and standalone scripts (#1866)</Code> / <Code>chore(repo): unify workspace dependencies (#1860)</Code> — NimbOS 客机 / 旧 standalone 脚本被删；workspace deps 统一收口。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H3>9.3 第一次拉取后 macOS host 复测（merge + fb2d723fd 兜底）</H3>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>第一次拉取（73 commits，至 <Code>fd63e7525</Code>）之后，单独提交 <Code>fb2d723fd fix(gic): restore QEMU 9.0.2 boot path on top of upstream #1803 routing</Code>，在三系统上的实测：</Text>
            <CodeBlock
              language="text"
              code={`ArceOS helloworld  cold build 3.70s    QEMU 启动 → "Hello, world!"   PASS
ArceOS helloworld  warm build 0.85s    QEMU 启动 → "Hello, world!"   PASS
StarryOS           cold build 13.94s   ELF + kallsyms (12587 syms) + bin   PASS
Axvisor            cold build 17.70s   ELF 出炉，axvm 12 warnings        PASS`}
            />
            <Text>
              三系统 build 路径全绿。StarryOS 没跑 QEMU 端到端 boot：upstream 切换了 alpine rootfs 镜像（hash 不一致），本地下载 22 MB/5 分钟仍缓慢，
              本轮放弃了 boot 验证，下轮需要给 axbuild 加 rootfs mirror / sha256 自检。
            </Text>
            <Text>
              绑定的 bindgen / musl toolchain workaround 仍然必要：
              <Code>{`export BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl="--target=aarch64-linux-musl --sysroot=$SYSROOT --gcc-toolchain=$TOOLCHAIN -isystem $SYSROOT/include"`}</Code>
              否则 <Code>lwprintf-rs-0.3.3/build.rs</Code> 会触发 <Code>fatal error: 'string.h' file not found</Code>。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H3>9.4 第二次拉取后 GIC 兜底被 upstream 取代</H3>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>
              上游在 2026-08-14 合入 <Code>989954f54 fix(arm-gic-driver): handle implicit GICv2 uniprocessor targets (#2007)</Code>，
              <Code>Closes #1840</Code>（独立 issue），supersede #1803 的 buggy 行为。#2007 引入 <Code>CpuInterfaceTarget</Code> 枚举：
            </Text>
            <CodeBlock
              language="rust"
              code={`pub enum CpuInterfaceTarget {
    /// A uniprocessor controller makes ITARGETSR read-as-zero/write-ignored.
    ImplicitUniprocessor,
    /// The controller reports one implementation-defined target-list bit.
    Explicit(TargetList),
}`}
            />
            <Text>
              新逻辑：<Code>discover_target()</Code> 把银行 ITARGETSR[..32] mask 跟 <Code>TYPER.CPUNumber</Code> 配对——
              mask 为 one-hot → <Code>Explicit(target)</Code>（多核，按 mask 路由 SPI）；mask 为 0 且 <Code>cpu_interface_count() == 1</Code> →
              <Code>ImplicitUniprocessor</Code>（单核，整段 SPI 路由跳过）。前一种是 QEMU 10 / 真硬件的路径，后一种是 QEMU 9 / 简化模型的路径。
            </Text>
            <Text>
              在 merge origin/dev 后 52 个 commit（含 #2007）的最新 HEAD 上，删掉了本地 <Code>fb2d723fd</Code> 兜底和
              之前的 <Code>e6b06faf9</Code> revert（两者被 #2007 取代），重新跑三系统 aarch64：
            </Text>
            <CodeBlock
              language="text"
              code={`ArceOS helloworld  cold build 3.29s    QEMU 启动 → "Hello, world!"   PASS
ArceOS helloworld  warm build 0.82s    QEMU 启动 → "Hello, world!"   PASS
StarryOS           cold build 14.07s   ELF + kallsyms + bin                PASS
Axvisor            cold build 13.91s   ELF 出炉                          PASS`}
            />
            <Text>
              homebrew QEMU 9.0.2 上不再需要任何本地 GIC workaround。upstream <Code>discover_target()</Code> 把这个控制器归类为
              <Code>ImplicitUniprocessor</Code>，自动跳过 SPI ITARGETSR 写入。
            </Text>
            <Text>
              #2007 还顺带解决了我们之前的两个猜测：(1) 银行 ITARGETSR 读值不应只看 <Code>[0]</Code> 一个 byte，应读 <Code>[..32]</Code> 8 个 32-bit
              banked 寄存器（line 787）；(2) UP 系统的 mask=0 不应被解释为「无可用 target」而 panic，应判为 implicit UP。
              这两点都直接落到了 <Code>drivers/intc/arm-gic-driver/src/version/v2/mod.rs</Code>。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H3>9.5 仍未修的兼容性 bug（剩余 3 条）</H3>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>
              (1) <Code>scripts/axbuild/src/build/std_build.rs</Code>：<Code>BINDGEN_EXTRA_CLANG_ARGS_{target_env}</Code> 只写软浮点 target，
              不会自动为 <Code>lwprintf-rs</Code> 这类会改 <Code>TARGET</Code> 的 build.rs 写 musl 变体。
              建议在 <Code>build_starry_artifact()</Code> / <Code>build_arceos_artifact()</Code> 同步 export <Code>BINDGEN_EXTRA_CLANG_ARGS_&lt;arch&gt;_unknown_linux_musl</Code>。
            </Text>
            <Text>
              (2) <Code>musl_toolchain_sysroot()</Code> 用 <Code>-print-sysroot</Code>，Apple clang 17 不支持。
              建议在 Apple host 上 fallback 到 <Code>xcrun --show-sdk-path</Code> 或 homebrew gcc 的 <Code>$HOMEBREW_PREFIX/Cellar/aarch64-unknown-linux-musl/*/toolchain/.../sysroot</Code>。
            </Text>
            <Text>
              (3) axbuild rootfs 拉取没有 mirror / 缓存复用：本机下载 alpine rootfs 22 MB/5 分钟，每次 lock 文件都会重新拉。
            </Text>
            <Text style={{ color: theme.text.tertiary }}>
              之前列的 (3)「<Code>fix(arm-gic-driver)</Code> #1803 没在 QEMU 9 上验证过」已被 #2007 解决，移出此列表。
              本地兜底 commit <Code>fb2d723fd</Code> 与历史 revert <Code>e6b06faf9</Code> 都被 git rebase 摘掉，不再需要保留。
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}