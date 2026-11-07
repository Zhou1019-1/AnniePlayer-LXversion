#!/bin/bash
# ============================================================================
# 安妮播放器 Lite（macOS 无 Apple Music 版）—— 一键构建
#
# 用法：
#   ./build-dmg-lite.sh [版本号]        # 版本号可带 mac-lite-v 前缀，会自动剥掉
#
# 产物：
#   macos/dist/AnniePlayer-Lite-{版本}.dmg
#   macos/dist/annie-player-lite-macos-{版本}.zip
#
# 与完整版的差异：
#   · 编译时加 -D LITE，sources 里 #if !LITE 包裹的 Apple Music / Lima / QEMU
#     代码全部不参与编译（同一份 src，两个产品，零拷贝）
#   · 前端在构建时打补丁（web-patch.py），不复制第二份 12MB 的 web
#   · 无运行时依赖、universal（arm64+x86_64）、最低 macOS 13
# ============================================================================
set -euo pipefail

LITE_DIR="$(cd "$(dirname "$0")" && pwd)"
MACOS_DIR="$(cd "$LITE_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MACOS_DIR/.." && pwd)"

VERSION="${1:-}"
[ -z "$VERSION" ] && VERSION="1.0.1"
# 去掉可能的 tag 前缀
VERSION="${VERSION#mac-lite-v}"; VERSION="${VERSION#mac-v}"; VERSION="${VERSION#lite-v}"; VERSION="${VERSION#v}"

DIST="$MACOS_DIR/dist"
BUILD="$MACOS_DIR/build-lite"
APP_NAME="安妮播放器 Lite.app"
APP_ID="com.annie.player.mac.lite"
MIN_MACOS="${ANNIE_LITE_MIN_MACOS:-13.0}"

command -v swiftc >/dev/null || { echo "❌ 找不到 swiftc（需要 Xcode Command Line Tools）"; exit 1; }
[ -d "$MACOS_DIR/AppTemplate/AnniePlayer.app" ] || { echo "❌ 缺少 AppTemplate"; exit 1; }

echo "=== 安妮播放器 Lite · 版本: $VERSION · universal · macOS ${MIN_MACOS}+ ==="

# ---------- 1. 编译（同一份 src，加 -D LITE）----------
if [ "${USE_PREBUILT:-0}" = "1" ] && [ -f "$BUILD/annie" ]; then
  echo "=== 1. 复用已有 build-lite/annie（USE_PREBUILT=1）==="
else
  echo "=== 1. 编译 Lite（arm64）==="
  rm -rf "$BUILD"; mkdir -p "$BUILD"
  swiftc -O -parse-as-library -D LITE -target "arm64-apple-macosx${MIN_MACOS}" \
    -o "$BUILD/annie-arm64" "$MACOS_DIR"/src/*.swift
  echo "=== 1. 编译 Lite（x86_64）==="
  swiftc -O -parse-as-library -D LITE -target "x86_64-apple-macosx${MIN_MACOS}" \
    -o "$BUILD/annie-x86_64" "$MACOS_DIR"/src/*.swift
  lipo -create "$BUILD/annie-arm64" "$BUILD/annie-x86_64" -output "$BUILD/annie"
fi
echo "  ✅ $(file -b "$BUILD/annie")"

# ---------- 2. 前端打补丁（不复制第二份 web）----------
echo "=== 2. 生成 Lite 前端 ==="
python3 "$LITE_DIR/web-patch.py" "$MACOS_DIR/web" "$BUILD/web-lite"
echo "  ✅ $(du -sh "$BUILD/web-lite" | cut -f1)"

# ---------- 3. 组装 App ----------
echo "=== 3. 组装 App（从零拼，不带完整版的 deps/lima）==="
rm -rf "$DIST"; mkdir -p "$DIST"
STAGE="$BUILD/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE"
APP="$STAGE/$APP_NAME"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$MACOS_DIR/AppTemplate/AnniePlayer.app/Contents/Info.plist" "$APP/Contents/"
cp "$MACOS_DIR/AppTemplate/AnniePlayer.app/Contents/Resources/AppIcon.icns" "$APP/Contents/Resources/"
cp "$BUILD/annie" "$APP/Contents/MacOS/AnnieMac"
chmod +x "$APP/Contents/MacOS/AnnieMac"
cp -R "$BUILD/web-lite" "$APP/Contents/Resources/web"

# 版本 / 名称 / ID / 最低系统
PB=/usr/libexec/PlistBuddy
$PB -c "Set :CFBundleDisplayName 安妮播放器 Lite" "$APP/Contents/Info.plist"
$PB -c "Set :CFBundleName 安妮播放器 Lite" "$APP/Contents/Info.plist"
$PB -c "Set :CFBundleIdentifier $APP_ID" "$APP/Contents/Info.plist"
$PB -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
$PB -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"
$PB -c "Set :LSMinimumSystemVersion $MIN_MACOS" "$APP/Contents/Info.plist"
$PB -c "Set :CFBundleIconFile AppIcon" "$APP/Contents/Info.plist" 2>/dev/null || true

# GPL-3.0 合规：随包附带许可证与第三方声明 + 源码地址
[ -f "$REPO_ROOT/LICENSE" ] && cp "$REPO_ROOT/LICENSE" "$APP/Contents/Resources/LICENSE.txt"
[ -d "$REPO_ROOT/THIRDPARTY" ] && cp -R "$REPO_ROOT/THIRDPARTY" "$APP/Contents/Resources/THIRDPARTY"
cat > "$APP/Contents/Resources/开源声明.txt" << 'LICEOF'
安妮播放器 Lite（macOS）
========================

本项目基于「安妮播放器」macOS 版精简而来（移除 Apple Music 相关功能）。
许可证：GNU General Public License v3.0 only（GPL-3.0-only），完整文本见 LICENSE.txt。

对应源码：https://github.com/Zhou1019-1/AnniePlayer-LXversion （macos/lite/ 目录）
第三方组件声明见 THIRDPARTY/（洛雪组件为 Apache-2.0，各自保留原声明）。

原版 Windows 安妮播放器：无敌章鱼哥 出品 · 交流 QQ 群 1023637098
LICEOF

echo "  ✅ $(du -sh "$APP" | cut -f1) · $($PB -c 'Print :CFBundleName' "$APP/Contents/Info.plist") v$($PB -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"

# ---------- 4. ad-hoc 签名 ----------
echo "=== 4. 签名（ad-hoc）==="
codesign --force --deep --sign - "$APP" 2>/dev/null && echo "  ✅ 已签名（ad-hoc）" || echo "  ⚠️ 签名失败（不影响本机使用）"

# ---------- 5. 安装说明 + 打包 ----------
echo "=== 5. 打包产物 ==="
README_TMP="$BUILD/安装说明.txt"
cat > "$README_TMP" << 'READMEEOF'
安妮播放器 Lite · macOS 版
==========================

【这个版本有什么】
  本地播放（ALAC / FLAC / WAV / MP3 / AAC / OGG / OPUS，bit-perfect 输出）
  + 在线音乐（酷我 / 酷狗 / 网易云 / 咪咕 / QQ 音乐搜索）
  + Qobuz（用自己的账号，最高 24bit/192kHz FLAC）
  + 歌词 / 桌面歌词 / 三套界面 / 迷你模式 / 频谱可视化
  ★ 没有 Apple Music，不需要虚拟机，不需要登录任何账号，开箱即用。

【安装】
1. 把「安妮播放器 Lite.app」拖到「应用程序」文件夹
2. 首次打开如果提示「无法验证开发者」：
   系统设置 → 隐私与安全 → 滚到最底部「安全性」区域
   → 点「仍要打开」→ 输入开机密码 → 确定（只需一次）
   如果找不到「仍要打开」按钮，打开「终端」执行（把路径换成你的）：
   xattr -cr "/Applications/安妮播放器 Lite.app"

【运行要求】
- macOS 13.0 或更高（macOS Ventura 及以上），Apple Silicon / Intel 均可
- 不联网也能放本地音乐；在线功能需要联网

【数据位置】
  ~/Library/Application Support/AnnieMac（曲库 / 设置 / 下载记录）
  Qobuz 登录只保存 token（不保存密码），退出登录会直接删除绑定文件。

【许可证】
  GPL-3.0-only，随包附 LICENSE.txt / THIRDPARTY / 开源声明.txt

【反馈】
邮箱：2947205204@qq.com
GitHub：https://github.com/Zhou1019-1/AnniePlayer-LXversion/issues

【致谢】
原版 Windows 安妮播放器：无敌章鱼哥 出品 · 交流 QQ 群 1023637098
READMEEOF

SAFE_VER=$(echo "$VERSION" | tr -cd '0-9A-Za-z.-')

ZIP_OUT="$DIST/annie-player-lite-macos-${SAFE_VER}.zip"
ZIP_STAGE="$BUILD/zipstage"; rm -rf "$ZIP_STAGE"; mkdir -p "$ZIP_STAGE"
cp -R "$APP" "$ZIP_STAGE/"
cp "$README_TMP" "$ZIP_STAGE/"
( cd "$ZIP_STAGE" && ditto -c -k --sequesterRsrc --zlibCompressionLevel 9 . "$ZIP_OUT" )
echo "  ✅ ZIP: $(du -h "$ZIP_OUT" | cut -f1)"

DMG_OUT="$DIST/AnniePlayer-Lite-${SAFE_VER}.dmg"   # ⚠️ 资产名用 ASCII：GitHub Release 会剥离中文，曾产出 "-Lite-1.0.1.dmg"
DMG_STAGE="$BUILD/dmgstage"; rm -rf "$DMG_STAGE"; mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
cp "$README_TMP" "$DMG_STAGE/安装说明.txt"
if hdiutil create -volname "安妮播放器 Lite" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_OUT" 2>&1 | tail -1; then
  echo "  ✅ DMG: $(du -h "$DMG_OUT" | cut -f1)"
else
  echo "  ❌ DMG 创建失败"; exit 1
fi

echo ""
echo "=== 6. 产物清单 ==="
ls -lh "$DIST"
echo ""
echo "✅ 完成"
