'use strict';
// ============================================================================
// 下载后元数据写入器（V1.1.10）
//   用已随包分发的 ffmpeg（engine/tools/ffmpeg.exe）给下载音频写标签：
//     标题 / 歌手 / 专辑 / 专辑艺术家 / 曲目号 / 碟号 / 发行时间 / 封面
//   同时旁挂同名 .lrc 歌词文件（洛雪桌面版同款做法，播放器 readLyrics 直接读取）。
//   ffmpeg 是流复制（-c copy）不重编码，mp3(ID3)/flac(Vorbis)/m4a(MP4) 全覆盖。
//   任何失败都静默返回，绝不阻塞下载流程。
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 工具链定位（与 analyzer.js resolveTool 一致：dev/prod 双路径） */
function resolveTool(name) {
  const prod = path.join(process.resourcesPath || '', 'engine', 'tools', name);
  const dev = path.join(__dirname, '..', 'engine', 'tools', name);
  // SVLX 仓库布局：annie/main → 仓库根 engine/tools（V4.3.22 前缺这条，
  // dev 下落回 PATH 找不到 ffmpeg → 下载的歌静默无标签无封面，与分析器当年同款坑）
  const devRoot = path.join(__dirname, '..', '..', 'engine', 'tools', name);
  for (const p of [prod, dev, devRoot]) { try { if (fs.existsSync(p)) return p; } catch { } }
  return name; // 回退 PATH
}

/** 把任意值清洗成 ffmpeg -metadata 可接受的安全字符串（禁 ` 与换行） */
function metaValue(v) {
  if (v == null) return '';
  return String(v).replace(/[`\r\n]/g, ' ').trim();
}

/** 歌词字段专用清洗：保留换行（多行 LRC 是合法标签值；若用 metaValue 把换行洗成空格，
 *  内嵌歌词会变成单行，渲染层 parseLrc 只认行首时间戳 → 歌词无时间轴不滚动） */
function lyricValue(v) {
  if (v == null) return '';
  return String(v).replace(/`/g, '').trim();
}

/** 下载封面图片字节（主进程直连，带超时与大小上限；kwcdn 走 http）
 *  V4.4.6：① 支持 dataURL 直接解码——渲染层 coverProxy 会把 kw http 封面转成 dataURL 回写
 *  song.cover，下载链路拿到 dataURL 此前直接判死（只认 http）→ kw 下载不嵌封面；
 *  ② 魔数校验——只接受 JPEG/PNG/GIF/WEBP，HTML 错误页/重定向页不再被当封面嵌入。 */
function isImageBytes(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true; // RIFF+WEBP
  return false;
}
async function fetchCoverBytes(url, timeoutMs = 10000, maxBytes = 8 * 1024 * 1024, httpFetch) {
  const u = String(url || '');
  if (/^data:image\//i.test(u)) {
    const m = /^data:image\/[a-z]+;base64,(.+)$/is.exec(u);
    if (!m) return null;
    try {
      const buf = Buffer.from(m[1], 'base64');
      return (buf.length > 0 && buf.length <= maxBytes && isImageBytes(buf)) ? buf : null;
    } catch { return null; }
  }
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    // Qobuz 由调用方注入 Electron net.fetch（跟随系统代理）；其他平台维持原全局 fetch
    const resp = await (httpFetch || fetch)(u, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(to);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes || !isImageBytes(buf)) return null;
    return buf;
  } catch { return null; }
}

/** 判断封面字节的 MIME（依据魔数，ffmpeg 无需显式给，但写临时文件用扩展名） */
function coverExt(buf) {
  if (!buf || buf.length < 12) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'webp';
  return 'jpg';
}

/**
 * 给已下载的音频文件写标签 + 封面 + 嵌入歌词。
 * @param {object} opts { dest, title, artist, album, albumArtist, track, disc, date, coverUrl, coverBytes, lyrics, provider }
 * @returns {Promise<{ok:boolean, tagged?:boolean, cover?:boolean, reason?:string}>}
 */
async function writeTags(opts) {
  const dest = opts && opts.dest;
  if (!dest || !fs.existsSync(dest)) return { ok: false, reason: 'no-file' };
  const ext = (path.extname(dest) || '').replace('.', '').toLowerCase();
  // ffmpeg 写标签支持：mp3/flac/m4a(mp4)/ogg/wav(aiff 有限)。ape/dsf 等不支持则跳过
  const supported = ['mp3', 'flac', 'm4a', 'mp4', 'ogg', 'wav', 'aiff', 'aac'];
  if (!supported.includes(ext)) return { ok: false, reason: 'unsupported-ext:' + ext };

  // 封面：优先传入字节，否则按 URL 抓取；embedCover=false 时不嵌入（洛雪「嵌入封面」开关）
  const wantEmbedCover = opts.embedCover !== false;
  let coverBuf = wantEmbedCover ? (opts.coverBytes || null) : null;
  if (wantEmbedCover && !coverBuf && opts.coverUrl) coverBuf = await fetchCoverBytes(opts.coverUrl, 10000, 8 * 1024 * 1024, opts.httpFetch).catch(() => null);

  // 临时输出路径（同目录保证跨设备 rename 原子性）
  const tmpOut = dest.replace(/\.[^.]+$/, '') + '.tagtmp.' + ext;
  const args = ['-y', '-v', 'error', '-i', dest];
  let coverFile = null;
  if (coverBuf) {
    const cExt = coverExt(coverBuf);
    const tmpCover = tmpOut + '.cover.' + cExt;
    try { fs.writeFileSync(tmpCover, coverBuf); } catch { }
    if (fs.existsSync(tmpCover)) args.push('-i', tmpCover);
    coverFile = tmpCover;
  }
  // 音频流全保留；有新封面要写入时显式剔除源文件自带的旧封面流（-map 0:a? 之外排除 0:v），
  // 否则 -map 0 会把旧 attached_pic 一并拷出 → 双封面并存，读取方只认第一张（旧的），
  // 表现为「封面错」：wy 源文件自带 APIC 封面，实测写完两图并存、旧图在前盖新图。
  args.push('-map', '0');
  if (coverFile) args.push('-map', '-0:v', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');

  const meta = {
    title: metaValue(opts.title),
    artist: metaValue(opts.artist),
    album: metaValue(opts.album),
    album_artist: metaValue(opts.albumArtist),
    track: metaValue(opts.track),
    disc: metaValue(opts.disc),
    date: metaValue(opts.date),
    genre: metaValue(opts.genre),
    composer: metaValue(opts.composer),
    comment: metaValue(opts.comment),
    publisher: metaValue(opts.publisher),
  };
  // V3.5.9：clearEmpty=true（曲库手动编辑）时空字段也下发 `-metadata key=` 以删除旧标签；
  // 下载路径默认不传，保持"空值跳过不动原标签"的旧行为
  const clearEmpty = opts.clearEmpty === true;
  for (const k of Object.keys(meta)) {
    if (meta[k] || clearEmpty) args.push('-metadata', `${k}=${meta[k]}`);
  }
  // V1.1.10：嵌入歌词——FLAC 用大写 LYRICS（Vorbis comment），MP3 用小写 lyrics（ID3 USLT）。
  // 实测：flac + LYRICS 有效；mp3 + lyrics 有效（写成 ID3 标签，播放器/ffprobe 可读）。
  // V4.3.22：embedLrc/embedTLrc 开关（洛雪「嵌入歌词 / 同时嵌入翻译歌词」）
  // V4.6.3：embedRLrc/embedLxLrc 开关（洛雪「同时嵌入罗马音 / 逐字歌词(awlrc)」），并入走 buildLyrics 时间轴对齐
  if (opts.embedLrc !== false) {
    const lrc = lyricValue(buildLyrics(
      { lrc: opts.lyrics, tlyric: opts.tlyric, rlyric: opts.rlyric, lxlyric: opts.lxlyric },
      { t: opts.embedTLrc !== false, r: opts.embedRLrc === true, lx: opts.embedLxLrc === true }
    ));
    if (lrc) {
      const lyricKey = ext === 'flac' ? 'LYRICS' : 'lyrics';
      args.push('-metadata', `${lyricKey}=${lrc}`);
    }
  }
  if (coverFile) {
    args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  }
  args.push('-c', 'copy', tmpOut);

  return new Promise((resolve) => {
    const proc = spawn(resolveTool('ffmpeg.exe'), args, { windowsHide: true });
    let errText = '';
    // V4.6.4：stderr 环形截断（此前无上限，持续报错会涨爆内存）+ 120s 超时杀进程树
    // （此前无超时，畸形文件会让 ffmpeg 永久卡住、下载队列整体堵死）
    proc.stderr.on('data', (d) => { errText += d; if (errText.length > 4000) errText = errText.slice(-4000); });
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { require('child_process').execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => { }); } catch { }
      try { proc.kill(); } catch { }
    }, 120000);
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(killer); resolve(r); };
    proc.on('error', (e) => { cleanup(coverFile); finish({ ok: false, reason: 'spawn:' + e.message }); });
    proc.on('close', (code) => {
      cleanup(coverFile);
      if (timedOut) { try { fs.unlinkSync(tmpOut); } catch { } finish({ ok: false, reason: 'ffmpeg-timeout(120s)' }); return; }
      if (code !== 0) {
        try { fs.unlinkSync(tmpOut); } catch { }
        finish({ ok: false, reason: 'ffmpeg-' + code + ':' + errText.split('\n')[0].trim() });
        return;
      }
      // 原子替换
      try {
        fs.renameSync(tmpOut, dest);
        finish({ ok: true, tagged: true, cover: !!coverBuf });
      } catch (e) {
        try { fs.unlinkSync(tmpOut); } catch { }
        finish({ ok: false, reason: 'rename:' + e.message });
      }
    });
  });
}

function cleanup(p) { if (p) { try { fs.unlinkSync(p); } catch { } } }

/* ============ V4.6.3 洛雪同款歌词组装（功能对齐，非代码移植） ============
 * 译文/罗马音并入前做「时间轴对齐过滤」：只保留时间戳与原文匹配的行，防错位（洛雪 lrcTool 同款策略）；
 * 逐字歌词不直接并入文本（<字级时间戳> 普通播放器不认），打包为 awlrc 扩展标签行追加。 */
const _timeFieldExp = /^(?:\[[\d:.]+\])+/g;
const _timeExp = /\d{1,3}(:\d{1,3}){0,2}(?:\.\d{1,3})/g;
const _tz1 = /^0+(\d+)/, _tz2 = /:0+(\d+)/g, _tz3 = /\.0+(\d+)/;
function _fmtTimeLabel(label) { return label.replace(_tz1, '$1').replace(_tz2, ':$1').replace(_tz3, '.$1'); }
function _timeLabelsOf(lrc) {
  const set = new Set();
  for (const raw of String(lrc || '').split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    const m = _timeFieldExp.exec(line);
    if (!m) continue;
    if (!line.replace(_timeFieldExp, '').trim()) continue;
    const times = m[0].match(_timeExp);
    if (times) for (const t of times) set.add(_fmtTimeLabel(t));
  }
  return set;
}
function _filterExtended(lrcLabels, ext) {
  const lines = [];
  for (const raw of String(ext || '').split(/\r\n|\n|\r/)) {
    let line = raw.trim();
    const m = _timeFieldExp.exec(line);
    if (!m) continue;
    const text = line.replace(_timeFieldExp, '').trim();
    if (!text) continue;
    const times = m[0].match(_timeExp);
    if (!times) continue;
    const kept = times.filter((t) => lrcLabels.has(_fmtTimeLabel(t)));
    if (!kept.length) continue;
    if (kept.length !== times.length) line = `[${kept.join('][')}]${text}`;
    lines.push(line);
  }
  return lines.join('\n');
}
function _buildAwlrc(data) {
  const b64 = (s) => Buffer.from(String(s).trim(), 'utf8').toString('base64');
  const parts = [];
  if (data.lrc) parts.push('lrc:' + b64(data.lrc));
  if (data.tlyric) parts.push('tlrc:' + b64(data.tlyric));
  if (data.rlyric) parts.push('rlrc:' + b64(data.rlyric));
  if (data.lxlyric) parts.push('awlrc:' + b64(data.lxlyric)); // awlrc 键 = 逐字歌词本体（洛雪格式）
  return parts.length ? `[awlrc:${parts.join(',')}]` : '';
}
/** data: {lrc, tlyric, rlyric, lxlyric}; opts: {t, r, lx} 三个开关 */
function buildLyrics(data, opts) {
  const lrc = (data && data.lrc) || '';
  if (!lrc.trim()) return '';
  if (!data.tlyric && !data.rlyric && !data.lxlyric) return lrc;
  let out = lrc.trim();
  const labels = _timeLabelsOf(out);
  if (opts.t && data.tlyric) { const f = _filterExtended(labels, data.tlyric); if (f) out += '\n\n' + f + '\n'; }
  if (opts.r && data.rlyric) { const f = _filterExtended(labels, data.rlyric); if (f) out += '\n\n' + f + '\n'; }
  if (opts.lx) { const aw = _buildAwlrc(data); if (aw) out += '\n\n' + aw + '\n'; }
  return out;
}

/**
 * 写 .lrc 歌词文件（与音频同目录同名）。
 * @param {object} opts { dest, lrc, tlyric, rlyric?, lxlyric?, includeTlyric?, includeRlrc?, includeLxlrc?, encoding? }
 *   includeTlyric: 是否把翻译歌词并入文件（默认 true，洛雪「同时将翻译歌词写入歌词文件」）
 *   includeRlrc: 罗马音并入（默认 false）/ includeLxlrc: 逐字歌词 awlrc 打包并入（默认 false）
 *   encoding: 'utf8'（默认）| 'gbk'（洛雪同款编码选项，GBK 经 iconv-lite 编码）
 */
function writeLyric(opts) {
  const dest = opts && opts.dest;
  if (!dest) return { ok: false, reason: 'no-dest' };
  const lrc = opts.lrc || '';
  if (!lrc.trim()) return { ok: false, reason: 'no-lrc' };
  const lrcPath = dest.replace(/\.[^.]+$/, '') + '.lrc';
  try {
    const text = buildLyrics(
      { lrc: opts.lrc, tlyric: opts.tlyric, rlyric: opts.rlyric, lxlyric: opts.lxlyric },
      { t: opts.includeTlyric !== false, r: opts.includeRlrc === true, lx: opts.includeLxlrc === true }
    );
    if (opts.encoding === 'gbk') {
      const iconv = require('iconv-lite');
      fs.writeFileSync(lrcPath, iconv.encode(text, 'gbk'));
    } else {
      fs.writeFileSync(lrcPath, text, 'utf8');
    }
    return { ok: true, path: lrcPath };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/**
 * 把封面字节保存为独立图片文件（与音频同目录同名 .jpg/.png）。
 * 仅"保存封面到本地"开关开启时调用；嵌入标签由 writeTags 独立完成。
 * @param {object} opts { dest, coverBytes }
 */
function writeCoverFile(opts) {
  const dest = opts && opts.dest;
  if (!dest) return { ok: false, reason: 'no-dest' };
  const buf = opts.coverBytes;
  if (!buf || !buf.length) return { ok: false, reason: 'no-cover-bytes' };
  const ext = coverExt(buf);
  const coverPath = dest.replace(/\.[^.]+$/, '') + '.' + ext;
  try {
    fs.writeFileSync(coverPath, buf);
    return { ok: true, path: coverPath };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { writeTags, writeLyric, writeCoverFile, fetchCoverBytes, resolveTool, buildLyrics };
