/* ===== V4.6：Apple Music 音源（章鱼解密链路）=====
 * 侧栏 🍎 入口：链接/ID 解析 + 搜索，曲目点击经本地 HTTP 解密服务播放（P1 仅 AAC，Range 支持 seek 瞬时）。
 * wrapper-lite 未运行时显示引导。复用 AM 现有样式类，不新增 CSS。 */
(function () {
  'use strict';
  var AM = window.__annieAMInternal;
  if (!AM) return;
  var S = AM.S, R = AM.R;

  function el(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }
  function fmtT(ms) { var sec = Math.max(0, Math.round((ms || 0) / 1000)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

  /* 下载音质（全档位：aac / aac128 / he-aac / alac / atmos） */
  var DL_QUALITIES = [
    ['alac', 'ALAC 无损（最高 24bit/192kHz）'],
    ['atmos', '杜比全景声（空间音频 EC-3）'],
    ['aac', 'AAC 256K（标准立体声）'],
    ['aac128', 'AAC 128K（小文件）'],
    ['he-aac', 'HE-AAC 64K（高压缩省流量）'],
  ];
  var DL_QLABELS = { 'aac': 'AAC 256K', 'aac128': 'AAC 128K', 'he-aac': 'HE-AAC 64K', 'alac': 'ALAC 无损', 'atmos': '杜比全景声' };
  function dlQuality() {
    var q = localStorage.getItem('annieplayer.am.dlq') || 'aac';
    return DL_QLABELS[q] ? q : 'aac';
  }
  function setDlQuality(q) {
    try { localStorage.setItem('annieplayer.am.dlq', q); } catch (e) { }
  }
  /* 播放音质（P2：aac 缓冲式 / alac 流式无损） */
  function playQuality() {
    var q = localStorage.getItem('annieplayer.am.playq') || 'aac';
    return q === 'alac' ? 'alac' : 'aac';
  }
  function setPlayQuality(q) {
    try { localStorage.setItem('annieplayer.am.playq', q); } catch (e) { }
  }

  var AMV = {
    st: null,          // am:status 结果
    kw: '', results: [], albums: [], busy: false, err: '',
    parsed: null,      // { kind, album, tracks }
    playQueue: [], playIndex: -1,
  };

  function toast(msg) { try { if (typeof proToast === 'function') proToast(msg); } catch (e) { } }
  function setErr(e) { AMV.err = typeof e === 'string' ? e : ('操作失败：' + ((e && e.message) || e)); }
  function refresh() { if (S.view === 'amusic') AM.renderView(); }

  /* 进入视图时拉状态 + 暖服务（节流：同一视图停留期间 30 秒内只握手一次，防 renderView 重绘风暴） */
  var _lastEnter = 0;
  function enter() {
    var now = Date.now();
    if (now - _lastEnter < 30000 && AMV.st) return; // 30 秒节流
    _lastEnter = now;
    window.mine.amStatus().then(function (st) { AMV.st = st; refresh(); }).catch(function () { });
    window.mine.amEnsureService().catch(function () { }); // 懒启动播放服务
  }

  /* 播放（走本地 HTTP 解密服务；连播守卫 provider==='am' + amid） */
  function playTrack(song, queue, index) {
    if (queue && queue.length) { AMV.playQueue = queue.slice(); AMV.playIndex = index || 0; }
    else { AMV.playQueue = [song]; AMV.playIndex = 0; }
    patchAmTransport();
    doPlay(song);
  }
  /* 预热下一首 playlist（切歌加速：后台提前解析 master/media playlist，命中缓存首 chunk 秒出，fire-and-forget） */
  function prefetchNext(pq) {
    var nxt = AMV.playQueue[AMV.playIndex + 1];
    if (!nxt || !nxt.id) return;
    window.mine.amPrefetch({ id: String(nxt.id), codec: pq }).catch(function () { });
  }
  /* V4.6：播放加载进度卡——轮询解密服务 /progress，展示真实阶段与分片进度，避免「点了半天没反应」 */
  var _loadToken = 0, _loadCard = null, _loadTimer = 0;
  function loadCardHide() {
    _loadToken++;
    if (_loadTimer) { clearInterval(_loadTimer); _loadTimer = 0; }
    if (_loadCard) { try { _loadCard.remove(); } catch (e) { } _loadCard = null; }
  }
  function loadCardShow(song, url, codec) {
    loadCardHide();
    var root = document.getElementById('am-root');
    if (!root) return;
    var tk = ++_loadToken;
    var card = el('div', 'am-load-card');
    var spin = el('span', 'am-load-spin');
    card.appendChild(spin);
    var txt = el('span', 'am-load-text', '正在加载「' + (song.name || '') + '」…');
    card.appendChild(txt);
    var barW = el('span', 'am-load-bar'), bar = el('i');
    barW.appendChild(bar); card.appendChild(barW);
    root.appendChild(card); _loadCard = card;
    var STAGE = { idle: '准备中', playlist: '解析播放列表', key: '获取密钥', init: '读取音频头', segments: '下载分片', remux: '封装音频', done: '等待引擎就绪' };
    var t0 = Date.now();
    /* 真正开始播放（state.playing 且 currentPath 就是这条流）→ 绿勾「加载成功」停留 3 秒再收卡 */
    function succeed() {
      if (tk !== _loadToken || !_loadCard) return;
      if (_loadTimer) { clearInterval(_loadTimer); _loadTimer = 0; }
      spin.className = 'am-load-ok'; spin.textContent = '✓';
      bar.style.width = '100%';
      txt.textContent = '「' + (song.name || '') + '」加载成功，开始播放';
      setTimeout(function () { if (tk === _loadToken) loadCardHide(); }, 3000);
    }
    setTimeout(function () { if (tk === _loadToken) loadCardHide(); }, 90e3); // 兜底 90s 自动收卡
    /* 两阶段闩锁：切歌瞬间 currentPath 已是新歌但 playing 还是上一首的残留 true——
       必须先观察到「这首歌没在播」（引擎 loading 事件把 playing 拉低）再武装，
       之后 playing 重新为真才是这首歌真的出声了，否则切歌会秒跳「加载成功」 */
    var armed = false;
    _loadTimer = setInterval(function () {
      if (tk !== _loadToken) return;
      var onThis = state.playing && state.currentPath === url;
      if (!armed) { if (!onThis) armed = true; return; }
      if (onThis) { succeed(); return; }
      // 渲染层 CSP（connect-src 'self'）禁直连 127.0.0.1 服务，进度改走 IPC 读主进程内存
      window.mine.amProgress({ id: String(song.id), codec: codec }).then(function (p) {
        if (tk !== _loadToken || !_loadCard) return;
        var extra = '';
        if (p && p.stage === 'segments' && p.total) {
          extra = ' ' + (p.done || 0) + '/' + p.total;
          bar.style.width = Math.min(100, Math.round((p.done || 0) / p.total * 100)) + '%';
        } else if (p && p.bytes) {
          extra = ' ' + (p.bytes / 1048576).toFixed(1) + 'MB';
          bar.style.width = '100%';
        }
        txt.textContent = '正在加载「' + (song.name || '') + '」· ' + (STAGE[p && p.stage] || '准备中') + extra + '（' + Math.round((Date.now() - t0) / 1000) + 's）';
      }).catch(function () { });
    }, 300);
  }
  /* 播放失败：红叉「加载失败」停留 3 秒再收卡 */
  function loadCardFail(msg) {
    if (!_loadCard) return;
    var tk = _loadToken;
    if (_loadTimer) { clearInterval(_loadTimer); _loadTimer = 0; }
    var spin = _loadCard.querySelector('.am-load-spin');
    if (spin) { spin.className = 'am-load-ok am-load-ng'; spin.textContent = '✕'; }
    var txt = _loadCard.querySelector('.am-load-text');
    if (txt) txt.textContent = msg || '加载失败';
    setTimeout(function () { if (tk === _loadToken) loadCardHide(); }, 3000);
  }
  function doPlay(song) {
    AMV.err = '';
    var pq = playQuality();
    prefetchNext(pq);
    window.mine.amSongUrl({ song: song, codec: pq }).then(function (f) {
      if (!f || !f.playable || !f.url) { setErr((f && f.message) || '未取到播放地址'); refresh(); return; }
      S.fmt = pq === 'alac' ? 'ALAC · 无损' : 'AAC · 256K';
      if (AM.refreshBadge) AM.refreshBadge();
      loadCardShow(song, f.url, pq); // V4.6：加载进度卡（出声/失败/超时自动收）
      Promise.resolve(window.annieStreamPlay({
        url: f.url,
        title: song.name || '', artist: song.artist || '', album: song.album || '',
        cover: song.cover || '', duration: (song.duration || 0) / 1000,
        provider: 'am', quality: f.quality || (pq === 'alac' ? 'Apple Music ALAC' : 'Apple Music AAC'),
        song: song, /* V4.6：带原始 song 对象 → 进播放缓存（边播边存，再播秒开） */
        amid: String(song.id || ''),
        onPlayed: function () { fetchLyric(song); },
      })).then(function (ok) { if (ok === false) loadCardFail('「' + (song.name || '') + '」加载失败，请重试'); });
    }).catch(function (e) { setErr(e); refresh(); loadCardFail('「' + (song.name || '') + '」加载失败：' + ((e && e.message) || e)); });
  }

  /* 歌词：AM 侧三轨（正文/翻译/罗马音）灌入安妮缓存键 */
  function fetchLyric(song) {
    if (!song || !song.id) return;
    window.mine.amLyric({ id: String(song.id), lang: 'zh-Hans' }).then(function (r) {
      if (!r) return;
      var path = state.currentPath; if (!path) return;
      try {
        if (r.lrc) { window.__annieStreamLrcByPath = window.__annieStreamLrcByPath || {}; window.__annieStreamLrcByPath[path] = r.lrc; }
        if (r.tlyric) { window.__annieStreamTlyByPath = window.__annieStreamTlyByPath || {}; window.__annieStreamTlyByPath[path] = r.tlyric; }
        document.dispatchEvent(new CustomEvent('annie-stream-lyric', { detail: { path: path } }));
      } catch (e) { }
    }).catch(function () { });
  }

  /* 连播：包装 annieStream.playNext/playPrev（同 Qobuz 模式） */
  function patchAmTransport() {
    if (AMV._tpPatched) return;
    AMV._tpPatched = true;
    function curOk() {
      var cs = (typeof state !== 'undefined') && state.currentStream;
      var cur = AMV.playQueue[AMV.playIndex];
      return !!(cs && cs.provider === 'am' && cs.amid && cur && String(cur.id) === cs.amid);
    }
    function amPlay(i) {
      var e = AMV.playQueue[i];
      if (!e) return;
      AMV.playIndex = i;
      doPlay(e);
    }
    var st = window.annieStream;
    if (st && st.playNext && !st.__amPatched) {
      st.__amPatched = true;
      var oldNext = st.playNext.bind(st), oldPrev = st.playPrev ? st.playPrev.bind(st) : null;
      st.playNext = function (pos) { if (curOk() && AMV.playIndex < AMV.playQueue.length - 1) { amPlay(AMV.playIndex + 1); return; } oldNext(pos); };
      if (oldPrev) st.playPrev = function (pos) { if (curOk() && AMV.playIndex > 0) { amPlay(AMV.playIndex - 1); return; } oldPrev(pos); };
    }
  }

  /* ---------------- 视图渲染 ---------------- */
  function trackRow(t, list, idx) {
    var tr = el('div', 'am-sl-track');
    tr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer';
    tr.onmouseenter = function () { tr.style.background = 'var(--am-glass-2)'; };
    tr.onmouseleave = function () { tr.style.background = ''; };
    var cov = el('img'); cov.style.cssText = 'width:38px;height:38px;border-radius:6px;object-fit:cover;flex:none;background:var(--am-glass-2)';
    cov.draggable = false;
    if (t.cover) cov.src = t.cover;
    var info = el('div'); info.style.cssText = 'flex:1;min-width:0';
    var tt = el('div', '', t.name || '?'); tt.style.cssText = 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    var sub = el('div', '', (t.artist || '') + (t.album ? ' — ' + t.album : '')); sub.style.cssText = 'font-size:12px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    info.appendChild(tt); info.appendChild(sub);
    var dur = el('div', '', fmtT(t.duration)); dur.style.cssText = 'font-size:12px;opacity:.55;font-variant-numeric:tabular-nums;flex:none';
    /* ♥ 收藏到在线歌单（复用国内流媒体的歌单选择器） */
    var bFav = el('button', 'am-tbtn', '♥'); bFav.title = '收藏到在线歌单';
    bFav.style.cssText = 'flex:none;opacity:0;transition:opacity .15s';
    bFav.onclick = function (e) {
      e.stopPropagation();
      if (AM.openSplPicker) AM.openSplPicker(e.clientX, e.clientY, [t]);
    };
    tr.appendChild(bFav);
    /* 下载按钮（P1：接 dlManager，标签/封面/歌词全套落盘） */
    var bDl = el('button', 'am-tbtn', '⬇'); bDl.title = '下载（含标签/封面/歌词）';
    bDl.style.cssText = 'flex:none;opacity:0;transition:opacity .15s';
    tr.appendChild(bDl);
    tr.onmouseenter = function () { tr.style.background = 'var(--am-glass-2)'; bDl.style.opacity = '1'; bFav.style.opacity = '1'; };
    tr.onmouseleave = function () { tr.style.background = ''; bDl.style.opacity = '0'; bFav.style.opacity = '0'; };
    bDl.onclick = function (e) {
      e.stopPropagation();
      var q = dlQuality();
      window.mine.dlAdd([{ provider: 'am', quality: q, song: t, saveLrc: true, saveCover: true }]).then(function (r) {
        toast(r && r.added ? '已加入下载队列（' + (DL_QLABELS[q] || 'AAC 256K') + '）' : '已在队列中');
      }).catch(function (e2) { setErr(e2); refresh(); });
    };
    tr.appendChild(cov); tr.appendChild(info); tr.appendChild(dur);
    tr.onclick = function () { playTrack(t, list, idx); };
    return tr;
  }

  function renderAmView(c) {
    var head = el('div'); head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap';
    head.appendChild(el('div', 'am-view-h', 'Apple Music'));
    var stTxt = '检测中…';
    if (AMV.st) stTxt = AMV.st.ok ? 'wrapper 已连接' : 'wrapper 未运行';
    var stEl = el('span', 'am-c-dim', stTxt);
    if (AMV.st && !AMV.st.ok) stEl.style.color = '#e11d48';
    head.appendChild(stEl);
    /* 播放音质选择（P2：AAC 缓冲式 / ALAC 流式无损） */
    head.appendChild(el('span', 'am-c-dim', '播放音质'));
    var psel = el('button', 'am-btn', playQuality() === 'alac' ? 'ALAC 无损' : 'AAC 256K');
    psel.style.cssText = 'padding:4px 10px;font-size:12px';
    psel.onclick = function (e) {
      e.stopPropagation();
      var pop = document.querySelector('#am-root .am-pop') || R.pop;
      if (!pop) return;
      pop.innerHTML = ''; pop.classList.add('on');
      [['aac', 'AAC 256K（起播快，缓冲式）'], ['alac', 'ALAC 无损（流式，最高 24/192）']].forEach(function (kv) {
        var it = el('button', 'am-pop-item', kv[1]);
        if (playQuality() === kv[0]) it.style.fontWeight = '700';
        it.onclick = function () { setPlayQuality(kv[0]); pop.classList.remove('on'); refresh(); };
        pop.appendChild(it);
      });
      var pr = psel.getBoundingClientRect();
      pop.style.left = pr.left + 'px'; pop.style.top = (pr.bottom + 6) + 'px';
    };
    head.appendChild(psel);
    /* 下载音质选择（P1：AAC / ALAC 无损） */
    head.appendChild(el('span', 'am-c-dim', '下载音质'));
    var qsel = el('button', 'am-btn', DL_QLABELS[dlQuality()] || 'AAC 256K');
    qsel.style.cssText = 'padding:4px 10px;font-size:12px';
    qsel.onclick = function (e) {
      e.stopPropagation(); // 防 document 外点监听立刻关弹层（am-dom.js:1010）
      var pop = document.querySelector('#am-root .am-pop') || R.pop;
      if (!pop) { toast('弹层组件未就绪'); return; }
      pop.innerHTML = '';
      pop.classList.add('on');
      DL_QUALITIES.forEach(function (kv) {
        var it = el('button', 'am-pop-item', kv[1]);
        if (dlQuality() === kv[0]) it.style.fontWeight = '700';
        it.onclick = function () { setDlQuality(kv[0]); pop.classList.remove('on'); refresh(); };
        pop.appendChild(it);
      });
      var r = qsel.getBoundingClientRect();
      pop.style.left = r.left + 'px'; pop.style.top = (r.bottom + 6) + 'px';
      // R.pop 已在 DOM 中（am-dom.js 构建时挂 #am-root），外点关闭由全局监听负责
    };
    head.appendChild(qsel);
    c.appendChild(head);

    /* wrapper 未运行引导 */
    if (AMV.st && !AMV.st.ok) {
      var guide = el('div'); guide.style.cssText = 'padding:14px 16px;border-radius:12px;background:var(--am-glass-2);margin-bottom:12px;line-height:1.8';
      guide.appendChild(el('div', '', '⚠️ Apple Music 解密服务（wrapper-lite）未运行'));
      guide.appendChild(el('div', 'am-c-dim', '请先启动 wrapper-lite：解压目录下双击 2-start-server.bat，待窗口显示服务就绪后回到本页。'));
      guide.appendChild(el('div', 'am-c-dim', '首次使用需在 wrapper 窗口扫码登录 Apple ID（建议小号），登录态永久缓存。'));
      var bRe = el('button', 'am-btn', '↻ 重新检测');
      bRe.style.marginTop = '8px';
      bRe.onclick = function () { _lastEnter = 0; enter(); }; // 手动重测绕过节流
      guide.appendChild(bRe);
      c.appendChild(guide);
    }

    /* 搜索 */
    var row = el('div', 'am-st-inputrow');
    var inp = document.createElement('input'); inp.className = 'am-st-input'; inp.placeholder = '搜索 Apple Music（歌曲/专辑）…'; inp.value = AMV.kw;
    inp.onkeydown = function (e) { if (e.key === 'Enter') doSearch(inp.value.trim()); };
    var bS = el('button', 'am-btn', '搜索');
    bS.onclick = function () { doSearch(inp.value.trim()); };
    row.appendChild(inp); row.appendChild(bS);
    c.appendChild(row);

    /* 链接/ID 解析 */
    var row2 = el('div', 'am-st-inputrow');
    var inp2 = document.createElement('input'); inp2.className = 'am-st-input'; inp2.placeholder = '粘贴 Apple Music 链接（歌曲/专辑/歌单）…';
    inp2.onkeydown = function (e) { if (e.key === 'Enter') doResolve(inp2.value.trim(), inp2); };
    var bR = el('button', 'am-btn', '解析');
    bR.onclick = function () { doResolve(inp2.value.trim(), inp2); };
    row2.appendChild(inp2); row2.appendChild(bR);
    c.appendChild(row2);

    if (AMV.err) { var eb = el('div', 'am-c-dim', AMV.err); eb.style.cssText = 'color:#e11d48;margin:8px 0'; c.appendChild(eb); }
    if (AMV.busy) { c.appendChild(el('div', 'am-c-dim', '加载中…')); return; }

    /* 解析结果（专辑/歌单详情） */
    if (AMV.parsed && AMV.parsed.tracks && AMV.parsed.tracks.length) {
      var p = AMV.parsed;
      var h = el('div', 'am-view-h', (p.album ? (p.album.title || p.album.name || '') : '解析结果') + '（' + p.tracks.length + ' 首）');
      h.style.margin = '14px 0 6px';
      c.appendChild(h);
      var bAll = el('button', 'am-btn', '▶ 全部播放');
      bAll.style.marginBottom = '8px';
      bAll.onclick = function () { playTrack(p.tracks[0], p.tracks, 0); };
      c.appendChild(bAll);
      var list = el('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:2px';
      p.tracks.forEach(function (t, i) { list.appendChild(trackRow(t, p.tracks, i)); });
      c.appendChild(list);
      return;
    }

    /* 搜索结果 */
    if (AMV.results.length) {
      c.appendChild(el('div', 'am-view-h', '单曲'));
      var list2 = el('div'); list2.style.cssText = 'display:flex;flex-direction:column;gap:2px';
      AMV.results.forEach(function (t, i) { list2.appendChild(trackRow(t, AMV.results, i)); });
      c.appendChild(list2);
    }
    if (AMV.albums.length) {
      var ah = el('div', 'am-view-h', '专辑'); ah.style.marginTop = '14px';
      c.appendChild(ah);
      var grid = el('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px';
      AMV.albums.forEach(function (a) {
        var card = el('div'); card.style.cssText = 'cursor:pointer';
        var im = el('img'); im.style.cssText = 'width:100%;aspect-ratio:1;border-radius:10px;object-fit:cover;background:var(--am-glass-2)';
        im.draggable = false;
        var art = a.artwork || (a.attributes && a.attributes.artwork && a.attributes.artwork.url) || '';
        if (art) im.src = String(art).replace('{w}x{h}', '300x300') + (/\.(jpg|png)$/i.test(art) ? '' : '.jpg');
        var nm = el('div', '', a.name || (a.attributes && a.attributes.name) || '?');
        nm.style.cssText = 'font-size:13px;font-weight:600;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        card.appendChild(im); card.appendChild(nm);
        card.onclick = function () {
          var aid = a.id || (a.attributes && a.attributes.playParams && a.attributes.playParams.id) || '';
          if (aid) doResolve('https://music.apple.com/cn/album/x/' + aid, null);
        };
        grid.appendChild(card);
      });
      c.appendChild(grid);
    }
  }

  function doSearch(kw) {
    if (!kw) return;
    AMV.kw = kw; AMV.busy = true; AMV.err = ''; AMV.parsed = null; refresh();
    window.mine.amSearch({ keywords: kw, storefront: 'cn', limit: 25 }).then(function (r) {
      AMV.busy = false;
      AMV.results = r.songs || []; AMV.albums = r.albums || [];
      if (!AMV.results.length && !AMV.albums.length) AMV.err = '没有搜到结果';
      refresh();
    }).catch(function (e) { AMV.busy = false; setErr(e); refresh(); });
  }

  function doResolve(text, inp) {
    if (!text) return;
    AMV.busy = true; AMV.err = ''; refresh();
    window.mine.amResolve(text).then(function (r) {
      AMV.busy = false;
      if (inp) inp.value = '';
      if (r.tracks && r.tracks.length) { AMV.parsed = r; AMV.results = []; AMV.albums = []; }
      else AMV.err = '解析成功但无曲目';
      refresh();
    }).catch(function (e) { AMV.busy = false; setErr(e); refresh(); });
  }

  /* 注册到 AM 桥 */
  AM.renderAmusicView = renderAmView;
  AM.amEnter = enter;
})();
