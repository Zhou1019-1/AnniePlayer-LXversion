# 安妮播放器 Lite · 更新日志

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
