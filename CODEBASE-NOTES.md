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
- **内嵌歌词换行事故（2026-10-15 修复 ✅）**：tagWriter.js 的 `metaValue()`（:27-30）把 `\r\n` 洗成空格，下载嵌入歌词（writeTags :120-121 走该函数）被压成单行 → 渲染层 `parseLrc`（am-lyrics.js:121，按物理行切段、只认行首时间戳）只解析出第一句、无时间轴不滚动。旁挂 .lrc 不受影响（writeLyric 原文直写）。修复：① writeTags 歌词字段改用 `lyricValue()`（:34-37，保换行仅去反引号）——ffmpeg 命令行参数传多行值实测没问题（ffmpeg 7.x 回环验证 PASS）；② `parseLrc` 入口加单行 LRC 归一化：`/([^\r\n\]])(\[\d+:\d+(\.\d+)?\])/g → '$1\n$2'`，在「非 ] 字符后的时间戳」前补换行，存量坏文件无需重下即可恢复滚动；行首连续时间戳 `[t1][t2]同句多时间点` 前字符是 `]` 不匹配，行为不变。注意：PowerShell `node -e "..."` 双引号串里 `$1/$2` 会被 PS 展开吞掉，正则替换测试要写临时脚本文件跑。
- **下载封面错/缺事故三连（2026-10-16 修复 ✅，用户反馈「只有网易云封面错」定位）**：
  - ① **双封面并存（主因，表现为封面错）**：tagWriter.js `writeTags` 用 `-map 0` 全流拷贝，源文件自带的 attached_pic 被原样带出，新封面追加在后 → 文件里两张封面，ffmpeg/music-metadata/播放器都只读第一张（旧的错图）。实测：源文件嵌红图 + 写蓝图 → 2 张、第一张仍红。wy 独有是因为网易 CDN 源文件自带 APIC 封面流（其他平台源文件多不带）。修复：有 coverFile 时加 `-map -0:v` 显式剔除旧封面流（`args.push('-map', '-0:v', ...)`），回归 PASS（写完只剩新图）。
  - ② **kw 下载不嵌封面（表现为封面缺）**：渲染层 streaming.js `updateRowCover` 把 kw 的 http 封面经 coverProxy 转成 dataURL 后回写 `song.cover`，下载链路 writeDownloadedTags 拿到 dataURL 传给 tagWriter.fetchCoverBytes——此前只认 http(s) 直接返回 null → 不嵌封面。修复：fetchCoverBytes 支持 dataURL 直接 base64 解码。
  - ③ **HTML 错误页当封面嵌入**：fetchCoverBytes 此前不校验内容类型，平台风控/重定向返回的 HTML 会被当封面写进文件。修复：加 `isImageBytes` 魔数校验（JPEG/PNG/GIF/WEBP），非图字节一律拒嵌。
  - 回归测试（ffmpeg 真实文件）：双封面修复 ✓ / dataURL 解码 ✓ / HTML 拒绝 ✓ / 无封面纯写标签不受影响 ✓。
- **封面背景丢失 + covercache 无上限（2026-10-16 修复 ✅，秋野奈文档定位）**：Chromium 对 CSS `url()` 有 ~2MB 长度上限（url::kMaxURLChars），封面 `<img src>` 不受影响但背景 `background-image: var(--am-bgimage)` 受影响——「封面能显示、背景丢失」。修复（library.js）：① `readMeta`/`ffprobeCover`/外部封面三处出口统一接 `shrinkCoverIfNeeded`（>500KB → ffmpeg 缩到 640px JPEG q85，实测 2.6MB PNG → 75KB JPEG，缩 97%），下游背景/取色/SMTC/IPC/磁盘缓存全受益；② covercache 加总大小上限 512MB（`COVER_DISK_MAX_BYTES`），启动时全量校正 + 写入时增量估算，超限按 mtime LRU 删到 80%。秋野奈本机数据：10714 首曲库 443 首（17%）封面超限，covercache 13 天涨到 2GB。他建议的 bgThumb（渲染层 canvas 缩 96px）思路正确但主进程缩放更彻底（一处修复全链路）。

### 平台/音质
- `PLATFORMS` 映射表（provider 键→中文名）在 am-stream.js / streaming.js 顶部。音质 `S.stQuality` / `currentQuality()`。
- 下载管理 dlManager：见 AGENTS.md 规范第 7 条。

### Qobuz 链路（V4.4.3 摸清并补全，✅ check-syntax 159 文件 0 失败；dev 真机验证待用户跑）
- **连播**：am-qobuz.js `playTrack(t, album, queue, index)` 建立 `QZ.playQueue[{t,album}]/playIndex`（专辑/歌单/搜索列表整表即队列）；`patchQobuzTransport()` 首次播放时包装 `annieStream.playNext/playPrev` + `AM.nextStream/prevStream`，守卫 `currentStream.provider==='Qobuz' && currentStream.qid===队列当前项 id`（payload 带 `qid`），联动全局播放模式（repeat-one/list-rand 同洛雪语义），播完队列自然停止。历史根因：此前 Qobuz 单曲直连无队列，ended 后三层 playNext 包装守卫全落空。
- **下载 M3（标签/封面/歌词）**：qobuz/download.js `runQueue(..., post)` 后处理钩子（**done 与 skip 都跑**——skip 补历史无标签文件，幂等）；index.js `makePostProcessor(fill)`：歌词（lyricMatch 阈值 80 落盘宁缺毋滥）→ `tagWriter.writeTags`（标题/艺人/专辑/专辑艺术家/曲目号/碟号/日期+封面 coverUrl+嵌入歌词）→ 旁挂 .lrc；fill 计数随 end 事件 → am-qobuz.js 汇总文案 + **歌词未匹配每批一次 proToast**（不逐曲弹）。coverUrl 由渲染层下载项/主进程 resolveToTracks 双向附着。
- **健壮性**：download.js `checkAudioMagic` 落盘前校验 fLaC/ID3 魔数（防 403 错误页存成假 FLAC，noRetry 直接失败）；原有 .part 断点续传 + 3 次指数退避（重试现签新 URL）保留。
- **歌词链**：index.js `lyricMatch(p, minScore)` 模块级函数——**LRCLIB 优先**（extMeta.lrclibGet：/api/get 四参精确 → search 兜底时长 ±3s 采信）→ 落空走 LX 五源打分（播放 60 / 落盘 80）。播放时兜底（fetchLyric，am-qobuz.js）与下载落盘共用。
- **标签字段补全（V4.4.3 第二轮）**：makePostProcessor 增 genre/composer/publisher（Qobuz 专辑级 `genre.name`/`label.name`，曲目级 `composer.name`）；渲染层「下载全部」附着 genre/publisher/releaseDate；resolveToTracks 专辑分支同步附着。UPC/ISRC/版权 tagWriter 无对应字段，未写。
- **网络流切歌爆音修复（V4.4.3，引擎侧）**：`Engine.Playback.cs PlayCrossfade` 在 `mixer.FadeTo` 前对 URL 源补预缓冲（≥0.5s，同 quickStart URL 下限，8s 上限 + gen 代际守卫）。根因：crossfade 路径此前无预缓冲（PrebufferAndStart 只服务普通 Play），新源空缓冲被设备回调立刻消费 → 静音↔波形硬切换 = 碎裂爆音；本地文件即时解码无感，Qobuz 高码率 FLAC 最明显。等待期间旧源继续播放，听感无缝。

### 国际元数据源（V4.4.3，`annie/main/extMeta.js`）✅
- 纯 Node 模块（规范 12 无顶层 electron）；`setHttpFetch` 注入 net.fetch（qobuz/index.js init 里随 qzFetch 一并注入）；UA 带项目标识。
- **LRCLIB**（同步歌词，免 key）：lrclibGet/lrclibSearch/lrclibById；**MusicBrainz**（标签，限速 1 req/s 内置串行队列 `_mbChain`）：mbSearch 归一化 `{name,artist,album,duration(ms),cover(CAA front-250),_mb:{title,artist,album,albumArtist,date,track,disc,duration,releaseId}}`；**CAA** `caaCover(releaseId, size)`。
- **onlineMatch 接入**：searchCandidates 加 `intl` 参数（默认开），国际源与五源同一 Promise.allSettled 并行（境外连不上静默降级），候选上限 15→20；`fetchLyricForCand(cand)` 统一取词（lrclib 按 id / musicbrainz 转 LRCLIB / 五源走 lx-sdk），批量匹配与 autoLyric 同链路自动受益；applyMatch 加 `writeTags`（MB 候选写全套标签，其余三件套）+ `_lrclib/_mb` 回传。渲染层 onlineMatch.js 弹窗加「写入曲目标签」「国际源」两个勾选（默认 关/开），结果文案加「已写入曲目标签」。

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
- **⚠️ 顶栏高度 ↔ 沉浸悬挂栏联动（V4.4.8 踩坑 ✅）**：沉浸右上 `.am-imm-closebar` 与左上 `.am-imm-infobar` 的 `top` 必须 =（`.am-topbar` 高 − `.am-tbtn` 34px）/ 2，使按钮中心与主窗口窗口按钮中心齐平。V4.4.8 PR#10 把顶栏 64→70px（am.css 末尾 `.am-topbar{height:70px}`）却漏改这两栏（仍 top:14），沉浸/彩胶悬挂栏整体偏上 ~4px；现改 top:18 并加注释。以后改顶栏高度三处同改。
- **AM 沉浸真全屏**（V4.4）：ui.amImmFullscreen → `window.mine.winFullScreen(v)` → 主进程 `win:fullscreen`（setFullScreen，重复调用幂等守卫）。挂在 am-render.js `toggleImmersive` 进出点；所有沉浸出口（⤡/迷你互斥/切主题）都汇聚该函数，不会残留全屏。
- **AM 沉浸样式双模式**（V4.4）：ui.amImmMode = classic|vinyl。am-render.js `buildImmersive` 按 `immMode()` 分支布局（classic 原样；vinyl = 左大歌词常驻 + 右旋转彩胶 + 底部全宽功能栏），传输/进度控件抽成 `buildImmControls`/`buildImmProg` 两模式共用（R.immPlay 等引用不变）。彩胶取色 `paintVinyl()` 在 syncAuxViews 切歌点调 `amVizColor.analyze` 注入 `--vinyl-c1/--vinyl-c2`（黑白封面回落 --am-accent）；旋转纯 CSS `amVinylSpin`，暂停停转靠 refreshAuxProgress 里 `am-vinyl-paused` 类。设置里切换经 `AM.refreshImmMode()` 原地重建（不退出沉浸）。
- **封面取色失败永久缓存事故（2026-10-16 修复 ✅）**：am-vizcolor.js `analyze()` 的超时/onerror/canvas 异常都走 `settle(url, null)` 写入会话级缓存——大封面 PNG（1400²，2.6MB dataURL 3.4MB）首次加载若赶上启动卡顿超 8s，整局被缓存成 null 不再重试，频谱条/彩胶双双无封面色，重启才自愈。修复：瞬时失败走 `failTransient()`（delete cache + 回调 null，下次 analyze 重试），仅分析结论 null（黑白封面）仍缓存。同案顺带发现：mediaSession.js 把 3.4MB 封面 dataURL 直塞 SMTC artwork，Chromium 报 "MediaImage src exceeds maximum URL length" 并静默丢弃整个 metadata（标题艺人全丢），现 >512KB 不带图保文字。
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

### 流媒体播放缓存（V4.4）✅（分组/命中标识代码已落，真实播放待验）
- 主进程 `streamCache.js`：按 `provider + songId + quality` 建键，URL 只用于本次播放/下载（有时效签名，不能做缓存键）；默认缓存目录 `%APPDATA%/安妮播放器融合版V3/streamCache`，索引 `stream-cache.json`，library store 保存 `streamCache.enabled/maxMB/dir`。
- 播放路径集中在 renderer `player.js` 的 `annieStreamPlay`：命中缓存则 engine 播本地文件（**命中时同步给入参 track 对象置 `track.cached=true`**，AM 据此亮缓存徽标）；未命中先正常播网络 URL，同时 IPC 后台整流保存，失败不影响播放。仅国内洛雪五平台载荷带 `song` 时缓存，Qobuz 当前不参与。
- `streamCache` IPC：lookup/fill/stats/setCfg/pickDir/clear/**groups**。上限 128MB–50GB，设置 UI 暴露 512MB–20GB；超限 LRU 清理，缓存目录可自定义。
- **V4.4 分组**：fill 写索引条目带 `provider/quality/title/artist`（旧条目无字段，`entryGroup(key,ent)` 兜底——provider 取 key 首段匹配 kg/kw/mg/tx/wy，quality 取尾部匹配 flac24bit/flac/320k/128k，未命中归 other/unknown）；`streamCache:groups` 返回 `[{provider,quality,count,totalMB}]`；`streamCache:clear(filter)` 无参=全清（返回 `{removed}`），带 `{provider}` 和/或 `{quality}`=只删命中组。preload 暴露 `streamCacheGroups()`、`streamCacheClear(filter)`。设置 UI（settings.js 下载 section「播放缓存」）分组卡片 `.set-sc-groups/.set-sc-grow`（app.css）。
- **命中标识（renderer AM）**：`S.cacheHit`（am-stream.js playStreamAt 调 annieStreamPlay 前置 false、成功回调读 `playTrack.cached`）；`AM.refreshCacheBadge()`（am-render.js）切换主 `.am-badge`/沉浸 `.am-imm-fmt`/迷你 `.am-mini-fmt` 的 `am-fmt-cache` 类（CSS：绿字 #33c98f/#4ad295 + 圆点，am.css `.am-badge` 后），refreshTransport 每次联动（切本地 currentStream=null 即灭灯）；命中时状态栏文案「平台 · 音质 · 本地缓存秒开」。
- 选择集统一存 `S.msSel`（Set<path>，**存 path 不存索引**）；复选框模式 `S.msOn` 仍保留（右键「☑ 多选」进入），两者共用工具条——`renderTrackTable` 里 `S.msOn || S.msSel.size` 即渲染 `renderMsToolbar`。
- 行点击逻辑在 `buildTrackRow`：非 msOn 模式单击走 `rowSelClick`（Ctrl/Meta 切换、Shift 从 `S._selAnchor` 连选后替换、普通单击清空选择并记锚点；播放仍双击）；msOn 模式修饰键同样走 rowSelClick，普通点击=勾选切换。
- 框选：R.content 一次性挂 mousedown（`_marqueeBound`），只在表格视图（songs/favorites/albums详情/pl:）+ 空白处启动（排除 `tr.am-tr/thead/.am-view-head/.am-ms-bar/button/input/a` 及滚动条），6px 位移阈值防抢单击；选框 `.am-marquee`（fixed+pointer-events:none，client 坐标）；松手按 `getBoundingClientRect` 相交命中**已渲染行**（窗口化下垫片区命不中——已知限制），Ctrl=追加否则替换。
- 换视图清快速选择（`S._msView` 跟踪，msOn 模式维持原跨视图存活行为）；歌单视图工具条批量操作=「从歌单移除选中」（复用 `playlistReorder` 整组替换 paths，不碰曲库），其他视图=「删除选中」走 deleteTracks。
- **openAddMenu 多选感知**：`selPaths = msSel.size>1 && msSel.has(trackPath) ? 整组 : 单曲`——加入歌单/新建歌单/从本歌单移除/从曲库删除/编辑标签全部按 selPaths 批量（fb2k 侧早有 forEachSel 对等机制）；菜单头部显示「已选 N 首」。工具条也有「📥 加入播放列表…」按钮（openAddMenu 以选中首项为锚打开）。

### 沉浸体验五大块（V4.4 攒更，代码已落待 dev 验）✅ 代码事实
- **① 沉浸增强（am-render.js/am.css）**：静止隐栏后屏幕底部悬浮玻璃 dock（buildImmDock，进度条复用 bindProgDrag 带表把 hooks）；暂停/音量 OSD；经典双栏与彩胶两样式各自记忆面板开合/歌词滚动位置；切歌封面交叉转场。
- **② 彩胶 rAF 惯性物理（am-render.js）**：状态 `_vinylAngle/_vinylOmega/_vinylRAF/_vinylLastT/_vinylSpeedSec/_vinylSeek`；`vinylStep(t)` 做一帧积分（dt 指数逼近目标角速度，起转 tau `VINYL_TAU_SPIN=1.4`s、停转 `VINYL_TAU_STOP=0.85`s），`vinylFrame(t)` 是 rAF 包装（守卫 `R.immVinyl && S.imm`，不满足即不重排=循环自杀），统一 `vinylWriteTransform()` 写 inline transform，停稳挂 `am-vinyl-still`；`vinylSwitch()` 切歌加 900ms `am-vinyl-switch` 类（CSS `@keyframes amVinylSwitch` 换碟明暗闪动）；表把 `vinylCrownSeek(from,to)` easeOutCubic 550ms；CSS 已删旧 `animation:amVinylSpin`，新增 `.am-vinyl::before` 慢速**同向**流光（speed×7 秒，曾用 reverse 反向被用户否决）。生命周期：buildImmersive 彩胶分支末尾 vinylStartSpin，refreshImmMode 重建前 vinylStopSpin。
  - **⚠️ 转速越界坑（V4.4）**：localStorage `annieplayer.am.vinyl.speed` 合法区间 4–60（秒/圈），旧版遗留值（实测 198）会让目标角速度 360/198≈1.82°/s——rAF 完全正常（n 按 60fps 涨）但盘肉眼静止。applyVinylStyle 读取后必须区间校验，越界回落 18 并回写存储。诊断看 ω：稳态应 ≈ 360/spd。
  - **⚠️ 盘体/封面不转的真正根因（V4.4，dt 单位括号错）**：`vinylStep` 里 dt 曾写成 `Math.min(0.05, (t - _vinylLastT)) / 1000`——t 是 rAF 时间戳（**毫秒**），min 括号括错导致 dt 恒 = 0.05/1000 = 0.00005s（比正确的 16.7ms 缩小约 100 倍），角速度每秒只涨 ~0.04°/s、角度 60 秒才转 0.36°（round=0），盘体背景与封面肉眼完全静止，只有 `.am-vinyl::before` 的 CSS `amVinylSheen` 流光在转（视觉假象「盘体在转但封面不转」）。正确写法 `Math.min(0.05, (t - _vinylLastT) / 1000)`。诊断铁证：`ω=1.89` 但 `ang=0`（ω 有值、角度不涨 = dt 被缩放）。排查教训：连读多轮误诊为「rAF 节流」「时间戳倒挂」，均因读不到截图、凭编造诊断值下结论——务必让用户直接贴诊断行文字，且 ω/ang 同看可区分「dt 缩放」（ω≠0 但 ang 不涨）vs「rAF 饿死」（n 不涨）。保留的防御：main.js 4 个 commandLine 开关（防遮挡节流）+ 看门狗 vinylWatchTick + 倒挂保护 `if (_vinylLastT && t <= _vinylLastT) return false;` 均无害可留。
- **③ 歌词（am-lyrics.js/am.css）**：LS 键 `<prefix>dual`（row 上下行 / side 侧行 / src 只原文 / tly 只译文）、`<prefix>lyrpos`（upper/center/lower）；`readLyrProfile/applyLyrStyle` 写 S.lyrDual/lyrPos/immLyrDual/immLyrPos + root 类 `am-m-dual-*`（主含迷你）/`am-i-dual-*`；`buildLyrLineEl(l,i,cls,wordLimit,dual)`；预设（舒适 1.05/1.7/blur1、影院 1.25/1.95/blur0、紧凑 .9/1.3/blur1，**只覆盖字号/行距/虚化**）在 buildLyrSetPop，分段按钮用 `.am-seg`，选中态 class 是 **`on`**（`.am-tbtn.on`，不是 am-tbtn-on）。**自动滚动不亮滚动条**：`progScrollTop(box,v)`（AM.progScrollTop）写 scrollTop 前置 WeakMap 150ms 窗口，autoHideScrollbar 的 scroll 监听命中窗口直接 return（否则逐行跟随会让滚动条竖条常驻；旧实现程序滚动还误写 _lyrManualScrollUntil 导致跟随 5s 一跳）。沉浸歌词背景板（glass/solid）已应用户要求移除。
- **④ 播放体验**：
  - d1 主界面队列抽屉：`R.btnQ/R.btnQBadge`（am-dom.js right 区）；`buildQDrawer(root)/toggleMainQueue(force)/refreshQBadge()`（am-render.js），root 类 `am-q-on`、S.qOn；`.am-q-drawer` absolute top64 right0 width340 z6 磨砂滑入；与沉浸 R.immQ/迷你 R.miniQ 共用 renderQueuePanel（fold 标签条件含 box===R.qDrawer）；500ms 轮询切歌时刷新打开的队列面板；角标=剩余待播（流媒体 list.length-1-stIndex / 本地 queue.length-1-index，99+ 封顶）。
  - d2 进度 hover 气泡：am.js bindProgDrag 创建 `.am-prog-tip` 挂 **bar.parentElement**（进度条本身 overflow:hidden 会裁掉），三处进度条（顶栏/沉浸主栏/dock）共用 CSS；拖动中持续跟手。
  - d3 重启恢复：LS `annieplayer.resume.v1`（meta）+`annieplayer.resume.pos`（{path,pos}）；`writeResumeMeta/writeResumePosThrottled(5s)/resetResumePos/restoreResume`（am-render.js，mount 调、S._resumeDone 守卫）；本地经 state.libIndex 映射 paths→tracks 后 playAt(idx,pos)，流媒体存前 200 首快照恢复 S.stQuality/_playList/stIndex 后 playStreamAt + `_resumeSeek/_resumePause`（首个 position 事件补 seek、引擎起播即 pause）；position/state 事件 + 500ms 轮询 + pagehide + `annie-app-before-quit` 写入；设置 settings.js 默认 amResume:true（AM 界面页开关，关闭 removeItem 两键）。
  - d4 下一首预解析（am-stream.js）：模块级 `_preUrl/_preKey/_preAt/_preLoading/_preAt2`，`PRE_TTL=90000`；`preKeyOf=songKey`，`consumePreload(song)` 命中返回完整 r（url/headers/quality/format/playable/message）；`nextStreamIndex` 复刻 nextStream（repeat-one 跳过预取）；`maybePreloadNext` 守卫：playing+currentStream+时长过半且剩余<75s+全局 4s 节流+同 key 8s 失败重试+慢回调丢弃（list 引用/currentStream.song 不匹配）；触发点在引擎 **position 事件**；playStreamAt 命中预取走 Promise.resolve(preHit) 复用同一 then 链。
- **⑤ 缓存管理**：见上一分区（groups/clear(filter)/缓存徽标）。

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

24. ✅新功能·歌词外观双锚点+双配置（用户反馈迭代）：toggleLyrSetPop 按锚点判 ctx（btn===R.immBtnLyrSet → 'imm'，否则 'main'），每次打开按 ctx 重建弹层（标题「歌词外观 · 主界面/沉浸模式」）；沉浸右上角 closebar ⚙ = R.immBtnLyrSet（am-render.js buildImmersive）；外点关闭白名单补 immBtnLyrSet（am-dom.js:319）。**V4.4 主界面右栏歌词与沉浸歌词外观已拆成两套独立配置**（am-lyrics.js readLyrProfile/applyLyrStyle）：主界面键前缀 `annieplayer.am.`（lyrscale/lyrlh/lyrwordlimit/lyrblur/tlyscale，面板封面 lyrcover 仅主界面），沉浸键前缀 `annieplayer.imm.`（同前五键）；CSS 变量主=--am-lyr-scale/--am-lyr-lh/--am-tly-scale，沉浸=--am-imm-lyr-scale/--am-imm-lyr-lh/--am-imm-tly-scale（.am-imm-lyr 选择器，am.css:690-691）；虚化 class 拆分 am-no-lyrblur（限 .am-lyr-scroll/.am-mini-lyr）与 am-no-imm-lyrblur（限 .am-imm-lyr，am.css:423-426）；每行词数在 buildLyrInto 内按 box===R.immLyrBox 自动选词数（am-render 调用无需传参），迷你跟随主界面；沉浸配置从未设置时 readLyrProfile seed=主界面值（不写盘，调过一次才独立）；设置中心 AM 界面页有两组滑条。

25. ✅沉浸模式静止自动隐藏鼠标（视频式，am-render.js:837-917）：toggleImmersive 进/出时成对 start/stop（监听挂 window：mousemove/mousedown/wheel/touchstart/keydown，passive；另有 documentElement mouseleave→immDockLeave）；静止 2.5s（IMM_CURSOR_IDLE_MS）给 #am-root 加 `am-imm-chrome-off`+`am-imm-cursor-off`（CSS cursor:none!important am.css:623-624；chrome 隐藏 am.css:625-632：closebar 上移淡出/.am-imm-vbar 下移淡出/经典 .am-imm-left 内 prog+ctl 淡出，纯 opacity 不 reflow）；定时触发瞬间若有 `.am-pop.on` 或 S.immQOn 则本轮不藏；**底部 dock 唤出**：静止后 mousemove/mousedown 且 clientY≥innerHeight-104（IMM_DOCK_ZONE_PX）→加 am-imm-dock-on（不恢复其余 chrome）；热区容器 .am-imm-dockzone pointer-events:none 不挡歌词，dock 默认 pointer-events:none 仅 dock-on 可点；state.seeking 期间活动监听直接 return（拖进度条出热区不打断）；dock 内独立一套 cur/fill/bar/remain+三键（bindProgDrag 同 seek 链路+表把钩子），refreshAuxProgress 同步 R.immDock*。**OSD**（am.css:652-667 .am-imm-osd）：播放/暂停与音量变化由 immOsdTick 在 refreshAuxProgress 内检测（_immLastPlaying/_immLastVol，进/出沉浸重置 null 不首弹），R.immVol.oninput 暂停态无 tick 时直接给音量 OSD；showImmOsd 1.1s 后加 am-imm-osd-out 淡出。**封面交叉转场** immCoverCrossfade（syncAuxViews 用，替代 immCover 的 swapCover）：旧 src 克隆 img.am-imm-cov-ghost（CSS 锚点 .am-imm-left position:relative 顶/左/右0+aspect-ratio；彩胶 .am-vinyl-label 内 inset:0）amCovOut 淡出微缩 520ms 移除，新 img am-cov-in 从 blur(10px) scale(1.045) 淡入；无封面/首次走 swapCover。**布局记忆** saveImmLayout/restoreImmLayout（LS annieplayer.imm.layout.classic/.vinyl：lyr/q/sr 滚动比例）：退出沉浸 saveImmLayout、进入恢复（buildLyrInto 之后），refreshImmMode 切样式时按 R.imm 旧 class 先存旧样式再恢复新样式；彩胶 lyr 恒真，有存档时 setImmLyr/setImmQueue 严格同步防跨样式残留。

26. ✅拖入歌单多文件自动排序（用户反馈多选拖入无序；根因=资源管理器 CF_HDROP 多选顺序随机，焦点文件排第一）：排序在主进程内聚——`lib:playlist:add` 新增第 4 参 sort（preload playlistAdd 透传；仅 am-dom.js addDroppedToPlaylist 的两个拖入入口=侧栏歌单名/歌单视图 drop 传 true，右键/批量加入保持用户选择序不排序）；library.js 新增 `orderAudioPaths(paths, cache)`：≥60% 文件有有效曲目号（≥2 首且≥2 个不同号）→ 专辑标签(缺失回落目录)→碟号→曲目号→自然文件名（无号的同组沉底）；否则目录→数字感知自然文件名（localeCompare numeric，track2<track10）；CUE/ISO 虚拟路径（#cue/#iso）不碰文件系统直接自然序；cache[p].track===undefined 视为老缓存需 readMetaBatch 现读，空串=确认无号，读出的 track/disc 回填 metaCache 持久化（二次拖入免读盘）；lib:metaBatch 缓存写入（main.js:1175）也顺带补存 track/disc，扫描/列表渲染会自然填充；排序在去重之后、before 插入之前执行；toast 报「已自动排序」。改了主进程/preload，验证需重启 dev。

27. ✅迷你模式 ✕ 收托盘再打开回主界面（用户反馈：迷你下点 ✕ → 托盘 → 显示窗口，仍是迷你窗）：根因=hide 只藏窗，主进程 miniActive/小 bounds 与渲染层 S.mini（及 proUi 遗留迷你 body.mini 双实现）都没退。修法=main.js:1338 挂 mainWindow 'hide' 监听：miniActive 时先抓当前迷你 bounds（回传做位置记忆），隐藏中 setAlwaysOnTop(false)+setMinimumSize(1120,680)+setBounds(miniSaved)（无闪烁），miniWasMax 的 maximize 延迟到一次性 'show' 监听（隐藏中 maximize 在部分 Windows 不可靠），复位 miniActive/miniSaved/miniWasMax，webContents 发 `mini:hiddenToTray`；渲染层 am-render.js exitMini 拆出 exitMiniUI(miniBounds) 纯 UI 卸载（乐观置 S.mini=false 行为保持），订阅该桥（preload onMiniHiddenToTray）；proUi.js 遗留迷你栏同桥同步拆 body.mini。minimize()（— 按钮）不触发 hide，任务栏恢复仍迷你=预期；关闭对话框选「彻底退出」不 hide 不受影响；托盘菜单"显示主窗口"和托盘 click 都只 show()，自动受益。

28. ✅**V4.4.0 发布事故：本地安装包打进框架依赖引擎，仅装 .NET 10 的用户引擎全崩**（诊断包铁证：info.json `engineAlive:false`、devices.json `{"error":"engine exited"}`、engine-errors 满屏 `You must install or update .NET ... Framework 'Microsoft.NETCore.App', version '9.0.0' ... frameworks found: 10.0.9`、退出码 2147516566=0x80008096 FrameworkMissing，主进程 5 次退避重启 1s/2s/4s/8s 全灭）。根因链：① 云端 release.yml/ci.yml 编译命令是 `dotnet publish engine/src -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o engine/publish`（自包含单文件 ~69MB，不依赖系统 .NET）；② 但本地 `npm run dist:setup` 直接把**仓库里陈旧的 engine/publish**（framework-dependent 散件：AnnieEngine.exe 仅 0.15MB apphost + AnnieEngine.dll 0.16MB + NAudio 散 dll，无 coreclr/hostfxr，runtimeconfig 钉 net9.0 且 rollForward 默认 Minor 不跨主版本）打进 nsis；③ .NET 10 已 GA 的新机器只装 10.0.9 → 拒绝运行 net9 程序（主版本不向前 roll）。修法：清空 engine/publish → 同云端命令重编（自包含单文件目录里只剩 AnnieEngine.exe[+pdb]，无 runtimeconfig.json）→ 重打 setup（179.2MB）；package.json 加 `build:engine` 与 `predist:setup` 钩子，以后 `npm run dist:setup` 自动先编引擎。排障要点：① `dotnet publish` bundle 阶段报 UnauthorizedAccess 删不掉 AnnieEngine.exe = 有引擎进程占用——AnnieEngine 是独立 spawn 子进程（engineClient.js:58），杀 electron 不会带走，要 `Get-Process AnnieEngine|Stop-Process -Force`；② 区分本地包/云端包问题：云端 release 包永远自包含，同类崩溃先问用户安装包来源；③ 用户侧应急=装 .NET 9 Desktop Runtime x64（https://dotnet.microsoft.com/download/dotnet/9.0），根治=换自包含安装包。

29. ✅**「内存/CPU 温度」类诊断包怎么读**（2026-10-12 用户 Eashon 案，V4.4.0 好包 engineAlive:true/无崩溃/渲染层无报错）：① engine-errors 里 `[flac] invalid sync code / decode_frame() failed` 四连且时间戳稳定早于 crossfade 日志 ~4 秒=**良性**：ffmpeg 全速预解码到 EOF（解码队列默认≈4 秒，`Decode.cs:51`），stderr 是 `ReadToEndAsync` 在**进程退出时**才整体刷出（`Decode.cs:85-89`），故打印时刻≈EOF 而非出错时刻；单帧错误=该 FLAC 文件本身坏帧，播放继续。② 用户曲库 44.1k/48k 交替时**每次切歌都 crossfade 失配回退**（`Engine.Playback.cs:408-413`）：StopAll（60ms 淡出+Sleep80，`:644-672`，旧 ffmpeg `Kill(entireProcessTree:true)` 可靠释放无泄漏）→ 重建 WASAPI 流=切歌瞬间尖峰，非持续占用。③ **持续温升结构性因素**：main.js:9-12 四个开关（关 CalculateNativeWinOcclusion + disable-background-timer-throttling + disable-backgrounding-occluded-windows + disable-renderer-backgrounding）+ webPreferences `backgroundThrottling:false`（main.js:325，V4.4 修彩胶遮挡停转引入）→ 窗口被遮挡时 rAF 不节流；AM 频谱 vizLoop 有 `document.hidden` 早退（am-render.js:1705）但**被其他窗口遮挡（非最小化/托盘）仍按 60fps 全画布绘制 32 条**；进度插值 rAF（player.js:1470-1485）连 document.hidden 检查都没有，播放期间永久 60fps（AM 下只做几次浮点运算，成本低）。外接显示器挂独显 HDMI 时 Windows 可能把 Electron 分到 dGPU 合成=整机温升常见诱因，建议让用户在「图形设置」里指定集显对照。④ 已排除：节拍分析在 AM 主题整段挂起（stage-adapter.js playTrack `__legacyThemeHidden` 早退）；引擎频谱仅 10Hz（Engine.Playback.cs TickPosition）；2s 设备轮询纯 ID 枚举毫秒级（Outputs.cs:920-933）；封面内存 LRU 300/磁盘 3000 有界（library.js:122,144）；preload:false 队列≈4s 有界；peq 空带/eq 关近零成本（limiter+autoPreamp 默认开=每采样托管浮点，小）。⑤ 小浪费（非主因）：remote.js:105,141 的 700ms 状态快照/5s 曲库签名**遥控未开启时也无条件在跑**（仅主进程侧空转）。诊断包无进程级数据，此类工单必须让用户补：任务管理器 AnniePlayerSVLX（主/渲染/GPU 分项）、AnnieEngine、ffmpeg 各自内存/CPU + 高占用场景（前台/遮挡/最小化/托盘、播放/暂停）。

30. ✅**框架依赖坏引擎事故第 3 位受害者，出现新错误码变种 0x80008083**（2026-10-12 QQ 群用户「碎」，系统用户 mimi；V4.4.0；归档 DIAG-20261012-0041）：与第 28 条同族但程度更极端——第 1/2 位机器装了 .NET 10 缺 9（0x80008096 FrameworkMissing，模板 "frameworks found: 10.0.9"）；本机**任何 .NET 都没有**，apphost 打印 `You must install .NET / .NET location: Not found / Failed to resolve hostfxr.dll [not found]. Error code: 0x80008083`，退出码 2147516547（=0x80008083 HostApiNotFound）。诊断包读包要点：engineAlive:false + devices.json `{"error":"engine exited"}` + **engine-log.txt 与 engine-crash.log 均空**（apphost 阶段失败，未进 CLR/托管崩溃流程）+ engine-errors.txt 被同一模板刷屏（本案 94 次退出/1037 行，16:40:53~16:41:54 三轮 6 连崩熔断，退避 1/2/4/8s 与 engineClient.js:88-104 完全吻合）。**安装路径不能作为包来源判据**：nsis `allowToChangeInstallationDirectory:true`（package.json build.nsis），用户可自选 E:\音乐 等目录；铁证是 apphost 原文——自包含单文件引擎 bundle 内带 hostfxr/coreclr，物理上不可能打印该模板。终局确认让用户看 `resources\engine\AnnieEngine.exe` 大小：好包≈69MB 单文件；坏包≈0.15MB apphost + AnnieEngine.dll + AnnieEngine.runtimeconfig.json 散件。次生陷阱：① 该用户 settings.json `volume:0`，修好引擎后仍无声，要先拉音量；② trackCount=0，需重新扫库。产品改进候选（未做）：engineClient 识别 0x80008081~0x8000809F apphost 模板后别再静默崩 6 轮，直接弹可操作窗（下载 .NET 9 / 重下完整包）；首启自检引擎文件自包含特征。

31. ✅**坏引擎事故第 4 位受害者（Jeremy，系统用户 Administrator；归档 DIAG-20261012-0008）：0x80008096 经典型 + 崩溃后 exe 被火绒删除（已回访实锤）**。本机已装 **.NET 8.0.29 与 10.0.11 唯独没 9**（模板列出两个 frameworks found，要求 Microsoft.NETCore.App 9.0.0），退出码 2147516566；per-machine 安装在 `C:\Program Files\AnniePlayerSVLX`（现包 nsis perMachine:false，老包或管理员安装可进 Program Files）。知识点：① devices.json 第三种形态 `{"error":"引擎未启动（缺少 AnnieEngine.exe）"}`——来自 engineClient.js:143-146，`call()` 前 `start()` 经 resolveEnginePath()（:11-22）确认文件不存在返回 false（:48-55），RPC 直接 reject、**不 spawn 所以之后零崩溃日志**；含义=导出时引擎 exe 已从 resources\engine 消失。**本案该文件消失经开发者向用户确认是火绒隔离删除**（火绒「安全工具→隔离区」可恢复，信任区加安装目录可防复发）——这是首个实锤案例：**框架依赖坏引擎缺运行时→2.5 分钟 12 次快速崩溃→火绒启发式把 AnnieEngine.exe 隔离**，两层故障叠加；以后遇到"缺少 AnnieEngine.exe"先让用户查杀软隔离区（火绒/360/Defender）。注意白名单只解决文件被删，恢复出的坏引擎仍缺 .NET 9，必须再装 .NET 9 或换自包含完整包。② **同一份 apphost 模板会被拆进 engine-log.txt 和 engine-errors.txt 两个文件**：stderr 数据块在 engineClient.js:64-67 按块做 `/error|exception|fail|异常|错误/i` 正则分流，不含 error 的块（"frameworks were found" 等）落 logRing——在 engine-log 看到 .NET 模板**不代表引擎正常启动过**，判据仍是有没有 `[engine] rpc ready`。③ 该用户 volume=1 无音量坑，但 trackCount=0 需扫库。

32. 🔍**产品路线头脑风暴（2026-10-12，尚未形成实施承诺）**：近期主线聚焦可靠性与用户信任：安装包/引擎产物自检、引擎启动失败分类提示及恢复指引、本地与云端发包验证；用户确认中期并行切片为**播放链路状态**（输出设备/模式/采样率/重采样/DSP 可解释），另备选曲库备份迁移；媒体库批量修复须先定义预览/确认/撤销规则，省电策略需避免全局禁用节流；主题生态与分享同步暂列长期探索。头脑风暴：[产品路线草案.md](产品路线草案.md)；范围与现状盘点：[产品范围与现状盘点.md](产品范围与现状盘点.md)；细化实现计划：[产品实现计划草案.md](产品实现计划草案.md)。用户已同意先做范围定义和现状盘点，并要求按方案细化计划；计划文档已完成，**尚待用户审批后才实施**。

33. ✅**V4.4.1 可靠性 P0 + 播放链路状态 P0（2026-10-12 落地，待真机验证）**：
   ① **引擎产物自包含门禁**：新增 [verify-engine-publish.js](scripts/verify-engine-publish.js)（PE 头有效 + exe ≥10MB + 禁止旁置 AnnieEngine.dll/runtimeconfig.json，拦 0.15MB framework-dependent apphost）与负例测试 [verify-engine-publish-test.js](scripts/verify-engine-publish-test.js)（好/小apphost/旁置/坏PE/缺失 5 例）；`predist:setup` 钩子追加校验，ci.yml/release.yml 都加产物校验+检查器测试，release 打包后对 win-unpacked 再校验一次。
   ② **引擎启动故障分类**：engineClient.js 导出纯函数 `classifyStartupFailure(code,text)`，白名单只认两类——2147516566/0x80008096=`dotnet-runtime-missing`、2147516547/0x80008083=`dotnet-hostfxr-missing`（含官方模板文本兜底）；stderr 改用 StringDecoder 按**合并后全文**分类（不再按 chunk 正则），exit/close/stderr-end 用 `finishOnce` 保证终结一次；每代 spawn 有 generation，首个合法 JSON-RPC 行视为启动成功（广播 `engine-started`）。命中两类 .NET 或 spawn ENOENT/EPERM 即 `_manualRetryRequired=true` **停止自动重启**，广播 `engine-startup-failure {kind,code,message}`，只等用户显式 `engine.retry()`；普通运行期崩溃仍走原 1/2/4/8s ×6 熔断。新增 IPC `engine:retry`（重拉+engine.info 验证）、`engine:status`（=engine.getDiagnostics：路径/存在/大小/存活/startupFailure/熔断计数）；诊断包 info.json 新增 `engine` 字段。测试 [engine-client-test.js](scripts/engine-client-test.js)（4 组，含普通崩溃负例防误判）。
   ③ **故障恢复 UI**：index.html 新增 body 级 `#engine-banner` 持久提示条（三主题可见，CSS app.css），按钮：重新检测 / 下载 .NET 9（openExternal 官方页）/ 杀软隔离说明（火绒/360/Defender 路径文案，不自动改杀软）/ 导出诊断；文案表 `FAILURE_COPY` 在 player.js，boot 时 engineStatus 补显（事件早于渲染层订阅的场景）；熔断 toast 文案去掉"可能被安全软件拦截"的武断表述。
   ④ **播放链路共享状态**：player.js `state.chain={phase,format,updatedAt}`，phase=loading/playing/paused/stopped/device-changed/output-error/engine-dead，变更发 DOM 事件 `annie-chain-state`（三主题单一事实源）；停止/播完/engine-dead 调 `clearPlaybackFormat()` 清 #np-format/#bp-chip/window.__lastFormat（暂停保留）；AM（am-render bindGlobal）与 FB2K（fb2k bindGlobal）订阅该事件清各自格式徽标/格式行；设置中心健康区块加"本次引擎运行累计+运行时长+最近刷新时刻"，链路详情共享模式输出格式标注"引擎侧；系统混音器最终格式由 Windows 决定"。
   验证：`check-syntax.js` 155 文件 0 失败、两个新测试全过、当前 engine/publish（72,580,722 字节）通过校验。**未做**：最终 NSIS 安装包安装后复验（仍为 unpacked 校验）、真机 dev GUI 验证、媒体库体检/省电/同步（后续批次）。
   追加验证（2026-10-12）：暂存目录模拟打包后结构（硬链接 AnnieEngine.exe + junction tools），`node scripts/smoke-test.js <staging>` 全过：三件套存在 / ffmpeg 可运行 / engine.info 找到 ffmpeg / devices.list 结构正常（6 设备）/ probe 48kHz 测试音解码正常。

34. ✅**文件夹拖放 + 歌词 5 秒不回弹（2026-10-13，用户 791529734「红叶抄」/3464023482「蓝的天」）**：
   - 新主进程 IPC `drop:classify(paths)`→`[{path,name,isDirectory}]`（main.js + preload `dropClassify`），配合既有 `drop:expand`（递归目录取音频）。player.js 暴露 `window.annieCollectDropped(fileList)→{files,folders}`。
   - **AM 主题**：侧栏播放列表区空白处放文件夹→以文件夹名建歌单并装入递归歌曲（`bindSidebarFolderDrop`，挂 am-dom build 的 root，仅在落点为 `.am-side` 且不在具体歌单按钮时触发，纯散文件不拦截交给 queue）；拖到具体歌单按钮/已打开歌单视图→展开后加进该歌单（per-button 与 R.content 的 drop 已改 `plExpandDropped` 异步递归，不再只收散音频）。`.am-side-drop` 整列高亮。
   - **FB2K 主题**：`bindFbTreeFolderDrop(R.tree)` 同样规则；树节点 `node()` 补 `dataset.key`（'pl:'+id）。
   - **歌词手动滚动 5 秒不回弹**：主面板 R.lyrScroll 之前从没注册 autoHideScrollbar（5 秒机制只对 imm/mini 生效）→ build 时补 `AM.autoHideScrollbar(R.lyrScroll)`；fb2k R.lyrLines 新增本地 holdoff（`S._fbLyrManualUntil` + `_fbLyrProgMark`），程序驱动滚动先 mark 150ms 避免误判手动。切歌 renderLyrics 重置 holdoff。
   - 落点判定：拖到歌单按钮上由按钮 drop（stopPropagation）处理加歌；侧栏空白处文件夹→建歌单；散文件→全局 queue。
   - 验证：check-syntax 155/0、engine-client + engine-publish 测试全过、engine/publish 校验通过。**真机 GUI 拖放/滚动未验**。

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

## 七、媒体库体检 & 备份迁移（V4.4.2 起；计划见 `媒体库体检与备份迁移-实现计划.md`）

> **状态：V4.4.2 已发布**（2026-10-13，tag v4.4.2，release #49 成功；本地包 setupEXE\annie-player-svlx-setup-4.4.2.exe 引擎 72.5MB 自包含门禁通过）。

### 本次发版教训（V4.4.2 过程沉淀，后续 agent 必读）
- **主进程模块顶层不得 `require('electron')`**：CI 的纯 Node 测试（ci.yml 无 `npm ci` 步骤，与 release.yml 不同）会 MODULE_NOT_FOUND 红叉。V4.4.1 的 `engine-client-test.js` 因此连红两次（V4.4.1/V4.4.2 首发 CI 都挂），V4.4.2 补 commit 把 engineClient.js 改成惰性加载（`electronApp()/electronBrowserWindow()` 函数内 require）。**新写主进程模块若需跑纯 Node 单测，顶层只引 Node 内置模块；healthCheck.js/backup.js/trackMatcher.js 均遵守此规**。
- **ci.yml 与 release.yml 的依赖准备不对称**：release.yml 有 `npm ci`，ci.yml 没有（图快）。往 ci.yml 加测试步骤时先确认该测试链路不碰 node_modules 里的包。
- **改完 Electron 主进程/preload 的验证纪律**：渲染层 Ctrl+R 即生效，主进程/preload 必须退出重开；涉及 ffmpeg 写标签必须 dev 真实落盘验证（AGENTS 规范 5 旧账）。
- **续播弹窗（V4.4.2 行为变更）**：恢复点 localStorage `annieplayer.resume.v1/pos`，弹窗在 am-render.js `showResumePrompt`，流媒体恢复点冗余 title/artist 字段（防 URL 文件名直接上屏）。
- **彩胶外观双写**：localStorage 主写 + `store.vinylCfg` 镜像（800ms 防抖 saveSettings），启动 `vinylSeedFromStore()` 只回填缺失键；「恢复默认」须先 persistVinylCfg 再 applyVinylStyle（否则种子回填旧值）。

### Slice A：体检 P0（H1-H9）✅ 已落代码（待 dev 真机验证）
- **主进程模块** `annie/main/healthCheck.js`（无 Electron 依赖，仅 fs/path，可纯 Node 单测）：导出 `start(win, store)` / `cancel()` / `getLastReport()` / `fix(store,payload)` / `undo(store)` / `ITEM_CAP=500`。
- **扫描**：汇总 tracks+playlists.paths+favorites 的真实路径（CUE/ISO 虚拟轨剥 `#cueN/#isoN` 后缀按容器去重，`containerOf()`）→ `fs.statSync` 每 200 个 setImmediate 一拍可取消；文件夹判可达性时盘根（`path.parse(f).root`）stat 失败=offline（盘未插/网络盘断，不提供修复），盘根在而目录不在=missing（可移除）。
- **报告**（事件 `health:event`：start/progress/end，对齐 fakescan 模式）：`{totals,cats:{h1DeadTracks,h2PlaylistRefs,h3Favorites,h4Orphans,h5Folders,h6ZeroByte,h7MissingTags,h8Duplicates,h9Analysis}}`；每类 `{items,count,truncated}` 明细推渲染层**截断 500**，完整报告留模块内 `lastReport` 供 `health:exportReport` 导出。h4 额外带 `statsCount/metaCount`，h5 带 `missingCount/offlineCount`。H8 分组口径与 `lib:duplicates` 相同（同 norm 规则复制一份在 `duplicateStats()`）。
- **修复** `fix(store,{action,...})` 三动作（直接改 store，main.js 负责 saveStore/flush/广播）：① `pruneRefs`（playlistItems `{plId,path}` / favoriteItems `{path}`，移除前**复检文件仍死**否则进 skipped；歌单/收藏条目带原 index 供撤销按位插回）② `pruneOrphans`（items `{kind:'stats'|'meta',key}`，复检 key 仍不在 tracks）③ `removeFolders`（复检目录仍缺失；与 `lib:removeFolder` 同口径连 tracks 一起过滤）。返回 `{snapshot,removed,skipped}`。
- **撤销快照**：main.js `health:fix` 写 `store.healthUndo = {time, actions:[snapshot]}`（**只留最近一次**，新修复覆盖）；`Buffer.byteLength(JSON.stringify(candidate)) > 5MB` 时不入库，返回 `snapshotTooLarge:true` + `manifest` 供渲染层走 `health:saveJson` 导出清单。`health:undo` 按 actions 逆序、同组 index 降序 splice 写回（已存在的键/路径不覆盖）。H6 零字节删除走 `lib:deleteFiles` 回收站链路，**不进撤销快照**。
- **修复后刷新**：main.js 三个修复动作末尾统一 `broadcastScan({type:'done',fallback:true})` → player.js:892 整库重拉 getLibrary；removeFolders 额外 `setupLibraryWatch()` 重建监听。
- **IPC**（main.js 备份 IPC 之后）：`health:scan / health:cancel / health:fix / health:undo / health:undoInfo / health:exportReport / health:saveJson`；preload 同名 `healthScan/healthCancel/healthFix/healthUndo/healthUndoInfo/healthExportReport/healthSaveJson/onHealthEvent`。
- **UI**：settings.js 曲库工具区（dup 清理与配置备份之间），`hcRow` 入口 + `hcUndoBox`（撤销条，面板构建即查 undoInfo）+ `hcReportBox`（进度条 + 9 张 `.set-hc-card` 卡片）；样式 app.css `.set-hc-*`（badge ok/warn/bad 三色系，复用 set-dup 暗色卡片风）。H1 修复=confirm 后 `mine.rescan()`；H8 卡片按钮滚动到 dupRow 并自动点 dupBtn；H9 按钮滚动并 click 现有 loudBtn/bpmBtn。
- **H4 流媒体键分流**（2026-10-13 真机报告驱动）：stats 里 `http(s)://` 开头的键是流媒体临时播放链接的统计（vkey 过期即废、只增不减），扫描时按 `kind:'stream'` 单列子组「流媒体播放统计（可安全清理）」，`h4Cat.streamCount` 单独计数；pruneOrphans 的 fix 把 `stream` 与 `stats` 同桶处理（都从 store.stats 删）。
- **验证**：check-syntax 156 文件 0 失败；纯 Node 造数单测 29 项断言全过（死链/CUE 容器丢失/零字节/孤儿/文件夹移除/撤销按位还原/复检跳过/取消）。
- **待办切片**：D=深度体检 H10-H12（缺封面/不可解码/封面缓存清理，ffmpeg 前 5 秒并发 4）。

### Slice D：深度体检 H10-H12 ✅ 已落代码（待 dev 真机验证）
- **healthCheck.js** 深度段：`start(win, store, {deep, coverCacheDir})`——deep=true 时 P0 跑完后对 tracks 存活文件（容器去重）4 并发逐首探测：
  - H11 不可解码：`ffmpeg -v error -t 5 -i f -f null -`，退出码非 0 或 stderr 有输出即坏；
  - H10 缺封面：ffprobe JSON streams 找 `codec_type=video 且 attached_pic!=0` 的内嵌图，无则查目录外置封面（cover/folder/front/album/art/thumb × jpg/jpeg/png/webp，目录级 memo 共享），解码失败的文件跳过封面探测；
  - H12 封面缓存：readdir + stat 汇总 covercache 条数/字节。
  - `runProbe`（spawn + 200ms cancel 轮询 + 超时 SIGKILL；取消/超时/启动失败返回 null——深度项宁可漏报不误报）；工具路径 resolveTool 三候选（resourcesPath / 仓库根 engine/tools / PATH）。报告新增 `deep:true` + `cats.h10NoCover/h11Undecodable/h12CoverCache`，进度事件 `phase:'deep'`。
- **IPC**：`health:scan({deep})` 传 coverCacheDir（仅 deep 时）；`health:clearCoverCache` 清空缓存目录并 `library.initCoverDiskCache` 重建内存索引（防索引指向已删文件）。
- **UI**：体检行右侧「深度体检」勾选（localStorage `annieplayer.health.deep` 记忆）；报告尾部 H10（仅报告，引导在线匹配）/ H11（勾选移回收站，走 libDeleteFiles）/ H12（显示占用 + 一键清空）三张卡片。
- **验证**：真实 ffmpeg 造好/坏文件各一——H11 正确报坏、H10 正确报缺封面、H12 计数正确；20 文件并发取消后 2.5s 无 ffmpeg 进程残留。

### Slice C：跨机路径重映射 + 重启后二次匹配 ✅ 已落代码（待 dev 真机验证）
- **匹配器共享** `annie/main/trackMatcher.js`：V4.3.25 五级匹配（绝对路径→相对根→文件名+大小→同名+时长±1.5s→标题艺人+时长±2s）原样抽出，`matchTracks(items, store)` 返回 `{matched, missing, perItem}`（perItem 为 Slice C 新增的逐条对齐数组，null=未命中；旧调用方不受影响）。main.js `.anniepl` 导入改调共享模块。
- **路径重映射**（backup.js）：`remapViewPaths(view, rootMap)` 前缀替换 folders/favorites/playlists.paths/stats/analysis 键——路径边界匹配（`根` 或 `根\` 前缀，MusicX 不被 Music 吞）、大小写不敏感比较但保留后缀原始大小写、CUE/ISO `#cueN` 后缀不动；`rootCheck(view, rootMap, {dirExists,fileExists})` 返回逐根可达性 + 映射后预估 matched/total（fns 注入便于单测）。
- **新 IPC**：`backup:pickDir`（纯选目录不入库）、`backup:rootCheck`（读包+normalize+预估）、`backup:apply` 增 rootMap/smartMatch 入参（apply 前先 remapViewPaths，返回 remapped 数）、`backup:rematch`（重启后二次匹配）。
- **_pendingMigration**：apply 时若导入了路径类分区且 smartMatch≠false 则写 `{time, file, rootMap, remapped}`；`backup:rematch` 读备份文件取 analysis 指纹 → 逆向 rootMap 找回原始路径 → 对 store 中仍死的引用（歌单/收藏/stats/metaCache 键）跑 matchTracks → 命中回写（stats 同键合并相加、metaCache 并入分析白名单字段保 fresh 条目），清标记 + broadcastScan fallback。备份文件被删则清标记放行（死链留给体检 H2/H3）。
- **渲染层**：settings.js 向导恢复三步编号（摘要 → **路径重映射** → 模式与内容）；第 2 步逐根显示「本机存在/本机不存在/已映射 ✓」+ 选文件夹/清除映射 + 实时预估「预计匹配 X/Y 首」+ 智能匹配勾选（默认开）；摘要渲染抽成 bkRenderSummary 供上一步返回复用。player.js 启动检测 `_pendingMigration`：有索引直接 rematch，空库等 scan done 事件后 rematch → 结果条「已恢复 X/Y 条引用」+ 未匹配 confirm 后走 healthSaveJson 导出清单。
- **验证**：check-syntax 158 文件 0 失败；Node 单测 22 项全过（五级匹配/perItem 对齐/占用互斥/remap 边界与 CUE 后缀/rootCheck 预估）。

### Slice B：备份 2.0（分内容导出 + 导入向导摘要/模式内容步）✅ 已落代码（待 dev 真机验证）
- **主进程模块** `annie/main/backup.js`（纯函数无 Electron 依赖）：`buildPackage(store,{sections,listenStats,appName,appVer})` / `estimate(store,listenStats)` / `normalize(pkg)`（v1 平铺 data → v2 视图）/ `inspectPackage(pkg,fileBytes)` / `extractRoots(sections)` / `applyToStore(store,view,{mode,sections})`；常量 `SECTIONS`/`ANALYSIS_FIELDS`/`STRUCT_KEYS`。
- **v2 包**：`{kind:'annie-backup',schemaVersion:2,app,ver,time,sections:{settings,folders,favorites,playlists,streamPlaylists,stats,analysis,listenStats},counts,roots}`。settings = store 顶层减 STRUCT_KEYS（含 healthUndo/_pendingMigration/_pendingRescan，永不入包）；analysis = metaCache 白名单字段（`loudness,bpm,key,track,disc,rg,fakeScan,mtimeMs,fileSize,duration,title,artist,album`，封面 dataURL 永不入）；listenStats（听歌报告 localStorage `annieplayer.listenstats.v1`）跟随「收听统计 stats」勾选，由渲染层读 localStorage 传入。
- **roots 提取**：优先 folders 聚类（子目录被父目录吸收，大小写/斜杠归一）；无 folders 时从 favorites/playlists.paths/stats/analysis 键的父目录聚类，上限 50。Slice C 的路径重映射以此为基础。
- **合并模式口径**（决策 3 落地）：folders/favorites 并集（路径归一去重、现有顺序在前）；playlists 按名合并 paths 并集、新名追加且 id 撞车换新 id；streamPlaylists 按 id 去重跳过；stats 同键数值相加、lastPlayed 取大；settings 只补缺省键（ui 对象按键级补）；analysis 逐键 `Object.assign(本机, 备份白名单)`。覆盖模式 = 对应键整表替换（analysis 整表替 metaCache）。**任何导入后 healthUndo 清 null**（防撤销快照引用已不存在的数据）。
- **IPC**（替换旧 backup:export/import）：`backup:estimate(listenStats)`、`backup:export({sections,listenStats})`（返回 bytes/counts）、`backup:pickInspect()`（选文件+只读摘要+roots）、`backup:apply({path,mode,sections})`（.bak 兜底 → apply → flush → setupLibraryWatch；tracks 空且 folders 非空时写 `_pendingRescan` 标记）。
- **渲染层**：player.js 启动 `loadLibrary()` 后检查 `_pendingRescan` → saveSettings 清除 + proToast + scanStart（换机/重装导入后自动重建索引）。settings.js 曲库工具区「曲库备份与迁移」：导出面板 7 项勾选（analysis 默认不勾，各项实时显示条数+预估字节+总计）；导入向导内联两步（B 切片暂不含路径映射步）：摘要（版本/时间/各项数量/roots）→ 模式（覆盖/合并 radio）+ 内容勾选 → confirm → apply → listenStats 写回 localStorage（merge 时本机已有报告则保留）→ 800ms 后 relaunchApp。
- **验证**：check-syntax 157 文件 0 失败；纯 Node 单测 44 项断言全过（v2 导出/白名单/roots 聚类/覆盖/合并全口径/v1 兼容/坏文件三种形态拒绝/部分分区导入）。

## 八、DSD 播放链路与已知坑（V4.4.3 诊断实锤，首案 DIAG-20261014-2144 XMOS 沙沙声）

- **三模式**（settings.js:34 dsdMode `pcm|dop|native`，IPC `dsd.setMode`）：
  - `pcm` 转 PCM（默认）：ffmpeg DSF 解码器直出 **352800Hz**（DSD64/8）float PCM 走普通 Play 路径（Engine.Playback.cs:69 条件 `_dsdMode!="pcm"`）。
  - `dop`：**仅 WASAPI 独占**（TryPlayDop 对非 WasapiExclusiveBackend 直接 notify 回退，Engine.Playback.cs:260-264）；引擎自封装 DoP = DsdRate/16 → 176.4k/24bit（Dop.cs:128）；设备能力 `wb.SupportsDop(rate)` 实测（devices.json `dop:true/false`）。
  - `native`：TryPlayDop 分发到 TryPlayNativeDsd（Engine.Playback.cs:259 → :326），**仅 ASIO**；`AsioNativeDsdOutput.Open()` 用 kAsioCanDoIoFormat 探 DSD 原始格式，被拒即 notify 并**回退普通 PCM 路径（=352.8k ffmpeg 直出）**。
- **⚠️ 已实锤坑：Native 被拒后回退 352.8k float 直出 ASIO 会出「全程沙沙白噪」**。AsioBackend.TryOpenCore 在 `getSampleRate` 返 ASE_NotPresent（驱动未运行态，良性）时「按请求率直试」（Outputs.cs:816-819），`AsioOut.Init` 不抛异常只代表缓冲建成（日志「已以 float32 格式成功初始化」），**不保证 DSD 能力驱动真按 352.8k 线性 PCM 重放**——Thesycon 系 XMOS 驱动（XMOS USB Audio 2.0 ST 3059 实测）Init 假成功、DAC 输出沙沙。
- **处置口径**（给用户）：ASIO+native 沙沙/异常 → 改 **WASAPI 独占 + DoP**（devices.json dop:true 的设备即支持，真 DSD 直通）；ASIO 刚需 → 选 foo_dsd_asio/DSDTranscoder 代理驱动（设备枚举里可见，需自配）；pcm 模式在同类驱动的 352.8k 上同样可能异常。
- **可选引擎加固（未做，待授权）**：DSF 转 PCM 对 ASIO 后端优先降到 176.4k/24bit（DoP 同族率）而非 352.8k 直出；ASIO 通道 sampleType 为 ASIOSTDSDInt8* 时禁止以 float PCM Init；Native 失败 notify 带「超高率 PCM 部分驱动会出噪，建议 WASAPI DoP」文案。
- 判据速记：DSD 沙沙（全程宽带白噪、持续）= 格式错配，不是欠载（欠载是静音断续）；看 engine-log 有无「Native DSD 打开失败」+「352800Hz…float32 成功初始化」相邻两行即可定性。

## 九、安全审计加固（V4.4.3，群友秋野奈静态审计反馈，第 1 批已修）✅
- **P0 流缓存源流错误崩溃（已修）**：streamCache.js fill() 旧实现 `Readable.fromWeb(resp.body).pipe(ws)` 只监听 ws 的 error，网络中断时源流 unhandled 'error' 异步抛出、try/catch 抓不到 → 主进程无提示退出（与「失败静默」注释矛盾）。改用 `stream/promises` 的 `pipeline()`（错误统一走 catch，失败销毁两端）。
- **P0 主进程全局兜底（已修）**：main.js 顶部注册 `process.on('uncaughtException'/'unhandledRejection')` → `processErrorRing`（50 条环形，console.error 留痕，不主动退出——Electron 主进程多数未捕获错误可恢复）；诊断包新增 **main-process-errors.txt**。此前全项目零兜底。
- **P1 渲染层封面缓存 LRU（已修，上限均 300）**：proUi.js `npfCoverCache`（Map+npfCoverSet 触顶删最旧键）、pro.js `coverCache`（Map+coverSet）、remote.js `coverCache`（普通对象+coverKeys FIFO，因 fetchCover 用 `in` 判占位）。对照已有的 library.js coverCache 300 / streaming coverCache 200。
- **P2 HTML 注入面（已修）**：fb2k.js 新增本地 `escHtml()`（与 player.js:547 同口径 `&<>"'`），元信息面板两处 innerHTML 拼接（流媒体 sg.* + 本地 m.*/文件路径）元素内容与 key 都转义（title 属性原有 `&quot;` 替换保留）；fakeScan.js buildHtml 报告的 path/grade/reason 转义（score 是数字不转）。实际威胁低（数据源是曲库+平台 API，无远程页面），属纵深防御。
- **src/ 目录真相（审计误判澄清）**：`package.json "main":"src/main.js"`——src/main.js 是**真入口**（便携模式/单例锁/托盘/require annie 主模块），进打包，**绝不能删**。仅 `src/preload.js`（svlx:* 7 通道主进程零 handler）、`src/launcher.js`、`src/launcher.html`（无 loadFile）是旧启动器残留，V4.4.3 已精确删除。
- **未修（第 2/3 批，待拍板）**：① `track:readFile`（main.js:1943→library.readFileBuffer 只限 64MB 无目录约束）与 `lib:deleteFiles`（shell.trashItem 任意路径）拟加「必须在已加入曲库目录内」白名单；② senderFrame 来源校验（单窗口应用价值低）、sandbox:true（需验证手机遥控第二窗口）；③ backgroundThrottling:false 是 V4.4 为彩胶遮挡停转有意关闭，hide 时节流方案用户 2026-10-14 已拍板放弃省电方向；④ 591 空 catch 多为有意静默降级，不搞运动式整改。

## 十、AM 专辑详情页排序（V4.4.3）✅
- **需求**：专辑详情页（albums 视图点入某专辑）曲目多方式排序 + 默认按「发布顺序」。
- **设置键**：`ui.amAlbumDetailSort`（settings.js DEFAULTS，默认 `release`；与专辑列表页 `amAlbumSort` 独立）。
- **实现**：am.js `sortAlbumDetailTracks(list, mode)`——
  - `release`：碟号 disc → 曲目号 track（'no/of' 取前段 `parseInt(s.split('/')[0])`，与 library.js orderAudioPaths 同口径）；无碟号按 1 处理；无号沉底按文件名 azCollator；CUE 虚拟分轨无 track 标签 → `#cueN`/`#isoN` 数字续排（正 `#(cue|iso)(\d+)`）。
  - `az` 标题 / `azArtist` 演唱者（副键标题）/ `name` 文件名 / `durDesc|durAsc` 时长。
  - `trackMeta(t)` 扩展返回 `track/disc` 原始串（metaCache 白名单字段本就含）。
  - `currentTracks()` 在 `albums&&albumKey` 分支末尾调用。
- **UI**：am-dom.js 详情页头部改为「‹ 专辑 + 专辑名 + am-sort-sel 排序下拉」（复用 `.am-view-head` 样式与下拉持久化逻辑，headKeyFor 加 `albumDetail#key#mode` 保证 IME/切换不重建搜索框——详情页无搜索框，故自建 head 而非 buildViewHead）。
- **验证**：check-syntax 157 文件 0 失败；dev 真机验证待用户跑。

## 十一、在线搜索历史交互（V4.4.3）✅
- **需求**：在线音乐搜索历史支持单条删除 + 清空全部。
- **实现**：am-stream.js 搜索输入行（仅 search 页签）去掉原生 `<datalist>`（不支持交互），改自绘下拉弹层 `.am-st-histpop`（输入行内 `position:absolute` 挂载，复用玻璃风 CSS 变量）——聚焦/输入时弹出，每行 ✕ 单删（改 localStorage `annieplayer.stHistory`），底部「清空全部」；blur 120ms 后关闭（给点击留窗口，不自建 document 外点监听，避免与 R.pop 机制冲突）。
- **CSS**：am.css `.am-st-histpop/.am-st-histrow/.am-st-histtxt/.am-st-histdel/.am-st-histfoot`（z-index 60 在内容层之上、低于全局 R.pop 的 90）。
- **验证**：check-syntax 157 文件 0 失败；dev 真机验证待用户跑。

## 十二、DSD 白噪修复 + 特权 IPC 白名单 + 播放链路状态实时化（V4.4.5 待发）✅
### 1. DSD 转 PCM「假成功」白噪修复（红叶抄诊断包实锤）
- **故障链**（诊断日志逐行）：`[dsd] Native DSD 打开失败: kAsioCanDoIoFormat 被拒` → `[asio] 采样率探测返回 0，将以 352800Hz 直接尝试打开` → `[asio] 已以 float32 格式成功初始化` = 全程白噪。根因：DSF 的 ffmpeg 默认输出率（DSD64→352.8kHz）当 PCM 率直开 ASIO，驱动 Init「假成功」但取数速率错配。
- **修复 A（Engine.Playback.cs `OpenWithChannels`）**：DSD 源（`info.Codec` 含 dsd）且 rate>176400 时钳到 **176400Hz**（DoP 同族率），标 `resampled=true` 并 emit notify；format 事件 `dsdMode` 如实报 `"pcm"`（此前报 `_dsdMode` 全局值，渲染层会误显 Native DSD 徽标），`reason` 写「DSD 转 PCM（钳至 176400Hz 安全回退）」。
- **修复 B（Outputs.cs `AsioBackend.TryOpenCore`）**：驱动采样率探测返回 0 且 requestedRate>192000 时，不再硬开——先按 `AsioFallbackRates` 找 ≤192k 的可对齐率（优先 176400/88200）交给引擎重采样；全被拒才硬开。
- **Stats 补字段（Engine.cs）**：`dsdNativeActive = _asioDsd != null`——注意 `dopActive` 在 Native 和 DoP 路径都为 true，区分必须看 `dsdNativeActive`，状态页判断顺序先 Native 后 DoP。
- **验证**：引擎编译 0 error（109 警告全是既有 CS8632 nullable 注释）；真机白噪消除待用户验证（用户设备 XMOS USB Audio 2.0 ST 3059 + ASIO Native）。

### 2. 特权 IPC 曲库白名单（安全审计第 2 批）
- **实现（main.js `registerIpc` 内 `pathAllowed(p)`）**：路径剥 `#cueN/#isoN` 后缀后，必须命中 `store.tracks[].path` ∪ `store.playlists[].paths` ∪ `store.folders[]` 前缀（含根目录自身）。playlists.paths 入白名单是为兜住「拖入曲库外文件」的既有体验（这类文件进歌单不一定进 tracks）。`path.resolve` 归一防 `..` 穿越，大小写按 Windows 语义。
- **套用点**：`lib:deleteFiles`（拒绝时 `failed.push({error:'not-in-library'})` 不删）、`track:readFile`（拒绝时 throw）。两者与 `pathAllowed` 同在 `registerIpc` 作用域（闭包可见）。
- **未套用**：`iso:extractTrack`（src 须是曲库轨才被 UI 触发，且产物落 userData/isoCache，风险低）；tagWriter/backup 走 dialog 自选路径天然受限。sandbox:true 升级未做（需专项验证手机遥控第二窗口）。
- **验证**：check-syntax 0 失败；行为回归待用户验证（拖入曲库外文件的节拍分析/删除不应被误拒）。

### 3. 播放链路状态页（设置 → 音频输出 → 输出健康）
- **范围决策**：不新建页面——「输出健康」区（settings.js:962 起）已含设备/格式/缓冲/欠载/限幅 + 链路图 + 全参数对照浮层（openChainDetail），本次只补差距。
- **本次增量**：① 文本区补「音频输出」行（ASIO/WASAPI + 独占/共享说明）与「DSD 处理」行（Native DSD / DoP / 不适用，依赖 stats.dsdNativeActive）；② 自动刷新——`setInterval` 2.5s 且仅在 `panel.open && currentPage==='audio'` 时拉 `engine('stats')`（与统计页 3454 行同款「面板开着才轮询」模式，关闭零开销）。
- **验证**：check-syntax 0 失败；真机显示待用户验证。

---

> **维护提醒**：每次阅览代码发现新事实，顺手追加到对应分区；分区不够用就新加。「🔍待验证」项落实后改「✅」并补行号。本文件随仓库走 git，别提交到杂物目录。
