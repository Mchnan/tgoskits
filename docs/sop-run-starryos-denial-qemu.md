# SOP：编译并运行 StarryOS denial 桌面 QEMU 产物（macOS arm64 宿主）

状态：2026-09-09 端到端实测通过（LP_NUM_THREADS=1 下锁屏约 t50s 出画）。
适用：本仓库快照分支 `fix/starry-arm64-desktop-snapshot-20260908` 的产物。
环境：macOS arm64（HVF）+ Homebrew QEMU ≥ 11。

## 0. 最重要的三条（血泪）

1. **deniald 必须带 `--flutter-bundle /opt/denial/shell-bundle`**。缺了它**没有任何
   报错**，只是静默降级 diagnostic-atlas 诊断模式：蓝屏闪一下（诊断图集蓝矩形）→
   永远黑屏 + 光标可动、无锁屏。识别标志：`/tmp/dd.log` 里
   `presentation="diagnostic-atlas"`。正常应是 `presentation="native-output-pools"`，
   且后续出现 `Using the Impeller rendering backend`、
   `started Rust Flutter embedder`、`synchronized Flutter desktop visibility`。
2. **绝不能硬杀 QEMU**（宿主 SIGTERM / `\x01x`）：guest ext4 目录项存活但数据块
   未落盘，文件变全零，e2fsck 只修元数据救不回数据。关机一律 guest 内
   `sync; poweroff`。
3. **同一 rootfs 镜像同时只能开一个 QEMU**（写锁），第二个会
   "Failed to get write lock" 启动失败。

## 1. 编译

每次新 shell 都要设置（勿写进 rc，会影响其它架构 target；跑完 unset）：

```bash
export PATH="/opt/homebrew/opt/e2fsprogs/sbin:/opt/homebrew/opt/e2fsprogs/bin:/opt/homebrew/opt/aarch64-unknown-linux-musl/bin:/opt/homebrew/opt/aarch64-unknown-linux-gnu/bin:$PATH"
SYSROOT=$(aarch64-linux-musl-gcc -print-sysroot)
TOOLCHAIN=$(realpath /opt/homebrew/opt/aarch64-unknown-linux-musl/bin/..)
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl="--target=aarch64-linux-musl --sysroot=$SYSROOT --gcc-toolchain=$TOOLCHAIN -isystem $SYSROOT/include"

cargo xtask starry build -c os/StarryOS/configs/board/qemu-aarch64.toml --smp 4
unset BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl
```

- 产物：`target/aarch64-unknown-none-softfloat/release/starryos.bin`。
- 这套 env 是给 lwprintf-rs 的 bindgen 用的（它内部把 TARGET 改成 musl，
  Apple clang 无 `-print-sysroot`，必须喂 homebrew musl gcc 的 sysroot）。
- 需要 rootfs 时的来源：`tmp/axbuild/rootfs/rootfs-aarch64-denial-full.img`
  （已含 deniald + Flutter bundle + gcompat 垫片 + libdenialshim）。

## 2. 启动 QEMU（仓库根目录）

```bash
qemu-system-aarch64 -machine virt -cpu max -accel hvf -smp 4 -m 2048M \
  -display cocoa,show-cursor=on \
  -monitor unix:/tmp/qemu-monf.sock,server,nowait \
  -device virtio-gpu-pci \
  -device virtio-keyboard-pci -device virtio-mouse-pci \
  -device nvme,drive=disk0,serial=tgoskits,max_ioqpairs=64,msix_qsize=65 \
  -drive id=disk0,if=none,format=raw,file=tmp/axbuild/rootfs/rootfs-aarch64-denial-full.img \
  -append "root=/dev/nvme0n1 console=ttyS0" \
  -serial stdio \
  -kernel target/aarch64-unknown-none-softfloat/release/starryos.bin
```

- cocoa 窗口 = 显示器；终端 = guest 串口控制台；约 30–60s 出 `root@starry`
  提示（直接是 root shell，无 login 密码）。
- `-monitor .../qemu-monf.sock` 供 screendump / sendkey 用（见 §5）。

## 3. 启动 denial 桌面（已实测命令，逐字符照抄）

```bash
mkdir -p /tmp/.X11-unix; chmod 1777 /tmp/.X11-unix
export LIBGL_ALWAYS_SOFTWARE=1 LIBSEAT_BACKEND=noop XDG_RUNTIME_DIR=/tmp \
       DENIA_NO_PREDECESSOR=1 LD_PRELOAD=/usr/lib/libdenialshim.so \
       DENIA_RENDER_AUDIT=1 LP_NUM_THREADS=1
/usr/bin/deniald --device /dev/dri/card0 --wayland \
  --flutter-bundle /opt/denial/shell-bundle >/tmp/dd.log 2>&1 &
```

各参数缺一不可的原因：
- `--flutter-bundle`：不带 = 诊断模式（见 §0.1）。
- `LD_PRELOAD=libdenialshim.so`：Rust std 引用 `__res_init`，gcompat 不提供，
  缺了 deniald 直接 exit 127。
- `DENIA_NO_PREDECESSOR=1`：跳过"前任 KMS 状态"捕获（unikernel 冷启动没有
  已绑定的 plane）。
- `LIBSEAT_BACKEND=noop`：smithay 在 new() 时即激活，card0 不校验 DRM master。
- `chmod 1777 /tmp/.X11-unix`：Xwayland 要求正确的套接字目录权限。

## 4. 预期现象与耗时基线（实测）

- 启动后先闪一下蓝屏 → 黑屏 + 白色光标条随鼠标移动（扫描输出链路活着的标志）
  → 等首帧。
- **LP_NUM_THREADS=1：完整锁屏约 t50 秒**（2026-09-09 实测；时钟逐秒走动 +
  壁纸 + 光标 + 右上角状态条）。
- **默认 4 线程（不设 LP_NUM_THREADS）：约 t90–150 秒**——多线程 llvmpipe 在
  当前调度器下反而更慢（重帧慢约 3 倍），这是已知问题：根因是旧调度器
  唤醒/派生永远选本地 CPU、无负载均衡，任务全挤在一个 vCPU。上游
  PR #1775（2026-09-08 调度器重建）已架构性修复，待 repatch 后更新本节。
- 日志健康检查点（`grep -a` /tmp/dd.log）：
  `Using the Impeller rendering backend`、`started Rust Flutter embedder`、
  `synchronized Flutter desktop visibility visible=true`、
  `enabled native output pipelines`。
- `sys_prctl: unsupported option` 警告无害（glibc loader 的 PR_SET_VMA 类调用）。

## 5. 键鼠与取证

- 键鼠直接在 cocoa 窗口操作（evdev 轮询修复已在本树内）。
- 验证输入到内核：`timeout 6 dd if=/dev/input/event0 of=/tmp/x.bin bs=24 count=4`，
  窗口里敲键后 dd 应秒收 96 字节。
- screendump / 注入（nc 连 HMP 不会自退，必须后台+定时杀）：

```bash
hmp() { (echo "$1" | nc -U /tmp/qemu-monf.sock >/dev/null 2>&1 &); sleep 2; \
        pkill -f "nc -U /tmp/qemu-monf.sock" 2>/dev/null; }
hmp "screendump /tmp/shot.ppm"    # 1280x800 P6 PPM
hmp "sendkey b"                   # 鼠标用 mouse_move / mouse_button
```

## 6. 坑清单（全部实踩）

| 坑 | 现象 | 对策 |
| --- | --- | --- |
| 漏 `--flutter-bundle` | 蓝闪→永远黑屏+光标，无任何报错 | 照抄 §3 命令；查 dd.log 的 `presentation=` |
| 硬杀 QEMU | ext4 文件名在内容全零 | guest 内 `sync; poweroff` 再关 |
| 镜像双开 | Failed to get write lock | 启动前 `pgrep -x qemu-system-aarch64` |
| 串口 >4KB 单次输出 | 控制台冻结 | 长输出 `| head` / 分块 |
| `pgrep -x` | 恒不匹配 | 用 `pgrep -l` |
| `rusage`/`times`/ps TIME | 恒返回 221h38m35s 垃圾值 | 仅记账 cosmetic，不可作依据 |
| guest /tmp | tmpfs，断电即丢 | 证据先 `cp /root/` + `sync` |
| expect 标记 | 回显的命令文本误触发 marker | marker 用 `echo X_"DO"NE` 变形 |
| Apple clang | 不支持 `-print-sysroot` | §1 的 musl gcc env 配方 |
