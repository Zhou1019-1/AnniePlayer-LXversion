using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Media;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Storage;
using Windows.Storage.Streams;
using System.Runtime.InteropServices;

class AnnieSmtcHost
{
    [DllImport("shell32.dll", SetLastError = true)]
    static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string appid);

    static MediaPlayer player;
    static SystemMediaTransportControls smtc;
    static string lastCover = "";

    static void Say(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    static void Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        int parentPid = 0;
        string silent = "silent.wav";
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "-ParentPid") int.TryParse(args[i + 1], out parentPid);
            if (args[i] == "-Silent") silent = args[i + 1];
        }

        try { SetCurrentProcessExplicitAppUserModelID("AnniePlayer.Fusion.SMTC"); } catch { }

        // 单实例：已有宿主就退出
        bool created;
        var mutex = new Mutex(true, @"Global\AnniePlayerSMTC", out created);
        if (!created) { Say("{\"ok\":false,\"msg\":\"already-running\"}"); return; }

        try
        {
            player = new MediaPlayer();
            player.IsLoopingEnabled = true;
            player.Volume = 0.01;
            player.Source = MediaSource.CreateFromUri(new Uri(silent));
            smtc = player.SystemMediaTransportControls;
            smtc.IsEnabled = true;
            smtc.IsPlayEnabled = true;
            smtc.IsPauseEnabled = true;
            smtc.IsNextEnabled = true;
            smtc.IsPreviousEnabled = true;
            smtc.DisplayUpdater.Type = MediaPlaybackType.Music;
            smtc.ButtonPressed += new Windows.Foundation.TypedEventHandler<SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs>(Smtc_ButtonPressed);
            player.Play();
            Say("{\"ok\":true,\"msg\":\"smtc-ready\"}");
        }
        catch (Exception ex)
        {
            Say("{\"ok\":false,\"msg\":\"" + ex.Message.Replace("\"", "'") + "\"}");
            return;
        }

        if (parentPid > 0)
        {
            var timer = new Timer(_ =>
            {
                try { var p = System.Diagnostics.Process.GetProcessById(parentPid); }
                catch { Environment.Exit(0); }
            }, null, 5000, 5000);
        }

        while (true)
        {
            string line = Console.In.ReadLine();
            if (line == null) break;
            line = line.Trim();
            if (line.Length == 0) continue;
            try
            {
                string json = Encoding.UTF8.GetString(Convert.FromBase64String(line));
                if (json.Contains("\"cmd\":\"quit\"")) break;
                Apply(json);
            }
            catch (Exception ex) { Say("{\"ok\":false,\"msg\":\"" + ex.Message.Replace("\"", "'") + "\"}"); }
        }
        try { player.Dispose(); } catch { }
    }

    static void Smtc_ButtonPressed(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args)
    {
        string name = args.Button.ToString().ToLowerInvariant(); // play / pause / next / previous
        Say("{\"evt\":\"button\",\"button\":\"" + name + "\"}");
    }

    static string Extract(string json, string key)
    {
        string pat = "\"" + key + "\":\"";
        int i = json.IndexOf(pat);
        if (i < 0) return null;
        i += pat.Length;
        var sb = new StringBuilder();
        for (; i < json.Length; i++)
        {
            char c = json[i];
            if (c == '\\' && i + 1 < json.Length)
            {
                char n = json[++i];
                if (n == 'n') sb.Append('\n');
                else if (n == 't') sb.Append('\t');
                else if (n == 'u' && i + 4 < json.Length)
                {
                    sb.Append((char)Convert.ToInt32(json.Substring(i + 1, 4), 16));
                    i += 4;
                }
                else sb.Append(n);
            }
            else if (c == '"') break;
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static double ExtractNum(string json, string key)
    {
        string pat = "\"" + key + "\":";
        int i = json.IndexOf(pat);
        if (i < 0) return 0;
        i += pat.Length;
        int j = i;
        while (j < json.Length && ("0123456789.+-".IndexOf(json[j]) >= 0)) j++;
        double v;
        return double.TryParse(json.Substring(i, j - i), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out v) ? v : 0;
    }

    static void Apply(string json)
    {
        var mp = smtc.DisplayUpdater.MusicProperties;
        string t = Extract(json, "title");
        string a = Extract(json, "artist");
        string al = Extract(json, "album");
        if (t != null) mp.Title = t;
        if (a != null) mp.Artist = a;
        if (al != null) mp.AlbumTitle = al;

        string cover = Extract(json, "cover");
        if (!string.IsNullOrEmpty(cover) && cover != lastCover)
        {
            try
            {
                string tmp = Path.Combine(Path.GetTempPath(), "annie-smtc-cover.jpg");
                File.WriteAllBytes(tmp, Convert.FromBase64String(cover));
                var file = StorageFile.GetFileFromPathAsync(tmp).AsTask().GetAwaiter().GetResult();
                smtc.DisplayUpdater.Thumbnail = RandomAccessStreamReference.CreateFromFile(file);
                lastCover = cover;
            }
            catch { }
        }
        smtc.DisplayUpdater.Update();
        smtc.IsPlayEnabled = true; smtc.IsPauseEnabled = true;
        smtc.IsNextEnabled = true; smtc.IsPreviousEnabled = true;

        double posSec = ExtractNum(json, "pos");
        double durSec = ExtractNum(json, "dur");
        if (durSec > 0.5)
        {
            try
            {
                var tl = new SystemMediaTransportControlsTimelineProperties();
                tl.StartTime = TimeSpan.Zero;
                tl.MinSeekTime = TimeSpan.Zero;
                tl.MaxSeekTime = TimeSpan.FromSeconds(durSec);
                tl.EndTime = TimeSpan.FromSeconds(durSec);
                tl.Position = TimeSpan.FromSeconds(Math.Min(Math.Max(0, posSec), durSec));
                smtc.UpdateTimelineProperties(tl);
            }
            catch { }
        }

        if (json.Contains("\"playing\":true"))
        {
            smtc.PlaybackStatus = MediaPlaybackStatus.Playing;
            player.Play();
        }
        else if (json.Contains("\"playing\":false"))
        {
            smtc.PlaybackStatus = MediaPlaybackStatus.Paused;
            player.Pause();
        }
        Say("{\"ok\":true,\"msg\":\"updated\"}");
    }
}
