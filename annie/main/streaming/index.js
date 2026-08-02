'use strict';
// ============================================================================
// 流媒体统一入口 —— 洛雪全功能版
//   平台能力（搜索/歌词/封面/热搜）：洛雪 musicSdk 原版 (lxsdk.js → lx-sdk/)
//   播放 URL：用户导入的音源脚本优先（sources.js 沙箱），洛雪测试接口兜底
//   下载：解析直链后落盘到本地曲库目录
// 安妮自研的 netease/qq 流媒体模块已剔除。
// ============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const sources = require('./sources');
const lxsdk = require('./lxsdk');

const PROVIDERS = lxsdk.PROVIDERS;

let settingsFile = null;
let streamSettings = { downloadDir: '' };

function init(app) {
  sources.init(app); // 加载已导入的自定义音源
  settingsFile = path.join(app.getPath('userData'), 'stream-settings.json');
  try { streamSettings = { downloadDir: '', ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { }
  // 预热洛雪 SDK（异步，不阻塞启动）
  lxsdk.loadSdk().catch((e) => console.warn('[lxsdk] 预加载失败:', e.message));
}

function saveStreamSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(streamSettings, null, 2), 'utf8'); } catch { }
}

async function search({ provider, keywords, page, limit }) {
  return lxsdk.search({ provider, keywords, page: page || 1, limit: limit || 30 });
}

async function songUrl(params) {
  return lxsdk.songUrl(params);
}

async function lyric(params) {
  return lxsdk.lyric(params);
}

async function getPic(params) {
  return lxsdk.getPic(params);
}

async function hotSearch(params) {
  return lxsdk.hotSearch(params);
}

/* ---------------- 下载 ---------------- */

function sanitizeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

/** 下载目录：用户自定义优先，默认 系统音乐文件夹/AnniePlayerSVLX Downloads */
function downloadDir() {
  const custom = streamSettings.downloadDir;
  const dir = custom || path.join(os.homedir(), 'Music', 'AnniePlayerSVLX Downloads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 设置自定义下载目录（空字符串恢复默认） */
function setDownloadDir(dir) {
  streamSettings.downloadDir = dir || '';
  saveStreamSettings();
  return downloadDir();
}

/**
 * 下载在线曲目到本地曲库目录。
 * @param params { provider, quality, song }
 * @param onProgress (receivedBytes, totalBytes) => void
 */
async function download(params, onProgress) {
  const r = await songUrl(params);
  if (!r || !r.playable || !r.url) throw new Error((r && r.message) || '无法获取下载地址');
  const song = params.song || {};
  const ext = (r.format && /^[a-z0-9]+$/i.test(r.format) ? r.format : (r.url.split('?')[0].split('.').pop() || 'mp3')).toLowerCase();
  const fileName = sanitizeFileName(`${song.artist || '未知艺人'} - ${song.name || song.id}`) + '.' + ext;
  let dest = path.join(downloadDir(), fileName);
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(downloadDir(), fileName.replace(new RegExp(`\\.${ext}$`), ` (${n++}).${ext}`));
  }

  const headers = {};
  if (r.headers) {
    for (const line of String(r.headers).split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  const resp = await fetch(r.url, { headers });
  if (!resp.ok || !resp.body) throw new Error('下载失败：HTTP ' + resp.status);
  const total = Number(resp.headers.get('content-length') || 0);
  const out = fs.createWriteStream(dest);
  const reader = resp.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) await new Promise((res) => out.once('drain', res));
      if (onProgress) onProgress(received, total);
    }
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(dest); } catch { }
    throw e;
  }
  await new Promise((res) => out.end(res));
  return { ok: true, path: dest, size: received, quality: r.quality || '', level: r.level, downgraded: !!r.downgraded, requestedType: r.requestedType };
}

module.exports = {
  init, search, songUrl, lyric, getPic, hotSearch, download, downloadDir, setDownloadDir,
  PROVIDERS,
  sources, // 音源管理 API 透出给 IPC 层
};
