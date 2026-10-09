'use strict';
/* ================= 仿 foobar2000 主题（主题 B） =================
 * 与粒子舞台主题共享同一 PlayerCore（state / playAt / 引擎事件），仅做界面层替换。
 * 挂载/卸载由 theme.js 驱动；所有偏好存 localStorage（annieplayer.fb2k.*）。 */
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  };

  /* ---------------- 状态 ---------------- */
  var S = {
    mounted: false,
    activeList: 'default',            // default | fav | pl:<id> | folder:<path>
    playlists: [], // V4.4：初始为空，由 initPlaylists() 从主进程 library.json 读取（含 localStorage 旧数据一次性迁移）
    filter: '',
    ratings: LS.get('annieplayer.ratings', {}),
    rows: [], tracks: [],
    sel: new Set(), anchor: -1,
    pos: 0, dur: 0, playing: false, format: null, lastPath: null,
    metaCache: new Map(),
    rowH: 32,
    leftW: LS.get('annieplayer.fb2k.leftW', 220),
    rightW: LS.get('annieplayer.fb2k.rightW', 300),
    rightCollapsed: LS.get('annieplayer.fb2k.rightCollapsed', false),
    viewMode: LS.get('annieplayer.fb2k.viewMode', 'list'), // list | split | cover
    specOn: LS.get('annieplayer.fb2k.specOn', true),
    detailCollapsed: LS.get('annieplayer.fb2k.detailCollapsed', false), // 右侧详细信息收起（保留封面/参数/歌词/频谱）
    sortKey: null, sortAsc: true,
    colW: LS.get('annieplayer.fb2k.colW', {}), // V4.4 第三层：用户拖过的列宽覆盖（k → px，仅固定宽列）
    lyrPath: null, lyrLines: null, lyrCur: -1,
    specFrames: null, specGen: -1, specSmooth: null,
    hiddenPaths: new Set(), // 会话级"从列表移除"
    treeExpanded: new Set(), // EXP 7.28：文件夹树展开状态（会话级）
    dark: LS.get('annieplayer.fb2k.dark', false), // V1.1.2：FB2K 暗色模式（持久化）
    // V4.4：在线歌单（流媒体）——主进程 streamPlaylists 的渲染层镜像，与 AM 同一份
    spl: [], splVer: 0,
    stQuality: LS.get('annieplayer.fb2k.stQuality', 'flac'), // 流媒体音质偏好（与 AM 默认一致）
    streamQueue: null, streamIdx: -1 // FB2K 发起的流媒体播放队列快照 + 当前索引
  };

  /* V4.4：流媒体平台标签 + 虚拟曲目适配。
   * 在线歌单 items 契约：{provider, song, addedAt}；song 为洛雪原始曲目对象
   * {name, artist, album, cover, duration(ms), provider, songmid/hash/id/rid}。
   * 虚拟曲目借用本地列表管线（选中/排序/虚拟滚动全按 path 键控），
   * path 用稳定伪路径 stream://provider/id，__stream 挂原始 song。 */
  var PLAT_LABEL = { kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐', tx: 'QQ 音乐', wy: '网易云音乐' };
  function songKeyOf(s) {
    s = s || {};
    return (s.provider || '') + '|' + String(s.songmid || s.hash || s.id || s.rid || ((s.name || '') + '|' + (s.artist || '')));
  }
  function splTrack(it, idx) {
    var song = (it && it.song) ? it.song : (it || {});
    var provider = (it && it.provider) || song.provider || '';
    return {
      __stream: song, __splIdx: idx,
      path: 'stream://' + provider + '/' + String(song.songmid || song.hash || song.id || song.rid || ((song.name || '') + '|' + (song.artist || ''))),
      name: song.name || '未知曲目',
      dir: '☁ ' + (PLAT_LABEL[provider] || provider || '在线'),
      mtime: 0
    };
  }
  /* 当前播放的流媒体是否就是这首（state.currentPath 是真实 URL，与伪路径不等，需按歌曲身份比对） */
  function isCurStream(song) {
    var cs = state.currentStream;
    if (!cs) return false;
    return songKeyOf(cs.song || cs) === songKeyOf(song);
  }
  /* http 封面经主进程代理转 dataURL 再显示（CSP img-src 拦截直链），与 player.js 同一策略 */
  function setStreamCover(img, url) {
    if (!url) { img.src = PLACEHOLDER; return; }
    if (/^https?:\/\//i.test(url) && window.mine.streamCoverProxy) {
      window.mine.streamCoverProxy(url).then(function (r) { if (r && r.url) img.src = r.url; }).catch(function () { });
    } else img.src = url;
  }
  function stNotify(m) { try { if (typeof proToast === 'function') proToast(m); } catch (e) { } }

  var SVG = {
    play: '<svg viewBox="0 0 16 16"><path d="M4 2l9 6-9 6z"/></svg>',
    pause: '<svg viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>',
    prev: '<svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM13 2L6 8l7 6z"/></svg>',
    next: '<svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM3 2l7 6-7 6z"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><path d="M3 3h10v10H3z"/></svg>',
    vol: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-4v12l-4-4H2zM11 5q2 3 0 6" stroke="currentColor" fill="none" stroke-width="1.4"/></svg>',
    mute: '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-4v12l-4-4H2zM11 5l4 6M15 5l-4 6" stroke="currentColor" stroke-width="1.2"/></svg>',
    list: '<svg viewBox="0 0 16 16"><path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h12v2H2z"/></svg>',
    split: '<svg viewBox="0 0 16 16"><path d="M2 3h5v10H2zM9 3h5v10H9z"/></svg>',
    cover: '<svg viewBox="0 0 16 16"><path d="M2 2h12v12H2z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="3"/></svg>',
    spec: '<svg viewBox="0 0 16 16"><path d="M2 8h2v6H2zM7 4h2v10H7zM12 7h2v7h-2z"/></svg>',
    eq: '<svg viewBox="0 0 16 16"><path d="M3 2v5M3 10v4M8 2v2M8 7v7M13 2v8M13 13v1" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="3" cy="8.5" r="1.6"/><circle cx="8" cy="5.5" r="1.6"/><circle cx="13" cy="11.5" r="1.6"/></svg>',
    gear: '<svg viewBox="0 0 16 16"><path d="M8 5a3 3 0 100 6 3 3 0 000-6zM8 1l1 2 2.2-.5 1 2 2.2.8-.4 2.2 1.5 1.7-1.5 1.7.4 2.2-2.2.8-1 2L9 15l-1-1-2.2.5-1-2-2.2-.8.4-2.2L1.5 8 3 6.3l-.4-2.2 2.2-.8 1-2L8 3z" fill-rule="evenodd"/></svg>',
    folder: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M1 3h5l2 2h7v8H1z" fill="#e8c96a"/></svg>',
    moon: '<svg viewBox="0 0 16 16"><path d="M13.5 9.5A5.5 5.5 0 016.5 2.5 5.5 5.5 0 1013.5 9.5z"/></svg>',
    sun: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
    screen: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 6.5l4 1.5-4 1.5z"/></svg>'
  };
  // foobox 风格占位封面（耳机 + 黑胶半遮罩，SVG data URI）
  var PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#e8e8e8"/>' +
    '<circle cx="100" cy="88" r="46" fill="#d0d0d0"/><circle cx="100" cy="88" r="18" fill="#e8e8e8"/>' +
    '<circle cx="100" cy="88" r="4" fill="#b0b0b0"/>' +
    '<path d="M60 150a40 40 0 0180 0" fill="none" stroke="#999" stroke-width="9" stroke-linecap="round"/>' +
    '<rect x="52" y="140" width="14" height="24" rx="5" fill="#888"/><rect x="134" y="140" width="14" height="24" rx="5" fill="#888"/></svg>');

  function fmtHMS(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(h) + ':' + p(m) + ':' + p(ss);
  }
  function fmtCountdown(s) { // -2:34
    s = Math.max(0, Math.ceil(s || 0));
    return '-' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function fmtSize(b) {
    if (!b) return '-';
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
    return Math.round(b / 1024) + ' KB';
  }
  function fmtDate(ms) {
    if (!ms) return '-';
    var d = new Date(ms), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function channelsText(n) {
    if (n === 1) return '单声道';
    if (n === 2) return '立体声';
    if (n === 6) return '5.1 声道';
    if (n === 8) return '7.1 声道';
    return n ? n + ' 声道' : '-';
  }
  function isLossless(codec) { return /flac|ape|wav|aiff|alac|dts|tta|wv/i.test(codec || ''); }

  /* ---------------- 元数据（带封面，懒加载缓存） ---------------- */
  /* 右栏/标题刷新合并到一次 rAF：同一帧内多个 meta 到达只重建一次右栏 */
  var rightRAF = 0;
  function scheduleRightRefresh() {
    if (rightRAF) return;
    rightRAF = requestAnimationFrame(function () {
      rightRAF = 0;
      if (window.annieTheme.current !== 'fb2k') return;
      updateRight(); updateTitle();
    });
  }

  function getMeta(path) {
    var m = S.metaCache.get(path);
    if (!m) {
      m = { pending: true };
      S.metaCache.set(path, m);
      window.mine.meta(path).then(function (r) {
        Object.assign(m, r); m.pending = false;
        if (window.annieTheme.current === 'fb2k') { refreshVisibleRowMeta(path); scheduleRightRefresh(); }
      }).catch(function () { m.pending = false; });
    }
    return m;
  }

  /* ================= DOM 构建 ================= */
  var R = {}; // 关键元素引用
  function build() {
    var root = $('#fb2k-root');
    root.innerHTML = '';
    root.classList.toggle('f2-dark', S.dark); // V1.1.2：构建即应用暗色（首帧前，无闪烁）

    /* ---------- 标题栏 ---------- */
    var tb = el('div', 'f2-titlebar');
    R.title = el('div', 'f2-title', 'AnniePlayer');
    tb.appendChild(R.title);
    // 主题独立：版本号动态获取，不硬编码（随 package.json 升级）
    if (window.mine && window.mine.appVersion) {
      window.mine.appVersion().then(function (v) {
        if (v && R.title) R.title.textContent = 'AnniePlayer V' + v;
        S.appVer = v;
      }).catch(function () { });
    }
    // V4.4：设置入口统一到标题栏右侧齿轮（对齐 AM/粒子舞台的右上角惯例）；菜单栏「视图→设置中心…」保留
    var bSetTop = el('button', 'f2-tb-gear'); bSetTop.title = '设置中心';
    bSetTop.innerHTML = SVG.gear;
    bSetTop.onclick = function () { window.annieSettings.togglePanel(); };
    tb.appendChild(bSetTop);
    var wb = el('div', 'f2-winbtns');
    // V4.4 第三层：窗口按钮 Unicode 字符「— □ ×」改 SVG（粗细/对齐一致，不再依赖字体渲染）
    var bMin = el('button', ''); bMin.title = '最小化'; bMin.onclick = function () { window.mine.winMin(); };
    bMin.innerHTML = '<svg viewBox="0 0 10 10" width="11" height="11"><path d="M1 5.5h8" stroke="currentColor" stroke-width="1.1"/></svg>';
    var bMax = el('button', ''); bMax.title = '最大化'; bMax.onclick = function () { window.mine.winMax(); };
    bMax.innerHTML = '<svg viewBox="0 0 10 10" width="11" height="11"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
    var bCls = el('button', 'f2-close'); bCls.title = '关闭'; bCls.onclick = function () { window.mine.winClose(); };
    bCls.innerHTML = '<svg viewBox="0 0 10 10" width="11" height="11"><path d="M1.8 1.8l6.4 6.4M8.2 1.8L1.8 8.2" stroke="currentColor" stroke-width="1.1"/></svg>';
    wb.append(bMin, bMax, bCls); tb.appendChild(wb);
    root.appendChild(tb);

    /* ---------- 菜单栏 ---------- */
    root.appendChild(buildMenubar());

    /* ---------- 三栏 ---------- */
    R.main = el('div', 'f2-main');
    R.main.style.setProperty('--f2-left', S.leftW + 'px');
    R.main.style.setProperty('--f2-right', S.rightW + 'px');
    R.main.classList.toggle('right-collapsed', S.rightCollapsed);

    // 左：播放列表树（V4.4：合并双搜索框为单一实时过滤框，输入即过滤当前列表）
    var left = el('div', 'f2-left');
    var filterRow = el('div', 'f2-filter-row');
    R.filterInput = document.createElement('input');
    R.filterInput.placeholder = '🔍 过滤当前列表';
    var ft = null;
    R.filterInput.oninput = function () { clearTimeout(ft); ft = setTimeout(function () { onFilter(R.filterInput.value); }, 150); };
    R.filterBadge = el('span', 'f2-badge dim', '0');
    filterRow.append(R.filterInput, R.filterBadge);
    left.appendChild(filterRow);
    R.tree = el('div', 'f2-tree');
    left.appendChild(R.tree);
    R.main.appendChild(left);
    R.main.appendChild(makeResizer('left'));

    // 中：曲目列表
    var center = el('div', 'f2-center');
    R.cols = el('div', 'f2-cols');
    center.appendChild(R.cols);
    R.list = el('div', 'f2-list');
    R.spacer = el('div');
    R.rows = el('div', 'f2-rows');
    R.list.appendChild(R.spacer);
    R.list.appendChild(R.rows);
    // 滚动事件用 rAF 合并：滚动中每帧最多重绘一次可视行
    var scrollRAF = 0;
    R.list.addEventListener('scroll', function () {
      if (scrollRAF) return;
      scrollRAF = requestAnimationFrame(function () { scrollRAF = 0; renderVisible(); });
    });
    center.appendChild(R.list);
    R.main.appendChild(center);
    R.main.appendChild(makeResizer('right'));

    // 右：封面与信息
    buildRight();
    R.main.appendChild(R.rightWrap);
    root.appendChild(R.main);

    /* ---------- EQ 底部抽屉（EXP 7.28，默认收起） ---------- */
    R.eqDock = el('div', 'f2-eq-dock hidden');
    root.appendChild(R.eqDock);

    /* ---------- 底部控制栏 ---------- */
    root.appendChild(buildBottom());

    bindGlobal();
  }

  function buildMenubar() {
    var bar = el('div', 'f2-menubar');
    var MENUS = [
      ['文件', [
        ['添加音乐文件夹…', '', function () { $('#btn-add-folder').click(); }],
        ['重新扫描媒体库', 'F5', function () { $('#btn-rescan').click(); }],
        ['-', null, null],
        ['设置中心…', 'Ctrl+,', function () { window.annieSettings.togglePanel(); }],
        ['-', null, null],
        ['退出', '', function () { window.mine.winClose(); }]
      ]],
      ['编辑', [
        ['批量编辑标签…', '', function () { var paths = []; forEachSel(function (t) { paths.push(t.path); }); if (paths.length && window.annieTagEdit) window.annieTagEdit.open({ paths: paths }); }],
        ['添加到喜爱 / 取消喜爱', '', function () { forEachSel(function (t) { window.mine.toggleFavorite(t.path).then(function (f) { state.favorites = new Set(f); refreshAll(); }); }); }],
        ['从列表中移除（本次会话）', 'Delete', function () { forEachSel(function (t) { S.hiddenPaths.add(t.path); }); S.sel.clear(); rebuildRows(); }],
        ['清空过滤', '', function () { R.filterInput.value = ''; onFilter(''); }]
      ]],
      ['视图', [
        ['切换到粒子舞台主题', '', function () { window.annieTheme.switch('legacy'); }],
        ['设置中心…', 'Ctrl+,', function () { window.annieSettings.togglePanel(); }],
        ['-', null, null],
        ['列表视图', '', function () { setViewMode('list'); }],
        ['分栏视图', '', function () { setViewMode('split'); }],
        ['封面视图', '', function () { setViewMode('cover'); }],
        ['-', null, null],
        ['收起 / 展开右侧栏', '', toggleRight],
        ['桌面歌词', 'Alt+L', function () { if (window.annieDlyricsToggle) window.annieDlyricsToggle(); }]
      ]],
      ['播放', [
        ['播放 / 暂停', 'Space', transportPlayPause],
        ['上一曲', 'Ctrl+←', transportPrev],
        ['下一曲', 'Ctrl+→', transportNext],
        ['停止', 'Ctrl+S', function () { window.mine.engine('stop').catch(function () { }); }],
        ['-', null, null],
        ['音量 +', 'Ctrl+↑', function () { setVolumeUI(Math.min(1, volGain() + 0.05)); }],
        ['音量 -', 'Ctrl+↓', function () { setVolumeUI(Math.max(0, volGain() - 0.05)); }],
        ['-', null, null],
        // V3.5.6：均衡器快捷入口（打开设置中心播放页，风格与 FB2K 菜单一致）
        ['均衡器…', '', function () { if (window.annieSettings) window.annieSettings.openPage('playback'); }]
      ]],
      ['媒体库', [
        ['默认列表', '', function () { setActiveList('default'); }],
        ['我的喜爱', '', function () { setActiveList('fav'); }],
        ['新建播放列表', '', newPlaylist]
      ]],
      ['帮助', [
        ['关于 AnniePlayer', '', function () {
          var ver = S.appVer ? ('V' + S.appVer) : '';
          modal('关于 AnniePlayer', 'AnniePlayer ' + ver + ' · 仿 foobar2000 主题<br>本地独占音乐播放器（WASAPI Exclusive / ASIO）<br>作者：无敌章鱼哥 · GPL-3.0');
        }]
      ]]
    ];
    MENUS.forEach(function (m) {
      var mi = el('div', 'f2-menu', m[0]);
      var dd = el('div', 'f2-dropdown');
      m[1].forEach(function (it) {
        if (it[0] === '-') { dd.appendChild(el('div', 'f2-sep')); return; }
        var row = el('div', 'f2-mi');
        row.appendChild(el('span', '', it[0]));
        if (it[1]) row.appendChild(el('span', 'f2-sc', it[1]));
        row.onclick = function () { closeMenus(); it[2](); };
        dd.appendChild(row);
      });
      mi.appendChild(dd);
      mi.onclick = function (e) {
        var was = mi.classList.contains('open');
        closeMenus();
        if (!was) mi.classList.add('open');
        e.stopPropagation();
      };
      mi.onmouseenter = function () {
        if (bar.querySelector('.f2-menu.open') && !mi.classList.contains('open')) { closeMenus(); mi.classList.add('open'); }
      };
      bar.appendChild(mi);
    });
    return bar;
  }
  function closeMenus() {
    var q = document.querySelectorAll('.f2-menu.open');
    for (var i = 0; i < q.length; i++) q[i].classList.remove('open');
  }
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest || !e.target.closest('.f2-menu')) closeMenus();
  });

  function buildRight() {
    R.rightWrap = el('div', 'f2-right');
    renderRight();
  }
  function renderRight() {
    var w = R.rightWrap;
    w.innerHTML = '';
    if (S.rightCollapsed) {
      var b = el('button', 'f2-collapse-btn', '» 封面与信息');
      b.title = '展开右侧栏';
      b.onclick = toggleRight;
      w.appendChild(b);
      return;
    }
    var body = el('div', 'f2-right-body');
    var headRow = el('div');
    headRow.style.cssText = 'display:flex;justify-content:flex-end;padding:4px 6px 0;flex:none';
    // 详情收起开关：隐藏长清单，只留封面 + 参数简显 + 歌词 + 频谱
    var db = el('button', '', S.detailCollapsed ? '详情 ▸' : '详情 ▾');
    db.title = S.detailCollapsed ? '展开歌曲详细信息' : '收起歌曲详细信息（保留封面、参数、歌词、频谱）';
    db.style.cssText = 'border:none;background:transparent;color:#999;cursor:pointer;font-size:12px;margin-right:auto';
    db.onclick = toggleDetail;
    headRow.appendChild(db);
    var cb = el('button', '', '«');
    cb.title = '收起右侧栏'; cb.style.cssText = 'border:none;background:transparent;color:#999;cursor:pointer;font-size:12px';
    cb.onclick = toggleRight;
    headRow.appendChild(cb); body.appendChild(headRow);

    var cbox = el('div', 'f2-cover-box');
    R.cover = document.createElement('img');
    R.cover.className = 'f2-cover'; R.cover.src = PLACEHOLDER; R.cover.draggable = false;
    cbox.appendChild(R.cover); body.appendChild(cbox);
    R.songName = el('div', 'f2-songname', ''); body.appendChild(R.songName);
    R.formatLine = el('div', 'f2-formatline', ''); body.appendChild(R.formatLine);
    R.meta = el('div', 'f2-meta');
    R.meta.style.display = S.detailCollapsed ? 'none' : '';
    body.appendChild(R.meta);

    R.lyrBox = el('div', 'f2-lyrics');
    R.lyrBox.appendChild(el('div', 'f2-sec-title', '歌词'));
    R.lyrLines = el('div', 'f2-lyr-lines');
    R.lyrBox.appendChild(R.lyrLines);
    body.appendChild(R.lyrBox);

    R.specBox = el('div', 'f2-spec-box');
    R.specBox.appendChild(el('div', 'f2-sec-title', '频谱'));
    R.spec = document.createElement('canvas');
    R.spec.id = 'f2-spec';
    R.specBox.appendChild(R.spec);
    body.appendChild(R.specBox);

    w.appendChild(body);
  }
  function toggleRight() {
    S.rightCollapsed = !S.rightCollapsed;
    LS.set('annieplayer.fb2k.rightCollapsed', S.rightCollapsed);
    R.main.classList.toggle('right-collapsed', S.rightCollapsed);
    renderRight(); updateRight(); renderLyrics(); updateSpecVisibility();
  }
  function toggleDetail() {
    S.detailCollapsed = !S.detailCollapsed;
    LS.set('annieplayer.fb2k.detailCollapsed', S.detailCollapsed);
    renderRight(); updateRight(); renderLyrics(); updateSpecVisibility();
  }

  function buildBottom() {
    var bar = el('div', 'f2-bottom');
    // 左下功能按钮组
    var tools = el('div', 'f2-toolbtns');
    R.btnCycleView = toolBtn(SVG.list, '播放列表视图切换（列表/分栏/封面）', function () {
      setViewMode(S.viewMode === 'list' ? 'split' : S.viewMode === 'split' ? 'cover' : 'list');
    });
    R.btnSpec = toolBtn(SVG.spec, '可视化效果开关', function () {
      S.specOn = !S.specOn; LS.set('annieplayer.fb2k.specOn', S.specOn);
      R.btnSpec.classList.toggle('active', S.specOn); updateSpecVisibility();
    });
    R.btnSpec.classList.toggle('active', S.specOn);
    // EXP 7.28：15 段 EQ 底部抽屉（引擎端 DSP，双界面共享状态）
    R.eqPanel = null;
    var btnEq = toolBtn(SVG.eq, '均衡器（15 段）', function () {
      var willOpen = R.eqDock.classList.contains('hidden');
      R.eqDock.classList.toggle('hidden', !willOpen);
      btnEq.classList.toggle('active', willOpen);
      if (willOpen && !R.eqPanel && window.annieEQ) R.eqPanel = window.annieEQ.mountPanel(R.eqDock);
    });
    var btnSet = toolBtn(SVG.gear, '设置面板', function () { window.annieSettings.togglePanel(); });
    // V1.1.2：暗色模式快捷切换（工具栏按钮，Ctrl+Shift+D 同效）
    R.btnDark = toolBtn(S.dark ? SVG.sun : SVG.moon, '暗色模式切换（Ctrl+Shift+D）', function () { setDarkMode(!S.dark); });
    // Pro beat0.0.1：Now Playing 全屏入口（N 键同效）
    R.btnNpf = toolBtn(SVG.screen, 'Now Playing 全屏（N）', function () { window.annieProUi && annieProUi.toggleNpf(); });
    R.btnDark.classList.toggle('active', S.dark);
    // SVLX：WASAPI 独占/共享开关（与粒子舞台底栏锁按钮同一逻辑，走 exclusive.js 全局接口）
    var SVG_LOCK = '<svg viewBox="0 0 16 16"><path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="3.6" y="7" width="8.8" height="6.4" rx="1.6"/></svg>';
    var SVG_UNLOCK = '<svg viewBox="0 0 16 16"><path d="M5.5 7V4.8a2.5 2.5 0 0 1 4.9-.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="3.6" y="7" width="8.8" height="6.4" rx="1.6"/></svg>';
    var syncExclBtn = function (on) {
      if (!R.btnExcl) return;
      R.btnExcl.innerHTML = on ? SVG_LOCK : SVG_UNLOCK;
      R.btnExcl.classList.toggle('active', on);
      R.btnExcl.title = on ? 'WASAPI 独占输出（bit-perfect 直通）——点击切换共享'
                           : 'WASAPI 共享输出（兼容模式）——点击切换独占';
    };
    R.btnExcl = toolBtn('', '', async function () {
      if (!window.annieExclusiveToggle) return;
      syncExclBtn(await window.annieExclusiveToggle());
    });
    syncExclBtn(window.annieIsExclusive ? window.annieIsExclusive() : true);
    document.addEventListener('annie-exclusive-changed', function (e) { syncExclBtn(!!(e.detail && e.detail.exclusive)); });
    // SVLX：定位当前播放文件（树展开 + 列表滚动 + 高亮闪烁）
    var SVG_TARGET = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.6"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    R.btnLocate = toolBtn(SVG_TARGET, '定位当前播放文件', function () { locatePlayingFb2k(true); });
    tools.append(R.btnCycleView, R.btnSpec, btnEq, R.btnExcl, R.btnLocate, R.btnDark, R.btnNpf, btnSet);
    bar.appendChild(tools);

    // 进度条
    var prog = el('div', 'f2-progress');
    R.tCur = el('span', 'f2-ptime', '00:00:00');
    R.slider = el('div', 'f2-slider idle');
    R.rail = el('div', 'rail'); R.fill = el('div', 'fill'); R.knob = el('div', 'knob');
    R.sliderTip = el('div', 'f2-slider-tip');
    R.slider.append(R.rail, R.fill, R.knob, R.sliderTip);
    R.tTotal = el('span', 'f2-ptime', '00:00:00');
    prog.append(R.tCur, R.slider, R.tTotal);
    bar.appendChild(prog);
    bindSlider();

    // 播放控制组
    var tp = el('div', 'f2-transport');
    var bPrev = el('button', 'f2-tbtn'); bPrev.innerHTML = SVG.prev; bPrev.title = '上一曲'; bPrev.onclick = transportPrev;
    R.btnPlay = el('button', 'f2-tbtn main'); R.btnPlay.innerHTML = SVG.play; R.btnPlay.title = '播放/暂停';
    R.btnPlay.onclick = transportPlayPause;
    var bNext = el('button', 'f2-tbtn'); bNext.innerHTML = SVG.next; bNext.title = '下一曲'; bNext.onclick = transportNext;
    var bStop = el('button', 'f2-tbtn'); bStop.innerHTML = SVG.stop; bStop.title = '停止';
    bStop.onclick = function () { window.mine.engine('stop').catch(function () { }); };
    // 播放模式循环切换（与 AM/粒子舞台共用 anniePlayMode 状态）
    var bMode = el('button', 'f2-tbtn'); bMode.textContent = '→';
    function syncModeBtn() {
      if (!window.anniePlayMode) return;
      var inf = window.anniePlayMode.info();
      bMode.textContent = inf.icon;
      bMode.title = '播放模式：' + inf.label + (inf.hint ? '\n' + inf.hint : '') + '\n（仅本地播放生效，点击切换）';
    }
    bMode.onclick = function () {
      if (!window.anniePlayMode) return;
      var inf = window.anniePlayMode.cycle();
      try { if (typeof proToast === 'function') proToast('播放模式：' + inf.label); } catch (e) { }
    };
    document.addEventListener('annie-playmode-changed', syncModeBtn);
    syncModeBtn();
    tp.append(bPrev, R.btnPlay, bNext, bStop, bMode);
    bar.appendChild(tp);

    // 音量
    var vol = el('div', 'f2-volume');
    R.volIcon = el('button', 'f2-vicon'); R.volIcon.innerHTML = SVG.vol; R.volIcon.title = '静音切换';
    R.volIcon.onclick = toggleMute;
    R.volSlider = el('div', 'f2-vol-slider');
    R.volFill = el('div', 'fill'); R.volKnob = el('div', 'knob');
    R.volSlider.append(el('div', 'rail'), R.volFill, R.volKnob);
    vol.append(R.volIcon, R.volSlider);
    bar.appendChild(vol);
    bindVolume();

    // 右下视图按钮
    var views = el('div', 'f2-viewbtns');
    R.viewBtns = {};
    [['list', SVG.list, '列表视图'], ['split', SVG.split, '分栏视图'], ['cover', SVG.cover, '封面视图']].forEach(function (v) {
      var b = el('button'); b.innerHTML = v[1]; b.title = v[2];
      b.onclick = function () { setViewMode(v[0]); };
      R.viewBtns[v[0]] = b; views.appendChild(b);
    });
    bar.appendChild(views);
    refreshViewBtns();
    return bar;
  }
  function toolBtn(svg, title, fn) {
    var b = el('button'); b.innerHTML = svg; b.title = title; b.onclick = fn;
    return b;
  }
  function modal(title, html) {
    var mask = el('div', 'f2-modal-mask');
    var box = el('div', 'f2-modal');
    box.appendChild(el('h3', '', title));
    var body = el('div'); body.innerHTML = html; body.style.lineHeight = '1.8';
    box.appendChild(body);
    var btns = el('div'); btns.style.cssText = 'text-align:right;margin-top:12px';
    var ok = el('button', '', '确定');
    ok.style.cssText = 'padding:4px 18px;border:1px solid #4a90c2;background:#4a90c2;color:#fff;border-radius:3px;cursor:pointer';
    ok.onclick = function () { mask.remove(); };
    btns.appendChild(ok); box.appendChild(btns);
    mask.appendChild(box);
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    ($('#fb2k-root') || document.body).appendChild(mask); // V1.1.2：挂进 root 以继承暗色类
  }

  /* ================= 左侧：播放列表树 ================= */
  /* V4.4：歌单树节点长按拖拽排序（与 AM 侧栏 attachPlDragSort 同款 Pointer 长按模式）。
   * 400ms 长按进入拖拽并抑制 click；拖动经过目标节点时按上半/下半决定插前/插后（落点高亮）；
   * 松手后按新顺序调主进程 playlistReorderList 持久化并重渲树。 */
  function attachPlSort(plNode, pl) {
    plNode.dataset.plid = pl.id;
    // V4.4：与 AM 同步改为位移阈值拖拽（移动 >6px 即拖，无位移=点击）；
    // 旧 400ms 长按 + 8px 早移取消在桌面鼠标下表现为「拖不动」
    var armed = false, dragging = false, startY = 0, pid = 0;
    plNode.style.touchAction = 'none';
    plNode.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return; // 右键交给 oncontextmenu
      pid = e.pointerId; startY = e.clientY; dragging = false; armed = true;
    });
    plNode.addEventListener('pointermove', function (e) {
      if (!armed && !dragging) return;
      if (!dragging) {
        if (Math.abs(e.clientY - startY) <= 6) return;
        dragging = true;
        plNode.classList.add('pl-drag-src');
        try { plNode.setPointerCapture(pid); } catch (err) { }
      }
      var over = document.elementFromPoint(e.clientX, e.clientY);
      var target = over && over.closest ? over.closest('.f2-node[data-plid]') : null;
      clearPlDrop();
      if (target && target !== plNode && target.dataset.plid) {
        var r = target.getBoundingClientRect();
        var before = (e.clientY - r.top) < r.height / 2;
        target.classList.add(before ? 'pl-drop-before' : 'pl-drop-after');
        plNode._dropTarget = target; plNode._dropBefore = before;
      } else { plNode._dropTarget = null; }
    });
    function endDrag() {
      armed = false;
      if (!dragging) return; // 无位移=正常点击，放行
      dragging = false;
      plNode.classList.remove('pl-drag-src');
      var target = plNode._dropTarget, before = plNode._dropBefore;
      plNode._dropTarget = null;
      clearPlDrop();
      try { plNode.releasePointerCapture(pid); } catch (err) { }
      plNode._suppressClick = true;
      setTimeout(function () { plNode._suppressClick = false; }, 50);
      if (!target || !target.dataset.plid || target.dataset.plid === pl.id) return;
      var ids = S.playlists.map(function (p) { return p.id; });
      var from = ids.indexOf(pl.id);
      if (from < 0 || ids.indexOf(target.dataset.plid) < 0) return;
      ids.splice(from, 1);
      var to = ids.indexOf(target.dataset.plid);
      ids.splice(before ? to : to + 1, 0, pl.id);
      window.mine.playlistReorderList(ids).then(function (pls) { S.playlists = pls; rebuildTree(); }).catch(function () { });
    }
    plNode.addEventListener('pointerup', endDrag);
    plNode.addEventListener('pointercancel', endDrag);
    // 拖拽后抑制紧随的 click（避免误进歌单）
    plNode.addEventListener('click', function (e) { if (plNode._suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  }
  function clearPlDrop() {
    if (!R.tree) return;
    R.tree.querySelectorAll('.pl-drop-before, .pl-drop-after').forEach(function (x) { x.classList.remove('pl-drop-before'); x.classList.remove('pl-drop-after'); });
  }

  function rebuildTree() {
    // V4.4：歌单签名变化即递增 plVer 使排序缓存失效（歌单统一主进程后，内容变更来自
    // IPC 返回/AM 侧加歌/迁移等 8 个路径，集中在这里兜底，防 sortCache 命中陈旧行）
    var plSig = S.playlists.map(function (p) {
      return p.id + ':' + p.paths.length + ':' + (p.paths[0] || '') + ':' + (p.paths[p.paths.length - 1] || '');
    }).join('|');
    if (plSig !== S._plSig) {
      S._plSig = plSig; S.plVer++;
      // 当前正停在被变更的歌单视图：行列表一并失效重建（旧 bug：AM 侧加歌后切回 FB2K 行列表陈旧）
      if (typeof S.activeList === 'string' && S.activeList.indexOf('pl:') === 0 && typeof rebuildRows === 'function') rebuildRows();
    }
    var t = R.tree;
    t.innerHTML = '';
    var tracks = state.library.tracks;
    function node(icon, name, count, key, child) {
      var n = el('div', 'f2-node' + (child ? ' child' : '') + (S.activeList === key ? ' active' : ''));
      n.appendChild(el('span', 'f2-twisty', ''));
      var ic = el('span', 'f2-nicon'); ic.innerHTML = icon || '';
      n.appendChild(ic);
      n.appendChild(el('span', 'f2-nname', name)).title = name;
      n.appendChild(el('span', 'f2-badge', String(count)));
      n.onclick = function () { setActiveList(key); };
      n.oncontextmenu = function (e) { e.preventDefault(); treeCtxMenu(e, key); };
      return n;
    }
    t.appendChild(node('', '默认列表', tracks.length, 'default'));
    t.appendChild(node('♥', '我的喜爱', state.favorites.size, 'fav'));
    // Pro beat0.0.1：智能列表
    if (window.anniePro) {
      t.appendChild(node('🔥', '最常听', window.anniePro.smartTracks('top').length, 'smart:top'));
      t.appendChild(node('🕒', '最近播放', window.anniePro.smartTracks('recent').length, 'smart:recent'));
      t.appendChild(node('🆕', '最近添加', Math.min(100, tracks.length), 'smart:new'));
    }
    S.playlists.forEach(function (p) {
      var plNode = node(SVG.list, p.name, p.paths.length, 'pl:' + p.id);
      attachPlSort(plNode, p); // V4.4：歌单节点拖拽排序（Pointer 长按拖拽，落点高亮，playlistReorderList 持久化）
      t.appendChild(plNode);
    });
    // V4.4：在线歌单分组（流媒体，主进程 streamPlaylists，与 AM 同一份；默认展开）
    var splOpen = !S.treeExpanded.has('__spl:closed');
    var splHead = el('div', 'f2-node');
    var stw = el('span', 'f2-twisty', splOpen ? '▼' : '▶');
    stw.onclick = function (e) {
      e.stopPropagation();
      if (splOpen) S.treeExpanded.add('__spl:closed'); else S.treeExpanded.delete('__spl:closed');
      rebuildTree();
    };
    splHead.appendChild(stw);
    var sic = el('span', 'f2-nicon'); sic.textContent = '☁'; splHead.appendChild(sic);
    splHead.appendChild(el('span', 'f2-nname', '在线歌单'));
    splHead.appendChild(el('span', 'f2-badge', ''));
    splHead.onclick = stw.onclick;
    splHead.oncontextmenu = function (e) { e.preventDefault(); treeCtxMenu(e, '__spl'); };
    t.appendChild(splHead);
    if (splOpen) {
      S.spl.forEach(function (sp) {
        var sn = node('☁', sp.name, (sp.items || []).length, 'spl:' + sp.id);
        sn.classList.add('child');
        t.appendChild(sn);
      });
    }
    // Pro beat0.0.1：媒体库（艺术家 / 专辑两级聚合）
    if (window.anniePro) {
      var mediaOpen = S.treeExpanded.has('__media');
      var mediaRow = el('div', 'f2-node');
      var mtw = el('span', 'f2-twisty', mediaOpen ? '▼' : '▶');
      mtw.onclick = function (e) {
        e.stopPropagation();
        if (mediaOpen) S.treeExpanded.delete('__media'); else S.treeExpanded.add('__media');
        rebuildTree();
      };
      mediaRow.appendChild(mtw);
      var mic = el('span', 'f2-nicon'); mic.textContent = '🗂'; mediaRow.appendChild(mic);
      mediaRow.appendChild(el('span', 'f2-nname', '媒体库'));
      mediaRow.appendChild(el('span', 'f2-badge', ''));
      mediaRow.onclick = mtw.onclick;
      t.appendChild(mediaRow);
      if (mediaOpen) {
        var artistsOpen = S.treeExpanded.has('__media_artists');
        var albumsOpen = S.treeExpanded.has('__media_albums');
        var groupRow = function (label, icon, count, open, toggleKey) {
          var g = el('div', 'f2-node child');
          g.style.paddingLeft = '20px';
          var tw2 = el('span', 'f2-twisty', open ? '▼' : '▶');
          tw2.onclick = function (e) {
            e.stopPropagation();
            if (open) S.treeExpanded.delete(toggleKey); else S.treeExpanded.add(toggleKey);
            rebuildTree();
          };
          g.appendChild(tw2);
          g.appendChild(el('span', 'f2-nname', label));
          g.appendChild(el('span', 'f2-badge', String(count)));
          g.onclick = tw2.onclick;
          return g;
        };
        t.appendChild(groupRow('艺术家', '', window.anniePro.aggArtists().length, artistsOpen, '__media_artists'));
        if (artistsOpen) {
          window.anniePro.aggArtists().slice(0, 300).forEach(function (a) {
            var key = 'artist:' + a.key;
            var r = el('div', 'f2-node child' + (S.activeList === key ? ' active' : ''));
            r.style.paddingLeft = '34px';
            r.appendChild(el('span', 'f2-twisty', ''));
            r.appendChild(el('span', 'f2-nname', a.artist)).title = a.artist;
            r.appendChild(el('span', 'f2-badge', String(a.count)));
            r.onclick = function () { setActiveList(key); };
            t.appendChild(r);
          });
        }
        t.appendChild(groupRow('专辑', '', window.anniePro.aggAlbums().length, albumsOpen, '__media_albums'));
        if (albumsOpen) {
          window.anniePro.aggAlbums().slice(0, 300).forEach(function (a) {
            var key = 'album:' + a.key;
            var r = el('div', 'f2-node child' + (S.activeList === key ? ' active' : ''));
            r.style.paddingLeft = '34px';
            r.appendChild(el('span', 'f2-twisty', ''));
            r.appendChild(el('span', 'f2-nname', a.album)).title = a.album + ' · ' + a.artist;
            r.appendChild(el('span', 'f2-badge', String(a.count)));
            r.onclick = function () { setActiveList(key); };
            t.appendChild(r);
          });
        }
      }
    }
    /* EXP 7.28：递归文件夹树（与粒子舞台同源 buildFolderTree / state.library.tracks），
     * 支持展开/折叠；计数为递归汇总；点击过滤行为与粒子舞台一致（isPathUnder 递归包含）。 */
    var renderFolderNode = function (n, depth) {
      var key = 'folder:' + n.path;
      var hasKids = n.children.size > 0;
      var expanded = S.treeExpanded.has(n.path);
      var row = el('div', 'f2-node' + (depth ? ' child' : '') + (S.activeList === key ? ' active' : ''));
      row.style.paddingLeft = (6 + depth * 14) + 'px';
      var tw = el('span', 'f2-twisty', hasKids ? (expanded ? '▼' : '▶') : '');
      if (hasKids) tw.onclick = function (e) {
        e.stopPropagation();
        if (expanded) S.treeExpanded.delete(n.path); else S.treeExpanded.add(n.path);
        rebuildTree();
      };
      row.appendChild(tw);
      var ic = el('span', 'f2-nicon'); ic.innerHTML = SVG.folder; row.appendChild(ic);
      var nm = el('span', 'f2-nname', n.name); nm.title = n.path; row.appendChild(nm);
      row.appendChild(el('span', 'f2-badge', String(n.count)));
      row.onclick = function () { setActiveList(key); };
      row.oncontextmenu = function (e) { e.preventDefault(); treeCtxMenu(e, key); };
      t.appendChild(row);
      if (hasKids && expanded) {
        var kids = [...n.children.values()].sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN-u-co-pinyin'); });
        kids.forEach(function (k) { renderFolderNode(k, depth + 1); });
      }
    };
    buildFolderTree().forEach(function (r) {
      if (!S.treeExpanded.has(r.path) && S.treeExpanded.size === 0) S.treeExpanded.add(r.path); // 默认展开根
      renderFolderNode(r, 0);
    });
  }
  function setActiveList(key) {
    S.activeList = key;
    S.sel.clear(); S.anchor = -1;
    rebuildTree(); rebuildRows();
  }
  function onFilter(v) {
    S.filter = (v || '').trim();
    rebuildRows();
  }
  function treeCtxMenu(e, key) {
    var items = [['新建播放列表', newPlaylist]];
    items.push(['新建在线歌单', newSpl]);
    items.push(['📥 导入歌单（.anniepl）…', importPlaylistFiles]);
    items.push(['📥 导入在线歌单（.anniespl）…', importSplFiles]);
    if (key.indexOf('pl:') === 0) {
      var id = key.slice(3);
      items.push('-');
      items.push(['📤 导出歌单（.anniepl）…', function () { exportPlaylistFile(id); }]);
      items.push(['重命名', function () {
        var p = S.playlists.find(function (x) { return x.id === id; });
        // V4.1：Electron 不支持原生 prompt()，走应用内输入对话框
        window.anniePrompt('播放列表名称', p ? p.name : '', function (n) {
          // V4.4：歌单统一到主进程
          window.mine.playlistRename(id, n).then(function (pls) {
            if (Array.isArray(pls)) S.playlists = pls;
            rebuildTree();
          }).catch(function () { });
        });
      }]);
      items.push(['删除', function () {
        // V4.4：歌单统一到主进程
        window.mine.playlistDelete(id).then(function (pls) {
          if (Array.isArray(pls)) S.playlists = pls;
          if (S.activeList === key) setActiveList('default'); else rebuildTree();
        }).catch(function () { });
      }]);
    } else if (key.indexOf('spl:') === 0) {
      var sid = key.slice(4);
      items.push('-');
      items.push(['📤 导出在线歌单（.anniespl）…', function () { exportSplFile(sid); }]);
      items.push(['重命名', function () {
        var sp = S.spl.find(function (x) { return x.id === sid; });
        window.anniePrompt('在线歌单名称', sp ? sp.name : '', function (n) {
          window.mine.splRename(sid, n).then(function (pls) {
            if (Array.isArray(pls)) { S.spl = pls; S.splVer++; }
            rebuildTree();
          }).catch(function () { });
        });
      }]);
      items.push(['删除', function () {
        window.mine.splDelete(sid).then(function (pls) {
          if (Array.isArray(pls)) { S.spl = pls; S.splVer++; }
          if (S.activeList === key) setActiveList('default'); else rebuildTree();
        }).catch(function () { });
      }]);
    }
    items.push(['导入文件夹…', function () { $('#btn-add-folder').click(); }]);
    ctxMenu(e, items);
  }
  /* V4.4：在线歌单管理——全部走主进程 RPC（返回最新 streamPlaylists 直接覆盖镜像） */
  function newSpl() {
    window.anniePrompt('新建在线歌单名称', '新建在线歌单', function (n) {
      window.mine.splCreate(n).then(function (pls) {
        if (Array.isArray(pls)) { S.spl = pls; S.splVer++; }
        rebuildTree();
      }).catch(function () { });
    });
  }
  function exportSplFile(id) {
    window.mine.splExportFile(id).then(function (r) {
      if (!r || r.reason === 'canceled') return;
      if (r.ok) stNotify('📤 已导出 ' + r.count + ' 首到：' + r.path);
      else alert('导出失败：' + (r.reason || '未知错误'));
    }).catch(function () { });
  }
  function importSplFiles() {
    window.mine.splImportFile().then(function (r) {
      if (!r || r.canceled) return;
      if (Array.isArray(r.playlists)) { S.spl = r.playlists; S.splVer++; }
      rebuildTree();
      var oks = (r.results || []).filter(function (x) { return x.ok; });
      var bads = (r.results || []).filter(function (x) { return !x.ok; });
      if (!oks.length) {
        alert('导入失败：\n' + bads.map(function (x) { return x.file + '：' + x.error; }).join('\n'));
        return;
      }
      var total = oks.reduce(function (s, x) { return s + (x.imported || 0); }, 0);
      stNotify('📥 已导入 ' + oks.length + ' 个在线歌单，共 ' + total + ' 首');
      if (oks.length === 1 && oks[0].id) setActiveList('spl:' + oks[0].id);
      if (bads.length) alert('以下文件解析失败：\n' + bads.map(function (x) { return '· ' + x.file + '：' + x.error; }).join('\n'));
    }).catch(function () { });
  }
  /* V4.4：在线歌单初始化——从主进程 streamPlaylists 读取（与 AM 同一份） */
  function initSpl() {
    if (!window.mine || !window.mine.splList) return;
    window.mine.splList().then(function (pls) {
      S.spl = Array.isArray(pls) ? pls : [];
      S.splVer++;
      if (!S.mounted) return;
      rebuildTree();
      if (S.activeList.indexOf('spl:') === 0) rebuildRows();
    }).catch(function () { });
  }
  function newPlaylist() {
    // V4.1：Electron 不支持原生 prompt()，走应用内输入对话框
    window.anniePrompt('新建播放列表名称', '新建列表', function (n) {
      // V4.4：歌单统一到主进程 library.json（与 AM 同一份，跨主题共享）
      window.mine.playlistCreate(n).then(function (pls) {
        if (Array.isArray(pls)) S.playlists = pls;
        rebuildTree();
      }).catch(function () { });
    });
  }
  /* V4.4：导出歌单 .anniepl（换机复现；主进程多指纹匹配），与 AM 侧同一 RPC */
  function exportPlaylistFile(id) {
    window.mine.playlistExportFile(id).then(function (r) {
      if (!r || r.reason === 'canceled') return;
      if (r.ok) { try { if (typeof proToast === 'function') proToast('📤 已导出 ' + r.count + ' 首到：' + r.path); } catch (e) { } }
      else alert('导出失败：' + (r.reason || '未知错误'));
    }).catch(function () { });
  }
  /* V4.4：导入歌单 .anniepl（主进程匹配建表；未命中曲目列清单），与 AM 侧同一 RPC */
  function importPlaylistFiles() {
    window.mine.playlistImportFile().then(function (r) {
      if (!r || r.canceled) return;
      if (Array.isArray(r.playlists)) S.playlists = r.playlists;
      var oks = (r.results || []).filter(function (x) { return x.ok; });
      var bads = (r.results || []).filter(function (x) { return !x.ok; });
      if (!oks.length) {
        alert('导入失败：\n' + bads.map(function (x) { return x.file + '：' + x.error; }).join('\n'));
        rebuildTree(); return;
      }
      rebuildTree();
      var totalMiss = oks.reduce(function (s, x) { return s + (x.total - x.matched); }, 0);
      var totalMatched = oks.reduce(function (s, x) { return s + x.matched; }, 0);
      try { if (typeof proToast === 'function') proToast('📥 已导入 ' + oks.length + ' 个歌单，匹配 ' + totalMatched + ' 首' + (totalMiss ? '，' + totalMiss + ' 首未找到' : '')); } catch (e) { }
      if (oks.length === 1 && oks[0].id) setActiveList('pl:' + oks[0].id);
      if (totalMiss || bads.length) {
        var lines = [];
        if (totalMiss) {
          lines.push('以下 ' + totalMiss + ' 首未在本机曲库找到（本机未收录、文件名/标签不同或源文件缺失）：');
          var shown = 0;
          oks.forEach(function (x) {
            (x.missing || []).forEach(function (m) {
              if (shown++ >= 50) return;
              var label = m.title || m.file || '未知曲目';
              if (m.artist) label += ' — ' + m.artist;
              if (m.file && m.title && m.file !== m.title) label += '（' + String(m.file).split('\\').pop() + '）';
              lines.push('· [' + x.name + '] ' + label);
            });
          });
          if (shown > 50) lines.push('…（仅显示前 50 首）');
        }
        if (bads.length) lines.push('', '以下文件解析失败：', bads.map(function (x) { return '· ' + x.file + '：' + x.error; }).join('\n'));
        alert(lines.join('\n'));
      }
    }).catch(function () { });
  }
  /* V4.4：歌单持久化统一走主进程。S.playlists 仅作主进程 library.json playlists 的渲染层镜像，
   * 不再写 localStorage（旧逻辑 savePlaylists 写 annieplayer.fb2k.playlists 已废弃，见 initPlaylists 迁移）。
   * 保留 savePlaylists 作 no-op 兼容旧调用点（各处 IPC 已用返回的最新 playlists 直接覆盖 S.playlists）。 */
  function savePlaylists() { S.plVer++; }
  /* V4.4：歌单初始化——从主进程读取，并做一次性 localStorage 旧歌单迁移（幂等）。
   * 迁移：若 localStorage 还有 FB2K 自建歌单且未迁移过，逐个 playlistCreate 建到主进程并补 paths，
   * 完成后置迁移标记并清空 localStorage 旧数据，避免重复迁移。 */
  var PL_MIGRATE_KEY = 'annieplayer.fb2k.playlists.migrated';
  var plMigrating = false; // V4.4：迁移链是 N 次串行 IPC，耗时窗口内快速切主题会并发重入（旧实现会建出重复歌单）
  function initPlaylists() {
    if (!window.mine || !window.mine.playlists) return;
    window.mine.playlists().then(function (pls) {
      pls = Array.isArray(pls) ? pls : [];
      var legacy = LS.get('annieplayer.fb2k.playlists', []);
      var migrated = LS.get(PL_MIGRATE_KEY, false);
      if (!migrated && !plMigrating && Array.isArray(legacy) && legacy.length) {
        plMigrating = true;
        // V4.4：任一步骤失败则不标 migrated、不清 legacy，下次启动重试
        // （旧实现逐步 catch 吞错 + 无条件标已迁移并清 legacy → 中途失败的歌单永久丢失）
        var failed = false;
        // 逐个迁移：建歌单 + 补曲目（主进程 playlistCreate 返回最新列表；取新歌单 id 再 playlistAdd）
        var chain = Promise.resolve(pls);
        legacy.forEach(function (lp) {
          chain = chain.then(function (cur) {
            if (!lp || !lp.name) return cur;
            // 同名歌单已存在则跳过建（只补缺失曲目），防重复
            var exist = (cur || []).find(function (x) { return x.name === lp.name; });
            if (exist) {
              var miss = (lp.paths || []).filter(function (p) { return exist.paths.indexOf(p) < 0; });
              if (!miss.length) return cur;
              return window.mine.playlistAdd(exist.id, miss).then(function (r) { return Array.isArray(r) ? r : cur; })
                .catch(function () { failed = true; return cur; });
            }
            return window.mine.playlistCreate(lp.name).then(function (r) {
              var after = Array.isArray(r) ? r : cur;
              var created = after.find(function (x) { return x.name === lp.name; });
              if (created && (lp.paths || []).length) {
                return window.mine.playlistAdd(created.id, lp.paths).then(function (r2) { return Array.isArray(r2) ? r2 : after; })
                  .catch(function () { failed = true; return after; });
              }
              return after;
            }).catch(function () { failed = true; return cur; });
          });
        });
        return chain.then(function (finalPls) {
          plMigrating = false;
          S.playlists = Array.isArray(finalPls) ? finalPls : pls;
          if (!failed) {
            LS.set(PL_MIGRATE_KEY, true);
            LS.set('annieplayer.fb2k.playlists', []); // 清空旧数据，防二次迁移
          }
          rebuildTree();
        }).catch(function () { plMigrating = false; }); // 链上每步已 catch，理论上不触发，兜底复位锁
      }
      if (plMigrating) return; // 迁移进行中：并发进来的读取不覆盖，等迁移链收尾统一刷新
      S.playlists = pls;
      rebuildTree();
    }).catch(function () { });
  }

  /* ================= 中央：曲目列表（虚拟滚动） ================= */
  var COLS = [
    { k: 'cover', name: '封面', w: 50, sort: null },
    { k: 'state', name: '', w: 30, sort: null },
    { k: 'idx', name: '#', w: 40, sort: 'idx' },
    { k: 'title', name: '标题', flex: 1, sort: 'title' },
    { k: 'artist', name: '艺术家', flex: 1, sort: 'artist' },
    { k: 'rating', name: '等级', w: 80, sort: 'rating' },
    { k: 'time', name: '时间', w: 60, sort: 'time' },
    { k: 'mtime', name: '修改日期', w: 96, sort: 'mtime' } // V4.3.15
  ];
  /* V4.4 第三层：列宽可拖。固定宽列（cover/state/idx/rating/time/mtime）表头右缘 7px 热区拖拽；
   * 拖中只改表头+可见行单元格的 width（不重建 DOM，避免 pointer capture 中断），松手才持久化+重建。 */
  function colWidth(c) { return c.w ? (S.colW[c.k] || c.w) : null; }
  function applyColWidthLive(c) {
    var w = colWidth(c) + 'px';
    R.cols.querySelectorAll('.f2-col[data-ck="' + c.k + '"]').forEach(function (h) { h.style.width = w; });
    R.rows.querySelectorAll('.f2-c-' + c.k).forEach(function (cell) { cell.style.width = w; });
  }
  function attachColResize(headCell, c) {
    var h = el('span', 'f2-col-resize');
    h.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var startX = e.clientX, w0 = colWidth(c), moved = false;
      try { headCell.setPointerCapture(e.pointerId); } catch (err) { }
      var mv = function (ev) {
        var w = Math.max(28, Math.min(320, Math.round(w0 + ev.clientX - startX)));
        if (w !== w0) moved = true;
        S.colW[c.k] = w;
        applyColWidthLive(c);
      };
      var up = function () {
        headCell.removeEventListener('pointermove', mv);
        headCell.removeEventListener('pointerup', up);
        headCell.removeEventListener('pointercancel', up);
        if (moved) {
          LS.set('annieplayer.fb2k.colW', S.colW);
          headCell._suppressSort = true; // 拖拽后抑制紧随的 click（防误触发排序）
          setTimeout(function () { headCell._suppressSort = false; }, 50);
          buildCols(); renderVisible();
        }
      };
      headCell.addEventListener('pointermove', mv);
      headCell.addEventListener('pointerup', up);
      headCell.addEventListener('pointercancel', up);
    });
    h.onclick = function (e) { e.stopPropagation(); }; // 手柄点击不触发排序
    headCell.appendChild(h);
  }
  function buildCols() {
    R.cols.innerHTML = '';
    COLS.forEach(function (c) {
      if (S.viewMode === 'split' && c.k === 'cover') return;
      var d = el('div', 'f2-col', c.name);
      d.dataset.ck = c.k;
      var cw = colWidth(c);
      if (cw != null) d.style.cssText = 'flex:none;width:' + cw + 'px';
      else d.style.cssText = 'flex:' + c.flex + ';min-width:0';
      if (c.sort) {
        if (S.sortKey === c.sort) d.appendChild(el('span', 'f2-sort-arrow', S.sortAsc ? '▲' : '▼'));
        d.onclick = function () {
          if (d._suppressSort) return; // 刚拖完列宽
          if (S.sortKey === c.sort) S.sortAsc = !S.sortAsc; else { S.sortKey = c.sort; S.sortAsc = true; }
          rebuildRows();
        };
      }
      if (c.w) attachColResize(d, c);
      R.cols.appendChild(d);
    });
  }

  function baseTracks() {
    var list = state.library.tracks;
    if (S.activeList === 'fav') list = list.filter(function (t) { return state.favorites.has(t.path); });
    // Pro beat0.0.1：智能列表 / 媒体库聚合过滤
    else if (S.activeList.indexOf('smart:') === 0 && window.anniePro) list = window.anniePro.smartTracks(S.activeList.slice(6));
    else if (S.activeList.indexOf('album:') === 0 && window.anniePro) list = window.anniePro.albumTracks(S.activeList.slice(6));
    else if (S.activeList.indexOf('artist:') === 0 && window.anniePro) list = window.anniePro.artistTracks(S.activeList.slice(7));
    else if (S.activeList.indexOf('folder:') === 0) {
      var f = S.activeList.slice(7);
      list = list.filter(function (t) { return isPathUnder(t.dir, f); });
    } else if (S.activeList.indexOf('pl:') === 0) {
      var pl = S.playlists.find(function (x) { return 'pl:' + x.id === S.activeList; });
      var set = new Set(pl ? pl.paths : []);
      list = list.filter(function (t) { return set.has(t.path); });
    } else if (S.activeList.indexOf('spl:') === 0) {
      // V4.4：在线歌单——items 映射为虚拟曲目（__stream 挂原始 song，__splIdx 记原索引供 splRemove）
      var sp = S.spl.find(function (x) { return 'spl:' + x.id === S.activeList; });
      list = (sp && sp.items ? sp.items : []).map(function (it, i) { return splTrack(it, i); });
    }
    list = list.filter(function (t) { return !S.hiddenPaths.has(t.path); });
    return list;
  }

  /* 排序结果缓存：过滤/重绘时复用，避免每次都对数千曲目重做拼音排序 */
  var sortCache = { key: null, deco: null };
  S.ratingsVer = 0;
  S.plVer = 0;
  function sortCacheKey() {
    return [S.activeList, S.sortKey, S.sortAsc, state.library.tracks.length,
      state.favorites.size, S.hiddenPaths.size, S.ratingsVer, S.plVer, S.splVer].join('|');
  }
  /* V4.4：流媒体虚拟曲目的 artist/album 直取 song（全局 tagOf 会按文件名猜，对伪路径不适用） */
  function fb2kTagOf(t) {
    if (t.__stream) return { artist: t.__stream.artist || '', album: t.__stream.album || '' };
    return tagOf(t);
  }
  function sortedDeco() {
    var key = sortCacheKey();
    if (sortCache.key === key && sortCache.deco) return sortCache.deco;
    var coll = new Intl.Collator('zh-Hans-CN-u-co-pinyin'); // 复用 collator，远快于逐次 localeCompare
    var deco = baseTracks().map(function (t) {
      var tag = fb2kTagOf(t);
      return { t: t, artist: tag.artist || '', album: tag.album || '', name: t.name, dir: t.dir };
    });
    if (S.sortKey) { // 列排序：扁平
      var dir = S.sortAsc ? 1 : -1;
      deco.sort(function (a, b) {
        var r = 0;
        if (S.sortKey === 'title') r = coll.compare(a.name, b.name);
        else if (S.sortKey === 'artist') r = coll.compare(a.artist || '￿', b.artist || '￿');
        else if (S.sortKey === 'rating') r = (S.ratings[a.t.path] || 0) - (S.ratings[b.t.path] || 0);
        else if (S.sortKey === 'time') r = (durOf(a.t) - durOf(b.t));
        else if (S.sortKey === 'mtime') r = ((a.t.mtime || 0) - (b.t.mtime || 0)); // V4.3.15
        return r * dir || coll.compare(a.name, b.name);
      });
    } else { // 默认：专辑 → 曲名
      deco.sort(function (a, b) {
        return coll.compare(a.album || '￿', b.album || '￿') || coll.compare(a.name, b.name);
      });
    }
    sortCache = { key: key, deco: deco };
    return deco;
  }

  /* EXP 7.28：>1000 首时排序移交 Web Worker（listWorker.js），主线程只做索引重排。
   * 结果按 sortCacheKey 缓存，过滤/重绘复用；Worker 失败降级同步排序。 */
  var rebuildGen = 0;
  function rebuildRows() {
    var gen = ++rebuildGen;
    var key = sortCacheKey();
    if (sortCache.key === key && sortCache.deco) { applyDeco(sortCache.deco); return; }
    var base = baseTracks();
    // V4.4：流媒体虚拟曲目不走 Worker（listWorker 的 tagOf 按 tagCache 猜标签，对伪路径不适用；在线歌单量级也远小于 1000）
    if (base.length > 1000 && window.annieListWorker && !(base[0] && base[0].__stream)) {
      var durs = {};
      S.metaCache.forEach(function (m, p) { if (m && m.duration) durs[p] = m.duration; });
      window.annieListWorker.sort({
        op: 'fb2k-sort', tracks: base, tagCache: state.tagCache,
        sortKey: S.sortKey, sortAsc: S.sortAsc, ratings: S.ratings, durs: durs
      }).then(function (r) {
        if (gen !== rebuildGen) return;
        if (!r || !r.order) { applyDeco(sortedDeco()); return; } // Worker 失败兜底
        var deco = r.order.map(function (i) {
          var t = base[i], tag = fb2kTagOf(t);
          return { t: t, artist: tag.artist || '', album: tag.album || '', name: t.name, dir: t.dir };
        });
        sortCache = { key: key, deco: deco };
        applyDeco(deco);
      }).catch(function () { if (gen === rebuildGen) applyDeco(sortedDeco()); });
      return;
    }
    applyDeco(sortedDeco());
  }
  function applyDeco(deco) {
    // 关键词过滤（O(n)，不触发重排）
    var kw = S.filter.toLowerCase();
    if (kw) {
      deco = deco.filter(function (d) {
        return d.name.toLowerCase().indexOf(kw) >= 0 || d.dir.toLowerCase().indexOf(kw) >= 0
          || d.artist.toLowerCase().indexOf(kw) >= 0 || d.album.toLowerCase().indexOf(kw) >= 0;
      });
    }
    var rows = [], ti = 0; // ti：曲目前置序号（前缀和），滚动渲染直接取用，不再每次从头数
    if (S.sortKey) {
      deco.forEach(function (d) { rows.push({ type: 'track', t: d.t, ti: ti++ }); });
    } else { // 默认：按专辑分组（绿色分组行）
      var lastAl = null;
      deco.forEach(function (d) {
        var al = d.album || '未知专辑';
        if (al !== lastAl) {
          lastAl = al;
          rows.push({ type: 'group', label: al + (d.artist && d.artist !== '未知艺术家' ? ' | ' + d.artist : '') });
        }
        rows.push({ type: 'track', t: d.t, ti: ti++ });
      });
    }
    var list = deco.map(function (d) { return d.t; });
    S.rows = rows;
    S.tracks = list;
    // SVLX 同步 beta0.0.3：路径 → 行号 / 曲目序号双索引，定位与队列查找 O(1)
    S.rowPathIdx = new Map();
    S.trackPathIdx = new Map();
    for (var ri = 0; ri < rows.length; ri++) {
      if (rows[ri].type === 'track') S.rowPathIdx.set(rows[ri].t.path, ri);
    }
    for (var ti = 0; ti < list.length; ti++) S.trackPathIdx.set(list[ti].path, ti);
    // 播放中不覆写 PlayerCore 队列（双击/ transport 会钉住队列快照）；
    // 覆写会导致队列顺序与播放索引错位（显示一首、播放另一首）。
    // V4.4：流媒体虚拟曲目不进本地队列（播放走 annieStreamPlay，不经 state.queue）
    if (!state.currentPath && !(list[0] && list[0].__stream)) state.queue = list;
    R.spacer.style.height = (rows.length * S.rowH) + 'px';
    buildCols();
    renderVisible();
    // 匹配数量徽章
    R.filterBadge.textContent = String(list.length);
    R.filterBadge.classList.toggle('dim', !S.filter);
  }

  function durOf(t) {
    if (t.__stream) return (t.__stream.duration || 0) / 1000; // V4.4：song.duration 为毫秒
    var m = S.metaCache.get(t.path);
    return (m && m.duration) || 0;
  }

  /* ---------- 虚拟滚动渲染 ---------- */
  function renderVisible() {
    var st = R.list.scrollTop, h = R.list.clientHeight;
    var start = Math.max(0, Math.floor(st / S.rowH) - 8);
    var end = Math.min(S.rows.length, Math.ceil((st + h) / S.rowH) + 8);
    R.rows.innerHTML = '';
    var frag = document.createDocumentFragment();
    for (var i = start; i < end; i++) { // 只遍历可视区间；曲目序号取行模型预计算的 r.ti
      var r = S.rows[i];
      var node = r.type === 'group' ? groupNode(r, i) : trackNode(r, i, r.ti);
      node.style.top = (i * S.rowH) + 'px';
      node.style.position = 'absolute';
      node.style.left = '0'; node.style.right = '0';
      frag.appendChild(node);
    }
    R.rows.appendChild(frag);
    lazyLoadVisibleMeta(start, end);
    // 空列表状态
    var empty = $('.f2-empty', R.list);
    if (!S.rows.length && !empty) {
      var e = el('div', 'f2-empty');
      e.appendChild(el('div', '', listName()));
      e.appendChild(el('div', '', '空列表'));
      R.list.appendChild(e);
    } else if (S.rows.length && empty) empty.remove();
  }
  function listName() {
    if (S.activeList === 'fav') return '我的喜爱';
    if (S.activeList.indexOf('pl:') === 0) {
      var p = S.playlists.find(function (x) { return 'pl:' + x.id === S.activeList; });
      return p ? p.name : '播放列表';
    }
    if (S.activeList.indexOf('spl:') === 0) {
      var sp = S.spl.find(function (x) { return 'spl:' + x.id === S.activeList; });
      return sp ? sp.name : '在线歌单';
    }
    return '默认列表';
  }

  function groupNode(r) {
    var g = el('div', 'f2-group-row', r.label);
    g.style.height = S.rowH + 'px';
    return g;
  }

  function trackNode(r, rowIdx, trackIdx) {
    var t = r.t;
    // V4.4：流媒体行的"播放中"按歌曲身份判定（state.currentPath 是真实 URL，不等于伪路径）
    var playing = t.__stream ? isCurStream(t.__stream) : t.path === state.currentPath;
    var d = el('div', 'f2-row' + (trackIdx % 2 ? ' alt' : '') + (S.sel.has(t.path) ? ' sel' : '') + (playing ? ' playing' : ''));
    d.style.height = S.rowH + 'px';
    d.dataset.path = t.path;
    d.dataset.qi = trackIdx;
    COLS.forEach(function (c) {
      if (S.viewMode === 'split' && c.k === 'cover') return;
      var cell = el('div', 'f2-cell f2-c-' + c.k);
      var ccw = colWidth(c); // V4.4 第三层：用户拖过的列宽优先
      if (ccw != null) cell.style.cssText = 'flex:none;width:' + ccw + 'px';
      else cell.style.cssText = 'flex:' + c.flex + ';min-width:0';
      if (c.k === 'cover') {
        var img = document.createElement('img');
        img.src = PLACEHOLDER; img.draggable = false;
        if (t.__stream) setStreamCover(img, t.__stream.cover); // V4.4：http 封面走代理
        else { var m = S.metaCache.get(t.path); if (m && m.cover) img.src = m.cover; }
        cell.appendChild(img);
        if (S.viewMode === 'cover') { img.style.width = '40px'; img.style.height = '40px'; }
      } else if (c.k === 'state') {
        cell.textContent = playing ? '▶' : '';
      } else if (c.k === 'idx') {
        cell.textContent = trackIdx + 1;
      } else if (c.k === 'title') {
        cell.textContent = t.name.replace(/\.[^.]+$/, '');
        cell.title = cell.textContent;
      } else if (c.k === 'artist') {
        var ar = fb2kTagOf(t).artist; cell.textContent = ar || '未知艺术家';
      } else if (c.k === 'rating') {
        if (!t.__stream) cell.appendChild(starCell(t.path)); // V4.4：流媒体不入本地评分体系
      } else if (c.k === 'time') {
        cell.textContent = playing && S.dur > 0 ? fmtCountdown(S.dur - S.pos) : durationText(t);
      } else if (c.k === 'mtime') {
        cell.textContent = t.mtime ? fmtDate(t.mtime) : ''; // V4.3.15：文件修改日期（扫描入库字段）
      }
      d.appendChild(cell);
    });
    d.onclick = function (e) { rowSelect(e, t.path, rowIdx); };
    // V4.4：流媒体双击走 annieStreamPlay 链路（现解析 URL），本地曲目照旧进本地队列
    d.ondblclick = function () { if (t.__stream) playFb2kStreamAt(trackIdx, S.tracks); else { state.queue = S.tracks; playAt(trackIdx); } };
    d.oncontextmenu = function (e) { e.preventDefault(); rowCtxMenu(e, t, trackIdx); };
    return d;
  }

  function starCell(path) {
    var n = S.ratings[path] || 0;
    var box = el('span');
    var _loop = function (i) {
      var s = el('span', i <= n ? '' : 'off', '★');
      s.style.cursor = 'pointer';
      s.onclick = function (e) {
        e.stopPropagation();
        S.ratings[path] = (n === i ? 0 : i);
        S.ratingsVer++;
        LS.set('annieplayer.ratings', S.ratings);
        renderVisible();
      };
      box.appendChild(s);
    };
    for (var i = 1; i <= 5; i++) _loop(i);
    return box;
  }

  function durationText(t) {
    if (t.__stream) { // V4.4：song.duration 为毫秒
      var ss = Math.round((t.__stream.duration || 0) / 1000);
      return ss ? Math.floor(ss / 60) + ':' + String(ss % 60).padStart(2, '0') : '';
    }
    var m = S.metaCache.get(t.path);
    if (m && m.duration) { var s = Math.round(m.duration); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
    return '';
  }

  /* ---------- 选中 / 右键 ---------- */
  function rowSelect(e, path, rowIdx) {
    if (e.ctrlKey || e.metaKey) {
      if (S.sel.has(path)) S.sel.delete(path); else S.sel.add(path);
      S.anchor = rowIdx;
    } else if (e.shiftKey && S.anchor >= 0) {
      S.sel.clear();
      var a = Math.min(S.anchor, rowIdx), b = Math.max(S.anchor, rowIdx);
      for (var i = a; i <= b; i++) if (S.rows[i] && S.rows[i].type === 'track') S.sel.add(S.rows[i].t.path);
    } else {
      S.sel.clear(); S.sel.add(path); S.anchor = rowIdx;
    }
    renderVisible(); updateRight();
  }
  function forEachSel(fn) {
    S.rows.forEach(function (r) { if (r.type === 'track' && S.sel.has(r.t.path)) fn(r.t); });
  }
  /* V4.4：流媒体播放入口——现解析 URL 后走全局 annieStreamPlay（player.js），
   * 队列快照钉在 S.streamQueue（歌单后续编辑不影响进行中的队列，与 AM _playList 同理）。
   * 歌词在播放确认后拉取，按 state.currentPath 缓存并广播 annie-stream-lyric（FB2K 歌词面板监听重载）。 */
  function playFb2kStreamAt(i, list) {
    list = list || S.tracks;
    var vt = list[i];
    if (!vt || !vt.__stream) return;
    S.streamQueue = list; S.streamIdx = i;
    var song = vt.__stream;
    window.mine.streamSongUrl({ provider: song.provider, quality: S.stQuality, song: song }).then(function (r) {
      if (S.streamQueue !== list || S.streamIdx !== i) return; // 等待期间已切别的歌
      if (!r || !r.playable || !r.url) { stNotify(song.name + '：' + ((r && r.message) || '无法播放')); return; }
      Promise.resolve(window.annieStreamPlay({
        url: r.url, headers: r.headers || null,
        title: song.name, artist: song.artist, album: song.album || '',
        cover: song.cover || '', duration: song.duration ? song.duration / 1000 : 0,
        provider: song.provider, quality: r.quality || '', song: song
      })).then(function (ok) {
        if (ok === false) { stNotify(song.name + '：播放失败，' + (window.__annieLastStreamError || '引擎未接受流地址')); return; }
        renderVisible(); updateRight(); // 播放行高亮/右栏即时迁移（不等首个 position 事件）
        if (window.mine.streamLyric) {
          window.mine.streamLyric({ provider: song.provider, song: song }).then(function (ly) {
            if (!ly || !ly.lrc || !state.currentPath || !state.currentStream) return;
            if (songKeyOf(state.currentStream.song || state.currentStream) !== songKeyOf(song)) return; // 已切歌
            window.__annieStreamLrcByPath = window.__annieStreamLrcByPath || {};
            window.__annieStreamLrcByPath[state.currentPath] = ly.lrc;
            window.__annieStreamTlyByPath = window.__annieStreamTlyByPath || {};
            window.__annieStreamTlyByPath[state.currentPath] = ly.tlyric || '';
            if (window.annieStage && window.annieStage.setLyricText) window.annieStage.setLyricText(ly.lrc, ly.tlyric); // V4.4：译文轨一并注入舞台
            try { document.dispatchEvent(new CustomEvent('annie-stream-lyric', { detail: { path: state.currentPath } })); } catch (e) { }
          }).catch(function () { });
        }
      });
      // 搜索结果常缺封面：异步补齐（行封面 + 右栏）
      if (!song.cover && window.mine.streamGetPic) {
        window.mine.streamGetPic({ provider: song.provider, song: song }).then(function (p) {
          if (p && p.url) { song.cover = p.url; renderVisible(); if (isCurStream(song)) updateRight(); }
        }).catch(function () { });
      }
    }).catch(function (e2) { stNotify('获取播放地址失败：' + (e2.message || e2)); });
  }

  function rowCtxMenu(e, t, trackIdx) {
    if (!S.sel.has(t.path)) { S.sel.clear(); S.sel.add(t.path); renderVisible(); updateRight(); }
    // V4.4：流媒体行右键——播放 / 加到在线歌单 / 从本歌单移除（本地标签/评分/喜爱体系不适用）
    if (t.__stream) {
      var sitems = [['播放', function () { playFb2kStreamAt(trackIdx, S.tracks); }]];
      // V4.4：在线歌单 >8 收敛为二级浮层（防右键菜单被歌单列表顶出屏幕，对齐 AM）
      var splItems = S.spl.map(function (sp) {
        return ['添加到「' + sp.name + '」', function () {
          var songs = []; forEachSel(function (x) { if (x.__stream) songs.push(x.__stream); });
          if (!songs.length) songs.push(t.__stream);
          window.mine.splAdd(sp.id, songs).then(function (r2) {
            if (r2 && Array.isArray(r2.playlists)) { S.spl = r2.playlists; S.splVer++; rebuildTree(); }
            stNotify('已添加 ' + (r2 && r2.added != null ? r2.added : songs.length) + ' 首到「' + sp.name + '」');
          }).catch(function () { });
        }];
      });
      if (splItems.length > 8) sitems.push({ sub: '☁ 加到在线歌单…', items: splItems });
      else splItems.forEach(function (it) { sitems.push(it); });
      sitems.push(['＋ 新建在线歌单', newSpl]);
      if (S.activeList.indexOf('spl:') === 0) {
        var sid0 = S.activeList.slice(4);
        sitems.push('-');
        sitems.push(['从本歌单移除', function () {
          var idxs = []; forEachSel(function (x) { if (x.__stream && x.__splIdx != null) idxs.push(x.__splIdx); });
          if (!idxs.length && t.__splIdx != null) idxs.push(t.__splIdx);
          if (!idxs.length) return;
          window.mine.splRemove(sid0, idxs).then(function (pls) {
            if (Array.isArray(pls)) { S.spl = pls; S.splVer++; rebuildTree(); rebuildRows(); }
          }).catch(function () { });
        }]);
      }
      ctxMenu(e, sitems);
      return;
    }
    var items = [
      ['播放', function () { state.queue = S.tracks; playAt(trackIdx); }],
      ['添加到喜爱 / 取消喜爱', function () { window.mine.toggleFavorite(t.path).then(function (f) { state.favorites = new Set(f); refreshAll(); }); }]
    ];
    // V4.4：本地歌单 >8 收敛为二级浮层（与流媒体侧同机制）
    var plItems = S.playlists.map(function (p) {
      return ['添加到「' + p.name + '」', function () {
        // V4.4：歌单统一到主进程（playlistAdd 内部去重）
        var paths = []; forEachSel(function (x) { paths.push(x.path); });
        window.mine.playlistAdd(p.id, paths).then(function (pls) {
          if (Array.isArray(pls)) S.playlists = pls;
          rebuildTree();
        }).catch(function () { });
      }];
    });
    if (plItems.length > 8) items.push({ sub: '📁 加到播放列表…', items: plItems });
    else plItems.forEach(function (it) { items.push(it); });
    items.push(['查看属性', function () { showProps(t); }]);
    // V4.4：打开文件位置（资源管理器定位并选中该文件）
    items.push(['在文件夹中显示', function () { if (window.mine.showItemInFolder) window.mine.showItemInFolder(t.path); }]);
    items.push(['编辑标签…', function () {
      var paths = []; forEachSel(function (x) { paths.push(x.path); });
      if (window.annieTagEdit) window.annieTagEdit.open(paths.length > 1 ? { paths: paths } : { path: t.path });
    }]);
    items.push(['在线匹配歌词 / 封面…', function () { if (window.annieMatch) window.annieMatch.open({ path: t.path }); }]);
    items.push(['找相似歌曲…', function () { if (window.annieSimilar) window.annieSimilar.open(t.path); }]); // V4.3.16
    items.push([ // V4.3.21：一键电台（种子 + 相似链式续播）
      (window.annieSimilar && annieSimilar.radio.isOn()) ? '📻 关闭电台' : '📻 一键电台',
      function () {
        if (!window.annieSimilar) return;
        if (annieSimilar.radio.isOn()) { annieSimilar.radio.stop(); try { if (typeof proToast === 'function') proToast('📻 电台已关闭'); } catch (e) { } }
        else annieSimilar.radio.start(t.path);
      }]);
    if (S.sel.size > 1) items.push(['批量匹配歌词（' + S.sel.size + ' 首）…', function () {
      var paths = []; forEachSel(function (x) { paths.push(x.path); });
      if (window.annieBatchMatch) window.annieBatchMatch.open(paths);
    }]);
    items.push(['从列表中移除（本次会话）', function () {
      forEachSel(function (x) { S.hiddenPaths.add(x.path); }); S.sel.clear(); rebuildRows();
    }]);
    ctxMenu(e, items);
  }
  /* 右键上下文菜单（V4.4：改单一共享弹层节点 + 一次注册外点关闭，替代「每次新建节点 + 每菜单独挂 document 监听」的反模式。
   * 机制对齐 AM 的 R.pop：节点常驻 #fb2k-root 内（随主题显隐、继承暗色），外点关闭在 build 时统一挂一次。） */
  var ctxPop = null;
  function ensureCtxPop() {
    if (ctxPop) return ctxPop;
    ctxPop = el('div', 'f2-ctx');
    ($('#fb2k-root') || document.body).appendChild(ctxPop);
    // 外点关闭只挂这一次（捕获阶段，点弹层外即关；点弹层内不干预）
    document.addEventListener('pointerdown', function (e) {
      if (ctxPop.classList.contains('on') && !ctxPop.contains(e.target)) closeCtxMenu();
    }, true);
    return ctxPop;
  }
  function closeCtxMenu() { if (ctxPop) ctxPop.classList.remove('on'); }
  /* V4.4：右键菜单二级浮层（歌单 >8 时收敛，对齐 AM buildPopSubMenu）。
   * 子面板挂在菜单项节点内部（仍是 ctxPop 子孙，外点关闭监听不误伤），
   * position:fixed 摆脱父级；右侧放不下自动翻左，上下避让。 */
  function ctxSubMenu(m, label, subItems) {
    var mi = el('div', 'f2-mi f2-mi-sub', label + '（' + subItems.length + '）');
    mi.appendChild(el('span', 'f2-sub-arrow', '▸'));
    var sub = el('div', 'f2-ctx f2-ctx-sub');
    subItems.forEach(function (it) {
      if (it === '-') { sub.appendChild(el('div', 'f2-ctx-sep')); return; }
      var si = el('div', 'f2-mi', it[0]);
      si.onclick = function () { closeCtxMenu(); it[1](); };
      sub.appendChild(si);
    });
    function place() {
      sub.classList.add('on');
      var br = mi.getBoundingClientRect();
      var sw = sub.offsetWidth, sh = sub.offsetHeight;
      var sx = br.right + 2;
      if (sx + sw > innerWidth - 8) sx = br.left - sw - 2; // 右侧放不下翻左
      if (sx < 8) sx = Math.max(8, innerWidth - sw - 8);
      var sy = Math.max(8, Math.min(br.top - 3, innerHeight - sh - 8));
      sub.style.left = sx + 'px';
      sub.style.top = sy + 'px';
    }
    function hide() { sub.classList.remove('on'); }
    mi.onmouseenter = place;
    mi.onclick = function (e) { e.stopPropagation(); if (!sub.classList.contains('on')) place(); };
    mi.onmouseleave = function (e) {
      var to = e.relatedTarget;
      if (to && (to === sub || sub.contains(to))) return;
      hide();
    };
    sub.onmouseleave = function (e) {
      var to = e.relatedTarget;
      if (to && to === mi) return;
      hide();
    };
    mi.appendChild(sub);
    m.appendChild(mi);
  }
  function ctxMenu(e, items) {
    var m = ensureCtxPop();
    m.innerHTML = '';
    items.forEach(function (it) {
      if (it === '-') { m.appendChild(el('div', 'f2-ctx-sep')); return; } // 支持分隔符
      if (it.sub) { ctxSubMenu(m, it.sub, it.items); return; } // V4.4：二级浮层项 {sub:'标题', items:[...]}
      var mi = el('div', 'f2-mi', it[0]);
      mi.onclick = function () { closeCtxMenu(); it[1](); };
      m.appendChild(mi);
    });
    m.classList.add('on');
    // 先显示再量尺寸定位（防内容溢出屏幕）
    var mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.min(e.clientX, innerWidth - mw - 8) + 'px';
    m.style.top = Math.min(e.clientY, innerHeight - mh - 8) + 'px';
  }
  function showProps(t) {
     // V4.4：流媒体虚拟曲目——属性直取 song（无本地文件元数据）
     if (t.__stream) {
       var sg = t.__stream;
       modal('属性', '<b>' + (sg.name || t.name) + '</b><br>艺术家：' + (sg.artist || '-') + '<br>专辑：' + (sg.album || '-')
         + '<br>平台：' + (PLAT_LABEL[sg.provider] || sg.provider || '-')
         + '<br>时长：' + (sg.duration ? fmtHMS(sg.duration / 1000) : '-')
         + '<br>来源：流媒体（联网解析播放）');
       return;
     }
      var m = getMeta(t.path);
      function row(k, v) { return '<div class="f2-meta-row"><span class="k">' + k + '</span><span class="v">' + (v || '-') + '</span></div>'; }
    var html = row('标题', m.title || t.name.replace(/\.[^.]+$/, '')) + row('艺术家', m.artist) + row('专辑', m.album)
      + row('文件名', t.name) + row('文件路径', t.path) + row('时长', m.duration ? fmtHMS(m.duration) : '-')
      + row('格式', (m.codec || '').toUpperCase()) + row('比特率', m.bitrate ? Math.round(m.bitrate / 1000) + ' kbps' : '-')
      + row('采样率', m.sampleRate ? m.sampleRate + ' Hz' : '-') + row('声道', channelsText(m.channels))
      + row('文件大小', fmtSize(m.fileSize)) + row('修改日期', fmtDate(m.mtimeMs || t.mtime));
    modal('属性', html);
  }

  /* ---------- 元数据懒加载（可见行） ---------- */
  var lazyTimer = null;
  function lazyLoadVisibleMeta(start, end) {
    clearTimeout(lazyTimer);
    lazyTimer = setTimeout(function () {
      var paths = [];
      for (var i = start; i < end && i < S.rows.length; i++) {
        var r = S.rows[i];
        // V4.4：跳过 stream:// 伪路径——流媒体曲目没有本地 meta，送 metaFullBatch 会白送 ffmpeg 解析，
        // 且回来后 refreshVisibleRowMeta 的 durationText({path}) 丢 __stream 拿空串覆盖正确时长列
        if (r.type === 'track' && !r.t.__stream && !S.metaCache.has(r.t.path)) paths.push(r.t.path);
      }
      paths = paths.slice(0, 40);
      if (!paths.length) return;
      // V3.1：批量完整 meta 一次 IPC（原 40 次独立 track:meta），先占 pending 位防重入
      paths.forEach(function (p) { S.metaCache.set(p, { pending: true }); });
      window.mine.metaFullBatch(paths).then(function (map) {
        paths.forEach(function (p) {
          var m = S.metaCache.get(p);
          var r = map && map[p];
          if (m && r) Object.assign(m, r);
          if (m) m.pending = false;
        });
        if (window.annieTheme.current !== 'fb2k') return;
        paths.forEach(refreshVisibleRowMeta);
        scheduleRightRefresh(); // 40 个 meta 到达只重建一次右栏
      }).catch(function () {
        paths.forEach(function (p) { var m = S.metaCache.get(p); if (m) m.pending = false; });
      });
    }, 60);
  }
  function refreshVisibleRowMeta(path) {
    if (path && path.indexOf('stream://') === 0) return; // V4.4：流媒体行时长/封面由 trackNode 用 song 数据渲染，不走 metaCache
    var q = R.rows.querySelectorAll('.f2-row');
    for (var i = 0; i < q.length; i++) {
      if (q[i].dataset.path !== path) continue;
      var m = S.metaCache.get(path);
      if (!m) continue;
      var img = q[i].querySelector('.f2-c-cover img');
      if (img && m.cover) img.src = m.cover;
      var time = q[i].querySelector('.f2-c-time');
      if (time && path !== state.currentPath) time.textContent = durationText({ path: path });
    }
  }

  /* ================= 右侧：封面 / 信息 / 歌词 / 频谱 ================= */
  function displayTrack() {
    // 选中优先（与播放行分离）；无选中时跟随播放
    if (S.sel.size) {
      var p = S.sel.values().next().value;
      var r = S.rows.find(function (x) { return x.type === 'track' && x.t.path === p; });
      if (r) return r.t;
      return { path: p, name: p.split(/[\\/]/).pop(), dir: p.slice(0, p.lastIndexOf(p.split(/[\\/]/).pop())) };
    }
    if (state.currentPath) {
      // V4.4：播放流媒体时右栏跟随——用 currentStream 的 song 拼虚拟曲目（currentPath 是真实 URL，getMeta 不可读）
      var cs = state.currentStream;
      if (cs) {
        var csg = cs.song || { name: cs.title, artist: cs.artist, album: cs.album, provider: cs.provider, cover: cs.cover, duration: (cs.duration || 0) * 1000 };
        return { __stream: csg, path: state.currentPath, name: cs.title || csg.name || '未知曲目', dir: '' };
      }
      return { path: state.currentPath, name: (state.currentPath || '').split(/[\\/]/).pop(), dir: '' };
    }
    return null;
  }

  function updateRight() {
    if (S.rightCollapsed || !R.cover) return;
    var t = displayTrack();
    if (!t) {
      R.cover.src = PLACEHOLDER; R.cover.classList.remove('loading');
      R.songName.textContent = ''; R.formatLine.textContent = ''; R.meta.innerHTML = '';
      return;
    }
    // V4.4：流媒体虚拟曲目——信息直取 song（无本地文件元数据；封面 http 走代理）
    if (t.__stream) {
      var sg = t.__stream;
      R.cover.classList.remove('loading');
      setStreamCover(R.cover, sg.cover);
      R.songName.textContent = sg.name || t.name;
      R.formatLine.textContent = PLAT_LABEL[sg.provider] || sg.provider || '流媒体';
      var srows = [
        ['专辑', sg.album || '-'], ['艺术家', sg.artist || '-'], ['标题', sg.name || '-'],
        ['平台', PLAT_LABEL[sg.provider] || sg.provider || '-'],
        ['持续时间', sg.duration ? fmtHMS(sg.duration / 1000) : '-'],
        ['来源', '流媒体（联网解析播放）']
      ];
      R.meta.innerHTML = srows.map(function (r) {
        return '<div class="f2-meta-row"><span class="k">' + r[0] + '</span><span class="v" title="' + String(r[1]).replace(/"/g, '&quot;') + '">' + r[1] + '</span></div>';
      }).join('');
      return;
    }
    var m = getMeta(t.path);
    R.cover.classList.toggle('loading', !!m.pending);
    R.cover.src = m.cover || PLACEHOLDER;
    R.songName.textContent = m.title || t.name.replace(/\.[^.]+$/, '');
    var baseFmt = m.codec
      ? m.codec.toUpperCase() + ' | ' + (m.bitrate ? Math.round(m.bitrate / 1000) + 'K' : '-') + ' | ' + (m.sampleRate || '-') + 'Hz'
      : '';
    // Pro beat0.0.1：Bit-perfect 直通状态行（绿点=直通 / 黄点+原因）
    if (S.format && t.path === state.currentPath) {
      var d = S.format;
      var inFmt = d.bitDepth === 1 ? 'DSD' : (d.requestedRate / 1000) + 'kHz/' + (d.bitDepth || '?') + 'bit';
      R.formatLine.innerHTML = (baseFmt ? baseFmt + '<br>' : '')
        + '<span class="f2-bp ' + (d.bitPerfect ? 'ok' : 'warn') + '" title="'
        + (d.bitPerfect ? 'Bit-perfect 源码率直通' : String(d.reason || '非直通').replace(/"/g, '&quot;')) + '">●</span> '
        + inFmt + ' → ' + (d.outFormat || '-');
    } else {
      R.formatLine.textContent = baseFmt;
    }
    var dirName = (t.dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
    var rows = [
      ['专辑', m.album || '-'], ['艺术家', m.artist || '-'], ['标题', m.title || '-'],
      ['文件名', t.name], ['文件夹名', dirName || '-'], ['文件路径', t.path],
      ['子曲目索引', '1'], ['文件大小', fmtSize(m.fileSize)], ['修改日期', fmtDate(m.mtimeMs || t.mtime)],
      ['持续时间', m.duration ? fmtHMS(m.duration) : '-'], ['比特率', m.bitrate ? Math.round(m.bitrate / 1000) + ' kbps' : '-'],
      ['采样比特', m.bitsPerSample ? m.bitsPerSample + ' bits' : '-'], ['声道', channelsText(m.channels)]
    ];
    R.meta.innerHTML = rows.map(function (r) {
      return '<div class="f2-meta-row"><span class="k">' + r[0] + '</span><span class="v" title="' + String(r[1]).replace(/"/g, '&quot;') + '">' + r[1] + '</span></div>';
    }).join('');
  }

  /* ---------- 歌词 ---------- */
  /* 逐字歌词提取（与 stage-adapter 同款解析；无词标签返回 null，普通 LRC 行为不变）
   * 支持 <mm:ss.xxx>文字（绝对）与 <相对ms,时长ms>文字（lxlyric）两种标签 */
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
  /* 用行元素实际字体测每个词的字宽占比（缓存到节点，字体/文本变化时重算） */
  /* 逐词 span 卡拉OK：每词独立双层，词间自然折行；每 tick 只刷当前行 */
  function karaPaintLine(node, now) {
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
  function karaResetLine(node) {
    var arr = node._karaWords;
    for (var i = 0; i < arr.length; i++) arr[i].hi.style.width = '0%';
  }
  function parseLrc(text) {
    var map = new Map();
    text.split(/\r?\n/).forEach(function (line) {
      // lxlyric 行格式：[起始ms,时长ms]文本（行内 <相对ms,时长ms> 词标签走同一提取）
      var lx = /^\s*\[(\d+),(\d+)\](.*)$/.exec(line);
      if (lx) {
        var lt = (parseInt(lx[1], 10) || 0) / 1000;
        var lraw = (lx[3] || '').trim();
        var lex = karaExtractWords(lraw, lt);
        if (!map.has(lt)) map.set(lt, { t: lt, txt: lex ? lex.text : lraw, tly: '', words: lex ? lex.words : null });
        return;
      }
      var re = /\[(\d+):(\d+(?:\.\d+)?)\]/g, mm, last = 0, times = [];
      while ((mm = re.exec(line))) { times.push(+mm[1] * 60 + (+mm[2])); last = re.lastIndex; }
      if (!times.length) return;
      var raw = line.slice(last).trim();
      // 逐字：提取 <词时间> 标签，txt 清洗为纯文本
      var ex = karaExtractWords(raw, times[times.length - 1]);
      var txt = ex ? ex.text : raw;
      var words = ex ? ex.words : null;
      times.forEach(function (t) {
        if (!map.has(t)) map.set(t, { t: t, txt: txt, tly: '', words: words ? words.slice() : null });
        else { map.get(t).tly = txt; } // 同时间戳第二行视为译文
      });
    });
    return [...map.values()].sort(function (a, b) { return a.t - b.t; });
  }
  function loadLyrics(path) {
    S.lyrPath = path; S.lyrLines = null; S.lyrCur = -1;
    if (!path) { renderLyrics(); return; }
    // V4.4：流媒体歌词——读 streaming 层按 currentPath 缓存的 LRC（annie-stream-lyric 事件到达后重载；
    // 译文轨拼接进原文，parseLrc 同时间戳第二行自动并轨为 tly）
    if (path.indexOf('http') === 0) {
      var lrc = window.__annieStreamLrcByPath && window.__annieStreamLrcByPath[path];
      var tly = window.__annieStreamTlyByPath && window.__annieStreamTlyByPath[path];
      S.lyrLines = lrc ? parseLrc(lrc + (tly ? '\n' + tly : '')) : null;
      renderLyrics();
      return;
    }
    window.mine.lyrics(path).then(function (r) {
      if (S.lyrPath !== path) return;
      S.lyrLines = (r && r.ok) ? parseLrc(r.text) : null;
      renderLyrics();
    }).catch(function () { renderLyrics(); });
  }
  /* 逐字歌词总开关（设置中心·歌词页，LS annieplayer.karaoke，默认开） */
  function karaOn() { try { return localStorage.getItem('annieplayer.karaoke') !== '0'; } catch (e) { return true; } }
  // 开关变更后重建歌词行（撤下/恢复逐词扫过）
  document.addEventListener('annie-karaoke-changed', function () { renderLyrics(); });
  function renderLyrics() {
    if (!R.lyrLines) return;
    R.lyrLines.innerHTML = '';
    if (!S.lyrLines || !S.lyrLines.length) {
      R.lyrLines.appendChild(el('div', 'f2-lyr', '（无歌词）'));
    } else {
      S.lyrLines.forEach(function (l, i) {
        var d = el('div', 'f2-lyr');
        d.dataset.i = i;
        if (l.words && l.words.length && l.txt && karaOn()) {
          // 逐词 span（词间自然折行；词内双层按进度裁切扫过）
          d.classList.add('kara');
          var wspans = [];
          l.words.forEach(function (w) {
            var ws = el('span', 'kara-w');
            var base = el('span', 'kara-wb'); base.textContent = w.text;
            var hi = el('span', 'kara-wh'); hi.textContent = w.text;
            ws.appendChild(base); ws.appendChild(hi);
            d.appendChild(ws);
            wspans.push({ w: w, hi: hi });
          });
          d._karaWords = wspans;
        } else {
          d.appendChild(document.createTextNode(l.txt || ' '));
        }
        if (l.tly) d.appendChild(el('span', 'tly', l.tly));
        // V4.4：点击歌词行 seek 到该行（与 AM 歌词面板一致；seekTo 含 CUE 偏移 + seekPending 保护）
        d.style.cursor = 'pointer';
        d.title = '点击跳转到此句';
        d.onclick = function () { seekTo(l.t); };
        R.lyrLines.appendChild(d);
      });
    }
    // 歌词为异步加载：渲染完成后必须刷新可见性，否则歌词框一直 display:none
    S.lyrCur = -1;
    updateLyricsVisibility();
    tickLyrics();
  }
  function tickLyrics() {
    if (!S.lyrLines || !R.lyrLines) return;
    var cur = -1;
    // V3.5.15：歌词偏移（按曲记忆，与 AM/桌面歌词同一 Store）
    var epos = window.annieLyrOff ? window.annieLyrOff.pos(S.lyrPath || state.currentPath, S.pos) : S.pos;
    for (var i = 0; i < S.lyrLines.length; i++) if (S.lyrLines[i].t <= epos + 0.15) cur = i; else break;
    // 逐词扫过：当前行每 tick 更新各词裁切宽度（不吃下方 line-change 早退）
    var q = R.lyrLines.querySelectorAll('.f2-lyr');
    if (cur >= 0 && q[cur] && q[cur]._karaWords) karaPaintLine(q[cur], epos);
    if (cur === S.lyrCur) return;
    // 行切换：重置上一行逐词宽度，避免残留
    if (S.lyrCur >= 0 && q[S.lyrCur] && q[S.lyrCur]._karaWords) karaResetLine(q[S.lyrCur]);
    S.lyrCur = cur;
    for (var j = 0; j < q.length; j++) q[j].classList.toggle('cur', j === cur);
    if (cur >= 0 && q[cur]) {
      var box = R.lyrLines;
      box.scrollTop = q[cur].offsetTop - box.clientHeight / 2 + 16;
    }
  }
  function updateLyricsVisibility() {
    if (R.lyrBox) R.lyrBox.style.display = (S.playing && S.lyrLines && S.lyrLines.length) ? '' : 'none';
  }

  /* ---------- 频谱（真实 FFT 帧，来自分析管线） ----------
   * 分析管线是离线全速解码（远快于播放），帧按时间顺序推送（46ms/帧）。
   * 必须缓存全部帧、按当前播放位置取帧显示，而不是取"最新一帧"——
   * 否则解码完成后频谱冻结在歌曲结尾帧，与实际播放内容无关。 */
  var SPEC_FRAME_SEC = 2048 / 44100; // analyzer HOP / SAMPLE_RATE
  window.mine.onAnalyzeEvent(function (p) {
    if (p.type !== 'frames' || !p.frames || !p.count) return;
    // 仅 FB2K 主题激活且频谱开启时缓存 FFT 帧；其他主题直接丢弃（每首数 MB，切歌才清）
    if (window.annieTheme.current !== 'fb2k' || !S.specOn) return;
    if (p.gen !== S.specGen) { S.specGen = p.gen; S.specFrames = []; } // 新一曲的分析：重置缓存
    var arr = new Uint8Array(p.frames);
    var bands = Math.floor(arr.length / p.count);
    if (!bands) return;
    if (!S.specFrames) S.specFrames = [];
    for (var f = 0; f < p.count; f++) S.specFrames.push(arr.slice(f * bands, (f + 1) * bands));
  });
  var specRAF = 0;
  function specLoop() {
    // 非 FB2K 主题：不再排下一帧，循环停摆（切回 fb2k 时由 startSpecLoop 重启）
    if (window.annieTheme.current !== 'fb2k') { specRAF = 0; return; }
    specRAF = requestAnimationFrame(specLoop);
    if (!S.playing || !S.specOn || S.rightCollapsed || !R.spec) return;
    var cv = R.spec, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    // 高 DPI 适配：canvas 物理像素 = CSS 像素 × devicePixelRatio，坐标系缩放回去（防高分屏频谱柱模糊）
    var dpr = window.devicePixelRatio || 1;
    var pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 按当前播放位置取对应的 FFT 帧（误差 ≤ 帧长 46ms）
    var bands = null;
    if (S.specFrames && S.specFrames.length) {
      var fi = Math.floor(S.pos / SPEC_FRAME_SEC);
      bands = S.specFrames[Math.min(Math.max(fi, 0), S.specFrames.length - 1)];
    }
    var N = 36, bw = W / N;
    if (!S.specSmooth || S.specSmooth.length !== N) S.specSmooth = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var v = 0;
      if (bands) {
        var b0 = Math.floor(i / N * bands.length), b1 = Math.max(b0 + 1, Math.floor((i + 1) / N * bands.length));
        for (var b = b0; b < b1; b++) v += bands[b];
        v = v / (b1 - b0) / 255;
      }
      S.specSmooth[i] = Math.max(v, S.specSmooth[i] * 0.86); // 峰值缓降
      var h = Math.max(1, S.specSmooth[i] * (H - 4));
      ctx.fillStyle = S.dark ? '#5c6478' : '#444'; // V1.1.2：暗色下频谱柱提亮
      ctx.fillRect(i * bw + 1, H - h, bw - 2, h);
    }
  }
  /* 防重入启动：循环已在跑（specRAF 非 0）时不重复排帧 */
  function startSpecLoop() {
    if (!specRAF && window.annieTheme.current === 'fb2k') specRAF = requestAnimationFrame(specLoop);
  }
  function updateSpecVisibility() {
    if (R.specBox) R.specBox.style.display = (S.playing && S.specOn) ? '' : 'none';
  }

  /* ================= 标题栏 ================= */
  function updateTitle() {
    var path = state.currentPath;
    if (!path || !S.playing) {
      R.title.textContent = 'AnniePlayer V' + (S.appVer || ''); // V4.4：用动态版本号，原写死 'V3' 每发版都错
      R.title.classList.remove('playing');
      return;
    }
    var m = path.indexOf('http') === 0 ? null : getMeta(path);
    var f = S.format || {};
    var title = (m && m.title) || $('#thumb-title').textContent || path.split(/[\\/]/).pop();
    var artist = (m && m.artist && m.artist !== '未知艺术家') ? m.artist : ($('#thumb-artist').textContent.split(' · ')[0] || '');
    var album = (m && m.album) || '';
    var codec = (f.codec || (m && m.codec) || '').toUpperCase();
    var parts = [title + (artist ? ' - ' + artist : '')];
    if (album) parts.push(album);
    if (codec) parts.push(codec, isLossless(codec) ? 'lossless' : 'lossy');
    if (m && m.channels) parts.push(channelsText(m.channels));
    var bits = f.bitDepth || (m && m.bitsPerSample);
    if (bits) parts.push(bits + ' bits');
    if (m && m.bitrate) parts.push(Math.round(m.bitrate / 1000) + ' kbps');
    var rate = f.requestedRate || (m && m.sampleRate);
    if (rate) parts.push(rate + ' Hz');
    R.title.textContent = parts.join(' | ');
    R.title.classList.add('playing');
  }

  /* ================= 传输 / 进度 / 音量 ================= */
  function transportPlayPause() {
    if (state.currentPath) window.mine.engine(state.playing ? 'pause' : 'resume').catch(function () { });
    else if (S.tracks.length) { state.queue = S.tracks; playAt(0); }
  }
  /* 当前曲目在 FB2K 列表中的位置（按路径定位，避免被其它视图的队列覆写干扰） */
  function fb2kQueueIndex() {
    var i = S.trackPathIdx ? S.trackPathIdx.get(state.currentPath) : undefined; // SVLX 同步：O(1)
    return i === undefined ? -1 : i;
  }
  /* V4.4：当前播放流媒体在 FB2K 队列快照中的位置（按歌曲身份匹配，编辑歌单后引用失效也能兜底） */
  function fb2kStreamIndex() {
    if (!state.currentStream || !S.streamQueue) return -1;
    var cur = songKeyOf(state.currentStream.song || state.currentStream);
    for (var i = 0; i < S.streamQueue.length; i++) {
      var vt = S.streamQueue[i];
      if (vt && vt.__stream && songKeyOf(vt.__stream) === cur) return i;
    }
    return -1;
  }
  /* 流媒体下一首（联动全局播放模式，与 AM nextStream 同语义；到列表末尾自然停止） */
  function streamNextFb2k() {
    var list = S.streamQueue;
    if (!list || !list.length) return;
    var i = fb2kStreamIndex();
    if (i < 0) return;
    var m = window.anniePlayMode ? window.anniePlayMode.get() : 'list-seq';
    if (m === 'repeat-one') { playFb2kStreamAt(i, list); return; }
    if (m === 'list-rand' || m === 'all-rand') {
      if (list.length > 1) { var ri; do { ri = Math.floor(Math.random() * list.length); } while (ri === i); playFb2kStreamAt(ri, list); }
      else playFb2kStreamAt(i, list);
      return;
    }
    if (i + 1 < list.length) { playFb2kStreamAt(i + 1, list); return; }
    // 播放定时·播完当前列表停止（与 AM 一致）
    var t = window.annieSleepTimer && window.annieSleepTimer.get();
    if (t && t.type === 'queue') {
      window.annieSleepTimer.clear();
      stNotify('当前列表已播完，已停止');
    }
  }
  function transportNext() {
    // V4.4：流媒体优先——FB2K 队列接管；非 FB2K 发起的流交还 streaming 层队列
    if (state.currentStream) {
      if (S.streamQueue && fb2kStreamIndex() >= 0) { streamNextFb2k(); return; }
      if (window.annieStream) window.annieStream.playNext();
      return;
    }
    // 播放模式接管（随机/单曲循环等，与 AM/粒子舞台一致；本地队列上下文已在 playAt 时同步）
    if (window.annieNextByMode && window.annieNextByMode()) return;
    var i = fb2kQueueIndex();
    if (i >= 0 && i + 1 < S.tracks.length) { state.queue = S.tracks; playAt(i + 1); }
  }
  function transportPrev() {
    // V4.4：流媒体上一首（>3s 回开头，与 AM prevStream 同语义）
    if (state.currentStream) {
      if (S.streamQueue) {
        var si = fb2kStreamIndex();
        if (si >= 0) {
          if (S.pos > 3) { seekTo(0); return; }
          if (si > 0) playFb2kStreamAt(si - 1, S.streamQueue);
          return;
        }
      }
      if (window.annieStream) window.annieStream.playPrev(S.pos);
      return;
    }
    var i = fb2kQueueIndex();
    if (i < 0) return;
    state.queue = S.tracks;
    playAt(S.pos > 3 ? i : Math.max(0, i - 1));
  }
  function updateTransport() {
    R.btnPlay.innerHTML = S.playing ? SVG.pause : SVG.play;
    R.slider.classList.toggle('idle', !state.currentPath);
  }

  function tickProgress() {
    if (state.seeking || state.seekPending) return; // V1.1.4：seek 保护——旧 position 不拉回
    var pct = S.dur > 0 ? Math.min(100, S.pos / S.dur * 100) : 0;
    R.fill.style.width = pct + '%';
    R.knob.style.left = pct + '%';
    R.tCur.textContent = fmtHMS(S.pos);
    R.tTotal.textContent = fmtHMS(S.dur);
    // 播放行负数倒计时
    var pr = R.rows.querySelector('.f2-row.playing .f2-c-time');
    if (pr && S.dur > 0) pr.textContent = fmtCountdown(S.dur - S.pos);
  }
  /* 统一 seek 入口（含 CUE 分轨偏移换算 + seekPending 保护）：进度条松手与歌词点击行共用 */
  function seekTo(sec) {
    if (!state.currentPath) return;
    state.seekPending = true;
    state.seekTarget = sec;
    clearTimeout(state.seekTimer);
    state.seekTimer = setTimeout(function () { state.seekPending = false; }, 10000);
    window.mine.engine('seek', { seconds: (state.currentCue ? state.currentCue.start : 0) + sec }, 30000).catch(function () { });
  }
  function bindSlider() {
    R.slider.addEventListener('pointermove', function (e) {
      if (!S.dur) { R.sliderTip.classList.remove('show'); return; }
      var r = R.slider.getBoundingClientRect();
      var pct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      R.sliderTip.textContent = fmtHMS(pct * S.dur);
      R.sliderTip.style.left = (pct * 100) + '%';
      R.sliderTip.classList.add('show');
    });
    R.slider.addEventListener('pointerleave', function () { R.sliderTip.classList.remove('show'); });
    R.slider.addEventListener('pointerdown', function (e) {
      if (!state.currentPath || !S.dur) return;
      state.seeking = true;
      var sec = 0;
      var seek = function (ev) {
        var r = R.slider.getBoundingClientRect();
        var pct = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        sec = pct * S.dur;
        R.fill.style.width = (pct * 100) + '%';
        R.knob.style.left = (pct * 100) + '%';
        R.tCur.textContent = fmtHMS(sec);
      };
      seek(e);
      var up = function () {
        window.removeEventListener('pointermove', seek);
        window.removeEventListener('pointerup', up);
        state.seeking = false;
        if (typeof proToast === 'function') proToast('正在跳转…'); // 网络流 seek 需重新拉流（数秒）
        seekTo(sec);
      };
      window.addEventListener('pointermove', seek);
      window.addEventListener('pointerup', up);
    });
  }

  var mutePrev = 1;
  // 主题独立：音量直接读写共享核心 state.library.volume，不依赖隐藏的旧底栏 #volume DOM
  function volGain() {
    var v = (window.state && typeof window.state.library === 'object' && window.state.library != null) ? window.state.library.volume : null;
    if (v == null || !isFinite(v)) v = 0.8;
    return Math.min(1, Math.max(0, v));
  }
  function setVolumeUI(g) {
    g = Math.min(1, Math.max(0, g));
    if (window.state && window.state.library) window.state.library.volume = g;
    try { window.mine.engine('volume.set', { gain: g }); } catch (e) { }
    if (window.annieStage && window.annieStage.setVolume) window.annieStage.setVolume(g);
    try { window.mine.saveSettings({ volume: g }); } catch (e) { }
    refreshVolume();
  }
  function toggleMute() {
    var g = volGain();
    if (g > 0) { mutePrev = g; setVolumeUI(0); } else setVolumeUI(mutePrev || 1);
  }
  function refreshVolume() {
    var g = volGain();
    R.volFill.style.width = (g * 100) + '%';
    R.volKnob.style.left = (g * 100) + '%';
    R.volIcon.innerHTML = g > 0 ? SVG.vol : SVG.mute;
    R.volSlider.title = '音量 ' + Math.round(g * 100) + '%';
  }
  function bindVolume() {
    R.volSlider.addEventListener('pointerdown', function (e) {
      var set = function (ev) {
        var r = R.volSlider.getBoundingClientRect();
        var g = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        setVolumeUI(g);
      };
      set(e);
      var up = function () {
        window.removeEventListener('pointermove', set);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', set);
      window.addEventListener('pointerup', up);
    });
  }

  /* ================= 视图模式 ================= */
  function setViewMode(v) {
    S.viewMode = v;
    S.rowH = v === 'cover' ? 48 : 32;
    LS.set('annieplayer.fb2k.viewMode', v);
    refreshViewBtns(); rebuildRows();
  }
  function refreshViewBtns() {
    if (!R.viewBtns) return;
    Object.keys(R.viewBtns).forEach(function (k) { R.viewBtns[k].classList.toggle('active', k === S.viewMode); });
  }

  /* ================= 栏宽拖拽 ================= */
  function makeResizer(side) {
    var r = el('div', 'f2-resizer');
    r.addEventListener('pointerdown', function (e) {
      r.classList.add('on');
      var x0 = e.clientX;
      var w0 = side === 'left' ? S.leftW : S.rightW;
      var move = function (ev) {
        var dx = ev.clientX - x0;
        if (side === 'left') {
          S.leftW = Math.max(180, Math.min(400, w0 + dx));
          R.main.style.setProperty('--f2-left', S.leftW + 'px');
        } else {
          S.rightW = Math.max(220, Math.min(420, w0 - dx));
          R.main.style.setProperty('--f2-right', S.rightW + 'px');
        }
      };
      var up = function () {
        r.classList.remove('on');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        LS.set('annieplayer.fb2k.leftW', S.leftW);
        LS.set('annieplayer.fb2k.rightW', S.rightW);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });
    return r;
  }

  /* ================= 引擎事件 ================= */
  function bindGlobal() {
    window.mine.onEngineEvent(function (event, d) {
      if (event === 'position') {
        // Pro：CUE 分轨——位置/时长按分轨窗口显示，到分轨终点自动下一曲
        var cue = state.currentCue;
        if (cue) {
          S.dur = cue.end != null ? cue.end - cue.start : (d.duration || 0) - cue.start;
          S.pos = Math.max(0, d.seconds - cue.start);
          if (cue.end != null && d.seconds >= cue.end - 0.12) { transportNext(); return; }
        } else {
          S.pos = d.seconds;
          if (d.duration) S.dur = d.duration;
        }
        if (state.seekPending && d.seconds >= state.seekTarget - 0.5) { // V1.1.4：seek 完成
          state.seekPending = false;
          clearTimeout(state.seekTimer);
        }
        if (state.currentPath !== S.lastPath) onTrackChanged();
        tickProgress(); tickLyrics();
      } else if (event === 'state') {
        S.playing = d.state === 'playing';
        updateTransport(); updateTitle();
        updateLyricsVisibility(); updateSpecVisibility();
        if (d.state === 'stopped') { S.pos = 0; tickProgress(); }
      } else if (event === 'format') {
        S.format = d;
        updateTitle();
        updateRight(); // Pro：Bit-perfect 状态行刷新
      }
    });
    // 键盘快捷键（仅 FB2K 主题激活且非输入状态时）
    document.addEventListener('keydown', function (e) {
      if (window.annieTheme.current !== 'fb2k') return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.code === 'Space') { e.preventDefault(); transportPlayPause(); }
      else if (e.ctrlKey && e.code === 'ArrowRight') { e.preventDefault(); transportNext(); }
      else if (e.ctrlKey && e.code === 'ArrowLeft') { e.preventDefault(); transportPrev(); }
      else if (e.ctrlKey && e.code === 'KeyS') { e.preventDefault(); window.mine.engine('stop').catch(function () { }); }
      else if (e.ctrlKey && e.code === 'ArrowUp') { e.preventDefault(); setVolumeUI(Math.min(1, volGain() + 0.05)); }
      else if (e.ctrlKey && e.code === 'ArrowDown') { e.preventDefault(); setVolumeUI(Math.max(0, volGain() - 0.05)); }
      else if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); setDarkMode(!S.dark); } // V1.1.2 暗色切换
      else if (e.key === 'F5') { e.preventDefault(); $('#btn-rescan').click(); }
      else if (e.key === 'Delete') {
        forEachSel(function (t) { S.hiddenPaths.add(t.path); });
        S.sel.clear(); rebuildRows();
      }
    });
    startSpecLoop();
  }

  function onTrackChanged() {
    S.lastPath = state.currentPath;
    var path = S.lastPath;
    S.dur = state.duration || S.dur;
    S.specFrames = null; S.specGen = -1; // 切歌后等待新一曲的分析帧
    // 切歌后丢弃失效选中：右侧信息栏"选中优先"，若残留旧选中会显示上一首的封面/信息
    // （双击播放的行本身即选中行，含当前路径时不受影响）
    if (S.sel.size && (!path || !S.sel.has(path))) { S.sel.clear(); S.anchor = -1; }
    renderVisible();          // 播放行高亮迁移
    updateRight();            // 无选中时跟随播放
    updateTitle();
    loadLyrics(path); // V4.4：http（流媒体）也进 loadLyrics——内部读流歌词缓存
    if (path && path.indexOf('http') !== 0) { var m = getMeta(path); if (m && m.duration) S.dur = m.duration; }
    updateLyricsVisibility();
  }

  // V4.4：流媒体歌词到达广播 → FB2K 歌词面板重载（AM 歌词面板同款事件）
  document.addEventListener('annie-stream-lyric', function (e) {
    if (!S.mounted || window.annieTheme.current !== 'fb2k') return;
    var p = e.detail && e.detail.path;
    if (p && p === state.currentPath) loadLyrics(p);
  });

  // 在线匹配落盘后：若正在播放该文件，重载歌词并刷新右栏（封面按 mtime 自动失效）
  document.addEventListener('annie-local-media-updated', function (e) {
    var p = e.detail && e.detail.path;
    if (!p || !S.mounted) return;
    if (state.currentPath === p) { loadLyrics(p); scheduleRightRefresh(); }
  });

  /* ================= 挂载 / 刷新 ================= */
  function refreshAll() {
    if (!S.mounted) return;
    // 主题切走期间发生过切歌：同步清理失效选中，保证信息栏跟随当前播放曲目
    if (state.currentPath !== S.lastPath && S.sel.size
      && (!state.currentPath || !S.sel.has(state.currentPath))) { S.sel.clear(); S.anchor = -1; }
    S.lastPath = state.currentPath;
    S.pos = state.position || 0;
    S.dur = state.duration || 0;
    S.playing = !!state.playing;
    S.rowH = S.viewMode === 'cover' ? 48 : 32;
    rebuildTree(); rebuildRows();
    updateRight(); updateTransport(); updateTitle(); refreshVolume();
    if (state.currentPath) loadLyrics(state.currentPath); // V4.4：http（流媒体）走歌词缓存分支
    else { S.lyrLines = null; renderLyrics(); }
    updateLyricsVisibility(); updateSpecVisibility();
    tickProgress();
  }

  /* V1.1.2：FB2K 暗色模式（持久化 + 按钮/快捷键/设置面板三入口，切换即时无闪烁） */
  function setDarkMode(on) {
    S.dark = !!on;
    LS.set('annieplayer.fb2k.dark', S.dark);
    var root = $('#fb2k-root');
    if (root) root.classList.toggle('f2-dark', S.dark);
    if (R.btnDark) {
      R.btnDark.innerHTML = S.dark ? SVG.sun : SVG.moon;
      R.btnDark.classList.toggle('active', S.dark);
    }
    document.dispatchEvent(new CustomEvent('annie-f2-dark-changed', { detail: { dark: S.dark } }));
  }
  /* Pro beat0.0.1：命令面板入口 */
  window.annieFb2kDark = { toggle: function () { setDarkMode(!S.dark); } };

  /* V1.1.1：切回 FB2K 主题时，树展开并选中播放文件所在文件夹，列表滚动到播放行；
   * 流媒体曲目不入库则保持当前视图
   * beta0.0.3 移植：O(1) 行索引 + 平滑滚动 + 播放行高亮闪烁 */
  var normP = function (p) { return String(p || '').replace(/\//g, '\\').toLowerCase(); };
  /* 滚动列表到指定路径行（虚拟滚动：按行号定位 scrollTop） */
  function scrollToRowPath(cp, smooth) {
    var i = S.rowPathIdx ? S.rowPathIdx.get(cp) : undefined;
    if (i === undefined) return false;
    var top = Math.max(0, i * S.rowH - R.list.clientHeight / 2);
    if (smooth && R.list.scrollTo) R.list.scrollTo({ top: top, behavior: 'smooth' });
    else R.list.scrollTop = top;
    renderVisible();
    if (smooth) setTimeout(function () { flashPlayingRowFb2k(0); }, 350);
    return true;
  }
  /* 播放行高亮闪烁（2 次脉冲动画，最多重试 4 次等待行渲染） */
  function flashPlayingRowFb2k(attempts) {
    var node = R.rows && R.rows.querySelector('.f2-row.playing');
    if (node) {
      node.classList.remove('locate-flash');
      void node.offsetWidth; // 重启动画
      node.classList.add('locate-flash');
      setTimeout(function () { node.classList.remove('locate-flash'); }, 2000);
    } else if ((attempts || 0) < 4) {
      setTimeout(function () { flashPlayingRowFb2k((attempts || 0) + 1); }, 300);
    }
  }
  function locatePlayingFb2k(smooth) {
    var cp = state.currentPath;
    if (!cp) return;
    var inLib = (typeof libHas === 'function') ? libHas(cp)
      : state.library.tracks.some(function (t) { return t.path === cp; });
    if (!inLib) return;
    var dir = cp.replace(/[\\/][^\\/]+$/, '');
    var nd = normP(dir);
    var targetPath = null;
    var expandTo = function (nodes) {
      for (var i = 0; i < nodes.length; i++) {
        var np = normP(nodes[i].path);
        if (nd === np) targetPath = nodes[i].path; // 树节点真实路径（键名需精确一致）
        if (nd === np || nd.indexOf(np + '\\') === 0) {
          S.treeExpanded.add(nodes[i].path);
          expandTo([...nodes[i].children.values()]);
        }
      }
    };
    expandTo(buildFolderTree());
    if (!targetPath) return; // 不在任何曲库文件夹下（如临时文件），保持当前视图
    S.activeList = 'folder:' + targetPath;
    rebuildTree();
    rebuildRows();
    updateRight();
    updateTitle();
    scrollToRowPath(cp, smooth);
    // 大列表走 Worker 异步排序时，行模型稍后才就绪，补一次定位
    if (smooth) setTimeout(function () { scrollToRowPath(cp, true); }, 450);
    else setTimeout(function () { scrollToRowPath(cp); }, 450);
  }
  /* beta0.0.3 移植：一键定位入口（平滑滚动 + 高亮） */
  window.annieFb2kLocate = function () { locatePlayingFb2k(true); };
  document.addEventListener('annie-theme-changed', function (e) {
    if (e.detail && e.detail.theme === 'fb2k') { locatePlayingFb2k(); startSpecLoop(); }
  });

  window.annieFb2k = {
    mount: function () {
      if (!S.mounted) { build(); S.mounted = true; }
      initPlaylists(); // V4.4：歌单统一从主进程读取（含 localStorage 旧数据一次性迁移）
      initSpl(); // V4.4：在线歌单从主进程 streamPlaylists 读取（与 AM 同一份）
      refreshAll();
      startSpecLoop(); // 切回 FB2K 主题时重启频谱循环（内部防重入）
    },
    refresh: refreshAll,
    specWanted: function () { return !!S.specOn; }, // player.js 切歌时据此决定是否为 FB2K 频谱跑 FFT 分析
    isDark: function () { return S.dark; },          // V1.1.2
    setDark: function (on) { setDarkMode(on); }      // V1.1.2
  };

  /* V4.4：流媒体自然结束续播接管（仿 AM patchStreamPlayNext 的链式包装）。
   * player.js 在引擎 ended 时调 window.annieStream.playNext()——此处拦截：
   * 仅当当前流来自 FB2K 队列快照时接管（含单曲循环 N 遍定时，与 AM 一致），否则交还原逻辑链。 */
  (function patchFb2kStreamPlayNext() {
    if (!window.annieStream || window.annieStream.__fb2kPatched) return;
    var orig = window.annieStream.playNext;
    window.annieStream.playNext = function () {
      if (!(window.annieTheme && annieTheme.current === 'fb2k' && state.currentStream
          && S.streamQueue && fb2kStreamIndex() >= 0)) { if (orig) orig(); return; }
      // V3.5.8：播放定时·单曲循环 N 遍（在线播放，与 AM 一致）
      var t = window.annieSleepTimer && window.annieSleepTimer.get();
      if (t && t.type === 'repeatN') {
        t.played++;
        if (t.played < t.total) { playFb2kStreamAt(fb2kStreamIndex(), S.streamQueue); return; }
        window.annieSleepTimer.clear();
        stNotify('单曲循环 ' + t.total + ' 遍已播完，已停止');
        return;
      }
      streamNextFb2k();
    };
    window.annieStream.__fb2kPatched = true;
  })();

  // PlayerCore 的列表/树重绘钩子：曲库变化时同步 FB2K 视图
  var origRCV = window.renderCurrentView;
  if (typeof origRCV === 'function') {
    window.renderCurrentView = function () {
      origRCV.apply(this, arguments);
      if (window.annieTheme && window.annieTheme.current === 'fb2k') refreshAll();
    };
  }
  var origRFT = window.renderFolderTree;
  if (typeof origRFT === 'function') {
    window.renderFolderTree = function () {
      origRFT.apply(this, arguments);
      if (window.annieTheme && window.annieTheme.current === 'fb2k' && S.mounted) rebuildTree();
    };
  }

  // 启动即为 FB2K 主题时（theme.js 先于本文件执行），自挂载
  if (window.annieTheme && window.annieTheme.current === 'fb2k') window.annieFb2k.mount();
})();
