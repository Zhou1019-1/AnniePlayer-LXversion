#!/bin/bash
# 安妮播放器 macOS 版 —— 一键构建（云端 CI 与本地通用）
#
# 用法：
#   ./build-dmg.sh [版本号]        本地构建（版本号默认取 Info.plist）
#
# 产物：
#   dist/annie-player-macos-arm64-{版本}.zip
#   dist/安妮播放器-{版本}-离线版.dmg
#
# ⚠️ 本脚本必须能在 GitHub Actions 的 macos-latest runner 上直接跑通，
#    不允许依赖开发者本机的私有路径（规范：构建可复现）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-}"
DIST="$ROOT/dist"
BUILD="$ROOT/build"
TEMPLATE="$ROOT/AppTemplate/AnniePlayer.app"
APP_NAME="AnniePlayer.app"

echo "=== 0. 环境检查 ==="
[ -d "$TEMPLATE" ] || { echo "❌ 缺少 App 模板: $TEMPLATE"; exit 1; }
command -v swiftc >/dev/null || { echo "❌ 找不到 swiftc（需要 Xcode Command Line Tools）"; exit 1; }

# 版本号：参数优先，否则读模板 Info.plist
if [ -z "$VERSION" ]; then
  VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TEMPLATE/Contents/Info.plist" 2>/dev/null || echo "0.0.0")
fi
echo "  版本: $VERSION"
echo "  工程: $ROOT"

echo ""
echo "=== 1. 编译 Swift（arm64 release）==="
rm -rf "$BUILD"
mkdir -p "$BUILD"
swiftc -O -parse-as-library -target arm64-apple-macosx15.0 \
  -o "$BUILD/annie" src/*.swift
echo "  ✅ 编译完成: $(ls -lh "$BUILD/annie" | awk '{print $5}')"

echo ""
echo "=== 2. 组装 App 包 ==="
rm -rf "$DIST"
mkdir -p "$DIST"
STAGE="$BUILD/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$TEMPLATE" "$STAGE/$APP_NAME"
APP="$STAGE/$APP_NAME"

# 二进制
cp "$BUILD/annie" "$APP/Contents/MacOS/AnnieMac"
chmod +x "$APP/Contents/MacOS/AnnieMac"

# 前端资源（以仓库 macos/web 为准，覆盖模板里的旧副本）
rm -rf "$APP/Contents/Resources/web"
cp -R "$ROOT/web" "$APP/Contents/Resources/web"

# 脚本
mkdir -p "$APP/Contents/Resources/scripts"
for f in connect-proxy.py sync-am-token.sh; do
  [ -f "$ROOT/assets/$f" ] && cp "$ROOT/assets/$f" "$APP/Contents/Resources/scripts/"
done
[ -f "$ROOT/scripts/sync-am-token.sh" ] && cp "$ROOT/scripts/sync-am-token.sh" "$APP/Contents/Resources/scripts/" || true

# 版本号写回
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"
# 图标字段保险（历史踩坑：漏了会导致图标空白）
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AppIcon" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$APP/Contents/Info.plist"
[ -f "$APP/Contents/Resources/AppIcon.icns" ] || cp "$ROOT/assets/AppIcon.icns" "$APP/Contents/Resources/" 2>/dev/null || true

echo "  ✅ App 组装完成: $(du -sh "$APP" | cut -f1)"
echo "     版本: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
echo "     图标: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$APP/Contents/Info.plist")"

echo ""
echo "=== 3. 下载运行时依赖 ==="
# ⚠️ 2026-10-24（优化上传体积）：
#   原来需要把 ubuntu.img(588MB) + limactl(31MB) + wrapper-lite(83MB) + wrapper-pkg(49MB)
#   全部作为 Release 资产上传（共 764MB），浏览器上传大文件经常失败。
#   现在改为全部从**官方源**下载，只有 wrapper-pkg（自研，无公开源）走自己的 Release：
#     · ubuntu.img    → Ubuntu 官方云镜像（cloud-images.ubuntu.com）
#     · limactl      → lima 官方 GitHub Release
#     · wrapper-lite → 本仓库已有的 wrapper-lite-v1 Release
#     · wrapper-pkg  → 本仓库 mac-runtime-v1 Release（只有 49MB）
#   本地有文件时优先用本地（开发者用），云端自动下载。
RUNTIME_TAG="${MAC_RUNTIME_TAG:-mac-runtime-v1}"
REPO="${GITHUB_REPOSITORY:-Zhou1019-1/AnniePlayer-LXversion}"
RUNTIME_BASE="${MAC_RUNTIME_BASE:-https://github.com/$REPO/releases/download/$RUNTIME_TAG}"
UBUNTU_URL="${MAC_UBUNTU_URL:-https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img}"
LIMA_VER="${MAC_LIMA_VER:-2.2.1}"
LIMA_URL="https://github.com/lima-vm/lima/releases/download/v${LIMA_VER}/lima-${LIMA_VER}-Darwin-arm64.tar.gz"
WRAPPER_LITE_URL="https://github.com/${REPO}/releases/download/wrapper-lite-v1/wrapper-lite.zip"
DEPS_OK=1

mkdir -p "$APP/Contents/Resources/lima" "$APP/Contents/Resources/deps"

# ── limactl ──
if [ -x "$ROOT/assets/limactl" ]; then
  cp "$ROOT/assets/limactl" "$APP/Contents/Resources/lima/" && echo "  ✅ limactl（本地）"
elif command -v limactl >/dev/null; then
  cp "$(command -v limactl)" "$APP/Contents/Resources/lima/limactl" && echo "  ✅ limactl（系统）"
else
  TMP_TGZ="$BUILD/lima.tar.gz"
  echo "  → 下载 limactl（lima v${LIMA_VER}，约 37MB）…"
  if curl -fsSL --retry 3 --connect-timeout 20 --max-time 600 -o "$TMP_TGZ" "$LIMA_URL"; then
    tar -xzf "$TMP_TGZ" -C "$BUILD"
    LIMA_BIN=$(find "$BUILD" -name limactl -type f | head -1)
    if [ -n "$LIMA_BIN" ]; then
      cp "$LIMA_BIN" "$APP/Contents/Resources/lima/limactl"
      chmod +x "$APP/Contents/Resources/lima/limactl"
      echo "  ✅ limactl（下载，$(du -h "$APP/Contents/Resources/lima/limactl" | cut -f1)）"
    else
      echo "  ⚠️ 压缩包里找不到 limactl"; DEPS_OK=0
    fi
  else
    echo "  ⚠️ limactl 下载失败"; DEPS_OK=0
  fi
fi

# ── ubuntu.img ──
if [ -f "$ROOT/assets/ubuntu.img" ]; then
  cp "$ROOT/assets/ubuntu.img" "$APP/Contents/Resources/lima/" && echo "  ✅ ubuntu.img（本地）"
else
  echo "  → 下载 Ubuntu 镜像（约 588MB，可能较慢）…"
  if curl -fsSL --retry 3 --connect-timeout 30 --max-time 1800 -C -        -o "$APP/Contents/Resources/lima/ubuntu.img" "$UBUNTU_URL"; then
    echo "  ✅ ubuntu.img（下载，$(du -h "$APP/Contents/Resources/lima/ubuntu.img" | cut -f1)）"
  else
    echo "  ⚠️ ubuntu.img 下载失败（App 首次登录时会自行重试）"; DEPS_OK=0
  fi
fi

# ── lima yaml / am-login 部署包 ──
[ -f "$ROOT/assets/annie-am-login.yaml" ] && cp "$ROOT/assets/annie-am-login.yaml" "$APP/Contents/Resources/lima/" || true
[ -d "$ROOT/assets/am-login-package" ] && cp -R "$ROOT/assets/am-login-package" "$APP/Contents/Resources/lima/" 2>/dev/null || true

# ── wrapper-lite（QEMU 运行时）──
if [ -d "$ROOT/assets/wrapper-lite" ]; then
  cp -R "$ROOT/assets/wrapper-lite" "$APP/Contents/Resources/deps/wrapper-lite"
  echo "  ✅ wrapper-lite（本地）"
else
  echo "  → 下载 wrapper-lite（约 83MB）…"
  TMP_W="$BUILD/wrapper-lite.zip"
  if curl -fsSL --retry 3 --connect-timeout 20 --max-time 900 -o "$TMP_W" "$WRAPPER_LITE_URL"; then
    unzip -q "$TMP_W" -d "$BUILD/wrapper-unzip"
    SRC=$(find "$BUILD/wrapper-unzip" -maxdepth 2 -name wrapper-lite-qemu -type f | head -1)
    if [ -n "$SRC" ]; then
      SRC_DIR=$(dirname "$SRC")
      mv "$SRC_DIR" "$APP/Contents/Resources/deps/wrapper-lite"
      echo "  ✅ wrapper-lite（下载，$(du -sh "$APP/Contents/Resources/deps/wrapper-lite" | cut -f1)）"
    else
      echo "  ⚠️ wrapper-lite.zip 结构异常"; DEPS_OK=0
    fi
  else
    echo "  ⚠️ wrapper-lite 下载失败"; DEPS_OK=0
  fi
fi
rm -f "$APP/Contents/Resources/deps/wrapper-lite/qemu/data.img" 2>/dev/null || true

# ── wrapper-pkg（自研，无公开源）──
# ⚠️ 2026-10-24：49MB，压缩后小于 100MB，直接进 git（assets/wrapper-pkg.zip），
#   这样完全不需要 Release 资产，也不用浏览器上传大文件。
WP_DEST="$APP/Contents/Resources/lima/am-login-package/wrapper-pkg"
if [ -d "$ROOT/assets/am-login-package/wrapper-pkg" ]; then
  mkdir -p "$(dirname "$WP_DEST")"
  cp -R "$ROOT/assets/am-login-package/wrapper-pkg" "$WP_DEST"
  echo "  ✅ wrapper-pkg（本地目录）"
elif [ -f "$ROOT/assets/wrapper-pkg.zip" ]; then
  mkdir -p "$(dirname "$WP_DEST")"
  unzip -q "$ROOT/assets/wrapper-pkg.zip" -d "$BUILD/wp-unzip"
  SRC_WP=$(find "$BUILD/wp-unzip" -maxdepth 1 -type d -name wrapper-pkg | head -1)
  if [ -n "$SRC_WP" ]; then
    mv "$SRC_WP" "$WP_DEST"
    echo "  ✅ wrapper-pkg（git 内的 zip，$(du -sh "$WP_DEST" | cut -f1)）"
  else
    echo "  ⚠️ wrapper-pkg.zip 结构异常"; DEPS_OK=0
  fi
else
  echo "  → 下载 wrapper-pkg（约 49MB）…"
  TMP_WP="$BUILD/wrapper-pkg.zip"
  if curl -fsSL --retry 3 --connect-timeout 20 --max-time 600 -o "$TMP_WP" "$RUNTIME_BASE/wrapper-pkg.zip"; then
    mkdir -p "$(dirname "$WP_DEST")"
    unzip -q "$TMP_WP" -d "$BUILD/wp-unzip"
    SRC_WP=$(find "$BUILD/wp-unzip" -maxdepth 1 -type d -name wrapper-pkg | head -1)
    if [ -n "$SRC_WP" ]; then
      mv "$SRC_WP" "$WP_DEST"
      echo "  ✅ wrapper-pkg（下载，$(du -sh "$WP_DEST" | cut -f1)）"
    else
      echo "  ⚠️ wrapper-pkg.zip 结构异常"; DEPS_OK=0
    fi
  else
    echo "  ⚠️ wrapper-pkg 下载失败"; DEPS_OK=0
  fi
fi

[ "$DEPS_OK" = "1" ] && echo "  ✅ 运行时依赖齐全" || echo "  ⚠️ 部分依赖缺失（首次登录时会自行补下载）"

echo "=== 4. 签名（ad-hoc）==="
codesign --force --deep --sign - "$APP" 2>/dev/null && echo "  ✅ 已签名（ad-hoc）" || echo "  ⚠️ 签名失败（不影响本机使用）"
codesign -v "$APP" 2>/dev/null && echo "  ✅ 签名校验通过" || true

echo ""
echo "=== 5. 打包产物 ==="
SAFE_VER=$(echo "$VERSION" | tr -cd '0-9A-Za-z.-')

# ZIP（含安装说明）
README_TMP="$BUILD/README.txt"
cat > "$README_TMP" << 'READMEEOF'
安妮播放器 macOS ARM64 版
========================

【安装】
1. 把 AnniePlayer.app 拖到「应用程序」文件夹
2. 首次打开如果提示「无法验证开发者」：
   系统设置 → 隐私与安全 → 滚到最底部「安全性」区域
   → 点击「仍要打开」→ 点「打开」→ 输入开机密码 → 确定
   之后就不再提示。

   如果找不到「仍要打开」按钮，可在终端执行：
   xattr -cr /Applications/AnniePlayer.app

【运行要求】
- macOS 15.0 或更高（Apple Silicon / arm64）
- 首次启动自动拉起服务（无需手动操作）
- 退出 App 时所有服务自动停止

【反馈】
邮箱：2947205204@qq.com
GitHub：https://github.com/Zhou1019-1/AnniePlayer-LXversion/issues

【致谢】
原版 Windows 安妮播放器：无敌章鱼哥 出品 · 交流 QQ 群 1023637098
READMEEOF

ZIP_OUT="$DIST/annie-player-macos-arm64-${SAFE_VER}.zip"
ZIP_STAGE="$BUILD/zipstage"
rm -rf "$ZIP_STAGE"; mkdir -p "$ZIP_STAGE"
cp -R "$APP" "$ZIP_STAGE/"
cp "$README_TMP" "$ZIP_STAGE/README.txt"
( cd "$ZIP_STAGE" && zip -r -X -q "$ZIP_OUT" . )
echo "  ✅ ZIP: $(du -h "$ZIP_OUT" | cut -f1)"

# DMG
DMG_OUT="$DIST/安妮播放器-${SAFE_VER}-离线版.dmg"
DMG_STAGE="$BUILD/dmgstage"
rm -rf "$DMG_STAGE"; mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/"
cp "$README_TMP" "$DMG_STAGE/安装说明.txt" 2>/dev/null || true
if hdiutil create -volname "安妮播放器" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_OUT" 2>&1 | tail -1; then
  echo "  ✅ DMG: $(du -h "$DMG_OUT" | cut -f1)"
else
  echo "  ❌ DMG 创建失败"
fi

echo ""
echo "=== 6. 产物清单 ==="
find "$DIST" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' \) -exec ls -lh {} \; | awk '{print "  ", $9, $5}'
echo ""
echo "✅ 完成"
