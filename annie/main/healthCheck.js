'use strict';
/* 媒体库体检（Slice A：P0 项 H1-H9）。
 * 原则：只扫描 + 出纯数据报告，不自动修复任何东西；修复由 IPC health:fix 在用户确认后执行，
 * 修复前生成撤销快照（store.healthUndo，仅留最近一次，>5MB 降级为 JSON 清单导出）。
 *
 * 检查项（P0：fs.stat + 库内交叉引用，廉价）：
 *  H1 曲目文件不存在（CUE/ISO 虚拟轨剥 #cueN/#isoN 后缀查容器）
 *  H2 歌单死引用（playlists.paths 不在磁盘，附 refBy 歌单名）
 *  H3 收藏死引用
 *  H4 统计/标签缓存孤儿（stats、metaCache 的 key 不在 tracks）
 *  H5 媒体库文件夹不可达（区分盘未插/网络盘断 offline 与目录已删除 missing）
 *  H6 零字节文件
 *  H7 缺基础标签（metaCache 有条目但 title/artist 全空，仅报告）
 *  H8 重复歌曲分组数（与 lib:duplicates 同口径，渲染层卡片跳现有清理区）
 *  H9 响度/BPM 未分析数（渲染层按钮直接触发现有补算）
 * 深度项（Slice D，deep:true 才跑，4 并发 + 可取消 + 子进程整树 kill）：
 *  H10 缺封面（ffprobe 查内嵌图 + 目录外置封面文件，仅报告不自动改）
 *  H11 不可解码/损坏（ffmpeg 解前 5 秒，-v error 有输出或退出码非 0 即坏，仅报告）
 *  H12 封面缓存占用（统计 covercache 目录条数/体积，修复=清空缓存，安全） */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/* 工具路径三候选（AGENTS 规范 5：打包产物 / 开发目录 / 仓库根 engine/tools，最后回退 PATH） */
function resolveTool(name) {
  const cands = [
    path.join(process.resourcesPath || '', 'engine', 'tools', name),
    path.join(__dirname, '..', '..', 'engine', 'tools', name),
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch { } }
  return name;
}

const VIRTUAL_RE = /#(cue|iso)\d+$/i;
const ITEM_CAP = 500; // 单类明细推给渲染层的上限，完整清单留在 lastReport 供导出

// CUE/ISO 虚拟轨路径 → 真实容器路径
function containerOf(p) { return String(p == null ? '' : p).replace(VIRTUAL_RE, ''); }
function isVirtual(p) { return VIRTUAL_RE.test(String(p || '')); }

let job = null;       // 当前扫描令牌（可取消）
let lastReport = null; // 最近一份完整报告（不截断，供「导出完整清单」）

function yieldBatch() { return new Promise((resolve) => setImmediate(resolve)); }

function statFile(p) {
  try {
    const st = fs.statSync(p);
    return { ok: st.isFile(), size: st.size };
  } catch { return { ok: false, size: -1 }; }
}

/* 批量 stat 真实文件集合（每 200 个让出事件循环一拍，支持取消） */
async function buildExistence(realSet, onProgress, token) {
  const exist = new Map();
  const total = realSet.size;
  let done = 0;
  for (const rp of realSet) {
    if (token.cancel) break;
    exist.set(rp, statFile(rp));
    done++;
    if (done % 200 === 0) {
      onProgress({ phase: 'files', done, total });
      await yieldBatch();
    }
  }
  if (!token.cancel) onProgress({ phase: 'files', done, total });
  return exist;
}

function baseName(p) {
  try { return path.basename(containerOf(p)); } catch { return String(p || ''); }
}
function dirName(p) {
  try { return path.dirname(containerOf(p)); } catch { return ''; }
}
function displayName(p, mc) {
  if (mc && (mc.title || mc.artist)) return mc.title + (mc.artist ? ' - ' + mc.artist : '');
  let base = baseName(p);
  if (isVirtual(p)) base += p.slice(containerOf(p).length); // 追加 #cue3 / #iso2
  return base;
}

/* H8：与 lib:duplicates 同口径的"规范化标题+艺人"分组（只统计，不返回明细） */
function duplicateStats(store) {
  const mc = store.metaCache || {};
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/[\s\-_·、,，.。!！?？'"\[\]（）()【】~～]/g, '');
  const groups = new Map();
  for (const t of (store.tracks || [])) {
    if (t.cue) continue; // CUE 虚拟分轨不参与查重
    const m = mc[t.path] || {};
    const title = norm(m.title) || norm(String(t.name || '').replace(/\.[^.]+$/, ''));
    if (!title) continue;
    const key = title + '|' + norm(m.artist);
    if (!groups.has(key)) groups.set(key, 0);
    groups.set(key, groups.get(key) + 1);
  }
  let groupCount = 0, removable = 0;
  for (const n of groups.values()) if (n >= 2) { groupCount++; removable += n - 1; }
  return { groups: groupCount, removable };
}

function cap(items) {
  return { items: items.slice(0, ITEM_CAP), count: items.length, truncated: items.length > ITEM_CAP };
}

async function runScan(store, token, send, opts) {
  opts = opts || {};
  const started = Date.now();
  const tracks = store.tracks || [];
  const playlists = store.playlists || [];
  const favorites = Array.isArray(store.favorites) ? store.favorites : [];
  const folders = Array.isArray(store.folders) ? store.folders : [];
  const metaCache = store.metaCache || {};
  const stats = store.stats || {};

  // 1) 汇总所有需要 stat 的真实文件（tracks + 歌单 + 收藏；虚拟轨按容器去重）
  const realSet = new Set();
  const addReal = (p) => { if (typeof p === 'string' && p) realSet.add(containerOf(p)); };
  for (const t of tracks) addReal(t.path);
  for (const pl of playlists) for (const p of (pl.paths || [])) addReal(p);
  for (const p of favorites) addReal(p);

  send({ type: 'start', total: realSet.size + folders.length });
  const exist = await buildExistence(realSet, (ev) => {
    if (!token.cancel) send({ type: 'progress', phase: ev.phase, done: ev.done, total: ev.total });
  }, token);
  if (token.cancel) return null;

  // 2) H5 文件夹可达性（数量少，直接 stat；盘根不存在 = 盘未插/网络盘断）
  const h5Offline = [], h5Missing = [];
  let folderDone = 0;
  for (const f of folders) {
    if (token.cancel) return null;
    let folderOk = false;
    try { folderOk = fs.statSync(f).isDirectory(); } catch { }
    if (!folderOk) {
      const root = path.parse(f).root;
      let driveOk = false;
      try { driveOk = fs.statSync(root).isDirectory(); } catch { }
      (driveOk ? h5Missing : h5Offline).push({ path: f, kind: driveOk ? 'missing' : 'offline' });
    }
    folderDone++;
    send({ type: 'progress', phase: 'folders', done: realSet.size + folderDone, total: realSet.size + folders.length });
  }

  const alive = (p) => {
    const r = exist.get(containerOf(p));
    return !!(r && r.ok);
  };

  // 3) H1 死曲目 / H6 零字节
  const h1 = [], h6 = [];
  for (const t of tracks) {
    const r = exist.get(containerOf(t.path));
    if (!r || !r.ok) {
      h1.push({
        path: t.path, name: t.name || displayName(t.path, metaCache[t.path]),
        dir: t.dir || dirName(t.path),
        detail: isVirtual(t.path) ? ('CUE/ISO 容器不存在：' + containerOf(t.path)) : '文件不存在'
      });
    } else if (r.size === 0) {
      h6.push({ path: t.path, name: t.name || baseName(t.path), dir: t.dir || dirName(t.path), detail: '0 字节' });
    }
  }

  // 4) H2 歌单死引用（一条死路径在多个歌单 → 每个歌单各一项，附歌单名）
  const h2 = [];
  for (const pl of playlists) {
    for (const p of (pl.paths || [])) {
      if (typeof p !== 'string' || alive(p)) continue;
      h2.push({
        plId: pl.id, plName: pl.name, path: p,
        name: displayName(p, metaCache[p]), dir: dirName(p),
        detail: isVirtual(p) ? '容器不存在' : '文件不存在'
      });
    }
  }

  // 5) H3 收藏死引用
  const h3 = [];
  for (const p of favorites) {
    if (typeof p !== 'string' || alive(p)) continue;
    h3.push({ path: p, name: displayName(p, metaCache[p]), dir: dirName(p) });
  }

  // 6) H4 孤儿缓存（key 不在 tracks；stats 与 metaCache 分两组，先统计后缓存）
  // 流媒体统计键（http(s):// 临时播放链接，vkey 过期即废）单列一组：可安全清理，不与本地文件孤儿混淆
  const isStreamKey = (k) => /^https?:\/\//i.test(k);
  const trackSet = new Set(tracks.map((t) => t.path));
  const h4Stats = [], h4Meta = [], h4Stream = [];
  for (const key of Object.keys(stats)) {
    if (trackSet.has(key)) continue;
    if (isStreamKey(key)) h4Stream.push({ kind: 'stream', key, name: baseName(key), dir: dirName(key) });
    else h4Stats.push({ kind: 'stats', key, name: baseName(key), dir: dirName(key) });
  }
  for (const key of Object.keys(metaCache)) {
    if (!trackSet.has(key)) h4Meta.push({ kind: 'meta', key, name: baseName(key), dir: dirName(key) });
  }
  const h4Cat = cap(h4Stats.concat(h4Meta).concat(h4Stream));
  h4Cat.statsCount = h4Stats.length;
  h4Cat.metaCount = h4Meta.length;
  h4Cat.streamCount = h4Stream.length;

  // 7) H7 缺基础标签（有条目但标题/艺人全空）
  const h7 = [];
  for (const t of tracks) {
    const m = metaCache[t.path];
    if (m && !String(m.title || '').trim() && !String(m.artist || '').trim()) {
      h7.push({ path: t.path, name: t.name || baseName(t.path), dir: t.dir || dirName(t.path) });
    }
  }

  // 8) H9 响度/BPM 未分析
  let loudnessMissing = 0, bpmMissing = 0;
  for (const t of tracks) {
    const m = metaCache[t.path] || {};
    if (!m.loudness) loudnessMissing++;
    if (typeof m.bpm !== 'number') bpmMissing++;
  }

  // 9) Slice D 深度项（H10 缺封面 / H11 不可解码 / H12 封面缓存）：deep:true 才跑
  let deepCats = null;
  if (opts.deep && !token.cancel) {
    // 深度项只跑曲库 tracks 里存活的真实文件（CUE/ISO 虚拟轨按容器去重已在 realSet 完成）
    const aliveFiles = [];
    for (const t of tracks) {
      const r = exist.get(containerOf(t.path));
      if (r && r.ok && r.size > 0) aliveFiles.push(containerOf(t.path));
    }
    const uniq = Array.from(new Set(aliveFiles));
    send({ type: 'progress', phase: 'deep', done: 0, total: uniq.length });
    const d = await deepScan(uniq, token, send, opts.coverCacheDir);
    if (token.cancel) return null;
    deepCats = {
      h10NoCover: cap(d.h10),
      h11Undecodable: cap(d.h11),
      h12CoverCache: d.h12
    };
  }

  return {
    version: 1,
    time: new Date().toISOString(),
    durationMs: Date.now() - started,
    deep: !!deepCats,
    totals: {
      tracks: tracks.length, playlists: playlists.length,
      favorites: favorites.length, folders: folders.length, filesStated: realSet.size
    },
    cats: {
      h1DeadTracks: cap(h1),
      h2PlaylistRefs: cap(h2),
      h3Favorites: cap(h3),
      h4Orphans: h4Cat,
      h5Folders: { items: cap(h5Missing.concat(h5Offline)).items, count: h5Missing.length + h5Offline.length, truncated: h5Missing.length + h5Offline.length > ITEM_CAP, missingCount: h5Missing.length, offlineCount: h5Offline.length },
      h6ZeroByte: cap(h6),
      h7MissingTags: cap(h7),
      h8Duplicates: duplicateStats(store),
      h9Analysis: { loudnessMissing, bpmMissing },
      ...(deepCats || {})
    }
  };
}

/* 截断明细供渲染层（完整报告留 lastReport） */
function capReport(report) {
  return report; // cats 各项已在 runScan 内 cap 过
}

function start(win, store, opts) {
  cancelScan();
  const token = { cancel: false };
  job = token;
  const send = (payload) => {
    try { if (win && !win.isDestroyed()) win.webContents.send('health:event', payload); } catch { }
  };
  runScan(store, token, send, opts).then((report) => {
    if (job === token) job = null;
    if (token.cancel || !report) { send({ type: 'end', canceled: true }); return; }
    lastReport = report;
    send({ type: 'end', report: capReport(report) });
  }).catch((err) => {
    if (job === token) job = null;
    console.error('[health] 体检失败:', err);
    send({ type: 'end', error: String((err && err.message) || err) });
  });
}

function cancelScan() { if (job) { job.cancel = true; job = null; } }

function getLastReport() { return lastReport; }

/* ---------------- 修复（health:fix 调用，直接改 store，调用方负责 saveStore/广播） ---------------- */

function fileAlive(p) {
  try { fs.statSync(containerOf(p)); return true; } catch { return false; }
}
function folderAlive(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
const normPath = (s) => String(s == null ? '' : s).replace(/\//g, '\\').replace(/\\+$/g, '');

/* 执行单项修复。返回 { snapshot, removed, skipped }：
 * snapshot 为撤销凭证（只含被删数据），skipped 为复检后已无需处理的项。 */
function fix(store, payload) {
  const action = payload && payload.action;
  const snapshot = { type: action };
  const removed = {};
  const skipped = [];

  if (action === 'pruneRefs') {
    const before = { playlists: {}, favorites: [] };
    // 歌单死引用：按 plId 聚合，移除前复检文件是否仍不存在（报告后用户可能已重扫/补回）
    const byPl = new Map();
    for (const it of (payload.playlistItems || [])) {
      if (!it || typeof it.plId !== 'string' || typeof it.path !== 'string') continue;
      if (fileAlive(it.path)) { skipped.push({ path: it.path, reason: '文件已恢复' }); continue; }
      if (!byPl.has(it.plId)) byPl.set(it.plId, new Set());
      byPl.get(it.plId).add(it.path);
    }
    let plCount = 0;
    for (const pl of (store.playlists || [])) {
      const set = byPl.get(pl.id);
      if (!set) continue;
      const saved = [];
      pl.paths = (pl.paths || []).filter((p, idx) => {
        if (set.has(p)) { saved.push({ path: p, index: idx }); return false; }
        return true;
      });
      if (saved.length) { before.playlists[pl.id] = saved; plCount += saved.length; }
    }
    // 收藏死引用
    const favSet = new Set();
    for (const it of (payload.favoriteItems || [])) {
      if (it && typeof it.path === 'string') favSet.add(it.path);
    }
    const favs = Array.isArray(store.favorites) ? store.favorites : [];
    favs.forEach((p, idx) => {
      if (favSet.has(p)) {
        if (fileAlive(p)) skipped.push({ path: p, reason: '文件已恢复' });
        else before.favorites.push({ path: p, index: idx });
      }
    });
    const favDel = new Set(before.favorites.map((x) => x.path));
    if (favDel.size) store.favorites = favs.filter((p) => !favDel.has(p));
    removed.playlist = plCount;
    removed.favorite = before.favorites.length;
    snapshot.before = before;
  } else if (action === 'pruneOrphans') {
    const trackSetNow = new Set((store.tracks || []).map((t) => t.path));
    const before = { stats: {}, meta: {} };
    for (const it of (payload.items || [])) {
      if (!it || typeof it.key !== 'string') continue;
      if (trackSetNow.has(it.key)) { skipped.push({ key: it.key, reason: '已重新进入曲库' }); continue; }
      if ((it.kind === 'stats' || it.kind === 'stream') && Object.prototype.hasOwnProperty.call(store.stats || {}, it.key)) {
        before.stats[it.key] = store.stats[it.key];
      } else if (it.kind === 'meta' && Object.prototype.hasOwnProperty.call(store.metaCache || {}, it.key)) {
        before.meta[it.key] = store.metaCache[it.key];
      }
    }
    Object.keys(before.stats).forEach((k) => { delete store.stats[k]; });
    Object.keys(before.meta).forEach((k) => { delete store.metaCache[k]; });
    removed.stats = Object.keys(before.stats).length;
    removed.meta = Object.keys(before.meta).length;
    snapshot.before = before;
  } else if (action === 'removeFolders') {
    const wanted = new Set((payload.items || []).map((x) => x && x.path).filter((x) => typeof x === 'string'));
    const oldFolders = Array.isArray(store.folders) ? store.folders : [];
    const beforeFolders = [];
    oldFolders.forEach((f, idx) => { if (wanted.has(f)) beforeFolders.push({ path: f, index: idx }); });
    // 复检：盘已插回/目录恢复的不移除
    const valid = beforeFolders.filter((x) => !folderAlive(x.path));
    beforeFolders.filter((x) => folderAlive(x.path)).forEach((x) => skipped.push({ path: x.path, reason: '文件夹已恢复' }));
    const validSet = new Set(valid.map((x) => x.path));
    const validNorms = Array.from(validSet).map(normPath);
    store.folders = oldFolders.filter((f) => !validSet.has(f));
    // 与 lib:removeFolder 同口径：文件夹移除后其下 tracks 一并移出索引
    const removedTracks = [];
    store.tracks = (store.tracks || []).filter((t) => {
      const nd = normPath(t.dir);
      for (const nf of validNorms) {
        if (nd === nf || nd.startsWith(nf + '\\')) { removedTracks.push(t); return false; }
      }
      return true;
    });
    removed.folder = valid.length;
    removed.tracks = removedTracks.length;
    snapshot.before = { folders: valid, tracks: removedTracks };
  } else {
    throw new Error('未知的体检修复动作：' + action);
  }

  return { snapshot, removed, skipped };
}

/* 按 snapshot 逆序写回（health:undo）。返回 {ok, restored}。 */
function undo(store) {
  const u = store.healthUndo;
  if (!u || !Array.isArray(u.actions) || !u.actions.length) return { ok: false, reason: 'no-snapshot' };
  let restored = 0;
  if (!store.stats) store.stats = {};
  if (!store.metaCache) store.metaCache = {};
  if (!Array.isArray(store.favorites)) store.favorites = [];
  if (!Array.isArray(store.playlists)) store.playlists = [];
  if (!Array.isArray(store.folders)) store.folders = [];
  if (!Array.isArray(store.tracks)) store.tracks = [];

  for (let i = u.actions.length - 1; i >= 0; i--) {
    const a = u.actions[i];
    if (a.type === 'pruneRefs') {
      const b = a.before || {};
      for (const [plId, arr] of Object.entries(b.playlists || {})) {
        const pl = store.playlists.find((x) => x.id === plId);
        if (!pl || !Array.isArray(pl.paths)) continue;
        arr.slice().sort((x, y) => y.index - x.index).forEach((e) => {
          if (!pl.paths.includes(e.path)) { pl.paths.splice(Math.min(e.index, pl.paths.length), 0, e.path); restored++; }
        });
      }
      (b.favorites || []).slice().sort((x, y) => y.index - x.index).forEach((e) => {
        if (!store.favorites.includes(e.path)) { store.favorites.splice(Math.min(e.index, store.favorites.length), 0, e.path); restored++; }
      });
    } else if (a.type === 'pruneOrphans') {
      const b = a.before || {};
      for (const [k, v] of Object.entries(b.stats || {})) {
        if (!Object.prototype.hasOwnProperty.call(store.stats, k)) { store.stats[k] = v; restored++; }
      }
      for (const [k, v] of Object.entries(b.meta || {})) {
        if (!Object.prototype.hasOwnProperty.call(store.metaCache, k)) { store.metaCache[k] = v; restored++; }
      }
    } else if (a.type === 'removeFolders') {
      const b = a.before || {};
      (b.folders || []).slice().sort((x, y) => y.index - x.index).forEach((e) => {
        if (!store.folders.includes(e.path)) { store.folders.splice(Math.min(e.index, store.folders.length), 0, e.path); restored++; }
      });
      const have = new Set(store.tracks.map((t) => t.path));
      for (const t of (b.tracks || [])) {
        if (!have.has(t.path)) { store.tracks.push(t); have.add(t.path); restored++; }
      }
    }
  }
  delete store.healthUndo;
  return { ok: true, restored };
}

/* ---------------- Slice D：深度体检（H10 缺封面 / H11 不可解码 / H12 封面缓存） ----------------
 * 4 并发子进程池；token.cancel 时立即杀掉在跑的 ffmpeg/ffprobe 并停止派新任务。 */

const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'art', 'thumb'];
const COVER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
function hasExternalCover(dir) {
  for (const n of COVER_NAMES) for (const e of COVER_EXTS) {
    try { if (fs.statSync(path.join(dir, n + e)).isFile()) return true; } catch { }
    try { if (fs.statSync(path.join(dir, n[0].toUpperCase() + n.slice(1) + e)).isFile()) return true; } catch { }
  }
  return false;
}

/* 跑一个工具进程，返回 {code, stdout, stderrTail}；取消/超时/启动失败返回 null（深度项宁可漏报不误报）。 */
function runProbe(tool, args, token, timeoutMs, wantStdout) {
  return new Promise((resolve) => {
    if (token.cancel) return resolve(null);
    let proc;
    try { proc = spawn(resolveTool(tool), args, { windowsHide: true }); }
    catch { return resolve(null); }
    let stderr = '', stdout = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch { } }, timeoutMs || 15000);
    const cancelWatch = setInterval(() => {
      if (token.cancel) { killed = true; try { proc.kill('SIGKILL'); } catch { } }
    }, 200);
    if (cancelWatch.unref) cancelWatch.unref();
    proc.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d.toString(); });
    if (wantStdout) proc.stdout.on('data', (d) => { if (stdout.length < 1024 * 1024) stdout += d.toString(); });
    else proc.stdout.resume(); // 不消费也必须排空，防止管道写满卡死
    proc.on('error', () => { clearTimeout(timer); clearInterval(cancelWatch); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer); clearInterval(cancelWatch);
      resolve(killed ? null : { code, stdout, stderrTail: stderr.trim().split('\n').slice(-3).join(' | ') });
    });
  });
}

/* H10 单文件：true=有封面 / false=缺封面 / null=探测失败（不计） */
async function probeCover(file, dirCoverMemo, token) {
  const r = await runProbe('ffprobe.exe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', file
  ], token, 10000, true);
  if (!r || r.code !== 0) return null;
  let hasEmbedded = false;
  try {
    const j = JSON.parse(r.stdout || '{}');
    hasEmbedded = (j.streams || []).some((s) =>
      s.codec_type === 'video' && (!s.disposition || s.disposition.attached_pic !== 0));
  } catch { return null; }
  if (hasEmbedded) return true;
  const dir = dirName(file);
  if (!dirCoverMemo.has(dir)) dirCoverMemo.set(dir, hasExternalCover(dir));
  return dirCoverMemo.get(dir);
}

/* 深度扫描主流程：files 为去重后的真实文件数组（只含 stat 存活的）。4 并发。 */
async function deepScan(files, token, send, coverCacheDir) {
  const total = files.length;
  let done = 0;
  const h10 = [], h11 = [];
  const CONC = 4;
  let idx = 0;
  const dirCoverMemo = new Map(); // 目录级外置封面记忆（同专辑共享，避免重复 stat）
  async function worker() {
    while (!token.cancel) {
      const i = idx++;
      if (i >= total) return;
      const f = files[i];
      // H11 不可解码：ffmpeg 解前 5 秒，有错或退出码非 0 即坏
      const dec = await runProbe('ffmpeg.exe', [
        '-v', 'error', '-t', '5', '-i', f, '-f', 'null', '-'
      ], token, 20000);
      if (token.cancel) return;
      if (dec && (dec.code !== 0 || dec.stderrTail)) {
        h11.push({ path: f, name: baseName(f), dir: dirName(f), detail: dec.stderrTail || ('退出码 ' + dec.code) });
      }
      // H10 缺封面（解码探测失败的文件顺带跳过封面探测——大概率也读不出流）
      if (!(dec && dec.code !== 0)) {
        const hasCov = await probeCover(f, dirCoverMemo, token);
        if (token.cancel) return;
        if (hasCov === false) h10.push({ path: f, name: baseName(f), dir: dirName(f) });
      }
      done++;
      if (done % 5 === 0 || done === total) send({ type: 'progress', phase: 'deep', done, total });
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  // H12 封面缓存占用（目录遍历即可，毫秒级）
  let h12 = { count: 0, bytes: 0 };
  if (coverCacheDir) {
    try {
      for (const fn of fs.readdirSync(coverCacheDir)) {
        try { h12.bytes += fs.statSync(path.join(coverCacheDir, fn)).size; h12.count++; } catch { }
      }
    } catch { }
  }
  return { h10, h11, h12 };
}

module.exports = {
  start, cancel: cancelScan, getLastReport,
  fix, undo,
  ITEM_CAP, deepScan, hasExternalCover
};
