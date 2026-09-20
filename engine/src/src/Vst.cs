using NAudio.Vst3;

namespace MineEngine;

/// <summary>
/// VST3 效果器槽位（VST实验区一期：效果器宿主）。
/// 槽位持有模块与配置（路径/启用/状态），插件实例按"每个 PcmFloatSource 一份"创建——
/// 交叉淡入时新旧两源并行读，各自持有独立实例，天然避免并发处理竞争。
/// 线程模型：模块加载/实例化/参数读取在 RPC 线程；Process 仅音频线程；参数写入走
/// NAudio.Vst3 的主机参数队列（SetParameterNormalized 线程安全）。
/// 护栏：加载或处理异常 → Broken 自动旁通，不影响播放（引擎 Supervisor 兜底之外的第一道保险）。
/// </summary>
public sealed class VstFxSlot : IDisposable
{
    public string Id = "";
    public string Path = "";
    public string Name = "";
    public bool Enabled = true;
    public volatile bool Broken;        // 加载/处理失败 → 自动旁通
    public volatile bool EditorOpen;    // 原生界面打开期间：临时摘掉活实例，避免同插件活动实例抢占 UI Attach
    public byte[]? SavedState;          // 最近持久化状态（换源/换采样率重建实例时恢复）

    private Vst3Module? _module;
    private Vst3ClassInfo? _classInfo;

    /// <summary>加载模块并选定效果类（幂等，仅 RPC 线程调用）。</summary>
    public void LoadModule()
    {
        if (_module is not null) return;
        _module = Vst3Module.Load(Path);
        var classes = _module.GetClasses();
        _classInfo = classes.FirstOrDefault(c => c.IsEffect)
                  ?? classes.FirstOrDefault(c => c.IsAudioModule)
                  ?? throw new InvalidOperationException("模块中没有可用的效果类");
        if (string.IsNullOrEmpty(Name)) Name = _classInfo.Name;
    }

    /// <summary>为指定源创建一份独立插件实例（声道数不匹配则抛错，由调用方旁通）。</summary>
    public VstFxInstance CreateInstanceFor(int rate, int channels)
    {
        LoadModule();
        // 最大块 200ms：覆盖输出回调常见块长；过大仅多占少量内存
        var plugin = _module!.CreatePlugin(_classInfo!, rate, Math.Max(1024, rate / 5));
        int inCh = plugin.InputChannelCount, outCh = plugin.OutputChannelCount;
        if (inCh != channels || outCh != channels)
        {
            try { plugin.Dispose(); } catch { }
            throw new InvalidOperationException($"插件声道（{inCh}→{outCh}）与当前 {channels} 声道不匹配");
        }
        if (SavedState is not null) { try { plugin.LoadState(SavedState); } catch { } }
        return new VstFxInstance { Slot = this, Plugin = plugin };
    }

    /// <summary>模块未加载也能给出展示名（列表用）。</summary>
    public void Dispose()
    {
        try { _module?.Dispose(); } catch { }
        _module = null;
    }
}

/// <summary>某个 PcmFloatSource 私有的一份插件实例（含输入拷贝缓冲）。</summary>
public sealed class VstFxInstance
{
    public VstFxSlot Slot = null!;
    public Vst3Plugin Plugin = null!;
    public float[]? Scratch;
    /// <summary>插件原生界面挂在活实例上（分析仪才能看到信号）；挂接期间源退役不释放插件对象。</summary>
    public volatile bool EditorAttached;
    /// <summary>源已退役但编辑器仍开着：插件对象转交编辑器关闭路径回收（见 Engine.VstEditorCleanup）。</summary>
    public bool Orphaned;

    /// <summary>源退役时调用：把插件状态收编回槽位（参数不丢），再释放原生资源。</summary>
    public void Dispose()
    {
        try { Slot.SavedState = Plugin.SaveState(); } catch { }
        if (EditorAttached) { Orphaned = true; return; } // 编辑器还活着，延迟释放防原生崩溃
        try { Plugin.Dispose(); } catch { }
    }
}
