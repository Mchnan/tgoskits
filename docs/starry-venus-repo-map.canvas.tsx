// venus 栈六仓关系图（Mchnan GitHub 总图，2026-10-11）
// 配套：AGENTS.md §3 六仓关系条目、starry-upstream-defects-ledger.canvas.tsx。
import {
  Stack, Row, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider, ArchGraph,
  useHostTheme, useCanvasAction, FileLink,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

function FL({ path, label }: { path: string; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} label={label} dispatch={dispatch} />;
}

const buildGraph = {
  nodes: [
    { id: "scripts", label: "stack-scripts" },
    { id: "vkr", label: "virgl-darwin" },
    { id: "qemu", label: "qemu(darwin)" },
    { id: "mvk", label: "MoltenVK" },
    { id: "tgos", label: "tgoskits" },
    { id: "denial", label: "denial" },
    { id: "lib", label: "libvirgl+qemu" },
    { id: "icd", label: "MVK-main ICD" },
    { id: "bin", label: "starryos.bin" },
    { id: "rootfs", label: "deniald@rootfs" },
    { id: "run", label: "qemu-system" },
    { id: "win", label: "Cocoa 窗口" },
  ],
  edges: [
    { from: "scripts", to: "qemu", label: "build-qemu" },
    { from: "vkr", to: "lib", label: "ninja install" },
    { from: "qemu", to: "lib", label: "链接" },
    { from: "mvk", to: "icd", label: "Xcode 重建" },
    { from: "tgos", to: "bin", label: "xtask build" },
    { from: "denial", to: "rootfs", label: "debugfs 注入" },
    { from: "lib", to: "run", label: "" },
    { from: "icd", to: "run", label: "" },
    { from: "bin", to: "run", label: "装载" },
    { from: "rootfs", to: "run", label: "装载" },
    { from: "run", to: "win", label: "venus 链" },
  ],
};

const repoHeaders = ["仓（Mchnan）", "分支 @ HEAD", "来源", "本地路径", "内容"];
const repoAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left", "left"];
const repoRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "success", "success",
];
const repoRows = [
  [
    <Code>tgoskits</Code>,
    <Code>venus-into-dev-0924 @ a1a800e23</Code>,
    "fork rcore-os/tgoskits",
    "~/tgoskits",
    "guest 内核 card0/vgpu/axdisplay、崩溃取证、设计文档与缺陷总账画布（推送时去 local/ 前缀）",
  ],
  [
    <Code>virglrenderer-darwin</Code>,
    <Code>darwin-venus @ 0b8b4914</Code>,
    "独立仓（上游 fd.o virgl）",
    "~/venus-stack/src/virglrenderer",
    "vkr darwin 补丁全集：shm/MTLBuffer 基建、创建失败兼容层、linear tiling 直通",
  ],
  [
    <Code>qemu</Code>,
    <Code>darwin-venus @ 1961a80</Code>,
    "独立仓（上游 qemu/qemu）",
    "~/venus-stack/src/qemu",
    "hvf 未对齐跳过、pixman blob scanout、UI 刷新、cocoa bounds、模式钉死 1280x800",
  ],
  [
    <Code>MoltenVK</Code>,
    <Code>darwin-venus-probes @ fd31714</Code>,
    "fork KhronosGroup/MoltenVK",
    "~/venus-stack/src/MoltenVK",
    "R9-PROBE 仪表（上游 main 67b2682 基底，Xcode 重建装 prefix）",
  ],
  [
    <Code>denial</Code>,
    <Code>venus-stack-e2e @ 3cab163</Code>,
    "fork denialwm/denial",
    "~/denial",
    "合成器 GL root present 修复 + field 诊断（R6 验证态；fork main 领先上游 187 提交，刻意不动）",
  ],
  [
    <Code>venus-stack-scripts</Code>,
    <Code>main @ 94657db</Code>,
    "新建独立仓",
    "~/venus-stack",
    "qstart/build 脚本、e2e-run、取证收集器、探针源码、README 关系表（src/mirror/prefix/镜像不入库）",
  ],
];

export default function VenusRepoMap(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>venus 栈六仓关系（Mchnan GitHub）</H1>
      <Text>
        全部 venus 加速桌面工作落在 Mchnan 名下六个仓：两个本地源码子仓与合成器、
        三个上游 fork、一个宿主脚本工具仓。本页是拓扑与构建/运行链总图；
        缺陷明细见
        <FL path="starry-upstream-defects-ledger.canvas.tsx" label=" 缺陷总账画布" />
        {" "}，逐轮记录见
        <FL path="design/starry-venus-into-dev-card0.md" label=" 设计文档" />。
      </Text>

      <Grid columns={3} gap={12}>
        <Card><CardBody><Stat value="6" label="仓（3 fork + 2 独立 + 1 脚本工具仓）" tone="info" /></CardBody></Card>
        <Card><CardBody><Stat value="5 个分支" label="darwin-venus / probes / e2e / into-dev-0924 / main" tone="success" /></CardBody></Card>
        <Card><CardBody><Stat value="逐仓核验一致" label="远端 HEAD = 本地 HEAD（推送后 ls-remote 比对）" tone="success" /></CardBody></Card>
      </Grid>

      <Card>
        <CardHeader><H2>构建与运行链（谁构建谁、谁装载谁）</H2></CardHeader>
        <CardBody>
          <ArchGraph nodes={buildGraph.nodes} edges={buildGraph.edges} direction="vertical" />
          <Divider />
          <Text>
            运行链入口是 stack-scripts 仓的
            <FL path="/Users/herbcheng/venus-stack/qstart-denial-e2e.sh" label=" qstart-denial-e2e.sh" />
            {" "}：起 qemu-system-aarch64（xres=1280,yres=800），装载 tgoskits 构建的
            starryos.bin 与注入了 deniald + e2e-run.sh 的 denial-full rootfs，
            通过 prefix 的 libvirglrenderer（vkr）驱动 MoltenVK-main ICD，
            渲染结果经 blob scanout → pixman → Cocoa 窗口出屏。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>六仓清单</H2></CardHeader>
        <CardBody>
          <Table headers={repoHeaders} rows={repoRows} columnAlign={repoAlign} rowTone={repoRowTones} />
        </CardBody>
      </Card>

      <Callout tone="info" title="GitHub 操作口径（gh CLI 不存在）">
        <Text>
          推送直接 <Code>git push {"<remote>"}</Code>（HTTPS 走凭据链、SSH 走密钥）；
          fork/建仓/提 issue 用 <Code>git credential fill</Code> 取 osxkeychain 的
          token（api user = Mchnan）后调 GitHub REST API（POST /repos/{"{owner}"}/
          {"{repo}"}/forks、POST /user/repos）。fork 就绪有几秒延迟，先
          ls-remote 轮询再推。denial 的验证态走分支而非 main：fork main 已领先
          上游 187 提交，rebase 会产生未验证树。
        </Text>
      </Callout>

      <Card>
        <CardHeader><H2>关键文件索引</H2></CardHeader>
        <CardBody>
          <Stack gap={6}>
            <Text>
              脚本工具仓 README（含同样的关系表）：
              <FL path="/Users/herbcheng/venus-stack/README.md" label="venus-stack/README.md" />
            </Text>
            <Text>
              启动入口：
              <FL path="/Users/herbcheng/venus-stack/qstart-denial-e2e.sh" label="qstart-denial-e2e.sh" />
              {" / "}
              <FL path="/Users/herbcheng/venus-stack/build-qemu-git.sh" label="build-qemu-git.sh" />
            </Text>
            <Text>
              内核构建配置：
              <FL path="../os/StarryOS/configs/board/qemu-aarch64.toml" label="os/StarryOS/configs/board/qemu-aarch64.toml" />
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Row gap={8}>
        <Pill active>六仓总图</Pill>
        <Pill>3 fork + 2 独立 + 1 脚本仓</Pill>
        <Pill>远端 = 本地</Pill>
      </Row>
    </Stack>
  );
}
