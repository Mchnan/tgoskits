# SOP：运行 StarryOS denial 桌面 QEMU 产物（macOS arm64 宿主）

适用对象：本仓库工作树构建出的 `starryos.bin`（qemu-aarch64 板卡，含 display + virtio-gpu +
virtio-input + evdev 输入修复）与 Alpine denial rootfs。
环境：macOS arm64（HVF 硬件虚拟化）+ Homebrew QEMU ≥ 11。

## 1. 产物与前置条件

```bash
# 内核（本工作树构建，SMP=4）
ls -la target/aarch64-unknown-none-softfloat/release/starryos.bin
# rootfs（Alpine + deniald + Flutter shell bundle + gcompat 垫片）
ls -la tmp/axbuild/rootfs/rootfs-aarch64-denial-full.img
# QEMU
qemu-system-aarch64 --version
```

注意：同一 rootfs 镜像同时只能被一个 QEMU 打开（写锁）。启动前确认没有别的
`qemu-system-aarch64` 占用 `rootfs-aarch64-denial-full.img`。

## 2. 启动 QEMU（仓库根目录执行）

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

- 弹出的 **cocoa 窗口就是显示器**；终端本身是 guest 串口控制台。
- 可另加 `-vnc :0` 用 VNC 客户端连 localhost:5900 抓帧。
- `/tmp/qemu-monf.sock` 是 HMP monitor，供 screendump / sendkey 注入用。

## 3. 登录与基本检查

约 30–60 秒后出现 `login:`，输入 `root`（无密码）进入 shell。

```bash
ls -l /dev/fb0 /dev/dri/card0     # fb0 主设备号 29、card0 226，二者存在即显示链路健康
cat /proc/cpuinfo | grep -c processor   # 4
```

## 4. 启动 denial 桌面

```bash
export LIBGL_ALWAYS_SOFTWARE=1 LIBSEAT_BACKEND=noop XDG_RUNTIME_DIR=/tmp DENIA_NO_PREDECESSOR=1
mkdir -p /tmp/.X11-unix
LD_PRELOAD=/usr/lib/libdenialshim.so /usr/bin/deniald --device /dev/dri/card0 --wayland --frames 200000 >/tmp/dd.log 2>&1 &
```

- `LD_PRELOAD=libdenialshim.so` 必须带上（Rust std 引用 `__res_init`，gcompat 不提供；
  缺了 deniald 直接 exit 127）。
- `DENIA_NO_PREDECESSOR=1` 跳过"前任 KMS 状态"捕获（unikernel 冷启动没有已绑定的 plane）。
- 启动日志里 `sys_prctl: unsupported option` 警告无害（glibc loader 的
  PR_SET_VMA 类调用，内核未实现，不影响运行）。

## 5. 预期现象与耗时基线

- 启动后**先闪一下蓝屏、然后黑屏 + 可跟随的白色光标条**：蓝屏闪现是首次 KMS
  present 把尚未绘制的帧缓冲扫出（一次性）；之后黑屏 + 光标随动 =
  virtio-gpu 光标平面在更新，扫描输出链路是活的，只等 shell 首帧。
- 默认（多线程 llvmpipe，LP_NUM_THREADS=4）：**完整锁屏约 t90–150 秒**
  （时钟逐秒走动 + Welcome back 解锁面板 + blur backdrop）。这是当前已知慢项
  （旧调度器放置策略 + 软渲染），不是卡死，耐心等。
- 想快 3 倍：kill 掉 deniald 后加 `export LP_NUM_THREADS=1` 再启动，
  首个完整桌面约 **t35 秒**。
- 渲染进行中的证据：`top` 里 deniald 应占高 CPU（llvmpipe 软渲染吃满一个
  vCPU）；`tail -20 /tmp/dd.log` 应看到 libinput 添加 event0/event1、PAM、
  Xwayland、引擎+Dart shell+Impeller 渲染 pass 全 alive。
- 超过约 3 分钟仍全黑才算异常，届时按第 7 节 screendump 取证并查 dd.log。

## 6. 键鼠操作

直接在 cocoa 窗口里点击 / 移动 / 打字即可（本工作树含 evdev 轮询修复，输入链路已通）。
验证输入到内核：另开一次阻塞读，注入事件应即时到达——

```bash
timeout 6 dd if=/dev/input/event0 of=/tmp/x.bin bs=24 count=4 2>&1 | tail -1
# 在 cocoa 窗口敲几个键，dd 应几秒内收满 96 字节（4 条事件）
```

## 7. 取证：screendump / 注入（host 侧）

```bash
hmp() { (echo "$1" | nc -U /tmp/qemu-monf.sock >/dev/null 2>&1 &); sleep 2; \
        pkill -f "nc -U /tmp/qemu-monf.sock" 2>/dev/null; }
hmp "screendump /tmp/shot.ppm"      # 1280x800 P6 PPM
hmp "sendkey b"                     # 注入按键；鼠标用 mouse_move / mouse_button
```

nc 连 HMP 不会自己退出，必须按上式"后台 + 定时杀"。PPM 转 PNG 宿主无 ImageMagick，
可直接用 macOS 截屏对 cocoa 窗口截图代替。

## 8. 已知坑（全部实踩）

1. **guest 串口单次输出 > 4KB 会冻结控制台**——长输出用 `| head` / 分块。
2. `pgrep -x` 在 guest procfs 下恒不匹配，用 `pgrep -l deniald`。
3. `rusage`/`times` 对任何进程返回同一组常量垃圾值（221h38m35s），仅记账 cosmetic。
4. guest `/tmp` 是 tmpfs，**断电即丢**（dd.log 等证据先 `cp /root/` + `sync`）。
5. 关机务必 guest 内 `sync; poweroff`；宿主 `\x01x` 硬杀会丢 ext4 数据块（目录项存活、
   内容全零），e2fsck 只修元数据救不回数据。

## 9. 重新构建产物（需要时）

每次新 shell 都要设置（勿写进 rc，影响其它架构 target）：

```bash
export PATH="/opt/homebrew/opt/e2fsprogs/sbin:/opt/homebrew/opt/e2fsprogs/bin:/opt/homebrew/opt/aarch64-unknown-linux-musl/bin:/opt/homebrew/opt/aarch64-unknown-linux-gnu/bin:$PATH"
SYSROOT=$(aarch64-linux-musl-gcc -print-sysroot)
TOOLCHAIN=$(realpath /opt/homebrew/opt/aarch64-unknown-linux-musl/bin/..)
export BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl="--target=aarch64-linux-musl --sysroot=$SYSROOT --gcc-toolchain=$TOOLCHAIN -isystem $SYSROOT/include"

cargo xtask starry build -c os/StarryOS/configs/board/qemu-aarch64.toml --smp 4
```

跑完后 `unset BINDGEN_EXTRA_CLANG_ARGS_aarch64_unknown_linux_musl`。
