// m4a(fMP4) 元数据写入：向 moov 追加 udta/meta/ilst
// 适用于 Apple HLS 单文件 fMP4（init 段 moov + moof/mdat 分片）：
// sample 位置由 trun data_offset（相对 moof）寻址，moov 增长不影响播放。
'use strict';

function box(type, ...payloads) {
  const size = 8 + payloads.reduce((a, p) => a + p.length, 0);
  const b = Buffer.alloc(size);
  b.writeUInt32BE(size, 0);
  b.write(type, 4, 'latin1');
  let off = 8;
  for (const p of payloads) { p.copy(b, off); off += p.length; }
  return b;
}

function dataAtom(payload, typeFlags) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(typeFlags, 0); // 0x1=UTF-8 文本, 0xD=JPEG, 0xE=PNG, 0x15=整型对
  return box('data', head, payload);
}

const textItem = (fourcc, str) => box(fourcc, dataAtom(Buffer.from(String(str), 'utf8'), 1));

function pairItem(fourcc, a, b) {
  const p = Buffer.alloc(8);
  p.writeUInt16BE(a, 2);
  p.writeUInt16BE(b, 4);
  return box(fourcc, dataAtom(p, 0x15));
}

// 自由格式字段：----/mean=com.apple.iTunes/name=<key>
function freeformItem(key, str) {
  return box('----', box('mean', Buffer.from('\x00\x00\x00\x00com.apple.iTunes')),
    box('name', Buffer.from('\x00\x00\x00\x00' + key)), dataAtom(Buffer.from(String(str), 'utf8'), 1));
}

// 32 位整型字段（cnID/plID/atID，iTunes 惯例 0x15 大端 4 字节）
function intItem(fourcc, n) {
  const p = Buffer.alloc(4);
  p.writeUInt32BE(Number(n) >>> 0, 0);
  return box(fourcc, dataAtom(p, 0x15));
}

// 单字节字段（rtng 分级：1=explicit 2=clean）
function byteItem(fourcc, n) {
  return box(fourcc, dataAtom(Buffer.from([n & 0xff]), 0x15));
}

// meta 内的 hdlr（iTunes 风格 mdir/appl）
function hdlr() {
  const body = Buffer.alloc(25);
  body.write('mdir', 4, 'latin1');      // handler_type
  body.write('appl', 8, 'latin1');      // reserved[0]（iTunes 惯例）
  return box('hdlr', body);
}

/**
 * 向 m4a Buffer 写入标签，返回新 Buffer
 * meta: { title, artist, album, albumArtist, composer, genre, year,
 *         trackNumber, trackTotal, discNumber, discTotal, lyrics, isrc,
 *         copyright, recordLabel, upc, rating(1=explicit,2=clean),
 *         songId, albumId, artistId, sortOrder(bool),
 *         cover: Buffer|null, coverType: 'jpg'|'png' }
 */
function tagM4A(buf, meta) {
  const items = [];
  if (meta.title) items.push(textItem('©nam', meta.title));
  if (meta.artist) items.push(textItem('©ART', meta.artist));
  if (meta.album) items.push(textItem('©alb', meta.album));
  if (meta.albumArtist) items.push(textItem('aART', meta.albumArtist));
  if (meta.composer) items.push(textItem('©wrt', meta.composer));
  if (meta.genre) items.push(textItem('©gen', meta.genre));
  if (meta.year) items.push(textItem('©day', String(meta.year)));
  if (meta.lyrics) items.push(textItem('©lyr', meta.lyrics));
  if (meta.trackNumber) items.push(pairItem('trkn', meta.trackNumber, meta.trackTotal || 0));
  if (meta.discNumber) items.push(pairItem('disk', meta.discNumber, meta.discTotal || 0));
  if (meta.isrc) {
    const p = Buffer.from(meta.isrc, 'utf8');
    items.push(box('----', box('mean', Buffer.from('\x00\x00\x00\x00com.apple.iTunes')),
      box('name', Buffer.from('\x00\x00\x00\x00ISRC')), dataAtom(p, 1)));
  }
  // ---- 扩展字段（对齐 amd.wol.moe）----
  if (meta.copyright) items.push(textItem('cprt', meta.copyright));
  if (meta.recordLabel) items.push(textItem('©pub', meta.recordLabel));
  if (meta.upc) items.push(freeformItem('UPC', meta.upc));
  if (meta.rating) items.push(byteItem('rtng', meta.rating));
  if (meta.songId) items.push(intItem('cnID', meta.songId));
  if (meta.albumId) items.push(intItem('plID', meta.albumId));
  if (meta.artistId) items.push(intItem('atID', meta.artistId));
  // 排序字段：直接复制显示值（与站点行为一致）
  if (meta.sortOrder) {
    if (meta.title) items.push(textItem('sonm', meta.title));
    if (meta.artist) items.push(textItem('soar', meta.artist));
    if (meta.album) items.push(textItem('soal', meta.album));
    if (meta.albumArtist) items.push(textItem('soaa', meta.albumArtist));
    if (meta.composer) items.push(textItem('soco', meta.composer));
  }
  if (meta.cover && meta.cover.length) {
    items.push(box('covr', dataAtom(meta.cover, meta.coverType === 'png' ? 0xE : 0xD)));
  }
  if (!items.length) return buf;

  const udta = box('udta', box('meta', Buffer.alloc(4), hdlr(), box('ilst', ...items)));

  // 找顶层 moov，把 udta 追加进去并修正 size
  let p = 0;
  while (p + 8 <= buf.length) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(p + 8));
    if (size === 0) size = buf.length - p;
    if (type === 'moov') {
      const moov = buf.subarray(p, p + size);
      moov.writeUInt32BE(size + udta.length, 0);
      return Buffer.concat([buf.subarray(0, p), moov, udta, buf.subarray(p + size)]);
    }
    p += size;
  }
  throw new Error('moov box not found');
}

module.exports = { tagM4A };
