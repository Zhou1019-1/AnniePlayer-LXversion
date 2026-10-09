'use strict';
// 渲染层桥：contextIsolation 下暴露受控 API。

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mine', {
  // 窗口
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  winClose: () => ipcRenderer.invoke('win:close'),

  // V4.4：AnnieFlyout 伴侣进程（任务栏小组件 + 切歌弹窗）
  flyoutGet: () => ipcRenderer.invoke('flyout:get'),
  flyoutSet: (on) => ipcRenderer.invoke('flyout:set', on),
  flyoutPush: (obj) => ipcRenderer.send('flyout:push', obj), // SMTC 桥：曲目/状态推送
  onFlyoutCmd: (cb) => { // SMTC 桥：按钮命令回流（play/pause/next/prev）
    const listener = (_e, cmd) => cb(cmd);
    ipcRenderer.on('flyout:cmd', listener);
    return () => ipcRenderer.removeListener('flyout:cmd', listener);
  },

  // V3.5.8：全局快捷键 / 播放状态上报（任务栏缩略图）
  hotkeysGet: () => ipcRenderer.invoke('hotkeys:get'),
  hotkeysSetEnabled: (on) => ipcRenderer.invoke('hotkeys:setEnabled', on),
  playState: (s) => ipcRenderer.send('player:state', s),
  playerProgress: (p) => ipcRenderer.send('player:progress', p), // V3.5.18：任务栏进度条

  // 曲库
  pickFolder: () => ipcRenderer.invoke('lib:pickFolder'),
  removeFolder: (f) => ipcRenderer.invoke('lib:removeFolder', f),
  rescan: () => ipcRenderer.invoke('lib:rescan'),
  getLibrary: () => ipcRenderer.invoke('lib:get'),
  libDuplicates: () => ipcRenderer.invoke('lib:duplicates'),       // V3.5.8：重复歌曲检测
  libDeleteFiles: (paths) => ipcRenderer.invoke('lib:deleteFiles', paths), // V3.5.8：移入回收站
  tracksHide: (paths) => ipcRenderer.invoke('lib:tracksHide', paths), // V4.3.22：仅移出曲库显示
  toggleFavorite: (p) => ipcRenderer.invoke('lib:toggleFavorite', p),
  metaBatch: (paths) => ipcRenderer.invoke('lib:metaBatch', paths),
  metaFullBatch: (paths) => ipcRenderer.invoke('lib:metaFullBatch', paths), // V3.1：批量完整 meta（含封面）
  matchSearch: (params) => ipcRenderer.invoke('match:search', params), // V3.3.1：在线歌词/封面匹配
  matchApply: (params) => ipcRenderer.invoke('match:apply', params),
  matchBatchStart: (paths, opts) => ipcRenderer.invoke('match:batchStart', paths, opts), // V4.3.4：批量匹配歌词
  matchBatchCancel: () => ipcRenderer.invoke('match:batchCancel'),
  onMatchBatchEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('match:batch:event', h); return () => ipcRenderer.removeListener('match:batch:event', h); },
  tagPickCover: () => ipcRenderer.invoke('tag:pickCover'),            // V3.5.9：标签编辑选封面
  tagEdit: (params) => ipcRenderer.invoke('tag:edit', params),        // V3.5.9：写回标签
  tagEditBatch: (params) => ipcRenderer.invoke('tag:editBatch', params), // Track B：批量写回标签

  // SVLX 1.3.0：自建播放列表（AM 主题）
  playlists: () => ipcRenderer.invoke('lib:playlists'),
  playlistCreate: (name) => ipcRenderer.invoke('lib:playlist:create', name),
  playlistRename: (id, name) => ipcRenderer.invoke('lib:playlist:rename', id, name),
  playlistDelete: (id) => ipcRenderer.invoke('lib:playlist:delete', id),
  playlistAdd: (id, paths) => ipcRenderer.invoke('lib:playlist:add', id, paths),
  playlistReorder: (id, paths) => ipcRenderer.invoke('lib:playlist:reorder', id, paths), // V4.3.22：拖拽排序
  // V4.3.22：导入 foobar2000 .fpl 播放列表
  fplImport: () => ipcRenderer.invoke('lib:playlist:importFpl'),
  // V4.3.25：自建歌单导出（.anniepl）/ 导入换机复现（多指纹匹配）
  playlistExportFile: (id) => ipcRenderer.invoke('lib:playlist:exportFile', id),
  playlistImportFile: () => ipcRenderer.invoke('lib:playlist:importFile'),
  // V4.3.26：在线歌单导出（.anniespl）/ 导入换机复现（流媒体 provider+ID 快照，无需本地文件）
  splExportFile: (id) => ipcRenderer.invoke('spl:exportFile', id),
  splImportFile: () => ipcRenderer.invoke('spl:importFile'),
  // V4.3.26：侧栏自建歌单长按拖拽排序
  playlistReorderList: (ids) => ipcRenderer.invoke('lib:playlist:reorderList', ids),
  // V4.3.5：在线歌单（流媒体收藏）
  splList: () => ipcRenderer.invoke('spl:list'),
  splCreate: (name) => ipcRenderer.invoke('spl:create', name),
  splRename: (id, name) => ipcRenderer.invoke('spl:rename', id, name),
  splDelete: (id) => ipcRenderer.invoke('spl:delete', id),
  splAdd: (id, songs) => ipcRenderer.invoke('spl:add', id, songs),
  splRemove: (id, indexes) => ipcRenderer.invoke('spl:remove', id, indexes),
  playlistRemove: (id, p) => ipcRenderer.invoke('lib:playlist:remove', id, p),

  // EXP 7.28：Worker 曲库扫描（批量/进度/取消）
  scanStart: () => ipcRenderer.invoke('lib:scanStart'),
  scanCancel: () => ipcRenderer.invoke('lib:scanCancel'),
  onScanEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('scan:event', listener);
    return () => ipcRenderer.removeListener('scan:event', listener);
  },

  // 曲目数据
  meta: (p) => ipcRenderer.invoke('track:meta', p),
  lyrics: (p) => ipcRenderer.invoke('track:lyrics', p),
  readFile: (p) => ipcRenderer.invoke('track:readFile', p),
  // SVLX 1.2.0：SACD ISO 按需解轨（返回 { ok, path } / { ok:false, error }）
  isoExtract: (params) => ipcRenderer.invoke('iso:extractTrack', params),

  // 设置
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  // 引擎
  engine: (method, params, timeoutMs) => ipcRenderer.invoke('engine:call', method, params, timeoutMs),
  onEngineEvent: (cb) => {
    const listener = (_e, payload) => cb(payload.event, payload.data);
    ipcRenderer.on('engine-event', listener);
    return () => ipcRenderer.removeListener('engine-event', listener);
  },

  // VST实验区：VST3 效果器（选择 .vst3 文件）
  vstPickPlugin: () => ipcRenderer.invoke('vst:pickPlugin'),
  vstPresetExport: (json) => ipcRenderer.invoke('vst:presetExport', json), // V3.5.11：导出效果器方案
  vstPresetImport: () => ipcRenderer.invoke('vst:presetImport'),           // V3.5.11：导入效果器方案

  // 流媒体平台（洛雪 musicSdk：酷狗 / 酷我 / 咪咕 / QQ / 网易）
  streamSearch: (params) => ipcRenderer.invoke('stream:search', params),
  streamSongUrl: (params) => ipcRenderer.invoke('stream:songUrl', params),
  streamLyric: (params) => ipcRenderer.invoke('stream:lyric', params),
  streamGetPic: (params) => ipcRenderer.invoke('stream:getPic', params),
  streamCoverProxy: (url) => ipcRenderer.invoke('stream:coverProxy', url),
  streamHotSearch: (params) => ipcRenderer.invoke('stream:hotSearch', params),
  streamHotComments: (params) => ipcRenderer.invoke('stream:hotComments', params), // V3.5.19：网易云热门评论
  // 发现音乐：排行榜 / 歌单广场（V3.5.4）
  streamLeaderboards: (params) => ipcRenderer.invoke('stream:leaderboards', params),
  streamLeaderboardList: (params) => ipcRenderer.invoke('stream:leaderboardList', params),
  streamSongLists: (params) => ipcRenderer.invoke('stream:songLists', params),
  streamSongListSearch: (params) => ipcRenderer.invoke('stream:songListSearch', params), // V4.3.16
  streamSongListDetail: (params) => ipcRenderer.invoke('stream:songListDetail', params),
  // V4.3：专辑搜索 / 专辑曲目
  streamAlbumSearch: (params) => ipcRenderer.invoke('stream:albumSearch', params),
  streamAlbumSongs: (params) => ipcRenderer.invoke('stream:albumSongs', params),

  // V4.4：节拍分析落盘缓存（beat-cache.json；键=曲路径，二次播放免整轨解码）
  beatCacheGet: (key) => ipcRenderer.invoke('beatCache:get', key),
  beatCacheSet: (key, map) => ipcRenderer.invoke('beatCache:set', key, map),
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p), // V4.4：在文件管理器中定位

  // 设置中心：版本 / 手动检查更新 / 外链 / 更新状态订阅
  appVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  copyText: (text) => ipcRenderer.invoke('app:copyText', text), // V4.3.16
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  onUpdateStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('app:updateStatus', listener);
    return () => ipcRenderer.removeListener('app:updateStatus', listener);
  },
  getReleaseNotes: (ver) => ipcRenderer.invoke('app:getReleaseNotes', ver), // 新版本更新日志（V3.5.3）

  // 洛雪式音源管理
  streamSourcesList: () => ipcRenderer.invoke('stream:sources:list'),
  streamSourcesImport: () => ipcRenderer.invoke('stream:sources:import'),
  streamSourcesImportUrl: (params) => ipcRenderer.invoke('stream:sources:importUrl', params),

  // V4.3.6：Qobuz 在线播放/下载
  qobuzStatus: () => ipcRenderer.invoke('qobuz:status'),
  qobuzLogin: (p) => ipcRenderer.invoke('qobuz:login', p),
  qobuzLogout: () => ipcRenderer.invoke('qobuz:logout'),
  qobuzSearch: (p) => ipcRenderer.invoke('qobuz:search', p),
  qobuzAlbumGet: (id) => ipcRenderer.invoke('qobuz:albumGet', id),
  qobuzPlaylistGet: (id) => ipcRenderer.invoke('qobuz:playlistGet', id),
  qobuzArtistGet: (id) => ipcRenderer.invoke('qobuz:artistGet', id),
  qobuzFavorites: (type) => ipcRenderer.invoke('qobuz:favorites', type),
  qobuzUserPlaylists: () => ipcRenderer.invoke('qobuz:userPlaylists'),
  qobuzFav: (p) => ipcRenderer.invoke('qobuz:fav', p),
  qobuzFileUrl: (p) => ipcRenderer.invoke('qobuz:fileUrl', p),
  qobuzLyricMatch: (p) => ipcRenderer.invoke('qobuz:lyricMatch', p),
  qobuzParseUrl: (text) => ipcRenderer.invoke('qobuz:parseUrl', text),
  qobuzDownload: (p) => ipcRenderer.invoke('qobuz:download', p),
  qobuzDlCancel: () => ipcRenderer.invoke('qobuz:dlCancel'),
  qobuzPickDlDir: (reset) => ipcRenderer.invoke('qobuz:pickDlDir', reset),
  onQobuzDlEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('qobuz:dl:event', h); return () => ipcRenderer.removeListener('qobuz:dl:event', h); },
  streamSourcesRemove: (params) => ipcRenderer.invoke('stream:sources:remove', params),
  streamSourcesSetEnabled: (params) => ipcRenderer.invoke('stream:sources:setEnabled', params),

  // 流媒体下载
  streamDownload: (params) => ipcRenderer.invoke('stream:download', params),
  streamDownloadDir: () => ipcRenderer.invoke('stream:downloadDir'),
  streamSetDownloadDir: () => ipcRenderer.invoke('stream:downloadDir:set'),
  streamResetDownloadDir: () => ipcRenderer.invoke('stream:downloadDir:reset'),
  // V4.3.22：下载任务管理器（下载情况视图）
  dlList: () => ipcRenderer.invoke('dl:list'),
  dlAdd: (items) => ipcRenderer.invoke('dl:add', items),
  dlPause: (id) => ipcRenderer.invoke('dl:pause', id),
  dlResume: (id) => ipcRenderer.invoke('dl:resume', id),
  dlRemove: (id) => ipcRenderer.invoke('dl:remove', id),
  dlClear: (statuses) => ipcRenderer.invoke('dl:clear', statuses),
  dlRetryAll: () => ipcRenderer.invoke('dl:retryAll'),
  dlOpenFolder: (id) => ipcRenderer.invoke('dl:openFolder', id),
  dlGetSettings: () => ipcRenderer.invoke('dl:settings:get'),
  dlSetSettings: (patch) => ipcRenderer.invoke('dl:settings:set', patch),
  onDlEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('dl:event', h); return () => ipcRenderer.removeListener('dl:event', h); },
  onStreamDownloadProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('stream:downloadProgress', listener);
    return () => ipcRenderer.removeListener('stream:downloadProgress', listener);
  },

  // 音频分析（频谱图 / 波形 / 无损检测）
  analyzeStart: (input, headers) => ipcRenderer.invoke('analyze:start', input, headers),
  analyzeCancel: () => ipcRenderer.invoke('analyze:cancel'),
  onAnalyzeEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('analyze:event', listener);
    return () => ipcRenderer.removeListener('analyze:event', listener);
  },

  // Pro beat0.0.1：响度分析（EBU R128）
  loudnessAnalyze: (p) => ipcRenderer.invoke('loudness:analyze', p),
  loudnessSet: (updates) => ipcRenderer.invoke('loudness:set', updates),
  bpmSet: (updates) => ipcRenderer.invoke('bpm:set', updates), // V4.3.16：BPM 落盘（相似推荐）
  loudnessBatchStart: (paths) => ipcRenderer.invoke('loudness:batchStart', paths),
  loudnessBatchCancel: () => ipcRenderer.invoke('loudness:batchCancel'),
  onLoudnessEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('loudness:event', listener);
    return () => ipcRenderer.removeListener('loudness:event', listener);
  },

  // Pro beat0.0.1：播放统计
  statsCount: (p) => ipcRenderer.invoke('stats:count', p),
  statsTime: (p, sec) => ipcRenderer.invoke('stats:time', p, sec),
  statsGet: () => ipcRenderer.invoke('stats:get'),

  // 假无损批量检测（V4.0.5：支持整库/文件夹/单曲三种范围）
  fakeScanBatchStart: (paths) => ipcRenderer.invoke('fakescan:batchStart', paths),
  fakeScanPickFolder: () => ipcRenderer.invoke('fakescan:pickFolder'),
  fakeScanPickFile: () => ipcRenderer.invoke('fakescan:pickFile'),
  fakeScanCancel: () => ipcRenderer.invoke('fakescan:cancel'),
  fakeScanExport: (format, items) => ipcRenderer.invoke('fakescan:export', format, items),
  onFakeScanEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('fakescan:event', listener);
    return () => ipcRenderer.removeListener('fakescan:event', listener);
  },

  // Pro beat0.0.1：迷你模式 / 桌面歌词 / 拖放 / 托盘
  miniEnter: (miniBounds) => ipcRenderer.invoke('mini:enter', miniBounds),
  miniExit: () => ipcRenderer.invoke('mini:exit'),
  miniSetSize: (w, h) => ipcRenderer.invoke('mini:setSize', w, h),
  miniPin: (on) => ipcRenderer.invoke('mini:pin', on), // V3.5.15：迷你窗口置顶开关
  dlyricsToggle: () => ipcRenderer.invoke('dlyrics:toggle'),
  dlyricsSetCompat: (v) => ipcRenderer.invoke('dlyrics:setCompat', v), // V4.3.13：高DPI透明窗鼠标失灵兼容模式
  dlyricsGetCompat: () => ipcRenderer.invoke('dlyrics:getCompat'),
  dlyricsLine: (payload) => ipcRenderer.send('dlyrics:line', payload),
  dlyricsCtl: (payload) => ipcRenderer.send('dlyrics:ctl', payload),
  onDlyricsLine: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('dlyrics:line', listener);
    return () => ipcRenderer.removeListener('dlyrics:line', listener);
  },
  onDlyricsClosed: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('dlyrics:closed', listener);
    return () => ipcRenderer.removeListener('dlyrics:closed', listener);
  },
  dropExpand: (paths) => ipcRenderer.invoke('drop:expand', paths),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onTrayAction: (cb) => {
    const listener = (_e, action) => cb(action);
    ipcRenderer.on('tray:action', listener);
    return () => ipcRenderer.removeListener('tray:action', listener);
  },
  // 关闭行为被系统对话框「以后都这样执行」修改后同步渲染层
  onCloseBehaviorChanged: (cb) => {
    const listener = (_e, behavior) => cb(behavior);
    ipcRenderer.on('annie:closeBehaviorChanged', listener);
    return () => ipcRenderer.removeListener('annie:closeBehaviorChanged', listener);
  },
  // V4.3.12：局域网手机遥控
  remoteGetInfo: () => ipcRenderer.invoke('remote:getInfo'),
  remoteSetEnabled: (enabled) => ipcRenderer.invoke('remote:setEnabled', { enabled: !!enabled }),
  remoteRegenCode: () => ipcRenderer.invoke('remote:regenCode'),
  remotePushState: (state) => ipcRenderer.send('remote:push', state),
  remotePushLib: (list) => ipcRenderer.send('remote:pushLib', list), // 遥控二期：曲库快照
  onRemoteCmd: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('remote:cmd', listener);
    return () => ipcRenderer.removeListener('remote:cmd', listener);
  },

  // Pro beat0.0.1：诊断包导出（rendererSnapshot 为渲染侧设置/状态快照）
  diagExport: (rendererSnapshot) => ipcRenderer.invoke('diag:export', rendererSnapshot),
  backupExport: () => ipcRenderer.invoke('backup:export'),   // V4.3.19：配置备份（脑暴 10.1）
  backupImport: () => ipcRenderer.invoke('backup:import'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  reportError: (payload) => ipcRenderer.send('renderer-error', payload) // 渲染层 JS 错误上报（进诊断包）
});
