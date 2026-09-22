/* ============================================================
 * 听歌统计 Store（V3.5.17）
 * 本地记录每首歌的播放次数/累计时长、总收听时长、24 小时时段分布，
 * 供设置页「听歌报告」使用。数据仅存 localStorage，不上传。
 * 键与歌词偏移一致：剥离 #cue/#iso 虚拟分轨后缀，整轨与分轨共享统计。
 * ============================================================ */
(function () {
  const KEY = 'annieplayer.listenstats.v1';
  const MAX_SONGS = 800;      // 超出后按最久未播修剪，防 localStorage 膨胀
  let data = load();
  let curKey = null;          // 当前计时曲目
  let lastPos = -1;           // 上一次 position（秒）
  let saveTimer = 0;

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d && d.songs && Array.isArray(d.hours) && d.hours.length === 24) {
        if (!d.days) d.days = {};
        return d;
      }
    } catch (e) { }
    return { totalSec: 0, totalPlays: 0, songs: {}, hours: new Array(24).fill(0), days: {} };
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

  // 曲目开始播放（meta 就绪后调用）
  function recordPlay(path, meta) {
    if (!path) return;
    const k = normKey(path);
    curKey = k; lastPos = -1;
    let s = data.songs[k];
    if (!s) {
      s = data.songs[k] = { title: '', artist: '', album: '', plays: 0, sec: 0, last: 0 };
      prune();
    }
    meta = meta || {};
    s.title = meta.title || s.title || '未知曲目';
    s.artist = meta.artist || s.artist;
    s.album = meta.album || s.album;
    s.plays++; s.last = Date.now();
    data.totalPlays++;
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
    return {
      totalSec: data.totalSec,
      totalPlays: data.totalPlays,
      topSongs: arr.slice().sort((a, b) => b.plays - a.plays || b.sec - a.sec).slice(0, 8),
      topArtists: agg(arr, s => s.artist),
      topAlbums: agg(arr, s => s.album),
      favHour: favSec > 60 ? favHour : -1,   // 不足 1 分钟不显示，避免误导
      days: data.days,                        // V3.5.19：按天秒数（热力图）
    };
  }

  function clear() {
    data = { totalSec: 0, totalPlays: 0, songs: {}, hours: new Array(24).fill(0), days: {} };
    curKey = null; lastPos = -1;
    try { localStorage.removeItem(KEY); } catch (e) { }
  }

  window.annieListenStats = { recordPlay, tick, report, clear };
})();
