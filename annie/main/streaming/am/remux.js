// remux.js — fMP4(moof/mdat 分片) 重封装为经典 MP4（填充 stbl 样本表）
// 目的：foobar2000 等只读 moov 样本表的播放器可以正常播放
'use strict';

function* boxes(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    yield { type, start: p, size, payload: p + hdr, hdr };
    p += size;
  }
}

function box(type, ...payloads) {
  const size = 8 + payloads.reduce((a, p) => a + p.length, 0);
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0);
  b.write(type, 4, 'latin1');
  let off = 8;
  for (const p of payloads) { p.copy(b, off); off += p.length; }
  return b;
}

function fullBox(type, version, flags, ...payloads) {
  const vf = Buffer.alloc(4);
  vf.writeUInt8(version, 0);
  vf.writeUIntBE(flags, 1, 3);
  return box(type, vf, ...payloads);
}

const cloneBox = (buf, b) => Buffer.from(buf.subarray(b.start, b.start + b.size));

// stsd 重写：enca → 原始编码（frma），并剥离加密声明 sinf
// 否则 ffmpeg/foobar2000 等会视为「加密/多 fourcc」而拒绝解码
function rewriteStsd(stsd) {
  if (!stsd || stsd.toString('latin1', 4, 8) !== 'stsd') return stsd;
  const entryCount = stsd.readUInt32BE(12);
  const head = Buffer.from(stsd.subarray(0, 16)); // 头 + version/flags + entry_count
  const entries = [];
  let q = 16;
  for (let i = 0; i < entryCount && q + 8 <= stsd.length; i++) {
    const esize = stsd.readUInt32BE(q);
    const etype = stsd.toString('latin1', q + 4, q + 8);
    if (etype !== 'enca' && etype !== 'encv') {
      entries.push(Buffer.from(stsd.subarray(q, q + esize)));
      q += esize;
      continue;
    }
    // 音频 sample entry：固定 28 字节头（含 box 头共 36），子 box 在其后
    const childrenStart = q + 36;
    let frma = null;
    const kept = [];
    for (const c of boxes(stsd, childrenStart, q + esize)) {
      if (c.type === 'sinf') {
        for (const s of boxes(stsd, c.payload, c.start + c.size)) {
          if (s.type === 'frma') frma = stsd.toString('latin1', s.payload, s.payload + 4);
        }
        continue; // 丢弃 sinf（frma/schm/schi/tenc）
      }
      kept.push(Buffer.from(stsd.subarray(c.start, c.start + c.size)));
    }
    const newSize = 36 + kept.reduce((a, b) => a + b.length, 0);
    const entry = Buffer.concat([
      Buffer.from(stsd.subarray(q, q + 36)), // box 头 + sample entry 固定头
      ...kept,
    ]);
    entry.writeUInt32BE(newSize, 0);
    entry.write(frma || 'alac', 4, 'latin1');
    entries.push(entry);
    q += esize;
  }
  const out = Buffer.concat([head, ...entries]);
  out.writeUInt32BE(out.length, 0);
  return out;
}

// 就地改 mvhd/tkhd/mdhd 的 duration（仅 version 0）
function patchDuration(boxBuf, offset, value) {
  boxBuf.writeUInt32BE(value >>> 0, offset);
}

/**
 * @param {Buffer} buf ftyp+moov(init)+[moof+mdat]* 的完整文件
 * @returns {Buffer|null} 经典 MP4；结构不符返回 null
 */
function remuxFMP4(buf) {
  // ---------- 第一遍：收集 ----------
  let ftyp = null, moov = null;
  const fragments = []; // { samples: [{size, dur, cts}], data: Buffer }
  for (const b of boxes(buf, 0, buf.length)) {
    if (b.type === 'ftyp') ftyp = cloneBox(buf, b);
    else if (b.type === 'moov') moov = b;
    else if (b.type === 'moof') fragments.push({ moof: b });
    else if (b.type === 'mdat' && fragments.length) {
      fragments[fragments.length - 1].data = buf.subarray(b.payload, b.start + b.size);
    }
  }
  if (!ftyp || !moov || !fragments.length || fragments.some(f => !f.data)) return null;

  // ---------- moov 里取关键件 ----------
  let mvhd, tkhd, mdhd, hdlr, smhd, dinf, stsd, trex, stbl;
  const moovExtras = []; // udta 等原样保留
  for (const c of boxes(buf, moov.payload, moov.start + moov.size)) {
    if (c.type === 'mvhd') mvhd = cloneBox(buf, c);
    else if (c.type === 'trak') {
      for (const t of boxes(buf, c.payload, c.start + c.size)) {
        if (t.type === 'tkhd') tkhd = cloneBox(buf, t);
        else if (t.type === 'mdia') {
          for (const m of boxes(buf, t.payload, t.start + t.size)) {
            if (m.type === 'mdhd') mdhd = cloneBox(buf, m);
            else if (m.type === 'hdlr') hdlr = cloneBox(buf, m);
            else if (m.type === 'minf') {
              for (const n of boxes(buf, m.payload, m.start + m.size)) {
                if (n.type === 'smhd') smhd = cloneBox(buf, n);
                else if (n.type === 'dinf') dinf = cloneBox(buf, n);
                else if (n.type === 'stbl') {
                  stbl = n;
                  for (const s of boxes(buf, n.payload, n.start + n.size)) {
                    if (s.type === 'stsd') stsd = cloneBox(buf, s);
                  }
                }
              }
            }
          }
        }
      }
    } else if (c.type === 'mvex') {
      for (const v of boxes(buf, c.payload, c.start + c.size)) {
        if (v.type === 'trex') trex = v;
      }
    } else if (c.type === 'udta') moovExtras.push(cloneBox(buf, c));
  }
  if (!mvhd || !tkhd || !mdhd || !stsd) return null;
  stsd = rewriteStsd(stsd);

  // trex 默认时长/大小
  let trexDur = 0, trexSize = 0;
  if (trex) {
    trexDur = buf.readUInt32BE(trex.payload + 12);
    trexSize = buf.readUInt32BE(trex.payload + 16);
  }
  const mediaTimescale = mdhd.readUInt32BE(20);   // mdhd v0
  const movieTimescale = mvhd.readUInt32BE(20);   // mvhd v0

  // ---------- 解析每个 moof 的 trun ----------
  let totalSamples = 0, totalDuration = 0;
  const allSizes = [];
  const sttsRuns = [];   // [count, delta]
  const ctts = [];       // [count, offset]，仅在有 cts offset 时
  let hasCtts = false;

  for (const f of fragments) {
    f.samples = [];
    for (const tr of boxes(buf, f.moof.payload, f.moof.start + f.moof.size)) {
      if (tr.type !== 'traf') continue;
      let defDur = trexDur, defSize = trexSize;
      for (const c of boxes(buf, tr.payload, tr.start + tr.size)) {
        const p = c.payload;
        if (c.type === 'tfhd') {
          const flags = buf.readUInt32BE(p) & 0xffffff;
          let q = p + 8;
          if (flags & 0x1) q += 8;
          if (flags & 0x2) q += 4;
          if (flags & 0x8) { defDur = buf.readUInt32BE(q); q += 4; }
          if (flags & 0x10) { defSize = buf.readUInt32BE(q); q += 4; }
        } else if (c.type === 'trun') {
          const flags = buf.readUInt32BE(p) & 0xffffff;
          const count = buf.readUInt32BE(p + 4);
          let q = p + 8;
          let dataOffset = 0;
          if (flags & 0x1) { dataOffset = buf.readInt32BE(q); q += 4; }
          if (flags & 0x4) q += 4;
          let off = f.moof.start + dataOffset; // 精确按 trun 定位 sample 数据
          for (let i = 0; i < count; i++) {
            let dur = defDur, size = defSize, cts = null;
            if (flags & 0x100) { dur = buf.readUInt32BE(q); q += 4; }
            if (flags & 0x200) { size = buf.readUInt32BE(q); q += 4; }
            if (flags & 0x400) q += 4;
            if (flags & 0x800) { cts = buf.readUInt32BE(q); q += 4; hasCtts = true; }
            f.samples.push({ offset: off, size, dur, cts });
            off += size;
          }
        }
      }
    }
    for (const s of f.samples) {
      allSizes.push(s.size);
      const last = sttsRuns[sttsRuns.length - 1];
      if (last && last[1] === s.dur) last[0]++;
      else sttsRuns.push([1, s.dur]);
      if (hasCtts) {
        const lc = ctts[ctts.length - 1];
        const v = s.cts ?? 0;
        if (lc && lc[1] === v) lc[0]++;
        else ctts.push([1, v]);
      }
      totalSamples++;
      totalDuration += s.dur;
    }
  }
  if (!totalSamples) return null;

  // ---------- 重建 moov ----------
  const sttsBody = Buffer.alloc(4 + sttsRuns.length * 8);
  sttsBody.writeUInt32BE(sttsRuns.length, 0);
  sttsRuns.forEach(([c, d], i) => { sttsBody.writeUInt32BE(c, 4 + i * 8); sttsBody.writeUInt32BE(d, 8 + i * 8); });

  const stscBody = Buffer.alloc(4 + 12);
  stscBody.writeUInt32BE(1, 0);
  stscBody.writeUInt32BE(1, 4);               // first_chunk
  stscBody.writeUInt32BE(totalSamples, 8);    // samples_per_chunk（单 chunk）
  stscBody.writeUInt32BE(1, 12);              // sample_description_index

  const stszBody = Buffer.alloc(8 + allSizes.length * 4);
  stszBody.writeUInt32BE(0, 0);               // sample_size=0 → 用表
  stszBody.writeUInt32BE(allSizes.length, 4);
  allSizes.forEach((s, i) => stszBody.writeUInt32BE(s, 8 + i * 4));

  const stcoBody = Buffer.alloc(8);           // 占位，偏移量最后回填
  stcoBody.writeUInt32BE(1, 0);

  const stblParts = [
    stsd,
    fullBox('stts', 0, 0, sttsBody),
    fullBox('stsc', 0, 0, stscBody),
    fullBox('stsz', 0, 0, stszBody),
    fullBox('stco', 0, 0, stcoBody),
  ];
  if (hasCtts) {
    const cttsBody = Buffer.alloc(4 + ctts.length * 8);
    cttsBody.writeUInt32BE(ctts.length, 0);
    ctts.forEach(([c, o], i) => { cttsBody.writeUInt32BE(c, 4 + i * 8); cttsBody.writeUInt32BE(o, 8 + i * 8); });
    stblParts.push(fullBox('ctts', 0, 0, cttsBody));
  }
  const newStbl = box('stbl', ...stblParts);
  const newMinf = box('minf', smhd, dinf, newStbl);

  // mdhd duration（媒体时间轴）
  patchDuration(mdhd, 24, totalDuration);
  const newMdia = box('mdia', mdhd, hdlr, newMinf);

  // tkhd duration（电影时间轴）
  const movieDuration = Math.round(totalDuration * movieTimescale / mediaTimescale);
  patchDuration(tkhd, 28, movieDuration);
  const newTrak = box('trak', tkhd, newMdia);

  patchDuration(mvhd, 24, movieDuration);
  const newMoov = box('moov', mvhd, newTrak, ...moovExtras);

  // ---------- 组装 ----------
  // 精确拼接每个 sample 的字节（跳过 mdat 里可能存在的尾部填充/附加数据）
  const allSamples = fragments.flatMap(f => f.samples);
  const mdatPayload = Buffer.concat(allSamples.map(s => buf.subarray(s.offset, s.offset + s.size)));
  const mdatHeaderSize = mdatPayload.length + 8 > 0xffffffff ? 16 : 8;
  const chunkOffset = ftyp.length + newMoov.length + mdatHeaderSize;
  // 回填 stco（box 是构建时拷贝的，直接在 newMoov 里找 stco 改）
  const stcoPos = newMoov.indexOf('stco');
  if (stcoPos < 0) return null;
  newMoov.writeUInt32BE(chunkOffset, stcoPos + 12); // type(4)+v/f(4)+count(4) 之后

  let mdat;
  if (mdatHeaderSize === 16) {
    mdat = Buffer.alloc(16);
    mdat.writeUInt32BE(1, 0);
    mdat.write('mdat', 4, 'latin1');
    mdat.writeBigUInt64BE(BigInt(mdatPayload.length + 16), 8);
    mdat = Buffer.concat([mdat, mdatPayload]);
  } else {
    mdat = box('mdat', mdatPayload);
  }
  return Buffer.concat([ftyp, newMoov, mdat]);
}

module.exports = { remuxFMP4 };
