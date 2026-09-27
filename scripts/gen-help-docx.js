/* 生成《安妮播放器全功能介绍与使用说明》.docx
 * 内容源：annie/renderer/js/local/helpContent.js（应用内「使用说明」同源，改一处处处同步）
 * 依赖：本机 pandoc（https://pandoc.org）
 * 用法：node scripts/gen-help-docx.js
 * 输出：docs/安妮播放器全功能介绍与使用说明.docx
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_MD = path.join(ROOT, 'docs', '安妮播放器全功能介绍与使用说明.md');
const OUT_DOCX = path.join(ROOT, 'docs', '安妮播放器全功能介绍与使用说明.docx');

// helpContent.js 是浏览器脚本（赋值 window.ANNIE_HELP），垫 window 后按 CJS 加载
global.window = {};
require(path.join(ROOT, 'annie/renderer/js/local/helpContent.js'));
const HELP = global.window.ANNIE_HELP;
if (!Array.isArray(HELP) || !HELP.length) { console.error('helpContent 加载失败'); process.exit(1); }

const pkg = require(path.join(ROOT, 'package.json'));
const today = new Date().toISOString().slice(0, 10);

const lines = [];
lines.push(`% 安妮播放器融合版 · 全功能介绍与使用说明`);
lines.push(`% 无敌章鱼哥`);
lines.push(`% V${pkg.version} · ${today}`);
lines.push('');
lines.push('安妮播放器融合版是一款面向 Windows 10/11 的桌面级 HiFi 音乐播放器：自研 AnnieEngine 音频引擎（独立进程，WASAPI 独占/ASIO 输出，Bit-perfect 链路）+ 3D 粒子视觉舞台 + 洛雪音乐在线生态，三者共享同一曲库与播放队列。');
lines.push('');
lines.push('> 本文档与软件内「设置 → 使用说明」同源同步，随版本更新。更多 HiFi 资源与交流：Q 群 1023637098。');
lines.push('');

for (const ch of HELP) {
  lines.push(`# ${ch.t}`);
  lines.push('');
  for (const [title, desc] of ch.items) {
    lines.push(`**${title}**：${desc}`);
    lines.push('');
  }
}

fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');

try {
  execFileSync('pandoc', [OUT_MD, '-o', OUT_DOCX, '--standalone', '--toc', '--toc-depth=1', '-M', 'lang=zh-CN'], { stdio: 'inherit' });
} catch (e) {
  console.error('pandoc 执行失败（未安装？https://pandoc.org/installing.html）');
  process.exit(1);
}
const kb = (fs.statSync(OUT_DOCX).size / 1024).toFixed(1);
console.log(`已生成 ${OUT_DOCX}（${kb} KB，${HELP.length} 章 / ${HELP.reduce((n, c) => n + c.items.length, 0)} 条）`);
