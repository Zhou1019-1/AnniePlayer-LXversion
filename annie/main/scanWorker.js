'use strict';
/* EXP 7.28 —— 曲库扫描/元数据 Worker（worker_threads）
 * 职责：递归目录遍历（批量 100 首回传）、取消支持、元数据批量解析。
 * 主线程（main.js ScanManager）只收发消息，不做文件系统遍历。
 * 异常时 Worker 进程整体退出，由主线程降级为同步扫描兜底。 */
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const AUDIO_EXTS = new Set([
  '.flac', '.mp3', '.wav', '.ape', '.m4a', '.aac', '.alac',
  '.aiff', '.aif', '.ogg', '.opus', '.wma', '.dsf', '.dff',
  '.tta', '.wv', '.mka', '.mp2'
]);

let cancelled = false;

parentPort.on('message', (msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'cancel') { cancelled = true; return; }
  if (msg.type === 'scan') scan(msg.jobId, msg.folders || []);
  else if (msg.type === 'meta') metaBatch(msg.jobId, msg.paths || []);
});

/* ---------------- 递归扫描（深度≤12，与旧 walk 对齐；批量 100） ---------------- */
/* 定期让出事件循环，保证 cancel 消息能被及时处理 */
const yieldLoop = () => new Promise(r => setImmediate(r));

async function scan(jobId, folders) {
  cancelled = false;
  const post = (m) => parentPort.postMessage(Object.assign({ jobId, kind: 'scan' }, m));
  let found = 0, sinceYield = 0;
  let batch = [];

  const flush = () => {
    if (batch.length) { post({ type: 'batch', tracks: batch, found }); batch = []; }
  };

  const cueFiles = []; // Pro beat0.0.1：扫描中收集 .cue
  const isoFiles = []; // SVLX 1.2.0：扫描中收集 SACD .iso

  async function walk(dir, depth) {
    if (cancelled || depth > 12) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (cancelled) return;
      if (++sinceYield >= 200) { sinceYield = 0; await yieldLoop(); }
      try {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (ext === '.cue') { cueFiles.push(full); continue; } // Pro：CUE 分轨
        if (ext === '.iso') { // SVLX 1.2.0：SACD ISO 分轨（主线程探测后生成虚拟分轨）
          let size = 0, mtime = 0;
          try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch { }
          isoFiles.push({ path: full, name: e.name, dir, size, mtime });
          continue;
        }
        if (!AUDIO_EXTS.has(ext)) continue;
        let size = 0, mtime = 0;
        try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch { }
        batch.push({ path: full, name: e.name, dir, size, mtime });
        found++;
        if (batch.length >= 100) flush();
      } catch { /* 单文件异常跳过（特殊字符/权限/超长路径） */ }
    }
  }

  for (const f of folders) {
    if (cancelled) break;
    await walk(f, 0);
  }

  /* Pro beat0.0.1：CUE 分轨——整轨文件隐藏，替换为虚拟分轨 */
  if (!cancelled && cueFiles.length) {
    try {
      const { decodeCue, parseCueText } = require('./cueParser');
      const hidden = [], virtuals = [];
      for (const cuePath of cueFiles) {
        try {
          const cue = parseCueText(decodeCue(fs.readFileSync(cuePath)));
          if (!cue.file || !cue.tracks.length) continue;
          const dir = path.dirname(cuePath);
          // FILE 行可能是相对/绝对路径，大小写不敏感匹配同目录音频
          const audioFull = path.isAbsolute(cue.file) ? cue.file : path.join(dir, cue.file);
          let size = 0, mtime = 0;
          try { const st = fs.statSync(audioFull); size = st.size; mtime = st.mtimeMs; } catch { continue; }
          hidden.push(audioFull);
          for (const t of cue.tracks) {
            virtuals.push({
              path: audioFull + '#cue' + t.no,
              name: (t.title || 'Track ' + t.no) + path.extname(audioFull),
              dir, size, mtime,
              cue: { src: audioFull, start: t.startSec, end: t.endSec, no: t.no },
              cueMeta: { title: t.title, artist: t.artist || cue.albumArtist || '', album: cue.album || '' }
            });
          }
        } catch { /* 单个 cue 解析失败跳过 */ }
      }
      if (hidden.length || virtuals.length) post({ type: 'cue', hidden, tracks: virtuals });
    } catch { /* cueParser 不可用时忽略 CUE（整轨照常入列） */ }
  }

  /* SVLX 1.2.0：SACD ISO——交给主线程用 sacd_extract 探测分轨 */
  if (!cancelled && isoFiles.length) post({ type: 'isoFound', isos: isoFiles });

  flush();
  post({ type: cancelled ? 'cancelled' : 'done', found });
}

/* ---------------- 元数据批量解析（并发 4，50 条一批回传） ---------------- */
async function metaBatch(jobId, paths) {
  cancelled = false;
  const post = (m) => parentPort.postMessage(Object.assign({ jobId, kind: 'meta' }, m));
  let mm;
  try { mm = require('music-metadata'); } catch (e) { post({ type: 'error', message: 'music-metadata 不可用: ' + e.message }); return; }

  let idx = 0, done = 0, batch = {};
  const flush = () => {
    if (Object.keys(batch).length) { post({ type: 'metaBatch', out: batch, done }); batch = {}; }
  };
  async function worker() {
    while (idx < paths.length && !cancelled) {
      const p = paths[idx++];
      try {
        const m = await mm.parseFile(p, { duration: true, skipCovers: true });
        const c = m.common || {};
        batch[p] = {
          ok: true,
          title: c.title || '', artist: c.artist || '', album: c.album || '',
          genre: (c.genre && c.genre[0]) || '', year: c.year || 0
        };
      } catch (e) { batch[p] = { ok: false, error: e.message }; }
      done++;
      if (Object.keys(batch).length >= 50) flush();
    }
  }
  const workers = [];
  for (let i = 0; i < 4; i++) workers.push(worker());
  await Promise.all(workers);
  flush();
  post({ type: cancelled ? 'cancelled' : 'metaDone', done });
}
