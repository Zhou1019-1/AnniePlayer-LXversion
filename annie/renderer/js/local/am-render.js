'use strict';
/* ===== am.js 拆分片：am-render.js =====
 * 状态刷新与外壳：播放状态/封面刷新、播放定时弹层、待播清单/历史/评论、沉浸模式、迷你模式、频谱条、引擎事件、挂载导出
 * 来源：am.js 原稿行 1691-1771 + 1800-2447（原样切片，零行为变更）
 * 共享变量经 window.__annieAMInternal 桥接；前向引用为转发桩，运行时解析。 */
(function () {
  // V4.4.8：沉浸层线性图标（SVG，替代 emoji 字形）
  function immSvgIcon(d, size) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('width', String(size || 15)); s.setAttribute('height', String(size || 15));
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d); p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.5');
    p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p); return s;
  }
  var AM = window.__annieAMInternal || (window.__annieAMInternal = {}); // AM 主题内部模块桥（跨分片共享闭包变量）
  // 从桥取用先加载分片导出的引用（此时前片已执行完，引用有效）
  var S = AM.S;
  var R = AM.R;
  var el = AM.el;
  var fmtTime = AM.fmtTime;
  var fmtRemain = AM.fmtRemain;
  var isLight = AM.isLight;
  var allTracks = AM.allTracks;
  var trackMeta = AM.trackMeta;
  var ensureCover = AM.ensureCover;
  var albumCover = AM.albumCover;
  /* 曲目封面：优先本文件内嵌图（同专辑不同内嵌图各不相同），取不到再退回专辑级共享封面 */
  function trackCover(t, cb) {
    var p = '';
    try { p = (t && (t.path || (t.cue && t.cue.src) || (t.iso && t.iso.src))) || ''; } catch (e) { p = ''; }
    if (!p) { albumCover(t, cb); return; }
    ensureCover(p, function (u) {
      if (u) cb(u);
      else albumCover(t, cb);
    });
  }
  var albumKeyOf = AM.albumKeyOf;
  var srcFileOf = AM.srcFileOf;
  var refreshPlaylists = AM.refreshPlaylists;
  var playList = AM.playList;
  var togglePlay = AM.togglePlay;
  var next = AM.next;
  var prev = AM.prev;
  var seek = AM.seek;
  var bindProgDrag = AM.bindProgDrag; // V4.3.16：进度条拖动（顶栏/沉浸/迷你共用）
  var playStreamAt = AM.playStreamAt;
  var patchStreamPlayNext = AM.patchStreamPlayNext;
  var build = AM.build;
  var renderSidebar = AM.renderSidebar;
  var renderView = AM.renderView;
  var renderAmWindow = AM.renderAmWindow;
  var scrollRowIntoView = AM.scrollRowIntoView;
  var currentTracks = AM.currentTracks;
  var loadLyrics = AM.loadLyrics;
  var tickLyrics = AM.tickLyrics;
  var refitAllLyr = AM.refitAllLyr;
  var applyLyrStyle = AM.applyLyrStyle;
  var rerenderAllLyr = AM.rerenderAllLyr;
  var buildLyrInto = AM.buildLyrInto;
  var autoHideScrollbar = AM.autoHideScrollbar;

  /* 提前注册到模块桥：本片片尾的自挂载会经其他片的桩回调这些函数（function 声明有提升，此处引用有效） */
  AM.syncModeBtn = syncModeBtn;
  AM.syncTimerBtn = syncTimerBtn;
  AM.toggleTimerPop = toggleTimerPop;
  AM.toggleImmersive = toggleImmersive;
  AM.enterMini = enterMini;
  AM.buildMini = buildMini;
  AM.refreshBadge = refreshBadge;
  AM.refreshCacheBadge = refreshCacheBadge;

function amModeSvg(id) {
    var SH = '<path d="M2.6 5.2 H5.1 C6.1 5.2 6.9 5.6 7.5 6.3 L10.3 9.5 C10.9 10.2 11.7 10.6 12.7 10.6 H13.2 M12 8.7 L13.9 10.6 L12 12.5 M2.6 10.6 H5.1 C6.1 10.6 6.9 10.2 7.5 9.5 L10.3 6.3 C10.9 5.6 11.7 5.2 12.7 5.2 H13.2 M12 3.3 L13.9 5.2 L12 7.1"/>';
    if (id === 'all-rand') {
      return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SH + '</svg>';
    }
    if (id === 'list-rand') {
      /* 列表内随机：外框表示「只在本列表」 */
      return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + '<rect x="1.3" y="1.3" width="13.4" height="13.4" rx="3.6" stroke-opacity=".75"/><g transform="translate(2.7 2.7) scale(0.66)">' + SH + '</g></svg>';
    }
    if (id === 'all-seq') {
      /* 全文件顺序：三条杠 */
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>';
    }
    if (id === 'list-seq') {
      /* 列表内顺序：上右箭头 + 下左箭头（直线） */
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h12"/><path d="M15 5.5 18 8 15 10.5"/><path d="M18 16H6"/><path d="M9 13.5 6 16 9 18.5"/></svg>';
    }
    var key = { 'repeat-one': 'modeRepeatOne' }[id];
    if (typeof window.ico === 'function' && key) return window.ico(key, 16);
    return null;
  }function amModeSvg(id) {
    var SH = '<path d="M2.6 5.2 H5.1 C6.1 5.2 6.9 5.6 7.5 6.3 L10.3 9.5 C10.9 10.2 11.7 10.6 12.7 10.6 H13.2 M12 8.7 L13.9 10.6 L12 12.5 M2.6 10.6 H5.1 C6.1 10.6 6.9 10.2 7.5 9.5 L10.3 6.3 C10.9 5.6 11.7 5.2 12.7 5.2 H13.2 M12 3.3 L13.9 5.2 L12 7.1"/>';
    if (id === 'all-rand') {
      return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SH + '</svg>';
    }
    if (id === 'list-rand') {
      /* 列表内随机：外框表示「只在本列表」 */
      return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + '<rect x="1.3" y="1.3" width="13.4" height="13.4" rx="3.6" stroke-opacity=".75"/><g transform="translate(2.7 2.7) scale(0.66)">' + SH + '</g></svg>';
    }
    if (id === 'all-seq') {
      /* 全文件顺序：三条杠 */
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>';
    }
    if (id === 'list-seq') {
      /* 列表内顺序：上右箭头 + 下左箭头（直线） */
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h12"/><path d="M15 5.5 18 8 15 10.5"/><path d="M18 16H6"/><path d="M9 13.5 6 16 9 18.5"/></svg>';
    }
    var key = { 'repeat-one': 'modeRepeatOne' }[id];
    if (typeof window.ico === 'function' && key) return window.ico(key, 16);
    return null;
  }  /* ================= 播放模式 / 播放定时（仅本地播放生效） ================= */
  function syncModeBtn() {
    if (!R.btnMode || !window.anniePlayMode) return;
    var inf = window.anniePlayMode.info();
    R.btnMode.innerHTML = amModeSvg(inf.id) || inf.icon;
    R.btnMode.title = '播放模式：' + inf.label + (inf.hint ? '\n' + inf.hint : '') + '\n（本地全量生效；在线播放支持顺序/随机/单曲循环，点击切换）';
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
    // V4.4.6：顶栏精简后 btnTimer 收进「⋯」菜单（不在 DOM，rect 全 0），锚点改用 ⋯ 按钮
    var anchor = (R.btnTimer && R.btnTimer.isConnected) ? R.btnTimer : R.btnMore;
    var r = anchor.getBoundingClientRect();
    pop.classList.add('on'); // 先显示再测量（display:none 时 offsetHeight 为 0）
    pop.style.left = Math.max(8, r.right - 280) + 'px';
    var tbBottom = document.getElementById('am-root').classList.contains('am-topbar-bottom');
    pop.style.top = tbBottom ? Math.max(8, r.top - pop.offsetHeight - 8) + 'px' : (r.bottom + 8) + 'px';
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

  /* ================= 待播清单 / 历史记录（沉浸与迷你共享） ================= */
  /* V4.5：把曲目插到「下一首」或待播清单末尾——右键菜单 / 多选工具条共用。
     paths 为曲目路径数组；append=true 追加到末尾，否则插到当前曲之后。返回实际入列数量。 */
  function enqueueNext(paths, append) {
    var list = (paths || []).filter(function (p) { return !!p; });
    if (!list.length) return 0;
    var byPath = {};
    try { (allTracks() || []).forEach(function (t) { if (t && t.path) byPath[t.path] = t; }); } catch (e) { }
    var items = list.map(function (p) {
      return byPath[p] || { path: p, name: String(p).split(/[\\/]/).pop() };
    });
    var q = state.queue || (state.queue = []);
    var cur = (state.index == null) ? -1 : (state.index | 0);
    var at = (append || !q.length) ? q.length : Math.max(0, cur + 1);
    q.splice.apply(q, [at, 0].concat(items));
    if (at <= cur) state.index = cur + items.length;  // 插在当前曲之前：索引跟着后移，保持当前曲不变
    /* 已打开的待播面板要重建（新行要出现），但重建会把滚动位置归零——
       这里先记下当前滚动位置，重建（分帧）完成后再还原，避免浏览到中间时被弹回顶部 */
    try { if (S.qOn && R.qDrawer) refreshQueueKeepPos(R.qDrawer, at, items.length); } catch (e1) { }
    try { if (S.immQOn && R.immQ && S.imm) refreshQueueKeepPos(R.immQ, at, items.length); } catch (e2) { }
    try { if (S.miniQOn && R.miniQ) refreshQueueKeepPos(R.miniQ, at, items.length); } catch (e3) { }
    return items.length;
  }
  /* 刷新已打开的待播面板并保住滚动位置：重建前登记，重建（分帧）完成后在 pump 末尾还原 */
  function refreshQueueKeepPos(box, insertAt, count) {
    if (!box) return;
    qKeepCapture(box, insertAt, count);
    S._qJumpCur = false;   // 插入/追加刷新优先保持当前位置，不跳到当前曲
    /* 队列不大时一次性同步建完：避免「清空 → 分帧插入」之间那几帧空白，
       否则即使最后滚回原位，观感上还是"跳了一下" */
    _qSyncDrain = true;
    try { renderQueuePanel(box); } finally { _qSyncDrain = false; }
  }
  var _qSyncDrain = false;
  /* —— 面板重建后的滚动保持 ——
     renderQueuePanel 会 box.innerHTML='' 再分帧重建，scrollTop 必然归零（原来只在「打开面板」时
     跳一次当前曲）。这里在刷新前记下「视口内第一行 + 它相对列表顶部的偏移」，分帧建完后按该行的
     新行号（新行插在它上方则 +插入数）滚回同一偏移。全部用 getBoundingClientRect 计算，
     不依赖 offsetParent，也不受逐帧插入时 scrollHeight 还在增长的影响（只在最后一行建完后写一次）。 */
  var qKeepMap = new WeakMap();
  function qKeepCapture(box, insertAt, count) {
    var rec = null;
    try {
      var l = box.querySelector('.am-q-list');
      if (l && l.scrollTop > 0) {
        var lr = l.getBoundingClientRect(), rows = l.querySelectorAll('.am-q-row');
        for (var i = 0; i < rows.length; i++) {
          var rr = rows[i].getBoundingClientRect();
          if (rr.bottom > lr.top + 4) {   // 视口内第一行（可能露出半行）
            rec = { idx: i, off: rr.top - lr.top, at: insertAt, n: count, ts: Date.now() };
            break;
          }
        }
      }
    } catch (e) { }
    if (rec) qKeepMap.set(box, rec); else qKeepMap['delete'](box);
  }
  function qKeepTake(box) {
    var rec = box && qKeepMap.get(box);
    if (!rec) return null;
    qKeepMap['delete'](box);
    return (Date.now() - rec.ts > 5000) ? null : rec;   // 超过 5s 视为过期，不抢用户此刻的滚动
  }
  function qKeepApply(box, list, rec) {
    try {
      var rows = list.querySelectorAll('.am-q-row');
      if (!rows.length) return;
      var idx = rec.idx;
      if (rec.at != null && rec.at <= idx) idx += (rec.n || 0);   // 新行落在这行上方 → 行号后移
      if (idx < 0) idx = 0;
      if (idx >= rows.length) idx = rows.length - 1;
      var lr = list.getBoundingClientRect();
      var top0 = rows[idx].getBoundingClientRect().top - lr.top;  // 此刻 scrollTop 仍为 0
      var want = top0 - rec.off;
      list.scrollTop = Math.max(0, Math.min(want, list.scrollHeight - list.clientHeight));
    } catch (e) { }
  }
  /* 待播面板滚动：用 rAF 自己做缓动（逐帧写 scrollTop），不依赖元素的 scroll-behavior。
     · 常规距离（≤2.5 屏）全程缓动，easeOutCubic，时长按距离伸缩；
     · 超长距离（几百行）先瞬移到终点前 1.5 屏，再缓动滑完最后一屏——整段跨越时浏览器要逐帧
       绘制上百个新进视口的行，实测会掉到 10fps 左右（单帧 100~200ms），反而更不流畅；
     · 逐帧只前进 1~2 行时滚动本身稳定在 ~10ms/帧（压测无 >50ms 的帧）。 */
  function qSmoothScroll(el, top) {
    try {
      if (!el) return;
      var max = Math.max(0, el.scrollHeight - el.clientHeight);
      var want = Math.max(0, Math.min(top, max));
      var from = el.scrollTop;
      var dist = want - from;
      if (Math.abs(dist) < 4) return;
      if (Math.abs(dist) > el.clientHeight * 4) {
        el.scrollTop = want - (dist > 0 ? 1 : -1) * el.clientHeight * 4;
        from = el.scrollTop;
        dist = want - from;
      }
      var t0 = performance.now();
      var dur = Math.min(520, Math.max(220, Math.abs(dist) * 0.18));
      if (el.__qScrollRAF) cancelAnimationFrame(el.__qScrollRAF);
      (function step(now) {
        var k = (now - t0) / dur; if (!(k > 0)) k = 0; else if (k > 1) k = 1;   // rAF 时间戳可能早于 t0
        var e = 1 - Math.pow(1 - k, 3);            // easeOutCubic
        el.scrollTop = from + dist * e;
        el.__qScrollRAF = (k < 1) ? requestAnimationFrame(step) : 0;
      })(t0);
    } catch (e) { try { el.scrollTop = top; } catch (e2) { } }
  }
  function renderQueuePanel(box) {
    box.innerHTML = '';
    /* V4.3：沉浸队列抽屉收回小标签——贴在抽屉左缘外侧垂直居中（收回指引此前不明确） */
    if (box === R.immQ || box === R.qDrawer) {
      var fold = el('button', 'am-imm-q-fold', '❯');
      fold.title = '收回面板';
      fold.onclick = function () {
        if (box === R.qDrawer) toggleMainQueue(false);
        else setImmQueue(false);
      };
      box.appendChild(fold);
    }
    var tabs = el('div', 'am-q-tabs');
    var tQ = el('button', 'am-q-tab' + (S.qTab !== 'hist' && S.qTab !== 'cmt' ? ' cur' : ''), '待播清单');
    var tH = el('button', 'am-q-tab' + (S.qTab === 'hist' ? ' cur' : ''), '历史记录');
    var tC = el('button', 'am-q-tab' + (S.qTab === 'cmt' ? ' cur' : ''), '评论');
    tQ.onclick = function () { S.qTab = 'queue'; renderQueuePanel(box); };
    tH.onclick = function () { S.qTab = 'hist'; renderQueuePanel(box); };
    tC.onclick = function () { S.qTab = 'cmt'; renderQueuePanel(box); };
    tabs.appendChild(tQ); tabs.appendChild(tH); tabs.appendChild(tC);
    box.appendChild(tabs);
    var list = el('div', 'am-q-list');
    box.appendChild(list);
    /* 取出「刷新前登记的滚动位置」（仅待播清单页签），分帧渲染完成后在 pump 末尾还原 */
    var qKeep = (S.qTab !== 'hist' && S.qTab !== 'cmt') ? qKeepTake(box) : null;

    /* V3.5.19：网易云热门评论——流媒体 wy 曲目直接用 songmid，其他按「歌名 歌手」搜 wy 取首条 */
    if (S.qTab === 'cmt') {
      var cmtQ = {};
      if (state.currentStream) {
        var ctr = state.currentStream;
        if (ctr.provider === 'wy' && ctr.meta && ctr.meta.songmid) cmtQ.songmid = ctr.meta.songmid;
        cmtQ.name = ctr.title || ctr.name || ''; cmtQ.artist = ctr.artist || '';
      } else if (state.currentPath) {
        var cm = trackMeta({ path: state.currentPath });
        cmtQ.name = cm.title || ''; cmtQ.artist = cm.artist || '';
      }
      var cmtKey = (state.currentStream ? state.currentStream.url : state.currentPath) || '';
      list.appendChild(el('div', 'am-q-empty', '正在加载网易云热门评论…'));
      window.mine.streamHotComments(cmtQ).then(function (r) {
        var nowKey = (state.currentStream ? state.currentStream.url : state.currentPath) || '';
        if (nowKey !== cmtKey || S.qTab !== 'cmt') return; // 切歌/切页签后丢弃旧响应
        list.innerHTML = '';
        if (!r || !r.ok || !r.comments || !r.comments.length) {
          list.appendChild(el('div', 'am-q-empty', (r && r.error) || '暂无评论（该曲可能未收录网易云）'));
          return;
        }
        list.appendChild(el('div', 'am-q-empty am-q-cmt', '网易云热门评论 · 共 ' + (r.total || r.comments.length) + ' 条'));
        r.comments.forEach(function (c) {
          var row = el('div', 'am-cmt-row');
          row.appendChild(el('div', 'am-cmt-text', c.text));
          row.appendChild(el('div', 'am-cmt-meta', (c.userName || '匿名') + (c.likedCount ? ' · 👍 ' + c.likedCount : '') + (c.timeStr ? ' · ' + c.timeStr : '')));
          list.appendChild(row);
        });
      }).catch(function (e) {
        list.innerHTML = '';
        list.appendChild(el('div', 'am-q-empty', '加载失败：' + (e && e.message ? e.message : e)));
      });
      return;
    }

    var qDragIdx = -1; // V3.5.15：待播清单拖拽排序（仅本地队列分支）
    /* V4.4.7（PR#6）：封面懒解析——队列可能上千首，原来每一行都排一次 meta 解析，
       点开面板要等好几秒。改成只有滚到列表可视区 ±400px 内才真正去解。 */
    var qCoverObs = null, qCoverPend = new WeakMap();
    function qCoverLazy(img, track) {
      if (typeof IntersectionObserver !== 'function') { trackCover(track, function (u) { if (u) img.src = u; }); return; }
      if (!qCoverObs) {
        qCoverObs = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            var en = entries[i];
            if (!en.isIntersecting) continue;
            qCoverObs.unobserve(en.target);
            var tr = qCoverPend.get(en.target);
            qCoverPend['delete'](en.target);
            if (tr) trackCover(tr, (function (node) { return function (u) { if (u) node.src = u; }; })(en.target));
          }
        }, { root: list, rootMargin: '400px 0px' });
      }
      qCoverPend.set(img, track);
      qCoverObs.observe(img);
    }
    var addRow = function (coverUrl, track, title, sub, durText, cur, onclick, opts) {
      var row = el('div', 'am-q-row' + (cur ? ' cur' : ''));
      if (track && track.path) row.dataset.path = track.path; // V4.4.9：切歌时按 path 只改高亮，不整表重建
      var img = document.createElement('img');
      img.className = 'am-q-cover'; img.alt = ''; img.draggable = false;
      if (coverUrl) img.src = coverUrl;
      else if (track) qCoverLazy(img, track);
      row.appendChild(img);
      var tx = el('div', 'am-q-tx');
      tx.appendChild(el('div', 'am-q-title', title));
      tx.appendChild(el('div', 'am-q-sub', sub));
      row.appendChild(tx);
      row.appendChild(el('div', 'am-q-dur', durText || ''));
      if (opts && opts.onRemove) {
        var del = el('button', 'am-q-del', '✕');
        del.title = '从待播清单移除';
        del.onclick = function (e) { e.stopPropagation(); opts.onRemove(); };
        row.appendChild(del);
      }
      if (opts && typeof opts.dragIdx === 'number') {
        var myIdx = opts.dragIdx;
        row.title = '拖拽调整顺序';
        /* 用 Pointer 事件拖动：原生 HTML5 拖拽期间浏览器不派发滚轮事件，无法滚轮翻页 */
        row.addEventListener('pointerdown', function (e) {
          if (e.button !== 0) return;
          if (e.target.closest && e.target.closest('.am-q-del')) return;
          var pid = e.pointerId, sy = e.clientY, active = false, tgt = null, after = false;
          try { row.setPointerCapture(pid); } catch (er) { }
          function clearOver() {
            var xs = list.querySelectorAll('.am-q-row.drag-over');
            for (var z = 0; z < xs.length; z++) xs[z].classList.remove('drag-over');
          }
          function onMove(ev) {
            if (!active) {
              if (Math.abs(ev.clientY - sy) < 5) return;
              active = true; row.classList.add('q-drag-src');
            }
            var under = document.elementFromPoint(ev.clientX, ev.clientY);
            var r2 = under && under.closest ? under.closest('.am-q-row') : null;
            clearOver();
            tgt = null;
            if (r2 && r2 !== row) {
              var rr = r2.getBoundingClientRect();
              after = (ev.clientY - rr.top) > rr.height / 2;
              r2.classList.add('drag-over');
              tgt = r2;
            }
            var lr = list.getBoundingClientRect();
            if (ev.clientY < lr.top + 60) list.scrollTop -= 12;
            else if (ev.clientY > lr.bottom - 60) list.scrollTop += 12;
            ev.preventDefault();
          }
          function onUp() {
            row.removeEventListener('pointermove', onMove);
            row.removeEventListener('pointerup', onUp);
            row.removeEventListener('pointercancel', onUp);
            row.classList.remove('q-drag-src');
            clearOver();
            try { row.releasePointerCapture(pid); } catch (er2) { }
            if (!active || !tgt) return;
            row._dragMoved = true;
            setTimeout(function () { row._dragMoved = false; }, 60);
            var rows = Array.prototype.slice.call(list.querySelectorAll('.am-q-row'));
            var toIdx = rows.indexOf(tgt);
            if (toIdx < 0) return;
            var insertAt = toIdx > myIdx ? toIdx - 1 : toIdx;
            if (after) insertAt += 1;
            if (insertAt !== myIdx) moveQueueRow(myIdx, insertAt);
          }
          row.addEventListener('pointermove', onMove);
          row.addEventListener('pointerup', onUp);
          row.addEventListener('pointercancel', onUp);
        });
      }
      row.onclick = function (e) {
        if (row._dragMoved) { row._dragMoved = false; e.stopPropagation(); e.preventDefault(); return; }
        if (onclick) onclick.call(row, e);
      };
      list.appendChild(row);
    }

    /* V3.5.15：待播清单编辑——重排/移除后按当前播放路径重映射索引（播放模式即时取索引，无内部顺序缓存） */
    function remapQueueIndex() {
      var q = state.queue, cp = state.currentPath;
      state.index = -1;
      for (var i = 0; i < q.length; i++) if (q[i] && q[i].path === cp) { state.index = i; break; }
      if (state.index < 0) state.index = Math.min(state.index + 1, q.length - 1);
    }
    function moveQueueRow(from, to) {
      var q = state.queue;
      if (from < 0 || from >= q.length || to < 0 || to >= q.length) return;
      var item = q.splice(from, 1)[0];
      q.splice(to, 0, item);
      remapQueueIndex();
      renderQueuePanel(box);
    }
    function removeQueueRow(idx) {
      var q = state.queue;
      if (idx < 0 || idx >= q.length) return;
      q.splice(idx, 1);
      if (idx === state.index) {
        // 移除正在播放的行：直接切到顺位下一首
        if (q.length) { renderQueuePanel(box); playAt(Math.min(idx, q.length - 1)); return; }
        state.index = -1;
      } else remapQueueIndex();
      renderQueuePanel(box);
    }

    if (S.qTab !== 'hist') {
      // 待播清单：流媒体用搜索结果队列，本地用 state.queue（完整队列，当前曲高亮）
      if (state.currentStream) {
        // V4.3.13：跟随实际播放队列（在线歌单快照 S._playList），不是搜索结果列表
        var rs = S._playList || S.stResults || [];
        if (!rs.length) { list.appendChild(el('div', 'am-q-empty', '（无待播曲目）')); return; }
        rs.forEach(function (song, i) {
          addRow(song.cover || '', null, song.title || song.name || '', song.artist || '',
            // V4.3.13 修复：洛雪 SDK 的 duration 是毫秒（其他地方都 /1000，这里漏了）
            song.duration ? fmtTime(song.duration / 1000) : '', i === S.stIndex,
            function () { playStreamAt(i, S._playList || S.stResults); });
        });
        return;
      }
      var q = state.queue || [];
      if (!q.length) { list.appendChild(el('div', 'am-q-empty', '（无待播曲目）')); return; }
      list.appendChild(el('div', 'am-q-empty', '拖拽调整顺序，✕ 移除'));
      try {
        var _qq = state.queue || [];
        var _qn = _qq.length;
        list.setAttribute('data-qsig', 'L' + _qn + '|' +
          String(_qn ? ((_qq[0] && (_qq[0].path || _qq[0].id || _qq[0].title || '')) || '') : '').slice(-24) + '|' +
          String(_qn ? ((_qq[_qn - 1] && (_qq[_qn - 1].path || _qq[_qn - 1].id || _qq[_qn - 1].title || '')) || '') : '').slice(-24));
      } catch (eQ) { }

      /* 待播清单分帧渲染的世代号（切歌重建、关面板/重开、清空互不干扰）——
         只被下面的 pumpQueueRows 用到，所以放在这里而不是信息面板块里。
         分包时注意：这段必须跟「队列行分帧」同一个 PR，否则会 ReferenceError。 */
      var _qGens = new WeakMap();
      function qGenNext(box) { var g = (_qGens.get(box) || 0) + 1; _qGens.set(box, g); return g; }
      function qGenLive(box, g) { return _qGens.get(box) === g; }
      /* V4.4.7（PR#6）：队列可能有上万首——原来一次性同步建几千行、每行还排一次封面解析，
         面板要等好几秒才弹出来。改成先建外壳 + 每帧只干 ~8ms（超预算就交还事件循环）。 */
      /* V4.4.9：渲染完整队列（此前从 state.index 起，点选靠后的歌会让上面已播曲目从列表消失） */
      var qGen = qGenNext(box), qPut = 0, qStop = q.length;
      var qSyncNow = _qSyncDrain && qStop <= 600;   // 队列不大：一次建完，避免多帧空白
      (function pumpQueueRows() {
      if (!qGenLive(box, qGen)) return;        // 同一容器又开了一轮渲染 → 这一轮作废
      var qT0 = performance.now();
      while (qPut < qStop && (qSyncNow || performance.now() - qT0 < 8)) {
      var i = qPut++;
        (function (t, idx) {
          var m = trackMeta(t);
          var dm = S.meta[t.path];
          addRow(null, t, m.title, m.artist + (m.album ? ' — ' + m.album : ''),
            dm && dm.duration ? fmtTime(dm.duration) : '', idx === state.index,
            function () { playAt(idx); },
            { dragIdx: idx, onRemove: function () { removeQueueRow(idx); } });
        })(q[i], i);
      }
      if (qPut < qStop) { setTimeout(pumpQueueRows, 0); return; }
      /* 打开面板 / 从别的列表开始播放时把当前曲滚进可视区（只跳一次，避免跟随播放打断手动浏览） */
      if (S._qJumpCur) {
        S._qJumpCur = false;
        try {
          var curRow = list.querySelector('.am-q-row.cur');
          if (curRow) {
            /* 用 rect 计算：行的 offsetParent 是抽屉而不是列表，offsetTop 会把上方页签也算进去 */
            var lrJ = list.getBoundingClientRect(), crJ = curRow.getBoundingClientRect();
            /* 重建后直接瞬时定位：列表是从 0 开始新建的，做动画会变成“从顶上滚下来” */
            var wantJ = list.scrollTop + (crJ.top - lrJ.top) - (list.clientHeight - curRow.offsetHeight) / 2;
            list.scrollTop = Math.max(0, Math.min(wantJ, list.scrollHeight - list.clientHeight));
          }
        } catch (e0) { }
      } else if (qKeep) {
        qKeepApply(box, list, qKeep);
      }

      })();
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
  /* V4.4：沉浸样式双模式——classic 经典双栏 | vinyl 彩胶唱片（仿 QQ 音乐：封面圆盘 + 封面取色刻纹 + 旋转） */
  function immMode() {
    try { return (window.annieSettings && annieSettings.ui && annieSettings.ui.amImmMode) || 'classic'; } catch (e) { return 'classic'; }
  }
  AM.immIsVinyl = function () { return immMode() === 'vinyl'; }; // 供 am-lyrics 更新链路判「歌词常驻」
  /* V4.4：自动在线补全的封面补显——当前曲无封面时用匹配到的在线封面（仅显示，不落盘） */
  AM.autoCoverFill = function (path, coverUrl) {
    if (!coverUrl || !state.currentPath || state.currentStream) return;
    var cur = (state.currentCue && state.currentCue.src) || (state.currentIso && state.currentIso.src) || state.currentPath;
    if (cur !== path) return;
    if (R.npCover && R.npCover.getAttribute('src')) return; // 已有封面不抢
    swapCover(R.npCover, coverUrl);
    swapAtmosphere(coverUrl);
    syncAuxViews();
  };
  AM.vinylCrownSeek = function (from, to) { vinylCrownSeek(from, to); }; // 歌词点跳等其它 seek 入口也甩碟（无彩胶时内部空转）
  function buildImmControls() { // 两种布局共用的传输/音量/队列按钮（引用挂 R 上供 syncAux/refreshAux 用）
    var ctl = el('div', 'am-imm-ctl');
    var vol = el('span', 'am-imm-vol');
    vol.appendChild(el('span', null, '🔊'));
    R.immVol = document.createElement('input');
    R.immVol.type = 'range'; R.immVol.min = 0; R.immVol.max = 100; R.immVol.className = 'am-imm-volin';
    R.immVol.oninput = function () {
      if (R.vol) { R.vol.value = R.immVol.value; R.vol.oninput(); }
      // 暂停时没有进度 tick，直接给一次音量 OSD（播放时由 immOsdTick 统一检测，值已同步不会重复弹）
      if (S.imm) {
        var v = +R.immVol.value;
        showImmOsd('<span class="am-imm-osd-ic">' + (v === 0 ? '🔇' : (v < 50 ? '🔈' : '🔊')) + '</span><span class="am-imm-osd-vol">' + v + '%</span>');
        _immLastVol = v;
      }
    };
    vol.appendChild(R.immVol);
    ctl.appendChild(vol);
    var bP = el('button', 'am-imm-btn', '⏮'); bP.onclick = prev;
    R.immPlay = el('button', 'am-imm-btn am-imm-play', '▶'); R.immPlay.onclick = togglePlay;
    var bN = el('button', 'am-imm-btn', '⏭'); bN.onclick = next;
    ctl.appendChild(bP); ctl.appendChild(R.immPlay); ctl.appendChild(bN);
    R.immBtnLyr = el('button', 'am-imm-btn', '');
    R.immBtnLyr.appendChild(immSvgIcon('M4.4 4.4 h7.2 a1.6 1.6 0 0 1 1.6 1.6 v4.0 a1.6 1.6 0 0 1 -1.6 1.6 h-3.9 l-2.5 1.9 v-1.9 a1.6 1.6 0 0 1 -1.6 -1.6 v-4.0 a1.6 1.6 0 0 1 1.6 -1.6 z', 24));
 R.immBtnLyr.title = '歌词（再点收起）';
    R.immBtnLyr.onclick = function () { setImmLyr(!S.immLyrOn); };
    R.immBtnQ = el('button', 'am-imm-btn', '☰'); R.immBtnQ.title = '待播清单 / 历史记录';
    R.immBtnQ.onclick = function () { setImmQueue(!S.immQOn); };
    ctl.appendChild(R.immBtnLyr); ctl.appendChild(R.immBtnQ);
    return ctl;
  }
  function buildImmProg() {
    var prog = el('div', 'am-imm-prog');
    R.immCur = el('span', 'am-imm-time', '0:00');
    var bar = el('div', 'am-imm-bar');
    R.immFill = el('div', 'am-imm-fill');
    bar.appendChild(R.immFill);
    // V4.4：彩胶表把联动钩子（经典模式无 R.immVinyl，钩子内部空转）
    bindProgDrag(bar, R.immFill, R.immCur, { onPreview: vinylCrownPreview, onSeek: vinylCrownSeek });
    R.immRemain = el('span', 'am-imm-time', '-0:00');
    prog.appendChild(R.immCur); prog.appendChild(bar); prog.appendChild(R.immRemain);
    return prog;
  }
  /* ---------- 彩胶旋转：rAF 惯性物理（暂停减速 / 恢复加速 / 切歌重启）+ 表把联动 ----------
     旧实现走 CSS animation + animation-play-state（瞬停瞬起）；V4.4 改为逐帧积分：
     omega 按指数曲线逼近目标转速（播放=360/speedSec，暂停=0），视觉上像真实唱盘的惯性。
     表把甩碟与跟手转动并入同一角度：transform = rotate(angle + crownOffset)，每帧统一写入。 */
  var _crownOffset = 0, _crownDragBase = null, _crownT = 0;
  var CROWN_DEG_PER_SEC = 6; // 表把手感：每 scrub 1 秒音频转 6°（一分钟音频=一整圈）
  var _vinylAngle = 0, _vinylOmega = 0, _vinylRAF = 0, _vinylLastT = 0, _vinylSpeedSec = 18, _vinylSeek = null;
  var VINYL_TAU_SPIN = 1.4;   // 启动加速时间常数（秒，越大越肉）
  var VINYL_TAU_STOP = 0.85;  // 停转减速时间常数
  function vinylWriteTransform() {
    if (R.immVinyl) R.immVinyl.style.transform = 'rotate(' + (_vinylAngle + _crownOffset) + 'deg)';
  }
  function vinylStep(t) {
    // 时间戳倒挂保护：看门狗用 performance.now() 补步后，迟到的 rAF 帧可能带着更早的时间戳
    // 到达（rAF t 是渲染时刻，可早于回调执行时刻），负 dt 会把 ω 反向修正、盘体越转越慢。
    if (_vinylLastT && t <= _vinylLastT) return false;
    if (!_vinylLastT) _vinylLastT = t;
    var dt = Math.min(0.05, (t - _vinylLastT) / 1000); // t 单位是毫秒，先除 1000 转秒再 clamp（曾把括号括错，dt 缩小 100 倍致盘体几乎不转）
    _vinylLastT = t;
    // 表把甩碟推进（easeOutCubic 550ms，结束后整圈归一防数值膨胀）
    if (_vinylSeek) {
      var p = Math.min(1, (performance.now() - _vinylSeek.t0) / 550);
      var e = 1 - Math.pow(1 - p, 3);
      _crownOffset = _vinylSeek.base + _vinylSeek.delta * e;
      if (p >= 1) {
        _crownOffset = ((_crownOffset % 360) + 360) % 360;
        _vinylSeek = null;
      }
    }
    // 切歌转场期间盘体目标转速视为 0（视觉淡出后从静止启动）
    var switching = R.imm.classList.contains('am-vinyl-switch');
    var target = (state.playing && !switching) ? 360 / Math.max(4, _vinylSpeedSec) : 0;
    var tau = target > _vinylOmega ? VINYL_TAU_SPIN : VINYL_TAU_STOP;
    _vinylOmega += (target - _vinylOmega) * (1 - Math.exp(-dt / tau));
    if (target === 0 && _vinylOmega < 0.35) _vinylOmega = 0;
    // 停稳后挂 still 类（暂停慢速流光）；阈值迟滞避免临界点反复 toggle
    var still = _vinylOmega === 0 && target === 0;
    if (R.immVinyl.classList.contains('am-vinyl-still') !== still) R.immVinyl.classList.toggle('am-vinyl-still', still);
    _vinylAngle = (_vinylAngle + _vinylOmega * dt) % 360000; // 限幅防超长会话数值膨胀
    vinylWriteTransform();
  }
  function vinylFrame(t) {
    _vinylRAF = 0;
    if (!R.immVinyl || !S.imm) { _vinylLastT = 0; return; }
    vinylStep(t);
    _vinylRAF = requestAnimationFrame(vinylFrame);
  }
  /* V4.4：rAF 看门狗——某些环境（窗口遮挡误判/后台节流开关失效）rAF 会被饿到 ~1fps，
     此时用计时器手工补一步；计时器在 backgroundThrottling:false 下不受遮挡节流影响。 */
  var _vinylWatch = 0;
  function vinylWatchTick() {
    if (!S.imm || !R.immVinyl) { if (_vinylWatch) { clearInterval(_vinylWatch); _vinylWatch = 0; } return; }
    if (_vinylLastT && performance.now() - _vinylLastT > 60) vinylStep(performance.now());
  }
  function vinylStartSpin() {
    _vinylLastT = 0;
    if (!_vinylRAF) _vinylRAF = requestAnimationFrame(vinylFrame);
    if (!_vinylWatch) _vinylWatch = setInterval(vinylWatchTick, 30);
  }
  function vinylStopSpin() {
    if (_vinylRAF) { cancelAnimationFrame(_vinylRAF); _vinylRAF = 0; }
    if (_vinylWatch) { clearInterval(_vinylWatch); _vinylWatch = 0; }
    _vinylLastT = 0; _vinylSeek = null;
  }
  /* 切歌：盘体短暂淡出微缩再淡入，转速归零后随播放自然加速（rAF 检测 am-vinyl-switch 类） */
  function vinylSwitch() {
    if (!R.immVinyl || !R.imm) return;
    _vinylOmega = 0;
    R.imm.classList.remove('am-vinyl-switch');
    void R.immVinyl.offsetWidth;
    R.imm.classList.add('am-vinyl-switch');
    clearTimeout(vinylSwitch._t);
    vinylSwitch._t = setTimeout(function () { if (R.imm) R.imm.classList.remove('am-vinyl-switch'); }, 900);
  }
  function vinylCrownApply(deg, transition) {
    if (!R.immVinyl) return;
    _crownOffset = deg; // transition 参数已废弃（rAF 统一驱动，保留签名兼容调用处）
    vinylWriteTransform();
  }
  function vinylCrownPreview(sec) {
    if (!R.immVinyl) return;
    _vinylSeek = null; // 跟手打断甩碟动画
    if (_crownDragBase == null) _crownDragBase = { sec: sec, offset: _crownOffset };
    clearTimeout(_crownT);
    _crownOffset = _crownDragBase.offset + (sec - _crownDragBase.sec) * CROWN_DEG_PER_SEC;
    vinylWriteTransform();
  }
  function vinylCrownSeek(from, to) {
    /* 沉浸进度条点/拖之后立刻对齐歌词，不等下一次 tick */
    setTimeout(function () { try { if (AM.lyrJumpToCur) AM.lyrJumpToCur(); } catch (e) { } }, 60);
    if (!R.immVinyl) { _crownDragBase = null; return; }
    _crownDragBase = null;
    var dir = to >= from ? 1 : -1;
    var burst = dir * Math.min(540, 120 + Math.abs(to - from) * 8); // 跳得越远甩得越多，上限一圈半
    _vinylSeek = { t0: performance.now(), base: _crownOffset, delta: burst };
  }
  /* ================= V4.4.7（秋野奈 PR#6）：沉浸模式「歌曲信息面板」 =================
   * 左上角 ↓ 唤出：面板自屏幕顶部下拉，半透明黑 + 毛玻璃背景；
   * 内容：标题 / 歌手 / 专辑 / 格式 / 位深 · 采样率 / 码率 / 声道 / 时长 / 文件大小 / 文件路径；
   * 面板底部一条实时频谱——与主界面频谱条同一数据源（引擎 10Hz 推 32 频段）、同一套配色；
   * 再点按钮 / 点面板外 / Esc 收起；展开期间暂停「静止隐藏 chrome」，保证按钮始终可点。 */
  var _infoOn = false, _infoAt = 0, _infoRaf = 0, _infoSmooth = null, _infoMetaSeq = 0, _infoPassKey = '';
  var _infoGain = 1; // 频谱自动增益（平滑）
  /* 行顺序即面板里「标签 / 值」的显示顺序；值为空的行连同标签整行隐藏 */
  var IMM_INFO_ROWS = [
    ['格式', 'fmt'],
    ['位深 · 采样率', 'depth'],
    ['码率', 'bitrate'],
    ['声道', 'ch'],
    ['输出状态', 'out'],
    ['后端', 'dac'],
    ['响度', 'loud'],
    ['统计', 'plays'],
    ['播放进度', 'pos'],
    ['时长', 'dur'],
    ['文件大小', 'size'],
    ['文件路径', 'path']
  ];
  function infoFmtSize(n) {
    n = +n || 0;
    if (n <= 0) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n >= 100 ? 0 : 1) : n) + ' ' + u[i];
  }
  function infoSet(key, text) {
    var v = R.infoVal && R.infoVal[key];
    if (!v) return;
    var on = !!text;
    v.textContent = on ? text : '';
    v.style.display = on ? '' : 'none';
    if (v._k) v._k.style.display = on ? '' : 'none';
  }
  function infoKeyNow() { return (state.currentPath || '') + '|' + (S.fmt || '') + '|' + (S.dur > 0 ? '1' : '0'); }
  function refreshImmInfo() {
    if (!R.immInfo) return;
    _infoPassKey = infoKeyNow();
    var p = state.currentPath;
    var st = state.currentStream || null;
    var t = p ? allTracks().find(function (x) { return x.path === p; }) : null;
    var title = '', artist = '', album = '';
    if (p) {
      if (st) { title = st.title || p; artist = st.artist || ''; album = st.album || ''; }
      else if (state.currentCue && state.currentCue.title) {
        title = state.currentCue.title; artist = state.currentCue.artist || ''; album = state.currentCue.album || '';
      } else if (t) { var m = trackMeta(t); title = m.title; artist = m.artist; album = m.album; }
      if (!title) title = (t && t.name) || p;
    }
    R.infoTitle.textContent = title || '未在播放';
    R.infoSub.textContent = p ? [artist, album].filter(Boolean).join(' — ') : '';
    R.infoSub.style.display = R.infoSub.textContent ? '' : 'none';
    /* S.fmt 形如「FLAC · 24bit · 96kHz」（引擎实际输出）：拆成「格式」与「位深 · 采样率」两行，
       否则同一条信息会在面板里出现两遍 */
    var fparts = (S.fmt || '').split(' · ');
    infoSet('fmt', fparts[0] || '');
    infoSet('depth', fparts.slice(1).join(' · '));
    infoSet('bitrate', '');
    infoSet('ch', '');
    infoSet('dur', S.dur > 0 ? fmtTime(S.dur) : '');
    infoSet('size', t && t.size ? infoFmtSize(t.size) : '');
    infoSet('path', !p ? '' : (st ? '在线流媒体' + (st.source ? ' · ' + st.source : '') : p));
    refreshImmInfoExtra((state.currentCue && state.currentCue.src) || (state.currentIso && state.currentIso.src) || (t && t.path) || p);
    /* 位深/采样率/码率/声道/精确字节数只有主进程解析得到（metaCache 命中时纯内存返回，不读盘） */
    var src = (state.currentCue && state.currentCue.src) ||
              (state.currentIso && state.currentIso.src) || (t && t.path) || null;
    if (st || !src || !window.mine || !window.mine.meta) return;
    var seq = ++_infoMetaSeq;
    window.mine.meta(src).then(function (mm) {
      if (seq !== _infoMetaSeq || !_infoOn || !mm || !mm.ok) return; // 期间切歌/收面板：丢弃过期结果
      var bits = mm.bitsPerSample ? mm.bitsPerSample + 'bit' : '';
      var rate = mm.sampleRate ? (Math.round(mm.sampleRate / 100) / 10) + 'kHz' : '';
      if (mm.codec) infoSet('fmt', String(mm.codec).toUpperCase()); // 文件真实编码优先于引擎输出串
      if (bits || rate) infoSet('depth', [bits, rate].filter(Boolean).join(' · '));
      if (mm.bitrate) infoSet('bitrate', Math.round(mm.bitrate / 1000) + ' kbps');
      if (mm.channels) infoSet('ch', mm.channels === 1 ? '单声道' : (mm.channels === 2 ? '立体声' : mm.channels + ' 声道'));
      if (mm.fileSize) infoSet('size', infoFmtSize(mm.fileSize));
    }).catch(function () { });
  }
  /* V4.4.7（PR#6）：把旧「N 键媒体信息浮层」的内容并进来——输出状态 / 后端 / 响度 / 统计 / 进度 */
  var _infoExtraSeq = 0, _infoPosAt = 0;
  var _lrPeak = null;
  function refreshImmInfoExtra(srcPath) {
    var seq = ++_infoExtraSeq;
    infoSet('pos', S.dur > 0 ? fmtTime(S.pos || 0) + ' / ' + fmtTime(S.dur) : '');
    if (!window.mine) return;
    if (window.mine.engine) {
      window.mine.engine('stats').then(function (st) {
        if (seq !== _infoExtraSeq || !_infoOn || !st || st.ok === false) return;
        var reqRate = st.requestedRate ? (Math.round(st.requestedRate / 100) / 10) + 'kHz' : '';
        var outRate = st.outputRate ? (Math.round(st.outputRate / 100) / 10) + 'kHz' : '';
        var bits = st.bitsPerSample ? st.bitsPerSample + 'bit' : '';
        var mode = st.exclusive ? '独占' : '共享';
        var tail = '（' + mode + (st.resampled ? '，系统重采样' : '') + '）';
        /* 顺序与上面「位深 · 采样率」一致：位深在前、采样率在后 */
        var pair = function (rate, bit) { return [bit || '?', rate].filter(Boolean).join('/'); };
        infoSet('out', (reqRate && outRate && st.requestedRate !== st.outputRate)
          ? (pair(reqRate, bits) + ' → ' + pair(outRate, bits) + tail)
          : (pair(outRate, bits) + tail));
        infoSet('dac', (st.backendKind ? String(st.backendKind).toUpperCase() : '') + ' ' + mode + (st.deviceName ? ' · ' + st.deviceName : ''));
        if (typeof st.loudGain === 'number' && st.loudGain > 0) {
          var db = 20 * Math.log10(Math.max(1e-6, st.loudGain));
          infoSet('loud', (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB');
        } else { infoSet('loud', ''); }
      }).catch(function () { });
    }
    if (window.mine.statsGet && srcPath) {
      window.mine.statsGet(srcPath).then(function (map) {
        if (seq !== _infoExtraSeq || !_infoOn) return;
        var r = map && map[srcPath];
        if (!r || (!r.count && !r.totalSec)) { infoSet('plays', ''); return; }
        infoSet('plays', '播放 ' + (r.count || 0) + ' 次 · 累计 ' + Math.round((r.totalSec || 0) / 60) + ' 分钟');
      }).catch(function () { });
    }
  }
  /* V4.4.7（PR#6）：两个入口——N 键、点顶栏那个「FLAC · 16bit · 44.1kHz」胶囊。
     旧的 np-full 浮层已由 CSS 隐藏（它是另一套渲染，这里直接不给它出场机会）。 */
  var _infoAutoImm = false, _infoToggleAt = 0;
  /* V4.4.7：把面板从沉浸层搬到 #am-root 下的独立遮罩里（A 形态，不切沉浸） */
  function bindPanelBlankClose(ov, panel) {
    if (!panel || panel._amSb) return;
    panel._amSb = true;
    panel.addEventListener('click', function (e11) {
      var tg = e11.target;
      if (tg === panel || (tg.classList && tg.classList.contains('am-imm-info-inner')) ||
          (tg.classList && tg.classList.contains('am-imm-info-grid'))) {
        ov.classList.remove('on');
        setImmInfo(false);
        e11.stopPropagation();
      }
    }, true);
  }
  function ensureStandalonePanel() {
    if (R.infoOv) {
      /* 面板可能被搬回沉浸层（那一层是 display:none），也可能在沉浸层重建后换了节点：
         每次打开都确认它真的挂在遮罩里，并清掉遮罩里残留的旧面板节点 */
      try {
        if (R.immInfo && R.immInfo.parentElement !== R.infoOv) {
          var olds = R.infoOv.querySelectorAll('.am-imm-info');
          for (var oi = 0; oi < olds.length; oi++) olds[oi].parentNode.removeChild(olds[oi]);
          R.infoOv.appendChild(R.immInfo);
        }
        bindPanelBlankClose(R.infoOv, R.immInfo);
      } catch (e6b) { }
      return R.infoOv;
    }
    try {
      var ov = el('div', 'am-info-ov');
      if (!R.immInfo) {
        /* 沉浸层还没建过：直接在遮罩里建一套面板。
           不要用 toggleImmersive(true)+toggleImmersive(false) 去「借」沉浸层那套——
           那对一进一出在动画/状态守卫下会卡在沉浸模式里出不来（设置里点「进入氛围模式」就中招）。 */
        buildImmInfo(ov);
        R.immOv = null;                       // 这套面板不属于沉浸层
        if (R.immInfoBar) R.immInfoBar.style.display = 'none';   // 独立浮层不要左上角 ↓
      }
      if (!R.immInfo) return null;
      /* 点遮罩空白处 = 收起（整屏遮罩，点哪儿都算面板外） */
      ov.addEventListener('click', function (e10) {
        if (e10.target !== ov) return;
        ov.classList.remove('on');
        setImmInfo(false);
        e10.stopPropagation();
      }, true);
      bindPanelBlankClose(ov, R.immInfo);
      if (R.immInfo.parentElement !== ov) ov.appendChild(R.immInfo);
      document.getElementById('am-root').appendChild(ov);
      R.infoOv = ov;
      return ov;
    } catch (e7) { return null; }
  }
  function openImmInfoFromAnywhere() {
    if (Date.now() - _infoToggleAt < 400) return;
    if (Date.now() - (window.__amBadgeDragAt || 0) < 600) return;
    _infoToggleAt = Date.now();
    /* 氛围模式是全屏层：旧的「Now Playing 全屏」和歌词外观弹层都收掉，别叠在一起 */
    try {
      if (document.querySelector('#np-full.show') && window.annieProUi && window.annieProUi.toggleNpf) {
        window.annieProUi.toggleNpf(false);
      }
      if (R.lyrSetPop && R.lyrSetPop.classList.contains('on')) R.lyrSetPop.classList.remove('on');
    } catch (e16) { }
    try {
      /* 已经在沉浸模式里：沿用沉浸层自己的面板（那里有 ↓ 按钮和遮罩，不要抢过来） */
      if (S.imm) {
        if (R.infoOv && R.immInfo && R.immOv && R.immOv !== R.infoOv && R.infoOv.contains(R.immInfo)) {
          R.immOv.appendChild(R.immInfo);       // 搬回沉浸层
          R.infoOv.classList.remove('on');
          _infoOn = false;
          R.immInfo.classList.remove('on');
        }
        setImmInfo(!_infoOn);
        return;
      }
      if (_infoOn) { var ovc = ensureStandalonePanel(); setImmInfo(false); if (ovc) ovc.classList.remove('on'); return; }
      (function retry(n) {
        setTimeout(function () {
          var ov2 = ensureStandalonePanel();
          if (ov2) { ov2.classList.add('on'); setImmInfo(true); return; }
          if (n > 0) retry(n - 1);
        }, n === 12 ? 0 : 180);
      })(12);
    } catch (e) { }
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if ((e.key || '').toLowerCase() !== 'n') return;
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    /* 先拦下来：proUi 在 window 上还绑了一个 N（打开 #np-full 那套旧全屏 Now Playing），
       不拦的话按一次 N 会两个一起弹（输入框里除外，上面已经放行） */
    e.preventDefault(); e.stopPropagation();
    if (document.querySelector('.set-panel.on, #settings-panel.open')) return;
    /* 真的有菜单/弹层开着才让路：只看「有尺寸」的，且歌词外观弹层放行
       （它会在氛围面板上叠一层，N 应该把它收掉再开面板） */
    var pops = document.querySelectorAll('#am-root .am-pop.on');
    for (var pi = 0; pi < pops.length; pi++) {
      if (pops[pi].classList.contains('am-lyrset-pop')) continue;
      if (pops[pi].getBoundingClientRect().width > 0) return;
    }
    openImmInfoFromAnywhere();
  }, true);
  /* 直接给格式胶囊绑 onclick：有些布局下事件被别的处理器吃掉，光靠委托不保险 */
  function bindFmtBadge() {
    var list = document.querySelectorAll('#am-root .am-badge, #am-root .am-fmt');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b._amInfoBound) continue;
      if (!/(kHz|bit|FLAC|MP3|WAV|DSD|M4A)/i.test(b.textContent || '')) continue;
      b._amInfoBound = true;
      b.style.cursor = 'pointer';
      b.title = '歌曲信息（N）';
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        openImmInfoFromAnywhere();
      }, true);
    }
  }
  /* 兜底：按坐标命中（不依赖事件 target，也不依赖 click 是否被别处吃掉） */
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var n = document.elementFromPoint(e.clientX, e.clientY), i = 0;
    while (n && n !== document.body && i++ < 6) {
      var c = (typeof n.className === 'string') ? n.className : '';
      var txt = (n.textContent || '').trim();
      if (/(badge|fmt)/i.test(c) && /(kHz|bit|FLAC|MP3|WAV|DSD|M4A)/i.test(txt) && txt.length < 40) {
        // 只拦住拖动区行为，开面板交给 mouseup（否则一按下就开，拖动也会开）
        e.preventDefault();
        return;
      }
      n = n.parentElement;
    }
  }, true);
  /* 点底部频谱条 = 打开信息面板 */
  setTimeout(function () {
    try {
      var vb = document.querySelector('.am-vizbar') || document.getElementById('viz-bar') || document.querySelector('.viz-bar');
      if (vb && !vb._amInfoBound) {
        vb._amInfoBound = true;
        vb.style.cursor = 'pointer';
        vb.title = '歌曲信息（N）';
        vb.addEventListener('click', function (e8) { e8.stopImmediatePropagation(); e8.preventDefault(); openImmInfoFromAnywhere(); }, true);
      }
    } catch (e9) { }
  }, 1500);

  try {
    if (localStorage.getItem('amLRBar') === 'off') {
      var rootEl = document.getElementById('am-root');
      if (rootEl) rootEl.classList.add('am-lr-off');
    }
  } catch (e4) { }

  setInterval(function () {
    if (R.infoOv) R.infoOv.classList.toggle('on', !!_infoOn && !S.imm);
    /* 设置中心打开时不再顺手收掉氛围模式：点 ⚙ 只是打开设置，面板原样留在后面
       （设置是 z-index 200 的整层遮罩，会盖住面板；关掉设置后面板还在） */
    /* 沉浸层的 ↓ 按钮：buildImmInfo 每次重建都会重置它的 onclick，
       这里统一改绑到 openImmInfoFromAnywhere（它会先把面板搬回沉浸层再开） */
    /* 设置里「氛围模式（全屏频谱）」那块：改成信息面板的说明 + 入口 */
    (function () {
      try {
        if (window.__amAmbPatched) return;
        var btn = null, nodes = document.querySelectorAll('.set-row');
        for (var i = 0; i < nodes.length; i++) {
          if ((nodes[i].textContent || '').indexOf('氛围模式') >= 0) { btn = nodes[i]; break; }
        }
        if (!btn) return;
        window.__amAmbPatched = true;
        var tEl = btn.querySelector('div > div');
        if (tEl) tEl.textContent = '氛围模式';
        var hint = btn.querySelector('.set-hint');
        if (hint) hint.textContent = '全屏实时频谱 + 当前曲目完整信息（格式 / 位深 / 输出状态 / 后端 / 统计 / 进度），颜色跟随封面；可从顶栏格式胶囊、底部频谱条进入，快捷键 N';
        var b = btn.querySelector('button');
        if (b) b.textContent = '进入氛围模式';
        btn.addEventListener('click', function (ev) {
          if (ev.target && ev.target.tagName === 'BUTTON') {
            ev.preventDefault(); ev.stopPropagation();
            /* 先收起设置中心，再开面板，否则面板会被设置遮罩盖住 */
            try {
              if (window.annieSettings && window.annieSettings.togglePanel) window.annieSettings.togglePanel();
              var closeBtn = document.querySelector('.set-close, .set-panel .set-x, .set-panel [title="关闭"]');
              if (closeBtn) closeBtn.click();
            } catch (e12) { }
            setTimeout(function () { openImmInfoFromAnywhere(); }, 280);
          }
        }, true);
      } catch (e10) { }
    })();

    /* 设置中心：给「信息面板」补说明文字，并把它排到「信息面板电平条」上面 */
    (function () {
      try {
        if (window.__amStFix) return;
        var rows = [].slice.call(document.querySelectorAll('.set-row'));
        if (!rows.length) return;
        var infoRow = null, lrRow = null;
        for (var ri = 0; ri < rows.length; ri++) {
          var row = rows[ri];
          if (!row.querySelector('button, select')) continue;   // 只要带控件的设置行，别碰说明页的纯文字块
          var txt = (row.textContent || '').replace(/\s+/g, '');
          if (txt.indexOf('电平条') >= 0 && txt.indexOf('L/R') >= 0) { lrRow = row; continue; }
          if (txt.indexOf('氛围模式') >= 0) infoRow = row;
        }
        if (infoRow) {
          var lab = infoRow.querySelector('div');
          var hint = infoRow.querySelector('.set-hint');
          if (!hint && lab) {
            hint = document.createElement('div');
            hint.className = 'set-hint';
            lab.appendChild(hint);
          }
          if (hint) hint.textContent = '全屏实时频谱 + 当前曲目完整信息（格式 / 位深 / 输出状态 / 后端 / 统计 / 进度），颜色跟随封面；可从顶栏格式胶囊、底部频谱条进入，快捷键 N';
        }
        if (lrRow) {
          var lrLab0 = lrRow.querySelector('div > div');
          if (lrLab0) lrLab0.textContent = '氛围模式电平条';
          var lrHint = lrRow.querySelector('.set-hint');
          if (lrHint) lrHint.textContent = '氛围模式里那两条 L / R 电平指示，颜色跟随封面';
        }
        if (infoRow && lrRow && infoRow.parentNode === lrRow.parentNode) {
          lrRow.parentNode.insertBefore(infoRow, lrRow);          // 氛围模式 先
          lrRow.parentNode.insertBefore(lrRow, infoRow.nextSibling); // 电平条紧随其后
        }
        window.__amStFix = true;
      } catch (e11) { }
    })();

    /* 使用说明页：把旧的氛围模式文案换成现在的实际行为（名字仍叫氛围模式）。
       标题「氛围模式」和描述是两个节点，所以这里只按描述原文匹配；
       设置页是懒建的、切页时还可能重建，所以只要面板开着且还含旧串就再写一遍。 */
    (function () {
      try {
        var sp = document.querySelector('#settings-panel');
        if (!sp || !sp.classList.contains('open')) return;
        if ((sp.textContent || '').indexOf('Ctrl+Shift+V') < 0) return;
        var OLD_DESC = '全屏实时频谱 + 当前曲目信息（跟随强调色）；AM 点底部频谱条 / Ctrl+Shift+V / 设置中心进入；ESC 或单击退出';
        var NEW_DESC = '全屏实时频谱 + 当前曲目完整信息（格式 / 位深 / 输出状态 / 后端 / 统计 / 进度，颜色跟随封面）；顶栏格式胶囊 / 底部频谱条 / 快捷键 N / 设置中心进入；ESC 或单击空白处退出';
        var KNOWN = [
          [OLD_DESC, NEW_DESC],
          ['Ctrl+Shift+V 氛围模式 / ', ''],
          ['/ Ctrl+Shift+V 氛围模式', ''],
          ['氛围模式入口', '氛围模式（信息面板）']
        ];
        var walker = document.createTreeWalker(sp, NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = walker.nextNode())) {
          var v = n.nodeValue;
          if (!v || (v.indexOf('氛围模式') < 0 && v.indexOf('Ctrl+Shift+V') < 0)) continue;
          var out = v;
          for (var ki = 0; ki < KNOWN.length; ki++) {
            if (out.indexOf(KNOWN[ki][0]) >= 0) out = out.split(KNOWN[ki][0]).join(KNOWN[ki][1]);
          }
          if (out !== v) n.nodeValue = out;
        }
      } catch (e12b) { }
    })();

    if (R.immBtnInfo && !R.immBtnInfo._amInfoRebind) {
      R.immBtnInfo._amInfoRebind = true;
      R.immBtnInfo.onclick = function (e) { e.stopPropagation(); openImmInfoFromAnywhere(); };
    }
  }, 250);

  setInterval(bindFmtBadge, 1200);
  if (document.readyState !== 'loading') setTimeout(bindFmtBadge, 300);

  document.addEventListener('click', function (e) {
    var n = e.target;
    for (var i = 0; n && n !== document.body && i < 6; i++, n = n.parentElement) {
      var c = (typeof n.className === 'string') ? n.className : '';
      var txt = (n.textContent || '').trim();
      if (/(fmt|badge)/i.test(c) && /(kHz|bit|FLAC|MP3|WAV|DSD|M4A)/i.test(txt) && txt.length < 40) {
        e.preventDefault(); e.stopPropagation();   // 别让胶囊自己的点击逻辑把面板又关掉
        openImmInfoFromAnywhere();
        return;
      }
    }
  }, true);

  function infoVizFrame() {
    if (!_infoOn || !R.infoViz) { _infoRaf = 0; return; }
    _infoRaf = requestAnimationFrame(infoVizFrame);
    if (R.infoLR) {
      if (!_lrPeak) { _lrPeak = new Float32Array(32); for (var p0 = 0; p0 < 32; p0++) _lrPeak[p0] = 0.02; }
      var ls = 0, rs = 0, q0;
      for (q0 = 0; q0 < 32; q0++) {
        var bv = vizBands[q0] || 0;
        if (bv > _lrPeak[q0]) _lrPeak[q0] = bv; else _lrPeak[q0] *= 0.9985; // 缓慢回落
        var nv = Math.min(1, bv / Math.max(0.02, _lrPeak[q0]));
        if (q0 < 16) ls += nv; else rs += nv;
      }
      /* 颜色跟封面调色板（与频谱同源） */
      var palNow = (typeof vizPal !== 'undefined' && vizPal) || null;
      var cA = (palNow && palNow.primary) || (typeof vizAccA !== 'undefined' && vizAccA) || '';
      var cB = (palNow && palNow.accent) || (typeof vizAccB !== 'undefined' && vizAccB) || '';
      if (cA) {
        var grad2 = 'linear-gradient(90deg, ' + cA + ', ' + (cB || cA) + ')';
        if (R.infoLR.grad !== grad2) {
          R.infoLR.grad = grad2;
          R.infoLR.l.style.background = grad2;
          R.infoLR.r.style.background = grad2;
        }
      }
      R.infoLR.l.style.width = Math.round((ls / 16) * 100) + '%';
      R.infoLR.r.style.width = Math.round((rs / 16) * 100) + '%';
    }
    if (_infoPassKey !== infoKeyNow()) refreshImmInfo(); // 切歌/格式到达即时换内容
    var cv = R.infoViz, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== w * 2) { cv.width = w * 2; cv.height = h * 2; } // 2x 高清，与主频谱条一致
    if (!_infoSmooth) _infoSmooth = new Float32Array(32);
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    var heat = vizMode === 'heat';
    if (!heat) { // 配色与主界面 vizLoop 同源（accent / cover / coverMulti / rainbow）
      var grad = ctx.createLinearGradient(0, 0, cv.width, 0), pal = vizPal, i0;
      if (vizMode === 'rainbow') {
        var hues = [265, 230, 200, 160, 110, 55, 15];
        for (i0 = 0; i0 < hues.length; i0++) grad.addColorStop(i0 / (hues.length - 1), 'hsl(' + hues[i0] + ',85%,58%)');
      } else if (vizMode === 'coverMulti' && pal && pal.stops && pal.stops.length >= 2) {
        for (i0 = 0; i0 < pal.stops.length; i0++) grad.addColorStop(i0 / (pal.stops.length - 1), pal.stops[i0]);
      } else if (pal && pal.primary) {
        grad.addColorStop(0, pal.primary); grad.addColorStop(1, pal.accent);
      } else {
        grad.addColorStop(0, vizAccA || '#fa2d55'); grad.addColorStop(1, vizAccB || '#ff5c7a');
      }
      ctx.fillStyle = grad;
    }
    var n = 32, bw = cv.width / n;
    /* 轻微自动增益：低频永远最强，直接按原始幅度画的话右半屏几乎看不见，
       整条频谱会显得「只有左边一段」。按每帧最大值平滑归一化，让整条都活起来。 */
    var qmax = 0;
    for (var b0 = 0; b0 < n; b0++) if (_infoSmooth[b0] > qmax) qmax = _infoSmooth[b0];
    var gTarget = qmax > 0.08 ? Math.min(3.2, 0.85 / qmax) : 1;
    _infoGain += (gTarget - _infoGain) * 0.12;
    for (var i = 0; i < n; i++) {
      /* V4.4.8：与主界面同一套低频去同步（连续相同 band → 爬升） */
      var rb = vizBands[i] || 0;
      var rs2 = i, re2 = i;
      while (rs2 > 0 && Math.abs((vizBands[rs2 - 1] || 0) - rb) < 0.0005) rs2--;
      while (re2 < n - 1 && Math.abs((vizBands[re2 + 1] || 0) - rb) < 0.0005) re2++;
      var rlen2 = re2 - rs2 + 1;
      if (rlen2 > 1) {
        var st2 = (i - rs2) / (rlen2 - 1);
        var ph2 = (performance.now() / 2600) % 1;
        st2 = (st2 * 0.7 + ph2 * 0.3) % 1;
        rb = rb * (0.50 + 0.50 * st2);
        rb = Math.min(1, rb * (1 + 0.10 * Math.sin(performance.now() / 190 + i * 2.1)));
      }
      var kI = rb > _infoSmooth[i] ? (0.28 + ((i * 17) % 5) * 0.07) : (0.13 + ((i * 29) % 6) * 0.03);
      var v = _infoSmooth[i] += (rb - _infoSmooth[i]) * kI; // 帧间插值
      var vs = Math.min(1, v * _infoGain);
      var bh = Math.max(2, vs * (cv.height - 6));
      if (heat) ctx.fillStyle = vizHeatColor(vs);
      ctx.globalAlpha = 0.4 + vs * 0.6;
      ctx.fillRect(i * bw + 1, cv.height - bh, bw - 2, bh);
    }
    ctx.globalAlpha = 1;
  }
  function immInfoOutside(e) {
    if (!_infoOn || Date.now() - _infoAt < 60) return; // 忽略「打开面板的那一次点击」
    var t = e.target;
    if (R.immInfoBar && R.immInfoBar.contains(t)) return;
    // V4.4.8：面板内层铺满整屏，点它的空白区域也应算「外面」——只有点真正的文字/图表块才不关
    if (R.immInfo) {
      var inner = R.immInfo.querySelector('.am-imm-info-inner');
      if (inner && t !== inner && inner.contains(t)) return;
      if (inner && t === inner) { setImmInfo(false); return; }
      if (!R.immInfo.contains(t)) { /* 面板外的任意位置 → 关闭 */ }
    }
    /* 沉浸层右上角那排按钮浮在面板之上：真全屏 / 最小化 / 退出沉浸 不关面板，
       歌词外观（⚙）要关面板（它会在面板上叠一层设置弹层） */
    var cbBtn = (t && t.closest) ? t.closest('.am-imm-closebar .am-tbtn') : null;
    if (cbBtn && !/歌词外观/.test(cbBtn.title || '')) return;
    setImmInfo(false);
  }
  function immInfoKey(e) {
    if (!_infoOn || e.key !== 'Escape') return;
    /* 设置中心开着时 Esc 归它（关最上层）；设置关掉后氛围面板还在 */
    if (document.querySelector('#settings-panel.open')) return;
    e.stopPropagation();
    setImmInfo(false);
  }
  /* V4.4.8：监听器的挂/摘改成幂等同步——原先 setImmInfo 早退时会把监听器摘掉就不再挂回，
     表现为「面板开着但点哪都关不掉」 */
  function syncImmInfoListeners(on) {
    document.removeEventListener('mousedown', immInfoOutside, true);
    document.removeEventListener('keydown', immInfoKey, true);
    if (on) {
      document.addEventListener('mousedown', immInfoOutside, true);
      document.addEventListener('keydown', immInfoKey, true);
    }
  }
  function setImmInfo(on) {
    on = !!on;
    if (on === _infoOn) { syncImmInfoListeners(on); return; }
    _infoOn = on;
    _infoAt = Date.now();
    if (R.immInfo) R.immInfo.classList.toggle('on', on);
    if (R.immBtnInfo) {
      R.immBtnInfo.classList.toggle('on', on); // chevron 翻向由 CSS 负责（.on 时转 180°）
      R.immBtnInfo.title = on ? '收起歌曲信息' : '歌曲信息（下拉面板）';
    }
    cancelAnimationFrame(_infoRaf); _infoRaf = 0;
    syncImmInfoListeners(on);
    if (on) {
      refreshImmInfo();
      infoVizFrame();
    } else if (_infoSmooth) _infoSmooth.fill(0);
    immShowChrome(); // 展开/收起都退出「静止隐藏」态，左上角按钮始终可见
  }
  function buildImmInfo(ov) {
    /* 左上角「⌄」：与右上角 ⛶ 全屏 / − 最小化 同排同风格。
       图标用 SVG 画（不用字形、也不用 CSS 边框旋转）——这样两条臂严格等长，
       且顶点是真正的钝角；展开时整枚图标转 180°。 */
    var bar = el('div', 'am-imm-infobar');
    R.immBtnInfo = el('button', 'am-tbtn', '');
    var chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('class', 'am-imm-chev');
    chev.setAttribute('viewBox', '0 0 16 10');
    chev.setAttribute('width', '13');
    chev.setAttribute('height', '8');
    chev.setAttribute('aria-hidden', 'true');
    var chevP = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    chevP.setAttribute('d', 'M2 2 L8 8 L14 2');
    chevP.setAttribute('fill', 'none');
    chevP.setAttribute('stroke', 'currentColor');
    chevP.setAttribute('stroke-width', '1.7');
    chevP.setAttribute('stroke-linecap', 'round');
    chevP.setAttribute('stroke-linejoin', 'round');
    chev.appendChild(chevP);
    R.immBtnInfo.appendChild(chev);
    R.immBtnInfo.title = '歌曲信息（下拉面板）';
    R.immBtnInfo.onclick = function (e) { e.stopPropagation(); setImmInfo(!_infoOn); };
    bar.appendChild(R.immBtnInfo);
    ov.appendChild(bar);
    R.immInfoBar = bar;
    var panel = el('div', 'am-imm-info');
    var inner = el('div', 'am-imm-info-inner');
    var head = el('div', 'am-imm-info-head');
    R.infoTitle = el('div', 'am-imm-info-title', '未在播放');
    R.infoSub = el('div', 'am-imm-info-sub', '');
    head.appendChild(R.infoTitle); head.appendChild(R.infoSub);
    inner.appendChild(head);
    var grid = el('div', 'am-imm-info-grid');
    R.infoVal = {};
    for (var i = 0; i < IMM_INFO_ROWS.length; i++) {
      var key = IMM_INFO_ROWS[i][1];
      var k = el('span', 'am-imm-info-k', IMM_INFO_ROWS[i][0]);
      var v = el('span', 'am-imm-info-v', '');
      v._k = k;
      if (key === 'path') v.classList.add('am-imm-info-path');
      k.style.display = 'none'; v.style.display = 'none';
      grid.appendChild(k); grid.appendChild(v);
      R.infoVal[key] = v;
    }
    inner.appendChild(grid);
    /* V4.4.7：L/R 电平条（挂在频谱上方）。没有真正的左右声道数据，
       所以对每个频段做「各自的历史峰值归一化」再取前后半段平均——
       这样低频不会永久压死右边，两条会跟着音乐一起跳。 */
    var lrWrap = el('div', 'am-imm-info-lr');
    function lrRow(label) {
      var row = el('div', 'am-imm-info-lr-row');
      var lab = el('span', 'am-imm-info-lr-lab', label);
      var track = el('div', 'am-imm-info-lr-track');
      var fill = el('i', 'am-imm-info-lr-fill');
      track.appendChild(fill);
      row.appendChild(lab); row.appendChild(track);
      lrWrap.appendChild(row);
      return fill;
    }
    R.infoLR = { l: lrRow('L'), r: lrRow('R') };
    inner.appendChild(lrWrap);
    R.infoViz = document.createElement('canvas');
    R.infoViz.className = 'am-imm-info-viz';
    inner.appendChild(R.infoViz);
    panel.appendChild(inner);
    ov.appendChild(panel);
    R.immInfo = panel;
    R.immOv = ov;   /* 记住沉浸层容器，面板被搬到独立遮罩后能搬回来 */
    /* 沉浸层重建时，独立遮罩里可能还留着上一套面板节点：清掉，只保留当前这套 */
    try {
      if (R.infoOv) {
        var stale = R.infoOv.querySelectorAll('.am-imm-info');
        for (var si = 0; si < stale.length; si++) {
          if (stale[si] !== R.immInfo) stale[si].parentNode.removeChild(stale[si]);
        }
      }
    } catch (e19) { }
    /* 重建（切换经典/彩胶样式）时把状态与监听一并归零，避免残留展开态 */
    document.removeEventListener('mousedown', immInfoOutside, true);
    document.removeEventListener('keydown', immInfoKey, true);
    cancelAnimationFrame(_infoRaf); _infoRaf = 0;
    _infoOn = false; _infoPassKey = '';
    panel.classList.remove('on');
  }
  function buildImmersive() {
    if (R.imm) return;
    var vinyl = immMode() === 'vinyl';
    var root = document.getElementById('am-root');
    var ov = el('div', vinyl ? 'am-imm am-imm-vinyl' : 'am-imm');
    ov.appendChild(el('div', 'am-imm-bg'));
    var cb = el('div', 'am-imm-closebar');
    // V4.4：沉浸模式歌词外观入口（与主面板 ⚙ 同一弹层，锚点换成这里）
    R.immBtnLyrSet = el('button', 'am-tbtn', '⚙');
    R.immBtnLyrSet.title = '歌词外观（字号 / 行距 / 偏移）';
    R.immBtnLyrSet.onclick = function (e) {
      e.stopPropagation();
      if (AM.toggleLyrSetPop) AM.toggleLyrSetPop(R.immBtnLyrSet);
    };
    cb.appendChild(R.immBtnLyrSet);
    // V4.4：彩胶模式专属——💿 彩胶外观弹层（封面大小/盘体大小/透明度/位置/纹路摇号）
    if (vinyl) {
      R.immBtnVinyl = el('button', 'am-tbtn', '💿');
      R.immBtnVinyl.title = '彩胶外观（封面大小 / 盘体大小 / 透明度 / 位置 / 纹路）';
      R.immBtnVinyl.onclick = function (e) { e.stopPropagation(); openVinylSetPop(R.immBtnVinyl); };
      cb.insertBefore(R.immBtnVinyl, R.immBtnLyrSet);
    } else R.immBtnVinyl = null;
    // V4.4.8：退出沉浸按钮改用 SVG 叉形（与顶栏关闭键同款，不用字形）
    function _immWinIcon(d) {
      var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 16 16');
      s.setAttribute('width', '16'); s.setAttribute('height', '16');
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d); p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.6');
      p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
      s.appendChild(p); return s;
    }
    var bExit = el('button', 'am-tbtn', '');
    bExit.appendChild(_immWinIcon('M4.2 4.2 L11.8 11.8 M11.8 4.2 L4.2 11.8'));
    bExit.title = '退出沉浸模式';
    bExit.onclick = function () { toggleImmersive(false); };
    cb.appendChild(bExit);
    /* V4.4.7（秋野奈 PR#4）：沉浸界面直接切换真全屏（与「设置 → AM 界面」同源，持久化） */
    R.immBtnFs = el('button', 'am-tbtn', '⛶');
    R.immBtnFs.title = '真全屏（隐藏任务栏）';
    R.immBtnFs.onclick = function (e) {
      e.stopPropagation();
      /* V4.5：全屏状态统一用 window.__immFs（按钮/Esc/进沉浸自动全屏共用同一状态源），
         避免「窗口已全屏但按钮状态没跟上」第一次点击无效。按钮=显式改偏好，持久化到设置 */
      var ui = window.annieSettings && annieSettings.ui;
      var on = !window.__immFs;
      window.__immFs = on;
      if (ui) ui.amImmFullscreen = on;
      try { window.annieSettings.save(); } catch (x) { }
      try { if (window.mine && window.mine.winFullScreen) window.mine.winFullScreen(on); } catch (x) { }
      R.immBtnFs.classList.toggle('on', on);
      R.immBtnFs.title = on ? '退出真全屏（显示任务栏）' : '真全屏（隐藏任务栏）';
    };
    window.__immFs = false;   // 构建按钮栏时复位；进沉浸若自动全屏会在 toggleImmersive 里再置 true
    R.immBtnFs.classList.remove('on');
    cb.insertBefore(R.immBtnFs, bExit);
    /* V4.4.7（秋野奈 PR#5）：沉浸界面最小化按钮（CSS 画横线图标，不用字形——em dash 太宽、U+2212 太窄） */
    R.immBtnMin = el('button', 'am-tbtn', '');
    R.immBtnMin.title = '最小化';
    R.immBtnMin.style.display = 'inline-flex';
    R.immBtnMin.style.alignItems = 'center';
    R.immBtnMin.style.justifyContent = 'center';
    var _minBar = document.createElement('span');
    _minBar.style.display = 'block';
    _minBar.style.width = '.78em';
    _minBar.style.height = '.1em';
    _minBar.style.borderRadius = '1px';
    _minBar.style.background = 'currentColor';
    R.immBtnMin.appendChild(_minBar);
    R.immBtnMin.onclick = function (e) { e.stopPropagation(); try { window.mine.winMin(); } catch (x) { } };
    cb.insertBefore(R.immBtnMin, bExit);
    /* V4.4.8：沉浸层直接最大化/还原（与顶栏窗口三键同源） */
    R.immBtnMax = el('button', 'am-tbtn', '');
    R.immBtnMax.title = '最大化';
    R.immBtnMax.style.display = 'inline-flex';
    R.immBtnMax.style.alignItems = 'center';
    R.immBtnMax.style.justifyContent = 'center';
    R.immBtnMax.appendChild(_immWinIcon('M3.6 3.6 H12.4 V12.4 H3.6 Z'));
    R.immBtnMax.onclick = function (e) { e.stopPropagation(); try { window.mine.winMax(); } catch (x) { } };
    cb.insertBefore(R.immBtnMax, bExit);
    ov.appendChild(cb);
    buildImmInfo(ov);            // V4.4.7：左上角 ↓ + 歌曲信息面板

    R.immCover = document.createElement('img');
    R.immCover.alt = ''; R.immCover.draggable = false;
    R.immTitle = el('div', 'am-imm-title');
    R.immSub = el('div', 'am-imm-sub');
    R.immFmt = el('div', 'am-imm-fmt');

    if (!vinyl) {
      var main = el('div', 'am-imm-main');
      var left = el('div', 'am-imm-left');
      R.immCover.className = 'am-imm-cover';
      left.appendChild(R.immCover); left.appendChild(R.immTitle);
      left.appendChild(R.immSub); left.appendChild(R.immFmt);
      left.appendChild(buildImmProg());
      left.appendChild(buildImmControls());
      main.appendChild(left);
      R.immLyrBox = el('div', 'am-imm-lyr');
      autoHideScrollbar(R.immLyrBox);
      main.appendChild(R.immLyrBox);
      ov.appendChild(main);
    } else {
      /* 彩胶布局：左 = 大标题 + 常驻大歌词；右 = 旋转彩胶（圆形封面标签）；底 = 全宽进度条 + 传输栏 */
      var vmain = el('div', 'am-imm-main am-imm-vmain');
      var vleft = el('div', 'am-imm-vleft');
      vleft.appendChild(R.immTitle); vleft.appendChild(R.immSub); vleft.appendChild(R.immFmt);
      R.immLyrBox = el('div', 'am-imm-lyr');
      autoHideScrollbar(R.immLyrBox);
      vleft.appendChild(R.immLyrBox);
      var vright = el('div', 'am-imm-vright');
      R.immVinyl = el('div', 'am-vinyl');
      var label = el('div', 'am-vinyl-label');
      R.immCover.className = 'am-vinyl-cover';
      label.appendChild(R.immCover);
      R.immVinyl.appendChild(label);
      vright.appendChild(R.immVinyl);
      vmain.appendChild(vleft); vmain.appendChild(vright);
      ov.appendChild(vmain);
      var vbar = el('div', 'am-imm-vbar');
      vbar.appendChild(buildImmProg());
      var vctl = buildImmControls();
      R.immBtnLyr.style.display = 'none'; // 彩胶模式歌词常驻，无收起需求
      vbar.appendChild(vctl);
      ov.appendChild(vbar);
      _crownOffset = 0; _crownDragBase = null; clearTimeout(_crownT); // 重建盘面清零表把状态
      _vinylAngle = 0; _vinylOmega = 0; _vinylSeek = null; // 重建盘面从静止起步
      applyVinylStyle(); // 应用自定义（封面占比/盘体大小/透明度/位置/转速）并铺随机纹路
      vinylStartSpin();  // rAF 惯性旋转（含暂停减速/恢复加速）
    }
    R.immQ = el('div', 'am-imm-queue');
    ov.appendChild(R.immQ);
    buildImmDock(ov);   // V4.4：底部热区悬浮控制 dock（静止隐藏 chrome 后唤出）
    R.immOsd = el('div', 'am-imm-osd'); // 中央状态提示（播放/暂停/音量）
    ov.appendChild(R.immOsd);
    root.appendChild(ov);
    R.imm = ov;
  // V4.4.8：R.imm 就位后再应用一次彩胶外观——首次构建时上面的 applyVinylStyle()
  // 里 R.imm 还是 null，位置/轴心孔等 class 会漏掉（表现为重启后设置是悬挂、实际居中）
  if (vinyl) applyVinylStyle();
  }
  /* ---------- V4.4：底部悬浮 dock（视频式：静止隐藏全部 chrome，鼠标探入屏幕底部热区唤出） ---------- */
  function buildImmDock(ov) {
    var zone = el('div', 'am-imm-dockzone');
    var dock = el('div', 'am-imm-dock');
    var prog = el('div', 'am-imm-prog');
    R.immDockCur = el('span', 'am-imm-time', '0:00');
    var bar = el('div', 'am-imm-bar');
    R.immDockFill = el('div', 'am-imm-fill');
    bar.appendChild(R.immDockFill);
    bindProgDrag(bar, R.immDockFill, R.immDockCur, { onPreview: vinylCrownPreview, onSeek: vinylCrownSeek });
    R.immDockRemain = el('span', 'am-imm-time', '-0:00');
    prog.appendChild(R.immDockCur); prog.appendChild(bar); prog.appendChild(R.immDockRemain);
    var ctl = el('div', 'am-imm-ctl');
    var dP = el('button', 'am-imm-btn', '⏮');
    dP.onclick = function () { prev(); };
    R.immDockPlay = el('button', 'am-imm-btn am-imm-play', '▶');
    R.immDockPlay.onclick = function () { togglePlay(); };
    var dN = el('button', 'am-imm-btn', '⏭');
    dN.onclick = function () { next(); };
    ctl.appendChild(dP); ctl.appendChild(R.immDockPlay); ctl.appendChild(dN);
    dock.appendChild(prog); dock.appendChild(ctl);
    zone.appendChild(dock);
    ov.appendChild(zone);
    R.immDockZone = zone;
    // 热区容器本身 pointer-events:none（不挡歌词点击）；进出判定在 window mousemove 里按 clientY 处理
  }
  /* 彩胶取色：复用频谱条的封面调色板分析（主色=胶片刻纹基色，强调色=标签圈描边），黑白封面回落主题强调色 */
  var _vinylUrl = undefined;
  function paintVinyl(url) {
    if (!R.immVinyl) return;
    if (url === _vinylUrl) return;
    var first = _vinylUrl === undefined; // 进入沉浸/重建后的首次同步=当前曲，不做切歌转场
    _vinylUrl = url;
    if (!first) vinylSwitch(); // 切歌：盘体淡出再从静止启动
    if (!url || !window.amVizColor) {
      R.immVinyl.style.removeProperty('--vinyl-c1'); R.immVinyl.style.removeProperty('--vinyl-c2');
      return;
    }
    window.amVizColor.analyze(url, function (pal) {
      if (!R.immVinyl || url !== _vinylUrl) return; // 慢回调回来时已经切歌
      if (pal) {
        R.immVinyl.style.setProperty('--vinyl-c1', pal.primary);
        R.immVinyl.style.setProperty('--vinyl-c2', pal.accent);
      } else {
        R.immVinyl.style.removeProperty('--vinyl-c1'); R.immVinyl.style.removeProperty('--vinyl-c2');
      }
    });
  }
  /* ---------- 彩胶外观自定义（沉浸界面 💿 弹层；localStorage 持久化 + CSS 变量即时生效） ---------- */
  var VINYL_LS = {
    cover: 'annieplayer.am.vinyl.cover',  // 封面圆直径占盘体 %（50–90，胶圈宽度随之一增一减）
    scale: 'annieplayer.am.vinyl.scale',  // 盘体整体大小倍率（0.55–1.60）
    op: 'annieplayer.am.vinyl.op',        // 盘体不透明度（0.25–1，越低越透）
    pos: 'annieplayer.am.vinyl.pos',      // 唱片位置：center 居中 | corner 右上悬挂（QQ 音乐式，探出屏幕右上）
    hole: 'annieplayer.am.vinyl.hole',    // 轴心孔：'1' 开（默认）| '0' 关
    speed: 'annieplayer.am.vinyl.speed',  // 转速：秒/圈（4–60，默认 18）
    tex: 'annieplayer.am.vinyl.tex',      // 自定义盘面图（dataURL，智能裁切 640px JPEG；空=自动刻纹）
    texHist: 'annieplayer.am.vinyl.texHist' // 盘面图历史（JSON dataURL 数组，上限 8，点选切回）
  };
  function vinylLsNum(key, def) { try { var v = parseFloat(localStorage.getItem(key)); return isFinite(v) ? v : def; } catch (e) { return def; } }
  /* V4.4.2：彩胶外观双写持久化——localStorage 仍是渲染主源，同时防抖镜像进 library.json（store.vinylCfg），
   * 防 localStorage leveldb 被强杀丢写导致"重启后彩胶设置归零"；且随备份 2.0 设置段一起走，换机不丢。
   * 盘面图 tex/texHist（大 dataURL）不进 store，避免 library.json 膨胀。 */
  function vinylCfgSnapshot() {
    return {
      cover: vinylLsNum(VINYL_LS.cover, 73),
      scale: vinylLsNum(VINYL_LS.scale, 1),
      op: vinylLsNum(VINYL_LS.op, 1),
      speed: vinylLsNum(VINYL_LS.speed, 18),
      pos: (function () { try { return localStorage.getItem(VINYL_LS.pos) || 'center'; } catch (e) { return 'center'; } })(),
      hole: (function () { try { return localStorage.getItem(VINYL_LS.hole) === '0' ? '0' : '1'; } catch (e) { return '1'; } })()
    };
  }
  var _vinylCfgSaveT = 0;
  function persistVinylCfg() {
    // 先同步渲染层缓存快照（vinylSeedFromStore 读的是它），再防抖落盘
    try { if (window.state && state.library) state.library.vinylCfg = vinylCfgSnapshot(); } catch (e) { }
    clearTimeout(_vinylCfgSaveT);
    _vinylCfgSaveT = setTimeout(function () {
      try { if (window.mine && window.mine.saveSettings) window.mine.saveSettings({ vinylCfg: vinylCfgSnapshot() }); } catch (e) { }
    }, 800);
  }
  /* 启动种子：localStorage 缺的键从 store.vinylCfg 回填（只补缺失，不覆盖本机已有调整） */
  function vinylSeedFromStore() {
    try {
      var cfg = (window.state && state.library && state.library.vinylCfg) || null;
      if (!cfg || typeof cfg !== 'object') return;
      var map = { cover: VINYL_LS.cover, scale: VINYL_LS.scale, op: VINYL_LS.op, speed: VINYL_LS.speed, pos: VINYL_LS.pos, hole: VINYL_LS.hole };
      Object.keys(map).forEach(function (k) {
        if (cfg[k] == null) return;
        try { if (localStorage.getItem(map[k]) == null) localStorage.setItem(map[k], String(cfg[k])); } catch (e) { }
      });
    } catch (e) { }
  }
  /* 纹路随机化：缓存一组随机刻纹——宽度幂分布（细多粗少）、明暗纹随机混排
     （亮纹=封面色，暗纹=纯黑压纹，对比才看得出来）、12% 概率哑光圈（仿真唱片分轨间隙）；
     🎲 重新摇号。纹路从固定半径起铺（不再从封面边缘起——封面调大会把纹路整个挤出盘面） */
  var _vinylGrooves = null;
  function genVinylGrooves() {
    var gs = [], p = 0;
    while (p < 78) { // 覆盖 22%→100% 半径（纹路固定起点 22%，标签圈盖住的部分自然隐藏）
      var w = 0.2 + Math.pow(Math.random(), 1.4) * 1.9; // 0.2–2.1%，细纹多粗纹少
      // 负值=暗纹（纯黑压纹，alpha 取绝对值）；亮纹=封面色高浓度
      var a = Math.random() < 0.42 ? -(0.10 + Math.random() * 0.24) : (26 + Math.random() * 28);
      var gap = Math.random() < 0.12 ? 0.6 + Math.random() * 1.6 : 0;
      gs.push({ w: w, a: a, gap: gap });
      p += w + gap;
    }
    _vinylGrooves = gs;
  }
  var VINYL_SHEEN = 'conic-gradient(from 210deg, transparent 0deg, rgba(255,255,255,.18) 16deg, transparent 38deg, transparent 168deg, rgba(255,255,255,.10) 192deg, transparent 218deg)';
  var VINYL_GROOVE_START = 22; // 纹路固定起点（%半径，标签圈之下；封面大小只决定露多少，不再推走纹路）
  function vinylTex() { try { return localStorage.getItem(VINYL_LS.tex) || ''; } catch (e) { return ''; } }
  function vinylTexHist() {
    try { var a = JSON.parse(localStorage.getItem(VINYL_LS.texHist) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function saveTexHist(a) { try { localStorage.setItem(VINYL_LS.texHist, JSON.stringify(a.slice(0, 8))); } catch (e) { } }
  function pushTexHist(dataUrl) {
    var a = vinylTexHist().filter(function (u) { return u !== dataUrl; });
    a.unshift(dataUrl);
    saveTexHist(a);
  }
  /* 智能裁切：四角采样背景色 → 找内容包围盒（唱片照片自动去掉白/黑边），
     包围盒居中取方并内缩 2% 去毛边；识别失败回落中心方形裁切 */
  function smartCropSquare(img) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var fb = Math.min(w, h), out = { sx: (w - fb) / 2, sy: (h - fb) / 2, side: fb };
    try {
      var sc = Math.min(1, 360 / Math.max(w, h));
      var sw = Math.max(8, Math.round(w * sc)), sh = Math.max(8, Math.round(h * sc));
      var cv = document.createElement('canvas'); cv.width = sw; cv.height = sh;
      var cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, sw, sh);
      var d = cx.getImageData(0, 0, sw, sh).data;
      var cn = 0, br = 0, bg = 0, bb = 0;
      [[2, 2], [sw - 3, 2], [2, sh - 3], [sw - 3, sh - 3]].forEach(function (pt) {
        var i = (pt[1] * sw + pt[0]) * 4;
        if (d[i + 3] > 128) { br += d[i]; bg += d[i + 1]; bb += d[i + 2]; cn++; }
      });
      if (!cn) return out;
      br /= cn; bg /= cn; bb /= cn;
      var minX = sw, minY = sh, maxX = -1, maxY = -1;
      for (var y = 0; y < sh; y += 2) {
        for (var x = 0; x < sw; x += 2) {
          var j = (y * sw + x) * 4;
          if (d[j + 3] <= 128) continue; // 透明像素视为背景
          if (Math.abs(d[j] - br) > 42 || Math.abs(d[j + 1] - bg) > 42 || Math.abs(d[j + 2] - bb) > 42) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX > minX && maxY > minY) {
        var bw = maxX - minX, bh = maxY - minY;
        if (bw * bh < sw * sh * 0.9) { // 内容确实小于整图才启用（整图就是内容时保持原裁切）
          var cxp = (minX + maxX) / 2 / sc, cyp = (minY + maxY) / 2 / sc;
          var sd = Math.min(Math.max(bw, bh) / sc * 0.98, w, h); // 内缩 2% 去边缘毛边
          out.sx = Math.min(Math.max(cxp - sd / 2, 0), w - sd);
          out.sy = Math.min(Math.max(cyp - sd / 2, 0), h - sd);
          out.side = sd;
        }
      }
    } catch (e) { }
    return out;
  }
  /* 选盘面图（仿全局壁纸思路）：智能裁切 → 640px JPEG → localStorage 单槽 + 历史 8 张；
     圆形由盘体 border-radius 遮罩裁出，盘体旋转时图随盘转 */
  function pickVinylTexture(after) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f || !/^image\//.test(f.type)) return;
      var url = URL.createObjectURL(f);
      var img = new Image();
      img.onload = function () {
        try {
          var c = smartCropSquare(img);
          if (!(c.side > 0)) throw new Error('bad image');
          var cv = document.createElement('canvas');
          cv.width = cv.height = 640;
          cv.getContext('2d').drawImage(img, c.sx, c.sy, c.side, c.side, 0, 0, 640, 640);
          var dataUrl = cv.toDataURL('image/jpeg', 0.88);
          localStorage.setItem(VINYL_LS.tex, dataUrl);
          pushTexHist(dataUrl);
          paintVinylTexture();
          if (after) after();
          if (typeof proToast === 'function') proToast('盘面图片已应用');
        } catch (e) {
          if (typeof proToast === 'function') proToast('图片处理失败（过大或格式不支持）');
        }
        URL.revokeObjectURL(url);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        if (typeof proToast === 'function') proToast('图片读取失败');
      };
      img.src = url;
    };
    inp.click();
  }
  function paintVinylTexture() {
    if (!R.immVinyl) return;
    var tex = vinylTex();
    if (tex) {
      // 自定义盘面：图随盘转；叠磨砂压暗层（吃「盘体不透明」滑杆）+ 亚克力反光带，刻纹层让位
      var dimA = (1 - vinylLsNum(VINYL_LS.op, 1)) * 0.72;
      R.immVinyl.style.backgroundImage = VINYL_SHEEN
        + ', linear-gradient(rgba(10,10,16,' + dimA.toFixed(2) + '), rgba(10,10,16,' + dimA.toFixed(2) + '))'
        + ', url("' + tex + '")';
      R.immVinyl.style.backgroundSize = 'auto, auto, cover';
      R.immVinyl.style.backgroundPosition = 'center, center, center';
      R.immVinyl.style.backgroundColor = 'rgba(14,14,20,.55)';
      return;
    }
    R.immVinyl.style.backgroundSize = '';
    R.immVinyl.style.backgroundPosition = '';
    if (!_vinylGrooves) genVinylGrooves();
    var start = VINYL_GROOVE_START;
    var stops = ['transparent 0% ' + start.toFixed(2) + '%'];
    var p = start;
    for (var i = 0; i < _vinylGrooves.length && p < 100; i++) {
      var g = _vinylGrooves[i];
      var p2 = Math.min(100, p + g.w);
      var c = g.a >= 0
        ? 'color-mix(in srgb, var(--vc1) calc(' + g.a.toFixed(1) + '% * var(--am-vinyl-op, 1)), transparent)'
        : 'rgba(0,0,0, calc(' + (-g.a).toFixed(3) + ' * var(--am-vinyl-op, 1)))';
      stops.push(c + ' ' + p.toFixed(2) + '% ' + p2.toFixed(2) + '%');
      p = p2;
      if (g.gap) { var g2 = Math.min(100, p + g.gap); stops.push('transparent ' + p.toFixed(2) + '% ' + g2.toFixed(2) + '%'); p = g2; }
    }
    R.immVinyl.style.backgroundImage = VINYL_SHEEN + ', radial-gradient(circle, ' + stops.join(',') + ')';
    // 亚克力底：大幅减淡（不透明度滑杆仍有 0.25–1 全程可调）
    R.immVinyl.style.backgroundColor = 'color-mix(in srgb, var(--vc1) calc(9% * var(--am-vinyl-op, 1)), rgba(16,16,22, calc(.16 * var(--am-vinyl-op, 1))))';
  }
  function applyVinylStyle() {
    vinylSeedFromStore(); // V4.4.2：localStorage 丢写时从 store.vinylCfg 回填
    try {
      var rs = document.documentElement.style;
      rs.setProperty('--am-vinyl-cover', vinylLsNum(VINYL_LS.cover, 73) + '%');
      rs.setProperty('--am-vinyl-scale', String(vinylLsNum(VINYL_LS.scale, 1)));
      rs.setProperty('--am-vinyl-op', String(vinylLsNum(VINYL_LS.op, 1)));
      var speedSec = vinylLsNum(VINYL_LS.speed, 18);
      // V4.4：转速合法区间 4–60 秒/圈；旧版可能遗留越界值（如 198）导致盘体肉眼几乎不转，越界即回落默认并纠正存储
      if (!(speedSec >= 4 && speedSec <= 60)) {
        speedSec = 18;
        try { localStorage.setItem(VINYL_LS.speed, '18'); } catch (e2) { }
      }
      rs.setProperty('--am-vinyl-speed', String(speedSec));
      _vinylSpeedSec = speedSec; // rAF 惯性旋转读这个目标转速
    } catch (e) { }
    if (R.imm) {
      var corner = false, holeOff = false;
      try {
        corner = (localStorage.getItem(VINYL_LS.pos) || 'center') === 'corner';
        holeOff = localStorage.getItem(VINYL_LS.hole) === '0';
      } catch (e) { }
      R.imm.classList.toggle('am-pos-corner', corner);
      R.imm.classList.toggle('am-vinyl-nohole', holeOff);
      paintVinylTexture();
    }
  }
  function buildVinylSetPop() {
    var pop = el('div', 'am-pop am-lyrset-pop');
    pop.appendChild(el('div', 'am-pop-h', '彩胶外观'));
    var sliders = [];
    function sRow(label, key, min, max, step, def, fmt) {
      var row = el('div', 'am-pop-row');
      row.appendChild(el('span', null, label));
      var sl = document.createElement('input');
      sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step;
      sl.className = 'am-lyrset-slider';
      var v = el('span', 'am-lyrset-v', '');
      function sync() { sl.value = vinylLsNum(key, def); v.textContent = fmt(parseFloat(sl.value)); }
      sl._sync = sync;
      sl.oninput = function () {
        try { localStorage.setItem(key, String(sl.value)); } catch (e) { }
        v.textContent = fmt(parseFloat(sl.value));
        applyVinylStyle();
        persistVinylCfg(); // V4.4.2：镜像进 store，重启/换机不丢
      };
      sync(); sliders.push(sl);
      row.appendChild(sl); row.appendChild(v);
      pop.appendChild(row);
    }
    sRow('封面大小', VINYL_LS.cover, 50, 90, 1, 73, function (v) { return Math.round(v) + '%'; });
    sRow('盘体大小', VINYL_LS.scale, 0.55, 1.6, 0.01, 1, function (v) { return Math.round(v * 100) + '%'; });
    sRow('盘体不透明', VINYL_LS.op, 0.25, 1, 0.01, 1, function (v) { return Math.round(v * 100) + '%'; });
    sRow('转速', VINYL_LS.speed, 4, 60, 1, 18, function (v) { return Math.round(v) + '秒/圈'; });
    // 唱片位置（居中 / 右上悬挂）
    var prow = el('div', 'am-pop-row');
    prow.appendChild(el('span', null, '唱片位置'));
    var seg = el('div', 'am-vinylset-seg');
    var bC = el('button', 'am-vinylset-segbtn', '居中');
    var bR = el('button', 'am-vinylset-segbtn', '右上悬挂');
    function curPos() { try { return localStorage.getItem(VINYL_LS.pos) || 'center'; } catch (e) { return 'center'; } }
    function syncSeg() { var p = curPos(); bC.classList.toggle('on', p === 'center'); bR.classList.toggle('on', p !== 'center'); }
    bC.onclick = function () { try { localStorage.setItem(VINYL_LS.pos, 'center'); } catch (e) { } syncSeg(); applyVinylStyle(); persistVinylCfg(); };
    bR.onclick = function () { try { localStorage.setItem(VINYL_LS.pos, 'corner'); } catch (e) { } syncSeg(); applyVinylStyle(); persistVinylCfg(); };
    syncSeg();
    seg.appendChild(bC); seg.appendChild(bR);
    prow.appendChild(seg); pop.appendChild(prow);
    // 轴心孔开关
    var hrow = el('div', 'am-pop-row');
    hrow.appendChild(el('span', null, '轴心孔'));
    var hseg = el('div', 'am-vinylset-seg');
    var bHOn = el('button', 'am-vinylset-segbtn', '开');
    var bHOff = el('button', 'am-vinylset-segbtn', '关');
    function holeOffNow() { try { return localStorage.getItem(VINYL_LS.hole) === '0'; } catch (e) { return false; } }
    function syncHole() { var off = holeOffNow(); bHOn.classList.toggle('on', !off); bHOff.classList.toggle('on', off); }
    bHOn.onclick = function () { try { localStorage.setItem(VINYL_LS.hole, '1'); } catch (e) { } syncHole(); applyVinylStyle(); persistVinylCfg(); };
    bHOff.onclick = function () { try { localStorage.setItem(VINYL_LS.hole, '0'); } catch (e) { } syncHole(); applyVinylStyle(); persistVinylCfg(); };
    syncHole();
    hseg.appendChild(bHOn); hseg.appendChild(bHOff);
    hrow.appendChild(hseg); pop.appendChild(hrow);
    // 盘面图片（自定义盘体表面，替代自动刻纹；「盘体不透明」滑杆对其同样生效）
    var trow = el('div', 'am-pop-row');
    trow.appendChild(el('span', null, '盘面图片'));
    var tseg = el('div', 'am-vinylset-seg');
    var bPickTex = el('button', 'am-vinylset-segbtn', '选择图片…');
    var bClearTex = el('button', 'am-vinylset-segbtn', '清除');
    tseg.appendChild(bPickTex); tseg.appendChild(bClearTex);
    trow.appendChild(tseg); pop.appendChild(trow);
    var texHint = el('div', 'am-lyrset-v', '');
    texHint.style.margin = '-4px 2px 4px';
    pop.appendChild(texHint);
    var thumbs = el('div', 'am-vinylset-thumbs');
    pop.appendChild(thumbs);
    function syncTexRow() {
      var curTex = vinylTex();
      texHint.textContent = curTex ? '已应用自定义盘面（智能去边裁切，随盘旋转）' : '未设置：盘面为封面取色随机刻纹';
      bClearTex.style.opacity = curTex ? '1' : '.45';
      // 历史缩略图条：点按切回，hover × 删除（仿全局壁纸历史）
      thumbs.innerHTML = '';
      var hist = vinylTexHist();
      if (!hist.length) { thumbs.style.display = 'none'; return; }
      thumbs.style.display = '';
      hist.forEach(function (u) {
        var cell = el('div', 'am-vinylset-thumb' + (u === curTex ? ' on' : ''));
        var im = document.createElement('img');
        im.src = u; im.alt = ''; im.draggable = false;
        cell.appendChild(im);
        var bx = el('button', 'am-vinylset-thumb-x', '✕');
        bx.onclick = function (e) {
          e.stopPropagation();
          saveTexHist(vinylTexHist().filter(function (x) { return x !== u; }));
          if (vinylTex() === u) { try { localStorage.removeItem(VINYL_LS.tex); } catch (e2) { } paintVinylTexture(); }
          syncTexRow();
        };
        cell.appendChild(bx);
        cell.onclick = function () {
          try { localStorage.setItem(VINYL_LS.tex, u); } catch (e) { }
          pushTexHist(u); // 置顶
          paintVinylTexture(); syncTexRow();
        };
        thumbs.appendChild(cell);
      });
    }
    bPickTex.onclick = function () { pickVinylTexture(syncTexRow); };
    bClearTex.onclick = function () {
      try { localStorage.removeItem(VINYL_LS.tex); } catch (e) { }
      paintVinylTexture(); syncTexRow();
    };
    syncTexRow();
    pop._syncSegs = function () { syncSeg(); syncHole(); syncTexRow(); };
    // 纹路摇号 / 恢复默认
    var arow = el('div', 'am-pop-row');
    var aseg = el('div', 'am-vinylset-seg');
    var bDice = el('button', 'am-vinylset-segbtn', '🎲 换一组纹路');
    bDice.onclick = function () { genVinylGrooves(); paintVinylTexture(); };
    var bReset = el('button', 'am-vinylset-segbtn', '↺ 恢复默认');
    bReset.onclick = function () {
      try {
        localStorage.removeItem(VINYL_LS.cover); localStorage.removeItem(VINYL_LS.scale);
        localStorage.removeItem(VINYL_LS.op); localStorage.removeItem(VINYL_LS.pos);
        localStorage.removeItem(VINYL_LS.hole); localStorage.removeItem(VINYL_LS.speed);
        localStorage.removeItem(VINYL_LS.tex); localStorage.removeItem(VINYL_LS.texHist);
      } catch (e) { }
      sliders.forEach(function (sl) { sl._sync(); });
      syncSeg(); syncHole(); syncTexRow(); genVinylGrooves();
      persistVinylCfg(); // V4.4.2：先把默认值同步进缓存快照+镜像，再 apply（防种子把旧值回填）
      applyVinylStyle();
    };
    aseg.appendChild(bDice); aseg.appendChild(bReset);
    arow.appendChild(aseg); pop.appendChild(arow);
    document.getElementById('am-root').appendChild(pop);
    R.vinylSetPop = pop;
  }
  function openVinylSetPop(anchor) {
    if (!R.vinylSetPop) buildVinylSetPop();
    var pop = R.vinylSetPop;
    if (pop.classList.contains('on')) { pop.classList.remove('on'); return; }
    pop.querySelectorAll('input[type=range]').forEach(function (sl) { if (sl._sync) sl._sync(); });
    var r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, r.right - 260) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
    pop.classList.add('on');
  }
  /* 设置里切换沉浸样式：沉浸中立即重建布局（不退出沉浸，不打断播放） */
  /* V4.4.8：设置里切换取色权重后，立刻按新模式重算当前封面的颜色 */
  AM.refreshVizColor = function () {
    var root = document.getElementById('am-root');
    var src = R.npCover && R.npCover.getAttribute('src');
    if (!root || !src || !window.amVizColor) return;
    window.amVizColor.analyze(src, function (pal) {
      if (!pal) {
        root.style.removeProperty('--am-cover-c1');
        root.style.removeProperty('--am-cover-c2');
            root.style.removeProperty('--am-cover-vivid');
        return;
      }
      root.style.setProperty('--am-cover-c1', pal.primary);
      root.style.setProperty('--am-cover-c2', pal.accent);
              root.style.setProperty('--am-cover-vivid', pal.vivid || pal.primary);
    });
  };
  AM.refreshImmMode = function () {
    if (!R.imm) return;
    var wasVinyl = R.imm.classList.contains('am-imm-vinyl');
    saveImmLayout(wasVinyl); // 重建前先存旧样式（immMode() 此刻已是新值）
    vinylStopSpin();         // 旧盘 rAF 循环停掉（buildImmersive 内会按新样式重启）
    R.imm.remove(); R.imm = null; R.immVinyl = null; _vinylUrl = undefined;
    buildImmersive();
    var root = document.getElementById('am-root');
    root.classList.toggle('am-imm-lyr-on', S.imm && !!S.immLyrOn);
    root.classList.toggle('am-imm-q-on', S.imm && !!S.immQOn);
    if (S.imm) {
      syncAuxViews(); refreshAuxProgress();
      if (S.immLyrOn || immMode() === 'vinyl') buildLyrInto(R.immLyrBox);
      if (S.immQOn) renderQueuePanel(R.immQ);
      restoreImmLayout(immMode() === 'vinyl');
    }
  };
  /* ================= 沉浸模式：静止自动隐藏鼠标+chrome（视频式体验） =================
   * 静止 2.5s：隐藏鼠标、顶栏、底部控制栏（经典内联 prog/ctl、彩胶 vbar）；
   * 静止后把鼠标探入屏幕底部热区 → 悬浮 dock 淡入（含进度条+三键，可拖拽/点击）；
   * 在非热区移动鼠标/按键/滚轮 → 完整 chrome 立即回来并重新计时。 */
  var IMM_CURSOR_IDLE_MS = 2500, IMM_DOCK_ZONE_PX = 104, IMM_DOCK_LEAVE_MS = 450;
  var immCursorTimer = 0, immDockLeaveT = 0;
  function immRoot() { return document.getElementById('am-root'); }
  function immChromeOff() {
    var root = immRoot();
    return !!(root && root.classList.contains('am-imm-chrome-off'));
  }
  function immPopOpen() {
    // 弹层/右键菜单开着时不藏 chrome（💿 彩胶外观、歌词外观等正在交互）
    return !!document.querySelector('#am-root .am-pop.on');   // V4.4.8：信息面板不再阻止静止隐藏 // 信息面板展开时不藏 chrome
  }
  /* 静默隐藏 chrome 后，进度条+控制栏虽然在视觉上消失但仍占布局位，左列可见部分会偏上。
     这里量出被隐藏那一段（含前后 gap）的一半高度，供 CSS 把整列下移；恢复时回位。 */
  var _immShiftT = 0;
  function syncImmLyrShift() {
    try {
      var root = document.getElementById('am-root');
      var left = root && R.imm ? R.imm.querySelector('.am-imm-left') : null;
      if (!left) return;
      var prog = left.querySelector('.am-imm-prog');
      var ctl = left.querySelector('.am-imm-ctl');
      if (!prog || !ctl) return;
      var cs = getComputedStyle(left);
      var gap = parseFloat(cs.rowGap || cs.gap) || 12;
      var h = prog.offsetHeight + ctl.offsetHeight + gap * 2;
      if (h > 0) root.style.setProperty('--am-imm-hide-shift', Math.round(h) + 'px');
    } catch (e) { }
  }
  window.addEventListener('resize', function () {
    clearTimeout(_immShiftT);
    _immShiftT = setTimeout(syncImmLyrShift, 200);
  }, { passive: true });
  function immGoIdle() {
    var root = immRoot();
    if (!root || !S.imm || immPopOpen() || S.immQOn) return; // 弹层/待播面板交互中不藏
    syncImmLyrShift();
    root.classList.add('am-imm-chrome-off', 'am-imm-cursor-off');
    root.classList.remove('am-imm-dock-on');
  }
  function immShowChrome() {
    var root = immRoot();
    if (!root) return;
    root.classList.remove('am-imm-chrome-off', 'am-imm-cursor-off', 'am-imm-dock-on');
    clearTimeout(immCursorTimer);
    immCursorTimer = setTimeout(immGoIdle, IMM_CURSOR_IDLE_MS);
  }
  function immDockEnter() {
    if (!S.imm) return;
    clearTimeout(immDockLeaveT);
    clearTimeout(immCursorTimer); // dock 交互期间静止计时暂停
    var root = immRoot();
    // 只有静止隐藏后探入热区才唤出 dock；chrome 已显示时（内联/vbar 可见）不重复弹
    if (root && root.classList.contains('am-imm-chrome-off')) {
      root.classList.add('am-imm-dock-on');
      root.classList.remove('am-imm-cursor-off');
    }
  }
  function immDockLeave() {
    if (!S.imm) return;
    clearTimeout(immDockLeaveT);
    immDockLeaveT = setTimeout(function () {
      var root = immRoot();
      if (!root || !S.imm) return;
      root.classList.remove('am-imm-dock-on');
      clearTimeout(immCursorTimer);
      immCursorTimer = setTimeout(immGoIdle, 600);
    }, IMM_DOCK_LEAVE_MS);
  }
  function immOnCursorActivity(e) {
    if (!S.imm) return;
    if (state.seeking) return; // 拖进度条期间不切换 chrome/dock（防止手拖出热区打断拖拽）
    var inZone = e && (e.type === 'mousemove' || e.type === 'mousedown') &&
      e.clientY != null && e.clientY >= window.innerHeight - IMM_DOCK_ZONE_PX;
    var root = immRoot();
    // 静止隐藏后探入热区，或已在 dock 中且仍在热区 → 维持 dock，不恢复其余 chrome
    if (inZone && root && (root.classList.contains('am-imm-chrome-off') || root.classList.contains('am-imm-dock-on'))) {
      immDockEnter();
      return;
    }
    immShowChrome();
  }
  var IMM_CURSOR_EVENTS = ['mousemove', 'mousedown', 'wheel', 'touchstart', 'keydown'];
  function immWinLeave() { immDockLeave(); } // 鼠标移出窗口：dock 延迟收起，进入静止
  function immStartCursorWatch() {
    clearTimeout(immCursorTimer);
    IMM_CURSOR_EVENTS.forEach(function (ev) {
      window.addEventListener(ev, immOnCursorActivity, { passive: true });
    });
    document.documentElement.addEventListener('mouseleave', immWinLeave);
    immShowChrome();
  }
  function immStopCursorWatch() {
    clearTimeout(immCursorTimer);
    clearTimeout(immDockLeaveT);
    IMM_CURSOR_EVENTS.forEach(function (ev) {
      window.removeEventListener(ev, immOnCursorActivity);
    });
    document.documentElement.removeEventListener('mouseleave', immWinLeave);
    var root = immRoot();
    if (root) root.classList.remove('am-imm-chrome-off', 'am-imm-cursor-off', 'am-imm-dock-on');
  }
  /* ---------- V4.4：沉浸中央 OSD（播放/暂停、音量百分比，1.2s 后淡出） ---------- */
  var _immOsdT = 0;
  function showImmOsd(html) {
    if (!R.immOsd) return;
    R.immOsd.innerHTML = html;
    R.immOsd.classList.remove('am-imm-osd-out');
    void R.immOsd.offsetWidth;
    R.immOsd.classList.add('am-imm-osd-in');
    clearTimeout(_immOsdT);
    _immOsdT = setTimeout(function () {
      R.immOsd.classList.remove('am-imm-osd-in');
      R.immOsd.classList.add('am-imm-osd-out');
    }, 1100);
  }
  var _immLastPlaying = null, _immLastVol = null;
  function immOsdTick() {
    if (!S.imm) { _immLastPlaying = null; _immLastVol = null; return; }
    if (_immLastPlaying !== null && state.playing !== _immLastPlaying) {
      showImmOsd('<span class="am-imm-osd-ic">' + (state.playing ? '⏸' : '▶') + '</span>');
    }
    _immLastPlaying = state.playing;
    var vol = R.vol ? +R.vol.value : null;
    if (vol != null && _immLastVol !== null && vol !== _immLastVol) {
      var ic = vol === 0 ? '🔇' : (vol < 50 ? '🔈' : '🔊');
      showImmOsd('<span class="am-imm-osd-ic">' + ic + '</span><span class="am-imm-osd-vol">' + vol + '%</span>');
    }
    _immLastVol = vol;
  }
  /* ---------- V4.4：沉浸布局记忆（经典/彩胶各自记忆面板展开 + 歌词滚动比例） ---------- */
  function immLayoutKey(vinyl) { return 'annieplayer.imm.layout.' + (vinyl ? 'vinyl' : 'classic'); }
  function saveImmLayout(vinylForce) {
    if (!R.imm) return;
    var vinyl = vinylForce != null ? vinylForce : (immMode() === 'vinyl');
    var box = R.immLyrBox;
    var ratio = 0;
    if (box && box.scrollHeight > box.clientHeight) ratio = box.scrollTop / (box.scrollHeight - box.clientHeight);
    try {
      localStorage.setItem(immLayoutKey(vinyl), JSON.stringify({
        lyr: vinyl ? true : !!S.immLyrOn, // 彩胶歌词常驻恒为开
        q: !!S.immQOn,
        sr: +ratio.toFixed(4),
      cur: S.lyrCur,   // V4.4.8：记住当时的当前行，换行后不再套用旧位置
        v: 1
      }));
    } catch (e) { }
  }
  function restoreImmLayout(vinyl) {
    var cfg = null;
    try { cfg = JSON.parse(localStorage.getItem(immLayoutKey(vinyl)) || 'null'); } catch (e) { }
    if (!cfg) { if (vinyl) setImmLyr(true); return; } // 彩胶首次进入：歌词常驻
    // 有存档时严格同步（避免经典→彩胶→经典后 S.immLyrOn 被彩胶置 true 残留）
    setImmLyr(vinyl ? true : !!cfg.lyr);
    setImmQueue(!!cfg.q);
    if (R.immLyrBox) {
      // V4.4.8：进度与当前行不同（切歌/播放推进）就回到当前行；同一行内才恢复手动滚动位置
      var _sameLine = (cfg.cur === S.lyrCur), _nearBottom = cfg.sr >= 0.985;
      requestAnimationFrame(function () {
        if (!R.immLyrBox) return;
        if (_sameLine && !_nearBottom) {
          var v = cfg.sr * Math.max(0, R.immLyrBox.scrollHeight - R.immLyrBox.clientHeight);
          (AM.progScrollTop || function (b, x) { b.scrollTop = x; })(R.immLyrBox, v);
          return;
        }
        var nl = R.immLyrBox.querySelector('.am-lyr-line.cur');
        if (nl) (AM.progScrollTop || function (b, x) { b.scrollTop = x; })(R.immLyrBox, nl.offsetTop - R.immLyrBox.clientHeight * 0.35);
      });
    }
  }
  /* V4.4.8：空闲预构建沉浸层——首次进入不再因同步建 DOM/canvas 而卡顿、丢动画 */
  var _immWarmed = false;
  function immWarmUp() {
    if (_immWarmed || R.imm) return;
    _immWarmed = true;
    try { buildImmersive(); } catch (e) { }
  }
  try { setTimeout(immWarmUp, 2500); } catch (e) { }
  function toggleImmersive(force) {
    var want = force !== undefined ? force : !S.imm;
    if (want === !!S.imm) return;
    if (want && S.mini) { exitMini(); } // 沉浸与迷你互斥
    if (!want && R.imm) saveImmLayout(); // V4.4：退出沉浸前保存当前样式的布局
    buildImmersive();
    S.imm = want;
    if (!want) setImmInfo(false); // 退出沉浸收起信息面板
    if (want) immStartCursorWatch(); else immStopCursorWatch(); // 静止自动隐藏鼠标随沉浸进出
    if (want && R.immVinyl) vinylStartSpin(); // 复用旧沉浸层（buildImmersive 早退）时重启盘体 rAF；退出后循环靠 S.imm 自停
    // V4.4：沉浸模式真全屏（设置 → AM 界面 开关；退出沉浸无条件复位，非全屏时为无害空操作）
    try {
      var fsOn = !!(window.annieSettings && annieSettings.ui && annieSettings.ui.amImmFullscreen);
      /* V4.5：设置开启时进沉浸自动真全屏（V4.4.8 曾改为「保持窗口大小」导致开关形同虚设）；
         __immFs 同步，供 Esc 逐级退出判断。退出沉浸无条件复位（非全屏时是无害空操作） */
      if (window.mine && window.mine.winFullScreen) {
        if (want && fsOn) {
          window.mine.winFullScreen(true); window.__immFs = true;
          if (R.immBtnFs) { R.immBtnFs.classList.add('on'); R.immBtnFs.title = '退出真全屏（显示任务栏）'; }
        }
        else if (!want) {
          window.mine.winFullScreen(false); window.__immFs = false;
          if (R.immBtnFs) { R.immBtnFs.classList.remove('on'); R.immBtnFs.title = '真全屏（隐藏任务栏）'; }
        }
      }
    } catch (e) { }
    var root = document.getElementById('am-root');
    root.classList.toggle('am-imm-on', want);
    root.classList.toggle('am-imm-lyr-on', want && !!S.immLyrOn);
    root.classList.toggle('am-imm-q-on', want && !!S.immQOn);
    if (want) {
      syncAuxViews(); refreshAuxProgress();
      if (S.immLyrOn || immMode() === 'vinyl') buildLyrInto(R.immLyrBox); // 彩胶模式歌词常驻
      if (S.immQOn) renderQueuePanel(R.immQ);
      restoreImmLayout(immMode() === 'vinyl'); // V4.4：按沉浸样式恢复面板展开/歌词滚动（buildLyrInto 之后）
      syncImmLyrShift();
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
    if (on && S.imm) { S._qJumpCur = true; renderQueuePanel(R.immQ); immShowChrome(); } // 打开队列即退出静止隐藏态
  }

  /* ================= V4.4：主界面待播清单抽屉 ================= */
  function buildQDrawer(root) {
    if (R.qDrawer) return;
    R.qDrawer = el('div', 'am-q-drawer');
    root.appendChild(R.qDrawer);
  }
  function toggleMainQueue(force) {
    if (!R.qDrawer) return;
    var on = force !== undefined ? force : !S.qOn;
    S.qOn = on;
    document.getElementById('am-root').classList.toggle('am-q-on', on);
    if (R.btnQ) R.btnQ.classList.toggle('on', on);
    if (on) { S._qJumpCur = true; renderQueuePanel(R.qDrawer); }
  }
  AM.toggleMainQueue = toggleMainQueue;
  AM.enqueueNext = enqueueNext;
  /* 队列剩余条数角标（流媒体=当前之后的曲目数；本地=当前索引之后） */
  function refreshQBadge() {
    if (!R.btnQBadge) return;
    var n = 0;
    if (state.currentStream) {
      var rs = S._playList || S.stResults || [];
      n = Math.max(0, rs.length - 1 - S.stIndex);
    } else {
      n = Math.max(0, (state.queue || []).length - 1 - state.index);
    }
    var qbMode = 'dot';
    try { qbMode = (window.annieSettings && annieSettings.ui && annieSettings.ui.amQBadge) || 'dot'; } catch (e) { }
    R.btnQBadge.textContent = qbMode === 'count' ? (n > 99 ? '99+' : String(n)) : '';
    R.btnQBadge.classList.toggle('am-dot', qbMode !== 'count');
    R.btnQBadge.style.display = (n > 0 && qbMode !== 'off') ? '' : 'none';
  }
  /* 抽屉开着时的轻刷新：切歌/队列增删后更新高亮与角标（仅 queue 页签需要，评论/历史各自有事件或手动切回） */
  /* V4.4.9：切歌只改当前行高亮，不重建整表（避免封面闪烁、列表跳动） */
  function amQueueCurUpdate(box) {
    try {
      var list = box && box.querySelector('.am-q-list');
      if (!list) return false;
      var rows = list.querySelectorAll('.am-q-row');
      if (!rows.length) return false;
      /* 队列内容变了（换歌单 / 播放别的列表）→ 交给调用方重建，不能只挪高亮 */
      try {
        var _q = state.currentStream ? (S._playList || S.stResults || []) : (state.queue || []);
        var _n = _q.length;
        var _sig = (state.currentStream ? 'S' : 'L') + _n + '|' +
          String(_n ? ((_q[0] && (_q[0].path || _q[0].id || _q[0].title || '')) || '') : '').slice(-24) + '|' +
          String(_n ? ((_q[_n - 1] && (_q[_n - 1].path || _q[_n - 1].id || _q[_n - 1].title || '')) || '') : '').slice(-24);
        if (list.getAttribute('data-qsig') !== _sig) { S._qJumpCur = true; return false; }   // 队列被整份换掉（点了别的列表/歌单）→ 重建时定位到当前曲
      } catch (eS) { }
      /* V4.5：高亮按「行号 == state.index」判定，不再按路径匹配——
         队列里允许出现同一首歌的多条（下一首播放插入的重复项），按路径会让它们一起高亮 */
      var curIdx = state.currentStream ? -1 : (state.index | 0);
      var curPath = state.currentPath || '';
      var byIndex = (S.qTab !== 'hist');   // 历史页签的行不是队列顺序，不能按下标高亮
      var hasPath = false;
      for (var i = 0; i < rows.length; i++) {
        var rp = rows[i].dataset.path || '';
        if (rp) hasPath = true;
        var on = byIndex ? (curIdx >= 0 && i === curIdx) : (!state.currentStream && rp && rp === curPath);
        if (on !== rows[i].classList.contains('cur')) rows[i].classList.toggle('cur', on);
      }
      return hasPath;
    } catch (e) { return false; }
  }
  function refreshQDrawerIfOpen() {
    refreshQBadge();
    if (S.qOn && R.qDrawer && S.qTab !== 'cmt' && !amQueueCurUpdate(R.qDrawer)) renderQueuePanel(R.qDrawer);
  }

  /* ================= V4.4：重启恢复播放（本地 + 流媒体） =================
   * 双 localStorage 键：meta（队列快照/索引/播放态，切歌时写）+ pos（高频进度，5s 节流写）。
   * 启动 mount 时恢复：本地直接 playAt(idx,pos)；流媒体重建队列快照后重新解析 URL 播放，
   * 首个 position 事件到达再 seek。上次退出为暂停态 → 引擎开播后立刻 pause（不出整曲等待）。 */
  var RESUME_META = 'annieplayer.resume.v1', RESUME_POS = 'annieplayer.resume.pos';
  var _resumeSeek = null;   // 流媒体恢复：开播后首个 position 事件到达时 seek 到该秒
  var _resumePause = false; // 恢复目标为暂停态：检测到引擎 playing 后立即 pause
  function resumeEnabled() {
    try { return !(window.annieSettings && annieSettings.ui && annieSettings.ui.amResume === false); } catch (e) { return true; }
  }
  function writeResumeMeta() {
    if (!resumeEnabled()) return;
    try {
      if (state.currentStream) {
        var list = S._playList || S.stResults || [];
        if (!list.length || S.stIndex < 0 || !list[S.stIndex]) return;
        localStorage.setItem(RESUME_META, JSON.stringify({
          v: 1, kind: 'stream', quality: S.stQuality || 'flac',
          idx: S.stIndex, playing: !!state.playing, path: state.currentPath,
          // V4.4.2：冗余标题/艺人——快照错位或队列变动时弹窗仍能显示可读歌名
          title: state.currentStream.title || '', artist: state.currentStream.artist || '',
          songs: list.slice(0, 200) // 快照上限 200 首（约 100~300KB，localStorage 容量内）
        }));
      } else if (state.currentPath && state.queue && state.queue.length && state.index >= 0) {
        /* V4.4.9：播放列表曲目可能不在媒体库（未加入库的目录），恢复时按 libIndex 查不到——
           额外存一份轻量曲目信息，doRestore 里作为兜底 */
        localStorage.setItem(RESUME_META, JSON.stringify({
          v: 1, kind: 'local', idx: state.index, playing: !!state.playing, path: state.currentPath,
          title: (state.queue[state.index] && state.queue[state.index].name) || '',
          paths: state.queue.map(function (t) { return t && t.path; }).filter(Boolean),
          items: state.queue.slice(0, 200).map(function (t) {
            if (!t) return null;
            var mm = trackMeta(t);
            return { path: t.path, name: t.name || '', title: mm.title || '', artist: mm.artist || '',
                     album: mm.album || '', dur: t.dur || t.duration || 0 };
          }).filter(Boolean)
        }));
      }
    } catch (e) { /* 配额超限等：静默放弃本次保存 */ }
  }
  var _resumeSaveT = 0;
  function writeResumePosThrottled() {
    if (!resumeEnabled() || !state.currentPath) return;
    var now = Date.now();
    if (now - _resumeSaveT < 5000) return;
    _resumeSaveT = now;
    try { localStorage.setItem(RESUME_POS, JSON.stringify({ path: state.currentPath, pos: S.pos || state.position || 0 })); } catch (e) { }
  }
  function writeResumePosNow() {
    _resumeSaveT = 0;
    writeResumePosThrottled();
  }
  function resetResumePos(path) { // 切歌瞬间 S.pos 仍是旧曲值，位置键显式归零
    try { localStorage.setItem(RESUME_POS, JSON.stringify({ path: path || state.currentPath, pos: 0 })); } catch (e) { }
    _resumeSaveT = Date.now();
  }
  function restoreResume() {
    if (S._resumeDone) return;
    S._resumeDone = true;
    if (!resumeEnabled()) return;
    var meta = null;
    try { meta = JSON.parse(localStorage.getItem(RESUME_META) || 'null'); } catch (e) { }
    if (!meta || meta.v !== 1) return;
    var pos = 0;
    try {
      var pp = JSON.parse(localStorage.getItem(RESUME_POS) || 'null');
      if (pp && pp.path === meta.path) pos = Math.max(0, pp.pos || 0);
    } catch (e) { }
    // V4.4.2：不再静默续播——弹确认框由用户决定（无论上次退出是播放还是暂停）
    /* V4.4.9：设置项「启动时询问是否续播」写入 localStorage，这里必须读同一个键；
       window.__amResumePrompt 仅保留为 DevTools 逃生口（此前只读 window 导致开关形同虚设） */
    var _ask = false;
    try {
      var _rpLs = localStorage.getItem('annieplayer.amResumePrompt');
      if (_rpLs === 'on' || _rpLs === '1') _ask = true;
      else if (_rpLs === null && window.annieSettings && annieSettings.ui && annieSettings.ui.amResumePrompt === 'on') _ask = true;
    } catch (e0) { }
    if (_ask || window.__amResumePrompt) { showResumePrompt(meta, pos); }
    else {
      /* V4.4.9：默认静默恢复队列并强制暂停；等曲库索引就绪再执行（否则会静默失败） */
      var _rr = 0;
      (function _tryRestore() {
        var ready = false;
        try { ready = !!(state.libIndex && state.libIndex.size); } catch (e2) { }
        if (!ready) { if (_rr++ < 40) setTimeout(_tryRestore, 250); return; }
        try {
          meta.playing = false;
          var _vg = (state.library && state.library.volume != null) ? state.library.volume : 0.6;
          /* 先按持久化的独占/共享重建后端，再静默恢复；否则引擎启动默认独占会短暂静音其他程序 */
          var _ex = true;
          try { var _ev = localStorage.getItem('annieplayer.exclusive'); if (_ev !== null) _ex = _ev === '1'; } catch (e0) { }
          var _go = function () {
            try { window.mine.engine('volume.set', { gain: 0 }).catch(function () { }); } catch (e10) { }
            doRestore(meta, pos);
            setTimeout(function () { try { window.mine.engine('pause').catch(function () { }); } catch (e8) { } }, 80);
            setTimeout(function () { try { window.mine.engine('pause').catch(function () { }); } catch (e9) { } }, 600);
            setTimeout(function () { try { window.mine.engine('volume.set', { gain: _vg }).catch(function () { }); } catch (e11) { } }, 900);
          };
          if (_ex === false) {
            var _kind = state.backendKind || 'wasapi';
            var _id = null;
            try { var _bk = (state.library && state.library.backend) || ''; var _p = _bk.split('|'); if (_p[0] === 'wasapi' && _p[1]) _id = _p[1]; } catch (e0) { }
            var _select = function () { return window.mine.engine('devices.select', { kind: _kind, id: _id, exclusive: false }); };
            var _apply = function () {
              var _race = new Promise(function (res) { setTimeout(res, 1500); });
              Promise.race([_select().then(function () { return true; }), _race.then(function () { return false; })])
                .then(function (ok) { if (ok) window.__amExclDone = true; _go(); })
                .catch(function () { _go(); });
            };
            var _nm = (window.__lastFormat && window.__lastFormat.device) || null;
            if (_nm) {
              try {
                window.mine.engine('devices.list').then(function (dd) {
                  var hit = ((dd && dd.wasapi) || []).filter(function (x) { return x.name === _nm; })[0];
                  if (hit) _id = hit.id;
                  _apply();
                }).catch(function () { _apply(); });
              } catch (e0) { _apply(); }
            } else { _apply(); }
          } else { _go(); }
        } catch (e3) { }
      })();
    }
  }
  /* 续播确认弹窗：显示上次曲目/进度/状态；「续播」执行恢复，其余（不续播/关窗/Esc）清除恢复点 */
  function showResumePrompt(meta, pos) {
    var name = '';
    if (meta.kind === 'stream' && Array.isArray(meta.songs) && meta.songs[meta.idx]) {
      var sg = meta.songs[meta.idx];
      name = (sg.name || '') + (sg.artist ? ' - ' + sg.artist : '');
    }
    // V4.4.2：优先用写入时冗余的标题/艺人（快照错位、流媒体 URL 等场景兜底）
    if (!name && meta.title) name = meta.title + (meta.artist ? ' - ' + meta.artist : '');
    if (!name) {
      var p0 = String(meta.path || '');
      // 流媒体 URL 没有可读文件名——不拿 URL 截断段糊弄用户
      if (/^https?:\/\//i.test(p0)) name = '在线曲目';
      else { try { name = p0.replace(/#(cue|iso)\d+$/i, '').split(/[\\/]/).pop(); } catch (e) { } }
    }
    if (!name) { doRestore(meta, pos); return; } // 拿不到名字就直接恢复（不该发生，兜底）
    var mm = Math.floor(pos / 60), ss = Math.floor(pos % 60);
    var posTxt = mm + ':' + String(ss).padStart(2, '0');
    var ov = el('div', 'am-prompt-ov');
    var box = el('div', 'am-prompt');
    box.appendChild(el('div', 'am-pop-h', '继续上次播放？'));
    var msg = el('div', 'am-resume-msg');
    msg.textContent = '上次播放到《' + name + '》 ' + posTxt + (meta.playing ? '' : '（已暂停）');
    box.appendChild(msg);
    var row = el('div', 'am-prompt-btns');
    var bNo = el('button', 'am-btn', '不了');
    var bOk = el('button', 'am-btn am-btn-accent', '续播');
    function cleanup(resume) {
      ov.remove();
      document.removeEventListener('keydown', onKey, true);
      if (resume) doRestore(meta, pos);
      else { // 明确不续播：清掉恢复点，避免下次启动再问同一首
        try { localStorage.removeItem(RESUME_META); localStorage.removeItem(RESUME_POS); } catch (e) { }
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); cleanup(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); cleanup(true); }
    }
    bNo.onclick = function () { cleanup(false); };
    bOk.onclick = function () { cleanup(true); };
    ov.onclick = function (e) { if (e.target === ov) cleanup(false); };
    document.addEventListener('keydown', onKey, true);
    row.appendChild(bNo); row.appendChild(bOk);
    box.appendChild(row); ov.appendChild(box);
    document.body.appendChild(ov);
  }
  function doRestore(meta, pos) {
    if (meta.kind === 'local') {
      var byPath = state.libIndex || null;
      /* V4.4.9：播放列表曲目未必在媒体库索引里（未入库目录），此时用恢复点自带的 items 兜底 */
      var byItem = {};
      (meta.items || []).forEach(function (it) { if (it && it.path) byItem[it.path] = it; });
      var tracks = (meta.paths || []).map(function (p) {
        var t = byPath ? byPath.get(p) : null;
        if (!t && byItem[p]) t = byItem[p];
        return t || null;
      }).filter(Boolean);
      var idx = -1;
      tracks.forEach(function (t, i) { if (t.path === meta.path) idx = i; });
      if (idx < 0 || !tracks.length) return; // 曲目已不在媒体库且无兜底信息（移动/移除）→ 放弃恢复
      state.queue = tracks;
      state.queueCtx = 'list'; // 手动恢复的队列不视为全库（全文件顺序模式不越权接管）
      _resumePause = !meta.playing;
      playAt(idx, pos);
      /* V4.4.9：未入库的播放列表曲目没有标签缓存 → 顶栏标题会退化成文件路径、
         队列行只剩编号。恢复后异步补标签，到达后重刷顶栏与队列 */
      try {
        var _need = tracks.filter(function (x) { return x && x.path && !(S.meta && S.meta[x.path]); });
        if (_need.length) {
          if (window.__annieAMInternal && window.__annieAMInternal.ensureMeta) window.__annieAMInternal.ensureMeta(_need.slice(0, 200));
          var _mt = 0;
          (function _pollQueueMeta() {
            var miss = tracks.filter(function (x) { return x && x.path && !(S.meta && S.meta[x.path] && !S.meta[x.path].fail); });
            if (miss.length && _mt++ < 40) { setTimeout(_pollQueueMeta, 300); return; }
            try { refreshNowPlaying(); } catch (e1) { }
            try { if (S.qOn && R.qDrawer) renderQueuePanel(R.qDrawer); } catch (e2) { }
            try { if (S.immQOn && R.immQ && S.imm) renderQueuePanel(R.immQ); } catch (e3) { }
            try { if (S.miniQOn && R.miniQ && S.mini) renderQueuePanel(R.miniQ); } catch (e4) { }
          })();
        }
      } catch (eM) { }
    } else if (meta.kind === 'stream' && Array.isArray(meta.songs) && meta.songs[meta.idx]) {
      S.stQuality = meta.quality || S.stQuality;
      S._playList = meta.songs; // 纯快照队列，不污染搜索视图 stResults
      S.stIndex = meta.idx;
      _resumeSeek = pos;
      _resumePause = !meta.playing;
      playStreamAt(meta.idx, meta.songs);
    }
  }
  /* 引擎 state 事件里调用：恢复目标为暂停时，等引擎真正起播后立刻暂停（只播极短一瞬） */
  function resumeHandleState() {
    if (_resumePause && state.playing) {
      _resumePause = false;
      window.mine.engine('pause').catch(function () { });
    }
  }
  /* 引擎 position 事件里调用：流媒体恢复开播后补 seek（本地走 playAt offsetSec，不用这里） */
  function resumeHandlePosition() {
    if (_resumeSeek != null && state.currentStream && state.playing) {
      var target = _resumeSeek;
      _resumeSeek = null;
      if (target > 1) seek(target);
    }
  }
  window.addEventListener('pagehide', function () { writeResumeMeta(); writeResumePosNow(); });
  document.addEventListener('annie-app-before-quit', function () { writeResumeMeta(); writeResumePosNow(); });

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
    // V4.3.13：在线曲目快捷操作（仅播放流媒体/在线歌单时显示）
    R.miniBtnFav = el('button', 'am-tbtn', '♥'); R.miniBtnFav.title = '收藏到在线歌单'; R.miniBtnFav.style.display = 'none';
    R.miniBtnFav.onclick = function (e) { if (AM.favCurrentStream) AM.favCurrentStream(e.clientX, e.clientY); };
    R.miniBtnDl = el('button', 'am-tbtn', '⬇'); R.miniBtnDl.title = '下载当前在线歌曲'; R.miniBtnDl.style.display = 'none';
    R.miniBtnDl.onclick = function () {
      var cs = state.currentStream;
      if (cs && cs.song && AM.downloadStreamSong) AM.downloadStreamSong(cs.song, R.miniBtnDl);
    };
    var bPin = el('button', 'am-tbtn mini-pin-btn', '📌'); bPin.title = '窗口置顶（置于所有窗口之上）';
    bPin.onclick = function () { if (window.annieMiniPin) window.annieMiniPin.set(!window.annieMiniPin.get()); };
    var bExit = el('button', 'am-tbtn', '⤢'); bExit.title = '退出迷你模式'; bExit.onclick = function () { exitMini(); };
    var bClose = el('button', 'am-tbtn am-close', '✕'); bClose.title = '关闭'; bClose.onclick = function () { window.mine.winClose(); };
    wb.appendChild(R.miniBtnFav); wb.appendChild(R.miniBtnDl); wb.appendChild(bMin); wb.appendChild(bPin); wb.appendChild(bExit); wb.appendChild(bClose);
    head.appendChild(wb);
    m.appendChild(head);

    var prog = el('div', 'am-mini-prog');
    R.miniCur = el('span', 'am-mini-time', '0:00');
    var bar = el('div', 'am-mini-bar');
    R.miniFill = el('div', 'am-mini-fill');
    bar.appendChild(R.miniFill);
    bindProgDrag(bar, R.miniFill, R.miniCur); // V4.3.16：可拖动（原仅点击）
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
      refreshMiniStreamBtns(); // V4.3.13：进入迷你时同步 ♥/⬇ 可见性（可能正播在线曲目）
      var root = document.getElementById('am-root');
      root.classList.add('am-mini-on');
      root.classList.remove('am-mini-lyr-on', 'am-mini-q-on');
      R.miniBtnLyr.classList.remove('on'); R.miniBtnQ.classList.remove('on');
      if (window.annieMiniPin) window.annieMiniPin.apply(); // V3.5.15：按偏好套用置顶
      syncAuxViews(); refreshAuxProgress();
      miniResize(); // 首启/共享位置记忆尺寸不一：强制校准为迷你基准尺寸（360×170）
    }).catch(function () { });
  }
  function exitMini() {
    if (!S.mini) return;
    var pr = window.mine.miniExit();
    exitMiniUI(null); // 保持旧行为：S.mini 立即置 false、UI 立即卸载，IPC 仅负责窗口形态
    pr.then(function (r) {
      if (r && r.miniBounds) { try { localStorage.setItem(MINI_BOUNDS_LS, JSON.stringify(r.miniBounds)); } catch (e) { } }
    }).catch(function () { });
  }
  /* 迷你 UI 卸载（不碰主进程窗口形态）：⤢ 退出时 mini:enter 的逆操作；
   * V4.4 迷你下 ✕ 收进托盘时主进程已在隐藏状态还原窗口，经 onMiniHiddenToTray 走这里。 */
  function exitMiniUI(miniBounds) {
    if (!S.mini) return;
    if (miniBounds) { try { localStorage.setItem(MINI_BOUNDS_LS, JSON.stringify(miniBounds)); } catch (e) { } }
    S.mini = false;
    S.miniLyrOn = false; S.miniQOn = false;
    document.getElementById('am-root').classList.remove('am-mini-on', 'am-mini-lyr-on', 'am-mini-q-on');
    /* V4.4：退出迷你强制重开窗格——迷你期间 .am-body display:none，
     * 期间切歌/重建会以 clientHeight=0 算出错误窗口（只渲染顶部几行+巨大垫片），
     * 回来后浏览器又可能把 scrollTop 恢复到旧位置 → 视口落在垫片上=整片空白，
     * 直到下次轮询/切歌才自愈（用户回报「回主界面歌曲不显示，等一下就好」）。
     * 两遍：rAF 补布局恢复后的当帧，300ms 补 OS 窗口尺寸还原落定后。
     * 托盘隐藏路径下窗口不可见也照常执行——下次 show 时主界面已是正确窗口。 */
    requestAnimationFrame(function () { if (S._tbl) { S._tbl.lastStart = -1; renderAmWindow(); } });
    setTimeout(function () { if (S._tbl) { S._tbl.lastStart = -1; renderAmWindow(); } }, 300);
  }
  if (window.mine && mine.onMiniHiddenToTray) {
    mine.onMiniHiddenToTray(function (payload) { if (S.mini) exitMiniUI(payload && payload.miniBounds); });
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

  /* V4.4：沉浸封面切歌交叉转场——旧封面克隆为 ghost 淡出微缩，新封面从模糊放大态淡入；
   * 经典（.am-imm-cover 方角）与彩胶（.am-vinyl-cover 圆形标签）共用，ghost 克隆原 class 继承圆角。
   * 无封面/首次/切到无封面不交叉（直接走 swapCover），避免空层闪烁。 */
  var immCovTimer = 0;
  /* 只有长方形封面才放大；正方形保持原尺寸（放大后会压到歌名） */
  function markImmCoverShape() {
    try {
      var im = R.immCover;
      if (!im) return;
      if (!im.__shapeBound) {
        im.__shapeBound = 1;
        im.addEventListener('load', markImmCoverShape);
      }
      var w = im.naturalWidth, h = im.naturalHeight;
      if (!w || !h) return;
      im.classList.toggle('am-imm-wide', (w / h) > 1.15);
      var _g = im.parentElement && im.parentElement.querySelector('.am-imm-cov-ghost');
      if (_g) _g.classList.toggle('am-imm-wide', im.classList.contains('am-imm-wide'));
    } catch (e) { }
  }
  function immCoverCrossfade(url) {
    var img = R.immCover;
    if (!img) return;
    var old = img.getAttribute('src') || '';
    var nu = url || '';
    if (old === nu) return;
    if (!old || !nu) { img.classList.remove('am-cov-in'); swapCover(img, nu || null); return; }
    /* 新封面以克隆层盖在上面淡入：旧图仍在下面，不会再"盖回"新图。
       （原实现把旧封面克隆到上层淡出，切歌时会看到：先新图、再闪回旧图、再回新图） */
    var host = img.parentElement;
    /* 连续切歌（间隔 <380ms）时上一次 ghost 的移除 timer 会被下面的 clearTimeout 取消，
       旧 ghost 再无清理路径、永久盖住封面——进函数先清掉全部残留 ghost */
    host.querySelectorAll('.am-imm-cov-ghost').forEach(function (g) { g.remove(); });
    var ghost = img.cloneNode(false);
    ghost.removeAttribute('id');
    ghost.className += ' am-imm-cov-ghost';
    ghost.src = nu;
    host.appendChild(ghost);
    img.classList.remove('am-swap', 'am-cov-in');
    /* 底层立刻换成新图，保证一定切；顶层 ghost 只负责淡入过渡 */
    img.src = nu;
    markImmCoverShape();
    void img.offsetWidth;
    img.classList.add('am-cov-in');
    void ghost.offsetWidth;
    ghost.classList.add('am-cov-in');
    if (immCovTimer) clearTimeout(immCovTimer);
    immCovTimer = setTimeout(function () {
      immCovTimer = 0;
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    }, 380);
  }
  /* 沉浸/迷你界面字段同步（封面/标题/参数 与 进度/播放键）；封面走 swapCover 弹入动画 */
  function syncAuxViews() {
    var cover = R.npCover && R.npCover.getAttribute('src');
    if (R.imm) {
      immCoverCrossfade(cover || null); // V4.4：沉浸封面交叉转场（替代单图 swap）
      if (R.immVinyl) paintVinyl(cover || null); // 彩胶颜色跟随封面
      R.immTitle.textContent = R.npTitle.textContent;
      R.immSub.textContent = R.npSub.textContent;
      R.immFmt.textContent = S.fmt || '';
      if (R.vol) R.immVol.value = R.vol.value;
    }
    if (R.mini) {
      swapCover(R.miniCover, cover || null);
      R.miniTitle.textContent = R.npTitle.textContent;
      R.miniSub.textContent = R.npSub.textContent;
      R.miniFmt.textContent = S.fmt || '';
      if (R.vol) R.miniVol.value = R.vol.value;
    }
  }
  /* ===== 沉浸模式 Esc 一次退出 =====
     V4.5（用户拍板）：无论经典/彩胶、无论是否真全屏/最大化/开着信息面板，
     Esc 一次直接回主界面（全屏复位、信息面板收起由 toggleImmersive 统一处理）。
     仅设置中心 / 排序弹层 / 氛围模式打开时让位给它们自己的 Esc 处理。 */
  (function () {
    if (window.__immEscBound) return;
    window.__immEscBound = 1;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (!S.imm) return;
      if (document.querySelector('#settings-panel.open')) return;
      if (document.querySelector('.am-pop.on, .am-sort-pop.on')) return;
      if (window.annieAmbient && window.annieAmbient.isOpen && window.annieAmbient.isOpen()) return;
      e.preventDefault(); e.stopPropagation();
      try { toggleImmersive(false); } catch (x) { }
    }, true);
  })();

  /* 沉浸模式：文字随窗口比例缩放（以 1280×720 为基准），再乘设置里的字号系数 */
  (function () {
    if (window.__amImmFsBound) return;
    window.__amImmFsBound = 1;
    function apply() {
      try {
        var root = document.getElementById('am-root');
        if (!root) return;
        var k = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
        k = Math.max(0.85, Math.min(1.45, k));
        var ls = (S && S.lyrScale) ? S.lyrScale : 1;
        root.style.setProperty('--am-imm-fs', (k * ls).toFixed(3));
      } catch (e) { }
    }
    window.addEventListener('resize', apply);
    apply();
    setInterval(apply, 1200);
  })();

  function refreshAuxProgress() {
    if (state.seeking) return; // V4.3.16：拖动预览期间不覆盖沉浸/迷你进度
    var pct = S.dur > 0 ? Math.min(1, S.pos / S.dur) : 0;
    var cur = fmtTime(S.pos);
    var rem = S.dur > 0 ? '-' + fmtTime(Math.max(0, S.dur - S.pos)) : '-0:00';
    if (R.imm && S.imm) {
      R.immCur.textContent = cur; R.immRemain.textContent = rem;
      R.immFill.style.width = (pct * 100) + '%';
      setPlayIcon(R.immPlay);
      if (R.immDockFill) { // V4.4：底部悬浮 dock 同步进度（拖动预览期间同样被函数头的 seeking 守卫挡住）
        R.immDockCur.textContent = cur; R.immDockRemain.textContent = rem;
        R.immDockFill.style.width = (pct * 100) + '%';
        setPlayIcon(R.immDockPlay);
      }
      if (R.immVinyl) { /* V4.4：盘体转/停由 rAF 惯性物理读 state.playing 驱动，不再切 CSS play-state */ }
      immOsdTick(); // 播放/暂停、音量 OSD 检测
    }
    if (R.mini && S.mini) {
      R.miniCur.textContent = cur; R.miniRemain.textContent = rem;
      R.miniFill.style.width = (pct * 100) + '%';
      setPlayIcon(R.miniPlay);
    }
  }

  /* ---------------- 播放状态刷新 ---------------- */
  /* V4.1 切歌动效助手：氛围背景 dip-fade / 封弹入 / 文本两阶段过渡，全部可重入（连点切歌重置定时器） */
  var _bgSwapT = 0, _bgLast = undefined;
  /* V4.4.8：超大内嵌封面（data:）先缩到 720px 再用作氛围背景；
     之前 3~4MB 的 base64 直接塞进 --am-bgimage 会整条背景不显示 */
  var _bgSmallCache = {};
  function bgFromDataUrl(url, cb) {
    if (!url || url.slice(0, 5) !== 'data:' || url.length < 300 * 1024) { cb(url); return; }
    if (_bgSmallCache[url]) { cb(_bgSmallCache[url]); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var max = 720;
        var w = img.naturalWidth || 1, h = img.naturalHeight || 1;
        var k = Math.min(1, max / Math.max(w, h));
        var cv2 = document.createElement('canvas');
        cv2.width = Math.max(1, Math.round(w * k));
        cv2.height = Math.max(1, Math.round(h * k));
        cv2.getContext('2d').drawImage(img, 0, 0, cv2.width, cv2.height);
        var out = cv2.toDataURL('image/jpeg', 0.82);
        _bgSmallCache[url] = out;
        cb(out);
      } catch (e) { cb(url); }
    };
    img.onerror = function () { cb(url); };
    img.src = url;
  }
  function swapAtmosphere(url) {
    var root = document.getElementById('am-root');
    if (!root || url === _bgLast) return;
    _bgLast = url;
    root.classList.add('am-bgout');
    clearTimeout(_bgSwapT);
    _bgSwapT = setTimeout(function () {
      if (url) {
        bgFromDataUrl(url, function (u) {
          if (_bgLast !== url) return;
          root.style.setProperty('--am-bgimage', 'url("' + u + '")');
          root.classList.remove('am-nobg');
        });
      }
      else root.classList.add('am-nobg');
      root.classList.remove('am-bgout');
    }, 180);
  }
  function swapCover(img, url) {
    if (!img) return;
    if ((img.getAttribute('src') || '') === (url || '')) return;
    if (url) img.src = url; else img.removeAttribute('src');
    img.classList.remove('am-swap'); void img.offsetWidth; img.classList.add('am-swap');
    // V4.3.22：顶栏封面变化时镜像到歌词面板封面，并标记有无封面（CSS 据此给歌词区顶部让位）
    if (img === R.npCover && R.lyrCover) {
      swapCover(R.lyrCover, url);
      if (R.lyrCoverBg) R.lyrCoverBg.style.backgroundImage = url ? 'url("' + url + '")' : '';
      var root = document.getElementById('am-root');
      if (root) {
        root.classList.toggle('am-lyrcover-has', !!url);
        // V4.4.8：当前封面取色 → CSS 变量（侧栏搜索框 / A–Z 索引条半透明底色用）
        if (window.amVizColor) {
          if (!url) {
            root.style.removeProperty('--am-cover-c1');
            root.style.removeProperty('--am-cover-c2');
            root.style.removeProperty('--am-cover-vivid');
          } else {
            window.amVizColor.analyze(url, function (pal) {
              if (!pal) {
                root.style.removeProperty('--am-cover-c1');
                root.style.removeProperty('--am-cover-c2');
            root.style.removeProperty('--am-cover-vivid');
                return;
              }
              /* 搜索框底色来源可选：跟随封面 / 跟随频谱主色 / 不着色 */
              var _tone = (window.annieSettings && annieSettings.ui && annieSettings.ui.amSearchTone) || 'cover';
              var _c1 = _tone === 'plain' ? 'transparent'
                      : (_tone === 'prime' ? pal.primary : (pal.vizUi || pal.primary));
              root.style.setProperty('--am-cover-c1', _c1);
              root.style.setProperty('--am-cover-c2', pal.accent);
              root.style.setProperty('--am-cover-vivid', pal.vivid || pal.primary);
              /* 深色封面给更高占比、浅色封面给更低占比，避免「深封面一片白、浅封面一片灰」 */
              try {
                var _m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(pal.primary || '');
                if (_m) {
                  var _r = +_m[1], _g = +_m[2], _b = +_m[3];
                  var _l = 0.2126 * _r + 0.7152 * _g + 0.0722 * _b;
                  /* 反解占比：让合成后的亮度落在一个固定区间 ——
                     深色封面自动少掺（不发黑），浅色封面自动多掺（不发白） */
                  var _W = 251, _tgt = 0.845 * 255;
                  var _ratio = (_W - _tgt) / Math.max(18, (_W - _l));
                  var _t = Math.round(Math.max(12, Math.min(40, _ratio * 100)));
                  root.style.setProperty('--am-cover-tint', _t + '%');
                }
              } catch (e2) { }
            });
          }
        }
      }
    }
  }
  var _txT = 0;
  /* V4.3.13：迷你模式 ♥/⬇ 只在播在线曲目时露面；切歌时重置下载按钮状态 */
  function refreshMiniStreamBtns() {
    if (!R.miniBtnFav || !R.miniBtnDl) return;
    var on = !!(state.currentStream && state.currentStream.song);
    R.miniBtnFav.style.display = on ? '' : 'none';
    R.miniBtnDl.style.display = on ? '' : 'none';
    if (on && R.miniBtnDl.disabled) { R.miniBtnDl.disabled = false; R.miniBtnDl.textContent = '⬇'; }
  }
  function swapNpText(title, sub) {
    refreshMiniStreamBtns(); // 切歌时机：在线/本地身份在此刻切换
    if (!R.npText) return;
    if (R.npTitle.textContent === title && R.npSub.textContent === sub) return;
    clearTimeout(_txT);
    R.npText.classList.remove('am-tx-in');
    R.npText.classList.add('am-tx-out');
    _txT = setTimeout(function () {
      R.npTitle.textContent = title;
      R.npSub.textContent = sub;
      // 迷你/沉浸直接写入新文本：syncAuxViews 读 npTitle 时本动画尚未落地，会拿到上一首（慢一拍）
      if (R.miniTitle) { R.miniTitle.textContent = title; R.miniSub.textContent = sub; }
      if (R.immTitle) { R.immTitle.textContent = title; R.immSub.textContent = sub; }
      R.npText.classList.remove('am-tx-out');
      R.npText.classList.add('am-tx-in');
    }, 140);
  }
  /* 播放/暂停图标形变（图标变化时才重放动画；进度 tick 高频调用零开销） */
  function setPlayIcon(btn) {
    if (!btn) return;
    var icon = state.playing ? '⏸' : '▶';
    if (btn.textContent !== icon) {
      btn.classList.remove('am-ico-sw'); void btn.offsetWidth; btn.classList.add('am-ico-sw');
      btn.textContent = icon;
    }
    /* V4.4.7（PR#6）：⏸ 字形的墨迹比 ▶ 低（顶栏 2.0px、沉浸模式 2.6px），换字形时重贴一次，
       否则会一直沿用上一个字形的垂直偏移 */
    var isImm = btn.classList.contains('am-imm-play');
    btn.style.position = 'relative';
    btn.style.top = (icon === '⏸' ? (isImm ? -2.6 : -2.9) : (isImm ? 0 : -0.9)) + 'px';
  }
  /* V4.4.7（PR#6）：记住最后一次拿到的音质文本。引擎的 format 事件是「格式变化才发」，
     一旦 S.fmt 被清空，同格式的下一首不会再发事件，徽标就一直不回来（只能重启）。 */
  var _fmtClearT = 0, _lastFmt = '';
  function refreshBadge() {
    clearTimeout(_fmtClearT);
    if (S.fmt) _lastFmt = S.fmt;
    if (!R.npBadge) return;
    /* V4.4.8：按 np 实际可用宽度决定胶囊文案（短/长） */
    var _rootEl = document.getElementById('am-root');
    var _npEl = _rootEl && _rootEl.querySelector('.am-np');
    if (window.__amMeasuring) return;   /* 展开预测测量期间不要动胶囊 */
    /* 迟滞：低于 290 才收，高于 330 才展开，中间区间保持现状（防止阈值附近来回抖） */
    var _npw = _npEl ? _npEl.clientWidth : 0;
    if (_npw < 290) window.__amTightOn = true; else if (_npw > 330) window.__amTightOn = false;
    var _tightBadge = !!window.__amTightOn;   /* np 被压到 0 也算紧凑 */
    var _txt = _tightBadge ? String(S.fmt || '').split('·')[0].trim() : S.fmt;
    if (R.npBadge.textContent !== _txt) {
      var _b = R.npBadge;
      if (window.__amBadgeAnim) return;   /* 动画进行中，避免拖拽/观测器反复重启 */
      var _shrink = _txt.length < _b.textContent.length;
      if (window.__amNoBlur) {
        /* 拖动路径：先动宽度（文字暂不换，靠 ellipsis 逐字裁），收完再落文案；无模糊 */
        _b.classList.remove('am-badge-blur');
        var _ow = _b.getBoundingClientRect().width;
        var _clone = _b.cloneNode(false);
        _clone.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;width:auto;';
        _clone.textContent = _txt;
        _b.appendChild(_clone);
        var _nw = _clone.getBoundingClientRect().width;
        _clone.remove();
        window.__amBadgeAnim = true;
        _b.style.transition = 'width .16s ease';
        _b.style.width = _ow + 'px';
        if (_shrink) {
          void _b.offsetWidth;
          _b.style.width = _nw + 'px';
          setTimeout(function () { _b.textContent = _txt; _b.style.width = ''; _b.style.transition = ''; window.__amBadgeAnim = false; }, 180);
        } else {
          _b.textContent = _txt;
          void _b.offsetWidth;
          _b.style.width = _nw + 'px';
          setTimeout(function () { _b.style.width = ''; _b.style.transition = ''; window.__amBadgeAnim = false; }, 180);
        }
      } else {
        var _ow2 = _b.getBoundingClientRect().width;
        var _clone2 = _b.cloneNode(false);
        _clone2.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;width:auto;';
        _clone2.textContent = _txt;
        _b.appendChild(_clone2);
        var _nw2 = _clone2.getBoundingClientRect().width;
        _clone2.remove();
        window.__amBadgeAnim = true;
        _b.style.transition = _shrink ? 'width .11s ease' : 'width .28s cubic-bezier(.25,.1,.25,1)';
        _b.style.width = _ow2 + 'px';
        _b.textContent = _txt;
        void _b.offsetWidth;
        if (_shrink) { _b.classList.remove('am-badge-blur'); void _b.offsetWidth; _b.classList.add('am-badge-blur'); }
        else { _b.classList.remove('am-badge-blur'); }
        _b.style.width = _nw2 + 'px';
        setTimeout(function () { _b.style.transition = 'none'; _b.style.width = ''; void _b.offsetWidth; _b.style.transition = ''; window.__amBadgeAnim = false; }, _shrink ? 160 : 340);
        setTimeout(function () { _b.classList.remove('am-badge-blur'); }, 620);
      }
    }
    R.npBadge.style.display = S.fmt ? '' : 'none';
  }
  // V4.4：流媒体命中本地播放缓存时，主/沉浸/迷你三处音质徽标点亮「缓存」态
  function refreshCacheBadge() {
    var on = !!(state.currentStream && S.cacheHit);
    [R.npBadge, R.immFmt, R.miniFmt].forEach(function (elm) {
      if (!elm) return;
      elm.classList.toggle('am-fmt-cache', on);
      elm.title = on ? '命中本地播放缓存，秒开且不耗流量' : '';
    });
  }
  function refreshTimes() {
    if (!R.npCur) return;
    if (state.seeking) return; // V4.3.16：拖动预览期间不覆盖
    R.npCur.textContent = fmtTime(S.pos);
    R.npRemain.textContent = S.dur > 0 ? fmtRemain(S.dur - S.pos) : '0:00';
    if (R.npProgFill && S.dur > 0) R.npProgFill.style.width = (Math.min(1, S.pos / S.dur) * 100) + '%';
    refreshAuxProgress();
  }
  function refreshNowPlaying() {
    if (!R.npTitle) return;
    var p = state.currentPath;
    if (!p) {
      swapNpText('未在播放', '');
      swapCover(R.npCover, null);
      S.fmt = ''; refreshBadge();
      swapAtmosphere(null);
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
    /* __amNpMetaFallback: 不在曲库索引时回退到标签缓存，避免顶栏只剩文件路径 */
    else if (S.meta[p]) { var mf = S.meta[p]; title = mf.title || p; artist = mf.artist || ''; album = mf.album || ''; }
    swapNpText(title, artist + (album ? ' — ' + album : ''));
    /* V4.4.8：冷启动曲库/标签未就绪时标题会退化成文件名，就绪后补一次 */
    if (!state.currentStream) {
      var _npTry = 0;
      (function _npPoll() {
        if (state.currentPath !== p) return;
        var _tt = null;
        try { _tt = allTracks().find(function (x) { return x.path === p; }); } catch (e0) { }
        if (!_tt) { if (_npTry++ < 25) setTimeout(_npPoll, 300); return; }
        if (!(S.meta && S.meta[_tt.path])) {
          try { if (window.__annieAMInternal && window.__annieAMInternal.ensureMeta) window.__annieAMInternal.ensureMeta([_tt]); } catch (e1) { }
          if (_npTry++ < 25) setTimeout(_npPoll, 300);
          return;
        }
        var _m2 = window.__annieAMInternal && window.__annieAMInternal.trackMeta ? window.__annieAMInternal.trackMeta(_tt) : null;
        if (_m2 && _m2.title && _m2.title !== R.npTitle.textContent) {
          swapNpText(_m2.title, _m2.artist + (_m2.album ? ' — ' + _m2.album : ''));
          S._smtc = { title: _m2.title, artist: _m2.artist, album: _m2.album }; pushSmtc();
        }
      })();
    }
    S._smtc = { title: title, artist: artist, album: album }; // V4.4.7：供 SMTC 伴随进程使用
    S._smtcCover = ''; S._smtcCoverReady = false;            // 换曲先清封面，等回调里补
    pushSmtc();
    if (streamCover) {
      // 流媒体：封面是 URL，直接用（不经 meta 解析）
      swapCover(R.npCover, streamCover);
      swapAtmosphere(streamCover);
      syncAuxViews();
    } else {
      var srcPath = (state.currentCue && state.currentCue.src) ||
                    (state.currentIso && state.currentIso.src) || (t && t.path) || p;
      if (srcPath) (t ? trackCover : ensureCover).call(null, t || srcPath, function (url) {
        if (state.currentPath !== p) return;
        if (url && url.indexOf('data:') === 0) smtcCoverThumb(url, function (small) { S._smtcCover = small; S._smtcCoverReady = true; pushSmtc(); }); /* V4.4.7：SMTC 封面（缩到 400px） */
        swapCover(R.npCover, url || null);
        swapAtmosphere(url || null);
        syncAuxViews();
      });
      else { swapCover(R.npCover, null); swapAtmosphere(null); }
      syncAuxViews();
    }
    loadLyrics(state.currentStream ? state.currentPath : ((state.currentCue && state.currentCue.src) || (t && t.path) || p || null), !!state.currentStream);
  }

  /* V4.4.7（PR#6）：SMTC 封面统一缩到 400px JPEG（SMTC 缩略图不需要大图，减小 IPC 体积）。
     原始内嵌封面动辄几百 KB～几 MB（dataURL 更大），直接塞给 PowerShell 宿主既慢又会被
     主进程的 400KB 上限截断——截断后 base64 非法，宿主解码失败就永远没有封面。 */
  var _smtcThumbCache = {};
  function smtcCoverThumb(url, cb) {
    if (!url || url.indexOf('data:') !== 0) { cb(''); return; }
    if (_smtcThumbCache[url] !== undefined) { cb(_smtcThumbCache[url]); return; }
    try {
      var img = new Image();
      img.onload = function () {
        try {
          var MAXS = 400;
          var iw = img.width || MAXS, ih = img.height || MAXS;
          var s = Math.min(iw, ih);                 // 先居中裁成正方形
          var side = Math.max(64, Math.min(MAXS, s)); // 不放大：源图小于 400 就按源图边长走
          var cv = document.createElement('canvas');
          cv.width = side; cv.height = side;
          var g = cv.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, side, side);
          var out = cv.toDataURL('image/jpeg', 0.9);
          _smtcThumbCache[url] = out;
          cb(out);
        } catch (e) { _smtcThumbCache[url] = ''; cb(''); }
      };
      img.onerror = function () { _smtcThumbCache[url] = ''; cb(''); };
      img.src = url;
    } catch (e) { cb(''); }
  }

  /* V4.4.7（PR#6）：把当前曲目推给主进程 → SMTC 伴随进程（同一首/同一状态只发一次） */
  /* V4.4.7：封面没到时先等 ~400ms，把「标题+封面」合并成一次 Update。
     否则会先推一条无封面的元数据——壁纸/歌词挂件往往只认第一次变更，之后就一直是空封面。 */
  function pushSmtc() {
    if (S._smtcT) { clearTimeout(S._smtcT); S._smtcT = null; }
    var delay = S._smtcCoverReady ? 0 : 400;
    S._smtcT = setTimeout(function () { S._smtcT = null; pushSmtcNow(); }, delay);
  }
  function pushSmtcNow() {
    try {
      if (!window.mine || !window.mine.smtcUpdate) return;
      // 设置里可以关掉：关掉时直接收掉那个常驻进程
      if (localStorage.getItem('amSmtc') === 'off') {
        if (S._smtcSig !== 'off') { S._smtcSig = 'off'; window.mine.smtcUpdate({ off: true }); }
        return;
      }
      var m = S._smtc || {};
      var cv = S._smtcCover || '';
      var ci = cv.indexOf('base64,');
      var cb64 = ci >= 0 ? cv.slice(ci + 7) : '';
      var o = { title: m.title || '', artist: m.artist || '', album: m.album || '', playing: !!state.playing, cover: cb64, pos: Math.round(S.pos || 0), dur: Math.round(S.dur || 0) };
      var sig = o.title + '|' + o.artist + '|' + o.album + '|' + (o.playing ? '1' : '0') + '|' +
                (cb64 ? cb64.length + ':' + cb64.slice(0, 24) : '') + '|' + o.pos + '/' + o.dur;
      if (sig === S._smtcSig) return;
      S._smtcSig = sig;
      window.mine.smtcUpdate(o);
    } catch (e) { }
  }
  /* PR#17#B：SMTC 首启迁移——存量 on 且用户从未显式选择过 → 置 off 并提示 */
  (function () {
    try {
      if (localStorage.getItem('annieplayer.amSmtcMigrated') === '1') return;
      localStorage.setItem('annieplayer.amSmtcMigrated', '1');
      if (localStorage.getItem('annieplayer.amSmtcUserSet') === '1') return;
      if (localStorage.getItem('amSmtc') !== 'on') return;
      localStorage.setItem('amSmtc', 'off');
      (function syncStore(n) {
        try {
          if (localStorage.getItem('annieplayer.amSmtcUserSet') === '1') return;
          var s = window.annieSettings;
          if (s && s.ui) {
            if (s.ui.amSmtc !== 'off') { s.ui.amSmtc = 'off'; if (typeof s.save === 'function') s.save(); }
            if (localStorage.getItem('amSmtc') !== 'off') localStorage.setItem('amSmtc', 'off');
            return;
          }
        } catch (e3) { }
        if (n < 40) setTimeout(function () { syncStore(n + 1); }, 250);
      })(0);
      (function waitToast(n) {
        if (typeof window.proToast === 'function') {
          try { window.proToast('SMTC 可能增加系统负载，已默认关闭，可在 设置 → AM 界面 开启'); } catch (e2) { }
          return;
        }
        if (n > 20) return;
        setTimeout(function () { waitToast(n + 1); }, 500);
      })(0);
    } catch (e0) { }
  })();
  /* PR#17#A：设置项「启动时询问是否续播」+ SMTC 显式选择标记 */
  (function () {
    var KEY = 'annieplayer.amResumePrompt';
    var FLAG = 'annieplayer.amSmtcUserSet';
    function val() {
      try { return localStorage.getItem(KEY) === 'on' ? 'on' : 'off'; } catch (e) { return 'off'; }
    }
    function markSmtc() {
      try {
        var rows = document.querySelectorAll('.set-row');
        for (var i = 0; i < rows.length; i++) {
          if ((rows[i].textContent || '').indexOf('系统媒体会话') >= 0) {
            var sel = rows[i].querySelector('select');
            if (sel && !sel.__amSmtcMark) {
              sel.__amSmtcMark = 1;
              sel.addEventListener('change', function () {
                try { localStorage.setItem(FLAG, '1'); } catch (e) { }
              });
            }
            break;
          }
        }
      } catch (e) { }
    }
    function inject() {
      try {
        if (document.getElementById('am-rp-row')) return;
        var rows = document.querySelectorAll('.set-row');
        if (!rows.length) return;
        var anchor = null;
        for (var i = 0; i < rows.length; i++) {
          if ((rows[i].textContent || '').indexOf('系统媒体会话') >= 0) { anchor = rows[i]; break; }
        }
        if (!anchor) return;
        var row = document.createElement('div');
        row.className = 'set-row';
        row.id = 'am-rp-row';
        var lab = document.createElement('div');
        var t = document.createElement('div');
        t.textContent = '启动时询问是否续播';
        var h = document.createElement('div');
        h.className = 'set-hint';
        h.textContent = '关闭=直接静默恢复并暂停（不弹窗）；开启=弹窗让你选择续播或从头播放';
        lab.appendChild(t); lab.appendChild(h);
        var sel = document.createElement('select');
        [['off', '关闭（静默恢复）'], ['on', '开启（弹窗询问）']].forEach(function (o) {
          var op = document.createElement('option');
          op.value = o[0]; op.textContent = o[1];
          sel.appendChild(op);
        });
        sel.value = val();
        sel.onchange = function () {
          try { localStorage.setItem(KEY, sel.value); } catch (e) { }
          try {
            if (window.annieSettings && annieSettings.ui) {
              annieSettings.ui.amResumePrompt = sel.value;
              if (typeof annieSettings.save === 'function') annieSettings.save();
            }
          } catch (e) { }
        };
        row.appendChild(lab); row.appendChild(sel);
        anchor.parentNode.insertBefore(row, anchor.nextSibling);
      } catch (e) { }
    }
    window.__amRpInject = inject;
    /* 面板打开时每 600ms 轻量补一次（一次 getElementById，代价可忽略）；关闭时不做事 */
    try {
      function tick() {
        var panel = document.getElementById('settings-panel');
        if (!panel || !panel.classList.contains('open')) return;
        inject();
        markSmtc();
      }
      setInterval(tick, 600);
      setTimeout(tick, 800);
    } catch (e) { }
  })();
  function refreshTransport() {
    pushSmtc();  /* V4.4.7: 播放/暂停状态也同步给 SMTC */

    if (!R.btnPlay) return;
    S.playing = !!state.playing;
    setPlayIcon(R.btnPlay);
    refreshAuxProgress();
    refreshQBadge(); // V4.4：待播数角标（高频轮询调用，内部仅写文本）
    refreshCacheBadge(); // V4.4：切回本地（currentStream 清空）时灭缓存灯
  }
  function refresh() {
    refreshNowPlaying();
    refreshTransport();
    restoreScrollAround();
  }
  /* renderView 重建内容但保持滚动位置，并主动对齐窗口化可视区（不等 scroll 事件，时序不可靠） */
  function restoreScrollAround() {
    /* __amDragGuard: 拖动期间延迟重绘，拖动结束再补 */
    if (window.__amDragBusy) { window.__amDragPending = true; return; }
    var sc = R.content ? R.content.scrollTop : 0;
    renderView();
    if (!R.content) return;
    void R.content.scrollHeight; // 强制布局，避免恢复值被旧高度钳制
    R.content.scrollTop = sc;
    if (S._tbl) { S._tbl.lastStart = -1; renderAmWindow(); }
  }
  window.__amFlushDragRender = function () {
    if (!window.__amDragPending) return;
    window.__amDragPending = false;
    restoreScrollAround();
  };

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
        // V4.3.16：拖动预览期间位置事件不回写（预览归拖动器负责）
        if (state.seeking) return;
        // V4.3.16：seek 保护——引擎重缓冲期间的旧位置事件丢弃（在线曲目 1~3s 回拉根因），到达目标后解除
        if (state.seekPending) {
          var rel = Math.max(0, (data.seconds || 0) - (state.currentCue ? state.currentCue.start : 0));
          if (rel >= (state.seekTarget || 0) - 0.5) { state.seekPending = false; clearTimeout(state.seekTimer); }
          else return;
        }
        S.pos = Math.max(0, (data.seconds || 0) - (state.currentCue ? state.currentCue.start : 0));
        S.dur = state.currentCue ? (state.currentCue.end - state.currentCue.start)
          : (data.duration || (state.currentStream && state.duration) || 0);
        refreshTimes();
        tickLyrics();
        resumeHandlePosition();   // V4.4：流媒体重启恢复的补 seek
        writeResumePosThrottled(); // V4.4：播放进度持久化（5s 节流）
        if (AM.maybePreloadNext) AM.maybePreloadNext(); // V4.4：接近曲尾预解析下一首 URL
      } else if (event === 'state') {
        refreshTransport();
        resumeHandleState(); // V4.4：恢复为暂停态时，引擎起播即暂停
      } else if (event === 'format' && data && !state.currentStream) {
        // 音质徽标：本地播放显示 编码 · 位深/采样率（流式音质由 playStreamAt 直接设置）
        var parts = [];
        if (data.codec) parts.push(String(data.codec).toUpperCase());
        if (data.bitDepth) parts.push(data.bitDepth + 'bit');
        if (data.requestedRate) parts.push((data.requestedRate / 1000) + 'kHz');
        S.fmt = parts.join(' · ');
        refreshBadge();
        // 迷你/沉浸的参数行不走 syncAuxViews（它只在切歌/封面回调时跑），这里直接同步
        if (R.miniFmt) R.miniFmt.textContent = S.fmt;
        if (R.immFmt) R.immFmt.textContent = S.fmt;
        // V4.3.19：切歌格式 OSD（FLAC · 24bit · 96kHz · ASIO/重采样 一目了然）
        if (AM.showFmtOsd && parts.length) {
          // dsdMode/dop 是引擎全局设置不是当前曲目状态——只在当前曲目真是 DSD 时才显示
          var isDsd = data.codec && /dsd/i.test(String(data.codec));
          var osdTxt = S.fmt +
            (data.backend === 'asio' ? ' · ASIO' : data.backend ? ' · WASAPI' : '') +
            (isDsd && data.dsdMode === 'native' ? ' · Native DSD' : isDsd && data.dop ? ' · DoP' : '') +
            (data.resampled ? ' · 重采样至 ' + Math.round((data.sampleRate || 0) / 100) / 10 + 'kHz' : '');
          AM.showFmtOsd(osdTxt);
        }
      }
    });
    // V4.4.1：共享播放链路状态——停止/引擎死亡时清除音质徽标，避免残留上一曲格式
    document.addEventListener('annie-chain-state', function (e) {
      var phase = e.detail && e.detail.phase;
      if (phase !== 'stopped' && phase !== 'engine-dead') return;
      // V4.4.7（PR#6）：不再清空音质徽标。引擎 format 事件边沿触发，清空后同格式的
      // 下一首不会补发 → 徽标消失且要重启才回来。这里只回填上一次已知格式。
      if (!S.fmt) S.fmt = _lastFmt;
      refreshBadge();
      if (R.miniFmt && S.fmt) R.miniFmt.textContent = S.fmt;
      if (R.immFmt && S.fmt) R.immFmt.textContent = S.fmt;
    });
    // state.currentPath 变化（playAt 触发后无专用事件）——轮询兜底 + 主题切换时刷新
    var lastPath = null, lastPlaying = null, lastQIndex = -1;
    /* 队列里同一首歌可能有多条（「下一首播放」插入的重复项）：切到第二条同曲时 currentPath 不变，
       轮询的「路径变了」分支不会触发，高亮会停在第一条上。这里单独按 state.index 兜底刷新高亮 */
    function syncQueueCur() {
      if (S.qTab === 'cmt') return;
      try { if (S.qOn && R.qDrawer && !amQueueCurUpdate(R.qDrawer)) renderQueuePanel(R.qDrawer); } catch (e1) { }
      try { if (S.immQOn && R.immQ && S.imm && !amQueueCurUpdate(R.immQ)) renderQueuePanel(R.immQ); } catch (e2) { }
      try { if (S.miniQOn && R.miniQ && S.mini && !amQueueCurUpdate(R.miniQ)) renderQueuePanel(R.miniQ); } catch (e3) { }
    }
    window.__annieQueueSync = syncQueueCur;   // 供 player.js 的 playAt 起播后立即刷新（见下）
    /* 队列顺序整体变了（切随机播放洗牌等）→ 重建已打开的面板 */
    window.__annieQueueRefresh = function () {
      try { if (S.qOn && R.qDrawer) renderQueuePanel(R.qDrawer); } catch (e1) { }
      try { if (S.immQOn && R.immQ && S.imm) renderQueuePanel(R.immQ); } catch (e2) { }
      try { if (S.miniQOn && R.miniQ && S.mini) renderQueuePanel(R.miniQ); } catch (e3) { }
    };
    /* 从某个列表开始播放（点歌/歌单）→ 重建面板并定位到当前曲 */
    window.__annieQueueJumpCur = function () {
      S._qJumpCur = true;
      window.__annieQueueRefresh();
    };
    /* 同一列表里换一首点播：不重建，只把当前行滚进可视区（已经看得见就不动） */
    window.__annieQueueScrollCur = function () {
      try {
        if (!S.qOn || !R.qDrawer) return;
        var list = R.qDrawer.querySelector('.am-q-list');
        if (!list) return;
        var cur = list.querySelector('.am-q-row.cur');
        if (!cur) return;
        var lr = list.getBoundingClientRect(), cr = cur.getBoundingClientRect();
        if (cr.top >= lr.top - 1 && cr.bottom <= lr.bottom + 1) return;
        var want = list.scrollTop + (cr.top - lr.top) - (list.clientHeight - cur.offsetHeight) / 2;
        qSmoothScroll(list, want);
      } catch (e) { }
    };
    setInterval(function () {
      if (!window.annieTheme || annieTheme.current !== 'am' || !S.mounted) return;
      if (state.playing !== lastPlaying) { // V4.4：播放/暂停态变化即持久化（恢复时按此决定起播还是暂停）
        lastPlaying = state.playing;
        writeResumeMeta();
      }
      if (state.currentPath !== lastPath) {
        lastPath = state.currentPath; lastQIndex = state.index; refresh();
        writeResumeMeta();   // V4.4：切歌即存队列快照与索引
        resetResumePos(state.currentPath); // 新曲位置键归零（此刻 S.pos 仍是旧曲值）
        // V4.4：任何打开的队列面板随切歌刷新（评论页签不打断，历史/待播更新当前行高亮）
        if (S.qTab !== 'cmt') {
          if (S.qOn && R.qDrawer && !amQueueCurUpdate(R.qDrawer)) renderQueuePanel(R.qDrawer);
          if (S.immQOn && R.immQ && S.imm && !amQueueCurUpdate(R.immQ)) renderQueuePanel(R.immQ);
          if (S.miniQOn && R.miniQ && S.mini && !amQueueCurUpdate(R.miniQ)) renderQueuePanel(R.miniQ);
        }
        // V4.1：切歌后自动定位到当前播放行（随机/顺序播放跳转到远处时滚动跟随；
        // 行已在可视区则不打扰；流媒体与专辑/文件夹网格视图跳过）
        var p2 = state.currentPath;
        if (p2 && !state.currentStream && S.view !== 'stream'
            && !(S.view === 'albums' && !S.albumKey) && !(S.view === 'folders' && !S.folderPath)
            && currentTracks().some(function (t) { return t.path === p2; })) {
          /* V4.4.9：用户刚手动滚动过（1.5s 内）就不强制定位，避免打断浏览 */
          if (Date.now() - (S._userScrollAt || 0) > 1500) scrollRowIntoView(p2, { auto: true });
        } else if (p2 && state.currentStream && (S.view === 'stream' || S.view.indexOf('spl:') === 0)
            && AM.scrollStreamRowIntoView) {
          // V4.4：流媒体切歌终点校正——playStreamAt 的 smooth 滚动会被 refresh 链里
          // restoreScrollAround 的瞬时 scrollTop 恢复掐断在半路（首次播放「定位乱跳」根因之一），
          // 这里在全部重建落定后补一次（行已可见则不打扰）
          AM.scrollStreamRowIntoView(true);
        }
      } else if (state.index !== lastQIndex) {
        /* 同一首歌的多条重复项之间切换：路径不变，只有 index 变 —— 只刷高亮，不做整套 refresh */
        lastQIndex = state.index;
        syncQueueCur();
      }
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
  /* V3.5.17：实时频谱可视化条——引擎 10Hz 推 32 频段，rAF 插值平滑绘制 */
  var vizBands = new Float32Array(32);
  var vizSmooth = new Float32Array(32);
  var vizAccA = '', vizAccB = '', vizColorAt = 0;
  /* V4.3.17：配色模式——accent 主题强调色 / cover 封面双色 / coverMulti 封面多色 / rainbow 彩虹频段 / heat 幅度热成像 */
  /* 媒体键 / 系统浮层按钮 → 本体的播放控制 */
  try {
    if (window.mine && window.mine.onSmtcButton) {
      window.mine.onSmtcButton(function (txt) {
        try {
          var mm = /"button":"(\w+)"/.exec(String(txt || ''));
          var b = mm && mm[1];
          if (!b) return;
          if (b === 'play' || b === 'pause') { if (R.btnPlay) R.btnPlay.click(); }
          else if (b === 'next') { if (R.btnNext) R.btnNext.click(); }
          else if (b === 'previous') { if (R.btnPrev) R.btnPrev.click(); }
        } catch (e5) { }
      });
    }
  } catch (e6) { }
  var vizMode = 'cover', vizCoverSrc = null, vizPal = null, vizRainbowW = 0, vizRainbowGrad = null;
  if (window.mine && window.mine.onEngineEvent) {
    window.mine.onEngineEvent(function (ev, d) {
      if (ev === 'spectrum' && d && d.bands) { for (var i = 0; i < 32; i++) vizBands[i] = d.bands[i] || 0; }
    });
  }
  function vizHeatColor(t) { // 幅度热成像：安静冷蓝 → 爆棚白金
    return 'hsl(' + (210 - 170 * t).toFixed(0) + ',90%,' + (45 + 27 * t).toFixed(0) + '%)';
  }
  function vizLoop() {
    requestAnimationFrame(vizLoop);
    var cv = R.vizBar;
    if (!cv || !S.mounted || document.hidden) return;
    if (window.annieTheme && annieTheme.current !== 'am') return;
    /* 取色轮询放在「频谱条是否显示」判断之前：主频谱条隐藏或在沉浸模式时也要更新 vizPal，
       否则氛围面板的 L/R 与频谱会一直用强调色 */
    var now = Date.now();
    if (now - vizColorAt > 1000) { // 强调色/模式/封面 1s 轮询（支持自定义强调色与切歌实时切换）
      vizColorAt = now;
      var cs = getComputedStyle(document.getElementById('am-root'));
      vizAccA = cs.getPropertyValue('--am-accent').trim() || '#fa2d55';
      vizAccB = cs.getPropertyValue('--am-accent-2').trim() || '#ff5c7a';
      vizMode = (window.annieSettings && annieSettings.ui.amVizColor) || 'cover';
      var src = (R.npCover && R.npCover.getAttribute('src')) || '';
      if (src !== vizCoverSrc) {
        vizCoverSrc = src; vizPal = null;
        if (src && window.amVizColor) {
          (function (u) { amVizColor.analyze(u, function (p) { if (vizCoverSrc === u) vizPal = p; }); })(src);
        }
      }
    }
    if (window.annieSettings && annieSettings.ui.amViz === false) {
      if (cv.style.display !== 'none') cv.style.display = 'none';
      var _r0 = document.getElementById('am-root'); if (_r0) _r0.classList.add('am-viz-off');
      return;
    }
    var _r1 = document.getElementById('am-root'); if (_r1) _r1.classList.remove('am-viz-off');
    if (cv.style.display === 'none') cv.style.display = '';
    /* V4.4.7：取色/模式轮询必须排在「频谱条有没有尺寸」之前——沉浸模式里 .am-vizbar 是
       display:none（宽高 0），原来在这儿就 return 了，氛围模式面板的配色会永远停在
       进沉浸前那一首（表现：沉浸里切歌，面板频谱色不变） */
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== w * 2) { cv.width = w * 2; cv.height = h * 2; } // 2x 高清
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    var grad = null;
    if (vizMode !== 'heat') {
      grad = ctx.createLinearGradient(0, 0, cv.width, 0);
      if (vizMode === 'rainbow') {
        if (!vizRainbowGrad || vizRainbowW !== cv.width) { // 彩虹频段渐变按宽度缓存
          vizRainbowW = cv.width; vizRainbowGrad = grad;
          var hues = [265, 230, 200, 160, 110, 55, 15]; // 低频紫 → 高频红
          for (var hi = 0; hi < hues.length; hi++) vizRainbowGrad.addColorStop(hi / (hues.length - 1), 'hsl(' + hues[hi] + ',85%,58%)');
        }
        grad = vizRainbowGrad;
      } else if (vizMode === 'coverMulti' && vizPal && vizPal.stops && vizPal.stops.length >= 2) {
        for (var si = 0; si < vizPal.stops.length; si++) grad.addColorStop(si / (vizPal.stops.length - 1), vizPal.stops[si]);
      } else if ((vizMode === 'cover' || vizMode === 'coverMulti') && vizPal) {
        grad.addColorStop(0, vizPal.vizPrimary || vizPal.primary);
        grad.addColorStop(1, vizPal.vizAccent || vizPal.accent);
      } else { // accent 模式 / 封面取色失败（无封面、黑白封面、CORS 被拦）回落
        grad.addColorStop(0, vizAccA); grad.addColorStop(1, vizAccB);
      }
      ctx.fillStyle = grad;
    }
    var n = 32, bw = cv.width / n;
    for (var i = 0; i < n; i++) {
      /* V4.4.8：引擎低频若干条 band 是同一个值（bin 重复），整段等高很死板；
         按「连续相同值」的段做线性爬升 0.55 → 1.0，视觉上才有层次 */
      var rStart = i, rEnd = i, rStep;
      while (rStart > 0 && Math.abs(vizBands[rStart - 1] - vizBands[i]) < 0.0005) rStart--;
      while (rEnd < n - 1 && Math.abs(vizBands[rEnd + 1] - vizBands[i]) < 0.0005) rEnd++;
      var rLen = rEnd - rStart + 1;
      /* V4.4.8：引擎低频若干条 band 是同一个值（bin 重复），整段等高很死板；
         按「连续相同值」的段做线性爬升 0.55 → 1.0，视觉上才有层次 */
      var rStart = i, rEnd = i, rStep;
      while (rStart > 0 && Math.abs(vizBands[rStart - 1] - vizBands[i]) < 0.0005) rStart--;
      while (rEnd < n - 1 && Math.abs(vizBands[rEnd + 1] - vizBands[i]) < 0.0005) rEnd++;
      var rLen = rEnd - rStart + 1;
      var target = vizBands[i];
      if (rLen > 1) {
        rStep = (i - rStart) / (rLen - 1);
        /* 峰值缓慢滑动：同一段里的拾弧不是死的，看着有呼吸感 */
        var phM = (performance.now() / 2600) % 1;
        rStep = (rStep * 0.7 + phM * 0.3) % 1;
        target = target * (0.50 + 0.50 * rStep);
        /* 每根柱子带一点相位摆动，同一段里也不会齐刷刷 */
        target = Math.min(1, target * (1 + 0.12 * Math.sin(performance.now() / 170 + i * 1.9)));
      }
      if (rLen > 1) {
        rStep = (i - rStart) / (rLen - 1);
        /* 峰值缓慢滑动：同一段里的拾弧不是死的，看着有呼吸感 */
        var phM = (performance.now() / 2600) % 1;
        rStep = (rStep * 0.7 + phM * 0.3) % 1;
        target = target * (0.50 + 0.50 * rStep);
        /* 每根柱子带一点相位摆动，同一段里也不会齐刷刷 */
        target = Math.min(1, target * (1 + 0.12 * Math.sin(performance.now() / 170 + i * 1.9)));
      }
      var kRise = 0.30 + ((i * 13) % 5) * 0.075, kFall = 0.14 + ((i * 37) % 7) * 0.028;
      vizSmooth[i] += (target - vizSmooth[i]) * (target > vizSmooth[i] ? kRise : kFall); // 帧间插值
      var bh = Math.max(2, vizSmooth[i] * (cv.height - 4));
      if (vizMode === 'heat') ctx.fillStyle = vizHeatColor(Math.min(1, vizSmooth[i]));
      ctx.globalAlpha = 0.35 + vizSmooth[i] * 0.6;
      ctx.fillRect(i * bw + 1, cv.height - bh, bw - 2, bh);
    }
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(vizLoop);

  function mount() {
    if (!S.mounted) {
      build();
      buildQDrawer(document.getElementById('am-root')); // V4.4：主界面待播清单抽屉
      bindGlobal();
      patchStreamPlayNext();
      S.mounted = true;
      restoreResume(); // V4.4：重启恢复上次播放（曲目/队列/进度，本地+流媒体）
      // V4.1：主界面入场错峰动画（仅首次挂载；1s 后移除类，避免后续 DOM 重建重放）
      var root0 = document.getElementById('am-root');
      if (root0) { root0.classList.add('am-enter'); setTimeout(function () { root0.classList.remove('am-enter'); }, 1000); }
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
