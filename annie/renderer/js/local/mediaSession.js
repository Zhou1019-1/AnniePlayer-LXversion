/* ============================================================
 * SMTC 系统媒体控制（V3.5.18）
 * Chromium Media Session API → Windows 系统媒体浮层：
 * 音量浮层/锁屏界面显示封面与曲目信息，键盘媒体键（⏯⏮⏭）全局控制。
 * 控制动作复用 UI 按钮点击，保证本地/流媒体/播放模式逻辑完全一致。
 * ============================================================ */
(function () {
  if (!('mediaSession' in navigator)) return;

  function setMeta(m) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: m.title || '未知曲目',
        artist: m.artist || '',
        album: m.album || '',
        artwork: m.cover ? [{ src: m.cover }] : [],
      });
    } catch (e) { }
  }

  function clickBtn(id) { const b = document.getElementById(id); if (b) b.click(); }
  const bind = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { } };
  bind('play', () => { if (window.state && !state.playing) clickBtn('btn-play'); });
  bind('pause', () => { if (window.state && state.playing) clickBtn('btn-play'); });
  bind('previoustrack', () => clickBtn('btn-prev'));
  bind('nexttrack', () => clickBtn('btn-next'));
  bind('stop', () => clickBtn('btn-stop'));
  // 系统浮层拖动进度条 → 绝对 seek（复用方向键 seek 的 seekPending 保护模式）
  bind('seekto', (d) => {
    if (!window.state || !state.currentPath || d.seekTime == null) return;
    const target = (state.currentCue ? state.currentCue.start : 0) + Math.max(0, d.seekTime);
    state.seekPending = true;
    state.seekTarget = state.currentCue ? target - state.currentCue.start : target;
    clearTimeout(state.seekTimer);
    state.seekTimer = setTimeout(() => { state.seekPending = false; }, 10000);
    window.mine.engine('seek', { seconds: target }, 30000)
      .catch(() => { state.seekPending = false; clearTimeout(state.seekTimer); });
  });

  function setPlaying(playing) {
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) { }
  }
  // 系统浮层进度条（Windows 不显示但 macOS/部分环境用）
  function setPosition(pos, dur) {
    try {
      if (dur > 0 && pos >= 0 && pos <= dur + 0.5) {
        navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(pos, dur), playbackRate: 1 });
      }
    } catch (e) { }
  }

  window.annieSMTC = { setMeta, setPlaying, setPosition };
})();
