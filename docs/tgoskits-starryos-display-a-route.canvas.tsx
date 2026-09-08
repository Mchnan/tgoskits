import {
  Stack, Row, Grid, H1, H2, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, CodeBlock, ArchGraph, FileLink,
  useHostTheme, useCanvasAction,
  type TableColumnAlign, type TableRowTone,
} from "cursor/canvas";

const PROOF_SRC = "data:image/jpeg;base64,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";

const pipeline = {
  nodes: [
    { id: "app", label: "fbdemo 用户态" },
    { id: "fb0", label: "/dev/fb0 mmap" },
    { id: "refresh", label: "fb-refresh 60Hz" },
    { id: "axdisplay", label: "axdisplay" },
    { id: "gpu", label: "virtio-gpu" },
    { id: "qemu", label: "QEMU scanout" },
    { id: "win", label: "Cocoa 窗口 + VNC" },
  ],
  edges: [
    { from: "app", to: "fb0", label: "像素写入" },
    { from: "fb0", to: "refresh", label: "mmap 直映" },
    { from: "refresh", to: "axdisplay", label: "定时 flush" },
    { from: "axdisplay", to: "gpu", label: "virtqueue" },
    { from: "gpu", to: "qemu", label: "脏矩形" },
    { from: "qemu", to: "win", label: "扫描输出" },
  ],
};

const stepHeaders = ["步骤", "内容", "结果"];
const stepRows: Array<{ tone: TableRowTone; cells: string[] }> = [
  {
    tone: "success",
    cells: [
      "内核构建",
      "wayland 构建配置含 ax-runtime/display 与 ax-driver/virtio-gpu，lwprintf bindgen 需 musl sysroot 环境变量",
      "通过",
    ],
  },
  {
    tone: "success",
    cells: [
      "HVF 图形启动",
      "cocoa 窗口 + serial stdio 并存，内核到 root shell；/dev/dri/card0 (226:0)、/dev/fb0 (29:0) 就位",
      "通过",
    ],
  },
  {
    tone: "success",
    cells: [
      "fb0 ioctl + mmap",
      "宿主 musl 静态编译 fbdemo 注入干净 base 镜像；FBIOGET_VSCREENINFO/FSCREENINFO 全通",
      "1280x800 bpp=32",
    ],
  },
  {
    tone: "success",
    cells: [
      "扫描输出实拍",
      "QEMU 自带 -vnc :0，自写 RFB 3.8 raw 客户端抓帧（无截屏权限的替代方案）",
      "画面与源码一致",
    ],
  },
  {
    tone: "warning",
    cells: [
      "Weston + GTK4 桌面",
      "run-hvf.sh provision 装完 223 包后硬杀 QEMU，rootfs 数据块丢失，weston 二进制成全零文件",
      "受阻，待干净重做",
    ],
  },
];
const stepTones: Array<TableRowTone | undefined> = stepRows.map((r) => r.tone);
const stepAligns: Array<TableColumnAlign | undefined> = ["left", "left", "left"];

const pitfallHeaders = ["坑", "现象与根因", "对策"];
const pitfallRows = [
  [
    "guest 硬杀丢数据",
    "run-hvf.sh provision 完成后以 ctrl-a x 杀 QEMU；ext4 目录项与 inode 已提交但数据块未落盘，host e2fsck 只修元数据不救数据",
    "guest 内 sync + poweroff 优雅关机后再做任何 host 侧校验",
  ],
  [
    "apk DB 损坏",
    "重装时报 v2 database format error；注入 base 镜像的干净 DB 仍报 invalid or inconsistent（原因未查明）",
    "从 base 镜像重新拷贝 rootfs 再走完整 provision",
  ],
  [
    "expect marker 误匹配",
    "echo 回显的命令文本本身含 WESTON_DIED / SYNC_DONE 字样，被 expect 当成真实输出提前进入错误分支",
    "marker 用引号变形（如 echo SYNC_\"DO\"NE），使回显与输出不同形",
  ],
  [
    "串口输出滞后",
    "guest 侧输出可能显著延迟到达，看似卡死实则仍在推进",
    "expect timeout 放宽，先怀疑延迟再怀疑挂死",
  ],
  [
    "截屏权限缺失",
    "ZCode 无 Screen Recording 授权，computer-use 截屏被系统拒绝",
    "QEMU 同时挂 -vnc :0，用约 60 行的 RFB 客户端抓帧；注意 QEMU 只推脏矩形，需循环请求至全覆盖",
  ],
];

const reproCode = `# 1. 静态交叉编译最小 fb 演示（宿主 musl 工具链，无 guest 依赖）
aarch64-linux-musl-gcc -static -O2 -o /tmp/fbdemo /tmp/fbdemo.c

# 2. 克隆干净 base 镜像并注入（APFS clone + debugfs 直写）
cp -c tmp/axbuild/rootfs/rootfs-aarch64-alpine.img \\
      tmp/axbuild/rootfs/rootfs-aarch64-fbdemo.img
debugfs -w -R "write /tmp/fbdemo /usr/bin/fbdemo" \\
  tmp/axbuild/rootfs/rootfs-aarch64-fbdemo.img

# 3. 图形启动（cocoa 窗口与 VNC 后端并存，HVF 加速）
qemu-system-aarch64 -machine virt -cpu max -accel hvf -smp 4 -m 2048M \\
  -display cocoa,show-cursor=on -vnc :0 \\
  -device virtio-gpu-pci -device virtio-keyboard-pci -device virtio-mouse-pci \\
  -device nvme,drive=disk0,serial=tgoskits,max_ioqpairs=64,msix_qsize=65 \\
  -drive id=disk0,if=none,format=raw,file=...rootfs-aarch64-fbdemo.img \\
  -append "root=/dev/nvme0n1 console=ttyS0" -serial stdio \\
  -kernel target/aarch64-unknown-none-softfloat/release/starryos.bin

# 4. guest 内运行；宿主用 RFB 客户端连 localhost:5900 抓帧
/usr/bin/fbdemo &
# → FBDEMO fb: Virtio Framebuf 1280x800 bpp=32 line=5120 smem=4096000`;

const nextHeaders = ["方向", "内容"];
const nextRows = [
  [
    "Weston 桌面补验证",
    "干净重做 provision：cp base 镜像、resize、overlay 注入、guest apk add 后 sync + poweroff 优雅关机，再起 weston (drm-backend + pixman) 与 gtk4-demo",
  ],
  [
    "B 线：默认 run 带显示",
    "board 配置补 ax-runtime/display（缺它则 init_display 不执行，fb0/card0 空转）；run 配置补 -device virtio-gpu-pci，-nographic 换 -display cocoa + 显式 -serial stdio，经 --qemu-config 传入",
  ],
  [
    "KMS 路径演示",
    "fbdemo 扩展为 /dev/dri/card0 dumb buffer + SETCRTC + 页翻转路径（其 ioctl 语义已由系统套件 drm-test 系列在 463 子用例中验证）",
  ],
];

export default function StarryDisplayARoute(): JSX.Element {
  const dispatch = useCanvasAction();
  const theme = useHostTheme();
  return (
    <Stack gap={16} style={{ padding: 24 }}>
      <H1>StarryOS × QEMU 模拟显示器 — A 线原型验证</H1>
      <Text>
        目标：让 StarryOS 的输出出现在 QEMU 模拟显示器（窗口）上，而不只是串口
        console。本报告记录 2026-09-06 在 Apple Silicon macOS 宿主上的原型验证进展：
        显示链路已端到端闭环，桌面级验证（Weston + GTK4）因 rootfs 损坏待干净重做。
      </Text>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="闭环" label="fb0 到扫描输出全链路" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="1280x800" label="virtio-gpu 分辨率 @32bpp" tone="info" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="HVF" label="图形启动 + 串口并存" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="受阻" label="Weston 桌面（rootfs 损坏）" tone="warning" />
          </CardBody>
        </Card>
      </Grid>

      <Callout tone="success" title="核心结论">
        <Text>
          StarryOS 的图形栈在仓库内早已全部存在（virtio-gpu 驱动、axdisplay、/dev/fb0
          与 /dev/dri/card0），缺的只是配置组合。最小原型一次打通：用户态写
          <Code> /dev/fb0</Code> → 内核 60Hz <Code>fb-refresh</Code> 定时 flush →
          axdisplay → virtio-gpu → QEMU 扫描输出，VNC 实拍帧与绘制源码逐像素对应。
          注意内核没有 fbcon：窗口画面永远来自用户态绘制，console 始终走 UART，
          两者天然并存互不干扰。
        </Text>
      </Callout>

      <Card>
        <CardHeader>
          <H2>显示链路（全部为仓库现有实现）</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <ArchGraph nodes={pipeline.nodes} edges={pipeline.edges} direction="vertical" />
            <Text>
              驱动入口在
              <FileLink path="../drivers/ax-driver/src/virtio/display.rs" label="virtio/display.rs" dispatch={dispatch} />
              （PCI probe → VirtIOGpu → rdrive 注册）；axruntime 按
              <Code> ax-runtime/display</Code> feature 收编设备；fbdev 语义与 60Hz 刷新任务在
              <FileLink path="../os/StarryOS/kernel/src/pseudofs/dev/fb.rs" label="pseudofs/dev/fb.rs" dispatch={dispatch} />
              ；KMS 模拟（dumb buffer、SETCRTC、页翻转、vblank）在同目录
              <Code> card0.rs</Code>。系统套件的
              <FileLink path="../test-suit/starryos/qemu/system/qemu-aarch64.toml" label="qemu-aarch64.toml" dispatch={dispatch} />
              本就挂有 virtio-gpu-pci，drm-test 系列子用例已在 463 子用例内通过。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>实拍证据：QEMU 扫描输出帧</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <img
              src={PROOF_SRC}
              alt="QEMU VNC 抓帧：fbdemo 滚动色条与弹跳白色方块（1280x800）"
              style={{ width: "100%", borderRadius: 8, display: "block" }}
            />
            <Text>
              上图为 QEMU VNC 端口（localhost:5900）抓取的原始扫描输出（缩放自
              1280x800 全尺寸原图 /tmp/starry-display-proof.png）。画面为注入的
              fbdemo 绘制内容：六段滚动色带与 60x60 弹跳白色方块，图中方块正处于
              蓝色带上的动画中途位置——证明是实时渲染帧而非静态残留。
            </Text>
            <CodeBlock
              language="text"
              code={`guest: FBDEMO fb: Virtio Framebuf 1280x800 bpp=32 line=5120 smem=4096000
host: RFB 3.8 握手 → SetPixelFormat(32bpp LE) → raw 编码 → 脏矩形 1072x800`}
            />
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>验证过程</H2>
        </CardHeader>
        <CardBody>
          <Table
            headers={stepHeaders}
            rows={stepRows.map((r) => r.cells)}
            columnAlign={stepAligns}
            rowTone={stepTones}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>踩坑记录（全部实踩）</H2>
        </CardHeader>
        <CardBody>
          <Table headers={pitfallHeaders} rows={pitfallRows} rowTone={[
            "danger", "warning", "warning", "neutral", "info",
          ]} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>复跑步骤</H2>
        </CardHeader>
        <CardBody>
          <CodeBlock language="bash" code={reproCode} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>遗留与下一步</H2>
        </CardHeader>
        <CardBody>
          <Stack gap={8}>
            <Table headers={nextHeaders} rows={nextRows} />
            <Text>
              完整踩坑与技术细节已记录在
              <FileLink
                path="../docs/tgoskits-arm64-macos-build-process.canvas.tsx"
                label="tgoskits-arm64-macos-build-process.canvas.tsx"
                dispatch={dispatch}
              />
              第 9.8 节；A 线原始脚本为
              <FileLink path="../apps/starry/wayland/run-hvf.sh" label="apps/starry/wayland/run-hvf.sh" dispatch={dispatch} />
              （内含 cocoa + HVF + VNC 的完整启动参数）。宿主侧临时产物：
              <Code> /tmp/fbdemo.c</Code>、<Code> /tmp/starry-display-proof.png</Code>，
              镜像 <Code> rootfs-aarch64-fbdemo.img</Code> 保留可复跑，
              损坏的 <Code> rootfs-aarch64-wayland.img</Code> 待重做覆盖。
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Row gap={8}>
        <Pill active>A 线原型</Pill>
        <Pill>显示链路闭环</Pill>
        <Pill>Weston 桌面待重做</Pill>
      </Row>
      <Text style={{ color: theme.text.secondary }}>
        验证环境：macOS arm64（Darwin 24.6.0），Homebrew QEMU，aarch64 musl 交叉工具链，
        StarryOS target aarch64-unknown-none-softfloat，构建配置含 ax-runtime/display。
      </Text>
    </Stack>
  );
}
