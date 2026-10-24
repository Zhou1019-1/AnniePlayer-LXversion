# 音频后端架构说明（macOS）

## 为什么不用 Windows 的 AnnieEngine

主线的 AnnieEngine 是 **C# / Windows 专用**（WASAPI 独占 / ASIO 输出 / .NET 运行时）。
macOS 没有这两套 API，也不适合在 App 里塞 .NET 运行时，所以 mac 版**自研音频后端**。

## 后端选择：AVFoundation

| 方案 | 评价 | 结论 |
|---|---|---|
| AVFoundation（AVPlayer + AVAssetReader） | 系统原生、免费、支持 ALAC/FLAC/WAV、CoreAudio 直通 | ✅ 采用 |
| PortAudio / RtAudio | 要自己解 ALAC/FLAC（需额外库） | ❌ 复杂 |
| libmpv | 支持格式多但体积大、和 UI 同步麻烦 | ❌ 过重 |
| CoreAudio HAL 直写 | 最底层、可完全控制，但需要自己解码 | ❌ 工作量大 |

## 播放链路

```
用户点歌
  ↓
Bridge.swift: case "engine" → AudioEngine.shared.play(path:)
  ↓
AVPlayer + AVPlayerItem（本地文件 / http 流）
  ↓
addPeriodicTimeObserver(0.1s) → emit("position", ...) → 前端进度/歌词
                              → emit("lrlevel", ...) → L/R 电平表
```

### bit-perfect 保证

- 本地文件直接 `AVPlayerItem(url: fileURL)`，不经任何重采样
- 输出设备格式由 CoreAudio 决定（`AudioEngine.shared.currentDeviceFormat`）
- 音质徽标显示的编码/位深/采样率来自 `AVAssetReader` 解析的文件头

### 格式支持矩阵

| 格式 | 支持 | 说明 |
|---|---|---|
| ALAC (.m4a) | ✅ | AVFoundation 原生 |
| FLAC | ✅ | macOS 10.13+ 原生 |
| WAV / AIFF | ✅ | |
| MP3 / AAC | ✅ | |
| OGG / OPUS | ⚠️ | 部分文件（无原生解码器） |
| DSD (.dsf/.dff) | ⚠️ | 暂不支持 |

## L/R 电平表实现

`LRMeter.swift`：**独立 AVAssetReader 并行解码**（不影响播放）：

```swift
LRMeter.shared.start(path: path, at: 0)   // 播放开始时启动
LRMeter.shared.tick()                      // 每 0.1s 取一次 RMS
```

- 解码为 float32 交错 PCM（44100Hz / 2ch）
- 每 0.1s 的 chunk 计算 L/R 各自的 RMS → 归一化 0..1
- **远程 URL**：`AVAssetReader` 不支持 http，先 `URLSession.downloadTask` 到缓存文件再解码

## 频谱分析

`SpectrumAnalyzer.swift`：vDSP FFT（1024 点 Hann 窗）

```
AVAssetReader 解码 → 单声道 float32
  ↓ 每 0.125s 一个 chunk
vDSP_ctoz → vDSP_fft_zrip → vDSP_zvabs
  ↓ 1024 bin → 192 个对数频段（20Hz~20kHz）
dB 归一化（-80dB..0dB → 0..255）
  ↓ 分批 emit("frames", frames: Uint8Array, count)
前端 viz.js: appendSpecFrames() → canvas 热力图
```

- 波形：每 chunk 的峰值 → 重采样 1600 点 → 归一化 + 幂压缩（2/3 次方）
- 前端协议：`{type:'frames'|'done'|'lossless'|'error', gen, ...}`

## Apple Music 解密链路

```
LMKSign（Swift 实现，src/TemariWasm.swift）
  ↓ 用 Anisette 数据签名（需要设备指纹 + 机器 ID）
connect-proxy.py（8443，Apple Anisette CONNECT 代理）
  ↓
QEMU + wrapper-lite（12340，跑 amLinux 解密服务）
  ↓
Lima 虚拟机（annie-am-login，am-login-server）
  ↓ 两阶段 2FA 登录
Apple Music API（ALAC 媒体流）
  ↓
AudioFetcher 解密 → 本地缓存文件
  ↓
AVPlayer 播放
```

### 为什么需要虚拟机

Apple 的 Anisette 服务要求真实的 iOS/macOS 设备环境（设备指纹、机器 ID、Apple 服务握手）。
Windows 版用 QEMU 跑 amLinux（完整的 Android 环境）。mac 版简化方案：

- 用 **Lima** 跑一个极简 Ubuntu（255MB RAM），里面只跑 `am-login-server`
- **不跑完整 amLinux**（省内存：255MB vs 2GB）
- 登录完成后把 token 同步到 QEMU wrapper 的 `data.img`

## 服务生命周期

`ServiceShutdown.swift` + `App.swift`：

| 时机 | 动作 |
|---|---|
| App 启动 +1s | `ConnectProxyManager.ensureRunning()`（8443） |
| App 启动 +3s | `LoginBridge.ensureServiceRunning()`（QEMU 12340） |
| App 启动 +5s | `VMInstaller.ensureLoginVM()`（Lima 虚拟机） |
| App 退出 | `ServiceShutdown.run()`（停止全部服务 + `limactl stop -f`） |

## 内存占用（实测）

| 组件 | 内存 |
|---|---|
| App（Swift + WKWebView） | 12.8 MB |
| QEMU（wrapper-lite） | 0.2 MB 空闲 / ~20 MB 播放 |
| wrapper 进程 | 0.6 MB |
| connect-proxy | 1 MB |
| Lima 虚拟机（最小） | 255 MB |
| **合计** | **≈290 MB** |

对比：如果用完整 snowluma VM（14GB）→ 2.05GB。选择了最小化方案。
