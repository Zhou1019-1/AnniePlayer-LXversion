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
    gapless: true,           // V3.5.15：无缝播放（切歌保持输出流，硬切不重建）
    resampleHq: false,       // V3.5.15：重采样质量（false=swresample 标准 / true=soxr 高质量）
    loudMode: 'off',        // 响度均衡：off | track | album
    chMode: 'stereo',        // V3.5.19：声道模式 stereo|swap|mono|invertL|invertR
    chBalance: 0,            // V3.5.19：声道平衡 -1（全左）.. 0 .. 1（全右）
    peqOn: false,            // V3.5.19：参量 EQ 开关
    peqBands: [],            // V3.5.19：参量 EQ 频段 [{f: Hz, g: dB, q}]，最多 12 段
    eqOn: false,           // （已废弃）15 段 EQ 状态现由 eq.js annieEQ Store 统一管理
    // —— 下载设置 ——（下载目录与 stream-settings.json 同源，此处仅作展示/入口，不持久化）
    downloadDir: '',
    saveLrc: true,         // 下载时在目录生成旁挂 .lrc 歌词文件（嵌入标签始终做）
    saveCover: true,        // 下载时在目录生成封面图片文件（嵌入标签始终做）
    closeToTray: false,      // V3.5.9：关闭主窗口后驻留系统托盘（默认关=关窗即退出，保证更新顺利安装）
    accent: 'default',       // V3.5.17：强调色（default=主题原色；AM/粒子舞台生效）
    amViz: true              // V3.5.17：AM 主题底部实时频谱条
  };

  /* V3.5.17：强调色预设——内联 style 写到 <html>，优先级高于所有 CSS 变量定义（含 data-palette 方案） */
  var ACCENTS = {
    default: { name: '主题默认', a: '', b: '' },
    coral:   { name: '珊瑚红', a: '#fa2d55', b: '#ff5c7a' },
    sunset:  { name: '落日橙', a: '#ff7a45', b: '#ffa94d' },
    gold:    { name: '香槟金', a: '#d4a017', b: '#e6c255' },
    jade:    { name: '翡翠绿', a: '#10b981', b: '#34d399' },
    azure:   { name: '天际蓝', a: '#3b82f6', b: '#60a5fa' },
    violet:  { name: '罗兰紫', a: '#8b5cf6', b: '#a78bfa' }
  };
  function applyAccent() {
    var de = document.documentElement;
    var amRoot = document.getElementById('am-root'); // --am-accent 定义在 #am-root 上，元素级定义优先于继承，须直设
    var key = ui.accent || 'default';
    var preset = ACCENTS[key] || ACCENTS.default;
    if (!preset.a) { // 默认：清除覆盖，回主题原色
      ['--am-accent', '--am-accent-2', '--accent', '--glow'].forEach(function (v) { de.style.removeProperty(v); if (amRoot) amRoot.style.removeProperty(v); });
      return;
    }
    de.style.setProperty('--am-accent', preset.a);
    de.style.setProperty('--am-accent-2', preset.b);
    de.style.setProperty('--accent', preset.a);
    de.style.setProperty('--glow', preset.b);
    if (amRoot) { amRoot.style.setProperty('--am-accent', preset.a); amRoot.style.setProperty('--am-accent-2', preset.b); }
  }
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

  function applyAll() { applyVisual(); applyLyrics(); applyInterface(); applyAccent(); }

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
    ['ext', '扩展'],
    ['help', '使用说明']
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

    // —— 强调色自定义（V3.5.17：AM/粒子舞台变量驱动主题生效，FB2K 保持经典配色） ——
    var accRow = markItem(el('div', 'set-row'), '强调色 主题色 accent 颜色自定义');
    var accLab = el('div'); accLab.appendChild(el('div', '', '强调色'));
    accLab.appendChild(el('div', 'set-hint', '按钮/进度条/选中高亮的颜色；作用于 AM 与粒子舞台主题（FB2K 保持经典）'));
    var accWrap = el('div', 'set-ctrl'); accWrap.style.gap = '8px'; accWrap.style.flexWrap = 'wrap';
    var accSwatches = [];
    Object.keys(ACCENTS).forEach(function (k) {
      var sw = el('button', 'acc-sw');
      sw.title = ACCENTS[k].name;
      if (k === 'default') {
        sw.textContent = '默认';
        sw.style.fontSize = '11px'; sw.style.width = '44px';
      } else {
        sw.style.background = 'linear-gradient(135deg,' + ACCENTS[k].a + ',' + ACCENTS[k].b + ')';
      }
      sw.dataset.acc = k;
      sw.onclick = function () {
        ui.accent = k; save();
        applyAccent();
        accSwatches.forEach(function (x) { x.classList.toggle('on', x.dataset.acc === k); });
      };
      accSwatches.push(sw); accWrap.appendChild(sw);
    });
    accSwatches.forEach(function (x) { x.classList.toggle('on', x.dataset.acc === (ui.accent || 'default')); });
    accRow.appendChild(accLab); accRow.appendChild(accWrap);
    s5.appendChild(accRow);

    // —— AM 频谱可视化条开关（V3.5.17） ——
    var vizRow = markItem(el('div', 'set-row'), 'am 频谱 可视化 频谱条 spectrum 底部动画');
    var vizLab = el('div'); vizLab.appendChild(el('div', '', 'AM 界面底部频谱条'));
    vizLab.appendChild(el('div', 'set-hint', 'Apple Music 主题窗口底部的实时频谱动画（引擎 32 频段驱动，几乎不耗资源）'));
    var vizWrap = el('label', 'switch');
    var vizChk = document.createElement('input'); vizChk.type = 'checkbox'; vizChk.checked = ui.amViz !== false;
    vizChk.onchange = function () { ui.amViz = vizChk.checked; save(); };
    vizWrap.appendChild(vizChk); vizWrap.appendChild(el('span', 'knob'));
    vizRow.appendChild(vizLab); vizRow.appendChild(vizWrap);
    s5.appendChild(vizRow);

    // —— 氛围模式（V3.5.18：全屏频谱，任意主题可用） ——
    var ambRow = markItem(el('div', 'set-row'), '氛围模式 全屏 频谱 可视化 ambient');
    var ambLab = el('div'); ambLab.appendChild(el('div', '', '氛围模式（全屏频谱）'));
    ambLab.appendChild(el('div', 'set-hint', '全屏实时频谱 + 当前曲目信息，跟随强调色；AM 主题点击底部频谱条或按 Ctrl+Shift+V 也可进入'));
    var ambBtn = el('button', 'btn-ghost', '进入氛围模式');
    ambBtn.style.width = 'auto'; ambBtn.style.padding = '6px 16px'; ambBtn.style.fontSize = '12px';
    ambBtn.onclick = function () { if (window.annieAmbient) annieAmbient.open(); };
    ambRow.appendChild(ambLab); ambRow.appendChild(ambBtn);
    s5.appendChild(ambRow);

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
    // V3.5.19：音质链路图——源 → DSP 各段 → 输出，激活段点亮、直通段灰显
    // V4.0.1：链路图可点击，弹出全参数对照浮层
    var healthChain = el('div', 'chain-wrap');
    healthChain.style.display = 'none';
    healthChain.title = '点击查看链路全参数对照';
    sHealth.appendChild(healthChain);
    sHealth.appendChild(healthText);
    function chainStage(label, active, detail) {
      var s = el('span', 'chain-st' + (active ? ' on' : ''), label + (active && detail ? ' ' + detail : ''));
      return s;
    }
    function renderChain(s) {
      healthChain.innerHTML = '';
      var chNames = { stereo: '立体声', swap: '左右互换', mono: '单声道', invertL: '左反相', invertR: '右反相' };
      var stages = [
        chainStage('源 ' + (s.requestedRate ? (s.requestedRate / 1000) + 'kHz' : '—'), true),
        chainStage('VST', (s.vstActive || 0) > 0, '×' + s.vstActive),
        chainStage('EQ', !!s.eqActive),
        chainStage('PEQ', !!s.peqActive, s.peqBands + ' 段'),
        chainStage('声道', (!!s.channelMode && s.channelMode !== 'stereo') || Math.abs(s.channelBalance || 0) > 0.001, s.channelMode !== 'stereo' ? chNames[s.channelMode] : ''),
        chainStage('响度', Math.abs((s.loudGain || 1) - 1) > 0.005, (s.loudGain ? (20 * Math.log10(s.loudGain)).toFixed(1) + 'dB' : '')),
        chainStage('前级限幅', (s.preamp || 1) < 0.999, s.preamp < 0.999 ? (20 * Math.log10(s.preamp)).toFixed(1) + 'dB' : ''),
        chainStage('重采样', !!s.resampled, s.resampled && s.outputRate ? '→ ' + (s.outputRate / 1000) + 'kHz' : ''),
        chainStage('输出 ' + (s.outputRate ? (s.outputRate / 1000) + 'kHz/' + s.bitsPerSample + 'bit' : '—'), true),
      ];
      stages.forEach(function (st, i) {
        if (i > 0) healthChain.appendChild(el('span', 'chain-arrow', '→'));
        healthChain.appendChild(st);
      });
      healthChain.style.display = '';
    }
    /* ---- V4.0.1：链路图展开版——点链路图弹全参数对照（源 → 解码 → DSP → 输出） ---- */
    function openChainDetail() {
      var f = window.__lastFormat || {};
      var eqState = window.annieEQ ? window.annieEQ.state : null;
      var eqLabels = (window.annieEQ && window.annieEQ.FREQ_LABELS) || [];
      Promise.all([
        window.mine.engine('stats'),
        window.mine.engine('vst.list').catch(function () { return null; })
      ]).then(function (rs) {
        var s = rs[0] || {};
        if (s.ok === false) throw new Error(s.error || 'stats 失败');
        var vstSlots = (rs[1] && rs[1].slots) || [];
        var dbOf = function (lin) { return (20 * Math.log10(Math.max(1e-6, lin))).toFixed(1) + ' dB'; };
        var pct = function (v) { return Math.round(v * 100) + '%'; };
        var chNames = { stereo: '立体声', swap: '左右互换', mono: '单声道合并', invertL: '左声道反相', invertR: '右声道反相' };
        var loudNames = { off: '关闭', track: '音轨模式', album: '专辑模式' };
        var isDsd = (f.codec || '').toLowerCase().indexOf('dsd') >= 0 || f.bitDepth === 1 || s.dopActive;
        var stages = [];

        // ① 源
        stages.push({
          name: '源', on: !!f.codec, rows: f.codec ? [
            ['编码 / 位深', isDsd ? 'DSD ' + (f.requestedRate / 2822400).toFixed(0) + 'x（1bit）' : (f.codec || '?') + ' / ' + (f.bitDepth || '?') + 'bit'],
            ['采样率 / 声道', (f.requestedRate / 1000) + ' kHz / ' + (f.channels || '?') + ' ch']
          ] : [['状态', '未播放']]
        });
        // ② 解码
        stages.push({
          name: '解码', on: !!f.codec, rows: [
            ['解码器', 'FFmpeg → float32 PCM'],
            ['整轨预载', s.preload ? '开（预载到内存）' : '关（流式 ≈4s 队列）']
          ]
        });
        // ③ VST
        var vstOn = vstSlots.filter(function (v) { return v.enabled && !v.broken; });
        stages.push({
          name: 'VST 效果器', on: vstOn.length > 0,
          rows: vstOn.length > 0
            ? vstOn.map(function (v) { return [v.name || v.path, (v.perfMs || 0) + ' ms/块']; })
            : [['状态', '未挂接（直通）']]
        });
        // ④ EQ
        var eqGains = eqState ? eqState.gains : [];
        var eqAct = !!(eqState && eqState.enabled) && eqGains.some(function (g) { return Math.abs(g) > 0.01; });
        stages.push({
          name: '图示 EQ（15 段）', on: eqAct,
          rows: eqAct
            ? eqGains.map(function (g, i) { return Math.abs(g) > 0.01 ? [(eqLabels[i] || '') + ' Hz', (g > 0 ? '+' : '') + g.toFixed(1) + ' dB'] : null; }).filter(Boolean)
            : [['状态', eqState && eqState.enabled ? '全 0dB（无染色）' : '已关闭（直通）']]
        });
        // ⑤ PEQ
        var peqAct = !!ui.peqOn && (ui.peqBands || []).length > 0;
        stages.push({
          name: '参量 EQ', on: peqAct,
          rows: peqAct
            ? ui.peqBands.map(function (b) { return [b.f + ' Hz', (b.g > 0 ? '+' : '') + b.g + ' dB · Q' + b.q]; })
            : [['状态', '未启用（直通）']]
        });
        // ⑥ 声道
        var chAct = (ui.chMode && ui.chMode !== 'stereo') || Math.abs(ui.chBalance || 0) > 0.001;
        stages.push({
          name: '声道矩阵', on: chAct,
          rows: chAct ? [
            ['模式', chNames[ui.chMode] || '立体声'],
            ['平衡', Math.abs(ui.chBalance || 0) < 0.001 ? '居中' : (ui.chBalance < 0 ? '偏左 ' + pct(-ui.chBalance) : '偏右 ' + pct(ui.chBalance))]
          ] : [['状态', '直通（无矩阵运算）']]
        });
        // ⑦ 响度
        var lg = s.loudGain || 1;
        stages.push({
          name: '响度增益', on: Math.abs(lg - 1) > 0.005,
          rows: [
            ['当前增益', Math.abs(lg - 1) > 0.005 ? dbOf(lg) : '0 dB（不处理）'],
            ['响度均衡模式', loudNames[ui.loudMode] || '关闭']
          ]
        });
        // ⑧ 前级限幅
        var pa = s.preamp || 1;
        stages.push({
          name: '前级 / 限幅', on: pa < 0.999,
          rows: [
            ['自动前级补偿', (eqState && eqState.autoPreamp === false) ? '已关闭' : (pa < 0.999 ? dbOf(pa) + '（按 EQ/PEQ 最大正增益）' : '0 dB（无正增益无需补偿）')],
            ['软限幅器', (eqState && eqState.limiter === false) ? '已关闭' : '开启（峰值封顶 0dBFS）']
          ]
        });
        // ⑨ 重采样
        var isShared = !s.exclusive;
        stages.push({
          name: '重采样', on: !!s.resampled,
          rows: s.resampled ? [
            ['采样率', (s.requestedRate / 1000) + ' kHz → ' + (s.outputRate / 1000) + ' kHz'],
            ['质量档位', ui.resampleHq ? '高质量（soxr 64 阶）' : '标准（swresample）']
          ] : [['状态', isShared ? '共享模式：系统混音器重采样（引擎侧直通）' : '源码率直通']]
        });
        // ⑩ 输出
        stages.push({
          name: '输出', on: true, rows: [
            ['设备', (s.deviceName || '-') + '（' + (s.backendKind === 'asio' ? 'ASIO' : 'WASAPI') + (s.exclusive ? ' 独占' : ' 共享') + (s.dopActive ? ' / DoP' : '') + '）'],
            ['输出格式', s.outputRate ? (s.outputRate / 1000) + ' kHz / ' + s.bitsPerSample + 'bit / ' + s.channels + 'ch' : '未打开'],
            ['缓冲', (s.bufferMs || 0) + ' ms' + (s.preload ? ' + 整轨预载' : '')],
            ['切歌', (s.crossfadeSec > 0 ? '交叉淡入 ' + s.crossfadeSec + 's' : (ui.gapless ? '无缝（硬切不重建流）' : '普通（重建设备流）'))]
          ]
        });
        // ⑪ 健康计数
        stages.push({
          name: '运行健康', on: true, rows: [
            ['欠载', (s.underrunCount || 0) + ' 次 / ' + (s.underrunFrames || 0) + ' 帧（增长=爆音风险）'],
            ['限幅触发', (s.limiterClipBlocks || 0) + ' 块'],
            ['解码失败', s.decodeFailed ? '是' : '否']
          ]
        });

        // 结论：与顶栏 bp-chip 同口径——bit-perfect = 独占 + 引擎未重采样 + 非 DSD 转 PCM
        var dspNames = [];
        stages.forEach(function (st, i) { if (st.on && i >= 2 && i <= 7) dspNames.push(st.name); });
        var bp = !isShared && !!f.bitPerfect && !s.dopActive;
        var verdict, verdictCls;
        if (s.dopActive) { verdict = '✓ DoP 原生直通：DSD 位流封装直达设备，全链零处理'; verdictCls = 'ok'; }
        else if (!f.codec) { verdict = '当前未播放，以上为链路配置预览'; verdictCls = ''; }
        else if (bp) {
          verdict = '✓ Bit-perfect：采样率/位深源码直通输出设备，无重采样';
          if (dspNames.length) verdict += '；数字域处理中：' + dspNames.join('、') + '（不改变采样率/位深）';
          verdictCls = 'ok';
        } else {
          var why = [];
          if (isShared) why.push('WASAPI 共享模式（系统混音器重采样）');
          if (s.resampled) why.push('引擎重采样至 ' + (s.outputRate / 1000) + ' kHz');
          if (isDsd) why.push('DSD 转 PCM');
          verdict = '✗ 非 Bit-perfect：' + (why.join('；') || f.reason || '未知原因'); verdictCls = 'warn';
        }

        // —— 构建浮层 DOM ——
        var ov = el('div', 'modal');
        var box = el('div', 'modal-box chain-detail-box');
        var head = el('div', 'chain-detail-head');
        head.appendChild(el('div', 'modal-title', '音质链路全参数对照'));
        var closeBtn = el('button', 'btn-ghost', '关闭');
        head.appendChild(closeBtn);
        box.appendChild(head);
        var body = el('div', 'chain-detail-body');
        stages.forEach(function (st, i) {
          var stEl = el('div', 'chain-d-stage');
          var stHead = el('div', 'chain-d-stage-head');
          stHead.appendChild(el('span', 'chain-d-idx', (i + 1) + ''));
          stHead.appendChild(el('span', 'chain-d-name', st.name));
          stHead.appendChild(el('span', 'chain-d-pill' + (st.on ? ' on' : ''), st.on ? '生效' : '直通'));
          stEl.appendChild(stHead);
          st.rows.forEach(function (r) {
            var row = el('div', 'chain-d-row');
            row.appendChild(el('span', 'chain-d-k', r[0]));
            row.appendChild(el('span', 'chain-d-v', r[1]));
            stEl.appendChild(row);
          });
          body.appendChild(stEl);
          if (i < stages.length - 1) body.appendChild(el('div', 'chain-d-arrow', '↓'));
        });
        var vd = el('div', 'chain-d-verdict' + (verdictCls ? ' ' + verdictCls : ''), verdict);
        body.appendChild(vd);
        box.appendChild(body);
        ov.appendChild(box);
        var close = function () { try { ov.remove(); } catch (e) { } };
        closeBtn.onclick = close;
        ov.addEventListener('click', function (ev) { if (ev.target === ov) close(); });
        document.body.appendChild(ov);
      }).catch(function (e) {
        healthText.textContent = '读取失败：' + (e && e.message ? e.message : e);
      });
    }
    healthChain.onclick = openChainDetail;

    function renderAudioHealth() {
      healthBtn.disabled = true;
      window.mine.engine('stats').then(function (s) {
        if (!s || s.ok === false) throw new Error((s && s.error) || 'stats 失败');
        renderChain(s);
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

    // —— 无缝播放（V3.5.15） ——
    var glRow = markItem(el('div', 'set-row'), '无缝播放 gapless 切歌间隙 连续播放');
    var glLab = el('div'); glLab.appendChild(el('div', '', '无缝播放（Gapless）'));
    glLab.appendChild(el('div', 'set-hint', '切歌保持输出流不重建，间隙缩至毫秒级（现场专辑/古典连篇必备）；交叉淡入>0 时优先生效'));
    var glWrap = el('label', 'switch');
    var glChk = document.createElement('input'); glChk.type = 'checkbox'; glChk.checked = ui.gapless !== false;
    glChk.onchange = function () {
      ui.gapless = glChk.checked; save();
      window.mine.engine('gapless.set', { on: ui.gapless }).catch(function () { });
    };
    glWrap.appendChild(glChk); glWrap.appendChild(el('span', 'knob'));
    glRow.appendChild(glLab); glRow.appendChild(glWrap);
    sPlay.appendChild(glRow);

    // —— 重采样质量（V3.5.15） ——
    var rsRow = markItem(el('div', 'set-row'), '重采样质量 resample soxr 采样率转换 src');
    var rsLab = el('div'); rsLab.appendChild(el('div', '', '重采样质量'));
    rsLab.appendChild(el('div', 'set-hint', '仅引擎重采样时生效（设备不支持源采样率的回退场景）；高质量更通透、CPU 略高；下一曲生效'));
    var rsSel = document.createElement('select');
    [['fast', '标准（默认）'], ['hq', '高质量（64 阶滤波）']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; rsSel.appendChild(op);
    });
    rsSel.value = ui.resampleHq ? 'hq' : 'fast';
    rsSel.onchange = function () {
      ui.resampleHq = rsSel.value === 'hq'; save();
      window.mine.engine('resample.set', { hq: ui.resampleHq }).catch(function () { });
    };
    rsRow.appendChild(rsLab); rsRow.appendChild(rsSel);
    sPlay.appendChild(rsRow);

    // —— 声道工具箱（V3.5.19：引擎 2x2 声道矩阵，实时生效不破音） ——
    var chRow = markItem(el('div', 'set-row'), '声道 平衡 左右互换 单声道 反相 channel balance mono swap invert');
    var chLab = el('div'); chLab.appendChild(el('div', '', '声道工具箱'));
    chLab.appendChild(el('div', 'set-hint', '左右平衡 / 声道互换 / 单声道合并 / 单端反相（相位检查）；引擎实时处理，仅立体声输出生效'));
    var chWrap = el('div', 'set-ctrl');
    var chSel = document.createElement('select');
    [['stereo', '立体声（默认）'], ['swap', '左右互换'], ['mono', '单声道合并'], ['invertL', '左声道反相'], ['invertR', '右声道反相']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; chSel.appendChild(op);
    });
    chSel.value = ui.chMode || 'stereo';
    function pushChannel() {
      window.mine.engine('channel.set', { mode: ui.chMode, balance: ui.chBalance }).catch(function () { });
    }
    chSel.onchange = function () { ui.chMode = chSel.value; save(); pushChannel(); };
    var chBal = document.createElement('input');
    chBal.type = 'range'; chBal.min = -100; chBal.max = 100; chBal.step = 1;
    chBal.value = Math.round((ui.chBalance || 0) * 100);
    chBal.title = '声道平衡';
    var chBalVal = el('span', 'set-val', '');
    function fmtBalance() {
      var v = Math.round((ui.chBalance || 0) * 100);
      chBalVal.textContent = v === 0 ? '居中' : (v < 0 ? '左 ' + (-v) + '%' : '右 ' + v + '%');
    }
    fmtBalance();
    chBal.oninput = function () { ui.chBalance = +chBal.value / 100; fmtBalance(); pushChannel(); };
    chBal.ondblclick = function () { ui.chBalance = 0; chBal.value = 0; fmtBalance(); pushChannel(); }; // 双击回中
    chWrap.appendChild(chSel); chWrap.appendChild(chBal); chWrap.appendChild(chBalVal);
    chRow.appendChild(chLab); chRow.appendChild(chWrap);
    sPlay.appendChild(chRow);

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
    // 单一事实来源：annieEQ（eq.js 全局 Store）。本面板与悬浮面板共享状态、实时双向同步。
    var sEq = section(pgPlayback, '均衡器（15 段）');
    var eqRow = markItem(el('div', 'set-row'), '均衡器 eq equalizer 音效 低音增强 高音增强 人声 流行 摇滚 古典');
    eqRow.style.flexDirection = 'column'; eqRow.style.alignItems = 'stretch'; eqRow.style.gap = '10px';
    if (!window.annieEQ) {
      eqRow.appendChild(el('div', 'set-hint', 'EQ 模块未加载'));
      sEq.appendChild(eqRow);
    } else (function () {
      var EQ = window.annieEQ;
      var CN_NAMES = { flat: '平直', pop: '流行', rock: '摇滚', jazz: '爵士', classical: '古典', vocal: '人声', bass: '低音增强', treble: '高音增强', custom: '自定义' };
      var eqTop = el('div'); eqTop.style.display = 'flex'; eqTop.style.justifyContent = 'space-between'; eqTop.style.alignItems = 'center'; eqTop.style.gap = '10px';
      var eqLab = el('div'); eqLab.appendChild(el('div', '', '均衡器（15 段，32Hz–16kHz）'));
      eqLab.appendChild(el('div', 'set-hint', '引擎 PCM 域实时处理，拖动即时生效不破音；与悬浮面板实时同步'));
      var eqCtrls = el('div', 'set-ctrl');
      var eqChk = document.createElement('input'); eqChk.type = 'checkbox';
      var eqSel = document.createElement('select');
      Object.keys(EQ.PRESETS).forEach(function (k) {
        var op = document.createElement('option'); op.value = k; op.textContent = CN_NAMES[k] || EQ.PRESETS[k].name; eqSel.appendChild(op);
      });
      eqChk.onchange = function () { EQ.setEnabled(eqChk.checked); };
      eqSel.onchange = function () { EQ.applyPreset(eqSel.value); if (!EQ.state.enabled) EQ.setEnabled(true); }; // 选预设即启用
      eqCtrls.appendChild(eqChk); eqCtrls.appendChild(eqSel);
      eqTop.appendChild(eqLab); eqTop.appendChild(eqCtrls);
      eqRow.appendChild(eqTop);
      // 15 根竖向推子
      var eqWrap = el('div', 'eq-wrap');
      var eqSliders = EQ.FREQ_LABELS.map(function (f, i) {
        var band = el('div', 'eq-band');
        var sl = document.createElement('input');
        sl.type = 'range'; sl.min = -12; sl.max = 12; sl.step = 0.5;
        sl.title = f + 'Hz';
        sl.oninput = function () {
          EQ.setGain(i, +sl.value);
          if (!EQ.state.enabled) EQ.setEnabled(true); // 动手即启用
        };
        band.appendChild(sl);
        band.appendChild(el('div', 'eq-f', f));
        eqWrap.appendChild(band);
        return sl;
      });
      eqRow.appendChild(eqWrap);
      sEq.appendChild(eqRow);
      // Store → 面板订阅同步（悬浮面板/命令面板的改动实时反映到此处）
      function renderEq(s) {
        eqChk.checked = s.enabled;
        eqSel.value = EQ.PRESETS[s.preset] || s.preset === 'custom' ? s.preset : 'flat';
        eqSliders.forEach(function (sl, i) { if (document.activeElement !== sl) sl.value = s.gains[i]; });
      }
      EQ.onChange(renderEq);
      renderEq(EQ.state);
    })();

    /* ================= 参量均衡器 PEQ（V3.5.19） ================= */
    // 自由频段 peaking biquad（与 15 段图示 EQ 串联，在之后处理）——面向耳机校准（AutoEq 方案）
    var sPeq = section(pgPlayback, '参量均衡器（PEQ）');
    var peqTopRow = markItem(el('div', 'set-row'), '参量均衡器 peq parametric 耳机校准 autoeq 频率 q值');
    var peqTopLab = el('div'); peqTopLab.appendChild(el('div', '', '参量均衡器'));
    peqTopLab.appendChild(el('div', 'set-hint', '自定义频率/增益/Q 值的自由频段（最多 12 段），与 15 段 EQ 串联；耳机校准方案（如 AutoEq）按频段逐条添加即可'));
    var peqTopWrap = el('div', 'set-ctrl');
    var peqTimer = 0;
    function pushPeq() {
      clearTimeout(peqTimer);
      peqTimer = setTimeout(function () {
        window.mine.engine('peq.set', { enabled: ui.peqOn, bands: ui.peqBands }).catch(function () { });
      }, 200);
    }
    var peqChkWrap = el('label', 'switch');
    var peqChk = document.createElement('input'); peqChk.type = 'checkbox'; peqChk.checked = !!ui.peqOn;
    peqChk.onchange = function () { ui.peqOn = peqChk.checked; save(); pushPeq(); };
    peqChkWrap.appendChild(peqChk); peqChkWrap.appendChild(el('span', 'knob'));
    var peqAdd = el('button', 'btn-ghost', '＋ 加频段');
    peqAdd.style.width = 'auto'; peqAdd.style.padding = '6px 12px'; peqAdd.style.fontSize = '12px';
    peqTopWrap.appendChild(peqChkWrap); peqTopWrap.appendChild(peqAdd);
    peqTopRow.appendChild(peqTopLab); peqTopRow.appendChild(peqTopWrap);
    sPeq.appendChild(peqTopRow);
    var peqList = el('div');
    sPeq.appendChild(peqList);
    function renderPeqBands() {
      peqList.innerHTML = '';
      if (!ui.peqBands.length) { peqList.appendChild(el('div', 'set-hint', '尚未添加频段——点「＋ 加频段」开始（典型起点：100Hz / +3dB / Q1.0 试低音）')); return; }
      ui.peqBands.forEach(function (b, i) {
        var row = el('div', 'peq-row');
        var idx = el('span', 'peq-idx', String(i + 1));
        var fIn = document.createElement('input'); fIn.type = 'number'; fIn.min = 20; fIn.max = 20000; fIn.step = 10; fIn.value = Math.round(b.f); fIn.title = '频率 Hz';
        var gIn = document.createElement('input'); gIn.type = 'range'; gIn.min = -24; gIn.max = 24; gIn.step = 0.5; gIn.value = b.g; gIn.title = '增益 dB';
        var gVal = el('span', 'peq-g', (b.g > 0 ? '+' : '') + b.g + 'dB');
        var qIn = document.createElement('input'); qIn.type = 'number'; qIn.min = 0.3; qIn.max = 12; qIn.step = 0.1; qIn.value = b.q; qIn.title = 'Q 值（越大越窄）';
        var del = el('button', 'set-lib-del', '✕'); del.title = '删除该频段';
        fIn.onchange = function () { b.f = Math.min(20000, Math.max(20, +fIn.value || 1000)); fIn.value = Math.round(b.f); save(); pushPeq(); };
        gIn.oninput = function () { b.g = +gIn.value; gVal.textContent = (b.g > 0 ? '+' : '') + b.g + 'dB'; save(); pushPeq(); if (!ui.peqOn) { ui.peqOn = true; peqChk.checked = true; } };
        qIn.onchange = function () { b.q = Math.min(12, Math.max(0.3, +qIn.value || 1)); qIn.value = b.q; save(); pushPeq(); };
        del.onclick = function () { ui.peqBands.splice(i, 1); save(); pushPeq(); renderPeqBands(); };
        row.appendChild(idx); row.appendChild(fIn); row.appendChild(el('span', 'peq-unit', 'Hz'));
        row.appendChild(gIn); row.appendChild(gVal);
        row.appendChild(el('span', 'peq-unit', 'Q')); row.appendChild(qIn);
        row.appendChild(del);
        peqList.appendChild(row);
      });
    }
    peqAdd.onclick = function () {
      if (ui.peqBands.length >= 12) return;
      ui.peqBands.push({ f: 1000, g: 0, q: 1.0 });
      if (!ui.peqOn) { ui.peqOn = true; peqChk.checked = true; }
      save(); pushPeq(); renderPeqBands();
    };
    renderPeqBands();

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

    // —— 复制诊断摘要（V3.5.17：轻量报障——不用导 zip，群里直接粘贴） ——
    var sumRow = markItem(el('div', 'set-row'), '复制诊断摘要 系统信息 一键复制 报障');
    var sumLab = el('div'); sumLab.appendChild(el('div', '', '复制诊断摘要'));
    sumLab.appendChild(el('div', 'set-hint', '版本/系统/引擎/输出设备/曲库规模一键复制到剪贴板，群里报障直接粘贴'));
    var sumBtn = el('button', 'btn-ghost', '复制摘要');
    sumBtn.onclick = function () {
      sumBtn.disabled = true;
      var lines = [];
      Promise.all([
        window.mine.appVersion ? window.mine.appVersion().catch(function () { return '?'; }) : Promise.resolve('?'),
        window.mine.engine('engine.info').catch(function () { return null; }),
        window.mine.engine('stats').catch(function () { return null; })
      ]).then(function (rs) {
        var v = rs[0], info = rs[1], st = rs[2];
        lines.push('安妮播放器融合版 V' + v);
        lines.push('系统: ' + navigator.platform + ' / Electron UA: ' + (navigator.userAgent.match(/Electron\/[\d.]+/) || ['?'])[0]);
        lines.push('引擎: ' + (info ? '运行中（ffmpeg ' + (info.ffmpegFound ? '✓' : '✗') + '）' : '未响应'));
        if (st) {
          lines.push('输出: ' + (st.backendKind || '?') + (st.exclusive ? ' 独占' : ' 共享') + ' → ' + (st.deviceName || st.deviceId || '?'));
          lines.push('格式: ' + (st.outputRate || '?') + 'Hz/' + (st.bitsPerSample || '?') + 'bit' + (st.resampled ? '（重采样）' : ''));
        }
        lines.push('输出选择: ' + (ui.backend || 'wasapi') + ' / ' + (ui.deviceId || '默认设备') + (ui.exclusive !== false ? ' / 独占' : ' / 共享'));
        try { lines.push('曲库: ' + ((window.state && state.library && state.library.tracks.length) || 0) + ' 首'); } catch (e) { }
        lines.push('时间: ' + new Date().toLocaleString());
        return navigator.clipboard.writeText(lines.join('\n'));
      }).then(function () { sumBtn.textContent = '已复制 ✓'; })
        .catch(function () { sumBtn.textContent = '复制失败'; })
        .finally(function () { sumBtn.disabled = false; setTimeout(function () { sumBtn.textContent = '复制摘要'; }, 3000); });
    };
    sumRow.appendChild(sumLab); sumRow.appendChild(sumBtn);
    sFk.appendChild(sumRow);

    // —— 听歌报告（V3.5.17：本地统计 Top 歌曲/艺术家/专辑、总时长、最爱时段，可一键复制分享） ——
    function lsrFmtDur(sec) {
      sec = Math.round(sec || 0);
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      return h > 0 ? h + ' 小时 ' + m + ' 分钟' : m + ' 分钟';
    }
    function lsrList(title, arr, fmt) {
      var box = el('div', 'lsr-col');
      box.appendChild(el('div', 'lsr-col-title', title));
      if (!arr.length) { box.appendChild(el('div', 'lsr-empty', '暂无数据')); return box; }
      arr.forEach(function (s, i) {
        var row = el('div', 'lsr-item');
        row.appendChild(el('span', 'lsr-rank', String(i + 1)));
        row.appendChild(el('span', 'lsr-name', fmt(s)));
        row.appendChild(el('span', 'lsr-val', s.plays + ' 次 · ' + lsrFmtDur(s.sec)));
        box.appendChild(row);
      });
      return box;
    }
    function lsrText(r) {
      var L = ['🎵 我的安妮播放器听歌报告', '累计收听 ' + lsrFmtDur(r.totalSec) + ' · 播放 ' + r.totalPlays + ' 次'];
      if (r.favHour >= 0) L.push('最爱时段：' + r.favHour + ' 点');
      if (r.topSongs.length) {
        L.push('', '【Top 歌曲】');
        r.topSongs.slice(0, 5).forEach(function (s, i) { L.push((i + 1) + '. ' + s.title + (s.artist ? ' — ' + s.artist : '') + '（' + s.plays + ' 次）'); });
      }
      if (r.topArtists.length) {
        L.push('', '【Top 艺术家】');
        r.topArtists.slice(0, 3).forEach(function (s, i) { L.push((i + 1) + '. ' + s.name); });
      }
      L.push('', '—— 安妮播放器融合版');
      return L.join('\n');
    }
    // 分享图：canvas 绘制卡片 → PNG 复制到剪贴板（直接粘贴发群）
    function lsrDrawCard(r) {
      var W = 760, H = 1080;
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      var accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#fac900';
      var FONT = '"Segoe UI","Microsoft YaHei",sans-serif';
      // 背景：深色渐变 + 顶部强调色光晕
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#141722'); g.addColorStop(1, '#0b0d13');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      var glow = ctx.createRadialGradient(W / 2, -80, 40, W / 2, -80, 480);
      glow.addColorStop(0, accent + '55'); glow.addColorStop(1, accent + '00');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, 400);
      // 标题
      ctx.fillStyle = accent; ctx.beginPath(); ctx.roundRect(48, 56, 8, 34, 4); ctx.fill();
      ctx.fillStyle = '#f2f3f7'; ctx.font = '700 30px ' + FONT;
      ctx.fillText('安妮播放器 · 听歌报告', 70, 84);
      ctx.fillStyle = '#8a90a3'; ctx.font = '14px ' + FONT;
      ctx.fillText(new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }), 70, 112);
      // 三大数字卡片
      var stats = [
        ['累计收听', lsrFmtDur(r.totalSec)],
        ['播放次数', String(r.totalPlays)],
        ['最爱时段', r.favHour >= 0 ? r.favHour + ' 点' : '—'],
      ];
      stats.forEach(function (s, i) {
        var x = 48 + i * 226;
        ctx.fillStyle = '#ffffff10'; ctx.beginPath(); ctx.roundRect(x, 140, 210, 96, 14); ctx.fill();
        ctx.strokeStyle = accent + '44'; ctx.stroke();
        ctx.fillStyle = '#8a90a3'; ctx.font = '13px ' + FONT; ctx.fillText(s[0], x + 18, 172);
        ctx.fillStyle = accent; ctx.font = '700 26px ' + FONT; ctx.fillText(s[1], x + 18, 212);
      });
      // Top 歌曲
      var y = 286;
      ctx.fillStyle = accent; ctx.font = '600 17px ' + FONT; ctx.fillText('TOP 歌曲', 48, y); y += 14;
      r.topSongs.slice(0, 5).forEach(function (s, i) {
        y += 46;
        ctx.fillStyle = '#ffffff0c'; ctx.beginPath(); ctx.roundRect(48, y - 26, W - 96, 38, 10); ctx.fill();
        ctx.fillStyle = accent; ctx.font = '700 16px ' + FONT; ctx.fillText(String(i + 1), 66, y);
        ctx.fillStyle = '#e8eaf2'; ctx.font = '15px ' + FONT;
        var name = s.title + (s.artist ? ' — ' + s.artist : '');
        if (ctx.measureText(name).width > 480) { while (name.length > 4 && ctx.measureText(name + '…').width > 480) name = name.slice(0, -1); name += '…'; }
        ctx.fillText(name, 96, y);
        ctx.fillStyle = '#8a90a3'; ctx.font = '13px ' + FONT; ctx.textAlign = 'right';
        ctx.fillText(s.plays + ' 次', W - 66, y); ctx.textAlign = 'left';
      });
      // Top 艺术家 / 专辑 两栏
      y += 56;
      ctx.fillStyle = accent; ctx.font = '600 17px ' + FONT; ctx.fillText('TOP 艺术家', 48, y);
      ctx.fillText('TOP 专辑', 400, y);
      var col = function (arr, x) {
        var yy = y + 14;
        arr.slice(0, 3).forEach(function (s, i) {
          yy += 36;
          ctx.fillStyle = accent; ctx.font = '700 14px ' + FONT; ctx.fillText(String(i + 1), x, yy);
          ctx.fillStyle = '#d5d9e6'; ctx.font = '14px ' + FONT;
          var nm = s.name || ''; if (ctx.measureText(nm).width > 260) { while (nm.length > 4 && ctx.measureText(nm + '…').width > 260) nm = nm.slice(0, -1); nm += '…'; }
          ctx.fillText(nm, x + 26, yy);
        });
        if (!arr.length) { ctx.fillStyle = '#8a90a3'; ctx.font = '13px ' + FONT; ctx.fillText('暂无数据', x, yy + 36); }
      };
      col(r.topArtists, 48); col(r.topAlbums, 400);
      // 页脚
      ctx.fillStyle = accent + '66'; ctx.fillRect(48, H - 88, W - 96, 1);
      ctx.fillStyle = '#8a90a3'; ctx.font = '13px ' + FONT;
      ctx.fillText('—— 安妮播放器融合版 · 本地统计，仅自己可见', 48, H - 52);
      return new Promise(function (res, rej) { cv.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob failed')); }, 'image/png'); });
    }
    function openListenReport() {
      var st = window.annieListenStats; if (!st) return;
      var r = st.report();
      var mask = el('div', 'lsr-mask');
      var panel = el('div', 'lsr-panel');
      panel.appendChild(el('div', 'lsr-title', '我的听歌报告'));
      panel.appendChild(el('div', 'lsr-summary', r.totalPlays > 0
        ? '累计收听 ' + lsrFmtDur(r.totalSec) + ' · 共播放 ' + r.totalPlays + ' 次' + (r.favHour >= 0 ? ' · 最爱在 ' + r.favHour + ' 点听歌' : '')
        : '还没有统计数据——去播放几首歌吧！'));
      // —— 收听热力图（V3.5.19：近 26 周，GitHub 风格，跟随强调色） ——
      (function () {
        var days = r.days || {};
        var accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#fac900';
        var wrap = el('div', 'lsr-heat-wrap');
        wrap.appendChild(el('div', 'lsr-col-title', '收听热力图（近半年）'));
        var grid = el('div', 'lsr-heat');
        var today = new Date(); today.setHours(0, 0, 0, 0);
        var start = new Date(today.getTime() - (25 * 7 + ((today.getDay() + 6) % 7)) * 86400000); // 对齐到周一
        var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
        var opac = [0, 0.25, 0.45, 0.7, 1];
        for (var w = 0; w < 26; w++) for (var d = 0; d < 7; d++) {
          var day = new Date(start.getTime() + (w * 7 + d) * 86400000);
          if (day > today) continue;
          var key = ymd(day);
          var sec = days[key] || 0;
          var lv = sec <= 0 ? 0 : sec < 1200 ? 1 : sec < 3600 ? 2 : sec < 7200 ? 3 : 4;
          var cell = el('span', 'lsr-heat-c');
          cell.title = key + ' · ' + (sec > 0 ? Math.round(sec / 60) + ' 分钟' : '未收听');
          if (lv > 0) { cell.style.background = accent; cell.style.opacity = opac[lv]; }
          grid.appendChild(cell);
        }
        wrap.appendChild(grid);
        panel.appendChild(wrap);
      })();
      var cols = el('div', 'lsr-cols');
      cols.appendChild(lsrList('Top 歌曲', r.topSongs, function (s) { return s.title + (s.artist ? ' — ' + s.artist : ''); }));
      cols.appendChild(lsrList('Top 艺术家', r.topArtists, function (s) { return s.name; }));
      cols.appendChild(lsrList('Top 专辑', r.topAlbums, function (s) { return s.name; }));
      panel.appendChild(cols);
      var btns = el('div', 'lsr-btns');
      var btnImg = el('button', 'btn-ghost', '生成分享图');
      btnImg.onclick = function () {
        btnImg.disabled = true;
        lsrDrawCard(r).then(function (blob) {
          return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }).then(function () { btnImg.textContent = '已复制 ✓ 直接粘贴发群'; })
          .catch(function () { btnImg.textContent = '生成失败'; })
          .finally(function () { btnImg.disabled = false; setTimeout(function () { btnImg.textContent = '生成分享图'; }, 3000); });
      };
      var btnCopy = el('button', 'btn-ghost', '复制报告');
      btnCopy.onclick = function () {
        navigator.clipboard.writeText(lsrText(r)).then(function () { btnCopy.textContent = '已复制 ✓'; })
          .catch(function () { btnCopy.textContent = '复制失败'; })
          .finally(function () { setTimeout(function () { btnCopy.textContent = '复制报告'; }, 3000); });
      };
      var btnClear = el('button', 'btn-ghost', '清空统计');
      btnClear.onclick = function () {
        if (!confirm('确定清空全部听歌统计？此操作不可恢复。')) return;
        st.clear(); mask.remove();
      };
      var btnClose = el('button', 'btn-ghost', '关闭');
      btnClose.onclick = function () { mask.remove(); };
      btns.appendChild(btnImg); btns.appendChild(btnCopy); btns.appendChild(btnClear); btns.appendChild(btnClose);
      panel.appendChild(btns);
      mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
      mask.appendChild(panel);
      document.body.appendChild(mask);
    }
    var lsrRow = markItem(el('div', 'set-row'), '听歌报告 统计 Top 歌曲 艺术家 专辑 时长');
    var lsrLab = el('div'); lsrLab.appendChild(el('div', '', '听歌报告'));
    lsrLab.appendChild(el('div', 'set-hint', '本地统计你的播放记录：Top 歌曲/艺术家/专辑、累计时长、最爱时段，可一键复制分享'));
    var lsrBtn = el('button', 'btn-ghost', '查看报告');
    lsrBtn.onclick = openListenReport;
    lsrRow.appendChild(lsrLab); lsrRow.appendChild(lsrBtn);
    sFk.appendChild(lsrRow);

    // —— 智能歌单生成器（V3.5.19：规则筛选本地曲库 → 播放/存为播放列表） ——
    var slsRow = markItem(el('div', 'set-row'), '智能歌单 规则 筛选 生成 播放列表 smart playlist');
    var slsLab = el('div'); slsLab.appendChild(el('div', '', '智能歌单生成器'));
    slsLab.appendChild(el('div', 'set-hint', '按艺术家/专辑/流派/播放次数/最近播放/仅无损等规则筛选曲库，生成并播放或存为播放列表'));
    var slsBtn = el('button', 'btn-ghost', '打开生成器');
    slsBtn.onclick = function () { if (window.annieSmart) annieSmart.openBuilder(); };
    slsRow.appendChild(slsLab); slsRow.appendChild(slsBtn);
    sFk.appendChild(slsRow);

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

    /* ================= 使用说明（V3.5.18：说明书应用内版，内容见 helpContent.js） ================= */
    var pgHelp = pageEls.help;
    if (window.ANNIE_HELP) {
      var sHelpTop = section(pgHelp, '使用说明');
      sHelpTop.appendChild(el('div', 'set-hint', '与《章鱼科技：安妮播放器全功能说明书》同步；顶部搜索框可直接搜功能名（如「独占」「频谱」「快捷键」）'));
      window.ANNIE_HELP.forEach(function (sec2) {
        var sH = section(pgHelp, sec2.t);
        sec2.items.forEach(function (it) {
          var row = markItem(el('div', 'set-row'), it[0] + ' ' + it[1]);
          var lab = el('div');
          lab.appendChild(el('div', '', it[0]));
          lab.appendChild(el('div', 'set-hint', it[1]));
          row.appendChild(lab);
          sH.appendChild(row);
        });
      });
    }

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
