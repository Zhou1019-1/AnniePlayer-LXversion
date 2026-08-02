'use strict';
/* Pro beat0.0.1：CUE 分轨解析（worker_threads 安全，无 Electron 依赖）。
 * 支持外挂 .cue（UTF-8 BOM / UTF-8 / GBK），INDEX 01 mm:ss:ff（75fps）。
 * 内嵌 CUE（FLAC cuesheet）由 music-metadata common.cuesheet 提供时走同一解析。 */

function decodeCue(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
    return buf.slice(3).toString('utf8');
  const utf8 = buf.toString('utf8');
  // UTF-8 解码出现大量替换字符时按 GBK 重解（中文 CUE 常见）
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > 2) {
    try {
      const iconv = require('iconv-lite');
      if (iconv.encodingExists('gbk')) return iconv.decode(buf, 'gbk');
    } catch { }
  }
  return utf8;
}

function tsToSec(ts) {
  const m = /(\d+)\s*:\s*(\d+)\s*:\s*(\d+)/.exec(ts);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]) + (+m[3]) / 75;
}

function unquote(s) {
  s = (s || '').trim();
  const q = /^"(.*)"$/.exec(s);
  return q ? q[1] : s;
}

/**
 * 解析 CUE 文本。
 * 返回 { file, album, albumArtist, tracks: [{ no, title, artist, startSec, endSec|null }] }
 */
function parseCueText(text) {
  const lines = text.split(/\r?\n/);
  const cue = { file: '', album: '', albumArtist: '', tracks: [] };
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = /^FILE\s+"?([^"]+)"?\s+\w+/i.exec(line))) { cue.file = unquote(m[1]); continue; }
    if ((m = /^TRACK\s+(\d+)\s+AUDIO/i.exec(line))) {
      cur = { no: +m[1], title: '', artist: '', startSec: null, endSec: null };
      cue.tracks.push(cur);
      continue;
    }
    if ((m = /^TITLE\s+(.+)$/i.exec(line))) {
      if (cur && !cur.title) cur.title = unquote(m[1]);
      else if (!cur) cue.album = unquote(m[1]);
      continue;
    }
    if ((m = /^PERFORMER\s+(.+)$/i.exec(line))) {
      if (cur && !cur.artist) cur.artist = unquote(m[1]);
      else if (!cur) cue.albumArtist = unquote(m[1]);
      continue;
    }
    if ((m = /^INDEX\s+01\s+(\d+\s*:\s*\d+\s*:\s*\d+)/i.exec(line))) {
      if (cur) cur.startSec = tsToSec(m[1]);
      continue;
    }
  }
  // 起止时间：下一轨起点即本轨终点；末轨 null（到文件尾）
  for (let i = 0; i < cue.tracks.length; i++) {
    const t = cue.tracks[i];
    if (t.startSec == null) t.startSec = i === 0 ? 0 : cue.tracks[i - 1].endSec;
    t.endSec = i + 1 < cue.tracks.length ? cue.tracks[i + 1].startSec : null;
    if (!t.title) t.title = 'Track ' + String(t.no).padStart(2, '0');
    if (!t.artist) t.artist = cue.albumArtist;
  }
  cue.tracks = cue.tracks.filter(t => t.startSec != null);
  return cue;
}

module.exports = { decodeCue, parseCueText };
