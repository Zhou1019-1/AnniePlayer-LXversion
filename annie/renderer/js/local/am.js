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
    view: 'songs',        // songs | albums | folders | favorites | stream | pl:<id>
    albumKey: null,       // 专辑详情（albums 视图点入）
    folderKey: null,      // 文件夹详情：{root, seg}（folders 视图点入）
    libFolders: [],       // 媒体库根文件夹（lib:get 缓存）
    search: '',
    playlists: [],
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
    stTab: 'search',           // search | boards | lists
    tabSongs: {},              // 每个页签各自的歌曲列表缓存（切页签恢复）
    boards: [], boardsProvider: '', boardSel: '', boardName: '', bdPage: 0, bdAllPage: 1,
    slLists: [], slProvider: '', slPage: 0, slLimit: 30, slTotal: 0,
    slDetailId: '', slDetailName: '', slDPage: 0, slDLimit: 100, slDTotal: 0
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
        // 新标签可能让新曲目命中搜索，需重绘；但按块到达，200ms 合并避免每块整表重建
        if (S.search && window.annieTheme && annieTheme.current === 'am') {
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
    return m.album || ('dir:' + (t.dir || '')); // 无专辑标签时按目录分组（同目录≈同专辑）
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
  function folderGroupOf(t) {
    var p = normP(t.path);
    for (var i = 0; i < S.libFolders.length; i++) {
      var root = normP(S.libFolders[i]).replace(/\\+$/, '');
      if (root && p.toLowerCase().indexOf(root.toLowerCase() + '\\') === 0) {
        var rel = p.slice(root.length + 1);
        var seg = rel.indexOf('\\') >= 0 ? rel.split('\\')[0] : ''; // '' = 直接放在根目录的文件
        return { root: root, seg: seg };
      }
    }
    return { root: '', seg: normP(t.dir || '') }; // 不在任何根目录下：退化为按所在目录分组
  }
  function folderGroups() {
    var map = {};
    allTracks().forEach(function (t) {
      var g = folderGroupOf(t);
      var key = (g.root + '\\' + g.seg).toLowerCase();
      if (!map[key]) map[key] = { root: g.root, seg: g.seg, count: 0 };
      map[key].count++;
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  function currentTracks() {
    var list = allTracks();
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
    } else if (S.view === 'folders' && S.folderKey) {
      var fk = S.folderKey;
      list = list.filter(function (t) {
        var g = folderGroupOf(t);
        return g.root === fk.root && g.seg === fk.seg;
      });
    }
    if (S.search) {
      var q = S.search.toLowerCase();
      list = list.filter(function (t) {
        var m = trackMeta(t);
        return (m.title + ' ' + m.artist + ' ' + m.album).toLowerCase().indexOf(q) >= 0;
      });
    }
    return list;
  }
  function refreshPlaylists() {
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
    window.mine.engine('seek', { seconds: base + Math.max(0, sec) }, 30000).catch(function () { });
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
  AM.folderGroups = folderGroups;
  AM.currentTracks = currentTracks;
  AM.refreshPlaylists = refreshPlaylists;
  AM.playList = playList;
  AM.togglePlay = togglePlay;
  AM.next = next;
  AM.prev = prev;
  AM.seek = seek;
})();
