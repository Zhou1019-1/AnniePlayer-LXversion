// ESM loader hooks：解析洛雪 musicSdk 的别名与扩展名省略导入
// 通过 module.register() 在 CJS 主进程注册后生效
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const STREAMING_DIR = path.dirname(fileURLToPath(import.meta.url)); // annie/main/streaming
const SHIMS = path.join(STREAMING_DIR, 'lxsdk-shims');               // annie/main/streaming/lxsdk-shims
const SDK_DIR = path.join(STREAMING_DIR, 'lx-sdk');                  // annie/main/streaming/lx-sdk

// 显式别名表
const ALIASES = new Map([
  ['@renderer/utils', path.join(SHIMS, 'renderer-utils.mjs')],
  ['@common/ipcNames', path.join(SHIMS, 'ipc-names.mjs')],
  ['@common/rendererIpc', path.join(SHIMS, 'renderer-ipc.mjs')],
  ['@common/utils/lyricUtils/kg', path.join(SHIMS, 'lyric-kg.mjs')],
]);

// SDK 内部对上层工具的相对引用 → shim
const REL_MAP = new Map([
  ['request', path.join(SHIMS, 'request.mjs')],
  ['message', path.join(SHIMS, 'message.mjs')],
  ['index', path.join(SHIMS, 'renderer-index.mjs')],
]);

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function tryResolveAsFileOrIndex(absPath) {
  if (existsFile(absPath)) return absPath;
  if (existsFile(absPath + '.js')) return absPath + '.js';
  if (existsFile(absPath + '.mjs')) return absPath + '.mjs';
  const idx = path.join(absPath, 'index.js');
  if (existsFile(idx)) return idx;
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // 1) 显式别名
  if (ALIASES.has(specifier)) {
    return { url: pathToFileURL(ALIASES.get(specifier)).href, shortCircuit: true };
  }

  // 1b) 前缀别名：@renderer/utils/musicSdk/* → lx-sdk/*
  if (specifier.startsWith('@renderer/utils/musicSdk/')) {
    const abs = path.join(SDK_DIR, specifier.slice('@renderer/utils/musicSdk/'.length));
    const found = tryResolveAsFileOrIndex(abs);
    if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
    throw new Error(`无法解析 SDK 内部模块: ${specifier}`);
  }

  // 2) 相对导入：先按 Node ESM 默认规则试；失败后手动补扩展名/目录索引
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const abs = path.resolve(parentDir, specifier);
      const base = path.basename(abs);
      // 2a) SDK 对上层工具模块的引用（../../request、../../index、../../../request 等）
      if (abs.startsWith(STREAMING_DIR) && !abs.startsWith(SDK_DIR) && REL_MAP.has(base)) {
        return { url: pathToFileURL(REL_MAP.get(base)).href, shortCircuit: true };
      }
      // 2b) SDK 内部的扩展名省略/目录导入
      if (abs.startsWith(SDK_DIR) || abs.startsWith(SHIMS)) {
        const found = tryResolveAsFileOrIndex(abs);
        if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
      }
      throw new Error(`无法解析模块: ${specifier} (from ${context.parentURL})`);
    }
  }

  // 3) 其他（node: 内置、npm 包）走默认
  return nextResolve(specifier, context);
}
