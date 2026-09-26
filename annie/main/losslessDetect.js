'use strict';
/* 无损真伪鉴别核心（主进程，V4.0.5）
 * 检测方法移植自 UltraMusicTestTool（github.com/Zhou1019-1/UltraMusicTestTool，同作者 Python 版）：
 *   ① 频谱截止检测（权重 0.35）：有损编码器砖墙低通 vs 真录音自然滚降
 *   ② 编码帧痕迹检测（0.25）：MP3/AAC/Opus 固定帧长在高频短时能量上的周期调制残留
 *   ③ 位深量化分析（0.15）：16bit→24bit 假 Hi-Res 的低位恒零（位空洞）
 *   ④ 采样率上转换检测（0.25）：44.1k/48k→96k/192k 假 Hi-Res 带宽精确止步于源 Nyquist
 * 加权融合（权重×置信度）+ 决定性证据盖帽 → 五级判定（同 Spek V4.0 分级）。
 *
 * 管线：ffprobe 探测 → ffmpeg 以【原生采样率 + 原生位深整型】流式解码 →
 * 三路 STFT 累计器（8192/512/16384 点）+ 位深末尾零统计，全程流式不缓存整轨 PCM。
 * 分析时长按采样率封顶（>=176.4k:60s / >=88.2k:90s / 其他:180s）。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/* ---------------- 工具链定位（与 analyzer.js 一致的三路径） ---------------- */
function resolveTool(name) {
  const prod = path.join(process.resourcesPath || '', 'engine', 'tools', name);
  const dev = path.join(__dirname, '..', 'engine', 'tools', name);
  const devRoot = path.join(__dirname, '..', '..', 'engine', 'tools', name);
  for (const p of [prod, dev, devRoot]) { try { if (fs.existsSync(p)) return p; } catch { } }
  return name;
}

/* ---------------- FFT（迭代 radix-2，与 analyzer.js 同款实现） ---------------- */
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
  const hann = new Float64Array(size); // 与 scipy 'hann' 对称窗一致
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

/* STFT 流式累计器：逐帧 Hann 加窗 FFT，回调输出 |X|²（半谱，size/2 个 bin） */
const fftPlans = new Map();
function getPlan(size) {
  if (!fftPlans.has(size)) fftPlans.set(size, makeFft(size));
  return fftPlans.get(size);
}
class StftFeeder {
  constructor(size, hop, onFrame) {
    this.size = size; this.hop = hop; this.onFrame = onFrame;
    this.plan = getPlan(size);
    this.carry = new Float64Array(size); // 未凑满一帧的遗留采样
    this.carryLen = 0;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.frames = 0;
  }
  /* samples: Float64Array（单声道浮点） */
  feed(samples) {
    let off = 0;
    while (off < samples.length) {
      const need = this.size - this.carryLen;
      const take = Math.min(need, samples.length - off);
      this.carry.set(samples.subarray(off, off + take), this.carryLen);
      this.carryLen += take; off += take;
      if (this.carryLen === this.size) {
        const { re, im, plan } = this;
        for (let i = 0; i < this.size; i++) { re[i] = this.carry[i] * plan.hann[i]; im[i] = 0; }
        fftRadix2(re, im, plan);
        this.onFrame(re, im);
        this.frames++;
        // 滑动 hop：保留尾部 size-hop
        this.carry.copyWithin(0, this.hop);
        this.carryLen = this.size - this.hop;
      }
    }
  }
}

/* ---------------- 容器探测 ---------------- */
const LOSSY_CODECS = new Set(['mp3', 'aac', 'vorbis', 'opus', 'wmav1', 'wmav2', 'wmapro', 'ogg']);

function probe(input, headers) {
  return new Promise((resolve) => {
    const args = ['-v', 'error'];
    if (/^https?:\/\//i.test(input)) {
      args.push('-timeout', '15000000');
      if (headers) args.push('-headers', headers);
    }
    args.push('-show_entries', 'stream=codec_name,sample_rate,bits_per_sample,bits_per_raw_sample,channels:format=format_name',
      '-of', 'json', input);
    let out = '';
    const proc = spawn(resolveTool('ffprobe.exe'), args, { windowsHide: true });
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      try {
        const j = JSON.parse(out);
        const s = (j.streams || []).find(x => x.sample_rate);
        if (!s) { resolve(null); return; }
        resolve({
          codec: s.codec_name || '',
          formatName: (j.format && j.format.format_name) || '',
          sampleRate: Number(s.sample_rate) || 0,
          channels: Number(s.channels) || 2,
          bitsRaw: Number(s.bits_per_raw_sample) || 0,
          bits: Number(s.bits_per_sample) || 0,
        });
      } catch { resolve(null); }
    });
  });
}

/* ---------------- 平滑 / 统计小工具（对齐 numpy 语义） ---------------- */
// np.convolve(x, ones(win)/win, 'same')：零填充、始终除以 win
function smoothSame(x, win) {
  const n = x.length, h = (win - 1) / 2, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < win; k++) {
      const j = i - h + k;
      if (j >= 0 && j < n) s += x[j];
    }
    out[i] = s / win;
  }
  return out;
}
function variance(x) {
  const n = x.length; if (!n) return 0;
  let m = 0; for (let i = 0; i < n; i++) m += x[i]; m /= n;
  let v = 0; for (let i = 0; i < n; i++) { const d = x[i] - m; v += d * d; }
  return v / n;
}
// 频带 [a,b) 对应的 bin 区间（bin i 频率 = i*bw）
function bandBins(a, b, bw, maxBin) {
  const i0 = Math.max(0, Math.ceil(a / bw - 1e-9));
  const i1 = Math.min(maxBin, Math.ceil(b / bw - 1e-9)); // 半开
  return i1 > i0 ? [i0, i1] : null;
}
function bandMean(arr, i0, i1) { let s = 0; for (let i = i0; i < i1; i++) s += arr[i]; return s / (i1 - i0); }

/* ---------------- 主流程 ---------------- */
const GRADE_TABLE = [
  [85, '真无损', 3, '频谱形态自然，未检测到转码痕迹'],
  [65, '大概率真无损', 3, '整体自然，存在极轻微异常（可能是音乐风格或母带特性）'],
  [45, '轻度嫌疑', 2, '部分指标异常，建议结合耳听判断'],
  [25, '大概率假无损', 1, '多项指标符合有损转码/上转换特征'],
  [0, '假无损', 0, '强烈疑似有损→无损转码或假 Hi-Res'],
];
const WEIGHTS = { cutoff: 0.35, codec: 0.25, bitdepth: 0.15, upsampling: 0.25 };
// 编码帧周期候选（采样点），对齐 UltraMusicTestTool
const FRAME_CANDIDATES = [['MP3帧(1152)', 1152], ['MP3颗粒(576)', 576], ['AAC帧(1024)', 1024], ['Opus帧(960)', 960]];
const SOURCE_NYQUISTS = [22050, 24000, 32000, 16000];

/**
 * 检测单个文件。返回 { done: Promise<result|null>, cancel() }。
 * result: { score, verdict, verdictLevel, reasons, methods, cutoffFreq, hasCutoff,
 *           container:{codec,sampleRate,bitDepth,channels}, durationAnalyzed, profileDb,
 *           lossyContainer? } —— 字段兼容旧 viz 报告（score/verdict/verdictLevel/reasons/cutoffFreq）。
 * opts: { maxSec, headers, timeoutMs }
 */
function detectLossless(input, opts) {
  opts = opts || {};
  let killed = false;
  let proc = null;
  const done = (async () => {
    const info = await probe(input, opts.headers);
    if (!info || !info.sampleRate) return null;
    const sr = info.sampleRate;
    const nyq = sr / 2;
    const isDsd = /^dsd/i.test(info.codec) || /dsf/i.test(info.formatName);
    const isFloat = /^pcm_f/.test(info.codec);
    const bits = info.bitsRaw || info.bits;
    // 有损容器：无需频谱检测（伪装无损扩展名的由调用方按 verdict 处理）
    if (LOSSY_CODECS.has(info.codec)) {
      return {
        lossyContainer: true,
        score: 0, verdict: '有损压缩格式', verdictLevel: 0,
        reasons: ['源文件编码为 ' + info.codec.toUpperCase() + '，属于有损压缩格式，无需频谱检测'],
        methods: [], container: { codec: info.codec, sampleRate: sr, bitDepth: bits, channels: info.channels },
      };
    }
    // 整型输出格式：仅在能还原容器真实位深时使用（浮点 PCM 位深检测无意义）
    const intFmt = (!isFloat && !isDsd && bits >= 16)
      ? (bits <= 16 ? 's16le' : bits <= 24 ? 's24le' : 's32le') : null;
    const intBits = intFmt ? (bits <= 16 ? 16 : bits <= 24 ? 24 : 32) : 0;
    const ch = Math.min(Math.max(info.channels || 2, 1), 8);
    const maxSec = opts.maxSec || (sr >= 176400 ? 60 : sr >= 88200 ? 90 : 180);

    /* ---- 累计器状态 ---- */
    // ① 频谱截止（8192@sr>=44100 否则 4096，hop=size/4）
    const cutSize = sr >= 44100 ? 8192 : 4096;
    const cutBw = sr / cutSize;
    const cutSumPower = new Float64Array(cutSize / 2);
    // 截止之上时间变化：逐帧 1kHz 带能量（10k ~ nyq）
    const bandStarts = [];
    for (let f = 10000; f + 1000 <= nyq + 1; f += 1000) bandStarts.push(f);
    const cutBandFrames = []; // 每帧 Float64Array(bandStarts.length)
    // ② 编码帧痕迹（512，hop 128）——sr<32000 不适用
    const codecOk = sr >= 32000;
    const hfHi = Math.min(20000, nyq * 0.95);
    const hfMaskBins = [];
    if (codecOk) {
      const bw512 = sr / 512;
      let r = bandBins(12000, hfHi, bw512, 256);
      if (!r) r = bandBins(nyq * 0.5, nyq, bw512, 256);
      if (r) for (let i = r[0]; i < r[1]; i++) hfMaskBins.push(i);
    }
    const hfSeries = [];
    const hfBinPower = new Float64Array(256); // 谱平坦度：逐 bin 时间累计
    // ②b 联合立体声：side/mid 1024 hop 256，带 10k~min(18k, nyq*0.9)
    const stereo = ch === 2;
    let smBand = null, sideE = 0, midE = 0;
    if (stereo && codecOk) smBand = bandBins(10000, Math.min(18000, nyq * 0.9), sr / 1024, 512);
    // ④ 上转换（16384，hop 4096）——仅 Hi-Res
    const upOk = sr >= 88200;
    const upSumPower = upOk ? new Float64Array(16384 / 2) : null;
    // ③ 位深：末尾零统计（tzGe[k] = 非零样本中 tz>=k 的数量）
    const bdOk = !!intFmt;
    const tzGe = bdOk ? new Float64Array(intBits + 1) : null;
    let nzSamples = 0;

    /* ---- 帧回调 ---- */
    const cutFeeder = new StftFeeder(cutSize, cutSize / 4, (re, im) => {
      for (let i = 0; i < cutSize / 2; i++) cutSumPower[i] += re[i] * re[i] + im[i] * im[i];
      const be = new Float64Array(bandStarts.length);
      for (let b = 0; b < bandStarts.length; b++) {
        const r = bandBins(bandStarts[b], bandStarts[b] + 1000, cutBw, cutSize / 2);
        if (!r) continue;
        let s = 0;
        for (let i = r[0]; i < r[1]; i++) s += re[i] * re[i] + im[i] * im[i];
        be[b] = s / (r[1] - r[0]);
      }
      cutBandFrames.push(be);
    });
    const codecFeeder = codecOk ? new StftFeeder(512, 128, (re, im) => {
      let s = 0;
      for (const i of hfMaskBins) { const p = re[i] * re[i] + im[i] * im[i]; s += p; hfBinPower[i] += p; }
      hfSeries.push(s / Math.max(1, hfMaskBins.length));
    }) : null;
    const midFeeder = (stereo && smBand) ? new StftFeeder(1024, 256, (re, im) => {
      for (let i = smBand[0]; i < smBand[1]; i++) midE += re[i] * re[i] + im[i] * im[i];
    }) : null;
    const sideFeeder = (stereo && smBand) ? new StftFeeder(1024, 256, (re, im) => {
      for (let i = smBand[0]; i < smBand[1]; i++) sideE += re[i] * re[i] + im[i] * im[i];
    }) : null;
    const upFeeder = upOk ? new StftFeeder(16384, 4096, (re, im) => {
      for (let i = 0; i < 8192; i++) upSumPower[i] += re[i] * re[i] + im[i] * im[i];
    }) : null;

    /* ---- ffmpeg 原生解码（流式） ---- */
    await new Promise((resolve) => {
      const args = ['-v', 'error', '-nostdin'];
      if (/^https?:\/\//i.test(input)) {
        args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000');
        if (opts.headers) args.push('-headers', opts.headers);
      }
      args.push('-i', input, '-t', String(maxSec), '-f', intFmt || 'f32le', '-acodec', 'pcm_' + (intFmt || 'f32le'), 'pipe:1');
      proc = spawn(resolveTool('ffmpeg.exe'), args, { windowsHide: true });
      const killer = setTimeout(() => { try { proc.kill(); } catch { } }, opts.timeoutMs || 180000);

      const bps = intFmt ? intBits / 8 : 4;
      const frameBytes = ch * bps;
      const invScale = intFmt ? 1 / (1 << (intBits - 1)) : 1;
      let pending = Buffer.alloc(0);

      proc.stdout.on('data', (chunk) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        const nFrames = Math.floor(pending.length / frameBytes);
        if (!nFrames) return;
        const mono = new Float64Array(nFrames);
        const side = (stereo && sideFeeder) ? new Float64Array(nFrames) : null;
        for (let f = 0; f < nFrames; f++) {
          const base = f * frameBytes;
          let sum = 0, c0 = 0, c1 = 0;
          for (let c = 0; c < ch; c++) {
            const o = base + c * bps;
            let v;
            if (!intFmt) v = pending.readFloatLE(o);
            else if (bps === 2) v = pending.readInt16LE(o);
            else if (bps === 3) { v = pending[o] | (pending[o + 1] << 8) | (pending[o + 2] << 16); if (v >= 8388608) v -= 16777216; }
            else v = pending.readInt32LE(o);
            // 位深统计：整型域末尾零（逐样本，全声道）
            if (bdOk) {
              const a = Math.abs(v);
              if (a > 0) {
                nzSamples++;
                let t = 0, tmp = a;
                while (t < intBits && (tmp & 1) === 0) { t++; tmp >>= 1; }
                for (let k = 1; k <= t; k++) tzGe[k]++;
              }
            }
            const fv = intFmt ? v * invScale : v;
            if (c === 0) c0 = fv; else if (c === 1) c1 = fv;
            sum += fv;
          }
          mono[f] = sum / ch;
          if (side) side[f] = 0.5 * (c0 - c1);
        }
        pending = pending.slice(nFrames * frameBytes);
        cutFeeder.feed(mono);
        if (codecFeeder) codecFeeder.feed(mono);
        if (midFeeder) midFeeder.feed(mono); // mid = 0.5(L+R) 与 mono 同形，能量比例不变
        if (sideFeeder) sideFeeder.feed(side);
        if (upFeeder) upFeeder.feed(mono);
      });
      proc.on('error', () => { clearTimeout(killer); resolve(); });
      proc.on('close', () => { clearTimeout(killer); resolve(); });
    });
    proc = null;
    if (killed) return null;
    const framesAnalyzed = cutFeeder.frames;
    if (framesAnalyzed < 8) return null; // 数据太少无法判定
    const durationAnalyzed = framesAnalyzed * (cutSize / 4) / sr;

    /* ================ 方法①：频谱截止检测 ================ */
    function methodCutoff() {
      const na = { id: 'cutoff', name: '频谱截止检测', applicable: false, score: 100, confidence: 1, summary: '不适用：音频过短 (<1s)', deductions: [], metrics: {} };
      const power = new Float64Array(cutSize / 2);
      let peak = 0;
      for (let i = 0; i < power.length; i++) {
        power[i] = 10 * Math.log10(Math.max(cutSumPower[i] / framesAnalyzed, 1e-20));
        if (power[i] > peak) peak = power[i];
      }
      for (let i = 0; i < power.length; i++) power[i] -= peak; // 峰值归一 0dB
      const win = Math.max(3, Math.round(200 / cutBw) | 1);
      const dbs = smoothSame(power, win);

      const band = 2000, step = 100;
      const loF = 10000, hiF = nyq - 1000;
      let best = null;
      for (let f = loF; f <= hiF; f += step) {
        const rLo = bandBins(f - band, f, cutBw, cutSize / 2);
        const rHi = bandBins(f, f + band, cutBw, cutSize / 2);
        if (!rLo || !rHi) continue;
        const lo = bandMean(dbs, rLo[0], rLo[1]);
        const hi = bandMean(dbs, rHi[0], rHi[1]);
        const drop = lo - hi;
        if (!best || drop > best.drop) best = { f, drop, lo, hi };
      }
      if (!best) return na;
      const cutoffHz = best.f, dropDb = best.drop, hiDb = best.hi;
      const sharpness = dropDb / (band / 1000);
      // 截止之上逐帧能量变异系数（1kHz 带近似）
      let aboveVar = 0;
      const aboveIdx = [];
      for (let b = 0; b < bandStarts.length; b++) if (bandStarts[b] >= cutoffHz) aboveIdx.push(b);
      if (aboveIdx.length) {
        const series = new Float64Array(cutBandFrames.length);
        for (let t = 0; t < cutBandFrames.length; t++) {
          let s = 0;
          for (const b of aboveIdx) s += cutBandFrames[t][b];
          series[t] = s / aboveIdx.length;
        }
        let m = 0; for (let i = 0; i < series.length; i++) m += series[i];
        m /= series.length;
        if (m > 0) aboveVar = Math.sqrt(variance(series)) / (m + 1e-20);
      }
      const hfRef = bandBins(16000, Math.min(20000, nyq), cutBw, cutSize / 2);
      const hfLevel = hfRef ? bandMean(dbs, hfRef[0], hfRef[1]) : -120;

      let score = 100;
      const deductions = [];
      const cutoffKhz = cutoffHz / 1000;
      const relCutoff = cutoffHz / nyq;
      const hasBrickwall = dropDb >= 25 && sharpness >= 12 && hiDb <= -40;
      const hasCutoff = dropDb >= 15 && sharpness >= 6 && hiDb <= -35;
      if (hasBrickwall) {
        deductions.push([45, '检测到砖墙式频率截止 @ ' + cutoffKhz.toFixed(1) + 'kHz（对比度 ' + dropDb.toFixed(0) + 'dB，斜率 ' + sharpness.toFixed(0) + 'dB/kHz），典型有损低通滤波器特征']);
      } else if (hasCutoff) {
        if (relCutoff > 0.93) deductions.push([8, 'Nyquist 附近存在能量下降 @ ' + cutoffKhz.toFixed(1) + 'kHz，可能是抗混叠滤波或自然滚降']);
        else deductions.push([25, '检测到明显频率截止 @ ' + cutoffKhz.toFixed(1) + 'kHz（对比度 ' + dropDb.toFixed(0) + 'dB），疑似有损转码']);
      }
      if (cutoffKhz < 16.5 && hasCutoff) deductions.push([10, '截止频率极低（' + cutoffKhz.toFixed(1) + 'kHz < 16.5kHz），符合低码率 MP3（≤128kbps）转码特征']);
      else if (cutoffKhz < 19 && hasCutoff) deductions.push([5, '截止频率偏低（' + cutoffKhz.toFixed(1) + 'kHz），符合中等码率有损编码特征']);
      if (hfLevel < -55 && nyq >= 22000) deductions.push([10, '16-20kHz 频段平均电平极低（' + hfLevel.toFixed(0) + 'dB），缺乏真实高频内容']);
      if (hasCutoff && aboveVar < 0.25) deductions.push([10, '截止频率以上区域无音乐性时间变化（变异系数 ' + aboveVar.toFixed(2) + '），疑似空带/静态噪声']);
      for (const d of deductions) score -= d[0];
      score = Math.max(0, Math.min(100, score));
      return {
        id: 'cutoff', name: '频谱截止检测', applicable: true, score,
        confidence: durationAnalyzed > 5 ? 0.9 : 0.6,
        summary: hasBrickwall ? '砖墙截止 @ ' + cutoffKhz.toFixed(1) + 'kHz，强烈疑似有损转码'
          : hasCutoff ? '存在频率截止 @ ' + cutoffKhz.toFixed(1) + 'kHz，有转码嫌疑' : '未检测到低通滤波器截止特征',
        deductions,
        metrics: {
          cutoff_khz: +cutoffKhz.toFixed(2), contrast_db: +dropDb.toFixed(1),
          sharpness_db_per_khz: +sharpness.toFixed(1), hf_16_20k_level_db: +hfLevel.toFixed(1),
          above_cutoff_time_cv: +aboveVar.toFixed(2),
        },
        _hasCutoff: hasCutoff || hasBrickwall,
      };
    }

    /* ================ 方法②：编码帧痕迹检测 ================ */
    function methodCodec() {
      const na = (why) => ({ id: 'codec', name: '编码帧痕迹检测', applicable: false, score: 100, confidence: 1, summary: '不适用：' + why, deductions: [], metrics: {} });
      if (!codecOk) return na('采样率过低');
      if (durationAnalyzed < 3) return na('时长不足 (<3s)');
      // 高频短时能量序列去慢包络
      const e = Float64Array.from(hfSeries);
      const slow = smoothSame(e, 64);
      for (let i = 0; i < e.length; i++) e[i] -= slow[i];
      for (let i = 0; i < 32 && i < e.length; i++) { e[i] = 0; e[e.length - 1 - i] = 0; }
      const totalVar = variance(e) + 1e-20;
      let bestPeriod = null, bestStrength = 0;
      for (const [label, periodSamples] of FRAME_CANDIDATES) {
        const pHops = Math.max(2, Math.round(periodSamples / 128));
        const nEpochs = Math.floor(e.length / pHops);
        if (nEpochs < 24) continue;
        const pattern = new Float64Array(pHops);
        for (let ep = 0; ep < nEpochs; ep++) {
          const base = ep * pHops;
          for (let j = 0; j < pHops; j++) pattern[j] += e[base + j];
        }
        for (let j = 0; j < pHops; j++) pattern[j] /= nEpochs;
        const strength = variance(pattern) / totalVar;
        if (strength > bestStrength) { bestStrength = strength; bestPeriod = label; }
      }
      // 高频谱平坦度：逐 bin 时间平均功率的几何/算术均值比
      let logSum = 0, arithSum = 0, bn = 0;
      for (const i of hfMaskBins) {
        const p = hfBinPower[i] / Math.max(1, codecFeeder.frames) + 1e-30;
        logSum += Math.log(p); arithSum += p; bn++;
      }
      const flatness = bn ? Math.exp(logSum / bn) / (arithSum / bn) : 0;
      // 联合立体声 Side/Mid 高频能量比
      const sideMid = (stereo && smBand && midFeeder.frames > 0 && midE > 0) ? sideE / (midE + 1e-20) : null;

      let score = 100;
      const deductions = [];
      if (bestStrength >= 0.35) deductions.push([30, '高频能量存在强周期性调制（强度 ' + bestStrength.toFixed(2) + '），周期与 ' + bestPeriod + ' 吻合，典型有损编码帧残留']);
      else if (bestStrength >= 0.20) deductions.push([15, '高频能量存在周期性波动（强度 ' + bestStrength.toFixed(2) + '，接近 ' + bestPeriod + '），有编码帧痕迹嫌疑']);
      if (flatness >= 0.25) deductions.push([10, '高频段谱平坦度过高（' + flatness.toFixed(2) + '），接近白噪声特征，疑似量化噪声填充']);
      if (sideMid !== null && sideMid < 0.02) deductions.push([10, '高频段 Side/Mid 能量比极低（' + sideMid.toFixed(4) + '），符合 Joint Stereo 有损编码的高频合并特征']);
      for (const d of deductions) score -= d[0];
      score = Math.max(0, Math.min(100, score));
      return {
        id: 'codec', name: '编码帧痕迹检测', applicable: true, score, confidence: 0.8,
        summary: '帧周期痕迹强度 ' + bestStrength.toFixed(2) + (bestPeriod ? '（' + bestPeriod + '）' : '') + (deductions.length ? '，检测到编码残留' : '，未见明显编码残留'),
        deductions,
        metrics: {
          frame_periodicity: +bestStrength.toFixed(3), matched_period: bestPeriod || '无',
          hf_spectral_flatness: +flatness.toFixed(3),
          hf_side_mid_ratio: sideMid === null ? '单声道' : +sideMid.toFixed(4),
        },
      };
    }

    /* ================ 方法③：位深量化分析 ================ */
    function methodBitdepth() {
      const na = (why) => ({ id: 'bitdepth', name: '位深量化分析', applicable: false, score: 100, confidence: 1, summary: '不适用：' + why, deductions: [], metrics: {} });
      if (isDsd) return na('DSD 为 1bit 流，位深检测不适用');
      if (isFloat) return na('浮点 PCM 无固定位深');
      if (!bdOk) return na('位深不足 16bit 或未知');
      if (!nzSamples) return na('全静音文件');
      const fracGe = (k) => tzGe[k] / nzSamples;
      let kMax = 0;
      for (let k = 1; k < intBits; k++) { if (fracGe(k) > 0.99) kMax = k; else break; }
      const effectiveBits = intBits - kMax;
      let score = 100;
      const deductions = [];
      if (intBits >= 24) {
        if (kMax >= 8) deductions.push([45, '声明 24bit 但 ' + (fracGe(8) * 100).toFixed(1) + '% 样本的低 8 位恒为 0，实际有效位深仅 ~' + effectiveBits + 'bit，典型 16bit→24bit 假 Hi-Res 上转换']);
        else if (kMax >= 4) deductions.push([20, '24bit 文件低 ' + kMax + ' 位几乎恒为 0（有效位深 ~' + effectiveBits + 'bit），可能经过低精度源上转换']);
      } else if (intBits === 16) {
        if (effectiveBits <= 12) deductions.push([15, '16bit 文件有效位深仅 ~' + effectiveBits + 'bit（' + (fracGe(4) * 100).toFixed(1) + '% 样本低4位为0），疑似低精度源或重度数字处理']);
      }
      for (const d of deductions) score -= d[0];
      score = Math.max(0, Math.min(100, score));
      return {
        id: 'bitdepth', name: '位深量化分析', applicable: true, score, confidence: 0.85,
        summary: '有效位深 ~' + effectiveBits + 'bit / 声明 ' + intBits + 'bit' + (deductions.length ? '，存在位空洞' : '，位深利用正常'),
        deductions,
        metrics: { claimed_bits: intBits, effective_bits: effectiveBits, trailing_zero_bits: kMax, lsb_zero_fraction: +fracGe(1).toFixed(4) },
      };
    }

    /* ================ 方法④：采样率上转换检测 ================ */
    function methodUpsampling() {
      const na = (why) => ({ id: 'upsampling', name: '采样率上转换检测', applicable: false, score: 100, confidence: 1, summary: '不适用：' + why, deductions: [], metrics: {} });
      if (!upOk) return na('采样率 ' + sr + 'Hz < 88.2kHz，非 Hi-Res 无需检测');
      if (durationAnalyzed < 1) return na('时长不足 (<1s)');
      const n = 16384 / 2;
      const bw = sr / 16384;
      const power = new Float64Array(n);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        power[i] = 10 * Math.log10(Math.max(upSumPower[i] / Math.max(1, upFeeder.frames), 1e-20));
        if (power[i] > peak) peak = power[i];
      }
      for (let i = 0; i < n; i++) power[i] -= peak;
      const win = Math.max(3, Math.round(200 / bw) | 1);
      const dbs = smoothSame(power, win);

      let detectedSrc = null, dropDb = 0;
      const half = 1500;
      for (const srcNyq of SOURCE_NYQUISTS) {
        if (srcNyq + half >= nyq) continue;
        const rLo = bandBins(srcNyq - half, srcNyq, bw, n);
        const rHi = bandBins(srcNyq, srcNyq + half, bw, n);
        if (!rLo || !rHi) continue;
        const drop = bandMean(dbs, rLo[0], rLo[1]) - bandMean(dbs, rHi[0], rHi[1]);
        if (drop > dropDb) { dropDb = drop; detectedSrc = srcNyq; }
      }
      let score = 100;
      const deductions = [];
      if (dropDb >= 20 && detectedSrc !== null) {
        deductions.push([40, '在 ' + (detectedSrc / 1000).toFixed(2) + 'kHz 处检测到能量陡降（' + dropDb.toFixed(0) + 'dB），精确对应 ' + (detectedSrc * 2 / 1000).toFixed(1) + 'kHz 源采样率 Nyquist，典型低采样率→' + (sr / 1000).toFixed(0) + 'kHz 上转换']);
      } else if (dropDb >= 12 && detectedSrc !== null) {
        deductions.push([15, '在 ' + (detectedSrc / 1000).toFixed(2) + 'kHz 附近存在能量下降（' + dropDb.toFixed(0) + 'dB），可能经过采样率转换']);
      }
      // 镜像混叠（劣质 SRC 特征）：fc 上下对称频带相关性
      let mirrorCorr = 0;
      if (detectedSrc !== null && detectedSrc + 3000 < nyq) {
        const mLo = bandBins(detectedSrc - 3000, detectedSrc - 200, bw, n);
        const mHi = bandBins(detectedSrc + 200, detectedSrc + 3000, bw, n);
        if (mLo && mHi && mLo[1] - mLo[0] > 4 && mHi[1] - mHi[0] > 4) {
          const cnt = Math.min(mLo[1] - mLo[0], mHi[1] - mHi[0]);
          const a = new Float64Array(cnt), b = new Float64Array(cnt);
          let ma = 0, mb = 0;
          for (let i = 0; i < cnt; i++) { a[i] = dbs[mLo[1] - 1 - i]; b[i] = dbs[mHi[0] + i]; ma += a[i]; mb += b[i]; }
          ma /= cnt; mb /= cnt;
          let sab = 0, saa = 0, sbb = 0;
          for (let i = 0; i < cnt; i++) { const da = a[i] - ma, db2 = b[i] - mb; sab += da * db2; saa += da * da; sbb += db2 * db2; }
          const denom = Math.sqrt(saa * sbb);
          if (denom > 1e-12) mirrorCorr = sab / denom;
        }
        if (mirrorCorr >= 0.7) deductions.push([10, '源 Nyquist 两侧频谱镜像相关 ' + mirrorCorr.toFixed(2) + '，存在重采样镜像混叠痕迹']);
      }
      const uhfBand = bandBins(24000, Math.min(40000, nyq * 0.95), bw, n);
      const uhfLevel = uhfBand ? bandMean(dbs, uhfBand[0], uhfBand[1]) : -120;
      if (uhfLevel < -60 && !deductions.length) deductions.push([10, '24kHz 以上频段平均电平 ' + uhfLevel.toFixed(0) + 'dB，缺乏超高频内容，高采样率无实际信息收益']);
      for (const d of deductions) score -= d[0];
      score = Math.max(0, Math.min(100, score));
      return {
        id: 'upsampling', name: '采样率上转换检测', applicable: true, score, confidence: 0.85,
        summary: (detectedSrc !== null && dropDb >= 12) ? '疑似源采样率 ' + (detectedSrc * 2 / 1000).toFixed(1) + 'kHz 上转换' : '未发现采样率上转换特征',
        deductions,
        metrics: {
          samplerate_khz: +(sr / 1000).toFixed(1),
          suspected_source_nyquist_khz: detectedSrc ? +(detectedSrc / 1000).toFixed(2) : '无',
          edge_drop_db: +dropDb.toFixed(1), mirror_correlation: +mirrorCorr.toFixed(2),
          uhf_24k_level_db: +uhfLevel.toFixed(1),
        },
      };
    }

    /* ================ 融合判定（含决定性证据盖帽） ================ */
    const methods = [methodCutoff(), methodCodec(), methodBitdepth(), methodUpsampling()];
    let totalW = 0, acc = 0;
    for (const r of methods) {
      if (!r.applicable) continue;
      const w = (WEIGHTS[r.id] || 1) * Math.max(0.2, r.confidence);
      acc += r.score * w; totalW += w;
    }
    let score = totalW > 0 ? acc / totalW : 50;
    for (const r of methods) {
      if (!r.applicable || r.confidence < 0.75) continue;
      if (r.score <= 40) score = Math.min(score, 45);       // 强证据 → 最多"轻度嫌疑"下沿
      else if (r.score <= 55) score = Math.min(score, 64);  // 明确异常 → 最多"轻度嫌疑"
      else if (r.score <= 65) score = Math.min(score, 74);
    }
    score = Math.max(0, Math.min(100, score));
    score = Math.round(score * 10) / 10;
    let verdict = GRADE_TABLE[GRADE_TABLE.length - 1][1], verdictLevel = 0, detail = GRADE_TABLE[GRADE_TABLE.length - 1][3];
    for (const [th, g, lv, dt] of GRADE_TABLE) {
      if (score >= th) { verdict = g; verdictLevel = lv; detail = dt; break; }
    }
    // 兼容字段：报告理由列表（方法名前缀）+ 截止频率（viz 报告显示用）
    const reasons = [];
    for (const m of methods) {
      if (!m.applicable) { reasons.push('【' + m.name + '】' + m.summary); continue; }
      if (!m.deductions.length) reasons.push('【' + m.name + '】' + m.summary + '（' + m.score.toFixed(0) + '/100）');
      for (const [pts, text] of m.deductions) reasons.push('【' + m.name + '】[-' + pts + '] ' + text);
    }
    reasons.push('综合得分 ' + score + '/100：' + detail);
    const cutM = methods[0];
    return {
      score, verdict, verdictLevel, reasons, methods,
      cutoffFreq: cutM.metrics.cutoff_khz || 0,
      hasCutoff: !!cutM._hasCutoff,
      container: { codec: info.codec, sampleRate: sr, bitDepth: bdOk ? intBits : bits, channels: ch },
      durationAnalyzed: Math.round(durationAnalyzed * 10) / 10,
      // 粗粒度归一化频谱剖面（报告条形图用；取截止方法的平均谱，log 24 带）
      profileDb: (() => {
        const bands = 24, out = [];
        const logMin = Math.log10(1000), logMax = Math.log10(nyq);
        for (let b = 0; b < bands; b++) {
          const f0 = Math.pow(10, logMin + (logMax - logMin) * (b / bands));
          const f1 = Math.pow(10, logMin + (logMax - logMin) * ((b + 1) / bands));
          const r = bandBins(f0, f1, cutBw, cutSize / 2);
          if (!r) { out.push(-120); continue; }
          let s = 0;
          for (let i = r[0]; i < r[1]; i++) s += cutSumPower[i];
          out.push(s);
        }
        const mx = Math.max(...out, 1e-20);
        return out.map(v => Math.round(10 * Math.log10(Math.max(v / mx, 1e-12)) * 10) / 10);
      })(),
    };
  })();

  return {
    done,
    cancel() { killed = true; try { if (proc) proc.kill(); } catch { } },
  };
}

module.exports = { detectLossless, LOSSY_CODECS };
