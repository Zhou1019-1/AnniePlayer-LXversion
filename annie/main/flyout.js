/* AnnieFlyout 伴侣进程管理（V4.4）
 * 基于 FluentFlyout（GPL-3.0，源码见仓库 flyout/ 目录）裁剪：
 * 任务栏媒体小组件 + 切歌/媒体键弹窗。
 * SMTC 桥（V4.4）：Chromium Media Session 在无 <audio> 出声时不会桥到 Windows SMTC，
 * 故由 AnnieFlyout 自持 SMTC 会话——本模块经 stdin JSON 行推曲目/状态，stdout 收按钮命令。
 * 路径解析对齐 resolveTool 思路：打包态 resources/flyout、仓库根 flyout/publish（dev）。 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

let proc = null;
let onCmd = null; // 按钮命令回调（由 main.js 注入转发到渲染层）
let outBuf = '';
let lastMeta = null;  // 最近的 meta/state 缓存——启动重放用（开机续播的推送可能早于 WPF 桥就绪）
let lastState = null;

function resolveFlyout() {
  const cands = [
    path.join(process.resourcesPath || '', 'flyout', 'AnnieFlyout.exe'), // 打包态
    path.join(__dirname, '..', '..', 'flyout', 'publish', 'AnnieFlyout.exe'), // dev：仓库根 flyout/publish
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch { } }
  return null;
}

function isRunning() { return !!(proc && !proc.killed && proc.exitCode === null); }

function start(opts) {
  if (opts && typeof opts.onCmd === 'function') onCmd = opts.onCmd;
  if (isRunning()) return true;
  const exe = resolveFlyout();
  if (!exe) { console.warn('[flyout] 未找到 AnnieFlyout.exe（dev 需先在 flyout/ 下 dotnet publish）'); return false; }
  try {
    proc = spawn(exe, [], { windowsHide: true, cwd: path.dirname(exe), stdio: ['pipe', 'pipe', 'ignore'] });
    outBuf = '';
    proc.stdout.on('data', (chunk) => {
      outBuf += chunk.toString('utf8');
      let idx;
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx).trim(); outBuf = outBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && msg.type === 'cmd' && msg.cmd && onCmd) onCmd(msg.cmd);
          // 弹窗进度条拖拽回流（SMTC PlaybackPositionChangeRequested）
          else if (msg && msg.type === 'seek' && typeof msg.positionSec === 'number' && onCmd) onCmd({ cmd: 'seek', positionSec: msg.positionSec });
        } catch { }
      }
    });
    proc.on('exit', () => { proc = null; });
    proc.on('error', (e) => { console.error('[flyout] 启动失败:', e && e.message); proc = null; });
    console.log('[flyout] AnnieFlyout 已启动, pid=' + proc.pid);
    // 重放缓存的 meta/state：覆盖开机续播推送早于桥就绪、flyout 崩溃重启两类场景
    setTimeout(() => {
      if (!isRunning()) return;
      if (lastMeta) send(lastMeta);
      if (lastState) send(lastState);
    }, 1500);
    return true;
  } catch (e) { console.error('[flyout] 启动异常:', e && e.message); proc = null; return false; }
}

function stop() {
  try { if (isRunning()) proc.kill(); } catch { }
  proc = null;
  // 兜底清理孤儿实例（单实例互斥在崩溃/强杀后可能留下残留进程）
  try { execFile('taskkill', ['/F', '/IM', 'AnnieFlyout.exe'], { windowsHide: true }, () => { }); } catch { }
}

/* dataURL 封面落盘为临时文件（SMTC 端只收 URL/文件路径，pipe 行也不适合塞大 base64）。
 * 扩展名必须真实反映格式——曾用 .img 导致 SMTC 缩略图解码失败，
 * 连累整个媒体属性读取抛 COMException（外部读到的会话标题/封面全空）。 */
const _coverFiles = {};
function normalizeCover(cover) {
  if (!cover || typeof cover !== 'string') return '';
  if (/^https?:\/\//.test(cover)) return cover;
  const m = cover.match(/^data:image\/(png|jpe?g);base64,(.+)$/s);
  if (!m) return '';
  try {
    const ext = m[1] === 'png' ? 'png' : 'jpg';
    const f = _coverFiles[ext] || (_coverFiles[ext] = path.join(os.tmpdir(), 'annie-flyout-cover.' + ext));
    fs.writeFileSync(f, Buffer.from(m[2], 'base64'));
    return f;
  } catch { return ''; }
}

/* 渲染层 → AnnieFlyout 推送（非运行中直接丢弃，但 meta/state 始终缓存供重放） */
function send(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.type === 'meta') {
    obj = Object.assign({}, obj, { cover: normalizeCover(obj.cover) });
    lastMeta = obj;
  } else if (obj.type === 'state') {
    lastState = obj;
  }
  if (!isRunning()) return;
  try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { }
}

// 应用退出时带走伴侣进程（各 before-quit 路径都会触发）
try { app.on('before-quit', () => stop()); } catch { }

module.exports = { start, stop, isRunning, resolveFlyout, send };
