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
  var cache = {};          // url -> palette | null | 'pending'
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
    var colorful = 0, total = 0;
    for (i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      total++;
      var hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      if (hsl.s < 0.12 || hsl.l < 0.08 || hsl.l > 0.92) continue; // 灰/死黑/死白不算彩色
      colorful++;
      var b = buckets[Math.min(NB - 1, Math.floor(hsl.h * NB))];
      var wgt = hsl.s * (1 - Math.abs(hsl.l - 0.5)); // 饱和度×中间亮度权重：鲜艳不刺眼的色优先
      b.r += data[i] * wgt; b.g += data[i + 1] * wgt; b.b += data[i + 2] * wgt; b.w += wgt;
    }
    if (!total) return null; if (colorful / total < 0.06) return { primary: 'rgb(228,228,228)', accent: 'rgb(158,158,158)', stops: ['rgb(240,240,240)', 'rgb(196,196,196)', 'rgb(140,140,140)'], mono: true }; // 黑白封面→中性灰；无图像才回落主题色
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
    return {
      primary: css(list[0].r, list[0].g, list[0].b),
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
    /** analyze(url, cb)：cb(palette|null)，palette = { primary, accent, stops[] } */
    analyze: function (url, cb) {
      if (!url) { cb(null); return; }
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
      img.src = url;
      setTimeout(function () { failTransient('超时8s'); }, 8000); // 慢图兜底
    }
  };
})();
