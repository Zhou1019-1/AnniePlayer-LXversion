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
  let bodyIsJson = false;
  if (reqBody == null && form != null) {
    reqBody = new URLSearchParams(form).toString();
    bodyIsForm = true;
  } else if (reqBody != null && typeof reqBody !== 'string') {
    reqBody = JSON.stringify(reqBody);
    bodyIsJson = true;
  }

  const init = {
    method: method.toUpperCase(),
    headers: { 'User-Agent': UA, ...optHeaders },
    signal: controller.signal,
  };
  if (reqBody != null) init.body = reqBody;
  // Content-Type 推断：form 参数 → urlencoded；对象 body → application/json；字符串 body 且未显式指定 → application/json。
  // 修复：此前只在 typeof reqBody === 'string' 时推断——对象 body 被 JSON.stringify 后漏设 Content-Type，
  // 导致音源脚本 POST JSON 被服务器拒（HTTP 415 Unsupported Media Type，实测 Elite 音源 /api/encrypt）。
  if (reqBody != null && !init.headers['Content-Type']) {
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
