# 用 StarryOS 内核支撑 OpenHarmony：可行性调研与差距分析

- 作者：TGOSKits 调研（2026-08-03）
- 范围：可行性评估 + 差距分析报告（非设计文档，不包含实现方案）
- 对应 guideline：[feature-development.md](../book/guideline/feature-development.md)（高风险功能前置调研）、[starry/syscall.md](../book/guideline/starry/syscall.md)（syscall 语义证据要求）

## 1. 摘要（TL;DR）

**结论：方向可行，但属于「重写 Linux ABI 兼容层」级别的系统工程，不是配置项问题。「StarryOS 能跑 alpine → 能跑 OpenHarmony」的推理只对了一半。**

- alpine（busybox/musl）是**通用 POSIX 用户态**，几乎不依赖 Linux 专有内核机制，对内核特性要求极低；
- OpenHarmony 标准系统是**开源但 ABI 深度绑定 Linux 专有机制的系统**（用户态与内核补丁均开源，如 startup_init 为 Apache-2.0）：binder/hwbinder 进程间通信、fuse 共享存储、完整 netlink/rtnetlink、cgroup controllers、ueventd/kobject 设备模型、seccomp/selinux 策略、ioctl 体系——这些是 OHOS 系统服务的**硬依赖**，StarryOS 目前全部缺失或仅最小实现；
- 因此建议**分阶段推进**，第一个可验证里程碑（M1：OHOS 用户态启动到 shell）即可证明可行性，也暴露最大风险；完整 OHOS（应用/方舟/图形）目前无公开先例，工作量以人月级计，风险极高。

## 2. 背景与目标

### 2.1 用户目标

用 StarryOS（TGOSKits 的 Rust 编写、Linux 兼容用户态内核）承载 OpenHarmony。用户的理解：OpenHarmony ≈ Linux 6.6 + 安卓支持 + 其他特性；既然 StarryOS 已能运行 alpine，该目标具有可行性。

### 2.2 成功标准（本报告评估对象）

| 层级 | 可观察结果 |
|------|-----------|
| M1 启动 | OHOS rootfs 在 StarryOS 上启动，ohos-init（begetd）跑到 shell / 命令行可用 |
| M2 系统服务 | servicemanager / HDF devmgr / netmanager 等核心系统服务在线，hdc 可连接 |
| M3 应用 | appspawn 孵化一个 OHOS 应用（ArkTS/方舟）并显示 |

### 2.3 非目标

- 不评估 OHOS 源码/工具链移植（hb 构建、HDF 源码适配）——那是后续实现阶段的另一项工作；
- 不做内核特性逐 syscall 的 ABI 合规证明（属于 M1 之后的实现评审范围）。

## 3. 调研方法

- 内部：tgoskits 仓库代码树（`os/StarryOS/kernel`、`os/arceos/modules`、`drivers/`）；
- 外部：OpenHarmony 官方 Gitee 仓库与文档（gitee.com/openharmony）；
- 证据分级：**已核实**（gitee API/README 直接确认）、**领域知识**（来自既有认知，未抓一手资料）、**未知**（检索未覆盖）；
- 检索日期：2026-08-03。仓库/分支信息以当日为准。

## 4. OHOS 侧事实

### 4.1 内核基线【已核实】

- OpenHarmony 标准系统内核是 **Linux LTS**：已完成 4.19、5.10 适配，**rk3568 已适配 6.6**（官方文档《标准系统内核概述》）。
- 内核仓库 `openharmony/kernel_linux_6.6`（linux-6.6 原生仓）默认分支 master，含 `OpenHarmony-5.0-Release`、`5.1.0-Release`、`6.0-Beta1`、`6.0-Release` 分支；补丁基线从 6.6.26 一路升级到 **6.6.101**（commit 消息 `!94/!148/!190` 等）。
- 标准系统最小内存 **128MiB**（官方最低门槛，指可支持该量级内存的入门产品；实际设备如 rk3568 板内存更大），面向应用处理器。

### 4.2 OHOS 专属内核补丁面【已核实（commit 消息）/部分未核实】

| 领域 | 补丁/特性 | 核实状态 |
|------|-----------|---------|
| 文件系统 | **hmdfs**（分布式文件系统内核端，含 remount）、splice_read/write 改动 | 已核实 |
| 调度 | **FrameRtg 帧调度**（`kernel-standard-sched-rtg.md`）、CPU 轻量级隔离、`__set_cpus_allowed_ptr` 修复 | 已核实 |
| 内存 | memcg 增强（/dev/memcg/memory.stat）、purgeable memory（曾回退）、**Enhanced SWAP（ESWAP）** | 已核实 |
| 网络 | **NewIP 协议栈**（可选特性，标准系统运行不依赖，可暂不实现） | 已核实 |
| 电源 | power 键开机修复 | 已核实 |
| 驱动 | f_generic（USB gadget）、HCK 内核解耦框架 | 已核实 |
| IPC/安全 | **hwbinder**（binder fork）、fuse 增强、security hooks、selinux 策略 | **未核实**（官方 docs 目录有总表，本轮未逐项抓取） |

> 注意：官方文档目录（`zh-cn/device-dev/kernel/Readme-CN.md`）列出了完整的「标准系统内核增强特性」章节（ESWAP/NewIP/RTG/CPU isolation/HCK 等），后续实现阶段应逐项核对。

### 4.3 用户态启动链路【结构已核实；依赖细节为领域知识】

`startup_init` 仓库（C 语言，Apache-2.0）结构：`begetd`（init 主程序）、`ueventd`（设备节点守护）、`services`、`remount`、`initsync`、`watchdog`。

启动链路的**硬依赖**（领域知识，M1 需逐项验证）：

1. 挂载 system/vendor/data 分区：overlayfs 叠加只读层 + **fuse** 挂载共享存储；
2. ueventd：依赖 **devtmpfs/kobject uevent**（netlink NETLINK_KOBJECT_UEVENT）创建设备节点；
3. servicemanager：**硬依赖 /dev/binder**（binder ioctl 体系）；
4. HDF 驱动框架：用户态 hdf_devmgr 与内核态 hdf core 通信（binder/hwbinder）；
5. appspawn（应用孵化器，类似 zygote）：binder 通信 + 每应用独立 mount namespace + seccomp；
6. 全程依赖：cgroup（memcg）、capabilities、seccomp、procfs/sysfs、pty、ioctl 体系。

### 4.4 「安卓支持」的含义【已核实结论 + 中不确定度】

- OpenHarmony **没有官方 AOSP AppCompat 层**（方舟运行时不可直接跑 APK；社区有零散尝试，无官方产物）；
- 官方文档语境下的「安卓」主要指内核沿用 **Android 系内核特性**：`CONFIG_ANDROID_BINDER_IPC`、binderfs、fuse、lmkd 等 Android config 在 OHOS 内核保留；**hwbinder 是 OHOS 对 binder 的 fork/扩展**；
- 若用户的「安卓支持」指 APK 兼容层，需另行澄清——本报告按「内核 android config 面」评估。

### 4.5 系统镜像与沙箱【领域知识，未核实】

- 分区：system / vendor / product / chipset / data；
- 启动脚本：`.cfg` 格式（init.cfg 系，非 Android 的 init.rc）；
- 沙箱：appspawn 为每个应用创建独立 mount namespace + bind mount + seccomp；
- uid 模型：OHOS 自研 uid 分配（与 AOSP 不同）。

### 4.6 先例【未知】

- **未检索到「非 Linux 内核跑 OHOS 标准系统」的公开先例**；
- OHOS 轻量/小型系统确实用 LiteOS-M/LiteOS-A，但**标准系统（含 HDF/ability 框架）只在 Linux 上跑过**；
- StarryOS 承载属开创性工作，无先例可参考。

## 5. StarryOS 现状（对照清单）

来源：`os/StarryOS/kernel` 代码树调研（详细 file:line 见调研记录）。

| 类别 | StarryOS 现状 | 支持度 |
|------|--------------|--------|
| syscall | ~230 分发分支；含 openat2/statx/clone3/io_uring/seccomp/pidfd/epoll_pwait2/timerfd/eventfd/inotify/membarrier/rseq/bpf/init_module 等 | 支持 |
| syscall 缺失 | landlock（无）、fanotify_init（Unsupported）、open_by_handle_at（EOPNOTSUPP）、fsopen/fspick/open_tree（ENOSYS） | 缺失/占位 |
| VFS | ext4（rsext4+jbd2）、fat、tmpfs、devfs、devpts、procfs、sysfs、debugfs、usbfs、cgroupfs、**overlayfs**；mount/umount2/pivot_root/bind；权限/链接/设备文件 | 支持 |
| FUSE | 无 | **缺失** |
| /dev 设备 | null/zero/full/random/console/tty/ptmx/pts/kmsg/rtc/loop/fb/drm/event/ion(dmaheap,sg2002)/pwm/kpu 等 | 支持（无 binder） |
| **binder** | 无 Android binder 设备/驱动 | **缺失** |
| 进程 | clone/clone3/fork/vfork/execve/execveat、COW、进程组/会话、完整信号、capabilities、pidfd | 支持 |
| namespace | unshare/setns 存在；net ns 有，pid/mnt/uts/ipc 无独立隔离；userns 无 | 部分 |
| cgroup | 目录结构 + procs 迁移，**无 controllers**（memcg/cpu 等） | 部分（缺核心） |
| 调度 | ax-task sched-rr（RR 时间片+优先级）；CFS 未启用；sched_setscheduler 桩 | 部分 |
| 电源 | 无 suspend/resume/wakelock/cpuidle；有 cpufreq DVFS + Rockchip PM 域；reboot 有 | **缺失** |
| 网络 | AF_INET/6、AF_UNIX、AF_NETLINK、AF_PACKET、AF_VSOCK；**netlink 仅最小实现**（KOBJECT_UEVENT 广播 + ROUTE 字节传输 + genl 最小） | 部分 |
| init | PID1=用户程序；ELF 加载器支持动态链接（musl ldso）；可跑 alpine（busybox）、riscv64 自编译 Debian | 支持 |
| 内存模型 | 每进程独立用户地址空间 + 页表切换；COW/mmap 后端齐全 | 支持 |
| SMP/架构 | SMP 开关（ax-runtime/smp、IPI、per-CPU runqueue）；riscv64/aarch64/loongarch64 官方支持，x86_64 实际可用 | 支持 |

## 6. 差距分析

### 6.1 OHOS 硬依赖 vs StarryOS 现状

| OHOS 依赖 | StarryOS 现状 | 差距等级 | 对应里程碑 |
|-----------|--------------|---------|-----------|
| binder/hwbinder（servicemanager/appspawn 硬依赖） | 无 | **阻塞** | M1 |
| fuse（共享存储/ohos 分区挂载） | 无 | **阻塞** | M1 |
| overlayfs | 已有实现 | ✅ 基本满足（挂载选项覆盖度需验证，如 index/redirect_dir 仅校验） | M1 |
| mount/pivot_root/bind | 已有 | ✅ 满足 | M1 |
| ueventd（devtmpfs + kobject uevent） | netlink KOBJECT_UEVENT 广播有；devtmpfs 语义需确认 | 大 | M1 |
| procfs/sysfs | 已有（含 /proc/mountinfo、bus/usb） | ✅ 基本满足 | M1 |
| cgroup（memcg 等 controllers） | 仅目录无 controller | **大**（memcg 是 ESWAP/内存统计基础） | M1/M2 |
| capabilities/seccomp | 已有 | ✅ 基本满足（策略需适配） | M1 |
| 完整 netlink/rtnetlink（netmanager） | 最小实现 | **阻塞** | M2 |
| 设备模型/HDF core 通信 | 无 HDF 语义 | 大 | M2 |
| suspend/wakelock 电源管理 | 无 | 大 | M3 |
| mount namespace 隔离（appspawn 每应用独立 mount ns + bind mount） | pid/mnt/uts/ipc 无独立隔离 | 大 | M3 |
| ion/dmaheap/GPU | ion 仅 sg2002 feature；GPU 驱动缺 | 大 | M3 |
| landlock/selinux 类安全 | 无 | 中（可先绕过） | M3 |
| fanotify | Unsupported | 中 | M3 |
| io_uring OP 覆盖 | setup/enter/register 有，OP 覆盖未知 | 中（需验证） | M2 |
| 调度（RTG 帧调度语义） | RR 调度 | 中（OHOS 服务可先跑通，帧调度是优化） | M3 |

### 6.2 关键判断

1. **「能跑 alpine」证明的是通用 POSIX 面**：musl/busybox 对内核的要求（fork/exec/open/read/socket/mmap）StarryOS 已覆盖得很好；但 OHOS 系统服务走的是 Linux 专有机制（binder ioctl、netlink 协议、cgroup、设备模型），这些不在 alpine 验证覆盖内。
2. **M1 的最大风险是 binder 与 fuse**：binder 是纯内核驱动（ioctl 面 + 用户态协议），可以按 ABI 复刻（有 AOSP 实现与 Android 文档可参考）；fuse 需要实现 VFS 转发协议（有 Linux 内核与 libfuse 参考）。两者都是「大而确定」的工作，不像调度/图形那样依赖难以复刻的语义。
3. **netmanager 的 netlink 深度是 M2 的阻塞项**：OHOS 网络栈通过 netlink/rtnetlink 做接口/路由管理，StarryOS 目前的 ROUTE 字节传输不足以支撑，需要按 rtnetlink 协议族补 RTM_GETLINK/GETADDR/NEWLINK/NEWROUTE 及多播组语义。
4. **cgroup 是系统级前提**：OHOS 进程树、memcg 统计、lmkd 类内存回收都挂在 cgroup 上；StarryOS 的「目录 + procs」只是壳，controllers 语义是独立大块。

## 7. 可行性结论

| 目标 | 结论 | 工作量级 | 主要风险 |
|------|------|---------|---------|
| M1：OHOS 启动到 shell | **可行**（工程量确定，无先例但可模块化推进） | 数人月 | binder ioctl 面、fuse 协议、ueventd 语义 |
| M2：核心系统服务在线 | 有条件可行（netlink/cgroup 补齐后） | 追加数人月 | netlink 深度、HDF 通信 |
| M3：跑通 OHOS 应用 | 高风险（图形/方舟/安全体系），不建议近期承诺 | 人月级+，不确定 | GPU 栈、方舟 runtime 依赖、seccomp 策略 |

**核心建议**：以 M1 为第一个正式里程碑。M1 的完成本身就有独立价值（证明 Rust 内核能承载 OHOS 用户态），且其失败模式清晰、可快速验证（启动日志到哪一步卡住）。不要一上来承诺 M3。

## 8. 替代方案比较

| 方案 | 语义完整性 | 工作量 | 风险 | 评价 |
|------|-----------|--------|------|------|
| A. StarryOS 完整承载 OHOS 标准系统 | 完整 | 极大 | 极高（无先例） | 长线目标，分阶段走 |
| B. StarryOS + OHOS 子集（启动到 shell/命令行） | 部分（M1） | 数人月 | 中 | **推荐起点** |
| C. 混合内核（StarryOS 主 + Linux 辅助跑 OHOS） | 高 | 大（IPC/内存共享） | 高 | 架构不清晰，不推荐 |
| D. 放弃，用 Linux 内核 + OHOS 官方发布 | 完整 | 0 | 无 | 失去「Rust 内核承载」价值 |
| E. 先做「OHOS rootfs 在 StarryOS 上启动」概念验证（不承诺系统服务） | 最小 | 小 | 低 | 与 B 重叠，可作 B 的第一阶段 |

选 B（M1 起步），理由：工程量确定、风险可控、可独立验收；M2/M3 在 M1 之后根据证据再决定，符合 feature-development「先证明问题值得解决，再分步验证」的原则。

## 9. 分阶段路线图（建议）

### M0：准备与证据采集（1-2 周）
- 获取 OHOS 标准系统镜像（5.0/6.0，rk3568 或 qemu 可用目标）并在 QEMU + Linux 上跑通；
- 用 strace 抓 OHOS 启动链路的**精确 syscall/ioctl 依赖清单**（binder ioctl 号、netlink 消息、mount 序列）；
- 产出：依赖清单文档（作为 M1 的实现输入）。

### M1：OHOS 用户态启动到 shell（数人月）
- StarryOS 新增：binder 设备（/dev/binder + ioctl 面，参考 AOSP binder 驱动语义）；fuse（VFS 转发，参考 Linux fuse 协议）；ueventd 所需 devtmpfs 语义；
- 验证 cgroup 目录/memcg 最小语义、capabilities/seccomp 策略适配；
- 验收：OHOS rootfs 在 StarryOS 上启动，begetd 跑完启动序列，进入 shell/命令行；
- 每个新能力按 [syscall.md](../book/guideline/starry/syscall.md) 要求做 Linux/Starry 差分验证。

### M2：核心系统服务（追加数人月）
- netlink/rtnetlink 协议族补齐；HDF devmgr 通信；cgroup controllers（memcg 起步）；
- 验收：servicemanager/netmanager 在线，hdc 可连接。

### M3：应用与图形（高风险，建议仅评估）
- appspawn、方舟运行时、GPU/图形栈、suspend/wakelock、安全体系；
- 结论前先做专项可行性验证（方舟 runtime 对 mmap/线程/内存的依赖清单）。

## 10. 开放问题与下一步

1. **「安卓支持」语义需确认**：指内核 android config 面（本报告评估口径）还是 APK 兼容层？
2. **OHOS 目标版本**：5.0.3 还是 6.0？不同版本补丁面与 rootfs 结构有差异，影响 M0 镜像选择。
3. **目标平台**：qemu-aarch64（rk3568 类）作为开发验证平台，还是直接面向某块开发板？
4. **下一步动作建议**：启动 M0（获取镜像 + Linux 上跑通 + strace 依赖清单）。这是成本最低、最能消除本报告不确定度的动作。

## 附录：证据来源

| 来源 | 内容 | 检索日 |
|------|------|--------|
| [openharmony/kernel_linux_6.6](https://gitee.com/openharmony/kernel_linux_6.6) | linux-6.6 原生仓；分支/补丁基线（README_OpenHarmony.md、branches API） | 2026-08-03 |
| [openharmony/docs 内核章节](https://gitee.com/openharmony/docs/blob/master/zh-cn/device-dev/kernel/Readme-CN.md) | 标准系统内核概述（Linux、128MiB、6.6 适配）、增强特性目录（ESWAP/NewIP/RTG/CPU isolation/HCK） | 2026-08-03 |
| [openharmony/startup_init](https://gitee.com/openharmony/startup_init) | begetd/ueventd/services/remount/initsync/watchdog 结构 | 2026-08-03 |
| tgoskits `os/StarryOS/kernel` 代码树 | syscall/VFS/驱动/进程/网络/init 现状 | 2026-08-03 |
| [starry/syscall.md](../book/guideline/starry/syscall.md) | syscall 语义证据要求 | 2026-08-03 |

**未核实项**（实现阶段必须补）：hwbinder 具体 ioctl 面、fuse 增强细节、OHOS security hooks/selinux 策略、OHOS 镜像分区与 .cfg 脚本的一手内容、netmanager 的 netlink 消息集合。不确定度已在正文各节标注。
