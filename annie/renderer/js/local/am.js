'use strict';
/* ================= Apple Music 风格主题（主题 C，与粒子舞台/FB2K 并列） =================
 * 设计参考：Apple Music for Windows + Liquid Glass —— 磨砂玻璃、封面氛围背景、大字号逐行歌词。
 * 接入方式与 fb2k.js 同构：
 *   - window.annieAM = { mount, refresh }（theme.js 切到 am 时调 mount）
 *   - 播放链路全部复用 player.js 的全局 state / playAt()，队列天然连续
 *   - 引擎事件经 window.mine.onEngineEvent 订阅（position/state/format）
 *   - 自建播放列表走 lib:playlist:* IPC，持久化在主进程 library.json
 *   - 在线搜索走洛雪 musicSdk（stream:search / stream:songUrl），播放经 window.annieStreamPlay
 * 亮/暗：localStorage 'annieplayer.am.light'（'1' 亮 / 默认暗）。
 * 性能约束：表格行不加载封面（mine.meta 是整文件解析，逐行调用会卡死 UI）；
 *   封面仅用于专辑网格/歌单头/正在播放，且并发限流。 */
(function () {
  var LIGHT_KEY = 'annieplayer.am.light';

  var S = {
    mounted: false,
    view: 'songs',        // songs | albums | folders | favorites | stream | pl:<id>
    albumKey: null,       // 专辑详情（albums 视图点入）
    folderKey: null,      // 文件夹详情：{root, seg}（folders 视图点入）
    libFolders: [],       // 媒体库根文件夹（lib:get 缓存）
    search: '',
    playlists: [],
    meta: {},             // path -> {title,artist,album,...}（metaBatch 缓存）
    metaDeep: false,      // 搜索时是否已发起全库标签加载
    cover: {},            // 实际文件 path -> dataURL | null（lazy + 并发限流）
    acover: {},           // 专辑 key -> dataURL | null（专辑级封面共享）
    acoverRep: {},        // 专辑 key -> 代表文件 path
    acoverWait: {},       // 专辑 key -> [cb]（解析中合并等待）
    coverQ: [], coverActive: 0,
    lyrPath: null, lyrLines: [], lyrCur: -1,
    pos: 0, dur: 0, playing: false,
    fmt: '',              // 音质徽标文本（引擎 format 事件 / 流式音质）
    lyricsOn: true,
    // 洛雪在线搜索 / 发现音乐（V3.5.4：排行榜 + 歌单广场）
    stProvider: 'kg', stKw: '', stPage: 0, stAllPage: 1, stResults: [], stIndex: -1,
    stSearching: false, stQuality: 'flac',
    stTab: 'search',           // search | boards | lists
    tabSongs: {},              // 每个页签各自的歌曲列表缓存（切页签恢复）
    boards: [], boardsProvider: '', boardSel: '', boardName: '', bdPage: 0, bdAllPage: 1,
    slLists: [], slProvider: '', slPage: 0, slLimit: 30, slTotal: 0,
    slDetailId: '', slDetailName: '', slDPage: 0, slDLimit: 100, slDTotal: 0
  };
  var R = {};             // DOM 引用表

  var PLATFORMS = { kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐', tx: 'QQ 音乐', wy: '网易云音乐' };
  var TYPE_LABEL = { flac24bit: 'Hi-Res', flac: 'FLAC', '320k': '320K', '128k': '128K' };

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function esc(s) { return String(s == null ? '' : s); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function fmtRemain(sec) { return '-' + fmtTime(sec); }
  function isLight() { try { return localStorage.getItem(LIGHT_KEY) === '1'; } catch (e) { return false; } }

  /* ---------------- 数据 ---------------- */
  function allTracks() {
    // state 是 player.js 的顶层 const（跨脚本共享词法作用域，但不在 window 上）
    return (typeof state !== 'undefined' && state.library && state.library.tracks) || [];
  }
  function trackMeta(t) {
    var m = S.meta[t.path];
    return {
      title: (m && m.title) || String(t.name || '').replace(/\.[^.]+$/, ''),
      artist: (m && m.artist) || '未知艺术家',
      album: (m && m.album) || ''
    };
  }
  /* 按需批量取标签（渲染行时调用，已缓存的自动跳过） */
  function ensureMeta(tracks) {
    var missing = tracks.filter(function (t) { return !S.meta[t.path]; }).slice(0, 200);
    if (!missing.length) return; // 全部命中缓存时绝不能回调查渲染——否则与 renderView 互相递归
    window.mine.metaBatch(missing.map(function (t) { return t.path; })).then(function (out) {
      for (var p in out) S.meta[p] = out[p];
      // 解析失败的曲目主进程不入缓存——打失败标记，防止每次渲染都重复请求
      missing.forEach(function (t) { if (!S.meta[t.path]) S.meta[t.path] = { fail: true }; });
      if (!(window.annieTheme && annieTheme.current === 'am')) return;
      // 专辑网格的分组依赖标签，需整视图重排；曲目表只补丁可见行文本，避免整视图重建
      if (S.view === 'albums' && !S.albumKey) renderView();
      else patchVisibleMeta();
    }).catch(function () { });
  }
  /* 标签到达后只更新当前 DOM 里可见行的文本（窗口化/非窗口化均适用） */
  function patchVisibleMeta() {
    if (!R.content) return;
    var rows = R.content.querySelectorAll('tr.am-tr');
    for (var k = 0; k < rows.length; k++) {
      var tr = rows[k], m = S.meta[tr.dataset.path];
      if (!m || m.fail) continue;
      var titleEl = tr.querySelector('.am-c-title');
      if (titleEl && m.title) titleEl.textContent = m.title;
      var dims = tr.querySelectorAll('.am-c-dim');
      if (dims[0] && m.artist) dims[0].textContent = m.artist;
      if (dims[1]) dims[1].textContent = m.album || '';
    }
  }
  /* 搜索时全库深加载标签（metaCache 持久化，全库解析只有一次成本；分块避免一次 IPC 过大） */
  function ensureMetaDeep() {
    if (S.metaDeep) return;
    S.metaDeep = true;
    var idx = 0, CHUNK = 400;
    function step() {
      var all = allTracks();
      var missing = [];
      while (idx < all.length && missing.length < CHUNK) {
        var t = all[idx++];
        if (!S.meta[t.path]) missing.push(t.path);
      }
      if (!missing.length && idx >= all.length) return; // 全部完成
      if (!missing.length) { step(); return; }
      window.mine.metaBatch(missing).then(function (out) {
        for (var p in out) S.meta[p] = out[p];
        missing.forEach(function (p) { if (!S.meta[p]) S.meta[p] = { fail: true }; });
        // 新标签可能让新曲目命中搜索，需重绘；但按块到达，200ms 合并避免每块整表重建
        if (S.search && window.annieTheme && annieTheme.current === 'am') {
          clearTimeout(S._deepRT);
          S._deepRT = setTimeout(renderView, 200);
        }
        setTimeout(step, 30); // 让出主线程，避免搜索框打字卡顿
      }).catch(function () { setTimeout(step, 500); });
    }
    step();
  }
  /* 封面 lazy + 并发限流（最多 3 个 meta 解析同时在飞，防止 IPC 风暴卡 UI） */
  function ensureCover(path, cb) {
    if (S.cover[path] !== undefined) { cb(S.cover[path]); return; }
    S.coverQ.push({ path: path, cb: cb });
    pumpCoverQ();
  }
  function pumpCoverQ() {
    while (S.coverActive < 3 && S.coverQ.length) {
      var job = S.coverQ.shift();
      if (S.cover[job.path] !== undefined) { job.cb(S.cover[job.path]); continue; }
      S.coverActive++;
      (function (j) {
        window.mine.meta(j.path).then(function (m) {
          S.cover[j.path] = (m && m.cover) || null;
        }).catch(function () { S.cover[j.path] = null; }).then(function () {
          S.coverActive--;
          j.cb(S.cover[j.path]);
          pumpCoverQ();
        });
      })(job);
    }
  }
  /* ---------- 专辑级封面共享：整张专辑只解析一个文件的封面，专辑内曲目复用 ---------- */
  function srcFileOf(t) { return (t.cue && t.cue.src) || (t.iso && t.iso.src) || t.path; }
  function albumKeyOf(t) {
    var m = trackMeta(t);
    return m.album || ('dir:' + (t.dir || '')); // 无专辑标签时按目录分组（同目录≈同专辑）
  }
  /* 取某曲目所在专辑的封面；cb(dataURL|null)。同专辑并发请求合并，只解析一次 */
  function albumCover(t, cb) {
    var key = albumKeyOf(t);
    if (S.acover[key] !== undefined) { cb(S.acover[key]); return; }
    if (S.acoverWait[key]) { S.acoverWait[key].push(cb); return; }
    S.acoverWait[key] = [cb];
    if (!S.acoverRep[key]) S.acoverRep[key] = srcFileOf(t);
    var rep = S.acoverRep[key];
    S.coverQ.push({
      path: rep,
      cb: function (url) {
        S.acover[key] = url || null;
        var waiters = S.acoverWait[key] || [];
        delete S.acoverWait[key];
        waiters.forEach(function (w) { w(S.acover[key]); });
      }
    });
    // 复用底层并发限流队列，但绕过 path 级缓存（rep 可能被其他专辑引用）
    if (S.cover[rep] !== undefined) {
      // 已有 path 级结果——直接出队这个 job 立即结算
      for (var i = S.coverQ.length - 1; i >= 0; i--) {
        if (S.coverQ[i].path === rep) { var job = S.coverQ.splice(i, 1)[0]; job.cb(S.cover[rep]); break; }
      }
    }
    pumpCoverQ();
  }
  /* ---------- 文件夹视图：按媒体库根目录下的一级子文件夹分组（根目录本身不外显） ---------- */
  function normP(p) { return String(p || '').replace(/\//g, '\\'); }
  function folderGroupOf(t) {
    var p = normP(t.path);
    for (var i = 0; i < S.libFolders.length; i++) {
      var root = normP(S.libFolders[i]).replace(/\\+$/, '');
      if (root && p.toLowerCase().indexOf(root.toLowerCase() + '\\') === 0) {
        var rel = p.slice(root.length + 1);
        var seg = rel.indexOf('\\') >= 0 ? rel.split('\\')[0] : ''; // '' = 直接放在根目录的文件
        return { root: root, seg: seg };
      }
    }
    return { root: '', seg: normP(t.dir || '') }; // 不在任何根目录下：退化为按所在目录分组
  }
  function folderGroups() {
    var map = {};
    allTracks().forEach(function (t) {
      var g = folderGroupOf(t);
      var key = (g.root + '\\' + g.seg).toLowerCase();
      if (!map[key]) map[key] = { root: g.root, seg: g.seg, count: 0 };
      map[key].count++;
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  function currentTracks() {
    var list = allTracks();
    if (S.view === 'favorites') {
      list = list.filter(function (t) { return state.favorites && state.favorites.has(t.path); });
    } else if (S.view.indexOf('pl:') === 0) {
      var pl = S.playlists.find(function (p) { return p.id === S.view.slice(3); });
      var paths = pl ? pl.paths : [];
      var byPath = {};
      list.forEach(function (t) { byPath[t.path] = t; });
      list = paths.map(function (p) { return byPath[p]; }).filter(Boolean);
    } else if (S.view === 'albums' && S.albumKey) {
      list = list.filter(function (t) { return (trackMeta(t).album || '未知专辑') === S.albumKey; });
    } else if (S.view === 'folders' && S.folderKey) {
      var fk = S.folderKey;
      list = list.filter(function (t) {
        var g = folderGroupOf(t);
        return g.root === fk.root && g.seg === fk.seg;
      });
    }
    if (S.search) {
      var q = S.search.toLowerCase();
      list = list.filter(function (t) {
        var m = trackMeta(t);
        return (m.title + ' ' + m.artist + ' ' + m.album).toLowerCase().indexOf(q) >= 0;
      });
    }
    return list;
  }
  function refreshPlaylists() {
    return window.mine.playlists().then(function (pls) {
      S.playlists = Array.isArray(pls) ? pls : [];
      renderSidebar();
      if (S.view.indexOf('pl:') === 0) renderView();
    }).catch(function () { });
  }

  /* ---------------- 播放控制 ---------------- */
  function playList(list, i) {
    state.queue = list;
    // 播放模式"全文件顺序/随机"的上下文标记：队列是否就是全库（全文件顺序仅此时生效）
    var all = allTracks();
    state.queueCtx = (list.length === all.length && list[0] === all[0]) ? 'all' : 'list';
    playAt(i);
  }
  function togglePlay() {
    if (!state.currentPath && allTracks().length) { playList(allTracks(), 0); return; }
    window.mine.engine(state.playing ? 'pause' : 'resume').catch(function () { });
  }
  function next() {
    if (state.currentStream) { nextStream(); return; } // 流媒体不接管：走流媒体自己的续播
    if (!state.queue.length) return;
    // 播放模式接管（仅本地）；未接管时保持旧手动行为（末尾回卷）
    if (window.annieNextByMode && window.annieNextByMode()) return;
    playAt((state.index + 1) % state.queue.length);
  }
  function prev() {
    if (state.currentStream) { prevStream(); return; }
    if (!state.queue.length) return;
    if (S.pos > 3) playAt(state.index); else playAt(Math.max(0, state.index - 1));
  }
  function seek(sec) {
    var base = state.currentCue ? state.currentCue.start : 0;
    window.mine.engine('seek', { seconds: base + Math.max(0, sec) }, 30000).catch(function () { });
  }

  /* ---------------- 洛雪在线搜索 ---------------- */
  function doStreamSearch(fresh) {
    var kw = S.stKw;
    if (!kw || S.stSearching) return;
    S.stSearching = true;
    var provider = S.stProvider;
    var page = fresh ? 1 : S.stPage + 1;
    renderStreamStatus(fresh ? PLATFORMS[provider] + ' 搜索中…' : '加载第 ' + page + ' 页…');
    window.mine.streamSearch({ provider: provider, keywords: kw, page: page, limit: 30 }).then(function (r) {
      if (provider !== S.stProvider && fresh) return;
      S.stResults = fresh ? (r.songs || []) : S.stResults.concat(r.songs || []);
      S.stPage = r.page || page;
      S.stAllPage = r.allPage || 1;
      if (fresh) S.stIndex = -1;
      S.stSearching = false;
      renderView();
      renderStreamStatus(PLATFORMS[provider] + '：共 ' + (r.total != null ? r.total : S.stResults.length) +
        ' 首 · 已加载 ' + S.stResults.length + ' 首（第 ' + S.stPage + '/' + S.stAllPage + ' 页）');
    }).catch(function (e) {
      S.stSearching = false;
      renderStreamStatus('搜索失败：' + (e.message || e), true);
    });
  }
  function renderStreamStatus(text, warn) { if (R.stStatus) { R.stStatus.textContent = text || ''; R.stStatus.classList.toggle('warn', !!warn); } }
  function playStreamAt(i) {
    var song = S.stResults[i];
    if (!song) return;
    S.stIndex = i;
    highlightStreamRow();
    renderStreamStatus('正在获取播放地址：' + song.name + '…');
    window.mine.streamSongUrl({ provider: song.provider, quality: S.stQuality, song: song }).then(function (r) {
      if (S.stIndex !== i) return;
      if (!r || !r.playable || !r.url) { renderStreamStatus(song.name + '：' + ((r && r.message) || '无法播放'), true); return; }
      S.fmt = (r.quality || '') + (r.format ? ' · ' + String(r.format).toUpperCase() : '');
      refreshBadge();
      renderStreamStatus(PLATFORMS[song.provider] + ' · ' + (r.quality || '') + ' ' + (r.format || '').toUpperCase() + ' · 独占输出中');
      if (window.annieStreamPlay) {
        // 单击即播（与洛雪流媒体面板一致）；annieStreamPlay 返回 false 表示引擎拒绝流地址
        Promise.resolve(window.annieStreamPlay({
          url: r.url, headers: r.headers || null,
          title: song.name, artist: song.artist, album: song.album || '',
          cover: song.cover || '', duration: song.duration ? song.duration / 1000 : 0,
          provider: song.provider, quality: r.quality || ''
        })).then(function (ok) {
          if (ok === false) { renderStreamStatus(song.name + '：播放失败，引擎未接受流地址', true); return; }
          // 播放确认后取歌词：注入缓存 + 广播给 AM 歌词面板 + 同步粒子舞台
          if (window.mine.streamLyric) {
            window.mine.streamLyric({ provider: song.provider, song: song }).then(function (ly) {
              if (!ly || !ly.lrc) return;
              if (S.stIndex !== i || !state.currentStream || !state.currentPath) return;
              window.__annieStreamLrcByPath = window.__annieStreamLrcByPath || {};
              window.__annieStreamLrcByPath[state.currentPath] = ly.lrc;
              if (window.annieStage && window.annieStage.setLyricText) window.annieStage.setLyricText(ly.lrc);
              try { document.dispatchEvent(new CustomEvent('annie-stream-lyric', { detail: { path: state.currentPath } })); } catch (e) { }
            }).catch(function () { });
          }
        });
      }
      if (!song.cover && window.mine.streamGetPic) {
        window.mine.streamGetPic({ provider: song.provider, song: song }).then(function (p) {
          if (p && p.url) { song.cover = p.url; if (S.stResults.indexOf(song) >= 0 && S.view === 'stream') renderView(); }
        }).catch(function () { });
      }
    }).catch(function (e) { renderStreamStatus('获取播放地址失败：' + (e.message || e), true); });
  }
  function nextStream() {
    if (S.stIndex < S.stResults.length - 1) { playStreamAt(S.stIndex + 1); return; }
    // V3.5.8：播放定时·播完当前列表停止（在线列表播完自然停止，补提示与清理）
    var t = window.annieSleepTimer && window.annieSleepTimer.get();
    if (t && t.type === 'queue') {
      window.annieSleepTimer.clear();
      try { if (typeof proToast === 'function') proToast('当前列表已播完，已停止'); } catch (e) { }
    }
  }
  function prevStream() { if (S.pos > 3) { seek(0); return; } if (S.stIndex > 0) playStreamAt(S.stIndex - 1); }
  function highlightStreamRow() {
    if (!R.content) return;
    var rows = R.content.querySelectorAll('.am-tr[data-st]');
    rows.forEach(function (r) { r.classList.toggle('cur', +r.dataset.st === S.stIndex); });
  }
  /* 流媒体自然结束续播：仅当当前流来自 AM 搜索列表时才接管，否则交还 streaming.js 原逻辑 */
  function patchStreamPlayNext() {
    if (!window.annieStream || window.annieStream.__amPatched) return;
    var orig = window.annieStream.playNext;
    window.annieStream.playNext = function () {
      if (window.annieTheme && annieTheme.current === 'am' && state.currentStream &&
          S.stIndex >= 0 && S.stResults[S.stIndex] &&
          state.currentStream.title === S.stResults[S.stIndex].name) {
        // V3.5.8：播放定时·单曲循环 N 遍（在线播放）
        var t = window.annieSleepTimer && window.annieSleepTimer.get();
        if (t && t.type === 'repeatN') {
          t.played++;
          if (t.played < t.total) { playStreamAt(S.stIndex); return; }
          window.annieSleepTimer.clear();
          try { if (typeof proToast === 'function') proToast('单曲循环 ' + t.total + ' 遍已播完，已停止'); } catch (e) { }
          return;
        }
        nextStream();
      } else if (orig) orig();
    };
    window.annieStream.__amPatched = true;
  }

  /* ---------------- 构建 DOM ---------------- */
  function build() {
    var root = document.getElementById('am-root');
    root.innerHTML = '';
    root.classList.toggle('am-light', isLight());
    root.classList.toggle('am-lyr-on', S.lyricsOn);

    /* 顶栏（拖拽由 CSS 标准模式处理：容器 drag + 交互子元素 no-drag） */
    var top = el('div', 'am-topbar');
    var tp = el('div', 'am-transport');
    R.btnPrev = el('button', 'am-tbtn', '⏮'); R.btnPrev.title = '上一首';
    R.btnPlay = el('button', 'am-tbtn am-play', '▶'); R.btnPlay.title = '播放/暂停';
    R.btnNext = el('button', 'am-tbtn', '⏭'); R.btnNext.title = '下一首';
    R.btnPrev.onclick = prev; R.btnPlay.onclick = togglePlay; R.btnNext.onclick = next;
    tp.appendChild(R.btnPrev); tp.appendChild(R.btnPlay); tp.appendChild(R.btnNext);
    top.appendChild(tp);

    /* 中央：封面 + 标题/艺人 + 音质徽标；下行：当前时间 · 进度 · 剩余时间 */
    var np = el('div', 'am-np');
    var npRow = el('div', 'am-np-row');
    R.npCover = el('img', 'am-np-cover'); R.npCover.alt = '';
    var npText = el('div', 'am-np-text');
    R.npTitle = el('div', 'am-np-title', '未在播放');
    R.npSub = el('div', 'am-np-sub', '');
    npText.appendChild(R.npTitle); npText.appendChild(R.npSub);
    R.npBadge = el('span', 'am-badge'); R.npBadge.style.display = 'none';
    npRow.appendChild(R.npCover); npRow.appendChild(npText); npRow.appendChild(R.npBadge);
    np.appendChild(npRow);
    var progRow = el('div', 'am-np-progrow');
    R.npCur = el('span', 'am-np-time', '0:00');
    R.npProg = el('div', 'am-np-prog'); R.npProgFill = el('i');
    R.npProg.appendChild(R.npProgFill);
    R.npProg.onclick = function (e) {
      if (!S.dur) return;
      var r = R.npProg.getBoundingClientRect();
      seek(S.dur * Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    };
    R.npRemain = el('span', 'am-np-time', '0:00');
    progRow.appendChild(R.npCur); progRow.appendChild(R.npProg); progRow.appendChild(R.npRemain);
    np.appendChild(progRow);
    top.appendChild(np);

    var right = el('div', 'am-tb-right');
    var vol = el('div', 'am-vol');
    vol.appendChild(el('span', null, '🔊'));
    R.vol = document.createElement('input');
    R.vol.type = 'range'; R.vol.min = 0; R.vol.max = 100;
    var legacyVol = document.querySelector('#volume');
    R.vol.value = legacyVol ? legacyVol.value : 80;
    R.vol.oninput = function () {
      var g = (+R.vol.value) / 100;
      window.mine.engine('volume.set', { gain: g }).catch(function () { });
      if (legacyVol) legacyVol.value = R.vol.value; // 与粒子舞台底栏音量保持同步
    };
    vol.appendChild(R.vol);
    right.appendChild(vol);
    R.btnExcl = el('button', 'am-tbtn', (window.annieIsExclusive ? window.annieIsExclusive() : true) ? '🔒' : '🔓');
    R.btnExcl.title = 'WASAPI 独占/共享输出（独占 = bit-perfect）';
    R.btnExcl.onclick = async function () {
      if (!window.annieExclusiveToggle) return;
      var on = await window.annieExclusiveToggle();
      R.btnExcl.textContent = on ? '🔒' : '🔓';
    };
    document.addEventListener('annie-exclusive-changed', function (e) {
      if (R.btnExcl) R.btnExcl.textContent = (e.detail && e.detail.exclusive) ? '🔒' : '🔓';
    });
    R.btnLocate = el('button', 'am-tbtn', '🎯'); R.btnLocate.title = '定位当前播放文件';
    R.btnLocate.onclick = locatePlaying;
    right.appendChild(R.btnExcl); right.appendChild(R.btnLocate);
    // 播放模式循环切换（仅本地播放生效）
    R.btnMode = el('button', 'am-tbtn', '→');
    syncModeBtn();
    R.btnMode.onclick = function () {
      if (!window.anniePlayMode) return;
      var inf = window.anniePlayMode.cycle();
      try { if (typeof proToast === 'function') proToast('播放模式：' + inf.label); } catch (e) { }
    };
    document.addEventListener('annie-playmode-changed', syncModeBtn);
    right.appendChild(R.btnMode);
    // 播放定时（仅本地播放生效）
    R.btnTimer = el('button', 'am-tbtn', '⏲');
    R.btnTimer.onclick = function (e) { e.stopPropagation(); toggleTimerPop(); };
    document.addEventListener('annie-sleeptimer-changed', syncTimerBtn);
    right.appendChild(R.btnTimer);
    // 沉浸式播放界面 / 迷你模式
    R.btnImm = el('button', 'am-tbtn', '⤢'); R.btnImm.title = '沉浸式播放界面';
    R.btnImm.onclick = function () { toggleImmersive(); };
    right.appendChild(R.btnImm);
    R.btnMiniM = el('button', 'am-tbtn', '🗕'); R.btnMiniM.title = '迷你模式';
    R.btnMiniM.onclick = function () { enterMini(); };
    right.appendChild(R.btnMiniM);
    // 桌面歌词快捷入口（Alt+L；状态跟随 annie-dlyrics-changed）
    var btnDlyr = el('button', 'am-tbtn' + ((window.annieDlyricsOn && window.annieDlyricsOn()) ? ' on' : ''), '🎤');
    btnDlyr.title = '桌面歌词（Alt+L）';
    btnDlyr.onclick = function () { if (window.annieDlyricsToggle) window.annieDlyricsToggle(); };
    document.addEventListener('annie-dlyrics-changed', function (e) { btnDlyr.classList.toggle('on', !!(e.detail && e.detail.on)); });
    right.appendChild(btnDlyr);
    // 均衡器快捷入口（打开设置中心并定位到播放页）
    var btnEq = el('button', 'am-tbtn', '≣'); btnEq.title = '均衡器';
    btnEq.onclick = function () { if (window.annieSettings) window.annieSettings.openPage('playback'); };
    right.appendChild(btnEq);
    // 设置中心入口（与粒子舞台顶栏 ⚙ 同一个面板）
    var btnSet = el('button', 'am-tbtn', '⚙'); btnSet.title = '设置中心（Ctrl+,）';
    btnSet.onclick = function () { if (window.annieSettings) window.annieSettings.togglePanel(); };
    right.appendChild(btnSet);
    R.btnLyr = el('button', 'am-tbtn' + (S.lyricsOn ? ' on' : ''), '💬'); R.btnLyr.title = '歌词面板';
    R.btnLyr.onclick = function () {
      S.lyricsOn = !S.lyricsOn;
      root.classList.toggle('am-lyr-on', S.lyricsOn);
      R.btnLyr.classList.toggle('on', S.lyricsOn);
    };
    R.btnLight = el('button', 'am-tbtn', isLight() ? '🌙' : '☀'); R.btnLight.title = '亮色/暗色';
    R.btnLight.onclick = function () {
      var l = !isLight();
      try { localStorage.setItem(LIGHT_KEY, l ? '1' : '0'); } catch (e) { }
      root.classList.toggle('am-light', l);
      R.btnLight.textContent = l ? '🌙' : '☀';
    };
    R.btnTheme = el('button', 'am-tbtn', '🎨'); R.btnTheme.title = '切换主题（粒子舞台 → FB2K → Apple Music）';
    R.btnTheme.onclick = function () {
      var order = ['legacy', 'fb2k', 'am'];
      window.annieTheme.switch(order[(order.indexOf(annieTheme.current) + 1) % order.length]);
    };
    right.appendChild(R.btnLyr); right.appendChild(R.btnLight); right.appendChild(R.btnTheme);
    var wb = el('div', 'am-winbtns');
    var bMin = el('button', 'am-tbtn', '—'); bMin.title = '最小化'; bMin.onclick = function () { window.mine.winMin(); };
    var bMax = el('button', 'am-tbtn', '▢'); bMax.title = '最大化'; bMax.onclick = function () { window.mine.winMax(); };
    var bClose = el('button', 'am-tbtn am-close', '✕'); bClose.title = '关闭'; bClose.onclick = function () { window.mine.winClose(); };
    wb.appendChild(bMin); wb.appendChild(bMax); wb.appendChild(bClose);
    right.appendChild(wb);
    top.appendChild(right);

    /* 主体 */
    var body = el('div', 'am-body');
    R.sidebar = el('nav', 'am-side');
    R.content = el('div', 'am-content');
    // 窗口化渲染：滚动时按可视区重建行（rAF 合并，避免滚动事件风暴）
    R.content.addEventListener('scroll', function () {
      if (!S._tbl || S._tblRAF) return;
      S._tblRAF = requestAnimationFrame(function () { S._tblRAF = 0; renderAmWindow(); });
    });
    var lyr = el('aside', 'am-lyrics');
    R.lyrScroll = el('div', 'am-lyr-scroll');
    lyr.appendChild(R.lyrScroll);
    // 歌词外观设置入口（悬浮 ⚙，hover 面板显现）
    R.btnLyrSet = el('button', 'am-lyr-set', '⚙');
    R.btnLyrSet.title = '歌词外观（字号 / 行距）';
    R.btnLyrSet.onclick = function (e) { e.stopPropagation(); toggleLyrSetPop(); };
    lyr.appendChild(R.btnLyrSet);
    body.appendChild(R.sidebar); body.appendChild(R.content); body.appendChild(lyr);

    /* 添加到播放列表弹出菜单 */
    R.pop = el('div', 'am-pop');
    /* 播放定时弹层 */
    R.timerPop = el('div', 'am-pop am-timer-pop');

    root.appendChild(top); root.appendChild(body); root.appendChild(R.pop); root.appendChild(R.timerPop);
    buildMini(root);
    document.addEventListener('click', function (e) {
      if (R.pop.classList.contains('on') && !R.pop.contains(e.target)) R.pop.classList.remove('on');
      if (R.timerPop.classList.contains('on') && !R.timerPop.contains(e.target) && e.target !== R.btnTimer) R.timerPop.classList.remove('on');
      if (R.lyrSetPop && R.lyrSetPop.classList.contains('on') && !R.lyrSetPop.contains(e.target) && e.target !== R.btnLyrSet) R.lyrSetPop.classList.remove('on');
    });

    renderSidebar();
    renderView();
    applyLyrStyle(); // 恢复歌词字号/行距设置（含初次自适应）
  }

  /* ---------------- 侧栏 ---------------- */
  function renderSidebar() {
    if (!R.sidebar) return;
    var sb = R.sidebar;
    sb.innerHTML = '';

    function nav(icon, name, view) {
      var b = el('button', 'am-nav' + (S.view === view && !S.albumKey && !S.folderKey ? ' cur' : ''));
      b.appendChild(el('span', 'am-nav-ico', icon));
      b.appendChild(el('span', 'am-nav-name', name));
      b.onclick = function () { S.view = view; S.albumKey = null; S.folderKey = null; renderSidebar(); renderView(); };
      return b;
    }

    sb.appendChild(el('div', 'am-side-h', '媒体库'));
    sb.appendChild(nav('🔍', '在线音乐', 'stream'));
    // 添加文件夹：只作入口，文件夹列表不外显在 AM 界面（与粒子舞台/FB2K 不同）
    var addFolder = el('button', 'am-nav am-new');
    addFolder.appendChild(el('span', 'am-nav-ico', '＋'));
    addFolder.appendChild(el('span', 'am-nav-name', '添加歌曲文件夹…'));
    addFolder.onclick = function () {
      window.mine.pickFolder().then(function (store) {
        // pickFolder 返回最新 store——顺带刷新根目录列表（文件夹视图分组依赖）
        if (store && Array.isArray(store.folders)) S.libFolders = store.folders;
        return window.mine.scanStart();
      }).catch(function () { });
    };
    sb.appendChild(addFolder);

    sb.appendChild(el('div', 'am-side-h', '资料库'));
    sb.appendChild(nav('🎵', '歌曲', 'songs'));
    sb.appendChild(nav('💿', '专辑', 'albums'));
    sb.appendChild(nav('📁', '文件夹', 'folders'));
    sb.appendChild(nav('❤️', '喜爱歌曲', 'favorites'));

    sb.appendChild(el('div', 'am-side-h', '播放列表'));
    S.playlists.forEach(function (pl) {
      var b = nav('🎧', pl.name, 'pl:' + pl.id);
      var del = el('button', 'am-nav-del', '✕');
      del.title = '删除播放列表';
      del.onclick = function (e) {
        e.stopPropagation();
        if (!confirm('删除播放列表「' + pl.name + '」？')) return;
        window.mine.playlistDelete(pl.id).then(function (pls) {
          S.playlists = pls;
          if (S.view === 'pl:' + pl.id) S.view = 'songs';
          renderSidebar(); renderView();
        });
      };
      b.appendChild(del);
      sb.appendChild(b);
    });
    var add = el('button', 'am-nav am-new');
    add.appendChild(el('span', 'am-nav-ico', '＋'));
    add.appendChild(el('span', 'am-nav-name', '新建播放列表'));
    add.onclick = function () {
      var name = prompt('播放列表名称：', '新建播放列表');
      if (name == null) return;
      window.mine.playlistCreate(name).then(function (pls) {
        S.playlists = pls;
        S.view = 'pl:' + pls[pls.length - 1].id;
        renderSidebar(); renderView();
      });
    };
    sb.appendChild(add);

    // 本地搜索（AM 语义：全库搜索；输入即切回歌曲视图并深加载全库标签）
    var sch = el('div', 'am-search');
    sch.appendChild(el('span', null, '⌕'));
    var inp = document.createElement('input');
    inp.placeholder = '搜索歌曲、艺人、专辑'; inp.value = S.search;
    inp.oninput = function () {
      S.search = inp.value.trim();
      if (S.search) {
        // 搜索是全库行为：专辑网格/文件夹列表/在线搜索里输入时切回歌曲列表
        if (S.view === 'stream' || (S.view === 'albums' && !S.albumKey) || (S.view === 'folders' && !S.folderKey)) {
          S.view = 'songs'; S.albumKey = null; S.folderKey = null;
          renderSidebar();
        }
        ensureMetaDeep(); // 后台分块补齐全库标签（metaCache 持久化，仅首次有成本）
      }
      // 防抖：打字过程中不整表重绘，150ms 静默后一次性渲染
      clearTimeout(S._schT);
      S._schT = setTimeout(renderView, 150);
    };
    sch.appendChild(inp); sb.appendChild(sch);
  }

  /* ---------------- 内容区 ---------------- */
  function renderView() {
    if (!R.content || (window.annieTheme && annieTheme.current !== 'am')) return;
    var c = R.content;
    c.innerHTML = '';

    if (S.view === 'stream') { renderStreamView(c); return; }

    var tracks = currentTracks();

    if (S.view === 'albums' && !S.albumKey) { renderAlbumGrid(c); return; }
    if (S.view === 'folders' && !S.folderKey) { renderFolderList(c); return; }

    if (S.view === 'folders' && S.folderKey) {
      var fback = el('button', 'am-btn', '‹ 文件夹');
      fback.onclick = function () { S.folderKey = null; renderView(); };
      c.appendChild(fback);
      c.appendChild(el('div', 'am-view-h', S.folderKey.seg ||
        (S.folderKey.root ? S.folderKey.root.split('\\').pop() + '（根目录）' : '未分类')));
    } else if (S.view === 'albums' && S.albumKey) {
      var back = el('button', 'am-btn', '‹ 专辑');
      back.onclick = function () { S.albumKey = null; renderView(); };
      c.appendChild(back);
      c.appendChild(el('div', 'am-view-h', S.albumKey));
    } else if (S.view.indexOf('pl:') === 0) {
      renderPlaylistHead(c);
    } else {
      c.appendChild(el('div', 'am-view-h',
        S.view === 'favorites' ? '喜爱歌曲' : '歌曲'));
    }

    if (!tracks.length) {
      c.appendChild(el('div', 'am-empty',
        S.view === 'favorites' ? '还没有喜爱的歌曲' :
        S.view.indexOf('pl:') === 0 ? '播放列表是空的——在歌曲行上点 ⊕ 添加' : '曲库为空，请先在设置中添加音乐文件夹'));
      return;
    }
    renderTrackTable(c, tracks);
    ensureMeta(tracks.slice(0, 120));
  }

  /* 文件夹列表：媒体库根目录下的一级子文件夹（根目录本身不外显） */
  function renderFolderList(c) {
    c.appendChild(el('div', 'am-view-h', '文件夹'));
    var groups = folderGroups();
    if (!groups.length) {
      c.appendChild(el('div', 'am-empty', '曲库为空——点击侧栏"添加歌曲文件夹…"开始'));
      return;
    }
    groups.forEach(function (g) {
      var row = el('div', 'am-folder-row');
      row.appendChild(el('span', 'am-folder-ico', '📁'));
      var name = g.seg || (g.root ? g.root.split('\\').pop() + '（根目录文件）' : '未分类');
      row.appendChild(el('span', 'am-folder-name', name));
      row.appendChild(el('span', 'am-folder-sub', g.count + ' 首'));
      row.onclick = function () { S.folderKey = { root: g.root, seg: g.seg }; renderView(); };
      c.appendChild(row);
    });
  }

  function renderAlbumGrid(c) {
    c.appendChild(el('div', 'am-view-h', '专辑'));
    var tracks = allTracks();
    ensureMeta(tracks.slice(0, 400)); // 专辑分组依赖标签，取回后自动重绘
    var byAlbum = {};
    tracks.forEach(function (t) {
      var m = trackMeta(t);
      var k = m.album || '未知专辑';
      if (!byAlbum[k]) byAlbum[k] = { name: k, artist: m.artist, tracks: [] };
      byAlbum[k].tracks.push(t);
    });
    var grid = el('div', 'am-album-grid');
    Object.keys(byAlbum).sort().forEach(function (k) {
      var a = byAlbum[k];
      var card = el('div', 'am-album-card');
      var img = el('img'); img.alt = ''; img.loading = 'lazy';
      albumCover(a.tracks[0], function (url) { if (url) img.src = url; }); // 与表格共享专辑级缓存
      card.appendChild(img);
      card.appendChild(el('div', 'am-album-name', a.name));
      card.appendChild(el('div', 'am-album-sub', a.artist + ' · ' + a.tracks.length + ' 首'));
      card.onclick = function () { S.albumKey = k; renderView(); };
      grid.appendChild(card);
    });
    c.appendChild(grid);
  }

  function renderPlaylistHead(c) {
    var pl = S.playlists.find(function (p) { return p.id === S.view.slice(3); });
    if (!pl) { S.view = 'songs'; renderView(); return; }
    var head = el('div', 'am-pl-head');
    var tracks = currentTracks();
    if (tracks.length) {
      var img = el('img', 'am-pl-cover'); img.alt = '';
      albumCover(tracks[0], function (url) { if (url) img.src = url; });
      head.appendChild(img);
    } else {
      head.appendChild(el('div', 'am-pl-cover-ph', '🎧'));
    }
    var info = el('div', 'am-pl-info');
    var name = el('div', 'am-pl-name', pl.name);
    name.contentEditable = 'true'; name.spellcheck = false;
    name.onblur = function () {
      var n = name.textContent.trim();
      if (n && n !== pl.name) window.mine.playlistRename(pl.id, n).then(function (pls) { S.playlists = pls; renderSidebar(); });
    };
    name.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } };
    info.appendChild(name);
    info.appendChild(el('div', 'am-pl-meta', pl.paths.length + ' 首歌曲'));
    var acts = el('div', 'am-pl-actions');
    var bPlay = el('button', 'am-btn am-btn-accent', '▶ 播放');
    bPlay.onclick = function () { if (tracks.length) playList(tracks, 0); };
    var bShuffle = el('button', 'am-btn', '🔀 随机播放');
    bShuffle.onclick = function () {
      if (!tracks.length) return;
      playList(tracks, Math.floor(Math.random() * tracks.length));
    };
    acts.appendChild(bPlay); acts.appendChild(bShuffle);
    info.appendChild(acts);
    head.appendChild(info);
    c.appendChild(head);
  }

  /* 本地曲目表：封面按专辑共享（每张专辑只解析一次，行内复用同一 dataURL，解码一次）；
     超 2000 行的巨型列表不渲染封面列以保流畅。
     V3.1：>300 行窗口化渲染——只构建可视区 ±15 行，上下用占位行撑高度，滚动 rAF 合并。 */
  var AM_ROW_H_COVER = 52, AM_ROW_H_PLAIN = 41, AM_WINDOW_MIN = 300, AM_OVERSCAN = 15;
  function buildTrackRow(t, i, opts) {
    var m = trackMeta(t);
    var tr = el('tr', 'am-tr' + (state.currentPath === t.path ? ' cur' : ''));
    tr.dataset.path = t.path; // 定位播放文件用
    if (opts.withCover) {
      var tdCover = el('td');
      var img = el('img', 'am-c-cover'); img.alt = ''; img.loading = 'lazy';
      img.style.visibility = 'hidden';
      albumCover(t, function (url) { if (url) { img.src = url; img.style.visibility = ''; } });
      tdCover.appendChild(img); tr.appendChild(tdCover);
    }
    tr.appendChild(el('td', 'am-c-title', esc(m.title)));
    tr.appendChild(el('td', 'am-c-dim', esc(m.artist)));
    tr.appendChild(el('td', 'am-c-dim', esc(m.album)));
    var acts = el('td', 'am-c-acts');
    var bFav = el('button', 'am-mini-btn' + (state.favorites && state.favorites.has(t.path) ? ' faved' : ''), '♥');
    bFav.title = '喜爱';
    bFav.onclick = function (e) {
      e.stopPropagation();
      window.mine.toggleFavorite(t.path).then(function (favs) {
        state.favorites = new Set(favs);
        bFav.classList.toggle('faved', state.favorites.has(t.path));
        if (S.view === 'favorites') renderView();
      });
    };
    var bAdd = el('button', 'am-mini-btn', '⊕');
    bAdd.title = '添加到播放列表';
    bAdd.onclick = function (e) { e.stopPropagation(); openAddMenu(e.clientX, e.clientY, t.path); };
    acts.appendChild(bFav); acts.appendChild(bAdd);
    if (opts.inPlaylist) {
      var bRm = el('button', 'am-mini-btn', '✕');
      bRm.title = '从播放列表移除';
      bRm.onclick = function (e) {
        e.stopPropagation();
        window.mine.playlistRemove(opts.plId, t.path).then(function (pls) { S.playlists = pls; renderSidebar(); renderView(); });
      };
      acts.appendChild(bRm);
    }
    tr.appendChild(acts);
    tr.ondblclick = function () { playList(opts.tracks, i); };
    return tr;
  }
  function amSpacerRow(h, cols) {
    var tr = el('tr');
    var td = el('td');
    td.colSpan = cols;
    td.style.cssText = 'height:' + h + 'px;padding:0;border:0';
    tr.appendChild(td);
    return tr;
  }
  function renderTrackTable(c, tracks) {
    var tb = el('table', 'am-table');
    var inPlaylist = S.view.indexOf('pl:') === 0;
    var opts = {
      withCover: tracks.length <= 2000,
      inPlaylist: inPlaylist,
      plId: inPlaylist ? S.view.slice(3) : null,
      tracks: tracks
    };
    tb.innerHTML = '<thead><tr>' + (opts.withCover ? '<th style="width:46px"></th>' : '') +
      '<th>歌曲</th><th>艺人</th><th>专辑</th><th style="width:96px"></th></tr></thead>';
    var body = el('tbody');
    tb.appendChild(body);
    c.appendChild(tb);

    if (tracks.length <= AM_WINDOW_MIN) {
      S._tbl = null;
      tracks.forEach(function (t, i) { body.appendChild(buildTrackRow(t, i, opts)); });
      return;
    }
    // 窗口化：可视区 ±15 行
    var rowH = opts.withCover ? AM_ROW_H_COVER : AM_ROW_H_PLAIN;
    var cols = opts.withCover ? 5 : 4;
    var win = { tracks: tracks, opts: opts, body: body, tb: tb, rowH: rowH, cols: cols, lastStart: -1, lastEnd: -1 };
    S._tbl = win;
    renderAmWindow();
  }
  function renderAmWindow() {
    var win = S._tbl, c = R.content;
    if (!win || !c || !win.body.isConnected) { return; }
    var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
    var base = win.tb.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop + headH;
    var st = c.scrollTop, h = c.clientHeight;
    var start = Math.max(0, Math.floor((st - base) / win.rowH) - AM_OVERSCAN);
    var end = Math.min(win.tracks.length, Math.ceil((st + h - base) / win.rowH) + AM_OVERSCAN);
    if (start === win.lastStart && end === win.lastEnd) return;
    win.lastStart = start; win.lastEnd = end;
    var frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(amSpacerRow(start * win.rowH, win.cols));
    for (var i = start; i < end; i++) frag.appendChild(buildTrackRow(win.tracks[i], i, win.opts));
    if (end < win.tracks.length) frag.appendChild(amSpacerRow((win.tracks.length - end) * win.rowH, win.cols));
    win.body.innerHTML = '';
    win.body.appendChild(frag);
  }

  /* ---------------- 发现音乐：数据加载（V3.5.4） ---------------- */
  function switchStreamTab(tab) {
    if (S.stTab === tab) return;
    S.tabSongs[S.stTab] = S.stResults; // 缓存旧页签列表
    S.stTab = tab;
    S.stResults = S.tabSongs[tab] || [];
    S.stIndex = -1;
    if (tab === 'boards' && (S.boardsProvider !== S.stProvider || !S.boards.length)) { renderView(); loadBoards(); return; }
    if (tab === 'lists' && !S.slDetailId && (S.slProvider !== S.stProvider || !S.slLists.length)) { renderView(); loadSongLists(1); return; }
    renderView();
  }
  function switchStreamProvider(k) {
    if (S.stProvider === k) return;
    S.stProvider = k;
    if (S.stTab === 'search') { if (S.stKw) doStreamSearch(true); else renderView(); }
    else if (S.stTab === 'boards') { renderView(); loadBoards(); }
    else { S.slDetailId = ''; S.slDetailName = ''; renderView(); loadSongLists(1); }
  }
  function loadBoards() {
    var provider = S.stProvider;
    renderStreamStatus('加载' + PLATFORMS[provider] + '排行榜…');
    window.mine.streamLeaderboards({ provider: provider }).then(function (r) {
      if (S.stProvider !== provider) return;
      S.boards = r.list || []; S.boardsProvider = provider; S.boardSel = ''; S.boardName = '';
      renderView();
      renderStreamStatus(S.boards.length ? '' : '该平台暂无排行榜');
    }).catch(function (e) { renderStreamStatus('排行榜加载失败：' + (e.message || e), true); });
  }
  function loadBoardList(bangid, name, page) {
    renderStreamStatus('加载「' + name + '」…');
    window.mine.streamLeaderboardList({ provider: S.stProvider, bangid: bangid, page: page || 1 }).then(function (r) {
      S.stResults = page > 1 ? S.stResults.concat(r.songs || []) : (r.songs || []);
      S.stIndex = -1; S.boardSel = bangid; S.boardName = name;
      S.bdPage = r.page || 1; S.bdAllPage = r.allPage || 1;
      renderView();
      renderStreamStatus('「' + name + '」共 ' + (r.total || S.stResults.length) + ' 首 · 已加载 ' + S.stResults.length + ' 首');
    }).catch(function (e) { renderStreamStatus('榜单加载失败：' + (e.message || e), true); });
  }
  function loadSongLists(page) {
    var provider = S.stProvider;
    renderStreamStatus('加载歌单广场…');
    window.mine.streamSongLists({ provider: provider, page: page || 1 }).then(function (r) {
      if (S.stProvider !== provider) return;
      S.slLists = page > 1 ? S.slLists.concat(r.list || []) : (r.list || []);
      S.slProvider = provider; S.slPage = r.page || 1; S.slLimit = r.limit || 30; S.slTotal = r.total || 0;
      renderView(); renderStreamStatus('');
    }).catch(function (e) { renderStreamStatus('歌单加载失败：' + (e.message || e), true); });
  }
  function loadSongListDetail(id, name, page) {
    renderStreamStatus('加载歌单「' + name + '」…');
    window.mine.streamSongListDetail({ provider: S.stProvider, id: id, page: page || 1 }).then(function (r) {
      S.stResults = page > 1 ? S.stResults.concat(r.songs || []) : (r.songs || []);
      S.stIndex = -1; S.slDetailId = id; S.slDetailName = name;
      S.slDPage = r.page || 1; S.slDLimit = r.limit || 100; S.slDTotal = r.total || 0;
      renderView();
      renderStreamStatus('「' + name + '」共 ' + (r.total || S.stResults.length) + ' 首 · 已加载 ' + S.stResults.length + ' 首');
    }).catch(function (e) { renderStreamStatus('歌单详情加载失败：' + (e.message || e), true); });
  }

  /* 搜索结果/榜单/歌单共用的歌曲表格（单击即播） */
  function renderSongsTable(c) {
    var tb = el('table', 'am-table');
    tb.innerHTML = '<thead><tr><th style="width:46px"></th><th>歌曲</th><th>艺人</th><th>专辑</th><th style="width:56px;text-align:right">时长</th><th style="width:110px">音质</th><th style="width:44px"></th></tr></thead>';
    var body = el('tbody');
    S.stResults.forEach(function (song, i) {
      var tr = el('tr', 'am-tr' + (i === S.stIndex ? ' cur' : ''));
      tr.dataset.st = i;
      var tdCover = el('td');
      var img = el('img', 'am-c-cover'); img.alt = ''; img.loading = 'lazy';
      if (song.cover) { img.src = song.cover; img.onerror = function () { img.style.visibility = 'hidden'; }; }
      else img.style.visibility = 'hidden';
      tdCover.appendChild(img); tr.appendChild(tdCover);
      tr.appendChild(el('td', 'am-c-title', esc(song.name)));
      tr.appendChild(el('td', 'am-c-dim', esc(song.artist || '未知艺人')));
      tr.appendChild(el('td', 'am-c-dim', esc(song.album || '')));
      var dur = song.interval || (song.duration ? fmtTime(song.duration / 1000) : '');
      var tdDur = el('td', 'am-c-dim', dur); tdDur.style.textAlign = 'right';
      tr.appendChild(tdDur);
      var tdQ = el('td');
      (song.types || []).forEach(function (t) {
        var hq = t.type === 'flac' || t.type === 'flac24bit';
        tdQ.appendChild(el('span', 'am-qbadge' + (hq ? ' hq' : ''), TYPE_LABEL[t.type] || t.type));
      });
      tr.appendChild(tdQ);
      // V3.5.8：单曲下载按钮（含进度百分比，完成后写入标签/封面/歌词）
      var tdDl = el('td');
      var bDl = el('button', 'am-dl-btn', '⬇');
      bDl.title = '下载到下载目录（音质：' + S.stQuality + '）';
      bDl.onclick = function (e) { e.stopPropagation(); downloadSong(song, bDl); };
      tdDl.appendChild(bDl); tr.appendChild(tdDl);
      tr.onclick = function () { playStreamAt(i); };
      tr.ondblclick = function () { playStreamAt(i); };
      body.appendChild(tr);
    });
    tb.appendChild(body);
    c.appendChild(tb);
  }

  /* V3.5.8：在线歌曲下载（复用主进程 stream:download） */
  var dlState = {}; // _dlKey → 按钮元素
  var dlBound = false;
  function bindDlProgress() {
    if (dlBound || !window.mine.onStreamDownloadProgress) return;
    dlBound = true;
    window.mine.onStreamDownloadProgress(function (p) {
      var btn = dlState[p.key];
      if (btn && btn.isConnected) {
        btn.textContent = p.total ? Math.floor(p.received / p.total * 100) + '%' : Math.floor(p.received / 1048576) + 'M';
      }
    });
  }
  function downloadSong(song, btn) {
    if (!window.mine.streamDownload || btn.disabled) return;
    bindDlProgress();
    var key = 'am-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    dlState[key] = btn;
    btn.disabled = true; btn.textContent = '…';
    var asu = (window.annieSettings && window.annieSettings.ui) || {};
    window.mine.streamDownload({
      provider: song.provider || S.stProvider,
      quality: S.stQuality,
      song: song,
      saveLrc: asu.saveLrc !== false,
      saveCover: asu.saveCover !== false,
      _dlKey: key
    }).then(function (r) {
      delete dlState[key];
      btn.textContent = '✓';
      try { if (typeof proToast === 'function') proToast('已下载：' + (song.name || '') + (r && r.downgraded ? '（已降级为 ' + (r.quality || '') + '）' : '')); } catch (e) { }
    }).catch(function (e) {
      delete dlState[key];
      btn.disabled = false; btn.textContent = '⬇';
      try { if (typeof proToast === 'function') proToast('下载失败：' + (e && e.message || e), 5000); } catch (err) { }
    });
  }

  /* V3.5.8：在线歌单收藏（localStorage 持久化，跨启动保留） */
  var SLFAV_KEY = 'annieplayer.slFavs';
  function slFavs() { try { return JSON.parse(localStorage.getItem(SLFAV_KEY) || '[]'); } catch (e) { return []; } }
  function slFavSave(a) { try { localStorage.setItem(SLFAV_KEY, JSON.stringify(a.slice(0, 200))); } catch (e) { } }
  function slIsFav(id) { return slFavs().some(function (f) { return f.id === id && f.provider === S.stProvider; }); }
  function renderMoreBtn(c, label, fn) {
    var more = el('button', 'am-btn', label);
    more.style.marginTop = '14px';
    more.onclick = fn;
    c.appendChild(more);
  }

  /* ---------------- 在线音乐视图（搜索 / 排行榜 / 歌单广场） ---------------- */
  function renderStreamView(c) {
    c.appendChild(el('div', 'am-view-h', '在线音乐'));

    // 页签 + 音质
    var bar = el('div', 'am-st-bar');
    var tabBox = el('div', 'am-st-pfs');
    [['search', '搜索'], ['boards', '排行榜'], ['lists', '歌单广场']].forEach(function (t) {
      var chip = el('button', 'am-chip' + (S.stTab === t[0] ? ' cur' : ''), t[1]);
      chip.onclick = function () { switchStreamTab(t[0]); };
      tabBox.appendChild(chip);
    });
    bar.appendChild(tabBox);
    var qSel = document.createElement('select');
    qSel.className = 'am-st-quality';
    [['flac24bit', 'Hi-Res'], ['flac', 'FLAC'], ['320k', '320K'], ['128k', '128K']].forEach(function (q) {
      var o = document.createElement('option'); o.value = q[0]; o.textContent = q[1]; qSel.appendChild(o);
    });
    qSel.value = S.stQuality;
    qSel.onchange = function () { S.stQuality = qSel.value; };
    bar.appendChild(qSel);
    c.appendChild(bar);

    // 平台
    var pfBar = el('div', 'am-st-bar');
    var pf = el('div', 'am-st-pfs');
    Object.keys(PLATFORMS).forEach(function (k) {
      var chip = el('button', 'am-chip' + (S.stProvider === k ? ' cur' : ''), PLATFORMS[k]);
      chip.onclick = function () { switchStreamProvider(k); };
      pf.appendChild(chip);
    });
    pfBar.appendChild(pf);
    c.appendChild(pfBar);

    // 搜索输入行（仅搜索页签）
    if (S.stTab === 'search') {
      var inpRow = el('div', 'am-st-inputrow');
      var inp = document.createElement('input');
      inp.className = 'am-st-input'; inp.placeholder = '搜索歌曲、艺人、专辑…（洛雪全平台音源）'; inp.value = S.stKw;
      inp.onkeydown = function (e) { if (e.key === 'Enter') { S.stKw = inp.value.trim(); doStreamSearch(true); } };
      var bGo = el('button', 'am-btn am-btn-accent', '搜索');
      bGo.onclick = function () { S.stKw = inp.value.trim(); doStreamSearch(true); };
      inpRow.appendChild(inp); inpRow.appendChild(bGo);
      c.appendChild(inpRow);
    }

    R.stStatus = el('div', 'am-st-status');
    c.appendChild(R.stStatus);

    if (S.stTab === 'boards') {
      // 榜单 chips（网格流式排列）
      var bdBox = el('div', 'am-st-pfs am-bd-pfs');
      S.boards.forEach(function (b) {
        var chip = el('button', 'am-chip' + (S.boardSel === b.bangid ? ' cur' : ''), b.name);
        chip.onclick = function () { loadBoardList(b.bangid, b.name, 1); };
        bdBox.appendChild(chip);
      });
      c.appendChild(bdBox);
      if (!S.stResults.length) {
        c.appendChild(el('div', 'am-empty', S.boards.length ? '选择一个榜单查看歌曲' : '正在加载榜单…'));
        return;
      }
      renderSongsTable(c);
      if (S.bdPage < S.bdAllPage) renderMoreBtn(c, '加载更多（' + S.bdPage + '/' + S.bdAllPage + '）', function () { loadBoardList(S.boardSel, S.boardName, S.bdPage + 1); });
      return;
    }

    if (S.stTab === 'lists') {
      if (!S.slDetailId) {
        // V3.5.8：收藏的歌单（当前平台，点击直达，✕ 移除）
        var favs = slFavs().filter(function (f) { return f.provider === S.stProvider; });
        if (favs.length) {
          c.appendChild(el('div', 'am-view-h', '收藏的歌单'));
          var fbox = el('div', 'am-st-pfs');
          fbox.style.marginBottom = '14px';
          favs.forEach(function (f) {
            var chip = el('span', 'am-chip');
            chip.appendChild(el('span', '', f.name));
            chip.onclick = function () { loadSongListDetail(f.id, f.name, 1); };
            var x = el('span', 'am-chip-x', '✕');
            x.title = '移除收藏';
            x.onclick = function (e) {
              e.stopPropagation();
              slFavSave(slFavs().filter(function (v) { return !(v.id === f.id && v.provider === f.provider); }));
              renderView();
            };
            chip.appendChild(x);
            fbox.appendChild(chip);
          });
          c.appendChild(fbox);
        }
        // 歌单卡片网格
        if (!S.slLists.length) { c.appendChild(el('div', 'am-empty', '正在加载歌单…')); return; }
        var grid = el('div', 'am-sl-grid');
        S.slLists.forEach(function (pl) {
          var card = el('div', 'am-sl-card');
          var img = el('img', 'am-sl-cover'); img.alt = ''; img.loading = 'lazy';
          if (pl.img) { img.src = pl.img; img.onerror = function () { img.style.visibility = 'hidden'; }; }
          else img.style.visibility = 'hidden';
          card.appendChild(img);
          card.appendChild(el('div', 'am-sl-name', esc(pl.name)));
          card.appendChild(el('div', 'am-sl-meta', (pl.playCount ? pl.playCount + ' 播放' : '') + (pl.total ? ' · ' + pl.total + ' 首' : '')));
          card.onclick = function () { loadSongListDetail(pl.id, pl.name, 1); };
          grid.appendChild(card);
        });
        c.appendChild(grid);
        if (S.slPage * S.slLimit < S.slTotal) renderMoreBtn(c, '加载更多歌单（' + S.slLists.length + '/' + S.slTotal + '）', function () { loadSongLists(S.slPage + 1); });
        return;
      }
      // 歌单详情（返回 + 歌曲表）
      var barD = el('div'); barD.style.cssText = 'display:flex;gap:10px;margin-bottom:10px';
      var back = el('button', 'am-btn', '‹ 返回歌单广场');
      back.onclick = function () { S.slDetailId = ''; S.slDetailName = ''; S.stResults = S.tabSongs.lists = []; renderView(); };
      barD.appendChild(back);
      // V3.5.8：收藏歌单（★ 已收藏 / ☆ 未收藏）
      var bFav = el('button', 'am-btn', slIsFav(S.slDetailId) ? '★ 已收藏' : '☆ 收藏歌单');
      bFav.onclick = function () {
        var a = slFavs();
        var fi = a.findIndex(function (f) { return f.id === S.slDetailId && f.provider === S.stProvider; });
        if (fi >= 0) a.splice(fi, 1);
        else a.unshift({ id: S.slDetailId, name: S.slDetailName, provider: S.stProvider, at: Date.now() });
        slFavSave(a);
        bFav.textContent = slIsFav(S.slDetailId) ? '★ 已收藏' : '☆ 收藏歌单';
      };
      barD.appendChild(bFav);
      c.appendChild(barD);
      c.appendChild(el('div', 'am-view-h', esc(S.slDetailName)));
      if (!S.stResults.length) { c.appendChild(el('div', 'am-empty', '正在加载歌单歌曲…')); return; }
      renderSongsTable(c);
      if (S.slDPage * S.slDLimit < S.slDTotal) renderMoreBtn(c, '加载更多（已加载 ' + S.stResults.length + '/' + S.slDTotal + '）', function () { loadSongListDetail(S.slDetailId, S.slDetailName, S.slDPage + 1); });
      return;
    }

    // 搜索页签
    if (!S.stResults.length) {
      c.appendChild(el('div', 'am-empty', S.stKw ? '无结果' : '输入关键词，从五大平台搜索在线音乐'));
      return;
    }
    renderSongsTable(c);
    if (S.stPage < S.stAllPage && !S.stSearching) {
      renderMoreBtn(c, '加载更多（' + S.stPage + '/' + S.stAllPage + '）', function () { doStreamSearch(false); });
    }
  }

  /* "添加到播放列表"菜单 */
  function openAddMenu(x, y, trackPath) {
    var pop = R.pop;
    pop.innerHTML = '';
    pop.appendChild(el('div', 'am-pop-item', '添加到播放列表')).style.fontWeight = '600';
    pop.appendChild(el('div', 'am-pop-sep'));
    var mte = el('button', 'am-pop-item', '✏️ 编辑标签…');
    mte.onclick = function () {
      pop.classList.remove('on');
      if (window.annieTagEdit) window.annieTagEdit.open({ path: trackPath });
    };
    pop.appendChild(mte);
    var mch = el('button', 'am-pop-item', '🔎 在线匹配歌词 / 封面…');
    mch.onclick = function () {
      pop.classList.remove('on');
      if (window.annieMatch) window.annieMatch.open({ path: trackPath });
    };
    pop.appendChild(mch);
    pop.appendChild(el('div', 'am-pop-sep'));
    S.playlists.forEach(function (pl) {
      var it = el('button', 'am-pop-item', pl.name);
      it.onclick = function () {
        pop.classList.remove('on');
        window.mine.playlistAdd(pl.id, [trackPath]).then(function (pls) {
          S.playlists = pls;
          if (S.view === 'pl:' + pl.id) renderView();
        });
      };
      pop.appendChild(it);
    });
    if (S.playlists.length) pop.appendChild(el('div', 'am-pop-sep'));
    var nw = el('button', 'am-pop-item', '＋ 新建播放列表…');
    nw.onclick = function () {
      pop.classList.remove('on');
      var name = prompt('播放列表名称：', '新建播放列表');
      if (name == null) return;
      window.mine.playlistCreate(name).then(function (pls) {
        S.playlists = pls;
        return window.mine.playlistAdd(pls[pls.length - 1].id, [trackPath]);
      }).then(function (pls) { S.playlists = pls; renderSidebar(); });
    };
    pop.appendChild(nw);
    pop.classList.add('on');
    var w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - h - 12) + 'px';
  }

  /* ---------------- 歌词（AM 风格逐行） ---------------- */
  /* 逐字歌词：词标签解析（<mm:ss.xxx>绝对 / <相对ms,时长ms>lxlyric）+ 双层渲染 + 进度
   * 与 fb2k/stage-adapter 同款逻辑；无词标签时完全回退行级高亮 */
  function karaParseMark(raw, lineStart) {
    var s = String(raw || '').trim();
    var mm = /^(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)$/.exec(s);
    if (mm) return { t: (parseInt(mm[1], 10) || 0) * 60 + parseFloat(mm[2] || '0'), d: 0 };
    var rel = /^(\d+),(\d+)$/.exec(s);
    if (rel) return { t: (Number(lineStart) || 0) + (parseInt(rel[1], 10) || 0) / 1000, d: (parseInt(rel[2], 10) || 0) / 1000 };
    return null;
  }
  function karaExtractWords(rawText, lineStart) {
    var s = String(rawText || '');
    if (s.indexOf('<') < 0) return null;
    var re = /<([^<>]+)>/g, m, marks = [];
    while ((m = re.exec(s))) marks.push({ raw: m[1], index: m.index, end: re.lastIndex });
    if (!marks.length) return null;
    var words = [], fullText = '';
    for (var i = 0; i < marks.length; i++) {
      var seg = s.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].index : s.length);
      if (!seg) continue;
      var tk = karaParseMark(marks[i].raw, lineStart);
      if (tk == null) { fullText += seg; continue; }
      var c0 = fullText.length;
      fullText += seg;
      words.push({ text: seg, t: tk.t, d: tk.d, c0: c0, c1: fullText.length });
    }
    if (!words.length) return null;
    for (var k = 0; k < words.length; k++) {
      if (words[k].d > 0) continue;
      var nxt = words[k + 1];
      words[k].d = nxt ? Math.max(0.06, nxt.t - words[k].t) : 0.6;
    }
    return { text: fullText, words: words };
  }
  /* 逐词 span 卡拉OK：每词独立双层（底暗/顶高亮按词内进度裁切），词间自然折行，
   * 长行不再缩字号而是换行显示；每 tick 只刷当前行（~词数个 style 写入） */
  function paintKaraLine(node, now) {
    var arr = node._karaWords;
    for (var i = 0; i < arr.length; i++) {
      var w = arr[i].w;
      var ws = w.t, we = w.t + Math.max(0.08, w.d || 0.24);
      var p;
      if (now >= we) p = 1;
      else if (now <= ws) p = 0;
      else p = (now - ws) / (we - ws);
      arr[i].hi.style.width = (p * 100).toFixed(1) + '%';
    }
  }
  function resetKaraLine(node) {
    var arr = node._karaWords;
    for (var i = 0; i < arr.length; i++) arr[i].hi.style.width = '0%';
  }
  /* 逐字歌词总开关（设置中心·歌词页，LS annieplayer.karaoke，默认开） */
  function karaOn() { try { return localStorage.getItem('annieplayer.karaoke') !== '0'; } catch (e) { return true; } }
  /* 构建一行歌词元素（逐字时每词一个 span 可折行），主歌词/沉浸/迷你共用 */
  function buildLyrLineEl(l, i, cls) {
    var d = el('div', cls + ' far');
    if (l.words && l.words.length && l.text && karaOn()) {
      d.classList.add('kara');
      var limit = S.lyrWordLimit | 0; // 每行词数限制（0=按容器宽度自然折行）
      var wspans = [];
      l.words.forEach(function (w, wi) {
        if (limit > 0 && wi > 0 && wi % limit === 0) d.appendChild(document.createElement('br'));
        var ws = el('span', 'kara-w');
        var base = el('span', 'kara-wb'); base.textContent = w.text;
        var hi = el('span', 'kara-wh'); hi.textContent = w.text;
        ws.appendChild(base); ws.appendChild(hi);
        d.appendChild(ws);
        wspans.push({ w: w, hi: hi });
      });
      d._karaWords = wspans;
    } else {
      d.appendChild(document.createTextNode(l.text));
    }
    if (l.tly) d.appendChild(el('span', 'tly', l.tly));
    d.onclick = function () { seek(l.t); };
    d._idx = i;
    d._kt = l.text || ''; // 自适应行宽测量用
    return d;
  }
  /* 更新容器内当前行逐词进度（每 tick 调用；行切换时重置上一行） */
  function paintKara(container, cur, now) {
    if (!container) return;
    if (container._karaCur !== cur) {
      var old = container._karaCur;
      if (old != null && old >= 0) {
        var on = container.children[old];
        if (on && on._karaWords) resetKaraLine(on);
      }
      container._karaCur = cur;
    }
    if (cur < 0) return;
    var node = container.children[cur];
    if (node && node._karaWords) paintKaraLine(node, now);
  }
  function parseLrc(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      // lxlyric 行格式：[起始ms,时长ms]文本（行内 <相对ms,时长ms> 词标签走同一提取）
      var lx = /^\s*\[(\d+),(\d+)\](.*)$/.exec(line);
      if (lx) {
        var lt = (parseInt(lx[1], 10) || 0) / 1000;
        var lraw = (lx[3] || '').trim();
        var lex = karaExtractWords(lraw, lt);
        out.push({ t: lt, text: lex ? lex.text : lraw, words: lex ? lex.words : null });
        return;
      }
      var m = line.match(/((\[\d+:\d+(\.\d+)?\])+)(.*)/);
      if (!m) return;
      var raw = m[4].trim();
      var re = /\[(\d+):(\d+)(\.\d+)?\]/g, t, firstT = null, times = [];
      while ((t = re.exec(m[1]))) {
        var tt = (+t[1]) * 60 + (+t[2]) + (t[3] ? +t[3] : 0);
        if (firstT == null) firstT = tt;
        times.push(tt);
      }
      // 逐字：提取 <词时间> 标签，text 清洗为纯文本
      var ex = karaExtractWords(raw, firstT);
      var txt = ex ? ex.text : raw;
      var words = ex ? ex.words : null;
      times.forEach(function (tt) {
        out.push({ t: tt, text: txt, words: words ? words.slice() : null });
      });
    });
    // 翻译行合并：同一时间戳的后续行作为 tly
    out.sort(function (a, b) { return a.t - b.t; });
    var merged = [];
    out.forEach(function (l) {
      var prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.t - l.t) < 0.4 && prev.text && l.text) prev.tly = l.text;
      else if (l.text) merged.push({ t: l.t, text: l.text, tly: '', words: l.words || null });
    });
    return merged;
  }
  function loadLyrics(path, isStream) {
    if (S.lyrPath === path) return;
    S.lyrPath = path; S.lyrLines = []; S.lyrCur = -1;
    R.lyrScroll.innerHTML = '';
    if (!path) { renderLyrics(); return; }
    // 流媒体曲目：path 是真实播放 URL；歌词由 AM/streaming.js 取到后注入 __annieStreamLrcByPath 并广播 annie-stream-lyric
    if (isStream) {
      var cached = window.__annieStreamLrcByPath && window.__annieStreamLrcByPath[path];
      if (cached) { S.lyrLines = parseLrc(cached); }
      renderLyrics();
      return;
    }
    window.mine.lyrics(path).then(function (r) {
      if (S.lyrPath !== path) return;
      S.lyrLines = (r && r.ok && r.text) ? parseLrc(r.text) : [];
      renderLyrics();
    }).catch(function () { renderLyrics(); });
  }
  function renderLyrics() {
    // 沉浸/迷你里打开的歌词容器同步刷新
    if (R.imm && S.imm && S.immLyrOn) buildLyrInto(R.immLyrBox);
    if (R.mini && S.mini && S.miniLyrOn) buildLyrInto(R.miniLyr);
    var box = R.lyrScroll;
    box.innerHTML = '';
    if (!S.lyrLines.length) {
      var emptyText = !state.currentPath ? '播放歌曲以显示歌词'
        : (state.currentStream ? '歌词加载中…' : '暂无歌词');
      box.appendChild(el('div', 'am-lyr-empty', emptyText));
      return;
    }
    S.lyrLines.forEach(function (l, i) {
      box.appendChild(buildLyrLineEl(l, i, 'am-lyr-line'));
    });
    fitLyrLines(box);
    tickLyrics();
  }
  function tickLyrics() {
    if (!S.lyrLines.length || !R.lyrScroll) return;
    var cur = -1;
    for (var i = 0; i < S.lyrLines.length; i++) {
      if (S.lyrLines[i].t <= S.pos + 0.15) cur = i; else break;
    }
    // 逐字扫过：每 tick 更新当前行（不吃下方 line-change 早退）
    paintKara(R.lyrScroll, cur, S.pos);
    // 沉浸/迷你歌词容器同样每 tick 平滑扫过（否则只在行切换时跳变）
    if (R.imm && S.imm && S.immLyrOn) paintKara(R.immLyrBox, cur, S.pos);
    if (R.mini && S.mini && S.miniLyrOn) paintKara(R.miniLyr, cur, S.pos);
    if (cur === S.lyrCur) return;
    S.lyrCur = cur;
    var nodes = R.lyrScroll.children;
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      if (n._idx == null) continue;
      var dist = Math.abs(n._idx - cur);
      n.classList.toggle('cur', n._idx === cur);
      n.classList.toggle('near', dist === 1);
      n.classList.toggle('far', dist > 1);
    }
    if (cur >= 0 && nodes[cur]) {
      R.lyrScroll.scrollTop = nodes[cur].offsetTop - R.lyrScroll.clientHeight * 0.42;
    }
    // 沉浸/迷你歌词容器跟随同一 S.lyrCur
    if (R.imm && S.imm && S.immLyrOn) paintLyrBox(R.immLyrBox, cur, 0.35);
    if (R.mini && S.mini && S.miniLyrOn) paintLyrBox(R.miniLyr, cur, 0.40);
  }

  /* 定位当前播放文件：当前视图找不到时切回歌曲全库，滚动到播放行并闪烁高亮 */
  function locatePlaying() {
    var p = state.currentPath;
    if (!p || state.currentStream) return; // 流媒体不入库，无法定位
    var inView = currentTracks().some(function (t) { return t.path === p; });
    if (!inView) {
      S.view = 'songs'; S.albumKey = null; S.folderKey = null; S.search = '';
      renderSidebar();
    }
    renderView();
    setTimeout(function () {
      if (!R.content) return;
      var sel = '.am-tr[data-path="' + CSS.escape(p) + '"]';
      var row = R.content.querySelector(sel);
      if (!row && S._tbl) {
        // 窗口化渲染：目标行不在 DOM，按索引算 scrollTop 滚过去再重建可视区
        var win = S._tbl, idx = -1;
        for (var k = 0; k < win.tracks.length; k++) if (win.tracks[k].path === p) { idx = k; break; }
        if (idx < 0) return;
        var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
        var base = win.tb.getBoundingClientRect().top - R.content.getBoundingClientRect().top + R.content.scrollTop + headH;
        R.content.scrollTop = Math.max(0, base + idx * win.rowH - (R.content.clientHeight - win.rowH) / 2);
        renderAmWindow();
        row = R.content.querySelector(sel);
      } else if (row) {
        // 非窗口化：手动滚容器——不能用 scrollIntoView，它会连 #am-root（fixed 壳）一起滚，把顶栏顶出视口
        var cRect = R.content.getBoundingClientRect();
        var rRect = row.getBoundingClientRect();
        var target = R.content.scrollTop + (rRect.top - cRect.top) - (cRect.height - rRect.height) / 2;
        if (R.content.scrollTo) R.content.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
        else R.content.scrollTop = Math.max(0, target);
      }
      if (!row) return;
      var root = document.getElementById('am-root');
      if (root && root.scrollTop) root.scrollTop = 0; // 防御：壳容器永不允许滚动
      row.classList.remove('locate-flash');
      void row.offsetWidth; // 重启动画
      row.classList.add('locate-flash');
      setTimeout(function () { row.classList.remove('locate-flash'); }, 2000);
    }, 60);
  }

  /* ================= 歌词外观：自适应行宽 + 字号/行距自定义 + 滚动条自动隐藏 ================= */
  var _fitCanvas = null;
  function fitCtx() {
    if (!_fitCanvas) _fitCanvas = document.createElement('canvas');
    return _fitCanvas.getContext('2d');
  }
  /* 逐行自适应：行文本宽于容器则按比例缩字号（最低 55%），卡拉OK行整体缩放不影响扫过比例 */
  function fitLyrLines(box) {
    if (!box || !box.clientWidth) return;
    var avail = box.clientWidth - 30;
    var nodes = box.children;
    var ctx = fitCtx();
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n._idx == null || !n._kt) continue;
      if (!n._fs0 || n._fsv !== S.lyrFsV) { // 字号设置变化后重取基准
        var cs = getComputedStyle(n);
        n._fs0 = parseFloat(cs.fontSize) || 15;
        n._fw = cs.fontWeight || '400';
        n._ff = cs.fontFamily || 'sans-serif';
        n._fsv = S.lyrFsV;
      }
      ctx.font = n._fw + ' ' + n._fs0 + 'px ' + n._ff;
      var w = ctx.measureText(n._kt).width;
      // 仅兜底不可折行的超长词（无空白）；其余行一律自然折行，不再缩字号
      if (w > avail && !/\s/.test(n._kt)) n.style.fontSize = Math.max(n._fs0 * 0.55, Math.floor(n._fs0 * avail / w * 10) / 10) + 'px';
      else n.style.fontSize = '';
    }
  }
  function refitAllLyr() {
    fitLyrLines(R.lyrScroll);
    if (R.imm && S.imm && S.immLyrOn) fitLyrLines(R.immLyrBox);
    if (R.mini && S.mini && S.miniLyrOn) fitLyrLines(R.miniLyr);
  }
  /* 滚动条仅滚动时出现（停滚 800ms 后隐藏） */
  function autoHideScrollbar(box) {
    if (!box) return;
    var t = 0;
    box.addEventListener('scroll', function () {
      box.classList.add('scrolling');
      clearTimeout(t);
      t = setTimeout(function () { box.classList.remove('scrolling'); }, 800);
    }, { passive: true });
  }
  /* 字号/行距/每行词数自定义（localStorage 持久化，CSS 变量驱动，三处歌词容器同效） */
  function applyLyrStyle() {
    var sc = 1, lh = 1.45, wl = 0;
    try {
      sc = Math.min(1.6, Math.max(0.7, parseFloat(localStorage.getItem('annieplayer.am.lyrscale')) || 1));
      lh = Math.min(2.2, Math.max(1.2, parseFloat(localStorage.getItem('annieplayer.am.lyrlh')) || 1.45));
      wl = Math.min(20, Math.max(0, parseInt(localStorage.getItem('annieplayer.am.lyrwordlimit'), 10) || 0));
    } catch (e) { }
    S.lyrFsV = (S.lyrFsV || 0) + 1; // 递增使各行字号缓存失效
    S.lyrScale = sc; S.lyrLh = lh; S.lyrWordLimit = wl;
    var root = document.getElementById('am-root');
    if (root) {
      root.style.setProperty('--am-lyr-scale', sc);
      root.style.setProperty('--am-lyr-lh', lh);
    }
    refitAllLyr();
  }
  /* 结构级变更（每行词数）后重建三处歌词容器 */
  function rerenderAllLyr() {
    renderLyrics();
    if (R.imm && S.imm && S.immLyrOn) buildLyrInto(R.immLyrBox);
    if (R.mini && S.mini && S.miniLyrOn) buildLyrInto(R.miniLyr);
  }
  function toggleLyrSetPop() {
    if (!R.lyrSetPop) buildLyrSetPop();
    var pop = R.lyrSetPop;
    if (pop.classList.contains('on')) { pop.classList.remove('on'); return; }
    var r = R.btnLyrSet.getBoundingClientRect();
    pop.style.left = Math.max(8, r.right - 250) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
    pop.classList.add('on');
  }
  function buildLyrSetPop() {
    var pop = el('div', 'am-pop am-lyrset-pop');
    pop.appendChild(el('div', 'am-pop-h', '歌词外观'));
    var row1 = el('div', 'am-pop-row');
    row1.appendChild(el('span', null, '字号'));
    var sl1 = document.createElement('input');
    sl1.type = 'range'; sl1.min = 70; sl1.max = 160; sl1.step = 5;
    sl1.value = Math.round((S.lyrScale || 1) * 100);
    sl1.className = 'am-lyrset-slider';
    var v1 = el('span', 'am-lyrset-v', sl1.value + '%');
    sl1.oninput = function () {
      v1.textContent = sl1.value + '%';
      try { localStorage.setItem('annieplayer.am.lyrscale', String(sl1.value / 100)); } catch (e) { }
      applyLyrStyle();
    };
    row1.appendChild(sl1); row1.appendChild(v1);
    pop.appendChild(row1);
    var row2 = el('div', 'am-pop-row');
    row2.appendChild(el('span', null, '行距'));
    var sl2 = document.createElement('input');
    sl2.type = 'range'; sl2.min = 120; sl2.max = 220; sl2.step = 5;
    sl2.value = Math.round((S.lyrLh || 1.45) * 100);
    sl2.className = 'am-lyrset-slider';
    var v2 = el('span', 'am-lyrset-v', (sl2.value / 100).toFixed(2));
    sl2.oninput = function () {
      v2.textContent = (sl2.value / 100).toFixed(2);
      try { localStorage.setItem('annieplayer.am.lyrlh', String(sl2.value / 100)); } catch (e) { }
      applyLyrStyle();
    };
    row2.appendChild(sl2); row2.appendChild(v2);
    pop.appendChild(row2);
    // 每行词数（卡拉OK行生效；0=按容器宽度自然折行）
    var row3 = el('div', 'am-pop-row');
    row3.appendChild(el('span', null, '每行词数'));
    var sl3 = document.createElement('input');
    sl3.type = 'range'; sl3.min = 0; sl3.max = 12; sl3.step = 1;
    sl3.value = S.lyrWordLimit || 0;
    sl3.className = 'am-lyrset-slider';
    var v3 = el('span', 'am-lyrset-v', (S.lyrWordLimit || 0) === 0 ? '自动' : String(S.lyrWordLimit));
    sl3.oninput = function () {
      var n = +sl3.value;
      v3.textContent = n === 0 ? '自动' : String(n);
      try { localStorage.setItem('annieplayer.am.lyrwordlimit', String(n)); } catch (e) { }
      S.lyrWordLimit = n;
      rerenderAllLyr();
    };
    row3.appendChild(sl3); row3.appendChild(v3);
    pop.appendChild(row3);
    pop.appendChild(el('div', 'am-pop-hint', '超长行自动折行显示（不再缩小字号）；每行词数仅对逐字歌词生效，中文按字计'));
    document.getElementById('am-root').appendChild(pop);
    R.lyrSetPop = pop;
  }

  /* ================= 播放模式 / 播放定时（仅本地播放生效） ================= */
  function syncModeBtn() {
    if (!R.btnMode || !window.anniePlayMode) return;
    var inf = window.anniePlayMode.info();
    R.btnMode.textContent = inf.icon;
    R.btnMode.title = '播放模式：' + inf.label + (inf.hint ? '\n' + inf.hint : '') + '\n（仅本地播放生效，点击切换）';
  }
  function syncTimerBtn() {
    if (!R.btnTimer) return;
    var t = window.annieSleepTimer && window.annieSleepTimer.get();
    R.btnTimer.classList.toggle('on', !!t);
    R.btnTimer.title = '播放定时' + (t ? '\n当前：' + window.annieSleepTimer.describe() : '');
  }
  function toggleTimerPop() {
    var pop = R.timerPop;
    if (pop.classList.contains('on')) { pop.classList.remove('on'); return; }
    renderTimerPop();
    var r = R.btnTimer.getBoundingClientRect();
    pop.style.left = Math.max(8, r.right - 280) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
    pop.classList.add('on');
  }
  function renderTimerPop() {
    var pop = R.timerPop;
    pop.innerHTML = '';
    pop.appendChild(el('div', 'am-pop-h', '播放定时'));
    pop.appendChild(el('div', 'am-pop-hint', '仅对本地播放生效（在线播放不接管）'));
    var ST = window.annieSleepTimer;
    if (!ST) return;
    var cur = ST.get();
    if (cur) {
      var row0 = el('div', 'am-pop-row');
      row0.appendChild(el('span', 'am-pop-cur', '当前：' + ST.describe()));
      var bOff = el('button', 'am-mini-btn', '关闭');
      bOff.onclick = function () { ST.clear(); toggleTimerPop(); };
      row0.appendChild(bOff);
      pop.appendChild(row0);
    }
    var b1 = el('button', 'am-pop-item', '▤ 播完当前列表即停止');
    b1.onclick = function () {
      ST.set({ type: 'queue' });
      toggleTimerPop();
      try { if (typeof proToast === 'function') proToast('将在当前列表播完后停止'); } catch (e) { }
    };
    pop.appendChild(b1);
    // 定时 N 分钟停止
    var row2 = el('div', 'am-pop-row');
    row2.appendChild(el('span', null, '⏱'));
    var minIn = document.createElement('input');
    minIn.type = 'number'; minIn.min = 1; minIn.max = 720; minIn.value = 30; minIn.className = 'am-pop-num';
    row2.appendChild(minIn);
    row2.appendChild(el('span', null, '分钟后停止'));
    var b2 = el('button', 'am-mini-btn', '设定');
    b2.onclick = function () {
      var mins = Math.max(1, Math.min(720, +minIn.value || 0));
      ST.set({ type: 'time', at: Date.now() + mins * 60000 });
      toggleTimerPop();
      try { if (typeof proToast === 'function') proToast(mins + ' 分钟后停止播放'); } catch (e) { }
    };
    row2.appendChild(b2);
    pop.appendChild(row2);
    // 单曲循环 N 遍后停止（生效期间覆盖播放模式）
    var row3 = el('div', 'am-pop-row');
    row3.appendChild(el('span', null, '🔂'));
    var nIn = document.createElement('input');
    nIn.type = 'number'; nIn.min = 1; nIn.max = 99; nIn.value = 3; nIn.className = 'am-pop-num';
    row3.appendChild(nIn);
    row3.appendChild(el('span', null, '遍后停止当前歌曲'));
    var b3 = el('button', 'am-mini-btn', '设定');
    b3.onclick = function () {
      if (state.currentStream) { try { if (typeof proToast === 'function') proToast('仅本地播放生效'); } catch (e) { } return; }
      var n = Math.max(1, Math.min(99, +nIn.value || 0));
      ST.set({ type: 'repeatN', total: n, played: 0 });
      toggleTimerPop();
      try { if (typeof proToast === 'function') proToast('当前歌曲循环 ' + n + ' 遍后停止'); } catch (e) { }
    };
    row3.appendChild(b3);
    pop.appendChild(row3);
    pop.appendChild(el('div', 'am-pop-hint', '提示：循环 N 遍生效期间会覆盖顶栏的播放模式'));
  }

  /* ================= 歌词行：沉浸/迷你共享渲染 ================= */
  function buildLyrInto(box) {
    box.innerHTML = '';
    if (!S.lyrLines.length) {
      box.appendChild(el('div', 'am-lyr-empty', !state.currentPath ? '播放歌曲以显示歌词' : (state.currentStream ? '歌词加载中…' : '暂无歌词')));
      return;
    }
    S.lyrLines.forEach(function (l, i) {
      box.appendChild(buildLyrLineEl(l, i, 'am-lyr-line'));
    });
    fitLyrLines(box);
    paintLyrBox(box, S.lyrCur, 0.35);
  }
  function paintLyrBox(box, cur, rate) {
    if (!box) return;
    var nodes = box.children;
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      if (n._idx == null) continue;
      var dist = Math.abs(n._idx - cur);
      n.classList.toggle('cur', n._idx === cur);
      n.classList.toggle('near', dist === 1);
      n.classList.toggle('far', dist > 1);
    }
    paintKara(box, cur, S.pos);
    if (cur >= 0 && nodes[cur]) box.scrollTop = nodes[cur].offsetTop - box.clientHeight * rate;
  }

  /* ================= 待播清单 / 历史记录（沉浸与迷你共享） ================= */
  function renderQueuePanel(box) {
    box.innerHTML = '';
    var tabs = el('div', 'am-q-tabs');
    var tQ = el('button', 'am-q-tab' + (S.qTab !== 'hist' ? ' cur' : ''), '待播清单');
    var tH = el('button', 'am-q-tab' + (S.qTab === 'hist' ? ' cur' : ''), '历史记录');
    tQ.onclick = function () { S.qTab = 'queue'; renderQueuePanel(box); };
    tH.onclick = function () { S.qTab = 'hist'; renderQueuePanel(box); };
    tabs.appendChild(tQ); tabs.appendChild(tH);
    box.appendChild(tabs);
    var list = el('div', 'am-q-list');
    box.appendChild(list);

    function addRow(coverUrl, track, title, sub, durText, cur, onclick) {
      var row = el('div', 'am-q-row' + (cur ? ' cur' : ''));
      var img = document.createElement('img');
      img.className = 'am-q-cover'; img.alt = ''; img.draggable = false;
      if (coverUrl) img.src = coverUrl;
      else if (track) albumCover(track, function (u) { if (u) img.src = u; });
      row.appendChild(img);
      var tx = el('div', 'am-q-tx');
      tx.appendChild(el('div', 'am-q-title', title));
      tx.appendChild(el('div', 'am-q-sub', sub));
      row.appendChild(tx);
      row.appendChild(el('div', 'am-q-dur', durText || ''));
      row.onclick = onclick;
      list.appendChild(row);
    }

    if (S.qTab !== 'hist') {
      // 待播清单：流媒体用搜索结果队列，本地用 state.queue（从当前索引起）
      if (state.currentStream) {
        var rs = S.stResults || [];
        if (!rs.length) { list.appendChild(el('div', 'am-q-empty', '（无待播曲目）')); return; }
        rs.forEach(function (song, i) {
          addRow(song.cover || '', null, song.title || song.name || '', song.artist || '',
            song.duration ? fmtTime(song.duration) : '', i === S.stIndex,
            function () { playStreamAt(i); });
        });
        return;
      }
      var q = state.queue || [];
      if (!q.length) { list.appendChild(el('div', 'am-q-empty', '（无待播曲目）')); return; }
      for (var i = Math.max(0, state.index); i < q.length; i++) {
        (function (t, idx) {
          var m = trackMeta(t);
          var dm = S.meta[t.path];
          addRow(null, t, m.title, m.artist + (m.album ? ' — ' + m.album : ''),
            dm && dm.duration ? fmtTime(dm.duration) : '', idx === state.index,
            function () { playAt(idx); });
        })(q[i], i);
      }
      return;
    }
    // 历史记录：播放统计 lastPlayed 倒序（仅本地有统计）
    var stats = (state.library && state.library.stats) || {};
    var all = allTracks();
    var byPath = {};
    all.forEach(function (t) { byPath[t.path] = t; });
    var items = Object.keys(stats).filter(function (p) { return stats[p] && stats[p].lastPlayed && byPath[p]; })
      .sort(function (a, b) { return stats[b].lastPlayed - stats[a].lastPlayed; })
      .slice(0, 50);
    if (!items.length) { list.appendChild(el('div', 'am-q-empty', '（暂无播放记录）')); return; }
    items.forEach(function (p) {
      var t = byPath[p];
      var m = trackMeta(t);
      addRow(null, t, m.title, m.artist + (m.album ? ' — ' + m.album : ''), '',
        state.currentPath === p,
        function () { var ai = all.indexOf(t); playList(all, ai >= 0 ? ai : 0); });
    });
  }

  /* ================= 沉浸式播放界面 ================= */
  function buildImmersive() {
    if (R.imm) return;
    var root = document.getElementById('am-root');
    var ov = el('div', 'am-imm');
    ov.appendChild(el('div', 'am-imm-bg'));
    var cb = el('div', 'am-imm-closebar');
    var bExit = el('button', 'am-tbtn', '⤡');
    bExit.title = '退出沉浸模式';
    bExit.onclick = function () { toggleImmersive(false); };
    cb.appendChild(bExit);
    ov.appendChild(cb);

    var main = el('div', 'am-imm-main');
    var left = el('div', 'am-imm-left');
    R.immCover = document.createElement('img');
    R.immCover.className = 'am-imm-cover'; R.immCover.alt = ''; R.immCover.draggable = false;
    R.immTitle = el('div', 'am-imm-title');
    R.immSub = el('div', 'am-imm-sub');
    R.immFmt = el('div', 'am-imm-fmt');
    left.appendChild(R.immCover); left.appendChild(R.immTitle);
    left.appendChild(R.immSub); left.appendChild(R.immFmt);

    var prog = el('div', 'am-imm-prog');
    R.immCur = el('span', 'am-imm-time', '0:00');
    var bar = el('div', 'am-imm-bar');
    R.immFill = el('div', 'am-imm-fill');
    bar.appendChild(R.immFill);
    bar.onclick = function (e) {
      var r = bar.getBoundingClientRect();
      if (S.dur > 0) seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.dur);
    };
    R.immRemain = el('span', 'am-imm-time', '-0:00');
    prog.appendChild(R.immCur); prog.appendChild(bar); prog.appendChild(R.immRemain);
    left.appendChild(prog);

    var ctl = el('div', 'am-imm-ctl');
    var vol = el('span', 'am-imm-vol');
    vol.appendChild(el('span', null, '🔊'));
    R.immVol = document.createElement('input');
    R.immVol.type = 'range'; R.immVol.min = 0; R.immVol.max = 100; R.immVol.className = 'am-imm-volin';
    R.immVol.oninput = function () { if (R.vol) { R.vol.value = R.immVol.value; R.vol.oninput(); } };
    vol.appendChild(R.immVol);
    ctl.appendChild(vol);
    var bP = el('button', 'am-imm-btn', '⏮'); bP.onclick = prev;
    R.immPlay = el('button', 'am-imm-btn am-imm-play', '▶'); R.immPlay.onclick = togglePlay;
    var bN = el('button', 'am-imm-btn', '⏭'); bN.onclick = next;
    ctl.appendChild(bP); ctl.appendChild(R.immPlay); ctl.appendChild(bN);
    R.immBtnLyr = el('button', 'am-imm-btn', '💬'); R.immBtnLyr.title = '歌词（再点收起）';
    R.immBtnLyr.onclick = function () { setImmLyr(!S.immLyrOn); };
    R.immBtnQ = el('button', 'am-imm-btn', '☰'); R.immBtnQ.title = '待播清单 / 历史记录';
    R.immBtnQ.onclick = function () { setImmQueue(!S.immQOn); };
    ctl.appendChild(R.immBtnLyr); ctl.appendChild(R.immBtnQ);
    left.appendChild(ctl);

    main.appendChild(left);
    R.immLyrBox = el('div', 'am-imm-lyr');
    autoHideScrollbar(R.immLyrBox);
    main.appendChild(R.immLyrBox);
    ov.appendChild(main);
    R.immQ = el('div', 'am-imm-queue');
    ov.appendChild(R.immQ);
    root.appendChild(ov);
    R.imm = ov;
  }
  function toggleImmersive(force) {
    var want = force !== undefined ? force : !S.imm;
    if (want === !!S.imm) return;
    if (want && S.mini) { exitMini(); } // 沉浸与迷你互斥
    buildImmersive();
    S.imm = want;
    var root = document.getElementById('am-root');
    root.classList.toggle('am-imm-on', want);
    root.classList.toggle('am-imm-lyr-on', want && !!S.immLyrOn);
    root.classList.toggle('am-imm-q-on', want && !!S.immQOn);
    if (want) {
      syncAuxViews(); refreshAuxProgress();
      if (S.immLyrOn) buildLyrInto(R.immLyrBox);
      if (S.immQOn) renderQueuePanel(R.immQ);
    }
  }
  function setImmLyr(on) {
    S.immLyrOn = on;
    document.getElementById('am-root').classList.toggle('am-imm-lyr-on', on && S.imm);
    R.immBtnLyr.classList.toggle('on', on);
    if (on && S.imm) buildLyrInto(R.immLyrBox);
  }
  function setImmQueue(on) {
    S.immQOn = on;
    document.getElementById('am-root').classList.toggle('am-imm-q-on', on && S.imm);
    R.immBtnQ.classList.toggle('on', on);
    if (on && S.imm) renderQueuePanel(R.immQ);
  }

  /* ================= 迷你模式（AM 风格，窗口形态切换） ================= */
  var MINI_BOUNDS_LS = 'annieplayer.pro.mini.bounds'; // 与粒子舞台迷你模式共享位置记忆
  function buildMini(root) {
    var m = el('div', 'am-mini');
    var head = el('div', 'am-mini-head');
    R.miniCover = document.createElement('img');
    R.miniCover.className = 'am-mini-cover'; R.miniCover.alt = ''; R.miniCover.draggable = false;
    head.appendChild(R.miniCover);
    var info = el('div', 'am-mini-info');
    R.miniTitle = el('div', 'am-mini-title', '—');
    R.miniSub = el('div', 'am-mini-sub', '');
    R.miniFmt = el('div', 'am-mini-fmt', '');
    info.appendChild(R.miniTitle); info.appendChild(R.miniSub); info.appendChild(R.miniFmt);
    head.appendChild(info);
    var wb = el('div', 'am-mini-winbtns');
    var bMin = el('button', 'am-tbtn', '—'); bMin.title = '最小化'; bMin.onclick = function () { window.mine.winMin(); };
    var bExit = el('button', 'am-tbtn', '⤢'); bExit.title = '退出迷你模式'; bExit.onclick = function () { exitMini(); };
    var bClose = el('button', 'am-tbtn am-close', '✕'); bClose.title = '关闭'; bClose.onclick = function () { window.mine.winClose(); };
    wb.appendChild(bMin); wb.appendChild(bExit); wb.appendChild(bClose);
    head.appendChild(wb);
    m.appendChild(head);

    var prog = el('div', 'am-mini-prog');
    R.miniCur = el('span', 'am-mini-time', '0:00');
    var bar = el('div', 'am-mini-bar');
    R.miniFill = el('div', 'am-mini-fill');
    bar.appendChild(R.miniFill);
    bar.onclick = function (e) {
      var r = bar.getBoundingClientRect();
      if (S.dur > 0) seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.dur);
    };
    R.miniRemain = el('span', 'am-mini-time', '-0:00');
    prog.appendChild(R.miniCur); prog.appendChild(bar); prog.appendChild(R.miniRemain);
    m.appendChild(prog);

    var ctl = el('div', 'am-mini-ctl');
    var vol = el('span', 'am-mini-vol');
    vol.appendChild(el('span', null, '🔊'));
    R.miniVol = document.createElement('input');
    R.miniVol.type = 'range'; R.miniVol.min = 0; R.miniVol.max = 100; R.miniVol.className = 'am-mini-volin';
    R.miniVol.oninput = function () { if (R.vol) { R.vol.value = R.miniVol.value; R.vol.oninput(); } };
    vol.appendChild(R.miniVol);
    ctl.appendChild(vol);
    var mid = el('span', 'am-mini-mid');
    var bP = el('button', 'am-tbtn', '⏮'); bP.onclick = prev;
    R.miniPlay = el('button', 'am-tbtn am-mini-play', '▶'); R.miniPlay.onclick = togglePlay;
    var bN = el('button', 'am-tbtn', '⏭'); bN.onclick = next;
    mid.appendChild(bP); mid.appendChild(R.miniPlay); mid.appendChild(bN);
    ctl.appendChild(mid);
    var rig = el('span', 'am-mini-right');
    R.miniBtnLyr = el('button', 'am-tbtn', '💬'); R.miniBtnLyr.title = '歌词（再点收起）';
    R.miniBtnLyr.onclick = function () { setMiniLyr(!S.miniLyrOn); };
    R.miniBtnQ = el('button', 'am-tbtn', '☰'); R.miniBtnQ.title = '待播清单 / 历史记录';
    R.miniBtnQ.onclick = function () { setMiniQueue(!S.miniQOn); };
    rig.appendChild(R.miniBtnLyr); rig.appendChild(R.miniBtnQ);
    ctl.appendChild(rig);
    m.appendChild(ctl);

    R.miniLyr = el('div', 'am-mini-lyr');
    autoHideScrollbar(R.miniLyr);
    m.appendChild(R.miniLyr);
    R.miniQ = el('div', 'am-mini-queue');
    m.appendChild(R.miniQ);
    root.appendChild(m);
    R.mini = m;
  }
  function enterMini() {
    if (S.mini) return;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(MINI_BOUNDS_LS) || 'null'); } catch (e) { }
    window.mine.miniEnter(saved).then(function (r) {
      if (!r || !r.ok) return;
      if (S.imm) toggleImmersive(false); // 互斥
      S.mini = true;
      S.miniLyrOn = false; S.miniQOn = false;
      var root = document.getElementById('am-root');
      root.classList.add('am-mini-on');
      root.classList.remove('am-mini-lyr-on', 'am-mini-q-on');
      R.miniBtnLyr.classList.remove('on'); R.miniBtnQ.classList.remove('on');
      syncAuxViews(); refreshAuxProgress();
      miniResize(); // 首启/共享位置记忆尺寸不一：强制校准为迷你基准尺寸（360×170）
    }).catch(function () { });
  }
  function exitMini() {
    if (!S.mini) return;
    window.mine.miniExit().then(function (r) {
      if (r && r.miniBounds) { try { localStorage.setItem(MINI_BOUNDS_LS, JSON.stringify(r.miniBounds)); } catch (e) { } }
    }).catch(function () { });
    S.mini = false;
    S.miniLyrOn = false; S.miniQOn = false;
    document.getElementById('am-root').classList.remove('am-mini-on', 'am-mini-lyr-on', 'am-mini-q-on');
  }
  function miniResize() {
    var h = (S.miniLyrOn || S.miniQOn) ? 560 : 170;
    window.mine.miniSetSize(360, h).catch(function () { });
  }
  function setMiniLyr(on) {
    S.miniLyrOn = on;
    if (on) S.miniQOn = false;
    var root = document.getElementById('am-root');
    root.classList.toggle('am-mini-lyr-on', on);
    root.classList.toggle('am-mini-q-on', S.miniQOn);
    R.miniBtnLyr.classList.toggle('on', on);
    R.miniBtnQ.classList.toggle('on', S.miniQOn);
    if (on) buildLyrInto(R.miniLyr);
    miniResize();
  }
  function setMiniQueue(on) {
    S.miniQOn = on;
    if (on) S.miniLyrOn = false;
    var root = document.getElementById('am-root');
    root.classList.toggle('am-mini-q-on', on);
    root.classList.toggle('am-mini-lyr-on', S.miniLyrOn);
    R.miniBtnQ.classList.toggle('on', on);
    R.miniBtnLyr.classList.toggle('on', S.miniLyrOn);
    if (on) renderQueuePanel(R.miniQ);
    miniResize();
  }

  /* 沉浸/迷你界面字段同步（封面/标题/参数 与 进度/播放键） */
  function syncAuxViews() {
    var cover = R.npCover && R.npCover.getAttribute('src');
    if (R.imm) {
      if (cover) R.immCover.src = cover; else R.immCover.removeAttribute('src');
      R.immTitle.textContent = R.npTitle.textContent;
      R.immSub.textContent = R.npSub.textContent;
      R.immFmt.textContent = S.fmt || '';
      if (R.vol) R.immVol.value = R.vol.value;
    }
    if (R.mini) {
      if (cover) R.miniCover.src = cover; else R.miniCover.removeAttribute('src');
      R.miniTitle.textContent = R.npTitle.textContent;
      R.miniSub.textContent = R.npSub.textContent;
      R.miniFmt.textContent = S.fmt || '';
      if (R.vol) R.miniVol.value = R.vol.value;
    }
  }
  function refreshAuxProgress() {
    var pct = S.dur > 0 ? Math.min(1, S.pos / S.dur) : 0;
    var cur = fmtTime(S.pos);
    var rem = S.dur > 0 ? '-' + fmtTime(Math.max(0, S.dur - S.pos)) : '-0:00';
    var playIcon = state.playing ? '⏸' : '▶';
    if (R.imm && S.imm) {
      R.immCur.textContent = cur; R.immRemain.textContent = rem;
      R.immFill.style.width = (pct * 100) + '%';
      R.immPlay.textContent = playIcon;
    }
    if (R.mini && S.mini) {
      R.miniCur.textContent = cur; R.miniRemain.textContent = rem;
      R.miniFill.style.width = (pct * 100) + '%';
      R.miniPlay.textContent = playIcon;
    }
  }

  /* ---------------- 播放状态刷新 ---------------- */
  function refreshBadge() {
    if (!R.npBadge) return;
    R.npBadge.textContent = S.fmt;
    R.npBadge.style.display = S.fmt ? '' : 'none';
  }
  function refreshTimes() {
    if (!R.npCur) return;
    R.npCur.textContent = fmtTime(S.pos);
    R.npRemain.textContent = S.dur > 0 ? fmtRemain(S.dur - S.pos) : '0:00';
    if (R.npProgFill && S.dur > 0) R.npProgFill.style.width = (Math.min(1, S.pos / S.dur) * 100) + '%';
    refreshAuxProgress();
  }
  function refreshNowPlaying() {
    if (!R.npTitle) return;
    var p = state.currentPath;
    if (!p) {
      R.npTitle.textContent = '未在播放';
      R.npSub.textContent = '';
      R.npCover.removeAttribute('src');
      S.fmt = ''; refreshBadge();
      document.getElementById('am-root').classList.add('am-nobg');
      return;
    }
    var t = allTracks().find(function (x) { return x.path === p; });
    var title = p, artist = '', album = '', streamCover = '';
    if (state.currentStream) {
      title = state.currentStream.title || p;
      artist = state.currentStream.artist || '';
      album = state.currentStream.album || '';
      streamCover = state.currentStream.cover || '';
    } else if (state.currentCue && state.currentCue.title) { title = state.currentCue.title; artist = state.currentCue.artist || ''; }
    else if (t) { var m = trackMeta(t); title = m.title; artist = m.artist; album = m.album; }
    R.npTitle.textContent = title;
    R.npSub.textContent = artist + (album ? ' — ' + album : '');
    var root = document.getElementById('am-root');
    if (streamCover) {
      // 流媒体：封面是 URL，直接用（不经 meta 解析）
      R.npCover.src = streamCover;
      root.style.setProperty('--am-bgimage', 'url("' + streamCover + '")');
      root.classList.remove('am-nobg');
      syncAuxViews();
    } else {
      var srcPath = (state.currentCue && state.currentCue.src) ||
                    (state.currentIso && state.currentIso.src) || (t && t.path);
      if (srcPath) (t ? albumCover : ensureCover).call(null, t || srcPath, function (url) {
        if (state.currentPath !== p) return;
        if (url) { R.npCover.src = url; }
        if (url) { root.style.setProperty('--am-bgimage', 'url("' + url + '")'); root.classList.remove('am-nobg'); }
        else root.classList.add('am-nobg');
        syncAuxViews();
      });
    }
    syncAuxViews();
    loadLyrics(state.currentStream ? state.currentPath : ((state.currentCue && state.currentCue.src) || (t && t.path) || null), !!state.currentStream);
  }
  function refreshTransport() {
    if (!R.btnPlay) return;
    S.playing = !!state.playing;
    R.btnPlay.textContent = S.playing ? '⏸' : '▶';
    refreshAuxProgress();
  }
  function refresh() {
    refreshNowPlaying();
    refreshTransport();
    restoreScrollAround();
  }
  /* renderView 重建内容但保持滚动位置，并主动对齐窗口化可视区（不等 scroll 事件，时序不可靠） */
  function restoreScrollAround() {
    var sc = R.content ? R.content.scrollTop : 0;
    renderView();
    if (!R.content) return;
    void R.content.scrollHeight; // 强制布局，避免恢复值被旧高度钳制
    R.content.scrollTop = sc;
    if (S._tbl) { S._tbl.lastStart = -1; renderAmWindow(); }
  }

  /* ---------------- 引擎事件 ---------------- */
  function bindGlobal() {
    // 流媒体歌词到达（streaming.js 广播）：命中当前曲目则重载歌词面板
    document.addEventListener('annie-stream-lyric', function (e) {
      if (!state.currentStream || !e.detail || e.detail.path !== state.currentPath) return;
      S.lyrPath = null; // 解除 loadLyrics 的同路径短路
      loadLyrics(state.currentPath, true);
    });
    window.mine.onEngineEvent(function (event, data) {
      if (event === 'position' && data) {
        S.pos = Math.max(0, (data.seconds || 0) - (state.currentCue ? state.currentCue.start : 0));
        S.dur = state.currentCue ? (state.currentCue.end - state.currentCue.start)
          : (data.duration || (state.currentStream && state.duration) || 0);
        refreshTimes();
        tickLyrics();
      } else if (event === 'state') {
        refreshTransport();
      } else if (event === 'format' && data && !state.currentStream) {
        // 音质徽标：本地播放显示 编码 · 位深/采样率（流式音质由 playStreamAt 直接设置）
        var parts = [];
        if (data.codec) parts.push(String(data.codec).toUpperCase());
        if (data.bitDepth) parts.push(data.bitDepth + 'bit');
        if (data.requestedRate) parts.push((data.requestedRate / 1000) + 'kHz');
        S.fmt = parts.join(' · ');
        refreshBadge();
      }
    });
    // state.currentPath 变化（playAt 触发后无专用事件）——轮询兜底 + 主题切换时刷新
    var lastPath = null;
    setInterval(function () {
      if (!window.annieTheme || annieTheme.current !== 'am' || !S.mounted) return;
      if (state.currentPath !== lastPath) { lastPath = state.currentPath; refresh(); }
      refreshTransport();
    }, 500);
  }

  /* 媒体库根目录缓存（文件夹视图分组依赖）；曲库扫描完成后节流浪新 */
  var libFoldersAt = 0;
  function refreshLibFolders(force) {
    var now = Date.now();
    if (!force && now - libFoldersAt < 10000) return;
    libFoldersAt = now;
    window.mine.getLibrary().then(function (lib) {
      if (lib && Array.isArray(lib.folders)) S.libFolders = lib.folders;
    }).catch(function () { });
  }

  /* ---------------- 挂载 / 对外 ---------------- */
  function mount() {
    if (!S.mounted) {
      build();
      bindGlobal();
      patchStreamPlayNext();
      S.mounted = true;
    }
    refreshPlaylists();
    refreshLibFolders(true);
    refresh();
    document.getElementById('am-root').classList.toggle('am-light', isLight());
  }

  // 曲库变化时同步（与 fb2k.js 同模式：包装 player.js 的全局渲染函数）
  function wrapGlobal(name) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__amWrapped) return;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      if (S.mounted && window.annieTheme && annieTheme.current === 'am') {
        refreshLibFolders(false); renderSidebar();
        // playAt 也会触发这里（player.js 更新高亮）——保持滚动位置，否则切歌跳回顶端
        restoreScrollAround();
      }
      return r;
    };
    wrapped.__amWrapped = true;
    window[name] = wrapped;
  }
  wrapGlobal('renderCurrentView');
  wrapGlobal('renderFolderTree');

  // 窗口尺寸变化：歌词行重新自适应（防抖 250ms）
  var _lyrRsT = 0;
  window.addEventListener('resize', function () {
    clearTimeout(_lyrRsT);
    _lyrRsT = setTimeout(refitAllLyr, 250);
  });
  document.addEventListener('annie-theme-changed', function (e) {
    if (e.detail && e.detail.theme === 'am' && S.mounted) { patchStreamPlayNext(); refresh(); }
    // 切离 AM：迷你窗先还原（避免小窗里装别的主题），沉浸层收起
    else if (e.detail && e.detail.theme !== 'am') { if (S.mini) exitMini(); if (S.imm) toggleImmersive(false); }
  });
  // 在线匹配落盘后：清封面缓存（新 cover.jpg 生效）；若正在播放该文件则重载歌词与顶栏
  document.addEventListener('annie-local-media-updated', function (e) {
    var p = e.detail && e.detail.path;
    if (!p || !S.mounted) return;
    var t = null;
    allTracks().forEach(function (x) { if (x.path === p) t = x; });
    if (t) {
      delete S.acover[albumKeyOf(t)];
      delete S.cover[srcFileOf(t)];
      delete S.cover[p];
    }
    if (state.currentPath === p) {
      loadLyrics(p, false);
      if (R.npTitle) R.npTitle.textContent = ''; // 绕过 refreshNowPlaying 同路径早退守卫
      refreshNowPlaying();
    }
    if (S.view === 'albums') renderView(); // 专辑网格封面刷新
  });

  window.annieAM = { mount: mount, refresh: refresh };
  // 设置中心·歌词页联动：AM 字号/行距重应用、每行词数/逐字开关变更后重建歌词
  window.amLyrStyle = applyLyrStyle;
  window.amLyrRerender = rerenderAllLyr;
  document.addEventListener('annie-karaoke-changed', function () { if (S.mounted) rerenderAllLyr(); });

  // 启动即是 am 主题时自挂载（theme.js 先于本文件执行 apply()）
  if (window.annieTheme && annieTheme.current === 'am') mount();
})();
