// ===== Apple Music 音源（章鱼解密链路）· 主进程挂载 =====
// V4.6：第三大在线音源。模块本体在 ./（downloader/service 等，章鱼侧交付），
// 这里负责：service 懒启动（wasmPath dev/打包双路径 + net.fetch 注入）、
// Track→安妮 song 契约映射、IPC 通道族（am:*）。
'use strict';
const path = require('path');
const dl = require('./downloader.js');
const { createAmService } = require('./service.js');

let svc = null;          // 播放服务单例（懒启动）
let svcStarting = null;  // 并发启动合并
let appRef = null;       // 惰性取 userData 路径（不必顶层 require electron）

/* net.fetch 适配器（惰性 require electron——CI 纯 Node 测试顶层没有 electron 包） */
function amFetch(url, opts) {
  const { net } = require('electron');
  return net.fetch(url, opts);
}

function wasmPath() {
  // dev：模块同目录；打包：asar 外 extraResources（electron-builder 配置 resources/am/temari.wasm）
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.join(process.resourcesPath, 'am', 'temari.wasm');
  } catch { }
  return path.join(__dirname, 'temari.wasm');
}

async function ensureService() {
  if (svc) return svc;
  if (svcStarting) return svcStarting;
  /* wrapper 地址：优先用 amWrapper 解析到的实际监听地址（启动脚本可能改端口），缺省 12340 */
  let wUrl = 'http://127.0.0.1:12340';
  try {
    const amWrapper = require('../../amWrapper');
    const st = await amWrapper.status();
    if (st && st.url) wUrl = st.url;
  } catch { }
  svcStarting = createAmService({
    wasmPath: wasmPath(),
    wrapperUrl: wUrl,
    apiKey: '',
    fetchImpl: amFetch,
  }).then((s) => { svc = s; svcStarting = null; return s; })
    .catch((e) => { svcStarting = null; throw e; });
  return svcStarting;
}

/* 章鱼 Track → 安妮 song 契约（name 而非 title、duration 毫秒、provider 键） */
function toSong(t) {
  const cov = t.artwork
    ? String(t.artwork).replace('{w}x{h}', '300x300') + (/\.(jpg|png|webp)$/i.test(t.artwork) ? '' : '.jpg')
    : '';
  return {
    name: t.title || '', artist: t.artist || '', album: t.album || '',
    cover: cov, duration: t.durationMs || 0,
    provider: 'am', id: String(t.adamId || ''),
    _am: t, // 完整 Track（下载时要完整元数据）
  };
}

function register(ipcMain) {
  /* wrapper-lite 健康检查（渲染层轮询引导） */
  ipcMain.handle('am:status', async () => {
    try {
      const s = await dl.wrapperStatus();
      return { ok: true, wrapper: s, serviceOn: !!svc, serviceUrl: svc ? svc.url : '' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), serviceOn: !!svc };
    }
  });

  /* 搜索（走 amp-api 官方 catalog，token 自抓） */
  ipcMain.handle('am:search', async (_e, p) => {
    const r = await dl.search(String((p && p.keywords) || ''), (p && p.storefront) || 'cn', (p && p.limit) || 25);
    return { songs: (r.songs || []).map(toSong), albums: r.albums || [] };
  });

  /* 链接/ID 解析（song/album/playlist → 曲目列表） */
  ipcMain.handle('am:resolve', async (_e, input) => {
    const r = await dl.resolve(String(input || ''));
    return { kind: r.kind, album: r.album || null, tracks: (r.tracks || []).map(toSong) };
  });

  /* 编码探测（一首歌有哪些音质可选） */
  ipcMain.handle('am:probeCodecs', async (_e, adamId) => dl.probeCodecs(String(adamId || '')));

  /* 歌词三轨（lyric 正文 / tlyric 翻译 / rlyric 罗马音） */
  ipcMain.handle('am:lyric', async (_e, p) => {
    const r = await dl.fetchLyricsSplit(String((p && p.id) || ''), (p && p.lang) || 'zh-Hans');
    return { lrc: r.lyric || '', tlyric: r.tlyric || '', rlyric: r.rlyric || '' };
  });

  /* 封面（返回 dataURL，渲染层直接 <img>） */
  ipcMain.handle('am:getPic', async (_e, p) => {
    const t = (p && p.song && p.song._am) || null;
    const art = t ? t.artwork : (p && p.artwork) || '';
    if (!art) return { url: '' };
    const cov = await dl.fetchCover(art, 600, 'jpeg', t ? t.artworkSize : 0);
    if (!cov || !cov.data) return { url: '' };
    return { url: 'data:image/' + (cov.type || 'jpeg') + ';base64,' + cov.data.toString('base64') };
  });

  /* 播放地址：懒启动服务 → 返回本地 HTTP 流地址（AAC=Range 支持 seek 瞬时；ALAC=流式，seek 重发新流） */
  ipcMain.handle('am:songUrl', async (_e, p) => {
    const song = (p && p.song) || {};
    const id = String(song.id || (song._am && song._am.adamId) || '');
    if (!id) return { playable: false, message: '缺少 adamId' };
    // P2：播放音质由调用方（渲染层 doPlay）经 params.codec 传入（aac / alac）
    const codec = (p && p.codec === 'alac') ? 'alac' : 'aac';
    try {
      const s = await ensureService();
      return {
        playable: true,
        url: s.url + '/am/' + id + '?codec=' + codec,
        headers: {},
        quality: codec === 'alac' ? 'ALAC 无损' : 'AAC 256K',
        format: codec,
      };
    } catch (e) {
      return { playable: false, message: String((e && e.message) || e) };
    }
  });

  /* 播放服务预启动（设置页可手动触发；进 AM 视图时自动暖） */
  ipcMain.handle('am:ensureService', async () => {
    try { const s = await ensureService(); return { ok: true, url: s.url }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  /* 预热下一首 playlist（切歌加速：后台提前解析 master/media playlist，命中缓存首 chunk 秒出） */
  ipcMain.handle('am:prefetch', async (_e, p) => {
    const id = String((p && p.id) || (p && p.song && p.song.id) || '');
    if (!id) return { ok: false };
    const codec = (p && p.codec === 'alac') ? 'alac' : 'aac';
    await dl.prefetch(id, codec);
    return { ok: true };
  });

  /* 播放加载进度（V4.6 进度卡；渲染层 CSP 禁止直连 127.0.0.1，改走 IPC 读主进程内存） */
  ipcMain.handle('am:progress', (_e, p) => {
    const id = String((p && p.id) || (p && p.adamId) || '');
    const codec = (p && p.codec === 'alac') ? 'alac' : 'aac';
    return dl.getProgress(id, codec) || { stage: 'idle' };
  });
}

/* 应用退出时关服务 */
function shutdown() {
  try { if (svc) svc.close(); } catch { }
  svc = null;
}

/* ===== 下载（P1：AAC / ALAC 可选，downloadTrack 全管线含标签/封面/歌词） =====
 * dlManager 经 streaming/index.js download() 路由到这里（provider === 'am'）。
 * 与通用路径不同：不走 URL 流式写盘，而是 downloadTrack 直接拿 Buffer 一次性落盘。 */
const fs = require('fs');

function downloadDirFallback() {
  // 与 streaming/index.js downloadDir() 同规则：设置页可改，缺省 ~/Music/安妮播放器
  try {
    const { app } = require('electron');
    return require('path').join(app.getPath('music'), '安妮播放器');
  } catch { return process.cwd(); }
}

async function downloadTrackWithTags(params, onProgress) {
  const song = (params && params.song) || {};
  const t = song._am || null;
  const adamId = String(song.id || (t && t.adamId) || '');
  if (!adamId) throw new Error('缺少 adamId');
  // 音质映射：安妮 quality 字段 → 章鱼 codec（全档位：aac / aac128 / he-aac / alac / atmos）
  const q = String((params && params.quality) || 'aac').toLowerCase();
  const CODEC_MAP = { 'aac': 'aac', 'aac256': 'aac', 'aac128': 'aac128', 'he-aac': 'he-aac', 'heaac': 'he-aac', 'alac': 'alac', '无损': 'alac', 'flac': 'alac', 'atmos': 'atmos', '杜比全景声': 'atmos' };
  const codec = CODEC_MAP[q] || 'aac';
  const QLABELS = { 'aac': 'AAC 256K', 'aac128': 'AAC 128K', 'he-aac': 'HE-AAC 64K', 'alac': 'ALAC 无损', 'atmos': '杜比全景声' };
  const res = await dl.downloadTrack(t || { adamId: adamId, title: song.name || '', artist: song.artist || '', album: song.album || '' }, {
    codec: codec,
    wasmPath: wasmPath(),
    saveLyrics: params.saveLrc !== false,
    lyricLang: 'zh-Hans',
    lyricsExtra: ['translation', 'pronunciation'],
    alacFix: true, remux: true,
  }, function (pg) {
    // 章鱼进度 {phase, done, total} → dlManager 进度（received, total）
    if (onProgress && pg && pg.total) onProgress(pg.done, pg.total);
  });
  // 落盘（目录与命名规则对齐通用路径）
  const ext = codec === 'alac' ? 'm4a' : 'm4a'; // 章鱼产物统一 MP4 容器（AAC/ALAC 同扩展名）
  const base = (song.artist || '未知艺人') + ' - ' + (song.name || adamId);
  const sanitize = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');
  let dest = require('path').join(downloadDirFallback(), sanitize(base) + '.' + ext);
  let n = 1;
  while (fs.existsSync(dest)) dest = require('path').join(downloadDirFallback(), sanitize(base) + ' (' + (n++) + ').' + ext);
  fs.writeFileSync(dest, res.file);
  // 旁挂歌词（saveLrc 控制）
  if (params.saveLrc !== false && res.lyrics && res.lyrics.lrc) {
    try { fs.writeFileSync(dest.replace(/\.[^.]+$/, '.lrc'), res.lyrics.lrc, 'utf8'); } catch { }
  }
  return { ok: true, path: dest, size: res.file.length, quality: QLABELS[codec] || 'AAC 256K', tagged: true };
}

module.exports = { register, shutdown, ensureService, downloadTrackWithTags };
