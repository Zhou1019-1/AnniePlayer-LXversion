/* ============================================================
 * README「全功能说明书」章节 + 离线版说明书 生成器
 * 单一事实来源：annie/renderer/js/local/helpContent.js（应用内使用说明）
 * 用法：
 *   node scripts/gen-readme-help.js          写入 README.md（标记区间内替换）+ docs/章鱼科技：安妮播放器全功能说明书.md（整本重生成）
 *   node scripts/gen-readme-help.js --check  只校验是否同步（CI 用，不同步退出码 1）
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readmePath = path.join(root, 'README.md');
const helpPath = path.join(root, 'annie/renderer/js/local/helpContent.js');
const manualPath = path.join(root, 'docs', '章鱼科技：安妮播放器全功能说明书.md');
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

// 离线版说明书：整本重生成（V4.3.16 起与 README 同源，每次发版必跑本脚本）
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manual = ['# 章鱼科技：安妮播放器全功能说明书', '',
  '**产品名称**：' + (pkg.productName || '安妮播放器融合版') + '（AnniePlayer SVLX）',
  '**版本**：V' + pkg.version,
  '**开发者**：无敌章鱼哥（章鱼科技）',
  '**HiFi 资源群**：QQ 1023637098',
  '**许可**：GPL-3.0-only（含 Apache-2.0 洛雪音乐组件）',
  '',
  '> 本文件由 scripts/gen-readme-help.js 自动生成（源：annie/renderer/js/local/helpContent.js），与应用内「设置 → 使用说明」完全同步，请勿手改。',
  '', '---', '',
  ...lines.slice(2, -1), ''].join('\n');

const md = fs.readFileSync(readmePath, 'utf8');
const bi = md.indexOf(BEGIN), ei = md.indexOf(END);
if (bi < 0 || ei < 0) { console.error('[gen-readme-help] README 缺少 ' + BEGIN + ' / ' + END + ' 标记'); process.exit(1); }
const next = md.slice(0, bi) + block + md.slice(ei + END.length);
const oldManual = fs.existsSync(manualPath) ? fs.readFileSync(manualPath, 'utf8') : '';

if (process.argv.includes('--check')) {
  const readmeOk = next === md, manualOk = manual === oldManual;
  if (readmeOk && manualOk) { console.log('[gen-readme-help] README + 离线说明书已同步 ✓'); process.exit(0); }
  console.error('[gen-readme-help] ' + (!readmeOk ? 'README ' : '') + (!manualOk ? '离线说明书 ' : '') + '与 helpContent.js 不同步！请运行 node scripts/gen-readme-help.js');
  process.exit(1);
}
fs.writeFileSync(readmePath, next);
fs.writeFileSync(manualPath, manual);
// docx 版（pandoc 可用时同步生成；缺失则静默跳过，不阻塞流程）
try {
  const { execFileSync } = require('child_process');
  execFileSync('pandoc', [manualPath, '-o', path.join(root, '《章鱼科技：安妮播放器全功能说明书》.docx'), '--from', 'gfm', '--toc', '--toc-depth=2', '-M', 'lang=zh-CN'], { stdio: 'ignore' });
  console.log('[gen-readme-help] docx 已同步（pandoc）');
} catch { console.log('[gen-readme-help] pandoc 不可用，跳过 docx（md 已更新）'); }
console.log('[gen-readme-help] README + 离线说明书 已更新（' + HELP.length + ' 章 / ' + HELP.reduce((n, s) => n + s.items.length, 0) + ' 条）');
