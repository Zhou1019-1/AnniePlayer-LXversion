namespace MineEngine;

/// <summary>
/// V3.5.17：实时频谱分析（AM 可视化条）。
/// 从 PcmFloatSource 的环形缓冲取最近 1024 采样，Hann 窗 + radix-2 FFT，
/// 映射为 32 个对数频带（40Hz–16kHz），dB 归一化 + 快升慢降平滑。
/// 仅由 position 定时器线程（10Hz）调用，音频线程只写环形缓冲（单写者，允许撕裂）。
/// </summary>
public static class VizFft
{
    public const int Bands = 32;
    private const int N = 1024;

    private static readonly float[] Window = BuildHann();
    private static readonly float[] Re = new float[N];
    private static readonly float[] Im = new float[N];
    private static readonly float[] Ema = new float[Bands];
    private static readonly float[] Samples = new float[N];

    private static float[] BuildHann()
    {
        var w = new float[N];
        for (int i = 0; i < N; i++) w[i] = 0.5f * (1f - (float)Math.Cos(2 * Math.PI * i / (N - 1)));
        return w;
    }

    /// <summary>ring: 环形缓冲（长度须为 2 的幂）；writePos: 下一个写入位置。输出写入 out（32 段，0..1）。</summary>
    public static void Compute(float[] ring, int writePos, int sampleRate, float[] outBands)
    {
        int mask = ring.Length - 1;
        int start = writePos - N;
        for (int i = 0; i < N; i++)
        {
            Samples[i] = ring[(start + i) & mask] * Window[i];
        }

        // 拷贝到复数数组并做位反转置换
        for (int i = 0; i < N; i++) { Re[i] = Samples[i]; Im[i] = 0f; }
        for (int i = 1, j = 0; i < N; i++)
        {
            int bit = N >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { (Re[i], Re[j]) = (Re[j], Re[i]); (Im[i], Im[j]) = (Im[j], Im[i]); }
        }
        for (int len = 2; len <= N; len <<= 1)
        {
            double ang = -2.0 * Math.PI / len;
            float wRe = (float)Math.Cos(ang), wIm = (float)Math.Sin(ang);
            for (int i = 0; i < N; i += len)
            {
                float curRe = 1f, curIm = 0f;
                for (int j = 0; j < len / 2; j++)
                {
                    int u = i + j, v = i + j + len / 2;
                    float tRe = Re[v] * curRe - Im[v] * curIm;
                    float tIm = Re[v] * curIm + Im[v] * curRe;
                    Re[v] = Re[u] - tRe; Im[v] = Im[u] - tIm;
                    Re[u] += tRe; Im[u] += tIm;
                    float nRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = nRe;
                }
            }
        }

        // 对数频带聚合（40Hz .. min(16kHz, 奈奎斯特)）
        double nyq = Math.Min(16000, sampleRate / 2.0);
        double logMin = Math.Log(40.0), logMax = Math.Log(nyq);
        double binHz = (double)sampleRate / N;
        for (int b = 0; b < Bands; b++)
        {
            double f0 = Math.Exp(logMin + (logMax - logMin) * b / Bands);
            double f1 = Math.Exp(logMin + (logMax - logMin) * (b + 1) / Bands);
            int i0 = Math.Max(1, (int)(f0 / binHz));
            int i1 = Math.Min(N / 2 - 1, Math.Max(i0 + 1, (int)(f1 / binHz)));
            double sum = 0;
            for (int i = i0; i < i1; i++) sum += Math.Sqrt(Re[i] * Re[i] + Im[i] * Im[i]);
            double mag = sum / (i1 - i0) * 2.0 / N;
            // dB 映射：-55dB..0 → 0..1
            float level = (float)Math.Clamp((20 * Math.Log10(mag + 1e-9) + 55) / 55.0, 0, 1);
            // 快升慢降（视觉平滑）
            Ema[b] = level > Ema[b] ? level : Ema[b] * 0.72f;
            outBands[b] = (float)Math.Round(Ema[b], 3);
        }
    }

    public static void Reset()
    {
        Array.Clear(Ema, 0, Ema.Length);
    }
}
