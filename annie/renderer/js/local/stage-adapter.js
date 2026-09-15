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
  // 切歌时间戳：position 事件防护用（忽略切歌后短暂窗口内旧曲残留的时间校准）
  var lastTrackSwitchAt = 0;

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

  var lastBuildAt = -1;
  function buildSpectrum() {
    var now = performance.now();
    // 同帧复用：主循环每帧连续调 getByteFrequencyData + getByteTimeDomainData，
    // 各触发一次完整合成（上万次超越函数）——3ms 内的重复调用直接复用上次结果
    if (now - lastBuildAt < 3) return;
    lastBuildAt = now;
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
    // 仅舞台可见且播放中需要 60fps 补间；暂停或切到其他主题时降为 4Hz 慢轮（等 state 事件恢复锚点）
    var active = posPlaying && !annieAudio.paused && !window.__legacyThemeHidden;
    if (active) {
      var now = performance.now();
      var est = lastPosSec + (now - lastPosAt) / 1000;
      if (annieAudio.duration > 0) est = Math.min(est, annieAudio.duration + 0.25);
      annieAudio.currentTime = est;
      requestAnimationFrame(interpTicker);
    } else {
      setTimeout(interpTicker, 250);
    }
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
    // 流媒体封面是 HTTP(S) URL 时，优先交给 Mineradio 原生的 loadCoverFromUrl
    // （内部已处理 Referer 注入、canvas 裁剪、粒子纹理更新）
    if (typeof dataUrl === 'string' && (dataUrl.startsWith('http://') || dataUrl.startsWith('https://'))) {
      // V1.1.8：http 封面（如 kwcdn.kuwo.cn，其 https 证书无效且 CSP 拦 http）
      // 直接经主进程代理转 dataURL，避免加载失败。
      if (dataUrl.startsWith('http://') && window.mine.streamCoverProxy) {
        window.mine.streamCoverProxy(dataUrl).then(function (r) {
          if (token !== trackSwitchToken) return;
          if (r && r.url) applyStageCover(r.url, trackKey, token); // dataURL 走下方 blob 分支
          else clearStageCover();
        }).catch(function () { clearStageCover(); });
        return;
      }
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
  // 逐字歌词提取：支持两种词标签（无标签返回 null，行为与原来完全一致）
  //   1) <mm:ss.xxx>文字        绝对时间（下载文件常见的"增强 LRC"）
  //   2) <相对ms,时长ms>文字     相对行首（洛雪 lxlyric 格式）
  function parseWordMark(raw, lineStart) {
    var s = String(raw || '').trim();
    var mm = /^(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)$/.exec(s); // mm:ss.xxx
    if (mm) return { t: (parseInt(mm[1], 10) || 0) * 60 + parseFloat(mm[2] || '0'), d: 0 };
    var rel = /^(\d+),(\d+)$/.exec(s);                       // 相对ms,时长ms
    if (rel) return { t: (Number(lineStart) || 0) + (parseInt(rel[1], 10) || 0) / 1000, d: (parseInt(rel[2], 10) || 0) / 1000 };
    return null;
  }
  function extractWordTimes(rawText, lineStart) {
    var s = String(rawText || '');
    if (s.indexOf('<') < 0) return null;
    var re = /<([^<>]+)>/g, m, marks = [];
    while ((m = re.exec(s))) marks.push({ raw: m[1], index: m.index, end: re.lastIndex });
    if (!marks.length) return null;
    var words = [], fullText = '';
    for (var i = 0; i < marks.length; i++) {
      var seg = s.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].index : s.length);
      if (!seg) continue;                                     // 首尾空文本占位 / 纯时间占位
      var tk = parseWordMark(marks[i].raw, lineStart);
      if (tk == null) { fullText += seg; continue; }          // 非时间标签：原样保留
      var c0 = fullText.length;
      fullText += seg;
      words.push({ text: seg, t: tk.t, d: tk.d, c0: c0, c1: fullText.length });
    }
    if (!words.length) return null;
    // 缺时长的词用下一词起点推算（末词兜底 0.6s）
    for (var k = 0; k < words.length; k++) {
      if (words[k].d > 0) continue;
      var nxt = words[k + 1];
      words[k].d = nxt ? Math.max(0.06, nxt.t - words[k].t) : 0.6;
    }
    return { text: fullText, words: words };
  }

  // 通用歌词注入：text 为空 → 清空；非空 → 解析 LRC 并激活歌词舞台
  function applyLyricText(text, token) {
    if (token !== trackSwitchToken) return;
    if (!text) {
      lyricsLines = [];
      if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') {
        invalidateStageLyricPayloadForNewLyrics('annie-no-lyrics');
      }
      return;
    }
    var lines = parseLyricText(text);
    if (token !== trackSwitchToken) return;
    // 逐字歌词：从 <词时间> 标签提取 words（逐字卡拉OK由舞台 getLyricLineProgress 自动接管）
    var hasWordTiming = false;
    for (var li = 0; li < lines.length; li++) {
      var ex = extractWordTimes(lines[li].text, lines[li].t);
      if (ex && ex.words.length) {
        lines[li].text = ex.text;
        lines[li].words = ex.words;
        lines[li].charCount = Math.max(1, ex.text.length);
        lines[li].source = 'word-lrc';
        hasWordTiming = true;
      }
    }
    originalLyricsState = {
      lines: lines,
      hasNativeKaraoke: hasWordTiming,
      timingSource: hasWordTiming ? 'word-lrc' : 'lrc',
      translationLines: [],
      translationSource: 'none'
    };
    lyricsLines = lines;
    lyricsTimingSource = hasWordTiming ? 'word-lrc' : 'lrc';
    // 激活歌词舞台（对齐上游 toggleLyricsPanel(true) 的开启序列）
    try {
      fx.particleLyrics = true;
      if (typeof createLyricsParticles === 'function') createLyricsParticles();
      lyricsVisible = true;
    } catch (e) { console.warn('[stage] lyricsVisible', e); }
    if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') {
      invalidateStageLyricPayloadForNewLyrics('annie-track-lyrics');
    }
    // 不启动全轨预热（scheduleStageLyricPrewarm / FullTrackWarmup）：协作式全轨构建
    // 每步仅 4.2ms 预算、步间 6-24ms 延迟，数十行歌词要数秒~十几秒，期间
    // tickLyricsParticles 的 stageLyricWarmupPending() 门控会一直拦截渲染，
    // 导致歌词迟迟不显示/旧歌词长期保留。这里只留一个 ~120ms 的 warmup 窗口，
    // 让 tick 尽快走"当前行同步/轻量构建"路径立即显示首行，后续行按需渐进补齐。
    if (typeof requestStageLyricWarmup === 'function') requestStageLyricWarmup('annie-track', 120);
  }

  async function applyStageLyrics(path, token) {
    try {
      var r = await window.mine.lyrics(path);
      if (token !== trackSwitchToken) return;
      applyLyricText((r && r.ok && r.text) ? r.text : '', token);
    } catch (e) { console.warn('[stage] lyrics', e); }
  }

  // ================= 节拍分析 =================
  async function applyStageBeatMap(path, durationSec, token, song) {
    try {
      // 流媒体 URL 无法走本地文件读取（无本地字节），跳过节拍图（视觉照常）
      if (/^https?:\/\//i.test(path)) return;
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
      lastTrackSwitchAt = performance.now(); // 开启 position 防护窗口

      try {
        if (typeof resetLyricsForTrackSwitch === 'function') resetLyricsForTrackSwitch();
        else { lyricsLines = []; }
      } catch (e) { console.warn('[stage] resetLyrics', e); try { lyricsLines = []; } catch (e2) { } }
      // 立即清除上一首的歌词 mesh：reset 只清数据不清 mesh，
      // 若不手动清，新歌词构建完成前旧歌词会一直保留（用户感知"歌词停在上一首"）。
      try {
        if (typeof clearStageLyrics === 'function') clearStageLyrics();
      } catch (e) { console.warn('[stage] clearLyrics', e); }

      try { applyStageCover(meta.cover, 'annie|' + meta.path, token); } catch (e) { console.warn('[stage] cover', e); }
      // 流媒体 URL（http/https）没有本地 .lrc：跳过本地歌词读取，
      // 避免其空结果异步到达后覆盖 streaming.js 通过 setLyricText 注入的在线歌词。
      // 在线歌词由 streaming.js → streamLyric → annieStage.setLyricText 负责。
      if (!/^https?:\/\//i.test(String(meta.path || ''))) {
        try { applyStageLyrics(meta.path, token); } catch (e) { console.warn('[stage] lyrics', e); }
      }
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
    getParticlesEnabled: function () { return particlesEnabled; },

    // 流媒体在线歌词注入（由 streaming.js 异步回调调用；token 竞态由 applyLyricText 把关）
    setLyricText: function (text) {
      applyLyricText(text || '', trackSwitchToken);
    },

    // 流媒体封面补充注入（由 streaming.js 异步回调调用；URL 直接走 applyStageCover 的 HTTP 链路）
    setCover: function (src) {
      if (!src) return;
      try {
        applyStageCover(src, 'annie|' + (currentSong ? currentSong.id : 'cover'), trackSwitchToken);
      } catch (e) { console.warn('[stage] setCover', e); }
    }
  };
  window.annieStage = annieStage;

  // ================= 引擎事件 =================
  window.mine.onEngineEvent(function (event, d) {
    switch (event) {
      case 'position':
        // V1.1.4：seek 保护——引擎 seek 未完成时忽略旧曲 position 校准（歌词时间源防乱跳）
        if (typeof state !== 'undefined' && state.seekPending) break;
        // 切歌后 600ms 内的"大秒数"position 事件是旧曲残留（引擎 play 确认后
        // 仍可能补发旧曲位置），会把歌词时间源钉在旧位置导致新歌词错位；
        // 新曲首个 position 事件从 0 附近开始，不会被误杀。
        if (performance.now() - lastTrackSwitchAt < 600 && Number(d.seconds || 0) > 3) break;
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
