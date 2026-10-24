#!/bin/bash
# 把 VM（am-login-server）里登录成功的 token 同步到 QEMU 的 data.img。
set -e
RT="$HOME/Library/Application Support/AppleMusicDL/wrapper-lite-runtime-arm64/qemu"
IMG="$RT/data.img"
TMPIMG="/tmp/qemu-data-sync.img"
VM_DATA="/tmp/wrapper-pkg/rootfs/data"

echo "[sync] 1. 停止 QEMU"
pkill -9 -f "wrapper-lite-qemu" 2>/dev/null || true
pkill -9 -f "qemu-system-x86_64" 2>/dev/null || true
sleep 2

echo "[sync] 2. 复制 data.img 到 VM"
limactl copy "$IMG" "snowluma:$TMPIMG" 2>/dev/null || { echo "[sync] 复制失败"; exit 1; }

echo "[sync] 3. VM 内挂载并写入 token"
limactl shell snowluma sudo bash -c "
set -e
mkdir -p /mnt/qemu-data
umount -l /mnt/qemu-data 2>/dev/null || true
mount -o loop $TMPIMG /mnt/qemu-data
for f in MUSIC_TOKEN DEV_TOKEN token_cache.json STOREFRONT_ID accounts.sqlitedb accounts.sqlitedb-wal accounts.sqlitedb-shm; do
  if [ -f $VM_DATA/\$f ]; then cp -f $VM_DATA/\$f /mnt/qemu-data/ 2>/dev/null || true; fi
done
mkdir -p /mnt/qemu-data/mpl_db
for f in accounts.sqlitedb accounts.sqlitedb-wal accounts.sqlitedb-shm kvs.sqlitedb kvs.sqlitedb-wal kvs.sqlitedb-shm; do
  if [ -f $VM_DATA/mpl_db/\$f ]; then cp -f $VM_DATA/mpl_db/\$f /mnt/qemu-data/mpl_db/ 2>/dev/null || true; fi
done
sync
umount /mnt/qemu-data
" 2>&1 | tail -3

echo "[sync] 4. 复制回 macOS"
limactl copy "snowluma:$TMPIMG" "$IMG" 2>/dev/null || { echo "[sync] 复制回失败"; exit 1; }

echo "[sync] 5. 启动 QEMU 服务"
( cd "$HOME/.dsh/amdl/wrapper-lite/unpacked" && ./wrapper-lite-qemu > /tmp/qemu-after-sync.log 2>&1 & ) || true
sleep 25

echo "[sync] 6. 验证 /status"
curl -s --max-time 8 "http://127.0.0.1:12340/status" 2>/dev/null | head -c 200
echo
