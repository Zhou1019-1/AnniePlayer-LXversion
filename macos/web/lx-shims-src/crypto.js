// Node crypto 兼容层 —— 用纯 JS 实现 SDK 需要的加密函数
//
// 洛雪 SDK 用了 Node 的 crypto：
//   createCipheriv / createDecipheriv  → AES 加解密（酷我/网易云协议）
//   createHash                         → MD5
//   publicEncrypt / randomBytes        → 网易云部分接口
//
// 浏览器的 Web Crypto 是异步 API，和 Node 的同步 API 不兼容，
// 所以这里用纯 JS 实现（AES 用 Web Crypto 的同步包装不行，直接抄了个 AES 实现）。

import { md5 as _md5 } from './md5.js';

// ---------- AES（纯 JS，用于 createCipheriv/createDecipheriv） ----------
// 简化实现：只支持 aes-128-ecb / aes-128-cbc（SDK 实际用到的）
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(function initSBox() {
  // 生成 AES S-box
  let p = 1, q = 1;
  const rotl = (x, s) => ((x << s) | (x >>> (8 - s))) & 0xff;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4);
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

function xtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }
function mul(a, b) {
  let r = 0;
  while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; }
  return r;
}

function expandKey(key) {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = [];
  for (let i = 0; i < nk; i++) w[i] = [key[i*4], key[i*4+1], key[i*4+2], key[i*4+3]];
  const rcon = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w[i-1].slice();
    if (i % nk === 0) {
      t = [SBOX[t[1]] ^ rcon[i/nk-1], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
    } else if (nk > 6 && i % nk === 4) {
      t = t.map(b => SBOX[b]);
    }
    w[i] = w[i-nk].map((b, j) => b ^ t[j]);
  }
  return { w, nr };
}

function encryptBlock(state, ks) {
  const { w, nr } = ks;
  const addRK = (r) => { for (let c = 0; c < 4; c++) for (let r2 = 0; r2 < 4; r2++) state[c*4+r2] ^= w[r*4+c][r2]; };
  addRK(0);
  for (let round = 1; round <= nr; round++) {
    for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
    // ShiftRows
    const t = state.slice();
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) state[r*4+c] = t[r*4+((c+r)%4)];
    if (round !== nr) {
      for (let c = 0; c < 4; c++) {
        const a = state.slice(c*4, c*4+4);
        state[c*4]   = mul(a[0],2)^mul(a[1],3)^a[2]^a[3];
        state[c*4+1] = a[0]^mul(a[1],2)^mul(a[2],3)^a[3];
        state[c*4+2] = a[0]^a[1]^mul(a[2],2)^mul(a[3],3);
        state[c*4+3] = mul(a[0],3)^a[1]^a[2]^mul(a[3],2);
      }
    }
    addRK(round);
  }
  return state;
}

function decryptBlock(state, ks) {
  const { w, nr } = ks;
  const addRK = (r) => { for (let c = 0; c < 4; c++) for (let r2 = 0; r2 < 4; r2++) state[c*4+r2] ^= w[r*4+c][r2]; };
  addRK(nr);
  for (let round = nr - 1; round >= 0; round--) {
    const t = state.slice();
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) state[r*4+c] = t[r*4+((c-r+4)%4)];
    for (let i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]];
    addRK(round);
    if (round !== 0) {
      for (let c = 0; c < 4; c++) {
        const a = state.slice(c*4, c*4+4);
        state[c*4]   = mul(a[0],14)^mul(a[1],11)^mul(a[2],13)^mul(a[3],9);
        state[c*4+1] = mul(a[0],9)^mul(a[1],14)^mul(a[2],11)^mul(a[3],13);
        state[c*4+2] = mul(a[0],13)^mul(a[1],9)^mul(a[2],14)^mul(a[3],11);
        state[c*4+3] = mul(a[0],11)^mul(a[1],13)^mul(a[2],9)^mul(a[3],14);
      }
    }
  }
  return state;
}

function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') return new TextEncoder().encode(x);
  if (Array.isArray(x)) return Uint8Array.from(x);
  return new Uint8Array(0);
}

// ---------- 公开 API（模仿 node:crypto） ----------

export function createHash(algo) {
  const a = String(algo).toLowerCase();
  let buf = '';
  return {
    update(data) {
      buf += (typeof data === 'string') ? data : new TextDecoder().decode(toBytes(data));
      return this;
    },
    digest(enc) {
      // 用 crypto-js 实现各种 hash
      const C = globalThis.CryptoJS;
      if (!C) return _md5(buf);
      let h;
      if (a.includes('md5')) h = C.MD5(buf);
      else if (a.includes('sha1')) h = C.SHA1(buf);
      else if (a.includes('sha256')) h = C.SHA256(buf);
      else if (a.includes('sha512')) h = C.SHA512(buf);
      else if (a.includes('sha3')) h = C.SHA3(buf);
      else h = C.MD5(buf);
      if (enc === 'base64') return h.toString(C.enc.Base64);
      return h.toString(C.enc.Hex);
    },
  };
}

function pkcs7Pad(data, bs = 16) {
  const pad = bs - (data.length % bs);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}
function pkcs7Unpad(data) {
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16) return data;
  return data.slice(0, data.length - pad);
}

// 给 Uint8Array 挂 toString('hex')（Node Buffer 的语义）
function hexify(u8) {
  if (u8.__hexified) return u8;
  const orig = Uint8Array.prototype.toString;
  Object.defineProperty(u8, 'toString', {
    value: function(enc) {
      if (enc === 'hex') {
        let s = '';
        for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0');
        return s;
      }
      if (enc === 'base64') {
        let s = '';
        for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]);
        return btoa(s);
      }
      if (enc === 'utf8' || enc === 'utf-8' || enc === undefined) {
        return new TextDecoder().decode(this);
      }
      return orig.call(this);
    },
    writable: true, configurable: true,
  });
  u8.__hexified = true;
  return u8;
}

// 字节数组 → CryptoJS WordArray（正确实现）
function bytesToWA(C, bytes) {
  const words = [];
  for (let i = 0; i < bytes.length; i++) {
    words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8);
  }
  return C.lib.WordArray.create(words, bytes.length);
}

// CryptoJS WordArray → 字节数组
function waToBytes(wa) {
  const out = new Uint8Array(wa.sigBytes);
  const words = wa.words;
  for (let i = 0; i < wa.sigBytes; i++) {
    out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return hexify(out);
}

function makeAES(a, key, iv, encrypt) {
  const C = globalThis.CryptoJS;
  if (!C) throw new Error('CryptoJS 未加载');
  const kb = toBytes(key);
  const k = bytesToWA(C, kb);
  const ivArr = iv ? bytesToWA(C, toBytes(iv)) : undefined;
  const mode = a.includes('cbc') ? C.mode.CBC :
               a.includes('ecb') ? C.mode.ECB : C.mode.CBC;
  const options = { mode, padding: C.pad.Pkcs7 };
  if (ivArr) options.iv = ivArr;
  const c = encrypt
    ? C.algo.AES.createEncryptor(k, options)
    : C.algo.AES.createDecryptor(k, options);
  let pending = new Uint8Array(0);

  return {
    update(data) {
      const bytes = toBytes(data);
      if (!bytes.length) return new Uint8Array(0);
      const merged = new Uint8Array(pending.length + bytes.length);
      merged.set(pending); merged.set(bytes, pending.length);
      pending = new Uint8Array(0);
      const out = c.process(bytesToWA(C, merged));
      return waToBytes(out);
    },
    final() {
      const out = c.finalize();
      const r = waToBytes(out);
      pending = new Uint8Array(0);
      return r;
    },
  };
}

export function createCipheriv(algo, key, iv) {
  return makeAES(String(algo).toLowerCase(), key, iv, true);
}

export function createDecipheriv(algo, key, iv) {
  return makeAES(String(algo).toLowerCase(), key, iv, false);
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

export const constants = { RSA_PKCS1_PADDING: 1 };

export function publicEncrypt() {
  throw new Error('publicEncrypt 不支持（需要 RSA，B 站/Netease 部分接口可能失效）');
}

export default {
  createHash, createCipheriv, createDecipheriv, randomBytes, constants, publicEncrypt,
};
