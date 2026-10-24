/* ===== V4.3.6：Qobuz 在线播放/下载页 =====
 * 用户登录自己的 Qobuz 付费账号（同 QBDLX），搜索/专辑/歌单/收藏 → 现解析直链播放；下载走主进程队列。
 * 复用 AM 现有样式类（am-table / am-sl-card / am-btn 等），不新增 CSS。 */
(function () {
  'use strict';
  var AM = window.__annieAMInternal; // AM 桥接对象（同 am.js 拆分片约定）
  if (!AM) return;
  var S = AM.S, R = AM.R;

  function el(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }
  function esc(s) { return String(s == null ? '' : s); }
  function fmtT(sec) { sec = Math.max(0, Math.round(sec || 0)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  function imgOf(obj) { return (obj && obj.image && (obj.image.large || obj.image.small || obj.image.thumbnail)) || ''; }

  var QZ = {
    st: null,        // qobuz:status 结果
    restoring: false,
    kw: '', type: 'album',   // album | track | playlist
    results: [], busy: false, err: '',
    detail: null,    // { kind:'album'|'playlist', id, info, tracks }
    playQueue: [],   // V4.4.3：连播队列 [{t, album}]（专辑/歌单/搜索列表即队列）
    playIndex: -1,
  };

  function quality() { var q = parseInt(localStorage.getItem('annie.qz.q') || '4', 10); return q >= 1 && q <= 4 ? q : 4; }
  var QLABEL = { 1: 'MP3 320', 2: 'FLAC 16bit/44.1kHz', 3: 'FLAC 24bit/≤96kHz', 4: 'FLAC 24bit/≤192kHz' };

  function setErr(e) { QZ.err = typeof e === 'string' ? e : ('操作失败：' + ((e && e.message) || e)); }
  function refresh() { if (S.view === 'qobuz') AM.renderView(); }

  /* ---------------- 下载（M2：并发/重试/断点续传在主进程 download.js） ---------------- */
  QZ.dl = { running: false, total: 0, done: 0, fail: 0, skip: 0, current: '', pct: 0, summary: '' };
  QZ.parsed = null; // 链接解析结果 { kind, title, sub, tracks }
  QZ.favs = {};     // 会话内收藏状态（'album:id' / 'playlist:id' → true）

  function toast(msg) { try { if (typeof proToast === 'function') proToast(msg); } catch (e) { } }

  function startDownload(tracks) {
    if (!tracks || !tracks.length) return;
    if (QZ.dl.running) { QZ.err = '已有下载队列进行中'; refresh(); return; }
    QZ.err = '';
    window.mine.qobuzDownload({ items: tracks, quality: quality() })
      .then(function () { refresh(); })
      .catch(function (e) { setErr(e); refresh(); });
  }

  function doParseUrl(inp) {
    var text = inp.value.trim();
    if (!text) return;
    QZ.busy = true; QZ.err = ''; refresh();
    window.mine.qobuzParseUrl(text).then(function (r) {
      QZ.busy = false;
      inp.value = '';
      // 专辑/歌单：解析成功直接进详情视图（曲目列表可逐首播放/下载，顶部有「下载全部」），不再只挂下载横幅
      if ((r.kind === 'album' || r.kind === 'playlist') && r.info) {
        QZ.parsed = null;
        QZ.detail = { kind: r.kind, id: r.id, info: r.info, tracks: r.tracks };
        refresh();
        return;
      }
      QZ.parsed = r; // 单曲：保留横幅一键下载
      refresh();
    }).catch(function (e) { QZ.busy = false; setErr(e); refresh(); });
  }

  // 主进程下载事件 → 状态面板。进度事件高频：只直改状态条 DOM，不做全量重绘（防输入框失焦）
  if (window.mine && window.mine.onQobuzDlEvent) {
    window.mine.onQobuzDlEvent(function (ev) {
      var d = QZ.dl;
      if (ev.phase === 'begin') { d.running = true; d.total = ev.total; d.done = d.fail = d.skip = 0; d.pct = 0; d.summary = ''; refresh(); return; }
      if (ev.phase === 'trackBegin') { d.current = ev.title || ''; d.pct = 0; }
      else if (ev.phase === 'progress') d.pct = ev.total ? Math.round(ev.received / ev.total * 100) : 0;
      else if (ev.phase === 'done') d.done = ev.stat.done;
      else if (ev.phase === 'skip') d.skip = ev.stat.skip;
      else if (ev.phase === 'fail') { d.fail = ev.stat.fail; console.warn('[qobuz] 下载失败:', ev.title, ev.error); }
      else if (ev.phase === 'end') {
        d.running = false; d.current = '';
        var f = ev.fill || {};
        var doneN = (ev.stat.done || 0) + (ev.stat.skip || 0); // 跳过（已存在）的也跑了标签/歌词补全
        d.summary = '下载' + (ev.canceled ? '已取消' : '完成') + '：成功 ' + ev.stat.done + '，跳过 ' + ev.stat.skip + '，失败 ' + ev.stat.fail +
          (doneN ? '；标签 ' + (f.tagged || 0) + '/' + doneN + '，歌词 ' + (f.lyric || 0) + '/' + doneN : '');
        refresh();
        // V4.4.3：歌词补全失败统一提醒一次（LRCLIB+国内五源都没有的情况），不逐曲打扰
        if (!ev.canceled && f.lyricMiss > 0) {
          toast('歌词补全：' + doneN + ' 首中 ' + f.lyricMiss + ' 首 LRCLIB 与国内平台均未找到匹配歌词，已跳过');
        }
        return;
      }
      // 高频段（trackBegin/progress/done/skip/fail）：状态条在位则直改，不在位才重绘
      if (QZ._dlLine && document.contains(QZ._dlLine)) {
        QZ._dlLine.textContent = dlStatusText();
      } else refresh();
    });
  }

  function dlStatusText() {
    var d = QZ.dl;
    if (d.running) {
      return '下载中 ' + (d.done + d.fail + d.skip) + '/' + d.total +
        (d.current ? ' · 当前：' + d.current + ' ' + d.pct + '%' : '') +
        (d.fail ? ' · 失败 ' + d.fail : '');
    }
    return d.summary;
  }

  /* ---------------- 播放（V4.4.3：连播队列——此前单曲直连无队列，ended 后静默停在曲尾） ---------------- */
  /* playTrack(t, album, queue, index)：queue 传当前列表即建立连播上下文；队列内续播每首现签 URL（时效安全） */
  function playTrack(t, album, queue, index) {
    if (queue && queue.length) {
      QZ.playQueue = queue.map(function (x) { return { t: x, album: album || null }; });
      QZ.playIndex = index || 0;
    } else {
      QZ.playQueue = [{ t: t, album: album || null }];
      QZ.playIndex = 0;
    }
    patchQobuzTransport();
    doPlay(t, album);
  }
  function doPlay(t, album) {
    QZ.err = '';
    window.mine.qobuzFileUrl({ trackId: String(t.id), quality: quality() }).then(function (f) {
      if (!f || !f.url) { QZ.err = '未取到播放地址'; refresh(); return; }
      // 音质徽标：与洛雪流媒体同款（流式播放引擎 format 事件被跳过，徽标在此直设）
      S.fmt = 'FLAC · ' + (f.bit_depth || '?') + 'bit · ' + (f.sampling_rate || '?') + 'kHz';
      if (AM.refreshBadge) AM.refreshBadge();
      window.annieStreamPlay({
        url: f.url,
        title: t.title || '',
        artist: (t.performer && t.performer.name) || (album && album.artist && album.artist.name) || '',
        album: (album && album.title) || (t.album && t.album.title) || '',
        cover: (album && imgOf(album)) || imgOf(t.album) || '',
        duration: t.duration || 0,
        provider: 'Qobuz',
        quality: 'Qobuz ' + (f.bit_depth || '?') + 'bit/' + (f.sampling_rate || '?') + 'kHz',
        qid: String(t.id), // V4.4.3：连播守卫身份（playNext 包装按 qid 比对队列当前项）
        onPlayed: function () { fetchLyric(t, album); }, // Qobuz 无歌词 API：播放确认后 LRCLIB→五源兜底匹配
      });
    }).catch(function (e) { setErr(e); refresh(); });
  }

  /* V4.4.3：Qobuz 连播——包装 annieStream.playNext/playPrev（ended 事件/底部传输栏走这里）
   * 与 AM.nextStream/prevStream（AM 底栏走 AM 桥）。守卫 provider==='Qobuz' + qid 身份比对，
   * 不命中交还原实现（洛雪/本地不受影响）。首次播放时包装，确保在 am-stream 补丁之后的最外层。 */
  function patchQobuzTransport() {
    if (QZ._tpPatched) return;
    QZ._tpPatched = true;
    function curOk() {
      var cs = (typeof state !== 'undefined') && state.currentStream;
      var cur = QZ.playQueue[QZ.playIndex];
      return !!(cs && cs.provider === 'Qobuz' && cs.qid && cur && String(cur.t.id) === cs.qid);
    }
    function qzPlay(i) {
      var e = QZ.playQueue[i];
      if (!e) return;
      QZ.playIndex = i;
      doPlay(e.t, e.album);
    }
    function qzNext() {
      var n = QZ.playQueue.length;
      if (!n) return;
      var m = window.anniePlayMode ? window.anniePlayMode.get() : 'list-seq';
      if (m === 'repeat-one') { qzPlay(QZ.playIndex); return; }
      if (m === 'list-rand' || m === 'all-rand') {
        if (n > 1) { var ri; do { ri = Math.floor(Math.random() * n); } while (ri === QZ.playIndex); qzPlay(ri); }
        else qzPlay(QZ.playIndex);
        return;
      }
      if (QZ.playIndex < n - 1) qzPlay(QZ.playIndex + 1); // 播完队列自然停止（同洛雪在线列表语义）
    }
    function qzPrev() {
      if (S.pos > 3 && AM.seek) { AM.seek(0); return; }
      if (QZ.playIndex > 0) qzPlay(QZ.playIndex - 1);
    }
    if (window.annieStream && window.annieStream.playNext) {
      var origNext = window.annieStream.playNext, origPrev = window.annieStream.playPrev;
      window.annieStream.playNext = function () { if (curOk()) qzNext(); else if (origNext) origNext(); };
      if (origPrev) window.annieStream.playPrev = function () { if (curOk()) qzPrev(); else origPrev(); };
    }
    var origAmNext = AM.nextStream, origAmPrev = AM.prevStream;
    if (origAmNext) AM.nextStream = function () { if (curOk()) return qzNext(); return origAmNext.apply(this, arguments); };
    if (origAmPrev) AM.prevStream = function () { if (curOk()) return qzPrev(); return origAmPrev.apply(this, arguments); };
  }

  /* 歌词兜底匹配：注入流媒体歌词缓存 + 广播事件（同 am-stream.js playStreamAt 的注入点） */
  function fetchLyric(t, album) {
    if (!window.mine || !window.mine.qobuzLyricMatch) return;
    var curPath = (typeof state !== 'undefined' && state.currentPath) || null;
    if (!curPath) return;
    window.mine.qobuzLyricMatch({
      title: t.title || '',
      artist: (t.performer && t.performer.name) || (album && album.artist && album.artist.name) || '',
      album: (album && album.title) || (t.album && t.album.title) || '',
      duration: t.duration || 0,
    }).then(function (ly) {
      if (!ly || !ly.ok || !ly.lrc) { console.log('[qobuz] 歌词兜底无果:', ly && ly.reason); return; }
      if (typeof state === 'undefined' || state.currentPath !== curPath) return; // 已切歌丢弃
      window.__annieStreamLrcByPath = window.__annieStreamLrcByPath || {};
      window.__annieStreamLrcByPath[curPath] = ly.lrc;
      window.__annieStreamTlyByPath = window.__annieStreamTlyByPath || {};
      window.__annieStreamTlyByPath[curPath] = ly.tlyric || '';
      console.log('[qobuz] 歌词兜底命中:', ly.matched.provider, ly.matched.name, '-', ly.matched.artist, 'score', ly.matched.score);
      if (window.annieStage && window.annieStage.setLyricText) window.annieStage.setLyricText(ly.lrc);
      try { document.dispatchEvent(new CustomEvent('annie-stream-lyric', { detail: { path: curPath } })); } catch (e) { }
    }).catch(function () { });
  }

  /* ---------------- 数据动作 ---------------- */
  function doSearch() {
    if (!QZ.kw) return;
    QZ.busy = true; QZ.err = ''; QZ.results = []; QZ.detail = null; refresh();
    window.mine.qobuzSearch({ type: QZ.type, query: QZ.kw, limit: 30 }).then(function (res) {
      // token 可能在搜索过程中失效 → 复查状态，失效则退回登录页
      if (!res || (!res.albums && !res.tracks && !res.artists)) {
        window.mine.qobuzStatus().then(function (st) {
          if (!st.loggedIn || st.needToken) { QZ.st = st; QZ.results = []; QZ.detail = null; refresh(); }
        });
      }
      // ⚠️ 2026-10-22：后端返回的是**裸数组**（res.albums = [...]），
      //    不是 {items:[...]}。原来只认 .items → 永远拿不到结果。
      var key = QZ.type + 's';
      var raw = res && res[key];
      QZ.results = Array.isArray(raw) ? raw : ((raw && raw.items) || []);
      QZ.busy = false; refresh();
    }).catch(function (e) { QZ.busy = false; setErr(e); refresh(); });
  }
  function openAlbum(id) {
    QZ.busy = true; QZ.err = ''; refresh();
    window.mine.qobuzAlbumGet(String(id)).then(function (d) {
      QZ.detail = { kind: 'album', id: id, info: d, tracks: (d.tracks && d.tracks.items) || [] };
      QZ.busy = false; refresh();
    }).catch(function (e) { QZ.busy = false; setErr(e); refresh(); });
  }
  function openPlaylist(id) {
    QZ.busy = true; QZ.err = ''; refresh();
    window.mine.qobuzPlaylistGet(String(id)).then(function (d) {
      QZ.detail = { kind: 'playlist', id: id, info: d, tracks: (d.tracks && d.tracks.items) || [] };
      QZ.busy = false; refresh();
    }).catch(function (e) { QZ.busy = false; setErr(e); refresh(); });
  }
  function loadFavorites(type) { // album | track
    QZ.busy = true; QZ.err = ''; QZ.detail = null; refresh();
    window.mine.qobuzFavorites(type).then(function (res) {
      QZ.type = type;
      var _raw = res && res[type + 's'];
      QZ.results = Array.isArray(_raw) ? _raw : ((_raw && _raw.items) || []);
      QZ.results.forEach(function (it) { if (it.id != null) QZ.favs[type + ':' + it.id] = true; }); // 收藏列表即已收藏，回填状态
      QZ.kw = '';
      QZ.busy = false; refresh();
    }).catch(function (e) { QZ.busy = false; setErr(e); refresh(); });
  }
  function loadMyPlaylists() {
    QZ.busy = true; QZ.err = ''; QZ.detail = null; refresh();
    window.mine.qobuzUserPlaylists().then(function (res) {
      QZ.type = 'playlist';
      var _pl = res && res.playlists;
      QZ.results = Array.isArray(_pl) ? _pl : ((_pl && _pl.items) || []);
      QZ.kw = '';
      QZ.busy = false; refresh();
    }).catch(function (e) { QZ.busy = false; setErr(e); refresh(); });
  }

  /* ---------------- 登录卡 ---------------- */
  function renderLogin(c) {
    // ⚠️ 2026-10-22：登录页重做（用户要求「token 失效时退回登录页」）
    //    两种登录方式：
    //      1. 填 Token（推荐，从公开渠道拿）
    //      2. 邮箱密码（有自己账号的话）
    c.innerHTML = '';
    var page = el('div');
    page.style.cssText = 'display:flex;flex-direction:column;align-items:center;width:100%;padding-top:8px';
    var title = el('div', 'am-view-h', 'Qobuz');
    title.style.cssText = 'margin:0 0 6px;text-align:center';
    page.appendChild(title);

    // 失效提示
    var errMsg = QZ.st && QZ.st.tokenError ? QZ.st.tokenError : '';
    if (QZ.st && QZ.st.needToken) {
      var warn = el('div');
      warn.style.cssText = 'text-align:center;color:#ff6b6b;font-size:13px;margin-bottom:12px;max-width:440px;line-height:1.6';
      warn.textContent = errMsg || '内置 Token 已失效，请填入新的 Token 或使用账号登录';
      page.appendChild(warn);
    }

    var desc = el('div', 'am-c-dim');
    desc.textContent = 'Qobuz 需要有效的 Token 才能搜索/播放。可从公开渠道获取，或使用自己的账号登录。';
    desc.style.cssText = 'text-align:center;margin-bottom:18px;font-size:13px;max-width:440px;line-height:1.6';
    page.appendChild(desc);

    // ===== Token 输入卡片（主推） =====
    var card = el('div');
    card.style.cssText = 'width:min(460px,100%);display:flex;flex-direction:column;gap:10px;' +
      'padding:20px 22px;border-radius:14px;margin-bottom:14px;' +
      'background:color-mix(in srgb, var(--am-bg) 82%, transparent);' +
      'border:1px solid var(--am-sep);box-shadow:0 10px 30px -18px rgba(0,0,0,.4)';
    var tokenHead = el('div');
    tokenHead.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:2px';
    tokenHead.textContent = '① 填写 Token（推荐）';
    card.appendChild(tokenHead);

    var inpT = document.createElement('input');
    inpT.className = 'am-st-input';
    inpT.placeholder = '粘贴 Qobuz user_auth_token（32~64 位字符串）';
    inpT.style.width = '100%';
    card.appendChild(inpT);

    var rowRegion = el('div');
    rowRegion.style.cssText = 'display:flex;gap:8px;align-items:center';
    var inpR = document.createElement('input');
    inpR.className = 'am-st-input';
    inpR.placeholder = '区域（如 US / GB，可留空）';
    inpR.style.flex = '1';
    rowRegion.appendChild(inpR);
    card.appendChild(rowRegion);

    var tErr = el('div');
    tErr.style.cssText = 'color:#ff6b6b;font-size:12px;min-height:16px';
    card.appendChild(tErr);

    var bSave = el('button', 'am-btn am-btn-accent', '保存并验证');
    bSave.onclick = function () {
      var tk = inpT.value.trim();
      if (!tk) { tErr.textContent = '请先粘贴 Token'; return; }
      tErr.textContent = '验证中…';
      window.mine.qobuzSetToken({ token: tk, region: inpR.value.trim() }).then(function () {
        return window.mine.qobuzStatus();
      }).then(function (st) {
        QZ.st = st;
        if (st.loggedIn) {
          tErr.textContent = '';
          QZ.results = []; QZ.detail = null;
          refresh();
        } else {
          tErr.textContent = st.tokenError || 'Token 无效，请检查';
        }
      }).catch(function (e) { tErr.textContent = '验证失败：' + (e.message || e); });
    };
    card.appendChild(bSave);
    page.appendChild(card);

    // ===== 账号密码登录（次选） =====
    var card2 = el('div');
    card2.style.cssText = 'width:min(460px,100%);display:flex;flex-direction:column;gap:10px;' +
      'padding:20px 22px;border-radius:14px;' +
      'background:color-mix(in srgb, var(--am-bg) 82%, transparent);' +
      'border:1px solid var(--am-sep);box-shadow:0 10px 30px -18px rgba(0,0,0,.4)';
    var head2 = el('div');
    head2.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:2px';
    head2.textContent = '② 或使用 Qobuz 账号登录';
    card2.appendChild(head2);

    var inpE = document.createElement('input');
    inpE.className = 'am-st-input'; inpE.placeholder = '邮箱'; inpE.style.width = '100%';
    card2.appendChild(inpE);
    var inpP = document.createElement('input');
    inpP.className = 'am-st-input'; inpP.type = 'password'; inpP.placeholder = '密码'; inpP.style.width = '100%';
    card2.appendChild(inpP);
    var aErr = el('div');
    aErr.style.cssText = 'color:#ff6b6b;font-size:12px;min-height:16px';
    card2.appendChild(aErr);

    function submitLogin() {
      aErr.textContent = '登录中…';
      window.mine.qobuzLogin({ email: inpE.value.trim(), password: inpP.value }).then(function (st) {
        QZ.st = st;
        if (st.loggedIn) { aErr.textContent = ''; QZ.results = []; QZ.detail = null; refresh(); }
        else { aErr.textContent = st.error || '登录失败'; }
      }).catch(function (e) { aErr.textContent = '登录失败：' + (e.message || e); });
    }
    inpP.onkeydown = function (e) { if (e.key === 'Enter') submitLogin(); };
    var bLogin = el('button', 'am-btn', '账号登录');
    bLogin.onclick = submitLogin;
    card2.appendChild(bLogin);
    page.appendChild(card2);

    // 帮助链接
    var help = el('div', 'am-c-dim');
    help.style.cssText = 'text-align:center;font-size:11px;margin-top:14px;max-width:460px;line-height:1.7;opacity:.72';
    help.textContent = 'Token 可从公开渠道获取（如 Qobuz 用户分享的 token 池）。若全部失效，需等待更新或使用自己的账号。';
    page.appendChild(help);

    c.appendChild(page);
  }


  function renderTracks(c, tracks, album) {
    var tb = el('table', 'am-table');
    tb.innerHTML = '<thead><tr><th style="width:40px;text-align:right">#</th><th style="width:46px"></th><th>歌曲</th><th>艺人</th><th style="width:56px;text-align:right">时长</th><th style="width:40px" title="收藏">♥</th><th style="width:40px" title="链接">🔗</th><th style="width:40px" title="下载">⬇</th></tr></thead>';
    var body = el('tbody');
    tracks.forEach(function (t, ti) {
      var tr = el('tr', 'am-tr');
      var tdN = el('td', 'am-c-dim', String(t.track_number || '')); tdN.style.textAlign = 'right'; tr.appendChild(tdN);
      var tdCover = el('td');
      var img = el('img', 'am-c-cover'); img.alt = ''; img.loading = 'lazy';
      var csrc = (album && imgOf(album)) || imgOf(t.album);
      if (csrc) { img.src = csrc; img.onerror = function () { img.style.visibility = 'hidden'; }; }
      else img.style.visibility = 'hidden';
      tdCover.appendChild(img); tr.appendChild(tdCover);
      tr.appendChild(el('td', 'am-c-title', esc(t.title) + (t.parental_warning ? ' 🅴' : '')));
      tr.appendChild(el('td', 'am-c-dim', esc((t.performer && t.performer.name) || '')));
      var tdD = el('td', 'am-c-dim', fmtT(t.duration)); tdD.style.textAlign = 'right'; tr.appendChild(tdD);
      // ⚠️ 2026-10-22：补上收藏 / 复制链接（用户要求）
      var tdFav = el('td');
      var bFav = el('button', 'am-dl-btn', '♥');
      bFav.title = '收藏到 Qobuz 我的收藏';
      bFav.onclick = function (e) {
        e.stopPropagation();
        var isFav = !!QZ.favs['track:' + t.id];
        window.mine.qobuzFav({ type: 'track', id: String(t.id), add: !isFav }).then(function () {
          QZ.favs['track:' + t.id] = !isFav;
          bFav.style.color = isFav ? '' : '#e91e63';
          if (typeof proToast === 'function') proToast(isFav ? '已取消收藏' : '已收藏到 Qobuz');
        }).catch(function () { });
      };
      if (QZ.favs['track:' + t.id]) bFav.style.color = '#e91e63';
      tdFav.appendChild(bFav); tr.appendChild(tdFav);

      var tdShare = el('td');
      var bShare = el('button', 'am-dl-btn', '🔗');
      bShare.title = '复制 Qobuz 分享链接';
      bShare.onclick = function (e) {
        e.stopPropagation();
        var url = 'https://www.qobuz.com/track/' + t.id;
        try {
          if (window.mine && window.mine.copyText) window.mine.copyText(url);
          if (typeof proToast === 'function') proToast('链接已复制：' + url);
        } catch (err) { }
      };
      tdShare.appendChild(bShare); tr.appendChild(tdShare);

      var tdDl = el('td');
      var bDl = el('button', 'am-dl-btn', '⬇'); bDl.title = '下载到下载目录（音质：' + QLABEL[quality()] + '）';
      bDl.onclick = function (e) {
        e.stopPropagation();
        var item = Object.assign({}, t);
        if (album && !item.albumTitle) { item.albumTitle = album.title; item.albumArtist = (album.artist && album.artist.name) || ''; }
        if (!item.coverUrl) item.coverUrl = csrc || ''; // V4.4.3：封面随下载项走（主进程嵌标签用）
        startDownload([item]);
      };
      tdDl.appendChild(bDl); tr.appendChild(tdDl);
      tr.onclick = function () { playTrack(t, album, tracks, ti); }; // V4.4.3：整表即连播队列
      body.appendChild(tr);
    });
    tb.appendChild(body);
    c.appendChild(tb);
  }

  /* ---------------- 详情（专辑/歌单） ---------------- */
  function renderDetail(c) {
    var d = QZ.detail;
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:10px;margin-bottom:10px';
    var back = el('button', 'am-btn', '‹ 返回');
    back.onclick = function () { QZ.detail = null; refresh(); };
    bar.appendChild(back);
    // 下载全部（专辑：曲目附 albumTitle/albumArtist，主进程按「艺人 - 专辑/序号 - 标题」落子目录）
    if (d.tracks.length) {
      var bAll = el('button', 'am-btn', '⬇ 下载全部（' + d.tracks.length + ' 首）');
      bAll.onclick = function () {
        var dCover = d.kind === 'album' ? imgOf(d.info)
          : ((d.info.images300 && d.info.images300[0]) || (d.info.images && d.info.images[0]) || '');
        startDownload(d.tracks.map(function (t) {
          var item = Object.assign({}, t);
          if (d.kind === 'album') {
            item.albumTitle = d.info.title; item.albumArtist = (d.info.artist && d.info.artist.name) || '';
            item.genre = (d.info.genre && d.info.genre.name) || '';       // V4.4.3：流派
            item.publisher = (d.info.label && d.info.label.name) || '';   // V4.4.3：厂牌
            if (d.info.release_date_original) item.releaseDate = String(d.info.release_date_original).slice(0, 10);
          }
          if (!item.coverUrl) item.coverUrl = dCover; // V4.4.3：封面随下载项走（主进程嵌标签用）
          return item;
        }));
      };
      bar.appendChild(bAll);
    }
    // 收藏到 Qobuz 账号（专辑 favorite/create|delete；歌单 subscribe|unsubscribe）
    var fkey = d.kind + ':' + d.info.id;
    var bFavQ = el('button', 'am-btn', QZ.favs[fkey] ? '★ 已收藏' : (d.kind === 'album' ? '♥ 收藏专辑' : '♥ 收藏歌单'));
    bFavQ.onclick = function () {
      var add = !QZ.favs[fkey];
      bFavQ.disabled = true;
      window.mine.qobuzFav({ kind: d.kind, id: String(d.info.id), add: add }).then(function () {
        QZ.favs[fkey] = add;
        toast(add ? '已收藏到你的 Qobuz 账号' : '已取消收藏');
        refresh();
      }).catch(function (e) { bFavQ.disabled = false; setErr(e); refresh(); });
    };
    bar.appendChild(bFavQ);
    c.appendChild(bar);
    var head = el('div'); head.style.cssText = 'display:flex;gap:14px;margin-bottom:12px;align-items:flex-start';
    var img = el('img', 'am-sl-cover'); img.alt = ''; img.style.cssText = 'width:96px;height:96px;border-radius:8px;flex:none';
    var src = d.kind === 'playlist'
      ? (d.info.images300 && d.info.images300[0]) || (d.info.images && d.info.images[0]) || ''
      : imgOf(d.info);
    if (src) { img.src = src; img.onerror = function () { img.style.visibility = 'hidden'; }; } else img.style.visibility = 'hidden';
    head.appendChild(img);
    var box = el('div');
    box.appendChild(el('div', 'am-view-h', esc(d.info.title || d.info.name || '')));
    box.appendChild(el('div', 'am-c-dim', esc(
      d.kind === 'album'
        ? ((d.info.artist && d.info.artist.name || '') + (d.info.release_date_original ? ' · ' + String(d.info.release_date_original).slice(0, 10) : '') + ' · ' + d.tracks.length + ' 首')
        : ((d.info.owner && d.info.owner.name ? d.info.owner.name + ' · ' : '') + d.tracks.length + ' 首'))));
    head.appendChild(box);
    c.appendChild(head);
    if (!d.tracks.length) { c.appendChild(el('div', 'am-empty', QZ.busy ? '加载中…' : '没有曲目')); return; }
    renderTracks(c, d.tracks, d.kind === 'album' ? d.info : null);
  }

  /* ---------------- 结果区 ---------------- */
  function renderResults(c) {
    if (QZ.busy && !QZ.results.length) { c.appendChild(el('div', 'am-empty', '加载中…')); return; }
    if (!QZ.results.length) { c.appendChild(el('div', 'am-empty', QZ.kw ? '无结果' : '搜索，或从上方进入你的收藏/歌单')); return; }
    if (QZ.type === 'track') {
      renderTracks(c, QZ.results.map(function (t) { return t; }), null);
      return;
    }
    var grid = el('div', 'am-sl-grid');
    QZ.results.forEach(function (it) {
      var card = el('div', 'am-sl-card');
      var img = el('img', 'am-sl-cover'); img.alt = ''; img.loading = 'lazy';
      var src = QZ.type === 'playlist'
        ? ((it.images300 && it.images300[0]) || (it.images && it.images[0]) || '')
        : imgOf(it);
      if (src) { img.src = src; img.onerror = function () { img.style.visibility = 'hidden'; }; } else img.style.visibility = 'hidden';
      card.appendChild(img);
      card.appendChild(el('div', 'am-sl-name', esc(it.title || it.name || '')));
      card.appendChild(el('div', 'am-sl-meta', esc(
        QZ.type === 'playlist'
          ? ((it.owner && it.owner.name) || '') + (it.tracks_count ? ' · ' + it.tracks_count + ' 首' : '')
          : ((it.artist && it.artist.name) || '') + (it.tracks_count ? ' · ' + it.tracks_count + ' 首' : ''))));
      card.onclick = function () { QZ.type === 'playlist' ? openPlaylist(it.id) : openAlbum(it.id); };
      grid.appendChild(card);
    });
    c.appendChild(grid);
  }

  /* ---------------- 主视图 ---------------- */
  function renderQobuzView(c) {
    if (!window.mine.qobuzStatus) { c.appendChild(el('div', 'am-empty', 'Qobuz 模块未加载')); return; }
    if (!QZ.st) {
      c.appendChild(el('div', 'am-empty', '正在读取登录状态…'));
      window.mine.qobuzStatus().then(function (st) {
        QZ.st = st;
        if (!st.loggedIn && st.hasSavedCreds && !QZ.restoring) {
          // 凭据在，token 可能过期：触发一次后台重登后轮询
          QZ.restoring = true;
          window.mine.qobuzFavorites('album').catch(function () { }).then(function () {
            return window.mine.qobuzStatus();
          }).then(function (st2) { QZ.st = st2; QZ.restoring = false; refresh(); });
        }
        refresh();
      }).catch(function () { c.innerHTML = ''; c.appendChild(el('div', 'am-empty', 'Qobuz 模块未加载')); });
      return;
    }
    // ⚠️ 2026-10-22：token 失效（loggedIn=false 或 needToken）→ 退回登录页
    if (!QZ.st.loggedIn || QZ.st.needToken) { renderLogin(c); return; }

    // 账号栏
    var acc = el('div'); acc.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap';
    acc.appendChild(el('div', 'am-view-h', 'Qobuz'));
    acc.appendChild(el('span', 'am-c-dim', esc(QZ.st.userName) + (QZ.st.subscription ? ' · ' + QZ.st.subscription : '')));
    /* V4.4.8：Qobuz 音质 → 胶囊弹层（原生 select 标签会被截断，样式也不统一） */
    if (AM.sortDropdown) {
      acc.appendChild(AM.sortDropdown(
        [['4', QLABEL[4]], ['3', QLABEL[3]], ['2', QLABEL[2]], ['1', QLABEL[1]]],
        String(quality()),
        function (v) { localStorage.setItem('annie.qz.q', v); }
      ));
    } else {
      var sel = document.createElement('select'); sel.className = 'am-st-input';
      [4, 3, 2, 1].forEach(function (q) {
        var o = document.createElement('option'); o.value = q; o.textContent = QLABEL[q];
        if (q === quality()) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () { localStorage.setItem('annie.qz.q', sel.value); };
      acc.appendChild(sel);
    }
    // ⚠️ 2026-10-22：Token 管理（用户要求：token 过期时能自己换）
    var bTok = el('button', 'am-btn', '🔑 更换 Token');
    bTok.title = '当前 Token 失效时可在这里换新的';
    bTok.onclick = function () {
      window.mine.qobuzClearToken().then(function () { return window.mine.qobuzStatus(); })
        .then(function (st) { QZ.st = st; QZ.results = []; QZ.detail = null; refresh(); });
    };
    acc.appendChild(bTok);
    var bOut = el('button', 'am-btn', '退出登录');
    bOut.onclick = function () {
      window.mine.qobuzLogout().then(function () {
        return window.mine.qobuzTokenStatus();
      }).then(function () { return window.mine.qobuzStatus(); })
        .then(function (st) { QZ.st = st; QZ.results = []; QZ.detail = null; QZ.results = []; refresh(); });
    };
    acc.appendChild(bOut);
    // 下载目录（Qobuz 独立设置；默认回落到流媒体下载目录）
    if (QZ.st.dlDir) {
      var bDir = el('button', 'am-btn', '📁 ' + (QZ.st.dlDir.split(/[\\/]/).pop() || QZ.st.dlDir));
      bDir.title = '下载目录：' + QZ.st.dlDir + '（点击更改）';
      bDir.onclick = function () {
        window.mine.qobuzPickDlDir().then(function (dir) { QZ.st.dlDir = dir; refresh(); });
      };
      acc.appendChild(bDir);
      var bDirReset = el('button', 'am-btn', '恢复默认');
      bDirReset.title = '恢复为默认下载目录（与洛雪流媒体相同）';
      bDirReset.onclick = function () {
        window.mine.qobuzPickDlDir(true).then(function (dir) { QZ.st.dlDir = dir; refresh(); });
      };
      acc.appendChild(bDirReset);
    }
    c.appendChild(acc);

    // 搜索行
    var row = el('div', 'am-st-inputrow');
    var inp = document.createElement('input'); inp.className = 'am-st-input'; inp.placeholder = '搜索 Qobuz…'; inp.value = QZ.kw;
    inp.onkeydown = function (e) { if (e.key === 'Enter') { QZ.kw = inp.value.trim(); doSearch(); } };
    /* V4.4.8：搜索类型 → 胶囊弹层 */
    var qzType = QZ.type;
    var tsel = AM.sortDropdown
      ? AM.sortDropdown([['album', '专辑'], ['track', '单曲'], ['playlist', '歌单']], qzType,
          function (v) { QZ.type = v; })
      : (function () {
          var s = document.createElement('select'); s.className = 'am-st-input';
          [['album', '专辑'], ['track', '单曲'], ['playlist', '歌单']].forEach(function (kv) {
            var o = document.createElement('option'); o.value = kv[0]; o.textContent = kv[1];
            if (kv[0] === qzType) o.selected = true;
            s.appendChild(o);
          });
          s.onchange = function () { QZ.type = s.value; };
          return s;
        })();
    var bGo = el('button', 'am-btn am-btn-accent', '搜索');
    bGo.onclick = function () { QZ.kw = inp.value.trim(); doSearch(); };
    row.appendChild(inp); row.appendChild(tsel); row.appendChild(bGo);
    c.appendChild(row);

    // 链接解析行（QBDLX 同款：粘贴专辑/单曲/歌单链接或裸 ID → 解析 → 下载）
    var lrow = el('div', 'am-st-inputrow');
    var linp = document.createElement('input'); linp.className = 'am-st-input';
    linp.placeholder = '粘贴 Qobuz 链接或 ID（专辑 / 单曲 / 歌单）…';
    linp.onkeydown = function (e) { if (e.key === 'Enter') doParseUrl(linp); };
    var bParse = el('button', 'am-btn', '解析');
    bParse.onclick = function () { doParseUrl(linp); };
    lrow.appendChild(linp); lrow.appendChild(bParse);
    c.appendChild(lrow);

    // 解析结果条：确认后一键入下载队列
    if (QZ.parsed) {
      var prow = el('div'); prow.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap';
      prow.appendChild(el('span', 'am-c-dim', '解析到' + { album: '专辑', track: '单曲', playlist: '歌单' }[QZ.parsed.kind] + '「' + esc(QZ.parsed.title) + '」' +
        (QZ.parsed.sub ? ' · ' + esc(QZ.parsed.sub) : '') + ' · ' + QZ.parsed.tracks.length + ' 首'));
      var bDlAll = el('button', 'am-btn am-btn-accent', '⬇ 下载 ' + QZ.parsed.tracks.length + ' 首');
      bDlAll.onclick = function () { startDownload(QZ.parsed.tracks); QZ.parsed = null; refresh(); };
      var bDismiss = el('button', 'am-btn', '✕');
      bDismiss.onclick = function () { QZ.parsed = null; refresh(); };
      prow.appendChild(bDlAll); prow.appendChild(bDismiss);
      c.appendChild(prow);
    }

    // 下载队列状态条（事件直改文本；QZ._dlLine 供进度高频更新）
    if (QZ.dl.running || QZ.dl.summary) {
      var drow = el('div'); drow.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0';
      QZ._dlLine = el('span', 'am-c-dim', dlStatusText());
      drow.appendChild(QZ._dlLine);
      if (QZ.dl.running) {
        var bCancel = el('button', 'am-btn', '取消');
        bCancel.onclick = function () { window.mine.qobuzDlCancel(); };
        drow.appendChild(bCancel);
      } else {
        var bClr = el('button', 'am-btn', '✕');
        bClr.onclick = function () { QZ.dl.summary = ''; refresh(); };
        drow.appendChild(bClr);
      }
      c.appendChild(drow);
    } else QZ._dlLine = null;

    // 快捷入口
    var quick = el('div'); quick.style.cssText = 'display:flex;gap:8px;margin:8px 0 10px;flex-wrap:wrap';
    [['♥ 收藏专辑', function () { loadFavorites('album'); }],
     ['♥ 收藏单曲', function () { loadFavorites('track'); }],
     ['📋 我的歌单', loadMyPlaylists]].forEach(function (kv) {
      var b = el('button', 'am-btn', kv[0]); b.onclick = kv[1]; quick.appendChild(b);
    });
    c.appendChild(quick);

    if (QZ.err) { var e2 = el('div', 'am-c-dim', esc(QZ.err)); e2.style.cssText = 'color:#ff6b6b;margin-bottom:8px'; c.appendChild(e2); }

    if (QZ.detail) { renderDetail(c); return; }
    renderResults(c);
  }

  AM.renderQobuzView = renderQobuzView;
  console.log('[qobuz] 模块加载完成');
})();
