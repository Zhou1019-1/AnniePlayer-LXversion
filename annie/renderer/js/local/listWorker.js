'use strict';
/* EXP 7.28 —— 大列表排序/过滤 Web Worker（>1000 首时由主线程 offload 过来）
 * 主线程只接收排序后的索引顺序并重排，不在主线程做拼音 Collator 比较。
 * 排序逻辑与 player.js sortTracks / fb2k.js sortedDeco 对齐（tagOf 为精简副本）。 */

let coll = null;
function getColl() {
  if (!coll) coll = new Intl.Collator('zh-Hans-CN-u-co-pinyin');
  return coll;
}

/* 与 player.js tagOf 等价的标签推导（文件名/文件夹名兜底） */
function tagOf(t, tagCache) {
  const tag = tagCache[t.path] || {};
  let artist = (tag.artist && tag.artist !== '未知艺术家') ? tag.artist : '';
  let album = tag.album || '';
  let year = tag.year || 0;
  const base = t.name.replace(/\.[^.]+$/, '');
  const dirName = t.dir.split(/[\\/]/).filter(Boolean).pop() || '';
  if (!artist) {
    const parts = base.split(' - ').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0], tail = parts[parts.length - 1];
      if (dirName.includes(first)) artist = first;
      else if (dirName.includes(tail)) artist = tail;
      else artist = tail;
    }
  }
  if (!album && dirName) album = dirName.replace(/^CD\s*\d+\s*[-_]?\s*/i, '').trim();
  if (!year) {
    const m = (dirName + ' ' + base).match(/(?<!\d)(19|20)\d{2}(?!\d)/);
    if (m) year = parseInt(m[0], 10);
  }
  return { artist, album, genre: tag.genre || '', year };
}

self.onmessage = (e) => {
  const d = e.data;
  if (!d || !d.op) return;
  const c = getColl();
  const tracks = d.tracks, tagCache = d.tagCache || {};
  const deco = tracks.map((t, i) => {
    const tag = tagOf(t, tagCache);
    return { i, name: t.name, dir: t.dir, mtime: t.mtime || 0, path: t.path, artist: tag.artist, album: tag.album, genre: tag.genre, year: tag.year };
  });
  const cmpName = (a, b) => c.compare(a.name, b.name);
  const cmpZh = (a, b) => c.compare(String(a || ''), String(b || ''));
  const last = (v) => v ? v : '￿';

  if (d.op === 'legacy-sort') {
    const mode = d.mode || 'name';
    if (mode === 'folder') deco.sort((a, b) => cmpZh(a.dir, b.dir) || cmpName(a, b));
    else if (mode === 'mtime') deco.sort((a, b) => (b.mtime - a.mtime));
    else if (mode === 'artist') deco.sort((a, b) => cmpZh(last(a.artist), last(b.artist)) || cmpName(a, b));
    else if (mode === 'album') deco.sort((a, b) => cmpZh(last(a.album), last(b.album)) || cmpName(a, b));
    else if (mode === 'genre') deco.sort((a, b) => cmpZh(last(a.genre), last(b.genre)) || cmpName(a, b));
    else if (mode === 'year') deco.sort((a, b) => ((b.year || 0) - (a.year || 0)) || cmpName(a, b));
    else deco.sort(cmpName);
  } else if (d.op === 'fb2k-sort') {
    const ratings = d.ratings || {}, durs = d.durs || {};
    if (d.sortKey) {
      const dir = d.sortAsc ? 1 : -1;
      deco.sort((a, b) => {
        let r = 0;
        if (d.sortKey === 'title') r = c.compare(a.name, b.name);
        else if (d.sortKey === 'artist') r = c.compare(a.artist || '￿', b.artist || '￿');
        else if (d.sortKey === 'rating') r = (ratings[a.path] || 0) - (ratings[b.path] || 0);
        else if (d.sortKey === 'time') r = (durs[a.path] || 0) - (durs[b.path] || 0);
        return r * dir || c.compare(a.name, b.name);
      });
    } else {
      deco.sort((a, b) => c.compare(a.album || '￿', b.album || '￿') || c.compare(a.name, b.name));
    }
  }
  self.postMessage({ jobId: d.jobId, order: deco.map(x => x.i) });
};
