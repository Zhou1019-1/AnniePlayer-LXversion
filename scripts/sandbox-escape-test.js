'use strict';
/* 沙箱逃逸验证：复刻 sources-worker.js 的沙箱配置，验证经典逃逸链已被 codeGeneration 阻断 */
const vm = require('vm');
const crypto = require('crypto');

const lxApi = {
  on() { }, send() { }, request() { },
  utils: { crypto: { md5: (s) => crypto.createHash('md5').update(s).digest('hex'), buffer: Buffer } },
};
const sandbox = {
  globalThis: null,
  lx: lxApi,
  window: { lx: lxApi },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  TextEncoder, TextDecoder, encodeURIComponent,
  Buffer: undefined, fetch: undefined, require: undefined, process: undefined, module: undefined,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox, { name: 'lx-source:test', codeGeneration: { strings: false, wasm: false } });

const ESCAPES = [
  ['console.log.constructor 逃逸', 'console.log.constructor("return process")().versions.node'],
  ['globalThis.constructor 链', 'globalThis.constructor.constructor("return process")().versions.node'],
  ['宿主函数 constructor（TextEncoder）', 'TextEncoder.constructor("return process")().versions.node'],
  ['lx API 方法 constructor', 'lx.on.constructor("return process")().versions.node'],
  ['暴露的 Buffer 类 constructor', 'lx.utils.crypto.buffer.constructor("return process")().versions.node'],
  ['eval 直接执行', 'eval("1+1")'],
  ['WebAssembly 编译', 'new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))'],
  ['Function 构造器', '(function(){}).constructor("return 1+1")()'],
];

let blocked = 0, escaped = 0;
for (const [name, code] of ESCAPES) {
  try {
    const r = vm.runInContext(code, sandbox, { timeout: 2000 });
    console.log(`✗ 逃逸成功 [${name}] →`, String(r).slice(0, 60));
    escaped++;
  } catch (e) {
    console.log(`✓ 已阻断 [${name}]: ${e.message.slice(0, 50)}`);
    blocked++;
  }
}
console.log(`\n结果：${blocked} 阻断 / ${escaped} 逃逸`);
process.exit(escaped > 0 ? 1 : 0);
