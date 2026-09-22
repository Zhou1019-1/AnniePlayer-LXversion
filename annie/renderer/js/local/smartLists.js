/* ============================================================
 * 智能歌单 + 每日推荐（V3.5.19）
 * 完全离线的曲库智能：
 *  - query(rule)：规则查询（艺术家/专辑/流派/播放次数/最近播放/仅无损）
 *  - dailyMix(n)：每日推荐——种子 = 当天日期（同日结果稳定），
 *    60% 艺术家偏好（近 90 天播放统计）+ 40% 随机探索，排除今天已播
 * 生成结果可「生成并播放」或存为自建播放列表（主进程存储，三主题共享）。
 * ============================================================ */
(function () {
  function meta(p) {
    return (window.state && state.library.metaCache && state.library.metaCache[p]) || {};
  }
  function statsOf(p) {
    return (window.state && state.library.stats && state.library.stats[p]) || null;
  }

  /* rule: { artist, album, genre, minPlays, withinDays, losslessOnly }（空条件不约束） */
  function query(rule) {
    const tracks = (window.state && state.library.tracks) || [];
    const now = Date.now();
    return tracks.filter(t => {
      const m = meta(t.path);
      if (rule.artist && !(m.artist || '').toLowerCase().includes(rule.artist.toLowerCase())) return false;
      if (rule.album && !(m.album || '').toLowerCase().includes(rule.album.toLowerCase())) return false;
      if (rule.genre && !(m.genre || '').toLowerCase().includes(rule.genre.toLowerCase())) return false;
      if (rule.losslessOnly && !/\.(flac|ape|wav|aiff?|dsf|dff|wv|tak|mka)$/i.test(t.path)) return false;
      const st = statsOf(t.path);
      if (rule.minPlays > 0 && (!st || (st.count || 0) < rule.minPlays)) return false;
      if (rule.withinDays > 0 && (!st || !st.lastPlayed || now - st.lastPlayed > rule.withinDays * 86400000)) return false;
      return true;
    });
  }

  function dailyMix(count) {
    count = count || 30;
    const tracks = (window.state && state.library.tracks) || [];
    if (!tracks.length) return [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    // 艺术家偏好分（播放统计累计次数，封顶 20 防一家独大）
    const artistScore = {};
    const stats = state.library.stats || {};
    Object.keys(stats).forEach(p => {
      const st = stats[p];
      if (!st || !st.count) return;
      const m = meta(p);
      if (m.artist) artistScore[m.artist] = (artistScore[m.artist] || 0) + st.count;
    });
    // 种子随机（mulberry32，种子来自日期 → 同一天结果稳定）
    let seed = 0; const ds = today.toDateString();
    for (let i = 0; i < ds.length; i++) seed = (seed * 31 + ds.charCodeAt(i)) >>> 0;
    const rnd = () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const todayStart = today.getTime();
    const pool = tracks.filter(t => {
      const st = statsOf(t.path);
      return !st || !st.lastPlayed || st.lastPlayed < todayStart; // 排除今天已播
    });
    const scored = pool.map(t => {
      const m = meta(t.path);
      const af = m.artist && artistScore[m.artist] ? Math.min(1, artistScore[m.artist] / 20) : 0;
      return { t, score: af * 0.6 + rnd() * 0.4 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, count).map(x => x.t);
  }

  /* 存为自建播放列表（返回新列表 id；playlistCreate 返回的是全量数组） */
  async function saveAsPlaylist(name, tracks) {
    const before = await window.mine.playlists();
    const after = await window.mine.playlistCreate(name);
    const pl = (after || []).find(p => !(before || []).some(b => b.id === p.id)) || (after || [])[after.length - 1];
    if (!pl) throw new Error('创建播放列表失败');
    await window.mine.playlistAdd(pl.id, tracks.map(t => t.path));
    return pl.id;
  }

  function playTracks(tracks) {
    if (!tracks.length || !window.state) return;
    state.queue = tracks.slice();
    if (typeof playAt === 'function') playAt(0);
  }

  /* ---------------- 生成器弹层（设置中心入口） ---------------- */
  function openBuilder() {
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const mask = mk('div', 'lsr-mask');
    const panel = mk('div', 'lsr-panel');
    panel.appendChild(mk('div', 'lsr-title', '智能歌单生成器'));
    panel.appendChild(mk('div', 'lsr-summary', '按规则从本地曲库筛选，生成并播放或存为播放列表（条件留空 = 不约束）'));

    const fields = {};
    const defs = [
      ['artist', '艺术家包含', '如：周杰伦'],
      ['album', '专辑包含', '如：范特西'],
      ['genre', '流派包含', '如：Rock'],
      ['minPlays', '播放次数 ≥', '0 = 不限'],
      ['withinDays', '最近 N 天内播放过', '0 = 不限'],
    ];
    const form = mk('div', 'sls-form');
    defs.forEach(d => {
      const row = mk('div', 'sls-field');
      row.appendChild(mk('label', 'sls-label', d[1]));
      const inp = document.createElement('input');
      inp.className = 'sls-input';
      inp.placeholder = d[2];
      if (d[0] === 'minPlays' || d[0] === 'withinDays') { inp.type = 'number'; inp.min = 0; }
      row.appendChild(inp);
      form.appendChild(row);
      fields[d[0]] = inp;
    });
    const lossRow = mk('label', 'sls-field sls-loss');
    const lossChk = document.createElement('input'); lossChk.type = 'checkbox';
    lossRow.appendChild(lossChk); lossRow.appendChild(mk('span', '', '仅无损格式（FLAC/APE/WAV/DSD 等）'));
    form.appendChild(lossRow);
    panel.appendChild(form);

    const countEl = mk('div', 'lsr-summary', '');
    panel.appendChild(countEl);
    function preview() {
      const n = query(readRule()).length;
      countEl.textContent = '匹配 ' + n + ' 首';
    }
    function readRule() {
      return {
        artist: fields.artist.value.trim(),
        album: fields.album.value.trim(),
        genre: fields.genre.value.trim(),
        minPlays: +fields.minPlays.value || 0,
        withinDays: +fields.withinDays.value || 0,
        losslessOnly: lossChk.checked,
      };
    }
    Object.keys(fields).forEach(k => { fields[k].oninput = preview; });
    lossChk.onchange = preview;
    preview();

    const btns = mk('div', 'lsr-btns');
    const btnPlay = mk('button', 'btn-ghost', '生成并播放');
    btnPlay.onclick = function () {
      const list = query(readRule());
      if (!list.length) { countEl.textContent = '没有匹配的曲目'; return; }
      playTracks(list);
      mask.remove();
    };
    const btnSave = mk('button', 'btn-ghost', '存为播放列表');
    btnSave.onclick = async function () {
      const list = query(readRule());
      if (!list.length) { countEl.textContent = '没有匹配的曲目'; return; }
      const name = prompt('播放列表名称', '智能歌单 ' + new Date().toLocaleDateString());
      if (!name) return;
      btnSave.disabled = true;
      try {
        await saveAsPlaylist(name, list);
        btnSave.textContent = '已保存 ✓';
      } catch (e) { btnSave.textContent = '保存失败'; }
      btnSave.disabled = false;
      setTimeout(function () { btnSave.textContent = '存为播放列表'; }, 3000);
    };
    const btnClose = mk('button', 'btn-ghost', '关闭');
    btnClose.onclick = function () { mask.remove(); };
    btns.appendChild(btnPlay); btns.appendChild(btnSave); btns.appendChild(btnClose);
    panel.appendChild(btns);
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    mask.appendChild(panel);
    document.body.appendChild(mask);
  }

  window.annieSmart = { query, dailyMix, saveAsPlaylist, playTracks, openBuilder };
})();
