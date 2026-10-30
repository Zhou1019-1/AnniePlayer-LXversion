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
  try { require('../jsonFile').writeJsonAtomic(settingsFile, streamSettings, 2); } catch { }
}

async function search({ provider, keywords, page, limit }) {
  return lxsdk.search({ provider, keywords, page: page || 1, limit: limit || 30 });
}

async function songUrl(params) {
  return lxsdk.songUrl(params);
}

async function enrichSavedSongs(songs) {
  return lxsdk.enrichSavedSongs(songs);
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
async function songListSearch(params) { return lxsdk.songListSearch(params); }
async function songListDetail(params) { return lxsdk.songListDetail(params); }
/* V4.3：专辑搜索 / 专辑曲目 */
async function albumSearch(params) { return lxsdk.albumSearch(params); }
async function albumSongs(params) { return lxsdk.albumSongs(params); }

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

/** V3.5.19：网易云热门评论（AM 沉浸页评论面板） */
async function hotComments(params) {
  try {
    return { ok: true, ...(await lxsdk.hotComments(params || {})) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 80), comments: [] };
  }
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
 * @param params { provider, quality, song, fileNameFmt?, skipExisting?, signal? }
 *   fileNameFmt: 'artist-name'（默认）| 'name-artist' | 'name'
 *   skipExisting: 下载目录已存在同名文件时直接返回 { skipped:true }
 *   signal: AbortSignal——中止即抛 AbortError（半成品删除，任务管理器据此实现暂停）
 * @param onProgress (receivedBytes, totalBytes) => void
 */
function baseNameFor(song, fmt) {
  const name = sanitizeFileName((song && (song.name || song.id)) || '未命名');
  const artist = sanitizeFileName((song && song.artist) || '未知艺人');
  if (fmt === 'name-artist') return `${name} - ${artist}`;
  if (fmt === 'name') return name;
  return `${artist} - ${name}`;
}
/* V4.6.4：歌单/专辑名清洗为合法的一级子目录名。
 * 复用 sanitizeFileName 去非法字符，再额外剥路径分隔符（防穿越）、去首尾点/空格、
 * 拦 Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9），限长 80 字符。 */
function sanitizeGroupDir(name) {
  // V4.6.4 修正：空输入必须先直接返回 ''——此前复用 sanitizeFileName('') 会返回「未命名」，
  // 导致搜索单曲（groupDir=''）被误建「未命名」文件夹。空 = 不建子目录（落根目录）。
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return '';
  let s = sanitizeFileName(raw);
  // sanitizeFileName 对纯非法字符输入也会回退「未命名」——此时视为无效目录名，不建
  if (s === '未命名') return '';
  s = s.replace(/[\/\\]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80).trim();
  if (!s) return '';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
  return s;
}
/* V4.6.3：落盘前魔数嗅探——URL 层校验只能看扩展名/Content-Type，无扩展名或
 * Content-Type 伪装时加密流（QQ mflac/mgg 实测漏网）会混进来；容器头不符
 * 视为下载失败（删半成品抛错，任务层据此换源）。 */
function sniffMagicOk(filePath, ext) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return true; } // 读不了不拦（保守放行）
  const buf = Buffer.alloc(16);
  let n = 0;
  try { n = fs.readSync(fd, buf, 0, 16, 0); } catch { }
  try { fs.closeSync(fd); } catch { }
  if (n < 4) return false; // 空文件/截断
  const s = (a, b) => buf.slice(a, b).toString('latin1');
  switch (ext) {
    case 'flac': return s(0, 4) === 'fLaC';
    case 'mp3': return s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    case 'm4a': case 'aac': case 'mp4': return s(4, 8) === 'ftyp' || (buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0);
    case 'ogg': return s(0, 4) === 'OggS';
    case 'wav': return s(0, 4) === 'RIFF';
    case 'ape': return s(0, 4) === 'MAC ';
    case 'dsf': return s(0, 3) === 'DSD';
    default: return true; // 不认识的容器不拦
  }
}

/* 下载界面只信成品文件：FLAC 容器/请求档位不等于 Hi-Res，真实位深与采样率由 ffprobe 读取。 */
async function probeDownloadedFile(filePath) {
  const info = await require('../analyzer').probeCodec(filePath).catch(() => null);
  if (!info) return {};
  const codec = String(info.codec || '').toLowerCase();
  const bitDepth = Number(info.bitDepth) || 0;
  const sampleRate = Number(info.sampleRate) || 0;
  const lossless = /flac|alac|wav|aiff|pcm|dsd|ape/.test(codec);
  return {
    actualCodec: codec,
    actualBitDepth: bitDepth,
    actualSampleRate: sampleRate,
    actualQuality: lossless ? ((bitDepth === 1 || bitDepth >= 24 || sampleRate > 48000) ? 'flac24bit' : 'flac') : ''
  };
}

async function download(params, onProgress) {
  /* V4.6：Apple Music 音源走章鱼解密链路（downloadTrack 直接拿 Buffer，含标签/封面/歌词全套），
     不走「songUrl → 拉 URL 流式写盘」通用路径 */
  if (params.provider === 'am') {
    const am = require('./am');
    return am.downloadTrackWithTags(params, onProgress);
  }
  /* V4.6.3 洛雪式下载（国内流媒体，am/qobuz 不动）：
   * - 锁档不降级：lockType 固定用户所选音质，失败即任务失败（不再静默降档）
   * - 断点续传：半成品存 <目标>.part，暂停/断网保留，续下带 Range 头
   * - 链接过期：401/403/410 重新取址（同档锁）后继续 Range 续下（洛雪 refreshUrl 同款）
   * - 网络错误重试最多 3 次（洛雪 tryNum 同款） */
  const getUrl = () => songUrl({ provider: params.provider, song: params.song, quality: params.quality, lockType: true });
  let r = await getUrl();
    if (!r || !r.playable || !r.url) throw new Error((r && r.message) || '无法获取下载地址');
    const song = params.song || {};
    /* V4.6.4：URL 扩展名回退必须白名单校验——此前无扩展名 URL（如 https://host/stream）
     * 会把域名残余（含 / : .）拼进文件名产非法路径。只接受已知音频扩展名，否则回退 mp3。 */
    const KNOWN_EXT = ['mp3', 'flac', 'ape', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'aiff', 'dsf', 'dff'];
    let ext = '';
    if (r.format && /^[a-z0-9]+$/i.test(r.format)) ext = r.format.toLowerCase();
    else {
      const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(r.url.split('?')[0].split('#')[0]);
      if (m && KNOWN_EXT.indexOf(m[1].toLowerCase()) >= 0) ext = m[1].toLowerCase();
    }
    if (!ext || !/^[a-z0-9]+$/.test(ext)) ext = 'mp3';
  const fileName = baseNameFor(song, params.fileNameFmt) + '.' + ext;
  /* V4.6.4：歌单/专辑批量下载自动建子文件夹——渲染层传 groupDir（歌单名/专辑名），
   * 清洗 Windows 非法字符与保留名后拼为下载目录下的一级子目录。空/非法则不建（保持旧行为）。 */
  const groupDir = sanitizeGroupDir(params.groupDir);
  const targetDir = groupDir ? path.join(downloadDir(), groupDir) : downloadDir();
  // 续传任务带 destPath（dlManager 持久化的既定目标路径），跳过撞名处理直接续同一文件
  let dest = params.destPath || path.join(targetDir, fileName);
  // V4.3.22：设置「下载目录存在同名文件时跳过下载此任务」
  if (!params.destPath && params.skipExisting && fs.existsSync(dest)) {
    let size = 0; try { size = fs.statSync(dest).size; } catch { }
    const actual = await probeDownloadedFile(dest);
    return { ok: true, skipped: true, path: dest, size, quality: r.quality || '', level: r.level, ...actual };
  }
  const partOf = (p) => p + '.part';
  if (!params.destPath) {
    let n = 1;
    // 撞名避让同时看完成品与半成品（另一个任务的 .part 不能抢）
    while (fs.existsSync(dest) || fs.existsSync(partOf(dest))) {
      dest = path.join(targetDir, fileName.replace(new RegExp(`\\.${ext}$`), ` (${n++}).${ext}`));
    }
  }
  if (params.onDest) { try { params.onDest(dest); } catch { } }
  // V4.6.4：groupDir 子目录可能不存在，写盘前确保目录已建（递归，幂等）
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { }
  const part = partOf(dest);

  const baseHeaders = {};
  if (r.headers) {
    for (const line of String(r.headers).split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) baseHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const throwAbort = () => { const ae = new Error('已暂停'); ae.name = 'AbortError'; throw ae; };
  const isAbort = (e) => (params.signal && params.signal.aborted) || (e && e.name === 'AbortError');
  const MAX_RETRY = 3;
  let retries = 0, refreshes = 0, received = 0;
  let url = r.url;
  for (;;) {
    if (params.signal && params.signal.aborted) throwAbort();
    let have = 0;
    try { have = fs.statSync(part).size; } catch { }
    const headers = { ...baseHeaders };
    if (have > 0) headers.Range = 'bytes=' + have + '-';
    let resp;
    try {
      resp = await fetch(url, { headers, signal: params.signal });
    } catch (e) {
      if (isAbort(e)) throwAbort();
      if (++retries > MAX_RETRY) throw e;
      await sleep(1000); continue;
    }
    // 链接过期：重新取址（同档锁）后续传——流媒体 URL 有时效，洛雪 refreshUrl 同款
    if (resp.status === 401 || resp.status === 403 || resp.status === 410) {
      try { resp.body && resp.body.cancel(); } catch { }
      if (++refreshes > MAX_RETRY) throw new Error('下载失败：HTTP ' + resp.status + '（链接多次刷新仍过期）');
      const r2 = await getUrl().catch(() => null);
      if (!r2 || !r2.url) { await sleep(1000); continue; }
      url = r2.url;
      continue;
    }
    // 服务器忽略 Range 回 200：从头下（清掉半成品）
    if (have > 0 && resp.status === 200) { have = 0; try { fs.unlinkSync(part); } catch { } }
    // 416 Range 不可满足（半成品已完整或比资源还长）：删半成品从头下（洛雪 Resume failed 同款）
    if (resp.status === 416) {
      try { resp.body && resp.body.cancel(); } catch { }
      try { fs.unlinkSync(part); } catch { }
      continue;
    }
    if (!resp.ok || !resp.body || (have > 0 && resp.status !== 206)) {
      try { resp.body && resp.body.cancel(); } catch { }
      if (++retries > MAX_RETRY) throw new Error('下载失败：HTTP ' + resp.status);
      await sleep(1000); continue;
    }
    const total = have + Number(resp.headers.get('content-length') || 0);
    const out = fs.createWriteStream(part, have > 0 ? { flags: 'a' } : {});
    const reader = resp.body.getReader();
    received = have;
    let failed = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (!out.write(value)) await new Promise((res) => out.once('drain', res));
        if (onProgress) onProgress(received, total);
      }
    } catch (e) {
      failed = e;
    }
    if (failed) {
      out.destroy();
      // 中止（暂停）/ 断线都保留 .part 半成品——续传从断点继续（洛雪式）
      if (isAbort(failed)) throwAbort();
      if (++retries > MAX_RETRY) throw failed;
      await sleep(1000); continue;
    }
    await new Promise((res) => out.end(res));
    break;
  }
  // 传完到改名之间被暂停：同样按中止处理（.part 保留供续传）
  if (params.signal && params.signal.aborted) throwAbort();
  // V4.6.3：魔数嗅探——内容与容器不符（疑为平台加密流）删半成品抛错，任务层据此换源
  if (!sniffMagicOk(part, ext)) {
    try { fs.unlinkSync(part); } catch { }
    throw new Error('下载内容与 ' + ext + ' 容器格式不符（疑为平台加密格式），已丢弃');
  }
  try { fs.renameSync(part, dest); } catch (e) { throw new Error('落盘改名失败：' + (e && e.message)); }

  // V1.1.10：下载后写元数据——封面/标题/歌手/专辑/专辑艺术家/曲目号/碟号/发行时间 + 歌词。
  // 附加项受设置页开关控制：saveLrc（旁挂 .lrc + 嵌入）/ saveCover（嵌入封面）。
  // 全部尽力而为：任何一步失败都不阻塞下载成功返回。
  const tagged = await writeDownloadedTags(dest, song, params.provider, {
    saveLrc: params.saveLrc !== false,
    saveCover: params.saveCover !== false,
    embedCover: params.embedCover !== false,   // V4.3.22：洛雪「嵌入封面」
    embedLrc: params.embedLrc !== false,       // V4.3.22：洛雪「嵌入歌词」
    embedTLrc: params.embedTLrc !== false,     // V4.3.22：洛雪「同时嵌入翻译歌词」
    embedRLrc: params.embedRLrc === true,      // V4.6.3：洛雪「同时嵌入罗马音歌词」
    embedLxLrc: params.embedLxLrc === true,    // V4.6.3：洛雪「同时嵌入逐字歌词(awlrc)」
    lrcTLrc: params.lrcTLrc !== false,         // V4.3.22：洛雪「翻译歌词写入歌词文件」
    lrcRLrc: params.lrcRLrc === true,          // V4.6.3：洛雪「罗马音写入歌词文件」
    lrcLxLrc: params.lrcLxLrc === true,        // V4.6.3：洛雪「逐字歌词(awlrc)写入歌词文件」
    lrcEncoding: params.lrcEncoding || 'utf8', // V4.3.22：洛雪「歌词文件编码 UTF-8/GBK」
  }).catch(() => false);

  const actual = await probeDownloadedFile(dest);
  return { ok: true, path: dest, size: received, quality: r.quality || '', level: r.level, downgraded: !!r.downgraded, requestedType: r.requestedType, tagged: !!tagged, ...actual };
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
    // 2) 拉歌词（嵌入标签始终做；旁挂 .lrc 受 saveLrc 控制）；译文/罗马音/逐字轨一并带回
    let lrc = '', tlyric = '', rlyric = '', lxlyric = '';
    try {
      const lr = await lxsdk.lyric({ provider, song });
      if (lr && lr.lrc) { lrc = lr.lrc; tlyric = lr.tlyric || ''; rlyric = lr.rlyric || ''; lxlyric = lr.lxlyric || ''; }
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
    // 4) 写标签：嵌入歌词（FLAC LYRICS / MP3 USLT）+ 嵌入封面（attached_pic）
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
      tlyric,
      rlyric,
      lxlyric,
      coverUrl,
      coverBytes: coverBuf,
      embedCover: opts.embedCover,
      embedLrc: opts.embedLrc,
      embedTLrc: opts.embedTLrc,
      embedRLrc: opts.embedRLrc,
      embedLxLrc: opts.embedLxLrc,
    }).catch(() => ({ ok: false }));
    // V4.3.22：失败留痕——此前全静默，ffmpeg 路径坑排查无门
    if (!tagRes || !tagRes.ok) console.warn('[dl-tag] 写标签失败：' + dest + '，原因：' + ((tagRes && tagRes.reason) || 'unknown'));
    // 5) 独立文件（受开关控制）：
    //    - saveLrc   → 旁挂同名 .lrc（lrcTLrc 控制是否并入翻译，lrcEncoding 控制编码）
    //    - saveCover → 独立封面图片文件（同名 .jpg/.png）
    if (wantLrc && lrc && lrc.trim()) tagWriter.writeLyric({ dest, lrc, tlyric, rlyric, lxlyric, includeTlyric: opts.lrcTLrc, includeRlrc: opts.lrcRLrc, includeLxlrc: opts.lrcLxLrc, encoding: opts.lrcEncoding });
    if (wantCover && coverBuf) tagWriter.writeCoverFile({ dest, coverBytes: coverBuf });
    return tagRes && tagRes.ok;
  } catch (e) {
    console.warn('[streaming] 写下载元数据失败(不阻塞):', e && e.message);
    return false;
  }
}

/**
 * V4.6.3 自动换源（洛雪 getOtherSource 同款，功能对齐）：跨平台按「歌名 + 歌手 + 时长」找同歌。
 * 匹配规则：歌名归一化后严格相等 +（歌手有交集 或 时长差 ≤3s），双条件二选一防误配；
 * 逐平台搜索（排除当前平台），首个命中即返回。
 * @returns {Promise<{provider, song}|null>}
 */
const _normKey = (s) => String(s || '').toLowerCase().replace(/[\s　·•,，、;；&＆（）()\[\]【】'"/\\-]/g, '');
async function findOtherSource(song, excludeProvider) {
  const name = _normKey(song && song.name);
  if (!name) return null;
  const artist = _normKey(song && song.artist);
  const dur = Number(song && song.duration) || 0; // ms
  const keywords = ((song && song.name) || '') + ' ' + ((song && song.artist) || '');
  for (const p of PROVIDERS) {
    if (p === excludeProvider) continue;
    let list = [];
    try {
      const r = await search({ provider: p, keywords: keywords.trim(), page: 1, limit: 5 });
      list = (r && r.songs) || [];
    } catch { continue; }
    for (const c of list) {
      if (_normKey(c.name) !== name) continue;
      const ca = _normKey(c.artist);
      const artistHit = artist && ca && (ca.includes(artist) || artist.includes(ca));
      const durHit = dur && c.duration && Math.abs(Number(c.duration) - dur) <= 3000;
      if (artistHit || durHit) return { provider: p, song: c };
    }
  }
  return null;
}

module.exports = {
  init, search, songUrl, lyric, getPic, coverProxy, hotSearch, hotComments, download, downloadDir, setDownloadDir, findOtherSource, probeDownloadedFile, enrichSavedSongs,
  leaderboards, leaderboardList, songLists, songListSearch, songListDetail, albumSearch, albumSongs,
  PROVIDERS,
  sources, // 音源管理 API 透出给 IPC 层
};
