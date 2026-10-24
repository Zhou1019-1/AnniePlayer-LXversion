import Foundation

/// ⚠️ 2026-10-24：ConnectProxy 管理器
/// App 启动时自动确保 8443 的 CONNECT 代理在跑（AM 登录/播放必需）。
/// 代理脚本随 App 分发（Resources/scripts/connect-proxy.py）。
final class ConnectProxyManager {
    static let shared = ConnectProxyManager()
    private var proc: Process?
    private let port = 8443

    /// 确保代理运行（已在跑则跳过）
    func ensureRunning() {
        if portInUse() { return }
        guard let script = scriptPath() else {
            fputs("[PROXY] 找不到 connect-proxy.py\n", stderr)
            return
        }
        let python = findPython()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = [script.path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            proc = p
            fputs("[PROXY] 已启动 connect-proxy (8443) pid=\(p.processIdentifier)\n", stderr)
            // 等端口就绪
            for _ in 0..<20 {
                usleep(200_000)
                if portInUse() { break }
            }
        } catch {
            fputs("[PROXY] 启动失败: \(error.localizedDescription)\n", stderr)
        }
    }

    /// 停止代理（App 退出时调用）
    func stop() {
        if let p = proc, p.isRunning {
            p.terminate()
            fputs("[PROXY] 已停止 connect-proxy\n", stderr)
        }
        proc = nil
        // 兜底：按名字杀掉（可能是上次残留）
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        kill.arguments = ["-f", "connect-proxy.py"]
        try? kill.run()
    }

    private func scriptPath() -> URL? {
        let candidates = [
            Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/scripts/connect-proxy.py"),
            URL(fileURLWithPath: NSHomeDirectory() + "/.dsh/annie-mac/assets/connect-proxy.py"),
            URL(fileURLWithPath: "/tmp/connect-proxy.py"),
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private func findPython() -> String {
        for p in ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]
        where FileManager.default.isExecutableFile(atPath: p) {
            return p
        }
        return "/usr/bin/python3"
    }

    private func portInUse() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        p.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run(); p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
