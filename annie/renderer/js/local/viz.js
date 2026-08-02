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
};

const SPEC_BANDS = 192;

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

/* ---------------- 标签页切换（波形 / 频谱 / 无损，任意时刻仅显示其一） ---------------- */
document.querySelectorAll('.viz-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.viz-tab').forEach(b => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.vtab;
    $v('#wave-canvas').classList.toggle('active', tab === 'wave');
    $v('#spec-canvas').classList.toggle('active', tab === 'spec');
    $v('#lossless-page').classList.toggle('active', tab === 'lossless');
    renderWave();
    renderSpec();
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
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#07080c';
  ctx.fillRect(0, 0, W, H);

  const toDb = (v) => v > 1e-6 ? 20 * Math.log10(v) : -60;
  const frac = (v) => Math.max(0, Math.min(1, (toDb(v) + 60) / 60));
  const grad = ctx.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, '#008aff');
  grad.addColorStop(0.65, '#fac900');
  grad.addColorStop(0.92, '#e74c3c');

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
function renderWave() {
  const cv = $v('#wave-canvas');
  const W = cv.clientWidth, H = cv.clientHeight;
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
    return;
  }

  const mid = H / 2;
  const progress = vizState.duration > 0 ? Math.min(1, vizState.position / vizState.duration) : 0;
  const n = wf.length;
  const barW = W / n;

  for (let i = 0; i < n; i++) {
    const x = i * barW;
    const h = Math.max(1, wf[i] * (H - 6));
    ctx.fillStyle = (i / n) <= progress ? '#fac900' : '#3a4a6b'; // 播放过：金色；未播放：蓝灰
    ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h);
  }

  // 进度线
  if (progress > 0) {
    ctx.fillStyle = 'rgba(250,201,0,.9)';
    ctx.fillRect(progress * W - 1, 0, 2, H);
  }
}

/* ---------------- 频谱渲染 ---------------- */
function resetSpec() {
  vizState.specCanvas = document.createElement('canvas');
  vizState.specCanvas.width = Math.max(1, Math.ceil((vizState.specDur || 240) * 8)); // 预估宽度，不足再扩
  vizState.specCanvas.height = SPEC_BANDS;
  vizState.specCtx = vizState.specCanvas.getContext('2d');
  vizState.specCtx.fillStyle = '#000';
  vizState.specCtx.fillRect(0, 0, vizState.specCanvas.width, SPEC_BANDS);
  vizState.specFrames = 0;
}

function appendSpecFrames(frames, count) {
  if (!vizState.specCtx) resetSpec();
  // 预估宽度不足时扩容
  if (vizState.specFrames + count > vizState.specCanvas.width) {
    const old = vizState.specCanvas;
    const bigger = document.createElement('canvas');
    bigger.width = Math.max(old.width * 2, vizState.specFrames + count + 256);
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

function renderSpec() {
  const cv = $v('#spec-canvas');
  const W = cv.clientWidth, H = cv.clientHeight;
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
    return;
  }
  ctx.drawImage(vizState.specCanvas, 0, 0, vizState.specFrames, SPEC_BANDS, 0, 0, W, H);

  // 频率刻度（右缘）
  ctx.fillStyle = 'rgba(232,234,240,.55)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  const marks = [[22, 0.04], [16, 0.22], [12, 0.36], [8, 0.52], [4, 0.68], [1, 0.87]];
  for (const [k, frac] of marks) ctx.fillText(k + 'k', W - 4, H * frac + 3);

  // 播放进度线
  const progress = vizState.duration > 0 ? Math.min(1, vizState.position / vizState.duration) : 0;
  if (progress > 0) {
    ctx.fillStyle = 'rgba(250,201,0,.85)';
    ctx.fillRect(progress * W - 1, 0, 2, H);
  }
}

/* ---------------- 无损检测报告 ---------------- */
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
window.mine.onAnalyzeEvent((p) => {
  if (p.gen !== vizState.gen) return; // 过期分析结果丢弃
  if (p.type === 'frames') {
    appendSpecFrames(new Uint8Array(p.frames), p.count);
    $v('#viz-status').textContent = '分析中… ' + (vizState.specFrames / 8).toFixed(0) + 's';
    renderSpec();
  } else if (p.type === 'done') {
    vizState.analyzing = false;
    vizState.waveform = p.waveform && p.waveform.length ? new Float32Array(p.waveform) : null;
    if (p.durationSec) vizState.specDur = p.durationSec;
    renderLossless(p.lossless);
    $v('#viz-status').textContent = '分析完成';
    renderWave();
    renderSpec();
  } else if (p.type === 'error') {
    vizState.analyzing = false;
    $v('#viz-status').textContent = '分析失败';
    renderLossless(null);
    $v('#lossless-summary').textContent = '分析失败：' + (p.message || '未知错误');
    renderWave();
    renderSpec();
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
    resetSpec();
    renderLossless(null);
    $v('#viz-status').textContent = '分析中…';
    renderWave();
    renderSpec();
    const r = await window.mine.analyzeStart(input, headers || null);
    if (r && r.gen) vizState.gen = r.gen;
    if (!r || !r.ok) {
      vizState.analyzing = false;
      $v('#viz-status').textContent = '分析不可用';
    }
  },
  /** 播放进度同步（position 事件驱动）。 */
  setProgress(pos, dur) {
    vizState.position = pos || 0;
    if (dur) vizState.duration = dur;
    renderWave();
    // 频谱进度线 10Hz 重绘开销可控（分区收起时 renderSpec 内部自动跳过）
    renderSpec();
  },
  /** Plus：底栏"频谱"按钮开关可视化面板（状态持久化）。 */
  toggleBar() {
    setVizBar(!$v('#viz-bar').classList.contains('hidden'), true);
  },
};

// 窗口尺寸变化时重绘
window.addEventListener('resize', () => { renderWave(); renderSpec(); drawLevel(); });
drawLevel();

})();
