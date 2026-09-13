import {
  Stack, Row, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, CodeBlock, Divider, ArchGraph, BarChart, FileLink,
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
          <Stat value="14-16fps" label="动画期实际呈现（引擎需求 60fps）" tone="danger" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="87-127ms" label="llvmpipe 光栅 p50/p95（占帧生产 97%）" tone="danger" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="<10ms" label="内核路径全链（提交即呈现，事件 <2ms）" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="零 panic" label="dev tip 9383ba409 + 全补丁栈实测" tone="success" />
        </CardBody>
      </Card>
    </Grid>
  );
}

// ---- revision history ----

const historyHeaders = ["时间", "当时结论", "关键读数", "后续命运"];
const historyAlign: Array<TableColumnAlign | undefined> = ["center", "left", "left", "left"];
const historyRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "warning",
    cells: [
      "09-10 初判",
      "0.5Hz vsync 门控：2.000s 节拍器钳死每一帧",
      "vsync_gap 恒 2.000s±3ms；27 帧 / 10.9s 差分仅 3 次变化",
      "作废：2.000s 是 Dart 静止场景（锁屏无动画）的需求节拍，不是内核门控",
    ],
  },
  {
    tone: "danger",
    cells: [
      "09-10 修正",
      "真实带载瓶颈 = llvmpipe 单线程光栅 50-80ms/帧",
      "HMP 带载后 ATOMIC 间隔缩到 0.10-0.13s（约 10fps）；output_ticks=60、missed_vblanks=0",
      "方向成立；单线程归因随后被 MT 复测部分推翻",
    ],
  },
  {
    tone: "success",
    cells: [
      "09-11 打通",
      "RT 提权 + llvmpipe MT + 合成 vblank 时钟三项落地",
      "RT armed SCHED_RR；轻内容窗口 MT raster 6.4-13.9ms；drm-modeset 23 fail 到 75/75",
      "上游 #1775/#2313/#2261/#2302 repatch + vblank 时钟",
    ],
  },
  {
    tone: "danger",
    cells: [
      "09-11 定锤",
      "两个内核 panic 是桌面被随机打死的真凶，非性能问题",
      "push_wake 唤醒批次断言（两次实测）；card0 KMS 状态跨进程泄漏（grouped 必挂单跑恒绿）",
      "快照栈修复 3c8935a47 + fd2266548；上游 #2357 独立修复 futex，card0 走 #2393",
    ],
  },
  {
    tone: "danger",
    cells: [
      "09-13 终锤",
      "83ms/12-15fps 缺口 = 引擎帧生产段（deadline_to_ready），内核全链无责",
      "动画期 dirty=60/s、unavailable≈46/s → 实际 14-16fps；raster p50 87-127ms 占帧生产 97%",
      "定论：llvmpipe 光栅化是唯一瓶颈；下一手全在用户态",
    ],
  },
];

// ---- 09-13 measured breakdown ----

const stageHeaders = ["阶段", "动画期实测", "依据", "是否瓶颈"];
const stageAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "center"];
const stageRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "Dart 构建（layout/paint）",
      "0.2 - 0.9ms",
      "dart_frame_timing build_avg_us（frames=5 样本 0.9ms）",
      "否",
    ],
  },
  {
    tone: "danger",
    cells: [
      "llvmpipe 光栅（默认多线程）",
      "raster_avg 91.6ms / p50 90.7ms / p95 127.6ms（锁屏与桌面拖影内容）",
      "dart_frame_timing raster 段；engine_over_budget=5/5 全部超 16.7ms 预算",
      "是——唯一瓶颈，占帧生产 95ms 的 97%",
    ],
  },
  {
    tone: "success",
    cells: [
      "ready → 提交（card0 ATOMIC）",
      "1 - 5ms（p95）",
      "output_scheduler ready_to_submit_p95；fence_to_submit 同量级",
      "否",
    ],
  },
  {
    tone: "success",
    cells: [
      "提交 → 呈现（4MB memcpy + flush）",
      "0ms（提交即同步呈现）",
      "submit_to_presentation 全零；render_to_publish p95 < 12ms",
      "否",
    ],
  },
  {
    tone: "success",
    cells: [
      "flip 事件投递",
      "0.7 - 1.9ms（p95）",
      "presentation_delivery；vblank 时钟 output_ticks=60/s 恒定",
      "否",
    ],
  },
];

// ---- budget bar chart ----

function BudgetChart() {
  const budgetLabels = ["raster p50", "raster p95", "deadline→ready p50", "ready→submit p95", "提交→呈现", "事件投递 p95", "60fps 预算"];
  const budgetValues = [90.7, 127.6, 60, 5, 0.1, 1.9, 16.7];
  return (
    <Stack gap={8}>
      <BarChart
        title="动画期每帧分解 vs 60fps 预算（ms）"
        labels={budgetLabels}
        series={[
          { label: "实测（ms）", data: budgetValues },
        ]}
      />
      <Table
        headers={["阶段", "ms", "口径"]}
        rows={[
          ["llvmpipe raster", "90.7 / 127.6", "p50 / p95"],
          ["deadline→ready 全段", "60", "p50"],
          ["ready→submit", "5", "p95"],
          ["提交→呈现", "0.1", "均值"],
          ["flip 事件投递", "1.9", "p95"],
          ["60fps 帧预算", "16.7", "上限"],
        ]}
      />
    </Stack>
  );
}

// ---- pipeline graph (annotated with 09-13 measurements) ----

const pipeline = {
  nodes: [
    { id: "vblank", label: "vblank 时钟" },
    { id: "timeline", label: "Volition 时间线" },
    { id: "dart", label: "Dart 构建 0.9ms" },
    { id: "raster", label: "llvmpipe 91ms" },
    { id: "atomic", label: "card0 ATOMIC" },
    { id: "memcpy", label: "4MB memcpy" },
    { id: "flush", label: "virtio flush" },
    { id: "qemu", label: "QEMU 扫描" },
    { id: "cocoa", label: "Cocoa 显示" },
    { id: "flip", label: "flip 事件 <2ms" },
  ],
  edges: [
    { from: "vblank", to: "timeline", label: "60/s 恒定" },
    { from: "timeline", to: "dart", label: "目标-2ms" },
    { from: "dart", to: "raster", label: "97% 耗时" },
    { from: "raster", to: "atomic", label: "ready" },
    { from: "atomic", to: "memcpy", label: "1-5ms" },
    { from: "memcpy", to: "flush", label: "0ms" },
    { from: "flush", to: "qemu" },
    { from: "qemu", to: "cocoa", label: "pixman" },
    { from: "atomic", to: "flip", label: "立即入队" },
    { from: "flip", to: "vblank", label: "相位回流" },
  ],
};

// ---- kernel stack status ----

const stackHeaders = ["补丁", "上游状态", "dev tip 实测"];
const stackAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const stackRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "vblank 时钟（#2365，7df3bf6f5）",
      "open，mergeable=True",
      "output_ticks=60/s 稳定；GET_SEQUENCE/QUEUE_SEQUENCE 全链工作",
    ],
  },
  {
    tone: "success",
    cells: [
      "card0 生命周期重置（#2393，320e9b4e4）",
      "open，mergeable=True（Closes #2392）",
      "grouped 前置用例不再污染 KMS 状态",
    ],
  },
  {
    tone: "success",
    cells: [
      "#2284 card0 对齐 + IN_FENCE_FD",
      "open，dirty（基线在 #2268 之前）",
      "按文件提取 diff 移植；dma-buf lseek / GETPLANE 回读 / OBJECT 属性值全链生效",
    ],
  },
  {
    tone: "success",
    cells: [
      "input INTx unmask（#2353）+ ax-net unix 锁层级",
      "open / 未上游（dev 已结构性吸收锁意图）",
      "键鼠 IRQ 路径工作；deniald 启动零 panic",
    ],
  },
  {
    tone: "info",
    cells: [
      "futex push_wake 合并语义（快照栈 3c8935a47）",
      "上游 #2357 独立修复并自带回归测试",
      "dev 无需携带；rebase 时自然对齐",
    ],
  },
];

// ---- next work ----

const nextHeaders = ["优先级", "事项", "切入点"];
const nextAlign: Array<TableColumnAlign | undefined> = ["center", "left", "left"];
const nextRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "danger",
    cells: [
      "P0",
      "llvmpipe 光栅化 87-127ms/帧（锁屏与桌面拖影内容）",
      "Mesa llvmpipe：内容复杂度（拖影光标层）、分块调度、raster 线程数；对照 LP=1 与 MT 在重内容下的真实差异",
    ],
  },
  {
    tone: "warning",
    cells: [
      "P1",
      "virtio-gpu 3D 加速（VIRTGPU_GET_CAPS / RESOURCE_CREATE 族）",
      "guest 内核 virtio-gpu 驱动 + qemu virgl/venus；mesa 已在探测（0xc0186449/0xc0106443）",
    ],
  },
  {
    tone: "success",
    cells: [
      "P2",
      "内核侧：无待修项",
      "vblank/KMS/提交/事件投递全链 <10ms 已实测洗清；#2365/#2393 上游合并即收尾",
    ],
  },
];

// ---- tool notes ----

const toolHeaders = ["工具 / 环境", "本轮结论", "备注"];
const toolAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const toolRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "DENIA_RENDER_AUDIT=1（三源审计）",
      "dart_frame_timing（build/raster 分解）+ output_scheduler（deadline_to_ready 全链）+ frame_scheduler（dirty/unavailable 决策）三层拼出完整证据链",
      "动画期串口 TX 冻结是常态：审计要在动画进行中或刚结束时用单条小命令即拉",
    ],
  },
  {
    tone: "danger",
    cells: [
      "guesthold 串口持有守护",
      "必须单实例：双 holder 分别抢走 ser.sock 与 serctl.sock 后「命令回显正常但响应永不出现」",
      "QEMU chardev 被僵尸 accepted 连接污染后重连被饿死，只能整机重启换 socket",
    ],
  },
  {
    tone: "warning",
    cells: [
      "busybox grep -o 正则类",
      "带 [0-9]* 字符类的 grep -o 经常静默空输出",
      "改用 sed 去 ANSI 后 grep 关键字 + awk substr 配对字段；大响应经持久化输出文件本地解析",
    ],
  },
  {
    tone: "warning",
    cells: [
      "HMP 硬退 rootfs 兜底",
      "quit 后重启 deniald 可能报 Could not find a free socket for the XServer（/tmp/.X11-unix 消失）",
      "重跑 mkdir 循环确认存在后立即启动；本次实测 rootfs 数据完好（审计/设置均正常）",
    ],
  },
  {
    tone: "success",
    cells: [
      "锁屏策略（测试环境）",
      "settings.json power 节关 idleLock/Dpms/Suspend；root 密码 1234；本机默认无锁启动",
      "写坏文件会 fallback 安全默认并 WARN，不覆盖文件",
    ],
  },
  {
    tone: "success",
    cells: [
      "HMP mouse.py + screendump 差分",
      "corner 校准（钳制原点）+ 小步平滑滑移才是可复现动画；截屏差分给呈现帧率真值",
      "screendump 每次 ~3MB 且暂停 vCPU，会污染 audit 窗口，两者不能同时采",
    ],
  },
  {
    tone: "warning",
    cells: [
      "宿主 clippy 全矩阵",
      "riscv64/x86/loongarch 的 musl 交叉 gcc 未装，lwprintf build.rs 裸找 {arch}-linux-musl-gcc",
      "macOS 手工匹配参数只跑 aarch64 目标；其余交给上游 CI",
    ],
  },
];

export default function DenialFpsRootCause(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <Stack gap={4}>
        <H1>StarryOS denial 桌面帧率：根因终锤与全量数据</H1>
        <Text>
          2026-09-13 · M4（HVF）+ QEMU 11 · dev tip 9383ba409 + 验证栈
          local/dev-desktop-0913（f5519af86）· 结论同步沉淀至 AGENTS.md 第 3 节
        </Text>
      </Stack>

      <SummaryStrip />

      <Callout tone="danger" title="终锤结论：83ms/12-15fps 的全部延迟在引擎帧生产段（deadline_to_ready），内核无责">
        <Text>
          动画期 frame_scheduler 决策审计：dirty_output_ticks=60/s（引擎要 60fps）、
          unavailable_output_ticks≈46/s（ready 槽被上一帧占用）、实际 presentations=14-16/s。
          output_scheduler 延迟分解：presentation_interval p50≈61-72ms ≈ deadline_to_ready p50 54-67ms
          ＋ ready_to_submit 1-5ms ＋ submit_to_presentation 0（提交即同步呈现）＋ 事件投递 0.7-1.9ms。
          Dart 帧审计进一步定位：raster（llvmpipe）p50≈91ms、p95≈128ms，占帧生产 95ms 的 97%；
          build 仅 0.9ms、vsync 开销 2.7ms；所有帧超 16.7ms 预算（engine_over_budget=5/5）。
          空闲期全链健康（2Hz 按需呈现、deadline_to_presentation 亚毫秒）。9-11 的「MT raster
          6.4-13.9ms」只适用于轻内容窗口——llvmpipe 光栅化时间强依赖内容复杂度，锁屏/桌面拖影
          内容下 87-127ms。下一手全部在用户态：llvmpipe 光栅化优化或 virtio-gpu 3D 加速。
        </Text>
      </Callout>

      <Card>
        <CardHeader><H2>根因修订史（三轮修订 + 终锤）</H2></CardHeader>
        <CardBody>
          <Table
            headers={historyHeaders}
            rows={historyRows.map((r) => r.cells)}
            columnAlign={historyAlign}
            rowTone={historyRows.map((r) => r.tone)}
          />
          <Divider />
          <Text>
            09-13 终锤的转折点是「动画 + 即取审计」一体流程：整机重启后趁串口健康，在 12s wave
            动画刚结束时单条命令拉回 output_scheduler 与 dart_frame_timing 两类审计，
            首次拿到动画窗口的完整延迟分解。此前 9-11 的 83ms 排查卡在串口冻结拿不到带载审计。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>当前每帧分解（动画期实测）</H2></CardHeader>
        <CardBody>
          <Table
            headers={stageHeaders}
            rows={stageRows.map((r) => r.cells)}
            columnAlign={stageAlign}
            rowTone={stageRows.map((r) => r.tone)}
          />
          <Divider />
          <BudgetChart />
          <Divider />
          <Text>
            自洽校验：presentation_interval p50（61-72ms）≈ deadline_to_ready（54-67ms）
            ＋ ready_to_submit（1-5ms）＋ submit_to_presentation（0）＋ delivery（0.7-1.9ms），
            链路无缺口。frame_scheduler 侧 render_available = ready 槽为空——unavailable 46/60
            ticks 意味着 ready 槽被上一帧占用近 770ms/s，即帧生产本身吃满间隔。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>现行帧管线：内核各段全部洗清</H2></CardHeader>
        <CardBody>
          <ArchGraph nodes={pipeline.nodes} edges={pipeline.edges} direction="vertical" />
          <Divider />
          <Text>
            Volition 帧调度是软件时间线（OutputTimeline 自推 next_tick + 相位锁，calloop 定时器驱动），
            相位锁输入是 flip 事件的 presented_at；合成 vblank 时钟经 GET_SEQUENCE/QUEUE_SEQUENCE
            提供边界参照（output_ticks=60/s 恒定、missed_vblank_streaks 语义正常）。提交经 Volition
            deadline 调度器贴近 presentation_target 发非阻塞原子提交，card0「提交即同步呈现」
            与其匹配——submit_to_presentation 全零实测。管线各段加总不到 10ms，瓶颈唯一指向 raster。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>dev tip 验证栈与补丁状态</H2></CardHeader>
        <CardBody>
          <Table
            headers={stackHeaders}
            rows={stackRows.map((r) => r.cells)}
            columnAlign={stackAlign}
            rowTone={stackRows.map((r) => r.tone)}
          />
          <Divider />
          <Text>
            验证栈 local/dev-desktop-0913（单提交 f5519af86）= dev tip + 六个补丁。cherry-pick 陷阱：
            #2284 分支基线在 #2268 之前，整提交 cherry-pick -3 会把无关基线差异全裹进来
            （上游标 dirty 的原因）——必须 git diff c^ c -- 按文件提取后 3-way apply，
            并手工适配 dev 已演进的 vm_read(current) API 与 DRM_MODE_PROP_SIGNED_RANGE 常量。
            桌面实测：RT armed SCHED_RR、零 panic（9-11 rebase 栈 PI mutex 恐慌未在新 dev 复现，
            嫌疑解除）、锁屏出画正常。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>下一步（按优先级）</H2></CardHeader>
        <CardBody>
          <Table
            headers={nextHeaders}
            rows={nextRows.map((r) => r.cells)}
            columnAlign={nextAlign}
            rowTone={nextRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>排查方法与工具坑（多轮实战沉淀）</H2></CardHeader>
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
              DRM / vblank：<RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" label="card0.rs" /> ·{" "}
              <RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/vblank.rs" label="vblank.rs" /> ·{" "}
              <RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/drm.rs" label="drm.rs（ioctl 定义）" />
            </Text>
            <Text>
              present 路径：<RepoFileLink path="../os/arceos/modules/axdisplay/src/lib.rs" label="axdisplay framebuffer_flush" /> ·{" "}
              <RepoFileLink path="../drivers/ax-driver/src/virtio/display.rs" label="virtio-gpu 驱动" />
            </Text>
            <Text>
              denial 侧（帧率下一手落点）：<RepoFileLink path="../../denial/compositor/src/bin/deniald/output_scheduler.rs" label="output_scheduler.rs（deadline_to_ready 审计源）" /> ·{" "}
              <RepoFileLink path="../../denial/compositor/src/bin/deniald/frame_scheduler.rs" label="frame_scheduler.rs（dirty/unavailable 决策）" />
            </Text>
            <Text>
              运行手册与速查：<RepoFileLink path="sop-run-starryos-denial-qemu.md" label="SOP：denial 桌面 QEMU" /> ·{" "}
              <RepoFileLink path="../AGENTS.md" label="AGENTS.md 第 3 节（本结论文字版）" />
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Text>
        测量产物（宿主 /tmp/prof/，重启即失；本轮 878KB / 2.3MB 审计流已本地解析）。
        QEMU 实例已 sync; poweroff 干净关机，rootfs 备份 rootfs-aarch64-denial-full.img.bak-0913。
        验证栈分支 local/dev-desktop-0913 保留作 dev tip 桌面回归入口。
      </Text>
    </Stack>
  );
}
