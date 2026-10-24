import Foundation

/// ⚠️ 2026-10-24（用户要求「拖进应用文件夹一步完成全部部署」）：
///   App 首次启动时自动创建/部署登录服务 VM（annie-am-login）。
///   所需资源全部打包在 App bundle 的 Resources/lima/ 下：
///     · limactl            内置 Lima 运行时（免 brew）
///     · ubuntu.img         Ubuntu 24.04 云镜像（免下载）
///     · am-login-package/  am-login-server + Android wrapper
///     · annie-am-login.yaml Lima 模板
///   流程：检测 VM → 不存在 → 内置 limactl create → 启动 → 部署 am-login → 验证 /ping
final class VMInstaller {
    static let shared = VMInstaller()

    static let vmName = "annie-am-login"
    private let logURL = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Logs/AppleMusicDL/vm-install.log")

    private func log(_ s: String) {
        let line = "[VM-INSTALL] \(s)\n"
        fputs(line, stderr)
        if let data = line.data(using: .utf8) {
            try? FileManager.default.createDirectory(
                at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let h = try? FileHandle(forWritingTo: logURL) {
                h.seekToEndOfFile(); h.write(data); try? h.close()
            } else {
                try? data.write(to: logURL)
            }
        }
    }

    // MARK: - 运行时资产（大二进制，不进 git）

    /// ⚠️ 2026-10-24（macOS 线规范）：
    ///   ubuntu.img(588MB) / limactl(31MB) / wrapper-pkg(111MB) 不进 git 仓库，
    ///   托管在固定 tag 的 prerelease 资产里（仿 Windows 线 wrapper-lite 的做法）。
    ///   首次运行时如缺失，自动从该 Release 下载。
    static let runtimeTag = "mac-runtime-v1"
    static let runtimeRepo = "Zhou1019-1/AnniePlayer-LXversion"
    static var runtimeBase: String {
        // 允许用环境变量覆盖（本地调试 / 私有镜像）
        if let override = ProcessInfo.processInfo.environment["MAC_RUNTIME_BASE"], !override.isEmpty {
            return override
        }
        return "https://github.com/\(runtimeRepo)/releases/download/\(runtimeTag)"
    }

    /// ⚠️ 2026-10-24（优化下载体积）：
    ///   运行时依赖一律从**官方源**下载，不依赖本仓库的 Release 资产：
    ///     · ubuntu.img    → Ubuntu 官方云镜像
    ///     · limactl       → lima 官方 GitHub Release
    ///     · wrapper-lite  → 本仓库已有的 wrapper-lite-v1 Release
    ///     · wrapper-pkg   → 已打包进 App（assets/wrapper-pkg.zip，49MB）
    static let ubuntuURL = "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img"
    static let limaVersion = "2.2.1"
    static var limaURL: String {
        "https://github.com/lima-vm/lima/releases/download/v\(limaVersion)/lima-\(limaVersion)-Darwin-arm64.tar.gz"
    }
    static var wrapperLiteURL: String {
        "https://github.com/\(runtimeRepo)/releases/download/wrapper-lite-v1/wrapper-lite.zip"
    }

    /// 下载单个运行时资产到指定路径（失败返回 false，不抛错）
    @discardableResult
    func downloadRuntimeAsset(_ name: String, to dest: URL, minBytes: Int64 = 1024) -> Bool {
        let dir = dest.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = "\(Self.runtimeBase)/\(name)"
        log("下载运行时资产: \(name) → \(dest.path)")
        for attempt in 1...3 {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
            p.arguments = ["-fsSL", "-C", "-", "--retry", "2", "--connect-timeout", "20",
                           "--max-time", "1800", "-o", dest.path, url]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
            let sz = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? Int64) ?? 0
            if sz >= minBytes { return true }
            log("\(name) 第 \(attempt) 次下载未完成（\(sz) 字节）")
            usleep(1_500_000)
        }
        return false
    }

    /// 确保 limactl 存在（内置 → 系统 → 下载）
    private func ensureLimactl() -> String? {
        if let existing = limactlPath() { return existing }
        // 下载到 App 的 Resources/lima/ 下（可写性：用户级 Application Support 兜底）
        let destDir = resourcesDir ?? URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/AnniePlayer/lima")
        // 从 lima 官方 Release 下载（tar.gz 里含 limactl）
        guard let r = resourcesDir else { return nil }
        let dest = destDir.appendingPathComponent("limactl")
        try? FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)
        let tgz = destDir.appendingPathComponent("lima.tar.gz")
        let url = Self.limaURL
        log("下载 limactl: \(url)")
        for attempt in 1...3 {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
            p.arguments = ["-fsSL", "--retry", "1", "--connect-timeout", "20",
                           "--max-time", "600", "-o", tgz.path, url]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run(); p.waitUntilExit()
            if FileManager.default.fileExists(atPath: tgz.path) {
                // 解包取 limactl
                let tar = Process()
                tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
                tar.arguments = ["-xzf", tgz.path, "-C", destDir.path]
                try? tar.run(); tar.waitUntilExit()
                if FileManager.default.fileExists(atPath: dest.path) {
                    try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dest.path)
                    self.limactlDownloaded = dest.path
                    log("limactl 下载完成")
                    return dest.path
                }
            }
            log("limactl 第 \(attempt) 次尝试失败")
            usleep(1_500_000)
        }
        _ = r
        return nil
    }

    /// 下载到的 limactl 路径（resourcesDir 找不到时用）
    private var limactlDownloaded: String?

    /// 资源目录（bundle 内或开发目录）
    private var resourcesDir: URL? {
        let candidates = [
            Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/lima"),
            URL(fileURLWithPath: NSHomeDirectory() + "/.dsh/annie-mac/lima-assets"),
            URL(fileURLWithPath: NSHomeDirectory() + "/anie-dmg-assets"),
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// 内置 limactl（无 bundle 时回退系统 limactl）
    private func limactlPath() -> String? {
        if let r = resourcesDir?.appendingPathComponent("limactl"),
           FileManager.default.isExecutableFile(atPath: r.path) {
            return r.path
        }
        // 下载缓存的 limactl
        let cache = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/AnniePlayer/lima/limactl")
        if FileManager.default.isExecutableFile(atPath: cache.path) { return cache.path }
        for p in ["/opt/homebrew/bin/limactl", "/usr/local/bin/limactl"] {
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    /// 登录 VM 是否已存在且可用
    func vmReady() -> Bool {
        guard let lima = limactlPath() else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: lima)
        p.arguments = ["list"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        try? p.run(); p.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return out.contains(Self.vmName)
    }

    /// 服务 /ping 是否可用
    func serviceAlive() -> Bool {
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        var req = URLRequest(url: URL(string: "http://127.0.0.1:12341/ping")!)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let d = data, String(data: d, encoding: .utf8)?.contains("\"ok\"") == true { ok = true }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 3)
        return ok
    }

    /// ⚠️ 主流程：确保登录 VM 就绪（首次启动调用，可能耗时 5~10 分钟）
    /// 进度回调在主线程调用（可用于界面提示）
    func ensureLoginVM(progress: @escaping (String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            func emit(_ msg: String) {
                self.log(msg)
                DispatchQueue.main.async { progress(msg) }
            }
            // 1. 服务已在跑 → 完成
            if self.serviceAlive() { emit("登录服务已就绪"); return }
            // 2. VM 存在但没启动 → 启动
            guard let lima = self.limactlPath() else {
                emit("找不到 Lima（内置/系统都没有），无法自动配置登录服务")
                return
            }
            if self.vmReady() {
                emit("启动已存在的登录 VM…")
                self.run(lima, ["start", Self.vmName, "--tty=false"], timeout: 300)
                if self.serviceAlive() { emit("登录服务已就绪"); return }
            } else {
                // 3. 首次安装：用内置 Lima + 预置镜像创建 VM
                guard let r = self.resourcesDir else {
                    emit("找不到内置安装资源（Resources/lima）")
                    return
                }
                let yaml = r.appendingPathComponent("annie-am-login.yaml").path
                let img = r.appendingPathComponent("ubuntu.img").path
                if !FileManager.default.fileExists(atPath: img) {
                    // ⚠️ 2026-10-24：内置镜像缺失时自动下载（用用户自己的网络）。
                    emit("正在下载 Ubuntu 镜像（约 588MB，首次安装需要）…")
                    if !self.downloadUbuntuImage(to: img) {
                        emit("Ubuntu 镜像下载失败，请检查网络后重启 App 重试")
                        return
                    }
                    emit("镜像下载完成，继续创建 VM…")
                }
                emit("正在创建登录 VM（首次安装约 5~10 分钟）…")
                // Lima 支持本地镜像：模板里用 file:// 或直接复制到缓存
                let tmpYaml = self.prepareYaml(template: yaml, imagePath: img)
                self.run(lima, ["create", "--name=\(Self.vmName)", tmpYaml, "--tty=false"], timeout: 900)
                emit("VM 已创建，正在启动…")
                self.run(lima, ["start", Self.vmName, "--tty=false"], timeout: 600)
                if !self.serviceAlive() {
                    emit("登录服务启动失败，请查看日志")
                    return
                }
            }
            // 4. 部署 am-login 包（首次）
            guard let r = self.resourcesDir,
                  FileManager.default.fileExists(atPath: r.appendingPathComponent("am-login-package").path) else {
                emit("登录服务包缺失")
                return
            }
            emit("正在部署登录服务…")
            self.deployAmLogin(lima: lima, resources: r)
            if self.serviceAlive() { emit("✅ 登录服务部署完成") } else { emit("⚠️ 部署后服务未响应") }
        }
    }

    // MARK: - 辅助

    /// ⚠️ 2026-10-24：自动下载 Ubuntu 镜像（断点续传 + 重试）
    private func downloadUbuntuImage(to path: String) -> Bool {
        let url = Self.ubuntuURL
        for attempt in 1...40 {
            log("下载镜像 第 \(attempt) 次尝试")
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
            p.arguments = ["-sL", "-C", "-", "--max-time", "300",
                           "--speed-limit", "5000", "--speed-time", "20",
                           "-o", path, url]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
            let sz = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int64) ?? 0
            log("下载进度: \(sz / 1024 / 1024)MB")
            if sz > 600_000_000 { return true }
            usleep(1_000_000)
        }
        return false
    }

    private func prepareYaml(template: String, imagePath: String) -> String {
        // 把模板里的远程镜像地址替换成本地 file:// 地址
        let tmp = NSTemporaryDirectory() + "annie-am-login-local.yaml"
        var text = (try? String(contentsOfFile: template, encoding: .utf8)) ?? ""
        if let range = text.range(of: "location: \"https://cloud-images.ubuntu.com") {
            let end = text[range.lowerBound...].firstIndex(of: "\n") ?? text.endIndex
            let line = text[range.lowerBound..<end]
            // 保留缩进，替换 location 行
            text = text.replacingOccurrences(of: String(line),
                                             with: "  - location: \"file://\(imagePath)\"\n    arch: \"aarch64\"")
        }
        try? text.write(toFile: tmp, atomically: true, encoding: .utf8)
        return tmp
    }

    @discardableResult
    private func run(_ bin: String, _ args: [String], timeout: TimeInterval) -> Int32 {
        log("run: \(bin) \(args.joined(separator: " "))")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { log("启动失败: \(error.localizedDescription)"); return -1 }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(200_000) }
        if p.isRunning { p.terminate() }
        return p.terminationStatus
    }

    private func deployAmLogin(lima: String, resources: URL) {
        let pkg = resources.appendingPathComponent("am-login-package")
        let tarPath = NSTemporaryDirectory() + "am-login-pkg.tar.gz"
        // 打包 am-login 包
        run("/usr/bin/tar", ["-C", pkg.deletingLastPathComponent().path,
                             "-czf", tarPath, pkg.lastPathComponent], timeout: 120)
        // 复制到 VM
        run(lima, ["copy", tarPath, "\(Self.vmName):/tmp/am-login-pkg.tar.gz"], timeout: 300)
        // VM 内安装
        let script = """
        set -e
        mkdir -p /opt/am-login
        cp /tmp/am-login-export/am-login-server.py /opt/am-login/ 2>/dev/null || true
        cp /tmp/am-login-export/run-main.sh /opt/am-login/ 2>/dev/null || true
        cp /tmp/am-login-export/device.txt /opt/am-login/ 2>/dev/null || true
        tar -xzf /tmp/am-login-pkg.tar.gz -C /tmp/ 2>/dev/null || true
        if [ -d /tmp/am-login-export/wrapper-pkg ]; then
          cp -R /tmp/am-login-export/wrapper-pkg /opt/am-login/ 2>/dev/null || true
        fi
        chmod +x /opt/am-login/run-main.sh 2>/dev/null || true
        cat > /etc/systemd/system/am-login.service << 'EOF'
        [Unit]
        Description=Apple Music login manager (VM resident)
        After=network.target

        [Service]
        Type=simple
        User=root
        ExecStart=/usr/bin/python3 /opt/am-login/am-login-server.py
        Restart=always
        RestartSec=2

        [Install]
        WantedBy=multi-user.target
        EOF
        systemctl daemon-reload
        systemctl enable --now am-login
        """
        let tmpScript = NSTemporaryDirectory() + "deploy-am-login.sh"
        try? script.write(toFile: tmpScript, atomically: true, encoding: .utf8)
        run(lima, ["copy", tmpScript, "\(Self.vmName):/tmp/deploy.sh"], timeout: 120)
        run(lima, ["shell", Self.vmName, "sudo", "bash", "/tmp/deploy.sh"], timeout: 300)
        log("am-login 部署完成")
    }
}
