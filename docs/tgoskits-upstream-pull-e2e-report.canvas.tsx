import {
  Stack, Grid, H1, H2, H3, Text, Card, CardHeader, CardBody,
  Table, Stat, Callout, Code, CodeBlock, Divider,
  ArchGraph, FileLink, useHostTheme, useCanvasAction,
  type TableRowTone,
} from "cursor/canvas";

function FL({ path, line, label }: { path: string; line?: number; label: string }) {
  const dispatch = useCanvasAction();
  return <FileLink path={path} line={line} label={label} dispatch={dispatch} />;
}

const mergeGraph = {
  nodes: [
    { id: 'base', label: 'fd63e7525' },
    { id: 'fake', label: '8c1009eed 伪合并' },
    { id: 'doc', label: 'a7793b350 docs' },
    { id: 'up', label: 'origin/dev' },
    { id: 'merge', label: '797b9b4b4 合并' },
    { id: 'bk', label: 'backup 分支' },
  ],
  edges: [
    { from: 'base', to: 'fake' },
    { from: 'fake', to: 'doc' },
    { from: 'base', to: 'up', label: '+209 提交' },
    { from: 'doc', to: 'merge' },
    { from: 'up', to: 'merge', label: '上游为基准' },
    { from: 'bk', to: 'doc', label: '备份' },
  ],
};

function SummaryStrip() {
  return (
    <Grid columns={4} gap={12}>
      <Card>
        <CardBody>
          <Stat value="1 项" label="上游未实现的本地功能（lock-lint），实测可用" tone="success" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="3 OS" label="QEMU e2e 覆盖 aarch64（ArceOS / Starry / Axvisor）" tone="info" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="876/885" label="std 测试通过；9 项失败为 macOS 环境问题" tone="warning" />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Stat value="全绿" label="Axvisor 8 案例（清除陈旧构建缓存后）" tone="success" />
        </CardBody>
      </Card>
    </Grid>
  );
}

function MergeBackground() {
  return (
    <Card>
      <CardHeader>
        <H3>合并背景：单亲伪合并导致 353 个冲突</H3>
      </CardHeader>
      <CardBody>
        <Stack gap={8}>
          <Text>
            本地的 <Code>8c1009eed "Merge origin/dev into local dev"</Code> 实为单亲提交，
            只把一份 8 月中的上游快照拷入本地，历史从未真正与上游合流（真实合并基停留在
            <Code> fd63e7525</Code>）。拉取时 353 个文件冲突，按「以上游为基准」全部解决，
            仅保留 <Code>a7793b350</Code> 的 canvas 文档与 19 个本地独有文件。
          </Text>
          <ArchGraph nodes={mergeGraph.nodes} edges={mergeGraph.edges} direction="vertical" />
          <Text>
            验证环境：macOS arm64 · QEMU 11.0.3 · nightly-2026-09-04 · 上游 HEAD
            <Code> 9f75284ab</Code>（2026-09-04）。合并前状态备份于
            <Code> backup/dev-pre-upstream-pull-20260905</Code>。
          </Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

type LocRow = {
  local: string;
  upstream: React.ReactNode;
  verdict: string;
  note: React.ReactNode;
  tone: TableRowTone;
};

const localRows: LocRow[] = [
  {
    local: 'lock_lint.rs + lock_lint.md',
    upstream: <Text>无（全仓库零引用）</Text>,
    verdict: '仍有效',
    note: (
      <Text>
        scratch worktree 接线 3 行后对当前 axbuild 编译 0 错误，对合并树运行
        all lock-lint checks passed；规则与上游锁重构（ax-kspin/ax-lockdep 移除）一致。
        本地实现见 <FL path="../scripts/axbuild/src/lock_lint.rs" label="scripts/axbuild/src/lock_lint.rs" />，
        文档见 <FL path="docs/build/lock_lint.md" label="docs/docs/build/lock_lint.md" />。
      </Text>
    ),
    tone: 'success',
  },
  {
    local: 'os/axvisor/src/virtio_blk.rs',
    upstream: (
      <FL
        path="../virtualization/axvm/src/configured/devices/virtio_blk.rs"
        label="axvm/configured/devices/virtio_blk.rs"
      />
    ),
    verdict: '已被取代',
    note: <Text>同血缘演进版：上游 844 行 vs 本地 797 行，注册点已迁入 axvm 设备图。</Text>,
    tone: 'info',
  },
  {
    local: 'axvm configured/ivc.rs + machine/ivc.rs',
    upstream: (
      <FL
        path="../virtualization/axvm/src/configured/devices/ivc.rs"
        label="axvm/configured/devices/ivc.rs"
      />
    ),
    verdict: '已被取代',
    note: <Text>上游 #1834 IVC demo 与 #2268 IVC 基准已落地（axivc / axhvc crate）。</Text>,
    tone: 'info',
  },
  {
    local: 'axtask/src/sync/axtest.rs',
    upstream: <Text>上游自带测试组织</Text>,
    verdict: '陈旧死代码',
    note: <Text>引用的 rwlock_*_hold_for_test() 在当前树已不存在，接线也无法编译。</Text>,
    tone: 'danger',
  },
  {
    local: 'axsync/src/axtest.rs',
    upstream: <Text>上游自带测试组织</Text>,
    verdict: '冗余',
    note: <Text>SpinLock / SpinRwLock 仍导出、可编译，但未接线且与上游测试重复。</Text>,
    tone: 'warning',
  },
  {
    local: 'axplat_crates/examples/*.lds ×3',
    upstream: <Text>platforms/ax-plat</Text>,
    verdict: '陈旧残留',
    note: <Text>整个 axplat_crates 已被上游删除，上游全仓库已无任何 .lds 文件。</Text>,
    tone: 'danger',
  },
  {
    local: 'canvas / 分析文档等 ×7',
    upstream: <Text>无</Text>,
    verdict: '本地产物',
    note: <Text>与构建无关，保留；其中 canvas 文档见下一节论断复核。</Text>,
    tone: 'neutral',
  },
];

function LocalVerdict() {
  return (
    <Card>
      <CardHeader>
        <H3>本地提交/文件逐项判定（19 个本地独有文件按类归并）</H3>
      </CardHeader>
      <CardBody>
        <Table
          headers={['本地内容', '上游对应实现', '判定', '依据']}
          rows={localRows.map((r) => [r.local, r.upstream, r.verdict, r.note])}
          rowTone={localRows.map((r) => r.tone)}
        />
      </CardBody>
    </Card>
  );
}

type ClaimRow = {
  claim: string;
  evidence: React.ReactNode;
  verdict: string;
  tone: TableRowTone;
};

const claimRows: ClaimRow[] = [
  {
    claim: '9.4 #2007 取代本地 QEMU 9 GIC workaround',
    evidence: <Text>989954f54 已在上游；本次全部 QEMU aarch64 测试在无本地兜底下通过。</Text>,
    verdict: '成立',
    tone: 'success',
  },
  {
    claim: '(1) bindgen 只写请求 target 的 env 变体',
    evidence: (
      <Text>
        <FL path="../scripts/axbuild/src/build/std_build.rs" line={125} label="std_build.rs:125" />
        {' '}仍只写 BINDGEN_EXTRA_CLANG_ARGS_&#123;target_env&#125;；实测复现
        string.h not found，文档的 musl sysroot 环境变量 workaround 有效。
      </Text>
    ),
    verdict: '成立',
    tone: 'success',
  },
  {
    claim: '(2) musl_toolchain_sysroot 用 -print-sysroot 无 fallback',
    evidence: (
      <Text>
        <FL path="../scripts/axbuild/src/build/std_build.rs" line={160} label="std_build.rs:160" />
        {' '}失败时静默返回 None，无 xcrun / homebrew gcc 回退。
      </Text>
    ),
    verdict: '成立',
    tone: 'success',
  },
  {
    claim: '(3) rootfs 拉取无 mirror / 缓存复用',
    evidence: <Text>registry 化 image pull（sha256 校验复用）+ rootfs-cache-key + 共享 rootfs 缓存已落地。</Text>,
    verdict: '已过时',
    tone: 'danger',
  },
];

function CanvasClaims() {
  return (
    <Card>
      <CardHeader>
        <H3>canvas 文档（a7793b350）论断复核</H3>
      </CardHeader>
      <CardBody>
        <Stack gap={8}>
          <Text>
            对照对象：
            <FL
              path="tgoskits-arm64-macos-build-process.canvas.tsx"
              label="tgoskits-arm64-macos-build-process.canvas.tsx"
            />
            {' '}第 9.4 / 9.5 节。
          </Text>
          <Table
            headers={['论断', '当前代码证据', '结论']}
            rows={claimRows.map((r) => [r.claim, r.evidence, r.verdict])}
            rowTone={claimRows.map((r) => r.tone)}
          />
          <Text>结论：9.5 节的 (1)(2) 仍然成立且本次被实测复现；(3) 已被上游解决，建议更新该条目。</Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

type E2eRow = {
  item: string;
  result: string;
  note: React.ReactNode;
  tone: TableRowTone;
};

const e2eRows: E2eRow[] = [
  {
    item: 'ArceOS QEMU 套件（aarch64）',
    result: '通过',
    note: <Text>rust 组 2/2 + C 组 1/1，全部 PASS。</Text>,
    tone: 'success',
  },
  {
    item: 'StarryOS ktest（starry-kernel）',
    result: '11/11 通过',
    note: <Text>AXTEST_SUMMARY pass=11 fail=0，含 perf sampling 等内核用例。</Text>,
    tone: 'success',
  },
  {
    item: 'StarryOS GICv2 SMP4 启动',
    result: '通过',
    note: <Text>STARRY_AARCH64_GICV2_BOOT_PASSED，进到 root shell。</Text>,
    tone: 'success',
  },
  {
    item: 'StarryOS test qemu 套件',
    result: '3/3 全通过（axbuild 修复后闭环）',
    note: (
      <Text>
        初判「解包基建缺口」根因更正为 homebrew fakeroot 拆参假成功；随后为闭环 macOS 设计意图修改
        axbuild：extract_rootfs 直执 + 顶层完整性校验、C 子用例交叉工具链原生回退（无 qemu-user 时用
        &#123;prefix&#125;-&#123;tool&#125; 宿主工具）、readelf 候选扩展、prebuild.sh 响亮跳过 +
        apk-curl-equivalence 条件跳过。最终 qemu-rga/system、qemu/system（463/463 系统子用例）、
        tty-console-input-burst 全部 PASS（见下方追加复现卡）。
      </Text>
    ),
    tone: 'success',
  },
  {
    item: 'Axvisor QEMU 全部 8 案例',
    result: '全部通过',
    note: <Text>smoke、panic×2、console 回归×2、http-control-plane、browser-console、qemu-ivc（recv 5/5）、gicv2/gicv3-timer-stress。</Text>,
    tone: 'success',
  },
  {
    item: 'std 测试（cargo xtask test）',
    result: '876/885',
    note: <Text>9 项失败全在 axbuild 宿主测试（临时目录双斜杠等），纯 origin/dev 完全一致；23 包连带失败源于 cpu-local 在 Mach-O 无法编译。</Text>,
    tone: 'warning',
  },
  {
    item: 'clippy --all',
    result: 'macOS 不可用',
    note: <Text>cpu-local 的 .percpu.* ELF section 在 Mach-O host target 非法；纯 origin/dev 同样失败，上游仅在 Linux CI 验证。</Text>,
    tone: 'warning',
  },
  {
    item: 'lock-lint 实测（scratch 接线）',
    result: '通过',
    note: <Text>编译 0 错误 + 对合并树规则全部 PASS。</Text>,
    tone: 'success',
  },
];

function E2eResults() {
  return (
    <Card>
      <CardHeader>
        <H3>全量 e2e 结果（aarch64，macOS 宿主）</H3>
      </CardHeader>
      <CardBody>
        <Table
          headers={['验证项', '结果', '证据 / 备注']}
          rows={e2eRows.map((r) => [r.item, r.result, r.note])}
          rowTone={e2eRows.map((r) => r.tone)}
        />
      </CardBody>
    </Card>
  );
}

const reproRows: Array<[string, string, React.ReactNode, TableRowTone]> = [
  [
    'GICv2 SMP4 启动',
    'exit 0',
    <Text>STARRY_AARCH64_GICV2_BOOT_PASSED 自动匹配，进入 root shell（--smp 4 + gicv2-boot 配置，修复后复验）。</Text>,
    'success',
  ],
  [
    'ktest starry-kernel',
    '11/11',
    <Text>AXTEST_SUMMARY pass=11 fail=0 skip=0（修复后复验）。</Text>,
    'success',
  ],
  [
    '套件 qemu-rga/system（rga-lifecycle C 子用例）',
    'PASS',
    <Text>C 子用例由原生交叉工具链构建（Apple clang + aarch64-linux-musl binutils），qemu 里运行通过。</Text>,
    'success',
  ],
  [
    '套件 qemu/system（分组系统用例）',
    '463/463',
    <Text>STARRY_SYSTEM_TEST_SUMMARY total=463 passed=463 failed=0，245 秒；prebuild.sh 响亮跳过、apk-curl-equivalence 显式条件跳过（CMakeLists STATUS 标记）。</Text>,
    'success',
  ],
  [
    '套件 tty-console-input-burst',
    'PASS',
    <Text>3/3 case(s) passed，all starry qemu tests passed，exit 0。</Text>,
    'success',
  ],
];

function StarryRepro() {
  return (
    <Card>
      <CardHeader>
        <H3>追加复现与闭环：StarryOS 全量 e2e（2026-09-05，合并树 + axbuild 修复）</H3>
      </CardHeader>
      <CardBody>
        <Stack gap={8}>
          <Text>
            按 CI 检查（.github/ci/checks/starry.toml 的 aarch64 项）在合并树 797b9b4b4 上完整复现，
            并为闭环 macOS 设计意图修改 axbuild 后达到全量通过：
          </Text>
          <Table
            headers={['复现步骤', '结果', '证据']}
            rows={reproRows.map((r) => [r[0], r[1], r[2]])}
            rowTone={reproRows.map((r) => r[3])}
          />
          <H3>根因实验：homebrew fakeroot 假成功</H3>
          <CodeBlock
            language="text"
            code={`# ① 伪 root 未生效
$ fakeroot -- id -u
501

# ② fakeroot 包裹 rdump：exit 0，但 0 个文件（引号被拆，/ 被当镜像打开）
$ fakeroot -- debugfs -R "rdump / /tmp/out" rootfs-aarch64-alpine.img
debugfs: Is a directory while trying to open /
rdump: Usage: rdump <directory>... <native directory>
$ find /tmp/out | wc -l
1

# ③ 裸 debugfs rdump：exit 0，5826 项完整解出（仅 2 条无害 chown 告警）
$ debugfs -R "rdump / /tmp/out" rootfs-aarch64-alpine.img
$ find /tmp/out | wc -l
5826`}
          />
          <H3>axbuild 修改清单（测试先行，clippy 全绿）</H3>
          <Table
            headers={['文件', '修改', '动机']}
            rowTone={['success', 'success', 'success', 'success', 'success'] as Array<TableRowTone | undefined>}
            rows={[
              [
                'rootfs/inject.rs',
                '非 Linux 宿主不再包 fakeroot（homebrew fakeroot 拆参假成功）；rdump 后用 ls -p / 校验镜像顶层条目全部落地',
                '静默空解包在退出码层面不可检测，必须校验完整性',
              ],
              [
                'test/build/toolchain.rs + env.rs + c.rs + grouped_c.rs + rust.rs',
                '新增 GuestToolExecution：有 qemu-user 走原模拟路径；否则回退宿主原生 {gnu_tool_prefix}-{tool} 交叉工具写包装器',
                'QEMU linux-user 仅支持 Linux host，C 子用例跨编译在 macOS 需原生 binutils',
              ],
              [
                'rootfs/runtime.rs',
                'readelf 解析扩展为 readelf / llvm-readelf / {prefix}-readelf 候选',
                '运行库同步用宿主 readelf，macOS 无裸 readelf',
              ],
              [
                'test/build/{env,c,grouped_c,rust}.rs',
                'prebuild.sh 在原生模式下响亮跳过（println 说明原因与运行期后果）',
                'prebuild 以客户机进程跑在 qemu-user 内，无 qemu 无法执行；不得静默',
              ],
              [
                'test-suit/.../apk-curl-equivalence/CMakeLists.txt',
                'staging root 无 curl 时 STATUS 显式跳过（原 FATAL_ERROR 阻断整组 482 用例）',
                '该子用例验证 apk 安装的 curl，仅在能跑 apk 的宿主有意义',
              ],
            ]}
          />
          <Callout tone="info" title="闭环前的临时诊断手段（已被代码修复取代）">
            <Text>
              定位期间用 /tmp/fakeroot-shim（exec "$@" 透传）验证过 fakeroot 是唯一故障点；
              根因链见 <FL path="../scripts/axbuild/src/rootfs/inject.rs" line={120} label="extract_rootfs" />
              {' '}与 <FL path="../scripts/axbuild/src/rootfs/inject.rs" line={167} label="run()" />（原先只查退出码）。
              新增环境前置：brew install cmake（C 管线宿主工具）。
            </Text>
          </Callout>
        </Stack>
      </CardBody>
    </Card>
  );
}

function StaleCacheFinding() {
  return (
    <Card>
      <CardHeader>
        <H3>根因定位：陈旧构建缓存导致 axvisor 假失败（已解决）</H3>
      </CardHeader>
      <CardBody>
        <Stack gap={8}>
          <Text>
            http-control-plane / browser-console / gicv3-timer-stress 最初确定性挂起，但
            纯 origin/dev worktree 上却通过。对比发现主树复用了 pull 之前旧本地线的
            构建产物（fingerprint 跨目标规格 / 源替换失效）。
          </Text>
          <Table
            headers={['观测', '主树（陈旧缓存）', '清缓存后 / 纯 origin/dev']}
            rows={[
              ['axvisor musl-PIE 二进制体积', '5.5 MB', '60.6 MB（两树一致）'],
              ['http-control-plane', 'banner 后挂起，120s probe 超时', '7.6s 通过（1/1）'],
              ['gicv3-timer-stress', 'serial init 后挂起，600s 超时', '27.8s 通过（1/1）'],
            ]}
          />
          <Callout tone="warning" title="建议：本次合并等价于一次大规模源替换">
            <Text>
              保险起见执行 cargo clean，或至少清理 target/aarch64-unknown-linux-musl、
              target/axvisor-qemu-artifacts-*、tmp/axbuild/axvisor，避免其他流程复用
              pre-merge 产物。
            </Text>
          </Callout>
        </Stack>
      </CardBody>
    </Card>
  );
}

function EnvFindings() {
  return (
    <Card>
      <CardHeader>
        <H3>macOS 环境问题与可用 workaround</H3>
      </CardHeader>
      <CardBody>
        <Table
          headers={['问题', '现象', '处置']}
          rowTone={['danger', 'warning', 'info', 'info', 'info'] as Array<TableRowTone | undefined>}
          rows={[
            [
              'homebrew fakeroot 假成功（已定位根因）',
              'macOS 上拆坏 debugfs -R 引号参数，rdump 报 usage 错误却 exit 0，axbuild 只查退出码 → 静默空解包',
              'PATH 前置 exec "$@" 透传 shim 后裸 debugfs rdump 完整解出 5826 项；建议向上游反馈增加完整性校验',
            ],
            [
              '套件 C 子用例需 host qemu-user（已闭环）',
              'required host binary not found: qemu-aarch64-static / qemu-aarch64',
              'axbuild 已支持无 qemu-user 时回退宿主原生 {gnu_tool_prefix}-{tool} 交叉工具；宿主仅剩 apk prebuild 不可执行（响亮跳过），apk-curl-equivalence 条件跳过',
            ],
            [
              'lwprintf-rs bindgen 无 sysroot',
              'string.h not found（canvas 文档遗留问题 (1)）',
              '设 BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl=--sysroot=$(aarch64-linux-musl-gcc -print-sysroot) 后正常',
            ],
            [
              'debugfs 不在 PATH',
              'failed to spawn debugfs',
              'PATH 前置 /opt/homebrew/opt/e2fsprogs/sbin（keg-only）',
            ],
            [
              '测试资产未预置',
              'linux-qemu not found',
              '按 CI manifest（.github/ci/checks/axvisor.toml）先执行 image pull',
            ],
          ]}
        />
        <Divider />
        <Text>
          CI 资产预置流程见{' '}
          <FL path="../.github/ci/checks/axvisor.toml" label=".github/ci/checks/axvisor.toml" />
          {' '}：cargo xtask image pull qemu-aarch64 --extract-dir tmp/axbuild/images。
        </Text>
      </CardBody>
    </Card>
  );
}

function FollowUps() {
  const theme = useHostTheme();
  return (
    <Card>
      <CardHeader>
        <H3>后续建议</H3>
      </CardHeader>
      <CardBody>
        <Stack gap={6}>
          <Text>
            <Code>1</Code>{'  '}lock-lint 恢复接线（mod + clap 变体 + match 分支共 3 行）并考虑作为 PR 提交上游——
            它是唯一上游没有且实测可用的本地功能。
          </Text>
          <Text>
            <Code>2</Code>{'  '}更新 canvas 文档 9.5 节第 (3) 条：rootfs 缓存已被上游 registry 化方案解决。
          </Text>
          <Text>
            <Code>3</Code>{'  '}大合并后清理构建缓存，防止陈旧产物假失败（本次 3 个 axvisor 假失败的根因）。
          </Text>
          <Text>
            <Code>4</Code>{'  '}向上游反馈/提交：axbuild 的 fakeroot 假成功修复 + 提取完整性校验 +
            原生交叉工具链回退 + prebuild 响亮跳过（本次已在本地验证，可整理为 PR）；
            以及 std 测试与 clippy 在 macOS host target 的 Mach-O 限制。
          </Text>
          <Text style={{ color: theme.text.tertiary }}>
            报告生成：2026-09-05 · 合并提交 797b9b4b4 · 上游 9f75284ab · 分支 dev（领先 origin/dev 3 个提交，未推送）
          </Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

export default function UpstreamPullE2eReport(): JSX.Element {
  return (
    <Stack gap={16} style={{ padding: 28 }}>
      <H1>TGOSKits 上游拉取验证：本地提交有效性 × 全量 e2e</H1>
      <SummaryStrip />
      <Callout tone="success" title="核心结论">
        <Text>
          合并后的树是健康的：三大 OS 的 QEMU e2e 在清除一处陈旧构建缓存后全部通过，
          所有 std 测试 / clippy 失败均为 macOS 环境问题且在纯 origin/dev 上完全复现。
          本地提交中仅 lock-lint 是上游没有的存活功能（实测可用），其余本地内容已被上游收编或陈旧。
          StarryOS 可用性已按 CI aarch64 检查全步闭环：boot、ktest 与 starry test qemu 全套件
          （含 463 个系统 C 子用例）全部通过，唯一环境差异是 apk prebuild 在无 qemu-user 宿主上
          响亮跳过（apk-curl-equivalence 子用例随之显式跳过）。
        </Text>
      </Callout>
      <MergeBackground />
      <LocalVerdict />
      <CanvasClaims />
      <E2eResults />
      <StarryRepro />
      <StaleCacheFinding />
      <EnvFindings />
      <FollowUps />
    </Stack>
  );
}
