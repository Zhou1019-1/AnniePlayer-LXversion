using System.Text.Json.Nodes;
using NAudio.Vst3;
using NAudio.Wave;

namespace MineEngine;

/// <summary>引擎核心：命令分发 + 播放状态机。拆分：Engine.Dsp.cs（DSP 设置）/ Engine.Vst.cs（VST 链）/ Engine.Playback.cs（播放控制）。</summary>
public sealed partial class Engine
{
    private readonly Rpc _rpc = new();
    private readonly object _gate = new();
    private static readonly DateTime StartedAt = DateTime.UtcNow; // Pro beat0.0.1：调试面板运行时长

    private IOutputBackend? _backend;
    private string _backendKind = "wasapi";
    private string? _backendDeviceId;   // wasapi: MMDevice ID；asio: 驱动名
    private bool _exclusive = true;     // V1.1.9：WASAPI 独占（默认）/共享

    private TrackInfo? _track;
    private FfmpegPcmStream? _pcm;
    private PcmFloatSource? _source;
    private double _offsetSec;
    private int _decodeRate;
    private bool _resampled;
    private bool _playing;
    private bool _pausing;               // V1.1.9：淡出进行中（锁外等待，防 resume 竞争）
    private bool _ended;
    private float _gain = 1.0f;
    private double[] _eqGains = new double[EqChain.BandCount]; // EXP 7.28：15 段 EQ 增益（dB）
    private bool _eqEnabled = true;
    // V3.5.19：参量 EQ（自由频段，与图示 EQ 串联）与声道工具（平衡/互换/单声道/反相）
    private bool _peqEnabled;
    private List<PeqChain.Band> _peqBands = new();
    private string _chMode = "stereo";   // stereo | swap | mono | invertL | invertR
    private double _chBalance;           // -1（全左）.. 0 .. 1（全右）
    /* ---------------- VST实验区：VST3 效果器链 ---------------- */
    private readonly List<VstFxSlot> _vstSlots = new();   // 槽位配置（路径/启用/状态），实例按源私有
    private readonly HashSet<string> _vstCrashNotified = new(); // 崩溃通知去重（音频线程置 Broken，定时器线程发通知）
    private VstEditorWindow? _vstEditor;       // 当前打开的插件原生界面（一期半：同时只允许一个）
    private VstFxInstance? _vstEditorInst;     // 编辑器挂接的活实例（可能是 Orphaned 的退役实例）
    /* ---------------- Pro beat0.0.1：音质链路增强 ---------------- */
    private string _dsdMode = "pcm";       // pcm（转 PCM）| dop（DoP 直通）| native（ASIO DSD，暂回退）
    private int _bufferMs = 150;          // 独占缓冲 50–500ms（V1.1.4：默认 150ms，50ms 过小易欠载爆音）
    private bool _preload;                 // 整轨预载到内存
    private string? _finalUrl;             // V1.1.4：网络流最终重定向 URL（seek 复用，省 302 往返）
    private string? _finalUrlPath;         // V1.1.6：_finalUrl 所属的原始请求 path（必须匹配才可复用）
    private long _finalUrlAt;              // 缓存时间戳（TickCount64）
    // V1.1.4：ffprobe 探测缓存（URL → TrackInfo）——前端预探测下一首后，切歌 Play 命中缓存跳过网络探测
    private readonly Dictionary<string, (TrackInfo Info, long At)> _probeCache = new();
    private const long ProbeCacheTtlMs = 10 * 60 * 1000L;
    private const int ProbeCacheMax = 64;
    private double _crossfadeSec;          // 交叉淡入时长（0=关闭）
    private bool _gapless;                 // V3.5.15：无缝播放（mixer 常驻，切歌硬切不开关设备）
    private bool _resampleHq;              // V3.5.15：重采样走 soxr 高质量
    private const int FadeMs = 60;         // V1.1.7：播放/暂停淡入淡出时长（无爆音暂停/恢复）
    private bool _autoPreamp = true;       // 自动前级补偿（防削波）
    private bool _limiter = true;          // 输出软限幅器
    private float _loudGain = 1.0f;        // 响度归一化增益（线性，由渲染侧按 R128 计算下发）
    private CrossfadeMixer? _mixer;
    private DsfReader? _dsf;
    private DopSource? _dopSource;
    private bool _dopActive;
    private string? _headers;          // 当前网络流的 HTTP 头（seek 重放时复用）
    private int _playGeneration;       // 播放代际：递增以识别新播放请求，防止竞态
    private readonly object _playGate = new(); // 播放互斥锁：串行化设备关键区（StopAll→打开→预缓冲→启动）
    // V1.1.10：设备流是否处于暂停（Pause 已 SafeStop 但句柄保留）。PlayCrossfade 需要据此
    // 恢复设备流——否则暂停后切歌 FadeTo 只换 mixer 源、不重启 WasapiOut → 无声但 UI 报 playing。
    private bool _streamPaused;

    private readonly Timer _positionTimer;

    // 电平数据：音频回调线程只写以下字段（零 I/O/零 JSON/零锁），
    // 由 position 定时器（10Hz）读取后 Emit level。float 读写原子，volatile 脏标记保证有序。
    private float _levelRmsL, _levelPeakL, _levelRmsR, _levelPeakR;
    private volatile bool _levelDirty;

    private void OnLevelSample(float rmsL, float peakL, float rmsR, float peakR)
    {
        _levelRmsL = rmsL; _levelPeakL = peakL; _levelRmsR = rmsR; _levelPeakR = peakR;
        _levelDirty = true;
    }

    public Engine(Rpc rpc)
    {
        _rpc = rpc;
        rpc.OnRequest += HandleAsync;
        _positionTimer = new Timer(_ => TickPosition(), null, Timeout.Infinite, Timeout.Infinite);
    }

    private async Task<object?> HandleAsync(string method, JsonObject p)
    {
        object? result = method switch
        {
            "engine.info" => new
            {
                version = "1.0.1",
                backend = _backendKind,
                ffmpeg = Toolchain.FfmpegPath,
                ffprobe = Toolchain.FfprobePath,
                ffmpegFound = Toolchain.FfmpegFound,
                ffprobeFound = Toolchain.FfprobeFound,
                hint = (Toolchain.FfmpegFound && Toolchain.FfprobeFound) ? "" : Toolchain.MissingHint
            },

            "devices.list" => (object)new
            {
                wasapi = WasapiExclusiveBackend.Enumerate().Select(d => new
                {
                    id = d.Id,
                    name = d.Name,
                    // Pro：DoP 能力探测（176.4kHz/24bit 独占），不支持时前端灰显 DoP 选项；
                    // 个别虚拟设备属性缺失会抛 KeyNotFound，逐台隔离
                    dop = ProbeDopSafe(d.Id)
                }),
                asio = AsioBackend.Enumerate(),
                current = new { kind = _backendKind, id = _backendDeviceId }
            },

            "devices.select" => SelectBackend(p["kind"]?.GetValue<string>() ?? "wasapi", p["id"]?.GetValue<string>(), p["exclusive"]?.GetValue<bool>() ?? true),

            "probe" => ProbeWithCache(Req(p, "path")),

            "play" => Play(Req(p, "path"), p["offsetSec"]?.GetValue<double>() ?? 0, p["headers"]?.GetValue<string>(), p["loudGain"]?.GetValue<double>() ?? 1.0),

            "play.crossfade" => PlayCrossfade(Req(p, "path"), p["headers"]?.GetValue<string>(), p["loudGain"]?.GetValue<double>() ?? 1.0),

            "pause" => Pause(),
            "resume" => Resume(),
            // V1.1.5：stop 递增播放代际——旧实现 StopAll 不碰 _playGeneration，
            // 并发 in-flight 的 play 在 stop 之后仍能通过代际检查、继续启动设备并 emit "playing"，
            // 造成 UI 已停止但引擎实际在播（串音/状态错乱根因之一）。
            "stop" => StopRequest(),

            "seek" => Seek(p["seconds"]?.GetValue<double>() ?? 0),

            "volume.set" => SetVolume(p["gain"]?.GetValue<double>() ?? 1.0),

            "eq.set" => SetEq(p),

            /* ---------------- VST实验区：VST3 效果器 ---------------- */
            "vst.scan" => VstScan(),
            "vst.list" => VstList(),
            "vst.add" => VstAdd(Req(p, "path")),
            "vst.remove" => VstRemove(Req(p, "id")),
            "vst.enable" => VstEnable(Req(p, "id"), p["on"]?.GetValue<bool>() ?? true),
            "vst.move" => VstMove(Req(p, "id"), p["dir"]?.GetValue<int>() ?? 0),
            "vst.params" => VstParams(Req(p, "id")),
            "vst.setParam" => VstSetParam(Req(p, "id"), p["paramId"]?.GetValue<uint>() ?? 0, p["value"]?.GetValue<double>() ?? 0),
            "vst.state" => VstGetState(Req(p, "id")),
            "vst.setState" => VstSetState(Req(p, "id"), p["stateB64"]?.GetValue<string>() ?? ""),
            "vst.openEditor" => await VstOpenEditor(Req(p, "id")),
            "vst.closeEditor" => VstCloseEditor(Req(p, "id")),

            /* ---------------- Pro beat0.0.1 ---------------- */
            "dsd.setMode" => SetDsdMode(p["mode"]?.GetValue<string>() ?? "pcm"),
            "buffer.set" => SetBuffer(p["ms"]?.GetValue<int>() ?? 50, p["preload"]?.GetValue<bool>() ?? false),
            "dsp.set" => SetDsp(p),
            "loud.set" => SetLoudGain(p["gain"]?.GetValue<double>() ?? 1.0),
            "crossfade.set" => SetCrossfade(p["seconds"]?.GetValue<double>() ?? 0),
            // V3.5.15：无缝播放（切歌保持设备流，硬切不重建）/ 重采样质量（soxr 高质量，下一曲生效）
            "gapless.set" => SetGapless(p["on"]?.GetValue<bool>() ?? true),
            "resample.set" => SetResampleHq(p["hq"]?.GetValue<bool>() ?? false),
            // V3.5.19：参量 EQ / 声道工具
            "peq.set" => SetPeq(p),
            "channel.set" => SetChannel(p),
            // V4：音频正确性测试（CI 专用，无输出设备拉取整条解码+DSP 链）
            "test.decode" => TestDecode(p),

            "asio.panel" => ShowAsioPanel(),

            // Pro beat0.0.1：调试/输出健康——解码缓冲水位 / 设备格式 / 重采样 / 欠载与限幅计数
            "stats" => Stats(),

            "shutdown" => Shutdown(),
            _ => throw new InvalidOperationException("未知方法: " + method),
        };
        // V3.5.15 修复：async 方法里 return Task.FromResult(result) 会把 Task 本体当结果序列化
        // （前端收到 {Result:..., Status:...} 导致 devices.list/stats/probe 等全部取不到字段）
        return result;
    }

    /// <summary>输出健康/调试统计：设备格式、重采样、缓冲水位、欠载与限幅计数（未播放时健康计数为 0）。</summary>
    private object Stats()
    {
        var src = _source;
        var pcm = _pcm;
        var backend = _backend;
        var fmt = backend?.ActiveFormat;
        double bufferedSec = src is null || pcm is null ? 0 : Math.Round(pcm.QueuedBytes / (double)Math.Max(1, src.WaveFormat.SampleRate * src.WaveFormat.Channels * 4), 2);
        return new
        {
            ok = true,
            bufferedBytes = pcm?.QueuedBytes ?? 0,
            bufferedSec,
            uptimeSec = (DateTime.UtcNow - StartedAt).TotalSeconds,
            playGeneration = _playGeneration,
            crossfadeSec = _crossfadeSec,
            dsdMode = _dsdMode,
            backendKind = _backendKind,
            deviceId = _backendDeviceId,
            deviceName = backend?.DeviceName ?? "",
            exclusive = backend is WasapiExclusiveBackend wb ? wb.IsExclusive : _exclusive,
            requestedRate = backend?.RequestedRate ?? _decodeRate,
            outputRate = fmt?.SampleRate ?? 0,
            bitsPerSample = fmt?.BitsPerSample ?? 0,
            channels = fmt?.Channels ?? 0,
            resampled = backend?.Resampled ?? _resampled,
            bufferMs = _bufferMs,
            preload = _preload,
            playing = _playing,
            streamPaused = _streamPaused,
            crossfading = _mixer?.Crossfading ?? false,
            dopActive = _dopActive,
            underrunCount = src is null ? 0 : System.Threading.Interlocked.Read(ref src.UnderrunCount),
            underrunFrames = src is null ? 0 : System.Threading.Interlocked.Read(ref src.UnderrunFrames),
            limiterClipBlocks = src is null ? 0 : System.Threading.Interlocked.Read(ref src.LimiterClipBlocks),
            decodeFailed = pcm?.Failed ?? false,
            sourceEnded = src?.SourceEnded ?? false,
            // V3.5.19：链路图——各 DSP 段激活状态（渲染层拼链路图用）
            eqActive = _eqEnabled && _eqGains.Any(g => Math.Abs(g) > 0.01),
            peqActive = _peqEnabled && _peqBands.Any(b => Math.Abs(b.GainDb) > 0.01),
            peqBands = _peqBands.Count,
            channelMode = _chMode,
            channelBalance = _chBalance,
            loudGain = src?.LoudGain ?? 1.0f,
            preamp = src?.Preamp ?? 1.0f,
            vstActive = _vstSlots.Count(s => s.Enabled && !s.Broken)
        };
    }

    private static string Req(JsonObject p, string key)
        => p[key]?.GetValue<string>() ?? throw new ArgumentException("缺少参数: " + key);

    private object SelectBackend(string kind, string? id, bool exclusive = true)
    {
        StopAll(emitState: false);
        lock (_gate)
        {
            _backend?.Dispose();
            _backend = null;
            _backendKind = kind;
            _backendDeviceId = id;
            _exclusive = exclusive; // V1.1.9：WASAPI 独占/共享（共享=系统混音器格式，不切设备）

            if (kind == "asio")
            {
                var drivers = AsioBackend.Enumerate();
                var name = id ?? drivers.FirstOrDefault();
                // V3.5.2+：持久化的 ASIO 驱动已不存在/加载失败 → 回退 WASAPI 默认输出而不是报错
                if (name is not null && !drivers.Contains(name)) name = null;
                if (name is not null)
                {
                    try { _backend = new AsioBackend(name); _backendDeviceId = name; }
                    catch { name = null; _backend = null; }
                }
                if (name is null)
                {
                    var dev = WasapiExclusiveBackend.GetDefault()
                        ?? throw new InvalidOperationException("ASIO 驱动不可用且无 WASAPI 输出设备");
                    _backendKind = "wasapi";
                    _backend = new WasapiExclusiveBackend(dev, exclusive);
                    _backendDeviceId = dev.ID;
                }
            }
            else
            {
                var dev = id is null ? WasapiExclusiveBackend.GetDefault() : WasapiExclusiveBackend.FindById(id);
                if (dev is null && id is not null)
                {
                    // 设备断电/拔插/重枚举后持久化的 GUID 失效：回退系统默认输出，
                    // 不再抛"WASAPI 设备不存在"导致整链播放失败（V3.5.2）
                    dev = WasapiExclusiveBackend.GetDefault();
                }
                if (dev is null) throw new InvalidOperationException("无可用 WASAPI 输出设备");
                _backend = new WasapiExclusiveBackend(dev, exclusive);
                _backendDeviceId = dev.ID;
            }
        }
        _rpc.Emit("backend", new { kind = _backendKind, device = _backend!.DeviceName, exclusive });
        return new { kind = _backendKind, id = _backendDeviceId, exclusive };
    }

    private IOutputBackend EnsureBackend()
    {
        if (_backend is null) SelectBackend(_backendKind, _backendDeviceId);
        return _backend!;
    }

    /// <summary>Pro：DoP 能力安全探测（设备属性缺失/消失时返回 false 而不是让整个 devices.list 失败）。</summary>
    private static bool ProbeDopSafe(string id)
    {
        try
        {
            return WasapiExclusiveBackend.FindById(id) is { } dev
                && new WasapiExclusiveBackend(dev).SupportsDop(2822400);
        }
        catch { return false; }
    }

    private object ShowAsioPanel()
    {
        if (_backend is AsioBackend ab) ab.ShowControlPanel();
        return new { ok = true };
    }

    private object Shutdown()
    {
        Task.Run(async () => { await Task.Delay(100); Environment.Exit(0); });
        return new { ok = true };
    }
}
