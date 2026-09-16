'use strict';
// ============================================================================
// 流媒体统一入口 —— 洛雪全功能版
//   平台能力（搜索/歌词/封面/热搜）：洛雪 musicSdk 原版 (lxsdk.js → lx-sdk/)
//   播放 URL：用户导入的音源脚本优先（sources.js 沙箱），洛雪测试接口兜底
//   下载：解析直链后落盘到本地曲库目录
// 安妮自研的 netease/qq 流媒体模块已剔除。
// ============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const sources = require('./sources');
const lxsdk = require('./lxsdk');
const tagWriter = require('../tagWriter');

const PROVIDERS = lxsdk.PROVIDERS;

let settingsFile = null;
let streamSettings = { downloadDir: '' };

function init(app) {
  sources.init(app); // 加载已导入的自定义音源
  settingsFile = path.join(app.getPath('userData'), 'stream-settings.json');
  try { streamSettings = { downloadDir: '', ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { }
  // 预热洛雪 SDK（异步，不阻塞启动）
  lxsdk.loadSdk().catch((e) => console.warn('[lxsdk] 预加载失败:', e.message));
}

function saveStreamSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(streamSettings, null, 2), 'utf8'); } catch { }
}

async function search({ provider, keywords, page, limit }) {
  return lxsdk.search({ provider, keywords, page: page || 1, limit: limit || 30 });
}

async function songUrl(params) {
  return lxsdk.songUrl(params);
}

async function lyric(params) {
  return lxsdk.lyric(params);
}

async function getPic(params) {
  return lxsdk.getPic(params);
}

/* 发现音乐：排行榜 / 歌单广场（V3.5.4） */
async function leaderboards(params) { return lxsdk.leaderboards(params); }
async function leaderboardList(params) { return lxsdk.leaderboardList(params); }
async function songLists(params) { return lxsdk.songLists(params); }
async function songListDetail(params) { return lxsdk.songListDetail(params); }

/**
 * 封面代理：把 HTTP(S) 图片转成 dataURL 交给渲染层。
 * 用途：kwcdn.kuwo.cn 的 https 证书无效、部分 CDN 图被 CSP 拦 http——
 * 主进程 Node fetch 走系统 TLS/直连能取到，转 data: 后渲染层 img-src 放行。
 * 带 10 秒超时 + 大小上限（8MB），失败返回空串由调用方回退。
 * V3.1：LRU 缓存（200 条）——列表滚动/切歌重复请求同一批封面不再重复 fetch。
 */
const COVER_CACHE_MAX = 200;
const coverCache = new Map(); // url -> Promise<{url,...}>（存 Promise 合并并发同求）
async function coverProxy(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { url: '', error: 'bad-url' };
  const hit = coverCache.get(u);
  if (hit) { coverCache.delete(u); coverCache.set(u, hit); return hit; } // LRU 触热
  const p = coverProxyFetch(u);
  coverCache.set(u, p);
  if (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value);
  // 失败结果不驻留缓存（网络抖动后下次还能重试）
  p.catch(() => {}).then(r => { if (r && r.error) coverCache.delete(u); });
  return p;
}
async function coverProxyFetch(u) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(u, { signal: ctrl.signal });
    clearTimeout(to);
    if (!resp.ok) return { url: '', error: 'http-' + resp.status };
    const type = (resp.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//i.test(type)) return { url: '', error: 'not-image:' + type };
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return { url: '', error: 'too-large' };
    return { url: `data:${type};base64,${buf.toString('base64')}` };
  } catch (e) {
    return { url: '', error: String((e && e.message) || e).slice(0, 80) };
  }
}

async function hotSearch(params) {
  return lxsdk.hotSearch(params);
}

/* ---------------- 下载 ---------------- */

function sanitizeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

/** 下载目录：用户自定义优先，默认 系统音乐文件夹/AnniePlayerSVLX Downloads */
function downloadDir() {
  const custom = streamSettings.downloadDir;
  const dir = custom || path.join(os.homedir(), 'Music', 'AnniePlayerSVLX Downloads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 设置自定义下载目录（空字符串恢复默认） */
function setDownloadDir(dir) {
  streamSettings.downloadDir = dir || '';
  saveStreamSettings();
  return downloadDir();
}

/**
 * 下载在线曲目到本地曲库目录。
 * @param params { provider, quality, song }
 * @param onProgress (receivedBytes, totalBytes) => void
 */
async function download(params, onProgress) {
  const r = await songUrl(params);
  if (!r || !r.playable || !r.url) throw new Error((r && r.message) || '无法获取下载地址');
  const song = params.song || {};
  const ext = (r.format && /^[a-z0-9]+$/i.test(r.format) ? r.format : (r.url.split('?')[0].split('.').pop() || 'mp3')).toLowerCase();
  const fileName = sanitizeFileName(`${song.artist || '未知艺人'} - ${song.name || song.id}`) + '.' + ext;
  let dest = path.join(downloadDir(), fileName);
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(downloadDir(), fileName.replace(new RegExp(`\\.${ext}$`), ` (${n++}).${ext}`));
  }

  const headers = {};
  if (r.headers) {
    for (const line of String(r.headers).split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  const resp = await fetch(r.url, { headers });
  if (!resp.ok || !resp.body) throw new Error('下载失败：HTTP ' + resp.status);
  const total = Number(resp.headers.get('content-length') || 0);
  const out = fs.createWriteStream(dest);
  const reader = resp.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) await new Promise((res) => out.once('drain', res));
      if (onProgress) onProgress(received, total);
    }
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(dest); } catch { }
    throw e;
  }
  await new Promise((res) => out.end(res));

  // V1.1.10：下载后写元数据——封面/标题/歌手/专辑/专辑艺术家/曲目号/碟号/发行时间 + 歌词。
  // 附加项受设置页开关控制：saveLrc（旁挂 .lrc + 嵌入）/ saveCover（嵌入封面）。
  // 全部尽力而为：任何一步失败都不阻塞下载成功返回。
  const tagged = await writeDownloadedTags(dest, song, params.provider, {
    saveLrc: params.saveLrc !== false,
    saveCover: params.saveCover !== false,
  }).catch(() => false);

  return { ok: true, path: dest, size: received, quality: r.quality || '', level: r.level, downgraded: !!r.downgraded, requestedType: r.requestedType, tagged: !!tagged };
}

/**
 * 下载后处理：写音频标签（含封面）+ 旁挂 .lrc 歌词。
 * 元数据来源：song 已有字段（标题/歌手/专辑）+ 专辑详情接口补全（曲目号/碟号/发行时间/专辑艺术家）+ 歌词接口。
 * @returns {Promise<boolean>} 是否成功写入标签
 */
async function writeDownloadedTags(dest, song, provider, opts) {
  opts = opts || {};
  const wantLrc = opts.saveLrc !== false;     // 是否生成旁挂 .lrc 文件
  const wantCover = opts.saveCover !== false; // 是否生成独立封面图片文件
  try {
    // 1) 补全专辑详情元数据（尽力而为，接口失败返回空字段）
    const detail = await lxsdk.albumDetail({ provider, song }).catch(() => ({}));
    // 2) 拉歌词（嵌入标签始终做；旁挂 .lrc 受 saveLrc 控制）
    let lrc = '';
    try {
      const lr = await lxsdk.lyric({ provider, song });
      if (lr && lr.lrc) lrc = lr.lrc;
    } catch { }
    // 3) 封面：song.cover 可能为空（kw/kg 搜索 img:null）→ getPic 补全（嵌入始终做）
    let coverUrl = (song && (song.cover || (song.meta && song.meta.img))) || '';
    if (!coverUrl) {
      try {
        const pc = await lxsdk.getPic({ provider, song });
        if (pc && pc.url) coverUrl = pc.url;
      } catch { }
    }
    // 封面字节：既用于嵌入，也用于 saveCover 时落盘独立文件
    let coverBuf = null;
    if (coverUrl) coverBuf = await tagWriter.fetchCoverBytes(coverUrl).catch(() => null);
    // 4) 写标签：嵌入歌词（FLAC LYRICS / MP3 USLT）+ 嵌入封面（attached_pic），始终执行
    const tagRes = await tagWriter.writeTags({
      dest,
      title: song && (song.name || (song.meta && song.meta.name)),
      artist: song && (song.artist || (song.meta && song.meta.singer)),
      album: (song && (song.album || (song.meta && song.meta.albumName))) || (detail && detail.albumName),
      albumArtist: (detail && detail.albumArtist) || (song && song.artist),
      track: detail && detail.track,
      disc: detail && detail.disc,
      date: detail && detail.date,
      lyrics: lrc,
      coverUrl,
      coverBytes: coverBuf,
    }).catch(() => ({ ok: false }));
    // 5) 独立文件（受开关控制）：
    //    - saveLrc   → 旁挂同名 .lrc
    //    - saveCover → 独立封面图片文件（同名 .jpg/.png）
    if (wantLrc && lrc && lrc.trim()) tagWriter.writeLyric({ dest, lrc, tlyric: '' });
    if (wantCover && coverBuf) tagWriter.writeCoverFile({ dest, coverBytes: coverBuf });
    return tagRes && tagRes.ok;
  } catch (e) {
    console.warn('[streaming] 写下载元数据失败(不阻塞):', e && e.message);
    return false;
  }
}

module.exports = {
  init, search, songUrl, lyric, getPic, coverProxy, hotSearch, download, downloadDir, setDownloadDir,
  leaderboards, leaderboardList, songLists, songListDetail,
  PROVIDERS,
  sources, // 音源管理 API 透出给 IPC 层
};
