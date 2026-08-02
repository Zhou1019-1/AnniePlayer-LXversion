# AnniePlayer SVLX — 安妮播放器 × 洛雪音乐 深度融合版

将 [洛雪音乐(lx-music-desktop)](https://github.com/lyswhut/lx-music-desktop) 的**核心功能模块代码级集成**进安妮播放器：同一 Electron 进程、统一 UI、连贯操作流，而非双应用启动器。

> 下载安装包请见 [Releases](../../releases)（`setup.exe`，未签名，SmartScreen 提示时点「更多信息 → 仍要运行」）。

## 功能

- **本地曲库**：扫描 Worker、CUE 分轨、响度归一、AnnieEngine 独占解码输出、EQ、桌面歌词、迷你模式、3D 可视化舞台
- **流媒体搜索**：洛雪 musicSdk 原版移植，五大平台（酷狗 / 酷我 / 咪咕 / QQ / 网易）+ 分页加载
- **自定义音源**：洛雪 2.x 同款模式——导入 `.js` 音源脚本（vm 沙箱隔离执行），启停/删除/多音源回退
- **音质分级**：Hi-Res 24bit / 无损 FLAC / 极高 320K / 标准 128K，播放与下载共用；URL 实际格式校验，音源乱标音质（请求 FLAC 返回 MP3）会被识别并自动降级 + 明确提示
- **流媒体下载**：自定义下载目录，实时进度，按音质落盘
- **歌词链路**：洛雪原版解密——酷狗 KRC（XOR+zlib）、酷我 lrcx（yeelion+gb18030）、QQ QRC（qrc_decode 原生模块）、咪咕 mrc

## 技术架构

```
AnniePlayerSVLX.exe (Electron 42, 单进程)
├── src/main.js              入口: 单例锁 / 便携模式 / 系统托盘
├── annie/main/              安妮主进程: 引擎 RPC / 曲库扫描 / CUE / 响度
│   └── streaming/           ★ 洛雪深度融合层
│       ├── lx-sdk/          洛雪 musicSdk 原版代码(零修改, ESM loader 别名解析)
│       ├── sources.js       音源沙箱: lx.on/lx.request/lx.utils.crypto 全兼容
│       ├── lxsdk.js         桥接: 搜索/播放URL/歌词/音质回退 + 格式校验
│       └── index.js         IPC 路由 + 流式下载
├── annie/renderer/          安妮 UI(流媒体面板内嵌洛雪式搜索/音质/下载)
└── engine/                  AnnieEngine 解码引擎 sidecar + ffmpeg(不入库,见下)
```

洛雪代码来源与声明见 [THIRDPARTY/lx-music-desktop/](THIRDPARTY/lx-music-desktop/NOTICE.LICENSE)（Apache-2.0）。

## 构建

```powershell
npm install

# 构建前需放入 AnnieEngine 二进制(由 AnnieEngine 引擎项目构建产出):
#   engine/publish/  → AnnieEngine.exe 及 .NET 运行时
#   engine/tools/    → ffmpeg.exe / ffprobe.exe

npm run dist:setup   # 产出 setupEXE/setup.exe (NSIS x64)
```

开发运行：`npm start`（同样需要 engine/ 二进制）。

## 许可证与免责

- 本项目整体：**GPL-3.0-only**（随安妮播放器）
- 洛雪组件：**Apache-2.0**，已保留原始许可声明
- 音源解析能力仅供学习交流，请遵守各音乐平台服务条款；第三方音源脚本由其作者负责，与本项目无关
