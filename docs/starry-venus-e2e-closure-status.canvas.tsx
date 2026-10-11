// venus/zink 加速桌面端到端闭环 — 现状与计划（第十一轮收官，2026-10-11）
// 上屏轮：scanout 黑屏根因闭合（vkr 把 LINEAR 改写 OPTIMAL → 渲染落 Metal
// 私有存储 → shm 恒零），linear tiling 直通后 venus 加速桌面历史首次上屏。
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

const blackChain = {
  nodes: [
    { id: "request", label: "guest 请求 LINEAR tiling" },
    { id: "rewrite", label: "vkr 改写为 OPTIMAL" },
    { id: "private", label: "渲染落 Metal 私有存储" },
    { id: "shmzero", label: "shm 背书内存恒零" },
    { id: "scanout", label: "scanout 读 shm 全黑" },
  ],
  edges: [
    { from: "request", to: "rewrite", label: "darwn shim 旧假设：MVK 无 linear" },
    { from: "rewrite", to: "private", label: "OPTIMAL = MTLTexture 私有存储" },
    { from: "private", to: "shmzero", label: "私有存储 ≠ 设备内存字节" },
    { from: "shmzero", to: "scanout", label: "BAR 映射与 pixman scanout 同源" },
  ],
};

const fixChain = {
  nodes: [
    { id: "keep", label: "vkr 停改写：DRM_MODIFIER→LINEAR" },
    { id: "texel", label: "MoltenVK texel buffer 路径" },
    { id: "write", label: "渲染像素写入 shm 字节" },
    { id: "visible", label: "BAR/scanout 直读可见" },
  ],
  edges: [
    { from: "keep", to: "texel", label: "renderLinearTextures=Apple GPU" },
    { from: "texel", to: "write", label: "_mtlTexelBuffer=shm 包装" },
    { from: "write", to: "visible", label: "Shared 存储零拷贝一致" },
  ],
};

const evidenceHeaders = ["证据", "取证方法", "结论"];
const evidenceAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const evidenceRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "success", "success",
];
const evidenceRows = [
  [
    "668 次 TEMP set_scanout_blob，`no mapped memory` 0 次",
    "上一轮 QEMU 日志全量复查",
    "scanout 绑定层完全正常（每次都引用到已映射内存）——黑屏在内容层",
  ],
  [
    "vkr_image.c 把 guest LINEAR/DRM_MODIFIER 一律改写 OPTIMAL",
    "源码审读 + 注释考古（旧假设：MoltenVK 无 linear）",
    "OPTIMAL 渲染落 Metal 私有 MTLTexture 存储，与 shm 字节无关",
  ],
  [
    "darwin 路径 HOST_VISIBLE 内存 = 匿名 shm + newBufferWithBytesNoCopy",
    "vkr_metal_helpers.m / vkr_device_memory.c 审读",
    "blob 导出 shm fd = guest BAR 映射 = pixman scanout 读取——恒零即黑",
  ],
  [
    "guest 本来就请求 LINEAR（smithay gbm [Linear] → zink 非 modifier 回退）",
    "deniald kms_state.rs + zink_resource.c + vkr 假扩展注入链审读",
    "把它变 OPTIMAL 的只有 vkr 改写，guest 零改动即可修复",
  ],
  [
    "MoltenVK 支持 linear 渲染：renderLinearTextures=supportsApple1（M4=true）",
    "MVKImage.mm validateLinear/bindDeviceMemory texel buffer 路径审读",
    "linear 图像渲染像素直接写入 shm 包装的 MTLBuffer",
  ],
  [
    "screendump distinct=45,498（第十轮恒 1）+ 时钟跨分钟走字",
    "QEMU monitor screendump + 逐像素统计 + 70s 间隔复测",
    "端到端上屏实锤：壁纸/时钟/顶栏组件全部正确，无剪切无花屏",
  ],
];

const closedHeaders = ["链条", "轮次", "处置", "状态"];
const closedAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];
const closedRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "success", "success", "success",
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
    "第十一轮",
    "vkr 停改写 LINEAR tiling（0b8b4914）：渲染写 shm 字节，scanout 直读",
    "已闭合",
  ],
  [
    "GPU timestamp 语义（4.8e12 µs 异常值；本轮 samples=0）",
    "第十一轮记录",
    "仅影响度量不影响出帧，zink 查询池采样行为待核对",
    "非阻塞待办",
  ],
];

const planItems = [
  {
    id: "r11-exclude",
    content: "排除「scanout 没建立」：上一轮 668 次 set_scanout_blob 零拒绝，绑定层正常——黑屏收敛到内容层",
    status: "completed" as const,
  },
  {
    id: "r11-root",
    content: "根因定性：vkr darwin shim 把 guest LINEAR/DRM_MODIFIER tiling 改写 OPTIMAL，渲染落 Metal 私有存储，shm 背书内存（BAR/scanout 同源）恒零",
    status: "completed" as const,
  },
  {
    id: "r11-fix",
    content: "修复（vkr 三处，guest 零改动）：vkCreateImage 停改写（仅 DRM_MODIFIER→LINEAR）；layout 查询对 linear 图像直通 MoltenVK；图像格式查询失败先按 LINEAR 重答",
    status: "completed" as const,
  },
  {
    id: "r11-verify",
    content: "端到端验证：screendump distinct=45,498、时钟 07:03→07:06 走字、deadline p50≈14.9–16.4ms 在预算内、missed_vblanks=0、心跳 4 分钟+、261+ flip 零 vkr fatal",
    status: "completed" as const,
  },
  {
    id: "r11-land",
    content: "落地：vkr 提交 0b8b4914（darwin-venus）；设计文档第十一轮补记 + AGENTS.md 记忆 + 本画布",
    status: "completed" as const,
  },
  {
    id: "r11-60hz",
    content: "60Hz 持续帧率实测（负载下）：桌面空闲为事件驱动稀疏帧 ~2s 一帧；raster_avg≈1.5–2.4ms（CPU 侧），linear 渲染的 GPU 侧成本待负载测量",
    status: "pending" as const,
  },
  {
    id: "r11-ts",
    content: "GPU timestamp 语义核对：本轮 gpu_render_samples=0（第十轮 28/43、4.8e12 µs 异常值），linear 下 zink 查询池采样行为待核对",
    status: "pending" as const,
  },
  {
    id: "r11-xway",
    content: "Xwayland 应用窗口渲染验证（X11 客户端经 GLX 走 libgallium-26.2.4 的路径上屏）",
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
    "venus-stack virglrenderer（darwin-venus）",
    <Code>0b8b4914</Code>,
    "第十一轮：vkr 停改写 LINEAR tiling——vkCreateImage 仅 DRM_MODIFIER→LINEAR；layout 对 linear 直通；格式查询回退链 LINEAR 优先",
  ],
  [
    "tgoskits 文档（local/venus-into-dev-0924）",
    <Code>本轮</Code>,
    "设计文档 §scanout 黑屏根因闭合 + AGENTS.md 第十一轮记忆 + 本画布",
  ],
  [
    "tgoskits 文档（第十轮）",
    <Code>231ff5bd6</Code>,
    "状态画布第十轮收官 + 内核取证（20be680bd：signal.rs / user.rs / mod.rs，+253/−8）",
  ],
  [
    "guest rootfs（denial-full 镜像，debugfs 注入）",
    <Code>—</Code>,
    "mesa 26.2.4 齐套（第十轮，本轮零改动）",
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
    "blob scanout 可见性判据（本轮核心教训）",
    "非 GL console 的零拷贝 scanout 读 shm 字节，被扫描图像必须「渲染写内存」——MoltenVK 上即 VK_IMAGE_TILING_LINEAR（texel buffer 背书，_mtlTexelBuffer=shm 包装的 MTLBuffer）；OPTIMAL 渲染只存在于 Metal 私有存储，对 BAR/scanout 永远不可见。「合成器侧有内容+屏幕黑」的组合首先怀疑宿主 tiling 改写",
  ],
  [
    "pitch 一致性",
    "linear 直通后 layout 查询返回 MoltenVK 真实 pitch（minimumLinearTextureAlignmentForPixelFormat 行对齐），guest 全链（gbm stride/ADDFB2/scanout）单一事实来源；256 对齐合成答案只给 OPTIMAL 遗留路径。当前几何（640/848 宽）两种口径一致，非 4 倍数宽度必须用直通答案",
  ],
  [
    "QEMU 日志判读口径",
    "TEMP set_scanout_blob 次数高且无 `no mapped memory` ⇒ scanout 绑定层健康，黑屏去内容层找（tiling/内存背书），不要先怀疑绑定",
  ],
  [
    "宿主重建口径",
    "改 vkr 只需 `ninja -C build-darwin && ninja install`：QEMU 动态链 prefix/lib/libvirglrenderer.1.dylib，render server=prefix/libexec/virgl_render_server 静态链，同树重建即一致，无需重编 QEMU/MoltenVK/guest",
  ],
  [
    "mesa 换代纪律（第十轮）",
    "libgallium 是版本化 SONAME 可多代共存；pipe_screen 无版本化 ABI，跨代共享即虚表错位。换 mesa 必须整套换（libGL/libGLES/libEGL/libgbm/gbm 后端/dri shims/libvulkan_virtio/drirc.d）并清掉旧代散落文件",
  ],
  [
    "内核崩溃取证 = guest ptrace 替代品（第十轮）",
    "warn 级一次性输出（comm/exe/PC/LR/全寄存器/指令字/映射表/栈字），一轮重启锁定「库内偏移+调用者」；aarch64 FP 链读 [fp]/[fp+8]，不要减 16",
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
      <H1>venus/zink 加速桌面 — scanout 黑屏根因闭合（上屏轮）</H1>
      <Text>
        第十一轮收官（2026-10-11，上屏轮）。第十轮闭合 Xwayland SIGSEGV 后，
        scanout 仍 100% 纯黑但内容在合成器侧存在。本轮先证伪「scanout 没建立」
        （668 次 set_scanout_blob 零拒绝，绑定层正常），再把黑屏收敛到内容层：
        vkr darwin shim 把 guest 请求的 LINEAR tiling 改写成 OPTIMAL，MoltenVK
        把渲染写进 Metal 私有 MTLTexture 存储，而 scanout 零拷贝直读的 shm
        背书内存恒零。修复只在宿主 vkr（提交 0b8b4914）——停改写 + layout
        直通 + 查询回退链——guest 内核与 rootfs 零改动。venus 加速桌面
        历史首次真实上屏。
      </Text>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="45,498" label="screendump distinct 色（第十轮恒 1）" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="历史首次" label="桌面真实上屏：壁纸/时钟/顶栏全正确" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="≈15ms" label="deadline_to_presentation_p50（16.6ms 预算内）" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="0 次" label="vkr fatal / ring 退出（261+ 次 flip）" tone="success" />
          </CardBody>
        </Card>
      </Grid>

      <Callout tone="success" title="本轮根因：vkr 的 tiling 改写让渲染永远到不了 scanout 读的内存">
        <Text>
          黑屏机制：deniald→smithay gbm 请求 [Modifier::Linear]，zink 因 vkr
          注入的假 VK_EXT_image_drm_format_modifier（modifier props 实为空）
          走「非 modifier LINEAR 回退」以 VK_IMAGE_TILING_LINEAR 调
          vkCreateImage（Flutter 的 dmabuf 导入经 ZINK_BIND_DMABUF 同样
          LINEAR）；vkr_image.c 的 darwin shim 把它改写成 OPTIMAL（旧假设：
          MoltenVK 无 linear 模式）。OPTIMAL 图像在 MoltenVK 上渲染进 Metal
          私有 MTLTexture 存储；而 darwin 路径所有 HOST_VISIBLE 内存都是
          匿名 shm + newBufferWithBytesNoCopy 包成的 Shared MTLBuffer，
          blob 资源导出的 shm fd = guest BAR 映射 = QEMU pixman scanout
          读取——渲染像素与这些字节永不相交，读出全零即黑。BAR 里「有壁纸
          的 atlas blob」是 deniald CPU 写入的 background blob，恰是对照。
        </Text>
      </Callout>

      <Grid columns={2} gap={12}>
        <Card>
          <CardHeader>
            <H2>黑屏链（本轮闭合）</H2>
          </CardHeader>
          <CardBody>
            <ArchGraph nodes={blackChain.nodes} edges={blackChain.edges} direction="vertical" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <H2>修复链（linear 直通）</H2>
          </CardHeader>
          <CardBody>
            <ArchGraph nodes={fixChain.nodes} edges={fixChain.edges} direction="vertical" />
            <Divider />
            <Text>
              MoltenVK 的 linear 支持一直在：validateLinear 接受 2D/单 mip/单
              layer BGRA8，renderLinearTextures = supportsApple1 在 M4 为
              true；bindDeviceMemory 对 linear 图像走 texel buffer 路径，
              _mtlTexelBuffer 直接取 shm 包装的 MTLBuffer——渲染像素写进
              shm 字节，BAR 映射与 scanout 同源可见。
            </Text>
          </CardBody>
        </Card>
      </Grid>

      <Card>
        <CardHeader>
          <H2>取证证据（第十一轮）</H2>
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
          <H2>第十一轮任务清单与下一步计划</H2>
        </CardHeader>
        <CardBody>
          <TodoListCard todos={planItems} />
          <Divider />
          <Callout tone="info" title="下一手：负载帧率与度量收尾">
            <Text>
              桌面已上屏且健康（present_callback≈424–760µs、
              deadline_to_presentation_p50≈14.9–16.4ms 在 16.6ms 预算内、
              missed_vblanks=0、Xwayland is ready display=:0）。空闲桌面为
              事件驱动稀疏帧（~2s 一帧，与 llvmpipe 时期同形态）；60Hz
              持续帧率需要负载实测（raster_avg≈1.5–2.4ms 为 CPU 侧，
              linear 渲染的 GPU 侧成本待测）。GPU timestamp 语义
              （gpu_render_samples 本轮 0，第十轮 28/43 与 4.8e12 µs 异常值）
              是仅剩的度量缺口，不影响出帧。
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
              设计文档（§scanout 黑屏根因闭合）：
              <FL path="design/starry-venus-into-dev-card0.md" label="docs/design/starry-venus-into-dev-card0.md" />
            </Text>
            <Text>
              项目记忆：
              <FL path="../AGENTS.md" label="AGENTS.md §3" />
            </Text>
            <Text>
              vkr 修复（venus-stack 树）：
              <FL
                path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_image.c"
                label="venus/vkr_image.c"
              />
              {" / "}
              <FL
                path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_physical_device.c"
                label="venus/vkr_physical_device.c"
              />
            </Text>
            <Text>
              内核 fence 注册表（第七轮，本轮零改动）：
              <FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" label="pseudofs/dev/vgpu.rs" />
            </Text>
            <Text>
              e2e 启动：
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
        <Pill active>第十一轮收官</Pill>
        <Pill>scanout 黑屏根因闭合</Pill>
        <Pill>linear tiling 直通</Pill>
        <Pill>桌面首次上屏</Pill>
        <Pill>Xwayland ready + 心跳健康</Pill>
      </Row>
      <Text>
        状态基调：黑屏三层结构全部剥完——Xwayland 崩溃层（第十轮）、GPU 通道层
        （第七至九轮）、池缓冲可见性层（本轮：vkr tiling 改写）均已闭合；端到端
        「GPU 渲染 → zink venus → ring → MoltenVK（linear texel buffer over
        shm）→ 内核 blob scanout → QEMU pixman → 屏幕」全链贯通。剩余为度量
        收尾（负载帧率、GPU timestamp 语义）与 Xwayland 应用窗口渲染验证。
      </Text>
    </Stack>
  );
}
