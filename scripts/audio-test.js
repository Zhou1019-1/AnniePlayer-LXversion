/* ============================================================
 * 音频正确性测试集（V4 · Audio Core & Reliability）
 *
 * 思路：引擎 test.decode RPC 不开输出设备，直接拉取与播放完全相同的
 * 解码+DSP 链（ffmpeg → PcmFloatSource：EQ/PEQ/声道矩阵/响度/限幅），
 * 返回帧数/分声道 RMS/峰值/中置能量/直流偏移/超限样本数，脚本侧断言。
 *
 * 用法：npm run test:audio   （CI：release.yml 打包前、ci.yml 日常检查）
 * 素材：lavfi 现场生成到临时目录，不入库。
 * ============================================================ */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

const root = path.join(__dirname, '..');
const FFMPEG = path.join(root, 'engine/tools/ffmpeg.exe');
// 引擎定位：优先 publish 单文件，其次 build 输出（CI 日常检查不打包单文件也能跑）
const ENGINE_CANDIDATES = [
  path.join(root, 'engine/publish/AnnieEngine.exe'),
  path.join(root, 'engine/src/bin/Release/net9.0-windows7.0/AnnieEngine.exe'),
];

let failed = 0, passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail || ''); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)); }
function ratioIn(r, lo, hi) { return r >= lo && r <= hi; }

/* ---------- 极简 JSON-RPC stdio 客户端（协议同 engineClient） ---------- */
function startEngine(exe) {
  const proc = spawn(exe, [], { cwd: path.dirname(exe), stdio: ['pipe', 'pipe', 'inherit'] });
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
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('超时: ' + method)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
    });
  }
  return { call, kill: () => { try { proc.kill(); } catch { } } };
}

/* ---------- 测试素材（lavfi 现场生成） ---------- */
function genFixtures(dir) {
  const F = {};
  const mk = (name, args) => {
    const p = path.join(dir, name);
    execFileSync(FFMPEG, ['-y', '-v', 'error', ...args, p]);
    F[name.replace('.wav', '')] = p;
  };
  // 基准：1kHz 正弦立体声 44.1k/16bit 2s
  mk('sine44.wav', ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2:sample_rate=44100', '-ac', '2', '-c:a', 'pcm_s16le']);
  // 高清：1kHz 正弦立体声 96k/24bit 2s
  mk('sine96.wav', ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2:sample_rate=96000', '-ac', '2', '-c:a', 'pcm_s24le']);
  // 单声道
  mk('mono.wav', ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2:sample_rate=44100', '-ac', '1', '-c:a', 'pcm_s16le']);
  // 非对称：L=1kHz 正弦，R=静音（声道独立性/互换/反相测试）
  mk('asym.wav', ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2:sample_rate=44100', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo[a]', '-map', '[a]', '-c:a', 'pcm_s16le']);
  // 静音
  mk('silence.wav', ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=2', '-c:a', 'pcm_s16le']);
  // 满幅 0dBFS（限幅器测试；aevalsrc 保证满幅）
  mk('loud.wav', ['-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*1000*t):s=44100:d=2', '-ac', '2', '-c:a', 'pcm_s16le']);
  return F;
}

(async () => {
  const engineExe = ENGINE_CANDIDATES.find(p => fs.existsSync(p));
  if (!engineExe) { console.error('[audio-test] 找不到引擎，请先 dotnet publish 或 build'); process.exit(1); }
  if (!fs.existsSync(FFMPEG)) { console.error('[audio-test] 找不到 ffmpeg，请先 npm run setup:tools'); process.exit(1); }
  console.log('[audio-test] 引擎:', engineExe);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-audiotest-'));
  const F = genFixtures(tmp);
  console.log('[audio-test] 素材已生成:', tmp);

  const eng = startEngine(engineExe);
  try {
    // 等引擎 RPC 就绪
    const info = await eng.call('engine.info');
    if (!info || !info.ffmpegFound) throw new Error('引擎未找到 ffmpeg');

    const D = (p, params) => eng.call('test.decode', { path: p, ...(params || {}) });

    /* ---- 1. 基准解码 ---- */
    console.log('\n[1] 基准解码');
    const base = await D(F.sine44);
    ok('44.1k 采样率直通', base.sampleRate === 44100 && !base.resampled, JSON.stringify([base.sampleRate, base.resampled]));
    ok('声道数 = 2', base.channels === 2);
    ok('帧数 ≈ 88200（2s）', approx(base.frames, 88200, 0.01), String(base.frames));
    ok('RMS 非零（有信号）', base.rmsL > 0.05, String(base.rmsL));
    ok('L/R 平衡（对称信号）', approx(base.rmsL, base.rmsR, 0.01), `${base.rmsL} vs ${base.rmsR}`);
    ok('直流偏移 ≈ 0', Math.abs(base.dcL) < 0.001 && Math.abs(base.dcR) < 0.001, `${base.dcL}/${base.dcR}`);
    ok('无超限样本', base.overCount === 0);

    /* ---- 2. 高清源码率 ---- */
    console.log('\n[2] 96k/24bit 源码率');
    const hi = await D(F.sine96);
    ok('96k 直通不重采样', hi.sampleRate === 96000 && hi.sourceRate === 96000 && !hi.resampled);
    ok('帧数 ≈ 192000', approx(hi.frames, 192000, 0.01), String(hi.frames));

    /* ---- 3. 重采样 ---- */
    console.log('\n[3] 重采样 96k → 44.1k');
    const rs = await D(F.sine96, { rate: 44100 });
    ok('输出率 = 44100 且标记重采样', rs.sampleRate === 44100 && rs.resampled === true, JSON.stringify([rs.sampleRate, rs.resampled]));
    ok('帧数比 ≈ 2s', approx(rs.frames, 88200, 0.01), String(rs.frames));
    ok('重采样后信号保留', rs.rmsL > base.rmsL * 0.8, `${rs.rmsL} vs ${base.rmsL}`);

    /* ---- 4. 单声道 ---- */
    console.log('\n[4] 单声道');
    const mono = await D(F.mono);
    ok('声道数 = 1', mono.channels === 1);
    ok('单声道 RMS 与立体声基准一致', approx(mono.rmsL, base.rmsL, 0.03), `${mono.rmsL} vs ${base.rmsL}`);

    /* ---- 5. 静音 ---- */
    console.log('\n[5] 静音');
    const sil = await D(F.silence);
    ok('RMS ≈ 0', sil.rmsL < 1e-5 && sil.rmsR < 1e-5, `${sil.rmsL}/${sil.rmsR}`);

    /* ---- 6. 声道矩阵 ---- */
    console.log('\n[6] 声道工具');
    const asym = await D(F.asym);
    ok('非对称素材：L 有信号 R 静音', asym.rmsL > 0.05 && asym.rmsR < 1e-4, `${asym.rmsL}/${asym.rmsR}`);
    const swap = await D(F.asym, { channelMode: 'swap' });
    ok('左右互换：能量对调', swap.rmsR > asym.rmsL * 0.95 && swap.rmsL < 1e-4, `${swap.rmsL}/${swap.rmsR}`);
    const monoMix = await D(F.asym, { channelMode: 'mono' });
    ok('单声道合并：L=R=(L+R)/2', approx(monoMix.rmsL, asym.rmsL / 2, 0.03) && approx(monoMix.rmsR, monoMix.rmsL, 0.01), `${monoMix.rmsL}/${monoMix.rmsR} vs ${asym.rmsL / 2}`);
    const inv = await D(F.sine44, { channelMode: 'invertL' }); // 对称信号反相：中置应完全抵消
    ok('左反相：单端能量不变', approx(inv.rmsL, base.rmsL, 0.01), String(inv.rmsL));
    ok('左反相：中置（L+R）/2 ≈ 0（相位抵消）', inv.rmsMid < base.rmsL * 0.01, `rmsMid=${inv.rmsMid}`);
    const bal = await D(F.sine44, { channelMode: 'stereo', channelBalance: 1 });
    ok('平衡全右：L 静音 R 保留', bal.rmsL < 1e-4 && bal.rmsR > base.rmsR * 0.95, `${bal.rmsL}/${bal.rmsR}`);

    /* ---- 7. EQ ---- */
    console.log('\n[7] 15 段 EQ');
    const eqBand = await D(F.sine44, { eq: [0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0] }); // 1250Hz 段 +6dB
    ok('单段 +6dB → 1kHz 正弦被部分提升', ratioIn(eqBand.rmsL / base.rmsL, 1.1, 1.7), `ratio=${(eqBand.rmsL / base.rmsL).toFixed(3)}`);
    const eq0 = await D(F.sine44, { eq: new Array(15).fill(0) });
    ok('全 0dB → 与基准一致（无染色）', ratioIn(eq0.rmsL / base.rmsL, 0.99, 1.01), `ratio=${(eq0.rmsL / base.rmsL).toFixed(4)}`);

    /* ---- 8. PEQ ---- */
    console.log('\n[8] 参量 EQ');
    const peq = await D(F.sine44, { peq: [{ f: 1000, g: 6, q: 1 }] });
    ok('1kHz +6dB Q1 → RMS 明显提升', ratioIn(peq.rmsL / base.rmsL, 1.6, 2.3), `ratio=${(peq.rmsL / base.rmsL).toFixed(3)}`);

    /* ---- 9. 限幅器 ---- */
    console.log('\n[9] 削波防护');
    const hot = await D(F.loud, { eq: new Array(15).fill(12), limiter: true });
    ok('满幅+12dB+限幅 → 峰值 ≤ 1.0 无超限', hot.peakL <= 1.0001 && hot.overCount === 0, `peak=${hot.peakL} over=${hot.overCount}`);
    const raw = await D(F.loud, { eq: new Array(15).fill(12), limiter: false });
    ok('关限幅 → 确实超限（验证测试灵敏度）', raw.overCount > 0, `peak=${raw.peakL} over=${raw.overCount}`);

    /* ---- 10. 响度增益 ---- */
    console.log('\n[10] 响度增益');
    const half = await D(F.sine44, { loudGain: 0.5 });
    ok('loudGain 0.5 → RMS 减半', ratioIn(half.rmsL / base.rmsL, 0.48, 0.52), `ratio=${(half.rmsL / base.rmsL).toFixed(3)}`);
  } catch (e) {
    failed++;
    console.error('[audio-test] 执行异常:', e.message);
  } finally {
    eng.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }

  console.log(`\n[audio-test] 通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
