import AppKit
import WebKit

/// ⚠️ 2026-10-24（用户反馈「桌面歌词功能没做」）：
///   前端 desktop-lyrics.html 早就写好了（透明窗、逐字卡拉OK、悬停工具条），
///   但 Swift 侧只把 dlyricsToggle 映射到 dlyricsSet（只存设置，不建窗口）→ 功能等于没有。
///   这里实现真正的桌面歌词窗口：
///     · 无边框 + 透明 + 置顶 + 不进 Dock
///     · 可拖动（页面内 -webkit-app-region: drag）
///     · 十字穿透可选（鼠标穿透，不影响下层的操作）
///     · 通过 evaluateJavaScript 推送歌词行（onDlyricsLine）
/// ⚠️ 2026-10-24 修复「点歌词会把主界面弹出来」：
///   NSPanel 的 .nonactivatingPanel 还不够 —— 只要窗口能成为 key window，
///   点击就会激活整个 App（macOS 随即把主窗口带到最前）。
///   必须重写 canBecomeKey / canBecomeMain 返回 false，让点击只作用于窗口本身。
/// ⚠️ 2026-10-24：WKWebView 被点击时会抢第一响应者并向系统请求激活 App，
///   即使宿主是 nonactivating panel 也挡不住 → 主窗口被带前。
///   桌面歌词只做展示+按钮，不需要键盘焦点，直接禁止它成为第一响应者。
final class NoFocusWebView: WKWebView {
    override func becomeFirstResponder() -> Bool { false }

    /// ⚠️ 2026-10-24（用户反馈「桌面歌词无法移动」）：
    ///   网页里的 `-webkit-app-region: drag` 是 Electron 特性，**WKWebView 不认**，
    ///   所以之前完全拖不动。这里用原生 mouseDown → NSWindow.performDrag 实现拖动。
    ///   右上角的工具条 / 自定义面板区域仍交给网页处理（否则点不到按钮）。
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let w = bounds.width
        // WKWebView 是 flipped：y=0 在顶部
        let inToolbar = (p.x > w - 330 && p.y < 46)
        let inPanel = (p.x > w - 250 && p.y < 270)
        if inToolbar || inPanel {
            super.mouseDown(with: event)
            return
        }
        window?.performDrag(with: event)
    }
}

/// ⚠️ 2026-10-24：解锁按钮不能用 NSButton —— 按钮的标准点击流程会激活 App
///   （即便宿主是 nonactivatingPanel）。用自定义 NSView + mouseDown 直接回调，
///   不进入任何窗口激活/焦点路径。
final class UnlockView: NSView {
    var onClick: (() -> Void)?
    override var acceptsFirstResponder: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        let size = bounds.width
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.5, dy: 0.5))
        NSColor(calibratedWhite: 0.10, alpha: 0.92).setFill()
        circle.fill()
        NSColor(calibratedWhite: 1, alpha: 0.30).setStroke()
        circle.lineWidth = 1
        circle.stroke()
        // 锁图标（SF Symbol 画到指定 rect）
        if let img = NSImage(systemSymbolName: "lock.fill", accessibilityDescription: nil) {
            let cfg = NSImage.SymbolConfiguration(pointSize: size * 0.42, weight: .semibold)
            if let sym = img.withSymbolConfiguration(cfg) {
                let tinted = NSImage(size: sym.size, flipped: false) { r in
                    sym.draw(in: r)
                    NSColor(calibratedRed: 1, green: 0.82, blue: 0.25, alpha: 1).set()
                    r.fill(using: .sourceAtop)
                    return true
                }
                let w = tinted.size.width, h = tinted.size.height
                tinted.draw(in: NSRect(x: (size - w) / 2, y: (size - h) / 2, width: w, height: h))
            }
        }
    }
    override func mouseDown(with event: NSEvent) {
        onClick?()
    }
}

final class LyricsPanel: NSPanel {
    // ⚠️ 2026-10-24 关键修正：
    //   之前重写 canBecomeKey=false 反而**破坏了 nonactivatingPanel 机制** ——
    //   macOS 对「不能成为 key 的窗口」被点击时走 click-through 路径，
    //   会把点击转成「激活 App」→ 主窗口弹出。
    //   正确做法：让面板能成为 key（nonactivatingPanel 会保证激活不传递给 App），
    //   配合 becomesKeyOnlyIfNeeded + 不抢焦点的 WKWebView 子类。
    override var canBecomeMain: Bool { false }
}

final class DesktopLyricsWindow: NSObject {
    static let shared = DesktopLyricsWindow()

    private var window: NSWindow?
    private var webView: WKWebView?
    private var server: LocalServer?
    private var passThrough = false;
    private var locked = false
    private var hoverTimer: Timer?
    private var mouseMonitor: Any?

    var isShown: Bool { window?.isVisible ?? false }

    // MARK: - 开关

    @discardableResult
    func toggle() -> [String: Any] {
        // ⚠️ 2026-10-24：Bridge 的调用可能来自后台线程，而 NSWindow/WKWebView
        //   必须在主线程创建（否则挂起或崩溃 → 前端 await 永远不返回）。
        if !Thread.isMainThread {
            // ⚠️ 用 async 而不是 sync：Bridge 的调用链可能正等待主线程回包，
            //   sync 到主线程会互相等待 → 死锁 → 前端 await 永不返回。
            DispatchQueue.main.async { _ = self.toggle() }
            return ["ok": true, "shown": true]   // 乐观值（前端随后由事件同步）
        }
        fputs("[DLYRICS] toggle 开始 isShown=\(isShown)\n", stderr)
        if isShown { hide(); return ["ok": true, "shown": false] }
        show()
        fputs("[DLYRICS] toggle 结束 shown=\(isShown)\n", stderr)
        return ["ok": true, "shown": isShown]
    }

    func show() {
        if !Thread.isMainThread {
            DispatchQueue.main.async { self.show() }
            return
        }
        if window == nil { create() }
        window?.orderFrontRegardless()
        fputs("[DLYRICS] show 完成\n", stderr)
        notifyMainState(true)
    }

    func hide() {
        if !Thread.isMainThread {
            DispatchQueue.main.async { self.hide() }
            return
        }
        window?.orderOut(nil)
        notifyMainState(false)
    }

    /// ⚠️ 2026-10-24 修复「点桌面歌词的 ✕ 后主界面图标没变成关闭状态」：
    ///   主界面图标靠 `annie-dlyrics-changed` 事件更新，而这个事件由主窗口的
    ///   proUi.js 在 dispatch 时发出。桌面歌词窗口的 ✕ 直接调 mine.dlyricsToggle()
    ///   → 只在 Swift 侧隐藏窗口 → 主窗口完全不知道 → 图标状态不动。
    ///   这里统一在主窗口里派发事件 + 同步 __dlyrOn 标记。
    /// ⚠️ 2026-10-24（用户要求）：
    ///   锁定后 → 鼠标必须能穿透到后面的应用（点击不被歌词窗挡住）；
    ///   但检测到鼠标移入歌词区域时，仍要在「居中正上方」浮现解锁按钮。
    ///
    ///   ⚠️ 关键矛盾：ignoresMouseEvents=true 会让窗口完全收不到鼠标事件，
    ///   就没法知道鼠标进来了。解法：用全局鼠标位置轮询（NSEvent.mouseLocation），
    ///   只在不锁定（可交互）时才让窗口接收鼠标；锁定时窗口穿透 + 轮询检测位置。
    private func setLocked(_ on: Bool) {
        // ⚠️ 2026-10-24：Bridge 调用可能来自后台线程，Timer 必须在主线程 RunLoop 才会触发。
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in self?.setLocked(on) }
            return
        }
        locked = on
        guard let win = window else { return }
        if on {
            // ⚠️ 2026-10-24（用户要求，第三版）：
            //   ① 锁定后主歌词窗口**永远穿透** → 点击可直接操作下面任何窗口/App
            //   ② 鼠标经过歌词区域 → 在独立小窗口里浮现 🔒（可点，不激活 App）
            //   ③ 点 🔒 → 解锁
            win.ignoresMouseEvents = true          // 永远穿透
            win.isMovableByWindowBackground = false
            lastInside = false
            startMouseTracking()
            webView?.evaluateJavaScript("window.__dlyricsLockSet && window.__dlyricsLockSet(true);") { _, _ in }
            fputs("[DLYRICS] 锁定：歌词窗口穿透 + 独立解锁按钮轮询\n", stderr)
        } else {
            win.ignoresMouseEvents = false
            win.isMovableByWindowBackground = false
            // ⚠️ 2026-10-24（用户要求）：未锁定状态下鼠标扫过就要浮现工具条，
            //   不要点击才出现。透明 WKWebView 里 :hover/mouseenter 不可靠，
            //   所以解锁态也保持全局轮询，用它驱动网页的 .hover 类。
            lastInside = false
            hideUnlockPanel()
            startMouseTracking()
            webView?.evaluateJavaScript("window.__dlyricsLockSet && window.__dlyricsLockSet(false);") { _, _ in }
            fputs("[DLYRICS] 解锁（保留光标轮询用于悬浮工具条）\n", stderr)
        }
    }

    // MARK: - 独立解锁按钮窗口

    private func makeUnlockPanel() -> NSPanel {
        // ⚠️ 2026-10-24（用户反馈「锁图标挡住歌词」）：44 → 22（缩小 50%）
        let size: CGFloat = 22
        let p = LyricsPanel(contentRect: NSRect(x: 0, y: 0, width: size, height: size),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        p.level = .floating
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isMovableByWindowBackground = false
        p.isReleasedWhenClosed = false
        p.becomesKeyOnlyIfNeeded = true
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

        // 自定义视图（不用 NSButton，避免标准点击流程激活 App）
        let v = UnlockView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        v.onClick = { [weak self] in self?.unlockClicked() }
        p.contentView = v
        return p
    }

    @objc private func unlockClicked() {
        fputs("[DLYRICS] 解锁按钮被点击\n", stderr)
        hideUnlockPanel()
        setLocked(false)
    }

    private func showUnlockPanel() {
        guard locked, let win = window else { return }
        if unlockPanel == nil { unlockPanel = makeUnlockPanel() }
        guard let p = unlockPanel else { return }
        // 位置：歌词窗口「居中正上方」，小图标贴顶 4px（不压歌词文字行）
        let f = win.frame
        let size = p.frame.size
        let origin = NSPoint(x: f.midX - size.width / 2, y: f.maxY - size.height - 4)
        p.setFrameOrigin(origin)
        p.orderFrontRegardless()
    }

    private func hideUnlockPanel() {
        unlockPanel?.orderOut(nil)
    }

    /// 锁定态：全局轮询光标位置（0.05s ≈ 20Hz），判断是否经过歌词窗口区域。
    /// ⚠️ 用户明确要求：检测「光标经过」，不是检测点击。
    private func startMouseTracking() {
        stopMouseTracking()
        hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            self?.checkMouseInWindow()
        }
        RunLoop.main.add(hoverTimer!, forMode: .common)
    }

    private func stopMouseTracking() {
        hoverTimer?.invalidate()
        hoverTimer = nil
    }

    private var debugTick = 0
    private func checkMouseInWindow() {
        guard let win = window, win.isVisible else { return }
        let p = NSEvent.mouseLocation

        // 命中区域略微扩大 6px，光标碰到边缘就能触发
        let inside = win.frame.insetBy(dx: -6, dy: -6).contains(p)
        guard inside != lastInside else { return }
        lastInside = inside
        if locked {
            if inside {
                showUnlockPanel()
                fputs("[DLYRICS] 光标进入歌词区域 → 浮现独立解锁按钮\n", stderr)
            } else {
                hideUnlockPanel()
                fputs("[DLYRICS] 光标离开 → 隐藏解锁按钮\n", stderr)
            }
        } else {
            // 未锁定：只驱动网页悬浮工具条
            fputs("[DLYRICS] 光标\(inside ? "进入" : "离开")歌词区域 → \(inside ? "显示" : "隐藏")工具条\n", stderr)
        }
        // 通知网页：锁定态清控件；未锁定态显示/隐藏悬浮工具条
        let js = "window.__dlyricsHover && window.__dlyricsHover(\(inside));"
        webView?.evaluateJavaScript(js) { _, _ in }
    }

    private var lastInside = false
    /// ⚠️ 2026-10-24：独立的解锁按钮小窗口。
    ///   锁定后主歌词窗口必须**完全穿透**（点击直达下层窗口），
    ///   但浮现的解锁按钮又必须能点 —— 所以按钮放在独立的小 NSPanel 里，
    ///   只覆盖按钮那 44×44 区域，其余区域仍然穿透。
    private var unlockPanel: NSPanel?

    private func notifyMainState(_ on: Bool) {
        let js = """
        (function(){
          try {
            window.__dlyrOnState = \(on);
            document.dispatchEvent(new CustomEvent('annie-dlyrics-changed', {detail:{on:\(on)}}));
          } catch(e){}
        })();
        """
        DispatchQueue.main.async {
            Bridge.shared.webView?.evaluateJavaScript(js) { _, _ in }
        }
    }

    // MARK: - 创建窗口

    private func create() {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = screen.width * 0.6
        let h: CGFloat = 130
        let rect = NSRect(x: screen.midX - w / 2, y: screen.minY + 120, width: w, height: h)

        // ⚠️ 2026-10-24 修复「点歌词会把主界面弹出来」：
        //   原来用 NSWindow —— 点击歌词窗口会让整个 App 变成活跃状态，
        //   macOS 随即把 App 的主窗口带到最前 → 用户点歌词（甚至只是点浮现的锁）
        //   就看到主播放器窗口跳出来，极其烦人。
        //
        //   桌面歌词/悬浮面板的正确做法：NSPanel + .nonactivatingPanel
        //   —— 点击窗口不激活 App，也不改变其它窗口的层级。
        //   配合 becomesKeyOnlyIfNeeded（不需要键盘输入就不抢 key window）。
        let win = LyricsPanel(contentRect: rect,
                              styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = false
        win.level = .floating                 // 置顶（在所有 App 之上）
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        win.isMovableByWindowBackground = false
        win.isReleasedWhenClosed = false
        win.ignoresMouseEvents = false
        // 关键三连：不抢焦点 / 失焦不消失 / 不因 App 失活而隐藏
        win.becomesKeyOnlyIfNeeded = true
        win.isFloatingPanel = true
        win.hidesOnDeactivate = false
        win.worksWhenModal = true

        // ⚠️ 2026-10-24：复用主窗口的 LocalServer（同一端口服务整个 web/ 目录）
        //   原来想自己 new 一个 LocalServer，但它是单例（init 私有）且已完成 start(rootDir:)。
        let srv = LocalServer.shared
        server = srv

        let cfg = WKWebViewConfiguration()
        cfg.suppressesIncrementalRendering = false
        // 注入 mine 桥（只给桌面歌词需要的三个方法）
        let bridgeJS = """
        // ⚠️ 2026-10-24 修复「桌面歌词窗口开了但歌词不显示」：
        //   页面调用 window.mine.onDlyricsLine(cb) 注册回调，
        //   但注入脚本原来写的是空函数 → 回调被丢弃 → Swift 推来的行无处可去。
        //   现在把回调存到 window.__dlyricsLineCb，由 __dlyricsPush 唤醒。
        window.__dlyricsLineCb = null;
        window.mine = {
          dlyricsToggle: function(){ return window.webkit.messageHandlers.mine.postMessage(
            {name:'dlyricsToggle', args:[]}); },
          dlyricsCtl: function(o){ return window.webkit.messageHandlers.mine.postMessage(
            {name:'dlyricsCtl', args:[o]}); },
          onDlyricsLine: function(cb){ window.__dlyricsLineCb = cb; },
          copyText: function(t){ return window.webkit.messageHandlers.mine.postMessage(
            {name:'copyText', args:[t]}); }
        };
        window.__dlyricsPush = function(json){
          try {
            var d = (typeof json === 'string') ? JSON.parse(json) : json;
            if (window.__dlyricsLineCb) window.__dlyricsLineCb(d);
          } catch(e){}
        };
        """
        let uc = WKUserContentController()
        uc.addUserScript(WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        uc.add(LyricsHandler.shared, name: "mine")
        cfg.userContentController = uc

        let wv = NoFocusWebView(frame: NSRect(x: 0, y: 0, width: w, height: h),
                                configuration: cfg)
        wv.autoresizingMask = [.width, .height]
        wv.setValue(false, forKey: "drawsBackground")   // 透明
        if let url = URL(string: "http://127.0.0.1:\(srv.port)/desktop-lyrics.html") {
            wv.load(URLRequest(url: url))
            fputs("[DLYRICS] 窗口已创建，加载 \(url)\n", stderr)
        }
        win.contentView = wv
        window = win
        webView = wv
        fputs("[DLYRICS] create 完成\n", stderr)
        lastInside = false
        startMouseTracking()   // 未锁定态也要感知光标（悬浮工具条）
    }

    // MARK: - 推送歌词行

    func pushLine(_ dict: [String: Any]) {
        guard let wv = webView,
              let d = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: d, encoding: .utf8) else { return }
        let js = "window.__dlyricsPush && window.__dlyricsPush(\(s));"
        DispatchQueue.main.async { wv.evaluateJavaScript(js) { _, _ in } }
    }

    // MARK: - 控制（字号/颜色/对齐/锁定/穿透）

    func ctl(_ opts: [String: Any]) {
        if let pt = opts["passThrough"] as? Bool {
            passThrough = pt
            fputs("[DLYRICS] 鼠标穿透=\(pt)\n", stderr)
        }
        // ⚠️ 2026-10-24 关键修复：前端桌面歌词页面发的是 {lock: bool}，
        //   Swift 原来只认 {locked: bool} → 用户手动点 🔒 完全没有效果
        //   （而主窗口/Bridge 路径用 locked 所以我的自动测试一直"通过"）。
        //   两种 key 都接受。
        if let lock = (opts["locked"] as? Bool) ?? (opts["lock"] as? Bool) {
            if lock != locked { setLocked(lock) }
        }
        // 透明度（前端 apply 每次都发 {opacity: 0.55~1}，之前完全没处理）
        if let op = (opts["opacity"] as? Double) ?? (opts["opacity"] as? NSNumber)?.doubleValue {
            window?.alphaValue = CGFloat(max(0.25, min(1.0, op)))
        }
        // ⚠️ 2026-10-24（用户要求）：主窗口「亮色/暗色」按钮 → 同步桌面歌词深浅色
        if let theme = opts["theme"] as? String {
            let js = "window.__dlyricsThemeSet && window.__dlyricsThemeSet(\"\(theme)\");"
            webView?.evaluateJavaScript(js) { _, _ in }
            fputs("[DLYRICS] 深浅色 → \(theme)\n", stderr)
        }
        // ⚠️ 2026-10-24：桌面歌词工具条的上/下首/播放暂停按钮
        //   → 转发给主窗口前端执行（主窗口有完整的播放控制逻辑）。
        if let cmd = opts["cmd"] as? String, !cmd.isEmpty {
            let js = "window.__dlyricsCmd && window.__dlyricsCmd(\"\(cmd)\");"
            notifyMain(js)
            fputs("[DLYRICS] 转发播放控制: \(cmd)\n", stderr)
        }
        if let frame = opts["frame"] as? [String: Any],
           let x = frame["x"] as? Double, let y = frame["y"] as? Double,
           let w = frame["w"] as? Double, let h = frame["h"] as? Double,
           let win = window {
            win.setFrame(NSRect(x: x, y: y, width: w, height: h), display: true, animate: false)
        }
    }

    private func notifyMain(_ js: String) {
        DispatchQueue.main.async {
            Bridge.shared.webView?.evaluateJavaScript(js) { _, _ in }
        }
    }
}

/// 桌面歌词窗口的 JS 消息处理
final class LyricsHandler: NSObject, WKScriptMessageHandler {
    static let shared = LyricsHandler()
    func userContentController(_ uc: WKUserContentController, didReceive msg: WKScriptMessage) {
        guard let body = msg.body as? [String: Any],
              let name = body["name"] as? String else { return }
        let args = (body["args"] as? [Any]) ?? []
        switch name {
        case "dlyricsToggle":
            _ = DesktopLyricsWindow.shared.toggle()
        case "dlyricsCtl":
            let opts = (args.first as? [String: Any]) ?? [:]
            DesktopLyricsWindow.shared.ctl(opts)
        default:
            break
        }
    }
}
