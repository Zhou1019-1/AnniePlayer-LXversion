const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export function httpFetch(url, options = {}) {
  const { method = 'GET', headers: optHeaders = {}, body, form, timeout: timeoutMs = 15000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reqBody = body, bodyIsForm = false;
  if (reqBody == null && form != null) {
    reqBody = new URLSearchParams(form).toString(); bodyIsForm = true;
  } else if (reqBody != null && typeof reqBody !== 'string') {
    reqBody = JSON.stringify(reqBody);
  }
  const init = { method: method.toUpperCase(),
                 headers: { 'User-Agent': UA, ...optHeaders },
                 signal: controller.signal };
  if (reqBody != null) init.body = reqBody;
  if (reqBody != null && !init.headers['Content-Type']) {
    init.headers['Content-Type'] = bodyIsForm ? 'application/x-www-form-urlencoded' : 'application/json';
  }
  let cancelled = false;
  const cancelHttp = () => { cancelled = true; controller.abort(); };
  const promise = fetch(url, init).then(async res => {
    clearTimeout(timer);
    const statusCode = res.status, headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const raw = new Uint8Array(await res.arrayBuffer());
    let body;
    const text = new TextDecoder().decode(raw);
    try {
      body = JSON.parse(text);
    } catch {
      // ⚠️ 酷我等接口返回的是「单引号伪 JSON」（2026-10-21）：
      //    形如 {'AARTIST':'xxx',...}，标准 JSON.parse 会失败。
      //    用 Function 求值（比 eval 稍安全，作用域隔离）。
      try {
        body = (new Function('return (' + text + ')'))();
      } catch {
        body = text;
      }
    }
    return { statusCode, headers, body, raw };
  }).catch(err => {
    clearTimeout(timer);
    if (cancelled) throw new Error('cancelled');
    throw err;
  });
  return { promise, cancelHttp };
}
export default { httpFetch };
