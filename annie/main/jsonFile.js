'use strict';
/* V4.6.4：JSON 文件原子写（tmp + rename），与 main.js flushStore 同款式。
 * 背景：beat-cache.json / dl-tasks.json / stream-settings.json / stream-sources.json
 * 此前直接覆盖写，断电/强杀时留下半截 JSON，下次启动解析失败数据清零。
 * 注意：纯 Node 模块（规范 12），禁止顶层 require('electron')，供 CI 纯 Node 测试引用。 */
const fs = require('fs');
const path = require('path');

/** 原子写 JSON：先写 <file>.tmp 再 rename 覆盖。失败抛错由调用方决定兜底策略。 */
function writeJsonAtomic(file, obj, indent) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, indent || 0), 'utf8');
  fs.renameSync(tmp, file);
}

/** 静默版：写失败不抛（沿用旧调用点的静默降级语义），返回是否成功。 */
function tryWriteJsonAtomic(file, obj, indent) {
  try { writeJsonAtomic(file, obj, indent); return true; } catch { return false; }
}

/** 读 JSON，失败/结构非法返回 fallback。 */
function readJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (v && typeof v === 'object') ? v : fallback;
  } catch { return fallback; }
}

module.exports = { writeJsonAtomic, tryWriteJsonAtomic, readJson };
