'use strict';
// ============================================================================
// 洛雪式自定义音源运行时（LX custom source API 兼容沙箱）
// 用户可导入第三方音源脚本(.js)，脚本通过 globalThis.lx API 注册请求处理器。
// 存储:
//   userData/stream-sources/        音源脚本文件(<id>.js)
//   userData/stream-sources.json    注册表 [{id,name,version,description,author,enabled}]
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { httpFetch } = require('./lx-http');

let _app = null;
let _dir = '';          // 脚本目录
let _registryFile = ''; // 注册表路径
let _registry = [];     // [{id,name,version,description,author,enabled}]
const _runtimes = new Map(); // id -> {handler, info}

/* ---------------- 工具 ---------------- */
function md5(s) {
  return crypto.createHash('md5').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');
}
function aesEncrypt(data, mode, key, iv) {
  // 兼容 lx utils.crypto.aesEncrypt(buffer|string, 'ecb'|'cbc'|'aes-128-ecb'|..., keyBuffer, ivBuffer)
  const m = String(mode || 'ecb').toLowerCase();
  const alg = m.startsWith('aes-') ? m : `aes-128-${m}`;
  const cipher = crypto.createCipheriv(alg, key, alg.endsWith('ecb') ? null : (iv || Buffer.alloc(16)));
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

/** 解析脚本头部注释元数据：@name @version @description @author */
function parseMeta(script, fallbackName) {
  const meta = { name: fallbackName, version: '', description: '', author: '' };
  const head = script.slice(0, 4000);
  const m = (k) => {
    const r = head.match(new RegExp(`@${k}\\s+([^\\r\\n*]+)`));
    return r ? r[1].trim() : '';
  };
  meta.name = m('name') || fallbackName;
  meta.version = m('version');
  meta.description = m('description');
  meta.author = m('author');
  return meta;
}

/* ---------------- LX API 沙箱 ---------------- */
function createSandbox(sourceId, scriptInfo) {
  const state = { requestHandler: null, initedHandler: null };
  const EVENT_NAMES = {
    request: 'request',
    inited: 'inited',
    updateAlert: 'updateAlert',
  };

  const lxRequest = (url, options, callback) => {
    const { promise, cancelHttp } = httpFetch(url, options || {});
    promise
      .then((resp) => {
        // 与洛雪 userApi 的 lx.request 契约一致：callback(err, resp, body)
        const respObj = {
          statusCode: resp.statusCode,
          statusMessage: '',
          headers: resp.headers || {},
          bytes: resp.raw ? resp.raw.length : 0,
          raw: resp.raw,
          body: resp.body,
        };
        callback(null, respObj, respObj.body);
      })
      .catch((err) => callback(err, null, null));
    return cancelHttp; // 洛雪约定：返回取消函数
  };

  const lxApi = {
    EVENT_NAMES,
    env: 'desktop',
    version: '2.0.0',
    currentScriptInfo: scriptInfo,
    on(eventName, handler) {
      if (eventName === EVENT_NAMES.request) state.requestHandler = handler;
      else if (eventName === EVENT_NAMES.inited) state.initedHandler = handler;
    },
    send(eventName, data) {
      if (eventName === EVENT_NAMES.request && state.requestHandler) {
        return Promise.resolve().then(() => state.requestHandler(data));
      }
      return Promise.reject(new Error('未知事件: ' + eventName));
    },
    request: lxRequest,
    utils: {
      crypto: {
        md5,
        aesEncrypt,
        randomBytes: (len) => crypto.randomBytes(len),
        buffer: Buffer,
      },
      buffer: {
        from: (...args) => Buffer.from(...args),
        bufToString: (buf, format) => Buffer.from(buf).toString(format === 'hex' ? 'hex' : 'utf8'),
      },
      zlib: {
        inflate: (data) => Promise.resolve(require('zlib').inflateSync(data)),
        deflate: (data) => Promise.resolve(require('zlib').deflateSync(data)),
      },
    },
  };

  const sandbox = {
    globalThis: null,
    lx: lxApi,
    window: { lx: lxApi },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    TextEncoder, TextDecoder,
    Buffer: undefined, // 不直接暴露，统一走 lx.utils
    fetch: undefined,
    require: undefined,
    process: undefined,
    module: undefined,
    exports: undefined,
  };
  sandbox.globalThis = sandbox;
  return { sandbox, state };
}

/* ---------------- 运行时管理 ---------------- */
function loadRuntime(entry) {
  const file = path.join(_dir, entry.id + '.js');
  const script = fs.readFileSync(file, 'utf8');
  const info = { name: entry.name, version: entry.version, description: entry.description, author: entry.author };
  const { sandbox, state } = createSandbox(entry.id, info);
  try {
    vm.createContext(sandbox, { name: 'lx-source:' + entry.id });
    vm.runInContext(script, sandbox, { timeout: 5000, filename: entry.id + '.js' });
  } catch (e) {
    _runtimes.delete(entry.id);
    throw new Error(`音源脚本执行失败: ${e.message}`);
  }
  if (typeof state.requestHandler !== 'function') {
    _runtimes.delete(entry.id);
    throw new Error('音源脚本未注册请求处理器 (lx.on("request", ...))');
  }
  _runtimes.set(entry.id, { handler: state.requestHandler, info });
  if (state.initedHandler) {
    try { Promise.resolve(state.initedHandler({ status: true, sources: {} })).catch(() => {}); } catch { }
  }
}

function saveRegistry() {
  fs.writeFileSync(_registryFile, JSON.stringify(_registry, null, 2), 'utf8');
}

function init(app) {
  _app = app;
  _dir = path.join(app.getPath('userData'), 'stream-sources');
  _registryFile = path.join(app.getPath('userData'), 'stream-sources.json');
  if (!fs.existsSync(_dir)) fs.mkdirSync(_dir, { recursive: true });
  try {
    _registry = JSON.parse(fs.readFileSync(_registryFile, 'utf8'));
  } catch { _registry = []; }
  // 加载所有启用的音源
  for (const entry of _registry) {
    if (!entry.enabled) continue;
    try { loadRuntime(entry); } catch (e) { console.warn('[lx-source] 加载失败', entry.id, e.message); }
  }
}

function list() {
  return _registry.map((e) => ({
    id: e.id, name: e.name, version: e.version,
    description: e.description, author: e.author,
    enabled: e.enabled, loaded: _runtimes.has(e.id),
  }));
}

/** 导入音源脚本（从给定路径复制进沙箱目录并验证） */
function importFromPath(srcPath) {
  const script = fs.readFileSync(srcPath, 'utf8');
  const meta = parseMeta(script, path.basename(srcPath, '.js'));
  // 生成稳定 id
  const id = 'src_' + md5(meta.name + Date.now()).slice(0, 10);
  const entry = { id, name: meta.name, version: meta.version, description: meta.description, author: meta.author, enabled: true };
  const dest = path.join(_dir, id + '.js');
  fs.writeFileSync(dest, script, 'utf8');
  // 先验证可运行再入册
  loadRuntime(entry);
  _registry = _registry.filter((e) => e.id !== id);
  _registry.push(entry);
  saveRegistry();
  return { id, name: entry.name, version: entry.version, description: entry.description, author: entry.author, enabled: true, loaded: true };
}

function remove(id) {
  _registry = _registry.filter((e) => e.id !== id);
  _runtimes.delete(id);
  try { fs.unlinkSync(path.join(_dir, id + '.js')); } catch { }
  saveRegistry();
  return { ok: true };
}

function setEnabled(id, enabled) {
  const entry = _registry.find((e) => e.id === id);
  if (!entry) throw new Error('音源不存在');
  entry.enabled = !!enabled;
  saveRegistry();
  if (enabled) {
    try { loadRuntime(entry); } catch (e) { entry.enabled = false; saveRegistry(); throw e; }
  } else {
    _runtimes.delete(id);
  }
  return { ok: true, enabled: entry.enabled };
}

/** 是否有可用（已加载）的自定义音源 */
function hasActiveSource() {
  return _registry.some((e) => e.enabled && _runtimes.has(e.id));
}

/**
 * 向已启用音源发起请求（洛雪协议）
 * @param {string} action 'musicUrl' | 'lyric' | 'hotSearch'
 * @param {object} payload { source, info }  source: kg/kw/tx/wy/mg
 */
async function handleRequest(action, payload, timeoutMs = 15000) {
  const enabled = _registry.filter((e) => e.enabled && _runtimes.has(e.id));
  if (!enabled.length) throw new Error('没有已启用的音源');
  const errors = [];
  for (const entry of enabled) {
    const rt = _runtimes.get(entry.id);
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => rt.handler({ action, source: payload.source, info: payload.info })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('音源响应超时')), timeoutMs)),
      ]);
      return { sourceId: entry.id, sourceName: entry.name, result };
    } catch (e) {
      errors.push(`${entry.name}: ${e.message}`);
    }
  }
  throw new Error(errors.join('；') || '所有音源均请求失败');
}

/** 指定具体音源发起请求 */
async function handleRequestById(id, action, payload, timeoutMs = 15000) {
  const rt = _runtimes.get(id);
  if (!rt) throw new Error('音源未加载');
  const result = await Promise.race([
    Promise.resolve().then(() => rt.handler({ action, source: payload.source, info: payload.info })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('音源响应超时')), timeoutMs)),
  ]);
  return { sourceId: id, sourceName: (_registry.find((e) => e.id === id) || {}).name || id, result };
}

module.exports = { init, list, importFromPath, remove, setEnabled, hasActiveSource, handleRequest, handleRequestById };
