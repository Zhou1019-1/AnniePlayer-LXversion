'use strict';
/* ===== am.js 拆分片：am-dom.js =====
 * 界面构建与本地视图：build() 主 DOM、侧栏、内容区（专辑网格/文件夹/歌单头/曲目表窗口化）、添加菜单、定位播放
 * 来源：am.js 原稿行 388-871 + 1248-1295 + 1499-1540（原样切片，零行为变更）
 * 共享变量经 window.__annieAMInternal 桥接；前向引用为转发桩，运行时解析。 */
(function () {
  var AM = window.__annieAMInternal || (window.__annieAMInternal = {}); // AM 主题内部模块桥（跨分片共享闭包变量）
  // 从桥取用先加载分片导出的引用（此时前片已执行完，引用有效）
  var S = AM.S;
  var R = AM.R;
  var LIGHT_KEY = AM.LIGHT_KEY;
  var el = AM.el;
  var esc = AM.esc;
  var isLight = AM.isLight;
  var allTracks = AM.allTracks;
  var trackMeta = AM.trackMeta;
  var ensureMeta = AM.ensureMeta;
  var ensureMetaDeep = AM.ensureMetaDeep;
  var albumCover = AM.albumCover;
  var folderGroups = AM.folderGroups;
  var currentTracks = AM.currentTracks;
  var playList = AM.playList;
  var togglePlay = AM.togglePlay;
  var next = AM.next;
  var prev = AM.prev;
  var seek = AM.seek;
  var renderStreamView = AM.renderStreamView;
  var applyLyrStyle = AM.applyLyrStyle;
  var toggleLyrSetPop = AM.toggleLyrSetPop;
  // 前向引用：目标函数由后加载分片注册到桥，调用时才取值（加载期取不到）
  function syncModeBtn() { return AM.syncModeBtn.apply(this, arguments); }
  function syncTimerBtn() { return AM.syncTimerBtn.apply(this, arguments); }
  function toggleTimerPop() { return AM.toggleTimerPop.apply(this, arguments); }
  function toggleImmersive() { return AM.toggleImmersive.apply(this, arguments); }
  function enterMini() { return AM.enterMini.apply(this, arguments); }
  function buildMini() { return AM.buildMini.apply(this, arguments); }

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
    // V3.5.17：实时频谱可视化条（引擎 32 频段 10Hz 推送，贴底细条，迷你/沉浸下隐藏）
    R.vizBar = document.createElement('canvas'); R.vizBar.className = 'am-vizbar';
    R.vizBar.style.pointerEvents = 'auto'; R.vizBar.style.cursor = 'pointer';
    R.vizBar.title = '点击进入氛围模式（全屏频谱）';
    R.vizBar.onclick = function () { if (window.annieAmbient) annieAmbient.open(); };
    root.appendChild(R.vizBar);
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


  /* 注册到模块桥（供其他分片取用） */
  AM.build = build;
  AM.renderSidebar = renderSidebar;
  AM.renderView = renderView;
  AM.renderAmWindow = renderAmWindow;
})();
