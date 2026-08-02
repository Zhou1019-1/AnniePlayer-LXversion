/* 安妮播放器 —— 视觉适配层（模块之后、player.js 之前加载）
 * 把 AnnieEngine 的播放事实（位置/状态/电平/格式）翻译成 Mineradio 视觉栈
 * 期望的全局环境：
 *   audio    → 假 HTMLAudioElement（currentTime 由引擎 position 事件 + rAF 插值驱动）
 *   analyser → 假 AnalyserNode（频谱由引擎 RMS/Peak 合成）
 *   封面     → applyCoverCanvas / setAlbumBackground / setControlCoverSrc
 *   歌词     → parseLyricText + lyricsLines + invalidateStageLyricPayloadForNewLyrics
 *   节拍     → analyzeAudioBeats（读本地文件字节）+ smoothBeatMapHandoff
 * 对外暴露 window.annieStage。 */

(function () {
  // ================= 假 audio =================
  var annieAudio = {
    currentTime: 0,
    duration: 0,
    paused: true,
    volume: 1,
    muted: false,
    readyState: 4,
    src: '',
    crossOrigin: 'anonymous',
    playbackRate: 1,
    ended: false,
    addEventListener: function () { },
    removeEventListener: function () { },
    dispatchEvent: function () { return true; },
    play: function () { return Promise.resolve(); },
    pause: function () { },
    load: function () { },
    canPlayType: function () { return ''; },
  };

  // 粒子总开关（设置面板可关；playTrack 淡入目标值以此为准）
  var particlesEnabled = true;

  // ================= 假 analyser（引擎电平 → 合成频谱） =================
  var BINS = 1024;
  var spectrumLevel = 0;       // 当前平滑能量
  var spectrumTarget = 0;      // 引擎电平目标能量
  var spectrumKick = 0;        // 能量突增时的低频冲击
  var lastLevelAt = 0;
  var synthBins = new Uint8Array(BINS);
  var synthWave = new Uint8Array(2048);

  function feedLevel(rms, peak) {
    // rms/peak 是 0~1 的 float 域电平；给它一点动态扩张，视觉更灵动
    var energy = Math.min(1, (rms * 1.35 + peak * 0.25));
    if (energy > spectrumTarget + 0.22) spectrumKick = Math.min(1, spectrumKick + (energy - spectrumTarget) * 1.6);
    spectrumTarget = energy;
    lastLevelAt = performance.now();
  }

  function buildSpectrum() {
    var now = performance.now();
    // 引擎电平 ~11Hz 上报；超过 300ms 没新数据视为停播，能量自然衰减
    if (now - lastLevelAt > 300) spectrumTarget *= 0.94;
    // 攻击快、释放慢
    var up = spectrumTarget > spectrumLevel;
    spectrumLevel += (spectrumTarget - spectrumLevel) * (up ? 0.42 : 0.10);
    spectrumKick *= 0.90;

    var t = now * 0.001;
    for (var i = 0; i < BINS; i++) {
      var x = i / BINS;
      // 低频厚重的包络 + 中频驼峰 + 高频空气感
      var shape = Math.exp(-x * 4.2) * 0.95
        + Math.exp(-Math.pow((x - 0.28) * 6.5, 2)) * 0.38
        + Math.exp(-Math.pow((x - 0.8) * 5.0, 2)) * 0.10;
      // 有机的抖动，避免"一条死直线"
      var wob = 0.82
        + 0.10 * Math.sin(t * 5.1 + i * 0.41)
        + 0.08 * Math.sin(t * 11.7 + i * 0.13);
      var kickBoost = 1 + spectrumKick * Math.exp(-x * 9.0) * 1.5;
      var v = spectrumLevel * shape * wob * kickBoost * 255;
      synthBins[i] = v > 255 ? 255 : (v | 0);
    }
    for (var j = 0; j < 2048; j++) {
      var p = j / 2048 * Math.PI * 2;
      var w = Math.sin(p * 6 + t * 7.3) * 0.6 + Math.sin(p * 17 + t * 3.1) * 0.3 + Math.sin(p * 41 + t * 13.7) * 0.1;
      synthWave[j] = 128 + (w * spectrumLevel * 110) | 0;
    }
  }

  var annieAnalyser = {
    fftSize: 2048,
    frequencyBinCount: BINS,
    minDecibels: -90,
    maxDecibels: -10,
    smoothingTimeConstant: 0.8,
    getByteFrequencyData: function (arr) { buildSpectrum(); arr.set(synthBins.subarray(0, arr.length)); },
    getByteTimeDomainData: function (arr) { buildSpectrum(); arr.set(synthWave.subarray(0, arr.length)); },
    getFloatFrequencyData: function (arr) { for (var i = 0; i < arr.length; i++) arr[i] = -100 + synthBins[i % BINS] / 255 * 80; },
    getFloatTimeDomainData: function (arr) { for (var i = 0; i < arr.length; i++) arr[i] = (synthWave[i % 2048] - 128) / 128; },
    connect: function () { }, disconnect: function () { },
  };

  // 接管视觉栈的音频全局（变量由 00-core-stores.js 声明）
  audio = annieAudio;
  analyser = annieAnalyser;

  // ================= 位置插值（引擎 10Hz 上报之间用 rAF 补间） =================
  var lastPosSec = 0;
  var lastPosAt = 0;
  var posPlaying = false;

  function interpTicker() {
    if (posPlaying && !annieAudio.paused) {
      var now = performance.now();
      var est = lastPosSec + (now - lastPosAt) / 1000;
      if (annieAudio.duration > 0) est = Math.min(est, annieAudio.duration + 0.25);
      annieAudio.currentTime = est;
    }
    requestAnimationFrame(interpTicker);
  }
  requestAnimationFrame(interpTicker);

  // ================= 封面 =================
  function dataUrlToBlob(dataUrl) {
    var m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
    if (!m) return null;
    var bin = atob(m[2]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }

  function clearStageCover() {
    try {
      currentCoverSource = null;
      coverProcessToken++;
      uniforms.uHasCover.value = 0;
      if (typeof setCoverDepthState === 'function') setCoverDepthState(0, 0, 1);
      if (typeof resetFloatColorsToIdle === 'function') resetFloatColorsToIdle();
      if (typeof setAlbumBackground === 'function') setAlbumBackground('');
      if (typeof setControlCoverSrc === 'function') setControlCoverSrc('');
      // 注意：左上角悬浮封面 thumb-cover 由 player.js 独立管理，stage-adapter 不操作它
    } catch (e) { console.warn('[stage] clearCover', e); }
  }

  function applyStageCover(dataUrl, trackKey, token) {
    if (!dataUrl) { clearStageCover(); return; }
    // 流媒体封面是 HTTP URL 时，优先交给 Mineradio 原生的 loadCoverFromUrl
    // （内部已处理 Referer 注入、canvas 裁剪、粒子纹理更新）
    if (typeof dataUrl === 'string' && (dataUrl.startsWith('http://') || dataUrl.startsWith('https://'))) {
      if (typeof loadCoverFromUrl === 'function') {
        loadCoverFromUrl(dataUrl, {
          trackToken: token,
          trackSwitch: true,
          coverKey: trackKey,
          coverSourceKind: 'url',
          coverSource: dataUrl
        });
        return;
      }
      // loadCoverFromUrl 不存在时退化为 fetch 下载
      fetch(dataUrl, { mode: 'cors' })
        .then(function (r) { return r.blob(); })
        .then(function (blob) {
          if (token !== trackSwitchToken) return;
          var reader = new FileReader();
          reader.onload = function () { applyStageCover(reader.result, trackKey, token); };
          reader.readAsDataURL(blob);
        })
        .catch(function () { clearStageCover(); });
      return;
    }
    var blob = dataUrlToBlob(dataUrl);
    if (!blob) { clearStageCover(); return; }
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      if (token !== trackSwitchToken) { URL.revokeObjectURL(url); return; }
      try {
        var size = (typeof coverTextureSizeForResolution === 'function')
          ? coverTextureSizeForResolution(fx.coverResolution) : 512;
        var cv = document.createElement('canvas');
        cv.width = cv.height = size;
        var cx = cv.getContext('2d');
        var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        var s = Math.min(iw, ih);
        cx.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, size, size);
        if (typeof setAlbumBackground === 'function') setAlbumBackground(dataUrl);
        applyCoverCanvas(cv, dataUrl, {
          trackToken: token,
          trackSwitch: true,
          coverKey: trackKey,
          coverSourceKind: 'file',
          coverSource: trackKey
        });
        // applyCoverCanvas 内部会设置 thumb-cover；此处保留注释以说明职责边界
      } catch (e) { console.warn('[stage] applyCover', e); }
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { URL.revokeObjectURL(url); clearStageCover(); };
    img.src = url;
  }

  // ================= 歌词 =================
  async function applyStageLyrics(path, token) {
    try {
      var r = await window.mine.lyrics(path);
      if (token !== trackSwitchToken) return;
      if (!r.ok || !r.text) {
        lyricsLines = [];
        if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') {
          invalidateStageLyricPayloadForNewLyrics('annie-no-lyrics');
        }
        return;
      }
      var lines = parseLyricText(r.text);
      if (token !== trackSwitchToken) return;
      originalLyricsState = {
        lines: lines,
        hasNativeKaraoke: false,
        timingSource: 'lrc',
        translationLines: [],
        translationSource: 'none'
      };
      lyricsLines = lines;
      lyricsTimingSource = 'lrc';
      // 激活歌词舞台（对齐上游 toggleLyricsPanel(true) 的开启序列）
      try {
        fx.particleLyrics = true;
        if (typeof createLyricsParticles === 'function') createLyricsParticles();
        lyricsVisible = true;
      } catch (e) { console.warn('[stage] lyricsVisible', e); }
      if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') {
        invalidateStageLyricPayloadForNewLyrics('annie-track-lyrics');
      }
      if (typeof requestStageLyricWarmup === 'function') requestStageLyricWarmup('annie-track', 150);
      if (typeof scheduleStageLyricPrewarm === 'function') scheduleStageLyricPrewarm('annie-track', 48);
      if (typeof scheduleStageLyricFullTrackWarmup === 'function') scheduleStageLyricFullTrackWarmup('track-ready', 220);
    } catch (e) { console.warn('[stage] lyrics', e); }
  }

  // ================= 节拍分析 =================
  async function applyStageBeatMap(path, durationSec, token, song) {
    try {
      var buf = await window.mine.readFile(path); // ArrayBuffer（主进程限制 64MB）
      if (token !== trackSwitchToken) return;
      var blobUrl = URL.createObjectURL(new Blob([buf]));
      var map = null;
      try {
        map = await analyzeAudioBeats(blobUrl, durationSec || 0, token, { song: song });
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (map && token === trackSwitchToken) {
        smoothBeatMapHandoff(String(path), map, token, song);
      }
    } catch (e) {
      // APE/DSD/TTA 等 Chromium 解不了的格式会走到这里：没有节拍图，视觉照样播
      console.warn('[stage] beat analysis skipped:', e && e.message);
    }
  }

  // ================= 对外：切歌 =================
  var annieStage = {
    ready: true,

    playTrack: function (meta) {
      // meta: {path, title, artist, album, cover, duration, sampleRate, bitsPerSample, codec}
      var token = ++trackSwitchToken;
      // 节拍分析用自己的令牌做竞态取消，必须与切歌令牌对齐
      try { beatMapToken = token; } catch (e) { }
      // 粒子整体透明度淡入（上游在 05-playback 播放启动里做，本地版在此补齐）
      try { if (typeof tweenParticleAlpha === 'function') tweenParticleAlpha(uniforms.uAlpha.value || 0, particlesEnabled ? 1.0 : 0, 220); } catch (e) { }
      currentSong = {
        id: String(meta.path),
        name: meta.title || '',
        title: meta.title || '',
        artist: meta.artist || '',
        album: meta.album || '',
        duration: meta.duration || 0
      };
      currentIdx = 0;
      isPlaying = true;
      if (typeof playing !== 'undefined') playing = true;

      annieAudio.duration = meta.duration || 0;
      annieAudio.currentTime = 0;
      annieAudio.paused = false;
      annieAudio.ended = false;
      lastPosSec = 0; lastPosAt = performance.now(); posPlaying = true;

      try {
        if (typeof resetLyricsForTrackSwitch === 'function') resetLyricsForTrackSwitch();
        else { lyricsLines = []; }
      } catch (e) { console.warn('[stage] resetLyrics', e); try { lyricsLines = []; } catch (e2) { } }

      try { applyStageCover(meta.cover, 'annie|' + meta.path, token); } catch (e) { console.warn('[stage] cover', e); }
      try { applyStageLyrics(meta.path, token); } catch (e) { console.warn('[stage] lyrics', e); }
      try { applyStageBeatMap(meta.path, meta.duration, token, currentSong); } catch (e) { console.warn('[stage] beat', e); }
    },

    setPaused: function (paused) {
      annieAudio.paused = !!paused;
      posPlaying = !paused;
      isPlaying = !paused;
      if (typeof playing !== 'undefined') playing = !paused;
      lastPosSec = annieAudio.currentTime;
      lastPosAt = performance.now();
    },

    stop: function () {
      annieAudio.paused = true;
      posPlaying = false;
      isPlaying = false;
      if (typeof playing !== 'undefined') playing = false;
      spectrumTarget = 0;
    },

    setVolume: function (gain) { annieAudio.volume = gain; },

    setParticlesEnabled: function (on) {
      particlesEnabled = !!on;
      try {
        if (typeof tweenParticleAlpha === 'function') {
          var cur = (typeof uniforms !== 'undefined' && uniforms.uAlpha) ? uniforms.uAlpha.value : 0;
          tweenParticleAlpha(cur, particlesEnabled ? 1.0 : 0, 300);
        }
      } catch (e) { }
    },
    getParticlesEnabled: function () { return particlesEnabled; }
  };
  window.annieStage = annieStage;

  // ================= 引擎事件 =================
  window.mine.onEngineEvent(function (event, d) {
    switch (event) {
      case 'position':
        lastPosSec = d.seconds || 0;
        lastPosAt = performance.now();
        if (d.duration) annieAudio.duration = d.duration;
        // 位置事件是"校准"，插值器负责帧间推进；偏差过大直接硬跳
        if (Math.abs(annieAudio.currentTime - lastPosSec) > 0.35) annieAudio.currentTime = lastPosSec;
        break;
      case 'state':
        if (d.state === 'playing') annieStage.setPaused(false);
        else if (d.state === 'paused') annieStage.setPaused(true);
        else if (d.state === 'stopped' || d.state === 'ended') annieStage.stop();
        break;
      case 'level':
        feedLevel(d.rms || 0, d.peak || 0);
        break;
    }
  });

  // 启动待机粒子淡入（对齐上游首页待机行为）
  try { if (typeof tweenParticleAlpha === 'function') tweenParticleAlpha(0, particlesEnabled ? 0.96 : 0, 1200); } catch (e) { }

  console.log('[stage] 视觉适配层就绪');
})();
