namespace MineEngine;

/// <summary>
/// 参量均衡器 PEQ（V3.5.19）：自由频段 peaking biquad 链（RBJ Audio-EQ-Cookbook），
/// 与 15 段图示 EQ 串联（PEQ 在图示 EQ 之后处理）。频段 0–12 个，频率/增益/Q 全自定义，
/// 面向耳机校准（如 AutoEq 方案导入）。系数快照整体引用替换，音频线程无锁。
/// </summary>
public sealed class PeqChain
{
    public const int MaxBands = 12;

    /// <summary>单段参数：频率 Hz（20–20000）、增益 dB（±24）、Q（0.3–12）。</summary>
    public readonly struct Band
    {
        public readonly double Freq, GainDb, Q;
        public Band(double f, double g, double q)
        {
            Freq = Math.Clamp(f, 20.0, 20000.0);
            GainDb = Math.Clamp(g, -24.0, 24.0);
            Q = Math.Clamp(q, 0.3, 12.0);
        }
    }

    private struct BandCoeffs { public double B0, B1, B2, A1, A2; public bool Active; }

    private sealed class CoeffSet
    {
        public BandCoeffs[] Bands = Array.Empty<BandCoeffs>();
        public bool AnyActive;
    }

    private volatile CoeffSet _coeffs = new();
    private double[,,] _z; // [band, channel, 4]，仅音频线程访问；频段数变化时重建
    private readonly int _channels;

    public PeqChain(int sampleRate, int channels)
    {
        _channels = channels;
        SampleRate = sampleRate;
        _z = new double[0, channels, 4];
    }

    public int SampleRate { get; }

    /// <summary>更新频段参数。新系数原子替换；滤波状态数组随频段数变化重建（轻微状态清零可接受）。</summary>
    public void Update(IReadOnlyList<Band> bands)
    {
        int n = Math.Min(bands.Count, MaxBands);
        var set = new CoeffSet();
        var arr = new BandCoeffs[n];
        for (int b = 0; b < n; b++)
        {
            var band = bands[b];
            double freq = Math.Min(band.Freq, SampleRate * 0.45); // 奈奎斯特保护
            if (Math.Abs(band.GainDb) > 0.01) set.AnyActive = true;
            double a = Math.Pow(10.0, band.GainDb / 40.0);
            double w0 = 2.0 * Math.PI * freq / SampleRate;
            double cosW0 = Math.Cos(w0);
            double alpha = Math.Sin(w0) / (2.0 * band.Q);
            double a0 = 1.0 + alpha / a;
            arr[b] = new BandCoeffs
            {
                B0 = (1.0 + alpha * a) / a0,
                B1 = (-2.0 * cosW0) / a0,
                B2 = (1.0 - alpha * a) / a0,
                A1 = (-2.0 * cosW0) / a0,
                A2 = (1.0 - alpha / a) / a0,
                Active = Math.Abs(band.GainDb) > 0.01,
            };
        }
        set.Bands = arr;
        _coeffs = set;
        if (_z.GetLength(0) != n) _z = new double[n, _channels, 4];
    }

    /// <summary>对一帧（channels 个 float 样本）应用滤波链。仅音频线程调用。</summary>
    public unsafe void ProcessFrame(float* frame)
    {
        var c = _coeffs;
        if (!c.AnyActive) return;
        var bands = c.Bands;
        for (int b = 0; b < bands.Length; b++)
        {
            ref var k = ref bands[b];
            if (!k.Active) continue;
            for (int ch = 0; ch < _channels; ch++)
            {
                double x = frame[ch];
                double y = k.B0 * x + k.B1 * _z[b, ch, 0] + k.B2 * _z[b, ch, 1]
                                      - k.A1 * _z[b, ch, 2] - k.A2 * _z[b, ch, 3];
                _z[b, ch, 1] = _z[b, ch, 0]; _z[b, ch, 0] = x;
                _z[b, ch, 3] = _z[b, ch, 2]; _z[b, ch, 2] = y;
                frame[ch] = y > 4.0f ? 4.0f : (y < -4.0f ? -4.0f : (float)y); // ±4 安全钳位
            }
        }
    }
}
