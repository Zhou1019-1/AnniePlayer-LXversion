// 直接控制 QEMU 的登录 —— 支持验证码注入。
//
// 背景（2026-10-18 调研结论）：
//   wrapper-lite 官方启动器 `wrapper-lite-qemu` 不支持从外部提交 2FA 验证码：
//     · --login 只吃 "账号:密码"，不给验证码的机会
//     · --code-from-file 读的是 guest 里 /data/2fa.txt，而 /data 是 data.img（ext4）
//     · 登录期间 12340 端口完全不响应 HTTP
//     · lite 也不从 stdin 读
//
// 破解办法（自己实现的）：
//   1. 解开 lite-initramfs，在 init 脚本里加几行：把 fw_cfg 里的 `2fa_code`
//      写进 /data/2fa.txt（见 assets/build-initramfs.sh）
//   2. 绕过官方启动器，直接调 qemu-system-x86_64，多传一个
//      `-fw_cfg name=2fa_code,file=...`
//   3. lite 带 --code-from-file 启动，就会读到我们放进去的验证码。
//
// 所以流程是：
//   第一次启动（没有验证码）→ lite 报 2FA: true → App 弹框要验证码
//     → 用户输入 → **重启 QEMU**，这次带上 2fa_code → 登录成功

import Foundation

// MARK: - 登录阶段

enum LoginPhase: Equatable {
    case idle
    case loggingIn          // 正在登录
    case needCode           // 需要 6 位验证码
    case needRetry          // 账号密码错
    case success            // 成功
    case failed(String)     // 失败

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
    var isNeedCode: Bool { self == .needCode }
}

final class QemuLogin: ObservableObject {
    @Published var phase: LoginPhase = .idle
    @Published var message = ""
    @Published var rawLog = ""

    /// 日志同时写到文件，方便排查（用户 2026-10-18：「要不你自己读取日志吧」）
    static let logURL: URL = {
        let d = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/AppleMusicDL")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d.appendingPathComponent("login.log")
    }()

    func logToFile(_ s: String) {
        guard let data = s.data(using: .utf8) else { return }
        let url = Self.logURL
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(data); try? h.close()
        } else {
            try? data.write(to: url)
        }
    }
    @Published var running = false
    @Published var waitSeconds = 0          // 已经等了多久（给用户看）
    @Published var prewarming = false       // 是否正在后台预热虚拟机
    @Published var prewarmReady = false     // 预热是否完成

    /// 预热用的进程（服务模式，不登录）—— 用户输密码时它已经在启动了
    private var warmProc: Process?
    /// 服务是否已就绪（外部查询用）
    var serviceReady: Bool { prewarmReady }

    let wrapperDir: URL

    private var task: Process?
    private var master: Int32 = -1
    private var readSource: (any DispatchSourceRead)?
    private var buffer = ""
    private var ticker: Timer?
    private var saw2FA = false
    private var needsCodeAlreadyHandled = false

    private var email = ""
    private var password = ""

    init(wrapperDir: URL) {
        self.wrapperDir = wrapperDir
    }

    static func `default`() -> QemuLogin {
        // ⚠️ 一定要用**可写的工作目录**，不能用 App 里那份（2026-10-18 修）：
        //    下载后直接双击打开时，macOS 会把 App translocation 到只读挂载点，
        //    往 bundle 里写 .lite-qemu-args 必然失败 →「写不了参数文件」。
        //    详见 EnvPaths.ensureWrapperRuntime。
        if let runtime = EnvPaths.ensureWrapperRuntime() {
            return QemuLogin(wrapperDir: runtime)
        }
        if let bundled = EnvPaths.bundledDepsDir() {
            return QemuLogin(wrapperDir: bundled.appendingPathComponent("wrapper-lite"))
        }
        let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                           in: .userDomainMask)[0]
            .appendingPathComponent("AppleMusicDL/wrapper")
        return QemuLogin(wrapperDir: dir)
    }

    // MARK: - 对外接口

    /// 登录成功后启动常驻服务（这样 App 就能真正下载了）
    func startService() {
        let launcher = wrapperDir.appendingPathComponent("wrapper-lite-qemu")
        guard FileManager.default.isExecutableFile(atPath: launcher.path) else {
            logToFile(">>> startService: 找不到 launcher\n"); return
        }
        if portInUse() {
            // ⚠️ 2026-10-23：端口被占不代表服务可用（可能是旧目录/旧盘的 QEMU）。
            //   这里探测一下 /status：能通才视为已启动；否则清掉占用者再启动自己的。
            let ok = statusReachable()
            if ok {
                logToFile(">>> startService: 端口已占用且服务可用，视为已启动\n")
                prewarmReady = true
                return
            }
            logToFile(">>> startService: 端口被占但服务不可用，清掉后重启\n")
            stopExistingQemuOnPort()
        }
        let p = Process()
        p.currentDirectoryURL = wrapperDir
        p.executableURL = launcher
        p.arguments = []
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            warmProc = p
            logToFile(">>> startService: 已启动，等待就绪\n")
            pollPrewarm(attempt: 0)
        } catch {
            logToFile(">>> startService 失败: \(error.localizedDescription)\n")
        }
    }

    /// 预热：App 一打开就在后台把虚拟机启动起来（服务模式，不登录）。
    /// 用户输账号密码需要十几秒，这段时间正好用来启动虚拟机 —— 并行。
    /// （用户 2026-10-18：「首次启动的时候登录和后台不能并行吗」）
    func prewarm() {
        guard warmProc?.isRunning != true, !prewarmReady else { return }
        prewarming = true
        prewarmReady = false

        let launcher = wrapperDir.appendingPathComponent("wrapper-lite-qemu")
        guard FileManager.default.isExecutableFile(atPath: launcher.path) else {
            prewarming = false
            return
        }
        let p = Process()
        p.currentDirectoryURL = wrapperDir
        p.executableURL = launcher
        p.arguments = []                                  // 服务模式
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice

        // 端口被占说明已经有服务，直接算预热完成
        if portInUse() {
            prewarming = false
            prewarmReady = true
            return
        }

        do {
            try p.run()
            warmProc = p
        } catch {
            prewarming = false
            return
        }
        // 后台轮询，就绪后标记
        pollPrewarm(attempt: 0)
    }

    private func pollPrewarm(attempt: Int) {
        if attempt > 40 {                     // 80 秒超时
            prewarming = false
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            let ready = self.portInUse()
            DispatchQueue.main.async {
                if ready {
                    self.prewarming = false
                    self.prewarmReady = true
                } else {
                    self.pollPrewarm(attempt: attempt + 1)
                }
            }
        }
    }

    /// 某个文件是否被进程占用（用 lsof 查）
    private func fileInUse(_ path: String) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        p.arguments = ["-t", path]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        try? p.run(); p.waitUntilExit()
        if let out = try? pipe.fileHandleForReading.readToEnd(),
           let str = String(data: out, encoding: .utf8) {
            return !str.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return false
    }

    /// ⚠️ 2026-10-23：登录前重置 data.img（清掉上一个账号的 token），保证真实登录。
    private func resetDataImageForLogin() {
        let dataImg = wrapperDir.appendingPathComponent("qemu/data.img")
        let template = wrapperDir.appendingPathComponent("qemu/data.img.template")
        let fm = FileManager.default
        guard fm.fileExists(atPath: template.path) else {
            logToFile(">>> [警告] data.img.template 不存在，跳过重置（可能导致复用旧登录态）\n")
            return
        }
        // 等 data.img 锁彻底释放
        for _ in 0..<20 {
            if !fileInUse(dataImg.path) { break }
            usleep(100_000)
        }
        try? fm.removeItem(at: dataImg)
        do {
            try fm.copyItem(at: template, to: dataImg)
            logToFile(">>> 登录前已重置 data.img（清除旧账号 token，强制真实登录）\n")
        } catch {
            logToFile(">>> [警告] 重置 data.img 失败: \(error.localizedDescription)\n")
        }
    }

    /// 同步检查 /status 是否可访问（用于判断端口上的服务是否真的可用）
    private func statusReachable() -> Bool {
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        var req = URLRequest(url: URL(string: "http://127.0.0.1:12340/status")!)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data,
               let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               o["code"] as? Int == 0 {
                ok = true
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2.5)
        return ok
    }

    private func portInUse() -> Bool {
        let lsof = Process()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-nP", "-iTCP:12340", "-sTCP:LISTEN"]
        lsof.standardOutput = Pipe()
        lsof.standardError = Pipe()
        try? lsof.run(); lsof.waitUntilExit()
        return lsof.terminationStatus == 0
    }

    /// 停掉预热的进程（要开始正式登录时用，因为登录要独占端口）
    private func stopPrewarm() {
        if let p = warmProc, p.isRunning {
            p.terminate()
            let pid = p.processIdentifier
            DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) {
                kill(pid, SIGKILL)
            }
        }
        warmProc = nil
        prewarming = false
        prewarmReady = false
    }

    /// ⚠️ 2026-10-23 修复「登录时服务熄火 / 登录失败代码 1」：
    ///   QemuLogin 登录要**独占** 12340 端口。但 App 的常驻服务（或此前手动启动的
    ///   wrapper-lite-qemu）也占着这个端口，而 stopPrewarm() 只能停「本对象启动的预热进程」，
    ///   管不到外部/其他目录的 QEMU。
    ///   结果：登录 QEMU 起来就被端口冲突打回 → 失败代码 1，或者把服务挤掉（熄火）。
    ///   这里在登录前把端口占用者（wrapper-lite-qemu）全部停掉，登录结束后 startService 会重启。
    private func stopExistingQemuOnPort() {
        // ⚠️ 2026-10-23 关键修复「登录成功但 token 没写入 data.img」：
        //   登录 QEMU 必须**独占** data.img。如果常驻服务 QEMU 还持有 data.img 的
        //   写锁，登录 QEMU 能正常登录（guest 内存里成功）但 token 写不进磁盘 →
        //   QEMU 退出后 token 丢失 → App 判定登录失败。
        //   所以这里除了停 12340 端口占用者，还要停掉所有持有 data.img 的 QEMU，
        //   并等待锁真正释放。
        let dataImgPath = wrapperDir.appendingPathComponent("qemu/data.img").path
        var pids: [Int32] = []
        let lsof = Process()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-nP", "-iTCP:12340", "-sTCP:LISTEN", "-t"]
        let pipe = Pipe()
        lsof.standardOutput = pipe
        lsof.standardError = FileHandle.nullDevice
        try? lsof.run(); lsof.waitUntilExit()
        if let out = try? pipe.fileHandleForReading.readToEnd(),
           let str = String(data: out, encoding: .utf8) {
            for line in str.split(separator: "\n") {
                if let pid = Int32(line.trimmingCharacters(in: .whitespaces)) {
                    pids.append(pid)
                }
            }
        }
        // 追加：找持有 data.img 的 QEMU（可能是服务 QEMU，不占端口但占盘）
        let lsof2 = Process()
        lsof2.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof2.arguments = ["-t", dataImgPath]
        let pipe2 = Pipe()
        lsof2.standardOutput = pipe2
        lsof2.standardError = FileHandle.nullDevice
        try? lsof2.run(); lsof2.waitUntilExit()
        if let out2 = try? pipe2.fileHandleForReading.readToEnd(),
           let str2 = String(data: out2, encoding: .utf8) {
            for line in str2.split(separator: "\n") {
                if let pid = Int32(line.trimmingCharacters(in: .whitespaces)),
                   !pids.contains(pid) {
                    pids.append(pid)
                }
            }
        }
        for pid in pids {
            kill(pid, SIGTERM)
            logToFile(">>> 登录前释放资源（端口/data.img）：SIGTERM \(pid)\n")
        }
        if !pids.isEmpty {
            // 等端口 + data.img 锁都释放（最多 3 秒），仍占用就强杀
            for _ in 0..<30 {
                usleep(100_000)
                if !portInUse() && !fileInUse(dataImgPath) { break }
            }
            if portInUse() || fileInUse(dataImgPath) {
                for pid in pids {
                    kill(pid, SIGKILL)
                    logToFile(">>> 登录前强杀占用进程 \(pid)\n")
                }
                // 强杀后等锁释放（最多 2 秒）
                for _ in 0..<20 {
                    usleep(100_000)
                    if !portInUse() && !fileInUse(dataImgPath) { break }
                }
            }
            logToFile(">>> 登录前资源状态: 端口占用=\(portInUse()) data.img占用=\(fileInUse(dataImgPath))\n")
        }
    }

    /// 开始登录。code 为空 = 第一次尝试（会探出要不要验证码）
    func login(email: String, password: String, code: String? = nil) {
        self.email = email
        self.password = password
        // ⚠️ 2026-10-22：登录前记录现有 token 指纹，
        //    防止「旧 token 还在 → 失败也算成功」的误判
        capturePreLoginFingerprint()
        saw2FA = false
        needsCodeAlreadyHandled = false
        buffer = ""
        rawLog = ""
        running = true
        phase = .loggingIn
        waitSeconds = 0
        // 预热进程占着端口，正式登录要独占 → 先停掉它
        // （预热的意义在于「用户输密码时」已经把该做的工作做了，
        //   现在真正登录只是重启一次，用户感知不到额外等待）
        let wasReady = prewarmReady
        stopPrewarm()
        // ⚠️ 2026-10-23：释放端口 —— 没有这一步时，常驻服务 QEMU 会让登录 QEMU 起不来
        stopExistingQemuOnPort()
        // ⚠️ 2026-10-23 关键（用户报「陌生账号没登录过却显示登录成功」）：
        //   data.img 里如果残留上一个账号的 token，guest 的 --login 流程可能直接
        //   复用旧登录态返回 success（不真正校验新账号/密码）→ 假成功。
        //   每次登录前用「格式化空盘模板」重置 data.img，强制真实登录。
        resetDataImageForLogin()
        message = code == nil
            ? (wasReady ? "正在登录…" : "正在登录…（首次启动约 20 秒）")
            : "正在用验证码登录…"
        logToFile("\n\n===== 开始登录 \(Date()) 带验证码: \(code != nil) 预热就绪: \(wasReady) =====\n")
        logToFile("wrapperDir: \(wrapperDir.path)\n")

        launch(code: code)
        startTicker()
    }

    /// 用户输入了验证码 → 重启 QEMU 并带上验证码
    func submitCode(_ code: String) {
        let c = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !c.isEmpty else { return }
        // ⚠️ 2026-10-23 关键修复「提交验证码后提示密码错误」：
        //    cleanup() 在「检测到需要验证码」时也会执行，会把 password 清空
        //    （安全考虑，抹掉明文密码）。而这里原来是延迟 1.5 秒后再读
        //    self.password —— 那时已经是空字符串，于是第二次登录提交了**空密码**，
        //    Apple 返回「请检查你输入的账户信息是否正确」。
        //    诊断日志实测：第一次密码长度=8，第二次密码长度=0。
        //    修复：调用当下立即捕获凭据，延迟执行时用捕获的值。
        let e = email
        let p = password
        logToFile(">>> submitCode: 捕获凭据 email长度=\(e.count) password长度=\(p.count)\n")
        killQemu()
        // 稍等，让端口释放
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.login(email: e, password: p, code: c)
        }
    }

    func cancel() {
        stopTicker()
        killQemu()
        running = false
        phase = .idle
        message = ""
    }

    // MARK: - QEMU 启动

    private func launch(code: String?) {
        let q = wrapperDir.appendingPathComponent("qemu")
        // 选 QEMU：优先用 App 自带的（ARM Mac 用），没有就用系统的（Intel Mac 用）
        //
        // 为什么 Intel Mac 要用系统 QEMU（2026-10-18）：
        //   wrapper-lite 自带的 QEMU 只编译了 arm64 + 只有 tcg 加速器，
        //   Intel Mac 跑不了。但 Intel Mac 是 x86_64 架构，和 guest 一致，
        //   用系统 QEMU（brew install qemu）可以走 HVF 硬件加速，启动只要 2~3 秒。
        let bundled = q.appendingPathComponent("bin/qemu-system-x86_64")
        let qemuBin: URL
        var usingSystemQemu = false
        if isExecutableArchCompatible(bundled) {
            qemuBin = bundled
        } else if let sys = findSystemQemu() {
            qemuBin = sys
            usingSystemQemu = true
        } else {
            fail("""
            找不到可用的 QEMU。
            \(isIntelMac ? "请先执行：brew install qemu" : "安装包可能不完整")
            """)
            return
        }
        logToFile(">>> 使用 QEMU: \(qemuBin.path)（系统: \(usingSystemQemu)）\n")

        // 参数文件：让 lite 以「登录模式」跑，并且允许从文件读验证码
        let argsFile = q.appendingPathComponent(".lite-qemu-args")
        // ⚠️ 2026-10-23 关键：让 QEMU guest 走 Mac 上的 CONNECT 代理
        //    （QEMU user-mode 网络里，Mac 主机地址是 10.0.2.2）
        //    原因：VM/客户机都无法直连 gsa.apple.com（Apple 的 Anisette 认证服务器，
        //    TLS 会被阻断），而 Mac 可以。不传代理时 lite 的设备认证会失败。
        var args = ["--login", "\(email):\(password)", "--base-dir", "/data",
                    "--proxy", "http://10.0.2.2:8443"]
        // 每台机器独立的设备指纹（避免共用默认 ID 被 Apple 风控）
        if let dev = UserDefaults.standard.string(forKey: "annie.am.deviceInfo"),
           !dev.isEmpty {
            args.append("--device-info")
            args.append(dev)
        }
        if code != nil { args.append("--code-from-file") }
        // 登录完成后 lite 会直接退出，不需要它监听端口
        // 诊断日志：记录这次登录用的账号、密码长度、验证码状态（不记录密码明文）
        let maskedEmail = email.count > 3
            ? String(email.prefix(3)) + "***" + String(email.suffix(8))
            : "***"
        logToFile(">>> [诊断] 账号=\(maskedEmail) 密码长度=\(password.count) "
                  + "带验证码=\(code != nil) 参数=\(args.map { $0.contains(":") ? "<cred>" : $0 }.joined(separator: " "))\n")
        let argsText = args.map { $0 + "\n" }.joined()
        try? FileManager.default.createDirectory(at: q, withIntermediateDirectories: true)
        do {
            try argsText.write(to: argsFile, atomically: true, encoding: .utf8)
        } catch {
            // 把真实原因（只读 / 权限）带出来，别只丢一句「写不了参数文件」，
            // 否则用户和作者都猜不到是 App Translocation（2026-10-18）
            let ns = error as NSError
            let readable = ns.userInfo[NSUnderlyingErrorKey].map { "\($0)" } ?? ns.localizedDescription
            let hint = wrapperDir.path.contains("/AppTranslocation/")
                ? "\n这是系统把 App 挂到只读位置运行的，请先运行一次：\nxattr -d com.apple.quarantine \"/Applications/Apple Music 下载器.app\"\n再重新打开 App。"
                : "\n目录：\(wrapperDir.path)"
            logToFile(">>> 写参数文件失败: \(readable)\n>>> 目录: \(wrapperDir.path)\n")
            fail("写不了参数文件（\(readable)）\(hint)")
            return
        }

        // 验证码文件（写在宿主机，通过 fw_cfg 传给 guest）
        var extraFW: [String] = []
        if let code {
            let codeFile = q.appendingPathComponent(".2fa-code")
            guard (try? code.write(to: codeFile, atomically: true, encoding: .utf8)) != nil else {
                logToFile(">>> 写验证码文件失败: \(wrapperDir.path)/qemu\n")
                fail("写不了验证码文件（目录不可写：\(q.path)）"); return
            }
            extraFW = ["-fw_cfg", "name=2fa_code,file=\(codeFile.path)"]
        }

        // 自定义 initramfs 从本项目 resources 里取（它含 2fa 注入逻辑）
        let customInitrd = findCustomInitramfs()
        let initrd = customInitrd ?? q.appendingPathComponent("lite-initramfs.cpio.gz")

        var qargs: [String] = [
            "-L", q.appendingPathComponent("bin").path,
            "-accel", effectiveAccel,
            "-cpu", effectiveAccel == "hvf" ? "host" : "max",
            "-m", "512", "-smp", "2",
            "-kernel", q.appendingPathComponent("vmlinuz-lite-qemu").path,
            "-initrd", initrd.path,
            "-append", "console=ttyS0 quiet net.ifnames=0 biosdevname=0",
            "-display", "none", "-serial", "stdio", "-no-reboot",
            "-nic", "user,model=e1000",
            "-drive", "file=\(q.appendingPathComponent("data.img").path),format=raw,if=virtio",
            "-fw_cfg", "name=lite_args,file=\(argsFile.path)",
        ]
        qargs += extraFW

        // 分配 PTY 以拿到输出
        var m: Int32 = 0, s: Int32 = 0
        var ws = winsize(ws_row: 40, ws_col: 200, ws_xpixel: 0, ws_ypixel: 0)
        guard openpty(&m, &s, nil, nil, &ws) == 0 else {
            fail("无法创建终端"); return
        }
        master = m

        let t = Process()
        t.currentDirectoryURL = q
        t.executableURL = qemuBin
        t.arguments = qargs
        // ⚠️ 包里的 qemu 写死了 18 个 Homebrew 库的绝对路径
        //    （/opt/homebrew/opt/capstone/lib/libcapstone.5.dylib 等）。
        //    用户机器没装 brew → dyld: Library not loaded → QEMU 直接起不来
        //    （2026-10-18 用户日志就是这样）。包里带了 qemu/lib/ 这份拷贝，
        //    靠 DYLD_LIBRARY_PATH 让 dyld 先在这里找。
        //    注意签名：SIP 下从 AppTranslocation/受保护位置启动的子进程不会继承
        //    DYLD_* 环境变量，我们只从 ~/Library/Application Support 的可写副本启动，
        //    不受影响。
        if let env = qemuEnvironment(for: qemuBin, qemuDir: q) {
            t.environment = env
        }
        let slave = FileHandle(fileDescriptor: s, closeOnDealloc: false)
        t.standardInput = slave
        t.standardOutput = slave
        t.standardError = slave

        t.terminationHandler = { [weak self] p in
            DispatchQueue.main.async { self?.qemuExited(status: p.terminationStatus) }
        }

        do {
            try t.run()
        } catch {
            close(m); close(s); master = -1
            fail("启动 QEMU 失败：\(error.localizedDescription)")
            return
        }
        close(s)
        task = t
        startReading()
    }

    /// 包里的 qemu 需要自己的 Homebrew 依赖库（qemu/lib/）。
    ///
    /// 为什么不能只靠修改二进制里的依赖路径（install_name_tool）：
    ///   wrapper-lite 是第三方发布物，包里那份已经是它们 build 出来的成品，
    ///   动它会碰签名；用 DYLD_LIBRARY_PATH 只是运行期查找顺序，零侵入。
    ///
    /// 只在「用 App 自带的 qemu」且「包里确实有 lib/」时设置；
    /// 用系统 qemu 时不设置（系统 qemu 自己链接自己那套库）。
    private func qemuEnvironment(for qemuBin: URL, qemuDir: URL) -> [String: String]? {
        let libDir = qemuDir.appendingPathComponent("lib")
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: libDir.path, isDirectory: &isDir),
              isDir.boolValue else { return nil }
        // 系统 qemu（/opt/homebrew/bin/...）不用我们的 lib/
        if !qemuBin.path.hasPrefix(qemuDir.path) { return nil }

        var env = ProcessInfo.processInfo.environment
        let existing = env["DYLD_LIBRARY_PATH"] ?? ""
        env["DYLD_LIBRARY_PATH"] = existing.isEmpty ? libDir.path : "\(libDir.path):\(existing)"
        return env
    }

    /// 当前机器是不是 Intel Mac
    /// 实际要用的加速器。
    ///
    /// ⚠️ 不能只看是不是 Intel 就用 hvf（2026-10-19 用户报 HV_ERROR）：
    ///    黑苹果（macOS 跑在 PC 上或虚拟机里）通常没有 HVF 权限，
    ///    直接给 -accel hvf 会报 HV_ERROR (0xfae94001) 启动失败。
    /// 正确做法：Intel 上先试 hvf，跑不通就自动回退 tcg（慢但一定能用）。
    private lazy var effectiveAccel: String = {
        guard isIntelMac else { return "tcg" }        // ARM Mac 架构不同，本来就用不了 hvf
        // 用一个最小的 QEMU 调用探测 hvf 是否可用
        let q = wrapperDir.appendingPathComponent("qemu")
        if let sys = findSystemQemu() {
            let probe = Process()
            probe.executableURL = sys
            probe.arguments = ["-accel", "hvf", "-display", "none",
                               "-kernel", q.appendingPathComponent("vmlinuz-lite-qemu").path,
                               "-m", "128", "-S"]
            probe.standardOutput = Pipe()
            probe.standardError = Pipe()
            do {
                try probe.run()
                // 跑 2 秒看它是否立刻报错退出
                probe.terminate()
                probe.waitUntilExit()
                logToFile(">>> hvf 探测: 退出码 \(probe.terminationStatus)\n")
                return probe.terminationStatus == 0 ? "hvf" : "tcg"
            } catch {
                logToFile(">>> hvf 探测失败: \(error.localizedDescription)\n")
                return "tcg"
            }
        }
        return "tcg"
    }()

    /// 当前是不是 Intel Mac。
    ///
    /// ⚠️ 必须**运行时**判断，不能用 #if arch(x86_64)（2026-10-19 踩坑）：
    ///    App 是通用二进制（arm64 + x86_64 都有），
    ///    #if 是编译期宏，会把两个分支都编进去；
    ///    在 ARM Mac 上如果走了 x86_64 分支（Rosetta），
    ///    #if arch(x86_64) 会返回 true → 用 hvf 加速 → HV_ERROR 启动失败。
    ///    改成读运行时 CPU 架构才准。
    private var isIntelMac: Bool {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw -> String in
            let bytes = raw.bindMemory(to: CChar.self)
            return String(cString: bytes.baseAddress!)
        }
        return machine == "x86_64"
    }

    /// 检查这个二进制文件和当前 CPU 架构是否兼容（跑不了就返回 false）
    private func isExecutableArchCompatible(_ url: URL) -> Bool {
        guard FileManager.default.isExecutableFile(atPath: url.path) else { return false }
        // 尝试执行 `file` 判断架构
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/file")
        p.arguments = ["-b", url.path]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        try? p.run(); p.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(),
                         encoding: .utf8) ?? ""
        // 运行时架构（不是编译期）
        return out.contains(isIntelMac ? "x86_64" : "arm64")
    }

    /// 找系统装的 QEMU（Intel Mac 用这个走 HVF 加速）
    private func findSystemQemu() -> URL? {
        let candidates = ["/opt/homebrew/bin/qemu-system-x86_64",
                          "/usr/local/bin/qemu-system-x86_64",
                          "/usr/bin/qemu-system-x86_64"]
        for c in candidates where isExecutableArchCompatible(URL(fileURLWithPath: c)) {
            return URL(fileURLWithPath: c)
        }
        return nil
    }

    private func findCustomInitramfs() -> URL? {
        // 完整包里，wrapper-lite 目录下的 initramfs 已经被替换成「支持 2FA 注入」的版本，
        // 所以直接用 qemu 目录里那份即可。
        // （精简包里是官方原版，没有注入能力，但也没有登录态注入需求 —— 登录走官方流程）
        return nil
    }

    private func startReading() {
        let fd = master
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        src.setEventHandler { [weak self] in
            var buf = [UInt8](repeating: 0, count: 8192)
            let n = Darwin.read(fd, &buf, 8192)
            guard n > 0 else { return }
            let s = String(bytes: buf[0..<n], encoding: .utf8) ?? ""
            self?.consume(s)
        }
        src.resume()
        readSource = src
    }

    // MARK: - 输出解析

    private func consume(_ chunk: String) {
        buffer += chunk
        rawLog += chunk
        logToFile(chunk)
        if rawLog.count > 30000 { rawLog = String(rawLog.suffix(20000)) }
        let low = buffer.lowercased()

        // 要不要验证码。
        // ⚠️ 关键（2026-10-18 从 lite 二进制里挖出来的）：
        //   lite 需要验证码时会打印：
        //     "Enter your 2FA code into <dir>/2fa.txt"
        //   然后**等 60 秒**，超时就 "2FA code timeout (60s), aborting login"。
        //   所以监听这句话才是准的 —— 之前用 "2FA: true" 判断，
        //   但那个字段在不需要验证码时是 false、需要时也可能因为时序错过。
        let needsCode = buffer.contains("Enter your 2FA code")
            || buffer.contains("2FA: true")
        if needsCode && !needsCodeAlreadyHandled {
            saw2FA = true
            needsCodeAlreadyHandled = true
            phase = .needCode
            message = "请输入手机收到的 6 位验证码"
            logToFile("\n>>> 检测到需要验证码；当前 QEMU 会等 60 秒，\n"
                      + ">>> 用户输入后我们会重启 QEMU 并把验证码通过 fw_cfg 传进去\n")
            // 注意：先不杀 QEMU —— 让它把日志吐完整，用户输入后我们主动杀掉再重启
            stopTicker()
            return
        }

        // 成功（以 lite 的明确输出为准）
        if low.contains("login success") || low.contains("logged in successfully")
            || low.contains("token cache saved") || low.contains("logged in as") {
            finishOK(); return
        }

        // ⚠️ 2026-10-22：失败原因分类（用户要求「再出现同样问题专门做一个」）
        //    Apple 的每种错误都需要不同的处理方式，笼统的「登录失败」没法指导用户。
        //    这里把常见的 6 种情况分别识别出来，给出可操作的中文提示。
        if low.contains("login failed") || low.contains("check the account information")
            || low.contains("failed to cache account info")
            || low.contains("account is disabled") || low.contains("locked") {
            if phase != .needCode {
                if low.contains("account is disabled") {
                    // 账号被 Apple 风控锁定（最常见：新设备 + 刚改密码 + 多地登录）
                    fail("""
                    【Apple 账户因安全原因被停用】

                    Apple 官方说明（support.apple.com/102640）：
                    「此 Apple 账户因安全原因被停用 / Your account has been disabled 
                     for security reasons」→ 账户被自动锁定以保护安全。

                    常见触发原因：
                      · 近期改过密码
                      · 从新设备登录（本软件模拟的音频客户端）
                      · 密码或账户信息输错次数过多

                    ✅ 官方解决方法：重设密码
                      1. 打开 https://iforgot.apple.com
                      2. 输入该 Apple ID
                      3. 选择「重设密码」（Apple 没有「解锁账户」这个选项）
                      4. 用受信任的 iPhone 收验证码，或回答安全问题
                      5. 设置新密码
                      6. 用新密码在 iPhone「设置 → Apple ID」登录一次，确认恢复正常

                    ⚠️ 重设密码后建议等 1 小时再回来登录（风控冷却期）。

                    如果重设密码后仍提示停用：
                      · 在 iPhone 上打开「设置 → 你的名字 → 媒体与购买项目 → 查看账户」
                      · 若有「继续」提示，点一下请求重新激活
                    """)
                } else if low.contains("check the account information") {
                    fail("""
                    【账号或密码不正确】

                    请确认：
                      · Apple ID 邮箱是否完整（如 xxx@qq.com）
                      · 密码是否是最近改过的那个
                      · 有没有多打了空格

                    提示：如果刚改过密码，请用新密码。
                    """)
                } else if low.contains("locked") || low.contains("too many") {
                    fail("""
                    【登录尝试过多，已临时锁定】

                    Apple 限制短时间内多次失败登录。
                    请等待 15~30 分钟后再试，或先到 https://appleid.apple.com 确认账号状态。
                    """)
                } else if low.contains("not available in") || low.contains("country") {
                    fail("""
                    【该账号在你所在的地区不可用】

                    Apple Music 的可用性受地区限制。
                    请确认账号所属地区（如美区/国区）与网络出口一致。
                    """)
                } else if low.contains("subscription") || low.contains("no music") {
                    fail("""
                    【该账号没有 Apple Music 订阅】

                    Apple Music 播放需要有效订阅（个人/家庭/学生）。
                    请确认账号已订阅，否则只能搜索不能播放。
                    """)
                } else {
                    // 兜底：把 Apple 的原始错误带出来，方便排查
                    var raw = ""
                    for line in buffer.components(separatedBy: "\n").reversed() {
                        if line.contains("dialogHandler") || line.contains("server message") {
                            raw = line.trimmingCharacters(in: .whitespacesAndNewlines)
                            break
                        }
                    }
                    var msg = "【登录失败】\n\n"
                    if !raw.isEmpty { msg += "Apple 返回：\n" + raw + "\n\n" }
                    msg += "如需帮助，请把上面的信息反馈给开发者。"
                    fail(msg)
                }
            }
            return
        }
    }

    private func qemuExited(status: Int32) {
        running = false
        stopTicker()
        switch phase {
        case .success, .needCode:
            break
        default:
            // 以「登录态有没有写进去」为准
            if loginStateWritten() {
                finishOK()
            } else if saw2FA {
                phase = .needCode
                message = "请输入手机收到的 6 位验证码"
            } else if status == 0 {
                // ⚠️ 2026-10-23：这里原来直接报泛化文案「登录流程结束，但没拿到登录态」，
                //   导致错误密码也被显示成「没拿到登录态」（用户看到的提示）。
                //   用完整日志重新判定真实原因（账号密码错/被停用/锁定/网络等）。
                let full = (self.rawLog + "\n" + self.buffer).lowercased()
                fail(self.classifyFailure(full))
            } else {
                fail("登录失败（代码 \(status)）")
            }
        }
        cleanup()
    }

    /// 判断登录态有没有真的写进去。
    ///
    /// ⚠️ 不能用「有没有非零字节」判断（2026-10-18 修）：
    ///    data.img 是 ext4 镜像，超级块/位图/目录项本来就全是非零字节，
    ///    所以那个判断永远为 true —— 登录失败也会被当成成功，
    ///    用户看到「登录成功」但其实什么也没写进去。
    ///
    /// 正确做法：扫磁盘里有没有 lite 写的 token 特征串（JWT 的 "eyJ" 开头），
    /// 并且要排除登录前就存在的内容。
    /// 登录前 data.img 里已有的 token 标记（用于排除旧凭证误判成功）
    /// ⚠️ 2026-10-22：原来只检查「有没有 eyJ 特征」，但上次成功登录的 token
    ///    一直留在 data.img 里 → 这次登录失败（如账号被禁用）也会被判成功。
    ///    现在登录前先记录已有的 token 位置指纹，登录后要求「出现新的」
    private var preLoginTokenFingerprint: String? = nil

    /// 计算当前 data.img 里 token 特征串的指纹（位置+长度），用于比对变化
    private func tokenFingerprint() -> String {
        let img = wrapperDir.appendingPathComponent("qemu/data.img")
        guard let data = try? Data(contentsOf: img) else { return "none" }
        let marker = "eyJraWQiOi".data(using: .utf8)!
        var parts: [String] = []
        var searchStart = data.startIndex
        while let r = data.range(of: marker, in: searchStart..<data.endIndex) {
            parts.append(String(r.lowerBound))
            searchStart = r.upperBound
            if parts.count > 20 { break }   // 只记前 20 处
        }
        return parts.isEmpty ? "none" : parts.joined(separator: ",")
    }

    /// 登录前调用：记录现存 token 指纹
    func capturePreLoginFingerprint() {
        preLoginTokenFingerprint = tokenFingerprint()
        logToFile("\n>>> 登录前 token 指纹: \(preLoginTokenFingerprint ?? "nil")\n")
    }

    private func loginStateWritten() -> Bool {
        // ⚠️ 2026-10-22：必须先确认「有新 token 写入」，不能只看有没有 token
        let after = tokenFingerprint()
        if let before = preLoginTokenFingerprint, before == after {
            logToFile("\n>>> token 指纹未变化（\(after)），判定登录未写入\n")
            return false
        }
        let img = wrapperDir.appendingPathComponent("qemu/data.img")
        guard let data = try? Data(contentsOf: img) else { return false }
        // lite 的 token_cache.json 里是 JWT，必然含 eyJraWQiOi（header 开头）
        let marker = "eyJraWQiOi".data(using: .utf8)!
        if data.range(of: marker) != nil { return true }
        // 有些版本的 token 存在别处，再兜一层
        let music = "\"music_token\"".data(using: .utf8)!
        return data.range(of: music) != nil
    }

    private func finishOK() {
        guard phase != .success else { return }     // 防重复
        stopTicker()
        phase = .success
        message = "✅ 登录成功"
        running = false
        logToFile("\n>>> finishOK: 登录成功，准备启动服务\n")
        // ⚠️ 千万不能立刻 cleanup（那会 killQemu）：
        //    lite 打印 "login successful" 之后还要把 token 写进 data.img，
        //    这时候杀进程 = token 没落盘 = 「登录成功」但下次还要重登。
        //    （2026-10-18 实测踩到：日志显示 login successful，data.img 里 0 token）
        // 正确做法：最多等 15 秒让它自己退出（它写完会自己 poweroff）。
        waitForExitThenCleanup()
    }

    private func waitForExitThenCleanup() {
        var waited = 0.0
        func poll() {
            waited += 0.5
            let stillRunning = task?.isRunning ?? false
            if !stillRunning || waited > 15 {
                // lite 已经自己退出了（或等太久），这时才清理
                let ok = loginStateWritten()
                logToFile("\n>>> 登录完成后等待 \(waited) 秒，QEMU 已退出\n")
                logToFile(">>> data.img 里有 token: \(ok)\n")
                if !ok {
                    // ⚠️ 2026-10-23 修复「错误密码提示不准」：
                    //   consume() 的实时分类依赖缓冲区匹配，guest 输出分块到达时
                    //   "Check the account information" 可能跨块被拆开 → 匹配不上 →
                    //   最后落到这里显示泛泛的「登录没真正完成」。
                    //   这里用**完整 rawLog** 再判定一次真实原因，给出准确提示。
                    let full = (self.rawLog + "\n" + self.buffer).lowercased()
                    self.phase = .failed(self.classifyFailure(full))
                    self.message = self.classifyFailure(full)
                    cleanup(keepTask: false)
                } else {
                    // token 落盘成功 → 清理干净的临时文件后启动常驻服务
                    self.cleanup(keepTask: false)
                    // ⚠️ 2026-10-23：先把端口上的「旧服务」（可能是别的目录/手动启动的
                    //   wrapper-lite-qemu，data.img 里没有刚登录的 token）清掉，
                    //   否则 startService 会看到端口占用 → 视为已启动 →
                    //   服务其实还是旧盘 → /status 显示未登录（用户以为登录失败）。
                    self.stopExistingQemuOnPort()
                    self.startService()
                }
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { poll() }
        }
        poll()
    }

    /// ⚠️ 2026-10-23：从完整日志里判定登录失败的真实原因（用于 token 未写入时的兜底提示）
    private func classifyFailure(_ low: String) -> String {
        if low.contains("check the account information") || low.contains("login failed") {
            return """
            【账号或密码不正确】

            Apple 明确返回了「请检查输入的账户信息」。
            请确认：
              · Apple ID 邮箱是否完整（如 xxx@qq.com）
              · 密码是否是最近改过的那个
              · 有没有多打空格
            """
        }
        if low.contains("account is disabled") || low.contains("disabled for security") {
            return """
            【Apple 账户因安全原因被停用】

            请到 https://iforgot.apple.com 重设密码，完成后等 1 小时再试。
            """
        }
        if low.contains("locked") || low.contains("too many") {
            return "【登录尝试过多，已临时锁定】请等待 15~30 分钟后再试。"
        }
        if low.contains("2fa") || low.contains("verification") || low.contains("code") {
            return "【需要两步验证码】请输入手机收到的验证码后重试。"
        }
        if low.contains("proxy") || low.contains("network") || low.contains("timeout") {
            return "【网络错误】无法连接 Apple 服务器，请检查网络后重试。"
        }
        return "【登录没真正完成】没有拿到登录凭证，请重试。如果反复失败请告诉我。"
    }

    private func fail(_ msg: String) {
        stopTicker()
        phase = .failed(msg)
        message = msg
        running = false
        cleanup()
    }

    // MARK: - 计时 / 清理

    private func startTicker() {
        stopTicker()
        ticker = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.waitSeconds += 1
            if self.waitSeconds > 120 && self.phase == .loggingIn {
                self.fail("登录超时（2 分钟），请重试")
            }
        }
    }

    private func stopTicker() {
        ticker?.invalidate()
        ticker = nil
    }

    /// 公开的关闭方法（供退出登录调用）
    func shutdown() {
        stopPrewarm()
        killQemu()
        running = false
        fputs("QemuLogin: 已关闭\n", stderr)
    }

    private func killQemu(keepTask: Bool = false) {
        readSource?.cancel()
        readSource = nil
        if master >= 0 { close(master); master = -1 }
        if keepTask { return }
        if let t = task, t.isRunning {
            t.terminate()
            // 兜底：强杀
            let pid = t.processIdentifier
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                kill(pid, SIGKILL)
            }
        }
        task = nil
    }

    private func cleanup(keepTask: Bool = false) {
        killQemu(keepTask: keepTask)
        // 抹掉明文密码和验证码文件
        wipe(wrapperDir.appendingPathComponent("qemu/.lite-qemu-args"))
        wipe(wrapperDir.appendingPathComponent("qemu/.2fa-code"))
        password = ""
    }

    private func wipe(_ url: URL) {
        let fm = FileManager.default
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 0,
           let h = try? FileHandle(forWritingTo: url) {
            try? h.write(contentsOf: Data(repeating: 0, count: size))
            try? h.synchronize()
            try? h.close()
        }
        try? fm.removeItem(at: url)
    }
}
