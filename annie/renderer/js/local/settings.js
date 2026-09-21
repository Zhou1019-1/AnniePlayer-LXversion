'use strict';
/* 安妮播放器 —— 设置中心（主窗口覆盖层）
 * 由原右侧抽屉设置面板进化而来：左侧九页导航 + 顶部搜索；
 * 保留全部既有区块与逻辑（applyVisual/applyLyrics/applyInterface/save/hydrate），
 * 视觉参数直推 Mineradio 视觉栈 fx 对象，歌词参数改动后 invalidate 重建网格，
 * 全部偏好经主进程持久化到 store.ui；对外暴露 window.annieSettings，
 * player.js 启动时 hydrate(store.ui)。新增区块（输出设备/独占/播放模式/逐字开关等）
 * 走 localStorage 或引擎 RPC，不进 store.ui。 */

(function () {
  var DEFAULTS = {
    // —— 视觉预设与粒子（对齐 fxDefaults）——
    preset: 0,
    intensity: 0.85, point: 1.0, speed: 1.0, twist: 0.0,
    scatter: 0.0, color: 1.10, cinemaShake: 0.5, coverResolution: 1.55,
    // —— 歌词 ——
    lyricDisplayMode: 'cinema', lyricTranslationMode: 'multi', lyricScale: 1.0,
    lyricGlow: true, lyricGlowStrength: 0.28, lyricGlowParticles: false,
    // —— 界面 ——
    particlesEnabled: true, albumBg: true, albumBgBlur: 120,
    sortMode: 'name', sidebarCollapsed: false, viewMode: 'tree',
    // 侧栏宽度（px）与可视化面板整体关闭状态（持久化，重启后恢复）
    sidebarWidth: 320, vizBarHidden: false,
    // Plus：配色方案（gold 暗夜金 / aurora 靛蓝极光 / jade 翡翠深空 / day 白昼）
    palette: 'gold',
    /* ---------------- Pro beat0.0.1：音质链路 ---------------- */
    dsdMode: 'pcm',        // pcm 转 PCM（默认）| dop（DoP 直通）| native（ASIO DSD）
    bufferMs: 150,        // 独占缓冲 50–500ms（默认 150ms：50ms 过小，快速操作时易欠载爆音）
    preload: false,        // 整轨预载到内存
    crossfadeSec: 0.5,       // 交叉淡入 0–10s（0=关闭）
    loudMode: 'off',        // 响度均衡：off | track | album
    eqOn: false,           // 15 段均衡器开关（引擎 PCM 域 biquad 链，独占/ASIO 共享）
    eqPreset: 'flat',      // 预设：flat | pop | rock | classical | vocal | bass | treble | custom
    eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // —— 下载设置 ——（下载目录与 stream-settings.json 同源，此处仅作展示/入口，不持久化）
    downloadDir: '',
    saveLrc: true,         // 下载时在目录生成旁挂 .lrc 歌词文件（嵌入标签始终做）
    saveCover: true,        // 下载时在目录生成封面图片文件（嵌入标签始终做）
    closeToTray: false      // V3.5.9：关闭主窗口后驻留系统托盘（默认关=关窗即退出，保证更新顺利安装）
  };
  var ui = Object.assign({}, DEFAULTS);
  var saveTimer = null;

  /* ---------------- localStorage 辅助（新增区块用，不进 store.ui） ---------------- */
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  // 逐字歌词总开关（三主题共用）：默认开，'0' = 关
  function karaokeOn() { return lsGet('annieplayer.karaoke', '1') !== '0'; }

  /* ---------------- 应用：视觉（实时） ---------------- */
  function applyVisual() {
    try {
      fx.intensity = ui.intensity;
      fx.point = ui.point;
      fx.speed = ui.speed;
      fx.twist = ui.twist;
      fx.scatter = ui.scatter;
      fx.color = ui.color;
      fx.cinemaShake = ui.cinemaShake;
      fx.coverResolution = ui.coverResolution;
      if (typeof syncFxUniforms === 'function') syncFxUniforms();
      if (typeof saveLyricLayout === 'function') saveLyricLayout({ silent: true, reason: 'settings' });
    } catch (e) { console.warn('[settings] visual', e); }
  }

  /* ---------------- 应用：歌词（重建网格） ---------------- */
  function applyLyrics() {
    try {
      fx.lyricDisplayMode = ui.lyricDisplayMode;
      fx.lyricTranslationMode = ui.lyricTranslationMode;
      fx.lyricScale = ui.lyricScale;
      fx.lyricGlow = ui.lyricGlow;
      fx.lyricGlowStrength = ui.lyricGlowStrength;
      fx.lyricGlowParticles = ui.lyricGlowParticles;
      if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') {
        invalidateStageLyricPayloadForNewLyrics('settings');
      }
      if (typeof saveLyricLayout === 'function') saveLyricLayout({ silent: true, reason: 'settings' });
    } catch (e) { console.warn('[settings] lyrics', e); }
  }

  /* Plus：应用配色方案（写 html[data-palette] + localStorage 供下轮启动早标记） */
  function applyPalette() {
    try {
      document.documentElement.dataset.palette = ui.palette || 'gold';
      localStorage.setItem('annieplayer.palette', ui.palette || 'gold');
    } catch (e) { }
  }

  /* ---------------- 应用：界面 ---------------- */
  function applyInterface() {
    applyPalette();
    try {
      if (window.annieStage) window.annieStage.setParticlesEnabled(ui.particlesEnabled);
    } catch (e) { }
    try {
      var wrap = document.getElementById('stage-wrap');
      if (wrap) {
        wrap.classList.toggle('no-album-bg', !ui.albumBg);
        wrap.style.setProperty('--album-blur', (ui.albumBgBlur || 120) + 'px');
      }
    } catch (e) { }
    // 侧栏与排序归 player.js 管，发个事件通知它
    try { document.dispatchEvent(new CustomEvent('annie-settings-changed')); } catch (e) { }
  }

  function applyAll() { applyVisual(); applyLyrics(); applyInterface(); }

  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { window.mine.saveSettings({ ui: Object.assign({}, ui) }); } catch (e) { }
    }, 350);
  }

  /* ---------------- 面板 DOM ---------------- */
  var panel = null;      // #settings-panel（覆盖层根）
  var contentEl = null;  // .set-content（页面容器挂载点）
  var navEl = null;      // .set-nav
  var searchEl = null;   // 搜索框
  var currentPage = 'general';
  var pageEls = {};      // pageId → .set-page
  var onOpenHooks = [];  // 每次打开面板时刷新（如媒体库文件夹列表）

  // 左导航九页（顺序即定案）
  var PAGES = [
    ['general', '常规'],
    ['audio', '音频输出'],
    ['playback', '播放'],
    ['fx', '效果器'],
    ['lyrics', '歌词'],
    ['visual', '视觉舞台'],
    ['library', '媒体库'],
    ['tools', '曲库工具'],
    ['download', '下载'],
    ['update', '更新与关于'],
    ['ext', '扩展']
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* 在指定页面内建一个区块（原 section(title) 直挂 panel，改为挂页面容器） */
  function section(pageEl, title) {
    var s = el('div', 'set-section');
    s.appendChild(el('div', 'set-title', title));
    pageEl.appendChild(s);
    return s;
  }

  /* 可搜索行：加 set-item 类与 data-kw 关键词（含英文术语） */
  function markItem(row, kw) {
    row.classList.add('set-item');
    if (kw) row.dataset.kw = kw;
    return row;
  }

  function sliderRow(parent, label, key, min, max, step, fmt, onInput, kw) {
    var row = markItem(el('div', 'set-row'), kw || label);
    var head = el('div', 'set-row-head');
    head.appendChild(el('span', 'set-label', label));
    var val = el('span', 'set-val', fmt(ui[key]));
    head.appendChild(val);
    row.appendChild(head);
    var input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    input.value = ui[key];
    input.dataset.key = key;
    input.oninput = function () {
      ui[key] = Number(input.value);
      val.textContent = fmt(ui[key]);
      onInput();
      save();
    };
    row.appendChild(input);
    parent.appendChild(row);
    return input;
  }

  function checkRow(parent, label, key, onChange, kw) {
    var row = markItem(el('label', 'set-check'), kw || label);
    var input = document.createElement('input');
    input.type = 'checkbox'; input.checked = !!ui[key]; input.dataset.key = key;
    input.onchange = function () { ui[key] = input.checked; onChange(); save(); };
    row.appendChild(input);
    row.appendChild(el('span', '', label));
    parent.appendChild(row);
    return input;
  }

  function selectRow(parent, label, key, options, onChange, kw) {
    var row = markItem(el('div', 'set-row'), kw || label);
    var head = el('div', 'set-row-head');
    head.appendChild(el('span', 'set-label', label));
    var sel = document.createElement('select');
    sel.dataset.key = key;
    for (var i = 0; i < options.length; i++) {
      var o = document.createElement('option');
      o.value = options[i][0]; o.textContent = options[i][1];
      sel.appendChild(o);
    }
    sel.value = ui[key];
    sel.onchange = function () { ui[key] = sel.value; onChange(); save(); };
    head.appendChild(sel);
    row.appendChild(head);
    parent.appendChild(row);
    return sel;
  }

  /* LS 驱动的开关行（新增区块用；checked 语义：'0' 为关，其余为开） */
  function lsCheckRow(parent, label, lsKey, defOn, onChange, kw) {
    var row = markItem(el('label', 'set-check'), kw || label);
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = lsGet(lsKey, defOn ? '1' : '0') !== '0';
    input.onchange = function () {
      lsSet(lsKey, input.checked ? '1' : '0');
      if (onChange) onChange(input.checked);
    };
    row.appendChild(input);
    row.appendChild(el('span', '', label));
    parent.appendChild(row);
    return input;
  }

  /* LS 驱动的滑杆行（新增区块用） */
  function lsSliderRow(parent, label, lsKey, min, max, step, def, fmt, onInput, kw) {
    var row = markItem(el('div', 'set-row'), kw || label);
    var head = el('div', 'set-row-head');
    head.appendChild(el('span', 'set-label', label));
    var cur = parseFloat(lsGet(lsKey, String(def)));
    if (!isFinite(cur)) cur = def;
    var val = el('span', 'set-val', fmt(cur));
    head.appendChild(val);
    row.appendChild(head);
    var input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = cur;
    input.oninput = function () {
      var v = Number(input.value);
      val.textContent = fmt(v);
      lsSet(lsKey, String(v));
      if (onInput) onInput(v);
    };
    row.appendChild(input);
    parent.appendChild(row);
    return input;
  }

  var fmt2 = function (v) { return Number(v).toFixed(2); };
  var fmtPx = function (v) { return Math.round(v) + 'px'; };

  /* 预设芯片（名称取自视觉栈 presetMeta，点击调上游 setPreset） */
  function buildPresets(parent) {
    var grid = markItem(el('div', 'preset-grid'), '视觉预设 preset 粒子舞台');
    var meta = [];
    try { meta = presetMeta; } catch (e) { }
    for (var i = 0; i < meta.length; i++) {
      (function (idx) {
        var chip = el('button', 'preset-chip', meta[idx].name || ('预设 ' + idx));
        chip.dataset.preset = idx;
        chip.title = meta[idx].desc || '';
        chip.onclick = function () {
          ui.preset = idx;
          try { setPreset(idx); } catch (e) { console.warn('[settings] setPreset', e); }
          refreshPresetChips();
          save();
        };
        grid.appendChild(chip);
      })(i);
    }
    parent.appendChild(grid);
  }

  function refreshPresetChips() {
    if (!panel) return;
    panel.querySelectorAll('.preset-chip').forEach(function (c) {
      c.classList.toggle('active', Number(c.dataset.preset) === ui.preset);
    });
  }

  /* ---------------- 页面切换 / 搜索 ---------------- */
  function showPage(id) {
    currentPage = id;
    for (var k in pageEls) pageEls[k].classList.toggle('active', k === id);
    if (navEl) {
      navEl.querySelectorAll('.set-nav-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.page === id);
      });
    }
  }

  function applySearch(q) {
    q = String(q || '').trim().toLowerCase();
    var searching = !!q;
    panel.classList.toggle('searching', searching);
    if (!searching) { // 清空：恢复当前页与全部行
      panel.querySelectorAll('.row-hide').forEach(function (n) { n.classList.remove('row-hide'); });
      panel.querySelectorAll('.sec-hide').forEach(function (n) { n.classList.remove('sec-hide'); });
      showPage(currentPage);
      return;
    }
    // 搜索态：全部页面铺开（CSS 控制），逐行过滤
    contentEl.querySelectorAll('.set-section').forEach(function (sec) {
      var titleHit = (sec.querySelector('.set-title').textContent || '').toLowerCase().indexOf(q) >= 0;
      var anyVisible = false;
      sec.querySelectorAll('.set-item').forEach(function (row) {
        var hay = ((row.textContent || '') + ' ' + (row.dataset.kw || '')).toLowerCase();
        var hit = titleHit || hay.indexOf(q) >= 0;
        row.classList.toggle('row-hide', !hit);
        if (hit) anyVisible = true;
      });
      sec.classList.toggle('sec-hide', !anyVisible);
    });
  }

  function buildPanel() {
    if (panel) return;
    panel = el('aside', '', null);
    panel.id = 'settings-panel';

    var backdrop = el('div', 'set-backdrop');
    backdrop.onclick = function () { togglePanel(false); };
    panel.appendChild(backdrop);

    var win = el('div', 'set-window');

    var head = el('div', 'set-head');
    head.appendChild(el('span', 'set-head-title', '设置中心'));
    searchEl = document.createElement('input');
    searchEl.className = 'set-search';
    searchEl.placeholder = '搜索设置…（如：独占 / 逐字 / 更新）';
    searchEl.oninput = function () { applySearch(searchEl.value); };
    head.appendChild(searchEl);
    var close = el('button', 'set-close', '×');
    close.title = '关闭（Esc）';
    close.onclick = function () { togglePanel(false); };
    head.appendChild(close);
    win.appendChild(head);

    var body = el('div', 'set-body');
    navEl = el('nav', 'set-nav');
    PAGES.forEach(function (p) {
      var b = el('button', 'set-nav-btn', p[1]);
      b.dataset.page = p[0];
      b.onclick = function () {
        if (searchEl.value) { searchEl.value = ''; applySearch(''); }
        showPage(p[0]);
      };
      navEl.appendChild(b);
    });
    body.appendChild(navEl);
    contentEl = el('div', 'set-content');
    PAGES.forEach(function (p) {
      var pg = el('div', 'set-page');
      pg.dataset.page = p[0];
      pageEls[p[0]] = pg;
      contentEl.appendChild(pg);
    });
    body.appendChild(contentEl);
    win.appendChild(body);
    panel.appendChild(win);

    var pgGeneral = pageEls.general, pgAudio = pageEls.audio, pgPlayback = pageEls.playback,
      pgFx = pageEls.fx,
      pgLyrics = pageEls.lyrics, pgVisual = pageEls.visual, pgLibrary = pageEls.library,
      pgTools = pageEls.tools,
      pgDownload = pageEls.download, pgUpdate = pageEls.update, pgExt = pageEls.ext;

    /* ================= 常规 ================= */
    // —— 界面 ——
    var s4 = section(pgGeneral, '界面');
    checkRow(s4, '粒子总开关', 'particlesEnabled', applyInterface, '粒子总开关 舞台粒子 particles');
    checkRow(s4, '封面氛围背景', 'albumBg', applyInterface, '封面氛围背景 模糊 background blur');
    sliderRow(s4, '背景模糊', 'albumBgBlur', 40, 200, 10, fmtPx, applyInterface, '背景模糊 blur');
    var ctRow = checkRow(s4, '关闭主窗口后驻留系统托盘', 'closeToTray', applyInterface, '关闭 最小化 托盘 驻留 后台 close tray minimize');
    ctRow.title = '默认关闭（关窗即退出），保证在线更新顺利安装；开启后关窗仅隐藏到托盘';

    // —— V3.5.8：全局快捷键（状态存主进程 store，IPC 开关） ——
    var sHk = section(pgGeneral, '全局快捷键');
    var hkRow = markItem(el('label', 'set-check'), '全局快捷键 媒体键 后台播放 global hotkey media keys');
    var hkInput = document.createElement('input');
    hkInput.type = 'checkbox';
    hkRow.appendChild(hkInput);
    hkRow.appendChild(el('span', '', '启用全局快捷键（软件在后台/最小化时也能控制播放）'));
    sHk.appendChild(hkRow);
    sHk.appendChild(el('div', 'set-hint', '播放/暂停 Ctrl+Alt+Space · 上一首/下一首 Ctrl+Alt+←/→ · 音量 Ctrl+Alt+↑/↓；支持键盘媒体键。任务栏图标悬停也有播放控制按钮。'));
    if (window.mine.hotkeysGet) {
      window.mine.hotkeysGet().then(function (on) { hkInput.checked = !!on; }).catch(function () { });
      hkInput.onchange = function () {
        window.mine.hotkeysSetEnabled(hkInput.checked).catch(function () { });
      };
    } else hkInput.disabled = true;

    // —— 外观：界面主题（一键切换，无需重启） ——
    var s5 = section(pgGeneral, '外观 · 界面主题');
    var themeGrid = markItem(el('div', 'theme-grid'), '界面主题 粒子舞台 fb2k apple music 换肤 theme');
    [['legacy', '粒子舞台', 'theme-thumb-legacy', '全屏粒子动画 · 沉浸封面'],
     ['fb2k', '仿 FB2K', 'theme-thumb-fb2k', 'foobar2000 分栏布局'],
     ['am', 'Apple Music', 'theme-thumb-am', '磨砂玻璃 · 媒体库 · 歌词']].forEach(function (t) {
      var card = el('button', 'theme-card');
      card.dataset.theme = t[0];
      card.appendChild(el('div', 'theme-thumb ' + t[2]));
      var nm = el('div', 'theme-name', t[1]);
      var ds = el('div', 'theme-desc', t[3]);
      card.appendChild(nm); card.appendChild(ds);
      card.onclick = function () { if (window.annieTheme) window.annieTheme.switch(t[0]); };
      themeGrid.appendChild(card);
    });
    s5.appendChild(themeGrid);
    s5.appendChild(el('div', 'set-hint', '切换即时生效，播放状态保持连续'));
    function refreshThemeCards() {
      if (!window.annieTheme) return;
      themeGrid.querySelectorAll('.theme-card').forEach(function (c) {
        c.classList.toggle('active', c.dataset.theme === window.annieTheme.current);
      });
    }
    refreshThemeCards();
    document.addEventListener('annie-theme-changed', refreshThemeCards);

    // —— V1.1.2：FB2K 外观（亮色/暗色，与工具栏按钮、Ctrl+Shift+D 三处同步） ——
    var sF2 = section(pgGeneral, 'FB2K 界面 · 外观');
    var f2row = markItem(el('div', 'set-row'), 'fb2k 暗色模式 夜间 dark mode');
    var f2lab = el('div'); f2lab.appendChild(el('div', '', '暗色模式'));
    f2lab.appendChild(el('div', 'set-hint', '护眼暗色主题，仅作用于 FB2K 界面；快捷键 Ctrl+Shift+D'));
    var btnF2 = el('button', 'btn-ghost');
    function refreshF2Btn() {
      var on = window.annieFb2k && window.annieFb2k.isDark();
      btnF2.textContent = on ? '🌙 暗色：开' : '☀ 暗色：关';
      btnF2.classList.toggle('on', !!on);
    }
    btnF2.onclick = function () {
      if (window.annieFb2k) window.annieFb2k.setDark(!window.annieFb2k.isDark());
      refreshF2Btn();
    };
    refreshF2Btn();
    document.addEventListener('annie-f2-dark-changed', refreshF2Btn);
    f2row.appendChild(f2lab); f2row.appendChild(btnF2);
    sF2.appendChild(f2row);

    // —— Plus：外观 · 配色方案（四套 WCAG AA 实算配色，即时切换） ——
    var s6 = section(pgGeneral, '外观 · 配色方案');
    var palGrid = markItem(el('div', 'pal-grid'), '配色方案 暗夜金 靛蓝极光 翡翠深空 白昼 palette');
    [['gold', '暗夜金', 'pal-thumb-gold', '经典品牌金 · 低蓝光'],
     ['aurora', '靛蓝极光', 'pal-thumb-aurora', '冷色科技感'],
     ['jade', '翡翠深空', 'pal-thumb-jade', '低刺激 · 耐看'],
     ['day', '白昼', 'pal-thumb-day', '明亮环境适用']].forEach(function (t) {
      var card = el('button', 'pal-card');
      card.dataset.palette = t[0];
      card.appendChild(el('div', 'pal-thumb ' + t[2]));
      card.appendChild(el('div', 'pal-name', t[1]));
      card.appendChild(el('div', 'pal-desc', t[3]));
      card.onclick = function () {
        ui.palette = t[0];
        applyPalette();
        palGrid.querySelectorAll('.pal-card').forEach(function (c) {
          c.classList.toggle('active', c.dataset.palette === ui.palette);
        });
        save();
      };
      palGrid.appendChild(card);
    });
    s6.appendChild(palGrid);
    s6.appendChild(el('div', 'set-hint', '配色即时生效并记忆；舞台画布保持深色以保证粒子对比度'));
    palGrid.querySelectorAll('.pal-card').forEach(function (c) {
      c.classList.toggle('active', c.dataset.palette === ui.palette);
    });

    /* ================= 音频输出 ================= */
    // —— 输出设备与模式（新增：设备枚举 + 模式/设备切换 + 独占开关） ——
    var sOut = section(pgAudio, '输出设备与模式');
    var devRow = markItem(el('div', 'set-row'), '输出模式 输出设备 声卡 wasapi asio 共享 device output');
    var devLab = el('div'); devLab.appendChild(el('div', '', '输出模式 / 设备'));
    devLab.appendChild(el('div', 'set-hint', '切换会断流重建；与底栏 🔒 按钮、设备下拉同源'));
    var devCtrls = el('div', 'set-ctrl');
    var kindSel = document.createElement('select');
    [['wasapi', 'WASAPI'], ['asio', 'ASIO']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1];
      kindSel.appendChild(op);
    });
    var devSel = document.createElement('select');
    devCtrls.appendChild(kindSel); devCtrls.appendChild(devSel);
    devRow.appendChild(devLab); devRow.appendChild(devCtrls);
    sOut.appendChild(devRow);

    var devListCache = null;
    function fillDevSel(kind, currentId) {
      devSel.innerHTML = '';
      var arr = (devListCache && devListCache[kind]) || [];
      if (!arr.length) {
        var op0 = document.createElement('option'); op0.value = ''; op0.textContent = '（无可用设备）';
        devSel.appendChild(op0);
        return;
      }
      arr.forEach(function (d) {
        // 引擎契约：wasapi 是 {id,name} 对象，asio 是纯字符串（驱动名）——两种形态都兼容
        var id = (d && d.id) || d;
        var name = (d && d.name) || d;
        var op = document.createElement('option');
        op.value = id; op.textContent = name;
        devSel.appendChild(op);
      });
      if (currentId) devSel.value = currentId;
    }
    function commitDevice() {
      var kind = kindSel.value, id = devSel.value || null;
      var ex = window.annieIsExclusive ? window.annieIsExclusive() : true;
      window.mine.engine('devices.select', { kind: kind, id: id, exclusive: ex }).catch(function () { });
      if (id) { try { window.mine.saveSettings({ backend: kind + '|' + id }); } catch (e) { } }
      syncExclRow();
    }
    kindSel.onchange = function () { fillDevSel(kindSel.value, null); commitDevice(); };
    devSel.onchange = commitDevice;
    window.mine.engine('devices.list').then(function (d) {
      devListCache = d || {};
      var cur = devListCache.current || {};
      kindSel.value = cur.kind || (typeof state !== 'undefined' && state.backendKind) || 'wasapi';
      fillDevSel(kindSel.value, cur.id || null);
      syncExclRow();
    }).catch(function () { });

    // —— 独占开关（与底栏 🔒 / FB2K / AM 三处共用 exclusive.js 的切换逻辑） ——
    var exRow = markItem(el('div', 'set-row'), '独占输出 共享输出 wasapi exclusive bit-perfect 独占模式');
    var exLab = el('div'); exLab.appendChild(el('div', '', 'WASAPI 独占输出'));
    exLab.appendChild(el('div', 'set-hint', '独占：bit-perfect 直通；共享：系统混音器（兼容模式）。切换需断流重建'));
    var exChkWrap = el('label', 'switch');
    var exChk = document.createElement('input'); exChk.type = 'checkbox';
    exChk.checked = window.annieIsExclusive ? window.annieIsExclusive() : true;
    exChk.onchange = function () {
      if (window.annieExclusiveSet) window.annieExclusiveSet(exChk.checked);
    };
    exChkWrap.appendChild(exChk); exChkWrap.appendChild(el('span', 'knob'));
    exRow.appendChild(exLab); exRow.appendChild(exChkWrap);
    sOut.appendChild(exRow);
    function syncExclRow() {
      var isAsio = kindSel.value === 'asio'; // ASIO 本身即独占，开关无意义
      exChk.disabled = isAsio;
      exRow.style.opacity = isAsio ? .45 : '';
    }
    document.addEventListener('annie-exclusive-changed', function (e) {
      exChk.checked = !!(e.detail && e.detail.exclusive);
    });

    /* ================= Pro beat0.0.1：音质链路（输出相关三项留在音频输出页） ================= */
    var sAq = section(pgAudio, '音质链路（Pro）');

    // —— DSD 输出方式 ——
    var dsdRow = markItem(el('div', 'set-row'), 'dsd dop native asio pcm 输出方式 176.4kHz');
    var dsdLab = el('div'); dsdLab.appendChild(el('div', '', 'DSD 输出方式'));
    dsdLab.appendChild(el('div', 'set-hint', 'DoP 需要设备支持 176.4kHz/24bit 独占；播放中切换将于下一曲生效（断流重建）'));
    var dsdSel = document.createElement('select');
    [['pcm', '转 PCM（默认）'], ['dop', 'DoP（DSD over PCM）'], ['native', 'Native（ASIO DSD）']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1];
      if (o[0] === 'dop') op.id = 'opt-dop';
      dsdSel.appendChild(op);
    });
    dsdSel.value = ui.dsdMode;
    dsdSel.onchange = function () {
      ui.dsdMode = dsdSel.value; save();
      window.mine.engine('dsd.setMode', { mode: ui.dsdMode }).catch(function () { });
    };
    dsdRow.appendChild(dsdLab); dsdRow.appendChild(dsdSel);
    sAq.appendChild(dsdRow);
    // DoP 能力探测：当前设备不支持则灰显 DoP 选项
    window.mine.engine('devices.list').then(function (d) {
      var cur = d.current || {};
      if (cur.kind !== 'wasapi') return; // ASIO 时 DoP 本就不可达（引擎会回退）
      var dev = (d.wasapi || []).find(function (x) { return x.id === cur.id; });
      var opt = document.getElementById('opt-dop');
      if (opt && dev && !dev.dop) {
        opt.disabled = true;
        opt.textContent = 'DoP（当前设备不支持 176.4kHz/24bit）';
        if (ui.dsdMode === 'dop') { ui.dsdMode = 'pcm'; dsdSel.value = 'pcm'; save(); window.mine.engine('dsd.setMode', { mode: 'pcm' }).catch(function () { }); }
      }
    }).catch(function () { });

    // —— 音频缓冲 ——
    var bufRow = markItem(el('div', 'set-row'), '音频缓冲 卡顿 爆音 buffer ms 欠载');
    var bufLab = el('div'); bufLab.appendChild(el('div', '', '音频缓冲'));
    bufLab.appendChild(el('div', 'set-hint', '卡顿/爆音时可调大缓冲（下一曲生效）'));
    var bufWrap = el('div', 'set-ctrl');
    var bufSlider = document.createElement('input');
    bufSlider.type = 'range'; bufSlider.min = 50; bufSlider.max = 500; bufSlider.step = 10; bufSlider.value = ui.bufferMs;
    var bufVal = el('span', 'set-val', ui.bufferMs + 'ms');
    bufSlider.oninput = function () {
      ui.bufferMs = +bufSlider.value; bufVal.textContent = ui.bufferMs + 'ms'; save();
      window.mine.engine('buffer.set', { ms: ui.bufferMs, preload: !!ui.preload }).catch(function () { });
    };
    bufWrap.appendChild(bufSlider); bufWrap.appendChild(bufVal);
    bufRow.appendChild(bufLab); bufRow.appendChild(bufWrap);
    sAq.appendChild(bufRow);

    // —— 整轨预载 ——
    var preRow = markItem(el('div', 'set-row'), '整轨预载 内存 preload 机械硬盘');
    var preLab = el('div'); preLab.appendChild(el('div', '', '整轨预载到内存'));
    preLab.appendChild(el('div', 'set-hint', '机械硬盘曲库切歌更稳（占内存，下一曲生效）'));
    var preChkWrap = el('label', 'switch');
    var preChk = document.createElement('input'); preChk.type = 'checkbox'; preChk.checked = !!ui.preload;
    preChk.onchange = function () {
      ui.preload = preChk.checked; save();
      window.mine.engine('buffer.set', { ms: ui.bufferMs || 50, preload: ui.preload }).catch(function () { });
    };
    preChkWrap.appendChild(preChk); preChkWrap.appendChild(el('span', 'knob'));
    preRow.appendChild(preLab); preRow.appendChild(preChkWrap);
    sAq.appendChild(preRow);

    // —— 输出健康（Track A）：设备/格式/重采样/缓冲水位/欠载与限幅计数 ——
    var sHealth = section(pgAudio, '输出健康');
    var healthRow = markItem(el('div', 'set-row'), '输出健康 欠载 爆音 重采样 缓冲 设备 格式 underrun health');
    var healthLab = el('div'); healthLab.appendChild(el('div', '', '输出健康'));
    healthLab.appendChild(el('div', 'set-hint', '查看当前设备/格式/缓冲/欠载/限幅；爆音自查先看欠载是否增长'));
    var healthBtn = el('button', 'btn-ghost', '刷新');
    healthRow.appendChild(healthLab); healthRow.appendChild(healthBtn);
    sHealth.appendChild(healthRow);
    var healthText = el('div', 'set-hint', '点击「刷新」读取当前输出状态');
    sHealth.appendChild(healthText);
    function renderAudioHealth() {
      healthBtn.disabled = true;
      window.mine.engine('stats').then(function (s) {
        if (!s || s.ok === false) throw new Error((s && s.error) || 'stats 失败');
        var fmt = s.outputRate ? (s.requestedRate + ' → ' + s.outputRate + 'Hz / ' + s.bitsPerSample + 'bit / ' + s.channels + 'ch' + (s.resampled ? '（重采样）' : '')) : '未播放';
        healthText.textContent =
          '设备：' + (s.deviceName || '-') + '（' + (s.backendKind || '-') + (s.exclusive ? ' 独占' : ' 共享') + (s.dopActive ? ' / DoP' : '') + '）\n' +
          '格式：' + fmt + '\n' +
          '缓冲：' + (s.bufferedSec || 0) + 's / ' + Math.round((s.bufferedBytes || 0) / 1048576) + 'MB（目标 ' + (s.bufferMs || 0) + 'ms' + (s.preload ? '，整轨预载' : '') + '）\n' +
          '健康：欠载 ' + (s.underrunCount || 0) + ' 次 / ' + (s.underrunFrames || 0) + ' 帧；限幅 ' + (s.limiterClipBlocks || 0) + ' 块；解码失败 ' + (s.decodeFailed ? '是' : '否');
      }).catch(function (e) { healthText.textContent = '读取失败：' + (e && e.message ? e.message : e); })
        .then(function () { healthBtn.disabled = false; });
    }
    healthBtn.onclick = renderAudioHealth;
    onOpenHooks.push(function () { if (currentPage === 'audio') renderAudioHealth(); });

    /* ================= 播放 ================= */
    // —— 播放模式（默认；与底栏/AM 顶栏按钮共用 playmode.js） ——
    var sPm = section(pgPlayback, '播放模式');
    var pmRow = markItem(el('div', 'set-row'), '播放模式 顺序播放 随机播放 单曲循环 shuffle repeat');
    var pmLab = el('div'); pmLab.appendChild(el('div', '', '默认播放模式'));
    pmLab.appendChild(el('div', 'set-hint', '与播放栏的模式按钮同步，仅本地播放生效'));
    var pmSel = document.createElement('select');
    if (window.anniePlayMode) {
      window.anniePlayMode.list.forEach(function (m) {
        var op = document.createElement('option'); op.value = m.id; op.textContent = m.label;
        pmSel.appendChild(op);
      });
      pmSel.value = window.anniePlayMode.get();
    }
    pmSel.onchange = function () { if (window.anniePlayMode) window.anniePlayMode.set(pmSel.value); };
    document.addEventListener('annie-playmode-changed', function () {
      if (window.anniePlayMode) pmSel.value = window.anniePlayMode.get();
    });
    pmRow.appendChild(pmLab); pmRow.appendChild(pmSel);
    sPm.appendChild(pmRow);

    var sPlay = section(pgPlayback, '播放（Pro）');

    // —— 交叉淡入 ——
    var cfRow = markItem(el('div', 'set-row'), '交叉淡入 crossfade 切歌淡入淡出');
    var cfLab = el('div'); cfLab.appendChild(el('div', '', '交叉淡入（Crossfade）'));
    cfLab.appendChild(el('div', 'set-hint', '切歌淡入淡出（0=关闭）；独占模式下同一输出流内混音过渡'));
    var cfWrap = el('div', 'set-ctrl');
    var cfSlider = document.createElement('input');
    cfSlider.type = 'range'; cfSlider.min = 0; cfSlider.max = 10; cfSlider.step = 0.5; cfSlider.value = ui.crossfadeSec;
    var cfVal = el('span', 'set-val', ui.crossfadeSec > 0 ? ui.crossfadeSec + 's' : '关');
    cfSlider.oninput = function () {
      ui.crossfadeSec = +cfSlider.value;
      cfVal.textContent = ui.crossfadeSec > 0 ? ui.crossfadeSec + 's' : '关';
      save();
      window.mine.engine('crossfade.set', { seconds: ui.crossfadeSec }).catch(function () { });
    };
    cfWrap.appendChild(cfSlider); cfWrap.appendChild(cfVal);
    cfRow.appendChild(cfLab); cfRow.appendChild(cfWrap);
    sPlay.appendChild(cfRow);

    // —— 响度均衡 ——
    var loudRow = markItem(el('div', 'set-row'), '响度均衡 ebu r128 lufs 音量均衡 loudness');
    var loudLab = el('div'); loudLab.appendChild(el('div', '', '响度均衡（EBU R128）'));
    loudLab.appendChild(el('div', 'set-hint', '目标 -16 LUFS；未分析的曲目播放时后台自动补算'));
    var loudSel = document.createElement('select');
    [['off', '关闭（默认）'], ['track', '按曲目'], ['album', '按专辑']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; loudSel.appendChild(op);
    });
    loudSel.value = ui.loudMode;
    loudSel.onchange = function () { ui.loudMode = loudSel.value; save(); };
    loudRow.appendChild(loudLab); loudRow.appendChild(loudSel);
    sPlay.appendChild(loudRow);

    // —— 15 段均衡器（引擎 PCM 域，热更新不破音） ——
    var EQ_FREQS = ['32', '50', '80', '125', '200', '315', '500', '800', '1.2k', '2k', '3.1k', '5k', '8k', '12.5k', '16k'];
    var EQ_PRESETS = {
      flat:      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      pop:       [-1, 0, 1, 2, 3, 2, 1, 0, -1, -1, 0, 1, 2, 3, 3],
      rock:      [3, 2, 1, 0, -1, -2, -1, 0, 1, 2, 3, 3, 3, 2, 2],
      classical: [2, 1, 0, 0, 0, 0, -1, -1, -1, 0, 1, 2, 2, 3, 3],
      vocal:     [-2, -3, -3, -2, -1, 0, 1, 2, 3, 3, 2, 1, 0, -1, -2],
      bass:      [6, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      treble:    [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 6]
    };
    var eqSendTimer = null;
    function eqPush() { // 热更新到引擎（独占/ASIO 共享，实时不破音）；拖动时 60ms 节流
      if (eqSendTimer) clearTimeout(eqSendTimer);
      eqSendTimer = setTimeout(function () {
        window.mine.engine('eq.set', { gains: ui.eqGains.slice(0, 15), enabled: !!ui.eqOn }).catch(function () { });
      }, 60);
    }
    var sEq = section(pgPlayback, '均衡器（15 段）');
    var eqRow = markItem(el('div', 'set-row'), '均衡器 eq equalizer 音效 低音增强 高音增强 人声 流行 摇滚 古典');
    eqRow.style.flexDirection = 'column'; eqRow.style.alignItems = 'stretch'; eqRow.style.gap = '10px';
    var eqTop = el('div'); eqTop.style.display = 'flex'; eqTop.style.justifyContent = 'space-between'; eqTop.style.alignItems = 'center'; eqTop.style.gap = '10px';
    var eqLab = el('div'); eqLab.appendChild(el('div', '', '均衡器（15 段，32Hz–16kHz）'));
    eqLab.appendChild(el('div', 'set-hint', '引擎 PCM 域实时处理，拖动即时生效不破音；独占/ASIO 同样有效'));
    var eqCtrls = el('div', 'set-ctrl');
    var eqChk = document.createElement('input'); eqChk.type = 'checkbox'; eqChk.checked = !!ui.eqOn;
    var eqSel = document.createElement('select');
    [['flat', '平直'], ['pop', '流行'], ['rock', '摇滚'], ['classical', '古典'], ['vocal', '人声'], ['bass', '低音增强'], ['treble', '高音增强'], ['custom', '自定义']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; eqSel.appendChild(op);
    });
    eqSel.value = ui.eqPreset in EQ_PRESETS || ui.eqPreset === 'custom' ? ui.eqPreset : 'flat';
    eqChk.onchange = function () { ui.eqOn = eqChk.checked; save(); eqPush(); };
    eqSel.onchange = function () {
      ui.eqPreset = eqSel.value;
      if (EQ_PRESETS[ui.eqPreset]) {
        ui.eqGains = EQ_PRESETS[ui.eqPreset].slice();
        eqSliders.forEach(function (sl, i) { sl.value = ui.eqGains[i]; });
        if (!ui.eqOn) { ui.eqOn = true; eqChk.checked = true; } // 选预设即启用
      }
      save(); eqPush();
    };
    eqCtrls.appendChild(eqChk); eqCtrls.appendChild(eqSel);
    eqTop.appendChild(eqLab); eqTop.appendChild(eqCtrls);
    eqRow.appendChild(eqTop);
    // 15 根竖向推子
    var eqWrap = el('div', 'eq-wrap');
    var eqSliders = EQ_FREQS.map(function (f, i) {
      var band = el('div', 'eq-band');
      var sl = document.createElement('input');
      sl.type = 'range'; sl.min = -12; sl.max = 12; sl.step = 0.5;
      sl.value = ui.eqGains[i] || 0; sl.title = f + 'Hz';
      sl.oninput = function () {
        ui.eqGains[i] = +sl.value;
        if (ui.eqPreset !== 'custom') { ui.eqPreset = 'custom'; eqSel.value = 'custom'; }
        if (!ui.eqOn) { ui.eqOn = true; eqChk.checked = true; } // 动手即启用
        save(); eqPush();
      };
      band.appendChild(sl);
      band.appendChild(el('div', 'eq-f', f));
      eqWrap.appendChild(band);
      return sl;
    });
    eqRow.appendChild(eqWrap);
    sEq.appendChild(eqRow);
    // 启动时把持久化的 EQ 推给引擎（引擎不自行持久化）
    eqPush();

    /* ================= 歌词 ================= */
    // —— 全局（AM / FB2K / 舞台逐字） ——
    var sLg = section(pgLyrics, '全局（AM / FB2K / 舞台）');
    lsCheckRow(sLg, '逐字歌词（卡拉OK）', 'annieplayer.karaoke', true, function (on) {
      try { document.dispatchEvent(new CustomEvent('annie-karaoke-changed', { detail: { on: on } })); } catch (e) { }
      // 舞台主题：重建歌词网格以应用/撤下逐字扫过
      if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') invalidateStageLyricPayloadForNewLyrics('karaoke-toggle');
    }, '逐字歌词 卡拉ok karaoke 逐词 扫过');
    var tlyRow = lsCheckRow(sLg, '显示翻译行', 'annieplayer.lyrtly', true, function (on) {
      document.body.classList.toggle('no-tly', !on);
    }, '翻译行 译文 罗马音 tly translation');
    // —— 桌面歌词开关（窗口开关，状态跟随 annie-dlyrics-changed） ——
    var dlRow = markItem(el('div', 'set-row'), '桌面歌词 desktop lyrics 悬浮 置顶 逐字');
    var dlLab = el('div'); dlLab.appendChild(el('div', '', '桌面歌词'));
    dlLab.appendChild(el('div', 'set-hint', '屏幕上方悬浮歌词条，本地逐字歌词有卡拉OK填充；快捷键 Alt+L'));
    var dlChk = document.createElement('input'); dlChk.type = 'checkbox';
    dlChk.checked = !!(window.annieDlyricsOn && window.annieDlyricsOn());
    dlChk.onchange = function () { if (window.annieDlyricsToggle) window.annieDlyricsToggle(); };
    document.addEventListener('annie-dlyrics-changed', function (e) { dlChk.checked = !!(e.detail && e.detail.on); });
    dlRow.appendChild(dlLab); dlRow.appendChild(dlChk);
    sLg.appendChild(dlRow);
    lsSliderRow(sLg, 'AM 歌词字号', 'annieplayer.am.lyrscale', 0.7, 1.6, 0.05, 1, fmt2, function () {
      if (window.amLyrStyle) window.amLyrStyle();
    }, 'am 歌词字号 字体大小 apple music font size');
    lsSliderRow(sLg, 'AM 歌词行距', 'annieplayer.am.lyrlh', 1.2, 2.2, 0.05, 1.45, fmt2, function () {
      if (window.amLyrStyle) window.amLyrStyle();
    }, 'am 歌词行距 行高 line height');
    lsSliderRow(sLg, 'AM 每行词数', 'annieplayer.am.lyrwordlimit', 0, 12, 1, 0,
      function (v) { return v === 0 ? '自动' : String(Math.round(v)); }, function () {
        if (window.amLyrRerender) window.amLyrRerender();
      }, 'am 每行词数 折行 word limit');

    // —— 在线匹配默认保存项（match 弹窗三个复选框的初始值） ——
    var sMatch = section(pgLyrics, '在线匹配 · 默认保存项');
    var matchHint = el('div', 'set-hint', '打开「在线匹配歌词 / 封面」弹窗时的默认勾选（弹窗内可临时改）');
    lsCheckRow(sMatch, '保存歌词（旁挂 .lrc）', 'annieplayer.match.def.lrc', true, null, '在线匹配 保存歌词 lrc');
    lsCheckRow(sMatch, '保存封面（cover.jpg）', 'annieplayer.match.def.cover', true, null, '在线匹配 保存封面 cover');
    lsCheckRow(sMatch, '同时嵌入文件标签', 'annieplayer.match.def.embed', false, null, '在线匹配 嵌入标签 embed');
    sMatch.appendChild(matchHint);

    // —— 舞台歌词 ——
    var s3 = section(pgLyrics, '舞台歌词');
    selectRow(s3, '显示模式', 'lyricDisplayMode', [
      ['cinema', '影院环绕'], ['triple', '三行'], ['dual', '双行'], ['single', '单行']
    ], applyLyrics, '舞台歌词 显示模式 影院环绕 三行 双行 单行');
    selectRow(s3, '翻译', 'lyricTranslationMode', [
      ['multi', '全部翻译'], ['current', '仅当前行'], ['dual', '双行对照'], ['off', '关闭翻译']
    ], applyLyrics, '舞台歌词 翻译模式 translation');
    sliderRow(s3, '歌词字号', 'lyricScale', 0.6, 1.4, 0.05, fmt2, applyLyrics, '舞台歌词 字号 font size');
    checkRow(s3, '歌词辉光', 'lyricGlow', applyLyrics, '舞台歌词 辉光 glow');
    sliderRow(s3, '辉光强度', 'lyricGlowStrength', 0, 1, 0.05, fmt2, applyLyrics, '辉光强度 glow strength');
    checkRow(s3, '辉光粒子', 'lyricGlowParticles', applyLyrics, '辉光粒子 glow particles');

    /* ================= 视觉舞台 ================= */
    var s1 = section(pgVisual, '视觉预设');
    buildPresets(s1);

    var s2 = section(pgVisual, '粒子调节');
    sliderRow(s2, '粒子强度', 'intensity', 0, 1.5, 0.05, fmt2, applyVisual, '粒子强度 intensity');
    sliderRow(s2, '粒子大小', 'point', 0.3, 2, 0.05, fmt2, applyVisual, '粒子大小 point size');
    sliderRow(s2, '粒子速度', 'speed', 0.1, 2.5, 0.05, fmt2, applyVisual, '粒子速度 speed');
    sliderRow(s2, '旋转扭曲', 'twist', 0, 1, 0.05, fmt2, applyVisual, '旋转扭曲 twist');
    sliderRow(s2, '飘散', 'scatter', 0, 0.6, 0.02, fmt2, applyVisual, '飘散 scatter');
    sliderRow(s2, '色彩增强', 'color', 0.5, 2, 0.05, fmt2, applyVisual, '色彩增强 color');
    sliderRow(s2, '节拍震屏', 'cinemaShake', 0, 1, 0.05, fmt2, applyVisual, '节拍震屏 shake');
    sliderRow(s2, '封面粒子密度', 'coverResolution', 0.75, 1.55, 0.05, fmt2, applyVisual, '封面粒子密度 cover resolution');
    s2.appendChild(el('div', 'set-hint', '封面粒子密度在切歌后生效'));

    /* ================= VST实验区：效果器（VST3 链） ================= */
    (function buildFxPage() {
      var fx = window.annieFx;
      var sFx = section(pgFx, 'VST3 效果器链');
      var fxBox = markItem(el('div', 'set-lib-list'), '效果器 vst vst3 插件 混响 压缩 effect plugin fx');
      sFx.appendChild(fxBox);
      var fxStat = el('div', 'set-hint', 'VST3 效果器在引擎音频链中处理（均衡器之前）；启停/打开界面做 20ms 平滑过渡，异常或高负载自动旁通；未播放时参数仅可查看');
      sFx.appendChild(fxStat);
      if (!fx) { fxBox.appendChild(el('div', 'set-hint', '效果器模块未加载')); return; }

      // —— V3.5.9：效果器方案（整套链的保存/切换，如"音箱模式/耳机模式"） ——
      var prRow = markItem(el('div', 'set-row'), '效果器方案 预设 保存 切换 preset 音箱 耳机');
      var prLab = el('div'); prLab.appendChild(el('div', '', '效果器方案'));
      prLab.appendChild(el('div', 'set-hint', '保存当前整条链（插件/顺序/启停/参数），一键切换；支持导入/导出与 A/B 对比'));
      var prWrap = el('div', 'set-ctrl');
      var prSel = document.createElement('select');
      var prSaveBtn = el('button', 'btn-ghost', '存为方案…');
      var prDelBtn = el('button', 'btn-ghost', '删除');
      var prExpBtn = el('button', 'btn-ghost', '导出当前链');
      var prImpBtn = el('button', 'btn-ghost', '导入');
      var prAbBtn = el('button', 'btn-ghost', 'A/B');
      function refreshPresets() {
        var list = fx.presets.list();
        prSel.innerHTML = '';
        var d0 = document.createElement('option'); d0.value = ''; d0.textContent = list.length ? '选择方案以应用…' : '（暂无方案）';
        prSel.appendChild(d0);
        list.forEach(function (p) {
          var o = document.createElement('option');
          o.value = p.id; o.textContent = p.name + '（' + p.slots.length + ' 个插件）';
          prSel.appendChild(o);
        });
        prDelBtn.disabled = !list.length;
      }
      prSel.onchange = function () {
        if (!prSel.value) return;
        var name = prSel.options[prSel.selectedIndex].textContent;
        prSel.disabled = true;
        fx.presets.apply(prSel.value).then(function (r) {
          fxStat.textContent = '已应用方案：' + name + (r.failed ? '（' + r.failed + ' 个插件缺失已跳过）' : '');
        }).catch(function (e) { fxStat.textContent = '应用方案失败：' + (e && e.message ? e.message : e); })
          .then(function () { prSel.disabled = false; prSel.value = ''; });
      };
      prSaveBtn.onclick = async function () {
        if (!fx.cfg.slots.length) { fxStat.textContent = '当前链为空，先添加插件'; return; }
        var name = prompt('方案名称：', '我的方案 ' + (fx.presets.list().length + 1));
        if (name == null || !name.trim()) return;
        prSaveBtn.disabled = true; prSaveBtn.textContent = '保存中…';
        try {
          await fx.presets.saveAs(name.trim());
          refreshPresets();
          fxStat.textContent = '已保存方案「' + name.trim() + '」';
        } catch (e) { fxStat.textContent = '保存失败：' + (e && e.message ? e.message : e); }
        prSaveBtn.disabled = false; prSaveBtn.textContent = '存为方案…';
      };
      prDelBtn.onclick = function () {
        if (!prSel.value) { fxStat.textContent = '先在左侧选择要删除的方案'; return; }
        if (!confirm('删除该方案？（不会移除当前链）')) return;
        fx.presets.remove(prSel.value);
        refreshPresets();
      };
      prExpBtn.onclick = async function () {
        prExpBtn.disabled = true; prExpBtn.textContent = '导出中…';
        try {
          var p = await fx.presets.exportCurrent();
          if (p) fxStat.textContent = '已导出：' + p;
        } catch (e) { fxStat.textContent = '导出失败：' + (e && e.message ? e.message : e); }
        prExpBtn.disabled = false; prExpBtn.textContent = '导出当前链';
      };
      prImpBtn.onclick = async function () {
        prImpBtn.disabled = true; prImpBtn.textContent = '导入中…';
        try {
          var p = await fx.presets.import();
          if (p) { refreshPresets(); fxStat.textContent = '已导入方案「' + p.name + '」（未自动应用）'; }
        } catch (e) { fxStat.textContent = '导入失败：' + (e && e.message ? e.message : e); }
        prImpBtn.disabled = false; prImpBtn.textContent = '导入';
      };
      prAbBtn.onclick = async function () {
        prAbBtn.disabled = true;
        try {
          var r = await fx.ab.toggle();
          fxStat.textContent = r.stored ? '已存 A/B 快照，再点一次切回当前链' : '已切换 A/B（再点切回）';
        } catch (e) { fxStat.textContent = 'A/B 失败：' + (e && e.message ? e.message : e); }
        prAbBtn.disabled = false;
      };
      prWrap.appendChild(prSel); prWrap.appendChild(prSaveBtn); prWrap.appendChild(prDelBtn);
      prWrap.appendChild(prExpBtn); prWrap.appendChild(prImpBtn); prWrap.appendChild(prAbBtn);
      prRow.appendChild(prLab); prRow.appendChild(prWrap);
      sFx.insertBefore(prRow, fxStat);
      refreshPresets();

      // —— 参数面板（点「参数」展开） ——
      var paramPanel = el('div', 'fx-params');
      paramPanel.style.display = 'none';
      sFx.appendChild(paramPanel);
      var paramSlotId = null;

      function renderParams(id, path) {
        paramSlotId = id;
        paramPanel.innerHTML = '';
        paramPanel.style.display = '';
        paramPanel.appendChild(el('div', 'set-hint', '正在读取参数…'));
        fx.params(id).then(function (r) {
          if (paramSlotId !== id) return; // 已切换
          paramPanel.innerHTML = '';
          paramPanel.appendChild(el('div', 'fx-params-title', '🎛 ' + (r.name || '') + '（' + r.params.length + ' 个参数）'));
          if (!r.params.length) { paramPanel.appendChild(el('div', 'set-hint', '该插件没有可编辑参数')); return; }
          r.params.forEach(function (p) {
            if (p.readOnly) return;
            var row = el('div', 'set-row');
            var head = el('div', 'set-row-head');
            head.appendChild(el('span', 'set-label', p.title));
            var val = el('span', 'set-val', p.display || String(Math.round(p.value * 100) / 100));
            head.appendChild(val);
            row.appendChild(head);
            var slider = document.createElement('input');
            slider.type = 'range'; slider.min = 0; slider.max = 1;
            slider.step = (p.discrete && p.steps > 0) ? (1 / p.steps) : 0.001;
            slider.value = p.value;
            slider.oninput = function () {
              val.textContent = slider.value;
              fx.setParam(id, path, p.id, parseFloat(slider.value)).then(function (rr) {
                if (rr && rr.display) val.textContent = rr.display;
              }).catch(function () { });
            };
            row.appendChild(slider);
            paramPanel.appendChild(row);
          });
        }).catch(function (e) {
          paramPanel.innerHTML = '';
          paramPanel.appendChild(el('div', 'set-hint', '读取参数失败：' + (e && e.message ? e.message : e)));
        });
      }

      function renderFxSlots() {
        paramSlotId = null; paramPanel.style.display = 'none'; paramPanel.innerHTML = '';
        fxBox.innerHTML = '';
        fx.ensureReady().then(function (slots) {
          fxBox.innerHTML = '';
          var cfgs = fx.cfg.slots;
          if (!slots.length && !cfgs.length) {
            fxBox.appendChild(el('div', 'set-hint', '尚未添加效果器，点击下方「扫描」或「添加 .vst3 文件」'));
            return;
          }
          slots.forEach(function (s) {
            var row = el('div', 'set-lib-item fx-slot' + (s.broken ? ' broken' : ''));
            var chk = document.createElement('input');
            chk.type = 'checkbox'; chk.checked = !!s.enabled; chk.title = '启用 / 旁通';
            chk.onchange = function () { fx.enable(s.id, s.path, chk.checked).catch(function (e) { chk.checked = !chk.checked; fxStat.textContent = '操作失败：' + e.message; }); };
            row.appendChild(chk);
            var perf = (s.perfMs && s.perfMs > 0) ? (' · ' + s.perfMs + 'ms') : '';
            var nm = el('span', 'set-lib-path', (s.broken ? (s.auto ? '⚠高负载 ' : '⚠ ') : '') + (s.name || s.path) + perf);
            nm.title = s.path
              + (s.broken ? (s.auto ? '\n已自动旁通：处理耗时过高，重新启用可复活' : '\n已旁通：插件处理异常，重新启用可复活') : '')
              + (s.perfMs ? ('\n处理耗时（EMA）：' + s.perfMs + ' ms/块') : '');
            row.appendChild(nm);
            var ops = el('span', 'fx-ops');
            [['🖥', '打开插件原生界面（需播放中）', function () {
                fx.openEditor(s.id).catch(function (e) { fxStat.textContent = e && e.message ? e.message : String(e); });
              }],
             ['🎛', '参数', function () { renderParams(s.id, s.path); }],
             ['↑', '上移', function () { fx.move(s.id, s.path, -1).catch(function () { }); }],
             ['↓', '下移', function () { fx.move(s.id, s.path, 1).catch(function () { }); }],
             ['✕', '移除', function () { fx.remove(s.id, s.path).catch(function (e) { fxStat.textContent = '移除失败：' + e.message; }); }]]
              .forEach(function (b) {
                var btn = el('button', 'set-lib-del', b[0]); btn.title = b[1]; btn.onclick = b[2];
                ops.appendChild(btn);
              });
            row.appendChild(ops);
            fxBox.appendChild(row);
          });
          // 配置里有但引擎没加载上的（文件缺失等）
          cfgs.forEach(function (c) {
            if (slots.some(function (s) { return s.path === c.path; })) return;
            var row = el('div', 'set-lib-item fx-slot broken');
            row.appendChild(el('span', 'set-lib-path', '✕ ' + (c.name || c.path) + '（未加载）'));
            var del = el('button', 'set-lib-del', '✕'); del.title = '从链中移除';
            del.onclick = function () {
              var i = fx.cfg.slots.indexOf(c);
              if (i >= 0) { fx.cfg.slots.splice(i, 1); }
              try { localStorage.setItem('annieplayer.vstfx', JSON.stringify(fx.cfg)); } catch (e) { }
              renderFxSlots();
            };
            row.appendChild(del);
            fxBox.appendChild(row);
          });
        }).catch(function () {
          fxBox.innerHTML = '';
          fxBox.appendChild(el('div', 'set-hint', '引擎未就绪，稍后重试'));
        });
      }
      renderFxSlots();
      onOpenHooks.push(renderFxSlots);
      fx.onChange(function () { if (currentPage === 'fx') renderFxSlots(); });

      // —— 管理按钮行 ——
      var fxBtnRow = el('div', 'set-row');
      var fxBtnLab = el('div'); fxBtnLab.appendChild(el('div', '', '管理'));
      fxBtnLab.appendChild(el('div', 'set-hint', '扫描系统 VST3 目录，或手动选择 .vst3 文件'));
      var fxBtnWrap = el('div', 'set-ctrl');
      var scanBtn = el('button', 'btn-ghost', '扫描系统插件');
      scanBtn.onclick = function () {
        scanBtn.disabled = true; scanBtn.textContent = '扫描中…';
        fx.scan().then(function (items) {
          scanBtn.disabled = false; scanBtn.textContent = '扫描系统插件';
          if (!items.length) { fxStat.textContent = '未在系统 VST3 目录发现插件'; return; }
          // 扫描结果以临时列表呈现，点击即添加
          fxBox.innerHTML = '';
          fxBox.appendChild(el('div', 'set-hint', '发现 ' + items.length + ' 个插件，点击添加（再次打开本页回到链视图）'));
          items.forEach(function (it) {
            var row = el('div', 'set-lib-item');
            row.appendChild(el('span', 'set-lib-path', it.name || it.path));
            var add = el('button', 'set-lib-del', '＋'); add.title = '添加到效果器链';
            add.onclick = function () {
              add.disabled = true;
              fx.addPath(it.path).then(function () { add.textContent = '✓'; })
                .catch(function (e) { add.disabled = false; fxStat.textContent = '添加失败：' + e.message; });
            };
            row.appendChild(add);
            fxBox.appendChild(row);
          });
        }).catch(function (e) {
          scanBtn.disabled = false; scanBtn.textContent = '扫描系统插件';
          fxStat.textContent = '扫描失败：' + e.message;
        });
      };
      var pickBtn = el('button', 'btn-ghost', '添加 .vst3 文件…');
      pickBtn.onclick = async function () {
        pickBtn.disabled = true;
        try {
          var p = await window.mine.vstPickPlugin();
          if (p) await fx.addPath(p);
        } catch (e) { fxStat.textContent = '添加失败：' + (e && e.message ? e.message : e); }
        pickBtn.disabled = false;
      };
      fxBtnWrap.appendChild(scanBtn); fxBtnWrap.appendChild(pickBtn);
      fxBtnRow.appendChild(fxBtnLab); fxBtnRow.appendChild(fxBtnWrap);
      sFx.appendChild(fxBtnRow);
    })();

    /* ================= 媒体库 ================= */
    // 与侧栏「添加音乐文件夹 / 重新扫描」同一套逻辑（pickFolder / removeFolder / startLibraryScan）
    var sLib = section(pgLibrary, '媒体库文件夹');
    var libListBox = markItem(el('div', 'set-lib-list'), '媒体库 文件夹 载入 移除 folder library');
    sLib.appendChild(libListBox);
    var libStat = el('div', 'set-hint', '');
    sLib.appendChild(libStat);
    function renderLibFolders() {
      libListBox.innerHTML = '';
      var lib = (typeof state !== 'undefined') ? state.library : null;
      var folders = (lib && lib.folders) || [];
      if (!folders.length) {
        libListBox.appendChild(el('div', 'set-hint', '尚未添加文件夹，点击下方「添加文件夹」载入本地音乐'));
      }
      folders.forEach(function (f) {
        var row = el('div', 'set-lib-item');
        var pathEl = el('span', 'set-lib-path', '📁 ' + f); pathEl.title = f;
        var del = el('button', 'set-lib-del', '✕'); del.title = '从媒体库移除（不删除磁盘文件）';
        del.onclick = async function () {
          try {
            state.library = await window.mine.removeFolder(f);
            if (typeof isPathUnder === 'function' &&
              (state.folderFilter === f || isPathUnder(state.folderFilter, f))) state.folderFilter = null;
            renderFolders(); renderFolderTree(); renderCurrentView();
          } catch (e) { }
          renderLibFolders();
        };
        row.appendChild(pathEl); row.appendChild(del);
        libListBox.appendChild(row);
      });
      libStat.textContent = lib
        ? ('共 ' + folders.length + ' 个文件夹 · ' + ((lib.tracks && lib.tracks.length) || 0) + ' 首曲目')
        : '';
    }
    renderLibFolders();
    onOpenHooks.push(renderLibFolders);
    var libBtnRow = markItem(el('div', 'set-row'), '添加文件夹 重新扫描 媒体库 scan rescan');
    var libBtnLab = el('div'); libBtnLab.appendChild(el('div', '', '管理'));
    libBtnLab.appendChild(el('div', 'set-hint', '添加后自动后台扫描；移除仅出媒体库，不动磁盘文件'));
    var libBtnWrap = el('div', 'set-ctrl');
    var libAddBtn = el('button', 'btn-ghost', '添加文件夹…');
    libAddBtn.onclick = async function () {
      libAddBtn.disabled = true;
      try {
        state.library = await window.mine.pickFolder();
        renderFolders(); renderFolderTree(); renderCurrentView();
        if (typeof startLibraryScan === 'function') startLibraryScan(); // Worker 异步扫描
      } catch (e) { }
      libAddBtn.disabled = false;
      renderLibFolders();
    };
    var libRescanBtn = el('button', 'btn-ghost', '重新扫描');
    libRescanBtn.onclick = function () {
      if (typeof startLibraryScan === 'function') startLibraryScan();
      setTimeout(renderLibFolders, 1500);
    };
    libBtnWrap.appendChild(libAddBtn); libBtnWrap.appendChild(libRescanBtn);
    libBtnRow.appendChild(libBtnLab); libBtnRow.appendChild(libBtnWrap);
    sLib.appendChild(libBtnRow);

    /* ================= Pro beat0.0.1：曲库工具 ================= */
    var sFk = section(pgTools, '曲库工具（Pro）');
    // —— 补算响度（旧曲库） ——
    var loudBtnRow = markItem(el('div', 'set-row'), '曲库响度补算 loudness 分析 ffmpeg');
    var loudBtnLab = el('div'); loudBtnLab.appendChild(el('div', '', '曲库响度补算'));
    loudBtnLab.appendChild(el('div', 'set-hint', '后台分批分析全部曲目响度（ffmpeg 逐轨解码，耗时较长）'));
    var loudBtn = el('button', 'btn-ghost', '开始补算');
    var loudBusy = false;
    loudBtn.onclick = function () {
      if (loudBusy) { window.mine.loudnessBatchCancel(); return; }
      var lib = (typeof state !== 'undefined') ? state.library : null;
      if (!lib) return;
      var missing = lib.tracks.map(function (t) { return t.path; }).filter(function (p) {
        var mc = lib.metaCache[p]; return !(mc && mc.loudness);
      });
      if (!missing.length) { loudBtn.textContent = '全部已分析 ✓'; setTimeout(function () { loudBtn.textContent = '开始补算'; }, 2000); return; }
      loudBusy = true;
      loudBtn.textContent = '补算中 0/' + missing.length + '（点击取消）';
      window.mine.loudnessBatchStart(missing);
      var off = window.mine.onLoudnessEvent(function (ev) {
        if (ev.type === 'progress') loudBtn.textContent = '补算中 ' + ev.done + '/' + ev.total + '（点击取消）';
        else if (ev.type === 'end') {
          off(); loudBusy = false;
          loudBtn.textContent = ev.canceled ? '已取消（' + ev.ok + ' 首已分析）' : '完成：' + ev.ok + '/' + ev.total + ' 首';
          setTimeout(function () { loudBtn.textContent = '开始补算'; }, 4000);
        }
      });
    };
    loudBtnRow.appendChild(loudBtnLab); loudBtnRow.appendChild(loudBtn);
    sFk.appendChild(loudBtnRow);

    // —— 假无损批量检测 ——
    var fkRow = markItem(el('div', 'set-row'), '假无损 批量检测 频谱 fake lossless');
    var fkLab = el('div'); fkLab.appendChild(el('div', '', '假无损批量检测'));
    fkLab.appendChild(el('div', 'set-hint', '后台逐轨频谱分析（仅检测无损格式），可疑曲目在列表打 ⚠ 标记'));
    var fkBtn = el('button', 'btn-ghost', '开始检测');
    var fkBusy = false, fkResults = [];
    fkBtn.onclick = function () {
      if (fkBusy) { window.mine.fakeScanCancel(); return; }
      var lib = (typeof state !== 'undefined') ? state.library : null;
      if (!lib || !lib.tracks.length) return;
      fkBusy = true; fkResults = [];
      fkBtn.textContent = '检测中 0/' + lib.tracks.length + '（点击取消）';
      window.mine.fakeScanBatchStart(lib.tracks.map(function (t) { return t.path; }));
      var off = window.mine.onFakeScanEvent(function (ev) {
        if (ev.type === 'progress') {
          fkBtn.textContent = '检测中 ' + ev.done + '/' + ev.total + ' · 疑似 ' + ev.suspect + '（点击取消）';
          if (ev.verdict === 'suspect' || ev.verdict === 'clean') {
            fkResults.push({ path: ev.path, cutoff: ev.cutoff, verdict: ev.verdict, reason: ev.reason });
            var mc = state.library.metaCache[ev.path] || (state.library.metaCache[ev.path] = {});
            mc.fakeScan = { cutoff: ev.cutoff, verdict: ev.verdict, reason: ev.reason };
          }
        } else if (ev.type === 'end') {
          off(); fkBusy = false;
          fkBtn.textContent = '完成：疑似 ' + ev.suspect + ' 首 / 共 ' + ev.done + ' 首';
          fkCsvBtn.disabled = fkHtmlBtn.disabled = fkResults.length === 0;
          renderCurrentView(); // ⚠ 标记刷新
          setTimeout(function () { fkBtn.textContent = '开始检测'; }, 5000);
        }
      });
    };
    fkRow.appendChild(fkLab); fkRow.appendChild(fkBtn);
    sFk.appendChild(fkRow);
    var fkExpRow = markItem(el('div', 'set-row'), '导出检测报告 csv html 频谱');
    var fkExpLab = el('div'); fkExpLab.appendChild(el('div', '', '导出检测报告'));
    fkExpLab.appendChild(el('div', 'set-hint', 'CSV（路径/截止频率/判定）或 HTML（含频段能量图）'));
    var fkExpWrap = el('div', 'set-ctrl');
    var fkCsvBtn = el('button', 'btn-ghost', '导出 CSV');
    var fkHtmlBtn = el('button', 'btn-ghost', '导出 HTML');
    fkCsvBtn.disabled = fkHtmlBtn.disabled = true;
    fkCsvBtn.onclick = function () { window.mine.fakeScanExport('csv', fkResults).catch(function () { }); };
    fkHtmlBtn.onclick = function () { window.mine.fakeScanExport('html', fkResults).catch(function () { }); };
    fkExpWrap.appendChild(fkCsvBtn); fkExpWrap.appendChild(fkHtmlBtn);
    fkExpRow.appendChild(fkExpLab); fkExpRow.appendChild(fkExpWrap);
    sFk.appendChild(fkExpRow);

    // —— V3.5.8：重复歌曲清理 ——
    var dupRow = markItem(el('div', 'set-row'), '重复歌曲 清理 查重 duplicates 去重');
    var dupLab = el('div'); dupLab.appendChild(el('div', '', '重复歌曲清理'));
    dupLab.appendChild(el('div', 'set-hint', '按"标题+艺人"查重；同组默认保留体积最大的文件，其余勾选后移入回收站'));
    var dupBtn = el('button', 'btn-ghost', '扫描重复');
    dupRow.appendChild(dupLab); dupRow.appendChild(dupBtn);
    sFk.appendChild(dupRow);
    var dupBox = el('div');
    sFk.appendChild(dupBox);
    function renderDupGroups(dupGroups) {
      dupBox.innerHTML = '';
      if (!dupGroups.length) { dupBox.appendChild(el('div', 'set-hint', '未发现重复歌曲 ✓')); return; }
      var total = 0;
      dupGroups.forEach(function (g) { total += g.length - 1; });
      dupBox.appendChild(el('div', 'set-hint', '发现 ' + dupGroups.length + ' 组重复（可多删 ' + total + ' 个文件）；默认勾选每组除最大文件外的全部'));
      dupGroups.slice(0, 100).forEach(function (g) {
        var box = el('div', 'set-dup-group');
        box.appendChild(el('div', 'set-dup-head', (g[0].title || g[0].name) + ' · ' + (g[0].artist || '未知艺人') + '（' + g.length + ' 个副本）'));
        g.forEach(function (t, i) {
          var row = el('label', 'set-dup-item');
          var cb = document.createElement('input');
          cb.type = 'checkbox'; cb.checked = i > 0; cb.dataset.path = t.path; // 组内已按体积降序，默认保留第 0 个
          row.appendChild(cb);
          row.appendChild(el('span', 'set-dup-name', t.name + '（' + (t.size / 1048576).toFixed(1) + 'MB）'));
          row.appendChild(el('span', 'set-dup-dir', t.dir));
          box.appendChild(row);
        });
        dupBox.appendChild(box);
      });
      if (dupGroups.length > 100) dupBox.appendChild(el('div', 'set-hint', '仅显示前 100 组，处理后可再次扫描'));
      var delBtn = el('button', 'btn-ghost', '删除选中（移入回收站）');
      delBtn.onclick = function () {
        var paths = [];
        dupBox.querySelectorAll('input[type=checkbox]:checked').forEach(function (cb) { paths.push(cb.dataset.path); });
        if (!paths.length) return;
        if (!confirm('将 ' + paths.length + ' 个文件移入回收站？\n（可从系统回收站恢复）')) return;
        delBtn.disabled = true; delBtn.textContent = '删除中…';
        window.mine.libDeleteFiles(paths).then(function (r) {
          var msg = '已删除 ' + (r.done ? r.done.length : 0) + ' 个文件' + ((r.failed && r.failed.length) ? '，失败 ' + r.failed.length + ' 个' : '');
          delBtn.disabled = false; delBtn.textContent = '删除选中（移入回收站）';
          try { if (typeof proToast === 'function') proToast(msg, 5000); } catch (e) { }
          dupBox.innerHTML = '';
          dupBox.appendChild(el('div', 'set-hint', msg + '，可重新扫描确认'));
        }).catch(function () { delBtn.disabled = false; delBtn.textContent = '删除选中（移入回收站）'; });
      };
      dupBox.appendChild(delBtn);
    }
    dupBtn.onclick = function () {
      if (!window.mine.libDuplicates) return;
      dupBtn.disabled = true; dupBtn.textContent = '扫描中…';
      dupBox.innerHTML = '';
      window.mine.libDuplicates().then(function (groups) {
        dupBtn.disabled = false; dupBtn.textContent = '扫描重复';
        renderDupGroups(groups || []);
      }).catch(function () { dupBtn.disabled = false; dupBtn.textContent = '扫描重复'; });
    };

    // —— 诊断信息导出（Pro beat0.0.1：崩溃报障用） ——
    var diagRow = markItem(el('div', 'set-row'), '导出诊断信息 报障 日志 zip 崩溃');
    var diagLab = el('div'); diagLab.appendChild(el('div', '', '导出诊断信息'));
    diagLab.appendChild(el('div', 'set-hint', '打包设备枚举/引擎日志/最近错误/设置快照为 zip，供报障使用'));
    var diagBtn = el('button', 'btn-ghost', '导出 zip');
    diagBtn.onclick = function () {
      diagBtn.disabled = true;
      window.mine.diagExport({ ui: annieSettingsSafe(), theme: currentThemeSafe(), time: Date.now() })
        .then(function (r) { diagBtn.textContent = r && r.ok ? '已导出 ✓' : '已取消'; })
        .catch(function () { diagBtn.textContent = '导出失败'; })
        .finally(function () { diagBtn.disabled = false; setTimeout(function () { diagBtn.textContent = '导出 zip'; }, 3000); });
    };
    function annieSettingsSafe() { try { return JSON.parse(JSON.stringify(ui)); } catch (e) { return null; } }
    function currentThemeSafe() { try { return window.annieTheme ? annieTheme.current : null; } catch (e) { return null; } }
    diagRow.appendChild(diagLab); diagRow.appendChild(diagBtn);
    sFk.appendChild(diagRow);

    /* ================= 下载 ================= */
    // 与流媒体面板下载目录同一份配置（主进程 stream-settings.json）；
    // 这里提供展示 + 更改/默认入口，改动即时同步到流媒体面板。
    var s0 = section(pgDownload, '下载设置');
    (function () {
      // 行：左侧 label + hint，右侧卡片（路径 + 按钮 + 右下角开关）
      var row = markItem(el('div', 'set-row'), '下载目录 保存位置 download 流媒体');
      var lab = el('div');
      lab.appendChild(el('div', '', '下载目录'));
      lab.appendChild(el('div', 'set-hint', '流媒体下载的保存位置，与流媒体面板的下载目录同步'));
      row.appendChild(lab);
      // 路径卡片：带边框容器，右下角为歌词/封面保存开关
      var card = el('div', 'set-dl-card');
      var dirVal = el('div', 'set-dl-dir', '读取中…');
      card.appendChild(dirVal);
      var foot = el('div', 'set-dl-foot');
      var btnRow = el('div', 'set-dl-btns');
      var btnChange = el('button', 'eq-preset', '更改');
      var btnReset = el('button', 'eq-preset', '默认');
      btnChange.style.cssText = 'border-radius: 7px; padding: 4px 12px; font-size: 12px; border: 1px solid var(--line); background: var(--bg3); color: var(--text); cursor: pointer;';
      btnReset.style.cssText = btnChange.style.cssText;
      btnRow.appendChild(btnChange);
      btnRow.appendChild(btnReset);
      foot.appendChild(btnRow);
      // 右下角：保存歌词 / 保存封面 两个开关
      var opts = el('div', 'set-dl-opts');
      var mkOpt = function (key, label) {
        var l = el('label', 'set-dl-opt');
        var c = document.createElement('input');
        c.type = 'checkbox'; c.checked = !!ui[key]; c.dataset.key = key;
        c.onchange = function () { ui[key] = c.checked; save(); };
        l.appendChild(c);
        l.appendChild(el('span', '', label));
        opts.appendChild(l);
        return l;
      };
      mkOpt('saveLrc', '歌词');
      mkOpt('saveCover', '封面');
      foot.appendChild(opts);
      card.appendChild(foot);
      row.appendChild(card);
      s0.appendChild(row);
      // 异步读取当前目录（主进程默认：系统音乐文件夹/AnniePlayerSVLX Downloads）
      if (window.mine && window.mine.streamDownloadDir) {
        window.mine.streamDownloadDir().then(function (dir) { dirVal.textContent = dir || '（默认）'; dirVal.title = dir; }).catch(function () { dirVal.textContent = '（读取失败）'; });
      }
      btnChange.onclick = async function () {
        try {
          var r = await window.mine.streamSetDownloadDir();
          if (!r || r.canceled) return;
          dirVal.textContent = r.dir; dirVal.title = r.dir;
        } catch (e) { dirVal.textContent = '（失败：' + (e && e.message || e) + '）'; }
      };
      btnReset.onclick = async function () {
        try {
          var dir = await window.mine.streamResetDownloadDir();
          dirVal.textContent = dir; dirVal.title = dir;
        } catch { }
      };
    })();

    /* ================= 更新与关于 ================= */
    var sUp = section(pgUpdate, '更新');
    // 当前版本
    var verRow = markItem(el('div', 'set-row'), '当前版本 版本号 version');
    var verLab = el('div'); verLab.appendChild(el('div', '', '当前版本'));
    verLab.appendChild(el('div', 'set-hint', '安妮播放器融合版（无敌章鱼哥制作出品，交流Q群1023637098）'));
    var verVal = el('span', 'set-val', '读取中…');
    if (window.mine && window.mine.appVersion) {
      window.mine.appVersion().then(function (v) { verVal.textContent = 'V' + v; }).catch(function () { verVal.textContent = '未知'; });
    }
    verRow.appendChild(verLab); verRow.appendChild(verVal);
    sUp.appendChild(verRow);
    // 检查更新（按钮 + 内联状态文案）
    var upRow = markItem(el('div', 'set-row'), '检查更新 自动更新 升级 update 新版本');
    var upLab = el('div'); upLab.appendChild(el('div', '', '软件更新'));
    upLab.appendChild(el('div', 'set-hint', '后台每 6 小时自动静默检查；差量下载，重启后生效'));
    var upWrap = el('div', 'set-ctrl');
    var upBtn = el('button', 'btn-ghost', '检查更新');
    var upStatus = el('span', 'set-val', '');
    upWrap.appendChild(upBtn); upWrap.appendChild(upStatus);
    upRow.appendChild(upLab); upRow.appendChild(upWrap);
    sUp.appendChild(upRow);
    // V3.5.3：更新日志展示 + 发现新版本红点（齿轮 / 导航"更新与关于"）
    var upNotes = markItem(el('div', 'set-upd-notes hidden'), '更新日志 更新内容 changelog release notes');
    sUp.appendChild(upNotes);
    var __notesVer = null;
    async function loadNotes(ver) {
      if (!ver || __notesVer === ver) return;
      __notesVer = ver;
      upNotes.classList.remove('hidden');
      upNotes.textContent = '正在获取 V' + ver + ' 更新日志…';
      try {
        var n = window.mine.getReleaseNotes ? await window.mine.getReleaseNotes(ver) : null;
        upNotes.textContent = n ? ('V' + ver + ' 更新内容\n' + n) : '（未能获取更新日志，可到 GitHub release 页查看）';
      } catch (e) { upNotes.textContent = '（未能获取更新日志）'; }
    }
    function updText(status, data) {
      switch (status) {
        case 'checking': return '正在检查更新…';
        case 'available': return '发现新版本 V' + (data || '') + '，开始下载…';
        case 'downloading': return '下载更新中 ' + (data || 0) + '%';
        case 'ready': return 'V' + (data || '') + ' 已就绪，重启后生效';
        case 'latest': return '已是最新版本 ✓';
        case 'error': return '检查失败：' + (data || '未知错误');
        default: return '';
      }
    }
    upBtn.onclick = async function () {
      upBtn.disabled = true; upStatus.textContent = '正在检查更新…';
      try {
        var r = await window.mine.checkUpdate();
        if (r && r.dev) upStatus.textContent = '开发环境，未启用自动更新';
        else if (r && r.ok === false) upStatus.textContent = '检查失败：' + (r.error || '未知错误');
        // ok 时状态由 onUpdateStatus 事件流推进
      } catch (e) { upStatus.textContent = '检查失败'; }
      upBtn.disabled = false;
    };
    if (window.mine && window.mine.onUpdateStatus) {
      window.mine.onUpdateStatus(function (p) {
        if (!p) return;
        upStatus.textContent = updText(p.status, p.data);
        if (p.status === 'available' || p.status === 'ready') {
          document.body.classList.add('upd-has'); // 齿轮/导航红点
          loadNotes(p.data);
        } else if (p.status === 'latest') {
          document.body.classList.remove('upd-has');
        }
      });
    }

    var sAbout = section(pgUpdate, '关于');
    var aboutCard = markItem(el('div', 'set-about-card'), '关于 章鱼科技 无敌章鱼哥 安妮播放器 about');
    aboutCard.appendChild(el('div', 'set-about-name', '安妮播放器融合版'));
    aboutCard.appendChild(el('div', 'set-about-sub', '章鱼科技出品 · 作者：无敌章鱼哥'));
    aboutCard.appendChild(el('div', 'set-about-sub', '本地独占音乐播放器（WASAPI Exclusive / ASIO）· GPL-3.0'));
    sAbout.appendChild(aboutCard);
    // 交流与仓库
    var linkRow = markItem(el('div', 'set-row'), 'qq群 交流 反馈 github 仓库 开源');
    var linkLab = el('div'); linkLab.appendChild(el('div', '', '交流与反馈'));
    linkLab.appendChild(el('div', 'set-hint', 'QQ 群：1023637098'));
    var linkWrap = el('div', 'set-ctrl');
    var btnRepo = el('button', 'btn-ghost', 'GitHub 仓库');
    btnRepo.onclick = function () { window.mine.openExternal('https://github.com/Zhou1019-1/AnniePlayer-LXversion'); };
    linkWrap.appendChild(btnRepo);
    linkRow.appendChild(linkLab); linkRow.appendChild(linkWrap);
    sAbout.appendChild(linkRow);

    var sThanks = section(pgUpdate, '鸣谢');
    var thRow = markItem(el('div', 'set-row'), '鸣谢 贡献者 电狗 洛雪 mineradio 致谢 contributor');
    var thLab = el('div'); thLab.appendChild(el('div', '', '贡献者与上游项目'));
    thLab.appendChild(el('div', 'set-hint', 'Mineradio 视觉引擎 · 感谢每一位贡献者'));
    var thWrap = el('div', 'set-ctrl');
    var btnDog = el('button', 'btn-ghost', '电狗 @chenhaochen66');
    btnDog.title = '音源 Worker 沙箱 · 三主题逐字歌词';
    btnDog.onclick = function () { window.mine.openExternal('https://github.com/chenhaochen66'); };
    var btnLx = el('button', 'btn-ghost', '洛雪音乐 LX Music');
    btnLx.title = 'musicSdk 音源';
    btnLx.onclick = function () { window.mine.openExternal('https://github.com/lyswhut/lx-music-desktop'); };
    thWrap.appendChild(btnDog); thWrap.appendChild(btnLx);
    thRow.appendChild(thLab); thRow.appendChild(thWrap);
    sThanks.appendChild(thRow);

    /* ================= 扩展（音源插件管理 + 生态占位） ================= */
    var sExt = section(pgExt, '音源插件');
    var extStat = el('div', 'set-hint', '');
    var extList = markItem(el('div', 'set-lib-list'), '扩展 插件 音源 洛雪 自定义源 脚本 plugin source import');
    sExt.appendChild(extList);
    sExt.appendChild(extStat);
    var extBtnRow = markItem(el('div', 'set-row'), '导入音源 脚本 洛雪 import');
    var extBtnLab = el('div'); extBtnLab.appendChild(el('div', '', '管理'));
    extBtnLab.appendChild(el('div', 'set-hint', '支持洛雪自定义音源脚本（.js），导入后播放/歌词优先走音源'));
    var extBtnWrap = el('div', 'set-ctrl');
    var extImportBtn = el('button', 'btn-ghost', '导入音源脚本…');
    extImportBtn.onclick = async function () {
      extImportBtn.disabled = true;
      extStat.textContent = '正在导入音源…';
      try {
        var r = await window.mine.streamSourcesImport();
        if (r && r.canceled) extStat.textContent = '已取消导入';
        else if (r && r.error) extStat.textContent = '导入失败：' + r.error;
        else if (r && r.source) extStat.textContent = '音源「' + r.source.name + '」导入成功并已启用';
      } catch (e) { extStat.textContent = '导入失败：' + (e.message || e); }
      extImportBtn.disabled = false;
      renderExtSources();
    };
    extBtnWrap.appendChild(extImportBtn);
    extBtnRow.appendChild(extBtnLab); extBtnRow.appendChild(extBtnWrap);
    sExt.appendChild(extBtnRow);
    function renderExtSources() {
      if (!window.mine || !window.mine.streamSourcesList) return;
      window.mine.streamSourcesList().then(function (list) {
        list = list || [];
        extList.innerHTML = '';
        var active = list.filter(function (s) { return s.enabled && s.loaded; });
        extStat.textContent = !list.length ? '未导入音源（使用内置解析）'
          : (active.length ? '已启用 ' + active.length + ' 个音源：' + active.map(function (s) { return s.name; }).join('、')
            : '音源已全部停用（使用内置解析）');
        if (!list.length) {
          extList.appendChild(el('div', 'set-hint', '尚未导入音源脚本'));
          return;
        }
        list.forEach(function (s) {
          var row = el('div', 'set-lib-item');
          var name = el('span', 'set-lib-path', (s.enabled ? '🟢 ' : '⚪ ') + s.name + (s.version ? ' v' + s.version : ''));
          name.title = (s.description || '') + (s.author ? '\n作者：' + s.author : '') +
            ((s.enabled && !s.loaded) ? '\n（加载失败，请重新导入）' : '');
          var tgl = el('button', 'btn-ghost', s.enabled ? '停用' : '启用');
          tgl.onclick = async function () {
            try { await window.mine.streamSourcesSetEnabled({ id: s.id, enabled: !s.enabled }); }
            catch (e) { extStat.textContent = '操作失败：' + (e.message || e); }
            renderExtSources();
          };
          var del = el('button', 'set-lib-del', '✕'); del.title = '删除音源';
          del.onclick = async function () {
            if (!confirm('删除音源「' + s.name + '」？')) return;
            try { await window.mine.streamSourcesRemove({ id: s.id }); } catch (e) { }
            renderExtSources();
          };
          row.appendChild(name); row.appendChild(tgl); row.appendChild(del);
          extList.appendChild(row);
        });
      }).catch(function () { extStat.textContent = '音源服务不可用'; });
    }
    renderExtSources();
    onOpenHooks.push(renderExtSources);
    // 生态占位（可视化/主题/歌词源等后续开放）
    var extCard = markItem(el('div', 'set-ext-card'), '扩展 插件 生态 可视化 主题 歌词源 plugin extension 敬请期待');
    extCard.appendChild(el('div', 'set-ext-icon', '🧩'));
    extCard.appendChild(el('div', 'set-ext-text', '可视化、主题、歌词源等更多插件类型正在加紧制作，敬请期待。'));
    extCard.appendChild(el('div', 'set-ext-sub', '章鱼出品，必属精品'));
    sExt.appendChild(extCard);

    document.body.appendChild(panel);
    showPage('general');
    refreshPresetChips();
  }

  /* 面板控件值与 ui 同步（hydrate 后调用） */
  function syncControls() {
    if (!panel) return;
    panel.querySelectorAll('input[data-key]').forEach(function (input) {
      var k = input.dataset.key;
      if (input.type === 'checkbox') input.checked = !!ui[k];
      else {
        input.value = ui[k];
        var val = input.parentElement.querySelector('.set-val');
        if (val) val.textContent = (k === 'albumBgBlur' ? fmtPx : fmt2)(ui[k]);
      }
    });
    panel.querySelectorAll('select[data-key]').forEach(function (sel) {
      sel.value = ui[sel.dataset.key];
    });
    refreshPresetChips();
  }

  function togglePanel(force) {
    buildPanel();
    var open = force !== undefined ? !!force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (open) { // 每次打开：清搜索、回当前页、刷新动态区块
      if (searchEl.value) { searchEl.value = ''; applySearch(''); }
      showPage(currentPage);
      onOpenHooks.forEach(function (fn) { try { fn(); } catch (e) { } });
    }
  }

  /* ---------------- 对外 ---------------- */
  window.annieSettings = {
    ui: ui,
    togglePanel: togglePanel,
    // V3.5.6：打开设置中心并定位到指定页（AM/FB2K 的均衡器等快捷入口用）
    openPage: function (id) {
      togglePanel(true);
      if (id && pageEls[id]) showPage(id);
    },
    applyAll: applyAll,
    save: save,
    /* Pro beat0.0.1：命令面板用——配色切换与任意字段更新 */
    setPalette: function (k) {
      ui.palette = k;
      save(); applyVisual();
    },
    update: function (patch) {
      for (var k in patch) { if (patch[k] !== undefined) ui[k] = patch[k]; }
      save(); applyVisual();
    },
    hydrate: function (saved) {
      if (saved && typeof saved === 'object') {
        for (var k in DEFAULTS) {
          if (saved[k] !== undefined) ui[k] = saved[k];
        }
      }
      applyAll();
      syncControls();
    }
  };

  document.getElementById('btn-settings').onclick = function () { togglePanel(); };
  // 快捷键：Ctrl+, 开关设置中心；Esc 关闭
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === ',' || e.code === 'Comma')) {
      e.preventDefault();
      togglePanel();
    } else if (e.key === 'Escape' && panel && panel.classList.contains('open')) {
      togglePanel(false);
    }
  });
  // 翻译行开关（LS annieplayer.lyrtly）：启动即应用，不必先打开设置中心
  document.body.classList.toggle('no-tly', lsGet('annieplayer.lyrtly', '1') === '0');
  // 全局：发现新版本红点（不必先打开设置中心；面板内状态条由 buildPanel 里的监听负责）
  if (window.mine && window.mine.onUpdateStatus) {
    window.mine.onUpdateStatus(function (p) {
      if (!p) return;
      if (p.status === 'available' || p.status === 'ready') document.body.classList.add('upd-has');
      else if (p.status === 'latest') document.body.classList.remove('upd-has');
    });
  }

  console.log('[settings] 设置中心就绪');
})();
