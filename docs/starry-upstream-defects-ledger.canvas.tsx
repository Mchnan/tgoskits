// venus/darwin 栈上游缺陷总账（第十一轮末梳理，2026-10-11）
// 两侧栈（darwin 宿主渲染链 + StarryOS guest）各轮定位的上游库缺陷、
// 证据轮次与修复落点。配套：docs/design/starry-venus-into-dev-card0.md、AGENTS.md §3。
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

const stackGraph = {
  nodes: [
    { id: "cocoa", label: "Cocoa 窗口" },
    { id: "qemu", label: "QEMU blob scanout" },
    { id: "vgpu", label: "card0/vgpu KMS" },
    { id: "deniald", label: "deniald+zink" },
    { id: "ring", label: "venus ring" },
    { id: "vkr", label: "vkr (virglrenderer)" },
    { id: "mvk", label: "MoltenVK/Metal" },
  ],
  edges: [
    { from: "mvk", to: "vkr", label: "shm MTLBuffer" },
    { from: "vkr", to: "ring", label: "ring 解析" },
    { from: "ring", to: "deniald", label: "EXECBUFFER" },
    { from: "deniald", to: "vgpu", label: "ADDFB2/flip" },
    { from: "vgpu", to: "qemu", label: "SET_SCANOUT_BLOB" },
    { from: "qemu", to: "cocoa", label: "dpy_gfx_update" },
  ],
};

const ledgerHeaders = ["缺陷", "轮次", "修改方式", "状态"];
const ledgerAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left", "left"];

const mvkHeaders = ledgerHeaders;
const mvkRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "success", "warning", "warning",
];
const mvkRows = [
  [
    "1.4.2 捆绑 SPIRV-Cross 缺 \"sampler\" 保留字（上游 main aa217aeb 已含）：skia uniform 遮蔽 MSL sampler 类型，Shader library compile failed，pipeline 全拒并连带 ring 卡点",
    "第八→九轮",
    "带完整 Xcode 的机器用上游 main 重建 MoltenVK（67b2682，fetchDependencies 拉 SPIRV-Cross pin），换装后错误归零",
    "已闭合",
  ],
  [
    "\"MoltenVK 无 linear 模式\"是错误假设：renderLinearTextures = supportsApple1 在 Apple GPU 为真，linear 图像走 texel buffer 直接写设备内存字节；OPTIMAL 渲染落 Metal 私有 MTLTexture 存储，对 BAR/scanout 永不可见（R11 黑屏的语义基础）",
    "第十一轮",
    "vkr 停改写 LINEAR tiling（0b8b4914）：渲染像素直接落 shm 字节，scanout 零拷贝可见",
    "已闭合",
  ],
  [
    "vkGetImageSubresourceLayout 对 OPTIMAL 图像返回垃圾（64 宽 BGRA 报 rowPitch=258）",
    "第八轮",
    "vkr 对 OPTIMAL 图像合成 256 对齐线性答案；linear 直通后真实图像走 MoltenVK 原生答案（pitch 单一事实来源）",
    "已闭合",
  ],
  [
    "缺 VK_EXT_image_drm_format_modifier；对不认识的 external-memory handle 类型（dma-buf）直接 FEATURE_NOT_PRESENT 拒绝 vkCreateImage/vkAllocateMemory",
    "第八轮",
    "vkr 向 guest 注入假扩展 + 创建时剥离 modifier/external-memory 结构；导出在资源层由 shm blob 满足",
    "已闭合",
  ],
  [
    "ICD 部署劫持：DYLD_LIBRARY_PATH 含 /opt/homebrew/lib 时 loader 对 @rpath/libMoltenVK.dylib 的解析落到 brew 1.4.2——此前所有「换装验证」都跑在被劫持的旧版上",
    "第九轮",
    "dylib 复制到 prefix/lib 用 install_name_tool 改唯一 install name + ad-hoc codesign，ICD json 指绝对路径；换装验证必须核对日志 MoltenVK version 行",
    "已闭合",
  ],
  [
    "M4 无 D24_UNORM_S8_UINT（vkGetPhysicalDeviceFormatProperties optimal=0）→ Impeller stencil 附加失败 GL_FRAMEBUFFER_UNSUPPORTED(0x8CD6)",
    "第四轮",
    "deniald 弃 Impeller 改 skia 路径（GL 组合上 MoltenVK 无此深度格式属硬件能力缺口）",
    "已闭合（绕过）",
  ],
  [
    "zink-venus GPU timestamp 语义异常：4.8e12 µs 量级（第十轮），linear 直通后 gpu_render_samples=0（第十一轮）",
    "第十→十一轮",
    "仅影响度量不影响出帧；zink 查询池路径与 MVK timestamp 单位核对待办",
    "待办",
  ],
];

const vkrRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success",
];
const vkrRows = [
  [
    "偶发 INITIALIZATION_FAILED(-3) 拒绝 vkCreatePipelineCache/vkCreateGraphicsPipelines，而 mesa venus vn_async_* fire-and-forget 不读响应 → 宿主静默不加对象 → guest 幽灵句柄 → 查表 fatal → ring 死（exiting ret=-22）→ deniald 全线静默",
    "第七轮",
    "vkr 兼容层：创建失败绑 null stub（cache 直接绑；pipeline 先去 cache 重试再 stub，stub 先捕获 guest id）、BindPipeline null 跳过、无 pipeline 的 draw/dispatch 跳过；内核 out-syncobj 推迟到宿主 fence retire",
    "已闭合",
  ],
  [
    "第二次 vkCreatePipelineCache（去 cache 重试路径）把 ring 线程卡死在驱动调用内部，持 queue vk_mutex 堵死 sync 线程与 fence retire（~6s phase=1000 冻结）",
    "第八轮",
    "禁用 retry（cache/pipeline 失败直接 null stub）——与 R9 重建后未再复现互证「卡点同源」",
    "已闭合",
  ],
  [
    "darwin shim 把 guest 请求的 LINEAR/DRM_MODIFIER tiling 一律改写 OPTIMAL（旧假设：MVK 两者都不支持）——渲染写 Metal 私有存储，shm 背书内存（guest BAR 映射与 pixman scanout 同源）恒零，scanout 黑",
    "第十一轮",
    "0b8b4914：仅 DRM_MODIFIER→LINEAR、停改写 LINEAR；layout 查询对 linear 直通（texel buffer 真实 pitch）；图像格式查询失败先按 LINEAR 配置重答",
    "已闭合",
  ],
  [
    "macOS 无 dma-buf/udmabuf：Vulkan external memory 体系没有可用的宿主传递通道",
    "第八轮起（基建）",
    "vkr_metal_helpers：HOST_VISIBLE 内存 = 匿名 shm + newBufferWithBytesNoCopy 包 Shared MTLBuffer；blob 资源导出 shm fd；导入侧对同一 shm 再包 MTLBuffer（无拷贝，共享物理页）",
    "已闭合（基建）",
  ],
];

const qemuRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "success", "success",
];
const qemuRows = [
  [
    "hvf：未对齐 memory section 直接 abort 整个虚拟机",
    "早期",
    "accel/hvf 跳过未对齐段（7109d5e）",
    "已闭合",
  ],
  [
    "MAP_RESOURCE_BLOB 的 MAP_FIXED 快路径用 mmap(MAP_FIXED) 换宿主RAM 块底下的页，hvf memory listener 永不知情 → EPT 继续指向孤儿页，guest 读写错位内存（KVM 有 mmu_notifier，hvf 无等价物）",
    "第八轮前",
    "禁用 MAP_FIXED 快路径，恒走 MR-subregion（listener 可见）路径（a8dd183）",
    "已闭合",
  ],
  [
    "virtio-gpu 的 opengl.found() 外层门 + dmabuf 假设把 venus-only 构建（无 epoxy EGL、macOS 无 udmabuf）的扫描输出全砍成 'Display output is not active.'",
    "第八轮前",
    "去 opengl 外层门（c9ce8a2/910b803）+ 非 GL console 的 pixman 零拷贝 blob scanout：DisplaySurface 原地引用 blob 内存（a8dd183）",
    "已闭合",
  ],
  [
    "blob flip 无逐帧 flush 命令（guest 直接 page flip）且设备 gfx_update 钩子为空 → UI 永远收不到 dpy_gfx_update → Cocoa 只换 pixman 指针不重绘，窗口冻结在黑帧（screendump 直读内存却一直有内容）",
    "本会话",
    "virgl_cmd_set_scanout_blob 成功后补 dpy_gfx_update_full（877291d），每次 flip 通知 UI",
    "已闭合",
  ],
  [
    "Cocoa：resizeWindow 非可调分支 ÷backingScaleFactor 把 640x480 压成 320x240 点，contentView frame 变化又静默重置 view bounds → drawRect 以 320 坐标系对 640 图像做裁剪 → 桌面下半部放大 2 倍（时钟被裁掉）",
    "本会话",
    "bounds 不变量（a7990fb）：resizeWindow 尾部统一 updateBounds + setFrameSize override 实时重申；非可调窗口按 guest 原生点尺寸开窗",
    "已闭合",
  ],
  [
    "virtio_gpu_ui_info 把窗口派生宽高（点 × backing scale）写进 req_state → GET_DISPLAY_INFO pmode 与 EDID 首选模式随窗口漂移，guest 池缓冲按漂移模式分配",
    "本会话",
    "钉死模式（1961a80）：ui_info 只留 offset/refresh/物理尺寸，模式恒为 xres/yres（固定面板语义）；启动脚本显式 xres=1280,yres=800",
    "已闭合",
  ],
];

const mesaRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "warning",
];
const mesaRows = [
  [
    "mesa 栈混装：libgallium 是版本化 SONAME（libgallium-<ver>.so）可多代共存，但 pipe_screen 无版本化 ABI——25.2.7 建的 screen 被 26.2.3 按 +0x6c0 调 is_format_supported，同偏移实为 resource_from_memobj → SIGSEGV@VA:0x15c；桥接实体是 SONAME 撞名的双份 dril shim（musl dlopen 先到先得）",
    "第十轮",
    "统一 mesa 栈到 edge 26.2.4 齐套（libGL/libGLES/libEGL/libgbm/gbm 后端/dri shims/libvulkan_virtio/drirc.d）并清掉旧代散落文件；换代纪律：必须整套换+清旧代",
    "已闭合",
  ],
  [
    "zink 在缺 VK_EXT_image_drm_format_modifier 时静默丢弃 modifier 列表（resource_create 只在 have_EXT 时保留 res->modifiers）——gbm 请求的 [LINEAR] modifier 可能被无声忽略",
    "第十一轮（定性）",
    "本栈靠 vkr 注入假扩展 + zink 非 modifier LINEAR 回退兜住；上游行为已记录，未改 mesa 源",
    "已闭合（绕过）",
  ],
  [
    "venus vn_async_* fire-and-forget 不读宿主响应：宿主创建失败时 guest 持幽灵句柄",
    "第七轮",
    "宿主 vkr 侧兼容（null stub）兜住；未改 mesa",
    "已闭合（绕过）",
  ],
  [
    "gbm dri：GBM_BO_USE_RENDERING 不映射到 dri_use 标志（RENDER_TARGET bind 由 is_format_supported 探测补齐）；26.2.4 GPU timestamp 与 zink 查询池行为待核对",
    "第十一轮",
    "记录在案",
    "待办",
  ],
];

const pkgRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "success", "warning",
];
const pkgHeaders = ["缺陷", "轮次", "修改方式", "状态"];
const pkgRows = [
  [
    "smithay GbmAllocator：create_with_modifiers2 失败且 modifiers 含 Linear/Invalid 时，静默回退到无 modifier 的 gbm_bo_create（隐式 tiling）——调用方以为拿到 LINEAR 实则拿到驱动自选布局",
    "第十一轮（定性）",
    "本栈未实际触发（vkr 假扩展让 modifiers 路径成功）；作为 modifier 断链风险记录在案",
    "已闭合（记录）",
  ],
  [
    "denial Flutter fork：GL fbo zero-is-no-target 语义缺失，引擎在 ext-view 之后、present 之前整体放弃出帧（frames=0 永久）",
    "第五→六轮",
    "--denial-gl-fbo-zero-is-no-target 无条件传递（Phase 42），present 回调复活（present_callback 790µs 基线）",
    "已闭合",
  ],
  [
    "ext4 journal 回放会吞掉 debugfs 注入的文件（挂载即回放）",
    "第六轮",
    "注入前 tune2fs -O ^has_journal 移除 journal",
    "已闭合",
  ],
  [
    "libdrm 升级覆盖：镜像内符号链接指 131 文件名，2.4.134 内容必须写进 131 文件名而不是新增文件",
    "第六轮",
    "覆盖式注入 + MD5 回读",
    "已闭合",
  ],
  [
    "busybox wget --post-file 把 URL 基名当响应体落盘：/tmp/snap 残留后后续 POST 全部 File exists 失败",
    "第九→十轮",
    "e2e watcher 每次 POST 前同时清 /tmp/snap 与 /root/snap（CWD 在 /root）",
    "已闭合",
  ],
  [
    "lwprintf-rs build.rs 依赖 Linux gcc 生成本机绑定：loongarch64/riscv64 的内核 clippy 在 macOS 无法运行（aarch64 由 axbuild deny-warnings 覆盖）",
    "第一轮起（基线）",
    "已知环境缺口，构建口径以 aarch64 为准",
    "基线缺口",
  ],
];

const uapiHeaders = ["语义点（本仓对齐，非上游 bug）", "轮次", "处理"];
const uapiAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const uapiRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "success", "success", "success", "success",
];
const uapiRows = [
  [
    "DRM_CAP_SYNCOBJ_TIMELINE 必须等于用户态编译所对 UAPI 头的值（0x14）：凭记忆写错值会让 mesa 静默降级 sync-file 路径，EXECBUFFER 在 venus 上必 DEVICE_LOST",
    "第一轮",
    "对齐 0x14 并记录「与头一致」纪律",
  ],
  [
    "RESOURCE_CREATE_BLOB 结构需带 v6.15 的 blob_hints 尾部——ioctl 号编码结构大小，旧 48B 布局的编号落不进 handler",
    "第一轮",
    "按 v6.15 UAPI 补齐",
  ],
  [
    "syncobj 挂在 VgpuFd 上要求 CONTEXT_INIT → 无 context fd 的 CREATE 必 EINVAL；SYNCOBJ_EVENTFD 缺失让 mesa sync provider 全面回退",
    "第二轮",
    "挪独立 per-fd 表 + 实现 EVENTFD + HANDLE_TO_FD 24B 带点导出/导入",
  ],
  [
    "legacy DRM_IOCTL_MODE_ADDFB(0xAE) 缺失：zink gbm 走 legacy 入口直接 ENOTSUP 打死 deniald；PRIME 跨 fd 导入需要别名语义",
    "第三轮",
    "合成 ADDFB2 走同一核心；PRIME_FD_TO_HANDLE 克隆资源条目（同宿主资源/新 GEM 句柄）",
  ],
  [
    "out-syncobj 在 submit 时即置位会让 guest 越过宿主 retire、lap venus ring 损坏命令流",
    "第七轮",
    "推迟到宿主 fence retire 置位 + orphan_ids 竞态暂存",
  ],
  [
    "axdisplay 28 个入口裸解引用未初始化的 MAIN_DISPLAY → venus-only 下 deniald 一启动就内核 panic",
    "第二轮",
    "全部判空降级（info 零尺寸占位/flush false/NotAvailable）",
  ],
  [
    "card0 display_resolution() 在 venus-only（无 2D display 设备）时落到 640x480 兜底，钉死桌面分辨率",
    "本会话",
    "优先取 3D face 的 GET_DISPLAY_INFO pmode（a20d3a5a0），对齐宿主 xres/yres=1280x800",
  ],
  [
    "Xwayland 装 SIGSEGV handler 会吞掉「投递终止才 dump」的崩溃取证路径",
    "第十轮",
    "handle_user_page_fault 在 force-deliver 前一次性 dump（per-process 代），无视 disposition（20be680bd）",
  ],
];

const pendingItems = [
  {
    id: "ts",
    content: "26.2.4 zink-venus GPU timestamp 语义核对（4.8e12 µs 异常值 / gpu_render_samples=0，仅影响度量）",
    status: "pending" as const,
  },
  {
    id: "60hz",
    content: "1280x800 下负载 60Hz 帧率实测与 deadline 预算稳定性（linear 渲染 2.67x 像素的 GPU 侧成本）",
    status: "pending" as const,
  },
  {
    id: "xway",
    content: "Xwayland 应用窗口渲染验证（X11 客户端经 GLX/libgallium-26.2.4 路径上屏）",
    status: "pending" as const,
  },
  {
    id: "offscreen",
    content: "offscreen-blit 模式的 gbm modifier 断链（create_with_modifiers2 EINVAL + smithay 静默回退）如需启用需先补内核 modifier 语义",
    status: "pending" as const,
  },
];

export default function UpstreamDefectsLedger(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>venus/darwin 栈上游缺陷总账</H1>
      <Text>
        十一轮 + 本会话在两侧栈（darwin 宿主渲染链、StarryOS guest）定位到的全部上游库
        缺陷与修复方式，按组件分账。证据与逐环实证见
        <FL path="design/starry-venus-into-dev-card0.md" label=" 设计文档" />
        {" "}与 <FL path="../AGENTS.md" label="AGENTS.md §3 项目记忆" />；
        本页是横向对账视图。
      </Text>

      <Grid columns={4} gap={12}>
        <Card><CardBody><Stat value="9 类" label="涉及上游组件（MVK/SPV-Cross/vkr/QEMU/mesa/smithay/Flutter/打包/工具链）" tone="info" /></CardBody></Card>
        <Card><CardBody><Stat value="24 项" label="缺陷与语义缺口入账" tone="info" /></CardBody></Card>
        <Card><CardBody><Stat value="20 项" label="已闭合（含绕过与基建）" tone="success" /></CardBody></Card>
        <Card><CardBody><Stat value="4 项" label="待办（度量/验证类，无阻塞）" tone="warning" /></CardBody></Card>
      </Grid>

      <Card>
        <CardHeader><H2>栈层与缺陷热点（渲染数据流）</H2></CardHeader>
        <CardBody>
          <ArchGraph nodes={stackGraph.nodes} edges={stackGraph.edges} direction="vertical" />
          <Divider />
          <Text>
            读法：每层都改过宿主侧补丁——MoltenVK 重建与 tiling 语义（vkr 改写曾把渲染
            送进 Metal 私有存储）、vkr 创建失败兼容层与 shm 基建、QEMU blob scanout
            三连（pixman 路径/UI 刷新/模式钉死）、Cocoa bounds 不变量、内核 card0 的
            UAPI 对齐与分辨率来源。命令流（zink → ring → vkr → MVK）与数据流在此汇合：
            渲染必须落进「scanout 直读的那份内存」，任何一层把它引去别处就是黑屏。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H3>MoltenVK / SPIRV-Cross（宿主 GPU 驱动）</H3></CardHeader>
        <CardBody>
          <Table headers={mvkHeaders} rows={mvkRows} columnAlign={ledgerAlign} rowTone={mvkRowTones} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H3>virglrenderer / vkr（宿主 venus 渲染器，darwin-venus 本地栈）</H3></CardHeader>
        <CardBody>
          <Table headers={ledgerHeaders} rows={vkrRows} columnAlign={ledgerAlign} rowTone={vkrRowTones} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H3>QEMU（virtio-gpu / hvf / Cocoa，darwin-venus 分支）</H3></CardHeader>
        <CardBody>
          <Table headers={ledgerHeaders} rows={qemuRows} columnAlign={ledgerAlign} rowTone={qemuRowTones} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H3>mesa（guest 26.2.4：gbm / zink / venus）</H3></CardHeader>
        <CardBody>
          <Table headers={ledgerHeaders} rows={mesaRows} columnAlign={ledgerAlign} rowTone={mesaRowTones} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H3>smithay / Flutter fork / 打包与工具链</H3></CardHeader>
        <CardBody>
          <Table headers={pkgHeaders} rows={pkgRows} columnAlign={ledgerAlign} rowTone={pkgRowTones} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H3>guest 内核 UAPI 对齐账（本仓修复的 Linux 语义缺口）</H3></CardHeader>
        <CardBody>
          <Table headers={uapiHeaders} rows={uapiRows} columnAlign={uapiAlign} rowTone={uapiRowTones} />
          <Divider />
          <Text>
            这一节不是上游缺陷，而是把 card0/vgpu 对齐 Linux virtio-gpu + DRM UAPI
            语义时踩到的每一处「差一点就静默失败」的点；实现集中在
            <FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" label=" vgpu.rs" />
            {" "}、<FL path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" label="card0.rs" />
            {" "}与 <FL path="../drivers/gpu/virtio-gpu/src/lib.rs" label="drivers/gpu/virtio-gpu" />。
          </Text>
        </CardBody>
      </Card>

      <Callout tone="info" title="横切教训（跨缺陷复用的判据）">
        <Stack gap={6}>
          <Text>
            一、可见性判据：非 GL console 的零拷贝 scanout 读的是「渲染写内存」的那份字节——
            MoltenVK 上即 LINEAR tiling（texel buffer 背书）；OPTIMAL 渲染在 Metal 私有
            存储，对 BAR/scanout 永不可见。「合成器侧有内容 + 屏幕黑」先查 tiling 改写与
            内存背书，再查绑定层。
          </Text>
          <Text>
            二、判定口径：QEMU TEMP set_scanout_blob 次数高且无 no mapped memory ⇒ 绑定层
            健康，黑屏去内容层找；screendump（读 surface 内存）与 Cocoa 窗口（等
            dpy_gfx_update 通知才重绘）是两条路，取证有内容不代表窗口会动。
          </Text>
          <Text>
            三、版本纪律：mesa 整套换代并清旧代散落文件（pipe_screen 无版本化 ABI，混装即
            虚表错位）；换 ICD 必须核对日志的 MoltenVK version 行（@rpath 劫持教训）；
            DRM UAPI 值必须与用户态编译所对的内核头一致。
          </Text>
          <Text>
            四、hvf 与 KVM 的差异：MAP_FIXED 换页、未对齐 memory section 都没有
            mmu_notifier 兜底，一切内存变更必须走 memory listener 可见的路径。
          </Text>
          <Text>
            五、fire-and-forget 的代价：venus 异步创建不读响应，宿主任何「拒绝创建」都会
            变成 guest 幽灵句柄——宿主兼容层（null stub）必须先捕获 guest id 再失败。
          </Text>
        </Stack>
      </Callout>

      <Card>
        <CardHeader><H3>待办（无阻塞，度量与验证类）</H3></CardHeader>
        <CardBody>
          <TodoListCard todos={pendingItems} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H3>修复落点索引</H3></CardHeader>
        <CardBody>
          <Stack gap={6}>
            <Text>
              vkr（0b8b4914 linear 直通）：
              <FL path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_image.c" label="venus/vkr_image.c" />
              {" / "}
              <FL path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_physical_device.c" label="vkr_physical_device.c" />
              {" / "}
              <FL path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_device_memory.c" label="vkr_device_memory.c" />
            </Text>
            <Text>
              QEMU（877291d UI 刷新 / a7990fb cocoa bounds / 1961a80 模式钉死 / a8dd183 pixman scanout+MAP_FIXED）：
              <FL path="/Users/herbcheng/venus-stack/src/qemu/hw/display/virtio-gpu-virgl.c" label="virtio-gpu-virgl.c" />
              {" / "}
              <FL path="/Users/herbcheng/venus-stack/src/qemu/ui/cocoa.m" label="ui/cocoa.m" />
              {" / "}
              <FL path="/Users/herbcheng/venus-stack/src/qemu/hw/display/virtio-gpu-base.c" label="virtio-gpu-base.c" />
            </Text>
            <Text>
              内核（a20d3a5a0 分辨率来源 / 20be680bd 崩溃取证 / 6678a8b2a venus 面接装）：
              <FL path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" label="card0.rs" />
              {" / "}
              <FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" label="vgpu.rs" />
              {" / "}
              <FL path="../drivers/gpu/virtio-gpu/src/lib.rs" label="drivers/gpu/virtio-gpu" />
            </Text>
            <Text>
              启动与取证：
              <FL path="/Users/herbcheng/venus-stack/qstart-denial-e2e.sh" label="qstart-denial-e2e.sh" />
              {" / "}
              <FL path="/Users/herbcheng/venus-stack/e2e-run.sh" label="e2e-run.sh" />
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Row gap={8}>
        <Pill active>第十一轮末总账</Pill>
        <Pill>宿主侧 17 项闭合</Pill>
        <Pill>内核 UAPI 8 项对齐</Pill>
        <Pill>桌面 1280x800 上屏</Pill>
        <Pill>待办均为度量类</Pill>
      </Row>
    </Stack>
  );
}
