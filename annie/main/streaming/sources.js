'use strict';
// ============================================================================
// 洛雪式自定义音源运行时（LX custom source API 兼容沙箱）
// 用户可导入第三方音源脚本(.js)，脚本通过 globalThis.lx API 注册请求处理器。
// 存储:
//   userData/stream-sources/        音源脚本文件(<id>.js)
//   userData/stream-sources.json    注册表 [{id,name,version,description,author,enabled}]
//
// V1.0.1 (R1)：脚本执行迁移到 worker_threads（sources-worker.js）。
// V4.0.3：再升级为独立子进程（child_process.fork + --disallow-code-generation-from-strings），
//   进程级禁用 eval/Function 构造器，堵住 vm 沙箱经宿主函数 constructor 的经典逃逸链；
//   独立进程崩溃/卡死不占主进程句柄表，kill 熔断重建语义与 worker 版一致。
//   原因：脚本若与主进程同 vm 沙箱同步执行，第三方脚本的死循环/超重同步计算
//   会冻结整个主进程（所有 IPC 无响应，只能杀进程）。
//   现在：脚本卡死只阻塞子进程；请求超时先 ping 探测，确认无响应后
//   kill + 退避重建 + 重新加载 + 排队请求重试一次。
// 对外 API 签名保持不变（setEnabled / importFromPath 因需等待加载回执变为 async，
// 调用方均为 ipcMain.handle，天然兼容）。
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');

let _app = null;
let _dir = '';          // 脚本目录
let _registryFile = ''; // 注册表路径
let _registry = [];     // [{id,name,version,description,author,enabled}]
const _loadedIds = new Set(); // 已加载（Worker 回执维护）

/* ---------------- Worker 生命周期 ---------------- */
let _worker = null;
let _workerReady = false;
let _restarting = false;      // 熔断重建中
let _restartAttempt = 0;      // 退避计数
let _readyWaiters = [];       // waitForReady 等待者
let _loadWaiters = [];        // 加载回执等待者 [{id, resolve(ok)}]
let _restartWaiters = [];     // 重建期间排队请求 [{resolve, reject}]
let _jobSeq = 0;
const _pendingJobs = new Map(); // jobId -> {resolve, reject, timer, sourceId, sourceName}

function startWorker() {
  if (_worker) return;
  // V4.0.3：独立子进程 + 进程级禁用字符串代码生成（eval/Function 全进程失效），
  // 沙箱内任何经宿主函数 .constructor 的逃逸尝试都会抛 EvalError
  _worker = fork(path.join(__dirname, 'sources-worker.js'), [], {
    execArgv: ['--disallow-code-generation-from-strings'],
  });
  _workerReady = false;
  _worker.on('message', onWorkerMessage);
  _worker.on('error', (err) => console.error('[lx-source] sandbox error:', err && err.message));
  _worker.on('exit', onWorkerExit);
}

function onWorkerExit(code) {
  console.error(`[lx-source][${Date.now()}] 音源沙箱退出 code=` + code);
  // 拒绝所有在途请求（重建后调用方按需重试）
  for (const [, job] of _pendingJobs) {
    clearTimeout(job.timer);
    job.reject(new Error('音源沙箱已重启'));
  }
  _pendingJobs.clear();
  // 清空加载/就绪状态：重建完成后由 init 回执重建
  _loadedIds.clear();
  _loadWaiters = [];
  _readyWaiters = [];
  _worker = null;
  _workerReady = false;
  scheduleRestart();
}

function scheduleRestart() {
  if (_restarting) return;
  _restarting = true;
  const delay = Math.min(4000, 500 * Math.pow(2, _restartAttempt++));
  console.error(`[lx-source] ${delay}ms 后重启音源沙箱（第 ${_restartAttempt} 次）`);
  setTimeout(() => {
    try {
      startWorker();
      waitForReady()
        .then(() => {
          // 重建后重新加载所有启用音源（init 消息驱动 loaded 回执）
          postToWorker({ type: 'init', dir: _dir, entries: _registry.filter((e) => e.enabled) });
          return reloadAll();
        })
        .then(() => {
          _restarting = false;
          _restartAttempt = 0;
          const waiters = _restartWaiters.splice(0);
          for (const w of waiters) w.resolve();
        })
        .catch((e) => {
          _restarting = false;
          const waiters = _restartWaiters.splice(0);
          for (const w of waiters) w.reject(new Error('音源沙箱重启失败: ' + (e.message || e)));
        });
    } catch (e) {
      _restarting = false;
      const waiters = _restartWaiters.splice(0);
      for (const w of waiters) w.reject(new Error('音源沙箱重启失败: ' + (e.message || e)));
    }
  }, delay);
}

function waitForReady() {
  if (_workerReady) return Promise.resolve();
  return new Promise((resolve) => _readyWaiters.push({ resolve }));
}

function waitLoad(id) {
  if (_loadedIds.has(id)) return Promise.resolve({ ok: true });
  return new Promise((resolve) => _loadWaiters.push({ id, resolve }));
}

function reloadAll() {
  const entries = _registry.filter((e) => e.enabled);
  if (!entries.length) return Promise.resolve();
  return Promise.allSettled(entries.map((e) => waitLoad(e.id)));
}

/* ---------------- Worker 消息 ---------------- */
function onWorkerMessage(msg) {
  switch (msg.type) {
    case 'ready': {
      _workerReady = true;
      const waiters = _readyWaiters.splice(0);
      for (const w of waiters) w.resolve();
      break;
    }
    case 'loaded': {
      if (msg.ok) _loadedIds.add(msg.id);
      else _loadedIds.delete(msg.id);
      const waiters = _loadWaiters.filter((w) => w.id === msg.id);
      _loadWaiters = _loadWaiters.filter((w) => w.id !== msg.id);
      for (const w of waiters) w.resolve({ ok: !!msg.ok, error: msg.error });
      break;
    }
    case 'unloaded':
      _loadedIds.delete(msg.id);
      break;
    case 'result': {
      const job = _pendingJobs.get(msg.jobId);
      if (!job) break;
      _pendingJobs.delete(msg.jobId);
      clearTimeout(job.timer);
      if (msg.ok) job.resolve({ sourceId: job.sourceId, sourceName: job.sourceName, result: msg.value });
      else job.reject(new Error(msg.error || '音源请求失败'));
      break;
    }
  }
}

/* ---------------- 请求 + 超时熔断 ---------------- */
function postToWorker(msg) {
  if (!_worker) throw new Error('音源沙箱未启动');
  _worker.send(msg);
}

/**
 * 请求超时处理：先 ping 健康探测。
 * 若 Worker 事件循环被同步死循环占用（ping 无响应）→ terminate 熔断，exit 回调触发重建；
 * 若只是慢请求（ping 有响应）→ 仅超时，不打断 Worker。
 */
function onJobTimeout(jobId) {
  const job = _pendingJobs.get(jobId);
  if (!job) return;
  _pendingJobs.delete(jobId);
  clearTimeout(job.timer);
  let ponged = false;
  const pingId = 'ping' + jobId;
  const pongHandler = (msg) => { if (msg.type === 'pong' && msg.id === pingId) ponged = true; };
  try {
    _worker.on('message', pongHandler);
    postToWorker({ type: 'ping', id: pingId });
  } catch { ponged = true; }
  setTimeout(() => {
    _worker.removeListener('message', pongHandler);
    if (!ponged) {
      console.error(`[lx-source][${Date.now()}] 音源沙箱疑似卡死，熔断重启`);
      try { _worker.kill(); } catch { }
    }
    job.reject(new Error('音源响应超时' + (ponged ? '' : '（沙箱已重置）')));
  }, 1000);
}

async function requestInWorker(sourceId, sourceName, action, source, info, timeoutMs) {
  // 熔断重建期间：排队等待，重建完成后重试
  if (_restarting) {
    await new Promise((resolve, reject) => _restartWaiters.push({ resolve, reject }));
  }
  if (!_workerReady) await waitForReady();
  const jobId = ++_jobSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => onJobTimeout(jobId), timeoutMs);
    _pendingJobs.set(jobId, { resolve, reject, timer, sourceId, sourceName });
    try {
      postToWorker({ type: 'request', jobId, sourceId, action, source, info });
    } catch (e) {
      clearTimeout(timer);
      _pendingJobs.delete(jobId);
      reject(e);
    }
  });
}

/* ---------------- 对外 API（签名与迁移前一致） ---------------- */
function md5(s) {
  return crypto.createHash('md5').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');
}

/** 解析脚本头部注释元数据：@name @version @description @author */
function parseMeta(script, fallbackName) {
  const meta = { name: fallbackName, version: '', description: '', author: '' };
  const head = script.slice(0, 4000);
  const m = (k) => {
    const r = head.match(new RegExp(`@${k}\\s+([^\\r\\n*]+)`));
    return r ? r[1].trim() : '';
  };
  meta.name = m('name') || fallbackName;
  meta.version = m('version');
  meta.description = m('description');
  meta.author = m('author');
  return meta;
}

function saveRegistry() {
  fs.writeFileSync(_registryFile, JSON.stringify(_registry, null, 2), 'utf8');
}

function init(app) {
  _app = app;
  _dir = path.join(app.getPath('userData'), 'stream-sources');
  _registryFile = path.join(app.getPath('userData'), 'stream-sources.json');
  if (!fs.existsSync(_dir)) fs.mkdirSync(_dir, { recursive: true });
  try {
    _registry = JSON.parse(fs.readFileSync(_registryFile, 'utf8'));
  } catch { _registry = []; }
  // 启动沙箱 Worker 并异步加载所有启用的音源（不再阻塞主进程）
  startWorker();
  postToWorker({ type: 'init', dir: _dir, entries: _registry.filter((e) => e.enabled) });
}

function list() {
  return _registry.map((e) => ({
    id: e.id, name: e.name, version: e.version,
    description: e.description, author: e.author,
    enabled: e.enabled, loaded: _loadedIds.has(e.id),
  }));
}

/** 导入音源脚本（从给定路径复制进沙箱目录并验证） */
async function importFromPath(srcPath) {
  const script = fs.readFileSync(srcPath, 'utf8');
  const meta = parseMeta(script, path.basename(srcPath, '.js'));
  const id = 'src_' + md5(meta.name + Date.now()).slice(0, 10);
  const entry = { id, name: meta.name, version: meta.version, description: meta.description, author: meta.author, enabled: true };
  const dest = path.join(_dir, id + '.js');
  fs.writeFileSync(dest, script, 'utf8');
  // 先验证可运行再入册（等待 Worker 加载回执，失败抛错）
  let ok = false;
  let loadError = '';
  try {
    await waitForReady();
    postToWorker({ type: 'load', entry });
    const r = await waitLoad(id);
    ok = r.ok;
    loadError = r.error || '';
  } catch (e) {
    try { fs.unlinkSync(dest); } catch { }
    throw new Error(`音源脚本执行失败: ${e.message}`);
  }
  if (!ok) {
    try { fs.unlinkSync(dest); } catch { }
    throw new Error(loadError || '音源脚本验证失败（沙箱加载未通过）');
  }
  _registry = _registry.filter((e) => e.id !== id);
  _registry.push(entry);
  saveRegistry();
  return { id, name: entry.name, version: entry.version, description: entry.description, author: entry.author, enabled: true, loaded: true };
}

function remove(id) {
  _registry = _registry.filter((e) => e.id !== id);
  _loadedIds.delete(id);
  try { postToWorker({ type: 'unload', id }); } catch { }
  try { fs.unlinkSync(path.join(_dir, id + '.js')); } catch { }
  saveRegistry();
  return { ok: true };
}

async function setEnabled(id, enabled) {
  const entry = _registry.find((e) => e.id === id);
  if (!entry) throw new Error('音源不存在');
  entry.enabled = !!enabled;
  saveRegistry();
  if (enabled) {
    // 等待 Worker 加载回执；失败回滚注册表并抛错
    try {
      await waitForReady();
      postToWorker({ type: 'load', entry });
      const r = await waitLoad(id);
      if (!r.ok) throw new Error(r.error || '音源加载失败');
    } catch (e) {
      entry.enabled = false;
      saveRegistry();
      throw e;
    }
  } else {
    _loadedIds.delete(id);
    try { postToWorker({ type: 'unload', id }); } catch { }
  }
  return { ok: true, enabled: entry.enabled };
}

/** 是否有可用（已加载）的自定义音源 */
function hasActiveSource() {
  return _registry.some((e) => e.enabled && _loadedIds.has(e.id));
}

/**
 * 向已启用音源发起请求（洛雪协议）
 * @param {string} action 'musicUrl' | 'lyric' | 'hotSearch'
 * @param {object} payload { source, info }  source: kg/kw/tx/wy/mg
 */
async function handleRequest(action, payload, timeoutMs = 15000) {
  const enabled = _registry.filter((e) => e.enabled && _loadedIds.has(e.id));
  if (!enabled.length) throw new Error('没有已启用的音源');
  const errors = [];
  for (const entry of enabled) {
    try {
      return await requestInWorker(entry.id, entry.name, action, payload.source, payload.info, timeoutMs);
    } catch (e) {
      errors.push(`${entry.name}: ${e.message}`);
    }
  }
  throw new Error(errors.join('；') || '所有音源均请求失败');
}

/** 指定具体音源发起请求 */
async function handleRequestById(id, action, payload, timeoutMs = 15000) {
  if (!_loadedIds.has(id)) throw new Error('音源未加载');
  return requestInWorker(id, (_registry.find((e) => e.id === id) || {}).name || id, action, payload.source, payload.info, timeoutMs);
}

module.exports = { init, list, importFromPath, remove, setEnabled, hasActiveSource, handleRequest, handleRequestById };
