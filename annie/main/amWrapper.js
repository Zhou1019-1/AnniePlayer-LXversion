// ===== wrapper-lite 生命周期管理（V4.6：Apple Music 音源后端）=====
// 负责：wrapper-lite-qemu.exe 的登录（--login）/ 服务启停 / 状态检测 / 路径解析（dev/打包双路径）。
// 约束：主进程模块顶层禁止 require('electron')（AGENTS.md 规范 12）——全部惰性加载。
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/* wrapper-lite 根目录：dev 用仓库内 annie/resources/wrapper-lite/，打包用 process.resourcesPath/wrapper-lite/ */
function wrapperDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.join(process.resourcesPath, 'wrapper-lite');
  } catch { }
  return path.join(__dirname, '..', 'resources', 'wrapper-lite'); // __dirname=annie/main → 向上一级是 annie/
}
/* 有效工作目录：QEMU launcher 用窄字符拼路径，非 ASCII 路径（中文安装目录）必 boot 失败
 *（章鱼侧一键部署 bat 同款结论：「QEMU cannot run from a Chinese path」）。
 * 对策：含非 ASCII 时镜像到 %ProgramData%\annie-player\wrapper-lite（纯 ASCII）。
 * 登录态保护：目标已有 qemu/data.img 时同步跳过它（用户已登录的会话不被覆盖）。 */
let _effDir = null;
function effectiveWrapperDir() {
  if (_effDir) return _effDir;
  const dir = wrapperDir();
  if (/^[\x00-\x7F]+$/.test(dir)) return (_effDir = dir);
  const alt = path.join(process.env.ProgramData || 'C:\\ProgramData', 'annie-player', 'wrapper-lite');
  try {
    const exeOk = fs.existsSync(path.join(alt, 'wrapper-lite-qemu.exe'));
    const initrdOk = fs.existsSync(path.join(alt, 'qemu', 'lite-initramfs.cpio.gz'));
    if (!exeOk || !initrdOk) {
      fs.mkdirSync(alt, { recursive: true });
      const hasLogin = fs.existsSync(path.join(alt, 'qemu', 'data.img'));
      fs.cpSync(dir, alt, {
        recursive: true, force: true,
        filter: (src) => !(hasLogin && /[\\/]qemu[\\/]data\.img$/.test(src)),
      });
      console.log('[am-wrapper] 中文路径检测到，已镜像到 ' + alt);
    }
    _effDir = alt;
  } catch (e) {
    console.warn('[am-wrapper] 镜像到 ProgramData 失败，退回原路径：', e.message);
    _effDir = dir;
  }
  return _effDir;
}

function exePath() { return path.join(effectiveWrapperDir(), 'wrapper-lite-qemu.exe'); }
function dataDir() { return path.join(effectiveWrapperDir(), 'data'); } // 登录态/2fa.txt 存这（QEMU data.img 同目录）

let svcProc = null;   // 服务进程句柄
let svcStarting = null;
let svcUrl = 'http://127.0.0.1:12340'; // 服务实际监听地址（启动时从输出解析，缺省 12340）
let svcGen = 0;       // V4.6.4：stop/start 代际号——stop 使旧轮询/旧 close 回调失效

/* 从 wrapper 输出解析实际监听地址（如 "Listening: http://127.0.0.1:12340" 或 "listening on 0.0.0.0:12340"） */
function parseListenUrl(text) {
  const m = /Listening:\s*(https?:\/\/[^\s]+)/i.exec(text) || /listening on\s+(?:https?:\/\/)?([\d.]+):(\d+)/i.exec(text);
  if (!m) return null;
  if (m[1] && m[1].startsWith('http')) return m[1];
  if (m[1] && m[2]) return 'http://' + (m[1] === '0.0.0.0' ? '127.0.0.1' : m[1]) + ':' + m[2];
  return null;
}

/* 状态检测：/status 透传 + 进程存活（地址用解析到的实际监听地址） */
async function status() {
  const exeOk = fs.existsSync(exePath());
  if (!exeOk) return { ok: false, stage: 'missing', error: 'wrapper-lite 未安装（安装包可能损坏）' };
  try {
    const resp = await fetch(svcUrl + '/status', { signal: AbortSignal.timeout(3000) });
    const j = await resp.json();
    if (j && j.code === 0) return { ok: true, stage: 'running', regions: (j.data && j.data.regions) || [], url: svcUrl };
    return { ok: false, stage: 'error', error: (j && j.msg) || '状态异常' };
  } catch (e) {
    return { ok: false, stage: svcProc ? 'starting' : 'stopped', error: svcProc ? '服务启动中…' : '服务未运行', url: svcUrl };
  }
}

/* 登录（--login user:pass，2FA 可选经 --code-from-file 读 data/2fa.txt）
 * 登录会另起一个 QEMU 实例并占用 12340 转发端口——与运行中的服务实例冲突
 *（已踩：Could not set up host forwarding rule）。故先停服务再等端口释放，
 * 登录完（无论成败）自动把服务拉回来——成功则带上新会话。 */
async function login(user, pass, code2fa) {
  stopService();
  await killOrphans(); // svcProc 丢失的孤儿（如上轮 dev 会话）也一并清掉
  // 等旧实例端口释放（最多 5 秒）
  for (let i = 0; i < 10; i++) {
    try { await fetch(svcUrl + '/status', { signal: AbortSignal.timeout(500) }); await new Promise(r => setTimeout(r, 500)); }
    catch { break; } // 不可达 = 端口已释放
  }
  // 端口仍被占用且不是我们起的实例 → 外部 wrapper 占用，无法接管
  try {
    await fetch(svcUrl + '/status', { signal: AbortSignal.timeout(500) });
    return { ok: false, output: '端口 12340 被其他 wrapper 实例占用，请先关闭它再登录' };
  } catch { }
  const r = await new Promise((resolve) => {
    const args = ['--login', String(user) + ':' + String(pass)];
    if (code2fa) {
      try { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(path.join(dataDir(), '2fa.txt'), String(code2fa), 'utf8'); } catch { }
      args.push('--code-from-file');
    }
    const p = spawn(exePath(), args, { cwd: effectiveWrapperDir(), windowsHide: false });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => {
      resolve({ ok: code === 0, output: out.slice(-800) }); // 末段输出（含错误提示）
    });
    p.on('error', (e) => resolve({ ok: false, output: String(e && e.message || e) }));
  });
  startService().catch(() => { }); // 服务拉回（登录成功则带新会话；失败也恢复可用状态）
  return r;
}

/* 启动服务（无参 = 起 HTTP 服务，端口 12340） */
function startService() {
  if (svcProc && !svcProc.killed) return Promise.resolve({ ok: true, already: true });
  if (svcStarting) return svcStarting;
  const gen = ++svcGen; // V4.6.4：本次启动的代际号，stop 后旧轮询必须退出
  svcStarting = (async () => {
    // V4.6.4：若上一轮刚 stop（taskkill 异步），先等端口释放，避免新实例端口转发冲突
    for (let i = 0; i < 10; i++) {
      try { await fetch(svcUrl + '/status', { signal: AbortSignal.timeout(300) }); await new Promise(r => setTimeout(r, 300)); }
      catch { break; } // 不可达 = 端口已释放
    }
    return new Promise((resolve) => {
      try {
        const proc = spawn(exePath(), [], { cwd: effectiveWrapperDir(), windowsHide: true });
        svcProc = proc;
        /* 从 wrapper 输出解析实际监听地址（启动脚本可能改端口） */
        let outBuf = '';
        const onData = (d) => {
          outBuf += d.toString();
          const u = parseListenUrl(outBuf);
          if (u) svcUrl = u;
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', (e) => { if (svcStarting) svcStarting = null; resolve({ ok: false, error: String(e && e.message || e) }); });
        // V4.6.4：close 回调身份比对——旧进程退出不得误清新进程句柄
        proc.on('close', () => { if (svcProc === proc) svcProc = null; });
        // 等服务就绪（QEMU 虚拟机引导实测 ~15s，留 30 秒轮询 /status）
        let tries = 0;
        const t = setInterval(async () => {
          tries++;
          if (gen !== svcGen) { clearInterval(t); svcStarting = null; resolve({ ok: false, error: '启动已被停止/替换' }); return; }
          const st = await status();
          if (st.ok) { clearInterval(t); svcStarting = null; resolve({ ok: true, url: svcUrl }); }
          else if (tries > 60) { clearInterval(t); svcStarting = null; resolve({ ok: false, error: '服务启动超时（30 秒未就绪）' }); }
        }, 500);
      } catch (e) { svcStarting = null; resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  })();
  return svcStarting;
}

function stopService() {
  svcGen++; // V4.6.4：使进行中的启动轮询/旧 close 回调失效
  svcStarting = null;
  try {
    if (svcProc && !svcProc.killed && svcProc.pid) {
      /* 必须杀进程树：Windows 下 svcProc.kill() 只杀 launcher，qemu-system 子进程
       * 会孤儿化继续占 12340 端口（已踩：登录时端口转发冲突）。taskkill /T 连子代一起杀。 */
      spawn('taskkill', ['/pid', String(svcProc.pid), '/T', '/F'], { windowsHide: true });
    }
  } catch { }
  svcProc = null;
}

/* 清理由我们目录出去的孤儿 qemu/launcher（dev 重启残留场景：svcProc 已丢但进程还在）。
 * 只杀可执行路径属于 effectiveWrapperDir() 的进程——绝不碰章鱼侧工具等其他实例。 */
function killOrphans() {
  return new Promise((resolve) => {
    const dir = effectiveWrapperDir().replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe' or Name='wrapper-lite-qemu.exe'" ` +
      `| Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir}') } ` +
      `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    require('child_process').execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => resolve());
  });
}

/* 应用退出时清理 */
function shutdown() { stopService(); }

module.exports = { status, login, startService, stopService, shutdown, wrapperDir };
