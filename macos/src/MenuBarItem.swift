import AppKit

/// ⚠️ 2026-10-24（用户反馈「设置里的使用说明是 Windows 版」+ 排查发现）：
///   macOS 版**完全没有实现菜单栏图标（托盘）**，也没有「关闭到托盘」。
///   但前端帮助文档、设置里大量写着「托盘」「任务栏」—— 全是 Windows 文案。
///   这里补上 macOS 的等价实现：
///     · 菜单栏图标（NSStatusItem）
///     · 显示/隐藏主窗口、上一首/播放暂停/下一首、退出
///     · 关闭按钮行为：ask / tray（隐藏窗口驻留菜单栏）/ quit
final class MenuBarItem: NSObject {
    static let shared = MenuBarItem()

    private var statusItem: NSStatusItem?
    private var playing = false

    private let behaviorKey = "annie.ui.closeBehavior"

    /// 关闭按钮行为：ask（每次询问）/ tray（最小化到菜单栏）/ quit（退出）
    var closeBehavior: String {
        get { UserDefaults.standard.string(forKey: behaviorKey) ?? "ask" }
        set { UserDefaults.standard.set(newValue, forKey: behaviorKey) }
    }

    // MARK: - 菜单栏图标

    func install() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = item.button {
            btn.image = NSImage(systemSymbolName: "music.note",
                                accessibilityDescription: "安妮播放器")
            btn.image?.isTemplate = true
            btn.toolTip = "安妮播放器"
        }
        item.menu = buildMenu()
        statusItem = item
        fputs("[MENUBAR] 菜单栏图标已创建\n", stderr)
    }

    private func buildMenu() -> NSMenu {
        let m = NSMenu()
        m.addItem(withTitle: "显示／隐藏主窗口", action: #selector(toggleWindow), keyEquivalent: "").target = self
        m.addItem(.separator())
        m.addItem(withTitle: "上一首", action: #selector(prevTrack), keyEquivalent: "").target = self
        let play = m.addItem(withTitle: "播放／暂停", action: #selector(togglePlay), keyEquivalent: "").target = self
        _ = play
        m.addItem(withTitle: "下一首", action: #selector(nextTrack), keyEquivalent: "").target = self
        m.addItem(.separator())
        // ⚠️ 2026-10-24（用户反馈「解锁按钮没了/点不到」）：
        //   菜单栏提供永远不会被遮挡的解锁入口（桌面歌词锁定时窗口穿透，
        //   主窗口可能被别的窗口盖住，只有菜单栏一定可点）。
        let dlItem = m.addItem(withTitle: "显示/隐藏桌面歌词", action: #selector(toggleDlyrics), keyEquivalent: "").target = self
        _ = dlItem
        m.addItem(withTitle: "解锁桌面歌词", action: #selector(unlockDlyrics), keyEquivalent: "").target = self
        m.addItem(.separator())
        m.addItem(withTitle: "退出安妮播放器", action: #selector(quit), keyEquivalent: "q").target = self
        return m
    }

    // MARK: - 动作

    @objc private func toggleWindow() {
        guard let w = NSApp.windows.first(where: { $0.canBecomeMain }) else { return }
        if w.isVisible && w.isKeyWindow {
            w.orderOut(nil)
        } else {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc private func toggleDlyrics() {
        _ = DesktopLyricsWindow.shared.toggle()
    }
    @objc private func unlockDlyrics() {
        DesktopLyricsWindow.shared.ctl(["locked": false])
        fputs("[MENUBAR] 桌面歌词已解锁\n", stderr)
    }

    @objc private func prevTrack()  { sendCommand("prev") }
    @objc private func togglePlay() { sendCommand("playpause") }
    @objc private func nextTrack()  { sendCommand("next") }
    @objc private func quit()       { NSApp.terminate(nil) }

    private func sendCommand(_ cmd: String) {
        let js = "window.__dlyricsCmd && window.__dlyricsCmd(\"\(cmd)\");"
        DispatchQueue.main.async {
            Bridge.shared.webView?.evaluateJavaScript(js) { _, _ in }
        }
    }

    // MARK: - 关闭行为

    /// 用户点窗口关闭按钮时调用。返回 true = 真的关闭窗口。
    func handleWindowClose() -> Bool {
        switch closeBehavior {
        case "tray":
            // 隐藏窗口，App 驻留菜单栏（macOS 的叫法不是"托盘"）
            NSApp.windows.first(where: { $0.canBecomeMain })?.orderOut(nil)
            notifyFrontendHidden()
            fputs("[MENUBAR] 窗口已隐藏，驻留菜单栏\n", stderr)
            return false
        case "quit":
            return true
        default:
            // ask：默认隐藏到菜单栏（macOS 用户不习惯被弹窗打断）
            NSApp.windows.first(where: { $0.canBecomeMain })?.orderOut(nil)
            notifyFrontendHidden()
            return false
        }
    }

    private func notifyFrontendHidden() {
        DispatchQueue.main.async {
            Bridge.shared.webView?.evaluateJavaScript(
                "window.__miniHiddenToTray && window.__miniHiddenToTray();") { _, _ in }
        }
    }
}
