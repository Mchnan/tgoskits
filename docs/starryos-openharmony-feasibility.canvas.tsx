import {
  Stack, Row, Grid, H1, H2, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider,
  useHostTheme,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

// ── OHOS 内核补丁面 ────────────────────────────────────────────────
const patchHeaders = ["领域", "OHOS 专属补丁 / 特性", "核实状态"];
const patchAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const patchRows: Array<[string, string, string, TableRowTone]> = [
  ["文件系统", "hmdfs（分布式文件系统内核端，含 remount）、splice_read/write 改动", "已核实", "success"],
  ["调度", "FrameRtg 帧调度、CPU 轻量级隔离、__set_cpus_allowed_ptr 修复", "已核实", "success"],
  ["内存", "memcg 增强（/dev/memcg/memory.stat）、purgeable（曾回退）、Enhanced SWAP（ESWAP）", "已核实", "success"],
  ["网络", "NewIP 协议栈（可选特性，标准系统运行不依赖，可暂不实现）", "已核实", "success"],
  ["电源", "power 键开机修复", "已核实", "success"],
  ["驱动", "f_generic（USB gadget）、HCK 内核解耦框架", "已核实", "success"],
  ["IPC/安全", "hwbinder（binder fork）、fuse 增强、security hooks、selinux 策略", "未核实", "warning"],
];
const patchRowTone: Array<TableRowTone | undefined> = patchRows.map((r) => r[3]);
const patchTableRows = patchRows.map(([a, b, c]) => [a, b, c]);

// ── StarryOS 现状 ──────────────────────────────────────────────────
const starryHeaders = ["类别", "StarryOS 现状", "支持度"];
const starryAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const starryRows: Array<[string, string, string, TableRowTone]> = [
  ["syscall", "约 230 个分发分支：openat2/statx/clone3/io_uring/seccomp/pidfd/epoll_pwait2/timerfd/eventfd/inotify/membarrier/rseq/bpf/init_module 等", "支持", "success"],
  ["syscall 缺失", "landlock（无）、fanotify_init（Unsupported）、open_by_handle_at（EOPNOTSUPP）、fsopen/fspick/open_tree（ENOSYS）", "缺失", "danger"],
  ["VFS", "ext4（rsext4+jbd2）、fat、tmpfs、devfs、devpts、procfs、sysfs、debugfs、usbfs、cgroupfs、overlayfs；mount/umount2/pivot_root/bind；权限/链接/设备文件", "支持", "success"],
  ["FUSE", "无实现", "缺失", "danger"],
  ["/dev 设备", "null/zero/full/random/console/tty/ptmx/pts/kmsg/rtc/loop/fb/drm/event/ion(dmaheap,sg2002)/pwm/kpu 等", "支持", "success"],
  ["binder", "无 Android binder 设备/驱动", "缺失", "danger"],
  ["进程", "clone/clone3/fork/vfork/execve/execveat、COW、进程组/会话、完整信号、capabilities、pidfd", "支持", "success"],
  ["namespace", "unshare/setns 存在；net ns 有；pid/mnt/uts/ipc 无独立隔离；userns 无", "部分", "warning"],
  ["cgroup", "目录结构 + procs 迁移，无 controllers（memcg/cpu 等）", "部分", "warning"],
  ["调度", "ax-task sched-rr（RR 时间片 + 优先级）；CFS 未启用；sched_setscheduler 为桩", "部分", "warning"],
  ["电源", "无 suspend/resume/wakelock/cpuidle；有 cpufreq DVFS + Rockchip PM 域；reboot 有", "缺失", "danger"],
  ["网络", "AF_INET/6、AF_UNIX、AF_NETLINK、AF_PACKET、AF_VSOCK；netlink 仅最小实现", "部分", "warning"],
  ["init", "PID1=用户程序；ELF 加载器支持动态链接（musl ldso）；可跑 alpine、riscv64 自编译 Debian", "支持", "success"],
  ["内存模型", "每进程独立用户地址空间 + 页表切换；COW/mmap 后端齐全", "支持", "success"],
  ["SMP/架构", "SMP 开关（IPI、per-CPU runqueue）；riscv64/aarch64/loongarch64 官方支持，x86_64 实际可用", "支持", "success"],
];
const starryRowTone: Array<TableRowTone | undefined> = starryRows.map((r) => r[3]);
const starryTableRows = starryRows.map(([a, b, c]) => [a, b, c]);

// ── 差距分析 ───────────────────────────────────────────────────────
const gapHeaders = ["OHOS 依赖", "StarryOS 现状", "差距等级", "里程碑"];
const gapAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const gapRows: Array<[string, string, string, string, TableRowTone]> = [
  ["binder/hwbinder（servicemanager/appspawn 硬依赖）", "无", "阻塞", "M1", "danger"],
  ["fuse（共享存储/ohos 分区挂载）", "无", "阻塞", "M1", "danger"],
  ["overlayfs", "已有实现", "基本满足（挂载选项覆盖度需验证，如 index/redirect_dir 仅校验）", "M1", "success"],
  ["mount/pivot_root/bind", "已有", "满足", "M1", "success"],
  ["ueventd（devtmpfs + kobject uevent）", "netlink KOBJECT_UEVENT 广播有；devtmpfs 语义需确认", "大", "M1", "warning"],
  ["procfs/sysfs", "已有（含 /proc/mountinfo、bus/usb）", "基本满足", "M1", "success"],
  ["cgroup（memcg 等 controllers）", "仅目录无 controller", "大（memcg 是 ESWAP/内存统计基础）", "M1/M2", "warning"],
  ["capabilities/seccomp", "已有", "基本满足（策略需适配）", "M1", "success"],
  ["完整 netlink/rtnetlink（netmanager）", "最小实现", "阻塞", "M2", "danger"],
  ["设备模型/HDF core 通信", "无 HDF 语义", "大", "M2", "warning"],
  ["io_uring OP 覆盖", "setup/enter/register 有，OP 覆盖未知", "中（需验证）", "M2", "info"],
  ["suspend/wakelock 电源管理", "无", "大", "M3", "warning"],
  ["mount namespace 隔离（appspawn 每应用独立 mount ns + bind mount）", "pid/mnt/uts/ipc 无独立隔离", "大", "M3", "warning"],
  ["ion/dmaheap/GPU", "ion 仅 sg2002 feature；GPU 驱动缺", "大", "M3", "warning"],
  ["landlock/selinux 类安全", "无", "中（可先绕过）", "M3", "info"],
  ["fanotify", "Unsupported", "中", "M3", "info"],
  ["调度（RTG 帧调度语义）", "RR 调度", "中（OHOS 服务可先跑通，帧调度是优化）", "M3", "info"],
];
const gapRowTone: Array<TableRowTone | undefined> = gapRows.map((r) => r[4]);
const gapTableRows = gapRows.map(([a, b, c, d]) => [a, b, c, d]);

// ── 替代方案 ───────────────────────────────────────────────────────
const altHeaders = ["方案", "语义完整性", "工作量", "风险", "评价"];
const altAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left", "left"];
const altRows: Array<[string, string, string, string, string, TableRowTone]> = [
  ["A. StarryOS 完整承载 OHOS 标准系统", "完整", "极大", "极高（无先例）", "长线目标，分阶段走", "info"],
  ["B. StarryOS + OHOS 子集（启动到 shell/命令行）", "部分（M1）", "数人月", "中", "推荐起点", "success"],
  ["C. 混合内核（StarryOS 主 + Linux 辅助）", "高", "大（IPC/内存共享）", "高", "架构不清晰，不推荐", "warning"],
  ["D. 放弃，用 Linux 内核 + OHOS 官方发布", "完整", "0", "无", "失去「Rust 内核承载」价值", "warning"],
  ["E. OHOS rootfs 概念验证（不承诺系统服务）", "最小", "小", "低", "与 B 重叠，可作 B 第一阶段", "info"],
];
const altRowTone: Array<TableRowTone | undefined> = altRows.map((r) => r[5]);
const altTableRows = altRows.map(([a, b, c, d, e]) => [a, b, c, d, e]);

function RoadmapStep({
  tone, num, title, body,
}: { tone: TableRowTone; num: string; title: string; body: string }) {
  return (
    <Row gap={10} align="start">
      <Pill tone={tone}>{num}</Pill>
      <Stack gap={2}>
        <Text weight="medium">{title}</Text>
        <Text>{body}</Text>
      </Stack>
    </Row>
  );
}

export default function StarryOsOpenHarmonyFeasibility(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={20} style={{ padding: 28 }}>
      <Stack gap={6}>
        <H1>用 StarryOS 内核支撑 OpenHarmony：可行性调研与差距分析</H1>
        <Text style={{ color: theme.text.secondary }}>
          调研日期 2026-08-03 · 详细报告见 <Code>docs/starryos-openharmony-feasibility.md</Code> · 本文档为其 CanvasGlass 摘要版
        </Text>
      </Stack>

      <Callout tone="warning" title="核心结论：方向可行，但属「重写 Linux ABI 兼容层」级别的系统工程，不是配置项问题">
        <Text>
          「StarryOS 能跑 alpine → 能跑 OpenHarmony」的推理只对了一半：alpine（busybox/musl）是通用 POSIX 用户态，
          对内核特性要求极低；OHOS 标准系统是开源但 ABI 深度绑定 Linux 专有机制的系统——
          binder/hwbinder、fuse、完整 netlink/rtnetlink、cgroup controllers、ueventd 设备模型、seccomp/selinux 策略，
          这些是 OHOS 系统服务的硬依赖，StarryOS 目前全部缺失或仅最小实现。
        </Text>
      </Callout>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="M1 可行" label="OHOS 启动到 shell：工程量确定，数人月" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="M2 有条件" label="系统服务在线：需补齐 netlink + cgroup controllers" tone="warning" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="M3 高风险" label="应用/方舟/图形：无公开先例，不建议近期承诺" tone="danger" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="3 项阻塞" label="binder / fuse / 完整 netlink（cgroup 为大缺口）" tone="danger" />
          </CardBody>
        </Card>
      </Grid>

      <Divider />

      <Card>
        <CardHeader>
          <H2>1. OHOS 侧事实</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              标准系统内核是 Linux LTS（4.19/5.10 已适配，rk3568 已适配 6.6），官方最低内存 128MiB。
              内核仓库 <Code>openharmony/kernel_linux_6.6</Code> 为 linux-6.6 原生仓，含
              <Code>OpenHarmony-5.0/5.1/6.0</Code> 分支，补丁基线升级到 6.6.101。
            </Text>
            <Table
              headers={patchHeaders}
              rows={patchTableRows}
              columnAlign={patchAlign}
              rowTone={patchRowTone}
            />
            <Text>
              启动链路组件（<Code>startup_init</Code> 仓库）：begetd（init 主程序）/ ueventd / services / remount / initsync / watchdog。
              硬依赖：overlayfs 叠加只读层 + fuse 共享存储 → ueventd 建 /dev 节点（devtmpfs + kobject uevent）→
              servicemanager（硬依赖 <Code>/dev/binder</Code>）→ HDF 驱动服务 → appspawn（应用孵化器，binder 通信 + 每应用独立 mount namespace + seccomp）。
            </Text>
            <Callout tone="info" title="「安卓支持」的含义（需与需求方确认口径）">
              <Text>
                OHOS 没有官方 AOSP AppCompat 层；官方语境下「安卓」主要指内核沿用 Android 系特性
                （CONFIG_ANDROID_BINDER_IPC、binderfs、fuse、lmkd），hwbinder 是 OHOS 对 binder 的 fork/扩展。
                若指 APK 兼容层，需另行评估。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>2. StarryOS 现状（对照清单）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              来源：<Code>os/StarryOS/kernel</Code> 代码树调研。总评：新架构 StarryOS（monolithic，基于 ArceOS ax-runtime/ax-task 全家桶），
              Linux 兼容度远超老版 Starry，已能跑 alpine musl、riscv64 自编译 Debian（294/297 crates）。
            </Text>
            <Table
              headers={starryHeaders}
              rows={starryTableRows}
              columnAlign={starryAlign}
              rowTone={starryRowTone}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>3. 差距分析：OHOS 硬依赖 vs StarryOS 现状</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              <Code>阻塞</Code> = 该能力缺失且 OHOS 系统服务硬依赖；<Code>大</Code> = 有雏形但语义差距大；
              <Code>中</Code> = 可先绕过或后补。
            </Text>
            <Table
              headers={gapHeaders}
              rows={gapTableRows}
              columnAlign={gapAlign}
              rowTone={gapRowTone}
            />
            <Callout tone="info" title="三个关键判断">
              <Text>
                1）「能跑 alpine」证明的是通用 POSIX 面（fork/exec/open/read/socket/mmap），不覆盖 OHOS 的 Linux 专有机制；
                2）M1 最大风险是 binder 与 fuse——都是「大而确定」的工作（有 AOSP 实现与 libfuse 可参考），不像调度/图形依赖难以复刻的语义；
                3）netmanager 的 netlink 深度是 M2 阻塞项，需按 rtnetlink 协议族补 RTM_GETLINK/GETADDR/NEWLINK/NEWROUTE 及多播组语义。
              </Text>
            </Callout>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>4. 可行性结论与替代方案</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              建议以 <Code>M1（OHOS 启动到 shell）</Code> 为第一个正式里程碑：工程量确定、失败模式清晰、可快速验证；
              不要一上来承诺 M3。M1 的完成本身有独立价值（证明 Rust 内核能承载 OHOS 用户态）。
            </Text>
            <Table
              headers={altHeaders}
              rows={altTableRows}
              columnAlign={altAlign}
              rowTone={altRowTone}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>5. 分阶段路线图</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={10}>
            <RoadmapStep
              tone="info"
              num="M0"
              title="准备与证据采集（1-2 周）"
              body="获取 OHOS 标准系统镜像（5.0/6.0）并在 QEMU + Linux 上跑通；用 strace 抓启动链路的精确 syscall/ioctl 依赖清单（binder ioctl 号、netlink 消息、mount 序列），作为 M1 实现输入。"
            />
            <RoadmapStep
              tone="success"
              num="M1"
              title="OHOS 用户态启动到 shell（数人月）"
              body="StarryOS 新增：binder 设备（/dev/binder + ioctl 面，参考 AOSP 语义）、fuse（VFS 转发，参考 Linux fuse 协议）、ueventd 所需 devtmpfs 语义；验证 cgroup 目录/memcg 最小语义与 seccomp 策略适配。验收：begetd 跑完启动序列进入 shell。"
            />
            <RoadmapStep
              tone="warning"
              num="M2"
              title="核心系统服务在线（追加数人月）"
              body="netlink/rtnetlink 协议族补齐；HDF devmgr 通信；cgroup controllers（memcg 起步）。验收：servicemanager/netmanager 在线，hdc 可连接。"
            />
            <RoadmapStep
              tone="danger"
              num="M3"
              title="应用与图形（高风险，仅建议评估）"
              body="appspawn、方舟运行时、GPU/图形栈、suspend/wakelock、安全体系。结论前先做专项可行性验证（方舟 runtime 对 mmap/线程/内存的依赖清单）。"
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>6. 开放问题与下一步</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={10}>
            <Row gap={10} align="start">
              <Pill tone="info">1</Pill>
              <Text>「安卓支持」语义需确认：内核 android config 面（本报告口径）还是 APK 兼容层？</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">2</Pill>
              <Text>OHOS 目标版本：5.0.3 还是 6.0？不同版本补丁面与 rootfs 结构有差异，影响 M0 镜像选择。</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="info">3</Pill>
              <Text>目标平台：qemu-aarch64（rk3568 类）开发验证，还是直接面向具体开发板？</Text>
            </Row>
            <Row gap={10} align="start">
              <Pill tone="warning">4</Pill>
              <Text>
                下一步动作（成本最低、最能消除不确定度）：启动 M0——获取镜像 + Linux 上跑通 + strace 依赖清单。
              </Text>
            </Row>
          </Stack>
        </CardBody>
      </Card>

      <Divider />

      <Stack gap={4}>
        <Text style={{ color: theme.text.tertiary }}>
          本画布为调研摘要；事实核验（syscall 缺失/支持、binder/FUSE 缺失、cgroup 壳、netlink 最小）与仓库代码一致，
          未核实项（hwbinder ioctl 面、fuse 增强细节、OHOS security hooks/selinux 策略、镜像分区一手内容、netmanager 的 netlink 消息集合）已在报告中如实标注。
        </Text>
        <Text style={{ color: theme.text.tertiary }}>
          对应 guideline：book/guideline/feature-development.md（高风险功能前置调研）、book/guideline/starry/syscall.md（syscall 语义证据要求）。
        </Text>
      </Stack>
    </Stack>
  );
}
