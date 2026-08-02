'use strict';
/* Pro beat0.0.1：假无损批量检测。
 * 原理：ffmpeg 解码 44.1kHz 单声道 PCM → Goertzel 计算多个高频点能量，
 * 与宽带能量对比得到频谱截止频率；16/18kHz 一刀切为典型有损转制特征。
 * 批量任务后台逐轨执行，进度事件推送 + 可取消，不阻塞 UI 与播放。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveFfmpeg() {
  const prod = path.join(process.resourcesPath || '', 'engine', 'tools', 'ffmpeg.exe');
  const dev = path.join(__dirname, '..', 'engine', 'tools', 'ffmpeg.exe');
  for (const p of [prod, dev]) { try { if (fs.existsSync(p)) return p; } catch { } }
  return 'ffmpeg.exe';
}

const RATE = 44100;
const PROBES = [15000, 16000, 17000, 18000, 19000, 20000, 21000]; // 探测频点（Hz）

/* Goertzel 单频点能量累加器 */
function goertzel(freq) {
  const w = 2 * Math.PI * freq / RATE;
  const coeff = 2 * Math.cos(w);
  let q0 = 0, q1 = 0, q2 = 0, n = 0;
  return {
    add(x) { q0 = coeff * q1 - q2 + x; q2 = q1; q1 = q0; n++; },
    power() { return n > 0 ? (q1 * q1 + q2 * q2 - coeff * q1 * q2) / (n * n) : 0; }
  };
}

/* 分析单轨：返回 { cutoff, verdict, reason, bands } 或 null */
function analyzeTrack(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(resolveFfmpeg(), [
        '-hide_banner', '-v', 'error', '-nostdin',
        '-i', filePath, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'
      ], { windowsHide: true });
    } catch { resolve(null); return; }

    const gs = PROBES.map(goertzel);
    let broadSum = 0, broadN = 0;
    let pending = Buffer.alloc(0);

    proc.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const samples = Math.floor(pending.length / 4);
      for (let i = 0; i < samples; i++) {
        const x = pending.readFloatLE(i * 4);
        broadSum += x * x; broadN++;
        for (const g of gs) g.add(x);
      }
      pending = pending.slice(samples * 4);
    });
    const killer = setTimeout(() => { try { proc.kill(); } catch { } }, 180000);
    proc.on('close', () => {
      clearTimeout(killer);
      if (broadN < RATE * 2) { resolve(null); return; } // 少于 2 秒无法判定
      const broad = broadSum / broadN;
      const bands = PROBES.map((f, i) => ({ freq: f, rel: gs[i].power() / Math.max(broad, 1e-12) }));
      // 截止频率：相对能量跌破阈值的第一个探测点（-40dB = 1e-4）
      let cutoff = PROBES[PROBES.length - 1] + 1000;
      for (const b of bands) {
        if (b.rel < 1e-4) { cutoff = b.freq; break; }
      }
      let verdict, reason;
      if (cutoff <= 16500) {
        verdict = 'suspect';
        reason = `高频截止于 ${(cutoff / 1000).toFixed(0)}kHz，疑似 MP3 ≤256kbps 转制`;
      } else if (cutoff <= 18500) {
        verdict = 'suspect';
        reason = `高频截止于 ${(cutoff / 1000).toFixed(0)}kHz，疑似 MP3 320kbps / AAC 转制`;
      } else {
        verdict = 'clean';
        reason = `频谱延伸至 ${(cutoff / 1000).toFixed(0)}kHz 以上，未见明显转制特征`;
      }
      resolve({ cutoff, verdict, reason, bands });
    });
    proc.on('error', () => { clearTimeout(killer); resolve(null); });
  });
}

/* ---------------- 批量任务 ---------------- */
let batch = null;

async function batchStart(win, paths, onResult) {
  batchCancel();
  const state = { cancel: false };
  batch = state;
  const send = (payload) => { try { if (win && !win.isDestroyed()) win.webContents.send('fakescan:event', payload); } catch { } };
  send({ type: 'start', total: paths.length });
  let done = 0, suspect = 0;
  for (const p of paths) {
    if (state.cancel) break;
    // 仅检测自称为无损的格式（有损格式无需判定）
    if (!/\.(flac|wav|ape|aiff?|alac|tta|wv|dsf|dff)$/i.test(p)) { done++; continue; }
    const v = await analyzeTrack(p);
    done++;
    if (v) {
      if (v.verdict === 'suspect') suspect++;
      try { onResult(p, v); } catch { }
    }
    send({ type: 'progress', done, total: paths.length, suspect, path: p, verdict: v ? v.verdict : 'skip', cutoff: v ? v.cutoff : 0, reason: v ? v.reason : '' });
  }
  if (batch === state) batch = null;
  send({ type: 'end', done, total: paths.length, suspect, canceled: state.cancel });
}

function batchCancel() { if (batch) { batch.cancel = true; batch = null; } }

/* ---------------- 报告导出 ---------------- */
function buildCsv(items) {
  const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const rows = [['文件路径', '截止频率(Hz)', '判定', '理由'].join(',')];
  for (const it of items) rows.push([esc(it.path), it.cutoff || '', it.verdict === 'suspect' ? '疑似假无损' : '正常', esc(it.reason || '')].join(','));
  return '﻿' + rows.join('\r\n'); // BOM 供 Excel 识别 UTF-8
}

function buildHtml(items) {
  const bar = (bands) => {
    if (!bands || !bands.length) return '';
    const max = Math.max(...bands.map(b => b.rel), 1e-6);
    const rects = bands.map((b, i) => {
      const h = Math.max(1, Math.round(60 * Math.sqrt(b.rel / max)));
      const x = 10 + i * 30;
      return `<rect x="${x}" y="${70 - h}" width="20" height="${h}" fill="#5aa8ff"/>` +
        `<text x="${x + 10}" y="82" font-size="8" text-anchor="middle" fill="#888">${b.freq / 1000}k</text>`;
    }).join('');
    return `<svg width="240" height="90" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  };
  const rows = items.map(it => `<tr class="${it.verdict === 'suspect' ? 'sus' : ''}">
    <td>${it.path}</td><td>${it.cutoff || '-'}</td>
    <td>${it.verdict === 'suspect' ? '⚠ 疑似假无损' : '✓ 正常'}</td>
    <td>${it.reason || ''}</td><td>${bar(it.bands)}</td></tr>`).join('\n');
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>假无损检测报告</title>
<style>body{font:13px/1.6 "Microsoft YaHei UI",sans-serif;background:#10131c;color:#e8eaf0;padding:24px}
h1{font-size:18px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333a4d;padding:6px 8px;vertical-align:top}
th{background:#1b2030;text-align:left}.sus td{background:rgba(245,185,66,.08);color:#f5b942}</style></head>
<body><h1>假无损批量检测报告（AnniePlayerPlus Pro）</h1>
<p>共 ${items.length} 条，其中疑似假无损 ${items.filter(i => i.verdict === 'suspect').length} 条。</p>
<table><tr><th>文件路径</th><th>截止频率(Hz)</th><th>判定</th><th>理由</th><th>频段能量</th></tr>${rows}</table>
</body></html>`;
}

module.exports = { analyzeTrack, batchStart, batchCancel, buildCsv, buildHtml };
