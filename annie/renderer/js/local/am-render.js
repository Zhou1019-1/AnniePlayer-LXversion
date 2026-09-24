'use strict';
/* ===== am.js 拆分片：am-render.js =====
 * 状态刷新与外壳：播放状态/封面刷新、播放定时弹层、待播清单/历史/评论、沉浸模式、迷你模式、频谱条、引擎事件、挂载导出
 * 来源：am.js 原稿行 1691-1771 + 1800-2447（原样切片，零行为变更）
 * 共享变量经 window.__annieAMInternal 桥接；前向引用为转发桩，运行时解析。 */
(function () {
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
  var albumKeyOf = AM.albumKeyOf;
  var srcFileOf = AM.srcFileOf;
  var refreshPlaylists = AM.refreshPlaylists;
  var playList = AM.playList;
  var togglePlay = AM.togglePlay;
  var next = AM.next;
  var prev = AM.prev;
  var seek = AM.seek;
  var playStreamAt = AM.playStreamAt;
  var patchStreamPlayNext = AM.patchStreamPlayNext;
  var build = AM.build;
  var renderSidebar = AM.renderSidebar;
  var renderView = AM.renderView;
  var renderAmWindow = AM.renderAmWindow;
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

  /* ================= 待播清单 / 历史记录（沉浸与迷你共享） ================= */
  function renderQueuePanel(box) {
    box.innerHTML = '';
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
        list.appendChild(el('div', 'am-q-empty', '网易云热门评论 · 共 ' + (r.total || r.comments.length) + ' 条'));
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
    function addRow(coverUrl, track, title, sub, durText, cur, onclick, opts) {
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
      if (opts && opts.onRemove) {
        var del = el('button', 'am-q-del', '✕');
        del.title = '从待播清单移除';
        del.onclick = function (e) { e.stopPropagation(); opts.onRemove(); };
        row.appendChild(del);
      }
      if (opts && typeof opts.dragIdx === 'number') {
        var myIdx = opts.dragIdx;
        row.draggable = true;
        row.title = '拖拽调整顺序';
        row.addEventListener('dragstart', function (e) { qDragIdx = myIdx; try { e.dataTransfer.effectAllowed = 'move'; } catch (er) { } });
        row.addEventListener('dragover', function (e) { e.preventDefault(); row.classList.add('drag-over'); });
        row.addEventListener('dragleave', function () { row.classList.remove('drag-over'); });
        row.addEventListener('drop', function (e) {
          e.preventDefault(); row.classList.remove('drag-over');
          if (qDragIdx >= 0 && qDragIdx !== myIdx) moveQueueRow(qDragIdx, myIdx);
          qDragIdx = -1;
        });
        row.addEventListener('dragend', function () { qDragIdx = -1; });
      }
      row.onclick = onclick;
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
      list.appendChild(el('div', 'am-q-empty', '拖拽调整顺序，✕ 移除'));
      for (var i = Math.max(0, state.index); i < q.length; i++) {
        (function (t, idx) {
          var m = trackMeta(t);
          var dm = S.meta[t.path];
          addRow(null, t, m.title, m.artist + (m.album ? ' — ' + m.album : ''),
            dm && dm.duration ? fmtTime(dm.duration) : '', idx === state.index,
            function () { playAt(idx); },
            { dragIdx: idx, onRemove: function () { removeQueueRow(idx); } });
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
    var bPin = el('button', 'am-tbtn mini-pin-btn', '📌'); bPin.title = '窗口置顶（置于所有窗口之上）';
    bPin.onclick = function () { if (window.annieMiniPin) window.annieMiniPin.set(!window.annieMiniPin.get()); };
    var bExit = el('button', 'am-tbtn', '⤢'); bExit.title = '退出迷你模式'; bExit.onclick = function () { exitMini(); };
    var bClose = el('button', 'am-tbtn am-close', '✕'); bClose.title = '关闭'; bClose.onclick = function () { window.mine.winClose(); };
    wb.appendChild(bMin); wb.appendChild(bPin); wb.appendChild(bExit); wb.appendChild(bClose);
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
      if (window.annieMiniPin) window.annieMiniPin.apply(); // V3.5.15：按偏好套用置顶
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
  /* V3.5.17：实时频谱可视化条——引擎 10Hz 推 32 频段，rAF 插值平滑绘制 */
  var vizBands = new Float32Array(32);
  var vizSmooth = new Float32Array(32);
  var vizAccA = '', vizAccB = '', vizColorAt = 0;
  if (window.mine && window.mine.onEngineEvent) {
    window.mine.onEngineEvent(function (ev, d) {
      if (ev === 'spectrum' && d && d.bands) { for (var i = 0; i < 32; i++) vizBands[i] = d.bands[i] || 0; }
    });
  }
  function vizLoop() {
    requestAnimationFrame(vizLoop);
    var cv = R.vizBar;
    if (!cv || !S.mounted || document.hidden) return;
    if (window.annieTheme && annieTheme.current !== 'am') return;
    if (window.annieSettings && annieSettings.ui.amViz === false) { if (cv.style.display !== 'none') cv.style.display = 'none'; return; }
    if (cv.style.display === 'none') cv.style.display = '';
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== w * 2) { cv.width = w * 2; cv.height = h * 2; } // 2x 高清
    var now = Date.now();
    if (now - vizColorAt > 1000) { // 强调色 1s 缓存（支持自定义强调色实时切换）
      vizColorAt = now;
      var cs = getComputedStyle(document.getElementById('am-root'));
      vizAccA = cs.getPropertyValue('--am-accent').trim() || '#fa2d55';
      vizAccB = cs.getPropertyValue('--am-accent-2').trim() || '#ff5c7a';
    }
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    var grad = ctx.createLinearGradient(0, 0, cv.width, 0);
    grad.addColorStop(0, vizAccA); grad.addColorStop(1, vizAccB);
    ctx.fillStyle = grad;
    var n = 32, bw = cv.width / n;
    for (var i = 0; i < n; i++) {
      var target = vizBands[i];
      vizSmooth[i] += (target - vizSmooth[i]) * 0.35; // 帧间插值
      var bh = Math.max(2, vizSmooth[i] * (cv.height - 4));
      ctx.globalAlpha = 0.35 + vizSmooth[i] * 0.6;
      ctx.fillRect(i * bw + 1, cv.height - bh, bw - 2, bh);
    }
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(vizLoop);

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
