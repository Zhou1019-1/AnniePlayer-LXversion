'use strict';
/* ===== am.js 拆分片：am-stream.js =====
 * 在线音乐：洛雪搜索/排行榜/歌单广场、在线歌曲表、单曲与批量下载、流媒体续播接管
 * 来源：am.js 原稿行 275-387 + 872-1247（原样切片，零行为变更）
 * 共享变量经 window.__annieAMInternal 桥接；前向引用为转发桩，运行时解析。 */
(function () {
  var AM = window.__annieAMInternal || (window.__annieAMInternal = {}); // AM 主题内部模块桥（跨分片共享闭包变量）
  // 从桥取用先加载分片导出的引用（此时前片已执行完，引用有效）
  var S = AM.S;
  var R = AM.R;
  var PLATFORMS = AM.PLATFORMS;
  var TYPE_LABEL = AM.TYPE_LABEL;
  var el = AM.el;
  var esc = AM.esc;
  var fmtTime = AM.fmtTime;
  var seek = AM.seek;
  // 前向引用：目标函数由后加载分片注册到桥，调用时才取值（加载期取不到）
  function renderView() { return AM.renderView.apply(this, arguments); }
  function refreshBadge() { return AM.refreshBadge.apply(this, arguments); }
  function renderSidebar() { return AM.renderSidebar.apply(this, arguments); }

  /* ---------------- 洛雪在线搜索 ---------------- */
  // V3.5.14：搜索历史（localStorage，最多 15 条，datalist 提示）
  var STH_KEY = 'annieplayer.stHistory';
  function stHist() { try { return JSON.parse(localStorage.getItem(STH_KEY) || '[]'); } catch (e) { return []; } }
  function stHistPush(kw) {
    if (!kw) return;
    var a = stHist().filter(function (x) { return x !== kw; });
    a.unshift(kw);
    try { localStorage.setItem(STH_KEY, JSON.stringify(a.slice(0, 15))); } catch (e) { }
  }
  function doStreamSearch(fresh) {
    var kw = S.stKw;
    if (!kw || S.stSearching) return;
    if (fresh) stHistPush(kw);
    S.stSearching = true;
    var provider = S.stProvider;
    var page = fresh ? 1 : S.stPage + 1;
    renderStreamStatus(fresh ? PLATFORMS[provider] + ' 搜索中…' : '加载第 ' + page + ' 页…');
    window.mine.streamSearch({ provider: provider, keywords: kw, page: page, limit: 30 }).then(function (r) {
      // V4.4：stale 结果丢弃前必须复位 stSearching——否则搜索中切平台后所有后续搜索被守卫永久挡死
      if (provider !== S.stProvider && fresh) { S.stSearching = false; return; }
      S.stResults = fresh ? (r.songs || []) : S.stResults.concat(r.songs || []);
      if (fresh) S.stFilter = ''; // 新搜索清空筛选
      S.stPage = r.page || page;
      S.stAllPage = r.allPage || 1;
      if (fresh) S.stIndex = -1;
      S.stSearching = false;
      renderView();
      renderStreamStatus(PLATFORMS[provider] + '：共 ' + (r.total != null ? r.total : S.stResults.length) +
        ' 首 · 已加载 ' + S.stResults.length + ' 首（第 ' + S.stPage + '/' + S.stAllPage + ' 页）');
    }).catch(function (e) {
      S.stSearching = false;
      renderStreamStatus('搜索失败：' + (e.message || e), true);
    });
  }
  function renderStreamStatus(text, warn) { if (R.stStatus) { R.stStatus.textContent = text || ''; R.stStatus.classList.toggle('warn', !!warn); } }
  function stToast(msg) { try { if (typeof proToast === 'function') proToast(msg); } catch (e) { } }
  /* V4.3.5：播放队列泛化——搜索/榜单/专辑用 S.stResults（live 引用，加载更多自然续播）；
     在线歌单用独立快照数组（歌单编辑不影响进行中的队列）。S._playList 记录当前队列。 */
  function playStreamAt(i, queue) {
    var list = queue || S.stResults;
    var song = list[i];
    if (!song) return;
    S.stIndex = i;
    S._playList = list;
    highlightStreamRow();
    scrollStreamRowIntoView(true); // V4.3.13：切歌滚动跟随（含随机播放跳到远处）
    renderStreamStatus('正在获取播放地址：' + song.name + '…');
    window.mine.streamSongUrl({ provider: song.provider, quality: S.stQuality, song: song }).then(function (r) {
      if (S.stIndex !== i || S._playList !== list) return;
      if (!r || !r.playable || !r.url) { renderStreamStatus(song.name + '：' + ((r && r.message) || '无法播放'), true); return; }
      S.fmt = (r.quality || '') + (r.format ? ' · ' + String(r.format).toUpperCase() : '');
      refreshBadge();
      if (AM.showFmtOsd && S.fmt) AM.showFmtOsd(PLATFORMS[song.provider] + ' · ' + S.fmt); // V4.3.19：在线切歌格式 OSD
      renderStreamStatus(PLATFORMS[song.provider] + ' · ' + (r.quality || '') + ' ' + (r.format || '').toUpperCase() + ' · 独占输出中');
      if (window.annieStreamPlay) {
        // 单击即播（与洛雪流媒体面板一致）；annieStreamPlay 返回 false 表示引擎拒绝流地址
        // song 原样带上：播放中一键收藏需要洛雪原始曲目对象（含平台 ID/meta 供日后再解析）
        Promise.resolve(window.annieStreamPlay({
          url: r.url, headers: r.headers || null,
          title: song.name, artist: song.artist, album: song.album || '',
          cover: song.cover || '', duration: song.duration ? song.duration / 1000 : 0,
          provider: song.provider, quality: r.quality || '', song: song
        })).then(function (ok) {
          if (ok === false) { renderStreamStatus(song.name + '：播放失败，' + (window.__annieLastStreamError || '引擎未接受流地址'), true); return; }
          // 播放确认后取歌词：注入缓存 + 广播给 AM 歌词面板 + 同步粒子舞台
          if (window.mine.streamLyric) {
            window.mine.streamLyric({ provider: song.provider, song: song }).then(function (ly) {
              if (!ly || !ly.lrc) return;
              if (S.stIndex !== i || S._playList !== list || !state.currentStream || !state.currentPath) return;
              window.__annieStreamLrcByPath = window.__annieStreamLrcByPath || {};
              window.__annieStreamLrcByPath[state.currentPath] = ly.lrc;
              // 译文轨（源自带 tlyric）：一并缓存，AM 歌词按时间戳合并显示
              window.__annieStreamTlyByPath = window.__annieStreamTlyByPath || {};
              window.__annieStreamTlyByPath[state.currentPath] = ly.tlyric || '';
              if (window.annieStage && window.annieStage.setLyricText) window.annieStage.setLyricText(ly.lrc, ly.tlyric); // V4.4：译文轨一并注入舞台
              try { document.dispatchEvent(new CustomEvent('annie-stream-lyric', { detail: { path: state.currentPath } })); } catch (e) { }
            }).catch(function () { });
          }
        });
      }
      if (!song.cover && window.mine.streamGetPic) {
        window.mine.streamGetPic({ provider: song.provider, song: song }).then(function (p) {
          if (!(p && p.url)) return;
          song.cover = p.url;
          if (list.indexOf(song) < 0) return;
          if (S.view !== 'stream' && S.view.indexOf('spl:') !== 0) return;
          // V4.4：原位更新该行封面，绝不整视图 renderView——重建会把滚动位置打飞
          // （旧实现：首次播放封面缺席 → 取回后整表重建 → scrollTop 被钳回 0 →「定位乱跳」根因）
          var row = findStreamRowBySong(song);
          var img = row && row.querySelector('.am-c-cover');
          if (img) { img.style.visibility = ''; setAlbumCover(img, p.url); }
          // 歌单头部大图：该曲是歌单首曲且头部还是 ☁️ 占位时一并补上
          var pl = (S.view.indexOf('spl:') === 0) && currentSpl();
          if (pl && pl.items.length && pl.items[0].song === song && R.content) {
            var ph = R.content.querySelector('.am-pl-cover-ph');
            if (ph) {
              var himg = el('img', 'am-sl-cover');
              himg.alt = ''; himg.style.cssText = 'width:96px;height:96px;border-radius:8px;flex:none;object-fit:cover';
              setAlbumCover(himg, p.url);
              ph.replaceWith(himg);
            }
          }
        }).catch(function () { });
      }
    }).catch(function (e) { renderStreamStatus('获取播放地址失败：' + (e.message || e), true); });
  }
  function nextStream() {
    var list = S._playList || S.stResults;
    // V4.3.5：联动全局播放模式（单曲循环/随机类对在线队列生效；顺序类照旧）
    var m = window.anniePlayMode ? window.anniePlayMode.get() : 'list-seq';
    if (m === 'repeat-one') { playStreamAt(S.stIndex, list); return; }
    if (m === 'list-rand' || m === 'all-rand') {
      if (list.length > 1) {
        var ri;
        do { ri = Math.floor(Math.random() * list.length); } while (ri === S.stIndex);
        playStreamAt(ri, list);
      } else playStreamAt(S.stIndex, list);
      return;
    }
    if (S.stIndex < list.length - 1) { playStreamAt(S.stIndex + 1, list); return; }
    // V3.5.8：播放定时·播完当前列表停止（在线列表播完自然停止，补提示与清理）
    var t = window.annieSleepTimer && window.annieSleepTimer.get();
    if (t && t.type === 'queue') {
      window.annieSleepTimer.clear();
      try { if (typeof proToast === 'function') proToast('当前列表已播完，已停止'); } catch (e) { }
    }
  }
  function prevStream() { if (S.pos > 3) { seek(0); return; } if (S.stIndex > 0) playStreamAt(S.stIndex - 1, S._playList || S.stResults); }
  /* V4.3.26：歌曲身份键——歌单编辑后 S._playList 快照里的 song 与新渲染的 item.song 是不同对象引用，
   * 随机播放定位/高亮用 ===/indexOf 会找不到（用户反馈"随机切歌定位停在半路"根因）。
   * 统一按 provider + 平台ID（songmid/hash/id/rid）兜底 name|artist 比对。 */
  function songKey(s) {
    if (!s) return '';
    return (s.provider || '') + '|' + String(s.songmid || s.id || s.hash || s.rid || ((s.name || '') + '|' + (s.artist || '')));
  }
  /* 在渲染出的行里按「当前播放歌曲身份」找对应行（不依赖 S.stIndex 与视图行序一致） */
  function findStreamRowBySong(song) {
    if (!R.content || !song) return null;
    var key = songKey(song);
    var rows = R.content.querySelectorAll('.am-tr[data-st]');
    for (var k = 0; k < rows.length; k++) {
      var idx = +rows[k].dataset.st;
      // 当前视图对应列表：在线歌单视图用歌单 items，发现音乐用 stResults
      var list = (S.view.indexOf('spl:') === 0 && currentSpl()) ? currentSpl().items.map(function (x) { return x.song; }) : S.stResults;
      if (list && list[idx] && songKey(list[idx]) === key) return rows[k];
    }
    return null;
  }
  function highlightStreamRow() {
    if (!R.content) return;
    var cs = state.currentStream;
    var curSong = (cs && cs.song) || (S._playList && S._playList[S.stIndex]) || null;
    var rows = R.content.querySelectorAll('.am-tr[data-st]');
    rows.forEach(function (r) { r.classList.remove('cur'); });
    var row = findStreamRowBySong(curSong) || R.content.querySelector('.am-tr[data-st="' + S.stIndex + '"]');
    if (row) row.classList.add('cur');
  }
  /* V4.3.13：切歌后滚动跟随当前行（在可视区内则不打扰）。
   * 注意 #am-root 是滚动祖先，禁用 scrollIntoView——手动滚 R.content。 */
  function scrollStreamRowIntoView(auto) {
    setTimeout(function () {
      if (!R.content) return;
      // V4.3.26：按当前播放歌曲身份找行（歌单编辑后引用失效时索引会错位，身份匹配兜底）
      var cs = state.currentStream;
      var curSong = (cs && cs.song) || (S._playList && S._playList[S.stIndex]) || null;
      var row = findStreamRowBySong(curSong) || R.content.querySelector('.am-tr[data-st="' + S.stIndex + '"]');
      if (!row) return; // 当前视图不是播放来源列表 → 没有对应行，不动
      var cRect = R.content.getBoundingClientRect();
      var rRect = row.getBoundingClientRect();
      var visible = rRect.top >= cRect.top && rRect.bottom <= cRect.bottom;
      if (auto && visible) return;
      if (!visible) {
        var target = R.content.scrollTop + (rRect.top - cRect.top) - (cRect.height - rRect.height) / 2;
        if (R.content.scrollTo) R.content.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
        else R.content.scrollTop = Math.max(0, target);
      }
    }, 60);
  }
  /* 流媒体自然结束续播：仅当当前流来自 AM 搜索列表时才接管，否则交还 streaming.js 原逻辑 */
  function patchStreamPlayNext() {
    if (!window.annieStream || window.annieStream.__amPatched) return;
    var orig = window.annieStream.playNext;
    window.annieStream.playNext = function () {
      var list = S._playList || S.stResults;
      if (window.annieTheme && annieTheme.current === 'am' && state.currentStream &&
          S.stIndex >= 0 && list[S.stIndex] &&
          state.currentStream.title === list[S.stIndex].name) {
        // V3.5.8：播放定时·单曲循环 N 遍（在线播放）
        var t = window.annieSleepTimer && window.annieSleepTimer.get();
        if (t && t.type === 'repeatN') {
          t.played++;
          if (t.played < t.total) { playStreamAt(S.stIndex, list); return; }
          window.annieSleepTimer.clear();
          try { if (typeof proToast === 'function') proToast('单曲循环 ' + t.total + ' 遍已播完，已停止'); } catch (e) { }
          return;
        }
        nextStream();
      } else if (orig) orig();
    };
    window.annieStream.__amPatched = true;
  }

  /* ---------------- 发现音乐：数据加载（V3.5.4） ---------------- */
  function switchStreamTab(tab) {
    if (S.stTab === tab) return;
    S.tabSongs[S.stTab] = S.stResults; // 缓存旧页签列表
    S.stTab = tab;
    S.stResults = S.tabSongs[tab] || [];
    S.stIndex = -1;
    if (tab === 'boards' && (S.boardsProvider !== S.stProvider || !S.boards.length)) { renderView(); loadBoards(); return; }
    if (tab === 'lists' && !S.slDetailId && (S.slProvider !== S.stProvider || !S.slLists.length)) { renderView(); loadSongLists(1); return; }
    renderView();
  }
  function switchStreamProvider(k) {
    if (S.stProvider === k) return;
    S.stProvider = k;
    if (S.stTab === 'search') { if (S.stKw) doStreamSearch(true); else renderView(); }
    else if (S.stTab === 'boards') { renderView(); loadBoards(); }
    else if (S.stTab === 'albums') { // V4.3：切平台清专辑详情，有关键词则重搜（mg 不支持→主进程报错提示）
      S.abDetailId = ''; S.abDetailInfo = null;
      if (S.abKw && !S.abSearching) doAlbumSearch(true); else renderView();
    }
    else { S.slDetailId = ''; S.slDetailName = ''; S.slSearch = ''; renderView(); loadSongLists(1); }
  }
  function loadBoards() {
    var provider = S.stProvider;
    renderStreamStatus('加载' + PLATFORMS[provider] + '排行榜…');
    window.mine.streamLeaderboards({ provider: provider }).then(function (r) {
      if (S.stProvider !== provider) return;
      S.boards = r.list || []; S.boardsProvider = provider; S.boardSel = ''; S.boardName = '';
      renderView();
      renderStreamStatus(S.boards.length ? '' : '该平台暂无排行榜');
    }).catch(function (e) { renderStreamStatus('排行榜加载失败：' + (e.message || e), true); });
  }
  function loadBoardList(bangid, name, page) {
    renderStreamStatus('加载「' + name + '」…');
    window.mine.streamLeaderboardList({ provider: S.stProvider, bangid: bangid, page: page || 1 }).then(function (r) {
      S.stResults = page > 1 ? S.stResults.concat(r.songs || []) : (r.songs || []);
      S.stIndex = -1; S.boardSel = bangid; S.boardName = name;
      if (!(page > 1)) S.stFilter = ''; // 新榜单清空筛选
      S.bdPage = r.page || 1; S.bdAllPage = r.allPage || 1;
      renderView();
      renderStreamStatus('「' + name + '」共 ' + (r.total || S.stResults.length) + ' 首 · 已加载 ' + S.stResults.length + ' 首');
    }).catch(function (e) { renderStreamStatus('榜单加载失败：' + (e.message || e), true); });
  }
  function loadSongLists(page) {
    var provider = S.stProvider;
    renderStreamStatus('加载歌单广场…');
    window.mine.streamSongLists({ provider: provider, page: page || 1 }).then(function (r) {
      if (S.stProvider !== provider) return;
      S.slLists = page > 1 ? S.slLists.concat(r.list || []) : (r.list || []);
      S.slProvider = provider; S.slPage = r.page || 1; S.slLimit = r.limit || 30; S.slTotal = r.total || 0;
      renderView(); renderStreamStatus('');
    }).catch(function (e) { renderStreamStatus('歌单加载失败：' + (e.message || e), true); });
  }
  /* V4.3.16：歌单关键词搜索（当前平台；结果复用广场网格，清空 slSearch 即回广场） */
  function searchSongLists(text, page) {
    var provider = S.stProvider;
    renderStreamStatus('搜索歌单「' + text + '」…');
    window.mine.streamSongListSearch({ provider: provider, text: text, page: page || 1 }).then(function (r) {
      if (S.stProvider !== provider || S.slSearch !== text) return;
      S.slLists = page > 1 ? S.slLists.concat(r.list || []) : (r.list || []);
      S.slProvider = provider; S.slPage = r.page || 1; S.slLimit = r.limit || 20; S.slTotal = r.total || 0;
      renderView();
      renderStreamStatus(S.slLists.length ? '' : '没有找到与「' + text + '」相关的歌单');
    }).catch(function (e) { renderStreamStatus('歌单搜索失败：' + (e.message || e), true); });
  }
  /* V3.5.14：解析歌单链接 / 纯 ID → { provider, id }；无法识别返回 null */
  function parsePlaylistInput(text) {
    text = String(text || '').trim();
    if (!text) return null;
    if (/^\d{4,}$/.test(text)) return { provider: S.stProvider, id: text };
    var m;
    if (/music\.163\.com|netease/i.test(text)) {
      m = text.match(/[?&]id=(\d+)/) || text.match(/playlist\/(\d+)/);
      return m ? { provider: 'wy', id: m[1] } : null;
    }
    if (/y\.qq\.com|qq\.com/i.test(text)) {
      m = text.match(/playlist\/(\d+)/) || text.match(/[?&](?:id|disstid)=(\d+)/);
      return m ? { provider: 'tx', id: m[1] } : null;
    }
    if (/kugou\.com/i.test(text)) {
      m = text.match(/special\/single\/(\d+)/) || text.match(/songlist\/(\d+)/) || text.match(/(\d{5,})/);
      return m ? { provider: 'kg', id: m[1] } : null;
    }
    if (/kuwo\.cn/i.test(text)) {
      m = text.match(/playlist_detail\/(\d+)/) || text.match(/playlists?\/(\d+)/) || text.match(/[?&]pid=(\d+)/);
      return m ? { provider: 'kw', id: m[1] } : null;
    }
    if (/migu\.cn/i.test(text)) {
      m = text.match(/playlist\/(\d+)/) || text.match(/[?&]id=(\d+)/);
      return m ? { provider: 'mg', id: m[1] } : null;
    }
    return null;
  }
  function loadSongListDetail(id, name, page) {
    renderStreamStatus('加载歌单「' + name + '」…');
    window.mine.streamSongListDetail({ provider: S.stProvider, id: id, page: page || 1 }).then(function (r) {
      // V4.3.15：详情接口带回歌单真实名称——导入场景占位名（"导入的歌单"）被替换，
      // 已收藏条目若还是占位名/旧名一并自愈（收藏的是 id，改名不丢收藏）
      var realName = (r.info && r.info.name) || name;
      // V4.4：详情接口的歌单真实封面——收藏条目补 img（侧栏「收藏的歌单」小封面数据源）
      var realImg = (r.info && (r.info.img || r.info.pic)) || '';
      S.slDetailImg = realImg;
      if (r.info && (r.info.name || realImg)) {
        var favs = slFavs(), healed = false;
        favs.forEach(function (f) {
          if (String(f.id) === String(id) && f.provider === S.stProvider) {
            if (r.info.name && f.name !== r.info.name) { f.name = r.info.name; healed = true; } // 占位名/旧名自愈
            if (realImg && f.img !== realImg) { f.img = realImg; healed = true; } // 封面补齐/换图自愈
          }
        });
        if (healed) { slFavSave(favs); renderSidebar(); }
      }
      S.stResults = page > 1 ? S.stResults.concat(r.songs || []) : (r.songs || []);
      S.stIndex = -1; S.slDetailId = id; S.slDetailName = realName;
      if (!(page > 1)) S.stFilter = ''; // 新列表清空筛选（追加页保留）
      S.slDPage = r.page || 1; S.slDLimit = r.limit || 100; S.slDTotal = r.total || 0;
      renderView();
      renderStreamStatus('「' + realName + '」共 ' + (r.total || S.stResults.length) + ' 首 · 已加载 ' + S.stResults.length + ' 首');
    }).catch(function (e) { renderStreamStatus('歌单详情加载失败：' + (e.message || e), true); });
  }

  /* ---------------- V4.3：专辑搜索 / 专辑曲目（kg/kw/tx/wy 四源） ---------------- */
  function doAlbumSearch(fresh) {
    var kw = S.abKw;
    if (!kw || S.abSearching) return;
    if (S.stProvider === 'mg') { renderStreamStatus('咪咕暂不支持专辑搜索，请切换到酷狗/酷我/QQ/网易', true); return; }
    S.abSearching = true;
    S.abDetailId = ''; S.abDetailInfo = null;
    var provider = S.stProvider;
    var page = fresh ? 1 : S.abPage + 1;
    renderStreamStatus(fresh ? PLATFORMS[provider] + ' 搜索专辑中…' : '加载第 ' + page + ' 页…');
    window.mine.streamAlbumSearch({ provider: provider, keywords: kw, page: page, limit: 20 }).then(function (r) {
      if (provider !== S.stProvider && fresh) { S.abSearching = false; return; } // V4.4：同 stSearching 卡死修复
      S.abResults = fresh ? (r.albums || []) : S.abResults.concat(r.albums || []);
      S.abPage = r.page || page;
      S.abAllPage = r.allPage || 1;
      S.abSearching = false;
      renderView();
      renderStreamStatus(PLATFORMS[provider] + '：共 ' + (r.total != null ? r.total : S.abResults.length) +
        ' 张专辑 · 已加载 ' + S.abResults.length + ' 张（第 ' + S.abPage + '/' + S.abAllPage + ' 页）');
    }).catch(function (e) {
      S.abSearching = false;
      renderStreamStatus('专辑搜索失败：' + (e.message || e), true);
    });
  }
  function loadAlbumDetail(id) {
    var provider = S.stProvider;
    renderStreamStatus('加载专辑曲目…');
    window.mine.streamAlbumSongs({ provider: provider, id: id, page: 1 }).then(function (r) {
      S.stResults = r.songs || [];
      S.stFilter = ''; // 新专辑清空筛选
      S.stIndex = -1;
      S.abDetailId = id; S.abDetailInfo = r.info || null;
      renderView();
      renderStreamStatus('「' + (S.abDetailInfo && S.abDetailInfo.name || '') + '」共 ' + (r.total || S.stResults.length) + ' 首 · 已加载 ' + S.stResults.length + ' 首');
    }).catch(function (e) { renderStreamStatus('专辑曲目加载失败：' + (e.message || e), true); });
  }
  /* 专辑封面：http 图（酷我等）CSP 拦截 → 主进程代理转 dataURL；https 直载。
   * onFail：彻底失败时回调（侧栏小图标用来还原占位 emoji） */
  function setAlbumCover(img, url, onFail) {
    function fail() { img.style.visibility = 'hidden'; if (onFail) onFail(); }
    if (!url) { fail(); return; }
    if (/^https:/i.test(url)) { img.src = url; img.onerror = fail; return; }
    if (window.mine.streamCoverProxy) {
      window.mine.streamCoverProxy(url).then(function (r) {
        if (r && r.url) { img.src = r.url; img.onerror = fail; } else fail();
      }).catch(fail);
    } else fail();
  }
  AM.setStreamImg = setAlbumCover; // 侧栏歌单小封面（am-dom 片）复用同一 http 代理通道

  /* 音质列只显示「实际会播的档位」：与主进程 qualityCandidates 同一降级链（所选档 → 向下回退） */
  var QORDER = ['flac24bit', 'flac', '320k', '128k'];
  function effectiveQuality(song) {
    var avail = (song.types || []).map(function (t) { return t.type; });
    if (!avail.length) return S.stQuality; // 无档位信息（如专辑详情）→ 按所选档尝试
    var start = Math.max(0, QORDER.indexOf(S.stQuality));
    for (var i = start; i < QORDER.length; i++) if (avail.indexOf(QORDER[i]) >= 0) return QORDER[i];
    return S.stQuality; // 库里没有更低档：实际播放仍会从所选档尝试
  }
  function fillQualityBadge(badge, song) {
    var qt = effectiveQuality(song);
    badge.className = 'am-qbadge' + (qt === 'flac' || qt === 'flac24bit' ? ' hq' : '');
    badge.textContent = TYPE_LABEL[qt] || qt;
  }

  /* 搜索结果/榜单/歌单共用的歌曲表格（单击即播）
   * V4.3.22：多选模式——右键「多选」进入，行首复选框 + 全选/下载选中/退出；批量下载进任务队列 */
  function renderSongsTable(c) {
    if (!S.stSel || !(S.stSel instanceof Set)) S.stSel = new Set();
    if (S.stMulti) renderMsBar(c);
    // V4.3.26：结果内筛选框——已加载的歌单/榜单/收藏歌单/专辑曲目内再过滤定位（IME 组词期不重建，保焦点）
    var fbar = el('div', 'am-st-filterbar');
    var finput = el('input', 'am-spl-search');
    finput.type = 'text'; finput.placeholder = '🔍 在当前列表内筛选（歌名 / 艺人 / 专辑）…';
    finput.value = S.stFilter || '';
    var fTimer = 0, fComposing = false;
    finput.addEventListener('compositionstart', function () { fComposing = true; });
    finput.addEventListener('compositionend', function () { fComposing = false; applyF(); });
    function applyF() {
      clearTimeout(fTimer);
      fTimer = setTimeout(function () {
        var q = finput.value.trim();
        if (q === (S.stFilter || '')) return;
        S.stFilter = q;
        renderTb(); // 只重建表格区，筛选框不动
      }, 120);
    }
    finput.addEventListener('input', function () { if (!fComposing) applyF(); });
    fbar.appendChild(finput);
    c.appendChild(fbar);
    var tbHost = el('div');
    c.appendChild(tbHost);
    function renderTb() {
      tbHost.innerHTML = '';
      var q = (S.stFilter || '').trim().toLowerCase();
      var tb = el('table', 'am-table');
      tb.innerHTML = '<thead><tr>' + (S.stMulti ? '<th style="width:34px"></th>' : '') + '<th style="width:46px"></th><th>歌曲</th><th>艺人</th><th>专辑</th><th style="width:56px;text-align:right">时长</th><th style="width:72px">音质</th><th style="width:44px"></th><th style="width:44px"></th><th style="width:44px"></th></tr></thead>';
      var body = el('tbody');
      // 在线歌单播放中队列≠本表：高亮只认当前队列（防误标同索引行）
      var queueHere = !S._playList || S._playList === S.stResults;
      var shown = 0;
      S.stResults.forEach(function (song, i) {
        if (q) {
          var hay = ((song.name || '') + ' ' + (song.artist || '') + ' ' + (song.album || '')).toLowerCase();
          if (hay.indexOf(q) < 0) return;
        }
        shown++;
        var tr = el('tr', 'am-tr' + (queueHere && i === S.stIndex && !S.stMulti ? ' cur' : '') + (S.stMulti && S.stSel.has(song) ? ' sel' : ''));
        tr.dataset.st = i;
      if (S.stMulti) { // 多选模式：行首复选框，点击行=切换选中（不播放）
        var tdCk = el('td');
        var ck = document.createElement('input');
        ck.type = 'checkbox'; ck.checked = S.stSel.has(song); ck.className = 'am-ms-ck';
        ck.onclick = function (e) { e.stopPropagation(); toggleSel(song, tr, ck); };
        tdCk.appendChild(ck); tr.appendChild(tdCk);
      }
      var tdCover = el('td');
      var img = el('img', 'am-c-cover'); img.alt = ''; img.loading = 'lazy';
      if (song.cover) { img.src = song.cover; img.onerror = function () { img.style.visibility = 'hidden'; }; }
      else img.style.visibility = 'hidden';
      tdCover.appendChild(img); tr.appendChild(tdCover);
      tr.appendChild(el('td', 'am-c-title', esc(song.name)));
      tr.appendChild(el('td', 'am-c-dim', esc(song.artist || '未知艺人')));
      tr.appendChild(el('td', 'am-c-dim', esc(song.album || '')));
      var dur = song.interval || (song.duration ? fmtTime(song.duration / 1000) : '');
      var tdDur = el('td', 'am-c-dim', dur); tdDur.style.textAlign = 'right';
      tr.appendChild(tdDur);
      var tdQ = el('td');
      var bq = el('span', 'am-qbadge');
      bq.dataset.stq = i;
      fillQualityBadge(bq, song);
      tdQ.appendChild(bq);
      tr.appendChild(tdQ);
      // V4.3.5：收藏到在线歌单（♥ 弹出歌单选择器）
      var tdFav = el('td');
      var bFav = el('button', 'am-dl-btn', '♥');
      bFav.title = '收藏到在线歌单';
      bFav.onclick = function (e) { e.stopPropagation(); openSplPicker(e.clientX, e.clientY, [song]); };
      tdFav.appendChild(bFav); tr.appendChild(tdFav);
      // V4.3.16：复制平台分享链接
      var tdShare = el('td');
      var bShare = el('button', 'am-dl-btn', '🔗');
      bShare.title = '复制' + (PLATFORMS[song.provider] || '') + '分享链接';
      bShare.onclick = function (e) {
        e.stopPropagation();
        var url = window.annieShare && window.annieShare.trackUrl(song.provider, song);
        if (!url) { stToast('该平台暂不支持生成分享链接'); return; }
        window.annieShare.copy(url).then(function (ok) { stToast(ok ? '链接已复制：' + url : '复制失败'); });
      };
      tdShare.appendChild(bShare); tr.appendChild(tdShare);
      // V3.5.8：单曲下载按钮（V4.3.22 起统一进下载任务队列，见「下载情况」）
      var tdDl = el('td');
      var bDl = el('button', 'am-dl-btn', '⬇');
      bDl.title = '下载到下载目录（音质：' + S.stQuality + '）';
      bDl.onclick = function (e) {
        e.stopPropagation();
        bDl.textContent = '✓';
        setTimeout(function () { if (bDl.isConnected) bDl.textContent = '⬇'; }, 1500);
        queueDownloads([song]);
      };
      tdDl.appendChild(bDl); tr.appendChild(tdDl);
      if (S.stMulti) {
        tr.onclick = function () { toggleSel(song, tr, tr.querySelector('.am-ms-ck')); };
      } else {
        tr.onclick = function () { playStreamAt(i); };
        tr.ondblclick = function () { playStreamAt(i); };
        // 右键：多选 / 下载
        tr.oncontextmenu = function (e) { e.preventDefault(); openStRowMenu(e.clientX, e.clientY, i); };
      }
      body.appendChild(tr);
      });
      tb.appendChild(body);
      if (shown === 0) {
        tbHost.appendChild(el('div', 'am-empty', '当前列表没有匹配「' + S.stFilter + '」的歌曲'));
      } else {
        if (q) tbHost.appendChild(el('div', 'am-pl-meta', '匹配 ' + shown + ' / ' + S.stResults.length + ' 首'));
        tbHost.appendChild(tb);
      }
    }
    renderTb();
  }

  /* 多选：切换某行选中态（存歌曲对象引用——翻页/追加加载后选择依然正确；原地更新防滚动丢失） */
  function toggleSel(song, tr, ck) {
    if (S.stSel.has(song)) { S.stSel.delete(song); tr.classList.remove('sel'); if (ck) ck.checked = false; }
    else { S.stSel.add(song); tr.classList.add('sel'); if (ck) ck.checked = true; }
    var cnt = document.querySelector('.am-ms-count');
    if (cnt) cnt.textContent = '已选 ' + S.stSel.size + ' 首';
  }

  /* 多选工具条：全选 / 下载选中 / 退出 */
  function renderMsBar(c) {
    var bar = el('div', 'am-ms-bar');
    var bAll = el('button', 'am-btn', (S.stSel.size >= S.stResults.length && S.stResults.length) ? '☐ 取消全选' : '☑ 全选');
    bAll.onclick = function () {
      if (S.stSel.size >= S.stResults.length) S.stSel.clear();
      else S.stResults.forEach(function (song) { S.stSel.add(song); });
      renderView();
    };
    bar.appendChild(bAll);
    // V4.3.26：批量收藏到在线歌单（复用歌单选择器；在线曲目无本地文件，不能进本地播放列表——仅能进在线歌单）
    var bFavAll = el('button', 'am-btn', '♥ 加到在线歌单');
    bFavAll.onclick = function (e) {
      if (!S.stSel.size) { stToast('先勾选要收藏的歌曲'); return; }
      var songs = Array.from(S.stSel);
      openSplPicker(e.clientX, e.clientY, songs); // 选择器内部已弹提示；不退出多选，便于连续收藏到多个歌单
    };
    bar.appendChild(bFavAll);
    var bDl = el('button', 'am-btn', '⬇ 下载选中');
    bDl.onclick = function () {
      if (!S.stSel.size) { stToast('先勾选要下载的歌曲'); return; }
      var songs = Array.from(S.stSel);
      S.stMulti = false; S.stSel = new Set();
      queueDownloads(songs);
      renderView();
    };
    bar.appendChild(bDl);
    var bExit = el('button', 'am-btn', '✕ 退出多选');
    bExit.onclick = function () { S.stMulti = false; S.stSel = new Set(); renderView(); };
    bar.appendChild(bExit);
    bar.appendChild(el('span', 'am-ms-count', '已选 ' + S.stSel.size + ' 首'));
    c.appendChild(bar);
  }

  /* 右键小菜单：多选 / 下载——直接复用全局共享弹层 R.pop（与 ⊕ 菜单同一套），
   * 外点关闭走应用初始化时就注册好的成熟机制，不再自己挂监听（此前自挂监听各种关不掉） */
  function openStRowMenu(x, y, i) {
    var pop = R.pop;
    pop.innerHTML = '';
    var b1 = el('button', 'am-pop-item', '☑ 多选');
    b1.onclick = function () { pop.classList.remove('on'); S.stMulti = true; S.stSel = new Set([S.stResults[i]]); renderView(); };
    pop.appendChild(b1);
    var b2 = el('button', 'am-pop-item', '⬇ 下载');
    b2.onclick = function () { pop.classList.remove('on'); queueDownloads([S.stResults[i]]); };
    pop.appendChild(b2);
    pop.classList.add('on');
    var w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - h - 12) + 'px';
  }

  /* V4.3.22：下载统一入口——进主进程任务队列（下载情况视图管理，支持并发/暂停/重试） */
  function queueDownloads(songs) {
    if (!window.mine.dlAdd || !songs || !songs.length) return;
    var asu = (window.annieSettings && window.annieSettings.ui) || {};
    window.mine.dlAdd(songs.map(function (song) {
      return {
        provider: song.provider || S.stProvider, quality: S.stQuality, song: song,
        saveLrc: asu.saveLrc !== false, saveCover: asu.saveCover !== false
      };
    })).then(function (r) {
      try {
        if (typeof proToast === 'function') {
          proToast('已加入下载队列 ' + (r ? r.added : songs.length) + ' 首' +
            (r && r.skipped ? '（队列中已存在 ' + r.skipped + ' 首）' : '') + '，见「下载情况」');
        }
      } catch (e) { }
    }).catch(function () { });
  }

  /* V3.5.8：在线歌曲下载（复用主进程 stream:download） */
  var dlState = {}; // _dlKey → 按钮元素
  var dlBound = false;
  function bindDlProgress() {
    if (dlBound || !window.mine.onStreamDownloadProgress) return;
    dlBound = true;
    window.mine.onStreamDownloadProgress(function (p) {
      var btn = dlState[p.key];
      if (btn && btn.isConnected) {
        btn.textContent = p.total ? Math.floor(p.received / p.total * 100) + '%' : Math.floor(p.received / 1048576) + 'M';
      }
    });
  }
  function downloadSong(song, btn) {
    if (!window.mine.streamDownload || btn.disabled) return;
    bindDlProgress();
    var key = 'am-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    dlState[key] = btn;
    btn.disabled = true; btn.textContent = '…';
    var asu = (window.annieSettings && window.annieSettings.ui) || {};
    window.mine.streamDownload({
      provider: song.provider || S.stProvider,
      quality: S.stQuality,
      song: song,
      saveLrc: asu.saveLrc !== false,
      saveCover: asu.saveCover !== false,
      _dlKey: key
    }).then(function (r) {
      delete dlState[key];
      btn.textContent = '✓';
      try { if (typeof proToast === 'function') proToast('已下载：' + (song.name || '') + (r && r.downgraded ? '（已降级为 ' + (r.quality || '') + '）' : '')); } catch (e) { }
    }).catch(function (e) {
      delete dlState[key];
      btn.disabled = false; btn.textContent = '⬇';
      try { if (typeof proToast === 'function') proToast('下载失败：' + (e && e.message || e), 5000); } catch (err) { }
    });
  }

  /* V3.5.8：在线歌单收藏（localStorage 持久化，跨启动保留） */
  var SLFAV_KEY = 'annieplayer.slFavs';
  function slFavs() { try { return JSON.parse(localStorage.getItem(SLFAV_KEY) || '[]'); } catch (e) { return []; } }
  function slFavSave(a) { try { localStorage.setItem(SLFAV_KEY, JSON.stringify(a.slice(0, 200))); } catch (e) { } }
  function slIsFav(id) { return slFavs().some(function (f) { return f.id === id && f.provider === S.stProvider; }); }
  function renderMoreBtn(c, label, fn) {
    var more = el('button', 'am-btn', label);
    more.style.marginTop = '14px';
    more.onclick = fn;
    c.appendChild(more);
  }

  /* V3.5.14：批量下载当前已加载的全部结果（V4.3.22 起进任务队列，并发/暂停在「下载情况」管理） */
  function renderBatchDlBtn(c) {
    if (!S.stResults.length || !window.mine.dlAdd) return;
    var btn = el('button', 'am-btn', '⬇ 下载已加载 ' + S.stResults.length + ' 首');
    btn.style.marginTop = '14px'; btn.style.marginLeft = '10px';
    btn.onclick = function () { queueDownloads(S.stResults.slice()); };
    c.appendChild(btn);
  }

  /* ---------------- 在线音乐视图（搜索 / 排行榜 / 歌单广场） ---------------- */
  function renderStreamView(c) {
    c.appendChild(el('div', 'am-view-h', '在线音乐'));

    // 页签 + 音质
    var bar = el('div', 'am-st-bar');
    var tabBox = el('div', 'am-st-pfs');
    [['search', '搜索'], ['boards', '排行榜'], ['lists', '歌单广场'], ['albums', '专辑']].forEach(function (t) {
      var chip = el('button', 'am-chip' + (S.stTab === t[0] ? ' cur' : ''), t[1]);
      chip.onclick = function () { switchStreamTab(t[0]); };
      tabBox.appendChild(chip);
    });
    bar.appendChild(tabBox);
    var qSel = document.createElement('select');
    qSel.className = 'am-st-quality';
    [['flac24bit', 'Hi-Res'], ['flac', 'FLAC'], ['320k', '320K'], ['128k', '128K']].forEach(function (q) {
      var o = document.createElement('option'); o.value = q[0]; o.textContent = q[1]; qSel.appendChild(o);
    });
    qSel.value = S.stQuality;
    qSel.onchange = function () {
      S.stQuality = qSel.value;
      // 音质档变化 → 实时刷新音质角标为「实际会播的档位」
      document.querySelectorAll('[data-stq]').forEach(function (b) {
        var song = S.stResults[+b.dataset.stq];
        if (song) fillQualityBadge(b, song);
      });
    };
    bar.appendChild(qSel);
    c.appendChild(bar);

    // 平台
    var pfBar = el('div', 'am-st-bar');
    var pf = el('div', 'am-st-pfs');
    Object.keys(PLATFORMS).forEach(function (k) {
      var chip = el('button', 'am-chip' + (S.stProvider === k ? ' cur' : ''), PLATFORMS[k]);
      chip.onclick = function () { switchStreamProvider(k); };
      pf.appendChild(chip);
    });
    pfBar.appendChild(pf);
    c.appendChild(pfBar);

    // 搜索输入行（仅搜索页签）
    if (S.stTab === 'search') {
      var inpRow = el('div', 'am-st-inputrow');
      var inp = document.createElement('input');
      inp.className = 'am-st-input'; inp.placeholder = '搜索歌曲、艺人、专辑…（洛雪全平台音源）'; inp.value = S.stKw;
      inp.onkeydown = function (e) { if (e.key === 'Enter') { S.stKw = inp.value.trim(); doStreamSearch(true); } };
      var bGo = el('button', 'am-btn am-btn-accent', '搜索');
      bGo.onclick = function () { S.stKw = inp.value.trim(); doStreamSearch(true); };
      inpRow.appendChild(inp); inpRow.appendChild(bGo);
      // 搜索历史提示（datalist）
      var dl = el('datalist'); dl.id = 'am-st-history';
      stHist().forEach(function (h) { var o = document.createElement('option'); o.value = h; dl.appendChild(o); });
      inp.setAttribute('list', 'am-st-history');
      inpRow.appendChild(dl);
      c.appendChild(inpRow);
    }

    R.stStatus = el('div', 'am-st-status');
    c.appendChild(R.stStatus);

    if (S.stTab === 'boards') {
      // 榜单 chips（网格流式排列）
      var bdBox = el('div', 'am-st-pfs am-bd-pfs');
      S.boards.forEach(function (b) {
        var chip = el('button', 'am-chip' + (S.boardSel === b.bangid ? ' cur' : ''), b.name);
        chip.onclick = function () { loadBoardList(b.bangid, b.name, 1); };
        bdBox.appendChild(chip);
      });
      c.appendChild(bdBox);
      if (!S.stResults.length) {
        c.appendChild(el('div', 'am-empty', S.boards.length ? '选择一个榜单查看歌曲' : '正在加载榜单…'));
        return;
      }
      renderSongsTable(c);
      renderBatchDlBtn(c);
      if (S.bdPage < S.bdAllPage) renderMoreBtn(c, '加载更多（' + S.bdPage + '/' + S.bdAllPage + '）', function () { loadBoardList(S.boardSel, S.boardName, S.bdPage + 1); });
      return;
    }

    if (S.stTab === 'lists') {
      if (!S.slDetailId) {
        // V4.3.16：歌单关键词搜索（当前平台）
        var slsRow = el('div', 'am-st-inputrow');
        var slsInp = document.createElement('input');
        slsInp.className = 'am-st-input'; slsInp.placeholder = '搜索' + PLATFORMS[S.stProvider] + '歌单（关键词）…';
        slsInp.value = S.slSearch || '';
        var bSls = el('button', 'am-btn', '搜索歌单');
        function doSlSearch() {
          var kw = slsInp.value.trim();
          if (!kw) { if (S.slSearch) { S.slSearch = ''; loadSongLists(1); } return; }
          S.slSearch = kw;
          searchSongLists(kw, 1);
        }
        slsInp.onkeydown = function (e) { if (e.key === 'Enter') doSlSearch(); };
        bSls.onclick = doSlSearch;
        slsRow.appendChild(slsInp); slsRow.appendChild(bSls);
        c.appendChild(slsRow);
        // 搜索态提示条（✕ 清除回广场）
        if (S.slSearch) {
          var srow = el('div', 'am-st-pfs');
          srow.style.marginBottom = '10px';
          var schip = el('span', 'am-chip');
          schip.appendChild(el('span', '', '「' + S.slSearch + '」的搜索结果（' + (S.slTotal || 0) + '）'));
          var sx = el('span', 'am-chip-x', '✕');
          sx.title = '清除搜索，返回歌单广场';
          sx.onclick = function () { S.slSearch = ''; loadSongLists(1); };
          schip.appendChild(sx);
          srow.appendChild(schip);
          c.appendChild(srow);
        }
        // V3.5.14：歌单链接 / ID 导入（自动识别平台并跳转详情）
        var impRow = el('div', 'am-st-inputrow');
        var impInp = document.createElement('input');
        impInp.className = 'am-st-input'; impInp.placeholder = '粘贴歌单链接或歌单 ID（自动识别平台）…';
        var bImp = el('button', 'am-btn', '导入歌单');
        function doImport() {
          var p = parsePlaylistInput(impInp.value);
          if (!p) { renderStreamStatus('无法识别：请粘贴五大平台歌单链接，或直接输入数字歌单 ID（按当前平台解析）', true); return; }
          if (p.provider !== S.stProvider) { S.stProvider = p.provider; S.stResults = []; S.stIndex = -1; S.stFilter = ''; }
          impInp.value = '';
          loadSongListDetail(p.id, '导入的歌单', 1);
        }
        impInp.onkeydown = function (e) { if (e.key === 'Enter') doImport(); };
        bImp.onclick = doImport;
        impRow.appendChild(impInp); impRow.appendChild(bImp);
        c.appendChild(impRow);
        // V3.5.8：收藏的歌单（当前平台，点击直达，✕ 移除）
        var favs = slFavs().filter(function (f) { return f.provider === S.stProvider; });
        if (favs.length) {
          c.appendChild(el('div', 'am-view-h', '收藏的歌单'));
          var fbox = el('div', 'am-st-pfs');
          fbox.style.marginBottom = '14px';
          favs.forEach(function (f) {
            var chip = el('span', 'am-chip');
            chip.appendChild(el('span', '', f.name));
            chip.onclick = function () { loadSongListDetail(f.id, f.name, 1); };
            var x = el('span', 'am-chip-x', '✕');
            x.title = '移除收藏';
            x.onclick = function (e) {
              e.stopPropagation();
              slFavSave(slFavs().filter(function (v) { return !(v.id === f.id && v.provider === f.provider); }));
              renderSidebar(); renderView();
            };
            chip.appendChild(x);
            fbox.appendChild(chip);
          });
          c.appendChild(fbox);
        }
        // 歌单卡片网格
        if (!S.slLists.length) { c.appendChild(el('div', 'am-empty', '正在加载歌单…')); return; }
        var grid = el('div', 'am-sl-grid');
        S.slLists.forEach(function (pl) {
          var card = el('div', 'am-sl-card');
          var img = el('img', 'am-sl-cover'); img.alt = ''; img.loading = 'lazy';
          if (pl.img) { img.src = pl.img; img.onerror = function () { img.style.visibility = 'hidden'; }; }
          else img.style.visibility = 'hidden';
          card.appendChild(img);
          card.appendChild(el('div', 'am-sl-name', esc(pl.name)));
          card.appendChild(el('div', 'am-sl-meta', (pl.playCount ? pl.playCount + ' 播放' : '') + (pl.total ? ' · ' + pl.total + ' 首' : '')));
          card.onclick = function () { loadSongListDetail(pl.id, pl.name, 1); };
          grid.appendChild(card);
        });
        c.appendChild(grid);
        if (S.slPage * S.slLimit < S.slTotal) renderMoreBtn(c, '加载更多歌单（' + S.slLists.length + '/' + S.slTotal + '）', function () { S.slSearch ? searchSongLists(S.slSearch, S.slPage + 1) : loadSongLists(S.slPage + 1); });
        return;
      }
      // 歌单详情（返回 + 歌曲表）
      var barD = el('div'); barD.style.cssText = 'display:flex;gap:10px;margin-bottom:10px';
      var back = el('button', 'am-btn', '‹ 返回歌单广场');
      back.onclick = function () { S.slDetailId = ''; S.slDetailName = ''; S.stResults = S.tabSongs.lists = []; S.stFilter = ''; renderView(); };
      barD.appendChild(back);
      // V3.5.8：收藏歌单（★ 已收藏 / ☆ 未收藏）
      var bFav = el('button', 'am-btn', slIsFav(S.slDetailId) ? '★ 已收藏' : '☆ 收藏歌单');
      bFav.onclick = function () {
        var a = slFavs();
        var fi = a.findIndex(function (f) { return f.id === S.slDetailId && f.provider === S.stProvider; });
        if (fi >= 0) { a.splice(fi, 1); stToast('已取消收藏「' + S.slDetailName + '」'); }
        else {
          // V4.4：收藏时存歌单封面（详情接口带回的 img；广场卡片兜底），侧栏小封面用
          var cvImg = S.slDetailImg || '';
          if (!cvImg) {
            var inGrid = S.slLists.find(function (x) { return String(x.id) === String(S.slDetailId); });
            if (inGrid && inGrid.img) cvImg = inGrid.img;
          }
          a.unshift({ id: S.slDetailId, name: S.slDetailName, provider: S.stProvider, img: cvImg, at: Date.now() });
          stToast('已收藏「' + S.slDetailName + '」，侧栏「收藏的歌单」直达');
        }
        slFavSave(a);
        bFav.textContent = slIsFav(S.slDetailId) ? '★ 已收藏' : '☆ 收藏歌单';
        renderSidebar(); // 侧栏「收藏的歌单」分组即时增减
      };
      barD.appendChild(bFav);
      // V4.3.16：复制歌单平台分享链接
      var bLink = el('button', 'am-btn', '🔗 复制链接');
      bLink.title = '复制该歌单在' + PLATFORMS[S.stProvider] + '的分享链接';
      bLink.onclick = function () {
        var url = window.annieShare && window.annieShare.playlistUrl(S.stProvider, S.slDetailId);
        if (!url) { stToast('该平台暂不支持生成分享链接'); return; }
        window.annieShare.copy(url).then(function (ok) { stToast(ok ? '歌单链接已复制：' + url : '复制失败'); });
      };
      barD.appendChild(bLink);
      c.appendChild(barD);
      c.appendChild(el('div', 'am-view-h', esc(S.slDetailName)));
      if (!S.stResults.length) { c.appendChild(el('div', 'am-empty', '正在加载歌单歌曲…')); return; }
      renderSongsTable(c);
      renderBatchDlBtn(c);
      if (S.slDPage * S.slDLimit < S.slDTotal) renderMoreBtn(c, '加载更多（已加载 ' + S.stResults.length + '/' + S.slDTotal + '）', function () { loadSongListDetail(S.slDetailId, S.slDetailName, S.slDPage + 1); });
      return;
    }

    /* ---------------- V4.3：专辑页签 ---------------- */
    if (S.stTab === 'albums') {
      // 专辑详情（返回 + 专辑信息头 + 曲目表）
      if (S.abDetailId) {
        var barA = el('div'); barA.style.cssText = 'display:flex;gap:10px;margin-bottom:10px';
        var backA = el('button', 'am-btn', '‹ 返回专辑列表');
        backA.onclick = function () { S.abDetailId = ''; S.abDetailInfo = null; S.stResults = S.tabSongs.albums = []; S.stFilter = ''; renderView(); };
        barA.appendChild(backA);
        // V4.3.5：收藏整专到在线歌单（曲目加载完后可用）
        if (S.stResults.length) {
          var bFavAl = el('button', 'am-btn', '♥ 收藏整专（' + S.stResults.length + ' 首）');
          bFavAl.onclick = function (e) { e.stopPropagation(); openSplPicker(e.clientX, e.clientY, S.stResults.slice()); }; // stopPropagation：防 document 点击代理把刚打开的弹层立刻关掉
          barA.appendChild(bFavAl);
        }
        c.appendChild(barA);
        var ai = S.abDetailInfo;
        if (ai) {
          var head = el('div'); head.style.cssText = 'display:flex;gap:14px;margin-bottom:12px;align-items:flex-start';
          var aimg = el('img', 'am-sl-cover'); aimg.alt = ''; aimg.style.cssText = 'width:96px;height:96px;border-radius:8px;flex:none';
          setAlbumCover(aimg, ai.img);
          head.appendChild(aimg);
          var aiBox = el('div');
          aiBox.appendChild(el('div', 'am-view-h', esc(ai.name || '')));
          aiBox.appendChild(el('div', 'am-c-dim', esc((ai.artist || '') + (ai.date ? ' · ' + ai.date : '') + (ai.count ? ' · ' + ai.count + ' 首' : ''))));
          if (ai.desc) {
            var dsc = el('div', 'am-c-dim', esc(ai.desc));
            dsc.style.cssText = 'margin-top:6px;font-size:12px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden';
            aiBox.appendChild(dsc);
          }
          head.appendChild(aiBox);
          c.appendChild(head);
        }
        if (!S.stResults.length) { c.appendChild(el('div', 'am-empty', '正在加载专辑曲目…')); return; }
        renderSongsTable(c);
        renderBatchDlBtn(c);
        return;
      }
      // 专辑搜索行
      var abRow = el('div', 'am-st-inputrow');
      var abInp = document.createElement('input');
      abInp.className = 'am-st-input'; abInp.placeholder = '搜索专辑名，如「范特西」「魔杰座」…'; abInp.value = S.abKw;
      abInp.onkeydown = function (e) { if (e.key === 'Enter') { S.abKw = abInp.value.trim(); doAlbumSearch(true); } };
      var bAb = el('button', 'am-btn am-btn-accent', '搜索专辑');
      bAb.onclick = function () { S.abKw = abInp.value.trim(); doAlbumSearch(true); };
      abRow.appendChild(abInp); abRow.appendChild(bAb);
      c.appendChild(abRow);
      if (S.stProvider === 'mg') {
        c.appendChild(el('div', 'am-empty', '咪咕暂不支持专辑搜索——切到酷狗 / 酷我 / QQ / 网易试试'));
        return;
      }
      if (!S.abResults.length) {
        c.appendChild(el('div', 'am-empty', S.abKw ? '无匹配专辑' : '输入专辑名，搜索当前平台的专辑'));
        return;
      }
      var aGrid = el('div', 'am-sl-grid');
      S.abResults.forEach(function (a) {
        var card = el('div', 'am-sl-card');
        var img = el('img', 'am-sl-cover'); img.alt = ''; img.loading = 'lazy';
        setAlbumCover(img, a.img);
        card.appendChild(img);
        card.appendChild(el('div', 'am-sl-name', esc(a.name)));
        card.appendChild(el('div', 'am-sl-meta', esc(a.artist || '') + (a.date ? ' · ' + a.date : '') + (a.count ? ' · ' + a.count + ' 首' : '')));
        card.onclick = function () { loadAlbumDetail(a.id); };
        aGrid.appendChild(card);
      });
      c.appendChild(aGrid);
      if (S.abPage < S.abAllPage && !S.abSearching) {
        renderMoreBtn(c, '加载更多专辑（' + S.abPage + '/' + S.abAllPage + '）', function () { doAlbumSearch(false); });
      }
      return;
    }

    // 搜索页签
    if (!S.stResults.length) {
      c.appendChild(el('div', 'am-empty', S.stKw ? '无结果' : '输入关键词，从五大平台搜索在线音乐'));
      return;
    }
    renderSongsTable(c);
    renderBatchDlBtn(c);
    if (S.stPage < S.stAllPage && !S.stSearching) {
      renderMoreBtn(c, '加载更多（' + S.stPage + '/' + S.stAllPage + '）', function () { doStreamSearch(false); });
    }
  }

  /* ---------------- V4.3.5：在线歌单（流媒体收藏） ---------------- */
  /* 收藏选择器：单曲 ♥ / 整专收藏 / 播放中 ♥ 共用。songs 为洛雪原始曲目对象数组 */
  function openSplPicker(x, y, songs) {
    if (!songs || !songs.length) return;
    songs.forEach(function (s) { if (!s.provider) s.provider = S.stProvider; }); // 专辑详情曲目可能缺 provider
    var pop = R.pop;
    pop.innerHTML = '';
    pop.appendChild(el('div', 'am-pop-item', '收藏到在线歌单' + (songs.length > 1 ? '（' + songs.length + ' 首）' : ''))).style.fontWeight = '600';
    pop.appendChild(el('div', 'am-pop-sep'));
    function addTo(pl) {
      pop.classList.remove('on');
      window.mine.splAdd(pl.id, songs).then(function (r) {
        S.streamPlaylists = r.playlists;
        renderSidebar();
        if (S.view === 'spl:' + pl.id) renderView();
        stToast('已收藏 ' + r.added + ' 首到「' + pl.name + '」' + (r.added < songs.length ? '（重复已跳过）' : ''));
      }).catch(function (e) { console.error('[spl] 收藏失败', e); stToast('收藏失败：' + ((e && e.message) || e)); });
    }
    // V4.3.26：在线歌单 >8 个收敛为二级浮层，避免选择器被歌单列表顶出屏幕
    if ((S.streamPlaylists || []).length > 8) {
      AM.buildPopSubMenu(pop, '☁️ 收藏到在线歌单…', (S.streamPlaylists || []).map(function (pl) {
        return { label: pl.name + '（' + pl.items.length + ' 首）', pl: pl };
      }), function (item) { addTo(item.pl); });
    } else {
      (S.streamPlaylists || []).forEach(function (pl) {
        var it = el('button', 'am-pop-item', pl.name + '（' + pl.items.length + ' 首）');
        it.onclick = function () { addTo(pl); };
        pop.appendChild(it);
      });
    }
    if ((S.streamPlaylists || []).length) pop.appendChild(el('div', 'am-pop-sep'));
    var nw = el('button', 'am-pop-item', '＋ 新建在线歌单…');
    nw.onclick = function () {
      pop.classList.remove('on');
      window.anniePrompt('在线歌单名称', '新建在线歌单', function (name) {
        window.mine.splCreate(name).then(function (pls) {
          S.streamPlaylists = pls;
          renderSidebar();
          addTo(pls[pls.length - 1]);
        }).catch(function () { });
      });
    };
    pop.appendChild(nw);
    pop.classList.add('on');
    var w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - h - 12) + 'px';
  }

  function currentSpl() {
    if (S.view.indexOf('spl:') !== 0) return null;
    return (S.streamPlaylists || []).find(function (p) { return p.id === S.view.slice(4); }) || null;
  }
  /* 歌单播放：队列=歌单曲目快照（编辑歌单不影响进行中的队列）；上下首/自然结束续播走既有机制 */
  function playSplAt(pl, i) {
    var list = pl.items.map(function (it) {
      if (!it.song.provider) it.song.provider = it.provider;
      return it.song;
    });
    list._splId = pl.id; // V4.3.13：标记来源歌单，定位播放（🎯）时能切回该视图
    playStreamAt(i, list);
  }

  function renderSplView(c) {
    var pl = currentSpl();
    if (!pl) { S.view = 'stream'; renderView(); return; }
    // 头部（沿用本地播放列表的 am-pl-* 样式）
    var head = el('div', 'am-pl-head');
    // 封面：用第一首「有封面」的曲目（整专收藏即专辑封面），http 图走代理；无封面回退 ☁️ 占位
    var firstCover = '';
    for (var hci = 0; hci < pl.items.length; hci++) {
      var hsg = pl.items[hci] && pl.items[hci].song;
      if (hsg && hsg.cover) { firstCover = hsg.cover; break; }
    }
    if (firstCover) {
      var plImg = el('img', 'am-sl-cover');
      plImg.alt = ''; plImg.style.cssText = 'width:96px;height:96px;border-radius:8px;flex:none;object-fit:cover';
      setAlbumCover(plImg, firstCover);
      head.appendChild(plImg);
    } else head.appendChild(el('div', 'am-pl-cover-ph', '☁️'));
    var info = el('div', 'am-pl-info');
    var name = el('div', 'am-pl-name', pl.name);
    name.contentEditable = 'true'; name.spellcheck = false;
    name.onblur = function () {
      var n = name.textContent.trim();
      if (n && n !== pl.name) window.mine.splRename(pl.id, n).then(function (pls) { S.streamPlaylists = pls; renderSidebar(); });
    };
    name.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } };
    info.appendChild(name);
    info.appendChild(el('div', 'am-pl-meta', pl.items.length + ' 首在线歌曲 · 播放地址每次现解析'));
    var acts = el('div', 'am-pl-actions');
    var bPlay = el('button', 'am-btn am-btn-accent', '▶ 播放');
    bPlay.onclick = function () { if (pl.items.length) playSplAt(pl, 0); };
    var bShuffle = el('button', 'am-btn', '🔀 随机播放');
    bShuffle.onclick = function () { if (pl.items.length) playSplAt(pl, Math.floor(Math.random() * pl.items.length)); };
    acts.appendChild(bPlay); acts.appendChild(bShuffle);
    info.appendChild(acts);
    head.appendChild(info);
    // V4.3.26：歌单内搜索——输入即过滤定位（IME 组词期不重建输入框；data-st 保留原始索引，随机播放定位不受影响）
    var searchBox = el('input', 'am-spl-search');
    searchBox.type = 'text'; searchBox.placeholder = '🔍 在歌单内搜索（歌名 / 艺人 / 专辑）…';
    searchBox.value = S.splSearch || '';
    var searchTimer = 0, searchComposing = false;
    searchBox.addEventListener('compositionstart', function () { searchComposing = true; });
    searchBox.addEventListener('compositionend', function () { searchComposing = false; applySearch(); });
    function applySearch() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        var q = searchBox.value.trim();
        if (q === (S.splSearch || '')) return;
        S.splSearch = q;
        // 只重建表格区域，不重建设置/搜索框本身（保焦点与 IME 会话）
        renderSplTable();
      }, 120);
    }
    searchBox.addEventListener('input', function () { if (!searchComposing) applySearch(); });
    info.appendChild(searchBox); // V4.4：挂 info 列（原来挂 head 成第三个 flex 子项，把按钮区挤成竖排文字）
    c.appendChild(head);
    if (!pl.items.length) { c.appendChild(el('div', 'am-empty', '歌单还是空的——在在线音乐的歌曲行上点 ♥ 收藏进来')); return; }

    R.stStatus = el('div', 'am-st-status'); // playStreamAt 的解析进度显示位
    c.appendChild(R.stStatus);

    // V4.3.26：表格渲染抽成函数——搜索过滤时单独重建表格区（不动搜索框，保焦点）
    var tbHost = el('div');
    c.appendChild(tbHost);
    function renderSplTable() {
      tbHost.innerHTML = '';
      var q = (S.splSearch || '').trim().toLowerCase();
      // 过滤后的 [原始索引, item] 对——data-st 始终保留歌单内原始索引，随机播放定位不受影响
      var rows = [];
      pl.items.forEach(function (it, i) {
        if (q) {
          var s = it.song;
          var hay = ((s.name || '') + ' ' + (s.artist || '') + ' ' + (s.album || '')).toLowerCase();
          if (hay.indexOf(q) < 0) return;
        }
        rows.push([i, it]);
      });
      if (!rows.length) {
        tbHost.appendChild(el('div', 'am-empty', q ? '歌单内没有匹配「' + S.splSearch + '」的歌曲' : '歌单还是空的'));
        return;
      }
      if (q) tbHost.appendChild(el('div', 'am-pl-meta', '匹配 ' + rows.length + ' / ' + pl.items.length + ' 首'));
      var tb = el('table', 'am-table');
      tb.innerHTML = '<thead><tr><th style="width:46px"></th><th>歌曲</th><th>艺人</th><th>专辑</th><th style="width:56px;text-align:right">时长</th><th style="width:64px">平台</th><th style="width:44px"></th><th style="width:44px"></th><th style="width:44px"></th></tr></thead>';
      var body = el('tbody');
      rows.forEach(function (pair) {
        var i = pair[0], it = pair[1];
        var song = it.song;
        if (!song.provider) song.provider = it.provider; // V4.3.13：下载/再解析依赖 provider（旧收藏可能没存进 song 里）
        // V4.3.26：cur 高亮按歌曲身份匹配（歌单编辑后 _playList 快照 song 与新 item.song 引用不同，=== 会失配）
        var curSong = (state.currentStream && state.currentStream.song) || (S._playList && S._playList[S.stIndex]);
        var cur = !!(curSong && songKey(curSong) === songKey(song));
        var tr = el('tr', 'am-tr' + (cur ? ' cur' : ''));
        tr.dataset.st = i;
        var tdCover = el('td');
        var img = el('img', 'am-c-cover'); img.alt = ''; img.loading = 'lazy';
        if (song.cover) { img.src = song.cover; img.onerror = function () { img.style.visibility = 'hidden'; }; }
        else img.style.visibility = 'hidden';
        tdCover.appendChild(img); tr.appendChild(tdCover);
        tr.appendChild(el('td', 'am-c-title', esc(song.name || '')));
        tr.appendChild(el('td', 'am-c-dim', esc(song.artist || '未知艺人')));
        tr.appendChild(el('td', 'am-c-dim', esc(song.album || '')));
        var dur = song.interval || (song.duration ? fmtTime(song.duration / 1000) : '');
        var tdDur = el('td', 'am-c-dim', dur); tdDur.style.textAlign = 'right';
        tr.appendChild(tdDur);
        var tdPf = el('td');
        tdPf.appendChild(el('span', 'am-qbadge', PLATFORMS[it.provider] ? PLATFORMS[it.provider].replace('音乐', '') : it.provider));
        tr.appendChild(tdPf);
        // V4.3.16：复制平台分享链接
        var tdShare2 = el('td');
        var bShare2 = el('button', 'am-dl-btn', '🔗');
        bShare2.title = '复制' + (PLATFORMS[it.provider] || '') + '分享链接';
        bShare2.onclick = function (e) {
          e.stopPropagation();
          var url = window.annieShare && window.annieShare.trackUrl(it.provider, song);
          if (!url) { stToast('该平台暂不支持生成分享链接'); return; }
          window.annieShare.copy(url).then(function (ok) { stToast(ok ? '链接已复制：' + url : '复制失败'); });
        };
        tdShare2.appendChild(bShare2); tr.appendChild(tdShare2);
        // V4.3.13：在线歌单补齐下载（与搜索结果行同一机制）
        var tdDl = el('td');
        var bDl = el('button', 'am-dl-btn', '⬇');
        bDl.title = '下载到下载目录（音质：' + S.stQuality + '）';
        bDl.onclick = function (e) { e.stopPropagation(); downloadSong(song, bDl); };
        tdDl.appendChild(bDl); tr.appendChild(tdDl);
        var tdRm = el('td');
        var bRm = el('button', 'am-dl-btn', '✕');
        bRm.title = '从歌单移除';
        bRm.onclick = function (e) {
          e.stopPropagation();
          window.mine.splRemove(pl.id, [i]).then(function (pls) {
            S.streamPlaylists = pls;
            renderSidebar(); renderView();
          });
        };
        tdRm.appendChild(bRm); tr.appendChild(tdRm);
        tr.onclick = function () { playSplAt(pl, i); };
        tr.ondblclick = function () { playSplAt(pl, i); };
        body.appendChild(tr);
      });
      tb.appendChild(body);
      tbHost.appendChild(tb);
    }
    renderSplTable();
  }

  /* 播放中一键收藏：顶栏 ♥ 调这里（song 来自 state.currentStream.song） */
  function favCurrentStream(x, y) {
    var cs = state.currentStream;
    if (!cs || !cs.song) { stToast('当前没有正在播放的在线歌曲'); return; }
    openSplPicker(x, y, [cs.song]);
  }


  /* V4.3.13：定位当前播放的在线曲目（顶栏 🎯 的流媒体分支）。
   * 找当前播放队列里的曲目行 → 视图不在来源时切回来源（在线歌单/在线音乐）→ 滚动 + 闪烁。
   * 注意 #am-root 是滚动祖先，禁用 scrollIntoView——手动滚 R.content。 */
  function locateStream() {
    var cs = state.currentStream;
    if (!cs || !cs.song) return;
    var list = S._playList || S.stResults;
    if (!list || !list.length) return;
    var idx = list.indexOf(cs.song);
    if (idx < 0) {
      // V4.3.26：歌单编辑过快照换对象——按身份（provider+平台ID，兜底 name|artist）匹配
      var key = songKey(cs.song);
      idx = list.findIndex(function (s) { return songKey(s) === key; });
    }
    if (idx < 0) return;
    var wantView = list._splId ? 'spl:' + list._splId : 'stream';
    if (S.view !== wantView) {
      S.view = wantView; renderSidebar(); renderView();
    } else renderView(); // 重渲染确保 cur 行/滚动目标存在
    highlightStreamRow();
    setTimeout(function () {
      if (!R.content) return;
      var row = R.content.querySelector('.am-tr[data-st="' + idx + '"]');
      if (!row) return;
      var cRect = R.content.getBoundingClientRect();
      var rRect = row.getBoundingClientRect();
      if (rRect.top < cRect.top || rRect.bottom > cRect.bottom) {
        var target = R.content.scrollTop + (rRect.top - cRect.top) - (cRect.height - rRect.height) / 2;
        if (R.content.scrollTo) R.content.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
        else R.content.scrollTop = Math.max(0, target);
      }
      row.classList.remove('locate-flash');
      void row.offsetWidth; // 重启动画
      row.classList.add('locate-flash');
      setTimeout(function () { row.classList.remove('locate-flash'); }, 2000);
    }, 60);
  }


  AM.renderStreamStatus = renderStreamStatus;
  AM.playStreamAt = playStreamAt;
  AM.nextStream = nextStream;
  AM.prevStream = prevStream;
  AM.patchStreamPlayNext = patchStreamPlayNext;
  AM.renderStreamView = renderStreamView;
  AM.renderSplView = renderSplView;       // V4.3.5：在线歌单视图
  AM.openSplPicker = openSplPicker;       // V4.3.5：收藏到在线歌单选择器
  AM.favCurrentStream = favCurrentStream; // V4.3.5：播放中一键收藏
  AM.copyCurrentStreamLink = function () {  // V4.3.16：复制播放中在线歌的分享链接
    var cs = state.currentStream;
    if (!cs || !cs.song) { stToast('当前没有正在播放的在线歌曲'); return; }
    var url = window.annieShare && window.annieShare.trackUrl(cs.song.provider || cs.provider, cs.song);
    if (!url) { stToast('该平台暂不支持生成分享链接'); return; }
    window.annieShare.copy(url).then(function (ok) { stToast(ok ? '链接已复制：' + url : '复制失败'); });
  };
  AM.locateStream = locateStream;         // V4.3.13：定位当前播放的在线曲目
  AM.scrollStreamRowIntoView = scrollStreamRowIntoView; // V4.4：切歌后终点校正（smooth 滚动被瞬时恢复掐断时补位）
  AM.downloadStreamSong = downloadSong;   // V4.3.13：迷你模式 ⬇ 复用

  /* 侧栏「收藏的歌单」直达：切到 在线音乐·歌单广场·对应平台 并加载该歌单详情 */
  function openFavSongList(f) {
    S.view = 'stream';
    if (S.stProvider !== f.provider) { S.stProvider = f.provider; S.slLists = []; S.slProvider = ''; }
    S.tabSongs[S.stTab] = S.stResults; // 缓存旧页签列表（与 switchStreamTab 同约定）
    S.stTab = 'lists';
    S.slDetailId = ''; S.slDetailName = ''; S.stResults = []; S.stFilter = '';
    S.stIndex = -1;
    renderSidebar(); renderView();
    loadSongListDetail(f.id, f.name, 1);
  }
  AM.slFavs = slFavs;             // 侧栏「收藏的歌单」分组数据源（am-dom 片消费）
  AM.slFavSave = slFavSave;
  AM.openFavSongList = openFavSongList;
})();
