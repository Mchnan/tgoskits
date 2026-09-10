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
          <Stat value="0.5 fps" label="桌面实际节拍（vsync 门控）" tone="danger" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="2.000s" label="Volition vsync 周期（±3ms）" tone="danger" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="50-80ms" label="llvmpipe 每帧光栅（LP=1）" tone="warning" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="<5ms" label="内核 present 全路径" tone="success" />
        </CardBody>
      </Card>
    </Grid>
  );
}

// ---- evidence table ----

const evidenceHeaders = ["证据", "测量方法", "读数", "指向"];
const evidenceAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const evidenceRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "danger",
    cells: [
      "vsync_gap 恒定 2.000s",
      "DENIA_RENDER_AUDIT=1 的 dart_frame_timing 逐帧审计，20 个 2s 窗口",
      "vsync_gap_avg_us=2000283，抖动仅 ±3ms；空闲锁屏与拖拽动画期间完全相同",
      "一个 2.000s 的节拍器在门控每一帧",
    ],
  },
  {
    tone: "danger",
    cells: [
      "端到端 0.28fps",
      "拖拽手势期间 HMP 连续 screendump 差分（27 帧 / 10.9s）",
      "画面仅变化 3 次，且拖拽进行中一帧不出；输入事件已到达，帧等下一个 2s tick",
      "显示链路端到端被同一节拍钳死",
    ],
  },
  {
    tone: "danger",
    cells: [
      "提交节奏 2.000s",
      "card0 内核 TEMP-PROF ioctl 探针（临时，已回滚）",
      "MODE_ATOMIC 稳态 32.508s、34.497s、36.518s、38.529s……间隔 2.000s±5ms",
      "Volition 每 2s 才向内核提交一次",
    ],
  },
  {
    tone: "danger",
    cells: [
      "零 vblank API 调用",
      "同一探针全量记录",
      "全程 0 次 WAIT_VBLANK / CRTC_GET_SEQUENCE / CRTC_QUEUE_SEQUENCE",
      "compositor 没有向内核要 vblank 时钟",
    ],
  },
  {
    tone: "warning",
    cells: [
      "fence 通知被拒",
      "启动期探针",
      "DRM_IOCTL_SYNCOBJ_EVENTFD(0xc01864cf) 及 0xc0186449、0xc0106443 全部 ENOSYS",
      "Volition 的 vblank/fence 时钟 API 建不起来",
    ],
  },
];

// ---- per-frame breakdown ----

const stageHeaders = ["阶段", "实测耗时", "依据", "是否瓶颈"];
const stageAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "center"];
const stageRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "Flutter build（Dart 布局）",
      "0.5 - 1.5ms",
      "dart_frame_timing build_avg_us=503..1535",
      "否",
    ],
  },
  {
    tone: "warning",
    cells: [
      "llvmpipe 光栅化（LP_NUM_THREADS=1）",
      "稳定 50 - 80ms（空闲锁屏首帧 163ms、启动首帧 196ms）",
      "raster_avg_us=51746..84123 窗口值",
      "只压到 12-20fps，非天花板",
    ],
  },
  {
    tone: "success",
    cells: [
      "内核 present（4MB memcpy + transfer_to_host_2d + resource_flush 同步往返）",
      "fence_to_submit 2.8ms、submit_to_presentation 0、delivery 236us",
      "Volition output_scheduler 审计逐段计时",
      "否",
    ],
  },
  {
    tone: "danger",
    cells: [
      "Volition vsync 节拍（KMS-hold 兜底定时器）",
      "2.000s",
      "presentation_interval_avg_us=1973882；ATOMIC 提交间隔",
      "是——唯一天花板",
    ],
  },
];

// ---- pipeline graph ----

const pipeline = {
  nodes: [
    { id: "volition", label: "Volition 2s hold" },
    { id: "dart", label: "Dart 帧构建" },
    { id: "raster", label: "llvmpipe 光栅" },
    { id: "atomic", label: "card0 ATOMIC" },
    { id: "memcpy", label: "4MB memcpy" },
    { id: "flush", label: "virtio flush" },
    { id: "qemu", label: "QEMU 扫描输出" },
    { id: "cocoa", label: "Cocoa 显示" },
    { id: "flip", label: "flip 事件" },
  ],
  edges: [
    { from: "volition", to: "atomic", label: "2s 节拍放行" },
    { from: "dart", to: "raster", label: "50-80ms" },
    { from: "raster", to: "atomic", label: "提交" },
    { from: "atomic", to: "memcpy", label: "立即执行" },
    { from: "memcpy", to: "flush", label: "两次同步往返" },
    { from: "flush", to: "qemu", label: "RESOURCE_FLUSH" },
    { from: "qemu", to: "cocoa", label: "pixman" },
    { from: "atomic", to: "flip", label: "立即入队" },
    { from: "flip", to: "volition", label: "未用于节拍", tone: "back" as const },
  ],
};

// ---- unsupported ioctl table ----

const ioctlHeaders = ["ioctl", "解码", "内核现状", "影响"];
const ioctlAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const ioctlRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "danger",
    cells: [
      "0xc01864cf",
      "DRM_IOCTL_SYNCOBJ_EVENTFD（24B IOWR）",
      "未实现，ENOSYS",
      "Volition 想注册 fence/vblank 到 eventfd 的唤醒被拒",
    ],
  },
  {
    tone: "warning",
    cells: [
      "0xc0186449 / 0xc0106443",
      "legacy 段 IOWR，24B / 16B（启动探测）",
      "未实现，ENOSYS",
      "启动期探测失败（栈明显容忍，非致命）",
    ],
  },
  {
    tone: "warning",
    cells: [
      "WAIT_VBLANK(0xc0186430)",
      "card0 已实现（sleep wait_count x 16.67ms）",
      "deniald 从未调用",
      "现有实现即使存在也不在节拍路径上",
    ],
  },
  {
    tone: "warning",
    cells: [
      "CRTC_GET_SEQUENCE / QUEUE_SEQUENCE",
      "0xc018643b / 0xc018643c",
      "card0 未实现，且 deniald 未调用",
      "无任何合成 vblank 序号源可用",
    ],
  },
];

// ---- fix directions ----

const fixHeaders = ["优先级", "修复项", "落点", "预期收益"];
const fixAlign: Array<TableColumnAlign | undefined> = ["center", "left", "left", "left"];
const fixRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "danger",
    cells: [
      "P0",
      "card0 补 vblank 时钟：实现 CRTC_GET_SEQUENCE / QUEUE_SEQUENCE，flip 完成事件按 60Hz 边界盖时间戳（当前 commit 瞬间立即入队+立即时间戳，compositor 推不出 16.67ms 周期），或在 CRTC 活跃期间由内核合成 60Hz vblank 事件流；SYNCOBJ_EVENTFD 是 deniald 明确请求的接口，一并实现",
      "os/StarryOS/kernel/src/pseudofs/dev/card0.rs",
      "解锁 Volition 的 60fps 节拍，0.5fps 到 60fps 上限",
    ],
  },
  {
    tone: "warning",
    cells: [
      "P1",
      "llvmpipe 多线程：新调度器下默认 4 线程 raster 在 6.4ms - 1223ms 间病态波动（单线程 50-80ms 稳定），逐帧分解定位 worker 交互",
      "guest 用户态 Mesa（llvmpipe）+ 调度器",
      "12-20fps 到接近 60fps 的算力余量",
    ],
  },
  {
    tone: "warning",
    cells: [
      "P2",
      "sched_setscheduler 实现 SCHED_RR/FIFO（当前 ENOSYS，deniald 的 latency-critical 提权静默失败，18:28 后自行 fallback 到 SCHED_OTHER nice=-10）",
      "os/StarryOS kernel 调度器",
      "帧延迟抖动收敛（不影响帧率上限）",
    ],
  },
];

// ---- tool notes ----

const toolHeaders = ["工具", "本轮结论", "备注"];
const toolAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const toolRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "DENIA_RENDER_AUDIT=1",
      "dart_frame_timing / output_scheduler 两套审计直接给出每帧分解与 2s 节拍，零侵入",
      "帧率问题首选入口",
    ],
  },
  {
    tone: "success",
    cells: [
      "HMP screendump 差分",
      "连续截屏 + md5 对比测端到端帧率（截屏本身约 3-5fps 上限，只能测 0.5fps 量级）",
      "判据脚本 /tmp/prof/in/fps_burst.py",
    ],
  },
  {
    tone: "success",
    cells: [
      "card0 TEMP-PROF 内核探针",
      "warn! 打 ioctl cmd+单调时间戳，重建内核 54s；全量 ioctl 流直接定锤",
      "用后回滚，需要时重加",
    ],
  },
  {
    tone: "danger",
    cells: [
      "gdbstub Z0/Z1 断点",
      "QEMU 11 + HVF 下均不触发（vCont;t 停机采样可用）",
      "断点法在此环境不可用",
    ],
  },
  {
    tone: "danger",
    cells: [
      "ptrace strace",
      "StarryOS ptrace 为 per-process 附加语义，一进程同时只允许一个 tracer；tracer 挂死后 kill -9 的退出清理曾令 guest 串口失联需重启",
      "谨慎使用；guest 有 musl gcc 可自编译测试程序",
    ],
  },
  {
    tone: "success",
    cells: [
      "guest 自编译基元测试",
      "timerfd+epoll 200ms 唤醒 ±3ms、eventfd/pipe/clock_nanosleep 全部正常，空闲与桌面满载复测一致",
      "排除内核 timer/epoll 回归",
    ],
  },
];

export default function DenialFpsRootCause(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <Stack gap={4}>
        <H1>StarryOS denial 桌面帧率根因：0.5Hz vsync 门控</H1>
        <Text>
          2026-09-10 · M4（HVF）+ QEMU 11.0.3 · 分支 fix/starry-arm64-desktop-snapshot-20260908 ·
          LP_NUM_THREADS=1 · 结论同日沉淀至 AGENTS.md 第 3 节
        </Text>
      </Stack>

      <SummaryStrip />

      <Callout tone="danger" title="核心结论：桌面卡顿与算力无关，是 Volition 的 vblank 时钟建不起来后退化到 2s 兜底节拍">
        <Text>
          deniald 的输出调度器（Volition）拿不到任何 vblank 时钟 API——vblank 相关 ioctl 未实现或被
          ENOSYS 拒绝，card0 的 flip 事件又是 commit 瞬间立即入队、立即盖时间戳，推不出 16.67ms
          周期——于是它退化到内部约 2 秒一次的 KMS-hold 兜底定时器当 vsync 用。整个桌面的每一帧都被这个
          0.5Hz 节拍放行：渲染 50-80ms、内核 present 微秒级，都在 2 秒里等待。
        </Text>
      </Callout>

      <Card>
        <CardHeader><H2>证据链：三条独立测量 + 内核探针</H2></CardHeader>
        <CardBody>
          <Table
            headers={evidenceHeaders}
            rows={evidenceRows.map((r) => r.cells)}
            columnAlign={evidenceAlign}
            rowTone={evidenceRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>每帧耗时分解：时间都花在等 2s tick</H2></CardHeader>
        <CardBody>
          <Table
            headers={stageHeaders}
            rows={stageRows.map((r) => r.cells)}
            columnAlign={stageAlign}
            rowTone={stageRows.map((r) => r.tone)}
          />
          <Divider />
          <Text>
            设计预期是 16.67ms 一帧（deniald 启动日志 output target authorized interval=16.666944ms），
            实际每一帧的放行间隔是它的 120 倍。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>帧管线与断裂的节拍回路</H2></CardHeader>
        <CardBody>
          <ArchGraph nodes={pipeline.nodes} edges={pipeline.edges} direction="vertical" />
          <Divider />
          <Text>
            虚线回边是问题所在：card0 在 commit 时立即把 flip 事件入队（queue_flip_event 无任何
            vblank 等待），本应作为下一帧节拍来源的事件流，因为 Volition 的 vblank 时钟建不起来，
            根本没有参与节拍——每帧由 2s hold 定时器独立放行。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>根因机制：vblank 时钟 API 全部缺位</H2></CardHeader>
        <CardBody>
          <Table
            headers={ioctlHeaders}
            rows={ioctlRows.map((r) => r.cells)}
            columnAlign={ioctlAlign}
            rowTone={ioctlRows.map((r) => r.tone)}
          />
          <Divider />
          <Text>
            card0 的设计注释明确写着 WAIT_VBLANK 立即返回、无真实 vblank 源；present_fb 每帧做
            全帧 memcpy 后触发 framebuffer_flush（virtio-gpu 两次同步 virtqueue 往返）。该路径本身
            微秒级，修复 vblank 时钟不需要动 present 路径。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>修复方向</H2></CardHeader>
        <CardBody>
          <Table
            headers={fixHeaders}
            rows={fixRows.map((r) => r.cells)}
            columnAlign={fixAlign}
            rowTone={fixRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>排查方法与工具坑（本轮实战验证）</H2></CardHeader>
        <CardBody>
          <Table
            headers={toolHeaders}
            rows={toolRows.map((r) => r.cells)}
            columnAlign={toolAlign}
            rowTone={toolRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>相关文件</H2></CardHeader>
        <CardBody>
          <Stack gap={6}>
            <Text>
              DRM 仿真（vblank 时钟修复落点）：<RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" label="card0.rs" /> ·{" "}
              <RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/drm.rs" label="drm.rs（ioctl 定义）" />
            </Text>
            <Text>
              present 路径：<RepoFileLink path="../os/arceos/modules/axdisplay/src/lib.rs" label="axdisplay framebuffer_flush" /> ·{" "}
              <RepoFileLink path="../drivers/ax-driver/src/virtio/display.rs" label="virtio-gpu 驱动" />
            </Text>
            <Text>
              运行手册与速查：<RepoFileLink path="sop-run-starryos-denial-qemu.md" label="SOP：denial 桌面 QEMU" /> ·{" "}
              <RepoFileLink path="../AGENTS.md" label="AGENTS.md 第 3 节（本结论文字版）" />
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Text>
        测量产物（宿主 /tmp/prof/in/，重启即失）：audit 数据、screendump 差分脚本、guest 内自编译的
        test_ev / test_rt / strl2 源码副本。QEMU 已干净关机，card0.rs 探针已回滚。
      </Text>
    </Stack>
  );
}
