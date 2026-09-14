'use strict';
/* ============================================================================
 * 播放模式 + 播放定时（SVLX V3.2，仅本地播放生效）
 *   - 播放模式：全文件顺序 / 列表内顺序 / 随机（全库）/ 列表内随机 / 单曲循环
 *     · 全文件顺序仅在"歌曲"全库视图播放时生效（queueCtx==='all'），否则按列表内顺序
 *     · 流媒体续播走 streaming.js 的 playNext，本模块一律不接管（state.currentStream 直接放行）
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

  function setMode(id) {
    state.playMode = id;
    try { localStorage.setItem(LS_MODE, id); } catch (e) { }
  }
  try {
    var saved = localStorage.getItem(LS_MODE);
    if (saved && MODES.some(function (m) { return m.id === saved; })) state.playMode = saved;
    else state.playMode = 'list-seq';
  } catch (e) { state.playMode = 'list-seq'; }

  function toast(msg) { try { if (typeof proToast === 'function') proToast(msg); } catch (e) { } }
  function allTracks() { return (typeof state !== 'undefined' && state.library && state.library.tracks) || []; }

  function stopPlayback(msg) {
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
      // 仅本地播放生效：正在播流媒体时不执行
      if (state.currentStream) { window.annieSleepTimer.clear(); toast('播放定时仅对本地播放生效，本次未执行'); return; }
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
})();
