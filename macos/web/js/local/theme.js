'use strict';
/* 界面主题管理器：粒子舞台(legacy) ↔ 仿 foobar2000(fb2k) ↔ Apple Music(am) 一键切换。
 * 「两个世界」仪式感版（V4.4）：切换 = 全屏过渡动画（复用启动屏 logo + 离开/进入文案）
 *   + 渐出停止播放（听歌统计记为正常会话结束，非 skip）+ 非当前主题彻底冻结
 *   （DOM 休眠不渲染、渲染循环/频谱/歌词经 annieTheme.current 守卫停摆——架构级
 *   「只运行一个界面」，不做物理卸载重建：三主题共享全局 state、全局监听模块加载即绑，
 *   物理卸载需重写三模块生命周期、风险高且收益存疑，详见 CODEBASE-NOTES.md）。
 * 停止但可恢复：切换前快照播放现场（path/stream/position/queue/index），新界面顶部
 *   出「⏵ 续播」提示条，点它从断点重建播放（本地 playAt+seek / 流媒体重取 URL）。
 * 主题存 localStorage（key: annieplayer.theme）。预留扩展：VALID 数组追加即可。 */
(function () {
  var KEY = 'annieplayer.theme';
  var VALID = ['legacy', 'fb2k', 'am'];
  var THEME_NAME = { legacy: '粒子舞台', fb2k: 'FB2K', am: 'AM' };
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { }
  var current = VALID.indexOf(stored) >= 0 ? stored : 'am';
  var switching = false;
  var switchStartedAt = 0;
  var switchWatchdog = 0;

  /* ---------- 播放现场快照（停止但可恢复） ---------- */
  var snapshot = null; // {isStream, path, stream, position, queue, index, title, artist}
  function takeSnapshot() {
    var st = window.state;
    // V4.4：暂停中也要快照——旧条件要求 st.playing，暂停切主题时引擎被 stop 但无快照，
    // 续播条不出、断点永久丢失（与本文件「无论是否播放中，记录现场供恢复」的设计矛盾）
    if (!st || !st.currentPath) { snapshot = null; return; }
    // 自然播完（停在末尾且非播放中）不弹续播条——续播一首已结束的歌没有意义
    if (!st.playing && st.duration > 0 && (st.position || 0) >= st.duration - 1.5) { snapshot = null; return; }
    var isStream = !!st.currentStream;
    var title = '', artist = '';
    if (isStream && st.currentStream) { title = st.currentStream.title || ''; artist = st.currentStream.artist || ''; }
    else {
      var tr = (st.library && st.library.tracks || []).find(function (t) { return t.path === st.currentPath; });
      // V4.4：tracks 元素无 meta 字段（元数据在 library.metaCache[path]）——旧实现恒显示带扩展名的文件名
      var mc = st.library && st.library.metaCache && st.library.metaCache[st.currentPath];
      title = (mc && mc.title) || (tr && tr.meta && tr.meta.title) || (tr && tr.name) || '';
      artist = (mc && mc.artist) || (tr && tr.meta && tr.meta.artist) || '';
    }
    snapshot = {
      isStream: isStream,
      path: st.currentPath,
      stream: st.currentStream || null,
      position: st.position || 0,
      queue: (st.queue || []).slice(),
      index: st.index,
      title: title, artist: artist
    };
  }

  /* ---------- 渐出停止播放（听歌统计记正常结束） ---------- */
  function stopPlayback(done) {
    var st = window.state;
    if (!st || !st.currentPath) { done(); return; }
    // 听歌统计：定性当前会话（按实际收听比例归 完整/部分/跳过，非一律 skip）
    try { if (window.annieListenStats) window.annieListenStats.endSession(); } catch (e) { }
    // 暂停中：无需渐出（已无声），直接 stop
    if (!st.playing) { try { window.mine.engine('stop'); } catch (e) { } done(); return; }
    // 播放中：音量渐出 700ms 再 stop（比硬切柔和；渐出的是引擎增益，不动主音量推子值）
    var vol0 = (st.library && typeof st.library.volume === 'number') ? st.library.volume : 0.8;
    var steps = 14, i = 0;
    // ⚠️ 兜底（2026-10-21）：渐出循环可能被卡住（engine 调用是 Promise，
    //    主线程忙时 setTimeout 会被推迟）。加 1.5 秒超时强制走完。
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      clearInterval(t);
      try { window.mine.engine('stop'); } catch (e) { }
      setTimeout(function () {
        try { window.mine.engine('volume.set', { gain: vol0 }); } catch (e) { }
        done();
      }, 60);
    };
    var guard = setTimeout(finish, 1500);
    var t = setInterval(function () {
      if (finished) return;
      i++;
      var g = vol0 * (1 - i / steps);
      try { window.mine.engine('volume.set', { gain: Math.max(0, g) }); } catch (e) { }
      if (i >= steps) {
        clearTimeout(guard);
        finish();
      }
    }, 50);
  }

  /* ---------- 续播提示条（手动恢复） ---------- */
  var lastFromTheme = ''; // 切换来源主题（续播文案用「从 XX 切来」）
  function resumeBar() { return document.getElementById('theme-resume'); }
  function hideResume() { var b = resumeBar(); if (b) b.classList.remove('tr-on'); }
  function showResume() {
    if (!snapshot || !snapshot.path) return;
    // ⚠️ 2026-10-24（用户要求）：切换模式后，点播放 / 按空格 应直接断点续播
    //   （不用先点顶部「⏵ 续播」条）。把恢复入口暴露到全局。
    window.__annieResumePending = true;
    var bar = resumeBar(), txt = document.getElementById('theme-resume-txt');
    if (!bar || !txt) return;
    var label = snapshot.title || snapshot.path.split(/[\\/]/).pop();
    txt.innerHTML = '已从 <b>' + escapeHtml(THEME_NAME[lastFromTheme] || lastFromTheme) + '</b> 切来 · 《' + escapeHtml(label) + '》' + (snapshot.artist ? ' · ' + escapeHtml(snapshot.artist) : '') + '（' + fmtPos(snapshot.position) + ' 处断点）';
    bar.classList.add('tr-on');
  }
  function fmtPos(s) { s = Math.max(0, Math.round(s || 0)); var m = Math.floor(s / 60), ss = s % 60; return m + ':' + (ss < 10 ? '0' : '') + ss; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function doResume() {
    window.__annieResumePending = false;
    if (!snapshot || !snapshot.path) { hideResume(); return; }
    var snap = snapshot; hideResume();
    var st = window.state;
    if (!st) return;
    if (snap.isStream && snap.stream) {
      // 流媒体：重取 URL 播放（URL 有时效），再 seek 回断点
      var song = snap.stream.song || snap.stream;
      // 音质用快照里的（切走时所选档），回退 128k（streaming.js 的 currentQuality 是 IIFE 局部，拿不到）
      var qual = snap.stream.quality || '128k';
      if (window.mine.streamSongUrl && song && song.provider) {
        window.mine.streamSongUrl({ provider: song.provider, quality: qual, song: song }).then(function (r) {
          if (!r || !r.playable || !r.url) return;
          return window.annieStreamPlay({
            url: r.url, headers: r.headers || null,
            title: snap.stream.title, artist: snap.stream.artist, album: snap.stream.album || '',
            cover: snap.stream.cover || '', duration: snap.stream.duration || 0,
            provider: song.provider, quality: r.quality || '', song: song
          }).then(function () {
            if (snap.position > 1) setTimeout(function () { try { window.mine.engine('seek', { seconds: snap.position }); } catch (e) { } }, 400);
          });
        }).catch(function () { });
      }
    } else {
      // 本地：恢复队列 + playAt(index) + seek 回断点
      try {
        if (snap.queue && snap.queue.length) st.queue = snap.queue;
        var idx = snap.index >= 0 ? snap.index : 0;
        if (typeof window.playAt === 'function') {
          window.playAt(idx);
          if (snap.position > 1) setTimeout(function () { try { window.mine.engine('seek', { seconds: snap.position }); } catch (e) { } }, 500);
        }
      } catch (e) { }
    }
    snapshot = null;
  }

  /* ---------- 主题激活/冻结 ---------- */
  function apply(theme) {
    current = theme;
    document.documentElement.dataset.theme = theme;
    // 通知粒子主循环跳过重负载渲染（11-main-loop.js 检查此标志）
    window.__legacyThemeHidden = theme !== 'legacy';
    var root = document.getElementById('fb2k-root');
    if (root) root.setAttribute('aria-hidden', theme === 'fb2k' ? 'false' : 'true');
    if (theme === 'fb2k' && window.annieFb2k) window.annieFb2k.mount();
    var amRoot = document.getElementById('am-root');
    if (amRoot) amRoot.setAttribute('aria-hidden', theme === 'am' ? 'false' : 'true');
    if (theme === 'am' && window.annieAM) window.annieAM.mount();
    document.dispatchEvent(new CustomEvent('annie-theme-changed', { detail: { theme: theme } }));
  }

  /* ---------- 切换主流程：快照 → 渐出停 → 过渡动画 → 激活新 → 续播提示 ---------- */
  var splash = function () { return document.getElementById('theme-splash'); };
  var splashStatus = function () { return document.getElementById('theme-splash-status'); };
  var MIN_SHOW = 900; // 仪式感下限：logo 动画至少呈现一轮
  var FADE_OUT = 500; // 与 CSS transition opacity .5s 一致

  function doSwitch(theme) {
    try { console.log('[theme] doSwitch(' + theme + ') switching=' + switching); } catch(e) {}
    if (switching) { try{console.log('[theme] 正在切换中，丢弃');}catch(e){} return; }
    switching = true;
    switchStartedAt = Date.now();
    // ⚠️ 看门狗（2026-10-21）：如果 8 秒后 switching 还是 true，强制复位，
    //    防止任何一步卡死导致主题永久锁死。
    clearTimeout(switchWatchdog);
    switchWatchdog = setTimeout(function () {
      if (switching) {
        try { console.warn('[theme] 切换超时，强制复位'); } catch (e) {}
        switching = false;
        switchStartedAt = 0;
        var sp1 = splash();
        if (sp1) sp1.classList.remove('ts-on', 'bs-out');
      }
    }, 8000);
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { }
    try { localStorage.setItem(KEY, theme); } catch (e) { }
    hideResume();
    lastFromTheme = current; // 记录来源主题（续播文案用）
    takeSnapshot(); // 切换前快照播放现场（无论是否播放中，记录现场供恢复）

    var sp = splash(), stEl = splashStatus();
    var t0 = Date.now();
    if (stEl) stEl.textContent = '正在离开 ' + (THEME_NAME[current] || current) + '…';
    if (sp) { sp.classList.remove('bs-out'); sp.classList.add('ts-on'); }

    // 渐出停止播放（约 760ms），与过渡屏淡入并行
    stopPlayback(function () {
      // 切到「进入」文案 + 激活新主题（让出主线程一帧，防长任务卡死过渡动画）
      setTimeout(function () {
        if (stEl) stEl.textContent = '正在进入 ' + (THEME_NAME[theme] || theme) + '…';
        apply(theme);
        // 等新主题首帧就绪 + 满足最短展示时间，再淡出过渡屏
        var wait = Math.max(0, MIN_SHOW - (Date.now() - t0));
        setTimeout(function () {
          if (sp) { sp.classList.remove('ts-on'); sp.classList.add('bs-out'); }
          setTimeout(function () {
            if (sp) sp.classList.remove('bs-out');
            switching = false;
            switchStartedAt = 0;
            clearTimeout(switchWatchdog);
            showResume(); // 新界面顶部出「⏵ 续播」手动恢复条
          }, FADE_OUT);
        }, wait);
      }, 0);
    });

    // ⚠️ 硬性复位（2026-10-21）：不依赖异步链，2.5 秒后无条件复位 switching。
    //    之前 switching 卡在 true 导致无法再次切换主题。
    setTimeout(function () {
      if (!switching) return;
      try { console.log('[theme] 硬性复位 switching'); } catch (e) {}
      switching = false;
      switchStartedAt = 0;
      clearTimeout(switchWatchdog);
      var spX = splash();
      if (spX) spX.classList.remove('ts-on', 'bs-out');
      if (current !== theme) { try { apply(theme); } catch (e) {} }
      try { showResume(); } catch (e) {}
    }, 2500);
  }

  /* 续播条按钮（模块加载即绑一次；DOM 在 index.html 常驻） */
  function bindResumeBar() {
    var play = document.getElementById('theme-resume-play');
    var x = document.getElementById('theme-resume-x');
    if (play) play.onclick = doResume;
    if (x) x.onclick = function () { snapshot = null; hideResume(); };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindResumeBar);
  else bindResumeBar();

  /* AM 为主力开发界面；切往粒子舞台/FB2K 前弹确认（两个界面半停止开发） */
  function confirmLegacySwitch(theme) {
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center';
    var _lt = document.documentElement.classList.contains('am-light') || document.documentElement.dataset.light === '1';
    if (_lt) mask.style.background = 'rgba(255,255,255,.45)';
    var box = document.createElement('div');
    // ⚠️ 浅色适配（2026-10-21）
    var _light = document.documentElement.classList.contains('am-light')
      || document.documentElement.dataset.light === '1';
    box.style.cssText = _light
      ? 'background:#faf8f5;color:#1e1e1e;border:1px solid rgba(0,0,0,.10);border-radius:14px;padding:22px 26px;max-width:430px;box-shadow:0 16px 48px rgba(0,0,0,.16);font-size:14px;line-height:1.8'
      : 'background:#22252d;color:#e8ebf2;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:22px 26px;max-width:430px;box-shadow:0 16px 48px rgba(0,0,0,.55);font-size:14px;line-height:1.8';
    var msg = document.createElement('div');
    msg.textContent = '安妮播放器主力开发AM模拟界面，另外两个界面已经半停止开发，可能存在各类未知BUG，请问是否确认切换？';
    box.appendChild(msg);
    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:16px';
    var bCancel = document.createElement('button');
    bCancel.textContent = '取消';
    bCancel.style.cssText = _lt
      ? 'padding:6px 20px;border-radius:8px;border:1px solid rgba(0,0,0,.18);background:transparent;color:#444;cursor:pointer;font-size:13px'
      : 'padding:6px 20px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#cfd4de;cursor:pointer;font-size:13px';
    var bOk = document.createElement('button');
    bOk.textContent = '确认切换到 ' + (THEME_NAME[theme] || theme);
    bOk.style.cssText = 'padding:6px 20px;border-radius:8px;border:none;background:#e0485f;color:#fff;cursor:pointer;font-size:13px';
    bCancel.onclick = function () { mask.remove(); };
    bOk.onclick = function () { mask.remove(); doSwitch(theme); };
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    btns.appendChild(bCancel); btns.appendChild(bOk);
    box.appendChild(btns); mask.appendChild(box);
    document.body.appendChild(mask);
  }

  function switchTheme(theme) {
    try { console.log('[theme] switch(' + theme + ') 当前=' + current + ' switching=' + switching); } catch(e) {}
    if (VALID.indexOf(theme) < 0) { try{console.log('[theme] 无效主题');}catch(e){} return; }
    if (theme === current) { try{console.log('[theme] 已经是该主题，忽略');}catch(e){} return; }
    // ⚠️ 卡死自愈（2026-10-21）：上次切换如果没走完（switching 卡在 true），
    //    用户就再也切不回去了。这里检测超时并强制复位。
    if (switching) {
      var now = Date.now();
      if (!switchStartedAt || now - switchStartedAt > 6000) {
        switching = false;
        switchStartedAt = 0;
        // 清掉可能残留的过渡屏
        var sp0 = splash();
        if (sp0) sp0.classList.remove('ts-on', 'bs-out');
      } else {
        return;   // 正在切换中，忽略重复点击
      }
    }
    // ⚠️ 2026-10-24（用户反馈）：去掉「另外两个界面已经半停止开发…」的恐吓弹窗。
    //   三套界面都是正式功能，切换不该拦一道确认框。
    if (theme !== 'am') { doSwitch(theme); return; }
    doSwitch(theme);
  }

  /* ⚠️ 2026-10-24（用户要求）：主题切换按钮改成「弹出菜单主动选择另外两个模式」，
     不再循环切换（循环切换用户不知道下一个是什么）。三套界面的按钮共用这一个菜单。 */
  function showThemeMenu(anchor) {
    var old = document.getElementById('annie-theme-menu');
    if (old) { old.remove(); if (old._for === anchor) return; }   // 同一个按钮再点=收起
    var items = [
      { key: 'legacy', name: '粒子舞台', desc: '视觉优先 · 粒子/封面氛围' },
      { key: 'fb2k',    name: 'FB2K',    desc: '效率优先 · 播放列表/树形曲库' },
      { key: 'am',      name: 'Apple Music', desc: '美学优先 · 仿 AM 界面' }
    ];
    var menu = document.createElement('div');
    menu.id = 'annie-theme-menu';
    menu._for = anchor;
    var _lt = document.documentElement.classList.contains('am-light') || document.documentElement.dataset.light === '1';
    menu.style.cssText = 'position:fixed;z-index:100000;min-width:210px;padding:6px;border-radius:10px;'
      + 'font-size:13px;line-height:1.5;box-shadow:0 12px 36px rgba(0,0,0,.28);'
      + (_lt ? 'background:#faf8f5;color:#1e1e1e;border:1px solid rgba(0,0,0,.10)'
             : 'background:#22252d;color:#e8ebf2;border:1px solid rgba(255,255,255,.10)');
    items.forEach(function (it) {
      var row = document.createElement('div');
      var active = it.key === current;
      row.style.cssText = 'display:flex;flex-direction:column;gap:1px;padding:7px 10px;border-radius:7px;cursor:pointer;'
        + (active ? (_lt ? 'background:rgba(0,0,0,.06)' : 'background:rgba(255,255,255,.10)') : '');
      row.innerHTML = '<div style="font-weight:600">' + (active ? '✓ ' : '') + it.name + '</div>'
        + '<div style="font-size:11px;opacity:.6">' + it.desc + '</div>';
      row.onmouseenter = function () { if (!active) row.style.background = _lt ? 'rgba(0,0,0,.04)' : 'rgba(255,255,255,.06)'; };
      row.onmouseleave = function () { if (!active) row.style.background = ''; };
      row.onclick = function (e) {
        e.stopPropagation();
        menu.remove();
        if (it.key !== current) switchTheme(it.key);
      };
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    // 定位在按钮下方（超出屏幕则往上弹）
    var r = anchor.getBoundingClientRect();
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    setTimeout(function () {
      function off(e) {
        if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off, true); }
      }
      document.addEventListener('mousedown', off, true);
    }, 0);
  }
  window.annieThemeMenu = showThemeMenu;

  window.annieTheme = {
    get current() { return current; },
    apply: apply,
    switch: switchTheme,
    // ⚠️ 2026-10-24：暴露断点续播（供「点播放/空格」自动调用）
    hasResume: function () { return !!(snapshot && snapshot.path) && !!window.__annieResumePending; },
    doResume: doResume
  };

  // 启动时按存储主题应用（html dataset 已在 head 内联脚本中先行设置，避免闪屏）
  apply(current);
})();
