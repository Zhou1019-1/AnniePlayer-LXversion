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
globalThis.__svlxApis = {
  async call(source, action, info) {
    const { result } = await sources.handleRequest(action, { source, info });
    return result;
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

async function search({ provider, keywords, page = 1, limit = 30 }) {
  if (!PROVIDERS.includes(provider)) throw new Error('未知平台: ' + provider);
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
              quality: `音源·${QUALITY_LABEL[type] || type}`,
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

module.exports = { PROVIDERS, PROVIDER_NAMES, loadSdk, search, songUrl, lyric, getPic, hotSearch, normalize };
