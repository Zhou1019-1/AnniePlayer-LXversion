// 安妮播放器 macOS 版
//
// 目标（用户 2026-10-21）：
//   「只要能在 mac 上完整实现它的功能就行」
//
// 方案：
//   WKWebView 加载他们的完整 UI（HTML/CSS/JS 全跨平台）
//   Swift 实现 window.mine 桥接 + 音频引擎
//
//   ┌─────────────── SwiftUI 窗口 ───────────────┐
//   │  WKWebView（他们的 UI）                     │
//   │     ↓ window.mine.<method>()                │
//   │  JS Bridge（我们实现，转成原生调用）          │
//   │     ↓                                        │
//   │  引擎：搜索 / 解密 / 播放（AVPlayer）         │
//   └──────────────────────────────────────────────┘

import SwiftUI
import WebKit
import AVFoundation
import Combine

// ⚠️ 用纯 AppKit 创建窗口（2026-10-21）：
//    SwiftUI 的 WindowGroup 在无 nib 的 App bundle 里有时不创建窗口，
//    进程直接退出（exit 0 但无窗口）。改用 NSWindow + NSWindowController 最稳。
@main
final class AppMain {
    static func main() {
        fputs("=== AnnieMac 启动 ===\n", stderr)
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        // ⚠️ setActivationPolicy 必须在 run() 之前，但要在 delegate 设置之后
        // （顺序错了会卡在 run 里，didFinishLaunching 永远不触发）
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!

    /// 构建菜单栏
    /// ⚠️ 2026-10-22：必须有「编辑」菜单，否则 ⌘V/⌘C/⌘X/⌘A/⌘Z 在 WKWebView 里全部失效。
    private func setupMenuBar() {
        let mainMenu = NSMenu()

        // ---- 应用菜单 ----
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        let appName = "安妮播放器"
        appMenu.addItem(withTitle: "关于 \(appName)", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // ---- 编辑菜单（关键！粘贴/复制/全选/撤销都靠它）----
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())
        // 网页里的查找
        let findItem = editMenu.addItem(withTitle: "查找", action: nil, keyEquivalent: "")
        let findMenu = NSMenu(title: "查找")
        findItem.submenu = findMenu
        let find = findMenu.addItem(withTitle: "查找…", action: #selector(performFind), keyEquivalent: "f")
        find.target = self

        // ---- 窗口菜单 ----
        let winItem = NSMenuItem()
        mainMenu.addItem(winItem)
        let winMenu = NSMenu(title: "窗口")
        winItem.submenu = winMenu
        winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winMenu.addItem(.separator())
        winMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.windowsMenu = winMenu

        // ---- 播放控制（方便用键盘）----
        let playItem = NSMenuItem()
        mainMenu.addItem(playItem)
        let playMenu = NSMenu(title: "播放")
        playItem.submenu = playMenu
        let playPause = playMenu.addItem(withTitle: "播放/暂停", action: #selector(togglePlayPause), keyEquivalent: " ")
        playPause.target = self
        playMenu.addItem(withTitle: "上一首", action: #selector(prevTrack), keyEquivalent: "")
        playMenu.addItem(withTitle: "下一首", action: #selector(nextTrack), keyEquivalent: "")

        NSApp.mainMenu = mainMenu
        fputs("菜单栏已创建（编辑菜单含粘贴 ⌘V）\n", stderr)
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(nil)
    }

    @objc private func performFind() {
        // WKWebView 内置查找
        for w in NSApp.windows {
            if let wv = findWebView(in: w.contentView) {
                let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 60),
                                    styleMask: [.titled, .closable], backing: .buffered, defer: false)
                panel.title = "查找"
                let field = NSTextField(frame: NSRect(x: 10, y: 15, width: 380, height: 30))
                field.placeholderString = "在当前页面查找…"
                panel.contentView?.addSubview(field)
                if let win = w as? NSWindow {
                    win.beginSheet(panel, completionHandler: nil)
                } else {
                    panel.makeKeyAndOrderFront(nil)
                }
                _ = wv
                break
            }
        }
    }

    private func findWebView(in view: NSView?) -> WKWebView? {
        guard let v = view else { return nil }
        if let wv = v as? WKWebView { return wv }
        for sub in v.subviews {
            if let wv = findWebView(in: sub) { return wv }
        }
        return nil
    }

    @objc private func togglePlayPause() {
        Bridge.shared.webView?.evaluateJavaScript(
            "window.__annieAMInternal && window.__annieAMInternal.togglePlay && window.__annieAMInternal.togglePlay()",
            completionHandler: nil)
    }
    @objc private func prevTrack() {
        Bridge.shared.webView?.evaluateJavaScript(
            "window.__annieAMInternal && window.__annieAMInternal.prevStream && window.__annieAMInternal.prevStream()",
            completionHandler: nil)
    }
    @objc private func nextTrack() {
        Bridge.shared.webView?.evaluateJavaScript(
            "window.__annieAMInternal && window.__annieAMInternal.nextStream && window.__annieAMInternal.nextStream()",
            completionHandler: nil)
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        // ⚠️ 全局异常捕获（2026-10-21）：
        //    之前点播放/收藏会闪退，日志只有 EXC_BREAKPOINT + AppKit _crashOnException，
        //    看不到具体异常。装上 handler 把异常信息写到 stderr。
        NSSetUncaughtExceptionHandler { ex in
            var msg = "=== 未捕获异常 ===\n"
            msg += "名称: \(ex.name.rawValue)\n"
            msg += "原因: \(ex.reason ?? "nil")\n"
            msg += "调用栈:\n"
            for frame in ex.callStackReturnAddresses {
                msg += "  \(frame)\n"
            }
            if let syms = ex.callStackSymbols as [String]? {
                for s in syms.prefix(20) { msg += "  \(s)\n" }
            }
            fputs(msg, stderr)
        }
        fputs("applicationDidFinishLaunching\n", stderr)
        NSApp.setActivationPolicy(.regular)

        // ⚠️ 2026-10-22 新增菜单栏（关键修复）：
        //    macOS 的 ⌘V / ⌘C / ⌘A / ⌘Z 等快捷键是**通过菜单项的 keyEquivalent 派发**的，
        //    没有菜单栏 → 这些快捷键全部失效 → WKWebView 输入框无法粘贴。
        //    用户反馈「无法用 command 快捷指令粘贴账号进输入框」就是这个原因。
        //    这里构建标准 App / 编辑 / 窗口菜单。
        setupMenuBar()

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 860),
            // ⚠️ 用 fullSizeContentView（2026-10-21 v4）：
            //    用户要「窗口真全屏」效果——网页铺满整个窗口（含红绿灯那一栏），
            //    播放器内容右移 80px 给红绿灯让位。
            //    拖动窗口由顶部透明拖拽层负责（见 setupDragArea）。
            styleMask: [.titled, .closable, .miniaturizable, .resizable,
                        .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        // ⚠️ 2026-10-23：交给 ARC 管理窗口生命周期（默认 true 会在 close 时
        //   自动 release，强引用 window 会变悬垂指针 → 退出时 objc_retain 崩溃）。
        window.isReleasedWhenClosed = false
        window.title = "安妮播放器"
        // ⚠️ 标题栏配色（2026-10-21 v3）：
        //    v2 用了 titlebarAppearsTransparent = true，结果标题栏完全透明
        //    → 能看见桌面（用户反馈「红绿灯那一栏透明」）。
        //    正解：标题栏**不透明**，底色由 window.backgroundColor 提供；
        //    用 titlebarSeparatorStyle=.none 去掉分隔线，视觉上和内容连成一体。
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        // ⚠️ 跟随系统外观（2026-10-21 修）：
        //    之前硬编码 .darkAqua，导致 Mac 切浅色模式时窗口还是深色。
        //    置 nil = 跟随系统。
        window.appearance = nil
        window.isOpaque = true
        // ⚠️ 2026-10-23 修复「启动白屏 + 浅色/深色对不上」：
        //    原来窗口底色硬编码 #1e1e1e（深色），系统切浅色时窗口边框仍是深色，
        //    而 WKWebView 在 HTML 首帧前会画自己的白色底 → 开屏先白一下再变深。
        //    改成 NSColor(name:) 动态色：由系统外观（darkAqua/aqua）自动取深浅两套，
        //    同色同时赋给 window / bgView / webView.underPageBackgroundColor，
        //    这样开屏阶段和网页首帧之间不会出现色差或白屏。
        // 色值与 index.html 里 boot-splash 的 --bs-bg 完全一致（深 #16181d / 浅 #f6f4ef），
        // 这样「窗口 → WebView 首帧 → 开屏加载动画」三个阶段是同一种底色，无白屏无跳色。
        let dynamicBg = NSColor(name: nil) { appearance -> NSColor in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            if isDark {
                return NSColor(srgbRed: 0x16 / 255.0, green: 0x18 / 255.0,
                               blue: 0x1d / 255.0, alpha: 1.0)
            } else {
                return NSColor(srgbRed: 0xf6 / 255.0, green: 0xf4 / 255.0,
                               blue: 0xef / 255.0, alpha: 1.0)
            }
        }
        // ⚠️ 2026-10-23：同样避免动态色在启动早期解析成浅色 →
        //   按系统深色偏好取实色（与 boot-splash 的 --bs-bg 一致）。
        let _isDarkBoot = UserDefaults.standard.string(forKey: "AppleInterfaceStyle") == "Dark"
        let solidBg: NSColor = _isDarkBoot
            ? NSColor(srgbRed: 0x16 / 255.0, green: 0x18 / 255.0, blue: 0x1d / 255.0, alpha: 1.0)
            : NSColor(srgbRed: 0xf6 / 255.0, green: 0xf4 / 255.0, blue: 0xef / 255.0, alpha: 1.0)
        window.backgroundColor = solidBg
        // 底层背景视图：垫在 webView 下面（内容区底色）。
        //   · 初始色用**动态色**（跟随系统深浅），避免浅色模式下露出深色底；
        //   · 之后网页切主题时由 BackgroundBridge 更新成网页给出的具体色（setWindowBg）。
        let bgView = NSView()
        bgView.wantsLayer = true
        bgView.layer?.backgroundColor = solidBg.cgColor
        window.contentView?.addSubview(bgView)
        bgView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            bgView.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            bgView.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            bgView.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            bgView.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor),
        ])
        BackgroundBridge.shared.view = bgView
        window.center()
        window.setFrameAutosaveName("AnnieMainWindow")
        window.minSize = NSSize(width: 1100, height: 700)
        // ⚠️ 2026-10-23 修复「从迷你模式关闭 App，重开还是小窗口」：
        //   setFrameAutosaveName 会把迷你尺寸（360×150）也存下来，
        //   下次启动直接恢复成迷你大小。这里在启动时检测并强制回正常尺寸。
        let restored = window.frame
        if restored.width < 600 || restored.height < 400 {
            fputs("检测到上次以迷你尺寸退出（\(Int(restored.width))×\(Int(restored.height))），恢复默认窗口\n", stderr)
            window.setContentSize(NSSize(width: 1280, height: 820))
            window.center()
        }


        fputs("准备创建 webView\n", stderr)
        let web = makeWebView()
        fputs("webView 创建完成\n", stderr)
        // ⚠️ 用 contentLayoutGuide（2026-10-21）：
        //    直接把 web 设为 contentView 会让它铺满整个窗口（含标题栏区域），
        //    拖标题栏时会落进网页的鼠标事件里 → 选中文字、拖不动窗口。
        //    改成加到 contentView 上、约束到 contentLayoutGuide，
        //    这样网页从标题栏**下方**开始，标题栏区域完全归系统处理（原生拖拽）。
        let container = NSView()
        container.wantsLayer = true
        window.contentView = container
        container.addSubview(web)

        // ⚠️ 启动遮罩（原生）：盖在 webView 上方，遮住「导航期间 WKWebView 白底」。
        //    必须在 web 之后 addSubview 才能盖住它；由 Bridge 的 didFinish 导航回调移除。
        BootOverlayView.shared.attach(to: container, color: dynamicBg)
        web.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: container.topAnchor),
            web.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        // ⚠️ 2026-10-22 移除顶部原生拖拽层（用户反馈「顶部播放器控件无法交互，按住会拖动窗口」）：
        //    这个 DragBarView 是盖在 WKWebView 上的原生 NSView，
        //    从 x=80 横跨到 x=(宽-260)、高 76px —— 正好压住播放控件和进度条，
        //    把所有鼠标事件都变成「拖动窗口」，控件点不了。
        //    改成：拖拽交给网页自己处理（见下方 setupDragWebView），
        //    只在没有控件的空白区域拖。

        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)
        fputs("窗口已显示\n", stderr)

        // ⚠️ 2026-10-23：暂停启动预热 —— 与首播解密并发时 4+4 个 JSContext
        //    同时编译 wasm 会互相抢 CPU，实测反而让首次解密更慢（卡住 45s+）。
        //    等确认安全的预热方式（如单 worker 预热）再启用。
        // DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
        //     TemariWasm.shared.warmup()
        // }

        // ⚠️ 2026-10-24：App 启动时自动确保 connect-proxy 运行（8443）。
        //   AM 登录/播放的 QEMU 需要走这个 CONNECT 代理访问 Apple 服务器
        //   （VM/QEMU 无法直连 gsa.apple.com）。之前它是手动启动的，没跑就会登录失败。
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            ConnectProxyManager.shared.ensureRunning()
        }

        // ⚠️ 2026-10-24：安装菜单栏图标（macOS 的「托盘」等价物）。
        //   排查发现 macOS 版完全没实现，但帮助文档/设置里全是「托盘」文案。
        MenuBarItem.shared.install()
        // 窗口关闭行为交给 MenuBarItem 决定（最小化到菜单栏 / 直接退出）
        if let w = NSApp.windows.first(where: { $0.canBecomeMain }) { w.delegate = self }

        // ⚠️ 2026-10-24（用户要求「拖进应用文件夹一步完成全部部署」）：
        //   App 启动后自动检测/创建登录服务 VM（首次安装 5~10 分钟，后台执行）。
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) {
            VMInstaller.shared.ensureLoginVM { msg in
                fputs("[BOOT] 登录服务: \(msg)\n", stderr)
            }
        }

        // ⚠️ 2026-10-23：启动后自动拉起 Apple Music 解密服务（QEMU wrapper-lite）。
        //   之前 App 不负责启动服务，重启电脑/重启 App 后 AM 全部失效（表现为「熄火」）。
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
            Task { await LoginBridge.shared.ensureServiceRunning() }
        }

        // 调试：执行任意 JS
        // ⚠️ 2026-10-24 调试注入：启动后自动开桌面歌词（不锁定）
        if ProcessInfo.processInfo.environment["ANNIE_DLYRICS_OPEN"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 10.0) {
                if !DesktopLyricsWindow.shared.isShown { _ = DesktopLyricsWindow.shared.toggle() }
                fputs("[DEBUG] 已自动开启桌面歌词\n", stderr)
            }
        }

        // ⚠️ 2026-10-24 调试注入：启动后自动开桌面歌词并锁定（用于验证穿透/解锁按钮）
        if ProcessInfo.processInfo.environment["ANNIE_DLYRICS_LOCKED"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 8.0) {
                if !DesktopLyricsWindow.shared.isShown { _ = DesktopLyricsWindow.shared.toggle() }
                DesktopLyricsWindow.shared.ctl(["locked": true])
                fputs("[DEBUG] 已自动开启并锁定桌面歌词\n", stderr)
            }
        }

        if let code = ProcessInfo.processInfo.environment["ANNIE_EVAL"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
                Bridge.shared.webView?.evaluateJavaScript(code) { r, e in
                    fputs("EVAL结果: \(r ?? "nil")\nerr: \(e?.localizedDescription ?? "")\n", stderr)
                }
            }
        }

        // 调试：如果设置了 ANNIE_AUTOCLICK，加载完后自动点「下一步」
        if let sel = ProcessInfo.processInfo.environment["ANNIE_AUTOCLICK"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) {
                let js = """
                (function(){
                  var out = [];
                  out.push('body children: ' + document.body.children.length);
                  out.push('all buttons: ' + document.querySelectorAll('button').length);
                  var btns = document.querySelectorAll('button.ob-btn');
                  out.push('ob-btn: ' + btns.length);
                  if (btns.length > 0) {
                    for (var j = 0; j < btns.length; j++) {
                      out.push('  btn[' + j + ']: "' + btns[j].textContent.trim() + '"');
                      if (btns[j].textContent.trim() === '\(sel)') {
                        btns[j].click();
                        out.push('CLICKED');
                        return out.join(' | ');
                      }
                    }
                  }
                  // 兜底：所有可见按钮
                  var all = document.querySelectorAll('button, [role=button]');
                  for (var i = 0; i < all.length; i++) {
                    var t = (all[i].textContent || '').trim();
                    if (t === '\(sel)') {
                      all[i].click();
                      out.push('CLICKED(all)');
                      return out.join(' | ');
                    }
                  }
                  out.push('NOT FOUND');
                  return out.join(' | ');
                })();
                """
                Bridge.shared.webView?.evaluateJavaScript(js) { r, e in
                    fputs("自动点击结果: \(r ?? "nil") err=\(e?.localizedDescription ?? "")\n", stderr)
                }
            }
        }
    }

    // ⚠️ 2026-10-23 删除 applicationWillTerminate 中的窗口恢复逻辑（崩溃修复）：
    //   崩溃堆栈：objc_retain → AppDelegate.applicationWillTerminate → SIGSEGV。
    //   原因：NSWindow 默认 isReleasedWhenClosed = true，关闭/退出流程中窗口已 dealloc，
    //   此时访问 self.window 或调用 setFrame 会碰到悬垂指针 → EXC_BAD_ACCESS。
    //
    //   不需要在这里恢复窗口尺寸：setFrameAutosaveName 保存的是关闭时的 frame，
    //   而 App 启动时有「检测到迷你尺寸（<600×400）→ 恢复默认窗口」的校正逻辑
    //   （见 makeWebView 里的 restored 检查），完全覆盖这个场景。

    // ⚠️ 2026-10-24（用户要求）：App 退出时停止所有后台服务。
    //   注意：这里不能访问 window（可能已释放 → objc_retain 崩溃，历史踩坑）。
    func applicationWillTerminate(_ notification: Notification) {
        ServiceShutdown.run()
    }

    /// ⚠️ 2026-10-24：关闭按钮 → 按「设置 → 关闭行为」处理
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        MenuBarItem.shared.handleWindowClose()
    }

    /// ⚠️ 2026-10-24：关闭按钮按「设置 → 关闭行为」处理（菜单栏驻留 / 直接退出）
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool {
        // 窗口关闭后不退出 App（驻留菜单栏）；只有用户从菜单栏选「退出」才退出
        false
    }
}

// MARK: - 背景色桥（日夜模式）

/// 网页切换主题时，同步更新窗口底层背景色，保证标题栏和内容一致。
final class BackgroundBridge {
    static let shared = BackgroundBridge()
    weak var view: NSView?
    private init() {}

    /// 设置背景色（hex 字符串，如 "#1e1e1e"）
    func setColor(_ hex: String) {
        var h = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if h.hasPrefix("#") { h = String(h.dropFirst()) }
        guard h.count == 6, let v = UInt32(h, radix: 16) else { return }
        let r = CGFloat((v >> 16) & 0xFF) / 255.0
        let g = CGFloat((v >> 8) & 0xFF) / 255.0
        let b = CGFloat(v & 0xFF) / 255.0
        DispatchQueue.main.async { [weak self] in
            self?.view?.layer?.backgroundColor = NSColor(srgbRed: r, green: g, blue: b, alpha: 1).cgColor
        }
    }
}

// MARK: - 顶栏拖拽区域

/// 盖在顶栏上的透明视图，按住可以拖动窗口。
/// 只占顶栏中间一段（左侧 84px 留给红绿灯，右侧 120px 留给工具按钮）。
final class DragBarView: NSView {
    override func mouseDown(with event: NSEvent) {
        // 双击 → 最大化/还原（和系统标题栏行为一致）
        if event.clickCount == 2 {
            window?.zoom(nil)
            return
        }
        window?.performDrag(with: event)
    }
    override func hitTest(_ point: NSPoint) -> NSView? {
        // 只有点在自己身上才拦截；子视图（按钮）正常响应
        return super.hitTest(point)
    }
}

// MARK: - 创建 WKWebView

func makeWebView() -> WKWebView {
    fputs("  makeWebView 进入\n", stderr)
    let cfg = WKWebViewConfiguration()
    cfg.mediaTypesRequiringUserActionForPlayback = []

    fputs("  config 创建完成\n", stderr)
    fputs("  注入桥接脚本…\n", stderr)
    let userScript = WKUserScript(
        source: Bridge.fullInjectJS,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: false
    )
    cfg.userContentController.addUserScript(userScript)
    fputs("  注册消息处理器…\n", stderr)
    for name in Bridge.messageNames {
        cfg.userContentController.add(Bridge.shared, name: name)
    }

    fputs("  准备创建 WKWebView\n", stderr)
    let web = WKWebView(frame: .zero, configuration: cfg)
    fputs("  WKWebView 创建完成\n", stderr)
    web.navigationDelegate = Bridge.shared
    web.uiDelegate = Bridge.shared

    // ⚠️ 2026-10-22：backdrop-filter 的尝试与结论
    //    · drawsBackground=false ← 试过，无效，且可能破坏渲染路径，已移除
    //    · 本 App 的 WKWebView（macOS 27.2）实测完全不渲染 backdrop-filter：
    //        CSS.supports("backdrop-filter","blur(10px)") === true
    //        getComputedStyle(el).backdropFilter        === "none"
    //      祖先链也干净（无 filter/transform/opacity 阻断）。
    //    · 结论：走 CSS 渐变 + 更高不透明度的替代方案（见 am.css）。
    web.setValue(true, forKey: "drawsBackground")
    // ⚠️ 2026-10-23 消除开屏白屏：
    //    WKWebView 在页面首帧渲染前会先画自己的默认白底（underPageBackgroundColor 默认白），
    //    本地 HTTP 加载 + JS 解析期间就表现为「白屏一会儿才出现加载动画」。
    //    这里把 underPageBackgroundColor 设成和窗口一致的动态色（跟随系统深浅）。
    if #available(macOS 12.0, *) {
        web.underPageBackgroundColor = NSColor(name: nil) { appearance -> NSColor in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            if isDark {
                return NSColor(srgbRed: 0x16 / 255.0, green: 0x18 / 255.0,
                               blue: 0x1d / 255.0, alpha: 1.0)
            } else {
                return NSColor(srgbRed: 0xf6 / 255.0, green: 0xf4 / 255.0,
                               blue: 0xef / 255.0, alpha: 1.0)
            }
        }
    }

    // 找 UI 资源目录
    // ⚠️ 必须用 HTTP 服务加载，不能用 loadFileURL（2026-10-21）：
    //    file:// 协议下 ES module import 会被 CORS 拦住，
    //    洛雪 SDK 是纯 ESM，必须走 http://
    let webDir = Bundle.main.resourceURL?.appendingPathComponent("web")
    if let dir = webDir, FileManager.default.fileExists(atPath: dir.path) {
        do {
            let port = try LocalServer.shared.start(rootDir: dir)
            let url = URL(string: "http://127.0.0.1:\(port)/index.html")!
            fputs("本地服务: http://127.0.0.1:\(port)  目录: \(dir.path)\n", stderr)

            // ⚠️ 2026-10-23 修复「启动黑-白-黑闪烁」：
            //    WKWebView 在**导航完成前**会画自己的白色画布（underPageBackgroundColor
            //    只作用于已加载页面的透明区域，管不到首帧之前的空白）。
            //    先同步 loadHTMLString 一个纯色占位页（不需要网络，立刻渲染），
            //    再导航到真正的 UI —— 导航期间 WebView 保持旧页面，于是：
            //      窗口底色 → 占位页纯色 → 真页面
            //    全程同色，不再闪白。
            // ⚠️ 2026-10-23 修：这里**不能用 NSApp.effectiveAppearance** ——
            //    App 启动早期它还没应用系统外观，返回默认 aqua（浅色），
            //    结果占位页用了浅色 #f6f4ef → 深色系统下先闪一大块白（实测抓到）。
            //    改用系统级 UserDefaults 判断（深色模式时 "AppleInterfaceStyle" == "Dark"，
            //    浅色模式下该键不存在）。
            let isDark = (UserDefaults.standard.string(forKey: "AppleInterfaceStyle") == "Dark")
            let bootBg = isDark ? "#16181d" : "#f6f4ef"
            web.loadHTMLString(
                "<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<style>html,body{margin:0;padding:0;height:100%;background:" + bootBg + ";}</style>"
                + "</head><body></body></html>",
                baseURL: nil)
            // 等占位页真正渲染一帧后再导航（直接同步 load 可能被 WebKit 合并掉）
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                web.load(URLRequest(url: url))
            }
        } catch {
            fputs("❌ 本地服务启动失败: \(error)\n", stderr)
            web.loadHTMLString("<h1>本地服务启动失败</h1><p>\(error)</p>", baseURL: nil)
        }
    } else {
        fputs("❌ 找不到 index.html，resourceURL=\(Bundle.main.resourceURL?.path ?? "nil")\n", stderr)
        web.loadHTMLString(
            "<h1 style='font-family:sans-serif'>找不到 UI 资源</h1>" +
            "<p>请把 annie/renderer/ 的内容放进 App 的 Resources/web/</p>",
            baseURL: nil)
    }
    Bridge.shared.webView = web
    return web
}

