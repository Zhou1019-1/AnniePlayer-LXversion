'use strict';
// 本地曲库：文件夹递归扫描、内嵌标签读取、同目录 lrc 歌词查找。
// 支持 DSD（dsf/dff，ffmpeg 会转成 PCM 播放）、常见无损/有损格式。

const fs = require('fs');
const path = require('path');

const AUDIO_EXTS = new Set([
  '.flac', '.mp3', '.wav', '.ape', '.m4a', '.aac', '.alac',
  '.aiff', '.aif', '.ogg', '.opus', '.wma', '.dsf', '.dff',
  '.tta', '.wv', '.mka', '.mp2'
]);

function isAudio(file) { return AUDIO_EXTS.has(path.extname(file).toLowerCase()); }

function walk(dir, out, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile() && isAudio(full)) {
      try {
        const st = fs.statSync(full);
        out.push({ path: full, name: e.name, dir, ext: path.extname(e.name).toLowerCase(), size: st.size, mtime: st.mtimeMs });
      } catch { }
    }
  }
}

function scanFolders(folders) {
  const tracks = [];
  for (const f of folders) walk(f, tracks);
  const withCue = applyCueSplit(tracks); // Pro beat0.0.1：CUE 分轨（同步兜底路径同样生效）
  withCue.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN-u-co-pinyin'));
  return withCue;
}

/* Pro beat0.0.1：CUE 分轨——整轨隐藏，替换为虚拟分轨（与 scanWorker 同逻辑） */
function applyCueSplit(tracks) {
  const dirs = new Set(tracks.map(t => t.dir));
  const hidden = new Set(), virtuals = [];
  try {
    const { decodeCue, parseCueText } = require('./cueParser');
    for (const dir of dirs) {
      let ents;
      try { ents = fs.readdirSync(dir); } catch { continue; }
      for (const name of ents) {
        if (!name.toLowerCase().endsWith('.cue')) continue;
        try {
          const cue = parseCueText(decodeCue(fs.readFileSync(path.join(dir, name))));
          if (!cue.file || !cue.tracks.length) continue;
          const audioFull = path.isAbsolute(cue.file) ? cue.file : path.join(dir, cue.file);
          const src = tracks.find(t => t.path === audioFull);
          if (!src) continue;
          hidden.add(audioFull);
          for (const t of cue.tracks) {
            virtuals.push({
              path: audioFull + '#cue' + t.no,
              name: (t.title || 'Track ' + t.no) + path.extname(audioFull),
              dir, ext: src.ext, size: src.size, mtime: src.mtime,
              cue: { src: audioFull, start: t.startSec, end: t.endSec, no: t.no },
              cueMeta: { title: t.title, artist: t.artist || cue.albumArtist || '', album: cue.album || '' }
            });
          }
        } catch { }
      }
    }
  } catch { return tracks; }
  return [...tracks.filter(t => !hidden.has(t.path)), ...virtuals];
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

function mimeFromExt(ext) {
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif' };
  return map[ext.toLowerCase()] || 'image/jpeg';
}

/** 内嵌标签无封面时，查找同目录常见外部封面文件。 */
function findExternalCover(dir) {
  const names = ['cover', 'folder', 'front', 'album', 'art', 'thumb', 'Cover', 'Folder', 'Front', 'Album', 'Art', 'Thumb'];
  for (const n of names) {
    for (const ext of IMAGE_EXTS) {
      const p = path.join(dir, n + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  // 兜底：任意图片文件
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (IMAGE_EXTS.has(path.extname(f).toLowerCase())) return path.join(dir, f);
    }
  } catch { }
  return null;
}

/** 读内嵌标签（标题/艺术家/专辑/时长/码率 + 封面 dataURL）。 */
async function readMeta(filePath) {
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(filePath, { duration: true });
    const c = meta.common || {};
    let cover = null;
    if (Array.isArray(c.picture) && c.picture.length > 0) {
      const pic = c.picture[0];
      cover = `data:${pic.format || 'image/jpeg'};base64,${Buffer.from(pic.data).toString('base64')}`;
    }
    // 内嵌无封面时，尝试读取同目录外部封面文件
    if (!cover) {
      const extCover = findExternalCover(path.dirname(filePath));
      if (extCover) {
        try {
          const buf = fs.readFileSync(extCover);
          if (buf.length > 0 && buf.length < 16 * 1024 * 1024) {
            cover = `data:${mimeFromExt(path.extname(extCover))};base64,${buf.toString('base64')}`;
          }
        } catch { }
      }
    }
    let fileSize = 0, mtimeMs = 0;
    try { const st = fs.statSync(filePath); fileSize = st.size; mtimeMs = st.mtimeMs; } catch { }
    return {
      ok: true,
      title: c.title || path.basename(filePath, path.extname(filePath)),
      artist: c.artist || (c.artists && c.artists[0]) || '未知艺术家',
      album: c.album || '',
      genre: (Array.isArray(c.genre) && c.genre[0]) || '',
      year: c.year || 0,
      duration: meta.format?.duration || 0,
      codec: meta.format?.codec || '',
      sampleRate: meta.format?.sampleRate || 0,
      bitsPerSample: meta.format?.bitsPerSample || 0,
      bitrate: meta.format?.bitrate || 0,
      channels: meta.format?.numberOfChannels || 0,
      fileSize, mtimeMs,
      cover
    };
  } catch (e) {
    return { ok: false, error: e.message, title: path.basename(filePath, path.extname(filePath)), artist: '未知艺术家', album: '', cover: null };
  }
}

/** 批量读取标签（排序用）。limit 并发，返回 {path: meta}。 */
async function readMetaBatch(paths, limit = 4) {
  const out = {};
  let idx = 0;
  async function worker() {
    while (idx < paths.length) {
      const p = paths[idx++];
      try { out[p] = await readMeta(p); } catch (e) { out[p] = { ok: false, error: e.message }; }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, paths.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/** 查找并读取同名 .lrc（自动识别 UTF-8 / GBK）。 */
function readLyrics(filePath) {
  const base = filePath.slice(0, filePath.length - path.extname(filePath).length);
  const candidates = [base + '.lrc', base + '.LRC'];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const buf = fs.readFileSync(p);
      let text;
      if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        text = buf.toString('utf8');
      } else {
        try { text = new TextDecoder('utf8', { fatal: true }).decode(buf); }
        catch { text = new TextDecoder('gbk').decode(buf); }
      }
      return { ok: true, path: p, text };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'no-lrc' };
}

/** 读文件为 Buffer（渲染层节拍分析用）。>64MB 拒绝，防内存爆。 */
function readFileBuffer(filePath) {
  const st = fs.statSync(filePath);
  if (st.size > 64 * 1024 * 1024) throw new Error('文件过大，跳过节拍分析读取');
  return fs.readFileSync(filePath);
}

module.exports = { scanFolders, readMeta, readMetaBatch, readLyrics, readFileBuffer, isAudio };
