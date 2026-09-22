/* ============================================================
 * 长稳测试（V4 · Audio Core & Reliability）
 *
 * 循环播放合成音源（混合采样率/声道，含 seek / 暂停恢复 / 无缝切歌），
 * 定期采样引擎 stats RPC + 进程内存/句柄/线程数，结束输出 Markdown 报告。
 *
 * 注意：真实走输出设备，但以 WASAPI 共享模式运行（不独占声卡），低音量。
 * 不进 CI——长稳测试按小时计，本地手动跑。
 *
 * 用法：
 *   npm run test:soak                                    （默认 30 分钟）
 *   node scripts/soak-test.js --minutes 480              （8 小时）
 *   node scripts/soak-test.js --minutes 60 --interval 15 --out 报告.md
 *   运行中 Ctrl+C 可提前结束并出报告
 * ============================================================ */
'use strict';
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

/* ---------- 参数 ---------- */
function argVal(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const MINUTES = Math.max(1, parseFloat(argVal('minutes', '30')));
const INTERVAL_SEC = Math.max(5, parseFloat(argVal('interval', '10')));
const OUT_FILE = path.resolve(argVal('out', '长稳测试报告.md'));

const root = path.join(__dirname, '..');
const FFMPEG = path.join(root, 'engine/tools/ffmpeg.exe');
const ENGINE_CANDIDATES = [
  path.join(root, 'engine/publish/AnnieEngine.exe'),
  path.join(root, 'engine/src/bin/Release/net9.0-windows7.0/AnnieEngine.exe'),
];

/* ---------- 极简 JSON-RPC stdio 客户端（协议同 audio-test） ---------- */
function startEngine(exe) {
  const proc = spawn(exe, [], { cwd: path.dirname(exe), stdio: ['pipe', 'pipe', 'inherit'] });
  const state = { crashed: false, crashCode: null };
  proc.on('exit', (code) => { state.crashed = true; state.crashCode = code; });
  const pending = new Map();
  let nextId = 1;
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null) return; // 事件帧忽略
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
  });
  function call(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (state.crashed) return reject(new Error('引擎进程已退出 code=' + state.crashCode));
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('超时: ' + method)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
    });
  }
  return { call, proc, state, kill: () => { try { proc.kill(); } catch { } } };
}

/* ---------- 进程采样（内存/句柄/线程，经 PowerShell 一次取齐） ---------- */
function sampleProc(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `$p=Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64) $($p.HandleCount) $($p.Threads.Count)"`],
      { encoding: 'utf8', timeout: 8000 }).trim();
    const [mem, handles, threads] = out.split(/\s+/).map(Number);
    return { memMB: Math.round(mem / 1048576), handles, threads };
  } catch { return null; }
}

/* ---------- 测试素材（混合采样率/声道/位深，覆盖重采样与声道路径） ---------- */
function genFixtures(dir) {
  const mk = (name, args) => {
    const p = path.join(dir, name);
    execFileSync(FFMPEG, ['-y', '-v', 'error', ...args, p]);
    return p;
  };
  return [
    mk('a-44k-16.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=20:sample_rate=44100', '-ac', '2', '-c:a', 'pcm_s16le']),
    mk('b-48k-24.wav', ['-f', 'lavfi', '-i', 'sine=frequency=550:duration=20:sample_rate=48000', '-ac', '2', '-c:a', 'pcm_s24le']),
    mk('c-96k-24.wav', ['-f', 'lavfi', '-i', 'sine=frequency=660:duration=20:sample_rate=96000', '-ac', '2', '-c:a', 'pcm_s24le']),
    mk('d-44k-mono.wav', ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=20:sample_rate=44100', '-ac', '1', '-c:a', 'pcm_s16le']),
  ];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtTime = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });

(async () => {
  const engineExe = ENGINE_CANDIDATES.find(p => fs.existsSync(p));
  if (!engineExe) { console.error('[soak] 找不到引擎，请先 dotnet publish 或 build'); process.exit(1); }
  if (!fs.existsSync(FFMPEG)) { console.error('[soak] 找不到 ffmpeg，请先 npm run setup:tools'); process.exit(1); }
  console.log(`[soak] 引擎: ${engineExe}`);
  console.log(`[soak] 计划时长 ${MINUTES} 分钟，采样间隔 ${INTERVAL_SEC}s，报告 → ${OUT_FILE}`);
  console.log('[soak] 以 WASAPI 共享模式低音量运行，不独占声卡；Ctrl+C 提前结束出报告');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-soak-'));
  const fixtures = genFixtures(tmp);
  const eng = startEngine(engineExe);

  const startedAt = Date.now();
  const deadline = startedAt + MINUTES * 60000;
  const samples = [];
  let plays = 0, seeks = 0, pauses = 0, playErrors = 0, consecutiveErr = 0;
  let finished = false;
  process.on('SIGINT', () => { finished = true; }); // Ctrl+C：跳出循环出报告

  // —— 定期采样：stats RPC + 进程指标 ——
  (async () => {
    while (!finished && Date.now() < deadline) {
      try {
        const s = await eng.call('stats', {}, 10000);
        const pm = sampleProc(eng.proc.pid);
        samples.push({
          at: Date.now(), playing: !!s.playing,
          underruns: s.underrunCount || 0, underrunFrames: s.underrunFrames || 0,
          limiterBlocks: s.limiterClipBlocks || 0, decodeFailed: !!s.decodeFailed,
          memMB: pm ? pm.memMB : null, handles: pm ? pm.handles : null, threads: pm ? pm.threads : null,
        });
      } catch { /* 单次采样失败不致命 */ }
      await sleep(INTERVAL_SEC * 1000);
    }
  })();

  try {
    const info = await eng.call('engine.info');
    if (!info || !info.ffmpegFound) throw new Error('引擎未找到 ffmpeg');
    // 共享模式 + 低音量 + 无缝播放：不抢声卡、听感不吵、切歌走 mixer 常驻路径
    await eng.call('devices.select', { kind: 'wasapi', id: null, exclusive: false });
    await eng.call('gapless.set', { on: true });
    await eng.call('volume.set', { gain: 0.15 });

    let i = 0;
    while (!finished && Date.now() < deadline && !eng.state.crashed) {
      const f = fixtures[i % fixtures.length]; i++;
      try {
        // 交替普通播放 / 无缝切歌（gapless 常驻 mixer 路径）
        await eng.call(i % 2 ? 'play' : 'play.crossfade', { path: f, loudGain: 1.0 });
        plays++; consecutiveErr = 0;
      } catch (e) {
        playErrors++; consecutiveErr++;
        console.error(`[soak] 播放失败(${playErrors})：${e.message}`);
        if (consecutiveErr >= 5) throw new Error('连续 5 次播放失败，判定引擎不可用');
        await sleep(2000);
        continue;
      }
      await sleep(6000);
      if (finished) break;
      if (i % 3 === 0) { try { await eng.call('seek', { seconds: 5 }); seeks++; } catch { } await sleep(3000); }
      if (i % 5 === 0) { try { await eng.call('pause'); pauses++; await sleep(1500); await eng.call('resume'); } catch { } await sleep(2000); }
      await sleep(2000); // 单条约 11s：播放 6 + (seek 3 | 暂停 3.5) + 余量 2
      const el = ((Date.now() - startedAt) / 60000).toFixed(1);
      const last = samples[samples.length - 1];
      console.log(`[soak] ${el}min · 已播 ${plays} 轨 · 欠载 ${last ? last.underruns : '-'} · 内存 ${last && last.memMB != null ? last.memMB + 'MB' : '-'}`);
    }
  } catch (e) {
    console.error('[soak] 执行异常:', e.message);
  }

  /* ---------- 汇总报告 ---------- */
  try { await eng.call('stop', {}, 5000); } catch { }
  try { await eng.call('shutdown', {}, 3000); } catch { }
  eng.kill();

  const first = samples.find(s => s.memMB != null) || {};
  const last = [...samples].reverse().find(s => s.memMB != null) || {};
  const peakMem = samples.reduce((m, s) => Math.max(m, s.memMB || 0), 0);
  const memGrowth = (first.memMB && last.memMB) ? last.memMB - first.memMB : 0;
  const dU = samples.length ? (last.underruns || 0) - (first.underruns || 0) : 0;
  const dUF = samples.length ? (last.underrunFrames || 0) - (first.underrunFrames || 0) : 0;
  const dLim = samples.length ? (last.limiterBlocks || 0) - (first.limiterBlocks || 0) : 0;
  const decodeFailed = samples.some(s => s.decodeFailed);
  const crashed = eng.state.crashed;

  // 判定：崩溃/解码失败 = 失败；内存增长 >30% 且 >64MB = 疑似泄漏警告；欠载增长 = 警告（可能是测试机负载）
  const verdicts = [];
  if (crashed) verdicts.push('✗ 引擎进程崩溃（code=' + eng.state.crashCode + '）');
  if (decodeFailed) verdicts.push('✗ 出现解码失败');
  if (playErrors > 0) verdicts.push('✗ 播放 RPC 失败 ' + playErrors + ' 次');
  if (first.memMB && last.memMB && memGrowth > 64 && last.memMB > first.memMB * 1.3) verdicts.push('⚠ 内存增长 ' + memGrowth + 'MB（' + first.memMB + '→' + last.memMB + '），疑似泄漏，建议延长复测');
  if (dU > 0) verdicts.push('⚠ 欠载 +' + dU + ' 次（+' + dUF + ' 帧）——共享模式下可能是系统负载，独占模式复测确认');
  if (!verdicts.length) verdicts.push('✓ 通过：零崩溃 / 零解码失败 / 零播放错误 / 内存稳定 / 无欠载');

  const durMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  const report = [
    '# 安妮播放器 · 长稳测试报告',
    '',
    '- 开始：' + fmtTime(startedAt) + '　结束：' + fmtTime(Date.now()) + '（实际 ' + durMin + ' 分钟）',
    '- 引擎：' + engineExe,
    '- 模式：WASAPI 共享 · gapless 开 · 音量 0.15 · 素材 4 条混合采样率（44.1k/48k/96k/单声道）',
    '',
    '## 结论',
    '',
    ...verdicts.map(v => '- ' + v),
    '',
    '## 汇总',
    '',
    '| 指标 | 起始 | 结束 | 峰值 |',
    '| --- | --- | --- | --- |',
    '| 内存（MB） | ' + (first.memMB ?? '-') + ' | ' + (last.memMB ?? '-') + ' | ' + (peakMem || '-') + ' |',
    '| 句柄数 | ' + (first.handles ?? '-') + ' | ' + (last.handles ?? '-') + ' | - |',
    '| 线程数 | ' + (first.threads ?? '-') + ' | ' + (last.threads ?? '-') + ' | - |',
    '| 欠载次数 | ' + (first.underruns ?? 0) + ' | ' + (last.underruns ?? 0) + ' | - |',
    '| 限幅块 | ' + (first.limiterBlocks ?? 0) + ' | ' + (last.limiterBlocks ?? 0) + ' | - |',
    '',
    '播放 ' + plays + ' 轨 · seek ' + seeks + ' 次 · 暂停/恢复 ' + pauses + ' 次 · 播放错误 ' + playErrors + ' 次 · 采样点 ' + samples.length + ' 个',
    '',
    '## 采样明细（时间 | 内存MB | 句柄 | 线程 | 欠载 | 限幅）',
    '',
    '```',
    ...samples.map(s => [fmtTime(s.at), s.memMB, s.handles, s.threads, s.underruns, s.limiterBlocks].join(' | ')),
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(OUT_FILE, report);
  console.log('\n' + verdicts.join('\n'));
  console.log('[soak] 报告已写入: ' + OUT_FILE);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  process.exit(crashed || decodeFailed || playErrors > 0 ? 1 : 0);
})();
