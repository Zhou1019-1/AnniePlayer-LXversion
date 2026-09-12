# AnniePlayer SVLX — 安妮播放器 × 洛雪音乐 深度融合版（发行名：安妮播放器融合版V3）

将 [洛雪音乐(lx-music-desktop)](https://github.com/lyswhut/lx-music-desktop) 的**核心功能模块代码级集成**进安妮播放器：同一 Electron 进程、统一 UI、连贯操作流，而非双应用启动器。

> 下载安装包请见 [Releases](../../releases)（`安妮播放器融合版V3-vX.Y.Z-setup.exe`，未签名，SmartScreen 提示时点「更多信息 → 仍要运行」）。
> 本应用由无敌章鱼哥开发；更多 HiFi 资源，加入 Q 群 1023637098 获取。

## 功能

### 三套并列主题（设置 → 外观，或命令面板 Ctrl+K 切换）

- **粒子舞台**：Three.js 3D 可视化舞台（Mineradio 视觉栈 + sonic-topography 声波地形），13 个预设含「音域回响」（Wallpaper Engine 桥接）与月蚀圣环/雨幕霓虹/折光蝶群/深海绽放四个新着色器预设，节拍驱动相机
- **FB2K**：仿 foobar2000 效率界面，暗色模式、虚拟滚动（5000+ 首 60fps）
- **Apple Music（v1.2.0 新增）**：磨砂玻璃 + 封面氛围大模糊背景 + AM 风格大字号逐行歌词（点击行跳转），亮/暗双主题；AM Windows 式顶栏（传输控制/迷你封面/进度+当前与剩余时间/音质徽标）；侧栏资料库（歌曲/专辑/文件夹/喜爱）+ 内嵌洛雪在线搜索（五平台、音质选择、单击即播、自动续播）

### 本地曲库

- 扫描 Worker（崩溃自动降级）、CUE 分轨、**SACD ISO 分轨（v1.2.0 新增，sacd_extract 探测）**
- **自建播放列表（v1.2.0 新增）**：新建/重命名/删除/加歌/移除，library.json 持久化，三主题共享
- 响度归一（EBU R128）、假无损批量检测（Goertzel）、AnnieEngine 独占解码输出、15 段 EQ（RBJ biquad 热更新）、桌面歌词、迷你模式

### 流媒体（洛雪深度融合）

- 洛雪 musicSdk 原版移植，五大平台（酷狗 / 酷我 / 咪咕 / QQ / 网易）+ 分页加载
- **自定义音源**：洛雪 2.x 同款模式——导入 `.js` 音源脚本（vm 沙箱隔离执行），启停/删除/多音源回退
- **音质分级**：Hi-Res 24bit / 无损 FLAC / 极高 320K / 标准 128K，播放与下载共用；URL 实际格式校验，音源乱标音质会被识别并自动降级 + 明确提示
- **流媒体下载**：自定义下载目录，实时进度，按音质落盘
- **歌词链路**：洛雪原版解密——酷狗 KRC（XOR+zlib）、酷我 lrcx（yeelion+gb18030）、QQ QRC（qrc_decode 原生模块）、咪咕 mrc

### 性能工程（v1.2.0）

- **专辑级封面共享**：每张专辑只解析一次封面，专辑内所有行复用（配合并发限流），大曲库表格滚动不卡
- **舞台休眠**：切到 AM/FB2K 主题后 3D 舞台渲染完全停止（GPU 零占用），主循环降为 4fps 心跳；可视化分析（ffmpeg 全曲解码）同步门控，切歌零后台负载
- metaCache 持久化：全库标签解析只有一次成本；搜索时后台分块深加载

## 技术架构

```
AnniePlayerSVLX.exe (Electron 42, 单进程)
├── src/main.js              入口: 单例锁 / 便携模式 / 系统托盘
├── annie/main/              安妮主进程: 引擎 RPC / 曲库扫描 / CUE / SACD ISO / 响度 / 播放列表
│   └── streaming/           ★ 洛雪深度融合层
│       ├── lx-sdk/          洛雪 musicSdk 原版代码(零修改, ESM loader 别名解析)
│       ├── sources.js       音源沙箱: lx.on/lx.request/lx.utils.crypto 全兼容
│       ├── lxsdk.js         桥接: 搜索/播放URL/歌词/音质回退 + 格式校验
│       └── index.js         IPC 路由 + 流式下载
├── annie/renderer/          安妮 UI：粒子舞台(modules/00~11) / FB2K / Apple Music 三主题并列
└── engine/                  AnnieEngine 解码引擎 sidecar + ffmpeg/sacd_extract(不入库,见下)
```

洛雪代码来源与声明见 [THIRDPARTY/lx-music-desktop/](THIRDPARTY/lx-music-desktop/NOTICE.LICENSE)（Apache-2.0）。

## 构建

```powershell
npm install

# 构建前需放入 AnnieEngine 二进制(由 AnnieEngine 引擎项目构建产出):
#   engine/publish/  → AnnieEngine.exe 及 .NET 运行时
#   engine/tools/    → ffmpeg.exe / ffprobe.exe / sacd_extract.exe

npm run dist:setup   # 产出 setupEXE/安妮播放器融合版V3-vX.Y.Z-setup.exe (NSIS x64)
```

打包直接复用 `node_modules/electron/dist`（`electronDist` 配置），无需联网下载 Electron。
开发运行：`npm start`（同样需要 engine/ 二进制）。

## 致谢

- **电狗（[@chenhaochen66](https://github.com/chenhaochen66)）**：PR #1 贡献——音源沙箱 Worker 化（脚本卡死不再冻结主进程）、下载元数据/内嵌歌词写入（tagWriter）、WASAPI 独占/共享开关、QQ 免签搜索与纯 JS QRC 歌词解密、国内镜像打包配置、AnnieEngine 引擎源码入库，以及「安妮独家音源」公益 API 的收集整理
- [洛雪音乐 lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)（Apache-2.0）：流媒体 SDK 与歌词解密方案
- [Mineradio](https://github.com/XxHuberrr/Mineradio) / [sonic-topography](https://github.com/yin-yizhen/sonic-topography)：粒子舞台视觉栈与声波地形算法

## 许可证与免责

- 本项目整体：**GPL-3.0-only**（随安妮播放器）
- 洛雪组件：**Apache-2.0**，已保留原始许可声明
- 音源解析能力仅供学习交流，请遵守各音乐平台服务条款；第三方音源脚本由其作者负责，与本项目无关
