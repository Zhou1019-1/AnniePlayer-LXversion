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
    playlists: LS.get('annieplayer.fb2k.playlists', []),
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
    sortKey: null, sortAsc: true,
    lyrPath: null, lyrLines: null, lyrCur: -1,
    specFrames: null, specGen: -1, specSmooth: null,
    hiddenPaths: new Set(), // 会话级"从列表移除"
    treeExpanded: new Set(), // EXP 7.28：文件夹树展开状态（会话级）
    dark: LS.get('annieplayer.fb2k.dark', false) // V1.1.2：FB2K 暗色模式（持久化）
  };

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
    sun: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>'
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
  function getMeta(path) {
    var m = S.metaCache.get(path);
    if (!m) {
      m = { pending: true };
      S.metaCache.set(path, m);
      window.mine.meta(path).then(function (r) {
        Object.assign(m, r); m.pending = false;
        if (window.annieTheme.current === 'fb2k') { refreshVisibleRowMeta(path); updateRight(); updateTitle(); }
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
    R.title = el('div', 'f2-title', 'AnniePlayer V3');
    tb.appendChild(R.title);
    var wb = el('div', 'f2-winbtns');
    var bMin = el('button', '', '—'); bMin.title = '最小化'; bMin.onclick = function () { window.mine.winMin(); };
    var bMax = el('button', '', '□'); bMax.title = '最大化'; bMax.onclick = function () { window.mine.winMax(); };
    var bCls = el('button', 'f2-close', '×'); bCls.title = '关闭'; bCls.onclick = function () { window.mine.winClose(); };
    wb.append(bMin, bMax, bCls); tb.appendChild(wb);
    root.appendChild(tb);

    /* ---------- 菜单栏 ---------- */
    root.appendChild(buildMenubar());

    /* ---------- 三栏 ---------- */
    R.main = el('div', 'f2-main');
    R.main.style.setProperty('--f2-left', S.leftW + 'px');
    R.main.style.setProperty('--f2-right', S.rightW + 'px');
    R.main.classList.toggle('right-collapsed', S.rightCollapsed);

    // 左：播放列表树
    var left = el('div', 'f2-left');
    var searchBox = el('div', 'f2-left-search');
    R.searchInput = document.createElement('input');
    R.searchInput.placeholder = '搜索当前列表';
    R.searchInput.onkeydown = function (e) {
      if (e.key === 'Enter') { R.filterInput.value = R.searchInput.value; onFilter(R.searchInput.value); }
    };
    searchBox.appendChild(R.searchInput);
    searchBox.appendChild(el('span', 'f2-arr', '▼'));
    left.appendChild(searchBox);
    var filterRow = el('div', 'f2-filter-row');
    R.filterInput = document.createElement('input');
    R.filterInput.placeholder = '过滤';
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
    R.list.addEventListener('scroll', renderVisible);
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
        ['退出', '', function () { window.mine.winClose(); }]
      ]],
      ['编辑', [
        ['添加到喜爱 / 取消喜爱', '', function () { forEachSel(function (t) { window.mine.toggleFavorite(t.path).then(function (f) { state.favorites = new Set(f); refreshAll(); }); }); }],
        ['从列表中移除（本次会话）', 'Delete', function () { forEachSel(function (t) { S.hiddenPaths.add(t.path); }); S.sel.clear(); rebuildRows(); }],
        ['清空过滤', '', function () { R.filterInput.value = ''; onFilter(''); }]
      ]],
      ['视图', [
        ['切换到粒子舞台主题', '', function () { window.annieTheme.switch('legacy'); }],
        ['主题与外观设置…', '', function () { window.annieSettings.togglePanel(); }],
        ['-', null, null],
        ['列表视图', '', function () { setViewMode('list'); }],
        ['分栏视图', '', function () { setViewMode('split'); }],
        ['封面视图', '', function () { setViewMode('cover'); }],
        ['-', null, null],
        ['收起 / 展开右侧栏', '', toggleRight]
      ]],
      ['播放', [
        ['播放 / 暂停', 'Space', transportPlayPause],
        ['上一曲', 'Ctrl+←', transportPrev],
        ['下一曲', 'Ctrl+→', transportNext],
        ['停止', 'Ctrl+S', function () { window.mine.engine('stop').catch(function () { }); }],
        ['-', null, null],
        ['音量 +', 'Ctrl+↑', function () { setVolumeUI(Math.min(1, volGain() + 0.05)); }],
        ['音量 -', 'Ctrl+↓', function () { setVolumeUI(Math.max(0, volGain() - 0.05)); }]
      ]],
      ['媒体库', [
        ['默认列表', '', function () { setActiveList('default'); }],
        ['我的喜爱', '', function () { setActiveList('fav'); }],
        ['新建播放列表', '', newPlaylist]
      ]],
      ['帮助', [
        ['关于 AnniePlayer', '', function () {
          modal('关于 AnniePlayer', 'AnniePlayer V3 · 仿 foobar2000 主题<br>本地独占音乐播放器（WASAPI Exclusive / ASIO）<br>作者：无敌章鱼哥 · GPL-3.0');
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
    R.meta = el('div', 'f2-meta'); body.appendChild(R.meta);

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
    R.btnNpf = toolBtn(SVG.screen || '⛶', 'Now Playing 全屏（N）', function () { window.annieProUi && annieProUi.toggleNpf(); });
    R.btnDark.classList.toggle('active', S.dark);
    tools.append(R.btnCycleView, R.btnSpec, btnEq, R.btnDark, R.btnNpf, btnSet);
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
    tp.append(bPrev, R.btnPlay, bNext, bStop);
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
  function rebuildTree() {
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
      t.appendChild(node(SVG.list, p.name, p.paths.length, 'pl:' + p.id));
    });
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
    if (key.indexOf('pl:') === 0) {
      var id = key.slice(3);
      items.push(['重命名', function () {
        var p = S.playlists.find(function (x) { return x.id === id; });
        var n = prompt('播放列表名称', p ? p.name : '');
        if (n && p) { p.name = n; savePlaylists(); rebuildTree(); }
      }]);
      items.push(['删除', function () {
        S.playlists = S.playlists.filter(function (x) { return x.id !== id; });
        savePlaylists();
        if (S.activeList === key) setActiveList('default'); else rebuildTree();
      }]);
    }
    items.push(['导入文件夹…', function () { $('#btn-add-folder').click(); }]);
    ctxMenu(e, items);
  }
  function newPlaylist() {
    var n = prompt('新建播放列表名称', '新建列表');
    if (!n) return;
    S.playlists.push({ id: Date.now().toString(36), name: n, paths: [] });
    savePlaylists(); rebuildTree();
  }
  function savePlaylists() { S.plVer++; LS.set('annieplayer.fb2k.playlists', S.playlists); }

  /* ================= 中央：曲目列表（虚拟滚动） ================= */
  var COLS = [
    { k: 'cover', name: '封面', w: 50, sort: null },
    { k: 'state', name: '', w: 30, sort: null },
    { k: 'idx', name: '#', w: 40, sort: 'idx' },
    { k: 'title', name: '标题', flex: 1, sort: 'title' },
    { k: 'artist', name: '艺术家', flex: 1, sort: 'artist' },
    { k: 'rating', name: '等级', w: 80, sort: 'rating' },
    { k: 'time', name: '时间', w: 60, sort: 'time' }
  ];
  function buildCols() {
    R.cols.innerHTML = '';
    COLS.forEach(function (c) {
      if (S.viewMode === 'split' && c.k === 'cover') return;
      var d = el('div', 'f2-col', c.name);
      if (c.w) d.style.cssText = 'flex:none;width:' + c.w + 'px';
      else d.style.cssText = 'flex:' + c.flex + ';min-width:0';
      if (c.sort) {
        if (S.sortKey === c.sort) d.appendChild(el('span', 'f2-sort-arrow', S.sortAsc ? '▲' : '▼'));
        d.onclick = function () {
          if (S.sortKey === c.sort) S.sortAsc = !S.sortAsc; else { S.sortKey = c.sort; S.sortAsc = true; }
          rebuildRows();
        };
      }
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
      state.favorites.size, S.hiddenPaths.size, S.ratingsVer, S.plVer].join('|');
  }
  function sortedDeco() {
    var key = sortCacheKey();
    if (sortCache.key === key && sortCache.deco) return sortCache.deco;
    var coll = new Intl.Collator('zh-Hans-CN-u-co-pinyin'); // 复用 collator，远快于逐次 localeCompare
    var deco = baseTracks().map(function (t) {
      var tag = tagOf(t);
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
    if (base.length > 1000 && window.annieListWorker) {
      var durs = {};
      S.metaCache.forEach(function (m, p) { if (m && m.duration) durs[p] = m.duration; });
      window.annieListWorker.sort({
        op: 'fb2k-sort', tracks: base, tagCache: state.tagCache,
        sortKey: S.sortKey, sortAsc: S.sortAsc, ratings: S.ratings, durs: durs
      }).then(function (r) {
        if (gen !== rebuildGen) return;
        if (!r || !r.order) { applyDeco(sortedDeco()); return; } // Worker 失败兜底
        var deco = r.order.map(function (i) {
          var t = base[i], tag = tagOf(t);
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
    var rows = [];
    if (S.sortKey) {
      deco.forEach(function (d) { rows.push({ type: 'track', t: d.t }); });
    } else { // 默认：按专辑分组（绿色分组行）
      var lastAl = null;
      deco.forEach(function (d) {
        var al = d.album || '未知专辑';
        if (al !== lastAl) {
          lastAl = al;
          rows.push({ type: 'group', label: al + (d.artist && d.artist !== '未知艺术家' ? ' | ' + d.artist : '') });
        }
        rows.push({ type: 'track', t: d.t });
      });
    }
    var list = deco.map(function (d) { return d.t; });
    S.rows = rows;
    S.tracks = list;
    // beta0.0.3 移植：路径 → 行号 O(1) 索引（定位播放行时替代线性扫描）
    var pIdx = new Map();
    for (var ri = 0; ri < rows.length; ri++) {
      if (rows[ri].type === 'track') pIdx.set(rows[ri].t.path, ri);
    }
    S.rowPathIdx = pIdx;
    // 播放中不覆写 PlayerCore 队列（双击/ transport 会钉住队列快照）；
    // 覆写会导致队列顺序与播放索引错位（显示一首、播放另一首）
    if (!state.currentPath) state.queue = list;
    R.spacer.style.height = (rows.length * S.rowH) + 'px';
    buildCols();
    renderVisible();
    // 匹配数量徽章
    R.filterBadge.textContent = String(list.length);
    R.filterBadge.classList.toggle('dim', !S.filter);
  }

  function durOf(t) {
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
    var trackIdx = -1;
    for (var i = 0; i < end; i++) {
      var r = S.rows[i];
      if (r.type === 'track') trackIdx++;
      if (i < start) continue;
      var node = r.type === 'group' ? groupNode(r, i) : trackNode(r, i, trackIdx);
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
    return '默认列表';
  }

  function groupNode(r) {
    var g = el('div', 'f2-group-row', r.label);
    g.style.height = S.rowH + 'px';
    return g;
  }

  function trackNode(r, rowIdx, trackIdx) {
    var t = r.t;
    var playing = t.path === state.currentPath;
    var d = el('div', 'f2-row' + (trackIdx % 2 ? ' alt' : '') + (S.sel.has(t.path) ? ' sel' : '') + (playing ? ' playing' : ''));
    d.style.height = S.rowH + 'px';
    d.dataset.path = t.path;
    d.dataset.qi = trackIdx;
    // Pro beat0.0.1：假无损 ⚠ 标记（悬浮显示判定理由）
    var fk = window.anniePro && window.anniePro.fakeMark(t.path);
    if (fk) { var fkw = el('span', 'fake-warn', '⚠'); fkw.title = fk.reason || '疑似假无损'; d.appendChild(fkw); }
    COLS.forEach(function (c) {
      if (S.viewMode === 'split' && c.k === 'cover') return;
      var cell = el('div', 'f2-cell f2-c-' + c.k);
      if (c.w) cell.style.cssText = 'flex:none;width:' + c.w + 'px';
      else cell.style.cssText = 'flex:' + c.flex + ';min-width:0';
      if (c.k === 'cover') {
        var img = document.createElement('img');
        img.src = PLACEHOLDER; img.draggable = false;
        var m = S.metaCache.get(t.path);
        if (m && m.cover) img.src = m.cover;
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
        var ar = tagOf(t).artist; cell.textContent = ar || '未知艺术家';
      } else if (c.k === 'rating') {
        cell.appendChild(starCell(t.path));
      } else if (c.k === 'time') {
        cell.textContent = playing && S.dur > 0 ? fmtCountdown(S.dur - S.pos) : durationText(t);
      }
      d.appendChild(cell);
    });
    d.onclick = function (e) { rowSelect(e, t.path, rowIdx); };
    d.ondblclick = function () { state.queue = S.tracks; playAt(trackIdx); };
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
  function rowCtxMenu(e, t, trackIdx) {
    if (!S.sel.has(t.path)) { S.sel.clear(); S.sel.add(t.path); renderVisible(); updateRight(); }
    var items = [
      ['播放', function () { state.queue = S.tracks; playAt(trackIdx); }],
      ['添加到喜爱 / 取消喜爱', function () { window.mine.toggleFavorite(t.path).then(function (f) { state.favorites = new Set(f); refreshAll(); }); }]
    ];
    S.playlists.forEach(function (p) {
      items.push(['添加到「' + p.name + '」', function () {
        forEachSel(function (x) { if (p.paths.indexOf(x.path) < 0) p.paths.push(x.path); });
        savePlaylists(); rebuildTree();
      }]);
    });
    items.push(['查看属性', function () { showProps(t); }]);
    items.push(['从列表中移除（本次会话）', function () {
      forEachSel(function (x) { S.hiddenPaths.add(x.path); }); S.sel.clear(); rebuildRows();
    }]);
    ctxMenu(e, items);
  }
  function ctxMenu(e, items) {
    var old = $('.f2-ctx'); if (old) old.remove();
    var m = el('div', 'f2-ctx');
    items.forEach(function (it) {
      var mi = el('div', 'f2-mi', it[0]);
      mi.onclick = function () { m.remove(); it[1](); };
      m.appendChild(mi);
    });
    m.style.left = Math.min(e.clientX, innerWidth - 190) + 'px';
    m.style.top = Math.min(e.clientY, innerHeight - items.length * 26 - 12) + 'px';
    ($('#fb2k-root') || document.body).appendChild(m); // V1.1.2：挂进 root 以继承暗色类
    setTimeout(function () {
      document.addEventListener('pointerdown', function h(ev) {
        if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', h); }
      });
    }, 0);
  }
  function showProps(t) {
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
        if (r.type === 'track' && !S.metaCache.has(r.t.path)) paths.push(r.t.path);
      }
      paths.slice(0, 40).forEach(getMeta);
    }, 60);
  }
  function refreshVisibleRowMeta(path) {
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
    if (state.currentPath) return { path: state.currentPath, name: (state.currentPath || '').split(/[\\/]/).pop(), dir: '' };
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
  function parseLrc(text) {
    var map = new Map();
    text.split(/\r?\n/).forEach(function (line) {
      var re = /\[(\d+):(\d+(?:\.\d+)?)\]/g, mm, last = 0, times = [];
      while ((mm = re.exec(line))) { times.push(+mm[1] * 60 + (+mm[2])); last = re.lastIndex; }
      if (!times.length) return;
      var txt = line.slice(last).trim();
      times.forEach(function (t) {
        if (!map.has(t)) map.set(t, { t: t, txt: txt, tly: '' });
        else { map.get(t).tly = txt; } // 同时间戳第二行视为译文
      });
    });
    return [...map.values()].sort(function (a, b) { return a.t - b.t; });
  }
  function loadLyrics(path) {
    S.lyrPath = path; S.lyrLines = null; S.lyrCur = -1;
    if (!path || path.indexOf('http') === 0) { renderLyrics(); return; }
    window.mine.lyrics(path).then(function (r) {
      if (S.lyrPath !== path) return;
      S.lyrLines = (r && r.ok) ? parseLrc(r.text) : null;
      renderLyrics();
    }).catch(function () { renderLyrics(); });
  }
  function renderLyrics() {
    if (!R.lyrLines) return;
    R.lyrLines.innerHTML = '';
    if (!S.lyrLines || !S.lyrLines.length) {
      R.lyrLines.appendChild(el('div', 'f2-lyr', '（无歌词）'));
    } else {
      S.lyrLines.forEach(function (l, i) {
        var d = el('div', 'f2-lyr');
        d.dataset.i = i;
        d.appendChild(document.createTextNode(l.txt || ' '));
        if (l.tly) d.appendChild(el('span', 'tly', l.tly));
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
    for (var i = 0; i < S.lyrLines.length; i++) if (S.lyrLines[i].t <= S.pos + 0.15) cur = i; else break;
    if (cur === S.lyrCur) return;
    S.lyrCur = cur;
    var q = R.lyrLines.querySelectorAll('.f2-lyr');
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
    if (p.gen !== S.specGen) { S.specGen = p.gen; S.specFrames = []; } // 新一曲的分析：重置缓存
    var arr = new Uint8Array(p.frames);
    var bands = Math.floor(arr.length / p.count);
    if (!bands) return;
    if (!S.specFrames) S.specFrames = [];
    for (var f = 0; f < p.count; f++) S.specFrames.push(arr.slice(f * bands, (f + 1) * bands));
  });
  var specRAF = 0;
  function specLoop() {
    specRAF = requestAnimationFrame(specLoop);
    if (window.annieTheme.current !== 'fb2k' || !S.playing || !S.specOn || S.rightCollapsed || !R.spec) return;
    var cv = R.spec, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    var ctx = cv.getContext('2d');
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
  function updateSpecVisibility() {
    if (R.specBox) R.specBox.style.display = (S.playing && S.specOn) ? '' : 'none';
  }

  /* ================= 标题栏 ================= */
  function updateTitle() {
    var path = state.currentPath;
    if (!path || !S.playing) {
      R.title.textContent = 'AnniePlayer V3';
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
    for (var i = 0; i < S.tracks.length; i++) if (S.tracks[i].path === state.currentPath) return i;
    return -1;
  }
  function transportNext() {
    var i = fb2kQueueIndex();
    if (i >= 0 && i + 1 < S.tracks.length) { state.queue = S.tracks; playAt(i + 1); }
  }
  function transportPrev() {
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
        // V1.1.4：seek 保护——锁定目标位置，引擎 seek 完成前旧 position 不拉回
        state.seekPending = true;
        state.seekTarget = sec;
        clearTimeout(state.seekTimer);
        state.seekTimer = setTimeout(function () { state.seekPending = false; }, 10000);
        if (typeof proToast === 'function') proToast('正在跳转…'); // 网络流 seek 需重新拉流（数秒）
        window.mine.engine('seek', { seconds: (state.currentCue ? state.currentCue.start : 0) + sec }, 30000).catch(function () { });
      };
      window.addEventListener('pointermove', seek);
      window.addEventListener('pointerup', up);
    });
  }

  var mutePrev = 1;
  function volGain() { return (+($('#volume').value) || 0) / 100; }
  function setVolumeUI(g) {
    $('#volume').value = Math.round(g * 100);
    $('#volume').dispatchEvent(new Event('input'));
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
      else if (e.ctrlKey && e.code === 'ArrowUp') { e.preventDefault(); setVolumeUI(Math.min(1, volGain() + 0.05)); }
      else if (e.ctrlKey && e.code === 'ArrowDown') { e.preventDefault(); setVolumeUI(Math.max(0, volGain() - 0.05)); }
      else if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); setDarkMode(!S.dark); } // V1.1.2 暗色切换
      else if (e.key === 'F5') { e.preventDefault(); $('#btn-rescan').click(); }
      else if (e.key === 'Delete') {
        forEachSel(function (t) { S.hiddenPaths.add(t.path); });
        S.sel.clear(); rebuildRows();
      }
    });
    specLoop();
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
    loadLyrics(path && path.indexOf('http') !== 0 ? path : null);
    if (path) { var m = getMeta(path); if (m && m.duration) S.dur = m.duration; }
    updateLyricsVisibility();
  }

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
    if (state.currentPath && state.currentPath.indexOf('http') !== 0) loadLyrics(state.currentPath);
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
    if (e.detail && e.detail.theme === 'fb2k') locatePlayingFb2k();
  });

  window.annieFb2k = {
    mount: function () {
      if (!S.mounted) { build(); S.mounted = true; }
      refreshAll();
    },
    refresh: refreshAll,
    isDark: function () { return S.dark; },          // V1.1.2
    setDark: function (on) { setDarkMode(on); }      // V1.1.2
  };

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
