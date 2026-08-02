# LXversion — AnniePlayer SVLX(安妮 × 洛雪 融合版)

> 版本号: **SVLX.1.0**
> 融合架构: **SVLX 启动器 + 安妮播放器(同进程内嵌) + 洛雪音乐(独立子进程)**
> 两个应用的功能均 **100% 保留**,互不改源码式合并,避免功能丢失。

## 架构

```
AnniePlayerSVLX.exe (src/main.js —— 启动器主进程)
├── 启动器窗口 (src/launcher.html)
│     ├── [安妮播放器] → require(annie/main/main.js) 同进程启动
│     └── [洛雪音乐]   → spawn(bundled/lx-music/lx-music.exe) 独立进程
├── 安妮播放器 (annie/)         —— 完整复制自 AnniePlayerPlusProVersion
│     ├── main/    引擎RPC/曲库扫描Worker/流媒体(网易云·QQ)/CUE/响度
│     ├── renderer/ 完整 UI(迷你模式/桌面歌词/命令面板/可视化)
│     └── 依赖 AnnieEngine sidecar (engine/publish)
└── 洛雪音乐 (bundled/lx-music/) —— 从 _lx-source 完整构建的 win-unpacked
      └── 独立 exe:歌单/排行榜/桌面歌词/全局热键/同步/OpenAPI 全保留
```

### 融合补丁(仅打在 LXversion 副本上,原始版本未动)

[annie/main/main.js](annie/main/main.js) 尾部:
- `global.__svlxAnnieOpen`:启动器二次进入时重开安妮窗口(require 缓存不会重跑 whenReady)
- `window-all-closed`:启动器在场时关窗回启动器,而不是退出整个应用

### 借鉴洛雪的桌面外壳模式(src/main.js)

1. **单例锁** `requestSingleInstanceLock` + second-instance 回启动器
2. **Windows 便携模式**:exe 旁存在 `portable/` 目录则用户数据随身
3. **系统托盘**:启动安妮/启动洛雪/打开启动器/退出
4. **关窗即回启动器**,托盘"退出"才真正退出

## 目录

```
LXversion/
├── src/                 启动器(main.js / preload.js / launcher.html / launcher.js)
├── annie/               安妮播放器完整代码(main + renderer + build 图标)
├── engine/              AnnieEngine 运行时(publish) + ffmpeg(tools)
├── bundled/lx-music/    洛雪完整构建产物(构建后生成)
├── THIRDPARTY/          洛雪源码参考模块 + NOTICE.LICENSE (Apache-2.0 声明)
├── _lx-source/          洛雪源码克隆(构建用,不进入安装包)
├── build/               icon.ico / installer.nsh
└── setupEXE/            electron-builder 输出(setup.exe)
```

## 构建

```powershell
cd E:\AnniePlayerTRAE\AnniePlayer-V1-Preview\app\LXversion

# 1. 构建洛雪组件(已完成可跳过)
cd _lx-source; npm install; npm run build
node build-config/build-pack.js target=dir   # 产物复制到 ..\bundled\lx-music\
cd ..

# 2. 安装融合壳依赖并打包
npm install
npm run dist:setup                            # 产出 setupEXE\setup.exe
```

## 许可证

- 整体: **GPL-3.0-only**(随安妮播放器)
- 洛雪组件: **Apache-2.0**,已保留 [THIRDPARTY/lx-music-desktop/NOTICE.LICENSE](THIRDPARTY/lx-music-desktop/NOTICE.LICENSE)
- 注意:洛雪的音源解析能力受其上游免责声明约束,请遵守各音乐平台服务条款。

## 已知事项

- `setup.exe` 未做 Authenticode 代码签名,首次运行会被 SmartScreen 提示"未知发布者",选"仍要运行"即可。
- 版本号 `SVLX.1.0` 为非标准 semver,NSIS 元数据按字面值写入。
- 安装包体积较大(内嵌两套 Electron 运行时),属预期。
