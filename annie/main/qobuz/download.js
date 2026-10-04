'use strict';
/* V4.3.6：Qobuz 下载器。
 * 并发 3（p-limit 思路自实现）/ 指数退避重试 / .part 断点续传（Range）。
 * 落盘目录复用洛雪流媒体的下载目录（streaming.downloadDir），安妮扫描该目录即自动入库。
 * 去重策略：同名已存在直接跳过（QBDLX 默认同款）。标签/封面嵌入属 M3，此层只管文件。 */
const fs = require('fs');
const path = require('path');

/* V4.3.22 修复：HTTP 层可注入（Electron net.fetch 走系统代理），同 api.js */
let httpFetch = globalThis.fetch;
function setHttpFetch(fn) { if (typeof fn === 'function') httpFetch = fn; }

const CONCURRENCY = 3;
const MAX_ATTEMPT = 3; // 每首最多尝试次数（每次重新签名取新 URL，防 URL 过期）

function sanitize(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

function pad2(n) { n = Number(n) || 0; return n > 0 && n < 10 ? '0' + n : String(n || ''); }

/* 目标路径：专辑上下文 → 子目录「艺人 - 专辑 / 01 - 标题.ext」；单曲 → 根目录「艺人 - 标题.ext」 */
function destOf(baseDir, item, ext) {
  const artist = (item.performer && item.performer.name) || (item.albumArtist) || '未知艺人';
  const title = item.title || String(item.id);
  if (item.albumTitle) {
    const dir = path.join(baseDir, sanitize(item.albumArtist || artist) + ' - ' + sanitize(item.albumTitle));
    return path.join(dir, sanitize(pad2(item.track_number) + ' - ' + title) + '.' + ext);
  }
  return path.join(baseDir, sanitize(artist + ' - ' + title) + '.' + ext);
}

/** 单曲下载（带重试 + .part 续传）。getFileUrl 每次重试现签，规避 URL 时效。 */
async function downloadOne(client, quality, item, baseDir, isCanceled, emit) {
  // 先探一次 URL 拿格式（ext 影响目标路径与续传判断）
  let f = await client.getFileUrl(String(item.id), quality);
  if (!f || !f.url) throw new Error('未取到下载地址（可能无订阅权限或地区限制）');
  const ext = (f.mime_type && /flac/i.test(f.mime_type)) ? 'flac'
    : (f.url.split('?')[0].split('.').pop() || 'flac').toLowerCase();
  const dest = destOf(baseDir, item, /^[a-z0-9]+$/.test(ext) ? ext : 'flac');
  if (fs.existsSync(dest)) return { skipped: true, path: dest };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPT; attempt++) {
    if (isCanceled()) throw Object.assign(new Error('已取消'), { canceled: true });
    if (attempt > 1) f = await client.getFileUrl(String(item.id), quality); // 重试现签新 URL
    const offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const headers = offset > 0 ? { Range: 'bytes=' + offset + '-' } : {};
    try {
      const resp = await httpFetch(f.url, { headers });
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
      // 服务器忽略 Range 回 200 → 从头重写
      const resume = offset > 0 && resp.status === 206;
      const total = Number(resp.headers.get('content-length') || 0) + (resume ? offset : 0);
      const out = fs.createWriteStream(part, { flags: resume ? 'a' : 'w' });
      let received = resume ? offset : 0;
      const reader = resp.body.getReader();
      try {
        for (;;) {
          if (isCanceled()) throw Object.assign(new Error('已取消'), { canceled: true });
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (!out.write(value)) await new Promise((res) => out.once('drain', res));
          emit('progress', { id: item.id, received, total });
        }
      } finally { await new Promise((res) => out.end(res)); }
      fs.renameSync(part, dest); // 完成转移
      return { skipped: false, path: dest, size: received };
    } catch (e) {
      lastErr = e;
      if (e.canceled) throw e;
      if (attempt < MAX_ATTEMPT) await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, attempt - 1))); // 1s/2s 指数退避
    }
  }
  throw lastErr || new Error('下载失败');
}

/**
 * 队列下载：并发 3，全程事件回报。
 * @param items Qobuz 曲目对象数组（可附 albumTitle/albumArtist 字段启用专辑子目录命名）
 * @param emit (phase, data) => void；phase: begin|progress|done|fail|skip|end
 */
async function runQueue(client, quality, items, baseDir, isCanceled, emit) {
  const stat = { total: items.length, done: 0, fail: 0, skip: 0 };
  emit('begin', { total: stat.total });
  let cursor = 0;
  async function worker() {
    while (cursor < items.length && !isCanceled()) {
      const item = items[cursor++];
      emit('trackBegin', { id: item.id, title: item.title });
      try {
        const r = await downloadOne(client, quality, item, baseDir, isCanceled, emit);
        if (r.skipped) { stat.skip++; emit('skip', { id: item.id, path: r.path, stat }); }
        else { stat.done++; emit('done', { id: item.id, path: r.path, stat }); }
      } catch (e) {
        if (e.canceled) { emit('end', { stat, canceled: true }); return; }
        stat.fail++;
        emit('fail', { id: item.id, title: item.title, error: e.message || String(e), stat });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  if (!isCanceled()) emit('end', { stat, canceled: false });
  return stat;
}

module.exports = { runQueue, downloadOne, destOf, sanitize, setHttpFetch };
