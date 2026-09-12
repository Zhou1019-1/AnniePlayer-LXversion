'use strict';
/* 安妮播放器 —— 设置面板（MR 风格视觉自定义 + 界面偏好）
 * 视觉参数直推 Mineradio 视觉栈的 fx 对象（syncFxUniforms 实时生效）；
 * 歌词参数改动后 invalidate 重建歌词网格；全部偏好经主进程持久化到 store.ui。
 * 对外暴露 window.annieSettings，player.js 启动时 hydrate(store.ui)。 */

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
    // —— 下载设置 ——（下载目录与 stream-settings.json 同源，此处仅作展示/入口，不持久化）
    downloadDir: '',
    saveLrc: true,         // 下载时在目录生成旁挂 .lrc 歌词文件（嵌入标签始终做）
    saveCover: true        // 下载时在目录生成封面图片文件（嵌入标签始终做）
  };
  var ui = Object.assign({}, DEFAULTS);
  var saveTimer = null;

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
  var panel = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function section(title) {
    var s = el('div', 'set-section');
    s.appendChild(el('div', 'set-title', title));
    panel.appendChild(s);
    return s;
  }

  function sliderRow(parent, label, key, min, max, step, fmt, onInput) {
    var row = el('div', 'set-row');
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

  function checkRow(parent, label, key, onChange) {
    var row = el('label', 'set-check');
    var input = document.createElement('input');
    input.type = 'checkbox'; input.checked = !!ui[key]; input.dataset.key = key;
    input.onchange = function () { ui[key] = input.checked; onChange(); save(); };
    row.appendChild(input);
    row.appendChild(el('span', '', label));
    parent.appendChild(row);
    return input;
  }

  function selectRow(parent, label, key, options, onChange) {
    var row = el('div', 'set-row');
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

  var fmt2 = function (v) { return Number(v).toFixed(2); };
  var fmtPx = function (v) { return Math.round(v) + 'px'; };

  /* 预设芯片（名称取自视觉栈 presetMeta，点击调上游 setPreset） */
  function buildPresets(parent) {
    var grid = el('div', 'preset-grid');
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

  function buildPanel() {
    if (panel) return;
    panel = el('aside', '', null);
    panel.id = 'settings-panel';

    var head = el('div', 'set-head');
    head.appendChild(el('span', 'set-head-title', '设置'));
    var close = el('button', 'set-close', '×');
    close.title = '关闭';
    close.onclick = function () { togglePanel(false); };
    head.appendChild(close);
    panel.appendChild(head);

    // —— 下载设置 ——
    // 与流媒体面板下载目录同一份配置（主进程 stream-settings.json）；
    // 这里提供展示 + 更改/默认入口，改动即时同步到流媒体面板。
    var s0 = section('下载设置');
    (function () {
      // 行：左侧 label + hint，右侧卡片（路径 + 按钮 + 右下角开关）
      var row = el('div', 'set-row');
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

    // —— 视觉预设 ——
    var s1 = section('视觉预设');
    buildPresets(s1);

    // —— 粒子调节 ——
    var s2 = section('粒子调节');
    sliderRow(s2, '粒子强度', 'intensity', 0, 1.5, 0.05, fmt2, applyVisual);
    sliderRow(s2, '粒子大小', 'point', 0.3, 2, 0.05, fmt2, applyVisual);
    sliderRow(s2, '粒子速度', 'speed', 0.1, 2.5, 0.05, fmt2, applyVisual);
    sliderRow(s2, '旋转扭曲', 'twist', 0, 1, 0.05, fmt2, applyVisual);
    sliderRow(s2, '飘散', 'scatter', 0, 0.6, 0.02, fmt2, applyVisual);
    sliderRow(s2, '色彩增强', 'color', 0.5, 2, 0.05, fmt2, applyVisual);
    sliderRow(s2, '节拍震屏', 'cinemaShake', 0, 1, 0.05, fmt2, applyVisual);
    sliderRow(s2, '封面粒子密度', 'coverResolution', 0.75, 1.55, 0.05, fmt2, applyVisual);
    s2.appendChild(el('div', 'set-hint', '封面粒子密度在切歌后生效'));

    // —— 歌词 ——
    var s3 = section('歌词');
    selectRow(s3, '显示模式', 'lyricDisplayMode', [
      ['cinema', '影院环绕'], ['triple', '三行'], ['dual', '双行'], ['single', '单行']
    ], applyLyrics);
    selectRow(s3, '翻译', 'lyricTranslationMode', [
      ['multi', '全部翻译'], ['current', '仅当前行'], ['dual', '双行对照'], ['off', '关闭翻译']
    ], applyLyrics);
    sliderRow(s3, '歌词字号', 'lyricScale', 0.6, 1.4, 0.05, fmt2, applyLyrics);
    checkRow(s3, '歌词辉光', 'lyricGlow', applyLyrics);
    sliderRow(s3, '辉光强度', 'lyricGlowStrength', 0, 1, 0.05, fmt2, applyLyrics);
    checkRow(s3, '辉光粒子', 'lyricGlowParticles', applyLyrics);

    // —— 界面 ——
    var s4 = section('界面');
    checkRow(s4, '粒子总开关', 'particlesEnabled', applyInterface);
    checkRow(s4, '封面氛围背景', 'albumBg', applyInterface);
    sliderRow(s4, '背景模糊', 'albumBgBlur', 40, 200, 10, fmtPx, applyInterface);

    // —— 外观：界面主题（一键切换，无需重启） ——
    var s5 = section('外观 · 界面主题');
    var themeGrid = el('div', 'theme-grid');
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
    var sF2 = section('FB2K 界面 · 外观');
    var f2row = el('div', 'set-row');
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
    var s6 = section('外观 · 配色方案');
    var palGrid = el('div', 'pal-grid');
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

    /* ================= Pro beat0.0.1：音质链路 ================= */
    var sAq = section('音质链路（Pro）');

    // —— DSD 输出方式 ——
    var dsdRow = el('div', 'set-row');
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
    var bufRow = el('div', 'set-row');
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
    var preRow = el('div', 'set-row');
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

    // —— 交叉淡入 ——
    var cfRow = el('div', 'set-row');
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
    sAq.appendChild(cfRow);

    // —— 响度均衡 ——
    var loudRow = el('div', 'set-row');
    var loudLab = el('div'); loudLab.appendChild(el('div', '', '响度均衡（EBU R128）'));
    loudLab.appendChild(el('div', 'set-hint', '目标 -16 LUFS；未分析的曲目播放时后台自动补算'));
    var loudSel = document.createElement('select');
    [['off', '关闭（默认）'], ['track', '按曲目'], ['album', '按专辑']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; loudSel.appendChild(op);
    });
    loudSel.value = ui.loudMode;
    loudSel.onchange = function () { ui.loudMode = loudSel.value; save(); };
    loudRow.appendChild(loudLab); loudRow.appendChild(loudSel);
    sAq.appendChild(loudRow);

    // —— 补算响度（旧曲库） ——
    var loudBtnRow = el('div', 'set-row');
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
    sAq.appendChild(loudBtnRow);

    /* ================= Pro beat0.0.1：假无损批量检测 ================= */
    var sFk = section('曲库工具（Pro）');
    var fkRow = el('div', 'set-row');
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
    var fkExpRow = el('div', 'set-row');
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

    // —— 诊断信息导出（Pro beat0.0.1：崩溃报障用） ——
    var diagRow = el('div', 'set-row');
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

    document.body.appendChild(panel);
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
  }

  /* ---------------- 对外 ---------------- */
  window.annieSettings = {
    ui: ui,
    togglePanel: togglePanel,
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
  // 点舞台空白处收起面板
  document.getElementById('stage-wrap').addEventListener('pointerdown', function () {
    if (panel && panel.classList.contains('open')) togglePanel(false);
  });

  console.log('[settings] 设置面板就绪');
})();
