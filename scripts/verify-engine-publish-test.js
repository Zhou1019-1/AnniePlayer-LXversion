'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const verifier = path.join(__dirname, 'verify-engine-publish.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-engine-publish-test-'));

function writePe(file, size) {
  const data = Buffer.alloc(size);
  data.write('MZ', 0, 'ascii');
  data.writeUInt32LE(64, 0x3c);
  data.write('PE\0\0', 64, 'binary');
  fs.writeFileSync(file, data);
}

function run(dir, expectOk, label) {
  const result = spawnSync(process.execPath, [verifier, dir], { encoding: 'utf8' });
  assert.strictEqual(result.status === 0, expectOk, label + ': ' + (result.stderr || result.stdout));
}

try {
  const good = path.join(root, 'good');
  fs.mkdirSync(good);
  writePe(path.join(good, 'AnnieEngine.exe'), 10 * 1024 * 1024);
  run(good, true, '自包含 PE 应通过');

  const small = path.join(root, 'small');
  fs.mkdirSync(small);
  writePe(path.join(small, 'AnnieEngine.exe'), 1024);
  run(small, false, '小型 framework-dependent apphost 应失败');

  const sidecar = path.join(root, 'sidecar');
  fs.mkdirSync(sidecar);
  writePe(path.join(sidecar, 'AnnieEngine.exe'), 10 * 1024 * 1024);
  fs.writeFileSync(path.join(sidecar, 'AnnieEngine.runtimeconfig.json'), '{}');
  run(sidecar, false, 'runtimeconfig 旁置应失败');

  const malformed = path.join(root, 'malformed');
  fs.mkdirSync(malformed);
  fs.writeFileSync(path.join(malformed, 'AnnieEngine.exe'), Buffer.alloc(10 * 1024 * 1024));
  run(malformed, false, '无效 PE 应失败');

  const missing = path.join(root, 'missing');
  fs.mkdirSync(missing);
  run(missing, false, '缺少 exe 应失败');
  console.log('[engine-publish-test] 5 项检查通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
