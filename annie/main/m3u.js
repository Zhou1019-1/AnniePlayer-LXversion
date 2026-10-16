'use strict';
/* M3U/M3U8 播放列表解析（V4.4.6）
 * M3U 是纯文本格式：每行一个路径/URL，支持 #EXTINF 元数据行。
 * #EXTM3U 头部标记扩展格式（M3U8 = UTF-8 编码的扩展 M3U）。
 * 本解析器只取本地文件路径；http 等网络流跳过（安妮播放列表是本地文件列表）。
 *
 * 编码：M3U8 规范是 UTF-8；M3U 历史上可能是 ANSI/GBK。
 * 检测顺序：UTF-8 BOM → UTF-8 严格校验 → GBK 兜底。 */
const fs = require('fs');
const path = require('path');

/** 检测并解码 M3U 文本（UTF-8 BOM / UTF-8 / GBK） */
function decodeM3u(buf) {
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf8', 3);
  // 尝试严格 UTF-8
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { }
  // GBK 兜底（中文 Windows 记事本/旧播放器的 ANSI 输出）
  try { return new TextDecoder('gbk').decode(buf); } catch { }
  return buf.toString('latin1');
}

/** 判断路径是否为本地文件路径（非 http/rtp 等网络流） */
function isLocalPath(p) {
  if (/^\w+:\/\//.test(p)) return false; // http:// https:// rtp:// 等
  return true;
}

/** 解析 M3U/M3U8 内容，返回本地路径数组
 * @param buf 文件内容 Buffer
 * @param m3uDir M3U 文件所在目录（相对路径基于此解析）
 * @returns {string[]} 本地文件路径数组
 */
function parseM3u(buf, m3uDir) {
  const text = decodeM3u(buf);
  const lines = text.split(/\r?\n/);
  const paths = [];
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue; // #EXTM3U / #EXTINF / 注释 全跳过
    // file:// URI 先转本地路径再判断（否则会被 isLocalPath 的协议检查误杀）
    let p = line.replace(/^file:\/\//i, '');
    // file:///E:/path → E:/path（去掉前导 /，否则 path.resolve 误判为相对路径）
    if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1);
    if (!isLocalPath(p)) continue;
    // 相对路径 → 基于 M3U 所在目录解析
    if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('\\\\') && m3uDir) p = path.resolve(m3uDir, p);
    paths.push(p);
  }
  return paths;
}

/** 从文件路径解析（便捷入口） */
function parseM3uFile(filePath) {
  return parseM3u(fs.readFileSync(filePath), path.dirname(filePath));
}

module.exports = { parseM3u, parseM3uFile, decodeM3u };
