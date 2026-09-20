'use strict';
/* VST实验区 —— VST3 效果器链（一期）
 * 引擎端：VstFxSlot/VstFxInstance（PcmFloatSource 内 EQ 之前块级处理，崩溃自动旁通）。
 * 本模块：localStorage 持久化槽位配置（路径/启用/插件状态 base64）→ 引擎 vst.* RPC；
 * 启动时自动恢复链（引擎就绪后排队的 RPC 会自然等待）；设置中心「效果器」页调用 mount 挂载 UI。 */
(function () {
  var LS_KEY = 'annieplayer.vstfx';

  function loadCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (c && Array.isArray(c.slots)) return c;
    } catch (e) { }
    return { slots: [] };
  }
  var cfg = loadCfg();           // { slots: [{path, name, enabled, stateB64}] }
  var runtime = { restored: false, restoring: false };
  var listeners = [];
  var stateSaveTimers = {};      // path → timer（参数变更后防抖收编插件状态）

  function persist() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) { } }
  function emit() { for (var i = 0; i < listeners.length; i++) listeners[i](); }
  function cfgByPath(path) {
    for (var i = 0; i < cfg.slots.length; i++) if (cfg.slots[i].path === path) return cfg.slots[i];
    return null;
  }

  /* 引擎调用：ok:false 视为失败抛错 */
  function E(method, params) {
    return window.mine.engine('vst.' + method, params || {}).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || '操作失败');
      return r;
    });
  }

  /* 启动恢复：按持久化配置顺序重建链（引擎未就绪时 RPC 排队等待，失败重试） */
  function restore() {
    if (runtime.restored || runtime.restoring || !cfg.slots.length) return;
    runtime.restoring = true;
    (async function () {
      var ok = true;
      for (var i = 0; i < cfg.slots.length; i++) {
        var s = cfg.slots[i];
        try {
          var r = await E('add', { path: s.path });
          if (r.slot && r.slot.name) s.name = r.slot.name;
          if (s.stateB64) { try { await E('setState', { id: r.slot.id, stateB64: s.stateB64 }); } catch (e) { } }
          if (s.enabled === false) { try { await E('enable', { id: r.slot.id, on: false }); } catch (e) { } }
        } catch (e) { ok = false; /* 插件文件缺失等：保留配置，UI 显示为未加载 */ }
      }
      runtime.restored = ok;   // 有失败则下次打开设置页时还会重试
      runtime.restoring = false;
      persist(); emit();
    })();
  }

  /* 参数变更后 800ms 防抖：从引擎收编当前实例状态回持久化（切歌/重启后恢复） */
  function scheduleStateSave(id, path) {
    clearTimeout(stateSaveTimers[path]);
    stateSaveTimers[path] = setTimeout(function () {
      E('state', { id: id }).then(function (r) {
        var c = cfgByPath(path);
        if (c && r.stateB64) { c.stateB64 = r.stateB64; persist(); }
      }).catch(function () { });
    }, 800);
  }

  var fx = {
    get cfg() { return cfg; },
    onChange: function (cb) { listeners.push(cb); return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },

    list: function () { return E('list').then(function (r) { return r.slots || []; }); },
    scan: function () { return E('scan').then(function (r) { return r.items || []; }); },

    addPath: async function (path) {
      if (cfgByPath(path)) throw new Error('该插件已在链中');
      var r = await E('add', { path: path });
      cfg.slots.push({ path: path, name: (r.slot && r.slot.name) || path, enabled: true, stateB64: '' });
      persist(); emit();
      return r.slot;
    },

    remove: async function (id, path) {
      await E('remove', { id: id });
      var i = cfg.slots.findIndex(function (s) { return s.path === path; });
      if (i >= 0) cfg.slots.splice(i, 1);
      persist(); emit();
    },

    enable: async function (id, path, on) {
      await E('enable', { id: id, on: !!on });
      var c = cfgByPath(path);
      if (c) c.enabled = !!on;
      persist(); emit();
    },

    move: async function (id, path, dir) {
      await E('move', { id: id, dir: dir });
      var i = cfg.slots.findIndex(function (s) { return s.path === path; });
      var j = i + (dir < 0 ? -1 : 1);
      if (i >= 0 && j >= 0 && j < cfg.slots.length) {
        var t = cfg.slots[i]; cfg.slots[i] = cfg.slots[j]; cfg.slots[j] = t;
      }
      persist(); emit();
    },

    params: function (id) { return E('params', { id: id }); },

    /* 插件原生界面（独立悬浮窗，挂在播放中的活实例上；未播放引擎会拒绝） */
    openEditor: function (id) { return E('openEditor', { id: id }); },
    closeEditor: function (id) { return E('closeEditor', { id: id }); },

    setParam: function (id, path, paramId, value) {
      return E('setParam', { id: id, paramId: paramId, value: value }).then(function (r) {
        scheduleStateSave(id, path);
        return r;
      });
    },

    /* 打开面板时调用：确保已恢复 + 返回引擎侧槽位 */
    ensureReady: function () { restore(); return fx.list().catch(function () { return []; }); }
  };

  /* ---------------- V3.5.9：效果器方案（整套链配置的保存/切换） ---------------- */
  var PRESET_KEY = 'annieplayer.vstfx.presets';
  function loadPresets() { try { var a = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function savePresets(list) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(list.slice(0, 30))); } catch (e) { } }

  fx.presets = {
    list: loadPresets,
    /* 保存当前链为方案：先收编各槽最新参数状态（live 实例可能刚调过），再深拷贝快照 */
    saveAs: async function (name) {
      var slots = await fx.list().catch(function () { return []; });
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (s.broken) continue;
        try {
          var r = await E('state', { id: s.id });
          var c = cfgByPath(s.path);
          if (c && r.stateB64) c.stateB64 = r.stateB64;
        } catch (e) { }
      }
      persist();
      var list = loadPresets();
      var preset = { id: 'p' + Date.now().toString(36), name: name, slots: JSON.parse(JSON.stringify(cfg.slots)), at: Date.now() };
      list.unshift(preset);
      savePresets(list);
      return preset;
    },
    /* 切换方案：清空当前链 → 按方案逐槽重建（含参数状态与启停）；缺失插件跳过不中断 */
    apply: async function (id) {
      var p = null;
      var all = loadPresets();
      for (var i = 0; i < all.length; i++) if (all[i].id === id) p = all[i];
      if (!p) throw new Error('方案不存在');
      var cur = await fx.list().catch(function () { return []; });
      for (var j = 0; j < cur.length; j++) { try { await E('remove', { id: cur[j].id }); } catch (e) { } }
      cfg.slots = [];
      var failed = 0;
      for (var k = 0; k < p.slots.length; k++) {
        var ps = p.slots[k];
        try {
          var r = await E('add', { path: ps.path });
          if (ps.stateB64) { try { await E('setState', { id: r.slot.id, stateB64: ps.stateB64 }); } catch (e) { } }
          if (ps.enabled === false) { try { await E('enable', { id: r.slot.id, on: false }); } catch (e) { } }
          cfg.slots.push({ path: ps.path, name: ps.name, enabled: ps.enabled !== false, stateB64: ps.stateB64 || '' });
        } catch (e) { failed++; }
      }
      runtime.restored = true;
      persist(); emit();
      return { total: p.slots.length, failed: failed };
    },
    remove: function (id) {
      savePresets(loadPresets().filter(function (x) { return x.id !== id; }));
    }
  };

  window.annieFx = fx;

  /* 引擎崩溃旁通通知 → 刷新 UI 徽标 */
  try {
    window.mine.onEngineEvent(function (event, d) {
      if (event === 'notify' && d && typeof d.text === 'string' && d.text.indexOf('VST') >= 0) emit();
    });
  } catch (e) { }

  /* 启动即恢复（引擎 sidecar 就绪前排队的调用会在就绪后执行） */
  if (cfg.slots.length) setTimeout(restore, 0);
})();
