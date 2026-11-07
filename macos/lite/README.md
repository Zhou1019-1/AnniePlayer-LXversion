# 安妮播放器 Lite（macOS）

完整版 macOS 应用去掉 Apple Music 后的精简版。**同一份 `macos/src`，编译时加 `-D LITE`**，不维护第二套源码。

| | 完整版（macos/） | Lite（macos/lite/） |
|---|---|---|
| 编译 | `swiftc -target arm64-apple-macosx15.0 src/*.swift` | `swiftc -D LITE -target {arm64,x86_64}-apple-macosx13.0 src/*.swift` |
| Apple Music / Lima VM / QEMU / FairPlay 解密 | 有 | **无**（`#if !LITE` 排除） |
| 体积 / 首启 | ~1.0 GB / 首次装 VM 5~10 分钟 | ~16 MB / 秒开 |
| 架构 / 最低系统 | arm64 / macOS 15 | universal（arm64+x86_64）/ macOS 13 |
| 发布 tag | `mac-v*` | `mac-lite-v*` |

## 构建

```bash
# 在仓库根目录
./macos/lite/build-dmg-lite.sh 1.0.1
```

产物在 `macos/dist/`：

```
AnniePlayer-Lite-1.0.1.dmg
annie-player-lite-macos-1.0.1.zip
```

脚本会：编译两个架构 → lipo universal → 用 `web-patch.py` 从 `macos/web` 现场生成 Lite 前端 → 从零组装 App（不带完整版的 deps/lima）→ ad-hoc 签名 → 打 DMG/ZIP。会把 `LICENSE` / `THIRDPARTY` / `开源声明.txt` 一并放进 App 资源（GPL-3.0 合规）。

## 编译开关约定

- 源码里所有 Apple Music / VM / QEMU 相关代码都在 `#if !LITE` 里，**完整版构建行为完全不变**
- Lite 构建时这些方法在 `Bridge.allMethods` 里仍保留名字（只是白名单，没有对应 dispatch case，调用无副作用）；这样不用在数组字面量里塞 `#if`（Swift 不支持）
- 前端不复制第二份：`web-patch.py` 在构建时删掉 Apple Music 页面/弹窗/侧栏入口，锚点匹配失败会直接报错，不会静默产出坏包

## 发版

推 `mac-lite-v*` 标签：

```bash
git tag mac-lite-v1.0.1
git push origin mac-lite-v1.0.1
```

`.github/workflows/release-mac.yml` 里的 `build-mac-lite` job 会自动构建并发布到 GitHub Release（**prerelease**，硬规则：不能抢 Windows 主线的 `releases/latest` 指针）。

版本说明写在 `macos/更新日志-lite.md`，workflow 自动按 `## V{版本}` 提取为 Release notes。

## 和完整版共用目录的注意

- 数据目录相同（`~/Library/Application Support/AnnieMac`），曲库/歌单/设置互通
- Qobuz 凭据是共享的：Lite 版已加固（不存密码、退出删文件、备份不含凭据），完整版旧构建仍有旧行为
- 两个 App 的 bundle id 不同（`com.annie.player.mac` / `com.annie.player.mac.lite`），可以同时安装
