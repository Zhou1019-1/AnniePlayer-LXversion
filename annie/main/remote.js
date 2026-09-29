'use strict';
/* 局域网手机遥控（脑暴 9.1）：主进程原生 http + SSE，零依赖。
 * 手机浏览器访问 http://电脑IP:端口 → 配对码配对 → 遥控面板（封面/进度/传输控制/音量/播放模式/实时歌词）。
 * 状态由渲染层桥（renderer/js/local/remote.js）推送；指令经 main.js 转发给渲染层执行。
 * 安全：4 位配对码（设置里可见/可重置），配对成功发 token（持久化于 store.remote.tokens）；
 *       配对失败 5 次锁 30 秒防局域网易猜。 */

const http = require('http');
const os = require('os');
const crypto = require('crypto');

let server = null;
let boundPort = 0;
let getRemoteConf = null;   // () => ({ code, tokens: [] }) 持久化读写由 main.js 注入
let saveTokens = null;      // (tokens) => void
let forwardCmd = null;      // (cmd, value) => void 转发渲染层
const sseClients = new Set();
let lastStateJson = '';
let pairFails = 0;
let pairLockUntil = 0;

const BASE_PORT = 45823;
const CMDS = new Set(['playpause', 'next', 'prev', 'seek', 'volume', 'mode']);

function lanAddrs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal
        && !it.address.startsWith('169.254.')   // 链路本地（无 DHCP 自分配）
        && !it.address.startsWith('198.18.')) { // Clash fake-ip 虚拟网卡
        out.push(it.address);
      }
    }
  }
  return out;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, cb) {
  let data = '';
  req.on('data', (c) => {
    data += c;
    if (data.length > 64 * 1024) { req.destroy(); }
  });
  req.on('end', () => {
    try { cb(JSON.parse(data || '{}')); } catch { cb(null); }
  });
}

function tokenOf(req, url) {
  return url.searchParams.get('token') || req.headers['x-remote-token'] || '';
}

function tokenValid(tok) {
  const conf = getRemoteConf ? getRemoteConf() : null;
  return !!(tok && conf && Array.isArray(conf.tokens) && conf.tokens.includes(tok));
}

function normCode(s) {
  // 手机中文输入法常打出全角数字（７４０３），归一成半角再比；顺带吞掉空白
  return String(s == null ? '' : s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '');
}

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (path === '/' || path === '/index.html') {
    send(res, 200, PAGE, 'text/html; charset=utf-8');
    return;
  }

  if (path === '/api/pair' && req.method === 'POST') {
    const now = Date.now();
    if (now < pairLockUntil) { sendJson(res, 429, { ok: false, retryAfter: Math.ceil((pairLockUntil - now) / 1000) }); return; }
    readBody(req, (body) => {
      const conf = getRemoteConf ? getRemoteConf() : null;
      const got = normCode(body && body.code);
      const want = normCode(conf && conf.code);
      console.log('[remote] 配对尝试 收到:', JSON.stringify(got), '期望:', JSON.stringify(want), '原始body:', body ? 'ok' : 'null');
      if (!body || got !== want || !want) {
        pairFails++;
        if (pairFails >= 5) { pairFails = 0; pairLockUntil = Date.now() + 30 * 1000; }
        sendJson(res, 403, { ok: false });
        return;
      }
      pairFails = 0;
      const token = crypto.randomBytes(16).toString('hex');
      const tokens = (conf.tokens || []).concat(token).slice(-20); // 最多留 20 台设备
      if (saveTokens) saveTokens(tokens);
      sendJson(res, 200, { ok: true, token });
    });
    return;
  }

  // 以下接口全部要 token（/api/cmd 的 token 在 body 里，单独校验）
  if (path !== '/api/cmd' && !tokenValid(tokenOf(req, url))) { sendJson(res, 401, { ok: false, error: 'unauthorized' }); return; }

  if (path === '/api/state' && req.method === 'GET') {
    send(res, 200, lastStateJson || '{}', 'application/json; charset=utf-8');
    return;
  }

  if (path === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (lastStateJson) res.write('event: state\ndata: ' + lastStateJson + '\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (path === '/api/cmd' && req.method === 'POST') {
    readBody(req, (body) => {
      if (!body || !tokenValid(String(body.token || ''))) { sendJson(res, 401, { ok: false, error: 'unauthorized' }); return; }
      if (!CMDS.has(body.cmd)) { sendJson(res, 400, { ok: false, error: 'bad cmd' }); return; }
      let value = body.value;
      if (body.cmd === 'seek' || body.cmd === 'volume') {
        value = Number(value);
        if (!Number.isFinite(value)) { sendJson(res, 400, { ok: false, error: 'bad value' }); return; }
        if (body.cmd === 'volume') value = Math.max(0, Math.min(1, value));
      }
      if (forwardCmd) forwardCmd(body.cmd, value);
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  sendJson(res, 404, { ok: false });
}

function tryListen(p, triesLeft, done) {
  const srv = http.createServer(handle);
  srv.once('error', () => {
    srv.close();
    if (triesLeft > 0) tryListen(p + 1, triesLeft - 1, done);
    else done(null);
  });
  srv.listen(p, '0.0.0.0', () => done(srv, p));
}

function start() {
  if (server) return info();
  return new Promise((resolve) => {
    tryListen(BASE_PORT, 10, (srv, p) => {
      if (!srv) { resolve({ ok: false, error: '端口不可用' }); return; }
      server = srv;
      boundPort = p;
      resolve(info());
    });
  });
}

function stop() {
  for (const res of sseClients) { try { res.end(); } catch { } }
  sseClients.clear();
  if (server) { try { server.close(); } catch { } server = null; }
  boundPort = 0;
  lastStateJson = '';
}

function info() {
  return {
    ok: !!server,
    port: boundPort,
    addrs: server ? lanAddrs().map((ip) => 'http://' + ip + ':' + boundPort) : [],
  };
}

function pushState(stateObj) {
  try { lastStateJson = JSON.stringify(stateObj || {}); } catch { return; }
  if (!sseClients.size) return;
  const payload = 'event: state\ndata: ' + lastStateJson + '\n\n';
  for (const res of sseClients) { try { res.write(payload); } catch { } }
}

function init(opts) {
  getRemoteConf = opts.getRemoteConf;
  saveTokens = opts.saveTokens;
  forwardCmd = opts.forwardCmd;
}

module.exports = { init, start, stop, info, pushState };

/* ---------------- 手机端页面（内嵌，免打包路径问题） ---------------- */
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#101014">
<title>安妮遥控</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:#101014; color:#eee; font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; min-height:100vh; display:flex; flex-direction:column; }
  #pair { margin:auto; text-align:center; padding:24px; }
  #pair h1 { font-size:20px; font-weight:600; }
  #pair p { color:#999; font-size:13px; }
  #pair input { font-size:28px; letter-spacing:12px; text-align:center; width:200px; padding:10px 0 10px 12px; border-radius:12px; border:1px solid #333; background:#1a1a20; color:#fff; outline:none; }
  #pair button { display:block; margin:16px auto 0; padding:10px 40px; font-size:16px; border:0; border-radius:12px; background:#4a6cf7; color:#fff; }
  #pair .err { color:#ff6b6b; font-size:13px; min-height:18px; }
  #main { display:none; flex-direction:column; min-height:100vh; padding:16px 16px calc(16px + env(safe-area-inset-bottom)); max-width:520px; margin:0 auto; width:100%; }
  #cover { width:100%; aspect-ratio:1; border-radius:18px; object-fit:cover; background:#1c1c24; display:block; }
  #title { font-size:19px; font-weight:600; margin:14px 0 2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #artist { font-size:14px; color:#999; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #lyr { flex:1; min-height:96px; max-height:30vh; overflow:hidden; margin:12px 0; text-align:center; position:relative; -webkit-mask-image:linear-gradient(#0000,#000 25%,#000 75%,#0000); mask-image:linear-gradient(#0000,#000 25%,#000 75%,#0000); }
  #lyr .l { font-size:14px; color:#777; padding:5px 0; transition:all .3s; }
  #lyr .l.cur { color:#fff; font-size:16px; font-weight:600; }
  #lyr .l .t { display:block; font-size:11px; color:#666; font-weight:400; }
  #lyr .l.cur .t { color:#9db4ff; }
  #bar { height:28px; display:flex; align-items:center; cursor:pointer; touch-action:none; }
  #bar .track { width:100%; height:4px; border-radius:2px; background:#2a2a33; position:relative; }
  #bar .fill { height:100%; border-radius:2px; background:#4a6cf7; width:0%; }
  #times { display:flex; justify-content:space-between; font-size:11px; color:#888; margin-top:2px; }
  #ctrl { display:flex; align-items:center; justify-content:center; gap:36px; margin:14px 0 6px; }
  #ctrl button { border:0; background:none; color:#fff; font-size:34px; padding:8px; }
  #ctrl #b-play { font-size:52px; }
  #row2 { display:flex; align-items:center; gap:12px; }
  #b-mode { border:1px solid #333; background:#1a1a20; color:#ccc; border-radius:10px; font-size:13px; padding:6px 10px; white-space:nowrap; }
  #vol { flex:1; accent-color:#4a6cf7; }
  #conn { position:fixed; top:8px; right:10px; font-size:11px; color:#666; }
  #conn.bad { color:#ff6b6b; }
</style>
</head>
<body>
<div id="pair">
  <h1>安妮遥控</h1>
  <p>输入电脑端 设置 → 手机遥控 里显示的 4 位配对码</p>
  <input id="code" inputmode="numeric" maxlength="4" autocomplete="off">
  <div class="err" id="pair-err"></div>
  <button id="b-pair">配 对</button>
</div>
<div id="main">
  <div id="conn">已连接</div>
  <img id="cover" alt="">
  <div id="title">—</div>
  <div id="artist">—</div>
  <div id="lyr"></div>
  <div id="bar"><div class="track"><div class="fill" id="fill"></div></div></div>
  <div id="times"><span id="t-cur">0:00</span><span id="t-total">0:00</span></div>
  <div id="ctrl">
    <button id="b-prev">⏮</button>
    <button id="b-play">▶</button>
    <button id="b-next">⏭</button>
  </div>
  <div id="row2">
    <button id="b-mode">顺序</button>
    <input type="range" id="vol" min="0" max="100" value="100">
  </div>
</div>
<script>
(function () {
  var token = localStorage.getItem('annie-remote-token') || '';
  var es = null, state = null, volTimer = null;

  function $(id) { return document.getElementById(id); }
  function fmt(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

  function showPair(msg) {
    $('pair').style.display = 'block'; $('main').style.display = 'none';
    if (msg != null) $('pair-err').textContent = msg;
    if (es) { es.close(); es = null; }
  }
  function showMain() { $('pair').style.display = 'none'; $('main').style.display = 'flex'; }

  $('b-pair').onclick = function () {
    var code = $('code').value.trim();
    fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (x) {
        if (x.j && x.j.ok && x.j.token) {
          token = x.j.token; localStorage.setItem('annie-remote-token', token);
          showMain(); connect();
        } else if (x.status === 429) showPair('尝试太频繁，' + x.j.retryAfter + ' 秒后再试');
        else showPair('配对码不对');
      })
      .catch(function () { showPair('连不上电脑，确认在同一 Wi-Fi'); });
  };

  function cmd(c, v) {
    fetch('/api/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, cmd: c, value: v }) })
      .then(function (r) { if (r.status === 401) { localStorage.removeItem('annie-remote-token'); showPair('配对已失效，请重新配对'); } })
      .catch(function () { });
  }

  $('b-play').onclick = function () { cmd('playpause'); };
  $('b-prev').onclick = function () { cmd('prev'); };
  $('b-next').onclick = function () { cmd('next'); };
  $('b-mode').onclick = function () { cmd('mode', 'cycle'); };
  $('vol').oninput = function () {
    $('vol').style.opacity = 0.7;
    clearTimeout(volTimer);
    volTimer = setTimeout(function () { cmd('volume', $('vol').value / 100); }, 120);
  };
  $('bar').addEventListener('pointerdown', function (e) {
    if (!state || !state.duration) return;
    var r = $('bar').getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    cmd('seek', ratio * state.duration);
  });

  function render(st) {
    state = st;
    $('title').textContent = st.title || '未在播放';
    $('artist').textContent = st.artist || '';
    if (st.cover) $('cover').src = st.cover; else $('cover').removeAttribute('src');
    $('b-play').textContent = st.playing ? '⏸' : '▶';
    $('fill').style.width = st.duration ? Math.min(100, st.position / st.duration * 100) + '%' : '0%';
    $('t-cur').textContent = fmt(st.position);
    $('t-total').textContent = fmt(st.duration);
    if (st.mode && st.mode.label) $('b-mode').textContent = st.mode.icon + ' ' + st.mode.label;
    if (document.activeElement !== $('vol') && st.volume != null) { $('vol').value = Math.round(st.volume * 100); $('vol').style.opacity = 1; }
    var lyr = $('lyr');
    if (st.lyric && st.lyric.lines && st.lyric.lines.length) {
      var L = st.lyric.lines, cur = st.lyric.cur;
      var from = Math.max(0, cur - 2), to = Math.min(L.length, cur + 4);
      if (cur < 0) { from = 0; to = Math.min(L.length, 5); }
      var html = '';
      for (var i = from; i < to; i++) {
        html += '<div class="l' + (i === cur ? ' cur' : '') + '">' + esc(L[i].txt) +
          (L[i].tly ? '<span class="t">' + esc(L[i].tly) + '</span>' : '') + '</div>';
      }
      lyr.innerHTML = html;
    } else {
      lyr.innerHTML = st.title ? '<div class="l cur">纯音乐 / 暂无歌词</div>' : '';
    }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function connect() {
    if (es) es.close();
    es = new EventSource('/events?token=' + encodeURIComponent(token));
    es.addEventListener('state', function (e) {
      $('conn').textContent = '已连接'; $('conn').className = '';
      try { render(JSON.parse(e.data)); } catch (err) { }
    });
    es.onerror = function () { $('conn').textContent = '连接中断，重连中…'; $('conn').className = 'bad'; };
  }

  if (token) {
    fetch('/api/state?token=' + encodeURIComponent(token))
      .then(function (r) {
        if (r.status === 401) { localStorage.removeItem('annie-remote-token'); showPair(''); return; }
        showMain(); return r.json();
      })
      .then(function (st) { if (st) { render(st); connect(); } })
      .catch(function () { showPair('连不上电脑，确认安妮播放器已开启遥控'); });
  } else {
    showPair('');
  }
})();
</script>
</body>
</html>`;
