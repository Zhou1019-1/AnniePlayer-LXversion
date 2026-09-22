using System.Text.Json.Nodes;
using NAudio.Vst3;
using NAudio.Wave;

namespace MineEngine;

/// <summary>引擎 DSP 设置：音量 / 15 段 EQ / 参量 EQ / 声道矩阵 / 防削波链路 / DSD 模式 / 缓冲 / 无缝与重采样档位。</summary>
public sealed partial class Engine
{
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

    /// <summary>V3.5.19：参量 EQ。params: { enabled: bool, bands: [{f: Hz, g: dB, q}] }</summary>
    private object SetPeq(JsonObject p)
    {
        if (p["enabled"] is JsonNode en) _peqEnabled = en.GetValue<bool>();
        if (p["bands"] is JsonArray arr)
        {
            var list = new List<PeqChain.Band>();
            foreach (var it in arr)
            {
                if (it is not JsonObject o) continue;
                list.Add(new PeqChain.Band(
                    o["f"]?.GetValue<double>() ?? 1000,
                    o["g"]?.GetValue<double>() ?? 0,
                    o["q"]?.GetValue<double>() ?? 1.0));
                if (list.Count >= PeqChain.MaxBands) break;
            }
            _peqBands = list;
        }
        lock (_gate) { ApplyPeqLocked(); ApplyDspLocked(); } // ApplyDspLocked：前级补偿需计入 PEQ 正增益
        return new { ok = true, enabled = _peqEnabled, bands = _peqBands.Count };
    }

    /// <summary>把当前 PEQ 频段挂载到活动源（须持有 _gate）。</summary>
    private void ApplyPeqLocked()
    {
        if (_source is null) return;
        if (!_peqEnabled || _peqBands.Count == 0) { _source.Peq = null; return; }
        var peq = _source.Peq;
        if (peq is null || peq.SampleRate != _source.WaveFormat.SampleRate)
            _source.Peq = peq = new PeqChain(_source.WaveFormat.SampleRate, _source.WaveFormat.Channels);
        peq.Update(_peqBands);
    }

    /// <summary>V3.5.19：声道工具。params: { mode: stereo/swap/mono/invertL/invertR, balance: -1..1 }</summary>
    private object SetChannel(JsonObject p)
    {
        if (p["mode"] is JsonNode m) _chMode = m.GetValue<string>();
        if (p["balance"] is JsonNode b) _chBalance = Math.Clamp(b.GetValue<double>(), -1.0, 1.0);
        lock (_gate) { ApplyChannelLocked(); }
        return new { ok = true, mode = _chMode, balance = _chBalance };
    }

    /// <summary>由模式 + 平衡计算 2x2 声道矩阵（null = 直通，省去每帧矩阵乘法）。</summary>
    private float[]? BuildChMatrix()
    {
        float gL = (float)(_chBalance > 0 ? 1.0 - _chBalance : 1.0);
        float gR = (float)(_chBalance < 0 ? 1.0 + _chBalance : 1.0);
        float mLL = 1, mLR = 0, mRL = 0, mRR = 1;
        switch (_chMode)
        {
            case "swap": mLL = 0; mLR = 1; mRL = 1; mRR = 0; break;
            case "mono": mLL = mLR = mRL = mRR = 0.5f; break;
            case "invertL": mLL = -1; break;
            case "invertR": mRR = -1; break;
        }
        if (mLL == 1 && mLR == 0 && mRL == 0 && mRR == 1 && gL == 1 && gR == 1) return null;
        // 平衡作用在输出声道：列乘 gL/gR
        return new[] { mLL * gL, mLR * gL, mRL * gR, mRR * gR };
    }

    /// <summary>把声道矩阵挂载到活动源（须持有 _gate）。</summary>
    private void ApplyChannelLocked() { if (_source is not null) _source.ChMatrix = BuildChMatrix(); }

    /// <summary>Pro：把防削波链路（自动前级 + 限幅器）应用到活动源（须持有 _gate）。</summary>
    private void ApplyDspLocked()
    {
        if (_source is null) return;
        double maxPos = 0;
        if (_eqEnabled) foreach (var g in _eqGains) if (g > maxPos) maxPos = g;
        if (_peqEnabled) foreach (var b in _peqBands) if (b.GainDb > maxPos) maxPos = b.GainDb; // V3.5.19：PEQ 正增益同样计入前级补偿
        _source.Preamp = _autoPreamp ? (float)Math.Pow(10.0, -maxPos / 20.0) : 1.0f;
        _source.Limiter = _limiter;
        _source.LoudGain = _loudGain;
        ApplyPeqLocked();      // V3.5.19：新源/换采样率时重建 PEQ 链
        ApplyChannelLocked();  // V3.5.19：声道矩阵
    }

    /* ---------------- Pro beat0.0.1：新 RPC ---------------- */

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

    // V3.5.15：无缝播放——切歌走 mixer 硬切（FadeTo 0），设备流不重建，间隙从秒级缩到毫秒级
    private object SetGapless(bool on)
    {
        _gapless = on;
        return new { ok = true, gapless = on };
    }

    // V3.5.15：重采样质量——hq=soxr（仅引擎重采样时生效；当前曲不变，下一曲生效）
    private object SetResampleHq(bool hq)
    {
        _resampleHq = hq;
        return new { ok = true, hq };
    }

    /// <summary>
    /// V4 音频正确性测试（CI）：解码文件经过与播放完全相同的 PcmFloatSource DSP 链
    /// （EQ/PEQ/声道矩阵/响度/限幅），不开输出设备直接拉完全部帧，返回可断言指标。
    /// 注意：会临时覆写 _chMode/_chBalance——测试脚本是独立引擎进程，无副作用。
    /// params: { path, rate?（目标采样率，0=源码率）, eq?: double[15], peq?: [{f,g,q}],
    ///           channelMode?, channelBalance?, loudGain?, limiter? }
    /// </summary>
    private object TestDecode(JsonObject p)
    {
        var path = Req(p, "path");
        var info = FfmpegPcmStream.Probe(path);
        int srcRate = info.SampleRate;
        int channels = Math.Max(1, Math.Min(2, info.Channels));
        int targetRate = p["rate"]?.GetValue<int>() ?? 0;
        int outRate = targetRate > 0 ? targetRate : srcRate;
        bool resample = targetRate > 0 && targetRate != srcRate;
        using var pcm = FfmpegPcmStream.Start(path, 0, resample ? outRate : 0, outRate, channels, null, 0, _resampleHq);
        var src = new PcmFloatSource(pcm, outRate, channels)
        {
            Gain = 1.0f,
            LoudGain = (float)Math.Clamp(p["loudGain"]?.GetValue<double>() ?? 1.0, 0.05, 4.0),
            Limiter = p["limiter"]?.GetValue<bool>() ?? true,
        };
        if (p["eq"] is JsonArray eqArr)
        {
            var gains = new double[EqChain.BandCount];
            for (int i = 0; i < EqChain.BandCount && i < eqArr.Count; i++) gains[i] = eqArr[i]?.GetValue<double>() ?? 0;
            src.Eq = new EqChain(outRate, channels);
            src.Eq.Update(gains);
        }
        if (p["peq"] is JsonArray peqArr)
        {
            var bands = new List<PeqChain.Band>();
            foreach (var it in peqArr)
                if (it is JsonObject o)
                    bands.Add(new PeqChain.Band(
                        o["f"]?.GetValue<double>() ?? 1000,
                        o["g"]?.GetValue<double>() ?? 0,
                        o["q"]?.GetValue<double>() ?? 1.0));
            src.Peq = new PeqChain(outRate, channels);
            src.Peq.Update(bands);
        }
        if (p["channelMode"] is JsonNode cm)
        {
            _chMode = cm.GetValue<string>();
            _chBalance = Math.Clamp(p["channelBalance"]?.GetValue<double>() ?? 0, -1.0, 1.0);
            src.ChMatrix = BuildChMatrix();
        }
        // 拉取全部帧并计量。FramesRead 只计真实解码帧（静音填充不计），据此剔除尾部静音。
        var buf = new byte[1 << 16];
        long frames = 0, overCount = 0;
        double sumL = 0, sumR = 0, meanL = 0, meanR = 0, sumMid = 0;
        float peakL = 0, peakR = 0;
        for (int iter = 0; iter < 100000; iter++)
        {
            long before = src.FramesRead;
            src.Read(buf, 0, buf.Length);
            long real = src.FramesRead - before;
            for (long fr = 0; fr < real; fr++)
            {
                float l = BitConverter.ToSingle(buf, (int)(fr * channels * 4));
                float r = channels > 1 ? BitConverter.ToSingle(buf, (int)(fr * channels * 4 + 4)) : l;
                float mid = (l + r) * 0.5f;
                sumL += (double)l * l; sumR += (double)r * r; sumMid += (double)mid * mid;
                meanL += l; meanR += r;
                float al = Math.Abs(l), ar = Math.Abs(r);
                if (al > peakL) peakL = al;
                if (ar > peakR) peakR = ar;
                if (al > 1.0001f || ar > 1.0001f) overCount++;
            }
            frames += real;
            if (src.SourceEnded && real == 0) break;
        }
        src.Deactivate();
        if (pcm.Failed) throw new InvalidOperationException("解码失败: " + path);
        return new
        {
            ok = true,
            frames,
            sampleRate = outRate,
            sourceRate = srcRate,
            channels,
            resampled = resample,
            rmsL = frames > 0 ? Math.Sqrt(sumL / frames) : 0,
            rmsR = frames > 0 ? Math.Sqrt(sumR / frames) : 0,
            rmsMid = frames > 0 ? Math.Sqrt(sumMid / frames) : 0, // 中置能量：相位抵消测试用
            peakL,
            peakR,
            dcL = frames > 0 ? meanL / frames : 0,
            dcR = frames > 0 ? meanR / frames : 0,
            overCount,
            durationSec = Math.Round(frames / (double)outRate, 3),
        };
    }
}
