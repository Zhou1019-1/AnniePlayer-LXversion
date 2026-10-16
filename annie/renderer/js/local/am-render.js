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

  /* ================= 播放模式 / 播放定时（仅本地播放生效） ================= */
  function syncModeBtn() {
    if (!R.btnMode || !window.anniePlayMode) return;
    var inf = window.anniePlayMode.info();
    R.btnMode.textContent = inf.icon;
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
    R.immBtnLyr = el('button', 'am-imm-btn', '💬'); R.immBtnLyr.title = '歌词（再点收起）';
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
    if (!R.immVinyl) { _crownDragBase = null; return; }
    _crownDragBase = null;
    var dir = to >= from ? 1 : -1;
    var burst = dir * Math.min(540, 120 + Math.abs(to - from) * 8); // 跳得越远甩得越多，上限一圈半
    _vinylSeek = { t0: performance.now(), base: _crownOffset, delta: burst };
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
    var bExit = el('button', 'am-tbtn', '⤡');
    bExit.title = '退出沉浸模式';
    bExit.onclick = function () { toggleImmersive(false); };
    cb.appendChild(bExit);
      /* 沉浸界面最小化（与迷你模式同一入口 window.mine.winMin）
     图标不用字形：em dash 太宽、U+2212 太窄，且字形长度与粗细绑死没法单独调；
     改用 CSS 画一条横线，长度 .78em、粗细 .1em，颜色跟随按钮。 */
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
    ov.appendChild(cb);

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
    return !!document.querySelector('#am-root .am-pop.on');
  }
  function immGoIdle() {
    var root = immRoot();
    if (!root || !S.imm || immPopOpen() || S.immQOn) return; // 弹层/待播面板交互中不藏
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
    if (cfg.sr > 0 && R.immLyrBox) {
      requestAnimationFrame(function () {
        if (!R.immLyrBox) return;
        var v = cfg.sr * Math.max(0, R.immLyrBox.scrollHeight - R.immLyrBox.clientHeight);
        (AM.progScrollTop || function (b, x) { b.scrollTop = x; })(R.immLyrBox, v);
      });
    }
  }
  function toggleImmersive(force) {
    var want = force !== undefined ? force : !S.imm;
    if (want === !!S.imm) return;
    if (want && S.mini) { exitMini(); } // 沉浸与迷你互斥
    if (!want && R.imm) saveImmLayout(); // V4.4：退出沉浸前保存当前样式的布局
    buildImmersive();
    S.imm = want;
    if (want) immStartCursorWatch(); else immStopCursorWatch(); // 静止自动隐藏鼠标随沉浸进出
    if (want && R.immVinyl) vinylStartSpin(); // 复用旧沉浸层（buildImmersive 早退）时重启盘体 rAF；退出后循环靠 S.imm 自停
    // V4.4：沉浸模式真全屏（设置 → AM 界面 开关；退出沉浸无条件复位，非全屏时为无害空操作）
    try {
      var fsOn = !!(window.annieSettings && annieSettings.ui && annieSettings.ui.amImmFullscreen);
      if (window.mine && window.mine.winFullScreen && (want ? fsOn : true)) window.mine.winFullScreen(want && fsOn);
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
    if (on && S.imm) { renderQueuePanel(R.immQ); immShowChrome(); } // 打开队列即退出静止隐藏态
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
    if (on) renderQueuePanel(R.qDrawer);
  }
  AM.toggleMainQueue = toggleMainQueue;
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
    R.btnQBadge.textContent = n > 99 ? '99+' : String(n);
    R.btnQBadge.style.display = n > 0 ? '' : 'none';
  }
  /* 抽屉开着时的轻刷新：切歌/队列增删后更新高亮与角标（仅 queue 页签需要，评论/历史各自有事件或手动切回） */
  function refreshQDrawerIfOpen() {
    refreshQBadge();
    if (S.qOn && R.qDrawer && S.qTab !== 'cmt') renderQueuePanel(R.qDrawer);
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
        localStorage.setItem(RESUME_META, JSON.stringify({
          v: 1, kind: 'local', idx: state.index, playing: !!state.playing, path: state.currentPath,
          title: (state.queue[state.index] && state.queue[state.index].name) || '',
          paths: state.queue.map(function (t) { return t && t.path; }).filter(Boolean)
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
    showResumePrompt(meta, pos);
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
      var tracks = (meta.paths || []).map(function (p) { return byPath ? byPath.get(p) : null; }).filter(Boolean);
      var idx = -1;
      tracks.forEach(function (t, i) { if (t.path === meta.path) idx = i; });
      if (idx < 0 || !tracks.length) return; // 曲目已不在媒体库（移动/移除）→ 放弃恢复
      state.queue = tracks;
      state.queueCtx = 'list'; // 手动恢复的队列不视为全库（全文件顺序模式不越权接管）
      _resumePause = !meta.playing;
      playAt(idx, pos);
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
  function immCoverCrossfade(url) {
    var img = R.immCover;
    if (!img) return;
    var old = img.getAttribute('src') || '';
    var nu = url || '';
    if (old === nu) return;
    if (!old || !nu) { img.classList.remove('am-cov-in'); swapCover(img, nu || null); return; }
    var host = img.parentElement;
    var ghost = img.cloneNode(false);
    ghost.removeAttribute('id');
    ghost.className += ' am-imm-cov-ghost';
    host.appendChild(ghost);
    img.classList.remove('am-swap', 'am-cov-in');
    img.src = nu;
    void img.offsetWidth;
    img.classList.add('am-cov-in');
    void ghost.offsetWidth;
    ghost.classList.add('am-cov-out');
    setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 560);
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
  function swapAtmosphere(url) {
    var root = document.getElementById('am-root');
    if (!root || url === _bgLast) return;
    _bgLast = url;
    root.classList.add('am-bgout');
    clearTimeout(_bgSwapT);
    _bgSwapT = setTimeout(function () {
      if (url) { root.style.setProperty('--am-bgimage', 'url("' + url + '")'); root.classList.remove('am-nobg'); }
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
      var root = document.getElementById('am-root');
      if (root) root.classList.toggle('am-lyrcover-has', !!url);
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
  }
  function refreshBadge() {
    if (!R.npBadge) return;
    R.npBadge.textContent = S.fmt;
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
    swapNpText(title, artist + (album ? ' — ' + album : ''));
    if (streamCover) {
      // 流媒体：封面是 URL，直接用（不经 meta 解析）
      swapCover(R.npCover, streamCover);
      swapAtmosphere(streamCover);
      syncAuxViews();
    } else {
      var srcPath = (state.currentCue && state.currentCue.src) ||
                    (state.currentIso && state.currentIso.src) || (t && t.path);
      if (srcPath) (t ? albumCover : ensureCover).call(null, t || srcPath, function (url) {
        if (state.currentPath !== p) return;
        swapCover(R.npCover, url || null);
        swapAtmosphere(url || null);
        syncAuxViews();
      });
      else { swapCover(R.npCover, null); swapAtmosphere(null); }
      syncAuxViews();
    }
    loadLyrics(state.currentStream ? state.currentPath : ((state.currentCue && state.currentCue.src) || (t && t.path) || null), !!state.currentStream);
  }
  function refreshTransport() {
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
      S.fmt = '';
      refreshBadge();
      if (R.miniFmt) R.miniFmt.textContent = '';
      if (R.immFmt) R.immFmt.textContent = '';
    });
    // state.currentPath 变化（playAt 触发后无专用事件）——轮询兜底 + 主题切换时刷新
    var lastPath = null, lastPlaying = null;
    setInterval(function () {
      if (!window.annieTheme || annieTheme.current !== 'am' || !S.mounted) return;
      if (state.playing !== lastPlaying) { // V4.4：播放/暂停态变化即持久化（恢复时按此决定起播还是暂停）
        lastPlaying = state.playing;
        writeResumeMeta();
      }
      if (state.currentPath !== lastPath) {
        lastPath = state.currentPath; refresh();
        writeResumeMeta();   // V4.4：切歌即存队列快照与索引
        resetResumePos(state.currentPath); // 新曲位置键归零（此刻 S.pos 仍是旧曲值）
        // V4.4：任何打开的队列面板随切歌刷新（评论页签不打断，历史/待播更新当前行高亮）
        if (S.qTab !== 'cmt') {
          if (S.qOn && R.qDrawer) renderQueuePanel(R.qDrawer);
          if (S.immQOn && R.immQ && S.imm) renderQueuePanel(R.immQ);
          if (S.miniQOn && R.miniQ && S.mini) renderQueuePanel(R.miniQ);
        }
        // V4.1：切歌后自动定位到当前播放行（随机/顺序播放跳转到远处时滚动跟随；
        // 行已在可视区则不打扰；流媒体与专辑/文件夹网格视图跳过）
        var p2 = state.currentPath;
        if (p2 && !state.currentStream && S.view !== 'stream'
            && !(S.view === 'albums' && !S.albumKey) && !(S.view === 'folders' && !S.folderPath)
            && currentTracks().some(function (t) { return t.path === p2; })) {
          scrollRowIntoView(p2, { auto: true });
        } else if (p2 && state.currentStream && (S.view === 'stream' || S.view.indexOf('spl:') === 0)
            && AM.scrollStreamRowIntoView) {
          // V4.4：流媒体切歌终点校正——playStreamAt 的 smooth 滚动会被 refresh 链里
          // restoreScrollAround 的瞬时 scrollTop 恢复掐断在半路（首次播放「定位乱跳」根因之一），
          // 这里在全部重建落定后补一次（行已可见则不打扰）
          AM.scrollStreamRowIntoView(true);
        }
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
    if (window.annieSettings && annieSettings.ui.amViz === false) { if (cv.style.display !== 'none') cv.style.display = 'none'; return; }
    if (cv.style.display === 'none') cv.style.display = '';
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== w * 2) { cv.width = w * 2; cv.height = h * 2; } // 2x 高清
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
        grad.addColorStop(0, vizPal.primary); grad.addColorStop(1, vizPal.accent);
      } else { // accent 模式 / 封面取色失败（无封面、黑白封面、CORS 被拦）回落
        grad.addColorStop(0, vizAccA); grad.addColorStop(1, vizAccB);
      }
      ctx.fillStyle = grad;
    }
    var n = 32, bw = cv.width / n;
    for (var i = 0; i < n; i++) {
      var target = vizBands[i];
      vizSmooth[i] += (target - vizSmooth[i]) * 0.35; // 帧间插值
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
