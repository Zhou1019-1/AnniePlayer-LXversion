using NAudio.Wave;

namespace MineEngine;

/// <summary>
/// DSF 原生 DSD 读取器（Pro beat0.0.1）。
/// DSF 结构：DSD 块(28B) + fmt 块(52B) + data 块（声道分块交错，默认每声道 4096B 交替）。
/// 输出为立体声字节交错的 DSD 位流（L0 R0 L1 R1 …，每字节 8 个 DSD 位，MSB 优先）。
/// 仅支持 DSF；DFF 结构差异大，上层回退 PCM。
/// </summary>
public sealed class DsfReader : IDisposable
{
    public int Channels { get; }
    public int DsdRate { get; }          // DSD 位率（Hz），如 2822400（DSD64）
    public long TotalDsdBytesPerChannel { get; }
    public double DurationSec { get; }

    private readonly FileStream _fs;
    private readonly long _dataStart;
    private readonly int _blockSize;
    private readonly byte[][] _chanBuf;
    private readonly int[] _chanPos;
    private readonly int[] _chanLen;
    private int _nextChannel;
    private long _blocksRead;

    public static bool IsDsf(string path)
        => path.EndsWith(".dsf", StringComparison.OrdinalIgnoreCase);

    public DsfReader(string path)
    {
        _fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16);
        var br = new BinaryReader(_fs);
        if (br.ReadUInt32() != 0x20445344) throw new InvalidDataException("不是 DSF 文件（缺 DSD 块）"); // "DSD "
        br.ReadUInt64(); // chunk size
        br.ReadUInt64(); // file size
        br.ReadUInt64(); // meta offset

        if (br.ReadUInt32() != 0x20746D66) throw new InvalidDataException("DSF 缺 fmt 块"); // "fmt "
        br.ReadUInt64(); // fmt size
        br.ReadUInt32(); // version
        br.ReadUInt32(); // format id
        br.ReadUInt32(); // channel type
        Channels = (int)br.ReadUInt32();
        DsdRate = (int)br.ReadUInt32();
        br.ReadUInt32(); // bits per sample (1/8)
        long sampleCount = br.ReadInt64();
        _blockSize = (int)br.ReadUInt32();
        br.ReadUInt32(); // reserved

        if (br.ReadUInt32() != 0x61746164) throw new InvalidDataException("DSF 缺 data 块"); // "data"
        long dataSize = (long)br.ReadUInt64() - 12;
        _dataStart = _fs.Position;
        TotalDsdBytesPerChannel = dataSize / Channels;
        DurationSec = DsdRate > 0 ? (double)TotalDsdBytesPerChannel * 8 / DsdRate : 0;
        _ = sampleCount;

        _chanBuf = new byte[Channels][];
        _chanPos = new int[Channels];
        _chanLen = new int[Channels];
        for (int c = 0; c < Channels; c++) _chanBuf[c] = new byte[_blockSize];
        _nextChannel = 0;
    }

    /// <summary>读取交错 DSD 字节到 buffer（L R 交错），返回实际字节数（0=结束）。</summary>
    public int ReadInterleaved(byte[] buffer, int offset, int count)
    {
        int written = 0;
        while (written < count)
        {
            int c = _nextChannel;
            if (_chanPos[c] >= _chanLen[c])
            {
                // 填充电前声道块
                long remain = TotalDsdBytesPerChannel - _blocksRead * _blockSize;
                if (remain <= 0 && c == 0) break;
                int want = (int)Math.Min(_blockSize, Math.Max(remain, 0));
                int n = want > 0 ? _fs.Read(_chanBuf[c], 0, want) : 0;
                _chanLen[c] = n; _chanPos[c] = 0;
                if (c == Channels - 1) _blocksRead++;
                if (n == 0) { _nextChannel = (c + 1) % Channels; if (c == 0) break; continue; }
            }
            buffer[offset + written++] = _chanBuf[c][_chanPos[c]++];
            _nextChannel = (c + 1) % Channels;
        }
        return written;
    }

    /// <summary>按秒定位（对齐到声道块边界；Pro：DoP 模式下的 seek 支持）。</summary>
    public void SeekSeconds(double sec)
    {
        long bytesPerChan = (long)(Math.Max(0, sec) * DsdRate / 8);
        long blocks = bytesPerChan / _blockSize;
        _fs.Position = _dataStart + blocks * _blockSize * Channels;
        _blocksRead = blocks;
        for (int c = 0; c < Channels; c++) { _chanLen[c] = 0; _chanPos[c] = 0; }
        _nextChannel = 0;
    }

    public void Dispose() { try { _fs.Dispose(); } catch { } }
}

/// <summary>
/// DoP（DSD over PCM）封装源：把 DSD 位流封装为 176.4kHz/24bit PCM 帧（DSD64）。
/// 每个 24bit 字 = 8bit 标记（0x05/0xFA 逐帧交替）+ 16bit DSD。
/// 对 WASAPI 独占而言就是普通 PCM 流，DAC 识别标记后按原生 DSD 解码。
/// DSD128+ 需 352.8kHz+ 输出率，由上层按 DsdRate/16 计算。
/// </summary>
public sealed class DopSource : IWaveProvider
{
    private readonly DsfReader _dsf;
    private readonly int _channels;
    private readonly byte[] _dsdBuf = new byte[1 << 16];
    private int _dsdPos, _dsdLen;
    private bool _markerFa; // false=0x05, true=0xFA
    private long _framesProduced;
    private volatile bool _active = true;

    public WaveFormat WaveFormat { get; }
    public long FramesProduced => System.Threading.Interlocked.Read(ref _framesProduced);
    public bool SourceEnded => !_active;
    public DsfReader Dsf => _dsf;

    public DopSource(DsfReader dsf)
    {
        _dsf = dsf;
        _channels = Math.Max(2, dsf.Channels); // DAC 期望立体声 DoP；多声道 DSF 罕见，按声道数输出
        int pcmRate = dsf.DsdRate / 16;        // DSD64→176400, DSD128→352800
        WaveFormat = new WaveFormat(pcmRate, 24, _channels);
    }

    public void Deactivate() { _active = false; }

    public int Read(byte[] buffer, int offset, int count)
    {
        if (!_active) { Array.Clear(buffer, offset, count); return count; }
        int bytesPerFrame = _channels * 3;
        int frames = count / bytesPerFrame;
        int written = 0;
        for (int f = 0; f < frames; f++)
        {
            byte marker = _markerFa ? (byte)0xFA : (byte)0x05;
            _markerFa = !_markerFa;
            for (int ch = 0; ch < _channels; ch++)
            {
                // 每声道每帧 16bit DSD（2 字节）
                if (_dsdLen - _dsdPos < 2)
                {
                    int remain = _dsdLen - _dsdPos;
                    if (remain > 0) _dsdBuf[0] = _dsdBuf[_dsdPos];
                    _dsdLen = remain + _dsf.ReadInterleaved(_dsdBuf, remain, _dsdBuf.Length - remain);
                    _dsdPos = 0;
                    if (_dsdLen - _dsdPos < 2) { Array.Clear(buffer, offset + written, count - written); return count; }
                }
                int o = offset + written;
                buffer[o] = _dsdBuf[_dsdPos];       // DoP：DSD 低位字节在 24bit 字的低 16bit
                buffer[o + 1] = _dsdBuf[_dsdPos + 1];
                buffer[o + 2] = marker;             // 高 8bit 为标记
                _dsdPos += 2;
                written += 3;
            }
        }
        System.Threading.Interlocked.Add(ref _framesProduced, frames);
        return count;
    }
}
