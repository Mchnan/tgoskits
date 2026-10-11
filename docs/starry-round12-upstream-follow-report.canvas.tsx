// 第十二轮汇报：上游跟进与重落地（2026-10-11）
// 汇报本轮结果 + 后续步骤。配套：starry-upstream-defects-ledger.canvas.tsx（缺陷总账）、
// design/starry-venus-into-dev-card0.md（设计文档）、AGENTS.md §3（项目记忆）。
import {
  Stack, Row, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Pill, Stat, Callout, Code, Divider, TodoListCard, CodeBlock,
  useHostTheme, useCanvasAction, FileLink,
  type TableColumnAlign,
} from "cursor/canvas";

function FL({ path, label }: { path: string; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} label={label} dispatch={dispatch} />;
}

const buildVmCommands = `# Linux 构建机（本机 QEMU arm64 VM，记忆口径逆向还原）
cd ~/arm64-buildVM && qemu-system-aarch64 -machine virt,highmem=on -cpu host \\
  -accel hvf -smp 8 -m 12G -drive file=vm.qcow2,if=virtio,format=qcow2 \\
  -drive if=virtio,format=raw,file=seed.iso \\
  -bios /opt/homebrew/share/qemu/edk2-aarch64-code.fd \\
  -device virtio-net-pci,netdev=net0 \\
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 \\
  -display none -serial file:serial-relaunch.log -pidfile vm.pid
ssh -i ~/.ssh/arm64build -p 2222 build@127.0.0.1
# VM 内：
git clone --depth 1 -b venus-into-upstream-1011 \\
  https://github.com/Mchnan/denial.git ~/denial-1011
cd ~/denial-1011/compositor && cargo build --release --features flutter
# 产物：~/denial-1011/compositor/target/release/deniald (18M, 2m22s)`;

const nextSteps = [
  {
    id: "vkprobe",
    content: "vkprobe 21 步复测：新内核（venus-into-dev-1011 构建 starryos.bin）+ venus 栈 QEMU，判据与十一轮一致（BAR 往返、窗口内读回 4/4）",
    status: "pending",
  },
  {
    id: "e2e",
    content: "桌面级 e2e 复测：qstart-denial-e2e.sh（xres=1280,yres=800）+ 新 deniald 注入（构建机产物已就绪，staging/ + inject-denial-full.py + debugfs 注入 + MD5 回读）",
    status: "pending",
  },
  {
    id: "engine",
    content: "引擎工件代次对齐：上游 denial main 锁 Flutter 3.47.5-r1 + Slimpeller（Skia 不再编译）；e2e 需决定拉新引擎工件或暂用旧验证态引擎组合跑移植保真度",
    status: "pending",
  },
  {
    id: "diag",
    content: "denial liveness_probe/生命周期诊断重接线：上游 flutter_event_loop.rs 重写 3125 行，3cab163 第 4 部分需按新循环重写",
    status: "pending",
  },
  {
    id: "upstream-pr",
    content: "向上游提 PR 的授权决策：D1（MODE_ATOMIC 上限）与 ax-net 自旋锁修复两笔是干净的独立修复，可提 rcore-os/tgoskits；denial 三处修复对应上游 KNOWN_ISSUES",
    status: "pending",
  },
  {
    id: "audit",
    content: "上游缺陷跟进立项：D3（create_blob 命令顺序为 API 形状问题）、D4（双 resource-id 计数器）、D5（in-fence 外域等待）建议反馈上游",
    status: "pending",
  },
];

export default function Round12Report(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>第十二轮：上游跟进与重落地</H1>
      <Text>
        上游跟进完成、两侧落地效果按新基线重写、上游今日缺陷审计入账、Linux
        构建机整包构建通过。四份交付物：
        <FL path="design/starry-venus-into-dev-card0.md" label="设计文档" />
        {" / "}
        <FL path="starry-upstream-defects-ledger.canvas.tsx" label="缺陷总账" />
        {" / "}
        <FL path="../AGENTS.md" label="项目记忆" />
        {" / "}两个已推送分支（见下）。
      </Text>

      <Grid columns={4} gap={12}>
        <Card><CardBody><Stat value="169 / 187" label="上游领先提交（tgoskits dev / denial main）" tone="info" /></CardBody></Card>
        <Card><CardBody><Stat value="7 + 1" label="本轮新提交（tgoskits / denial）" tone="success" /></CardBody></Card>
        <Card><CardBody><Stat value="23 项" label="上游今日缺陷入账（14+9）" tone="warning" /></CardBody></Card>
        <Card><CardBody><Stat value="18M" label="Linux 构建机 deniald 产物（2m22s）" tone="success" /></CardBody></Card>
      </Grid>

      <Card>
        <CardHeader><H2>判定：落地效果未被取代，但必须按新架构重写</H2></CardHeader>
        <CardBody>
          <Text>
            tgoskits 上游以 #2483/#2506/#2536/#2557 重构出可移植 GPU 栈（rdif
            VirglOps + async ctrl 队列 + card0 重组），已合入我们的 PR #2284/#2365；
            但上游今日是 virgl 面——CONTEXT_INIT 拒绝 capset 4、HOST_VISIBLE 恒
            0、EXECBUFFER 拒绝 syncobj、无 hostmem/MAP_BLOB/SYNCOBJ_TIMELINE，
            mesa venus 完全跑不起来。denial 上游推进 Flutter fork 与 Slimpeller，
            但 present 链三处 R6 级缺陷原样存在。重落地 + 两笔干净修复如下。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>tgoskits：venus 面重落地（venus-into-dev-1011）</H2></CardHeader>
        <CardBody>
          <Table
            headers={["提交", "内容", "验证"]}
            columnAlign={"left"}
            rows={[
              ["ffb3fed43", "venus 面按 rdif 架构重写：MAP/UNMAP_BLOB + with_fence_ring + HostMemRegion + VirglOps 四方法（带默认实现）；内核 card0/syncobj.rs（retire 改 fence_completed 轮询泵，orphan 竞态天然消失）+ venus 分支 + v6.15 blob_hints 56B + legacy ADDFB + blob mmap 键", "starry build（aarch64 deny-warnings）+ clippy 三包 + fmt 全过"],
              ["9bbc279ff", "ax-net unix：命名空间解析移出自旋锁抢占排斥区（cherry-pick；上游至今仍 panic 级）", "干净 cherry-pick"],
              ["8ef161a99", "崩溃取证四件套：aarch64 寄存器/指令字/映射/栈 + FP 链（cherry-pick）", "干净 cherry-pick"],
              ["a3d4dda53", "MODE_ATOMIC 无界 vm_load 加 1024/8192 上限（审计发现的内核 DoS）", "clippy 过"],
              ["65f56662a 起", "设计文档重述 + 缺陷总账画布 + 项目记忆", "画布 lint 三门全过"],
            ]}
          />
          <Divider />
          <Text>
            关键代码落点：
            <FL path="../os/StarryOS/kernel/src/pseudofs/dev/card0/syncobj.rs" label="card0/syncobj.rs" />
            {" / "}
            <FL path="../os/StarryOS/kernel/src/pseudofs/dev/card0/virtgpu.rs" label="card0/virtgpu.rs" />
            {" / "}
            <FL path="../drivers/gpu/virtio-gpu/src/device.rs" label="virtio-gpu/device.rs" />
            {" / "}
            <FL path="../drivers/interface/rdif-gpu/src/lib.rs" label="rdif-gpu/lib.rs" />
            。被上游结构性取代、不再携带的旧落地：connector pmode 来源、axdisplay
            判空降级、fb0 门禁（均核实有等价机制）。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>denial：present 修复重落地（venus-into-upstream-1011, eeaa548）</H2></CardHeader>
        <CardBody>
          <Table
            headers={["修复", "上游缺陷", "状态"]}
            columnAlign={"left"}
            rows={[
              ["--denial-gl-fbo-zero-is-no-target 提升出 Impeller 分支", "Skia 路径 root present 被静默丢弃→槽耗尽黑屏（R6 原样）", "已修，flutter-engine cargo check 过"],
              ["每帧 check_framebuffer_status，失败跳帧", "渲染期 FBO 裸奔；KNOWN_ISSUES 自认 live scale 36054 崩溃", "已修（broker 下一事务回收 Rendering 槽）"],
              ["native fence 失败降级 glFinish + 无 fence 发布", "软件/虚拟化 EGL 无 EGL_ANDROID_native_fence_sync 第一帧即 abort", "已修——Linux 构建实证：FatalRender 变体变为零构造点（编译器 dead-code 警告即证据）"],
            ]}
          />
          <Divider />
          <Text>
            代码落点：
            <FL path="/Users/herbcheng/denial/compositor/flutter-engine/src/host.rs" label="denial host.rs" />
            {" / "}
            <FL path="/Users/herbcheng/denial/compositor/src/bin/deniald/flutter_runtime/renderer/handler/open_gl.rs" label="denial open_gl.rs" />
            。3cab163 第 4 部分（liveness_probe/生命周期诊断）未移植：上游
            flutter_event_loop.rs 重写 3125 行，接线点全变，列入后续步骤。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>Linux 构建机验证（本轮新执行）</H2></CardHeader>
        <CardBody>
          <CodeBlock code={buildVmCommands} language="bash" />
          <Divider />
          <Text>
            结果：VM 内浅克隆 venus-into-upstream-1011（eeaa548），
            cargo build --release --features flutter 通过——deniald 18M
            （2m22s）+ denialctl + denial-glass-benchmark 全部产出，0 error；
            两条 dead-code 警告恰好证明 fence 降级补丁语义生效（FatalRender
            零构造点）。构建机此前在本机不可达的判断已过时：它就是本机 QEMU
            arm64 VM（~/arm64-buildVM），按记忆口径一条命令可启动。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><H2>上游今日缺陷（详见缺陷总账）</H2></CardHeader>
        <CardBody>
          <Table
            headers={["仓库", "缺陷", "能力缺口", "本轮已修"]}
            columnAlign={"left"}
            rows={[
              ["tgoskits origin/dev", "14 项：D1 无界分配（高）、D2 UAPI 48B（中）、D3 create_blob 顺序（中）、D4 双计数器（中）、D5 in-fence（中低）+ D6–D14 低severity", "7 项：syncobj 族 / hostmem / MAP_BLOB / venus capset（本轮重落地）；EDID / cross-device / 多 scanout（保持上游取舍）", "D1、D2、D8 + 全部 4 项阻塞性缺口"],
              ["denial origin/main", "9 项：Skia fbo-zero（高）、软件 EGL abort（高）、FBO 复检（中高）、pending 卡死（中）等", "—", "前三项（高×2 + 中高）"],
            ]}
          />
        </CardBody>
      </Card>

      <Callout tone="info">
        <Text>
          系统调用兼容性对照表（ioctl/mmap 五族，结论均为「部分正确」：语义经旧栈
          vkprobe+e2e 验证、本轮补单元断言，本分支系统级复测待 QEMU 轮次）见设计文档
          同名章节与 AGENTS.md §3。
        </Text>
      </Callout>

      <Card>
        <CardHeader><H2>后续步骤</H2></CardHeader>
        <CardBody>
          <TodoListCard todos={nextSteps} />
        </CardBody>
      </Card>

      <Row gap={8}>
        <Pill active>第十二轮汇报</Pill>
        <Pill>venus-into-dev-1011 已推送</Pill>
        <Pill>venus-into-upstream-1011 已推送</Pill>
        <Pill>Linux 构建通过</Pill>
        <Pill>待：vkprobe + e2e 复测</Pill>
      </Row>
    </Stack>
  );
}
