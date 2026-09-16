'use strict';
/* ============================================================================
 * 一键发版脚本（V3.5.3+）：npm run release [-- --skip-build] [-- --draft] [-- --notes "..."]
 *
 * 流程：electron-builder 打包 → 复制中文名副本 → GitHub 建草稿 release →
 *       直连 uploads.github.com 上传 latest.yml / blockmap / exe → 正式发布
 *
 * 说明：
 *  - token 取 `gh auth token`（复用 gh 登录态，不另存凭据）
 *  - api.github.com 走本机代理（gh 自动读 HTTPS_PROXY）；uploads.github.com 直连（更快）
 *  - exe 产物为 ASCII 名（artifactName 已改模板），中文名仅作额外下载件
 * ========================================================================== */
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'setupEXE');
const OWNER = 'Zhou1019-1';
const REPO = 'AnniePlayer-LXversion';
const PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:7897';

const args = process.argv.slice(2);
const opt = {
  skipBuild: args.includes('--skip-build'),
  draft: args.includes('--draft'),
  notes: (args.find(a => a.startsWith('--notes=')) || '').slice(8),
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VER = pkg.version;
const TAG = 'v' + VER;
const EXE_ASCII = `annie-player-svlx-setup-${VER}.exe`;
const EXE_CN = `V${VER}-setup.exe`;

function log(s) { console.log('[release] ' + s); }
function die(s) { console.error('[release] 失败: ' + s); process.exit(1); }

// ---------- 1. 打包 ----------
if (!opt.skipBuild) {
  log('打包中（electron-builder NSIS x64）...');
  const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never'],
    { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) die('electron-builder 退出码 ' + r.status);
} else log('跳过打包（--skip-build）');

const fExe = path.join(OUT, EXE_ASCII);
const fMap = fExe + '.blockmap';
const fYml = path.join(OUT, 'latest.yml');
for (const f of [fExe, fMap, fYml]) if (!fs.existsSync(f)) die('缺少产物: ' + f);
log(`产物就绪: ${EXE_ASCII} (${(fs.statSync(fExe).size / 1048576).toFixed(1)}MB)`);

// 中文名副本（仅作手动下载件，不参与自动更新）
const fCn = path.join(OUT, EXE_CN);
fs.copyFileSync(fExe, fCn);

// ---------- 2. GitHub 凭据 / release ----------
function gh(cmd) {
  const r = spawnSync('gh', cmd, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, HTTPS_PROXY: PROXY } });
  if (r.status !== 0) die(`gh ${cmd[0]} ${cmd[1] || ''}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
const TOKEN = gh(['auth', 'token']);
if (!TOKEN) die('gh 未登录');

const TITLE = `安妮播放器融合版 V${VER}`;
const NOTES = opt.notes || `安妮播放器融合版 V${VER}（详见提交记录）`;

let relId = null;
{ // tag 查询允许 404（不存在则新建），不能用会 exit 的 gh()
  const q = spawnSync('gh', ['api', `repos/${OWNER}/${REPO}/releases/tags/${TAG}`],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, HTTPS_PROXY: PROXY } });
  if (q.status === 0) { try { relId = JSON.parse(q.stdout).id; } catch { } }
}
if (relId) log(`release ${TAG} 已存在（id=${relId}），复用`);
else {
  relId = JSON.parse(gh(['api', `repos/${OWNER}/${REPO}/releases`, '-f', `tag_name=${TAG}`,
    '-f', `name=${TITLE}`, '-f', `body=${NOTES}`, '-F', 'draft=true'])).id;
  log(`已创建草稿 release（id=${relId}）`);
}

// 已存在的同名资产先删（幂等重传）
const existing = JSON.parse(gh(['api', `repos/${OWNER}/${REPO}/releases/${relId}/assets`]));
for (const a of existing) {
  if ([EXE_ASCII, EXE_ASCII + '.blockmap', EXE_CN, 'latest.yml'].includes(a.name)) {
    gh(['api', '-X', 'DELETE', `repos/${OWNER}/${REPO}/releases/assets/${a.id}`]);
    log('删除旧资产: ' + a.name);
  }
}

// ---------- 3. 上传（直连 uploads.github.com）----------
function upload(file, name) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const req = https.request({
      method: 'POST',
      host: 'uploads.github.com',
      path: `/repos/${OWNER}/${REPO}/releases/${relId}/assets?name=${encodeURIComponent(name)}`,
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'User-Agent': 'annie-release-script',
      },
      timeout: 7200000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        process.stdout.write('\n');
        if (res.statusCode === 201) resolve();
        else reject(new Error(`${name}: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(name + ': 上传超时')));
    let sent = 0, lastPct = -1;
    fs.createReadStream(file).on('data', c => {
      sent += c.length;
      const pct = Math.floor(sent / size * 100);
      if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r[release] 上传 ${name}: ${pct}%`); }
    }).pipe(req);
  });
}

(async () => {
  for (const [f, n] of [[fYml, 'latest.yml'], [fMap, EXE_ASCII + '.blockmap'], [fExe, EXE_ASCII], [fCn, EXE_CN]]) {
    log('开始上传: ' + n);
    await upload(f, n).catch(e => die(e.message));
  }
  if (opt.draft) {
    log(`完成，保持草稿: https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}（确认后手动发布）`);
  } else {
    gh(['release', 'edit', TAG, '--draft=false']);
    log(`已正式发布: https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
  }
})().catch(e => die(e.message));
