using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MineEngine;

/// <summary>
/// 行分隔 JSON-RPC（stdio）。请求: {"id":1,"method":"...","params":{...}}
/// 响应: {"id":1,"ok":true,"result":...} / {"id":1,"ok":false,"error":"..."}
/// 事件: {"event":"...","data":{...}}
/// </summary>
public sealed class Rpc : IDisposable
{
    private readonly Stream _in;
    private readonly Stream _out;
    private readonly object _writeLock = new();

    public Rpc()
    {
        _in = Console.OpenStandardInput();
        _out = Console.OpenStandardOutput();
        // 日志全部走 stderr，stdout 只承载协议帧
        Console.Error.WriteLine("[engine] rpc ready");
    }

    public event Func<string, JsonObject, Task<object?>>? OnRequest;
    public event Action? OnInputClosed;

    public async Task RunAsync(CancellationToken ct)
    {
        using var reader = new StreamReader(_in, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false, bufferSize: 1 << 16, leaveOpen: true);
        while (!ct.IsCancellationRequested)
        {
            string? line;
            try { line = await reader.ReadLineAsync(ct); }
            catch (OperationCanceledException) { break; }
            if (line is null) { OnInputClosed?.Invoke(); break; }
            if (string.IsNullOrWhiteSpace(line)) continue;

            _ = Task.Run(async () =>
            {
                try { await HandleLineAsync(line); }
                catch (Exception ex) { Console.Error.WriteLine("[engine] handle error: " + ex); }
            }, ct);
        }
    }

    private async Task HandleLineAsync(string line)
    {
        JsonObject? msg;
        try { msg = JsonNode.Parse(line) as JsonObject; }
        catch { return; }
        if (msg is null) return;

        var idNode = msg["id"];
        var method = msg["method"]?.GetValue<string>() ?? "";
        var parameters = msg["params"] as JsonObject ?? new JsonObject();

        try
        {
            object? result = null;
            var handler = OnRequest;
            if (handler is not null) result = await handler(method, parameters);
            WriteFrame(new JsonObject
            {
                ["id"] = idNode?.DeepClone(),
                ["ok"] = true,
                ["result"] = result is null ? null : JsonSerializer.SerializeToNode(result)
            });
        }
        catch (Exception ex)
        {
            WriteFrame(new JsonObject
            {
                ["id"] = idNode?.DeepClone(),
                ["ok"] = false,
                ["error"] = ex.Message
            });
        }
    }

    public void Emit(string eventName, object data)
    {
        WriteFrame(new JsonObject
        {
            ["event"] = eventName,
            ["data"] = JsonSerializer.SerializeToNode(data)
        });
    }

    private void WriteFrame(JsonObject frame)
    {
        var bytes = Encoding.UTF8.GetBytes(frame.ToJsonString() + "\n");
        lock (_writeLock)
        {
            _out.Write(bytes, 0, bytes.Length);
            _out.Flush();
        }
    }

    public void Dispose() { }
}
