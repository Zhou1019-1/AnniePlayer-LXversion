'use strict';
/* ============================================================================
 * 播放模式 + 播放定时（SVLX V3.2，仅本地播放生效）
 *   - 播放模式：全文件顺序 / 列表内顺序 / 随机（全库）/ 列表内随机 / 单曲循环
 *     · 全文件顺序仅在"歌曲"全库视图播放时生效（queueCtx==='all'），否则按列表内顺序
 *     · 流媒体：粒子舞台/FB2K 走 streaming.js 原逻辑不接管；AM 在线队列（V4.3.5 起）
 *       联动单曲循环/随机/顺序（all-rand 按列表内随机处理，all-seq 按列表内顺序处理）
 *   - 播放定时：播完当前列表停止 / 定时 N 分钟停止 / 单曲循环 N 遍停止
 *     · repeatN 生效期间覆盖播放模式（相当于临时单曲循环），次数耗尽即停并还原
 *     · 仅对本地播放生效：定时到点时若正在播流媒体则不执行
 * ========================================================================== */
(function () {
  var LS_MODE = 'annieplayer.playmode';

  var MODES = [
    { id: 'all-seq',   icon: '⇥',  label: '全文件顺序播放', hint: '仅在"歌曲"全库视图播放时生效；其他列表播放时按列表内顺序' },
    { id: 'list-seq',  icon: '→',  label: '列表内顺序播放' },
    { id: 'all-rand',  icon: '🔀', label: '随机播放（全库）' },
    { id: 'list-rand', icon: '⤨',  label: '列表内随机播放' },
    { id: 'repeat-one', icon: '🔂', label: '单曲循环' }
  ];

  function mode() { return state.playMode || 'list-seq'; }
  function info() { return MODES.find(function (m) { return m.id === mode(); }) || MODES[1]; }

  /* V4.5：随机播放要在待播清单里看得见——随机顺序在「再播放一首歌」时由 playList 建立
     （见 annieShuffleQueueForPlay），切模式本身不动队列；播到末尾再洗一次继续。 */
  function shuffleArr(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function queueUiRefresh() {
    try { if (window.__annieQueueRefresh) window.__annieQueueRefresh(); } catch (e) { }
  }
  /* 随机播到列表末尾后再洗一次牌（只发生在自然播完时，不改用户手动排的顺序） */
  function reshuffle() {
    var q = (state.queue || []).slice();
    if (q.length < 2) return false;
    var curPath = state.currentPath || (state.queue[state.index] && state.queue[state.index].path);
    shuffleArr(q);
    if (q[0] && q[0].path === curPath) { var t = q[0]; q[0] = q[1]; q[1] = t; }   // 别又是刚播完那首
    state.queue = q;
    state.index = 0;
    return true;
  }

  /* —— 切模式时的队列语义 ——
     · 全库随机：队列换成整个媒体库并洗牌（当前曲首位）；
     · 列表内随机：队列回到「当前播放的那份列表」并洗牌（当前曲首位）；
     · 其它模式（列表顺序 / 全文件顺序 / 单曲循环）：队列回到该列表的**原始顺序**；
     · 全文件顺序保持当前列表不动（等同列表顺序，只是全文件顺序的续播语义在 nextByMode 里）。 */
  var baseList = null;   // 当前正在播放的那份列表的原始顺序（playList 传入的那份）
  function setBase(list) {
    try { baseList = (list && list.length) ? list.slice() : null; } catch (e) { baseList = null; }
  }
  window.annieSetBaseQueue = setBase;   // 供 am.js 的 playList 调用（顺序播放时也记录列表）
  /* 洗牌：当前曲留在第一行 */
  function shuffledWithCur(list) {
    var curPath = state.currentPath;
    var curEnt = null, rest = [];
    for (var i = 0; i < list.length; i++) {
      if (!curEnt && list[i] && list[i].path === curPath) curEnt = list[i];
      else rest.push(list[i]);
    }
    shuffleArr(rest);
    var q = (curEnt ? [curEnt] : []).concat(rest);
    if (!curEnt) {   // 当前曲不在这份列表里：放队首，保证清单与实际播放一致
      var old = state.queue || [], ent = null;
      for (var j = 0; j < old.length; j++) if (old[j] && old[j].path === curPath) { ent = old[j]; break; }
      if (ent) q.unshift(ent);
    }
    return q;
  }
  /* 回到列表原始顺序（保留列表外多出来的歌，排在末尾） */
  function restoreOrder() {
    var base = baseList;
    if (!base || !base.length) return false;
    var pos = new Map();
    for (var i = 0; i < base.length; i++) { var p2 = base[i] && base[i].path; if (p2 && !pos.has(p2)) pos.set(p2, i); }
    var cur = (state.queue || []).slice();
    if (!cur.length) return false;
    cur.sort(function (a, b) {
      var x = pos.has(a && a.path) ? pos.get(a && a.path) : 1e9;
      var y = pos.has(b && b.path) ? pos.get(b && b.path) : 1e9;
      return x - y;
    });
    state.queue = cur;
    var cp = state.currentPath, at = -1;
    for (var k = 0; k < cur.length; k++) if (cur[k] && cur[k].path === cp) { at = k; break; }
    state.index = at >= 0 ? at : 0;
    return true;
  }
  function setQueueTo(list, ctx) {
    state.queue = list;
    state.queueCtx = ctx || 'list';
    var cp = state.currentPath, at = -1;
    for (var k = 0; k < list.length; k++) if (list[k] && list[k].path === cp) { at = k; break; }
    state.index = at >= 0 ? at : 0;
  }
  function setMode(id) {
    state.playMode = id;
    try { localStorage.setItem(LS_MODE, id); } catch (e) { }
    if (state.currentStream) return;                 // 流媒体不走队列
    var q = state.queue || [];
    if (!q.length && !(baseList && baseList.length)) return;
    if (id === 'all-rand') {
      var lib = (allTracks() || []).slice();
      if (!lib.length) return;
      setQueueTo(shuffledWithCur(lib), 'all');
      queueUiRefresh();
      return;
    }
    var src = (baseList && baseList.length) ? baseList : q;
    if (id === 'list-rand') {
      setQueueTo(shuffledWithCur(src), 'list');
      queueUiRefresh();
      return;
    }
    /* 列表顺序 / 全文件顺序 / 单曲循环：回到这份列表的原始顺序 */
    if (restoreOrder()) queueUiRefresh();
  }

  /* 供 am.js 的 playList 调用：随机模式下从某个列表开始播放时，把队列洗成随机顺序，
     点的那一首排第一（顺序/单曲循环返回 null，保持原列表顺序；全库随机池子是整个媒体库） */
  window.annieShuffleQueueForPlay = function (list, i) {
    try {
      var m = mode();
      if (m !== 'list-rand' && m !== 'all-rand') return null;
      if (state.currentStream) return null;
      var cur = list && list[i];
      if (!cur) return null;
      var pool = (m === 'all-rand') ? ((allTracks() || []).slice()) : list.slice();
      if (!pool.length) return null;
      var rest = pool.filter(function (t) { return t && t.path !== cur.path; });
      shuffleArr(rest);
      state.queueCtx = (m === 'all-rand') ? 'all' : 'list';
      return { list: [cur].concat(rest), index: 0 };
    } catch (e) { return null; }
  };

  try {
    var saved = localStorage.getItem(LS_MODE);
    if (saved && MODES.some(function (m) { return m.id === saved; })) state.playMode = saved;
    else state.playMode = 'list-seq';
  } catch (e) { state.playMode = 'list-seq'; }

  function toast(msg) { try { if (typeof proToast === 'function') proToast(msg); } catch (e) { } }
  function allTracks() { return (typeof state !== 'undefined' && state.library && state.library.tracks) || []; }

  function stopPlayback(msg) {
    // V4.3.24：定时停止=播放会话终结，给当前曲目会话定性（暂停按钮不走这里）
    if (window.annieListenStats) window.annieListenStats.endSession();
    window.mine.engine('pause').catch(function () { });
    if (msg) toast(msg);
  }

  /* ---------------- 播放定时 ---------------- */
  // state.sleepTimer: null | {type:'queue'} | {type:'time', at:ms} | {type:'repeatN', total, played}
  var timeCheckT = 0;
  function fireChanged() {
    try { document.dispatchEvent(new CustomEvent('annie-sleeptimer-changed')); } catch (e) { }
  }
  function startTimeCheck() {
    if (timeCheckT) return;
    timeCheckT = setInterval(function () {
      var t = state.sleepTimer;
      if (!t || t.type !== 'time') return;
      if (Date.now() < t.at) return;
      // V3.5.8：定时停止对在线播放同样生效（pause 对流媒体有效）
      window.annieSleepTimer.clear();
      if (state.playing) stopPlayback('定时时间到，已停止播放');
    }, 3000);
  }
  function stopTimeCheck() { if (timeCheckT) { clearInterval(timeCheckT); timeCheckT = 0; } }

  window.annieSleepTimer = {
    set: function (cfg) {
      state.sleepTimer = cfg;
      if (cfg && cfg.type === 'time') startTimeCheck();
      fireChanged();
    },
    clear: function () { state.sleepTimer = null; stopTimeCheck(); fireChanged(); },
    get: function () { return state.sleepTimer; },
    // 剩余描述（AM 按钮 tooltip 用）
    describe: function () {
      var t = state.sleepTimer;
      if (!t) return '';
      if (t.type === 'queue') return '播完当前列表停止';
      if (t.type === 'repeatN') return '单曲循环剩余 ' + Math.max(0, t.total - t.played) + ' 遍';
      if (t.type === 'time') return '定时停止：剩余 ' + Math.max(0, Math.ceil((t.at - Date.now()) / 60000)) + ' 分钟';
      return '';
    }
  };

  /* ---------------- 按模式取下一首 ----------------
   * isAuto=true 为引擎 ended 自动续播；false 为用户手动"下一首"。
   * 返回 true = 已接管（含主动停止）；false = 走调用方默认逻辑。
   * 流媒体一律返回 false（不接管）。 */
  function nextByMode(isAuto) {
    if (state.currentStream) return false; // 流媒体不生效
    if (!state.queue || !state.queue.length) return false;
    var timer = state.sleepTimer;

    // 定时·单曲循环 N 遍：覆盖播放模式，次数耗尽即停
    if (timer && timer.type === 'repeatN') {
      timer.played++;
      if (timer.played < timer.total) { playAt(state.index); }
      else { window.annieSleepTimer.clear(); stopPlayback('单曲循环 ' + timer.total + ' 遍已播完，已停止'); }
      return true;
    }

    var m = mode();
    if (m === 'repeat-one') { playAt(state.index); return true; }

    if (m === 'list-rand' || m === 'all-rand') {
      /* V4.5：进入随机模式时队列已经洗好牌（见 setMode），这里按顺序走；
         走到末尾再洗一次从头继续（「播完当前列表停止」优先） */
      var atEndR = state.index + 1 >= state.queue.length;
      if (!atEndR) { playAt(state.index + 1); return true; }
      if (timer && timer.type === 'queue') {
        window.annieSleepTimer.clear();
        stopPlayback('当前列表已播完，已停止');
        return true;
      }
      if (reshuffle()) queueUiRefresh();
      playAt(0);
      return true;
    }

    // 顺序类（all-seq / list-seq）。all-seq 仅在全库上下文生效，否则同 list-seq。
    var atEnd = state.index + 1 >= state.queue.length;
    if (atEnd) {
      // 定时·播完当前列表停止（默认本就停在末尾，这里补提示与清理；repeat-one 永不前进，不会到这）
      if (timer && timer.type === 'queue') {
        window.annieSleepTimer.clear();
        stopPlayback('当前列表已播完，已停止');
        return true;
      }
      return false; // 默认 playAt(index+1) 越界即停
    }
    playAt(state.index + 1);
    return true;
  }

  window.annieAutoNext = function () { return nextByMode(true); };
  window.annieNextByMode = function () { return nextByMode(false); };
  window.anniePlayMode = {
    list: MODES,
    get: mode,
    info: info,
    cycle: function () {
      var i = MODES.findIndex(function (m) { return m.id === mode(); });
      setMode(MODES[(i + 1) % MODES.length].id);
      fireModeChanged();
      return info();
    },
    set: function (id) { setMode(id); fireModeChanged(); }
  };
  function fireModeChanged() {
    try { document.dispatchEvent(new CustomEvent('annie-playmode-changed')); } catch (e) { }
  }

  /* ---------------- 粒子舞台底栏播放模式按钮（V3.5.14） ---------------- */
  (function bindModeButton() {
    var btn = document.getElementById('btn-mode');
    if (!btn) return;
    function refresh() {
      var i = info();
      // V4.4：SVG 图标（ICONS/ico 由 player.js 顶层定义，本脚本后加载共享全局词法作用域）
      var icoKey = { 'all-seq': 'modeAllSeq', 'list-seq': 'modeListSeq', 'all-rand': 'modeAllRand', 'list-rand': 'modeListRand', 'repeat-one': 'modeRepeatOne' }[i.id];
      btn.innerHTML = (typeof ico === 'function' && icoKey) ? ico(icoKey, 16) : i.icon;
      btn.title = '播放模式：' + i.label + (i.hint ? '\n' + i.hint : '') + '\n（仅本地播放生效，点击切换）';
    }
    btn.addEventListener('click', function () {
      var i = window.anniePlayMode.cycle();
      toast('播放模式：' + i.label);
    });
    document.addEventListener('annie-playmode-changed', refresh);
    refresh();
  })();
})();
