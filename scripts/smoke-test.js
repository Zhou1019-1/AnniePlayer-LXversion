'use strict';
/* CI 冒烟测试（V3.5.15）：打包后对 win-unpacked 的引擎做最小可用性验证。
 * 拦截"能打包不能播"事故（如 ffmpeg 漏进包）。用法：
 *   node scripts/smoke-test.js [engineDir]   默认 setupEXE/win-unpacked/resources/engine
 * 断言：AnnieEngine.exe/ffmpeg/ffprobe 存在；engine.info 报 ffmpegFound；probe 能解码测试音。 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const engineDir = path.resolve(process.argv[2] || 'setupEXE/win-unpacked/resources/engine');
const engineExe = path.join(engineDir, 'AnnieEngine.exe');
const ffmpeg = path.join(engineDir, 'tools', 'ffmpeg.exe');

function fail(msg) { console.error('[smoke] FAIL: ' + msg); process.exit(1); }
function ok(msg) { console.log('[smoke] ' + msg); }

for (const f of [engineExe, ffmpeg, path.join(engineDir, 'tools', 'ffprobe.exe')]) {
  if (!fs.existsSync(f)) fail('文件缺失: ' + f);
}
ok('引擎与 ffmpeg 三件套存在');

/* 1. 用包内 ffmpeg 生成 2 秒测试音（同时验证 ffmpeg 能跑） */
const wav = path.join(os.tmpdir(), 'annie-smoke-' + Date.now() + '.wav');
const gen = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', wav], { encoding: 'utf8' });
if (gen.status !== 0 || !fs.existsSync(wav) || fs.statSync(wav).size < 10000) fail('ffmpeg 生成测试音失败: ' + (gen.stderr || gen.status));
ok('ffmpeg 可运行（已生成测试音）');

/* 2. 引擎 RPC：engine.info / devices.list / probe */
const proc = spawn(engineExe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const replies = {};
let nextId = 1;
const pending = new Map();
proc.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { }
  }
});
let stderrBuf = '';
proc.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); });

function call(method, params, timeoutMs = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('RPC 超时: ' + method)), timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(t);
      if (msg.ok) resolve(msg.result);
      else reject(new Error(method + ' 被拒绝: ' + msg.error));
    });
    proc.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
  });
}

(async () => {
  try {
    const info = await call('engine.info');
    if (!info || info.ffmpegFound !== true || info.ffprobeFound !== true) {
      fail('engine.info 报告 ffmpeg 缺失: ' + JSON.stringify(info));
    }
    ok('engine.info: ffmpeg/ffprobe 已找到');

    const dev = await call('devices.list');
    // CI 无音频设备，wasapi 可为空数组；但必须能枚举（结构正确）且结果不是 Task 包装（V3.5.15 回归）
    if (!dev || !Array.isArray(dev.wasapi) || dev.Result !== undefined) {
      fail('devices.list 结构异常: ' + JSON.stringify(dev).slice(0, 200));
    }
    ok('devices.list 结构正常（设备数: ' + dev.wasapi.length + '，CI 无声卡可为 0）');

    const probe = await call('probe', { path: wav });
    const pr = probe && (probe.sampleRate || probe.SampleRate);
    if (pr !== 48000) fail('probe 探测异常: ' + JSON.stringify(probe).slice(0, 200));
    ok('probe 解码探测正常（48kHz 测试音）');

    console.log('[smoke] 全部通过');
    try { proc.kill(); } catch { }
    try { fs.unlinkSync(wav); } catch { }
    process.exit(0);
  } catch (e) {
    console.error('[smoke] 引擎 stderr 尾部: ' + stderrBuf.split('\n').slice(-5).join('\n'));
    fail(e.message);
  }
})();
