'use strict';
/* V4.3.6：Qobuz IPC 桥。
 * 与 QBDLX 同模式：每个用户登录自己的 Qobuz 付费账号（邮箱+密码 或 user_auth_token）。
 * 凭据用 Electron safeStorage 加密存 store.qobuzExp；token 失效自动重登一次。
 * 应用级 app_id/secret 默认用 Qobuz 安卓客户端公开对（见 api.js 注释），可手工覆盖。 */
const { ipcMain, safeStorage, dialog, BrowserWindow, net } = require('electron');
const api = require('./api');
const dl = require('./download');
const tagWriter = require('../tagWriter'); // V4.4.3：下载后写标签/封面/旁挂歌词（与洛雪下载链同一实现）
const extMeta = require('../extMeta');     // V4.4.3：LRCLIB 歌词优先源（欧美曲库命中率高于国内五源）
const streaming = require('../streaming'); // Qobuz 无歌词 API：借 LX 五源按标题+艺人兜底匹配；下载目录复用其 downloadDir

/* V4.3.22 修复：Qobuz 统一走 net.fetch —— 自动跟随 Windows 系统代理
 *（Node 全局 fetch 不读系统代理，挂 Clash 的用户照样连不上）。
 * 20s 连接/响应头超时；响应头一到达即清除计时，不限制大文件传输。 */
function qzFetch(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  return net.fetch(url, Object.assign({}, opts, { signal: ctl.signal })).then(
    function (r) { clearTimeout(timer); return r; },
    function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError')
        throw new Error('连接 Qobuz 超时（20 秒无响应）：检查网络或代理软件是否正常运行');
      const code = (e && (e.code || (e.cause && e.cause.code))) || '';
      throw new Error('无法连接 Qobuz 服务器' + (code ? '（' + code + '）' : '') +
        '：请检查网络，若使用代理请确认系统代理已开启');
    });
}

let loadStore = null, flushStore = null, touchStore = null;
let client = null;          // QobuzClient 登录态
let reloginInFlight = null; // 防并发重登

function enc(s) { try { return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(String(s)).toString('base64') : null; } catch { return null; } }
function dec(b64) { try { return b64 ? safeStorage.decryptString(Buffer.from(b64, 'base64')) : null; } catch { return null; } }

function savedCreds() {
  const q = (loadStore().qobuzExp) || {};
  if (q.encToken && q.userId) return { userId: q.userId, token: dec(q.encToken) };
  if (q.encEmail && q.encPass) return { email: dec(q.encEmail), password: dec(q.encPass) };
  return null;
}
function saveCreds(creds, opts) {
  const st = loadStore();
  const dlDir = (st.qobuzExp && st.qobuzExp.dlDir) || ''; // 下载目录是独立设置，登录/登出不丢
  if (creds.token) {
    st.qobuzExp = { userId: creds.userId, encToken: enc(creds.token) };
  } else {
    st.qobuzExp = { encEmail: enc(creds.email), encPass: enc(creds.password) };
  }
  if (opts && (opts.appId || opts.secret)) {
    st.qobuzExp.appId = opts.appId || '';
    st.qobuzExp.encSecret = opts.secret ? enc(opts.secret) : '';
  }
  if (dlDir) st.qobuzExp.dlDir = dlDir;
  touchStore(); flushStore(); // 直接改对象必须先置脏，否则不落盘（V4.3.10 教训）
}
function clearCreds() {
  const st = loadStore();
  const dlDir = (st.qobuzExp && st.qobuzExp.dlDir) || '';
  delete st.qobuzExp;
  if (dlDir) st.qobuzExp = { dlDir }; // 登出只清凭据，保留下载目录
  touchStore(); flushStore();
}

/* 下载目录：用户自选优先，默认回落到洛雪流媒体下载目录 */
function dlDir() {
  const custom = (loadStore().qobuzExp && loadStore().qobuzExp.dlDir) || '';
  return custom || streaming.downloadDir();
}
function setDlDir(dir) {
  const st = loadStore();
  st.qobuzExp = st.qobuzExp || {};
  if (dir) st.qobuzExp.dlDir = dir; else delete st.qobuzExp.dlDir;
  touchStore(); // V4.4：修复只 flush 不置脏——下载目录只活在内存、重启即丢（V4.3.10 同款教训）
  flushStore();
  return dlDir();
}
function savedOpts() {
  const q = (loadStore().qobuzExp) || {};
  const o = {};
  if (q.appId) o.appId = q.appId;
  if (q.encSecret) o.secret = dec(q.encSecret);
  return o;
}

function info() {
  return {
    loggedIn: !!(client && client.token),
    userName: client && client.user ? (client.user.display_name || client.user.login || '') : '',
    subscription: client && client.user && client.user.credential ? (client.user.credential.description || '') : '',
    hasSavedCreds: !!savedCreds(),
    dlDir: loadStore ? dlDir() : '', // 下载目录（自定义或默认）
  };
}

async function doLogin(creds, opts) {
  const c = new api.QobuzClient();
  await c.login(creds, opts || savedOpts());
  client = c;
  if (creds) saveCreds(creds, opts); // 显式登录才更新凭据
  return info();
}

/** 取已登录 client；未登录但有存凭据则自动重登（token 过期场景） */
async function ensure() {
  if (client && client.token) return client;
  if (!reloginInFlight) {
    const creds = savedCreds();
    if (!creds) throw Object.assign(new Error('未登录 Qobuz'), { code: 'NOAUTH' });
    reloginInFlight = doLogin(creds, null).finally(() => { reloginInFlight = null; });
  }
  await reloginInFlight;
  return client;
}

/** 带一次 401 重登重试的执行器 */
async function withAuth(fn) {
  const c = await ensure();
  try { return await fn(c); } catch (e) {
    if (e && e.code === 'AUTH') {
      client = null;              // 强制重登
      const c2 = await ensure();
      return fn(c2);
    }
    throw e;
  }
}

/* ---------------- 链接解析（QBDLX 同款对象：album/track/playlist 三类 + 裸 ID） ---------------- */
/** 返回 { kind:'album'|'track'|'playlist', id } 或 null */
function parseUrlInput(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (!/^(https?:\/\/)?([\w-]+\.)*qobuz\.com/i.test(s) && !/^[a-zA-Z0-9]+$/.test(s)) return null;
  // 商店链接 /album/{slug}/{id} 与 play 链接 /album/{id} 统一取尾段
  const m = s.match(/qobuz\.com\/(?:[a-z]{2}-[a-z]{2}\/)?(album|track|playlist|interpreter|artist)\/(?:[^/?#]+\/)?([a-zA-Z0-9]+)/i);
  if (m) return { kind: m[1].toLowerCase().replace('interpreter', 'artist'), id: m[2] };
  if (/^[a-zA-Z0-9]+$/.test(s)) return { kind: '', id: s }; // 裸 ID：类型未知，逐个试
  return null;
}

/* 专辑/曲目/歌单对象上的封面 URL（Qobuz image 对象：large > small > thumbnail） */
function coverUrlOf(obj) {
  const img = obj && obj.image;
  return (img && (img.large || img.small || img.thumbnail)) || '';
}

/** 解析为可下载曲目清单：{ kind, title, sub, tracks }（tracks 已附 albumTitle/albumArtist/coverUrl 供子目录命名与标签嵌入） */
async function resolveToTracks(c, kind, id) {
  async function tryKind(k) {
    if (k === 'album') {
      const a = await c.albumGet(id);
      const tracks = ((a.tracks && a.tracks.items) || []).map((t) => Object.assign({}, t, {
        albumTitle: a.title, albumArtist: (a.artist && a.artist.name) || '',
        coverUrl: t.coverUrl || coverUrlOf(a),
        releaseDate: a.release_date_original ? String(a.release_date_original).slice(0, 10) : '',
        genre: (a.genre && a.genre.name) || '',           // V4.4.3：流派（Qobuz 专辑级元数据）
        publisher: (a.label && a.label.name) || '',       // V4.4.3：厂牌
      }));
      return { kind: 'album', id: String(a.id), info: a, title: a.title, sub: (a.artist && a.artist.name) || '', tracks };
    }
    if (k === 'track') {
      const t = await c.trackGet(id);
      if (!t.coverUrl && t.album) t.coverUrl = coverUrlOf(t.album);
      return { kind: 'track', id: String(t.id), title: t.title, sub: (t.performer && t.performer.name) || '', tracks: [t] };
    }
    if (k === 'playlist') {
      const p = await c.playlistGet(id);
      const pCover = (p.images300 && p.images300[0]) || (p.images && p.images[0]) || '';
      const tracks = ((p.tracks && p.tracks.items) || []).map((t) =>
        (t.coverUrl || !t.album) ? t : Object.assign({}, t, { coverUrl: coverUrlOf(t.album) || pCover }));
      return { kind: 'playlist', id: String(p.id), info: p, title: p.name, sub: (p.owner && p.owner.name) || '', tracks };
    }
    return null;
  }
  if (kind) { const r = await tryKind(kind); if (r) return r; throw new Error('解析失败：' + kind + ' ' + id); }
  for (const k of ['album', 'track', 'playlist']) { // 裸 ID：按可能性逐个试
    try { const r = await tryKind(k); if (r) return r; } catch { }
  }
  throw new Error('无法识别的链接或 ID');
}

/* ---------------- 下载队列（单例：同时只允许一个队列） ---------------- */
const dlState = { running: false, canceled: false };

function init(ctx) {
  loadStore = ctx.loadStore; flushStore = ctx.flushStore; touchStore = ctx.touchStore;
  api.setHttpFetch(qzFetch); // V4.3.22：API/下载全链路走 net.fetch（系统代理）
  dl.setHttpFetch(qzFetch);
  extMeta.setHttpFetch(qzFetch); // V4.4.3：LRCLIB/MusicBrainz 同走系统代理（境外源，没开代理的用户由调用方静默降级）

  ipcMain.handle('qobuz:status', () => {
    const inf = info();
    // 有存凭据但未登录（token 过期/刚启动）：后台自动重登，渲染层轮询恢复
    if (!inf.loggedIn && inf.hasSavedCreds) { inf.restoring = true; ensure().catch(() => { }); }
    return inf;
  });
  ipcMain.handle('qobuz:login', async (_e, payload) => {
    // payload: { email, password } | { userId, token }，可选 appId/secret 覆盖
    const opts = {};
    if (payload.appId) opts.appId = String(payload.appId).trim();
    if (payload.secret) opts.secret = String(payload.secret).trim();
    try {
      return await doLogin(
        payload.token ? { userId: String(payload.userId), token: String(payload.token) }
                      : { email: String(payload.email), password: String(payload.password) },
        (opts.appId || opts.secret) ? opts : null);
    } catch (e) {
      console.error('[qobuz] 登录失败:', e && e.code, e && e.message); // 诊断包无主进程日志时难排查
      throw e;
    }
  });
  ipcMain.handle('qobuz:logout', () => { client = null; clearCreds(); return info(); });

  ipcMain.handle('qobuz:search', (_e, p) => withAuth((c) => c.search(p.type, p.query, p.limit)));
  ipcMain.handle('qobuz:albumGet', (_e, id) => withAuth((c) => c.albumGet(id)));
  ipcMain.handle('qobuz:playlistGet', (_e, id) => withAuth((c) => c.playlistGet(id)));
  ipcMain.handle('qobuz:artistGet', (_e, id) => withAuth((c) => c.artistGet(id)));
  ipcMain.handle('qobuz:favorites', (_e, type) => withAuth((c) => c.favorites(type)));
  ipcMain.handle('qobuz:userPlaylists', () => withAuth((c) => c.userPlaylists()));
  // 收藏写入：kind album|track|artist 走 favorite/*；playlist 走 subscribe/unsubscribe
  ipcMain.handle('qobuz:fav', (_e, p) => withAuth((c) =>
    p.kind === 'playlist' ? c.playlistSubscribe(String(p.id), !p.add) : (p.add ? c.favAdd(p.kind, String(p.id)) : c.favDel(p.kind, String(p.id)))));
  // quality 1-4：1=MP3 320 / 2=FLAC 16/44.1 / 3=24/≤96 / 4=24/≤192
  ipcMain.handle('qobuz:fileUrl', (_e, p) => withAuth((c) => c.getFileUrl(String(p.trackId), p.quality || 4)));

  // 粘贴链接/ID 解析（专辑/单曲/歌单 → 曲目清单预览）
  ipcMain.handle('qobuz:parseUrl', (_e, text) => withAuth(async (c) => {
    const ref = parseUrlInput(text);
    if (!ref) throw new Error('无法识别：支持 Qobuz 专辑/单曲/歌单链接或裸 ID');
    return resolveToTracks(c, ref.kind, ref.id);
  }));

  // 批量下载（单例队列；进度经 qobuz:dl:event 推送；V4.4.3 起每首落盘后写标签/封面/歌词补全）
  ipcMain.handle('qobuz:download', async (e, p) => {
    if (dlState.running) throw new Error('已有下载队列进行中');
    const items = (p && Array.isArray(p.items) ? p.items : []).filter((t) => t && t.id != null);
    if (!items.length) throw new Error('没有可下载的曲目');
    dlState.running = true; dlState.canceled = false;
    const fill = { tagged: 0, tagFail: 0, lyric: 0, lyricMiss: 0 }; // 后处理汇总，随 end 事件带给渲染层
    const post = makePostProcessor(fill);
    const emit = (phase, data) => {
      if (phase === 'end') data = Object.assign({}, data, { fill });
      try { e.sender.send('qobuz:dl:event', { phase, ...data }); } catch { }
    };
    try {
      return await withAuth((c) =>
        dl.runQueue(c, p.quality || 4, items, dlDir(), () => dlState.canceled, emit, post));
    } finally { dlState.running = false; }
  });
  ipcMain.handle('qobuz:dlCancel', () => { dlState.canceled = true; return true; });

  // 下载目录：选择文件夹 / 恢复默认（传 null）
  ipcMain.handle('qobuz:pickDlDir', async (e, reset) => {
    if (reset) return setDlDir(null);
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: '选择 Qobuz 下载目录', defaultPath: dlDir(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return dlDir(); // 取消=不变
    return setDlDir(r.filePaths[0]);
  });

  // 歌词兜底匹配（播放时用，不落盘；下载落盘走 makePostProcessor，阈值 80 更保守）
  ipcMain.handle('qobuz:lyricMatch', (_e, p) => lyricMatch(p, 60));
}

/* 歌词兜底匹配（Qobuz 无歌词 API）：LRCLIB 优先（欧美曲库同步歌词命中率高，精确端点按时长校验防错配）
 * → 落空再走 LX 五源并行搜索打分。minScore：播放时兜底 60；下载落盘 80（与 onlineMatch 批量一致）。 */
async function lyricMatch(p, minScore) {
  const l0 = await extMeta.lrclibGet({
    title: p.title || '', artist: p.artist || '', album: p.album || '', durationSec: p.duration || 0,
  }).catch(() => null);
  if (l0 && l0.ok && l0.lrc) {
    return {
      ok: true, lrc: l0.lrc, tlyric: '',
      matched: { provider: 'LRCLIB', name: l0.matched.name, artist: l0.matched.artist, score: l0.synced ? 100 : 90 },
    };
  }
  const kw = `${p.title || ''} ${p.artist || ''}`.trim();
  if (!kw) return { ok: false, reason: '缺少标题/艺人' };
  const local = { title: p.title || '', artist: p.artist || '', album: p.album || '', duration: (p.duration || 0) * 1000 };
  const PROVIDERS = ['wy', 'kg', 'kw', 'tx', 'mg'];
  const settled = await Promise.allSettled(PROVIDERS.map((pr) =>
    streaming.search({ provider: pr, keywords: kw, page: 1, limit: 5 })));
  let best = null;
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value || !r.value.songs) return;
    r.value.songs.forEach((song) => {
      const sc = scoreMatch(local, song);
      if (!best || sc > best.score) best = { provider: PROVIDERS[i], song, score: sc };
    });
  });
  if (!best || best.score < (minScore || 60)) return { ok: false, reason: '五源未找到足够相似的结果', best: best && best.score };
  const lr = await streaming.lyric({ provider: best.provider, song: best.song }).catch(() => null);
  if (!lr || !lr.lrc) return { ok: false, reason: '匹配到曲目但该平台无歌词' };
  return {
    ok: true, lrc: lr.lrc, tlyric: lr.tlyric || '',
    matched: { provider: best.provider, name: best.song.name, artist: best.song.artist, score: best.score },
  };
}

/** V4.4.3（M3）：下载/跳过后后处理——写标签+封面+嵌入歌词+旁挂 .lrc。fill 计数随 end 事件带给渲染层汇总。 */
function makePostProcessor(fill) {
  return async function post(item, dest) {
    const artist = (item.performer && item.performer.name) || item.albumArtist || '';
    const albumName = item.albumTitle || (item.album && item.album.title) || '';
    // 1) 歌词补全：五源兜底（阈值 80，落盘宁缺毋滥）
    let lrc = '', tlyric = '';
    const ly = await lyricMatch({ title: item.title || '', artist, album: albumName, duration: item.duration || 0 }, 80).catch(() => null);
    if (ly && ly.ok && ly.lrc) { lrc = ly.lrc; tlyric = ly.tlyric || ''; fill.lyric++; }
    else fill.lyricMiss++;
    // 2) 写标签 + 封面 + 嵌入歌词（tagWriter 与洛雪下载链同一实现；失败只留痕不影响下载成功计数）
    const tg = await tagWriter.writeTags({
      dest,
      title: item.title, artist, album: albumName,
      albumArtist: item.albumArtist || artist,
      track: item.track_number, disc: item.media_number,
      date: item.releaseDate || (item.album && item.album.release_date_original ? String(item.album.release_date_original).slice(0, 10) : ''),
      genre: item.genre || (item.album && item.album.genre && item.album.genre.name) || '',
      composer: (item.composer && item.composer.name) || '',
      publisher: item.publisher || (item.album && item.album.label && item.album.label.name) || '',
      coverUrl: item.coverUrl || coverUrlOf(item.album),
      httpFetch: qzFetch, // V4.6.8：封面同走 net.fetch；Node 全局 fetch 不读系统代理会直连超时
      lyrics: lrc, tlyric,
    }).catch((err) => ({ ok: false, reason: String((err && err.message) || err) }));
    if (tg && tg.ok) fill.tagged++;
    else { fill.tagFail++; console.warn('[qobuz-dl] 写标签失败：', dest, tg && tg.reason); }
    // 3) 旁挂 .lrc（与洛雪下载同一约定：同目录同名，编码沿用 GBK/UTF8 设置由 writeLyric 默认 utf8）
    if (lrc) tagWriter.writeLyric({ dest, lrc, tlyric });
    return { tagged: !!(tg && tg.ok), lyric: !!lrc };
  };
}

/* 归一化 + 打分（简化自 main/onlineMatch.js，实验期副本避免动 tracked 文件） */
function normStr(s) {
  return String(s || '').toLowerCase()
    .replace(/[（(【\[][^（）()【】\[\]]*[）)】\]]/g, '')
    .replace(/\s*(feat\.?|featuring)\b.*$/i, '')
    .replace(/[\s\-_·•,，。.!！?？'"、~～]/g, '');
}
function scoreMatch(local, song) {
  let sc = 0;
  const lt = normStr(local.title), ct = normStr(song.name);
  if (lt && ct) { if (lt === ct) sc += 60; else if (lt.includes(ct) || ct.includes(lt)) sc += 35; }
  const la = normStr(local.artist), ca = normStr(song.artist);
  if (la && ca) { if (la === ca) sc += 25; else if (la.includes(ca) || ca.includes(la)) sc += 18; }
  else if (!la) sc += 8;
  if (local.duration > 0 && song.duration > 0) {
    const diff = Math.abs(local.duration - song.duration) / 1000;
    if (diff <= 2) sc += 25; else if (diff <= 5) sc += 12;
  } else if (local.duration <= 0) sc += 8;
  const lm = normStr(local.album), cm = normStr(song.album);
  if (lm && cm && (lm === cm || lm.includes(cm) || cm.includes(lm))) sc += 10;
  return Math.min(100, sc);
}

module.exports = { init };
