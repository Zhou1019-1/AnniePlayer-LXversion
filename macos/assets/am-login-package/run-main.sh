#!/bin/bash
# Apple Music 主程序启动器（替代 wrapper 启动器）
#
# ⚠️ 为什么不用官方 wrapper 启动器（2026-10-22）：
#   wrapper.c 只 bind mount 了 /dev/urandom + /proc，
#   Apple 的 Anisette 设备认证需要**完整的 /dev 和 /sys**，
#   否则返回 response type 4 + "AMD-Action::SP"（认证协议未完成），
#   而且不会发 2FA 验证码。
#   实测手动挂载完整 /dev + /sys 后认证恢复正常。
#
# 用法: run-main.sh <main 的参数...>（会原样传给 /system/bin/main）

ROOT=/tmp/wrapper-pkg/rootfs

# 清理上次残留
pkill -9 -f "/system/bin/main" 2>/dev/null
for m in dev proc sys; do
    umount -l "$ROOT/$m" 2>/dev/null
done
sleep 0.3

mkdir -p "$ROOT/dev" "$ROOT/proc" "$ROOT/sys" "$ROOT/data"

# 完整 /dev（anisette 需要 random/null/zero 等）
if ! mount --bind /dev "$ROOT/dev"; then
    echo "mount /dev failed" >&2
    exit 1
fi
# /proc
if ! mount -t proc proc "$ROOT/proc"; then
    echo "mount /proc failed" >&2
    exit 1
fi
# /sys（硬件标识，失败不致命）
mount --bind /sys "$ROOT/sys" 2>/dev/null

cd "$ROOT" || exit 1
exec chroot . /system/bin/main "$@"
