// 第十二轮闭环日画布：全量闭环执行结果（2026-10-11）
// vkprobe 通过 + 四个移植缺陷修复 + 桌面剩余停摆定位。配套：
// starry-round12-upstream-follow-report.canvas.tsx（上半轮汇报）、
// starry-upstream-defects-ledger.canvas.tsx（缺陷总账）、
// design/starry-venus-into-dev-card0.md（闭环补记全文）、AGENTS.md §3。
import {
  Stack, Row, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider, ArchGraph, TodoListCard,
  CodeBlock, useHostTheme, useCanvasAction, FileLink,
  type TableColumnAlign,
} from "cursor/canvas";

function FL({ path, label }: { path: string; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} label={label} dispatch={dispatch} />;
}

const fenceTrace = `# fence 响应乱序实证（vkp a 轮，-d trace:virtio_gpu_fence_resp）
virtio_gpu_fence_ctrl fence 0x94, type 0x207   # 4 个 ring-0 kick 依次提交
virtio_gpu_fence_ctrl fence 0x95, type 0x207
virtio_gpu_fence_ctrl fence 0x96, type 0x207
virtio_gpu_fence_ctrl fence 0x97, type 0x207
virtio_gpu_fence_resp fence 0x97               # 倒序完成
virtio_gpu_fence_resp fence 0x96
virtio_gpu_fence_resp fence 0x95
virtio_gpu_fence_resp fence 0x94
virtio_gpu_fence_ctrl fence 0x99, type 0x207   # 0x99 = compute 批次（宿主推迟）
virtio_gpu_fence_ctrl fence 0x9a, type 0x207   # 0x9a = 后发空 kick（立即完成）
virtio_gpu_fence_resp fence 0x9a               # 0x9a 先于 0x99 完成
# 旧 ctrl 水位：max-popped = 0x9a  =>  fence_completed(0x99) 误判 true
# vkWaitForFences 提前返回 -> 读回发生在 Metal 执行之前 -> 全零`;

const evidenceGraph = {
  nodes: [
    { id: "fail", label: "vkprobe FAIL: readback 全零" },
    { id: "ab", label: "A/B：旧内核同栈 PASS" },
    { id: "wire", label: "wire 对齐：blob/offset/提交全同" },
    { id: "trace", label: "fence trace：响应乱序完成" },
    { id: "fix1", label: "修复1：连续前缀水位+乱序完成集" },
    { id: "fix2", label: "修复2：UNMAP fire-and-forget" },
    { id: "pass", label: "vkprobe 21 步 PASS" },
    { id: "desk", label: "桌面差分：blob 链推齐后 phase=1000" },
    { id: "next", label: "下一手：tidsig 线程级取证" },
  ],
  edges: [
    { from: "fail", to: "ab", label: "宿主栈排除" },
    { from: "ab", to: "wire", label: "回归在移植" },
    { from: "wire", to: "trace", label: "排除 wire 层" },
    { from: "trace", to: "fix1", label: "根因1：水位吞没" },
    { from: "fix1", to: "pass", label: "readback 4/4 MATCH" },
    { from: "pass", to: "fix2", label: "PASS 行恢复" },
    { from: "pass", to: "desk", label: "进入桌面闭环" },
    { from: "desk", to: "next", label: "剩余缺陷定位" },
  ],
};

const defectHeaders = ["缺陷", "实证", "修复", "提交"];
const defectAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "center"];

const defectRows = [
  [
    "1. 乱序 fence 完成模型",
    "fence trace 响应乱序（0x9a 先于 0x99）；上游 max-popped 水位把未完成的 compute 批次吞进水位，vkWaitForFences 提前返回，读回全零",
    "连续前缀水位 + 乱序完成集：virgl 顺序路径语义不变，乱序完成按 id 记录、前缀空洞补齐时折叠进水位",
    "3c62ce4d4",
  ],
  [
    "2. teardown UNMAP 拖死",
    "宿主对渲染器仍引用的资源挂起 unmap，request_sync 5s 超时标 broken，客户端退出卡死、PASS 行丢失",
    "UNMAP 改 fire-and-forget（完成泵记录拒绝），GpuResource::drop 在 UNREF 前补边界 notify，严格 FIFO 保证顺序",
    "3c62ce4d4",
  ],
  [
    "3. sync-file 导出无信号源",
    "未来点只登记 sync_files 表等拉式泵；客户端停在导出 fd 的 poll 上时无人泵，zink 队列冻结在 blob 链第 2 池后（4 blob vs 旧内核 14）",
    "导出时查 pending retire 拿设备 fence，bind_fence_id + register 交上游 refresher——宿主 retire 瞬间 signal，语义与水位推进等价",
    "94884d25e",
  ],
  [
    "4. dmabuf mmap 缺失",
    "PRIME 导出的 blob fd 拒绝 mmap（移植计划漏项）；deniald gbm CPU 写与背景写入经此 fd",
    "HostResourceDmaBuf::device_mmap 经 mapped_blob 解析为 PhysicalCachedResolved/PhysicalResolved；virgl 无 BAR 映射资源保持拒绝",
    "94884d25e",
  ],
];

const desktopHeaders = ["观测项", "旧内核（差分基线）", "新内核（当前）"];
const desktopAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];

const desktopRows = [
  ["屏幕内容（screendump 采样）", "0% 黑——R11 上屏结论复现", "100% 黑"],
  ["blob 创建链", "14 个：ring/resp/3池/8M/3atlas/32K/2M/16K 全部建出并映射", "修复后完全一致（14 个）"],
  ["SET_SCANOUT_BLOB flip 循环", "双缓冲交替（res 3/4）", "双缓冲交替（res 4/5），形态一致"],
  ["compositor 心跳（92s）", "健康出帧", "phase=1000、in_flight=true、dispatch_seq 增长"],
  ["windows=0 / target unavailable 日志", "同样存在", "同样存在——确认为稳态噪音，非断点"],
];

const nextSteps = [
  {
    id: "tidsig",
    content: "tidsig 线程级取证锁定 phase=1000 卡点：R8 方法论（区分 futex 正常停等与真死锁，每次 ptrace 后确认进程活性），目标=卡住线程的阻塞 ioctl 名与参数",
    status: "pending",
  },
  {
    id: "e2e",
    content: "修复后桌面 e2e 复测：判据与十一轮一致（screendump 非黑且跨截图时钟差、deadline_to_presentation_p50 入预算、missed_vblanks=0、5 分钟+ 存活）",
    status: "pending",
  },
  {
    id: "engine",
    content: "引擎工件代次决策：上游 denial main 锁 3.47.5-r1 + Slimpeller（Skia 不再编译）；e2e 决定拉新 aarch64 引擎工件或维持旧验证态组合跑保真度",
    status: "pending",
  },
  {
    id: "diag",
    content: "denial liveness_probe/生命周期诊断按上游新事件循环重接线（flutter_event_loop.rs 重写 3125 行，3cab163 第 4 部分）",
    status: "pending",
  },
  {
    id: "pr",
    content: "上游 PR 授权决策：D1（MODE_ATOMIC 上限）与 ax-net 自旋锁修复为干净独立修复，可提 rcore-os/tgoskits；denial 三处 present 修复对应上游 KNOWN_ISSUES",
    status: "pending",
  },
  {
    id: "audit",
    content: "上游缺陷立项反馈：D3（create_blob 命令顺序为 API 形状问题）、D4（双 resource-id 计数器）、D5（in-fence 外域等待）",
    status: "pending",
  },
];

export default function Round12ClosureStatus(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>第十二轮闭环日：vkprobe 通过与四个移植缺陷</H1>
      <Text>
        全量闭环第一日完成：vkprobe 21 步在新内核全绿，闭环过程抓出并修复四个移植
        缺陷（每个都有 A/B 差分或 QEMU trace 实证）；桌面级剩余一处引擎调用停摆，
        已定位到下一步取证手段。全文见
        <FL path="design/starry-venus-into-dev-card0.md" label=" 设计文档闭环补记" />
        {" "}与 <FL path="../AGENTS.md" label="AGENTS.md §3" />；上半轮汇报在
        <FL path="starry-round12-upstream-follow-report.canvas.tsx" label=" 汇报画布" />。
      </Text>

      <Grid columns={4} gap={12}>
        <Card><CardBody><Stat value="21/21" label="vkprobe 步数（新内核全绿，PASS 恢复）" tone="success" /></CardBody></Card>
        <Card><CardBody><Stat value="4 项" label="移植缺陷闭环（2 commit，均实证驱动）" tone="success" /></CardBody></Card>
        <Card><CardBody><Stat value="14 个" label="桌面 blob 创建链（推齐旧内核形态）" tone="info" /></CardBody></Card>
        <Card><CardBody><Stat value="1 项" label="剩余停摆（phase=1000，取证手段已定）" tone="warning" /></CardBody></Card>
      </Grid>

      <Card>
        <CardHeader><H2>闭环证据链（症状到根因）</H2></CardHeader>
        <CardBody>
          <ArchGraph nodes={evidenceGraph.nodes} edges={evidenceGraph.edges} direction="vertical" />
          <Divider />
          <Text>
            方法论：先 A/B（旧内核同栈重跑）把回归钉在移植内，再逐层对齐 wire
            （blob/offset/提交序列全同）排除协议层，最后 QEMU fence trace 暴露
            完成序——根因不在「哪里错发」而在「何时算完成」。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>关键证据：fence 响应乱序完成</H2></CardHeader>
        <CardBody>
          <CodeBlock code={fenceTrace} language="bash" />
          <Divider />
          <Text>
            venus ring 批次的响应被宿主推迟到渲染器 fence retire，而后发的空
            kick 立即完成——完成序天然乱序。上游 ctrl 的「最大已弹 fence」
            水位假设按序到达：0x9a 弹出后水位越过未完成的 0x99，
            fence_completed 误判，vkWaitForFences 提前返回，读回发生在 Metal
            执行之前。旧分支「按 token 匹配响应」的设计注记（容纳不了失序
            完成）正是同一问题的旧解，本轮把它翻译成新架构语义：连续前缀
            水位 + 乱序完成集，virgl 顺序路径行为不变。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>四个移植缺陷台账（全部 vkprobe/桌面实证驱动）</H2></CardHeader>
        <CardBody>
          <Table headers={defectHeaders} rows={defectRows} columnAlign={defectAlign} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>桌面 e2e 差分现状（同 rootfs、同 R11 deniald/engine）</H2></CardHeader>
        <CardBody>
          <Table headers={desktopHeaders} rows={desktopRows} columnAlign={desktopAlign} />
          <Divider />
          <Text>
            判读：deniald 侧行为两轮一致（日志签名相同的项都是稳态噪音），
            blob 创建链与 flip 循环在新内核已推齐旧内核形态；剩余差异收敛在
            compositor 卡住的引擎调用（phase=1000、in_flight=true，41 线程全
            S 睡眠，dispatch_seq 仍在增长——主循环活着，等一个永不完成的
            事务）。vkprobe 已逐项证明 UAPI 正确，剩余差异在更深的 fence
            语义组合路径上。
          </Text>
        </CardBody>
      </Card>

      <Callout tone="info">
        <Text>
          排查基建备忘（已入 AGENTS.md）：/tmp/pulled 由旧收集器 recv-log.py
          落盘（端口 8000 被占即直接复用）；vkprobe-fast 注入用 debugfs -w
          （脏镜像必须 -w）+ MD5 回读；QEMU 增量重建 ninja -C
          ~/venus-stack/src/qemu/build 约 1 分钟，fork 内 TEMP 打印沿用既有
          调试惯例。
        </Text>
      </Callout>

      <Card>
        <CardHeader><H2>下一步计划</H2></CardHeader>
        <CardBody>
          <TodoListCard todos={nextSteps} />
        </CardBody>
      </Card>

      <Row gap={8}>
        <Pill active>第十二轮闭环日</Pill>
        <Pill>vkprobe 21/21 通过</Pill>
        <Pill>4 缺陷闭环（HEAD 4318eac9c）</Pill>
        <Pill>已推送 venus-into-dev-1011</Pill>
        <Pill>待：tidsig 取证 + 桌面复测</Pill>
      </Row>
    </Stack>
  );
}
