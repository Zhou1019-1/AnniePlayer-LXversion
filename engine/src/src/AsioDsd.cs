using System.Runtime.InteropServices;
using NAudio.Wave;
using NAudio.Wave.Asio;

namespace MineEngine;

/// <summary>
/// V4.3.12：ASIO 原生 DSD 输出（真 Native DSD，不经过 DoP 封装、不转 PCM）。
/// 流程（ASIO SDK 2.3「Sony DSD Support」+ foobar2000 foo_dsd_asio 同款）：
///   1. future(kAsioCanDoIoFormat, DSD) 探测 → future(kAsioSetIoFormat, DSD) 切 DSD 模式
///   2. SetSampleRate(DSD 位率，DSD64=2822400 … DSD512=22579200)
///   3. CreateBuffers 后 GetChannelInfo 回报驱动选用的 DSD 样本类型（LSB1=32 / MSB1=33）
///   4. bufferSwitch 回调直推裸 DSD 位流——DSF 文件天然 LSB-first，MSB1 驱动按位翻转
/// 绕开 NAudio AsioOut（只认 PCM 浮点），直接用 AsioDriverExt 的原始缓冲回调。
/// 回调运行在声卡驱动的 RT 线程：严禁文件 IO / 锁等待过久——数据由供数线程预读进队列，回调只 memcpy。
/// </summary>
public sealed class AsioNativeDsdOutput : IDisposable
{
    private const int KAsioSetIoFormat = 0x23111961;   // asio.h：ASIOIoFormat* in params
    private const int KAsioCanDoIoFormat = 0x23112004;
    private const int KAsioDsdFormat = 1;              // kASIODSDFormat（kASIOPCMFormat=0）
    private const int AsioStDsdInt8Lsb1 = 32;          // 首样本在字节最低位（= DSF 文件天然位序）
    private const int AsioStDsdInt8Msb1 = 33;          // 首样本在字节最高位 → 每字节按位翻转

    private readonly DsfReader _dsf;
    private readonly string _driverName;
    private AsioDriverExt? _ext;

    private int _channels;
    private int _bufSamples;        // 每声道每缓冲的 DSD 样本数（=比特数）
    private int _bytesPerBuf;       // = _bufSamples / 8
    private bool _bitReverse;       // MSB1 驱动 → 送数前按位翻转
    private byte _silenceByte = 0x69;

    // 供数线程 → RT 回调 的预读队列（每声道一列，元素长度 _bytesPerBuf）
    private Queue<byte[]>[] _queues = Array.Empty<Queue<byte[]>>();
    private readonly object _queueGate = new();
    private readonly AutoResetEvent _queueEvent = new(false);
    private volatile bool _feedEnded;   // 文件已读完
    private volatile bool _stopFlag;
    private Thread? _feeder;
    private long _samplesConsumed;      // 只计真实数据（静音垫不计），用于播放位置
    private static readonly byte[] _revTable = BuildRevTable();

    /// <summary>已播放秒数（不含起始偏移，引擎侧自加 _offsetSec）。</summary>
    public double PositionSec => _dsf.DsdRate > 0 ? (double)Interlocked.Read(ref _samplesConsumed) / _dsf.DsdRate : 0;
    public string DriverName => _driverName;

    public AsioNativeDsdOutput(string driverName, DsfReader dsf)
    {
        _driverName = driverName;
        _dsf = dsf;
    }

    private static byte[] BuildRevTable()
    {
        var t = new byte[256];
        for (int i = 0; i < 256; i++)
        {
            byte b = (byte)i, r = 0;
            for (int k = 0; k < 8; k++) { r |= (byte)((b & 1) << (7 - k)); b >>= 1; }
            t[i] = r;
        }
        return t;
    }

    /// <summary>打开驱动并切到 DSD 模式。失败抛异常（调用方负责回退提示）。</summary>
    public void Open()
    {
        if (_dsf.Channels != 2) throw new InvalidOperationException($"Native DSD 暂仅支持立体声 DSF（本文件 {_dsf.Channels} 声道）");
        _channels = 2;

        AsioSta.Invoke(() =>
        {
            var driver = AsioDriver.GetAsioDriverByName(_driverName);
            _ext = new AsioDriverExt(driver); // 构造内 driver.Init

            // 1) 探测 + 切 DSD 模式。ASIOIoFormat：首 4 字节 FormatType，其余为 future 保留位（驱动不读），给 512B 零初始化足够
            IntPtr pFmt = Marshal.AllocHGlobal(512);
            try
            {
                // 清零
                for (int i = 0; i < 512; i++) Marshal.WriteByte(pFmt, i, 0);
                Marshal.WriteInt32(pFmt, 0, KAsioDsdFormat);
                try { driver.Future(KAsioCanDoIoFormat, pFmt); }
                catch { throw new InvalidOperationException($"ASIO 驱动 [{_driverName}] 不支持 Native DSD（kAsioCanDoIoFormat 被拒）"); }
                driver.Future(KAsioSetIoFormat, pFmt); // 失败会抛 AsioException
            }
            finally { Marshal.FreeHGlobal(pFmt); }

            // 2) 采样率 = DSD 位率（SDK 约定：DSD 不当特例，直接设 2.8224M 等）
            if (!driver.CanSampleRate(_dsf.DsdRate))
                throw new InvalidOperationException($"ASIO 驱动 [{_driverName}] 不接受 DSD 位率 {_dsf.DsdRate}Hz");
            _ext.SetSampleRate(_dsf.DsdRate); // 同时刷新 capabilities（DSD 模式下缓冲尺寸会变）

            // 3) 切格式后重查声道样本类型，确定位序
            int st = (int)driver.GetChannelInfo(0, false).type;
            if (st == AsioStDsdInt8Msb1) { _bitReverse = true; _silenceByte = 0x96; }
            else if (st == AsioStDsdInt8Lsb1) { _bitReverse = false; _silenceByte = 0x69; }
            else throw new InvalidOperationException($"ASIO 驱动 [{_driverName}] 未进入 DSD 模式（声道类型={st}，期望 32/33）");
            Console.Error.WriteLine($"[dsd] Native DSD：驱动 {_driverName}，位序 {(st == AsioStDsdInt8Msb1 ? "MSB1" : "LSB1")}，{_dsf.DsdRate}Hz");

            // 4) 建缓冲。bufferSize 单位是 DSD 样本（比特），Int8 打包 8 样本/字节
            _ext.FillBufferCallback = FillBuffer;
            _bufSamples = _ext.CreateBuffers(_channels, 0, false);
            _bytesPerBuf = Math.Max(8, _bufSamples / 8);
            Console.Error.WriteLine($"[dsd] ASIO 缓冲 {_bufSamples} 样本/声道（{_bytesPerBuf}B），回调周期 {_bufSamples * 1000.0 / _dsf.DsdRate:F2}ms");
        });

        _queues = new Queue<byte[]>[_channels];
        for (int c = 0; c < _channels; c++) _queues[c] = new Queue<byte[]>();
        _stopFlag = false; _feedEnded = false;
        Interlocked.Exchange(ref _samplesConsumed, 0);
        _feeder = new Thread(FeedLoop) { IsBackground = true, Name = "dsd-feeder", Priority = ThreadPriority.AboveNormal };
        _feeder.Start();
    }

    /// <summary>供数线程：读 DSF 交错字节 → 拆声道 → 入队。RT 回调线程绝不做文件 IO。</summary>
    private void FeedLoop()
    {
        int need = _bytesPerBuf * _channels;
        var inter = new byte[need];
        while (!_stopFlag && !_feedEnded)
        {
            lock (_queueGate)
            {
                if (_queues[0].Count >= 24) goto wait; // 队列上限，防内存堆积
            }
            {
                int n = _dsf.ReadInterleaved(inter, 0, need);
                if (n < need)
                {
                    _feedEnded = true;
                    for (int i = Math.Max(0, n); i < need; i++) inter[i] = _silenceByte; // 尾垫静音
                }
                for (int ch = 0; ch < _channels; ch++)
                {
                    var chunk = new byte[_bytesPerBuf];
                    if (_bitReverse)
                        for (int i = 0; i < _bytesPerBuf; i++) chunk[i] = _revTable[inter[i * _channels + ch]];
                    else
                        for (int i = 0; i < _bytesPerBuf; i++) chunk[i] = inter[i * _channels + ch];
                    lock (_queueGate) _queues[ch].Enqueue(chunk);
                }
            }
            continue;
        wait:
            _queueEvent.WaitOne(5);
        }
    }

    /// <summary>ASIO RT 回调：每声道弹一块 memcpy；欠载/曲终填 DSD 静音花纹（绝不能填 0——满幅直流烧喇叭）。</summary>
    private void FillBuffer(IntPtr[] inputs, IntPtr[] outputs)
    {
        for (int ch = 0; ch < _channels && ch < outputs.Length; ch++)
        {
            byte[]? chunk;
            lock (_queueGate) { chunk = _queues[ch].Count > 0 ? _queues[ch].Dequeue() : null; }
            if (chunk is not null)
            {
                Marshal.Copy(chunk, 0, outputs[ch], chunk.Length);
                if (ch == 0) Interlocked.Add(ref _samplesConsumed, _bufSamples);
            }
            else
            {
                for (int i = 0; i < _bytesPerBuf; i++) Marshal.WriteByte(outputs[ch], i, _silenceByte);
            }
        }
        _queueEvent.Set();
    }

    public void Play() { if (_ext is not null) AsioSta.Invoke(() => _ext.Start()); }
    public void Pause() { if (_ext is not null) AsioSta.Invoke(() => _ext.Stop()); }

    public void Dispose()
    {
        _stopFlag = true;
        _queueEvent.Set();
        try { _feeder?.Join(500); } catch { }
        var ext = _ext; _ext = null;
        if (ext is not null)
        {
            try { AsioSta.Invoke(() => { try { ext.Stop(); } catch { } ext.ReleaseDriver(); }); } catch { }
        }
    }
}
