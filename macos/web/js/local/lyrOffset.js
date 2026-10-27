'use strict';
/* V3.5.15：歌词偏移微调（按曲记忆）。
 * 单一 Store（localStorage annieplayer.lyroffset：{ path: 秒 }），AM 面板 / FB2K 侧栏 / 桌面歌词三处共用。
 * 语义：effectivePos = pos + off(path)。歌词偏慢（声音先到）按 + 提前歌词；偏快按 −。
 * 步进 0.5s，范围 ±30s；未设置的曲目偏移为 0。 */
(function () {
  var LS_KEY = 'annieplayer.lyroffset';
  var map = {};
  try { map = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { map = {}; }

  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch (e) { }
  }
  function normKey(path) {
    // CUE/ISO 虚拟分轨共享同一文件的歌词偏移（同一份 LRC）
    if (!path) return '';
    var i = path.indexOf('#cue'); if (i > 0) return path.slice(0, i);
    var j = path.indexOf('#iso'); if (j > 0) return path.slice(0, j);
    return path;
  }

  window.annieLyrOff = {
    get: function (path) { return +map[normKey(path)] || 0; },
    set: function (path, sec) {
      var k = normKey(path); if (!k) return 0;
      var v = Math.max(-30, Math.min(30, Math.round((+sec || 0) * 2) / 2));
      if (v === 0) delete map[k]; else map[k] = v;
      persist();
      return v;
    },
    adjust: function (path, delta) { return window.annieLyrOff.set(path, window.annieLyrOff.get(path) + delta); },
    /** 应用偏移后的歌词有效播放位置（秒） */
    pos: function (path, pos) { return (+pos || 0) + window.annieLyrOff.get(path); },
    fmt: function (sec) {
      if (!sec) return '0.0s';
      return (sec > 0 ? '+' : '') + sec.toFixed(1) + 's';
    }
  };
})();
