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

/** 下载封面图片字节（主进程直连，带超时与大小上限；kwcdn 走 http） */
async function fetchCoverBytes(url, timeoutMs = 10000, maxBytes = 8 * 1024 * 1024) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(u, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(to);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return null;
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
  if (wantEmbedCover && !coverBuf && opts.coverUrl) coverBuf = await fetchCoverBytes(opts.coverUrl).catch(() => null);

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
  // -map 0（原音频流）+ 封面作为附加图；先输出元数据
  args.push('-map', '0');
  if (coverFile) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');

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
  if (opts.embedLrc !== false) {
    let lrc = metaValue(opts.lyrics);
    if (lrc && opts.embedTLrc !== false && opts.tlyric) lrc += '\n' + metaValue(opts.tlyric);
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
    proc.stderr.on('data', (d) => { errText += d; });
    proc.on('error', (e) => { cleanup(coverFile); resolve({ ok: false, reason: 'spawn:' + e.message }); });
    proc.on('close', (code) => {
      cleanup(coverFile);
      if (code !== 0) {
        try { fs.unlinkSync(tmpOut); } catch { }
        resolve({ ok: false, reason: 'ffmpeg-' + code + ':' + errText.split('\n')[0].trim() });
        return;
      }
      // 原子替换
      try {
        fs.renameSync(tmpOut, dest);
        resolve({ ok: true, tagged: true, cover: !!coverBuf });
      } catch (e) {
        try { fs.unlinkSync(tmpOut); } catch { }
        resolve({ ok: false, reason: 'rename:' + e.message });
      }
    });
  });
}

function cleanup(p) { if (p) { try { fs.unlinkSync(p); } catch { } } }

/**
 * 写 .lrc 歌词文件（与音频同目录同名）。
 * @param {object} opts { dest, lrc, tlyric, includeTlyric?, encoding? }
 *   includeTlyric: 是否把翻译歌词并入文件（默认 true，洛雪「同时将翻译歌词写入歌词文件」）
 *   encoding: 'utf8'（默认）| 'gbk'（洛雪同款编码选项，GBK 经 iconv-lite 编码）
 */
function writeLyric(opts) {
  const dest = opts && opts.dest;
  if (!dest) return { ok: false, reason: 'no-dest' };
  const lrc = opts.lrc || '';
  if (!lrc.trim()) return { ok: false, reason: 'no-lrc' };
  const lrcPath = dest.replace(/\.[^.]+$/, '') + '.lrc';
  try {
    const includeT = opts.includeTlyric !== false;
    const text = lrc + (includeT && opts.tlyric ? '\n' + opts.tlyric : '');
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

module.exports = { writeTags, writeLyric, writeCoverFile, fetchCoverBytes, resolveTool };
