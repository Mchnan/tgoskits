// venus/zink 加速桌面端到端闭环 — 现状与计划（第十轮收官，2026-10-11）
// 内核取证轮：Xwayland SIGSEGV@0x15c 根因闭合（mesa 栈版本分裂 + 虚表错位），
// 统一 mesa 栈到 26.2.4 齐套，A/B 差分证实修复，Xwayland 历史首次 ready。
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

const crashChain = {
  nodes: [
    { id: "split", label: "mesa两代共存" },
    { id: "soname", label: "SONAME撞名shim" },
    { id: "share", label: "screen跨代共享" },
    { id: "vtable", label: "虚表槽位错位" },
    { id: "deref", label: "格式当指针" },
    { id: "crash", label: "SIGSEGV@0x15c" },
  ],
  edges: [
    { from: "split", to: "soname", label: "libdril_dri.so双份" },
    { from: "soname", to: "share", label: "dlopen先到先得" },
    { from: "share", to: "vtable", label: "25.2.7建/26.2.3调" },
    { from: "vtable", to: "deref", label: "+0x6c0槽位移位" },
    { from: "deref", to: "crash", label: "0x80B拷贝构造" },
  ],
};

const evidenceHeaders = ["证据", "取证方法", "结论"];
const evidenceAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const evidenceRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "info", "warning",
];
const evidenceRows = [
  [
    "pc=0xe56dcc x20=0x15c insn@pc=0xad40669a（ldp q26,q25,[x20]）",
    "内核同步 fault 一次性 dump：全量寄存器 + 指令字 + 映射表 + 栈字",
    "0x80 字节 SIMD 拷贝构造从 x20=0x15c 解引用——PIPE_FORMAT 枚举被当模板指针",
  ],
  [
    "PC 0xe56dcc ∈ libgallium-25.2.7.so（0x71c000+0x73adcc）",
    "crash mappings + .eh_frame FDE（0x73ada0..0x73aed0）+ 源码逐字段对照",
    "锁定 llvmpipe_resource_from_memobj（25.2.7 lp_texture.c:496）",
  ],
  [
    "栈字 [sp+8]=0xd1cc664 ∈ libEGL-26.2.3 +0x19664",
    "aarch64 序言 stp x29,x30,[sp,#-N]! 下调用者返回地址在 [sp+8]",
    "调用点 ldr x6,[x20,#0x6c0]; blr x6 = 26.2.3 布局的 is_format_supported",
  ],
  [
    "26.2.3 的 pipe_screen 在方法区前插入 caps/shader_caps/nir_options",
    "两代 p_screen.h 逐槽对照（is_format_supported：25.2.7 #12 / 26.2.3 #14，字节偏移后移至 +0x6c0）",
    "同偏移在 25.2.7 虚表上是 resource_from_memobj——虚表错位实锤",
  ],
  [
    "A/B 差分（同内核同 rootfs，仅换 mesa 栈）",
    "第九轮混装栈 vs 统一 26.2.4 齐套，各跑一轮 e2e",
    "混装栈 @2.8s 崩溃复现；统一栈零 SIGSEGV，Xwayland 历史首次 ready",
  ],
  [
    "scanout 仍 100% 黑，但 atlas blob 有完整壁纸（暗红 41,8,19）",
    "QEMU pmemsave 读 hostmem BAR + 逐像素统计",
    "内容在合成器侧存在；池缓冲→scanout 可见性是下一前沿（与 mesa 代际无关）",
  ],
];

const closedHeaders = ["链条", "轮次", "处置", "状态"];
const closedAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const closedRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "success", "warning",
];
const closedRows = [
  [
    "创建失败链（MVK 拒绝→宿主静默→幽灵句柄→ring 死）",
    "第七轮",
    "null stub + 先捕获 guest id；内核 out-syncobj 推迟到宿主 fence retire",
    "已修复",
  ],
  [
    "shader 保留字（skia sampler 遮蔽 MSL）",
    "第九轮",
    "MoltenVK main@67b2682 重建（SPIRV-Cross aa217aeb）",
    "已修复",
  ],
  [
    "ICD 部署劫持（DYLD_LIBRARY_PATH @rpath 落 brew 1.4.2）",
    "第九轮",
    "唯一 install name + ad-hoc codesign，json 指绝对路径",
    "已修复",
  ],
  [
    "ring 内部卡点（~6s 冻结 / phase=1000）",
    "第八→九轮",
    "确认是被拒 shader 的下游，重建后未复现",
    "已闭合",
  ],
  [
    "Xwayland SIGSEGV@0x15c（第三轮起同址同形态）",
    "第十轮",
    "mesa 栈统一 26.2.4 齐套 + 清除旧代文件",
    "已闭合",
  ],
  [
    "scanout 100% 黑（内容在合成器侧，池缓冲不可见）",
    "第十轮定性",
    "pool buffer 导入/呈现路径与 blob 映射策略待查",
    "活跃前沿",
  ],
];

const planItems = [
  {
    id: "r10-forensics",
    content: "内核崩溃取证四件套落地：全量寄存器 / insn@pc / crash mappings / 栈顶 8 字，per-process 一次性 dump（handle_user_page_fault 在 force-deliver 前调用，无视 disposition）",
    status: "completed" as const,
  },
  {
    id: "r10-func",
    content: "崩溃函数锁定：libgallium-25.2.7 的 llvmpipe_resource_from_memobj（FDE 边界 + 反汇编形状 + 源码逐字段吻合）",
    status: "completed" as const,
  },
  {
    id: "r10-caller",
    content: "调用者锁定：libEGL-26.2.3 +0x19664 的 is_format_supported 调用点（栈字 [sp+8] 直接给出）",
    status: "completed" as const,
  },
  {
    id: "r10-root",
    content: "根因定性：mesa 栈版本分裂（25.2.7 GL 侧 / 26.2.3 EGL 侧）+ pipe_screen 无版本化 ABI 的虚表错位；桥接实体 = SONAME 撞名的双份 dril shim",
    status: "completed" as const,
  },
  {
    id: "r10-fix",
    content: "修复：统一 mesa 栈到 edge 26.2.4 齐套（libgallium/libGL/libGLESx2/libEGL/libgbm/gbm 后端/dri shims/libvulkan_virtio/drirc.d），删除 25.2.7 与 26.2.3 旧代文件；全部 debugfs 注入 + MD5 回读校验",
    status: "completed" as const,
  },
  {
    id: "r10-ab",
    content: "A/B 差分复测：混装栈崩溃复现、统一栈零 SIGSEGV 且 Xwayland is ready display=:0（历史首次）+ XEmbed tray 映射、数分钟级存活",
    status: "completed" as const,
  },
  {
    id: "r10-land",
    content: "提交 20be680bd（内核取证 + 设计文档第十轮补记 + AGENTS.md 记忆）；aarch64 clippy 全量过、fmt 干净",
    status: "completed" as const,
  },
  {
    id: "r10-pool",
    content: "下一手（主攻）：池缓冲→scanout 可见性——Flutter 池缓冲（res 29/30，1.3MB）在 BAR 无映射、scanout 读宿主侧资源内存为黑；沿 dmabuf 导入是否落 shadow、fence 归还、blob 映射策略取实",
    status: "pending" as const,
  },
  {
    id: "r10-ts",
    content: "26.2.4 zink-venus GPU timestamp 语义核对（gpu_flutter_render 达 4.8e12 µs 量级，疑似频率/单位失配；当前只能判定有 GPU 活动）",
    status: "pending" as const,
  },
  {
    id: "r10-60hz",
    content: "内容帧恢复后测量 60Hz 持续帧率与 deadline 预算稳定性（present 链已健康：present_callback ~1ms、deadline p50≈15ms 在 16.6ms 预算内、missed_vblanks=0）",
    status: "pending" as const,
  },
];

const commitHeaders = ["仓库 / 栈", "提交", "内容"];
const commitAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const commitRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "success",
];
const commitRows = [
  [
    "tgoskits 内核（local/venus-into-dev-0924）",
    <Code>20be680bd</Code>,
    "第十轮：内核崩溃取证四件套 + 同步 fault 一次性 dump + aarch64 FP 回溯（signal.rs / user.rs / mod.rs，+253/−8）",
  ],
  [
    "tgoskits 文档",
    <Code>20be680bd</Code>,
    "设计文档 §Xwayland SIGSEGV 根因闭合 + AGENTS.md 第十轮记忆",
  ],
  [
    "tgoskits 文档（第九轮）",
    <Code>f559dd4ae</Code>,
    "MoltenVK 重建与 ring 卡点闭合补记",
  ],
  [
    "guest rootfs（denial-full 镜像，debugfs 注入）",
    <Code>—</Code>,
    "mesa 26.2.4 齐套 9 文件替换 + 3 个旧代文件删除 + drirc.d + dri 符号链接统一；MD5 回读全过",
  ],
  [
    "denial 工作树",
    <Code>3cab163</Code>,
    "（历史）Skia present 修复 + 心跳双通道 + 主循环 phase 相位码",
  ],
];

const memoHeaders = ["备忘", "内容"];
const memoAlign: Array<TableColumnAlign | undefined> = ["left", "left"];
const memoRows = [
  [
    "内核崩溃取证 = guest ptrace 替代品",
    "warn 级一次性输出（comm/exe/PC/LR/全寄存器/指令字/映射表/栈字），本例从零到锁定「库内偏移+调用者」只用一轮重启；Xwayland 装了 SIGSEGV handler，投递终止路径的 dump 被 handler 吞掉——必须在 force-deliver 前 dump",
  ],
  [
    "aarch64 FP 链语义",
    "序言 stp x29,x30,[sp,#-N]! 下 fp 指向保存对本身：读 [fp]/[fp+8]，不要按 riscv64 减 16；fp 链断裂时 [sp+8] 仍是调用者返回地址",
  ],
  [
    "mesa 换代纪律（本轮核心教训）",
    "libgallium 是版本化 SONAME（libgallium-<ver>.so）可多代共存；pipe_screen 无版本化 ABI，跨代共享即虚表错位。换 mesa 必须整套换（libGL/libGLES/libEGL/libgbm/gbm 后端/dri shims/libvulkan_virtio/drirc.d）并清掉旧代散落文件（含 /usr/lib 根下的散落 shim）",
  ],
  [
    "watcher 取证修复",
    "busybox wget --post-file 把响应体落盘为 URL 基名（CWD 在 /root）——POST 前同时清 /tmp/snap 与 /root/snap；全量 dd.log 上传 /tmp/pulled/ddfull.* 已打通",
  ],
  [
    "26.2.4 依赖面",
    "libgallium-26.2.4 依赖 libLLVM.so.23.1 / libSPIRV-Tools.so / libzstd 与 26.2.3 相同，无需连带升级；ICD json 与旧版逐字节相同",
  ],
  [
    "hostmem 取证手法",
    "QEMU monitor pmemsave 读 virtio-gpu hostmem BAR（info mtree 看 blob 子区域）+ 逐像素统计定位内容；live blob 映射会增删，BAR 里可看到已 unmap blob 的残留页",
  ],
];

export default function VenusClosureStatus(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>venus/zink 加速桌面 — Xwayland SIGSEGV 根因闭合（内核取证轮）</H1>
      <Text>
        第十轮收官（2026-10-11，内核取证轮）。第九轮把黑屏归因为 shell（pid 17）
        Xwayland 的 SIGSEGV@VA:0x15c。本轮不再依赖 guest 侧 ptrace，改为给内核加
        同步 fault 的一次性崩溃现场 dump，一轮重启直接拿到「库内偏移 + 调用者」：
        根因是 guest rootfs 内 mesa 栈混装——libGL-25.2.7（GLX/AIGLX 侧）与
        libEGL-26.2.3（注入的 EGL 侧）两代共存，pipe_screen 无版本化 ABI，
        26.2.3 的 is_format_supported 槽位（+0x6c0）在 25.2.7 虚表上落在
        resource_from_memobj，PIPE_FORMAT 枚举被当模板指针解引用。修复 = 统一
        mesa 栈到 26.2.4 齐套并清除旧代文件，差分 A/B 复测证实。
      </Text>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="0 次" label="SIGSEGV（统一 26.2.4 后；混装栈 2.8s 必崩）" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="历史首次" label="Xwayland is ready display=:0 + XEmbed tray 映射" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="≈15ms" label="deadline_to_presentation_p50（16.6ms 预算内）" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="100% 黑" label="scanout 现状：池缓冲→scanout 可见性（新前沿）" tone="warning" />
          </CardBody>
        </Card>
      </Grid>

      <Callout tone="danger" title="本轮根因：mesa 栈版本分裂 + pipe_screen 虚表错位">
        <Text>
          Xwayland 进程内同时存在 libGL-25.2.7（基底，NEEDED
          libgallium-25.2.7.so，GLX/AIGLX 侧创建 screen）与 libEGL-26.2.3
          （第三轮注入，NEEDED libgallium-26.2.3.so）。崩溃链：libEGL-26.2.3
          按 26.2.3 布局在 pscreen+0x6c0 调 is_format_supported(pscreen,
          format=0x15c, PIPE_TEXTURE_2D, 0, 0, PIPE_BIND_RENDER_TARGET)——
          26.2.3 在方法区前插入了 caps/shader_caps/nir_options 数据成员把
          方法区后移，同一偏移在 25.2.7 虚表上是
          llvmpipe_resource_from_memobj；该函数把第二参数当
          struct pipe_resource * 做 0x80 字节拷贝构造，格式枚举值 0x15c 被当
          指针解引用即崩。桥接实体：/usr/lib/dri/libdril_dri.so（25.2.7 实
          文件）与 /usr/lib/zink_dri.so（26.2.3 shim）SONAME 同为
          libdril_dri.so，musl dlopen 先到先得，screen 跨代流到对方。崩溃
          首现 == 第三轮首次注入 26.2.x，时间线吻合。
        </Text>
      </Callout>

      <Card>
        <CardHeader>
          <H2>崩溃链（本轮闭合）</H2>
        </CardHeader>
        <CardBody>
          <ArchGraph nodes={crashChain.nodes} edges={crashChain.edges} direction="vertical" />
          <Divider />
          <Text>
            修复把「两代共存」拆除：mesa 栈整体升到 26.2.4（26.2.3 的
            mesa-gl/mesa-gles 已被 CDN 滚走，故取 edge 现行版本），单一
            libgallium、单一 dril shim，screen 不再跨代。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>内核崩溃取证（本轮新增的可复用能力）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={6}>
            <Text>
              handle_user_page_fault 在 force-deliver 之前调用新增的
              dump_sync_fault_if_terminating：每进程代仅一次
              （ProcessData.sync_fault_dumped），无视 signal disposition——
              Xwayland 装了 SIGSEGV handler，原有「投递终止才 dump」的路径被
              handler 吞掉，这正是第九轮拿不到寄存器的原因。
            </Text>
            <Text>
              aarch64 四件套：全量 x0–x30 寄存器；insn@pc（4 字节指令字，
              离线即可反汇编）；crash mappings（含 PC 的映射 + 全部可执行
              映射，文件路径 + 文件内偏移）；栈顶 8 字（[sp+8] = 调用者返回
              地址）。另补齐 aarch64 FP 链回溯（原 riscv64-only）。
            </Text>
            <Text>
              实现：
              <FL path="../os/StarryOS/kernel/src/task/signal.rs" label="task/signal.rs" />
              {" / "}
              <FL path="../os/StarryOS/kernel/src/task/user.rs" label="task/user.rs" />
              {" / "}
              <FL path="../os/StarryOS/kernel/src/task/mod.rs" label="task/mod.rs" />
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>取证证据（第十轮）</H2>
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
          <H2>历轮断点清单（全部对账）</H2>
        </CardHeader>
        <CardBody>
          <Table
            headers={closedHeaders}
            rows={closedRows}
            columnAlign={closedAlign}
            rowTone={closedRowTones}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>第十轮任务清单与下一步计划</H2>
        </CardHeader>
        <CardBody>
          <TodoListCard todos={planItems} />
          <Divider />
          <Callout tone="info" title="下一手：池缓冲 → scanout 可见性（黑屏的最后一层）">
            <Text>
              现有证据：Flutter GPU 光栅在跑（gpu_render_samples=28/43、
              damage rect 336,0-640,45 顶栏区域、present_callback ~1ms）、
              hostmem BAR dump 的 atlas blob（2MB）有完整壁纸（暗红
              (41,8,19)，stride≠2560 呈剪切）——内容在合成器侧存在；而被
              flip 的池缓冲（res 29/30，1.3MB）在 BAR 无映射（info mtree
              仅剩 144KB blob），scanout 读宿主侧资源内存为黑。该缺口与
              mesa 代际无关（A/B 两侧起步帧均黑，第八轮的 684 灰起步帧在
              第九轮 MoltenVK 重建后即消失）。取实方向：dmabuf 导入是否落
              shadow、fence 归还、blob 映射策略；顺带核对 26.2.4 zink-venus
              的 GPU timestamp 语义（4.8e12 µs 量级异常值）。
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
              设计文档（§Xwayland SIGSEGV 根因闭合）：
              <FL path="design/starry-venus-into-dev-card0.md" label="docs/design/starry-venus-into-dev-card0.md" />
            </Text>
            <Text>
              项目记忆：
              <FL path="../AGENTS.md" label="AGENTS.md §3" />
            </Text>
            <Text>
              内核取证实现：
              <FL path="../os/StarryOS/kernel/src/task/signal.rs" label="task/signal.rs" />
              {" / "}
              <FL path="../os/StarryOS/kernel/src/task/user.rs" label="task/user.rs" />
            </Text>
            <Text>
              内核 fence 注册表（第七轮）：
              <FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" label="pseudofs/dev/vgpu.rs" />
            </Text>
            <Text>
              e2e watcher（本轮修复 wget 落盘 + 全量 dd.log 上传）：
              <FL
                path="/Users/herbcheng/venus-stack/e2e-run.sh"
                label="venus-stack/e2e-run.sh"
              />
              {" / 启动："}
              <FL
                path="/Users/herbcheng/venus-stack/qstart-denial-e2e.sh"
                label="qstart-denial-e2e.sh"
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
        <Pill active>第十轮收官</Pill>
        <Pill>0x15c 根因闭合</Pill>
        <Pill>mesa 26.2.4 统一</Pill>
        <Pill>Xwayland 首次 ready</Pill>
        <Pill>scanout 黑 = 新前沿</Pill>
      </Row>
      <Text>
        状态基调：黑屏的三层结构已剥完两层——Xwayland 崩溃层（本轮闭合）与
        GPU 通道层（第七至九轮闭合）均已修复；剩最后一层「内容在合成器侧
        存在但 scanout 读不到」（池缓冲可见性），与 mesa 代际无关、第十轮已
        定性取证。present 链健康（present_callback ~1ms、deadline p50≈15ms
        在预算内、missed_vblanks=0），60Hz 持续帧率测量等内容帧上屏后进行。
      </Text>
    </Stack>
  );
}
