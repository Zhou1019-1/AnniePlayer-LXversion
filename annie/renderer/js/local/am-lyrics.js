'use strict';
/* ===== am.js 拆分片：am-lyrics.js =====
 * 歌词系统：LRC/逐字解析、卡拉OK逐词渲染、主面板/沉浸/迷你三容器共享、外观设置弹层
 * 来源：am.js 原稿行 1296-1498 + 1541-1690 + 1772-1799（原样切片，零行为变更）
 * 共享变量经 window.__annieAMInternal 桥接；前向引用为转发桩，运行时解析。 */
(function () {
  var AM = window.__annieAMInternal || (window.__annieAMInternal = {}); // AM 主题内部模块桥（跨分片共享闭包变量）
  // 从桥取用先加载分片导出的引用（此时前片已执行完，引用有效）
  var S = AM.S;
  var R = AM.R;
  var el = AM.el;
  var seek = AM.seek;

  /* ---------------- 歌词（AM 风格逐行） ---------------- */
  /* 逐字歌词：词标签解析（<mm:ss.xxx>绝对 / <相对ms,时长ms>lxlyric）+ 双层渲染 + 进度
   * 与 fb2k/stage-adapter 同款逻辑；无词标签时完全回退行级高亮 */
  function karaParseMark(raw, lineStart) {
    var s = String(raw || '').trim();
    var mm = /^(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)$/.exec(s);
    if (mm) return { t: (parseInt(mm[1], 10) || 0) * 60 + parseFloat(mm[2] || '0'), d: 0 };
    var rel = /^(\d+),(\d+)$/.exec(s);
    if (rel) return { t: (Number(lineStart) || 0) + (parseInt(rel[1], 10) || 0) / 1000, d: (parseInt(rel[2], 10) || 0) / 1000 };
    return null;
  }
  function karaExtractWords(rawText, lineStart) {
    var s = String(rawText || '');
    if (s.indexOf('<') < 0) return null;
    var re = /<([^<>]+)>/g, m, marks = [];
    while ((m = re.exec(s))) marks.push({ raw: m[1], index: m.index, end: re.lastIndex });
    if (!marks.length) return null;
    var words = [], fullText = '';
    for (var i = 0; i < marks.length; i++) {
      var seg = s.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].index : s.length);
      if (!seg) continue;
      var tk = karaParseMark(marks[i].raw, lineStart);
      if (tk == null) { fullText += seg; continue; }
      var c0 = fullText.length;
      fullText += seg;
      words.push({ text: seg, t: tk.t, d: tk.d, c0: c0, c1: fullText.length });
    }
    if (!words.length) return null;
    for (var k = 0; k < words.length; k++) {
      if (words[k].d > 0) continue;
      var nxt = words[k + 1];
      words[k].d = nxt ? Math.max(0.06, nxt.t - words[k].t) : 0.6;
    }
    return { text: fullText, words: words };
  }
  /* 逐词 span 卡拉OK：每词独立双层（底暗/顶高亮按词内进度裁切），词间自然折行，
   * 长行不再缩字号而是换行显示；每 tick 只刷当前行（~词数个 style 写入） */
  function paintKaraLine(node, now) {
    var arr = node._karaWords;
    for (var i = 0; i < arr.length; i++) {
      var w = arr[i].w;
      var ws = w.t, we = w.t + Math.max(0.08, w.d || 0.24);
      var p;
      if (now >= we) p = 1;
      else if (now <= ws) p = 0;
      else p = (now - ws) / (we - ws);
      arr[i].hi.style.width = (p * 100).toFixed(1) + '%';
    }
  }
  function resetKaraLine(node) {
    var arr = node._karaWords;
    for (var i = 0; i < arr.length; i++) arr[i].hi.style.width = '0%';
  }
  /* 逐字歌词总开关（设置中心·歌词页，LS annieplayer.karaoke，默认开） */
  function karaOn() { try { return localStorage.getItem('annieplayer.karaoke') !== '0'; } catch (e) { return true; } }
  /* 构建一行歌词元素（逐字时每词一个 span 可折行），主歌词/沉浸/迷你共用 */
  function buildLyrLineEl(l, i, cls) {
    var d = el('div', cls + ' far');
    if (l.words && l.words.length && l.text && karaOn()) {
      d.classList.add('kara');
      var limit = S.lyrWordLimit | 0; // 每行词数限制（0=按容器宽度自然折行）
      var wspans = [];
      l.words.forEach(function (w, wi) {
        if (limit > 0 && wi > 0 && wi % limit === 0) d.appendChild(document.createElement('br'));
        var ws = el('span', 'kara-w');
        var base = el('span', 'kara-wb'); base.textContent = w.text;
        var hi = el('span', 'kara-wh'); hi.textContent = w.text;
        ws.appendChild(base); ws.appendChild(hi);
        d.appendChild(ws);
        wspans.push({ w: w, hi: hi });
      });
      d._karaWords = wspans;
    } else {
      d.appendChild(document.createTextNode(l.text));
    }
    if (l.tly) d.appendChild(el('span', 'tly', l.tly));
    d.onclick = function () { seek(l.t); };
    d._idx = i;
    d._kt = l.text || ''; // 自适应行宽测量用
    return d;
  }
  /* 更新容器内当前行逐词进度（每 tick 调用；行切换时重置上一行） */
  function paintKara(container, cur, now) {
    if (!container) return;
    if (container._karaCur !== cur) {
      var old = container._karaCur;
      if (old != null && old >= 0) {
        var on = container.children[old];
        if (on && on._karaWords) resetKaraLine(on);
      }
      container._karaCur = cur;
    }
    if (cur < 0) return;
    var node = container.children[cur];
    if (node && node._karaWords) paintKaraLine(node, now);
  }
  function parseLrc(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      // lxlyric 行格式：[起始ms,时长ms]文本（行内 <相对ms,时长ms> 词标签走同一提取）
      var lx = /^\s*\[(\d+),(\d+)\](.*)$/.exec(line);
      if (lx) {
        var lt = (parseInt(lx[1], 10) || 0) / 1000;
        var lraw = (lx[3] || '').trim();
        var lex = karaExtractWords(lraw, lt);
        out.push({ t: lt, text: lex ? lex.text : lraw, words: lex ? lex.words : null });
        return;
      }
      var m = line.match(/((\[\d+:\d+(\.\d+)?\])+)(.*)/);
      if (!m) return;
      var raw = m[4].trim();
      var re = /\[(\d+):(\d+)(\.\d+)?\]/g, t, firstT = null, times = [];
      while ((t = re.exec(m[1]))) {
        var tt = (+t[1]) * 60 + (+t[2]) + (t[3] ? +t[3] : 0);
        if (firstT == null) firstT = tt;
        times.push(tt);
      }
      // 逐字：提取 <词时间> 标签，text 清洗为纯文本
      var ex = karaExtractWords(raw, firstT);
      var txt = ex ? ex.text : raw;
      var words = ex ? ex.words : null;
      times.forEach(function (tt) {
        out.push({ t: tt, text: txt, words: words ? words.slice() : null });
      });
    });
    // 翻译行合并：同一时间戳的后续行作为 tly
    out.sort(function (a, b) { return a.t - b.t; });
    var merged = [];
    out.forEach(function (l) {
      var prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.t - l.t) < 0.4 && prev.text && l.text) prev.tly = l.text;
      else if (l.text) merged.push({ t: l.t, text: l.text, tly: '', words: l.words || null });
    });
    return merged;
  }
  function loadLyrics(path, isStream) {
    if (S.lyrPath === path) return;
    S.lyrPath = path; S.lyrLines = []; S.lyrCur = -1;
    R.lyrScroll.innerHTML = '';
    if (!path) { renderLyrics(); return; }
    // 流媒体曲目：path 是真实播放 URL；歌词由 AM/streaming.js 取到后注入 __annieStreamLrcByPath 并广播 annie-stream-lyric
    if (isStream) {
      var cached = window.__annieStreamLrcByPath && window.__annieStreamLrcByPath[path];
      if (cached) { S.lyrLines = parseLrc(cached); }
      renderLyrics();
      return;
    }
    window.mine.lyrics(path).then(function (r) {
      if (S.lyrPath !== path) return;
      S.lyrLines = (r && r.ok && r.text) ? parseLrc(r.text) : [];
      renderLyrics();
    }).catch(function () { renderLyrics(); });
  }
  function renderLyrics() {
    // 沉浸/迷你里打开的歌词容器同步刷新
    if (R.imm && S.imm && S.immLyrOn) buildLyrInto(R.immLyrBox);
    if (R.mini && S.mini && S.miniLyrOn) buildLyrInto(R.miniLyr);
    var box = R.lyrScroll;
    box.innerHTML = '';
    if (!S.lyrLines.length) {
      var emptyText = !state.currentPath ? '播放歌曲以显示歌词'
        : (state.currentStream ? '歌词加载中…' : '暂无歌词');
      box.appendChild(el('div', 'am-lyr-empty', emptyText));
      return;
    }
    S.lyrLines.forEach(function (l, i) {
      box.appendChild(buildLyrLineEl(l, i, 'am-lyr-line'));
    });
    fitLyrLines(box);
    tickLyrics();
  }
  function tickLyrics() {
    if (!S.lyrLines.length || !R.lyrScroll) return;
    // V3.5.15：歌词偏移（按曲记忆）——有效位置 = 播放位置 + 用户校准偏移
    var epos = window.annieLyrOff ? window.annieLyrOff.pos(S.lyrPath || state.currentPath, S.pos) : S.pos;
    var cur = -1;
    for (var i = 0; i < S.lyrLines.length; i++) {
      if (S.lyrLines[i].t <= epos + 0.15) cur = i; else break;
    }
    // 逐字扫过：每 tick 更新当前行（不吃下方 line-change 早退）
    paintKara(R.lyrScroll, cur, epos);
    // 沉浸/迷你歌词容器同样每 tick 平滑扫过（否则只在行切换时跳变）
    if (R.imm && S.imm && S.immLyrOn) paintKara(R.immLyrBox, cur, epos);
    if (R.mini && S.mini && S.miniLyrOn) paintKara(R.miniLyr, cur, epos);
    if (cur === S.lyrCur) return;
    S.lyrCur = cur;
    var nodes = R.lyrScroll.children;
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      if (n._idx == null) continue;
      var dist = Math.abs(n._idx - cur);
      n.classList.toggle('cur', n._idx === cur);
      n.classList.toggle('near', dist === 1);
      n.classList.toggle('far', dist > 1);
    }
    if (cur >= 0 && nodes[cur]) {
      R.lyrScroll.scrollTop = nodes[cur].offsetTop - R.lyrScroll.clientHeight * 0.42;
    }
    // 沉浸/迷你歌词容器跟随同一 S.lyrCur
    if (R.imm && S.imm && S.immLyrOn) paintLyrBox(R.immLyrBox, cur, 0.35);
    if (R.mini && S.mini && S.miniLyrOn) paintLyrBox(R.miniLyr, cur, 0.40);
  }

  /* ================= 歌词外观：自适应行宽 + 字号/行距自定义 + 滚动条自动隐藏 ================= */
  var _fitCanvas = null;
  function fitCtx() {
    if (!_fitCanvas) _fitCanvas = document.createElement('canvas');
    return _fitCanvas.getContext('2d');
  }
  /* 逐行自适应：行文本宽于容器则按比例缩字号（最低 55%），卡拉OK行整体缩放不影响扫过比例 */
  function fitLyrLines(box) {
    if (!box || !box.clientWidth) return;
    var avail = box.clientWidth - 30;
    var nodes = box.children;
    var ctx = fitCtx();
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n._idx == null || !n._kt) continue;
      if (!n._fs0 || n._fsv !== S.lyrFsV) { // 字号设置变化后重取基准
        var cs = getComputedStyle(n);
        n._fs0 = parseFloat(cs.fontSize) || 15;
        n._fw = cs.fontWeight || '400';
        n._ff = cs.fontFamily || 'sans-serif';
        n._fsv = S.lyrFsV;
      }
      ctx.font = n._fw + ' ' + n._fs0 + 'px ' + n._ff;
      var w = ctx.measureText(n._kt).width;
      // 仅兜底不可折行的超长词（无空白）；其余行一律自然折行，不再缩字号
      if (w > avail && !/\s/.test(n._kt)) n.style.fontSize = Math.max(n._fs0 * 0.55, Math.floor(n._fs0 * avail / w * 10) / 10) + 'px';
      else n.style.fontSize = '';
    }
  }
  function refitAllLyr() {
    fitLyrLines(R.lyrScroll);
    if (R.imm && S.imm && S.immLyrOn) fitLyrLines(R.immLyrBox);
    if (R.mini && S.mini && S.miniLyrOn) fitLyrLines(R.miniLyr);
  }
  /* 滚动条仅滚动时出现（停滚 800ms 后隐藏） */
  function autoHideScrollbar(box) {
    if (!box) return;
    var t = 0;
    box.addEventListener('scroll', function () {
      box.classList.add('scrolling');
      clearTimeout(t);
      t = setTimeout(function () { box.classList.remove('scrolling'); }, 800);
    }, { passive: true });
  }
  /* 字号/行距/每行词数自定义（localStorage 持久化，CSS 变量驱动，三处歌词容器同效） */
  function applyLyrStyle() {
    var sc = 1, lh = 1.45, wl = 0;
    try {
      sc = Math.min(1.6, Math.max(0.7, parseFloat(localStorage.getItem('annieplayer.am.lyrscale')) || 1));
      lh = Math.min(2.2, Math.max(1.2, parseFloat(localStorage.getItem('annieplayer.am.lyrlh')) || 1.45));
      wl = Math.min(20, Math.max(0, parseInt(localStorage.getItem('annieplayer.am.lyrwordlimit'), 10) || 0));
    } catch (e) { }
    S.lyrFsV = (S.lyrFsV || 0) + 1; // 递增使各行字号缓存失效
    S.lyrScale = sc; S.lyrLh = lh; S.lyrWordLimit = wl;
    var root = document.getElementById('am-root');
    if (root) {
      root.style.setProperty('--am-lyr-scale', sc);
      root.style.setProperty('--am-lyr-lh', lh);
    }
    refitAllLyr();
  }
  /* 结构级变更（每行词数）后重建三处歌词容器 */
  function rerenderAllLyr() {
    renderLyrics();
    if (R.imm && S.imm && S.immLyrOn) buildLyrInto(R.immLyrBox);
    if (R.mini && S.mini && S.miniLyrOn) buildLyrInto(R.miniLyr);
  }
  function toggleLyrSetPop() {
    if (!R.lyrSetPop) buildLyrSetPop();
    var pop = R.lyrSetPop;
    if (pop.classList.contains('on')) { pop.classList.remove('on'); return; }
    var r = R.btnLyrSet.getBoundingClientRect();
    pop.style.left = Math.max(8, r.right - 250) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
    pop.classList.add('on');
  }
  function buildLyrSetPop() {
    var pop = el('div', 'am-pop am-lyrset-pop');
    pop.appendChild(el('div', 'am-pop-h', '歌词外观'));
    var row1 = el('div', 'am-pop-row');
    row1.appendChild(el('span', null, '字号'));
    var sl1 = document.createElement('input');
    sl1.type = 'range'; sl1.min = 70; sl1.max = 160; sl1.step = 5;
    sl1.value = Math.round((S.lyrScale || 1) * 100);
    sl1.className = 'am-lyrset-slider';
    var v1 = el('span', 'am-lyrset-v', sl1.value + '%');
    sl1.oninput = function () {
      v1.textContent = sl1.value + '%';
      try { localStorage.setItem('annieplayer.am.lyrscale', String(sl1.value / 100)); } catch (e) { }
      applyLyrStyle();
    };
    row1.appendChild(sl1); row1.appendChild(v1);
    pop.appendChild(row1);
    var row2 = el('div', 'am-pop-row');
    row2.appendChild(el('span', null, '行距'));
    var sl2 = document.createElement('input');
    sl2.type = 'range'; sl2.min = 120; sl2.max = 220; sl2.step = 5;
    sl2.value = Math.round((S.lyrLh || 1.45) * 100);
    sl2.className = 'am-lyrset-slider';
    var v2 = el('span', 'am-lyrset-v', (sl2.value / 100).toFixed(2));
    sl2.oninput = function () {
      v2.textContent = (sl2.value / 100).toFixed(2);
      try { localStorage.setItem('annieplayer.am.lyrlh', String(sl2.value / 100)); } catch (e) { }
      applyLyrStyle();
    };
    row2.appendChild(sl2); row2.appendChild(v2);
    pop.appendChild(row2);
    // 每行词数（卡拉OK行生效；0=按容器宽度自然折行）
    var row3 = el('div', 'am-pop-row');
    row3.appendChild(el('span', null, '每行词数'));
    var sl3 = document.createElement('input');
    sl3.type = 'range'; sl3.min = 0; sl3.max = 12; sl3.step = 1;
    sl3.value = S.lyrWordLimit || 0;
    sl3.className = 'am-lyrset-slider';
    var v3 = el('span', 'am-lyrset-v', (S.lyrWordLimit || 0) === 0 ? '自动' : String(S.lyrWordLimit));
    sl3.oninput = function () {
      var n = +sl3.value;
      v3.textContent = n === 0 ? '自动' : String(n);
      try { localStorage.setItem('annieplayer.am.lyrwordlimit', String(n)); } catch (e) { }
      S.lyrWordLimit = n;
      rerenderAllLyr();
    };
    row3.appendChild(sl3); row3.appendChild(v3);
    pop.appendChild(row3);
    // V3.5.15：歌词偏移微调（±0.5s，按曲记忆；AM/FB2K/桌面歌词三处同一生效）
    if (window.annieLyrOff) {
      var row4 = el('div', 'am-pop-row');
      row4.appendChild(el('span', null, '歌词偏移'));
      var offVal = el('span', 'am-lyrset-v', window.annieLyrOff.fmt(window.annieLyrOff.get(state.currentPath)));
      var mkOffBtn = function (txt, title, fn) {
        var b = el('button', 'am-tbtn', txt); b.title = title;
        b.onclick = function () {
          if (!state.currentPath) { try { if (typeof proToast === 'function') proToast('未在播放，无法校准'); } catch (e) { } return; }
          fn();
          offVal.textContent = window.annieLyrOff.fmt(window.annieLyrOff.get(state.currentPath));
          tickLyrics();
        };
        return b;
      };
      row4.appendChild(mkOffBtn('−', '歌词延后 0.5 秒（歌词比声音快时点）', function () { window.annieLyrOff.adjust(state.currentPath, -0.5); }));
      row4.appendChild(offVal);
      row4.appendChild(mkOffBtn('＋', '歌词提前 0.5 秒（歌词比声音慢时点）', function () { window.annieLyrOff.adjust(state.currentPath, 0.5); }));
      row4.appendChild(mkOffBtn('↺', '重置本曲偏移', function () { window.annieLyrOff.set(state.currentPath, 0); }));
      pop.appendChild(row4);
    }
    pop.appendChild(el('div', 'am-pop-hint', '超长行自动折行显示（不再缩小字号）；每行词数仅对逐字歌词生效，中文按字计；歌词偏移按曲目记忆，对所有歌词显示生效'));
    document.getElementById('am-root').appendChild(pop);
    R.lyrSetPop = pop;
  }

  /* ================= 歌词行：沉浸/迷你共享渲染 ================= */
  function buildLyrInto(box) {
    box.innerHTML = '';
    if (!S.lyrLines.length) {
      box.appendChild(el('div', 'am-lyr-empty', !state.currentPath ? '播放歌曲以显示歌词' : (state.currentStream ? '歌词加载中…' : '暂无歌词')));
      return;
    }
    S.lyrLines.forEach(function (l, i) {
      box.appendChild(buildLyrLineEl(l, i, 'am-lyr-line'));
    });
    fitLyrLines(box);
    paintLyrBox(box, S.lyrCur, 0.35);
  }
  function paintLyrBox(box, cur, rate) {
    if (!box) return;
    var nodes = box.children;
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      if (n._idx == null) continue;
      var dist = Math.abs(n._idx - cur);
      n.classList.toggle('cur', n._idx === cur);
      n.classList.toggle('near', dist === 1);
      n.classList.toggle('far', dist > 1);
    }
    paintKara(box, cur, S.pos);
    if (cur >= 0 && nodes[cur]) box.scrollTop = nodes[cur].offsetTop - box.clientHeight * rate;
  }


  /* 注册到模块桥（供其他分片取用） */
  AM.loadLyrics = loadLyrics;
  AM.tickLyrics = tickLyrics;
  AM.refitAllLyr = refitAllLyr;
  AM.applyLyrStyle = applyLyrStyle;
  AM.rerenderAllLyr = rerenderAllLyr;
  AM.toggleLyrSetPop = toggleLyrSetPop;
  AM.buildLyrInto = buildLyrInto;
  AM.autoHideScrollbar = autoHideScrollbar;
})();
