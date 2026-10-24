// 洛雪自定义音源沙箱（浏览器版）
//
// 音源脚本通过 globalThis.lx 注册处理器：
//   const { EVENT_NAMES, request, on, send, env } = globalThis.lx
//   on(EVENT_NAMES.request, async ({ action, source, info }) => {
//     if (action === 'musicUrl') return 'https://...'
//   })
//
// 我们提供这套 API，让脚本以为自己在洛雪里跑。

export function createSandbox() {
  const handlers = {};
  const EVENT_NAMES = {
    request: 'request',
    inited: 'inited',
    updateAlert: 'updateAlert',
  };

  // ---- buffer 工具 ----
  const bufferUtils = {
    from(str, enc) {
      if (enc === 'base64') {
        const bin = atob(str);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      if (enc === 'hex') {
        const out = new Uint8Array(str.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
        return out;
      }
      return new TextEncoder().encode(str);
    },
    bufToString(buf, enc) {
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      if (enc === 'base64') {
        let s = '';
        for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return btoa(s);
      }
      return new TextDecoder().decode(u8);
    },
  };

  // ---- request：HTTP 请求（走桥接的 fetch）----
  function request(url, options, callback) {
    const opts = options || {};
    // 兼容三种调用：request(url, cb) / request(url, opts, cb) / request(url, opts)
    let cb = callback;
    if (typeof options === 'function') { cb = options; }
    const promise = fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
    }).then(async res => {
      const text = await res.text();
      return { statusCode: res.status, headers: {}, body: text };
    });
    if (cb) {
      promise.then(r => cb(null, r, r.body)).catch(e => cb(e));
      return;
    }
    return promise;
  }

  const lx = {
    EVENT_NAMES,
    eventNames: EVENT_NAMES,
    request,
    on(name, handler) {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(handler);
    },
    send(name, data) {
      const hs = handlers[name] || [];
      for (const h of hs) {
        try { h(data); } catch (e) { console.error('[lx-sandbox] send 处理出错', e); }
      }
    },
    env: 'desktop',
    version: '2.0.0',
    utils: { buffer: bufferUtils },
    currentScriptInfo: {},
  };

  return {
    lx,
    handlers,
    EVENT_NAMES,
    /** 调用 request 处理器（音乐地址/歌词等） */
    async invoke(action, source, info) {
      const hs = handlers[EVENT_NAMES.request] || [];
      if (!hs.length) throw new Error('音源脚本没有注册 request 处理器');
      // 洛雪约定：先用参数校验，再返回结果
      for (const h of hs) {
        const r = await h({ action, source, info });
        if (r != null) return r;
      }
      throw new Error('音源没有返回结果');
    },
  };
}
