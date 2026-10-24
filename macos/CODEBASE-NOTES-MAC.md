# 安妮播放器 macOS 版 · 代码事实库

> 每条带来源 `文件:行号`，✅已验证 / 🔍待验证。
> 阅改代码时顺手更新。踩坑教训当日写回。

## 一、架构事实

### App 外壳

- ✅ **入口在 `src/App.swift`**（`AppDelegate.applicationDidFinishLaunching`）。启动顺序：菜单栏图标 → 创建 webView → 启动服务。`src/App.swift:388`
- ✅ **JS ↔ Swift 桥在 `src/Bridge.swift`**，方法名清单在 `Bridge.allMethods`（327 个），注入脚本模板在 `injectJS`。`src/Bridge.swift:160`
- ✅ **注入模板会自动为每个 `on*` 方法生成 `__emit_<name>` 通道**。Swift 推送事件给前端必须用 `window.mine.__emit_onXxx(payload)`，不要自己造 `window.__xxxEmit`（会被覆盖）。`src/Bridge.swift:147`
- ✅ **LocalServer 是单例**（`init` 私有），用 `LocalServer.shared`，端口在 `start(rootDir:)` 后才有值。`src/LocalServer.swift:14`

### 音频

- ✅ **AudioEngine 用 AVPlayer**，起播 `play(path:)`，暂停/恢复用 `resume`/`pause`。`src/AudioEngine.swift:111`
- ⚠️ **`engine('status')` 的 `path` 字段会残留上次播放路径，但 `duration=0` 表示引擎里没有真正加载音频**。判断「能否 resume」必须看 `duration > 0`，不能看 `path`。
- ✅ **LRMeter 用独立 AVAssetReader 并行解码**，`AVAssetReader` **不支持远程 URL**，必须先下载到本地缓存文件。`src/LRMeter.swift:200`
- ✅ **SpectrumAnalyzer 的频段数必须是 192**（前端 `viz.js` 的 `SPEC_BANDS = 192`），帧率 8 帧/秒（`hopSec = 0.125`）。改错会导致频谱乱码。`src/SpectrumAnalyzer.swift:60`
- ✅ 波形必须是 **1600 点、归一化 0..1 的正数**（前端 `renderWaveFull` 用 `wf[i] * (H-6)` 画对称柱）。

### 窗口 / 桌面歌词

- ⚠️ **桌面歌词窗口必须是 `NSPanel(styleMask: [.borderless, .nonactivatingPanel])`**，否则点击会激活 App → 主窗口被带到最前。
- ⚠️ **`canBecomeKey = false` 会破坏 nonactivatingPanel 机制** —— macOS 对「不能成为 key 的窗口」被点击时走 click-through 路径，转成「激活 App」。只能重写 `canBecomeMain = false`。`src/DesktopLyrics.swift:18`
- ✅ **WKWebView 被点击会抢第一响应者并请求激活 App**，需要子类重写 `becomeFirstResponder() -> false`。`src/DesktopLyrics.swift:10`
- ⚠️ **`-webkit-app-region: drag` 是 Electron 特性，WKWebView 完全不认**。窗口拖动必须用原生 `NSWindow.performDrag(with:)`。`src/DesktopLyrics.swift:12`
- ⚠️ **透明 WKWebView 里的 CSS `:hover` 状态会残留**（鼠标移开后仍认为悬停），不能用来控制显示/隐藏，必须用 JS 类名 + 原生轮询。`web/desktop-lyrics.html:32`
- ✅ **锁定状态下的解锁按钮必须是独立小窗口**（22×22 NSPanel），因为主窗口锁定后完全穿透，同一个窗口无法既穿透又可点。`src/DesktopLyrics.swift:180`
- ⚠️ **解锁按钮不能用 NSButton** —— 标准点击流程会激活 App，要用自定义 NSView + mouseDown。`src/DesktopLyrics.swift:24`

### 键盘 / 焦点

- ✅ **窗口创建 / WKWebView 创建必须在主线程**。Bridge 后台线程调过来要用 `await MainActor.run {}`，**不能用 `DispatchQueue.main.sync`**（Bridge 可能正等主线程回包 → 死锁）。

## 二、踩坑教训（血泪）

### 1. 批量文案替换改坏变量名

❌ **事故**：用脚本把 `SMTC` 全局替换成 `Now Playing`，结果把变量名 `annieSMTC` 改成 `annieNow Playing`（带空格）→ **整个前端白屏**。

✅ **教训**：批量替换必须：
1. 先 `grep` 确认所有出现位置，区分「字符串文案」和「标识符」
2. 替换后**立即跑 `node --check`** 检查所有 JS 文件
3. 只替换带引号的字符串，用正则 `(['"])...SMTC...\1`

### 2. 前端字段名与 Swift 不匹配

❌ **事故**：前端 `dlyricsCtl({lock: true})`，Swift 只认 `opts["locked"]` → 手动点锁完全无效，但我的自动测试用 `locked` 所以一直"通过"。

✅ **教训**：**测试必须走用户的真实路径**。自动测试直接调 Swift API 会绕过前端逻辑。

### 3. 侧栏卡在图标条

❌ **事故**：窗口拖窄时侧栏宽度被存成 85px，窗口放大后不恢复 → 侧栏只剩图标。

✅ **修复**：`am-dom.js` 里加保护——窗口 >1100px 但侧栏 <120px 视为异常，重置 240px。

### 4. 曲目缺 dir 字段导致 FB2K 列表空白

❌ **事故**：`LibraryStore.addTrack` 没存 `dir`，前端 `tagOf()` 里 `t.dir.split()` 抛 TypeError → 整个列表渲染中断。

✅ **修复**：入库时存 `dir`；`librarySnapshot()` 返回时兜底补齐；前端 `tagOf()` 也从 `path` 兜底。

### 5. Release latest 指针

⚠️ **Windows 线踩过**：任何新发的**正式** Release 都会抢走 `releases/latest` 指针，导致 Windows 用户自动更新报「Cannot find latest.yml」。

✅ **硬规则**：macOS 的 Release 一律 `prerelease: true`，不要改。

## 三、前端关键文件

| 文件 | 职责 | 注意 |
|---|---|---|
| `web/index.html` | 主页面 + 事件桥 | 52 个 script 块，改动后必须验语法 |
| `web/js/local/am-dom.js` | AM 主题 DOM | 侧栏宽度保护在这里 |
| `web/js/local/am-render.js` | AM 渲染 | LR 电平、迷你模式、纯净模式 |
| `web/js/local/am-lyrics.js` | 歌词 | 纯净模式歌词 |
| `web/js/local/viz.js` | 波形/频谱/电平 | `SPEC_BANDS=192` |
| `web/js/local/fb2k.js` | FB2K 主题 | 曲目列表 virtual scroll |
| `web/js/local/theme.js` | 主题切换 | `switchTheme` / 选择菜单 |
| `web/js/local/streaming.js` | 在线音乐 | 5 平台标签 |
| `web/desktop-lyrics.html` | 桌面歌词页面 | 透明窗，禁用 :hover |
| `web/lx-sources/xinghai.js` | 洛雪音源脚本 | 启动时自动加载 |

## 四、构建

```bash
# 编译（warning 可忽略，无 error 即可）
swiftc -O -parse-as-library -target arm64-apple-macosx15.0 -o /tmp/annie src/*.swift

# 打包 DMG
./build-dmg.sh 1.0.0
```

⚠️ **`build-dmg.sh` 会从 `安妮播放器.app` 模板复制**，`Info.plist` 里的版本号需要单独改（脚本会自动确保 `CFBundleIconFile`）。
