// ===== wrapper-lite 运行时下载与强校验（V4.6：Apple Music 音源后端）=====
// 背景：wrapper-lite（QEMU 虚拟 Apple 客户端，裁剪后 ~275MB）不入 git，
// 托管为 GitHub Release 资产（tag wrapper-lite-v1）。本脚本：
//   1. 已存在且校验通过 → 跳过（dev 常态）；
//   2. 缺失/不完整 → 下载 zip → SHA256 比对 → 解压 → 落盘校验；
//   3. 任何一步失败 → exit 1，让打包流程直接红掉，绝不静默放出缺 wrapper 的安装包。
// 用法：node scripts/setup-wrapper.js   （release.yml 与本地 predist:setup 共用）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const WRAPPER_DIR = path.join(__dirname, '..', 'annie', 'resources', 'wrapper-lite');
const ZIP_PATH = path.join(__dirname, '..', 'engine', 'tools', '.wrapper-lite-download.zip'); // 临时落点（tools 已 gitignore）
const ASSET_URL = 'https://github.com/Zhou1019-1/AnniePlayer-LXversion/releases/download/wrapper-lite-v1/wrapper-lite.zip';
/* wrapper-lite-v1 资产的 SHA256（上传时实测值；升级 wrapper 时同步更新） */
const EXPECTED_SHA256 = '8fbedd4ed3d02e58451846a167e4b3fbea3eaed3f0d108e3841c83d78855c54c';
/* 解压后落盘校验基线（裁剪版实测：192 文件 / 275.6MB） */
const MIN_FILES = 180;
const MIN_TOTAL_BYTES = 260 * 1024 * 1024;
const KEY_FILES = [
  'wrapper-lite-qemu.exe',
  path.join('qemu', 'bin', 'qemu-system-x86_64.exe'),
  path.join('qemu', 'lite-initramfs.cpio.gz'),
  path.join('qemu', 'vmlinuz-lite-qemu'),
  path.join('qemu', 'data.img'),
];

function fail(msg) { console.error('[setup-wrapper] 失败：' + msg); process.exit(1); }

/* 落盘校验：关键文件存在 + 文件数/总大小达标 */
function verifyDir() {
  for (const rel of KEY_FILES) {
    if (!fs.existsSync(path.join(WRAPPER_DIR, rel))) return '缺少关键文件 ' + rel;
  }
  let files = 0, total = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { files++; total += fs.statSync(p).size; }
    }
  })(WRAPPER_DIR);
  if (files < MIN_FILES) return `文件数不足（${files} < ${MIN_FILES}）`;
  if (total < MIN_TOTAL_BYTES) return `总大小不足（${(total / 1048576).toFixed(1)}MB < ${(MIN_TOTAL_BYTES / 1048576).toFixed(0)}MB）`;
  return null;
}

async function download(url, dest) {
  console.log('[setup-wrapper] 下载 ' + url + ' …');
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log('[setup-wrapper] 下载完成 ' + (buf.length / 1048576).toFixed(1) + 'MB');
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

(async () => {
  // ① 已存在且完整 → 跳过
  if (fs.existsSync(path.join(WRAPPER_DIR, 'wrapper-lite-qemu.exe'))) {
    const bad = verifyDir();
    if (!bad) { console.log('[setup-wrapper] wrapper-lite 已存在且校验通过，跳过下载'); return; }
    console.warn('[setup-wrapper] 已存在的 wrapper-lite 不完整（' + bad + '），重新下载');
    fs.rmSync(WRAPPER_DIR, { recursive: true, force: true });
  }

  // ② 下载 + SHA256 强校验
  try { await download(ASSET_URL, ZIP_PATH); }
  catch (e) { fail('下载失败：' + e.message); }
  const actual = sha256File(ZIP_PATH);
  if (EXPECTED_SHA256.startsWith('__')) fail('脚本中的 EXPECTED_SHA256 未填写（占位符未替换）');
  if (actual !== EXPECTED_SHA256) fail('SHA256 不匹配：期望 ' + EXPECTED_SHA256 + '，实际 ' + actual + '（资产被替换/下载损坏，已阻断）');
  console.log('[setup-wrapper] SHA256 校验通过');

  // ③ 解压（Windows 自带 bsdtar 对部分 zip 条目兼容性差，改用 Expand-Archive）
  fs.mkdirSync(WRAPPER_DIR, { recursive: true });
  try {
    if (process.platform === 'win32') {
      // Windows：GitHub runner 上是 pwsh（PowerShell 7），本地可能是 powershell（Windows PowerShell）
      // 优先 pwsh，失败回退 powershell，再失败回退 tar
      let expanded = false;
      for (const cmd of ['pwsh', 'powershell']) {
        try {
          execFileSync(cmd, ['-NoProfile', '-Command', `Expand-Archive -Path '${ZIP_PATH}' -DestinationPath '${WRAPPER_DIR}' -Force`], { stdio: 'inherit' });
          expanded = true;
          break;
        } catch { /* 继续尝试下一个 */ }
      }
      if (!expanded) {
        console.warn('[setup-wrapper] Expand-Archive 不可用，回退 tar');
        execFileSync('tar', ['-xf', ZIP_PATH, '-C', WRAPPER_DIR], { stdio: 'inherit' });
      }
    } else {
      // Linux/macOS：tar 直解
      execFileSync('tar', ['-xf', ZIP_PATH, '-C', WRAPPER_DIR], { stdio: 'inherit' });
    }
  } catch (e) { fail('解压失败：' + e.message); }

  // ④ 落盘校验，不过即红
  const bad = verifyDir();
  if (bad) fail('解压后校验未过：' + bad);
  console.log('[setup-wrapper] wrapper-lite 就绪（' + WRAPPER_DIR + '）');

  try { fs.rmSync(ZIP_PATH, { force: true }); } catch { }
})().catch((e) => fail(String((e && e.message) || e)));
