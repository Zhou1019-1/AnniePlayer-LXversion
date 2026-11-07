# 安妮播放器 Lite · 更新日志

## V1.0.3（2026-11-08）

独立功能核查后的缺陷修复。**关键：其中大部分是完整版 macOS 与 Lite 共用的代码，完整版构建同样受益（下次完整版发版可直接复用）。**

### 修复

- **在线音乐页单曲下载（⬇ → `streamDownload`）崩溃**：进度回调来自 URLSession 后台线程却直接调
  `WKWebView.evaluateJavaScript`，触发 WebKit 主线程断言（EXC_BREAKPOINT）。改为
  `DispatchQueue.main.async` 派发（与下载队列一致）。
- **酷我单曲下载被 ATS 判失败**：`Info.plist` 同时存在 `NSAllowsArbitraryLoadsInWebContent` /
  `NSAllowsLocalNetworking` 时，系统会**忽略** `NSAllowsArbitraryLoads`，音源 302 到 http CDN
  的下载/封面请求被 ATS 拒绝。移除这两个键，由 `NSAllowsArbitraryLoads` 统管；同时修好
  电平表（LRMeter）远程下载被 ATS 拦的问题。
- **频谱/波形分析、曲库扫描进度、单曲下载百分比事件前端收不到**：前端 `index.html` 监听的是
  `window.__analyzeEmit` / `window.__scanEvent`，后端却推注入层的 `mine.__emit_on*` 空通道。
  后端改推正确通道；`__amDownloadProgress` 补转发 `onStreamDownloadProgress` 回调。
- **曲库快照 `folders` 恒为空**：`librarySnapshot()` 改为读取 `LibraryScanner.folders` 真实列表，
  侧栏文件夹 chip / 移除 / 文件夹过滤恢复。
- **设置中心重启不恢复**：`getLibrary().ui` 改为读取 `Settings`（`saveSettings` 已写入 UserDefaults
  的 `annie.settings.ui`），`player.js` 启动时 `hydrate` 读回。
- **备份会带走 Qobuz 账号**：备份导出与大小估算都剔除 `qobuz.json`（与 1.0.1 更新日志承诺一致）。
- **Lite 二进制残留 wrapper-lite/qemu/amdl 字符串**：`EnvPaths.swift` 整体加 `#if !LITE`
  （引用者只有完整版的 LoginBridge/QemuLogin，Lite 不再编译该文件）。

### 打包

- 版本号 1.0.3；产物名沿用 ASCII：`AnniePlayer-Lite-1.0.3.dmg` / `annie-player-lite-macos-1.0.3.zip`。

## V1.0.2（2026-11-08）

打包修正，无功能改动。

- **Release 资产名改用 ASCII**：GitHub Release 会剥离中文资产文件名，
  1.0.1 的 DMG 被发成 `-Lite-1.0.1.dmg`。现在 DMG 产物名改为
  `AnniePlayer-Lite-{版本}.dmg`（ZIP 本来就是 ASCII，不受影响）。
- 本地构建产物同步改名（App 显示名、DMG 卷名仍是「安妮播放器 Lite」）。

> 只记录 Lite 线（`mac-lite-v*`）。完整版 macOS 的更新日志见 `更新日志-mac.md`。

## V1.0.1（2026-11-08）

首个 Lite 版本：完整版 macOS 版去掉 Apple Music 后的精简版，同一份源码 `-D LITE` 构建。

### 与完整版的差异

- **移除**：Apple Music 登录 / 曲库搜索 / ALAC 无损播放与下载、Lima 虚拟机（Ubuntu 镜像 588 MB + limactl）、
  QEMU wrapper-lite（172 MB）、FairPlay 解密（HLS / MP4 / temari.wasm）、connect-proxy、
  前端 Apple Music 独立板块（`am-apple.js`）、登录/Token 弹窗、侧栏 🍎 入口
- **体积**：约 1.0 GB → 16 MB（DMG 9.5 MB / ZIP 7.3 MB）
- **架构**：arm64 → universal（arm64 + x86_64，Intel 可用）
- **最低系统**：macOS 15.0 → 13.0
- **零部署**：无外部二进制、无运行时下载、无虚拟机、无首启等待；退出无残留进程

### 保留

- 本地播放：ALAC / FLAC / WAV / MP3 / AAC / OGG / OPUS，bit-perfect 输出、EQ、独占模式
- 在线音乐：酷我 / 酷狗 / 网易云 / 咪咕（QQ 音乐仅搜索）
- Qobuz：搜索 / 播放 / 下载（最高 24bit/192kHz FLAC）
- 歌词：LRCLIB + 五平台兜底、逐字歌词、桌面歌词
- 三套界面（粒子舞台 / FB2K / Apple Music 风格皮肤）、迷你模式、频谱 / 电平 / 波形
- 菜单栏、深浅色、下载队列、播放续播

### Qobuz 账号安全加固（同版本包含）

- 不再把 Qobuz 密码明文写盘；旧版本残留的 `password` 字段在 App 启动时自动清洗
- 退出登录 = 清空内存 + **删除凭据文件**
- 备份导出**不包含** `qobuz.json`（发备份不会顺走账号）
- 凭据文件 `0600`、数据目录 `0700`；界面不显示用户 token
- 网络代理改为「系统代理 → 本机 65532 → 直连」，不再写死 65532（原来别人电脑上 Qobuz 会全失败）

### 打包

- 构建：`./macos/lite/build-dmg-lite.sh 1.0.1`（CI 见 `.github/workflows/release-mac.yml` 的 `build-mac-lite` job）
- 前端由 `web-patch.py` 在构建时从 `macos/web` 生成，不维护第二份
- App 资源内附 `LICENSE.txt` / `THIRDPARTY` / `开源声明.txt`（GPL-3.0 合规）
- 未签名（ad-hoc），首次打开需按安装说明放行一次
