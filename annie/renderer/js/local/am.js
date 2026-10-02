'use strict';
/* ===== am.js 拆分片：am.js =====
 * 核心与数据层：状态 S/R、常量、工具函数、标签/封面/分组数据层、播放控制
 * 来源：am.js 原稿行 14-274（原样切片，零行为变更）
 * 原 am.js 头注释（设计说明/接入方式/性能约束）保留在本片开头。
 * 共享变量经 window.__annieAMInternal 桥接；前向引用为转发桩，运行时解析。 */
(function () {
  var AM = window.__annieAMInternal || (window.__annieAMInternal = {}); // AM 主题内部模块桥（跨分片共享闭包变量）
  // 前向引用：目标函数由后加载分片注册到桥，调用时才取值（加载期取不到）
  function renderView() { return AM.renderView.apply(this, arguments); }
  function renderSidebar() { return AM.renderSidebar.apply(this, arguments); }
  function nextStream() { return AM.nextStream.apply(this, arguments); }
  function prevStream() { return AM.prevStream.apply(this, arguments); }

  var LIGHT_KEY = 'annieplayer.am.light';

  var S = {
    mounted: false,
    view: 'songs',        // songs | albums | folders | favorites | stream | pl:<id> | spl:<id>
    albumKey: null,       // 专辑详情（albums 视图点入）
    folderPath: null,     // V4.3.20：文件夹逐级浏览——当前目录绝对路径（null = 媒体库根列表）
    libFolders: [],       // 媒体库根文件夹（lib:get 缓存）
    search: '',
    playlists: [],
    streamPlaylists: [],  // V4.3.5：在线歌单 [{id,name,items:[{provider,song,addedAt}]}]
    _playList: null,      // 当前流媒体播放队列（=stResults 或在线歌单曲目数组）
    meta: {},             // path -> {title,artist,album,...}（metaBatch 缓存）
    metaDeep: false,      // 搜索时是否已发起全库标签加载
    cover: {},            // 实际文件 path -> dataURL | null（lazy + 并发限流）
    acover: {},           // 专辑 key -> dataURL | null（专辑级封面共享）
    acoverRep: {},        // 专辑 key -> 代表文件 path
    acoverWait: {},       // 专辑 key -> [cb]（解析中合并等待）
    coverQ: [], coverActive: 0,
    lyrPath: null, lyrLines: [], lyrCur: -1,
    pos: 0, dur: 0, playing: false,
    fmt: '',              // 音质徽标文本（引擎 format 事件 / 流式音质）
    lyricsOn: true,
    // 洛雪在线搜索 / 发现音乐（V3.5.4：排行榜 + 歌单广场）
    stProvider: 'kg', stKw: '', stPage: 0, stAllPage: 1, stResults: [], stIndex: -1,
    stSearching: false, stQuality: 'flac',
    stTab: 'search',           // search | boards | lists | albums
    tabSongs: {},              // 每个页签各自的歌曲列表缓存（切页签恢复）
    boards: [], boardsProvider: '', boardSel: '', boardName: '', bdPage: 0, bdAllPage: 1,
    slLists: [], slProvider: '', slPage: 0, slLimit: 30, slTotal: 0,
    slDetailId: '', slDetailName: '', slDPage: 0, slDLimit: 100, slDTotal: 0,
    // V4.3：专辑页签（kg/kw/tx/wy 四源；mg 不支持）
    abKw: '', abResults: [], abPage: 0, abAllPage: 1, abSearching: false,
    abDetailId: '', abDetailInfo: null
  };
  var R = {};             // DOM 引用表

  var PLATFORMS = { kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐', tx: 'QQ 音乐', wy: '网易云音乐' };
  var TYPE_LABEL = { flac24bit: 'Hi-Res', flac: 'FLAC', '320k': '320K', '128k': '128K' };

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function esc(s) { return String(s == null ? '' : s); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function fmtRemain(sec) { return '-' + fmtTime(sec); }
  function isLight() { try { return localStorage.getItem(LIGHT_KEY) === '1'; } catch (e) { return false; } }

  /* ---------------- 数据 ---------------- */
  function allTracks() {
    // state 是 player.js 的顶层 const（跨脚本共享词法作用域，但不在 window 上）
    return (typeof state !== 'undefined' && state.library && state.library.tracks) || [];
  }
  function trackMeta(t) {
    var m = S.meta[t.path];
    return {
      title: (m && m.title) || String(t.name || '').replace(/\.[^.]+$/, ''),
      artist: (m && m.artist) || '未知艺术家',
      album: (m && m.album) || ''
    };
  }
  /* 按需批量取标签（渲染行时调用，已缓存的自动跳过） */
  function ensureMeta(tracks) {
    var missing = tracks.filter(function (t) { return !S.meta[t.path]; }).slice(0, 200);
    if (!missing.length) return; // 全部命中缓存时绝不能回调查渲染——否则与 renderView 互相递归
    window.mine.metaBatch(missing.map(function (t) { return t.path; })).then(function (out) {
      for (var p in out) S.meta[p] = out[p];
      // 解析失败的曲目主进程不入缓存——打失败标记，防止每次渲染都重复请求
      missing.forEach(function (t) { if (!S.meta[t.path]) S.meta[t.path] = { fail: true }; });
      S._metaTick = (S._metaTick || 0) + 1; // V4.3.8：首字母排序缓存失效
      if (!(window.annieTheme && annieTheme.current === 'am')) return;
      // 专辑网格的分组依赖标签，需整视图重排；曲目表只补丁可见行文本，避免整视图重建
      if (S.view === 'albums' && !S.albumKey) renderView();
      else patchVisibleMeta();
    }).catch(function () { });
  }
  /* 标签到达后只更新当前 DOM 里可见行的文本（窗口化/非窗口化均适用） */
  function patchVisibleMeta() {
    if (!R.content) return;
    var rows = R.content.querySelectorAll('tr.am-tr');
    for (var k = 0; k < rows.length; k++) {
      var tr = rows[k], m = S.meta[tr.dataset.path];
      if (!m || m.fail) continue;
      var titleEl = tr.querySelector('.am-c-title');
      if (titleEl && m.title) titleEl.textContent = m.title;
      var dims = tr.querySelectorAll('.am-c-dim');
      if (dims[0] && m.artist) dims[0].textContent = m.artist;
      if (dims[1]) dims[1].textContent = m.album || '';
    }
  }
  /* 搜索时全库深加载标签（metaCache 持久化，全库解析只有一次成本；分块避免一次 IPC 过大） */
  function ensureMetaDeep() {
    if (S.metaDeep) return;
    S.metaDeep = true;
    var idx = 0, CHUNK = 400;
    function step() {
      var all = allTracks();
      var missing = [];
      while (idx < all.length && missing.length < CHUNK) {
        var t = all[idx++];
        if (!S.meta[t.path]) missing.push(t.path);
      }
      if (!missing.length && idx >= all.length) return; // 全部完成
      if (!missing.length) { step(); return; }
      window.mine.metaBatch(missing).then(function (out) {
        for (var p in out) S.meta[p] = out[p];
        missing.forEach(function (p) { if (!S.meta[p]) S.meta[p] = { fail: true }; });
        S._metaTick = (S._metaTick || 0) + 1; // V4.3.8：首字母排序缓存失效
        // 新标签可能让新曲目命中搜索/改变歌曲视图排序，需重绘；但按块到达，200ms 合并避免每块整表重建
        if ((S.search || S.view === 'songs') && window.annieTheme && annieTheme.current === 'am') {
          clearTimeout(S._deepRT);
          S._deepRT = setTimeout(renderView, 200);
        }
        setTimeout(step, 30); // 让出主线程，避免搜索框打字卡顿
      }).catch(function () { setTimeout(step, 500); });
    }
    step();
  }
  /* 封面 lazy + 并发限流（最多 3 个 meta 解析同时在飞，防止 IPC 风暴卡 UI） */
  function ensureCover(path, cb) {
    if (S.cover[path] !== undefined) { cb(S.cover[path]); return; }
    S.coverQ.push({ path: path, cb: cb });
    pumpCoverQ();
  }
  function pumpCoverQ() {
    while (S.coverActive < 3 && S.coverQ.length) {
      var job = S.coverQ.shift();
      if (S.cover[job.path] !== undefined) { job.cb(S.cover[job.path]); continue; }
      S.coverActive++;
      (function (j) {
        window.mine.meta(j.path).then(function (m) {
          S.cover[j.path] = (m && m.cover) || null;
        }).catch(function () { S.cover[j.path] = null; }).then(function () {
          S.coverActive--;
          j.cb(S.cover[j.path]);
          pumpCoverQ();
        });
      })(job);
    }
  }
  /* ---------- 专辑级封面共享：整张专辑只解析一个文件的封面，专辑内曲目复用 ---------- */
  function srcFileOf(t) { return (t.cue && t.cue.src) || (t.iso && t.iso.src) || t.path; }
  function albumKeyOf(t) {
    var m = trackMeta(t);
    /* V4.3.21：键加艺人防跨艺人同名专辑串封面；专辑缺失时退回按文件——
     * 旧逻辑「无专辑按目录分组」在下载/混装文件夹里把整目录的歌共用一张封面（迷你/队列张冠李戴现场） */
    if (m.album) return m.album + '|' + (m.artist || '');
    return 'file:' + t.path;
  }
  /* 取某曲目所在专辑的封面；cb(dataURL|null)。同专辑并发请求合并，只解析一次 */
  function albumCover(t, cb) {
    var key = albumKeyOf(t);
    if (S.acover[key] !== undefined) { cb(S.acover[key]); return; }
    if (S.acoverWait[key]) { S.acoverWait[key].push(cb); return; }
    S.acoverWait[key] = [cb];
    if (!S.acoverRep[key]) S.acoverRep[key] = srcFileOf(t);
    var rep = S.acoverRep[key];
    S.coverQ.push({
      path: rep,
      cb: function (url) {
        S.acover[key] = url || null;
        var waiters = S.acoverWait[key] || [];
        delete S.acoverWait[key];
        waiters.forEach(function (w) { w(S.acover[key]); });
      }
    });
    // 复用底层并发限流队列，但绕过 path 级缓存（rep 可能被其他专辑引用）
    if (S.cover[rep] !== undefined) {
      // 已有 path 级结果——直接出队这个 job 立即结算
      for (var i = S.coverQ.length - 1; i >= 0; i--) {
        if (S.coverQ[i].path === rep) { var job = S.coverQ.splice(i, 1)[0]; job.cb(S.cover[rep]); break; }
      }
    }
    pumpCoverQ();
  }
  /* ---------- 文件夹视图：按媒体库根目录下的一级子文件夹分组（根目录本身不外显） ---------- */
  function normP(p) { return String(p || '').replace(/\//g, '\\'); }
  /* V4.3.20：文件夹逐级浏览（替代原 root+seg 两层拍平）。
   * folderRoots()：媒体库根列表（含各根递归曲目数；根外目录兜底平铺）。
   * folderChildren(dirPath)：dirPath 的直接子文件夹列表（count 为递归曲目数）。 */
  function folderRoots() {
    var rows = [];
    var idx = {};
    (S.libFolders || []).forEach(function (f) {
      var root = normP(f).replace(/\\+$/, '');
      if (!root) return;
      idx[root.toLowerCase()] = rows.length;
      rows.push({ name: root.split('\\').pop() || root, path: root, count: 0 });
    });
    var extra = {};
    allTracks().forEach(function (t) {
      var d = normP(t.dir || '');
      if (!d) return;
      var dl = d.toLowerCase();
      var hit = false;
      for (var k in idx) {
        if (dl === k || dl.indexOf(k + '\\') === 0) { rows[idx[k]].count++; hit = true; break; }
      }
      if (!hit) { // 不在任何媒体库根下（极端兜底，正常扫描不会出现）
        if (!extra[dl]) extra[dl] = { name: d.split('\\').pop() || d, path: d, count: 0 };
        extra[dl].count++;
      }
    });
    return rows.concat(Object.keys(extra).sort().map(function (k) { return extra[k]; }));
  }
  function folderChildren(dirPath) {
    var base = normP(dirPath).replace(/\\+$/, '');
    var baseL = base.toLowerCase();
    var map = {};
    allTracks().forEach(function (t) {
      var d = normP(t.dir || '');
      if (d.toLowerCase().indexOf(baseL + '\\') !== 0) return;
      var rel = d.slice(base.length + 1);
      var seg = rel.split('\\')[0];
      if (!seg) return;
      var key = seg.toLowerCase();
      if (!map[key]) map[key] = { name: seg, path: base + '\\' + seg, count: 0 };
      map[key].count++;
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  /* V4.3.8：全曲库「歌曲」视图按标题首字母排序（中文按拼音首字母，查 pyinitial.js 字表）。
   * 排序结果按（列表引用+搜索词+标签版本）记忆，标签深加载到一块就失效重排；
   * S._azCache.firstIdx 供 am-dom.js 的 A–Z 索引栏跳转。 */
  var _azCollator = null;
  function azCollator() {
    if (!_azCollator) {
      try { _azCollator = new Intl.Collator(['zh-Hans-u-co-pinyin', 'en'], { sensitivity: 'base', numeric: true }); }
      catch (e) { _azCollator = { compare: function (a, b) { return a < b ? -1 : a > b ? 1 : 0; } }; }
    }
    return _azCollator;
  }
  function azLetterOf(title) {
    if (window.annieInitialOf) return window.annieInitialOf(title);
    var ch = String(title || '').replace(/^\s+/, '').charAt(0);
    return /[a-z]/i.test(ch) ? ch.toUpperCase() : '#';
  }
  function sortByInitial(list, field) {
    field = field || 'title'; // V4.3.16：'title'（V4.3.8 原版）| 'artist'（群友需求：演唱者头文字索引）
    var tick = S._metaTick || 0, search = S.search || '';
    var cache = S._azCache;
    if (cache && cache.list === list && cache.search === search && cache.tick === tick && cache.field === field) return cache.out;
    var col = azCollator();
    var keys = list.map(function (t) {
      var m = trackMeta(t);
      var key = field === 'artist' ? (m.artist || '') : (m.title || '');
      return { t: t, letter: azLetterOf(key), key: key, title: m.title || '' };
    });
    keys.sort(function (a, b) {
      // '#'（数字/符号/生僻字）排最后，其余按字母；同字母内按拼音/字母序
      var la = a.letter === '#' ? '\uffff' : a.letter, lb = b.letter === '#' ? '\uffff' : b.letter;
      if (la !== lb) return la < lb ? -1 : 1;
      var c = col.compare(a.key, b.key);
      return c !== 0 ? c : col.compare(a.title, b.title);
    });
    var firstIdx = {};
    var out = keys.map(function (k, i) { if (firstIdx[k.letter] === undefined) firstIdx[k.letter] = i; return k.t; });
    S._azCache = { list: list, search: search, tick: tick, field: field, out: out, firstIdx: firstIdx };
    return out;
  }

  /* V4.3.15：歌曲视图排序方式可选（设置持久化 annieSettings.ui.amSongSort）。
   * az = 首字母（配 A–Z 索引栏）；其余为平铺排序，索引栏自动隐藏。 */
  function songSortMode() {
    return (window.annieSettings && annieSettings.ui.amSongSort) || 'az';
  }
  function sortSongs(list) {
    var mode = songSortMode();
    if (mode === 'az') return sortByInitial(list);
    if (mode === 'azArtist') return sortByInitial(list, 'artist'); // V4.3.16
    var arr = list.slice();
    if (mode === 'name') arr.sort(function (a, b) { return azCollator().compare(a.name, b.name); });
    else if (mode === 'mtimeDesc') arr.sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
    else if (mode === 'mtimeAsc') arr.sort(function (a, b) { return (a.mtime || 0) - (b.mtime || 0); });
    else if (mode === 'sizeDesc') arr.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
    else if (mode === 'sizeAsc') arr.sort(function (a, b) { return (a.size || 0) - (b.size || 0); });
    return arr;
  }

  function currentTracks() {
    var list = allTracks();
    var isSongs = S.view === 'songs';
    if (S.view === 'favorites') {
      list = list.filter(function (t) { return state.favorites && state.favorites.has(t.path); });
    } else if (S.view.indexOf('pl:') === 0) {
      var pl = S.playlists.find(function (p) { return p.id === S.view.slice(3); });
      var paths = pl ? pl.paths : [];
      var byPath = {};
      list.forEach(function (t) { byPath[t.path] = t; });
      list = paths.map(function (p) { return byPath[p]; }).filter(Boolean);
    } else if (S.view === 'albums' && S.albumKey) {
      list = list.filter(function (t) { return (trackMeta(t).album || '未知专辑') === S.albumKey; });
    } else if (S.view === 'folders' && S.folderPath) {
      var fp = normP(S.folderPath).replace(/\\+$/, '').toLowerCase();
      list = list.filter(function (t) { return normP(t.dir || '').toLowerCase() === fp; }); // 仅本层直属文件，子目录以文件夹行呈现
    }
    if (S.search) {
      var q = S.search.toLowerCase();
      list = list.filter(function (t) {
        var m = trackMeta(t);
        return (m.title + ' ' + m.artist + ' ' + m.album).toLowerCase().indexOf(q) >= 0;
      });
    }
    if (isSongs) list = sortSongs(list); // V4.3.15：歌曲视图（含搜索结果）按所选方式排序
    return list;
  }
  function refreshPlaylists() {
    window.mine.splList().then(function (pls) {
      S.streamPlaylists = Array.isArray(pls) ? pls : [];
      renderSidebar();
      if (S.view.indexOf('spl:') === 0) renderView();
    }).catch(function () { });
    return window.mine.playlists().then(function (pls) {
      S.playlists = Array.isArray(pls) ? pls : [];
      renderSidebar();
      if (S.view.indexOf('pl:') === 0) renderView();
    }).catch(function () { });
  }

  /* ---------------- 播放控制 ---------------- */
  function playList(list, i) {
    state.queue = list;
    // 播放模式"全文件顺序/随机"的上下文标记：队列是否就是全库（全文件顺序仅此时生效）
    var all = allTracks();
    state.queueCtx = (list.length === all.length && list[0] === all[0]) ? 'all' : 'list';
    playAt(i);
  }
  function togglePlay() {
    if (!state.currentPath && allTracks().length) { playList(allTracks(), 0); return; }
    window.mine.engine(state.playing ? 'pause' : 'resume').catch(function () { });
  }
  function next() {
    if (state.currentStream) { nextStream(); return; } // 流媒体不接管：走流媒体自己的续播
    if (!state.queue.length) return;
    // 播放模式接管（仅本地）；未接管时保持旧手动行为（末尾回卷）
    if (window.annieNextByMode && window.annieNextByMode()) return;
    playAt((state.index + 1) % state.queue.length);
  }
  function prev() {
    if (state.currentStream) { prevStream(); return; }
    if (!state.queue.length) return;
    if (S.pos > 3) playAt(state.index); else playAt(Math.max(0, state.index - 1));
  }
  function seek(sec) {
    var base = state.currentCue ? state.currentCue.start : 0;
    var target = Math.max(0, sec);
    // V4.3.16：seek 保护——引擎重缓冲期间旧 position 事件持续到达，会把进度条拉回播放中位置
    // （在线流媒体重缓冲 1~3s，回拉尤其明显）；锁定目标位置，引擎确认到达或 10s 超时后解除（与舞台主题同一套）
    state.seekPending = true; state.seekTarget = target;
    clearTimeout(state.seekTimer);
    state.seekTimer = setTimeout(function () { state.seekPending = false; }, 10000);
    window.mine.engine('seek', { seconds: base + target }, 30000).catch(function () {
      state.seekPending = false; clearTimeout(state.seekTimer);
    });
  }
  // V4.3.16：进度条拖动——pointerdown/move/up 全程本地预览（填充+时间跟手），松手才 seek。
  // 原三处进度条（顶栏/沉浸/迷你）只有 onclick，无法拖动；在线曲目引擎事件 10Hz 更显迟钝，预览期间以 state.seeking 屏蔽位置回写。
  function bindProgDrag(bar, fillEl, curEl) {
    bar.addEventListener('pointerdown', function (e) {
      if (!state.currentPath || !(S.dur > 0)) return;
      e.preventDefault();
      var preview = function (ev) {
        var r = bar.getBoundingClientRect();
        var f = r.width > 0 ? Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) : 0;
        fillEl.style.width = (f * 100) + '%';
        if (curEl) curEl.textContent = fmtTime(f * S.dur);
        return f;
      };
      state.seeking = true;
      var frac = preview(e);
      var move = function (ev) { frac = preview(ev); };
      var up = function () {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        state.seeking = false;
        seek(frac * S.dur);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }


  /* 注册到模块桥（供其他分片取用） */
  AM.S = S;
  AM.R = R;
  AM.LIGHT_KEY = LIGHT_KEY;
  AM.PLATFORMS = PLATFORMS;
  AM.TYPE_LABEL = TYPE_LABEL;
  AM.el = el;
  AM.esc = esc;
  AM.fmtTime = fmtTime;
  AM.fmtRemain = fmtRemain;
  AM.isLight = isLight;
  AM.allTracks = allTracks;
  AM.trackMeta = trackMeta;
  AM.ensureMeta = ensureMeta;
  AM.ensureMetaDeep = ensureMetaDeep;
  AM.ensureCover = ensureCover;
  AM.albumCover = albumCover;
  AM.srcFileOf = srcFileOf;
  AM.albumKeyOf = albumKeyOf;
  AM.folderGroups = folderRoots;       // V4.3.20：旧名桥接新实现（媒体库根列表）
  AM.folderRoots = folderRoots;
  AM.folderChildren = folderChildren;
  AM.normP = normP;
  AM.currentTracks = currentTracks;
  AM.songSortMode = songSortMode;
  AM.refreshPlaylists = refreshPlaylists;
  AM.playList = playList;
  AM.togglePlay = togglePlay;
  AM.next = next;
  AM.prev = prev;
  AM.seek = seek;
  AM.bindProgDrag = bindProgDrag;

  /* V4.3.19：切歌格式 OSD（新脑暴 E）——右下胶囊显示当前格式/输出链，3.2s 淡出 */
  var fmtOsdTimer = null;
  function showFmtOsd(text) {
    if (!text) return;
    var host = document.querySelector('.am-body') || document.body;
    var d = document.getElementById('am-fmt-osd');
    if (!d) { d = el('div'); d.id = 'am-fmt-osd'; host.appendChild(d); }
    d.textContent = text;
    d.classList.add('on');
    clearTimeout(fmtOsdTimer);
    fmtOsdTimer = setTimeout(function () { d.classList.remove('on'); }, 3200);
  }
  AM.showFmtOsd = showFmtOsd;
})();
