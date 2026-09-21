using NAudio.Wave;
using NAudio.CoreAudioApi;
using System.Runtime.InteropServices;

namespace MineEngine;

/// <summary>WASAPI 错误翻译：把 HRESULT 变成用户能看懂的中文提示。</summary>
public static class WasapiErrors
{
    public const uint DEVICE_IN_USE = 0x8889000A;        // AUDCLNT_E_DEVICE_IN_USE
    public const uint UNSUPPORTED_FORMAT = 0x88890008;   // AUDCLNT_E_UNSUPPORTED_FORMAT
    public const uint EXCLUSIVE_NOT_ALLOWED = 0x8889000E;
    public const uint INVALID_DEVICE_PERIOD = 0x88890003;
    public const uint E_INVALIDARG = 0x80070057;

    public static bool IsFormatRejection(COMException ce)
        => (uint)ce.HResult is UNSUPPORTED_FORMAT or E_INVALIDARG;

    public static string Translate(COMException ce, string deviceName) => (uint)ce.HResult switch
    {
        DEVICE_IN_USE => $"设备 [{deviceName}] 正被其他程序占用（独占冲突）。请关闭 foobar2000 等其他播放器的独占输出后重试；刚切换设备时系统释放有延迟，等一秒再点播放即可。",
        EXCLUSIVE_NOT_ALLOWED => $"设备 [{deviceName}] 未开启独占权限：设置 → 系统 → 声音 → 更多声音设置 → 播放 → 双击该设备 → 高级，勾选两个「允许应用程序独占控制」。",
        INVALID_DEVICE_PERIOD => $"设备 [{deviceName}] 拒绝了缓冲周期设置。",
        _ => $"WASAPI 错误 0x{(uint)ce.HResult:X8}（设备：{deviceName}）",
    };
}

/// <summary>输出后端统一接口。</summary>
public interface IOutputBackend : IDisposable
{
    string Kind { get; }              // "wasapi" | "asio"
    string DeviceName { get; }
    WaveFormat ActiveFormat { get; }  // 实际打开的格式
    bool Resampled { get; }           // 是否发生了重采样兜底
    int RequestedRate { get; }        // 源文件原生采样率

    /// <summary>
    /// 按 source 的采样率尝试打开设备。
    /// 返回 null = 已打开；返回采样率 = 设备不接受当前采样率，请求引擎以该采样率重采样后重试。
    /// </summary>
    int? TryOpen(IWaveProvider source, int requestedRate, int channels);
    void Play();
    void Pause();
    void Stop();
}

/// <summary>
/// 浮点 PCM 源：从 FfmpegPcmStream 拉块，应用数字增益，做 RMS/Peak 计量。
/// 队列空但流未结束时输出静音（防爆音）；流结束后持续输出静音直到外部 Stop。
/// </summary>
public sealed class PcmFloatSource : IWaveProvider
{
    private readonly FfmpegPcmStream _pcm;
    private byte[]? _current;
    private int _currentOffset;
    private long _framesRead;
    private readonly int _frameBytes;
    private volatile bool _active = true;

    public float Gain = 1.0f;
    /// <summary>Pro：响度归一化增益（线性，由播放方按 ReplayGain/R128 计算后下发）。</summary>
    public float LoudGain = 1.0f;
    /// <summary>Pro：自动前级补偿（线性，= 10^(-max正增益dB/20)，防 EQ 正增益削波）。</summary>
    public float Preamp = 1.0f;
    /// <summary>Pro：输出软限幅器（tanh 软膝，第二道防削波保险）。</summary>
    public bool Limiter = true;
    /// <summary>15 段 EQ 链（EXP 7.28）：null = 直通。由 Engine 在创建源/收到 eq.set 时挂载。</summary>
    public EqChain? Eq;
    /// <summary>VST实验区：本源私有的 VST3 效果器实例链（EQ 之前处理）；null/空 = 直通。</summary>
    public VstFxInstance[]? VstFx;
    public WaveFormat WaveFormat { get; }
    public event Action<float, float, float, float>? OnLevel; // rmsL, peakL, rmsR, peakR
    public long FramesRead => System.Threading.Interlocked.Read(ref _framesRead);
    // 输出健康：短读/欠载与限幅触发计数（音频线程 Interlocked 写，stats RPC 读）
    public long UnderrunCount;
    public long UnderrunFrames;
    public long LimiterClipBlocks;
    public bool SourceEnded => !_active || _pcm.EndOfStream;

    private long _levelAccumFrames;
    private double _levelSumSqL, _levelSumSqR; // 分声道能量（单声道时两路相同）
    private float _levelPeakL, _levelPeakR;
    private int _levelPhase;                   // 跨 Read 调用的声道相位
    private const long LevelWindowFrames = 4096; // 每 4096 帧报一次

    // V1.1.7：增益渐变（播放/暂停淡入淡出）。字段在 RPC 线程写、音频线程读，用锁保护。
    private readonly object _fadeLock = new();
    private float _fadeFrom = 1f;              // 渐变起始增益（线性）
    private float _fadeTo = 1f;                // 渐变目标增益
    private long _fadeTotalFrames;             // 渐变总帧数
    private long _fadeRemainFrames;            // 剩余渐变帧数

    public PcmFloatSource(FfmpegPcmStream pcm, int sampleRate, int channels)
    {
        _pcm = pcm;
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, channels);
        _frameBytes = channels * 4;
    }

    /// <summary>标记源为不活跃，使 SourceEnded 立即返回 true，避免外部线程在已释放的流上继续读取。</summary>
    public void Deactivate()
    {
        _active = false;
        // VST实验区：源退役 → 收编插件状态回槽位并释放原生实例（防每换歌泄漏一份原生资源）
        var fx = VstFx; VstFx = null;
        if (fx is not null) foreach (var inst in fx) { try { inst.Dispose(); } catch { } }
    }

    /// <summary>
    /// V1.1.7：开始增益渐变（to=0 淡出，to=1 淡入）。音频线程在 Read 中逐帧线性插值，
    /// 无爆音。淡出必须等待其完成后再暂停设备（Pause 后音频线程不再读）。
    /// </summary>
    public void BeginFade(float to, int ms)
    {
        lock (_fadeLock)
        {
            _fadeFrom = _fadeTo; // 从当前目标继续（避免跳变）
            _fadeTo = to;
            _fadeTotalFrames = Math.Max(1, (long)(WaveFormat.SampleRate * ms / 1000.0));
            _fadeRemainFrames = _fadeTotalFrames;
        }
    }

    /// <summary>net9 目标要求 IWaveProvider 的 Span 重载：委托给字节数组版本（调用方是 NAudio 内部辅助路径，非音频热路径）。</summary>
    public int Read(Span<byte> buffer)
    {
        var tmp = new byte[buffer.Length];
        int n = Read(tmp, 0, tmp.Length);
        tmp.AsSpan(0, n).CopyTo(buffer);
        return n;
    }

    public int Read(byte[] buffer, int offset, int count)
    {
        // 如果源已被标记为不活跃，直接输出静音，避免访问已释放的流
        if (!_active)
        {
            Array.Clear(buffer, offset, count);
            return count;
        }

        int written = 0;

        while (written < count)
        {
            if (_current is null || _currentOffset >= _current.Length)
            {
                _current = _pcm.Take(50);
                _currentOffset = 0;
                if (_current is null)
                {
                    if (_pcm.EndOfStream || _pcm.Failed) break; // 真结束：补静音到 count
                    continue;                                     // 暂时无数据：补静音（欠载保护）
                }
            }
            int avail = _current.Length - _currentOffset;
            int want = count - written;
            int n = Math.Min(avail, want);
            Buffer.BlockCopy(_current, _currentOffset, buffer, offset + written, n);
            _currentOffset += n;
            written += n;
        }

        // 不足部分填静音
        if (written < count)
        {
            Array.Clear(buffer, offset + written, count - written);
            if (!_pcm.EndOfStream && !_pcm.Failed)
            {
                System.Threading.Interlocked.Increment(ref UnderrunCount);
                System.Threading.Interlocked.Add(ref UnderrunFrames, (count - written) / _frameBytes);
            }
        }

        // EQ → 增益（音量×响度×前级补偿）→ 软限幅 → 分声道计量（float 域；ch0→L，其余→R）
        // V1.1.5：位置只计实际解码出的数据帧（written），静音填充帧（欠载/seek 预缓冲不足时
        // 输出静音）不计——否则 quickStart 起播阶段进度条会跑在声音前面。
        int frames = written / _frameBytes;
        int chs = WaveFormat.Channels;
        var eq = Eq;
        float totalGain = Gain * LoudGain * Preamp;
        bool limiter = Limiter;
        bool clipBlock = false;
        float sumSqL = 0f, sumSqR = 0f, peakL = 0f, peakR = 0f;
        int phase = _levelPhase;
        // V1.1.7：淡入淡出快照（音频线程与 RPC 线程共享，锁内取快照避免撕裂）
        float fadeFrom = 1f, fadeTo = 1f; long fadeRemain = 0, fadeTotal = 1;
        bool fading;
        lock (_fadeLock) { fading = _fadeRemainFrames > 0; if (fading) { fadeFrom = _fadeFrom; fadeTo = _fadeTo; fadeRemain = _fadeRemainFrames; fadeTotal = _fadeTotalFrames; } }
        unsafe
        {
            fixed (byte* p = buffer)
            {
                float* f = (float*)(p + offset);
                // VST实验区：效果器链在 EQ 之前处理（块级、逐槽独立实例；崩溃/高负载自动旁通）
                var vst = VstFx;
                if (vst is not null && vst.Length > 0 && frames > 0)
                {
                    var block = new Span<float>(f, frames * chs);
                    float rampFrames = Math.Max(1f, WaveFormat.SampleRate * 0.020f); // 20ms 旁通/生效斜坡
                    long blockUs = Math.Max(1, (long)Math.Round(frames * 1_000_000.0 / WaveFormat.SampleRate));
                    foreach (var inst in vst)
                    {
                        var slot = inst.Slot;
                        float target = (slot.Enabled && !slot.Broken && !slot.EditorOpen) ? 1f : 0f;
                        float wet0 = inst.Wet;
                        float maxDelta = frames / rampFrames;
                        float wet1 = wet0 + Math.Clamp(target - wet0, -maxDelta, maxDelta);
                        if (wet1 <= 0.0005f && target <= 0f) { inst.Wet = 0f; continue; } // 已完全旁通：不处理，省 CPU
                        try
                        {
                            if (inst.Scratch is null || inst.Scratch.Length < block.Length) inst.Scratch = new float[block.Length];
                            block.CopyTo(inst.Scratch); // dry（Process 输出仍写回 block）
                            long t0 = System.Diagnostics.Stopwatch.GetTimestamp();
                            inst.Plugin.Process(inst.Scratch.AsSpan(0, block.Length), block, frames);
                            long us = (long)Math.Round((System.Diagnostics.Stopwatch.GetTimestamp() - t0) * 1_000_000.0 / System.Diagnostics.Stopwatch.Frequency);
                            System.Threading.Interlocked.Increment(ref slot.PerfCalls);
                            System.Threading.Interlocked.Exchange(ref slot.PerfLastUs, us);
                            long ema = System.Threading.Interlocked.Read(ref slot.PerfEmaUs);
                            System.Threading.Interlocked.Exchange(ref slot.PerfEmaUs, ema <= 0 ? us : (ema * 7 + us) / 8);
                            long slowUs = Math.Max(3000, (long)Math.Round(blockUs * 0.65));
                            if (us > slowUs)
                            {
                                int streak = System.Threading.Interlocked.Increment(ref slot.PerfSlowStreak);
                                long nowMs = Environment.TickCount64;
                                if (streak >= 8 && nowMs >= System.Threading.Interlocked.Read(ref slot.PerfCooldownUntilMs))
                                {
                                    slot.AutoBypassed = true; slot.Broken = true; wet1 = 0f;
                                    System.Threading.Interlocked.Exchange(ref slot.PerfCooldownUntilMs, nowMs + 5000);
                                }
                            }
                            else System.Threading.Interlocked.Exchange(ref slot.PerfSlowStreak, 0);
                            if (wet0 < 0.999f || wet1 < 0.999f)
                            {
                                int n = block.Length;
                                for (int i = 0; i < n; i++)
                                {
                                    float w = wet0 + (wet1 - wet0) * (i / (float)Math.Max(1, n - 1));
                                    block[i] = inst.Scratch[i] * (1f - w) + block[i] * w;
                                }
                            }
                            inst.Wet = wet1;
                        }
                        catch
                        {
                            try { inst.Scratch?.AsSpan(0, block.Length).CopyTo(block); } catch { } // 异常块回滚成干声，避免半截湿声咔哒
                            slot.AutoBypassed = false; slot.Broken = true; inst.Wet = 0f; // 护栏：异常即旁通，引擎侧稍后发通知
                        }
                    }
                }
                if (eq is not null)
                    for (int fr = 0; fr < frames; fr++) eq.ProcessFrame(f + fr * chs);
                for (int i = 0; i < count / 4; i++)
                {
                    float g = totalGain;
                    if (fading)
                    {
                        // 逐样本线性插值：本块起点进度 = (total-remain)/total，每样本推进 1/total
                        float t = Math.Min(1f, (float)(fadeTotal - fadeRemain) / fadeTotal + (float)i / fadeTotal);
                        g *= fadeFrom + (fadeTo - fadeFrom) * t;
                    }
                    float v = f[i] * g;
                    // Pro：软限幅器（tanh 软膝，|v|≤1 时近似线性，超限平滑压缩到 ±1 内）
                    if (limiter && (v > 1f || v < -1f)) { clipBlock = true; v = (float)Math.Tanh(v); }
                    f[i] = v;
                    float a = Math.Abs(v);
                    if (phase == 0) { sumSqL += v * v; if (a > peakL) peakL = a; }
                    else { sumSqR += v * v; if (a > peakR) peakR = a; }
                    if (++phase >= chs) phase = 0;
                }
            }
        }
        _levelPhase = phase;
        if (clipBlock) System.Threading.Interlocked.Increment(ref LimiterClipBlocks);
        System.Threading.Interlocked.Add(ref _framesRead, frames);
        // V1.1.7：消耗本块的渐变帧数（本块样本数 = count/4）
        if (fading)
        {
            lock (_fadeLock)
            {
                _fadeRemainFrames -= count / 4;
                if (_fadeRemainFrames <= 0) { _fadeRemainFrames = 0; _fadeFrom = _fadeTo; }
            }
        }

        _levelSumSqL += sumSqL; _levelSumSqR += sumSqR;
        if (peakL > _levelPeakL) _levelPeakL = peakL;
        if (peakR > _levelPeakR) _levelPeakR = peakR;
        _levelAccumFrames += frames;
        if (_levelAccumFrames >= LevelWindowFrames)
        {
            long fr = _levelAccumFrames;
            float rmsL = fr > 0 ? (float)Math.Sqrt(_levelSumSqL / fr) : 0f;
            float rmsR = fr > 0 ? (float)Math.Sqrt(_levelSumSqR / fr) : 0f;
            OnLevel?.Invoke(rmsL, _levelPeakL, rmsR, _levelPeakR);
            _levelSumSqL = 0; _levelSumSqR = 0; _levelPeakL = 0; _levelPeakR = 0; _levelAccumFrames = 0;
        }
        return count;
    }
}

/// <summary>float32 → 整数 PCM 转换器（16/24/32bit）。</summary>
public sealed class IntPcmConverter : IWaveProvider
{
    private readonly IWaveProvider _floatSource;
    private readonly int _bytesPerSample;
    private byte[] _floatBuf = new byte[1 << 14];

    public WaveFormat WaveFormat { get; }

    public IntPcmConverter(IWaveProvider floatSource, int targetBits)
    {
        _floatSource = floatSource;
        _bytesPerSample = targetBits / 8;
        WaveFormat = new WaveFormat(floatSource.WaveFormat.SampleRate, targetBits, floatSource.WaveFormat.Channels);
    }

    public int Read(Span<byte> buffer)
    {
        var tmp = new byte[buffer.Length];
        int n = Read(tmp, 0, tmp.Length);
        tmp.AsSpan(0, n).CopyTo(buffer);
        return n;
    }

    public int Read(byte[] buffer, int offset, int count)
    {
        int floatBytesNeeded = count / _bytesPerSample * 4;
        if (_floatBuf.Length < floatBytesNeeded) _floatBuf = new byte[floatBytesNeeded];
        int read = _floatSource.Read(_floatBuf.AsSpan(0, floatBytesNeeded)); // net9：IWaveProvider 仅 Span 重载
        int samples = read / 4;
        int outBytes = samples * _bytesPerSample;

        for (int i = 0; i < samples; i++)
        {
            float v = BitConverter.ToSingle(_floatBuf, i * 4);
            v = Math.Clamp(v, -1f, 1f);
            int o = offset + i * _bytesPerSample;
            switch (_bytesPerSample)
            {
                case 2:
                    short s16 = (short)Math.Round(v * 32767f);
                    buffer[o] = (byte)(s16 & 0xFF);
                    buffer[o + 1] = (byte)((s16 >> 8) & 0xFF);
                    break;
                case 3:
                    int s24 = (int)Math.Round(v * 8388607f);
                    buffer[o] = (byte)(s24 & 0xFF);
                    buffer[o + 1] = (byte)((s24 >> 8) & 0xFF);
                    buffer[o + 2] = (byte)((s24 >> 16) & 0xFF);
                    break;
                case 4:
                    int s32 = (int)Math.Round(v * 2147483647.0);
                    buffer[o] = (byte)(s32 & 0xFF);
                    buffer[o + 1] = (byte)((s32 >> 8) & 0xFF);
                    buffer[o + 2] = (byte)((s32 >> 16) & 0xFF);
                    buffer[o + 3] = (byte)((s32 >> 24) & 0xFF);
                    break;
            }
        }
        return outBytes;
    }
}

/// <summary>WASAPI 输出（独占或共享）。独占：格式尝试顺序原生率 24/16/32bit，失败返回候选采样率重采样；
/// 共享：系统混音器统一格式，直接按请求率打开（设备自动重采样），不切设备、不冲突。</summary>
public sealed class WasapiExclusiveBackend : IOutputBackend
{
    private static readonly int[] FallbackRates = { 384000, 352800, 192000, 176400, 96000, 88200, 48000, 44100 };

    private readonly MMDevice _device;
    private readonly AudioClientShareMode _shareMode; // V1.1.9：Exclusive（默认）| Shared
    private WasapiOut? _out;
    private IWaveProvider? _source;

    public string Kind => "wasapi";
    public string DeviceName { get; }
    public WaveFormat ActiveFormat { get; private set; } = new WaveFormat(44100, 16, 2);
    public bool Resampled { get; private set; }
    public int RequestedRate { get; private set; }
    /// <summary>Pro：独占缓冲长度（ms，50–500，默认 50，由 buffer.set 配置）。</summary>
    public int BufferMs = 50;
    /// <summary>V1.1.9：是否独占模式（false = 共享，系统混音器自动重采样）。</summary>
    public bool IsExclusive => _shareMode == AudioClientShareMode.Exclusive;

    public WasapiExclusiveBackend(MMDevice device, bool exclusive = true)
    {
        _device = device;
        _shareMode = exclusive ? AudioClientShareMode.Exclusive : AudioClientShareMode.Shared;
        DeviceName = device.FriendlyName;
    }

    public static List<(string Id, string Name)> Enumerate()
    {
        using var en = new MMDeviceEnumerator();
        return en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
            .Select(d => (d.ID, d.FriendlyName)).ToList();
    }

    public static MMDevice GetDefault()
    {
        using var en = new MMDeviceEnumerator();
        return en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
    }

    public static MMDevice? FindById(string id)
    {
        using var en = new MMDeviceEnumerator();
        return en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
            .FirstOrDefault(d => d.ID == id);
    }

    private bool SupportsExclusive(WaveFormat fmt)
    {
        try { return _device.AudioClient.IsFormatSupported(AudioClientShareMode.Exclusive, fmt, out _); }
        catch (Exception ex)
        {
            // 诊断：探测失败时记录真实原因（格式拒绝以外的错误会伪装成"不支持"）
            Console.Error.WriteLine($"[wasapi] 探测 {fmt.SampleRate}Hz/{fmt.BitsPerSample}bit/{fmt.Channels}ch 异常: 0x{(ex is COMException ce ? (uint)ce.HResult : 0xFFFFFFFF):X8} {ex.Message.Split('\n')[0]}");
            return false;
        }
    }

    public int? TryOpen(IWaveProvider source, int requestedRate, int channels)
    {
        _source = source;
        RequestedRate = requestedRate;

        // V1.1.9：共享模式——系统混音器统一格式，直接按请求率打开（设备侧自动重采样），
        // 永不返回重采样请求、不切设备、不与其他程序冲突。
        if (_shareMode == AudioClientShareMode.Shared)
        {
            foreach (int bits in new[] { 24, 16, 32 })
            {
                var fmt = bits == 32
                    ? WaveFormat.CreateIeeeFloatWaveFormat(requestedRate, channels)
                    : new WaveFormat(requestedRate, bits, channels);
                try
                {
                    StartOut(source, fmt, bits);
                    Resampled = false;
                    return null;
                }
                catch (COMException) { continue; } // 该位深不被混音器接受，试下一种
            }
            throw new InvalidOperationException($"设备 [{DeviceName}] 共享模式不接受任何常见格式。");
        }

        // 1) 独占：原生采样率，按位深优先级尝试
        // V1.1.4：24bit 优先（用户要求默认 24bit——bit-perfect 输出精度；白噪时改回 16bit 优先）
        foreach (int bits in new[] { 24, 16, 32 })
        {
            var fmt = bits == 32
                ? WaveFormat.CreateIeeeFloatWaveFormat(requestedRate, channels)
                : new WaveFormat(requestedRate, bits, channels);
            if (!SupportsExclusive(fmt)) continue;
            try
            {
                StartOut(source, fmt, bits);
                Resampled = false;
                return null;
            }
            catch (COMException) { continue; } // 罕见的"探测通过但初始化拒绝格式"：试下一种位深
            // 设备占用/权限等致命错误已在 StartOut 内翻译成中文并抛出
        }

        // 2) 原生率全部不支持 → 找一个设备支持的候选采样率，交给引擎重采样
        foreach (int rate in FallbackRates.Where(r => r != requestedRate))
        {
            foreach (int bits in new[] { 24, 16, 32 })
            {
                var fmt = bits == 32
                    ? WaveFormat.CreateIeeeFloatWaveFormat(rate, channels)
                    : new WaveFormat(rate, bits, channels);
                if (!SupportsExclusive(fmt)) continue;
                Resampled = true;
                return rate;
            }
        }
        throw new InvalidOperationException($"设备 [{DeviceName}] 独占模式下不接受任何常见格式。");
    }

    private void StartOut(IWaveProvider source, WaveFormat fmt, int bits)
    {
        IWaveProvider provider = bits == 32 ? source : new IntPcmConverter(source, bits);
        // 设备占用（0x8889000A）有瞬时性：切换设备后系统释放有延迟，重试 3 次
        for (int attempt = 1; ; attempt++)
        {
            try
            {
                _out = new WasapiOut(_device, _shareMode, true, Math.Clamp(BufferMs, 50, 500));
                _out.Init(provider);
                ActiveFormat = fmt;
                return;
            }
            catch (COMException ce)
            {
                try { _out?.Dispose(); } catch { }
                _out = null;
                if ((uint)ce.HResult == WasapiErrors.DEVICE_IN_USE && attempt < 4)
                {
                    Thread.Sleep(350);
                    continue;
                }
                if (WasapiErrors.IsFormatRejection(ce)) throw; // 交给上层换格式
                throw new InvalidOperationException(WasapiErrors.Translate(ce, DeviceName));
            }
        }
    }

    public void Play() => _out?.Play();
    // V1.1.8：暂停 = 干净停流（WasapiOut.Stop：停音频线程 + audioClient.Stop）但**不释放设备句柄**。
    // 真 Pause()（只置状态）在 WASAPI 独占+事件驱动下会导致：缓冲不被填充 → 硬件持续消费 → 下溢
    // → 事件流错乱，恢复后音频卡顿（只有重新起流才恢复，用户实测）。Stop 保留设备独占锁，
    // 不触发设备开关（音频服务安全），Resume 时 Play() 从 Stopped 启动新线程重新 Start，干净恢复。
    public void Pause() => SafeStop(_out, dispose: false);
    public void Stop() { var o = _out; _out = null; SafeStop(o, dispose: true); }
    public void Dispose() => Stop();

    /// <summary>
    /// 防死锁停止：NAudio WasapiOut（Exclusive + 事件驱动）的 Stop 会同步等待音频线程退出。
    /// 音频线程偶发退出/卡死时，该等待会永久阻塞调用线程——而 Stop 在引擎 RPC 线程上执行
    /// （Play 的 StopAll / pause / stop 请求），一旦卡死整个引擎无响应。
    /// 此处给等待加超时：正常停止毫秒级返回；故障时放弃实例，由后续 Play 重新创建。
    /// </summary>
    private static void SafeStop(WasapiOut? out_, bool dispose)
    {
        if (out_ is null) return;
        try
        {
            // 快速路径：设备已停止（重复 stop / 快速连点切歌）→ 直接释放，
            // 避免每次 Task.Run 调度开销（实测 ~80ms/次，快速连点会堆积成卡顿）
            if (out_.PlaybackState == PlaybackState.Stopped)
            {
                if (dispose) { try { out_.Dispose(); } catch { } }
                return;
            }
            var done = Task.Run(() => { try { out_.Stop(); } catch { } });
            if (!done.Wait(1500))
            {
                Console.Error.WriteLine("[wasapi] Stop 超时（音频线程无响应），后台 Dispose 兜底");
                // V1.1.5：旧实现直接放弃实例——僵尸 WasapiOut 永久持有 WASAPI 独占锁，
                // 后续 Play 一直 DEVICE_IN_USE（重试 3.6s），并最终拖垮 audiodg。
                // 现在交给后台线程继续等 + Dispose：不阻塞 RPC 线程，且最终释放设备句柄。
                if (dispose) _ = Task.Run(() => { try { out_.Dispose(); } catch { } });
                return;
            }
            if (dispose) { try { out_.Dispose(); } catch { } }
        }
        catch { }
    }

    /// <summary>Pro：探测设备是否支持 DoP 所需 PCM 封装率（DSD 位率/16，24bit 立体声独占）。</summary>
    public bool SupportsDop(int dsdRate)
    {
        int pcmRate = dsdRate / 16;
        if (pcmRate <= 0) return false;
        try { return _device.AudioClient.IsFormatSupported(AudioClientShareMode.Exclusive, new WaveFormat(pcmRate, 24, 2), out _); }
        catch { return false; }
    }

    /// <summary>Pro：以 DoP 方式打开输出（24bit PCM 直通，DSD 位流不经任何 DSP/增益）。</summary>
    public bool TryOpenDop(DopSource src)
    {
        var fmt = src.WaveFormat;
        if (!SupportsExclusive(fmt)) return false;
        _out = new WasapiOut(_device, AudioClientShareMode.Exclusive, true, Math.Clamp(BufferMs, 50, 500));
        _out.Init(src);
        ActiveFormat = fmt;
        RequestedRate = fmt.SampleRate;
        Resampled = false;
        return true;
    }
}

/// <summary>
/// ASIO 专用 STA 调度线程：NAudio 的 ASIO COM 互操作强制要求调用发生在 STA 线程，
/// 而引擎的 RPC 请求处理运行在线程池（MTA）线程上。
/// 这里用一个常驻 STA 线程串行执行所有 ASIO 操作，既满足单元状态要求，又天然保证操作顺序。
/// </summary>
internal static class AsioSta
{
    private sealed class WorkItem
    {
        public required Func<object?> Work;
        public required TaskCompletionSource<object?> Done;
    }

    private static readonly System.Collections.Concurrent.BlockingCollection<WorkItem> _queue = new();
    private static readonly Thread _thread;

    static AsioSta()
    {
        _thread = new Thread(() =>
        {
            foreach (var item in _queue.GetConsumingEnumerable())
            {
                try { item.Done.SetResult(item.Work()); }
                catch (Exception ex) { item.Done.SetException(ex); }
            }
        })
        {
            IsBackground = true,
            Name = "AsioStaThread"
        };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
    }

    public static T Invoke<T>(Func<T> work)
    {
        // 已在 STA 线程上（理论上不会发生，防御性处理）：直接执行，避免自死锁
        if (Thread.CurrentThread == _thread) return work();
        var done = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _queue.Add(new WorkItem { Work = () => work(), Done = done });
        return (T)done.Task.GetAwaiter().GetResult()!;
    }

    public static void Invoke(Action work)
        => Invoke<object?>(() => { work(); return null; });
}

/// <summary>
/// ASIO 输出。ASIO 采样率是驱动全局设置，打开流不会自动切换：
/// 先通过底层 AsioDriver 探测并尝试 SetSampleRate 对齐源文件采样率，
/// 驱动拒绝则返回驱动当前采样率，交给引擎重采样。
/// 注意：所有 NAudio ASIO 调用都必须经过 AsioSta 调度到 STA 线程执行。
/// </summary>
public sealed class AsioBackend : IOutputBackend
{
    private AsioOut? _asio;
    private readonly string _driverName;

    public string Kind => "asio";
    public string DeviceName => _driverName;
    public WaveFormat ActiveFormat { get; private set; } = new WaveFormat(44100, 16, 2);
    public bool Resampled { get; private set; }
    public int RequestedRate { get; private set; }

    public AsioBackend(string driverName) { _driverName = driverName; }

    public static string[] Enumerate()
    {
        try { return AsioSta.Invoke(() => AsioOut.GetDriverNames()); } catch { return Array.Empty<string>(); }
    }

    /// <summary>探测并对齐驱动采样率（STA 线程入口）；返回对齐后的实际采样率（0 = 探测失败，交给上层决策）。</summary>
    private int ProbeAndAlignRate(int requestedRate)
        => AsioSta.Invoke(() => ProbeAndAlignRateCore(requestedRate));

    private int ProbeAndAlignRateCore(int requestedRate)
    {
        NAudio.Wave.Asio.AsioDriver? drv = null;
        try
        {
            drv = NAudio.Wave.Asio.AsioDriver.GetAsioDriverByName(_driverName);
            double current = drv.GetSampleRate();
            int currentInt = (int)Math.Round(current);

            Console.Error.WriteLine($"[asio] 驱动 [{_driverName}] 当前采样率: {currentInt}Hz, 请求: {requestedRate}Hz");

            if (currentInt == requestedRate) return requestedRate;

            if (drv.CanSampleRate(requestedRate))
            {
                try
                {
                    drv.SetSampleRate(requestedRate);
                    // 给驱动留出切换生效时间
                    Thread.Sleep(100);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[asio] SetSampleRate({requestedRate}) 失败: {ex.Message}");
                }
                double now = drv.GetSampleRate();
                int nowInt = (int)Math.Round(now);
                Console.Error.WriteLine($"[asio] SetSampleRate 后实际采样率: {nowInt}Hz");
                if (nowInt == requestedRate) return requestedRate;
                return nowInt > 0 ? nowInt : currentInt;
            }

            Console.Error.WriteLine($"[asio] 驱动不支持 {requestedRate}Hz 采样率，维持当前 {currentInt}Hz");
            return currentInt;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[asio] 采样率探测失败: " + ex.Message);
            return 0;
        }
        finally
        {
            try { drv?.ReleaseComAsioDriver(); } catch { }
            // 低层驱动释放后稍作等待，避免 AsioOut 后续初始化时驱动尚未完全复位
            if (drv != null) Thread.Sleep(80);
        }
    }

    public int? TryOpen(IWaveProvider source, int requestedRate, int channels)
        => AsioSta.Invoke(() => TryOpenCore(source, requestedRate, channels));

    private int? TryOpenCore(IWaveProvider source, int requestedRate, int channels)
    {
        RequestedRate = requestedRate;
        Resampled = false;

        // 清理上一次可能残留的实例
        try { _asio?.Dispose(); } catch { }
        _asio = null;

        int aligned = ProbeAndAlignRateCore(requestedRate);
        if (aligned > 0 && aligned != requestedRate)
        {
            Resampled = true;
            return aligned; // 驱动不接受源采样率 → 请求重采样
        }

        if (aligned <= 0)
        {
            Console.Error.WriteLine($"[asio] 采样率探测返回 0，将以 {requestedRate}Hz 直接尝试打开。");
        }

        // 创建 AsioOut 实例
        try
        {
            _asio = new AsioOut(_driverName);
        }
        catch (Exception ex)
        {
            _asio = null;
            throw new InvalidOperationException(
                $"ASIO 驱动 [{_driverName}] 初始化失败: {ex.Message}。请确认驱动已正确安装且未被其他程序独占占用。");
        }

        // 验证采样率支持
        if (!_asio.IsSampleRateSupported(requestedRate))
        {
            _asio.Dispose(); _asio = null;
            throw new InvalidOperationException(
                $"ASIO 驱动 [{_driverName}] 不支持 {requestedRate}Hz 采样率。" +
                (aligned > 0 ? $" 驱动当前为 {aligned}Hz，请打开驱动控制面板手动切换或调整源文件。" : " 请打开驱动控制面板手动设置采样率。"));
        }

        // ASIO 驱动位深各异：优先 float32（直通无损），失败回退 int16
        Exception? float32Error = null;
        try
        {
            _asio.Init(source);
            ActiveFormat = source.WaveFormat;
            Console.Error.WriteLine($"[asio] 已以 float32 格式成功初始化 {_driverName}");
            return null;
        }
        catch (Exception ex)
        {
            float32Error = ex;
            Console.Error.WriteLine($"[asio] float32 Init 失败 ({ex.Message})，回退 int16...");
        }

        // 清理失败的 float32 实例，重建后以 int16 重试
        try { _asio.Dispose(); } catch { }
        _asio = null;

        try
        {
            _asio = new AsioOut(_driverName);
            var converter = new IntPcmConverter(source, 16);
            _asio.Init(converter);
            ActiveFormat = new WaveFormat(requestedRate, 16, channels);
            Console.Error.WriteLine($"[asio] 已以 int16 格式成功初始化 {_driverName}");
            return null;
        }
        catch (Exception ex2)
        {
            try { _asio?.Dispose(); } catch { }
            _asio = null;
            throw new InvalidOperationException(
                $"ASIO 驱动 [{_driverName}] 音频流初始化全部失败。" +
                $" Float32: {float32Error?.Message}; Int16: {ex2.Message}。" +
                $" 请检查驱动控制面板中的缓冲区大小和通道配置。");
        }
    }

    public void ShowControlPanel() { try { AsioSta.Invoke(() => _asio?.ShowControlPanel()); } catch { } }

    public void Play() => AsioSta.Invoke(() => _asio?.Play());
    public void Pause() => AsioSta.Invoke(() => _asio?.Stop());
    public void Stop() => AsioSta.Invoke(() =>
    {
        try { _asio?.Stop(); } catch { }
        try { _asio?.Dispose(); } catch { }
        _asio = null;
    });
    public void Dispose() => Stop();
}
