// venus/zink 加速桌面端到端闭环 — 现状与计划（第九轮收官，2026-10-11）
// MoltenVK 重建（main@67b2682 + SPIRV-Cross aa217aeb）+ ICD 部署劫持修复 +
// 复测判定：shader 失败归零、ring 卡点闭合、deadline 首次进预算。
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

const fixedChain = {
  nodes: [
    { id: "mvk", label: "MoltenVK拒绝创建" },
    { id: "silent", label: "宿主静默失败" },
    { id: "ghost", label: "guest幽灵句柄" },
    { id: "ring", label: "vkr ring死亡" },
    { id: "gpu", label: "GPU通道关闭" },
  ],
  edges: [
    { from: "mvk", to: "silent", label: "async不读响应" },
    { from: "silent", to: "ghost", label: "对象未注册" },
    { from: "ghost", to: "ring", label: "查表fatal" },
    { from: "ring", to: "gpu", label: "ring线程退出" },
  ],
};

const stallChain = {
  nodes: [
    { id: "mvkcall", label: "MVK调用内部阻塞" },
    { id: "mutex", label: "queue锁被持有" },
    { id: "nosync", label: "sync线程堵死" },
    { id: "nofence", label: "fence永不retire" },
    { id: "spin", label: "raster永旋" },
    { id: "freeze", label: "合成器冻结" },
    { id: "black", label: "scanout静止" },
  ],
  edges: [
    { from: "mvkcall", to: "mutex", label: "持锁不返回" },
    { from: "mutex", to: "nosync", label: "WaitForFences不可达" },
    { from: "nosync", to: "nofence", label: "retire响应断流" },
    { from: "nofence", to: "spin", label: "SYNCOBJ_WAIT永旋" },
    { from: "spin", to: "freeze", label: "phase=1000" },
    { from: "freeze", to: "black", label: "无新帧" },
  ],
};

const evidenceHeaders = ["证据", "取证方法", "结论"];
const evidenceAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const evidenceRowTones: Array<TableRowTone | undefined> = [
  "success", "danger", "danger", "info", "danger", "warning",
];
const evidenceRows = [
  [
    "100% 纯黑 → 684 灰像素（跨配置不变）",
    "QEMU monitor screendump 逐像素分析",
    "blob scanout 零拷贝直读资源内存，截到的就是 scanout 真实内容",
  ],
  [
    "Shader library compile failed（VK_ERROR_INITIALIZATION_FAILED）",
    "MVK_CONFIG_LOG_LEVEL=3 + REDIRECT_TO_STDERR 当场抓获",
    "texture2d<float> sampler 遮蔽 MSL sampler 类型，下一行编译失败",
  ],
  [
    "名字与 OpName 无关",
    "剥名 18 处 + 首字母改写 136 处 + 落盘解析零 sampler + 关参数缓冲",
    "1.4.2 捆绑的 SPIRV-Cross 对 combined image sampler 内部生成该名字",
  ],
  [
    "上游 main 已含修复",
    "get_reserved_keyword_set 注释与本轮错误一字不差",
    "1.4.2（2026-07-24 release）未包含，需重建 MoltenVK",
  ],
  [
    "ring 线程卡死在 MoltenVK 调用内",
    "解析行在冻结时刻停止 + vkr sync 线程零 3s 超时 + 内核 stall 告警",
    "持 queue vk_mutex，堵死 sync 线程与 fence retire 链",
  ],
  [
    "lldb 附加被拒绝",
    "debugserver 权限（macOS 安全策略）",
    "调用级卡点留待带 Xcode 的机器定位",
  ],
];

const planItems = [
  {
    id: "r8-attribution",
    content: "黑屏逐层归因完成（screendump 像素 / MVK 日志 / 名字来源四重排除）",
    status: "completed" as const,
  },
  {
    id: "r8-commits",
    content: "vkr 探针与兜底提交 574ce59b；文档与记忆 89fc03534",
    status: "completed" as const,
  },
  {
    id: "r9-rebuild",
    content: "MoltenVK main@67b2682 重建完成（Xcode 26.3，SPIRV-Cross aa217aeb 含 sampler 保留字修复）",
    status: "completed" as const,
  },
  {
    id: "r9-swap",
    content: "ICD 换装 + 揪出部署劫持（DYLD_LIBRARY_PATH 下 @rpath 标识符落到 brew 1.4.2）；唯一 install name 修复后 vkprobe 真 1.4.3 PASS",
    status: "completed" as const,
  },
  {
    id: "r9-e2e",
    content: "e2e 复测：shader 失败归零、~6s 冻结未复现（卡点同源成立）、心跳 11 分钟+；scanout 纯黑归因到 pre-existing shell SIGSEGV@0x15c",
    status: "completed" as const,
  },
  {
    id: "r9-60hz",
    content: "deadline_to_presentation_p50=14.96ms 首次进 16.6ms 预算；稀疏帧 2.0s（无输入事件驱动形态），持续 60Hz 待内容帧后测量",
    status: "pending" as const,
  },
  {
    id: "r9-stall",
    content: "ring 卡点无需 lldb——重建后未复现，第八轮「同源」假设成立",
    status: "completed" as const,
  },
  {
    id: "r9-docs",
    content: "结果回写文档 / AGENTS.md 记忆 / 本 canvas",
    status: "completed" as const,
  },
  {
    id: "r10-shell",
    content: "下一手：shell SIGSEGV@VA:0x15c 取栈（mini-strace/audit，第三轮遗留 next-step）——桌面内容上屏的唯一剩余阻塞",
    status: "pending" as const,
  },
];

const commitHeaders = ["仓库 / 栈", "提交", "内容"];
const commitAlign: Array<TableColumnAlign | undefined> = ["left", "left", "left"];
const commitRowTones: Array<TableRowTone | undefined> = [
  "success", "success", "success", "success",
];
const commitRows = [
  [
    "virglrenderer（darwin-venus 本地栈）",
    <Code>1f97b006 + 574ce59b</Code>,
    "创建失败 null stub / BindPipeline null 跳过 / 无 pipeline draw 跳过 / SPIR-V 剥名与落盘探针 / sync 停滞日志 / 禁 retry 注释",
  ],
  [
    "tgoskits 内核（local/venus-into-dev-0924）",
    <Code>d08ca64bd</Code>,
    "out-syncobj 推迟到宿主 fence retire + orphan retire 竞态修复",
  ],
  [
    "tgoskits 文档",
    <Code>89fc03534</Code>,
    "第八轮黑屏归因补记 + 对照组环境事实",
  ],
  [
    "denial 工作树",
    <Code>3cab163</Code>,
    "Skia present 修复 + 心跳双通道 + 主循环 phase 相位码",
  ],
];

const memoHeaders = ["备忘", "内容"];
const memoAlign: Array<TableColumnAlign | undefined> = ["left", "left"];
const memoRows = [
  [
    "对照组差异（用户提示）",
    "llvmpipe 组 = brew QEMU（Dock 图标不同源）+ 2D virtio-gpu EDID 的 1280x800；venus 组 = 自建 QEMU + venus 模式 640x480",
  ],
  [
    "禁 retry（已验证）",
    "第二次 vkCreatePipelineCache 会把 ring 线程卡死在驱动调用内部——失败后只能 null stub 直接过",
  ],
  [
    "换装验证纪律（第九轮教训）",
    "dyld 会把 ICD 的 @rpath 标识符经 DYLD_LIBRARY_PATH 解析到 brew 同名库——换装验证必须核对日志里的 MoltenVK version 行",
  ],
  [
    "MVK 调试开关",
    "MVK_CONFIG_LOG_LEVEL=3 + MVK_CONFIG_REDIRECT_LOGGING_TO_STDERR=1 可在 QEMU stderr 抓 MVK 错误与 program_source；VK_LOADER_DEBUG=all 抓 ICD 选择",
  ],
  [
    "已排除项",
    "SINGLE_QUEUE 信号量风格（=0 无效）、参数缓冲模式（=0 无效）、OpName 来源（改写后错误原样）、guest mesa 磁盘缓存（条目零 sampler 零 MSL）",
  ],
];

export default function VenusClosureStatus(): JSX.Element {
  const theme = useHostTheme();
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>venus/zink 加速桌面 — MoltenVK 重建收官与 ring 卡点闭合</H1>
      <Text>
        第九轮收官（2026-10-11，Xcode 重建轮）。用户装好完整 Xcode 后按第八轮
        修复路径重建 MoltenVK：main@67b2682 + SPIRV-Cross aa217aeb（sampler
        保留字修复确认在内）。首轮复测错误逐字节复现，追查出比 shader 更深的
        ICD 部署劫持（DYLD_LIBRARY_PATH 下 @rpath 标识符被解析到 brew 1.4.2），
        修复后真 1.4.3 复测：shader 失败归零、~6s 冻结未复现（第八轮「同源」
        假设成立）、deadline 首次进入 16.6ms 预算。黑屏的剩余阻塞重新归因到
        pre-existing 的 shell SIGSEGV@0x15c。
      </Text>

      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat value="0 个" label="Shader library compile failed（第八轮每轮必现）" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="11 分钟+" label="compositor 心跳存活（第八轮 ~6 秒冻结）" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="14.96ms" label="deadline_to_presentation_p50（首次进 16.6ms 预算）" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat value="100% 黑" label="scanout 现状：shell SIGSEGV@0x15c（pre-existing）" tone="warning" />
          </CardBody>
        </Card>
      </Grid>

      <Callout tone="danger" title="本轮最重要的新发现：ICD 部署劫持">
        <Text>
          独立 ICD json（VK_DRIVER_FILES 指向）写好后，render server 仍加载
          brew 1.4.2（日志 MoltenVK version 1.4.2 实锤，同环境宿主探针是
          1.4.3）。VK_LOADER_DEBUG=all 抓到 dyld 把 @rpath/libMoltenVK.dylib
          标识符解析落到 /opt/homebrew/lib/libMoltenVK.dylib——触发条件是
          DYLD_LIBRARY_PATH 含 /opt/homebrew/lib（vkr dlopen("libvulkan.dylib")
          找 loader 需要）。修复：dylib 复制到 prefix/lib 用 install_name_tool
          -id 改唯一 install name + ad-hoc codesign。教训：换装验证必须核对
          日志里的 MoltenVK version 行——此前的「vkprobe 全绿」全部跑在被
          劫持的 1.4.2 上。
        </Text>
      </Callout>

      <Callout tone="success" title="第八轮两大断点在真 1.4.3 上的复测判定">
        <Text>
          （1）Shader library compile failed：每轮必现 → 0，pipeline 全真
          （stub=0）。（2）ring ~6 秒内部冻结（phase=1000 停摆 + 内核
          syncobj stall + vkr sync 3s 超时）：未复现——「卡点是被拒 shader
          下游」的同源假设成立，无需 lldb 定位。vkWaitVirtqueueSeqnoMESA
          waiting→done 正常 retire，flip 循环健康，dispatch_seq 780 万持续
          增长（stale_ms=1 非冻结）。vkprobe 21 步在真 1.4.3 重跑 PASS
          （BAR 往返 + compute 读回 4/4，hostmem 路径无回归）。
        </Text>
      </Callout>

      <Card>
        <CardHeader>
          <H2>归因链 A — 创建失败链（已修复/已兜底）</H2>
        </CardHeader>
        <CardBody>
          <ArchGraph nodes={fixedChain.nodes} edges={fixedChain.edges} direction="vertical" />
          <Divider />
          <Text>
            第七轮已修：宿主创建失败不再静默（null stub + 先捕获 guest id），
            ring 从每轮必死转为存活（exiting ret=-22 = 0）；内核 out-syncobj
            推迟到宿主 fence retire 并修复 orphan 竞态。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>归因链 B — ring 内部卡点（活跃，第八轮定位）</H2>
        </CardHeader>
        <CardBody>
          <ArchGraph nodes={stallChain.nodes} edges={stallChain.edges} direction="vertical" />
          <Divider />
          <Text>
            ~6 秒处合成器冻结于 phase=1000（dispatch 内），内核 stall 告警
            syncobj 11 等待 queue=[122,124] 永不 retire；宿主 ring 解析行在
            冻结时刻停止、vkr sync 线程零 3s 超时——ring 线程卡死在某个
            MoltenVK 调用内部并持有 queue vk_mutex。已排除：SINGLE_QUEUE
            信号量风格、参数缓冲模式、OpName 来源。
          </Text>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <H2>取证证据</H2>
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
          <H2>第九轮任务清单（收官）与下一手</H2>
        </CardHeader>
        <CardBody>
          <TodoListCard todos={planItems} />
          <Divider />
          <Callout tone="info" title="换装产物与脚本（第九轮落地）">
            <Text>
              产物：~/venus-stack/prefix/lib/libMoltenVK-main.dylib（唯一
              install name）+ prefix/share/vulkan/icd.d/MoltenVK-main_icd.json；
              源树 ~/venus-stack/src/MoltenVK（main@67b2682，含 R9-PROBE
              仪表：fresh-spv/cache-msl 构造器与 readData initialData/UUID/
              条目数日志）。启动脚本 qstart-alpine-mvkmain.sh（vkprobe）与
              qstart-denial-e2e.sh（Cocoa e2e）均指向新 ICD；后者已修
              「脚本内 rm 重定向目标 → MVK 日志变已删除 inode」坑。busybox
              wget --post-file 会把 URL 基名当响应体落盘，/tmp/snap 残留后
              后续 POST 全失败——每轮只有前 1-2 个快照送达。
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
              设计文档（§黑屏归因与 MoltenVK 内部卡点）：
              <FL path="design/starry-venus-into-dev-card0.md" label="docs/design/starry-venus-into-dev-card0.md" />
            </Text>
            <Text>
              项目记忆：
              <FL path="../AGENTS.md" label="AGENTS.md §3" />
            </Text>
            <Text>
              vkr 探针与兜底：
              <FL
                path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_pipeline.c"
                label="vkr_pipeline.c"
              />
              {" / "}
              <FL
                path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_command_buffer.c"
                label="vkr_command_buffer.c"
              />
              {" / "}
              <FL
                path="/Users/herbcheng/venus-stack/src/virglrenderer/src/venus/vkr_queue.c"
                label="vkr_queue.c"
              />
            </Text>
            <Text>
              内核 fence 注册表：
              <FL path="../os/StarryOS/kernel/src/pseudofs/dev/vgpu.rs" label="pseudofs/dev/vgpu.rs" />
            </Text>
            <Text>
              deniald 心跳与相位码：
              <FL
                path="/Users/herbcheng/denial/compositor/src/bin/deniald/liveness_probe.rs"
                label="liveness_probe.rs"
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
        <Pill active>第九轮收官</Pill>
        <Pill>MoltenVK 1.4.3 上栈</Pill>
        <Pill>shader 失败归零</Pill>
        <Pill>ring 卡点闭合</Pill>
        <Pill>deadline 进预算</Pill>
      </Row>
      <Text>
        状态基调：第八轮收敛的两件事均已按预期路径修复——上游 SPIRV-Cross
        保留字缺失（重建即愈，实测归零）与 MoltenVK 内部 ring 卡点（确认为
        被拒 shader 的下游，重建后未复现）。桌面内容上屏的唯一剩余阻塞是
        pre-existing 的 shell SIGSEGV@VA:0x15c（第三轮遗留，与 MoltenVK
        无关）；60Hz 持续帧率测量等内容帧恢复后进行。
      </Text>
    </Stack>
  );
}
