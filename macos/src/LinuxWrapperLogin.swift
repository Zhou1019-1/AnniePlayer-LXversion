// Apple Music 登录器（VM 常驻服务版）
//
// ⚠️ 架构演进（2026-10-22）：
//
//   第 1 代：QemuLogin —— macOS 上跑 wrapper-lite-qemu（x86_64 QEMU 客户机）
//           问题：双层模拟的设备指纹被 Apple 识别 → `Your account is disabled`
//
//   第 2 代：LinuxWrapperLogin（limactl shell 版）—— 在 Lima Linux VM 里跑原生
//           问题：每次登录/轮询都要 `limactl shell` 起一次 SSH 会话（2~3 秒开销），
//                轮询一次实际要 4~5 秒，换号体验极差
//
//   第 3 代（当前）：VM 内常驻一个 Python HTTP 服务
//                   （/opt/am-login/am-login-server.py，systemd 常驻 + Restart=always），
//                   App 用 HTTP 调它：
//                     · 请求延迟 14~39ms（原 2000~3000ms，快约 100 倍）
//                     · 登录状态机、验证码判定、日志抓取都在 VM 侧完成
//                     · wrapper 登录成功后继续以服务模式常驻（播放时不用重启）
//
//   通信方式：Lima 会把 guest 的 127.0.0.1 端口自动转发到 host，
//            所以 App 直接访问 http://127.0.0.1:12341 即可。
//
//   两阶段 2FA（与 Apple 约定一致）：
//     第 1 次 POST /login {email,password}        → Apple 回 response type 4 → need_code
//     第 2 次 POST /login {email,password,code}   → wrapper 用「密码+验证码」重登 → success

import Foundation

/// Apple Music 登录器（通过 VM 常驻 HTTP 服务）
final class LinuxWrapperLogin {
    static let shared = LinuxWrapperLogin()

    /// VM 内登录管理服务地址（Lima 自动把 guest 127.0.0.1 端口转发到 host）
    static let base = "http://127.0.0.1:12341"

    /// Lima VM 名字（仅用于诊断提示）
    var vmName = "snowluma"

    private(set) var phase: Phase = .idle
    private(set) var message = ""
    private(set) var lastLog = ""

    enum Phase: Equatable {
        case idle
        case starting        // 正在启动 wrapper
        case loggingIn       // 已提交账号密码
        case needCode        // 等待 2FA 验证码
        case success
        case failed(String)
    }

    private init() {}

    // MARK: - HTTP 基础设施

    /// 同步 GET，返回 (状态码, 原始文本)
    private func httpGET(_ path: String, timeout: TimeInterval = 5) -> (Int, String) {
        guard let url = URL(string: Self.base + path) else { return (-1, "") }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        var code = -1
        var body = ""
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let http = resp as? HTTPURLResponse { code = http.statusCode }
            if let d = data { body = String(data: d, encoding: .utf8) ?? "" }
            if err != nil { code = -1 }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + timeout + 1)
        return (code, body)
    }

    /// 同步 POST JSON，返回 (状态码, 解析后的字典)
    private func httpPOST(_ path: String, _ payload: [String: Any],
                          timeout: TimeInterval = 10) -> (Int, [String: Any]) {
        guard let url = URL(string: Self.base + path) else { return (-1, [:]) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        var code = -1
        var out: [String: Any] = [:]
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let http = resp as? HTTPURLResponse { code = http.statusCode }
            if let d = data,
               let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                out = o
            }
            if err != nil { code = -1 }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + timeout + 1)
        return (code, out)
    }

    /// 服务是否在线
    func serviceOnline() -> Bool {
        let (code, body) = httpGET("/ping", timeout: 2)
        return code == 200 && body.contains("\"ok\"")
    }

    // MARK: - 设备指纹

    /// 本机唯一的 Apple Music 设备指纹（持久化在 UserDefaults）
    ///
    /// ⚠️ 2026-10-22 为什么必须每机独立：
    ///   wrapper 内置的默认设备信息是所有人共用的
    ///   （Samsung S9 + AndroidID dc28071e981c439e），Apple 一看就知道是伪造客户端；
    ///   实测同一个设备 ID 短时间内反复登录失败后，Apple 会把风控升级成
    ///   `response type 4`（连验证码都不发），换新 ID 立刻恢复正常。
    ///
    ///   格式：ClientId/版本/平台/系统版本/机型/构建号/区域/语言/AndroidID
    private var deviceInfo: String {
        let key = "annie.am.deviceInfo"
        if let saved = UserDefaults.standard.string(forKey: key), !saved.isEmpty {
            return saved
        }
        let models: [(String, String, String)] = [
            ("Samsung SM-G9980", "13", "TP1A.220624.014"),
            ("Xiaomi M2102J2SC", "12", "SKQ1.211006.001"),
            ("Google Pixel 6", "13", "TQ3A.230805.001"),
            ("OnePlus LE2120", "12", "RKQ1.211119.001"),
            ("OPPO PDET10", "13", "TP1A.220905.001"),
            ("vivo V2148A", "12", "SP1A.210812.003"),
        ]
        let pick = models.randomElement()!
        let hex = Array("0123456789abcdef")
        let androidId = String((0..<16).map { _ in hex.randomElement()! })
        let info = "Music/4.9/Android/\(pick.1)/\(pick.0)/\(pick.2)/zh-CN/zh-CN/\(androidId)"
        UserDefaults.standard.set(info, forKey: key)
        fputs("AM 设备指纹已生成: \(info)\n", stderr)
        return info
    }

    /// 把本机设备指纹同步给 VM 服务（登录前调用）
    @discardableResult
    func syncDevice() -> Bool {
        let (code, resp) = httpPOST("/device", ["info": deviceInfo], timeout: 5)
        return code == 200 && (resp["ok"] as? Bool) == true
    }

    // MARK: - 环境检查

    /// 检查登录服务是否可用（VM 是否启动、常驻服务是否在跑）
    func checkEnvironment() -> [String: Any] {
        let (code, body) = httpGET("/status", timeout: 3)
        if code == 200 {
            var d = (try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any]) ?? [:]
            d["ready"] = true
            d["serviceUrl"] = Self.base
            d["vmName"] = vmName
            d["wrapperDeployed"] = true
            d["rootfsOK"] = true
            return d
        }
        return [
            "ready": false,
            "serviceUrl": Self.base,
            "vmName": vmName,
            "vmRunning": false,
            "detail": """
            登录服务未响应（\(Self.base)）。

            请确认 Linux 虚拟机已启动：
              limactl start \(vmName)

            以及 VM 内的常驻服务在运行：
              limactl shell \(vmName) sudo systemctl status am-login
            """,
        ]
    }

    // MARK: - 登录

    /// 开始登录（或提交验证码）
    /// - Parameter code: 第 2 次调用时传入 6 位验证码
    func login(email: String, password: String, code: String? = nil,
               progress: @escaping (Phase, String) -> Void) {
        guard serviceOnline() else {
            let env = checkEnvironment()
            let detail = (env["detail"] as? String) ?? "登录服务未响应"
            finish(.failed("【环境未就绪】\n\n\(detail)"), progress)
            return
        }

        // 先把本机设备指纹同步给 VM（每台机器独立，避免共用 ID 被风控）
        _ = syncDevice()

        let hasCode = !(code ?? "").isEmpty
        phase = .starting
        message = hasCode ? "正在提交验证码…" : "正在启动认证环境…"
        progress(phase, message)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            var payload: [String: Any] = ["email": email, "password": password]
            if hasCode { payload["code"] = code! }

            let (pcode, presp) = self.httpPOST("/login", payload)
            guard pcode == 200, (presp["ok"] as? Bool) == true else {
                let err = (presp["error"] as? String) ?? "提交登录请求失败（HTTP \(pcode)）"
                self.finish(.failed("【登录请求失败】\n\n\(err)"), progress)
                return
            }

            // 轮询状态（VM 侧已完成状态机判断，这里只取结果）
            let deadline = Date().addingTimeInterval(hasCode ? 120 : 180)
            var sawNeedCode = hasCode
            while Date() < deadline {
                Thread.sleep(forTimeInterval: 0.3)   // 常驻 HTTP，300ms 足够快
                let (scode, sbody) = self.httpGET("/status", timeout: 4)
                guard scode == 200,
                      let d = try? JSONSerialization.jsonObject(with: Data(sbody.utf8)) as? [String: Any]
                else { continue }

                let ph = (d["phase"] as? String) ?? ""
                let msg = (d["message"] as? String) ?? ""
                self.lastLog = (d["logTail"] as? String) ?? self.lastLog

                switch ph {
                case "success":
                    self.finish(.success, progress)
                    return
                case "need_code":
                    if !sawNeedCode {
                        sawNeedCode = true
                        self.phase = .needCode
                        self.message = msg.isEmpty ? "需要验证码" : msg
                        progress(.needCode, self.message)
                        return
                    }
                    // ⚠️ 2026-10-23：第二次收到 need_code 不要立刻判失败 ——
                    //   VM 侧写 2fa.txt 后 wrapper 还要几秒才完成认证，
                    //   期间状态可能还是 need_code。给 10 秒宽限期观察是否转 success。
                    var becameSuccess = false
                    let graceEnd = Date().addingTimeInterval(10)
                    while Date() < graceEnd {
                        Thread.sleep(forTimeInterval: 0.4)
                        let (gc, gb) = self.httpGET("/status", timeout: 4)
                        guard gc == 200,
                              let gd = try? JSONSerialization.jsonObject(with: Data(gb.utf8)) as? [String: Any]
                        else { continue }
                        if (gd["phase"] as? String) == "success" {
                            becameSuccess = true
                            break
                        }
                    }
                    if becameSuccess {
                        self.finish(.success, progress)
                        return
                    }
                    self.finish(.failed("""
                    【验证码未通过】

                    Apple 仍然要求验证码，可能是：
                      · 验证码输入错误
                      · 验证码已过期（通常 5 分钟内有效）

                    请让账号主人重新获取验证码后再试。
                    """), progress)
                    return
                case "failed":
                    let detail = msg.isEmpty ? "登录失败" : msg
                    self.finish(.failed(self.explainFailure(detail, log: self.lastLog)), progress)
                    return
                case "starting", "logging_in":
                    self.phase = (ph == "starting") ? .starting : .loggingIn
                    if !msg.isEmpty { self.message = msg }
                default:
                    break
                }
            }
            self.finish(.failed("【登录超时】\n\nVM 侧 3 分钟内没有返回结果，请检查网络后重试。"), progress)
        }
    }

    /// 把失败原因翻译成可操作的中文提示
    private func explainFailure(_ detail: String, log: String) -> String {
        let low = (detail + "\n" + log).lowercased()
        if low.contains("disabled") {
            return """
            【Apple 账户被限制】

            Apple 返回了账号被停用的错误。可能原因：
              · 短时间内多次登录失败，触发风控
              · 账号处于安全观察期（刚改过密码）

            建议等 1~2 小时后再试。
            如果持续出现，请让账号主人在 iPhone 上确认账号状态正常。
            """
        }
        if low.contains("密码不正确") || low.contains("check the account") {
            return """
            【账号或密码不正确】

            请确认：
              · Apple ID 邮箱是否完整
              · 密码是否是最近改过的那个（注意大小写和末尾符号）
              · 有没有多打了空格
            """
        }
        var msg = "【登录失败】\n\n\(detail)"
        if !log.isEmpty {
            msg += "\n\nVM 日志：\n" + String(log.suffix(600))
        }
        return msg
    }

    private func finish(_ p: Phase, _ progress: @escaping (Phase, String) -> Void) {
        phase = p
        switch p {
        case .success: message = "登录成功"
        case .needCode: message = message.isEmpty ? "请输入验证码" : message
        case .failed(let m): message = m
        default: break
        }
        progress(p, message)
    }

    // MARK: - 登录状态 / 登出

    /// 是否已登录（VM 侧判断 data 目录里有 MUSIC_TOKEN / STOREFRONT_ID）
    func isLoggedIn() -> Bool {
        let (code, body) = httpGET("/status", timeout: 3)
        guard code == 200,
              let d = try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any]
        else { return false }
        return (d["loggedIn"] as? Bool) ?? false
    }

    /// 登出：通知 VM 侧清理登录态
    func logout() {
        _ = httpPOST("/logout", [:], timeout: 8)
        phase = .idle
        message = ""
        lastLog = ""
    }

    /// 读取 VM 侧最近日志（调试用）
    func fetchLog() -> String {
        let (code, body) = httpGET("/log", timeout: 4)
        return code == 200 ? body : ""
    }
}
