'use strict';
/* ============================================================================
 * 开发/CI 环境工具准备（V3.5.14）：npm run setup:tools
 *  - engine/tools/ffmpeg.exe + ffprobe.exe：缺失时自动下载（gyan.dev essentials 静态版）
 *  - engine/publish/AnnieEngine.exe：缺失时提示 dotnet publish 命令（引擎需本机/CI 编译）
 * 背景：engine/tools 不进 git，曾发生"ffmpeg 静默丢失 → 安装包能开不能播"事故。
 * ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'engine', 'tools');
const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

function log(s) { console.log('[setup:tools] ' + s); }
function die(s) { console.error('[setup:tools] 失败: ' + s); process.exit(1); }

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!redirects) return reject(new Error('重定向次数过多'));
        return resolve(download(new URL(res.headers.location, url).href, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      let got = 0, lastPct = -1;
      const total = +res.headers['content-length'] || 0;
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor(got / total * 100);
          if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r[setup:tools] 下载 ffmpeg: ${pct}%`); }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => { process.stdout.write('\n'); resolve(); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(TOOLS, { recursive: true });
  const needFfmpeg = !fs.existsSync(path.join(TOOLS, 'ffmpeg.exe')) || !fs.existsSync(path.join(TOOLS, 'ffprobe.exe'));

  if (!needFfmpeg) log('ffmpeg/ffprobe 已就绪，跳过下载');
  else {
    const zip = path.join(os.tmpdir(), 'annie-ffmpeg-dl.zip');
    const dir = path.join(os.tmpdir(), 'annie-ffmpeg-dl');
    log('下载 ffmpeg（gyan.dev essentials 静态版）…');
    await download(FFMPEG_ZIP_URL, zip).catch(e => die('下载失败: ' + e.message));
    log('解压中…');
    fs.rmSync(dir, { recursive: true, force: true });
    const ex = spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`], { stdio: 'inherit' });
    if (ex.status !== 0) die('解压失败');
    const bin = fs.readdirSync(dir).map(d => path.join(dir, d, 'bin')).find(p => fs.existsSync(p));
    if (!bin) die('压缩包内未找到 bin 目录');
    for (const t of ['ffmpeg.exe', 'ffprobe.exe']) fs.copyFileSync(path.join(bin, t), path.join(TOOLS, t));
    fs.rmSync(zip, { force: true }); fs.rmSync(dir, { recursive: true, force: true });
    log('ffmpeg/ffprobe 已放入 engine/tools');
  }

  // sacd_extract 已随 git 入库（V3.5.14 起），此处仅校验
  if (!fs.existsSync(path.join(TOOLS, 'sacd_extract.exe')))
    die('engine/tools/sacd_extract.exe 缺失——该文件已入库，请检查 git 检出是否完整');

  if (!fs.existsSync(path.join(ROOT, 'engine', 'publish', 'AnnieEngine.exe')))
    log('提示：engine/publish 无引擎二进制，如需本机运行请先执行: dotnet publish engine/src -c Release -o engine/publish');

  log('完成');
})().catch(e => die(e.message));
