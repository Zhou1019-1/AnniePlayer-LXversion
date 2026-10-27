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

  /* ⚠️ 2026-10-22 随机 / 顺序播放的正确实现：
     · 搜索列表 S.stResults 是「数据源」，**永远不动**
     · S._playList 是「当前播放队列」，随机模式时换成打乱副本
     · 切回顺序模式时，要把 _playList 还原成 stResults，并且
       把 stIndex 重新定位到「当前这首歌在 stResults 里的下标」，
       这样下一首就是原歌单里的下一首。
     · state.queue 是给本地曲库用的另一套，这里只管在线列表。 */
  /* ⚠️ 2026-10-22：切换播放模式后必须刷新所有相关视图，
     否则「待播清单」弹层还显示旧的队列顺序（用户反馈「待播清单没变」）。 */
  function refreshAllViews(AM) {
    try { if (AM.renderView) AM.renderView(); } catch (e) { }
    // ⚠️ 2026-10-22：待播清单实时刷新（用户反馈「打开时切换随机不实时变化」）。
    //    待播清单是 R.qDrawer 抽屉（S.qOn 表示是否展开），不是普通 .am-pop 弹层，
    //    之前的判断条件完全没命中，所以从来没刷新过。
    //    这里直接调 AM.refreshQueuePanel()（am-render.js 导出），它会检查 S.qOn/immQ 状态后重绘。
    try { if (AM.refreshQueuePanel) AM.refreshQueuePanel(); } catch (e) { }
    // 兜底：直接操作抽屉重新渲染（防止 refreshQueuePanel 未就绪）
    try {
      var R = AM._R;
      if (R && R.qDrawer && window.__annieAMInternal && AM.S && AM.S.qOn) {
        if (AM.renderQueuePanelDirect) AM.renderQueuePanelDirect(R.qDrawer);
      }
    } catch (e) { }
    try { window.dispatchEvent(new CustomEvent("annie-queue-changed")); } catch (e) { }
  }

  function currentSong() {
    try {
      var st = window.state;
      if (st && st.currentStream && st.currentStream.song) return st.currentStream.song;
    } catch (e) { }
    return null;
  }
  function sameSong(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    function idOf(s) {
      if (s.songmid != null && s.songmid !== '') return String(s.songmid);
      if (s.hash) return String(s.hash);
      if (s.id != null) return String(s.id);
      return '';
    }
    var x = idOf(a), y = idOf(b);
    return !!x && x === y;
  }
  function indexOfSong(list, song) {
    if (!list || !song) return -1;
    for (var i = 0; i < list.length; i++) { if (sameSong(list[i], song)) return i; }
    return -1;
  }
  /* 切到随机：把当前队列打乱成一份新副本（不改 stResults） */
  function enterShuffle() {
    try {
      var AM = window.__annieAMInternal;
      if (!AM || !AM.S) return;
      var S = AM.S;
      var base = S.stResults;
      if (!base || base.length < 2) return;
      // 已经是打乱副本 → 不重复洗
      if (S._playList && S._playList !== base && S._shuffledFrom === base) return;
      var copy = base.slice();
      var cur = currentSong();
      // 洗牌（Fisher-Yates）
      for (var j = copy.length - 1; j > 0; j--) {
        var k = Math.floor(Math.random() * (j + 1));
        var tmp = copy[j]; copy[j] = copy[k]; copy[k] = tmp;
      }
      // 把当前正在播的那首放到「开头」，保证接下来的下一首是洗牌后的下一首
      if (cur) {
        var ci = indexOfSong(copy, cur);
        if (ci > 0) {
          var c = copy.splice(ci, 1)[0];
          copy.unshift(c);
          S.stIndex = 0;
        } else if (ci === 0) {
          S.stIndex = 0;
        }
      } else {
        S.stIndex = 0;
      }
      S._playList = copy;
      S._shuffledFrom = base;      // 记住来源，方便切回顺序时还原
      refreshAllViews(AM);
      toast('随机播放：队列已打乱（共 ' + copy.length + ' 首，搜索列表不变）');
    } catch (e) { }
  }
  /* 切回顺序：还原成 stResults，并把 stIndex 定位到当前歌曲的原位置 */
  function exitShuffle() {
    try {
      var AM = window.__annieAMInternal;
      if (!AM || !AM.S) return;
      var S = AM.S;
      var base = S.stResults;
      if (!base || !base.length) return;
      var cur = currentSong();
      S._playList = base;
      S._shuffledFrom = null;
      if (cur) {
        var idx = indexOfSong(base, cur);
        if (idx >= 0) S.stIndex = idx;   // ← 关键：下一首 = 原歌单里这首歌的下一首
      }
      refreshAllViews(AM);
      toast('顺序播放：已回到原列表顺序（当前第 ' + (S.stIndex + 1) + ' / ' + base.length + ' 首）');
    } catch (e) { }
  }

  function setMode(id) {
    var prev = state.playMode;
    state.playMode = id;
    try { localStorage.setItem(LS_MODE, id); } catch (e) { }
    if (prev === id) return;
    var wasRand = (prev === 'list-rand' || prev === 'all-rand');
    var isRand = (id === 'list-rand' || id === 'all-rand');
    if (!wasRand && isRand) enterShuffle();       // 顺序 → 随机：打乱副本
    else if (wasRand && !isRand) exitShuffle();   // 随机 → 顺序：还原 + 重定位
  }
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

    if (m === 'list-rand') {
      if (state.queue.length > 1) {
        var ri;
        do { ri = Math.floor(Math.random() * state.queue.length); } while (ri === state.index);
        playAt(ri);
      } else playAt(state.index);
      return true;
    }

    if (m === 'all-rand') {
      var all = allTracks();
      if (all.length) {
        state.queue = all; state.queueCtx = 'all';
        var ai = 0;
        if (all.length > 1) {
          do { ai = Math.floor(Math.random() * all.length); } while (all[ai] && all[ai].path === state.currentPath);
        }
        playAt(ai);
        return true;
      }
      return false; // 全库为空，回落调用方默认
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
