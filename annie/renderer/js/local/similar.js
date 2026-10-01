/* ============================================================
 * V4.3.16：相似歌曲推荐（零云端纯本地）。
 * 特征：BPM（music-tempo，metaCache.bpm）+ 响度（ebur128 LUFS）+ 流派
 * + 播放统计口味；半速/倍速等价（120≈60）；同艺术家/同专辑多样性惩罚。
 * 入口：AM 行 ⊕ 菜单 / FB2K 右键「找相似歌曲」；结果弹层复用 lsr-* 样式。
 * ============================================================ */
(function () {
  'use strict';

  function meta(p) { return (window.state && state.library.metaCache && state.library.metaCache[p]) || {}; }
  function statsOf(p) { return (window.state && state.library.stats && state.library.stats[p]) || null; }

  /* BPM 距离：半速/倍速等价，取最小差 */
  function bpmDist(a, b) {
    if (!(a > 0) || !(b > 0)) return null;
    return Math.min(Math.abs(a - b), Math.abs(a - b * 2), Math.abs(a * 2 - b)) / Math.max(a, b);
  }

  /* 打分：可用特征加权平均（缺特征的特征不参与，权重重归一化），再乘多样性惩罚 */
  function score(seed, cand, artistTaste) {
    var sm = meta(seed.path), cm = meta(cand.path);
    var parts = [], wsum = 0;
    var bd = bpmDist(sm.bpm, cm.bpm);
    if (bd != null) { parts.push([Math.max(0, 1 - bd / 0.25), 0.45]); wsum += 0.45; }
    var si = sm.loudness && sm.loudness.i, ci = cm.loudness && cm.loudness.i;
    if (typeof si === 'number' && typeof ci === 'number') { parts.push([Math.max(0, 1 - Math.abs(si - ci) / 12), 0.25]); wsum += 0.25; }
    if (sm.genre && cm.genre) { parts.push([sm.genre.toLowerCase() === cm.genre.toLowerCase() ? 1 : 0, 0.15]); wsum += 0.15; }
    var taste = cm.artist && artistTaste[cm.artist] ? Math.min(1, artistTaste[cm.artist] / 20) : 0;
    parts.push([taste, 0.15]); wsum += 0.15;
    if (!wsum) return 0;
    var s = parts.reduce(function (acc, p) { return acc + p[0] * p[1]; }, 0) / wsum;
    if (sm.artist && cm.artist && sm.artist === cm.artist) s *= 0.7;  // 同艺术家降权（多样性）
    if (sm.album && cm.album && sm.album === cm.album) s *= 0.5;      // 同专辑再降
    return s;
  }

  /* 找相似：seedPath → [{ t, score }][n] */
  function similarTo(seedPath, n) {
    var lib = window.state && state.library;
    if (!lib) return [];
    var seed = lib.tracks.find(function (t) { return t.path === seedPath; });
    if (!seed) return [];
    // 艺术家口味表（与每日推荐同源：播放统计聚合，封顶 20）
    var artistTaste = {};
    var stats = lib.stats || {};
    Object.keys(stats).forEach(function (p) {
      var st = stats[p];
      if (!st || !st.count) return;
      var a = meta(p).artist;
      if (a) artistTaste[a] = (artistTaste[a] || 0) + st.count;
    });
    return lib.tracks
      .filter(function (t) { return t.path !== seedPath; })
      .map(function (t) { return { t: t, score: score(seed, t, artistTaste) }; })
      .filter(function (x) { return x.score > 0.05; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, n || 20);
  }

  /* ---------------- 结果弹层（复用 lsr-* 样式） ---------------- */
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function fmtMeta(p) {
    var mc = meta(p);
    var chips = [];
    if (mc.bpm > 0) chips.push(Math.round(mc.bpm) + ' BPM');
    if (mc.loudness && typeof mc.loudness.i === 'number') chips.push(mc.loudness.i.toFixed(1) + ' LUFS');
    if (mc.genre) chips.push(mc.genre);
    return chips.join(' · ');
  }

  async function open(seedPath) {
    var lib = window.state && state.library;
    if (!lib) return;
    var seed = lib.tracks.find(function (t) { return t.path === seedPath; });
    if (!seed) return;
    var sm = meta(seedPath);

    var mask = el('div', 'lsr-mask');
    var panel = el('div', 'lsr-panel');
    panel.style.maxWidth = '640px';
    panel.appendChild(el('div', 'lsr-title', '找相似歌曲'));
    panel.appendChild(el('div', 'lsr-summary', '与「' + (sm.title || seedPath) + ' - ' + (sm.artist || '') + '」相似的曲目（BPM/响度/流派/口味综合）'));
    var body = el('div', 'lsr-summary', '分析中…');
    body.style.maxHeight = '46vh'; body.style.overflowY = 'auto'; body.style.textAlign = 'left';
    panel.appendChild(body);
    var btns = el('div', 'lsr-btns');
    panel.appendChild(btns);
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    mask.appendChild(panel);
    document.body.appendChild(mask);

    // 种子缺 BPM 时先即时补算（单曲几秒），否则直接打分
    if (!(sm.bpm > 0) && seedPath.indexOf('#cue') < 0 && seedPath.indexOf('#iso') < 0 && !/^https?:/i.test(seedPath)) {
      body.textContent = '正在分析种子曲目节奏…';
      var bpm = await window.annieRhythm.analyzeTrack(seedPath);
      if (bpm > 0) {
        sm.bpm = Math.round(bpm * 10) / 10;
        try { window.mine.bpmSet(((function () { var o = {}; o[seedPath] = sm.bpm; return o; })())); } catch (e) { }
      }
    }

    var results = similarTo(seedPath, 20);
    body.textContent = '';
    if (!results.length) { body.textContent = '曲库里没有找到相似曲目（先跑一遍「设置 → 曲库工具 → 节奏/响度补算」效果更好）'; }

    var listTracks = results.map(function (r) { return r.t; });
    results.forEach(function (r) {
      var m = meta(r.t.path);
      var row = el('div', 'sls-field');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(127,127,127,.12)';
      var info = el('div', '', (m.title || r.t.path) + ' - ' + (m.artist || '未知艺术家'));
      info.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      info.title = fmtMeta(r.t.path);
      var sub = el('div', 'set-hint', fmtMeta(r.t.path));
      sub.style.cssText = 'flex:0 0 auto;font-size:11px';
      var pct = el('span', '', Math.round(r.score * 100) + '%');
      pct.style.cssText = 'flex:0 0 auto;min-width:38px;text-align:right;opacity:.75';
      var btnPlay = el('button', 'btn-ghost', '▶');
      btnPlay.style.padding = '2px 8px';
      btnPlay.onclick = function () {
        state.queue = listTracks.slice();
        if (typeof playAt === 'function') playAt(listTracks.indexOf(r.t));
        mask.remove();
      };
      var btnNext = el('button', 'btn-ghost', '＋');
      btnNext.title = '下一首播放';
      btnNext.style.padding = '2px 8px';
      btnNext.onclick = function () {
        state.queue.splice(state.index + 1, 0, r.t); // 插在当前之后，index 不受影响
        btnNext.textContent = '✓';
      };
      var left = el('div', ''); left.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:1px';
      left.appendChild(info); left.appendChild(sub);
      row.appendChild(left); row.appendChild(pct); row.appendChild(btnPlay); row.appendChild(btnNext);
      body.appendChild(row);
    });

    if (results.length) {
      var btnAll = el('button', 'btn-ghost', '全部播放');
      btnAll.onclick = function () {
        state.queue = listTracks.slice();
        if (typeof playAt === 'function') playAt(0);
        mask.remove();
      };
      var btnSave = el('button', 'btn-ghost', '存为播放列表');
      btnSave.onclick = function () {
        window.anniePrompt('播放列表名称', '相似 ' + (sm.title || ''), async function (name) {
          btnSave.disabled = true;
          try { await window.annieSmart.saveAsPlaylist(name, listTracks); btnSave.textContent = '已保存 ✓'; }
          catch (e) { btnSave.textContent = '保存失败'; }
          btnSave.disabled = false;
          setTimeout(function () { btnSave.textContent = '存为播放列表'; mask.remove(); }, 1500);
        });
      };
      btns.appendChild(btnAll); btns.appendChild(btnSave);
    }
    var btnClose = el('button', 'btn-ghost', '关闭');
    btnClose.onclick = function () { mask.remove(); };
    btns.appendChild(btnClose);
  }

  window.annieSimilar = { similarTo: similarTo, open: open };
})();
