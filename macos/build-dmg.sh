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
echo "=== 3. 下载运行时依赖（大二进制，来自 Release 资产）==="
# ⚠️ ubuntu.img(588MB) / limactl(31MB) / wrapper-lite(466MB) 不进 git，
#    从固定 tag 的 prerelease 资产下载。本地可用环境变量覆盖为本地路径。
RUNTIME_TAG="${MAC_RUNTIME_TAG:-mac-runtime-v1}"
REPO="${GITHUB_REPOSITORY:-Zhou1019-1/AnniePlayer-LXversion}"
RUNTIME_BASE="${MAC_RUNTIME_BASE:-https://github.com/$REPO/releases/download/$RUNTIME_TAG}"
DEPS_OK=1

fetch() { # $1=远程文件名 $2=目标路径
  local url="$RUNTIME_BASE/$1" dest="$2"
  if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$dest" "$url"; then
    echo "  ⚠️ 下载失败: $1（该组件将缺失，登录 Apple Music 时会不可用）"
    return 1
  fi
  echo "  ✅ $1 ($(du -h "$dest" | cut -f1))"
}

# limactl
mkdir -p "$APP/Contents/Resources/lima"
if [ -f "$ROOT/assets/limactl" ]; then
  cp "$ROOT/assets/limactl" "$APP/Contents/Resources/lima/" && echo "  ✅ limactl（本地）"
else
  fetch "limactl" "$APP/Contents/Resources/lima/limactl" && chmod +x "$APP/Contents/Resources/lima/limactl" || DEPS_OK=0
fi

# ubuntu.img
if [ -f "$ROOT/assets/ubuntu.img" ]; then
  cp "$ROOT/assets/ubuntu.img" "$APP/Contents/Resources/lima/" && echo "  ✅ ubuntu.img（本地）"
else
  fetch "ubuntu.img" "$APP/Contents/Resources/lima/ubuntu.img" || DEPS_OK=0
fi

# lima yaml / am-login 包
[ -f "$ROOT/assets/annie-am-login.yaml" ] && cp "$ROOT/assets/annie-am-login.yaml" "$APP/Contents/Resources/lima/" || true
[ -d "$ROOT/assets/am-login-package" ] && cp -R "$ROOT/assets/am-login-package" "$APP/Contents/Resources/lima/" || true

# wrapper-lite（QEMU + wrapper-lite-qemu）
if [ -d "$ROOT/assets/wrapper-lite" ]; then
  mkdir -p "$APP/Contents/Resources/deps"
  cp -R "$ROOT/assets/wrapper-lite" "$APP/Contents/Resources/deps/wrapper-lite"
  echo "  ✅ wrapper-lite（本地）"
else
  WRAP_TMP="$BUILD/wrapper-lite.zip"
  if curl -fsSL --retry 3 --connect-timeout 20 -o "$WRAP_TMP" "$RUNTIME_BASE/wrapper-lite.zip"; then
    mkdir -p "$APP/Contents/Resources/deps"
    unzip -q "$WRAP_TMP" -d "$APP/Contents/Resources/deps/"
    [ -d "$APP/Contents/Resources/deps/wrapper-lite" ] || mv "$APP/Contents/Resources/deps/unpacked" "$APP/Contents/Resources/deps/wrapper-lite" 2>/dev/null || true
    echo "  ✅ wrapper-lite（下载）"
  else
    echo "  ⚠️ 下载失败: wrapper-lite.zip"
    DEPS_OK=0
  fi
fi
# data.img 不进包（登录后生成的运行时数据）
rm -f "$APP/Contents/Resources/deps/wrapper-lite/qemu/data.img" 2>/dev/null || true

[ "$DEPS_OK" = "1" ] && echo "  ✅ 运行时依赖齐全" || echo "  ⚠️ 部分依赖缺失（包体积会变小，登录功能不可用）"

echo ""
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
