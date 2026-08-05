'use strict';
// 引擎子进程客户端：stdio 行分隔 JSON-RPC。
// 引擎路径解析：开发态 <repo>/engine/publish/AnnieEngine.exe；打包态 resources/engine/AnnieEngine.exe。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { app, BrowserWindow } = require('electron');

function resolveEnginePath() {
  const prod = path.join(process.resourcesPath || '', 'engine', 'AnnieEngine.exe');
  // EXP 沙箱布局：exp7.28/main → exp7.28/engine/publish
  const dev = path.join(__dirname, '..', 'engine', 'publish', 'AnnieEngine.exe');
  if (app.isPackaged && fs.existsSync(prod)) return prod;
  if (fs.existsSync(dev)) return dev;
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
    this._stopIntentional = false;
    this.onRestart = null;    // 重启完成回调（main 注入，恢复播放）
  }

  _log(line, isErr) {
    const item = { t: new Date().toISOString(), line: String(line).slice(0, 500) };
    const ring = isErr ? this.errorRing : this.logRing;
    ring.push(item);
    if (ring.length > 200) ring.shift();
  }

  start() {
    if (this.proc) return true;
    const exe = resolveEnginePath();
    if (!exe) {
      console.error('[engineClient] 未找到 AnnieEngine.exe，请先编译 engine。');
      return false;
    }
    // 打包态把 ffmpeg 放在引擎同级 tools/ 下；开发态用系统 PATH 或 engine/tools
    const env = { ...process.env };
    this.proc = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.started = true;

    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._onLine(line));

    this.proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      console.error('[engine]', s);
      this._log(s, /error|exception|fail|异常|错误/i.test(s));
    });
    this.proc.on('exit', (code) => {
      console.error('[engineClient] 引擎退出 code=' + code);
      this._log('引擎退出 code=' + code, code !== 0);
      this.proc = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('engine exited')); }
      this.pending.clear();
      this._broadcast('engine-dead', { code });
      // Pro beat0.0.1：崩溃守护——非主动停止时自动重启（退避 1s/2s/4s，上限 8s）
      if (!this._stopIntentional) this._scheduleRestart(code);
    });
    return true;
  }

  _scheduleRestart(code) {
    if (this.restarting) return;
    this.restarting = true;
    const now = Date.now();
    if (now - this.lastExitAt > 60000) this.restartCount = 0; // 稳定运行 1 分钟后重置退避
    this.lastExitAt = now;
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
    if (msg.event) {
      // 诊断：播放格式事件落日志（codec/bitDepth/sampleRate/resampled/device）
      if (msg.event === 'format' || msg.event === 'state' || msg.event === 'backend' || msg.event === 'error') {
        console.error('[engineEvent]', msg.event, JSON.stringify(msg.data || {}));
      }
      this._broadcast(msg.event, msg.data || {});
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else {
        // 诊断：引擎拒绝调用时带出方法名
        if (msg.error && !/already|ready/i.test(String(msg.error))) {
          console.error('[engineClient] 引擎拒绝:', p.method, '→', msg.error);
        }
        p.reject(new Error(msg.error || 'engine error'));
      }
    }
  }

  _broadcast(event, data) {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('engine-event', { event, data }); } catch { }
    }
  }

  call(method, params = {}, timeoutMs = 15000) {
    if (!this.proc && !this.start()) {
      return Promise.reject(new Error('引擎未启动（缺少 AnnieEngine.exe）'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('引擎调用超时: ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  stop() {
    if (!this.proc) return;
    this._stopIntentional = true; // Pro：主动停止不触发崩溃守护
    try { this.proc.stdin.write(JSON.stringify({ id: 0, method: 'shutdown', params: {} }) + '\n'); } catch { }
    const proc = this.proc;
    setTimeout(() => { try { proc.kill(); } catch { } }, 1500);
    this.proc = null;
  }
}

module.exports = { EngineClient, resolveEnginePath };
