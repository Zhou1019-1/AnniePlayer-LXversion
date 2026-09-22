'use strict';
/* 语法快速检查（CI 日常提交用）：对全部 JS 源码跑 node --check，防坏代码进 main。
 * 用法：node scripts/check-syntax.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOTS = ['annie/main', 'annie/renderer', 'src', 'scripts'];
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'lx-sdk') continue; // 第三方/依赖不查
      walk(full);
    } else if (/\.js$/.test(e.name)) files.push(full);
  }
}
for (const r of ROOTS) if (fs.existsSync(r)) walk(r);

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.error('FAIL ' + f + '\n' + (r.stderr || '').trim()); }
}
console.log(`[check-syntax] ${files.length} 个文件，${failed} 个失败`);
process.exit(failed ? 1 : 0);
