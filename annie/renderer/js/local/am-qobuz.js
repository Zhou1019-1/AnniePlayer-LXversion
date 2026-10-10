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
        d.summary = '下载' + (ev.canceled ? '已取消' : '完成') + '：成功 ' + ev.stat.done + '，跳过 ' + ev.stat.skip + '，失败 ' + ev.stat.fail;
        refresh(); return;
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

  /* ---------------- 播放 ---------------- */
  function playTrack(t, album) {
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
        onPlayed: function () { fetchLyric(t, album); }, // Qobuz 无歌词 API：播放确认后五源兜底匹配
      });
    }).catch(function (e) { setErr(e); refresh(); });
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
      var key = QZ.type + 's';
      QZ.results = (res && res[key] && res[key].items) || [];
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
      QZ.results = (res && res[type + 's'] && res[type + 's'].items) || [];
      QZ.results.forEach(function (it) { if (it.id != null) QZ.favs[type + ':' + it.id] = true; }); // 收藏列表即已收藏，回填状态
      QZ.kw = '';
      QZ.busy = false; refresh();
    }).catch(function (e) { QZ.busy = false; setErr(e); refresh(); });
  }
  function loadMyPlaylists() {
    QZ.busy = true; QZ.err = ''; QZ.detail = null; refresh();
    window.mine.qobuzUserPlaylists().then(function (res) {
      QZ.type = 'playlist';
      QZ.results = (res && res.playlists && res.playlists.items) || [];
      QZ.kw = '';
      QZ.busy = false; refresh();
    }).catch(function (e) { QZ.busy = false; setErr(e); refresh(); });
  }

  /* ---------------- 登录卡 ---------------- */
  function renderLogin(c) {
    c.appendChild(el('div', 'am-view-h', 'Qobuz'));
    c.appendChild(el('div', 'am-empty', '登录你自己的 Qobuz 付费账号（凭据仅加密保存在本机）'));
    var box = el('div'); box.style.cssText = 'max-width:340px;display:flex;flex-direction:column;gap:8px;margin-top:4px';
    var mode = { token: false };
    var inpE = document.createElement('input'); inpE.className = 'am-st-input'; inpE.placeholder = '邮箱';
    var inpP = document.createElement('input'); inpP.className = 'am-st-input'; inpP.type = 'password'; inpP.placeholder = '密码';
    var adv = el('div');
    adv.style.cssText = 'display:none;flex-direction:column;gap:8px';
    var inpA = document.createElement('input'); inpA.className = 'am-st-input'; inpA.placeholder = '自定义 app_id（一般留空）';
    var inpS = document.createElement('input'); inpS.className = 'am-st-input'; inpS.placeholder = '自定义 app_secret（一般留空）';
    adv.appendChild(inpA); adv.appendChild(inpS);
    var err = el('div', 'am-c-dim'); err.style.color = '#ff6b6b';
    function submit() {
      err.textContent = '登录中…';
      var p = { email: inpE.value.trim(), password: inpP.value };
      if (inpA.value.trim()) p.appId = inpA.value.trim();
      if (inpS.value.trim()) p.secret = inpS.value.trim();
      window.mine.qobuzLogin(p).then(function (st) {
        QZ.st = st; refresh();
      }).catch(function (e) {
        err.textContent = (e && e.message) || '登录失败';
      });
    }
    inpP.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    var bLogin = el('button', 'am-btn am-btn-accent', '登录');
    bLogin.onclick = submit;
    var bAdv = el('button', 'am-btn', '高级（自定义 app_id/secret）');
    bAdv.onclick = function () { adv.style.display = adv.style.display === 'none' ? 'flex' : 'none'; };
    box.appendChild(inpE); box.appendChild(inpP); box.appendChild(bLogin); box.appendChild(bAdv); box.appendChild(adv); box.appendChild(err);
    c.appendChild(box);
  }

  /* ---------------- 曲目表 ---------------- */
  function renderTracks(c, tracks, album) {
    var tb = el('table', 'am-table');
    tb.innerHTML = '<thead><tr><th style="width:40px;text-align:right">#</th><th style="width:46px"></th><th>歌曲</th><th>艺人</th><th style="width:56px;text-align:right">时长</th><th style="width:44px"></th></tr></thead>';
    var body = el('tbody');
    tracks.forEach(function (t) {
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
      var tdDl = el('td');
      var bDl = el('button', 'am-dl-btn', '⬇'); bDl.title = '下载到下载目录（音质：' + QLABEL[quality()] + '）';
      bDl.onclick = function (e) {
        e.stopPropagation();
        var item = Object.assign({}, t);
        if (album && !item.albumTitle) { item.albumTitle = album.title; item.albumArtist = (album.artist && album.artist.name) || ''; }
        startDownload([item]);
      };
      tdDl.appendChild(bDl); tr.appendChild(tdDl);
      tr.onclick = function () { playTrack(t, album); };
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
        startDownload(d.tracks.map(function (t) {
          var item = Object.assign({}, t);
          if (d.kind === 'album') { item.albumTitle = d.info.title; item.albumArtist = (d.info.artist && d.info.artist.name) || ''; }
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
    if (!QZ.st.loggedIn) { renderLogin(c); return; }

    // 账号栏
    var acc = el('div'); acc.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap';
    acc.appendChild(el('div', 'am-view-h', 'Qobuz'));
    acc.appendChild(el('span', 'am-c-dim', esc(QZ.st.userName) + (QZ.st.subscription ? ' · ' + QZ.st.subscription : '')));
    var sel = document.createElement('select'); sel.className = 'am-st-input'; sel.style.cssText = 'width:auto;padding:4px 8px';
    [4, 3, 2, 1].forEach(function (q) {
      var o = document.createElement('option'); o.value = q; o.textContent = QLABEL[q];
      if (q === quality()) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () { localStorage.setItem('annie.qz.q', sel.value); };
    acc.appendChild(sel);
    var bOut = el('button', 'am-btn', '退出登录');
    bOut.onclick = function () { window.mine.qobuzLogout().then(function (st) { QZ.st = st; QZ.results = []; QZ.detail = null; refresh(); }); };
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
    var tsel = document.createElement('select'); tsel.className = 'am-st-input'; tsel.style.cssText = 'width:auto;padding:4px 8px';
    [['album', '专辑'], ['track', '单曲'], ['playlist', '歌单']].forEach(function (kv) {
      var o = document.createElement('option'); o.value = kv[0]; o.textContent = kv[1];
      if (kv[0] === QZ.type) o.selected = true;
      tsel.appendChild(o);
    });
    tsel.onchange = function () { QZ.type = tsel.value; };
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
