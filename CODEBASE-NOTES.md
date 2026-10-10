# 安妮播放器 · 代码知识库（CODEBASE-NOTES.md）

> 面向所有接入本项目的 AI 编码助手：阅览代码过程中摸清的结构、功能、接口契约、数据流统一沉淀在这里，实时更新。
> 目的：**提速、不重复扒代码**。新会话/新 agent 动手前先扫一眼本文件，能省掉大量重复阅读。
> 与 AGENTS.md 分工：AGENTS.md 管「规范与流程」（怎么开发/发版），本文件管「代码事实」（某功能在哪、数据长啥样、怎么调）。
> 格式约定：每条注明来源 `文件:行号`，行号会变但结构稳定；标注 ✅已验证 / 🔍待验证。发现过时内容请直接改，别堆叠。

## 〇、全局架构事实

- 三主题：AM（`am-*.js` + `am.css`，主力）、粒子舞台（`player.js` 主体 + app.css）、仿FB2K（`fb2k.js` + `fb2k.css`）。
- **主题独立原则**（用户 2026-10-04 明确）：UI/交互层完全独立（各自音量滑条/快捷键层/布局，互不依赖对方 DOM），但全局状态/设置共享统一（音量值、曲库、引擎、听歌统计跨主题一致）。共享核心是全局 `state` + `window.mine` IPC。
- 主题切换由 `theme.js` 驱动，设 `html[data-theme]`。官方标注 FB2K/粒子舞台「半停止开发」，切过去弹确认框。
- 快捷键隔离：`player.js:1471` 的 window keydown 在 `data-theme==='fb2k'` 时 return 让位；FB2K 快捷键层 `fb2k.js:1519` 自判 `annieTheme.current==='fb2k'`。双向隔离防双击/双seek。

### 主题「世界化」切换机制（V4.4，用户拍板「截然不同」体验）
- **切换流程**（theme.js doSwitch）：快照播放现场 → 渐出停止播放 → 全屏过渡动画 → 激活新主题 → 顶部出「⏵ 续播」手动恢复条。
- **过渡屏** `#theme-splash`（index.html 常驻，复用启动屏 `.bs-logo/.bs-name/.bs-status` 样式，CSS 在 index.html 内联 21-46）。文案阶段：「正在离开 {旧主题}…」→「正在进入 {新主题}…」。最短展示 900ms（logo 动画一轮）+ 淡出 500ms。`data-motion="off"` 时跳过动画。
- **停止播放**：仅在 `state.playing` 时做音量渐出（700ms，14 步 × 50ms，渐出引擎增益不动主音量推子）再 `engine stop`；暂停中直接 stop。停前调 `annieListenStats.endSession()` 定性当前会话（按 80%/1/3 阈值归 完整/部分/跳过，**非一律 skip**）。
- **停止但可恢复**：`takeSnapshot()` 仅在 `state.playing` 时快照（path/stream/position/queue/index/title/artist），存 theme.js 模块内 `snapshot`。新界面顶部 `#theme-resume` 提示条（手动）：点「⏵ 续播」→ 本地 `playAt(index)`+seek 断点 / 流媒体 `streamSongUrl` 重取 URL（URL 有时效）再 `annieStreamPlay`+seek。点 ✕ 或续播后清快照。
- **关键依赖**：流媒体续播需完整 song（songmid/hash 等平台字段），故 streaming.js:421 调 `annieStreamPlay` 时**必须带 `song: song`**（V4.4 补；am-stream.js:83 本就有）。`state.currentStream = track`（player.js:1061）保留整个 track。

### 架构决策：「彻底冻结」而非「物理卸载重建」（V4.4）
- 用户要求「同时只运行一个界面」。**结论：用「彻底冻结」实现，不做物理卸载重建**。
- 理由：三主题共享全局 `state`、全局监听（AM 的 resize/theme-changed/local-media-updated 在 am-render.js:878-912、FB2K 的 keydown/pointerdown 在 fb2k.js bindGlobal）**模块加载即绑、永久在线**，且 AM 的 `mount()` 用 `S.mounted` 守卫（首次构建后 DOM 常驻，后续只刷新）、wrapGlobal/origRCV 是一次性包装。物理卸载需重写三模块生命周期 + 拆包装，风险极高、收益存疑。
- 「冻结」如何实现「只有一个界面在跑」：切走的主题 DOM 经 `data-theme` + aria-hidden 隐藏不渲染；渲染循环/频谱/歌词 tick 都有 `annieTheme.current` 守卫（如 fb2k.js specLoop:1267 非 fb2k 主题不排帧、player.js:1050 `__legacyThemeHidden` 跳粒子重负载）自动停摆。DOM 休眠仅占几 MB 内存，换来切换瞬时、状态连续、架构稳定。

## 一、FB2K 主题（fb2k.js 单 IIFE + fb2k.css）

### 结构
- 根容器 `index.html:289` `#fb2k-root`（默认 display:none），样式 `index.html:70` 引 `css/fb2k.css`，脚本 `index.html:327` 引 `js/local/fb2k.js`。
- fb2k.css:7-22：`html[data-theme="fb2k"]` 下 `#fb2k-root` 变 flex + `position:fixed;inset:0;z-index:40` 覆盖旧界面，同时 `!important` 隐藏 `#layout/#viz-bar/#bottom-bar/#level-dock/#tool-banner/#titlebar`。
- DOM 全 JS 动态构建（无 HTML 模板），入口 `build()` fb2k.js:126。布局：标题栏 → 菜单栏 → 三栏 Grid（`--f2-left/--f2-right` CSS 变量控列宽）→ EQ 抽屉 → 底部控制栏。
- 偏好存 localStorage `annieplayer.fb2k.*`（fb2k.js:13-42，封装 LS.get/set）。

### 音量（V4.4 已独立化）
- `volGain/setVolumeUI` fb2k.js:1400-1415：读写共享 `state.library.volume`（权威源）+ `mine.engine('volume.set',{gain})` + `annieStage.setVolume` + `mine.saveSettings({volume})`。**不再依赖隐藏 `#volume` DOM**（历史遗留已修）。gain 线性 0–1。
- 粒子舞台侧 `#volume` oninput 在 player.js:1385-1390；启动恢复 `state.library.volume` player.js:1509。

### 播放控制
- 传输：`transportPlayPause/fb2kQueueIndex/transportNext/transportPrev/updateTransport` fb2k.js。V4.4 已接流媒体：`state.currentStream` 时走 `fb2kStreamIndex/streamNextFb2k`（按 songKeyOf 身份定位，联动 anniePlayMode + 睡眠定时 repeatN/queue，与 AM nextStream 同语义）；非 FB2K 发起的流交还 `annieStream.playNext/playPrev`。
- 进度：`tickProgress/bindSlider`，悬停时间预览 + seekPending 保护；统一 seek 入口 `seekTo(sec)`（CUE 偏移换算 + seekPending）。
- 数据源 `baseTracks()`：fav/smart:/album:/artist:/folder:/pl:/spl: 过滤。V4.4 新增 spl: 分支——在线歌单 items 映射**虚拟曲目**（见下）。

### V4.4 流媒体接入（第二层已完成）✅
- **虚拟曲目适配**：`splTrack(it, idx)`（fb2k.js 顶部）把 `{provider, song, addedAt}` 映射为 `{__stream: song, __splIdx, path: 'stream://provider/<平台ID>', name, dir: '☁ 平台名', mtime: 0}`——借用本地列表全管线（选中/排序/虚拟滚动按 path 键控零改动）；`__splIdx` 记 items 原索引供 `splRemove`。
- **判“播放中”**：`isCurStream(song)` 按 `songKeyOf`（provider+平台ID）比对 `state.currentStream.song`——currentPath 是真实 URL ≠ 伪路径，绝不能直接等值比较。
- **播放**：`playFb2kStreamAt(i, list)`：`streamSongUrl` 现解析 → `annieStreamPlay`（带 `song` 原对象）→ 确认后 `streamLyric` 写 `__annieStreamLrcByPath[currentPath]` + 广播 `annie-stream-lyric`；缺封面 `streamGetPic` 补齐。队列快照钉 `S.streamQueue`（歌单编辑不影响进行中队列，对齐 AM `_playList`）。
- **自然结束接管**：模块尾部 IIFE 链式包装 `annieStream.playNext`（`__fb2kPatched` 幂等标记），仅 FB2K 主题 + 流来自 FB2K 队列时接管，否则交还原链（AM 的 `__amPatched` 包装在后加载，两级包装按主题各自拦截，互不冲突）。
- **歌词**：`loadLyrics` http 分支读 `__annieStreamLrcByPath/__annieStreamTlyByPath`（译文拼进原文，parseLrc 同时间戳并轨 tly）；监听 `annie-stream-lyric` 重载。
- **本地化适配点**：`fb2kTagOf`（__stream 直取 song.artist/album，全局 tagOf 会按文件名猜）、`durOf/durationText`（song.duration 是**毫秒**）、封面 `setStreamCover`（http 走 `streamCoverProxy` 转 dataURL，CSP 要求）、打分列流媒体留空、listWorker 跳过 __stream、`state.queue` 不入虚拟曲目。
- **右栏/属性**：`displayTrack` 播放流时用 currentStream 拼虚拟曲目；`updateRight`/`showProps` 各有 __stream 分支。
- **树**：在线歌单分组（默认展开，折叠态存 `S.treeExpanded '__spl:closed'`），节点 key `spl:<id>`；右键新建/重命名/删除/导出 .anniespl/导入，全走主进程 RPC 返回值覆盖 `S.spl` + `S.splVer++`（排序缓存键含 splVer）。`initSpl()` 在 mount 调用。
- 音质：`S.stQuality` LS `annieplayer.fb2k.stQuality` 默认 'flac'（FB2K 无音质切换 UI，降级由主进程 downgraded 兜底）。

### V4.4 歌单体系统一到主进程 ✅
- FB2K 歌单从 localStorage 迁到主进程 library.json playlists（与 AM 同一份）：`initPlaylists()` 读 `mine.playlists()` + 一次性迁移（幂等键 `annieplayer.fb2k.playlists.migrated`，同名合并补缺曲目，完成后清旧 LS）。新建/重命名/删除/加歌全走 IPC（返回最新 playlists 直接覆盖 `S.playlists`）；`savePlaylists()` 已退化为 no-op（仅 `S.plVer++` 刷排序缓存）。
- 树歌单节点拖拽排序 `attachPlSort`：Pointer 400ms 长按模式（与 AM `attachPlDragSort` 同款，非 HTML5 Drag）——pointerdown 计时 → 长按进入拖拽（setPointerCapture + .pl-drag-src）→ elementFromPoint 找 `.f2-node[data-plid]` 落点（上半 .pl-drop-before/下半 .pl-drop-after）→ 松手重排 ids 调 `playlistReorderList` → 重渲树。`_suppressClick` 抑制拖拽后误 click。样式在 fb2k.css `.f2-node.pl-drag-src/.pl-drop-before/.pl-drop-after`（inset box-shadow 指示线）。
- 本地歌单导出/导入 .anniepl：`exportPlaylistFile/importPlaylistFiles`（含未匹配清单回报，与 AM 同一 RPC）。

### 列表/树
- 左栏树 `rebuildTree`：默认列表/喜爱/智能列表（依赖 `window.anniePro`）/自建歌单（可拖拽排序）/在线歌单分组/媒体库艺术家·专辑两级/递归文件夹树。V4.4 已合并双搜索框为单一实时过滤框（150ms 防抖 onFilter）。
- 中央列表：列定义 COLS（封面/状态/#/标题/艺术家/等级/时间/修改日期 8 列写死，列宽不可拖——第三层待办）；虚拟滚动 renderVisible（±8 行）；>1000 首走 listWorker Web Worker rebuildRows。
- 选中 rowSelect（Ctrl/Shift 多选，存 path Set）；懒加载元数据 lazyLoadVisibleMeta（IPC metaFullBatch 每次 40 条）。

### 右键菜单
- V4.4 已改主题内共享弹层：`ensureCtxPop/closeCtxPop` 单一 `.f2-ctx` 节点 + document pointerdown 捕获阶段只注册一次（**不能复用 AM 的 R.pop**——R.pop 挂在隐藏的 AM 容器内且样式是 am-pop 体系；FB2K 已冻结时 R.pop 不可见）。菜单项 `'-'` 字符串渲染为分隔线（.f2-ctx-sep）。
- 行右键 rowCtxMenu：本地曲目（播放/喜爱/加到歌单/属性/标签/匹配/电台…）与流媒体曲目（播放/加到在线歌单/从本歌单移除）两分支。

### 歌词
- 已实现逐字卡拉OK + 译文轨 tly + 歌词偏移：karaParseMark/karaExtractWords/karaPaintLine/parseLrc/loadLyrics/karaOn/renderLyrics/tickLyrics。
- V4.4 流媒体歌词已接入（见上「流媒体接入」）。歌词行点击 seek：renderLyrics 行绑 click → `seekTo(l.t)`。

### 频谱
- 右栏 64px 高 36 柱 FFT canvas `#f2-spec`（fb2k.css:181-182）。数据来自离线分析管线缓存帧 `mine.onAnalyzeEvent`（非实时引擎帧）。V4.4 已做 DPR 适配（fb2k.js:1270-1277，cv.width=W*dpr + setTransform）。峰值缓降 0.86。

### 其他
- 版本号 V4.4 已动态化：`mine.appVersion()`（fb2k.js:133-139 标题栏、255-258 关于弹窗，存 S.appVer）。preload 暴露 `appVersion()` → `app:getVersion`。
- Now Playing 图标 V4.4 已补 SVG.screen（fb2k.js:60 定义、389 使用）。
- 暗色模式 `setDarkMode` fb2k.js:1573-1585 + `#fb2k-root.f2-dark` 全套覆盖（fb2k.css:269-393，自称 WCAG AA）。对外 `window.annieFb2kDark`。
- 对外接口 `window.annieFb2k = {mount, refresh, specWanted, isDark, setDark}` fb2k.js:1651-1661；定位 `window.annieFb2kLocate`。

### V4.4 第三层视觉收敛（已完成）✅
- **token 集中**：`#fb2k-root` 定义 `--f2-accent/--f2-fs/--f2-fs-sm/--f2-fs-lg/--f2-row-h/--f2-node-h`（fb2k.css 顶部）。`--f2-accent: var(--accent, #4a90c2)`——`--accent` 由 settings.js applyAccent 注入 documentElement，default 时属性不存在 → 回落经典蓝。**FB2K 无需 settings.js 额外注入，继承即得**；强调色文案已改为三主题生效。
- **派生色 pattern**：`background: 纯色兜底; background: color-mix(in srgb, var(--f2-accent) X%, 基底)` 两行写法——color-mix 不支持时自动回落。sel 20%、hover 9-12%、playing 72%（亮）/42%（暗）、active 按钮 22-30%。
- **已砍出戏元素**：彩虹进度条（亮暗统一 accent 纯色）、绿色分组行（accent 文字 + accent 边线）、绿色主播放钮（accent + hover brightness(.9)）。歌词当前行/逐字扫过/模态标题/EQ 全接 accent。
- **播放行**：accent 派生底色 + `box-shadow: inset 3px 0 0 rgba(255,255,255,.55)` 左指示条。
- **transition**：行/树节点/工具钮/视图钮/窗口钮 `background .12s ease`。
- **列宽可拖**：fb2k.js `colWidth(c)`（S.colW 覆盖，LS `annieplayer.fb2k.colW`）+ `attachColResize`（表头右缘 7px `.f2-col-resize` 热区，pointer capture；拖中 `applyColWidthLive` 只改表头+可见行 width 不重建 DOM，松手才持久化 + buildCols/renderVisible；`_suppressSort` 防误触发排序；28-320px 钳制）。trackNode/buildCols 均经 colWidth 取宽。
- **窗口按钮**：Unicode「— □ ×」改内联 SVG（11px stroke currentColor，`.f2-winbtns button` 已 flex 居中）。
- **已知遗留（未做，非缺陷）**：树节点缩进三套并存（.f2-node.child 26px / 文件夹树内联 6+depth*14 / 媒体库 20/34px）；歌词区 max-height:180px 与频谱 64px 固定；无 @media 流式尺寸（桌面应用窗口足够大，优先级低）。

## 二、全局共享接口（window.mine，preload.js）

- 音量/引擎：`mine.engine(cmd, params, timeout?)` JSON-RPC 调 C# 引擎。常用 cmd：`volume.set{gain}` / `play{path,offsetSec,loudGain}` / `pause` / `resume` / `stop` / `seek{seconds}` / `crossfade.set{seconds}` / `gapless.set{on}` / `devices.list` / `loud.set{gain}`。
- 设置：`mine.saveSettings(patch)`（patch 式，preload.js:81）。**无 getSettings**——读设置靠 `state.library`（曲库加载时带入，如 `state.library.volume`）或 settings.js 内部 `ui`。
- 版本：`mine.appVersion()` → `app:getVersion`。
- 元数据：`mine.metaFullBatch(paths[])` → 返回 `out[path] = {title/artist/album/duration/cover/...}`，cover 是 dataURL（library.js getCachedCover）。每次约 40 条批量。
- 本地歌单：`mine.playlists()` / `mine.playlistReorderList(ids[])`（V4.3.26 侧栏拖拽排序）等。
- 在线歌单（V4.3.26 导出导入）：`splList/splCreate/splRename/splDelete/splAdd/splRemove`（preload.js:56-61）、`splExportFile/splImportFile`（.anniespl）。

## 三、流媒体（在线音乐）— ✅数据契约已摸清（2026-10-04）

### 数据结构
- **在线歌单** `splList()` → `[{id, name, items:[{song, addedAt}]}]`（main.js:1038 `spl:list` 返回 `loadStore().streamPlaylists`；AM 消费处 am-stream.js:146 `currentSpl().items.map(x=>x.song)`）。
- **单首 song 对象**：`{name, artist, album, cover, duration, provider, songmid/hash/id/rid/...}`。注意：`duration` 单位是**毫秒**（播放时 `/1000`，am-stream.js:82）；`name` 不是 `title`；`cover` 可能是 URL 也可能空；`provider` 是平台键（kw/tx/wy/kg/mg/qobuz 等，PLATFORMS 映射表查中文名）；平台 ID 字段因 provider 而异（洛雪音源脚本要 hash/songmid 等原始字段，故传整个 song 对象）。
- 封面兜底：`song.cover` 为空时 `mine.streamGetPic({provider, song})` 异步补齐（streaming.js:384-394）。

### 播放
- **统一播放入口 `window.annieStreamPlay(track)`**（player.js:1059）。track 参数：`{url, headers, title, artist, album, cover, duration(秒), provider, quality, onPlayed}`。内部：`state.currentPath=track.url`（⚠️ currentPath 就是流媒体 URL，不是 stream:// 也不是本地路径）、`state.currentStream=track`、`state.index=-1`（不占本地队列索引）、`state.position=0`，然后走 crossfade/gapless 调 `enginePlayRecover(method,{path:url,offsetSec:0,headers})`。返回 `false` 表示引擎未接受流地址（错误细节在 `window.__annieLastStreamError`）。
- **取播放地址**：先 `mine.streamSongUrl({provider, quality, song})` → `{playable, url, headers, quality, format, downgraded, level, requestedType, message}`（streaming.js:355）。URL 有时效，现取现播。
- **上下曲**：`window.annieStream.playNext() / playPrev(positionSec)`（streaming.js:430-458）。队列是 `streamState.results`（streaming.js 模块内）+ `streamState.index`；自然结束由 player.js 调 `annieStream.playNext()`。⚠️ 这套是 streaming.js 的搜索页队列；AM 在线歌单（spl:）有自己一套（nextStream/prevStream 在 am-stream.js，队列存 `state._playList`）。
- **播放中状态**：`state.currentStream` 为真即流媒体播放中；`state.currentPath`=URL；切歌清除 seek 保护、取消本地切歌合并（streaming.js:332-334）。

### 歌词/封面缓存
- 歌词：`mine.streamLyric({provider, song})` → `{lrc, tlyric}`（tlyric 译文轨，wy/tx/kg 源自带）。缓存按 `state.currentPath`（即 URL）键控：`window.__annieStreamLrcByPath[path]=lrc`、`__annieStreamTlyByPath[path]=tlyric`（streaming.js:400-406），并广播 `annie-stream-lyric` CustomEvent。
- FB2K 接歌词：`loadLyrics`（fb2k.js:1171 对 http 直接 return）改为先查 `__annieStreamLrcByPath[state.currentPath]`，命中即用；未命中监听 `annie-stream-lyric` 事件补。

### 平台/音质
- `PLATFORMS` 映射表（provider 键→中文名）在 am-stream.js / streaming.js 顶部。音质 `S.stQuality` / `currentQuality()`。
- 下载管理 dlManager：见 AGENTS.md 规范第 7 条。

> FB2K 接流媒体要点：数据源用 `splList()` 的 items.map(x=>x.song)；播放/上下曲走 AM 在线歌单那套（需读 am-stream.js 的 nextStream/prevStream/playStreamSong 确认 `state._playList` 结构）；歌词查 `__annieStreamLrcByPath`；歌曲行渲染要适配 song 结构（无 .path/.dir/.ext/.meta，用 song.name/artist/album/duration(ms)/cover）——与本地 track 结构差异大，是改造核心。

## 五、粒子舞台（legacy 主题）— ✅已全面审查（2026-10-08）

### V4.4 重构实施记录（持续更新）
- **第一层已完成**：① 舞台彻底休眠（11-main-loop 尾部 hibernateStageForTheme/wakeStageFromTheme，切走 setSize(4,4)+renderLists.dispose+主循环/心跳链全停，requestMainLoopAnimationFrame/scheduleNextMainLoopFrame 加 hidden 守卫；refreshMainRendererViewport 休眠期跳过（theme-wake 除外）；ResizeObserver 加守卫；adapter interpTicker 加 interpRunning 全停/切回复启）。② playTrack 冻结期门控（stage-adapter：pendingVisualMeta/pendingLyricText{text,tly}/pendingCoverSrc 挂起，annie-theme-changed 切回补做；applyTrackVisuals=封面+本地歌词+节拍）。③ 节拍落盘缓存（main.js beatCache:get/set → userData/beat-cache.json LRU300 写防抖 800ms；preload beatCacheGet/Set；adapter applyStageBeatMap 先读缓存命中走 applyBeatMapCacheForCurrent，分析后落盘）。④ ui.beatAnalysis 开关（settings.js 粒子调节区 checkRow，默认 true）。⑤ GL contextrestored 冻结期不 reload，标 __annieStageNeedsReload 切回补 reload。
- **歌词译文轨已接通（p5）**：applyLyricText(text, token, tlyText)；本地走 splitMergedTranslations 同时间戳拆分（tagWriter 把 tlyric 拼进同一 .lrc 的合并格式——此前舞台译文被当普通行重复显示，已修）；流媒体三调用点（streaming.js:397/am-stream.js:96/fb2k.js:1325）均传 ly.tlyric；渲染消费 line.translation（attachLyricTranslations 挂接，14-stage-lyrics-rendering 读取）。
- **第二层列表交互已做（p6）**：msSel=Set<path>+msAnchor（Ctrl 切换/Shift 范围选不播放，单击保持即播）；buildTrackRow 加时长列（metaCache[p].duration 秒）+ escHtml 转义；右键菜单 #lv-pop/#lv-pop-sub（挂 body 共享弹层，FB2K 模式：播放/收藏批量/加到歌单▸二级列主进程 playlists/在文件夹中显示 mine.showItemInFolder→shell:showItem）；scrollPlayingIntoView 切歌自动跟随（playAt 末尾 setTimeout 120ms，已可见不打扰，hidden 守卫）。
- **硬伤修复+死代码（p7）**：innerHTML 转义 5 处（renderFolders/renderFlatFolders/renderFolderGrid×2/setFormatChips）；.tb-ver 写死 1.2.0 → boot 动态 mine.appVersion()；#btn-npf/#btn-mini 内联 onclick → boot addEventListener（注意方法名是 toggleNpf 不是 toggleNowPlaying）；**renderFolderTree 全删**（#folder-tree 自 V1.1.0 不存在，函数+9 调用点+state.treeExpanded+.tree-node CSS 全清）；登录弹窗 CSS 删（.modal 通用类保留——settings.js:984 链详情在用）；#drop-indicator 死样式删。
- **暂缓项**：modules 深层死代码（11-system-memory-controls/buildPresetGrid/播客 DJ/在线歌词抓取链，约 1500 行）——共享作用域符号引用需逐一 grep，留给专门一轮；proUi 无主题守卫的 keydown/fpsLoop/.tb-ver 监听空转（影响小）。
- **第三层美学重做已完成（p8）**：
  - **SVG 图标体系**：player.js 顶层 `ICONS` + `ico(name,size)`（24 viewBox/stroke 1.8/currentColor；顶层 const 跨经典脚本共享全局词法作用域，playmode/pro/streaming 直接用）。index.html 静态按钮走 `data-ico` 占位 + boot 填充（`insertAdjacentHTML('afterbegin')` 保留已有文字）。动态：btn-play play/pause swap、btn-fav-cur heart/heartFill、btn-mode 五模式（playmode.js id→modeXxx 键映射）、行内 fav、folder/folderOpen、pro.js 特殊行（fire/clock/sparkles/disc/mic）、s-dl download。Unicode 图标全退役（含 🖵 豆腐块）。
  - **viz.js**：fitCanvas() DPR 适配（三画布 level/wave/spec）；vizAccent()/vizAccentRgba() 读 `--accent`（1s 缓存），电平渐变缓存键加 accent。
  - **app.css 末尾「V4.4 美学重做」分区**（同优先级后写胜出）：分段控件 side-tabs/viz-tab、胶囊搜索框+focus 光晕、曲目行圆角+inset 3px 播放指示条（border-left 已弃）、底栏/按钮 hover accent 淡染、侧栏手柄 8px。
  - **侧栏宽度统一**：CSS clamp(240,24vw,420px) ↔ JS sidebarMaxW=min(420, 30vw)。
  - ⚠️ 教训：SearchReplace 用「注释首行」做 old_str 会吞掉 `/*` 导致语法错——锚点必须含完整行。



### 架构关键事实
- **player.js 不是主题文件，是三主题共享播放核心**（1534 行，无 IIFE 全顶层）：state/playAt/annieStreamPlay/tagOf/annieNextByMode/引擎事件总线/快捷键层全在这，只是兼职渲染 legacy 列表。**重构禁忌**：playAt（streaming.js:237、playmode.js、proUi.js:50、theme.js:113 调用）、tagOf（fb2k.js）、window.state（全项目）、annieStreamPlay（streaming/theme/AM）、proToast 均不可破坏。
- **隐藏 DOM id 依赖（AM/FB2K 下 display:none 但仍被读写，重构必须保留或提供替代）**：`#btn-play/#btn-next/#btn-prev`（proUi.js:469-471 托盘直接 .click()）、`#volume`（proUi.js:472-476 托盘音量、player.js:1517 启动同步、theme.js:53 渐出）、`#thumb-title/#thumb-artist`（ambient.js:53-55、reportPlayerState 读窗口标题源）、`#tb-backend`。
- **快捷键特例**：player.js:1474 仅排除 fb2k——**AM 刻意共用这套快捷键**（Space/方向键），收进 legacy 专属会让 AM 失声。
- 冻结机制：theme.js:127 设 `__legacyThemeHidden`；主循环只降 4fps 心跳不停止（11-main-loop.js:184,302），GPU buffer 不收缩（深休眠路径依赖 `window.desktopWindow` 桥，Annie 不存在 → 永不可达，08-desktop-render-power.js:15,123-132）。

### 3D 舞台（js/modules，43 分片）
- 加载：stage-loader.js:6-79 **同步 XHR ×43 + 拼接注入**（带 cache-bust），共享全局作用域，无 import/export。
- 对外接口 `window.annieStage`（stage-adapter.js:340-431）：playTrack/setPaused/stop/setVolume/setParticlesEnabled/setLyricText/setCover；切歌 token++ 防竞态。
- 纹理/几何体管理整体健康：封面三纹理常驻单例只换 image（15-ripples:569-592）；歌词 mesh 有完整 dispose 体系（03-lyrics-star-river:148-200）。
- ~~最大功能缺口：3D 舞台译文~~ ✅已修复（V4.4）：streaming tlyric 传入 + 本地合并行拆分（stage-adapter.js setLyrics isolated 模式）。
- ~~节拍磁盘缓存是桩~~ ✅已修复（V4.4）：beat-cache.json（LRU 300，主进程 beatCacheRead/Write IPC）；playTrack 冻结期门控已加（__legacyThemeHidden + pendingPlayTrackInfo）；设置中心有「节拍律动分析」开关。
- GL 上下文恢复 = location.reload()（00-renderer-quality:193-196），已改为仅舞台可见时 reload。
- ~~死代码清单~~ ✅已清理（V4.4）：renderFolderTree 全链、登录弹窗 CSS、drop-indicator 已删；Unicode 图标已 SVG 化（player.js 顶层 ICONS）；innerHTML 已转义；版本号已动态化；viz.js 已 DPR+accent 化；侧栏宽度钳制已统一（420px）。

### UI/交互层短板（对照 AM/FB2K）
- 曲目列表：无多选/无右键菜单/无拖拽/无列信息（行只显示文件名+完整目录，player.js:596）；单击即播无选中中间态；定位仅手动 #btn-locate，切歌不自动跟随。有虚拟滚动（606-665）不落后。
- Unicode 图标遍地：标题栏 ⚙—□×（index.html:107-110）、传输条 ⏮▶⏭⏹♡→◎📊🔊🎧🖵🗕（271-293，🖵 U+1F5B5 很多字体无字形出豆腐块）；版本号 .tb-ver 写死 1.2.0（index.html:103，无任何 JS 更新）。
- innerHTML 未转义：renderFolders/buildTrackRow/renderFolderGrid/setFormatChips（player.js:78,596,404,1293）——theme.js:84 有 escapeHtml 可复用。
- viz.js（底部波形/频谱/电平）：**颜色全硬编码金色系**（viz.js:141,149-151,224,230,295）换 palette 不变色；**无 DPR 适配**（cv.width=clientWidth，viz.js:139,202,359）高分屏发虚。ambient.js 是正面样板（读 --accent + DPR 适配）。
- 布局矛盾：侧栏宽度 CSS clamp 上限 380px（app.css:637）vs JS 钳 30vw（player.js:807-810）；#viz-bar 固定 118px 不可拖高；#folder-list max-height 84px。
- 内联 onclick：#btn-npf/#btn-mini（index.html:292-293）；`#device-pop` 外点关闭/proUi 全局 keydown/fpsLoop/.tb-ver 监听均无主题守卫（切走后空转）。

## 四、AM 主题关键桥（供跨主题参考）

- 分片桥 `window.__annieAMInternal`（双下划线！），跨分片共享经 `var AM = window.__annieAMInternal || (window.__annieAMInternal = {})`；前向引用用转发桩。
- 右键/弹层一律用全局共享弹层 `R.pop`（外点关闭在应用初始化已注册）；`AM.buildPopSubMenu` 是二级浮层工具（V4.3.26 歌单>8 收敛）。
- 听歌统计 `listenStats.js`：record/listenStats.endSession()，设置中心独立分页 pgStats（settings.js:2249-2459）。

### 设置中心主题专属页（V4.4）
- PAGES 新增 `ui-am`/`ui-fb2k`，`visual` 改名「粒子舞台」；构建点在 settings.js 歌词页块之后（sAmI/sAmLyr/sF2）。
- **AM 顶栏置底**：ui.amTopbarBottom → applyInterface 给 #am-root 加 `.am-topbar-bottom`，am.css 用 order:99 把 .am-topbar 移底（vizbar order:98 贴其上）。
- **AM 沉浸真全屏**（V4.4）：ui.amImmFullscreen → `window.mine.winFullScreen(v)` → 主进程 `win:fullscreen`（setFullScreen，重复调用幂等守卫）。挂在 am-render.js `toggleImmersive` 进出点；所有沉浸出口（⤡/迷你互斥/切主题）都汇聚该函数，不会残留全屏。
- **AM 沉浸样式双模式**（V4.4）：ui.amImmMode = classic|vinyl。am-render.js `buildImmersive` 按 `immMode()` 分支布局（classic 原样；vinyl = 左大歌词常驻 + 右旋转彩胶 + 底部全宽功能栏），传输/进度控件抽成 `buildImmControls`/`buildImmProg` 两模式共用（R.immPlay 等引用不变）。彩胶取色 `paintVinyl()` 在 syncAuxViews 切歌点调 `amVizColor.analyze` 注入 `--vinyl-c1/--vinyl-c2`（黑白封面回落 --am-accent）；旋转纯 CSS `amVinylSpin`，暂停停转靠 refreshAuxProgress 里 `am-vinyl-paused` 类。设置里切换经 `AM.refreshImmMode()` 原地重建（不退出沉浸）。
- **彩胶外观自定义**（V4.4）：沉浸 closebar 💿 → `R.vinylSetPop`（am-render.js buildVinylSetPop，沿用 lyrSetPop 独立弹层模式，外点关闭在 am-dom.js 统一注册）。存 localStorage `annieplayer.am.vinyl.*`：cover 50–90 / scale 0.55–1.6 / op 0.25–1 / speed 4–60 秒/圈 / pos center|corner / hole / **tex 自定义盘面图**。`applyVinylStyle()` 写 CSS 变量 `--am-vinyl-cover/scale/op/speed` + `am-pos-corner`/`am-vinyl-nohole` 类。纹路随机化：`_vinylGrooves` 缓存随机刻纹（宽度幂分布 0.2–2.1%、明暗纹混排——亮纹=封面色 26–54%、暗纹=纯黑压纹 .10–.34、12% 哑光圈），`VINYL_GROOVE_START=22` 固定半径起铺（**不从封面边缘起——封面调大会把纹路挤出盘面**），`paintVinylTexture()` 生成 radial-gradient 内联 backgroundImage。自定义盘面（tex）：`pickVinylTexture()` 智能裁切（smartCropSquare：四角采样背景色→内容包围盒居中取方内缩 2%，去唱片照片白/黑边；失败回落中心方形）640px JPEG dataURL 存 LS，历史 8 张 `texHist`（缩略图条点选切回/hover ✕ 删），paintVinylTexture 有 tex 时改铺 `sheen + 压暗层(吃 op 滑杆) + url(cover)`，圆形靠盘体 border-radius 遮罩，图随盘转。（~~流沙液体盘面 face=liquid~~：用户判定效果不佳，已整体移除，相关 canvas/引擎代码删净。）
- **彩胶表把联动**（V4.4）：附加旋转走独立 CSS `rotate` 属性（与底盘匀速动画的 transform 天然叠加，互不干扰）。`bindProgDrag` 第四参 hooks `{onPreview(秒), onSeek(从,到)}`（am.js，其它进度条不传则空转）；`vinylCrownPreview` 拖动跟手转（6°/scrub 秒，暂停也生效），`vinylCrownSeek` 松手甩碟（120°+8°/跳秒，上限 540°，cubic-bezier .55s 到位后整圈归一防回卷）。歌词行点跳经 `AM.vinylCrownSeek` 桥接也甩碟（am-lyrics.js buildLyrLineEl onclick）。
- ⚠️ **沉浸歌词更新链路的判据是 `S.immLyrOn`**（💬 开关）——彩胶模式歌词常驻但 immLyrOn=false，曾导致歌词不跟随/不高亮。现统一走 am-lyrics.js `immLyrActive()`（immLyrOn || AM.immIsVinyl()），改沉浸歌词相关代码时注意。
- **播放时自动在线补歌词**（V4.4）：am-lyrics.js `loadLyrics` 本地分支无歌词时 `tryAutoLyric(path)` → IPC `match:autoLyric` → onlineMatch.js `autoLyric`（复用 searchCandidates 五平台打分，≥80% 取最高分 → streaming.lyric 取词 + cover 补显 URL）。仅回显不落盘；会话级缓存 `_autoLrc`（'pending'/null 负缓存/{lrc,tlyric,cover}）；CUE/ISO 分轨跳过（state.currentCue/currentIso 守卫，整文件歌词会张冠李戴）。开关 LS `annieplayer.lrc.autofetch`（'0' 关，默认开），设置 → 歌词 → 在线匹配分区。封面补显走 `AM.autoCoverFill`（am-render.js，已有封面不抢）。
- AM 歌词三件套（am.lyrscale/lyrlh/lyrwordlimit）从歌词页迁入 AM 界面页。
- **FB2K 暗色 LS 是 JSON（true/false），与 settings lsCheckRow 的 '1'/'0' 不兼容**——FB2K 页暗色开关是自定义行（JSON 读写 + annieFb2k.setDark + annie-f2-dark-changed 回同步）。

### 拖文件入歌单 + 打开文件位置（V4.4）✅
- 「📂 打开文件位置」复用粒子舞台已有 IPC `window.mine.showItemInFolder`（`shell:showItem`）：AM 在 openAddMenu（am-dom.js，本地行右键/⊕ 菜单全视图生效）、FB2K 在 rowCtxMenu 本地分支（「在文件夹中显示」）。
- 拖外部文件入歌单：am-dom.js `plDroppedPaths`/`addDroppedToPlaylist`（getPathForFile + 扩展名白名单含 cue；playlistAdd 主进程按 path 去重，toast 报实际新增数）。落点两处：① 侧栏歌单 nav 按钮（HTML5 drag，`plDropHasFiles` 判 `Files` 类型——内部行长按排序用 Pointer 事件、行排序拖拽无 Files 类型，互不干扰）；② 歌单视图容器 R.content（`_plDropBound` 标记只挂一次，行内 reorder drop 冒泡到容器同样生效）。高亮样式 `.am-nav.am-nav-drop`（am.css）。
- **落点插入位**（用户反馈修）：`lib:playlist:add` 第三参 `before`（目标行 path，插到该行之前；无则追加底部）；歌单视图 drop 经 `e.target.closest('tr.am-tr').dataset.path` 取落点行（窗口化垫片行无 .am-tr → 落空白=底部），dragover 时落点行加 `.am-tr.drag-over` outline 高亮（dragleave 离开容器/drop 时清除，`c._plDropRow` 跟踪）。
- **非曲库 path 占位曲目**（用户反馈修）：AM `currentTracks` / fb2k `baseTracks` 的 pl: 分支对不在曲库的 pl.paths 合成 `{path,name,dir}` stub 照常渲染/播放（标签 ensureMeta 按 path 现读）——否则「从曲库删除」过的文件再拖进歌单会加进了却看不见。
- ⚠️ **右键删除的两种语义**：`tracksHide`/`lib:deleteFiles` 会把 path 从**所有歌单+收藏**同步剔除（曲库级删除）；歌单视图右键另有「✕ 从本播放列表移除」（`playlistRemove` 只动当前歌单，openAddMenu 内按 `S.view` 是否 pl: 条件渲染）。用户曾用曲库级删除删歌单1的歌把歌单2也删了——歌单视图里默认应引导用前者。

### 流媒体播放缓存（V4.4）🔍
- 主进程 `streamCache.js`：按 `provider + songId + quality` 建键，URL 只用于本次播放/下载（有时效签名，不能做缓存键）；默认缓存目录 `%APPDATA%/安妮播放器融合版V3/streamCache`，索引 `stream-cache.json`，library store 保存 `streamCache.enabled/maxMB/dir`。
- 播放路径集中在 renderer `player.js` 的 `annieStreamPlay`：命中缓存则 engine 播本地文件；未命中先正常播网络 URL，同时 IPC 后台整流保存，失败不影响播放。仅国内洛雪五平台载荷带 `song` 时缓存，Qobuz 当前不参与。
- `streamCache` IPC：lookup/fill/stats/setCfg/pickDir/clear。上限 128MB–50GB，设置 UI 暴露 512MB–20GB；超限 LRU 清理，缓存目录可自定义。待真实播放验证 Electron `net.fetch` Response body → 文件流、各平台 songId/quality 键稳定性及引擎本地缓存格式兼容性后改 ✅。
- 选择集统一存 `S.msSel`（Set<path>，**存 path 不存索引**）；复选框模式 `S.msOn` 仍保留（右键「☑ 多选」进入），两者共用工具条——`renderTrackTable` 里 `S.msOn || S.msSel.size` 即渲染 `renderMsToolbar`。
- 行点击逻辑在 `buildTrackRow`：非 msOn 模式单击走 `rowSelClick`（Ctrl/Meta 切换、Shift 从 `S._selAnchor` 连选后替换、普通单击清空选择并记锚点；播放仍双击）；msOn 模式修饰键同样走 rowSelClick，普通点击=勾选切换。
- 框选：R.content 一次性挂 mousedown（`_marqueeBound`），只在表格视图（songs/favorites/albums详情/pl:）+ 空白处启动（排除 `tr.am-tr/thead/.am-view-head/.am-ms-bar/button/input/a` 及滚动条），6px 位移阈值防抢单击；选框 `.am-marquee`（fixed+pointer-events:none，client 坐标）；松手按 `getBoundingClientRect` 相交命中**已渲染行**（窗口化下垫片区命不中——已知限制），Ctrl=追加否则替换。
- 换视图清快速选择（`S._msView` 跟踪，msOn 模式维持原跨视图存活行为）；歌单视图工具条批量操作=「从歌单移除选中」（复用 `playlistReorder` 整组替换 paths，不碰曲库），其他视图=「删除选中」走 deleteTracks。
- **openAddMenu 多选感知**：`selPaths = msSel.size>1 && msSel.has(trackPath) ? 整组 : 单曲`——加入歌单/新建歌单/从本歌单移除/从曲库删除/编辑标签全部按 selPaths 批量（fb2k 侧早有 forEachSel 对等机制）；菜单头部显示「已选 N 首」。工具条也有「📥 加入播放列表…」按钮（openAddMenu 以选中首项为锚打开）。

---

## 五、全局 bug 审计（2026-10-08 四路并行审计 + 人工复核；2026-10-09 修复 18 条）

### ✅ 已修复（2026-10-09，修复要点）
**主进程**
1. 防息屏失效（SVLX 分支无调用）→ main.js SVLX 分支补 `startAwakeBlock()`。
2. Qobuz 下载目录不落盘 → setDlDir 补 `touchStore()`。
3. loudness.js resolveFfmpeg 补仓库根候选路径（三候选对齐 analyzer/tagWriter）。
4. flushStore 写失败丢脏标记 → catch 里恢复 `_storeDirty=true` + console.error。

**播放核心**
5. cancelStreamSwitch 死代码（IIFE 局部未导出）→ streaming.js 新增 cancelStreamPlayback（取消合并定时器 + `streamState.gen++` 代际令牌），导出 `window.annieStream.cancelSwitch`；playStreamAt 两处守卫加 gen 校验（顺带修「URL 在途时点本地被劫持」）。
6. CUE 分轨到界越界漏音 + 绕过播放模式 → 交 `annieAutoNext()`，队尾显式 engine stop，记 endSession。
7. player.js 全局快捷键排除 TEXTAREA/contenteditable/isComposing（歌单重命名不再被劫）。

**FB2K / AM**
8. AM 搜索/专辑搜索切平台卡死 → stale return 前复位 stSearching/abSearching。
9. FB2K 在线歌单滚动时长列清空 → lazyLoadVisibleMeta 跳过 `stream://` 伪路径 + refreshVisibleRowMeta 对伪路径 return。
10. FB2K 歌单变更不刷新 → rebuildTree 顶部算歌单签名（id+数量+首尾path），变则 plVer++ 且在歌单视图时 rebuildRows。
11. FB2K 标题写死 V3 → 用 S.appVer。
12. initPlaylists 迁移吞错+并发重入 → 加 plMigrating 锁；任一步失败不标 migrated 不清 legacy（可重试）。
13. AM 侧栏切歌抽搐（用户回报）→ 病根 wrapGlobal 连带 renderSidebar 全量重建；首曲封面按 `歌单id|首曲path` 缓存（S.plCoverCache）同步渲染，无封面记 '' 防重复 IPC。
14. AM 歌单拖拽「拖不动」（用户回报）→ 400ms 长按+8px 早移取消在桌面鼠标下必被误取消（隔离环境合成事件验证逻辑本身可用）；AM/FB2K 统一改**位移阈值拖拽**（移动 >6px 即拖，无位移=点击）。
15. 沉浸模式未开歌词不居中（用户回报）→ am.css 未开歌词时 .am-imm-main 改单列。

**设置/统计**
16. closeBehavior 被抹 → buildPanel 不回写显示值进 ui；hydrate 显式恢复 saved.closeBehavior。
17. listenStats tick 清空/跨年 TypeError → years[yk] 存在性防护。
18. theme.js 暂停切主题丢断点 → takeSnapshot 暂停中也可快照（自然播完除外）；续播条曲名取 metaCache。FB2K accent 默认经典蓝 → fb2k.css `html[data-theme="fb2k"]{--accent:#4a90c2}`（特异性压 :root，用户自选内联仍优先）。

### ✅ 已修复（2026-10-09 第二轮，用户回报）
19. AM 侧栏「在线歌单」小封面不出 → am-dom.js 扫描「第一首有封面的曲目」（不再只看 items[0]）+ http 图走代理（AM.setStreamImg，am-stream 导出的 setAlbumCover 加 onFail 还原占位 emoji）；「收藏的歌单」收藏时存 f.img（am-stream.js 收藏按钮，详情接口 r.info.img / 广场卡片兜底），loadSongListDetail 顺带自愈旧收藏封面；歌单详情头部大图同机制。
20. 在线歌单首次播放「定位乱跳」→ 双根因：①封面取回后整表 renderView 无滚动恢复（scrollTop 钳回 0）→ 改原位更新该行 img（findStreamRowBySong 定位），首曲时补头部大图；②playStreamAt 的 smooth 滚动被 restoreScrollAround 瞬时恢复掐断半路 → am-render 500ms 轮询在 refresh 后对 stream/spl 视图补 AM.scrollStreamRowIntoView(true) 终点校正。
21. 在线歌单头「▶播放/🔀随机播放」按钮文字竖排（用户回报）→ 搜索框原是 head 第三个 flex 子项把按钮区挤窄；改挂 .am-pl-info 列内；CSS 补 .am-pl-info{flex:1}、.am-btn 全局 white-space:nowrap+flex:none。

### ✅ 已修复/新功能（2026-10-09 第三轮）
22. ✅新功能·全局自定义壁纸（用户反馈：三界面都要能导入壁纸）：新模块 wallpaper.js（IndexedDB annie-wallpaper-v1 存图片 Blob，blob: URL 在 CSP img-src 白名单内，零主进程/零 CSP 改动；LS annieplayer.wallpaper={on,blur,dim}）；应用=CSS 变量 --wp-img/--wp-blur/--wp-dim 挂 <html> + html.wp-on 类；AM 覆盖 #am-root::before、粒子舞台覆盖 body::before（白昼变体需 html.wp-on[data-palette="day"] 双倍特异性）并关极光层、FB2K 新增 ::before 壁纸层 + 面板半透明化（亮/暗两套，根透明需 html.wp-on[data-theme="fb2k"] 压 data-theme 白底）。设置中心三个主题页（粒子舞台/AM/FB2K）各挂同一 buildWallpaperSection（annie-wp-changed 事件互同步），选图/清除/开关 + 模糊(0-90px)/压暗(0-85%) 滑杆。AM 沉浸模式默认不受壁纸影响（仍随封面）；cfg.imm 开关（设置页「沉浸模式也使用壁纸」）→ html.wp-imm 类，am.css 用 html.wp-on.wp-imm 组合覆盖 .am-imm-bg（含 am-nobg opacity 豁免）。壁纸历史：单图槽改多图——IDB key=wp<ts>，LS 存 hist[]（上限 12 逐最旧）+ cur 指针；旧版单图槽 key 'wp' 自动迁移；设置页缩略图条点按 use(id) 切回、hover ✕ remove(id)，「清除」=删当前张并停用（历史保留）。
23. AM 迷你模式回主界面歌曲列表空白（用户回报「切歌或等一下就好」）→ 窗口化渲染在 .am-body display:none 期间被轮询/切歌触发，clientHeight=0 算出「顶部几行+巨大垫片」假窗口，恢复后视口落在垫片上=空白。双修：renderAmWindow 隐藏中标脏不渲染（am-dom.js:1302 guard）+ exitMini 双帧强制重开窗口（am-render.js:494-500，rAF+300ms 覆盖 OS 窗口还原时序）。

24. ✅新功能·沉浸模式歌词外观入口（用户反馈）：toggleLyrSetPop 支持任意锚点（pop._anchor 判定，同锚点再点收起/换锚点改挂），沉浸右上角 closebar 加 ⚙（R.immBtnLyrSet，am-render.js buildImmersive），与主面板 ⚙ 共用同一弹层；外点关闭白名单补 immBtnLyrSet（am-dom.js:319）。

### 🔍 待验证（暂未修，下轮候选）
- 【功能储备】SMTC ↔ Wallpaper Engine 联动（用户 2026-10-09 提出，先记下来慢慢做）：mediaSession.js 已走 Chromium Media Session → Windows SMTC（曲名/封面/进度/控制，不占音频管线，独占/ASIO 下 WE 也能读到）；待实测：①无 <audio> 发声（C# 引擎出声）时 Chromium 是否真的激活 SMTC（不激活则主进程 WinRT 原生注册兜底）②封面 dataURL 建议压 256×256（WE 官方建议）。WE 频谱类壁纸靠 loopback 抓 PCM，独占下物理无解（FB2K 同），要做得引擎旁路 PCM 给虚拟声卡。
- 扫描竞态：watchScanPending 与手动扫描互截（main.js:458-497/601-635）；scanWorker cancelled 单标志互踩（scanWorker.js:16,30,120）。
- app:relaunch 走 app.exit(0)：不触发 before-quit → flushStore/引擎退出等待全跳过，AnnieEngine.exe 孤儿残留（main.js:1500）。
- 流媒体跨主题续播接管链断档（三层补丁放行落到陈旧 streamState）。
- theme.js 续播流媒体未传 onPlayed → 无歌词/不预取下一首（streaming.js:381 注入全靠它）。
- 下载扩展名回退可产非法路径（streaming/index.js:151,161）；引擎崩溃自愈对流媒体用过期 URL 重播（player.js:1380-1393）。
- 非原子写四处：beat-cache.json / dl-tasks.json / stream-settings.json / stream-sources.json。
- 设置 setPalette/update 不调 applyPalette/applyAccent（settings.js:2883-2890，命令面板入口）；主题切换 switching 锁依赖 mount 不抛异常（theme.js:143-175）。
- ~~FB2K 右键菜单无歌单收敛~~ ✅已修：ctxSubMenu 二级浮层（fb2k.js:1456 ctxMenu 支持 {sub,items} 项；本地/流媒体歌单 >8 收敛，子面板挂菜单项内部 fixed 定位 + 翻左避让）；拖拽缺 pointercancel（fb2k.js:1933+/am.js:401+/player.js:1496+）仍待验证。
- qobuz 读取类端点不校验 HTTP status → token 过期自动重登可能不生效（qobuz/api.js:218-231）。

---

## 六、AnnieFlyout 伴侣进程（已于 V4.3.29 整体移除）

- **移除原因**：用户群普遍用不了（任务栏嵌入对系统环境敏感），功能整体下线。
- **移除清单**：`annie/main/flyout.js`、`flyout/` 目录（WPF 源码）删除；main.js IPC `flyout:get/set/push` 与启动联动删除；preload `flyoutGet/flyoutSet/flyoutPush/onFlyoutCmd` 删除；mediaSession.js 回退为纯 Chromium Media Session 单通道（doSeek 保留给 seekto）；settings.js 常规页「任务栏小组件」分区删除；package.json extraResources 的 flyout 项与 copyright 的 FluentFlyout 声明删除；release.yml 删 .NET 10 SDK 与 AnnieFlyout 编译步骤；.gitignore flyout 条目清理。
- **遗留**：老用户机器上 %AppData%\AnnieFlyout 配置目录与 store.ui.flyout 键残留无害；历史版本（V4.3.27–4.3.28）的安装包仍含 AnnieFlyout，属历史事实。

---

> **维护提醒**：每次阅览代码发现新事实，顺手追加到对应分区；分区不够用就新加。「🔍待验证」项落实后改「✅」并补行号。本文件随仓库走 git，别提交到杂物目录。
