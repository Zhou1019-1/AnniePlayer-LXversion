'use strict';
/* ============================================================
 * 音源沙箱端到端验证（V4.0.3）
 * fork 真实的 sources-worker.js（带 --disallow-code-generation-from-strings），
 * 验证：1) 正常音源脚本可加载可请求  2) 恶意脚本逃逸/挂死被阻断或超时
 * 用法：node scripts/sandbox-e2e-test.js
 * ============================================================ */
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKER = path.join(__dirname, '../annie/main/streaming/sources-worker.js');

/* 正常脚本：洛雪协议最简实现 */
const GOOD = `
globalThis.lx.on('request', function (info) {
  if (info.action === 'musicUrl') return Promise.resolve('https://example.com/test.mp3');
  return Promise.reject(new Error('unsupported'));
});
globalThis.lx.on('inited', function () { return Promise.resolve(); });
`;
/* 恶意脚本：加载时不动作，请求时尝试经典 constructor 逃逸读 process */
const EVIL = `
globalThis.lx.on('request', function () {
  try {
    var p = console.log.constructor('return process')();
    return Promise.resolve('ESCAPED:' + p.versions.node);
  } catch (e) {
    return Promise.reject(new Error('blocked: ' + e.message));
  }
});
`;
/* 挂死脚本：永不 resolve */
const HANG = `globalThis.lx.on('request', function () { return new Promise(function(){}); });`;

function forkSandbox() {
  return fork(WORKER, [], { execArgv: ['--disallow-code-generation-from-strings'] });
}
function once(child, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs);
    const h = (m) => { if (pred(m)) { clearTimeout(timer); child.off('message', h); resolve(m); } };
    child.on('message', h);
  });
}
const assert = (cond, name) => {
  if (!cond) { console.error('✗ ' + name); process.exitCode = 1; }
  else console.log('✓ ' + name);
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-sandbox-e2e-'));
  fs.writeFileSync(path.join(dir, 'good.js'), GOOD);
  fs.writeFileSync(path.join(dir, 'evil.js'), EVIL);
  fs.writeFileSync(path.join(dir, 'hang.js'), HANG);

  const child = forkSandbox();
  try {
    await once(child, m => m.type === 'ready');
    assert(true, '沙箱子进程就绪');
    child.send({ type: 'init', dir, entries: [] }); // init 负责设定脚本目录（_dir）

    // 1) 正常脚本：加载 + 请求
    child.send({ type: 'load', entry: { id: 'good', name: 'good' } });
    const lg = await once(child, m => m.type === 'loaded' && m.id === 'good');
    assert(lg.ok === true, '正常脚本加载成功' + (lg.error ? '（' + lg.error + '）' : ''));
    child.send({ type: 'request', jobId: 1, sourceId: 'good', action: 'musicUrl', source: 'kg', info: {} });
    const r1 = await once(child, m => m.type === 'result' && m.jobId === 1);
    assert(r1.ok && r1.value === 'https://example.com/test.mp3', '正常脚本请求返回 URL');
    if (!r1.ok || r1.value !== 'https://example.com/test.mp3') console.log('  实际:', JSON.stringify(r1));

    // 2) 恶意脚本：逃逸必须失败（错误信息应含 blocked/EvalError，而不是 ESCAPED）
    child.send({ type: 'load', entry: { id: 'evil', name: 'evil' } });
    const le = await once(child, m => m.type === 'loaded' && m.id === 'evil');
    assert(le.ok === true, '恶意脚本可加载（加载期无恶意行为）');
    child.send({ type: 'request', jobId: 2, sourceId: 'evil', action: 'musicUrl', source: 'kg', info: {} });
    const r2 = await once(child, m => m.type === 'result' && m.jobId === 2);
    assert(!r2.ok && !String(r2.value || '').startsWith('ESCAPED'), 'constructor 逃逸被阻断: ' + (r2.error || '').slice(0, 60));

    // 3) 挂死脚本：15s 内部超时兜底（测试等不起 15s，这里验证 ping 仍活着即可）
    child.send({ type: 'load', entry: { id: 'hang', name: 'hang' } });
    await once(child, m => m.type === 'loaded' && m.id === 'hang');
    child.send({ type: 'request', jobId: 3, sourceId: 'hang', action: 'musicUrl', source: 'kg', info: {} });
    child.send({ type: 'ping', id: 'p1' });
    const pong = await once(child, m => m.type === 'pong' && m.id === 'p1', 3000);
    assert(!!pong, '挂死请求不阻塞事件循环（ping 有响应，主进程可正常熔断）');
  } finally {
    child.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
  console.log(process.exitCode ? '\n沙箱端到端验证：存在失败项' : '\n沙箱端到端验证：全部通过');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('✗ 测试异常:', e); process.exit(1); });
