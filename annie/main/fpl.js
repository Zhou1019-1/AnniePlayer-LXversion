'use strict';
/* foobar2000 .fpl 播放列表解析（V4.3.22）
 * 格式（社区逆向笔记，helpful.knobs-dials.com/Playlist_file_notes；非官方规范，可能随 fb2k 版本变化）：
 *   0..15  16 字节 magic
 *   16     uint32LE 字符串块字节长度
 *   20..   字符串块：连续的 NUL 结尾 UTF-8 字符串，条目按「块内字节偏移」引用
 *   之后   uint32LE 条目数，然后每个条目：
 *            56 字节头（偏移 4..7 = 文件名字符串偏移；52..55 = 键值区的 4 字节单元数）
 *            + 键值区（单元数 * 4 字节，整个跳过）
 * 只取每条的文件路径；标题/艺人等元数据全部由安妮自己的标签解析负责。 */
const path = require('path');

const FPL_MAGIC = Buffer.from([0xe1, 0xa0, 0x9c, 0x91, 0xf8, 0x3c, 0x77, 0x42, 0x85, 0x2c, 0x3b, 0xcc, 0x14, 0x01, 0xd3, 0xf2]);

function isFpl(buf) {
  return !!buf && buf.length >= 20 && buf.subarray(0, 16).equals(FPL_MAGIC);
}

/* buf: .fpl 文件内容；fplDir: .fpl 所在目录（便携版 fb2k 可能写相对路径，相对它解析）。返回本地路径数组 */
function parseFpl(buf, fplDir) {
  if (!isFpl(buf)) throw new Error('不是 foobar2000 播放列表（文件头不匹配）');
  let pos = 16;
  const strLen = buf.readUInt32LE(pos); pos += 4;
  const strBase = pos;
  if (strBase + strLen > buf.length) throw new Error('文件损坏（字符串块越界）');
  pos += strLen;
  const readStr = (off) => {
    if (off < 0 || off >= strLen) return '';
    const start = strBase + off;
    const limit = strBase + strLen;
    let end = start;
    while (end < limit && buf[end] !== 0) end++;
    return buf.toString('utf8', start, end);
  };
  if (pos + 4 > buf.length) throw new Error('文件损坏（条目区越界）');
  const count = buf.readUInt32LE(pos); pos += 4;
  const paths = [];
  for (let i = 0; i < count; i++) {
    if (pos + 56 > buf.length) break; // 尾部截断：保住已解析的条目
    const fnameOff = buf.readUInt32LE(pos + 4);
    const kvUnits = buf.readUInt32LE(pos + 52);
    pos += 56 + kvUnits * 4;
    let p = readStr(fnameOff).trim();
    if (!p) continue;
    p = p.replace(/^file:\/\//i, '');
    if (/^\w+:\/\//.test(p)) continue; // http 等网络流跳过（本地播放列表只收文件）
    if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('\\\\') && fplDir) p = path.resolve(fplDir, p);
    paths.push(p);
  }
  return paths;
}

module.exports = { parseFpl, isFpl };
