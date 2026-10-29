'use strict';
/* scanWorker 按 jobId 取消机制集成测试（真实 worker_threads，纯 Node 可跑）
 * 跑法：node scripts/scan-worker-cancel-test.js */
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

const workerPath = path.join(__dirname, '..', 'annie', 'main', 'scanWorker.js');

function makeTree(root, n) {
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(root, `t${i}.mp3`), 'x');
  // 嵌套子目录增加扫描耗时窗口
  for (let d = 0; d < 3; d++) {
    const sub = path.join(root, 'sub' + d);
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(sub, `t${i}.flac`), 'x');
  }
}

async function run() {
  let pass = 0, fail = 0;
  const ok = (c, name) => { if (c) { pass++; console.log('  PASS', name); } else { fail++; console.error('  FAIL', name); } };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-scan-'));
  makeTree(dir, 400); // 400*4 = 1600 文件，足够产生多批次
  const w = new Worker(workerPath);
  const events = [];
  w.on('message', (m) => events.push(m));

  // 场景 1：scan job1 进行中，发「cancel(scan,1) + scan job2」连发（模拟手动扫描顶替）
  w.postMessage({ type: 'scan', jobId: 1, folders: [dir] });
  await new Promise(r => setTimeout(r, 5)); // 让 job1 启动
  w.postMessage({ type: 'cancel', kind: 'scan', jobId: 1 });
  w.postMessage({ type: 'scan', jobId: 2, folders: [dir] });

  await new Promise(r => setTimeout(r, 1500));
  const job2 = events.filter(m => m.jobId === 2);
  const job2done = job2.find(m => m.type === 'done');
  const job2cancelled = job2.find(m => m.type === 'cancelled');
  ok(!!job2done && !job2cancelled, '新扫描 job2 不被旧 cancel 误杀（done 而非 cancelled）');
  ok(job2done && job2done.found === 1600, `job2 扫全 1600 文件（实际 ${job2done && job2done.found}）`);
  const job1cancelled = events.find(m => m.jobId === 1 && m.type === 'cancelled');
  ok(!!job1cancelled, '旧扫描 job1 收到 cancelled');

  // 场景 2：无 jobId 的全局 cancel 仍能终止当前扫描（lib:scanCancel 兼容）
  events.length = 0;
  w.postMessage({ type: 'scan', jobId: 3, folders: [dir] });
  await new Promise(r => setTimeout(r, 5));
  w.postMessage({ type: 'cancel' });
  await new Promise(r => setTimeout(r, 800));
  ok(!!events.find(m => m.jobId === 3 && m.type === 'cancelled'), '无 jobId 全局 cancel 终止当前扫描');

  // 场景 3：全局 cancel 后启动的新任务不受影响（代际语义）
  events.length = 0;
  w.postMessage({ type: 'scan', jobId: 4, folders: [dir] });
  await new Promise(r => setTimeout(r, 1200));
  const job4done = events.find(m => m.jobId === 4 && m.type === 'done');
  ok(!!job4done && job4done.found === 1600, '全局 cancel 之后的新扫描正常完成');

  w.terminate();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
