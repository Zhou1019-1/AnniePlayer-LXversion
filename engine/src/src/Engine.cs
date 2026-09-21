using System.Text.Json.Nodes;
using NAudio.Vst3;
using NAudio.Wave;

namespace MineEngine;

/// <summary>引擎核心：命令分发 + 播放状态机。</summary>
public sealed class Engine
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

            "asio.panel" => ShowAsioPanel(),

            // Pro beat0.0.1：调试/输出健康——解码缓冲水位 / 设备格式 / 重采样 / 欠载与限幅计数
            "stats" => Stats(),

            "shutdown" => Shutdown(),
            _ => throw new InvalidOperationException("未知方法: " + method),
        };
        return Task.FromResult(result);
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
            sourceEnded = src?.SourceEnded ?? false
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

    private object SetVolume(double gain)
    {
        _gain = (float)Math.Clamp(gain, 0, 1.5);
        lock (_gate) { if (_source is not null) _source.Gain = _gain; }
        return new { gain = _gain };
    }

    /// <summary>
    /// EXP 7.28：15 段均衡器。params: { gains: double[15], enabled: bool }
    /// EQ 作用于解码后的 float PCM（PcmFloatSource），增益实时热更新、无爆音、不中断播放；
    /// 换歌/换采样率时新源会按当前增益重建滤波链，双界面共享同一实例。
    /// </summary>
    private object SetEq(JsonObject p)
    {
        if (p["gains"] is JsonArray arr)
            for (int i = 0; i < EqChain.BandCount && i < arr.Count; i++)
                _eqGains[i] = arr[i]?.GetValue<double>() ?? 0;
        if (p["enabled"] is JsonNode en) _eqEnabled = en.GetValue<bool>();
        lock (_gate) { ApplyEqLocked(); }
        return new { ok = true, enabled = _eqEnabled, gains = _eqGains };
    }

    /// <summary>把当前 EQ 增益挂载到活动源（须持有 _gate）。</summary>
    private void ApplyEqLocked()
    {
        if (_source is null) return;
        if (!_eqEnabled) { _source.Eq = null; return; }
        var eq = _source.Eq;
        if (eq is null || eq.SampleRate != _source.WaveFormat.SampleRate)
            _source.Eq = eq = new EqChain(_source.WaveFormat.SampleRate, _source.WaveFormat.Channels);
        eq.Update(_eqGains);
    }

    /* ==================== VST实验区：VST3 效果器链 ==================== */

    private static object VstSlotInfo(VstFxSlot s) => new
    {
        id = s.Id,
        path = s.Path,
        name = s.Name,
        enabled = s.Enabled,
        broken = s.Broken,
        auto = s.AutoBypassed,
        editorOpen = _editorSlotIdStatic == s.Id,
        perfMs = Math.Round(System.Threading.Interlocked.Read(ref s.PerfEmaUs) / 1000.0, 2),
        perfCalls = System.Threading.Interlocked.Read(ref s.PerfCalls)
    };
    // VstSlotInfo 是静态方法，编辑器状态经此静态字段透传（Engine 单例）
    private static string? _editorSlotIdStatic;

    private object VstScan()
    {
        try
        {
            var items = Vst3PluginScanner.EnumerateInstalled().Select(m => new { path = m.Path, name = m.Name }).ToArray();
            return new { ok = true, items };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    private object VstList() { lock (_gate) return new { ok = true, slots = _vstSlots.Select(VstSlotInfo).ToArray() }; }

    private object VstAdd(string path)
    {
        var slot = new VstFxSlot { Id = Guid.NewGuid().ToString("N")[..8], Path = path };
        try { slot.LoadModule(); }
        catch (Exception ex) { try { slot.Dispose(); } catch { } return new { ok = false, error = ex.Message }; }
        lock (_gate) { _vstSlots.Add(slot); ReattachVstLocked(); }
        return new { ok = true, slot = VstSlotInfo(slot) };
    }

    private object VstRemove(string id)
    {
        lock (_gate)
        {
            var slot = _vstSlots.FirstOrDefault(s => s.Id == id);
            if (slot is null) return new { ok = false, error = "槽位不存在" };
            if (_vstEditor is not null && _vstEditor.SlotId == id) CloseVstEditorLocked(); // 先关界面再卸模块
            _vstSlots.Remove(slot); _vstCrashNotified.Remove(id);
            ReattachVstLocked(); // 先重建链（摘掉该插件实例），再释放模块
            try { slot.Dispose(); } catch { }
        }
        return new { ok = true };
    }

    private object VstEnable(string id, bool on)
    {
        lock (_gate)
        {
            var slot = _vstSlots.FirstOrDefault(s => s.Id == id);
            if (slot is null) return new { ok = false, error = "槽位不存在" };
            slot.Enabled = on;
            if (on)
            {
                slot.Broken = false; slot.AutoBypassed = false; _vstCrashNotified.Remove(id); // 重新启用 = 给它一次复活机会
                System.Threading.Interlocked.Exchange(ref slot.PerfCalls, 0);
                System.Threading.Interlocked.Exchange(ref slot.PerfEmaUs, 0);
                System.Threading.Interlocked.Exchange(ref slot.PerfSlowStreak, 0);
                // 关闭时我们保留实例做湿声淡出；若当前源里还没有该槽实例（例如播放前就禁用），再挂链让它从 Wet=0 淡入。
                if (_source?.VstFx?.Any(i => i.Slot.Id == id) != true) ReattachVstLocked();
            }
            // 关闭：不拆链，PcmFloatSource 按 target=0 做 20ms 湿声淡出后跳过处理，避免咔哒。
        }
        return new { ok = true };
    }

    private object VstMove(string id, int dir)
    {
        lock (_gate)
        {
            int i = _vstSlots.FindIndex(s => s.Id == id);
            int j = i + (dir < 0 ? -1 : 1);
            if (i < 0) return new { ok = false, error = "槽位不存在" };
            if (j < 0 || j >= _vstSlots.Count) return new { ok = true }; // 到顶/到底不动
            (_vstSlots[i], _vstSlots[j]) = (_vstSlots[j], _vstSlots[i]);
            SyncVstOrderLocked(); // 仅重排已存在实例，不重建插件，避免顺序调整产生爆音
        }
        return new { ok = true };
    }

    private object VstParams(string id)
    {
        VstFxSlot? slot; VstFxInstance? live;
        lock (_gate) { slot = _vstSlots.FirstOrDefault(s => s.Id == id); live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id); }
        if (slot is null) return new { ok = false, error = "槽位不存在" };
        VstFxInstance? temp = null;
        try
        {
            var plugin = live?.Plugin ?? (temp = slot.CreateInstanceFor(48000, 2)).Plugin; // 未播放时临时实例读参数表
            var arr = plugin.Parameters
                .Where(pr => !pr.IsHidden)
                .Select(pr => new
                {
                    id = pr.Id, title = pr.Title, units = pr.Units,
                    value = pr.NormalizedValue, display = pr.DisplayValue,
                    readOnly = pr.IsReadOnly, discrete = pr.IsDiscrete || pr.StepCount > 0, steps = pr.StepCount
                }).ToArray();
            return new { ok = true, name = slot.Name, @params = arr };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        finally { if (temp is not null) try { temp.Dispose(); } catch { } }
    }

    private object VstSetParam(string id, uint paramId, double value)
    {
        VstFxInstance? live; VstFxSlot? slot;
        lock (_gate) { slot = _vstSlots.FirstOrDefault(s => s.Id == id); live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id); }
        if (slot is null) return new { ok = false, error = "槽位不存在" };
        if (live is null) return new { ok = true, display = "" }; // 未播放：参数暂存不了（一期限制），UI 侧仅展示
        try
        {
            // 经主机参数队列转发，线程安全；显示值回读给 UI
            string display = "";
            if (live.Plugin.Parameters.TryGetById(paramId, out var prm) && prm is not null)
            {
                prm.NormalizedValue = Math.Clamp(value, 0, 1);
                display = prm.DisplayValue;
            }
            return new { ok = true, display };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    private object VstGetState(string id)
    {
        VstFxSlot? slot; VstFxInstance? live;
        lock (_gate) { slot = _vstSlots.FirstOrDefault(s => s.Id == id); live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id); }
        if (slot is null) return new { ok = false, error = "槽位不存在" };
        try
        {
            if (live is not null) slot.SavedState = live.Plugin.SaveState(); // 收编当前实例状态
            return new { ok = true, stateB64 = slot.SavedState is null ? "" : Convert.ToBase64String(slot.SavedState) };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    private object VstSetState(string id, string stateB64)
    {
        VstFxSlot? slot; VstFxInstance? live;
        lock (_gate) { slot = _vstSlots.FirstOrDefault(s => s.Id == id); live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id); }
        if (slot is null) return new { ok = false, error = "槽位不存在" };
        try
        {
            slot.SavedState = string.IsNullOrEmpty(stateB64) ? null : Convert.FromBase64String(stateB64);
            if (live is not null && slot.SavedState is not null) live.Plugin.LoadState(slot.SavedState);
            return new { ok = true };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    /* ---------- 插件原生界面（FB2K 式独立悬浮窗） ---------- */

    /// <summary>打开插件原生界面。IVGI2 这类分离控制器插件要求模块/插件/视图在同一 UI 线程创建，因此编辑器实例在 VST 编辑器线程内生成。</summary>
    private async Task<object> VstOpenEditor(string id)
    {
        VstFxSlot? slot; int rate = 48000, channels = 2;
        lock (_gate)
        {
            slot = _vstSlots.FirstOrDefault(s => s.Id == id);
            var live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id);
            if (slot is null) return new { ok = false, error = "槽位不存在" };
            if (live is null) return new { ok = false, error = "请先播放音乐，再打开插件界面" };
            if (_vstEditor is not null)
            {
                if (_vstEditor.SlotId == id) return new { ok = true }; // 已开着
                CloseVstEditorLocked(); // 换另一个插件：先关旧的
            }
            rate = _source?.WaveFormat.SampleRate ?? 48000;
            channels = _source?.WaveFormat.Channels ?? 2;
            // 先标记 EditorOpen：音频线程把该槽湿声 20ms 淡出，再摘活实例（IVGI2 活动实例会抢占第二个实例的 UI Attach）。
            if (_source?.VstFx?.Any(i => i.Slot.Id == id) == true) slot.EditorOpen = true;
        }
        if (slot.EditorOpen) await Task.Delay(35); // 等淡出完成，避免开原生界面瞬间咔哒
        lock (_gate)
        {
            var src = _source;
            if (src?.VstFx is { } fx)
            {
                var removed = fx.Where(i => i.Slot.Id == id).ToArray();
                if (removed.Length > 0)
                {
                    foreach (var inst in removed) { try { slot.SavedState = inst.Plugin.SaveState(); } catch { } }
                    slot.EditorOpen = true;
                    var remain = fx.Where(i => i.Slot.Id != id).ToArray();
                    src.VstFx = remain.Length > 0 ? remain : null;
                    foreach (var inst in removed) { try { inst.Dispose(); } catch { } }
                }
            }
        }
        var win = new VstEditorWindow { SlotId = id, OnClosed = VstEditorCleanup };
        try
        {
            win.OpenFactory(() =>
            {
                var inst = slot.CreateInstanceFor(rate, channels);
                if (slot.SavedState is not null) { try { inst.Plugin.LoadState(slot.SavedState); } catch { } }
                inst.Orphaned = true;      // 不进音频链，关闭编辑器后由清理路径释放
                inst.EditorAttached = true;
                return inst;
            }, slot.Name + " — 安妮播放器");
            lock (_gate) { _vstEditor = win; _editorSlotIdStatic = id; _vstEditorInst = win.Instance; }
            return new { ok = true };
        }
        catch (Exception ex)
        {
            if (win.Instance is not null) { win.Instance.EditorAttached = false; try { win.Instance.Plugin.Dispose(); } catch { } }
            if (slot.EditorOpen) { slot.EditorOpen = false; lock (_gate) { ReattachVstLocked(); } } // 打开失败：恢复音频链
            return new { ok = false, error = ex.Message };
        }
    }

    private object VstCloseEditor(string id)
    {
        lock (_gate)
        {
            if (_vstEditor is null || _vstEditor.SlotId != id) return new { ok = true };
            CloseVstEditorLocked();
        }
        return new { ok = true };
    }

    /// <summary>关编辑器（须持 _gate）。实际清理在 UI 线程完成后经 VstEditorCleanup 回调。</summary>
    private void CloseVstEditorLocked()
    {
        var win = _vstEditor;
        _vstEditor = null; _editorSlotIdStatic = null;
        try { win?.Close(); } catch { }
        // 若窗口线程已不在（异常情况），就地兜底回收
        var inst = _vstEditorInst;
        if (win is null && inst is not null) { inst.EditorAttached = false; _vstEditorInst = null; if (inst.Orphaned) { try { inst.Plugin.Dispose(); } catch { } } }
    }

    /// <summary>窗口销毁回调（编辑器 UI 线程触发）：收编状态 + 回收退役实例的插件对象。</summary>
    private void VstEditorCleanup(VstEditorWindow win)
    {
        lock (_gate)
        {
            if (ReferenceEquals(_vstEditor, win)) { _vstEditor = null; _editorSlotIdStatic = null; }
            var inst = win.Instance ?? _vstEditorInst;
            if (inst is null || win.SlotId != inst.Slot.Id) return;
            _vstEditorInst = null;
            inst.EditorAttached = false;
            try { inst.Slot.SavedState = inst.Plugin.SaveState(); } catch { } // 编辑器里调的参数收编回槽位
            if (inst.Orphaned) // 独立编辑器实例：把状态同步回正在播放的活实例，再释放编辑器实例
            {
                var liveNow = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == inst.Slot.Id);
                if (liveNow is not null && !ReferenceEquals(liveNow, inst) && inst.Slot.SavedState is not null)
                {
                    try { liveNow.Plugin.LoadState(inst.Slot.SavedState); } catch { }
                }
                try { inst.Plugin.Dispose(); } catch { }
            }
            if (inst.Slot.EditorOpen) { inst.Slot.EditorOpen = false; ReattachVstLocked(); } // 关界面后把该槽接回音频链
        }
    }

    /// <summary>把启用的效果器链挂到源上（每源私有实例；旧实例先收编状态再释放）。可在锁外调用。</summary>
    private void AttachVst(PcmFloatSource source)
    {
        var old = source.VstFx; source.VstFx = null;
        if (old is not null) foreach (var i in old) { try { i.Dispose(); } catch { } }
        if (_vstSlots.Count == 0) return;
        int rate = source.WaveFormat.SampleRate, ch = source.WaveFormat.Channels;
        var list = new List<VstFxInstance>();
        foreach (var s in _vstSlots)
        {
            if (!s.Enabled || s.Broken || s.EditorOpen) continue;
            try { list.Add(s.CreateInstanceFor(rate, ch)); }
            catch (Exception ex) { s.Broken = true; _rpc.Emit("notify", new { text = $"VST 插件「{s.Name}」加载失败已旁通：{ex.Message}" }); }
        }
        source.VstFx = list.Count > 0 ? list.ToArray() : null;
    }

    private void ReattachVstLocked() { if (_source is not null) AttachVst(_source); }

    /// <summary>只按槽位顺序重排当前源里的实例；缺实例/多实例时才回退重建。须持 _gate。</summary>
    private void SyncVstOrderLocked()
    {
        var src = _source; var fx = src?.VstFx;
        if (src is null || fx is null) return;
        var order = new Dictionary<string, int>();
        for (int i = 0; i < _vstSlots.Count; i++) order[_vstSlots[i].Id] = i;
        if (fx.Any(i => !order.ContainsKey(i.Slot.Id))) { ReattachVstLocked(); return; }
        src.VstFx = fx.OrderBy(i => order[i.Slot.Id]).ToArray();
    }

    /// <summary>Pro：把防削波链路（自动前级 + 限幅器）应用到活动源（须持有 _gate）。</summary>
    private void ApplyDspLocked()
    {
        if (_source is null) return;
        double maxPos = 0;
        if (_eqEnabled) foreach (var g in _eqGains) if (g > maxPos) maxPos = g;
        _source.Preamp = _autoPreamp ? (float)Math.Pow(10.0, -maxPos / 20.0) : 1.0f;
        _source.Limiter = _limiter;
        _source.LoudGain = _loudGain;
    }

    /* ---------------- Pro beat0.0.1：新 RPC ---------------- */

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

    private object SetDsdMode(string mode)
    {
        _dsdMode = mode is "dop" or "native" ? mode : "pcm";
        return new { ok = true, mode = _dsdMode };
    }

    private object SetBuffer(int ms, bool preload)
    {
        _bufferMs = Math.Clamp(ms, 50, 500);
        _preload = preload;
        lock (_gate) { if (_backend is WasapiExclusiveBackend w) w.BufferMs = _bufferMs; }
        return new { ok = true, ms = _bufferMs, preload = _preload };
    }

    private object SetDsp(JsonObject p)
    {
        if (p["autoPreamp"] is JsonNode ap) _autoPreamp = ap.GetValue<bool>();
        if (p["limiter"] is JsonNode lm) _limiter = lm.GetValue<bool>();
        lock (_gate) { ApplyDspLocked(); }
        return new { ok = true, autoPreamp = _autoPreamp, limiter = _limiter };
    }

    private object SetLoudGain(double gain)
    {
        _loudGain = (float)Math.Clamp(gain, 0.05, 4.0); // -26dB ~ +12dB
        lock (_gate) { if (_source is not null) _source.LoudGain = _loudGain; }
        return new { gain = _loudGain };
    }

    private object SetCrossfade(double seconds)
    {
        _crossfadeSec = Math.Clamp(seconds, 0, 10);
        return new { ok = true, seconds = _crossfadeSec };
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

    // ---------------- 播放控制 ----------------

    private TrackInfo? GetCachedProbe(string path)
    {
        lock (_gate)
        {
            if (_probeCache.TryGetValue(path, out var e) && Environment.TickCount64 - e.At < ProbeCacheTtlMs)
                return e.Info;
            _probeCache.Remove(path);
            return null;
        }
    }

    private void CacheProbe(string path, TrackInfo info)
    {
        lock (_gate)
        {
            if (_probeCache.Count >= ProbeCacheMax)
            {
                // 简单淘汰：移除首个键（Dictionary 枚举序）
                foreach (var k in _probeCache.Keys) { _probeCache.Remove(k); break; }
            }
            _probeCache[path] = (info, Environment.TickCount64);
        }
    }

    private static TrackInfo ProbeGuarded(string path)
    {
        if (!Toolchain.FfprobeFound) throw new InvalidOperationException(Toolchain.MissingHint);
        return FfmpegPcmStream.Probe(path);
    }

    private object Play(string path, double offsetSec, string? headers = null, double loudGain = 1.0,
        TrackInfo? knownInfo = null, bool quickStart = false)
    {
        if (!Toolchain.FfmpegFound || !Toolchain.FfprobeFound)
            throw new InvalidOperationException(Toolchain.MissingHint);
        // 网络流地址跳过本地文件存在性检查
        if (!FfmpegPcmStream.IsUrl(path) && !File.Exists(path)) throw new FileNotFoundException("文件不存在: " + path);
        _loudGain = (float)Math.Clamp(loudGain, 0.05, 4.0);

        // 递增播放代际，防止旧播放操作覆盖新播放状态
        int gen = Interlocked.Increment(ref _playGeneration);
        _rpc.Emit("state", new { state = "loading", path });

        // ffprobe 探测不触碰输出设备，允许并发（网络流探测是耗时大头）
        // V1.1.4：seek 已携带 knownInfo 时跳过探测（格式/时长已知）；否则查 probe 缓存
        //（前端预探测预热），命中同样跳过网络探测——流媒体切歌 3~5s → ~1s
        var info = knownInfo ?? GetCachedProbe(path);
        if (info is null)
        {
            info = FfmpegPcmStream.Probe(path, headers);
            CacheProbe(path, info);
        }

        // V1.1.4：网络流异步解析最终重定向 URL（不阻塞播放），seek 时复用省 302 往返
        if (FfmpegPcmStream.IsUrl(path) && path != _finalUrl) TryResolveFinalUrl(path, headers);

        // 设备关键区串行化：多个并发 Play 排队执行，被替代的请求在入口直接退出，
        // 避免并发操作共享 backend 实例导致的流互相覆盖/设备互锁。
        lock (_playGate)
        {
            if (gen != _playGeneration) return new { ok = false, reason = "superseded" };
            StopAll(emitState: false);
            var backend = EnsureBackend();

            // Pro：DSD 原生输出分支（DoP / Native）。返回 null = 已发提示并回退普通 PCM 路径
            if (DsfReader.IsDsf(path) && _dsdMode != "pcm")
            {
                var dopResult = TryPlayDop(path, offsetSec, backend, gen);
                if (dopResult is not null) return dopResult;
            }

            // 设备释放延迟兜底：快速切歌时旧流刚释放，系统端设备句柄可能尚未完全复位
            // （USB 音频设备的独占锁释放可长达数秒），打开失败时延迟重试，总预算约 4 秒。
            for (int openRetry = 0; ; openRetry++)
            {
                if (gen != _playGeneration) return new { ok = false, reason = "superseded" };
                try
                {
                    return PlayWithBackend(path, offsetSec, headers, info, backend, gen, quickStart);
                }
                catch (Exception openEx) when (openRetry < 6 && gen == _playGeneration)
                {
                    Console.Error.WriteLine($"[engine] 打开输出设备失败，600ms 后重试 ({openRetry + 1}/6)：{openEx.GetType().Name}: {openEx.Message}");
                    if (openRetry == 0) Console.Error.WriteLine("[engine] openEx stack: " + openEx.StackTrace);
                    Thread.Sleep(600);
                }
            }
        }
    }

    private object PlayWithBackend(string path, double offsetSec, string? headers, TrackInfo info, IOutputBackend backend, int gen, bool quickStart = false)
    {
        try
        {
            return OpenWithChannels(path, offsetSec, headers, info, backend, gen, info.Channels, quickStart);
        }
        catch (InvalidOperationException) when (info.Channels != 2)
        {
            // 通道数兜底：单声道/多声道在部分设备上不被接受时，上混/下混为立体声重试
            Console.Error.WriteLine($"[engine] {info.Channels}ch 打开失败，回退 2ch 立体声重试");
            return OpenWithChannels(path, offsetSec, headers, info, backend, gen, 2, quickStart);
        }
    }

    /// <summary>Pro：解码队列容量（preload=整轨预载；否则 ≈4 秒）。</summary>
    private int CapacityFor(TrackInfo info, int rate, int channels)
        => _preload && info.DurationSec > 0
            ? (int)Math.Min((long)512 * 1024 * 1024, (long)(info.DurationSec * rate * channels * 4) + (1 << 20))
            : 0;

    private object OpenWithChannels(string path, double offsetSec, string? headers, TrackInfo info, IOutputBackend backend, int gen, int channels, bool quickStart = false)
    {
        int rate = info.SampleRate;
        bool resampled = false;

        for (int attempt = 0; attempt < 2; attempt++)
        {
            var pcm = FfmpegPcmStream.Start(path, offsetSec, resampled ? rate : 0, rate, channels, headers, CapacityFor(info, rate, channels));
            var source = new PcmFloatSource(pcm, rate, channels) { Gain = _gain, LoudGain = _loudGain };
            if (_eqEnabled) { source.Eq = new EqChain(rate, channels); source.Eq.Update(_eqGains); }
            AttachVst(source); // VST实验区：效果器链（每源私有实例）
            // 双声道电平：rms/peak 保留为两声道较大值（向后兼容），rmsL/peakL/rmsR/peakR 为分声道值
            // 音频回调线程只写缓存字段，level 事件由 position 定时器（10Hz）顺带发送
            source.OnLevel += OnLevelSample;

            // Pro：crossfade 开启时经混音器输出（设备流在切歌时保持打开，同流混音过渡）
            IWaveProvider outProvider = source;
            if (_crossfadeSec > 0)
            {
                if (_mixer is null || _mixer.WaveFormat.SampleRate != rate || _mixer.Channels != channels)
                    _mixer = new CrossfadeMixer(rate, channels);
                _mixer.SetInitial(source);
                outProvider = _mixer;
            }
            else _mixer = null;

            int? needRate;
            try
            {
                needRate = backend.TryOpen(outProvider, rate, channels);
            }
            catch
            {
                // 打开失败必须释放 ffmpeg 解码进程，否则快速重试时进程泄漏
                try { pcm.Dispose(); } catch { }
                throw;
            }
            if (needRate is null)
            {
                lock (_gate)
                {
                    // 检查是否已被更新的播放请求替代
                    if (gen != _playGeneration)
                    {
                        try { pcm.Dispose(); } catch { }
                        try { backend.Stop(); } catch { }
                        return new { ok = false, reason = "superseded" };
                    }
                    _track = info; _pcm = pcm; _source = source;
                    _offsetSec = offsetSec; _decodeRate = rate; _resampled = resampled;
                    _playing = true; _ended = false; _headers = headers;
                    _streamPaused = false; // 新开设备流，暂停标志清除
                    ApplyDspLocked(); // Pro：挂载自动前级/限幅器/响度增益
                }
                PrebufferAndStart(backend, pcm, rate, channels, gen, quickStart);

                // 预缓冲后再次检查代际，防止期间被新请求替代
                lock (_gate)
                {
                    if (gen != _playGeneration)
                    {
                        try { backend.Stop(); } catch { }
                        return new { ok = false, reason = "superseded" };
                    }
                }

                _rpc.Emit("format", new
                {
                    sampleRate = rate,
                    channels,
                    requestedRate = info.SampleRate,
                    resampled,
                    codec = info.Codec,
                    bitDepth = info.BitDepth,
                    backend = backend.Kind,
                    device = backend.DeviceName,
                    outFormat = $"{backend.ActiveFormat.SampleRate}Hz/{backend.ActiveFormat.BitsPerSample}bit",
                    // Pro：Bit-perfect 直通判定（黄点原因由渲染侧展示）
                    bitPerfect = !resampled && !info.Codec.Contains("dsd", StringComparison.OrdinalIgnoreCase),
                    reason = resampled ? $"引擎重采样至 {rate}Hz"
                        : info.Codec.Contains("dsd", StringComparison.OrdinalIgnoreCase) ? "DSD 转 PCM" : "",
                    dsdMode = _dsdMode, dop = false
                });
                _rpc.Emit("state", new { state = "playing", path });
                _positionTimer.Change(0, 100);
                return new { ok = true, sampleRate = rate, resampled };
            }

            // 设备不接受该采样率 → 用 ffmpeg 重采样后重试
            pcm.Dispose();
            rate = needRate.Value;
            resampled = true;
        }
        throw new InvalidOperationException("无法以任何采样率打开输出设备。");
    }

    private void PrebufferAndStart(IOutputBackend backend, FfmpegPcmStream pcm, int rate, int channels, int gen, bool quickStart = false)
    {
        // Pro：预缓冲目标跟随缓冲设置（50–500ms ×2，最少 0.3s）
        // V1.1.4：seek 快速起播目标 150ms，边播边缓冲（消除 seek 后的长预缓冲冻结）
        long target = quickStart
            ? (long)(rate * channels * 4 * 0.15)
            : (long)(rate * channels * 4 * Math.Max(0.3, _bufferMs / 1000.0 * 2));
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (!pcm.EndOfStream && !pcm.Failed && pcm.QueuedBytes < target && sw.ElapsedMilliseconds < 8000)
        {
            if (gen != _playGeneration) return; // 已被新播放请求替代：立即退出，释放关键区
            Thread.Sleep(15);
        }
        backend.Play();
    }

    /* ---------------- Pro beat0.0.1：DSD 原生输出（DoP） ---------------- */

    /// <summary>尝试以 DoP 播放 DSF；返回 null 表示已发 notify 并应回退普通 PCM 路径。</summary>
    private object? TryPlayDop(string path, double offsetSec, IOutputBackend backend, int gen)
    {
        if (_dsdMode == "native")
        {
            _rpc.Emit("notify", new { text = "Native ASIO DSD 需要驱动支持 DSD 样本格式，当前链路暂不支持，已回退转 PCM" });
            return null;
        }
        if (backend is not WasapiExclusiveBackend wb)
        {
            _rpc.Emit("notify", new { text = "DoP 仅支持 WASAPI 独占输出，已回退转 PCM" });
            return null;
        }
        DsfReader? dsf;
        try { dsf = new DsfReader(path); }
        catch { _rpc.Emit("notify", new { text = "DSF 解析失败，已回退转 PCM" }); return null; }

        if (!wb.SupportsDop(dsf.DsdRate))
        {
            _rpc.Emit("notify", new { text = $"设备不支持 {dsf.DsdRate / 16 / 1000}kHz/24bit（DoP 封装率），已回退转 PCM" });
            try { dsf.Dispose(); } catch { }
            return null;
        }
        if (offsetSec > 0.001) dsf.SeekSeconds(offsetSec);
        var dop = new DopSource(dsf);
        try { if (!wb.TryOpenDop(dop)) throw new InvalidOperationException("dop-open-rejected"); }
        catch
        {
            _rpc.Emit("notify", new { text = "DoP 打开输出失败，已回退转 PCM" });
            try { dsf.Dispose(); } catch { }
            return null;
        }

        lock (_gate)
        {
            if (gen != _playGeneration)
            {
                try { wb.Stop(); } catch { }
                try { dsf.Dispose(); } catch { }
                return new { ok = false, reason = "superseded" };
            }
            _dsf = dsf; _dopSource = dop; _dopActive = true;
            _track = new TrackInfo(path, dsf.DurationSec, dsf.DsdRate, dsf.Channels, "dsd", 1);
            _offsetSec = offsetSec; _playing = true; _ended = false;
            _streamPaused = false; // 新开设备流，暂停标志清除
        }
        wb.Play();
        _rpc.Emit("format", new
        {
            sampleRate = dsf.DsdRate,
            channels = dsf.Channels,
            requestedRate = dsf.DsdRate,
            resampled = false,
            codec = "dsd",
            bitDepth = 1,
            backend = backend.Kind,
            device = backend.DeviceName,
            outFormat = $"{dop.WaveFormat.SampleRate}Hz/24bit (DoP)",
            bitPerfect = true,
            reason = "",
            dsdMode = "dop",
            dop = true
        });
        _rpc.Emit("state", new { state = "playing", path });
        _positionTimer.Change(0, 100);
        return new { ok = true, dop = true };
    }

    /* ---------------- Pro beat0.0.1：交叉淡入（同流混音过渡） ---------------- */

    /// <summary>crossfade 切歌：设备流保持打开，旧曲淡出 + 新曲淡入。条件不满足时回退普通播放。</summary>
    private object PlayCrossfade(string path, string? headers, double loudGain)
    {
        // V1.1.9：去掉 !_playing 条件——歌曲自然结束后 _playing=false 但 mixer/设备仍在，
        // 此时切歌应继续走 crossfade（FadeTo 无缝衔接）；旧实现回退普通 Play 触发设备开关。
        if (_mixer is null || _backend is null || _dopActive
            || DsfReader.IsDsf(path) || _crossfadeSec <= 0)
            return Play(path, 0, headers, loudGain);
        if (!FfmpegPcmStream.IsUrl(path) && !File.Exists(path)) throw new FileNotFoundException("文件不存在: " + path);

        int gen = Interlocked.Increment(ref _playGeneration);
        _rpc.Emit("state", new { state = "loading", path });
        // V1.1.4：先探测；若与当前 mixer 采样率/声道不匹配则回退普通 Play——
        // mixer 重建后无法重绑后端设备（WasapiOut 绑定固定 provider），否则无声卡住
        //（流媒体 44.1k → 本地 96k 等跨采样率切歌会触发）
        // V1.1.9：回退必须带 quickStart（150ms 预缓冲边播边缓冲）——旧实现走完整预缓冲
        //（≥0.3s 起步，网络流更久），跨格式切歌"不跟手"的元凶之一。
        var info = FfmpegPcmStream.Probe(path, headers);
        if (info.SampleRate != _mixer!.WaveFormat.SampleRate || info.Channels != _mixer.Channels)
        {
            Console.Error.WriteLine($"[engine] crossfade 格式不匹配({info.SampleRate}/{info.Channels} vs {_mixer.WaveFormat.SampleRate}/{_mixer.Channels})，回退快速播放");
            return Play(path, 0, headers, loudGain, knownInfo: info, quickStart: true);
        }

        lock (_playGate)
        {
            if (gen != _playGeneration) return new { ok = false, reason = "superseded" };
            var mixer = _mixer!;
            int mixRate = mixer.WaveFormat.SampleRate, mixCh = mixer.Channels;
            bool resampled = info.SampleRate != mixRate;
            var pcm = FfmpegPcmStream.Start(path, 0, resampled ? mixRate : 0, mixRate, mixCh, headers, CapacityFor(info, mixRate, mixCh));
            var source = new PcmFloatSource(pcm, mixRate, mixCh) { Gain = _gain, LoudGain = (float)Math.Clamp(loudGain, 0.05, 4.0) };
            if (_eqEnabled) { source.Eq = new EqChain(mixRate, mixCh); source.Eq.Update(_eqGains); }
            AttachVst(source); // VST实验区：效果器链（交叉淡入新源私有实例，与淡出旧源无共享）
            // 音频回调线程只写缓存字段，level 事件由 position 定时器（10Hz）顺带发送
            source.OnLevel += OnLevelSample;

            FfmpegPcmStream? oldPcm;
            lock (_gate)
            {
                if (gen != _playGeneration)
                {
                    try { pcm.Dispose(); } catch { }
                    return new { ok = false, reason = "superseded" };
                }
                oldPcm = _pcm;
                _pcm = pcm; _source = source; _track = info;
                _offsetSec = 0; _decodeRate = mixRate; _ended = false; _headers = headers;
                // V1.1.9：必须恢复 _playing=true——V1.1.9 让 ended 后 mixer 保留，但
                // PlayCrossfade 漏设 _playing，导致：① 新歌播完 TickPosition 的 ended 判定
                // （if (_playing && ...)）永不触发 → 不自动连播；② 反复点击时同一首/同一组歌
                // 被反复播放（长音频自然结束后尤其明显）。OpenWithChannels/TryPlayDop 都有，
                // 唯独此分支遗漏。
                _playing = true;
                ApplyDspLocked();
            }
            mixer.FadeTo(source, _crossfadeSec);
            // V1.1.10：暂停后切歌——设备流已被 Pause SafeStop（句柄保留、流已停），
            // FadeTo 只换 mixer 源不重启设备流 → 无声但 UI 已报 playing（用户实测：
            // 暂停时切歌不播放，按钮却是播放状态，需再点播放键才恢复）。
            // 与 Resume 同机制：Play() 从 Stopped 启动新线程重新 Start，干净恢复。
            // 注意：必须先 FadeTo 再 Play——mixer 是新源唯一消费者，先起流会读旧源。
            if (_streamPaused) { _streamPaused = false; _backend.Play(); }
            // 旧解码进程在淡入完成后释放（淡出期间仍在被读取）
            _ = Task.Run(async () => { await Task.Delay((int)(_crossfadeSec * 1000) + 1500); try { oldPcm?.Dispose(); } catch { } });

            _rpc.Emit("format", new
            {
                sampleRate = mixRate,
                channels = mixCh,
                requestedRate = info.SampleRate,
                resampled,
                codec = info.Codec,
                bitDepth = info.BitDepth,
                backend = _backend.Kind,
                device = _backend.DeviceName,
                outFormat = $"{_backend.ActiveFormat.SampleRate}Hz/{_backend.ActiveFormat.BitsPerSample}bit",
                bitPerfect = !resampled,
                reason = resampled ? $"引擎重采样至 {mixRate}Hz" : "",
                dsdMode = _dsdMode,
                dop = false,
                crossfade = _crossfadeSec
            });
            _rpc.Emit("state", new { state = "playing", path });
            _positionTimer.Change(0, 100);
            return new { ok = true, crossfade = _crossfadeSec };
        }
    }

    private long _lastResumeAt; // V1.1.9：暂停/恢复节流时间戳（TickCount64）

    private object Pause()
    {
        bool doPause = false;
        lock (_gate)
        {
            if (_playing && _backend is not null)
            {
                // V1.1.7：先淡出再停流——瞬间静音会突兀爆音。淡出期间音频线程仍在读取。
                // V1.1.9：不在锁内 Sleep——高频连点暂停时，持锁 Sleep(90ms)+SafeStop Wait 会
                // 让 RPC 线程串行排队，且 SafeStop 的 Stop() 要 Join 音频线程，若音频线程
                // 正阻塞在 Read（队列空/锁竞争）则持锁等待 = 死锁。改为：锁内只标记淡出，
                // 锁外等待淡出完成 + 停流。
                if (_source is not null) _source.BeginFade(0f, FadeMs);
                _pausing = true;
                doPause = true;
            }
        }
        if (doPause)
        {
            Thread.Sleep(FadeMs + 30); // 锁外等待淡出在音频线程完成（~90ms）
            lock (_gate)
            {
                _pausing = false;
                if (_playing) { _backend.Pause(); _playing = false; _streamPaused = true; }
            }
            _rpc.Emit("state", new { state = "paused" });
        }
        return new { ok = true };
    }

    private object Resume()
    {
        lock (_gate)
        {
            if (_pausing) return new { ok = true }; // 淡出未完成时忽略恢复（防连点竞争）
            if (!_playing && _backend is not null && _source is not null)
            {
                // V1.1.9：恢复节流——高频连点暂停/恢复时，两次恢复间至少隔 120ms，
                // 避免反复 Start/Stop 音频线程导致 WASAPI 事件驱动状态竞争（引擎卡死）
                var now = Environment.TickCount64;
                if (_lastResumeAt != 0 && now - _lastResumeAt < 120)
                    return new { ok = true, throttled = true };
                _backend.Play();
                _playing = true;
                _lastResumeAt = now;
                _streamPaused = false;
                // V1.1.7：恢复后淡入（从 0 渐到全增益），避免瞬间音量跳变
                _source.BeginFade(1f, FadeMs);
                _rpc.Emit("state", new { state = "playing" });
            }
        }
        return new { ok = true };
    }

    private object ProbeWithCache(string path)
    {
        if (!Toolchain.FfprobeFound) throw new InvalidOperationException(Toolchain.MissingHint);
        var cached = GetCachedProbe(path);
        if (cached != null) return cached;
        var info = FfmpegPcmStream.Probe(path);
        CacheProbe(path, info);
        return info;
    }

    private object Seek(double seconds)
    {
        string? path; string? headers; TrackInfo? info; double loudGain; string? finalUrl; long finalUrlAt; string? finalUrlPath;
        lock (_gate) { path = _track?.Path; headers = _headers; info = _track; loudGain = _loudGain; finalUrl = _finalUrl; finalUrlAt = _finalUrlAt; finalUrlPath = _finalUrlPath; }
        if (path is null) return new { ok = false, reason = "no-track" };
        // V1.1.4：seek 复用已知格式跳过 ffprobe（网络流探测是耗时大头，会造成数秒 loading
        // 与进度条冻结），并走快速起播（150ms 预缓冲，边播边缓冲）。
        // 网络流优先复用缓存的最终 CDN URL（10 分钟内有效），省 302 重定向往返（实测省 ~1.4s）；
        // 失效时回退原始 URL 重试一次。
        // V1.1.6：_finalUrl 必须属于当前曲目（finalUrlPath == path）——否则切回本地后
        // 残留的流媒体 CDN URL 会被误用，seek 变成重新加载上一首流媒体（bug）。
        bool useFinal = finalUrl != null && finalUrlPath == path
            && Environment.TickCount64 - finalUrlAt < 10 * 60 * 1000L;
        try
        {
            Play(useFinal ? finalUrl! : path, Math.Max(0, seconds), headers, loudGain, knownInfo: info, quickStart: true);
        }
        catch (Exception e) when (useFinal)
        {
            Console.Error.WriteLine($"[engine] 最终URL失效({e.Message})，回退原始URL");
            Play(path, Math.Max(0, seconds), headers, loudGain, knownInfo: info, quickStart: true);
        }
        return new { ok = true };
    }

    /// <summary>异步解析网络流最终重定向 URL（手动跟随 3xx 链；CDN 不支持 HEAD 时回退 Range 0-0 的 GET）。</summary>
    private void TryResolveFinalUrl(string url, string? headers)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                // 注意：HttpClient 自动跟随重定向后 RequestMessage.RequestUri 仍是原始 URL，
                // 必须手动跟随 3xx Location 链才能拿到最终 CDN 地址。
                var final = await ResolveRedirectChain(url, headers, useGet: false)
                    ?? await ResolveRedirectChain(url, headers, useGet: true);
                if (!string.IsNullOrWhiteSpace(final) && final != url)
                {
                    lock (_gate) { _finalUrl = final; _finalUrlPath = url; _finalUrlAt = Environment.TickCount64; }
                    Console.Error.WriteLine($"[engine] 最终URL: {final}");
                }
            }
            catch { }
        });
    }

    private async Task<string?> ResolveRedirectChain(string url, string? headers, bool useGet)
    {
        try
        {
            using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(6) };
            string current = url;
            for (int i = 0; i < 10; i++)
            {
                using var req = new HttpRequestMessage(useGet ? HttpMethod.Get : HttpMethod.Head, current);
                if (useGet) req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 0);
                if (!string.IsNullOrWhiteSpace(headers))
                {
                    foreach (var line in headers.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        var idx = line.IndexOf(':');
                        if (idx > 0) req.Headers.TryAddWithoutValidation(line[..idx].Trim(), line[(idx + 1)..].Trim());
                    }
                }
                using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
                if (resp.StatusCode is System.Net.HttpStatusCode.Moved
                    or System.Net.HttpStatusCode.Redirect
                    or System.Net.HttpStatusCode.RedirectMethod
                    or System.Net.HttpStatusCode.TemporaryRedirect
                    or System.Net.HttpStatusCode.PermanentRedirect)
                {
                    var loc = resp.Headers.Location;
                    if (loc is null) return null;
                    current = new Uri(new Uri(current), loc).ToString();
                    continue;
                }
                // HEAD 不被支持（405/501）时返回 null，由上层回退 GET Range 探测
                if (resp.StatusCode is System.Net.HttpStatusCode.MethodNotAllowed or System.Net.HttpStatusCode.NotImplemented)
                    return null;
                return current;
            }
            return null;
        }
        catch { return null; }
    }

    private object StopRequest()
    {
        Interlocked.Increment(ref _playGeneration); // 使并发 in-flight 的 play 失效
        return StopAll(emitState: true);
    }

    private object StopAll(bool emitState)
    {
        lock (_gate)
        {
            _playing = false;
            _positionTimer.Change(Timeout.Infinite, Timeout.Infinite);
            // 先标记源为不活跃，让音频线程中的 Read() 感知到结束并平稳退出
            try { _source?.Deactivate(); } catch { }
            try { _dopSource?.Deactivate(); } catch { }
            try { _backend?.Stop(); } catch { }
            try { _pcm?.Dispose(); } catch { }
            try { _dsf?.Dispose(); } catch { }
            _pcm = null; _source = null; _track = null; _headers = null;
            _dsf = null; _dopSource = null; _dopActive = false; _mixer = null;
        }
        if (emitState) _rpc.Emit("state", new { state = "stopped" });
        return new { ok = true };
    }

    private void TickPosition()
    {
        double pos;
        double dur;
        bool shouldEnd = false;

        lock (_gate)
        {
            // VST实验区：音频线程置的 Broken 在此（10Hz 定时器线程）转成用户通知，去重
            foreach (var s in _vstSlots)
                if (s.Broken && _vstCrashNotified.Add(s.Id))
                    _rpc.Emit("notify", new { text = s.AutoBypassed
                        ? $"VST 插件「{s.Name}」处理耗时过高，已自动旁通（重新启用可复活）"
                        : $"VST 插件「{s.Name}」处理异常，已自动旁通（重新启用可复活）" });
            if (_track is null) return;
            if (_dopActive && _dopSource is not null)
            {
                // Pro：DoP 位置按封装帧推算（DSD 位流无电平计量）
                pos = _offsetSec + _dopSource.FramesProduced / (double)_dopSource.WaveFormat.SampleRate;
                dur = _track.DurationSec;
                if (_playing && !_ended && pos >= dur - 0.05) { _ended = true; shouldEnd = true; }
            }
            else
            {
                if (_source is null) return;
                pos = _offsetSec + (double)_source.FramesRead / _decodeRate;
                dur = _track.DurationSec;

                // 在锁内完整判断并标记结束，防止与新的 Play 调用产生竞态
                if (_playing && _source.SourceEnded && !_ended)
                {
                    _ended = true;
                    shouldEnd = true;
                }
            }
        }

        _rpc.Emit("position", new { seconds = Math.Round(pos, 3), duration = dur });

        // level 事件随 position 一起发（仅在有更新时），音频回调线程不参与 I/O
        if (_levelDirty)
        {
            _levelDirty = false;
            float rmsL = _levelRmsL, peakL = _levelPeakL, rmsR = _levelRmsR, peakR = _levelPeakR;
            _rpc.Emit("level",
                new { rms = Math.Max(rmsL, rmsR), peak = Math.Max(peakL, peakR), rmsL, peakL, rmsR, peakR });
        }

        if (shouldEnd)
        {
            // 只停止输出设备与定时器，不销毁 pcm/source（留给下一次 Play 的 StopAll 处理）
            // 这样可以避免在新 Play 已启动时误杀其资源
            lock (_gate)
            {
                _playing = false;
                _positionTimer.Change(Timeout.Infinite, Timeout.Infinite);
                // V1.1.9：crossfade 开启且 mixer 存在时，**保持设备流打开**（mixer 输出静音待命）——
                // 旧实现歌曲结束就 _backend.Stop()，下一曲 PlayCrossfade 因 !_playing 回退普通 Play，
                // 触发 StopAll → WASAPI 设备停+开。高频连点+自然结束交替时反复开关设备 = audiodg 假死根因。
                // 现在：设备保持，下一曲 play.crossfade 直接 FadeTo 无缝衔接。
                if (_crossfadeSec <= 0 || _mixer is null || _dopActive)
                    try { _backend?.Stop(); } catch { }
            }
            _rpc.Emit("state", new { state = "ended" });
        }
    }
}
