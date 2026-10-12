'use strict';
// 引擎子进程客户端：stdio 行分隔 JSON-RPC。
// 引擎路径解析：开发态 <repo>/engine/publish/AnnieEngine.exe；打包态 resources/engine/AnnieEngine.exe。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { StringDecoder } = require('string_decoder');
const { app, BrowserWindow } = require('electron');

function classifyStartupFailure(code, text) {
  const message = String(text || '');
  if (code === 2147516566 || /0x80008096/i.test(message)) return 'dotnet-runtime-missing';
  if (code === 2147516547 || /0x80008083/i.test(message)) return 'dotnet-hostfxr-missing';
  if (/You must install or update \.NET[\s\S]*Framework: ['"]Microsoft\.NETCore\.App['"], version ['"]9\./i.test(message)) return 'dotnet-runtime-missing';
  if (/You must install \.NET[\s\S]*Failed to resolve hostfxr\.dll \[not found\]/i.test(message)) return 'dotnet-hostfxr-missing';
  return null;
}

function resolveEnginePath() {
  const prod = path.join(process.resourcesPath || '', 'engine', 'AnnieEngine.exe');
  // EXP 沙箱布局：exp7.28/main → exp7.28/engine/publish
  const dev = path.join(__dirname, '..', 'engine', 'publish', 'AnnieEngine.exe');
  // LXversion 仓库布局：annie/main → <repo>/engine/publish
  const devRoot = path.join(__dirname, '..', '..', 'engine', 'publish', 'AnnieEngine.exe');
  if (app.isPackaged && fs.existsSync(prod)) return prod;
  if (fs.existsSync(dev)) return dev;
  if (fs.existsSync(devRoot)) return devRoot;
  if (fs.existsSync(prod)) return prod;
  return null;
}

class EngineClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.started = false;
    /* Pro beat0.0.1：崩溃守护 */
    this.restarting = false;
    this.restartCount = 0;
    this.lastExitAt = 0;
    this.logRing = [];        // 最近日志环形缓冲（诊断包用）
    this.errorRing = [];      // 最近错误栈
    this.startupFailure = null;
    this.engineFileMissing = false;
    this._manualRetryRequired = false;
    this._lastSpawnErrorGeneration = 0;
    this._lastStartedAt = 0;
    this._stopIntentional = false;
    this.onRestart = null;    // 重启完成回调（main 注入，恢复播放）
    this.eventFilter = null;  // 事件分流钩子（main 注入）：(win, event) => boolean，返回 false 不给该窗口发
  }

  _log(line, isErr) {
    const item = { t: new Date().toISOString(), line: String(line).slice(0, 500) };
    const ring = isErr ? this.errorRing : this.logRing;
    ring.push(item);
    if (ring.length > 200) ring.shift();
  }

  start() {
    if (this.proc) return true;
    // 已分类的启动故障（缺 .NET/exe 缺失）只允许用户显式 retry()，避免 call() 路径重启循环
    if (this._manualRetryRequired) return false;
    if (this.crashStorm) { this.crashStorm = false; this.restartCount = 0; } // 熔断后手动重试（点播放等触发）
    const exe = resolveEnginePath();
    if (!exe) {
      if (!this.engineFileMissing) {
        this.engineFileMissing = true;
        this.startupFailure = { kind: 'engine-file-missing', code: null, message: '未找到 AnnieEngine.exe' };
        this._manualRetryRequired = true;
        console.error('[engineClient] 未找到 AnnieEngine.exe。');
        this._broadcast('engine-startup-failure', this.startupFailure);
      }
      return false;
    }
    // 打包态把 ffmpeg 放在引擎同级 tools/ 下；开发态用系统 PATH 或 engine/tools
    const env = { ...process.env };
    let proc;
    try { proc = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) {
      this._handleSpawnError(e);
      return false;
    }
    this.proc = proc;
    this.engineFileMissing = false;
    this.started = true;
    this._stopIntentional = false;
    this._manualRetryRequired = false;
    this._lastStartedAt = Date.now();
    const generation = (this._generation || 0) + 1;
    this._generation = generation;
    const decoder = new StringDecoder('utf8');
    let stderrText = '';
    let stderrTail = '';
    let gotRpcMessage = false;
    let exitInfo = null;
    let finalized = false;
    let spawnFailed = false;
    const STDERR_LIMIT = 32768;

    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._onLine(line));

    proc.stderr.on('data', (d) => {
      const s = decoder.write(d);
      stderrText = (stderrText + s).slice(-STDERR_LIMIT);
      stderrTail += s;
      const lines = stderrTail.split(/\r?\n/);
      stderrTail = lines.pop() || '';
      for (const line of lines) this._recordStderr(line);
    });
    // exit/close 与 stderr end 的先后不固定：谁最后到谁终结，且全程只终结一次
    const finishOnce = () => {
      if (finalized || !exitInfo) return;
      finalized = true;
      this._finalizeExit(generation, exitInfo, stderrText, gotRpcMessage, spawnFailed);
    };
    proc.stderr.on('end', () => {
      const tail = decoder.end();
      if (tail) { stderrText = (stderrText + tail).slice(-STDERR_LIMIT); stderrTail += tail; }
      if (stderrTail.trim()) this._recordStderr(stderrTail);
      stderrTail = '';
      finishOnce();
    });
    proc.on('error', (error) => {
      if (generation !== this._generation) return;
      spawnFailed = true;
      this._lastSpawnErrorGeneration = generation;
      this._handleSpawnError(error);
    });
    proc.on('exit', (code, signal) => {
      exitInfo = { code, signal, pid: proc.pid };
      // 进程对象引用保留到 finalize，避免 close 前的并发 call 误判引擎仍存活；
      // pending 请求统一在 _finalizeExit 拒绝
    });
    proc.on('close', (code, signal) => {
      if (generation !== this._generation) return;
      if (!exitInfo) exitInfo = { code, signal, pid: proc.pid };
      finishOnce();
    });

    const onRpcMessage = (msg) => {
      if (!gotRpcMessage) {
        gotRpcMessage = true;
        this.startupFailure = null;
        this._manualRetryRequired = false;
        this._broadcast('engine-started', { generation });
      }
      this._handleRpcMessage(msg);
    };
    this._onRpcMessage = onRpcMessage;
    return true;
  }

  _recordStderr(line) {
    const s = String(line || '').trim();
    if (!s) return;
    console.error('[engine]', s);
    this._log(s, /error|exception|fail|异常|错误|You must install|Failed to resolve hostfxr/i.test(s));
  }

  _handleSpawnError(error) {
    const code = error && (error.code || error.errno) || null;
    const kind = code === 'ENOENT' ? 'engine-file-missing' : 'engine-spawn-failed';
    const message = String((error && error.message) || error || '引擎无法启动');
    this.startupFailure = { kind, code, message };
    this._manualRetryRequired = true;
    this.engineFileMissing = kind === 'engine-file-missing';
    this.proc = null;
    for (const [, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
    this._log('引擎启动失败(' + (code || 'unknown') + '): ' + message, true);
    this._broadcast('engine-startup-failure', this.startupFailure);
  }

  _finalizeExit(generation, exit, stderrText, gotRpcMessage, spawnFailed) {
    if (generation !== this._generation) return;
    const code = exit.code;
    if (this._lastStartedAt && Date.now() - this._lastStartedAt >= 60000) this.restartCount = 0;
    const wasIntentional = this._stopIntentional;
    this._stopIntentional = false;
    const startupKind = !gotRpcMessage && !spawnFailed ? classifyStartupFailure(code, stderrText) : null;
    if (startupKind) {
      this.startupFailure = {
        kind: startupKind,
        code,
        message: startupKind === 'dotnet-runtime-missing'
          ? '当前安装包的音频引擎需要 .NET 9 运行时。'
          : '系统未能找到 .NET hostfxr，无法启动音频引擎。'
      };
      this._manualRetryRequired = true;
      this._log('引擎启动失败(' + startupKind + ', code=' + code + ')', true);
    }
    console.error('[engineClient] 引擎退出 code=' + code);
    this._log('引擎退出 code=' + code, code !== 0);
    this.proc = null;
    for (const [, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error('engine exited')); }
    this.pending.clear();
    this._broadcast('engine-dead', { code, signal: exit.signal || null, startupFailure: this.startupFailure });
    if (this.startupFailure && (this.startupFailure.kind.startsWith('dotnet-') || spawnFailed)) {
      this._broadcast('engine-startup-failure', this.startupFailure);
      return;
    }
    if (!wasIntentional) this._scheduleRestart(code);
  }

  _handleRpcMessage(msg) {
    if (msg.event) {
      if (msg.event === 'format' || msg.event === 'state' || msg.event === 'backend' || msg.event === 'error') {
        console.error('[engineEvent]', msg.event, JSON.stringify(msg.data || {}));
      }
      this._broadcast(msg.event, msg.data || {});
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.result);
      else {
        if (msg.error && !/already|ready/i.test(String(msg.error))) {
          console.error('[engineClient] 引擎拒绝:', pending.method, '→', msg.error);
        }
        pending.reject(new Error(msg.error || 'engine error'));
      }
    }
  }

  retry() {
    this._manualRetryRequired = false;
    this.startupFailure = null;
    this.engineFileMissing = false;
    this.crashStorm = false;
    this.restartCount = 0;
    this._stopIntentional = false;
    return this.start();
  }

  _scheduleRestart(code) {
    if (this.restarting || this._manualRetryRequired) return;
    this.restarting = true;
    const now = Date.now();
    if (now - this.lastExitAt > 60000) this.restartCount = 0;
    this.lastExitAt = now;
    if (this.restartCount >= 6) {
      this.restarting = false;
      this.crashStorm = true;
      this._log(`引擎连续崩溃 ${this.restartCount} 次(code=${code})，停止自动重启；请检查输出设备或安全软件拦截记录`, true);
      this._broadcast('engine-crash-storm', { code, count: this.restartCount });
      return;
    }
    const delay = Math.min(8000, 1000 * Math.pow(2, this.restartCount++));
    this._log(`引擎崩溃(code=${code})，${delay}ms 后自动重启（第 ${this.restartCount} 次）`, true);
    setTimeout(() => {
      this.restarting = false;
      const ok = this.start();
      this._broadcast('engine-restarted', { ok, attempt: this.restartCount });
      if (ok && this.onRestart) { try { this.onRestart(); } catch { } }
    }, delay);
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (this._onRpcMessage) this._onRpcMessage(msg);
  }

  _broadcast(event, data) {
    const filter = this.eventFilter;
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (filter && !filter(win, event)) continue;
        win.webContents.send('engine-event', { event, data });
      } catch { }
    }
  }

  call(method, params = {}, timeoutMs = 15000) {
    if (!this.proc && !this.start()) {
      const failure = this.startupFailure;
      return Promise.reject(new Error(failure ? failure.message : '音频引擎文件缺失'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('引擎调用超时: ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  getDiagnostics() {
    const exe = resolveEnginePath();
    let sizeBytes = null;
    try { if (exe) sizeBytes = fs.statSync(exe).size; } catch { }
    return {
      enginePath: exe,
      engineFileExists: !!exe,
      engineFileSizeBytes: sizeBytes,
      engineAlive: !!this.proc,
      startupFailure: this.startupFailure,
      restartCount: this.restartCount,
      crashStorm: !!this.crashStorm
    };
  }

  stop() {
    if (!this.proc) return;
    this._stopIntentional = true;
    try { this.proc.stdin.write(JSON.stringify({ id: 0, method: 'shutdown', params: {} }) + '\n'); } catch { }
    const proc = this.proc;
    setTimeout(() => { try { proc.kill(); } catch { } }, 1500);
    this.proc = null;
  }

  async stopAndWait(timeoutMs = 4000) {
    const proc = this.proc;
    if (!proc) return;
    this._stopIntentional = true;
    this.proc = null;
    try { proc.stdin.write(JSON.stringify({ id: 0, method: 'shutdown', params: {} }) + '\n'); } catch { }
    const t0 = Date.now();
    while (proc.exitCode === null && !proc.killed) {
      if (Date.now() - t0 > timeoutMs) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (proc.exitCode === null && !proc.killed) { try { proc.kill(); } catch { } }
    const t1 = Date.now();
    while (proc.exitCode === null && Date.now() - t1 < 1500) await new Promise(r => setTimeout(r, 100));
  }
}

module.exports = { EngineClient, resolveEnginePath, classifyStartupFailure };
