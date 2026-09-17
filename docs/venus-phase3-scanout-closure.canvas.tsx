import {
  Stack, Row, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider, ArchGraph,
  FileLink, useCanvasAction,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

function FL({ path, label }: { path: string; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} label={label} dispatch={dispatch} />;
}

// ---- present 分流 DAG：card0 按 fb backing 路由 ----
const presentChain = {
  nodes: [
    { id: "client", label: "compositor" },
    { id: "addfb", label: "ADDFB2" },
    { id: "blobfb", label: "blob fb" },
    { id: "dumbfb", label: "dumb fb" },
    { id: "scanout", label: "SET_SCANOUT_BLOB" },
    { id: "memcpy", label: "memcpy+rebind" },
  ],
  edges: [
    { from: "client", to: "addfb", label: "gem handle" },
    { from: "addfb", to: "blobfb", label: "vgpu表" },
    { from: "addfb", to: "dumbfb", label: "dumb表" },
    { from: "blobfb", to: "scanout", label: "0x10d" },
    { from: "dumbfb", to: "memcpy", label: "axdisplay" },
  ],
};

// ---- 零拷贝内存链：guest 写入直达宿主 surface ----
const memChain = {
  nodes: [
    { id: "fill", label: "guest 写入" },
    { id: "bar", label: "hostmem BAR" },
    { id: "ept", label: "EPT 映射" },
    { id: "mr", label: "MR 子区域" },
    { id: "surf", label: "pixman surface" },
  ],
  edges: [
    { from: "fill", to: "bar", label: "16K slot" },
    { from: "bar", to: "ept", label: "hv listener" },
    { from: "ept", to: "mr", label: "shm 页" },
    { from: "mr", to: "surf", label: "ram_ptr" },
  ],
};

// ---- 交付物三面 ----
const deliverHeaders = ["改动面", "内容", "关键设计点"];
const deliverRows: (string | JSX.Element)[][] = [
  [
    <Code>drivers/gpu/virtio-gpu</Code>,
    "CMD_SET_SCANOUT_BLOB (0x10d) wire 结构 + VirtioGpu3D 三个新操作",
    "set_scanout_blob / bind_2d_scanout / disable_scanout 同步命令（scanout 无 fence，同步往返安全）；DRM XRGB8888/ARGB8888 映射到 B8G8R8X8/B8G8R8A8（内存序，Linux 同表）",
  ],
  [
    <Code>starry-kernel card0</Code>,
    "KMS present 按 fb backing 分流",
    "ADDFB2 先查 dumb 表再查 vgpu blob 表；present_fb 的 blob 分支发 SET_SCANOUT_BLOB（零 memcpy），dumb 分支保持 memcpy 且 blob scanout 曾活跃时先重绑 2D 资源；reset_kms_state 拆资源前先 disable scanout",
  ],
  [
    <Code>QEMU darwin fork</Code>,
    "virgl scanout 三补丁（a8dd183 已推 fork）",
    "非 GL console 走 pixman 直显路径；禁用 MAP_FIXED 快路径（恒走 MR 子区域，内存监听器可见）；unmap 前先停 scanout（pixman surface 原地引用 blob 内存）",
  ],
];

// ---- 探针 15 组（分组展示） ----
const probeHeaders = ["阶段", "步骤", "结果与证据"];
const probeTones: Array<TableRowTone | undefined> = [
  "success", "success", "success",
  "success", "success", "success",
  "success", "success", "success",
];
const probeRows: (string | JSX.Element)[][] = [
  ["3D 面基础", "GETPARAM/GET_CAPS/CONTEXT_INIT ×2", "21 步 Phase 2 面全部保持绿；blob mmap key 页对齐步进后多 blob 场景可用"],
  ["负例", "ADDFB2（关柄/伪造柄/尺寸不足）", "一律 EINVAL——blob fb 解析在内核侧先做 size ≥ fb_total 校验"],
  ["present", "blob A 建资源 + MAP + mmap BAR", "640×480×4；guest 写入渐变图案（r=x·255/639, g=y·255/479, b=0x40）"],
  ["present", "ADDFB2(blob A) + SETCRTC", "内核 present_blob 发 0x10d；CRTC_GET_SEQUENCE active=1"],
  ["present", "宿主 HMP screendump", "渐变 5 个探针点逐一匹配（SCANOUT-CHECK PASS 前半）"],
  ["flip", "blob B + PAGE_FLIP(A→B)", "宿主 surface 换成纯品红，4 点匹配（零拷贝：无 flush 命令）"],
  ["回收", "RMFB ×2 + GEM_CLOSE ×2", "宿主 disable；资源顺序拆除"],
  ["语义", "垃圾 EXECBUFFER（文档化）", "vkr 对未知 venus opcode 报 CS error 并拆 context 连接——此后仅允许 guest 本地步骤"],
  ["收尾", "TIMELINE_WAIT 复查 + 清理", "TIMELINE_WAIT EINVAL 语义不回归；=== VGPROBE PASS === + === SCANOUT-CHECK PASS ==="],
];

// ---- 本轮四坑 ----
const pitHeaders = ["坑", "现象", "根因与修复"];
const pitTones: Array<TableRowTone | undefined> = ["danger", "danger", "danger", "warning"];
const pitRows: (string | JSX.Element)[][] = [
  [
    "HVF EPT 陈旧",
    "guest BAR 写入后宿主读到全零；xp 直读 blob 物理地址也是零",
    "virgl MAP_FIXED 在 hostmem RAM 区块底下 mmap(MAP_FIXED) 换页，hvf 内存监听器无感知 → EPT 指向旧匿名页 → guest 写进孤儿页。KVM 有 mmu_notifier 兜底，Phase 1 能通是因为跑的 TCG。修复：darwin fork 禁用 MAP_FIXED，恒走 MR 子区域（监听器可见，Linux fallback 同语义）",
  ],
  [
    "shm fd 误判 dmabuf",
    "0x10d trace 正常但 console 恒为 Display output is not active. 占位图",
    "proxy 架构下 resource_get_info 的 info.fd 是 shm fd（≥0），QEMU 存进 res->base.dmabuf_fd → 「fd<0 才回退」永不成立 → 落进 darwin stub update_dmabuf（返回 0 假成功），surface 从未创建。修复：非 GL console 无条件走 pixman 直显",
  ],
  [
    "blob 尺寸 16K 对齐",
    "ring blob（0x21000）MAP 后 guest 首次 BAR 访问卡死",
    "4K 对齐尺寸让 hvf 监听器切出的 subsection 不对齐而被 skip-guard 跳过 → 该 gpa 段 EPT 缺失。修复：驱动把线上 blob 尺寸与 BAR slot 统一向上取整到 16 KiB（渲染器 shm 本就按宿主页取整，尾部为 guest 侧 padding）",
  ],
  [
    "格式字节序",
    "scanout 显示颜色通道错位（蓝变红邻位）",
    "DRM XRGB8888 内存序 [b,g,r,x] 对应 VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM(2)；X8R8G8B8(4) 字节序相反。修成与 Linux virtio_gpu_translate_format 同表",
  ],
];

// ---- 验证工具三坑 ----
const toolHeaders = ["坑", "后果", "规程"];
const toolTones: Array<TableRowTone | undefined> = ["warning", "warning", "warning"];
const toolRows: (string | JSX.Element)[][] = [
  [
    "debugfs 注入截断",
    "镜像内二进制 600 字节缺失 → guest 内 pc=0 SIGSEGV",
    "rm 后 write 会复用 extent 产出坏文件；必须 kill_file + unlink + write，且 debugfs dump 逐字节 cmp 校验后才开机",
  ],
  [
    "guest 运行中改镜像",
    "新注入被 guest unmount 的缓存写回覆盖，guest 永远看到旧目录/旧 inode",
    "规程固定为：关机 → 注入 → dump 校验 → 开机",
  ],
  [
    "holder 竞争串口",
    "探针前 7s 输出（含 MARKER₁）被 ctl 响应窗口吃掉；历史轮 marker 秒匹配造成黑屏假证据",
    "校验器盯 QEMU chardev logfile（console.log）而非 holder 的 live.log；marker 匹配必须带日志偏移量基线，只认本轮新增字节",
  ],
];

// ---- 验证矩阵 ----
const verifyHeaders = ["验证", "方式", "结果"];
const verifyTones: Array<TableRowTone | undefined> = ["success", "success", "success"];
const verifyRows: (string | JSX.Element)[][] = [
  [
    "E2E 探针",
    "vgprobe.c 15 组（4 负例）经 debugfs 注 rootfs clone + 串口 holder",
    "=== VGPROBE PASS ===（干净内核复跑确认）",
  ],
  [
    "零拷贝证明",
    "scanout-check.py 盯 console.log MARKER → HMP screendump → ppm 逐像素比对",
    "渐变 5 点 + 品红 4 点全中 === SCANOUT-CHECK PASS ===",
  ],
  [
    "2D 回归",
    "grouped qemu/system（含 drm-atomic→modeset 跨进程顺序）",
    "1/1 PASS（271.6s）；dumb 路径不回归",
  ],
  [
    "静态检查",
    "cargo xtask clippy（virtio-gpu + starry-kernel 板卡特性 aarch64）+ cargo fmt",
    "全绿",
  ],
];

export default function VenusPhase3Canvas(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 24 }}>
      <H1>venus 加速 Phase 3 — SET_SCANOUT_BLOB 接 KMS present 端到端闭环</H1>
      <Text>
        2026-09-16。Phase 3 目标：card0 的 KMS present 路径接到 3D blob 资源，
        让 compositor 提交的 blob-backed framebuffer 由宿主直接扫描输出——
        这是 venus-only 设备（darwin 无 vrend，无 2D 面）桌面上屏的唯一通路。
        结论：<Code>PASS</Code>，零拷贝语义拿到宿主像素级证明。
      </Text>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="Phase 3 PASS" label="探针 + 宿主 screendump 双闭环" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="0 memcpy" label="blob fb present：宿主 surface 原地引用 blob 内存" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="4+3" label="本轮新坑（HVF EPT / shm fd / 16K 对齐 / 字节序 + 工具三坑）" tone="danger" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="1/1" label="grouped qemu/system 回归（dumb 路径不回归）" tone="success" />
          </CardBody>
        </Card>
      </Grid>

      <Callout tone="success" title="核心结论">
        <Text>
          guest 用户态 mmap BAR 写入 → guest 物理内存 → EPT → 宿主 pixman surface，
          全程同一块宿主页：SETCRTC 后 console 显示 guest 写入的渐变（5 探针点逐像素匹配），
          PAGE_FLIP 后同步换成第二个 blob 的品红（4 点匹配）。
          compositor 直连 SET_SCANOUT_BLOB 不需要 DMA-BUF 导出链——resource id 直通。
        </Text>
      </Callout>

      <H2>present 分流与零拷贝内存链</H2>
      <Row gap={12}>
        <Card style={{ flex: 1 }}>
          <CardHeader><H3>card0 present 按 backing 路由</H3></CardHeader>
          <CardBody>
            <ArchGraph nodes={presentChain.nodes} edges={presentChain.edges} direction="vertical" />
          </CardBody>
        </Card>
        <Card style={{ flex: 1 }}>
          <CardHeader><H3>零拷贝内存链（HVF）</H3></CardHeader>
          <CardBody>
            <ArchGraph nodes={memChain.nodes} edges={memChain.edges} direction="vertical" />
          </CardBody>
        </Card>
      </Row>
      <Callout tone="warning" title="两条链路各断过一次">
        <Text>
          内存链断在 EPT 陈旧（MAP_FIXED 换页对 hvf 监听器不可见）；显示链断在
          shm fd 被当成 dmabuf（stub 假成功）。两者叠加时症状高度误导：
          0x10d trace 全部成功、内存全零、console 恒为占位图。
        </Text>
      </Callout>

      <H2>交付物</H2>
      <Table headers={deliverHeaders} rows={deliverRows} />

      <H2>端到端探针（15 组，含 4 负例）</H2>
      <Table headers={probeHeaders} rows={probeRows} rowTone={probeTones} />

      <H2>本轮四坑（复现必读）</H2>
      <Table headers={pitHeaders} rows={pitRows} rowTone={pitTones} />

      <H2>验证工具三坑</H2>
      <Table headers={toolHeaders} rows={toolRows} rowTone={toolTones} />

      <H2>验证矩阵</H2>
      <Table headers={verifyHeaders} rows={verifyRows} rowTone={verifyTones} />

      <Divider />
      <H2>遗留与下一步（Phase 4）</H2>
      <Table
        headers={["方向", "说明"]}
        rows={[
          [
            "deniald venus ICD 集成（Phase 4）",
            "rootfs 装 Alpine edge mesa-vulkan-virtio；Flutter Impeller-Vulkan 走 card0 的 VIRTGPU_* 面 + 本 Phase scanout 上屏；raster_avg 目标 87–127ms → <5ms。链路两端已各自闭环",
          ],
          [
            "fence 异步唤醒",
            "single-flight 同步语义（fence 在 ioctl 返回时视为 signaled）语义正确但 GPU 并行度未开；async submit + 内核事件队列唤醒延后",
          ],
          [
            "PRIME / DMA-BUF 导出链",
            "compositor 直连不需要；跨进程共享场景未来再补",
          ],
          [
            "混合 2D+3D 实测",
            "blob↔dumb 表面切换已实现（bind_2d_scanout 重绑），3D-only 设备已验证；2D 存在时的行为等价 Linux set_scanout 语义，待组合环境实测",
          ],
        ]}
        rowTone={["success", "warning", "neutral", "neutral"]}
      />

      <Divider />
      <H3>文件索引</H3>
      <Stack gap={4}>
        <Text>
          研究文档（§8 = 本轮实测）：<FL path="./research-host-vulkan-acceleration.md" label="docs/research-host-vulkan-acceleration.md" />
        </Text>
        <Text>
          驱动：<FL path="../drivers/gpu/virtio-gpu/src/protocol.rs" label="protocol.rs" /> ·{" "}
          <FL path="../drivers/gpu/virtio-gpu/src/lib.rs" label="lib.rs" /> ·{" "}
          <FL path="../drivers/gpu/virtio-gpu/src/device.rs" label="device.rs" />
        </Text>
        <Text>
          内核：<FL path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" label="card0.rs（present 分流）" /> ·{" "}
          <FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" label="vgpu.rs（blob 表 + 对齐/键修复）" />
        </Text>
        <Text>
          探针与校验：<FL path="../tmp/vgpu-probe/vgprobe.c" label="vgprobe.c" /> ·{" "}
          <FL path="../tmp/vgpu-probe/scanout-check.py" label="scanout-check.py" /> ·{" "}
          <FL path="../tmp/vgpu-probe/run-starry-scanout.sh" label="run-starry-scanout.sh" />
        </Text>
        <Text>
          速查：<FL path="../AGENTS.md" label="AGENTS.md" /> venus Phase 3 条目（坑册 + 复现配方）
        </Text>
      </Stack>
    </Stack>
  );
}
