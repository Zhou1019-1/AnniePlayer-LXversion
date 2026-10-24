#!/bin/bash
# 安妮播放器 —— 首次启动自动安装登录服务 VM
# 用法：install-am-login-vm.sh [DMG 挂载路径或 am-login 包路径]
set -e

PKG_DIR="${1:-}"
if [ -z "$PKG_DIR" ] || [ ! -d "$PKG_DIR" ]; then
  echo "[install] 用法: $0 <am-login-pkg 目录>"
  exit 1
fi
VM_NAME="annie-am-login"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "[install] 1. 检查 Lima"
if ! command -v limactl >/dev/null 2>&1; then
  echo "[install] ❌ 需要 Lima：请先执行 brew install lima"
  exit 1
fi

echo "[install] 2. 创建最小登录 VM（首次会下载 Ubuntu 镜像 ~500MB）"
if limactl list 2>/dev/null | grep -q "^$VM_NAME"; then
  echo "[install] VM 已存在，跳过创建"
else
  limactl create --name="$VM_NAME" "$HERE/annie-am-login.yaml" --tty=false
fi

echo "[install] 3. 启动 VM"
limactl start "$VM_NAME" 2>&1 | tail -2

echo "[install] 4. 部署 am-login 服务到 VM"
limactl shell "$VM_NAME" sudo bash -c '
set -e
mkdir -p /opt/am-login
systemctl stop am-login 2>/dev/null || true
'
# 复制文件（分块，避免单次太大）
limactl copy "$PKG_DIR/am-login-export/am-login-server.py" "$VM_NAME:/tmp/" 2>/dev/null || true
limactl copy "$PKG_DIR/am-login-export/run-main.sh" "$VM_NAME:/tmp/" 2>/dev/null || true
limactl copy "$PKG_DIR/am-login-export/device.txt" "$VM_NAME:/tmp/" 2>/dev/null || true

# 复制 wrapper-pkg（大文件，用 tar 流式传输）
if [ -d "$PKG_DIR/am-login-export/wrapper-pkg" ]; then
  echo "[install] 5. 传输 wrapper-pkg（112MB）"
  tar -C "$PKG_DIR/am-login-export" -czf /tmp/am-login-pkg.tar.gz wrapper-pkg
  limactl copy /tmp/am-login-pkg.tar.gz "$VM_NAME:/tmp/" 2>/dev/null
  limactl shell "$VM_NAME" sudo bash -c '
    set -e
    cd /opt/am-login
    cp /tmp/am-login-server.py /tmp/run-main.sh /tmp/device.txt /opt/am-login/ 2>/dev/null || true
    tar -xzf /tmp/am-login-pkg.tar.gz -C /opt/am-login/
    chmod +x /opt/am-login/run-main.sh
    cat > /etc/systemd/system/am-login.service << "EOF"
[Unit]
Description=Apple Music login manager (VM resident)
After=network.target

[Service]
Type=simple
User=root
PrivateTmp=no
ProtectSystem=no
ExecStart=/usr/bin/python3 /opt/am-login/am-login-server.py
Restart=always
RestartSec=2
StandardOutput=append:/var/log/am-login.log
StandardError=append:/var/log/am-login.log

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now am-login
    sleep 2
    systemctl is-active am-login
  ' 2>&1 | tail -3
fi

echo "[install] 6. 验证（host 端口 12341）"
sleep 3
curl -s --max-time 5 "http://127.0.0.1:12341/ping" 2>/dev/null || echo "（VM 可能还在启动，稍后重试）"
echo
echo "[install] ✅ 完成。VM 名称：$VM_NAME"
