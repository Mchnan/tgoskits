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

// ---- 数据链路 DAG：StarryOS guest 3D 面 → 宿主 Metal ----
const chain = {
  nodes: [
    { id: "flutter", label: "deniald/venus" },
    { id: "card0", label: "card0 vgpu" },
    { id: "driver", label: "virtio-gpu" },
    { id: "qemu", label: "virtio-gpu-gl" },
    { id: "proxy", label: "proxy client" },
    { id: "vkr", label: "vkr + Metal" },
  ],
  edges: [
    { from: "flutter", to: "card0", label: "VIRTGPU_*" },
    { from: "card0", to: "driver", label: "global_3d" },
    { from: "driver", to: "qemu", label: "ctrl vq" },
    { from: "qemu", to: "proxy", label: "in-proc" },
    { from: "proxy", to: "vkr", label: "socket+fd" },
  ],
};

// ---- hostmem 旁路（与渲染链正交的一条线） ----
const hostmemChain = {
  nodes: [
    { id: "mmap", label: "guest mmap" },
    { id: "vma", label: "PhysicalCached" },
    { id: "bar", label: "hostmem BAR" },
    { id: "shm", label: "vkr shm" },
    { id: "mtl", label: "MTLBuffer" },
  ],
  edges: [
    { from: "mmap", to: "vma", label: "key>=1<<40" },
    { from: "vma", to: "bar", label: "16K slot" },
    { from: "bar", to: "shm", label: "QEMU MR" },
    { from: "shm", to: "mtl", label: "bytesNoCopy" },
  ],
};

// ---- 交付物三面 ----
const deliverHeaders = ["改动面", "内容", "关键设计点"];
const deliverRows: (string | JSX.Element)[][] = [
  [
    <Code>drivers/gpu/virtio-gpu</Code>,
    "新 no_std crate：2D+3D 合并 virtio-gpu 驱动，全局 3D 注册表 global_3d()",
    "单控制队列单互斥；fenced SUBMIT_3D fire-and-forget + pending FIFO 按序 drain（宿主把响应推迟到 fence retire，同步等待必卡死）；命令头一律拷入驱动自有缓冲（曾踩 guest 栈 DMA 地址失效）",
  ],
  [
    <Code>ax-driver</Code>,
    "PCI SHARED_MEMORY_CFG 解析 + 新驱动接入 + vgpu re-export",
    "cap64 扩展与 BAR 物理地址重建；2D 不可用降级 3D-only（darwin venus-only 无 vrend，display 设备不注册，否则 axdisplay 适配器 panic）",
  ],
  [
    <Code>starry-kernel vgpu.rs</Code>,
    "card0 VIRTGPU_* ioctl 族 + 通用 syncobj 族 + hostmem mmap",
    "状态按进程 identity 键控（venus 每进程一 fd，行为等价）；blob mmap key 从 1<<40 起、BAR slot 16K 对齐、PhysicalCached；卡级状态挂 reset_kms_state()（#2393 语义）",
  ],
];

// ---- 探针 21 步（分组展示） ----
const probeHeaders = ["阶段", "步骤", "结果与证据"];
const probeTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success",
  "success", "success", "success", "success",
  "success", "success", "success", "success",
];
const probeRows: (string | JSX.Element)[][] = [
  ["能力协商", "GETPARAM ×7", "3d/blob/host_visible/ctx_init/capset_fix 全 1；capset_mask=0x10（venus 位）"],
  ["能力协商", "GET_CAPS(venus)", "160 字节 capset；wire[0..16] = 01 00 00 00 65 41 40 00 …"],
  ["上下文", "CONTEXT_INIT", "capset_id=4 + NUM_RINGS=64；第二次调用 EEXIST 语义正确"],
  ["资源", "RESOURCE_CREATE_BLOB", "HOST3D+MAPPABLE 132 KiB；bo_handle=0x1000000 / res_handle=0x1000"],
  ["资源", "RESOURCE_INFO", "res_handle / size / blob_mem 回读一致"],
  ["映射", "MAP + mmap", "offset=0x1_0000_0000_0000 → mmap 直写 hostmem BAR"],
  ["映射", "BAR 回读", "0xc0de0000-3 写读一致（guest 用户态 ↔ 宿主 shm ↔ MTLBuffer 同一页）"],
  ["同步", "SYNC CREATE/SIGNAL/QUERY", "timeline watermark=5；QUERY 返回全值"],
  ["提交", "EXECBUFFER(unfenced)", "64 字节命令流同步提交成功"],
  ["同步", "TIMELINE_WAIT 未来点", "无 WAIT_FOR_SUBMIT → EINVAL（Linux 语义一致）"],
  ["回收", "GEM_CLOSE + SYNC DESTROY", "blob unmap+unref、syncobj 删除，21/21 步全绿 VGPROBE PASS"],
];

// ---- 排障三坑 ----
const pitHeaders = ["坑", "现象", "根因与修复"];
const pitTones: Array<TableRowTone | undefined> = ["danger", "danger", "warning"];
const pitRows: (string | JSX.Element)[][] = [
  [
    "QEMU 版本宏改名",
    "BLOB 命令落 default → 0x1200；GET_CAPS 却正常",
    "virglrenderer 1.3 把 VIRGL_VERSION_MAJOR 改名为 VIRGL_MAJOR_VERSION；未定义标识符在 #if 中求值 0，RESOURCE_CREATE_BLOB/MAP_BLOB/SET_SCANOUT_BLOB 整段 case 被静默裁掉。Phase 1 的 QEMU 是 brew 头在时构建的，patch 触发重编才暴露。修复：源文件头部桥接宏名（已落 darwin fork）",
  ],
  [
    "wire 命令号手抄错",
    "CREATE_BLOB 一直 EIO；QEMU 报 ctrl 0x111 error 0x1200",
    "UAPI 实际值：CREATE_BLOB=0x10c、SUBMIT_3D=0x207、MAP/UNMAP_BLOB=0x208/0x209；用 process_cmd type 打点 + default-hit 诊断定位",
  ],
  [
    "vkr blob / ctx 语义",
    "blob_flags 带 SHAREABLE 即失败；空 debug_name 拖垮后续 blob",
    "blob_id=0 走宿主 shm 分配要求 blob_flags == 精确 MAPPABLE；CONTEXT_CREATE 空 debug_name 被 renderer 拒（Linux 总发 task comm）→ 内核补 starry-vgpu-{pid} 默认名",
  ],
];

// ---- 验证矩阵 ----
const verifyHeaders = ["验证", "命令/方式", "结果"];
const verifyTones: Array<TableRowTone | undefined> = ["success", "success", "success"];
const verifyRows: (string | JSX.Element)[][] = [
  [
    "E2E 探针",
    "vgprobe.c（musl 静态）经 debugfs 注 rootfs APFS clone、串口 holder 注入",
    "21/21 全绿 === VGPROBE PASS ===",
  ],
  [
    "2D 回归",
    "grouped qemu/system（含 drm-atomic→modeset 跨进程顺序）",
    "1/1 PASS；drm-modeset 75/75 不回归",
  ],
  [
    "静态检查",
    "cargo xtask clippy（bare-metal aarch64 手工匹配参数）+ cargo fmt",
    "全绿",
  ],
  [
    "环境还原",
    "guest 内 sync; poweroff；QEMU 调试打印全部摘除后干净复跑",
    "PASS、QEMU stderr 零 VGPUDBG",
  ],
];

// ---- 遗留 ----
const todoHeaders = ["方向", "说明"];
const todoTones: Array<TableRowTone | undefined> = ["success", "warning", "warning", "neutral"];
const todoRows: (string | JSX.Element)[][] = [
  [
    "SET_SCANOUT_BLOB 接 KMS present",
    "Phase 3 已闭环（2026-09-16）：card0 present 按 fb backing 分流，blob fb 走 SET_SCANOUT_BLOB 零拷贝 scanout、dumb fb 保持 memcpy + 2D 重绑；E2E 探针 15 组 + 宿主 screendump 像素级校验双 PASS（研究文档 §8）",
  ],
  [
    "deniald 集成（Phase 4）",
    "rootfs 装 Alpine edge mesa-vulkan-virtio（venus ICD）；Flutter Impeller-Vulkan 走 /dev/dri/card0 的 VIRTGPU_* 面 + Phase 3 scanout 上屏；raster_avg 目标 87–127ms → <5ms",
  ],
  [
    "fence 异步唤醒",
    "当前 single-flight 同步语义：fence 在 ioctl 返回时视为 signaled，vkWaitForFences 语义正确但 GPU 并行度未打开；下一步 async submit + 内核事件队列唤醒（poll 基建已在）",
  ],
  [
    "GUEST blob / EVENTFD / PRIME",
    "GUEST/HOST3D_GUEST（guest backing attach）延后；SYNCOBJ_EVENTFD 保持 ENOSYS 是诚实语义（见 §6.5 fence 分析）；PRIME 导出 blob handle / DMA-BUF 链延后（compositor 直连 SET_SCANOUT_BLOB 不需要）",
  ],
];

export default function VenusPhase2Canvas(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 24 }}>
      <H1>venus 加速 Phase 2 — StarryOS 内核 3D 面端到端打通</H1>
      <Text>
        2026-09-16。Phase 2 目标（宿主 GPU 加速路线图的 guest 内核侧大项）：
        给 card0 加上 mesa venus Vulkan 驱动所需的 VIRTGPU_* 3D 控制面与
        hostmem BAR 映射。本次以 raw ioctl 探针在 darwin venus QEMU +
        StarryOS 上全链验证通过，2D KMS 回归不受影响。
      </Text>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="21/21" label="探针检查全绿（VGPROBE PASS）" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="3" label="改动面：驱动 crate / ax-driver / 内核" tone="info" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="1/1" label="grouped system 回归（75/75）" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="28aa9a46c" label="提交（fix/card0-vblank-clock）" tone="info" />
          </CardBody>
        </Card>
      </Grid>

      <Callout tone="success" title="本轮决定性证据：guest 用户态直接读写宿主可见内存">
        <Text>
          探针在 guest 用户态对 hostmem BAR 的 mmap 映射写入
          <Code> 0xc0de0000-3 </Code>并回读一致——同一页同时被宿主
          MoltenVK 以 MTLBuffer（bytesNoCopy）持有，证明
          <Code> RESOURCE_CREATE_BLOB → MAP_BLOB → BAR → shm → Metal </Code>
          的零拷贝语义已在 StarryOS 上成立。
        </Text>
      </Callout>

      <H2>数据链路</H2>
      <Row gap={16}>
        <Card style={{ flex: 1 }}>
          <CardHeader>渲染提交链（控制面）</CardHeader>
          <CardBody>
            <ArchGraph nodes={chain.nodes} edges={chain.edges} direction="vertical" />
          </CardBody>
        </Card>
        <Card style={{ flex: 1 }}>
          <CardHeader>hostmem 旁路（数据面，与 KMS present 正交）</CardHeader>
          <CardBody>
            <ArchGraph nodes={hostmemChain.nodes} edges={hostmemChain.edges} direction="vertical" />
          </CardBody>
        </Card>
      </Row>

      <H2>交付物（提交 28aa9a46c）</H2>
      <Table headers={deliverHeaders} rows={deliverRows} />

      <H2>探针验证（tmp/vgpu-probe/vgprobe.c）</H2>
      <Table headers={probeHeaders} rows={probeRows} rowTone={probeTones} />

      <H2>排障三坑（复现必读）</H2>
      <Table headers={pitHeaders} rows={pitRows} rowTone={pitTones} />

      <Callout tone="warning" title="最隐蔽的一坑：QEMU VIRGL_VERSION_MAJOR 宏">
        <Text>
          virglrenderer 1.3+ 把版本宏改名为 <Code>VIRGL_MAJOR_VERSION</Code>（新
          virgl-version.h），而 QEMU 的 virtio-gpu-virgl.c 仍用旧名
          <Code> VIRGL_VERSION_MAJOR</Code>——未定义标识符在 <Code>#if</Code> 里求值 0，
          <Code> #if 0 &gt;= 1</Code> 把 blob/MAP_BLOB/SET_SCANOUT_BLOB/fence-info 的整段
          case 静默裁掉（0x111 命令落 default → 0x1200）。Phase 1 能跑是因为当时的
          QEMU 在 brew virglrenderer 头还在时构建；后来 brew 头被删、本轮 patch
          触发重编才暴露。修复 = 在源文件头部桥接宏名（已落 Mchnan/qemu darwin-venus）。
        </Text>
      </Callout>

      <H2>验证矩阵</H2>
      <Table headers={verifyHeaders} rows={verifyRows} rowTone={verifyTones} />

      <H2>遗留与下一步（Phase 3）</H2>
      <Table headers={todoHeaders} rows={todoRows} rowTone={todoTones} />

      <Divider />
      <H3>文件索引</H3>
      <Stack gap={4}>
        <Text>
          研究文档（§7 = 本轮实测）：<FL path="./research-host-vulkan-acceleration.md" label="docs/research-host-vulkan-acceleration.md" />
        </Text>
        <Text>
          3D 驱动 crate：<FL path="../drivers/gpu/virtio-gpu/src/lib.rs" label="lib.rs" /> ·{" "}
          <FL path="../drivers/gpu/virtio-gpu/src/device.rs" label="device.rs" /> ·{" "}
          <FL path="../drivers/gpu/virtio-gpu/src/protocol.rs" label="protocol.rs" />
        </Text>
        <Text>
          内核 3D 面：<FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" label="vgpu.rs" /> ·{" "}
          <FL path="../os/StarryOS/kernel/src/pseudofs/dev/card0.rs" label="card0.rs" />
        </Text>
        <Text>
          ax-driver 接线：<FL path="../drivers/ax-driver/src/virtio/display.rs" label="display.rs" /> ·{" "}
          <FL path="../drivers/ax-driver/src/pci/mod.rs" label="pci/mod.rs（SHARED_MEMORY_CFG 解析）" />
        </Text>
        <Text>
          探针：<FL path="../tmp/vgpu-probe/vgprobe.c" label="vgprobe.c" />（debugfs 注入 + 串口 holder{" "}
          <FL path="../tmp/vgpu-probe/starry-hold.py" label="starry-hold.py" />）
        </Text>
        <Text>
          QEMU 宏桥接修复（宿主侧）：<FL path="../AGENTS.md" label="AGENTS.md" /> venus Phase 2 条目有完整复现配方
        </Text>
      </Stack>
    </Stack>
  );
}
