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
    amTopbarBottom: false, // V4.4：AM 顶栏置底（AM 界面页开关）
    amImmFullscreen: false, // V4.4：沉浸模式真全屏（隐藏Dock；默认关=窗口最大化）
    amImmMode: 'classic',   // V4.4：沉浸模式样式 classic 经典双栏 | vinyl 彩胶唱片
    amResume: true,         // V4.4：重启恢复上次播放（曲目/队列/进度；上次暂停则恢复为暂停态）
    amSongSort: 'az',       // V4.3.15：AM 歌曲视图排序 az|azArtist|name|mtimeDesc|mtimeAsc|sizeDesc|sizeAsc
    amSongGroup: false,     // 歌曲列表按专辑分组（连续块；默认平铺）——分组表头依赖此开关
    amFavSort: 'az',        // V4.3.22：AM 喜爱歌曲视图排序（选项同歌曲视图）
    amAlbumSort: 'az',      // V4.3.22：AM 专辑视图排序 az|azArtist|countDesc|countAsc
    amAlbumDetailSort: 'release', // V4.4.3：AM 专辑详情页曲目排序 release(按发布碟号/曲目号)|az|azArtist|name|durDesc|durAsc
    amPlSort: 'default',      // V4.4.6：AM 播放列表排序 default(原始顺序)|azArtist(演唱者 A–Z)
    amSplSort: 'default',     // V4.4.6：AM 在线歌单/收藏歌单详情排序 default(平台原始顺序)|azArtist(演唱者 A–Z)
    // 侧栏宽度（px）与可视化面板整体关闭状态（持久化，重启后恢复）
    sidebarWidth: 320, vizBarHidden: false,
    // Plus：配色方案（gold 暗夜金 / aurora 靛蓝极光 / jade 翡翠深空 / day 白昼）
    palette: 'gold',
    /* ---------------- Pro beat0.0.1：音质链路 ---------------- */
    dsdMode: 'pcm',        // pcm 转 PCM（默认）| dop（DoP 直通）| native（CoreAudio DSD）
    bufferMs: 150,        // 独占缓冲 50–500ms（默认 150ms：50ms 过小，快速操作时易欠载爆音）
    preload: false,        // 整轨预载到内存
    crossfadeSec: 0.5,       // 交叉淡入 0–10s（0=关闭）
    gapless: true,           // V3.5.15：无缝播放（切歌保持输出流，硬切不重建）
    resampleHq: false,       // V3.5.15：重采样质量（false=swresample 标准 / true=soxr 高质量）
    loudMode: 'off',        // 响度均衡：off | track | album
    chMode: 'stereo',        // V3.5.19：声道模式 stereo|swap|mono|invertL|invertR
    chBalance: 0,            // V3.5.19：声道平衡 -1（全左）.. 0 .. 1（全右）
    peqOn: false,            // V3.5.19：参量 EQ 开关
    peqBands: [],            // V3.5.19：参量 EQ 频段 [{f: Hz, g: dB, q}]，最多 8 段（引擎上限）
    eqOn: false,           // （已废弃）15 段 EQ 状态现由 eq.js annieEQ Store 统一管理
    // —— 下载设置 ——（下载目录与 stream-settings.json 同源，此处仅作展示/入口，不持久化）
    downloadDir: '',
    saveLrc: true,         // 下载时在目录生成旁挂 .lrc 歌词文件（嵌入标签始终做）
    saveCover: true,        // 下载时在目录生成封面图片文件（嵌入标签始终做）
    closeToTray: false,      // V3.5.9：关闭主窗口后驻留菜单栏图标（默认关=关窗即退出，保证更新顺利安装）
    accent: 'default',       // V3.5.17：强调色（default=主题原色；AM/粒子舞台生效）
    amViz: true,              // V3.5.17：AM 主题底部实时频谱条
    amVizColor: 'cover',      // V4.3.17：频谱条配色 cover|coverMulti|rainbow|heat|accent
    amLRBar: 'on',            // V4.4.7（PR#6）：信息面板电平条 on|off
    amSmtc: 'off',             // V4.4.7（PR#6）：系统媒体会话（Now Playing）on|off
    amQBadge: 'dot',          // V4.4.7（PR#6）：待播清单角标 off=隐藏 | dot=小圆点 | count=歌曲数量
    beatAnalysis: true        // V4.4：节拍律动分析（相机随鼓点运动；关闭省整轨解码，弱机建议关）
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
    // V4.4：AM 顶栏置底（AM 界面页开关）
    try {
      var amRoot = document.getElementById('am-root');
      if (amRoot) {
        var tbOn = !!ui.amTopbarBottom;
        amRoot.classList.toggle('am-topbar-bottom', tbOn);
        /* 窗口三键不随顶栏下沉：顶栏的 backdrop-filter 会创建包含块，position:fixed 失效
         *（相对顶栏定位 → 三键反而钉在右下），所以置底时把 .am-winbtns 物理挂到 #am-root 下 */
        var wb = amRoot.querySelector('.am-winbtns');
        if (wb) {
          if (tbOn && wb.parentNode !== amRoot) {
            wb._homeParent = wb.parentNode; wb._homeNext = wb.nextSibling;
            amRoot.appendChild(wb);
          } else if (!tbOn && wb._homeParent) {
            wb._homeParent.insertBefore(wb, wb._homeNext);
            wb._homeParent = null; wb._homeNext = null;
          }
        }
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
  var pageShowHooks = {}; // V4.3.24：每次切到该页时刷新（听歌统计实时数据）

  // 左导航（顺序即定案；V4.4：主题专属设置页——粒子舞台/AM 界面/FB2K 界面）
  var PAGES = [
    ['general', '常规'],
    ['audio', '音频输出'],
    ['playback', '播放'],
    ['fx', '效果器'],
    ['lyrics', '歌词'],
    ['visual', '粒子舞台'],
    ['ui-am', 'AM 界面'],
    ['ui-fb2k', 'FB2K 界面'],
    ['library', '媒体库'],
    ['tools', '曲库工具'],
    ['stats', '听歌统计'],
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

  /* ---------------- V4.4：自定义壁纸（全局，三主题共用） ----------------
   * 数据在 wallpaper.js（IndexedDB 存图 + LS 存开关/模糊/明暗）；本区块只是 UI 壳，
   * 三个主题专属页各挂一份，经 annie-wp-changed 事件互相同步。 */
  function buildWallpaperSection(pageEl) {
    var wp = window.annieWallpaper;
    if (!wp) return;
    var s = section(pageEl, '自定义壁纸（全局）');
    s.appendChild(el('div', 'set-hint', '三个主题共用同一张壁纸；启用后替代封面氛围背景（沉浸模式是否跟随由下方开关决定）'));

    // —— 开关 ——
    var onRow = markItem(el('label', 'set-check'), '启用壁纸 自定义壁纸 背景图片 wallpaper background');
    var onCk = document.createElement('input');
    onCk.type = 'checkbox'; onCk.checked = !!wp.cfg.on;
    onCk.onchange = function () { wp.set({ on: onCk.checked }); };
    onRow.appendChild(onCk);
    onRow.appendChild(el('span', '', '启用自定义壁纸'));
    s.appendChild(onRow);

    // —— 沉浸模式联动（默认关：沉浸大背景仍随封面氛围） ——
    var immRow = markItem(el('label', 'set-check'), '沉浸模式壁纸 immersive wallpaper 沉浸背景');
    var immCk = document.createElement('input');
    immCk.type = 'checkbox'; immCk.checked = !!wp.cfg.imm;
    immCk.onchange = function () { wp.set({ imm: immCk.checked }); };
    immRow.appendChild(immCk);
    immRow.appendChild(el('span', '', '沉浸模式也使用壁纸'));
    var immHint = el('span', 'set-hint', '（不勾则沉浸模式背景仍随封面变化）');
    immHint.style.marginLeft = '6px';
    immRow.appendChild(immHint);
    s.appendChild(immRow);

    // —— 图片管理：预览 + 选择/清除 + 状态 ——
    var row = markItem(el('div', 'set-row'), '选择壁纸图片 清除 wallpaper pick image');
    var lab = el('div');
    lab.appendChild(el('div', '', '壁纸图片'));
    var stat = el('div', 'set-hint', '…');
    lab.appendChild(stat);
    row.appendChild(lab);
    var wrap = el('div', 'set-ctrl');
    var bPick = el('button', 'btn-ghost', '选择图片…');
    var bClear = el('button', 'btn-ghost', '清除');
    bClear.title = '删除当前壁纸并停用（历史里的其它壁纸保留，可点缩略图切回）';
    bPick.onclick = function () {
      bPick.disabled = true;
      wp.pick().catch(function () { }).then(function () { bPick.disabled = false; });
    };
    bClear.onclick = function () { wp.clear(); };
    wrap.appendChild(bPick); wrap.appendChild(bClear);
    row.appendChild(wrap);
    s.appendChild(row);
    var pv = document.createElement('img');
    pv.className = 'set-wp-preview'; pv.alt = '壁纸预览';
    s.appendChild(pv);

    // —— 历史壁纸条：用过的图自动留存（上限 12 张），点缩略图一键切回，hover 出 ✕ 可删 ——
    var strip = el('div', 'set-wp-strip');
    s.appendChild(markItem(strip, '历史壁纸 用过的壁纸 切换 wallpaper history'));
    function renderStrip() {
      strip.innerHTML = '';
      var list = wp.list();
      if (!list.length) { strip.style.display = 'none'; return; }
      strip.style.display = '';
      list.forEach(function (h) {
        var cell = el('div', 'set-wp-cell' + (h.id === wp.cfg.cur ? ' cur' : ''));
        cell.title = '点击切换为这张壁纸';
        var im = document.createElement('img');
        im.alt = '';
        wp.thumb(h.id).then(function (u) { if (u) im.src = u; else cell.remove(); });
        cell.appendChild(im);
        cell.onclick = function () { wp.use(h.id); };
        var del = el('button', 'set-wp-del', '✕');
        del.title = '从历史中删除';
        del.onclick = function (e) { e.stopPropagation(); wp.remove(h.id); };
        cell.appendChild(del);
        strip.appendChild(cell);
      });
    }

    // —— 模糊 / 明暗滑杆 ——
    function wpSlider(label, key, min, max, step, fmt, kw) {
      var r = markItem(el('div', 'set-row'), kw);
      var head = el('div', 'set-row-head');
      head.appendChild(el('span', 'set-label', label));
      var val = el('span', 'set-val', fmt(wp.cfg[key]));
      head.appendChild(val);
      r.appendChild(head);
      var input = document.createElement('input');
      input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = wp.cfg[key];
      input.oninput = function () {
        var v = Number(input.value);
        val.textContent = fmt(v);
        var patch = {}; patch[key] = v;
        wp.set(patch);
      };
      r.appendChild(input);
      s.appendChild(r);
      return input;
    }
    var slBlur = wpSlider('壁纸模糊', 'blur', 0, 90, 5, fmtPx, '壁纸模糊 背景模糊 wallpaper blur');
    var slDim = wpSlider('壁纸压暗', 'dim', 0, 0.85, 0.05,
      function (v) { return Math.round(v * 100) + '%'; }, '壁纸压暗 明暗 亮度 wallpaper dim brightness');

    function refresh() {
      onCk.checked = !!wp.cfg.on;
      immCk.checked = !!wp.cfg.imm;
      slBlur.value = wp.cfg.blur; slDim.value = wp.cfg.dim;
      var u = wp.thumbUrl();
      pv.style.display = u ? '' : 'none';
      if (u) pv.src = u;
      renderStrip();
      wp.hasImage().then(function (has) {
        stat.textContent = has ? (wp.cfg.on ? '已设置（生效中）' : '已设置（未启用）') : '未设置——点「选择图片」导入';
        if (has && !pv.src) {
          wp.previewUrl().then(function (u2) { if (u2) { pv.src = u2; pv.style.display = ''; } });
        }
        if (!has) { pv.removeAttribute('src'); pv.style.display = 'none'; }
      });
    }
    document.addEventListener('annie-wp-changed', refresh);
    refresh();
  }

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
    if (pageShowHooks[id]) { try { pageShowHooks[id](); } catch (e) { } }
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
      pgUiAm = pageEls['ui-am'], pgUiFb2k = pageEls['ui-fb2k'],
      pgTools = pageEls.tools,
      pgStats = pageEls.stats,
      pgDownload = pageEls.download, pgUpdate = pageEls.update, pgExt = pageEls.ext;

    /* ================= 常规 ================= */
    // —— 界面 ——
    var s4 = section(pgGeneral, '界面');
    checkRow(s4, '粒子总开关', 'particlesEnabled', applyInterface, '粒子总开关 舞台粒子 particles');
    checkRow(s4, '封面氛围背景', 'albumBg', applyInterface, '封面氛围背景 模糊 background blur');
    sliderRow(s4, '背景模糊', 'albumBgBlur', 40, 200, 10, fmtPx, applyInterface, '背景模糊 blur');
    /* V4.3：关闭按钮行为三选一（每次询问 / 隐藏到菜单栏 / 直接退出），取代旧 closeToTray 开关。
     * 主进程关闭对话框勾选「以后都这样执行」也会写同一键，经 onCloseBehaviorChanged 回同步。 */
    var cbRow = markItem(el('div', 'set-row'), '关闭按钮 关闭行为 最小化 菜单栏 退出 驻留 后台 close tray minimize quit');
    var cbLab = el('div'); cbLab.appendChild(el('div', '', '关闭按钮行为'));
    cbLab.appendChild(el('div', 'set-hint', '点窗口 ✕ 时的动作；选「每次询问」会弹窗让你选，并可勾选以后都这样执行'));
    var cbSel = document.createElement('select');
    [['ask', '每次询问'], ['tray', '隐藏到菜单栏'], ['quit', '直接退出']].forEach(function (kv) {
      var op = document.createElement('option'); op.value = kv[0]; op.textContent = kv[1];
      cbSel.appendChild(op);
    });
    var curBehavior = (ui.closeBehavior === 'tray' || ui.closeBehavior === 'quit') ? ui.closeBehavior
      : (ui.closeToTray ? 'tray' : 'ask'); // 旧设置迁移显示
    cbSel.value = curBehavior;
    // V4.4：不回写 ui.closeBehavior——旧实现把显示值（含回退 'ask'）写回 ui，
    // 之后任意 save() 都会把主进程记忆的 tray/quit 覆写成 'ask'，关闭行为记忆被静默抹掉
    cbSel.onchange = function () {
      ui.closeBehavior = cbSel.value;
      if (ui.closeBehavior === 'ask') delete ui.closeBehavior; // 询问=不记忆，主进程读不到键即弹窗
      save();
    };
    if (window.mine && window.mine.onCloseBehaviorChanged) {
      window.mine.onCloseBehaviorChanged(function (behavior) {
        ui.closeBehavior = behavior;
        cbSel.value = behavior;
      });
    }
    cbRow.appendChild(cbLab); cbRow.appendChild(cbSel);
    s4.appendChild(cbRow);

    // —— V3.5.8：全局快捷键（状态存主进程 store，IPC 开关） ——
    var sHk = section(pgGeneral, '全局快捷键');
    var hkRow = markItem(el('label', 'set-check'), '全局快捷键 媒体键 后台播放 global hotkey media keys');
    var hkInput = document.createElement('input');
    hkInput.type = 'checkbox';
    hkRow.appendChild(hkInput);
    hkRow.appendChild(el('span', '', '启用全局快捷键（软件在后台/最小化时也能控制播放）'));
    sHk.appendChild(hkRow);
    sHk.appendChild(el('div', 'set-hint', '播放/暂停 Ctrl+Alt+Space · 上一首/下一首 Ctrl+Alt+←/→ · 音量 Ctrl+Alt+↑/↓；支持键盘媒体键。Dock图标悬停也有播放控制按钮。'));
    if (window.mine.hotkeysGet) {
      window.mine.hotkeysGet().then(function (on) { hkInput.checked = !!on; }).catch(function () { });
      hkInput.onchange = function () {
        window.mine.hotkeysSetEnabled(hkInput.checked).catch(function () { });
      };
    } else hkInput.disabled = true;

    // —— V4.3.12：局域网手机遥控（脑暴 9.1） ——
    var sRm = section(pgGeneral, '手机遥控');
    var rmRow = markItem(el('label', 'set-check'), '手机遥控 局域网 遥控 配对 remote phone lan pair');
    var rmInput = document.createElement('input');
    rmInput.type = 'checkbox';
    rmRow.appendChild(rmInput);
    rmRow.appendChild(el('span', '', '启用局域网手机遥控（手机浏览器直接控制播放）'));
    sRm.appendChild(rmRow);
    var rmInfo = el('div', 'set-hint', '加载中…');
    sRm.appendChild(rmInfo);
    var rmCodeRow = markItem(el('div', 'set-row'), '配对码 重置配对 pair code reset');
    var rmCodeLab = el('div'); rmCodeLab.appendChild(el('div', '', '配对码'));
    rmCodeLab.appendChild(el('div', 'set-hint', '手机首次访问时输入；重置后所有已配对设备需重新配对'));
    var rmCodeBox = el('div');
    var rmCodeSpan = el('span', '', '————');
    rmCodeSpan.style.cssText = 'font-size:18px;letter-spacing:6px;font-weight:600;margin-right:10px;';
    var rmRegen = el('button', '', '重置');
    rmCodeBox.appendChild(rmCodeSpan); rmCodeBox.appendChild(rmRegen);
    rmCodeRow.appendChild(rmCodeLab); rmCodeRow.appendChild(rmCodeBox);
    sRm.appendChild(rmCodeRow);
    function rmRender(inf) {
      if (!inf) { rmInfo.textContent = '遥控服务不可用'; return; }
      rmCodeSpan.textContent = inf.code ? String(inf.code).split('').join(' ') : '————';
      if (inf.enabled && inf.addrs && inf.addrs.length) {
        rmInfo.textContent = '手机与电脑连同一 Wi-Fi，浏览器打开：' + inf.addrs.join(' 或 ');
      } else if (inf.enabled) {
        rmInfo.textContent = '服务启动中/启动失败（端口被占？）';
      } else {
        rmInfo.textContent = '开启后这里会显示手机访问地址；封面/进度/歌词实时同步，可控制播放/切歌/音量/播放模式';
      }
    }
    if (window.mine.remoteGetInfo) {
      window.mine.remoteGetInfo().then(function (inf) {
        rmInput.checked = !!(inf && inf.enabled);
        rmRender(inf);
      }).catch(function () { rmRender(null); });
      rmInput.onchange = function () {
        window.mine.remoteSetEnabled(rmInput.checked).then(rmRender).catch(function () { rmRender(null); });
      };
      rmRegen.onclick = function () {
        window.mine.remoteRegenCode().then(function (r) {
          if (r && r.code) rmCodeSpan.textContent = String(r.code).split('').join(' ');
        }).catch(function () { });
      };
    } else { rmInput.disabled = true; rmRegen.disabled = true; rmRender(null); }

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

    // —— 强调色自定义（V3.5.17：AM/粒子舞台变量驱动主题生效；V4.4 第三层起 FB2K 经 --f2-accent 同步接入） ——
    var accRow = markItem(el('div', 'set-row'), '强调色 主题色 accent 颜色自定义');
    var accLab = el('div'); accLab.appendChild(el('div', '', '强调色'));
    accLab.appendChild(el('div', 'set-hint', '按钮/进度条/选中高亮的颜色；作用于 AM、粒子舞台与 FB2K 主题（默认=各主题原色）'));
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

    // —— AM 频谱条配色模式（V4.3.17） ——
    var vcRow = markItem(el('div', 'set-row'), '频谱条配色 颜色 封面取色 彩虹 热成像 spectrum color');
    var vcLab = el('div'); vcLab.appendChild(el('div', '', '频谱条配色'));
    vcLab.appendChild(el('div', 'set-hint', '跟随封面：切歌自动换封面主色；封面多色：呈现封面多种颜色；黑白封面/无封面自动回落主题强调色'));
    var vcSel = document.createElement('select');
    [['cover', '跟随专辑封面'], ['coverMulti', '封面多色渐变'], ['rainbow', '彩虹频段'], ['heat', '幅度热成像'], ['accent', '主题强调色']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; vcSel.appendChild(op);
    });
    vcSel.value = ui.amVizColor || 'cover';
    vcSel.onchange = function () { ui.amVizColor = vcSel.value; save(); };
    vcRow.appendChild(vcLab); vcRow.appendChild(vcSel);
    s5.appendChild(vcRow);
    // —— 信息面板电平条（PR#6）：开关（颜色跟随封面） ——
    var lrRow2 = markItem(el('div', 'set-row'), '电平条 L/R 信息面板 频谱');
    var lrLab = el('div'); lrLab.appendChild(el('div', '', '信息面板电平条'));
    lrLab.appendChild(el('div', 'set-hint', '信息面板里那两条 L / R 电平指示，颜色跟随封面'));
    var lrSel = document.createElement('select');
    [['on', '显示'], ['off', '隐藏']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; lrSel.appendChild(op);
    });
    lrSel.value = ui.amLRBar === 'off' ? 'off' : 'on';
    try { localStorage.setItem('amLRBar', lrSel.value); } catch (e3) { }
    lrSel.onchange = function () {
      ui.amLRBar = lrSel.value; save();
      try { localStorage.setItem('amLRBar', lrSel.value); } catch (e3) { }
      var rr = document.getElementById('am-root');
      if (rr) rr.classList.toggle('am-lr-off', lrSel.value === 'off');
    };
    lrRow2.appendChild(lrLab); lrRow2.appendChild(lrSel);
    s5.appendChild(lrRow2);
    // —— 系统媒体会话（V4.4.7 PR#6）：壁纸 / 歌词挂件读歌名歌手封面 ——
    var stRow = markItem(el('div', 'set-row'), '系统媒体 Now Playing 媒体会话 壁纸 歌词挂件 浮层');
    var stLab = el('div'); stLab.appendChild(el('div', '', '系统媒体会话（Now Playing）'));
    stLab.appendChild(el('div', 'set-hint', '给 Windows 媒体浮层 / 音频壁纸 / 歌词挂件提供歌名·歌手·封面；会多一个隐藏的常驻进程'));
    var stSel = document.createElement('select');
    [['on', '开启'], ['off', '关闭']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; stSel.appendChild(op);
    });
    stSel.value = ui.amSmtc === 'off' ? 'off' : 'on';
    try { localStorage.setItem('amSmtc', stSel.value); } catch (e2) { }
    stSel.onchange = function () {
      ui.amSmtc = stSel.value; save();
      try { localStorage.setItem('amSmtc', stSel.value); } catch (e2) { }
    };
    stRow.appendChild(stLab); stRow.appendChild(stSel);
    s5.appendChild(stRow);
    // —— 待播角标样式（V4.4.7 PR#6：隐藏 / 小圆点 / 歌曲数量） ——
    var qbRow = markItem(el('div', 'set-row'), '待播角标 待播清单 队列 角标 红点 数字 徽标 badge');
    var qbLab = el('div'); qbLab.appendChild(el('div', '', '待播清单角标'));
    qbLab.appendChild(el('div', 'set-hint', '顶栏 ☰ 右上角那个小标记：隐藏不显示 / 只显示一个小圆点 / 显示待播歌曲数量'));
    var qbSel = document.createElement('select');
    [['off', '隐藏'], ['dot', '小圆点'], ['count', '歌曲数量']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; qbSel.appendChild(op);
    });
    qbSel.value = ui.amQBadge || 'dot';
    qbSel.onchange = function () { ui.amQBadge = qbSel.value; save(); };
    qbRow.appendChild(qbLab); qbRow.appendChild(qbSel);
    s5.appendChild(qbRow);

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

    // —— V4.1：界面动效（完整/精简/关闭；精简缩短时长，关闭全局关停动画与过渡） ——
    var sMo = section(pgGeneral, '外观 · 界面动效');
    var moRow = markItem(el('div', 'set-row'), '界面动效 动画 过渡 流畅 motion animation 减少动效');
    var moLab = el('div'); moLab.appendChild(el('div', '', '界面动效'));
    moLab.appendChild(el('div', 'set-hint', '启动序列 / 入场错峰 / 切歌过渡 / 弹层生长；低配机器或晕动敏感可选精简/关闭'));
    var moSel = document.createElement('select');
    [['full', '完整'], ['reduced', '精简'], ['off', '关闭']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; moSel.appendChild(op);
    });
    try { moSel.value = localStorage.getItem('annieplayer.ui.motion') || 'full'; } catch (e) { moSel.value = 'full'; }
    moSel.onchange = function () {
      try { localStorage.setItem('annieplayer.ui.motion', moSel.value); } catch (e) { }
      document.documentElement.dataset.motion = moSel.value;
    };
    moRow.appendChild(moLab); moRow.appendChild(moSel);
    sMo.appendChild(moRow);

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
    [['wasapi', 'CoreAudio'], ['asio', 'CoreAudio']].forEach(function (o) {
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
    // V4.3.12：设备热插拔——插拔耳机/DAC 后实时重填设备下拉（保持当前选中，不切换输出）
    if (!window.__devChangeBound) {
      window.__devChangeBound = true;
      document.addEventListener('annie-devices-changed', function () {
        window.mine.engine('devices.list').then(function (d) {
          devListCache = d || {};
          var keep = devSel.value || null;
          fillDevSel(kindSel.value, keep);
        }).catch(function () { });
      });
    }
    window.mine.engine('devices.list').then(function (d) {
      devListCache = d || {};
      var cur = devListCache.current || {};
      kindSel.value = cur.kind || (typeof state !== 'undefined' && state.backendKind) || 'wasapi';
      fillDevSel(kindSel.value, cur.id || null);
      syncExclRow();
    }).catch(function () { });

    // —— 独占开关（与底栏 🔒 / FB2K / AM 三处共用 exclusive.js 的切换逻辑） ——
    var exRow = markItem(el('div', 'set-row'), '独占输出 共享输出 wasapi exclusive bit-perfect 独占模式');
    var exLab = el('div'); exLab.appendChild(el('div', '', 'CoreAudio 独占输出'));
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
      var isAsio = kindSel.value === 'asio'; // CoreAudio 本身即独占，开关无意义
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
    dsdLab.appendChild(el('div', 'set-hint', 'DoP 需要设备支持 176.4kHz/24bit 独占；Native 需要 CoreAudio 驱动支持 DSD 直推；播放中切换将于下一曲生效（断流重建）'));
    var dsdSel = document.createElement('select');
    [['pcm', '转 PCM（默认）'], ['dop', 'DoP（DSD over PCM）'], ['native', 'Native（CoreAudio DSD·实验）']].forEach(function (o) {
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
      if (cur.kind !== 'wasapi') return; // CoreAudio 时 DoP 本就不可达（引擎会回退）
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
        // ⑩ 输出（共享模式下系统混音器最终设备格式引擎不可测，明确标注）
        var outputFmt = s.outputRate
          ? (s.outputRate / 1000) + ' kHz / ' + s.bitsPerSample + 'bit / ' + s.channels + 'ch' + (!s.exclusive ? '（引擎侧；系统混音器最终格式由 Windows 决定）' : '')
          : '未打开';
        stages.push({
          name: '输出', on: true, rows: [
            ['设备', (s.deviceName || '-') + '（' + (s.backendKind === 'asio' ? 'CoreAudio' : 'CoreAudio') + (s.exclusive ? ' 独占' : ' 共享') + (s.dopActive ? ' / DoP' : '') + '）'],
            ['输出格式', outputFmt],
            ['缓冲', (s.bufferMs || 0) + ' ms' + (s.preload ? ' + 整轨预载' : '')],
            ['切歌', (s.crossfadeSec > 0 ? '交叉淡入 ' + s.crossfadeSec + 's' : (ui.gapless ? '无缝（硬切不重建流）' : '普通（重建设备流）'))]
          ]
        });
        // ⑪ 健康计数（本次引擎运行累计；stats.uptimeSec 标注统计区间）
        var upSec = Math.round(s.uptimeSec || 0);
        var upTxt = Math.floor(upSec / 60) + '分' + (upSec % 60) + '秒';
        stages.push({
          name: '运行健康（本次引擎运行累计 · 已运行 ' + upTxt + '）', on: true, rows: [
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
          if (isShared) why.push('CoreAudio 共享模式（系统混音器重采样）');
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
      return window.mine.engine('stats').then(function (s) {
        if (!s || s.ok === false) throw new Error((s && s.error) || 'stats 失败');
        renderChain(s);
        var fmt = s.outputRate ? (s.requestedRate + ' → ' + s.outputRate + 'Hz / ' + s.bitsPerSample + 'bit / ' + s.channels + 'ch' + (s.resampled ? '（重采样）' : '')) : '未播放';
        var upSec = Math.round(s.uptimeSec || 0);
        // V4.4.5：播放链路状态页——补「音频输出模式」「DSD 处理」两行（此前只有设备括号注记，不够直观）
        var backendName = s.backendKind === 'asio' ? 'CoreAudio' : (s.backendKind === 'wasapi' ? 'CoreAudio' : (s.backendKind || '-'));
        var exclusiveTxt = s.backendKind === 'asio' ? '（CoreAudio 独占驱动，天然独占）' : (s.exclusive ? '（独占，绕过系统混音器）' : '（共享，经 Windows 混音器）');
        // Native 活动时 dopActive 也为 true（引擎内部同一状态位），必须先判 Native
        var dsdModeTxt = s.dsdNativeActive ? 'Native DSD（CoreAudio DSD 直推）'
          : (s.dopActive ? 'DoP（DSD 位流封装直通）' : '不适用（当前非 DSD 或已转 PCM）');
        healthText.textContent =
          '设备：' + (s.deviceName || '-') + '\n' +
          '音频输出：' + backendName + exclusiveTxt + '\n' +
          'DSD 处理：' + dsdModeTxt + '\n' +
          '格式：' + fmt + '\n' +
          '缓冲：' + (s.bufferedSec || 0) + 's / ' + Math.round((s.bufferedBytes || 0) / 1048576) + 'MB（目标 ' + (s.bufferMs || 0) + 'ms' + (s.preload ? '，整轨预载' : '') + '）\n' +
          '健康（本次引擎运行累计 ' + Math.floor(upSec / 60) + '分' + (upSec % 60) + '秒）：欠载 ' + (s.underrunCount || 0) + ' 次 / ' + (s.underrunFrames || 0) + ' 帧；限幅 ' + (s.limiterClipBlocks || 0) + ' 块；解码失败 ' + (s.decodeFailed ? '是' : '否') + '\n' +
          '最近刷新：' + new Date().toLocaleTimeString();
      }).catch(function (e) {
        healthText.textContent = '读取失败：' + (e && e.message ? e.message : e) + '\n（引擎未运行时可查看顶部故障提示条）';
      })
        .then(function () { healthBtn.disabled = false; });
    }
    healthBtn.onclick = renderAudioHealth;
    onOpenHooks.push(function () { if (currentPage === 'audio') renderAudioHealth(); });
    // V4.4.5：播放链路状态页实时化——设置面板开着且停在「音频输出」页时每 2.5s 自动刷新
    //（与统计页同款「仅面板开着才轮询」模式，面板关闭零开销，不引入常驻定时器成本）
    setInterval(function () {
      if (panel && panel.classList.contains('open') && currentPage === 'audio' && !healthBtn.disabled) renderAudioHealth();
    }, 2500);

    /* ================= 播放 ================= */
    // —— 播放模式（默认；与底栏/AM 顶栏按钮共用 playmode.js） ——
    var sPm = section(pgPlayback, '播放模式');
    var pmRow = markItem(el('div', 'set-row'), '播放模式 顺序播放 随机播放 单曲循环 shuffle repeat');
    var pmLab = el('div'); pmLab.appendChild(el('div', '', '默认播放模式'));
    pmLab.appendChild(el('div', 'set-hint', '与播放栏的模式按钮同步；本地全量生效，在线播放支持顺序/随机/单曲循环'));
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
    peqTopLab.appendChild(el('div', 'set-hint', '自定义频率/增益/Q 值的自由频段（最多 8 段），与 15 段 EQ 串联；耳机校准方案（如 AutoEq）按频段逐条添加即可'));
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
      if (ui.peqBands.length >= 8) return; // V4.0.3：与引擎上限对齐（引擎 peq.set 拒绝 >8 段）
      ui.peqBands.push({ f: 1000, g: 0, q: 1.0 });
      if (!ui.peqOn) { ui.peqOn = true; peqChk.checked = true; }
      save(); pushPeq(); renderPeqBands();
    };
    renderPeqBands();

    // —— AutoEq 耳机校正导入（V4.2）：官方全量库内置（autoeq-subset.json，scripts/autoeq-build.js 生成） ——
    var aeWrap = markItem(el('div', 'set-row'), 'autoeq 耳机校正 headphone calibration 导入 型号');
    var aeLab = el('div'); aeLab.appendChild(el('div', '', 'AutoEq 耳机校正'));
    aeLab.appendChild(el('div', 'set-hint', '按耳机型号套用 AutoEq 实测校正曲线（oratory1990 / crinacle / Rtings 等来源）；低架/高架滤波以峰值滤波近似，前级增益由自动前级补偿接管'));
    aeWrap.appendChild(aeLab);
    // V4.3.19：AutoEq 结果文件导入（脑暴 7.2）——ParametricEQ.txt → PEQ 自由频段；GraphicEQ.txt / freq,gain CSV → 15 段 EQ（log 插值）
    var aeFileBtn = el('button', 'btn-ghost', '导入结果文件…');
    aeFileBtn.style.cssText = 'width:auto;padding:6px 12px;font-size:12px;margin:6px 0 2px';
    aeFileBtn.title = '支持 AutoEq 网页版下载的 ParametricEQ / GraphicEQ 结果文件（.txt），或 频率,增益 两列 CSV';
    var aeFile = document.createElement('input');
    aeFile.type = 'file'; aeFile.accept = '.txt,.csv'; aeFile.style.display = 'none';
    aeFileBtn.onclick = function () { aeFile.click(); };
    aeFile.onchange = function () {
      var f = aeFile.files && aeFile.files[0];
      aeFile.value = '';
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var toast = function (s) { try { if (typeof proToast === 'function') proToast(s, 6000); } catch (e) { } };
        try {
          var text = String(rd.result || '');
          // Parametric：Filter  1: ON PK Fc 105.0 Hz Gain -2.9 dB Q 0.70（GEQ 类型行归为图示曲线）
          var peq = [], geqPts = [];
          var re = /Filter\s+\d+:\s+ON\s+([A-Za-z]+)\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+(-?[\d.]+)\s*dB(?:\s+Q\s+([\d.]+))?/g;
          var mm;
          while ((mm = re.exec(text))) {
            var tp = mm[1].toUpperCase();
            if (tp === 'GEQ') geqPts.push([+mm[2], +mm[3]]);
            else peq.push({ f: +mm[2], g: +mm[3], q: +(mm[4] || 1) }); // 低架/高架以峰值近似（与内置库一致）
          }
          if (!geqPts.length) { // 纯文本/CSV：每行 "freq gain"（逗号/空白/分号分隔）
            text.split(/\r?\n/).forEach(function (line) {
              var g = /^\s*([\d.]+)[\s,;]+(-?[\d.]+)\s*$/.exec(line);
              if (g && +g[1] >= 10 && +g[1] <= 22050) geqPts.push([+g[1], +g[2]]);
            });
          }
          if (peq.length) {
            // 引擎上限 8 段：超了按 |增益| 保大头，再按频率排序
            if (peq.length > 8) {
              peq = peq.slice().sort(function (a, b) { return Math.abs(b.g) - Math.abs(a.g); }).slice(0, 8)
                .sort(function (a, b) { return a.f - b.f; });
            }
            ui.peqBands = peq.map(function (b) { return { f: b.f, g: b.g, q: b.q }; });
            ui.peqOn = true; peqChk.checked = true;
            save(); pushPeq(); renderPeqBands();
            toast('已导入 ' + f.name + '：' + peq.length + ' 段参量 EQ 频段');
            return;
          }
          if (geqPts.length >= 2) {
            geqPts.sort(function (a, b) { return a[0] - b[0]; });
            var EQ = window.annieEQ;
            if (!EQ) { toast('EQ 模块未就绪'); return; }
            EQ.FREQS.forEach(function (tf, i) {
              // log 域分段线性插值（相邻恒 Q 段间误差 <1dB）
              var lt = Math.log(tf), g0 = geqPts[0], g1 = geqPts[geqPts.length - 1], v;
              if (tf <= g0[0]) v = g0[1];
              else if (tf >= g1[0]) v = g1[1];
              else {
                for (var k = 0; k < geqPts.length - 1; k++) {
                  var a = geqPts[k], b = geqPts[k + 1];
                  if (tf >= a[0] && tf <= b[0]) {
                    v = a[1] + (b[1] - a[1]) * (lt - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]));
                    break;
                  }
                }
              }
              EQ.setGain(i, v);
            });
            EQ.setEnabled(true);
            toast('已导入 ' + f.name + '：曲线已映射到 15 段 EQ');
            return;
          }
          toast('未识别：请使用 AutoEq 的 ParametricEQ / GraphicEQ 结果文件，或「频率,增益」两列 CSV');
        } catch (e) {
          try { if (typeof proToast === 'function') proToast('解析失败：' + (e && e.message || e)); } catch (e2) { }
        }
      };
      rd.readAsText(f);
    };
    aeLab.appendChild(aeFileBtn); aeLab.appendChild(aeFile);
    sPeq.appendChild(aeWrap);
    var aeBox = el('div', 'autoeq-box');
    var aeIn = document.createElement('input');
    aeIn.type = 'text'; aeIn.className = 'autoeq-search'; aeIn.placeholder = '输入耳机型号，如 HD650 / 森海 / AirPods / Kato…';
    aeBox.appendChild(aeIn);
    var aeList = el('div', 'autoeq-list');
    var aePrev = el('div', 'set-hint');
    aeBox.appendChild(aeList); aeBox.appendChild(aePrev);
    sPeq.appendChild(aeBox);
    var aeData = null, aeSel = null, aeLoading = false;
    var AE_TYPE = { 'in-ear': '入耳', 'over-ear': '头戴', 'earbud': '平头/耳塞', other: '其他' };
    /* V4.3.15：型号归一化匹配——忽略空格/连字符（HD650 = HD 650）+ 中文品牌别名（森海=Sennheiser 等）。
     * 别名键按长度降序排列（"森海塞尔"先于"森海"命中）。 */
    var AE_ALIAS = {
      '森海塞尔': 'sennheiser', '拜亚动力': 'beyerdynamic', '铁三角': 'audio-technica',
      '水月雨': 'moondrop', '天使吉米': 'tangzu', '弱水时砂': 'rose technics', '达音科': 'dunu',
      '森海': 'sennheiser', '索尼': 'sony', '苹果': 'apple', '拜亚': 'beyerdynamic',
      '舒尔': 'shure', '爱科技': 'akg', '歌德': 'grado', '飞傲': 'fiio', '兴戈': 'simgot',
      '博士': 'bose', '音特美': 'etymotic', '漫步者': 'edifier', '宁梵': 'nf audio'
    };
    var AE_ALIAS_KEYS = Object.keys(AE_ALIAS);
    var aeNorm = function (s) { return String(s).toLowerCase().replace(/[\s\-_·]+/g, ''); };
    function aeLoad() { // 首次输入时懒加载子集
      if (aeData || aeLoading) return; aeLoading = true;
      fetch('autoeq-subset.json').then(function (r) { return r.json(); }).then(function (d) {
        aeData = d; aeLoading = false;
        if (aeIn.value.trim()) aeRender();
      }).catch(function () { aeLoading = false; aePrev.textContent = '校正数据加载失败（autoeq-subset.json 缺失？）'; });
    }
    function aeRender() {
      aeList.innerHTML = '';
      var q = aeIn.value.trim().toLowerCase();
      if (!q || !aeData) { if (q && !aeData) aeLoad(); return; }
      for (var ai = 0; ai < AE_ALIAS_KEYS.length; ai++) q = q.split(AE_ALIAS_KEYS[ai]).join(AE_ALIAS[AE_ALIAS_KEYS[ai]]);
      var tokens = q.split(/\s+/).filter(Boolean).map(aeNorm);
      // 每个词元都要求命中（归一化后子串），多词可组合过滤（如「森海 hd650」）
      var hits = aeData.models.filter(function (m) {
        var n = aeNorm(m.n);
        return tokens.every(function (t) { return n.indexOf(t) >= 0; });
      }).slice(0, 8);
      if (!hits.length) { aeList.appendChild(el('div', 'set-hint', '库内无匹配型号（共 ' + aeData.count + ' 款，支持中文品牌名如「森海」；可手动按 AutoEq 网页结果加频段）')); return; }
      hits.forEach(function (m) {
        var it = el('div', 'autoeq-item' + (aeSel === m ? ' sel' : ''));
        it.appendChild(el('span', 'autoeq-name', m.n));
        it.appendChild(el('span', 'autoeq-meta', (AE_TYPE[m.type] || m.type) + ' · ' + m.src));
        it.onclick = function () { aeSel = m; aeRender(); aeShowPrev(); };
        aeList.appendChild(it);
      });
    }
    function aeShowPrev() {
      var m = aeSel; if (!m) return;
      aePrev.innerHTML = '';
      aePrev.appendChild(el('div', '', m.n + '（' + m.b.length + ' 段' + (m.pre != null ? '，AutoEq 前级 ' + m.pre + ' dB 由自动补偿接管' : '') + '）：' +
        m.b.map(function (b) { return b[0] + 'Hz ' + (b[1] > 0 ? '+' : '') + b[1] + 'dB Q' + b[2]; }).join(' · ')));
      var btn = el('button', 'btn-ghost', '✓ 套用到参量 EQ');
      btn.style.cssText = 'width:auto;padding:6px 14px;font-size:12px;margin-top:6px';
      btn.onclick = function () {
        ui.peqBands = m.b.map(function (b) { return { f: b[0], g: b[1], q: b[2] }; });
        ui.peqOn = true; peqChk.checked = true;
        save(); pushPeq(); renderPeqBands();
        try { if (typeof proToast === 'function') proToast('已套用 ' + m.n + ' 的 AutoEq 校正（' + m.b.length + ' 段）'); } catch (e) { }
      };
      aePrev.appendChild(btn);
    }
    aeIn.addEventListener('input', function () { aeSel = null; aePrev.innerHTML = ''; aeLoad(); aeRender(); });

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

    // —— 桌面歌词外观（与歌词条 ⚙ 面板同一份 LS 配置，歌词条经 storage 事件实时套用；
    //    部分机器透明窗不响应悬停/鼠标，这里是兜底入口） ——
    var DL_LS = 'annieplayer.pro.dlyrics';
    var DL_DEF = { scale: 1, opacity: 1, locked: false, color: '#ffd23f', nextColor: 'rgba(232,234,240,.65)', align: 'center', single: false, bg: 55 };
    function dlCfgGet() {
      var c = {}; try { c = JSON.parse(localStorage.getItem(DL_LS) || '{}') || {}; } catch (e) { }
      for (var k in DL_DEF) if (c[k] === undefined) c[k] = DL_DEF[k];
      return c;
    }
    function dlCfgSet(k, v) { var c = dlCfgGet(); c[k] = v; try { localStorage.setItem(DL_LS, JSON.stringify(c)); } catch (e) { } }
    var dlG = section(pgLyrics, '桌面歌词外观');
    function dlSwatchRow(label, key, colors, kw) {
      var r = markItem(el('div', 'set-row'), kw);
      var head = el('div', 'set-row-head');
      head.appendChild(el('span', 'set-label', label));
      var sw = el('div'); sw.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      var cur = dlCfgGet()[key];
      colors.forEach(function (c) {
        var dot = el('i');
        dot.style.cssText = 'width:18px;height:18px;border-radius:50%;cursor:pointer;background:' + c +
          ';border:2px solid ' + (c === cur ? '#fff' : 'transparent');
        dot.onclick = function () {
          dlCfgSet(key, c);
          sw.querySelectorAll('i').forEach(function (x) { x.style.borderColor = 'transparent'; });
          dot.style.borderColor = '#fff';
        };
        sw.appendChild(dot);
      });
      head.appendChild(sw); r.appendChild(head); dlG.appendChild(r);
    }
    dlSwatchRow('当前行颜色', 'color', ['#ffd23f', '#ff5f7e', '#4fc3f7', '#7ee787', '#c792ea', '#ffffff'], '桌面歌词 当前行 颜色 color');
    dlSwatchRow('未唱/下一行颜色', 'nextColor', ['rgba(232,234,240,.65)', 'rgba(255,255,255,.9)', 'rgba(255,210,63,.6)', 'rgba(138,144,165,.8)'], '桌面歌词 下一行 未唱 颜色 next color');
    var dlAlRow = markItem(el('div', 'set-row'), '桌面歌词 对齐 左 中 右 align');
    var dlAlHead = el('div', 'set-row-head');
    dlAlHead.appendChild(el('span', 'set-label', '对齐'));
    var dlAlSel = document.createElement('select');
    [['left', '左对齐'], ['center', '居中'], ['right', '右对齐']].forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; dlAlSel.appendChild(op);
    });
    dlAlSel.value = dlCfgGet().align;
    dlAlSel.onchange = function () { dlCfgSet('align', dlAlSel.value); };
    dlAlHead.appendChild(dlAlSel); dlAlRow.appendChild(dlAlHead); dlG.appendChild(dlAlRow);
    var dlSgRow = markItem(el('label', 'set-check'), '桌面歌词 单行模式 只显示当前行 single line');
    var dlSgChk = document.createElement('input'); dlSgChk.type = 'checkbox';
    dlSgChk.checked = !!dlCfgGet().single;
    dlSgChk.onchange = function () { dlCfgSet('single', dlSgChk.checked); };
    dlSgRow.appendChild(dlSgChk); dlSgRow.appendChild(el('span', '', '单行模式（只显示当前行）'));
    dlG.appendChild(dlSgRow);
    // V4.3.13：锁定也在这里——歌词条悬停/点击失灵的机器上，这是解锁的唯一可达入口
    var dlLkRow = markItem(el('label', 'set-check'), '桌面歌词 锁定 鼠标穿透 lock mouse-through');
    var dlLkChk = document.createElement('input'); dlLkChk.type = 'checkbox';
    dlLkChk.checked = !!dlCfgGet().locked;
    dlLkChk.onchange = function () { dlCfgSet('locked', dlLkChk.checked); };
    dlLkRow.appendChild(dlLkChk); dlLkRow.appendChild(el('span', '', '锁定桌面歌词（鼠标穿透，点不到歌词条）'));
    dlG.appendChild(dlLkRow);
    // 兼容模式：高 DPI（缩放≠100%）下透明窗鼠标事件会整个丢失（Electron/Windows 已知未解 bug）
    // → 重建为不透明窗口，牺牲圆角透明换 100% 可点可拖；开关后歌词条自动重建
    var dlCpRow = markItem(el('label', 'set-check'), '桌面歌词 兼容模式 鼠标失灵 点不到 拖不动 透明窗 compat high dpi');
    var dlCpChk = document.createElement('input'); dlCpChk.type = 'checkbox';
    if (window.mine.dlyricsGetCompat) window.mine.dlyricsGetCompat().then(function (v) { dlCpChk.checked = !!v; });
    dlCpChk.onchange = function () { if (window.mine.dlyricsSetCompat) window.mine.dlyricsSetCompat(dlCpChk.checked); };
    dlCpRow.appendChild(dlCpChk); dlCpRow.appendChild(el('span', '', '兼容模式（歌词条点不到/拖不动时开启：纯色底，牺牲圆角透明）'));
    dlG.appendChild(dlCpRow);
    function dlSliderRow(label, key, min, max, step, fmt, kw) {
      var row = markItem(el('div', 'set-row'), kw);
      var head = el('div', 'set-row-head');
      head.appendChild(el('span', 'set-label', label));
      var cur = Number(dlCfgGet()[key]); if (!isFinite(cur)) cur = DL_DEF[key];
      var val = el('span', 'set-val', fmt(cur));
      head.appendChild(val); row.appendChild(head);
      var input = document.createElement('input');
      input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = cur;
      input.oninput = function () { var v = Number(input.value); val.textContent = fmt(v); dlCfgSet(key, v); };
      row.appendChild(input); dlG.appendChild(row);
    }
    dlSliderRow('字号', 'scale', 0.6, 2.2, 0.05, function (v) { return Math.round(v * 100) + '%'; }, '桌面歌词 字号 大小 font size');
    dlSliderRow('背景深浅', 'bg', 0, 85, 5, function (v) { return Math.round(v) + '%'; }, '桌面歌词 背景 深浅 background');
    dlSliderRow('窗口不透明度', 'opacity', 0.3, 1, 0.05, function (v) { return Math.round(v * 100) + '%'; }, '桌面歌词 不透明度 opacity');

    /* ================= V4.4：AM 界面（主题专属设置页） ================= */
    buildWallpaperSection(pgUiAm);
    var sAmI = section(pgUiAm, '界面布局');
    // 歌曲列表按专辑分组（与分组表头、右键组头配套；默认平铺）
    checkRow(sAmI, '歌曲列表按专辑分组（默认平铺）', 'amSongGroup', function () {
      if (ui.amSongGroup && ui.amSongSort === 'az') { ui.amSongSort = 'albumAz'; }   // 开分组时默认按专辑名 A–Z
      try { var AM = window.__annieAMInternal; if (AM && AM.renderKeepScroll) AM.renderKeepScroll(); } catch (e) { }   // 立即重绘当前视图（保持滚动位置）
    }, '专辑 分组 专辑分组 组头 平铺 album group');
    sAmI.appendChild(el('div', 'set-hint', '本页设置仅作用于 AM 主题（切换主题互不影响）'));
    // —— 顶栏位置（顶部/底部）——
    var tbRow = markItem(el('div', 'set-row'), 'am 顶栏位置 底部 播放控制 进度条 转移 topbar bottom');
    var tbLab = el('div'); tbLab.appendChild(el('div', '', '顶栏位置'));
    tbLab.appendChild(el('div', 'set-hint', '播放控制/进度条/工具按钮所在横条；选「底部」则整条移到窗口下方'));
    var tbSel = document.createElement('select');
    [['', '顶部（默认）'], ['bottom', '底部']].forEach(function (kv) {
      var op = document.createElement('option'); op.value = kv[0]; op.textContent = kv[1];
      tbSel.appendChild(op);
    });
    tbSel.value = ui.amTopbarBottom ? 'bottom' : '';
    tbSel.onchange = function () { ui.amTopbarBottom = tbSel.value === 'bottom'; applyInterface(); save(); };
    tbRow.appendChild(tbLab); tbRow.appendChild(tbSel);
    sAmI.appendChild(tbRow);
    // —— 沉浸模式真全屏（隐藏Dock；沉浸中切换立即生效） ——
    checkRow(sAmI, '沉浸模式真全屏（隐藏Dock）', 'amImmFullscreen', function () {
      try {
        var amRoot2 = document.getElementById('am-root');
        var immOn = !!(amRoot2 && amRoot2.classList.contains('am-imm-on'));
        if (window.mine && window.mine.winFullScreen) window.mine.winFullScreen(!!ui.amImmFullscreen && immOn);
      } catch (e) { }
    }, '沉浸模式 全屏 Dock 隐藏 fullscreen immersive');
    // —— 重启恢复上次播放（V4.4.2 起改为启动时弹窗询问是否续播，不再静默起播） ——
    checkRow(sAmI, '启动时询问是否续播上次曲目（含进度）', 'amResume', function () {
      if (!ui.amResume) { // 关闭时清掉已存的恢复点，避免下次开启时恢复到陈旧曲目
        try {
          localStorage.removeItem('annieplayer.resume.v1');
          localStorage.removeItem('annieplayer.resume.pos');
        } catch (e) { }
      }
    }, '启动 恢复播放 续播 进度 记忆 restart resume');
    // —— 沉浸模式样式（经典双栏 / 彩胶唱片；沉浸中切换立即重建生效） ——
    var imRow = markItem(el('div', 'set-row'), '沉浸模式 样式 彩胶 黑胶 唱片 经典 vinyl immersive style');
    var imLab = el('div'); imLab.appendChild(el('div', '', '沉浸模式样式'));
    imLab.appendChild(el('div', 'set-hint', '经典双栏：左封面右歌词；彩胶唱片：右侧旋转彩胶（颜色跟随封面）+ 左侧大歌词 + 底部功能栏'));
    var imSel = document.createElement('select');
    [['classic', '经典双栏（默认）'], ['vinyl', '彩胶唱片']].forEach(function (kv) {
      var op = document.createElement('option'); op.value = kv[0]; op.textContent = kv[1];
      imSel.appendChild(op);
    });
    imSel.value = ui.amImmMode || 'classic';
    imSel.onchange = function () {
      ui.amImmMode = imSel.value; save();
      if (window.__annieAMInternal && __annieAMInternal.refreshImmMode) __annieAMInternal.refreshImmMode();
    };
    imRow.appendChild(imLab); imRow.appendChild(imSel);
    sAmI.appendChild(imRow);
    // —— V4.4.8：封面取色权重（影响频谱 / 侧栏搜索框 / A–Z 索引条的颜色） ——
    var vwRow = markItem(el('div', 'set-row'), '封面取色 权重 偏冷 偏暖 按面积 pick color weight cool warm area');
    var vwLab = el('div'); vwLab.appendChild(el('div', '', '封面取色权重'));
    vwLab.appendChild(el('div', 'set-hint', '偏冷：青蓝优先；偏暖：红橙优先；按面积：像素多的颜色优先（不看冷暖）'));
    var vwSel = document.createElement('select');
    [['area', '按面积（默认）'], ['cool', '偏冷'], ['warm', '偏暖']].forEach(function (kv) {
      var op = document.createElement('option'); op.value = kv[0]; op.textContent = kv[1];
      vwSel.appendChild(op);
    });
    vwSel.value = (window.amVizColor && window.amVizColor.weight) ? window.amVizColor.weight() : (localStorage.getItem('annieplayer.am.vizweight2') || 'area');
    vwSel.onchange = function () {
      if (window.amVizColor && window.amVizColor.setWeight) window.amVizColor.setWeight(vwSel.value);
      else { try { localStorage.setItem('annieplayer.am.vizweight2', vwSel.value); } catch (e) { } }
      try { if (window.__annieAMInternal && __annieAMInternal.refreshVizColor) __annieAMInternal.refreshVizColor(); } catch (e) { }
    };
    vwRow.appendChild(vwLab); vwRow.appendChild(vwSel);
    sAmI.appendChild(vwRow);
    // —— V4.4.8：侧栏搜索框 / A–Z 索引条的底色来源 ——
    var stRow = markItem(el('div', 'set-row'), '搜索框底色 取色 来源 跟随封面 主色 不着色 search tone');
    var stLab = el('div'); stLab.appendChild(el('div', '', '搜索框 / A–Z 底色'));
    stLab.appendChild(el('div', 'set-hint', '跟随封面：取封面里偏暖的那条色（当前默认）；跟随主色：与频谱同一个颜色；不着色：只留毛玻璃'));
    var stSel = document.createElement('select');
    [['cover', '跟随封面（默认）'], ['prime', '跟随频谱主色'], ['plain', '不着色']].forEach(function (kv) {
      var op = document.createElement('option'); op.value = kv[0]; op.textContent = kv[1];
      stSel.appendChild(op);
    });
    stSel.value = ui.amSearchTone || 'cover';
    stSel.onchange = function () {
      ui.amSearchTone = stSel.value; save();
      try { if (window.__annieAMInternal && __annieAMInternal.refreshVizColor) __annieAMInternal.refreshVizColor(); } catch (e) { }
    };
    stRow.appendChild(stLab); stRow.appendChild(stSel);
    sAmI.appendChild(stRow);
    // —— AM 歌词样式（自「歌词」页迁入本页，V4.4） ——
    var sAmLyr = section(pgUiAm, '歌词样式');
    lsSliderRow(sAmLyr, 'AM 歌词字号', 'annieplayer.am.lyrscale', 0.7, 1.6, 0.05, 1, fmt2, function () {
      if (window.amLyrStyle) window.amLyrStyle();
    }, 'am 歌词字号 字体大小 apple music font size');
    lsSliderRow(sAmLyr, 'AM 歌词行距', 'annieplayer.am.lyrlh', 1.2, 2.2, 0.05, 1.45, fmt2, function () {
      if (window.amLyrStyle) window.amLyrStyle();
    }, 'am 歌词行距 行高 line height');
    lsSliderRow(sAmLyr, 'AM 每行词数', 'annieplayer.am.lyrwordlimit', 0, 12, 1, 0,
      function (v) { return v === 0 ? '自动' : String(Math.round(v)); }, function () {
        if (window.amLyrRerender) window.amLyrRerender();
      }, 'am 每行词数 折行 word limit');
    // —— 沉浸模式歌词外观（与主界面右栏歌词各自独立；V4.4）。未配置时默认值取自主界面现有调校 ——
    var immSeedSc = parseFloat(localStorage.getItem('annieplayer.am.lyrscale')) || 1;
    var immSeedLh = parseFloat(localStorage.getItem('annieplayer.am.lyrlh')) || 1.45;
    lsSliderRow(sAmLyr, '沉浸歌词字号', 'annieplayer.imm.lyrscale', 0.7, 1.6, 0.05, immSeedSc, fmt2, function () {
      if (window.amLyrStyle) window.amLyrStyle();
    }, '沉浸 歌词字号 字体大小 immersive font size');
    lsSliderRow(sAmLyr, '沉浸歌词行距', 'annieplayer.imm.lyrlh', 1.2, 2.2, 0.05, immSeedLh, fmt2, function () {
      if (window.amLyrStyle) window.amLyrStyle();
    }, '沉浸 歌词行距 行高 immersive line height');
    lsSliderRow(sAmLyr, '沉浸每行词数', 'annieplayer.imm.lyrwordlimit', 0, 12, 1, 0,
      function (v) { return v === 0 ? '自动' : String(Math.round(v)); }, function () {
        if (window.amLyrRerender) window.amLyrRerender();
      }, '沉浸 每行词数 折行 immersive word limit');

    /* ================= V4.4：FB2K 界面（主题专属设置页） ================= */
    buildWallpaperSection(pgUiFb2k);
    var sF2 = section(pgUiFb2k, '外观');
    sF2.appendChild(el('div', 'set-hint', '本页设置仅作用于仿 FB2K 主题（FB2K 工具栏 🌙 按钮 / Ctrl+Shift+D 与本开关联动）'));
    // 暗色模式：fb2k.js 的 LS 是 JSON 序列化（true/false），与 lsCheckRow 的 '1'/'0' 不兼容——自定义读写
    var f2DarkRow = markItem(el('label', 'set-check'), 'fb2k 暗色模式 夜间 dark mode');
    var f2DarkInput = document.createElement('input');
    f2DarkInput.type = 'checkbox';
    try { f2DarkInput.checked = JSON.parse(localStorage.getItem('annieplayer.fb2k.dark') || 'false'); } catch (e) { }
    f2DarkInput.onchange = function () {
      if (window.annieFb2k && window.annieFb2k.setDark) window.annieFb2k.setDark(f2DarkInput.checked);
      else try { localStorage.setItem('annieplayer.fb2k.dark', JSON.stringify(f2DarkInput.checked)); } catch (e) { }
    };
    document.addEventListener('annie-f2-dark-changed', function (e) {
      f2DarkInput.checked = !!(e.detail && e.detail.dark); // FB2K 内切换后回同步本开关
    });
    f2DarkRow.appendChild(f2DarkInput);
    f2DarkRow.appendChild(el('span', '', '暗色模式'));
    sF2.appendChild(f2DarkRow);

    // —— 在线匹配默认保存项（match 弹窗三个复选框的初始值） ——
    var sMatch = section(pgLyrics, '在线匹配 · 默认保存项');
    var matchHint = el('div', 'set-hint', '打开「在线匹配歌词 / 封面」弹窗时的默认勾选（弹窗内可临时改）');
    lsCheckRow(sMatch, '保存歌词（旁挂 .lrc）', 'annieplayer.match.def.lrc', true, null, '在线匹配 保存歌词 lrc');
    lsCheckRow(sMatch, '保存封面（cover.jpg）', 'annieplayer.match.def.cover', true, null, '在线匹配 保存封面 cover');
    lsCheckRow(sMatch, '同时嵌入文件标签', 'annieplayer.match.def.embed', false, null, '在线匹配 嵌入标签 embed');
    lsCheckRow(sMatch, '播放时自动在线补齐缺失歌词', 'annieplayer.lrc.autofetch', true, null, '播放时自动补齐歌词 自动在线歌词 实时歌词 auto lyric fetch');
    sMatch.appendChild(el('div', 'set-hint', '自动补齐：播放到无歌词的本地歌曲时实时五平台匹配（≥80% 取最高分），歌词与封面仅用于本次显示、不写盘；要写盘请用右键「在线匹配」或下方批量匹配。CUE/ISO 分轨不自动匹配。'));
    sMatch.appendChild(matchHint);

    // —— V4.3.4：批量匹配歌词（≥80% 自动存旁挂 .lrc；整个曲库 / 文件夹） ——
    var sBm = section(pgLyrics, '批量匹配歌词');
    var bmRow = markItem(el('div', 'set-row'), '批量匹配歌词 整个曲库 文件夹 自动 lrc batch lyrics');
    var bmLab = el('div'); bmLab.appendChild(el('div', '', '自动批量匹配（歌词）'));
    bmLab.appendChild(el('div', 'set-hint', '五平台搜索取最高分，匹配度 ≥80% 自动保存旁挂 .lrc（含翻译行）；已有歌词的默认跳过，未匹配的列清单'));
    var bmWrap = el('div', 'set-ctrl');
    var bmBtnAll = el('button', 'btn-ghost', '整个曲库');
    var bmBtnDir = el('button', 'btn-ghost', '文件夹…');
    bmBtnAll.onclick = function () {
      var lib = (typeof state !== 'undefined') ? state.library : null;
      if (!lib || !lib.tracks.length) return;
      if (window.annieBatchMatch) window.annieBatchMatch.open(lib.tracks.map(function (t) { return t.path; }));
    };
    bmBtnDir.onclick = function () {
      window.mine.fakeScanPickFolder().then(function (r) { // 复用：选文件夹并递归枚举音频
        if (!r || !r.ok) return;
        if (window.annieBatchMatch) window.annieBatchMatch.open(r.paths);
      }).catch(function () { });
    };
    bmWrap.appendChild(bmBtnAll); bmWrap.appendChild(bmBtnDir);
    bmRow.appendChild(bmLab); bmRow.appendChild(bmWrap);
    sBm.appendChild(bmRow);

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
    buildWallpaperSection(pgVisual);
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
    checkRow(s2, '节拍律动分析', 'beatAnalysis', applyVisual, '节拍律动 相机 鼓点 beat analysis 弱机');
    s2.appendChild(el('div', 'set-hint', '节拍律动分析关闭后相机不再随鼓点运动（弱机建议关，省整轨解码）；封面粒子密度在切歌后生效'));

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
      prSaveBtn.onclick = function () {
        if (!fx.cfg.slots.length) { fxStat.textContent = '当前链为空，先添加插件'; return; }
        // V4.1：Electron 不支持原生 prompt()，走应用内输入对话框
        window.anniePrompt('方案名称', '我的方案 ' + (fx.presets.list().length + 1), async function (name) {
          prSaveBtn.disabled = true; prSaveBtn.textContent = '保存中…';
          try {
            await fx.presets.saveAs(name.trim());
            refreshPresets();
            fxStat.textContent = '已保存方案「' + name.trim() + '」';
          } catch (e) { fxStat.textContent = '保存失败：' + (e && e.message ? e.message : e); }
          prSaveBtn.disabled = false; prSaveBtn.textContent = '存为方案…';
        });
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

    // —— V4.3.16：曲库节奏（BPM）补算——为「找相似歌曲」供特征 ——
    var bpmBtnRow = markItem(el('div', 'set-row'), '曲库节奏补算 BPM 相似推荐 music-tempo');
    var bpmBtnLab = el('div'); bpmBtnLab.appendChild(el('div', '', '曲库节奏补算（BPM）'));
    bpmBtnLab.appendChild(el('div', 'set-hint', '后台逐轨分析节奏（music-tempo，约每首数秒），供「找相似歌曲」打分；CUE/ISO 分轨跳过'));
    var bpmBtn = el('button', 'btn-ghost', '开始补算');
    var bpmBusy = false;
    bpmBtn.onclick = async function () {
      if (bpmBusy) { window.annieRhythm.batchCancel(); return; }
      bpmBusy = true;
      bpmBtn.textContent = '补算中…（点击取消）';
      var r = await window.annieRhythm.batchFill(function (done, total) {
        bpmBtn.textContent = '补算中 ' + done + '/' + total + '（点击取消）';
      });
      bpmBusy = false;
      bpmBtn.textContent = r.canceled ? '已取消（' + r.ok + ' 首已分析）' : (r.total ? '完成：' + r.ok + '/' + r.total + ' 首' : '全部已分析 ✓');
      setTimeout(function () { bpmBtn.textContent = '开始补算'; }, 4000);
    };
    bpmBtnRow.appendChild(bpmBtnLab); bpmBtnRow.appendChild(bpmBtn);
    sFk.appendChild(bpmBtnRow);

    // —— 假无损批量检测（V4.0.5：四方法加权融合；整库/文件夹/单曲三种范围；只出报告不打标） ——
    var fkRow = markItem(el('div', 'set-row'), '假无损 批量检测 频谱 fake lossless 文件夹 单曲');
    var fkLab = el('div'); fkLab.appendChild(el('div', '', '无损鉴别（假无损检测）'));
    fkLab.appendChild(el('div', 'set-hint', '四方法加权融合（频谱截止/编码帧痕迹/位深量化/上转换）；结果只出诊断报告，不在列表打标记'));
    var fkWrap = el('div', 'set-ctrl');
    var fkBtnAll = el('button', 'btn-ghost', '整个曲库');
    var fkBtnDir = el('button', 'btn-ghost', '文件夹…');
    var fkBtnOne = el('button', 'btn-ghost', '单曲…');
    var fkBusy = false, fkResults = [], fkLast = null;
    function fkResetBtns() { fkBtnAll.textContent = '整个曲库'; fkBtnDir.textContent = '文件夹…'; fkBtnOne.textContent = '单曲…'; }
    function fkRun(paths, btn, label) {
      if (fkBusy) { window.mine.fakeScanCancel(); return; }
      if (!paths || !paths.length) { btn.textContent = '未发现音频文件'; setTimeout(fkResetBtns, 2000); return; }
      fkBusy = true; fkResults = []; fkLast = null;
      btn.textContent = '检测中 0/' + paths.length + '（点击取消）';
      window.mine.fakeScanBatchStart(paths);
      var off = window.mine.onFakeScanEvent(function (ev) {
        if (ev.type === 'progress') {
          btn.textContent = '检测中 ' + ev.done + '/' + ev.total + ' · 疑似 ' + ev.suspect + '（点击取消）';
          if (ev.verdict === 'suspect' || ev.verdict === 'clean') {
            fkResults.push({ path: ev.path, cutoff: ev.cutoff, verdict: ev.verdict, reason: ev.reason, score: ev.score, grade: ev.grade });
            fkLast = { path: ev.path, verdict: ev.verdict, score: ev.score, grade: ev.grade, reason: ev.reason };
          }
        } else if (ev.type === 'end') {
          off(); fkBusy = false;
          btn.textContent = (ev.canceled ? '已取消，' : '完成：') + '疑似 ' + ev.suspect + ' 首 / 共 ' + ev.done + ' 首';
          fkCsvBtn.disabled = fkHtmlBtn.disabled = fkResults.length === 0;
          // 单曲模式：直接弹判定结论
          if (label === 'one' && fkLast) {
            try { if (typeof proToast === 'function') proToast(fkLast.grade + '（' + fkLast.score + '/100）：' + (fkLast.reason || ''), 6000); } catch (e) { }
          }
          setTimeout(fkResetBtns, 5000);
        }
      });
    }
    fkBtnAll.onclick = function () {
      if (fkBusy) { window.mine.fakeScanCancel(); return; }
      window.annieConfirmFakeScan(function () {
        var lib = (typeof state !== 'undefined') ? state.library : null;
        if (!lib || !lib.tracks.length) return;
        fkRun(lib.tracks.map(function (t) { return t.path; }), fkBtnAll);
      });
    };
    fkBtnDir.onclick = function () {
      if (fkBusy) { window.mine.fakeScanCancel(); return; }
      window.annieConfirmFakeScan(function () {
        window.mine.fakeScanPickFolder().then(function (r) {
          if (!r || !r.ok) return;
          fkRun(r.paths, fkBtnDir);
        }).catch(function () { });
      });
    };
    fkBtnOne.onclick = function () {
      if (fkBusy) { window.mine.fakeScanCancel(); return; }
      window.annieConfirmFakeScan(function () {
        window.mine.fakeScanPickFile().then(function (r) {
          if (!r || !r.ok) return;
          fkRun(r.paths, fkBtnOne, 'one');
        }).catch(function () { });
      });
    };
    fkWrap.appendChild(fkBtnAll); fkWrap.appendChild(fkBtnDir); fkWrap.appendChild(fkBtnOne);
    fkRow.appendChild(fkLab); fkRow.appendChild(fkWrap);
    sFk.appendChild(fkRow);
    var fkExpRow = markItem(el('div', 'set-row'), '导出检测报告 csv html 频谱');
    var fkExpLab = el('div'); fkExpLab.appendChild(el('div', '', '导出检测报告'));
    fkExpLab.appendChild(el('div', 'set-hint', 'CSV（路径/得分/判定）或 HTML（含频谱剖面图）'));
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

    // —— V4.4.2：媒体库体检（Slice A：H1-H9；只出报告，修复逐项确认 + 一键撤销）——
    var hcRow = markItem(el('div', 'set-row'), '媒体库体检 健康检查 health 失效曲目 死链 歌单 收藏 孤儿缓存 不可达文件夹 零字节 缺标签');
    var hcLab = el('div');
    hcLab.appendChild(el('div', '', '媒体库体检'));
    hcLab.appendChild(el('div', 'set-hint', '一键排查失效曲目、歌单/收藏死链、孤儿缓存、不可达文件夹、零字节与缺标签文件；只出报告，所有修复都需你逐项确认，且可一键撤销'));
    var hcBtn = el('button', 'btn-ghost', '开始体检');
    var hcRight = el('div', 'set-ctrl');
    // Slice D：深度体检开关（H10 缺封面 / H11 不可解码 / H12 封面缓存；逐首 ffprobe/ffmpeg 探测，较慢）
    var hcDeepLab = el('label', 'set-hc-item');
    hcDeepLab.style.padding = '0 8px 0 0';
    var hcDeepCb = document.createElement('input');
    hcDeepCb.type = 'checkbox';
    try { hcDeepCb.checked = localStorage.getItem('annieplayer.health.deep') === '1'; } catch (e) { }
    hcDeepCb.onchange = function () { try { localStorage.setItem('annieplayer.health.deep', hcDeepCb.checked ? '1' : '0'); } catch (e) { } };
    hcDeepLab.appendChild(hcDeepCb);
    hcDeepLab.appendChild(el('span', 'set-hc-name', '深度体检'));
    hcDeepLab.title = '额外逐首探测：缺封面 / 不可解码坏文件 / 封面缓存占用（ffmpeg 逐首解码前 5 秒，较慢，可随时取消）';
    hcRight.appendChild(hcDeepLab);
    hcRight.appendChild(hcBtn);
    hcRow.appendChild(hcLab); hcRow.appendChild(hcRight);
    sFk.appendChild(hcRow);
    var hcUndoBox = el('div');
    var hcReportBox = el('div');
    sFk.appendChild(hcUndoBox);
    sFk.appendChild(hcReportBox);

    var hcBusy = false, hcOff = null, hcLastManifest = null;

    function hcToast(msg, ms) { try { if (typeof proToast === 'function') proToast(msg, ms || 5000); } catch (e) { } }
    function hcFmtTime(t) { try { return new Date(t).toLocaleString(); } catch (e) { return t || ''; } }

    function hcRefreshUndoBar() {
      hcUndoBox.innerHTML = '';
      if (!window.mine.healthUndoInfo) return;
      window.mine.healthUndoInfo().then(function (info) {
        if (!info) return;
        var bar = el('div', 'set-hc-undobar');
        var names = { pruneRefs: '死链清理', pruneOrphans: '孤儿缓存清理', removeFolders: '文件夹移除' };
        var labels = (info.actions || []).map(function (a) { return names[a] || a; }).join('、');
        bar.appendChild(el('span', 'set-hc-dim', '↩ 可撤销：' + hcFmtTime(info.time) + '（' + labels + '）'));
        var undoBtn = el('button', 'btn-ghost', '撤销上次清理');
        undoBtn.onclick = function () {
          if (!confirm('确定撤销上次体检清理？被移除的歌单/收藏引用、缓存键和文件夹索引将恢复。')) return;
          undoBtn.disabled = true;
          window.mine.healthUndo().then(function (r) {
            undoBtn.disabled = false;
            if (r && r.ok) {
              hcToast('已撤销清理，恢复 ' + r.restored + ' 项');
              hcReportBox.innerHTML = '';
              hcReportBox.appendChild(el('div', 'set-hc-desc', '撤销完成，建议重新体检确认。'));
              var again = el('button', 'btn-ghost', '重新体检');
              again.onclick = hcStart;
              hcReportBox.appendChild(again);
              hcRefreshUndoBar();
            } else { hcToast('没有可撤销的清理快照'); }
          }).catch(function () { undoBtn.disabled = false; hcToast('撤销失败'); });
        };
        bar.appendChild(undoBtn);
        hcUndoBox.appendChild(bar);
      }).catch(function () { });
    }
    hcRefreshUndoBar();

    // 卡片 / 明细行构造
    function hcCard(title, count, badgeCls, desc) {
      var card = el('div', 'set-hc-card');
      var head = el('div', 'set-hc-head');
      head.appendChild(el('span', 'set-hc-title', title));
      if (count != null) head.appendChild(el('span', 'set-hc-badge ' + (badgeCls || ''), String(count)));
      card.appendChild(head);
      if (desc) card.appendChild(el('div', 'set-hc-desc', desc));
      return card;
    }
    function hcCheckLine(name, dir, data, tagText) {
      var lab = el('label', 'set-hc-item');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true; cb.dataset.hc = JSON.stringify(data);
      lab.appendChild(cb);
      if (tagText) lab.appendChild(el('span', 'set-hc-tag', tagText));
      lab.appendChild(el('span', 'set-hc-name', name));
      if (dir) lab.appendChild(el('span', 'set-hc-dir', dir));
      return lab;
    }
    function hcPlainLine(name, dir, tagText, tagCls) {
      var lab = el('div', 'set-hc-item plain');
      if (tagText) lab.appendChild(el('span', 'set-hc-tag ' + (tagCls || ''), tagText));
      lab.appendChild(el('span', 'set-hc-name', name));
      if (dir) lab.appendChild(el('span', 'set-hc-dir', dir));
      return lab;
    }
    function hcCheckedData(card) {
      var out = [];
      card.querySelectorAll('.set-hc-items input[type=checkbox]:checked').forEach(function (cb) {
        try { out.push(JSON.parse(cb.dataset.hc || '{}')); } catch (e) { }
      });
      return out;
    }
    function hcTruncNote(cat, box) {
      if (cat.truncated) box.appendChild(el('div', 'set-hc-sub', '仅显示前 500 条，完整明细可用报告区的「导出完整清单」保存'));
    }
    // 修复完成后：提示 + 降级清单导出 + 重新体检
    function hcAfterFix(r, okMsg) {
      if (!r || !r.ok) { hcToast('修复失败：' + ((r && r.reason) || '未知错误')); return; }
      var skipped = (r.skipped || []).length;
      var msg = okMsg + (skipped ? '；' + skipped + ' 项复检时已存在被跳过' : '');
      hcToast(msg + (r.undoAvailable ? '（可撤销）' : ''), 6000);
      hcReportBox.innerHTML = '';
      hcReportBox.appendChild(el('div', 'set-hc-desc', msg + '。建议重新体检确认。'));
      if (r.snapshotTooLarge && r.manifest) {
        hcLastManifest = r.manifest;
        var saveListBtn = el('button', 'btn-ghost', '本次清理清单过大无法一键撤销，导出 JSON 清单存档…');
        saveListBtn.onclick = function () {
          window.mine.healthSaveJson('annie-health-manifest-' + new Date().toISOString().slice(0, 10) + '.json', hcLastManifest)
            .then(function (x) { if (x && x.ok) hcToast('清单已导出'); }).catch(function () { });
        };
        hcReportBox.appendChild(saveListBtn);
      }
      var again = el('button', 'btn-ghost', '重新体检');
      again.onclick = hcStart;
      hcReportBox.appendChild(again);
      hcRefreshUndoBar();
    }

    function hcRenderReport(report) {
      hcReportBox.innerHTML = '';
      var c = report.cats;
      var t = report.totals;
      var summary = el('div', 'set-hc-summary',
        '体检完成：曲目 ' + t.tracks + ' 首 · 自建歌单 ' + t.playlists + ' · 收藏 ' + t.favorites +
        ' · 校验文件 ' + t.filesStated + ' 个 · 耗时 ' + (report.durationMs / 1000).toFixed(1) + ' 秒');
      hcReportBox.appendChild(summary);
      var toolBar = el('div', 'set-hc-actions');
      var expBtn = el('button', 'btn-ghost', '导出完整清单（JSON）');
      expBtn.onclick = function () {
        expBtn.disabled = true;
        window.mine.healthExportReport().then(function (r) {
          if (r && r.ok) hcToast('体检报告已导出');
          else if (r && r.reason !== 'canceled') hcToast('导出失败：' + r.reason);
          expBtn.disabled = false;
        }).catch(function () { expBtn.disabled = false; });
      };
      toolBar.appendChild(expBtn);
      hcReportBox.appendChild(toolBar);

      var allClean = c.h1DeadTracks.count === 0 && c.h2PlaylistRefs.count === 0 && c.h3Favorites.count === 0 &&
        c.h4Orphans.count === 0 && c.h5Folders.count === 0 && c.h6ZeroByte.count === 0 && c.h7MissingTags.count === 0;
      if (allClean) hcReportBox.appendChild(el('div', 'set-hc-okline', '未发现失效文件与异常引用 ✓'));

      // H1 失效曲目（修复=重新扫描）
      var h1 = c.h1DeadTracks;
      var card1 = hcCard('H1 · 曲目文件不存在', h1.count, h1.count ? 'bad' : 'ok',
        '曲库索引指向的文件已不在磁盘（删除、移动或改名后残留）。重新扫描即可重建索引清除；歌单/收藏中的死链请用下方 H2/H3 分类清理。');
      if (h1.count) {
        var box1 = el('div', 'set-hc-items');
        h1.items.forEach(function (it) { box1.appendChild(hcPlainLine(it.name, it.dir, it.detail || '文件不存在', 'bad')); });
        hcTruncNote(h1, box1);
        card1.appendChild(box1);
        var rescanBtn = el('button', 'btn-ghost', '重新扫描曲库');
        rescanBtn.onclick = function () {
          if (!confirm('重新扫描将按当前媒体库文件夹重建曲目索引，确定开始？')) return;
          window.mine.rescan();
          hcToast('已开始重新扫描，扫描完成后可重新体检');
        };
        var act1 = el('div', 'set-hc-actions'); act1.appendChild(rescanBtn); card1.appendChild(act1);
      }
      hcReportBox.appendChild(card1);

      // H2 歌单死引用
      var h2 = c.h2PlaylistRefs;
      var card2 = hcCard('H2 · 歌单死引用', h2.count, h2.count ? 'warn' : 'ok',
        '自建歌单中指向的文件已不在磁盘，勾选后只从对应歌单移除引用，不删除任何文件。');
      if (h2.count) {
        var box2 = el('div', 'set-hc-items');
        h2.items.forEach(function (it) {
          box2.appendChild(hcCheckLine('[' + it.plName + '] ' + it.name, it.dir, { plId: it.plId, path: it.path }, '歌单'));
        });
        hcTruncNote(h2, box2);
        card2.appendChild(box2);
        var fix2Btn = el('button', 'btn-ghost', '从歌单移除选中项');
        fix2Btn.onclick = function () {
          var items = hcCheckedData(card2);
          if (!items.length) return;
          if (!confirm('从自建歌单中移除选中的 ' + items.length + ' 条死引用？\n（不删除磁盘文件，可撤销）')) return;
          fix2Btn.disabled = true;
          window.mine.healthFix({ action: 'pruneRefs', playlistItems: items }).then(function (r) {
            fix2Btn.disabled = false;
            hcAfterFix(r, '已从歌单移除 ' + ((r && r.removed && r.removed.playlist) || 0) + ' 条死引用');
          }).catch(function () { fix2Btn.disabled = false; });
        };
        var act2 = el('div', 'set-hc-actions'); act2.appendChild(fix2Btn); card2.appendChild(act2);
      }
      hcReportBox.appendChild(card2);

      // H3 收藏死引用
      var h3 = c.h3Favorites;
      var card3 = hcCard('H3 · 收藏死引用', h3.count, h3.count ? 'warn' : 'ok',
        '收藏列表中指向的文件已不在磁盘，勾选后从收藏移除，不删除任何文件。');
      if (h3.count) {
        var box3 = el('div', 'set-hc-items');
        h3.items.forEach(function (it) { box3.appendChild(hcCheckLine(it.name, it.dir, { path: it.path })); });
        hcTruncNote(h3, box3);
        card3.appendChild(box3);
        var fix3Btn = el('button', 'btn-ghost', '从收藏移除选中项');
        fix3Btn.onclick = function () {
          var items = hcCheckedData(card3);
          if (!items.length) return;
          if (!confirm('从收藏中移除选中的 ' + items.length + ' 条死引用？\n（不删除磁盘文件，可撤销）')) return;
          fix3Btn.disabled = true;
          window.mine.healthFix({ action: 'pruneRefs', favoriteItems: items }).then(function (r) {
            fix3Btn.disabled = false;
            hcAfterFix(r, '已从收藏移除 ' + ((r && r.removed && r.removed.favorite) || 0) + ' 条死引用');
          }).catch(function () { fix3Btn.disabled = false; });
        };
        var act3 = el('div', 'set-hc-actions'); act3.appendChild(fix3Btn); card3.appendChild(act3);
      }
      hcReportBox.appendChild(card3);

      // H4 孤儿缓存（收听统计 / 标签缓存 两组）
      var h4 = c.h4Orphans;
      var card4 = hcCard('H4 · 统计 / 标签缓存孤儿', h4.count, h4.count ? 'warn' : 'ok',
        '这些缓存键指向的曲目已不在曲库索引中（重新扫描不会自动清除），清理后可给 library.json 瘦身。');
      if (h4.count) {
        var box4 = el('div', 'set-hc-items');
        var statsItems = h4.items.filter(function (x) { return x.kind === 'stats'; });
        var metaItems = h4.items.filter(function (x) { return x.kind === 'meta'; });
        var streamItems = h4.items.filter(function (x) { return x.kind === 'stream'; });
        if (h4.statsCount) box4.appendChild(el('div', 'set-hc-sub', '收听统计孤儿（共 ' + h4.statsCount + ' 项）'));
        statsItems.forEach(function (it) { box4.appendChild(hcCheckLine(it.name, it.dir, { kind: 'stats', key: it.key }, '统计')); });
        if (h4.metaCount) box4.appendChild(el('div', 'set-hc-sub', '标签 / 分析缓存孤儿（共 ' + h4.metaCount + ' 项）'));
        metaItems.forEach(function (it) { box4.appendChild(hcCheckLine(it.name, it.dir, { kind: 'meta', key: it.key }, '缓存')); });
        if (h4.streamCount) box4.appendChild(el('div', 'set-hc-sub', '流媒体播放统计（共 ' + h4.streamCount + ' 项）——在线播放的临时链接记录，可安全清理'));
        streamItems.forEach(function (it) { box4.appendChild(hcCheckLine(it.name, it.dir, { kind: 'stream', key: it.key }, '流媒体')); });
        hcTruncNote(h4, box4);
        card4.appendChild(box4);
        var fix4Btn = el('button', 'btn-ghost', '清理选中孤儿键');
        fix4Btn.onclick = function () {
          var items = hcCheckedData(card4);
          if (!items.length) return;
          if (!confirm('清理选中的 ' + items.length + ' 个孤儿缓存键？\n（相关收听统计与分析结果会从本机删除，可撤销）')) return;
          fix4Btn.disabled = true;
          window.mine.healthFix({ action: 'pruneOrphans', items: items }).then(function (r) {
            fix4Btn.disabled = false;
            var rm = (r && r.removed) || {};
            hcAfterFix(r, '已清理孤儿缓存（统计 ' + (rm.stats || 0) + ' / 标签 ' + (rm.meta || 0) + '）');
          }).catch(function () { fix4Btn.disabled = false; });
        };
        var act4 = el('div', 'set-hc-actions'); act4.appendChild(fix4Btn); card4.appendChild(act4);
      }
      hcReportBox.appendChild(card4);

      // H5 不可达文件夹（offline 不可修仅提示 / missing 可移除）
      var h5 = c.h5Folders;
      var card5 = hcCard('H5 · 媒体库文件夹不可达', h5.count, h5.count ? 'warn' : 'ok',
        '移动盘未插 / 网络盘断开时建议保留（重新连接即可恢复）；目录已删除的文件夹可移出媒体库。');
      if (h5.count) {
        var box5 = el('div', 'set-hc-items');
        h5.items.forEach(function (it) {
          if (it.kind === 'offline') box5.appendChild(hcPlainLine(it.path, '', '盘未插/网络盘断开', 'warn'));
          else box5.appendChild(hcCheckLine(it.path, '', { path: it.path }, '目录已删除'));
        });
        hcTruncNote(h5, box5);
        card5.appendChild(box5);
        var missingShown = h5.items.filter(function (x) { return x.kind === 'missing'; });
        if (missingShown.length || h5.missingCount) {
          var fix5Btn = el('button', 'btn-ghost', '移除选中的已删除文件夹');
          fix5Btn.onclick = function () {
            var items = hcCheckedData(card5);
            if (!items.length) return;
            if (!confirm('从媒体库移除选中的 ' + items.length + ' 个文件夹？\n其下曲目会一并移出曲库索引（不删除磁盘文件，可撤销）')) return;
            fix5Btn.disabled = true;
            window.mine.healthFix({ action: 'removeFolders', items: items }).then(function (r) {
              fix5Btn.disabled = false;
              var rm = (r && r.removed) || {};
              hcAfterFix(r, '已移除文件夹 ' + (rm.folder || 0) + ' 个、曲目索引 ' + (rm.tracks || 0) + ' 首');
            }).catch(function () { fix5Btn.disabled = false; });
          };
          var act5 = el('div', 'set-hc-actions'); act5.appendChild(fix5Btn); card5.appendChild(act5);
        }
      }
      hcReportBox.appendChild(card5);

      // H6 零字节文件（走系统回收站，不经撤销快照）
      var h6 = c.h6ZeroByte;
      var card6 = hcCard('H6 · 零字节文件', h6.count, h6.count ? 'bad' : 'ok',
        '文件存在但大小为 0，通常是下载/拷贝失败的坏文件。删除走系统回收站，可从回收站恢复。');
      if (h6.count) {
        var box6 = el('div', 'set-hc-items');
        h6.items.forEach(function (it) { box6.appendChild(hcCheckLine(it.name, it.dir, { path: it.path })); });
        hcTruncNote(h6, box6);
        card6.appendChild(box6);
        var fix6Btn = el('button', 'btn-ghost', '删除选中（移入回收站）');
        fix6Btn.onclick = function () {
          var items = hcCheckedData(card6);
          var paths = items.map(function (x) { return x.path; });
          if (!paths.length) return;
          if (!confirm('将 ' + paths.length + ' 个零字节文件移入回收站？\n（可从系统回收站恢复，歌单/收藏引用会同步清理）')) return;
          fix6Btn.disabled = true;
          window.mine.libDeleteFiles(paths).then(function (r) {
            fix6Btn.disabled = false;
            var done = (r.done || []).length, failed = (r.failed || []).length;
            hcToast('已移入回收站 ' + done + ' 个文件' + (failed ? '，失败 ' + failed + ' 个' : ''), 6000);
            hcReportBox.innerHTML = '';
            hcReportBox.appendChild(el('div', 'set-hc-desc', '零字节文件已处理，建议重新体检确认。'));
            var again6 = el('button', 'btn-ghost', '重新体检');
            again6.onclick = hcStart;
            hcReportBox.appendChild(again6);
          }).catch(function () { fix6Btn.disabled = false; });
        };
        var act6 = el('div', 'set-hc-actions'); act6.appendChild(fix6Btn); card6.appendChild(act6);
      }
      hcReportBox.appendChild(card6);

      // H7 缺标签（仅报告，不自动改）
      var h7 = c.h7MissingTags;
      var card7 = hcCard('H7 · 缺基础标签', h7.count, h7.count ? 'warn' : 'ok',
        '标签缓存中标题与艺人均为空的文件。可在曲目行右键使用「标签编辑」或「在线匹配」补全，体检不会自动修改文件。');
      if (h7.count) {
        var box7 = el('div', 'set-hc-items');
        h7.items.forEach(function (it) { box7.appendChild(hcPlainLine(it.name, it.dir, '标题/艺人空', 'warn')); });
        hcTruncNote(h7, box7);
        card7.appendChild(box7);
      }
      hcReportBox.appendChild(card7);

      // H8 重复歌曲（跳现有重复清理区）
      var h8 = c.h8Duplicates || { groups: 0, removable: 0 };
      var card8 = hcCard('H8 · 重复歌曲', h8.groups, h8.groups ? 'warn' : 'ok',
        h8.groups ? ('按"标题+艺人"检出 ' + h8.groups + ' 组重复，理论可清理 ' + h8.removable + ' 个冗余副本。') :
          '未发现标题+艺人重复的歌曲。');
      if (h8.groups) {
        var go8Btn = el('button', 'btn-ghost', '前往重复歌曲清理');
        go8Btn.onclick = function () {
          try { dupRow.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
          if (!dupBox.children.length) dupBtn.click();
        };
        var act8 = el('div', 'set-hc-actions'); act8.appendChild(go8Btn); card8.appendChild(act8);
      }
      hcReportBox.appendChild(card8);

      // H9 响度 / BPM 未分析（触发现有补算）
      var h9 = c.h9Analysis || { loudnessMissing: 0, bpmMissing: 0 };
      var card9 = hcCard('H9 · 响度 / BPM 分析覆盖', null, '',
        '响度补算用于音量均衡，BPM 用于「找相似歌曲」。未分析数量多时点下方按钮直接补算（耗时较长，可取消）。');
      var box9 = el('div', 'set-hc-items');
      box9.appendChild(hcPlainLine('响度未分析 ' + h9.loudnessMissing + ' 首', '', '响度', h9.loudnessMissing ? 'warn' : 'ok'));
      box9.appendChild(hcPlainLine('BPM 未分析 ' + h9.bpmMissing + ' 首', '', 'BPM', h9.bpmMissing ? 'warn' : 'ok'));
      card9.appendChild(box9);
      var act9 = el('div', 'set-hc-actions');
      var go9L = el('button', 'btn-ghost', '补算响度');
      go9L.onclick = function () {
        try { loudBtnRow.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
        loudBtn.click();
      };
      var go9B = el('button', 'btn-ghost', '补算 BPM');
      go9B.onclick = function () {
        try { bpmBtnRow.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { }
        bpmBtn.click();
      };
      act9.appendChild(go9L); act9.appendChild(go9B); card9.appendChild(act9);
      hcReportBox.appendChild(card9);

      // —— Slice D：深度项卡片（勾选「深度体检」才出现在报告里） ——
      if (report.deep) {
        // H10 缺封面（仅报告，引导在线匹配，不自动改文件）
        var h10 = c.h10NoCover;
        var card10 = hcCard('H10 · 缺封面', h10.count, h10.count ? 'warn' : 'ok',
          '文件既无内嵌封面、所在目录也没有封面图（cover/folder/front 等）。可用曲目右键「在线匹配」补封面，体检不会自动修改文件。');
        if (h10.count) {
          var box10 = el('div', 'set-hc-items');
          h10.items.forEach(function (it) { box10.appendChild(hcPlainLine(it.name, it.dir, '缺封面', 'warn')); });
          hcTruncNote(h10, box10);
          card10.appendChild(box10);
        }
        hcReportBox.appendChild(card10);

        // H11 不可解码 / 损坏（仅报告列出，不自动删）
        var h11 = c.h11Undecodable;
        var card11 = hcCard('H11 · 不可解码 / 损坏文件', h11.count, h11.count ? 'bad' : 'ok',
          'ffmpeg 解码前 5 秒即报错或失败的文件（下载不完整/文件损坏）。建议重新获取源文件；可在下方勾选后移入回收站。');
        if (h11.count) {
          var box11 = el('div', 'set-hc-items');
          h11.items.forEach(function (it) { box11.appendChild(hcCheckLine(it.name, it.dir, { path: it.path }, '损坏')); });
          hcTruncNote(h11, box11);
          card11.appendChild(box11);
          var fix11Btn = el('button', 'btn-ghost', '删除选中（移入回收站）');
          fix11Btn.onclick = function () {
            var items = hcCheckedData(card11);
            var paths = items.map(function (x) { return x.path; });
            if (!paths.length) return;
            if (!confirm('将 ' + paths.length + ' 个损坏文件移入回收站？\n（可从系统回收站恢复，歌单/收藏引用会同步清理）')) return;
            fix11Btn.disabled = true;
            window.mine.libDeleteFiles(paths).then(function (r) {
              fix11Btn.disabled = false;
              var done = (r.done || []).length, failed = (r.failed || []).length;
              hcToast('已移入回收站 ' + done + ' 个文件' + (failed ? '，失败 ' + failed + ' 个' : ''), 6000);
            }).catch(function () { fix11Btn.disabled = false; });
          };
          var act11 = el('div', 'set-hc-actions'); act11.appendChild(fix11Btn); card11.appendChild(act11);
        }
        hcReportBox.appendChild(card11);

        // H12 封面缓存占用（一键清空，纯缓存安全）
        var h12 = c.h12CoverCache || { count: 0, bytes: 0 };
        var card12 = hcCard('H12 · 封面缓存占用', null, h12.count ? '' : 'ok',
          '封面磁盘缓存只进不出（mtime 变了自动换新版）。清空不影响数据，下次浏览时自动重建。');
        var box12 = el('div', 'set-hc-items');
        box12.appendChild(hcPlainLine('缓存 ' + h12.count + ' 个文件 · 占用 ' + bkFmtBytes(h12.bytes), '', h12.count ? '缓存' : '空', h12.count ? '' : 'ok'));
        card12.appendChild(box12);
        if (h12.count) {
          var clrBtn = el('button', 'btn-ghost', '清空封面缓存');
          clrBtn.onclick = function () {
            if (!confirm('清空封面磁盘缓存（' + h12.count + ' 个文件，' + bkFmtBytes(h12.bytes) + '）？\n纯缓存数据，删除后自动重建，不影响曲库。')) return;
            clrBtn.disabled = true;
            window.mine.healthClearCoverCache().then(function (r) {
              clrBtn.disabled = false;
              if (r && r.ok) {
                hcToast('已清空封面缓存（' + r.count + ' 个文件，' + bkFmtBytes(r.bytes) + '）');
                box12.innerHTML = '';
                box12.appendChild(hcPlainLine('缓存 0 个文件 · 占用 0 B', '', '空', 'ok'));
                card12.querySelector('.set-hc-actions').remove();
              }
            }).catch(function () { clrBtn.disabled = false; });
          };
          var act12 = el('div', 'set-hc-actions'); act12.appendChild(clrBtn); card12.appendChild(act12);
        }
        hcReportBox.appendChild(card12);
      }

      hcRefreshUndoBar();
    }

    function hcStart() {
      if (hcBusy) return;
      hcBusy = true;
      hcBtn.textContent = '取消体检';
      hcReportBox.innerHTML = '';
      var progWrap = el('div', 'set-hc-progress');
      var bar = document.createElement('progress');
      bar.value = 0; bar.max = 1;
      var plab = el('span', '', '准备中…');
      progWrap.appendChild(bar); progWrap.appendChild(plab);
      hcReportBox.appendChild(progWrap);
      if (hcOff) { try { hcOff(); } catch (e) { } hcOff = null; }
      hcOff = window.mine.onHealthEvent(function (ev) {
        if (ev.type === 'start') { bar.max = ev.total || 1; plab.textContent = '校验文件 0/' + ev.total; }
        else if (ev.type === 'progress') {
          bar.value = ev.total ? (ev.done / ev.total) : 0;
          plab.textContent = (ev.phase === 'folders' ? '检查文件夹 '
            : ev.phase === 'deep' ? '深度探测（ffmpeg 逐首解码）'
            : '校验文件 ') + ev.done + '/' + ev.total;
        } else if (ev.type === 'end') {
          if (hcOff) { try { hcOff(); } catch (e) { } hcOff = null; }
          hcBusy = false; hcBtn.textContent = '开始体检';
          if (ev.canceled) { hcReportBox.innerHTML = ''; hcReportBox.appendChild(el('div', 'set-hc-desc', '体检已取消')); return; }
          if (ev.error) { hcReportBox.innerHTML = ''; hcReportBox.appendChild(el('div', 'set-hc-desc', '体检出错：' + ev.error)); return; }
          hcRenderReport(ev.report);
        }
      });
      window.mine.healthScan({ deep: hcDeepCb.checked }).catch(function () {
        hcBusy = false; hcBtn.textContent = '开始体检';
        hcReportBox.innerHTML = '';
        hcReportBox.appendChild(el('div', 'set-hc-desc', '体检启动失败'));
      });
    }
    hcBtn.onclick = function () {
      if (hcBusy) { window.mine.healthCancel(); return; }
      hcStart();
    };

    // —— 备份与迁移 2.0（V4.3.19 初版；V4.4.2 Slice B：分内容导出 + 导入向导「摘要 → 模式与内容」）——
    var bakRow = markItem(el('div', 'set-row'), '配置备份 曲库备份 导出备份 导入备份 换机 迁移 backup 合并');
    var bakLab = el('div'); bakLab.appendChild(el('div', '', '曲库备份与迁移'));
    bakLab.appendChild(el('div', 'set-hint', '设置/歌单/收藏/收听统计/分析数据可按需勾选导出；导入先看摘要再选覆盖或合并，全程可回退（自动留 .bak）'));
    var bakWrap = el('div', 'set-ctrl');
    var bakExpBtn = el('button', 'btn-ghost', '导出备份…');
    var bakImpBtn = el('button', 'btn-ghost', '导入备份…');
    bakWrap.appendChild(bakExpBtn); bakWrap.appendChild(bakImpBtn);
    bakRow.appendChild(bakLab); bakRow.appendChild(bakWrap);
    sFk.appendChild(bakRow);
    var bakExpPanel = el('div', 'set-hc-card hidden');
    var bakImpPanel = el('div', 'set-hc-card hidden');
    sFk.appendChild(bakExpPanel);
    sFk.appendChild(bakImpPanel);

    var BK_SECTIONS = [
      ['settings', '设置', '界面偏好 / 音频输出 / 快捷键等全部设置键'],
      ['folders', '媒体库文件夹', '媒体库文件夹列表（不含曲目索引，导入后重扫重建）'],
      ['playlists', '自建歌单', '本地歌单及曲目路径引用'],
      ['streamPlaylists', '在线歌单', '流媒体歌单（含曲目快照，跨机直接可用）'],
      ['favorites', '收藏', '收藏的歌曲路径列表'],
      ['stats', '收听统计', '每首播放次数/时长 + 听歌报告（本机统计数据）'],
      ['analysis', '分析数据', '响度 / BPM / 标签摘要等，换机可免重算（体积较大，默认不勾）']
    ];
    function bkFmtBytes(n) {
      n = Number(n) || 0;
      if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
      if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
      return n + ' B';
    }
    function bkGetListenStats() {
      try { return JSON.parse(localStorage.getItem('annieplayer.listenstats.v1') || 'null'); } catch (e) { return null; }
    }

    /* ---- 导出面板：勾选内容（显示各项条数与预估大小） ---- */
    function bkOpenExport() {
      bakImpPanel.classList.add('hidden');
      bakExpPanel.classList.remove('hidden');
      bakExpPanel.innerHTML = '';
      bakExpPanel.appendChild(el('div', 'set-hc-title', '选择要导出的内容'));
      var listBox = el('div', 'set-hc-items');
      listBox.style.maxHeight = 'none';
      bakExpPanel.appendChild(listBox);
      var statusLine = el('div', 'set-hc-desc', '正在统计各项大小…');
      bakExpPanel.appendChild(statusLine);
      var actRow = el('div', 'set-hc-actions');
      var doBtn = el('button', 'btn-ghost', '导出');
      var cancelBtn = el('button', 'btn-ghost', '取消');
      actRow.appendChild(doBtn); actRow.appendChild(cancelBtn);
      bakExpPanel.appendChild(actRow);
      cancelBtn.onclick = function () { bakExpPanel.classList.add('hidden'); };
      var cbs = {};
      BK_SECTIONS.forEach(function (s) {
        var lab = el('label', 'set-hc-item');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = s[0] !== 'analysis'; // 决策：分析数据默认不勾，保持备份几十 KB
        cbs[s[0]] = cb;
        lab.appendChild(cb);
        lab.appendChild(el('span', 'set-hc-name', s[1]));
        var meta = el('span', 'set-hc-dir', s[2]);
        meta.dataset.role = 'meta';
        lab.appendChild(meta);
        listBox.appendChild(lab);
      });
      doBtn.onclick = function () {
        var sections = BK_SECTIONS.filter(function (s) { return cbs[s[0]].checked; }).map(function (s) { return s[0]; });
        if (!sections.length) { statusLine.textContent = '请至少勾选一项内容'; return; }
        doBtn.disabled = true; statusLine.textContent = '正在导出…';
        window.mine.backupExport({ sections: sections, listenStats: bkGetListenStats() }).then(function (r) {
          doBtn.disabled = false;
          if (r && r.ok) {
            statusLine.textContent = '已导出（' + bkFmtBytes(r.bytes) + '）：' + r.path;
            bakExpPanel.classList.add('hidden');
            try { if (typeof proToast === 'function') proToast('备份已导出'); } catch (e) { }
          }
          else statusLine.textContent = (r && r.reason === 'canceled') ? '已取消' : ('导出失败：' + ((r && r.reason) || '未知错误'));
        }).catch(function () { doBtn.disabled = false; statusLine.textContent = '导出失败'; });
      };
      window.mine.backupEstimate(bkGetListenStats()).then(function (est) {
        est = est || {};
        var totalSel = 0;
        BK_SECTIONS.forEach(function (s) {
          var e = est[s[0]];
          var meta = listBox.children[BK_SECTIONS.indexOf(s)].querySelector('[data-role=meta]');
          var cnt = e ? e.count : 0;
          var bytes = e ? e.bytes : 0;
          meta.textContent = s[2] + '　·　' + (s[0] === 'listenStats' ? '' : (cnt + ' 项 · ')) + bkFmtBytes(bytes);
          meta.dataset.bytes = bytes;
          if (cbs[s[0]].checked) totalSel += bytes;
        });
        var updTotal = function () {
          var t = 0;
          BK_SECTIONS.forEach(function (s) { if (cbs[s[0]].checked) t += Number(listBox.children[BK_SECTIONS.indexOf(s)].querySelector('[data-role=meta]').dataset.bytes) || 0; });
          statusLine.textContent = '预计备份大小约 ' + bkFmtBytes(t) + '（不含曲目文件本体与封面图）';
        };
        BK_SECTIONS.forEach(function (s) { cbs[s[0]].onchange = updTotal; });
        updTotal();
      }).catch(function () { statusLine.textContent = '（大小预估失败，不影响导出）'; });
    }
    bakExpBtn.onclick = function () {
      if (bakExpPanel.classList.contains('hidden')) bkOpenExport();
      else bakExpPanel.classList.add('hidden');
    };

    /* ---- 导入向导：第 1 步摘要 → 第 2 步路径重映射（Slice C）→ 第 3 步模式与内容 ---- */
    var bkImp = { summary: null, rootMap: {}, smartMatch: true };
    function bkImpClose() { bakImpPanel.classList.add('hidden'); bakImpPanel.innerHTML = ''; bkImp.summary = null; bkImp.rootMap = {}; bkImp.smartMatch = true; }
    // 第 1 步摘要渲染（初次与「上一步」返回共用）
    function bkRenderSummary(r, onNext) {
      bakImpPanel.innerHTML = '';
      bakImpPanel.appendChild(el('div', 'set-hc-title', '导入备份 · 第 1 步：文件摘要'));
      var c = r.counts || {};
      var lines = [
        '文件：' + r.path,
        '版本：' + (r.ver ? 'V' + r.ver : '未知') + '（备份格式 v' + r.schemaVersion + '）　导出时间：' + (r.time ? new Date(r.time).toLocaleString() : '未知') + '　大小：' + bkFmtBytes(r.fileBytes),
        '内容：设置 ' + (c.settings || 0) + ' 键 · 媒体库文件夹 ' + (c.folders || 0) + ' · 自建歌单 ' + (c.playlists || 0) +
          ' · 在线歌单 ' + (c.streamPlaylists || 0) + ' · 收藏 ' + (c.favorites || 0) + ' · 统计 ' + (c.stats || 0) +
          ' · 分析数据 ' + (c.analysis || 0) + (c.listenStats ? ' · 含听歌报告' : '')
      ];
      if (r.roots && r.roots.length) lines.push('备份中的媒体库根：' + r.roots.slice(0, 5).join('；') + (r.roots.length > 5 ? ' 等 ' + r.roots.length + ' 个' : ''));
      lines.forEach(function (t) { bakImpPanel.appendChild(el('div', 'set-hc-desc', t)); });
      if (r.schemaVersion < 2) bakImpPanel.appendChild(el('div', 'set-hc-desc', '（旧版备份文件：以兼容模式导入，不含分析数据）'));
      var act = el('div', 'set-hc-actions');
      var nextB = el('button', 'btn-ghost', '下一步');
      var cancelB = el('button', 'btn-ghost', '取消');
      nextB.onclick = onNext;
      cancelB.onclick = bkImpClose;
      act.appendChild(nextB); act.appendChild(cancelB);
      bakImpPanel.appendChild(act);
    }
    function bkImpStep1() {
      bakImpPanel.innerHTML = '';
      bakImpPanel.appendChild(el('div', 'set-hc-title', '导入备份 · 第 1 步：文件摘要'));
      bakImpPanel.appendChild(el('div', 'set-hc-desc', '正在读取备份文件…'));
      window.mine.backupPickInspect().then(function (r) {
        if (!r || !r.ok) {
          if (r && r.reason === 'canceled') { bkImpClose(); return; }
          bakImpPanel.innerHTML = '';
          bakImpPanel.appendChild(el('div', 'set-hc-title', '导入备份'));
          bakImpPanel.appendChild(el('div', 'set-hc-desc', '无法导入：' + ((r && r.reason) || '未知错误')));
          var closeB = el('button', 'btn-ghost', '关闭');
          closeB.onclick = bkImpClose;
          bakImpPanel.appendChild(closeB);
          return;
        }
        bkImp.summary = r;
        bkRenderSummary(r, bkImpStep2);
      }).catch(function () { bkImpClose(); });
    }
    /* 第 2 步：路径重映射（Slice C）——逐根显示本机可达性，不可达的选本机文件夹映射，实时预估匹配数 */
    function bkImpStep2() {
      var r = bkImp.summary;
      if (!r) return bkImpClose();
      bakImpPanel.innerHTML = '';
      bakImpPanel.appendChild(el('div', 'set-hc-title', '导入备份 · 第 2 步：路径重映射'));
      var rootBox = el('div', 'set-hc-items'); rootBox.style.maxHeight = 'none';
      var estLine = el('div', 'set-hc-desc', '正在检查备份中的路径…');
      var smartRow = el('label', 'set-hc-item');
      var smartCb = document.createElement('input');
      smartCb.type = 'checkbox'; smartCb.checked = bkImp.smartMatch !== false;
      smartCb.onchange = function () { bkImp.smartMatch = smartCb.checked; };
      smartRow.appendChild(smartCb);
      smartRow.appendChild(el('span', 'set-hc-name', '启用智能匹配兜底'));
      smartRow.appendChild(el('span', 'set-hc-dir', '重启后按 文件名/大小/时长/标签 再匹配一轮前缀没对上的'));
      var act = el('div', 'set-hc-actions');
      var backB = el('button', 'btn-ghost', '上一步');
      var nextB = el('button', 'btn-ghost', '下一步');
      var cancelB = el('button', 'btn-ghost', '取消');
      backB.onclick = function () { bkRenderSummary(bkImp.summary, bkImpStep2); };
      nextB.onclick = bkImpStep3;
      cancelB.onclick = bkImpClose;
      bakImpPanel.appendChild(rootBox);
      bakImpPanel.appendChild(estLine);
      bakImpPanel.appendChild(smartRow);
      act.appendChild(backB); act.appendChild(nextB); act.appendChild(cancelB);
      bakImpPanel.appendChild(act);
      function refresh() {
        window.mine.backupRootCheck({ path: r.path, rootMap: bkImp.rootMap }).then(function (rc) {
          if (!rc || !rc.ok) { estLine.textContent = '路径检查失败：' + ((rc && rc.reason) || '未知错误'); return; }
          rootBox.innerHTML = '';
          rc.roots.forEach(function (rt) {
            var row = el('div', 'set-hc-item plain');
            var okNow = rt.exists || rt.mappedExists;
            row.appendChild(el('span', 'set-hc-tag ' + (okNow ? 'ok' : 'bad'), rt.exists ? '本机存在' : (rt.mappedExists ? '已映射 ✓' : '本机不存在')));
            var nameEl = el('span', 'set-hc-name', rt.root);
            nameEl.style.direction = 'ltr';
            row.appendChild(nameEl);
            if (rt.mapped) row.appendChild(el('span', 'set-hc-dir', '→ ' + rt.mapped));
            rootBox.appendChild(row);
            if (!rt.exists) {
              var btnRow = el('div', 'set-hc-actions'); btnRow.style.margin = '0 0 4px 26px';
              var pickB = el('button', 'btn-ghost', rt.mapped ? '重新选择…' : '选择本机对应文件夹…');
              pickB.onclick = function () {
                pickB.disabled = true;
                window.mine.backupPickDir().then(function (dir) {
                  pickB.disabled = false;
                  if (!dir) return;
                  bkImp.rootMap[rt.root] = dir;
                  refresh();
                }).catch(function () { pickB.disabled = false; });
              };
              btnRow.appendChild(pickB);
              if (rt.mapped) {
                var clearB = el('button', 'btn-ghost', '清除映射');
                clearB.onclick = function () { delete bkImp.rootMap[rt.root]; refresh(); };
                btnRow.appendChild(clearB);
              }
              rootBox.appendChild(btnRow);
            }
          });
          estLine.textContent = rc.total
            ? ('预计匹配 ' + rc.matched + ' / ' + rc.total + ' 首（前缀直配' + (bkImp.smartMatch !== false ? '，其余重启后智能兜底' : '') + '）')
            : '备份中没有可校验的路径';
        }).catch(function () { estLine.textContent = '路径检查失败'; });
      }
      refresh();
    }
    function bkImpStep3() {
      var r = bkImp.summary;
      if (!r) return bkImpClose();
      bakImpPanel.innerHTML = '';
      bakImpPanel.appendChild(el('div', 'set-hc-title', '导入备份 · 第 3 步：模式与内容'));
      // 模式选择
      var modeBox = el('div', 'set-hc-items'); modeBox.style.maxHeight = 'none';
      var mode = 'overwrite';
      [['overwrite', '覆盖模式', '用备份内容替换本机对应数据（现有配置自动留 .bak 兜底，tracks 索引不动）'],
       ['merge', '合并模式', '歌单同名合并曲目并集、收藏/文件夹取并集、统计相加、设置只补缺省键']].forEach(function (m) {
        var lab = el('label', 'set-hc-item');
        var rb = document.createElement('input');
        rb.type = 'radio'; rb.name = 'bk-mode'; rb.checked = m[0] === 'overwrite';
        rb.onchange = function () { mode = m[0]; };
        lab.appendChild(rb);
        lab.appendChild(el('span', 'set-hc-name', m[1]));
        lab.appendChild(el('span', 'set-hc-dir', m[2]));
        modeBox.appendChild(lab);
      });
      bakImpPanel.appendChild(modeBox);
      // 内容勾选（只列出备份里实际存在的分区）
      bakImpPanel.appendChild(el('div', 'set-hc-sub', '导入内容'));
      var cntBox = el('div', 'set-hc-items'); cntBox.style.maxHeight = 'none';
      var c = r.counts || {};
      var cbs = {};
      BK_SECTIONS.forEach(function (s) {
        if (!c[s[0]]) return;
        var lab = el('label', 'set-hc-item');
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true;
        cbs[s[0]] = cb;
        lab.appendChild(cb);
        lab.appendChild(el('span', 'set-hc-name', s[1]));
        lab.appendChild(el('span', 'set-hc-dir', c[s[0]] + ' 项'));
        cntBox.appendChild(lab);
      });
      bakImpPanel.appendChild(cntBox);
      var statusLine = el('div', 'set-hc-desc', '');
      bakImpPanel.appendChild(statusLine);
      var act = el('div', 'set-hc-actions');
      var backB = el('button', 'btn-ghost', '上一步');
      var doB = el('button', 'btn-ghost', '导入并重启');
      var cancelB = el('button', 'btn-ghost', '取消');
      backB.onclick = bkImpStep2;
      cancelB.onclick = bkImpClose;
      doB.onclick = function () {
        var sections = Object.keys(cbs).filter(function (k) { return cbs[k].checked; });
        if (!sections.length) { statusLine.textContent = '请至少勾选一项内容'; return; }
        var nMap = Object.keys(bkImp.rootMap || {}).length;
        var tip = mode === 'overwrite'
          ? '覆盖模式：备份内容将替换本机的设置/歌单/收藏/统计（现有配置自动留 .bak 兜底），导入后应用自动重启。继续？'
          : '合并模式：备份内容将与本机数据合并（歌单同名合并、收藏取并集、统计相加），导入后应用自动重启。继续？';
        if (nMap) tip += '\n已配置 ' + nMap + ' 个路径映射，导入时会同步改写。';
        if (!confirm(tip)) return;
        doB.disabled = true; statusLine.textContent = '正在导入…';
        window.mine.backupApply({
          path: r.path, mode: mode, sections: sections,
          rootMap: bkImp.rootMap, smartMatch: bkImp.smartMatch !== false
        }).then(function (res) {
          if (!res || !res.ok) {
            doB.disabled = false;
            statusLine.textContent = '导入失败：' + ((res && res.reason) || '未知错误');
            return;
          }
          // 听歌报告（渲染层 localStorage）：覆盖模式直接写入；合并模式本机已有报告则保留本机
          if (res.listenStats) {
            try {
              var cur = localStorage.getItem('annieplayer.listenstats.v1');
              if (mode === 'overwrite' || !cur) localStorage.setItem('annieplayer.listenstats.v1', JSON.stringify(res.listenStats));
            } catch (e) { }
          }
          statusLine.textContent = '导入完成' +
            (res.remapped ? '，已按映射改写 ' + res.remapped + ' 条路径' : '') +
            (res.needsRescan ? '，重启后将自动重建曲库索引并做二次匹配' : '') + '，正在重启…';
          setTimeout(function () { window.mine.relaunchApp(); }, 800);
        }).catch(function () { doB.disabled = false; statusLine.textContent = '导入失败'; });
      };
      act.appendChild(backB); act.appendChild(doB); act.appendChild(cancelB);
      bakImpPanel.appendChild(act);
    }
    bakImpBtn.onclick = function () {
      if (!bakImpPanel.classList.contains('hidden')) { bkImpClose(); return; }
      bakExpPanel.classList.add('hidden');
      bakImpPanel.classList.remove('hidden');
      bkImpStep1();
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
      // V4.3.24 新维度：完整率/跳过率 + 常听曲风
      var judged = r.totalSkip + r.totalComplete + r.totalPartial;
      if (judged > 0) {
        L.push('完整听完 ' + (r.completeRate * 100).toFixed(1) + '% · 跳过 ' + (r.skipRate * 100).toFixed(1) + '%（完整 ' + r.totalComplete + ' / 跳过 ' + r.totalSkip + ' / 部分 ' + r.totalPartial + ' 次）');
      }
      if (r.genres.length) L.push('常听曲风：' + r.genres.slice(0, 3).map(function (g) { return g.name; }).join(' / '));
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
      // V4.3.24：完整率/跳过率一行（夹在数字卡片与 Top 歌曲之间）
      var lsrJudged = r.totalSkip + r.totalComplete + r.totalPartial;
      if (lsrJudged > 0) {
        ctx.fillStyle = '#8a90a3'; ctx.font = '13px ' + FONT;
        ctx.fillText('完整听完 ' + (r.completeRate * 100).toFixed(1) + '%  ·  跳过 ' + (r.skipRate * 100).toFixed(1) + '%', 48, 262);
      }
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
    /* —— 听歌统计（V4.3.24：原「听歌报告」弹窗升级为设置中心独立分页，
     * 复用上方 lsrFmtDur/lsrList/lsrText/lsrDrawCard；新增收听构成/曲风/年度维度。
     * 切到本页即刷新，停留期间每 4s 按数据签名差量重绘（无变化不重绘，保持滚动位置）。） —— */
    (function buildStatsPage() {
      var mount = el('div', 'set-stats');
      pgStats.appendChild(mount);
      var lastSig = '';

      // 水平条形行（曲风/年度用）：name + 轨道 + 值，fillWidth 0-100
      function barRow(name, ratio, valText, yearMod) {
        var row = el('div', 'set-stats-bar-row' + (yearMod ? ' is-year' : ''));
        row.appendChild(el('span', 'set-stats-bar-name', name));
        var track = el('span', 'set-stats-bar-track');
        var fill = el('i', 'set-stats-bar-fill');
        fill.style.width = Math.max(2, Math.round(ratio * 100)) + '%';
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el('span', 'set-stats-bar-val', valText));
        return row;
      }

      // 收听热力图（近 26 周，GitHub 风格，跟随强调色）
      function heatBlock(days) {
        var box = el('div', 'set-stats-box');
        var top = el('div', 'set-stats-heat-top');
        top.appendChild(el('span', 'set-hint', '颜色越深听得越久，悬停看当天分钟数'));
        var accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#fac900';
        var opac = [0, 0.25, 0.45, 0.7, 1];
        var lg = el('span', 'set-stats-lg');
        lg.appendChild(el('span', '', '少'));
        for (var li = 0; li < 5; li++) {
          var lc = el('i', 'set-stats-lg-c');
          if (li > 0) { lc.style.background = accent; lc.style.opacity = opac[li]; }
          lg.appendChild(lc);
        }
        lg.appendChild(el('span', '', '多'));
        top.appendChild(lg);
        box.appendChild(top);
        var grid = el('div', 'lsr-heat');
        var today = new Date(); today.setHours(0, 0, 0, 0);
        var start = new Date(today.getTime() - (25 * 7 + ((today.getDay() + 6) % 7)) * 86400000); // 对齐到周一
        var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
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
        box.appendChild(grid);
        return box;
      }

      function card(k, v, sub) {
        var c = el('div', 'set-stats-card');
        c.appendChild(el('div', 'set-stats-k', k));
        c.appendChild(el('div', 'set-stats-v', v));
        if (sub) c.appendChild(el('div', 'set-stats-sub', sub));
        return c;
      }

      function render() {
        var st = window.annieListenStats;
        if (!st) return;
        var r = st.report();
        // 数据签名：无变化跳过重绘（保留滚动位置/悬停态）
        var sig = [r.totalSec, r.totalPlays, r.totalSkip, r.totalComplete, r.totalPartial,
          r.genres.length, r.years.length, Object.keys(r.days).length].join('|');
        if (sig === lastSig && mount.childNodes.length) return;
        lastSig = sig;
        var scrollTop = contentEl ? contentEl.scrollTop : 0;
        mount.innerHTML = '';
        var judged = r.totalSkip + r.totalComplete + r.totalPartial;
        var pct = function (x) { return (x * 100).toFixed(1) + '%'; };

        // —— 总览：六张数字卡片 ——
        var sOv = section(mount, '总览');
        sOv.appendChild(el('div', 'set-stats-summary', r.totalPlays > 0
          ? '累计收听 ' + lsrFmtDur(r.totalSec) + ' · 共播放 ' + r.totalPlays + ' 次' + (r.favHour >= 0 ? ' · 最爱在 ' + r.favHour + ' 点听歌' : '')
          : '还没有统计数据——去播放几首歌吧！'));
        var cards = el('div', 'set-stats-cards');
        cards.appendChild(card('累计收听', lsrFmtDur(r.totalSec)));
        cards.appendChild(card('播放次数', String(r.totalPlays)));
        cards.appendChild(card('最爱时段', r.favHour >= 0 ? r.favHour + ' 点' : '—'));
        cards.appendChild(card('完整播放', r.totalComplete + ' 次', judged ? '占比 ' + pct(r.completeRate) : '暂无判定'));
        cards.appendChild(card('跳过', r.totalSkip + ' 次', judged ? '跳过率 ' + pct(r.skipRate) : '暂无判定'));
        cards.appendChild(card('部分收听', r.totalPartial + ' 次', judged ? '占比 ' + pct(judged ? r.totalPartial / judged : 0) : '暂无判定'));
        sOv.appendChild(cards);

        // —— 收听热力图（近半年） ——
        var sHeat = section(mount, '收听热力图（近半年）');
        sHeat.appendChild(heatBlock(r.days || {}));

        // —— 收听构成：完整/部分/跳过 堆叠条 + 图注 ——
        var sKind = section(mount, '收听构成');
        var kBox = el('div', 'set-stats-box');
        var stack = el('div', 'set-stats-stack');
        var segs = [
          ['完整听完', r.completeRate, r.totalComplete, 'var(--accent)'],
          ['部分收听', judged ? r.totalPartial / judged : 0, r.totalPartial, '#8a90a3'],
          ['跳过', r.skipRate, r.totalSkip, '#fa2d55']
        ];
        segs.forEach(function (g) {
          var seg = el('i', 'set-stats-seg');
          seg.style.width = (g[1] * 100) + '%';
          seg.style.background = g[3];
          seg.title = g[0] + ' ' + g[2] + ' 次 · ' + pct(g[1]);
          stack.appendChild(seg);
        });
        kBox.appendChild(stack);
        if (judged > 0) {
          var leg = el('div', 'set-stats-kind-leg');
          segs.forEach(function (g) {
            var item = el('span', 'set-stats-kind-item');
            var dot = el('i', 'set-stats-kind-dot'); dot.style.background = g[3];
            item.appendChild(dot);
            item.appendChild(document.createTextNode(g[0] + ' '));
            item.appendChild(el('b', '', g[2] + ' 次'));
            item.appendChild(document.createTextNode(' · ' + pct(g[1])));
            leg.appendChild(item);
          });
          kBox.appendChild(leg);
        } else {
          kBox.appendChild(el('div', 'lsr-empty', '播放几首歌并切歌后开始判定：听到 80% 或末尾算完整，不足 1/3 算跳过，之间算部分'));
        }
        sKind.appendChild(kBox);

        // —— 曲风分布 Top 8 ——
        var sGenre = section(mount, '曲风分布 Top 8');
        var gBox = el('div', 'set-stats-box');
        if (!r.genres.length) {
          gBox.appendChild(el('div', 'lsr-empty', '暂无数据——歌曲标签含「流派」字段后自动统计（支持 ; ； 、 / | 分隔，每首最多取 3 项）'));
        } else {
          var gMax = Math.max.apply(null, r.genres.map(function (g) { return g.sec; }));
          r.genres.forEach(function (g) {
            gBox.appendChild(barRow(g.name, gMax > 0 ? g.sec / gMax : 0, g.plays + ' 次 · ' + lsrFmtDur(g.sec)));
          });
        }
        sGenre.appendChild(gBox);

        // —— 年度统计 ——
        var sYear = section(mount, '年度统计');
        var yBox = el('div', 'set-stats-box');
        if (!r.years.length) {
          yBox.appendChild(el('div', 'lsr-empty', '暂无数据'));
        } else {
          var yMax = Math.max.apply(null, r.years.map(function (y) { return y.sec; }));
          r.years.forEach(function (y) {
            yBox.appendChild(barRow(y.name + ' 年', yMax > 0 ? y.sec / yMax : 0, y.plays + ' 次 · ' + lsrFmtDur(y.sec), true));
          });
        }
        sYear.appendChild(yBox);

        // —— Top 三榜（Top 8） ——
        var sTop = section(mount, 'Top 榜单');
        var cols = el('div', 'lsr-cols');
        cols.appendChild(lsrList('Top 歌曲', r.topSongs, function (s) { return s.title + (s.artist ? ' — ' + s.artist : ''); }));
        cols.appendChild(lsrList('Top 艺术家', r.topArtists, function (s) { return s.name; }));
        cols.appendChild(lsrList('Top 专辑', r.topAlbums, function (s) { return s.name; }));
        sTop.appendChild(cols);

        // —— 数据与分享：复制报告 / 生成分享图 / 清空统计 ——
        var sAct = section(mount, '数据与分享');
        var actRow = markItem(el('div', 'set-row'), '复制报告 生成分享图 清空统计 听歌统计 数据');
        var actLab = el('div');
        actLab.appendChild(el('div', '', '统计数据'));
        actLab.appendChild(el('div', 'set-hint', '数据仅保存在本机不上传；「复制报告」生成文本，「生成分享图」复制 PNG 后可直接粘贴发群'));
        actRow.appendChild(actLab);
        var btnWrap = el('div', 'set-stats-actions');
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
          st.clear();
          lastSig = '';
          render();
        };
        btnWrap.appendChild(btnImg); btnWrap.appendChild(btnCopy); btnWrap.appendChild(btnClear);
        actRow.appendChild(btnWrap);
        sAct.appendChild(actRow);

        if (contentEl) contentEl.scrollTop = scrollTop;
      }

      render(); // buildPanel 首建时即渲染（搜索索引/首次打开都有内容）
      onOpenHooks.push(function () { if (currentPage === 'stats') render(); });
      pageShowHooks.stats = render;
      // 停留本页时 4s 轮询：播放中 totalSec 持续变化，签名不同才重绘
      setInterval(function () {
        if (searchEl && searchEl.value) return; // 搜索态不重绘，避免过滤结果被刷新
        if (panel && panel.classList.contains('open') && currentPage === 'stats') render();
      }, 4000);
    })();

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

    // V4.4：流媒体播放缓存（边播边存 + LRU 上限；目录/大小自定义，主进程 streamCache.js 持久化）
    (function () {
      if (!window.mine || !window.mine.streamCacheStats) return;
      var sc = section(pgDownload, '播放缓存（在线播放）');
      var st0 = { enabled: true, maxMB: 2048, dir: '', custom: false, count: 0, totalMB: 0 };
      var refs = {};
      function refreshStats() {
        window.mine.streamCacheStats().then(function (s) { if (s) { st0 = s; apply(); } }).catch(function () { });
      }
      function apply() {
        if (refs.en) refs.en.checked = !!st0.enabled;
        if (refs.dir) { refs.dir.textContent = st0.dir + (st0.custom ? '' : '（默认）'); refs.dir.title = st0.dir; }
        if (refs.max) refs.max.value = String(st0.maxMB);
        if (refs.usage) refs.usage.textContent = '已缓存 ' + st0.count + ' 首 · 占用 ' + st0.totalMB + ' MB / 上限 ' + st0.maxMB + ' MB';
      }
      // 开关
      var r1 = markItem(el('div', 'set-row'), '播放缓存 在线播放 边播边存 cache 流媒体');
      var l1 = el('div');
      l1.appendChild(el('div', '', '启用播放缓存'));
      l1.appendChild(el('div', 'set-hint', '在线播放时后台把整首存到本地，下次再播直接解码缓存（秒开、省流量）；超出上限自动清理最久未播的'));
      r1.appendChild(l1);
      refs.en = document.createElement('input');
      refs.en.type = 'checkbox'; refs.en.checked = true;
      refs.en.onchange = function () { window.mine.streamCacheSetCfg({ enabled: refs.en.checked }).then(refreshStats).catch(function () { }); };
      r1.appendChild(refs.en);
      sc.appendChild(r1);
      // 缓存目录
      var r2 = markItem(el('div', 'set-row'), '缓存目录 缓存位置 cache dir 播放缓存');
      var l2 = el('div');
      l2.appendChild(el('div', '', '缓存目录'));
      l2.appendChild(el('div', 'set-hint', '默认在用户数据目录下；更改后旧目录文件不迁移（可手动删除）'));
      r2.appendChild(l2);
      var card = el('div', 'set-dl-card');
      refs.dir = el('div', 'set-dl-dir', '读取中…');
      card.appendChild(refs.dir);
      var foot = el('div', 'set-dl-foot');
      var btnRow = el('div', 'set-dl-btns');
      var bChg = el('button', 'eq-preset', '更改');
      var bDef = el('button', 'eq-preset', '默认');
      bChg.style.cssText = 'border-radius:7px;padding:4px 12px;font-size:12px;border:1px solid var(--line);background:var(--bg3);color:var(--text);cursor:pointer';
      bDef.style.cssText = bChg.style.cssText;
      bChg.onclick = function () { window.mine.streamCachePickDir().then(function (d) { if (d) refreshStats(); }).catch(function () { }); };
      bDef.onclick = function () { window.mine.streamCacheSetCfg({ dir: '' }).then(refreshStats).catch(function () { }); };
      btnRow.appendChild(bChg); btnRow.appendChild(bDef);
      foot.appendChild(btnRow);
      card.appendChild(foot);
      r2.appendChild(card);
      sc.appendChild(r2);
      // 上限 + 清空
      var r3 = markItem(el('div', 'set-row'), '缓存上限 缓存大小 cache size limit 播放缓存 清空');
      var l3 = el('div');
      l3.appendChild(el('div', '', '缓存上限'));
      refs.usage = el('div', 'set-hint', '读取中…');
      l3.appendChild(refs.usage);
      r3.appendChild(l3);
      var right = el('div'); right.style.cssText = 'display:flex;gap:8px;align-items:center';
      refs.max = el('select', 'am-sort-sel');
      [['512', '512 MB'], ['1024', '1 GB'], ['2048', '2 GB'], ['5120', '5 GB'], ['10240', '10 GB'], ['20480', '20 GB']].forEach(function (o) {
        var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; refs.max.appendChild(op);
      });
      refs.max.value = '2048';
      refs.max.onchange = function () { window.mine.streamCacheSetCfg({ maxMB: parseInt(refs.max.value, 10) }).then(refreshStats).catch(function () { }); };
      var bClr = el('button', 'eq-preset', '清空缓存');
      bClr.style.cssText = bChg.style.cssText;
      bClr.onclick = function () { window.mine.streamCacheClear().then(refreshStats).catch(function () { }); };
      right.appendChild(refs.max); right.appendChild(bClr);
      r3.appendChild(right);
      sc.appendChild(r3);
      // V4.4：按平台/音质分组查看与清理
      var gCard = el('div', 'set-dl-card');
      var gTitle = el('div', 'set-hint', '按平台 / 音质分组（读取中…）');
      gTitle.style.margin = '2px 0 6px';
      gCard.appendChild(gTitle);
      var gBox = el('div', 'set-sc-groups');
      gCard.appendChild(gBox);
      sc.appendChild(gCard);
      var PF_NAME = { kg: '酷狗', kw: '酷我', mg: '咪咕', tx: 'QQ 音乐', wy: '网易云', other: '其他' };
      var Q_NAME = { flac24bit: 'Hi-Res', flac: 'FLAC', '320k': '320K', '128k': '128K', unknown: '未知' };
      function refreshGroups() {
        if (!window.mine.streamCacheGroups) return;
        window.mine.streamCacheGroups().then(function (gs) {
          gBox.innerHTML = '';
          if (!gs || !gs.length) { gTitle.textContent = '按平台 / 音质分组（暂无缓存）'; return; }
          gTitle.textContent = '按平台 / 音质分组 · 共 ' + gs.length + ' 组';
          gs.forEach(function (g) {
            var row = el('div', 'set-sc-grow');
            row.appendChild(el('span', 'set-sc-gname', (PF_NAME[g.provider] || g.provider) + ' · ' + (Q_NAME[g.quality] || g.quality)));
            row.appendChild(el('span', 'set-hint', g.count + ' 首 · ' + g.totalMB + ' MB'));
            var b = el('button', 'eq-preset', '清理');
            b.style.cssText = bClr.style.cssText;
            b.onclick = function () {
              if (!window.confirm('确定清理「' + (PF_NAME[g.provider] || g.provider) + ' · ' + (Q_NAME[g.quality] || g.quality) + '」的 ' + g.count + ' 首缓存？')) return;
              window.mine.streamCacheClear({ provider: g.provider, quality: g.quality })
                .then(function () { refreshStats(); refreshGroups(); }).catch(function () { });
            };
            row.appendChild(b);
            gBox.appendChild(row);
          });
        }).catch(function () { gTitle.textContent = '分组信息读取失败'; });
      }
      var _refreshStatsOld = refreshStats;
      refreshStats = function () { _refreshStatsOld(); refreshGroups(); };
      refreshStats();
    })();

    // V4.3.22：下载任务管理选项（主进程 dlManager 持久化，改并发即时生效）
    (function () {
      if (!window.mine || !window.mine.dlGetSettings) return;
      var dlSet = { concurrency: 3, skipExisting: true, fileNameFmt: 'artist-name', embedCover: true, embedLrc: true, embedTLrc: true, lrcTLrc: true, lrcEncoding: 'utf8' };
      window.mine.dlGetSettings().then(function (s) { if (s) { dlSet = s; applyToUI(); } }).catch(function () { });
      var uiRefs = {};
      function applyToUI() {
        if (uiRefs.conc) uiRefs.conc.value = String(dlSet.concurrency || 3);
        if (uiRefs.skip) uiRefs.skip.checked = !!dlSet.skipExisting;
        if (uiRefs.fmt) uiRefs.fmt.value = dlSet.fileNameFmt || 'artist-name';
        ['embedCover', 'embedLrc', 'embedTLrc', 'lrcTLrc'].forEach(function (k) { if (uiRefs[k]) uiRefs[k].checked = dlSet[k] !== false; });
        if (uiRefs.lrcEncoding) uiRefs.lrcEncoding.value = dlSet.lrcEncoding || 'utf8';
      }
      function push(patch) { window.mine.dlSetSettings(patch).then(function (s) { if (s) dlSet = s; }).catch(function () { }); }
      function mkSel(opts, val, onch) {
        var s = el('select', 'am-sort-sel');
        opts.forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; s.appendChild(op); });
        s.value = val; s.onchange = function () { onch(s.value); };
        return s;
      }
      // 同时下载任务数
      var r1 = markItem(el('div', 'set-row'), '同时下载任务数 并发 download concurrency 批量下载');
      var l1 = el('div');
      l1.appendChild(el('div', '', '同时下载任务数'));
      l1.appendChild(el('div', 'set-hint', '批量下载时的并行任务数，其余任务排队等待（下载情况页可管理）'));
      r1.appendChild(l1);
      uiRefs.conc = mkSel([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6'], ['8', '8'], ['10', '10']],
        String(dlSet.concurrency), function (v) { push({ concurrency: parseInt(v, 10) }); });
      r1.appendChild(uiRefs.conc);
      s0.appendChild(r1);
      // 同名文件跳过
      var r2 = markItem(el('div', 'set-row'), '同名文件 跳过 重复下载 download skip existing');
      var l2 = el('div');
      l2.appendChild(el('div', '', '下载目录存在同名文件时跳过'));
      l2.appendChild(el('div', 'set-hint', '开启后同名文件不重复下载；关闭则自动加序号另存'));
      r2.appendChild(l2);
      uiRefs.skip = document.createElement('input');
      uiRefs.skip.type = 'checkbox'; uiRefs.skip.checked = !!dlSet.skipExisting;
      uiRefs.skip.onchange = function () { push({ skipExisting: uiRefs.skip.checked }); };
      r2.appendChild(uiRefs.skip);
      s0.appendChild(r2);
      // 文件命名方式
      var r3 = markItem(el('div', 'set-row'), '文件命名方式 下载文件名 download filename 命名');
      var l3 = el('div');
      l3.appendChild(el('div', '', '文件命名方式'));
      l3.appendChild(el('div', 'set-hint', '下载文件的命名规则，对之后的下载任务生效'));
      r3.appendChild(l3);
      uiRefs.fmt = mkSel([['artist-name', '艺术家 - 歌曲名'], ['name-artist', '歌曲名 - 艺术家'], ['name', '歌曲名']],
        dlSet.fileNameFmt, function (v) { push({ fileNameFmt: v }); });
      r3.appendChild(uiRefs.fmt);
      s0.appendChild(r3);
      // 嵌入到音频文件中的内容（洛雪同款）：嵌入封面 / 嵌入歌词 / 同时嵌入翻译歌词
      function mkCkRow(key, title, hint, terms) {
        var r = markItem(el('div', 'set-row'), terms);
        var l = el('div');
        l.appendChild(el('div', '', title));
        l.appendChild(el('div', 'set-hint', hint));
        r.appendChild(l);
        uiRefs[key] = document.createElement('input');
        uiRefs[key].type = 'checkbox'; uiRefs[key].checked = dlSet[key] !== false;
        uiRefs[key].onchange = function () { var p = {}; p[key] = uiRefs[key].checked; push(p); };
        r.appendChild(uiRefs[key]);
        s0.appendChild(r);
      }
      mkCkRow('embedCover', '嵌入封面', '把专辑封面嵌入下载的音频文件标签中', '嵌入封面 下载 embed cover');
      mkCkRow('embedLrc', '嵌入歌词', '把歌词嵌入下载的音频文件标签中', '嵌入歌词 下载 embed lyrics');
      mkCkRow('embedTLrc', '同时嵌入翻译歌词（如果有）', '嵌入歌词时一并将翻译歌词并入', '嵌入翻译歌词 tlyric');
      mkCkRow('lrcTLrc', '旁挂歌词文件含翻译（如果有）', '生成旁挂 .lrc 时把翻译歌词写入同一文件', '歌词文件 翻译 lrc tlyric');
      // 歌词文件编码
      var r4 = markItem(el('div', 'set-row'), '歌词编码 UTF-8 GBK lrc encoding');
      var l4 = el('div');
      l4.appendChild(el('div', '', '下载的歌词文件编码格式'));
      l4.appendChild(el('div', 'set-hint', '旁挂 .lrc 的编码；老播放器/车机不认 UTF-8 时选 GBK'));
      r4.appendChild(l4);
      uiRefs.lrcEncoding = mkSel([['utf8', 'UTF-8'], ['gbk', 'GBK']], dlSet.lrcEncoding, function (v) { push({ lrcEncoding: v }); });
      r4.appendChild(uiRefs.lrcEncoding);
      s0.appendChild(r4);
    })();

    /* ================= 更新与关于 ================= */
    var sUp = section(pgUpdate, '更新');
    // V4.3.19：联系渠道（QQ 群二维码，与首启引导/更新播报同一组）
    var sContact = section(pgUpdate, '联系我们（QQ 交流群）');
    var gWrap = markItem(el('div', 'set-groups'), '联系我们 QQ群 交流群 反馈 入群 二维码');
    [['assets/qq-group-annie.png', '安妮播放器专属群', '1128065156', '需求反馈 / Bug 上报'],
     ['assets/qq-group-hifi.png', '真无损HiFi音乐发烧友群', '1023637098', '无敌章鱼哥的 HiFi 交流群']].forEach(function (g) {
      var item = el('div', 'set-group');
      var img = document.createElement('img'); img.src = g[0]; img.alt = g[1];
      item.appendChild(img);
      item.appendChild(el('div', 'set-group-name', g[1]));
      item.appendChild(el('div', 'set-group-no', '群号 ' + g[2] + ' · ' + g[3]));
      gWrap.appendChild(item);
    });
    gWrap.appendChild(el('div', 'set-group-note', '请通过安妮播放器扫码入群的用户，在入群问题回答时明确备注入群渠道'));
    sContact.appendChild(gWrap);
    // ⚠️ 2026-10-22：macOS 版本署名（用户要求）
    var macCredit = markItem(el('div', 'set-row'), 'macOS 适配 署名 作者 反馈 联系');
    var macLab = el('div');
    macLab.appendChild(el('div', '', 'macOS 版本适配'));
    var macCreditTxt = el('div', 'set-hint');
    macCreditTxt.style.cssText = 'line-height:1.75;max-width:560px';
    macCreditTxt.textContent = '本 macOS 版本为「苏沐绫羽」进行全权适配，如有问题请及时向 2947205204@qq.com 邮箱提交反馈';
    macLab.appendChild(macCreditTxt);
    macCredit.appendChild(macLab);
    // 反馈邮箱做成可点复制
    var mailBtn = el('button', 'am-btn', '复制邮箱');
    mailBtn.style.marginLeft = '12px';
    mailBtn.onclick = function () {
      try {
        if (window.mine && window.mine.copyText) window.mine.copyText('2947205204@qq.com');
        if (typeof proToast === 'function') proToast('邮箱已复制：2947205204@qq.com');
      } catch (e) { }
    };
    macCredit.appendChild(mailBtn);
    sUp.appendChild(macCredit);

    // 当前版本
    var verRow = markItem(el('div', 'set-row'), '当前版本 版本号 version');
    var verLab = el('div'); verLab.appendChild(el('div', '', '当前版本'));
    verLab.appendChild(el('div', 'set-hint', '安妮播放器融合版（无敌章鱼哥制作出品，交流Q群1023637098）'));
    verLab.appendChild(el('div', 'set-hint', 'macOS 适配：苏沐绫羽'));
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
    aboutCard.appendChild(el('div', 'set-about-sub', '本地独占音乐播放器（CoreAudio Exclusive / CoreAudio）· GPL-3.0'));
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
    var btnQb = el('button', 'btn-ghost', 'QobuzDownloaderX @ImAiiR');
    btnQb.title = 'Qobuz 下载器先驱 · V4.3.6 Qobuz 功能的设计参考';
    btnQb.onclick = function () { window.mine.openExternal('https://github.com/ImAiiR/QobuzDownloaderX'); };
    thWrap.appendChild(btnDog); thWrap.appendChild(btnLx); thWrap.appendChild(btnQb);
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
    /* V4.3：在线导入（洛雪同款）——粘贴音源脚本链接，主进程拉取后走同一沙箱验证管线 */
    var extUrlBtn = el('button', 'btn-ghost', '在线导入…');
    extUrlBtn.title = '粘贴洛雪音源脚本的 http/https 链接，在线拉取导入';
    extUrlBtn.onclick = function () {
      window.anniePrompt('音源脚本链接（http/https）', 'https://', async function (url) {
        if (!url || !String(url).trim() || String(url).trim() === 'https://') return;
        extUrlBtn.disabled = true;
        extStat.textContent = '正在从链接下载音源…';
        try {
          var r = await window.mine.streamSourcesImportUrl({ url: String(url).trim() });
          if (r && r.error) extStat.textContent = '导入失败：' + r.error;
          else if (r && r.source) extStat.textContent = '音源「' + r.source.name + '」导入成功并已启用';
        } catch (e) { extStat.textContent = '导入失败：' + (e.message || e); }
        extUrlBtn.disabled = false;
        renderExtSources();
      });
    };
    extBtnWrap.appendChild(extUrlBtn);
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
        // V4.4：closeBehavior 不在 DEFAULTS 但需从主进程恢复显示（否则重启后设置面板恒显「每次询问」，与真实行为脱节）
        if (saved.closeBehavior !== undefined) ui.closeBehavior = saved.closeBehavior;
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
