'use strict';
/* Pro beat0.0.1：假无损批量检测（V4.0.5 起改用 UltraMusicTestTool 四方法加权融合）。
 * 检测核心在 losslessDetect.js（频谱截止/编码帧痕迹/位深量化/上转换，原生采样率+位深）；
 * 本文件只负责批量调度、进度事件与报告导出。结果只进诊断报告，不在曲目列表打标记。
 * 批量任务后台逐轨执行，进度事件推送 + 可取消，不阻塞 UI 与播放。 */
const path = require('path');
const { detectLossless } = require('./losslessDetect');

/* 自称无损的扩展名（这些若探测出实际是有损编码 → 伪装判疑似） */
const STRICT_LOSSLESS_EXT = /\.(flac|wav|ape|aiff?|alac|tta|wv|dsf|dff)$/i;
/* 批量入口接受的扩展名（m4a 可能是 ALAC 也可能是 AAC，探测后定夺） */
const SCAN_EXT = /\.(flac|wav|ape|aiff?|alac|tta|wv|dsf|dff|m4a)$/i;

/* 分析单轨：返回 { cutoff, verdict, score, grade, reason, profileDb } 或 null */
async function analyzeTrack(filePath) {
  try {
    const det = detectLossless(filePath, { maxSec: 45, timeoutMs: 120000 });
    const r = await det.done;
    if (!r) return null;
    if (r.lossyContainer) {
      // m4a 等容器本就不自称无损：跳过；flac/wav 等自称无损却实为有损 → 伪装
      if (!STRICT_LOSSLESS_EXT.test(filePath)) return null;
      return {
        cutoff: 0, verdict: 'suspect', score: 0, grade: '有损格式',
        reason: '扩展名自称无损，实际编码为 ' + r.container.codec.toUpperCase() + ' 有损格式（伪装文件）',
        profileDb: null,
      };
    }
    const suspect = r.score < 45; // 大概率假无损 / 假无损 两级
    const topReason = r.reasons.find(x => x.indexOf('[-') >= 0);
    return {
      cutoff: (r.cutoffFreq || 0) * 1000,
      verdict: suspect ? 'suspect' : 'clean',
      score: r.score, grade: r.verdict,
      reason: suspect ? (topReason || r.verdict) : (r.verdict + '（' + r.score + '/100）'),
      profileDb: r.profileDb || null,
    };
  } catch { return null; }
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
    // 仅检测自称为无损的格式 + m4a（ALAC/AAC 两用容器，探测后定夺）
    if (!SCAN_EXT.test(p)) { done++; continue; }
    const v = await analyzeTrack(p);
    done++;
    if (v) {
      if (v.verdict === 'suspect') suspect++;
      try { onResult(p, v); } catch { }
    }
    send({ type: 'progress', done, total: paths.length, suspect, path: p, verdict: v ? v.verdict : 'skip', cutoff: v ? v.cutoff : 0, reason: v ? v.reason : '', score: v ? v.score : 0, grade: v ? v.grade : '' });
  }
  if (batch === state) batch = null;
  send({ type: 'end', done, total: paths.length, suspect, canceled: state.cancel });
}

function batchCancel() { if (batch) { batch.cancel = true; batch = null; } }

/* ---------------- 报告导出 ---------------- */
function buildCsv(items) {
  const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const rows = [['文件路径', '得分', '判定', '截止频率(Hz)', '理由'].join(',')];
  for (const it of items) rows.push([esc(it.path), it.score != null ? it.score : '', esc(it.grade || (it.verdict === 'suspect' ? '疑似假无损' : '正常')), it.cutoff || '', esc(it.reason || '')].join(','));
  return '﻿' + rows.join('\r\n'); // BOM 供 Excel 识别 UTF-8
}

function buildHtml(items) {
  const bar = (profileDb) => {
    if (!profileDb || !profileDb.length) return '';
    // profileDb：24 个 log 频带（1kHz~Nyquist）的归一化 dB（≤0），映射 -60..0dB → 柱高
    const bw = 240 / profileDb.length;
    const rects = profileDb.map((db, i) => {
      const h = Math.max(1, Math.round(60 * Math.max(0, Math.min(1, (db + 60) / 60))));
      const x = 10 + i * bw;
      return `<rect x="${x.toFixed(1)}" y="${70 - h}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h}" fill="#5aa8ff"/>`;
    }).join('');
    return `<svg width="250" height="80" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  };
  const rows = items.map(it => `<tr class="${it.verdict === 'suspect' ? 'sus' : ''}">
    <td>${it.path}</td><td>${it.score != null ? it.score : '-'}</td>
    <td>${it.grade || (it.verdict === 'suspect' ? '⚠ 疑似假无损' : '✓ 正常')}</td>
    <td>${it.reason || ''}</td><td>${bar(it.profileDb)}</td></tr>`).join('\n');
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>无损鉴别报告</title>
<style>body{font:13px/1.6 "Microsoft YaHei UI",sans-serif;background:#10131c;color:#e8eaf0;padding:24px}
h1{font-size:18px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333a4d;padding:6px 8px;vertical-align:top}
th{background:#1b2030;text-align:left}.sus td{background:rgba(245,185,66,.08);color:#f5b942}</style></head>
<body><h1>无损鉴别报告（安妮播放器 SVLX · 四方法加权融合）</h1>
<p>共 ${items.length} 条，其中疑似假无损 ${items.filter(i => i.verdict === 'suspect').length} 条。检测方法：频谱截止 0.35 / 编码帧痕迹 0.25 / 位深量化 0.15 / 采样率上转换 0.25，加权融合 + 决定性证据盖帽。</p>
<table><tr><th>文件路径</th><th>得分</th><th>判定</th><th>理由</th><th>频谱剖面</th></tr>${rows}</table>
</body></html>`;
}

module.exports = { analyzeTrack, batchStart, batchCancel, buildCsv, buildHtml };
