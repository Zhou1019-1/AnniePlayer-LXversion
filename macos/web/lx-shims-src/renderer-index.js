// renderer-index shim —— SDK 需要的工具函数
import { md5 } from './md5.js';

export function formatPlayTime(seconds) {
  seconds = Math.floor(seconds || 0);
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

export function toMD5(str) { return md5(String(str)); }

export function decodeName(str) {
  if (!str) return '';
  return String(str).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'").replace(/&nbsp;/g,' ');
}

export function dateFormat2(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

export function dateFormat(date, fmt = 'Y-M-D h:m:s') {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return fmt
    .replace('Y', d.getFullYear())
    .replace('M', p(d.getMonth() + 1))
    .replace('D', p(d.getDate()))
    .replace('h', p(d.getHours()))
    .replace('m', p(d.getMinutes()))
    .replace('s', p(d.getSeconds()));
}

/** 数字 → 播放次数（"1.2万" 这种） */
export function formatPlayCount(num) {
  num = Number(num) || 0;
  if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿';
  if (num >= 10000) return (num / 10000).toFixed(1) + '万';
  return String(num);
}

/** 字节数 → "1.2 MB" */
export function sizeFormate(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export default { formatPlayTime, toMD5, decodeName, dateFormat2, dateFormat,
                 formatPlayCount, sizeFormate };
