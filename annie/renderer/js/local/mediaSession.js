/* ============================================================
 * SMTC 系统媒体控制（V3.5.18）
 * 通道一（Chromium Media Session API）：有 <audio> 出声的场景生效。
 * 通道二（V4.4 AnnieFlyout 桥）：我们的音频走外部 C# 引擎，Chromium 不会把
 * Media Session 桥到 Windows SMTC（实测会话数=0）——故由 AnnieFlyout 伴侣进程
 * 自持 SMTC 会话，经 mine.flyoutPush / mine.onFlyoutCmd 双向通信。
 * 控制动作复用 UI 按钮点击，保证本地/流媒体/播放模式逻辑完全一致。
 * ============================================================ */
(function () {
  function pushFlyout(obj) { try { if (window.mine && mine.flyoutPush) mine.flyoutPush(obj); } catch (e) { } }
  var lastFlyoutMeta = null; // 冷启动兜底：开机续播的 meta 推送可能撞进 AnnieFlyout 启动窗口被吞

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
    lastFlyoutMeta = { type: 'meta', title: m.title || '', artist: m.artist || '', album: m.album || '', cover: m.cover || '' };
    pushFlyout(lastFlyoutMeta);
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
  // AnnieFlyout 桥：SMTC 按钮命令回流（与上面的媒体键动作一一对应）
  if (window.mine && mine.onFlyoutCmd) {
    mine.onFlyoutCmd((cmd) => {
      if (cmd === 'play') doPlay();
      else if (cmd === 'pause') doPause();
      else if (cmd === 'prev') doPrev();
      else if (cmd === 'next') doNext();
      else if (cmd && cmd.cmd === 'seek') doSeek(cmd.positionSec); // 弹窗进度条拖拽回流
    });
  }
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
    pushFlyout({ type: 'state', playing: !!playing, positionSec: (window.state && state.position) || 0, durationSec: (window.state && state.duration) || 0 });
  }
  // 系统浮层进度条（Windows 不显示但 macOS/部分环境用）
  function setPosition(pos, dur) {
    try {
      if ('mediaSession' in navigator && dur > 0 && pos >= 0 && pos <= dur + 0.5) {
        navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(pos, dur), playbackRate: 1 });
      }
    } catch (e) { }
    pushFlyout({ type: 'state', playing: !!(window.state && state.playing), positionSec: pos || 0, durationSec: dur || 0 });
  }

  window.annieSMTC = { setMeta, setPlaying, setPosition };
  // 冷启动兜底：3s/8s 各补推一次当前曲目 meta（幂等，撞进 AnnieFlyout 启动窗口的首推由这里兜住）
  setTimeout(function () { if (lastFlyoutMeta) pushFlyout(lastFlyoutMeta); }, 3000);
  setTimeout(function () { if (lastFlyoutMeta) pushFlyout(lastFlyoutMeta); }, 8000);
})();
