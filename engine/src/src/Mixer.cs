using NAudio.Wave;

namespace MineEngine;

/// <summary>
/// 交叉淡入混音器（Pro beat0.0.1）：双槽（当前/下一曲）float 域混音。
/// 输出设备保持打开，切歌在同一输出流内完成淡入淡出（独占模式不断流）。
/// 两路输入采样率/声道必须一致（上层用 ffmpeg 解码端重采样对齐）。
/// </summary>
public sealed class CrossfadeMixer : IWaveProvider
{
    private readonly object _gate = new();
    private PcmFloatSource? _cur;
    private PcmFloatSource? _next;
    private int _fadeRemain;   // 剩余淡入帧
    private int _fadeTotal;
    private byte[] _mixBuf = new byte[1 << 16];

    public WaveFormat WaveFormat { get; }
    public int Channels => WaveFormat.Channels;

    public CrossfadeMixer(int sampleRate, int channels)
    {
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, channels);
    }

    /// <summary>当前生效源（淡入完成后为下一曲）。</summary>
    public PcmFloatSource? Current { get { lock (_gate) return _next is null ? _cur : _next; } }
    public bool Crossfading { get { lock (_gate) return _next is not null; } }

    /// <summary>首个源（无淡入直接挂载）。V1.1.4：释放旧源（Deactivate），防止旧 ffmpeg 后台残留导致串音/泄漏。</summary>
    public void SetInitial(PcmFloatSource s)
    {
        lock (_gate)
        {
            try { _cur?.Deactivate(); } catch { }
            try { _next?.Deactivate(); } catch { }
            _cur = s; _next = null; _fadeRemain = 0;
        }
    }

    /// <summary>淡入切换到新源：旧源线性淡出、新源线性淡入，时长 fadeSec 秒。</summary>
    public void FadeTo(PcmFloatSource s, double fadeSec)
    {
        lock (_gate)
        {
            if (_next is not null) { _next.Deactivate(); _cur = _next; } // 打断上一段淡入：以新源为基准
            _next = s;
            _fadeTotal = _fadeRemain = Math.Max(1, (int)(WaveFormat.SampleRate * fadeSec));
        }
    }

    public int Read(byte[] buffer, int offset, int count)
    {
        PcmFloatSource? cur, next;
        int remain, total;
        lock (_gate) { cur = _cur; next = _next; remain = _fadeRemain; total = _fadeTotal; }

        if (cur is null && next is null) { Array.Clear(buffer, offset, count); return count; }

        if (next is null)
        {
            int n = cur!.Read(buffer, offset, count);
            if (n < count) Array.Clear(buffer, offset + n, count - n);
            return count;
        }

        // 双路混音：cur 淡出 + next 淡入
        if (_mixBuf.Length < count) _mixBuf = new byte[count];
        cur?.Read(buffer, offset, count);
        next.Read(_mixBuf, 0, count);

        int frames = count / (WaveFormat.Channels * 4);
        int done = total - remain;
        unsafe
        {
            fixed (byte* pa = buffer, pb = _mixBuf)
            {
                float* a = (float*)(pa + offset);
                float* b = (float*)pb;
                int idx = 0;
                for (int f = 0; f < frames; f++)
                {
                    float t = Math.Min(1f, (float)(done + f) / total); // 0→1
                    float gN = t, gC = 1f - t;
                    for (int ch = 0; ch < WaveFormat.Channels; ch++)
                    {
                        a[idx] = a[idx] * gC + b[idx] * gN;
                        idx++;
                    }
                }
            }
        }

        lock (_gate)
        {
            _fadeRemain -= frames;
            if (_fadeRemain <= 0 && _next is not null)
            {
                try { _cur?.Deactivate(); } catch { }
                _cur = _next; _next = null; _fadeRemain = 0;
            }
        }
        return count;
    }
}
