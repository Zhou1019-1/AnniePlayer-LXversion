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
const CMDS = new Set(['playpause', 'next', 'prev', 'seek', 'volume', 'mode', 'playpath']);

/* 遥控二期（V4.3.18）：渲染层推送的曲库快照 [{p,t,ar,al}]，内存驻留，供手机端搜索/翻页/点播 */
let libSnapshot = [];
function pushLibrary(list) {
  if (!Array.isArray(list)) return;
  libSnapshot = list.filter((r) => r && r.p).slice(0, 50000);
}

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

  // 遥控二期：曲库搜索 + 分页（q 匹配歌名/歌手/专辑/路径文件名，大小写不敏感）
  if (path === '/api/library' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const off = Math.max(0, parseInt(url.searchParams.get('off'), 10) || 0);
    const lim = Math.min(200, Math.max(1, parseInt(url.searchParams.get('lim'), 10) || 80));
    let items = libSnapshot;
    if (q) {
      items = items.filter((r) =>
        (r.t && r.t.toLowerCase().includes(q)) ||
        (r.ar && r.ar.toLowerCase().includes(q)) ||
        (r.al && r.al.toLowerCase().includes(q)) ||
        r.p.toLowerCase().includes(q));
    }
    sendJson(res, 200, { total: items.length, items: items.slice(off, off + lim) });
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
      if (body.cmd === 'playpath') { // 遥控二期：点歌（本地曲库路径，渲染层校验存在性）
        value = String(value == null ? '' : value);
        if (!value || value.length > 2000) { sendJson(res, 400, { ok: false, error: 'bad value' }); return; }
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

module.exports = { init, start, stop, info, pushState, pushLibrary };

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
  /* 遥控二期：页签 + 曲库点播 */
  #tabs { display:flex; gap:8px; margin-bottom:12px; }
  #tabs button { flex:1; padding:8px 0; border-radius:10px; border:1px solid #333; background:#1a1a20; color:#999; font-size:14px; }
  #tabs button.on { background:#4a6cf7; border-color:#4a6cf7; color:#fff; }
  #view-play { display:flex; flex-direction:column; flex:1; min-height:0; }
  #view-lib { display:none; flex-direction:column; flex:1; min-height:0; }
  #lib-search { width:100%; padding:10px 14px; border-radius:12px; border:1px solid #333; background:#1a1a20; color:#fff; font-size:15px; outline:none; margin-bottom:8px; }
  #lib-list { flex:1; overflow-y:auto; min-height:200px; max-height:calc(100vh - 190px); }
  .lib-row { padding:10px 6px; border-bottom:1px solid #222; }
  .lib-row:active { background:#1c1c26; }
  .lib-row .t { font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .lib-row .a { font-size:12px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #lib-status { text-align:center; color:#666; font-size:12px; padding:10px 0; }
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
  <div id="tabs"><button id="tab-play" class="on">正在播放</button><button id="tab-lib">曲库点播</button></div>
  <div id="view-play">
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
  <div id="view-lib">
    <input id="lib-search" placeholder="搜索歌名 / 歌手 / 专辑" autocomplete="off">
    <div id="lib-list"></div>
    <div id="lib-status"></div>
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

  /* ---- 遥控二期：页签 + 曲库点播 ---- */
  var libQ = '', libOff = 0, libTotal = 0, libLoading = false, libLoaded = false, libSearchTimer = null;

  function switchTab(w) {
    $('tab-play').className = w === 'play' ? 'on' : '';
    $('tab-lib').className = w === 'lib' ? 'on' : '';
    $('view-play').style.display = w === 'play' ? 'flex' : 'none';
    $('view-lib').style.display = w === 'lib' ? 'flex' : 'none';
    if (w === 'lib' && !libLoaded) libLoad(true);
  }
  $('tab-play').onclick = function () { switchTab('play'); };
  $('tab-lib').onclick = function () { switchTab('lib'); };

  function libLoad(reset) {
    if (libLoading) return;
    if (reset) { libOff = 0; $('lib-list').innerHTML = ''; }
    libLoading = true;
    $('lib-status').textContent = '加载中…';
    fetch('/api/library?token=' + encodeURIComponent(token) + '&q=' + encodeURIComponent(libQ) + '&off=' + libOff + '&lim=80')
      .then(function (r) {
        if (r.status === 401) { localStorage.removeItem('annie-remote-token'); showPair('配对已失效，请重新配对'); return null; }
        return r.json();
      })
      .then(function (j) {
        if (!j) return;
        libLoading = false; libLoaded = true;
        if (!j.items) { $('lib-status').textContent = '加载失败'; return; }
        libTotal = j.total;
        var html = '';
        for (var i = 0; i < j.items.length; i++) {
          var it = j.items[i];
          html += '<div class="lib-row" data-p="' + encodeURIComponent(it.p) + '">' +
            '<div class="t">' + esc(it.t || it.p.split(/[\\\\/]/).pop()) + '</div>' +
            '<div class="a">' + esc([it.ar, it.al].filter(Boolean).join(' · ')) + '</div></div>';
        }
        $('lib-list').insertAdjacentHTML('beforeend', html);
        libOff += j.items.length;
        $('lib-status').textContent = libTotal
          ? (libOff >= libTotal ? '共 ' + libTotal + ' 首' : '上滑加载更多（' + libOff + '/' + libTotal + '）')
          : (libQ ? '没有匹配「' + libQ + '」的歌曲' : '曲库为空或尚未同步，稍后再试');
      })
      .catch(function () { libLoading = false; $('lib-status').textContent = '加载失败，点搜索框重试'; });
  }
  $('lib-search').oninput = function () {
    clearTimeout(libSearchTimer);
    libSearchTimer = setTimeout(function () { libQ = $('lib-search').value.trim(); libLoad(true); }, 300);
  };
  $('lib-list').onscroll = function () {
    var el2 = $('lib-list');
    if (el2.scrollTop + el2.clientHeight >= el2.scrollHeight - 200 && libOff < libTotal) libLoad(false);
  };
  $('lib-list').onclick = function (e) {
    var row = e.target.closest ? e.target.closest('.lib-row') : null;
    if (!row) return;
    cmd('playpath', decodeURIComponent(row.getAttribute('data-p')));
    switchTab('play');
  };

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
