'use strict';
/* ===== am.js 拆分片：am-stream.js =====
 * 在线音乐：洛雪搜索/排行榜/歌单广场、在线歌曲表、单曲与批量下载、流媒体续播接管
 * 来源：am.js 原稿行 275-387 + 872-1247（原样切片，零行为变更）
 * 共享变量经 window.__annieAMInternal 桥接；前向引用为转发桩，运行时解析。 */
(function () {
  var AM = window.__annieAMInternal || (window.__annieAMInternal = {}); // AM 主题内部模块桥（跨分片共享闭包变量）
  // 从桥取用先加载分片导出的引用（此时前片已执行完，引用有效）
  var S = AM.S;
  var R = AM.R;
  var PLATFORMS = AM.PLATFORMS;
  var TYPE_LABEL = AM.TYPE_LABEL;
  var el = AM.el;
  var esc = AM.esc;
  var fmtTime = AM.fmtTime;
  var seek = AM.seek;
  // 前向引用：目标函数由后加载分片注册到桥，调用时才取值（加载期取不到）
  function renderView() { return AM.renderView.apply(this, arguments); }
  function refreshBadge() { return AM.refreshBadge.apply(this, arguments); }

  /* ---------------- 洛雪在线搜索 ---------------- */
  // V3.5.14：搜索历史（localStorage，最多 15 条，datalist 提示）
  var STH_KEY = 'annieplayer.stHistory';
  function stHist() { try { return JSON.parse(localStorage.getItem(STH_KEY) || '[]'); } catch (e) { return []; } }
  function stHistPush(kw) {
    if (!kw) return;
    var a = stHist().filter(function (x) { return x !== kw; });
    a.unshift(kw);
    try { localStorage.setItem(STH_KEY, JSON.stringify(a.slice(0, 15))); } catch (e) { }
  }
  function doStreamSearch(fresh) {
    var kw = S.stKw;
    if (!kw || S.stSearching) return;
    if (fresh) stHistPush(kw);
    S.stSearching = true;
    var provider = S.stProvider;
    var page = fresh ? 1 : S.stPage + 1;
    renderStreamStatus(fresh ? PLATFORMS[provider] + ' 搜索中…' : '加载第 ' + page + ' 页…');
    window.mine.streamSearch({ provider: provider, keywords: kw, page: page, limit: 30 }).then(function (r) {
      if (provider !== S.stProvider && fresh) return;
      S.stResults = fresh ? (r.songs || []) : S.stResults.concat(r.songs || []);
      S.stPage = r.page || page;
      S.stAllPage = r.allPage || 1;
      if (fresh) S.stIndex = -1;
      S.stSearching = false;
      renderView();
      renderStreamStatus(PLATFORMS[provider] + '：共 ' + (r.total != null ? r.total : S.stResults.length) +
        ' 首 · 已加载 ' + S.stResults.length + ' 首（第 ' + S.stPage + '/' + S.stAllPage + ' 页）');
    }).catch(function (e) {
      S.stSearching = false;
      renderStreamStatus('搜索失败：' + (e.message || e), true);
    });
  }
  function renderStreamStatus(text, warn) { if (R.stStatus) { R.stStatus.textContent = text || ''; R.stStatus.classList.toggle('warn', !!warn); } }
  function playStreamAt(i) {
    var song = S.stResults[i];
    if (!song) return;
    S.stIndex = i;
    highlightStreamRow();
    renderStreamStatus('正在获取播放地址：' + song.name + '…');
    window.mine.streamSongUrl({ provider: song.provider, quality: S.stQuality, song: song }).then(function (r) {
      if (S.stIndex !== i) return;
      if (!r || !r.playable || !r.url) { renderStreamStatus(song.name + '：' + ((r && r.message) || '无法播放'), true); return; }
      S.fmt = (r.quality || '') + (r.format ? ' · ' + String(r.format).toUpperCase() : '');
      refreshBadge();
      renderStreamStatus(PLATFORMS[song.provider] + ' · ' + (r.quality || '') + ' ' + (r.format || '').toUpperCase() + ' · 独占输出中');
      if (window.annieStreamPlay) {
        // 单击即播（与洛雪流媒体面板一致）；annieStreamPlay 返回 false 表示引擎拒绝流地址
        Promise.resolve(window.annieStreamPlay({
          url: r.url, headers: r.headers || null,
          title: song.name, artist: song.artist, album: song.album || '',
          cover: song.cover || '', duration: song.duration ? song.duration / 1000 : 0,
          provider: song.provider, quality: r.quality || ''
        })).then(function (ok) {
          if (ok === false) { renderStreamStatus(song.name + '：播放失败，引擎未接受流地址', true); return; }
          // 播放确认后取歌词：注入缓存 + 广播给 AM 歌词面板 + 同步粒子舞台
          if (window.mine.streamLyric) {
            window.mine.streamLyric({ provider: song.provider, song: song }).then(function (ly) {
              if (!ly || !ly.lrc) return;
              if (S.stIndex !== i || !state.currentStream || !state.currentPath) return;
              window.__annieStreamLrcByPath = window.__annieStreamLrcByPath || {};
              window.__annieStreamLrcByPath[state.currentPath] = ly.lrc;
              if (window.annieStage && window.annieStage.setLyricText) window.annieStage.setLyricText(ly.lrc);
              try { document.dispatchEvent(new CustomEvent('annie-stream-lyric', { detail: { path: state.currentPath } })); } catch (e) { }
            }).catch(function () { });
          }
        });
      }
      if (!song.cover && window.mine.streamGetPic) {
        window.mine.streamGetPic({ provider: song.provider, song: song }).then(function (p) {
          if (p && p.url) { song.cover = p.url; if (S.stResults.indexOf(song) >= 0 && S.view === 'stream') renderView(); }
        }).catch(function () { });
      }
    }).catch(function (e) { renderStreamStatus('获取播放地址失败：' + (e.message || e), true); });
  }
  function nextStream() {
    if (S.stIndex < S.stResults.length - 1) { playStreamAt(S.stIndex + 1); return; }
    // V3.5.8：播放定时·播完当前列表停止（在线列表播完自然停止，补提示与清理）
    var t = window.annieSleepTimer && window.annieSleepTimer.get();
    if (t && t.type === 'queue') {
      window.annieSleepTimer.clear();
      try { if (typeof proToast === 'function') proToast('当前列表已播完，已停止'); } catch (e) { }
    }
  }
  function prevStream() { if (S.pos > 3) { seek(0); return; } if (S.stIndex > 0) playStreamAt(S.stIndex - 1); }
  function highlightStreamRow() {
    if (!R.content) return;
    var rows = R.content.querySelectorAll('.am-tr[data-st]');
    rows.forEach(function (r) { r.classList.toggle('cur', +r.dataset.st === S.stIndex); });
  }
  /* 流媒体自然结束续播：仅当当前流来自 AM 搜索列表时才接管，否则交还 streaming.js 原逻辑 */
  function patchStreamPlayNext() {
    if (!window.annieStream || window.annieStream.__amPatched) return;
    var orig = window.annieStream.playNext;
    window.annieStream.playNext = function () {
      if (window.annieTheme && annieTheme.current === 'am' && state.currentStream &&
          S.stIndex >= 0 && S.stResults[S.stIndex] &&
          state.currentStream.title === S.stResults[S.stIndex].name) {
        // V3.5.8：播放定时·单曲循环 N 遍（在线播放）
        var t = window.annieSleepTimer && window.annieSleepTimer.get();
        if (t && t.type === 'repeatN') {
          t.played++;
          if (t.played < t.total) { playStreamAt(S.stIndex); return; }
          window.annieSleepTimer.clear();
          try { if (typeof proToast === 'function') proToast('单曲循环 ' + t.total + ' 遍已播完，已停止'); } catch (e) { }
          return;
        }
        nextStream();
      } else if (orig) orig();
    };
    window.annieStream.__amPatched = true;
  }

  /* ---------------- 发现音乐：数据加载（V3.5.4） ---------------- */
  function switchStreamTab(tab) {
    if (S.stTab === tab) return;
    S.tabSongs[S.stTab] = S.stResults; // 缓存旧页签列表
    S.stTab = tab;
    S.stResults = S.tabSongs[tab] || [];
    S.stIndex = -1;
    if (tab === 'boards' && (S.boardsProvider !== S.stProvider || !S.boards.length)) { renderView(); loadBoards(); return; }
    if (tab === 'lists' && !S.slDetailId && (S.slProvider !== S.stProvider || !S.slLists.length)) { renderView(); loadSongLists(1); return; }
    renderView();
  }
  function switchStreamProvider(k) {
    if (S.stProvider === k) return;
    S.stProvider = k;
    if (S.stTab === 'search') { if (S.stKw) doStreamSearch(true); else renderView(); }
    else if (S.stTab === 'boards') { renderView(); loadBoards(); }
    else { S.slDetailId = ''; S.slDetailName = ''; renderView(); loadSongLists(1); }
  }
  function loadBoards() {
    var provider = S.stProvider;
    renderStreamStatus('加载' + PLATFORMS[provider] + '排行榜…');
    window.mine.streamLeaderboards({ provider: provider }).then(function (r) {
      if (S.stProvider !== provider) return;
      S.boards = r.list || []; S.boardsProvider = provider; S.boardSel = ''; S.boardName = '';
      renderView();
      renderStreamStatus(S.boards.length ? '' : '该平台暂无排行榜');
    }).catch(function (e) { renderStreamStatus('排行榜加载失败：' + (e.message || e), true); });
  }
  function loadBoardList(bangid, name, page) {
    renderStreamStatus('加载「' + name + '」…');
    window.mine.streamLeaderboardList({ provider: S.stProvider, bangid: bangid, page: page || 1 }).then(function (r) {
      S.stResults = page > 1 ? S.stResults.concat(r.songs || []) : (r.songs || []);
      S.stIndex = -1; S.boardSel = bangid; S.boardName = name;
      S.bdPage = r.page || 1; S.bdAllPage = r.allPage || 1;
      renderView();
      renderStreamStatus('「' + name + '」共 ' + (r.total || S.stResults.length) + ' 首 · 已加载 ' + S.stResults.length + ' 首');
    }).catch(function (e) { renderStreamStatus('榜单加载失败：' + (e.message || e), true); });
  }
  function loadSongLists(page) {
    var provider = S.stProvider;
    renderStreamStatus('加载歌单广场…');
    window.mine.streamSongLists({ provider: provider, page: page || 1 }).then(function (r) {
      if (S.stProvider !== provider) return;
      S.slLists = page > 1 ? S.slLists.concat(r.list || []) : (r.list || []);
      S.slProvider = provider; S.slPage = r.page || 1; S.slLimit = r.limit || 30; S.slTotal = r.total || 0;
      renderView(); renderStreamStatus('');
    }).catch(function (e) { renderStreamStatus('歌单加载失败：' + (e.message || e), true); });
  }
  /* V3.5.14：解析歌单链接 / 纯 ID → { provider, id }；无法识别返回 null */
  function parsePlaylistInput(text) {
    text = String(text || '').trim();
    if (!text) return null;
    if (/^\d{4,}$/.test(text)) return { provider: S.stProvider, id: text };
    var m;
    if (/music\.163\.com|netease/i.test(text)) {
      m = text.match(/[?&]id=(\d+)/) || text.match(/playlist\/(\d+)/);
      return m ? { provider: 'wy', id: m[1] } : null;
    }
    if (/y\.qq\.com|qq\.com/i.test(text)) {
      m = text.match(/playlist\/(\d+)/) || text.match(/[?&](?:id|disstid)=(\d+)/);
      return m ? { provider: 'tx', id: m[1] } : null;
    }
    if (/kugou\.com/i.test(text)) {
      m = text.match(/special\/single\/(\d+)/) || text.match(/songlist\/(\d+)/) || text.match(/(\d{5,})/);
      return m ? { provider: 'kg', id: m[1] } : null;
    }
    if (/kuwo\.cn/i.test(text)) {
      m = text.match(/playlist_detail\/(\d+)/) || text.match(/playlists?\/(\d+)/) || text.match(/[?&]pid=(\d+)/);
      return m ? { provider: 'kw', id: m[1] } : null;
    }
    if (/migu\.cn/i.test(text)) {
      m = text.match(/playlist\/(\d+)/) || text.match(/[?&]id=(\d+)/);
      return m ? { provider: 'mg', id: m[1] } : null;
    }
    return null;
  }
  function loadSongListDetail(id, name, page) {
    renderStreamStatus('加载歌单「' + name + '」…');
    window.mine.streamSongListDetail({ provider: S.stProvider, id: id, page: page || 1 }).then(function (r) {
      S.stResults = page > 1 ? S.stResults.concat(r.songs || []) : (r.songs || []);
      S.stIndex = -1; S.slDetailId = id; S.slDetailName = name;
      S.slDPage = r.page || 1; S.slDLimit = r.limit || 100; S.slDTotal = r.total || 0;
      renderView();
      renderStreamStatus('「' + name + '」共 ' + (r.total || S.stResults.length) + ' 首 · 已加载 ' + S.stResults.length + ' 首');
    }).catch(function (e) { renderStreamStatus('歌单详情加载失败：' + (e.message || e), true); });
  }

  /* 搜索结果/榜单/歌单共用的歌曲表格（单击即播） */
  function renderSongsTable(c) {
    var tb = el('table', 'am-table');
    tb.innerHTML = '<thead><tr><th style="width:46px"></th><th>歌曲</th><th>艺人</th><th>专辑</th><th style="width:56px;text-align:right">时长</th><th style="width:110px">音质</th><th style="width:44px"></th></tr></thead>';
    var body = el('tbody');
    S.stResults.forEach(function (song, i) {
      var tr = el('tr', 'am-tr' + (i === S.stIndex ? ' cur' : ''));
      tr.dataset.st = i;
      var tdCover = el('td');
      var img = el('img', 'am-c-cover'); img.alt = ''; img.loading = 'lazy';
      if (song.cover) { img.src = song.cover; img.onerror = function () { img.style.visibility = 'hidden'; }; }
      else img.style.visibility = 'hidden';
      tdCover.appendChild(img); tr.appendChild(tdCover);
      tr.appendChild(el('td', 'am-c-title', esc(song.name)));
      tr.appendChild(el('td', 'am-c-dim', esc(song.artist || '未知艺人')));
      tr.appendChild(el('td', 'am-c-dim', esc(song.album || '')));
      var dur = song.interval || (song.duration ? fmtTime(song.duration / 1000) : '');
      var tdDur = el('td', 'am-c-dim', dur); tdDur.style.textAlign = 'right';
      tr.appendChild(tdDur);
      var tdQ = el('td');
      (song.types || []).forEach(function (t) {
        var hq = t.type === 'flac' || t.type === 'flac24bit';
        tdQ.appendChild(el('span', 'am-qbadge' + (hq ? ' hq' : ''), TYPE_LABEL[t.type] || t.type));
      });
      tr.appendChild(tdQ);
      // V3.5.8：单曲下载按钮（含进度百分比，完成后写入标签/封面/歌词）
      var tdDl = el('td');
      var bDl = el('button', 'am-dl-btn', '⬇');
      bDl.title = '下载到下载目录（音质：' + S.stQuality + '）';
      bDl.onclick = function (e) { e.stopPropagation(); downloadSong(song, bDl); };
      tdDl.appendChild(bDl); tr.appendChild(tdDl);
      tr.onclick = function () { playStreamAt(i); };
      tr.ondblclick = function () { playStreamAt(i); };
      body.appendChild(tr);
    });
    tb.appendChild(body);
    c.appendChild(tb);
  }

  /* V3.5.8：在线歌曲下载（复用主进程 stream:download） */
  var dlState = {}; // _dlKey → 按钮元素
  var dlBound = false;
  function bindDlProgress() {
    if (dlBound || !window.mine.onStreamDownloadProgress) return;
    dlBound = true;
    window.mine.onStreamDownloadProgress(function (p) {
      var btn = dlState[p.key];
      if (btn && btn.isConnected) {
        btn.textContent = p.total ? Math.floor(p.received / p.total * 100) + '%' : Math.floor(p.received / 1048576) + 'M';
      }
    });
  }
  function downloadSong(song, btn) {
    if (!window.mine.streamDownload || btn.disabled) return;
    bindDlProgress();
    var key = 'am-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    dlState[key] = btn;
    btn.disabled = true; btn.textContent = '…';
    var asu = (window.annieSettings && window.annieSettings.ui) || {};
    window.mine.streamDownload({
      provider: song.provider || S.stProvider,
      quality: S.stQuality,
      song: song,
      saveLrc: asu.saveLrc !== false,
      saveCover: asu.saveCover !== false,
      _dlKey: key
    }).then(function (r) {
      delete dlState[key];
      btn.textContent = '✓';
      try { if (typeof proToast === 'function') proToast('已下载：' + (song.name || '') + (r && r.downgraded ? '（已降级为 ' + (r.quality || '') + '）' : '')); } catch (e) { }
    }).catch(function (e) {
      delete dlState[key];
      btn.disabled = false; btn.textContent = '⬇';
      try { if (typeof proToast === 'function') proToast('下载失败：' + (e && e.message || e), 5000); } catch (err) { }
    });
  }

  /* V3.5.8：在线歌单收藏（localStorage 持久化，跨启动保留） */
  var SLFAV_KEY = 'annieplayer.slFavs';
  function slFavs() { try { return JSON.parse(localStorage.getItem(SLFAV_KEY) || '[]'); } catch (e) { return []; } }
  function slFavSave(a) { try { localStorage.setItem(SLFAV_KEY, JSON.stringify(a.slice(0, 200))); } catch (e) { } }
  function slIsFav(id) { return slFavs().some(function (f) { return f.id === id && f.provider === S.stProvider; }); }
  function renderMoreBtn(c, label, fn) {
    var more = el('button', 'am-btn', label);
    more.style.marginTop = '14px';
    more.onclick = fn;
    c.appendChild(more);
  }

  /* V3.5.14：批量下载当前已加载的全部结果（逐首顺序下载，状态行显示进度） */
  var batchRunning = false;
  function renderBatchDlBtn(c) {
    if (!S.stResults.length || !window.mine.streamDownload) return;
    var btn = el('button', 'am-btn', '⬇ 下载已加载 ' + S.stResults.length + ' 首');
    btn.style.marginTop = '14px'; btn.style.marginLeft = '10px';
    btn.onclick = function () {
      if (batchRunning) return;
      batchRunning = true; btn.disabled = true;
      var songs = S.stResults.slice();
      var asu = (window.annieSettings && window.annieSettings.ui) || {};
      var done = 0, fail = 0;
      (function step(i) {
        if (i >= songs.length) {
          batchRunning = false; btn.disabled = false;
          btn.textContent = '⬇ 下载已加载 ' + S.stResults.length + ' 首';
          renderStreamStatus('批量下载完成：成功 ' + done + ' 首' + (fail ? '，失败 ' + fail + ' 首' : ''));
          return;
        }
        var song = songs[i];
        btn.textContent = '下载中 ' + (i + 1) + '/' + songs.length;
        renderStreamStatus('批量下载 ' + (i + 1) + '/' + songs.length + '：' + song.name);
        window.mine.streamDownload({
          provider: song.provider || S.stProvider, quality: S.stQuality, song: song,
          saveLrc: asu.saveLrc !== false, saveCover: asu.saveCover !== false,
          _dlKey: 'amb-' + Date.now() + '-' + i
        }).then(function () { done++; }).catch(function () { fail++; }).finally(function () { step(i + 1); });
      })(0);
    };
    c.appendChild(btn);
  }

  /* ---------------- 在线音乐视图（搜索 / 排行榜 / 歌单广场） ---------------- */
  function renderStreamView(c) {
    c.appendChild(el('div', 'am-view-h', '在线音乐'));

    // 页签 + 音质
    var bar = el('div', 'am-st-bar');
    var tabBox = el('div', 'am-st-pfs');
    [['search', '搜索'], ['boards', '排行榜'], ['lists', '歌单广场']].forEach(function (t) {
      var chip = el('button', 'am-chip' + (S.stTab === t[0] ? ' cur' : ''), t[1]);
      chip.onclick = function () { switchStreamTab(t[0]); };
      tabBox.appendChild(chip);
    });
    bar.appendChild(tabBox);
    var qSel = document.createElement('select');
    qSel.className = 'am-st-quality';
    [['flac24bit', 'Hi-Res'], ['flac', 'FLAC'], ['320k', '320K'], ['128k', '128K']].forEach(function (q) {
      var o = document.createElement('option'); o.value = q[0]; o.textContent = q[1]; qSel.appendChild(o);
    });
    qSel.value = S.stQuality;
    qSel.onchange = function () { S.stQuality = qSel.value; };
    bar.appendChild(qSel);
    c.appendChild(bar);

    // 平台
    var pfBar = el('div', 'am-st-bar');
    var pf = el('div', 'am-st-pfs');
    Object.keys(PLATFORMS).forEach(function (k) {
      var chip = el('button', 'am-chip' + (S.stProvider === k ? ' cur' : ''), PLATFORMS[k]);
      chip.onclick = function () { switchStreamProvider(k); };
      pf.appendChild(chip);
    });
    pfBar.appendChild(pf);
    c.appendChild(pfBar);

    // 搜索输入行（仅搜索页签）
    if (S.stTab === 'search') {
      var inpRow = el('div', 'am-st-inputrow');
      var inp = document.createElement('input');
      inp.className = 'am-st-input'; inp.placeholder = '搜索歌曲、艺人、专辑…（洛雪全平台音源）'; inp.value = S.stKw;
      inp.onkeydown = function (e) { if (e.key === 'Enter') { S.stKw = inp.value.trim(); doStreamSearch(true); } };
      var bGo = el('button', 'am-btn am-btn-accent', '搜索');
      bGo.onclick = function () { S.stKw = inp.value.trim(); doStreamSearch(true); };
      inpRow.appendChild(inp); inpRow.appendChild(bGo);
      // 搜索历史提示（datalist）
      var dl = el('datalist'); dl.id = 'am-st-history';
      stHist().forEach(function (h) { var o = document.createElement('option'); o.value = h; dl.appendChild(o); });
      inp.setAttribute('list', 'am-st-history');
      inpRow.appendChild(dl);
      c.appendChild(inpRow);
    }

    R.stStatus = el('div', 'am-st-status');
    c.appendChild(R.stStatus);

    if (S.stTab === 'boards') {
      // 榜单 chips（网格流式排列）
      var bdBox = el('div', 'am-st-pfs am-bd-pfs');
      S.boards.forEach(function (b) {
        var chip = el('button', 'am-chip' + (S.boardSel === b.bangid ? ' cur' : ''), b.name);
        chip.onclick = function () { loadBoardList(b.bangid, b.name, 1); };
        bdBox.appendChild(chip);
      });
      c.appendChild(bdBox);
      if (!S.stResults.length) {
        c.appendChild(el('div', 'am-empty', S.boards.length ? '选择一个榜单查看歌曲' : '正在加载榜单…'));
        return;
      }
      renderSongsTable(c);
      renderBatchDlBtn(c);
      if (S.bdPage < S.bdAllPage) renderMoreBtn(c, '加载更多（' + S.bdPage + '/' + S.bdAllPage + '）', function () { loadBoardList(S.boardSel, S.boardName, S.bdPage + 1); });
      return;
    }

    if (S.stTab === 'lists') {
      if (!S.slDetailId) {
        // V3.5.14：歌单链接 / ID 导入（自动识别平台并跳转详情）
        var impRow = el('div', 'am-st-inputrow');
        var impInp = document.createElement('input');
        impInp.className = 'am-st-input'; impInp.placeholder = '粘贴歌单链接或歌单 ID（自动识别平台）…';
        var bImp = el('button', 'am-btn', '导入歌单');
        function doImport() {
          var p = parsePlaylistInput(impInp.value);
          if (!p) { renderStreamStatus('无法识别：请粘贴五大平台歌单链接，或直接输入数字歌单 ID（按当前平台解析）', true); return; }
          if (p.provider !== S.stProvider) { S.stProvider = p.provider; S.stResults = []; S.stIndex = -1; }
          impInp.value = '';
          loadSongListDetail(p.id, '导入的歌单', 1);
        }
        impInp.onkeydown = function (e) { if (e.key === 'Enter') doImport(); };
        bImp.onclick = doImport;
        impRow.appendChild(impInp); impRow.appendChild(bImp);
        c.appendChild(impRow);
        // V3.5.8：收藏的歌单（当前平台，点击直达，✕ 移除）
        var favs = slFavs().filter(function (f) { return f.provider === S.stProvider; });
        if (favs.length) {
          c.appendChild(el('div', 'am-view-h', '收藏的歌单'));
          var fbox = el('div', 'am-st-pfs');
          fbox.style.marginBottom = '14px';
          favs.forEach(function (f) {
            var chip = el('span', 'am-chip');
            chip.appendChild(el('span', '', f.name));
            chip.onclick = function () { loadSongListDetail(f.id, f.name, 1); };
            var x = el('span', 'am-chip-x', '✕');
            x.title = '移除收藏';
            x.onclick = function (e) {
              e.stopPropagation();
              slFavSave(slFavs().filter(function (v) { return !(v.id === f.id && v.provider === f.provider); }));
              renderView();
            };
            chip.appendChild(x);
            fbox.appendChild(chip);
          });
          c.appendChild(fbox);
        }
        // 歌单卡片网格
        if (!S.slLists.length) { c.appendChild(el('div', 'am-empty', '正在加载歌单…')); return; }
        var grid = el('div', 'am-sl-grid');
        S.slLists.forEach(function (pl) {
          var card = el('div', 'am-sl-card');
          var img = el('img', 'am-sl-cover'); img.alt = ''; img.loading = 'lazy';
          if (pl.img) { img.src = pl.img; img.onerror = function () { img.style.visibility = 'hidden'; }; }
          else img.style.visibility = 'hidden';
          card.appendChild(img);
          card.appendChild(el('div', 'am-sl-name', esc(pl.name)));
          card.appendChild(el('div', 'am-sl-meta', (pl.playCount ? pl.playCount + ' 播放' : '') + (pl.total ? ' · ' + pl.total + ' 首' : '')));
          card.onclick = function () { loadSongListDetail(pl.id, pl.name, 1); };
          grid.appendChild(card);
        });
        c.appendChild(grid);
        if (S.slPage * S.slLimit < S.slTotal) renderMoreBtn(c, '加载更多歌单（' + S.slLists.length + '/' + S.slTotal + '）', function () { loadSongLists(S.slPage + 1); });
        return;
      }
      // 歌单详情（返回 + 歌曲表）
      var barD = el('div'); barD.style.cssText = 'display:flex;gap:10px;margin-bottom:10px';
      var back = el('button', 'am-btn', '‹ 返回歌单广场');
      back.onclick = function () { S.slDetailId = ''; S.slDetailName = ''; S.stResults = S.tabSongs.lists = []; renderView(); };
      barD.appendChild(back);
      // V3.5.8：收藏歌单（★ 已收藏 / ☆ 未收藏）
      var bFav = el('button', 'am-btn', slIsFav(S.slDetailId) ? '★ 已收藏' : '☆ 收藏歌单');
      bFav.onclick = function () {
        var a = slFavs();
        var fi = a.findIndex(function (f) { return f.id === S.slDetailId && f.provider === S.stProvider; });
        if (fi >= 0) a.splice(fi, 1);
        else a.unshift({ id: S.slDetailId, name: S.slDetailName, provider: S.stProvider, at: Date.now() });
        slFavSave(a);
        bFav.textContent = slIsFav(S.slDetailId) ? '★ 已收藏' : '☆ 收藏歌单';
      };
      barD.appendChild(bFav);
      c.appendChild(barD);
      c.appendChild(el('div', 'am-view-h', esc(S.slDetailName)));
      if (!S.stResults.length) { c.appendChild(el('div', 'am-empty', '正在加载歌单歌曲…')); return; }
      renderSongsTable(c);
      renderBatchDlBtn(c);
      if (S.slDPage * S.slDLimit < S.slDTotal) renderMoreBtn(c, '加载更多（已加载 ' + S.stResults.length + '/' + S.slDTotal + '）', function () { loadSongListDetail(S.slDetailId, S.slDetailName, S.slDPage + 1); });
      return;
    }

    // 搜索页签
    if (!S.stResults.length) {
      c.appendChild(el('div', 'am-empty', S.stKw ? '无结果' : '输入关键词，从五大平台搜索在线音乐'));
      return;
    }
    renderSongsTable(c);
    renderBatchDlBtn(c);
    if (S.stPage < S.stAllPage && !S.stSearching) {
      renderMoreBtn(c, '加载更多（' + S.stPage + '/' + S.stAllPage + '）', function () { doStreamSearch(false); });
    }
  }


  /* 注册到模块桥（供其他分片取用） */
  AM.renderStreamStatus = renderStreamStatus;
  AM.playStreamAt = playStreamAt;
  AM.nextStream = nextStream;
  AM.prevStream = prevStream;
  AM.patchStreamPlayNext = patchStreamPlayNext;
  AM.renderStreamView = renderStreamView;
})();
