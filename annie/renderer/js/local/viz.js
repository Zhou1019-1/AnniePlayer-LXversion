'use strict';
/* 安妮播放器 V2 —— 可视化模块（IIFE 包裹，避免与视觉舞台模块的全局标识符冲突） */
(function () {
/* 实时电平（引擎 level 事件） + 整曲波形（含进度） + Spek 风格频谱图 + 无损检测报告。
 * 数据来源：主进程 analyzer（ffmpeg 解码 → FFT），通过 analyze:event 推送。
 */

const vizState = {
  gen: 0,                 // 当前分析代际
  analyzing: false,
  // 频谱
  specFrames: 0,
  specCanvas: null,       // 离屏画布（1px/帧 × 192 行，已上色）
  specCtx: null,
  specDur: 0,
  // 波形
  waveform: null,         // Float32Array 0..1
  // 进度
  position: 0,
  duration: 0,
  // 电平（双声道）
  rmsL: 0, peakL: 0, rmsR: 0, peakR: 0, peakHoldL: 0, peakHoldR: 0,
  // V1.1.5：canvas 尺寸缓存——渲染热路径（10Hz position/level）绝不读 clientWidth/
  // clientHeight（读取会强制同步回流，是 UI 卡顿根源）；只在 resize/切 tab/面板显隐时重测。
  size: { wave: { w: 0, h: 0 }, spec: { w: 0, h: 0 }, level: { w: 0, h: 0 } },
  sizeDirty: { wave: true, spec: true, level: true },
  _levelGrad: null,       // 电平渐变缓存（避免 11Hz 每次 createLinearGradient）
  _levelGradH: 0,
  // V1.1.5：波形进度增量渲染状态（仅重绘进度变化跨越的柱，而非每帧全量 1600 根）
  waveLastIdx: -1,
};

const SPEC_BANDS = 192;
// V1.1.9：频谱离屏画布宽度上限（8 分钟 × 8px/s = 3840px）——长音频不再无限膨胀
const MAX_SPEC_W = 3840;

/* ---------------- Spek 风格调色板（黑→紫→红→橙→黄→白） ---------------- */
const PALETTE = (() => {
  const stops = [
    [0.00, 0, 0, 0],
    [0.15, 24, 12, 58],
    [0.32, 74, 20, 104],
    [0.50, 148, 24, 92],
    [0.65, 208, 52, 44],
    [0.80, 238, 130, 30],
    [0.92, 252, 208, 60],
    [1.00, 255, 255, 255],
  ];
  const lut = new Uint8Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
    const [t0, r0, g0, b0] = stops[s];
    const [t1, r1, g1, b1] = stops[s + 1];
    const k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    lut[v * 3] = Math.round(r0 + (r1 - r0) * k);
    lut[v * 3 + 1] = Math.round(g0 + (g1 - g0) * k);
    lut[v * 3 + 2] = Math.round(b0 + (b1 - b0) * k);
  }
  return lut;
})();

const $v = (s) => document.querySelector(s);

/* ---------------- V1.1.5：canvas 尺寸缓存 ----------------
 * 渲染热路径（position 10Hz / level 11Hz）只读缓存；尺寸只在低频事件
 * （resize / 切 tab / 面板显隐）时重测。读 clientWidth/clientHeight 会
 * 强制同步回流——之前每 10Hz 读一次，是主线程周期性掉帧的直接原因。 */
function ensureVizSize(key) {
  const s = vizState.size[key];
  if (!vizState.sizeDirty[key]) return s;
  const cv = key === 'wave' ? $v('#wave-canvas') : key === 'spec' ? $v('#spec-canvas') : $v('#level-canvas');
  const w = cv.clientWidth, h = cv.clientHeight;
  s.w = w; s.h = h;
  vizState.sizeDirty[key] = false;
  return s;
}
function markVizSizeDirty() {
  vizState.sizeDirty.wave = vizState.sizeDirty.spec = vizState.sizeDirty.level = true;
}

/* ---------------- 标签页切换（波形 / 频谱 / 无损，任意时刻仅显示其一） ---------------- */
let autoSwitchedTab = false; // 分析中自动切到频谱页签的标记（分析完成后切回）

function switchVizTab(tab) {
  document.querySelectorAll('.viz-tab').forEach(b => b.classList.toggle('active', b.dataset.vtab === tab));
  $v('#wave-canvas').classList.toggle('active', tab === 'wave');
  $v('#spec-canvas').classList.toggle('active', tab === 'spec');
  const sp = $v('#spec-progress'); if (sp) sp.classList.toggle('active', tab === 'spec');
  $v('#lossless-page').classList.toggle('active', tab === 'lossless');
  renderWave();
  renderSpec();
}

function currentVizTab() {
  const active = document.querySelector('.viz-tab.active');
  return active ? active.dataset.vtab : 'wave';
}

document.querySelectorAll('.viz-tab').forEach(btn => {
  btn.onclick = () => {
    autoSwitchedTab = false; // 用户手动切换后不再自动切回
    switchVizTab(btn.dataset.vtab);
  };
});

/* ---------------- 面板整体关闭 / 恢复（状态持久化） ---------------- */
function setVizBar(hidden, persist) {
  $v('#viz-bar').classList.toggle('hidden', hidden);
  $v('#btn-viz-restore').classList.toggle('hidden', !hidden);
  if (persist && window.annieSettings) {
    annieSettings.ui.vizBarHidden = hidden;
    annieSettings.save();
  }
  // 恢复显示后画布尺寸从 0 恢复，需要重绘
  markVizSizeDirty();
  renderWave();
  renderSpec();
}
$v('#btn-viz-close').onclick = () => setVizBar(true, true);
$v('#btn-viz-restore').onclick = () => setVizBar(false, true);
function applyVizPrefs() {
  if (window.annieSettings) setVizBar(!!annieSettings.ui.vizBarHidden, false);
}
applyVizPrefs();
document.addEventListener('annie-settings-changed', applyVizPrefs);

/* ---------------- 实时电平 ---------------- */
/* 双声道竖直电平柱：L/R 各一条 RMS 柱 + Peak 保持线 + dB 读数（dB 刻度 -60..0） */
function drawLevel() {
  const cv = $v('#level-canvas');
  const { w: W, h: H } = ensureVizSize('level');
  if (!W || !H) return;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#07080c';
  ctx.fillRect(0, 0, W, H);

  const toDb = (v) => v > 1e-6 ? 20 * Math.log10(v) : -60;
  const frac = (v) => Math.max(0, Math.min(1, (toDb(v) + 60) / 60));
  // V1.1.5：渐变缓存——11Hz 调用下旧实现每次 createLinearGradient 新建对象
  if (!vizState._levelGrad || vizState._levelGradH !== H) {
    const g = ctx.createLinearGradient(0, H, 0, 0);
    g.addColorStop(0, '#008aff');
    g.addColorStop(0.65, '#fac900');
    g.addColorStop(0.92, '#e74c3c');
    vizState._levelGrad = g;
    vizState._levelGradH = H;
  }
  const grad = vizState._levelGrad;

  const meterH = H - 14;            // 底部留 dB 读数区
  const barW = Math.max(6, (W - 14) / 2);
  const channels = [
    { label: 'L', rms: vizState.rmsL, holdKey: 'peakHoldL', peak: vizState.peakL, x: 4 },
    { label: 'R', rms: vizState.rmsR, holdKey: 'peakHoldR', peak: vizState.peakR, x: W - 4 - barW },
  ];
  for (const ch of channels) {
    const h = frac(ch.rms) * (meterH - 6);
    ctx.fillStyle = grad;
    ctx.fillRect(ch.x, 4 + (meterH - 6) - h, barW, h);

    // Peak 保持线（带衰减， clipped 时变红）
    vizState[ch.holdKey] = Math.max(ch.peak, vizState[ch.holdKey] * 0.94);
    const pk = frac(vizState[ch.holdKey]) * (meterH - 6);
    ctx.fillStyle = vizState[ch.holdKey] >= 0.99 ? '#e74c3c' : '#e8eaf0';
    ctx.fillRect(ch.x, 4 + (meterH - 6) - pk, barW, 2);

    // dB 读数（显示 Peak Hold 值）
    const db = toDb(vizState[ch.holdKey]);
    ctx.fillStyle = '#8a90a5';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(db <= -59.5 ? '-∞' : db.toFixed(0), ch.x + barW / 2, H - 3);
  }
}

// 引擎 level 事件驱动（~10Hz），独立注册监听；兼容旧版单声道字段
window.mine.onEngineEvent((event, d) => {
  if (event !== 'level') return;
  vizState.rmsL = d.rmsL ?? d.rms ?? 0;
  vizState.peakL = d.peakL ?? d.peak ?? 0;
  vizState.rmsR = d.rmsR ?? d.rms ?? 0;
  vizState.peakR = d.peakR ?? d.peak ?? 0;
  drawLevel();
});

/* ---------------- 波形渲染 ---------------- */
/* V1.1.5 性能拆分：
 * renderWaveFull()  — 低频：绘制全部 1600 根柱（切歌/尺寸变化/分析完成时调用）
 * drawWaveProgress() — 10Hz：只重绘进度跨过的柱（金↔蓝灰切换）+ 进度线
 * 旧实现 setProgress 每 10Hz 全量重绘 1600 根 fillRect + 强制回流 = 卡顿根因。 */
function renderWaveFull() {
  const cv = $v('#wave-canvas');
  const { w: W, h: H } = ensureVizSize('wave');
  if (!W || !H) return; // 分区收起时尺寸为 0，跳过绘制
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#07080c';
  ctx.fillRect(0, 0, W, H);

  const wf = vizState.waveform;
  if (!wf || !wf.length) {
    ctx.fillStyle = '#8a90a5';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(vizState.analyzing ? '波形分析中…' : '播放曲目后显示波形', W / 2, H / 2);
    vizState.waveLastIdx = -1;
    return;
  }

  const mid = H / 2;
  const n = wf.length;
  const barW = W / n;
  const progress = vizState.duration > 0 ? Math.min(1, vizState.position / vizState.duration) : 0;
  const curIdx = Math.floor(progress * n);

  // 底图：全部画为未播放色（蓝灰），再覆盖已播放部分
  ctx.fillStyle = '#3a4a6b';
  for (let i = 0; i < n; i++) {
    const x = i * barW;
    const h = Math.max(1, wf[i] * (H - 6));
    ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h);
  }
  ctx.fillStyle = '#fac900';
  for (let i = 0; i <= curIdx && i < n; i++) {
    const x = i * barW;
    const h = Math.max(1, wf[i] * (H - 6));
    ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h);
  }
  vizState.waveLastIdx = curIdx;
  drawWaveProgressLine(ctx, W, H, progress);
}

// 波形进度增量：仅把 [lastIdx+1, curIdx] 区间内的柱刷成金色（播放前进），
// 或 [curIdx+1, lastIdx] 刷回蓝灰（seek 回退）。旧实现每次全量重绘 n 根。
function drawWaveProgress() {
  const cv = $v('#wave-canvas');
  const { w: W, h: H } = ensureVizSize('wave');
  const wf = vizState.waveform;
  if (!W || !H || !wf || !wf.length || vizState.waveLastIdx < 0) return;
  const ctx = cv.getContext('2d');
  const mid = H / 2;
  const n = wf.length;
  const barW = W / n;
  const progress = vizState.duration > 0 ? Math.min(1, vizState.position / vizState.duration) : 0;
  const curIdx = Math.floor(progress * n);
  if (curIdx !== vizState.waveLastIdx) {
    if (curIdx > vizState.waveLastIdx) {
      ctx.fillStyle = '#fac900';
      for (let i = vizState.waveLastIdx + 1; i <= curIdx && i < n; i++) {
        const x = i * barW;
        const h = Math.max(1, wf[i] * (H - 6));
        ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h);
      }
    } else {
      ctx.fillStyle = '#3a4a6b';
      for (let i = curIdx + 1; i <= vizState.waveLastIdx && i < n; i++) {
        const x = i * barW;
        const h = Math.max(1, wf[i] * (H - 6));
        ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h);
      }
    }
    vizState.waveLastIdx = curIdx;
  }
  drawWaveProgressLine(ctx, W, H, progress, wf, mid, barW, n);
}

// 进度线：先擦除旧线所在列（V1.1.9：整列清背景再重画柱——旧实现只重画柱区域，
// 进度线画满全高，超出柱高的上下留白永不擦除 → 拉进度条后残留黄色竖线），再画新线。
function drawWaveProgressLine(ctx, W, H, progress, wf, mid, barW, n) {
  const oldX = vizState._waveOldX;
  vizState._waveOldX = -1;
  if (oldX >= 0 && wf) {
    // 整列清为背景色（2px + 柱间隙余量）
    ctx.fillStyle = '#07080c';
    ctx.fillRect(Math.max(0, oldX - 1), 0, 4, H);
    // 重画该列覆盖到的柱
    const i0 = Math.max(0, Math.floor((oldX - 1) / barW));
    const i1 = Math.min(n - 1, Math.floor((oldX + 3) / barW));
    for (let i = i0; i <= i1; i++) {
      const x = i * barW;
      const h = Math.max(1, wf[i] * (H - 6));
      ctx.fillStyle = i <= vizState.waveLastIdx ? '#fac900' : '#3a4a6b';
      ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h);
    }
  }
  if (progress > 0) {
    const px = Math.round(progress * W) - 1;
    ctx.fillStyle = 'rgba(250,201,0,.9)';
    ctx.fillRect(px, 0, 2, H);
    vizState._waveOldX = px;
  }
}

// 兼容旧接口（低频调用方：switchVizTab/setVizBar/analyze/resize）
function renderWave() {
  vizState._waveOldX = -1; // 全量重绘前重置旧线标记，避免残留
  renderWaveFull();
}

/* ---------------- 频谱渲染 ----------------
 * V1.1.9：全轨一次分析（波形完整），频谱画布封顶 MAX_SPEC_W（8 分钟 × 8px/s）。
 * 长音频不再分配数万像素画布（旧实现 1.5h = 43200px ≈ 33MB，fillRect/扩容/拷贝
 * 全是同步重活 → 切歌卡）。超出 8 分钟部分忽略（频谱展示前 8 分钟，波形不受影响）。 */
function resetSpec() {
  vizState.specCanvas = document.createElement('canvas');
  vizState.specCanvas.width = Math.max(1, Math.min(MAX_SPEC_W, Math.ceil((vizState.specDur || 240) * 8)));
  vizState.specCanvas.height = SPEC_BANDS;
  vizState.specCtx = vizState.specCanvas.getContext('2d');
  vizState.specCtx.fillStyle = '#000';
  vizState.specCtx.fillRect(0, 0, vizState.specCanvas.width, SPEC_BANDS);
  vizState.specFrames = 0;
}

function appendSpecFrames(frames, count) {
  if (!vizState.specCtx) resetSpec();
  // 预估宽度不足时扩容（封顶 MAX_SPEC_W，超出忽略）
  if (vizState.specFrames + count > vizState.specCanvas.width) {
    if (vizState.specCanvas.width >= MAX_SPEC_W) {
      vizState.specFrames += count; // 计数推进，画面定格在 8 分钟
      return;
    }
    const old = vizState.specCanvas;
    const bigger = document.createElement('canvas');
    bigger.width = Math.min(MAX_SPEC_W, Math.max(old.width * 2, vizState.specFrames + count + 256));
    bigger.height = SPEC_BANDS;
    const bctx = bigger.getContext('2d');
    bctx.drawImage(old, 0, 0);
    vizState.specCanvas = bigger;
    vizState.specCtx = bctx;
  }
  const img = vizState.specCtx.createImageData(count, SPEC_BANDS);
  for (let f = 0; f < count; f++) {
    for (let b = 0; b < SPEC_BANDS; b++) {
      const v = frames[f * SPEC_BANDS + b];
      // 行 0 = 顶部 = 最高频带
      const row = SPEC_BANDS - 1 - b;
      const o = (row * count + f) * 4;
      img.data[o] = PALETTE[v * 3];
      img.data[o + 1] = PALETTE[v * 3 + 1];
      img.data[o + 2] = PALETTE[v * 3 + 2];
      img.data[o + 3] = 255;
    }
  }
  vizState.specCtx.putImageData(img, vizState.specFrames, 0);
  vizState.specFrames += count;
}

function renderSpecFull() {
  const cv = $v('#spec-canvas');
  const { w: W, h: H } = ensureVizSize('spec');
  if (!W || !H) return; // 分区收起时尺寸为 0，跳过绘制
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  if (!vizState.specFrames || !vizState.specCanvas) {
    ctx.fillStyle = '#8a90a5';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(vizState.analyzing ? '频谱分析中…' : '播放曲目后显示频谱', W / 2, H / 2);
    vizState._specOldX = -1;
    positionSpecProgress(0, 0); // 无频谱数据时隐藏覆盖层进度线
    return;
  }
  ctx.drawImage(vizState.specCanvas, 0, 0, vizState.specFrames, SPEC_BANDS, 0, 0, W, H);

  // 频率刻度（右缘）——静态，仅全量重绘时画一次
  ctx.fillStyle = 'rgba(232,234,240,.55)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  const marks = [[22, 0.04], [16, 0.22], [12, 0.36], [8, 0.52], [4, 0.68], [1, 0.87]];
  for (const [k, frac] of marks) ctx.fillText(k + 'k', W - 4, H * frac + 3);

  const progress = vizState.duration > 0 ? Math.min(1, vizState.position / vizState.duration) : 0;
  vizState._specOldX = -1;
  positionSpecProgress(W, progress);
}

// 进度线移到独立覆盖层：60fps 只写 transform，底图不再全量重绘。
// （V1.1.9 曾改全量重绘解决旧线染黄；覆盖层方案天然无残留问题）
function positionSpecProgress(W, progress) {
  const ov = $v('#spec-progress');
  if (!ov) return;
  const line = ov.firstElementChild;
  if (!line) return;
  const show = progress > 0 && W > 0;
  line.style.display = show ? '' : 'none';
  if (show) line.style.transform = 'translateX(' + (Math.round(progress * W) - 1) + 'px)';
}
function drawSpecProgress() {
  const s = vizState.size.spec;
  const progress = vizState.duration > 0 ? Math.min(1, vizState.position / vizState.duration) : 0;
  positionSpecProgress(s.w, progress);
}

// 兼容旧接口（低频调用方：switchVizTab/setVizBar/analyze/resize）
function renderSpec() {
  renderSpecFull();
}

/* ---------------- 无损检测报告 ---------------- */
// V3.1：无损判定改为用户主动触发——分析照常产出波形/频谱，判定结果仅暂存，
// 用户点击"开始无损检测"才展示；无现成结果时对当前曲目跑一次分析。
function renderLosslessIdle() {
  const sum = $v('#lossless-summary');
  const rs = $v('#lossless-reasons');
  if (!sum || !rs) return;
  sum.textContent = state.currentPath
    ? '无损判定不会自动进行，点击按钮对当前曲目检测'
    : '播放曲目后可手动进行无损检测';
  rs.innerHTML = '';
  const btn = document.createElement('button');
  btn.textContent = '开始无损检测';
  btn.style.cssText = 'margin-top:8px;padding:6px 16px;border:1px solid var(--line);border-radius:8px;background:none;color:var(--fg,#e8eaf0);cursor:pointer;font-size:12px';
  btn.onmouseenter = () => { btn.style.borderColor = '#fac900'; };
  btn.onmouseleave = () => { btn.style.borderColor = 'var(--line)'; };
  btn.onclick = () => window.annieViz.detectLossless();
  rs.appendChild(btn);
}

function renderLossless(r) {
  const sum = $v('#lossless-summary');
  const rs = $v('#lossless-reasons');
  if (!r) {
    sum.textContent = vizState.analyzing ? '无损检测分析中…' : '播放任意曲目后自动生成无损检测报告';
    rs.innerHTML = '';
    return;
  }
  let html = `<span class="verdict v${r.verdictLevel}">${r.verdict}</span><span class="score">得分 ${r.score}/100</span>`;
  if (r.hasCutoff) html += `<span class="score"> · 频率截止 @ ${r.cutoffFreq.toFixed(1)}kHz</span>`;
  if (r.codec) html += `<span class="score"> · 编码 ${String(r.codec).toUpperCase()}</span>`;
  sum.innerHTML = html;
  rs.innerHTML = (r.reasons && r.reasons.length)
    ? r.reasons.map(x => `<div>${x}</div>`).join('')
    : '<div>未发现转码嫌疑特征，频谱形态自然。</div>';
}

/* ---------------- 分析事件 ---------------- */
// V1.1.9：分析帧渲染节流——长音频全轨分析期间主进程高速推送 frames 事件，
// 旧实现每批都同步 renderSpec（全量 drawImage），渲染主线程被 IPC 频率拖着跑。
// 现在：数据立即入离屏画布（putImageData 轻），画面重绘合并到 rAF——每帧最多一次。
let _specRaf = 0;
function scheduleSpecRender() {
  if (_specRaf) return;
  _specRaf = requestAnimationFrame(() => {
    _specRaf = 0;
    if (vizState.analyzing || vizState.specFrames) renderSpecFull();
  });
}

window.mine.onAnalyzeEvent((p) => {
  if (p.gen !== vizState.gen) return; // 过期分析结果丢弃
  if (p.type === 'frames') {
    appendSpecFrames(new Uint8Array(p.frames), p.count);
    $v('#viz-status').textContent = '分析中… ' + (vizState.specFrames / 8).toFixed(0) + 's';
    scheduleSpecRender(); // V1.1.9：合并到 rAF，不再每批全量重绘
  } else if (p.type === 'done') {
    vizState.analyzing = false;
    vizState.waveform = p.waveform && p.waveform.length ? new Float32Array(p.waveform) : null;
    if (p.durationSec) vizState.specDur = p.durationSec;
    if (p.lossless) vizState.lossless = p.lossless; // V3.1：暂存不展示
    if (vizState.losslessWanted) { vizState.losslessWanted = false; renderLossless(vizState.lossless); }
    else renderLosslessIdle();
    $v('#viz-status').textContent = '分析完成';
    renderWave();
    renderSpec();
    if (autoSwitchedTab) { autoSwitchedTab = false; switchVizTab('wave'); } // 波形就绪，切回
  } else if (p.type === 'lossless') {
    // 并行编码探测补发的无损结论（覆盖频谱计算的判定，如"有损压缩格式"快捷结论）
    vizState.lossless = p.lossless; // V3.1：暂存，用户触发过才展示
    if (vizState.losslessWanted) { vizState.losslessWanted = false; renderLossless(p.lossless); }
  } else if (p.type === 'error') {
    vizState.analyzing = false;
    $v('#viz-status').textContent = '分析失败';
    renderLossless(null);
    $v('#lossless-summary').textContent = '分析失败：' + (p.message || '未知错误');
    renderWave();
    renderSpec();
    if (autoSwitchedTab) { autoSwitchedTab = false; switchVizTab('wave'); }
  }
});

/* ---------------- 对外接口 ---------------- */
window.annieViz = {
  /** 开始分析新曲目（本地路径或流媒体 URL）。 */
  async analyze(input, headers) {
    vizState.gen++;
    vizState.analyzing = true;
    vizState.waveform = null;
    vizState.position = 0;
    vizState.lossless = null; // V3.1：新曲目清空旧判定
    resetSpec();
    renderLosslessIdle();
    $v('#viz-status').textContent = '分析中…';
    // 分析中自动展示"频谱"页签：频谱是流式渲染（逐批到达即绘制），
    // 波形必须等整曲分析完成才一次性出现——避免用户误以为要等分析完才有图。
    if (!$v('#viz-bar').classList.contains('hidden') && currentVizTab() === 'wave') {
      autoSwitchedTab = true;
      switchVizTab('spec');
    }
    renderWave();
    renderSpec();
    const r = await window.mine.analyzeStart(input, headers || null);
    if (r && r.gen) vizState.gen = r.gen;
    if (!r || !r.ok) {
      vizState.analyzing = false;
      $v('#viz-status').textContent = '分析不可用';
    }
  },
  /** 播放进度同步（position 事件驱动，10Hz）。V1.1.5：只做增量绘制——
   *  波形/频谱底图不动，仅刷新进度线（旧实现每 10Hz 全量重绘 1600 根柱 + drawImage）。 */
  setProgress(pos, dur) {
    vizState.position = pos || 0;
    if (dur) vizState.duration = dur;
    // 仅当前激活的页面需要增量更新进度线（未激活 canvas display:none，绘制是 no-op）
    if (currentVizTab() === 'wave') drawWaveProgress();
    else if (currentVizTab() === 'spec') drawSpecProgress();
  },
  /** V3.1：无损检测手动触发——有暂存结果直接展示，否则对当前曲目跑一次分析。 */
  async detectLossless() {
    if (vizState.lossless && !vizState.analyzing) { renderLossless(vizState.lossless); return; }
    const input = state.currentStream ? state.currentStream.url
      : (state.currentCue ? state.currentCue.src : state.currentPath);
    if (!input) return;
    vizState.losslessWanted = true;
    $v('#lossless-summary').textContent = '无损检测分析中…（整曲 FFT，请稍候）';
    $v('#lossless-reasons').innerHTML = '';
    await window.annieViz.analyze(input, state.currentStream ? (state.currentStream.headers || null) : null);
  },
  /** Plus：底栏"频谱"按钮开关可视化面板（状态持久化）。 */
  toggleBar() {
    setVizBar(!$v('#viz-bar').classList.contains('hidden'), true);
  },
};

// 窗口尺寸变化时重绘（低频：先标记缓存脏，再全量重绘）
window.addEventListener('resize', () => { markVizSizeDirty(); renderWave(); renderSpec(); drawLevel(); });
// V1.1.5：面板显隐/切 tab 时尺寸可能变化（收起时 0 → 展开后恢复），全量重绘前重测
const _origSwitch = switchVizTab;
switchVizTab = function (tab) {
  markVizSizeDirty();
  _origSwitch(tab);
};
drawLevel();

})();
