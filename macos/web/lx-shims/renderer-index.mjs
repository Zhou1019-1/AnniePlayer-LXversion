// Shim: @renderer/utils/index (SDK 以 ../../index 引用)
// 提供 formatPlayTime / sizeFormate / decodeName / dateFormat / dateFormat2 / formatPlayCount / toMD5
import crypto from 'node:crypto';

export const toMD5 = (str) => crypto.createHash('md5').update(str).digest('hex');

const encodeNames = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#039;': "'",
};
export const decodeName = (str = '') => {
  if (!str) return '';
  return String(str).replace(/(?:&amp;|&lt;|&gt;|&quot;|&apos;|&#039;|&nbsp;)/gm, (s) => encodeNames[s]);
};

export const formatPlayTime = (time) => {
  let m = Math.trunc(time / 60);
  let s = Math.trunc(time % 60);
  return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
};

export const sizeFormate = (size) => {
  if (!size) return '0.0K';
  const units = ['B', 'K', 'M', 'G'];
  let i = 0;
  size = Number(size);
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(1) + units[i];
};

export const dateFormat = (time, format = 'Y-M-D h:m:s') => {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return format.replace('Y', d.getFullYear()).replace('M', pad(d.getMonth() + 1)).replace('D', pad(d.getDate()))
    .replace('h', pad(d.getHours())).replace('m', pad(d.getMinutes())).replace('s', pad(d.getSeconds()));
};

export const dateFormat2 = (time) => dateFormat(time, 'Y-M-D');

export const formatPlayCount = (num) => {
  if (num > 100000000) return `${Math.trunc(num / 10000000) / 10}亿`;
  if (num > 10000) return `${Math.trunc(num / 1000) / 10}万`;
  return String(num);
};
