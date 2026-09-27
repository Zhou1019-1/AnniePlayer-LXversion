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

/* ---------------- 专辑搜索 / 专辑曲目（V4.3 在线音乐「专辑」页签） ----------------
 * kg/kw/mg 详情复用洛雪 lx-sdk 各源 album 模块（经动态 import）；
 * 专辑搜索五源均为自写（洛雪 SDK 未导出任何源的专辑搜索）；
 * tx/wy 的详情为自写（tx 走 musicu.fcg GetAlbumDetail，wy 走 api/album）。 */

/** tx 专辑搜索：musicu.fcg DoSearchForQQMusicDesktop search_type=2
 * （client_search_cp t=2 已下线只回 zhida；mobile 版被风控 req.code=2001，desktop 版实测可用） */
async function txAlbumSearch(keywords, page, limit) {
  const resp = await httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    body: {
      comm: { ct: '19', cv: '1859', uin: '0' },
      req: {
        module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicDesktop',
        param: { query: keywords, search_type: 2, page_num: page, num_per_page: limit },
      },
    },
  }).promise;
  const body = resp && resp.body;
  const al = body && body.req && body.req.code === 0 && body.req.data && body.req.data.body && body.req.data.body.album;
  if (!al) throw new Error('tx 专辑搜索失败: ' + ((body && body.req && body.req.code) || 'no-data'));
  const list = al.list || [];
  const albums = list.map(a => ({
    id: a.albumMID || '',
    name: a.albumName || '',
    artist: a.singerName || (a.singer_list || []).map(s => s.name).join('、'),
    img: httpsCover(a.albumPic || (a.albumMID ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${a.albumMID}.jpg` : '')),
    date: a.publicTime || '',
    count: a.song_count || 0,
  })).filter(a => a.id);
  const total = al.totalNum || al.totalnum || albums.length;
  return { albums, total, page, allPage: Math.ceil(total / limit) || 1 };
}

/** tx 专辑曲目：GetAlbumDetail 取专辑信息（basicInfo）+ AlbumSongList.GetAlbumSongList 取全曲目
 * （后者 songList[].songInfo 带 mid/singer/album/interval/file.size_*，与免签搜索 meta 同构） */
async function txAlbumSongs(albumMid, page, limit) {
  const post = (mod, method, param) => httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    body: { comm: { ct: '19', cv: '1859', uin: '0' }, req: { module: mod, method, param } },
  }).promise;
  const [infoResp, listResp] = await Promise.all([
    post('music.musichallAlbum.AlbumInfoServer', 'GetAlbumDetail', { albumMid }),
    post('music.musichallAlbum.AlbumSongList', 'GetAlbumSongList', { albumMid, albumID: 0, begin: 0, num: 500, order: 2 }),
  ]);
  const basic = infoResp && infoResp.body && infoResp.body.req && infoResp.body.req.data;
  const listData = listResp && listResp.body && listResp.body.req && listResp.body.req.data;
  const info = basic && basic.basicInfo;
  if (!info || !listData || !Array.isArray(listData.songList)) throw new Error('tx 专辑详情失败');
  const albumName = info.albumName || '';
  const pubDate = info.publishDate || '';
  const metas = listData.songList.map(w => {
    const item = w.songInfo || {};
    const f = item.file || {};
    const types = [], _types = {};
    if (f.size_128mp3) { types.push({ type: '128k', size: fmtSize(f.size_128mp3) }); _types['128k'] = { size: fmtSize(f.size_128mp3) }; }
    if (f.size_320mp3) { types.push({ type: '320k', size: fmtSize(f.size_320mp3) }); _types['320k'] = { size: fmtSize(f.size_320mp3) }; }
    if (f.size_flac) { types.push({ type: 'flac', size: fmtSize(f.size_flac) }); _types.flac = { size: fmtSize(f.size_flac) }; }
    if (f.size_hires) { types.push({ type: 'flac24bit', size: fmtSize(f.size_hires) }); _types.flac24bit = { size: fmtSize(f.size_hires) }; }
    return {
      singer: (item.singer || []).map(s => s.name).filter(Boolean).join(','),
      name: item.title || item.name || '',
      albumName,
      albumId: albumMid,
      source: 'tx',
      interval: fmtInterval(item.interval),
      songId: item.id != null ? String(item.id) : '',
      albumMid,
      strMediaMid: f.media_mid || '',
      songmid: item.mid || '',
      img: `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`,
      types, _types, typeUrl: {},
      belongCD: item.index_cd != null ? String(item.index_cd) : '',
      cdIdx: item.index_album != null ? String(item.index_album) : '',
      pubtime: 0,
    };
  }).filter(m => m.songmid && m.strMediaMid);
  // 歌手字段结构随接口版本漂移（singer / singerList / 嵌套对象），取第一个含 name 的数组
  const singerCands = [basic && basic.singer, basic && basic.singerList, info.singerList, info.singer];
  const singerArr = singerCands.map(c => Array.isArray(c) ? c : (c && (c.singerList || c.singerlist)))
    .find(c => Array.isArray(c) && c.length) || [];
  return {
    info: {
      name: albumName,
      artist: singerArr.map(s => s.name).filter(Boolean).join('、'),
      img: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`,
      date: pubDate,
      desc: info.desc || '',
      count: listData.totalNum || metas.length,
    },
    metas, total: listData.totalNum || metas.length,
  };
}

/** wy 专辑搜索：eapi cloudsearch type=10（复用洛雪 wy 的 eapiRequest） */
async function wyAlbumSearch(keywords, page, limit) {
  await loadSdk(); // 确保 ESM loader（别名/扩展名解析）已注册
  const { eapiRequest } = (await import(pathToFileURL(path.join(__dirname, 'lx-sdk/wy/utils/index.js')).href));
  const { body } = await eapiRequest('/api/cloudsearch/pc', {
    s: keywords, type: 10, limit, offset: limit * (page - 1), total: page == 1,
  }).promise;
  const result = body && body.result;
  if (!result) throw new Error('wy 专辑搜索失败');
  const albums = (result.albums || []).map(a => ({
    id: String(a.id),
    name: a.name || '',
    artist: (a.artist && a.artist.name) || (a.artists || []).map(s => s.name).join('、'),
    img: httpsCover(a.picUrl || ''),
    date: a.publishTime ? new Date(a.publishTime).toISOString().slice(0, 10) : '',
    count: a.size || 0,
  }));
  const total = result.albumCount || albums.length;
  return { albums, total, page, allPage: Math.ceil(total / limit) || 1 };
}

/** wy 专辑曲目：eapi /api/v1/album/{id}（公开 /api/album 已被风控 code=-462；eapi 实测 200） */
async function wyAlbumSongs(albumId, page, limit) {
  await loadSdk();
  const { eapiRequest } = (await import(pathToFileURL(path.join(__dirname, 'lx-sdk/wy/utils/index.js')).href));
  const { body } = await eapiRequest(`/api/v1/album/${albumId}`, {}).promise;
  if (!body || body.code !== 200 || !body.album) throw new Error('wy 专辑详情失败: ' + ((body && body.code) || 'no-data'));
  const al = body.album;
  const metas = (body.songs || []).map(s => ({
    singer: (s.ar || s.artists || []).map(a => a.name).join('、'),
    name: s.name || '',
    albumName: al.name || '',
    albumId: String(al.id),
    source: 'wy',
    interval: fmtInterval((s.dt || 0) / 1000),
    songmid: s.id,
    img: httpsCover((s.al && s.al.picUrl) || al.picUrl || ''),
    types: [], _types: {}, typeUrl: {},
  }));
  return {
    info: {
      name: al.name || '',
      artist: (al.artist && al.artist.name) || (al.artists || []).map(a => a.name).join('、'),
      img: httpsCover(al.picUrl || ''),
      date: al.publishTime ? new Date(al.publishTime).toISOString().slice(0, 10) : '',
      desc: al.description || '',
      count: al.size || metas.length,
    },
    metas, total: al.size || metas.length,
  };
}

/** kg 专辑搜索：mobilecdnbj v3 search/album */
async function kgAlbumSearch(keywords, page, limit) {
  const url = 'http://mobilecdnbj.kugou.com/api/v3/search/album?format=json&showtype=1' +
    '&keyword=' + encodeURIComponent(keywords) + '&page=' + page + '&pagesize=' + limit;
  const resp = await httpFetch(url).promise;
  const body = resp && resp.body;
  const data = body && body.data;
  if (!data || !Array.isArray(data.info)) throw new Error('kg 专辑搜索失败');
  const albums = data.info.map(a => ({
    id: String(a.albumid || a.album_id || ''),
    name: a.albumname || a.album_name || '',
    artist: a.singername || a.singer_name || '',
    img: httpsCover(String(a.imgurl || a.sizable_cover || '').replace('{size}', '300')),
    date: String(a.publishtime || a.publish_date || '').slice(0, 10),
    count: a.songcount || 0,
  })).filter(a => a.id);
  const total = data.total || albums.length;
  return { albums, total, page, allPage: Math.ceil(total / limit) || 1 };
}

/** kg 专辑曲目：洛雪 kg/album.js（含 getMusicInfosByList 完整 meta） */
async function kgAlbumSongs(albumId, page, limit) {
  await loadSdk(); // 确保 ESM loader 已注册
  const album = (await import(pathToFileURL(path.join(__dirname, 'lx-sdk/kg/album.js')).href)).default;
  const r = await album.getAlbumDetail(albumId, page, limit || 200);
  return {
    info: {
      name: r.info.name || '', artist: r.info.author || '',
      img: httpsCover(r.info.img || ''), date: '', desc: r.info.desc || '', count: r.total || 0,
    },
    metas: r.list || [], total: r.total || 0,
  };
}

/** kw 响应清洗：&nbsp; 等 HTML 实体 + 字面 \uXXXX 转义（r.s ft=album 返回的伪 JSON 常见残留，注意双反斜杠变体） */
function kwClean(s) {
  return String(s || '')
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .trim();
}

/** kw 专辑搜索：search.kuwo.cn r.s ft=album */
async function kwAlbumSearch(keywords, page, limit) {
  const url = 'http://search.kuwo.cn/r.s?all=' + encodeURIComponent(keywords) +
    '&pn=' + (page - 1) + '&rn=' + limit + '&ft=album&itemset=web_2013&client=kt&rformat=json&encoding=utf8';
  const resp = await httpFetch(url).promise;
  let body = resp && resp.body;
  if (typeof body === 'string') { try { body = JSON.parse(body.replace(/'/g, '"')); } catch { body = null; } }
  const list = body && (body.albumlist || []);
  const albums = list.map(a => {
    // pic 是相对路径（300/s4s47/...jpg），img/hts_img 才是完整 URL
    let img = a.img || a.hts_img || '';
    if (!img && a.pic) img = 'http://img2.sycdn.kuwo.cn/star/albumcover/' + a.pic;
    return {
      id: String(a.albumid || ''),
      name: kwClean(a.name),
      artist: kwClean(a.artist),
      img,
      date: String(a.pub || a.showtime || '').slice(0, 10),
      count: parseInt(a.musiccnt) || 0,
    };
  }).filter(a => a.id);
  const total = parseInt(body && body.total) || albums.length;
  return { albums, total, page, allPage: Math.ceil(total / limit) || 1 };
}

/** kw 专辑曲目：洛雪 kw/album.js getAlbumListDetail（musiclist 带 formats → types） */
async function kwAlbumSongs(albumId, page, limit) {
  await loadSdk(); // 确保 ESM loader 已注册
  const album = (await import(pathToFileURL(path.join(__dirname, 'lx-sdk/kw/album.js')).href)).default;
  const r = await album.getAlbumListDetail(albumId, page || 1);
  return {
    info: {
      name: r.info.name || '', artist: r.info.author || '',
      img: httpsCover(r.info.img || ''), date: '', desc: r.info.desc || '', count: r.total || 0,
    },
    metas: r.list || [], total: r.total || 0,
  };
}

/** 统一专辑搜索：{ provider, albums:[{id,name,artist,img,date,count}], total, page, allPage }
 *  仅支持 kg/kw/tx/wy 四源（mg 咪咕按需求裁剪） */
async function albumSearch({ provider, keywords, page = 1, limit = 20 }) {
  if (!['kg', 'kw', 'tx', 'wy'].includes(provider)) throw new Error('该平台暂不支持专辑搜索');
  if (!keywords) throw new Error('缺少关键词');
  let r;
  switch (provider) {
    case 'tx': r = await txAlbumSearch(keywords, page, limit); break;
    case 'wy': r = await wyAlbumSearch(keywords, page, limit); break;
    case 'kg': r = await kgAlbumSearch(keywords, page, limit); break;
    case 'kw': r = await kwAlbumSearch(keywords, page, limit); break;
  }
  return { provider, albums: r.albums, total: r.total, page: r.page, allPage: r.allPage };
}

/** 统一专辑曲目：{ provider, info:{name,artist,img,date,desc,count}, songs:[normalize 后], total, page, allPage } */
async function albumSongs({ provider, id, page = 1, limit = 200 }) {
  if (!['kg', 'kw', 'tx', 'wy'].includes(provider)) throw new Error('该平台暂不支持专辑');
  let r;
  switch (provider) {
    case 'tx': r = await txAlbumSongs(id, page, limit); break;
    case 'wy': r = await wyAlbumSongs(id, page, limit); break;
    case 'kg': r = await kgAlbumSongs(id, page, limit); break;
    case 'kw': r = await kwAlbumSongs(id, page, limit); break;
  }
  const slice = r.metas; // 各源详情接口多为整表返回，直接全量（limit 语义留给未来分页源）
  return {
    provider,
    info: r.info,
    songs: slice.map(info => normalize(provider, info)),
    total: r.total || slice.length,
    page: 1,
    allPage: 1,
  };
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

/**
 * V3.5.19：网易云热门评论。
 * 流媒体 wy 曲目直接传 songmid；本地/其他平台曲目按「歌名 歌手」搜 wy 取第一条匹配。
 * 返回 { total, comments: [{text, userName, likedCount, timeStr}] }。
 */
async function hotComments({ songmid, name, artist, limit = 15 }) {
  const sdk = await loadSdk();
  const wy = sdk.wy;
  if (!wy || !wy.comment) throw new Error('评论模块不可用');
  let id = songmid;
  if (!id) {
    const kw = [name, artist].filter(Boolean).join(' ').trim();
    if (!kw) throw new Error('缺少曲目信息');
    const rs = await search({ provider: 'wy', keywords: kw, page: 1, limit: 5 });
    const first = (rs.songs || [])[0];
    id = first && first.meta && first.meta.songmid;
    if (!id) throw new Error('网易云未找到该曲');
  }
  const r = await wy.comment.getHotComment({ songmid: id }, 1, limit);
  return {
    total: r.total || 0,
    comments: (r.comments || []).map(c => ({
      text: c.text || '',
      userName: c.userName || '',
      likedCount: c.likedCount || 0,
      timeStr: c.timeStr || '',
    })),
  };
}

module.exports = { PROVIDERS, PROVIDER_NAMES, loadSdk, search, songUrl, lyric, getPic, hotSearch, albumDetail, albumSearch, albumSongs, normalize, leaderboards, leaderboardList, songLists, songListDetail, hotComments };
