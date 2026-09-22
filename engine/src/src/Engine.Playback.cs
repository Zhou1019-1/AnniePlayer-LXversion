using System.Text.Json.Nodes;
using NAudio.Vst3;
using NAudio.Wave;

namespace MineEngine;

/// <summary>引擎播放控制：探测缓存 / 播放状态机（Play/Seek/Pause/Resume/Stop）/ DoP / 交叉淡入 / 位置与电平上报。</summary>
public sealed partial class Engine
{
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
            object OpenWithRetry(IOutputBackend be)
            {
                for (int openRetry = 0; ; openRetry++)
                {
                    if (gen != _playGeneration) return new { ok = false, reason = "superseded" };
                    try
                    {
                        return PlayWithBackend(path, offsetSec, headers, info, be, gen, quickStart);
                    }
                    catch (Exception openEx) when (openRetry < 6 && gen == _playGeneration)
                    {
                        Console.Error.WriteLine($"[engine] 打开输出设备失败，600ms 后重试 ({openRetry + 1}/6)：{openEx.GetType().Name}: {openEx.Message}");
                        if (openRetry == 0) Console.Error.WriteLine("[engine] openEx stack: " + openEx.StackTrace);
                        Thread.Sleep(600);
                    }
                }
            }

            try
            {
                return OpenWithRetry(backend);
            }
            catch (Exception openFail)
            {
                // V3.5.15：设备打开彻底失败（DAC 断开/驱动异常等）→ 自动回退 WASAPI 共享默认输出再试，
                // 避免"点播放没反应"。已是兜底配置仍失败才向上抛错。
                if (_backendKind == "wasapi" && _backendDeviceId is null && !_exclusive) throw;
                Console.Error.WriteLine($"[engine] 输出设备打开失败，自动回退 WASAPI 共享默认输出：{openFail.GetType().Name}: {openFail.Message}");
                _rpc.Emit("notify", new { text = "输出设备不可用（" + (_backendKind == "asio" ? "ASIO: " + (_backendDeviceId ?? "默认驱动") : "当前设备") + "），已自动切换 WASAPI 共享输出" });
                SelectBackend("wasapi", null, exclusive: false);
                return OpenWithRetry(EnsureBackend());
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
            var pcm = FfmpegPcmStream.Start(path, offsetSec, resampled ? rate : 0, rate, channels, headers, CapacityFor(info, rate, channels), _resampleHq);
            var source = new PcmFloatSource(pcm, rate, channels) { Gain = _gain, LoudGain = _loudGain };
            if (_eqEnabled) { source.Eq = new EqChain(rate, channels); source.Eq.Update(_eqGains); }
            AttachVst(source); // VST实验区：效果器链（每源私有实例）
            // 双声道电平：rms/peak 保留为两声道较大值（向后兼容），rmsL/peakL/rmsR/peakR 为分声道值
            // 音频回调线程只写缓存字段，level 事件由 position 定时器（10Hz）顺带发送
            source.OnLevel += OnLevelSample;

            // Pro：crossfade 开启时经混音器输出（设备流在切歌时保持打开，同流混音过渡）
            // V3.5.15：gapless 开启时同样常驻 mixer（切歌 FadeTo(0) 硬切，设备不重建）
            IWaveProvider outProvider = source;
            if (_crossfadeSec > 0 || _gapless)
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
        // V3.5.15：gapless 开启且 crossfade=0 时仍走本路径（FadeTo(0) 硬切，设备流不重建）。
        if (_mixer is null || _backend is null || _dopActive
            || DsfReader.IsDsf(path) || (_crossfadeSec <= 0 && !_gapless))
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
            var pcm = FfmpegPcmStream.Start(path, 0, resampled ? mixRate : 0, mixRate, mixCh, headers, CapacityFor(info, mixRate, mixCh), _resampleHq);
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

        // V3.5.17：实时频谱（32 频段，随 position 10Hz 发射）——AM 可视化条用
        if (_playing && _source is not null)
        {
            var bands = new float[VizFft.Bands];
            VizFft.Compute(_source.VizRing, _source.VizWritePos, _decodeRate > 0 ? _decodeRate : 44100, bands);
            _rpc.Emit("spectrum", new { bands });
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
                // V3.5.16：gapless 开启时同样保持设备流（crossfade=0 走 FadeTo(0) 硬切）
                if ((_crossfadeSec <= 0 && !_gapless) || _mixer is null || _dopActive)
                    try { _backend?.Stop(); } catch { }
            }
            _rpc.Emit("state", new { state = "ended" });
        }
    }
}
