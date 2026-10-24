// dns shim —— 浏览器没有 DNS 模块，返回空实现
export function lookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; }
  if (cb) cb(null, [{ address: '0.0.0.0', family: 4 }]);
}
export function resolve(host, cb) { if (cb) cb(null, []); }
export const promises = {
  lookup: async () => [{ address: '0.0.0.0', family: 4 }],
  resolve: async () => [],
};
export default { lookup, resolve, promises };
