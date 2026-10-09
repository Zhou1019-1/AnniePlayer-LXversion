'use strict';
/* V4.4：全局自定义壁纸（三主题共用）
 * 存储：图片 Blob 存 IndexedDB（annie-wallpaper-v1/media/<id>），历史清单与设置存 LS
 * annieplayer.wallpaper = { on, blur, dim, cur, hist:[{id,at}] }（历史上限 12 张，超出逐最旧）。
 * 应用：CSS 变量挂 <html>（--wp-img / --wp-blur / --wp-dim）+ html.wp-on 类，
 * 三主题各自的氛围伪层用 html.wp-on 规则把封面氛围替换为壁纸
 *（AM #am-root::before / 粒子舞台 body::before / FB2K 新增 #fb2k-root::before 层）。
 * 不经主进程：file input 读图，blob: URL 在 CSP img-src 白名单内，天然安全。 */
(function () {
  var LS_KEY = 'annieplayer.wallpaper';
  var DB_NAME = 'annie-wallpaper-v1', STORE = 'media';
  var LEGACY_KEY = 'wp'; // V4.4 初版单图槽，迁移进历史
  var HIST_MAX = 12;
  var cfg = { on: false, blur: 40, dim: 0.35, cur: '', hist: [], imm: false };
  try {
    var saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (saved && typeof saved === 'object') {
      if (typeof saved.on === 'boolean') cfg.on = saved.on;
      if (isFinite(saved.blur)) cfg.blur = Math.max(0, Math.min(90, Number(saved.blur)));
      if (isFinite(saved.dim)) cfg.dim = Math.max(0, Math.min(0.85, Number(saved.dim)));
      if (typeof saved.cur === 'string') cfg.cur = saved.cur;
      if (Array.isArray(saved.hist)) cfg.hist = saved.hist.filter(function (h) { return h && typeof h.id === 'string'; });
      if (typeof saved.imm === 'boolean') cfg.imm = saved.imm; // 沉浸模式也用壁纸（默认关：沉浸仍随封面）
    }
  } catch (e) { }
  var urlCache = {}; // id → objectURL（会话级缓存，勿 revoke，历史缩略图复用）

  function saveCfg() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) { } }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('indexedDB unavailable')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
    });
  }
  function idbOp(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var out = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { db.close(); resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('idb op failed')); };
      });
    });
  }
  function idbPut(id, blob) { return idbOp('readwrite', function (st) { st.put({ blob: blob, at: Date.now() }, id); }); }
  function idbGet(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(id);
        req.onsuccess = function () {
          var r = req.result;
          resolve(r ? (r.blob || r) : null); // 兼容裸 Blob 与 {blob,at} 两种形态
        };
        req.onerror = function () { reject(req.error || new Error('idb get failed')); };
        tx.oncomplete = function () { db.close(); };
      });
    });
  }
  function idbDel(id) { return idbOp('readwrite', function (st) { st.delete(id); }); }

  /* 旧版单图槽（key 'wp'）迁移进历史清单，只迁一次 */
  var migrated = false;
  function migrateLegacy() {
    if (migrated) return Promise.resolve();
    migrated = true;
    if (cfg.cur || cfg.hist.length) return Promise.resolve();
    return idbGet(LEGACY_KEY).then(function (b) {
      if (!b) return;
      var id = 'wp' + Date.now();
      return idbPut(id, b).then(function () { return idbDel(LEGACY_KEY); }).then(function () {
        cfg.cur = id; cfg.hist = [{ id: id, at: Date.now() }];
        saveCfg();
      });
    }).catch(function () { });
  }

  function urlFor(id) {
    if (urlCache[id]) return Promise.resolve(urlCache[id]);
    return idbGet(id).then(function (b) {
      if (!b) return null;
      urlCache[id] = URL.createObjectURL(b);
      return urlCache[id];
    }).catch(function () { return null; });
  }
  /* 当前壁纸 objectURL（无论开关状态，设置页预览也用）；无图 resolve(null) */
  function ensureUrl() {
    return migrateLegacy().then(function () {
      if (!cfg.cur) return null;
      return urlFor(cfg.cur);
    });
  }

  function apply() {
    var root = document.documentElement;
    root.style.setProperty('--wp-blur', Math.round(cfg.blur) + 'px');
    root.style.setProperty('--wp-dim', String(cfg.dim));
    root.classList.toggle('wp-imm', !!cfg.imm); // 沉浸模式壁纸开关（与 wp-on 组合生效）
    if (!cfg.on) {
      root.classList.remove('wp-on');
      document.dispatchEvent(new CustomEvent('annie-wp-changed'));
      return Promise.resolve();
    }
    return ensureUrl().then(function (url) {
      if (!url) { root.classList.remove('wp-on'); } // 开着开关但没图：静默回落氛围背景
      else {
        root.style.setProperty('--wp-img', 'url("' + url + '")');
        root.classList.add('wp-on');
      }
      document.dispatchEvent(new CustomEvent('annie-wp-changed'));
    });
  }

  /* 收进历史：置顶、去重、超额逐最旧（连图一起删） */
  function pushHist(id) {
    cfg.hist = cfg.hist.filter(function (h) { return h.id !== id; });
    cfg.hist.unshift({ id: id, at: Date.now() });
    while (cfg.hist.length > HIST_MAX) {
      var old = cfg.hist.pop();
      idbDel(old.id).catch(function () { });
      if (urlCache[old.id]) { try { URL.revokeObjectURL(urlCache[old.id]); } catch (e) { } delete urlCache[old.id]; }
    }
  }

  /* 选图：隐藏 file input；成功后进历史并自动启用。resolve(true/false) */
  function pick() {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) { resolve(false); return; }
        if (!/^image\//.test(f.type)) { resolve(false); return; }
        var id = 'wp' + Date.now();
        idbPut(id, f).then(function () {
          urlCache[id] = URL.createObjectURL(f);
          pushHist(id);
          cfg.cur = id; cfg.on = true; saveCfg();
          return apply();
        }).then(function () { resolve(true); })
          .catch(function () { resolve(false); });
      };
      // 部分平台取消选择不触发任何事件——focus 回窗后若未选图则按取消处理
      var onFocus = function () {
        window.removeEventListener('focus', onFocus);
        setTimeout(function () { if (!inp.files || !inp.files.length) resolve(false); }, 400);
      };
      window.addEventListener('focus', onFocus);
      inp.click();
    });
  }

  /* 切换到历史中的某一张（自动启用） */
  function use(id) {
    if (!cfg.hist.some(function (h) { return h.id === id; })) return Promise.resolve(false);
    cfg.cur = id; cfg.on = true; saveCfg();
    return apply().then(function () { return true; });
  }

  /* 从历史删除一张；删的是当前图则顺位到最近一张，没有则停用 */
  function remove(id) {
    cfg.hist = cfg.hist.filter(function (h) { return h.id !== id; });
    var p = idbDel(id).catch(function () { });
    if (urlCache[id]) { try { URL.revokeObjectURL(urlCache[id]); } catch (e) { } delete urlCache[id]; }
    if (cfg.cur === id) {
      cfg.cur = cfg.hist.length ? cfg.hist[0].id : '';
      if (!cfg.cur) {
        cfg.on = false;
        document.documentElement.style.removeProperty('--wp-img');
      }
    }
    saveCfg();
    return p.then(function () { return apply(); });
  }

  /* 清除：删除当前这张并停用（历史其余保留，可从缩略图条点回） */
  function clear() {
    if (!cfg.cur) { cfg.on = false; saveCfg(); return apply(); }
    return remove(cfg.cur);
  }

  window.annieWallpaper = {
    cfg: cfg,
    set: function (patch) {
      if (patch) {
        if (typeof patch.on === 'boolean') cfg.on = patch.on;
        if (typeof patch.imm === 'boolean') cfg.imm = patch.imm;
        if (isFinite(patch.blur)) cfg.blur = Math.max(0, Math.min(90, Number(patch.blur)));
        if (isFinite(patch.dim)) cfg.dim = Math.max(0, Math.min(0.85, Number(patch.dim)));
        saveCfg();
      }
      return apply();
    },
    pick: pick,
    use: use,
    remove: remove,
    clear: clear,
    apply: apply,
    list: function () { return cfg.hist.slice(); },
    thumb: urlFor, // id → Promise<objectURL|null>
    hasImage: function () { return migrateLegacy().then(function () { return !!cfg.cur; }); },
    previewUrl: ensureUrl,
    thumbUrl: function () { return cfg.cur ? (urlCache[cfg.cur] || '') : ''; }
  };

  // 启动即应用（不必先打开设置中心；无图时静默回落各主题原氛围背景）
  apply();
})();
