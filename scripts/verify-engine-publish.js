'use strict';

const fs = require('fs');
const path = require('path');

const engineDir = path.resolve(process.argv[2] || 'engine/publish');
if (!fs.existsSync(engineDir) || !fs.statSync(engineDir).isDirectory()) {
  console.error('[engine-publish] FAIL: 引擎目录不存在: ' + engineDir);
  process.exit(1);
}
const engineExe = path.join(engineDir, 'AnnieEngine.exe');
const engineDll = path.join(engineDir, 'AnnieEngine.dll');
const runtimeConfig = path.join(engineDir, 'AnnieEngine.runtimeconfig.json');
const MIN_SELF_CONTAINED_BYTES = 10 * 1024 * 1024;

function fail(message) {
  console.error('[engine-publish] FAIL: ' + message);
  process.exit(1);
}

if (!fs.existsSync(engineExe)) fail('缺少 AnnieEngine.exe: ' + engineExe);

const stat = fs.statSync(engineExe);
if (!stat.isFile() || stat.size < MIN_SELF_CONTAINED_BYTES) {
  fail('AnnieEngine.exe 体积异常（' + stat.size + ' 字节）；预期为包含 .NET Runtime 的 win-x64 自包含单文件产物');
}

const fd = fs.openSync(engineExe, 'r');
const dosHeader = Buffer.alloc(64);
let peHeader = Buffer.alloc(4);
try {
  fs.readSync(fd, dosHeader, 0, dosHeader.length, 0);
  if (dosHeader.toString('ascii', 0, 2) !== 'MZ') fail('AnnieEngine.exe 不是有效的 PE 文件（缺少 MZ 头）');
  const peOffset = dosHeader.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 4 > stat.size) fail('AnnieEngine.exe 的 PE 头偏移无效');
  peHeader = Buffer.alloc(4);
  fs.readSync(fd, peHeader, 0, peHeader.length, peOffset);
} finally {
  fs.closeSync(fd);
}
if (peHeader.toString('binary') !== 'PE\0\0') fail('AnnieEngine.exe 不是有效的 PE 文件（签名错误）');

const unexpected = [engineDll, runtimeConfig].filter((file) => fs.existsSync(file));
if (unexpected.length) {
  fail('发现框架依赖部署旁置文件：' + unexpected.map((file) => path.basename(file)).join(', '));
}

console.log('[engine-publish] PASS: ' + stat.size + ' 字节 PE 单文件，未发现 AnnieEngine.dll/runtimeconfig');
