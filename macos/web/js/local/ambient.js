/* ============================================================
 * 氛围模式（V3.5.18）：全屏频谱——复用引擎 FFT 32 频段做全屏可视化。
 * 入口：AM 主题点击底部频谱条 / 设置中心「氛围模式」/ Ctrl+Shift+V；
 * 退出：ESC 或单击空白处。颜色实时跟随强调色。
 * ============================================================ */
(function () {
  let mask = null, cv = null, ctx = null, raf = 0, onResize = null;
  const target = new Float32Array(32);
  const cur = new Float32Array(32);
  let accent = '#fac900', accentAt = 0, infoAt = 0, elTitle = null, elArtist = null;

  window.mine.onEngineEvent((ev, d) => {
    if (ev === 'spectrum' && d && d.bands) { for (let i = 0; i < 32; i++) target[i] = d.bands[i] || 0; }
  });

  function accentNow() {
    if (performance.now() - accentAt > 1000) {
      accentAt = performance.now();
      accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#fac900';
    }
    return accent;
  }

  function sizeCanvas() {
    if (!mask || !cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(mask.clientWidth * dpr);
    cv.height = Math.round(mask.clientHeight * 0.62 * dpr);
  }

  function loop() {
    if (!mask) return;
    raf = requestAnimationFrame(loop);
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const n = 32, bw = w / n, ac = accentNow();
    const idle = !window.state || !state.playing;
    for (let i = 0; i < n; i++) {
      cur[i] += (target[i] - cur[i]) * 0.3;
      if (idle) cur[i] *= 0.94; // 暂停/停止时缓降归零，不留死帧
      const bh = Math.max(2, cur[i] * h * 0.86);
      const x = i * bw + bw * 0.18, ww = bw * 0.64;
      const g = ctx.createLinearGradient(0, h - bh, 0, h);
      g.addColorStop(0, ac); g.addColorStop(1, ac + '22');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.roundRect(x, h - bh, ww, bh, Math.min(6, ww / 2)); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.75)'; // 峰值顶帽
      ctx.beginPath(); ctx.roundRect(x, h - bh, ww, Math.max(2, h * 0.004), 2); ctx.fill();
    }
    // 曲目信息 500ms 刷新一次（切歌跟随）
    if (performance.now() - infoAt > 500) {
      infoAt = performance.now();
      const t = document.getElementById('thumb-title'), a = document.getElementById('thumb-artist');
      if (elTitle && t) elTitle.textContent = t.textContent;
      if (elArtist && a) elArtist.textContent = a.textContent;
    }
  }

  function open() {
    if (mask) return;
    mask = document.createElement('div');
    mask.className = 'amb-mask';
    const info = document.createElement('div');
    info.className = 'amb-info';
    elTitle = document.createElement('div'); elTitle.className = 'amb-title';
    elArtist = document.createElement('div'); elArtist.className = 'amb-artist';
    info.appendChild(elTitle); info.appendChild(elArtist);
    const hint = document.createElement('div');
    hint.className = 'amb-hint'; hint.textContent = 'ESC 或单击退出';
    cv = document.createElement('canvas'); cv.className = 'amb-canvas';
    mask.appendChild(info); mask.appendChild(cv); mask.appendChild(hint);
    mask.addEventListener('click', close);
    document.body.appendChild(mask);
    ctx = cv.getContext('2d');
    sizeCanvas();
    onResize = sizeCanvas;
    window.addEventListener('resize', onResize);
    loop();
  }

  function close() {
    if (!mask) return;
    cancelAnimationFrame(raf);
    if (onResize) window.removeEventListener('resize', onResize);
    onResize = null;
    mask.remove(); mask = null; cv = null; ctx = null; elTitle = null; elArtist = null;
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') close();
    else if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      if (mask) close(); else open();
    }
  });

  window.annieAmbient = { open, close, toggle: () => (mask ? close() : open()) };
})();
