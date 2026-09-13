'use strict';
// 安妮播放器 V1 预览版 (Annie Player V1 Preview) —— Electron 主进程
// 职责：窗口、引擎子进程生命周期、曲库/标签/歌词 IPC。

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads'); // EXP 7.28：曲库扫描 Worker
const { EngineClient } = require('./engineClient');
const library = require('./library');
const streaming = require('./streaming');
const analyzer = require('./analyzer');

const engine = new EngineClient();
let mainWindow = null;
let dlyrWinRef = null; // 桌面歌词窗引用（引擎事件分流用，由 registerIpc 内 dlyrics:toggle 维护）

/* 性能优化：引擎事件按窗口分流。实证 desktop-lyrics.html 只消费 dlyrics:line 中继，
 * 不订阅 engine-event；保留 position/state/ended 白名单兜底（歌词滚动需要），
 * level(~10Hz 频谱) 等高频事件不再发给桌面歌词窗。主窗全量不变。 */
const DLYR_ENGINE_EVENTS = new Set(['position', 'state', 'ended']);
engine.eventFilter = (win, event) => {
  if (dlyrWinRef && win === dlyrWinRef) return DLYR_ENGINE_EVENTS.has(event);
  return true;
};

// ---------- 流媒体图片 CDN 防盗链：按目标域注入 Referer ----------
function setupImageReferer() {
  const refererFor = (url) => {
    try {
      const h = new URL(url).hostname;
      if (h.endsWith('.126.net') || h.endsWith('.127.net') || h === 'music.163.com') return 'https://music.163.com/';
      if (h.endsWith('.gtimg.cn') || h.endsWith('.qq.com') || h.endsWith('.qqmusic.com')) return 'https://y.qq.com/';
    } catch { }
    return null;
  };
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const ref = refererFor(details.url);
    if (ref && details.resourceType === 'image') {
      details.requestHeaders.Referer = ref;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

/* ================= EXP 7.28：曲库扫描管理器（worker_threads） =================
 * 递归扫描/元数据解析全部在 scanWorker.js 线程内执行；
 * 主进程只收发消息。Worker 崩溃时自动重建 + 同步扫描兜底，绝不拖垮播放器。 */
let scanWorker = null;
let scanJobId = 0;
let scannedTracks = [];
const metaPending = new Map(); // jobId -> { out, resolve }
let metaJobSeq = 0;

function broadcastScan(payload) {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('scan:event', payload); } catch { }
}

/* SVLX 1.2.0：SACD ISO 分轨（sacd_extract 探测 → 虚拟分轨，播放时按需解轨为临时 DSF） */
const sacdIso = require('./sacdIso');
let isoProbeJobs = 0;      // 进行中的 ISO 探测数
let pendingScanDone = null; // ISO 探测未完成时暂存 done 事件
function finishScanIfReady() {
  if (!pendingScanDone || isoProbeJobs > 0) return;
  const m = pendingScanDone; pendingScanDone = null;
  try { saveStore({ tracks: scannedTracks }); } catch { }
  broadcastScan({ type: 'done', found: m.found });
}
async function probeIsos(isos) {
  isoProbeJobs++;
  try {
    const virtuals = [];
    for (const f of isos) {
      try {
        const info = await sacdIso.probe(f.path);
        const albumName = info.album || f.name.replace(/\.iso$/i, ''); // 无文本元数据的 ISO 用文件名兜底
        for (const tr of info.tracks) {
          virtuals.push({
            path: f.path + '#iso' + tr.no,
            name: (tr.title || ('Track ' + String(tr.no).padStart(2, '0'))) + '.dsf',
            dir: f.dir, size: f.size, mtime: f.mtime,
            iso: { src: f.path, no: tr.no, dur: tr.dur || 0 },
            cueMeta: { title: tr.title || ('Track ' + String(tr.no).padStart(2, '0')), artist: tr.performer || info.albumArtist || '', album: albumName }
          });
        }
      } catch { /* 非 SACD ISO 或探测失败：跳过 */ }
    }
    if (virtuals.length) {
      scannedTracks.push(...virtuals);
      try {
        const store = loadStore();
        let dirty = false;
        for (const t of virtuals) {
          store.metaCache[t.path] = { title: t.cueMeta.title, artist: t.cueMeta.artist, album: t.cueMeta.album, genre: '', year: 0, duration: t.iso.dur || 0 };
          dirty = true;
        }
        if (dirty) saveStore({ metaCache: store.metaCache });
      } catch { }
      broadcastScan({ type: 'cue', hidden: [], tracks: virtuals }); // 复用 CUE 事件通道（渲染层统一处理）
    }
  } catch { }
  isoProbeJobs--;
  finishScanIfReady();
}

function ensureScanWorker() {
  if (scanWorker) return scanWorker;
  try {
    scanWorker = new Worker(path.join(__dirname, 'scanWorker.js'));
  } catch (e) {
    console.error('[scan] Worker 创建失败，降级同步扫描:', e);
    scanWorker = null;
    return null;
  }
  scanWorker.on('message', (m) => {
    if (!m || !m.kind) return;
    if (m.kind === 'scan') {
      if (m.jobId !== scanJobId) return; // 过期任务结果丢弃
      if (m.type === 'batch') { scannedTracks.push(...m.tracks); broadcastScan({ type: 'batch', tracks: m.tracks, found: m.found }); }
      else if (m.type === 'cue') {
        // Pro beat0.0.1：CUE 分轨——隐藏整轨、追加虚拟分轨、写入分轨标签
        const hide = new Set(m.hidden || []);
        scannedTracks = scannedTracks.filter(t => !hide.has(t.path));
        scannedTracks.push(...(m.tracks || []));
        try {
          const store = loadStore();
          let dirty = false;
          for (const t of (m.tracks || [])) {
            if (!t.cueMeta) continue;
            store.metaCache[t.path] = { title: t.cueMeta.title || '', artist: t.cueMeta.artist || '', album: t.cueMeta.album || '', genre: '', year: 0 };
            dirty = true;
          }
          if (dirty) saveStore({ metaCache: store.metaCache });
        } catch { }
        broadcastScan({ type: 'cue', hidden: m.hidden, tracks: m.tracks });
      }
      else if (m.type === 'done') {
        pendingScanDone = m; // SVLX 1.2.0：等待进行中的 ISO 探测完成后再收尾
        finishScanIfReady();
      }
      else if (m.type === 'isoFound') {
        // SVLX 1.2.0：SACD ISO——主线程探测分轨（sacd_extract 不可用时静默跳过）
        if (sacdIso.available()) probeIsos(m.isos || []);
      }
      else if (m.type === 'cancelled') {
        try { saveStore({ tracks: scannedTracks }); } catch { } // 保留已扫到的部分
        broadcastScan({ type: 'cancelled', found: m.found });
      }
    } else if (m.kind === 'meta') {
      const p = metaPending.get(m.jobId);
      if (!p) return;
      if (m.type === 'metaBatch') Object.assign(p.out, m.out);
      else if (m.type === 'metaDone' || m.type === 'cancelled' || m.type === 'error') {
        metaPending.delete(m.jobId);
        p.resolve(p.out);
      }
    }
  });
  scanWorker.on('error', (e) => {
    console.error('[scan] Worker 异常:', e);
    broadcastScan({ type: 'error', message: 'scan-worker-crashed: ' + e.message });
    // 让挂起的 meta 请求走降级路径
    for (const [, p] of metaPending) p.resolve(null);
    metaPending.clear();
    try { scanWorker.terminate(); } catch { }
    scanWorker = null;
  });
  scanWorker.on('exit', () => { scanWorker = null; });
  return scanWorker;
}

/** 元数据解析走 Worker；Worker 不可用时返回 null，调用方降级为 library.readMetaBatch。 */
function metaViaWorker(paths) {
  return new Promise((resolve) => {
    const w = ensureScanWorker();
    if (!w) { resolve(null); return; }
    const jobId = ++metaJobSeq;
    metaPending.set(jobId, { out: {}, resolve });
    w.postMessage({ type: 'meta', jobId, paths });
    // 兜底超时：防止 Worker 卡死导致 metaBatch 永不返回
    setTimeout(() => {
      const p = metaPending.get(jobId);
      if (p) { metaPending.delete(jobId); p.resolve(p.out); }
    }, 120000);
  });
}

// ---------- 曲库持久化（userData/library.json） ----------
function storePath() { return path.join(app.getPath('userData'), 'library.json'); }

/* 性能优化：store 内存单例。启动后首次 loadStore 读盘一次，之后全部走内存；
 * saveStore 只做顶层浅合并 + 防抖 1500ms 原子落盘（临时文件 + rename），
 * 避免"任何小改动 = 全量读 + 全量写数 MB JSON"。 */
let _storeMem = null;
let _storeDirty = false;
let _storeTimer = null;

function loadStore() {
  if (_storeMem) return _storeMem;
  try {
    const s = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (!Array.isArray(s.favorites)) s.favorites = [];
    if (!Array.isArray(s.playlists)) s.playlists = []; // SVLX 1.3.0：自建播放列表 [{id,name,paths,created}]
    if (!s.metaCache || typeof s.metaCache !== 'object') s.metaCache = {};
    if (!s.stats || typeof s.stats !== 'object') s.stats = {}; // Pro beat0.0.1：播放统计
    _storeMem = s;
  }
  catch { _storeMem = { folders: [], tracks: [], volume: 1, backend: null, favorites: [], playlists: [], metaCache: {}, stats: {} }; }
  return _storeMem;
}

function flushStore() {
  if (!_storeDirty || !_storeMem) return;
  _storeDirty = false;
  clearTimeout(_storeTimer); _storeTimer = null;
  try {
    const p = storePath();
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_storeMem), 'utf8'); // 不缩进，省体积和序列化时间
    fs.renameSync(tmp, p); // 原子替换，避免写一半损坏 library.json
  } catch { }
}

function saveStore(patch) {
  const cur = loadStore();
  Object.assign(cur, patch); // 保持原语义：浅合并顶层键
  _storeDirty = true;
  clearTimeout(_storeTimer);
  _storeTimer = setTimeout(flushStore, 1500);
  if (_storeTimer.unref) _storeTimer.unref();
  return cur;
}

// 退出前强制落盘防抖窗口内的未保存变更
app.on('before-quit', () => { try { flushStore(); } catch { } });

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    backgroundColor: '#07080c',
    show: false,
    // 进程/任务栏图标（开发模式 electron.exe 默认图标需显式覆盖；打包后 exe 内嵌图标优先）
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 播放器后台/失焦时保持 rAF 渲染（歌词粒子/舞台动画不被节流冻结）
      backgroundThrottling: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- 系统托盘（Pro beat0.0.1：含迷你模式 / 桌面歌词入口） ----------
let tray = null;
function createTray() {
  // SVLX 融合：src/main.js 已创建托盘（图标路径已修），此处跳过避免通知栏双图标
  if (global.__svlxBoot) return;
  try {
    const { Tray, Menu, nativeImage } = require('electron');
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('安妮播放器Plus Pro');
    const send = (action) => { try { mainWindow?.webContents.send('tray:action', action); } catch { } };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { label: '播放 / 暂停', click: () => send('toggle') },
      { label: '上一首', click: () => send('prev') },
      { label: '下一首', click: () => send('next') },
      { type: 'separator' },
      { label: '迷你模式', click: () => send('mini') },
      { label: '桌面歌词', click: () => send('dlyrics') },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]));
    tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  } catch (e) { console.warn('[tray] 创建失败', e.message); }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('win:min', () => mainWindow?.minimize());
  ipcMain.handle('win:max', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.handle('win:close', () => mainWindow?.close());

  // EXP 7.28：选目录只更新文件夹列表，扫描交由 lib:scanStart（Worker 异步批量回传）
  ipcMain.handle('lib:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return loadStore();
    const store = loadStore();
    const folders = Array.from(new Set([...store.folders, ...r.filePaths]));
    return saveStore({ folders });
  });

  // EXP 7.28：移除文件夹即时生效（内存过滤，无需重扫磁盘）
  ipcMain.handle('lib:removeFolder', async (_e, folder) => {
    const store = loadStore();
    const folders = store.folders.filter(f => f !== folder);
    const norm = p => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '');
    const nf = norm(folder);
    const tracks = (store.tracks || []).filter(t => {
      const nd = norm(t.dir);
      return !(nd === nf || nd.startsWith(nf + '\\'));
    });
    return saveStore({ folders, tracks });
  });

  // EXP 7.28：Worker 扫描（批量回传 + 进度 + 可取消；Worker 不可用时同步兜底）
  ipcMain.handle('lib:scanStart', () => {
    const store = loadStore();
    const w = ensureScanWorker();
    if (!w) {
      const tracks = library.scanFolders(store.folders);
      saveStore({ tracks });
      broadcastScan({ type: 'done', found: tracks.length, fallback: true });
      return { ok: true, fallback: true };
    }
    scanJobId++;
    scannedTracks = [];
    w.postMessage({ type: 'cancel' }); // 终止上一个任务
    w.postMessage({ type: 'scan', jobId: scanJobId, folders: store.folders });
    return { ok: true, jobId: scanJobId };
  });
  ipcMain.handle('lib:scanCancel', () => {
    if (scanWorker) scanWorker.postMessage({ type: 'cancel' });
    return { ok: true };
  });
  // 兼容旧调用：重新扫描 = scanStart
  ipcMain.handle('lib:rescan', () => {
    const store = loadStore();
    const w = ensureScanWorker();
    if (w) {
      scanJobId++;
      scannedTracks = [];
      w.postMessage({ type: 'cancel' });
      w.postMessage({ type: 'scan', jobId: scanJobId, folders: store.folders });
      return { ok: true, jobId: scanJobId };
    }
    const tracks = library.scanFolders(store.folders);
    saveStore({ tracks });
    broadcastScan({ type: 'done', found: tracks.length, fallback: true });
    return { ok: true, fallback: true };
  });

  ipcMain.handle('lib:get', () => loadStore());

  // 喜爱列表：切换收藏状态，返回最新 favorites 数组
  ipcMain.handle('lib:toggleFavorite', (_e, trackPath) => {
    const store = loadStore();
    const favs = store.favorites;
    const i = favs.indexOf(trackPath);
    if (i >= 0) favs.splice(i, 1); else favs.push(trackPath);
    saveStore({ favorites: favs });
    return favs;
  });

  // SVLX 1.3.0：自建播放列表（Apple Music 主题使用；{id, name, paths[], created}）
  ipcMain.handle('lib:playlists', () => loadStore().playlists);
  ipcMain.handle('lib:playlist:create', (_e, name) => {
    const store = loadStore();
    const pl = {
      id: 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      name: String(name || '').trim() || '新建播放列表',
      paths: [],
      created: Date.now()
    };
    store.playlists.push(pl);
    saveStore({ playlists: store.playlists });
    return store.playlists;
  });
  ipcMain.handle('lib:playlist:rename', (_e, id, name) => {
    const store = loadStore();
    const pl = store.playlists.find(p => p.id === id);
    if (pl) { const n = String(name || '').trim(); if (n) pl.name = n; saveStore({ playlists: store.playlists }); }
    return store.playlists;
  });
  ipcMain.handle('lib:playlist:delete', (_e, id) => {
    const store = loadStore();
    saveStore({ playlists: store.playlists.filter(p => p.id !== id) });
    return loadStore().playlists;
  });
  ipcMain.handle('lib:playlist:add', (_e, id, paths) => {
    const store = loadStore();
    const pl = store.playlists.find(p => p.id === id);
    if (pl && Array.isArray(paths)) {
      for (const p of paths) if (typeof p === 'string' && !pl.paths.includes(p)) pl.paths.push(p);
      saveStore({ playlists: store.playlists });
    }
    return store.playlists;
  });
  ipcMain.handle('lib:playlist:remove', (_e, id, trackPath) => {
    const store = loadStore();
    const pl = store.playlists.find(p => p.id === id);
    if (pl) { pl.paths = pl.paths.filter(p => p !== trackPath); saveStore({ playlists: store.playlists }); }
    return store.playlists;
  });

  // 批量读取标签（排序用），结果写入 metaCache 持久化，避免重复解析
  // EXP 7.28：解析移交 scanWorker 线程；Worker 不可用时降级为主进程异步解析
  ipcMain.handle('lib:metaBatch', async (_e, paths) => {
    const store = loadStore();
    const cache = store.metaCache;
    const missing = paths.filter(p => !cache[p] && !p.includes('#cue') && !p.includes('#iso')); // Pro：CUE/ISO 虚拟分轨不触碰文件系统
    if (missing.length) {
      let fresh = await metaViaWorker(missing);
      if (!fresh) fresh = await library.readMetaBatch(missing);
      for (const [p, m] of Object.entries(fresh)) {
        if (m && m.ok) {
          cache[p] = { title: m.title, artist: m.artist, album: m.album, genre: m.genre || '', year: m.year || 0 };
        }
      }
      saveStore({ metaCache: cache });
    }
    const out = {};
    for (const p of paths) if (cache[p]) out[p] = cache[p];
    return out;
  });

  /* ---------------- Pro beat0.0.1：响度分析（EBU R128） ---------------- */
  const loudness = require('./loudness');
  function mergeLoudness(collected) {
    const s = loadStore();
    let dirty = false;
    for (const [p, v] of Object.entries(collected)) {
      s.metaCache[p] = { ...(s.metaCache[p] || {}), loudness: v };
      delete collected[p];
      dirty = true;
    }
    if (dirty) saveStore({ metaCache: s.metaCache });
  }
  ipcMain.handle('loudness:analyze', (_e, p) => loudness.analyzeTrack(p));
  ipcMain.handle('loudness:set', (_e, updates) => { mergeLoudness({ ...(updates || {}) }); return { ok: true }; });
  ipcMain.handle('loudness:batchStart', (_e, paths) => {
    const collected = {};
    loudness.batchStart(mainWindow, paths || [], (p, v) => {
      collected[p] = v;
      if (Object.keys(collected).length >= 20) mergeLoudness(collected); // 分批落盘
    }).then(() => mergeLoudness(collected));
    return { ok: true };
  });
  ipcMain.handle('loudness:batchCancel', () => { loudness.batchCancel(); return { ok: true }; });

  /* ---------------- Pro beat0.0.1：播放统计（防抖落盘） ---------------- */
  let statsDirty = false, statsTimer = null;
  function statsSaveSoon() {
    statsDirty = true;
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      if (!statsDirty) return;
      statsDirty = false;
      try { saveStore({ stats: statsMem }); } catch { }
    }, 5000);
  }
  const statsMem = loadStore().stats || {};
  ipcMain.handle('stats:count', (_e, p) => {
    const s = statsMem[p] || (statsMem[p] = { count: 0, lastPlayed: 0, totalSec: 0 });
    s.count++; s.lastPlayed = Date.now();
    statsSaveSoon();
    return { ok: true, count: s.count };
  });
  ipcMain.handle('stats:time', (_e, p, sec) => {
    const s = statsMem[p] || (statsMem[p] = { count: 0, lastPlayed: 0, totalSec: 0 });
    s.totalSec += Math.max(0, Math.min(sec || 0, 86400));
    statsSaveSoon();
    return { ok: true };
  });
  ipcMain.handle('stats:get', () => statsMem);

  /* ---------------- Pro beat0.0.1：假无损批量检测 + 报告导出 ---------------- */
  const fakeScan = require('./fakeScan');
  let fakeCollected = {}; // path -> 判定结果（供导出报告）
  ipcMain.handle('fakescan:batchStart', (_e, paths) => {
    fakeCollected = {};
    const collected = {};
    // 分批落盘（同 loudness 范式）：每首歌一次全量读写 library.json 是 O(N²) IO
    const flush = (obj) => {
      const keys = Object.keys(obj);
      if (!keys.length) return;
      const s = loadStore();
      for (const p of keys) {
        const v = obj[p];
        s.metaCache[p] = { ...(s.metaCache[p] || {}), fakeScan: { cutoff: v.cutoff, verdict: v.verdict, reason: v.reason } };
        delete obj[p];
      }
      saveStore({ metaCache: s.metaCache });
    };
    fakeScan.batchStart(mainWindow, paths || [], (p, v) => {
      collected[p] = v; fakeCollected[p] = v;
      if (Object.keys(collected).length >= 20) flush(collected);
    }).then(() => flush(collected));
    return { ok: true };
  });
  ipcMain.handle('fakescan:cancel', () => { fakeScan.batchCancel(); return { ok: true }; });
  ipcMain.handle('fakescan:export', async (_e, format, items) => {
    const { dialog } = require('electron');
    const isCsv = format === 'csv';
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出假无损检测报告',
      defaultPath: isCsv ? 'fakescan-report.csv' : 'fakescan-report.html',
      filters: [isCsv ? { name: 'CSV', extensions: ['csv'] } : { name: 'HTML', extensions: ['html'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    const content = isCsv ? fakeScan.buildCsv(items) : fakeScan.buildHtml(items);
    fs.writeFileSync(r.filePath, content, 'utf8');
    return { ok: true, path: r.filePath };
  });

  /* ---------------- Pro beat0.0.1：迷你模式（主窗口形态切换，位置记忆） ---------------- */
  let miniSaved = null, miniWasMax = false;
  ipcMain.handle('mini:enter', (_e, miniBounds) => {
    if (!mainWindow) return { ok: false };
    // 最大化窗口 setSize/setBounds 无效：先记录并退出最大化（修复：最大化进迷你变"全屏"）
    miniWasMax = mainWindow.isMaximized();
    if (!miniSaved) miniSaved = mainWindow.getNormalBounds();
    if (miniWasMax) mainWindow.unmaximize();
    mainWindow.setMinimumSize(360, 120);
    mainWindow.setAlwaysOnTop(true);
    // 记忆位置尺寸合法性钳制（防止历史异常值把迷你窗撑回大屏）
    if (miniBounds && miniBounds.width >= 360 && miniBounds.width <= 900 && miniBounds.height >= 120 && miniBounds.height <= 400)
      mainWindow.setBounds(miniBounds);
    else mainWindow.setSize(420, 150);
    return { ok: true };
  });
  ipcMain.handle('mini:exit', () => {
    if (!mainWindow) return { ok: false };
    const b = mainWindow.getBounds();
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(1120, 680);
    if (miniWasMax) mainWindow.maximize(); // 进入前是最大化 → 还原最大化
    else if (miniSaved) mainWindow.setBounds(miniSaved);
    miniSaved = null; miniWasMax = false;
    return { ok: true, miniBounds: b };
  });

  /* ---------------- Pro beat0.0.1：桌面歌词窗口 ---------------- */
  let dlyrWin = null;
  ipcMain.handle('dlyrics:toggle', () => {
    if (dlyrWin) { dlyrWin.close(); return { ok: true, shown: false }; }
    dlyrWin = new BrowserWindow({
      width: 760, height: 128, frame: false, transparent: true, resizable: true,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, minimizable: false, maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false
      }
    });
    dlyrWin.loadFile(path.join(__dirname, '..', 'renderer', 'desktop-lyrics.html'));
    dlyrWinRef = dlyrWin; // 供引擎事件分流识别
    dlyrWin.on('closed', () => { dlyrWin = null; dlyrWinRef = null; try { mainWindow?.webContents.send('dlyrics:closed'); } catch { } });
    return { ok: true, shown: true };
  });
  ipcMain.on('dlyrics:line', (_e, payload) => { try { dlyrWin?.webContents.send('dlyrics:line', payload); } catch { } });
  ipcMain.on('dlyrics:ctl', (_e, payload) => {
    if (!dlyrWin) return;
    if (payload.lock != null) dlyrWin.setIgnoreMouseEvents(!!payload.lock, { forward: true });
    if (payload.opacity != null) dlyrWin.setOpacity(Math.max(0.2, Math.min(1, payload.opacity)));
  });

  /* ---------------- Pro beat0.0.1：拖放展开（递归目录 → 音频文件列表） ---------------- */
  ipcMain.handle('drop:expand', (_e, paths) => {
    const AUDIO = new Set(['.flac', '.mp3', '.wav', '.ape', '.m4a', '.aac', '.alac', '.aiff', '.aif', '.ogg', '.opus', '.wma', '.dsf', '.dff', '.tta', '.wv', '.mka', '.mp2']);
    const out = [];
    const walk = (p, depth) => {
      if (depth > 10) return;
      let st; try { st = fs.statSync(p); } catch { return; }
      if (st.isDirectory()) {
        let ents; try { ents = fs.readdirSync(p); } catch { return; }
        for (const n of ents) walk(path.join(p, n), depth + 1);
        return;
      }
      if (AUDIO.has(path.extname(p).toLowerCase()))
        out.push({ path: p, name: path.basename(p), dir: path.dirname(p), size: st.size, mtime: st.mtimeMs });
    };
    for (const p of (paths || [])) walk(p, 0);
    out.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN-u-co-pinyin'));
    return out;
  });

  /* ---------------- Pro beat0.0.1：诊断包导出 ---------------- */
  ipcMain.handle('diag:export', async (_e, rendererSnapshot) => {
    const { dialog } = require('electron');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出诊断信息',
      defaultPath: 'annieplayer-diag-' + new Date().toISOString().slice(0, 10) + '.zip',
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };

    let devices = null;
    try { devices = await engine.call('devices.list', {}, 60000); } catch (e) { devices = { error: e.message }; }
    const store = loadStore();
    const settings = {
      folders: store.folders, volume: store.volume, backend: store.backend,
      trackCount: (store.tracks || []).length, renderer: rendererSnapshot || null
    };
    const info = {
      app: 'AnniePlayerPlusProVersion beta0.0.2',
      electron: process.versions.electron, node: process.versions.node,
      platform: process.platform + ' ' + process.arch,
      time: new Date().toISOString(),
      engineAlive: !!engine.proc
    };
    const { buildZip } = require('./diagZip');
    const zip = buildZip([
      { name: 'info.json', content: JSON.stringify(info, null, 2) },
      { name: 'devices.json', content: JSON.stringify(devices, null, 2) },
      { name: 'settings.json', content: JSON.stringify(settings, null, 2) },
      { name: 'engine-log.txt', content: engine.logRing.map(x => x.t + ' ' + x.line).join('\n') || '(空)' },
      { name: 'engine-errors.txt', content: engine.errorRing.map(x => x.t + ' ' + x.line).join('\n') || '(空)' },
    ]);
    fs.writeFileSync(r.filePath, zip);
    return { ok: true, path: r.filePath };
  });

  // Pro：CUE 虚拟分轨（路径含 #cueN）不读文件系统，直接由 metaCache 合成
  // SVLX 1.2.0：SACD ISO 虚拟分轨（路径含 #isoN）同样由 metaCache 合成
  ipcMain.handle('track:meta', async (_e, p) => {
    if (p.includes('#cue') || p.includes('#iso')) {
      const c = loadStore().metaCache[p] || {};
      return { ok: true, title: c.title || '', artist: c.artist || '', album: c.album || '', duration: c.duration || 0, cue: true };
    }
    /* 性能优化：metaCache 持久缓存命中（mtimeMs 校验）+ 封面内存 LRU 命中 → 直接返回，
     * 免重复 readMeta 整文件解析。旧版 metaBatch 写入的条目无 mtimeMs → 自动miss走解析。 */
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(p).mtimeMs; } catch { }
    const store = loadStore();
    const c = store.metaCache[p];
    if (c && mtimeMs && c.mtimeMs === mtimeMs) {
      const cover = library.getCachedCover(p, mtimeMs);
      if (cover !== undefined) {
        return {
          ok: true, title: c.title || '', artist: c.artist || '', album: c.album || '',
          genre: c.genre || '', year: c.year || 0, duration: c.duration || 0,
          codec: c.codec || '', sampleRate: c.sampleRate || 0, bitsPerSample: c.bitsPerSample || 0,
          bitrate: c.bitrate || 0, channels: c.channels || 0,
          fileSize: c.fileSize || 0, mtimeMs, cover
        };
      }
    }
    const meta = await library.readMeta(p);
    if (meta && meta.ok) {
      const mt = meta.mtimeMs || mtimeMs;
      library.setCachedCover(p, mt, meta.cover); // 封面 dataURL 体积大，只进内存 LRU，不写持久缓存
      store.metaCache[p] = {
        ...(store.metaCache[p] || {}), // 保留 loudness / fakeScan 等外部写入的字段
        title: meta.title, artist: meta.artist, album: meta.album,
        genre: meta.genre || '', year: meta.year || 0, duration: meta.duration || 0,
        codec: meta.codec || '', sampleRate: meta.sampleRate || 0, bitsPerSample: meta.bitsPerSample || 0,
        bitrate: meta.bitrate || 0, channels: meta.channels || 0,
        fileSize: meta.fileSize || 0, mtimeMs: mt
      };
      saveStore({ metaCache: store.metaCache });
    }
    return meta;
  });
  /* V3.1：批量完整 meta（FB2K 懒加载用，替代 40 次独立 track:meta IPC）。
   * 缓存逻辑与 track:meta 一致（metaCache mtime 校验 + 封面内存 LRU），
   * 未命中的批量解析（readMetaBatch 4 并发），封面只进内存 LRU。 */
  ipcMain.handle('lib:metaFullBatch', async (_e, paths) => {
    const store = loadStore();
    const out = {};
    const missing = [];
    for (const p of paths) {
      if (p.includes('#cue') || p.includes('#iso')) {
        const c = store.metaCache[p] || {};
        out[p] = { ok: true, title: c.title || '', artist: c.artist || '', album: c.album || '', duration: c.duration || 0, cue: true };
        continue;
      }
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(p).mtimeMs; } catch { }
      const c = store.metaCache[p];
      if (c && mtimeMs && c.mtimeMs === mtimeMs) {
        const cover = library.getCachedCover(p, mtimeMs);
        if (cover !== undefined) {
          out[p] = {
            ok: true, title: c.title || '', artist: c.artist || '', album: c.album || '',
            genre: c.genre || '', year: c.year || 0, duration: c.duration || 0,
            codec: c.codec || '', sampleRate: c.sampleRate || 0, bitsPerSample: c.bitsPerSample || 0,
            bitrate: c.bitrate || 0, channels: c.channels || 0,
            fileSize: c.fileSize || 0, mtimeMs, cover
          };
          continue;
        }
      }
      missing.push(p);
    }
    if (missing.length) {
      const fresh = await library.readMetaBatch(missing);
      for (const [p, meta] of Object.entries(fresh)) {
        if (meta && meta.ok) {
          const mt = meta.mtimeMs || 0;
          library.setCachedCover(p, mt, meta.cover);
          store.metaCache[p] = {
            ...(store.metaCache[p] || {}),
            title: meta.title, artist: meta.artist, album: meta.album,
            genre: meta.genre || '', year: meta.year || 0, duration: meta.duration || 0,
            codec: meta.codec || '', sampleRate: meta.sampleRate || 0, bitsPerSample: meta.bitsPerSample || 0,
            bitrate: meta.bitrate || 0, channels: meta.channels || 0,
            fileSize: meta.fileSize || 0, mtimeMs: mt
          };
        }
        out[p] = meta;
      }
      saveStore({ metaCache: store.metaCache });
    }
    return out;
  });
  ipcMain.handle('track:lyrics', (_e, p) => {
    const cut = p.includes('#cue') ? p.indexOf('#cue') : (p.includes('#iso') ? p.indexOf('#iso') : -1);
    return library.readLyrics(cut >= 0 ? p.slice(0, cut) : p);
  });
  ipcMain.handle('track:readFile', (_e, p) => {
    // Pro：CUE 虚拟分轨剥离 #cueN 后缀，读真实整轨文件
    const cut = p.includes('#cue') ? p.indexOf('#cue') : (p.includes('#iso') ? p.indexOf('#iso') : -1);
    const real = cut >= 0 ? p.slice(0, cut) : p;
    const buf = library.readFileBuffer(real);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  // SVLX 1.2.0：SACD ISO 按需解轨 → 临时 DSF（缓存命中直接返回）
  ipcMain.handle('iso:extractTrack', async (_e, params) => {
    try {
      if (!sacdIso.available()) return { ok: false, error: '缺少 sacd_extract.exe' };
      const cacheDir = path.join(app.getPath('userData'), 'isoCache');
      const dsf = await sacdIso.extractTrack(params.src, params.no, cacheDir);
      return { ok: true, path: dsf };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('settings:save', (_e, patch) => saveStore(patch));

  // 引擎直通
  ipcMain.handle('engine:call', (_e, method, params, timeoutMs) => engine.call(method, params || {}, timeoutMs || 60000));

  // 流媒体平台（洛雪 musicSdk：酷狗 / 酷我 / 咪咕 / QQ / 网易）
  ipcMain.handle('stream:search', (_e, params) => streaming.search(params));
  ipcMain.handle('stream:songUrl', (_e, params) => streaming.songUrl(params));
  ipcMain.handle('stream:lyric', (_e, params) => streaming.lyric(params));
ipcMain.handle('stream:getPic', (_e, params) => streaming.getPic(params));
ipcMain.handle('stream:coverProxy', (_e, url) => streaming.coverProxy(url));
ipcMain.handle('stream:hotSearch', (_e, params) => streaming.hotSearch(params));

  // —— 洛雪式音源管理（导入/删除/启停）——
  ipcMain.handle('stream:sources:list', () => streaming.sources.list());
  ipcMain.handle('stream:sources:import', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入洛雪音源脚本',
      filters: [{ name: '音源脚本', extensions: ['js'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    try {
      // V1.2.0 修复：importFromPath 已 async 化（Worker 沙箱验证），必须 await——
      // 否则返回的是未完成 Promise（UI 显示 undefined），且 refreshSources 抢在
      // 注册表写入前执行，导致"导入成功但列表仍显示未导入"
      return { canceled: false, source: await streaming.sources.importFromPath(r.filePaths[0]) };
    } catch (e) {
      return { canceled: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('stream:sources:remove', (_e, { id }) => streaming.sources.remove(id));
  ipcMain.handle('stream:sources:setEnabled', (_e, { id, enabled }) => streaming.sources.setEnabled(id, enabled));

  // —— 流媒体下载（进度事件推送渲染层）——
  ipcMain.handle('stream:download', async (e, params) => {
    try {
      return await streaming.download(params, (received, total) => {
        try { e.sender.send('stream:downloadProgress', { key: params._dlKey, received, total }); } catch { }
      });
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('stream:downloadDir', () => streaming.downloadDir());
  ipcMain.handle('stream:downloadDir:set', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载目录',
      defaultPath: streaming.downloadDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    return { canceled: false, dir: streaming.setDownloadDir(r.filePaths[0]) };
  });
  ipcMain.handle('stream:downloadDir:reset', () => streaming.setDownloadDir(''));

  // 音频分析（频谱图 / 波形 / 无损检测）
  analyzer.register(ipcMain, () => mainWindow);
}

// ---------- 生命周期 ----------
// SVLX 模式下跳过锁 + whenReady（已由 src/main.js 接管）
if (global.__svlxBoot) {
  registerIpc();
  streaming.init(app);
  setupImageReferer();
  engine.start();
  // 预热：引擎首次 devices.list 需 ~20s（WASAPI 枚举），后台预跑避免 UI 超时
  engine.call('devices.list', {}, 90000).catch(() => { });
  createWindow();
  global.__svlxAnnieOpen = () => {
    try { if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus(); } } catch { }
  };
  app.on('window-all-closed', () => {
    if (global.__svlxQuitting) { engine.stop(); app.quit(); }
  });
} else {
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    registerIpc();
    streaming.init(app); // 恢复流媒体登录态（userData/stream-cookies.json）
    setupImageReferer(); // 流媒体封面 CDN 防盗链 Referer 注入
    engine.start(); // 引擎拉起失败不阻塞 UI，调用时再报错
    // 预热：引擎首次 devices.list 需 ~20s（WASAPI 枚举），后台预跑避免 UI 超时
    engine.call('devices.list', {}, 90000).catch(() => { });
    createWindow();
    createTray(); // Pro beat0.0.1：系统托盘

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // SVLX 融合补丁：向启动器暴露“重开窗口”钩子（require 缓存导致再次进入时不会重跑 whenReady）
global.__svlxAnnieOpen = () => {
  try { if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus(); } } catch { }
};

app.on('window-all-closed', () => {
    // SVLX 融合补丁：启动器在场时，关窗回启动器而不是退出整个应用
    if (typeof global.__svlxOnAllClosed === 'function') { global.__svlxOnAllClosed(); return; }
    engine.stop();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => engine.stop());
}
} // end else (non-SVLX mode)
