/* ============================================================
 * 听歌统计 Store（V3.5.17，V4.3.24 扩展新维度）
 * 本地记录每首歌的播放次数/累计时长、总收听时长、24 小时时段分布，
 * 跳过/完整播放统计、曲风分布、年度统计。数据仅存 localStorage，不上传。
 * 键与歌词偏移一致：剥离 #cue/#iso 虚拟分轨后缀，整轨与分轨共享统计。
 * ============================================================ */
(function () {
  const KEY = 'annieplayer.listenstats.v1';
  const MAX_SONGS = 800;      // 超出后按最久未播修剪，防 localStorage 膨胀
  let data = load();
  let curKey = null;          // 当前计时曲目
  let lastPos = -1;           // 上一次 position（秒）
  let curSessSec = 0;         // 本次播放会话已听秒数（判定跳过/完整用）
  let curDur = 0;             // 当前曲目总时长（秒，未知为 0）
  let curGenres = [];         // 当前曲目曲风（tick 累计曲风时长用）
  let saveTimer = 0;

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d && d.songs && Array.isArray(d.hours) && d.hours.length === 24) {
        if (!d.days) d.days = {};
        if (!d.genres) d.genres = {};
        if (!d.years) d.years = {};
        if (d.totalSkip == null) d.totalSkip = 0;
        if (d.totalComplete == null) d.totalComplete = 0;
        if (d.totalPartial == null) d.totalPartial = 0;
        return d;
      }
    } catch (e) { }
    return {
      totalSec: 0, totalPlays: 0, songs: {},
      hours: new Array(24).fill(0), days: {},
      genres: {}, years: {},
      totalSkip: 0, totalComplete: 0, totalPartial: 0,
    };
  }
  // 节流落盘：播放中 position 10Hz 调用，最多每 8s 写一次
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { }
    }, 8000);
  }
  function normKey(p) { return String(p || '').replace(/#(cue|iso).*/i, ''); }
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function yearKey(d) { return String((d || new Date()).getFullYear()); }
  // 曲风格式化拆分：支持 ; ； 、 / | 分隔，最多取 3 项
  function splitGenre(g) {
    return String(g || '').split(/[;；、/|]/)
      .map(x => x.trim()).filter(x => x && x.length <= 30).slice(0, 3);
  }
  // 修剪 400 天前的按天记录（热力图只看近半年，长期留存防膨胀）
  function pruneDays() {
    const cutoff = dayKey(new Date(Date.now() - 400 * 86400000));
    Object.keys(data.days).forEach(k => { if (k < cutoff) delete data.days[k]; });
  }

  function prune() {
    const keys = Object.keys(data.songs);
    if (keys.length <= MAX_SONGS) return;
    keys.sort((a, b) => (data.songs[a].last || 0) - (data.songs[b].last || 0));
    for (let i = 0; i < keys.length - MAX_SONGS; i++) delete data.songs[keys[i]];
  }

  /* 会话判定：本次收听属于 complete（完整播放）/ skip（跳过）/ partial（没听完但不算跳）。
   * 标准：已知时长——听到末尾 10s 内或 ≥80% = 完整；≤1/3 = 跳过；之间 = 部分。
   * 未知时长——≥60s = 完整；<20s = 跳过；之间 = 部分。 */
  function classify(sess, dur) {
    if (dur > 0) {
      if (sess >= dur - 10 || sess / dur >= 0.8) return 'complete';
      if (sess / dur <= 0.33) return 'skip';
      return 'partial';
    }
    if (sess >= 60) return 'complete';
    if (sess < 20) return 'skip';
    return 'partial';
  }

  /** 结束上一曲的播放会话（切歌/停止时调用）：累计跳过/完整/部分计数 */
  function finalizeSession() {
    if (!curKey) return;
    const s = data.songs[curKey];
    const kind = classify(curSessSec, curDur);
    if (s) {
      s[kind] = (s[kind] || 0) + 1;
    }
    data[kind === 'complete' ? 'totalComplete' : kind === 'skip' ? 'totalSkip' : 'totalPartial']++;
    curKey = null; curSessSec = 0; curDur = 0; curGenres = [];
    save();
  }

  // 曲目开始播放（meta 就绪后调用）
  function recordPlay(path, meta) {
    if (!path) return;
    if (curKey) finalizeSession(); // 切歌：先给上一曲会话定性
    const k = normKey(path);
    curKey = k; lastPos = -1; curSessSec = 0;
    let s = data.songs[k];
    if (!s) {
      s = data.songs[k] = { title: '', artist: '', album: '', genre: '', plays: 0, sec: 0, last: 0 };
      prune();
    }
    meta = meta || {};
    s.title = meta.title || s.title || '未知曲目';
    s.artist = meta.artist || s.artist;
    s.album = meta.album || s.album;
    s.plays++; s.last = Date.now();
    data.totalPlays++;
    // 曲风：每首播放计入曲风播放次数；时长在 tick 累计
    curGenres = splitGenre(meta.genre);
    if (curGenres.length) {
      s.genre = curGenres[0];
      curGenres.forEach(g => {
        data.genres[g] = data.genres[g] || { plays: 0, sec: 0 };
        data.genres[g].plays++;
      });
    }
    curDur = Number(meta.duration) > 0 ? Number(meta.duration) : 0;
    // 年度统计
    const yk = yearKey();
    data.years[yk] = data.years[yk] || { plays: 0, sec: 0 };
    data.years[yk].plays++;
    save();
  }

  // 引擎 position 事件驱动（10Hz）：累加收听时长。
  // 步长 >0.6s 视为 seek 跳变不计；暂停期间无事件自然停表。
  function tick(pos) {
    if (pos == null) return;
    if (lastPos >= 0) {
      const d = pos - lastPos;
      if (d > 0 && d <= 0.6) {
        data.totalSec += d;
        data.hours[new Date().getHours()] += d;
        const dk = dayKey();
        data.days[dk] = (data.days[dk] || 0) + d;
        if (Object.keys(data.days).length > 410) pruneDays();
        if (curKey && data.songs[curKey]) data.songs[curKey].sec += d;
        curSessSec += d;
        curGenres.forEach(g => { data.genres[g].sec += d; });
        const yk = yearKey();
        data.years[yk].sec += d;
        save();
      }
    }
    lastPos = pos;
  }

  function agg(arr, get) {
    const m = {};
    arr.forEach(s => {
      const k = get(s);
      if (!k) return;
      (m[k] = m[k] || { name: k, plays: 0, sec: 0 });
      m[k].plays += s.plays; m[k].sec += s.sec;
    });
    return Object.values(m).sort((a, b) => b.sec - a.sec).slice(0, 8);
  }

  function report() {
    const arr = Object.values(data.songs);
    let favHour = -1, favSec = 0;
    data.hours.forEach((s, h) => { if (s > favSec) { favSec = s; favHour = h; } });
    const judged = data.totalSkip + data.totalComplete + data.totalPartial;
    return {
      totalSec: data.totalSec,
      totalPlays: data.totalPlays,
      topSongs: arr.slice().sort((a, b) => b.plays - a.plays || b.sec - a.sec).slice(0, 8),
      topArtists: agg(arr, s => s.artist),
      topAlbums: agg(arr, s => s.album),
      favHour: favSec > 60 ? favHour : -1,   // 不足 1 分钟不显示，避免误导
      days: data.days,                        // 按天秒数（热力图）
      // V4.3.24 新维度
      totalSkip: data.totalSkip,
      totalComplete: data.totalComplete,
      totalPartial: data.totalPartial,
      // 比率以已判定会话数为分母（旧版本数据升级初期会话数可能小于总播放数）
      skipRate: judged ? data.totalSkip / judged : 0,
      completeRate: judged ? data.totalComplete / judged : 0,
      genres: Object.entries(data.genres)
        .map(([name, v]) => Object.assign({ name }, v))
        .sort((a, b) => b.sec - a.sec).slice(0, 8),
      years: Object.keys(data.years).sort().map(y => Object.assign({ name: y }, data.years[y])),
    };
  }

  /** 播放完全停止时调用：给当前会话定性（暂停不调，继续听仍算同一会话） */
  function endSession() {
    finalizeSession();
    lastPos = -1;
  }

  function clear() {
    data = {
      totalSec: 0, totalPlays: 0, songs: {}, hours: new Array(24).fill(0), days: {},
      genres: {}, years: {}, totalSkip: 0, totalComplete: 0, totalPartial: 0,
    };
    curKey = null; lastPos = -1; curSessSec = 0; curDur = 0; curGenres = [];
    try { localStorage.removeItem(KEY); } catch (e) { }
  }

  window.annieListenStats = { recordPlay, tick, report, clear, endSession };
})();
