/* ============================================================
 * V4.3.16：曲库节奏（BPM）分析——为「相似歌曲推荐」供特征。
 * 复用节拍系统的 music-tempo worker（vendor/music-tempo.min.js），
 * 但完全独立于播放态节拍管线：readFile → decodeAudioData → 单声道混缩
 * → worker 算 tempo → bpm:set 落盘 metaCache[path].bpm（number；
 * >0 有效，-1 = 分析失败标记，缺失 = 未分析）。
 * ============================================================ */
(function () {
  'use strict';

  var MAX_ANALYZE_SEC = 15 * 60; // 与节拍管线一致的内存护栏：>15min 跳过

  /* ---------------- music-tempo worker（与 00-tempo-worker-cache-prefetch.js 同参数） ---------------- */
  var _workerUrl = null;
  function workerUrl() {
    if (_workerUrl) return _workerUrl;
    var code = [
      'self.onmessage=function(e){',
      'var d=e.data||{};',
      'try{',
      'importScripts(d.scriptUrl);',
      'var C=self.MusicTempo||(typeof MusicTempo!=="undefined"?MusicTempo:null);',
      'if(!C)throw new Error("MusicTempo unavailable");',
      'var mono=new Float32Array(d.mono);',
      'var mt=new C(mono,{bufferSize:2048,hopSize:Math.max(128,Math.round(d.sampleRate*0.010)),timeStep:0.010,minBeatInterval:0.36,maxBeatInterval:0.95,expiryTime:8});',
      'self.postMessage({ok:true,tempo:mt.tempo||0});',
      '}catch(err){self.postMessage({ok:false,error:(err&&err.message)||String(err)});}',
      '};'
    ].join('');
    _workerUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    return _workerUrl;
  }

  function runTempoWorker(mono, sampleRate) {
    return new Promise(function (resolve) {
      var worker;
      try { worker = new Worker(workerUrl()); } catch (e) { resolve(0); return; }
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true;
        try { worker.terminate(); } catch (e) { }
        resolve(0);
      }, 30000);
      worker.onmessage = function (ev) {
        if (done) return; done = true; clearTimeout(timer);
        try { worker.terminate(); } catch (e) { }
        var d = ev.data || {};
        resolve(d.ok && d.tempo > 0 ? d.tempo : 0);
      };
      worker.onerror = function () {
        if (done) return; done = true; clearTimeout(timer);
        try { worker.terminate(); } catch (e) { }
        resolve(0);
      };
      worker.postMessage({
        mono: mono.buffer, sampleRate: sampleRate,
        scriptUrl: new URL('vendor/music-tempo.min.js', location.href).href
      }, [mono.buffer]);
    });
  }

  /* ---------------- 单曲分析：path → bpm（0 = 失败） ---------------- */
  async function analyzeTrack(path) {
    try {
      if (!window.mine || !window.mine.readFile) return 0;
      var ab = await window.mine.readFile(path);
      if (!ab || !ab.byteLength) return 0;
      var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Ctx) return 0;
      var dc = new Ctx(1, 1, 44100);
      var buf = await new Promise(function (res, rej) { dc.decodeAudioData(ab, res, rej); });
      if (!buf || buf.duration > MAX_ANALYZE_SEC) return 0;
      var len = buf.length, chs = buf.numberOfChannels;
      var mono = new Float32Array(len);
      var scale = 1 / Math.max(1, chs);
      for (var ch = 0; ch < chs; ch++) {
        var data = buf.getChannelData(ch);
        for (var i = 0; i < len; i++) mono[i] += data[i] * scale;
      }
      return await runTempoWorker(mono, buf.sampleRate);
    } catch (e) {
      return 0; // DSD/异常格式 decodeAudioData 会抛——按失败处理
    }
  }

  /* ---------------- 批量补算（设置页按钮驱动） ----------------
   * 逐轨串行，每 10 首落盘一批；返回 { done, total, ok, canceled }。 */
  var _cancelFlag = false;
  function batchCancel() { _cancelFlag = true; }

  async function batchFill(onProgress) {
    var lib = window.state && state.library;
    if (!lib) return { done: 0, total: 0, ok: 0, canceled: false };
    var missing = lib.tracks.map(function (t) { return t.path; }).filter(function (p) {
      if (p.indexOf('#cue') >= 0 || p.indexOf('#iso') >= 0) return false; // 虚拟分轨 v1 跳过
      if (/^https?:/i.test(p)) return false;
      var mc = lib.metaCache[p];
      return !(mc && typeof mc.bpm === 'number');
    });
    _cancelFlag = false;
    var ok = 0, pending = {};
    for (var i = 0; i < missing.length; i++) {
      if (_cancelFlag) break;
      var p = missing[i];
      var bpm = await analyzeTrack(p);
      pending[p] = bpm > 0 ? Math.round(bpm * 10) / 10 : -1;
      if (bpm > 0) ok++;
      // 同步到内存 metaCache（打分即时可用），攒 10 首落盘
      var mc = lib.metaCache[p] || (lib.metaCache[p] = {});
      mc.bpm = pending[p];
      if (Object.keys(pending).length >= 10) {
        try { await window.mine.bpmSet(pending); } catch (e) { }
        pending = {};
      }
      if (onProgress) onProgress(i + 1, missing.length, p);
      await new Promise(function (r) { setTimeout(r, 0); }); // 让出主线程
    }
    if (Object.keys(pending).length) { try { await window.mine.bpmSet(pending); } catch (e) { } }
    return { done: _cancelFlag ? -1 : missing.length, total: missing.length, ok: ok, canceled: _cancelFlag };
  }

  window.annieRhythm = { analyzeTrack: analyzeTrack, batchFill: batchFill, batchCancel: batchCancel };
})();
