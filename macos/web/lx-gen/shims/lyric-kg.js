// 酷狗 KRC 歌词解密
// KRC 格式：前 4 字节 "krc1" + XOR 加密(0x6b) + zlib 压缩
// 浏览器有 DecompressionStream，可以解压

export async function decodeKrc(buffer) {
  try {
    let data = buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(buffer);

    // 检查 KRC1 头
    const header = new TextDecoder().decode(data.slice(0, 4));
    if (header !== 'krc1') {
      // 不是 KRC，当普通文本返回
      return new TextDecoder().decode(data);
    }

    // XOR 解密
    const dec = new Uint8Array(data.length - 4);
    for (let i = 4; i < data.length; i++) {
      dec[i - 4] = data[i] ^ 0x6b;
    }

    // zlib 解压（用 DecompressionStream）
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(dec);
      writer.close();
      const chunks = [];
      const reader = ds.readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return new TextDecoder().decode(out);
    }
    // 退化：返回原始解密数据
    return new TextDecoder().decode(dec);
  } catch (e) {
    return '';
  }
}

export function decodeLyric(str) { return str; }
export default { decodeKrc, decodeLyric };
