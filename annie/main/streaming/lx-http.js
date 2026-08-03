'use strict';
// Minimal fetch wrapper compatible with LX's httpFetch API.
// Replaces @renderer/utils/request.js for Annie main process.
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function httpFetch(url, options = {}) {
  const { method = 'GET', headers: optHeaders = {}, body, form, timeout: timeoutMs = 15000, family, lookup } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let reqBody = body;
  let bodyIsForm = false;
  if (reqBody == null && form != null) {
    reqBody = new URLSearchParams(form).toString();
    bodyIsForm = true;
  }

  const init = {
    method: method.toUpperCase(),
    headers: { 'User-Agent': UA, ...optHeaders },
    signal: controller.signal,
  };
  if (reqBody != null) init.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
  // Content-Type 推断：form 参数 → urlencoded；对象 body（JSON 字符串）→ application/json。
  // 此前统一按 urlencoded 处理导致 QQ musics.fcg 等接口拒绝 JSON body 请求。
  if (typeof reqBody === 'string' && !init.headers['Content-Type']) {
    init.headers['Content-Type'] = bodyIsForm ? 'application/x-www-form-urlencoded' : 'application/json';
  }

  // cancel-ability
  let cancelled = false;
  const cancelHttp = () => { cancelled = true; controller.abort(); };

  const promise = fetch(url, init).then(async res => {
    clearTimeout(timer);
    const statusCode = res.status;
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const raw = Buffer.from(await res.arrayBuffer());
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      body = raw.toString('utf8');
    }
    return { statusCode, headers, body, raw };
  }).catch(err => {
    clearTimeout(timer);
    if (cancelled) throw new Error('cancelled');
    throw err;
  });

  return { promise, cancelHttp };
}

/** MD5 hex */
function toMD5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

module.exports = { httpFetch, toMD5, UA };
