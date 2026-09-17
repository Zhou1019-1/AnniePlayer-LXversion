using System.Runtime.InteropServices;
using NAudio.Vst3;

namespace MineEngine;

/// <summary>
/// VST3 插件原生界面宿主窗口（FB2K 式独立悬浮窗）。
/// 窗口与 IPlugView 的全部调用都绑在专用 STA 线程（带消息循环）——VST3 规范要求界面
/// 调用单线程化；Process 在音频线程，两者由插件的组件/控制器分离机制保证并发安全。
/// 生命周期：Open() 起线程建窗挂视图 → 用户点 X 或引擎 Close() → UI 线程上
/// Detach+Dispose 视图 → 回调 OnClosed（引擎在此回收插件实例）。
/// 注意：视图挂在"正在处理音频的活实例"上（分析仪类插件只有这样才能看到信号），
/// 实例被源退役时不立即释放（见 VstFxInstance.Orphaned），由编辑器关闭路径兜底回收。
/// </summary>
public sealed class VstEditorWindow
{
    /* ---------------- Win32 ---------------- */
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowExW(uint exStyle, string className, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr hInstance, IntPtr param);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool GetMessageW(out MSG msg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int exitCode);
    [DllImport("user32.dll", SetLastError = true)] private static extern ushort RegisterClassW(ref WNDCLASS wc);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern bool AdjustWindowRect(ref RECT rect, uint style, bool hasMenu);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr LoadCursorW(IntPtr hInstance, IntPtr name);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandleW(string? name);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASS { public uint style; public WndProcDelegate lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; public string? lpszMenuName; public string lpszClassName; }
    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    private const uint WS_OVERLAPPED = 0x00000000, WS_CAPTION = 0x00C00000, WS_SYSMENU = 0x00080000;
    private const uint WM_CLOSE = 0x0010, WM_DESTROY = 0x0002;
    private const uint SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004;
    private const int SW_SHOW = 5;

    private static bool _classReady;
    private static readonly WndProcDelegate _wndProc = WndProc; // 持引用防 GC
    private static VstEditorWindow? _current;                    // 同时只允许一个插件界面（一期半简化）

    /* ---------------- 实例状态 ---------------- */
    private Thread? _thread;
    private IntPtr _hwnd;
    private Vst3PluginView? _view;
    private Vst3Plugin? _plugin;
    private readonly ManualResetEventSlim _ready = new();
    private Exception? _openError;

    public string SlotId = "";
    /// <summary>窗口完全关闭（视图已 Detach/Dispose）后回调。由 UI 线程触发，引擎负责回收插件实例。</summary>
    public Action<VstEditorWindow>? OnClosed;

    /// <summary>开窗口并挂载插件视图（任意线程调用；视图创建在内部 UI 线程）。失败抛错。</summary>
    public void Open(Vst3Plugin plugin, string title)
    {
        _plugin = plugin;
        _thread = new Thread(() => UiThreadMain(title)) { IsBackground = true, Name = "VstEditor" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        _ready.Wait(TimeSpan.FromSeconds(15));
        if (_openError is not null) throw _openError;
        if (_hwnd == IntPtr.Zero) throw new InvalidOperationException("插件界面创建超时");
        try { SetForegroundWindow(_hwnd); } catch { }
    }

    /// <summary>请求关闭（任意线程；实际清理在 UI 线程消息循环里完成）。</summary>
    public void Close()
    {
        var h = _hwnd;
        if (h != IntPtr.Zero) PostMessageW(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }

    private static void EnsureClass()
    {
        if (_classReady) return;
        try { SetProcessDPIAware(); } catch { }
        var wc = new WNDCLASS
        {
            lpfnWndProc = _wndProc,
            hInstance = GetModuleHandleW(null),
            hCursor = LoadCursorW(IntPtr.Zero, new IntPtr(32512)), // IDC_ARROW
            lpszClassName = "AnnieVstEditor"
        };
        var atom = RegisterClassW(ref wc);
        if (atom == 0 && Marshal.GetLastWin32Error() != 1410) // 1410 = 类已注册
            throw new InvalidOperationException($"注册窗口类失败（Win32 错误 {Marshal.GetLastWin32Error()}）");
        _classReady = true;
    }

    private void UiThreadMain(string title)
    {
        try
        {
            EnsureClass();
            uint style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
            _hwnd = CreateWindowExW(0, "AnnieVstEditor", title, style,
                200, 120, 640, 420, IntPtr.Zero, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
            if (_hwnd == IntPtr.Zero)
                throw new InvalidOperationException($"创建宿主窗口失败（Win32 错误 {Marshal.GetLastWin32Error()}）");

            _view = _plugin!.CreateView();           // 插件不支持编辑器时返回 null 或抛错
            if (_view is null) throw new InvalidOperationException("该插件没有原生界面");
            _view.AttachTo(_hwnd, 1.0f);

            var size = _view.GetSize();
            if (size.Width > 0 && size.Height > 0)
            {
                var rc = new RECT { right = size.Width, bottom = size.Height };
                AdjustWindowRect(ref rc, style, false);
                SetWindowPos(_hwnd, IntPtr.Zero, 0, 0, rc.right - rc.left, rc.bottom - rc.top, SWP_NOMOVE | SWP_NOZORDER);
            }
            // 插件内部布局变化（如折叠面板）→ 跟随调整窗口
            _view.Resized += (_, sz) =>
            {
                var rc2 = new RECT { right = sz.Width, bottom = sz.Height };
                AdjustWindowRect(ref rc2, style, false);
                SetWindowPos(_hwnd, IntPtr.Zero, 0, 0, rc2.right - rc2.left, rc2.bottom - rc2.top, SWP_NOMOVE | SWP_NOZORDER);
            };
            _current = this;
            ShowWindow(_hwnd, SW_SHOW);
            _ready.Set();
        }
        catch (Exception ex) { _openError = ex; _ready.Set(); return; }

        // 消息循环：窗口销毁前一直转
        while (GetMessageW(out var msg, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
    }

    private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        var self = _current;
        if (self is not null && hWnd == self._hwnd)
        {
            if (msg == WM_CLOSE) { DestroyWindow(hWnd); return IntPtr.Zero; }
            if (msg == WM_DESTROY)
            {
                // 视图清理必须在 UI 线程（VST3 规范）
                try { self._view?.Detach(); } catch { }
                try { self._view?.Dispose(); } catch { }
                self._view = null;
                self._hwnd = IntPtr.Zero;
                _current = null;
                PostQuitMessage(0);
                // 通知引擎回收插件实例（引擎内部自行加锁）
                try { self.OnClosed?.Invoke(self); } catch { }
                return IntPtr.Zero;
            }
        }
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }
}
