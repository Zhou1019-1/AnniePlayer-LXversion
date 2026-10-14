'use strict';
/* ============================================================================
 * V4.4.3：国际元数据源（LRCLIB 同步歌词 / MusicBrainz 标签 / Cover Art Archive 封面）
 * - 纯 Node 模块：顶层不 require('electron'）（规范 12）；fetch 可注入（主进程传 net.fetch 走系统代理）
 * - 定位是「补充源」：境外服务，无代理用户可能连不上——调用方必须 catch 后静默降级到国内五源
 * - MusicBrainz 限速 1 req/s（官方硬性要求），模块内建串行节流队列；UA 必带
 * ========================================================================== */

let httpFetch = globalThis.fetch;
let USER_AGENT = 'AnniePlayer/4.4.2 (+https://github.com/Zhou1019-1/AnniePlayer-LXversion)';
function setHttpFetch(fn) { if (typeof fn === 'function') httpFetch = fn; }
function setUserAgent(ua) { if (ua) USER_AGENT = String(ua); }

async function getJson(url) {
  const resp = await httpFetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
  if (!resp.ok) { const e = new Error('HTTP ' + resp.status); e.status = resp.status; throw e; }
  return resp.json();
}

/* ---------------- LRCLIB（同步歌词） ----------------
 * /api/get：四参精确匹配（track+artist+album+duration），最快最准
 * /api/search?q=：模糊兜底；/api/get/{id}：按 id 取歌词正文 */

function lrclibRow(t) {
  return {
    id: t.id,
    name: t.trackName || '', artist: t.artistName || '', album: t.albumName || '',
    duration: Math.round((t.duration || 0) * 1000), // 对齐洛雪 song.duration 毫秒口径
    synced: !!t.syncedLyrics,
  };
}

/** 关键词搜索（候选列表用；只回有歌词的条目前 5，歌词正文不回传——apply 时按 id 再取） */
async function lrclibSearch({ title, artist, keyword }) {
  const q = String(keyword || ((title || '') + ' ' + (artist || ''))).trim();
  if (!q) return [];
  const arr = await getJson('https://lrclib.net/api/search?q=' + encodeURIComponent(q)).catch(() => null);
  if (!Array.isArray(arr)) return [];
  return arr.filter((t) => t && (t.syncedLyrics || t.plainLyrics)).slice(0, 5).map(lrclibRow);
}

async function lrclibById(id) {
  return getJson('https://lrclib.net/api/get/' + encodeURIComponent(String(id)));
}

/** 取歌词正文：优先精确端点 → 搜索兜底（时长 ±3s 才采信，防张冠李戴）。
 * 返回 { ok, lrc, synced, matched }；同步歌词优先，纯文本兜底。 */
async function lrclibGet({ title, artist, album, durationSec }) {
  if (!title) return { ok: false, reason: 'no-title' };
  const dur = Math.round(durationSec || 0);
  try {
    const u = 'https://lrclib.net/api/get?track_name=' + encodeURIComponent(title) +
      '&artist_name=' + encodeURIComponent(artist || '') +
      '&album_name=' + encodeURIComponent(album || '') +
      '&duration=' + dur;
    const r = await getJson(u);
    const lrc = (r && (r.syncedLyrics || r.plainLyrics)) || '';
    if (lrc.trim()) return { ok: true, lrc: r.syncedLyrics || r.plainLyrics, synced: !!r.syncedLyrics, matched: lrclibRow(r) };
  } catch (e) { /* 404/网络失败 → 走搜索兜底 */ }
  const rows = await lrclibSearch({ title, artist }).catch(() => []);
  const durMs = dur * 1000;
  const pick = rows.find((t) => !durMs || Math.abs(t.duration - durMs) <= 3000);
  if (!pick) return { ok: false, reason: 'lrclib 无匹配' };
  const r = await lrclibById(pick.id).catch(() => null);
  const lrc = (r && (r.syncedLyrics || r.plainLyrics)) || '';
  if (!lrc.trim()) return { ok: false, reason: 'lrclib 无歌词内容' };
  return { ok: true, lrc: r.syncedLyrics || r.plainLyrics, synced: !!r.syncedLyrics, matched: lrclibRow(r) };
}

/* ---------------- MusicBrainz（标签元数据） + Cover Art Archive（封面） ----------------
 * 限速：官方要求 ≤1 req/s，模块内串行队列保证。 */

let _mbChain = Promise.resolve();
let _mbLast = 0;
function mbThrottle() {
  _mbChain = _mbChain.then(async () => {
    const wait = 1100 - (Date.now() - _mbLast);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _mbLast = Date.now();
  });
  return _mbChain;
}

function mbEsc(s) { return String(s || '').replace(/(["\\])/g, '\\$1'); }
function caaCover(releaseId, size) { // size: 250 | 500 | ''（原图 front）
  return releaseId ? 'https://coverartarchive.org/release/' + releaseId + '/front' + (size ? '-' + size : '') : '';
}

/** 录音搜索 → 归一化候选（对齐洛雪 song 口径：name/artist/album/duration(ms)），
 *  _mb 附完整标签包（含曲目号/碟号/日期/专辑艺术家/releaseId，供 writeTags 与 CAA 封面）。 */
async function mbSearch({ title, artist, album, keyword, limit }) {
  let q;
  if (keyword && String(keyword).trim()) q = mbEsc(String(keyword).trim()); // 自由关键词：全文查询
  else {
    if (!title) return [];
    q = 'recording:"' + mbEsc(title) + '"';
    if (artist) q += ' AND artist:"' + mbEsc(artist) + '"';
    if (album) q += ' AND release:"' + mbEsc(album) + '"';
  }
  await mbThrottle();
  const url = 'https://musicbrainz.org/ws/2/recording/?fmt=json&limit=' + (limit || 5) + '&query=' + encodeURIComponent(q);
  const r = await getJson(url).catch(() => null);
  const recs = (r && r.recordings) || [];
  return recs.map((rec) => {
    const ac = (rec['artist-credit'] || []).map((a) => a.name).join('');
    const rel = (rec.releases || [])[0] || null;
    let track = '', disc = '', albumArtist = ac, date = '';
    if (rel) {
      const rac = (rel['artist-credit'] || []).map((a) => a.name).join('');
      if (rac) albumArtist = rac;
      date = rel.date ? String(rel.date).slice(0, 10) : '';
      (rel.media || []).forEach((m) => {
        (m.tracks || []).forEach((tr) => {
          if (tr.recording && tr.recording.id === rec.id) { track = tr.number || ''; disc = String(m.position || ''); }
        });
      });
    }
    return {
      name: rec.title || '', artist: ac,
      album: rel ? (rel.title || '') : '',
      duration: rec.length || 0,
      cover: rel && rel.id ? caaCover(rel.id, 250) : '',
      _mb: {
        title: rec.title || '', artist: ac,
        album: rel ? (rel.title || '') : '', albumArtist, date, track, disc,
        duration: rec.length || 0,
        releaseId: (rel && rel.id) || '',
      },
    };
  });
}

module.exports = { setHttpFetch, setUserAgent, lrclibSearch, lrclibById, lrclibGet, mbSearch, caaCover };
