'use strict';
/* ===== am.js 拆分片：am-dom.js =====
 * 界面构建与本地视图：build() 主 DOM、侧栏、内容区（专辑网格/文件夹/歌单头/曲目表窗口化）、添加菜单、定位播放
 * 来源：am.js 原稿行 388-871 + 1248-1295 + 1499-1540（原样切片，零行为变更）
 * 共享变量经 window.__annieAMInternal 桥接；前向引用为转发桩，运行时解析。 */
(function () {
  var AM = window.__annieAMInternal || (window.__annieAMInternal = {}); // AM 主题内部模块桥（跨分片共享闭包变量）
  // 从桥取用先加载分片导出的引用（此时前片已执行完，引用有效）
  var S = AM.S;
  var R = AM.R;
  var LIGHT_KEY = AM.LIGHT_KEY;
  var el = AM.el;
  var esc = AM.esc;
  var isLight = AM.isLight;
  var allTracks = AM.allTracks;
  var trackMeta = AM.trackMeta;
  var ensureMeta = AM.ensureMeta;
  var ensureMetaDeep = AM.ensureMetaDeep;
  var albumCover = AM.albumCover;
  var folderRoots = AM.folderRoots;
  var folderChildren = AM.folderChildren;
  var normP = AM.normP;
  var currentTracks = AM.currentTracks;
  var playList = AM.playList;
  var togglePlay = AM.togglePlay;
  var next = AM.next;
  var prev = AM.prev;
  var seek = AM.seek;
  var bindProgDrag = AM.bindProgDrag; // V4.3.16：进度条拖动（顶栏/沉浸/迷你共用）
  var renderStreamView = AM.renderStreamView;
  var renderSplView = AM.renderSplView; // V4.3.5：在线歌单视图（am-stream 片先加载，引用有效）
  var applyLyrStyle = AM.applyLyrStyle;
  var toggleLyrSetPop = AM.toggleLyrSetPop;
  // 前向引用：目标函数由后加载分片注册到桥，调用时才取值（加载期取不到）
  function syncModeBtn() { return AM.syncModeBtn.apply(this, arguments); }
  function syncTimerBtn() { return AM.syncTimerBtn.apply(this, arguments); }
  function toggleTimerPop() { return AM.toggleTimerPop.apply(this, arguments); }
  function toggleImmersive() { return AM.toggleImmersive.apply(this, arguments); }
  function enterMini() { return AM.enterMini.apply(this, arguments); }
  function buildMini() { return AM.buildMini.apply(this, arguments); }

  /* ---------------- 构建 DOM ---------------- */
  function build() {
    var root = document.getElementById('am-root');
    root.innerHTML = '';
    root.classList.toggle('am-light', isLight());
    root.classList.toggle('am-lyr-on', S.lyricsOn);

    /* 顶栏（拖拽由 CSS 标准模式处理：容器 drag + 交互子元素 no-drag） */
    var top = el('div', 'am-topbar');
    var tp = el('div', 'am-transport');
    R.btnPrev = el('button', 'am-tbtn', '⏮'); R.btnPrev.title = '上一首';
    R.btnPlay = el('button', 'am-tbtn am-play', '▶'); R.btnPlay.title = '播放/暂停';
    R.btnNext = el('button', 'am-tbtn', '⏭'); R.btnNext.title = '下一首';
    R.btnPrev.onclick = prev; R.btnPlay.onclick = togglePlay; R.btnNext.onclick = next;
    tp.appendChild(R.btnPrev); tp.appendChild(R.btnPlay); tp.appendChild(R.btnNext);
    top.appendChild(tp);

    /* 中央：封面 + 标题/艺人 + 音质徽标；下行：当前时间 · 进度 · 剩余时间 */
    var np = el('div', 'am-np');
    var npRow = el('div', 'am-np-row');
    R.npCover = el('img', 'am-np-cover'); R.npCover.alt = '';
    var npText = el('div', 'am-np-text');
    R.npText = npText; // V4.1：切歌文本过渡动画需要容器引用
    R.npTitle = el('div', 'am-np-title', '未在播放');
    R.npSub = el('div', 'am-np-sub', '');
    npText.appendChild(R.npTitle); npText.appendChild(R.npSub);
    R.npBadge = el('span', 'am-badge'); R.npBadge.style.display = 'none';
    npRow.appendChild(R.npCover); npRow.appendChild(npText); npRow.appendChild(R.npBadge);
    np.appendChild(npRow);
    var progRow = el('div', 'am-np-progrow');
    R.npCur = el('span', 'am-np-time', '0:00');
    R.npProg = el('div', 'am-np-prog'); R.npProgFill = el('i');
    R.npProg.appendChild(R.npProgFill);
    bindProgDrag(R.npProg, R.npProgFill, R.npCur); // V4.3.16：可拖动（原仅点击）
    R.npRemain = el('span', 'am-np-time', '0:00');
    progRow.appendChild(R.npCur); progRow.appendChild(R.npProg); progRow.appendChild(R.npRemain);
    np.appendChild(progRow);
    top.appendChild(np);

    var right = el('div', 'am-tb-right');
    var vol = el('div', 'am-vol');
    // V4.1：🔊 图标可点击（静音/取消静音），悬停展开音量条
    var volIco = el('button', 'am-tbtn am-vol-ico', '🔊');
    volIco.title = '点击静音/取消静音；悬停展开音量条';
    volIco.onclick = function () {
      var cur = +R.vol.value;
      if (cur > 0) { S._muteVol = cur; R.vol.value = 0; }
      else { R.vol.value = S._muteVol || 80; }
      R.vol.oninput();
      volIco.textContent = +R.vol.value > 0 ? '🔊' : '🔇';
    };
    vol.appendChild(volIco);
    R.vol = document.createElement('input');
    R.vol.type = 'range'; R.vol.min = 0; R.vol.max = 100;
    var legacyVol = document.querySelector('#volume');
    R.vol.value = legacyVol ? legacyVol.value : 80;
    R.vol.oninput = function () {
      var g = (+R.vol.value) / 100;
      window.mine.engine('volume.set', { gain: g }).catch(function () { });
      if (legacyVol) legacyVol.value = R.vol.value; // 与粒子舞台底栏音量保持同步
    };
    vol.appendChild(R.vol);
    // V4.3.22：音量条关闭延迟——离开悬停区后保持 600ms，给鼠标移过去的余量；
    // 期间重新进入立即取消隐藏（隐形桥 ::after 是 vol 子元素，移到桥上不触发 mouseleave）
    var volHideT = null;
    function volKeep() { clearTimeout(volHideT); vol.classList.add('vol-open'); }
    function volScheduleHide() {
      clearTimeout(volHideT);
      volHideT = setTimeout(function () { vol.classList.remove('vol-open'); }, 600);
    }
    vol.addEventListener('mouseenter', volKeep);
    vol.addEventListener('mouseleave', volScheduleHide);
    R.vol.addEventListener('focus', volKeep); // 键盘 Tab 聚焦也保持
    // V4.3.22 修复：指针拖动结束后输入框仍持有 :focus，音量条卡在不消失。
    // 指针交互结束（change）即 blur；鼠标若还悬停区域上，:hover 会继续保持音量条。
    // volFromPtr 标记保证键盘方向键调节时不抢焦点。
    var volFromPtr = false;
    R.vol.addEventListener('pointerdown', function () { volFromPtr = true; });
    R.vol.addEventListener('change', function () {
      if (volFromPtr) { volFromPtr = false; R.vol.blur(); }
    });
    right.appendChild(vol);
    R.btnExcl = el('button', 'am-tbtn', (window.annieIsExclusive ? window.annieIsExclusive() : true) ? '🔒' : '🔓');
    R.btnExcl.title = 'WASAPI 独占/共享输出（独占 = bit-perfect）';
    R.btnExcl.onclick = async function () {
      if (!window.annieExclusiveToggle) return;
      var on = await window.annieExclusiveToggle();
      R.btnExcl.textContent = on ? '🔒' : '🔓';
    };
    document.addEventListener('annie-exclusive-changed', function (e) {
      if (R.btnExcl) R.btnExcl.textContent = (e.detail && e.detail.exclusive) ? '🔒' : '🔓';
    });
    R.btnLocate = el('button', 'am-tbtn', '🎯'); R.btnLocate.title = '定位当前播放文件';
    R.btnLocate.onclick = locatePlaying;
    right.appendChild(R.btnExcl); right.appendChild(R.btnLocate);
    // 播放模式循环切换（本地全量；在线支持顺序/随机/单曲循环）
    R.btnMode = el('button', 'am-tbtn', '→');
    syncModeBtn();
    R.btnMode.onclick = function () {
      if (!window.anniePlayMode) return;
      var inf = window.anniePlayMode.cycle();
      try { if (typeof proToast === 'function') proToast('播放模式：' + inf.label); } catch (e) { }
    };
    document.addEventListener('annie-playmode-changed', syncModeBtn);
    right.appendChild(R.btnMode);
    // 播放定时（仅本地播放生效）
    R.btnTimer = el('button', 'am-tbtn', '⏲');
    R.btnTimer.onclick = function (e) { e.stopPropagation(); toggleTimerPop(); };
    document.addEventListener('annie-sleeptimer-changed', syncTimerBtn);
    right.appendChild(R.btnTimer);
    // 沉浸式播放界面 / 迷你模式
    R.btnImm = el('button', 'am-tbtn', '⤢'); R.btnImm.title = '沉浸式播放界面';
    R.btnImm.onclick = function () { toggleImmersive(); };
    right.appendChild(R.btnImm);
    R.btnMiniM = el('button', 'am-tbtn', '🗕'); R.btnMiniM.title = '迷你模式';
    R.btnMiniM.onclick = function () { enterMini(); };
    right.appendChild(R.btnMiniM);
    // 桌面歌词快捷入口（Alt+L；状态跟随 annie-dlyrics-changed）
    var btnDlyr = el('button', 'am-tbtn' + ((window.annieDlyricsOn && window.annieDlyricsOn()) ? ' on' : ''), '🎤');
    btnDlyr.title = '桌面歌词（Alt+L）';
    btnDlyr.onclick = function () { if (window.annieDlyricsToggle) window.annieDlyricsToggle(); };
    document.addEventListener('annie-dlyrics-changed', function (e) { btnDlyr.classList.toggle('on', !!(e.detail && e.detail.on)); });
    right.appendChild(btnDlyr);
    // V4.3.5：播放中一键收藏（仅在线歌曲；本地歌曲走行内 ♥）
    var btnNpFav = el('button', 'am-tbtn', '♥');
    btnNpFav.title = '收藏正在播放的在线歌曲到在线歌单';
    btnNpFav.onclick = function (e) {
      e.stopPropagation(); // 防 document 点击代理把刚打开的收藏弹层立刻关掉
      var r = btnNpFav.getBoundingClientRect();
      if (AM.favCurrentStream) AM.favCurrentStream(r.left, r.bottom + 6);
    };
    right.appendChild(btnNpFav);
    // V4.3.16：复制播放中在线歌的平台分享链接
    var btnNpShare = el('button', 'am-tbtn', '🔗');
    btnNpShare.title = '复制正在播放的在线歌曲的分享链接';
    btnNpShare.onclick = function () { if (AM.copyCurrentStreamLink) AM.copyCurrentStreamLink(); };
    right.appendChild(btnNpShare);
    // 设置中心入口（与粒子舞台顶栏 ⚙ 同一个面板）
    var btnSet = el('button', 'am-tbtn', '⚙'); btnSet.title = '设置中心（Ctrl+,）';
    btnSet.onclick = function () { if (window.annieSettings) window.annieSettings.togglePanel(); };
    right.appendChild(btnSet);
    R.btnLyr = el('button', 'am-tbtn' + (S.lyricsOn ? ' on' : ''), '💬'); R.btnLyr.title = '歌词面板';
    R.btnLyr.onclick = function () {
      S.lyricsOn = !S.lyricsOn;
      root.classList.toggle('am-lyr-on', S.lyricsOn);
      R.btnLyr.classList.toggle('on', S.lyricsOn);
      syncLyrFold(); // 与面板左缘折叠小标签同步图标/方向
    };
    R.btnLight = el('button', 'am-tbtn', isLight() ? '🌙' : '☀'); R.btnLight.title = '亮色/暗色';
    R.btnLight.onclick = function () {
      var l = !isLight();
      try { localStorage.setItem(LIGHT_KEY, l ? '1' : '0'); } catch (e) { }
      root.classList.toggle('am-light', l);
      R.btnLight.textContent = l ? '🌙' : '☀';
    };
    R.btnTheme = el('button', 'am-tbtn', '🎨'); R.btnTheme.title = '切换主题（粒子舞台 → FB2K → Apple Music）';
    R.btnTheme.onclick = function () {
      var order = ['legacy', 'fb2k', 'am'];
      window.annieTheme.switch(order[(order.indexOf(annieTheme.current) + 1) % order.length]);
    };
    right.appendChild(R.btnLyr); right.appendChild(R.btnLight); right.appendChild(R.btnTheme);
    var wb = el('div', 'am-winbtns');
    var bMin = el('button', 'am-tbtn', '—'); bMin.title = '最小化'; bMin.onclick = function () { window.mine.winMin(); };
    var bMax = el('button', 'am-tbtn', '▢'); bMax.title = '最大化'; bMax.onclick = function () { window.mine.winMax(); };
    var bClose = el('button', 'am-tbtn am-close', '✕'); bClose.title = '关闭'; bClose.onclick = function () { window.mine.winClose(); };
    wb.appendChild(bMin); wb.appendChild(bMax); wb.appendChild(bClose);
    right.appendChild(wb);
    top.appendChild(right);

    /* 主体 */
    var body = el('div', 'am-body');
    R.sidebar = el('nav', 'am-side');
    R.content = el('div', 'am-content');    // 窗口化渲染：滚动时按可视区重建行（rAF 合并，避免滚动事件风暴）
    R.content.addEventListener('scroll', function () {
      if (!S._tbl || S._tblRAF) return;
      S._tblRAF = requestAnimationFrame(function () { S._tblRAF = 0; renderAmWindow(); });
    });
    var lyr = el('aside', 'am-lyrics');
    // V4.3.22：面板顶部封面（绝对定位叠加在歌词滚动区上方；无封面/开关关闭时隐藏）
    R.lyrCover = el('img', 'am-lyr-cover'); R.lyrCover.alt = '';
    lyr.appendChild(R.lyrCover);
    R.lyrScroll = el('div', 'am-lyr-scroll');
    lyr.appendChild(R.lyrScroll);
    // 歌词外观设置入口（悬浮 ⚙，hover 面板显现）
    R.btnLyrSet = el('button', 'am-lyr-set', '⚙');
    R.btnLyrSet.title = '歌词外观（字号 / 行距）';
    R.btnLyrSet.onclick = function (e) { e.stopPropagation(); toggleLyrSetPop(); };
    lyr.appendChild(R.btnLyrSet);
    // V4.3.22：歌词面板折叠小标签（贴面板左缘外侧，与沉浸队列抽屉同一交互）
    // 挂 .am-body 而非 .am-lyrics——面板 overflow:hidden 会把负 left 的子元素裁掉。
    // 双态：面板开=❯收回（贴面板左缘）；面板关=❮展开（贴窗口右缘），与顶栏 💬 互相同步
    var btnLyrFold = el('button', 'am-lyr-fold', S.lyricsOn ? '❯' : '❮');
    function syncLyrFold() {
      btnLyrFold.textContent = S.lyricsOn ? '❯' : '❮';
      btnLyrFold.title = S.lyricsOn ? '收回歌词面板' : '展开歌词面板';
    }
    syncLyrFold();
    btnLyrFold.onclick = function (e) {
      e.stopPropagation();
      S.lyricsOn = !S.lyricsOn;
      root.classList.toggle('am-lyr-on', S.lyricsOn);
      if (R.btnLyr) R.btnLyr.classList.toggle('on', S.lyricsOn);
      syncLyrFold();
    };
    body.appendChild(R.sidebar); body.appendChild(R.content); body.appendChild(lyr);
    body.appendChild(btnLyrFold);

    // V4.3.16：悬浮回顶部——滚过约 1.5 屏才浮出，点击平滑回顶（挂 .am-body 不随 content 清空，全视图通用）
    var backTop = el('button', 'am-backtop', '⤒');
    backTop.title = '返回顶部';
    backTop.onclick = function () { R.content.scrollTo({ top: 0, behavior: 'smooth' }); };
    body.appendChild(backTop);
    R.content.addEventListener('scroll', function () {
      backTop.classList.toggle('on', R.content.scrollTop > R.content.clientHeight * 1.5);
    }, { passive: true });

    /* 添加到播放列表弹出菜单 */
    R.pop = el('div', 'am-pop');
    /* 播放定时弹层 */
    R.timerPop = el('div', 'am-pop am-timer-pop');

    root.appendChild(top); root.appendChild(body); root.appendChild(R.pop); root.appendChild(R.timerPop);
    // V3.5.17：实时频谱可视化条（引擎 32 频段 10Hz 推送，贴底细条，迷你/沉浸下隐藏）
    R.vizBar = document.createElement('canvas'); R.vizBar.className = 'am-vizbar';
    R.vizBar.style.pointerEvents = 'auto'; R.vizBar.style.cursor = 'pointer';
    R.vizBar.title = '点击进入氛围模式（全屏频谱）';
    R.vizBar.onclick = function () { if (window.annieAmbient) annieAmbient.open(); };
    root.appendChild(R.vizBar);
    buildMini(root);
    document.addEventListener('click', function (e) {
      if (R.pop.classList.contains('on') && !R.pop.contains(e.target)) R.pop.classList.remove('on');
      if (R.timerPop.classList.contains('on') && !R.timerPop.contains(e.target) && e.target !== R.btnTimer) R.timerPop.classList.remove('on');
      if (R.lyrSetPop && R.lyrSetPop.classList.contains('on') && !R.lyrSetPop.contains(e.target) && e.target !== R.btnLyrSet) R.lyrSetPop.classList.remove('on');
    });

    renderSidebar();
    renderView();
    applyLyrStyle(); // 恢复歌词字号/行距设置（含初次自适应）
  }

  /* ---------------- 侧栏 ---------------- */
  function renderSidebar() {
    if (!R.sidebar) return;
    var sb = R.sidebar;
    sb.innerHTML = '';

    function nav(icon, name, view) {
      var b = el('button', 'am-nav' + (S.view === view && !S.albumKey && !S.folderPath ? ' cur' : ''));
      b.appendChild(el('span', 'am-nav-ico', icon));
      b.appendChild(el('span', 'am-nav-name', name));
      b.onclick = function () { S.view = view; S.albumKey = null; S.folderPath = null; renderSidebar(); renderView(); };
      return b;
    }

    sb.appendChild(el('div', 'am-side-h', '媒体库'));
    sb.appendChild(nav('🔍', '在线音乐', 'stream'));
    sb.appendChild(nav('⬇', '下载情况', 'downloads')); // V4.3.22：下载任务管理（洛雪式五标签）
    sb.appendChild(nav('🔷', 'Qobuz', 'qobuz')); // V4.3.6：Qobuz 在线播放/下载（登录自己的付费账号）
    // 添加文件夹：只作入口，文件夹列表不外显在 AM 界面（与粒子舞台/FB2K 不同）
    var addFolder = el('button', 'am-nav am-new');
    addFolder.appendChild(el('span', 'am-nav-ico', '＋'));
    addFolder.appendChild(el('span', 'am-nav-name', '添加歌曲文件夹…'));
    addFolder.onclick = function () {
      window.mine.pickFolder().then(function (store) {
        // pickFolder 返回最新 store——顺带刷新根目录列表（文件夹视图分组依赖）
        if (store && Array.isArray(store.folders)) S.libFolders = store.folders;
        return window.mine.scanStart();
      }).catch(function () { });
    };
    sb.appendChild(addFolder);

    sb.appendChild(el('div', 'am-side-h', '资料库'));
    sb.appendChild(nav('🎵', '歌曲', 'songs'));
    sb.appendChild(nav('💿', '专辑', 'albums'));
    sb.appendChild(nav('📁', '文件夹', 'folders'));
    sb.appendChild(nav('❤️', '喜爱歌曲', 'favorites'));

    sb.appendChild(el('div', 'am-side-h', '播放列表'));
    S.playlists.forEach(function (pl) {
      var b = nav('🎧', pl.name, 'pl:' + pl.id);
      var del = el('button', 'am-nav-del', '✕');
      del.title = '删除播放列表';
      del.onclick = function (e) {
        e.stopPropagation();
        if (!confirm('删除播放列表「' + pl.name + '」？')) return;
        window.mine.playlistDelete(pl.id).then(function (pls) {
          S.playlists = pls;
          if (S.view === 'pl:' + pl.id) S.view = 'songs';
          renderSidebar(); renderView();
        });
      };
      b.appendChild(del);
      sb.appendChild(b);
    });
    var add = el('button', 'am-nav am-new');
    add.appendChild(el('span', 'am-nav-ico', '＋'));
    add.appendChild(el('span', 'am-nav-name', '新建播放列表'));
    add.onclick = function () {
      amPrompt('播放列表名称', '新建播放列表', function (name) {
        window.mine.playlistCreate(name).then(function (pls) {
          S.playlists = pls;
          S.view = 'pl:' + pls[pls.length - 1].id;
          renderSidebar(); renderView();
        });
      });
    };
    sb.appendChild(add);

    // V4.3.22：导入 foobar2000 .fpl 播放列表（扫描曲库时也会自动识别媒体库内的 .fpl）
    var impFpl = el('button', 'am-nav am-new');
    impFpl.appendChild(el('span', 'am-nav-ico', '📥'));
    impFpl.appendChild(el('span', 'am-nav-name', '导入 FPL 播放列表…'));
    impFpl.title = '导入 foobar2000 播放列表（.fpl）；媒体库文件夹内的 .fpl 会在扫描曲库时自动导入';
    impFpl.onclick = function () {
      // 首次使用给引导：fpl 默认在 fb2k 配置目录，不在歌曲文件夹里
      try {
        if (localStorage.getItem('annieplayer.fplGuide') !== '1') {
          var go = confirm(
            '安妮播放器会在每次扫描曲库时，自动导入媒体库文件夹内的 foobar2000 播放列表（.fpl）。\n\n' +
            '但 foobar2000 默认把播放列表保存在自己的配置目录：\n%AppData%\\foobar2000\\playlists-v2.0\\（老版本为 playlists-v1.4）\n通常和你的歌曲文件夹不在一起，所以自动识别可能找不到。\n\n' +
            '想自动同步的话：在 foobar2000 里右键播放列表页签 → 另存为，把 .fpl 存到任一媒体库文件夹内，' +
            '下次扫描即自动导入；之后在 fb2k 里改了歌单重新另存一次，安妮会跟随更新。\n\n' +
            '点「确定」立即手动选择 .fpl 文件导入（可一次多选）。');
          localStorage.setItem('annieplayer.fplGuide', '1');
          if (!go) return;
        }
      } catch (e) { }
      window.mine.fplImport().then(function (r) {
        if (!r || r.canceled) return;
        if (r.playlists) S.playlists = r.playlists;
        var oks = (r.results || []).filter(function (x) { return x.ok; });
        var fails = (r.results || []).length - oks.length;
        var total = oks.reduce(function (s, x) { return s + x.count; }, 0);
        var msg = oks.length ? ('已导入 ' + oks.length + ' 个播放列表（共 ' + total + ' 首）') : '';
        if (fails) msg += (msg ? '，' : '') + fails + ' 个解析失败';
        try { if (msg && typeof proToast === 'function') proToast(msg); } catch (e) { }
        if (oks.length === 1) { // 只导入一个时直接跳过去
          var last = S.playlists[S.playlists.length - 1];
          if (last) { S.view = 'pl:' + last.id; renderSidebar(); renderView(); return; }
        }
        renderSidebar();
      }).catch(function () { });
    };
    sb.appendChild(impFpl);

    // V4.3.5：在线歌单（流媒体收藏；与本地播放列表并列但互不相混）
    sb.appendChild(el('div', 'am-side-h', '在线歌单'));
    (S.streamPlaylists || []).forEach(function (pl) {
      var b = nav('☁️', pl.name, 'spl:' + pl.id);
      // 图标位换成第一首曲目的封面缩略图（整专收藏即专辑封面），无封面保留 ☁️
      var fc = pl.items && pl.items.length && pl.items[0].song && pl.items[0].song.cover;
      if (fc) {
        var ico = b.querySelector('.am-nav-ico');
        var cv = el('img'); cv.alt = ''; cv.loading = 'lazy';
        cv.style.cssText = 'width:18px;height:18px;border-radius:4px;object-fit:cover;flex:none';
        cv.src = fc; cv.onerror = function () { cv.style.visibility = 'hidden'; };
        ico.textContent = ''; ico.appendChild(cv);
      }
      var del = el('button', 'am-nav-del', '✕');
      del.title = '删除在线歌单';
      del.onclick = function (e) {
        e.stopPropagation();
        if (!confirm('删除在线歌单「' + pl.name + '」？（不影响任何本地文件）')) return;
        window.mine.splDelete(pl.id).then(function (pls) {
          S.streamPlaylists = pls;
          if (S.view === 'spl:' + pl.id) S.view = 'stream';
          renderSidebar(); renderView();
        });
      };
      b.appendChild(del);
      sb.appendChild(b);
    });
    var addSpl = el('button', 'am-nav am-new');
    addSpl.appendChild(el('span', 'am-nav-ico', '＋'));
    addSpl.appendChild(el('span', 'am-nav-name', '新建在线歌单'));
    addSpl.onclick = function () {
      amPrompt('在线歌单名称', '新建在线歌单', function (name) {
        window.mine.splCreate(name).then(function (pls) {
          S.streamPlaylists = pls;
          S.view = 'spl:' + pls[pls.length - 1].id;
          renderSidebar(); renderView();
        });
      });
    };
    sb.appendChild(addSpl);

    // 收藏的平台歌单（歌单广场 ☆ 收藏歌单 的来源；localStorage，am-stream 片提供存取与跳转）
    var slFavs = AM.slFavs ? AM.slFavs() : [];
    if (slFavs.length) {
      sb.appendChild(el('div', 'am-side-h', '收藏的歌单'));
      slFavs.forEach(function (f) {
        var b = el('button', 'am-nav');
        b.appendChild(el('span', 'am-nav-ico', '🎵'));
        var pf = (AM.PLATFORMS && AM.PLATFORMS[f.provider]) ? AM.PLATFORMS[f.provider].replace('音乐', '') : f.provider;
        b.appendChild(el('span', 'am-nav-name', pf + ' · ' + f.name));
        b.onclick = function () { if (AM.openFavSongList) AM.openFavSongList(f); };
        var del = el('button', 'am-nav-del', '✕');
        del.title = '取消收藏';
        del.onclick = function (e) {
          e.stopPropagation();
          if (!AM.slFavSave) return;
          AM.slFavSave(AM.slFavs().filter(function (v) { return !(v.id === f.id && v.provider === f.provider); }));
          renderSidebar(); renderView();
        };
        b.appendChild(del);
        sb.appendChild(b);
      });
    }

    // 本地搜索（AM 语义：全库搜索；输入即切回歌曲视图并深加载全库标签）
    var sch = el('div', 'am-search');
    sch.appendChild(el('span', null, '⌕'));
    var inp = document.createElement('input');
    inp.placeholder = '搜索歌曲、艺人、专辑'; inp.value = S.search;
    inp.oninput = function () {
      S.search = inp.value.trim();
      if (S.search) {
        // 搜索是全库行为：专辑网格/文件夹列表/在线搜索里输入时切回歌曲列表
        if (S.view === 'stream' || (S.view === 'albums' && !S.albumKey) || (S.view === 'folders' && !S.folderPath)) {
          S.view = 'songs'; S.albumKey = null; S.folderPath = null;
          renderSidebar();
        }
        ensureMetaDeep(); // 后台分块补齐全库标签（metaCache 持久化，仅首次有成本）
      }
      // 防抖：打字过程中不整表重绘，150ms 静默后一次性渲染
      clearTimeout(S._schT);
      S._schT = setTimeout(renderView, 150);
    };
    sch.appendChild(inp); sb.appendChild(sch);
  }

  /* ---------------- 内容区 ---------------- */
  /* V4.3.22：视图头部共享构建器——标题 + 视图内搜索框 + 排序下拉（歌曲/专辑/喜爱歌曲共用）。
   * 搜索框匹配字段跟随当前排序方式（标题排序搜标题、演唱者排序搜演唱者……），
   * 查询串存 S.viewQuery[view]（会话级），输入 150ms 防抖重绘。 */
  var SONG_SORT_OPTS = [['az', '首字母 A–Z（标题）'], ['azArtist', '首字母 A–Z（演唱者）'], ['name', '文件名'],
    ['mtimeDesc', '修改时间 · 新→旧'], ['mtimeAsc', '修改时间 · 旧→新'], ['sizeDesc', '大小 · 大→小'], ['sizeAsc', '大小 · 小→大']];
  var ALBUM_SORT_OPTS = [['az', '名称 A–Z'], ['azArtist', '艺人 A–Z'], ['countDesc', '曲目数 · 多→少'], ['countAsc', '曲目数 · 少→多']];
  function viewQuery(view) { return (S.viewQuery && S.viewQuery[view]) || ''; }
  function buildViewHead(title, cfg) {
    var head = el('div', 'am-view-head');
    head.appendChild(el('div', 'am-view-h', title));
    if (cfg.search) {
      var inp = document.createElement('input');
      inp.className = 'am-view-search';
      inp.placeholder = cfg.search.placeholder;
      inp.value = viewQuery(cfg.view);
      inp.oninput = function () {
        S.viewQuery = S.viewQuery || {};
        S.viewQuery[cfg.view] = inp.value.trim();
        clearTimeout(S._vqT);
        S._vqT = setTimeout(function () {
          renderView();
          // 重绘会重建输入框——恢复焦点并把光标移到末尾，保证连续输入不中断
          var el2 = R.content && R.content.querySelector('.am-view-search');
          if (el2) { el2.focus(); try { el2.setSelectionRange(el2.value.length, el2.value.length); } catch (e) { } }
        }, 150);
      };
      head.appendChild(inp);
    }
    if (cfg.sort) {
      var sel = el('select', 'am-sort-sel');
      sel.title = '排序方式';
      cfg.sort.opts.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        sel.appendChild(op);
      });
      sel.value = cfg.sort.value;
      sel.onchange = function () {
        if (window.annieSettings) { annieSettings.ui[cfg.sort.key] = sel.value; annieSettings.save(); }
        renderView();
      };
      head.appendChild(sel);
    }
    return head;
  }
  /* 搜索框占位符：明示当前匹配字段（跟随排序方式） */
  function songSearchPh(mode) {
    var f = AM.songSearchField(mode);
    return f === 'artist' ? '搜索演唱者' : f === 'name' ? '搜索文件名' : '搜索标题';
  }

  function renderView() {
    if (!R.content || (window.annieTheme && annieTheme.current !== 'am')) return;
    var c = R.content;
    c.innerHTML = '';
    // V4.3.8：A–Z 索引栏挂在 .am-body 上（不随 content 清空），非歌曲视图需主动移除
    var oldAz = c.parentElement && c.parentElement.querySelector('.am-az');
    if (oldAz) oldAz.remove();
    S._az = null;
    // V4.1：视图切换动画只在「视图签名变化」时播放——切歌高亮/搜索输入/标签到达的重绘不闪
    var sig = S.view + '|' + (S.albumKey || '') + '|' + (S.folderPath || '');
    if (sig !== S._vswSig) {
      S._vswSig = sig;
      c.classList.remove('am-vsw'); void c.offsetWidth; c.classList.add('am-vsw');
      clearTimeout(S._vswT);
      S._vswT = setTimeout(function () { c.classList.remove('am-vsw'); }, 400);
    }

    // V4.3.22：多选模式只在 歌曲/专辑详情/喜爱歌曲 存活，切走即退出
    if (S.msOn && !(S.view === 'songs' || S.view === 'favorites' || (S.view === 'albums' && S.albumKey))) {
      S.msOn = false; if (S.msSel) S.msSel.clear();
    }

    if (S.view === 'stream') { renderStreamView(c); return; }
    if (S.view === 'downloads') { if (window.annieAMDownload) window.annieAMDownload.render(c); return; } // V4.3.22：下载情况
    if (S.view === 'qobuz') { if (AM.renderQobuzView) AM.renderQobuzView(c); return; } // V4.3.6：Qobuz 视图
    if (S.view.indexOf('spl:') === 0) { renderSplView(c); return; } // V4.3.5：在线歌单

    var tracks = currentTracks();

    if (S.view === 'albums' && !S.albumKey) { renderAlbumGrid(c); return; }
    if (S.view === 'folders' && !S.folderPath) { renderFolderRoots(c); return; }

    var folderKids = null;
    if (S.view === 'folders' && S.folderPath) {
      // V4.3.20：逐级浏览——返回上级 + 当前目录名 + 直接子文件夹行
      var fback = el('button', 'am-btn', '‹ 返回上级');
      fback.onclick = function () {
        var p = normP(S.folderPath).replace(/\\+$/, '');
        var isRoot = (S.libFolders || []).some(function (f) { return normP(f).replace(/\\+$/, '').toLowerCase() === p.toLowerCase(); });
        var parent = p.replace(/\\[^\\]+$/, '');
        S.folderPath = (isRoot || parent === p) ? null : parent;
        renderView();
      };
      c.appendChild(fback);
      c.appendChild(el('div', 'am-view-h', S.folderPath.split('\\').filter(Boolean).pop() || S.folderPath));
      folderKids = folderChildren(S.folderPath);
      folderKids.forEach(function (g) {
        var row = el('div', 'am-folder-row');
        row.appendChild(el('span', 'am-folder-ico', '📁'));
        row.appendChild(el('span', 'am-folder-name', g.name));
        row.appendChild(el('span', 'am-folder-sub', g.count + ' 首'));
        row.onclick = function () { S.folderPath = g.path; renderView(); };
        c.appendChild(row);
      });
    } else if (S.view === 'albums' && S.albumKey) {
      var back = el('button', 'am-btn', '‹ 专辑');
      back.onclick = function () { S.albumKey = null; renderView(); };
      c.appendChild(back);
      c.appendChild(el('div', 'am-view-h', S.albumKey));
    } else if (S.view.indexOf('pl:') === 0) {
      renderPlaylistHead(c);
    } else if (S.view === 'favorites') {
      // V4.3.22：喜爱歌曲头部——视图内搜索 + 排序下拉（同歌曲视图）
      c.appendChild(buildViewHead('喜爱歌曲', {
        view: 'favorites',
        search: { placeholder: songSearchPh(AM.favSortMode()) },
        sort: { opts: SONG_SORT_OPTS, value: AM.favSortMode(), key: 'amFavSort' }
      }));
    } else {
      // V4.3.15：歌曲视图标题行——右侧排序下拉（首字母/文件名/修改时间/大小）
      // V4.3.22：加视图内搜索框，匹配字段跟随排序方式
      c.appendChild(buildViewHead('歌曲', {
        view: 'songs',
        search: { placeholder: songSearchPh(AM.songSortMode()) },
        sort: { opts: SONG_SORT_OPTS, value: AM.songSortMode(), key: 'amSongSort' }
      }));
    }

    if (S.view === 'songs' && (!AM.songSortMode || AM.songSortMode() === 'az' || AM.songSortMode() === 'azArtist')) {
      ensureMetaDeep(); // 首字母排序依赖全库标签，闲时深加载（按块到达自动重排）；平铺排序不需要
    }

    if (!tracks.length) {
      // 文件夹层级页：只有子文件夹没有直属音频时不报「曲库为空」
      if (!(S.view === 'folders' && folderKids && folderKids.length)) {
        c.appendChild(el('div', 'am-empty',
          S.view === 'favorites' ? '还没有喜爱的歌曲' :
          S.view === 'folders' ? '此文件夹内没有音频文件' :
          S.view.indexOf('pl:') === 0 ? '播放列表是空的——在歌曲行上点 ⊕ 添加' : '曲库为空，请先在设置中添加音乐文件夹'));
      }
      return;
    }
    renderTrackTable(c, tracks);
    if (S.view === 'songs') renderAzBar(c, tracks); // V4.3.8：右侧 A–Z 索引栏
    ensureMeta(tracks.slice(0, 120));
  }

  /* V4.3.20：文件夹根列表——媒体库根目录（点入逐级深入；根外目录兜底平铺） */
  function renderFolderRoots(c) {
    c.appendChild(el('div', 'am-view-h', '文件夹'));
    var groups = folderRoots();
    if (!groups.length) {
      c.appendChild(el('div', 'am-empty', '曲库为空——点击侧栏"添加歌曲文件夹…"开始'));
      return;
    }
    groups.forEach(function (g) {
      var row = el('div', 'am-folder-row');
      row.appendChild(el('span', 'am-folder-ico', '📁'));
      row.appendChild(el('span', 'am-folder-name', g.name));
      row.appendChild(el('span', 'am-folder-sub', g.count + ' 首'));
      row.onclick = function () { S.folderPath = g.path; renderView(); };
      c.appendChild(row);
    });
  }

  function renderAlbumGrid(c) {
    // V4.3.22：专辑视图头部——视图内搜索 + 排序下拉（名称/艺人/曲目数）
    var amode = AM.albumSortMode ? AM.albumSortMode() : 'az';
    c.appendChild(buildViewHead('专辑', {
      view: 'albums',
      search: { placeholder: amode === 'azArtist' ? '搜索艺人' : '搜索专辑名' },
      sort: { opts: ALBUM_SORT_OPTS, value: amode, key: 'amAlbumSort' }
    }));
    var tracks = allTracks();
    ensureMeta(tracks.slice(0, 400)); // 专辑分组依赖标签，取回后自动重绘
    var byAlbum = {};
    tracks.forEach(function (t) {
      var m = trackMeta(t);
      var k = m.album || '未知专辑';
      if (!byAlbum[k]) byAlbum[k] = { name: k, artist: m.artist, tracks: [] };
      byAlbum[k].tracks.push(t);
    });
    // 视图内搜索：匹配字段跟随排序方式（艺人排序搜艺人，其余搜专辑名）
    var aq = viewQuery('albums').toLowerCase();
    if (aq) {
      Object.keys(byAlbum).forEach(function (k) {
        var a = byAlbum[k];
        var v = (amode === 'azArtist' ? (a.artist || '') : a.name).toLowerCase();
        if (v.indexOf(aq) < 0) delete byAlbum[k];
      });
    }
    // 排序：名称/艺人走拼音 collator，曲目数按数量
    var col = AM.azCollator ? AM.azCollator() : null;
    var keys = Object.keys(byAlbum).sort(function (x, y) {
      var a = byAlbum[x], b = byAlbum[y];
      if (amode === 'countDesc') return b.tracks.length - a.tracks.length;
      if (amode === 'countAsc') return a.tracks.length - b.tracks.length;
      var ka = amode === 'azArtist' ? (a.artist || '') : a.name;
      var kb = amode === 'azArtist' ? (b.artist || '') : b.name;
      var r = col ? col.compare(ka, kb) : ka.localeCompare(kb);
      return r !== 0 ? r : (col ? col.compare(a.name, b.name) : a.name.localeCompare(b.name));
    });
    var grid = el('div', 'am-album-grid');
    keys.forEach(function (k) {
      var a = byAlbum[k];
      var card = el('div', 'am-album-card');
      var img = el('img'); img.alt = ''; img.loading = 'lazy';
      albumCover(a.tracks[0], function (url) { if (url) img.src = url; }); // 与表格共享专辑级缓存
      card.appendChild(img);
      card.appendChild(el('div', 'am-album-name', a.name));
      card.appendChild(el('div', 'am-album-sub', a.artist + ' · ' + a.tracks.length + ' 首'));
      card.onclick = function () { S.albumKey = k; renderView(); };
      // V4.3.22：专辑右键——删除整个专辑（仅移出曲库 / 连同源文件，弹窗勾选确认）
      card.oncontextmenu = function (e) {
        e.preventDefault();
        var pop = R.pop;
        pop.innerHTML = '';
        pop.appendChild(el('div', 'am-pop-item', a.name)).style.fontWeight = '600';
        pop.appendChild(el('div', 'am-pop-sep'));
        var md = el('button', 'am-pop-item', '🗑 删除该专辑（' + a.tracks.length + ' 首）…');
        md.onclick = function () { pop.classList.remove('on'); deleteTracks(a.tracks.map(function (t) { return t.path; })); };
        pop.appendChild(md);
        pop.classList.add('on');
        var w = pop.offsetWidth, h = pop.offsetHeight;
        pop.style.left = Math.min(e.clientX, window.innerWidth - w - 12) + 'px';
        pop.style.top = Math.min(e.clientY, window.innerHeight - h - 12) + 'px';
      };
      grid.appendChild(card);
    });
    c.appendChild(grid);
  }

  function renderPlaylistHead(c) {
    var pl = S.playlists.find(function (p) { return p.id === S.view.slice(3); });
    if (!pl) { S.view = 'songs'; renderView(); return; }
    var head = el('div', 'am-pl-head');
    var tracks = currentTracks();
    if (tracks.length) {
      var img = el('img', 'am-pl-cover'); img.alt = '';
      albumCover(tracks[0], function (url) { if (url) img.src = url; });
      head.appendChild(img);
    } else {
      head.appendChild(el('div', 'am-pl-cover-ph', '🎧'));
    }
    var info = el('div', 'am-pl-info');
    var name = el('div', 'am-pl-name', pl.name);
    name.contentEditable = 'true'; name.spellcheck = false;
    name.onblur = function () {
      var n = name.textContent.trim();
      if (n && n !== pl.name) window.mine.playlistRename(pl.id, n).then(function (pls) { S.playlists = pls; renderSidebar(); });
    };
    name.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } };
    info.appendChild(name);
    info.appendChild(el('div', 'am-pl-meta', pl.paths.length + ' 首歌曲'));
    var acts = el('div', 'am-pl-actions');
    var bPlay = el('button', 'am-btn am-btn-accent', '▶ 播放');
    bPlay.onclick = function () { if (tracks.length) playList(tracks, 0); };
    var bShuffle = el('button', 'am-btn', '🔀 随机播放');
    bShuffle.onclick = function () {
      if (!tracks.length) return;
      playList(tracks, Math.floor(Math.random() * tracks.length));
    };
    acts.appendChild(bPlay); acts.appendChild(bShuffle);
    info.appendChild(acts);
    head.appendChild(info);
    c.appendChild(head);
  }

  /* 本地曲目表：封面按专辑共享（每张专辑只解析一个文件的封面，行内复用同一 dataURL，解码一次）；
     V4.1：移除 2000 行封面硬顶——窗口化渲染已把同时在屏的 <img> 限制在可视区 ±15 行，
     叠加专辑级缓存 + 并发限流 3 的 lazy 队列，超大曲库封面列也流畅。
     V3.1：>300 行窗口化渲染——只构建可视区 ±15 行，上下用占位行撑高度，滚动 rAF 合并。 */
  var AM_ROW_H_COVER = 52, AM_ROW_H_PLAIN = 41, AM_WINDOW_MIN = 300, AM_OVERSCAN = 15;
  function buildTrackRow(t, i, opts) {
    var m = trackMeta(t);
    var selected = S.msOn && S.msSel && S.msSel.has(t.path);
    var tr = el('tr', 'am-tr' + (state.currentPath === t.path && !S.msOn ? ' cur' : '') + (selected ? ' sel' : ''));
    tr.dataset.path = t.path; // 定位播放文件用
    if (S.msOn) { // V4.3.22：多选模式——行首复选框，点击行=切换选中（不播放）
      var tdCk = el('td');
      var ck = document.createElement('input');
      ck.type = 'checkbox'; ck.checked = !!selected; ck.className = 'am-ms-ck';
      ck.onclick = function (e) { e.stopPropagation(); msToggle(t.path, tr, ck); };
      tdCk.appendChild(ck); tr.appendChild(tdCk);
    }
    if (opts.withCover) {
      var tdCover = el('td');
      var img = el('img', 'am-c-cover'); img.alt = ''; img.loading = 'lazy'; img.draggable = false;
      img.style.visibility = 'hidden';
      albumCover(t, function (url) { if (url) { img.src = url; img.style.visibility = ''; } });
      tdCover.appendChild(img); tr.appendChild(tdCover);
    }
    tr.appendChild(el('td', 'am-c-title', esc(m.title)));
    tr.appendChild(el('td', 'am-c-dim', esc(m.artist)));
    tr.appendChild(el('td', 'am-c-dim', esc(m.album)));
    var acts = el('td', 'am-c-acts');
    var bFav = el('button', 'am-mini-btn' + (state.favorites && state.favorites.has(t.path) ? ' faved' : ''), '♥');
    bFav.title = '喜爱';
    bFav.onclick = function (e) {
      e.stopPropagation();
      window.mine.toggleFavorite(t.path).then(function (favs) {
        state.favorites = new Set(favs);
        bFav.classList.toggle('faved', state.favorites.has(t.path));
        if (S.view === 'favorites') renderView();
      });
    };
    var bAdd = el('button', 'am-mini-btn', '⊕');
    bAdd.title = '添加到播放列表';
    bAdd.onclick = function (e) { e.stopPropagation(); openAddMenu(e.clientX, e.clientY, t.path); };
    acts.appendChild(bFav); acts.appendChild(bAdd);
    if (opts.inPlaylist) {
      var bRm = el('button', 'am-mini-btn', '✕');
      bRm.title = '从播放列表移除';
      bRm.onclick = function (e) {
        e.stopPropagation();
        window.mine.playlistRemove(opts.plId, t.path).then(function (pls) { S.playlists = pls; renderSidebar(); renderView(); });
      };
      acts.appendChild(bRm);
    }
    tr.appendChild(acts);
    // V4.3.22：播放列表内拖拽排序（与迷你待播清单同一交互：拖到目标行放下即插入该行前）
    if (opts.inPlaylist && !S.msOn) {
      tr.draggable = true;
      tr.title = '拖拽调整顺序';
      tr.addEventListener('dragstart', function (e) {
        S._plDragPath = t.path;
        try { e.dataTransfer.effectAllowed = 'move'; } catch (er) { }
      });
      tr.addEventListener('dragover', function (e) { e.preventDefault(); tr.classList.add('drag-over'); });
      tr.addEventListener('dragleave', function () { tr.classList.remove('drag-over'); });
      tr.addEventListener('drop', function (e) {
        e.preventDefault(); tr.classList.remove('drag-over');
        var from = S._plDragPath; S._plDragPath = null;
        if (from && from !== t.path) movePlRow(opts.plId, from, t.path);
      });
      tr.addEventListener('dragend', function () { S._plDragPath = null; tr.classList.remove('drag-over'); });
    }
    if (S.msOn) {
      tr.onclick = function () { msToggle(t.path, tr, tr.querySelector('.am-ms-ck')); };
    } else {
      tr.ondblclick = function () { playList(opts.tracks, i); };
      // V4.3.21：行右键 = ⊕ 菜单（同一入口，坐标取鼠标位置）
      tr.oncontextmenu = function (e) { e.preventDefault(); openAddMenu(e.clientX, e.clientY, t.path); };
    }
    return tr;
  }

  /* ---------- V4.3.22：本地曲库多选 + 删除（歌曲/专辑详情/喜爱歌曲） ---------- */
  /* 播放列表拖拽排序：from 插到 to 行之前（按路径定位——窗口化行索引在 paths 有缺口时会错位） */
  function movePlRow(plId, fromPath, toPath) {
    var pl = S.playlists.find(function (p) { return p.id === plId; });
    if (!pl) return;
    var arr = pl.paths;
    var fi = arr.indexOf(fromPath), ti = arr.indexOf(toPath);
    if (fi < 0 || ti < 0) return;
    arr.splice(fi, 1);
    arr.splice(arr.indexOf(toPath), 0, fromPath); // 删除后目标索引自动前移，插到它前面=占据原视觉位
    renderView(); // 本地先重排即时反馈，持久化随后
    window.mine.playlistReorder(plId, arr).then(function (pls) { S.playlists = pls; }).catch(function () { });
  }
  function msToggle(p, tr, ck) {
    if (!S.msSel) S.msSel = new Set();
    if (S.msSel.has(p)) { S.msSel.delete(p); tr.classList.remove('sel'); if (ck) ck.checked = false; }
    else { S.msSel.add(p); tr.classList.add('sel'); if (ck) ck.checked = true; }
    var cnt = document.querySelector('.am-ms-count');
    if (cnt) cnt.textContent = '已选 ' + S.msSel.size + ' 首';
  }
  function msExit() { S.msOn = false; if (S.msSel) S.msSel.clear(); renderView(); }
  function renderMsToolbar(c, tracks) {
    var bar = el('div', 'am-ms-bar');
    var bAll = el('button', 'am-btn', (S.msSel && S.msSel.size >= tracks.length && tracks.length) ? '☐ 取消全选' : '☑ 全选');
    bAll.onclick = function () {
      if (!S.msSel) S.msSel = new Set();
      if (S.msSel.size >= tracks.length) S.msSel.clear();
      else tracks.forEach(function (t) { S.msSel.add(t.path); });
      renderView();
    };
    bar.appendChild(bAll);
    var bDel = el('button', 'am-btn am-btn-danger', '🗑 删除选中');
    bDel.onclick = function () {
      if (!S.msSel || !S.msSel.size) { try { proToast('先勾选要删除的歌曲'); } catch (e) { } return; }
      deleteTracks(Array.from(S.msSel));
    };
    bar.appendChild(bDel);
    var bExit = el('button', 'am-btn', '✕ 退出多选');
    bExit.onclick = msExit;
    bar.appendChild(bExit);
    bar.appendChild(el('span', 'am-ms-count', '已选 ' + (S.msSel ? S.msSel.size : 0) + ' 首'));
    c.appendChild(bar);
  }
  /* 删除确认：默认仅移出曲库显示；勾选后连同源文件（系统回收站，可恢复） */
  function amConfirmDel(count, cb) {
    var ov = el('div', 'am-prompt-ov');
    var box = el('div', 'am-prompt');
    box.appendChild(el('div', 'am-pop-h', '删除 ' + count + ' 首歌曲'));
    box.appendChild(el('div', 'am-pop-hint', '默认仅从曲库移除显示，磁盘文件不受影响。'));
    var lab = el('label', 'am-del-opt');
    var ck = document.createElement('input'); ck.type = 'checkbox';
    lab.appendChild(ck);
    lab.appendChild(el('span', '', '同时删除源文件（移入系统回收站，可恢复）'));
    box.appendChild(lab);
    var row = el('div', 'am-prompt-btns');
    var bNo = el('button', 'am-btn', '取消');
    var bOk = el('button', 'am-btn am-btn-danger', '删除');
    function close(v) { ov.remove(); if (v != null) cb(v); }
    bNo.onclick = function () { close(null); };
    bOk.onclick = function () { close(ck.checked); };
    ov.onclick = function (e) { if (e.target === ov) close(null); };
    row.appendChild(bNo); row.appendChild(bOk);
    box.appendChild(row); ov.appendChild(box);
    document.body.appendChild(ov);
  }
  function deleteTracks(paths) {
    if (!paths || !paths.length) return;
    amConfirmDel(paths.length, function (delFile) {
      var done = function (pls, msg) {
        if (pls) S.playlists = pls;
        S.msOn = false; if (S.msSel) S.msSel.clear();
        renderSidebar(); renderView();
        try { proToast(msg); } catch (e) { }
      };
      if (delFile) {
        window.mine.libDeleteFiles(paths).then(function (r) {
          var n = r && r.done ? r.done.length : 0, f = r && r.failed ? r.failed.length : 0;
          done(r && r.playlists, '已删除 ' + n + ' 首（源文件已入回收站）' + (f ? '，' + f + ' 个失败' : ''));
        }).catch(function () { });
      } else {
        window.mine.tracksHide(paths).then(function (r) {
          done(r && r.playlists, '已移出曲库 ' + (r ? r.removed : paths.length) + ' 首（源文件保留）');
        }).catch(function () { });
      }
    });
  }
  function amSpacerRow(h, cols) {
    var tr = el('tr');
    var td = el('td');
    td.colSpan = cols;
    td.style.cssText = 'height:' + h + 'px;padding:0;border:0';
    tr.appendChild(td);
    return tr;
  }
  function renderTrackTable(c, tracks) {
    var tb = el('table', 'am-table');
    var inPlaylist = S.view.indexOf('pl:') === 0;
    var opts = {
      withCover: true, // V4.1：封面列全量开启（窗口化 + 专辑共享缓存兜底）
      inPlaylist: inPlaylist,
      plId: inPlaylist ? S.view.slice(3) : null,
      tracks: tracks
    };
    if (S.msOn) renderMsToolbar(c, tracks); // V4.3.22：多选工具条（全选/删除选中/退出）
    tb.innerHTML = '<thead><tr>' + (S.msOn ? '<th style="width:34px"></th>' : '') + (opts.withCover ? '<th style="width:46px"></th>' : '') +
      '<th>歌曲</th><th>艺人</th><th>专辑</th><th style="width:96px"></th></tr></thead>';
    var body = el('tbody');
    tb.appendChild(body);
    c.appendChild(tb);

    if (tracks.length <= AM_WINDOW_MIN) {
      S._tbl = null;
      tracks.forEach(function (t, i) { body.appendChild(buildTrackRow(t, i, opts)); });
      return;
    }
    // 窗口化：可视区 ±15 行
    var rowH = opts.withCover ? AM_ROW_H_COVER : AM_ROW_H_PLAIN;
    var cols = (opts.withCover ? 5 : 4) + (S.msOn ? 1 : 0);
    var win = { tracks: tracks, opts: opts, body: body, tb: tb, rowH: rowH, cols: cols, lastStart: -1, lastEnd: -1 };
    S._tbl = win;
    renderAmWindow();
  }
  function renderAmWindow() {
    var win = S._tbl, c = R.content;
    if (!win || !c || !win.body.isConnected) { return; }
    var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
    var base = win.tb.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop + headH;
    var st = c.scrollTop, h = c.clientHeight;
    var start = Math.max(0, Math.floor((st - base) / win.rowH) - AM_OVERSCAN);
    var end = Math.min(win.tracks.length, Math.ceil((st + h - base) / win.rowH) + AM_OVERSCAN);
    if (start === win.lastStart && end === win.lastEnd) return;
    win.lastStart = start; win.lastEnd = end;
    var frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(amSpacerRow(start * win.rowH, win.cols));
    for (var i = start; i < end; i++) frag.appendChild(buildTrackRow(win.tracks[i], i, win.opts));
    if (end < win.tracks.length) frag.appendChild(amSpacerRow((win.tracks.length - end) * win.rowH, win.cols));
    win.body.innerHTML = '';
    win.body.appendChild(frag);
    azSyncActive(win, start); // V4.3.8：滚动联动索引栏当前字母
  }

  /* ---------- V4.3.8：A–Z 索引栏（仅全曲库「歌曲」视图，配合 am.js 首字母排序） ---------- */
  function renderAzBar(c, tracks) {
    var cache = S._azCache;
    if (!cache || cache.out !== tracks) return; // 非首字母排序结果（理论不发生）不出栏
    var firstIdx = cache.firstIdx;
    var bar = el('div', 'am-az');
    var present = [];
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('').forEach(function (L) {
      var has = firstIdx[L] !== undefined;
      if (has) present.push(L);
      var s = el('span', 'am-az-l' + (has ? '' : ' off'), L);
      if (has) {
        s.dataset.letter = L;
        s.onclick = function () { azJump(L); };
      }
      bar.appendChild(s);
    });
    S._az = { bar: bar, firstIdx: firstIdx, present: present, cur: '' };
    // 挂 .am-body（content 是滚动容器，索引栏需悬浮且不随 innerHTML 清空）
    (c.parentElement || c).appendChild(bar);
  }
  function azJump(L) {
    var az = S._az;
    if (!az) return;
    var idx = az.firstIdx[L];
    if (idx === undefined) return;
    var c = R.content, win = S._tbl;
    if (win && win.body.isConnected) {
      // 窗口化：与 scrollRowIntoView 同一套 base 换算；
      // 再多回退「表头 + 一行 + 6px」，否则字母组首行会被 sticky 表头（歌曲/艺人/专辑）盖住
      var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
      var base = win.tb.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop + headH;
      c.scrollTo({ top: base + idx * win.rowH - headH - win.rowH - 6, behavior: 'smooth' });
    } else {
      var rows = c.querySelectorAll('tr.am-tr');
      var row = rows[idx];
      if (row) {
        // V4.3.11 修复：不能用 scrollIntoView——它会连 #am-root（fixed 壳）一起滚，把顶栏顶出视口
        //（用户实锤：点字母索引后顶部播放栏消失）。与窗口化路径同算法手动滚容器，
        // 并回退「表头 + 一行 + 6px」防 sticky 表头遮挡。
        var thead = c.querySelector('thead');
        var headH2 = thead ? thead.offsetHeight : 0;
        var cRect = c.getBoundingClientRect();
        var top = row.getBoundingClientRect().top - cRect.top + c.scrollTop - headH2 - row.offsetHeight - 6;
        c.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
  }
  /* 滚动时按首个可见行反推当前字母并高亮（仅窗口化路径调用，小列表无感） */
  function azSyncActive(win, start) {
    var az = S._az;
    if (!az || !az.bar.isConnected) return;
    var cur = az.present[0] || '';
    for (var i = 0; i < az.present.length; i++) {
      if (az.firstIdx[az.present[i]] <= start) cur = az.present[i]; else break;
    }
    if (cur === az.cur) return;
    az.cur = cur;
    var kids = az.bar.children;
    for (var k = 0; k < kids.length; k++) kids[k].classList.toggle('cur', kids[k].dataset.letter === cur);
  }

  /* V4.1：应用内输入对话框——Electron 不支持原生 window.prompt()（静默无反应），
   * 全局挂 window.anniePrompt(title, 默认值, cb) 供所有主题/设置面板使用。 */
  function amPrompt(title, defVal, cb) {
    var ov = el('div', 'am-prompt-ov');
    var box = el('div', 'am-prompt');
    box.appendChild(el('div', 'am-pop-h', title));
    var inp = document.createElement('input');
    inp.className = 'am-prompt-in';
    inp.value = defVal || '';
    box.appendChild(inp);
    var row = el('div', 'am-prompt-btns');
    var bNo = el('button', 'am-btn', '取消');
    var bOk = el('button', 'am-btn am-btn-accent', '确定');
    function close(v) { ov.remove(); if (v != null) cb(v); }
    bNo.onclick = function () { close(null); };
    bOk.onclick = function () { var v = inp.value.trim(); if (v) close(v); else inp.focus(); };
    inp.onkeydown = function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') bOk.onclick();
      else if (e.key === 'Escape') close(null);
    };
    ov.onclick = function (e) { if (e.target === ov) close(null); };
    row.appendChild(bNo); row.appendChild(bOk);
    box.appendChild(row); ov.appendChild(box);
    document.body.appendChild(ov); // 挂 body：设置面板/其他主题同样可用（CSS 变量带兜底值）
    inp.focus(); inp.select();
  }
  window.anniePrompt = amPrompt;

  /* "添加到播放列表"菜单 */
  function openAddMenu(x, y, trackPath) {
    var pop = R.pop;
    pop.innerHTML = '';
    pop.appendChild(el('div', 'am-pop-item', '添加到播放列表')).style.fontWeight = '600';
    pop.appendChild(el('div', 'am-pop-sep'));
    var mte = el('button', 'am-pop-item', '✏️ 编辑标签…');
    mte.onclick = function () {
      pop.classList.remove('on');
      if (window.annieTagEdit) window.annieTagEdit.open({ path: trackPath });
    };
    pop.appendChild(mte);
    var mch = el('button', 'am-pop-item', '🔎 在线匹配歌词 / 封面…');
    mch.onclick = function () {
      pop.classList.remove('on');
      if (window.annieMatch) window.annieMatch.open({ path: trackPath });
    };
    pop.appendChild(mch);
    // V4.3.22：查看所在专辑——跳到专辑视图并打开该曲所属专辑
    var mal = el('button', 'am-pop-item', '💿 查看所在专辑');
    mal.onclick = function () {
      pop.classList.remove('on');
      var t = null;
      allTracks().forEach(function (x) { if (x.path === trackPath) t = x; });
      if (!t) return;
      S.view = 'albums'; S.albumKey = trackMeta(t).album || '未知专辑'; S.folderPath = null;
      renderSidebar(); renderView();
    };
    pop.appendChild(mal);
    // V4.3.16：相似歌曲推荐（零云端本地打分）
    var msr = el('button', 'am-pop-item', '✨ 找相似歌曲…');
    msr.onclick = function () {
      pop.classList.remove('on');
      if (window.annieSimilar) window.annieSimilar.open(trackPath);
    };
    pop.appendChild(msr);
    // V4.3.21：一键电台（种子 + 相似链式续播）
    var mrd = el('button', 'am-pop-item',
      (window.annieSimilar && annieSimilar.radio.isOn()) ? '📻 关闭电台' : '📻 一键电台');
    mrd.onclick = function () {
      pop.classList.remove('on');
      if (!window.annieSimilar) return;
      if (annieSimilar.radio.isOn()) {
        annieSimilar.radio.stop();
        try { if (typeof proToast === 'function') proToast('📻 电台已关闭'); } catch (e) { }
      } else annieSimilar.radio.start(trackPath);
    };
    pop.appendChild(mrd);
    // V4.3.22：多选（歌曲/专辑详情/喜爱歌曲视图）——进入多选模式并选中本行
    if (S.view === 'songs' || S.view === 'favorites' || (S.view === 'albums' && S.albumKey)) {
      var mms = el('button', 'am-pop-item', '☑ 多选');
      mms.onclick = function () { pop.classList.remove('on'); S.msOn = true; S.msSel = new Set([trackPath]); renderView(); };
      pop.appendChild(mms);
    }
    // V4.3.22：删除——弹窗勾选：仅移出曲库显示 / 连同源文件入回收站
    var mdel = el('button', 'am-pop-item', '🗑 删除…');
    mdel.onclick = function () { pop.classList.remove('on'); deleteTracks([trackPath]); };
    pop.appendChild(mdel);
    // V4.3.19：歌词海报（仅当前播放且有歌词的行；竖版 1080×1620，含封面/音质/节选歌词/版本号）
    try {
      var isCurTrack = (typeof state !== 'undefined' && state && state.currentPath === trackPath);
      if (isCurTrack && S.lyrLines && S.lyrLines.length) {
        var mpp = el('button', 'am-pop-item', '🖼 生成歌词海报');
        mpp.onclick = function () {
          pop.classList.remove('on');
          if (window.anniePoster) window.anniePoster.open(trackPath);
        };
        pop.appendChild(mpp);
      }
    } catch (e) { }
    pop.appendChild(el('div', 'am-pop-sep'));
    S.playlists.forEach(function (pl) {
      var it = el('button', 'am-pop-item', pl.name);
      it.onclick = function () {
        pop.classList.remove('on');
        window.mine.playlistAdd(pl.id, [trackPath]).then(function (pls) {
          S.playlists = pls;
          if (S.view === 'pl:' + pl.id) renderView();
        });
      };
      pop.appendChild(it);
    });
    if (S.playlists.length) pop.appendChild(el('div', 'am-pop-sep'));
    var nw = el('button', 'am-pop-item', '＋ 新建播放列表…');
    nw.onclick = function () {
      pop.classList.remove('on');
      amPrompt('播放列表名称', '新建播放列表', function (name) {
        window.mine.playlistCreate(name).then(function (pls) {
          S.playlists = pls;
          return window.mine.playlistAdd(pls[pls.length - 1].id, [trackPath]);
        }).then(function (pls) { S.playlists = pls; renderSidebar(); });
      });
    };
    pop.appendChild(nw);
    pop.classList.add('on');
    var w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - h - 12) + 'px';
  }

  /* 滚动到指定曲目行并闪烁高亮（窗口化时先按索引滚再重建可视区）。
   * opts.auto：自动定位模式——行已在可视区内则不打扰（手动双击播放等场景）。 */
  function scrollRowIntoView(p, opts) {
    opts = opts || {};
    setTimeout(function () {
      if (!R.content) return;
      var sel = '.am-tr[data-path="' + CSS.escape(p) + '"]';
      var row = R.content.querySelector(sel);
      if (!row && S._tbl) {
        // 窗口化渲染：目标行不在 DOM，按索引算 scrollTop 滚过去再重建可视区
        var win = S._tbl, idx = -1;
        for (var k = 0; k < win.tracks.length; k++) if (win.tracks[k].path === p) { idx = k; break; }
        if (idx < 0) return;
        var headH = win.tb.tHead ? win.tb.tHead.offsetHeight : 0;
        var base = win.tb.getBoundingClientRect().top - R.content.getBoundingClientRect().top + R.content.scrollTop + headH;
        R.content.scrollTop = Math.max(0, base + idx * win.rowH - (R.content.clientHeight - win.rowH) / 2);
        renderAmWindow();
        row = R.content.querySelector(sel);
      } else if (row) {
        // 非窗口化：手动滚容器——不能用 scrollIntoView，它会连 #am-root（fixed 壳）一起滚，把顶栏顶出视口
        var cRect = R.content.getBoundingClientRect();
        var rRect = row.getBoundingClientRect();
        var visible = rRect.top >= cRect.top && rRect.bottom <= cRect.bottom;
        if (visible && opts.auto) return; // 已在可视区：自动定位不打扰
        if (!visible) {
          var target = R.content.scrollTop + (rRect.top - cRect.top) - (cRect.height - rRect.height) / 2;
          if (R.content.scrollTo) R.content.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
          else R.content.scrollTop = Math.max(0, target);
        }
      }
      if (!row) return;
      var root = document.getElementById('am-root');
      if (root && root.scrollTop) root.scrollTop = 0; // 防御：壳容器永不允许滚动
      if (opts.flash === false) return;
      row.classList.remove('locate-flash');
      void row.offsetWidth; // 重启动画
      row.classList.add('locate-flash');
      setTimeout(function () { row.classList.remove('locate-flash'); }, 2000);
    }, 60);
  }

  /* 定位当前播放文件：当前视图找不到时切回歌曲全库，滚动到播放行并闪烁高亮 */
  function locatePlaying() {
    var p = state.currentPath;
    // V4.3.13：流媒体/在线歌单也能定位——回到来源视图滚动高亮当前行
    if (state.currentStream) { if (AM.locateStream) AM.locateStream(); return; }
    if (!p) return;
    var inView = currentTracks().some(function (t) { return t.path === p; });
    if (!inView) {
      S.view = 'songs'; S.albumKey = null; S.folderPath = null; S.search = '';
      renderSidebar();
    }
    renderView();
    scrollRowIntoView(p, { auto: false });
  }


  /* 注册到模块桥（供其他分片取用） */
  AM.build = build;
  AM.renderSidebar = renderSidebar;
  AM.renderView = renderView;
  AM.renderAmWindow = renderAmWindow;
  AM.scrollRowIntoView = scrollRowIntoView;
})();
