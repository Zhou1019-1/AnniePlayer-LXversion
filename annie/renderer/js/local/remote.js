/* 局域网手机遥控·渲染层桥（V4.3.12，脑暴 9.1）
 * 主进程 remote.js 起 HTTP+SSE 服务；本桥负责：
 *   1) 每 700ms 推一份状态快照（封面 dataURL 只在切歌时携带，省 IPC/流量）
 *   2) 执行遥控指令（播放控制复用 AM 模块桥，语义与界面按钮完全一致）
 * 主进程侧未开启遥控时 pushState 为空转，开销可忽略。 */
(function () {
  'use strict';
  if (!window.mine || !window.mine.onRemoteCmd) return;
  var lastCoverFor = null;
  var lastCover = '';
  var metaFetching = {}; // 防重复拉取
  var coverCache = {};   // path -> dataURL|''（metaBatch 批量标签不含封面，封面要单拉 meta()）

  function fetchCover(path) {
    if (coverCache[path] !== undefined) return;
    coverCache[path] = ''; // 占位防重入
    window.mine.meta(path).then(function (mm) {
      coverCache[path] = (mm && mm.cover) || '';
    }).catch(function () { });
  }

  function nameFromPath(p) {
    var s = String(p || '').split(/[\\/]/).pop() || '';
    return s.replace(/\.[^.]+$/, '');
  }

  // player.js 的 state 是顶层 const（全局词法环境，不在 window 上），用 typeof 安全取
  function getState() {
    try { if (typeof state !== 'undefined' && state) return state; } catch (e) { }
    return window.state || {};
  }

  function curTrack() {
    var st = getState();
    if (st.currentStream) {
      return {
        title: st.currentStream.title || '', artist: st.currentStream.artist || '',
        album: st.currentStream.album || '', cover: st.currentStream.cover || '',
        key: 'stream|' + (st.currentStream.provider || '') + '|' + (st.currentStream.title || ''),
      };
    }
    var t = st.queue && st.queue[st.index];
    if (!t) return null;
    // 本地曲目：标题/艺人/专辑/封面都在 S.meta（metaBatch）里，track 对象本身只有 path
    var AM = window.__annieAMInternal || {};
    var S = AM.S || {};
    var m = t.path && S.meta ? S.meta[t.path] : null;
    var ok = m && !m.fail;
    // 当前曲还没标签：后台拉一次（下轮推送就有了），本轮先退化为文件名
    if (!ok && t.path && window.mine.meta && !metaFetching[t.path]) {
      metaFetching[t.path] = 1;
      window.mine.meta(t.path).then(function (mm) {
        delete metaFetching[t.path];
        if (mm && S.meta) S.meta[t.path] = mm;
      }).catch(function () { delete metaFetching[t.path]; });
    }
    // 封面：metaBatch 不含，单拉 meta()（带缓存，下轮推送就有了）
    if (t.path && window.mine.meta) fetchCover(t.path);
    var cover = (t.path && coverCache[t.path]) || (ok && m.cover) || t.cover || '';
    return {
      title: (ok && m.title) || t.title || nameFromPath(t.path),
      artist: (ok && m.artist) || t.artist || '',
      album: (ok && m.album) || t.album || '',
      cover: cover,
      key: t.path || '',
    };
  }

  function snapshot() {
    var st = getState();
    var AM = window.__annieAMInternal || {};
    var S = AM.S || {};
    var t = curTrack();
    var cover = '';
    if (t) {
      if (t.key !== lastCoverFor) { lastCoverFor = t.key; lastCover = t.cover || ''; }
      else if (!lastCover && t.cover) lastCover = t.cover; // 封面异步后到，补进缓存
      cover = lastCover;
    } else { lastCoverFor = null; lastCover = ''; }
    var vol = 1;
    try {
      if (AM.R && AM.R.vol) vol = (+AM.R.vol.value) / 100;
      else { var lv = document.querySelector('#volume'); if (lv) vol = (+lv.value) / 100; }
    } catch (e) { }
    var mode = null;
    try { if (window.anniePlayMode) mode = window.anniePlayMode.info(); } catch (e) { }
    var lines = [];
    if (S.lyrLines && S.lyrLines.length) {
      for (var i = 0; i < S.lyrLines.length; i++) {
        var l = S.lyrLines[i] || {};
        lines.push({ t: l.t, txt: l.txt || l.text || '', tly: l.tly || '' });
      }
    }
    return {
      playing: !!st.playing,
      title: t ? t.title : '', artist: t ? t.artist : '', album: t ? t.album : '',
      cover: cover,
      duration: st.duration || 0, position: st.position || 0,
      volume: vol,
      mode: mode ? { id: mode.id, icon: mode.icon, label: mode.label } : null,
      lyric: { lines: lines, cur: S.lyrCur != null ? S.lyrCur : -1 },
    };
  }

  setInterval(function () {
    try { window.mine.remotePushState(snapshot()); } catch (e) { }
  }, 700);

  /* 遥控二期（V4.3.18）：曲库快照推送——lib/meta 变化时推给主进程（5s 轮询签名，8s 节流）。
   * 行格式 {p,t,ar,al}，meta 未加载的行退化为文件名，随后 meta 到位自动补推。 */
  var lastLibSig = '';
  var lastLibPush = 0;
  function pushLibSnapshot() {
    try {
      if (!window.mine.remotePushLib) return;
      var AM = window.__annieAMInternal || {};
      var S = AM.S || {};
      if (!AM.allTracks) return;
      var lib = AM.allTracks() || [];
      var mcount = 0;
      if (S.meta) { for (var k in S.meta) mcount++; }
      var sig = lib.length + ':' + mcount;
      var now = Date.now();
      if (sig === lastLibSig || (lastLibSig && now - lastLibPush < 8000)) return;
      lastLibSig = sig; lastLibPush = now;
      var rows = [];
      for (var i = 0; i < lib.length; i++) {
        var t = lib[i] || {};
        var m = t.path && S.meta ? S.meta[t.path] : null;
        var ok = m && !m.fail;
        rows.push({
          p: t.path || '',
          t: (ok && m.title) || t.title || nameFromPath(t.path),
          ar: (ok && m.artist) || t.artist || '',
          al: (ok && m.album) || t.album || '',
        });
      }
      window.mine.remotePushLib(rows);
    } catch (e) { }
  }
  setInterval(pushLibSnapshot, 5000);

  window.mine.onRemoteCmd(function (p) {
    if (!p || !p.cmd) return;
    var AM = window.__annieAMInternal || {};
    var st = getState();
    try {
      switch (p.cmd) {
        case 'playpause':
          if (st.currentPath || st.currentStream) window.mine.engine(st.playing ? 'pause' : 'resume').catch(function () { });
          break;
        case 'next': if (AM.next) AM.next(); break;
        case 'prev': if (AM.prev) AM.prev(); break;
        case 'seek': {
          var base = st.currentCue ? st.currentCue.start || 0 : 0;
          window.mine.engine('seek', { seconds: base + Math.max(0, +p.value || 0) }, 30000).catch(function () { });
          break;
        }
        case 'volume': {
          var g = Math.max(0, Math.min(1, +p.value));
          window.mine.engine('volume.set', { gain: g }).catch(function () { });
          if (AM.R && AM.R.vol) AM.R.vol.value = Math.round(g * 100);
          var lv = document.querySelector('#volume'); if (lv) lv.value = Math.round(g * 100);
          break;
        }
        case 'mode': if (window.anniePlayMode) window.anniePlayMode.cycle(); break;
        case 'playpath': { // 遥控二期：手机点歌——全库上下文播放（与界面点行同语义）
          var all2 = AM.allTracks ? AM.allTracks() : [];
          var want = String(p.value || '');
          for (var pi = 0; pi < all2.length; pi++) {
            if (all2[pi] && all2[pi].path === want) { if (AM.playList) AM.playList(all2, pi); break; }
          }
          break;
        }
      }
    } catch (e) { }
  });
})();
