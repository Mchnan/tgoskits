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
          <Stat value="唯一可行" label="Venus：guest Vulkan → 宿主 MoltenVK" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="87-127ms" label="现状 llvmpipe raster p50/p95（占帧生产 97%）" tone="danger" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="<5ms" label="Venus 落地后 raster 目标量级" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="零覆盖" label="card0 现有 VIRTGPU_* ioctl（纯 KMS 仿真）" tone="danger" />
        </CardBody>
      </Card>
    </Grid>
  );
}

// ---- path matrix ----

const pathHeaders = ["路径", "macOS 判定", "一句话理由"];
const pathColumnAlign: Array<TableColumnAlign | undefined> = ["left", "center", "left"];
const pathRowTones: Array<TableRowTone | undefined> = ["success", "danger", "warning", "danger"];
const pathRows: (string | JSX.Element)[][] = [
  [
    "Venus（Vulkan passthrough）",
    <Pill active>可行</Pill>,
    "virglrenderer 上游显式支持 darwin：vkr_metal_helpers.m（2026-04）用 vkExportMetalObjectsEXT + shm mmap + MTLBuffer 导入解决外部内存；MoltenVK 已支持 VK_EXT_external_memory_metal",
  ],
  [
    "virgl（OpenGL passthrough）",
    "不可行",
    "libepoxy 在 darwin 上禁用 EGL/GLX；brew 的 virglrenderer 在 macOS 只能建 NO_VIRGL 空壳上下文；Apple GL 已弃用且上限 4.1，virgl GL 后端没有可用宿主 GL 窗口系统",
  ],
  [
    "gfxstream（rutabaga 后端）",
    "不推荐",
    "QEMU virtio-gpu-rutabaga 需要 rutabaga_gfx_ffi（macOS 构建支持不明）；guest 需 mesa gfxstream 驱动（Alpine 无包，须自编）；仅剩 Linux/Android 生态",
  ],
  [
    "DRM native context",
    "不适用",
    "上游仅面向 Linux 宿主的具体 DRM 驱动（amdgpu/i915/panfrost 等），macOS 无对应 DRM 驱动",
  ],
];

// ---- pipeline graph ----

const pipeline = {
  nodes: [
    { id: "flutter", label: "deniald Flutter" },
    { id: "icd", label: "mesa venus ICD" },
    { id: "kernel", label: "内核 virtio-gpu" },
    { id: "qemu", label: "QEMU gl 后端" },
    { id: "vkr", label: "virglrenderer" },
    { id: "mvk", label: "MoltenVK Metal" },
    { id: "cocoa", label: "cocoa 显示" },
  ],
  edges: [
    { from: "flutter", to: "icd", label: "Vulkan" },
    { from: "icd", to: "kernel", label: "VIRTGPU_*" },
    { from: "kernel", to: "qemu", label: "virtqueue" },
    { from: "qemu", to: "vkr", label: "capset" },
    { from: "vkr", to: "mvk", label: "shm+MTLBuffer" },
    { from: "mvk", to: "kernel", tone: "back" as const, label: "结果共享回传" },
    { from: "kernel", to: "cocoa", label: "2D scanout 呈现" },
  ],
};

// ---- evidence cards ----

function EvidenceCards() {
  return (
    <Stack gap={12}>
      <Card>
        <CardHeader><H3>1.1 virglrenderer 上游明确支持 darwin，且专为 Venus 做了 Metal 互操作</H3></CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>
              根 meson 有 <Code>with_host_darwin</Code> 分支（darwin 上 EGL 不要求 gbm）；
              src/meson 在 <Code>with_venus and with_host_darwin</Code> 时编入
              <Code>venus/vkr_metal_helpers.m</Code>——专门为 macOS 加的 Objective-C Metal 帮助层。
            </Text>
            <Text>
              vkr_metal_helpers.m（2026-04，作者 Lucas Amaral）干两件事：
              <Code>vkExportMetalObjectsEXT</Code> 取 MTLDevice；
              <Code>os_create_anonymous_file</Code> + mmap 后用
              <Code>newBufferWithBytesNoCopy</Code> 把同一块共享内存包成 MTLBuffer
              （MTLStorageShared，host CPU 与 GPU 看同一页——正是 Venus host-visible 内存需要的语义）。
            </Text>
            <Text>
              vkr_device_memory.c：宿主支持 <Code>VK_EXT_external_memory_metal</Code> 时，
              host-visible 内存走「shm + MTLBuffer 导入」（handle type
              <Code>VK_EXTERNAL_MEMORY_HANDLE_TYPE_MTLBUFFER_BIT_EXT</Code>），完全不需要 dma-buf。
            </Text>
          </Stack>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><H3>1.2 MoltenVK（宿主 Vulkan）具备所需扩展</H3></CardHeader>
        <CardBody>
          <Text>
            MoltenVK 官方 Whats_New 明确包含 <Code>VK_EXT_external_memory_metal</Code>、
            <Code>VK_EXT_external_memory_host</Code>、<Code>vkExportMetalObjectsEXT</Code> 与
            <Code>VK_KHR_external_memory_*</Code>。Homebrew 有受维护的 <Code>molten-vk</Code>
            formula（brew 的 mesa formula 就以 -Dmoltenvk-dir 引用它）。
          </Text>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><H3>1.3 QEMU：设备存在，但 brew 包没编进去</H3></CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>
              QEMU 11 文档：3D 后端只有 virtio-gpu-gl（virglrenderer：virgl GL / venus / DRM native
              context）与 virtio-gpu-rutabaga（gfxstream）两种；Venus 的设备形态如下，blob 映射走
              <Code>virgl_renderer_resource_map</Code> + QEMU memory region（POSIX mmap，不绑 KVM，
              darwin/HVF 原则可行）。但官方宿主要求表只写了 Linux 行——属「上游只测过 Linux」，
              不是机制性排除，本项目要自证。
            </Text>
            <CodeBlock language="bash" code={`# 本机 brew QEMU 11.0.3 -device help 只有 virtio-gpu-pci/device（2D）
# 需要源码构建 QEMU：
meson setup build -Dvirglrenderer=enabled -Dopengl=enabled
# opengl=epoxy，darwin 上 epoxy 仅 GL 也可满足依赖

# 宿主 virglrenderer 必须源码构建（brew 版没开 venus 且无 EGL）：
meson setup build -Dvenus=true   # 需要 ObjC + Metal framework + 动态加载的 MoltenVK

# 目标设备：
qemu-system-aarch64 ... -device virtio-gpu-gl,hostmem=4G,blob=true,venus=true`} />
          </Stack>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><H3>1.4 guest rootfs 现状：纯 GL 栈，无任何 Vulkan ICD</H3></CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>
              debugfs 只读检查 rootfs-aarch64-denial-full.img：Alpine 系（gcompat 跑 glibc deniald），
              mesa 25.2.7 纯 GL 栈（libgallium、libdril_dri.so、libEGL/libGL、libgbm），
              <Code>/usr/share/vulkan</Code> 为空、无 libvulkan——Flutter 的 Impeller
              目前实际跑在 GL（llvmpipe）上。
            </Text>
            <Text>
              好消息：Alpine edge 有现成 aarch64 包 <Code>mesa-vulkan-virtio</Code>（venus ICD），
              v3.22 没有。venus 驱动还要求 guest 内核 virtio-gpu 驱动宣称 5 个 param：
              <Code>3D_FEATURES / CAPSET_QUERY_FIX / RESOURCE_BLOB / HOST_VISIBLE / CONTEXT_INIT</Code>。
            </Text>
          </Stack>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><H3>1.5 guest 内核现状：card0 是 pure KMS 仿真，VIRTGPU_* 零覆盖</H3></CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>
              <RepoFileLink
                path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs"
                label="os/StarryOS/kernel/src/pseudofs/dev/card0.rs"
              />{" "}
              是 simpledrm 类 KMS 仿真：CREATE_DUMB/ADDFB2/SETCRTC/PAGE_FLIP/MODE_ATOMIC +
              合成 vblank，present 是 memcpy 进 axdisplay scanout（再经 virtio-drivers 的 2D 协议刷给
              QEMU）。全仓库没有 VIRTGPU_* 用户态 ioctl 族——上轮审计的三条 ENOSYS 探针即此。
            </Text>
            <Text>
              2D virtio-gpu 协议在外部 <Code>virtio-drivers</Code> crate（VirtIOGpu 2D：
              transfer_to_host_2d / resource_flush），axdisplay 只消费其 framebuffer。
              内核侧缺的是一整套真实 virtio-gpu DRM 驱动的 3D 面：GETPARAM / GET_CAPS /
              RESOURCE_CREATE_BLOB / MAP / CONTEXT_INIT / EXECBUFFER、hostmem BAR 映射、
              blob 生命周期与事件队列——本项目最大工程量，但范围清晰（Linux virtio_gpu 驱动子集）。
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

// ---- gap table ----

const gapHeaders = ["层", "现状", "缺口"];
const gapColumnAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const gapRowTones: Array<TableRowTone | undefined> = ["warning", "danger", "warning"];
const gapRows = [
  [
    "宿主",
    "brew QEMU 11.0.3 无 3D 设备；MoltenVK 未装；brew virglrenderer 未开 venus",
    "源码构建 QEMU（virgl+opengl）与 virglrenderer（-Dvenus=true）+ brew install molten-vk",
  ],
  [
    "guest 内核（最大项）",
    "card0 纯 KMS 仿真；零 VIRTGPU_* ioctl；2D 协议在 virtio-drivers crate",
    "virtio-gpu DRM 的 3D 面：GETPARAM/GET_CAPS/RESOURCE_CREATE_BLOB/MAP/CONTEXT_INIT/EXECBUFFER + hostmem BAR 映射 + 事件队列",
  ],
  [
    "guest 用户态",
    "Alpine rootfs 只有 mesa 25.2.7 纯 GL 栈（Flutter 跑 llvmpipe），无 Vulkan ICD",
    "Alpine edge mesa-vulkan-virtio 包（或自编 mesa -Dvulkan-drivers=virtio）+ libvulkan-loader；Flutter 切 Vulkan/Impeller",
  ],
];

// ---- phase table ----

const phaseHeaders = ["Phase", "做什么", "通过判据", "为什么要先做"];
const phaseColumnAlign: Array<TableColumnAlign | undefined> = ["center", "left", "left", "left"];
const phaseRowTones: Array<TableRowTone | undefined> = ["success", "info", "info", "neutral"];
const phaseRows = [
  [
    "0",
    "brew install molten-vk，宿主 vulkaninfo",
    "确认 VK_EXT_external_memory_metal、vkExportMetalObjectsEXT、Vulkan 1.2+",
    "半天级，宿主链第一环直接证伪",
  ],
  [
    "1",
    "源码构建 virglrenderer -Dvenus=true 与带 virtio-gpu-gl 的 QEMU；宿主跑 virgl_test_server --venus；guest 装 venus ICD，VN_DEBUG=vtest 走 socket",
    "guest 内 vulkaninfo / vkcube 经 vtest 渲染成功",
    "vtest 完全绕过 guest 内核驱动，先定锤宿主 renderer + guest ICD 两端与 MoltenVK 兼容性；失败尽早止损",
  ],
  [
    "2",
    "StarryOS 实现 VIRTGPU_* 子集（GETPARAM/GET_CAPS/RESOURCE_CREATE_BLOB/MAP/CONTEXT_INIT/EXECBUFFER + hostmem BAR + 事件队列）；QEMU 切 venus=true 真设备",
    "guest vulkaninfo 走真 virtio-gpu 设备",
    "唯一的大项；建议在 #2365/#2393 上游收敛后单独立项",
  ],
  [
    "3",
    "deniald Flutter 切 Vulkan/Impeller + KMS/scanout 集成",
    "「动画 + 即取 dd.log 审计」流程对比 raster_avg_us 与 screendump 差分帧率",
    "目标是 raster 从 87-127ms 进入 <5ms 量级",
  ],
];

// ---- risk table ----

const riskHeaders = ["风险 / 未定项", "影响", "缓解"];
const riskColumnAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const riskRowTones: Array<TableRowTone | undefined> = ["warning", "warning", "neutral", "warning"];
const riskRows = [
  [
    "QEMU virtio-gpu-gl 在 darwin/HVF 无官方宿主支持记录（文档表只有 Linux 行）",
    "blob/hostmem 映射可能有 darwin 专有坑",
    "Phase 1 的 vtest 先验可暴露 renderer 侧问题；QEMU 侧问题在 Phase 2 初暴露",
  ],
  [
    "virglrenderer 的 darwin Venus 支持是 2026-04 新代码",
    "成熟度未经验证",
    "Phase 1 直接实测；失败即止损，不投入内核侧",
  ],
  [
    "Venus 的「违规假设」（vkMapMemory 映射 host-visible 内存）",
    "MoltenVK 行为需实测",
    "macOS 路径用 shm/MTLBuffer 绕开 dma-buf；Phase 1 vkcube 验证一致性",
  ],
  [
    "deniald 是外部二进制，Flutter embedder 是否接受 venus ICD、Impeller-Vulkan 的 WSI 适配",
    "集成面不确定",
    "Phase 3 实测；ICD 就位后 Flutter 通常自动探测 Vulkan",
  ],
  [
    "兜底路线",
    "Venus 不通时的退路",
    "lavapipe（仍是软件，收益有限）、gfxstream 自编（成本高）、llvmpipe 使用方式优化",
  ],
];

// ---- page ----

export default function HostVulkanAccelerationResearch(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 24 }}>
      <H1>宿主 Vulkan 渲染加速调研（denial 桌面帧率下一手）</H1>
      <Text>
        2026-09-14 定稿 · 纯调研、未动任何实现 · 完整报告见{" "}
        <RepoFileLink
          path="research-host-vulkan-acceleration.md"
          label="docs/research-host-vulkan-acceleration.md"
        />{" "}
        · 上一轮根因见{" "}
        <RepoFileLink
          path="starryos-denial-qemu-fps-root-cause.canvas.tsx"
          label="fps root-cause 画布"
        />
      </Text>

      <SummaryStrip />

      <Callout tone="info" title="TL;DR">
        <Text>
          macOS 宿主上唯一现实的 GPU 加速路径是 <Code>Venus</Code>
          （guest Vulkan → 宿主 Vulkan/MoltenVK），经 virglrenderer 的 darwin 后端落地——上游生态
          已把路修通大半（darwin 编译分支 + 2026-04 的 Metal 互操作层）。virgl（宿主 GL）在 macOS
          判死（epoxy 无 EGL/GLX、Apple GL 弃用），gfxstream 成本显著更高。三端缺口：宿主需源码构建
          QEMU + virglrenderer，guest 内核需实现 VIRTGPU_* 3D 面（最大工程项），guest 用户态用
          Alpine edge 的 mesa-vulkan-virtio 包。验证走 vtest 免内核先验，可小代价证伪。
        </Text>
      </Callout>

      <Stack gap={8}>
        <H2>一、macOS 加速路径全景</H2>
        <Table
          headers={pathHeaders}
          rows={pathRows}
          columnAlign={pathColumnAlign}
          rowTone={pathRowTones}
        />
      </Stack>

      <Stack gap={8}>
        <H2>二、证据链（逐条可复核）</H2>
        <EvidenceCards />
      </Stack>

      <Stack gap={8}>
        <H2>三、Venus 端到端链路（目标形态）</H2>
        <Card>
          <CardHeader><H3>guest Vulkan 命令流 → 宿主 Metal 渲染 → 共享内存回传 → 2D scanout 呈现</H3></CardHeader>
          <CardBody>
            <Stack gap={8}>
              <ArchGraph nodes={pipeline.nodes} edges={pipeline.edges} direction="vertical" />
              <Callout tone="info" title="两条路径的分工">
                <Text>
                  虚线回边是渲染结果回传：MoltenVK 渲染进 MTLBuffer（shm mmap，MTLStorageShared），
                  同一块物理页映射回 guest，CPU/GPU 页级共享，无需拷贝。呈现路径保持现有 2D KMS/scanout
                  （venus surfaceless 模式渲染进共享内存，再经现有 present 链刷屏）——与 card0
                  「提交即同步呈现」语义吻合，显示管线不动。
                </Text>
              </Callout>
            </Stack>
          </CardBody>
        </Card>
      </Stack>

      <Stack gap={8}>
        <H2>四、帧率目标</H2>
        <Card>
          <CardHeader><H3>raster 每帧耗时：现状 vs Venus 目标</H3></CardHeader>
          <CardBody>
            <Stack gap={8}>
              <BarChart
                title="raster 每帧耗时（ms）：llvmpipe 现状 vs Venus 目标"
                categories={["p50", "p95"]}
                series={[
                  { name: "llvmpipe 现状 (ms)", data: [91, 128] },
                  { name: "Venus 目标 (ms)", data: [3, 6] },
                ]}
              />
              <Text>
                口径：现状取 2026-09-13 dev tip 验证栈动画期 Dart 帧审计（raster_p50≈90.7ms、
                raster_p95≈127.6ms，占帧生产 97%，全部帧超 16.7ms 预算）；Venus 目标是
                Metal 直通后光栅化应回落到的量级（与 audit 各管线段小于 10ms 的内核路径同量级）。
                观测入口沿用{" "}
                <RepoFileLink
                  path="sop-run-starryos-denial-qemu.md"
                  label="SOP §3 的 dd.log 审计流程"
                />。
              </Text>
            </Stack>
          </CardBody>
        </Card>
      </Stack>

      <Stack gap={8}>
        <H2>五、三端缺口清单</H2>
        <Table
          headers={gapHeaders}
          rows={gapRows}
          columnAlign={gapColumnAlign}
          rowTone={gapRowTones}
        />
      </Stack>

      <Stack gap={8}>
        <H2>六、分阶段验证路线</H2>
        <Callout tone="success" title="关键发现：vtest 可免内核先验">
          <Text>
            mesa venus 驱动支持 vtest 模式（guest ICD 经 socket 连宿主 virgl_test_server --venus），
            完全绕过 guest 内核驱动。Phase 1 用很小的工作量先验证「宿主 MoltenVK 渲染 + guest venus
            ICD」两端是否真能跑通（同时证伪 darwin 后端成熟度风险），通过后再投入内核侧。
          </Text>
        </Callout>
        <Table
          headers={phaseHeaders}
          rows={phaseRows}
          columnAlign={phaseColumnAlign}
          rowTone={phaseRowTones}
        />
      </Stack>

      <Stack gap={8}>
        <H2>七、风险与未定项</H2>
        <Table
          headers={riskHeaders}
          rows={riskRows}
          columnAlign={riskColumnAlign}
          rowTone={riskRowTones}
        />
      </Stack>

      <Stack gap={8}>
        <H2>八、建议</H2>
        <Callout tone="success" title="按 Phase 0 → 1 先做免内核先验">
          <Text>
            Phase 0/1 工作量小、可证伪快（宿主 MoltenVK + virglrenderer-venus + guest ICD vtest 直连），
            通过后再投入 Phase 2 的 guest 内核 virtio-gpu DRM 3D 面实现；Phase 2 是唯一的大项，
            建议在 #2365（vblank 时钟）/#2393（card0 重置）上游合并、验证栈收敛后单独立项。
          </Text>
        </Callout>
        <Row gap={12}>
          <Text>
            相关：<RepoFileLink
              path="research-host-vulkan-acceleration.md"
              label="调研报告全文"
            />
            {" · "}
            <RepoFileLink
              path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs"
              label="card0 KMS 仿真"
            />
            {" · "}
            <RepoFileLink
              path="sop-run-starryos-denial-qemu.md"
              label="denial QEMU SOP"
            />
          </Text>
        </Row>
      </Stack>
    </Stack>
  );
}
