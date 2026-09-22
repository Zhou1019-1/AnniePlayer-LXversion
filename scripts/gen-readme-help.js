/* ============================================================
 * README「全功能说明书」章节生成器
 * 单一事实来源：annie/renderer/js/local/helpContent.js（应用内使用说明）
 * 用法：
 *   node scripts/gen-readme-help.js          写入 README.md（标记区间内替换）
 *   node scripts/gen-readme-help.js --check  只校验是否同步（CI 用，不同步退出码 1）
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readmePath = path.join(root, 'README.md');
const helpPath = path.join(root, 'annie/renderer/js/local/helpContent.js');
const BEGIN = '<!-- HELP:BEGIN -->';
const END = '<!-- HELP:END -->';

// helpContent.js 是渲染层脚本（挂 window.ANNIE_HELP），用 shim 直接执行取值
const window = {};
eval(fs.readFileSync(helpPath, 'utf8'));
const HELP = window.ANNIE_HELP;
if (!Array.isArray(HELP) || !HELP.length) { console.error('[gen-readme-help] ANNIE_HELP 为空'); process.exit(1); }

const lines = [BEGIN, '<!-- 本章节由 scripts/gen-readme-help.js 自动生成（源：annie/renderer/js/local/helpContent.js），请勿手改 -->', '', '## 全功能说明书', ''];
for (const sec of HELP) {
  lines.push('### ' + sec.t, '');
  for (const it of sec.items) lines.push('- **' + it[0] + '**：' + it[1]);
  lines.push('');
}
lines.push(END);
const block = lines.join('\n');

const md = fs.readFileSync(readmePath, 'utf8');
const bi = md.indexOf(BEGIN), ei = md.indexOf(END);
if (bi < 0 || ei < 0) { console.error('[gen-readme-help] README 缺少 ' + BEGIN + ' / ' + END + ' 标记'); process.exit(1); }
const next = md.slice(0, bi) + block + md.slice(ei + END.length);

if (process.argv.includes('--check')) {
  if (next === md) { console.log('[gen-readme-help] README 说明书章节已同步 ✓'); process.exit(0); }
  console.error('[gen-readme-help] README 说明书章节与 helpContent.js 不同步！请运行 node scripts/gen-readme-help.js');
  process.exit(1);
}
fs.writeFileSync(readmePath, next);
console.log('[gen-readme-help] README 已更新（' + HELP.length + ' 章 / ' + HELP.reduce((n, s) => n + s.items.length, 0) + ' 条）');
