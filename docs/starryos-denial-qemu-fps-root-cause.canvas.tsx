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
          <Stat value="6.4-13.9ms" label="llvmpipe MT 带载 raster 均值" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="75/75" label="drm-modeset 回归（vblank 时钟落地后）" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="83ms" label="动画期 vsync_gap p50（当前唯一天花板）" tone="danger" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="60s" label="高强度动画零 panic（两个内核修复后）" tone="success" />
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
      "成立：KMS 管线按需运转、flip 回收链健康，非瓶颈",
    ],
  },
  {
    tone: "success",
    cells: [
      "09-11 打通",
      "RT 提权 + llvmpipe MT + 合成 vblank 时钟三项落地",
      "RT armed SCHED_RR；MT raster 6.4-13.9ms（旧 6-1223ms 波动消失）；drm-modeset 23 fail 到 75/75",
      "上游 #1775/#2313/#2261/#2302 repatch + d3d712341 vblank 时钟",
    ],
  },
  {
    tone: "danger",
    cells: [
      "09-11 定锤",
      "两个内核 panic 是桌面被随机打死的真凶，非性能问题",
      "push_wake 唤醒批次断言（两次实测）；card0 KMS 状态跨进程泄漏（grouped 必挂单跑恒绿）",
      "已修复 3c8935a47 + fd2266548；60s 高强度动画零 panic",
    ],
  },
];

// ---- vblank clock details ----

const vblankHeaders = ["机制项", "实现", "语义对齐"];
const vblankAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const vblankRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "合成 60Hz 时钟",
      "序列号 = 自建卡起单调时间 / 周期；edge_ns = anchor + N * 16.67ms",
      "Linux vblank_disable_immediate 模式（计数器由时间戳推导，非中断锁存）",
    ],
  },
  {
    tone: "success",
    cells: [
      "CRTC_GET_SEQUENCE / QUEUE_SEQUENCE",
      "0xc018643b / 0xc018643c；inactive CRTC 报 EINVAL；missed 目标立即发",
      "drm_crtc_get/queue_sequence_ioctl（Linux 4.19）",
    ],
  },
  {
    tone: "success",
    cells: [
      "WAIT_VBLANK 按 4.19 重写",
      "absolute-0 即纯查询；_DRM_VBLANK_EVENT 入队；SIGNAL 位/未知位 EINVAL",
      "修复了旧实现「等待语义反转 + 无事件路径」",
    ],
  },
  {
    tone: "success",
    cells: [
      "事件惰性兑现",
      "poll()/read() 时结算到期事件；无内核定时线程；时间戳恒为合成边界",
      "投递延迟 ≤ 调用方 poll 间隔（compositor 常驻 poll，可接受）",
    ],
  },
  {
    tone: "warning",
    cells: [
      "SYNCOBJ_EVENTFD 保持 ENOSYS",
      "smithay supports_syncobj_eventfd 探针期待 ENOENT；部分实现会让 deniald 宣告 syncobj 后全族失败",
      "隐式同步是当前工作路径，诚实 ENOSYS 才是对的",
    ],
  },
];

// ---- per-frame breakdown (current) ----

const stageHeaders = ["阶段", "当前实测", "依据", "是否瓶颈"];
const stageAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "center"];
const stageRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "Flutter build（Dart 布局）",
      "0.5 - 1.5ms",
      "dart_frame_timing build_avg_us",
      "否",
    ],
  },
  {
    tone: "success",
    cells: [
      "llvmpipe 光栅（默认多线程）",
      "带载 6.4 - 13.9ms（p95/max 30 - 77ms）",
      "新调度器下 MT 病态波动（6-1223ms）消失，RT 提权 flutter-raster SCHED_RR",
      "均值否；p95 尾部待观察",
    ],
  },
  {
    tone: "success",
    cells: [
      "内核 present（4MB memcpy + flush 同步往返）",
      "微秒级",
      "fence_to_submit 2.8ms、submit_to_presentation 0、delivery 236us",
      "否",
    ],
  },
  {
    tone: "danger",
    cells: [
      "动画期 presentation 节拍",
      "vsync_gap p50 约 83ms（约 12fps present）",
      "引擎每帧 6-14ms，可跑 60fps+；差异即提交/投递链的空转",
      "是——当前唯一天花板",
    ],
  },
];

// ---- pipeline graph (current) ----

const pipeline = {
  nodes: [
    { id: "vblank", label: "vblank 时钟" },
    { id: "timeline", label: "Volition 时间线" },
    { id: "dart", label: "Dart 构建" },
    { id: "raster", label: "llvmpipe MT" },
    { id: "atomic", label: "card0 ATOMIC" },
    { id: "memcpy", label: "4MB memcpy" },
    { id: "flush", label: "virtio flush" },
    { id: "qemu", label: "QEMU 扫描" },
    { id: "cocoa", label: "Cocoa 显示" },
    { id: "flip", label: "flip 事件" },
  ],
  edges: [
    { from: "vblank", to: "timeline", label: "GET_SEQUENCE" },
    { from: "timeline", to: "dart", label: "目标-2ms" },
    { from: "dart", to: "raster", label: "6-14ms" },
    { from: "raster", to: "atomic", label: "提交" },
    { from: "atomic", to: "memcpy", label: "立即" },
    { from: "memcpy", to: "flush", label: "两次往返" },
    { from: "flush", to: "qemu" },
    { from: "qemu", to: "cocoa", label: "pixman" },
    { from: "atomic", to: "flip", label: "立即入队" },
    { from: "flip", to: "vblank", label: "回流" },
  ],
};

// ---- panic fixes ----

const panicHeaders = ["panic", "触发面", "根因", "修复与验证"];
const panicAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const panicRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "warning",
    cells: [
      "push_wake：one futex wait generation cannot enter two live wake batches",
      "kill 多线程 deniald（唤醒风暴）或纯鼠标动画 5-12s",
      "waker 在 domain 锁内选人后、wake_all 前被抢占；等待者由独立 deadline 唤醒、完成该代次、立刻重入队新代次；第二个 waker 推送时撞上「仍链在未 drain 批次」",
      "改 Linux wake_q 合并语义（push 失败即丢弃，前一批次必然送达线程级唤醒）；确定性回归测试 RED+GREEN；axtest 176 过",
    ],
  },
  {
    tone: "warning",
    cells: [
      "crtc_active 误判：RMFB 后 GET_SEQUENCE 应 EINVAL 却成功",
      "grouped 套件里 drm-atomic 先跑；单跑恒绿",
      "card0 全局 ModesetState/fbs 跨进程泄漏：atomic 用例 commit 后退出，遗留状态让后一个纯 legacy 用例看到幻影活跃 CRTC",
      "落实 drm_release 契约：per-fd open_count，最后一个 fd 关闭时重置 KMS 状态/fb 表/事件队列；crtc_active 改按活 fb 绑定判",
    ],
  },
];

// ---- remaining work ----

const nextHeaders = ["优先级", "事项", "切入点"];
const nextAlign: Array<TableColumnAlign | undefined> = ["center", "left", "left"];
const nextRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "danger",
    cells: [
      "P0",
      "动画期 presentation 节拍：vsync_gap p50 约 83ms vs 引擎 6-14ms/帧",
      "Volition 提交节奏（presentation_target-2ms + 1-in-flight）与 vblank 事件投递路径；带载 output_scheduler 审计（presentation_interval / missed_vblanks / target_to_presentation）",
    ],
  },
  {
    tone: "warning",
    cells: [
      "P1",
      "llvmpipe raster p95 尾部（30-77ms）",
      "Mesa 侧；均值已健康，尾部决定掉帧",
    ],
  },
  {
    tone: "warning",
    cells: [
      "P2",
      "virtio-gpu 3D 加速（VIRTGPU_GET_CAPS / RESOURCE_CREATE 族， mesa 已在探测）",
      "guest 内核 virtio-gpu 驱动 + qemu virgl/venus",
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
      "DENIA_RENDER_AUDIT=1",
      "dart / output_scheduler / embedder 三源审计逐帧分解，零侵入",
      "串口冻结时 dd.log 在 guest /tmp（tmpfs 不落盘），需趁串口健康即取或重启后即拉",
    ],
  },
  {
    tone: "success",
    cells: [
      "锁屏策略（测试环境）",
      "settings.json power 节关 idleLock/Dpms/Suspend（schema v21，compositor 启动加载）；root 密码 1234",
      "本机已默认无锁启动；写坏文件会 fallback 安全默认并 WARN",
    ],
  },
  {
    tone: "danger",
    cells: [
      "guesthold 串口守护",
      "QEMU 运行中 pkill 留僵尸 accepted 连接，此后新连接进不去、TX 冻结、guest shell 全冻",
      "恢复只能 HMP system_powerdown + quit 整机重启",
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
    tone: "success",
    cells: [
      "cargo xtask ktest qemu",
      "内核 axtest 入口：-p starry-kernel --features axtest,smp --arch aarch64 --test axtest_kernel",
      "axtest 组装可调度任务必须用 ROOT_PID_NS；wait_if 超时返回 Err(ETIMEDOUT) 是正常路径",
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
      "StarryOS ptrace 为 per-process 附加语义；tracer 挂死后 kill -9 曾令 guest 串口失联需重启",
      "谨慎使用；guest 有 musl gcc 可自编译测试程序",
    ],
  },
];

export default function DenialFpsRootCause(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <Stack gap={4}>
        <H1>StarryOS denial 桌面帧率：根因修订与当前状态</H1>
        <Text>
          2026-09-11 · M4（HVF）+ QEMU 11 · 分支 fix/card0-vblank-clock ·
          结论同步沉淀至 AGENTS.md 第 3 节
        </Text>
      </Stack>

      <SummaryStrip />

      <Callout tone="warning" title="核心结论：根因经历两轮修订，vblank 时钟已落地，当前瓶颈收敛到动画期 presentation 节拍">
        <Text>
          09-10 的「0.5Hz vsync 门控」结论被带载复测推翻——2.000s 空闲节拍是 Dart 静止场景的需求节拍，
          KMS 管线本身按需运转。真实带载瓶颈先是 llvmpipe 单线程光栅（50-80ms/帧），随上游调度器重建
          （#1775/#2313）与 UserAccess/VMA 重写（#2261/#2302）落树后 RT+MT 全链打通。09-10 晚 card0
          合成 60Hz vblank 时钟落地（WAIT_VBLANK 语义反转修复 + CRTC sequence ioctl），drm-modeset
          回归 23 fail 到 75/75。09-11 把桌面随机 panic 的两个内核 bug 定锤修复（futex 唤醒批次、
          card0 KMS 状态泄漏）。当前残余缺口：动画期 presentation 节拍 83ms（约 12fps）vs 引擎
          6-14ms/帧的 60fps+ 能力。
        </Text>
      </Callout>

      <Card>
        <CardHeader><H2>根因修订史</H2></CardHeader>
        <CardBody>
          <Table
            headers={historyHeaders}
            rows={historyRows.map((r) => r.cells)}
            columnAlign={historyAlign}
            rowTone={historyRows.map((r) => r.tone)}
          />
          <Divider />
          <Text>
            带载复测是修订的转折点：HMP 连续注入鼠标时 MODE_ATOMIC 间隔从 2.0s 缩到 0.10-0.13s，
            证明提交节奏 = presentation_target-2ms + 1-in-flight 等 flip，Volition 从未退化到
            「KMS-hold 当 vsync」。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>vblank 时钟落地（d3d712341）</H2></CardHeader>
        <CardBody>
          <Table
            headers={vblankHeaders}
            rows={vblankRows.map((r) => r.cells)}
            columnAlign={vblankAlign}
            rowTone={vblankRows.map((r) => r.tone)}
          />
          <Divider />
          <Text>
            落点 <RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/vblank.rs" label="vblank.rs（时钟本体）" /> 与{" "}
            <RepoFileLink path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" label="card0.rs（ioctl 与事件队列）" />。
            桌面 A/B：新内核锁屏出画正常、带载 screendump 差分 8/8 全不同（0.45s/帧），无回归。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>当前每帧分解</H2></CardHeader>
        <CardBody>
          <Table
            headers={stageHeaders}
            rows={stageRows.map((r) => r.cells)}
            columnAlign={stageAlign}
            rowTone={stageRows.map((r) => r.tone)}
          />
          <Divider />
          <Text>
            上界参照：deniald 启动日志 output target authorized interval=16.666944ms（60fps）。
            当前 83ms 拍子是它的 5 倍，而各执行段加总不到 20ms——差额在提交与投递链的等待。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>现行帧管线：vblank 时钟已进入节拍回路</H2></CardHeader>
        <CardBody>
          <ArchGraph nodes={pipeline.nodes} edges={pipeline.edges} direction="vertical" />
          <Divider />
          <Text>
            Volition 帧调度是软件时间线（OutputTimeline 自推 next_tick + 相位锁，calloop 定时器驱动），
            相位锁的输入正是 flip 事件的 presented_at；内核 vblank 时钟经 GET_SEQUENCE/QUEUE_SEQUENCE
            为它提供边界参照。提交经 Volition deadline 调度器贴近 presentation_target 发非阻塞原子提交，
            card0「提交即同步呈现」语义与其匹配。当前 83ms 缺口意味着这条回路仍有空转段，待带载审计定位。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>本轮定锤的两个内核 panic</H2></CardHeader>
        <CardBody>
          <Table
            headers={panicHeaders}
            rows={panicRows.map((r) => r.cells)}
            columnAlign={panicAlign}
            rowTone={panicRows.map((r) => r.tone)}
          />
          <Divider />
          <Text>
            两个修复均已提交：3c8935a47（futex 合并语义 + 确定性回归测试，RED 复现 panic、GREEN 通过）、
            fd2266548（card0 生命周期重置）。验证：axtest 内核全套 176 过；grouped system 全量绿；
            桌面 60s 高强度动画零 panic 且 23/23 帧变化无行为回归。
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
              futex 修复：<RepoFileLink path="../os/StarryOS/kernel/src/task/futex.rs" label="futex.rs（push_wake + 回归测试）" /> ·{" "}
              <RepoFileLink path="../components/ax-task/src/thread/handle/wake_batch.rs" label="wake_batch.rs（合并契约）" />
            </Text>
            <Text>
              present 路径：<RepoFileLink path="../os/arceos/modules/axdisplay/src/lib.rs" label="axdisplay framebuffer_flush" /> ·{" "}
              <RepoFileLink path="../drivers/ax-driver/src/virtio/display.rs" label="virtio-gpu 驱动" />
            </Text>
            <Text>
              denial 侧（帧率排查下一步落点）：<RepoFileLink path="../../denial/compositor/src/bin/deniald/output_scheduler.rs" label="output_scheduler.rs" /> ·{" "}
              <RepoFileLink path="../../denial/compositor/src/bin/deniald/frame_scheduler.rs" label="frame_scheduler.rs（OutputTimeline 相位锁）" />
            </Text>
            <Text>
              运行手册与速查：<RepoFileLink path="sop-run-starryos-denial-qemu.md" label="SOP：denial 桌面 QEMU" /> ·{" "}
              <RepoFileLink path="../AGENTS.md" label="AGENTS.md 第 3 节（本结论文字版）" />
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Text>
        测量产物（宿主 /tmp/prof/，重启即失）：audit 数据、screendump 差分脚本、mouse.py 自动化工具。
        QEMU 桌面实例保持运行（内核含全部三项修复：vblank 时钟、futex 合并、card0 生命周期）。
      </Text>
    </Stack>
  );
}
