'use strict';
/* 综合搜索（五平台聚合）—— macOS Lite 独立实现
 *
 * 2026-11-17 主人要求：把 iOS 那套「在线搜索」逻辑移植到桌面版，**不合并平台**
 *   —— 即：iOS/安卓的 web/m/m.js 一行不动，桌面这边单独一份实现；
 *      合并的只是「搜索结果」，平台代码本身仍然各写各的。
 *
 * 对应 iOS 侧的口径（web/m/m.js）：
 *   1) 五平台并发搜第 1 页（各 30 首），按「歌名 + 歌手 + 版本标记」合并成一行，
 *      同一行里保留各平台的源（播放时按平台优先级回退）；
 *   2) 相关度打分排序（歌名精确/前缀、版本压制、OST 加权、热度、歌手/专辑命中置顶）；
 *   3) 结果不足 10 首时用「模糊写法」再搜一次（只做等价写法，不猜错别字）；
 *   4) 后台补第 2、3 页，追加去重后重新排序；
 *   5) 每页 30 首，页码按当前总数重新算。
 *
 * 与 iOS 的差异（桌面这边不做，原因写在这里免得以后误以为是漏移植）：
 *   · 不做「后台逐首校验可播性」——iOS 现网流程也没启用（verifyAllItems / validateSearchResults
 *     只有定义没有调用），桌面改成**播放时**按平台顺序真实取址回退（resolveUrl）。
 *   · 不做歌手/专辑分类 tab（那是移动端界面结构，桌面侧栏不适用）。
 *
 * 依赖：只依赖注入进来的 mine（window.mine），不发 DOM 操作，方便脱离 App 单测。
 */
(function () {
  var PAGE_SIZE = 30;

  // 平台顺序即取源优先级（2026-11-11 主人口径：酷狗 > 酷我 > QQ > 网易 > 咪咕）
  var PLATFORMS = [
    { pf: 'kg', name: '酷狗' },
    { pf: 'kw', name: '酷我' },
    { pf: 'tx', name: 'QQ' },
    { pf: 'wy', name: '网易' },
    { pf: 'mg', name: '咪咕' }
  ];
  var PF_ORDER = PLATFORMS.map(function (p) { return p.pf; });
  function pfName(pf) {
    for (var i = 0; i < PLATFORMS.length; i++) if (PLATFORMS[i].pf === pf) return PLATFORMS[i].name;
    return pf || '';
  }
  function byPf(a, b) { return PF_ORDER.indexOf(a.pf) - PF_ORDER.indexOf(b.pf); }

  // ---------- 文本归一 ----------
  function unesc(s) {
    return String(s == null ? '' : s).replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
  }
  function normTitle(s) {
    return String(s || '')
      .replace(/[（(【\[].*?[)）】\]]/g, ' ')
      .replace(/(伴奏|ktv|remix|dj版|钢琴版|片段|纯音乐|翻唱|live|cover)/gi, ' ')
      .replace(/[\s·・\-—]+/g, '')
      .toLowerCase();
  }
  function normArtist(s) {
    return String(s || '').split(/[\/、,;&]/)[0].replace(/[\s·・\-—]+/g, '').toLowerCase();
  }

  // ---------- 版本标记（「原唱」与「DJ版/翻唱」绝不能并成一行）----------
  var VER_ASCII_RE = /(?:^|[^a-z])(dj|remix|cover|live|acoustic|instrumental|ktv|8d)(?=[^a-z]|$)/gi;
  var VER_CJK_RE = /(伴奏|翻唱|加速版?|慢速版?|降速版?|升速版?|升调版?|降调版?|混音版?|电音版?|慢摇|舞曲|纯音乐|钢琴版?|吉他版?|清唱|现场版?|演唱会版?|女声版?|男声版?|抖音版?|铃声版?)/g;
  var VER_CANON = {
    dj: 'dj', remix: 'dj', 混音: 'dj', 电音: 'dj', 慢摇: 'dj', 舞曲: 'dj',
    cover: 'cover', 翻唱: 'cover',
    live: 'live', 现场: 'live', 演唱会: 'live',
    伴奏: '伴奏', instrumental: '伴奏',
    加速: '加速', 慢速: '慢速', 降速: '慢速', 升调: '升调', 降调: '降调'
  };
  function versionTagKey(s) {
    var t = String(s || '').toLowerCase();
    var ascii = (t.match(VER_ASCII_RE) || []).map(function (x) { return x.replace(/[^a-z0-9]/g, ''); }).filter(Boolean);
    var cjk = (t.match(VER_CJK_RE) || []).map(function (x) { return String(x).replace(/版$/, ''); });
    var set = {};
    ascii.concat(cjk).forEach(function (k) { set[VER_CANON[k] || k] = 1; });
    return Object.keys(set).sort().join('+');
  }

  // ---------- 封面 ----------
  function songCoverOf(raw) {
    if (!raw) return '';
    var c = raw.picUrl || raw.img || raw.cover || raw.albumPic || '';
    if (!c && raw.artwork && raw.artwork.url) c = raw.artwork.url;
    if (!c && raw.al && raw.al.picUrl) c = raw.al.picUrl;
    return String(c || '');
  }
  // 各平台封面 URL 的尺寸参数不同：尽量换大图，避免放大后发糊（与 iOS 侧同一套规则）
  function upgradeCover(url) {
    if (!url) return '';
    var u = String(url);
    u = u.replace(/imge\.kugou\.com\/stdmusic\/\d+\//, 'imge.kugou.com/stdmusic/480/');
    u = u.replace(/_(\d{2,3})x(\d{2,3})\.(jpg|jpeg|png)/i, '_800x800.$3');
    u = u.replace(/T002R(\d+)x(\d+)M000/, 'T002R800x800M000');
    if (/music\.126\.net/.test(u)) {
      if (/[?&]param=\d+y\d+/.test(u)) u = u.replace(/([?&]param=)(\d+)y(\d+)/, '$11000y1000');
      else if (!/\?/.test(u)) u += '?param=1000y1000';
    }
    u = u.replace(/\/albumcover\/\d+\//, '/albumcover/1200/');
    u = u.replace(/\/starheads\/\d+\//, '/starheads/500/');
    u = u.replace(/_\d{3,4}\.jpg$/, '_800.jpg');
    return u;
  }

  // ---------- 合并：一首歌一行，行内挂各平台源 ----------
  function mergeResults(groups) {
    var map = Object.create(null);
    var out = [];
    (groups || []).forEach(function (g) {
      if (!g || !g.songs) return;
      g.songs.forEach(function (s) {
        // iOS 原始字段是 ar/singer；桌面桥接层已经映射成 artist，这里都兼容
        var artists = s.ar || s.artists || s.singer || s.singers || s.artist || '';
        if (Array.isArray(artists)) artists = artists.map(function (a) { return a.name || a; }).join(' / ');
        var title = unesc(s.name || s.title || s.songname || '');
        var artist = unesc(artists || '');
        if (!title) return;
        var key = normTitle(title) + '|' + normArtist(artist) + '|' + versionTagKey(title);
        var entry = map[key];
        if (!entry) {
          entry = map[key] = {
            key: key, title: title, artist: artist,
            album: unesc(s.albumName || s.album || ''),
            cover: '', covers: [],
            hot: s.hot || s.playCount || s.heats || 0,
            sources: []
          };
          out.push(entry);
        }
        // 同一平台只留一条源，否则音质菜单/回退会出现「酷狗/酷狗/酷狗」
        if (!entry.sources.some(function (x) { return x.pf === g.pf; })) {
          entry.sources.push({ pf: g.pf, raw: s });
        }
        var cv = s.img || s.pic || s.cover || songCoverOf(s);
        if (cv) {
          var up = upgradeCover(cv);
          if (entry.covers.indexOf(up) < 0) entry.covers.push(up);
          if (!entry.cover) entry.cover = cv;   // 最高优先级平台没封面时，先记住别家的
        }
      });
    });
    // 封面统一用最高优先级源的（与 iOS 一致：换源时不换封面）
    out.forEach(function (e) {
      e.sources.sort(byPf);
      var top = e.sources[0];
      if (top) {
        var s = top.raw;
        e.cover = s.img || s.pic || s.cover || s.picUrl || e.cover;
      }
      e.cover = upgradeCover(e.cover);
    });
    return out;
  }

  // ---------- 相关度打分（与 iOS 同一套权重） ----------
  var NAME_BOOST = { exact: 260, prefix: 190, minFreq: 3, albumExact: 90, albumPrefix: 70 };

  function nameHitTier(name, kw) {
    var n = String(name || '').trim().toLowerCase(), k = String(kw || '').trim().toLowerCase();
    if (!n || !k) return 0;
    if (n === k) return 2;
    if (n.indexOf(k) === 0 || k.indexOf(n) === 0) return 1;
    return 0;
  }

  function buildSearchContext(list, kw) {
    var artistFreq = Object.create(null), albumFreq = Object.create(null);
    var maxA = 1, maxB = 1;
    (list || []).forEach(function (it) {
      String(it.artist || '').split(/\s*[\/、,&]\s*/).forEach(function (one) {
        var k2 = one.toLowerCase();
        if (!k2) return;
        artistFreq[k2] = (artistFreq[k2] || 0) + 1;
        if (artistFreq[k2] > maxA) maxA = artistFreq[k2];
      });
      var ab = String(it.album || '').toLowerCase();
      if (ab) {
        albumFreq[ab] = (albumFreq[ab] || 0) + 1;
        if (albumFreq[ab] > maxB) maxB = albumFreq[ab];
      }
    });
    return {
      kw: String(kw || ''), total: (list || []).length || 1,
      artistFreq: artistFreq, albumFreq: albumFreq, maxA: maxA, maxB: maxB
    };
  }

  function searchRelevanceScore(x, kw, ctx) {
    var want = String(kw || '').toLowerCase();
    var wantNorm = normTitle(kw);
    var queryWantsVariant = /(伴奏|remix|dj|翻唱|钢琴|片段|live|纯音乐|cover|女声|男声|版)/i.test(kw);
    var VARIANT = /(伴奏|remix|dj|翻唱|钢琴版|片段|纯音乐|cover|live|女声版|男声版|抖音版|ktv)/i;
    var OST = /(ost|原声|主题曲|片尾曲|片头曲|插曲|电视剧|电影|剧集|原声带)/i;
    var rawTitle = String(x.title || '');
    var t = rawTitle.toLowerCase();
    var s = 0;
    // 1) 歌名匹配度
    if (normTitle(rawTitle) === wantNorm) s -= 100;
    else if (t.indexOf(want) === 0) s -= 30;
    else if (t.indexOf(want) < 0) s += 40;
    // 2) 版本压制：除非用户主动搜这种版本
    if (!queryWantsVariant && VARIANT.test(rawTitle)) s += 70;
    // 3) 影视剧原声带加权
    var meta = rawTitle + ' ' + (x.album || '');
    if (OST.test(meta)) s -= 35;
    // 4) 热度
    var hot = Number(x.hot || 0);
    if (hot > 0) s -= Math.min(20, Math.log10(1 + hot) * 4);
    // 5) 歌手/专辑名命中 → 置顶
    if (ctx) {
      var bestTier = 0, bestFreq = 0;
      String(x.artist || '').split(/\s*[\/、,&]\s*/).forEach(function (one) {
        var t2 = nameHitTier(one, ctx.kw);
        if (!t2) return;
        var f2 = ctx.artistFreq[String(one).trim().toLowerCase()] || 0;
        if (t2 > bestTier || (t2 === bestTier && f2 > bestFreq)) { bestTier = t2; bestFreq = f2; }
      });
      if (bestTier && bestFreq >= NAME_BOOST.minFreq) {
        var ashare = bestFreq / ctx.total;
        s -= (bestTier === 2 ? NAME_BOOST.exact : NAME_BOOST.prefix) * Math.min(1, 0.55 + ashare * 1.8);
      }
      var albName = String(x.album || '').trim();
      var albNorm = normTitle(albName), ttlNorm = normTitle(x.title);
      var sameAsTitle = !!albNorm && !!ttlNorm &&
        (albNorm === ttlNorm || albNorm.indexOf(ttlNorm) === 0 || ttlNorm.indexOf(albNorm) === 0);
      var albTier = sameAsTitle ? 0 : nameHitTier(albName, ctx.kw);
      var albFreq = albTier ? (ctx.albumFreq[albName.toLowerCase()] || 0) : 0;
      if (albTier && albFreq >= NAME_BOOST.minFreq && (albFreq / ctx.total) >= 0.02) {
        var bshare = albFreq / ctx.total;
        s -= (albTier === 2 ? NAME_BOOST.albumExact : NAME_BOOST.albumPrefix) * Math.min(1, 0.55 + bshare * 1.8);
      }
    }
    // 6) 平台优先级（校验/锁定后 sources[0] 就是最终取源平台）
    s += PF_ORDER.indexOf((x.sources && x.sources[0] && x.sources[0].pf) || 'mg') * 8;
    return s;
  }

  // ---------- 模糊写法（只做等价写法，不猜错别字）----------
  function fuzzyKeywords(kw) {
    var base = String(kw || '').replace(/\s+/g, ' ').trim();
    var out = [];
    function clean(v) {
      return String(v || '').replace(/[（）()【】《》\[\]［］{}〈〉「」『』]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function add(v) {
      v = clean(v);
      if (v.length < 2) return;
      if (v.toLowerCase() === base.toLowerCase()) return;
      for (var i = 0; i < out.length; i++) if (out[i].toLowerCase() === v.toLowerCase()) return;
      out.push(v);
    }
    var NO_CONTENT = /[（(【\[《][^）)】\]》]*[）)】\]》]/g;
    add(base.replace(NO_CONTENT, ' '));
    add(base.replace(/(remaster(ed)?|重制版?|重置版|数字修复|高清|无损|完整版|现场版?|live|伴奏|纯音乐|dj版?|钢琴版|翻唱版?|ktv|女声版?|男声版?)/ig, ' '));
    var parts = clean(base).split(/\s*[-–—/|·]\s*|\s{2,}/).filter(function (t) { return !!t; });
    if (parts.length === 2) { add(parts[1]); add(parts[0]); }
    add(base.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }));
    add(base);
    return out.slice(0, 3);
  }

  // ---------- 搜索会话 ----------
  var S = { kw: '', rows: [], gen: 0, firstWave: null, fill: null, done: false, fuzzyUsed: false };

  function safe(p, fallback) {
    return Promise.resolve(p).catch(function () { return fallback; });
  }

  function fetchGroups(kw, page, mine) {
    return Promise.all(PLATFORMS.map(function (p) {
      return safe(mine.streamSearch({ provider: p.pf, keywords: kw, page: page, limit: PAGE_SIZE }), null)
        .then(function (r) { return { pf: p.pf, songs: (r && r.songs) || [] }; });
    }));
  }

  function rescore(list, kw) {
    var ctx = buildSearchContext(list, kw);
    (list || []).forEach(function (m) { m.__rel = searchRelevanceScore(m, kw, ctx); });
    list.sort(function (a, b) { return (a.__rel || 0) - (b.__rel || 0); });
    return list;
  }

  function begin(kw, mine) {
    var gen = ++S.gen;
    S.kw = kw; S.rows = []; S.done = false; S.fuzzyUsed = false;
    S.firstWave = (async function () {
      var groups = await fetchGroups(kw, 1, mine);
      if (gen !== S.gen) return;
      var merged = mergeResults(groups);
      S.rows = rescore(merged, kw);
    })();
    S.fill = (async function () {
      await S.firstWave;
      if (gen !== S.gen) return;
      var seen = Object.create(null);
      S.rows.forEach(function (m) { seen[m.key] = 1; });
      function absorb(list) {
        var add = [];
        (list || []).forEach(function (m) { if (m && m.key && !seen[m.key]) { seen[m.key] = 1; add.push(m); } });
        if (!add.length) return 0;
        S.rows = rescore(S.rows.concat(add), kw);
        return add.length;
      }
      // ① 直搜太少（<10 首）→ 模糊写法再搜一轮
      if (S.rows.length < 10) {
        var vars = fuzzyKeywords(kw);
        if (vars.length) {
          S.fuzzyUsed = true;
          var lists = await Promise.all(vars.map(function (q) { return fetchGroups(q, 1, mine); }));
          if (gen !== S.gen) return;
          var flat = [];
          lists.forEach(function (g) { flat = flat.concat(g || []); });
          absorb(mergeResults(flat));
        }
      }
      // ② 补第 2、3 页
      var arr = await Promise.all([fetchGroups(kw, 2, mine), fetchGroups(kw, 3, mine)]);
      if (gen !== S.gen) return;
      var flat2 = [];
      arr.forEach(function (g) { flat2 = flat2.concat(g || []); });
      absorb(mergeResults(flat2));
      S.done = true;
    })().catch(function () { S.done = true; });
  }

  // 行 → 桌面沿用的「平铺歌曲对象」：字段和单平台搜索结果完全一致（renderResults/播放/下载都不用改）
  function toRow(entry) {
    var srcs = (entry.sources || []).slice().sort(byPf);
    var top = srcs[0] || { pf: '', raw: {} };
    var raw = top.raw || {};
    var row = {};
    for (var k in raw) if (Object.prototype.hasOwnProperty.call(raw, k)) row[k] = raw[k];
    row.provider = top.pf;
    row.name = entry.title;
    row.artist = entry.artist;
    row.album = entry.album || row.album || '';
    row.cover = entry.cover || row.cover || songCoverOf(raw);
    if (row.interval == null) row.interval = 0;
    row._aggSources = srcs.map(function (s) { return { pf: s.pf, raw: s.raw }; });
    return row;
  }

  function snapshot(page) {
    var from = (page - 1) * PAGE_SIZE;
    return {
      rows: S.rows.slice(from, from + PAGE_SIZE).map(toRow),
      page: page,
      allPage: Math.max(1, Math.ceil(S.rows.length / PAGE_SIZE)),
      total: S.rows.length,
      done: S.done,
      fuzzyUsed: S.fuzzyUsed
    };
  }

  async function search(opts) {
    opts = opts || {};
    var mine = opts.mine || (typeof window !== 'undefined' ? window.mine : null);
    if (!mine || !mine.streamSearch) throw new Error('音源服务未就绪');
    var kw = String(opts.kw || '').trim();
    if (!kw) throw new Error('先输入关键词再搜');
    var page = Math.max(1, (opts.page | 0) || 1);
    if (S.kw !== kw) begin(kw, mine);
    await S.firstWave;
    if (page >= 2) {
      // 等后台补页（有上限，不卡死界面）；超时就把当前已有的给出去
      await Promise.race([S.fill, new Promise(function (r) { setTimeout(r, opts.waitMs || 8000); })]);
    }
    return snapshot(page);
  }

  // 播放取址：按平台优先级逐个真实取地址，第一个可用就用它（把「点歌没反应」变成「换个平台自动播」）
  async function resolveUrl(row, quality, mine) {
    mine = mine || (typeof window !== 'undefined' ? window.mine : null);
    if (!mine || !mine.streamSongUrl) return { playable: false, message: '音源服务未就绪' };
    var srcs = ((row && row._aggSources) || []).slice().sort(byPf);
    if (!srcs.length) return { playable: false, message: '没有可用音源' };
    var errs = [];
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i];
      var song = {};
      for (var k in s.raw) if (Object.prototype.hasOwnProperty.call(s.raw, k)) song[k] = s.raw[k];
      song.provider = s.pf;
      try {
        var r = await mine.streamSongUrl({ provider: s.pf, quality: quality, song: song });
        if (r && r.playable && r.url) {
          row.provider = s.pf;
          return r;
        }
        errs.push(pfName(s.pf) + '：' + ((r && r.message) || '取不到地址'));
      } catch (e) {
        errs.push(pfName(s.pf) + '：' + ((e && e.message) || e || '请求失败'));
      }
    }
    return { playable: false, message: errs.join('；') };
  }

  var API = {
    PAGE_SIZE: PAGE_SIZE,
    PLATFORMS: PLATFORMS,
    PF_ORDER: PF_ORDER,
    pfName: pfName,
    search: search,
    resolveUrl: resolveUrl,
    reset: function () { S = { kw: '', rows: [], gen: 0, firstWave: null, fill: null, done: false, fuzzyUsed: false }; },
    // 纯函数（单测用）
    mergeResults: mergeResults,
    buildSearchContext: buildSearchContext,
    searchRelevanceScore: searchRelevanceScore,
    fuzzyKeywords: fuzzyKeywords,
    versionTagKey: versionTagKey,
    normTitle: normTitle,
    upgradeCover: upgradeCover
  };
  if (typeof window !== 'undefined') window.SearchAgg = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
