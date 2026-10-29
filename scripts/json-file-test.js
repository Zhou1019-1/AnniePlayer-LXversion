'use strict';
/* jsonFile.js 纯 Node 单测（CI 无 npm ci，只引内置模块）
 * 跑法：node scripts/json-file-test.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeJsonAtomic, tryWriteJsonAtomic, readJson } = require('../annie/main/jsonFile');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.error('  FAIL', name); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-jsonfile-'));
const f = path.join(dir, 'a.json');

// 1. 基本写读
writeJsonAtomic(f, { a: 1, b: '中文' });
ok(readJson(f, null).a === 1, 'writeJsonAtomic 写入后可读');
ok(readJson(f, null).b === '中文', '中文内容正确');
ok(!fs.existsSync(f + '.tmp'), 'tmp 文件已被 rename 清理');

// 2. 覆盖写不产生半截文件（连续两次写，内容完整）
writeJsonAtomic(f, { a: 2 });
writeJsonAtomic(f, { a: 3, c: [1, 2, 3] });
ok(readJson(f, null).a === 3 && readJson(f, null).c.length === 3, '连续覆盖写内容完整');

// 3. indent 参数
writeJsonAtomic(f, { x: 1 }, 2);
ok(fs.readFileSync(f, 'utf8').includes('\n'), 'indent=2 产生格式化输出');

// 4. tryWriteJsonAtomic 失败静默返回 false（目标是目录 → rename/write 必败）
ok(tryWriteJsonAtomic(dir, { a: 1 }) === false, '写失败返回 false 不抛异常');

// 5. readJson 坏文件回退
fs.writeFileSync(f, '{broken json', 'utf8');
const fb = { fallback: true };
ok(readJson(f, fb) === fb, '坏 JSON 返回 fallback 对象');
ok(readJson(path.join(dir, 'not-exist.json'), fb) === fb, '文件不存在返回 fallback');

// 6. readJson 非对象（如数字/数组视为非法结构时）回退
fs.writeFileSync(f, '123', 'utf8');
ok(readJson(f, fb) === fb, '非对象 JSON 返回 fallback');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
