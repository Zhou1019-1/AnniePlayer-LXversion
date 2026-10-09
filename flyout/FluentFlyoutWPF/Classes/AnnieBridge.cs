// Copyright (c) 2026 Annie Player Project
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Annie 桥：安妮播放器（宿主）经 stdin JSON 行推送曲目/播放状态，
// 本进程持有自己的 SMTC 会话（Chromium Media Session 在无 <audio> 出声时不会桥到 Windows SMTC），
// 任务栏小组件/媒体弹窗因此总能显示安妮的播放信息；SMTC 按钮经 stdout JSON 行回流给宿主。
//
// 协议（JSON Lines，UTF-8）：
//   → stdin:  {"type":"meta","title","artist","album","cover"}   cover 支持 http(s) URL 或本地文件绝对路径
//   → stdin:  {"type":"state","playing":bool,"positionSec":n,"durationSec":n}
//   → stdout: {"type":"cmd","cmd":"play|pause|next|prev"}
//   → stdout: {"type":"seek","positionSec":n}   弹窗进度条拖拽（SMTC PlaybackPositionChangeRequested）
//   stdin 关闭（宿主退出）→ 本进程自动 Shutdown。

using System.IO;
using System.Text.Json;
using System.Windows;
using Windows.Media;
using Windows.Media.Playback;
using Windows.Storage;
using Windows.Storage.Streams;

namespace FluentFlyoutWPF.Classes;

public static class AnnieBridge
{
    private static readonly NLog.Logger Logger = NLog.LogManager.GetCurrentClassLogger();
    private static MediaPlayer? _player;
    private static SystemMediaTransportControls? _smtc;
    private static readonly object _outLock = new();

    /// <summary>在 UI 线程调用（MainWindow 构造函数）。MediaPlayer 有 Dispatcher 亲和性。</summary>
    public static void Start()
    {
        try
        {
            // 关键：WinExe 的 Console 默认走系统代码页（zh-CN=GBK），宿主按 UTF-8 写入的
            // 多字节序列在 GBK 下可能把后续 ASCII 引号吞成 trail byte → JSON 损坏（实踩）
            try { Console.InputEncoding = System.Text.Encoding.UTF8; Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }

            _player = new MediaPlayer();
            _smtc = _player.SystemMediaTransportControls;
            _smtc.IsPlayEnabled = true;
            _smtc.IsPauseEnabled = true;
            _smtc.IsNextEnabled = true;
            _smtc.IsPreviousEnabled = true;
            _smtc.IsStopEnabled = false;
            _smtc.PlaybackStatus = MediaPlaybackStatus.Stopped;
            _smtc.ButtonPressed += OnButtonPressed;
            // seek 能力经 ApplyState 的 UpdateTimelineProperties（Min/MaxSeekTime）对外声明，
            // FluentFlyout 弹窗进度条拖拽 → TryChangePlaybackPositionAsync → 本事件回流宿主
            _smtc.PlaybackPositionChangeRequested += OnPlaybackPositionChangeRequested;

            var thread = new Thread(ReadLoop) { IsBackground = true, Name = "AnnieBridgeStdin" };
            thread.Start();
            Logger.Info("AnnieBridge started (SMTC source mode)");
        }
        catch (Exception ex)
        {
            Logger.Error(ex, "AnnieBridge 启动失败（不影响小组件自身运行）");
        }
    }

    private static void OnButtonPressed(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args)
    {
        string? cmd = args.Button switch
        {
            SystemMediaTransportControlsButton.Play => "play",
            SystemMediaTransportControlsButton.Pause => "pause",
            SystemMediaTransportControlsButton.Next => "next",
            SystemMediaTransportControlsButton.Previous => "prev",
            _ => null,
        };
        if (cmd == null) return;
        try
        {
            lock (_outLock)
            {
                Console.Out.WriteLine(JsonSerializer.Serialize(new { type = "cmd", cmd }));
                Console.Out.Flush();
            }
        }
        catch (Exception ex) { Logger.Error(ex, "AnnieBridge 回流命令失败"); }
    }

    private static void OnPlaybackPositionChangeRequested(SystemMediaTransportControls sender, PlaybackPositionChangeRequestedEventArgs args)
    {
        try
        {
            var pos = Math.Max(0, args.RequestedPlaybackPosition.TotalSeconds);
            lock (_outLock)
            {
                Console.Out.WriteLine(JsonSerializer.Serialize(new { type = "seek", positionSec = pos }));
                Console.Out.Flush();
            }
        }
        catch (Exception ex) { Logger.Error(ex, "AnnieBridge seek 回流失败"); }
    }

    private static async void ReadLoop()
    {
        try
        {
            while (true)
            {
                var line = await Console.In.ReadLineAsync();
                if (line == null) break; // stdin 关闭 = 宿主退出
                HandleLine(line);
            }
        }
        catch (Exception ex) { Logger.Error(ex, "AnnieBridge stdin 读取异常"); }
        // 宿主已退出，跟随关闭
        try { Application.Current?.Dispatcher.Invoke(() => Application.Current.Shutdown()); } catch { }
    }

    private static void HandleLine(string line)
    {
        JsonDocument? doc = null;
        try
        {
            doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var t)) return;
            var type = t.GetString();
            // 拷出值再进 UI 线程，doc 随方法栈释放
            if (type == "meta")
            {
                string title = GetStr(root, "title"), artist = GetStr(root, "artist"), album = GetStr(root, "album"), cover = GetStr(root, "cover");
                Application.Current?.Dispatcher.BeginInvoke(() => _ = ApplyMetaAsync(title, artist, album, cover));
            }
            else if (type == "state")
            {
                bool playing = root.TryGetProperty("playing", out var p) && p.GetBoolean();
                double pos = root.TryGetProperty("positionSec", out var ps) ? ps.GetDouble() : 0;
                double dur = root.TryGetProperty("durationSec", out var ds) ? ds.GetDouble() : 0;
                Application.Current?.Dispatcher.BeginInvoke(() => ApplyState(playing, pos, dur));
            }
        }
        catch (Exception ex) { Logger.Warn($"AnnieBridge 消息解析失败: {ex.Message}"); }
        finally { doc?.Dispose(); }
    }

    private static string GetStr(JsonElement root, string name)
        => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

    private static async Task ApplyMetaAsync(string title, string artist, string album, string cover)
    {
        if (_smtc == null) return;
        try
        {
            var updater = _smtc.DisplayUpdater;
            updater.Type = MediaPlaybackType.Music;
            updater.MusicProperties.Title = string.IsNullOrEmpty(title) ? "未知曲目" : title;
            updater.MusicProperties.Artist = artist;
            updater.MusicProperties.AlbumTitle = album;

            updater.Thumbnail = null;
            if (!string.IsNullOrEmpty(cover))
            {
                try
                {
                    if (cover.StartsWith("http://") || cover.StartsWith("https://"))
                        updater.Thumbnail = RandomAccessStreamReference.CreateFromUri(new Uri(cover));
                    else if (File.Exists(cover))
                        updater.Thumbnail = RandomAccessStreamReference.CreateFromFile(await StorageFile.GetFileFromPathAsync(cover));
                }
                catch (Exception ex) { Logger.Warn($"AnnieBridge 封面设置失败: {ex.Message}"); }
            }
            updater.Update();
        }
        catch (Exception ex) { Logger.Error(ex, "AnnieBridge ApplyMeta 失败"); }
    }

    private static void ApplyState(bool playing, double positionSec, double durationSec)
    {
        if (_smtc == null) return;
        try
        {
            _smtc.PlaybackStatus = playing ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused;
            if (durationSec > 0)
            {
                var tl = new SystemMediaTransportControlsTimelineProperties
                {
                    StartTime = TimeSpan.Zero,
                    EndTime = TimeSpan.FromSeconds(durationSec),
                    MinSeekTime = TimeSpan.Zero,
                    MaxSeekTime = TimeSpan.FromSeconds(durationSec),
                    Position = TimeSpan.FromSeconds(Math.Clamp(positionSec, 0, durationSec)),
                };
                _smtc.UpdateTimelineProperties(tl);
            }
        }
        catch (Exception ex) { Logger.Error(ex, "AnnieBridge ApplyState 失败"); }
    }
}
