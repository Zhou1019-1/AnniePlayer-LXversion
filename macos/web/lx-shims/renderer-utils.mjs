// Shim: @renderer/utils
const encodeNames = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#039;': "'",
};
export const decodeName = (str = '') => {
  if (!str) return '';
  return String(str).replace(/(?:&amp;|&lt;|&gt;|&quot;|&apos;|&#039;|&nbsp;)/gm, (s) => encodeNames[s]);
};
