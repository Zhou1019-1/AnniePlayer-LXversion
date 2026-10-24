// Apple Music 账号登录 —— 把下载器里的 QemuLogin 接到 UI 上
//
// 流程：
//   1. 用户填 Apple ID + 密码
//   2. 启动 wrapper-lite（QEMU）登录
//   3. 登录成功后，/m3u8 和 /key 就会用用户自己的账号

import Foundation

@MainActor
final class LoginBridge {
    static let shared = LoginBridge()
    private var qemu: QemuLogin?

    private init() {}

    private func ensureQemu() -> QemuLogin {
        if let q = qemu { return q }
        // wrapper-lite 在 App bundle 里（或已复制到运行时目录）
        let dir = EnvPaths.existsNoFollow(EnvPaths.wrapperRuntimeDir)
            ? EnvPaths.wrapperRuntimeDir
            : (EnvPaths.bundledWrapperDir() ?? EnvPaths.wrapperRuntimeDir)
        let q = QemuLogin(wrapperDir: dir)
        qemu = q
        return q
    }

    /// ⚠️ 2026-10-23（用户要求）：抹去设备指纹（退出登录时调用）。
    ///   清掉 UserDefaults 保存的设备指纹 → 下次登录时 LinuxWrapperLogin.deviceInfo
    ///   会自动随机生成一台全新设备并下发给 VM → Apple 侧看到的是全新设备。
    private func resetDeviceFingerprint() {
        UserDefaults.standard.removeObject(forKey: "annie.am.deviceInfo")
        fputs("[LOGOUT] 设备指纹已抹去（下次登录将使用全新随机设备）\n", stderr)
        // 让 VM 侧也忘掉旧指纹（下次登录前会把新指纹 POST 过去）
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        p.arguments = ["-s", "--max-time", "3", "-X", "POST",
                       "-H", "Content-Type: application/json",
                       "-d", "{\"info\":\"\"}", "http://127.0.0.1:12341/device"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    /// ⚠️ 2026-10-23（用户要求）：清除设备登录记录 —— 用格式化空盘模板重置 data.img。
    ///   这样「退出登录」后：旧账号 token 彻底消失、可登录任意账号、重启保持未登录。
    private func clearDeviceLoginRecord() {
        let q = ensureQemu()
        let dir = q.wrapperDir
        let dataImg = dir.appendingPathComponent("qemu/data.img")
        let template = dir.appendingPathComponent("qemu/data.img.template")
        // 1. 停掉所有 QEMU（释放 data.img 锁）
        for (bin, args) in [("/usr/bin/pkill", ["-9", "-f", "wrapper-lite-qemu"]),
                            ("/usr/bin/pkill", ["-9", "-f", "qemu-system-x86_64"])] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: bin)
            p.arguments = args
            try? p.run(); p.waitUntilExit()
        }
        Thread.sleep(forTimeInterval: 2.0)
        // 2. 用模板覆盖 data.img（彻底清空登录凭证）
        let fm = FileManager.default
        if fm.fileExists(atPath: template.path) {
            try? fm.removeItem(at: dataImg)
            try? fm.copyItem(at: template, to: dataImg)
            fputs("[LOGOUT] 已用模板重置 data.img（设备登录记录已清除）\n", stderr)
        } else {
            try? fm.removeItem(at: dataImg)
            fputs("[LOGOUT] 模板缺失，已删除 data.img\n", stderr)
        }
        // 3. 重启干净服务（未登录）
        q.startService()
    }

    /// ⚠️ 2026-10-23：确保 AM 服务 QEMU 运行（App 启动时调用）。
    ///   App 之前完全依赖外部手动启动 wrapper-lite-qemu → 重启后服务没了，
    ///   界面就表现为「熄火」/AM 全挂。现在启动时自动拉起（runtime 目录，登录数据一致）。
    func ensureServiceRunning() async {
        let (ok, _) = await LiteAPI.status()
        if ok { return }
        let q = ensureQemu()
        // 端口被占（别的实例在跑）→ 直接视为已启动
        q.startService()
        // 等它起来（最多 40 秒）
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            let (ok2, _) = await LiteAPI.status()
            if ok2 { return }
            if q.serviceReady { return }
        }
    }

    /// 当前登录状态
    /// ⚠️ 2026-10-22 修正：原来 `loggedIn = !regions.isEmpty`，
    ///   只要 wrapper 报告有区域就认定已登录 —— 但实际 userToken 可能是空的，
    ///   导致界面显示「已登录」却播不了（只能用本地缓存）。
    ///   现在同时要求「有 token」或「本地有缓存凭证」。
    func status() async -> Any {
        let (ok, regions) = await LiteAPI.status()
        let hasToken = !SearchCore.userToken.isEmpty
        let cachedCreds = LiteAPI.hasCachedCreds()
        // ⚠️ 2026-10-22 修正架构认知：
        //    wrapper 模式下，token 存在虚拟机里（data.img），wrapper 内部用它做解密。
        //    App 侧**不需要**持有 token —— /status 返回非空 regions 就说明已登录。
        //    SearchCore.userToken 只用于「手工填 token」模式（无 wrapper 时的备选）。
        //    → 判定改成：wrapper 就绪(ok) + 未手动登出。
        // ⚠️ 2026-10-23 修正（严重 bug）：
        //   之前写的是 `ok && (!regions.isEmpty || !Self.forcedLoggedOut)` ——
        //   regions 为空（= 根本没登录）且未手动登出时，`!forcedLoggedOut` 为 true，
        //   结果**服务一跑就判定「已登录」** → 陌生账号/错误密码也显示登录成功。
        //   正确判定：必须 wrapper 就绪 + **regions 非空**（data.img 里真有登录态）
        //   且不是刚手动登出的状态。
        let reallyLoggedIn = ok && !regions.isEmpty && !Self.forcedLoggedOut
        return [
            "loggedIn": reallyLoggedIn,
            "hasToken": hasToken,
            "hasCachedCreds": cachedCreds,
            "regions": regions,
            "running": qemu?.running ?? false,
            "tokenLength": SearchCore.userToken.count,
            "forcedLoggedOut": Self.forcedLoggedOut,
        ]
    }

    /// 开始登录
    func login(email: String, password: String) async -> Any {
        guard !email.isEmpty, !password.isEmpty else {
            return ["ok": false, "error": "请填写 Apple ID 和密码"]
        }
        let q = ensureQemu()
        // 开始登录即视为「不再手动登出」
        Self.forcedLoggedOut = false
        q.login(email: email, password: password)

        // 等登录结果（最多 3 分钟）
        let start = Date()
        while Date().timeIntervalSince(start) < 180 {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            switch q.phase {
            case .success:
                // ⚠️ 2026-10-23：登录成功必须清掉「手动登出」标记，
                //   否则 status() 的判定会一直报未登录 → 界面卡在登录页。
                Self.forcedLoggedOut = false
                // ⚠️ 2026-10-23 关键修复「登录成功但界面不切换」：
                //   登录 QEMU 退出后 startService 还要启动常驻服务（20~40 秒），
                //   期间 /status 会返回 503/未登录。如果这时就返回 ok，
                //   前端立刻查状态 → 未登录 → 渲染回登录页（用户看到「又回到登录页」）。
                //   这里**等服务真正就绪（token 加载 + regions 非空）再返回**，
                //   保证前端拿到 ok 时立刻查状态就是已登录。
                for _ in 0..<45 {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    let (sok, sregions) = await LiteAPI.status()
                    if sok, !sregions.isEmpty { break }
                }
                return ["ok": true, "message": "登录成功"]
            case .needCode:
                return ["ok": false, "needCode": true,
                        "message": "需要两步验证码"]
            case .failed(let why):
                return ["ok": false, "error": why.isEmpty ? q.message : why]
            case .needRetry:
                return ["ok": false, "error": "账号或密码不对"]
            default:
                continue
            }
        }
        return ["ok": false, "error": "登录超时（3 分钟）"]
    }

    /// 退出登录
    /// ⚠️ 2026-10-22 新增（用户要求）：
    ///   之前只有 amClearToken（只清 SearchCore.userToken），
    ///   wrapper 里的登录态（regions）还在，所以界面上一直是「已登录」。
    ///   真正的登出必须：
    ///     1. 清 SearchCore.userToken
    ///     2. 清本地缓存的凭据（如果有）
    ///     3. 停掉 wrapper（它的内存态保存了登录会话）
    ///     4. 标记「已手动登出」，让 status() 返回未登录
    func logout() async -> Any {
        SearchCore.userToken = ""
        Self.forcedLoggedOut = true
        // ⚠️ 2026-10-23（用户要求）：退出登录要**清除设备登录记录**。
        //   wrapper 的登录凭证存在 data.img（QEMU 虚拟盘）里，只清内存/UserDefaults
        //   下次启动 QEMU 还会带着旧账号 → 等于没真正登出，也无法换账号测试。
        //   这里用预置的「格式化空盘模板」覆盖 data.img → 彻底回到全新设备状态。
        clearDeviceLoginRecord()
        // ⚠️ 2026-10-23（用户要求）：退出登录时自动抹去设备指纹。
        //   同一个设备指纹反复登录失败会被 Apple 风控升级（response type 4 连验证码都不发）。
        //   退出登录时清掉 UserDefaults 里的指纹 → 下次登录自动生成新的随机设备指纹。
        resetDeviceFingerprint()
        // 停掉 wrapper
        if let q = qemu { q.shutdown() }
        qemu = nil
        fputs("Apple Music: 已退出登录\n", stderr)
        return ["ok": true]
    }

    /// 手动登出标记（存盘，重启后仍生效，直到用户重新登录）
    private static let loggedOutKey = "annie.am.forcedLoggedOut"
    static var forcedLoggedOut: Bool {
        get { UserDefaults.standard.bool(forKey: loggedOutKey) }
        set { UserDefaults.standard.set(newValue, forKey: loggedOutKey) }
    }

    /// 提交两步验证码
    func submitCode(_ code: String) async -> Any {
        guard let q = qemu else {
            return ["ok": false, "error": "没有进行中的登录"]
        }
        q.submitCode(code)
        return ["ok": true]
    }
}
