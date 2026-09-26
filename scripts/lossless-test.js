'use strict';
/* 无损鉴别准确性验证（V4.0.5）：生成已知真值的样本，跑 losslessDetect 四方法融合检测并断言。
 * 与 UltraMusicTestTool tests/gen_samples.py + run_verification.py 同思路。
 * 用法：node scripts/lossless-test.js
 * 样本（全部 lavfi/ffmpeg 合成，不入库，跑完即删）：
 *   true44   粉噪 44.1k/16bit WAV（真无损对照）
 *   fake128  true44 → MP3 128k → FLAC（砖墙 ~15-16kHz，应判假无损）
 *   fake320  true44 → MP3 320k → FLAC（砖墙 ~20kHz，应判非真无损）
 *   fake24   true44 → 24bit WAV（16→24 位空洞，应被盖帽到 ≤64）
 *   up96     true44 → 96kHz/24bit WAV（带宽止步 22.05kHz，应判假无损级）
 *   true96   粉噪直出 96kHz/24bit WAV（真 Hi-Res 对照）
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { detectLossless } = require('../annie/main/losslessDetect');

const FFMPEG = path.join(__dirname, '..', 'engine', 'tools', 'ffmpeg.exe');

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error'].concat(args), { windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg 失败: ' + args.join(' ') + '\n' + r.stderr);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annietest-'));
  const P = (n) => path.join(dir, n);
  console.log('样本目录：' + dir);

  // 生成样本
  ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=30:amplitude=0.7:seed=42:sample_rate=44100', '-c:a', 'pcm_s16le', P('true44.wav')]);
  ff(['-i', P('true44.wav'), '-c:a', 'libmp3lame', '-b:a', '128k', P('t128.mp3')]);
  ff(['-i', P('t128.mp3'), '-c:a', 'flac', P('fake128.flac')]);
  ff(['-i', P('true44.wav'), '-c:a', 'libmp3lame', '-b:a', '320k', P('t320.mp3')]);
  ff(['-i', P('t320.mp3'), '-c:a', 'flac', P('fake320.flac')]);
  ff(['-i', P('true44.wav'), '-c:a', 'pcm_s24le', P('fake24.wav')]);
  ff(['-i', P('true44.wav'), '-ar', '96000', '-c:a', 'pcm_s24le', P('up96.wav')]);
  ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=30:amplitude=0.7:seed=42:sample_rate=96000', '-c:a', 'pcm_s24le', P('true96.wav')]);
  console.log('样本生成完成，开始检测…\n');

  const CASES = [
    { file: 'true44.wav', name: '真无损 44.1k/16bit', assert: (r) => r.score >= 65, want: 'score≥65' },
    { file: 'fake128.flac', name: 'MP3 128k 转 FLAC', assert: (r) => r.score <= 64 && cut(r) === 1, want: 'score≤64 且检出砖墙截止' },
    { file: 'fake320.flac', name: 'MP3 320k 转 FLAC', assert: (r) => r.score <= 64 && cut(r) === 1, want: 'score≤64 且检出砖墙截止' },
    { file: 'fake24.wav', name: '16→24bit 位空洞', assert: (r) => r.score <= 64 && bd(r) === 16, want: 'score≤64 且有效位深=16' },
    { file: 'up96.wav', name: '44.1→96kHz 上转换', assert: (r) => r.score <= 64 && up(r) === 24, want: 'score≤64 且识别源 Nyquist=24k' },
    { file: 'true96.wav', name: '真 Hi-Res 96k/24bit', assert: (r) => r.score >= 65, want: 'score≥65' },
  ];
  function bd(r) { const m = r.methods.find(x => x.id === 'bitdepth'); return m && m.metrics ? m.metrics.effective_bits : 0; }
  function cut(r) { return r.hasCutoff ? 1 : 0; }
  function up(r) { const m = r.methods.find(x => x.id === 'upsampling'); return m && m.metrics ? m.metrics.suspected_source_nyquist_khz : 0; }

  let pass = 0, fail = 0;
  for (const c of CASES) {
    const r = await detectLossless(P(c.file), {}).done;
    if (!r) { console.log('✗ ' + c.name + '：检测返回 null'); fail++; continue; }
    const ok = c.assert(r);
    console.log((ok ? '✓' : '✗') + ' ' + c.name + ' → ' + r.verdict + '（' + r.score + '/100，期望 ' + c.want + '）');
    for (const m of r.methods) {
      console.log('    [' + m.name + '] ' + (m.applicable ? m.score.toFixed(0) + '/100 ' + m.summary : m.summary));
      if (m.metrics) console.log('      指标: ' + Object.keys(m.metrics).map(k => k + '=' + m.metrics[k]).join('  '));
    }
    ok ? pass++ : fail++;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
