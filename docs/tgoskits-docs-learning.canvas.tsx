// TGOSKits 学习总结（基于 docs/ 目录）
// 一份可被 CanvasGlass 渲染的 .canvas.tsx 文档。
// 内容覆盖：项目总览、三套系统（ArceOS / StarryOS / Axvisor）、
// 组件层次、构建与命令、验证体系、贡献与编码规范、关键设计取舍。
// 所有外部链接保留为相对路径，便于在仓库内跳转阅读。

import {
  Stack,
  H1,
  H2,
  H3,
  Text,
  Card,
  CardHeader,
  CardBody,
  Row,
  Grid,
  Table,
  Pill,
  Stat,
  Callout,
  Code,
  CodeBlock,
  Divider,
  useHostTheme,
  type TableColumnAlign,
  type TableRowTone,
} from "cursor/canvas";

export default function TgoskitsDocsLearning(): JSX.Element {
  const theme = useHostTheme();

  // ---------- 1. 项目总览：四架构 × 三系统 矩阵 ----------
  const matrixHeaders = ["架构", "Target Triple", "QEMU 平台", "ArceOS", "StarryOS", "Axvisor"];
  const matrixRows: Array<{ arch: string; triple: string; qemu: string; a: string; s: string; x: string; tone: TableRowTone }> = [
    { arch: "AArch64", triple: "aarch64-unknown-none-softfloat", qemu: "virt", a: "Rust/C/axtest", s: "system/TTY", x: "Guest smoke", tone: "success" },
    { arch: "RISC-V 64", triple: "riscv64gc-unknown-none-elf", qemu: "virt", a: "Rust/C/axtest", s: "system/TTY", x: "Guest smoke (sstc)", tone: "success" },
    { arch: "x86_64", triple: "x86_64-unknown-none", qemu: "q35 + ACPI", a: "Rust/C/axtest", s: "system/TTY", x: "VMX/SVM, NimbOS UEFI", tone: "success" },
    { arch: "LoongArch64", triple: "loongarch64-unknown-none-softfloat", qemu: "virt (LVZ)", a: "Rust/C/axtest", s: "system/TTY", x: "动态 UEFI smoke", tone: "warning" },
  ];

  // ---------- 2. 三套系统定位对比 ----------
  const systemHeaders = ["系统", "定位", "入口", "配置目录", "测试目录", "根级入口"];
  const systemAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left", "left", "left"];
  const systemRows: Array<{ sys: string; role: string; entry: string; cfg: string; test: string; cmd: string; tone: TableRowTone }> = [
    { sys: "ArceOS", role: "可组合的模块化 Unikernel，TGOSKits 基础运行时", entry: "os/arceos/", cfg: "os/arceos/configs/", test: "test-suit/arceos/", cmd: "cargo arceos", tone: "info" },
    { sys: "StarryOS", role: "面向 Linux 应用兼容的组件化宏内核", entry: "os/StarryOS/", cfg: "os/StarryOS/configs/", test: "test-suit/starryos/", cmd: "cargo starry", tone: "success" },
    { sys: "Axvisor", role: "支持多 Guest 的 Type-I Hypervisor", entry: "os/axvisor/", cfg: "os/axvisor/configs/{board,vms}/", test: "test-suit/axvisor/", cmd: "cargo axvisor", tone: "warning" },
  ];

  // ---------- 3. 组件层次分类统计 ----------
  const layerHeaders = ["分类", "Crate 数", "说明"];
  const layerRows: Array<{ c: string; n: string; d: string; tone: TableRowTone }> = [
    { c: "组件层", n: "92", d: "可独立复用的领域实现：调度、内存、虚拟化、设备抽象、文件/网络栈", tone: "info" },
    { c: "ArceOS 层", n: "30", d: "ArceOS 内核模块、API 聚合、用户库与示例应用", tone: "success" },
    { c: "测试层", n: "17", d: "test-suit/{arceos,starryos} 与板测/集成用例", tone: "neutral" },
    { c: "平台层", n: "1", d: "当前唯一内置 axplat-dyn（动态平台）", tone: "warning" },
    { c: "工具层", n: "2", d: "axbuild + tg-xtask：解析、装配、调度", tone: "neutral" },
    { c: "StarryOS / Axvisor 层", n: "2 / 2", d: "系统顶层包，作为最终镜像入口", tone: "info" },
  ];

  // ---------- 4. 关键命令对照 ----------
  const cmdHeaders = ["目标", "配置选择", "构建", "运行", "测试"];
  const cmdRows: Array<{ t: string; sel: string; b: string; r: string; ts: string; tone: TableRowTone }> = [
    {
      t: "ArceOS",
      sel: "cargo arceos defconfig qemu-<arch>",
      b: "cargo arceos build --package <pkg>",
      r: "cargo arceos qemu",
      ts: "cargo arceos test qemu --test-group {rust|c}",
      tone: "info",
    },
    {
      t: "StarryOS",
      sel: "cargo starry defconfig qemu-<arch>",
      b: "cargo starry build",
      r: "cargo starry rootfs --arch <a> && cargo starry qemu",
      ts: "cargo starry test qemu --target <triple>",
      tone: "success",
    },
    {
      t: "Axvisor",
      sel: "cargo axvisor defconfig qemu-<arch>",
      b: "cd os/axvisor && cargo xtask build",
      r: "cargo axvisor qemu --vmconfigs tmp/vmconfigs/*.toml",
      ts: "cargo axvisor test qemu/uboot/board",
      tone: "warning",
    },
  ];

  // ---------- 5. 改动影响评估 ----------
  const impactHeaders = ["改动位置", "影响范围", "最小验证路径", "补充验证"];
  const impactRows: Array<{ loc: string; scope: string; minimal: string; extra: string; tone: TableRowTone }> = [
    {
      loc: "components/（基础 crate）",
      scope: "三套系统都可能受影响",
      minimal: "cargo test -p <crate>",
      extra: "ArceOS helloworld + StarryOS/Axvisor 最小用例",
      tone: "danger",
    },
    {
      loc: "os/arceos/modules/*",
      scope: "ArceOS + 上游复用路径（StarryOS、Axvisor）",
      minimal: "cargo xtask arceos run --package arceos-helloworld --arch riscv64",
      extra: "补 StarryOS / Axvisor 最小 case",
      tone: "warning",
    },
    {
      loc: "components/starry-* / os/StarryOS/kernel",
      scope: "仅 StarryOS（Linux 兼容语义）",
      minimal: "cargo xtask starry run --arch riscv64 --package starryos",
      extra: "cargo starry test qemu --target riscv64",
      tone: "info",
    },
    {
      loc: "virtualization/ + os/axvisor",
      scope: "仅 Axvisor（代码 + 配置 + Guest 镜像必须一起验证）",
      minimal: "cd os/axvisor && cargo xtask build",
      extra: "./scripts/setup_qemu.sh arceos && cargo xtask qemu --vmconfigs ...",
      tone: "warning",
    },
    {
      loc: "platforms/*",
      scope: "使用该平台的所有系统",
      minimal: "至少跑通对应架构的 ArceOS 基础启动",
      extra: "StarryOS / Axvisor 启动 smoke",
      tone: "danger",
    },
  ];

  // ---------- 6. 验证体系三层级 ----------
  const verifyHeaders = ["层级", "主要入口", "覆盖范围", "外部依赖"];
  const verifyRows: Array<{ lv: string; entry: string; scope: string; dep: string; tone: TableRowTone }> = [
    { lv: "Host", entry: "cargo xtask test / clippy", scope: "白名单 crate、格式、静态检查", dep: "Rust 工具链", tone: "info" },
    { lv: "QEMU", entry: "cargo {arceos,starry,axvisor} test qemu --target <triple>", scope: "启动、syscall、设备模型、Guest", dep: "QEMU、rootfs / Guest 镜像", tone: "success" },
    { lv: "Board", entry: "cargo {starry,axvisor} test board --board <name>", scope: "固件、真实中断控制器、DMA、真实设备", dep: "self-hosted runner、板卡服务器、串口", tone: "warning" },
  ];

  // ---------- 7. Axvisor 配置体系双层结构 ----------
  const axvHeaders = ["层", "路径", "内容", "影响"];
  const axvRows: Array<{ l: string; p: string; c: string; eff: string; tone: TableRowTone }> = [
    { l: "板级配置", p: "os/axvisor/configs/board/*.toml", c: "target、feature、SMP、VM 列表", eff: "决定 Hypervisor 镜像如何构建", tone: "info" },
    { l: "VM 配置", p: "os/axvisor/configs/vms/{qemu/<arch>,<board>}/", c: "[base] [kernel] [devices] 段；CPU、内存、镜像、直通设备", eff: "决定启动哪个 Guest 与其资源", tone: "success" },
    { l: "运行产物", p: "tmp/vmconfigs/*.generated.toml", c: "由 build + vm 配置生成", eff: "由 cargo axvisor qemu 消费", tone: "neutral" },
  ];

  return (
    <Stack gap={20} style={{ padding: "24px 32px", color: theme.text.primary }}>
      {/* ============ 标题与项目坐标 ============ */}
      <Stack gap={8}>
        <H1>TGOSKits 学习总结</H1>
        <Text>
          基于本仓库 <Code>docs/</Code> 目录（214 份 md/mdx，<Code>book/</Code> 中 6 份规范与设计），
          提炼项目结构、三套系统协作方式、构建与测试入口，以及 Rust 编码基线。
        </Text>
        <Row gap={8} wrap>
          <Pill tone="info">Rust 2024 · nightly-2026-07-15</Pill>
          <Pill tone="info">Workspace v0.5.12</Pill>
          <Pill tone="success">Apache-2.0</Pill>
          <Pill tone="warning">184 个 workspace 成员</Pill>
          <Pill tone="neutral">16 层依赖分级</Pill>
        </Row>
      </Stack>

      <Divider />

      {/* ============ 0. 一句话定位 ============ */}
      <Callout tone="info" title="项目定位">
        <Text>
          TGOSKits 不是单一 OS 发行版，而是面向 OS / Linux 兼容内核 / 虚拟化监视器研发的 Rust
          集成工作区。ArceOS、StarryOS、Axvisor 三套系统在同一 workspace 内共享底层 crate，
          通过 Cargo feature 与 Git Subtree 进行组合与独立演进。
        </Text>
      </Callout>

      {/* ============ 1. 三套系统坐标 ============ */}
      <Card>
        <CardHeader>
          <H2>1 · 三套系统坐标</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              三套系统共享 <Code>components/</Code>、<Code>platforms/</Code>、<Code>drivers/</Code>、<Code>memory/</Code>、
              <Code>virtualization/</Code> 这五个领域目录；<Code>os/</Code> 下各自维护系统特定的 OS Glue 与配置。
            </Text>
            <Table
              headers={systemHeaders}
              rows={systemRows.map((r) => [r.sys, r.role, r.entry, r.cfg, r.test, r.cmd])}
              columnAlign={systemAlign}
              rowTone={systemRows.map((r) => r.tone)}
            />
            <Text>
              ArceOS 同时是独立运行时、示例平台与共享能力提供者；StarryOS 在其上补齐进程 / syscall / 信号 /
              rootfs 等 Linux 兼容语义；Axvisor 在其上构建 Type-I Hypervisor，复用 axvm、axvm-types、各架构 vCPU 后端
              与 axdevice 三类虚拟化组件。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 2. 架构与平台支持矩阵 ============ */}
      <Card>
        <CardHeader>
          <H2>2 · 架构与平台支持矩阵</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              工作区统一管理四个 64 位架构。同一 target 名称在三套系统中各自落到不同
              <Code>qemu-&lt;arch&gt;.toml</Code>，由 axbuild 解析后再交给 ostool。
            </Text>
            <Table
              headers={matrixHeaders}
              rows={matrixRows.map((r) => [r.arch, r.triple, r.qemu, r.a, r.s, r.x])}
              rowTone={matrixRows.map((r) => r.tone)}
            />
            <Callout tone="warning" title="LoongArch64 与 Axvisor LVZ">
              <Text>
                Axvisor 的 LoongArch64 路径依赖 LVZ 虚拟化扩展，必须使用专用
                <Code> QEMU-LVZ </Code>镜像（<Code>ghcr.io/rcore-os/tgoskits-container-axvisor-lvz:latest</Code>），
                标准 <Code>qemu-system-loongarch64</Code> 无法运行该配置。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 3. 运行时架构图（5 层） ============ */}
      <Card>
        <CardHeader>
          <H2>3 · 运行时架构（五层）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              上层只能通过下一层公开的能力边界使用底层资源；依赖方向自上而下，但启动时序不固定，
              由 feature 装配决定每一步是否执行。
            </Text>
            <CodeBlock
              language="text"
              code={`systems          ArceOS · StarryOS · Axvisor
  ↑ depends on
system services   syscall/process · runtime/sched · VM/vCPU · OS Glue
  ↑ depends on
shared components scheduling · sync · memory · virtualization · device ifaces
  ↑ depends on
platform          CPU/trap/context · HAL · boot/firmware handshake
  ↑ depends on
drivers           block · net · irq · bus/SoC · misc device drivers`}
            />
            <Grid columns={3} gap={12}>
              <Card>
                <CardBody>
                  <Stat value="146" label="crate 总数（docs/components 统计）" tone="info" />
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <Stat value="533" label="仓库内有向依赖边" tone="success" />
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <Stat value="16" label="依赖分级（层 0 基础 → 层 16 应用/测试）" tone="warning" />
                </CardBody>
              </Card>
            </Grid>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 4. 组件层次分类 ============ */}
      <Card>
        <CardHeader>
          <H2>4 · 组件层次分类</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              分类与目录不完全对齐——<Code>components/</Code> 平铺，按 <Code>repos.csv</Code> 中的
              <Code> category </Code>字段和层级表归类。理解分类便于评估改动影响。
            </Text>
            <Table
              headers={layerHeaders}
              rows={layerRows.map((r) => [r.c, r.n, r.d])}
              rowTone={layerRows.map((r) => r.tone)}
            />
            <Text>
              层级 0 是基础（无仓库内依赖），层 16 是应用与测试：<Code>arceos-helloworld</Code>、
              <Code> axvisor </Code>、21 个 <Code>arceos-*</Code> 测试用例都在最顶层。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 5. 构建命令统一入口 ============ */}
      <Card>
        <CardHeader>
          <H2>5 · 统一构建入口</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              所有构建、运行与测试通过 <Code>cargo xtask</Code> 调度，底层由 <Code>scripts/axbuild</Code>（axbuild）实现。
              <Code>.cargo/config.toml</Code> 把 <Code>cargo arceos</Code> / <Code>cargo starry</Code> /
              <Code>cargo axvisor</Code> 映射为同一 <Code>cargo xtask</Code> 别名。
            </Text>
            <Table
              headers={cmdHeaders}
              rows={cmdRows.map((r) => [r.t, r.sel, r.b, r.r, r.ts])}
              rowTone={cmdRows.map((r) => r.tone)}
            />
            <CodeBlock
              language="bash"
              code={`# 最短路径
cargo xtask arceos qemu --arch aarch64
cargo xtask starry rootfs --arch aarch64 && cargo xtask starry qemu --arch aarch64
cargo xtask axvisor qemu --arch aarch64`}
            />
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 6. 验证体系 ============ */}
      <Card>
        <CardHeader>
          <H2>6 · 三层验证体系</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              验证按运行边界分 Host / QEMU / Board 三层。修改任何共享组件都应至少覆盖 Host + QEMU；
              涉及硬件/板级时再加 Board。
            </Text>
            <Table
              headers={verifyHeaders}
              rows={verifyRows.map((r) => [r.lv, r.entry, r.scope, r.dep])}
              rowTone={verifyRows.map((r) => r.tone)}
            />
            <Callout tone="info" title="CI 三层架构">
              <Text>
                文档 <Code>docs/build/ci.md</Code> 详细描述了 <Code>static_checks</Code> →
                <Code> test_checks </Code> 流水线：fmt / publish-dry-run / sync-lint / spin-lint
                通过后才并发跑 clippy、std 测试与三套系统 QEMU 测试；self-hosted runner 负责物理板
                与 x86 KVM 场景。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 7. 改动影响评估 ============ */}
      <Card>
        <CardHeader>
          <H2>7 · 改动影响评估（评估 → 验证）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              这是 <Code>docs/development/components.md</Code> 推荐的渐进式验证策略：
              定位最近的消费者 → 走最小验证路径 → 补充统一测试。
            </Text>
            <Table
              headers={impactHeaders}
              rows={impactRows.map((r) => [r.loc, r.scope, r.minimal, r.extra])}
              rowTone={impactRows.map((r) => r.tone)}
            />
            <Callout tone="danger" title="跨系统基础组件必须多路径验证">
              <Text>
                修改 <Code>components/axerrno</Code>、<Code>components/kspin</Code>、
                <Code> memory/page_table_multiarch </Code>等基础 crate 时，至少跑 host 测试 + ArceOS
                helloworld + 一个上层系统。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 8. StarryOS syscall 拓扑 ============ */}
      <Card>
        <CardHeader>
          <H2>8 · StarryOS syscall 拓扑（12 个功能域）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              <Code>kernel/src/syscall/mod.rs</Code> 的 <Code>handle_syscall()</Code> 是 StarryOS 的核心控制中枢，
              按 Sysno 分发到 12 个子模块。Linux 兼容语义在这一层明确定义。
            </Text>
            <Grid columns={4} gap={8}>
              <Pill tone="info">fs / io_mpx</Pill>
              <Pill tone="info">ipc / mm / net</Pill>
              <Pill tone="info">signal / sync</Pill>
              <Pill tone="info">task / time</Pill>
              <Pill tone="info">resources / sys</Pill>
              <Pill tone="info">mod.rs（入口）</Pill>
            </Grid>
            <Text>
              添加新 syscall 的标准流程：<Code>mod.rs</Code> 加 match arm → 按功能类别放子模块 → 实现
              <Code> sys_xxx </Code>→ 写最小 C 用户态程序 → 交叉编译放入 rootfs → QEMU 验证 →
              收入 <Code>test-suit/starryos/</Code>。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 9. Axvisor 配置与运行主线 ============ */}
      <Card>
        <CardHeader>
          <H2>9 · Axvisor：配置与运行主线</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              Axvisor 的核心设计前提是"代码、配置和 Guest 镜像同等重要"。常见"看起来像代码 bug"的问题
              根因在 <Code>.build.toml</Code>、<Code>vm_configs</Code>、<Code>kernel_path</Code> 或
              <Code> tmp/rootfs.img </Code>未对齐。
            </Text>
            <Table
              headers={axvHeaders}
              rows={axvRows.map((r) => [r.l, r.p, r.c, r.eff])}
              rowTone={axvRows.map((r) => r.tone)}
            />
            <CodeBlock
              language="bash"
              code={`# Axvisor 最小 QEMU 验证
cargo axvisor defconfig qemu-aarch64
cargo axvisor build
./scripts/setup_qemu.sh arceos
cargo axvisor qemu \\
  --build-config configs/board/qemu-aarch64.toml \\
  --qemu-config .github/workflows/qemu-aarch64.toml \\
  --vmconfigs tmp/vmconfigs/arceos-aarch64-qemu-smp1.generated.toml`}
            />
            <Text>
              vCPU 运行循环处理 <Code>Hypercall</Code>、<Code>ExternalInterrupt</Code>、<Code>Halt/CpuDown</Code>、
              <Code>SystemDown</Code> 等 <Code>VmExit</Code>；VM 生命周期经过 Loading → Loaded → Running →
              Suspended → Stopping → Stopped 六个状态，由 shell 命令约束状态转移合法性。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 10. 驱动框架重构方向 ============ */}
      <Card>
        <CardHeader>
          <H2>10 · 驱动框架重构方向</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              宿主物理设备路径正在收敛到 <Code>rdrive + rdif</Code>。FDT/ACPI 等运行时发现来源和
              外部自定义平台适配走同一套 rdrive 注册与 probe 主线；文件系统、网络、显示、输入、
              vsock、StarryOS 和 Axvisor 直接消费 <Code>rdif-* / rd-*</Code> 设备。
            </Text>
            <Callout tone="warning" title="边界：本轮不迁移 axdevice">
              <Text>
                <Code>axdevice / axdevice_base</Code> 继续作为 Axvisor / axvm 的 guest emulated device model，
                与宿主物理设备路径保持边界。
              </Text>
            </Callout>
            <CodeBlock
              language="text"
              code={`drivers/
├── blk/      sdhci-host · dwmmc-host · phytium-mci-host · nvme-driver
├── net/      realtek-rtl8125 · eth-intel · fxmac_rs · rd-net
├── intc/     arm-gic-driver · riscv_plic · rdif-intc
├── pci/      pcie · rk3588-pci · rdif-pcie
├── usb/      usb-host · usb-if · usb-serial
├── npu/      rockchip-npu · k230-kpu · sg2002-tpu
└── interface/  统一 rdif-* 接口契约`}
            />
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 11. 平台层与 somehal ============ */}
      <Card>
        <CardHeader>
          <H2>11 · 平台层</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              平台层把启动入口、内存布局、时钟、中断、控制台、电源、SMP、设备发现接入
              <Code> ax-plat / ax-hal </Code>。当前默认路径是
              <Code> axplat-dyn + somehal + someboot </Code>：
            </Text>
            <Grid columns={3} gap={12}>
              <Card>
                <CardBody>
                  <H3>axplat-dyn</H3>
                  <Text>唯一内置平台实现。从 FDT/ACPI/UEFI/U-Boot 信息建立动态平台。</Text>
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <H3>somehal</H3>
                  <Text>运行时平台事实来源：中断控制器、总线、设备 glue。</Text>
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <H3>someboot</H3>
                  <Text>启动与固件交接：解析 U-Boot 传入的 FDT，建立页表并启动 SMP。</Text>
                </CardBody>
              </Card>
            </Grid>
            <Callout tone="info" title="外部 ax-plat-*">
              <Text>
                外部平台可以通过独立 <Code>ax-plat</Code> 实现接入，但需自己维护启动、链接、IRQ、timer
                和设备发现 glue。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 12. 仓库管理与 Subtree ============ */}
      <Card>
        <CardHeader>
          <H2>12 · 仓库管理与 Git Subtree</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              主仓库采用三层分支策略：功能分支 → <Code>dev</Code>（集成分支）→ <Code>main</Code>（稳定基线）。
              所有 PR 默认进入 <Code>dev</Code>，禁止直接 PR 到 <Code>main</Code>。
            </Text>
            <Text>
              组件同步由 <Code>scripts/repo/repo.py</Code> 手动管理，组件来源记录在
              <Code> scripts/repo/repos.csv </Code>。常见命令：
            </Text>
            <CodeBlock
              language="bash"
              code={`python3 scripts/repo/repo.py list
python3 scripts/repo/repo.py pull <component> -b dev
python3 scripts/repo/repo.py push <component> -b dev
python3 scripts/repo/repo.py init -f scripts/repo/repos.csv`}
            />
            <Callout tone="info" title="何时需要动 subtree">
              <Text>
                只有当新组件要作为独立 subtree 长期维护时才需要改 <Code>repos.csv</Code>。
                仅在 TGOSKits 内部做原型的组件，先在 workspace 内接线即可。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 13. Rust 编码基线摘要 ============ */}
      <Card>
        <CardHeader>
          <H2>13 · Rust 编码基线（book/guideline 摘要）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              全部细则见 <Code>book/guideline/code-quality.md</Code>，下表摘出最影响设计与评审的硬性要求。
            </Text>
            <Grid columns={2} gap={12}>
              <Card>
                <CardBody>
                  <H3>可读性 & 函数</H3>
                  <Text>· 名字表达业务意图，不写 <Code>data</Code>/<Code>flag</Code>。</Text>
                  <Text>· 入口函数放文件开头；编排函数像目录，按"主线 → 步骤"展开。</Text>
                  <Text>· 函数 ≤ 3 个参数；超参用 struct / builder。</Text>
                  <Text>· 布尔参数替换为 enum（如 <Code>EmailVerification::Required</Code>）。</Text>
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <H3>类型 & 错误</H3>
                  <Text>· 用 newtype 表达语义，避免裸 <Code>u64</Code> / <Code>String</Code>。</Text>
                  <Text>· 公共字段保持私有，由方法维护不变量。</Text>
                  <Text>· 库用 <Code>thiserror</Code> 派生具体错误；host bin 用 <Code>anyhow</Code>。</Text>
                  <Text>· 生产路径不出现裸 <Code>unwrap()</Code>，错误用 <Code>?</Code> 显式传播。</Text>
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <H3>模块与边界</H3>
                  <Text>· 模块按领域组织，不按技术层拆散。</Text>
                  <Text>· <Code>mod.rs</Code> 只做目录页；业务实现下沉到 <Code>&lt;domain&gt;/*.rs</Code>。</Text>
                  <Text>· 带子模块的目录使用 <Code>foo/mod.rs + foo/child.rs</Code> 风格。</Text>
                  <Text>· 第三方依赖隔离在 adapter / repository 层。</Text>
                </CardBody>
              </Card>
              <Card>
                <CardBody>
                  <H3>并发 & unsafe</H3>
                  <Text>· 锁作用域要短：不要在持锁时做 I/O / <Code>.await</Code>。</Text>
                  <Text>· <Code>unsafe</Code> 必须小、收敛；外层提供 safe API + <Code># Safety</Code> 文档。</Text>
                  <Text>· 共享优先级：不共享 → channel → <Code>Arc&lt;T&gt;</Code> → <Code>Arc&lt;Mutex&lt;T&gt;&gt;</Code> → 原子 → unsafe。</Text>
                </CardBody>
              </Card>
            </Grid>
            <Callout tone="warning" title="feature-development 与 syscall 准则">
              <Text>
                高风险功能须在合并前独立可评审的设计材料；涉及 StarryOS 用户可见 syscall / Linux ABI
                行为时，必须重读 <Code>book/guideline/starry/syscall.md</Code>。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 14. 调试方案摘要 ============ */}
      <Card>
        <CardHeader>
          <H2>14 · 调试方案摘要</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              VS Code 作为统一入口，三部分协作：<Code>.vscode/launch.json</Code>（断点）、
              <Code> .vscode/tasks.json </Code>（前置任务）、<Code>.vscode/session.py</Code>（会话生命周期）。
            </Text>
            <Text>
              预置 6 个 AArch64 调试配置：<Code>ArceOS / StarryOS / Axvisor × Main / Boot</Code>。
              Main 聚焦主执行路径，Boot 聚焦更早的初始化阶段，便于按问题阶段前移断点。
            </Text>
            <Callout tone="warning" title="当前限制">
              <Text>
                仅 AArch64 target 硬编码；GDB stub 默认端口 1234，同一时刻只能运行一个调试会话。
                日志写在 <Code>target/qemu-debug/</Code>，长时间开发后可整目录清理。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 15. 常见陷阱 / 踩坑清单 ============ */}
      <Card>
        <CardHeader>
          <H2>15 · 常见陷阱</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>· 改 <Code>os/arceos/modules</Code> 只跑 ArceOS 是不够的——StarryOS / Axvisor 会同步受影响。</Text>
            <Text>· StarryOS 改 syscall 时只跑 <Code>qemu</Code> 不够，需要把测试程序放入 rootfs 并收入 <Code>test-suit/</Code>。</Text>
            <Text>· Axvisor "代码改对但 Guest 不起"，80% 是 <Code>vm_configs</Code> / <Code>kernel_path</Code> / <Code>tmp/rootfs.img</Code> 未对齐。</Text>
            <Text>· LoongArch64 Axvisor 必须用 LVZ 镜像，普通 <Code>qemu-system-loongarch64</Code> 跑不动。</Text>
            <Text>· StarryOS 暂不引入 KCOV：编译插桩 + 多核语义尚未稳定。</Text>
            <Text>· JH7110 / Phytium MCI / RK3568 DWMMC 暂时没有 <Code>ax-driver</Code> 注册 feature，板级根文件系统路径不要把它们当受支持配置。</Text>
            <Text>· CI 矩阵的 self-hosted runner 任务仅在 <Code>rcore-os</Code> 仓库触发；fork PR 会回退到 <Code>ubuntu-latest</Code> + base 容器。</Text>
          </Stack>
        </CardBody>
      </Card>

      {/* ============ 16. 文档地图：阅读顺序建议 ============ */}
      <Card>
        <CardHeader>
          <H2>16 · 文档地图：推荐阅读顺序</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>① <Code>docs/introduction/overview.md</Code> — 项目定位与三系统关系。</Text>
            <Text>② <Code>docs/quickstart/overview.md</Code> + 各系统 quickstart — 把三套系统入口跑通。</Text>
            <Text>③ <Code>docs/architecture/overview.md</Code> + 各系统架构页 — 理解依赖方向与运行主线。</Text>
            <Text>④ <Code>docs/components/overview.md</Code> + <Code>layers.md</Code> — 组件地图与 16 层分级。</Text>
            <Text>⑤ <Code>docs/build/overview.md</Code> + <Code>configuration.md</Code> — axbuild 与请求复用。</Text>
            <Text>⑥ <Code>docs/development/components.md</Code> — 改组件前先评估影响范围。</Text>
            <Text>⑦ <Code>book/guideline/code-quality.md</Code> + <Code>feature-development.md</Code> — 编码与功能开发基线。</Text>
            <Text>⑧ <Code>docs/contributing/repo.md</Code> — 仅在管理 subtree 时进入。</Text>
          </Stack>
        </CardBody>
      </Card>

      <Divider />

      <Text style={{ color: theme.text.tertiary }}>
        本文档基于 TGOSKits 仓库 <Code>docs/</Code> 与 <Code>book/</Code> 当前内容生成；
        仓库处于积极开发中，章节细节会随版本演进，请以最新源文档为准。
      </Text>
    </Stack>
  );
}
