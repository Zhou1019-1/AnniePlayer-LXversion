// service.js — Apple Music 解密播放 · 本地 HTTP 服务（P1：AAC 缓冲式 + Range）
// 供安妮主进程挂载。用法：
//   const { createAmService } = require('./service.js');
//   const svc = await createAmService({ wasmPath: '<abs>/temari.wasm', wrapperUrl, apiKey, fetchImpl });
//   svc.url  // 'http://127.0.0.1:PORT'  → 播放地址 `${svc.url}/am/<adamId>?codec=aac`
//   svc.close()
//
// 端点：
//   GET /am/<adamId>?codec=aac   解密音频流（P1 仅 aac；alac 等返回 400 明确提示）
//                                 支持 Range（206 Partial Content），seek 瞬时跳转
//   GET /status                  wrapper-lite 健康检查（透传 /status）
'use strict';
const http = require('node:http');
const dl = require('./downloader.js');

const P1_CODECS = ['aac', 'alac']; // aac 缓冲式（P1）；alac 流式（P2）
const MAX_CACHE = 2;       // 内存缓存最近播放的 AAC 曲目（seek/重复播放不重下）

async function createAmService(opts = {}) {
  const { wasmPath, wrapperUrl, apiKey, fetchImpl } = opts;
  if (!wasmPath) throw new Error('createAmService: 缺少 opts.wasmPath（temari.wasm 绝对路径）');
  dl.setConfig({
    wrapperUrl: wrapperUrl || 'http://127.0.0.1:12340',
    apiKey: apiKey || '',
    fetchImpl: fetchImpl || null, // 安妮侧传 Electron net.fetch
  });

  const cache = new Map(); // `${adamId}:${codec}` -> { buf, time }
  const inflight = new Map(); // 同曲并发请求合并
  const activeStreams = new Map(); // adamId -> { cancelled }（ALAC 流式）

  async function getTrackBuffer(adamId, codec) {
    const key = `${adamId}:${codec}`;
    const hit = cache.get(key);
    if (hit) { hit.time = Date.now(); return hit.buf; }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      // 播放用途：跳过全部标签/封面/歌词（fields:[]），保留 remux（播放器兼容性已验证）
      const track = { adamId, title: '', artist: '', album: '', hasLyrics: false };
      const res = await dl.downloadTrack(track, { codec, wasmPath, fields: [], saveLyrics: false });
      cache.set(key, { buf: res.file, time: Date.now() });
      while (cache.size > MAX_CACHE) { // LRU 淘汰最旧
        let ok, ot = Infinity;
        for (const [k, v] of cache) if (v.time < ot) { ot = v.time; ok = k; }
        cache.delete(ok);
      }
      return res.file;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // V4.6：播放加载进度查询（渲染层进度卡轮询）
    if (u.pathname === '/progress') {
      const id = u.searchParams.get('adamId') || '';
      const c = u.searchParams.get('codec') || 'aac';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dl.getProgress(id, c) || { stage: 'idle' }));
      return;
    }

    if (u.pathname === '/status') {
      try {
        const s = await dl.wrapperStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(s));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    const m = u.pathname.match(/^\/am\/(\d+)$/);
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown endpoint' }));
      return;
    }
    const adamId = m[1];
    const codec = u.searchParams.get('codec') || 'aac';
    if (!P1_CODECS.includes(codec)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `不支持的 codec=${codec}（在线播放支持：${P1_CODECS.join('/')}）` }));
      return;
    }

    // ---- ALAC 流式（P2）：边下边解密边写响应，无 Content-Length ----
    if (codec === 'alac') {
      // 同 adamId 已有流在跑 → 中止旧流（seek 场景：安妮侧重拿新 URL）
      const old = activeStreams.get(adamId);
      if (old) old.cancelled = true;
      const state = { cancelled: false };
      activeStreams.set(adamId, state);
      res.on('close', () => { state.cancelled = true; });
      try {
        const gen = dl.streamTrack(
          { adamId },
          { codec: 'alac', wasmPath, startSec: +(u.searchParams.get('t') || 0) });
        // V4.6：首 chunk 到位才发 200——生成器提前失败（wrapper 未就绪/鉴权失败/网络错误）时
        // 能回 500 明确错误；旧实现先写 200 再失败 → 客户端拿到空体，ffprobe 探测拿不到流信息
        const first = await gen.next();
        if (state.cancelled) { await gen.return?.(); return; }
        if (first.done) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '空流（无音频分片）' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'audio/mp4',
          'Cache-Control': 'no-store',
        });
        if (!res.write(first.value)) await new Promise(r => res.once('drain', r));
        for await (const chunk of gen) {
          if (state.cancelled) break;
          if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
        }
        await gen.return?.();
      } catch (e) {
        if (!state.cancelled && !res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!state.cancelled) console.error('[am-service] stream error:', e.message);
      } finally {
        if (activeStreams.get(adamId) === state) activeStreams.delete(adamId);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    let buf;
    try {
      buf = await getTrackBuffer(adamId, codec);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }

    const base = {
      'Content-Type': 'audio/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    const range = req.headers.range;
    if (range) {
      const rm = /bytes=(\d+)-(\d*)/.exec(range);
      if (rm) {
        const start = +rm[1];
        let end = rm[2] ? +rm[2] : buf.length - 1;
        if (start >= buf.length || start > end) {
          res.writeHead(416, { ...base, 'Content-Range': `bytes */${buf.length}` });
          res.end();
          return;
        }
        end = Math.min(end, buf.length - 1);
        res.writeHead(206, {
          ...base,
          'Content-Range': `bytes ${start}-${end}/${buf.length}`,
          'Content-Length': end - start + 1,
        });
        res.end(buf.subarray(start, end + 1));
        return;
      }
    }
    res.writeHead(200, { ...base, 'Content-Length': buf.length });
    res.end(buf);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // listen(0)：系统分配空闲端口，避免与 wrapper-lite(12340) 等冲突
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => server.close(r)),
  };
}

module.exports = { createAmService };
