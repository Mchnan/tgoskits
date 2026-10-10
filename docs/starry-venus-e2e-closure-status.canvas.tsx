// venus/zink 加速桌面端到端闭环 — 现状与计划（第八轮收官，2026-10-11）
// 黑屏归因（Cocoa 现场呈现轮）+ 下一轮重建 MoltenVK 的计划任务。
import {
  Stack, Row, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider, ArchGraph, TodoListCard,
  useHostTheme, useCanvasAction, FileLink,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

function FL({ path, label }: { path: string; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} label={label} dispatch={dispatch} />;
}

const fixedChain = {
  nodes: [
    { id: "mvk", label: "MoltenVK拒绝创建" },
    { id: "silent", label: "宿主静默失败" },
    { id: "ghost", label: "guest幽灵句柄" },
    { id: "ring", label: "vkr ring死亡" },
    { id: "gpu", label: "GPU通道关闭" },
  ],
  edges: [
    { from: "mvk", to: "silent", label: "async不读响应" },
    { from: "silent", to: "ghost", label: "对象未注册" },
    { from: "ghost", to: "ring", label: "查表fatal" },
    { from: "ring", to: "gpu", label: "ring线程退出" },
  ],
};

const stallChain = {
  nodes: [
    { id: "mvkcall", label: "MVK调用内部阻塞" },
    { id: "mutex", label: "queue锁被持有" },
    { id: "nosync", label: "sync线程堵死" },
    { id: "nofence", label: "fence永不retire" },
    { id: "spin", label: "raster永旋" },
    { id: "freeze", label: "合成器冻结" },
    { id: "black", label: "scanout静止" },
  ],
  edges: [
    { from: "mvkcall", to: "mutex", label: "持锁不返回" },
    { from: "mutex", to: "nosync", label: "WaitForFences不可达" },
    { from: "nosync", to: "nofence", label: "retire响应断流" },
    { from: "nofence", to: "spin", label: "SYNCOBJ_WAIT永旋" },
    { from: "spin", to: "freeze", label: "phase=1000" },
    { from: "freeze", to: "black", label: "无新帧" },
  ],
};

const evidenceHeaders = ["证据", "取证方法", "结论"];
const evidenceAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const evidenceRowTones: Array<TableRowTone | undefined> = [
  "success", "danger", "danger", "info", "danger", "warning",
];
const evidenceRows = [
  [
    "100% 纯黑 → 684 灰像素（跨配置不变）",
    "QEMU monitor screendump 逐像素分析",
    "blob scanout 零拷贝直读资源内存，截到的就是 scanout 真实内容",
  ],
  [
    "Shader library compile failed（VK_ERROR_INITIALIZATION_FAILED）",
    "MVK_CONFIG_LOG_LEVEL=3 + REDIRECT_TO_STDERR 当场抓获",
    "texture2d<float> sampler 遮蔽 MSL sampler 类型，下一行编译失败",
  ],
  [
    "名字与 OpName 无关",
    "剥名 18 处 + 首字母改写 136 处 + 落盘解析零 sampler + 关参数缓冲",
    "1.4.2 捆绑的 SPIRV-Cross 对 combined image sampler 内部生成该名字",
  ],
  [
    "上游 main 已含修复",
    "get_reserved_keyword_set 注释与本轮错误一字不差",
    "1.4.2（2026-07-24 release）未包含，需重建 MoltenVK",
  ],
  [
    "ring 线程卡死在 MoltenVK 调用内",
    "解析行在冻结时刻停止 + vkr sync 线程零 3s 超时 + 内核 stall 告警",
    "持 queue vk_mutex，堵死 sync 线程与 fence retire 链",
  ],
  [
    "lldb 附加被拒绝",
    "debugserver 权限（macOS 安全策略）",
    "调用级卡点留待带 Xcode 的机器定位",
  ],
];

const planItems = [
  {
    id: "r8-attribution",
    content: "黑屏逐层归因完成（screendump 像素 / MVK 日志 / 名字来源四重排除）",
    status: "completed" as const,
  },
  {
    id: "r8-commits",
    content: "vkr 探针与兜底提交 574ce59b；文档与记忆 89fc03534",
    status: "completed" as const,
  },
  {
    id: "r9-rebuild",
    content: "带 Xcode 机器重建 MoltenVK：fetchDependencies 拉上游 main 的 SPIRV-Cross，构建 macOS Release dylib",
    status: "pending" as const,
  },
  {
    id: "r9-swap",
    content: "换装新 dylib + 独立 ICD json（VK_DRIVER_FILES 指向），回归 vkprobe 21 步与 DRM 四用例",
    status: "pending" as const,
  },
  {
    id: "r9-e2e",
    content: "Cocoa e2e 复测：预期 shader 全过、ring 解锁、桌面内容上屏（screendump 非黑占比回升）",
    status: "pending" as const,
  },
  {
    id: "r9-60hz",
    content: "持续帧率 60Hz 测量（presentations / missed_vblanks / deadline_to_presentation）",
    status: "pending" as const,
  },
  {
    id: "r9-stall",
    content: "若 ring 卡点独立于 shader 修复仍存在：在 Xcode 机器 lldb 附加 + Metal GPU capture 定位调用级卡点",
    status: "pending" as const,
  },
  {
    id: "r9-docs",
    content: "结果回写文档 / AGENTS.md 记忆 / 本 canvas",
    status: "pending" as const,
  },
];

const commitHeaders = ["仓库 / 栈", "提交", "内容"];
const commitAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const commitRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success",
];
const commitRows = [
  [
    "virglrenderer（darwin-venus 本地栈）",
    <Code>1f97b006 + 574ce59b</Code>,
    "创建失败 null stub / BindPipeline null 跳过 / 无 pipeline draw 跳过 / SPIR-V 剥名与落盘探针 / sync 停滞日志 / 禁 retry 注释",
  ],
  [
    "tgoskits 内核（local/venus-into-dev-0924）",
    <Code>d08ca64bd</Code>,
    "out-syncobj 推迟到宿主 fence retire + orphan retire 竞态修复",
  ],
  [
    "tgoskits 文档",
    <Code>89fc03534</Code>,
    "第八轮黑屏归因补记 + 对照组环境事实",
  ],
  [
    "denial 工作树",
    <Code>3cab163</Code>,
    "Skia present 修复 + 心跳双通道 + 主循环 phase 相位码",
  ],
];

const memoHeaders = ["备忘", "内容"];
const memoAlign: Array<TableColumnAlign | undefined> = ["left", "left"];
const memoRows = [
  [
    "对照组差异（用户提示）",
    "llvmpipe 组 = brew QEMU（Dock 图标不同源）+ 2D virtio-gpu EDID 的 1280x800；venus 组 = 自建 QEMU + venus 模式 640x480",
  ],
  [
    "禁 retry（已验证）",
    "第二次 vkCreatePipelineCache 会把 ring 线程卡死在驱动调用内部——失败后只能 null stub 直接过",
  ],
  [
    "MVK 调试开关",
    "MVK_CONFIG_LOG_LEVEL=3 + MVK_CONFIG_REDIRECT_LOGGING_TO_STDERR=1 可在 QEMU stderr 抓 MVK 错误与 program_source",
  ],
  [
    "已排除项",
    "SINGLE_QUEUE 信号量风格（=0 无效）、参数缓冲模式（=0 无效）、OpName 来源（改写后错误原样）",
  ],
  [
    "本机构建限制",
    "仅 Command Line Tools，无 xcodebuild——MoltenVK 源构建需完整 Xcode，本机不可行",
  ],
];

export default function VenusClosureStatus(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>venus/zink 加速桌面 — 黑屏归因与重建计划</H1>
      <Text>
        第八轮收官（2026-10-11，Cocoa 现场呈现轮）。用户现场提示（窗口黑屏 +
        llvmpipe 对照组窗口/图标差异）触发逐层归因：黑屏从「不明」收敛为
        「MoltenVK 1.4.2 捆绑 SPIRV-Cross 的 sampler 保留字缺失 + ring 线程
        内部卡点」两件事，修复路径定案为在带 Xcode 的机器重建 MoltenVK。
      </Text>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="2 件" label="黑屏根因收敛：名字冲突 + ring 内部卡点" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="684 px" label="scanout 实测内容（shell 起步帧，跨配置不变）" tone="warning" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="18+136" label="SPIR-V 剥名 / 改写处（名字来源排除）" tone="info" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="8 项" label="第九轮计划任务（2 完成 / 6 待办）" tone="info" />
          </CardBody>
        </Card>
      </Grid>

      <Callout tone="danger" title="核心结论：黑屏 = 上游 SPIRV-Cross 保留字缺失 + MoltenVK 内部阻塞">
        <Text>
          skia 的 GLSL uniform 名为 "sampler"，MoltenVK 1.4.2 捆绑的 SPIRV-Cross
          在生成的 MSL 中让该名字遮蔽 Metal 的 sampler 类型——shader 库编译失败
          （VK_ERROR_INITIALIZATION_FAILED）。该名字与 SPIR-V 调试名无关
          （剥离/改写后错误原样），是旧版对 combined image sampler 的内部生成名。
          上游 main 的保留字集已修（注释与本轮错误一字不差），但 1.4.2 未包含，
          本机无 Xcode 不能重建。另有一条独立的 ring 线程内部卡点（~6 秒冻结），
          调用级定位同样需要 Xcode 机器。
        </Text>
      </Callout>

      <Card>
        <CardHeader>
          <H2>归因链 A — 创建失败链（已修复/已兜底）</H2>
        </CardHeader>
        <CardBody>
          <ArchGraph nodes={fixedChain.nodes} edges={fixedChain.edges} direction="vertical" />
          <Divider />
          <Text>
            第七轮已修：宿主创建失败不再静默（null stub + 先捕获 guest id），
            ring 从每轮必死转为存活（exiting ret=-22 = 0）；内核 out-syncobj
            推迟到宿主 fence retire 并修复 orphan 竞态。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>归因链 B — ring 内部卡点（活跃，第八轮定位）</H2>
        </CardHeader>
        <CardBody>
          <ArchGraph nodes={stallChain.nodes} edges={stallChain.edges} direction="vertical" />
          <Divider />
          <Text>
            ~6 秒处合成器冻结于 phase=1000（dispatch 内），内核 stall 告警
            syncobj 11 等待 queue=[122,124] 永不 retire；宿主 ring 解析行在
            冻结时刻停止、vkr sync 线程零 3s 超时——ring 线程卡死在某个
            MoltenVK 调用内部并持有 queue vk_mutex。已排除：SINGLE_QUEUE
            信号量风格、参数缓冲模式、OpName 来源。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>取证证据</H2>
        </CardHeader>
        <CardBody>
          <Table
            headers={evidenceHeaders}
            rows={evidenceRows}
            columnAlign={evidenceAlign}
            rowTone={evidenceRowTones}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>第九轮计划任务</H2>
        </CardHeader>
        <CardBody>
          <TodoListCard todos={planItems} />
          <Divider />
          <Callout tone="info" title="重建操作要点">
            <Text>
              带完整 Xcode 的机器：clone MoltenVK → fetchDependencies（拉取含
              修复的 SPIRV-Cross main）→ 构建 macOS Release → 产物
              libMoltenVK.dylib 换装 + 独立 ICD json（VK_DRIVER_FILES 指向）→
              先回归 vkprobe/DRM 四用例再上 e2e。本机仅有 CLT，
              xcodebuild 不可用。
            </Text>
          </Callout>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>提交清单</H2>
        </CardHeader>
        <CardBody>
          <Table
            headers={commitHeaders}
            rows={commitRows}
            columnAlign={commitAlign}
            rowTone={commitRowTones}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>关键文件索引</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={6}>
            <Text>
              设计文档（§黑屏归因与 MoltenVK 内部卡点）：
              <FL path="design/starry-venus-into-dev-card0.md" label="docs/design/starry-venus-into-dev-card0.md" />
            </Text>
            <Text>
              项目记忆：
              <FL path="../AGENTS.md" label="AGENTS.md §3" />
            </Text>
            <Text>
              vkr 探针与兜底：
              <FL
                path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_pipeline.c"
                label="vkr_pipeline.c"
              />
              {" / "}
              <FL
                path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_command_buffer.c"
                label="vkr_command_buffer.c"
              />
              {" / "}
              <FL
                path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_queue.c"
                label="vkr_queue.c"
              />
            </Text>
            <Text>
              内核 fence 注册表：
              <FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" label="pseudofs/dev/vgpu.rs" />
            </Text>
            <Text>
              deniald 心跳与相位码：
              <FL
                path="/Users/herbcheng/denial/compositor/src/bin/deniald/liveness_probe.rs"
                label="liveness_probe.rs"
              />
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>工程备忘</H2>
        </CardHeader>
        <CardBody>
          <Table headers={memoHeaders} rows={memoRows} columnAlign={memoAlign} />
        </CardBody>
      </Card>

      <Row gap={8}>
        <Pill active>第八轮收官</Pill>
        <Pill>黑屏归因完成</Pill>
        <Pill>下一手：重建 MoltenVK</Pill>
        <Pill>仪表全部就位</Pill>
      </Row>
      <Text>
        状态基调：黑屏已从「不明」收敛为两件可执行的事——上游 SPIRV-Cross
        保留字缺失（重建即愈）与 MoltenVK 内部 ring 卡点（大概率同源，重建后
        复测即可判定）。第九轮的全部前置仪表（screendump / MVK 日志 / 内核
        TEMP-PROBE / vkr-instr / SPIR-V 落盘）已就位。
      </Text>
    </Stack>
  );
}
