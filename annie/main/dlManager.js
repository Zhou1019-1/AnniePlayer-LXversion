'use strict';
/* V4.3.22：下载任务管理器（设计参考洛雪下载管理：任务列表 / 并发槽 / 暂停继续 / 持久化）
 * - 任务持久化 dl-tasks.json（含 song 快照，重启后可继续/重试）
 * - 暂停 = 中止当前传输并删除半成品，继续 = 重新排队从头下（流媒体地址有时效，断点续传无意义）
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
  lrcTLrc: true, lrcEncoding: 'utf8'                 // 旁挂歌词含翻译 / 歌词文件编码
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
    try { fs.writeFileSync(file(), JSON.stringify({ settings, tasks })); } catch { }
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
    // 队列中已有同曲未完成任务 → 跳过（已完成/出错的允许再次下载）
    const dup = tasks.find(t => t.provider === (it.provider || '') && t.songId === sid &&
      (t.status === 'waiting' || t.status === 'downloading' || t.status === 'paused'));
    if (dup) { skipped++; continue; }
    tasks.push({
      id: 'dl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      name: it.song.name || '', artist: it.song.artist || '', album: it.song.album || '',
      provider: it.provider || '', songId: sid, quality: it.quality || '',
      song: it.song, saveLrc: it.saveLrc !== false, saveCover: it.saveCover !== false,
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
  t.status = 'downloading'; t.received = 0; t.total = 0; t.error = ''; t.note = '';
  const ac = new AbortController();
  running.set(t.id, ac);
  pushTasks();
  let lastPush = 0;
  try {
    const r = await streaming.download({
      provider: t.provider, quality: t.quality, song: t.song,
      saveLrc: t.saveLrc, saveCover: t.saveCover,
      fileNameFmt: settings.fileNameFmt, skipExisting: settings.skipExisting,
      embedCover: settings.embedCover, embedLrc: settings.embedLrc, embedTLrc: settings.embedTLrc,
      lrcTLrc: settings.lrcTLrc, lrcEncoding: settings.lrcEncoding,
      signal: ac.signal
    }, (received, total) => {
      t.received = received; t.total = total;
      const now = Date.now();
      if (now - lastPush > 300 && broadcast) {
        lastPush = now;
        try { broadcast('dl:event', { type: 'progress', id: t.id, received, total }); } catch { }
      }
    });
    t.status = 'done'; t.filePath = r.path || ''; t.doneAt = Date.now();
    if (r && r.skipped) t.note = '同名文件已存在，跳过';
    else if (r && r.downgraded) t.note = '已降级为 ' + (r.quality || '');
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
  t.status = 'waiting'; t.error = ''; t.received = 0; t.total = 0;
  pump(); pushTasks();
}

function remove(id) {
  const i = tasks.findIndex(t => t.id === id);
  if (i < 0) return;
  const ac = running.get(id);
  if (ac) ac.abort();
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
  if (t && t.filePath) { try { shell.showItemInFolder(t.filePath); } catch { } }
}

function getSettings() { return { ...settings }; }
function setSettings(patch) {
  settings = { ...settings, ...(patch || {}) };
  settings.concurrency = Math.max(1, Math.min(10, settings.concurrency | 0 || 3));
  persist();
  pump(); // 并发调大立即补位
  return getSettings();
}

module.exports = { init, list: snap, add, pause, resume, remove, clear, retryAll, openFolder, getSettings, setSettings };
