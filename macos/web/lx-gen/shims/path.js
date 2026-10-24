export function join(...parts) { return parts.filter(Boolean).join('/'); }
export function dirname(p) { return p.split('/').slice(0,-1).join('/') || '.'; }
export const sep = '/';
export default { join, dirname, sep };
