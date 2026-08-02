'use strict';
/* Pro beat0.0.1：响度分析（EBU R128）。
 * 单轨：ffmpeg -af ebur128=peak=true 解析 Integrated loudness / True peak；
 * 批量：后台逐轨补算，进度事件推送 + 可取消；结果写入 metaCache 持久化。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveFfmpeg() {
  const prod = path.join(process.resourcesPath || '', 'engine', 'tools', 'ffmpeg.exe');
  const dev = path.join(__dirname, '..', 'engine', 'tools', 'ffmpeg.exe');
  for (const p of [prod, dev]) { try { if (fs.existsSync(p)) return p; } catch { } }
  return 'ffmpeg.exe';
}

/* 解析单轨响度；resolve({ i, tp }) 或 null（失败/非音频） */
function analyzeTrack(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(resolveFfmpeg(), [
        '-hide_banner', '-nostats', '-nostdin',
        '-i', filePath, '-af', 'ebur128=peak=true', '-f', 'null', '-'
      ], { windowsHide: true });
    } catch { resolve(null); return; }
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill(); } catch { } }, 120000); // 单轨 2 分钟兜底
    proc.on('close', () => {
      clearTimeout(killer);
      // Summary 段：I: -14.2 LUFS；True peak: -1.0 dBFS
      const summary = err.slice(err.lastIndexOf('Summary:'));
      const mi = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
      if (!mi) { resolve(null); return; }
      const mt = /True peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(summary)
        || /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(summary);
      resolve({ i: parseFloat(mi[1]), tp: mt ? parseFloat(mt[1]) : 0 });
    });
    proc.on('error', () => { clearTimeout(killer); resolve(null); });
  });
}

/* ---------------- 批量补算任务 ---------------- */
let batch = null; // { cancel, running }

/**
 * 批量补算响度。
 * @param {BrowserWindow} win 进度事件接收窗口
 * @param {string[]} paths 待分析路径
 * @param {(p:string, v:{i:number,tp:number})=>void} onResult 每轨结果回调（写 metaCache）
 */
async function batchStart(win, paths, onResult) {
  batchCancel();
  const state = { cancel: false };
  batch = state;
  const send = (payload) => { try { if (win && !win.isDestroyed()) win.webContents.send('loudness:event', payload); } catch { } };
  send({ type: 'start', total: paths.length });
  let done = 0, ok = 0;
  for (const p of paths) {
    if (state.cancel) break;
    const v = await analyzeTrack(p);
    done++;
    if (v) { ok++; try { onResult(p, v); } catch { } }
    send({ type: 'progress', done, total: paths.length, ok, path: p, found: !!v });
  }
  if (batch === state) batch = null;
  send({ type: 'end', done, total: paths.length, ok, canceled: state.cancel });
}

function batchCancel() {
  if (batch) { batch.cancel = true; batch = null; }
}

module.exports = { analyzeTrack, batchStart, batchCancel };
