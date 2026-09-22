'use strict';
/* Pro beat0.0.1 —— 曲库与管理（渲染侧共享模块）
 * 播放统计采集 / 智能列表 / 媒体库聚合（专辑·艺术家）/ 假无损标记。
 * 双主题共用；player.js 与 fb2k.js 通过 window.anniePro 调用。 */
(function () {
  const $ = (s) => document.querySelector(s);
  /* global state, renderCurrentView —— player.js 全局词法绑定（classic script 跨脚本可见） */
  if (typeof state === 'undefined') return;

  /* ================= 播放统计（规则：>30s 或 >50% 计一次；时长累计） ================= */
  let statCur = null, statAccum = 0, statLastPos = 0, statCounted = false;
  function statStore() { return state.library.stats || (state.library.stats = {}); }
  function flushStatTime() {
    if (statCur && statAccum > 0.5) {
      window.mine.statsTime(statCur, statAccum).catch(() => { });
      const s = statStore()[statCur] || (statStore()[statCur] = { count: 0, lastPlayed: 0, totalSec: 0 });
      s.totalSec += statAccum;
    }
  }
  window.mine.onEngineEvent((event, d) => {
    if (event === 'state') { if (d.state === 'ended' || d.state === 'stopped') flushStatTime(); return; }
    if (event !== 'position') return;
    const path = state.currentPath;
    if (!path) return;
    if (path !== statCur) { flushStatTime(); statCur = path; statAccum = 0; statLastPos = d.seconds; statCounted = false; return; }
    const delta = d.seconds - statLastPos;
    statLastPos = d.seconds;
    if (delta > 0 && delta < 2) statAccum += delta; // seek 跳变不计
    const effDur = state.duration || d.duration || 0;
    if (!statCounted && (statAccum >= 30 || (effDur > 0 && state.position >= effDur * 0.5))) {
      statCounted = true;
      window.mine.statsCount(path).then(() => {
        const s = statStore()[path] || (statStore()[path] = { count: 0, lastPlayed: 0, totalSec: 0 });
        s.count++; s.lastPlayed = Date.now();
      }).catch(() => { });
    }
  });

  /* ================= 智能列表 ================= */
  function smartTracks(kind) {
    const stats = state.library.stats || {};
    const tracks = state.library.tracks;
    if (kind === 'new') return [...tracks].sort((a, b) => b.mtime - a.mtime).slice(0, 100);
    // V3.5.19：每日推荐（完全离线，按艺术家偏好加权 + 种子随机）
    if (kind === 'daily') return window.annieSmart ? window.annieSmart.dailyMix(30) : [];
    const arr = tracks.filter(t => stats[t.path] && stats[t.path].count > 0);
    if (kind === 'top') arr.sort((a, b) => (stats[b.path].count || 0) - (stats[a.path].count || 0));
    else arr.sort((a, b) => (stats[b.path].lastPlayed || 0) - (stats[a.path].lastPlayed || 0));
    return arr.slice(0, 100);
  }

  /* ================= 媒体库聚合（专辑 / 艺术家，标签缺失归入"未知"） ================= */
  const UNKNOWN_ARTIST = '未知艺术家', UNKNOWN_ALBUM = '未知专辑';
  function metaOf(p) { return state.library.metaCache[p] || {}; }
  function aggAlbums() {
    const map = new Map();
    for (const t of state.library.tracks) {
      const mc = metaOf(t.path);
      const album = mc.album || UNKNOWN_ALBUM;
      const artist = mc.artist || UNKNOWN_ARTIST;
      const key = album + ' ' + artist;
      let a = map.get(key);
      if (!a) map.set(key, a = { key, album, artist, count: 0, first: t.path });
      a.count++;
    }
    return [...map.values()].sort((x, y) => x.album.localeCompare(y.album, 'zh-Hans-CN-u-co-pinyin'));
  }
  function aggArtists() {
    const map = new Map();
    for (const t of state.library.tracks) {
      const artist = metaOf(t.path).artist || UNKNOWN_ARTIST;
      let a = map.get(artist);
      if (!a) map.set(artist, a = { key: artist, artist, count: 0, first: t.path });
      a.count++;
    }
    return [...map.values()].sort((x, y) => x.artist.localeCompare(y.artist, 'zh-Hans-CN-u-co-pinyin'));
  }
  function albumTracks(key) {
    return state.library.tracks.filter(t => {
      const mc = metaOf(t.path);
      return (mc.album || UNKNOWN_ALBUM) + ' ' + (mc.artist || UNKNOWN_ARTIST) === key;
    });
  }
  function artistTracks(key) {
    return state.library.tracks.filter(t => (metaOf(t.path).artist || UNKNOWN_ARTIST) === key);
  }

  /* ================= 假无损标记 ================= */
  function fakeMark(p) {
    const fs = (state.library.metaCache[p] || {}).fakeScan;
    return fs && fs.verdict === 'suspect' ? fs : null;
  }

  /* ================= 粒子舞台：媒体库视图渲染 ================= */
  /* 专辑封面懒加载（并发 3，避免一次拉爆 meta 通道） */
  const coverCache = new Map();
  const coverQueue = [];
  let coverRunning = 0;
  function lazyCover(imgEl, firstPath) {
    if (coverCache.has(firstPath)) { imgEl.src = coverCache.get(firstPath); return; }
    coverQueue.push([imgEl, firstPath]);
    pumpCover();
  }
  function pumpCover() {
    while (coverRunning < 3 && coverQueue.length) {
      const [imgEl, p] = coverQueue.shift();
      coverRunning++;
      window.mine.meta(p).then(m => {
        const c = m && m.cover;
        if (c) { coverCache.set(p, c); if (imgEl.isConnected) imgEl.src = c; }
      }).catch(() => { }).finally(() => { coverRunning--; pumpCover(); });
    }
  }

  function renderAlbumGrid() {
    lvReset();
    const box = $('#track-list');
    box.innerHTML = '<div class="album-grid"></div>';
    const grid = box.firstChild;
    const kw = ($('#search').value || '').trim().toLowerCase();
    let albums = aggAlbums();
    if (kw) albums = albums.filter(a => a.album.toLowerCase().includes(kw) || a.artist.toLowerCase().includes(kw));
    const frag = document.createDocumentFragment();
    for (const a of albums) {
      const card = document.createElement('div');
      card.className = 'album-card';
      card.innerHTML = `<img alt=""><div class="ac-name" title="${a.album.replace(/"/g, '&quot;')}"></div><div class="ac-sub"></div>`;
      card.querySelector('.ac-name').textContent = a.album;
      card.querySelector('.ac-sub').textContent = `${a.artist} · ${a.count} 首`;
      lazyCover(card.querySelector('img'), a.first);
      card.onclick = () => enterLibNav('tracks', 'album:' + a.key, a.album);
      frag.appendChild(card);
    }
    grid.appendChild(frag);
  }

  function renderArtistList() {
    lvReset();
    const box = $('#track-list');
    box.innerHTML = '';
    const kw = ($('#search').value || '').trim().toLowerCase();
    let artists = aggArtists();
    if (kw) artists = artists.filter(a => a.artist.toLowerCase().includes(kw));
    const frag = document.createDocumentFragment();
    for (const a of artists) {
      const row = document.createElement('div');
      row.className = 'folder-row';
      row.innerHTML = `<span class="f-icon">🎤</span><div class="t-body"><div class="t-name"></div></div><span class="f-count">${a.count} 首</span>`;
      row.querySelector('.t-name').textContent = a.artist;
      row.onclick = () => enterLibNav('tracks', 'artist:' + a.key, a.artist);
      frag.appendChild(row);
    }
    box.appendChild(frag);
  }

  function lvReset() { if (typeof window.__lvReset === 'function') window.__lvReset(); }

  /* 粒子舞台平铺导航的 Pro 特殊行（插在"我的喜爱"之后） */
  function legacySpecialRows() {
    const stats = state.library.stats || {};
    const topN = smartTracks('top').length, recentN = smartTracks('recent').length;
    return [
      { special: 'smart:top', name: '最常听', sub: '按播放次数', count: topN, icon: '🔥' },
      { special: 'smart:recent', name: '最近播放', sub: '按最近播放时间', count: recentN, icon: '🕒' },
      { special: 'smart:new', name: '最近添加', sub: '按文件修改时间', count: Math.min(100, state.library.tracks.length), icon: '🆕' },
      // V3.5.19：每日推荐（本地曲库，种子=日期，同日稳定；count 固定展示不算实数，避免每次渲染全库排序）
      { special: 'smart:daily', name: '每日推荐', sub: '偏好 60% + 探索 40%', count: 30, icon: '✨' },
      { special: 'albums', name: '专辑', sub: '媒体库 · 按专辑聚合', count: aggAlbums().length, icon: '💿' },
      { special: 'artists', name: '艺术家', sub: '媒体库 · 按艺术家聚合', count: aggArtists().length, icon: '🎤' },
    ];
  }

  /* 统一进入/返回（player.js 的 enterFolder/backToFolders 扩展点） */
  function enterLibNav(mode, filter, label) {
    state.libNav.mode = mode;
    state.libNav.folder = filter;
    state.folderFilter = filter;
    renderCurrentView();
  }
  function navLabel() {
    const f = state.libNav.folder || '';
    if (f.startsWith('album:')) return '专辑：' + f.slice(6).split(' ')[0];
    if (f.startsWith('artist:')) return '艺术家：' + f.slice(7);
    if (f === 'smart:top') return '最常听';
    if (f === 'smart:recent') return '最近播放';
    if (f === 'smart:new') return '最近添加';
    if (f === 'smart:daily') return '每日推荐';
    return null;
  }

  window.anniePro = {
    smartTracks, aggAlbums, aggArtists, albumTracks, artistTracks, fakeMark,
    renderAlbumGrid, renderArtistList, legacySpecialRows, enterLibNav, navLabel,
    UNKNOWN_ARTIST, UNKNOWN_ALBUM
  };
})();
