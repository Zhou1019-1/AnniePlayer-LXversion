/* AutoEq 精选子集构建脚本（V4.2 规划功能）
 * 从 jaakkopasanen/AutoEq 仓库拉取热门耳机型号的 ParametricEQ 实测校正结果，
 * 转换为本机 PEQ 可用格式（仅 peaking 滤波、最多 8 段），输出 annie/renderer/autoeq-subset.json。
 *
 * 用法：node scripts/autoeq-build.js
 * 输出：annie/renderer/autoeq-subset.json（提交入仓；重新生成才需要联网）
 *
 * 转换规则（与引擎 PeqChain 对齐）：
 *   - PK（峰值）滤波原样保留
 *   - LSC（低架）→ PK @ Fc/√2，HSC（高架）→ PK @ Fc·√2（近似，校正主体在架内频段）
 *   - AutoEq 结果 10 段 → 按 |增益| 保留前 8 段，再按频率升序排列
 *   - AutoEq 的 Preamp 负前级不导入：本机 EQ/PEQ 链有自动前级补偿（按最大正增益）
 *
 * 数据来源说明：AutoEq 项目（github.com/jaakkopasanen/AutoEq）结果数据，
 * 各测量来源（oratory1990 / crinacle / Rtings 等）保留原作者署名于 JSON 的 src 字段。
 */

const fs = require('fs');
const path = require('path');

const INDEX_URL = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/INDEX.md';
const RAW_BASE = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/';
const OUT = path.join(__dirname, '..', 'annie', 'renderer', 'autoeq-subset.json');

/* 测量来源优先级（同型号多来源时取靠前） */
const SRC_PRIORITY = ['oratory1990', 'crinacle', 'Rtings', 'Innerfidelity', 'Super Review',
  'HypetheSonics', 'Regan Cipher', 'Kuulokenurkka', 'Jaytiss', 'ToneDeafMonk', 'DHRME', 'Ted\'s Squig Hoard'];

/* 精选型号：正则匹配 INDEX.md 条目名。选取标准 = 市面热门/保有量大的型号 */
const CURATED = [
  // —— Sennheiser ——
  /Sennheiser HD 600$/, /Sennheiser HD 650$/, /Sennheiser HD 660S2$/,
  /Sennheiser HD 800 S$/, /Sennheiser HD 560S$/, /Sennheiser HD 599$/, /Sennheiser HD 58X/,
  /Sennheiser HD 6XX/, /Sennheiser HD 25$/, /Sennheiser HD 660 S$/, /Sennheiser IE 200$/, /Sennheiser IE 300$/,
  /Sennheiser IE 600$/, /Sennheiser IE 900$/, /Sennheiser Momentum 4/,
  /Sennheiser Momentum True Wireless 3/, /Sennheiser Momentum True Wireless 4/,
  // —— Sony ——
  /Sony WH-1000XM4$/, /Sony WH-1000XM5$/, /Sony WH-1000XM3$/, /Sony WF-1000XM4$/, /Sony WF-1000XM5$/,
  /Sony WF-1000XM3$/, /Sony MDR-7506$/, /Sony MDR-MV1$/, /Sony IER-M7$/, /Sony IER-M9$/,
  /Sony IER-Z1R$/, /Sony LinkBuds S$/, /Sony WF-C500$/,
  // —— Bose / Apple / Samsung / Google / Nothing ——
  /Bose QuietComfort 45$/, /Bose QuietComfort Ultra Headphones/, /Bose QuietComfort 35 II/,
  /Apple AirPods Pro$/, /Apple AirPods Pro 2/, /Apple AirPods Max/, /Apple AirPods 3/, /Apple EarPods/,
  /Samsung Galaxy Buds2 Pro/, /Samsung Galaxy Buds2$/, /Samsung Galaxy Buds Pro/, /Samsung Galaxy Buds Live/,
  /Google Pixel Buds Pro/, /Nothing ear \(1\)$/, /Nothing ear \(2\)$/, /Nothing ear \(a\)$/,
  // —— Beyerdynamic / AKG / Audio-Technica ——
  /Beyerdynamic DT 770 Pro/, /Beyerdynamic DT 880/, /Beyerdynamic DT 990 Pro/, /Beyerdynamic DT 1990 Pro/,
  /Beyerdynamic DT 900 Pro X/, /Beyerdynamic DT 700 Pro X/, /Beyerdynamic Amiron/,
  /AKG K701$/, /AKG K702$/, /AKG K712/, /AKG K371$/, /AKG K361$/, /AKG K240/, /AKG K612/, /AKG N5005/,
  /Audio-Technica ATH-M50x$/, /Audio-Technica ATH-M40x$/, /Audio-Technica ATH-M70x$/,
  /Audio-Technica ATH-R70x$/, /Audio-Technica ATH-MSR7$/, /Audio-Technica ATH-E70$/,
  // —— Hifiman / Focal / Audeze / Meze / Grado / Philips ——
  /Hifiman Sundara$/, /Hifiman Sundara Closed/, /Hifiman Ananda$/, /Hifiman Edition XS/,
  /Hifiman HE400se$/, /Hifiman Arya$/, /Hifiman Deva \(wired\)$/, /Hifiman Svanar$/,
  /Focal Clear$/, /Focal Elex$/, /Focal Utopia/, /Focal Elegia$/, /Focal Bathys/,
  /Audeze LCD-2$/, /Audeze LCD-X$/, /Audeze LCD-3$/, /Audeze MM-500$/, /Audeze Mobius/,
  /Meze 109 Pro/, /Meze 99 Classics/, /Meze Empyrean/, /Meze 105 Aer/,
  /Grado SR80/, /Grado SR225/, /Philips SHP9500$/, /Philips Fidelio X2HR$/, /Philips SHP9600/,
  // —— 国产/ChiFi 入耳 ——
  /Moondrop Aria$/, /Moondrop Aria 2$/, /Moondrop KATO$/, /Moondrop Blessing 2$/, /Moondrop Blessing 3$/,
  /Moondrop Chu$/, /Moondrop Starfield$/, /Moondrop KXXS$/, /Moondrop Variations$/,
  /Moondrop May$/, /Moondrop Space Travel$/, /Moondrop Quarks$/,
  /Truthear Hexa$/, /Truthear x Crinacle Zero$/, /Truthear x Crinacle Zero RED$/, /Truthear Hola$/,
  /Truthear Nova$/, /Truthear Gate$/,
  /7Hz Salnotes Zero$/, /7Hz x Crinacle Zero 2$/, /7Hz Timeless$/, /7Hz Sonus$/, /7Hz Legato$/,
  /KZ ZS10 Pro$/, /KZ ZSN Pro X/, /KZ EDX Pro$/, /KZ AS10$/, /KZ Castor \(off-off-off-off\)$/, /KZ D-FI \(off-off-off-off\)$/,
  /Simgot Audio EW200$/, /Simgot Audio EM6L$/, /Simgot Audio EA500$/, /Simgot Audio EA1000 \(black nozzle\)$/,
  /DUNU Titan S$/, /DUNU Kima$/, /DUNU Falcon Ultra$/,
  /Tin HiFi T2$/, /Tin HiFi C2$/, /Tin HiFi T3 Plus$/, /Tin HiFi C3$/,
  /FiiO FH3$/, /FiiO FH5s$/, /FiiO FD5$/, /FiiO FH9 \(black filter\)$/, /FiiO FF1$/,
  /Shuoer S12$/, /Shuoer S12 Pro$/, /Shuoer EJ07M$/,
  /Kiwi Ears Quartet \(off-off\)$/, /Kiwi Ears Cadenza$/, /Tripowin.*Olina/, /TANGZU Wan'er S\.G/,
  /QKZ x HBB$/, /Rose Technics QuietSea/,
  // —— 经典监听/发烧入耳 ——
  /Shure SE215$/, /Shure SE425$/, /Shure SE535$/, /Shure SE846$/, /Shure SRH840$/, /Shure SRH1540$/,
  /Campfire Audio Andromeda$/, /Campfire Audio Solaris 2020$/, /Campfire Audio Honeydew$/,
  /64 Audio U12t$/, /64 Audio U4S \(m15 Apex module\)$/, /64 Audio Tia Trio$/,
  /Final Audio E3000$/, /Final Audio E4000$/, /Final Audio E5000$/, /Final Audio A4000$/, /Final Audio A8000$/,
  /Etymotic ER2XR$/, /Etymotic ER2SE$/, /Etymotic ER4XR$/, /Etymotic ER4SR$/,
  /Westone W40$/, /Westone UM Pro 30/,
  // —— 消费级 TWS/头戴 ——
  /Anker Soundcore Liberty 4$/, /Anker Soundcore Liberty 3 Pro$/, /Anker Soundcore Life Q30$/,
  /Anker Soundcore Space A40$/, /Anker Soundcore Liberty Air 2 Pro$/,
  /Edifier NeoBuds Pro$/, /Edifier W820NB/, /Edifier TWS1$/,
  /Redmi Buds 6 Pro \(ANC off\)$/, /Huawei Freebuds Pro$/, /Huawei Freebuds 5i \(ANC off\)$/,
  /JBL Live Pro 2 TWS$/, /JBL Tour Pro 2$/, /JBL Tune 230NC/,
  // —— 游戏耳机 ——
  /SteelSeries Arctis Nova Pro$/, /SteelSeries Arctis Nova 7$/, /HyperX Cloud II$/, /Logitech G Pro X/,
];

function parseIndex(md) {
  // 行格式：- [Name](./source/type/Name) by Source on rig
  const entries = [];
  const re = /^- \[(.+)\]\(\.\/(.+?)\) by (.+?)(?:\s+on\s+.+)?$/gm;
  let m;
  while ((m = re.exec(md))) {
    entries.push({ name: m[1], path: m[2], source: m[3] });
  }
  return entries;
}

function formFactor(p) {
  if (/in-ear/.test(p)) return 'in-ear';
  if (/over-ear/.test(p)) return 'over-ear';
  if (/earbud/.test(p)) return 'earbud';
  return 'other';
}

function pickEntry(re, entries, used) {
  const rei = new RegExp(re.source, 'i'); // 大小写不敏感（索引里 HIFIMAN/DUNU 等全大写）
  const cands = entries.filter(e => rei.test(e.name) && !used.has(e.path));
  if (!cands.length) return null;
  // 优先无括号变体名（默认目标/默认模式），再按来源优先级
  cands.sort((a, b) => {
    const ap = a.name.includes('(') ? 1 : 0, bp = b.name.includes('(') ? 1 : 0;
    if (ap !== bp) return ap - bp;
    const ai = SRC_PRIORITY.indexOf(a.source), bi = SRC_PRIORITY.indexOf(b.source);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  return cands[0];
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'annieplayer-autoeq-build' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.text();
}

function parsePeq(txt) {
  // Preamp: -6.1 dB / Filter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70
  const pre = (txt.match(/^Preamp:\s*([-\d.]+)\s*dB/m) || [])[1];
  const filters = [];
  const re = /^Filter\s+\d+:\s*ON\s+(PK|LSC|HSC|LS|HS)\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+([-\d.]+)\s*dB\s+Q\s+([\d.]+)/gm;
  let m;
  while ((m = re.exec(txt))) {
    const type = m[1];
    let f = +m[2], g = +m[3], q = +m[4];
    if (type === 'LSC' || type === 'LS') f = f / Math.SQRT2;      // 低架 → 峰值近似
    else if (type === 'HSC' || type === 'HS') f = f * Math.SQRT2; // 高架 → 峰值近似
    filters.push({ f: Math.min(20000, Math.max(20, Math.round(f))), g, q });
  }
  return { preamp: pre === undefined ? null : +pre, filters };
}

function reduceTo8(filters) {
  // 10 → 8：按 |增益| 保留影响最大的 8 段，再按频率升序
  const kept = filters.slice().sort((a, b) => Math.abs(b.g) - Math.abs(a.g)).slice(0, 8);
  kept.sort((a, b) => a.f - b.f);
  return kept.map(b => [b.f, +b.g.toFixed(1), +b.q.toFixed(2)]);
}

(async () => {
  console.log('拉取 INDEX.md …');
  const md = await fetchText(INDEX_URL);
  const entries = parseIndex(md);
  console.log('索引条目：' + entries.length);

  const used = new Set();
  const models = [];
  const missed = [];
  const failed = [];

  for (const re of CURATED) {
    const e = pickEntry(re, entries, used);
    if (!e) { missed.push(String(re)); continue; }
    used.add(e.path);
    const seg = decodeURIComponent(e.path.split('/').pop());
    const url = RAW_BASE + e.path + '/' + encodeURIComponent(seg + ' ParametricEQ.txt');
    try {
      const txt = await fetchText(url);
      const { preamp, filters } = parsePeq(txt);
      if (!filters.length) { failed.push(e.name + '（无滤波解析结果）'); continue; }
      models.push({
        n: e.name, src: e.source, type: formFactor(e.path),
        pre: preamp, b: reduceTo8(filters),
      });
      console.log('✓ ' + e.name + '  [' + e.source + ']  ' + filters.length + ' 段 → 8 段');
    } catch (err) {
      failed.push(e.name + '（' + err.message + '）');
    }
  }

  models.sort((a, b) => a.n.localeCompare(b.n, 'en'));
  const out = {
    version: 1,
    desc: 'AutoEq 精选耳机校正子集（jaakkopasanen/AutoEq 实测数据，峰化近似，最多 8 段）',
    generated: new Date().toISOString().slice(0, 10),
    count: models.length,
    models,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log('\n完成：' + models.length + ' 个型号 → ' + OUT + '（' + kb + ' KB）');
  if (missed.length) console.log('未匹配（' + missed.length + '）：\n  ' + missed.join('\n  '));
  if (failed.length) console.log('拉取/解析失败（' + failed.length + '）：\n  ' + failed.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
