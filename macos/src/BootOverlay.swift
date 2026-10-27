// 启动遮罩（原生 NSView）
//
// ⚠️ 为什么需要（2026-10-23）：
//    WKWebView 在 `load(URLRequest)` 后、新页面首帧渲染前，会清掉旧页面并画自己的
//    白色画布 —— 实测启动时会有约 0.9 秒纯白（截图抓到 RGB 255,255,255）。
//    underPageBackgroundColor 管不到这个阶段，loadHTMLString 占位页也会被导航清掉。
//    唯一可靠做法：用一个和主题同色的原生 NSView 盖在 WKWebView 上方，
//    等 didFinish 导航完成（网页首帧就绪）后再淡出移除。

import AppKit

final class BootOverlayView: NSView {
    static let shared = BootOverlayView()

    private var dismissed = false

    private override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }
    required init?(coder: NSCoder) { fatalError() }

    /// 挂到窗口内容视图上并铺满（必须在 webView 之后 addSubview 才能盖在它上面）
    ///
    /// ⚠️ 2026-10-23 白屏最终根因修复：
    ///   参数 color 是 NSColor(name:) 动态色，直接取 `.cgColor` 时会按**当前 appearance**
    ///   解析 —— 而 App 启动早期 effectiveAppearance 还停在 aqua（浅色），
    ///   于是遮罩被画成 #f6f4ef（近白）→ 用户看到 2 秒白屏。
    ///   这里不用动态色，改为按系统深色偏好显式取实色（和 index.html 的 --bs-bg 一致）。
    func attach(to container: NSView, color: NSColor) {
        let isDark = UserDefaults.standard.string(forKey: "AppleInterfaceStyle") == "Dark"
        let solid: NSColor = isDark
            ? NSColor(srgbRed: 0x16 / 255.0, green: 0x18 / 255.0, blue: 0x1d / 255.0, alpha: 1.0)
            : NSColor(srgbRed: 0xf6 / 255.0, green: 0xf4 / 255.0, blue: 0xef / 255.0, alpha: 1.0)
        fputs("[BOOT] 遮罩颜色 \(isDark ? "深" : "浅")色\n", stderr)
        layer?.backgroundColor = solid.cgColor
        translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(self)
        NSLayoutConstraint.activate([
            topAnchor.constraint(equalTo: container.topAnchor),
            leadingAnchor.constraint(equalTo: container.leadingAnchor),
            trailingAnchor.constraint(equalTo: container.trailingAnchor),
            bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        // 兜底：8 秒后强制退出（防止 didFinish 因页面错误不触发）
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            self?.dismiss()
        }
    }

    /// 网页首帧就绪后淡出移除
    func dismiss() {
        guard !dismissed, superview != nil else { return }
        dismissed = true
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.22
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            self?.removeFromSuperview()
        })
    }
}
