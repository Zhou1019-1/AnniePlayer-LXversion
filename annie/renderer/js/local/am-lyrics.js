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
  /* 构建一行歌词元素（逐字时每词一个 span 可折行），主歌词/沉浸/迷你共用。
   * wordLimit 显式指定每行词数（主面板/沉浸各自独立），未传时取主界面配置（兼容旧调用） */
  function buildLyrLineEl(l, i, cls, wordLimit, dual) {
    var d = el('div', cls + ' far');
    var tlyOnly = dual === 'tly' && l.tly;
    if (tlyOnly) {
      // 仅译文：译文按原文字号/字重渲染（CSS .tly-main），不插原文节点
      var tm = el('span', 'tly tly-main', l.tly);
      d.appendChild(tm);
    } else if (l.words && l.words.length && l.text && karaOn()) {
      d.classList.add('kara');
      var limit = wordLimit == null ? (S.lyrWordLimit | 0) : (wordLimit | 0); // 每行词数限制（0=按容器宽度自然折行）
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
    if (l.tly && !tlyOnly && dual !== 'src') d.appendChild(el('span', 'tly', l.tly));
    d.onclick = function () {
      var from = S.pos;
      seek(l.t);
      // V4.4：彩胶表把联动——歌词点跳也触发甩碟（AM.vinylCrownSeek 由 am-render 片注册，无彩胶时内部空转）
      try { if (AM.vinylCrownSeek) AM.vinylCrownSeek(from, l.t); } catch (e) { }
    };
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
    // 兼容单行 LRC：历史版本 tagWriter.metaValue 会把内嵌歌词的换行洗成空格，
    // 所有时间戳挤在一行 → 只识别出第一句、无时间轴不滚动。
    // 这里在「非 ] 字符之后的时间戳」前补换行拆行；行首连续时间戳（[t1][t2]同一句多时间点）
    // 的 [ 前面是 ]，不受影响，仍由下方多时间戳逻辑展开。
    text = String(text || '').replace(/([^\r\n\]])(\[\d+:\d+(\.\d+)?\])/g, '$1\n$2');
    text.split(/\r?\n/).forEach(function (line) {
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
      if (!/^(?:[\u4e00-\u9fff]{1,6}\s*[:\uff1a]|[A-Za-z][A-Za-z ]{0,14}by\s*[:\uff1a])/i.test(l.text || '') && prev && Math.abs(prev.t - l.t) < 0.4 && prev.text && l.text && !prev.tly) prev.tly = l.text;
      else if (l.text) merged.push({ t: l.t, text: l.text, tly: '', words: l.words || null });
    });
    return merged;
  }
  /* 流媒体译文轨合并：tlyric 是独立 LRC 文本，按时间戳就近挂到主歌词行（±0.8s） */
  function mergeTly(lines, tlyText) {
    if (!tlyText || !lines.length) return lines;
    var tl = parseLrc(tlyText);
    tl.forEach(function (x) {
      var best = -1, bd = 0.8;
      for (var i = 0; i < lines.length; i++) {
        var d = Math.abs(lines[i].t - x.t);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0 && !lines[best].tly && x.text !== lines[best].text && !/^(?:[\u4e00-\u9fff]{1,6}\s*[:\uff1a]|[A-Za-z][A-Za-z ]{0,14}by\s*[:\uff1a])/i.test(x.text || '')) lines[best].tly = x.text;
    });
    return lines;
  }
  function loadLyrics(path, isStream) {
    if (S.lyrPath === path) return;
    S.lyrPath = path; S.lyrLines = []; S.lyrCur = -1;
    R.lyrScroll.innerHTML = '';
    if (!path) { renderLyrics(); return; }
    // 流媒体曲目：path 是真实播放 URL；歌词由 AM/streaming.js 取到后注入 __annieStreamLrcByPath 并广播 annie-stream-lyric
    if (isStream) {
      var cached = window.__annieStreamLrcByPath && window.__annieStreamLrcByPath[path];
      if (cached) {
        S.lyrLines = parseLrc(cached);
        var tly = window.__annieStreamTlyByPath && window.__annieStreamTlyByPath[path];
        if (tly) mergeTly(S.lyrLines, tly);
      }
      renderLyrics();
      return;
    }
    window.mine.lyrics(path).then(function (r) {
      if (S.lyrPath !== path) return;
      S.lyrLines = (r && r.ok && r.text) ? parseLrc(r.text) : [];
      renderLyrics();
      if (!S.lyrLines.length) tryAutoLyric(path); // V4.4：无歌词时自动在线补全
    }).catch(function () { renderLyrics(); });
  }
  /* V4.4：播放时自动在线补全——无歌词的本地曲目实时五平台匹配（≥80% 取最高分），
     仅回显不落盘（落盘仍走右键「在线匹配」/ 批量匹配）；封面缺失时顺带补显示。
     会话级缓存（负缓存防重拉）；CUE/ISO 分轨跳过（整文件歌词会张冠李戴）。 */
  var _autoLrc = {}; // path → undefined(未拉) | 'pending' | null(无结果) | {lrc,tlyric,cover,provider}
  function autoLrcEnabled() { try { return localStorage.getItem('annieplayer.lrc.autofetch') !== '0'; } catch (e) { return true; } }
  function tryAutoLyric(path) {
    if (!path || !autoLrcEnabled()) return;
    if (!window.mine || !mine.matchAutoLyric) return;
    if (state.currentCue || state.currentIso) return;
    var c = _autoLrc[path];
    if (c === 'pending') { renderLyrics(); return; }
    if (c !== undefined) { applyAutoLyric(path); return; }
    _autoLrc[path] = 'pending';
    renderLyrics(); // 空态文案显示「在线匹配中…」
    mine.matchAutoLyric(path).then(function (r) {
      _autoLrc[path] = (r && r.ok) ? r : (r && r.cover ? { cover: r.cover } : null);
      applyAutoLyric(path);
    }).catch(function () { _autoLrc[path] = null; if (S.lyrPath === path) renderLyrics(); });
  }
  function applyAutoLyric(path) {
    if (S.lyrPath !== path) return;
    var c = _autoLrc[path];
    if (!c || c === 'pending') return;
    var filled = false;
    if (c.lrc && !S.lyrLines.length) {
      S.lyrLines = parseLrc(c.lrc);
      if (c.tlyric) mergeTly(S.lyrLines, c.tlyric);
      filled = !!S.lyrLines.length;
    }
    renderLyrics();
    if (filled && typeof proToast === 'function') proToast('已自动补全歌词（' + (c.provider || '在线') + ' · ' + (c.score || '?') + '%）');
    if (c.cover && AM.autoCoverFill) { try { AM.autoCoverFill(path, c.cover); } catch (e) { } }
  }
  /* V4.4.2：手动滚动 5 秒不回弹改为按容器 WeakMap（主界面/沉浸/迷你三盒各自独立计时）——
   * 旧实现单变量只管主界面 R.lyrScroll，沉浸歌词面板没吃到保护 */
  var _lyrManualScrollUntil = new WeakMap();
  function lyrManualUntil(box, ms) { if (box) _lyrManualScrollUntil.set(box, Date.now() + (ms || 5000)); }
  function lyrManualActive(box) { return !!(box && Date.now() < (_lyrManualScrollUntil.get(box) || 0)); }
  /* V4.4：彩胶沉浸模式歌词常驻（💬 开关隐藏不用），更新链路的 immLyrOn 判据要带上它。
     AM.immIsVinyl 由后加载的 am-render 片注册，调用时才取值（前向引用惯例） */
  function immLyrActive() { return !!(S.immLyrOn || (AM.immIsVinyl && AM.immIsVinyl())); }
  function renderLyrics() {
    _lyrManualScrollUntil = new WeakMap(); // 切歌/重建：三路保护期一并清零
    // 沉浸/迷你里打开的歌词容器同步刷新（沉浸用独立的每行词数，迷你跟随主界面）
    if (R.imm && S.imm && immLyrActive()) buildLyrInto(R.immLyrBox);
    if (R.mini && S.mini && S.miniLyrOn) buildLyrInto(R.miniLyr);
    var box = R.lyrScroll;
    box.innerHTML = '';
    if (!S.lyrLines.length) {
      var emptyText = !state.currentPath ? '播放歌曲以显示歌词'
        : (state.currentStream ? '歌词加载中…'
        : (_autoLrc[S.lyrPath] === 'pending' ? '正在在线匹配歌词…' : '暂无歌词'));
      box.appendChild(el('div', 'am-lyr-empty', emptyText));
      return;
    }
    S.lyrLines.forEach(function (l, i) {
      box.appendChild(buildLyrLineEl(l, i, 'am-lyr-line', S.lyrWordLimit | 0, S.lyrDual || 'row'));
    });
    fitLyrLines(box);
    tickLyrics();
    // V4.1：歌词整组重建（切歌/外观变更）逐行浮入
    box.classList.remove('am-lyr-fresh'); void box.offsetWidth; box.classList.add('am-lyr-fresh');
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
    if (R.imm && S.imm && immLyrActive()) paintKara(R.immLyrBox, cur, epos);
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
    if (cur >= 0 && nodes[cur] && !lyrManualActive(R.lyrScroll)) {
      progScrollTop(R.lyrScroll, nodes[cur].offsetTop - R.lyrScroll.clientHeight * lyrPosRate(S.lyrPos, 0.42));
    }
    // 沉浸/迷你歌词容器跟随同一 S.lyrCur（迷你不提供跟随位置设置，固定 0.40）
    if (R.imm && S.imm && immLyrActive()) paintLyrBox(R.immLyrBox, cur, lyrPosRate(S.immLyrPos, 0.35));
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
    if (R.imm && S.imm && immLyrActive()) fitLyrLines(R.immLyrBox);
    if (R.mini && S.mini && S.miniLyrOn) fitLyrLines(R.miniLyr);
  }
  /* 滚动条仅滚动时出现（停滚 800ms 后隐藏） */
  // V4.4：程序驱动（歌词跟随/恢复位置）的 scrollTop 写入窗口内不显示自动隐藏滚动条，
  // 否则逐行跟随滚动会持续触发 scroll 事件让滚动条竖条常驻
  var _progScrollUntil = new WeakMap();
  function progScrollTop(box, val) {
    if (!box) return;
    _progScrollUntil.set(box, Date.now() + 150);
    box.scrollTop = val;
  }
  AM.progScrollTop = progScrollTop;
  function autoHideScrollbar(box) {
    if (!box) return;
    var t = 0;
    box.addEventListener('scroll', function () {
      if (Date.now() < (_progScrollUntil.get(box) || 0)) return; // 跟随播放的自动滚动：不亮滚动条
      // V4.4.2：三个歌词容器各自记保护期（主界面/沉浸/迷你）
      if (box === R.lyrScroll || box === R.immLyrBox || box === R.miniLyr) lyrManualUntil(box, 5000);
      box.classList.add('scrolling');
      clearTimeout(t);
      t = setTimeout(function () { box.classList.remove('scrolling'); }, 800);
    }, { passive: true });
  }
  /* 字号/行距/每行词数自定义（localStorage 持久化，CSS 变量驱动）。
   * 主界面歌词（右栏，迷你跟随）与沉浸模式歌词两套配置独立：
   * 主界面键前缀 annieplayer.am.；沉浸键前缀 annieplayer.imm.（首次使用取与主界面相同的默认值） */
  function readLyrProfile(prefix, seed) {
    var p = { sc: 1, lh: 1.45, wl: 0, blur: true, tly: 1, dual: 'row', pos: 'upper' };
    if (seed) { p.sc = seed.sc; p.lh = seed.lh; p.wl = seed.wl; p.blur = seed.blur; p.tly = seed.tly; p.dual = seed.dual; p.pos = seed.pos; }
    try {
      var v;
      v = parseFloat(localStorage.getItem(prefix + 'lyrscale')); if (isFinite(v)) p.sc = Math.min(1.6, Math.max(0.7, v));
      v = parseFloat(localStorage.getItem(prefix + 'lyrlh')); if (isFinite(v)) p.lh = Math.min(2.2, Math.max(1.2, v));
      v = parseInt(localStorage.getItem(prefix + 'lyrwordlimit'), 10); if (!isNaN(v)) p.wl = Math.min(20, Math.max(0, v));
      v = localStorage.getItem(prefix + 'lyrblur'); if (v !== null) p.blur = v !== '0'; // 歌词虚化默认开
      v = parseFloat(localStorage.getItem(prefix + 'tlyscale')); if (isFinite(v)) p.tly = Math.min(1.6, Math.max(0.7, v)); // 译文字号独立缩放
      v = localStorage.getItem(prefix + 'dual'); if (v === 'row' || v === 'side' || v === 'src' || v === 'tly') p.dual = v; // 双语布局
      v = localStorage.getItem(prefix + 'lyrpos'); if (v === 'upper' || v === 'center' || v === 'lower') p.pos = v;       // 当前行跟随位置
    } catch (e) { }
    return p;
  }
  /* 当前行跟随位置 → 滚动定位比例（null 表示调用方用各自默认） */
  function lyrPosRate(pos, def) {
    if (pos === 'center') return 0.5;
    if (pos === 'lower') return 0.62;
    return def;
  }
  function applyLyrStyle() {
    var m = readLyrProfile('annieplayer.am.');
    // 沉浸配置从未设置时跟随主界面现有调校（老用户升级无感）；在沉浸弹层调过一次后即独立
    var im = readLyrProfile('annieplayer.imm.', m);
    var coverOn = true;
    try { coverOn = localStorage.getItem('annieplayer.am.lyrcover') !== '0'; } catch (e) { } // V4.3.22：面板封面默认开（仅主界面面板）
    S.lyrFsV = (S.lyrFsV || 0) + 1; // 递增使各行字号缓存失效
    S.lyrScale = m.sc; S.lyrLh = m.lh; S.lyrWordLimit = m.wl; S.lyrBlur = m.blur; S.lyrTlyScale = m.tly;
    S.lyrDual = m.dual; S.lyrPos = m.pos;
    S.immLyrScale = im.sc; S.immLyrLh = im.lh; S.immLyrWordLimit = im.wl; S.immLyrBlur = im.blur; S.immTlyScale = im.tly;
    S.immLyrDual = im.dual; S.immLyrPos = im.pos;
    S.lyrCoverOn = coverOn;
    var root = document.getElementById('am-root');
    if (root) {
      root.style.setProperty('--am-lyr-scale', m.sc);
      root.style.setProperty('--am-lyr-lh', m.lh);
      root.style.setProperty('--am-tly-scale', m.tly);
      root.style.setProperty('--am-imm-lyr-scale', im.sc);
      root.style.setProperty('--am-imm-lyr-lh', im.lh);
      root.style.setProperty('--am-imm-tly-scale', im.tly);
      root.classList.toggle('am-no-lyrblur', !m.blur);
      root.classList.toggle('am-no-imm-lyrblur', !im.blur);
      root.classList.toggle('am-lyrcover-off', !coverOn);
      // 双语布局：主界面（含迷你）am-m-dual-*，沉浸 am-i-dual-*（祖先类隔离，行类名共享）
      ['row', 'side', 'src', 'tly'].forEach(function (d) {
        root.classList.toggle('am-m-dual-' + d, m.dual === d);
        root.classList.toggle('am-i-dual-' + d, im.dual === d);
      });
    }
    refitAllLyr();
  }
  /* 结构级变更（每行词数）后重建三处歌词容器 */
  function rerenderAllLyr() {
    renderLyrics();
    if (R.imm && S.imm && immLyrActive()) buildLyrInto(R.immLyrBox);
    if (R.mini && S.mini && S.miniLyrOn) buildLyrInto(R.miniLyr);
  }
  /* V4.4：支持沉浸模式锚点——同一弹层可从主面板 ⚙ 或沉浸右上角 ⚙ 打开；
   * 开着时换锚点=改挂新位置，同一锚点再点=收起。
   * 两个锚点编辑的是两套独立配置：主面板 ⚙ 改主界面歌词，沉浸 ⚙ 改沉浸歌词。 */
  function toggleLyrSetPop(anchor) {
    var btn = anchor || R.btnLyrSet;
    var ctx = (R.immBtnLyrSet && btn === R.immBtnLyrSet) ? 'imm' : 'main';
    if (R.lyrSetPop) {
      if (R.lyrSetPop.classList.contains('on') && R.lyrSetPop._anchor === btn) { R.lyrSetPop.classList.remove('on'); return; }
      R.lyrSetPop.remove(); // 切换上下文时按新配置重建
      R.lyrSetPop = null;
    }
    buildLyrSetPop(ctx);
    var pop = R.lyrSetPop;
    pop._anchor = btn;
    var r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, r.right - 250) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
    pop.classList.add('on');
  }
  function buildLyrSetPop(ctx) {
    var imm = ctx === 'imm';
    // 当前上下文对应的配置（键前缀 + S 中已应用的值）
    var prefix = imm ? 'annieplayer.imm.' : 'annieplayer.am.';
    var cur = imm
      ? { sc: S.immLyrScale || 1, lh: S.immLyrLh || 1.45, wl: S.immLyrWordLimit || 0, blur: S.immLyrBlur !== false, tly: S.immTlyScale || 1 }
      : { sc: S.lyrScale || 1, lh: S.lyrLh || 1.45, wl: S.lyrWordLimit || 0, blur: S.lyrBlur !== false, tly: S.lyrTlyScale || 1 };
    var pop = el('div', 'am-pop am-lyrset-pop');
    pop.appendChild(el('div', 'am-pop-h', imm ? '歌词外观 · 沉浸模式' : '歌词外观 · 主界面'));
    if (imm) pop.appendChild(el('div', 'am-pop-hint', '此处设置仅作用于沉浸模式（含彩胶唱片）歌词，与主界面右栏歌词各自独立'));
    function sliderRow(label, keySuffix, min, max, step, value, fmt, oninput) {
      var row = el('div', 'am-pop-row');
      row.appendChild(el('span', null, label));
      var sl = document.createElement('input');
      sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step;
      sl.value = value;
      sl.className = 'am-lyrset-slider';
      var v = el('span', 'am-lyrset-v', fmt(sl.value));
      sl.oninput = function () { v.textContent = fmt(sl.value); oninput(sl.value); };
      row.appendChild(sl); row.appendChild(v);
      pop.appendChild(row);
      return sl;
    }
    function saveKey(suffix, val) { try { localStorage.setItem(prefix + suffix, String(val)); } catch (e) { } }
    sliderRow('字号', 'lyrscale', 70, 160, 5, Math.round(cur.sc * 100),
      function (x) { return x + '%'; },
      function (x) { saveKey('lyrscale', x / 100); applyLyrStyle(); });
    sliderRow('译文字号', 'tlyscale', 70, 160, 5, Math.round(cur.tly * 100),
      function (x) { return x + '%'; },
      function (x) { saveKey('tlyscale', x / 100); applyLyrStyle(); });
    sliderRow('行距', 'lyrlh', 120, 220, 5, Math.round(cur.lh * 100),
      function (x) { return (x / 100).toFixed(2); },
      function (x) { saveKey('lyrlh', x / 100); applyLyrStyle(); });
    sliderRow('每行词数', 'lyrwordlimit', 0, 12, 1, cur.wl,
      function (x) { return (+x) === 0 ? '自动' : String(x); },
      function (x) {
        var n = +x;
        saveKey('lyrwordlimit', n);
        if (imm) S.immLyrWordLimit = n; else S.lyrWordLimit = n;
        rerenderAllLyr();
      });
    // 歌词虚化开关（默认开；非当前行模糊，关闭后仅压暗）
    var rowB = el('div', 'am-pop-row');
    rowB.appendChild(el('span', null, '歌词虚化'));
    var bBlur = el('button', 'am-tbtn', cur.blur ? '开' : '关');
    bBlur.title = '非当前歌词行的模糊效果（默认打开）';
    bBlur.onclick = function () {
      var on = !cur.blur;
      cur.blur = on;
      bBlur.textContent = on ? '开' : '关';
      saveKey('lyrblur', on ? '1' : '0');
      applyLyrStyle();
    };
    rowB.appendChild(bBlur);
    pop.appendChild(rowB);
    /* ---- V4.4：显示预设（一键套字号/行距/虚化；仅覆盖这三项，双语/位置/背景不动） ---- */
    function reopenPop() { // 预设改动后重建弹层，让滑条同步到新值
      if (R.lyrSetPop) { R.lyrSetPop.classList.remove('on'); R.lyrSetPop.remove(); R.lyrSetPop = null; }
      buildLyrSetPop(ctx);
      var p = R.lyrSetPop;
      p._anchor = btn;
      var rr = btn.getBoundingClientRect();
      p.style.left = Math.max(8, rr.right - 250) + 'px';
      p.style.top = (rr.bottom + 8) + 'px';
      p.classList.add('on');
    }
    var PRESETS = {
      comfort: { sc: 1.05, lh: 1.7, blur: '1' },
      cinema:  { sc: 1.25, lh: 1.95, blur: '0' },
      compact: { sc: 0.9, lh: 1.3, blur: '1' }
    };
    var rowP = el('div', 'am-pop-row am-pop-row-wrap');
    rowP.appendChild(el('span', null, '预设'));
    var segP = el('div', 'am-seg');
    [['comfort', '舒适'], ['cinema', '影院'], ['compact', '紧凑']].forEach(function (kv) {
      var b = el('button', 'am-tbtn', kv[1]);
      b.title = kv[0] === 'comfort' ? '字号略大、行距宽松、虚化非当前行'
        : kv[0] === 'cinema' ? '大字号大行距、关闭虚化（只突出当前行）'
        : '小字号窄行距，一屏看更多行';
      b.onclick = function () {
        var s = PRESETS[kv[0]];
        saveKey('lyrscale', s.sc); saveKey('lyrlh', s.lh); saveKey('lyrblur', s.blur);
        applyLyrStyle();
        reopenPop();
      };
      segP.appendChild(b);
    });
    rowP.appendChild(segP);
    pop.appendChild(rowP);
    /* ---- V4.4：双语歌词布局（上下/左右/仅原文/仅译文；主界面与沉浸各自独立） ---- */
    function segRow(label, options, value, onPick) {
      var row = el('div', 'am-pop-row am-pop-row-wrap');
      row.appendChild(el('span', null, label));
      var seg = el('div', 'am-seg');
      options.forEach(function (o) {
        var b = el('button', 'am-tbtn' + (o.v === value ? ' on' : ''), o.t);
        if (o.hint) b.title = o.hint;
        b.onclick = function () {
          onPick(o.v);
          seg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
        };
        seg.appendChild(b);
      });
      row.appendChild(seg);
      pop.appendChild(row);
    }
    var dualNow = imm ? (S.immLyrDual || 'row') : (S.lyrDual || 'row');
    segRow('双语', [
      { v: 'row', t: '上下', hint: '译文显示在原文下方（默认）' },
      { v: 'side', t: '左右', hint: '译文排在原文右侧（原文短时同排）' },
      { v: 'src', t: '仅原文', hint: '隐藏译文行' },
      { v: 'tly', t: '仅译文', hint: '只看译文，译文按原文字号显示' }
    ], dualNow, function (v) {
      saveKey('dual', v);
      applyLyrStyle();
      rerenderAllLyr(); // 仅译文为结构级变更，三处容器统一重建
    });
    /* ---- V4.4：当前行跟随位置（偏上/居中/偏下） ---- */
    var posNow = imm ? (S.immLyrPos || 'upper') : (S.lyrPos || 'upper');
    segRow('跟随位置', [
      { v: 'upper', t: '偏上', hint: '当前行靠视口上方，下方显示更多后续歌词（默认）' },
      { v: 'center', t: '居中', hint: '当前行始终在视口中央' },
      { v: 'lower', t: '偏下', hint: '当前行靠视口下方，上方显示更多歌词' }
    ], posNow, function (v) {
      saveKey('lyrpos', v);
      applyLyrStyle();
      tickLyrics(); // 立即按新比例重新定位
    });
    // 面板封面开关仅主界面面板有（沉浸模式无此结构）
    if (!imm) {
      var rowC = el('div', 'am-pop-row');
      rowC.appendChild(el('span', null, '面板封面'));
      var bCover = el('button', 'am-tbtn', S.lyrCoverOn !== false ? '开' : '关');
      bCover.title = '在歌词面板顶部显示当前播放曲目的封面（默认打开）';
      bCover.onclick = function () {
        var on = !(S.lyrCoverOn !== false);
        bCover.textContent = on ? '开' : '关';
        try { localStorage.setItem('annieplayer.am.lyrcover', on ? '1' : '0'); } catch (e) { }
        applyLyrStyle();
      };
      rowC.appendChild(bCover);
      pop.appendChild(rowC);
    }
    // V3.5.15：歌词偏移微调（±0.5s，按曲记忆；时间轴校准，不属于外观，两处共享）
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
  function buildLyrInto(box, wordLimit) {
    var isImm = box === R.immLyrBox;
    // 默认按容器身份选词数/双语布局：沉浸歌词用独立配置，其余（迷你等）跟随主界面
    if (wordLimit == null) wordLimit = isImm ? (S.immLyrWordLimit | 0) : (S.lyrWordLimit | 0);
    var dual = isImm ? (S.immLyrDual || 'row') : (S.lyrDual || 'row');
    box.innerHTML = '';
    if (!S.lyrLines.length) {
      box.appendChild(el('div', 'am-lyr-empty', !state.currentPath ? '播放歌曲以显示歌词' : (state.currentStream ? '歌词加载中…' : '暂无歌词')));
      return;
    }
    S.lyrLines.forEach(function (l, i) {
      box.appendChild(buildLyrLineEl(l, i, 'am-lyr-line', wordLimit, dual));
    });
    fitLyrLines(box);
    var initRate = isImm ? lyrPosRate(S.immLyrPos, 0.35) : 0.4;
    paintLyrBox(box, S.lyrCur, initRate);
    // V4.1：整组重建时逐行浮入（重放 class 触发动画）
    box.classList.remove('am-lyr-fresh'); void box.offsetWidth; box.classList.add('am-lyr-fresh');
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
    // V4.4.2：用户手动翻看期间不强制回滚（高亮/逐字照常更新，与主界面同口径）
    if (cur >= 0 && nodes[cur] && !lyrManualActive(box)) progScrollTop(box, nodes[cur].offsetTop - box.clientHeight * rate);
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
