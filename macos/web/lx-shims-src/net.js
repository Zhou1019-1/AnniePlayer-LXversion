// net shim —— 浏览器没有 net 模块
export function connect() { throw new Error('net 不支持'); }
export function isIP(s) { return /^[\d.]+$/.test(s) ? 4 : 0; }
export default { connect, isIP };
