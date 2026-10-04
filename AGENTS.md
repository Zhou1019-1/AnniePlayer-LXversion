# 安妮播放器 · AI 协作规范（AGENTS.md）

> 本文档面向任何接入本项目的大模型/AI 编码助手。读完本文件即可按项目既定规范开发与发版。
> 项目名：章鱼科技：安妮播放器（Annie Player，融合版）。仓库：Zhou1019-1/AnniePlayer-LXversion。

## 一、项目架构速览

- **桌面应用**：Electron。主进程 `annie/main/`，渲染层 `annie/renderer/`，两者经 `window.mine` 桥（`annie/main/preload.js`）通信。
- **音频引擎**：自研 C# 引擎 AnnieEngine（`engine/`），主进程经 `engine.call('xxx', params)` 调用。首次 `devices.list` 需约 20s（WASAPI 枚举），启动时后台预热。
- **AM 主题**：渲染层核心，拆分为多个分片文件（`am.js` / `am-dom.js` / `am-render.js` / `am-stream.js` / `am-lyrics.js` 等）。
- **library.json 结构**：`{folders, tracks, favorites, playlists, metaCache, stats}`。

## 二、开发规范（硬规则）

### 1. AM 分片模块桥
- 跨分片共享变量/函数一律经 **`window.__annieAMInternal`（双下划线）** 桥接：`var AM = window.__annieAMInternal || (window.__annieAMInternal = {});`
- 前向引用（后加载分片的函数）用转发桩：`function renderView() { return AM.renderView.apply(this, arguments); }`
- **教训**：曾把桥名误写成单下划线 `window.annieAMInternal`，导致整个模块静默失效、视图空白，且无任何报错。改桥名后必须验证视图渲染。

### 2. 右键菜单 / 弹层
- **一律复用全局共享弹层 `R.pop`**（外点关闭机制在应用初始化时已注册，成熟可靠）。
- **禁止自建弹层 + 自挂 document/window 外点关闭监听**——事件会被截胡，菜单卡死在屏幕上（已踩两轮）。

### 3. CSS 注意
- `.am-lyrics` 有 `overflow:hidden`（折叠动画需要），**负 `left` 的子元素会被裁掉**——折叠按钮等贴边元素必须挂到 `.am-body` 上定位。
- 拖拽落点高亮用 `.am-tr.drag-over`（outline），拖拽句柄 `cursor: grab/grabbing`。
- 迷你模式下隐藏全局折叠标签类元素。

### 4. 二进制处理
- 用 `execFile` 读取二进制（封面/音频）时必须显式 `encoding: 'buffer'`，否则被错误解码为 UTF-8 字符串而损坏数据。

### 5. 工具路径解析（tagWriter/analyzer 通用）
- `resolveTool` 必须有**三候选路径**：打包产物路径、开发目录路径、**仓库根 `engine/tools` 路径**。
- **教训**：tagWriter 漏了仓库根候选路径 → dev 环境回退 PATH 找不到 ffmpeg → 下载歌曲无标签无封面且静默失败。涉及 ffmpeg 写标签的改动必须验证 dev 环境真实落盘。

### 6. 歌词/编码
- 旁挂 .lrc 写盘支持 GBK 编码：用 `iconv-lite` 的 `encode(text, 'gbk')`，勿手写。
- 流媒体歌词缓存按 `state.currentPath` 键控：`window.__annieStreamLrcByPath` / `__annieStreamTlyByPath`（译文轨）。

### 7. 下载任务管理（dlManager 模式，对齐洛雪）
- 任务队列 + 并发槽（1-10）+ `AbortController` 实现暂停。**流媒体 URL 有时效，断点续传无意义——"继续"=重新下载**。
- 持久化 `dl-tasks.json`（含 song 快照供重启继续）；重启后 downloading/waiting 一律置 paused。
- 队列去重键：`provider + songId`。
- 进度推送 300ms 节流，事件经 `'dl:event'` 广播。

### 8. 多选与拖拽
- 在线列表多选集合存**歌曲对象引用**（`Set<song>`），不存索引——翻页/追加加载后索引会错位。
- 本地多选集合存 `Set<path>`。
- 播放列表拖拽用 HTML5 Drag API，`dataTransfer.effectAllowed='move'`；按 **path 定位** splice（索引在窗口化渲染、paths 有缺口时会错位）。
- 行内封面 `<img>` 必须 `draggable = false` 防误拖。

### 9. 防息屏
- `powerSaveBlocker.start('prevent-display-sleep')` 在 `app.whenReady()` 时启动（main.js `startAwakeBlock`）。**用户拍板：只要软件开着就保持亮屏，不限于播放中**。进程退出自动释放，无需手动 stop。

### 10. 其他教训
- 修改 `main.js` 返回值时小心误改（曾把 `toggleFavorite` 的 `return favs` 误改为 `return store.playlists`）。改完 diff 复查。
- Electron dev 重启偶发退出：旧进程缓存目录未释放，等其退净重启即自愈，不必排查代码。
- FPL（foobar2000 播放列表）解析器在 `annie/main/fpl.js`；自动识别只扫媒体库文件夹内，fb2k 默认目录（%AppData%）的 .fpl 不会被扫到（引导文案已告知用户"另存为到媒体库文件夹"）。

## 三、发版规范（每次发版必须七步走全，本地+在线同步）

1. **package.json**：升版本号 + 补 `changelog` 条目（应用内「本版新变化」弹窗读取）。
2. **helpContent.js**（`annie/renderer/js/local/`）：补新功能条目 + 版本更新条目（应用内使用说明，共 10 章）。
3. **更新日志.md**：补版本段落（根目录，release workflow 会自动提取该段作 GitHub Release notes）。
4. **`npm run gen:help`**：重生成 README 说明书章节 + `docs/章鱼科技：安妮播放器全功能说明书.md` + `《章鱼科技：安妮播放器全功能说明书》.docx`（pandoc 输出到仓库根）。
5. **`npm run dist:setup`**：打本地安装包（输出 `setupEXE/annie-player-svlx-setup-X.Y.Z.exe`，已签名）。
6. **git commit + push main**：提交标题风格 `V4.3.x 功能点1 + 功能点2`（参考历史 `V4.3.21 一键电台 + 右键菜单 + window.state 挂载潜雷修复`）。只 add 相关文件，勿提交 `PR to Luoxue/`、`QobuzExp/`、`_tmp-*` 等杂物目录。
7. **git tag vX.Y.Z + git push origin vX.Y.Z**：触发 GitHub Actions `release` workflow（`.github/workflows/release.yml`）云端编译引擎、跑测试（冒烟/音频引擎/无损鉴别/沙箱）、自动从更新日志提取 notes、发布 Release。

> **不要**走本地 `scripts/release.js`（gh CLI 方案仅作备用）。标准发版 = tag 推送触发云端 workflow。

## 四、dev 开发调试

- **启动 dev**：`npm start`（即 `electron .`）。代码内判断 dev 环境用 `app.isPackaged === false`（如 `app:checkUpdate` 在 dev 下返回 `{dev:true}` 跳过更新检查）。
- **改动生效方式**：
  - 渲染层（`annie/renderer/` 的 js/css/html）：窗口内 **Ctrl+R 刷新即生效**，无需重启。
  - 主进程（`annie/main/`）、`preload.js`：**必须退出重开**才生效。
  - 涉及 ffmpeg 写标签/工具路径的改动：必须在 dev 环境验证真实落盘（见开发规范第 5 条）。
- **日志排查**：主进程日志（`console.log`、各模块 `[qobuz]` 等前缀日志）看启动终端；渲染层用 DevTools Console。首次 `devices.list` 约 20s 是 WASAPI 枚举正常现象（启动时已后台预热）。
- **用户侧问题排查**：让用户从应用内导出**诊断包**（含版本/日志/音频设备信息），先看诊断包再动手。
- **网络调试**：Qobuz 等网络请求走 Electron `net.fetch` 自动跟随系统代理；dev 下开着 Clash 等代理软件即为真实用户环境，别再切回 Node 原生 fetch。
- **已知良性现象**（不要当 bug 排查）：
  - dev 重启偶发退出：旧进程缓存目录未释放，等其退净重启即自愈。
  - 提交时 `annie/main/qobuz ignored` 警告：历史已追踪文件，修改照常进 commit，忽略即可。
- 改完代码必跑 `node scripts/check-syntax.js`（150+ 文件应 0 失败），再 Ctrl+R / 重启验证。

## 五、常用命令

```bash
node scripts/check-syntax.js   # 全量语法检查（改完代码必跑，150+ 文件应 0 失败）
npm run gen:help               # 说明书三件套
npm run dist:setup             # 本地安装包
```

## 六、用户偏好

- 中文交流，混合英文技术术语（dev、tag、fpl 等）。
- 美术风格与现有 AM 设计保持统一。
- 新功能参考洛雪音乐（lx-music-desktop）实现时，注意"参考功能集，不抄代码"。
