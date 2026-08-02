'use strict';
/* EXP 7.28 —— 15 段图示均衡器（共享 Store + 双界面面板）
 * 音频处理：引擎端 EqChain（float PCM 域 biquad 链，WASAPI/ASIO 共享同一实例）。
 * 本模块：单一全局 Store（localStorage 持久化）→ window.mine.engine('eq.set')；
 * 两个界面各自挂载面板（同一 DOM 结构），通过订阅模式实时双向同步。
 * 改动记录：新增本文件；fb2k.js 底部抽屉 + player.js 悬浮按钮 调用 mountPanel。 */
(function () {
  var FREQS = [32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000, 8000, 12500, 16000];
  var FREQ_LABELS = ['32', '50', '80', '125', '200', '315', '500', '800', '1.25k', '2k', '3.15k', '5k', '8k', '12.5k', '16k'];
  // 预设曲线（15 段 dB，32Hz→16kHz）
  var PRESETS = {
    flat: { name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    pop: { name: 'Pop', gains: [-1, 2, 4, 4, 2, 0, -2, -2, 0, 2, 3, 4, 3, 1, 0] },
    rock: { name: 'Rock', gains: [4, 3, 2, 1, -1, -2, 0, 2, 4, 5, 6, 6, 5, 4, 3] },
    jazz: { name: 'Jazz', gains: [4, 3, 1, 2, -2, -2, 0, 2, 3, 4, 5, 6, 6, 5, 4] },
    classical: { name: 'Classical', gains: [4, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 4] },
    custom: { name: 'Custom', gains: null } // 手动调整后的状态
  };
  var LS_KEY = 'annieplayer.eq';

  function loadState() {
    // Pro beat0.0.1：削波防护开关（自动前级补偿 / 软限幅器）默认开启
    var base = { enabled: true, gains: PRESETS.flat.gains.slice(), preset: 'flat', autoPreamp: true, limiter: true };
    try {
      var s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (s && Array.isArray(s.gains) && s.gains.length === 15) {
        base.gains = s.gains.map(function (v) { return clampDb(+v || 0); });
        base.enabled = s.enabled !== false;
        base.preset = PRESETS[s.preset] ? s.preset : 'flat';
        base.autoPreamp = s.autoPreamp !== false;
        base.limiter = s.limiter !== false;
      }
    } catch (e) { }
    return base;
  }
  function clampDb(v) { return Math.max(-12, Math.min(12, Math.round(v * 2) / 2)); }

  var state = loadState();
  var listeners = [];
  function emit() { for (var i = 0; i < listeners.length; i++) listeners[i](state); }
  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { }
  }

  /* 引擎同步（30ms 防抖，拖滑块不刷屏） */
  var applyTimer = null;
  function applyToEngine(immediate) {
    clearTimeout(applyTimer);
    var send = function () {
      window.mine.engine('eq.set', { gains: state.gains.slice(), enabled: state.enabled })
        .catch(function () { /* 引擎未就绪时下次操作会重发 */ });
    };
    if (immediate) send(); else applyTimer = setTimeout(send, 30);
  }

  var eq = {
    FREQS: FREQS,
    FREQ_LABELS: FREQ_LABELS,
    PRESETS: PRESETS,
    get state() { return state; },
    onChange: function (cb) { listeners.push(cb); return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },

    setGain: function (i, v) {
      state.gains[i] = clampDb(v);
      if (state.preset !== 'custom') state.preset = 'custom';
      persist(); applyToEngine(); emit();
    },
    applyPreset: function (key) {
      if (!PRESETS[key]) return;
      if (PRESETS[key].gains) state.gains = PRESETS[key].gains.slice();
      state.preset = key;
      persist(); applyToEngine(true); emit();
    },
    reset: function () { eq.applyPreset('flat'); },
    setEnabled: function (on) {
      state.enabled = !!on;
      persist(); applyToEngine(true); emit();
    },
    /* Pro beat0.0.1：削波防护（自动前级补偿 / 软限幅器），引擎热更新不断流 */
    setDsp: function (patch) {
      if (patch.autoPreamp !== undefined) state.autoPreamp = !!patch.autoPreamp;
      if (patch.limiter !== undefined) state.limiter = !!patch.limiter;
      persist(); emit();
      window.mine.engine('dsp.set', { autoPreamp: state.autoPreamp, limiter: state.limiter }).catch(function () { });
    },

    /** 在指定容器挂载 EQ 面板（双界面共用 DOM 结构，主题差异由外层 CSS 负责）。 */
    mountPanel: function (container) {
      container.innerHTML = '';
      container.classList.add('eq-panel');

      /* 头部：启用开关 + 预设 + 重置 */
      var head = document.createElement('div'); head.className = 'eq-head';
      var enableLbl = document.createElement('label'); enableLbl.className = 'eq-enable';
      var enableChk = document.createElement('input'); enableChk.type = 'checkbox';
      enableLbl.appendChild(enableChk);
      enableLbl.appendChild(document.createTextNode(' EQ 启用'));
      head.appendChild(enableLbl);

      var presetBtns = {};
      Object.keys(PRESETS).forEach(function (key) {
        var b = document.createElement('button');
        b.className = 'eq-preset'; b.textContent = PRESETS[key].name;
        b.onclick = function () { eq.applyPreset(key); };
        presetBtns[key] = b;
        head.appendChild(b);
      });
      var resetBtn = document.createElement('button');
      resetBtn.className = 'eq-reset'; resetBtn.textContent = '重置';
      resetBtn.onclick = function () { eq.reset(); };
      head.appendChild(resetBtn);
      container.appendChild(head);

      /* Pro beat0.0.1：削波防护行（自动前级补偿 + 软限幅器） */
      var dspRow = document.createElement('div'); dspRow.className = 'eq-dsp-row';
      var apLbl = document.createElement('label'); apLbl.className = 'eq-enable';
      var apChk = document.createElement('input'); apChk.type = 'checkbox';
      apLbl.appendChild(apChk);
      apLbl.appendChild(document.createTextNode(' 自动增益补偿（防削波）'));
      var lmLbl = document.createElement('label'); lmLbl.className = 'eq-enable';
      var lmChk = document.createElement('input'); lmChk.type = 'checkbox';
      lmLbl.appendChild(lmChk);
      lmLbl.appendChild(document.createTextNode(' 输出限幅器'));
      dspRow.appendChild(apLbl); dspRow.appendChild(lmLbl);
      container.appendChild(dspRow);
      apChk.onchange = function () { eq.setDsp({ autoPreamp: apChk.checked }); };
      lmChk.onchange = function () { eq.setDsp({ limiter: lmChk.checked }); };

      /* 15 段滑块（拖拽 + 数值输入双模式） */
      var bandsBox = document.createElement('div'); bandsBox.className = 'eq-bands';
      var sliders = [], inputs = [];
      FREQS.forEach(function (f, i) {
        var band = document.createElement('div'); band.className = 'eq-band';
        var val = document.createElement('input');
        val.className = 'eq-val'; val.type = 'number'; val.min = -12; val.max = 12; val.step = 0.5;
        val.title = FREQ_LABELS[i] + 'Hz 增益（dB）';
        val.onchange = function () {
          var v = parseFloat(val.value);
          if (isNaN(v)) { render(state); return; }
          eq.setGain(i, v);
        };
        var slider = document.createElement('input');
        slider.className = 'eq-slider'; slider.type = 'range';
        slider.min = -12; slider.max = 12; slider.step = 0.5;
        slider.setAttribute('orient', 'vertical'); // Firefox 兜底；Chromium 走 CSS writing-mode
        slider.oninput = function () { eq.setGain(i, parseFloat(slider.value)); };
        var lab = document.createElement('div'); lab.className = 'eq-freq'; lab.textContent = FREQ_LABELS[i];
        band.appendChild(val); band.appendChild(slider); band.appendChild(lab);
        bandsBox.appendChild(band);
        sliders.push(slider); inputs.push(val);
      });
      container.appendChild(bandsBox);

      /* Store → 面板 订阅同步（另一界面的改动实时反映到本面板） */
      function render(s) {
        enableChk.checked = s.enabled;
        apChk.checked = s.autoPreamp !== false;
        lmChk.checked = s.limiter !== false;
        container.classList.toggle('eq-off', !s.enabled);
        Object.keys(presetBtns).forEach(function (k) { presetBtns[k].classList.toggle('active', k === s.preset); });
        for (var i = 0; i < 15; i++) {
          if (document.activeElement !== sliders[i]) sliders[i].value = s.gains[i];
          if (document.activeElement !== inputs[i]) inputs[i].value = (s.gains[i] > 0 ? '+' : '') + s.gains[i].toFixed(1);
        }
      }
      enableChk.onchange = function () { eq.setEnabled(enableChk.checked); };
      var off = eq.onChange(render);
      render(state);
      return {
        unmount: function () { off(); container.innerHTML = ''; },
        refresh: function () { render(state); }
      };
    }
  };

  window.annieEQ = eq;

  /* ---------------- 粒子舞台界面：底部传输条 EQ 按钮 + 悬浮面板 ---------------- */
  (function mountLegacy() {
    // Plus 方案A：注入"音频工具组"，无则退回传输条
    var group = document.querySelector('#controls .ctl-group.tools') || document.getElementById('controls');
    if (!group) return;
    var btn = document.createElement('button');
    btn.id = 'btn-eq'; btn.className = 'ctl'; btn.title = '均衡器（15 段）'; btn.textContent = 'EQ';
    group.appendChild(btn);
    var panel = document.createElement('div');
    panel.id = 'eq-float'; panel.className = 'hidden';
    document.body.appendChild(panel);
    var api = null;
    btn.onclick = function () {
      var willOpen = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !willOpen);
      btn.classList.toggle('on', willOpen);
      if (willOpen && !api) api = eq.mountPanel(panel);
    };
  })();

  /* 启动时把持久化的 EQ 应用到引擎（引擎可能尚未拉起，带重试） */
  (function bootApply() {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      window.mine.engine('eq.set', { gains: state.gains.slice(), enabled: state.enabled })
        .then(function () { clearInterval(t); })
        .catch(function () { if (tries >= 10) clearInterval(t); });
    }, 800);
  })();
})();
