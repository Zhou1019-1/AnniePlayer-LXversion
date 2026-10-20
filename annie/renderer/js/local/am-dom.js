'use strict';
/* ===== am.js 拆分片：am-dom.js =====
 * 界面构建与本地视图：build() 主 DOM、侧栏、内容区（专辑网格/文件夹/歌单头/曲目表窗口化）、添加菜单、定位播放
 * 来源：am.js 原稿行 388-871 + 1248-1295 + 1499-1540（原样切片，零行为变更）
 * 共享变量经 window.__annieAMInternal 桥接；前向引用为转发桩，运行时解析。 */
(function () {
  /* V4.4.8：顶栏图标统一 SVG（emoji 字形在不同字体下大小/基线各不相同） */
  function amIcoTop(name, size) {
    var P = {
      vol: '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16.6 8.6a4.8 4.8 0 0 1 0 6.8"/>',
      mute: '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16.4 9.2l4.6 5.6M21 9.2l-4.6 5.6"/>',
      queue: '<path d="M4 7h10M4 12h10M4 17h6"/><circle cx="18.4" cy="16.6" r="2.3"/><path d="M20.7 16.6V7.8l2.2-.6"/>',
      timer: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.2v5l3.4 2"/>',
      expand: '<path d="M14.6 4.6H19.4V9.4"/><path d="M19.4 4.6L13.2 10.8"/><path d="M9.4 19.4H4.6V14.6"/><path d="M4.6 19.4L10.8 13.2"/>',
      mini: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M7 15h6"/>',
      mic: '<rect x="9" y="2.6" width="6" height="11" rx="3"/><path d="M5.6 11a6.4 6.4 0 0 0 12.8 0M12 17.4V21"/>',
      gear: '<g transform="translate(12 12) scale(0.9) translate(-12 -12)"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></g>',
      msg: '<path d="M4.6 4.2h14.8a1.6 1.6 0 0 1 1.6 1.6v9.6a1.6 1.6 0 0 1-1.6 1.6h-8l-4.2 2.8v-2.8H4.6A1.6 1.6 0 0 1 3 15.4V5.8A1.6 1.6 0 0 1 4.6 4.2z"/>',
      moon: '<path d="M21 12.8A8.6 8.6 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
      sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>',
      palette: '<rect x="3.6" y="3.6" width="7" height="7" rx="1.8"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.8"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.8"/><circle cx="16.9" cy="16.9" r="3.7"/>',
      lock: '<rect x="5" y="10.6" width="14" height="9.8" rx="2"/><path d="M8.6 10.6V7.4a3.4 3.4 0 0 1 6.8 0v3.2"/>',
      unlock: '<rect x="5" y="10.6" width="14" height="9.8" rx="2"/><path d="M8.6 10.6V7.4a3.4 3.4 0 0 1 6.4-1.7"/>',
      link: '<path d="M10.6 13.4a4 4 0 0 0 5.6 0l2.8-2.8a4 4 0 1 0-5.6-5.6l-1.4 1.4"/><path d="M13.4 10.6a4 4 0 0 0-5.6 0l-2.8 2.8a4 4 0 1 0 5.6 5.6l1.4-1.4"/>',
      back: '<path d="M14.6 6.2 9.4 12l5.2 5.8"/>',
    };
    return '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>';
  }
  /* ===== V4.4.8：可拖动分栏（侧栏 / 歌词面板） ===== */
  (function () {
    var KS = 'annieplayer.am.sidew', KL = 'annieplayer.am.lyrw';
    function num(v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; }
    function boot() {
      var root = document.getElementById('am-root');
      var body = root && root.querySelector('.am-body');
      if (!body) { setTimeout(boot, 300); return; }
      if (body.querySelector('.am-resize-l')) return;
      var sw = num(localStorage.getItem(KS), 0);
      if (sw >= 56 && sw <= 800) root.style.setProperty('--am-side-w', sw + 'px');
      var lw = num(localStorage.getItem(KL), 0);
      if (lw >= 260 && lw <= 640) root.style.setProperty('--am-lyr-w', lw + 'px');
      function make(cls, get, set, save, sign) {
        var h = document.createElement('div');
        h.className = 'am-resize ' + cls;
        body.appendChild(h);
        h.addEventListener('dblclick', function () {
          root.style.removeProperty(sign < 0 ? '--am-lyr-w' : '--am-side-w');
          try { localStorage.removeItem(sign < 0 ? KL : KS); } catch (e) { }
        });
        h.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation();
          var x0 = e.clientX, v0 = get(), last = v0;
          root.classList.add('am-resizing'); h.classList.add('dragging');
          function mv(ev) { last = set(v0 + (ev.clientX - x0) * sign) || last; if (window.__amCoalesce) window.__amCoalesce(); }
          function up() {
            document.removeEventListener('mousemove', mv, true);
            document.removeEventListener('mouseup', up, true);
            root.classList.remove('am-resizing'); h.classList.remove('dragging');
            try { localStorage.setItem(sign < 0 ? KL : KS, String(Math.round(last))); } catch (e) { }
            syncNarrow();
          }
          document.addEventListener('mousemove', mv, true);
          document.addEventListener('mouseup', up, true);
        });
      }
      // 左：侧栏（向左拖变窄 → sign = +1 时向右拖变宽）
      make('am-resize-l',
        function () { var s = root.querySelector('.am-side'); return s ? Math.round(s.getBoundingClientRect().width) : 240; },
        function (w) { w = Math.max(56, Math.min(Math.round(innerWidth * 0.33), w)); root.__sideWant = w; root.style.setProperty('--am-side-w', w + 'px'); return w; },
        null, 1);
      // 右：歌词面板（手柄在面板左缘，向左拖变宽 → sign = -1）
      /* 切换视图会重建内容区，重建后要重新判断一次 */
      try {
        var _c0 = root.querySelector('.am-content');
        if (_c0) new MutationObserver(function () { setTimeout(syncNarrow, 30); }).observe(_c0, { childList: true });
      } catch (e) { }
      syncNarrow();
      syncNpTight();
      syncRail();
      syncTransport();
      make('am-resize-r',
        function () { var l = root.querySelector('.am-lyrics'); return l ? Math.round(l.getBoundingClientRect().width) : 360; },
        function (w) { w = Math.max(260, Math.min(640, w)); root.style.setProperty('--am-lyr-w', w + 'px'); return w; },
        null, -1);
    }
    /* 内容区窄时切紧凑模式（按钮变小，避免三行换行） */
    function syncNarrow() {
      var r = document.getElementById('am-root'); if (!r) return;
      var c = r.querySelector('.am-content'); if (!c) return;
      /* 按「整排按钮所需宽度」判断：放得下保持原样，放不下才紧凑 */
      var info = r.querySelector('.am-pl-info');
      if (!info) { r.classList.remove('am-narrow'); return; }
      var acts = info.querySelector('.am-pl-actions');
      if (!acts || !acts.children.length) { r.classList.remove('am-narrow'); return; }
      /* 先按完整样式量一次「三个按钮 + 间距」的真实宽度 */
      var had = r.classList.contains('am-narrow');
      r.classList.remove('am-narrow');
      var _sum = 0, _kids = acts.children;
      for (var _k = 0; _k < _kids.length; _k++) _sum += _kids[_k].getBoundingClientRect().width;
      var _gap = parseFloat(getComputedStyle(acts).columnGap) || 8;
      var need = _sum + _gap * Math.max(0, _kids.length - 1);
      if (had) r.classList.add('am-narrow');
      r.classList.toggle('am-narrow', info.getBoundingClientRect().width < need);
    }
    /* 顶栏太挤时隐藏音质胶囊，避免插进右侧图标 */
    function syncNpTight() {
      var r = document.getElementById('am-root'); if (!r) return;
      var np = r.querySelector('.am-np'); if (!np) return;
      var w = np.getBoundingClientRect().width;
      var tight = r.classList.contains('am-np-tight');
      if (!tight && w < 340) r.classList.add('am-np-tight');
      else if (tight && w > 380) r.classList.remove('am-np-tight');
      /* 胶囊展开/收起等动画结束（约 280ms）再换文案，避免边动边变 */
      clearTimeout(window.__amBadgeT);
      window.__amBadgeT = setTimeout(function () {
        var w2 = np.getBoundingClientRect().width;
        var tg = r.classList.contains('am-np-tight');
        if (!tg && w2 < 340) r.classList.add('am-np-tight');
        else if (tg && w2 > 380) r.classList.remove('am-np-tight');
        try { if (window.__annieAMInternal && __annieAMInternal.refreshBadge) __annieAMInternal.refreshBadge(); } catch (e3) { }
      }, 300);
    }
    /* 侧栏窄到只剩图标（≈120px 以下）时切「轨道」模式 */
    function syncRail() {
      var r = document.getElementById('am-root'); if (!r) return;
      var s = r.querySelector('.am-side'); if (!s) return;
      var w = s.getBoundingClientRect().width;
      var rail = r.classList.contains('am-side-rail');
      var next = rail ? (w > 100 ? false : true) : (w <= 96 ? true : false);
      if (next !== rail) r.classList.toggle('am-side-rail', next);
      var hdr = r.querySelector('.am-side .am-side-h');
      var line = next || (!!hdr && (hdr.scrollWidth > hdr.clientWidth + 1));
      if (line !== r.classList.contains('am-hdr-line')) r.classList.toggle('am-hdr-line', line);
    }
    /* 拖拽时把三种同步合并到一帧，避免每个 mousemove 都强制重排 */
    var _rafSync = 0;
    /* 顶栏左侧控制键：随侧栏宽度保持居中；右侧正在播放块始终贴齐侧栏右缘 */
    function syncTransport() {
      var r = document.getElementById('am-root'); if (!r) return;
      var tr = r.querySelector('.am-transport');
      var np = r.querySelector('.am-np');
      var side = r.querySelector('.am-side');
      if (!tr || !np || !side) return;
      var sb = side.getBoundingClientRect();
      var sw = sb.width, pad = 14;
      var twant = Math.max(116, Math.min(sw - 28, 116 + (sw - 120) * 0.20));
      tr.style.width = twant + 'px';
      tr.style.marginLeft = Math.max(0, sw / 2 - pad - twant / 2) + 'px';
      var t2 = tr.getBoundingClientRect();
      var npNow = np.getBoundingClientRect().left;
      var m0 = parseFloat(np.style.marginLeft) || 0;
      var extra = npNow - t2.right - m0;
      var _gap = Math.max(8, t2.left);   /* 控制栏到左边框的距离，作为最小间距 */
      var want = Math.max(t2.right + _gap + 5, sb.right) - 2;   /* 再左移 2px：整体贴近侧栏竖线 */
      var ml = Math.max(0, want - t2.right - extra);
      np.style.marginLeft = ml + 'px';
      np.style.marginRight = '8px';   /* 右侧最小间隙对齐左侧（含视觉补偿 3px） */
      /* 自检：np 左缘与目标偏差 >1px 时立刻补一次（不越过控制键） */
      var d = want - np.getBoundingClientRect().left;
      if (Math.abs(d) > 1) np.style.marginLeft = (ml + d) + 'px';
      /* 拖动时即时触发胶囊收缩动画（不夹宽度，胶囊靠动画自己收窄） */
      try {
        var _swNow = Math.round(sb.width);
        if (_swNow !== window.__amLastSw) {
          window.__amLastSw = _swNow;
          window.__amNoBlur = true;
          try { var _AM = window.__annieAMInternal; if (_AM && _AM.refreshBadge) _AM.refreshBadge(); } catch (e) { }
          window.__amNoBlur = false;
        }
      } catch (e) { }
    }
    window.__amCoalesce = function () {
      if (_rafSync) return;
      _rafSync = requestAnimationFrame(function () {
        _rafSync = 0; syncNarrow(); syncRail(); syncNpTight(); syncTransport();
      });
    };
    window.__amSyncRail = syncRail;
    window.addEventListener('resize', syncRail);
    document.addEventListener('mouseup', function () { setTimeout(syncRail, 60); }, true);
    window.__amSyncNpT = syncNpTight;
    window.__amSyncTransport = syncTransport;
    /* 侧栏 / 内容区滚动条：鼠标移入该面板并移动时显示，停移约 900ms 隐藏，移出立即隐藏 */
    (function _amScrollbarHook() {
      var root = document.getElementById('am-root');
      if (!root) { setTimeout(_amScrollbarHook, 300); return; }
      var c = root.querySelector('.am-content');
      var s = root.querySelector('.am-side');
      if (!c || !s) { setTimeout(_amScrollbarHook, 300); return; }
      function bind(el) {
        if (!el || el.__amSB) return; el.__amSB = 1;
        var t = 0;
        el.addEventListener('mouseenter', function () { el.classList.add('am-sb-on'); });
        el.addEventListener('mousemove', function () {
          el.classList.add('am-sb-on');
          clearTimeout(t);
          t = setTimeout(function () { el.classList.remove('am-sb-on'); }, 900);
        }, { passive: true });
        el.addEventListener('scroll', function () {
          el.classList.add('am-sb-on');
          clearTimeout(t);
          t = setTimeout(function () { el.classList.remove('am-sb-on'); }, 900);
        }, { passive: true });
        el.addEventListener('mouseleave', function () { clearTimeout(t); el.classList.remove('am-sb-on'); });
      }
      bind(c); bind(s);
      function dragScroll(el) {
        if (!el || el.__amDrag) return; el.__amDrag = 1;
        var down = false, sy = 0, st = 0, moved = false, skipUntil = 0;
        el.addEventListener('pointerdown', function (e) {
          if (e.button !== 0) return;
          down = true; moved = false; sy = e.clientY; st = el.scrollTop; el._sbPrev = el.style.scrollBehavior; el.style.scrollBehavior = 'auto'; el.classList.add('am-drag-lyr');
        });
        window.addEventListener('pointermove', function (e) {
          if (!down) return;
          var dy = e.clientY - sy;
          if (Math.abs(dy) > 4) moved = true;
          el.scrollTop = st - dy;
        }, { passive: true });
        window.addEventListener('pointerup', function () {
          if (!down) return; down = false; el.classList.remove('am-drag-lyr'); el.style.scrollBehavior = el._sbPrev || '';
          if (moved) {
            skipUntil = Date.now() + 400;   /* 拖动后松手不算点击 */
            setTimeout(function () {
              if (down) return;
              var A = window.__annieAMInternal;
              var cur = el.querySelector('.am-lyr-line.cur');
              if (!cur || !A || !A.progScrollTop) return;
              el.style.scrollBehavior = 'smooth';
              A.progScrollTop(el, cur.offsetTop - el.clientHeight * 0.35);
            }, 2000);
          }
        }, true);
        el.addEventListener('click', function (e) {
          if (Date.now() < skipUntil) { e.stopPropagation(); e.preventDefault(); skipUntil = 0; }
        }, true);
      }
      function bindLyrDrag() {
        ['.am-lyr-scroll', '.am-imm-lyr', '.am-mini-lyr'].forEach(function (sel) {
          var el = root.querySelector(sel); if (el) dragScroll(el);
        });
      }
      bindLyrDrag(); setInterval(bindLyrDrag, 1500);
      var lyr = root.querySelector('.am-lyrics');
      if (lyr && !lyr.__amMV) {
        lyr.__amMV = 1; var t2 = 0;
        lyr.addEventListener('mousemove', function () {
          lyr.classList.add('am-mv');
          clearTimeout(t2); t2 = setTimeout(function () { lyr.classList.remove('am-mv'); }, 1200);
        }, { passive: true });
        lyr.addEventListener('mouseleave', function () { clearTimeout(t2); lyr.classList.remove('am-mv'); });
      }
    })();
    /* 记录/恢复上次停留的视图（歌曲/专辑/文件夹/播放列表…），重启回到原位置 */
    try {
      var _lvLast = '';
      setInterval(function () {
        var A = window.__annieAMInternal; if (!A || !A.S) return;
        var st = JSON.stringify({ v: A.S.view, a: A.S.albumKey || null, f: A.S.folderPath || null });
        if (st !== _lvLast) { _lvLast = st; try { localStorage.setItem('annieplayer.am.lastView', st); } catch (e) { } }
      }, 800);
      var _lvTries = 0;
      var _lvT = setInterval(function () {
        _lvTries++;
        var A = window.__annieAMInternal; if (!A || !A.S) { if (_lvTries > 100) clearInterval(_lvT); return; }
        var st2 = null; try { st2 = JSON.parse(localStorage.getItem('annieplayer.am.lastView') || 'null'); } catch (e) { }
        if (!st2 || !st2.v) { clearInterval(_lvT); return; }
        var _vT = st2.v, _aT = st2.a || null, _fT = st2.f || null;
        /* 播放列表还没加载完就再等一会儿（避免恢复到一个暂时不存在的歌单） */
        if ((_vT.indexOf('pl:') === 0 || _vT.indexOf('spl:') === 0) && _lvTries < 40) {
          var _id = _vT.split(':')[1];
          var _arr = _vT.indexOf('spl:') === 0 ? (A.S.streamPlaylists || []) : (A.S.playlists || []);
          if (!_arr.some(function (p) { return String(p.id) === String(_id); })) return;
        }
        if (A.S.view !== _vT || (A.S.albumKey || null) !== _aT || (A.S.folderPath || null) !== _fT) {
          A.S.view = _vT; A.S.albumKey = _aT; A.S.folderPath = _fT;
          try { if (A.renderSidebar) A.renderSidebar(); if (A.renderView) A.renderView(); } catch (e) { }
        }
        clearInterval(_lvT);
      }, 300);
    } catch (e) { }
    /* 兜底：每 400ms 检查一次对齐，有偏差才重算（防元素重建导致观察器失效） */
    setTimeout(function () { setInterval(function () {   /* 延后启动，首屏更快 */
      try {
        var r = document.getElementById('am-root'); if (!r) return;
        var s = r.querySelector('.am-side'); var c = r.querySelector('.am-np-cover');
        if (!s || !c) return;
        var d = s.getBoundingClientRect().right - c.getBoundingClientRect().left;
        if (Math.abs(d) > 1) syncTransport();
      } catch (e) { }
    }, 400); }, 1500);
    /* 侧栏宽度一变（恢复存档、拖动、窗口缩放）就重新对齐顶栏 */
    try {
      var _sideEl = document.querySelector('#am-root .am-side');
      if (_sideEl) {
        var _sideRO = new ResizeObserver(function () {
          clearTimeout(window.__amSideT);
          window.__amSideT = setTimeout(syncTransport, 60);
        });
        _sideRO.observe(_sideEl);
      }
    } catch (e) { }
    /* 启动瞬间侧栏宽度可能还没恢复：补几次 */
    [0, 120, 400, 1000].forEach(function (d) { setTimeout(function () { try { syncTransport(); } catch (e) { } }, d); });
    /* np 宽度变化时实时校正胶囊长短，避免状态残留 */
    try {
      var _npRO = new ResizeObserver(function () {
        clearTimeout(window.__amNpROT);
        window.__amNpROT = setTimeout(function () {
          if (window.__amSyncNpT) window.__amSyncNpT();
          try { if (window.__annieAMInternal && __annieAMInternal.refreshBadge) __annieAMInternal.refreshBadge(); } catch (e) { }
        }, 180);
      });
      var _npEl0 = document.querySelector('#am-root .am-np');
      if (_npEl0) _npRO.observe(_npEl0);
    } catch (e) { }
    window.addEventListener('resize', syncTransport);
    document.addEventListener('mouseup', function () { setTimeout(syncTransport, 60); }, true);
    window.addEventListener('resize', syncNpTight);
    document.addEventListener('mouseup', function () { setTimeout(syncNpTight, 60); }, true);
    window.addEventListener('resize', syncNarrow);
    setTimeout(syncNarrow, 400);
    document.addEventListener('mouseup', function () { setTimeout(syncNarrow, 60); }, true);
    boot();
  })();
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
  var folderRoots = AM.folderRoots;
  var folderChildren = AM.folderChildren;
  var normP = AM.normP;
  var currentTracks = AM.currentTracks;
  var playList = AM.playList;
  var togglePlay = AM.togglePlay;
  var next = AM.next;
  var prev = AM.prev;
  var seek = AM.seek;
  var bindProgDrag = AM.bindProgDrag; // V4.3.16：进度条拖动（顶栏/沉浸/迷你共用）
  var renderStreamView = AM.renderStreamView;
  var renderSplView = AM.renderSplView; // V4.3.5：在线歌单视图（am-stream 片先加载，引用有效）
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
    /* V4.4.7（秋野奈 PR#6）：点顶栏封面直接进沉浸模式——和右上角 ⤢ 按钮同一条路，
       按钮保留不动，这里只是多一个更顺手的入口 */
    R.npCover.title = '点击进入沉浸模式';
    R.npCover.onclick = function () { toggleImmersive(true); };
    var npText = el('div', 'am-np-text');
    R.npText = npText; // V4.1：切歌文本过渡动画需要容器引用
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
    bindProgDrag(R.npProg, R.npProgFill, R.npCur); // V4.3.16：可拖动（原仅点击）
    R.npRemain = el('span', 'am-np-time', '0:00');
    progRow.appendChild(R.npCur); progRow.appendChild(R.npProg); progRow.appendChild(R.npRemain);
    np.appendChild(progRow);
    top.appendChild(np);

    var right = el('div', 'am-tb-right');
    // V4.4.8：按钮组宽度逐帧写进 CSS 变量，中间块右缘与它保持恒定间距（展开/收起同速）
    try {
      var _tbLast = -1, _tbRaf = 0, _tbRoot = document.getElementById('am-root');
      var _tbRO = new ResizeObserver(function () {
        if (_tbRaf) return;
        _tbRaf = requestAnimationFrame(function () {
          _tbRaf = 0;
          var w = Math.round(right.getBoundingClientRect().width);
          if (w === _tbLast) return;
          _tbLast = w;
          if (_tbRoot) _tbRoot.style.setProperty('--am-tb-right-w', w + 'px');
        });
      });
      _tbRO.observe(right);
    } catch (e) { }
    var vol = el('div', 'am-vol');
    // V4.1：🔊 图标可点击（静音/取消静音），悬停展开音量条
    var volIco = el('button', 'am-tbtn am-vol-ico', ''); volIco.innerHTML = amIcoTop('vol', 18);
    volIco.title = '点击静音/取消静音；悬停展开音量条';
    volIco.onclick = function () {
      var cur = +R.vol.value;
      if (cur > 0) { S._muteVol = cur; R.vol.value = 0; }
      else { R.vol.value = S._muteVol || 80; }
      R.vol.oninput();
      volIco.innerHTML = amIcoTop(+R.vol.value > 0 ? 'vol' : 'mute', 18);
    };
    vol.appendChild(volIco);
    R.vol = document.createElement('input');
    R.vol.type = 'range'; R.vol.min = 0; R.vol.max = 100;
    var legacyVol = document.querySelector('#volume');
    R.vol.value = legacyVol ? legacyVol.value : 80;
    R.vol.oninput = function () {
      var g = (+R.vol.value) / 100;
      window.mine.engine('volume.set', { gain: g }).catch(function () { });
      if (legacyVol) legacyVol.value = R.vol.value; // 与粒子舞台底栏音量保持同步
      /* V4.4.9：持久化音量（此前只发引擎不落盘，重启会被 store 里的旧值覆盖成 100%） */
      try {
        if (state.library) state.library.volume = g;
        if (window.mine && window.mine.saveSettings) window.mine.saveSettings({ volume: g });
      } catch (e0) { }
    };
    vol.appendChild(R.vol);
    // V4.3.22：音量条关闭延迟——离开悬停区后保持 600ms，给鼠标移过去的余量；
    // 期间重新进入立即取消隐藏（隐形桥 ::after 是 vol 子元素，移到桥上不触发 mouseleave）
    var volHideT = null;
    function volKeep() { clearTimeout(volHideT); vol.classList.add('vol-open'); }
    function volScheduleHide() {
      clearTimeout(volHideT);
      volHideT = setTimeout(function () { vol.classList.remove('vol-open'); }, 200);
    }
    vol.addEventListener('mouseenter', volKeep);
    vol.addEventListener('mouseleave', volScheduleHide);
    R.vol.addEventListener('focus', volKeep); // 键盘 Tab 聚焦也保持
    // V4.3.22 修复：指针拖动结束后输入框仍持有 :focus，音量条卡在不消失。
    // 指针交互结束（change）即 blur；鼠标若还悬停区域上，:hover 会继续保持音量条。
    // volFromPtr 标记保证键盘方向键调节时不抢焦点。
    var volFromPtr = false;
    R.vol.addEventListener('pointerdown', function () { volFromPtr = true; });
    R.vol.addEventListener('change', function () {
      if (volFromPtr) { volFromPtr = false; R.vol.blur(); }
    });
    right.appendChild(vol);
    R.btnExcl = el('button', 'am-tbtn', ''); R.btnExcl.innerHTML = amIcoTop((window.annieIsExclusive ? window.annieIsExclusive() : true) ? 'lock' : 'unlock', 16);
    R.btnExcl.title = 'WASAPI 独占/共享输出（独占 = bit-perfect）';
    R.btnExcl.onclick = async function () {
      if (!window.annieExclusiveToggle) return;
      var on = await window.annieExclusiveToggle();
      R.btnExcl.innerHTML = amIcoTop(on ? 'lock' : 'unlock', 16);
    };
    document.addEventListener('annie-exclusive-changed', function (e) {
      if (R.btnExcl) R.btnExcl.innerHTML = amIcoTop((e.detail && e.detail.exclusive) ? 'lock' : 'unlock', 16);
    });

    // V4.4.6：顶栏精简——低频按钮不再直接入栏（对象照建，同步逻辑不受影响），收进「⋯」菜单
    // V4.4：主界面待播清单抽屉（此前仅沉浸/迷你能看队列）
    R.btnQ = el('button', 'am-tbtn', ''); R.btnQ.innerHTML = amIcoTop('queue', 16); R.btnQ.title = '待播清单 / 历史记录';
    R.btnQ.style.position = 'relative';
    R.btnQ.onclick = function () { if (AM.toggleMainQueue) AM.toggleMainQueue(); };
    R.btnQBadge = el('span', 'am-q-badge', '');
    R.btnQBadge.style.display = 'none';
    R.btnQ.appendChild(R.btnQBadge);
    right.appendChild(R.btnQ);
    // 播放模式循环切换（本地全量；在线支持顺序/随机/单曲循环）
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
    R.btnTimer = el('button', 'am-tbtn', ''); R.btnTimer.innerHTML = amIcoTop('timer', 16);
    R.btnTimer.onclick = function (e) { e.stopPropagation(); toggleTimerPop(); };
    document.addEventListener('annie-sleeptimer-changed', syncTimerBtn);
    // 沉浸式播放界面 / 迷你模式
    R.btnImm = el('button', 'am-tbtn', ''); R.btnImm.innerHTML = amIcoTop('expand', 16); R.btnImm.title = '沉浸式播放界面';
    R.btnImm.onclick = function () { toggleImmersive(); };
    right.appendChild(R.btnImm);
    R.btnMiniM = el('button', 'am-tbtn', ''); R.btnMiniM.innerHTML = amIcoTop('mini', 16); R.btnMiniM.title = '迷你模式';
    R.btnMiniM.onclick = function () { enterMini(); };
    // 桌面歌词快捷入口（Alt+L；状态跟随 annie-dlyrics-changed）
    var btnDlyr = el('button', 'am-tbtn' + ((window.annieDlyricsOn && window.annieDlyricsOn()) ? ' on' : ''), '');
    btnDlyr.innerHTML = amIcoTop('mic', 16);
    btnDlyr.title = '桌面歌词（Alt+L）';
    btnDlyr.onclick = function () { if (window.annieDlyricsToggle) window.annieDlyricsToggle(); };
    document.addEventListener('annie-dlyrics-changed', function (e) { btnDlyr.classList.toggle('on', !!(e.detail && e.detail.on)); });
    // V4.3.5：播放中一键收藏（仅在线歌曲；本地歌曲走行内 ♥）
    /* V4.4.7（PR#6）：收藏按钮重绘成 SVG 心形——未收藏是空心描边，收藏后填成主题色（默认红）。
       本地曲目：直接切换「喜爱歌曲」（与行内 ♥ 同一个 IPC），状态跟着 state.favorites 走；
       在线曲目：仍走原来的「加到在线歌单」弹层，行为不变。 */
    var btnNpFav = el('button', 'am-tbtn am-fav-btn');
    btnNpFav.title = '收藏';
    // 放在顶栏「歌曲信息」这一行里，格式徽标的左边
    if (R.npBadge && R.npBadge.parentNode === npRow) npRow.insertBefore(btnNpFav, R.npBadge);
    else npRow.appendChild(btnNpFav);
    var favSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    favSvg.setAttribute('class', 'am-fav-ico');
    favSvg.setAttribute('viewBox', '0 0 16 16');
    favSvg.setAttribute('width', '15');
    favSvg.setAttribute('height', '15');
    favSvg.setAttribute('aria-hidden', 'true');
    var favPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    favPath.setAttribute('d', 'M8 13.4 C8 13.4 2 9.5 2 5.9 C2 3.7 3.7 2.2 5.5 2.2 C6.7 2.2 7.6 2.9 8 3.7 C8.4 2.9 9.3 2.2 10.5 2.2 C12.3 2.2 14 3.7 14 5.9 C14 9.5 8 13.4 8 13.4 Z');
    favPath.setAttribute('fill', 'none');
    favPath.setAttribute('stroke', 'currentColor');
    favPath.setAttribute('stroke-width', '1.3');
    favPath.setAttribute('stroke-linejoin', 'round');
    favSvg.appendChild(favPath);
    btnNpFav.appendChild(favSvg);
    function syncNpFav() {
      var p = state.currentPath;
      var on = !!(p && !state.currentStream && state.favorites && state.favorites.has(p));
      btnNpFav.classList.toggle('on', on);
      btnNpFav.title = on ? '取消收藏' : '收藏';
      btnNpFav.style.display = p ? '' : 'none'; // 没在播放就不占位
    }
    btnNpFav.onclick = function (e) {
      e.stopPropagation();
      var p = state.currentPath;
      if (p && !state.currentStream) {
        window.mine.toggleFavorite(p).then(function (favs) {
          state.favorites = new Set(favs);
          syncNpFav();
          if (S.view === 'favorites') renderView();
        }).catch(function () { });
        return;
      }
      var r = btnNpFav.getBoundingClientRect();
      if (AM.favCurrentStream) AM.favCurrentStream(r.left, r.bottom + 6);
    };
    syncNpFav();
    setInterval(syncNpFav, 800); // 切歌/别处收藏后跟上状态（只是 Set.has，开销可忽略）
    // V4.3.16：复制播放中在线歌的平台分享链接
    var btnNpShare = el('button', 'am-tbtn', ''); btnNpShare.innerHTML = amIcoTop('link', 16);
    btnNpShare.title = '复制正在播放的在线歌曲的分享链接';
    btnNpShare.onclick = function () { if (AM.copyCurrentStreamLink) AM.copyCurrentStreamLink(); };
    // 设置中心入口（与粒子舞台顶栏 ⚙ 同一个面板）
    var btnSet = el('button', 'am-tbtn', ''); btnSet.innerHTML = amIcoTop('gear', 16); btnSet.title = '设置中心（Ctrl+,）';
    btnSet.onclick = function () { if (window.annieSettings) window.annieSettings.togglePanel(); };
    right.appendChild(btnSet);
    R.btnLyr = el('button', 'am-tbtn' + (S.lyricsOn ? ' on' : ''), ''); R.btnLyr.innerHTML = amIcoTop('msg', 16); R.btnLyr.title = '歌词面板';
    R.btnLyr.onclick = function () {
      S.lyricsOn = !S.lyricsOn;
      root.classList.toggle('am-lyr-on', S.lyricsOn);
      R.btnLyr.classList.toggle('on', S.lyricsOn);
      syncLyrFold(); // 与面板左缘折叠小标签同步图标/方向
    };
    R.btnLight = el('button', 'am-tbtn', ''); R.btnLight.innerHTML = amIcoTop(isLight() ? 'moon' : 'sun', 16); R.btnLight.title = '亮色/暗色';
    R.btnLight.onclick = function () {
      var l = !isLight();
      try { localStorage.setItem(LIGHT_KEY, l ? '1' : '0'); } catch (e) { }
      root.classList.toggle('am-light', l);
      R.btnLight.innerHTML = amIcoTop(l ? 'moon' : 'sun', 16);
    };
    R.btnTheme = el('button', 'am-tbtn', ''); R.btnTheme.innerHTML = amIcoTop('palette', 16); R.btnTheme.title = '切换主题（粒子舞台 → FB2K → Apple Music）';
    R.btnTheme.onclick = function () {
      var order = ['legacy', 'fb2k', 'am'];
      window.annieTheme.switch(order[(order.indexOf(annieTheme.current) + 1) % order.length]);
    };
    /* V4.4.7（PR#6）：低频入口不再是「⋯」弹层，改成「就地向左展开」的收缩栏：
       点一下，被收起的按钮从 ⋯ 左侧滑出来（就地展开，不弹窗）；再点一下收起。
       状态是「钉住」的——只有这个按钮能改，点别处（调音量/切歌…）不会自己收回去。
       留在栏上：音量 / 待播清单 / 播放模式 / 沉浸 / 设置。 */
    var moreWrap = el('div', 'am-tb-more');
    var MORE_KEY = 'annieplayer.tbmore.open'; // 展开/收起状态持久化（跨重启）
    function moreGroup(list) {
      list.forEach(function (b) { if (b) moreWrap.appendChild(b); });
    }
    moreGroup([R.btnExcl, R.btnTimer]);
    moreGroup([R.btnMiniM, R.btnLyr, btnDlyr]);
    moreGroup([btnNpShare]);
    moreGroup([R.btnLight, R.btnTheme]);
    right.appendChild(moreWrap);
    // V4.4.8：只有展开/收起真的挤到顶栏进度条那一块时才回弹，否则不动
    try {
      var _moT = 0, _w0 = -1;
      function _npWidth() { var n = document.querySelector('#am-root .am-np'); return n ? n.getBoundingClientRect().width : -1; }
      document.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.closest && t.closest('.am-tb-more-btn')) _w0 = _npWidth();
      }, true);
      new MutationObserver(function () {
        var root = document.getElementById('am-root');
        if (!root || !moreWrap.isConnected) return;
        var open = moreWrap.classList.contains('open');
        function _squeezed() {
          var w1 = _npWidth();
          var changed = (_w0 > 0 && w1 > 0 && Math.abs(w1 - _w0) > 2);
          _w0 = -1;
          return changed;
        }
        function _fire() {
          if (window.__amSyncNpT) window.__amSyncNpT();
          var _sq = _squeezed();
          /* 展开/收起都只在真的推动了中间块时才回弹（没碰到进度条就不动） */
          var _moved = (window.__amSqueezeNext !== false);
          window.__amSqueezeNext = undefined;
          if (open ? !_moved : !_sq) { root.classList.remove('am-tb-open', 'am-tb-close'); return; }
          root.classList.remove('am-tb-open', 'am-tb-close');
          void root.offsetWidth;
          root.classList.add(open ? 'am-tb-open' : 'am-tb-close');
          clearTimeout(_moT);
          _moT = setTimeout(function () {
            root.classList.remove('am-tb-open', 'am-tb-close');
          }, 420);
        }
        clearTimeout(window.__amFireT);
        window.__amFireT = setTimeout(_fire, open ? 0 : 40);   /* 展开与布局同时开始，合为一次回弹 */
      }).observe(moreWrap, { attributes: true, attributeFilter: ['class'] });
    } catch (e) { }

    R.btnMore = el('button', 'am-tbtn am-tb-more-btn');
    R.btnMore.title = '展开更多';
    var moreChev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    moreChev.setAttribute('class', 'am-more-chev');
    moreChev.setAttribute('viewBox', '0 0 10 12');
    moreChev.setAttribute('width', '9');
    moreChev.setAttribute('height', '11');
    moreChev.setAttribute('aria-hidden', 'true');
    var moreChevP = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    moreChevP.setAttribute('d', 'M7.5 1.5 L3 6 L7.5 10.5');
    moreChevP.setAttribute('fill', 'none');
    moreChevP.setAttribute('stroke', 'currentColor');
    moreChevP.setAttribute('stroke-width', '1.7');
    moreChevP.setAttribute('stroke-linecap', 'round');
    moreChevP.setAttribute('stroke-linejoin', 'round');
    moreChev.appendChild(moreChevP);
    R.btnMore.appendChild(moreChev);
    function setMore(open, silent) {
      /* V4.4.7：清掉可能残留的内联样式（调试/外部写入会把 max-width 钉死，
         导致点「收起」没反应——现象是类名变了但宽度不变） */
      moreWrap.style.maxWidth = '';
      moreWrap.style.marginRight = '';
      moreWrap.style.transition = '';
      moreWrap.classList.toggle('open', open);
      R.btnMore.classList.toggle('on', open);
      R.btnMore.title = open ? '收起' : '展开更多';
      if (!silent) { try { localStorage.setItem(MORE_KEY, open ? '1' : '0'); } catch (e) { } }
    }
    R.btnMore.onclick = function (e) {
      e.stopPropagation();
      var _opening = !moreWrap.classList.contains('open');
      if (!_opening) { setMore(false); return; }
      var _np = document.querySelector('#am-root .am-np');
      var _collide = false;
      if (_np) {
        /* 真实测量：临时用内联 maxWidth 展开 moreWrap（不改 class，不会触发回弹观察器），读完立刻还原 */
        window.__amMeasuring = true;
        var _mmPrev = moreWrap.style.maxWidth;
        var _trPrev = moreWrap.style.transition;
        moreWrap.style.transition = 'none';
        var _npBefore = _np.getBoundingClientRect().width;
        moreWrap.style.maxWidth = 'none';   /* 真实展开宽度，避免低估导致胶囊晚收 */
        var _npAfter = _np.getBoundingClientRect().width;
        _collide = _npAfter < 290;
        window.__amSqueezeNext = (_npAfter < _npBefore - 1);   /* 没推动就不要回弹 */
        moreWrap.style.maxWidth = _mmPrev;
        moreWrap.style.transition = _trPrev;
        window.__amMeasuring = false;
        void moreWrap.offsetWidth;
      }
      if (!_collide) { setMore(true); return; }
      setMore(true);   /* 展开图标与收胶囊同时进行 */
      (function () { var _rt = document.getElementById('am-root'); if (!_rt) return;
        _rt.classList.add('am-badge-shift');
        clearTimeout(window.__amShiftT);
        window.__amShiftT = setTimeout(function () { _rt.classList.remove('am-badge-shift'); }, 1100); })();
      var _A = window.__annieAMInternal, _b = document.querySelector('#am-root .am-badge');
      if (_A && _A.S && _b) {
        var _t = String(_A.S.fmt || '').split('·')[0].trim();
        if (_t && _b.textContent !== _t) {
          /* 直接换文案、不做宽度动画：避免「宽空胶囊」压到标题上 */
          _b.style.transition = 'none';
          _b.style.width = '';
          _b.textContent = _t;
          void _b.offsetWidth;
          _b.classList.remove('am-badge-blur'); void _b.offsetWidth; _b.classList.add('am-badge-blur');
          setTimeout(function () { _b.style.transition = ''; }, 60);
          setTimeout(function () { _b.classList.remove('am-badge-blur'); }, 620);
        }
      }
    };
    right.appendChild(R.btnMore);
    // 恢复上次的展开/收起状态（重启后不再默认收起）；直接落定，不播一遍展开动画
    try {
      if (localStorage.getItem(MORE_KEY) === '1') {
        moreWrap.classList.add('no-anim');
        setMore(true, true);
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { moreWrap.classList.remove('no-anim'); });
        });
      }
    } catch (e) { }
    var wb = el('div', 'am-winbtns');
    /* V4.4.7（PR#6）：最小化/最大化/关闭改用 SVG 画。
       原来用「— ▢ ✕」三个字形：粗细、字面高度、基线都跟左边那排图标对不上（还随字体变）。
       现在统一 1.5px 描边、11px 画布、圆角端点，靠 flex 居中，三个和左边一行齐平。 */
    function winIcon(d) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'am-win-ico');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('aria-hidden', 'true');
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.3');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
      return svg;
    }
    var bMin = el('button', 'am-tbtn', ''); bMin.title = '最小化'; bMin.appendChild(winIcon('M3 8 H13'));
    bMin.onclick = function () { window.mine.winMin(); };
    var bMax = el('button', 'am-tbtn', ''); bMax.title = '最大化'; bMax.appendChild(winIcon('M3.6 3.6 H12.4 V12.4 H3.6 Z'));
    bMax.onclick = function () { window.mine.winMax(); };
    var bClose = el('button', 'am-tbtn am-close', ''); bClose.title = '关闭'; bClose.appendChild(winIcon('M4.2 4.2 L11.8 11.8 M11.8 4.2 L4.2 11.8'));
    bClose.onclick = function () { window.mine.winClose(); };
    wb.appendChild(bMin); wb.appendChild(bMax); wb.appendChild(bClose);
    right.appendChild(wb);
    // V4.4：设置「顶栏置底」已开启时（AM build 晚于 settings hydrate），构建后立刻把三键挂到
    // #am-root 下钉回右上角——顶栏 backdrop-filter 会创建包含块使 fixed 定位失效，不能纯 CSS 钉住
    try {
      if (window.annieSettings && annieSettings.ui && annieSettings.ui.amTopbarBottom) {
        wb._homeParent = right; wb._homeNext = null;
        document.getElementById('am-root').appendChild(wb);
      }
    } catch (e) { }
    top.appendChild(right);

    /* 主体 */
    var body = el('div', 'am-body');
    R.sidebar = el('nav', 'am-side');
    R.content = el('div', 'am-content');    // 窗口化渲染：滚动时按可视区重建行（rAF 合并，避免滚动事件风暴）
    R.content.addEventListener('scroll', function () {
      if (!S._tbl || S._tblRAF) return;
      S._tblRAF = requestAnimationFrame(function () { S._tblRAF = 0; renderAmWindow(); });
    });
    scrollMemBind();
    scrollMemRestoreTick();   // V4.4.9：重启后恢复侧栏/内容区滚动位置
    var lyr = el('aside', 'am-lyrics');
    // V4.3.22：面板顶部封面（绝对定位叠加在歌词滚动区上方；无封面/开关关闭时隐藏）
    R.lyrCover = el('img', 'am-lyr-cover'); R.lyrCover.alt = '';
    lyr.appendChild(R.lyrCover);
    // V4.3.26：封面大小可拖拽调节（右下角把手对角拖拽 140–280px，CSS 变量驱动，localStorage 记忆）。
    // 把手挂 .am-lyrics（封面同容器）——overflow:hidden 不影响内部正坐标子元素。
    (function () {
      var CV_KEY = 'annieplayer.am.lyrcoversize';
      var size = 200;
      try { size = Math.min(280, Math.max(140, parseInt(localStorage.getItem(CV_KEY), 10) || 200)); } catch (e) { }
      var rootEl = document.getElementById('am-root');
      function apply() {
        if (rootEl) rootEl.style.setProperty('--am-lyrcover-size', size + 'px');
        try { localStorage.setItem(CV_KEY, String(size)); } catch (e) { }
      }
      apply();
      var grip = el('div', 'am-lyr-cover-grip'); grip.title = '拖拽调节封面大小';
      grip.addEventListener('pointerdown', function (e) {
        e.preventDefault(); e.stopPropagation();
        var sx = e.clientX, sy = e.clientY, s0 = size;
        grip.setPointerCapture(e.pointerId);
        grip.classList.add('on');
        function mv(ev) {
          var d = (ev.clientX - sx) + (ev.clientY - sy);
          size = Math.min(280, Math.max(140, Math.round(s0 + d * 0.7)));
          if (rootEl) rootEl.style.setProperty('--am-lyrcover-size', size + 'px');
        }
        function up(ev) {
          grip.releasePointerCapture(ev.pointerId);
          grip.classList.remove('on');
          apply();
          grip.removeEventListener('pointermove', mv);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
        }
        grip.addEventListener('pointermove', mv);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
      });
      lyr.appendChild(grip);
    })();
    R.lyrScroll = el('div', 'am-lyr-scroll');
    lyr.appendChild(R.lyrScroll);
    // V4.4.1：主界面歌词面板注册滚动监听——用户手动滑动后 5 秒内不自动跟随（与沉浸/迷你一致）
    if (typeof AM.autoHideScrollbar === 'function') AM.autoHideScrollbar(R.lyrScroll);
    // 歌词外观设置入口（悬浮 ⚙，hover 面板显现）
    R.btnLyrSet = el('button', 'am-lyr-set', '⚙');
    R.btnLyrSet.title = '歌词外观（字号 / 行距）';
    R.btnLyrSet.onclick = function (e) { e.stopPropagation(); toggleLyrSetPop(); };
    lyr.appendChild(R.btnLyrSet);
    // V4.3.22：歌词面板折叠小标签（贴面板左缘外侧，与沉浸队列抽屉同一交互）
    // 挂 .am-body 而非 .am-lyrics——面板 overflow:hidden 会把负 left 的子元素裁掉。
    // 双态：面板开=❯收回（贴面板左缘）；面板关=❮展开（贴窗口右缘），与顶栏 💬 互相同步
    var btnLyrFold = el('button', 'am-lyr-fold', S.lyricsOn ? '❯' : '❮');
    function syncLyrFold() {
      btnLyrFold.textContent = S.lyricsOn ? '❯' : '❮';
      btnLyrFold.title = S.lyricsOn ? '收回歌词面板' : '展开歌词面板';
    }
    syncLyrFold();
    btnLyrFold.onclick = function (e) {
      e.stopPropagation();
      S.lyricsOn = !S.lyricsOn;
      root.classList.toggle('am-lyr-on', S.lyricsOn);
      if (R.btnLyr) R.btnLyr.classList.toggle('on', S.lyricsOn);
      syncLyrFold();
    };
    body.appendChild(R.sidebar); body.appendChild(R.content); body.appendChild(lyr);
    body.appendChild(btnLyrFold);

    // V4.3.16：悬浮回顶部——滚过约 1.5 屏才浮出，点击平滑回顶（挂 .am-body 不随 content 清空，全视图通用）
    /* V4.4.7（PR#6）：回顶部图标同样改成 SVG——原来的「⤒」字形本身重心偏上，
       在圆钮里怎么摆都显得不居中 */
    var backTop = el('button', 'am-backtop');
    (function () {
      var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('class', 'am-backtop-ico');
      s.setAttribute('viewBox', '0 0 16 16');
      s.setAttribute('width', '16');
      s.setAttribute('height', '16');
      s.setAttribute('aria-hidden', 'true');
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M8 13.4 V3.4 M3.9 7.4 L8 3.3 L12.1 7.4');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.5');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      s.appendChild(p);
      backTop.appendChild(s);
    })();
    backTop.title = '返回顶部';
    backTop.onclick = function () { R.content.scrollTo({ top: 0, behavior: 'smooth' }); };
    body.appendChild(backTop);
    /* V4.4.7（PR#6）：定位当前播放——从顶栏「更多」里挪出来，做成右下角圆钮（与「回顶部」并排）。
       图标重绘成准星（SVG）；只在「当前页面看不到正在播放的那一行」时出现。 */
    R.btnLocate = el('button', 'am-backtop am-locate-fab');
    R.btnLocate.title = '定位当前播放';
    var locSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    locSvg.setAttribute('class', 'am-locate-ico');
    locSvg.setAttribute('viewBox', '0 0 16 16');
    locSvg.setAttribute('width', '16');
    locSvg.setAttribute('height', '16');
    locSvg.setAttribute('aria-hidden', 'true');
    var locRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    locRing.setAttribute('cx', '8');
    locRing.setAttribute('cy', '8');
    locRing.setAttribute('r', '4.3');
    locRing.setAttribute('fill', 'none');
    locRing.setAttribute('stroke', 'currentColor');
    locRing.setAttribute('stroke-width', '1.4');
    locSvg.appendChild(locRing);
    var locPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    locPath.setAttribute('d', 'M8 1.3 V3.2 M8 12.8 V14.7 M1.3 8 H3.2 M12.8 8 H14.7');
    locPath.setAttribute('fill', 'none');
    locPath.setAttribute('stroke', 'currentColor');
    locPath.setAttribute('stroke-width', '1.4');
    locPath.setAttribute('stroke-linecap', 'round');
    locSvg.appendChild(locPath);
    R.btnLocate.appendChild(locSvg);
    R.btnLocate.onclick = function (e) { e.stopPropagation(); locatePlaying(); };
    body.appendChild(R.btnLocate);
    /* 当前曲目在不在「本视图的列表」里、行是不是在可视区。
       返回 'none'（不显示）/ 'on'（行就在眼前）/ 'off'（该显示按钮）。
       注意：列表是窗口化渲染的（可视区 ±15 行），正在播放那一行通常**不在 DOM 里**，
       所以「在不在列表」必须查 S._tbl.tracks，不能查 DOM。 */
    function playingRowState() {
      var p = state.currentPath;
      if (!p || !R.content) return 'none';
      var row = null;
      try { row = R.content.querySelector('.am-tr[data-path="' + CSS.escape(p) + '"]'); } catch (e) { row = null; }
      var list = (S._tbl && S._tbl.tracks) || null, inList;
      if (list) {
        inList = false;
        for (var li = 0; li < list.length; li++) { if (list[li].path === p) { inList = true; break; } }
      } else {
        inList = !!row;                     // 未窗口化：DOM 里就是全部
      }
      if (!inList) {
        /* 本视图没有这首歌（在别的播放列表里播）：歌曲全库视图下照样给按钮，
           点了由 locatePlaying() 切回全库并滚到它 */
        return S.view === 'songs' ? 'off' : 'none';
      }
      if (!row) return 'off';               // 列表里有但没渲染 = 一定在视野外
      var r = row.getBoundingClientRect(), c = R.content.getBoundingClientRect();
      return (r.bottom > c.top + 6 && r.top < c.bottom - 6) ? 'on' : 'off';
    }
    function updateLocateFab() {
      /* 行就在眼前 → 收起（定位成功后也要消失）；滚出去了 / 本视图没有这首歌 → 浮出来。
         build133 试过「歌曲视图常驻」，结果定位成功后按钮不消失，已撤回。 */
      R.btnLocate.classList.toggle('on', playingRowState() === 'off');
    }
    R.content.addEventListener('scroll', updateLocateFab, { passive: true });
    setInterval(updateLocateFab, 700);      // 切歌 / 换视图 / 窗口化重建后跟上
    updateLocateFab();
    R.content.addEventListener('scroll', function () {
      backTop.classList.toggle('on', R.content.scrollTop > R.content.clientHeight * 1.5);
    }, { passive: true });

    /* 添加到播放列表弹出菜单 */
    R.pop = el('div', 'am-pop');
    /* 播放定时弹层 */
    R.timerPop = el('div', 'am-pop am-timer-pop');

    /* V4.4.7（PR#6）：顶栏这一排用的是 emoji 字形，每个字形的墨迹基线都不一样
       （最夸张的 🗕 比中线低 5.7px，⏸ 比左右邻键低 2.2px），整排看着不齐。
       这里按实测逐个做竖直微调；用 position/top 而不是 transform，避免盖掉 :active 的按下缩放。
       播放键会在 ▶/⏸ 之间换字形、独占键 🔒/🔓、亮暗键 🌙/☀——换完要重新贴一次，
       否则会一直沿用旧字形的偏移量。 */
    (function () {
      var nudge = { '⏮': -1.3, '▶': -0.9, '⏸': -2.9, '⏭': -1.3, '⇥': -1.3, '🗕': -5.7, '💬': -0.3, '🔗': -0.4, '🌙': -1.3, '🎨': -0.4, '🔊': -1.0, '⤢': 0.4, '⚙': 0.4, '⏲': 0.4, '🔓': -1.3, '🎤': 0.4, '🔒': 0.4 };
      function applyNudge(b) {
        if (!b) return;
        var t = (b.textContent || '').trim();
        var n = nudge[t];
        if (!t || n === undefined) { b.style.paddingTop = ''; b.style.paddingBottom = ''; return; }
        if (/play/i.test(b.className || '')) { b.style.paddingTop = ''; b.style.paddingBottom = ''; return; } // 播放键由 setPlayIcon 单独管
        /* V4.4.7：用上下内边距（2n 的差）挪字形，而不是 top——
           用 top 会把按钮的悬停底色块一起挪走，看起来那个图标整块高了一截 */
        b.style.paddingTop = (n > 0 ? n * 2 : 0) + 'px';
        b.style.paddingBottom = (n < 0 ? -n * 2 : 0) + 'px';
      }
      var btns = top.querySelectorAll('.am-tbtn'); /* 此刻 top 还没进文档，只能从 top 里查 */
      for (var i = 0; i < btns.length; i++) applyNudge(btns[i]);
      var watch = [R.btnPlay, R.btnExcl, R.btnLight];
      if (typeof MutationObserver === 'function') {
        for (var w = 0; w < watch.length; w++) {
          (function (b) {
            if (!b) return;
            new MutationObserver(function () { applyNudge(b); }).observe(b, { childList: true, characterData: true, subtree: true });
          })(watch[w]);
        }
      }
    })();
    root.appendChild(top); root.appendChild(body); root.appendChild(R.pop); root.appendChild(R.timerPop);
    // V3.5.17：实时频谱可视化条（引擎 32 频段 10Hz 推送，贴底细条，迷你/沉浸下隐藏）
    R.vizBar = document.createElement('canvas'); R.vizBar.className = 'am-vizbar';
    R.vizBar.style.pointerEvents = 'auto'; R.vizBar.style.cursor = 'pointer';
    R.vizBar.title = '点击进入氛围模式（全屏频谱）';
    R.vizBar.onclick = function () { if (window.annieAmbient) annieAmbient.open(); };
    root.appendChild(R.vizBar);
    buildMini(root);

    /* V4.4.1：文件夹拖到侧栏播放列表区空白处 → 以文件夹名建歌单并装入其中歌曲。
     * 拖到某个具体歌单按钮上由该按钮自己的 drop 处理（stopPropagation 后不会到这里）。 */
    bindSidebarFolderDrop(root);

    document.addEventListener('click', function (e) {
      if (R.pop.classList.contains('on') && !R.pop.contains(e.target)) R.pop.classList.remove('on');
      if (R.timerPop.classList.contains('on') && !R.timerPop.contains(e.target) && e.target !== R.btnTimer) R.timerPop.classList.remove('on');
      if (R.lyrSetPop && R.lyrSetPop.classList.contains('on') && !R.lyrSetPop.contains(e.target)
          && e.target !== R.btnLyrSet && e.target !== R.immBtnLyrSet) R.lyrSetPop.classList.remove('on'); // V4.4：沉浸 ⚙ 也是合法锚点
      if (R.vinylSetPop && R.vinylSetPop.classList.contains('on') && !R.vinylSetPop.contains(e.target)
          && e.target !== R.immBtnVinyl) R.vinylSetPop.classList.remove('on'); // V4.4：彩胶外观弹层
    });

    renderSidebar();
    renderView();
    applyLyrStyle(); // 恢复歌词字号/行距设置（含初次自适应）
  }

  /* ---------------- 侧栏 ---------------- */

  // V4.3.25：自建歌单导出 .anniepl（换机复现；主进程按多指纹在目标机曲库匹配）
  function exportPlaylistFile(pl) {
    window.mine.playlistExportFile(pl.id).then(function (r) {
      if (!r || r.reason === 'canceled') return;
      if (r.ok) {
        try { if (typeof proToast === 'function') proToast('📤 已导出 ' + r.count + ' 首到：' + r.path); } catch (e) { }
      } else alert('导出失败：' + (r.reason || '未知错误'));
    }).catch(function () { });
  }
  function removeSidePlaylist(pl) {
    if (!confirm('删除播放列表「' + pl.name + '」？')) return;
    window.mine.playlistDelete(pl.id).then(function (pls) {
      S.playlists = pls;
      if (S.view === 'pl:' + pl.id) S.view = 'songs';
      renderSidebar(); renderView();
    });
  }
  // 侧栏歌单行右键菜单（复用共享弹层 R.pop；外点关闭由初始化时注册的全局监听负责）
  function openPlSideMenu(x, y, pl) {
    var pop = R.pop;
    pop.innerHTML = '';
    var t = el('div', 'am-pop-head', pl.name); // V4.4：标题改不可点样式
    pop.appendChild(t);
    pop.appendChild(el('div', 'am-pop-sep'));
    var ex = el('button', 'am-pop-item', '📤 导出歌单文件…');
    ex.title = '导出为 .anniepl，可发给另一台电脑的安妮播放器导入复现';
    ex.onclick = function () { pop.classList.remove('on'); exportPlaylistFile(pl); };
    pop.appendChild(ex);
    var dl = el('button', 'am-pop-item', '🗑 删除播放列表');
    dl.onclick = function () { pop.classList.remove('on'); removeSidePlaylist(pl); };
    pop.appendChild(dl);
    pop.classList.add('on');
    var w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - h - 12) + 'px';
  }

  /* V4.3.26：侧栏自建歌单长按拖拽排序（Pointer 事件手动实现，与单击进歌单/右键菜单共存）。
   * 400ms 长按进入拖拽（此时抑制 click），拖动经过目标歌单时按上半/下半决定插前/插后（落点高亮），
   * 松手后按新顺序调 playlistReorderList 持久化并重渲侧栏。 */
  /* V4.4：改为「位移阈值拖拽」——按下即准备，移动 >6px 立即进入拖拽；无位移松手=正常点击。
   * 旧实现 400ms 长按 + 8px 早移取消：用户按下即拖（直觉操作）会在 400ms 内超 8px 被取消，
   * 表现为「完全拖不动」（隔离环境验证原逻辑本身可用，纯属交互时机问题）。 */
  function attachPlDragSort(btn, pl) {
    var armed = false, dragging = false, startY = 0, pid = 0;
    btn.style.touchAction = 'none'; // 触屏/触控板也走 pointer 流
    btn.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return; // 右键交给 oncontextmenu
      pid = e.pointerId; startY = e.clientY; dragging = false; armed = true;
    });
    btn.addEventListener('pointermove', function (e) {
      if (!armed && !dragging) return;
      if (!dragging) {
        if (Math.abs(e.clientY - startY) <= 6) return; // 未过阈值：仍是潜在点击
        dragging = true;
        btn.classList.add('pl-drag-src');
        try { btn.setPointerCapture(pid); } catch (err) { }
      }
      // 找当前悬停的歌单按钮
      var over = document.elementFromPoint(e.clientX, e.clientY);
      var target = over && over.closest ? over.closest('.am-nav[data-plid]') : null;
      sb_clearPlDrop();
      if (target && target !== btn && target.dataset.plid) {
        var r = target.getBoundingClientRect();
        var before = (e.clientY - r.top) < r.height / 2;
        target.classList.add(before ? 'pl-drop-before' : 'pl-drop-after');
        btn._dropTarget = target; btn._dropBefore = before;
      } else { btn._dropTarget = null; }
    });
    function endDrag(e) {
      armed = false;
      if (!dragging) return; // 无位移=正常点击，放行
      dragging = false;
      btn.classList.remove('pl-drag-src');
      var target = btn._dropTarget, before = btn._dropBefore;
      btn._dropTarget = null;
      sb_clearPlDrop();
      try { btn.releasePointerCapture(pid); } catch (err) { }
      btn._suppressClick = true;
      setTimeout(function () { btn._suppressClick = false; }, 50);
      if (!target || !target.dataset.plid || target.dataset.plid === pl.id) return;
      // 计算新顺序：把 pl 移到 target 前/后
      var ids = S.playlists.map(function (p) { return p.id; });
      var from = ids.indexOf(pl.id), to = ids.indexOf(target.dataset.plid);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      to = ids.indexOf(target.dataset.plid);
      ids.splice(before ? to : to + 1, 0, pl.id);
      window.mine.playlistReorderList(ids).then(function (pls) { S.playlists = pls; renderSidebar(); }).catch(function () { });
    }
    btn.addEventListener('pointerup', endDrag);
    btn.addEventListener('pointercancel', endDrag);
    // 拖拽后抑制紧随的 click（避免误进歌单）
    btn.addEventListener('click', function (e) { if (btn._suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  }
  function sb_clearPlDrop() {
    if (!R.sidebar) return;
    R.sidebar.querySelectorAll('.pl-drop-before, .pl-drop-after').forEach(function (x) { x.classList.remove('pl-drop-before'); x.classList.remove('pl-drop-after'); });
  }
  // 导入 .anniepl：主进程完成匹配并建表，这里汇报匹配结果；未命中曲目清单 alert 列出
  function importPlaylistFiles() {
    window.mine.playlistImportFile().then(function (r) {
      if (!r || r.canceled) return;
      if (r.playlists) S.playlists = r.playlists;
      var oks = (r.results || []).filter(function (x) { return x.ok; });
      var bads = (r.results || []).filter(function (x) { return !x.ok; });
      if (!oks.length) {
        alert('导入失败：\n' + bads.map(function (x) { return x.file + '：' + x.error; }).join('\n'));
        renderSidebar(); return;
      }
      renderSidebar();
      var totalMiss = oks.reduce(function (s, x) { return s + (x.total - x.matched); }, 0);
      var totalMatched = oks.reduce(function (s, x) { return s + x.matched; }, 0);
      try {
        if (typeof proToast === 'function')
          proToast('📥 已导入 ' + oks.length + ' 个歌单，匹配 ' + totalMatched + ' 首' + (totalMiss ? '，' + totalMiss + ' 首未找到' : ''));
      } catch (e) { }
      if (oks.length === 1 && oks[0].id) { S.view = 'pl:' + oks[0].id; renderSidebar(); renderView(); }
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

  // V4.3.26：在线歌单导出 .anniespl（流媒体 provider+平台 ID 快照，跨机无需本地文件，联网即播）
  function exportSplFile(pl) {
    window.mine.splExportFile(pl.id).then(function (r) {
      if (!r || r.reason === 'canceled') return;
      if (r.ok) {
        try { if (typeof proToast === 'function') proToast('📤 已导出在线歌单 ' + r.count + ' 首到：' + r.path); } catch (e) { }
      } else alert('导出失败：' + (r.reason || '未知错误'));
    }).catch(function () { });
  }
  function removeSideSpl(pl) {
    if (!confirm('删除在线歌单「' + pl.name + '」？（不影响任何本地文件）')) return;
    window.mine.splDelete(pl.id).then(function (pls) {
      S.streamPlaylists = pls;
      if (S.view === 'spl:' + pl.id) S.view = 'stream';
      renderSidebar(); renderView();
    });
  }
  // 在线歌单右键菜单（复用 R.pop）
  function openSplSideMenu(x, y, pl) {
    var pop = R.pop;
    pop.innerHTML = '';
    var t = el('div', 'am-pop-head', pl.name); // V4.4：标题改不可点样式
    pop.appendChild(t);
    pop.appendChild(el('div', 'am-pop-sep'));
    var ex = el('button', 'am-pop-item', '📤 导出在线歌单…');
    ex.title = '导出为 .anniespl，可发给另一台电脑导入（流媒体曲目联网即可播放，无需本地文件）';
    ex.onclick = function () { pop.classList.remove('on'); exportSplFile(pl); };
    pop.appendChild(ex);
    var dl = el('button', 'am-pop-item', '🗑 删除在线歌单');
    dl.onclick = function () { pop.classList.remove('on'); removeSideSpl(pl); };
    pop.appendChild(dl);
    pop.classList.add('on');
    var w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - h - 12) + 'px';
  }
  // 导入 .anniespl
  function importSplFiles() {
    window.mine.splImportFile().then(function (r) {
      if (!r || r.canceled) return;
      if (r.playlists) S.streamPlaylists = r.playlists;
      var oks = (r.results || []).filter(function (x) { return x.ok; });
      var bads = (r.results || []).filter(function (x) { return !x.ok; });
      if (!oks.length) {
        alert('导入失败：\n' + bads.map(function (x) { return x.file + '：' + x.error; }).join('\n'));
        renderSidebar(); return;
      }
      renderSidebar();
      var totalImp = oks.reduce(function (s, x) { return s + x.imported; }, 0);
      var totalSkip = oks.reduce(function (s, x) { return s + (x.total - x.imported); }, 0);
      try {
        if (typeof proToast === 'function')
          proToast('📥 已导入 ' + oks.length + ' 个在线歌单，共 ' + totalImp + ' 首' + (totalSkip ? '，' + totalSkip + ' 首无效/重复已跳过' : ''));
      } catch (e) { }
      if (oks.length === 1 && oks[0].id) { S.view = 'spl:' + oks[0].id; renderSidebar(); renderView(); }
      if (bads.length) alert('以下文件解析失败：\n' + bads.map(function (x) { return '· ' + x.file + '：' + x.error; }).join('\n'));
    }).catch(function () { });
  }

  /* ===== V4.4.9：侧栏分组折叠（左侧按钮单击 / 标题双击） ===== */
  function sideGroupState() {
    var raw = null; try { raw = localStorage.getItem('annieplayer.am.sideCollapsed'); } catch (e) { }
    if (raw) { try { var a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch (e2) { } }
    return [];
  }
  function sideGroupSave(arr) { try { localStorage.setItem('annieplayer.am.sideCollapsed', JSON.stringify(arr)); } catch (e) { } }
  function sideHeadName(h) {
    var t = h.querySelector('.am-side-h-txt');
    return (h.dataset.amGrp || (t ? t.textContent : h.textContent) || '').trim();
  }
  function buildSideHead(h) {
    if (h.__amBuilt) return;
    h.__amBuilt = 1;
    var raw = (h.textContent || '').trim();
    h.textContent = '';
    var caret = el('button', 'am-side-caret', '▾');
    caret.type = 'button';
    caret.setAttribute('aria-label', '收起或展开该分组');
    caret.onclick = function (e) { e.preventDefault(); e.stopPropagation(); toggleSideGroup(h); };
    caret.ondblclick = function (e) { e.stopPropagation(); };
    var txt = el('span', 'am-side-h-txt', raw);
    h.appendChild(caret);
    h.appendChild(txt);
    h.setAttribute('role', 'button');
    h.setAttribute('tabindex', '0');
    h.title = '单击箭头或双击标题：收起 / 展开该组';
    h.addEventListener('dblclick', function (e) {
      if (e.target && e.target.closest && e.target.closest('.am-side-caret')) return;
      e.preventDefault(); e.stopPropagation(); toggleSideGroup(h);
    });
    h.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleSideGroup(h); }
    });
  }
  /* ===== V4.4.9：滚动位置记忆（侧栏 + 内容区）——重启回到上次位置 ===== */
  var SCROLL_SIDE_KEY = 'annieplayer.am.sideScroll';
  var SCROLL_VIEW_KEY = 'annieplayer.am.viewScroll';
  var _scrollDeadline = Date.now() + 60000;
  var _sideScrollDone = false, _viewScrollDone = false;
  var _userScrolled = false;   // 只有用户真的滚动过才写盘，避免启动瞬间的 0 覆盖上次位置
  function viewScrollKey() { return (S.view || '') + '|' + (S.albumKey || ''); }
  function scrollMemBind() {
    try {
      if (R.sidebar) {
        var _t1 = null;
        R.sidebar.addEventListener('scroll', function () {
          clearTimeout(_t1);
          _t1 = setTimeout(function () {
            if (!_userScrolled) return;
            try { localStorage.setItem(SCROLL_SIDE_KEY, String(Math.round(R.sidebar.scrollTop))); } catch (e) { }
          }, 250);
        });
      }
      if (R.content) {
        var _t2 = null;
        R.content.addEventListener('scroll', function () {
          clearTimeout(_t2);
          _t2 = setTimeout(function () {
            if (!_userScrolled) return;
            try { localStorage.setItem(SCROLL_VIEW_KEY, JSON.stringify({ k: viewScrollKey(), top: Math.round(R.content.scrollTop) })); } catch (e) { }
          }, 250);
        });
      }
      var markUser = function () { _userScrolled = true; S._userScrollAt = Date.now(); };
      [R.sidebar, R.content].forEach(function (el0) {
        if (!el0) return;
        el0.addEventListener('wheel', markUser, { passive: true });
        el0.addEventListener('pointerdown', markUser, { passive: true });
        el0.addEventListener('keydown', markUser, { passive: true });
      });
    } catch (e) { }
  }
  function scrollMemRestoreSide() {
    if (_userScrolled || Date.now() > _scrollDeadline) return;
    var sb = R.sidebar; if (!sb) return;
    var v = 0;
    try { v = parseInt(localStorage.getItem(SCROLL_SIDE_KEY), 10) || 0; } catch (e) { }
    if (!v) return;
    if (Math.abs(sb.scrollTop - v) > 2) sb.scrollTop = v;
  }
  function scrollMemRestoreView() {
    if (_userScrolled || Date.now() > _scrollDeadline) return;
    var c = R.content; if (!c) return;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(SCROLL_VIEW_KEY) || 'null'); } catch (e) { }
    if (!saved || !saved.top) return;
    /* 启动时视图可能是默认视图（songs），等切回目标视图再恢复；到期限再放弃 */
    if (saved.k !== viewScrollKey()) return;
    /* 持续对齐到期限：分帧渲染/窗口化校准会二次改动 scrollTop */
    if (Math.abs(c.scrollTop - saved.top) > 2) c.scrollTop = saved.top;
  }
  function scrollMemRestoreTick() {
    scrollMemRestoreSide();
    scrollMemRestoreView();
    if (_userScrolled || Date.now() > _scrollDeadline) return;
    setTimeout(scrollMemRestoreTick, 200);
  }
  function applySideGroups(sb) {
    var closed = sideGroupState();
    var cur = null;
    for (var i = 0; i < sb.children.length; i++) {
      var n = sb.children[i];
      if (n.classList && n.classList.contains('am-side-h')) {
        cur = n;
        buildSideHead(n);
        var name = sideHeadName(n);
        n.dataset.amGrp = name;
        var off = closed.indexOf(name) >= 0;
        n.classList.toggle('am-grp-off', off);
        n.setAttribute('aria-expanded', off ? 'false' : 'true');
        var c = n.querySelector('.am-side-caret');
        if (c) c.textContent = off ? '▸' : '▾';
        continue;
      }
      if (cur && !(n.classList && n.classList.contains('am-search'))) {
        n.classList.toggle('am-grp-hidden', cur.classList.contains('am-grp-off'));
      }
    }
    queueSideSticky();   // V4.4.9：侧栏重绘后主动同步吸顶状态（否则切歌单后要滚一下才恢复）
    scrollMemRestoreSide(); // V4.4.9：侧栏构建完成后恢复滚动位置
  }
  function toggleSideGroup(h) {
    var name = sideHeadName(h);
    if (!name) return;
    var closed = sideGroupState();
    var i = closed.indexOf(name);
    var on = i >= 0;
    if (i >= 0) closed.splice(i, 1); else closed.push(name);
    sideGroupSave(closed);
    h.classList.toggle('am-grp-off', !on);
    h.setAttribute('aria-expanded', on ? 'true' : 'false');
    var c = h.querySelector('.am-side-caret');
    if (c) c.textContent = on ? '▾' : '▸';
    var n = h.nextElementSibling;
    while (n && !n.classList.contains('am-side-h')) {
      if (n.classList.contains('am-search')) break;
      n.classList.toggle('am-grp-hidden', !on);
      n = n.nextElementSibling;
    }
  }
  /* ===== V4.4.9：歌曲 / 播放列表按专辑分组（组序固定专辑名 A–Z，组内按当前排序） ===== */
  var AM_GRP_H = 52, AM_GRP_ROW_H = 40;
  function amSongGroupOn() {
    var v = S.view || '';
    return (v === 'songs' || v === 'favorites' || v.indexOf('pl:') === 0) &&
      !!(window.annieSettings && window.annieSettings.ui && window.annieSettings.ui.amSongGroup);
  }
  function grpCollapsedSet() { return S._grpCollapsed || (S._grpCollapsed = new Set()); }
  function isGrpCollapsed(g) { return !!g && grpCollapsedSet().has(g.id); }
  function expandGrp(g) { if (g) grpCollapsedSet().delete(g.id); }
  function toggleGrp(g) {
    if (!g) return;
    var s = grpCollapsedSet();
    if (s.has(g.id)) s.delete(g.id); else s.add(g.id);
    /* 折叠/展开只改变行数，保持当前滚动位置（此前 renderView 会跳回顶部） */
    renderKeepScroll();
  }
  function grpSub(g, aa) {
    var m = S.meta[g.first.path] || {};
    var bits = [];
    var a = aa || m.albumArtist || '';
    if (a) bits.push(a);
    bits.push(g.list.length + ' 首');
    if (m.year) bits.push(m.year);
    return bits.join(' · ');
  }
  function applyGrpMeta(m, cover, sub, g) {
    if (cover && !cover.querySelector('img') && m && m.cover) {
      cover.textContent = '';
      var im = el('img'); im.alt = ''; im.loading = 'lazy'; im.draggable = false; im.src = m.cover;
      cover.appendChild(im);
    }
    if (sub) sub.textContent = grpSub(g, (m && m.albumArtist) || '');
  }
  function fillGrpMeta(g, cover, sub) {
    var p = g.first.path;
    var cached = S.meta[p] || {};
    if (cached._full) { applyGrpMeta(cached, cover, sub, g); return; }
    if (!window.mine.metaFullBatch) {
      albumCover(g.first, function (url) { if (url) applyGrpMeta({ cover: url }, cover, sub, g); });
      return;
    }
    var q = S._grpFullQ || (S._grpFullQ = {});
    if (q[p]) { q[p].push(function (m) { applyGrpMeta(m, cover, sub, g); }); return; }
    q[p] = [function (m) { applyGrpMeta(m, cover, sub, g); }];
    window.mine.metaFullBatch([p]).then(function (out) {
      var m = (out && out[p]) || {};
      m._full = 1;
      S.meta[p] = Object.assign({}, S.meta[p] || {}, m);
      var ws = q[p] || []; delete q[p];
      ws.forEach(function (f) { try { f(m); } catch (e) { } });
    }).catch(function () { delete q[p]; });
  }
  function buildGroupEntries(tracks) {
    var groups = [], idxOf = {}, grp = null;
    tracks.forEach(function (t, i) {
      idxOf[t.path] = i;
      var key = trackMeta(t).album || '未知专辑';
      if (!grp || grp.key !== key) {
        grp = { key: key, id: 'g:' + t.path, first: t, list: [] };
        groups.push(grp);
      }
      grp.list.push(t);
    });
    var manual = grpOrderGet();
    S._grpManualOn = !!(manual && manual.length);
    if (manual && manual.length) {
      var pos = {}, mk;
      for (mk = 0; mk < manual.length; mk++) pos[manual[mk]] = mk;
      groups.forEach(function (g, i) { g._i = i; });
      groups.sort(function (a, b) {
        var pa = pos[a.key], pb = pos[b.key];
        if (pa === undefined) pa = 1e9 + a._i;
        if (pb === undefined) pb = 1e9 + b._i;
        return pa - pb;
      });
    }
    var entries = [];
    groups.forEach(function (g) {
      entries.push({ k: 'h', grp: g });
      g.list.forEach(function (t) { entries.push({ k: 't', t: t, i: idxOf[t.path], grp: g }); });
    });
    /* V4.4.9：不再自动展开「当前播放曲目所在组」，允许收起（Tab 全收起也生效） */
    var offsets = new Array(entries.length), y = 0;
    entries.forEach(function (e, k) {
      offsets[k] = y;
      y += e.k === 'h' ? AM_GRP_H : (isGrpCollapsed(e.grp) ? 0 : AM_GRP_ROW_H);
    });
    var trkEntry = new Array(tracks.length);
    entries.forEach(function (e, k) { if (e.k === 't') trkEntry[e.i] = k; });
    return { entries: entries, offsets: offsets, totalH: y, trkEntry: trkEntry };
  }
  function lowerBound(arr, v) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >>> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function buildGroupRow(g) {
    var tr = el('tr', 'am-grp-tr');
    var collapsed = isGrpCollapsed(g);
    if (collapsed) tr.classList.add('am-grp-collapsed');
    tr.dataset.grpid = g.id;
    tr.dataset.gkey = g.key;
    if (grpDragAllowed()) tr.classList.add('am-grp-draggable');
    if (S.msOn) {
      var tdGck = el('td', 'am-grp-ckcell');
      var gck = document.createElement('input');
      gck.type = 'checkbox';
      gck.className = 'am-ms-ck am-grp-ck';
      gck.title = '选中本组全部歌曲';
      gck.checked = !!(S.msSel && g.list.length && g.list.every(function (x) { return S.msSel.has(x.path); }));
      gck.onclick = function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (!S.msSel) S.msSel = new Set();
        if (gck.checked) g.list.forEach(function (x) { S.msSel.add(x.path); });
        else g.list.forEach(function (x) { S.msSel.delete(x.path); });
        renderKeepScroll();
      };
      tdGck.appendChild(gck);
      tr.appendChild(tdGck);
    }
    // V4.4.9：封面单独占左列表头「封面」，组内歌曲在封面右侧
    var tdCover = el('td', 'am-grp-covercell');
    var cover = el('div', 'am-grp-cover');
    tdCover.appendChild(cover);
    tr.appendChild(tdCover);
    albumCover(g.first, function (url) {
      if (!url || cover.querySelector('img')) return;
      var im = el('img'); im.alt = ''; im.loading = 'lazy'; im.draggable = false; im.src = url;
      cover.appendChild(im);
    });
    var tdInfo = el('td', 'am-grp-infocell');
    tdInfo.colSpan = 99;
    var box = el('div', 'am-grp-box' + (collapsed ? ' off' : ''));
    var info = el('div', 'am-grp-info');
    info.appendChild(el('div', 'am-grp-name', g.key));
    var sub = el('div', 'am-grp-sub', grpSub(g));
    info.appendChild(sub);
    box.appendChild(info);
    tdInfo.appendChild(box);
    tr.appendChild(tdInfo);
    tr.ondblclick = function (e) { e.preventDefault(); e.stopPropagation(); toggleGrp(g); };
    tr.oncontextmenu = function (e) {
      e.preventDefault(); e.stopPropagation();
      selectGroup(g, e.ctrlKey || e.metaKey);
      if (g.list && g.list.length) openAddMenu(e.clientX, e.clientY, g.list[0].path);
    };
    fillGrpMeta(g, cover, sub);
    bindGrpDrag(tr, g);
    return tr;
  }
  function currentGrpIds() {
    var w = S._tbl;
    if (w && w.grp && w.entries) {
      var ids = [];
      w.entries.forEach(function (e) { if (e.k === 'h') ids.push(e.grp.id); });
      if (ids.length) return ids;
    }
    // 非窗口化分组（≤300 首）：从 DOM 取组 id
    var trs = document.querySelectorAll('#am-root .am-grp-tr');
    if (!trs.length) return null;
    var out = [];
    for (var i = 0; i < trs.length; i++) if (trs[i].dataset.grpid) out.push(trs[i].dataset.grpid);
    return out.length ? out : null;
  }
  function toggleAllGrps() {
    var ids = currentGrpIds();
    if (!ids) return false;
    var s = grpCollapsedSet();
    if (s.size) s.clear();
    else for (var i = 0; i < ids.length; i++) s.add(ids[i]);
    renderKeepScroll();
    return true;
  }
  if (!window.__amGrpTab) {
    window.__amGrpTab = 1;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
      if (!amSongGroupOn()) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (S.msOn) return;
      if (toggleAllGrps()) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }
  function selectGroup(g, additive) {
    if (!g) return;
    if (!additive || !S.msSel) S.msSel = new Set();
    g.list.forEach(function (t) { S.msSel.add(t.path); });
    if (g.list.length) S._selAnchor = g.list[0].path;
    /* V4.4.9：保留滚动位置（否则右键组头会跳回顶部） */
    var c = document.querySelector('#am-root .am-content');
    var sc = c ? c.scrollTop : 0;
    renderView();
    if (c) {
      void c.scrollHeight;
      c.scrollTop = sc;
      if (S._tbl) { S._tbl.lastStart = -1; if (typeof renderAmWindow === 'function') renderAmWindow(); }
    }
  }
  function renderAmWindowGrp(win, c) {
    var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
    var base = win.tb.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop + headH;
    var st = c.scrollTop, h = c.clientHeight, y0 = st - base;
    var start = Math.max(0, lowerBound(win.offsets, y0) - AM_OVERSCAN);
    var end = Math.min(win.entries.length, lowerBound(win.offsets, y0 + h) + AM_OVERSCAN);
    if (start === win.lastStart && end === win.lastEnd) return;
    win.lastStart = start; win.lastEnd = end;
    var frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(amSpacerRow(win.offsets[start], win.cols));
    for (var k = start; k < end; k++) {
      var e = win.entries[k];
      if (e.k === 'h') frag.appendChild(buildGroupRow(e.grp));
      else if (!isGrpCollapsed(e.grp)) frag.appendChild(buildTrackRow(e.t, e.i, win.opts));
    }
    if (end < win.entries.length) frag.appendChild(amSpacerRow(win.totalH - win.offsets[end], win.cols));
    win.body.innerHTML = '';
    win.body.appendChild(frag);
    var ti = -1;
    for (var j = start; j >= 0; j--) { if (win.entries[j].k === 't') { ti = win.entries[j].i; break; } }
    if (ti >= 0) azSyncActive(win, ti);
  }
  function renderGroupRows(body, grp, opts) {
    grp.entries.forEach(function (e) {
      if (e.k === 'h') body.appendChild(buildGroupRow(e.grp));
      else if (!isGrpCollapsed(e.grp)) body.appendChild(buildTrackRow(e.t, e.i, opts));
    });
  }
  /* V4.4.9：侧栏标题吸顶——只在真正吸住时加半透明底，平时保持无底 */
  function syncSideSticky() {
    var side = document.querySelector('#am-root .am-side');
    if (!side) return;
    var sr = side.getBoundingClientRect();
    var stuck = side.scrollTop > 0;
    var hs = side.querySelectorAll('.am-side-h');
    for (var i = 0; i < hs.length; i++) {
      var r = hs[i].getBoundingClientRect();
      hs[i].classList.toggle('am-h-stuck', stuck && r.top <= sr.top + 9);
    }
    syncSideThumb();
  }
  /* 侧栏宽度变化（拖分栏 / 折叠轨 / 窗口缩放）时同步悬浮滚动条位置——
     拖分栏不触发 window resize，此前 thumb 会停在旧位置，看起来跑到左边 */
  var _sideRO = null;
  function watchSideSize() {
    try {
      var side = document.querySelector('#am-root .am-side');
      if (!side || !window.ResizeObserver || _sideRO) return;
      _sideRO = new ResizeObserver(function () { queueSideSticky(); });
      _sideRO.observe(side);
    } catch (e) { }
  }
  var _sideStkRaf = 0;
  function queueSideSticky() {
    if (_sideStkRaf) return;
    _sideStkRaf = requestAnimationFrame(function () { _sideStkRaf = 0; syncSideSticky(); });
  }
  document.addEventListener('scroll', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('am-side')) { queueSideSticky(); showSideThumb(); }
  }, true);
  window.addEventListener('resize', queueSideSticky);
  /* V4.4.9：侧栏悬浮滚动条——鼠标在侧栏内出现，移动保持，停一会隐藏，移出立刻隐藏；拖动期间常显 */
  var _sideThumbHide = 0, _sideThumbDrag = false;
  function ensureSideThumb() {
    var root = document.getElementById('am-root');
    if (!root) return null;
    var t = root.querySelector('.am-side-thumb');
    if (t) return t;
    t = document.createElement('div');
    t.className = 'am-side-thumb';
    root.appendChild(t);
    t.addEventListener('mouseenter', function () { showSideThumb(); });
    t.addEventListener('mousedown', function (e) {
      e.preventDefault();
      _sideThumbDrag = true;
      clearTimeout(_sideThumbHide);
      t.classList.add('on');
      var side = document.querySelector('#am-root .am-side');
      if (!side) return;
      var startY = e.clientY, startTop = side.scrollTop;
      var trackH = side.clientHeight - t.offsetHeight;
      var maxTop = side.scrollHeight - side.clientHeight;
      var move = function (ev) {
        if (trackH > 0) side.scrollTop = startTop + (ev.clientY - startY) / trackH * maxTop;
      };
      var up = function () {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        _sideThumbDrag = false;
        showSideThumb();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    return t;
  }
  function showSideThumb() {
    var t = ensureSideThumb();
    if (!t || t.style.display === 'none') return;
    t.classList.add('on');
    clearTimeout(_sideThumbHide);
    if (!_sideThumbDrag) _sideThumbHide = setTimeout(function () { t.classList.remove('on'); }, 900);
  }
  function hideSideThumb() {
    var t = document.querySelector('#am-root .am-side-thumb');
    if (!t || _sideThumbDrag) return;
    clearTimeout(_sideThumbHide);
    t.classList.remove('on');
  }
  function syncSideThumb() {
    var side = document.querySelector('#am-root .am-side');
    var t = ensureSideThumb();
    if (!side || !t) return;
    var sh = side.scrollHeight, ch = side.clientHeight;
    if (sh <= ch + 2) { t.classList.remove('on'); t.style.display = 'none'; return; }
    t.style.display = '';
    var sr = side.getBoundingClientRect();
    var h = Math.max(26, Math.round(ch * ch / sh));
    var maxTop = sh - ch;
    var y = sr.top + (maxTop ? (side.scrollTop / maxTop) * (ch - h) : 0);
    t.style.height = h + 'px';
    t.style.top = Math.round(y) + 'px';
    t.style.right = Math.max(2, Math.round(window.innerWidth - sr.right + 2)) + 'px';
  }
  document.addEventListener('mousemove', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    if (el.closest('.am-side') || el.closest('.am-side-thumb')) showSideThumb();
  }, true);
  document.addEventListener('mouseout', function (e) {
    var el = e.target, to = e.relatedTarget;
    if (!el || !el.closest || !el.closest('.am-side')) return;
    if (!to || !to.closest || (!to.closest('.am-side') && !to.closest('.am-side-thumb'))) hideSideThumb();
  }, true);
  function renderSidebar() {
    if (!R.sidebar) return;
    var sb = R.sidebar;
    sb.innerHTML = '';

    function nav(icon, name, view) {
      var b = el('button', 'am-nav' + (S.view === view && !S.albumKey && !S.folderPath ? ' cur' : ''));
      b.appendChild(el('span', 'am-nav-ico', icon));
      b.appendChild(el('span', 'am-nav-name', name));
      b.onclick = function () { S.view = view; S.albumKey = null; S.folderPath = null; renderSidebar(); renderView(); };
      return b;
    }

    sb.appendChild(el('div', 'am-side-h', '媒体库'));
    sb.appendChild(nav('🔍', '在线音乐', 'stream'));
    sb.appendChild(nav('⬇', '下载情况', 'downloads')); // V4.3.22：下载任务管理（洛雪式五标签）
    sb.appendChild(nav('🔷', 'Qobuz', 'qobuz')); // V4.3.6：Qobuz 在线播放/下载（登录自己的付费账号）
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
    // V4.3.26：图标位换首曲封面（批量 metaFullBatch 异步取，无封面保留 🎧）+ 长按拖拽排序
    // V4.4：封面缓存同步回填——切歌时 renderCurrentView 包装链会连带重建侧栏（am-render.js wrapGlobal），
    // 旧实现每次重建都重新 metaFullBatch + 🎧占位→封面异步交换，侧栏每切一首歌就抽搐闪烁一次。
    // 现按 歌单id+首曲path 缓存封面 dataURL，命中即同步渲染（浏览器内存缓存秒显，无占位交换）。
    var plCoverCache = S.plCoverCache || (S.plCoverCache = {});
    var plFirstPaths = [];
    S.playlists.forEach(function (pl) {
      var b = nav('🎧', pl.name, 'pl:' + pl.id);
      b.dataset.plid = pl.id;
      // 首曲封面：缓存命中同步渲染，未命中入批量回填队列
      var firstPath = (pl.paths || [])[0];
      if (firstPath) {
        var ck = pl.id + '|' + firstPath;
        if (plCoverCache[ck]) {
          var ico0 = b.querySelector('.am-nav-ico');
          if (ico0) {
            var cv0 = el('img'); cv0.alt = ''; cv0.loading = 'lazy'; cv0.draggable = false;
            cv0.style.cssText = 'width:18px;height:18px;border-radius:4px;object-fit:cover;flex:none';
            cv0.src = plCoverCache[ck];
            ico0.textContent = ''; ico0.appendChild(cv0);
          }
        } else if (plCoverCache[ck] !== '') plFirstPaths.push([pl.id, firstPath, b, ck]);
      }
      var del = el('button', 'am-nav-del', '✕');
      del.title = '删除播放列表（右键歌单可导出 .anniepl 换机复现）';
      del.onclick = function (e) {
        e.stopPropagation();
        removeSidePlaylist(pl);
      };
      b.appendChild(del);
      // V4.3.25：右键歌单——导出 .anniepl / 删除
      b.oncontextmenu = function (e) {
        e.preventDefault(); e.stopPropagation();
        openPlSideMenu(e.clientX, e.clientY, pl);
      };
      // V4.3.26：长按拖拽排序（400ms 长按进入拖拽，拖到目标位置松手插入；与单击/右键共存）
      attachPlDragSort(b, pl);
      // V4.4：拖外部音频文件到侧栏歌单直接加入
      b.addEventListener('dragover', function (e) {
        if (!plDropHasFiles(e)) return;
        e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (er) { }
        b.classList.add('am-nav-drop');
      });
      b.addEventListener('dragleave', function () { b.classList.remove('am-nav-drop'); });
      b.addEventListener('drop', async function (e) {
        if (!plDropHasFiles(e)) return;
        e.preventDefault(); e.stopPropagation(); b.classList.remove('am-nav-drop');
        var paths = await plExpandDropped(e);
        addDroppedToPlaylist(pl.id, paths);
      });
      sb.appendChild(b);
    });
    // 批量回填首曲封面（仅未命中缓存的；结果写缓存，无论有无封面——'' 表示「查过，无封面」）
    if (plFirstPaths.length && window.mine.metaFullBatch) {
      window.mine.metaFullBatch(plFirstPaths.map(function (x) { return x[1]; })).then(function (map) {
        plFirstPaths.forEach(function (x) {
          var cover = map && map[x[1]] && map[x[1]].cover;
          plCoverCache[x[3]] = cover || '';
          if (!cover) return;
          var ico = x[2].querySelector('.am-nav-ico');
          if (!ico) return;
          var cv = el('img'); cv.alt = ''; cv.loading = 'lazy'; cv.draggable = false;
          cv.style.cssText = 'width:18px;height:18px;border-radius:4px;object-fit:cover;flex:none';
          cv.src = cover; cv.onerror = function () { cv.style.visibility = 'hidden'; };
          ico.textContent = ''; ico.appendChild(cv);
        });
      }).catch(function () { });
    }
    var add = el('button', 'am-nav am-new');
    add.appendChild(el('span', 'am-nav-ico', '＋'));
    add.appendChild(el('span', 'am-nav-name', '新建播放列表'));
    add.onclick = function () {
      amPrompt('播放列表名称', '新建播放列表', function (name) {
        window.mine.playlistCreate(name).then(function (pls) {
          S.playlists = pls;
          S.view = 'pl:' + pls[pls.length - 1].id;
          renderSidebar(); renderView();
        });
      });
    };
    sb.appendChild(add);

    // V4.4.6：三个导入入口合并为「导入播放列表…」——点击弹选择层（复用共享弹层 R.pop），
    // 用户先选导入类型（FPL / M3U / 安妮歌单），再引导到文件选择。
    var impBtn = el('button', 'am-nav am-new');
    impBtn.appendChild(el('span', 'am-nav-ico', '📥'));
    impBtn.appendChild(el('span', 'am-nav-name', '导入播放列表…'));
    impBtn.title = '导入外部播放列表：foobar2000 (.fpl) / M3U (.m3u/.m3u8) / 安妮歌单 (.anniepl)';
    impBtn.onclick = function (e) {
      e.stopPropagation();
      var rect = impBtn.getBoundingClientRect();
      openImportMenu(rect.right + 8, rect.top);
    };
    sb.appendChild(impBtn);

    /* 导入类型选择弹层（共享弹层 R.pop，外点关闭由全局监听负责） */
    function openImportMenu(x, y) {
      var pop = R.pop;
      pop.innerHTML = '';
      pop.appendChild(el('div', 'am-pop-head', '选择导入格式'));
      pop.appendChild(el('div', 'am-pop-sep'));
      var items = [
        ['🎵', 'foobar2000 播放列表 (.fpl)', '从 foobar2000 导出的 .fpl 文件', doImportFpl],
        ['📄', 'M3U 播放列表 (.m3u / .m3u8)', '通用播放列表格式，多数播放器支持导出', doImportM3u],
        ['📦', '安妮歌单 (.anniepl)', '另一台电脑的安妮播放器导出（含标签指纹匹配）', function () { importPlaylistFiles(); }],
      ];
      items.forEach(function (it) {
        var btn = el('button', 'am-pop-item');
        btn.appendChild(el('span', '', it[0] + ' ' + it[1]));
        btn.title = it[2];
        btn.onclick = function () { pop.classList.remove('on'); it[3](); };
        pop.appendChild(btn);
      });
      pop.classList.add('on');
      var w = pop.offsetWidth, h = pop.offsetHeight;
      pop.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
      pop.style.top = Math.min(y, window.innerHeight - h - 12) + 'px';
    }

    // FPL 导入（原 impFpl.onclick 逻辑原样保留）
    function doImportFpl() {
      // 首次使用给引导：fpl 默认在 fb2k 配置目录，不在歌曲文件夹里
      try {
        if (localStorage.getItem('annieplayer.fplGuide') !== '1') {
          var go = confirm(
            '安妮播放器会在每次扫描曲库时，自动导入媒体库文件夹内的 foobar2000 播放列表（.fpl）。\n\n' +
            '但 foobar2000 默认把播放列表保存在自己的配置目录：\n%AppData%\\foobar2000\\playlists-v2.0\\（老版本为 playlists-v1.4）\n通常和你的歌曲文件夹不在一起，所以自动识别可能找不到。\n\n' +
            '想自动同步的话：在 foobar2000 里右键播放列表页签 → 另存为，把 .fpl 存到任一媒体库文件夹内，' +
            '下次扫描即自动导入；之后在 fb2k 里改了歌单重新另存一次，安妮会跟随更新。\n\n' +
            '点「确定」立即手动选择 .fpl 文件导入（可一次多选）。');
          localStorage.setItem('annieplayer.fplGuide', '1');
          if (!go) return;
        }
      } catch (e) { }
      window.mine.fplImport().then(function (r) {
        if (!r || r.canceled) return;
        if (r.playlists) S.playlists = r.playlists;
        var oks = (r.results || []).filter(function (x) { return x.ok; });
        var fails = (r.results || []).length - oks.length;
        var total = oks.reduce(function (s, x) { return s + x.count; }, 0);
        var msg = oks.length ? ('已导入 ' + oks.length + ' 个播放列表（共 ' + total + ' 首）') : '';
        if (fails) msg += (msg ? '，' : '') + fails + ' 个解析失败';
        try { if (msg && typeof proToast === 'function') proToast(msg); } catch (e) { }
        if (oks.length === 1) {
          var last = S.playlists[S.playlists.length - 1];
          if (last) { S.view = 'pl:' + last.id; renderSidebar(); renderView(); return; }
        }
        renderSidebar();
      }).catch(function () { });
    }

    // M3U/M3U8 导入
    function doImportM3u() {
      window.mine.m3uImport().then(function (r) {
        if (!r || r.canceled) return;
        if (r.playlists) S.playlists = r.playlists;
        var oks = (r.results || []).filter(function (x) { return x.ok; });
        var fails = (r.results || []).length - oks.length;
        var total = oks.reduce(function (s, x) { return s + x.count; }, 0);
        var msg = oks.length ? ('已导入 ' + oks.length + ' 个播放列表（共 ' + total + ' 首）') : '';
        if (fails) msg += (msg ? '，' : '') + fails + ' 个解析失败';
        try { if (msg && typeof proToast === 'function') proToast(msg); } catch (e) { }
        if (oks.length === 1) {
          var last = S.playlists[S.playlists.length - 1];
          if (last) { S.view = 'pl:' + last.id; renderSidebar(); renderView(); return; }
        }
        renderSidebar();
      }).catch(function () { });
    }

    // V4.3.5：在线歌单（流媒体收藏；与本地播放列表并列但互不相混）
    sb.appendChild(el('div', 'am-side-h', '在线歌单'));
    (S.streamPlaylists || []).forEach(function (pl) {
      var b = nav('☁️', pl.name, 'spl:' + pl.id);
      // V4.4：图标位换「第一首有封面的曲目」小封面（对齐本地歌单）；http 图走主进程代理（酷我 CDN 证书/CSP 拦截）
      var fc = '';
      for (var fi = 0; pl.items && fi < pl.items.length; fi++) {
        var sg = pl.items[fi] && pl.items[fi].song;
        if (sg && sg.cover) { fc = sg.cover; break; }
      }
      if (fc && AM.setStreamImg) {
        var ico = b.querySelector('.am-nav-ico');
        var cv = el('img'); cv.alt = ''; cv.loading = 'lazy'; cv.draggable = false;
        cv.style.cssText = 'width:18px;height:18px;border-radius:4px;object-fit:cover;flex:none';
        ico.textContent = ''; ico.appendChild(cv);
        AM.setStreamImg(cv, fc, function () { if (ico.isConnected) ico.textContent = '☁️'; });
      }
      var del = el('button', 'am-nav-del', '✕');
      del.title = '删除在线歌单（右键可导出 .anniespl 换机复现）';
      del.onclick = function (e) {
        e.stopPropagation();
        removeSideSpl(pl);
      };
      b.appendChild(del);
      // V4.3.26：右键在线歌单——导出 .anniespl / 删除
      b.oncontextmenu = function (e) {
        e.preventDefault(); e.stopPropagation();
        openSplSideMenu(e.clientX, e.clientY, pl);
      };
      sb.appendChild(b);
    });
    var addSpl = el('button', 'am-nav am-new');
    addSpl.appendChild(el('span', 'am-nav-ico', '＋'));
    addSpl.appendChild(el('span', 'am-nav-name', '新建在线歌单'));
    addSpl.onclick = function () {
      amPrompt('在线歌单名称', '新建在线歌单', function (name) {
        window.mine.splCreate(name).then(function (pls) {
          S.streamPlaylists = pls;
          S.view = 'spl:' + pls[pls.length - 1].id;
          renderSidebar(); renderView();
        });
      });
    };
    sb.appendChild(addSpl);
    // V4.3.26：导入在线歌单文件（.anniespl，另一台电脑导出；流媒体曲目联网即可播放）
    var impSpl = el('button', 'am-nav am-new');
    impSpl.appendChild(el('span', 'am-nav-ico', '📥'));
    impSpl.appendChild(el('span', 'am-nav-name', '导入在线歌单…'));
    impSpl.title = '导入 .anniespl 在线歌单（另一台电脑导出）；流媒体曲目存平台 ID，联网即可播放，无需本地文件，可多选批量导入';
    impSpl.onclick = function () { importSplFiles(); };
    sb.appendChild(impSpl);

    // 收藏的平台歌单（歌单广场 ☆ 收藏歌单 的来源；localStorage，am-stream 片提供存取与跳转）
    var slFavs = AM.slFavs ? AM.slFavs() : [];
    if (slFavs.length) {
      sb.appendChild(el('div', 'am-side-h', '收藏的歌单'));
      slFavs.forEach(function (f) {
        var b = el('button', 'am-nav');
        b.appendChild(el('span', 'am-nav-ico', '🎵'));
        // V4.4：图标位换歌单封面（收藏时存 f.img，详情加载自愈补齐；http 走代理）
        if (f.img && AM.setStreamImg) {
          var fico = b.querySelector('.am-nav-ico');
          var fcv = el('img'); fcv.alt = ''; fcv.loading = 'lazy'; fcv.draggable = false;
          fcv.style.cssText = 'width:18px;height:18px;border-radius:4px;object-fit:cover;flex:none';
          fico.textContent = ''; fico.appendChild(fcv);
          AM.setStreamImg(fcv, f.img, function () { if (fico.isConnected) fico.textContent = '🎵'; });
        }
        var pf = (AM.PLATFORMS && AM.PLATFORMS[f.provider]) ? AM.PLATFORMS[f.provider].replace('音乐', '') : f.provider;
        b.appendChild(el('span', 'am-nav-name', pf + ' · ' + f.name));
        b.onclick = function () { if (AM.openFavSongList) AM.openFavSongList(f); };
        var del = el('button', 'am-nav-del', '✕');
        del.title = '取消收藏';
        del.onclick = function (e) {
          e.stopPropagation();
          if (!AM.slFavSave) return;
          AM.slFavSave(AM.slFavs().filter(function (v) { return !(v.id === f.id && v.provider === f.provider); }));
          renderSidebar(); renderView();
        };
        b.appendChild(del);
        sb.appendChild(b);
      });
    }

    // 本地搜索（AM 语义：全库搜索；输入即切回歌曲视图并深加载全库标签）
    var sch = el('div', 'am-search');
    sch.appendChild((function () {
      var sp = document.createElement('span'); sp.className = 'am-search-ico';
      sp.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 L14 14"/></svg>';
      return sp;
    })());
    var inp = document.createElement('input');
    inp.placeholder = '搜索歌曲、艺人、专辑'; inp.value = S.search;
    // V4.3.24：IME 组词期间不切视图/不重绘（renderSidebar 会重建本框，同样打断中文输入）
    function commitSideSearch() {
      S.search = inp.value.trim();
      if (S.search) {
        // 搜索是全库行为：专辑网格/文件夹列表/在线搜索里输入时切回歌曲列表
        /* 专辑视图不跳走：搜索词直接用于过滤专辑（视图内搜索框仍只匹配专辑名） */
        if (S.view === 'stream' || (S.view === 'folders' && !S.folderPath)) {
          S.view = 'songs'; S.albumKey = null; S.folderPath = null;
          var pos = inp.selectionStart;
          renderSidebar(); // 侧栏重建会换新搜索框——恢复焦点与光标，保证连续输入
          var ni = R.sidebar && R.sidebar.querySelector('.am-search input');
          if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch (e) { } }
        }
        ensureMetaDeep(); // 后台分块补齐全库标签（metaCache 持久化，仅首次有成本）
      }
      // 防抖：打字过程中不整表重绘，150ms 静默后一次性渲染
      clearTimeout(S._schT);
      S._schT = setTimeout(renderView, 150);
    }
    inp.addEventListener('compositionstart', function () { inp._ime = true; });
    inp.addEventListener('compositionend', function () { inp._ime = false; commitSideSearch(); });
    inp.oninput = function () { if (inp._ime) return; commitSideSearch(); };
    sch.appendChild(inp); sb.appendChild(sch);
    applySideGroups(sb);
    watchSideSize();   // 观察侧栏尺寸，宽度变化时重算悬浮滚动条位置
  }

  /* ---------------- 内容区 ---------------- */
  /* V4.3.22：视图头部共享构建器——标题 + 视图内搜索框 + 排序下拉（歌曲/专辑/喜爱歌曲共用）。
   * 搜索框匹配字段跟随当前排序方式（标题排序搜标题、演唱者排序搜演唱者……），
   * 查询串存 S.viewQuery[view]（会话级），输入 150ms 防抖重绘。 */
  var SONG_SORT_OPTS = [['az', '首字母 A–Z（标题）'], ['albumAz', '专辑名 A–Z'], ['azArtist', '首字母 A–Z（演唱者）'], ['name', '文件名'],
    ['mtimeDesc', '修改时间 · 新→旧'], ['mtimeAsc', '修改时间 · 旧→新'],
    ['ctimeDesc', '创建时间 · 新→旧'], ['ctimeAsc', '创建时间 · 旧→新'], ['sizeDesc', '大小 · 大→小'], ['sizeAsc', '大小 · 小→大']];
  var ALBUM_SORT_OPTS = [['az', '名称 A–Z'], ['azArtist', '艺人 A–Z'], ['countDesc', '曲目数 · 多→少'], ['countAsc', '曲目数 · 少→多']];
  // V4.4.3：专辑详情页（进入某张专辑后）曲目排序——默认按发布顺序（碟号+曲目号标签）
  var ALBUM_DETAIL_SORT_OPTS = [['release', '按专辑发布顺序'], ['az', '标题 A–Z'], ['azArtist', '演唱者 A–Z'], ['name', '文件名'], ['durDesc', '时长 · 长→短'], ['durAsc', '时长 · 短→长']];
  function viewQuery(view) { return (S.viewQuery && S.viewQuery[view]) || ''; }
  /* V4.3.24：带搜索框三视图的头部身份键（视图 + 排序）。同键重绘复用旧头部 DOM——
     搜索框不被重建，中文 IME 组词会话/焦点/光标原位保留；排序切换后键变化，头部按新配置重建。
     （教训：曾在 oninput 防抖后 innerHTML 整体重绘，英文直接上屏无感，中文 composition 被掐断，
      表现为只能逐字母上屏、无法选字。） */
  function headKeyFor() {
    if (S.view === 'songs' && AM.songSortMode) return 'songs#' + AM.songSortMode();
    if (S.view === 'favorites' && AM.favSortMode) return 'favorites#' + AM.favSortMode();
    if (S.view === 'albums' && !S.albumKey && AM.albumSortMode) return 'albums#' + AM.albumSortMode();
    if (S.view === 'albums' && S.albumKey && AM.albumDetailSortMode) return 'albumDetail#' + S.albumKey + '#' + AM.albumDetailSortMode(); // V4.4.3
    return null;
  }
  function buildViewHead(title, cfg) {
    var head = el('div', 'am-view-head');
    head.dataset.hkey = cfg.view + '#' + (cfg.sort ? cfg.sort.value : '');
    head.appendChild(el('div', 'am-view-h', title));
    if (cfg.search) {
      var inp = document.createElement('input');
      inp.className = 'am-view-search';
      inp.placeholder = cfg.search.placeholder;
      inp.value = viewQuery(cfg.view);
      // IME 组词期间（compositionstart→compositionend）不索引、不重绘；
      // 汉字上屏 compositionend 后再提交过滤，避免组词过程被重绘打断
      function commitSearch() {
        S.viewQuery = S.viewQuery || {};
        S.viewQuery[cfg.view] = inp.value.trim();
        var pos = inp.selectionStart;
        clearTimeout(S._vqT);
        S._vqT = setTimeout(function () {
          renderView();
          // 头部复用时 inp 原位保留、焦点不动；仅头部被重建（切排序/切视图）时恢复焦点与光标
          if (!inp.isConnected) {
            var el2 = R.content && R.content.querySelector('.am-view-search');
            if (el2) { el2.focus(); try { el2.setSelectionRange(pos, pos); } catch (e) { } }
          }
        }, 150);
      }
      inp.addEventListener('compositionstart', function () { inp._ime = true; });
      inp.addEventListener('compositionend', function () { inp._ime = false; commitSearch(); });
      inp.oninput = function () { if (inp._ime) return; commitSearch(); };
      head.appendChild(inp);
    }
    if (cfg.sort) {
      head.appendChild(sortDropdown(cfg.sort.opts, cfg.sort.value, function (v) {
        if (window.annieSettings) { annieSettings.ui[cfg.sort.key] = v; annieSettings.save(); }
        renderView();
      }));
    }
    return head;
  }
  /* 搜索框占位符：明示当前匹配字段（跟随排序方式） */
  /* V4.4.7（PR#6）：行内小按钮统一用 SVG。符号字形（⊕ ✕ ⋯）各自的墨迹基线不同，
     和 SVG 混在一排永远对不齐；连同 .am-mini-btn 的 inline-flex 居中，三个图标严格同线。 */
  function miniIco(btn, d, size, ringR) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'am-fav-ico');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('width', size || 14);
    s.setAttribute('height', size || 14);
    s.setAttribute('aria-hidden', 'true');
    if (ringR) {
      var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '8'); c.setAttribute('cy', '8'); c.setAttribute('r', String(ringR));
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', 'currentColor');
      c.setAttribute('stroke-width', '1.3');
      s.appendChild(c);
    }
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.3');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
    btn.appendChild(s);
  }

  /* V4.4.7（PR#6）：自定义排序下拉。
     原生 <select> 的展开列表是系统绘制的（蓝底 + 系统高亮），既没法样式化也跟主题玻璃皮肤对不上，
     这里换成「胶囊按钮 + .am-pop 弹层」一套。弹层全应用共用一个实例，避免每次 renderView 往 body 里堆节点。 */
  var _sortPop = null, _sortOwner = null;
  function _sortOnDoc(e) {
    if (!_sortPop) return;
    if (_sortPop.contains(e.target)) return;
    if (_sortOwner && _sortOwner.contains(e.target)) return;
    _sortClose();
  }
  function _sortOnKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); _sortClose(); }
  }
  function _sortClose() {
    if (!_sortPop) return;
    _sortPop.classList.remove('on');
    if (_sortOwner) _sortOwner.classList.remove('open');
    _sortOwner = null;
    document.removeEventListener('mousedown', _sortOnDoc, true);
    document.removeEventListener('keydown', _sortOnKey, true);
  }
  function sortDropdown(opts, value, onPick) {
    if (!_sortPop) {
      _sortPop = el('div', 'am-pop am-sort-pop');
      // 必须挂在 #am-root 里：主题变量（--am-glass / --am-text …）都定义在它上面，
      // 挂 body 的话背景色/文字色全部失效（弹层会变全透明）
      (document.getElementById('am-root') || document.body).appendChild(_sortPop);
    }
    var wrap = el('div', 'am-sort-dd');
    var btn = el('button', 'am-sort-btn');
    btn.title = '排序方式';
    var lab = el('span', 'am-sort-lab');
    var chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('class', 'am-sort-chev');
    chev.setAttribute('viewBox', '0 0 16 10');
    chev.setAttribute('width', '11');
    chev.setAttribute('height', '7');
    chev.setAttribute('aria-hidden', 'true');
    var chP = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    chP.setAttribute('d', 'M2 2 L8 8 L14 2');
    chP.setAttribute('fill', 'none');
    chP.setAttribute('stroke', 'currentColor');
    chP.setAttribute('stroke-width', '1.6');
    chP.setAttribute('stroke-linecap', 'round');
    chP.setAttribute('stroke-linejoin', 'round');
    chev.appendChild(chP);
    btn.appendChild(lab); btn.appendChild(chev);
    wrap.appendChild(btn);
    var cur = value;
    function labelOf(v) {
      for (var i = 0; i < opts.length; i++) if (opts[i][0] === v) return opts[i][1];
      return opts.length ? opts[0][1] : '';
    }
    function paint() {
      lab.textContent = labelOf(cur);
      _sortPop.innerHTML = '';
      opts.forEach(function (o) {
        var it = el('button', 'am-pop-item' + (o[0] === cur ? ' on' : ''), o[1]);
        it.onclick = function (e) {
          e.stopPropagation();
          cur = o[0];
          lab.textContent = labelOf(cur);
          _sortClose();
          onPick(o[0]);
        };
        _sortPop.appendChild(it);
      });
    }
    btn.onclick = function (e) {
      e.stopPropagation();
      if (_sortOwner === wrap) { _sortClose(); return; }
      _sortClose();
      paint();
      var r = btn.getBoundingClientRect();
      _sortPop.style.minWidth = Math.max(150, Math.round(r.width)) + 'px';
      _sortPop.style.left = Math.round(r.left) + 'px';
      _sortPop.style.top = Math.round(r.bottom + 6) + 'px';
      _sortPop.classList.add('on');
      wrap.classList.add('open');
      _sortOwner = wrap;
      document.addEventListener('mousedown', _sortOnDoc, true);
      document.addEventListener('keydown', _sortOnKey, true);
    };
    lab.textContent = labelOf(cur);
    return wrap;
  }
  AM.sortDropdown = sortDropdown;   // V4.4.8：在线歌单复用同一个排序胶囊
  function songSearchPh(mode) {
    var f = AM.songSearchField(mode);
    return f === 'artist' ? '搜索演唱者' : f === 'name' ? '搜索文件名' : f === 'album' ? '搜索专辑' : '搜索标题';
  }

  function renderView() {
    if (!R.content || (window.annieTheme && annieTheme.current !== 'am')) return;
    var c = R.content;
    // V4.4：歌单视图整体作为拖放落点（R.content 常驻，监听只挂一次；拖到行上经冒泡同样生效）
    // 拖到某一行上 = 插入该行之前（落点行 outline 高亮），拖到空白处 = 追加到底部
    if (!c._plDropBound) {
      c._plDropBound = true;
      function plDropRowOf(e) {
        var tr = (e.target && e.target.closest) ? e.target.closest('tr.am-tr') : null;
        return (tr && tr.dataset.path) ? tr : null;   // 窗口化垫片行没有 data-path
      }
      /* V4.4.7（PR#6）：落点提示改成「有方向的插入线」——上半屏插到本行之前、
         下半屏插到本行之后，和行内拖拽排序用同一套 .drop-before / .drop-after 视觉 */
      function plDropClear() {
        if (!c._plDropRow) return;
        c._plDropRow.classList.remove('drop-before', 'drop-after');
        c._plDropRow = null;
        c._plDropAfter = false;
      }
      function plDropMark(tr, e) {
        var after = false;
        if (tr) {
          var r = tr.getBoundingClientRect();
          after = (e.clientY - r.top) > r.height / 2;
        }
        if (c._plDropRow === tr && c._plDropAfter === after) return;
        plDropClear();
        if (!tr) return;
        tr.classList.add(after ? 'drop-after' : 'drop-before');
        c._plDropRow = tr;
        c._plDropAfter = after;
      }
      function plDropNextPath(tr) {
        var nx = tr ? tr.nextElementSibling : null;
        while (nx && !(nx.dataset && nx.dataset.path)) nx = nx.nextElementSibling;
        return nx ? nx.dataset.path : null;
      }
      c.addEventListener('dragover', function (e) {
        if (S.view.indexOf('pl:') !== 0 || !plDropHasFiles(e)) return;
        e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (er) { }
        plDropMark(plDropRowOf(e), e);
      });
      c.addEventListener('dragleave', function (e) {
        if (!e.relatedTarget || !c.contains(e.relatedTarget)) plDropClear();
      });
      c.addEventListener('drop', async function (e) {
        if (S.view.indexOf('pl:') !== 0 || !plDropHasFiles(e)) return;
        e.preventDefault();
        var tr = c._plDropRow, after = c._plDropAfter;
        var beforePath = tr ? (after ? plDropNextPath(tr) : tr.dataset.path) : null;
        plDropClear();
        var paths = await plExpandDropped(e);
        addDroppedToPlaylist(S.view.slice(3), paths, beforePath);
      });
    }
    // V4.4：框选多选——空白处按下拖出选框，命中行入 selection（Ctrl 追加、否则替换）；
    // 行/表头/按钮/输入框上不启动（行要留给点击与拖拽排序）；只命中已渲染行（窗口化限制）
    if (!c._marqueeBound) {
      c._marqueeBound = true;
      c.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        var inTableView = S.view === 'songs' || S.view === 'favorites' || (S.view === 'albums' && S.albumKey) || S.view.indexOf('pl:') === 0;
        if (!inTableView) return;
        if (e.target.closest && e.target.closest('tr.am-tr, tr.am-grp-tr, thead, .am-view-head, .am-ms-bar, button, input, select, a, .am-az')) return;
        if (e.target === c && e.offsetX >= c.clientWidth) return; // 滚动条
        var sx = e.clientX, sy = e.clientY, box = null, rect = null;
        function mv(ev) {
          if (!box && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return; // 位移阈值，勿抢单击
          if (!box) { box = el('div', 'am-marquee'); document.body.appendChild(box); }
          var x = Math.min(sx, ev.clientX), y = Math.min(sy, ev.clientY);
          var w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy);
          box.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px';
          rect = { l: x, t: y, r: x + w, b: y + h };
          ev.preventDefault();
        }
        function up(ev) {
          document.removeEventListener('mousemove', mv, true);
          document.removeEventListener('mouseup', up, true);
          if (box) box.remove();
          if (!rect) return;
          if (!S.msSel) S.msSel = new Set();
          if (!(ev.ctrlKey || ev.metaKey)) S.msSel.clear();
          var rows = c.querySelectorAll('tr.am-tr'), hit = 0;
          for (var ri = 0; ri < rows.length; ri++) {
            var rr = rows[ri].getBoundingClientRect();
            if (rr.bottom < rect.t || rr.top > rect.b || rr.right < rect.l || rr.left > rect.r) continue;
            S.msSel.add(rows[ri].dataset.path); hit++;
          }
          var keepScroll = c.scrollTop;
          var selectedPaths = new Set(S.msSel);
          // 不重绘整个视图：保留窗口化列表、表头和滚动位置，只同步当前已渲染行的选中状态
          var allRows = c.querySelectorAll('tr.am-tr');
          for (var si = 0; si < allRows.length; si++) {
            var isSel = selectedPaths.has(allRows[si].dataset.path);
            allRows[si].classList.toggle('sel', isSel);
            var check = allRows[si].querySelector('.am-ms-ck');
            if (check) check.checked = isSel;
          }
          var cnt = c.querySelector('.am-ms-count');
          if (cnt) cnt.textContent = '已选 ' + S.msSel.size + ' 首';
          if (!S.msOn && S.msSel.size) {
            var tb = c.querySelector('.am-ms-bar');
            if (!tb) {
              var beforeH = c.querySelector('.am-ms-bar') ? c.querySelector('.am-ms-bar').offsetHeight : 0;
              renderView();
              var afterH = c.querySelector('.am-ms-bar') ? c.querySelector('.am-ms-bar').offsetHeight : 0;
              c.scrollTop = Math.max(0, keepScroll + afterH - beforeH);
              if (S._tbl) { S._tbl.lastStart = -1; S._tbl.lastEnd = -1; renderAmWindow(); }
              setTimeout(function () {
                c.scrollTop = Math.max(0, keepScroll + afterH - beforeH);
                if (S._tbl) { S._tbl.lastStart = -1; S._tbl.lastEnd = -1; renderAmWindow(); }
              }, 0);
            }
          }
        }
        document.addEventListener('mousemove', mv, true);
        document.addEventListener('mouseup', up, true);
      });
    }
    // V4.3.24：同视图同排序重绘时复用旧头部（搜索框），只删头部以外的子节点。
    // 头部绝不 remove/重插——脱离文档会丢焦点并取消 IME 组词，中文就没法选字
    var hk = headKeyFor();
    var reuseHead = null;
    if (hk) {
      var exHead = c.querySelector('.am-view-head[data-hkey]');
      if (exHead && exHead.dataset.hkey === hk) reuseHead = exHead;
    }
    if (reuseHead) {
      for (var ci = c.children.length - 1; ci >= 0; ci--) {
        if (c.children[ci] !== reuseHead) c.children[ci].remove();
      }
    } else {
      c.innerHTML = '';
    }
    // V4.3.8：A–Z 索引栏挂在 .am-body 上（不随 content 清空），非歌曲视图需主动移除
    var oldAz = c.parentElement && c.parentElement.querySelector('.am-az');
    if (oldAz) oldAz.remove();
    S._az = null;
    // V4.1：视图切换动画只在「视图签名变化」时播放——切歌高亮/搜索输入/标签到达的重绘不闪
    var sig = S.view + '|' + (S.albumKey || '') + '|' + (S.folderPath || '');
    if (sig !== S._vswSig) {
      S._vswSig = sig;
      c.classList.remove('am-vsw'); void c.offsetWidth; c.classList.add('am-vsw');
      clearTimeout(S._vswT);
      S._vswT = setTimeout(function () { c.classList.remove('am-vsw'); }, 400);
    }

    // V4.3.22：多选模式只在 歌曲/专辑详情/喜爱歌曲 存活，切走即退出
    if (S.msOn && !(S.view === 'songs' || S.view === 'favorites' || (S.view === 'albums' && S.albumKey) || S.view.indexOf('pl:') === 0)) {
      S.msOn = false; if (S.msSel) S.msSel.clear();
    }
    // V4.4：快速多选（Ctrl/Shift/框选）不换视图沿用，换视图即清空（msOn 复选框模式维持原行为）
    if (S._msView !== S.view) { S._msView = S.view; if (!S.msOn && S.msSel && S.msSel.size) S.msSel.clear(); }
    if (S._grpView !== S.view) { S._grpView = S.view; if (S._grpCollapsed) S._grpCollapsed.clear(); }

    if (S.view === 'stream') { renderStreamView(c); return; }
    if (S.view === 'downloads') { if (window.annieAMDownload) window.annieAMDownload.render(c); return; } // V4.3.22：下载情况
    if (S.view === 'qobuz') { if (AM.renderQobuzView) AM.renderQobuzView(c); return; } // V4.3.6：Qobuz 视图
    if (S.view.indexOf('spl:') === 0) { renderSplView(c); return; } // V4.3.5：在线歌单

    var tracks = currentTracks();

    if (S.view === 'albums' && !S.albumKey) { renderAlbumGrid(c, reuseHead); return; }
    if (S.view === 'folders' && !S.folderPath) { renderFolderRoots(c); return; }

    var folderKids = null;
    if (S.view === 'folders' && S.folderPath) {
      // V4.3.20：逐级浏览——返回上级 + 当前目录名 + 直接子文件夹行
      var fback = el('button', 'am-btn am-btn-back', '');
      fback.innerHTML = amIcoTop('back', 14) + '<span class="am-btn-label">返回上级</span>';
      fback.onclick = function () {
        var p = normP(S.folderPath).replace(/\\+$/, '');
        var isRoot = (S.libFolders || []).some(function (f) { return normP(f).replace(/\\+$/, '').toLowerCase() === p.toLowerCase(); });
        var parent = p.replace(/\\[^\\]+$/, '');
        S.folderPath = (isRoot || parent === p) ? null : parent;
        renderView();
      };
      c.appendChild(fback);
      c.appendChild(el('div', 'am-view-h', S.folderPath.split('\\').filter(Boolean).pop() || S.folderPath));
      folderKids = folderChildren(S.folderPath);
      folderKids.forEach(function (g) {
        var row = el('div', 'am-folder-row');
        row.appendChild(el('span', 'am-folder-ico', '📁'));
        row.appendChild(el('span', 'am-folder-name', g.name));
        row.appendChild(el('span', 'am-folder-sub', g.count + ' 首'));
        row.onclick = function () { S.folderPath = g.path; renderView(); };
        c.appendChild(row);
      });
    } else if (S.view === 'albums' && S.albumKey) {
      // V4.4.3：详情页头部 = ‹ 专辑 返回 + 共享头（标题 + 排序下拉，复用 buildViewHead 的下拉逻辑但无搜索框）
      if (!reuseHead) {
        var back = el('button', 'am-btn am-btn-back', '');
        back.innerHTML = amIcoTop('back', 14) + '<span class="am-btn-label">专辑</span>';
        back.onclick = function () { S.albumKey = null; renderView(); };
        var dhead = el('div', 'am-view-head');
        dhead.dataset.hkey = 'albumDetail#' + S.albumKey + '#' + (AM.albumDetailSortMode ? AM.albumDetailSortMode() : 'release');
        dhead.style.cssText = 'display:flex;align-items:center;gap:10px';
        dhead.appendChild(back);
        dhead.appendChild(el('div', 'am-view-h', S.albumKey));
        dhead.appendChild(sortDropdown(ALBUM_DETAIL_SORT_OPTS, AM.albumDetailSortMode ? AM.albumDetailSortMode() : 'release', function (v) {
          if (window.annieSettings) { annieSettings.ui.amAlbumDetailSort = v; annieSettings.save(); }
          renderView();
        }));
        c.appendChild(dhead);
      }
    } else if (S.view.indexOf('pl:') === 0) {
      renderPlaylistHead(c);
    } else if (S.view === 'favorites') {
      // V4.3.22：喜爱歌曲头部——视图内搜索 + 排序下拉（同歌曲视图）
      // 复用的 head 已在 c 的首位，绝不能再 appendChild——同一父节点内 append 已存在节点
      // 也会先摘后插，导致输入框失焦（表现为每上屏/删一个字就得重新点搜索框）
      if (!reuseHead) c.appendChild(buildViewHead('喜爱歌曲', {
        view: 'favorites',
        search: { placeholder: songSearchPh(AM.favSortMode()) },
        sort: { opts: SONG_SORT_OPTS, value: AM.favSortMode(), key: 'amFavSort' }
      }));
    } else {
      // V4.3.15：歌曲视图标题行——右侧排序下拉（首字母/文件名/修改时间/大小）
      // V4.3.22：加视图内搜索框，匹配字段跟随排序方式
      // 复用 head 零操作（同上：append 已存在节点会移动位置并抢走焦点）
      if (!reuseHead) c.appendChild(buildViewHead('歌曲', {
        view: 'songs',
        search: { placeholder: songSearchPh(AM.songSortMode()) },
        sort: { opts: SONG_SORT_OPTS, value: AM.songSortMode(), key: 'amSongSort' }
      }));
    }

    if (S.view === 'songs' && (!AM.songSortMode || AM.songSortMode() === 'az' || AM.songSortMode() === 'azArtist')) {
      ensureMetaDeep(); // 首字母排序依赖全库标签，闲时深加载（按块到达自动重排）；平铺排序不需要
    }
    if (amSongGroupOn()) ensureMetaDeep();   // V4.4.9：分组依赖全库专辑标签，否则启动时全挤进「未知专辑」

    if (!tracks.length) {
      // 文件夹层级页：只有子文件夹没有直属音频时不报「曲库为空」
      if (!(S.view === 'folders' && folderKids && folderKids.length)) {
        c.appendChild(el('div', 'am-empty',
          S.view === 'favorites' ? '还没有喜爱的歌曲' :
          S.view === 'folders' ? '此文件夹内没有音频文件' :
          S.view.indexOf('pl:') === 0 ? '播放列表是空的——在歌曲行上点 ⊕ 添加' : '曲库为空，请先在设置中添加音乐文件夹'));
      }
      return;
    }
    renderTrackTable(c, tracks);
    if (S.view === 'songs' && !S._grpManualOn) renderAzBar(c, tracks); // V4.4.9：手动排过组序时索引条失去意义
    ensureMeta(tracks.slice(0, 120));
    scrollMemRestoreView(); // V4.4.9：内容区渲染完成后恢复滚动位置（重启场景）
  }

  /* V4.3.20：文件夹根列表——媒体库根目录（点入逐级深入；根外目录兜底平铺） */
  function renderFolderRoots(c) {
    c.appendChild(el('div', 'am-view-h', '文件夹'));
    var groups = folderRoots();
    if (!groups.length) {
      c.appendChild(el('div', 'am-empty', '曲库为空——点击侧栏"添加歌曲文件夹…"开始'));
      return;
    }
    groups.forEach(function (g) {
      var row = el('div', 'am-folder-row');
      row.appendChild(el('span', 'am-folder-ico', '📁'));
      row.appendChild(el('span', 'am-folder-name', g.name));
      row.appendChild(el('span', 'am-folder-sub', g.count + ' 首'));
      row.onclick = function () { S.folderPath = g.path; renderView(); };
      c.appendChild(row);
    });
  }

  function renderAlbumGrid(c, reuseHead) {
    // V4.3.22：专辑视图头部——视图内搜索 + 排序下拉（名称/艺人/曲目数）
    var amode = AM.albumSortMode ? AM.albumSortMode() : 'az';
    // 复用 head 已在 c 首位，不再 append（移动已存在节点会使搜索框失焦）
    if (!reuseHead) c.appendChild(buildViewHead('专辑', {
      view: 'albums',
      search: { placeholder: amode === 'azArtist' ? '搜索艺人' : '搜索专辑名' },
      sort: { opts: ALBUM_SORT_OPTS, value: amode, key: 'amAlbumSort' }
    }));
    var tracks = allTracks();
    ensureMeta(tracks.slice(0, 400)); // 专辑分组依赖标签，取回后自动重绘
    var byAlbum = {};
    tracks.forEach(function (t) {
      var m = trackMeta(t);
      var k = m.album || '未知专辑';
      if (!byAlbum[k]) byAlbum[k] = { name: k, artist: m.artist, tracks: [] };
      byAlbum[k].tracks.push(t);
    });
    // 视图内搜索框只匹配专辑名；左下角搜索另按「专辑名 或 专辑内曲目的歌名/歌手」过滤
    var aq = viewQuery('albums').toLowerCase();
    var sq = (S.search || '').toLowerCase();
    if (aq || sq) {
      Object.keys(byAlbum).forEach(function (k) {
        var a = byAlbum[k];
        var hitQ = !aq || (a.name || '').toLowerCase().indexOf(aq) >= 0;
        var hitS = true;
        if (sq) {
          hitS = (a.name || '').toLowerCase().indexOf(sq) >= 0;
          if (!hitS) {
            var list = a.tracks || [];
            for (var ti = 0; ti < list.length; ti++) {
              var mm = trackMeta(list[ti]) || {};
              if (((mm.title || '') + ' ' + (mm.artist || '')).toLowerCase().indexOf(sq) >= 0) { hitS = true; break; }
            }
          }
        }
        if (!hitQ || !hitS) delete byAlbum[k];
      });
    }
    // 排序：名称/艺人走拼音 collator，曲目数按数量
    var col = AM.azCollator ? AM.azCollator() : null;
    var keys = Object.keys(byAlbum).sort(function (x, y) {
      var a = byAlbum[x], b = byAlbum[y];
      if (amode === 'countDesc') return b.tracks.length - a.tracks.length;
      if (amode === 'countAsc') return a.tracks.length - b.tracks.length;
      var ka = amode === 'azArtist' ? (a.artist || '') : a.name;
      var kb = amode === 'azArtist' ? (b.artist || '') : b.name;
      var r = col ? col.compare(ka, kb) : ka.localeCompare(kb);
      return r !== 0 ? r : (col ? col.compare(a.name, b.name) : a.name.localeCompare(b.name));
    });
    var grid = el('div', 'am-album-grid');
    keys.forEach(function (k) {
      var a = byAlbum[k];
      var card = el('div', 'am-album-card');
      var img = el('img'); img.alt = ''; img.loading = 'lazy';
      albumCover(a.tracks[0], function (url) { if (url) img.src = url; }); // 与表格共享专辑级缓存
      card.appendChild(img);
      card.appendChild(el('div', 'am-album-name', a.name));
      card.appendChild(el('div', 'am-album-sub', a.artist + ' · ' + a.tracks.length + ' 首'));
      card.onclick = function () { S.albumKey = k; renderView(); };
      // V4.3.22：专辑右键——删除整个专辑（仅移出曲库 / 连同源文件，弹窗勾选确认）
      card.oncontextmenu = function (e) {
        e.preventDefault();
        var pop = R.pop;
        pop.innerHTML = '';
        pop.appendChild(el('div', 'am-pop-head', a.name)); // V4.4：标题改不可点样式
        pop.appendChild(el('div', 'am-pop-sep'));
        var md = el('button', 'am-pop-item', '🗑 删除该专辑（' + a.tracks.length + ' 首）…');
        md.onclick = function () { pop.classList.remove('on'); deleteTracks(a.tracks.map(function (t) { return t.path; })); };
        pop.appendChild(md);
        pop.classList.add('on');
        var w = pop.offsetWidth, h = pop.offsetHeight;
        pop.style.left = Math.min(e.clientX, window.innerWidth - w - 12) + 'px';
        pop.style.top = Math.min(e.clientY, window.innerHeight - h - 12) + 'px';
      };
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
    var bShuffle = el('button', 'am-btn am-btn-shuffle', '');
    bShuffle.appendChild((function () {
      var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 16 16');
      s.setAttribute('width', '14'); s.setAttribute('height', '14');
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M2.6 5.2 H5.1 C6.1 5.2 6.9 5.6 7.5 6.3 L10.3 9.5 C10.9 10.2 11.7 10.6 12.7 10.6 H13.2 M12 8.7 L13.9 10.6 L12 12.5 M2.6 10.6 H5.1 C6.1 10.6 6.9 10.2 7.5 9.5 L10.3 6.3 C10.9 5.6 11.7 5.2 12.7 5.2 H13.2 M12 3.3 L13.9 5.2 L12 7.1');
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.5'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
      s.appendChild(p); return s;
    })());
    bShuffle.appendChild(el('span', 'am-btn-label', '随机播放'));
    bShuffle.onclick = function () {
      if (!tracks.length) return;
      playList(tracks, Math.floor(Math.random() * tracks.length));
    };
    acts.appendChild(bPlay); acts.appendChild(bShuffle);
    // V4.4.6：播放列表排序下拉（原始顺序 / 演唱者 A–Z）
    acts.appendChild(sortDropdown([['default', '原始顺序'], ['azArtist', '演唱者 A–Z']],
      AM.plSortMode ? AM.plSortMode() : 'default', function (v) {
        if (window.annieSettings) { annieSettings.ui.amPlSort = v; annieSettings.save(); }
        renderView();
      }));
    info.appendChild(acts);
    head.appendChild(info);
    c.appendChild(head);
  }

  /* 本地曲目表：封面按专辑共享（每张专辑只解析一个文件的封面，行内复用同一 dataURL，解码一次）；
     V4.1：移除 2000 行封面硬顶——窗口化渲染已把同时在屏的 <img> 限制在可视区 ±15 行，
     叠加专辑级缓存 + 并发限流 3 的 lazy 队列，超大曲库封面列也流畅。
     V3.1：>300 行窗口化渲染——只构建可视区 ±15 行，上下用占位行撑高度，滚动 rAF 合并。 */
  var AM_ROW_H_COVER = 52, AM_ROW_H_PLAIN = 41, AM_WINDOW_MIN = 300, AM_OVERSCAN = 15;
  function buildTrackRow(t, i, opts) {
    var m = trackMeta(t);
    var selected = S.msSel && S.msSel.has(t.path);
    var tr = el('tr', 'am-tr' + (state.currentPath === t.path && !S.msOn ? ' cur' : '') + (selected ? ' sel' : ''));
    tr.dataset.path = t.path; // 定位播放文件用
    if (S.msOn) { // V4.3.22：多选模式——行首复选框，点击行=切换选中（不播放）
      var tdCk = el('td');
      var ck = document.createElement('input');
      ck.type = 'checkbox'; ck.checked = !!selected; ck.className = 'am-ms-ck';
      ck.onclick = function (e) { e.stopPropagation(); msToggle(t.path, tr, ck); };
      tdCk.appendChild(ck); tr.appendChild(tdCk);
    }
    if (opts.withCover) {
      var tdCover = el('td');
      var img = el('img', 'am-c-cover'); img.alt = ''; img.loading = 'lazy'; img.draggable = false;
      img.style.visibility = 'hidden';
      albumCover(t, function (url) { if (url) { img.src = url; img.style.visibility = ''; } });
      tdCover.appendChild(img); tr.appendChild(tdCover);
    }
    if (opts.grouped) tr.appendChild(el('td', 'am-c-covercell'));
    amCols().order.forEach(function (k) {
      if (k === 'title') tr.appendChild(el('td', 'am-c-title', esc(m.title)));
      else if (k === 'artist') tr.appendChild(el('td', 'am-c-dim am-c-artist', esc(m.artist)));
      else tr.appendChild(el('td', 'am-c-dim am-c-album', esc(m.album)));
    });
    var acts = el('td', 'am-c-acts');
    /* V4.4.7（PR#6）：行内收藏键与顶栏同款——未收藏空心描边，收藏后填成主题色 */
    var bFav = el('button', 'am-mini-btn' + (state.favorites && state.favorites.has(t.path) ? ' faved' : ''));
    (function () {
      var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('class', 'am-fav-ico');
      s.setAttribute('viewBox', '0 0 16 16');
      s.setAttribute('width', '14');
      s.setAttribute('height', '14');
      s.setAttribute('aria-hidden', 'true');
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M8 13.4 C8 13.4 2 9.5 2 5.9 C2 3.7 3.7 2.2 5.5 2.2 C6.7 2.2 7.6 2.9 8 3.7 C8.4 2.9 9.3 2.2 10.5 2.2 C12.3 2.2 14 3.7 14 5.9 C14 9.5 8 13.4 8 13.4 Z');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.3');
      p.setAttribute('stroke-linejoin', 'round');
      s.appendChild(p);
      bFav.appendChild(s);
    })();
    bFav.title = '喜爱';
    bFav.onclick = function (e) {
      e.stopPropagation();
      window.mine.toggleFavorite(t.path).then(function (favs) {
        state.favorites = new Set(favs);
        bFav.classList.toggle('faved', state.favorites.has(t.path));
        if (S.view === 'favorites') renderView();
      });
    };
    var bAdd = el('button', 'am-mini-btn am-row-more');
    miniIco(bAdd, 'M4.3 8 H4.31 M8 8 H8.01 M11.7 8 H11.71', 14);
    bAdd.title = '歌曲操作';
    bAdd.onclick = function (e) { e.stopPropagation(); openAddMenu(e.clientX, e.clientY, t.path); };
    acts.appendChild(bFav); acts.appendChild(bAdd);
    /* V4.4.7（PR#6）：行内「从播放列表移除」的 ✕ 去掉了——太容易误触删歌；
       需要移除时走右键菜单（多选逻辑都还在） */
    tr.appendChild(acts);
    // V4.3.22：播放列表内拖拽排序（与迷你待播清单同一交互：拖到目标行放下即插入该行前）
    // V4.4.6：azArtist 排序模式下视图顺序≠paths 顺序，拖拽落点会错位——此时禁用拖拽
    if (opts.inPlaylist && !S.msOn && !(AM.plSortMode && AM.plSortMode() === 'azArtist')) {
      tr.draggable = true;
      tr.removeAttribute('title');
      tr.addEventListener('dragstart', function (e) {
        S._plDragPath = t.path;
        try { e.dataTransfer.effectAllowed = 'move'; } catch (er) { }
      });
      /* V4.4.7（PR#6）：拖动指示改成和侧栏歌单一致的「插入线」——
         落在行上半 = 插到该行前，下半 = 插到该行后；原来整行红框看不出方向 */
      tr.addEventListener('dragover', function (e) {
        e.preventDefault();
        var r = tr.getBoundingClientRect();
        var before = (e.clientY - r.top) < r.height / 2;
        tr.classList.toggle('drop-before', before);
        tr.classList.toggle('drop-after', !before);
        tr._dropBefore = before;
      });
      tr.addEventListener('dragleave', function () { tr.classList.remove('drop-before', 'drop-after'); });
      tr.addEventListener('drop', function (e) {
        e.preventDefault();
        tr.classList.remove('drop-before', 'drop-after');
        var from = S._plDragPath; S._plDragPath = null;
        if (from && from !== t.path) movePlRow(opts.plId, from, t.path, !tr._dropBefore);
      });
      tr.addEventListener('dragend', function () { S._plDragPath = null; tr.classList.remove('drop-before', 'drop-after'); });
    }
    if (S.msOn) {
      tr.onclick = function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) { rowSelClick(e, t, opts); return; } // 修饰键走快速多选
        msToggle(t.path, tr, tr.querySelector('.am-ms-ck')); S._selAnchor = t.path;
      };
    } else {
      // V4.4：单击行 = 快速多选操作（Ctrl 切换 / Shift 连选 / 普通单击清空选择并记锚点）；播放仍双击
      tr.onclick = function (e) { if (!rowSelClick(e, t, opts)) S._selAnchor = t.path; };
      tr.ondblclick = function () { playList(opts.tracks, i); };
      // V4.3.21：行右键 = ⊕ 菜单（同一入口，坐标取鼠标位置）
      tr.oncontextmenu = function (e) { e.preventDefault(); openAddMenu(e.clientX, e.clientY, t.path); };
    }
    return tr;
  }

  /* ---------- V4.3.22：本地曲库多选 + 删除（歌曲/专辑详情/喜爱歌曲） ---------- */
  /* 播放列表拖拽排序：from 插到 to 行之前（按路径定位——窗口化行索引在 paths 有缺口时会错位） */
  function movePlRow(plId, fromPath, toPath, after) {
    var pl = S.playlists.find(function (p) { return p.id === plId; });
    if (!pl) return;
    var arr = pl.paths;
    var fi = arr.indexOf(fromPath), ti = arr.indexOf(toPath);
    if (fi < 0 || ti < 0) return;
    arr.splice(fi, 1);
    var at = arr.indexOf(toPath);          // 删除后目标索引自动前移
    arr.splice(after ? at + 1 : at, 0, fromPath); // 上半屏插前、下半屏插后
    renderView(); // 本地先重排即时反馈，持久化随后
    window.mine.playlistReorder(plId, arr).then(function (pls) { S.playlists = pls; }).catch(function () { });
  }
  /* V4.4：快速多选单击处理——Ctrl+单击切换选中 / Shift+单击从锚点连选（锚点=上次点击行）/
     普通单击清空快速选择；返回 true 表示已消费本次点击（false=记锚点后照常） */
  function rowSelClick(e, t, opts) {
    if (!S.msSel) S.msSel = new Set();
    if (e.ctrlKey || e.metaKey) {
      if (S.msSel.has(t.path)) S.msSel.delete(t.path); else S.msSel.add(t.path);
      S._selAnchor = t.path;
      renderKeepScroll();
      return true;
    }
    if (e.shiftKey && S._selAnchor && opts.tracks) {
      var a = -1, b = -1;
      opts.tracks.forEach(function (x, xi) { if (x.path === S._selAnchor) a = xi; if (x.path === t.path) b = xi; });
      if (a >= 0 && b >= 0) {
        S.msSel.clear();
        for (var k = Math.min(a, b); k <= Math.max(a, b); k++) S.msSel.add(opts.tracks[k].path);
        renderKeepScroll();
        return true;
      }
      return false;
    }
    if (S.msSel.size) { S.msSel.clear(); renderKeepScroll(); }
    return false;
  }
  function msToggle(p, tr, ck) {
    if (!S.msSel) S.msSel = new Set();
    if (S.msSel.has(p)) { S.msSel.delete(p); tr.classList.remove('sel'); if (ck) ck.checked = false; }
    else { S.msSel.add(p); tr.classList.add('sel'); if (ck) ck.checked = true; }
    var cnt = document.querySelector('.am-ms-count');
    if (cnt) cnt.textContent = '已选 ' + S.msSel.size + ' 首';
  }
  /* V4.4.9：多选工具条出现/消失会改变内容高度 —— 重绘后按高度差补偿滚动，避免界面跳到顶上 */
  function renderKeepScroll() {
    var c = R.content;
    if (!c) { renderView(); return; }
    var st = c.scrollTop;
    var ob = c.querySelector('.am-ms-bar');
    var oh = ob ? ob.offsetHeight : 0;
    renderView();
    var nb = c.querySelector('.am-ms-bar');
    var nh = nb ? nb.offsetHeight : 0;
    var target = Math.max(0, st + nh - oh);
    c.scrollTop = target;
    if (S._tbl) { S._tbl.lastStart = -1; S._tbl.lastEnd = -1; renderAmWindow(); }
    setTimeout(function () {
      c.scrollTop = target;
      if (S._tbl) { S._tbl.lastStart = -1; S._tbl.lastEnd = -1; renderAmWindow(); }
    }, 0);
  }
  function msExit() { S.msOn = false; if (S.msSel) S.msSel.clear(); renderKeepScroll(); }
  function renderMsToolbar(c, tracks) {
    var bar = el('div', 'am-ms-bar');
    var bAll = el('button', 'am-btn', (S.msSel && S.msSel.size >= tracks.length && tracks.length) ? '☐ 取消全选' : '☑ 全选');
    bAll.onclick = function () {
      if (!S.msSel) S.msSel = new Set();
      if (S.msSel.size >= tracks.length) S.msSel.clear();
      else tracks.forEach(function (t) { S.msSel.add(t.path); });
      renderKeepScroll();
    };
    bar.appendChild(bAll);
    // V4.4：顶部工具条独立歌单选择器——不复用右键 R.pop，避免全局外点关闭逻辑立即收掉菜单
    var bAddPl = el('button', 'am-btn', '📥 加入播放列表…');
    bAddPl.onclick = function (e) {
      if (!S.msSel || !S.msSel.size) { try { proToast('先选中歌曲'); } catch (er) { } return; }
      var paths = Array.from(S.msSel);
      var menu = document.createElement('div');
      menu.className = 'am-ms-pl-menu';
      menu.style.cssText = 'position:fixed;z-index:1001;left:' + e.clientX + 'px;top:' + (e.clientY + 8) + 'px;min-width:190px;max-height:320px;overflow:auto';
      menu.appendChild(el('div', 'am-pop-head', '加入 ' + paths.length + ' 首到播放列表'));
      if (!S.playlists.length) menu.appendChild(el('div', 'am-pop-hint', '还没有本地播放列表'));
      S.playlists.forEach(function (pl) {
        var it = el('button', 'am-pop-item', pl.name + '（' + pl.paths.length + ' 首）');
        it.onclick = function () {
          window.mine.playlistAdd(pl.id, paths).then(function (pls) {
            S.playlists = pls; menu.remove(); renderSidebar();
            try { if (typeof proToast === 'function') proToast('已加入「' + pl.name + '」'); } catch (er) { }
          });
        };
        menu.appendChild(it);
      });
      var close = function (ev) {
        if (!menu.contains(ev.target) && ev.target !== bAddPl) { menu.remove(); document.removeEventListener('mousedown', close, true); }
      };
      document.body.appendChild(menu);
      document.addEventListener('mousedown', close, true);
    };
    bar.appendChild(bAddPl);
    if (S.view.indexOf('pl:') === 0) {
      // 歌单视图：批量「从本歌单移除」（复用 playlistReorder 整组替换 paths，不碰曲库/其他歌单）
      var bRm = el('button', 'am-btn am-btn-danger', '✕ 从歌单移除选中');
      bRm.onclick = function () {
        if (!S.msSel || !S.msSel.size) { try { proToast('先选中歌曲'); } catch (e) { } return; }
        var plId = S.view.slice(3);
        var pl = S.playlists.find(function (p) { return p.id === plId; });
        if (!pl) return;
        var del = new Set(S.msSel);
        window.mine.playlistReorder(plId, pl.paths.filter(function (p) { return !del.has(p); })).then(function (pls) {
          S.playlists = pls; S.msOn = false; if (S.msSel) S.msSel.clear();
          renderSidebar(); renderKeepScroll();
        });
      };
      bar.appendChild(bRm);
    } else {
      var bDel = el('button', 'am-btn am-btn-danger', '🗑 删除选中');
      bDel.onclick = function () {
        if (!S.msSel || !S.msSel.size) { try { proToast('先勾选要删除的歌曲'); } catch (e) { } return; }
        deleteTracks(Array.from(S.msSel));
      };
      bar.appendChild(bDel);
    }
    var bExit = el('button', 'am-btn', '✕ 取消选择');
    bExit.onclick = msExit;
    bar.appendChild(bExit);
    bar.appendChild(el('span', 'am-ms-count', '已选 ' + (S.msSel ? S.msSel.size : 0) + ' 首'));
    bar.classList.add('am-ms-float');
    c.appendChild(bar);
    /* V4.4.9：把工具条高度告诉表头（sticky top 让位），避免两者叠在一起 */
    try { var _r = document.getElementById('am-root'); if (_r) _r.style.setProperty('--am-ms-h', bar.offsetHeight + 'px'); } catch (e0) { }
  }
  /* 删除确认：默认仅移出曲库显示；勾选后连同源文件（系统回收站，可恢复） */
  function amConfirmDel(count, cb) {
    var ov = el('div', 'am-prompt-ov');
    var box = el('div', 'am-prompt');
    box.appendChild(el('div', 'am-pop-h', '删除 ' + count + ' 首歌曲'));
    box.appendChild(el('div', 'am-pop-hint', '默认仅从曲库移除显示，磁盘文件不受影响。'));
    var lab = el('label', 'am-del-opt');
    var ck = document.createElement('input'); ck.type = 'checkbox';
    lab.appendChild(ck);
    lab.appendChild(el('span', '', '同时删除源文件（移入系统回收站，可恢复）'));
    box.appendChild(lab);
    var row = el('div', 'am-prompt-btns');
    var bNo = el('button', 'am-btn', '取消');
    var bOk = el('button', 'am-btn am-btn-danger', '删除');
    function close(v) { ov.remove(); if (v != null) cb(v); }
    bNo.onclick = function () { close(null); };
    bOk.onclick = function () { close(ck.checked); };
    ov.onclick = function (e) { if (e.target === ov) close(null); };
    row.appendChild(bNo); row.appendChild(bOk);
    box.appendChild(row); ov.appendChild(box);
    document.body.appendChild(ov);
  }
  function deleteTracks(paths) {
    if (!paths || !paths.length) return;
    amConfirmDel(paths.length, function (delFile) {
      var done = function (pls, msg) {
        if (pls) S.playlists = pls;
        S.msOn = false; if (S.msSel) S.msSel.clear();
        renderSidebar(); renderView();
        try { proToast(msg); } catch (e) { }
      };
      if (delFile) {
        window.mine.libDeleteFiles(paths).then(function (r) {
          var n = r && r.done ? r.done.length : 0, f = r && r.failed ? r.failed.length : 0;
          done(r && r.playlists, '已删除 ' + n + ' 首（源文件已入回收站）' + (f ? '，' + f + ' 个失败' : ''));
        }).catch(function () { });
      } else {
        window.mine.tracksHide(paths).then(function (r) {
          done(r && r.playlists, '已移出曲库 ' + (r ? r.removed : paths.length) + ' 首（源文件保留）');
        }).catch(function () { });
      }
    });
  }
  function amSpacerRow(h, cols) {
    var tr = el('tr');
    var td = el('td');
    td.colSpan = cols;
    td.style.cssText = 'height:' + h + 'px;padding:0;border:0';
    tr.appendChild(td);
    return tr;
  }
  /* ===== V4.4.9：歌曲表列（封面固定最左；歌曲/艺人/专辑可拖宽、可换位） ===== */
  var AM_COL_DEFS = { title: '歌曲', artist: '艺人', album: '专辑' };
  var _amColsCache = null;
  function amCols() {
    if (_amColsCache) return _amColsCache;
    var st = { order: ['title', 'artist', 'album'], w: { title: 0.38, artist: 0.26, album: 0.36 } };
    try {
      var raw = localStorage.getItem('annieplayer.am.cols');
      if (raw) {
        var o = JSON.parse(raw);
        if (o && Array.isArray(o.order)) {
          var seen = {}, ord = [];
          o.order.forEach(function (k) { if (AM_COL_DEFS[k] && !seen[k]) { seen[k] = 1; ord.push(k); } });
          ['title', 'artist', 'album'].forEach(function (k) { if (ord.indexOf(k) < 0) ord.push(k); });
          st.order = ord;
        }
        if (o && o.w) ['title', 'artist', 'album'].forEach(function (k) {
          var v = +o.w[k];
          if (v > 1) v = v / 100;   // 兼容旧版百分数
          if (isFinite(v) && v >= 0.08 && v <= 0.8) st.w[k] = v;
        });
      }
    } catch (e) { }
    var sum = st.w.title + st.w.artist + st.w.album;
    if (sum > 0) { st.w.title /= sum; st.w.artist /= sum; st.w.album /= sum; }
    _amColsCache = st;
    return st;
  }
  function amColsSave(st) {
    _amColsCache = st;
    try { localStorage.setItem('annieplayer.am.cols', JSON.stringify({ order: st.order, w: st.w })); } catch (e) { }
  }
  /* V4.4.9：按「可用宽度」把比例换成 px（calc 在 <col> 上不生效） */
  function layoutCols(tb) {
    if (!tb || !tb.isConnected) return;
    var st = amCols();
    var total = tb.getBoundingClientRect().width;
    if (!total) return;
    var fixed = +(tb.dataset.colfixed || 0);
    var avail = Math.max(150, total - fixed);
    st.order.forEach(function (k) {
      var c = tb.querySelector('colgroup col[data-col="' + k + '"]');
      if (c) c.style.width = Math.max(60, Math.round(avail * st.w[k])) + 'px';
    });
    tb.dataset.colavail = String(Math.round(avail));
  }
  var _colRO = null;
  function watchCols(tb) {
    if (!window.ResizeObserver) return;
    try { if (_colRO) _colRO.disconnect(); } catch (e) { }
    _colRO = new ResizeObserver(function () {
      var t = document.querySelector('#am-root .am-table');
      if (t) layoutCols(t);
    });
    _colRO.observe(tb);
  }
  function buildTableHead(tb, grp, opts) {
    var st = amCols(), ms = !!S.msOn;
    tb.innerHTML = '';
    var cg = document.createElement('colgroup');
    function addCol(w, key) {
      var c = document.createElement('col');
      c.style.width = w;
      if (key) c.dataset.col = key;
      cg.appendChild(c);
      return c;
    }
    if (ms) addCol('34px');
    if (grp) addCol('92px'); else if (opts.withCover) addCol('46px');
    var fixed = (ms ? 34 : 0) + (grp ? 92 : (opts.withCover ? 46 : 0)) + 96;
    tb.dataset.colfixed = String(fixed);
    st.order.forEach(function (k) { addCol((st.w[k] * 100) + '%', k); });
    addCol('96px');
    tb.appendChild(cg);
    var thead = document.createElement('thead'), trh = document.createElement('tr');
    function addTh(w, label) {
      var th = el('th', '', label || '');
      if (w) th.style.width = w;
      trh.appendChild(th);
      return th;
    }
    if (ms) addTh('34px');
    if (grp) addTh('92px', '封面'); else if (opts.withCover) addTh('46px');
    st.order.forEach(function (k, i) {
      var th = addTh(null, AM_COL_DEFS[k]);
      th.dataset.col = k;
      th.draggable = true;
      th.removeAttribute('title');
      if (i < st.order.length - 1) {
        var g = el('span', 'am-col-grip');
        g.dataset.col = k;
        g.draggable = false;
        g.removeAttribute('title');
        th.appendChild(g);
      } else {
        th.classList.add('am-col-last');
      }
    });
    addTh('96px');
    thead.appendChild(trh);
    tb.appendChild(thead);
    bindColDrag(tb, thead);
  }
  function bindColDrag(tb, thead) {
    var ths = thead.querySelectorAll('th[data-col]');
    Array.prototype.forEach.call(ths, function (th) {
      th.addEventListener('dragstart', function (e) {
        if (e.target && e.target.classList && e.target.classList.contains('am-col-grip')) { e.preventDefault(); return; }
        S._dragCol = th.dataset.col;
        try { e.dataTransfer.setData('text/plain', th.dataset.col); e.dataTransfer.effectAllowed = 'move'; } catch (x) { }
        th.classList.add('am-col-dragging');
      });
      th.addEventListener('dragend', function () {
        th.classList.remove('am-col-dragging');
        Array.prototype.forEach.call(ths, function (x) { x.classList.remove('am-col-drop'); });
        S._dragCol = null;
      });
      th.addEventListener('dragover', function (e) {
        if (!S._dragCol || S._dragCol === th.dataset.col) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (x) { }
        th.classList.add('am-col-drop');
      });
      th.addEventListener('dragleave', function () { th.classList.remove('am-col-drop'); });
      th.addEventListener('drop', function (e) {
        e.preventDefault();
        var from = S._dragCol, to = th.dataset.col;
        th.classList.remove('am-col-drop');
        if (!from || !to || from === to) return;
        var st = amCols(), a = st.order.slice();
        var fi = a.indexOf(from), ti = a.indexOf(to);
        if (fi < 0 || ti < 0) return;
        a.splice(fi, 1);
        a.splice(ti, 0, from);
        st.order = a;
        amColsSave(st);
        S._dragCol = null;
        renderView();
      });
    });
    Array.prototype.forEach.call(thead.querySelectorAll('.am-col-grip'), function (g) {
      g.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (S._dragSession) return;
        S._dragSession = 'col';
        window.__amDragBusy = true;
        var key = g.dataset.col, st = amCols();
        var startX = e.clientX, f0 = st.w[key];
        var order = st.order.slice();
        var i = order.indexOf(key);
        var nb = order[i + 1];
        if (!nb) return;
        var f1 = st.w[nb];
        var avail = 0;
        Array.prototype.forEach.call(thead.querySelectorAll('th[data-col]'), function (th) { avail += th.getBoundingClientRect().width; });
        var fixed = +(tb.dataset.colfixed || 0);
        var minF = Math.min(0.45, 80 / Math.max(avail, 1));
        var cols = tb.querySelectorAll('colgroup col');
        var colOf = function (k) {
          var out = null;
          Array.prototype.forEach.call(cols, function (c) { if (c.dataset.col === k) out = c; });
          return out;
        };
        var elKey = colOf(key), elNb = colOf(nb);
        var move = function (ev) {
          var d = (ev.clientX - startX) / Math.max(avail, 1);
          var f = f0 + d, fn = f1 - d;
          if (f < minF) { f = minF; fn = f0 + f1 - f; }
          if (fn < minF) { fn = minF; f = f0 + f1 - fn; }
          if (elKey) elKey.style.width = Math.round(avail * f) + 'px';
          if (elNb) elNb.style.width = Math.round(avail * fn) + 'px';
          st.w[key] = f; st.w[nb] = fn;
        };
        var up = function () {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.documentElement.classList.remove('am-col-resizing');
          S._dragSession = null;
          window.__amDragBusy = false;
          if (window.__amFlushDragRender) window.__amFlushDragRender();
          amColsSave(st);
        };
        document.documentElement.classList.add('am-col-resizing');
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
  }
  /* ===== V4.4.9：长按组名拖动整组换位（顺序按「视图#排序」记忆） ===== */
  function grpSortSig() {
    var ui = (window.annieSettings && annieSettings.ui) || {};
    var v = S.view || '';
    var mode = v === 'songs' ? (ui.amSongSort || 'az')
      : v === 'favorites' ? (ui.amFavSort || 'az')
        : v.indexOf('pl:') === 0 ? (ui.amPlSort || 'default')
          : v.indexOf('spl:') === 0 ? (ui.amSplSort || 'default') : '';
    return v + '#' + mode;
  }
  function grpStore() {
    try { return JSON.parse(localStorage.getItem('annieplayer.am.grpOrder') || '{}'); } catch (e) { return {}; }
  }
  function grpOrderGet() {
    try {
      var st = grpStore()[grpSortSig()];
      if (!st || st.sig !== grpSortSig() || !Array.isArray(st.order)) return null;
      return st.order;
    } catch (e) { return null; }
  }
  function grpOrderSet(order) {
    try {
      var all = grpStore();
      all[grpSortSig()] = { sig: grpSortSig(), order: order };
      localStorage.setItem('annieplayer.am.grpOrder', JSON.stringify(all));
    } catch (e) { }
  }
  /* 只有「播放列表/在线歌单 + 原始顺序」才允许整组拖动；其它按 A–Z 等排序的视图不允许 */
  function grpDragAllowed() {
    var v = S.view || '';
    if (v.indexOf('pl:') !== 0 && v.indexOf('spl:') !== 0) return false;
    var ui = (window.annieSettings && annieSettings.ui) || {};
    var mode = v.indexOf('pl:') === 0 ? (ui.amPlSort || 'default') : (ui.amSplSort || 'default');
    return mode === 'default';
  }
  function bindGrpDrag(tr, g) {
    tr.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (S._dragSession) return;
      if (!grpDragAllowed()) return;
      S._dragSession = 'grp';
      window.__amDragBusy = true;
      var startView = S.view;
      var startTable = tr.closest('table');
      var startW = startTable ? startTable.getBoundingClientRect().width : 0;
      var sx = e.clientX, sy = e.clientY, timer = null, active = false, ghost = null, moved = false;
      var allRows = function () { return Array.prototype.slice.call(document.querySelectorAll('.am-grp-tr')).filter(function (x) { return !(x.closest && x.closest('.am-grp-ghost')); }); };
      var cleanup = function () {
        clearTimeout(timer);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        S._dragSession = null;
        window.__amDragBusy = false;
        if (window.__amFlushDragRender) window.__amFlushDragRender();
        tr.classList.remove('am-grp-dragging');
        allRows().forEach(function (x) { x.classList.remove('am-grp-drop'); });
        if (ghost) { ghost.remove(); ghost = null; }
      };
      var onMove = function (ev) {
        if (S.view !== startView) { cleanup(); return; }
        if (!active) {
          if (Math.abs(ev.clientX - sx) > 5 || Math.abs(ev.clientY - sy) > 5) cleanup();
          return;
        }
        moved = true;
        if (ghost) { ghost.style.top = (ev.clientY - 30) + 'px'; ghost.style.left = (ev.clientX - 60) + 'px'; }
        var under = document.elementFromPoint(ev.clientX, ev.clientY);
        var row = under && under.closest ? under.closest('.am-grp-tr') : null;
        allRows().forEach(function (x) { x.classList.toggle('am-grp-drop', !!row && x === row && x !== tr); });
        var c = document.querySelector('.am-content');
        if (c) {
          var rr = c.getBoundingClientRect();
          if (ev.clientY < rr.top + 56) c.scrollTop -= 12;
          else if (ev.clientY > rr.bottom - 56) c.scrollTop += 12;
        }
      };
      var onUp = function (ev) {
        if (S.view !== startView) { cleanup(); return; }
        if (!active) { cleanup(); return; }
        active = false;
        var under = document.elementFromPoint(ev.clientX, ev.clientY);
        var row = under && under.closest ? under.closest('.am-grp-tr') : null;
        if (row && row.closest('table') !== document.querySelector('#am-root .am-table')) row = null;
        var rows = allRows();
        cleanup();
        if (moved && row && row !== tr && row.dataset.gkey != null) {
          var keys = rows.map(function (x) { return x.dataset.gkey; });
          var from = keys.indexOf(g.key), to = keys.indexOf(row.dataset.gkey);
          if (from >= 0 && to >= 0) {
keys.splice(from, 1);
keys.splice(from < to ? to - 1 : to, 0, g.key);   // 插入到目标行之前（删除后目标下标左移一格）
grpOrderSet(keys);
renderView();
          }
        }
      };
      timer = setTimeout(function () {
        active = true;
        tr.classList.add('am-grp-dragging');
        var r = tr.getBoundingClientRect();
        var wrap = document.createElement('table');
        wrap.className = 'am-table am-grp am-grp-ghost';
        wrap.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + (startW || r.width) + 'px;pointer-events:none;z-index:9999;';
        if (startTable) {
          var cg0 = startTable.querySelector('colgroup');
          if (cg0) wrap.appendChild(cg0.cloneNode(true));
        }
        var tb2 = document.createElement('tbody');
        var clone = tr.cloneNode(true);
        clone.classList.remove('am-grp-dragging');
        tb2.appendChild(clone);
        wrap.appendChild(tb2);
        // 必须挂在 #am-root 内：AM 的样式都带 #am-root 作用域，挂 body 会让封面按原图尺寸撑满
        (document.getElementById('am-root') || document.body).appendChild(wrap);
        ghost = wrap;
      }, 480);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  /* V4.4.9：HTML5 拖动（歌曲行/列头）期间同样标注 busy，切歌时延迟整表重绘 */
  document.addEventListener('dragstart', function (e) {
    var el = e.target;
    if (el && el.closest && el.closest('#am-root .am-table')) window.__amDragBusy = true;
  }, true);
  document.addEventListener('dragend', function () {
    window.__amDragBusy = false;
    if (window.__amFlushDragRender) window.__amFlushDragRender();
  }, true);
  document.addEventListener('drop', function () {
    window.__amDragBusy = false;
    if (window.__amFlushDragRender) window.__amFlushDragRender();
  }, true);
  function renderTrackTable(c, tracks) {
    setTimeout(scrollMemRestoreView, 0);   // V4.4.9：列表渲染完成后尝试恢复内容区滚动（重启场景）
    var tb = el('table', 'am-table');
    var inPlaylist = S.view.indexOf('pl:') === 0;
    var grp = amSongGroupOn() ? buildGroupEntries(tracks) : null;   // V4.4.9：歌曲视图按专辑分组（连续块）
    S._grpOn = !!grp;
    if (!grp) S._grpManualOn = false;
    var opts = {
      withCover: !grp, // V4.4.9：分组模式去掉行内封面（只留组封面）
      grouped: !!grp,
      inPlaylist: inPlaylist,
      plId: inPlaylist ? S.view.slice(3) : null,
      tracks: tracks
    };
    if (S.msOn || (S.msSel && S.msSel.size)) renderMsToolbar(c, tracks); // V4.3.22：多选工具条（全选/删除选中/退出）；V4.4 快速多选有选中即显示
    else { try { var _r0 = document.getElementById('am-root'); if (_r0) _r0.style.setProperty('--am-ms-h', '0px'); } catch (e0) { } }
    if (grp) tb.className = 'am-table am-grp';
    buildTableHead(tb, grp, opts);   // V4.4.9：列头可拖宽 / 换位（封面固定最左）
    var body = el('tbody');
    tb.appendChild(body);
    c.appendChild(tb);
    layoutCols(tb); watchCols(tb);   // V4.4.9：列宽按可用宽度换算 + 跟随容器变化

    if (tracks.length <= AM_WINDOW_MIN) {
      S._tbl = null;
      if (grp) renderGroupRows(body, grp, opts);
      else tracks.forEach(function (t, i) { body.appendChild(buildTrackRow(t, i, opts)); });
      return;
    }
    // 窗口化：可视区 ±15 行
    var rowH = opts.withCover ? AM_ROW_H_COVER : AM_ROW_H_PLAIN;
    var cols = (opts.withCover || grp ? 5 : 4) + (S.msOn ? 1 : 0);
    var win = grp
      ? { grp: true, entries: grp.entries, offsets: grp.offsets, totalH: grp.totalH, trkEntry: grp.trkEntry, tracks: tracks, opts: opts, body: body, tb: tb, rowH: AM_GRP_ROW_H, cols: cols, lastStart: -1, lastEnd: -1 }
      : { tracks: tracks, opts: opts, body: body, tb: tb, rowH: rowH, cols: cols, lastStart: -1, lastEnd: -1 };
    S._tbl = win;
    renderAmWindow();
  }
  function renderAmWindow() {
    var win = S._tbl, c = R.content;
    if (!win || !c || !win.body.isConnected) { return; }
    if (win.grp) { renderAmWindowGrp(win, c); return; }   // V4.4.9：专辑分组窗口化
    /* V4.4：隐藏中（迷你模式 .am-body display:none）不算窗口——
     * clientHeight=0 会算出「顶部几行+巨大垫片」的假窗口，恢复显示后视口落在垫片上=列表空白。
     * 标脏返回，保持现有 DOM；恢复可见后由 exitMini/滚动事件重开。 */
    if (!c.clientHeight) { win.lastStart = -1; win.lastEnd = -1; return; }
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
    azSyncActive(win, start); // V4.3.8：滚动联动索引栏当前字母
  }

  /* ---------- V4.3.8：A–Z 索引栏（仅全曲库「歌曲」视图，配合 am.js 首字母排序） ---------- */
  function renderAzBar(c, tracks) {
    var cache = S._azCache;
    if (!cache || cache.out !== tracks) return; // 非首字母排序结果（理论不发生）不出栏
    var firstIdx = cache.firstIdx;
    var bar = el('div', 'am-az');
    var present = [];
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('').forEach(function (L) {
      var has = firstIdx[L] !== undefined;
      if (has) present.push(L);
      var s = el('span', 'am-az-l' + (has ? '' : ' off'), L);
      if (has) {
        s.dataset.letter = L;
        s.onclick = function () { azJump(L); };
      }
      bar.appendChild(s);
    });
    S._az = { bar: bar, firstIdx: firstIdx, present: present, cur: '' };
    // 挂 .am-body（content 是滚动容器，索引栏需悬浮且不随 innerHTML 清空）
    (c.parentElement || c).appendChild(bar);
  }
  function azJump(L) {
    var az = S._az;
    if (!az) return;
    var idx = az.firstIdx[L];
    if (idx === undefined) return;
    var c = R.content, win = S._tbl;
    if (win && win.body.isConnected) {
      // 窗口化：与 scrollRowIntoView 同一套 base 换算；
      // 再多回退「表头 + 一行 + 6px」，否则字母组首行会被 sticky 表头（歌曲/艺人/专辑）盖住
      if (win.grp) {
        var _ee = win.trkEntry[idx], _gg = _ee != null ? win.entries[_ee].grp : null;
        if (_gg && isGrpCollapsed(_gg)) { expandGrp(_gg); renderView(); setTimeout(function () { azJump(L); }, 30); return; }
        var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
        var base = win.tb.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop + headH;
        c.scrollTo({ top: base + win.offsets[_ee] - headH - win.rowH - 6, behavior: 'smooth' });
        return;
      }
      var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
      var base = win.tb.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop + headH;
      c.scrollTo({ top: base + idx * win.rowH - headH - win.rowH - 6, behavior: 'smooth' });
    } else {
      var row = null;
      if (amSongGroupOn()) {   // V4.4.9：分组后行序≠曲目序，按 path 找
        var _tk = currentTracks()[idx];
        row = _tk ? c.querySelector('.am-tr[data-path="' + CSS.escape(_tk.path) + '"]') : null;
      } else {
        var rows = c.querySelectorAll('tr.am-tr');
        row = rows[idx];
      }
      if (row) {
        // V4.3.11 修复：不能用 scrollIntoView——它会连 #am-root（fixed 壳）一起滚，把顶栏顶出视口
        //（用户实锤：点字母索引后顶部播放栏消失）。与窗口化路径同算法手动滚容器，
        // 并回退「表头 + 一行 + 6px」防 sticky 表头遮挡。
        var thead = c.querySelector('thead');
        var headH2 = thead ? thead.offsetHeight : 0;
        var cRect = c.getBoundingClientRect();
        var top = row.getBoundingClientRect().top - cRect.top + c.scrollTop - headH2 - row.offsetHeight - 6;
        c.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }
  /* 滚动时按首个可见行反推当前字母并高亮（仅窗口化路径调用，小列表无感） */
  function azSyncActive(win, start) {
    var az = S._az;
    if (!az || !az.bar.isConnected) return;
    var cur = az.present[0] || '';
    for (var i = 0; i < az.present.length; i++) {
      if (az.firstIdx[az.present[i]] <= start) cur = az.present[i]; else break;
    }
    if (cur === az.cur) return;
    az.cur = cur;
    var kids = az.bar.children;
    for (var k = 0; k < kids.length; k++) kids[k].classList.toggle('cur', kids[k].dataset.letter === cur);
  }

  /* V4.1：应用内输入对话框——Electron 不支持原生 window.prompt()（静默无反应），
   * 全局挂 window.anniePrompt(title, 默认值, cb) 供所有主题/设置面板使用。 */
  function amPrompt(title, defVal, cb) {
    var ov = el('div', 'am-prompt-ov');
    var box = el('div', 'am-prompt');
    box.appendChild(el('div', 'am-pop-h', title));
    var inp = document.createElement('input');
    inp.className = 'am-prompt-in';
    inp.value = defVal || '';
    box.appendChild(inp);
    var row = el('div', 'am-prompt-btns');
    var bNo = el('button', 'am-btn', '取消');
    var bOk = el('button', 'am-btn am-btn-accent', '确定');
    function close(v) { ov.remove(); if (v != null) cb(v); }
    bNo.onclick = function () { close(null); };
    bOk.onclick = function () { var v = inp.value.trim(); if (v) close(v); else inp.focus(); };
    inp.onkeydown = function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') bOk.onclick();
      else if (e.key === 'Escape') close(null);
    };
    ov.onclick = function (e) { if (e.target === ov) close(null); };
    row.appendChild(bNo); row.appendChild(bOk);
    box.appendChild(row); ov.appendChild(box);
    document.body.appendChild(ov); // 挂 body：设置面板/其他主题同样可用（CSS 变量带兜底值）
    inp.focus(); inp.select();
  }
  window.anniePrompt = amPrompt;

  /* V4.3.26：弹出菜单二级浮层（歌单太多把右键菜单顶出屏幕的修复）。
   * 二级层挂在 pop 内部（外点关闭监听只认 pop 节点，独立浮层会被瞬间点掉——AGENTS.md 规范第 2 条），
   * 用 position:fixed 摆脱父级 overflow；右侧放不下自动翻左，上下避让。 */
  function buildPopSubMenu(parentPop, label, list, onPick) {
    var btn = el('button', 'am-pop-item am-pop-sub', label + '（' + list.length + ' 个）');
    var arrow = el('span', 'am-pop-sub-arrow', '▸');
    btn.appendChild(arrow);
    var sub = el('div', 'am-pop-sub-panel');
    list.forEach(function (item) {
      var it = el('button', 'am-pop-item', item.label);
      it.onclick = function () { parentPop.classList.remove('on'); onPick(item); };
      sub.appendChild(it);
    });
    function place() {
      clearTimeout(sub._t); sub.classList.add('on');
      var br = btn.getBoundingClientRect();
      var sw = sub.offsetWidth, sh = sub.offsetHeight;
      var sx = br.right + 4;
      if (sx + sw > window.innerWidth - 8) sx = br.left - sw - 4; // 右侧放不下翻左
      if (sx < 8) sx = Math.max(8, window.innerWidth - sw - 8);
      var sy = br.top - 4;
      sy = Math.max(8, Math.min(sy, window.innerHeight - sh - 8));
      var _pr = parentPop.getBoundingClientRect(); sub.style.left = (sx - _pr.left) + 'px';
      sub.style.top = (sy - _pr.top) + 'px';
    }
    function hide() { clearTimeout(sub._t); sub._t = setTimeout(function () { sub.classList.remove('on'); }, 180); }
    btn.onmouseenter = place;
    btn.onclick = function (e) { e.stopPropagation(); if (!sub.classList.contains('on')) place(); };
    btn.onmouseleave = function (e) {
      var to = e.relatedTarget;
      if (to && (to === sub || sub.contains(to))) return;
      hide();
    };
    sub.onmouseleave = function (e) {
      var to = e.relatedTarget;
      if (to && to === btn) return;
      hide();
    };
    btn.appendChild(sub);
    parentPop.appendChild(btn);
    return btn;
  }
  AM.buildPopSubMenu = buildPopSubMenu;

  /* "添加到播放列表"菜单 */
  /* V4.4：拖外部音频文件/文件夹加入播放列表（侧栏歌单 / 歌单视图均可作落点；内部行拖拽不带 Files 类型，互不干扰） */
  var PL_DROP_RE = /\.(flac|wav|ape|aiff?|alac|tta|wv|dsf|dff|m4a|mp3|aac|ogg|opus|wma|cue)$/i;
  function plDropHasFiles(e) {
    try { return !!(e.dataTransfer && [].indexOf.call(e.dataTransfer.types, 'Files') >= 0); } catch (er) { return false; }
  }
  // 拖入项原始路径（音频文件 + 文件夹，不递归展开；递归由主进程 drop:expand 完成）
  function plDropRawPaths(e) {
    try {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return [];
      var out = [];
      for (var i = 0; i < e.dataTransfer.files.length; i++) {
        var p = window.mine.getPathForFile(e.dataTransfer.files[i]);
        if (p) out.push(p);
      }
      return out;
    } catch (er) { return []; }
  }
  // 仅音频文件路径（兼容旧调用；文件夹要走 drop:expand 递归）
  function plDroppedPaths(e) {
    try {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return [];
      var out = [];
      for (var i = 0; i < e.dataTransfer.files.length; i++) {
        var p = window.mine.getPathForFile(e.dataTransfer.files[i]);
        if (p && PL_DROP_RE.test(p)) out.push(p);
      }
      return out;
    } catch (er) { return []; }
  }
  // 异步：递归展开拖入的文件夹/文件为音频路径，供加入歌单使用
  async function plExpandDropped(e) {
    var raw = plDropRawPaths(e);
    if (!raw.length) return [];
    try {
      var tracks = await window.mine.dropExpand(raw);
      return (tracks || []).map(function (t) { return t.path; }).filter(Boolean);
    } catch (er) { return plDroppedPaths(e); }
  }
  function addDroppedToPlaylist(plId, paths, before) {
    if (!paths.length) { try { if (typeof proToast === 'function') proToast('没有可识别的音频文件'); } catch (e) { } return; }
    var pl0 = S.playlists.find(function (p) { return p.id === plId; });
    var oldLen = pl0 ? pl0.paths.length : 0;
    window.mine.playlistAdd(plId, paths, before, true).then(function (pls) { // 主进程去重 + 按曲目号/文件名自动排序
      S.playlists = pls; renderSidebar();
      if (S.view === 'pl:' + plId) renderView();
      var pl1 = pls.find(function (p) { return p.id === plId; });
      var added = pl1 ? pl1.paths.length - oldLen : paths.length;
      try {
        if (typeof proToast === 'function') proToast(added > 0 ? '📥 已加入 ' + added + ' 首到歌单（已自动排序）' : '这些歌曲已在歌单中');
      } catch (e) { }
    }).catch(function () { });
  }

  // V4.4.1：文件夹拖到侧栏播放列表区空白处 → 以文件夹名建歌单，内装递归展开后的音频；
  // 散文件拖到空白处仍走全局 queue 追加（proUi.js 的 window drop 处理），这里只管文件夹。
  async function bindSidebarFolderDrop(rootEl) {
    if (!rootEl || rootEl._sbFolderDropBound) return;
    rootEl._sbFolderDropBound = true;
    rootEl.addEventListener('dragover', function (e) {
      if (!plDropHasFiles(e)) return;
      var onPlaylist = e.target && e.target.closest && e.target.closest('[data-plid]');
      if (onPlaylist) return; // 落在具体歌单上，让该按钮自己高亮
      // 仅当落点在侧栏播放列表区才提示"建歌单"
      var inSide = e.target && e.target.closest && e.target.closest('.am-side');
      if (!inSide) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (er) { }
      inSide.classList.add('am-side-drop');
    });
    rootEl.addEventListener('dragleave', function (e) {
      var inSide = e.target && e.target.closest && e.target.closest('.am-side');
      if (inSide) inSide.classList.remove('am-side-drop');
    });
    rootEl.addEventListener('drop', async function (e) {
      if (!plDropHasFiles(e)) return;
      var inSide = e.target && e.target.closest && e.target.closest('.am-side');
      if (!inSide) return;
      var onPlaylist = e.target && e.target.closest && e.target.closest('[data-plid]');
      inSide.classList.remove('am-side-drop');
      if (onPlaylist) return; // 落在具体歌单按钮，按钮自己处理；这里不重复建歌单
      e.preventDefault(); e.stopPropagation();
      var collected = await window.annieCollectDropped(e.dataTransfer.files);
      var folders = collected.folders || [];
      if (!folders.length) return; // 纯散文件：交给全局 queue 追加逻辑，不建歌单
      var created = 0;
      for (var i = 0; i < folders.length; i++) {
        var f = folders[i];
        var name = f.name || (f.path.split(/[\\/]/).pop() || '新建播放列表');
        var pls = await window.mine.playlistCreate(name).catch(function () { return null; });
        if (!pls || !pls.length) continue;
        var pl = pls[pls.length - 1];
        // drop:expand 已递归展开文件夹，直接拿到音频路径
        var tracks = await window.mine.dropExpand([f.path]).catch(function () { return []; });
        var paths = (tracks || []).map(function (t) { return t.path; }).filter(Boolean);
        if (paths.length) await window.mine.playlistAdd(pl.id, paths, null, true).catch(function () { });
        created++;
      }
      if (created > 0) {
        S.playlists = await window.mine.playlists().catch(function () { return S.playlists; });
        renderSidebar();
        if (typeof proToast === 'function') proToast('已从文件夹新建 ' + created + ' 个播放列表');
      }
    });
  }

  function openAddMenu(x, y, trackPath) {
    var pop = R.pop;
    pop.innerHTML = '';
    // V4.4：多选感知——右键/⊕ 的目标行在快速选择集合内时，歌单/删除/标签操作作用于整组选中（与 fb2k forEachSel 对齐）
    var selPaths = (S.msSel && S.msSel.size > 1 && S.msSel.has(trackPath)) ? Array.from(S.msSel) : [trackPath];
    pop.appendChild(el('div', 'am-pop-head', selPaths.length > 1 ? '已选 ' + selPaths.length + ' 首' : '歌曲操作')); // V4.4：改不可点分组标题（原 .am-pop-item 可点样式无功能，误导点击）
    pop.appendChild(el('div', 'am-pop-sep'));
    var mte = el('button', 'am-pop-item', '✏️ 编辑标签…');
    mte.onclick = function () {
      pop.classList.remove('on');
      if (window.annieTagEdit) window.annieTagEdit.open(selPaths.length > 1 ? { paths: selPaths } : { path: trackPath });
    };
    pop.appendChild(mte);
    var mch = el('button', 'am-pop-item', '🔎 在线匹配歌词 / 封面…');
    mch.onclick = function () {
      pop.classList.remove('on');
      if (window.annieMatch) window.annieMatch.open({ path: trackPath });
    };
    pop.appendChild(mch);
    // V4.3.22：查看所在专辑——跳到专辑视图并打开该曲所属专辑
    var mal = el('button', 'am-pop-item', '💿 查看所在专辑');
    mal.onclick = function () {
      pop.classList.remove('on');
      var t = null;
      allTracks().forEach(function (x) { if (x.path === trackPath) t = x; });
      if (!t) return;
      S.view = 'albums'; S.albumKey = trackMeta(t).album || '未知专辑'; S.folderPath = null;
      renderSidebar(); renderView();
    };
    pop.appendChild(mal);
    // V4.4：打开文件位置（资源管理器定位并选中该文件）
    var mof = el('button', 'am-pop-item', '📂 打开文件位置');
    mof.onclick = function () {
      pop.classList.remove('on');
      if (window.mine.showItemInFolder) window.mine.showItemInFolder(trackPath);
    };
    pop.appendChild(mof);
    // V4.3.16：相似歌曲推荐（零云端本地打分）
    var msr = el('button', 'am-pop-item', '✨ 找相似歌曲…');
    msr.onclick = function () {
      pop.classList.remove('on');
      if (window.annieSimilar) window.annieSimilar.open(trackPath);
    };
    pop.appendChild(msr);
    // V4.3.21：一键电台（种子 + 相似链式续播）
    var mrd = el('button', 'am-pop-item',
      (window.annieSimilar && annieSimilar.radio.isOn()) ? '📻 关闭电台' : '📻 一键电台');
    mrd.onclick = function () {
      pop.classList.remove('on');
      if (!window.annieSimilar) return;
      if (annieSimilar.radio.isOn()) {
        annieSimilar.radio.stop();
        try { if (typeof proToast === 'function') proToast('📻 电台已关闭'); } catch (e) { }
      } else annieSimilar.radio.start(trackPath);
    };
    pop.appendChild(mrd);
    // V4.3.22：多选（歌曲/专辑详情/喜爱歌曲/播放列表视图）——进入多选模式并选中本行
    if (S.view === 'songs' || S.view === 'favorites' || (S.view === 'albums' && S.albumKey) || S.view.indexOf('pl:') === 0) {
      var mms = el('button', 'am-pop-item', '☑ 多选');
      mms.onclick = function () { pop.classList.remove('on'); S.msOn = true; S.msSel = new Set([trackPath]); renderKeepScroll(); };
      pop.appendChild(mms);
    }
    // V4.4：歌单视图里右键「移除」默认只移出本歌单（不碰曲库/其他歌单）——
    // 此前只有「删除…」（tracksHide 全歌单同步剔除），用户删歌单1的歌把歌单2也删了
    if (S.view.indexOf('pl:') === 0) {
      var mrm = el('button', 'am-pop-item', selPaths.length > 1 ? '✕ 从本播放列表移除 ' + selPaths.length + ' 首' : '✕ 从本播放列表移除');
      mrm.onclick = function () {
        pop.classList.remove('on');
        var plId = S.view.slice(3);
        var pl = S.playlists.find(function (p) { return p.id === plId; });
        if (!pl) return;
        if (selPaths.length > 1) { // 批量：复用 playlistReorder 整组替换 paths
          var del = new Set(selPaths);
          window.mine.playlistReorder(plId, pl.paths.filter(function (p) { return !del.has(p); })).then(function (pls) {
            S.playlists = pls; if (S.msSel) S.msSel.clear(); renderSidebar(); renderView();
          });
        } else {
          window.mine.playlistRemove(plId, trackPath).then(function (pls) {
            S.playlists = pls; renderSidebar(); renderView();
          });
        }
      };
      pop.appendChild(mrm);
    }
    // V4.3.22：删除——弹窗勾选：仅移出曲库显示 / 连同源文件入回收站（从曲库删=所有歌单同步移除）
    var mdel = el('button', 'am-pop-item', selPaths.length > 1 ? '🗑 从曲库删除 ' + selPaths.length + ' 首…' : '🗑 从曲库删除…');
    mdel.onclick = function () { pop.classList.remove('on'); deleteTracks(selPaths); };
    pop.appendChild(mdel);
    // V4.3.19：歌词海报（仅当前播放且有歌词的行；竖版 1080×1620，含封面/音质/节选歌词/版本号）
    try {
      var isCurTrack = (typeof state !== 'undefined' && state && state.currentPath === trackPath);
      if (isCurTrack && S.lyrLines && S.lyrLines.length) {
        var mpp = el('button', 'am-pop-item', '🖼 生成歌词海报');
        mpp.onclick = function () {
          pop.classList.remove('on');
          if (window.anniePoster) window.anniePoster.open(trackPath);
        };
        pop.appendChild(mpp);
      }
    } catch (e) { }
    pop.appendChild(el('div', 'am-pop-sep'));
    // V4.3.26：歌单 >8 个收敛为二级浮层，避免右键菜单被歌单列表顶出屏幕
    function doAddToPl(pl) {
      window.mine.playlistAdd(pl.id, selPaths).then(function (pls) {
        S.playlists = pls;
        if (S.view === 'pl:' + pl.id) renderView();
        try { if (selPaths.length > 1 && typeof proToast === 'function') proToast('📥 已把 ' + selPaths.length + ' 首加入「' + pl.name + '」'); } catch (e) { }
      });
    }
    if (S.playlists.length > 8) {
      buildPopSubMenu(pop, '📁 加入播放列表…', S.playlists.map(function (pl) {
        return { label: pl.name + '（' + (pl.paths || []).length + ' 首）', pl: pl };
      }), function (item) { doAddToPl(item.pl); });
    } else {
      S.playlists.forEach(function (pl) {
        var it = el('button', 'am-pop-item', pl.name);
        it.onclick = function () { pop.classList.remove('on'); doAddToPl(pl); };
        pop.appendChild(it);
      });
    }
    if (S.playlists.length) pop.appendChild(el('div', 'am-pop-sep'));
    var nw = el('button', 'am-pop-item', '＋ 新建播放列表…');
    nw.onclick = function () {
      pop.classList.remove('on');
      amPrompt('播放列表名称', '新建播放列表', function (name) {
        window.mine.playlistCreate(name).then(function (pls) {
          S.playlists = pls;
          return window.mine.playlistAdd(pls[pls.length - 1].id, selPaths);
        }).then(function (pls) { S.playlists = pls; renderSidebar(); });
      });
    };
    pop.appendChild(nw);
    pop.classList.add('on');
    var w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - h - 12) + 'px';
  }

  /* 滚动到指定曲目行并闪烁高亮（窗口化时先按索引滚再重建可视区）。
   * opts.auto：自动定位模式——行已在可视区内则不打扰（手动双击播放等场景）。 */
  function scrollRowIntoView(p, opts) {
    opts = opts || {};
    setTimeout(function () {
      if (!R.content) return;
      var sel = '.am-tr[data-path="' + CSS.escape(p) + '"]';
      var row = R.content.querySelector(sel);
      if (!row && S._tbl) {
        // 窗口化渲染：目标行不在 DOM，按索引算 scrollTop 滚过去再重建可视区
        var win = S._tbl, idx = -1;
        for (var k = 0; k < win.tracks.length; k++) if (win.tracks[k].path === p) { idx = k; break; }
        if (idx < 0) return;
        if (win.grp) {
          var _e = win.trkEntry[idx], _g = _e != null ? win.entries[_e].grp : null;
          if (_g && isGrpCollapsed(_g)) { expandGrp(_g); renderView(); scrollRowIntoView(p, opts); return; }
          var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
          var base = win.tb.getBoundingClientRect().top - R.content.getBoundingClientRect().top + R.content.scrollTop + headH;
          R.content.scrollTop = Math.max(0, base + win.offsets[_e] + win.rowH / 2 - R.content.clientHeight / 2);
          renderAmWindow();
          row = R.content.querySelector(sel);
        } else {
          var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
          var base = win.tb.getBoundingClientRect().top - R.content.getBoundingClientRect().top + R.content.scrollTop + headH;
          R.content.scrollTop = Math.max(0, base + idx * win.rowH - (R.content.clientHeight - win.rowH) / 2);
          renderAmWindow();
          row = R.content.querySelector(sel);
        }
      } else if (row) {
        // 非窗口化：手动滚容器——不能用 scrollIntoView，它会连 #am-root（fixed 壳）一起滚，把顶栏顶出视口
        var cRect = R.content.getBoundingClientRect();
        var rRect = row.getBoundingClientRect();
        var visible = rRect.top >= cRect.top && rRect.bottom <= cRect.bottom;
        if (visible && opts.auto) return; // 已在可视区：自动定位不打扰
        if (!visible) {
          var target = R.content.scrollTop + (rRect.top - cRect.top) - (cRect.height - rRect.height) / 2;
          if (R.content.scrollTo) R.content.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
          else R.content.scrollTop = Math.max(0, target);
        }
      }
      if (!row) return;
      var root = document.getElementById('am-root');
      if (root && root.scrollTop) root.scrollTop = 0; // 防御：壳容器永不允许滚动
      if (opts.flash === false) return;
      row.classList.remove('locate-flash');
      void row.offsetWidth; // 重启动画
      row.classList.add('locate-flash');
      setTimeout(function () { row.classList.remove('locate-flash'); }, 2000);
    }, 60);
  }

  /* 定位当前播放文件：当前视图找不到时切回歌曲全库，滚动到播放行并闪烁高亮 */
  function locatePlaying() {
    var p = state.currentPath;
    // V4.3.13：流媒体/在线歌单也能定位——回到来源视图滚动高亮当前行
    if (state.currentStream) { if (AM.locateStream) AM.locateStream(); return; }
    if (!p) return;
    var inView = currentTracks().some(function (t) { return t.path === p; });
    if (!inView) {
      S.view = 'songs'; S.albumKey = null; S.folderPath = null; S.search = '';
      renderSidebar();
    }
    renderView();
    scrollRowIntoView(p, { auto: false });
  }


  /* 注册到模块桥（供其他分片取用） */
  AM.build = build;
  AM.renderSidebar = renderSidebar;
  AM.renderView = renderView;
  AM.renderAmWindow = renderAmWindow;
  AM.scrollRowIntoView = scrollRowIntoView;
})();

/* 所有搜索框「✕ 清空」按钮（按输入框位置定位，不贴容器右边） */
(function () {
  if (window.__amClearBtn) return;
  window.__amClearBtn = 1;
  function isSearch(inp) {
    if (!inp || inp.tagName !== 'INPUT') return false;
    var ty = (inp.type || 'text').toLowerCase();
    if (ty !== 'text' && ty !== 'search') return false;
    var ph = inp.placeholder || '';
    if (/搜索|Search|search|粘贴|链接/.test(ph)) return true;
    var cls = inp.className || '';
    if (/am-search|am-st-input|search|qz/i.test(cls)) return true;
    if (inp.closest && inp.closest('.am-search,.am-view-head,.am-qz-bar,.am-st-bar,.am-searchbox')) return true;
    return false;
  }
  function place(inp, btn) {
    var p = btn.parentElement;
    if (!p) return;
    var ir = inp.getBoundingClientRect(), pr = p.getBoundingClientRect();
    if (!ir.width || !pr.width) return;
    btn.style.left = Math.round(ir.right - pr.left - 24) + 'px';
    btn.style.top = Math.round(ir.top - pr.top + ir.height / 2) + 'px';
  }
  function sync(inp) {
    var p = inp.parentElement;
    if (!p) return;
    var btn = null;
    for (var i = 0; i < p.children.length; i++) {
      if (p.children[i].classList && p.children[i].classList.contains('am-clear-btn')) { btn = p.children[i]; break; }
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'am-clear-btn';
      btn.title = '清空';
      btn.textContent = '✕';
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        try { inp.focus(); } catch (er) { }
        btn.style.display = 'none';
        inp.style.paddingRight = '';
      });
      if (getComputedStyle(p).position === 'static') p.style.position = 'relative';
      p.appendChild(btn);
    }
    var has = !!inp.value;
    btn.style.display = has ? '' : 'none';
    inp.style.paddingRight = has ? '26px' : '';
    if (has) place(inp, btn);
  }
  function scan() {
    var list = document.querySelectorAll('input');
    for (var i = 0; i < list.length; i++) if (isSearch(list[i])) sync(list[i]);
  }
  function reposition() {
    var list = document.querySelectorAll('.am-clear-btn');
    for (var i = 0; i < list.length; i++) {
      var btn = list[i];
      var inp = btn.parentElement && btn.parentElement.querySelector('input');
      if (inp && btn.style.display !== 'none') place(inp, btn);
    }
  }
  var raf = 0;
  function schedule() { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; reposition(); }); }
  document.addEventListener('input', function (e) { if (isSearch(e.target)) sync(e.target); }, true);
  document.addEventListener('focusin', function (e) { if (isSearch(e.target)) sync(e.target); }, true);
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, true);
  var tmr = 0;
  try {
    new MutationObserver(function () { clearTimeout(tmr); tmr = setTimeout(scan, 150); })
      .observe(document.body, { childList: true, subtree: true });
  } catch (e) { }
  setTimeout(scan, 600);
  setTimeout(scan, 2000);
})();
