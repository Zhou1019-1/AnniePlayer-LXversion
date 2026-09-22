# 安妮播放器融合版 V3（AnniePlayer SVLX）

> 无敌章鱼哥出品 · HiFi 桌面播放器：自研 .NET 独占音频引擎 + 洛雪音乐源深度融合 + 三套界面主题
> 交流 Q 群：**1023637098**（更多 HiFi 资源群公告获取）

[![release](https://img.shields.io/github/v/release/Zhou1019-1/AnniePlayer-LXversion?display_name=tag&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/Zhou1019-1/AnniePlayer-LXversion/releases/latest)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

## 下载安装

**[→ 前往 Releases 下载最新安装包](https://github.com/Zhou1019-1/AnniePlayer-LXversion/releases/latest)**（`V3.x.x-setup.exe`，约 160MB）

- 系统要求：**Windows 10 / 11 64 位**（内置全部运行库，无需装 .NET / VLC / 任何依赖）
- 安装包未购买代码签名，SmartScreen 提示时点 **「更多信息 → 仍要运行」** 即可
- **在线更新**：V3.3.1 之后的版本支持差量自动更新，打开软件即静默下载、下次启动生效（每次只需下载几 MB）
- 覆盖安装 / 升级不会丢失曲库、歌单与设置（数据在 `%APPDATA%\annie-player-svlx`）

## 三套界面主题（设置中心 → 常规，随时切换）

| 主题 | 风格 | 适合 |
| --- | --- | --- |
| **Apple Music** | 磨砂玻璃 + 封面氛围背景 + 大字逐行歌词，亮/暗双主题 | 默认主题，颜值党 |
| **FB2K** | 仿 foobar2000 经典布局，信息密度高，虚拟滚动 10 万首不卡 | 效率党 |
| **粒子舞台** | Three.js 3D 粒子可视化舞台，13 个视觉预设，节拍驱动相机 | 视觉党、投屏氛围 |

## 核心能力

**音质链路**
- WASAPI 独占（bit-perfect 直通）/ 共享、ASIO 直通（面板/采样率/缓冲控制）、DSD 转 PCM / DoP
- 自研 AnnieEngine 解码引擎（.NET 9 sidecar + ffmpeg）：32bit float PCM 域处理
- 15 段参数 EQ（引擎热更新不破音）、削波防护（自动前级 + tanh 软限幅）
- 响度均衡 EBU R128（目标 -16 LUFS，**ReplayGain 标签直读免分析**）
- **无缝播放 Gapless**（切歌保持输出流，间隙毫秒级）、交叉淡入 0–10s
- 重采样质量档位（标准 / 高质量 64 阶滤波）
- 输出设备打开失败自动回退 WASAPI 共享并提示，永不"点播放没反应"

**曲库管理**
- 全格式：FLAC / APE / WAV / DSF / DFF / TTA / M4A / MP3 / OGG / OPUS / WMA…
- CUE 整轨分轨、**SACD ISO 分轨**（sacd_extract）
- 标签编辑器（单曲 + **批量**，勾选式写回）、在线匹配歌词/封面（五平台）
- 假无损批量检测（Goertzel 频谱分析）、重复歌曲检测、播放统计
- 自建播放列表（三主题共享）、喜爱列表、收藏不依赖云端

**在线音乐（洛雪深度融合）**
- 五大平台搜索/播放/下载：酷狗 / 酷我 / 咪咕 / QQ / 网易
- 音质分级 Hi-Res 24bit / 无损 / 320K / 128K（URL 实际格式校验，虚标自动降级）
- 榜单 / 歌单广场、**歌单链接一键导入**（五平台链接或纯 ID）
- **批量下载已加载结果**、搜索历史、自定义音源脚本导入（vm 沙箱）

**其他**
- 桌面歌词（独立透明窗，逐字卡拉OK）、三主题逐字歌词、**歌词偏移微调（±0.5s 按曲记忆）**
- 迷你模式（**一键置顶 📌**）、AM 沉浸播放页（**待播清单可拖拽排序/移除**）
- 全局快捷键（媒体键 + Ctrl+Alt 组合）、播放模式五种、播放定时三种
- VST3 效果器链（原生编辑器界面 / 湿声平滑过渡 / 每插件耗时 / 方案导入导出 / A-B 对比）

## 常见问题（FAQ）

**Q：安装/更新时提示"无法关闭"或"Failed to uninstall old application files"？**
A：旧版本（≤3.5.8）的已知问题。任务管理器结束 `AnniePlayerSVLX.exe` 与 `AnnieEngine.exe` 后重试；或直接用最新 setup.exe 覆盖安装（数据不丢）。

**Q：点播放没声音/没反应？**
A：V3.5.15 起输出设备异常会自动回退 WASAPI 共享并弹提示。仍有问题请到 设置中心 → 音频输出 检查设备选择；用 USB DAC（ASIO）时确认设备已连接。

**Q：在线更新下载卡住？**
A：下载走的是 GitHub，建议挂代理或使用「安妮管家PRO」类工具的 hosts 加速；卡住可暂停后去 Releases 页手动下载覆盖安装。

**Q：杀毒软件报毒？**
A：安装包未签名 + 内含 ffmpeg 子进程调用，属误报，添加信任即可。所有代码（含引擎）均在本仓库开源。

**Q：Apple Music 浅色模式背景刺眼？**
A：V3.5.12 起已改为柔和暖白，文字对比度同步加深。右上角 ☀ 可切回深色。

## 开发与构建

```powershell
git clone https://github.com/Zhou1019-1/AnniePlayer-LXversion.git
cd AnniePlayer-LXversion
npm install
npm run setup:tools   # 下载 ffmpeg + 校验引擎/sacd_extract（首次克隆必跑）
npm start             # 开发模式运行
npm run dist:setup    # 本机打包 NSIS 安装包（含 ffmpeg 前置检查）
npm run smoke         # 冒烟测试：引擎 RPC + ffmpeg + 解码探测
```

**发布流程（CI）**：更新 `package.json` 版本号与 `更新日志.md` → push → `git tag vX.Y.Z && git push origin vX.Y.Z` → GitHub Actions 自动编译引擎、打包、冒烟测试、发布 release（约 3 分钟）。

引擎源码：`engine/src/`（.NET 9，`dotnet publish engine/src -c Release -o engine/publish`）。

## 致谢

- **电狗（[@chenhaochen66](https://github.com/chenhaochen66)）**：三主题逐字歌词（PR #2）；音源沙箱 Worker 化、下载写标签、WASAPI 独占/共享、QQ 免签搜索与纯 JS QRC 解密、AnnieEngine 引擎源码入库（PR #1）
- [洛雪音乐 lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)（Apache-2.0）：流媒体 SDK 与歌词解密方案
- [Mineradio](https://github.com/XxHuberrr/Mineradio) / [sonic-topography](https://github.com/yin-yizhen/sonic-topography)：粒子舞台视觉栈与声波地形算法

## 许可证与免责

- 本项目整体：**GPL-3.0-only**；洛雪组件：**Apache-2.0**（声明见 [THIRDPARTY/](THIRDPARTY/)）
- 音源解析能力仅供学习交流，请遵守各音乐平台服务条款；第三方音源脚本由其作者负责，与本项目无关
