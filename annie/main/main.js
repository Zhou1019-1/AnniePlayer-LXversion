'use strict';
// 安妮播放器 V1 预览版 (Annie Player V1 Preview) —— Electron 主进程
// 职责：窗口、引擎子进程生命周期、曲库/标签/歌词 IPC。

const { app, BrowserWindow, ipcMain, dialog, session, globalShortcut, nativeImage, shell } = require('electron');
// V4.4：Windows 原生遮挡检测（CalculateNativeWinOcclusion）会在全屏切换/窗口被遮挡后误判，
// 把渲染器 rAF 节流到 ~1fps——彩胶惯性旋转因此停死（视觉上只有表把/点击能动）。
// 在 app ready 前关闭遮挡与后台节流（webPreferences.backgroundThrottling:false 只管隐藏态）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads'); // EXP 7.28：曲库扫描 Worker
const { EngineClient } = require('./engineClient');
const library = require('./library');
const streaming = require('./streaming');
const onlineMatch = require('./onlineMatch');
const analyzer = require('./analyzer');
const tagWriter = require('./tagWriter'); // V3.5.9：曲库标签编辑（与下载写标签同一实现）
const qobuz = require('./qobuz'); // V4.3.6：Qobuz 在线播放/下载（用户登录自己的付费账号）
const amSrc = require('./streaming/am'); // V4.6：Apple Music 音源（章鱼解密链路）
const amWrapper = require('./amWrapper'); // V4.6：wrapper-lite 生命周期管理（登录/服务启停/状态）
const annieSourceHs = require('./annieSourceHandshake'); // V4.6：安妮音源心跳端点（音源仅可在安妮内运行）
const streamCache = require('./streamCache'); // V4.4：流媒体播放缓存（边播边存 + LRU 上限）
const dlManager = require('./dlManager'); // V4.3.22：下载任务管理器（下载情况视图）
const remote = require('./remote'); // V4.3.12：局域网手机遥控（脑暴 9.1）
const healthCheck = require('./healthCheck'); // V4.4.2：媒体库体检（H1-H9 + 修复撤销快照）
const backup = require('./backup'); // V4.4.2：备份 2.0（分内容导出/inspect/覆盖+合并 apply）
const trackMatcher = require('./trackMatcher'); // V4.4.2：五级匹配共享（.anniepl 导入 + 备份迁移二次匹配）

// V4.4.3 安全审计（P0）：主进程最后防线——任何未捕获异常/未处理 Promise 拒绝都先写环形缓冲
// （诊断包带出）再决定是否退出。流缓存等「本应静默」的异步错误此前会直接让整个播放器消失。
const processErrorRing = [];
function recordProcessError(kind, err) {
  try {
    const line = { t: new Date().toISOString(), kind, msg: (err && (err.stack || err.message)) || String(err) };
    processErrorRing.push(line);
    if (processErrorRing.length > 50) processErrorRing.shift();
    console.error('[uncaught]', kind, line.msg);
  } catch { }
}
process.on('uncaughtException', (err) => {
  recordProcessError('uncaughtException', err);
  // 不主动退出：Electron 主进程多数未捕获错误（流错误/IPC 处理器抛出）恢复性良好；
  // 真到了致命状态（句柄损坏）进程会自行崩，届时崩溃现场仍在系统错误日志里。
});
process.on('unhandledRejection', (reason) => {
  recordProcessError('unhandledRejection', reason);
});

const engine = new EngineClient();
let mainWindow = null;
let dlyrWinRef = null; // 桌面歌词窗引用（引擎事件分流用，由 registerIpc 内 dlyrics:toggle 维护）
let pendingInstall = false;   // V3.5.9：更新已下载待安装（选"稍后"后置位，关窗即触发安装）
let installQuitting = false;  // V3.5.9：quitAndInstall 强退流程防重入

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
let watchScanPending = false; // V4.3.10：当前 Worker 扫描任务来自文件监听（中间过程不广播进度）
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
  // V4.3.22：FPL 自动识别——扫描到媒体库内的 .fpl 即建/更新同名播放列表
  let fplStat = null;
  try { fplStat = syncFplPlaylists(m.fpls); } catch { }
  if (watchScanPending) {
    // V4.3.10：监听触发的扫描——不打扰进度 UI，只在完成后让渲染层全量刷新
    watchScanPending = false; libWatchRunning = false;
    broadcastScan({ type: 'done', found: m.found, fallback: true, watch: true, fpl: fplStat });
  } else {
    broadcastScan({ type: 'done', found: m.found, fpl: fplStat });
  }
}
/* V4.3.22：FPL 同步——播放列表条目用 fplPath 绑定来源文件，mtime 未变跳过，
 * 变化则整表替换 paths（在 fb2k 里改动后重新另存，安妮扫描时跟随更新） */
function syncFplPlaylists(fpls) {
  if (!Array.isArray(fpls) || !fpls.length) return null;
  const { parseFpl } = require('./fpl');
  const store = loadStore();
  const byFpl = new Map();
  for (const p of store.playlists) if (p.fplPath) byFpl.set(String(p.fplPath).toLowerCase(), p);
  let added = 0, updated = 0;
  for (const f of fpls) {
    if (!f || !f.path) continue;
    let paths;
    try { paths = parseFpl(fs.readFileSync(f.path), path.dirname(f.path)); } catch { continue; }
    if (!paths.length) continue;
    const existing = byFpl.get(String(f.path).toLowerCase());
    if (existing) {
      if (existing.fplMtime === f.mtime) continue;
      existing.paths = paths; existing.fplMtime = f.mtime; updated++;
    } else {
      let name = path.basename(f.path).replace(/\.fpl$/i, '') || 'FPL 导入';
      const names = new Set(store.playlists.map(p => p.name));
      const base = name; let n = 2;
      while (names.has(name)) name = base + ' (' + (n++) + ')';
      const pl = {
        id: 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        name, paths, created: Date.now(), fplPath: f.path, fplMtime: f.mtime || 0
      };
      store.playlists.push(pl); byFpl.set(String(f.path).toLowerCase(), pl); added++;
    }
  }
  if (added || updated) { saveStore({ playlists: store.playlists }); return { added, updated }; }
  return null;
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
            dir: f.dir, size: f.size, mtime: f.mtime, ctime: f.ctime,
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
      if (m.type === 'batch') { scannedTracks.push(...m.tracks); if (!watchScanPending) broadcastScan({ type: 'batch', tracks: m.tracks, found: m.found }); }
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
        if (!watchScanPending) broadcastScan({ type: 'cue', hidden: m.hidden, tracks: m.tracks }); // V4.3.10：监听扫描的中间过程不打扰渲染层，收尾 done(fallback) 统一刷新
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
        watchScanPending = false; libWatchRunning = false; // V4.3.10
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
    watchScanPending = false; libWatchRunning = false; // V4.3.10
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
    if (!Array.isArray(s.streamPlaylists)) s.streamPlaylists = []; // V4.3.5：在线歌单 [{id,name,items:[{provider,song,addedAt}],created}]
    if (!s.metaCache || typeof s.metaCache !== 'object') s.metaCache = {};
    if (!s.stats || typeof s.stats !== 'object') s.stats = {}; // Pro beat0.0.1：播放统计
    _storeMem = s;
  }
  catch { _storeMem = { folders: [], tracks: [], volume: 1, backend: null, favorites: [], playlists: [], streamPlaylists: [], metaCache: {}, stats: {} }; }
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
  } catch (e) {
    // V4.4：写失败必须恢复脏标记——否则 before-quit 兜底也不会再写，改动只活在内存
    _storeDirty = true;
    console.error('[store] flushStore 写盘失败（改动保留待重试）:', e && e.message);
  }
}

/* V4.3.10：直接改 store 对象后的落盘必须走 saveStore（置脏+防抖），
 * 否则 flushStore 见 _storeDirty=false 直接返回，改动只活在内存里、重启即丢。
 * （实锤 bug：关闭弹窗「以后都这样执行」重启后失效） */
function touchStore() { _storeDirty = true; }

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
  // V4.3.10：存量用户媒体库含盘符根目录 → 一次性提醒（整盘扫描+监听是卡死实锤来源）
  mainWindow.webContents.once('did-finish-load', () => {
    try {
      const st = loadStore();
      const roots = (st.folders || []).filter(isDriveRoot);
      if (!roots.length || (st.ui && st.ui.rootFolderWarned)) return;
      st.ui = st.ui || {}; st.ui.rootFolderWarned = true; touchStore(); flushStore();
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        dialog.showMessageBox(mainWindow, {
          type: 'warning', title: '媒体库包含整个盘符',
          message: '你的媒体库添加了整个盘符：' + roots.join('、'),
          detail: '整盘扫描和文件监听会覆盖盘上所有文件，曲库大时会明显卡顿甚至失去响应。' +
            '建议到 设置 → 媒体库 中移除它，改为添加盘上具体的音乐文件夹。（此提醒只出现一次）',
          buttons: ['知道了'], noLink: true,
        }).catch(() => { });
      }, 3000);
    } catch { }
  });
  /* V4.3：关闭按钮三选一——每次询问 / 最小化到托盘 / 直接退出。
   * 拦截 'close'：未记忆选择时弹原生对话框（带「以后都这样执行」勾选），
   * 记忆后按 store.ui.closeBehavior 直接执行；更新安装/托盘菜单退出等强退路径直接放行。 */
  mainWindow.on('close', (e) => {
    if (global.__svlxQuitting || pendingInstall) return;
    const st0 = loadStore();
    const ui0 = st0.ui || {};
    let behavior = ui0.closeBehavior;
    if (behavior !== 'tray' && behavior !== 'quit') behavior = ui0.closeToTray === true ? 'tray' : ''; // 旧设置迁移
    if (behavior === 'tray') { e.preventDefault(); mainWindow.hide(); return; }
    if (behavior === 'quit') return; // 放行，由 'closed' 完成退出
    e.preventDefault();
    const { dialog } = require('electron');
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '关闭 安妮播放器',
      message: '要最小化到系统托盘，还是彻底退出？',
      detail: '勾选「以后都这样执行」后不再询问，之后可在 设置 → 界面 中修改。',
      buttons: ['最小化到托盘', '彻底退出', '取消'],
      defaultId: 0, cancelId: 2, noLink: true,
      checkboxLabel: '以后都这样执行', checkboxChecked: false,
    }).then((r) => {
      if (!mainWindow || r.response === 2) return;
      const chosen = r.response === 0 ? 'tray' : 'quit';
      if (r.checkboxChecked) {
        const st = loadStore(); st.ui = st.ui || {}; st.ui.closeBehavior = chosen; touchStore(); flushStore();
        try { mainWindow.webContents.send('annie:closeBehaviorChanged', chosen); } catch { }
      }
      if (chosen === 'tray') mainWindow.hide();
      else { global.__svlxQuitting = true; try { mainWindow.close(); } catch { } }
    }).catch(() => { });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    /* V3.5.9：关窗退出逻辑（修复在线更新"无法关闭/装不上"根因）。
     * 旧行为：关窗后进程驻留托盘，__svlxQuitting 只有托盘"退出"菜单才置位 →
     *   ① NSIS 安装器 WM_CLOSE 关窗后进程不死 → "无法关闭"
     *   ② autoInstallOnAppQuit 等不到退出 → 已下载的更新永远装不上
     * 新行为：有待装更新（pendingInstall）或未开"驻留托盘"设置 → 关窗即完整退出。
     * V4.3：显式退出（对话框/托盘菜单）会置 __svlxQuitting，同样强制退出。 */
    const closeToTray = loadStore().ui && loadStore().ui.closeToTray === true;
    if (pendingInstall || !closeToTray || global.__svlxQuitting) {
      global.__svlxQuitting = true;
      try { app.quit(); } catch { }
    }
  });
  applyGlobalHotkeys();  // V3.5.8：全局快捷键
}

// 播控动作转发渲染层（全局快捷键/托盘共用通道；V3.5.15 移除任务栏缩略图按钮——Win11 不显示）
function sendPlayerAction(action) { try { mainWindow?.webContents.send('tray:action', action); } catch { } }
// SVLX 托盘（src/main.js）复用此通道发播控动作
global.__svlxPlayerAction = sendPlayerAction;

// ---------- V3.5.8：全局快捷键（媒体键 + Ctrl+Alt 组合；store.globalHotkeys=false 关闭） ----------
const HOTKEY_MAP = [
  ['MediaPlayPause', 'toggle'], ['MediaNextTrack', 'next'], ['MediaPreviousTrack', 'prev'],
  ['Ctrl+Alt+Space', 'toggle'], ['Ctrl+Alt+Right', 'next'], ['Ctrl+Alt+Left', 'prev'],
  ['Ctrl+Alt+Up', 'volup'], ['Ctrl+Alt+Down', 'voldn'],
];
let hotkeysOn = false;
function applyGlobalHotkeys() {
  try { globalShortcut.unregisterAll(); } catch { }
  hotkeysOn = false;
  if (loadStore().globalHotkeys === false) return;
  for (const [acc, act] of HOTKEY_MAP) {
    try { globalShortcut.register(acc, () => sendPlayerAction(act)); } catch { } // 被占用就跳过，不影响其他键
  }
  hotkeysOn = true;
}
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch { } });

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

// ---------- V3.5.8：媒体库文件夹监听（新增/删除音频文件自动增量入库，3s 防抖合并） ----------
let libWatchers = [], libWatchTimer = 0, libWatchRunning = false;
let lastWatchScanAt = 0; // V4.3.10：监听触发扫描的最小间隔（30s），防 IO 风暴反复拖库
// V4.3.10：盘符根目录（F:\ 这类）判定——整盘递归监听会接收全盘所有写事件，卡死主进程
function isDriveRoot(f) { return /^[a-zA-Z]:[\\/]?$/.test(String(f || '').trim()); }

function setupLibraryWatch() {
  for (const w of libWatchers) { try { w.close(); } catch { } }
  libWatchers = [];
  for (const f of (loadStore().folders || [])) {
    // V4.3.10：盘符根目录不挂监听（全盘事件洪峰会冲垮主进程），靠手动重扫
    if (isDriveRoot(f)) { console.warn('[lib] 跳过盘符根目录的文件监听:', f); continue; }
    try {
      const w = fs.watch(f, { recursive: true }, () => {
        clearTimeout(libWatchTimer);
        libWatchTimer = setTimeout(applyWatchChanges, 3000);
        if (libWatchTimer.unref) libWatchTimer.unref();
      });
      w.on('error', () => { });
      libWatchers.push(w);
    } catch { }
  }
}
function applyWatchChanges() {
  if (libWatchRunning) { // 上次扫描未完成：推迟再试
    clearTimeout(libWatchTimer);
    libWatchTimer = setTimeout(applyWatchChanges, 3000);
    return;
  }
  // V4.3.10：最小间隔 30s——目录频繁变动（下载中/其他程序写入）不至于连续全量重扫
  const elapsed = Date.now() - lastWatchScanAt;
  if (elapsed < 30000) {
    clearTimeout(libWatchTimer);
    libWatchTimer = setTimeout(applyWatchChanges, 30000 - elapsed);
    if (libWatchTimer.unref) libWatchTimer.unref();
    return;
  }
  libWatchRunning = true;
  lastWatchScanAt = Date.now();
  const store = loadStore();
  const w = ensureScanWorker();
  if (w) {
    // V4.3.10：全量 diff 扫描挪到 Worker（原来在主进程同步遍历整个媒体库，
    // 2 万首的库直接把主线程堵死 → Windows 判「应用程序挂起」强杀）
    watchScanPending = true;
    const prevJob = scanJobId; // V4.6.4：定点取消上一个扫描，不再用全局 cancel（会误杀 meta 任务）
    scanJobId++;
    scannedTracks = [];
    w.postMessage({ type: 'cancel', kind: 'scan', jobId: prevJob });
    w.postMessage({ type: 'scan', jobId: scanJobId, folders: store.folders });
    return; // 收尾在 Worker 'done'/'cancelled'/'error' 消息处（finishScanIfReady 等）
  }
  // Worker 不可用的同步兜底（极少见）：保留旧逻辑
  try {
    const fresh = library.scanFolders(store.folders || []);
    const oldPaths = new Set((store.tracks || []).map(t => t.path));
    const newPaths = new Set(fresh.map(t => t.path));
    const added = fresh.filter(t => !oldPaths.has(t.path)).length;
    const removed = (store.tracks || []).filter(t => !newPaths.has(t.path)).length;
    if (!added && !removed) return;
    saveStore({ tracks: fresh });
    broadcastScan({ type: 'done', found: fresh.length, fallback: true, watch: true, added, removed });
  } catch { } finally { libWatchRunning = false; }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('win:min', () => mainWindow?.minimize());
  ipcMain.handle('win:max', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.handle('win:close', () => mainWindow?.close());
  // V4.4：沉浸模式真全屏（隐藏任务栏）；退出全屏自动恢复之前的窗口边界
  ipcMain.handle('win:fullscreen', (_e, v) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isFullScreen() === !!v) return;
    mainWindow.setFullScreen(!!v);
  });

  // V3.5.8：全局快捷键开关（持久化在 store.globalHotkeys，默认开）
  ipcMain.handle('hotkeys:get', () => loadStore().globalHotkeys !== false);
  ipcMain.handle('hotkeys:setEnabled', (_e, on) => {
    saveStore({ globalHotkeys: !!on });
    applyGlobalHotkeys();
    return hotkeysOn;
  });
  // 渲染侧上报播放状态 → 窗口标题 + 托盘提示
  ipcMain.on('player:state', (_e, s) => {
    const st = { playing: !!(s && s.playing), title: String((s && s.title) || '').slice(0, 80) };
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(st.title ? st.title + ' · 安妮播放器' : '安妮播放器'); } catch { }
    try { if (tray) tray.setToolTip(st.title ? '安妮播放器 · ' + st.title : '安妮播放器'); } catch { }
  });
  // V3.5.18：渲染侧上报播放进度 → 任务栏图标进度条（ratio<0 清除；暂停显示暂停态）
  ipcMain.on('player:progress', (_e, p) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const r = p && Number(p.ratio);
      if (!isFinite(r) || r < 0) { mainWindow.setProgressBar(-1); return; }
      mainWindow.setProgressBar(Math.min(1, r), { mode: p.playing ? 'normal' : 'paused' });
    } catch { }
  });

  /* V4.4.7（PR#6）：SMTC 伴随进程（PowerShell + WinRT）。
     系统媒体浮层 / 壁纸媒体信息 / BetterLyrics 这类工具读的是 Windows 媒体会话（SMTC），
     本体音频走自研引擎（WASAPI 直出），而 Chromium 的 navigator.mediaSession 在 Electron 里
     不会桥到 SMTC；所以这里起一个隐藏的 PowerShell 常驻进程，自己持有静音 MediaPlayer +
     SystemMediaTransportControls，元数据由渲染层经 IPC 推过来。
     协议：每行一个 base64(UTF8 JSON)，避免控制台代码页把中文搞乱。 */
  const NL = String.fromCharCode(10);
  let smtcProc = null;
  let smtcAumidDone = false;
  /* V4.4.7：把会话 AUMID 注册进系统。
     系统的媒体浮层 / 壁纸引擎这类消费方会按会话的 SourceAppUserModelId 反查应用名和图标，
     查不到时整条会话可能被直接忽略（实测：BetterLyrics 认、壁纸引擎不认）。
     AnniePlayer.Fusion.SMTC 不是安装包注册的，这里补 DisplayName + IconUri（指向本体 exe）。 */
  function smtcRegisterAumid() {
    if (smtcAumidDone) return;
    smtcAumidDone = true;
    try {
      const { spawnSync } = require('child_process');
      const BS = String.fromCharCode(92);
      const key = 'HKCU' + BS + 'Software' + BS + 'Classes' + BS + 'AppUserModelId' + BS + 'AnniePlayer.Fusion.SMTC';
      spawnSync('reg', ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', '安妮播放器', '/f'], { windowsHide: true });
      spawnSync('reg', ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', process.execPath, '/f'], { windowsHide: true });
    } catch { }
  }
  function smtcEnsure() {
    if (smtcProc) return smtcProc;
    smtcRegisterAumid();
    try {
      /* 优先用编译版宿主（能接媒体键 / 浮层按钮）；没有 exe 才退回 PowerShell */
      const sdir = path.join(process.resourcesPath || '', 'smtc');
      const sexe = path.join(sdir, 'smtc-host.exe');
      if (fs.existsSync(sexe)) {
        const { spawn: sp2 } = require('child_process');
        smtcProc = sp2(sexe, ['-Silent', path.join(sdir, 'silent.wav'), '-ParentPid', String(process.pid)],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        try {
          smtcProc.stdout.on('data', (buf) => {
            const txt = buf.toString('utf8');
            if (txt.indexOf('"evt":"button"') >= 0 && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('smtc:button', txt);
            }
          });
        } catch { }
        smtcProc.on('exit', () => { smtcProc = null; });
        smtcProc.on('error', () => { smtcProc = null; });
        return smtcProc;
      }
    } catch { }
    try {
      const script = path.join(process.resourcesPath || '', 'smtc', 'smtc-host.ps1');
      if (!fs.existsSync(script)) return null;
      const { spawn } = require('child_process');
      smtcProc = spawn('powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      smtcProc.on('exit', () => { smtcProc = null; });
      smtcProc.on('error', () => { smtcProc = null; });
    } catch { smtcProc = null; }
    return smtcProc;
  }
  /* V4.4.7：手动拖窗口——顶栏是 app-region: drag，但格式胶囊改成 no-drag 才能点，
     所以长按胶囊时由渲染层推增量，这里移动窗口 */
  ipcMain.on('win:dragBy', (_e, d) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const dx = Math.round(Number(d && d.dx) || 0), dy = Math.round(Number(d && d.dy) || 0);
      if (!dx && !dy) return;
      const b = mainWindow.getBounds();
      mainWindow.setPosition(b.x + dx, b.y + dy);
    } catch { }
  });
  ipcMain.on('smtc:update', (_e, o) => {
    if (!o || o.off) {                       /* 设置里关掉：收掉会话 */
      try {
        if (smtcProc) {
          smtcProc.stdin.write(Buffer.from(JSON.stringify({ cmd: 'quit' }), 'utf8').toString('base64') + NL);
          smtcProc.kill();
        }
      } catch { }
      smtcProc = null;
      return;
    }
    const pr = smtcEnsure();
    if (!pr || !pr.stdin || pr.stdin.destroyed) return;
    try {
      const payload = {
        title: String((o && o.title) || '').slice(0, 120),
        artist: String((o && o.artist) || '').slice(0, 120),
        album: String((o && o.album) || '').slice(0, 120),
        playing: !!(o && o.playing),
        cover: String((o && o.cover) || '').slice(0, 2500000),
        pos: Number((o && o.pos) || 0),
        dur: Number((o && o.dur) || 0)
      };
      pr.stdin.write(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') + '\n');
    } catch { }
  });
  app.on('will-quit', () => {
    try {
      if (!smtcProc) return;
      smtcProc.stdin.write(Buffer.from(JSON.stringify({ cmd: 'quit' }), 'utf8').toString('base64') + '\n');
      smtcProc.kill();
    } catch { }
    smtcProc = null;
  });

  // EXP 7.28：选目录只更新文件夹列表，扫描交由 lib:scanStart（Worker 异步批量回传）
  ipcMain.handle('lib:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return loadStore();
    // V4.3.10：盘符根目录（F:\ 这类）警告——整盘递归扫描+监听极易卡死（实锤案例：2 万首库挂起强杀）
    const roots = r.filePaths.filter(isDriveRoot);
    if (roots.length) {
      const ans = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: '不建议添加盘符根目录',
        message: '你选择了整个盘符：' + roots.join('、'),
        detail: '把整个盘作为媒体库会导致扫描和文件监听覆盖全盘所有文件（包括系统和临时文件），' +
          '曲库很大时会明显卡顿甚至失去响应。\n\n强烈建议改为添加盘上具体的音乐文件夹。' +
          (r.filePaths.length > roots.length ? '\n其余选中的文件夹会正常添加。' : ''),
        buttons: ['仍要添加', '取消'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (ans.response === 1) r.filePaths = r.filePaths.filter(f => !isDriveRoot(f));
      if (!r.filePaths.length) return loadStore();
    }
    const store = loadStore();
    const folders = Array.from(new Set([...store.folders, ...r.filePaths]));
    const out = saveStore({ folders });
    setupLibraryWatch(); // V3.5.8：文件夹变更后重建监听
    return out;
  });

  // VST实验区：选择 .vst3 插件文件
  ipcMain.handle('vst:pickPlugin', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'VST3 插件', extensions: ['vst3'] }]
    });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });

  // V3.5.11：效果器方案导入/导出（.anniefx.json）
  ipcMain.handle('vst:presetExport', async (_e, json) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'annie-fx-preset.anniefx.json',
      filters: [{ name: '安妮效果器方案', extensions: ['anniefx.json', 'json'] }]
    });
    if (r.canceled || !r.filePath) return null;
    try { fs.writeFileSync(r.filePath, String(json || ''), 'utf8'); return r.filePath; }
    catch (ex) { throw new Error('写入失败：' + ex.message); }
  });
  ipcMain.handle('vst:presetImport', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: '安妮效果器方案', extensions: ['anniefx.json', 'json'] }]
    });
    if (r.canceled || !r.filePaths.length) return null;
    try { return fs.readFileSync(r.filePaths[0], 'utf8'); }
    catch (ex) { throw new Error('读取失败：' + ex.message); }
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
    const out = saveStore({ folders, tracks });
    setupLibraryWatch(); // V3.5.8
    return out;
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
    // V4.6.4：手动扫描若顶替了监听扫描，必须复位 watch 状态——否则本次进度事件被静默吞掉
    watchScanPending = false; libWatchRunning = false;
    const prevJob = scanJobId;
    scanJobId++;
    scannedTracks = [];
    w.postMessage({ type: 'cancel', kind: 'scan', jobId: prevJob }); // 定点终止上一个扫描任务
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
      watchScanPending = false; libWatchRunning = false; // V4.6.4：同 lib:scanStart，顶替监听扫描须复位
      const prevJob = scanJobId;
      scanJobId++;
      scannedTracks = [];
      w.postMessage({ type: 'cancel', kind: 'scan', jobId: prevJob });
      w.postMessage({ type: 'scan', jobId: scanJobId, folders: store.folders });
      return { ok: true, jobId: scanJobId };
    }
    const tracks = library.scanFolders(store.folders);
    saveStore({ tracks });
    broadcastScan({ type: 'done', found: tracks.length, fallback: true });
    return { ok: true, fallback: true };
  });

  ipcMain.handle('lib:get', () => loadStore());

  // V3.5.8：重复歌曲检测——按"规范化标题+艺人"分组（metaCache 无标签时回退文件名）
  ipcMain.handle('lib:duplicates', () => {
    const store = loadStore();
    const mc = store.metaCache || {};
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/[\s\-_·、,，.。!！?？'"\[\]（）()【】~～]/g, '');
    const groups = new Map();
    for (const t of (store.tracks || [])) {
      if (t.cue) continue; // CUE 虚拟分轨不参与查重
      const m = mc[t.path] || {};
      const title = norm(m.title) || norm(String(t.name || '').replace(/\.[^.]+$/, ''));
      if (!title) continue;
      const key = title + '|' + norm(m.artist);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        path: t.path, name: t.name, dir: t.dir, size: t.size || 0,
        title: m.title || '', artist: m.artist || '', album: m.album || '',
      });
    }
    const out = [];
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => b.size - a.size); // 组内按体积降序（最大者通常音质最好，默认保留）
      out.push(arr);
    }
    return out.sort((a, b) => b.length - a.length);
  });

  // V3.5.8：批量删除文件（移入回收站）并同步曲库/收藏
  // V4.3.22：顺带清理播放列表引用（删掉的文件不该在歌单里留尸）
  // V4.4.5：特权路径白名单——track:readFile / lib:deleteFiles 这类按路径操作磁盘的 IPC，
  // 只允许触碰「曲库文件夹内」或「曲库 tracks 列表里」的文件（后者兜住拖入曲库外文件的既有体验）。
  // 调用方经 preload 注入渲染层，渲染层被 XSS 污染时可任意传路径——这是纵深防御，不是修漏洞。
  // CUE/ISO 虚拟轨剥 #cueN/#isoN 后缀按真实容器校验。
  const VIRTUAL_PATH_RE = /#(cue|iso)\d+$/i;
  function pathAllowed(p) {
    try {
      let real = String(p == null ? '' : p).replace(VIRTUAL_PATH_RE, '');
      if (!real) return false;
      const norm = (s) => path.resolve(String(s)).replace(/[\\/]+$/, '');
      const rp = norm(real);
      const store = loadStore();
      for (const t of (store.tracks || [])) {
        if (t && t.path && norm(t.path).replace(VIRTUAL_PATH_RE, '') === rp) return true;
      }
      // 拖入的曲库外文件会进 playlists.paths（不一定进 tracks）——纳入白名单，别误伤其节拍分析/删除
      for (const pl of (store.playlists || [])) {
        for (const pp of ((pl && pl.paths) || [])) {
          if (pp && norm(pp).replace(VIRTUAL_PATH_RE, '') === rp) return true;
        }
      }
      for (const f of (store.folders || [])) {
        const root = norm(f);
        if (rp === root || rp.startsWith(root + path.sep)) return true;
      }
      return false;
    } catch { return false; }
  }

  ipcMain.handle('lib:deleteFiles', async (_e, paths) => {
    const done = [], failed = [];
    for (const p of (paths || [])) {
      // V4.4.5：曲库白名单——拒绝删除曲库目录外的任意文件（防渲染层被污染后乱删磁盘）
      if (!pathAllowed(p)) { failed.push({ path: p, error: 'not-in-library' }); continue; }
      try { await shell.trashItem(p); done.push(p); }
      catch (e) { failed.push({ path: p, error: String(e && e.message || e) }); }
    }
    if (done.length) {
      const store = loadStore();
      const del = new Set(done);
      for (const pl of store.playlists) pl.paths = pl.paths.filter(p => !del.has(p));
      saveStore({
        tracks: (store.tracks || []).filter(t => !del.has(t.path)),
        favorites: (store.favorites || []).filter(p => !del.has(p)),
        playlists: store.playlists,
      });
      broadcastScan({ type: 'done', found: (loadStore().tracks || []).length, fallback: true });
    }
    return { done, failed, playlists: loadStore().playlists };
  });

  // V4.3.22：仅从曲库移除显示（不动磁盘文件）——同步清理收藏/播放列表引用
  ipcMain.handle('lib:tracksHide', (_e, paths) => {
    const del = new Set(paths || []);
    const store = loadStore();
    if (del.size) {
      for (const pl of store.playlists) pl.paths = pl.paths.filter(p => !del.has(p));
      saveStore({
        tracks: (store.tracks || []).filter(t => !del.has(t.path)),
        favorites: (store.favorites || []).filter(p => !del.has(p)),
        playlists: store.playlists,
      });
      broadcastScan({ type: 'done', found: (loadStore().tracks || []).length, fallback: true });
    }
    return { removed: del.size, playlists: loadStore().playlists };
  });

  // 喜爱列表：切换收藏状态，返回最新 favorites 数组
  ipcMain.handle('lib:toggleFavorite', (_e, trackPath) => {
    const store = loadStore();
    const favs = store.favorites;
    const i = favs.indexOf(trackPath);
    if (i >= 0) favs.splice(i, 1); else favs.push(trackPath);
    saveStore({ favorites: favs });
    return favs;
  });

  // V4.3.22：播放列表拖拽排序——整表顺序回写（渲染层拖完一次性提交）
  ipcMain.handle('lib:playlist:reorder', (_e, id, paths) => {
    const store = loadStore();
    const pl = store.playlists.find(p => p.id === id);
    if (pl && Array.isArray(paths)) { pl.paths = paths.slice(); saveStore({ playlists: store.playlists }); }
    return store.playlists;
  });
  // V4.3.26：侧栏自建歌单长按拖拽排序——按 id 数组重排 playlists 顺序
  ipcMain.handle('lib:playlist:reorderList', (_e, ids) => {
    const store = loadStore();
    if (Array.isArray(ids)) {
      const byId = new Map(store.playlists.map(p => [p.id, p]));
      const next = [];
      ids.forEach(id => { if (byId.has(id)) { next.push(byId.get(id)); byId.delete(id); } });
      byId.forEach(p => next.push(p)); // 兜底：不在 ids 里的排末尾（防数据丢失）
      store.playlists = next;
      saveStore({ playlists: store.playlists });
    }
    return store.playlists;
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
  ipcMain.handle('lib:playlist:add', async (_e, id, paths, before, sort) => {
    const store = loadStore();
    const pl = store.playlists.find(p => p.id === id);
    if (pl && Array.isArray(paths)) {
      const add = [];
      for (const p of paths) if (typeof p === 'string' && !pl.paths.includes(p) && add.indexOf(p) < 0) add.push(p);
      if (add.length) {
        // V4.4：资源管理器多选拖入顺序无序——sort=true 时先按曲目号（回退自然文件名）排序再插入
        if (sort) {
          try {
            const r = await library.orderAudioPaths(add, store.metaCache);
            add.length = 0; r.paths.forEach(p => add.push(p));
            if (r.filled && Object.keys(r.filled).length) {
              for (const [p, f] of Object.entries(r.filled)) {
                store.metaCache[p] = { ...(store.metaCache[p] || {}), track: f.track, disc: f.disc };
              }
              saveStore({ metaCache: store.metaCache });
            }
          } catch (e) { console.error('[playlist] 拖入排序失败，按原始顺序加入:', e); }
        }
        // before=目标行路径时插到该行前（拖文件指定落点），否则追加到底部
        const at = (typeof before === 'string') ? pl.paths.indexOf(before) : -1;
        if (at >= 0) pl.paths.splice(at, 0, ...add); else pl.paths.push(...add);
        saveStore({ playlists: store.playlists });
      }
    }
    return store.playlists;
  });
  ipcMain.handle('lib:playlist:remove', (_e, id, trackPath) => {
    const store = loadStore();
    const pl = store.playlists.find(p => p.id === id);
    if (pl) { pl.paths = pl.paths.filter(p => p !== trackPath); saveStore({ playlists: store.playlists }); }
    return store.playlists;
  });

  // V4.3.22：导入 foobar2000 .fpl 播放列表——二进制解析（./fpl.js），每个文件建一个本地播放列表
  ipcMain.handle('lib:playlist:importFpl', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入 foobar2000 播放列表',
      filters: [{ name: 'foobar2000 播放列表', extensions: ['fpl'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const { parseFpl } = require('./fpl');
    const store = loadStore();
    const results = [];
    for (const fp of r.filePaths) {
      let paths;
      try { paths = parseFpl(fs.readFileSync(fp), path.dirname(fp)); }
      catch (e) { results.push({ file: fp, ok: false, error: String((e && e.message) || e) }); continue; }
      if (!paths.length) { results.push({ file: fp, ok: false, error: '未解析到本地文件路径' }); continue; }
      // 名称去重：与现有列表重名时追加序号
      let name = path.basename(fp).replace(/\.fpl$/i, '') || 'FPL 导入';
      const names = new Set(store.playlists.map(p => p.name));
      const base = name; let n = 2;
      while (names.has(name)) name = base + ' (' + (n++) + ')';
      // 绑定 fplPath：扫描到同一文件时更新本列表而不是重复新建
      let fm = 0; try { fm = fs.statSync(fp).mtimeMs; } catch { }
      store.playlists.push({
        id: 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        name, paths, created: Date.now(), fplPath: fp, fplMtime: fm
      });
      results.push({ file: fp, ok: true, name, count: paths.length });
    }
    saveStore({ playlists: store.playlists });
    return { canceled: false, results, playlists: loadStore().playlists };
  });

  // V4.4.6：导入 M3U/M3U8 播放列表——文本解析（./m3u.js），每个文件建一个本地播放列表
  ipcMain.handle('lib:playlist:importM3u', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入 M3U 播放列表',
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u', 'm3u8'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const { parseM3u } = require('./m3u');
    const store = loadStore();
    const results = [];
    for (const fp of r.filePaths) {
      let paths;
      try { paths = parseM3u(fs.readFileSync(fp), path.dirname(fp)); }
      catch (e) { results.push({ file: fp, ok: false, error: String((e && e.message) || e) }); continue; }
      if (!paths.length) { results.push({ file: fp, ok: false, error: '未解析到本地文件路径' }); continue; }
      let name = path.basename(fp).replace(/\.(m3u8?)$/i, '') || 'M3U 导入';
      const names = new Set(store.playlists.map(p => p.name));
      const base = name; let n = 2;
      while (names.has(name)) name = base + ' (' + (n++) + ')';
      store.playlists.push({
        id: 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        name, paths, created: Date.now(), m3uPath: fp
      });
      results.push({ file: fp, ok: true, name, count: paths.length });
    }
    saveStore({ playlists: store.playlists });
    return { canceled: false, results, playlists: loadStore().playlists };
  });
  /* V4.3.25：自建歌单导出 / 导入（换机复现；导出 .anniepl——JSON 载体，
   * 每首带多指纹：绝对路径、相对媒体库根路径、文件名、大小、时长、标题/艺人。
   * 导入在目标机曲库内 5 级降级匹配，未命中曲目随结果返回，前端列清单告知。
   * V4.4.2：匹配器抽至 trackMatcher.js 共享（备份迁移二次匹配同用），行为不变。 */
  const normPlPath = trackMatcher.normPlPath;
  const matchImportedTracks = (pkg, store) => trackMatcher.matchTracks(pkg.tracks, store);

  ipcMain.handle('lib:playlist:exportFile', async (_e, id) => {
    const store = loadStore();
    const pl = (store.playlists || []).find(p => p.id === id);
    if (!pl) return { ok: false, reason: '播放列表不存在' };
    const safeName = (pl.name || 'playlist').replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出播放列表「' + pl.name + '」',
      defaultPath: safeName + '.anniepl',
      filters: [{ name: '安妮播放列表', extensions: ['anniepl'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    try {
      const folders = (store.folders || []).map(f => String(f || '').replace(/[\\/]+$/, ''));
      const metas = store.metaCache || {};
      const tracks = [];
      for (const p0 of (pl.paths || [])) {
        if (typeof p0 !== 'string') continue;
        let rel = '';
        const np = normPlPath(p0);
        for (const f0 of folders) {
          if (np.indexOf(normPlPath(f0) + '\\') === 0) { rel = p0.slice(f0.length).replace(/^[\\/]+/, ''); break; }
        }
        const m = metas[p0] || {};
        tracks.push({
          path: p0,
          file: path.basename(p0.replace(/#(cue|iso)\d+$/i, '')),
          rel,
          title: m.title || '', artist: m.artist || '', album: m.album || '',
          duration: m.duration || 0, size: m.fileSize || 0
        });
      }
      fs.writeFileSync(r.filePath, JSON.stringify({
        kind: 'annie-playlist', version: 1, name: pl.name,
        app: app.getName(), appVer: app.getVersion(), time: new Date().toISOString(),
        folders, tracks
      }, null, 2), 'utf8');
      return { ok: true, path: r.filePath, count: tracks.length };
    } catch (e) { return { ok: false, reason: e.message }; }
  });

  ipcMain.handle('lib:playlist:importFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入安妮播放列表',
      filters: [{ name: '安妮播放列表', extensions: ['anniepl'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const store = loadStore();
    const names = new Set((store.playlists || []).map(p => p.name));
    const results = [];
    for (const fp of r.filePaths) {
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(fp, 'utf8')); }
      catch (e) { results.push({ file: fp, ok: false, error: '文件解析失败：' + e.message }); continue; }
      if (!pkg || pkg.kind !== 'annie-playlist' || !Array.isArray(pkg.tracks)) {
        results.push({ file: fp, ok: false, error: '不是有效的安妮播放列表文件（.anniepl）' }); continue;
      }
      const mr = matchImportedTracks(pkg, store);
      let name = String(pkg.name || path.basename(fp).replace(/\.anniepl$/i, '') || '').trim() || '导入的播放列表';
      const base = name; let n = 2;
      while (names.has(name)) name = base + ' (' + (n++) + ')';
      names.add(name);
      const npl = {
        id: 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        name, paths: mr.matched, created: Date.now(), importedFrom: fp
      };
      store.playlists.push(npl);
      results.push({
        id: npl.id, file: fp, ok: true, name,
        total: pkg.tracks.length, matched: mr.matched.length, missing: mr.missing
      });
    }
    saveStore({ playlists: store.playlists });
    return { canceled: false, results, playlists: loadStore().playlists };
  });

  /* V4.3.26：在线歌单导出 / 导入（.anniespl——JSON 载体，存 {provider, song 快照, addedAt}）。
   * 流媒体曲目不依赖本地文件：provider + 平台 ID（songmid/hash/trackId）跨机直接有效，
   * 导入即原样灌回，联网拉源即可播放，无需匹配本机曲库。 */
  ipcMain.handle('spl:exportFile', async (_e, id) => {
    const store = loadStore();
    const pl = (store.streamPlaylists || []).find(p => p.id === id);
    if (!pl) return { ok: false, reason: '在线歌单不存在' };
    const safeName = (pl.name || 'playlist').replace(/[\\/:*?"<>|]/g, '_');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出在线歌单「' + pl.name + '」',
      defaultPath: safeName + '.anniespl',
      filters: [{ name: '安妮在线歌单', extensions: ['anniespl'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify({
        kind: 'annie-stream-playlist', version: 1, name: pl.name,
        app: app.getName(), appVer: app.getVersion(), time: new Date().toISOString(),
        items: (pl.items || []).map(it => ({ provider: it.provider, song: it.song, addedAt: it.addedAt }))
      }, null, 2), 'utf8');
      return { ok: true, path: r.filePath, count: (pl.items || []).length };
    } catch (e) { return { ok: false, reason: e.message }; }
  });

  ipcMain.handle('spl:importFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入安妮在线歌单',
      filters: [{ name: '安妮在线歌单', extensions: ['anniespl'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const store = loadStore();
    const names = new Set((store.streamPlaylists || []).map(p => p.name));
    const results = [];
    for (const fp of r.filePaths) {
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(fp, 'utf8')); }
      catch (e) { results.push({ file: fp, ok: false, error: '文件解析失败：' + e.message }); continue; }
      if (!pkg || pkg.kind !== 'annie-stream-playlist' || !Array.isArray(pkg.items)) {
        results.push({ file: fp, ok: false, error: '不是有效的安妮在线歌单文件（.anniespl）' }); continue;
      }
      let name = String(pkg.name || path.basename(fp).replace(/\.anniespl$/i, '') || '').trim() || '导入的在线歌单';
      const base = name; let n = 2;
      while (names.has(name)) name = base + ' (' + (n++) + ')';
      names.add(name);
      // 逐条过 splNormalize 校验 + 同歌单内去重
      const seen = new Set(); const items = [];
      for (const raw of pkg.items) {
        const it = splNormalize(raw && raw.song ? Object.assign({}, raw.song, { provider: raw.provider || raw.song.provider }) : raw);
        if (!it) continue;
        if (raw && raw.addedAt) it.addedAt = raw.addedAt;
        const k = splItemKey(it);
        if (seen.has(k)) continue;
        seen.add(k); items.push(it);
      }
      const npl = {
        id: 'spl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        name, items, created: Date.now(), importedFrom: fp
      };
      store.streamPlaylists.push(npl);
      results.push({ id: npl.id, file: fp, ok: true, name, total: pkg.items.length, imported: items.length });
    }
    saveStore({ streamPlaylists: store.streamPlaylists });
    return { canceled: false, results, playlists: loadStore().streamPlaylists };
  });

  // V4.3.5：在线歌单（流媒体收藏）——items 存 {provider, song, addedAt}；
  // song 为洛雪 lx-sdk 原始曲目对象（含平台 ID/meta），播放地址每次现解析，不落盘 URL
  const splItemKey = (it) => {
    const s = (it && it.song) || {};
    return (it && it.provider || '') + '|' + String(s.songmid || s.id || s.hash || s.rid ||
      ((s.name || '') + '|' + (s.artist || '') + '|' + (s.duration || '')));
  };
  const splNormalize = (song) => {
    if (!song || typeof song !== 'object' || !song.provider) return null;
    return { provider: String(song.provider), song, addedAt: Date.now() };
  };
  ipcMain.handle('spl:list', () => loadStore().streamPlaylists);
  ipcMain.handle('spl:create', (_e, name) => {
    const store = loadStore();
    const pl = {
      id: 'spl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      name: String(name || '').trim() || '新建在线歌单',
      items: [],
      created: Date.now()
    };
    store.streamPlaylists.push(pl);
    saveStore({ streamPlaylists: store.streamPlaylists });
    return store.streamPlaylists;
  });
  ipcMain.handle('spl:rename', (_e, id, name) => {
    const store = loadStore();
    const pl = store.streamPlaylists.find(p => p.id === id);
    if (pl) { const n = String(name || '').trim(); if (n) { pl.name = n; saveStore({ streamPlaylists: store.streamPlaylists }); } }
    return store.streamPlaylists;
  });
  ipcMain.handle('spl:delete', (_e, id) => {
    const store = loadStore();
    saveStore({ streamPlaylists: store.streamPlaylists.filter(p => p.id !== id) });
    return loadStore().streamPlaylists;
  });
  ipcMain.handle('spl:add', (_e, id, songs) => {
    const store = loadStore();
    const pl = store.streamPlaylists.find(p => p.id === id);
    let added = 0;
    if (pl && Array.isArray(songs)) {
      const keys = new Set(pl.items.map(splItemKey));
      for (const raw of songs) {
        const it = splNormalize(raw);
        if (!it) continue;
        const k = splItemKey(it);
        if (keys.has(k)) continue; // 同平台同曲去重
        keys.add(k); pl.items.push(it); added++;
      }
      if (added) saveStore({ streamPlaylists: store.streamPlaylists });
    }
    return { playlists: store.streamPlaylists, added };
  });
  ipcMain.handle('spl:remove', (_e, id, indexes) => {
    const store = loadStore();
    const pl = store.streamPlaylists.find(p => p.id === id);
    if (pl && Array.isArray(indexes)) {
      const del = new Set(indexes.filter(i => Number.isInteger(i)));
      pl.items = pl.items.filter((_, i) => !del.has(i));
      saveStore({ streamPlaylists: store.streamPlaylists });
    }
    return store.streamPlaylists;
  });

  // V4.4：节拍分析落盘缓存（beat-cache.json，LRU 300 条，写 800ms 防抖合并）
  // 键 = 曲路径（stage-adapter 传入 String(path)）；值 = {map, at}，map 为节拍图原始 JSON
  let beatCache = null;
  let beatCacheTimer = null;
  const beatCacheFile = () => path.join(app.getPath('userData'), 'beat-cache.json');
  function loadBeatCache() {
    if (beatCache) return beatCache;
    try { beatCache = JSON.parse(fs.readFileSync(beatCacheFile(), 'utf8')); } catch (e) { beatCache = {}; }
    if (!beatCache || typeof beatCache !== 'object') beatCache = {};
    return beatCache;
  }
  function saveBeatCache() {
    clearTimeout(beatCacheTimer);
    beatCacheTimer = setTimeout(() => {
      try {
        const c = loadBeatCache();
        const keys = Object.keys(c);
        if (keys.length > 300) { // LRU：按最后访问时间删最旧
          keys.sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
          for (const k of keys.slice(0, keys.length - 300)) delete c[k];
        }
        require('./jsonFile').writeJsonAtomic(beatCacheFile(), c);
      } catch (e) { }
    }, 800);
  }
  ipcMain.handle('beatCache:get', (_e, key) => {
    const c = loadBeatCache();
    const it = c[String(key || '')];
    if (!it || !it.map) return { hit: false };
    it.at = Date.now(); saveBeatCache();
    return { hit: true, map: it.map };
  });
  ipcMain.handle('beatCache:set', (_e, key, map) => {
    if (!key || !map) return { ok: false };
    const c = loadBeatCache();
    c[String(key)] = { map: map, at: Date.now() };
    saveBeatCache();
    return { ok: true };
  });

  // V4.4：在文件管理器中定位（粒子舞台曲目右键菜单）
  ipcMain.handle('shell:showItem', (_e, p) => { try { shell.showItemInFolder(String(p || '')); } catch { } return { ok: true }; });

  // 批量读取标签（排序用），结果写入 metaCache 持久化，避免重复解析
  // EXP 7.28：解析移交 scanWorker 线程；Worker 不可用时降级为主进程异步解析
  ipcMain.handle('lib:metaBatch', async (_e, paths) => {
    const store = loadStore();
    const cache = store.metaCache;
    // V4.3.16：旧缓存里的 .wav 条目可能是乱码（wv 标记 <2 均为旧逻辑产物），强制重解析
    const missing = paths.filter(p => (!cache[p] || (p.toLowerCase().endsWith('.wav') && cache[p].wv !== 2)) && !p.includes('#cue') && !p.includes('#iso')); // Pro：CUE/ISO 虚拟分轨不触碰文件系统
    if (missing.length) {
      let fresh = await metaViaWorker(missing);
      if (!fresh) fresh = await library.readMetaBatch(missing);
      for (const [p, m] of Object.entries(fresh)) {
        if (m && m.ok) {
          cache[p] = { ...(cache[p] || {}), title: m.title, artist: m.artist, album: m.album, genre: m.genre || '', year: m.year || 0, track: m.track || '', disc: m.disc || '', ...(p.toLowerCase().endsWith('.wav') ? { wv: 2 } : {}) };
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

  /* ---------------- V4.3.16：BPM 落盘（渲染层 music-tempo 分析后回写，供相似推荐） ---------------- */
  ipcMain.handle('bpm:set', (_e, updates) => {
    const s = loadStore();
    let dirty = false;
    for (const [p, v] of Object.entries(updates || {})) {
      if (typeof v !== 'number') continue;
      s.metaCache[p] = { ...(s.metaCache[p] || {}), bpm: v };
      dirty = true;
    }
    if (dirty) saveStore({ metaCache: s.metaCache });
    return { ok: true };
  });

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

  /* ---------------- 假无损批量检测 + 报告导出（V4.0.5：不再落盘/打标，结果仅出报告） ---------------- */
  const fakeScan = require('./fakeScan');
  ipcMain.handle('fakescan:batchStart', (_e, paths) => {
    fakeScan.batchStart(mainWindow, paths || [], () => { });
    return { ok: true };
  });
  // 文件夹/单曲检测：系统对话框选目标，文件夹递归枚举音频文件
  ipcMain.handle('fakescan:pickFolder', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(mainWindow, { title: '选择要检测的文件夹', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'canceled' };
    const AUDIO_EXT = /\.(flac|wav|ape|aiff?|alac|tta|wv|dsf|dff|m4a|mp3|aac|ogg|opus|wma)$/i;
    const found = [];
    (function walk(dir) {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (AUDIO_EXT.test(e.name)) found.push(p);
      }
    })(r.filePaths[0]);
    return { ok: true, dir: r.filePaths[0], paths: found };
  });
  ipcMain.handle('fakescan:pickFile', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择要检测的音频文件', properties: ['openFile'],
      filters: [{ name: '音频文件', extensions: ['flac', 'wav', 'ape', 'aif', 'aiff', 'alac', 'tta', 'wv', 'dsf', 'dff', 'm4a', 'mp3', 'aac', 'ogg', 'opus', 'wma'] }]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'canceled' };
    return { ok: true, paths: [r.filePaths[0]] };
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
  let miniSaved = null, miniWasMax = false, miniActive = false, miniHideBound = false;
  /* V4.4：迷你模式下点 ✕ 收进托盘后，用户从托盘再打开期望看到主界面而不是迷你窗。
   * 窗口 hide 时若仍处于迷你形态：先抓取当前迷你 bounds（位置记忆），隐藏状态下还原置顶/
   * 最小尺寸/正常 bounds（不可见，无闪窗），最大化形态延迟到下次 show 时恢复（隐藏中
   * maximize 在部分 Windows 环境不可靠），再通知渲染层拆掉迷你 UI。miniActive 同步复位，
   * 与 mini:exit 路径互斥。最小化按钮（minimize）不触发 hide，任务栏恢复仍是迷你——符合预期。
   * 惰性绑定：registerIpc 执行早于主窗口创建，mainWindow 此时为 null。 */
  function bindMiniHideWatch(win) {
    if (miniHideBound || !win) return;
    miniHideBound = true;
    win.on('hide', () => {
      if (!win || win.isDestroyed?.() || !miniActive) return;
      let miniBounds = null;
      try { miniBounds = win.getBounds(); } catch { }
      const wasMax = miniWasMax;
      try {
        win.setAlwaysOnTop(false);
        win.setMinimumSize(1120, 680);
        if (!wasMax && miniSaved) win.setBounds(miniSaved);
      } catch { }
      miniActive = false; miniSaved = null; miniWasMax = false;
      if (wasMax) {
        const maxOnShow = () => { try { win.maximize(); } catch { } win.removeListener('show', maxOnShow); };
        win.on('show', maxOnShow);
      }
      try { win.webContents.send('mini:hiddenToTray', { ok: true, miniBounds }); } catch { }
    });
  }
  ipcMain.handle('mini:enter', (_e, miniBounds) => {
    if (!mainWindow) return { ok: false };
    bindMiniHideWatch(mainWindow);
    // 最大化窗口 setSize/setBounds 无效：先记录并退出最大化（修复：最大化进迷你变"全屏"）
    miniWasMax = mainWindow.isMaximized();
    if (!miniSaved) miniSaved = mainWindow.getNormalBounds();
    if (miniWasMax) mainWindow.unmaximize();
    mainWindow.setMinimumSize(360, 120);
    mainWindow.setAlwaysOnTop(true);
    miniActive = true;
    // 记忆位置尺寸合法性钳制（防止历史异常值把迷你窗撑回大屏）
    if (miniBounds && miniBounds.width >= 360 && miniBounds.width <= 900 && miniBounds.height >= 120 && miniBounds.height <= 400)
      mainWindow.setBounds(miniBounds);
    else mainWindow.setSize(420, 150);
    return { ok: true };
  });
  // AM 迷你界面：歌词/队列面板展开时动态调整窗口高度（仅迷你模式内有效）
  ipcMain.handle('mini:setSize', (_e, w, h) => {
    if (!mainWindow || !miniActive) return { ok: false };
    w = Math.round(Math.min(Math.max(w || 360, 320), 520));
    h = Math.round(Math.min(Math.max(h || 156, 120), 760));
    const b = mainWindow.getBounds();
    mainWindow.setBounds({ x: b.x, y: b.y, width: w, height: h });
    return { ok: true };
  });
  ipcMain.handle('mini:exit', () => {
    if (!mainWindow) return { ok: false };
    const b = mainWindow.getBounds();
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(1120, 680);
    miniActive = false;
    if (miniWasMax) mainWindow.maximize(); // 进入前是最大化 → 还原最大化
    else if (miniSaved) mainWindow.setBounds(miniSaved);
    miniSaved = null; miniWasMax = false;
    return { ok: true, miniBounds: b };
  });
  // V3.5.15：迷你模式一键置顶开关（默认置顶，📌 可临时取消；退出迷你强制恢复非置顶）
  ipcMain.handle('mini:pin', (_e, on) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    mainWindow.setAlwaysOnTop(!!on);
    return { ok: true, on: !!on };
  });

  /* ---------------- Pro beat0.0.1：桌面歌词窗口 ---------------- */
  let dlyrWin = null;
  let dlyrCompatCur = false; // 当前桌面歌词窗是否为兼容模式（不透明）
  function openDlyrWin() {
    const lbSt = loadStore();
    const lb = lbSt.ui && lbSt.ui.dlyrBounds; // V4.3.13：位置/尺寸记忆（洛雪同款）
    // V4.3.13：兼容模式——transparent:true 在 Windows 高 DPI（scaleFactor≠1）下走 WS_EX_LAYERED，
    // 命中测试坐标错位，鼠标事件整个进不了窗口（Electron/Chromium 未解 bug，洛雪同病）。
    // 兼容模式改全不透明窗口（setOpacity 也会加 LAYERED，同样禁用，见 dlyrics:ctl），鼠标 100% 可靠。
    const dlyrCompat = !!(lbSt.ui && lbSt.ui.dlyrCompat);
    dlyrCompatCur = dlyrCompat;
    dlyrWin = new BrowserWindow({
      width: (lb && lb.w) || 760, height: (lb && lb.h) || 128,
      x: lb && Number.isFinite(lb.x) ? lb.x : undefined,
      y: lb && Number.isFinite(lb.y) ? lb.y : undefined,
      frame: false, transparent: !dlyrCompat, resizable: true,
      backgroundColor: dlyrCompat ? '#0b0e17' : undefined,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, minimizable: false, maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false
      }
    });
    dlyrWin.loadFile(path.join(__dirname, '..', 'renderer', 'desktop-lyrics.html'));
    dlyrWinRef = dlyrWin; // 供引擎事件分流识别
    // V4.3.13：拖动/缩放后存 bounds（防抖落盘走 store 惯例：touchStore + 防抖 flush）
    let dlyrBoundsT = null;
    const saveBounds = () => {
      if (!dlyrWin || dlyrWin.isDestroyed()) return;
      const b = dlyrWin.getBounds();
      const s2 = loadStore();
      s2.ui = s2.ui || {}; s2.ui.dlyrBounds = { x: b.x, y: b.y, w: b.width, h: b.height };
      touchStore();
      clearTimeout(dlyrBoundsT); dlyrBoundsT = setTimeout(() => flushStore(), 800);
    };
    dlyrWin.on('moved', saveBounds);
    dlyrWin.on('resized', saveBounds);
    dlyrWin.on('closed', () => { dlyrWin = null; dlyrWinRef = null; try { mainWindow?.webContents.send('dlyrics:closed'); } catch { } });
  }
  ipcMain.handle('dlyrics:toggle', () => {
    if (dlyrWin) { dlyrWin.close(); return { ok: true, shown: false }; }
    openDlyrWin();
    return { ok: true, shown: true };
  });
  // V4.3.13：兼容模式开关（设置页）——transparent 只能创建时定，开关后重建窗口
  ipcMain.handle('dlyrics:setCompat', (_e, v) => {
    const s2 = loadStore();
    s2.ui = s2.ui || {}; s2.ui.dlyrCompat = !!v;
    touchStore(); flushStore();
    if (dlyrWin && !dlyrWin.isDestroyed()) { dlyrWin.close(); setTimeout(openDlyrWin, 200); }
    return { ok: true };
  });
  ipcMain.handle('dlyrics:getCompat', () => { const s2 = loadStore(); return !!(s2.ui && s2.ui.dlyrCompat); });
  ipcMain.on('dlyrics:line', (_e, payload) => { try { dlyrWin?.webContents.send('dlyrics:line', payload); } catch { } });
  ipcMain.on('dlyrics:ctl', (_e, payload) => {
    if (!dlyrWin) return;
    if (payload.lock != null) {
      dlyrWin.setIgnoreMouseEvents(!!payload.lock, { forward: true });
    }
    // V4.3.13：兼容模式下禁用 setOpacity——它在 Windows 上同样通过 WS_EX_LAYERED 实现，
    // 会重新触发高 DPI 分层窗鼠标事件丢失 bug（实测 exstyle 0x00280108 仍带 LAYERED）
    if (payload.opacity != null && !dlyrCompatCur) dlyrWin.setOpacity(Math.max(0.2, Math.min(1, payload.opacity)));
    // V4.3.13：桌面歌词工具栏播放控制 → 转主窗口（复用遥控指令通道 remote:cmd）
    if (payload.cmd) { try { mainWindow?.webContents.send('remote:cmd', { cmd: payload.cmd }); } catch { } }
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
        out.push({ path: p, name: path.basename(p), dir: path.dirname(p), size: st.size, mtime: st.mtimeMs, ctime: (st.birthtimeMs || st.ctimeMs || st.mtimeMs) });
    };
    for (const p of (paths || [])) walk(p, 0);
    out.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN-u-co-pinyin'));
    return out;
  });

  // V4.4.1：拖入项分类——区分文件夹/音频文件，渲染层据此决定"建歌单"还是"加歌单"
  ipcMain.handle('drop:classify', (_e, paths) => {
    return (paths || []).map((p) => {
      let isDir = false, name = path.basename(String(p || ''));
      try { const st = fs.statSync(p); isDir = st.isDirectory(); name = path.basename(st.isDirectory() ? String(p).replace(/[\\/]+$/, '') : p); } catch { }
      return { path: p, name, isDirectory: isDir };
    });
  });

  /* ---------------- Pro beat0.0.1：诊断包导出 ---------------- */
  /* 渲染层 JS 错误环形缓冲（window.onerror / unhandledrejection 上报），随诊断包导出 */
  const rendererErrorRing = [];
  ipcMain.on('renderer-error', (_e, payload) => {
    try {
      const p = payload || {};
      rendererErrorRing.push({
        t: new Date().toISOString(),
        kind: String(p.kind || 'error').slice(0, 24),
        msg: String(p.msg || '').slice(0, 500),
        src: String(p.src || '').slice(0, 300),
        line: p.line | 0, col: p.col | 0
      });
      if (rendererErrorRing.length > 100) rendererErrorRing.shift();
    } catch { }
  });
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
      app: app.getName() + ' V' + app.getVersion(), // V4.3.16：原为 PlusPro 时代硬编码，诊断包无法区分版本
      electron: process.versions.electron, node: process.versions.node,
      platform: process.platform + ' ' + process.arch,
      time: new Date().toISOString(),
      engineAlive: !!engine.proc,
      engine: (() => { try { return engine.getDiagnostics(); } catch { return null; } })()
    };
    const { buildZip } = require('./diagZip');
    const zip = buildZip([
      { name: 'info.json', content: JSON.stringify(info, null, 2) },
      { name: 'devices.json', content: JSON.stringify(devices, null, 2) },
      { name: 'settings.json', content: JSON.stringify(settings, null, 2) },
      { name: 'engine-log.txt', content: engine.logRing.map(x => x.t + ' ' + x.line).join('\n') || '(空)' },
      { name: 'engine-errors.txt', content: engine.errorRing.map(x => x.t + ' ' + x.line).join('\n') || '(空)' },
      { name: 'renderer-errors.txt', content: rendererErrorRing.map(x => x.t + ' [' + x.kind + '] ' + x.msg + (x.src ? ' @ ' + x.src + ':' + x.line + ':' + x.col : '')).join('\n') || '(空)' },
      { name: 'engine-crash.log', content: (() => { // V3.5.16：引擎托管崩溃现场
          try {
            const p = path.join(process.env.LOCALAPPDATA || '', 'annie-player-svlx', 'engine-crash.log');
            if (!fs.existsSync(p)) return '(无)';
            const s = fs.readFileSync(p, 'utf8');
            return s.length > 30000 ? '...(截断)...\n' + s.slice(-30000) : s;
          } catch { return '(读取失败)'; }
        })() },
      { name: 'main-process-errors.txt', content: processErrorRing.map(x => x.t + ' [' + x.kind + '] ' + x.msg).join('\n') || '(空)' }, // V4.4.3：主进程未捕获异常兜底记录
    ]);
    fs.writeFileSync(r.filePath, zip);
    return { ok: true, path: r.filePath };
  });

  /* ---------------- 配置备份 2.0（V4.3.19 初版；V4.4.2 Slice B 升级：分内容导出 + 三步向导 + 覆盖/合并） ----------------
   * 导出：backup.js 按勾选项收 sections（tracks/metaCache 全量永不入备份，分析数据走白名单），
   *       schemaVersion:2 + counts + roots（路径公共前缀，供 Slice C 跨机重映射）。
   * 导入：pickInspect 只读出摘要 → apply 校验 → 现有 library.json 留 .bak 兜底 →
   *       按模式（覆盖/合并）写入 → flush → 渲染层 relaunch；合并口径见 backup.js 注释。
   * v1 老备份经 normalize 包成 v2 视图，走同一管线。 */
  ipcMain.handle('backup:estimate', (_e, listenStats) => {
    return backup.estimate(loadStore(), listenStats && typeof listenStats === 'object' ? listenStats : null);
  });
  ipcMain.handle('backup:export', async (_e, opts) => {
    const { dialog } = require('electron');
    flushStore(); // 防抖窗口内的改动先落盘
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出配置备份',
      defaultPath: 'annieplayer-backup-' + new Date().toISOString().slice(0, 10) + '.anniebak.json',
      filters: [{ name: '安妮播放器备份', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    try {
      const o = opts || {};
      const pkg = backup.buildPackage(loadStore(), {
        sections: Array.isArray(o.sections) && o.sections.length ? o.sections : null,
        listenStats: (o.listenStats && typeof o.listenStats === 'object') ? o.listenStats : null,
        appName: app.getName(), appVer: app.getVersion()
      });
      const json = JSON.stringify(pkg);
      fs.writeFileSync(r.filePath, json, 'utf8');
      return { ok: true, path: r.filePath, bytes: Buffer.byteLength(json, 'utf8'), counts: pkg.counts };
    } catch (e) { return { ok: false, reason: e.message }; }
  });
  // 向导第 1 步：选文件 + 只读摘要（不应用）
  ipcMain.handle('backup:pickInspect', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入配置备份',
      filters: [{ name: '安妮播放器备份', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'canceled' };
    const fp = r.filePaths[0];
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const pkg = JSON.parse(raw);
      const summary = backup.inspectPackage(pkg, Buffer.byteLength(raw, 'utf8'));
      summary.path = fp;
      return summary;
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
  });
  // 向导第 2 步（Slice C）：路径重映射——选本机文件夹（不改媒体库，与 lib:pickFolder 区分）
  ipcMain.handle('backup:pickDir', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择本机对应的音乐文件夹',
      properties: ['openDirectory']
    });
    return (r.canceled || !r.filePaths[0]) ? null : r.filePaths[0];
  });
  // roots 可达性 + 映射后预估匹配数（rootMap: { 备份根: 本机根 }）
  ipcMain.handle('backup:rootCheck', async (_e, opts) => {
    const o = opts || {};
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(String(o.path || ''), 'utf8')); }
    catch (e) { return { ok: false, reason: '读取备份文件失败：' + e.message }; }
    try {
      const view = backup.normalize(pkg);
      return Object.assign({ ok: true }, backup.rootCheck(view, o.rootMap || {}));
    } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
  });
  // 向导第 3 步：应用（覆盖/合并 + 内容勾选 + 可选 rootMap 路径重映射）
  ipcMain.handle('backup:apply', async (_e, opts) => {
    const o = opts || {};
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(String(o.path || ''), 'utf8')); }
    catch (e) { return { ok: false, reason: '读取备份文件失败：' + e.message }; }
    let view;
    try { view = backup.normalize(pkg); }
    catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    // Slice C：导入前先做路径前缀替换（歌单/收藏/统计/分析键一并改写）
    const rootMap = (o.rootMap && typeof o.rootMap === 'object') ? o.rootMap : {};
    const remapped = backup.remapViewPaths(view, rootMap);
    const sp = storePath();
    try { fs.copyFileSync(sp, sp + '.bak-' + Date.now()); } catch { } // 导入前兜底
    const store = loadStore();
    const res = backup.applyToStore(store, view, { mode: o.mode, sections: o.sections });
    // 曲库索引为空且有媒体库文件夹（典型：换机/重装后导入）→ 重启后自动重扫一次
    const needRescan = !(store.tracks || []).length && (store.folders || []).length > 0;
    store._pendingRescan = needRescan ? { time: Date.now(), reason: 'backup-import' } : null;
    // Slice C：重启后二次匹配——扫描完成后对死路径跑五级兜底，把残留死链换新机路径
    // 向导第 2 步「智能匹配兜底」勾选才挂（默认勾）；纯前缀映射已 100% 的场景不挂也行，留着幂等
    const hasPathSections = (o.sections || Object.keys(view.sections))
      .some((s) => ['folders', 'favorites', 'playlists', 'stats', 'analysis'].includes(s));
    store._pendingMigration = (hasPathSections && o.smartMatch !== false)
      ? { time: Date.now(), file: String(o.path || ''), rootMap, remapped } : null;
    touchStore(); flushStore();
    setupLibraryWatch(); // folders 可能已变
    return {
      ok: true, mode: res.mode, applied: res.applied, notes: res.notes,
      listenStats: res.listenStats, needsRescan: needRescan, remapped,
      ver: view.ver, time: view.time
    };
  });
  /* Slice C：重启后二次匹配（渲染层在扫描完成后调用）。
   * 读备份文件取指纹（analysis 段的 size/duration/title/artist），对本机曲库跑五级匹配，
   * 把歌单/收藏/统计/metaCache 里仍然死的路径换成新机路径；完成后清 _pendingMigration。 */
  ipcMain.handle('backup:rematch', async () => {
    const store = loadStore();
    const pm = store._pendingMigration;
    if (!pm || !pm.file) return { ok: false, reason: 'none' };
    let view;
    try { view = backup.normalize(JSON.parse(fs.readFileSync(pm.file, 'utf8'))); }
    catch (e) {
      // 备份文件被移动/删除：不等了，清标记放行（歌单里死链留给体检 H2/H3 处理）
      store._pendingMigration = null; touchStore(); flushStore();
      return { ok: false, reason: '备份文件不可用：' + e.message };
    }
    const rootMap = pm.rootMap || {};
    const analysis = view.sections.analysis || {};
    // 本机现存路径集合（归一化小写比较）
    const existSet = new Set((store.tracks || []).map((t) => trackMatcher.normPlPath(t.path)));
    const isAlive = (p) => existSet.has(trackMatcher.normPlPath(String(p || '').replace(/#(cue|iso)\d+$/i, '')));
    // 收集 store 里仍死的引用：{kind, ref} ref 视类型为歌单对象/索引/键名
    const dead = [];
    for (const pl of (store.playlists || [])) {
      (pl.paths || []).forEach((p, i) => { if (!isAlive(p)) dead.push({ kind: 'pl', pl, idx: i, path: p }); });
    }
    (store.favorites || []).forEach((p, i) => { if (!isAlive(p)) dead.push({ kind: 'fav', idx: i, path: p }); });
    for (const k of Object.keys(store.stats || {})) if (!isAlive(k)) dead.push({ kind: 'stats', key: k, path: k });
    for (const k of Object.keys(store.metaCache || {})) if (!isAlive(k)) dead.push({ kind: 'meta', key: k, path: k });
    const total = dead.length;
    if (!total) {
      store._pendingMigration = null; touchStore(); flushStore();
      return { ok: true, restored: 0, total: 0, missing: [] };
    }
    /* 构造指纹：死路径 → 反查备份原始路径（逆向 rootMap）→ analysis 段取 size/duration/title/artist。
     * 无 analysis 指纹时仍可按文件名/相对根匹配（五级①②④）。 */
    const reverseMap = {};
    for (const [from, to] of Object.entries(rootMap)) reverseMap[trackMatcher.normPlPath(to)] = from;
    const toOriginal = (p) => {
      const nl = trackMatcher.normPlPath(String(p || '').replace(/#(cue|iso)\d+$/i, ''));
      for (const [toLow, from] of Object.entries(reverseMap)) {
        if (nl === toLow) return from;
        if (nl.startsWith(toLow + '\\')) return from + String(p).slice(toLow.length);
      }
      return p;
    };
    const items = dead.map((d) => {
      const orig = toOriginal(d.path);
      const a = analysis[orig] || analysis[String(d.path)] || {};
      let rel = '';
      const nl = trackMatcher.normPlPath(orig);
      for (const root of (view.roots || [])) {
        const rl = trackMatcher.normPlPath(root);
        if (nl.indexOf(rl + '\\') === 0) { rel = String(orig).slice(String(root).length).replace(/^[\\/]+/, ''); break; }
      }
      const base = String(orig).replace(/#(cue|iso)\d+$/i, '').split(/[\\/]/).pop();
      return { path: orig, file: base, rel, size: a.fileSize || 0, duration: a.duration || 0, title: a.title || '', artist: a.artist || '' };
    });
    const mr = trackMatcher.matchTracks(items, store);
    // 命中回写：perItem 与 dead 按下标一一对齐（null = 未匹配）
    let restored = 0;
    const missing = [];
    dead.forEach((d, i) => {
      const hit = mr.perItem[i];
      if (!hit) { missing.push({ path: d.path, title: items[i].title, artist: items[i].artist, file: items[i].file }); return; }
      restored++;
      if (d.kind === 'pl') d.pl.paths[d.idx] = hit;
      else if (d.kind === 'fav') store.favorites[d.idx] = hit;
      else if (d.kind === 'stats') {
        // 目标键已有统计（同曲另一份记录）时按合并口径相加，不覆盖
        if (store.stats[hit]) {
          const cur = store.stats[hit], inc = store.stats[d.key] || {};
          for (const [k, v] of Object.entries(inc)) {
            if (typeof v === 'number') cur[k] = k === 'lastPlayed' ? Math.max(cur[k] || 0, v) : (cur[k] || 0) + v;
            else if (cur[k] === undefined) cur[k] = v;
          }
        } else store.stats[hit] = store.stats[d.key];
        delete store.stats[d.key];
      }
      else if (d.kind === 'meta') {
        // 本机重扫产生的新条目为准（mtimeMs/fileSize 保鲜），备份侧只并入分析白名单字段（loudness/bpm 等）
        const base = store.metaCache[hit] || {};
        const inc = backup.pickAnalysisEntry(store.metaCache[d.key] || {});
        store.metaCache[hit] = Object.assign({}, base, inc);
        delete store.metaCache[d.key];
      }
    });
    store._pendingMigration = null;
    saveStore({
      playlists: store.playlists, favorites: store.favorites,
      stats: store.stats, metaCache: store.metaCache, _pendingMigration: null
    });
    flushStore();
    broadcastScan({ type: 'done', found: (store.tracks || []).length, fallback: true });
    return { ok: true, restored, total, missing };
  });
  /* V4.6.4：重启必须走完整退出链——旧实现 app.exit(0) 不触发 before-quit，
   * 跳过 flushStore（备份导入后重启恢复会丢未落盘数据）与引擎退出等待（AnnieEngine 孤儿）。
   * 现在：先同步落盘 → app.quit() 由 before-quit 拦截等引擎退出 → 最终 app.exit(0) 退出当前实例；
   * app.relaunch() 注册的新实例不受影响。 */
  ipcMain.handle('app:relaunch', () => {
    try { flushStore(); } catch { }
    app.relaunch();
    app.quit();
    return { ok: true };
  });

  /* ---------------- V4.4.2：媒体库体检（Slice A：H1-H9；只扫描出报告，修复须渲染层逐项确认） ----------------
   * 进度/结束走 health:event（对齐 fakescan 模式）；修复前生成撤销快照存 store.healthUndo，
   * 仅留最近一次；快照超 5MB 降级为返回 manifest 供渲染层导出 JSON 清单（不写撤销凭证）。 */
  const HEALTH_UNDO_MAX = 5 * 1024 * 1024;
  const coverCacheDir = () => path.join(app.getPath('userData'), 'covercache');
  ipcMain.handle('health:scan', (_e, opts) => {
    const o = opts || {};
    healthCheck.start(mainWindow, loadStore(), { deep: !!o.deep, coverCacheDir: o.deep ? coverCacheDir() : null });
    return { ok: true };
  });
  // Slice D·H12：清空封面磁盘缓存（纯缓存，删除安全，下次播放自动重建）
  ipcMain.handle('health:clearCoverCache', () => {
    const dir = coverCacheDir();
    let count = 0, bytes = 0;
    try {
      for (const fn of fs.readdirSync(dir)) {
        const fp = path.join(dir, fn);
        try { bytes += fs.statSync(fp).size; fs.unlinkSync(fp); count++; } catch { }
      }
    } catch { }
    // 清完重建内存索引（library 内部 coverDiskIndex 仍指向已删文件）
    library.initCoverDiskCache(dir);
    return { ok: true, count, bytes };
  });
  ipcMain.handle('health:cancel', () => { healthCheck.cancel(); return { ok: true }; });
  ipcMain.handle('health:fix', (_e, payload) => {
    const store = loadStore();
    let res;
    try { res = healthCheck.fix(store, payload || {}); }
    catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    // 撤销快照：新修复覆盖旧快照；超 5MB 不入库，降级清单导出
    const candidate = { time: new Date().toISOString(), actions: [res.snapshot] };
    let undoAvailable = false, snapshotTooLarge = false;
    try {
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > HEALTH_UNDO_MAX) {
        snapshotTooLarge = true;
        saveStore({ healthUndo: null });
      } else {
        saveStore({ healthUndo: candidate });
        undoAvailable = true;
      }
    } catch { snapshotTooLarge = true; }
    if (res.snapshot.type === 'pruneRefs') {
      saveStore({ playlists: store.playlists, favorites: store.favorites });
    } else if (res.snapshot.type === 'pruneOrphans') {
      saveStore({ stats: store.stats, metaCache: store.metaCache });
    } else if (res.snapshot.type === 'removeFolders') {
      saveStore({ folders: store.folders, tracks: store.tracks });
      setupLibraryWatch();
    }
    flushStore();
    // 曲库已变：fallback 通道让渲染层整体重拉 library（与 deleteFiles 同口径）
    broadcastScan({ type: 'done', found: (store.tracks || []).length, fallback: true });
    return {
      ok: true, action: res.snapshot.type, removed: res.removed, skipped: res.skipped,
      undoAvailable, snapshotTooLarge, manifest: snapshotTooLarge ? candidate : null
    };
  });
  ipcMain.handle('health:undo', () => {
    const store = loadStore();
    const r = healthCheck.undo(store);
    if (!r.ok) return r;
    saveStore({
      healthUndo: null,
      playlists: store.playlists, favorites: store.favorites,
      stats: store.stats, metaCache: store.metaCache,
      folders: store.folders, tracks: store.tracks
    });
    flushStore();
    setupLibraryWatch();
    broadcastScan({ type: 'done', found: (store.tracks || []).length, fallback: true });
    return r;
  });
  ipcMain.handle('health:undoInfo', () => {
    const u = loadStore().healthUndo;
    if (!u || !Array.isArray(u.actions) || !u.actions.length) return null;
    return { time: u.time || '', actions: u.actions.map((a) => a.type) };
  });
  // 导出最近一次体检的完整报告（明细不截断）
  ipcMain.handle('health:exportReport', async () => {
    const report = healthCheck.getLastReport();
    if (!report) return { ok: false, reason: '暂无体检报告，请先执行体检' };
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出媒体库体检报告',
      defaultPath: 'annie-health-report-' + new Date().toISOString().slice(0, 10) + '.json',
      filters: [{ name: 'JSON 清单', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(report, null, 2), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, reason: e.message }; }
  });
  // 通用 JSON 存档（撤销快照过大时的清单降级导出）
  ipcMain.handle('health:saveJson', async (_e, name, data) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出 JSON 清单',
      defaultPath: String(name || 'annie-health-list.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, reason: e.message }; }
  });

  // V4.3.18：封面磁盘缓存（头脑风暴 2.3），userData/covercache/，二次启动封面免整文件解析
  library.initCoverDiskCache(path.join(app.getPath('userData'), 'covercache'));

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
    // V4.3.16：.wav 旧缓存可能是乱码——wv 标记 <2 视为未命中，重走 readMeta（含 INFO 直读+仲裁）
    if (c && mtimeMs && c.mtimeMs === mtimeMs && (!p.toLowerCase().endsWith('.wav') || c.wv === 2)) {
      let cover = library.getCachedCover(p, mtimeMs);
      if (cover === undefined) { // V4.3.18：内存 LRU 未命中 → 磁盘缓存，仍免 readMeta
        cover = library.getDiskCover(p, mtimeMs);
        if (cover !== undefined) library.setCachedCover(p, mtimeMs, cover);
      }
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
      library.setCachedCover(p, mt, meta.cover); // 封面 dataURL 体积大，只进内存 LRU + 磁盘缓存，不写持久 metaCache
      library.setDiskCover(p, mt, meta.cover);
      store.metaCache[p] = {
        ...(store.metaCache[p] || {}), // 保留 loudness / fakeScan 等外部写入的字段
        title: meta.title, artist: meta.artist, album: meta.album,
        genre: meta.genre || '', year: meta.year || 0, duration: meta.duration || 0,
        codec: meta.codec || '', sampleRate: meta.sampleRate || 0, bitsPerSample: meta.bitsPerSample || 0,
        bitrate: meta.bitrate || 0, channels: meta.channels || 0,
        fileSize: meta.fileSize || 0, mtimeMs: mt,
        rg: meta.rg || null, // V3.5.15：ReplayGain 标签
        ...(p.toLowerCase().endsWith('.wav') ? { wv: 2 } : {}) // V4.3.16：WAV 标签已仲裁标记
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
      // V4.3.16：.wav 旧缓存可能是乱码——wv 标记 <2 视为未命中
      if (c && mtimeMs && c.mtimeMs === mtimeMs && (!p.toLowerCase().endsWith('.wav') || c.wv === 2)) {
        let cover = library.getCachedCover(p, mtimeMs);
        if (cover === undefined) { // V4.3.18：内存 LRU 未命中 → 磁盘缓存
          cover = library.getDiskCover(p, mtimeMs);
          if (cover !== undefined) library.setCachedCover(p, mtimeMs, cover);
        }
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
          library.setDiskCover(p, mt, meta.cover); // V4.3.18
          store.metaCache[p] = {
            ...(store.metaCache[p] || {}),
            title: meta.title, artist: meta.artist, album: meta.album,
            genre: meta.genre || '', year: meta.year || 0, duration: meta.duration || 0,
            codec: meta.codec || '', sampleRate: meta.sampleRate || 0, bitsPerSample: meta.bitsPerSample || 0,
            bitrate: meta.bitrate || 0, channels: meta.channels || 0,
            fileSize: meta.fileSize || 0, mtimeMs: mt,
            rg: meta.rg || null, // V3.5.15：ReplayGain 标签
            ...(p.toLowerCase().endsWith('.wav') ? { wv: 2 } : {}) // V4.3.16
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

  // V3.3.1：在线歌词/封面匹配（一期·单曲手动匹配）
  ipcMain.handle('match:search', (_e, params) => onlineMatch.searchCandidates(params || {}));
  ipcMain.handle('match:apply', (_e, params) => onlineMatch.applyMatch(params || {}));
  // V4.3.4：批量匹配歌词（≥80% 自动存旁挂 .lrc，进度经 match:batch:event 推送）
  ipcMain.handle('match:batchStart', (_e, paths, opts) => onlineMatch.batchStart(mainWindow, paths || [], opts || {}));
  ipcMain.handle('match:batchCancel', () => { onlineMatch.batchCancel(); return { ok: true }; });
  ipcMain.handle('match:autoLyric', (_e, p) => onlineMatch.autoLyric({ path: p })); // V4.4：播放时自动在线补歌词（仅回显不落盘）

  // V3.5.9：曲库标签编辑——选封面图 / 写回标签（ffmpeg 流复制，不重编码）
  ipcMain.handle('tag:pickCover', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });
  async function applyTagEdit(fp, fields, coverFile, clearEmpty) {
    fp = String(fp || '');
    if (!fp || fp.includes('#')) return { ok: false, reason: 'CUE/ISO 分轨不支持标签编辑' };
    let coverBytes = null;
    if (coverFile) { try { coverBytes = fs.readFileSync(coverFile); } catch { } }
    const f = fields || {};
    const r = await tagWriter.writeTags({
      dest: fp,
      title: f.title, artist: f.artist, album: f.album, albumArtist: f.albumArtist,
      track: f.track, disc: f.disc, date: f.date,
      genre: f.genre, composer: f.composer, comment: f.comment, publisher: f.publisher,
      coverBytes,
      clearEmpty: !!clearEmpty,
    }).catch((e) => ({ ok: false, reason: String(e && e.message || e) }));
    if (r && r.ok) {
      // 同步 metaCache（UI 立即反映；清掉封面缓存强制下次重新提取）
      const store = loadStore();
      const mc = Object.assign({}, store.metaCache[fp]);
      for (const k of ['title', 'artist', 'album', 'albumArtist', 'track', 'disc', 'date', 'genre', 'composer', 'comment', 'publisher']) {
        if (f[k] == null) continue;
        if (String(f[k]).trim()) mc[k] = String(f[k]).trim();
        else if (clearEmpty) delete mc[k];
      }
      if (coverBytes) delete mc.cover;
      store.metaCache[fp] = mc;
      saveStore({ metaCache: store.metaCache });
    }
    return r;
  }
  ipcMain.handle('tag:edit', (_e, p) => applyTagEdit(p && p.path, p || {}, p && p.coverFile, true)); // 手动编辑语义：清空字段 = 删除该标签
  // Track B：批量标签编辑——只写用户显式勾选的字段；空值/未勾选字段保留原标签
  ipcMain.handle('tag:editBatch', async (_e, p) => {
    const paths = Array.isArray(p && p.paths) ? p.paths : [];
    const fields = (p && p.fields) || {};
    const results = [];
    for (const fp of paths) {
      const r = await applyTagEdit(fp, fields, p && p.coverFile, false);
      results.push({ path: String(fp || ''), ok: !!(r && r.ok), reason: r && r.reason });
    }
    return { results };
  });
  ipcMain.handle('track:readFile', (_e, p) => {
    // Pro：CUE 虚拟分轨剥离 #cueN 后缀，读真实整轨文件
    const cut = p.includes('#cue') ? p.indexOf('#cue') : (p.includes('#iso') ? p.indexOf('#iso') : -1);
    const real = cut >= 0 ? p.slice(0, cut) : p;
    // V4.4.5：曲库白名单——拒绝读取曲库外任意文件内容（防渲染层被污染后外泄磁盘文件）
    if (!pathAllowed(p)) throw new Error('not-in-library');
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
  // V4.4.1：启动故障（缺 .NET/引擎 exe 被隔离等）后由用户显式触发重新检测
  ipcMain.handle('engine:retry', async () => {
    const ok = engine.retry();
    if (!ok) return { ok: false, failure: engine.startupFailure || null };
    try {
      await engine.call('engine.info', {}, 15000);
      return { ok: true };
    } catch (e) {
      return { ok: false, failure: engine.startupFailure || { kind: 'unknown', message: String((e && e.message) || e) } };
    }
  });
  ipcMain.handle('engine:status', () => engine.getDiagnostics());

  // 流媒体平台（洛雪 musicSdk：酷狗 / 酷我 / 咪咕 / QQ / 网易）
  ipcMain.handle('stream:search', (_e, params) => streaming.search(params));
  ipcMain.handle('stream:songUrl', (_e, params) => streaming.songUrl(params));
  ipcMain.handle('stream:lyric', (_e, params) => streaming.lyric(params));
ipcMain.handle('stream:getPic', (_e, params) => streaming.getPic(params));
ipcMain.handle('stream:coverProxy', (_e, url) => streaming.coverProxy(url));
ipcMain.handle('stream:hotSearch', (_e, params) => streaming.hotSearch(params));
ipcMain.handle('stream:hotComments', (_e, params) => streaming.hotComments(params)); // V3.5.19：网易云热门评论
// 发现音乐：排行榜 / 歌单广场（V3.5.4）
ipcMain.handle('stream:leaderboards', (_e, params) => streaming.leaderboards(params));
ipcMain.handle('stream:leaderboardList', (_e, params) => streaming.leaderboardList(params));
ipcMain.handle('stream:songLists', (_e, params) => streaming.songLists(params));
ipcMain.handle('stream:songListSearch', (_e, params) => streaming.songListSearch(params)); // V4.3.16：歌单关键词搜索
ipcMain.handle('stream:songListDetail', (_e, params) => streaming.songListDetail(params));
// V4.3：专辑搜索 / 专辑曲目
ipcMain.handle('stream:albumSearch', (_e, params) => streaming.albumSearch(params));
ipcMain.handle('stream:albumSongs', (_e, params) => streaming.albumSongs(params));

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
  // V4.3.12：局域网手机遥控 IPC
  function ensureRemoteCode(st) {
    st.remote = st.remote || {};
    if (!st.remote.code) { st.remote.code = String(Math.floor(1000 + Math.random() * 9000)); touchStore(); flushStore(); }
    return st.remote;
  }
  ipcMain.handle('remote:getInfo', async () => {
    const r = ensureRemoteCode(loadStore());
    const base = { enabled: !!r.enabled, code: r.code };
    return r.enabled ? Object.assign(base, remote.info()) : Object.assign(base, { ok: false, port: 0, addrs: [] });
  });
  ipcMain.handle('remote:setEnabled', async (_e, { enabled }) => {
    const r = ensureRemoteCode(loadStore());
    r.enabled = !!enabled; touchStore(); flushStore();
    if (enabled) await remote.start(); else remote.stop();
    return Object.assign({ enabled: !!enabled, code: r.code }, remote.info());
  });
  ipcMain.handle('remote:regenCode', async () => {
    const st = loadStore(); st.remote = st.remote || {};
    st.remote.code = String(Math.floor(1000 + Math.random() * 9000));
    st.remote.tokens = []; // 重置配对码同时踢掉所有已配对设备
    touchStore(); flushStore();
    return { code: st.remote.code };
  });
  ipcMain.on('remote:push', (_e, state) => { remote.pushState(state); });
  // 遥控二期（V4.3.18）：渲染层曲库快照 → 主进程内存，供手机端浏览点播
  ipcMain.on('remote:pushLib', (_e, list) => { remote.pushLibrary(list); });
  ipcMain.handle('stream:sources:importUrl', async (_e, { url }) => {
    try {
      return { canceled: false, source: await streaming.sources.importFromUrl(url) };
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

  // —— V4.3.22：下载任务管理器（洛雪式任务列表/并发/暂停继续，下载情况视图）——
  dlManager.init((ch, p) => {
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, p); } catch { }
  });
  ipcMain.handle('dl:list', () => dlManager.list());
  ipcMain.handle('dl:add', (_e, items) => dlManager.add(items));
  ipcMain.handle('dl:pause', (_e, id) => dlManager.pause(id));
  ipcMain.handle('dl:resume', (_e, id) => dlManager.resume(id));
  ipcMain.handle('dl:remove', (_e, id) => dlManager.remove(id));
  ipcMain.handle('dl:clear', (_e, statuses) => dlManager.clear(statuses));
  ipcMain.handle('dl:retryAll', () => dlManager.retryAll());
  ipcMain.handle('dl:openFolder', (_e, id) => dlManager.openFolder(id));
  ipcMain.handle('dl:openRoot', () => dlManager.openRoot()); // V4.6.4：打开下载根目录
  ipcMain.handle('dl:settings:get', () => dlManager.getSettings());
  ipcMain.handle('dl:settings:set', (_e, patch) => dlManager.setSettings(patch));

  // 音频分析（频谱图 / 波形 / 无损检测）
  analyzer.register(ipcMain, () => mainWindow);
}

// V3.3.1：GitHub Releases 差量自动更新（electron-updater，仅打包版运行）
// 用户侧体验：后台静默下载差量包（几 MB），下完弹窗询问是否重启安装；选"稍后"则下次启动生效。
// 注意：SVLX/非 SVLX 两种启动模式共用（原定义在 else 分支内，SVLX 模式下永不执行）
let __manualCheckUpdate = null;
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.warn('[update] electron-updater 不可用:', e.message); return; }
  autoUpdater.autoDownload = true;
  // 更新日志落盘（%APPDATA%\<productName>\logs\main.log），便于排查“没收到更新”
  try { autoUpdater.logger = require('electron-log'); } catch (e) { }
  const ulog = autoUpdater.logger || console;
  autoUpdater.autoInstallOnAppQuit = true;
  // V4.3.8：自建更新源方案已废弃（用户拍板回纯 GitHub），V4.3.7 曾短暂使用双源。
  // 服务器 latest.yml 已删除 → V4.3.7 客户端检查 404 → error 分支回落 GitHub，不会卡死。
  // 设置中心「更新」页状态推送（checking/available/latest/downloading/ready/error）
  const sendUpd = (status, data) => {
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:updateStatus', { status, data }); } catch { }
  };
  autoUpdater.on('checking-for-update', () => { ulog.info('[updater] checking'); sendUpd('checking'); });
  autoUpdater.on('update-available', (info) => { ulog.info('[updater] available: ' + (info && info.version)); sendUpd('available', info && info.version); });
  autoUpdater.on('update-not-available', () => { ulog.info('[updater] none'); sendUpd('latest'); });
  autoUpdater.on('download-progress', (p) => sendUpd('downloading', Math.round((p && p.percent) || 0)));
  autoUpdater.on('update-downloaded', async (info) => {
    ulog.info('[updater] downloaded: ' + (info && info.version));
    sendUpd('ready', info && info.version);
    // V3.5.3：更新公告——弹窗附带本次更新内容（release notes）
    let notes = '';
    try { notes = (await fetchReleaseNotes(info && info.version)) || ''; } catch { }
    try {
      const r = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '更新已就绪',
        message: '新版本 V' + (info && info.version) + ' 已下载完成',
        detail: '现在重启应用完成更新？（选"稍后"则关闭播放器时自动安装）'
          + (notes ? '\n\n更新内容：\n' + notes.slice(0, 800) : ''),
        buttons: ['立即重启更新', '稍后'],
        defaultId: 0, cancelId: 1,
      });
      if (r.response === 0) {
        // V3.5.9：彻底退出链路——等引擎进程真退（释放安装目录文件锁）+ 销毁托盘 + 强退兜底。
        // 旧版只 engine.stop()（异步 1.5s 慢杀）+ quitAndInstall，AnnieEngine.exe 残留
        // 导致安装器覆盖失败："Failed to uninstall old application files"。
        forceQuitForInstall();
      } else {
        // 选"稍后"：标记待装，用户关窗时走完整退出触发 autoInstallOnAppQuit
        pendingInstall = true;
      }
    } catch { }
  });
  autoUpdater.on('error', (e) => { console.warn('[update] 更新检查失败(不打扰用户):', e && e.message); sendUpd('error', String(e && e.message || e)); });

  /* V3.5.9：更新安装前的彻底退出（托盘/引擎/Worker 全清理，进程必死） */
  async function forceQuitForInstall() {
    if (installQuitting) return;
    installQuitting = true;
    try { global.__svlxQuitting = true; } catch { }
    try { flushStore(); } catch { }
    try { await engine.stopAndWait(4000); } catch { }
    try { if (scanWorker) { scanWorker.terminate(); scanWorker = null; } } catch { }
    try { global.__svlxTray && global.__svlxTray.destroy(); } catch { }
    try { autoUpdater.quitAndInstall(); } catch { }
    // 兜底：任何环节卡住（窗口 close 拦截等）3.5s 后强退，保证安装器能继续
    setTimeout(() => { try { app.exit(0); } catch { } }, 3500);
  }
  // 设置中心「检查更新」按钮：手动触发（自动检查仍会周期性静默进行）
  __manualCheckUpdate = async () => {
    try { await autoUpdater.checkForUpdates(); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  };
  // 启动 15s 后首查（让开启动带宽），之后每 6 小时复查
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => { }), 15000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => { }), 6 * 3600 * 1000);
}

// 设置中心：版本号 / 手动检查更新 / 打开外链（两种启动模式都注册）
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:openExternal', (_e, url) => {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) { const { shell } = require('electron'); shell.openExternal(u); }
});
ipcMain.handle('app:copyText', (_e, text) => { require('electron').clipboard.writeText(String(text || '')); return { ok: true }; }); // V4.3.16：分享链接复制
/* V4.3.22：运行期间防息屏/休眠（用户拍板：只要软件开着就保持亮屏，不限于播放中）。
 * 进程退出时 blocker 随进程自动释放，无需手动 stop。 */
let __awakeBlockId = null;
function startAwakeBlock() {
  if (__awakeBlockId != null) return;
  try { __awakeBlockId = require('electron').powerSaveBlocker.start('prevent-display-sleep'); } catch { }
}
ipcMain.handle('app:checkUpdate', async () => {
  if (!app.isPackaged) return { dev: true };
  if (!__manualCheckUpdate) return { ok: false, error: 'updater 未初始化' };
  return __manualCheckUpdate();
});
// 更新日志（设置中心·更新页 + 更新就绪弹窗共用）：net.fetch 走系统代理；失败返回 null 静默
async function fetchReleaseNotes(ver) {
  try {
    const { net } = require('electron');
    const v = String(ver || '').replace(/[^\d.]/g, '');
    if (!v) return null;
    const r = await net.fetch('https://api.github.com/repos/Zhou1019-1/AnniePlayer-LXversion/releases/tags/v' + v,
      { headers: { 'User-Agent': 'annie-player' } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.body) ? String(j.body) : null;
  } catch { return null; }
}
ipcMain.handle('app:getReleaseNotes', (_e, ver) => fetchReleaseNotes(ver));

// ---------- 生命周期 ----------
// V4.3.12：局域网手机遥控初始化——SVLX/非 SVLX 两分支共用（配对码懒生成；指令转发渲染层；开启状态随启动恢复）
function initRemote() {
  remote.init({
    getRemoteConf: () => {
      const st = loadStore(); st.remote = st.remote || {};
      if (!st.remote.code) { st.remote.code = String(Math.floor(1000 + Math.random() * 9000)); touchStore(); flushStore(); }
      return st.remote;
    },
    saveTokens: (tokens) => { const st = loadStore(); st.remote = st.remote || {}; st.remote.tokens = tokens; touchStore(); flushStore(); },
    forwardCmd: (cmd, value) => { try { if (mainWindow) mainWindow.webContents.send('remote:cmd', { cmd, value }); } catch { } },
  });
  if ((loadStore().remote || {}).enabled) remote.start();
}
// SVLX 模式下跳过锁 + whenReady（已由 src/main.js 接管）
if (global.__svlxBoot) {
  registerIpc();
  startAwakeBlock(); // V4.4：防息屏此前只在非 SVLX 死分支调用，生产/dev 从未生效
  setupLibraryWatch(); // V3.5.8：媒体库文件夹监听
  streaming.init(app);
  qobuz.init({ loadStore, flushStore, touchStore });
  amSrc.register(ipcMain); // V4.6：Apple Music 音源 IPC（am:* 通道族）
  // V4.6：wrapper-lite 静默自启（后台，不阻塞启动；已运行则跳过）
  amWrapper.status().then(function (st) { if (!st.ok && st.stage === 'stopped') amWrapper.startService().catch(function () { }); }).catch(function () { });
  ipcMain.handle('amWrapper:status', () => amWrapper.status());
  ipcMain.handle('amWrapper:login', (_e, p) => amWrapper.login(p.user, p.pass, p.code2fa || ''));
  ipcMain.handle('amWrapper:start', () => amWrapper.startService());
  ipcMain.handle('amWrapper:stop', () => { amWrapper.stopService(); return { ok: true }; });
  // V4.6：安妮音源心跳端点（音源沙箱验证宿主身份用）
  annieSourceHs.start();
  ipcMain.handle('annieSource:handshake', () => annieSourceHs.getHandshake());
  streamCache.init({ loadStore, flushStore, touchStore }); // V4.4：两分支共用，勿漏
  initRemote(); // V4.3.12：手机遥控（两分支共用，勿漏——漏了就是"配对码显示正常但永远不对"）
  setupImageReferer();
  engine.start();
  // 预热：引擎首次 devices.list 需 ~20s（WASAPI 枚举），后台预跑避免 UI 超时
  engine.call('devices.list', {}, 90000).catch(() => { });
  createWindow();
  setupAutoUpdate(); // V3.3.1：GitHub 差量自动更新（仅打包版生效）
  global.__svlxAnnieOpen = () => {
    try { if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus(); } } catch { }
  };
  app.on('window-all-closed', () => {
    if (global.__svlxQuitting) { engine.stop(); app.quit(); }
  });
  /* V3.5.9：退出前等待引擎进程真正退出（释放安装目录文件锁）。
   * preventDefault 拦截首次 quit → 引擎退出后 app.exit(0)；
   * forceQuitForInstall 路径已先停引擎（engine.proc 为 null），此处自动放行。 */
  app.on('before-quit', (e) => {
    if (engine.proc && !engine._stopIntentional) {
      e.preventDefault();
      engine.stopAndWait(4000).finally(() => { try { app.exit(0); } catch { } });
    }
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
    startAwakeBlock(); // V4.3.22：运行期间防息屏/休眠
    setupLibraryWatch(); // V3.5.8：媒体库文件夹监听
    streaming.init(app); // 恢复流媒体登录态（userData/stream-cookies.json）
    qobuz.init({ loadStore, flushStore, touchStore });
    amSrc.register(ipcMain); // V4.6：Apple Music 音源 IPC（am:* 通道族）
    // V4.6：wrapper-lite 静默自启（后台，不阻塞启动；已运行则跳过）
    amWrapper.status().then(function (st) { if (!st.ok && st.stage === 'stopped') amWrapper.startService().catch(function () { }); }).catch(function () { });
    ipcMain.handle('amWrapper:status', () => amWrapper.status());
    ipcMain.handle('amWrapper:login', (_e, p) => amWrapper.login(p.user, p.pass, p.code2fa || ''));
    ipcMain.handle('amWrapper:start', () => amWrapper.startService());
    ipcMain.handle('amWrapper:stop', () => { amWrapper.stopService(); return { ok: true }; });
    // V4.6：安妮音源心跳端点（音源沙箱验证宿主身份用）
    annieSourceHs.start();
    ipcMain.handle('annieSource:handshake', () => annieSourceHs.getHandshake());
    streamCache.init({ loadStore, flushStore, touchStore }); // V4.4：流媒体播放缓存
    initRemote(); // V4.3.12：手机遥控
    setupImageReferer(); // 流媒体封面 CDN 防盗链 Referer 注入
    engine.start(); // 引擎拉起失败不阻塞 UI，调用时再报错
    // 预热：引擎首次 devices.list 需 ~20s（WASAPI 枚举），后台预跑避免 UI 超时
    engine.call('devices.list', {}, 90000).catch(() => { });
    createWindow();
    createTray(); // Pro beat0.0.1：系统托盘
    setupAutoUpdate(); // V3.3.1：GitHub 差量自动更新（仅打包版）

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

  // V3.5.9：退出前等引擎真退（同 SVLX 分支），防安装器覆盖文件失败
  app.on('before-quit', (e) => {
    if (engine.proc && !engine._stopIntentional) {
      e.preventDefault();
      engine.stopAndWait(4000).finally(() => { try { app.exit(0); } catch { } });
    }
  });
}
} // end else (non-SVLX mode)
