import {
  Stack, Row, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider,
  FileLink, useCanvasAction,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

function FL({ path, label }: { path: string; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} label={label} dispatch={dispatch} />;
}

const chain = {
  nodes: [
    { id: "vulkaninfo", label: "vulkaninfo" },
    { id: "venus", label: "venus ICD" },
    { id: "virtgpu", label: "virtio_gpu.ko" },
    { id: "vggl", label: "virtio-gpu-gl" },
    { id: "libvirgl", label: "libvirgl proxy" },
    { id: "rserver", label: "render server" },
    { id: "vkr", label: "vkr" },
    { id: "mvk", label: "MoltenVK" },
    { id: "metal", label: "Metal (M4)" },
  ],
  edges: [
    { from: "vulkaninfo", to: "venus", label: "VK loader" },
    { from: "venus", to: "virtgpu", label: "VIRTGPU ioctl" },
    { from: "virtgpu", to: "vggl", label: "virtio queue" },
    { from: "vggl", to: "libvirgl", label: "in-process" },
    { from: "libvirgl", to: "rserver", label: "unix+fd" },
    { from: "rserver", to: "vkr", label: "dispatch" },
    { from: "vkr", to: "mvk", label: "dlopen" },
    { from: "mvk", to: "metal", label: "MTLDevice" },
  ],
};

const mileHeaders = ["里程碑", "结果", "关键证据"];
const mileRows: Array<{ tone: TableRowTone }> = [
  { tone: "success" },
  { tone: "success" },
  { tone: "success" },
  { tone: "success" },
  { tone: "success" },
  { tone: "success" },
  { tone: "success" },
  { tone: "success" },
  { tone: "warning" },
];
const mileRowsData: (string | JSX.Element)[][] = [
  [
    "Phase 0 宿主 MoltenVK",
    "PASS",
    "brew molten-vk 1.4.2；C 探针枚举 Apple M4，VK_EXT_external_memory_metal 与 VK_EXT_metal_surface 在位；portability 位必须由应用显式开启",
  ],
  [
    "virglrenderer darwin 构建",
    "PASS",
    "tip cf6c62d (venus-protocol 1.1.3)，-Dvenus=true；需要 shim 头路径解决 vkr_metal_helpers.m 的 venus-protocol/vulkan_metal.h 引用",
  ],
  [
    "宿主 vtest smoke",
    "PASS",
    "最小 C 客户端走 CREATE_RENDERER → PROTOCOL_VERSION → CONTEXT_INIT(capset VENUS) → GET_CAPSET，返回 40 dword 有效 capset",
  ],
  [
    "QEMU 11.0.3 darwin 构建",
    "PASS",
    "5 处 darwin/venus 补丁 + meson 外层门控修复（c9ce8a2）后 virtio-gpu-gl-pci(blob/hostmem/venus) 注册成功，render server 进程可被拉起",
  ],
  [
    "Alpine aarch64 guest",
    "PASS",
    "edge 6.18.42-lts netboot（TCG 探针默认；HVF 可切）；本地 APKINDEX 镜像绕开 slirp DNS；mesa-vulkan-virtio 26.2.2 + vulkan-loader + vulkan-tools；内核确认 3 个 capset（VENUS id4）+ context_init",
  ],
  [
    "16K 页 blob 映射修复",
    "PASS",
    "MAP_FIXED EINVAL → virglrenderer 返回 -EOPNOTSUPP → QEMU 走 renderer 自选地址 fallback；1MB blob 映射恢复（HVF 下还需 hv_vm_unmap 对齐修复 7109d5e 才不崩 VM）",
  ],
  [
    "vulkaninfo 枚举 Apple M4",
    "PASS",
    "GPU0: Virtio-GPU Venus (Apple M4)（vendorID 0x106b，DRIVER_ID_MESA_VENUS，mesa 26.2.2）；已知 teardown 挂死（DestroyRing 后 fence），summary 输出完整不受影响",
  ],
  [
    "offscreen compute 渲染",
    "PASS",
    "aarch64 musl 交叉编译探针：instance→device→buffer→dispatch(4,1,1) 全链 VK_SUCCESS，host-visible SSBO 读回 0xc0de0000-3 四字段全匹配——M4 真实执行 guest dispatch",
  ],
  [
    "ring-based fence retire",
    "进行中",
    "vkWaitForFences 5s 超时（work 已完成、读回已写好）；vulkaninfo teardown 挂死同根因：on_ring_seqno_update→sync queue→proxy retire_fence→QEMU→guest 通知链未通，Phase 2 前置修复",
  ],
];

const patchHeaders = ["文件", "补丁内容", "原因"];
const patchRows: (string | JSX.Element)[][] = [
  [
    <Code>hw/display/meson.build</Code>,
    "virtio_gpu_gl 与 virtio_gpu_pci_gl 的 when 列表去掉 opengl 依赖；外层门控从 virgl.found() and opengl.found() 放宽为仅 virgl.found()（c9ce8a2）",
    "darwin 上 libepoxy 无 EGL 头 → opengl.found()=NO，外层门控不放宽则 gl 设备源集整个被跳过（-device help 无 virtio-gpu-gl 的根因）",
  ],
  [
    <Code>virtio-gpu-gl.c</Code>,
    "module_dep(\"ui-opengl\") 加 #ifdef CONFIG_OPENGL 守卫（c9ce8a2）",
    "module_load() 对缺失的依赖模块直接放弃加载，opengl=NO 宿主上设备照样注册不上",
  ],
  [
    <Code>accel/hvf/hvf-all.c</Code>,
    "不对齐内存段从 assert 改为 warn+skip（7109d5e）",
    "hv_vm_unmap 与 hv_vm_map 一样要求 16K 对齐，fallback blob 子区域落 4K GPA 时 assert 直接杀死整个 VM（HV_BAD_ARGUMENT）",
  ],
  [
    <Code>virtio-gpu-virgl.c</Code>,
    "egl-helpers.h include 与 get_egl_display / D3D11 引用加 CONFIG_OPENGL 守卫；v4 回调 + ASYNC_FENCE_CB + THREAD_SYNC 移出 EGL 条件；加 VIRGL_RENDERER_NO_VIRGL",
    "vkr 渲染器硬性要求 THREAD_SYNC|ASYNC_FENCE_CB；vrend 无 EGL/GLX winsys，初始化会中止整个 virgl",
  ],
  [
    <Code>virtio-gpu-gl.c</Code>,
    "display_opengl 检查从 error 降级为 warn",
    "无头 (-display none) venus-only 场景不需要 GL scanout",
  ],
  [
    <Code>ui/console.c</Code>,
    "dpy_gl_ctx_create/destroy/make_current/update 的 assert(con->gl) 改为 NULL 容忍",
    "无头模式无 GL 显示上下文，scanout 更新直接丢弃",
  ],
];

const riskHeaders = ["问题", "影响", "现状 / 对策"];
const riskRows: Array<{ tone: TableRowTone }> = [
  { tone: "danger" },
  { tone: "warning" },
  { tone: "warning" },
  { tone: "neutral" },
  { tone: "neutral" },
];
const riskRowsData: (string | JSX.Element)[][] = [
  [
    "ring-based fence retire 链未通",
    "vkWaitForFences 超时；vulkaninfo teardown 挂死",
    "work 本身正常（读回已写好）；需排查 vkr on_ring_seqno_update → sync queue → proxy retire_fence → QEMU → guest 通知链在 render-server 多进程模式下的接线；Phase 2 前置修复",
  ],
  [
    "HVF 下 1MB blob fallback 子区域非 16K 对齐",
    "hv_vm_unmap assert 杀 VM（已修 7109d5e）",
    "探针默认 TCG 绕开；如需 HVF 性能，blob 分配需保证 16K 对齐或 hv_vm_map 支持子页",
  ],
  [
    "vkr_ring_start 的 thrd_create 曾静默失败",
    "ring 停摆、guest 等死",
    "已加 vkr_log 取证（darwin-venus 工作树）；加日志后未复现，疑 fork 后瞬态",
  ],
  [
    "Mchnan/virglrenderer 空仓库拒收推送",
    "多占一个仓库名",
    "token 无 delete_repo 权限，需手动删除；实际推送落在 Mchnan/virglrenderer-darwin",
  ],
  [
    "SET_SCANOUT (0x103) 返回 0x1203",
    "fbcon 无法点亮（仅 cosmetic）",
    "无头测试不需要 scanout；后续可查 2D 资源在 NO_VIRGL 下的创建路径",
  ],
];

const artHeaders = ["产物", "位置"];
const artRows: (string | JSX.Element)[][] = [
  [
    "venus 验证栈根目录",
    <FL path="/Users/herbcheng/venus-stack" label="~/venus-stack" />,
  ],
  [
    "QEMU 11.0.3（git 浅克隆 + darwin-venus 分支）",
    <FL path="/Users/herbcheng/venus-stack/src/qemu" label="src/qemu" />,
  ],
  [
    "virglrenderer（GitLab clone + darwin-venus 分支）",
    <FL path="/Users/herbcheng/venus-stack/src/virglrenderer" label="src/virglrenderer" />,
  ],
  [
    "virglrenderer 安装前缀（dylib + render server）",
    <FL path="/Users/herbcheng/venus-stack/prefix" label="prefix/" />,
  ],
  [
    "Alpine edge aarch64 镜像 + netboot 内核",
    <FL path="/Users/herbcheng/venus-stack/mirror" label="mirror/" />,
  ],
  [
    "启动/取证脚本（qstart-alpine.sh、alphold.py、recv.py 等）",
    <FL path="/Users/herbcheng/venus-stack/qstart-alpine.sh" label="~/venus-stack/*.sh|*.py" />,
  ],
  [
    "本仓库调研文档（§6 实测结果）",
    <FL path="research-host-vulkan-acceleration.md" label="docs/research-host-vulkan-acceleration.md" />,
  ],
  [
    "compute 探针（shader + C + 交叉编译产物）",
    <FL path="/tmp/vkprobe/probe.c" label="/tmp/vkprobe/" />,
  ],
];

const ghHeaders = ["仓库", "分支", "内容"];
const ghRows: (string | JSX.Element)[][] = [
  [
    "Mchnan/qemu",
    <Code>darwin-venus</Code>,
    "qemu v11.0.3 + darwin/venus 补丁：910b803（4 文件补丁）、c9ce8a2（meson 外层门控 + module_dep 守卫）、7109d5e（hvf 不对齐段 warn+skip）",
  ],
  [
    "Mchnan/virglrenderer-darwin",
    <Code>master</Code>,
    "上游 tip cf6c62d 镜像",
  ],
  [
    "Mchnan/virglrenderer-darwin",
    <Code>darwin-venus</Code>,
    "MAP_FIXED 失败回退 -EOPNOTSUPP（8107032）+ vkr ring 线程取证日志（vkr_ring_start/thread、DestroyRing、seqno 命令）",
  ],
];

export default function VenusPhase1Status(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>Venus 加速 Phase 1 现状（2026-09-15）</H1>
      <Text>
        目标：闭环验证「宿主 MoltenVK 渲染 + guest venus ICD」两端跑通，为
        StarryOS 内核 virtio-gpu 3D 面（Phase 2）立项提供可行性判据。
        2026-09-15 复测闭环：枚举 + offscreen 渲染双双 PASS，Phase 1 完成。
      </Text>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="PASS" label="Phase 1 端到端" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="Apple M4" label="vulkaninfo 枚举读数" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="4/4" label="compute 读回匹配" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="fence" label="retire 链待修（Phase 2 前置）" tone="warning" />
          </CardBody>
        </Card>
      </Grid>

      <Callout tone="danger" title="架构级发现：vtest 跨 QEMU 边界不可行">
        <Text>
          原定 Phase 1 是「guest vtest ICD 经 socket 连宿主 virgl_test_server」。
          实读 mesa 与 virglrenderer 源码确认：vtest 协议双向依赖 SCM_RIGHTS
          文件描述符传递（blob/shmem 资源、fence 全走 fd，mesa 客户端无条件断言
          blob 支持），而 fd 是内核局部资源，无法穿越 QEMU 边界。Phase 1 改道为
          QEMU <Code>virtio-gpu-gl,venus=true</Code> 设备路径（本就在原 Phase 1
          范围内）：渲染器与 MoltenVK 同在宿主侧，fd 语义成立。
        </Text>
      </Callout>

      <Card>
        <CardHeader><H2>端到端链路（实际打通形态）</H2></CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>
              Alpine aarch64 真实 Linux guest（HVF）代替 StarryOS guest 参与先验，
              StarryOS 内核零改动；blob 页共享回传依赖 MAP_BLOB + hostmem BAR。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>里程碑</H2></CardHeader>
        <CardBody>
          <Table
            headers={mileHeaders}
            rows={mileRowsData}
            rowTone={mileRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>QEMU darwin/venus 补丁清单</H2></CardHeader>
        <CardBody>
          <Table headers={patchHeaders} rows={patchRows} />
        </CardBody>
      </Card>

      <Callout tone="warning" title="16K 页页长错位：本阶段最深的坑">
        <Text>
          macOS arm64 宿主页长 16KB，guest Linux 内核按自身 4K 页粒度分配
          hostmem blob 的 BAR offset（第二个 blob 落在 0x...21000，非 16K 对齐），
          MAP_FIXED mmap 返回 EINVAL，MAP_BLOB 失败（guest 侧表现为
          response 0x1200 / command 0x208），vulkaninfo 因此挂死。修复：
          virglrenderer 的 virgl_renderer_resource_map_fixed 在 mmap 失败时改回
          -EOPNOTSUPP，让 QEMU 走既有的 renderer 自选地址 fallback（mmap(NULL)
          后由 memory region 子区域指向共享页），语义不变。
          补充：TCG 加速器下 fallback 全程可用；HVF 下 fallback 子区域落在
          4K 对齐 GPA，hv_vm_unmap 同样要求 16K 对齐，assert 会杀死整个 VM
          （已修 7109d5e，探针默认 TCG）。
        </Text>
      </Callout>

      <Card>
        <CardHeader><H2>遗留问题与风险</H2></CardHeader>
        <CardBody>
          <Table
            headers={riskHeaders}
            rows={riskRowsData}
            rowTone={riskRows.map((r) => r.tone)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>产物与位置</H2></CardHeader>
        <CardBody>
          <Table headers={artHeaders} rows={artRows} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>GitHub 侧（Mchnan）</H2></CardHeader>
        <CardBody>
          <Table headers={ghHeaders} rows={ghRows} />
          <Stack gap={6}>
            <Text>
              注：virglrenderer 上游在 freedesktop GitLab，GitHub 无 fork 源，
              故以独立仓库 Mchnan/virglrenderer-darwin 承载；最早误建的
              Mchnan/virglrenderer 空仓库拒收推送且 token 无删除权限，需手动清理。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>下一步</H2></CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Text>1. 修复 ring-based fence retire 通知链（Phase 2 前置）：定位 on_ring_seqno_update → sync queue → proxy retire_fence → QEMU 的断点；</Text>
            <Text>2. Phase 2 立项：StarryOS card0 增加 VIRTGPU_* 3D ioctl 族（GETPARAM/GET_CAPS/BLOB/MAP/CONTEXT_INIT/EXECBUFFER）+ hostmem BAR 用户态映射；</Text>
            <Text>3. deniald 集成（Phase 3）：Flutter/Impeller 检测 Vulkan ICD 后切 Impeller-Vulkan，用「动画 + 即取 dd.log 审计」对比 raster_avg_us；</Text>
            <Text>4. 推送 qemu/virglrenderer darwin-venus 新提交到 GitHub fork 备份。</Text>
          </Stack>
        </CardBody>
      </Card>

      <Divider />
      <Row>
        <Text>
          背景文档：
          <FL path="research-host-vulkan-acceleration.md" label="调研文档" />
          {"  ·  "}
          <FL path="sop-run-starryos-denial-qemu.md" label="denial QEMU SOP" />
          {"  ·  "}
          <FL path="../AGENTS.md" label="AGENTS.md 阶段记录" />
        </Text>
      </Row>
    </Stack>
  );
}
