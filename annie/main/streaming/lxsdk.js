'use strict';
// ============================================================================
// 洛雪 musicSdk CJS 门面层
// 通过 module.register 注册 ESM loader（别名 + 扩展名省略解析），
// 再动态 import 洛雪原版 SDK（lx-sdk/），向流媒体层暴露统一接口。
// 播放 URL 解析顺序与洛雪 2.x 一致：用户导入的音源脚本优先；
// 无音源时回退到洛雪测试接口（ts.tempmusics.tk）。
// ============================================================================
const path = require('path');
const { pathToFileURL } = require('url');
const sources = require('./sources');
const { httpFetch } = require('./lx-http');

const PROVIDERS = ['kg', 'kw', 'mg', 'tx', 'wy'];
const PROVIDER_NAMES = { kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐', tx: 'QQ 音乐', wy: '网易云音乐' };
const QUALITY_ORDER = ['flac24bit', 'flac', '320k', '128k'];
const QUALITY_LABEL = { flac24bit: 'Hi-Res 24bit', flac: '无损 FLAC', '320k': '极高 320k', '128k': '标准 128k' };
// 安妮音质档 → 洛雪 type
const ANNIE_TO_TYPE = { hires: 'flac24bit', lossless: 'flac', exhigh: '320k', standard: '128k' };

let sdkPromise = null;

/** 注册 loader 并加载洛雪 SDK（幂等） */
function loadSdk() {
  if (!sdkPromise) {
    const { register } = require('node:module');
    register(pathToFileURL(path.join(__dirname, 'lxsdk-loader.mjs')));
    sdkPromise = import(pathToFileURL(path.join(__dirname, 'lxsdk-entry.mjs')).href);
  }
  return sdkPromise;
}

/** 音源桥：SDK 的 apis(source) 经 globalThis.__svlxApis 调到自定义音源运行时 */
let lastSourceName = ''; // 最近一次成功响应的自定义音源名（音质标签展示用）
globalThis.__svlxApis = {
  async call(source, action, info) {
    const r = await sources.handleRequest(action, { source, info });
    lastSourceName = r.sourceName || '';
    return r.result;
  },
};

/* ---------------- 归一化 ---------------- */
function intervalToSec(interval) {
  if (!interval) return 0;
  if (typeof interval === 'number') return interval;
  const parts = String(interval).split(':');
  let total = 0, unit = 1;
  while (parts.length) { total += parseInt(parts.pop()) * unit; unit *= 60; }
  return total;
}

function deriveId(source, info) {
  switch (source) {
    case 'kg': return `${info.songmid}|${info.hash}`;
    case 'mg': return String(info.copyrightId);
    default: return String(info.songmid);
  }
}

/** CDN 封面统一升级为 https：页面 CSP img-src 仅放行 https，http 图（酷狗/网易）会被浏览器拦截。
 * 例外：kwcdn.kuwo.cn 的 https 证书无效（TLS 握手失败，实测），只能走 http——
 * 渲染层会经主进程 coverProxy 转 dataURL 加载（CSP 放行 data:）。 */
function httpsCover(url) {
  const s = String(url || '');
  if (/kwcdn\.kuwo\.cn/i.test(s)) return s; // 酷我封面：https 打不开，保留 http 由代理转
  return s.replace(/^http:\/\//i, 'https://');
}

/** LX musicInfo → 安妮流媒体歌曲对象（meta 完整透传，音源脚本需要原始字段） */
function normalize(source, info) {
  return {
    provider: source,
    id: deriveId(source, info),
    name: info.name || '',
    artist: info.singer || '',
    album: info.albumName || '',
    cover: httpsCover(info.img || ''),
    duration: (info._interval || intervalToSec(info.interval)) * 1000,
    interval: info.interval || '',
    types: info.types || [], // [{type:'flac24bit'|'flac'|'320k'|'128k', size, hash?}]
    meta: info,
  };
}

/** 待试音质序列：从请求档位开始只向下回退（flac24bit → flac → 320k → 128k） */
function qualityCandidates(quality, meta) {
  const want = ANNIE_TO_TYPE[quality] || 'flac';
  const startIdx = Math.max(0, QUALITY_ORDER.indexOf(want));
  const downChain = QUALITY_ORDER.slice(startIdx);
  const avail = new Set((meta.types || []).map((t) => t.type));
  const filtered = downChain.filter((t) => !avail.size || avail.has(t));
  return filtered.length ? filtered : downChain;
}

/* ---------------- 洛雪测试接口兜底 ---------------- */
function tempProxyUrl(provider, meta, type) {
  let id;
  switch (provider) {
    case 'kg': id = (meta._types && meta._types[type] && meta._types[type].hash) || meta.hash; break;
    case 'kw': id = meta.songmid; break;
    case 'mg': id = meta.copyrightId; break;
    case 'tx': id = meta.songmid; break;
    case 'wy': id = meta.songmid; break;
    default: return null;
  }
  if (!id) return null;
  return `http://ts.tempmusics.tk/url/${provider}/${id}/${type}`;
}

async function tryTempProxy(provider, meta, type) {
  const url = tempProxyUrl(provider, meta, type);
  if (!url) return null;
  try {
    const { body, statusCode } = await httpFetch(url).promise;
    if (statusCode === 200 && body && body.code === 0 && body.data) return body.data;
  } catch { }
  return null;
}

/* ---------------- URL 实际格式校验 ----------------
 * 部分音源脚本无视 info.type，请求 flac 也返回 mp3。
 * 校验规则：请求无损档(flac/flac24bit)时，URL 明确是 mp3/m4a → 判定不符；
 * 无法判断（无扩展名且 HEAD 无 Content-Type）时放行。
 */
function urlExt(url) {
  return (url.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
}

async function verifyUrlFormat(url, type) {
  const wantLossless = type === 'flac' || type === 'flac24bit';
  const ext = urlExt(url);
  if (ext === 'flac') return wantLossless;
  if (ext === 'mp3' || ext === 'm4a' || ext === 'aac') return !wantLossless;
  if (ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext) && ext !== 'com' && ext !== 'net') {
    // 其他已知扩展名（如 ape/wav 极少出现）——无损档放行
    if (ext === 'ape' || ext === 'wav' || ext === 'dsf') return wantLossless;
  }
  // 无有效扩展名 → HEAD 探测 Content-Type
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('flac') || ct.includes('x-flac')) return wantLossless;
    if (ct.includes('mpeg') || ct.includes('mp3') || ct.includes('mp4') || ct.includes('aac')) return !wantLossless;
  } catch { }
  return true; // 无法判断时放行
}

/* ---------------- 对外 API ---------------- */

/** tx 免签搜索：洛雪内置的 DoSearchForQQMusicMobile 已被 QQ 风控（req.code=2001 反复重试后"搜索失败"）。
 * 改用老版免签接口 c.y.qq.com/soso/fcgi-bin/client_search_cp（实测可用，含 size128/320/flac 与 songmid/media_mid）。 */
async function txSearchFallback(keywords, page, limit) {
  const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp' +
    '?format=json&p=' + (page || 1) + '&n=' + (limit || 30) +
    '&w=' + encodeURIComponent(keywords) +
    '&cr=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0&remoteplace=txt.yqq.center';
  const { httpFetch } = require('./lx-http');
  const resp = await httpFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://y.qq.com/' },
  }).promise;
  const body = resp && resp.body;
  if (!body || body.code !== 0 || !body.data || !body.data.song || !body.data.song.list) {
    throw new Error('tx 搜索失败: ' + ((body && body.code) || 'no-data'));
  }
  const rawList = body.data.song.list || [];
  const list = [];
  for (const item of rawList) {
    if (!item.songmid || !item.strMediaMid || !item.media_mid) continue;
    const types = [];
    const _types = {};
    const file = {
      size_128mp3: item.size128 || 0,
      size_320mp3: item.size320 || 0,
      size_flac: item.sizeflac || 0,
      size_hires: item.sizehires || 0,
      media_mid: item.strMediaMid || item.media_mid,
    };
    if (file.size_128mp3 != 0) { types.push({ type: '128k', size: fmtSize(file.size_128mp3) }); _types['128k'] = { size: fmtSize(file.size_128mp3) }; }
    if (file.size_320mp3 != 0) { types.push({ type: '320k', size: fmtSize(file.size_320mp3) }); _types['320k'] = { size: fmtSize(file.size_320mp3) }; }
    if (file.size_flac != 0) { types.push({ type: 'flac', size: fmtSize(file.size_flac) }); _types.flac = { size: fmtSize(file.size_flac) }; }
    if (file.size_hires != 0) { types.push({ type: 'flac24bit', size: fmtSize(file.size_hires) }); _types.flac24bit = { size: fmtSize(file.size_hires) }; }
    const singers = (item.singer || []).map(s => s.name).filter(Boolean);
    const albumMid = item.albummid || '';
    const albumName = item.albumname || '';
    list.push({
      singer: singers.join(','),
      name: item.songname || '',
      albumName,
      albumId: albumMid,
      source: 'tx',
      interval: fmtInterval(item.interval),
      songId: item.songid != null ? String(item.songid) : '',
      albumMid,
      strMediaMid: file.media_mid,
      songmid: item.songmid,
      img: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : '',
      types, _types, typeUrl: {},
      // 附加：碟号/曲目号/发行时间（免签接口独有，写下载标签用）
      belongCD: item.belongCD != null ? String(item.belongCD) : '',
      cdIdx: item.cdIdx != null ? String(item.cdIdx) : '',
      pubtime: item.pubtime || 0,
    });
  }
  const total = body.data.song.totalnum || list.length;
  return { list, total, allPage: Math.ceil(total / (limit || 30)) || 1 };
}

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '0B';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return bytes + 'B';
}

function fmtInterval(sec) {
  sec = Number(sec) || 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

async function search({ provider, keywords, page = 1, limit = 30 }) {
  if (!PROVIDERS.includes(provider)) throw new Error('未知平台: ' + provider);
  if (provider === 'tx') {
    // V1.1.10：tx 内置搜索被风控 → 免签接口替代
    const r = await txSearchFallback(keywords, page, limit);
    return {
      provider,
      songs: (r.list || []).map((info) => normalize(provider, info)),
      total: r.total || 0,
      allPage: r.allPage || 1,
      page,
    };
  }
  const sdk = await loadSdk();
  const mod = sdk[provider];
  const r = await mod.musicSearch.search(keywords, page, limit);
  return {
    provider,
    songs: (r.list || []).map((info) => normalize(provider, info)),
    total: r.total || 0,
    allPage: r.allPage || 1,
    page,
  };
}

async function songUrl({ provider, song, quality = 'hires' }) {
  const meta = (song && song.meta) || song || {};
  const candidates = qualityCandidates(quality, meta);
  const requested = candidates[0];
  const sdk = await loadSdk();
  const mod = sdk[provider];
  if (!mod) throw new Error('未知平台: ' + provider);

  let lastErr = null;
  for (const type of candidates) {
    // 1) 用户音源（洛雪模式：apis() → user_api）
    if (sources.hasActiveSource()) {
      try {
        const r = await mod.getMusicUrl(meta, type);
        const url = typeof r === 'string' ? r : (r && r.url);
        if (url && /^https?:\/\//.test(url)) {
          // 格式校验：请求无损却返回 mp3 时视为该档失败，继续向下回退
          if (!(await verifyUrlFormat(url, type))) {
            lastErr = new Error(`音源返回的 ${urlExt(url) || '未知格式'} 与请求音质 ${type} 不符`);
            console.warn('[lxsdk] 格式不符，降级:', type, '→', url.slice(0, 120));
          } else {
            return {
              provider, playable: true, url, headers: '',
              quality: `${lastSourceName || '音源'}·${QUALITY_LABEL[type] || type}`,
              format: (urlExt(url) || 'mp3').toLowerCase(),
              level: type, viaSource: true,
              requestedType: requested,
              downgraded: type !== requested, // 实际音质低于所选档位时为 true
            };
          }
        } else {
          lastErr = new Error('音源未返回有效地址');
        }
      } catch (e) { lastErr = e; }
    }
    // 2) 洛雪测试接口兜底
    const url = await tryTempProxy(provider, meta, type);
    if (url && (await verifyUrlFormat(url, type))) {
      return {
        provider, playable: true, url, headers: '',
        quality: QUALITY_LABEL[type] || type,
        format: (urlExt(url) || 'mp3').toLowerCase(),
        level: type, viaSource: false,
        requestedType: requested,
        downgraded: type !== requested,
      };
    }
  }
  return {
    provider, playable: false,
    requestedType: requested,
    message: `${QUALITY_LABEL[requested] || requested} 获取失败${lastErr ? '：' + String(lastErr.message || lastErr) : ''}`,
  };
}

/** 清洗洛雪原版 YRC 元数据行解析 bug 产生的 [NaN:NaN.NaN] 时间戳行（网易云 YRC 无 t 字段的元数据行） */
function cleanLyric(text) {
  if (!text) return '';
  return String(text).split('\n').filter((line) => !/^\[NaN:NaN\.NaN\]/.test(line)).join('\n');
}

async function lyric({ provider, song }) {
  const meta = (song && song.meta) || song || {};
  // V1.1.10：tx 特判——洛雪 SDK 的 tx.getLyric 只传 songmid 字符串，靠 getMusicInfo(songmid)
  // 拿数字 songId；但该详情接口已被 QQ 风控（req.code!=0），歌词必失败。
  // 我们的免签搜索 meta 已带数字 songId，直接用它调 GetPlayLyricInfo + SDK 的 parseLyric 解密。
  if (provider === 'tx') {
    try {
      const lr = await txLyricBySongId(meta);
      if (lr && lr.lrc) return lr;
    } catch (e) { console.warn('[lxsdk] tx 歌词获取失败:', e && e.message); }
  }
  const sdk = await loadSdk();
  const mod = sdk[provider];
  if (!mod) throw new Error('未知平台: ' + provider);
  // 1) 平台官方歌词（洛雪内置实现）
  // 注意：洛雪 SDK 的 getLyric 返回 requestObj（{promise, cancelHttp}）而非 Promise，
  // 直接 await 只会拿到对象本身导致 r.lyric 永远 undefined；此处兼容两种形态。
  try {
    const raw = mod.getLyric(meta);
    const r = (raw && typeof raw.then === 'function') ? await raw : await raw.promise;
    if (r && r.lyric) return { provider, lrc: cleanLyric(r.lyric), tlyric: cleanLyric(r.tlyric || ''), rlyric: cleanLyric(r.rlyric || ''), lxlyric: cleanLyric(r.lxlyric || '') };
  } catch (e) { console.warn('[lxsdk] 平台歌词获取失败:', e && e.message); }
  // 2) 自定义音源兜底
  if (sources.hasActiveSource()) {
    try {
      const { result } = await sources.handleRequest('lyric', { source: provider, info: { musicInfo: meta } });
      if (result && result.lyric) return { provider, lrc: result.lyric, tlyric: result.tlyric || '', viaSource: true };
    } catch { }
  }
  return { provider, lrc: '' };
}

/** tx 歌词：直接用数字 songId 调 GetPlayLyricInfo（绕过被风控的 getMusicInfo），复用 SDK parseLyric 解密 */
async function txLyricBySongId(meta) {
  const songId = meta.songId || meta.songid;
  if (songId == null || songId === '') return { provider: 'tx', lrc: '' };
  const { httpFetch } = require('./lx-http');
  const resp = await httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: { referer: 'https://y.qq.com', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 Chrome/86.0.4240.198 Safari/537.36' },
    body: {
      comm: { ct: '19', cv: '1859', uin: '0' },
      req: { method: 'GetPlayLyricInfo', module: 'music.musichallSong.PlayLyricInfo', param: { format: 'json', crypt: 1, ct: 19, cv: 1873, interval: 0, lrc_t: 0, qrc: 1, qrc_t: 0, roma: 1, roma_t: 0, songID: Number(songId), trans: 1, trans_t: 0, type: -1 } },
    },
  }).promise;
  const body = resp && resp.body;
  if (!body || body.code !== 0 || !body.req || body.req.code !== 0) {
    throw new Error('tx 歌词接口失败: ' + ((body && body.req && body.req.code) || (body && body.code) || 'no-data'));
  }
  const data = body.req.data || {};
  // 复用洛雪 SDK 的 parseLyric（内含 qrc 解密：原生模块 → 纯 JS 3DES 降级）
  const lyricMod = await import(pathToFileURL(path.join(__dirname, 'lx-sdk/tx/lyric.js')).href);
  const parsed = await lyricMod.default.parseLyric(data.lyric, data.trans, data.roma);
  const lrc = (parsed && parsed.lyric) || '';
  const tlyric = (parsed && parsed.tlyric) || '';
  if (!lrc && !tlyric) return { provider: 'tx', lrc: '' };
  return { provider: 'tx', lrc: cleanLyric(lrc), tlyric: cleanLyric(tlyric), rlyric: cleanLyric((parsed && parsed.rlyric) || ''), lxlyric: cleanLyric((parsed && parsed.lxlyric) || '') };
}

async function getPic({ provider, song }) {
  const meta = (song && song.meta) || song || {};
  if (meta.img) return { provider, url: httpsCover(meta.img) };
  try {
    const sdk = await loadSdk();
    const mod = sdk[provider];
    const r = await mod.getPic(meta);
    const url = typeof r === 'string' ? r : (r && r.url);
    return { provider, url: httpsCover(url || '') };
  } catch { return { provider, url: '' }; }
}

async function hotSearch({ provider }) {
  const sdk = await loadSdk();
  const mod = sdk[provider];
  if (!mod || !mod.hotSearch) return { provider, list: [] };
  try {
    const r = await mod.hotSearch.getList();
    return { provider, list: (r.list || []).slice(0, 20) };
  } catch { return { provider, list: [] }; }
}

/* ---------------- 专辑详情（写下载元数据用） ----------------
 * 下载后写标签需要曲目号/碟号/发行时间/专辑艺术家。搜索结果的 musicInfo 不含这些字段，
 * 需调各平台专辑详情接口补全。此处尽力而为：取不到就返回空字段，绝不抛错阻塞下载。
 * 字段映射（实测各平台专辑详情接口）：
 *   - kg   getAlbumInfo → publish_date；专辑歌曲列表有序 → track = index+1
 *   - kw   albuminfo → musiclist 有序 → track；body 顶层含 album 名/artist
 *   - mg   queryAlbumSong → songList 有序 → track；getAlbumInfo → singer
 *   - tx   musicu.fcg get_album_detail → 歌曲列表 + 专辑信息
 *   - wy   weapi/v3/song/detail → songs[0] 的 no/cd/publishTime 直接可用（无需专辑接口）
 */
async function albumDetail({ provider, song }) {
  const meta = (song && song.meta) || song || {};
  const out = { provider, track: '', disc: '', date: '', albumArtist: '', albumId: '', albumName: '' };
  try {
    switch (provider) {
      case 'wy': return await wyAlbumDetail(meta, out);
      case 'tx': return await txAlbumDetail(meta, out);
      case 'kg': return await kgAlbumDetail(meta, out);
      case 'kw': return await kwAlbumDetail(meta, out);
      case 'mg': return await mgAlbumDetail(meta, out);
      default: return out;
    }
  } catch { return out; }
}

async function wyAlbumDetail(meta, out) {
  // 网易：歌曲详情 raw songs[0] 直接含 no/cd/publishTime/al（musicInfo 未挂到 wy 模块，需直接 import）
  const songmid = meta.songmid != null ? meta.songmid : meta.id;
  if (songmid == null) return out;
  const mod = await import(pathToFileURL(path.join(__dirname, 'lx-sdk/wy/musicInfo.js')).href);
  const raw = await mod.default(songmid).promise;
  if (raw && raw.no != null) out.track = String(raw.no);
  if (raw && raw.cd != null) out.disc = String(raw.cd);
  if (raw && raw.publishTime) out.date = new Date(raw.publishTime).toISOString().slice(0, 10);
  if (raw && raw.al) { out.albumId = raw.al.id != null ? String(raw.al.id) : ''; out.albumName = raw.al.name || ''; }
  return out;
}

async function txAlbumDetail(meta, out) {
  // V1.1.10：新免签搜索接口的 meta 已带 cdIdx(曲目号)/belongCD(碟号)/pubtime(发行时间)——直接优先使用
  if (meta.cdIdx != null) out.track = String(meta.cdIdx);
  if (meta.belongCD != null) out.disc = String(meta.belongCD);
  if (meta.pubtime) out.date = new Date(meta.pubtime * 1000).toISOString().slice(0, 10);
  // QQ：musicu.fcg get_album_detail 拿专辑信息（专辑名/专辑艺术家——搜索 meta 已有 albumName，这里补 albumArtist/date）
  const albumId = meta.albumId || meta.albumMid || meta.album?.mid;
  if (!albumId) return out;
  const { httpFetch } = require('./lx-http');
  const resp = await httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    body: {
      comm: { ct: '19', cv: '1859', uin: '0' },
      req: { module: 'music.musichallAlbum.AlbumInfoServer', method: 'GetAlbumDetail', param: { albumMid: albumId } },
    },
  }).promise;
  const data = resp && resp.body && resp.body.req && resp.body.req.data;
  if (!data) return out;
  if (data.albumInfo) {
    out.albumName = data.albumInfo.name || out.albumName;
    out.albumArtist = (data.albumInfo.singer && data.albumInfo.singer.map(s => s.name).join(', ')) || '';
    out.date = out.date || data.albumInfo.aDate || data.albumInfo.time_public || '';
    out.albumId = String(albumId);
  }
  return out;
}

async function kgAlbumDetail(meta, out) {
  const albumId = meta.albumId || meta.album_id;
  if (!albumId) return out;
  const sdk = await loadSdk();
  const album = (await import(pathToFileURL(path.join(__dirname, 'lx-sdk/kg/album.js')).href)).default;
  const info = await album.getAlbumInfo(albumId);
  if (info && info.name) out.albumName = info.name;
  // 专辑歌曲列表（有序）定位当前歌 → 曲目号
  const detail = await album.getAlbumDetail(albumId, 1, 500).catch(() => null);
  if (detail && Array.isArray(detail.list)) {
    const hash = meta.hash;
    const idx = detail.list.findIndex(s => s.hash === hash);
    if (idx >= 0) out.track = String(idx + 1);
  }
  return out;
}

async function kwAlbumDetail(meta, out) {
  const albumId = meta.albumId || meta.albumid;
  if (!albumId) return out;
  const { httpFetch } = require('./lx-http');
  const resp = await httpFetch(`http://search.kuwo.cn/r.s?pn=0&rn=1000&stype=albuminfo&albumid=${encodeURIComponent(albumId)}&show_copyright_off=0&encoding=utf&vipver=MUSIC_9.1.0`).promise;
  // kw 响应是 GBK 编码（洛雪 decodeName 用 iconv 处理）。lx-http 保留 raw Buffer，直接按 GBK 解码。
  const raw = resp && resp.raw;
  if (!raw || !raw.length) return out;
  // 实测：kw albuminfo 响应声明 charset=utf-8，原始字节已是 UTF-8（"周杰伦"=e591a8...）。
  // 洛雪 decodeName 的 GBK 处理是针对旧接口；此接口直接按 UTF-8 解码即可。
  const body = raw.toString('utf8');
  try {
    // 该接口返回类 JSON（单引号包裹）。宽松解析关键字段：
    const mAlbum = body.match(/'album':'([^']*)'/);
    const mArtist = body.match(/'artist':'([^']*)'/);
    const mAlbumid = body.match(/'albumid':'([^']*)'/);
    if (mAlbum) out.albumName = mAlbum[1];
    if (mArtist) out.albumArtist = mArtist[1];
    if (mAlbumid) out.albumId = mAlbumid[1];
    // 歌曲列表（有序）定位当前歌 → 曲目号
    const songmid = meta.songmid;
    if (songmid != null) {
      const mm = body.match(/'musiclist':\[(.*)\]/);
      if (mm && mm[1]) {
        const parts = mm[1].split('},{');
        for (let i = 0; i < parts.length; i++) {
          const idm = parts[i].match(/'id':'([^']*)'/);
          if (idm && String(idm[1]) === String(songmid)) { out.track = String(i + 1); break; }
        }
      }
    }
  } catch { }
  return out;
}

async function mgAlbumDetail(meta, out) {
  const albumId = meta.albumId;
  if (!albumId) return out;
  const sdk = await loadSdk();
  const album = (await import(pathToFileURL(path.join(__dirname, 'lx-sdk/mg/album.js')).href)).default;
  const info = await album.getAlbumInfo(albumId).catch(() => null);
  if (info && info.author) out.albumArtist = info.author;
  if (info && info.name) out.albumName = info.name;
  const detail = await album.getAlbumDetail(albumId, 1).catch(() => null);
  if (detail && Array.isArray(detail.list)) {
    const copyrightId = meta.copyrightId;
    const idx = detail.list.findIndex(s => String(s.copyrightId) === String(copyrightId));
    if (idx >= 0) out.track = String(idx + 1);
  }
  return out;
}

/* ---------------- 发现音乐：排行榜 / 歌单广场（V3.5.4） ---------------- */
async function leaderboards({ provider }) {
  const sdk = await loadSdk();
  const mod = sdk[provider];
  if (!mod || !mod.leaderboard) throw new Error('该平台不支持排行榜');
  const r = await mod.leaderboard.getBoards();
  return {
    provider,
    list: (r.list || []).map(b => ({ id: String(b.id), name: b.name, bangid: String(b.bangid || b.id) })),
  };
}

async function leaderboardList({ provider, bangid, page }) {
  const sdk = await loadSdk();
  const mod = sdk[provider];
  if (!mod || !mod.leaderboard) throw new Error('该平台不支持排行榜');
  const r = await mod.leaderboard.getList(String(bangid), page || 1);
  const limit = r.limit || 100;
  return {
    provider,
    songs: (r.list || []).map((info) => normalize(provider, info)),
    total: r.total || 0,
    page: r.page || page || 1,
    allPage: Math.max(1, Math.ceil((r.total || 0) / limit)),
  };
}

async function songLists({ provider, sortId, tagId, page }) {
  const sdk = await loadSdk();
  const mod = sdk[provider];
  if (!mod || !mod.songList) throw new Error('该平台不支持歌单广场');
  const r = await mod.songList.getList(sortId || '', tagId || '', page || 1);
  return {
    provider,
    list: (r.list || []).map((it) => ({
      id: String(it.id), name: it.name, author: it.author || '',
      playCount: String(it.play_count || ''), img: httpsCover(it.img || ''),
      total: it.total || 0, desc: it.desc || '',
    })),
    total: r.total || 0, page: r.page || page || 1, limit: r.limit || 30,
  };
}

async function songListDetail({ provider, id, page }) {
  const sdk = await loadSdk();
  const mod = sdk[provider];
  if (!mod || !mod.songList) throw new Error('该平台不支持歌单');
  const r = await mod.songList.getListDetail(String(id), page || 1);
  return {
    provider,
    songs: (r.list || []).map((info) => normalize(provider, info)),
    total: r.total || 0, page: r.page || page || 1, limit: r.limit || 100,
  };
}

module.exports = { PROVIDERS, PROVIDER_NAMES, loadSdk, search, songUrl, lyric, getPic, hotSearch, albumDetail, normalize, leaderboards, leaderboardList, songLists, songListDetail };
