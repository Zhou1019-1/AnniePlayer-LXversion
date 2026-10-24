// 迷你模式
//
// ⚠️ 为什么需要（2026-10-23）：
//   播放器顶栏有「迷你模式」按钮，前端调用 miniEnter / miniExit / miniPin / miniSetSize，
//   但 Bridge 里这四个方法都没实现 → 点了没反应。
//
// 功能：把主窗口缩小成一块置顶的小播放条（类似音乐 App 的 MiniPlayer），
//       退出时恢复原来的位置和尺寸。

import AppKit

final class MiniMode {
    static let shared = MiniMode()

    private var savedFrame: NSRect?
    private var savedMinSize: NSSize?
    /// 纯净模式等固定尺寸状态：此时任何 setSize 请求都被忽略
    private var fixedSize = false
    private var savedLevel: NSWindow.Level = .normal
    private var pinned = false

    private init() {}

    private var window: NSWindow? {
        (NSApp.delegate as? AppDelegate)?.window
    }

    /// 进入迷你模式（返回 ok + 当前窗口尺寸）
    func enter(size: [String: Any]?) -> [String: Any] {
        guard let w = window else { return ["ok": false, "reason": "没有窗口"] }
        if savedFrame == nil {
            savedFrame = w.frame
            savedLevel = w.level
        }
        // ⚠️ 2026-10-23：迷你模式允许自由调整窗口尺寸。
        //   主窗口的 minSize 是 1100×700（正常模式需要），但迷你窗口只有 360×154，
        //   之前靠 setFrame 强行绕过 —— 用户手动拖拽边缘时就会被 minSize 弹回去，
        //   表现为「不能自由调整大小」。这里进入迷你时把 minSize 降到 260×110，
        //   退出时恢复。
        if savedMinSize == nil { savedMinSize = w.minSize }
        // ⚠️ 2026-10-23 迷你模式尺寸规则（用户需求）：
        //   ① 只允许**等比拉伸**（contentAspectRatio = 360:154，拖任意边宽高同步）
        //   ② 最大 = 最小 × 150% → 540×231
        //   ③ 最小 360×154 保证全部图标清晰可见
        w.minSize = NSSize(width: 360, height: 154)
        w.maxSize = NSSize(width: 540, height: 231)
        w.contentAspectRatio = NSSize(width: 360, height: 154)
        // 迷你尺寸（默认 360×154，和前端 miniResize 的基准一致；可被参数覆盖）
        var width: CGFloat = 360
        var height: CGFloat = 154
        if let s = size {
            if let v = s["width"] as? Double, v > 200 { width = v }
            if let v = s["height"] as? Double, v > 60 { height = v }
        }
        var f = w.frame
        // 保持右下角位置（迷你窗贴右下角）
        let screen = w.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? f
        let maxH = screen.height - 16
        if height > maxH { height = maxH }
        f.size = NSSize(width: width, height: height)
        f.origin = NSPoint(x: screen.maxX - width - 24, y: screen.minY + 24)
        w.setFrame(f, display: true, animate: true)
        w.level = .floating
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        fixedSize = false
        // ⚠️ 2026-10-23：迷你模式下隐藏系统窗口按钮（红黄绿）。
        //   迷你窗很窄，traffic lights 会直接盖在封面/标题上（用户反馈遮挡）。
        for btn in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            w.standardWindowButton(btn)?.isHidden = true
        }
        // 通知前端切到迷你布局
        pushEvent("miniEntered", ["width": width, "height": height])
        fputs("[MINI] 进入迷你模式 \(Int(width))x\(Int(height))\n", stderr)
        return ["ok": true, "width": width, "height": height, "pinned": true]
    }

    /// 退出迷你模式，恢复原窗口
    func exit() -> [String: Any] {
        guard let w = window else { return ["ok": false] }
        if let f = savedFrame {
            w.setFrame(f, display: true, animate: true)
        } else {
            w.setContentSize(NSSize(width: 1200, height: 800))
            w.center()
        }
        w.level = savedLevel
        w.collectionBehavior = [.fullScreenPrimary]
        fixedSize = false
        // 恢复主窗口最小尺寸限制
        w.contentAspectRatio = .zero
        if let ms = savedMinSize {
            w.minSize = ms
            savedMinSize = nil
        }
        w.maxSize = NSSize(width: 10000, height: 10000)
        // 恢复系统窗口按钮
        for btn in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            w.standardWindowButton(btn)?.isHidden = false
        }
        savedFrame = nil
        pinned = false
        pushEvent("miniExited", [:])
        fputs("[MINI] 退出迷你模式\n", stderr)
        return ["ok": true]
    }

    /// 迷你窗是否置顶
    func pin(_ on: Bool) -> [String: Any] {
        guard let w = window else { return ["ok": false] }
        pinned = on
        w.level = on ? .floating : .normal
        return ["ok": true, "pinned": on]
    }

    /// 切换窗口是否可调整尺寸（纯净模式固定尺寸用）
    /// - Parameter on: true = 允许拖拽调整；false = 固定（不可调整）
    func setResizable(_ on: Bool) {
        guard let w = window else { return }
        if on {
            fixedSize = false
            if !w.styleMask.contains(.resizable) { w.styleMask.insert(.resizable) }
            // 恢复普通迷你尺寸范围 + 等比约束
            w.minSize = NSSize(width: 360, height: 154)
            w.maxSize = NSSize(width: 540, height: 231)
            w.contentAspectRatio = NSSize(width: 360, height: 154)
        } else {
            fixedSize = true
            if w.styleMask.contains(.resizable) { w.styleMask.remove(.resizable) }
            // 纯净模式固定尺寸：min = max = 当前尺寸（拖不动）
            let cur = w.frame.size
            w.minSize = cur
            w.maxSize = cur
        }
        fputs("[MINI] 可调整尺寸 = \(on)\n", stderr)
    }

    /// 调整迷你窗口尺寸
    ///
    /// ⚠️ 2026-10-23 智能定位（用户需求：「歌词展开时检测在屏幕下半区就先上移再向下延展」）：
    ///   迷你窗通常停在屏幕右下角，歌词模式从 154 高变成 560 高时，
    ///   如果还是「顶部不动向下长」，底部会直接顶出屏幕。
    ///   规则：
    ///     ① 优先保持窗口**顶部位置**不变，向下延展（视觉上歌词往下长）
    ///     ② 如果延展后底部超出屏幕可用区 → 整体上移，保证底部在屏幕内
    ///     ③ 如果顶部也放不下（窗口比屏幕还高）→ 贴屏幕顶部
    func setSize(_ size: [String: Any]) -> [String: Any] {
        guard let w = window else { return ["ok": false] }
        // ⚠️ 2026-10-23：固定尺寸状态下忽略任何尺寸调整请求
        //   （NSWindow.setFrame 会绕过 styleMask 限制，必须在这里挡掉）
        if fixedSize {
            return ["ok": false, "reason": "固定尺寸模式",
                    "width": w.frame.width, "height": w.frame.height]
        }
        var width = w.frame.width, height = w.frame.height
        let reqW = (size["width"] as? Double) ?? 0
        let reqH = (size["height"] as? Double) ?? 0
        let baseW: CGFloat = 360, baseH: CGFloat = 154
        let maxScale: CGFloat = 1.5

        // ⚠️ 2026-10-23：模式判定改为「高度 ≥ 500 = 歌词/队列展开」。
        //   之前用 reqH > 240 判歌词 → 等比拉伸请求 400x400 / 600x100 会被误判成歌词模式，
        //   结果宽高独立变化（400x400、540x100），完全破坏等比。
        //   等比拉伸由宽度驱动（拖拽时 contentAspectRatio 让系统保持比例），
        //   所以只要不是歌词展开，一律按宽度等比计算高度。
        if reqH >= 500 {
            // 歌词/队列展开（用户要求）：
            //   ① 宽度 = 展开前的宽度（前端传入，不再 clamp 到 400）
            //   ② 高度固定 560
            w.contentAspectRatio = .zero
            w.minSize = NSSize(width: 300, height: 150)
            w.maxSize = NSSize(width: 760, height: 900)
            if reqW > 0 { width = min(max(reqW, 300), 760) }
            if reqH > 0 { height = reqH }
        } else {
            // 普通迷你：等比拉伸（宽 360~540，高按 360:154 同步）
            w.contentAspectRatio = NSSize(width: baseW, height: baseH)
            w.minSize = NSSize(width: baseW, height: baseH)
            w.maxSize = NSSize(width: baseW * maxScale, height: baseH * maxScale)
            if reqW > 0 {
                width = min(max(reqW, baseW), baseW * maxScale)
                height = width * baseH / baseW
            } else if reqH > 0 {
                height = min(max(reqH, baseH), baseH * maxScale)
                width = height * baseW / baseH
            } else {
                width = min(max(width, baseW), baseW * maxScale)
                height = width * baseH / baseW
            }
        }
        var f = w.frame
        let screen = w.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? f
        // 高度上限：不超出屏幕可用区
        let maxH = screen.height - 16
        if height > maxH { height = maxH }
        let topY = f.maxY                       // 保留顶部
        var newY = topY - height                // 向下延展
        // 底部超出屏幕 → 上移（先保证底部可见）
        if newY < screen.minY {
            newY = screen.minY
        }
        // 顶部超出屏幕 → 贴顶
        if newY + height > screen.maxY {
            newY = screen.maxY - height
        }
        f.origin.y = newY
        f.size = NSSize(width: width, height: height)
        w.setFrame(f, display: true, animate: true)
        fputs("[MINI] 调整尺寸 \(Int(width))×\(Int(height)) @ y=\(Int(newY))（屏幕 \(Int(screen.minY))..\(Int(screen.maxY))）\n", stderr)
        return ["ok": true, "width": width, "height": height, "y": newY]
    }

    private func pushEvent(_ type: String, _ extra: [String: Any]) {
        var d: [String: Any] = ["type": type]
        for (k, v) in extra { d[k] = v }
        guard let data = try? JSONSerialization.data(withJSONObject: d),
              let js = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            Bridge.shared.webView?.evaluateJavaScript(
                "window.__miniEvent && window.__miniEvent(\(js));") { _, _ in }
        }
    }
}
