'use strict';
/* Pro beat0.0.1 —— 交互与界面（渲染侧）
 * 迷你模式 / 桌面歌词（主窗口侧）/ Now Playing 全屏 / 拖放 / 命令面板(Ctrl+K) / 托盘动作。
 * 双主题共用；依赖 player.js 全局（state / playAt / proToast）与 fb2k.js 的全局行为。 */
(function () {
  if (typeof state === 'undefined') return;
  const $ = (s) => document.querySelector(s);
  const AUDIO_RE = /\.(flac|mp3|wav|ape|m4a|aac|alac|aiff?|ogg|opus|wma|dsf|dff|tta|wv|mka|mp2)$/i;

  /* ================== 迷你模式（主窗口形态切换，位置记忆） ================== */
  const MINI_LS = 'annieplayer.pro.mini.bounds';
  let miniOn = false;
  let miniBar = null;

  function buildMiniBar() {
    if (miniBar) return;
    miniBar = document.createElement('div');
    miniBar.id = 'mini-bar';
    miniBar.style.display = 'none'; // 初始隐藏，仅迷你模式开启时显示
    miniBar.innerHTML =
      '<img id="mini-cover" alt="">' +
      '<div class="mini-mid">' +
      '  <div id="mini-title">—</div>' +
      '  <div id="mini-sub">—</div>' +
      '  <div class="mini-prog"><div id="mini-prog-fill"></div></div>' +
      '</div>' +
      '<div class="mini-btns">' +
      '  <button id="mini-prev" title="上一首">⏮</button>' +
      '  <button id="mini-play" title="播放/暂停">▶</button>' +
      '  <button id="mini-next" title="下一首">⏭</button>' +
      '  <button id="mini-exit" title="退出迷你模式">✕</button>' +
      '</div>';
    document.body.appendChild(miniBar);
    $('#mini-play').onclick = () => $('#btn-play').click();
    $('#mini-next').onclick = () => playAt(state.index + 1);
    $('#mini-prev').onclick = () => { if (state.position > 3) playAt(state.index); else playAt(Math.max(0, state.index - 1)); };
    $('#mini-exit').onclick = () => toggleMini(false);
    setInterval(miniTick, 400);
  }

  function miniTick() {
    if (!miniOn) return;
    const t = nowTrack();
    // V1.1.10：实时 meta（title/artist/album）优先 state.metaCache——library.metaCache 无这些字段
    const m = t && !t.url ? (state.metaCache.get(t.path) || {}) : {};
    const title = m.title || (t && (t.title || (t.name ? t.name.replace(/\.[^.]+$/, '') : '—'))) || '—';
    const sub = t ? (
      (m.artist || m.album) ? [m.artist, m.album].filter(Boolean).join(' · ')
        : (t.url ? [t.artist, t.album].filter(Boolean).join(' · ') : t.dir)
    ) : '';
    $('#mini-title').textContent = title;
    $('#mini-sub').textContent = sub;
    const d = state.duration || 0;
    $('#mini-prog-fill').style.width = d > 0 ? Math.min(100, state.position / d * 100) + '%' : '0%';
    $('#mini-play').textContent = state.playing ? '⏸' : '▶';
    const coverKey = t ? (t.path || t.url) : '';
    const coverSrc = npfCoverCache.get(coverKey) || null;
    if (coverSrc) $('#mini-cover').src = coverSrc;
    else if (t) npfLoadCover(t); // 触发加载（回填缓存后下轮 tick 生效）
  }

  async function toggleMini(force) {
    const want = force !== undefined ? force : !miniOn;
    if (want === miniOn) return;
    if (want) {
      buildMiniBar();
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(MINI_LS) || 'null'); } catch { }
      const r = await window.mine.miniEnter(saved).catch(() => null);
      if (!r || !r.ok) return;
      miniOn = true;
      miniBar.style.display = 'flex'; // 修复：进入时显示
      document.body.classList.add('mini');
    } else {
      const r = await window.mine.miniExit().catch(() => null);
      miniOn = false;
      miniBar.style.display = 'none'; // 修复：退出时必须隐藏（fixed inset:0 不透明层，否则会盖住整个主界面）
      document.body.classList.remove('mini');
      if (r && r.miniBounds) { try { localStorage.setItem(MINI_LS, JSON.stringify(r.miniBounds)); } catch { } }
    }
  }

  /* ================== 桌面歌词（主窗口侧：开关 + 歌词行转发） ================== */
  let dlyrOn = false;
  async function toggleDlyrics(force) {
    const want = force !== undefined ? force : !dlyrOn;
    if (want === dlyrOn) return;
    const r = await window.mine.dlyricsToggle().catch(() => null);
    if (!r) return;
    dlyrOn = !!r.shown;
  }
  window.mine.onDlyricsClosed(() => { dlyrOn = false; });
  /* ---- 自同步歌词轨（主题无关：直读 .lrc，按引擎绝对位置同步；CUE 分轨时间轴天然对齐整轨 lrc） ---- */
  let lyrFor = null, lyrLines = [], lyrAbs = 0;
  function parseLrc(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const tags = raw.match(/\[\d+:\d+(?:\.\d+)?\]/g);
      if (!tags) continue;
      const txt = raw.replace(/\[[^\]]*\]/g, '').trim();
      if (!txt) continue;
      for (const tag of tags) {
        const mm = /\[(\d+):(\d+(?:\.\d+)?)\]/.exec(tag);
        out.push({ t: (+mm[1]) * 60 + (+mm[2]), text: txt });
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }
  function lyrLoad(path) {
    lyrFor = path || null;
    lyrLines = [];
    if (!path || path.startsWith('http')) return;
    const real = path.includes('#cue') ? path.slice(0, path.indexOf('#cue')) : path;
    window.mine.lyrics(real).then(r => {
      if (lyrFor !== path) return;
      if (r && r.ok && r.text) lyrLines = parseLrc(r.text);
    }).catch(() => { });
  }
  function getLyric() {
    if (!lyrLines.length) return { cur: '', next: '' };
    let i = -1;
    for (let k = 0; k < lyrLines.length; k++) { if (lyrLines[k].t <= lyrAbs + 0.15) i = k; else break; }
    if (i < 0) return { cur: '', next: lyrLines[0].text };
    return { cur: lyrLines[i].text, next: i + 1 < lyrLines.length ? lyrLines[i + 1].text : '' };
  }
  window.mine.onEngineEvent((event, d) => {
    if (event !== 'position') return;
    lyrAbs = d.seconds || 0;
    if (state.currentPath !== lyrFor) lyrLoad(state.currentPath);
  });
  setInterval(() => {
    if (!dlyrOn) return;
    const l = getLyric();
    const t = state.queue[state.index];
    window.mine.dlyricsLine({ cur: l.cur, next: l.next, title: t ? t.name.replace(/\.[^.]+$/, '') : '' });
  }, 350);

  /* ================== Now Playing 全屏信息页 ================== */
  let npf = null, npfOn = false;
  /* 封面直读 meta（本地）/ track.cover（流媒体），按 path|url 缓存 */
  const npfCoverCache = new Map();
  /* 当前曲目：流媒体优先（流媒体播放时 index=-1，queue[-1] 为 undefined） */
  function nowTrack() {
    return state.currentStream || state.queue[state.index];
  }
  function npfLoadCover(track) {
    const path = track && (track.path || track.url);
    if (!path) return;
    const img = document.getElementById('npf-cover');
    const ph = document.getElementById('npf-cover-ph');
    const apply = (c) => {
      npfCoverCache.set(path, c);
      const cur = nowTrack();
      if (!npfOn || !cur || (cur.path || cur.url) !== path) return;
      if (c) { img.src = c; img.style.display = ''; ph.style.display = 'none'; }
      else { img.style.display = 'none'; ph.style.display = 'flex'; }
    };
    if (npfCoverCache.has(path)) {
      const c = npfCoverCache.get(path);
      if (c) { img.src = c; img.style.display = ''; ph.style.display = 'none'; }
      else { img.style.display = 'none'; ph.style.display = 'flex'; }
      return;
    }
    if (track.url && track.cover) {
      // 流媒体封面：http（kwcdn.kuwo.cn 等）需代理转 dataURL（CSP img-src 拦截）
      if (/^https?:\/\//i.test(track.cover) && window.mine.streamCoverProxy) {
        window.mine.streamCoverProxy(track.cover).then(r => apply(r && r.url ? r.url : null)).catch(() => apply(null));
      } else apply(track.cover);
    } else {
      // 本地：优先实时 metaCache（showMeta 已填充 cover dataURL），未命中再 IPC
      const cached = state.metaCache.get(path);
      if (cached && cached.cover) { apply(cached.cover); return; }
      window.mine.meta(path).then(m => apply(m && m.cover ? m.cover : null)).catch(() => apply(null));
    }
  }

  function buildNpf() {
    if (npf) return;
    npf = document.createElement('div');
    npf.id = 'np-full';
    npf.innerHTML =
      '<button id="npf-exit" title="退出 (Esc)">✕</button>' +
      '<div class="npf-left"><div id="npf-cover-ph">♪</div><img id="npf-cover" alt="" style="display:none"></div>' +
      '<div class="npf-right">' +
      '  <div id="npf-title">—</div>' +
      '  <div id="npf-artist">—</div>' +
      '  <div id="npf-lyr"><div id="npf-lyr-cur"></div><div id="npf-lyr-next"></div></div>' +
      '  <div class="npf-meters"><div class="npf-meter"><span>L</span><div class="npf-bar"><div id="npf-l"></div></div></div>' +
      '  <div class="npf-meter"><span>R</span><div class="npf-bar"><div id="npf-r"></div></div></div></div>' +
      '  <table id="npf-tech"></table>' +
      '</div>';
    document.body.appendChild(npf);
    $('#npf-exit').onclick = () => toggleNpf(false);
    window.mine.onEngineEvent((event, d) => {
      if (!npfOn || event !== 'level') return;
      $('#npf-l').style.width = Math.min(100, (d.peakL || 0) * 100) + '%';
      $('#npf-r').style.width = Math.min(100, (d.peakR || 0) * 100) + '%';
    });
    // 歌词行（自同步歌词轨，双主题一致）
    setInterval(() => {
      if (!npfOn) return;
      const l = getLyric();
      $('#npf-lyr-cur').textContent = l.cur;
      $('#npf-lyr-next').textContent = l.next;
      $('#npf-lyr').style.display = (l.cur || l.next) ? '' : 'none';
    }, 400);
  }

  function npfRefresh() {
    if (!npfOn) return;
    const t = nowTrack();
    // V1.1.10：实时 meta 在 state.metaCache（showMeta 播放时填充，含 title/artist/album/cover），
    // state.library.metaCache 只有曲库扫描字段（loudness 等）——用错缓存导致全屏无元数据。
    const mc = t && !t.url ? (state.metaCache.get(t.path) || state.library.metaCache[t.path] || {}) : {};
    const fmt = window.__lastFormat || {};
    // V1.1.10：共享模式（独占开关熄灭）下后端显示"WASAPI 共享"、输出状态标注系统重采样
    const isShared = !(typeof window.annieIsExclusive === 'function' ? window.annieIsExclusive() : true);
    const isDsd = fmt.bitDepth === 1;
    const inFmt = fmt.requestedRate ? (isDsd ? 'DSD ' + (fmt.requestedRate / 2822400).toFixed(0) + 'x' : (fmt.requestedRate / 1000) + 'kHz/' + (fmt.bitDepth || '?') + 'bit') : '-';
    if (t) npfLoadCover(t);
    else { document.getElementById('npf-cover').style.display = 'none'; document.getElementById('npf-cover-ph').style.display = 'flex'; }
    const title = mc.title || (t ? (t.title || (t.name ? t.name.replace(/\.[^.]+$/, '') : '')) : '') || '—';
    const artist = mc.artist || t.artist || '未知艺术家';
    const album = mc.album || t.album;
    $('#npf-title').textContent = title;
    $('#npf-artist').textContent = artist + (album ? ' · ' + album : '');
    const st = t && !t.url ? (state.library.stats || {})[t.path] : null;
    const loud = mc.loudness;
    const beat = window.annieViz && window.annieViz.beatInfo ? window.annieViz.beatInfo() : null;
    const rows = [
      ['文件', t ? (t.path || (t.url ? '流媒体' : '-')) : '-'],
      ['格式', (mc.codec || fmt.codec || (t && t.quality) || '-').toString().toUpperCase() + (mc.bitrate ? ' · ' + Math.round(mc.bitrate / 1000) + 'kbps' : '')],
      ['输出状态', inFmt + ' → ' + (fmt.outFormat || '-') + (isShared ? '（共享，系统重采样）' : fmt.bitPerfect ? '（Bit-perfect）' : fmt.reason ? '（' + fmt.reason + '）' : '')],
      ['后端', fmt.backend ? (fmt.backend === 'asio' ? 'ASIO' : (isShared ? 'WASAPI 共享' : 'WASAPI 独占')) + ' · ' + (fmt.device || '') : '-'],
      ['响度', loud ? loud.i.toFixed(1) + ' LUFS · 真峰 ' + loud.tp.toFixed(1) + ' dBTP' : '未分析'],
      ['BPM / 调性', beat && beat.bpm ? beat.bpm.toFixed(0) + ' BPM' + (beat.key ? ' · ' + beat.key : '') : '-'],
      ['统计', st ? '播放 ' + st.count + ' 次 · 累计 ' + Math.round(st.totalSec / 60) + ' 分钟' : '-'],
      ['播放进度', (state.position || 0).toFixed(0) + 's / ' + (state.duration || 0).toFixed(0) + 's']
    ];
    $('#npf-tech').innerHTML = rows.map(r => '<tr><td>' + r[0] + '</td><td>' + String(r[1]).replace(/</g, '&lt;') + '</td></tr>').join('');
  }

  function toggleNpf(force) {
    const want = force !== undefined ? force : !npfOn;
    if (want === npfOn) return;
    if (want) {
      buildNpf();
      npfOn = true;
      npf.classList.add('show');
      npfRefresh();
      npf.__timer = setInterval(npfRefresh, 1000);
      if (npf.requestFullscreen) npf.requestFullscreen().catch(() => { });
    } else {
      npfOn = false;
      clearInterval(npf.__timer);
      npf.classList.remove('show');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    }
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && npfOn) toggleNpf(false);
  });

  /* ================== 拖放支持 ================== */
  let dropIndicator = null;
  function showDropIndicator(y) {
    if (!dropIndicator) {
      dropIndicator = document.createElement('div');
      dropIndicator.id = 'drop-indicator';
      document.body.appendChild(dropIndicator);
    }
    dropIndicator.style.top = y + 'px';
    dropIndicator.classList.add('show');
  }
  function hideDropIndicator() { if (dropIndicator) dropIndicator.classList.remove('show'); }

  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // 列表区域：显示插入位置指示线
    const listEl = document.elementFromPoint(e.clientX, e.clientY);
    const row = listEl && listEl.closest ? listEl.closest('.track-row, .f2-row') : null;
    if (row) {
      const rect = row.getBoundingClientRect();
      showDropIndicator(e.clientY < rect.top + rect.height / 2 ? rect.top : rect.bottom);
    } else hideDropIndicator();
  });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) hideDropIndicator(); });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    hideDropIndicator();
    let paths = [];
    try { paths = [...e.dataTransfer.files].map(f => window.mine.getPathForFile(f)).filter(Boolean); } catch { }
    if (!paths.length) return;
    let tracks;
    try { tracks = await window.mine.dropExpand(paths); } catch (err) { proToast('拖入失败：' + err.message); return; }
    tracks = (tracks || []).filter(t => AUDIO_RE.test(t.path));
    if (!tracks.length) { proToast('无可播放的音频文件（已过滤不支持的类型）'); return; }

    // 落点在列表行 → 插入到该行位置；否则追加到队列尾部
    const listEl = document.elementFromPoint(e.clientX, e.clientY);
    const row = listEl && listEl.closest ? listEl.closest('.track-row, .f2-row') : null;
    if (row && row.dataset.qi !== undefined) {
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const idx = Math.max(0, +row.dataset.qi + (before ? 0 : 1));
      state.queue.splice(idx, 0, ...tracks);
      proToast('已在位置 ' + (idx + 1) + ' 插入 ' + tracks.length + ' 首');
    } else {
      state.queue.push(...tracks);
      proToast('已追加 ' + tracks.length + ' 首到播放队列');
    }
  });

  /* ================== 命令面板（Ctrl+K） ================== */
  let cmdk = null, cmdkItems = [], cmdkSel = 0;
  function cmdRegistry() {
    const reg = [];
    const add = (name, hint, fn) => reg.push({ name, hint, fn });
    add('播放 / 暂停', '播放控制', () => $('#btn-play').click());
    add('下一首', '播放控制', () => playAt(state.index + 1));
    add('上一首', '播放控制', () => { if (state.position > 3) playAt(state.index); else playAt(Math.max(0, state.index - 1)); });
    add('打开 EQ 面板', '音效', () => $('#btn-eq').click());
    add('EQ 开关', '音效', () => window.annieEQ && annieEQ.setEnabled(!annieEQ.state.enabled));
    ['flat', 'pop', 'rock', 'jazz', 'classical', 'bass', 'vocal'].forEach(p =>
      add('EQ 预设：' + p, '音效', () => window.annieEQ && annieEQ.setPreset(p)));
    add('切换主题（粒子舞台 ⇄ FB2K）', '界面', () => annieTheme.apply(annieTheme.current === 'fb2k' ? 'legacy' : 'fb2k'));
    ['gold:暗夜金', 'aurora:靛蓝极光', 'jade:翡翠深空', 'day:白昼'].forEach(s => {
      const [k, label] = s.split(':');
      add('配色：' + label, '界面', () => annieSettings.setPalette(k));
    });
    add('FB2K 暗色模式切换', '界面', () => window.annieFb2kDark && annieFb2kDark.toggle());
    add('扫描曲库', '曲库', () => window.mine.scanStart());
    add('假无损批量检测', '曲库', () => window.mine.fakeScanBatchStart(state.library.tracks.map(t => t.path)));
    add('响度均衡：关闭', '音质', () => annieSettings.update({ loudMode: 'off' }));
    add('响度均衡：按曲目', '音质', () => annieSettings.update({ loudMode: 'track' }));
    add('响度均衡：按专辑', '音质', () => annieSettings.update({ loudMode: 'album' }));
    add('DSD 输出：转 PCM', '音质', () => { annieSettings.update({ dsdMode: 'pcm' }); window.mine.engine('dsd.setMode', { mode: 'pcm' }); });
    add('DSD 输出：DoP', '音质', () => { annieSettings.update({ dsdMode: 'dop' }); window.mine.engine('dsd.setMode', { mode: 'dop' }); });
    add('迷你模式', '窗口', () => toggleMini());
    add('桌面歌词', '窗口', () => toggleDlyrics());
    add('Now Playing 全屏', '窗口', () => toggleNpf(true));
    add('打开设置', '窗口', () => annieSettings.togglePanel(true));
    return reg;
  }
  function fuzzy(q, s) {
    q = q.toLowerCase(); s = s.toLowerCase();
    let i = 0;
    for (const c of s) { if (c === q[i]) i++; if (i >= q.length) return true; }
    return false;
  }
  function buildCmdk() {
    if (cmdk) return;
    cmdk = document.createElement('div');
    cmdk.id = 'cmdk';
    cmdk.innerHTML = '<div id="cmdk-box"><input id="cmdk-input" placeholder="输入命令…（↑↓ 选择，回车执行，Esc 关闭）"><div id="cmdk-list"></div></div>';
    document.body.appendChild(cmdk);
    const input = $('#cmdk-input');
    input.addEventListener('input', renderCmdk);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSel = Math.min(cmdkSel + 1, cmdkItems.length - 1); renderCmdk(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSel = Math.max(cmdkSel - 1, 0); renderCmdk(); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = cmdkItems[cmdkSel]; closeCmdk(); if (it) it.fn(); }
      else if (e.key === 'Escape') closeCmdk();
    });
    cmdk.addEventListener('click', (e) => { if (e.target === cmdk) closeCmdk(); });
  }
  function renderCmdk() {
    const q = $('#cmdk-input').value.trim();
    const reg = cmdRegistry();
    cmdkItems = q ? reg.filter(c => fuzzy(q, c.name) || fuzzy(q, c.hint)) : reg;
    cmdkSel = Math.min(cmdkSel, Math.max(0, cmdkItems.length - 1));
    $('#cmdk-list').innerHTML = cmdkItems.slice(0, 12).map((c, i) =>
      '<div class="cmdk-item' + (i === cmdkSel ? ' sel' : '') + '" data-i="' + i + '">' +
      '<span>' + c.name + '</span><em>' + c.hint + '</em></div>').join('');
    $('#cmdk-list').querySelectorAll('.cmdk-item').forEach(el => {
      el.onclick = () => { const it = cmdkItems[+el.dataset.i]; closeCmdk(); if (it) it.fn(); };
    });
  }
  function openCmdk() {
    buildCmdk();
    cmdkSel = 0;
    $('#cmdk-input').value = '';
    renderCmdk();
    cmdk.classList.add('show');
    setTimeout(() => $('#cmdk-input').focus(), 30);
  }
  function closeCmdk() { if (cmdk) cmdk.classList.remove('show'); }

  /* ================== 全局快捷键 + 托盘动作 ================== */
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyK' && e.ctrlKey) { e.preventDefault(); cmdk && cmdk.classList.contains('show') ? closeCmdk() : openCmdk(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'KeyN' && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); toggleNpf(); }
    else if (e.code === 'KeyM' && e.ctrlKey) { e.preventDefault(); toggleMini(); }
  });

  window.mine.onTrayAction((action) => {
    if (action === 'toggle') $('#btn-play').click();
    else if (action === 'next') playAt(state.index + 1);
    else if (action === 'prev') { if (state.position > 3) playAt(state.index); else playAt(Math.max(0, state.index - 1)); }
    else if (action === 'mini') toggleMini();
    else if (action === 'dlyrics') toggleDlyrics();
  });

  window.annieProUi = { toggleMini, toggleDlyrics, toggleNpf, openCmdk };

  /* ================== 性能调试面板（隐藏入口：标题栏版本号连击 5 次） ================== */
  let dbgOn = false, dbgPanel = null, dbgTimer = null;
  let dbgScanMs = null, dbgScanAt = 0;
  let dbgFps = 0, dbgFrames = 0, dbgFpsAt = Date.now();
  let dbgClicks = 0, dbgClickTimer = null;

  // 扫描耗时采集
  window.mine.onScanEvent((m) => {
    if (m.type === 'start') dbgScanAt = Date.now();
    else if ((m.type === 'done' || m.type === 'cancelled') && dbgScanAt) {
      dbgScanMs = Date.now() - dbgScanAt;
      dbgScanAt = 0;
    }
  });
  // FPS 采集（轻量 rAF 计数）
  (function fpsLoop() {
    dbgFrames++;
    const now = Date.now();
    if (now - dbgFpsAt >= 1000) { dbgFps = dbgFrames; dbgFrames = 0; dbgFpsAt = now; }
    requestAnimationFrame(fpsLoop);
  })();

  function toggleDebugPanel(force) {
    const want = force !== undefined ? force : !dbgOn;
    if (want === dbgOn) return;
    dbgOn = want;
    if (want) {
      if (!dbgPanel) {
        dbgPanel = document.createElement('div');
        dbgPanel.id = 'debug-panel';
        dbgPanel.innerHTML = '<div class="dbg-head">性能调试（Pro）<button id="dbg-close">✕</button></div><div id="dbg-body"></div>';
        document.body.appendChild(dbgPanel);
        dbgPanel.querySelector('#dbg-close').onclick = () => toggleDebugPanel(false);
      }
      dbgPanel.classList.add('show');
      const tick = async () => {
        if (!dbgOn) return;
        let stats = null, rtt = -1;
        const t0 = performance.now();
        try { stats = await window.mine.engine('stats', {}, 3000); rtt = Math.round(performance.now() - t0); } catch { }
        const body = document.getElementById('dbg-body');
        if (body) body.innerHTML =
          '<div class="dbg-row"><span>列表渲染帧率</span><b>' + dbgFps + ' fps</b></div>' +
          '<div class="dbg-row"><span>最近扫描耗时</span><b>' + (dbgScanMs != null ? (dbgScanMs / 1000).toFixed(1) + ' s' : (dbgScanAt ? '扫描中…' : '-')) + '</b></div>' +
          '<div class="dbg-row"><span>引擎缓冲水位</span><b>' + (stats ? (stats.bufferedBytes / 1048576).toFixed(2) + ' MB' : '-') + '</b></div>' +
          '<div class="dbg-row"><span>引擎运行时长</span><b>' + (stats ? Math.round(stats.uptimeSec) + ' s' : '-') + '</b></div>' +
          '<div class="dbg-row"><span>播放代际 renderGen</span><b>' + (stats ? stats.playGeneration : '-') + '</b></div>' +
          '<div class="dbg-row"><span>IPC 往返延迟</span><b>' + (rtt >= 0 ? rtt + ' ms' : '超时') + '</b></div>' +
          '<div class="dbg-row"><span>曲库规模</span><b>' + state.library.tracks.length + ' 首</b></div>';
      };
      tick();
      dbgTimer = setInterval(tick, 500);
    } else {
      clearInterval(dbgTimer);
      if (dbgPanel) dbgPanel.classList.remove('show');
    }
  }
  // 隐藏入口：标题栏版本号 3 秒内连击 5 次
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.tb-ver')) return;
    dbgClicks++;
    clearTimeout(dbgClickTimer);
    dbgClickTimer = setTimeout(() => { dbgClicks = 0; }, 3000);
    if (dbgClicks >= 5) { dbgClicks = 0; toggleDebugPanel(); }
  });
  window.annieProUi.toggleDebugPanel = toggleDebugPanel;
})();
