'use strict';
/* 引擎启动故障分类测试：不依赖 Electron，仅验证 engineClient 导出的纯函数。
 * 覆盖 0x80008096（缺 .NET 9）、0x80008083（缺 hostfxr）、官方模板文本与未知崩溃负例。 */
const assert = require('assert');
const path = require('path');

const { classifyStartupFailure } = require(path.join(__dirname, '..', 'annie', 'main', 'engineClient.js'));

// 1. 退出码直判
assert.strictEqual(classifyStartupFailure(2147516566, ''), 'dotnet-runtime-missing');
assert.strictEqual(classifyStartupFailure(2147516547, ''), 'dotnet-hostfxr-missing');

// 2. stderr 十六进制码（碎块拼接后的完整文本）
assert.strictEqual(
  classifyStartupFailure(null, 'Failed to resolve hostfxr.dll [not found]. Error code: 0x80008083'),
  'dotnet-hostfxr-missing'
);
assert.strictEqual(
  classifyStartupFailure(null, 'You must install or update .NET to run this application.\nFramework: \'Microsoft.NETCore.App\', version \'9.0.0\'\nError code: 0x80008096'),
  'dotnet-runtime-missing'
);

// 3. 官方模板文本（无退出码）
assert.strictEqual(
  classifyStartupFailure(1, "You must install or update .NET to run this application.\nFramework: 'Microsoft.NETCore.App', version '9.0.20' (x64)"),
  'dotnet-runtime-missing'
);
assert.strictEqual(
  classifyStartupFailure(1, 'You must install .NET to run this application.\n.NET location: Not found\nFailed to resolve hostfxr.dll [not found]'),
  'dotnet-hostfxr-missing'
);

// 4. 负例：普通引擎崩溃 / 其他错误不得误分类
assert.strictEqual(classifyStartupFailure(1, ''), null);
assert.strictEqual(classifyStartupFailure(134, 'Unhandled exception: System.InvalidOperationException'), null);
assert.strictEqual(classifyStartupFailure(0, 'rpc ready'), null);

console.log('[engine-client-test] 启动故障分类 4 组检查通过');
