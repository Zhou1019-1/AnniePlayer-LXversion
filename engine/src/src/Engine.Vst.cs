using System.Text.Json.Nodes;
using NAudio.Vst3;
using NAudio.Wave;

namespace MineEngine;

/// <summary>VST实验区：VST3 效果器链——槽位管理 / 参数与状态 / 原生编辑器窗口 / 按源挂链。</summary>
public sealed partial class Engine
{
    private static object VstSlotInfo(VstFxSlot s) => new
    {
        id = s.Id,
        path = s.Path,
        name = s.Name,
        enabled = s.Enabled,
        broken = s.Broken,
        auto = s.AutoBypassed,
        editorOpen = _editorSlotIdStatic == s.Id,
        perfMs = Math.Round(System.Threading.Interlocked.Read(ref s.PerfEmaUs) / 1000.0, 2),
        perfCalls = System.Threading.Interlocked.Read(ref s.PerfCalls)
    };
    // VstSlotInfo 是静态方法，编辑器状态经此静态字段透传（Engine 单例）
    private static string? _editorSlotIdStatic;

    private object VstScan()
    {
        try
        {
            var items = Vst3PluginScanner.EnumerateInstalled().Select(m => new { path = m.Path, name = m.Name }).ToArray();
            return new { ok = true, items };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    private object VstList() { lock (_gate) return new { ok = true, slots = _vstSlots.Select(VstSlotInfo).ToArray() }; }

    private object VstAdd(string path)
    {
        var slot = new VstFxSlot { Id = Guid.NewGuid().ToString("N")[..8], Path = path };
        try { slot.LoadModule(); }
        catch (Exception ex) { try { slot.Dispose(); } catch { } return new { ok = false, error = ex.Message }; }
        lock (_gate) { _vstSlots.Add(slot); ReattachVstLocked(); }
        return new { ok = true, slot = VstSlotInfo(slot) };
    }

    private object VstRemove(string id)
    {
        lock (_gate)
        {
            var slot = _vstSlots.FirstOrDefault(s => s.Id == id);
            if (slot is null) return new { ok = false, error = "槽位不存在" };
            if (_vstEditor is not null && _vstEditor.SlotId == id) CloseVstEditorLocked(); // 先关界面再卸模块
            _vstSlots.Remove(slot); _vstCrashNotified.Remove(id);
            ReattachVstLocked(); // 先重建链（摘掉该插件实例），再释放模块
            try { slot.Dispose(); } catch { }
        }
        return new { ok = true };
    }

    private object VstEnable(string id, bool on)
    {
        lock (_gate)
        {
            var slot = _vstSlots.FirstOrDefault(s => s.Id == id);
            if (slot is null) return new { ok = false, error = "槽位不存在" };
            slot.Enabled = on;
            if (on)
            {
                slot.Broken = false; slot.AutoBypassed = false; _vstCrashNotified.Remove(id); // 重新启用 = 给它一次复活机会
                System.Threading.Interlocked.Exchange(ref slot.PerfCalls, 0);
                System.Threading.Interlocked.Exchange(ref slot.PerfEmaUs, 0);
                System.Threading.Interlocked.Exchange(ref slot.PerfSlowStreak, 0);
                // 关闭时我们保留实例做湿声淡出；若当前源里还没有该槽实例（例如播放前就禁用），再挂链让它从 Wet=0 淡入。
                if (_source?.VstFx?.Any(i => i.Slot.Id == id) != true) ReattachVstLocked();
            }
            // 关闭：不拆链，PcmFloatSource 按 target=0 做 20ms 湿声淡出后跳过处理，避免咔哒。
        }
        return new { ok = true };
    }

    private object VstMove(string id, int dir)
    {
        lock (_gate)
        {
            int i = _vstSlots.FindIndex(s => s.Id == id);
            int j = i + (dir < 0 ? -1 : 1);
            if (i < 0) return new { ok = false, error = "槽位不存在" };
            if (j < 0 || j >= _vstSlots.Count) return new { ok = true }; // 到顶/到底不动
            (_vstSlots[i], _vstSlots[j]) = (_vstSlots[j], _vstSlots[i]);
            SyncVstOrderLocked(); // 仅重排已存在实例，不重建插件，避免顺序调整产生爆音
        }
        return new { ok = true };
    }

    private object VstParams(string id)
    {
        VstFxSlot? slot; VstFxInstance? live;
        lock (_gate) { slot = _vstSlots.FirstOrDefault(s => s.Id == id); live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id); }
        if (slot is null) return new { ok = false, error = "槽位不存在" };
        VstFxInstance? temp = null;
        try
        {
            var plugin = live?.Plugin ?? (temp = slot.CreateInstanceFor(48000, 2)).Plugin; // 未播放时临时实例读参数表
            var arr = plugin.Parameters
                .Where(pr => !pr.IsHidden)
                .Select(pr => new
                {
                    id = pr.Id, title = pr.Title, units = pr.Units,
                    value = pr.NormalizedValue, display = pr.DisplayValue,
                    readOnly = pr.IsReadOnly, discrete = pr.IsDiscrete || pr.StepCount > 0, steps = pr.StepCount
                }).ToArray();
            return new { ok = true, name = slot.Name, @params = arr };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
        finally { if (temp is not null) try { temp.Dispose(); } catch { } }
    }

    private object VstSetParam(string id, uint paramId, double value)
    {
        VstFxInstance? live; VstFxSlot? slot;
        lock (_gate) { slot = _vstSlots.FirstOrDefault(s => s.Id == id); live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id); }
        if (slot is null) return new { ok = false, error = "槽位不存在" };
        if (live is null) return new { ok = true, display = "" }; // 未播放：参数暂存不了（一期限制），UI 侧仅展示
        try
        {
            // 经主机参数队列转发，线程安全；显示值回读给 UI
            string display = "";
            if (live.Plugin.Parameters.TryGetById(paramId, out var prm) && prm is not null)
            {
                prm.NormalizedValue = Math.Clamp(value, 0, 1);
                display = prm.DisplayValue;
            }
            return new { ok = true, display };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    private object VstGetState(string id)
    {
        VstFxSlot? slot; VstFxInstance? live;
        lock (_gate) { slot = _vstSlots.FirstOrDefault(s => s.Id == id); live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id); }
        if (slot is null) return new { ok = false, error = "槽位不存在" };
        try
        {
            if (live is not null) slot.SavedState = live.Plugin.SaveState(); // 收编当前实例状态
            return new { ok = true, stateB64 = slot.SavedState is null ? "" : Convert.ToBase64String(slot.SavedState) };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    private object VstSetState(string id, string stateB64)
    {
        VstFxSlot? slot; VstFxInstance? live;
        lock (_gate) { slot = _vstSlots.FirstOrDefault(s => s.Id == id); live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id); }
        if (slot is null) return new { ok = false, error = "槽位不存在" };
        try
        {
            slot.SavedState = string.IsNullOrEmpty(stateB64) ? null : Convert.FromBase64String(stateB64);
            if (live is not null && slot.SavedState is not null) live.Plugin.LoadState(slot.SavedState);
            return new { ok = true };
        }
        catch (Exception ex) { return new { ok = false, error = ex.Message }; }
    }

    /* ---------- 插件原生界面（FB2K 式独立悬浮窗） ---------- */

    /// <summary>打开插件原生界面。IVGI2 这类分离控制器插件要求模块/插件/视图在同一 UI 线程创建，因此编辑器实例在 VST 编辑器线程内生成。</summary>
    private async Task<object> VstOpenEditor(string id)
    {
        VstFxSlot? slot; int rate = 48000, channels = 2;
        lock (_gate)
        {
            slot = _vstSlots.FirstOrDefault(s => s.Id == id);
            var live = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == id);
            if (slot is null) return new { ok = false, error = "槽位不存在" };
            if (live is null) return new { ok = false, error = "请先播放音乐，再打开插件界面" };
            if (_vstEditor is not null)
            {
                if (_vstEditor.SlotId == id) return new { ok = true }; // 已开着
                CloseVstEditorLocked(); // 换另一个插件：先关旧的
            }
            rate = _source?.WaveFormat.SampleRate ?? 48000;
            channels = _source?.WaveFormat.Channels ?? 2;
            // 先标记 EditorOpen：音频线程把该槽湿声 20ms 淡出，再摘活实例（IVGI2 活动实例会抢占第二个实例的 UI Attach）。
            if (_source?.VstFx?.Any(i => i.Slot.Id == id) == true) slot.EditorOpen = true;
        }
        if (slot.EditorOpen) await Task.Delay(35); // 等淡出完成，避免开原生界面瞬间咔哒
        lock (_gate)
        {
            var src = _source;
            if (src?.VstFx is { } fx)
            {
                var removed = fx.Where(i => i.Slot.Id == id).ToArray();
                if (removed.Length > 0)
                {
                    foreach (var inst in removed) { try { slot.SavedState = inst.Plugin.SaveState(); } catch { } }
                    slot.EditorOpen = true;
                    var remain = fx.Where(i => i.Slot.Id != id).ToArray();
                    src.VstFx = remain.Length > 0 ? remain : null;
                    foreach (var inst in removed) { try { inst.Dispose(); } catch { } }
                }
            }
        }
        var win = new VstEditorWindow { SlotId = id, OnClosed = VstEditorCleanup };
        try
        {
            win.OpenFactory(() =>
            {
                var inst = slot.CreateInstanceFor(rate, channels);
                if (slot.SavedState is not null) { try { inst.Plugin.LoadState(slot.SavedState); } catch { } }
                inst.Orphaned = true;      // 不进音频链，关闭编辑器后由清理路径释放
                inst.EditorAttached = true;
                return inst;
            }, slot.Name + " — 安妮播放器");
            lock (_gate) { _vstEditor = win; _editorSlotIdStatic = id; _vstEditorInst = win.Instance; }
            return new { ok = true };
        }
        catch (Exception ex)
        {
            if (win.Instance is not null) { win.Instance.EditorAttached = false; try { win.Instance.Plugin.Dispose(); } catch { } }
            if (slot.EditorOpen) { slot.EditorOpen = false; lock (_gate) { ReattachVstLocked(); } } // 打开失败：恢复音频链
            return new { ok = false, error = ex.Message };
        }
    }

    private object VstCloseEditor(string id)
    {
        lock (_gate)
        {
            if (_vstEditor is null || _vstEditor.SlotId != id) return new { ok = true };
            CloseVstEditorLocked();
        }
        return new { ok = true };
    }

    /// <summary>关编辑器（须持 _gate）。实际清理在 UI 线程完成后经 VstEditorCleanup 回调。</summary>
    private void CloseVstEditorLocked()
    {
        var win = _vstEditor;
        _vstEditor = null; _editorSlotIdStatic = null;
        try { win?.Close(); } catch { }
        // 若窗口线程已不在（异常情况），就地兜底回收
        var inst = _vstEditorInst;
        if (win is null && inst is not null) { inst.EditorAttached = false; _vstEditorInst = null; if (inst.Orphaned) { try { inst.Plugin.Dispose(); } catch { } } }
    }

    /// <summary>窗口销毁回调（编辑器 UI 线程触发）：收编状态 + 回收退役实例的插件对象。</summary>
    private void VstEditorCleanup(VstEditorWindow win)
    {
        lock (_gate)
        {
            if (ReferenceEquals(_vstEditor, win)) { _vstEditor = null; _editorSlotIdStatic = null; }
            var inst = win.Instance ?? _vstEditorInst;
            if (inst is null || win.SlotId != inst.Slot.Id) return;
            _vstEditorInst = null;
            inst.EditorAttached = false;
            try { inst.Slot.SavedState = inst.Plugin.SaveState(); } catch { } // 编辑器里调的参数收编回槽位
            if (inst.Orphaned) // 独立编辑器实例：把状态同步回正在播放的活实例，再释放编辑器实例
            {
                var liveNow = _source?.VstFx?.FirstOrDefault(i => i.Slot.Id == inst.Slot.Id);
                if (liveNow is not null && !ReferenceEquals(liveNow, inst) && inst.Slot.SavedState is not null)
                {
                    try { liveNow.Plugin.LoadState(inst.Slot.SavedState); } catch { }
                }
                try { inst.Plugin.Dispose(); } catch { }
            }
            if (inst.Slot.EditorOpen) { inst.Slot.EditorOpen = false; ReattachVstLocked(); } // 关界面后把该槽接回音频链
        }
    }

    /// <summary>把启用的效果器链挂到源上（每源私有实例；旧实例先收编状态再释放）。可在锁外调用。</summary>
    private void AttachVst(PcmFloatSource source)
    {
        var old = source.VstFx; source.VstFx = null;
        if (old is not null) foreach (var i in old) { try { i.Dispose(); } catch { } }
        if (_vstSlots.Count == 0) return;
        int rate = source.WaveFormat.SampleRate, ch = source.WaveFormat.Channels;
        var list = new List<VstFxInstance>();
        foreach (var s in _vstSlots)
        {
            if (!s.Enabled || s.Broken || s.EditorOpen) continue;
            try { list.Add(s.CreateInstanceFor(rate, ch)); }
            catch (Exception ex) { s.Broken = true; _rpc.Emit("notify", new { text = $"VST 插件「{s.Name}」加载失败已旁通：{ex.Message}" }); }
        }
        source.VstFx = list.Count > 0 ? list.ToArray() : null;
    }

    private void ReattachVstLocked() { if (_source is not null) AttachVst(_source); }

    /// <summary>只按槽位顺序重排当前源里的实例；缺实例/多实例时才回退重建。须持 _gate。</summary>
    private void SyncVstOrderLocked()
    {
        var src = _source; var fx = src?.VstFx;
        if (src is null || fx is null) return;
        var order = new Dictionary<string, int>();
        for (int i = 0; i < _vstSlots.Count; i++) order[_vstSlots[i].Id] = i;
        if (fx.Any(i => !order.ContainsKey(i.Slot.Id))) { ReattachVstLocked(); return; }
        src.VstFx = fx.OrderBy(i => order[i.Slot.Id]).ToArray();
    }
}
