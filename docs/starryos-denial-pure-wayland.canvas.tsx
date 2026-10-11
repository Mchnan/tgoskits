import {
  Stack, Grid, H1, H2, Text, Card, CardHeader, CardBody,
  Table, Stat, Callout, Code, Divider,
  ArchGraph, FileLink, useCanvasAction,
  type TableColumnAlign,
} from "cursor/canvas";

function FL({
  path, line, lineSha, label,
}: { path: string; line?: number; lineSha?: string; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} line={line} lineSha={lineSha} label={label} dispatch={dispatch} />;
}

function VerdictStrip() {
  return (
    <Grid columns={4} gap={12}>
      <Card>
        <CardBody>
          <Stat value="Wayland-first" label="denial 官方架构定位" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="开关已落地" label="上游 --no-xwayland（a974c10）" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="默认仍启用" label="feature xwayland 在 default 集" tone="warning" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="0 个" label="rootfs 内 X11 GUI 应用" tone="success" />
        </CardBody>
      </Card>
    </Grid>
  );
}

const graph = {
  nodes: [
    { id: "deniald", label: "deniald" },
    { id: "frontend", label: "WaylandFrontend" },
    { id: "spawn", label: "XWayland::spawn" },
    { id: "x11sock", label: "/tmp/.X11-unix" },
    { id: "xwmtray", label: "X11Wm + 托盘" },
    { id: "atlas", label: "denial-atlas" },
    { id: "wlcli", label: "Wayland 客户端" },
  ],
  edges: [
    { from: "deniald", to: "frontend", label: "init" },
    { from: "frontend", to: "spawn", label: "enabled 门控" },
    { from: "spawn", to: "x11sock", label: "建 socket" },
    { from: "x11sock", to: "spawn", tone: "back" as const, label: "全占满=fatal" },
    { from: "spawn", to: "xwmtray", label: "ready 后" },
    { from: "deniald", to: "atlas", label: "进程内" },
    { from: "deniald", to: "wlcli", label: "xdg shell" },
  ],
};

const evidenceHeaders = ["论断", "证据位置", "说明"];
const evidenceAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const evidenceRows = [
  {
    claim: "denial 是 Flutter-native Wayland 组合器",
    ev: <FL path="../../denial/docs/architecture.md" line={3} lineSha="d99b7cb9" label="architecture.md:3" />,
    note: "Smithay 提供 Wayland / DRM/KMS / libinput / Xwayland 基座，Flutter 拥有 shell 场景；系统里不存在独立 X server。",
    tone: "success",
  },
  {
    claim: "上游已把 Xwayland 变为可选",
    ev: <FL path="../../denial/compositor/src/bin/deniald/options.rs" line={297} lineSha="b098ee28" label="options.rs:297" />,
    note: "a974c10「Make Xwayland optional」新增 --no-xwayland 解析，usage 帮助文本同步（options.rs:355）；默认值取 cfg!(feature = \"xwayland\")（options.rs:211），回归测试锁定默认行为（options.rs:1431）。",
    tone: "success",
  },
  {
    claim: "spawn 仅在开关启用时发生",
    ev: <FL path="../../denial/compositor/src/bin/deniald/wayland_frontend/startup.rs" line={250} lineSha="8fe812ac" label="startup.rs:250" />,
    note: "WaylandFrontend 构造把 xwayland_enabled 传入 XWaylandState::start；禁用路径在 xwayland.rs:82 提前返回 active: None，只打 info 日志，不碰 socket 目录。",
    tone: "success",
  },
  {
    claim: "启用时 socket 耗尽仍致命",
    ev: <FL path="../../.cargo/git/checkouts/smithay-312425d48e59d8c8/812bd33/src/xwayland/x11_sockets.rs" line={43} lineSha="0c989d97" label="x11_sockets.rs:43" />,
    note: "smithay 例试遍 display 0–32 建 /tmp/.X11-unix/X<n> 与 /tmp/.X<n>-lock，全失败即报本错误；startup.rs:257 的 ? 传播到 denial_main，fatal error 退出。",
    tone: "danger",
  },
  {
    claim: "X11 唯一真实消费者是 XEmbed 托盘",
    ev: <FL path="../../denial/compositor/src/bin/deniald/wayland_frontend/xwayland.rs" line={162} lineSha="b04d1bf2" label="xwayland.rs:162" />,
    note: "XWM 就绪后启动 XEmbed 托盘宿主；失败本就走 warn 降级，不影响其余功能。",
    tone: "info",
  },
  {
    claim: "「无 XWayland」退路已由上游做完",
    ev: <FL path="../../denial/compositor/src/bin/deniald/wayland_frontend/xwayland.rs" line={59} lineSha="5de57d19" label="xwayland.rs:59" />,
    note: "XWaylandState.active 整体 Option<ActiveXWayland> 化，xwm / xembed_tray 也是 Option 字段；旧基线「xwayland_client 非可选需 guard」的问题随 a974c10 重构消失。",
    tone: "success",
  },
  {
    claim: "上游 ROADMAP 保留 Xwayland",
    ev: <FL path="../../denial/ROADMAP.md" line={33} lineSha="40bbb020" label="ROADMAP.md:33" />,
    note: "「Reliable Xwayland」仍是路线图目标：开关是可选模式，不是替换架构。",
    tone: "warning",
  },
];

const rootfsHeaders = ["取证项", "结果", "含义"];
const rootfsAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const rootfsRows = [
  {
    item: "/usr/lib GUI 工具链",
    result: "GTK / Qt 库 0 个",
    note: "仅有 libX11 / libxcb 全家（Xwayland 的依赖），无任何 GUI 应用框架。",
    tone: "success",
  },
  {
    item: "/usr/bin 应用清单",
    result: "busybox + musl 工具链 + dbus + deniald/denialctl",
    note: "唯一的 desktop entry 是 org.freedesktop.Xwayland.desktop（Xwayland 自带）。",
    tone: "success",
  },
  {
    item: "Flutter shell 形态",
    result: "进程内 denial-atlas 画布",
    note: "经 deniald 内部 Rust embedder 渲染进合成器场景，既非 X 客户端也非 Wayland 客户端。",
    tone: "info",
  },
  {
    item: "Xwayland 二进制",
    result: "存在，约 1.8MB",
    note: "当前服务零客户端：唯一潜在用户 XEmbed 托盘无宿主应用，pure Wayland 下可裁剪。",
    tone: "warning",
  },
];

const planHeaders = ["落地步骤", "改动内容", "代价", "影响"];
const planAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const planRows = [
  {
    step: "1. 启动参数切换验证",
    change: "deniald 启动命令加 --no-xwayland，不建 /tmp/.X11-unix，验证桌面与 denial-atlas 正常起",
    cost: "小",
    impact: "pure Wayland 模式在本 rootfs 的唯一实测验证",
    tone: "success",
  },
  {
    step: "2. 启动 SOP 更新",
    change: "启动流程删除 mkdir /tmp/.X11-unix 与 chmod 1777",
    cost: "小",
    impact: "目录消失坑与 SOP 特殊步骤一并消失",
    tone: "success",
  },
  {
    step: "3. 托盘换协议",
    change: "XEmbed 托盘宿主换成 StatusNotifierItem（DBus，KDE 系事实标准）监听",
    cost: "中",
    impact: "纯 Wayland 托盘路径补齐；当前 rootfs 无托盘应用，零回归风险",
    tone: "warning",
  },
  {
    step: "4. 应用生态约束",
    change: "未来 GUI 应用强制 Wayland 原生后端（GDK_BACKEND=wayland、Qt -platform wayland、SDL_VIDEODRIVER=wayland）",
    cost: "零",
    impact: "现无第三方 GUI 应用；出现真 X11 应用时再启用 Xwayland",
    tone: "success",
  },
  {
    step: "5. rootfs 裁剪",
    change: "移除 Xwayland（1.8MB）与 libX11 / libxcb* 依赖，或构建时去掉 xwayland feature",
    cost: "小",
    impact: "镜像瘦身；建议在步骤 1 验证通过后做",
    tone: "info",
  },
];

export default function DenialPureWaylandCanvas(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 24 }}>
      <H1>denial pure Wayland 调研：X server 依赖的真相与落地路径</H1>

      <VerdictStrip />

      <Callout tone="info" title="核心结论">
        <Text>
          denial 在架构上本来就是 pure Wayland：deniald 自己就是显示服务器与 Wayland
          组合器，系统里从来没有独立 X server。上游 a974c10「Make Xwayland
          optional」落地后，Xwayland 已是可选组件——
          <Code>--no-xwayland</Code> CLI 开关就绪，禁用时完全不触碰
          <Code> /tmp/.X11-unix</Code>；只是编译 feature
          <Code> xwayland </Code>仍在 default 集（默认启用），且启用状态下
          socket 耗尽仍致命。在本 StarryOS rootfs 上 Xwayland 当前服务零客户端，
          落地动作收敛为：启动参数切换验证 + 启动流程去除 mkdir。
        </Text>
      </Callout>

      <H2>一、启动硬依赖链（问题根源）</H2>
      <Card>
        <CardHeader>deniald 启动依赖图</CardHeader>
        <CardBody>
          <ArchGraph nodes={graph.nodes} edges={graph.edges} direction="vertical" />
          <Stack gap={4}>
            <Text>
              虚线回边是关键路径：开关启用时 <Code>/tmp/.X11-unix</Code>
              全被占满会让 <Code>XWayland::spawn</Code> 返回 Err，经
              <Code> ? </Code>传到 <Code>denial_main()</Code>，deniald 打印 fatal
              error 退出；<Code>--no-xwayland</Code> 时 spawn
              整段跳过（xwayland.rs:82 提前返回 <Code>active: None</Code>），
              socket 目录根本不会被访问。
            </Text>
            <Text>
              Xwayland 是 smithay 拉起的子进程（兼容层），不是被依赖的显示服务器；
              denial 的 Wayland、渲染、输入路径完全不经过它。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <H2>二、证据链</H2>
      <Card>
        <CardHeader>论断与文件级证据（锚点含内容指纹，行号漂移可自动发现）</CardHeader>
        <CardBody>
          <Table
            headers={evidenceHeaders}
            rows={evidenceRows.map((r) => [r.claim, r.ev, r.note])}
            columnAlign={evidenceAlign}
            rowTone={evidenceRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <H2>三、rootfs 取证：X11 使用量为零</H2>
      <Card>
        <CardHeader>rootfs-aarch64-denial-full.img 内容盘点</CardHeader>
        <CardBody>
          <Table
            headers={rootfsHeaders}
            rows={rootfsRows.map((r) => [r.item, r.result, r.note])}
            columnAlign={rootfsAlign}
            rowTone={rootfsRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <H2>四、pure Wayland 落地路径</H2>
      <Card>
        <CardHeader>按代价排序的五步方案（步骤 1 的开关上游已备好）</CardHeader>
        <CardBody>
          <Table
            headers={planHeaders}
            rows={planRows.map((r) => [r.step, r.change, r.cost, r.impact])}
            columnAlign={planAlign}
            rowTone={planRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Callout tone="warning" title="与当前帧率排查的关系">
        <Text>
          纯 Wayland 改造不影响帧率主线：现在的 mkdir 只是喂饱 spawn 的 socket 路径，
          Xwayland 空转不消耗渲染资源；桌面帧率瓶颈（llvmpipe 光栅化 +
          presentation 节拍）与它无关。pure Wayland 属于后续清理项，值得做
          （去坑、瘦身、语义诚实），优先级排在帧率修复之后——好在切换只改一个
          启动参数，随时可做。
        </Text>
      </Callout>

      <Divider />
      <H2>附：调试口径速查与关联画板</H2>
      <Card>
        <CardHeader>启动口径与 XWM 实现位置</CardHeader>
        <CardBody>
          <Stack gap={4}>
            <Text>
              十一轮桌面启动流程中的 mkdir <Code>/tmp/.X11-unix</Code> 与
              <Code> chmod 1777 </Code>仅服务于 Xwayland 的 socket 路径；启动命令加
              <Code> --no-xwayland </Code>后，这两步可整体去除。
            </Text>
            <Text>
              XWM 窗口管理、剪贴板桥接、键盘 grab 的完整实现在
              <FL
                path="../../denial/compositor/src/bin/deniald/wayland_frontend/xwayland.rs"
                line={854}
                lineSha="278c85fb"
                label="xwayland.rs XwmHandler"
              />
              ，全部挂在 <Code>active: Option</Code> 之下；gate 掉 spawn
              不触碰这些路径。
            </Text>
            <Text>
              关联画板：
              <FL path="starry-upstream-defects-ledger.canvas.tsx" label="上游缺陷总账" />
              {" · "}
              <FL path="starry-round12-upstream-follow-report.canvas.tsx" label="第十二轮汇报" />
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}
