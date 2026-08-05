'use strict';
// ============================================================================
// 音源沙箱 Worker —— 隔离第三方音源脚本的执行环境。
// 脚本在主进程 vm 沙箱内同步执行，死循环/超重同步计算会冻结整个主进程；
// 迁移到 worker_threads 后，脚本卡死只阻塞本 Worker，主进程可 terminate 熔断重建。
// 消息协议（主进程 ⇄ Worker）:
//   主→Worker: {type:'init', dir, entries} | {type:'load', entry} | {type:'unload', id}
//               | {type:'request', jobId, sourceId|null, action, source, info} | {type:'ping', id}
//   Worker→主: {type:'ready'} | {type:'loaded', id, ok, error?} | {type:'unloaded', id}
//               | {type:'pong', id} | {type:'result', jobId, ok, value?|error?}
// 结果统一 JSON 序列化往返（与跨线程结构化克隆相比行为更可控，兼容 Buffer/字符串/对象）。
// ============================================================================
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { httpFetch } = require('./lx-http');

let _dir = '';
const _runtimes = new Map(); // id -> {handler, info}

/* ---------------- 工具（与主进程原实现一致） ---------------- */
function md5(s) {
  return crypto.createHash('md5').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');
}
function aesEncrypt(data, mode, key, iv) {
  const m = String(mode || 'ecb').toLowerCase();
  const alg = m.startsWith('aes-') ? m : `aes-128-${m}`;
  const cipher = crypto.createCipheriv(alg, key, alg.endsWith('ecb') ? null : (iv || Buffer.alloc(16)));
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

/* ---------------- LX API 沙箱（与迁移前逐字段一致） ---------------- */
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
    return cancelHttp;
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
      if (eventName === EVENT_NAMES.inited) {
        return Promise.resolve();
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
    Buffer: undefined,
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
    try { Promise.resolve(state.initedHandler({ status: true, sources: {} })).catch(() => { }); } catch { }
  }
}

/* ---------------- 消息处理 ---------------- */
function post(obj) { parentPort.postMessage(obj); }

/** 结果统一 JSON 序列化：URL 字符串/普通对象直接透传；Buffer 转 {type:'Buffer',data}；不可序列化降级 String */
function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return String(value);
  }
}

function handleRequestMessage(msg) {
  const rt = msg.sourceId ? _runtimes.get(msg.sourceId) : null;
  Promise.resolve()
    .then(() => {
      if (!rt) throw new Error(msg.sourceId ? '音源未加载' : '没有已启用的音源');
      return rt.handler({ action: msg.action, source: msg.source, info: msg.info });
    })
    .then((value) => post({ type: 'result', jobId: msg.jobId, ok: true, value: safeClone(value) }))
    .catch((err) => post({ type: 'result', jobId: msg.jobId, ok: false, error: String((err && err.message) || err) }));
}

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'init':
      _dir = msg.dir;
      for (const entry of msg.entries) {
        try {
          loadRuntime(entry);
          post({ type: 'loaded', id: entry.id, ok: true });
        } catch (e) {
          post({ type: 'loaded', id: entry.id, ok: false, error: String(e.message || e) });
        }
      }
      break;
    case 'load':
      try {
        loadRuntime(msg.entry);
        post({ type: 'loaded', id: msg.entry.id, ok: true });
      } catch (e) {
        post({ type: 'loaded', id: msg.entry.id, ok: false, error: String(e.message || e) });
      }
      break;
    case 'unload':
      _runtimes.delete(msg.id);
      post({ type: 'unloaded', id: msg.id });
      break;
    case 'request':
      handleRequestMessage(msg);
      break;
    case 'ping':
      post({ type: 'pong', id: msg.id });
      break;
  }
});

post({ type: 'ready' });
