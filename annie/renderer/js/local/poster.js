'use strict';
/* V4.3.19：歌词海报生成（新脑暴 C）——竖版 1080×1620。
 * 美工参照用户提供的横版播放器截图：封面虚化作暖色底 + 封面圆角卡片 + 标题/演唱者 + 音质徽标 + 柔化歌词节选。
 * 必带信息：封面 / 歌名 / 演唱者 / 节选歌词（当前行高亮）/ 音质徽标 / 安妮播放器版本号。
 * 入口：AM 歌曲行 ⊕ 菜单「生成歌词海报」（仅当前播放且有歌词的行显示）；导出走 a.download（预设包同款落盘姿势）。 */
(function () {
  var W = 1080, H = 1620;

  function el(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }

  function loadImg(src) {
    return new Promise(function (resolve) {
      if (!src) return resolve(null);
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { resolve(null); };
      im.src = src;
    });
  }

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, maxW) {
    text = String(text || '');
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }

  function accent() {
    try {
      var root = document.getElementById('am-root') || document.documentElement;
      var v = getComputedStyle(root).getPropertyValue('--am-accent').trim();
      return v || '#fa2d55';
    } catch (e) { return '#fa2d55'; }
  }

  async function open(trackPath) {
    var AM = window.__annieAMInternal || {};
    var S = AM.S || {};
    var m = (S.meta && S.meta[trackPath]) || {};
    var title = (m && !m.fail && m.title) || String(trackPath || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    var artist = (m && !m.fail && m.artist) || '';
    var album = (m && !m.fail && m.album) || '';

    // 封面：S.cover 缓存 → meta 拉取兜底
    var cover = (S.cover && S.cover[trackPath]) || '';
    if (!cover && window.mine && window.mine.meta) {
      try { var mm = await window.mine.meta(trackPath); cover = (mm && mm.cover) || ''; } catch (e) { }
    }
    // 歌词节选：以当前行为中心取 7 行；非当前播放曲取开头 7 行
    var lines = (S.lyrLines || []).map(function (l) { return { txt: l.txt || l.text || '', tly: l.tly || '' }; })
      .filter(function (l) { return l.txt; });
    var cur = (typeof state !== 'undefined' && state && state.currentPath === trackPath && S.lyrCur >= 0) ? S.lyrCur : -1;
    var picked = [], curInPick = -1;
    if (lines.length) {
      var from = cur >= 0 ? Math.max(0, cur - 3) : 0;
      var to = Math.min(lines.length, from + 7);
      from = Math.max(0, to - 7);
      picked = lines.slice(from, to);
      curInPick = cur >= 0 ? cur - from : -1;
    }
    var fmt = (typeof state !== 'undefined' && state && state.currentPath === trackPath) ? (S.fmt || '') : '';
    var ver = '';
    try { ver = await window.mine.appVersion(); } catch (e) { }
    var acc = accent();
    var img = await loadImg(cover);

    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');

    /* ---- 背景：封面放大铺满 + 强虚化 + 压暗（参考图的暖色氛围底） ---- */
    ctx.fillStyle = '#101014'; ctx.fillRect(0, 0, W, H);
    if (img) {
      ctx.save();
      ctx.filter = 'blur(52px) saturate(1.35) brightness(.62)';
      var s = Math.max(W / img.width, H / img.height) * 1.15;
      ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
      ctx.restore();
    }
    var vg = ctx.createLinearGradient(0, 0, 0, H);
    vg.addColorStop(0, 'rgba(8,9,13,.25)');
    vg.addColorStop(.55, 'rgba(8,9,13,.45)');
    vg.addColorStop(1, 'rgba(8,9,13,.78)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    /* ---- 封面卡片（圆角 + 投影） ---- */
    var CS = 520, cx = (W - CS) / 2, cy = 130;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 60; ctx.shadowOffsetY = 24;
    rr(ctx, cx, cy, CS, CS, 26); ctx.fillStyle = '#1c1c24'; ctx.fill();
    ctx.restore();
    if (img) {
      ctx.save();
      rr(ctx, cx, cy, CS, CS, 26); ctx.clip();
      var cs2 = Math.max(CS / img.width, CS / img.height);
      ctx.drawImage(img, cx + (CS - img.width * cs2) / 2, cy + (CS - img.height * cs2) / 2, img.width * cs2, img.height * cs2);
      ctx.restore();
    }

    /* ---- 标题 / 演唱者·专辑 ---- */
    var y = cy + CS + 88;
    ctx.fillStyle = '#f2f3f7';
    ctx.font = '700 52px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(fitText(ctx, title, W - 160), W / 2, y);
    y += 52;
    ctx.fillStyle = 'rgba(242,243,247,.62)';
    ctx.font = '400 28px "Microsoft YaHei", sans-serif';
    ctx.fillText(fitText(ctx, artist + (album ? ' — ' + album : ''), W - 200), W / 2, y);

    /* ---- 音质徽标（胶囊描边，强调色） ---- */
    if (fmt) {
      y += 58;
      ctx.font = '600 24px "Microsoft YaHei", sans-serif';
      var tw = ctx.measureText(fmt).width, padX = 26, ph = 44, pw = tw + padX * 2;
      rr(ctx, (W - pw) / 2, y - ph + 8, pw, ph, ph / 2);
      ctx.strokeStyle = acc; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = acc;
      ctx.fillText(fmt, W / 2, y);
    }

    /* ---- 歌词节选（当前行强调色加粗，其余柔化，翻译行小字） ---- */
    if (picked.length) {
      y += 74;
      // 歌词区垂直居中于剩余空间
      var blockH = picked.length * 62;
      var ly = Math.max(y, (y + (H - 170)) / 2 - blockH / 2 + 40);
      for (var i = 0; i < picked.length; i++) {
        var L = picked[i];
        var isCur = i === curInPick;
        ctx.fillStyle = isCur ? acc : 'rgba(242,243,247,.55)';
        ctx.font = (isCur ? '700 34px' : '400 30px') + ' "Microsoft YaHei", sans-serif';
        ctx.fillText(fitText(ctx, L.txt, W - 220), W / 2, ly);
        if (L.tly) {
          ly += 36;
          ctx.fillStyle = isCur ? 'rgba(242,243,247,.8)' : 'rgba(242,243,247,.35)';
          ctx.font = '400 20px "Microsoft YaHei", sans-serif';
          ctx.fillText(fitText(ctx, L.tly, W - 260), W / 2, ly);
        }
        ly += 62; // 主行距（翻译行已在行内加排）
      }
    }

    /* ---- 底部署名：安妮播放器 + 版本号 ---- */
    ctx.fillStyle = 'rgba(242,243,247,.45)';
    ctx.font = '400 22px "Microsoft YaHei", sans-serif';
    ctx.fillText('安妮播放器 Annie Player' + (ver ? ' · V' + ver : ''), W / 2, H - 92);
    ctx.fillStyle = acc;
    ctx.font = '600 18px "Microsoft YaHei", sans-serif';
    ctx.fillText('—— 分享自 安妮播放器 ——', W / 2, H - 54);

    /* ---- 导出 PNG ---- */
    cv.toBlob(function (blob) {
      if (!blob) return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '歌词海报-' + (title + (artist ? '-' + artist : '')).replace(/[\\/:*?"<>|]/g, '_') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      try { if (typeof proToast === 'function') proToast('歌词海报已保存'); } catch (e) { }
    }, 'image/png');
  }

  window.anniePoster = { open: open };
})();
