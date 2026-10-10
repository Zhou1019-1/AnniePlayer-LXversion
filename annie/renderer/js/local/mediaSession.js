/* ============================================================
 * SMTC 系统媒体控制（V3.5.18）
 * Chromium Media Session API：有 <audio> 出声的场景生效。
 * 控制动作复用 UI 按钮点击，保证本地/流媒体/播放模式逻辑完全一致。
 * ============================================================ */
(function () {
  function setMeta(m) {
    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: m.title || '未知曲目',
          artist: m.artist || '',
          album: m.album || '',
          artwork: m.cover ? [{ src: m.cover }] : [],
        });
      }
    } catch (e) { }
  }

  function clickBtn(id) { const b = document.getElementById(id); if (b) b.click(); }
  const bind = (action, fn) => { try { if ('mediaSession' in navigator) navigator.mediaSession.setActionHandler(action, fn); } catch (e) { } };
  const doPlay = () => { if (window.state && !state.playing) clickBtn('btn-play'); };
  const doPause = () => { if (window.state && state.playing) clickBtn('btn-play'); };
  const doPrev = () => clickBtn('btn-prev');
  const doNext = () => clickBtn('btn-next');
  bind('play', doPlay);
  bind('pause', doPause);
  bind('previoustrack', doPrev);
  bind('nexttrack', doNext);
  bind('stop', () => clickBtn('btn-stop'));
  // 系统浮层拖动进度条 → 绝对 seek（复用方向键 seek 的 seekPending 保护模式）
  const doSeek = (sec) => {
    if (!window.state || !state.currentPath || sec == null) return;
    const target = (state.currentCue ? state.currentCue.start : 0) + Math.max(0, sec);
    state.seekPending = true;
    state.seekTarget = state.currentCue ? target - state.currentCue.start : target;
    clearTimeout(state.seekTimer);
    state.seekTimer = setTimeout(() => { state.seekPending = false; }, 10000);
    window.mine.engine('seek', { seconds: target }, 30000)
      .catch(() => { state.seekPending = false; clearTimeout(state.seekTimer); });
  };
  bind('seekto', (d) => doSeek(d && d.seekTime));

  function setPlaying(playing) {
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) { }
  }
  // 系统浮层进度条（Windows 不显示但 macOS/部分环境用）
  function setPosition(pos, dur) {
    try {
      if ('mediaSession' in navigator && dur > 0 && pos >= 0 && pos <= dur + 0.5) {
        navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(pos, dur), playbackRate: 1 });
      }
    } catch (e) { }
  }

  window.annieSMTC = { setMeta, setPlaying, setPosition };
})();
