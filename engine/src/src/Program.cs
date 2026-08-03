using MineEngine;

// 安妮播放器（Annie Player）独占音频引擎 AnnieEngine
// 用法：由 Electron 主进程以子进程方式拉起，通过 stdin/stdout 行分隔 JSON-RPC 通信。
// 也可手动运行测试，直接向 stdin 写 JSON 行，例如：
//   {"id":1,"method":"devices.list","params":{}}
//   {"id":2,"method":"play","params":{"path":"D:\\Music\\a.flac"}}
// 日志走 stderr。stdout/stderr 统一使用 UTF-8（无 BOM），与 Electron 主进程的解码方式一致，避免中文日志乱码
Console.OutputEncoding = new System.Text.UTF8Encoding(false);

Toolchain.Resolve(); // 定位 ffmpeg/ffprobe（tools 目录或 PATH）

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

var rpc = new Rpc();
var engine = new Engine(rpc);
rpc.OnInputClosed += () => cts.Cancel(); // 父进程退出 → 引擎随之退出

await rpc.RunAsync(cts.Token);
