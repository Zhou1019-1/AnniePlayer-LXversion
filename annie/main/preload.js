'use strict';
// 渲染层桥：contextIsolation 下暴露受控 API。

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mine', {
  // 窗口
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  winClose: () => ipcRenderer.invoke('win:close'),

  // 曲库
  pickFolder: () => ipcRenderer.invoke('lib:pickFolder'),
  removeFolder: (f) => ipcRenderer.invoke('lib:removeFolder', f),
  rescan: () => ipcRenderer.invoke('lib:rescan'),
  getLibrary: () => ipcRenderer.invoke('lib:get'),
  toggleFavorite: (p) => ipcRenderer.invoke('lib:toggleFavorite', p),
  metaBatch: (paths) => ipcRenderer.invoke('lib:metaBatch', paths),
  metaFullBatch: (paths) => ipcRenderer.invoke('lib:metaFullBatch', paths), // V3.1：批量完整 meta（含封面）
  matchSearch: (params) => ipcRenderer.invoke('match:search', params), // V3.3.1：在线歌词/封面匹配
  matchApply: (params) => ipcRenderer.invoke('match:apply', params),

  // SVLX 1.3.0：自建播放列表（AM 主题）
  playlists: () => ipcRenderer.invoke('lib:playlists'),
  playlistCreate: (name) => ipcRenderer.invoke('lib:playlist:create', name),
  playlistRename: (id, name) => ipcRenderer.invoke('lib:playlist:rename', id, name),
  playlistDelete: (id) => ipcRenderer.invoke('lib:playlist:delete', id),
  playlistAdd: (id, paths) => ipcRenderer.invoke('lib:playlist:add', id, paths),
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

  // 流媒体平台（洛雪 musicSdk：酷狗 / 酷我 / 咪咕 / QQ / 网易）
  streamSearch: (params) => ipcRenderer.invoke('stream:search', params),
  streamSongUrl: (params) => ipcRenderer.invoke('stream:songUrl', params),
  streamLyric: (params) => ipcRenderer.invoke('stream:lyric', params),
  streamGetPic: (params) => ipcRenderer.invoke('stream:getPic', params),
  streamCoverProxy: (url) => ipcRenderer.invoke('stream:coverProxy', url),
  streamHotSearch: (params) => ipcRenderer.invoke('stream:hotSearch', params),
  // 发现音乐：排行榜 / 歌单广场（V3.5.4）
  streamLeaderboards: (params) => ipcRenderer.invoke('stream:leaderboards', params),
  streamLeaderboardList: (params) => ipcRenderer.invoke('stream:leaderboardList', params),
  streamSongLists: (params) => ipcRenderer.invoke('stream:songLists', params),
  streamSongListDetail: (params) => ipcRenderer.invoke('stream:songListDetail', params),

  // 设置中心：版本 / 手动检查更新 / 外链 / 更新状态订阅
  appVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
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
  streamSourcesRemove: (params) => ipcRenderer.invoke('stream:sources:remove', params),
  streamSourcesSetEnabled: (params) => ipcRenderer.invoke('stream:sources:setEnabled', params),

  // 流媒体下载
  streamDownload: (params) => ipcRenderer.invoke('stream:download', params),
  streamDownloadDir: () => ipcRenderer.invoke('stream:downloadDir'),
  streamSetDownloadDir: () => ipcRenderer.invoke('stream:downloadDir:set'),
  streamResetDownloadDir: () => ipcRenderer.invoke('stream:downloadDir:reset'),
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

  // Pro beat0.0.1：假无损批量检测
  fakeScanBatchStart: (paths) => ipcRenderer.invoke('fakescan:batchStart', paths),
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
  dlyricsToggle: () => ipcRenderer.invoke('dlyrics:toggle'),
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

  // Pro beat0.0.1：诊断包导出（rendererSnapshot 为渲染侧设置/状态快照）
  diagExport: (rendererSnapshot) => ipcRenderer.invoke('diag:export', rendererSnapshot)
});
