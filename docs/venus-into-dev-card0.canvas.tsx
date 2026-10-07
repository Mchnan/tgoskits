/*
 * venus-into-dev-card0.canvas.tsx
 * venus 面接进 dev card0 现状看板（2026-10-07）：增量接装完成、三路验证全绿、
 * 遗留收敛为 fence 语义与桌面级 e2e 两笔旧账。
 */
import {
  Stack, Row, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider, TodoListCard,
  useHostTheme, useCanvasAction, FileLink,
  type TableRowTone,
} from "cursor/canvas";

function FL({ path, line, lineSha, label }: { path: string; line?: number; lineSha?: string; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} line={line} lineSha={lineSha} label={label} dispatch={dispatch} />;
}

const compareHeaders = ["验证项", "换装路线（9-24，local/venus-dev-0923）", "接装路线（本轮，6678a8b2a）"];
const compareRowTones: Array<TableRowTone> = ["success", "success", "success", "success", "success"];
const compareRows: string[][] = [
  ["vkprobe（venus 栈）", "PASS（21 步）", "PASS（21 步，含 BAR pattern 往返、读回 4/4）"],
  ["DRM modeset", "69 pass / 16 fail", "125 pass / 0 fail"],
  ["DRM atomic", "90 pass / 35 fail", "85 pass / 0 fail"],
  ["DRM version / perbuf-dumb", "14/0、40/1", "14/0、41/0"],
  ["2D 桌面（cocoa + llvmpipe）", "100% 非黑", "100% 非黑（1280x800，跨截图 8313 字节时钟差）"],
];

const portHeaders = ["层次", "接装内容", "锚点"];
const portRowTones: Array<TableRowTone> = ["info", "info", "info", "info", "info", "warning"];
const portRows: Array<{ cells: Array<string | JSX.Element>; tone: TableRowTone }> = [
  {
    tone: "info",
    cells: [
      "驱动 crate",
      "控制队列改 pending FIFO + token 匹配（fenced 响应宿主推迟到 retire，必须容忍失序完成）；fenced 提交 fire-and-forget；新增 hostmem BAR、MAP/UNMAP_BLOB、SET_SCANOUT_BLOB、submit_3d_deferred；2D/virgl API 原样保留",
      <FL path="../drivers/gpu/virtio-gpu/src/device.rs" line={172} lineSha="bf64658b" label="Pending/token 队列" />,
    ],
  },
  {
    tone: "info",
    cells: [
      "驱动 trait",
      "VirtioGpu3D + register_global_3d/global_3d：内核 DRM 层经 trait 句柄工作，不感知 transport/HAL；Arc 双消费者（显示适配器 + VIRTGPU_* 面）",
      <FL path="../drivers/gpu/virtio-gpu/src/lib.rs" line={301} lineSha="c5bfadbb" label="VirtioGpu3D" />,
    ],
  },
  {
    tone: "info",
    cells: [
      "探针/适配层",
      "PCI SHARED_MEMORY_CFG（cap64）解析重建 BAR；display 探针 2D 不可用降级 3D-only 不注册 display 设备",
      <FL path="../drivers/ax-driver/src/pci/mod.rs" line={1301} lineSha="27bb914e" label="shm 能力解析" />,
    ],
  },
  {
    tone: "info",
    cells: [
      "内核 vgpu 面",
      "新模块：venus VIRTGPU_* + syncobj 全族，状态按 file_id（与 dev card0 per-fd GEM 模型一致）；blob 直映射 hostmem BAR（16 KiB 槽位）；PRIME 走内核本地 dma-buf 替身",
      <FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" line={146} lineSha="1f011e7d" label="Vgpu 状态" />,
    ],
  },
  {
    tone: "info",
    cells: [
      "card0 接线",
      "CONTEXT_INIT capset 4 走 vgpu（VIRGL/VIRGL2 保持 axdisplay，共享 ctx-id 分配器）；ADDFB2 识别 blob 句柄走零拷贝 present；dumb present 先重绑 2D scanout",
      <FL path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" line={457} lineSha="b409a2aa" label="FbBacking::Blob" />,
    ],
  },
  {
    tone: "warning",
    cells: [
      "UAPI 补齐",
      "syncobj 全族 ioctl/结构、MAP_CACHE 常量、blob 结构 v6.15 blob_hints 尾部（ioctl 号编码结构大小，旧 48B 布局落不进 handler）；DRM_CAP_SYNCOBJ_TIMELINE=0x14",
      <FL path="../os/StarryOS/kernel/src/pseudofs/dev/drm.rs" line={207} lineSha="b9fe6dfc" label="TIMELINE cap" />,
    ],
  },
];

export default function VenusIntoDevCard0(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>venus 面接进 dev card0：增量接装闭环（2026-10-07）</H1>
      <Text>
        9-24 换装路线量化了代价（dev DRM 用例 69/16、90/35、40/1），结论是反向接装。
        本轮落地：<FL path="../docs/design/starry-venus-into-dev-card0.md" line={1} lineSha="dd5f474c" label="设计记录" />
        ，提交 <Code>6678a8b2a</Code>（分支 <Code>local/venus-into-dev-0924</Code>，
        基于 dev tip <Code>9a7b868ba</Code> + ax-net 修复 <Code>2dd559c08</Code>），
        全部为增量改动，无整体替换。
      </Text>

      <Grid columns={4} gap={12}>
        <Card><CardBody><Stat value="PASS" label="vkprobe 21 步（含 BAR 往返）" tone="success" /></CardBody></Card>
        <Card><CardBody><Stat value="265/0" label="DRM 四用例合计（换装为 218/52）" tone="success" /></CardBody></Card>
        <Card><CardBody><Stat value="100% 非黑" label="2D 桌面 + 时钟差" tone="success" /></CardBody></Card>
        <Card><CardBody><Stat value="18/18" label="starry-kernel clippy（aarch64）" tone="success" /></CardBody></Card>
      </Grid>

      <Callout tone="success" title="一句话结论">
        <Text>
          venus 要进 dev 的正确形态已经验证：**dev 原驱动 + 增量 venus 面**同时保住
          内核 3D 链路（vkprobe 全绿）和 dev card0 的全部 DRM 语义（四用例全绿），
          2D 桌面无回归。换装路线可以退役，只作 A/B 对照样本。
        </Text>
      </Callout>

      <H2>一、接装清单</H2>
      <Table
        headers={portHeaders}
        rows={portRows.map((r) => r.cells)}
        rowTone={portRows.map((r) => r.tone)}
      />

      <H2>二、三路验证</H2>
      <Table
        headers={compareHeaders}
        rows={compareRows}
        rowTone={compareRowTones}
      />
      <Text>
        A/B 对照：venus 换装分支内核在同一 venus 栈上同样 vkprobe PASS——排除本轮
        改动引入回归。clippy 的 loongarch/riscv 失败是 lwprintf-rs build.rs 依赖
        Linux gcc，在未改动基线上同样失败（macOS 宿主环境缺口，非本轮引入）。
      </Text>

      <Callout tone="warning" title="排查教训（给下一轮）">
        <Stack gap={4}>
          <Text>
            1. DRM_CAP_SYNCOBJ_TIMELINE 在本仓库 UAPI 头是 <Code>0x14</Code>；
            写错值（如凭记忆的 0x1a）mesa 会静默降级 sync-file 路径，EXECBUFFER
            走 FENCE_FD_OUT 同步路径在 venus 上必 DEVICE_LOST。
          </Text>
          <Text>
            2. 失败读数可能来自栈上旧二进制：rootfs 里 <Code>/opt/vgpu/vkprobe</Code>{" "}
            没有窗口钩子，注入 venus-stack/mirror 的 <Code>vkprobe-fast</Code> 后
            新旧内核同样 PASS。对照实验先控变量，再怀疑自己的代码。
          </Text>
          <Text>
            3. QEMU 源树（darwin-venus 分支）带本地提交，重建前先看 git status；
            /tmp 探针工具（HTTP 8100/收集 8000/hold/ctl）会话间会丢，
            按 <FL path="../docs/design/starry-venus-into-dev-card0.md" line={95} lineSha="0f90d61f" label="§排查记录" /> 重建。
          </Text>
        </Stack>
      </Callout>

      <H2>三、遗留与下一步</H2>
      <TodoListCard
        todos={[
          { id: "1", content: "fence 语义：内核把 out-syncobj 置位挪到宿主 fenced response 到达时；宿主 vkr 把 ring seqno 推进挪到 Metal 完成之后（9-24 起的旧账，两端各欠一半）", status: "pending" },
          { id: "2", content: "桌面级 venus e2e：deniald + zink 握手停摆是独立问题（引擎/合成器层，非内核）；venus 栈当前仍开着（/tmp/starry-vgpu-mon.sock）可直接续", status: "pending" },
          { id: "3", content: "接装分支收尾：跑 grouped system 回归确认无跨用例状态泄漏，再决定推 PR 还是先叠 fence 修复", status: "pending" },
          { id: "4", content: "换装分支 local/venus-dev-0923 退役：其研究文档 §9.11/§9.11.1 与画布保留作历史证据，不再作为 venus 进 dev 的载体", status: "pending" },
        ]}
      />

      <Divider />
      <H3>关联记忆与文件</H3>
      <Stack gap={4}>
        <Text>
          <FL path="../AGENTS.md" line={65} lineSha="cf4de6b4" label="AGENTS.md §3 项目记忆：接装条目" />
          　
          <FL path="../AGENTS.md" line={66} lineSha="bbb3c9cd" label="排查方法论条目" />
        </Text>
        <Text>
          <FL path="../docs/design/starry-venus-into-dev-card0.md" line={78} lineSha="f88454c9" label="设计记录 §验证" />
          　
          <FL path="../docs/design/starry-venus-into-dev-card0.md" line={111} lineSha="dfad5d46" label="§遗留" />
        </Text>
        <Text>
          上一轮画布 <Code>venus-dev-tip-port.canvas.tsx</Code>（换装路线 + 桌面卡点证据链）在
          local/venus-dev-0923 分支；本轮未复制到 dev 线，接装后其结论已由本画板与设计记录继承。
        </Text>
        <Text>
          主分支状态：dev tip <Code>9a7b868ba</Code> 不含 venus 面；接装分支
          <Code> local/venus-into-dev-0924</Code> 为唯一载体，工作树干净。
        </Text>
      </Stack>
      <Text>
        <span style={{ color: theme.text.secondary }}>
          看板生成于 2026-10-07，锚点指纹对准提交 6678a8b2a。
        </span>
      </Text>
    </Stack>
  );
}
