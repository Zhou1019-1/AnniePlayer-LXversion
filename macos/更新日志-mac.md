# 安妮播放器 macOS 版 · 更新日志

## V1.0.3（2026-11-08）

修复 macOS 线共享代码的缺陷（与 Lite 1.0.3 同批修复，Apple Music 功能与既有完整版一致、未改动）：

### 修复

- **在线音乐页单曲下载崩溃**：`SourceAPI.download` 的进度回调在 URLSession 后台线程直接调
  `WKWebView.evaluateJavaScript`，触发 WebKit 主线程断言（EXC_BREAKPOINT）。改为主线程派发。
- **酷我（及部分音源）下载被 ATS 拦**：`Info.plist` 同时存在 `NSAllowsArbitraryLoadsInWebContent` /
  `NSAllowsLocalNetworking` 时，系统会忽略 `NSAllowsArbitraryLoads`，音源 302 到 http CDN 的
  下载/封面请求被拒。移除这两个键；同时修好电平表（LRMeter）远程下载。
- **频谱/波形分析、曲库扫描进度、单曲下载百分比事件前端收不到**：后端改推
  `window.__analyzeEmit` / `window.__scanEvent`（`index.html` 实际监听的通道）；
  `__amDownloadProgress` 补转发 `onStreamDownloadProgress` 回调。
- **曲库快照 `folders` 恒为空 / 设置中心重启不恢复**：`librarySnapshot()` 改为读取
  `LibraryScanner.folders` 与 `Settings` 持久化的 `ui`。
- **备份导出/估算包含 `qobuz.json`**：会把 Qobuz 登录 token 随备份带走，现已剔除。

### 打包

- arm64 / macOS 15+；版本号 1.0.3。

## V1.0.0（2026-10-24）

**首个 macOS ARM64 版本**（Windows 版完整移植）

### 核心功能

- **本地音乐播放**：ALAC / FLAC / WAV / MP3 / AAC / OGG / OPUS，AVFoundation 解码，bit-perfect 输出
- **Apple Music**：登录（两阶段 2FA）、搜索、播放、下载 ALAC 无损；退出登录自动清除设备记录 + 抹设备指纹
- **Qobuz**：搜索 / 播放 / 下载（最高 24bit/192kHz FLAC）
- **多平台在线音乐**（洛雪 SDK + 自定义音源脚本）：
  - 酷我 kw：搜索 ✅ 播放 ✅
  - 酷狗 kg：搜索 ✅ 播放 ✅
  - 网易云 wy：搜索 ✅ 播放 ✅ 320k
  - 咪咕 mg：搜索 ✅ 播放 ✅
  - QQ tx：搜索 ✅ 播放 ❌（后端风控限制）
- **歌词**：LRCLIB 优先 + 五平台兜底；LRC / 逐字卡拉 OK / 双语
- **桌面歌词**：独立透明置顶窗口，可拖动；锁定后窗口完全穿透（不挡下层操作）+ 鼠标经过浮现小锁解锁；工具条鼠标扫过即显示
- **沉浸模式**：大歌词 / 队列抽屉 / 彩胶唱片（真实惯性物理）
- **迷你模式**：等比拉伸 360~540px；纯净模式只留封面/歌名/进度/歌词
- **三套界面**：粒子舞台（视觉优先）/ FB2K（效率优先）/ Apple Music（美学优先），顶栏调色板按钮切换

### 音频可视化

- **L/R 电平表**：真实左右声道解码（AVAssetReader 并行解码，不阻塞播放），在线流媒体自动下载到缓存后解码
- **波形**：整曲 1600 点峰值包络，播放前进部分变金色
- **频谱**：vDSP FFT（1024 点 Hann 窗）→ 192 频段对数分布 × 每秒 8 帧，热力图 + 频率刻度

### 系统集成

- **菜单栏图标**（macOS 的「托盘」）：显示/隐藏窗口、上一首/播放暂停/下一首、桌面歌词开关/解锁、退出
- **关闭行为**：隐藏到菜单栏 / 直接退出（设置可选）
- **服务生命周期**：启动自动拉起 connect-proxy(8443) + QEMU(12340) + Lima 登录虚拟机；退出 App 全部停止
- **深浅色**：跟随系统 / 手动切换，桌面歌词同步

### 界面适配（macOS 化）

- 全部 Windows 文案改 macOS 说法：托盘→菜单栏、任务栏→Dock、资源管理器→访达、WASAPI/ASIO→CoreAudio、SMTP→Now Playing
- 移除 Windows 风格窗口按钮（— □ ×），统一用系统红绿灯
- 顶栏布局：红绿灯 → 🎨 主题切换 → ⚙ 设置 → 标题
- 桌面歌词字体改系统字体（-apple-system / PingFang SC）

### 与 Windows 版的语义变更

| Windows | macOS |
|---|---|
| WASAPI 独占 / ASIO 输出 | CoreAudio 独占输出 |
| 系统托盘 | 菜单栏图标 |
| 任务栏进度条 | Dock 进度条 |
| 资源管理器 | 访达 |
| SMTC 系统媒体会话 | Now Playing（MPNowPlayingInfoCenter） |
| Win+ 快捷键 | ⌘ 快捷键 |

### 已知限制

- QQ 音乐搜索可用但**播放受后端风控限制**（返回「触发人机验证」）
- 首次登录 Apple Music 需要虚拟机初始化（约 2~5 分钟，取决于网络）
- 未签名版本首次打开需「右键 → 打开」或手动允许（见安装说明）

### 首次发布

- 发布通道：GitHub Release（prerelease，不抢 Windows 线 latest 指针）
- 架构：arm64（Apple Silicon）
- 安装包：DMG + ZIP（含安装说明）
