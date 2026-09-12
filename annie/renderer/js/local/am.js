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
    // 洛雪在线搜索
    stProvider: 'kg', stKw: '', stPage: 0, stAllPage: 1, stResults: [], stIndex: -1,
    stSearching: false, stQuality: 'flac'
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
      if (window.annieTheme && annieTheme.current === 'am') renderView();
    }).catch(function () { });
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
        if (S.search && window.annieTheme && annieTheme.current === 'am') renderView();
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
  function playList(list, i) { state.queue = list; playAt(i); }
  function togglePlay() {
    if (!state.currentPath && allTracks().length) { playList(allTracks(), 0); return; }
    window.mine.engine(state.playing ? 'pause' : 'resume').catch(function () { });
  }
  function next() {
    if (state.currentStream) { nextStream(); return; }
    if (state.queue.length) playAt((state.index + 1) % state.queue.length);
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
          if (ok === false) renderStreamStatus(song.name + '：播放失败，引擎未接受流地址', true);
        });
      }
      if (!song.cover && window.mine.streamGetPic) {
        window.mine.streamGetPic({ provider: song.provider, song: song }).then(function (p) {
          if (p && p.url) { song.cover = p.url; if (S.stResults.indexOf(song) >= 0 && S.view === 'stream') renderView(); }
        }).catch(function () { });
      }
    }).catch(function (e) { renderStreamStatus('获取播放地址失败：' + (e.message || e), true); });
  }
  function nextStream() { if (S.stIndex < S.stResults.length - 1) playStreamAt(S.stIndex + 1); }
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
    var lyr = el('aside', 'am-lyrics');
    R.lyrScroll = el('div', 'am-lyr-scroll');
    lyr.appendChild(R.lyrScroll);
    body.appendChild(R.sidebar); body.appendChild(R.content); body.appendChild(lyr);

    /* 添加到播放列表弹出菜单 */
    R.pop = el('div', 'am-pop');

    root.appendChild(top); root.appendChild(body); root.appendChild(R.pop);
    document.addEventListener('click', function (e) {
      if (R.pop.classList.contains('on') && !R.pop.contains(e.target)) R.pop.classList.remove('on');
    });

    renderSidebar();
    renderView();
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
    sb.appendChild(nav('🔍', '在线搜索', 'stream'));
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
      renderView();
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
     超 2000 行的巨型列表不渲染封面列以保流畅 */
  function renderTrackTable(c, tracks) {
    var tb = el('table', 'am-table');
    var inPlaylist = S.view.indexOf('pl:') === 0;
    var plId = inPlaylist ? S.view.slice(3) : null;
    var withCover = tracks.length <= 2000;
    tb.innerHTML = '<thead><tr>' + (withCover ? '<th style="width:46px"></th>' : '') +
      '<th>歌曲</th><th>艺人</th><th>专辑</th><th style="width:96px"></th></tr></thead>';
    var body = el('tbody');
    tracks.forEach(function (t, i) {
      var m = trackMeta(t);
      var tr = el('tr', 'am-tr' + (state.currentPath === t.path ? ' cur' : ''));
      tr.dataset.path = t.path; // 定位播放文件用
      if (withCover) {
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
      if (inPlaylist) {
        var bRm = el('button', 'am-mini-btn', '✕');
        bRm.title = '从播放列表移除';
        bRm.onclick = function (e) {
          e.stopPropagation();
          window.mine.playlistRemove(plId, t.path).then(function (pls) { S.playlists = pls; renderSidebar(); renderView(); });
        };
        acts.appendChild(bRm);
      }
      tr.appendChild(acts);
      tr.ondblclick = function () { playList(tracks, i); };
      body.appendChild(tr);
    });
    tb.appendChild(body);
    c.appendChild(tb);
  }

  /* ---------------- 在线搜索视图（洛雪 musicSdk，AM 外观） ---------------- */
  function renderStreamView(c) {
    c.appendChild(el('div', 'am-view-h', '在线搜索'));

    var bar = el('div', 'am-st-bar');
    var pf = el('div', 'am-st-pfs');
    Object.keys(PLATFORMS).forEach(function (k) {
      var chip = el('button', 'am-chip' + (S.stProvider === k ? ' cur' : ''), PLATFORMS[k]);
      chip.onclick = function () {
        S.stProvider = k;
        pf.querySelectorAll('.am-chip').forEach(function (x) { x.classList.toggle('cur', x === chip); });
        if (S.stKw) doStreamSearch(true);
      };
      pf.appendChild(chip);
    });
    bar.appendChild(pf);
    var qSel = document.createElement('select');
    qSel.className = 'am-st-quality';
    [['flac24bit', 'Hi-Res'], ['flac', 'FLAC'], ['320k', '320K'], ['128k', '128K']].forEach(function (q) {
      var o = document.createElement('option'); o.value = q[0]; o.textContent = q[1]; qSel.appendChild(o);
    });
    qSel.value = S.stQuality;
    qSel.onchange = function () { S.stQuality = qSel.value; };
    bar.appendChild(qSel);
    c.appendChild(bar);

    var inpRow = el('div', 'am-st-inputrow');
    var inp = document.createElement('input');
    inp.className = 'am-st-input'; inp.placeholder = '搜索歌曲、艺人、专辑…（洛雪全平台音源）'; inp.value = S.stKw;
    inp.onkeydown = function (e) { if (e.key === 'Enter') { S.stKw = inp.value.trim(); doStreamSearch(true); } };
    var bGo = el('button', 'am-btn am-btn-accent', '搜索');
    bGo.onclick = function () { S.stKw = inp.value.trim(); doStreamSearch(true); };
    inpRow.appendChild(inp); inpRow.appendChild(bGo);
    c.appendChild(inpRow);

    R.stStatus = el('div', 'am-st-status');
    c.appendChild(R.stStatus);

    if (!S.stResults.length) {
      c.appendChild(el('div', 'am-empty', S.stKw ? '无结果' : '输入关键词，从五大平台搜索在线音乐'));
      return;
    }

    var tb = el('table', 'am-table');
    tb.innerHTML = '<thead><tr><th style="width:46px"></th><th>歌曲</th><th>艺人</th><th>专辑</th><th style="width:56px;text-align:right">时长</th><th style="width:110px">音质</th></tr></thead>';
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
      // 单击即播（与洛雪流媒体面板一致；用户习惯来自那里，双击保留兼容）
      tr.onclick = function () { playStreamAt(i); };
      tr.ondblclick = function () { playStreamAt(i); };
      body.appendChild(tr);
    });
    tb.appendChild(body);
    c.appendChild(tb);

    if (S.stPage < S.stAllPage && !S.stSearching) {
      var more = el('button', 'am-btn', '加载更多（' + S.stPage + '/' + S.stAllPage + '）');
      more.style.marginTop = '14px';
      more.onclick = function () { doStreamSearch(false); };
      c.appendChild(more);
    }
  }

  /* "添加到播放列表"菜单 */
  function openAddMenu(x, y, trackPath) {
    var pop = R.pop;
    pop.innerHTML = '';
    pop.appendChild(el('div', 'am-pop-item', '添加到播放列表')).style.fontWeight = '600';
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
  function parseLrc(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var m = line.match(/((\[\d+:\d+(\.\d+)?\])+)(.*)/);
      if (!m) return;
      var txt = m[4].trim();
      var re = /\[(\d+):(\d+)(\.\d+)?\]/g, t;
      while ((t = re.exec(m[1]))) {
        out.push({ t: (+t[1]) * 60 + (+t[2]) + (t[3] ? +t[3] : 0), text: txt });
      }
    });
    // 翻译行合并：同一时间戳的后续行作为 tly
    out.sort(function (a, b) { return a.t - b.t; });
    var merged = [];
    out.forEach(function (l) {
      var prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.t - l.t) < 0.4 && prev.text && l.text) prev.tly = l.text;
      else if (l.text) merged.push({ t: l.t, text: l.text, tly: '' });
    });
    return merged;
  }
  function loadLyrics(path) {
    if (S.lyrPath === path) return;
    S.lyrPath = path; S.lyrLines = []; S.lyrCur = -1;
    R.lyrScroll.innerHTML = '';
    if (!path) { renderLyrics(); return; }
    window.mine.lyrics(path).then(function (r) {
      if (S.lyrPath !== path) return;
      S.lyrLines = (r && r.ok && r.text) ? parseLrc(r.text) : [];
      renderLyrics();
    }).catch(function () { renderLyrics(); });
  }
  function renderLyrics() {
    var box = R.lyrScroll;
    box.innerHTML = '';
    if (!S.lyrLines.length) {
      box.appendChild(el('div', 'am-lyr-empty', state.currentPath ? '暂无歌词' : '播放歌曲以显示歌词'));
      return;
    }
    S.lyrLines.forEach(function (l, i) {
      var d = el('div', 'am-lyr-line far');
      d.appendChild(document.createTextNode(l.text));
      if (l.tly) d.appendChild(el('span', 'tly', l.tly));
      d.onclick = function () { seek(l.t); };
      d._idx = i;
      box.appendChild(d);
    });
    tickLyrics();
  }
  function tickLyrics() {
    if (!S.lyrLines.length || !R.lyrScroll) return;
    var cur = -1;
    for (var i = 0; i < S.lyrLines.length; i++) {
      if (S.lyrLines[i].t <= S.pos + 0.15) cur = i; else break;
    }
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
      var row = R.content.querySelector('.am-tr[data-path="' + CSS.escape(p) + '"]');
      if (!row) return;
      // 手动滚容器：不能用 scrollIntoView——它会连 #am-root（fixed 壳）一起滚，把顶栏顶出视口
      var cRect = R.content.getBoundingClientRect();
      var rRect = row.getBoundingClientRect();
      var target = R.content.scrollTop + (rRect.top - cRect.top) - (cRect.height - rRect.height) / 2;
      if (R.content.scrollTo) R.content.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      else R.content.scrollTop = Math.max(0, target);
      var root = document.getElementById('am-root');
      if (root && root.scrollTop) root.scrollTop = 0; // 防御：壳容器永不允许滚动
      row.classList.remove('locate-flash');
      void row.offsetWidth; // 重启动画
      row.classList.add('locate-flash');
      setTimeout(function () { row.classList.remove('locate-flash'); }, 2000);
    }, 60);
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
    } else {
      var srcPath = (state.currentCue && state.currentCue.src) ||
                    (state.currentIso && state.currentIso.src) || (t && t.path);
      if (srcPath) (t ? albumCover : ensureCover).call(null, t || srcPath, function (url) {
        if (state.currentPath !== p) return;
        if (url) { R.npCover.src = url; }
        if (url) { root.style.setProperty('--am-bgimage', 'url("' + url + '")'); root.classList.remove('am-nobg'); }
        else root.classList.add('am-nobg');
      });
    }
    loadLyrics(state.currentStream ? null : ((state.currentCue && state.currentCue.src) || (t && t.path) || null));
  }
  function refreshTransport() {
    if (!R.btnPlay) return;
    S.playing = !!state.playing;
    R.btnPlay.textContent = S.playing ? '⏸' : '▶';
  }
  function refresh() {
    refreshNowPlaying();
    refreshTransport();
    var sc = R.content ? R.content.scrollTop : 0;
    renderView();
    if (R.content) R.content.scrollTop = sc;
  }

  /* ---------------- 引擎事件 ---------------- */
  function bindGlobal() {
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
      if (S.mounted && window.annieTheme && annieTheme.current === 'am') { refreshLibFolders(false); renderSidebar(); renderView(); }
      return r;
    };
    wrapped.__amWrapped = true;
    window[name] = wrapped;
  }
  wrapGlobal('renderCurrentView');
  wrapGlobal('renderFolderTree');

  document.addEventListener('annie-theme-changed', function (e) {
    if (e.detail && e.detail.theme === 'am' && S.mounted) { patchStreamPlayNext(); refresh(); }
  });

  window.annieAM = { mount: mount, refresh: refresh };

  // 启动即是 am 主题时自挂载（theme.js 先于本文件执行 apply()）
  if (window.annieTheme && annieTheme.current === 'am') mount();
})();
