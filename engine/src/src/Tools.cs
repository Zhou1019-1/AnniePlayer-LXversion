using System.Diagnostics;

namespace MineEngine;

/// <summary>
/// ffmpeg/ffprobe 定位与可用性检测。
/// 搜索顺序：MINEENGINE_FFMPEG 环境变量 → exe 同级 tools/ → exe 上一级 tools/（开发态 engine/tools）→ PATH。
/// </summary>
public static class Toolchain
{
    public static string FfmpegPath { get; private set; } = "ffmpeg";
    public static string FfprobePath { get; private set; } = "ffprobe";
    public static bool FfmpegFound { get; private set; }
    public static bool FfprobeFound { get; private set; }

    public const string MissingHint =
        "未找到 ffmpeg/ffprobe。请把 ffmpeg.exe 和 ffprobe.exe 放入 engine/tools 目录（或加入系统 PATH），然后重启播放器。";

    public static void Resolve()
    {
        var baseDir = AppContext.BaseDirectory;
        var candidatesDirs = new[]
        {
            Path.Combine(baseDir, "tools"),
            Path.Combine(baseDir, "..", "tools"),
        };

        // ffmpeg
        var envFfmpeg = Environment.GetEnvironmentVariable("MINEENGINE_FFMPEG");
        if (!string.IsNullOrWhiteSpace(envFfmpeg) && File.Exists(envFfmpeg))
        {
            FfmpegPath = envFfmpeg;
            FfmpegFound = true;
            var probeGuess = Path.Combine(Path.GetDirectoryName(envFfmpeg)!, "ffprobe.exe");
            if (File.Exists(probeGuess)) { FfprobePath = probeGuess; FfprobeFound = true; }
        }
        if (!FfmpegFound)
        {
            foreach (var dir in candidatesDirs)
            {
                var f = Path.Combine(dir, "ffmpeg.exe");
                if (File.Exists(f)) { FfmpegPath = Path.GetFullPath(f); FfmpegFound = true; break; }
            }
        }
        if (!FfprobeFound)
        {
            foreach (var dir in candidatesDirs)
            {
                var f = Path.Combine(dir, "ffprobe.exe");
                if (File.Exists(f)) { FfprobePath = Path.GetFullPath(f); FfprobeFound = true; break; }
            }
        }

        // 候选目录都没命中 → 试试 PATH
        if (!FfmpegFound) FfmpegFound = TestOnPath(FfmpegPath);
        if (!FfprobeFound) FfprobeFound = TestOnPath(FfprobePath);

        FfmpegPcmStream.FfmpegPath = FfmpegPath;
        FfmpegPcmStream.FfprobePath = FfprobePath;
        Console.Error.WriteLine($"[tools] ffmpeg={(FfmpegFound ? FfmpegPath : "缺失")} ffprobe={(FfprobeFound ? FfprobePath : "缺失")}");
    }

    private static bool TestOnPath(string exe)
    {
        try
        {
            var psi = new ProcessStartInfo(exe, "-version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi);
            return p is not null && p.WaitForExit(5000);
        }
        catch { return false; }
    }
}
