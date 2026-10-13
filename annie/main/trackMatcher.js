'use strict';
/* V4.4.2 Slice C：曲目指纹五级匹配（从 main.js 抽出共享，.anniepl 导入与备份迁移二次匹配共用）。
 * 逻辑与 V4.3.25 内联版完全一致，未改行为：
 *   ① 绝对路径直配 ② 相对媒体库根拼接 ③ 文件名+大小 ④ 同名+时长(±1.5s) ⑤ 标题+艺人+时长(±2s)
 * items: [{path, rel, file, size, duration, title, artist}]
 * 返回 { matched:[本机路径], missing:[{file,title,artist}] }（与 items 顺序对应） */

const normPlPath = (s) => String(s == null ? '' : s).replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
const normPlText = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');

function matchTracks(items, store) {
  const tracks = store.tracks || [];
  const metas = store.metaCache || {};
  const folders = (store.folders || []).map(f => normPlPath(f));
  const pushList = (mp, k, v) => { const a = mp.get(k); if (a) a.push(v); else mp.set(k, [v]); };
  const byPath = new Map(), byBaseSize = new Map(), byBase = new Map(), byTA = new Map();
  for (const t of tracks) {
    const p = t && t.path;
    if (typeof p !== 'string') continue;
    const n = normPlPath(p);
    const base = n.split('\\').pop();
    byPath.set(n, p);
    const m = metas[p] || {};
    if (m.fileSize) pushList(byBaseSize, base + '|' + m.fileSize, p);
    pushList(byBase, base, p);
    if (m.title) pushList(byTA, normPlText(m.title) + '|' + normPlText(m.artist || ''), p);
  }
  // 从候选里挑未占用、时长最接近的；无时长线索时仅候选唯一才采信（避免误配同名文件）
  const used = new Set();
  const pick = (cands, srcDur, tol) => {
    let best = null, bd = tol;
    for (const p of cands) {
      if (used.has(p)) continue;
      const d = (metas[p] || {}).duration || 0;
      if (srcDur && d) {
        const df = Math.abs(d - srcDur);
        if (df <= tol && df < bd) { bd = df; best = p; }
      } else if (!srcDur) {
        const avail = cands.filter(x => !used.has(x));
        if (avail.length === 1) best = avail[0]; // 双方都无时长可比，仅一个可用候选才采信
      }
    }
    return best;
  };
  const matched = [], missing = [];
  const perItem = []; // V4.4.2 Slice C：逐条结果（备份迁移回写要对齐原数组下标）
  for (const it of (items || [])) {
    let cand = null;
    const n = normPlPath(it.path || '');
    // ① 绝对路径直配
    if (n) { const x = byPath.get(n); if (x && !used.has(x)) cand = x; }
    // ② 相对媒体库根拼接（盘符/用户名/目录结构不同，只要相对后缀一致即可）
    if (!cand && it.rel) {
      for (const f of folders) {
        const x = byPath.get(f + '\\' + normPlPath(it.rel));
        if (x && !used.has(x)) { cand = x; break; }
      }
    }
    const baseRaw = String(it.file || '').replace(/#(cue|iso)\d+$/i, '');
    const base = normPlPath(baseRaw).split('\\').pop() || n.split('\\').pop();
    // ③ 文件名 + 大小
    if (!cand && base && it.size) {
      const a = byBaseSize.get(base + '|' + it.size);
      if (a) cand = a.find(x => !used.has(x)) || null;
    }
    // ④ 同名文件 + 时长近邻（容差 1.5s）
    if (!cand && base) {
      const a = byBase.get(base);
      if (a) cand = pick(a, it.duration || 0, 1.5);
    }
    // ⑤ 标题 + 艺人 + 时长近邻（容差 2s；目录/文件名全变、标签还在时兜底）
    if (!cand && it.title) {
      const a = byTA.get(normPlText(it.title) + '|' + normPlText(it.artist || ''));
      if (a) cand = pick(a, it.duration || 0, 2);
    }
    if (cand) { used.add(cand); matched.push(cand); perItem.push(cand); }
    else { missing.push({ file: it.file || it.path || '', title: it.title || '', artist: it.artist || '' }); perItem.push(null); }
  }
  return { matched, missing, perItem };
}

module.exports = { matchTracks, normPlPath, normPlText };
