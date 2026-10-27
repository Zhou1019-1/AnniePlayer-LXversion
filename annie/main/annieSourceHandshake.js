// ===== 安妮音源心跳端点（V4.6：音源仅可在安妮播放器内运行）=====
// 轻量 HTTP 端点，音源脚本（沙箱子进程）定期 POST 验证宿主身份。
// 端口动态分配（listen(0)），路径+密钥仅本进程内可知——外部播放器无法伪造。
'use strict';
const http = require('http');
const crypto = require('crypto');

let server = null;
let boundPort = 0;
let secret = ''; // 本次启动的握手密钥（随机生成，重启即变）
/** 独家音源的身份标签（插件可回带，非空时必须一致） */
const IDENTITY_TAG = '安妮音源';
/* V4.6.1：监听就绪信号——音源沙箱加载前必须等端点真正 listen 完成，
 * 否则「插件心跳」会跑在「端点已就绪」之前 → ECONNREFUSED → 心跳假失败（已踩）。 */
let listening = false;
let readyPromise = null;
let resolveReady = null;

/* 同步随机选端口（20000-60000）：listen(0) 异步回调才出端口，
 * 而 getHandshake() 同步返回——沙箱 init 时会拿到 port:0 导致心跳永远失败（已踩） */
function pickPort() {
  return 20000 + (crypto.randomBytes(2).readUInt16BE(0) % 40000);
}

/* 启动心跳端点（主进程启动时调用一次；getHandshake 有懒启动兜底） */
function start() {
  if (server) return { port: boundPort };
  secret = crypto.randomBytes(16).toString('hex'); // 每次启动随机密钥
  listening = false;
  readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*'); // 音源沙箱子进程跨域
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    // 唯一握手协议（以「章鱼音源特供版」为准）：POST /heartbeat
    if (req.method === 'POST' && req.url === '/heartbeat') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          // 唯一判定：密钥一致（+ 声明了 tag 就必须是安妮音源）。
          // 不再分 client / source 两套写法 —— 以「章鱼音源特供版」的 body 形状为准。
          const tag = j.tag == null ? '' : String(j.tag).trim();
          if (j.key === secret && (!tag || tag === IDENTITY_TAG)) {
            // 主字段 status（插件读它）；ok 仅作等价冗余，方便日志/旧脚本一眼看懂
            res.writeHead(200);
            res.end(JSON.stringify({
              status: 'ok',
              ok: true,
              ts: Date.now(),
              tag: j.tag || '',
              ver: j.ver || '',
            }));
            return;
          }
        } catch { }
        res.writeHead(403); res.end(JSON.stringify({ status: 'error', ok: false }));
      });
      return;
    }
    res.writeHead(404); res.end(JSON.stringify({ status: 'error', ok: false }));
  });
  const onErr = () => { // 端口被占：换随机端口重试
    boundPort = pickPort();
    server.listen(boundPort, '127.0.0.1');
  };
  server.on('error', onErr);
  boundPort = pickPort();
  server.listen(boundPort, '127.0.0.1', () => {
    server.removeListener('error', onErr);
    server.on('error', () => { }); // 监听成功后兜底吞掉运行期 error（无监听者的 error 事件会崩主进程）
    listening = true;
    if (resolveReady) { resolveReady(); resolveReady = null; }
    console.log('[annie-source] 心跳端点已就绪：127.0.0.1:' + boundPort);
  });
  return { port: boundPort };
}

/* 等待端点真正进入 listen 状态（音源沙箱加载前调用；已就绪则立即 resolve） */
function ready() {
  if (listening) return Promise.resolve();
  if (!server) start();
  return readyPromise || Promise.resolve();
}

/* 音源沙箱取握手参数（IPC 调用，仅主进程内可调） */
function getHandshake() {
  if (!boundPort) start(); // 懒启动兜底
  return { port: boundPort, key: secret };
}

function shutdown() {
  try { if (server) server.close(); } catch { }
  server = null; boundPort = 0; secret = '';
  listening = false; readyPromise = null; resolveReady = null;
}

module.exports = { start, ready, getHandshake, shutdown };
