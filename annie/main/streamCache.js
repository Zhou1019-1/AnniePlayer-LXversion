'use strict';
/* 流媒体播放缓存（V4.4）：边播边存 + LRU 按大小上限清理。
 * - 键 = provider_songId_quality（播放 URL 是时效签名，不能做键——见 AGENTS.md 下载任务同理）
 * - 配置持久化在 library.json 的 streamCache 字段；缓存索引 stream-cache.json 存在缓存目录内
 * - 命中后引擎直接解码本地文件（renderer 侧 track.url 身份不变，歌词/统计/收藏链路不受影响）
 * - 网络一律走 Electron net.fetch（自动跟随系统代理，AGENTS.md 网络调试约定） */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { app, ipcMain, dialog, BrowserWindow, net } = require('electron');

let loadStore = null, touchStore = null, flushStore = null;
const inflight = new Set(); // 边下边播去重（key 级）

function cfg() {
  const c = (loadStore().streamCache) || {};
  return {
    enabled: c.enabled !== false, // 默认开
    maxMB: Math.min(51200, Math.max(128, parseInt(c.maxMB, 10) || 2048)), // 128MB–50GB，默认 2GB
    dir: typeof c.dir === 'string' ? c.dir : ''
  };
}
function cacheDir() { return cfg().dir || path.join(app.getPath('userData'), 'streamCache'); }
function keyOf(ck) {
  return [ck.provider, ck.songId, ck.quality || ''].join('_').replace(/[^\w.-]+/g, '_').slice(0, 150);
}
function idxPath() { return path.join(cacheDir(), 'stream-cache.json'); }
function loadIdx() { try { return JSON.parse(fs.readFileSync(idxPath(), 'utf8')) || {}; } catch { return {}; } }
function saveIdx(idx) {
  try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(idxPath(), JSON.stringify(idx)); } catch { }
}
function setDir(dir) {
  const st = loadStore();
    st.streamCache = st.streamCache || {};
    if (dir) st.streamCache.dir = dir; else delete st.streamCache.dir;
    touchStore(); flushStore();
    enforceCap();
    return cfg();
}
function extOf(url) {
  const m = String(url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  const e = m ? m[1].toLowerCase() : '';
  return /^(flac|mp3|m4a|aac|ogg|opus|wav|wma)$/.test(e) ? e : 'mp3';
}

/* 命中返回 { path, size }；条目在但文件没了 → 清条目返回 null */
function lookup(ck) {
  const c = cfg();
  if (!c.enabled || !ck || !ck.provider || !ck.songId) return null;
  const key = keyOf(ck);
  const idx = loadIdx();
  const ent = idx[key];
  if (!ent) return null;
  const fp = path.join(cacheDir(), ent.file);
  try {
    const st = fs.statSync(fp);
    if (!st.size) throw new Error('empty');
    ent.lastUse = Date.now();
    saveIdx(idx);
    return { path: fp, size: st.size };
  } catch {
    delete idx[key];
    saveIdx(idx);
    return null;
  }
}

/* 后台边播边存：已缓存/在下载直接跳过；失败静默（不影响播放） */
function fill(ck) {
  const c = cfg();
  if (!c.enabled || !ck || !ck.url || !ck.provider || !ck.songId) return Promise.resolve({ ok: false });
  const key = keyOf(ck);
  const idx = loadIdx();
  if (idx[key]) return Promise.resolve({ ok: true, skipped: true });
  if (inflight.has(key)) return Promise.resolve({ ok: true, skipped: true });
  inflight.add(key);
  return (async () => {
    const file = key + '.' + extOf(ck.url);
    const part = path.join(cacheDir(), file + '.part');
    const fin = path.join(cacheDir(), file);
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      const resp = await net.fetch(ck.url, { headers: ck.headers || {} });
      if (!resp.ok || !resp.body) throw new Error('http-' + resp.status);
      await new Promise((res, rej) => {
        const ws = fs.createWriteStream(part);
        Readable.fromWeb(resp.body).pipe(ws);
        ws.on('finish', res);
        ws.on('error', rej);
      });
      const size = fs.statSync(part).size;
      if (!size) throw new Error('empty');
      try { fs.renameSync(part, fin); } catch { fs.copyFileSync(part, fin); fs.unlinkSync(part); }
      idx[key] = { file, size, lastUse: Date.now(), title: ck.title || '', artist: ck.artist || '' };
      saveIdx(idx);
      enforceCap(idx);
      return { ok: true, size };
    } catch (e) {
      try { fs.unlinkSync(part); } catch { }
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      inflight.delete(key);
    }
  })();
}

/* LRU：超出上限按 lastUse 从旧到新清，正在下载的不动 */
function enforceCap(idx) {
  const c = cfg();
  idx = idx || loadIdx();
  const cap = c.maxMB * 1048576;
  const keys = Object.keys(idx);
  let total = 0;
  keys.forEach(k => { total += idx[k].size || 0; });
  if (total <= cap) return;
  keys.sort((a, b) => (idx[a].lastUse || 0) - (idx[b].lastUse || 0));
  for (const k of keys) {
    if (total <= cap) break;
    if (inflight.has(k)) continue;
    try { fs.unlinkSync(path.join(cacheDir(), idx[k].file)); } catch { }
    total -= idx[k].size || 0;
    delete idx[k];
  }
  saveIdx(idx);
}

function init(hooks) {
  loadStore = hooks.loadStore; touchStore = hooks.touchStore; flushStore = hooks.flushStore;

  ipcMain.handle('streamCache:lookup', (_e, ck) => lookup(ck));
  ipcMain.handle('streamCache:fill', (_e, ck) => fill(ck));
  ipcMain.handle('streamCache:stats', () => {
    const idx = loadIdx();
    const keys = Object.keys(idx);
    let total = 0;
    keys.forEach(k => { total += idx[k].size || 0; });
    const c = cfg();
    return {
      enabled: c.enabled, maxMB: c.maxMB, dir: cacheDir(), custom: !!c.dir,
      count: keys.length, totalMB: Math.round(total / 1048576)
    };
  });
  ipcMain.handle('streamCache:setCfg', (_e, patch) => {
    const st = loadStore();
    st.streamCache = st.streamCache || {};
    const c = st.streamCache;
    if (patch && typeof patch.enabled === 'boolean') c.enabled = patch.enabled;
    if (patch && patch.maxMB != null) c.maxMB = Math.min(51200, Math.max(128, parseInt(patch.maxMB, 10) || 2048));
    if (patch && typeof patch.dir === 'string') { if (patch.dir) c.dir = patch.dir; else delete c.dir; }
    touchStore(); flushStore();
    enforceCap(); // 调小上限/换目录立即生效
    return cfg();
  });
  ipcMain.handle('streamCache:pickDir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择播放缓存目录', defaultPath: cacheDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const st = loadStore();
    st.streamCache = st.streamCache || {};
    st.streamCache.dir = r.filePaths[0];
    touchStore(); flushStore();
    enforceCap();
    return r.filePaths[0];
  });
  ipcMain.handle('streamCache:clear', () => {
    const idx = loadIdx();
    Object.keys(idx).forEach(k => { try { fs.unlinkSync(path.join(cacheDir(), idx[k].file)); } catch { } });
    saveIdx({});
    return true;
  });

  enforceCap(); // 启动兜底清一次（上次运行可能超限退出）
}

module.exports = { init };
