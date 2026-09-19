import {
  Stack, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Stat, Callout, Code, Divider, ArchGraph,
  FileLink, useCanvasAction,
  type TableRowTone,
} from "cursor/canvas";

function FL({ path, label }: { path: string; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} label={label} dispatch={dispatch} />;
}

// ---- 加速链路 DAG：guest ICD → 宿主 MoltenVK，环上标注本轮修复点 ----
const chain = {
  nodes: [
    { id: "app", label: "deniald/vkprobe" },
    { id: "loader", label: "libvulkan" },
    { id: "icd", label: "venus ICD" },
    { id: "card0", label: "card0 DRM" },
    { id: "vgpu", label: "virtio-gpu 3D" },
    { id: "vkr", label: "QEMU vkr" },
    { id: "mvk", label: "MoltenVK" },
    { id: "m4", label: "Apple M4" },
  ],
  edges: [
    { from: "app", to: "loader", label: "vkCreate" },
    { from: "loader", to: "icd", label: "dlopen ICD" },
    { from: "icd", to: "card0", label: "renderD128" },
    { from: "card0", to: "vgpu", label: "VIRTGPU_*" },
    { from: "vgpu", to: "vkr", label: "ctrl vq" },
    { from: "vkr", to: "mvk", label: "render server" },
    { from: "mvk", to: "m4", label: "dispatch" },
    { from: "vkr", to: "vgpu", label: "乱序配对已修", tone: "back" as const },
  ],
};

// ---- 交付提交 ----
const commitHeaders = ["提交", "内容"];
const commitRows: (string | JSX.Element)[][] = [
  [
    <Code>24652697e feat(starry-kernel)</Code>,
    "card0 面补齐 mesa venus ICD 契约：驱动身份、sysfs render 节点、syncobj 族、EXECBUFFER 语义 + 悬垂 GlobalPage 修复（6 files, +340/-37）",
  ],
  [
    <Code>5f41676a6 fix(virtio-gpu)</Code>,
    "drain_completed 按 token 轮转匹配乱序响应 + fenced 条目独立 recv 缓冲——shmem pool blob 118s 超时/设备粘性 broken 的根因",
  ],
  [
    <Code>dc609f0e1 feat(starry-kernel)</Code>,
    "CONTEXT_INIT 替换语义（解除 pid 复用楔死）+ PRIME blob fd 导出（VgpuBlobFd，deniald gbm/EGL 导出路径）",
  ],
  [
    <Code>e0c96b73 vkr(darwin)</Code>,
    "宿主 shim：nullDescriptor 强制 + dma-buf 可导出（MoltenVK 能力缺口，zink 得以初始化）",
  ],
];

// ---- 内核改动五面 ----
const kernelHeaders = ["改动面", "内容", "为什么必须"];
const kernelTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success", "danger",
];
const kernelRows: (string | JSX.Element)[][] = [
  [
    "驱动身份",
    "DRIVER_NAME → virtio_gpu，VERSION_MAJOR → 0",
    "mesa virtgpu_open_device 校验 name==virtio_gpu 且 major==0，否则 VK_ERROR_INITIALIZATION_FAILED",
  ],
  [
    "sysfs render 节点",
    "renderD128 三处视图 + platform uevent MODALIAS + <device>/drm/ 目录组",
    "libdrm drmGetDevices2 枚举链的硬依赖；缺 device/drm 组则全部节点被静默丢弃（本轮最深坑）",
  ],
  [
    "syncobj 族",
    "补 SYNCOBJ_WAIT(0xC3) + DRM_CAP_SYNCOBJ/TIMELINE",
    "mesa util_sync_provider_drm 以 TIMELINE cap 决定走内核 syncobj，否则 userspace 模拟在真 GPU 上死锁",
  ],
  [
    "EXECBUFFER 语义",
    "允许 size==0（ring kick）且每次提交恒带 fence；空 payload 不进 DMA 描述符",
    "Linux 无条件分配 out-fence；venus 宿主对 SUBMIT_3D 响应一律推迟到 retire，unfenced 同步等待实测必超时（Gpu3DError(62)）",
  ],
  [
    "悬垂 GlobalPage 修复",
    "cmd_page 绑定提升到函数作用域",
    "重构时 if/else 内层 shadow 持有页、Some(slice) 存裸指针，块结束即析构——cs 全零发给宿主，恰解码成 command type 0 = vkCreateInstance（协议巧合掩盖真相一整轮）",
  ],
];

// ---- vkprobe 进度矩阵 ----
const probeHeaders = ["链路段", "状态", "证据"];
const probeTones2: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success",
  "success", "success", "success", "success",
];
const probeRows: (string | JSX.Element)[][] = [
  ["ICD 加载", "通过", "VK_LOADER_DEBUG 确认 dlopen libvulkan_virtio.so，vkCreateInstance 真实例"],
  ["设备枚举", "通过", "drmGetDevices2 → Virtio-GPU Venus (Apple M4)，vendor 0x106b，mesa 26.2.2"],
  ["实例参数", "通过", "GETPARAM×6（3D/blob/host-visible/context-init…）全绿"],
  ["上下文", "通过", "GET_CAPS(capset 4) + CONTEXT_INIT → starry-vgpu-{pid}（替换语义修复后不再楔死）"],
  ["ring 建立", "通过", "ring blob 135K 创建/MAP；宿主 vkr_ring_start 成功、线程 entered"],
  ["shmem pool blob", "通过", "乱序配对修复后 RESOURCE_CREATE_BLOB(1MB) 即时返回（此前自旋 118s 超时）"],
  ["compute + fence", "通过", "vkQueueSubmit → timeline syncobj → vkWaitForFences VK_SUCCESS"],
  ["读回 4/4", "通过", "readback 0xc0de0000-3 全 MATCH；bar-pattern（BAR 写读回环）MATCH；两次复验"],
];

// ---- 本轮坑 ----
const pitHeaders = ["坑", "现象", "定锤手法与修复"];
const pitTones2: Array<TableRowTone | undefined> = ["danger", "danger", "warning", "warning", "warning"];
const pitRows: (string | JSX.Element)[][] = [
  [
    "device/drm 目录组缺失",
    "libdrm 前置全绿但 ICD 枚举恒 0 设备、零 ioctl 到达 card0",
    "mini-strace 抓到每节点一次 newfstatat(/sys/dev/char/226:X/device/drm)=-2——2.4.131 drmNodeIsDRM 的 Linux 分支 stat 该路径；内核补 <device>/drm/ 组后枚举瞬间通过",
  ],
  [
    "悬垂 GlobalPage",
    "宿主报 vkCreateInstance CS error；内核 cs 转储全零",
    "pre-copy 直读用户 VA（正确字节）+ 拷贝后回读（全零）对照定锤；修复 = GlobalPage 提升作用域",
  ],
  [
    "debugfs 注入分叉",
    "dump 校验通过且 e2fsck 干净，guest 仍 ENOENT / size 0",
    "覆盖写与追加写都会让 guest ext4 视图与宿主 debugfs 分叉；迭代探针改走 guest wget http://10.0.2.2:8000（宿主 http.server + slirp），一次解决",
  ],
  [
    "debugfs symlink 参数序",
    "两个 .so 符号链接从未建出，vkprobe 重定位全失败",
    "语义是 symlink <文件名> <目标>，与 ln 相反；按正确序重建后链接生效",
  ],
  [
    "对照实验自污染",
    "csblob 垃圾 cs 使 vkr 上下文 fatal，随后的 vkprobe 无辜受害",
    "vkr 对未知 opcode 报 CS error 并毒化上下文；垃圾注入实验与 vkprobe 必须分 boot 会话跑",
  ],
];

// ---- Phase 4.2 待办 ----
const nextHeaders = ["方向", "说明"];
const nextTones: Array<TableRowTone | undefined> = ["warning", "warning", "neutral", "neutral"];
const nextRows: (string | JSX.Element)[][] = [
  [
    "fence 语义缺口",
    "本栈 fence 在宿主派发命令时 retire（vkr ring fence 语义），不覆盖 Metal 实际完成；首次管线编译期间 vkWaitForFences 提前返回。需 vkr fence 线程接 MoltenVK 完成回调后推进 shmem timeline",
  ],
  [
    "mesa gbm-zink-venus 缓冲路径",
    "zink screen 已初始化（nullDescriptor/dma-buf shim 生效、gbm_create_device OK），但 gbm_bo_create 在 mesa 内部 EINVAL（strace 无 ioctl 到内核）——Phase 4.2 deniald 桌面的当前阻塞点，属 mesa 用户态集成",
  ],
  [
    "TEMP 探针移除",
    "内核 TEMP-PROBE（card0 逐 ioctl + vgpu pre-copy cs 转储）与 vkr TEMP 日志在 Phase 4.2 启动前移除",
  ],
  [
    "deniald zink 桌面",
    "gbm/EGL 链打通后目标 raster_avg 87–127ms → <5ms；渲染审计（DENIA_RENDER_AUDIT）在无截屏窗口采集",
  ],
];

export default function VenusPhase4Canvas(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 24 }}>
      <H1>venus Phase 4：deniald venus ICD 集成 — vkprobe 端到端闭环</H1>
      <Text>
        2026-09-19。分支 fix/card0-vblank-clock。路线定案：denial embedder 是
        OpenGL-only（FlutterRendererType_kOpenGL，Impeller 走 GLES），deniald
        零改动；加速链 = mesa zink（GL）→ venus ICD（Vulkan）→ card0
        VIRTGPU_* → 宿主 MoltenVK。rootfs 已有 zink_dri.so 与全部 GL 栈，缺的
        只是 vulkan loader + ICD。
      </Text>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="5 面" label="内核改动全落地" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="M4 ✓" label="ICD 枚举 Apple M4" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="ring ✓" label="vkr_ring_start 成功" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="端到端 PASS" label="vkprobe 4/4 读回" tone="success" />
          </CardBody>
        </Card>
      </Grid>

      <Callout tone="success" title="vkprobe 端到端闭环（2026-09-19）">
        完整 Vulkan 链路全绿：instance → enumerate（Venus/M4）→ device →
        HOST3D blob → BAR mmap → compute → timeline fence → 读回 0xc0de0000-3
        全 MATCH。三层修复：驱动控制响应乱序配对（drain 按 token 轮转 +
        fenced 条目独立 recv 缓冲，5f41676a6）；CONTEXT_INIT 替换语义 + PRIME
        blob fd 导出（dc609f0e1）；宿主 vkr shim 强制 nullDescriptor 与
        dma-buf 可导出（MoltenVK 能力缺口，fork e0c96b73）。
      </Callout>

      <Callout tone="warning" title="Phase 4.2（deniald 桌面）遗留两点">
        ① fence 语义缺口：本栈 fence 在宿主派发命令时 retire，不覆盖 Metal
        实际完成——首次管线编译期间 vkWaitForFences 提前返回，紧随的 CPU
        读回拿旧数据（vkprobe 无窗口版 readback[0] 打印 0、比较时已变 magic
        即证据），需 vkr fence 线程接 MoltenVK 完成回调。② mesa gbm-zink
        缓冲创建仍 EINVAL：zink screen 已能初始化（nullDescriptor/dma-buf
        shim 生效），但 gbm_bo_create 在 mesa 内部失败、未到内核——属 mesa
        用户态集成工作。
      </Callout>

      <Divider />

      <H2>加速链路与修复位置</H2>
      <Card>
        <CardHeader>
          <H3>guest ICD → 宿主 MoltenVK（虚线 = 当前死锁反馈）</H3>
        </CardHeader>
        <CardBody>
          <ArchGraph nodes={chain.nodes} edges={chain.edges} direction="vertical" />
        </CardBody>
      </Card>

      <H2>交付提交</H2>
      <Table headers={commitHeaders} rows={commitRows} />

      <H2>内核改动五面</H2>
      <Table headers={kernelHeaders} rows={kernelRows} rowTone={kernelTones} />
      <Text>
        回归：grouped qemu/system 全套 1/1（29 分组步骤、255s）+ drm-version /
        drm-modeset 单跑绿；drm-version 断言同步更新为 virtio_gpu 身份 + major
        0 + syncobj caps。clippy（板卡 feature 集）仅剩 somehal 既有警告。
      </Text>

      <H2>vkprobe 进度矩阵</H2>
      <Table headers={probeHeaders} rows={probeRows} rowTone={probeTones2} />

      <Divider />
      <H2>本轮五坑（复现必读）</H2>
      <Table headers={pitHeaders} rows={pitRows} rowTone={pitTones2} />

      <H2>下阶段清单</H2>
      <Table headers={nextHeaders} rows={nextRows} rowTone={nextTones} />

      <Divider />
      <H3>文件索引</H3>
      <Stack gap={4}>
        <Text>
          研究文档（§9 = 本轮全量证据）：
          <FL path="./research-host-vulkan-acceleration.md" label="docs/research-host-vulkan-acceleration.md" />
        </Text>
        <Text>
          内核：<FL path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" label="card0.rs（身份/caps/dispatch）" /> ·{" "}
          <FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" label="vgpu.rs（syncobj/EXECBUFFER/悬垂修复）" /> ·{" "}
          <FL path="../os/StarryOS/kernel/src/pseudofs/sysfs.rs" label="sysfs.rs（renderD128/MODALIAS/device-drm）" /> ·{" "}
          <FL path="../os/StarryOS/kernel/src/pseudofs/dev/drm.rs" label="drm.rs（cap 常量）" />
        </Text>
        <Text>
          驱动：<FL path="../drivers/gpu/virtio-gpu/src/device.rs" label="device.rs（空 payload/SPIN_BUDGET）" />
        </Text>
        <Text>
          探针：<FL path="../tmp/vgpu-probe/vkprobe.c" label="vkprobe.c" /> ·{" "}
          <FL path="../tmp/vgpu-probe/mini-strace.c" label="mini-strace.c" /> ·{" "}
          <FL path="../tmp/vgpu-probe/csblob3.c" label="csblob3.c" /> ·{" "}
          <FL path="../tmp/vgpu-probe/run-vkprobe.sh" label="run-vkprobe.sh" /> ·{" "}
          <FL path="../tmp/vgpu-probe/inject-venus-icd.sh" label="inject-venus-icd.sh" />
        </Text>
        <Text>
          测试：<FL path="../test-suit/starryos/qemu/system/drm-test-drm-version/src/main.c" label="drm-test-drm-version" /> ·{" "}
          速查：<FL path="../AGENTS.md" label="AGENTS.md" /> venus Phase 4 条目
        </Text>
      </Stack>
    </Stack>
  );
}
