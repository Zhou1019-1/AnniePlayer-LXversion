'use strict';
/* V4.4.2 Slice B：曲库备份 2.0（备份/迁移核心，纯函数模块，不依赖 Electron，可纯 Node 单测）。
 *
 * 备份包 v2 结构：
 *   { kind:'annie-backup', schemaVersion:2, app, ver, time,
 *     sections:{ settings:{}, folders:[], favorites:[], playlists:[], streamPlaylists:[], stats:{},
 *                analysis:{ 路径: {响度/BPM 等白名单字段} }, listenStats: <渲染层听歌报告原始对象或缺省> },
 *     counts:{...}, roots:[路径公共前缀] }
 * 向后兼容：v1 备份（{kind, data:{平铺全键}}）在 normalize 时包成 v2 视图，schemaVersion 缺省按 1。
 *
 * 边界（与计划一致）：
 *  - tracks 永不入备份、导入也永不动 tracks（派生索引，重扫重建）；
 *  - 封面 dataURL 永不入备份（体积）；
 *  - 应用分覆盖/合并两种模式，apply 只负责"改 store 对象"，落盘/.bak/重启由调用方（main.js）负责。 */

const path = require('path');

const KIND = 'annie-backup';
const SCHEMA_VERSION = 2;
/* store 顶层结构键：不属于"设置"，导出设置段时排除；也是 v1 平铺 data 拆分依据 */
const STRUCT_KEYS = new Set([
  'folders', 'tracks', 'favorites', 'playlists', 'streamPlaylists', 'metaCache', 'stats',
  'healthUndo', '_pendingMigration', '_pendingRescan'
]);
/* 分析数据段白名单：换机免重算的核心是 loudness/bpm；封面 dataURL（cover）永不导出 */
const ANALYSIS_FIELDS = ['loudness', 'bpm', 'key', 'track', 'disc', 'rg', 'fakeScan',
  'mtimeMs', 'fileSize', 'duration', 'title', 'artist', 'album'];
const SECTIONS = ['settings', 'folders', 'favorites', 'playlists', 'streamPlaylists', 'stats', 'analysis', 'listenStats'];
// 路径类分区的内容勾选默认全开；analysis 由渲染层单独控制默认不勾（计划第五部分决策 2）

const normPath = (s) => String(s == null ? '' : s).replace(/\//g, '\\').replace(/\\+$/g, '');
const normPathLow = (s) => normPath(s).toLowerCase();
const VIRTUAL_RE = /#(cue|iso)\d+$/i;
const stripVirtual = (p) => String(p == null ? '' : p).replace(VIRTUAL_RE, '');

/* ---------------- 导出 ---------------- */

function pickAnalysisEntry(entry) {
  const out = {};
  if (!entry || typeof entry !== 'object') return out;
  for (const k of ANALYSIS_FIELDS) {
    if (entry[k] !== undefined && entry[k] !== null && entry[k] !== '') out[k] = entry[k];
  }
  return out;
}

function settingsOf(store) {
  const out = {};
  for (const k of Object.keys(store || {})) {
    if (!STRUCT_KEYS.has(k)) out[k] = store[k];
  }
  return out;
}

function analysisOf(store) {
  const out = {};
  const mc = (store && store.metaCache) || {};
  for (const [k, v] of Object.entries(mc)) {
    const picked = pickAnalysisEntry(v);
    if (Object.keys(picked).length) out[k] = picked;
  }
  return out;
}

/* 收集指定分区的内容（sections 缺省 = 除 listenStats 外全部；listenStats 由渲染层显式传入） */
function collectSections(store, sections, listenStats) {
  const want = new Set(sections && sections.length ? sections : SECTIONS.filter(s => s !== 'listenStats'));
  const out = {};
  if (want.has('settings')) out.settings = settingsOf(store);
  if (want.has('folders')) out.folders = (store.folders || []).slice();
  if (want.has('favorites')) out.favorites = (store.favorites || []).slice();
  if (want.has('playlists')) out.playlists = JSON.parse(JSON.stringify(store.playlists || []));
  if (want.has('streamPlaylists')) out.streamPlaylists = JSON.parse(JSON.stringify(store.streamPlaylists || []));
  if (want.has('stats')) out.stats = JSON.parse(JSON.stringify(store.stats || {}));
  if (want.has('analysis')) out.analysis = analysisOf(store);
  // listenStats（听歌报告，渲染层 localStorage）跟随「收听统计 stats」勾选，由渲染层显式传入
  if ((want.has('listenStats') || want.has('stats')) && listenStats && typeof listenStats === 'object') out.listenStats = listenStats;
  return out;
}

function countsOf(sections) {
  const c = {};
  if (sections.settings) c.settings = Object.keys(sections.settings).length;
  if (sections.folders) c.folders = sections.folders.length;
  if (sections.favorites) c.favorites = sections.favorites.length;
  if (sections.playlists) c.playlists = sections.playlists.length;
  if (sections.streamPlaylists) c.streamPlaylists = sections.streamPlaylists.length;
  if (sections.stats) c.stats = Object.keys(sections.stats).length;
  if (sections.analysis) c.analysis = Object.keys(sections.analysis).length;
  if (sections.listenStats) c.listenStats = 1;
  return c;
}

/* 提取路径公共前缀根：优先用媒体库文件夹列表；没有则从全部路径的父目录聚类（子目录被父目录吸收） */
function extractRoots(sections) {
  const roots = [];
  const pushRoot = (p) => {
    const n = normPath(p);
    if (!n) return;
    const nl = n.toLowerCase();
    // 已被更短的根覆盖则跳过；若新根更短则替换旧根
    for (let i = 0; i < roots.length; i++) {
      const rl = roots[i].toLowerCase();
      if (nl === rl || nl.startsWith(rl + '\\')) return;
      if (rl.startsWith(nl + '\\')) { roots.splice(i, 1); i--; }
    }
    roots.push(n);
  };
  for (const f of (sections.folders || [])) pushRoot(f);
  if (!roots.length) {
    const dirs = new Set();
    const addPath = (p) => {
      if (typeof p !== 'string' || !p) return;
      try { dirs.add(normPath(path.dirname(stripVirtual(p)))); } catch { }
    };
    for (const p of (sections.favorites || [])) addPath(p);
    for (const pl of (sections.playlists || [])) for (const p of (pl.paths || [])) addPath(p);
    for (const k of Object.keys(sections.stats || {})) addPath(k);
    for (const k of Object.keys(sections.analysis || {})) addPath(k);
    for (const d of dirs) pushRoot(d);
  }
  return roots.slice(0, 50);
}

function buildPackage(store, opts) {
  opts = opts || {};
  const sections = collectSections(store, opts.sections, opts.listenStats);
  const counts = countsOf(sections);
  return {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    app: String(opts.appName || ''),
    ver: String(opts.appVer || ''),
    time: new Date().toISOString(),
    sections,
    counts,
    roots: extractRoots(sections)
  };
}

/* 导出面板预估：各分区条目数 + 序列化字节数（listenStats 由渲染层传入参与估算） */
function estimate(store, listenStats) {
  const sections = collectSections(store, null, listenStats);
  const out = {};
  for (const name of SECTIONS) {
    if (!sections[name]) continue;
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(sections[name]), 'utf8'); } catch { }
    const c = countsOf({ [name]: sections[name] });
    out[name] = { count: c[name] || 0, bytes };
  }
  return out;
}

/* ---------------- 校验与视图归一（v1 → v2） ---------------- */

function normalize(pkg) {
  if (!pkg || typeof pkg !== 'object') throw new Error('备份文件不是有效的 JSON 对象');
  if (pkg.kind !== KIND) throw new Error('不是有效的安妮备份文件（缺少 kind 标记）');
  const ver = Number(pkg.schemaVersion) || 1;
  if (ver >= 2) {
    if (!pkg.sections || typeof pkg.sections !== 'object') throw new Error('备份文件损坏（缺少 sections）');
    const s = pkg.sections;
    const view = {
      schemaVersion: ver,
      app: String(pkg.app || ''), ver: String(pkg.ver || ''), time: String(pkg.time || ''),
      sections: {
        settings: (s.settings && typeof s.settings === 'object') ? s.settings : {},
        folders: Array.isArray(s.folders) ? s.folders.filter(x => typeof x === 'string') : [],
        favorites: Array.isArray(s.favorites) ? s.favorites.filter(x => typeof x === 'string') : [],
        playlists: Array.isArray(s.playlists) ? s.playlists : [],
        streamPlaylists: Array.isArray(s.streamPlaylists) ? s.streamPlaylists : [],
        stats: (s.stats && typeof s.stats === 'object') ? s.stats : {},
        analysis: (s.analysis && typeof s.analysis === 'object') ? s.analysis : {}
      },
      roots: Array.isArray(pkg.roots) ? pkg.roots.filter(x => typeof x === 'string') : null
    };
    if (s.listenStats && typeof s.listenStats === 'object') view.sections.listenStats = s.listenStats;
    if (!view.roots || !view.roots.length) view.roots = extractRoots(view.sections);
    return view;
  }
  // v1：data 为平铺全键（含 folders/favorites/playlists/... + 设置键混排），包成 v2 视图
  const d = pkg.data;
  if (!d || typeof d !== 'object') throw new Error('备份文件损坏（缺少 data）');
  const settings = {};
  for (const k of Object.keys(d)) if (!STRUCT_KEYS.has(k)) settings[k] = d[k];
  const view = {
    schemaVersion: 1,
    app: String(pkg.app || ''), ver: String(pkg.ver || ''), time: String(pkg.time || ''),
    sections: {
      settings,
      folders: Array.isArray(d.folders) ? d.folders.filter(x => typeof x === 'string') : [],
      favorites: Array.isArray(d.favorites) ? d.favorites.filter(x => typeof x === 'string') : [],
      playlists: Array.isArray(d.playlists) ? d.playlists : [],
      streamPlaylists: Array.isArray(d.streamPlaylists) ? d.streamPlaylists : [],
      stats: (d.stats && typeof d.stats === 'object') ? d.stats : {},
      analysis: {} // v1 从未包含分析数据
    },
    roots: null
  };
  view.roots = extractRoots(view.sections);
  return view;
}

/* 导入第 1 步摘要（只读）：视图 + 各项数量 + 文件大小；validate 失败直接抛错 */
function inspectPackage(pkg, fileBytes) {
  const view = normalize(pkg);
  return {
    ok: true,
    schemaVersion: view.schemaVersion,
    app: view.app, ver: view.ver, time: view.time,
    counts: countsOf(view.sections),
    roots: view.roots,
    fileBytes: fileBytes || 0
  };
}

/* ---------------- 路径重映射（Slice C：跨机盘符/用户名不同） ----------------
 * rootMap: { 备份中的根: 本机对应根 }，如 {'C:\\Users\\mimi\\Music': 'D:\\乐库'}。
 * 前缀替换按路径边界匹配（根本身或 根\ 开头），大小写/斜杠归一比较，替换时保留原始后缀大小写。
 * CUE/ISO 虚拟轨的 #cueN/#isoN 后缀不动。 */

function remapOnePath(p, pairs) {
  if (typeof p !== 'string' || !p) return p;
  const m = p.match(VIRTUAL_RE);
  const suffix = m ? m[0] : '';
  const real = suffix ? p.slice(0, -suffix.length) : p;
  const nl = normPathLow(real);
  for (const [from, to] of pairs) {
    const fl = normPathLow(from);
    if (nl === fl) return normPath(to) + suffix;
    if (nl.startsWith(fl + '\\')) return normPath(to) + real.slice(normPath(from).length) + suffix;
  }
  return p;
}

function remapKeyObj(obj, pairs) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[remapOnePath(k, pairs)] = v;
  return out;
}

/* 对 normalize 后的 view 原地重写所有路径字段。返回改写的路径条数。 */
function remapViewPaths(view, rootMap) {
  const pairs = Object.entries(rootMap || {}).filter(([f, t]) => typeof f === 'string' && typeof t === 'string' && f && t);
  if (!pairs.length) return 0;
  let n = 0;
  const s = view.sections;
  const seen = new Set();
  const remapStr = (p) => {
    const r = remapOnePath(p, pairs);
    if (r !== p && !seen.has(p)) { seen.add(p); n++; }
    return r;
  };
  s.folders = (s.folders || []).map(remapStr);
  s.favorites = (s.favorites || []).map(remapStr);
  for (const pl of (s.playlists || [])) if (Array.isArray(pl.paths)) pl.paths = pl.paths.map(remapStr);
  s.stats = remapKeyObj(s.stats, pairs);
  s.analysis = remapKeyObj(s.analysis, pairs);
  return n;
}

/* roots 本机可达性 + 映射后预估匹配（apply 前的向导第 2 步用，fns 注入便于单测） */
function rootCheck(view, rootMap, fns) {
  const dirExists = (fns && fns.dirExists) || ((p) => { try { return require('fs').statSync(p).isDirectory(); } catch { return false; } });
  const fileExists = (fns && fns.fileExists) || ((p) => { try { return require('fs').statSync(p).isFile(); } catch { return false; } });
  const pairs = Object.entries(rootMap || {});
  const roots = (view.roots || []).map((root) => {
    const mapped = (rootMap || {})[root] || null;
    return {
      root,
      exists: dirExists(root),
      mapped,
      mappedExists: mapped ? dirExists(mapped) : null
    };
  });
  const all = new Set();
  for (const pl of (view.sections.playlists || [])) for (const p of (pl.paths || [])) all.add(p);
  for (const p of (view.sections.favorites || [])) all.add(p);
  for (const k of Object.keys(view.sections.stats || {})) all.add(k);
  for (const k of Object.keys(view.sections.analysis || {})) all.add(k);
  let matched = 0;
  for (const p of all) {
    const rp = remapOnePath(p, pairs);
    if (fileExists(rp.replace(VIRTUAL_RE, ''))) matched++;
  }
  return { roots, matched, total: all.size };
}

/* ---------------- 应用（覆盖 / 合并） ---------------- */

function newPlaylistId(prefix) {
  return (prefix || 'pl-') + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/* 合并 stats：同键数值字段相加，lastPlayed 取较大值（字段口径实测：{count,lastPlayed,totalSec}） */
function mergeStatsEntry(cur, inc) {
  const out = Object.assign({}, cur);
  for (const [k, v] of Object.entries(inc || {})) {
    if (typeof v === 'number') {
      if (k === 'lastPlayed') out[k] = Math.max(Number(out[k]) || 0, v);
      else out[k] = (Number(out[k]) || 0) + v;
    } else if (out[k] === undefined) out[k] = v;
  }
  return out;
}

/* apply 只改 store 对象；返回 {applied, listenStats, notes}。
 * sections 为本次要应用的分区名数组（缺省 = 备份里存在的全部）。 */
function applyToStore(store, view, opts) {
  opts = opts || {};
  const mode = opts.mode === 'merge' ? 'merge' : 'overwrite';
  const want = new Set(opts.sections && opts.sections.length ? opts.sections : Object.keys(view.sections));
  const s = view.sections;
  const applied = {};
  const notes = [];

  if (!Array.isArray(store.folders)) store.folders = [];
  if (!Array.isArray(store.favorites)) store.favorites = [];
  if (!Array.isArray(store.playlists)) store.playlists = [];
  if (!Array.isArray(store.streamPlaylists)) store.streamPlaylists = [];
  if (!store.stats || typeof store.stats !== 'object') store.stats = {};
  if (!store.metaCache || typeof store.metaCache !== 'object') store.metaCache = {};

  // —— 设置 ——
  if (want.has('settings') && s.settings && Object.keys(s.settings).length) {
    if (mode === 'overwrite') {
      for (const k of Object.keys(s.settings)) store[k] = s.settings[k];
      applied.settings = Object.keys(s.settings).length;
    } else {
      // 合并：只补当前不存在的键（「按备份补」）；ui 对象按键级补，不整体替换
      let n = 0;
      for (const [k, v] of Object.entries(s.settings)) {
        if (k === 'ui' && v && typeof v === 'object' && store.ui && typeof store.ui === 'object') {
          for (const [uk, uv] of Object.entries(v)) {
            if (store.ui[uk] === undefined) { store.ui[uk] = uv; n++; }
          }
        } else if (store[k] === undefined) { store[k] = v; n++; }
      }
      applied.settings = n;
    }
  }
  // —— 媒体库文件夹 ——
  if (want.has('folders') && s.folders) {
    if (mode === 'overwrite') { store.folders = s.folders.slice(); }
    else {
      const have = new Set(store.folders.map(normPathLow));
      for (const f of s.folders) if (!have.has(normPathLow(f))) { store.folders.push(f); have.add(normPathLow(f)); }
    }
    applied.folders = store.folders.length;
  }
  // —— 收藏 ——
  if (want.has('favorites') && s.favorites) {
    if (mode === 'overwrite') { store.favorites = s.favorites.slice(); }
    else {
      const have = new Set(store.favorites);
      for (const f of s.favorites) if (!have.has(f)) { store.favorites.push(f); have.add(f); }
    }
    applied.favorites = store.favorites.length;
  }
  // —— 自建歌单：同名合并 paths 并集；新名追加（id 撞车换新 id） ——
  if (want.has('playlists') && s.playlists) {
    if (mode === 'overwrite') {
      store.playlists = JSON.parse(JSON.stringify(s.playlists));
    } else {
      const byName = new Map(store.playlists.map(p => [p.name, p]));
      const ids = new Set(store.playlists.map(p => p.id));
      for (const raw of s.playlists) {
        if (!raw || typeof raw !== 'object') continue;
        const existing = byName.get(raw.name);
        if (existing) {
          const have = new Set(existing.paths || []);
          if (!Array.isArray(existing.paths)) existing.paths = [];
          for (const p of (raw.paths || [])) {
            if (typeof p === 'string' && !have.has(p)) { existing.paths.push(p); have.add(p); }
          }
        } else {
          const pl = JSON.parse(JSON.stringify(raw));
          if (!Array.isArray(pl.paths)) pl.paths = [];
          if (!pl.id || ids.has(pl.id)) pl.id = newPlaylistId('pl-');
          ids.add(pl.id);
          store.playlists.push(pl);
          byName.set(pl.name, pl);
        }
      }
    }
    applied.playlists = store.playlists.length;
  }
  // —— 在线歌单：按 id 去重追加 ——
  if (want.has('streamPlaylists') && s.streamPlaylists) {
    if (mode === 'overwrite') {
      store.streamPlaylists = JSON.parse(JSON.stringify(s.streamPlaylists));
    } else {
      const ids = new Set(store.streamPlaylists.map(p => p.id));
      for (const raw of s.streamPlaylists) {
        if (!raw || typeof raw !== 'object' || !raw.id) continue;
        if (ids.has(raw.id)) continue;
        const pl = JSON.parse(JSON.stringify(raw));
        if (!Array.isArray(pl.items)) pl.items = [];
        store.streamPlaylists.push(pl);
        ids.add(pl.id);
      }
    }
    applied.streamPlaylists = store.streamPlaylists.length;
  }
  // —— 收听统计：同键 count/totalSec 相加，lastPlayed 取大 ——
  if (want.has('stats') && s.stats) {
    if (mode === 'overwrite') {
      store.stats = JSON.parse(JSON.stringify(s.stats));
    } else {
      for (const [k, v] of Object.entries(s.stats)) {
        store.stats[k] = store.stats[k] ? mergeStatsEntry(store.stats[k], v) : JSON.parse(JSON.stringify(v));
      }
    }
    applied.stats = Object.keys(store.stats).length;
  }
  // —— 分析数据（写 metaCache，仅白名单字段） ——
  if (want.has('analysis') && s.analysis) {
    if (mode === 'overwrite') store.metaCache = {};
    let n = 0;
    for (const [k, v] of Object.entries(s.analysis)) {
      const picked = pickAnalysisEntry(v);
      if (!Object.keys(picked).length) continue;
      store.metaCache[k] = mode === 'overwrite' ? picked : Object.assign({}, store.metaCache[k], picked);
      n++;
    }
    applied.analysis = n;
  }
  // —— 听歌报告（渲染层 localStorage，原样带回由渲染层处理） ——
  let listenStats = null;
  if ((want.has('listenStats') || want.has('stats')) && s.listenStats) {
    listenStats = s.listenStats; // 覆盖/合并都由渲染层决定（本机已有报告时合并模式跳过）
    applied.listenStats = 1;
  }

  // 导入后旧的体检撤销快照引用可能已不存在，必须清掉防止误撤销
  if (store.healthUndo) { store.healthUndo = null; notes.push('healthUndo-cleared'); }

  return { mode, applied, listenStats, notes };
}

module.exports = {
  KIND, SCHEMA_VERSION, SECTIONS, ANALYSIS_FIELDS, STRUCT_KEYS,
  buildPackage, estimate, normalize, inspectPackage, extractRoots, applyToStore,
  pickAnalysisEntry, normPath, remapViewPaths, remapOnePath, rootCheck
};
