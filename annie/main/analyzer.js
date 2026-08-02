'use strict';
// 音频分析器：ffmpeg 解码 → FFT → 频谱图帧 / 波形 / 无损检测。
// 无损检测规则移植自 spek-lossless-detector（V4.0 扣分制），
// 但直接作用于真实 FFT 频谱数据而非 Spek 截图像素，避免对数轴硬编码失准。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/* ---------------- 工具链定位（与 engineClient 一致的 dev/prod 双路径） ---------------- */
function resolveTool(name) {
  const prod = path.join(process.resourcesPath || '', 'engine', 'tools', name);
  // EXP 沙箱布局：exp7.28/main → exp7.28/engine/tools
  const dev = path.join(__dirname, '..', 'engine', 'tools', name);
  for (const p of [prod, dev]) { try { if (fs.existsSync(p)) return p; } catch { } }
  return name; // 回退 PATH
}

/* ---------------- FFT（迭代 radix-2，预计算旋转因子） ---------------- */
function makeFft(size) {
  const levels = Math.round(Math.log2(size));
  const cosT = new Float64Array(size / 2);
  const sinT = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / size);
    sinT[i] = Math.sin((2 * Math.PI * i) / size);
  }
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let j = 0; j < levels; j++) r |= ((i >> j) & 1) << (levels - 1 - j);
    rev[i] = r;
  }
  const hann = new Float64Array(size);
  for (let i = 0; i < size; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return { size, cosT, sinT, rev, hann };
}

function fftRadix2(re, im, plan) {
  const { size, cosT, sinT, rev } = plan;
  for (let i = 0; i < size; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const half = len >> 1;
    const step = size / len;
    for (let i = 0; i < size; i += len) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cosT[k], wi = -sinT[k];
        const xr = re[i + j + half] * wr - im[i + j + half] * wi;
        const xi = re[i + j + half] * wi + im[i + j + half] * wr;
        re[i + j + half] = re[i + j] - xr;
        im[i + j + half] = im[i + j] - xi;
        re[i + j] += xr;
        im[i + j] += xi;
      }
    }
  }
}

/* ---------------- 常量 ---------------- */
const SAMPLE_RATE = 44100;
const FFT_SIZE = 4096;
const HOP = 2048;
const SPEC_BANDS = 192;          // 频谱图纵向 log 频带数（显示用）
const SPEC_MIN_HZ = 30;
const SPEC_MAX_HZ = 22050;
const FRAME_BATCH = 24;          // 每批推送的频谱帧数
const MAX_WAVEFORM_POINTS = 1600;

// 无损检测频带（Hz），与原 V4.0 七频带对应
const DETECT_BANDS = [
  [0, 4000], [4000, 8000], [8000, 12000], [12000, 16000],
  [16000, 18000], [18000, 20000], [20000, 22050],
];

const fftPlan = makeFft(FFT_SIZE);
const BIN_HZ = SAMPLE_RATE / FFT_SIZE;

// 显示用 log 频带 → bin 范围（预计算）
const specBandBins = (() => {
  const bands = [];
  const logMin = Math.log10(SPEC_MIN_HZ), logMax = Math.log10(SPEC_MAX_HZ);
  for (let b = 0; b < SPEC_BANDS; b++) {
    const f0 = Math.pow(10, logMin + (logMax - logMin) * (b / SPEC_BANDS));
    const f1 = Math.pow(10, logMin + (logMax - logMin) * ((b + 1) / SPEC_BANDS));
    const bin0 = Math.max(1, Math.floor(f0 / BIN_HZ));
    const bin1 = Math.min(FFT_SIZE / 2 - 1, Math.max(bin0, Math.ceil(f1 / BIN_HZ)));
    bands.push([bin0, bin1]);
  }
  return bands;
})();

// 检测频带 → bin 范围（预计算）
const detectBandBins = DETECT_BANDS.map(([f0, f1]) => [
  Math.max(1, Math.round(f0 / BIN_HZ)),
  Math.min(FFT_SIZE / 2 - 1, Math.round(f1 / BIN_HZ)),
]);

/* ---------------- 分析会话 ---------------- */
let current = null; // { proc, gen, cancelled }

function cancelAnalyze() {
  if (current) {
    current.cancelled = true;
    try { current.proc.kill(); } catch { }
    current = null;
  }
}

function isUrl(p) { return /^https?:\/\//i.test(p); }

/** 探测编码信息：有损格式直接给出结论，无需频谱分析。 */
function probeCodec(input, headers) {
  return new Promise((resolve) => {
    const args = ['-v', 'error'];
    if (isUrl(input)) {
      args.push('-timeout', '15000000');
      if (headers) args.push('-headers', headers);
    }
    args.push('-show_entries', 'stream=codec_name,sample_rate,bits_per_sample', '-of', 'json', input);
    let out = '';
    const proc = spawn(resolveTool('ffprobe.exe'), args, { windowsHide: true });
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      try {
        const j = JSON.parse(out);
        const s = (j.streams || []).find(x => x.sample_rate);
        resolve(s ? { codec: s.codec_name || '', sampleRate: Number(s.sample_rate) || 0, bitDepth: Number(s.bits_per_sample) || 0 } : null);
      } catch { resolve(null); }
    });
  });
}

/**
 * 启动分析。事件通过 win.webContents.send('analyze:event', ...) 推送：
 *   { type:'frames', gen, frames:Uint8Array, count }  频谱帧（每帧 SPEC_BANDS 字节，0-255）
 *   { type:'done', gen, waveform:Float32Array, lossless, durationSec }
 *   { type:'error', gen, message }
 * forcedLossless：有损容器格式的预定结论（频谱图照常生成，仅跳过频谱判定）。
 */
function startAnalyze(win, input, headers, gen, forcedLossless) {
  cancelAnalyze();

  const args = ['-v', 'error', '-nostdin'];
  if (isUrl(input)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000');
    if (headers) args.push('-headers', headers);
  }
  args.push('-i', input, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1');

  const proc = spawn(resolveTool('ffmpeg.exe'), args, { windowsHide: true });
  const session = { proc, gen, cancelled: false };
  current = session;

  // 状态
  const byteQueue = []; let queued = 0;
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const mags = new Float64Array(FFT_SIZE / 2);

  let specBatch = []; let specBatchCount = 0;
  let waveform = []; let waveAcc = 0; let waveAccMax = 0;
  const WAVE_WINDOW = 2205; // 0.05s @ 44.1k
  let totalSamples = 0;

  // 无损检测累计量
  const bandEnergySum = new Float64Array(DETECT_BANDS.length); // 各频带累计能量
  let frameCount = 0;
  const hfSeries = [];      // 16-22kHz 每帧能量（时间序列）
  const hf18Series = [];    // 18-22kHz
  const hf20Series = [];    // 20-22kHz
  const midSeries = [];     // 8-12kHz
  const hfSpecSum = new Float64Array(FFT_SIZE / 2); // 16-22kHz 累计谱

  let stderrBuf = '';
  proc.stderr.on('data', d => { stderrBuf += d; if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000); });

  proc.stdout.on('data', (chunk) => {
    byteQueue.push(chunk); queued += chunk.length;
    // 攒够一帧就处理（FFT_SIZE 个 s16 采样 = 8192 字节）
    while (queued >= FFT_SIZE * 2) {
      // 拼出 8192 字节
      const frameBuf = Buffer.concat(byteQueue);
      const consumed = HOP * 2; // 每次前进 HOP 个采样
      processFrame(frameBuf);
      const rest = frameBuf.subarray(consumed);
      byteQueue.length = 0;
      if (rest.length) byteQueue.push(rest);
      queued = rest.length;
    }
  });

  proc.on('error', (err) => {
    if (session.cancelled) return;
    current = null;
    send(win, { type: 'error', gen, message: '无法启动 ffmpeg: ' + err.message });
  });

  proc.on('close', () => {
    if (session.cancelled) return;
    current = null;
    if (frameCount < 10) {
      send(win, { type: 'error', gen, message: '音频分析失败：解码无数据。' + (stderrBuf.trim() ? ' ' + stderrBuf.trim().split('\n').pop() : '') });
      return;
    }
    const wf = downsampleWaveform(waveform, MAX_WAVEFORM_POINTS);
    const lossless = forcedLossless || computeLossless();
    send(win, {
      type: 'done', gen,
      waveform: Float32Array.from(wf),
      durationSec: totalSamples / SAMPLE_RATE,
      lossless,
    });
  });

  function processFrame(buf) {
    const n = FFT_SIZE;
    for (let i = 0; i < n; i++) {
      re[i] = buf.readInt16LE(i * 2) * fftPlan.hann[i];
      im[i] = 0;
    }
    // 波形：按 WAVE_WINDOW 窗口取峰值（帧内覆盖 HOP 个新采样）
    for (let i = 0; i < HOP; i++) {
      const v = Math.abs(buf.readInt16LE(i * 2)) / 32768;
      if (v > waveAccMax) waveAccMax = v;
      if (++waveAcc >= WAVE_WINDOW) { waveform.push(waveAccMax); waveAcc = 0; waveAccMax = 0; }
    }
    totalSamples += HOP;

    fftRadix2(re, im, fftPlan);
    const norm = 2 / (FFT_SIZE * 32768 * 0.5); // Hann 相干增益 0.5 补偿
    for (let i = 0; i < n / 2; i++) mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * norm;

    // 显示帧：log 频带取 max，转 dB 映射 0-255
    const frame = new Uint8Array(SPEC_BANDS);
    for (let b = 0; b < SPEC_BANDS; b++) {
      const [b0, b1] = specBandBins[b];
      let peak = 0;
      for (let i = b0; i <= b1; i++) if (mags[i] > peak) peak = mags[i];
      const db = 20 * Math.log10(peak + 1e-9);
      frame[b] = Math.max(0, Math.min(255, Math.round((db + 85) * 3))); // -85dB..0 → 0..255
    }
    specBatch.push(frame);
    if (++specBatchCount >= FRAME_BATCH) flushSpec();

    // 检测统计
    frameCount++;
    for (let b = 0; b < DETECT_BANDS.length; b++) bandEnergySum[b] += bandAvg(b);
    midSeries.push(bandAvg(2));                                // 8-12kHz
    hfSeries.push((bandAvg(4) + bandAvg(5) + bandAvg(6)) / 3); // 16-22kHz
    hf18Series.push((bandAvg(5) + bandAvg(6)) / 2);            // 18-22kHz
    hf20Series.push(bandAvg(6));                               // 20-22kHz
    for (let i = detectBandBins[4][0]; i <= detectBandBins[6][1]; i++) hfSpecSum[i] += mags[i];
  }

  function bandAvg(b) {
    const [b0, b1] = detectBandBins[b];
    let sum = 0;
    for (let i = b0; i <= b1; i++) sum += mags[i];
    return sum / (b1 - b0 + 1);
  }

  function flushSpec() {
    if (!specBatchCount) return;
    const out = new Uint8Array(specBatchCount * SPEC_BANDS);
    for (let i = 0; i < specBatchCount; i++) out.set(specBatch[i], i * SPEC_BANDS);
    send(win, { type: 'frames', gen, frames: out, count: specBatchCount });
    specBatch = []; specBatchCount = 0;
  }

  function computeLossless() {
    const profile = Array.from(bandEnergySum, e => e / frameCount); // 7 个频带的平均能量
    const midMean = profile[2], highMean = (profile[4] + profile[5] + profile[6]) / 3;
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
    const std = (arr) => { const m = mean(arr); return Math.sqrt(mean(arr.map(v => (v - m) * (v - m)))); };

    // ① 截止检测：相邻频带能量比
    let cutoffIdx = -1, dropRatio = 1;
    for (let i = 0; i < profile.length - 1; i++) {
      const ratio = profile[i] > 1e-12 ? profile[i + 1] / profile[i] : 1;
      if (ratio < 0.3 && ratio < dropRatio) { dropRatio = ratio; cutoffIdx = i; }
    }
    const hasCutoff = cutoffIdx >= 0 && dropRatio < 0.2;
    const cutoffFreq = hasCutoff ? DETECT_BANDS[cutoffIdx][1] / 1000 : 0;
    let sharpness = 0;
    if (cutoffIdx >= 0 && cutoffIdx < profile.length - 1) {
      const below = cutoffIdx > 0 ? profile[cutoffIdx - 1] : profile[cutoffIdx];
      const above = profile[cutoffIdx + 1];
      sharpness = Math.abs((below - profile[cutoffIdx]) / ((profile[cutoffIdx] - above) || 1e-12));
      if (!isFinite(sharpness)) sharpness = 10;
    }

    // ② 16-22kHz 衰减斜率（1kHz 子带，真无损向低频自然抬升，噪声填充则平坦）
    const subE = [];
    for (let f = 16000; f < 22000; f += 1000) {
      const b0 = Math.max(1, Math.round(f / BIN_HZ)), b1 = Math.min(FFT_SIZE / 2 - 1, Math.round((f + 1000) / BIN_HZ));
      let s = 0; for (let i = b0; i <= b1; i++) s += hfSpecSum[i];
      subE.push(s / Math.max(1, b1 - b0 + 1) / frameCount);
    }
    const slopeRatio = subE[0] > 1e-12 ? (subE[0] - subE[subE.length - 1]) / subE[0] : 0;

    // ③ 谐波结构：16-22kHz 平均谱的局部峰值密度 + 变异系数
    const h0 = detectBandBins[4][0], h1 = detectBandBins[6][1];
    const avgSpec = [];
    for (let i = h0; i <= h1; i++) avgSpec.push(hfSpecSum[i] / frameCount);
    const specMean = mean(avgSpec);
    let peaks = 0;
    for (let i = 1; i < avgSpec.length - 1; i++) {
      if (avgSpec[i] > avgSpec[i - 1] && avgSpec[i] > avgSpec[i + 1] && (avgSpec[i] - Math.min(avgSpec[i - 1], avgSpec[i + 1])) > specMean * 0.05) peaks++;
    }
    const peakDensity = peaks / Math.max(1, avgSpec.length);
    const cv = specMean > 1e-12 ? std(avgSpec) / specMean : 0;
    const harmonicScore = Math.min(1, peakDensity * 8 + cv * 0.3);

    // ④ 噪声均匀度
    const noiseUniformity = std(hf20Series) > 0 || std(hf18Series) > 0 ? std(hf20Series) / (std(hf18Series) || 1e-12) : 1;

    // ⑤ 高频时间方差
    const hfMean = mean(hfSeries) || 1e-12;
    let diffSum = 0;
    for (let i = 1; i < hfSeries.length; i++) diffSum += Math.abs(hfSeries[i] - hfSeries[i - 1]);
    const hfTimeVariance = (diffSum / Math.max(1, hfSeries.length - 1)) / hfMean;

    // ⑥ 亮像素占比（高频能量显著超过中频波动阈值的帧比例）
    const midStd = std(midSeries);
    const brightRatio = hfSeries.filter(e => e > midMean + midStd).length / Math.max(1, hfSeries.length);
    const highActive = highMean > 1e-6;

    // 扣分制（V4.0 规则）
    let score = 100;
    const reasons = [];
    if (hasCutoff) { score -= 40; reasons.push(`[-40] 检测到频率截止 @ ${cutoffFreq.toFixed(1)}kHz，相邻频带能量比 ${dropRatio.toFixed(2)}（典型有损编码低通特征）`); }
    if (sharpness > 3.0) { score -= 15; reasons.push(`[-15] 截止边缘过于陡峭（sharpness ${sharpness.toFixed(1)}）`); }
    else if (sharpness > 1.5) { score -= 8; reasons.push(`[-8] 截止边缘较陡峭（sharpness ${sharpness.toFixed(1)}）`); }
    if (slopeRatio < 0.3) { score -= 10; reasons.push(`[-10] 16-22kHz 高频无自然衰减形态（疑似噪声填充）`); }
    else if (slopeRatio < 0.6) { score -= 5; reasons.push(`[-5] 高频衰减形态偏弱`); }
    if (harmonicScore < 0.15) { score -= 10; reasons.push(`[-10] 高频区缺少谐波/泛音结构`); }
    else if (harmonicScore < 0.3) { score -= 5; reasons.push(`[-5] 高频谐波结构偏弱`); }
    if (noiseUniformity < 0.4 && highActive) { score -= 10; reasons.push(`[-10] 20kHz 以上能量过于均匀（疑似填充噪声）`); }
    else if (noiseUniformity < 0.6) { score -= 5; reasons.push(`[-5] 高频噪声均匀度偏高`); }
    if (hfTimeVariance < 0.3 && highActive) { score -= 10; reasons.push(`[-10] 高频能量几乎不随时间变化（静态噪声特征）`); }
    else if (hfTimeVariance < 0.5) { score -= 5; reasons.push(`[-5] 高频时间变化偏弱`); }
    if (brightRatio > 0.15 && highActive) { score -= 5; reasons.push(`[-5] 高频亮区占比异常（疑似升采样伪造）`); }
    score = Math.max(0, Math.min(100, score));

    let verdict, verdictLevel;
    if (score >= 85) { verdict = '真无损'; verdictLevel = 3; }
    else if (score >= 65) { verdict = '大概率真无损'; verdictLevel = 3; }
    else if (score >= 45) { verdict = '轻度嫌疑'; verdictLevel = 2; }
    else if (score >= 25) { verdict = '大概率假无损'; verdictLevel = 1; }
    else { verdict = '假无损'; verdictLevel = 0; }

    return {
      score, verdict, verdictLevel, reasons,
      cutoffFreq, hasCutoff, cutoffSharpness: sharpness,
      harmonicScore: +harmonicScore.toFixed(3),
      noiseUniformity: +noiseUniformity.toFixed(3),
      hfTimeVariance: +hfTimeVariance.toFixed(3),
      slopeRatio: +slopeRatio.toFixed(3),
    };
  }
}

function downsampleWaveform(peaks, maxPoints) {
  if (peaks.length <= maxPoints) return peaks;
  const out = [];
  const stride = peaks.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) {
    let m = 0;
    const s = Math.floor(i * stride), e = Math.min(peaks.length, Math.ceil((i + 1) * stride));
    for (let j = s; j < e; j++) if (peaks[j] > m) m = peaks[j];
    out.push(m);
  }
  return out;
}

function send(win, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send('analyze:event', payload); } catch { }
}

/* ---------------- IPC 注册 ---------------- */
const LOSSY_CODECS = new Set(['mp3', 'aac', 'vorbis', 'opus', 'wmav1', 'wmav2', 'wmapro', 'ogg']);

function register(ipcMain, getWindow) {
  let gen = 0;
  ipcMain.handle('analyze:start', async (_e, input, headers) => {
    const win = getWindow();
    if (!win || !input) return { ok: false };
    const myGen = ++gen;
    // 有损容器格式：探测编码后直接给出预定结论（频谱图仍照常生成供查看）
    const codecInfo = await probeCodec(input, headers);
    if (myGen !== gen) return { ok: false, reason: 'superseded' };
    let forcedLossless = null;
    if (codecInfo && LOSSY_CODECS.has(codecInfo.codec)) {
      forcedLossless = {
        score: 0, verdict: '有损压缩格式', verdictLevel: 0,
        reasons: [`源文件编码为 ${codecInfo.codec.toUpperCase()}，属于有损压缩格式，无需频谱检测`],
        codec: codecInfo.codec, formatShortcut: true,
      };
    }
    startAnalyze(win, input, headers, myGen, forcedLossless);
    return { ok: true, gen: myGen, codec: codecInfo };
  });
  ipcMain.handle('analyze:cancel', () => { gen++; cancelAnalyze(); return { ok: true }; });
}

module.exports = { register };
