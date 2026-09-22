'use strict';
/* 安妮播放器 V1 预览版 (Annie Player V1 Preview) —— 播放界面逻辑
 * 播放链路：UI → window.mine.engine(主进程) → AnnieEngine.exe（WASAPI 独占 / ASIO）
 * 视觉链路：window.annieStage（stage-adapter.js）→ Mineradio 歌词舞台 + 粒子 */

const $ = (s) => document.querySelector(s);

const state = {
  library: { folders: [], tracks: [], volume: 1, backend: null, favorites: [], metaCache: {} },
  queue: [],
  index: -1,
  playing: false,
  duration: 0,
  position: 0,
  seeking: false,
  seekPending: false,  // V1.1.4：seek 保护——引擎 seek 未完成前，旧 position 事件不得拉回进度条
  seekTarget: 0,
  seekTimer: 0,
  _posAt: 0,             // V1.1.7：最近一次 position 事件到达时刻（进度插值锚点）
  metaCache: new Map(),
  currentPath: null,
  currentStream: null, // 正在播放的流媒体曲目（本地播放时为 null）
  backendKind: 'wasapi',
  favorites: new Set(),   // 喜爱曲目路径集合
  tagCache: {},           // 排序用标签缓存（来自 store.metaCache）
  folderFilter: null,     // null=全部音乐 | 'favorites'=我的喜爱 | 文件夹路径
  treeExpanded: new Set(),// 文件夹树展开状态
  tagLoading: false,      // 批量标签加载中
  viewMode: 'tree',       // 'tree'=平铺文件夹导航 | 'grid'=文件夹图标网格
  gridPath: null,         // 网格视图当前所在文件夹（null=根层级）
  libNav: { mode: 'folders', folder: null }, // V1.1.0：folders=平铺文件夹 | tracks=文件夹内曲目
};

/* ---------------- 工具 ---------------- */
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

/* ---------------- 曲库 ---------------- */
/* SVLX 同步 beta0.0.3：曲库路径索引（path → track），O(1) 查找，替代全表线性扫描。
 * 在 tracks 各变更点增量维护；size 不一致时惰性重建兜底。 */
state.libIndex = new Map();
function rebuildLibIndex() {
  state.libIndex.clear();
  const ts = state.library.tracks || [];
  for (let i = 0; i < ts.length; i++) state.libIndex.set(ts[i].path, ts[i]);
}
function libHas(path) {
  if (state.libIndex.size !== (state.library.tracks || []).length) rebuildLibIndex();
  return state.libIndex.has(path);
}
async function loadLibrary() {
  state.library = await window.mine.getLibrary();
  rebuildLibIndex();
  state.favorites = new Set(state.library.favorites || []);
  state.tagCache = state.library.metaCache || {};
  state._tagVer = (state._tagVer || 0) + 1; // V3.1：视图缓存失效
  // 文件夹被移除后，过滤条件可能失效
  if (state.folderFilter && state.folderFilter !== 'favorites'
    && !state.library.folders.some(f => isPathUnder(state.folderFilter, f) || isPathUnder(f, state.folderFilter))) {
    state.folderFilter = null;
  }
  renderFolders();
  renderFolderTree();
  renderCurrentView();
}

function renderFolders() {
  const box = $('#folder-list');
  box.innerHTML = '';
  for (const f of state.library.folders) {
    const row = document.createElement('div');
    row.className = 'folder-chip';
    row.innerHTML = `<span title="${f}">📁 ${f}</span><b title="移除">✕</b>`;
    row.querySelector('b').onclick = async () => {
      state.library = await window.mine.removeFolder(f);
      if (state.folderFilter === f || isPathUnder(state.folderFilter, f)) state.folderFilter = null;
      renderFolders(); renderFolderTree(); renderCurrentView();
    };
    box.appendChild(row);
  }
}

/* ---------------- 文件夹树 ---------------- */
// 路径包含判断（统一分隔符后做前缀匹配）
function normPath(p) { return String(p || '').replace(/\//g, '\\').replace(/\\+$/, ''); }
function isPathUnder(p, dir) {
  if (!p || !dir) return false;
  const np = normPath(p), nd = normPath(dir);
  return np === nd || np.startsWith(nd + '\\');
}

// 从 tracks 的 dir 构建嵌套树：根 = library.folders，子节点 = 相对路径逐层拆分
function buildFolderTree() {
  const roots = [];
  for (const root of state.library.folders) {
    const node = { name: root.split(/[\\/]/).filter(Boolean).pop() || root, path: root, count: 0, children: new Map() };
    roots.push(node);
  }
  const findRoot = (dir) => roots.find(r => isPathUnder(dir, r.path));
  for (const t of state.library.tracks) {
    const root = findRoot(t.dir);
    if (!root) continue;
    root.count++;
    const rel = normPath(t.dir).slice(normPath(root.path).length).replace(/^\\/, '');
    if (!rel) continue;
    let cur = root;
    for (const part of rel.split('\\')) {
      if (!cur.children.has(part)) {
        cur.children.set(part, { name: part, path: cur.path + '\\' + part, count: 0, children: new Map() });
      }
      cur = cur.children.get(part);
      cur.count++;
    }
  }
  return roots;
}

function renderFolderTree() {
  const box = $('#folder-tree');
  if (!box) return; // V1.1.0：粒子舞台树已替换为平铺导航；FB2K 侧走自己的 rebuildTree
  box.innerHTML = '';
  const frag = document.createDocumentFragment();

  // 固定节点：全部音乐 / 我的喜爱
  const mkSpecial = (key, icon, label, count) => {
    const row = document.createElement('div');
    row.className = 'tree-node special' + (state.folderFilter === key ? ' active' : '');
    row.style.paddingLeft = '14px';
    const ic = document.createElement('span'); ic.className = 'tree-icon'; ic.textContent = icon;
    const nm = document.createElement('span'); nm.className = 'tree-name'; nm.textContent = label;
    const ct = document.createElement('span'); ct.className = 'tree-count'; ct.textContent = count;
    row.append(ic, nm, ct);
    row.onclick = () => { state.folderFilter = key; renderFolderTree(); renderTracks(); };
    frag.appendChild(row);
  };
  mkSpecial(null, '🎵', '全部音乐', state.library.tracks.length);
  mkSpecial('favorites', '♥', '我的喜爱', state.favorites.size);

  // 文件夹节点（递归）
  const renderNode = (node, depth) => {
    const hasKids = node.children.size > 0;
    const expanded = state.treeExpanded.has(node.path);
    const row = document.createElement('div');
    row.className = 'tree-node' + (state.folderFilter === node.path ? ' active' : '');
    row.style.paddingLeft = (14 + depth * 14) + 'px';
    row.title = node.path;
    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow' + (hasKids ? (expanded ? ' open' : '') : ' leaf');
    arrow.textContent = hasKids ? '▸' : '';
    arrow.onclick = (e) => {
      e.stopPropagation();
      if (expanded) state.treeExpanded.delete(node.path); else state.treeExpanded.add(node.path);
      renderFolderTree();
    };
    const ic = document.createElement('span'); ic.className = 'tree-icon'; ic.textContent = expanded && hasKids ? '📂' : '📁';
    const nm = document.createElement('span'); nm.className = 'tree-name'; nm.textContent = node.name;
    const ct = document.createElement('span'); ct.className = 'tree-count'; ct.textContent = node.count;
    row.append(arrow, ic, nm, ct);
    row.onclick = () => {
      state.folderFilter = state.folderFilter === node.path ? null : node.path;
      renderFolderTree(); renderTracks();
    };
    frag.appendChild(row);
    if (hasKids && expanded) {
      const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN-u-co-pinyin'));
      for (const k of kids) renderNode(k, depth + 1);
    }
  };

  for (const root of buildFolderTree()) {
    if (!state.treeExpanded.has(root.path) && state.treeExpanded.size === 0) state.treeExpanded.add(root.path);
    renderNode(root, 0);
  }
  box.appendChild(frag);
}

/* ---------------- 文件夹图标网格视图 ---------------- */
function findTreeNode(roots, target) {
  for (const r of roots) {
    if (normPath(r.path) === normPath(target)) return r;
    const found = findTreeNode([...r.children.values()], target);
    if (found) return found;
  }
  return null;
}

// 父级路径：根文件夹的父级为 null（回到根层级），其余截掉最后一段
function parentPathOf(p, roots) {
  const norm = normPath(p);
  if (roots.some(r => normPath(r.path) === norm)) return null;
  const idx = norm.lastIndexOf('\\');
  return idx > 0 ? norm.slice(0, idx) : null;
}

function directTracksOf(folderPath) {
  return state.library.tracks.filter(t => normPath(t.dir) === normPath(folderPath));
}

/* V1.1.0：视图渲染入口
 * grid=文件夹图标网格（旧逻辑保留）；tree 模式改为平铺文件夹导航：
 * folders=平铺显示所有文件夹（不显示曲目）→ tracks=仅显示所选文件夹内曲目 */
function renderCurrentView() {
  if (state.viewMode === 'grid') { renderFolderGrid(); updateLibNav(); return; }
  // Pro beat0.0.1：媒体库视图（专辑网格 / 艺术家列表）
  if (state.libNav.mode === 'albums' && window.anniePro) { window.anniePro.renderAlbumGrid(); updateLibNav(); return; }
  if (state.libNav.mode === 'artists' && window.anniePro) { window.anniePro.renderArtistList(); updateLibNav(); return; }
  if (state.libNav.mode === 'folders') renderFlatFolders();
  else renderTracks();
  updateLibNav();
}

function renderViewMode() {
  const grid = state.viewMode === 'grid';
  $('#search').classList.toggle('hidden', grid);
  $('#track-list').classList.toggle('hidden', grid);
  $('#grid-view').classList.toggle('hidden', !grid);
  $('#lib-nav').classList.toggle('hidden', grid || state.libNav.mode !== 'tracks');
  $('#btn-view-toggle').classList.toggle('on', grid);
  renderCurrentView();
}

/* ---------- V1.1.0：平铺文件夹导航 ---------- */
/* 所有含曲目的文件夹平铺（无子文件夹的与其他子文件夹同级）；
 * 每行浅色标注归属的主文件夹（曲库根目录）。 */
function flatFolderRows() {
  const roots = buildFolderTree();
  const cmpZh = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN-u-co-pinyin');
  const rows = [
    { special: 'all', name: '全部音乐', sub: '曲库全部曲目', count: state.library.tracks.length, icon: '🎵' },
    { special: 'fav', name: '我的喜爱', sub: '收藏的曲目', count: state.favorites.size, icon: '♥' },
    // Pro beat0.0.1：智能列表 + 媒体库聚合入口
    ...(window.anniePro ? window.anniePro.legacySpecialRows() : []),
  ];
  const walkKids = (nodes, rootName) => {
    nodes.sort(cmpZh).forEach(k => {
      rows.push({ path: k.path, name: k.name, sub: rootName, count: k.count, icon: '📁' });
      walkKids([...k.children.values()], rootName);
    });
  };
  roots.forEach(r => {
    rows.push({ path: r.path, name: r.name, sub: '主文件夹', count: r.count, icon: '📂', isRoot: true });
    walkKids([...r.children.values()], r.name);
  });
  const kw = $('#search').value.trim().toLowerCase();
  if (!kw) return rows;
  return rows.filter(r => r.name.toLowerCase().includes(kw) || (r.sub || '').toLowerCase().includes(kw));
}

function renderFlatFolders() {
  lv = null; // 退出虚拟滚动状态（文件夹视图非虚拟化）
  const box = $('#track-list');
  box.innerHTML = '';
  const rows = flatFolderRows();
  const frag = document.createDocumentFragment();
  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'folder-row' + (r.special ? ' special' : '');
    row.innerHTML = `<span class="f-icon">${r.icon}</span><div class="t-body"><div class="t-name">${r.name}</div></div><span class="f-root">${r.sub}</span><span class="f-count">${r.count} 首</span>`;
    row.title = r.path || r.name;
    row.onclick = () => enterFolder(r);
    frag.appendChild(row);
  });
  box.appendChild(frag);
}

/* 进入文件夹：只显示其内曲目（递归含子文件夹，沿用 isPathUnder 过滤逻辑） */
function enterFolder(r) {
  // Pro beat0.0.1：智能列表 / 媒体库聚合入口
  if (r.special === 'albums') { state.libNav.mode = 'albums'; state.libNav.folder = null; state.folderFilter = null; renderCurrentView(); return; }
  if (r.special === 'artists') { state.libNav.mode = 'artists'; state.libNav.folder = null; state.folderFilter = null; renderCurrentView(); return; }
  if (r.special && r.special.startsWith('smart:')) {
    state.libNav.mode = 'tracks'; state.libNav.folder = r.special; state.folderFilter = r.special;
    renderCurrentView(); return;
  }
  state.libNav.mode = 'tracks';
  if (r.special === 'all') state.libNav.folder = null;
  else if (r.special === 'fav') state.libNav.folder = 'favorites';
  else state.libNav.folder = r.path;
  state.folderFilter = state.libNav.folder; // 复用既有曲目过滤逻辑
  renderCurrentView();
}

/* 返回平铺文件夹视图 */
function backToFolders() {
  state.libNav.mode = 'folders';
  state.libNav.folder = null;
  state.folderFilter = null;
  renderCurrentView();
}
$('#btn-lib-back').onclick = backToFolders;

function updateLibNav() {
  const nav = $('#lib-nav');
  const inTracks = state.viewMode !== 'grid' && (state.libNav.mode === 'tracks' || state.libNav.mode === 'albums' || state.libNav.mode === 'artists');
  nav.classList.toggle('hidden', !inTracks);
  if (inTracks) {
    const proLabel = window.anniePro ? window.anniePro.navLabel() : null;
    $('#lib-nav-name').textContent = proLabel
      || (state.libNav.mode === 'albums' ? '专辑'
      : state.libNav.mode === 'artists' ? '艺术家'
      : state.libNav.folder === 'favorites' ? '我的喜爱'
      : state.libNav.folder === null ? '全部音乐'
      : state.libNav.folder);
  }
}

/* V1.1.1：切回粒子舞台时，索引自动定位到正在播放的文件
 * （进入其所在文件夹的曲目视图，并滚动到播放行）；流媒体曲目不入库则保持现状
 * beta0.0.3 移植：O(1) 索引查找；网格视图自动切换为平铺视图；平滑滚动 + 高亮闪烁 */
function flashPlayingRowLegacy(attempts) {
  const box = $('#track-list');
  const row = box && box.querySelector('.track-row[data-path="' + String(state.currentPath).replace(/"/g, '\\"') + '"]');
  if (row) {
    row.classList.remove('locate-flash');
    void row.offsetWidth; // 重启动画
    row.classList.add('locate-flash');
    setTimeout(() => row.classList.remove('locate-flash'), 2000);
  } else if ((attempts || 0) < 4) {
    setTimeout(() => flashPlayingRowLegacy((attempts || 0) + 1), 300);
  }
}
async function locatePlayingLegacy() {
  if (!state.currentPath) return false;
  if (!libHas(state.currentPath)) return false; // O(1) 索引
  if (state.viewMode === 'grid') { // 网格视图无曲目列表，切到平铺视图再定位
    state.viewMode = 'tree';
    if (window.annieSettings) { annieSettings.ui.viewMode = 'tree'; annieSettings.save(); }
  }
  const dir = state.currentPath.replace(/[\\/][^\\/]+$/, '');
  state.libNav.mode = 'tracks';
  state.libNav.folder = dir;
  state.folderFilter = dir;
  await renderTracks();
  updateLibNav();
  if (lv) {
    const i = lv.pathIdx.get(state.currentPath); // O(1) 索引
    if (i !== undefined) {
      const box = $('#track-list');
      box.scrollTo({ top: Math.max(0, lv.pos[i] - box.clientHeight / 2), behavior: 'smooth' });
      renderVirtualWindow();
      setTimeout(() => flashPlayingRowLegacy(0), 350);
    }
  }
  return true;
}
document.addEventListener('annie-theme-changed', (e) => {
  if (e.detail && e.detail.theme === 'legacy') locatePlayingLegacy();
});

/* beta0.0.3 移植：一键定位当前播放文件（双主题分发）。
 * FB2K 主题走 annieFb2kLocate（树展开+列表定位），粒子舞台走本文件 locatePlayingLegacy。 */
window.annieLocatePlaying = () => {
  if (!state.currentPath) return;
  if (window.annieTheme && annieTheme.current === 'fb2k' && window.annieFb2kLocate) window.annieFb2kLocate();
  else locatePlayingLegacy();
};
const btnLocate = $('#btn-locate');
if (btnLocate) btnLocate.onclick = () => window.annieLocatePlaying();

function renderFolderGrid() {
  const roots = buildFolderTree();
  const grid = $('#folder-grid');
  const crumb = $('#grid-crumb');
  const back = $('#grid-back');
  grid.innerHTML = '';
  let nodes, tracks, parentPath = null;

  if (!state.gridPath) {
    nodes = roots;
    tracks = [];
    crumb.textContent = '全部文件夹';
    back.disabled = true;
  } else {
    const node = findTreeNode(roots, state.gridPath);
    if (!node) { state.gridPath = null; return renderFolderGrid(); } // 文件夹已被移除
    nodes = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN-u-co-pinyin'));
    tracks = sortTracks(directTracksOf(node.path));
    crumb.textContent = node.path;
    parentPath = parentPathOf(node.path, roots);
    back.disabled = false;
  }
  back.onclick = () => { state.gridPath = parentPath; renderFolderGrid(); };

  const frag = document.createDocumentFragment();
  if (!nodes.length && !tracks.length) {
    const empty = document.createElement('div');
    empty.className = 'grid-empty';
    empty.textContent = state.gridPath ? '此文件夹为空' : '尚未添加音乐文件夹';
    frag.appendChild(empty);
  }

  // 文件夹图标卡片：有子文件夹的用 🗂 + 角标，纯曲目文件夹用 📁
  for (const n of nodes) {
    const hasKids = n.children.size > 0;
    const card = document.createElement('div');
    card.className = 'grid-folder' + (hasKids ? ' has-kids' : '');
    card.title = n.path + (hasKids ? `\n包含 ${n.children.size} 个子文件夹` : '');
    card.innerHTML =
      `<div class="gf-icon">${hasKids ? '🗂' : '📁'}${hasKids ? `<span class="gf-badge">${n.children.size}</span>` : ''}</div>` +
      `<div class="gf-name">${n.name}</div>` +
      `<div class="gf-sub">${hasKids ? n.children.size + ' 个子文件夹 · ' : ''}${n.count} 首</div>`;
    card.onclick = () => { state.gridPath = n.path; renderFolderGrid(); };
    frag.appendChild(card);
  }

  // 当前文件夹直属曲目（点击即播，队列 = 当前文件夹曲目）
  if (tracks.length) {
    const head = document.createElement('div');
    head.className = 'grid-section';
    head.textContent = `曲目（${tracks.length}）`;
    frag.appendChild(head);
    // 播放中不覆写队列（同 renderTracks）
    if (!state.currentPath) state.queue = tracks;
    tracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'track-row' + (t.path === state.currentPath ? ' active' : '');
      const fav = state.favorites.has(t.path);
      row.innerHTML = `<div class="t-body"><div class="t-name">${t.name.replace(/\.[^.]+$/, '')}</div><div class="t-sub">${t.dir}</div></div><span class="fav-btn${fav ? ' on' : ''}" title="${fav ? '取消喜爱' : '添加到喜爱'}">${fav ? '♥' : '♡'}</span>`;
      row.querySelector('.fav-btn').onclick = (e) => { e.stopPropagation(); toggleFavorite(t.path); };
      row.onclick = () => { state.queue = tracks; playAt(i); };
      frag.appendChild(row);
    });
    ensureTagsForSort(tracks);
  }
  grid.appendChild(frag);
}

$('#btn-view-toggle').onclick = () => {
  state.viewMode = state.viewMode === 'grid' ? 'tree' : 'grid';
  if (window.annieSettings) { annieSettings.ui.viewMode = state.viewMode; annieSettings.save(); }
  renderViewMode();
};

/* ---------------- EXP 7.28：大列表排序 Web Worker 客户端（fb2k.js 共享） ----------------
 * >1000 首时排序移交 listWorker.js，主线程只做索引重排；
 * Worker 异常时 resolve(null)，调用方降级为同步排序，播放器不受影响。 */
window.annieListWorker = (() => {
  let w = null;
  try { w = new Worker('js/local/listWorker.js'); } catch (e) { console.warn('[list] Worker 不可用，同步排序兜底', e); }
  if (!w) return null;
  let seq = 0;
  const pending = new Map();
  w.onmessage = (e) => {
    const res = pending.get(e.data.jobId);
    if (res) { pending.delete(e.data.jobId); res(e.data); }
  };
  w.onerror = (err) => {
    console.warn('[list] Worker 异常，降级同步排序:', err.message || err);
    for (const [, res] of pending) res(null);
    pending.clear();
    try { w.terminate(); } catch { }
    w = null;
  };
  return {
    sort(job) {
      if (!w) return Promise.resolve(null);
      const jobId = ++seq;
      return new Promise(res => { pending.set(jobId, res); w.postMessage(Object.assign({ jobId }, job)); });
    }
  };
})();
let renderGen = 0; // 渲染代际：丢弃过期的异步排序结果
async function sortTracksOffloaded(tracks, mode) {
  if (tracks.length <= 1000 || !window.annieListWorker) return sortTracks(tracks);
  const r = await window.annieListWorker.sort({ op: 'legacy-sort', tracks, tagCache: state.tagCache, mode });
  if (!r || !r.order) return sortTracks(tracks); // Worker 失败兜底
  return r.order.map(i => tracks[i]);
}

/* ---------------- 排序 ---------------- */
const cmpName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN-u-co-pinyin');
const cmpZh = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN-u-co-pinyin');
const TAG_SORTS = new Set(['artist', 'album', 'genre', 'year']);

// 标签访问器：内嵌标签优先；WAV 等无标签文件从 文件名/父文件夹名 推导兜底
// 命名惯例：单曲集为「标题 - 艺术家」，CD 抓轨为「艺术家 - 标题」+ 文件夹「CDxx-艺术家 - 专辑」
function tagOf(t) {
  const tag = state.tagCache[t.path] || {};
  let artist = (tag.artist && tag.artist !== '未知艺术家') ? tag.artist : '';
  let album = tag.album || '';
  let year = tag.year || 0;
  const base = t.name.replace(/\.[^.]+$/, '');
  const dirName = t.dir.split(/[\\/]/).filter(Boolean).pop() || '';
  if (!artist) {
    const parts = base.split(' - ').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0], tail = parts[parts.length - 1];
      // 参考文件夹名判断方向：哪一段出现在文件夹名里，哪一段就是艺术家
      if (dirName.includes(first)) artist = first;
      else if (dirName.includes(tail)) artist = tail;
      else artist = tail; // 默认按「标题 - 艺术家」
    }
  }
  if (!album && dirName) {
    album = dirName.replace(/^CD\s*\d+\s*[-_]?\s*/i, '').trim();
  }
  if (!year) {
    const m = (dirName + ' ' + base).match(/(?<!\d)(19|20)\d{2}(?!\d)/);
    if (m) year = parseInt(m[0], 10);
  }
  return { artist, album, genre: tag.genre || '', year };
}

function sortTracks(tracks) {
  const mode = (window.annieSettings && annieSettings.ui.sortMode) || 'name';
  const arr = tracks.slice();
  const last = (v) => v ? v : '￿'; // 空标签排最后
  if (mode === 'folder') arr.sort((a, b) => cmpZh(a.dir, b.dir) || cmpName(a, b));
  else if (mode === 'mtime') arr.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  else if (mode === 'artist') arr.sort((a, b) => cmpZh(last(tagOf(a).artist), last(tagOf(b).artist)) || cmpName(a, b));
  else if (mode === 'album') arr.sort((a, b) => cmpZh(last(tagOf(a).album), last(tagOf(b).album)) || cmpName(a, b));
  else if (mode === 'genre') arr.sort((a, b) => cmpZh(last(tagOf(a).genre), last(tagOf(b).genre)) || cmpName(a, b));
  else if (mode === 'year') arr.sort((a, b) => ((tagOf(b).year || 0) - (tagOf(a).year || 0)) || cmpName(a, b));
  else arr.sort(cmpName);
  return arr;
}

/* ---------------- 分组标签 ---------------- */
const TAG_GROUP_LABEL = { artist: '艺术家', album: '专辑', genre: '流派', year: '年份' };
function groupKeyOf(t, mode) {
  const tag = tagOf(t);
  if (mode === 'artist') return tag.artist || '未知艺术家';
  if (mode === 'album') return tag.album || '未知专辑';
  if (mode === 'genre') return tag.genre || '未知流派';
  if (mode === 'year') return tag.year ? String(tag.year) : '未知年份';
  return '';
}

// 标签排序需要全量标签：后台分批拉取缺失项，每批完成后增量重排
async function ensureTagsForSort(viewTracks) {
  const mode = (window.annieSettings && annieSettings.ui.sortMode) || 'name';
  if (!TAG_SORTS.has(mode) || state.tagLoading) return;
  const missing = viewTracks.filter(t => !state.tagCache[t.path]).map(t => t.path);
  if (!missing.length) return;
  state.tagLoading = true;
  try {
    const CHUNK = 200;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      const fresh = await window.mine.metaBatch(chunk);
      Object.assign(state.tagCache, fresh);
      state._tagVer = (state._tagVer || 0) + 1; // V3.1：标签到达 → 视图缓存失效，按新标签重排
      /* EXP 7.28 修复：解析失败的文件（DSD/损坏/无标签容器）做会话级负缓存标记。
       * 否则它们永远处于 missing，metaBatch → renderTracks → ensureTagsForSort 形成
       * 无限重渲染循环，行节点被反复替换导致点击事件无法派发（粒子舞台点歌无响应）。 */
      for (const p of chunk) if (!state.tagCache[p]) state.tagCache[p] = {};
      renderTracks(); // state.tagLoading 仍为 true，不会重入
    }
  } catch (e) { console.warn('[library] metaBatch', e); }
  finally { state.tagLoading = false; }
}

/* ---------------- 喜爱 ---------------- */
async function toggleFavorite(trackPath) {
  const favs = await window.mine.toggleFavorite(trackPath);
  state.favorites = new Set(favs);
  state._favVer = (state._favVer || 0) + 1; // V3.1：收藏过滤视图缓存失效
  renderFolderTree(); // 更新"我的喜爱"计数
  renderCurrentView();
  updateFavCurBtn(); // Plus：同步底栏收藏按钮
}

/* V3.1：视图排序缓存（见 renderTracks） */
let viewCache = { key: '', tracks: null };

function currentViewTracks() {
  let list = state.library.tracks;
  const ff = state.folderFilter;
  if (ff === 'favorites') list = list.filter(t => state.favorites.has(t.path));
  // Pro beat0.0.1：智能列表 / 专辑 / 艺术家过滤
  else if (ff && ff.startsWith('smart:') && window.anniePro) list = window.anniePro.smartTracks(ff.slice(6));
  else if (ff && ff.startsWith('album:') && window.anniePro) list = window.anniePro.albumTracks(ff.slice(6));
  else if (ff && ff.startsWith('artist:') && window.anniePro) list = window.anniePro.artistTracks(ff.slice(7));
  else if (ff) list = list.filter(t => isPathUnder(t.dir, ff));
  const kw = $('#search').value.trim().toLowerCase();
  if (kw) list = list.filter(t => t.name.toLowerCase().includes(kw) || t.dir.toLowerCase().includes(kw));
  return list;
}

/* EXP 7.28：曲目行构建（虚拟滚动复用）
 * Plus：点击播放改为容器级 pointerdown/pointerup 委托（见 virtualRenderList）。
 * 原因：标签后台加载会替换行节点，若恰好发生在按下与抬起之间，per-row onclick
 * 永远不会派发（节点已换）；委托在容器上，抬起时命中同路径新节点仍可播放。 */
function buildTrackRow(t, qi, queueRef) {
  const row = document.createElement('div');
  row.className = 'track-row' + (t.path === state.currentPath ? ' active' : '');
  row.dataset.path = t.path;
  row.dataset.qi = qi;
  const fav = state.favorites.has(t.path);
  // Pro beat0.0.1：假无损 ⚠ 标记（批量频谱检测判定，悬浮显示理由）
  const fk = window.anniePro && window.anniePro.fakeMark(t.path);
  const fkHtml = fk ? `<span class="fake-warn" title="${(fk.reason || '疑似假无损').replace(/"/g, '&quot;')}">⚠</span>` : '';
  row.innerHTML = `<div class="t-body"><div class="t-name">${fkHtml}${t.name.replace(/\.[^.]+$/, '')}</div><div class="t-sub">${t.dir}</div></div><span class="fav-btn${fav ? ' on' : ''}" title="${fav ? '取消喜爱' : '添加到喜爱'}">${fav ? '♥' : '♡'}</span>`;
  row.querySelector('.fav-btn').onclick = (e) => { e.stopPropagation(); toggleFavorite(t.path); };
  return row;
}

/* EXP 7.28：虚拟滚动引擎（5000+ 首滚动 60fps）
 * 只渲染可视窗口 ±400px 的行；分组头不再 sticky（绝对定位冲突），以固定行高代替。 */
const LV_ROW_H = 48, LV_GROUP_H = 30;
let lv = null; // { spacer, rowsEl, rows, pos, total }
window.__lvReset = () => { lv = null; }; // Pro：pro.js 媒体库视图渲染前重置虚拟列表状态
function virtualRenderList(rows) {
  const box = $('#track-list');
  if (!lv) {
    box.innerHTML = '';
    const spacer = document.createElement('div');
    const rowsEl = document.createElement('div');
    box.appendChild(spacer); box.appendChild(rowsEl);
    lv = { spacer, rowsEl, rows: [], pos: null, total: 0 };
    box.addEventListener('scroll', renderVirtualWindow);
    /* Plus：容器级点击委托（抗节点替换）；queueRef 从行模型取 */
    let pressPath = null;
    box.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.track-row');
      pressPath = row && !e.target.closest('.fav-btn') ? row.dataset.path : null;
    });
    box.addEventListener('pointerup', (e) => {
      const row = e.target.closest('.track-row');
      if (row && pressPath && row.dataset.path === pressPath && !e.target.closest('.fav-btn')) {
        const i = lv.pathIdx.get(row.dataset.path); // SVLX 同步：Map O(1) 取代 findIndex 线性扫描
        if (i !== undefined) { state.queue = lv.rows[i].queueRef; playAt(lv.rows[i].qi); }
      }
      pressPath = null;
    });
  }
  lv.rows = rows;
  // beta0.0.3 移植：路径 → 行号 O(1) 索引（定位播放行时替代 findIndex 线性扫描）
  const pIdx = new Map();
  for (let ri = 0; ri < rows.length; ri++) if (rows[ri].type === 'track') pIdx.set(rows[ri].t.path, ri);
  lv.pathIdx = pIdx;
  lv.pos = new Float64Array(rows.length + 1);
  let y = 0;
  for (let i = 0; i < rows.length; i++) { lv.pos[i] = y; y += rows[i].type === 'group' ? LV_GROUP_H : LV_ROW_H; }
  lv.pos[rows.length] = y;
  lv.total = y;
  lv.spacer.style.height = y + 'px';
  renderVirtualWindow();
}
function renderVirtualWindow() {
  if (!lv) return;
  const box = $('#track-list');
  const st = box.scrollTop, h = box.clientHeight;
  let lo = 0, hi = lv.rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lv.pos[mid + 1] < st - 400) lo = mid + 1; else hi = mid; }
  const start = lo;
  let end = start;
  while (end < lv.rows.length && lv.pos[end] < st + h + 400) end++;
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const r = lv.rows[i];
    const node = r.type === 'group' ? r.node : buildTrackRow(r.t, r.qi, r.queueRef);
    node.style.position = 'absolute';
    node.style.top = lv.pos[i] + 'px';
    node.style.left = '0'; node.style.right = '0';
    node.style.height = (r.type === 'group' ? LV_GROUP_H : LV_ROW_H) + 'px';
    node.style.boxSizing = 'border-box';
    frag.appendChild(node);
  }
  lv.rowsEl.innerHTML = '';
  lv.rowsEl.appendChild(frag);
}

async function renderTracks() {
  const gen = ++renderGen;
  const filtered = currentViewTracks();
  // 标签排序模式：按维度值分组，插入分类标签头
  const mode = (window.annieSettings && annieSettings.ui.sortMode) || 'name';
  /* V3.1 性能：视图排序结果缓存。切歌/收藏/切主题触发的 renderTracks 此前每次都
   * 全库 filter + 拼音 localeCompare 全排（>1000 首还会走一次 Worker 往返）。
   * 键 = 过滤条件 + 搜索词 + 排序模式 + 库规模 + 标签版本 + 收藏版本；
   * 智能列表是动态视图（依赖播放统计），不参与缓存。 */
  const ff = state.folderFilter || '';
  const kw = ($('#search').value || '').trim();
  const useCache = !ff.startsWith('smart:');
  const ck = ff + '|' + kw + '|' + mode + '|' + state.library.tracks.length + '|' + (state._tagVer || 0) + '|' + (state._favVer || 0);
  let tracks;
  if (useCache && viewCache.key === ck) tracks = viewCache.tracks;
  else {
    tracks = await sortTracksOffloaded(filtered, mode); // EXP 7.28：>1000 首 Worker 排序
    if (gen !== renderGen) return; // 期间又有新渲染请求，丢弃过期结果
    if (useCache) viewCache = { key: ck, tracks };
  }
  if (gen !== renderGen) return;
  // 播放中不覆写队列：点击行时会钉住队列快照，覆写会导致索引/播放错位
  if (!state.currentPath) state.queue = tracks;
  const grouped = TAG_SORTS.has(mode);
  let groupSizes = null;
  if (grouped) {
    groupSizes = new Map();
    for (const t of tracks) {
      const k = groupKeyOf(t, mode);
      groupSizes.set(k, (groupSizes.get(k) || 0) + 1);
    }
  }
  const rows = [];
  let lastGroup = null;
  tracks.forEach((t, i) => {
    if (grouped) {
      const g = groupKeyOf(t, mode);
      if (g !== lastGroup) {
        lastGroup = g;
        const head = document.createElement('div');
        head.className = 'group-head';
        const dim = document.createElement('span'); dim.className = 'g-dim'; dim.textContent = TAG_GROUP_LABEL[mode];
        const nm = document.createElement('span'); nm.className = 'g-name'; nm.textContent = g;
        const ct = document.createElement('span'); ct.className = 'g-count'; ct.textContent = groupSizes.get(g) + ' 首';
        head.append(dim, nm, ct);
        rows.push({ type: 'group', node: head });
      }
    }
    rows.push({ type: 'track', t, qi: i, queueRef: tracks });
  });
  virtualRenderList(rows);
  ensureTagsForSort(filtered);
}

/* ---------------- EXP 7.28：Worker 曲库扫描（批量增量渲染 + 进度 + 取消） ---------------- */
let scanRenderTimer = null;
function scanProgressUI(text, cancellable) {
  let box = document.getElementById('scan-progress');
  if (!text) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement('div');
    box.id = 'scan-progress';
    document.body.appendChild(box);
  }
  box.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = text;
  box.appendChild(label);
  if (cancellable) {
    const btn = document.createElement('button');
    btn.textContent = '取消';
    btn.onclick = () => window.mine.scanCancel().catch(() => { });
    box.appendChild(btn);
  }
}
function renderScanIncremental() { // 批次到达时节流重绘，避免阻塞交互
  clearTimeout(scanRenderTimer);
  scanRenderTimer = setTimeout(() => { renderFolderTree(); renderCurrentView(); }, 250);
}
function startLibraryScan() {
  state.library.tracks = [];
  state.libIndex.clear();
  renderFolderTree(); renderCurrentView();
  scanProgressUI('扫描中…已发现 0 首', true);
  window.mine.scanStart().catch(() => scanProgressUI(null));
}
window.mine.onScanEvent((m) => {
  if (m.type === 'batch') {
    state.library.tracks.push(...m.tracks);
    for (const t of m.tracks) state.libIndex.set(t.path, t); // SVLX 同步：索引增量维护
    scanProgressUI(`扫描中…已发现 ${m.found} 首`, true);
    renderScanIncremental();
  } else if (m.type === 'cue') {
    // Pro beat0.0.1：CUE 分轨——移除整轨、并入虚拟分轨（metaCache 已在主进程写入）
    const hide = new Set(m.hidden || []);
    state.library.tracks = state.library.tracks.filter(t => !hide.has(t.path));
    state.library.tracks.push(...(m.tracks || []));
    rebuildLibIndex(); // SVLX 同步：CUE 变更后重建索引
    for (const t of (m.tracks || [])) {
      if (t.cueMeta) state.library.metaCache[t.path] = { title: t.cueMeta.title, artist: t.cueMeta.artist, album: t.cueMeta.album };
    }
    renderFolderTree(); renderCurrentView();
  } else if (m.type === 'done' || m.type === 'cancelled' || m.type === 'error') {
    scanProgressUI(null);
    if (m.fallback || m.type === 'error') {
      // 同步兜底 / Worker 崩溃：tracks 已在主进程入库，重新拉取
      window.mine.getLibrary().then(lib => { state.library = lib; rebuildLibIndex(); renderFolderTree(); renderCurrentView(); });
    } else {
      renderFolderTree(); renderCurrentView();
    }
  }
});

$('#btn-add-folder').onclick = async () => {
  state.library = await window.mine.pickFolder();
  renderFolders(); renderFolderTree(); renderCurrentView();
  startLibraryScan(); // EXP 7.28：Worker 异步扫描，不再阻塞主线程
};
$('#btn-rescan').onclick = () => startLibraryScan();
$('#search').oninput = renderCurrentView; // V1.1.0：文件夹视图/曲目视图都响应搜索
// Pro beat0.0.1：回车直达「本地 × 流媒体统一搜索视图」
$('#search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const kw = $('#search').value.trim();
  if (kw && window.annieStreamSearch) window.annieStreamSearch(kw);
});

/* ---------------- 侧栏收放 + 排序 ---------------- */
const SIDEBAR_MIN_W = 120;
const sidebarMaxW = () => Math.max(SIDEBAR_MIN_W, Math.round(window.innerWidth * 0.3));
const clampSidebarW = (w) => Math.max(SIDEBAR_MIN_W, Math.min(sidebarMaxW(), Math.round(w)));
function applySidebarWidth(w) { $('#sidebar').style.width = clampSidebarW(w) + 'px'; }

function applySidebar() {
  const collapsed = !!(window.annieSettings && annieSettings.ui.sidebarCollapsed);
  $('#layout').classList.toggle('collapsed', collapsed);
  $('#btn-expand').classList.toggle('hidden', !collapsed);
  // 恢复上次拖拽的宽度偏好
  if (window.annieSettings && annieSettings.ui.sidebarWidth) applySidebarWidth(annieSettings.ui.sidebarWidth);
}

/* 侧栏右缘拖拽调宽（120px ~ 窗口 30%，释放后持久化） */
const sidebarResizer = $('#sidebar-resizer');
let rsDrag = null;
sidebarResizer.addEventListener('pointerdown', (e) => {
  rsDrag = { x: e.clientX, w: $('#sidebar').getBoundingClientRect().width };
  $('#sidebar').classList.add('resizing');
  sidebarResizer.classList.add('dragging');
  try { sidebarResizer.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针 */ }
  e.preventDefault();
});
sidebarResizer.addEventListener('pointermove', (e) => {
  if (!rsDrag) return;
  applySidebarWidth(rsDrag.w + e.clientX - rsDrag.x);
});
function rsEnd() {
  if (!rsDrag) return;
  rsDrag = null;
  $('#sidebar').classList.remove('resizing');
  sidebarResizer.classList.remove('dragging');
  if (window.annieSettings) {
    annieSettings.ui.sidebarWidth = clampSidebarW($('#sidebar').getBoundingClientRect().width);
    annieSettings.save();
  }
}
sidebarResizer.addEventListener('pointerup', rsEnd);
sidebarResizer.addEventListener('pointercancel', rsEnd);
// 窗口缩小后重新钳制宽度，不超过 30% 上限
window.addEventListener('resize', () => {
  if ($('#sidebar').getBoundingClientRect().width > sidebarMaxW()) applySidebarWidth(sidebarMaxW());
});

$('#btn-collapse').onclick = () => {
  if (!window.annieSettings) return;
  annieSettings.ui.sidebarCollapsed = true;
  annieSettings.save();
  applySidebar();
};
$('#btn-expand').onclick = () => {
  if (!window.annieSettings) return;
  annieSettings.ui.sidebarCollapsed = false;
  annieSettings.save();
  applySidebar();
};

$('#sort-select').onchange = (e) => {
  if (!window.annieSettings) return;
  annieSettings.ui.sortMode = e.target.value;
  annieSettings.save();
  renderCurrentView();
};

// 设置面板改动后同步界面侧（排序下拉值、侧栏状态、曲目列表）
document.addEventListener('annie-settings-changed', () => {
  if (!window.annieSettings) return;
  $('#sort-select').value = annieSettings.ui.sortMode;
  applySidebar();
  renderCurrentView();
});

/* ---------------- Pro beat0.0.1：响度归一化（EBU R128，目标 -16 LUFS） ---------------- */
// V3.5.15：无缝播放开关（默认开；与交叉淡入独立——crossfade>0 时优先淡入淡出）
function gaplessOn() { return !!(window.annieSettings && annieSettings.ui.gapless !== false); }
const LOUD_TARGET = -16;
function loudGainFor(p) {
  if (!window.annieSettings || (annieSettings.ui.loudMode || 'off') === 'off') return 1;
  const mc = state.library.metaCache && state.library.metaCache[p];
  // V3.5.15：ReplayGain 标签直读优先（RG 基准 -18 LUFS，本机目标 -16 LUFS → +2dB 平移；免 ebur128 分析）
  if (mc && mc.rg) {
    const db = (annieSettings.ui.loudMode === 'album' && mc.rg.album != null) ? mc.rg.album : mc.rg.track;
    if (db != null) {
      let gain = Math.pow(10, (db + 2) / 20);
      // 真峰 headroom：归一化后峰值不超过 -1dBFS（RG peak 为线性峰值）
      if (typeof mc.rg.peak === 'number' && mc.rg.peak > 0) gain = Math.min(gain, 0.891 / mc.rg.peak);
      return Math.max(0.05, Math.min(4, gain));
    }
  }
  const L = mc && mc.loudness;
  if (!L) { queueLoudness(p); return 1; }
  let i = L.i;
  if (annieSettings.ui.loudMode === 'album' && mc.album) {
    let sum = 0, n = 0;
    for (const t of state.library.tracks) {
      const m2 = state.library.metaCache[t.path];
      if (m2 && m2.album === mc.album && m2.loudness) { sum += m2.loudness.i; n++; }
    }
    if (n) i = sum / n;
  }
  let gain = Math.pow(10, (LOUD_TARGET - i) / 20);
  // 与削波防护联动：真峰 headroom 限制，归一化后真峰不超过 -1dBTP
  if (typeof L.tp === 'number') gain = Math.min(gain, Math.pow(10, (-1.0 - L.tp) / 20));
  return Math.max(0.05, Math.min(4, gain));
}
const loudPending = new Set();
function queueLoudness(p) {
  if (!p || p.startsWith('http') || loudPending.has(p)) return;
  loudPending.add(p);
  window.mine.loudnessAnalyze(p).then(v => {
    loudPending.delete(p);
    if (!v) return;
    window.mine.loudnessSet({ [p]: v });
    const mc = state.library.metaCache[p] || (state.library.metaCache[p] = {});
    mc.loudness = v;
    if (state.currentPath === p) window.mine.engine('loud.set', { gain: loudGainFor(p) }).catch(() => { }); // 热应用
  }).catch(() => loudPending.delete(p));
}

/* Pro beat0.0.1：引擎通知（DoP 回退等）全局 toast（双主题可见） */
let proToastTimer = null;
function proToast(text, ms = 4200) {
  let t = document.getElementById('pro-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'pro-toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(proToastTimer);
  proToastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* V3.5.3：输出设备失效自愈——播放因设备问题（GUID 失效/热拔插/ASIO 驱动丢失）失败时，
 * 自动回退系统默认 WASAPI 输出并重试一次；用户无感，不再整链"播放失败"。 */
async function enginePlayRecover(method, params) {
  try { return await window.mine.engine(method, params, 30000); }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (!/WASAPI|ASIO|设备|AudioClient|0x8889/i.test(msg)) throw e; // 非设备问题（网络流/解码失败等）原样抛出
    const ex = typeof window.annieIsExclusive === 'function' ? window.annieIsExclusive() : true;
    await window.mine.engine('devices.select', { kind: 'wasapi', id: null, exclusive: ex });
    try { window.mine.saveSettings({ backend: 'wasapi' }); } catch { } // 覆盖失效的持久化设备
    try { proToast('输出设备失效，已回退到系统默认设备'); } catch { }
    return window.mine.engine(method, params, 30000); // 重试一次，仍失败则抛给上层提示
  }
}

/* Pro beat0.0.1：Bit-perfect 直通状态（绿点=直通 / 黄点+原因） */
function updateBpChip(d) {
  const chip = document.getElementById('bp-chip');
  if (!chip) return;
  chip.classList.remove('hidden');
  // V1.1.9：共享模式（独占开关熄灭）下物理上不可能 bit-perfect——系统混音器必然重采样，
  // 引擎的 bitPerfect 只代表"引擎自身未重采样"：圆点熄灭（灰、无发光）+ 文字标注共享。
  const isShared = !(typeof window.annieIsExclusive === 'function' ? window.annieIsExclusive() : true);
  const isDsd = (d.codec || '').toLowerCase().includes('dsd') || d.bitDepth === 1;
  const inFmt = isDsd
    ? `DSD ${(d.requestedRate / 2822400).toFixed(0)}x`
    : `${d.requestedRate / 1000}kHz/${d.bitDepth || '?'}bit`;
  const bp = isShared ? false : !!d.bitPerfect; // 共享模式一律非直通
  chip.classList.toggle('ok', bp);
  chip.classList.toggle('warn', !bp && !isShared); // 共享模式：两态都不亮（灰点熄灭）
  chip.classList.toggle('off', isShared); // V1.1.9：共享模式熄灭态
  // 文字：共享模式显式标注（旧实现只有 inFmt→outFormat，看不出直通状态）
  document.getElementById('bp-text').textContent = isShared
    ? `共享 · ${inFmt} → ${d.outFormat}`
    : `${inFmt} → ${d.outFormat}`;
  chip.title = isShared
    ? '共享输出（非直通）：系统混音器会重采样到设备格式；如需 bit-perfect 请点亮独占开关'
    : (bp ? 'Bit-perfect 源码率直通（无重采样）' : (d.reason || '非直通'));
}

/* ---------------- 播放 ---------------- */
// V1.1.4：本地快速切歌合并——150ms 窗口内连点累计目标，只执行最后一次（减少引擎设备开关）
const localSwitch = { timer: 0, target: null };
function cancelLocalSwitch() {
  clearTimeout(localSwitch.timer);
  localSwitch.timer = 0;
  localSwitch.target = null;
}
function requestLocalSwitch(dir) {
  localSwitch.target = Math.max(0, Math.min(state.queue.length - 1, (localSwitch.target !== null ? localSwitch.target : state.index) + dir));
  clearTimeout(localSwitch.timer);
  localSwitch.timer = setTimeout(() => {
    const t = localSwitch.target;
    cancelLocalSwitch();
    playAt(t);
  }, 150);
}
async function playAt(i, offsetSec = 0) {
  const t = state.queue[i];
  if (!t) return;
  cancelLocalSwitch(); // 明确指定目标（列表点击/自动切歌），取消未执行的合并
  // V1.1.4：切歌清除 seek 保护——否则新歌 position（从 0 起）永远达不到旧 seekTarget，
  // 进度条被 seekPending 冻结 10 秒（快速混合操作卡顿源）
  if (state.seekPending) { state.seekPending = false; clearTimeout(state.seekTimer); }
  // V1.1.5：取消流媒体侧未执行的切歌合并——否则用户点本地曲目后 150ms 定时器仍会开火，
  // playStreamAt 劫持播放（把刚播的本地曲目换成流媒体曲目）
  if (typeof cancelStreamSwitch === 'function') cancelStreamSwitch();
  state.index = i;
  state.currentPath = t.path;
  state.currentStream = null;
  state.currentCue = t.cue ? { start: t.cue.start || 0, end: t.cue.end } : null; // Pro：CUE 分轨边界
  state.position = offsetSec;
  renderCurrentView();
  // 渲染可能重排/覆写列表：按路径回捞索引，保证"上一曲/下一曲/自动续播"跟随实际播放曲目
  const qi = state.queue.findIndex(x => x && x.path === t.path);
  if (qi >= 0) state.index = qi;

  // Pro：响度归一化增益 + 交叉淡入（引擎内部条件不满足时自动回退普通播放）
  const loudGain = loudGainFor(t.path);
  const cf = window.annieSettings ? (annieSettings.ui.crossfadeSec || 0) : 0;
  let playPath = t.cue ? t.cue.src : t.path;
  let playOffset = t.cue ? (t.cue.start || 0) : offsetSec;
  // SVLX 1.2.0：SACD ISO 虚拟分轨——先解轨为临时 DSF（缓存命中则秒回），再正常播放
  if (t.iso) {
    setFormatChips([{ text: '正在从 SACD ISO 解轨（首次较慢）…', cls: '' }]);
    const r = await window.mine.isoExtract({ src: t.iso.src, no: t.iso.no });
    if (!r || !r.ok) {
      setFormatChips([{ text: 'ISO 解轨失败: ' + (r && r.error || '未知错误'), cls: 'warn' }]);
      return;
    }
    playPath = r.path; playOffset = 0;
    if (t.iso.dur && !state.duration) { state.duration = t.iso.dur; $('#t-total').textContent = fmtTime(t.iso.dur); }
  }
  const method = (cf > 0 || gaplessOn()) && playOffset === 0 ? 'play.crossfade' : 'play';
  try {
    await enginePlayRecover(method, { path: playPath, offsetSec: playOffset, loudGain });
  } catch (e) {
    setFormatChips([{ text: '播放失败: ' + e.message, cls: 'warn' }]);
  }
  showMeta(t.path);
  // 触发可视化分析（波形 / 频谱 / 无损检测）。
  // V1.1.9：延后 1.2s 启动——切歌瞬间引擎 ffmpeg 解码与分析 ffmpeg 同时全速解码会
  // 抢磁盘/CPU，导致分析首批帧延迟随机波动（频谱"渐进 vs 从无到有"差异根因）。
  // 延后等引擎解码进入稳态后，分析稳定快速启动。
  // SVLX：粒子舞台可见时执行；FB2K 主题且频谱开启时同样需要 FFT 帧（右栏频谱柱）。
  // AM 主题无可视化消费方，不白跑 ffmpeg 全曲解码；流媒体也不分析（避免全速下载整首网络流）。
  if (window.annieViz) {
    const _p = playPath;
    setTimeout(() => {
      const wantStage = !window.__legacyThemeHidden;
      const wantFb2k = window.annieTheme && annieTheme.current === 'fb2k'
        && window.annieFb2k && typeof annieFb2k.specWanted === 'function' && annieFb2k.specWanted();
      if ((wantStage || wantFb2k) && (state.currentPath === _p || state.currentStream?.url === _p)) window.annieViz.analyze(_p, null);
    }, 1200);
  }
}

/* ---------------- 流媒体播放入口（由 streaming.js 调用） ---------------- */
window.annieStreamPlay = async function (track) {
  state.currentPath = track.url;
  state.currentStream = track;
  state.index = -1; // 流媒体不占用本地队列索引
  state.position = 0;
  state.duration = track.duration || 0;
  renderTracks();

  // 视觉立即切换（++trackSwitchToken / reset 歌词 / 封面 / 节拍）——不等待引擎确认。
  // 原因：engine('play') 是 JSON-RPC，慢速网络流可能数秒甚至超时才确认；
  // 若等它，舞台上的歌词/封面（数据早已并行就绪）会被引擎确认时间阻塞。
  try {
    if (window.annieStage) {
      window.annieStage.playTrack({
        path: track.url,
        title: track.title,
        artist: track.artist,
        album: track.album,
        cover: track.cover,
        duration: track.duration || 0,
        sampleRate: 0,
        bitsPerSample: 0,
        codec: track.quality || '流媒体'
      });
    }
  } catch (e) { console.warn('[player] stage playTrack', e); }
  // playTrack 已完成（token 已更新）→ 通知调用方注入歌词/封面（同步时机，无竞态）
  if (track.onPlayed) { try { track.onPlayed(); } catch (e) { console.warn('[player] onPlayed', e); } }

  try {
    // V1.1.4：流媒体切歌同样走 crossfade（设备保持）——与本地 playAt 一致，避免高频设备开关
    const cf = window.annieSettings ? (annieSettings.ui.crossfadeSec || 0) : 0;
    const method = (cf > 0 || gaplessOn()) ? 'play.crossfade' : 'play';
    await enginePlayRecover(method, { path: track.url, offsetSec: 0, headers: track.headers });
  } catch (e) {
    setFormatChips([{ text: '流媒体播放失败: ' + e.message, cls: 'warn' }]);
    return false; // SVLX：返回值供 AM 主题弹出错误提示
  }
  // 悬浮信息层
  $('#thumb-title').textContent = track.title || '未知曲目';
  if (window.annieListenStats) annieListenStats.recordPlay(track.url, track); // V3.5.17：听歌统计（流媒体）
  if (window.annieSMTC) annieSMTC.setMeta(track); // V3.5.18：系统媒体浮层
  $('#thumb-artist').textContent = [track.artist, track.album].filter(Boolean).join(' · ');
  reportPlayerState(); // V3.5.8
  // V1.1.8：http 封面（kwcdn.kuwo.cn 等）经代理转 dataURL 再显示——
  // 直接赋 http 会被 CSP img-src 拦截，且会覆盖 doInject 已代理好的 dataURL
  if (track.cover) {
    if (/^https?:\/\//i.test(track.cover) && window.mine.streamCoverProxy) {
      window.mine.streamCoverProxy(track.cover).then(r => {
        if (r && r.url && state.currentStream === track) $('#thumb-cover').src = r.url;
      }).catch(() => { });
    } else $('#thumb-cover').src = track.cover;
  }
  if (track.duration) { $('#t-total').textContent = fmtTime(track.duration); }
  // 流媒体不做可视化分析：analyze 会让 ffmpeg 全速下载整首网络流，
  // 与引擎的实时拉流抢带宽导致音频卡顿（AM/FB2K 门控后粒子舞台下仍会触发）。
  // 舞台对无分析数据的曲目走实时回退渲染。
  return true; // SVLX：返回值供 AM 主题弹出错误提示
};

async function showMeta(p) {
  if (!state.metaCache.has(p)) state.metaCache.set(p, await window.mine.meta(p));
  const m = state.metaCache.get(p);
  if (state.currentPath !== p) return;
  if (window.annieListenStats) annieListenStats.recordPlay(p, m); // V3.5.17：听歌统计
  if (window.annieSMTC) annieSMTC.setMeta(m); // V3.5.18：系统媒体浮层
  $('#thumb-title').textContent = m.title || '未知曲目';
  reportPlayerState(); // V3.5.8
  $('#thumb-artist').textContent = [m.artist, m.album].filter(Boolean).join(' · ');
  if (m.cover) $('#thumb-cover').src = m.cover;
  // V1.1.8：本地无封面时清除残留——旧实现只在新封面存在时赋值，
  // 流媒体带封面 → 本地无封面切换时，上一首封面会残留不消失
  else $('#thumb-cover').removeAttribute('src');
  if (m.duration) { state.duration = m.duration; $('#t-total').textContent = fmtTime(m.duration); }
  // Plus：切歌微交互（封面交叉淡入 + 文本逐行滑入）
  const np = $('#np-overlay');
  np.classList.remove('np-enter'); void np.offsetWidth; np.classList.add('np-enter');
  updateFavCurBtn();
  // 喂给视觉舞台（封面/歌词/节拍分析由适配层接管）
  if (window.annieStage) window.annieStage.playTrack({ ...m, path: p });
}

/* ---------------- 引擎事件 ---------------- */
window.mine.onEngineEvent((event, d) => {
  switch (event) {
    case 'position':
      // Pro：CUE 分轨——位置/时长按分轨窗口显示，到分轨终点自动续播
      if (state.currentCue) {
        const cue = state.currentCue;
        state.duration = cue.end != null ? cue.end - cue.start : (d.duration || 0) - cue.start;
        state.position = Math.max(0, d.seconds - cue.start);
        if (cue.end != null && d.seconds >= cue.end - 0.12) {
          if (!state.seeking) updateProgress();
          playAt(state.index + 1);
          break;
        }
      } else {
        state.position = d.seconds;
        if (d.duration) state.duration = d.duration;
        else if (state.currentStream && window.annieStream) {
          // 流媒体引擎探测不到时长时，用平台元数据兜底
          const fb = window.annieStream.currentFallbackDuration();
          if (fb) state.duration = fb;
        }
      }
      // V1.1.4：seek 保护——引擎 seek 期间（ffprobe 探测/重缓冲）旧 position 事件持续到达，
      // 会把进度条拉回播放中位置造成"乱跳"；锁定目标位置直到引擎确认到达目标
      if (state.seekPending) {
        if (d.seconds >= state.seekTarget - 0.5) {
          state.seekPending = false;
          clearTimeout(state.seekTimer);
        }
      }
      // V1.1.7：插值锚点——记录引擎位置与到达时刻，rAF 外推实现连续滑动
      state._posAt = performance.now();
      if (!state.seeking && !state.seekPending) {
        updateProgress();
        if (window.annieViz) window.annieViz.setProgress(state.position, state.duration);
        startProgressInterp();
      }
      // V3.5.17：听歌统计——按 position 事件累计收听时长（暂停无事件自然停表）
      if (state.playing && window.annieListenStats) annieListenStats.tick(state.position);
      // V3.5.18：任务栏进度条 + 系统媒体浮层位置（1s 节流）
      if (performance.now() - _pbSentAt > 1000) {
        _pbSentAt = performance.now();
        window.mine.playerProgress({ ratio: state.duration > 0 ? state.position / state.duration : -1, playing: state.playing });
        if (window.annieSMTC) annieSMTC.setPosition(state.position, state.duration);
      }
      break;
    case 'state':
      state.playing = d.state === 'playing';
      $('#btn-play').textContent = state.playing ? '⏸' : '▶';
      reportPlayerState(); // V3.5.8：同步任务栏缩略图图标
      { const bp = $('#btn-play'); bp.classList.remove('pop'); void bp.offsetWidth; bp.classList.add('pop'); } // Plus：播放键回弹
      // V1.1.7：暂停→停止插值（position 冻结）；恢复→重置锚点（下一 position 事件重新起算）
      if (!state.playing) cancelProgressInterp();
      else state._posAt = performance.now();
      // V3.5.18：系统媒体浮层播放状态 + 任务栏进度条模式（正常/暂停/结束清除）
      if (window.annieSMTC) annieSMTC.setPlaying(state.playing);
      if (d.state === 'ended') window.mine.playerProgress({ ratio: -1, playing: false });
      else window.mine.playerProgress({ ratio: state.duration > 0 ? state.position / state.duration : -1, playing: state.playing });
      if (d.state === 'ended') {
        if (state.currentStream && window.annieStream) window.annieStream.playNext();
        else if (window.annieAutoNext && window.annieAutoNext()) { /* 播放模式/定时已接管（仅本地） */ }
        else playAt(state.index + 1);
      }
      break;
    case 'format': {
      state.backendKind = d.backend;
      // V1.1.9：共享模式（独占开关熄灭）下系统混音器必然重采样，不显示"源码率直通"
      const isShared = !(typeof window.annieIsExclusive === 'function' ? window.annieIsExclusive() : true);
      const chips = [
        { text: `${d.codec || '?'} ${d.bitDepth ? d.bitDepth + 'bit' : ''}`.trim(), cls: '' },
        { text: `${d.requestedRate / 1000}kHz`, cls: 'gold' },
        { text: `${d.backend === 'asio' ? 'ASIO' : (isShared ? 'WASAPI 共享' : 'WASAPI 独占')}`, cls: 'gold' },
        { text: d.device || '', cls: '' },
      ];
      if (isShared) chips.push({ text: '共享模式（系统重采样）', cls: 'warn' });
      else if (d.resampled) chips.push({ text: `已重采样到 ${d.sampleRate / 1000}kHz`, cls: 'warn' });
      else chips.push({ text: '源码率直通', cls: 'gold' });
      setFormatChips(chips);
      updateBpChip(d); // Pro：Bit-perfect 直通状态
      window.__lastFormat = d; // Pro：Now Playing 技术信息复用
      // V1.1.9：徽章联动独占开关——独占点亮（金黄 live）、共享熄灭（灰色）
      const isExcl = typeof window.annieIsExclusive === 'function' ? window.annieIsExclusive() : true;
      $('#tb-backend').textContent = `${d.backend === 'asio' ? 'ASIO' : (isExcl ? 'WASAPI 独占' : 'WASAPI 共享')} · ${d.device || ''}`;
      $('#tb-backend').classList.toggle('live', isExcl);
      break;
    }
    case 'backend':
      // V1.1.9：徽章联动独占开关
      {
        const isExcl = typeof window.annieIsExclusive === 'function' ? window.annieIsExclusive() : true;
        $('#tb-backend').textContent = `${d.kind === 'asio' ? 'ASIO' : (isExcl ? 'WASAPI 独占' : 'WASAPI 共享')} · ${d.device || ''}`;
        $('#tb-backend').classList.toggle('live', isExcl);
      }
      break;
    case 'engine-dead':
      $('#tb-backend').textContent = '引擎已退出';
      $('#tb-backend').classList.remove('live');
      break;
    case 'engine-crash-storm': // V3.5.16：熔断——连崩 6 次停止自动重启，明确指引
      $('#tb-backend').textContent = '引擎崩溃';
      $('#tb-backend').classList.remove('live');
      proToast('音频引擎反复崩溃（可能被安全软件拦截）。请检查 360/电脑管家等拦截记录，或点击播放重试；仍不行请到 设置中心 → 曲库工具 导出诊断信息反馈', 10000);
      break;
    case 'engine-restarted': // Pro beat0.0.1：崩溃守护——恢复播放位置与队列
      if (d.ok) {
        $('#tb-backend').textContent = '引擎已自动恢复';
        proToast('音频引擎已自动恢复');
        if (state.currentPath) {
          const t = state.queue[state.index];
          const path = t && t.cue ? t.cue.src : state.currentPath;
          const off = (t && t.cue ? (t.cue.start || 0) : 0) + state.position;
          const gain = loudGainFor(state.currentPath);
          applyAudioSettings()
            .then(() => window.mine.engine('volume.set', { gain: (+$('#volume').value) / 100 }))
            .then(() => window.mine.engine('play', { path, offsetSec: off, loudGain: gain }, 30000))
            .catch(() => { });
        }
      } else {
        proToast('音频引擎重启失败，请检查输出设备', 6000);
      }
      break;
    case 'notify': // Pro：引擎通知（DoP 回退 / Native 不支持等）
      proToast(d.text || '');
      break;
  }
});

/* ---------------- V3.5.8：播放状态上报（任务栏缩略图 / 窗口标题） ---------------- */
let _psTimer = 0;
let _pbSentAt = 0; // V3.5.18：任务栏进度条/SMTC 位置 1s 节流锚点
function reportPlayerState() {
  if (_psTimer) return; // 合并连发（state 事件密集时）
  _psTimer = setTimeout(() => {
    _psTimer = 0;
    try {
      const t = $('#thumb-title') ? $('#thumb-title').textContent : '';
      const a = $('#thumb-artist') ? $('#thumb-artist').textContent : '';
      window.mine.playState({ playing: state.playing, title: t && t !== '—' ? (a ? t + ' · ' + a : t) : '' });
    } catch { }
  }, 120);
}

function setFormatChips(chips) {
  $('#np-format').innerHTML = chips.map(c => `<span class="fmt-chip ${c.cls}">${c.text}</span>`).join('');
}

/* ---------------- 传输控制 ---------------- */
// V1.1.7：进度插值状态——引擎 position 事件 10Hz，直接更新进度条会"一格一格跳"；
// 事件到达时记锚点（position + 到达时刻），rAF 循环按播放速率外推，进度条连续平滑滑动。
function updateProgress(pos) {
  const p = pos !== undefined ? pos : state.position;
  const pct = state.duration > 0 ? Math.min(100, p / state.duration * 100) : 0;
  $('#progress-fill').style.width = pct + '%';
  $('#progress-knob').style.left = pct + '%';
  $('#t-cur').textContent = fmtTime(p);
  $('#t-total').textContent = fmtTime(state.duration);
}
let _interpRaf = 0;
function cancelProgressInterp() {
  if (_interpRaf) { cancelAnimationFrame(_interpRaf); _interpRaf = 0; }
}
function startProgressInterp() {
  if (_interpRaf || !state.playing) return;
  const tick = () => {
    _interpRaf = 0;
    // 暂停/seek 保护/拖动中不插值（等 position 事件恢复锚点）
    if (!state.playing || state.seeking || state.seekPending) return;
    const dt = (performance.now() - state._posAt) / 1000;
    if (dt < 0 || dt > 5) return; // 锚点过期（引擎事件停滞），等下个事件刷新
    const disp = state.position + dt;
    // AM/FB2K 主题下舞台进度条隐藏，跳过 DOM 写入（其自身进度条由 position 事件驱动）
    if (!window.__legacyThemeHidden) updateProgress(disp);
    if (window.annieViz) window.annieViz.setProgress(disp, state.duration);
    _interpRaf = requestAnimationFrame(tick);
  };
  _interpRaf = requestAnimationFrame(tick);
}

$('#btn-play').onclick = async () => {
  if (state.currentPath) {
    try { await window.mine.engine(state.playing ? 'pause' : 'resume'); } catch { }
  } else if (state.queue.length) playAt(0);
};
// 流媒体播放时 state.index = -1（不占用本地队列索引），下一首/上一首必须走
// streaming.js 的播放队列（window.annieStream），否则会误播本地队列第 0 首。
$('#btn-next').onclick = () => {
  if (state.currentStream && window.annieStream) window.annieStream.playNext();
  else requestLocalSwitch(1); // V1.1.4：合并连点，只执行最后一次
};
$('#btn-prev').onclick = () => {
  if (state.currentStream && window.annieStream && window.annieStream.playPrev) window.annieStream.playPrev(state.position);
  else { if (state.position > 3) playAt(state.index); else requestLocalSwitch(-1); } // V1.1.4：合并连点
};
$('#btn-stop').onclick = () => {
  // V1.1.5：stop 立即解除 seek 保护——否则停止后 seekPending 残留，下次播放进度条被冻结
  if (state.seekPending) { state.seekPending = false; clearTimeout(state.seekTimer); }
  window.mine.engine('stop').catch(() => { });
};

// 进度条拖动
(() => {
  const bar = $('#progress');
  const seekTo = (e) => {
    const r = bar.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const sec = pct * state.duration;
    $('#progress-fill').style.width = pct * 100 + '%';
    $('#progress-knob').style.left = pct * 100 + '%';
    $('#t-cur').textContent = fmtTime(sec);
    return sec;
  };
  let sec = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (!state.currentPath || !state.duration) return;
    cancelProgressInterp(); // V1.1.7：拖动期间暂停插值，避免 rAF 外推与拖动手竞争
    state.seeking = true; sec = seekTo(e);
    const move = (ev) => { sec = seekTo(ev); };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      state.seeking = false;
      // V1.1.4：seek 保护——锁定目标位置，引擎 seek 完成前旧 position 不拉回（见 position 处理）
      state.seekPending = true;
      state.seekTarget = sec;
      clearTimeout(state.seekTimer);
      state.seekTimer = setTimeout(() => { state.seekPending = false; }, 10000);
      try { await window.mine.engine('seek', { seconds: (state.currentCue ? state.currentCue.start : 0) + sec }, 30000); }
      catch { state.seekPending = false; clearTimeout(state.seekTimer); } // V1.1.5：seek 失败立即解除冻结，避免进度条锁死 10 秒
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
})();

$('#volume').oninput = async (e) => {
  const g = e.target.value / 100;
  try { await window.mine.engine('volume.set', { gain: g }); } catch { }
  if (window.annieStage) window.annieStage.setVolume(g);
  window.mine.saveSettings({ volume: g });
};

/* ---------------- 设备选择 ---------------- */
async function refreshDevices() {
  let d;
  try { d = await window.mine.engine('devices.list'); }
  catch (e) {
    $('#device-select').innerHTML = `<option>引擎不可用：${e.message}</option>`;
    return;
  }
  const sel = $('#device-select');
  sel.innerHTML = '';
  const g1 = document.createElement('optgroup'); g1.label = 'WASAPI 独占';
  for (const dev of d.wasapi) {
    const o = document.createElement('option');
    o.value = 'wasapi|' + dev.id; o.textContent = dev.name;
    g1.appendChild(o);
  }
  const g2 = document.createElement('optgroup'); g2.label = 'ASIO';
  if (!d.asio.length) {
    const o = document.createElement('option'); o.disabled = true; o.textContent = '（未检测到 ASIO 驱动）';
    g2.appendChild(o);
  }
  for (const name of d.asio) {
    const o = document.createElement('option');
    o.value = 'asio|' + name; o.textContent = name;
    g2.appendChild(o);
  }
  sel.appendChild(g1); sel.appendChild(g2);

  const saved = state.library.backend;
  if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
}

$('#device-select').onchange = async (e) => {
  const [kind, id] = e.target.value.split('|');
  try {
    await window.mine.engine('devices.select', { kind, id });
    window.mine.saveSettings({ backend: e.target.value });
  } catch (err) {
    setFormatChips([{ text: '切换设备失败: ' + err.message, cls: 'warn' }]);
  }
};

/* ---------------- Plus：设备弹层（方案A：低频操作移出底栏黄金位） ---------------- */
$('#btn-device').onclick = (e) => {
  e.stopPropagation();
  $('#device-pop').classList.toggle('hidden');
};
$('#btn-device-close').onclick = () => $('#device-pop').classList.add('hidden');
document.addEventListener('pointerdown', (e) => {
  const pop = $('#device-pop');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== $('#btn-device')) {
    pop.classList.add('hidden');
  }
});

/* ---------------- Plus：音频工具组（方案A 中频区） ---------------- */
// 收藏当前曲目
function updateFavCurBtn() {
  const b = $('#btn-fav-cur');
  if (!b) return;
  const on = !!(state.currentPath && state.favorites.has(state.currentPath));
  b.textContent = on ? '♥' : '♡';
  b.classList.toggle('on', on);
}
$('#btn-fav-cur').onclick = () => {
  if (!state.currentPath) return;
  toggleFavorite(state.currentPath);
  updateFavCurBtn();
  const b = $('#btn-fav-cur');
  b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); // 收藏爆裂动效
};
// 波形/频谱面板开关
$('#btn-viz-toggle').onclick = () => { if (window.annieViz) window.annieViz.toggleBar(); };

/* ---------------- 窗口按钮 ---------------- */
$('#btn-min').onclick = () => window.mine.winMin();
$('#btn-max').onclick = () => window.mine.winMax();
$('#btn-close').onclick = () => window.mine.winClose();

/* ---------------- 快捷键 ---------------- */
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); $('#btn-play').click(); }
  // V1.1.5：方向键 seek 复用 seekPending 保护——旧实现直接发 seek 无保护，
  // 引擎 seek 期间旧 position 事件把进度条拉回（乱跳）
  else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    const delta = e.code === 'ArrowRight' ? 5 : -5;
    if (!state.currentPath) return;
    const target = (state.currentCue ? state.currentCue.start : 0) + Math.max(0, state.position + delta);
    state.seekPending = true;
    state.seekTarget = state.currentCue ? target - state.currentCue.start : target;
    clearTimeout(state.seekTimer);
    state.seekTimer = setTimeout(() => { state.seekPending = false; }, 10000);
    window.mine.engine('seek', { seconds: target }, 30000).catch(() => { state.seekPending = false; clearTimeout(state.seekTimer); });
  }
  else if (e.code === 'ArrowUp') { e.preventDefault(); $('#volume').value = Math.min(100, +$('#volume').value + 5); $('#volume').oninput({ target: $('#volume') }); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); $('#volume').value = Math.max(0, +$('#volume').value - 5); $('#volume').oninput({ target: $('#volume') }); }
});

/* ---------------- 启动 ---------------- */
(async function boot() {
  // ffmpeg 可用性预检
  try {
    const info = await window.mine.engine('engine.info');
    if (!info.ffmpegFound || !info.ffprobeFound) {
      $('#tool-banner').classList.remove('hidden');
    }
  } catch { /* 引擎未就绪时 devices.list 会再报错 */ }
  await loadLibrary();
  // 恢复设置面板偏好（视觉/歌词/界面/排序/侧栏/视图模式）
  if (window.annieSettings) {
    annieSettings.hydrate(state.library.ui);
    $('#sort-select').value = annieSettings.ui.sortMode;
    state.viewMode = annieSettings.ui.viewMode === 'grid' ? 'grid' : 'tree';
    renderViewMode();
    applySidebar();
  }
  if (state.library.volume != null) $('#volume').value = Math.round(state.library.volume * 100);
  await refreshDevices();
  const saved = state.library.backend;
  if (saved) {
    const [kind, id] = saved.split('|');
    try { await window.mine.engine('devices.select', { kind, id }); } catch { }
  }
  try { await window.mine.engine('volume.set', { gain: (+$('#volume').value) / 100 }); } catch { }
  await applyAudioSettings();
})();

/* Pro beat0.0.1：恢复音质链路设置（DSD 模式 / 缓冲 / 交叉淡入）；引擎崩溃重启后也会重放 */
async function applyAudioSettings() {
  if (!window.annieSettings) return;
  const u = annieSettings.ui;
  try { await window.mine.engine('dsd.setMode', { mode: u.dsdMode || 'pcm' }); } catch { }
  try { await window.mine.engine('buffer.set', { ms: u.bufferMs || 50, preload: !!u.preload }); } catch { }
  try { await window.mine.engine('crossfade.set', { seconds: u.crossfadeSec || 0 }); } catch { }
  // V3.5.15：无缝播放 + 重采样质量 启动同步
  try { await window.mine.engine('gapless.set', { on: u.gapless !== false }); } catch { }
  try { await window.mine.engine('resample.set', { hq: !!u.resampleHq }); } catch { }
  // V3.5.19：参量 EQ + 声道工具 启动同步
  try { await window.mine.engine('peq.set', { enabled: !!u.peqOn, bands: u.peqBands || [] }); } catch { }
  try { await window.mine.engine('channel.set', { mode: u.chMode || 'stereo', balance: u.chBalance || 0 }); } catch { }
}
