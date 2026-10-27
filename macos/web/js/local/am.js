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

  // ⚠️ 2026-10-22：QQ 音乐下线（用户要求）。
  //    原因：QQ 音乐所有可用链路都依赖第三方聚合后端 yy.zddyr.top，
  //    该后端已返回 403 Access denied，且 Qobuz/官方直连方案均不可行
  //    （官方接口需要签名，社区方案全部依赖那台已死的后端）。
  //    从 PLATFORMS 移除后，平台选择器里不再出现 QQ 音乐按钮。
  // ⚠️ 2026-10-22：Apple Music 独立成板块后，从「在线音乐」平台列表移除
  //    （用户要求：在线搜索不再需要 ALAC / AM 选项）
  //    AM 的搜索与播放走侧栏「🍎 Apple Music」专属页面。
  var PLATFORMS = { kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐', wy: '网易云音乐' };
  var TYPE_LABEL = { alac: 'ALAC', flac24bit: 'Hi-Res', flac: 'FLAC', '320k': '320K', '128k': '128K' };

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
  // ⚠️ 2026-10-21：主题判断改为「系统优先 + 用户可覆盖」
  //    之前只读 localStorage，Mac 切浅色模式时播放器不跟随。
  //    LIGHT_KEY 存 'system' | '1'(浅) | '0'(深)；默认跟随系统。
  function isLight() {
    try {
      var v = localStorage.getItem(LIGHT_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
      // 未设置或 'system' → 跟随系统
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    } catch (e) { return false; }
  }

  /* ---------------- 数据 ---------------- */
  function allTracks() {
    // state 是 player.js 的顶层 const（跨脚本共享词法作用域，但不在 window 上）
    return (typeof state !== 'undefined' && state.library && state.library.tracks) || [];
  }
  function trackMeta(t) {
    // ⚠️ 2026-10-23 修复「喜爱歌曲列表不显示歌手/专辑」：
    //   在线收藏的歌曲在 currentTracks() 里被包装成 __stream 曲目，path 是
    //   'stream://...' —— metaCache（按文件路径读标签）永远查不到，于是
    //   artist 一律落到「未知艺术家」。但这些曲目对象自带 meta/title/artist/album
    //   字段（currentTracks 里从收藏记录拷过来的），这里要兜底读它们。
    var m = S.meta[t.path] || t.meta || {};
    return {
      title: (m && m.title) || t.title || String(t.name || '').replace(/\.[^.]+$/, ''),
      artist: (m && m.artist) || t.artist || '未知艺术家',
      album: (m && m.album) || t.album || '',
      track: (m && m.track) || '',  // V4.4.3：专辑详情按发布顺序排序用（no/of 原始串）
      disc: (m && m.disc) || '',
      duration: (m && m.duration) || 0  // V4.4.3：时长排序用（metaCache 秒字段，非 track 对象上）
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
      var celA = tr.querySelector('.am-c-artist'), celB = tr.querySelector('.am-c-album');
      if (celA && m.artist) celA.textContent = m.artist;
      if (celB) celB.textContent = m.album || '';
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
        if ((S.search || S.view === 'songs' || S._grpOn) && window.annieTheme && annieTheme.current === 'am') {
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
  /* V4.3.22：喜爱歌曲/专辑视图排序（各自持久化，选项见 am-dom 头部下拉） */
  function favSortMode() {
    return (window.annieSettings && annieSettings.ui.amFavSort) || 'az';
  }
  function albumSortMode() {
    return (window.annieSettings && annieSettings.ui.amAlbumSort) || 'az';
  }
  /* V4.4.6：播放列表/在线歌单排序（各自持久化） */
  function plSortMode() {
    return (window.annieSettings && annieSettings.ui.amPlSort) || 'default';
  }
  function splSortMode() {
    return (window.annieSettings && annieSettings.ui.amSplSort) || 'default';
  }
  /* 视图内搜索的匹配字段跟随当前排序方式：标题排序搜标题、演唱者排序搜演唱者、文件名排序搜文件名 */
  function songSearchField(mode) {
    return mode === 'azArtist' ? 'artist' : mode === 'name' ? 'name' : mode === 'albumAz' ? 'album' : 'title';
  }
  function sortSongs(list, mode) {
    mode = mode || songSortMode();
    if (mode === 'az') return sortByInitial(list);
    if (mode === 'azArtist') return sortByInitial(list, 'artist'); // V4.3.16
    if (mode === 'albumAz') {   // V4.4.9：专辑名 A–Z（拉丁优先，其次数字 / 中文拼音，未知最后）
      var _tick = S._metaTick || 0, _qs = S.search || '', _ce = S._azCache;
      if (_ce && _ce.list === list && _ce.search === _qs && _ce.tick === _tick && _ce.field === 'album') return _ce.out;
      var _ac = azCollator(), _al = list.slice();
      var _cls = function (s) {
        var ch = (s || '').charAt(0);
        if (!ch) return 3;
        if (/[A-Za-z]/.test(ch)) return 0;
        if (/[0-9]/.test(ch)) return 1;
        return 2;
      };
      _al.sort(function (a, b) {
        var ma = trackMeta(a), mb = trackMeta(b);
        var ka = (ma.album || '').trim(), kb = (mb.album || '').trim();
        var ca = _cls(ka), cb = _cls(kb);
        if (ca !== cb) return ca - cb;
        var c = _ac.compare(ka || '\uFFFF', kb || '\uFFFF');
        return c !== 0 ? c : _ac.compare(ma.title || '', mb.title || '');
      });
      var _fi = {};
      _al.forEach(function (t, i) {
        var _a = (trackMeta(t).album || '未知专辑').trim();
        var _L = azLetterOf(_a);
        if (_fi[_L] === undefined) _fi[_L] = i;
      });
      S._azCache = { list: list, search: _qs, tick: _tick, field: 'album', out: _al, firstIdx: _fi };
      return _al;
    }
    var arr = list.slice();
    if (mode === 'name') arr.sort(function (a, b) { return azCollator().compare(a.name, b.name); });
    else if (mode === 'mtimeDesc') arr.sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
    else if (mode === 'mtimeAsc') arr.sort(function (a, b) { return (a.mtime || 0) - (b.mtime || 0); });
    else if (mode === 'ctimeDesc') arr.sort(function (a, b) { return (b.ctime || 0) - (a.ctime || 0); });
    else if (mode === 'ctimeAsc') arr.sort(function (a, b) { return (a.ctime || 0) - (b.ctime || 0); });
    else if (mode === 'sizeDesc') arr.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
    else if (mode === 'sizeAsc') arr.sort(function (a, b) { return (a.size || 0) - (b.size || 0); });
    return arr;
  }

  function currentTracks() {
    var list = allTracks();
    var isSongs = S.view === 'songs';
    if (S.view === 'favorites') {
      // ⚠️ 2026-10-22：喜爱歌曲 = 本地收藏 + 在线收藏（用户要求）
      list = list.filter(function (t) { return state.favorites && state.favorites.has(t.path); });
      // 在线收藏的歌曲：包装成 __stream 曲目（双击直接走流媒体播放）
      var streams = (S.favSongs || []).map(function (song) {
        return {
          __stream: true,
          path: 'stream://' + (song.provider || '') + '/' +
                String(song.songmid != null ? song.songmid : (song.hash || song.id || song.name || '')),
          name: song.name || '',
          title: song.name || '',
          artist: song.artist || song.singer || '',
          album: song.album || song.albumName || '',
          meta: { title: song.name || '', artist: song.artist || song.singer || '',
                  album: song.album || song.albumName || '',
                  cover: song.cover || song.img || song.pic || '' },
          // ⚠️ 2026-10-23：顶层也要带 cover —— 待播清单的流媒体分支直接读
          //   `song.cover`（队列元素就是这些包装曲目），只有 song.song.cover
          //   的话队列里永远不显示封面。
          cover: song.cover || song.img || song.pic || '',
          song: song,
          provider: song.provider || '',
          interval: song.interval || ''
        };
      });
      list = list.concat(streams);
    } else if (S.view.indexOf('pl:') === 0) {
      var pl = S.playlists.find(function (p) { return p.id === S.view.slice(3); });
      var paths = pl ? pl.paths : [];
      var byPath = {};
      list.forEach(function (t) { byPath[t.path] = t; });
      // 不在曲库的 path（如拖入的外部文件被「从曲库删除」过）合成占位曲目照常显示/播放，
      // 标签由 ensureMeta 按 path 现读——否则拖进来的歌会「加进了却看不见」
      list = paths.map(function (p) {
        if (byPath[p]) return byPath[p];
        var nm = String(p).split(/[\\/]/).pop();
        return { path: p, name: nm, dir: String(p).slice(0, p.length - nm.length).replace(/[\\/]+$/, '') };
      }).filter(Boolean);
    } else if (S.view === 'albums' && S.albumKey) {
      list = list.filter(function (t) { return (trackMeta(t).album || '未知专辑') === S.albumKey; });
      list = sortAlbumDetailTracks(list); // V4.4.3：详情页独立排序（默认按发布碟号/曲目号）
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
    // V4.3.22：视图内搜索（歌曲/喜爱）——匹配字段跟随当前排序方式（标题/演唱者/文件名）
    var vq = (S.viewQuery && (S.view === 'songs' || S.view === 'favorites') ? (S.viewQuery[S.view] || '') : '').toLowerCase();
    if (vq) {
      var vfield = songSearchField(isSongs ? songSortMode() : favSortMode());
      list = list.filter(function (t) {
        var m = trackMeta(t);
        var v = vfield === 'artist' ? (m.artist || '') : vfield === 'name' ? (t.name || '') : (m.title || '');
        return v.toLowerCase().indexOf(vq) >= 0;
      });
    }
    if (isSongs) list = sortSongs(list); // V4.3.15：歌曲视图（含搜索结果）按所选方式排序
    else if (S.view === 'favorites') list = sortSongs(list, favSortMode()); // V4.3.22：喜爱歌曲同样可多方式排序
    else if (S.view.indexOf('pl:') === 0 && plSortMode() === 'azArtist') list = sortByInitial(list, 'artist'); // V4.4.6：播放列表按演唱者首字母
    return list;
  }
  function refreshPlaylists() {
    // ⚠️ 2026-10-22：同时加载「收藏的在线歌曲」（喜爱歌曲视图要用）
    try {
      window.mine.favoriteSongs().then(function (songs) {
        S.favSongs = songs || [];
        if (S.view === 'favorites' && renderView) renderView();
      }).catch(function () { });
    } catch (e) { }
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
    // ⚠️ 2026-10-24（用户要求）：切换模式后点播放 → 直接断点续播，
    //   不需要先点顶部「⏵ 续播」条。切换完成时 theme.js 会置 __annieResumePending。
    if (window.annieTheme && window.annieTheme.hasResume && window.annieTheme.hasResume()) {
      window.annieTheme.doResume();
      return;
    }
    // ⚠️ 2026-10-22：修复「重启后点播放没反应」（用户反馈「播放控件无法直接操作继续播放」）。
    //    恢复续播后 state.currentStream 有值（界面显示歌名/封面/进度），
    //    但引擎里**没有加载任何音频**（我们刻意不自动播放）。
    //    这时点播放会走 engine('resume') —— 引擎空转，什么都不发生。
    //    正确做法：检测到「有 currentStream 但引擎没在播」→ 真正调 playStreamAt 起播。
    if (state.currentStream && window.__annieAMInternal && window.__annieAMInternal.playStreamAt) {
      var _AMx = window.__annieAMInternal;
      var _list = _AMx.S._playList || _AMx.S.stResults || [];
      var _idx = _AMx.S.stIndex;
      // 引擎里没有播放项（state.playing=false 且从未加载过）→ 起播
      if (!window.__amEngineLoaded) {
        if (_list.length && _idx >= 0 && _list[_idx]) {
          _AMx.playStreamAt(_idx, _list);   // 内部会处理 __amResumePending 的断点 seek
          return;
        }
      }
    }
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
  function bindProgDrag(bar, fillEl, curEl, hooks) { // hooks（可选）：{ onPreview(秒), onSeek(从秒, 到秒) }——V4.4 彩胶表把联动用
    // V4.4：hover 时间预览气泡（挂父级进度行——主进度条自身 overflow:hidden 会裁掉气泡）
    var tipHost = bar.parentElement || bar;
    var tip = el('span', 'am-prog-tip');
    tip.style.display = 'none';
    tipHost.appendChild(tip);
    function showTipAt(clientX) {
      if (!state.currentPath || !(S.dur > 0)) { tip.style.display = 'none'; return; }
      var rb = bar.getBoundingClientRect(), rp = tipHost.getBoundingClientRect();
      var f = rb.width > 0 ? Math.min(1, Math.max(0, (clientX - rb.left) / rb.width)) : 0;
      tip.textContent = fmtTime(f * S.dur);
      tip.style.left = (rb.left - rp.left + f * rb.width) + 'px';
      tip.style.display = 'block';
    }
    bar.addEventListener('pointermove', function (ev) { if (!state.seeking) showTipAt(ev.clientX); });
    bar.addEventListener('pointerleave', function () { if (!state.seeking) tip.style.display = 'none'; });
    bar.addEventListener('pointerdown', function (e) {
      // ⚠️ 2026-10-23 修复「迷你模式进度条拖不动」：
      //   原守卫是 `!state.currentPath || !(S.dur > 0)` —— 但迷你模式下在线曲目
      //   （AM / 流媒体）走 currentStream，state.currentPath 为空 → 直接 return，
      //   进度条完全不能交互。seek() 本身只依赖引擎，不需要 currentPath。
      if (!(S.dur > 0)) return;
      e.preventDefault();
      var fromPos = S.pos;
      var preview = function (ev) {
        var r = bar.getBoundingClientRect();
        var f = r.width > 0 ? Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) : 0;
        fillEl.style.width = (f * 100) + '%';
        if (curEl) curEl.textContent = fmtTime(f * S.dur);
        showTipAt(ev.clientX); // 拖拽中气泡持续跟手
        if (hooks && hooks.onPreview) hooks.onPreview(f * S.dur);
        return f;
      };
      state.seeking = true;
      var frac = preview(e);
      var move = function (ev) { frac = preview(ev); };
      var up = function () {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        state.seeking = false;
        tip.style.display = 'none';
        seek(frac * S.dur);
        if (hooks && hooks.onSeek) hooks.onSeek(fromPos, frac * S.dur);
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
  AM.favSortMode = favSortMode;
  AM.albumSortMode = albumSortMode;
  AM.plSortMode = plSortMode;   // V4.4.6
  AM.splSortMode = splSortMode; // V4.4.6
  /* V4.4.3：专辑详情页排序（独立持久化 ui.amAlbumDetailSort，与专辑列表页 amAlbumSort 分开）。
   * release = 按专辑发布顺序：碟号 disc → 曲目号 track（'no/of' 取前段）；
   *   无号曲目沉底按文件名自然序；CUE 虚拟分轨无标签，按 #cueN 数字续排；其余四种直接比较。 */
  function albumDetailSortMode() {
    return (window.annieSettings && annieSettings.ui.amAlbumDetailSort) || 'release';
  }
  function sortAlbumDetailTracks(list, mode) {
    mode = mode || albumDetailSortMode();
    var arr = list.slice();
    if (mode === 'release') {
      var num = function (s) { var n = parseInt(String(s || '').split('/')[0], 10); return isFinite(n) && n > 0 ? n : 0; };
      var cueNo = function (p) { var m = String(p || '').match(/#(cue|iso)(\d+)/i); return m ? parseInt(m[2], 10) : 0; };
      var metaOf = {};
      arr.forEach(function (t) { metaOf[t.path] = trackMeta(t); });
      arr.sort(function (a, b) {
        var am = metaOf[a.path], bm = metaOf[b.path];
        var ad = num(am.disc) || 1, bd = num(bm.disc) || 1; // 无碟号按第 1 碟处理（与单碟专辑同序）
        if (ad !== bd) return ad - bd;
        var at = num(am.track), bt = num(bm.track);
        var ac = cueNo(a.path), bc = cueNo(b.path);
        // CUE 分轨无 track 标签 → 用 #cueN；混合实体/分轨时无号沉底按文件名
        if (!at) at = ac;
        if (!bt) bt = bc;
        var ah = at > 0 ? 0 : 1, bh = bt > 0 ? 0 : 1;
        if (ah !== bh) return ah - bh;
        if (ah === 0 && at !== bt) return at - bt;
        var d = azCollator().compare(a.name, b.name);
        return d || azCollator().compare(a.path, b.path);
      });
      return arr;
    }
    if (mode === 'az') arr.sort(function (a, b) { return azCollator().compare(trackMeta(a).title, trackMeta(b).title); });
    else if (mode === 'azArtist') arr.sort(function (a, b) {
      var d = azCollator().compare(trackMeta(a).artist, trackMeta(b).artist);
      return d || azCollator().compare(trackMeta(a).title, trackMeta(b).title);
    });
    else if (mode === 'name') arr.sort(function (a, b) { return azCollator().compare(a.name, b.name); });
    else if (mode === 'durDesc') arr.sort(function (a, b) { return (trackMeta(b).duration) - (trackMeta(a).duration); });
    else if (mode === 'durAsc') arr.sort(function (a, b) { return (trackMeta(a).duration) - (trackMeta(b).duration); });
    return arr;
  }
  AM.albumDetailSortMode = albumDetailSortMode;
  AM.sortAlbumDetailTracks = sortAlbumDetailTracks;
  AM.songSearchField = songSearchField;
  AM.azCollator = azCollator;
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
