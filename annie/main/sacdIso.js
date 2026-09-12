'use strict';
/* SVLX 1.2.0：SACD ISO 支持（依赖 sacd_extract 0.3.9.3，GPL，https://github.com/sacd-ripper/sacd-ripper）
 * 探测：sacd_extract -P -i file.iso        → 解析曲目表（标题/艺术家/专辑/时长）
 * 抽取：sacd_extract -s -2 -t N -i file.iso -y <cacheDir> → 解出该轨为临时 DSF，交给现有 DSF/DoP 播放链路
 * 缓存：userData/isoCache/<md5(iso路径+轨号+mtime)>/，重复播放直接命中；总量超 8GB 时清最旧目录。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function toolPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'engine', 'tools', 'sacd_extract.exe'), // 打包态
    path.join(__dirname, '..', 'engine', 'tools', 'sacd_extract.exe'),             // annie/engine 布局
    path.join(__dirname, '..', '..', 'engine', 'tools', 'sacd_extract.exe')        // LXversion/engine 布局
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch { } }
  return null;
}
function available() { return !!toolPath(); }

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const exe = toolPath();
    if (!exe) return reject(new Error('缺少 engine/tools/sacd_extract.exe'));
    // cwd 指向 tools 目录：sacd_extract 会在工作目录找 sacd_extract.cfg
    execFile(exe, args, { timeout: timeoutMs || 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, cwd: path.dirname(exe) },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(String(stdout || ''));
      });
  });
}

/* ---------------- -P 输出解析（容错：不同 build 的行格式略有差异） ---------------- */
function parseDuration(s) {
  const m = /(\d+):(\d{2})(?::(\d{2}))?/.exec(s || '');
  if (!m) return 0;
  const sec = (+m[1]) * 60 + (+m[2]);
  return m[3] !== undefined ? sec + (+m[3]) / 75 : sec; // SACD 帧率 75fps
}

function parseProbe(text) {
  const lines = String(text).split(/\r?\n/);
  let album = '', albumArtist = '';
  const tracks = [];
  let cur = null;
  let areaSeen = 0;      // 只取第一个 Area（通常是立体声区），避免多声道区重复计入
  let inFirstArea = true;
  let inTrackList = false; // euflo 版：Track list [0]: 区块内按 Duration 顺序计轨
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if ((m = /^Album\s+Title\s*[:：]\s*(.+)$/i.exec(line))) { album = m[1].trim(); continue; }
    if ((m = /^Album\s+Artist\s*[:：]\s*(.+)$/i.exec(line))) { albumArtist = m[1].trim(); continue; }
    if ((m = /^Disc\s+Title\s*[:：]\s*(.+)$/i.exec(line))) { if (!album) album = m[1].trim(); continue; }
    if ((m = /^Disc\s+Artist\s*[:：]\s*(.+)$/i.exec(line))) { if (!albumArtist) albumArtist = m[1].trim(); continue; }
    if (/^Area\s+Information|^Area\s*[\[(]?\d/i.test(line)) {
      areaSeen++; inFirstArea = areaSeen <= 1; inTrackList = false; cur = null; continue;
    }
    if ((m = /^Track\s+list\s*\[(\d+)\]/i.exec(line))) { inTrackList = (+m[1]) === 0; cur = null; continue; }
    // 格式 A（经典版）：Track NN: + 后续 Title/Performer/Duration
    if ((m = /^Track\s*[\[(#]?\s*(\d+)\s*[\])]?\s*[:：]?\s*$/i.exec(line)) && !/^Track_/i.test(line)) {
      if (inFirstArea) { cur = { no: +m[1], title: '', performer: '', dur: 0 }; tracks.push(cur); }
      else cur = null;
      continue;
    }
    // 格式 B（euflo 版）：Track list 区块内每条 Duration 即一轨（轨号按顺序）
    if (inTrackList && /^Duration\s*[:：]/i.test(line)) {
      tracks.push({ no: tracks.length + 1, title: '', performer: '', dur: parseDuration(line) });
      continue;
    }
    if (!cur) continue;
    if ((m = /^Title\s*[:：]\s*(.+)$/i.exec(line))) { cur.title = m[1].trim(); continue; }
    if ((m = /^Performer\s*[:：]\s*(.+)$/i.exec(line))) { cur.performer = m[1].trim(); continue; }
    if (/^Duration\s*[:：]/i.test(line)) { cur.dur = parseDuration(line); continue; }
  }
  return { album, albumArtist, tracks: tracks.filter(t => t.no > 0) };
}

/** 探测 ISO 曲目表；返回 { album, albumArtist, tracks:[{no,title,performer,dur}] } */
async function probe(isoPath) {
  const out = await run(['-P', '-i', isoPath], 60000);
  const r = parseProbe(out);
  if (!r.tracks.length) throw new Error('未解析到曲目（可能不是 SACD ISO）');
  return r;
}

/** 抽取单轨为 DSF（缓存命中直接返回路径）。立体声区优先，失败回退多声道区。 */
async function extractTrack(isoPath, trackNo, cacheDir) {
  let size = 0, mtime = 0;
  try { const st = fs.statSync(isoPath); size = st.size; mtime = st.mtimeMs; } catch { }
  const key = crypto.createHash('md5').update(isoPath + '|' + trackNo + '|' + size + '|' + mtime).digest('hex');
  const outDir = path.join(cacheDir, key);
  const findDsf = () => {
    try {
      const f = fs.readdirSync(outDir).find(x => x.toLowerCase().endsWith('.dsf'));
      return f ? path.join(outDir, f) : null;
    } catch { return null; }
  };
  const hit = findDsf();
  if (hit) return hit;
  fs.mkdirSync(outDir, { recursive: true });
  let lastErr = null;
  for (const area of ['-2', '-m']) { // 先立体声区，无则多声道区
    try {
      await run([area, '-s', '-t', String(trackNo), '-i', isoPath, '-y', outDir], 15 * 60 * 1000);
      const f = findDsf();
      if (f) { cleanupCache(cacheDir); return f; }
    } catch (e) { lastErr = e; }
  }
  throw new Error('ISO 解轨失败: ' + (lastErr ? lastErr.message : '无输出文件'));
}

/** 缓存总量超 8GB 时按修改时间清最旧目录 */
function cleanupCache(cacheDir) {
  try {
    const ents = fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => { const p = path.join(cacheDir, e.name); let mt = 0, sz = 0;
        try { mt = fs.statSync(p).mtimeMs; for (const f of fs.readdirSync(p)) sz += fs.statSync(path.join(p, f)).size; } catch { }
        return { p, mt, sz }; });
    let total = ents.reduce((a, b) => a + b.sz, 0);
    const CAP = 8 * 1024 * 1024 * 1024;
    ents.sort((a, b) => a.mt - b.mt);
    for (const e of ents) {
      if (total <= CAP) break;
      try { fs.rmSync(e.p, { recursive: true, force: true }); total -= e.sz; } catch { }
    }
  } catch { }
}

module.exports = { available, probe, extractTrack, parseProbe };
