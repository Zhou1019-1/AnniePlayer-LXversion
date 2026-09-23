/* ============================================================
 * 曲库性能 Benchmark（V4 · Audio Core & Reliability）
 *
 * 两层测试：
 *   A. 真实文件扫描层（1k/10k，--full 加 50k）：临时目录生成微型 wav 树，
 *      实测 library.scanFolders（目录遍历+拼音排序）与 readMetaBatch（music-metadata 解析）
 *   B. 数据层（1k/10k/50k/100k/200k 合成数据）：启动加载（JSON 持久化往返，同 loadStore）、
 *      排序（直接执行生产代码 listWorker.js 的 legacy/fb2k 排序）、搜索（子串过滤）、内存占用
 *
 * 用法：
 *   npm run bench:library                 （标准：扫描 1k/10k + 数据层全档）
 *   node scripts/library-bench.js --full  （完整：扫描加 50k 真实文件）
 *   node scripts/library-bench.js --out 报告.md
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const FFMPEG = path.join(root, 'engine/tools/ffmpeg.exe');
const library = require(path.join(root, 'annie/main/library'));

function argVal(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const FULL = process.argv.includes('--full');
const OUT_FILE = path.resolve(argVal('out', '曲库Benchmark报告.md'));

const now = () => Number(process.hrtime.bigint() / 1000000n); // ms
const mb = (bytes) => Math.round(bytes / 1048576);

/* ---------- 生产排序代码：listWorker.js 用 self shim 直接执行（与渲染层同源） ---------- */
function loadListWorker() {
  const code = fs.readFileSync(path.join(root, 'annie/renderer/js/local/listWorker.js'), 'utf8');
  const self = {};
  new Function('self', code)(self);
  return {
    run(payload) {
      let out = null;
      self.postMessage = (m) => { out = m; };
      self.onmessage({ data: payload });
      return out;
    }
  };
}

/* ---------- 合成曲库（中英文混合，贴近真实曲库分布） ---------- */
const ARTISTS = ['周杰伦', 'Taylor Swift', '贝多芬', 'Aimer', '陈奕迅', '久石让', 'Daft Punk', '王菲', ' Hans Zimmer', 'RADWIMPS'];
const ALBUM_WORDS = ['范特西', 'Midnights', '交响曲', '残響散歌', 'U87', '宫崎骏精选', 'Discovery', '天空', '星际穿越', '你的名字'];
const GENRES = ['流行', '摇滚', '古典', '电子', '原声', '爵士'];
function genLibrary(n) {
  const tracks = new Array(n);
  const tagCache = {};
  for (let i = 0; i < n; i++) {
    const a = ARTISTS[i % ARTISTS.length];
    const al = ALBUM_WORDS[i % ALBUM_WORDS.length] + ' ' + (2000 + (i % 25));
    const dir = 'D:/Music/' + a.trim() + '/' + al;
    const name = a.trim() + ' - 曲目' + String(i % 97).padStart(2, '0') + '.flac';
    const p = dir + '/' + name;
    tracks[i] = { path: p, name, dir, ext: '.flac', size: 20 * 1048576 + (i % 1000), mtime: 1700000000000 + i * 1000 };
    tagCache[p] = { artist: a.trim(), album: al, genre: GENRES[i % GENRES.length], year: 2000 + (i % 25) };
  }
  return { tracks, tagCache };
}

/* ---------- A. 真实文件扫描 ---------- */
function benchScan(n, tmpRoot, baseWav) {
  const libDir = path.join(tmpRoot, 'lib' + n);
  fs.mkdirSync(libDir, { recursive: true });
  // 模拟 艺术家/专辑 两层目录（100 艺术家 × 每艺术家 5 专辑）
  for (let i = 0; i < n; i++) {
    const dir = path.join(libDir, '艺术家' + (i % 100), '专辑' + (i % 500));
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(baseWav, path.join(dir, '曲目' + i + '.wav')); // 全局唯一文件名（i 取模会互相覆盖）
  }
  const t0 = now();
  const tracks = library.scanFolders([libDir]);
  const scanMs = now() - t0;
  if (tracks.length !== n) throw new Error(`曲库生成异常：预期 ${n} 个文件，实际扫到 ${tracks.length}（检查文件名是否冲突）`);
  const t1 = now();
  // readMetaBatch 全量解析太慢（10k×music-metadata），抽样 2000 条换算
  const sample = tracks.slice(0, Math.min(2000, tracks.length)).map(t => t.path);
  return library.readMetaBatch(sample).then(() => {
    const metaMs = now() - t1;
    const metaEst = Math.round(metaMs * tracks.length / sample.length);
    return { n, files: tracks.length, scanMs, metaMs, metaEst, metaSample: sample.length };
  });
}

(async () => {
  console.log('[bench] 曲库性能 Benchmark 开始' + (FULL ? '（--full 含 5 万真实文件扫描）' : ''));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annie-bench-'));
  const lw = loadListWorker();
  const rows = [];

  /* ---- A. 真实文件扫描层 ---- */
  console.log('\n[A] 真实文件扫描（生成测试曲库…）');
  const baseWav = path.join(tmp, 'base.wav');
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2:sample_rate=8000', '-ac', '1', baseWav]);
  const scanSizes = FULL ? [1000, 10000, 50000] : [1000, 10000];
  const scanRows = [];
  for (const n of scanSizes) {
    const r = await benchScan(n, tmp, baseWav);
    scanRows.push(r);
    console.log(`  ${n} 文件：遍历+排序 ${r.scanMs}ms，元数据解析 ${r.metaSample} 条实测 ${r.metaMs}ms（全量估算 ${r.metaEst}ms）`);
    // 清理当前档，避免 50k 档叠加占用
    fs.rmSync(path.join(tmp, 'lib' + n), { recursive: true, force: true });
  }

  /* ---- B. 数据层（合成 1k~200k） ---- */
  console.log('\n[B] 数据层（合成曲库）');
  const DATA_SIZES = [1000, 10000, 50000, 100000, 200000];
  const storeFile = path.join(tmp, 'store.json');
  for (const n of DATA_SIZES) {
    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const { tracks, tagCache } = genLibrary(n);
    const heapAfter = process.memoryUsage().heapUsed;
    const memMB = mb(heapAfter - heapBefore);

    // 启动加载：JSON 序列化 + 写盘 + 读盘 + 解析（同 main.js loadStore 路径）
    let t = now();
    const json = JSON.stringify({ tracks, metaCache: tagCache });
    const serMs = now() - t;
    t = now();
    fs.writeFileSync(storeFile, json);
    const writeMs = now() - t;
    t = now();
    const loaded = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const loadMs = now() - t;
    const bootMs = serMs + writeMs + loadMs;

    // 排序：生产 listWorker 代码实测（拼音 Collator 是大头）
    t = now();
    lw.run({ op: 'legacy-sort', mode: 'name', tracks, tagCache });
    const sortNameMs = now() - t;
    t = now();
    lw.run({ op: 'fb2k-sort', sortKey: null, tracks, tagCache });
    const sortAlbumMs = now() - t;

    // 搜索：子串过滤（名称/艺术家/专辑 三字段，模拟渲染层搜索）
    const q = '曲目';
    t = now();
    const hits = loaded.tracks.filter(x => {
      const tg = loaded.metaCache[x.path] || {};
      return x.name.toLowerCase().includes(q) || (tg.artist || '').toLowerCase().includes(q) || (tg.album || '').toLowerCase().includes(q);
    }).length;
    const searchMs = now() - t;

    rows.push({ n, memMB, bootMs, sortNameMs, sortAlbumMs, searchMs, hits, jsonMB: mb(json.length) });
    console.log(`  ${n}：内存 ${memMB}MB · 加载 ${bootMs}ms · 排序(名称) ${sortNameMs}ms · 排序(专辑) ${sortAlbumMs}ms · 搜索 ${searchMs}ms`);
  }

  /* ---- 报告 ---- */
  const scanMap = {};
  scanRows.forEach(r => { scanMap[r.n] = r; });
  const lines = [
    '# 安妮播放器 · 曲库性能 Benchmark 报告',
    '',
    '- 时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
    '- 环境：Node ' + process.version + ' / ' + os.platform() + ' ' + os.release() + ' / ' + os.cpus()[0].model,
    '- 说明：扫描列为真实文件实测（元数据解析按 2000 条抽样估算全量）；启动/排序/搜索/内存为合成数据层实测（排序直接执行生产代码 listWorker.js）',
    '',
    '| 曲库规模 | 扫描（遍历+排序） | 元数据解析（估算） | 启动加载 | 排序·名称 | 排序·专辑分组 | 搜索 | 内存占用 |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...DATA_SIZES.map((n, i) => {
      const r = rows[i], sc = scanMap[n];
      return '| ' + n.toLocaleString()
        + ' | ' + (sc ? sc.scanMs + ' ms' : '—')
        + ' | ' + (sc ? sc.metaEst + ' ms' : '—')
        + ' | ' + r.bootMs + ' ms'
        + ' | ' + r.sortNameMs + ' ms'
        + ' | ' + r.sortAlbumMs + ' ms'
        + ' | ' + r.searchMs + ' ms'
        + ' | ' + r.memMB + ' MB |';
    }),
    '',
    '数据层存储 JSON 体积：' + rows.map(r => (r.n / 1000) + 'k=' + r.jsonMB + 'MB').join('，'),
    '',
  ].join('\n');
  fs.writeFileSync(OUT_FILE, lines);
  console.log('\n[bench] 报告已写入: ' + OUT_FILE);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
})().catch(e => { console.error('[bench] 失败:', e); process.exit(1); });
