// downloader.js — 自研下载解密链路（复刻 amd.wol.moe 前端行为）
// wrapper-lite API + temari.wasm 本地解密 + 标签/封面/歌词
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { tagM4A } = require('./mp4tag');
const { remuxFMP4 } = require('./remux');
const { alacFix } = require('./alacfix');

const WRAPPER_DEFAULT = 'https://wm.wol.moe';
const CATALOG = 'https://amp-api.wol.moe';
const ASSET_KEY_URI = 'skd://itunes.apple.com/P000000000/s1/e1';

// 可配置上游（2026-09 起 wm.wol.moe 需 API key：Telegram @wm_auth_bot 发 /newkey）
// fetchImpl：可选的网络实现注入（如 Electron net.fetch），为 null 时用全局 fetch
const CONFIG = { wrapperUrl: WRAPPER_DEFAULT, apiKey: '', fetchImpl: null };
function setConfig(c) {
  if (c.wrapperUrl) CONFIG.wrapperUrl = c.wrapperUrl.replace(/\/+$/, '');
  CONFIG.apiKey = c.apiKey || '';
  if (c.fetchImpl !== undefined) CONFIG.fetchImpl = c.fetchImpl || null;
}
// 统一网络出口：全部请求走这里，便于宿主注入 net.fetch（需支持 headers/signal/ok/status/json/text/arrayBuffer）
const http = (...args) => (CONFIG.fetchImpl || fetch)(...args);

// ---------- HTTP ----------
// catalog 直连苹果官方 amp-api（developer token 从 music.apple.com 页面 JS 里抓取，
// 是网页播放器的公开 token，无需用户账号）；失败时回退 amp-api.wol.moe 公益代理。
let devToken = null, devTokenAt = 0;
async function getDevToken() {
  if (devToken && Date.now() - devTokenAt < 1800e3) return devToken; // 缓存 30 分钟
  const html = await (await http('https://music.apple.com/')).text();
  const m = html.match(/src="(\/assets\/index[^"]+\.js)"/);
  if (!m) throw new Error('music.apple.com 页面结构变化，找不到 JS bundle');
  const js = await (await http('https://music.apple.com' + m[1])).text();
  const t = js.match(/"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/);
  if (!t) throw new Error('JS bundle 里找不到 developer token');
  devToken = t[1]; devTokenAt = Date.now();
  return devToken;
}

// catalog 统一入口：官方直连优先，公益代理兜底。返回语义同 api()（j.data 有则解包）
async function catalogApi(pathname, params = {}) {
  try {
    const url = new URL('https://amp-api.music.apple.com' + pathname);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
    const r = await http(url, {
      headers: { Authorization: `Bearer ${await getDevToken()}`, Origin: 'https://music.apple.com' },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`catalog 直连 HTTP ${r.status}`);
    const j = await r.json();
    return j.data !== undefined ? j.data : j;
  } catch {
    return api(CATALOG, pathname, params); // 公益代理兜底（自带重试）
  }
}

async function api(base, pathname, params = {}, retries = 3) {
  const url = new URL(base + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  // wrapper 接口按需带 API key
  const headers = {};
  if (CONFIG.apiKey && url.origin === new URL(CONFIG.wrapperUrl).origin)
    headers.Authorization = `Bearer ${CONFIG.apiKey}`;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await http(url, { headers, signal: AbortSignal.timeout(120000) });
      if (!r.ok) {
        let hint = '';
        try { const j = await r.json(); hint = j.msg || j.hint || ''; } catch {}
        if (r.status === 401) throw new Error('密钥服务需要 API Key：请在设置中填写（Telegram @wm_auth_bot 发 /newkey 免费获取）');
        // 429 配额/限流：重试只会加重限制，直接报错并给出提升配额方法
        if (r.status === 429) throw new Error(`密钥服务配额已用尽或被限流（${pathname}）：在 @wm_auth_bot 发 /quota 查额度，发 /login 绑定自己的 Apple Music 账号可提升配额`);
        throw new Error(`HTTP ${r.status}${hint ? ' ' + hint : ''}`);
      }
      const j = await r.json();
      if (j.code !== undefined && j.code !== 0) throw new Error(j.msg || 'wrapper error');
      return j.data !== undefined ? j.data : j;
    } catch (e) {
      lastErr = e;
      if (String(e.message).includes('fetch failed') && base === CONFIG.wrapperUrl) {
        lastErr = new Error(CONFIG.wrapperUrl.includes('127.0.0.1') || CONFIG.wrapperUrl.includes('localhost')
          ? '无法连接本地密钥服务：请先运行 wrapper-lite 的「2-启动服务.bat」并保持窗口开启'
          : '无法连接密钥服务：请检查网络或设置中的密钥服务地址');
      }
      if (i < retries - 1) await new Promise(r => setTimeout(r, 400 * 2 ** i));
    }
  }
  // 密钥服务在线兜底：本地 wrapper 连不上且配了 API Key 时，改打远程公共服务
  if (base === CONFIG.wrapperUrl && CONFIG.wrapperUrl !== WRAPPER_DEFAULT && CONFIG.apiKey
    && /无法连接|fetch failed/i.test(String(lastErr && lastErr.message))) {
    return api(WRAPPER_DEFAULT, pathname, params, retries);
  }
  throw lastErr;
}

async function fetchBytes(url, range, signal) {
  const headers = {};
  if (range) {
    const [len, off] = range.split('@').map(Number);
    headers.Range = `bytes=${off}-${off + len - 1}`;
  }
  const r = await http(url, { headers, signal });
  if (!r.ok) throw new Error(`分片 HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ---------- 链接解析 ----------
function parseInput(input) {
  input = input.trim();
  if (/^\d+$/.test(input)) return { kind: 'song', id: input, storefront: 'us' };
  const m = input.match(/music\.apple\.com\/([a-z]{2}(?:-[a-z]+)?)\/(album|song|playlist)(?:\/[^/?#]*)?\/(\d+)/i);
  if (!m) throw new Error('无法识别的链接，请粘贴 music.apple.com 的歌曲/专辑链接或数字 adamId');
  const storefront = m[1].toLowerCase();
  const kind = m[2].toLowerCase();
  const id = m[3];
  if (kind === 'album') {
    const si = input.match(/[?&]i=(\d+)/);
    if (si) return { kind: 'song', id: si[1], storefront };
    return { kind: 'album', id, storefront };
  }
  if (kind === 'playlist') return { kind: 'playlist', id, storefront };
  return { kind: 'song', id, storefront };
}

function normTrack(a) {
  return {
    adamId: a.id,
    title: a.attributes.name,
    artist: a.attributes.artistName,
    album: a.attributes.albumName,
    albumArtist: a.attributes.albumArtistName || a.attributes.artistName,
    composer: a.attributes.composerName || '',
    genre: (a.attributes.genreNames || []).filter(g => g !== 'Music')[0] || '',
    genres: (a.attributes.genreNames || []).filter(g => g !== 'Music'),
    year: (a.attributes.releaseDate || '').slice(0, 4),
    releaseDate: a.attributes.releaseDate || '',
    trackNumber: a.attributes.trackNumber || 0,
    discNumber: a.attributes.discNumber || 1,
    isrc: a.attributes.isrc || '',
    durationMs: a.attributes.durationInMillis || 0,
    artwork: a.attributes.artwork ? a.attributes.artwork.url : null,
    artworkSize: a.attributes.artwork ? Math.max(a.attributes.artwork.width, a.attributes.artwork.height) : 0,
    hasLyrics: !!a.attributes.hasLyrics,
    audioTraits: a.attributes.audioTraits || [],
    isAppleDigitalMaster: !!a.attributes.isAppleDigitalMaster,
    contentRating: a.attributes.contentRating || '',
    albumId: a.relationships?.albums?.data?.[0]?.id || '',
    artistId: a.relationships?.artists?.data?.[0]?.id || '',
  };
}

// 解析输入 -> 曲目列表
async function resolve(input, storefrontOverride) {
  const q = parseInput(input);
  const sf = storefrontOverride || q.storefront;
  if (q.kind === 'song') {
    const d = await catalogApi(`/v1/catalog/${sf}/songs/${q.id}`);
    const t = normTrack(d[0]);
    // 单曲链接补专辑级元数据（版权/厂牌/UPC，用于扩展标签）
    if (t.albumId) {
      try {
        const al = await catalogApi(`/v1/catalog/${sf}/albums/${t.albumId}`);
        const aa = al[0].attributes;
        t.copyright = aa.copyright || '';
        t.recordLabel = aa.recordLabel || '';
        t.upc = aa.upc || '';
      } catch {}
    }
    return { kind: 'song', tracks: [t] };
  }
  if (q.kind === 'album') {
    const album = await catalogApi(`/v1/catalog/${sf}/albums/${q.id}`);
    const tracks = await catalogApi(`/v1/catalog/${sf}/albums/${q.id}/tracks`);
    const aa = album[0].attributes;
    const list = tracks.map(normTrack);
    list.forEach(t => {
      if (!t.album) t.album = aa.name;
      if (!t.artwork && aa.artwork) t.artwork = aa.artwork.url;
      // 专辑级元数据下发到每首（扩展标签用）
      t.copyright = aa.copyright || '';
      t.recordLabel = aa.recordLabel || '';
      t.upc = aa.upc || '';
      t.albumId = t.albumId || q.id;
    });
    return {
      kind: 'album', tracks: list,
      album: {
        name: aa.name, artist: aa.artistName, upc: aa.upc || '',
        trackTotal: list.length,
        recordLabel: aa.recordLabel || '',
        copyright: aa.copyright || '',
        releaseDate: aa.releaseDate || '',
        genres: (aa.genreNames || []).filter(g => g !== 'Music'),
        isComplete: !!aa.isComplete,
      },
    };
  }
  // playlist
  const pl = await catalogApi(`/v1/catalog/${sf}/playlists/${q.id}/tracks`);
  return { kind: 'playlist', tracks: pl.filter(t => t.type === 'songs').map(normTrack) };
}

// ---------- 编码变体 ----------
const CODECS = {
  alac: { match: 'alac', label: 'ALAC 无损' },
  aac: { match: 'mp4a.40.2', label: 'AAC 256K' },
  'he-aac': { match: 'mp4a.40.5', label: 'HE-AAC 64K' },
  atmos: { match: 'ec-3', label: '杜比全景声' },
};

function pickVariant(master, codecKey) {
  const lines = master.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const a = {};
      const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi;
      let m;
      while ((m = re.exec(lines[i]))) a[m[1].toUpperCase()] = m[3] ?? m[4];
      variants.push({ codecs: a.CODECS || '', bw: +a.BANDWIDTH || 0, uri: (lines[i + 1] || '').trim() });
    }
  }
  const want = (CODECS[codecKey] || CODECS.alac).match;
  let pool = variants.filter(v => v.codecs.includes(want));
  if (!pool.length) pool = variants; // 兜底：最高码率
  pool.sort((a, b) => b.bw - a.bw);
  if (!pool.length) throw new Error('master playlist 无可用变体');
  return pool[0];
}

// 查询某首歌可用的编码
async function probeCodecs(adamId) {
  const { m3u8 } = await api(CONFIG.wrapperUrl, '/m3u8', { adamId });
  const master = await (await http(m3u8)).text();
  const found = new Set();
  for (const [key, c] of Object.entries(CODECS)) {
    if (master.includes(`CODECS="${c.match}"`)) found.add(key);
  }
  return { master, m3u8, codecs: [...found] };
}

// ---------- m3u8 ----------
function parseAttrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi;
  let m;
  while ((m = re.exec(line))) out[m[1].toUpperCase()] = m[3] ?? m[4];
  return out;
}

function parseMediaPlaylist(text, baseUrl) {
  const keyUris = [];
  let curKey = null, map = null, pendingRange = null, pendingDur = 0;
  const segs = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      if (a.URI) { curKey = a.URI; if (!keyUris.includes(a.URI)) keyUris.push(a.URI); }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      map = { url: new URL(a.URI, baseUrl).href, range: a.BYTERANGE || null };
    } else if (line.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17).trim();
    } else if (line && !line.startsWith('#')) {
      segs.push({ url: new URL(line.trim(), baseUrl).href, range: pendingRange, key: curKey, dur: pendingDur });
      pendingRange = null; pendingDur = 0;
    }
  }
  return { keyUris, map, segs };
}

// ---------- MP4 加密 sample 定位 ----------
function* boxes(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    yield { type, start: p, size, payload: p + hdr };
    p += size;
  }
}

function findEncryptedSamples(buf) {
  const out = [];
  for (const b of boxes(buf, 0, buf.length)) {
    if (b.type !== 'moof') continue;
    for (const tr of boxes(buf, b.payload, b.start + b.size)) {
      if (tr.type !== 'traf') continue;
      let defaultSize = 0;
      const truns = [];
      let sencCount = 0;
      for (const c of boxes(buf, tr.payload, tr.start + tr.size)) {
        const p = c.payload;
        if (c.type === 'tfhd') {
          const flags = buf.readUInt32BE(p) & 0xffffff;
          let q = p + 8;
          if (flags & 0x1) q += 8;
          if (flags & 0x2) q += 4;
          if (flags & 0x8) q += 4;
          if (flags & 0x10) { defaultSize = buf.readUInt32BE(q); q += 4; }
        } else if (c.type === 'trun') {
          const flags = buf.readUInt32BE(p) & 0xffffff;
          const count = buf.readUInt32BE(p + 4);
          let q = p + 8;
          let dataOffset = 0;
          if (flags & 0x1) { dataOffset = buf.readInt32BE(q); q += 4; }
          if (flags & 0x4) q += 4;
          const sizes = [];
          for (let i = 0; i < count; i++) {
            if (flags & 0x100) q += 4;
            if (flags & 0x200) { sizes.push(buf.readUInt32BE(q)); q += 4; }
            else sizes.push(defaultSize);
            if (flags & 0x400) q += 4;
            if (flags & 0x800) q += 4;
          }
          truns.push({ dataOffset, sizes });
        } else if (c.type === 'senc') {
          sencCount = buf.readUInt32BE(p + 4);
        }
      }
      if (!sencCount) continue;
      let consumed = 0;
      for (const t of truns) {
        let off = b.start + t.dataOffset;
        for (const sz of t.sizes) {
          if (consumed < sencCount && sz > 0) out.push({ offset: off, length: sz });
          consumed++;
          off += sz;
        }
      }
    }
  }
  return out;
}

// ---------- 流式播放（P2） ----------
// /m3u8 短缓存（5 分钟）：wrapper VM 上游协商约 2.5s，是冷启动最大头；
// 重播/seek 同曲时跳过。URL 带时效签名，TTL 不宜长。
const m3u8Cache = new Map(); // adamId -> { url, at }
async function getMasterUrl(adamId) {
  const hit = m3u8Cache.get(adamId);
  if (hit && Date.now() - hit.at < 300e3) return hit.url;
  const { m3u8 } = await api(CONFIG.wrapperUrl, '/m3u8', { adamId });
  m3u8Cache.set(adamId, { url: m3u8, at: Date.now() });
  return m3u8;
}

// 等长净化：加密标记盒类型原地改写为 free（字节长度/偏移不变，am-hook 同款手法）
function setBoxType(buf, pos, type) { buf.write(type, pos + 4, 4, 'latin1'); }

// init 段净化：enca → 原始编码 fourcc；sinf/pssh → free
function sanitizeInit(buf, codecKey) {
  const fourcc = codecKey === 'atmos' ? 'ec-3' : codecKey === 'alac' ? 'alac' : 'mp4a';
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);
  const walk = (s, e) => {
    for (const b of boxes(buf, s, e)) {
      if (b.type === 'pssh') { setBoxType(buf, b.start, 'free'); continue; }
      if (b.type === 'stsd') {
        // stsd：8 字节头 + 8 字节 version/flags+count，然后各 sample entry
        let q = b.payload + 8;
        while (q + 8 <= b.start + b.size) {
          const esize = buf.readUInt32BE(q);
          if (esize < 36 || q + esize > b.start + b.size) break;
          const etype = buf.toString('latin1', q + 4, q + 8);
          if (etype === 'enca') {
            setBoxType(buf, q, fourcc);
            // 音频 sample entry：盒头 8 + 固定头 28，之后是嵌套盒（esds/alac 配置 + sinf）
            for (const c of boxes(buf, q + 36, q + esize)) {
              if (c.type === 'sinf') setBoxType(buf, c.start, 'free');
            }
          }
          q += esize;
        }
        continue;
      }
      if (CONTAINERS.has(b.type)) walk(b.payload, b.start + b.size);
    }
  };
  walk(0, buf.length);
}

// init 段时长修正：Apple init(moov) 写的是占位时长（实测不同歌都恒定 ~14.95s），
// ffprobe/引擎以 mvhd 为曲目总长 → 流式播放被当成 15 秒短曲，播到即 ended（V4.6「ALAC 播 15 秒就停」根因）。
// 按 playlist EXTINF 总时长改写 mvhd/tkhd/mdhd/mehd（v0/v1 均兼容）。
function patchInitDuration(buf, totalSec) {
  if (!(totalSec > 0)) return;
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'mvex']);
  let movieTs = 0, mediaTs = 0;
  const walkTs = (s, e) => {
    for (const b of boxes(buf, s, e)) {
      if (b.type === 'mvhd') movieTs = buf.readUInt32BE(b.payload + (buf.readUInt8(b.payload) === 1 ? 20 : 12));
      else if (b.type === 'mdhd') mediaTs = buf.readUInt32BE(b.payload + (buf.readUInt8(b.payload) === 1 ? 20 : 12));
      else if (CONTAINERS.has(b.type)) walkTs(b.payload, b.start + b.size);
    }
  };
  walkTs(0, buf.length);
  if (!movieTs && !mediaTs) return;
  const movieDur = Math.round(totalSec * (movieTs || 1000));
  const mediaDur = Math.round(totalSec * (mediaTs || movieTs || 44100));
  const walkPatch = (s, e) => {
    for (const b of boxes(buf, s, e)) {
      const v1 = buf.readUInt8(b.payload) === 1;
      if (b.type === 'mvhd') { if (v1) buf.writeBigUInt64BE(BigInt(movieDur), b.payload + 24); else buf.writeUInt32BE(movieDur >>> 0, b.payload + 16); }
      else if (b.type === 'mehd') { if (v1) buf.writeBigUInt64BE(BigInt(movieDur), b.payload + 4); else buf.writeUInt32BE(movieDur >>> 0, b.payload + 4); }
      else if (b.type === 'tkhd') { if (v1) buf.writeBigUInt64BE(BigInt(movieDur), b.payload + 28); else buf.writeUInt32BE(movieDur >>> 0, b.payload + 20); }
      else if (b.type === 'mdhd') { if (v1) buf.writeBigUInt64BE(BigInt(mediaDur), b.payload + 24); else buf.writeUInt32BE(mediaDur >>> 0, b.payload + 16); }
      else if (CONTAINERS.has(b.type)) walkPatch(b.payload, b.start + b.size);
    }
  };
  walkPatch(0, buf.length);
}

// 分片净化：moof/traf 内的 senc/saiz/saio → free
function sanitizeFragment(buf) {
  for (const b of boxes(buf, 0, buf.length)) {
    if (b.type !== 'moof') continue;
    for (const tr of boxes(buf, b.payload, b.start + b.size)) {
      if (tr.type !== 'traf') continue;
      for (const c of boxes(buf, tr.payload, tr.start + tr.size)) {
        if (c.type === 'senc' || c.type === 'saiz' || c.type === 'saio') setBoxType(buf, c.start, 'free');
      }
    }
  }
}

// 流式下载解密：按时间轴顺序产出解密后的字节（init 段 + 各分片）
// opts: { codec='alac', wasmPath, concurrency=4, startSec=0, signal }
// - 分片级并发拉取 + 按序交付（预取窗口=concurrency，天然背压，内存上限≈concurrency×分片大小）
// - 客户端中止：opts.signal abort 或 break for-await（生成器 return）→ 停止拉取
// ===== 播放加速：master/media playlist 解析结果短期缓存 =====
// 重复播 / 切回播过的歌：跳过 wrapper 授权（getMasterUrl）+ 两次 Apple CDN 下载，首 chunk 秒出
const playlistCache = new Map(); // `${adamId}:${codec}` -> { keyUris, map, segs, at }

async function getPlaylist(adamId, codec) {
  const ck = `${adamId}:${codec}`;
  const hit = playlistCache.get(ck);
  if (hit && Date.now() - hit.at < 300e3) return hit;
  const masterUrl = await getMasterUrl(adamId);
  const master = await (await http(masterUrl)).text();
  const variant = pickVariant(master, codec);
  const mediaUrl = new URL(variant.uri, masterUrl).href;
  const media = await (await http(mediaUrl)).text();
  const { keyUris, map, segs } = parseMediaPlaylist(media, mediaUrl);
  const rec = { keyUris, map, segs, at: Date.now() };
  playlistCache.set(ck, rec);
  return rec;
}

/* 预热：主进程 am:prefetch IPC 在切歌前提前解析下一首 playlist（后台异步，不阻塞当前播放） */
async function prefetch(adamId, codec) {
  try { await getPlaylist(String(adamId), codec === 'alac' ? 'alac' : 'aac'); return true; }
  catch (e) { return false; }
}

/* 播放加载进度（V4.6）：service.js /progress 端点查询，渲染层轮询做加载进度卡 */
const playProgress = new Map(); // `${adamId}:${codec}` -> { stage, done, total, bytes, at }
function reportProg(key, patch) {
  const cur = playProgress.get(key) || {};
  playProgress.set(key, Object.assign(cur, patch, { at: Date.now() }));
}
function getProgress(adamId, codec) { return playProgress.get(`${adamId}:${codec}`) || null; }

async function* streamTrack(track, opts = {}) {
  const { codec = 'alac', wasmPath, concurrency = 4, startSec = 0, signal } = opts;
  const progKey = `${track.adamId}:${codec}`;
  reportProg(progKey, { stage: 'playlist', done: 0, total: 0, bytes: 0 });
  const { keyUris, map, segs } = await getPlaylist(track.adamId, codec);
  reportProg(progKey, { stage: 'key', total: segs.length });
  const temari = await loadTemari(wasmPath);

  // 冷启动优化：init 拉取与密钥模板请求并行；/key 网络并行、wasm fromJson 串行（bump 区共享）
  const initP = map ? fetchBytes(map.url, map.range, signal) : null;
  const tplJsons = await Promise.all(keyUris.map(uri => {
    const id = uri.includes('/P000000000/') ? '0' : track.adamId;
    return api(CONFIG.wrapperUrl, '/key', { adamId: id, uri });
  }));
  const handles = new Map();
  keyUris.forEach((uri, i) => {
    const ck = uri === ASSET_KEY_URI ? ASSET_KEY_URI : `${track.adamId}${uri}`;
    let h = templateCache.get(ck);
    if (!h) { h = temari.fromJson(JSON.stringify(tplJsons[i])); templateCache.set(ck, h); }
    handles.set(uri, h);
  });

  // seek：按 EXTINF 累计时长定位起始分片
  let startIdx = 0, startOffsetSec = 0;
  if (startSec > 0) {
    while (startIdx < segs.length - 1 && startOffsetSec + (segs[startIdx].dur || 0) < startSec) {
      startOffsetSec += segs[startIdx].dur || 0;
      startIdx++;
    }
  }

  if (initP) {
    reportProg(progKey, { stage: 'init' });
    const init = await initP;
    sanitizeInit(init, codec);
    // V4.6：init 占位时长改写为真实总长（seek 时扣除已跳过部分），否则引擎按 ~15s 误判 ended
    patchInitDuration(init, segs.reduce((a, s) => a + (s.dur || 0), 0) - startOffsetSec);
    yield init;
  }

  let next = startIdx, segDone = 0, bytesOut = 0;
  const pending = new Map();
  const launch = (i) => pending.set(i, (async () => {
    const seg = segs[i];
    const frag = await fetchBytes(seg.url, seg.range, signal);
    const h = handles.get(seg.key ?? keyUris[0]);
    if (h) {
      for (const s of findEncryptedSamples(frag)) {
        const plain = temari.decrypt(h, frag.subarray(s.offset, s.offset + s.length));
        if (plain) frag.set(plain, s.offset);
      }
    }
    sanitizeFragment(frag);
    reportProg(progKey, { stage: 'segments', done: ++segDone });
    return frag;
  })());
  for (let k = 0; k < concurrency && next < segs.length; k++) launch(next++);
  for (let i = startIdx; i < segs.length; i++) {
    if (signal && signal.aborted) return;
    const frag = await pending.get(i);
    pending.delete(i);
    if (next < segs.length) launch(next++);
    bytesOut += frag.length;
    reportProg(progKey, { bytes: bytesOut });
    yield frag;
  }
  reportProg(progKey, { stage: 'done' });
}


let temariInst = null;
async function loadTemari(wasmPath) {
  if (temariInst) return temariInst;
  const buf = fs.readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(buf, {});
  const ex = instance.exports;
  let heap = 524288; // 0x80000，栈区闲置段（复刻前端）
  // 注意：模板 JSON 构建完成后即可回收 bump 空间（实测清零输入区不影响解密，
  // 模板结构已完整拷贝进 wasm 堆）。若不回收，专辑约第 9 首时 bump 区
  // 会顶穿 wasm 堆基址(≈1.1MB) 触发 memory access out of bounds。
  const push = (bytes) => {
    const end = heap + bytes.byteLength;
    if (end > ex.memory.buffer.byteLength)
      ex.memory.grow(Math.ceil((end - ex.memory.buffer.byteLength) / 65536));
    const p = heap;
    heap += bytes.byteLength;
    new Uint8Array(ex.memory.buffer, p, bytes.byteLength).set(bytes);
    return p;
  };
  temariInst = {
    fromJson(jsonStr) {
      const b = new TextEncoder().encode(jsonStr);
      const save = heap;
      const h = ex.tmpl_from_json(push(b), b.byteLength);
      heap = save; // 模板已拷入 wasm 堆，JSON 输入区可回收
      if (!h) throw new Error('tmpl_from_json failed');
      return h;
    },
    decrypt(handle, sample) {
      const save = heap;
      const inP = push(sample);
      const outP = push(new Uint8Array(sample.byteLength));
      const n = ex.decrypt_sample_ffi(handle, inP, sample.byteLength, outP);
      const ok = n !== 0 && n === sample.byteLength;
      const out = ok ? Buffer.from(ex.memory.buffer, outP, n).slice() : null;
      heap = save; // 必须复位，否则撞上 wasm 内部堆
      return out;
    },
  };
  return temariInst;
}

// 密钥模板缓存（asset key 全局共享；content key 按 adamId+uri）
const templateCache = new Map();
async function getTemplate(temari, adamId, uri) {
  const cacheKey = uri === ASSET_KEY_URI ? ASSET_KEY_URI : `${adamId}${uri}`;
  if (templateCache.has(cacheKey)) return templateCache.get(cacheKey);
  const id = uri.includes('/P000000000/') ? '0' : adamId;
  const tpl = await api(CONFIG.wrapperUrl, '/key', { adamId: id, uri });
  const h = temari.fromJson(JSON.stringify(tpl));
  templateCache.set(cacheKey, h);
  return h;
}

// ---------- 歌词 TTML -> LRC ----------
const unescXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');

function ttmlTsToMs(t) {
  if (!t) return 0;
  const m = t.match(/(?:(\d+):)?(\d+):([\d.]+)/);
  if (m) return ((+m[1] || 0) * 3600 + (+m[2]) * 60 + parseFloat(m[3])) * 1000;
  const s2 = t.match(/([\d.]+)\s*s?$/); // 裸秒数（Apple 常见："6.152"）或带 s 后缀
  return s2 ? parseFloat(s2[1]) * 1000 : 0;
}

function msToLrcTs(ms) {
  const neg = ms < 0, n = Math.abs(ms);
  const mm = Math.floor(n / 60000), ss = Math.floor(n % 60000 / 1000), cs = Math.floor(n % 1000 / 10);
  return `${neg ? '-' : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// 解析 TTML 行（含逐词 span 与 itunes:key 行号，用于对齐翻译/发音）
function parseTtmlLines(ttml) {
  const src = ttml.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!DOCTYPE[\s\S]*?>/, '');
  const lines = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1], body = m[2];
    const beginMs = ttmlTsToMs(/begin="([^"]*)"/i.exec(attrs)?.[1]);
    const endMs = ttmlTsToMs(/end="([^"]*)"/i.exec(attrs)?.[1]);
    const key = /(?:itunes:key|key)="([^"]*)"/i.exec(attrs)?.[1];
    // 逐词 span：拼接为整行文本
    const words = [];
    const sre = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
    let sm, plain = body;
    while ((sm = sre.exec(body))) {
      const t = unescXml(sm[2].replace(/<[^>]+>/g, '')).trim();
      words.push(t);
      plain = plain.replace(sm[0], '');
    }
    const text = unescXml(plain.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (words.length && words.every(w => w)) lines.push({ beginMs, endMs, key, text: words.join(' ') });
    else if (text) lines.push({ beginMs, endMs, key, text });
  }
  return lines;
}

// 解析 <iTunesMetadata> 内的翻译/发音附加内容（移植自 amd.wol.moe）
function parseLyricsExtras(ttml) {
  const map = new Map(); // key -> { translation, pronunciation }
  const meta = /<iTunesMetadata[^>]*>([\s\S]*?)<\/iTunesMetadata>/i.exec(ttml);
  if (!meta) return map;
  const set = (kind, text, key) => {
    let o = map.get(key);
    if (!o) { o = {}; map.set(key, o); }
    o[kind] = text;
  };
  const re = /<(translation|transliteration)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(meta[1]))) {
    const kind = m[1].toLowerCase() === 'transliteration' ? 'pronunciation' : 'translation';
    const tre = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let t;
    while ((t = tre.exec(m[3]))) {
      const key = /for="([^"]*)"/i.exec(t[1])?.[1];
      if (!key) continue;
      const text = unescXml(t[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (text) set(kind, text, key);
    }
  }
  return map;
}

// extras: [] | ['translation'] | ['pronunciation'] | ['translation','pronunciation']
function ttmlToLrc(ttml, extras = []) {
  const lines = parseTtmlLines(ttml);
  const extraMap = extras.length ? parseLyricsExtras(ttml) : null;
  const out = [];
  for (const l of lines) {
    const ts = `[${msToLrcTs(l.beginMs)}]`;
    out.push(ts + l.text);
    // 附加内容以同时间戳的额外行插入
    if (extraMap && l.key) {
      const ex = extraMap.get(l.key);
      if (ex) for (const kind of extras) if (ex[kind]) out.push(ts + ex[kind]);
    }
  }
  return out.join('\n');
}

async function fetchLyrics(adamId, lang, extras = []) {
  try {
    const d = await api(CONFIG.wrapperUrl, '/lyrics', { adamId, language: lang || 'en', syllable: '0' }, 1);
    const ttml = d.lyrics || '';
    return { ttml, lrc: ttmlToLrc(ttml, extras) };
  } catch {
    return null;
  }
}

// 分离式歌词（安妮契约：正文/翻译/发音三条独立 LRC 串）
function ttmlToLrcSplit(ttml) {
  const lines = parseTtmlLines(ttml);
  const extraMap = parseLyricsExtras(ttml);
  const lyric = [], tlyric = [], rlyric = [];
  for (const l of lines) {
    const ts = `[${msToLrcTs(l.beginMs)}]`;
    lyric.push(ts + l.text);
    const ex = l.key && extraMap.get(l.key);
    if (ex) {
      if (ex.translation) tlyric.push(ts + ex.translation);
      if (ex.pronunciation) rlyric.push(ts + ex.pronunciation);
    }
  }
  return { lyric: lyric.join('\n'), tlyric: tlyric.join('\n'), rlyric: rlyric.join('\n') };
}

async function fetchLyricsSplit(adamId, lang) {
  try {
    const d = await api(CONFIG.wrapperUrl, '/lyrics', { adamId, language: lang || 'en', syllable: '0' }, 1);
    const ttml = d.lyrics || '';
    return { ttml, ...ttmlToLrcSplit(ttml) };
  } catch {
    return null;
  }
}

// catalog 搜索（amp-api 代理注入 developer token，调用方零鉴权）
// 返回 { songs: Track[], albums: [{id,name,artist,artwork,artworkSize,releaseDate,trackTotal}] }
async function search(term, storefront = 'cn', limit = 25) {
  const d = await catalogApi(`/v1/catalog/${storefront}/search`,
    { term, types: 'songs,albums', limit });
  const songs = (d.results?.songs?.data || []).filter(t => t.type === 'songs').map(normTrack);
  const albums = (d.results?.albums?.data || []).map(a => ({
    id: a.id,
    name: a.attributes.name,
    artist: a.attributes.artistName,
    artwork: a.attributes.artwork ? a.attributes.artwork.url : null,
    artworkSize: a.attributes.artwork ? Math.max(a.attributes.artwork.width, a.attributes.artwork.height) : 0,
    releaseDate: a.attributes.releaseDate || '',
    trackTotal: a.attributes.trackCount || 0,
  }));
  return { songs, albums };
}

// wrapper-lite 健康检查（返回 { code, data: { regions } }，未运行会抛友好错误）
async function wrapperStatus() {
  return api(CONFIG.wrapperUrl, '/status', {}, 1);
}

// coverFormat: 'jpeg' | 'png' | 'original'
async function fetchCover(artworkUrl, size, coverFormat = 'jpeg', artworkSize = 0) {
  if (!artworkUrl) return null;
  let url;
  if (coverFormat === 'original' && artworkSize) {
    url = artworkUrl.replace('{w}', artworkSize).replace('{h}', artworkSize);
  } else {
    url = artworkUrl.replace('{w}', size).replace('{h}', size);
  }
  if (coverFormat === 'png') url = url.replace(/\.jpg$/, '.png');
  const r = await http(url);
  if (!r.ok) return null;
  return { data: Buffer.from(await r.arrayBuffer()), type: url.includes('.png') ? 'png' : 'jpg' };
}

// ---------- 单首下载 ----------
async function downloadTrack(track, opts, onProgress) {
  const {
    codec = 'alac', wasmPath, coverSize = 600, coverFormat = 'jpeg',
    saveLyrics = true, saveCover = true, lyricLang = 'en', lyricFormat = 'lrc',
    lyricsExtra = [], alacFix: alacFixOpt = true, sortOrder = false,
    fields = null, // 可嵌入标签字段白名单，null = 全部
  } = opts;
  const want = (f) => !fields || fields.includes(f);
  const say = (phase, done, total) => onProgress?.({ phase, done, total });
  const progKey = `${track.adamId}:${codec}`; // V4.6：加载进度卡数据源（AAC 缓冲式播放也走这里）
  reportProg(progKey, { stage: 'playlist', done: 0, total: 0, bytes: 0 });

  say('获取流地址', 0, 1);
  const { m3u8: masterUrl } = await api(CONFIG.wrapperUrl, '/m3u8', { adamId: track.adamId });
  const master = await (await http(masterUrl)).text();
  const variant = pickVariant(master, codec);

  const mediaUrl = new URL(variant.uri, masterUrl).href;
  const media = await (await http(mediaUrl)).text();
  const { keyUris, map, segs } = parseMediaPlaylist(media, mediaUrl);
  reportProg(progKey, { stage: 'key', total: segs.length });

  say('获取密钥', 0, 1);
  const temari = await loadTemari(wasmPath);
  const handles = new Map();
  for (const uri of keyUris) handles.set(uri, await getTemplate(temari, track.adamId, uri));

  const parts = [];
  if (map) parts.push(await fetchBytes(map.url, map.range));
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const frag = await fetchBytes(seg.url, seg.range);
    const h = handles.get(seg.key ?? keyUris[0]);
    if (h) {
      for (const s of findEncryptedSamples(frag)) {
        const plain = temari.decrypt(h, frag.subarray(s.offset, s.offset + s.length));
        if (plain) frag.set ? frag.set(plain, s.offset) : plain.copy(frag, s.offset);
      }
    }
    parts.push(frag);
    say('下载解密', i + 1, segs.length);
    reportProg(progKey, { stage: 'segments', done: i + 1 });
  }

  say('写入标签', 0, 1);
  reportProg(progKey, { stage: 'remux' });
  const cover = want('cover') ? await fetchCover(track.artwork, coverSize, coverFormat, track.artworkSize) : null;
  const lyrics = saveLyrics && track.hasLyrics ? await fetchLyrics(track.adamId, lyricLang, lyricsExtra) : null;
  // 分级：explicit=1 clean=2（iTunes rtng 惯例）
  const rating = want('rating') && track.contentRating
    ? (track.contentRating === 'explicit' ? 1 : track.contentRating === 'clean' ? 2 : 0) : 0;
  // 注意顺序：先写标签（会向 moov 追加 udta），再重封装
  // 若反过来，moov 变长会使重封装算出的 stco 绝对偏移失效
  const tagged = tagM4A(Buffer.concat(parts), {
    title: want('title') ? track.title : '',
    artist: want('artist') ? track.artist : '',
    album: want('album') ? track.album : '',
    albumArtist: want('albumArtist') ? track.albumArtist : '',
    composer: want('composer') ? track.composer : '',
    genre: want('genre') ? track.genre : '',
    year: want('year') ? track.year : '',
    trackNumber: want('trackNumber') ? track.trackNumber : 0,
    trackTotal: opts.trackTotal || 0,
    discNumber: want('discNumber') ? track.discNumber : 0,
    lyrics: (want('lyrics') && lyrics) ? lyrics.lrc : '',
    isrc: want('isrc') ? track.isrc : '',
    copyright: want('copyright') ? track.copyright || '' : '',
    recordLabel: want('recordLabel') ? track.recordLabel || '' : '',
    upc: want('upc') ? track.upc || '' : '',
    rating,
    songId: want('songId') ? track.adamId : 0,
    albumId: want('albumId') ? track.albumId : 0,
    artistId: want('artistId') ? track.artistId : 0,
    sortOrder,
    cover: cover?.data, coverType: cover?.type,
  });
  // fMP4 → 经典 MP4 重封装（兼容性：foobar2000 等只读 moov 样本表的播放器）
  let out = tagged;
  if (opts.remux !== false) {
    const r = remuxFMP4(tagged);
    if (r) out = r;
  }
  // ALAC 结束标记修复（Apple END-tag 缺陷，移植自 amd.wol.moe；失败则用原文件）
  if (alacFixOpt && codec === 'alac') {
    try { alacFix(out); } catch {}
  }
  reportProg(progKey, { stage: 'done' });
  return { file: out, cover, lyrics, lyricFormat };
}

module.exports = { resolve, probeCodecs, downloadTrack, streamTrack, prefetch, fetchCover, fetchLyrics, fetchLyricsSplit, search, wrapperStatus, CODECS, parseInput, setConfig, ttmlToLrc, getProgress };
