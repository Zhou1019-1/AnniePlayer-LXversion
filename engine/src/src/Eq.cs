namespace MineEngine;

/// <summary>
/// 15 段图示均衡器（EXP 7.28 新增）。
/// RBJ Audio-EQ-Cookbook peaking biquad 链，作用于 float PCM 域（PcmFloatSource），
/// WASAPI Exclusive / ASIO 双输出通道共享同一实例；系数数组整体引用替换，音频线程无锁。
/// 频段：32 ~ 16000 Hz（2/3 倍频程，共 15 段），Q≈1.41 与带宽匹配，增益范围 ±12dB。
/// </summary>
public sealed class EqChain
{
    public static readonly double[] Frequencies =
        { 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000, 8000, 12500, 16000 };

    public const int BandCount = 15;
    private const double Q = 1.41;

    /// <summary>单段 biquad 系数（归一化，a0=1）。</summary>
    private struct BandCoeffs { public double B0, B1, B2, A1, A2; }

    /// <summary>不可变系数快照：Update 时整体替换引用，音频线程读到的一定是完整一致的一组。</summary>
    private sealed class CoeffSet
    {
        public readonly BandCoeffs[] Bands = new BandCoeffs[BandCount];
        public bool AnyActive; // 所有段都为 0dB 时为 false，Read 中可整体跳过
    }

    private volatile CoeffSet _coeffs = new();
    // 每声道滤波器状态（仅音频线程访问）：[band][channel] 的 x1,x2,y1,y2
    private double[,,] _z; // [band, channel, 4]
    private readonly int _channels;

    public EqChain(int sampleRate, int channels)
    {
        _channels = channels;
        _z = new double[BandCount, channels, 4];
        SampleRate = sampleRate;
    }

    public int SampleRate { get; }

    /// <summary>更新 15 段增益（dB，±12  clamp）。gains 长度不足 15 时缺省按 0dB。</summary>
    public void Update(double[] gains)
    {
        var set = new CoeffSet();
        for (int b = 0; b < BandCount; b++)
        {
            double db = b < gains.Length ? Math.Clamp(gains[b], -12.0, 12.0) : 0.0;
            if (Math.Abs(db) > 0.01) set.AnyActive = true;
            double a = Math.Pow(10.0, db / 40.0);
            double w0 = 2.0 * Math.PI * Frequencies[b] / SampleRate;
            double cosW0 = Math.Cos(w0);
            double alpha = Math.Sin(w0) / (2.0 * Q);
            double a0 = 1.0 + alpha / a;
            set.Bands[b] = new BandCoeffs
            {
                B0 = (1.0 + alpha * a) / a0,
                B1 = (-2.0 * cosW0) / a0,
                B2 = (1.0 - alpha * a) / a0,
                A1 = (-2.0 * cosW0) / a0,
                A2 = (1.0 - alpha / a) / a0,
            };
        }
        _coeffs = set; // 原子替换：音频线程不会读到半更新状态
    }

    /// <summary>对一帧（channels 个 float 样本）应用滤波链。仅音频线程调用。</summary>
    public unsafe void ProcessFrame(float* frame)
    {
        var c = _coeffs;
        if (!c.AnyActive) return;
        for (int b = 0; b < BandCount; b++)
        {
            ref var k = ref c.Bands[b];
            for (int ch = 0; ch < _channels; ch++)
            {
                double x = frame[ch];
                double y = k.B0 * x + k.B1 * _z[b, ch, 0] + k.B2 * _z[b, ch, 1]
                                      - k.A1 * _z[b, ch, 2] - k.A2 * _z[b, ch, 3];
                _z[b, ch, 1] = _z[b, ch, 0]; _z[b, ch, 0] = x;
                _z[b, ch, 3] = _z[b, ch, 2]; _z[b, ch, 2] = y;
                // Pro beat0.0.1：段间不再硬削波（削波防护上移到输出前：自动前级补偿 + 软限幅器），
                // 仅保留 ±4 安全钳位防滤波器异常发散
                frame[ch] = y > 4.0f ? 4.0f : (y < -4.0f ? -4.0f : (float)y);
            }
        }
    }
}
