import Foundation

/// ⚠️ 2026-10-24（用户要求「关闭 App 时那些服务要一起关闭」）：
/// App 退出时停止所有后台服务：
///   · connect-proxy（8443）
///   · QEMU wrapper（12340）
///   · 登录 VM（annie-am-login）
///
/// 注意：
///   1. 不能在 applicationWillTerminate 里访问 window（已释放会崩溃，见 App.swift 注释）
///   2. VM 停止较慢（10~20 秒）→ 异步执行，不阻塞退出
enum ServiceShutdown {
    static func run() {
        fputs("[EXIT] 正在停止后台服务…\n", stderr)
        // 1. connect-proxy（快）
        ConnectProxyManager.shared.stop()
        // 2. QEMU wrapper（快）
        killByPattern("wrapper-lite-qemu")
        killByPattern("qemu-system-x86_64")
        // 3. 登录 VM（慢 → 后台异步）
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/limactl")
            p.arguments = ["stop", "annie-am-login", "-f"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
            fputs("[EXIT] 登录 VM 已停止\n", stderr)
        }
    }

    private static func killByPattern(_ pattern: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        p.arguments = ["-9", "-f", pattern]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
    }
}
