import {
  Stack, Row, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, CodeBlock, Divider, ArchGraph, FileLink,
  useHostTheme, useCanvasAction,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

function RepoFileLink({ path, line, label }: { path: string; line?: number; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} line={line} label={label} dispatch={dispatch} />;
}

// ---- summary strip ----

function SummaryStrip() {
  return (
    <Grid columns={4} gap={12}>
      <Card>
        <CardBody>
          <Stat value="vblank 时钟" label="card0 60Hz 合成时钟 + 3 个 ioctl" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="75/75" label="drm-test-drm-modeset 红→绿" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="≈10fps" label="带载实际帧率（raster 瓶颈）" tone="warning" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="3 commits" label="已推送 Mchnan 修复分支" tone="success" />
        </CardBody>
      </Card>
    </Grid>
  );
}

// ---- landed commits ----

const commitHeaders = ["提交", "类型", "内容", "验证"];
const commitAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const commitRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "037396f78",
      "fix(ax-driver)",
      "virtio input probe 改回 take_virtio_transport（masked 会置位 INTERRUPT_DISABLE 掩死 INTx），键鼠事件恢复 IRQ 唤醒",
      "阻塞 dd 读者秒唤醒（各 144B），光标/点击/拖拽全通",
    ],
  },
  {
    tone: "success",
    cells: [
      "d3d712341",
      "feat(starry-kernel)",
      "card0 vblank 时钟：新增 vblank.rs（60Hz 时间派生序列号）；实现 CRTC_GET_SEQUENCE / QUEUE_SEQUENCE；WAIT_VBLANK 按 Linux 4.19 语义重写；事件队列统一 32B 序列化槽；queued 事件由 poll() 惰性兑现",
      "红相 23 fail（errno=95）→ 绿相 75/75；aarch64 clippy 全 feature 矩阵 -D warnings 干净；桌面 A/B 无回归",
    ],
  },
  {
    tone: "success",
    cells: [
      "0d6f5fa4e",
      "docs",
      "AGENTS.md 根因修正与落地记录、SOP §5 键鼠修复说明、帧率排查画布入库",
      "文档与分支实际内容一致",
    ],
  },
];

// ---- root-cause revision ----

const revisionHeaders = ["观测", "上一轮解读（已被推翻）", "本轮复测", "现状结论"];
const revisionAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const revisionRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "info",
    cells: [
      "空闲 MODE_ATOMIC 恒 2.000s",
      "0.5Hz vsync 门控（KMS-hold 兜底当节拍）",
      "带载（HMP mouse_move burst）时间隔缩到 0.10-0.13s",
      "2s 是 Dart 场景静止时的需求节拍（锁屏无动画），非内核门控",
    ],
  },
  {
    tone: "info",
    cells: [
      "output_ticks=60、missed_vblanks=0",
      "未关注",
      "output_scheduler 审计直读",
      "帧调度器 60Hz 走针、flip 事件回收链健康，Volition 提交节奏 = presentation_target − 2ms",
    ],
  },
  {
    tone: "info",
    cells: [
      "presentation_to_submit=2.0s，管线各段 <70ms",
      "未分解",
      "fence_to_submit 2.5ms、deadline_to_submit 69ms、delivery 1ms",
      "空闲在等需求；管线自身无门控、无 stall、无重建",
    ],
  },
  {
    tone: "warning",
    cells: [
      "0xc0186449 / 0xc0106443 ENOSYS",
      "vblank 时钟 API 缺位",
      "按 nr 解码为 VIRTGPU_GET_CAPS / VIRTGPU_RESOURCE_CREATE",
      "是 mesa 探测 virtio-gpu 3D 加速路径，与 vsync 无关",
    ],
  },
  {
    tone: "danger",
    cells: [
      "带载 0.10-0.13s/帧",
      "（旧结论认为算力不是主因）",
      "raster_avg_us 50-80ms 与提交间隔吻合",
      "真实瓶颈：llvmpipe 单线程光栅（LP_NUM_THREADS=1），决定 10-13fps 上限",
    ],
  },
];

// ---- vblank clock architecture ----

const clockGraph = {
  nodes: [
    { id: "get", label: "GET_SEQUENCE" },
    { id: "queue", label: "QUEUE_SEQUENCE" },
    { id: "wait", label: "WAIT_VBLANK" },
    { id: "clock", label: "vblank 时钟" },
    { id: "pending", label: "pending 队列" },
    { id: "poll", label: "poll() 兑现" },
    { id: "events", label: "事件队列 32B" },
    { id: "read", label: "read()" },
  ],
  edges: [
    { from: "get", to: "clock", label: "查询序列号" },
    { from: "queue", to: "pending", label: "未来目标" },
    { from: "queue", to: "events", label: "错过即发" },
    { from: "wait", to: "pending", label: "EVENT 入队" },
    { from: "wait", to: "clock", label: "阻塞至边沿" },
    { from: "pending", to: "poll", label: "边沿到达" },
    { from: "poll", to: "events", label: "入队+唤醒" },
    { from: "events", to: "read", label: "交付" },
  ],
};

// ---- uapi status ----

const uapiHeaders = ["ioctl", "本轮变化", "语义基准", "实现结论", "验证证据"];
const uapiAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left", "left"];
const uapiRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "CRTC_GET_SEQUENCE (0x3b)",
      "新增",
      "Linux 4.19 drm_crtc_get_sequence_ioctl",
      "正确：坏 CRTC→ENOENT、失活→EINVAL、回填 active/sequence/sequence_ns",
      "套件 4 项（active、推进率 5-9/120ms、错误路径）",
    ],
  },
  {
    tone: "success",
    cells: [
      "CRTC_QUEUE_SEQUENCE (0x3c)",
      "新增",
      "Linux 4.19 drm_crtc_queue_sequence_ioctl",
      "正确：未知 flags→EINVAL、错过立即补发、预留耗尽→ENOMEM",
      "套件 6 项（投递、user_data 回传、错误路径）；即时补发缺独立用例",
    ],
  },
  {
    tone: "warning",
    cells: [
      "WAIT_VBLANK (0x3a)",
      "重写",
      "Linux 4.19 drm_wait_vblank_ioctl",
      "部分正确：absolute-0 查询、EVENT 入队、SIGNAL→EINVAL；未实现 3×HZ 超时（EBUSY/EINTR）",
      "套件 9 项（单调、EVENT 入队、相对阻塞时长、错误路径）",
    ],
  },
  {
    tone: "danger",
    cells: [
      "SYNCOBJ_EVENTFD (0xcf) 及 syncobj 全族",
      "保持 ENOSYS（有意）",
      "v6.6 drm_syncobj_eventfd",
      "不实现：smithay 探针期待 ENOENT，部分实现会让 deniald 宣告 linux-drm-syncobj-v1 后后继全族失败；隐式同步是当前工作路径",
      "桌面实测 deniald 正常回退隐式同步，无回归",
    ],
  },
];

// ---- remaining work ----

const todoHeaders = ["优先级", "事项", "落点", "预期收益"];
const todoAlign: Array<TableColumnAlign | undefined> = ["center", "left", "left", "left"];
const todoRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "danger",
    cells: [
      "P1",
      "llvmpipe 多线程病态：默认 4 线程 raster 在 6ms-1223ms 间波动（单线程 50-80ms 稳定），逐帧分解定位 worker 与调度器交互",
      "guest Mesa（llvmpipe）+ 新调度器",
      "10-13fps → 接近 60fps 的算力余量（帧率真实瓶颈）",
    ],
  },
  {
    tone: "warning",
    cells: [
      "P1'",
      "virtio-gpu 3D 加速：VIRTGPU_GET_CAPS / RESOURCE_CREATE 仍 ENOSYS，mesa 只能走 llvmpipe 软渲染",
      "drivers/ax-driver virtio-gpu + mesa",
      "软渲染 → 硬件路径，光栅瓶颈整体移除",
    ],
  },
  {
    tone: "warning",
    cells: [
      "P2",
      "sched_setscheduler 实现 SCHED_RR/FIFO（当前 ENOSYS，deniald 提权失败后 fallback SCHED_OTHER nice=-10）",
      "os/StarryOS kernel 调度器",
      "帧延迟抖动收敛（不影响帧率上限）",
    ],
  },
  {
    tone: "neutral",
    cells: [
      "P3",
      "syncobj 全族（FD_TO_HANDLE / TIMELINE_SIGNAL / QUERY / EVENTFD）：一次覆盖 smithay DrmSyncPoint 全部 ffi 面后才可放探针过",
      "os/StarryOS/kernel card0",
      "Wayland explicit-sync 协议（协议完整性，非性能）",
    ],
  },
];

// ---- environment notes ----

const envHeaders = ["事项", "现状"];
const envAlign: Array<TableColumnAlign | undefined> = ["left", "left"];
const envRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "info",
    cells: [
      "基线 QEMU",
      "新内核实例运行中（guesthold 串口桥 + cmd.fifo），锁屏出画正常、空闲 CPU 低",
    ],
  },
  {
    tone: "warning",
    cells: [
      "host 单测",
      "vblank.rs 的 4 项纯函数单测在 macOS 宿主无法执行（cpu-local .percpu.* section 与 Mach-O 不兼容），需 Linux 侧跑",
    ],
  },
  {
    tone: "warning",
    cells: [
      "clippy 覆盖",
      "aarch64 全 feature 矩阵 -D warnings 干净；loongarch/riscv 因本机缺交叉 gcc 未跑（环境限制）",
    ],
  },
];

export default function DenialDesktopFpsStatus(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <Stack gap={4}>
        <H1>StarryOS denial 桌面：帧率工作现状</H1>
        <Text>
          2026-09-10（下午）· M4（HVF）+ QEMU 11.0.3 · 分支 fix/card0-vblank-clock ·
          已推送 Mchnan 远端（029bc42cb..0d6f5fa4e）· 上游吸收自 merge c4a00deee（#1775/#2313/#2261/#2302）
        </Text>
      </Stack>

      <SummaryStrip />

      <Callout tone="info" title="核心现状：vblank 时钟已补齐并验证，根因结论已修正——帧率上限由 llvmpipe 单线程光栅决定">
        <Text>
          带载复测（HMP 连续注入鼠标）推翻了上一轮「0.5Hz vsync 门控」主因：MODE_ATOMIC 间隔从 2.0s 缩到
          0.10-0.13s，管线按需运转、flip 回收健康。2.000s 是 Dart 场景静止时的需求节拍，不是内核门控。
          本轮按原方向落地了 card0 的 60Hz 合成 vblank 时钟与 CRTC 序列号 ioctl（对真实 DRM 用户态更完整），
          但 deniald 运行路径不调用这些 ioctl，帧率不变；要提升交互帧率，下一手在 llvmpipe 多线程或
          virtio-gpu 3D 加速。
        </Text>
      </Callout>

      <Card>
        <CardHeader><H2>本轮落地（3 个提交，已推送）</H2></CardHeader>
        <CardBody>
          <Table
            headers={commitHeaders}
            rows={commitRows.map((r) => r.cells)}
            columnAlign={commitAlign}
            rowTone={commitRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>根因修正：旧解读 vs 本轮复测</H2></CardHeader>
        <CardBody>
          <Table
            headers={revisionHeaders}
            rows={revisionRows.map((r) => r.cells)}
            columnAlign={revisionAlign}
            rowTone={revisionRows.map((r) => r.tone)}
          />
          <Divider />
          <Text>
            修正后的完整证据与文字版记录见 AGENTS.md 第 3 节「帧率根因修正与 vblank 时钟落地」条目；
            上一轮排查画布（starryos-denial-qemu-fps-root-cause）保留为历史诊断快照。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>vblank 时钟：数据流</H2></CardHeader>
        <CardBody>
          <ArchGraph nodes={clockGraph.nodes} edges={clockGraph.edges} direction="vertical" />
          <Divider />
          <Text>
            序列号 = 建卡起单调时间 ÷ 16.67ms（对齐 Linux vblank_disable_immediate 模式），无内核定时线程：
            queued 事件在 poll()/read() 时惰性兑现，事件时间戳携带合成边沿时间。两条错误路径（坏 CRTC →
            ENOENT、失活 → EINVAL）与错过目标立即补发的语义均对照 Linux 4.19 drm_vblank.c 实现。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>DRM uapi 现状（card0）</H2></CardHeader>
        <CardBody>
          <Table
            headers={uapiHeaders}
            rows={uapiRows.map((r) => r.cells)}
            columnAlign={uapiAlign}
            rowTone={uapiRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>待办与优先级</H2></CardHeader>
        <CardBody>
          <Table
            headers={todoHeaders}
            rows={todoRows.map((r) => r.cells)}
            columnAlign={todoAlign}
            rowTone={todoRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>环境与验证缺口</H2></CardHeader>
        <CardBody>
          <Table
            headers={envHeaders}
            rows={envRows.map((r) => r.cells)}
            columnAlign={envAlign}
            rowTone={envRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>相关文件</H2></CardHeader>
        <CardBody>
          <Stack gap={6}>
            <Text>
              本轮内核实现：<RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/vblank.rs" label="vblank.rs（时钟，新增）" /> ·{" "}
              <RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" label="card0.rs（ioctl 接入）" /> ·{" "}
              <RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/drm.rs" label="drm.rs（uapi 结构）" />
            </Text>
            <Text>
              回归用例：<RepoFileLink path="../test-suit/starryos/qemu/system/drm-test-drm-modeset/src/main.c" label="drm-test-drm-modeset main.c（+23 项检查）" />
            </Text>
            <Text>
              键鼠修复：<RepoFileLink path="../drivers/ax-driver/src/virtio/input.rs" line={31} label="virtio input.rs（transport 修复）" />
            </Text>
            <Text>
              文档：<RepoFileLink path="../AGENTS.md" label="AGENTS.md 第 3 节（速查）" /> ·{" "}
              <RepoFileLink path="sop-run-starryos-denial-qemu.md" label="SOP：denial 桌面 QEMU" /> ·{" "}
              <RepoFileLink path="starryos-denial-qemu-fps-root-cause.canvas.tsx" label="上一轮排查画布（历史快照）" />
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Text>
        复现入口：cargo xtask starry test qemu --arch aarch64 -c qemu/system/drm-test-drm-modeset；
        桌面观测实例与 /tmp/prof 工具链在宿主侧保持运行。
      </Text>
    </Stack>
  );
}
