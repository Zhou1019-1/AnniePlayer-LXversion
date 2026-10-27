# 安妮播放器 · macOS 版

Windows 版《安妮播放器》的 macOS ARM64 移植（原生 Swift + WKWebView）。

## 技术栈

| 层 | 技术 |
|---|---|
| App 外壳 | AppKit（NSWindow + WKWebView + 原生菜单栏图标） |
| 前端 | 原版 web 资源（HTML/CSS/JS，三套主题：粒子舞台 / FB2K / Apple Music） |
| 本地服务 | LocalServer（NWListener，随机端口，供 WKWebView 加载 http://） |
| 音频引擎 | AVFoundation（AVPlayer + AVAssetReader，支持 ALAC/FLAC/WAV，bit-perfect 输出） |
| Apple Music | LMKSign + Anisette（connect-proxy + QEMU wrapper 解密） |
| 登录 | Lima 虚拟机跑 am-login-server（两阶段 2FA） |
| 在线音乐 | 洛雪 SDK（lx-gen）+ 自定义音源脚本（kw/kg/wy/mg/tx） |

## 目录结构

```
macos/
├── src/                  # 42 个 Swift 文件
│   ├── App.swift         # 入口 / 窗口 / 菜单
│   ├── Bridge.swift      # JS ↔ Swift 桥（200+ 方法）
│   ├── AudioEngine.swift # 播放引擎
│   ├── LRMeter.swift     # L/R 电平表（并行解码 PCM）
│   ├── SpectrumAnalyzer.swift  # FFT 频谱分析（vDSP）
│   ├── DesktopLyrics.swift     # 桌面歌词窗口（NSPanel）
│   ├── MenuBarItem.swift       # 菜单栏图标
│   ├── SourceAPI.swift         # 多平台音源
│   ├── LoginBridge.swift       # 登录桥
│   ├── QemuLogin.swift         # QEMU 登录
│   ├── VMInstaller.swift       # Lima 虚拟机安装
│   ├── ServiceShutdown.swift   # 服务生命周期
│   └── ...
├── web/                  # 前端资源（12MB）
│   ├── index.html
│   ├── desktop-lyrics.html
│   ├── css/  js/  lx-sdk/  lx-gen/  lx-runtime/  lx-sources/
├── assets/               # 小资源（图标/配置/脚本）
├── scripts/              # 构建与工具脚本
└── build-dmg.sh          # 一键打包 DMG
```

## 本地开发

**要求**：macOS 15.0+（Apple Silicon）、Xcode Command Line Tools

```bash
# 编译
swiftc -O -parse-as-library -target arm64-apple-macosx15.0 -o /tmp/annie src/*.swift

# 打包（生成 DMG）
./build-dmg.sh 1.0.0
```

## 大二进制依赖（不进 git）

以下文件**不进仓库**，放在 GitHub Release 资产里，首次启动时自动下载：

| 文件 | 大小 | 用途 |
|---|---|---|
| `ubuntu.img` | 588MB | Lima 登录虚拟机的 Ubuntu 根文件系统（中科大镜像） |
| `limactl` | 31MB | Lima 命令行工具（lima 官方 Release） |
| `wrapper-lite-slim.zip` | 71MB | QEMU 运行时（`wrapper-lite-v2`，含 27 个 dylib） |
| `wrapper-pkg` | 49MB | am-login 部署包（已打包进 App，`assets/wrapper-pkg.zip`） |

**所有依赖都从官方源或仓库已有 Release 下载，无需手动上传大文件。**

## 已实现功能

### 本地播放
- ALAC / FLAC / WAV / MP3 / AAC / OGG / OPUS
- 音质徽章（编码 · 位深 · 采样率）
- L/R 电平表（真实声道解码，0.05s 刷新）
- 波形（整曲 1600 点包络）+ 频谱（192 频段 × N 帧 FFT 热力图）
- 播放列表 / 收藏 / 导入导出 / 统计 / 备份

### Apple Music
- 登录（支持两阶段 2FA 验证码）
- 搜索 / 播放 / 下载 ALAC 无损
- 退出登录自动清除设备记录 + 抹设备指纹

### Qobuz
- 搜索 / 播放 / 下载（最高 24bit/192kHz FLAC）

### 多平台在线音乐（洛雪 SDK）
| 平台 | 搜索 | 播放 |
|---|---|---|
| 酷我 kw | ✅ | ✅ |
| 酷狗 kg | ✅ | ✅ |
| 网易云 wy | ✅ | ✅ 320k |
| 咪咕 mg | ✅ | ✅ |
| QQ tx | ✅ | ❌ 后端风控限制 |

### 界面
- 三套主题可切换：粒子舞台 / FB2K / Apple Music（顶栏调色板按钮弹菜单）
- 迷你模式（等比拉伸 360~540px）/ 纯净模式
- 桌面歌词（独立透明窗口，可锁定穿透 + 悬浮解锁）
- 沉浸模式（歌词 / 队列 / 彩胶唱片）

### 系统集成
- 菜单栏图标（显示/隐藏窗口、播放控制、桌面歌词、退出）
- 关闭行为（隐藏到菜单栏 / 直接退出）
- 退出 App 自动停止所有后台服务

## 发版

```bash
git tag mac-v1.0.0
git push origin mac-v1.0.0
```

触发 `.github/workflows/release-mac.yml`，自动构建并发布 prerelease。

**⚠️ 必须保持 prerelease**：见 `macos/AGENTS.md` 第二节（防止抢走 Windows 线的 `releases/latest` 指针）。

## 致谢

- 原版 Windows 安妮播放器：无敌章鱼哥 出品
- 洛雪音乐 SDK：lyswhut
