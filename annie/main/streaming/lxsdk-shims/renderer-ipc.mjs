// Shim: @common/rendererIpc —— 直接在本进程实现 LX 主进程的两个歌词解密 handler
// kw: zlib inflate + yeelion XOR + gb18030 解码（返回 base64，与 LX 主进程契约一致）
// tx: qrc_decode.node 原生模块 + inflate（原生模块缺失时优雅降级）
import { inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import iconv from 'iconv-lite';

const inflateAsync = promisify(inflate);
const require2 = createRequire(import.meta.url);

// ---- 酷我歌词解密（移植自 LX main/modules/winMain/rendererEvent/kw_decodeLyric.ts）----
const buf_key = Buffer.from('yeelion');
const buf_key_len = buf_key.length;

async function kwDecodeLyric(lrcBase64, isGetLyricx) {
  const buf = Buffer.from(lrcBase64, 'base64');
  if (buf.toString('utf8', 0, 10) !== 'tp=content') return '';
  const lrcData = await inflateAsync(buf.subarray(buf.indexOf('\r\n\r\n') + 4));
  if (!isGetLyricx) return iconv.decode(lrcData, 'gb18030');
  const buf_str = Buffer.from(lrcData.toString(), 'base64');
  const output = Buffer.alloc(buf_str.length);
  let i = 0;
  while (i < buf_str.length) {
    let j = 0;
    while (j < buf_key_len && i < buf_str.length) {
      output[i] = buf_str[i] ^ buf_key[j];
      i++; j++;
    }
  }
  return iconv.decode(output, 'gb18030');
}

// ---- QQ 歌词解密（qrc_decode.node 原生模块，缺失时降级返回空）----
let qrc_decode = null;
let qrcTried = false;
function getQrcDecode() {
  if (qrcTried) return qrc_decode;
  qrcTried = true;
  const candidates = [
    path.join(process.resourcesPath || '', 'native', 'qrc_decode.node'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'annie', 'main', 'streaming', 'native', 'qrc_decode.node'),
    path.join(__dirnameShim(), '..', 'native', 'qrc_decode.node'),
  ];
  for (const p of candidates) {
    try {
      qrc_decode = require2(p).qrc_decode;
      if (qrc_decode) return qrc_decode;
    } catch { }
  }
  return null;
}
function __dirnameShim() {
  return path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
}

async function txDecodeOne(str) {
  if (!str) return '';
  // 优先原生模块（ABI 匹配时），失败降级纯 JS 3DES 实现
  const decode = getQrcDecode();
  if (decode) {
    try {
      const buf = Buffer.from(str, 'hex');
      return (await inflateAsync(decode(buf, buf.length))).toString();
    } catch (e) { console.warn('[lxsdk] qrc 原生解码失败，降级纯 JS:', e.message); }
  }
  try {
    const { qrcTripleDesDecrypt } = await import('./qrc-jsdec.mjs');
    const decrypted = qrcTripleDesDecrypt(str);
    if (!decrypted.length) return '';
    return (await inflateAsync(Buffer.from(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength))).toString();
  } catch (e) { console.warn('[lxsdk] qrc 纯 JS 解码失败:', e.message); return ''; }
}

// ---- rendererInvoke 实现 ----
export async function rendererInvoke(name, params) {
  switch (name) {
    case 'handle_kw_decode_lyric': {
      const { lrcBase64, isGetLyricx } = params;
      const lrc = await kwDecodeLyric(lrcBase64, isGetLyricx);
      return Buffer.from(lrc).toString('base64');
    }
    case 'handle_tx_decode_lyric': {
      const { lrc, tlrc, rlrc } = params;
      const [lyric, tlyric, rlyric] = await Promise.all([txDecodeOne(lrc), txDecodeOne(tlrc), txDecodeOne(rlrc)]);
      return { lyric, tlyric, rlyric };
    }
    default:
      throw new Error('unknown ipc: ' + name);
  }
}
