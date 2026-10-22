// alacfix.js — ALAC 结束标记（end tag）修复
// 移植自 amd.wol.moe：Apple 部分 ALAC 帧末尾 3 bit 结束标记（111）缺失/错误，
// 严格解码器会报错。此处按样本表逐帧检查最后 3 bit，不对则强制补上。
// 前提：重封装后的标准 MP4（单 chunk、样本连续），仅对「整帧」样本（长度≈标称帧长）动手。
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

function findPath(buf, start, end, path) {
  for (const b of boxes(buf, start, end)) {
    if (b.type !== path[0]) continue;
    if (path.length === 1) return b;
    const r = findPath(buf, b.payload, b.start + b.size, path.slice(1));
    if (r) return r;
  }
  return null;
}

// 解析 ALAC magic cookie：frameLength(u32) / bitDepth(u8@5) / channels(u8@9)
function parseAlacCookie(cookie) {
  let off = 0;
  if (cookie.length >= 8 && cookie.toString('latin1', 4, 8) === 'alac') off = 12; // 跳过 alac box 头+flags
  const c = cookie.subarray(off);
  if (c.length < 24) return null;
  const frameLength = c.readUInt32BE(0), bitDepth = c[5], channels = c[9];
  if (!frameLength || !bitDepth || !channels) return null;
  return { frameLength, bitDepth, channels };
}

// 标称整帧字节数 = ceil((frameLength * channels * bitDepth + 32) / 8)
const nominalFrameBytes = (c) => Math.ceil((c.frameLength * c.channels * c.bitDepth + 32) / 8);

/**
 * 修复 ALAC 帧结束标记。返回修复的帧数。
 * @param {Buffer} buf 重封装后的标准 MP4（会被就地修改）
 */
function alacFix(buf) {
  const moov = findPath(buf, 0, buf.length, ['moov']);
  if (!moov) return 0;
  const stbl = findPath(buf, moov.payload, moov.start + moov.size,
    ['trak', 'mdia', 'minf', 'stbl']);
  if (!stbl) return 0;
  const stsz = findPath(buf, stbl.payload, stbl.start + stbl.size, ['stsz']);
  const stco = findPath(buf, stbl.payload, stbl.start + stbl.size, ['stco']);
  const stsd = findPath(buf, stbl.payload, stbl.start + stbl.size, ['stsd']);
  if (!stsz || !stco || !stsd) return 0;

  // 从 stsd 的 alac sample entry 里找 alac 配置 box（cookie）
  let cookie = null;
  const entryCount = buf.readUInt32BE(stsd.payload + 4);
  let q = stsd.payload + 8;
  for (let i = 0; i < entryCount && q + 8 <= stsd.start + stsd.size; i++) {
    const esize = buf.readUInt32BE(q);
    if (buf.toString('latin1', q + 4, q + 8) === 'alac') {
      for (const c of boxes(buf, q + 36, q + esize)) {
        if (c.type === 'alac') { cookie = buf.subarray(c.start, c.start + c.size); break; }
      }
      break;
    }
    q += esize;
  }
  const cfg = cookie ? parseAlacCookie(cookie) : null;
  if (!cfg) return 0;

  // 样本大小表
  const count = buf.readUInt32BE(stsz.payload + 8);
  const constSize = buf.readUInt32BE(stsz.payload + 4);
  const sizes = [];
  if (constSize !== 0) {
    for (let i = 0; i < count; i++) sizes.push(constSize);
  } else {
    let p = stsz.payload + 12;
    for (let i = 0; i < count && p + 4 <= buf.length; i++, p += 4) sizes.push(buf.readUInt32BE(p));
  }
  // 首个 chunk 偏移（重封装后为单 chunk，样本自此连续排列）
  const chunkCount = buf.readUInt32BE(stco.payload + 4);
  let pos = chunkCount > 0 ? buf.readUInt32BE(stco.payload + 8) : 0;

  const nominal = nominalFrameBytes(cfg);
  let fixed = 0;
  for (const size of sizes) {
    const start = pos, end = start + size;
    pos = end;
    if (start < 0 || end > buf.length || size <= 2 || Math.abs(size - nominal) > 4) continue;
    const b1 = buf[end - 2], b0 = buf[end - 1];
    // 末 3 bit（b1 的 bit0 + b0 的 bit7,bit6）应为 111
    if ((((b1 & 1) << 2) | ((b0 >> 6) & 3)) !== 7) {
      buf[end - 2] = (b1 & 0xfe) | 1;
      buf[end - 1] = (b0 & 0x3f) | 0xc0;
      fixed++;
    }
  }
  return fixed;
}

module.exports = { alacFix };
