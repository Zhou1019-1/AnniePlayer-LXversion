export function readFileSync() { throw new Error('fs 不支持'); }
export const promises = {};
export default { readFileSync, promises };
