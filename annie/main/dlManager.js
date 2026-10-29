'use strict';
/* V4.3.22：下载任务管理器（设计参考洛雪下载管理：任务列表 / 并发槽 / 暂停继续 / 持久化）
 * - 任务持久化 dl-tasks.json（含 song 快照，重启后可继续/重试）
 * - V4.6.3 洛雪式断点续传：暂停保留 .part 半成品与进度，继续 = 重新取址（链接有时效）后 Range 续传
 * - 去重键 provider+songId+quality（洛雪同款：同曲可下多个音质）
 * - 并发数由设置「同时下载任务数」控制，改设置即时生效
 * - 事件推送渲染层：'dl:event' { type:'tasks', tasks }（结构变化）/ { type:'progress', id, received, total }（进度） */
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const streaming = require('./streaming');

let tasks = [];
let settings = {
  concurrency: 3, skipExisting: true, fileNameFmt: 'artist-name',
  embedCover: true, embedLrc: true, embedTLrc: true, // 嵌入封面/歌词/翻译歌词（洛雪同款）
  embedRLrc: false, embedLxLrc: false,               // V4.6.3：嵌入罗马音/逐字歌词(awlrc)（洛雪同款，默认关）
  lrcTLrc: true, lrcEncoding: 'utf8',                // 旁挂歌词含翻译 / 歌词文件编码
  lrcRLrc: false, lrcLxLrc: false,                   // V4.6.3：旁挂歌词含罗马音/逐字(awlrc)
  allowOtherSource: true                             // V4.6.3：洛雪「自动换源下载」——失败时跨平台找同歌重试
};
const running = new Map(); // id → AbortController
let broadcast = null;
let saveTimer = null;

function file() { return path.join(app.getPath('userData'), 'dl-tasks.json'); }

function init(broadcastFn) {
  broadcast = broadcastFn;
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(j.tasks)) tasks = j.tasks;
    if (j.settings) settings = { ...settings, ...j.settings };
  } catch { }
  // 上次退出时被中断的任务 → 已暂停（用户可继续/重试）
  for (const t of tasks) {
    if (t.status === 'downloading' || t.status === 'waiting') { t.status = 'paused'; t.error = ''; }
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { require('./jsonFile').writeJsonAtomic(file(), { settings, tasks }); } catch { }
  }, 300);
}

/* 渲染层快照：剥离 song（体积大，渲染层用不到；主进程内存/持久化保留以支持继续下载） */
function snap() { return tasks.map(t => { const { song, ...rest } = t; return rest; }); }
function pushTasks() { if (broadcast) { try { broadcast('dl:event', { type: 'tasks', tasks: snap() }); } catch { } } persist(); }

function find(id) { return tasks.find(t => t.id === id); }

/* items: [{ provider, quality, song, saveLrc, saveCover }]；返回 { added, skipped } */
function add(items) {
  let added = 0, skipped = 0;
  for (const it of (items || [])) {
    if (!it || !it.song) { skipped++; continue; }
    const sid = String(it.song.id != null ? it.song.id : (it.song.name || ''));
    // 队列中已有同曲同音质未完成任务 → 跳过（洛雪同款去重键 id+quality：同曲可下多个音质；已完成/出错的允许再次下载）
    const dup = tasks.find(t => t.provider === (it.provider || '') && t.songId === sid &&
      t.quality === (it.quality || '') &&
      (t.status === 'waiting' || t.status === 'downloading' || t.status === 'paused'));
    if (dup) { skipped++; continue; }
    tasks.push({
      id: 'dl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      name: it.song.name || '', artist: it.song.artist || '', album: it.song.album || '',
      provider: it.provider || '', songId: sid, quality: it.quality || '',
      song: it.song, saveLrc: it.saveLrc !== false, saveCover: it.saveCover !== false,
      groupDir: String(it.groupDir || ''), // V4.6.4：歌单/专辑名子文件夹（空=不建）
      status: 'waiting', received: 0, total: 0, error: '', filePath: '', note: '', addedAt: Date.now()
    });
    added++;
  }
  if (added) pump();
  pushTasks();
  return { added, skipped };
}

function pump() {
  const conc = Math.max(1, Math.min(10, settings.concurrency | 0 || 3));
  while (running.size < conc) {
    const t = tasks.find(x => x.status === 'waiting');
    if (!t) break;
    start(t);
  }
}

async function start(t) {
  // V4.6.3：不再清空 received/total——断点续传保留进度显示（洛雪式）
  t.status = 'downloading'; t.error = ''; t.note = '';
  const ac = new AbortController();
  running.set(t.id, ac);
  pushTasks();
  let lastPush = 0;
  const onProg = (received, total) => {
    t.received = received; t.total = total;
    const now = Date.now();
    if (now - lastPush > 300 && broadcast) {
      lastPush = now;
      try { broadcast('dl:event', { type: 'progress', id: t.id, received, total }); } catch { }
    }
  };
  const runDownload = (song, provider) => streaming.download({
    provider, quality: t.quality, song,
    saveLrc: t.saveLrc, saveCover: t.saveCover,
    groupDir: t.groupDir, // V4.6.4：歌单/专辑名子文件夹
    fileNameFmt: settings.fileNameFmt, skipExisting: settings.skipExisting,
    embedCover: settings.embedCover, embedLrc: settings.embedLrc, embedTLrc: settings.embedTLrc,
    embedRLrc: settings.embedRLrc, embedLxLrc: settings.embedLxLrc,
    lrcTLrc: settings.lrcTLrc, lrcRLrc: settings.lrcRLrc, lrcLxLrc: settings.lrcLxLrc,
    lrcEncoding: settings.lrcEncoding,
    // 续传：既定目标路径续同一文件；首下：解析出目标路径立刻回写（供持久化/续传）
    destPath: t.filePath || undefined,
    onDest: (p) => { t.filePath = p; },
    signal: ac.signal
  }, onProg);
  try {
    let r;
    try {
      r = await runDownload(t.song, t.provider);
    } catch (e) {
      if ((e && e.name === 'AbortError') || ac.signal.aborted) throw e;
      // V4.6.3 自动换源下载（洛雪 isUseOtherSource 同款，仅国内流媒体）：
      // 原平台失败 → 跨平台按歌名+歌手+时长找同歌 → 删旧半成品（内容不同源不可续）→ 换源重下
      const DOMESTIC = ['kw', 'kg', 'tx', 'wy', 'mg'];
      if (!settings.allowOtherSource || !DOMESTIC.includes(t.provider)) throw e;
      const alt = await streaming.findOtherSource(t.song, t.provider).catch(() => null);
      if (ac.signal.aborted) { const ae = new Error('已暂停'); ae.name = 'AbortError'; throw ae; }
      if (!alt) throw e;
      console.log('[dl] 自动换源：', t.provider, '→', alt.provider, '|', t.name, '-', t.artist);
      if (t.filePath) { try { fs.unlinkSync(t.filePath + '.part'); } catch { } t.filePath = ''; }
      t.received = 0; t.total = 0;
      r = await runDownload(alt.song, alt.provider);
      const PN = { kg: '酷狗', kw: '酷我', mg: '咪咕', tx: 'QQ音乐', wy: '网易云' };
      t.note = '原平台失败，已从 ' + (PN[alt.provider] || alt.provider) + ' 换源下载';
    }
    t.status = 'done'; t.filePath = r.path || ''; t.doneAt = Date.now();
    if (r && r.skipped) t.note = '同名文件已存在，跳过';
    else if (!t.note && r && r.downgraded) t.note = '已降级为 ' + (r.quality || '');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // pause() 先行置 paused；这里只兜底，绝不覆盖用户意图
      if (t.status === 'downloading') t.status = 'paused';
    } else {
      t.status = 'error';
      t.error = String((e && e.message) || e || '下载失败');
    }
  } finally {
    running.delete(t.id);
    pushTasks();
    pump();
  }
}

function pause(id) {
  const t = find(id);
  if (!t) return;
  if (t.status === 'downloading') {
    t.status = 'paused';
    const ac = running.get(id);
    if (ac) ac.abort();
  } else if (t.status === 'waiting') {
    t.status = 'paused';
  }
  pushTasks();
}

function resume(id) {
  const t = find(id);
  if (!t || (t.status !== 'paused' && t.status !== 'error')) return;
  // 保留 received/total：续传从断点继续，进度条不回零
  t.status = 'waiting'; t.error = '';
  pump(); pushTasks();
}

function remove(id) {
  const i = tasks.findIndex(t => t.id === id);
  if (i < 0) return;
  const ac = running.get(id);
  if (ac) ac.abort();
  const t = tasks[i];
  // 清理半成品（.part）；已完成的成品文件不动（洛雪 removeTask 同款，只清未完成的半成品）
  if (t && t.status !== 'done' && t.filePath) { try { fs.unlinkSync(t.filePath + '.part'); } catch { } }
  tasks.splice(i, 1);
  pushTasks();
}

/* statuses: 要清空的状态数组，如 ['done'] */
function clear(statuses) {
  const set = new Set(statuses || []);
  for (const t of tasks.slice()) if (set.has(t.status)) remove(t.id);
}

function retryAll() {
  let n = 0;
  for (const t of tasks) if (t.status === 'error') { t.status = 'waiting'; t.error = ''; n++; }
  if (n) { pump(); pushTasks(); }
  return n;
}

function openFolder(id) {
  const t = find(id);
  if (!t) return;
  /* V4.6.4：歌单/专辑任务（groupDir 非空）直接打开该歌单子文件夹——批量下载后
   * 用户要看的是整个文件夹，而非定位到某一首歌。单曲任务仍定位文件本身。 */
  if (t.groupDir) {
    try {
      const dir = path.join(streaming.downloadDir(), t.groupDir);
      if (fs.existsSync(dir)) { shell.openPath(dir); return; }
    } catch { }
  }
  if (t.filePath) { try { shell.showItemInFolder(t.filePath); } catch { } }
}

/* V4.6.4：打开下载根目录（下载情况视图头部「打开下载目录」按钮用） */
function openRoot() {
  try { const d = streaming.downloadDir(); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); } catch { }
}

function getSettings() { return { ...settings }; }
function setSettings(patch) {
  settings = { ...settings, ...(patch || {}) };
  settings.concurrency = Math.max(1, Math.min(10, settings.concurrency | 0 || 3));
  persist();
  pump(); // 并发调大立即补位
  return getSettings();
}

module.exports = { init, list: snap, add, pause, resume, remove, clear, retryAll, openFolder, openRoot, getSettings, setSettings };
