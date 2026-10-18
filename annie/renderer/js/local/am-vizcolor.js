/* ============================================================
 * V4.3.17：AM 频谱条封面取色（window.amVizColor）
 * 48×48 缩样 → 12 色相桶统计 → 主色/强调色/多色板。
 * 本地封面是 dataURL（canvas 安全）；在线封面走 crossOrigin=anonymous，
 * CDN 不回 CORS 头时 getImageData 抛错 → 返回 null，调用方回落强调色。
 * 黑白/低彩封面（彩色像素占比 < 6%）返回中性灰阶（偏亮，深色条上依然清晰）；无图像才返回 null。
 * ============================================================ */
(function () {
  'use strict';
  var SIZE = 48;
  var LS_KEY = 'annieplayer.am.vizweight2';
  function weightMode() { try { return localStorage.getItem(LS_KEY) || 'area'; } catch (e) { return 'area'; } }
  var cache = {};          // url|mode -> palette | null | 'pending'
  var waiters = {};        // url -> [cb]
  var cacheOrder = [];     // FIFO 上限 60
  var cv = null, cx = null;

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h, s: s, l: l };
  }
  function css(r, g, b) { return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')'; }

  function analyzePixels(data) {
    var NB = 12, buckets = [], i;
    for (i = 0; i < NB; i++) buckets.push({ r: 0, g: 0, b: 0, w: 0, h: i / NB });
    var colorful = 0, total = 0, lumSum = 0;
    for (i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      total++;
      lumSum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      var hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      if (hsl.l < 0.08 || hsl.l > 0.94) continue; // V4.4.8：只排除死黑/纯白，浅色也参与
      if (hsl.s >= 0.12) colorful++;
      var b = buckets[Math.min(NB - 1, Math.floor(hsl.h * NB))];
      /* V4.4.8：权重偏向冷色——青/蓝 1.0，绿 0.7，黄与红粉橙 0.25 */
      var cool = hsl.h >= 0.45 && hsl.h <= 0.72 ? 1.0
               : (hsl.h >= 0.25 && hsl.h < 0.45 ? 0.70
               : (hsl.h > 0.72 && hsl.h <= 0.82 ? 0.55 : 0.25));
      var wgt = (0.06 + hsl.s) * (1 - Math.abs(hsl.l - 0.5)) * cool;
      b.r += data[i] * wgt; b.g += data[i + 1] * wgt; b.b += data[i + 2] * wgt; b.w += wgt;
    }
    if (!total) return null; if (colorful / total < 0.06) {
      /* V4.4.8：纯白/黑白封面——按平均亮度给浅灰，频谱另用压暗版，避免浅到看不见 */
      var lum = lumSum / total;
      var nl = Math.max(96, Math.min(236, Math.round(96 + lum * 0.55)));
      var vz = Math.max(120, Math.min(200, Math.round(120 + lum * 0.30)));
      return {
        primary: 'rgb(' + nl + ',' + nl + ',' + nl + ')',
        accent: 'rgb(' + ((nl * 0.86) | 0) + ',' + ((nl * 0.86) | 0) + ',' + ((nl * 0.86) | 0) + ')',
        stops: ['rgb(' + Math.min(255, (nl + 14)) + ',' + Math.min(255, (nl + 14)) + ',' + Math.min(255, (nl + 14)) + ')',
                'rgb(' + ((nl * 0.88) | 0) + ',' + ((nl * 0.88) | 0) + ',' + ((nl * 0.88) | 0) + ')',
                'rgb(' + ((nl * 0.62) | 0) + ',' + ((nl * 0.62) | 0) + ',' + ((nl * 0.62) | 0) + ')'],
        vizPrimary: 'rgb(' + vz + ',' + vz + ',' + vz + ')',
        vizAccent: 'rgb(' + ((vz * 0.8) | 0) + ',' + ((vz * 0.8) | 0) + ',' + ((vz * 0.8) | 0) + ')',
        mono: true
      };
    } // 黑白封面→中性灰；无图像才回落主题色
    var list = buckets.filter(function (b) { return b.w > 0; })
      .map(function (b) { return { r: b.r / b.w, g: b.g / b.w, b: b.b / b.w, w: b.w, h: b.h }; })
      .sort(function (a, b) { return b.w - a.w; });
    if (!list.length) return null;
    // 多色板：按权重取前 5，按色相排序（渐变过渡更顺滑），相邻色相太近的合并掉
    var stops = list.slice(0, 5).sort(function (a, b) { return a.h - b.h; })
      .filter(function (c, idx, arr) { return idx === 0 || Math.abs(c.h - arr[idx - 1].h) > 0.06; })
      .map(function (c) { return css(c.r, c.g, c.b); });
    // 强调色：权重前 3 里取最鲜艳的
    var acc = list.slice(0, 3)
      .map(function (c) { var s = rgbToHsl(c.r, c.g, c.b); return { c: c, score: s.s * (1 - Math.abs(s.l - 0.55)) }; })
      .sort(function (a, b) { return b.score - a.score; })[0].c;
    /* V4.4.8：深色封面别直接取黑——优先用其中最鲜艳的元素色（深粉/紫等），
       并把它提到可用亮度，否则搜索框/索引条会是一块发黑的颜色 */
    function pickVivid(c) {
      var s0 = rgbToHsl(c.r, c.g, c.b);
      return { c: c, score: s0.s * (1 - Math.abs(s0.l - 0.55)) };
    }
    var base = list[0];
    var bl = rgbToHsl(base.r, base.g, base.b).l;
    if (bl < 0.34) {
      var vivid = list.slice(0, 6).map(pickVivid)
        .filter(function (x) { return rgbToHsl(x.c.r, x.c.g, x.c.b).l > 0.28; })
        .sort(function (a, b) { return b.score - a.score; })[0];
      if (vivid) base = vivid.c;
    }
    // 提亮：保证主色亮度不低于 0.52（深色封面的元素色往往也很暗）
    var bh = rgbToHsl(base.r, base.g, base.b);
    var lift = bh.l < 0.44 ? (0.44 - bh.l) / (1 - bh.l) : 0;
    var pr = base.r + (255 - base.r) * lift;
    var pg = base.g + (255 - base.g) * lift;
    var pb = base.b + (255 - base.b) * lift;
    return {
      vizUi: (function () {
        var _h = rgbToHsl(pr, pg, pb);
        /* 主色偏浅且饱和度一般 → 说明是浅底封面，改取「最暖的一条色板」
           （通常是人物发色/肤色），避免搜索框整块发蓝 */
        if (stops && stops.length) {
          var best = null, bs = -1e9;
          stops.forEach(function (s2) {
            var m2 = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s2);
            if (!m2) return;
            var rr = +m2[1], gg = +m2[2], bb = +m2[3];
            var warm = (rr - bb) * 0.9 + (rr - gg) * 0.4;
            if (warm > bs) { bs = warm; best = s2; }
          });
          if (best && bs > 12) {
            var _b2 = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(best);
            if (_b2) {
              var _bl = rgbToHsl(+_b2[1], +_b2[2], +_b2[3]).l;
              if (_bl > 0.30) return best;   // 太暗的“最暖色”不用
            }
          }
        }
        return _h.l > 0.72 ? css(acc.r, acc.g, acc.b) : css(pr, pg, pb);
      })(),
      primary: css(pr, pg, pb),
      accent: css(acc.r, acc.g, acc.b),
      stops: stops
    };
  }

  function settle(url, pal) {
    cache[url] = pal;
    cacheOrder.push(url);
    if (cacheOrder.length > 60) { var old = cacheOrder.shift(); delete cache[old]; }
    (waiters[url] || []).forEach(function (cb) { try { cb(pal); } catch (e) {} });
    delete waiters[url];
  }

  window.amVizColor = {
    /** setWeight('cool'|'warm'|'area')：切换权重并清空取色缓存 */
    setWeight: function (m) {
      if (m !== 'cool' && m !== 'warm' && m !== 'area') return;
      try { localStorage.setItem(LS_KEY, m); } catch (e) { }
      cache = {}; cacheOrder.length = 0; waiters = {};
    },
    weight: function () { return weightMode(); },
    /** analyze(url, cb)：cb(palette|null)，palette = { primary, accent, stops[] } */
    analyze: function (url, cb) {
      if (!url) { cb(null); return; }
      url = url + '|' + weightMode();
      if (cache[url] !== undefined && cache[url] !== 'pending') { cb(cache[url]); return; }
      if (cache[url] === 'pending') { (waiters[url] = waiters[url] || []).push(cb); return; }
      cache[url] = 'pending'; waiters[url] = [cb];
      var img = new Image();
      img.crossOrigin = 'anonymous';
      var done = false;
      // V4.4.6：瞬时失败（超时/加载失败/canvas 异常）不写入缓存——下次 analyze 重新尝试。
      // 此前 settle(url, null) 会把失败永久缓存，大图在启动卡顿期间超时后整局无封面色。
      function failTransient(reason) {
        if (done) return; done = true;
        console.warn('[vizcolor] 取色失败（下轮重试）:', reason);
        delete cache[url];
        (waiters[url] || []).forEach(function (cb) { try { cb(null); } catch (e) {} });
        delete waiters[url];
      }
      img.onload = function () {
        if (done) return; done = true;
        try {
          if (!cv) { cv = document.createElement('canvas'); cv.width = SIZE; cv.height = SIZE; cx = cv.getContext('2d', { willReadFrequently: true }); }
          cx.clearRect(0, 0, SIZE, SIZE);
          cx.drawImage(img, 0, 0, SIZE, SIZE);
          settle(url, analyzePixels(cx.getImageData(0, 0, SIZE, SIZE).data)); // 分析结果 null（黑白封面）仍缓存——那是稳定结论
        } catch (e) { failTransient('canvas: ' + (e && e.message)); } // canvas 被污染（CORS）
      };
      img.onerror = function () { failTransient('img.onerror'); };
      img.src = url.split('|')[0];
      setTimeout(function () { failTransient('超时8s'); }, 8000); // 慢图兜底
    }
  };
})();
