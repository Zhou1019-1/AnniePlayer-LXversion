// 环境路径解析 —— 开源版必须可配置。
//
// 原来所有路径都写死成 ~/.dsh/amdl/...，那是**我自己的部署目录**，
// 别人机器上不可能存在。开源版改成三级查找：
//
//   1. 用户的配置文件  ~/Library/Application Support/AppleMusicDL/config.json（推荐）
//   2. 环境变量        AMDL_PATH / WRAPPER_LITE_URL / AMDL_CONFIG
//   3. 常见安装位置    Homebrew、~/amdl、~/.dsh/amdl（兼容我原来的部署）
//
// 找不到就让 App 显示「缺依赖」引导，而不是直接报错。

import Foundation

struct EnvPaths {
    /// 当前 CPU 架构（Intel = x86_64 / Apple Silicon = arm64）
    /// 用户 2026-10-18：「群里有 Intel Mac 用户」——依赖文件名要按架构选
    /// ⚠️ 运行时判断，不能用 #if arch（2026-10-19 踩坑）：
    ///    App 是通用二进制，x86_64 分支在 ARM Mac 上跑（Rosetta）时会误判成 Intel。
    static var isIntel: Bool {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw -> String in
            String(cString: raw.bindMemory(to: CChar.self).baseAddress!)
        }
        return machine == "x86_64"
    }

    static var archName: String { isIntel ? "amd64" : "arm64" }

    var amdlBinary: URL?
    var amdlConfig: URL?
    var liteServer: String
    var wrapperDir: URL?

    static let liteDefault = "http://127.0.0.1:12340"

    // MARK: 在哪里找

    static func configFile() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return base.appendingPathComponent("AppleMusicDL/config.json")
    }

    /// 读用户配置（第一次运行时如果不存在，就写一份带默认值的）。
    static func userConfig() -> [String: String] {
        let url = configFile()
        if let d = try? Data(contentsOf: url),
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: String] {
            return obj
        }
        let defaults = ["liteServer": liteDefault, "amdlPath": "", "configPath": ""]
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        if let d = try? JSONSerialization.data(withJSONObject: defaults,
                                               options: [.prettyPrinted]) {
            try? d.write(to: url)
        }
        return defaults
    }

    static func save(_ cfg: [String: String]) {
        let url = configFile()
        if let d = try? JSONSerialization.data(withJSONObject: cfg,
                                               options: [.prettyPrinted]) {
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try? d.write(to: url)
        }
    }

    /// 按优先级解析出实际路径。
    /// full 包的依赖放在 App bundle 的 Contents/Resources/deps/ 里。
    /// 开源版（不带依赖）会返回 nil，走常规查找。
    static func bundledDepsDir() -> URL? {
        guard let exe = Bundle.main.executableURL else { return nil }
        // .../X.app/Contents/MacOS/X  ->  .../X.app/Contents/Resources/deps
        let deps = exe.deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Resources/deps")
        return FileManager.default.fileExists(atPath: deps.path) ? deps : nil
    }

    /// wrapper-lite 的**可写工作目录**。
    ///
    /// ⚠️ 为什么不能直接用 App 里的 `Contents/Resources/deps/wrapper-lite`（2026-10-18 修复）：
    ///   1. 下载后直接双击打开的 App 会被 macOS 做 **App Translocation** ——
    ///      系统把它挂到 `/private/var/folders/.../AppTranslocation/<UUID>/d/X.app`，
    ///      这是一个 **只读的 nullfs 挂载**（mount 里能看到 `read-only`）。
    ///      日志里 `wrapperDir: .../AppTranslocation/...` 就是这个状态。
    ///   2. 就算没有 translocation，App bundle 也不保证可写（权限、公证校验）。
    ///
    ///   App 登录时要把参数写进 `<wrapper-lite>/qemu/.lite-qemu-args`、验证码写进
    ///   `qemu/.2fa-code`，登录态要落进 `qemu/data.img` —— 只要目录只读，
    ///   就会走到「写不了参数文件」，其他用户就是这样挂掉的。
    ///
    /// 做法：把整份 wrapper-lite 复制到
    ///   `~/Library/Application Support/AppleMusicDL/wrapper-lite-runtime/`
    /// 以后所有读写都在这里，bundle 只当「只读模板」，永远不写它。
    ///
    /// 注意 `lstat` 而不是 `fileExists`：它是软链接时 fileExists 会跟随到 App 里，
    /// 那就又变成只读路径了。
    static var wrapperRuntimeDir: URL {
        let arch = isIntel ? "amd64" : "arm64"
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return base.appendingPathComponent("AppleMusicDL/wrapper-lite-runtime-\(arch)")
    }

    /// 这个目录/文件存在吗（**不跟随软链接**）
    static func existsNoFollow(_ url: URL) -> Bool {
        var st = stat()
        return lstat(url.path, &st) == 0
    }

    /// 去掉 App Translocation 前缀，拿到用户的真实安装路径。
    /// `/…/T/AppTranslocation/<UUID>/d/X.app/…` → `/Applications/X.app/…`
    static func originalPath(_ url: URL) -> URL {
        var p = url.standardizedFileURL.path
        if !p.hasPrefix("/") { p = "/" + p }        // 有的环境下 standardize 会吃掉前导 "/"
        guard let r = p.range(of: "/AppTranslocation/"), r.lowerBound != p.startIndex else {
            return url
        }
        let after = p[r.upperBound...].drop(while: { $0 != "/" })   // "/d/X.app/…"
        let rest = after.dropFirst(2)                               // 去掉 "/d"
        guard rest.hasPrefix("/") else { return url }
        return URL(fileURLWithPath: String(rest))
    }

    /// App 是不是正被系统以只读的 translocation 方式打开
    static var isAppTranslocated: Bool {
        guard let exe = Bundle.main.executableURL else { return false }
        return exe.standardizedFileURL.path.contains("/AppTranslocation/")
    }

    /// wrapper-lite 里必须有的几样东西都齐了
    static func wrapperLiteComplete(_ dir: URL) -> Bool {
        let fm = FileManager.default
        return fm.isExecutableFile(atPath: dir.appendingPathComponent("wrapper-lite-qemu").path)
            && fm.fileExists(atPath: dir.appendingPathComponent("qemu/bin/qemu-system-x86_64").path)
            && fm.fileExists(atPath: dir.appendingPathComponent("qemu/data.img").path)
    }

    /// App 里自带的那份 wrapper-lite 在哪（只读模板；没有就返回 nil）
    static func bundledWrapperDir() -> URL? {
        guard let deps = bundledDepsDir() else { return nil }
        let b = deps.appendingPathComponent("wrapper-lite")
        return wrapperLiteComplete(b) ? b : nil
    }

    /// 准备可写工作目录，返回给 Login / 服务启动用。
    ///
    /// - 已经有工作副本 → 直接返回（**不覆盖**，数据盘里有登录态）
    /// - 没有 → 从 App 里复制一份
    ///
    /// `progress` 会在开始复制时回调一次（复制要几秒，界面该显示「首次启动准备中」）。
    static func ensureWrapperRuntime(progress: ((String) -> Void)? = nil) -> URL? {
        let dest = wrapperRuntimeDir
        if existsNoFollow(dest) {
            if wrapperLiteComplete(dest) { return dest }
            // 残缺（上次复制被打断）→ 删掉重来
            try? FileManager.default.removeItem(at: dest)
        }

        // 1. 源：App 内置的那份
        //    2. App 外置 + 自带完整依赖（半 standalone 部署）
        //    3. 用户已经关联过的 wrapper 目录（精简版）
        var sources: [URL] = []
        if isAppTranslocated {
            // 复制要走用户的真实路径，不要顺着 translocation 的只读挂载点
            let orig = originalPath(Bundle.main.bundleURL)
            let cand = orig.appendingPathComponent("Contents/Resources/deps/wrapper-lite")
            if wrapperLiteComplete(cand) { sources.append(cand) }
        }
        if let b = bundledWrapperDir() { sources.append(b) }
        let linked = dest.deletingLastPathComponent().appendingPathComponent("wrapper")
        if wrapperLiteComplete(linked) { sources.append(linked) }

        guard let src = sources.first else { return nil }

        progress?("首次启动正在准备解密组件（约 400MB，需要十几秒）…")
        do {
            try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: src, to: dest)
        } catch {
            try? FileManager.default.removeItem(at: dest)
            return nil
        }
        // 复制会带上 quarantine / 只读等扩展属性，这里统一清一遍，
        // 保证 qemu/ 下能写参数文件
        //
        // 注意一定要加 -s（软链接本身也清），并且别用 -r：
        // 包里的 qemu-system-x86_64 是 r-x（刻意不可写），xattr -rc 走到它会被拒绝，
        // 而我们需要清属性的那些文件（data.img、vmlinuz、initramfs、.lite-qemu-args）
        // 本来就在 qemu/ 一级目录。
        clearQuarantine(dest.appendingPathComponent("qemu"))
        chmod(dest.appendingPathComponent("qemu").path, 0o755)
        return wrapperLiteComplete(dest) ? dest : nil
    }

    /// 递归清掉 quarantine / 其它 xattr（失败忽略：不可写文件本来也没有要清的东西）
    static func clearQuarantine(_ dir: URL) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        p.arguments = ["-cs", dir.path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
    }

    static func resolve() -> EnvPaths {
        let cfg = userConfig()
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser

        // ---- amdl 二进制 ----
        var amdl: URL?
        // 包内依赖优先（full 包）；没有再用用户配置
        let bundled = bundledDepsDir()
        var amdlCandidates: [String] = []
        if let b = bundled {
            // 完整包里按架构区分：amdl_arm64 / amdl_amd64（2026-10-18 Intel 适配）
            amdlCandidates += [
                b.appendingPathComponent("amdl_\(archName)").path,
                b.appendingPathComponent("amdl").path,
                b.appendingPathComponent("amdl/amdl").path,
            ]
        }
        amdlCandidates += [
            cfg["amdlPath"] ?? "",
            env["AMDL_PATH"] ?? "",
            "/opt/homebrew/bin/amdl",
            "/usr/local/bin/amdl",
            home.appendingPathComponent("amdl/amdl").path,
            // 按当前架构选：Intel Mac 找 amdl_darwin_amd64，ARM 找 amdl_darwin_arm64
            home.appendingPathComponent("amdl/amdl_darwin_\(archName)").path,
            home.appendingPathComponent(".dsh/amdl/amdl_darwin_\(archName)").path,
            // 兜底：两种都试一遍（用户可能放错了）
            home.appendingPathComponent("amdl/amdl_darwin_arm64").path,
            home.appendingPathComponent("amdl/amdl_darwin_amd64").path,
        ]
        for c in amdlCandidates where !c.isEmpty {
            let u = URL(fileURLWithPath: (c as NSString).expandingTildeInPath)
            if FileManager.default.isExecutableFile(atPath: u.path) { amdl = u; break }
        }

        // ---- config.yaml ----
        var conf: URL?
        var confCandidates: [String] = []
        if let b = bundled {
            confCandidates.append(b.appendingPathComponent("config.yaml").path)
        }
        confCandidates += [
            cfg["configPath"] ?? "",
            env["AMDL_CONFIG"] ?? "",
            home.appendingPathComponent("amdl/config.yaml").path,
            home.appendingPathComponent(".dsh/amdl/alac/config.yaml").path,
        ]
        for c in confCandidates where !c.isEmpty {
            let u = URL(fileURLWithPath: (c as NSString).expandingTildeInPath)
            if FileManager.default.fileExists(atPath: u.path) { conf = u; break }
        }

        // ---- wrapper-lite 目录 ----
        var wdir: URL?
        var wdirCandidates: [String] = []
        if let b = bundled {
            wdirCandidates.append(b.appendingPathComponent("wrapper-lite").path)
        }
        wdirCandidates += [
            env["WRAPPER_LITE_DIR"] ?? "",
            home.appendingPathComponent("wrapper-lite").path,
            home.appendingPathComponent("wrapper").path,
            home.appendingPathComponent(".dsh/amdl/wrapper-lite/unpacked").path,
        ]
        for c in wdirCandidates where !c.isEmpty {
            let u = URL(fileURLWithPath: (c as NSString).expandingTildeInPath)
            let launcher = u.appendingPathComponent("wrapper-lite-qemu")
            if FileManager.default.fileExists(atPath: launcher.path) { wdir = u; break }
        }

        let lite = (cfg["liteServer"]?.isEmpty == false ? cfg["liteServer"]!
                    : (env["LITE_SERVER"] ?? liteDefault))

        return EnvPaths(amdlBinary: amdl, amdlConfig: conf,
                        liteServer: lite, wrapperDir: wdir)
    }
}

// MARK: - 环境自检

struct CheckResult {
    var name: String
    var ok: Bool
    var detail: String
    var fixCommand: String?     // 不 OK 时给用户看的命令
}

enum EnvCheck {

    /// 检查 amdl 二进制
    static func amdl(_ p: EnvPaths) -> CheckResult {
        if let b = p.amdlBinary {
            return CheckResult(name: "amdl 下载器", ok: true,
                               detail: b.path, fixCommand: nil)
        }
        return CheckResult(
            name: "amdl 下载器", ok: false,
            detail: "没找到 amdl 可执行文件",
            fixCommand: "brew install amdl    # 或按 README 手动下载后设置 amdlPath")
    }

    /// 检查 config.yaml
    static func config(_ p: EnvPaths) -> CheckResult {
        if let c = p.amdlConfig {
            return CheckResult(name: "amdl 配置", ok: true,
                               detail: c.path, fixCommand: nil)
        }
        return CheckResult(
            name: "amdl 配置", ok: false,
            detail: "没找到 config.yaml",
            fixCommand: "amdl -v    # 首次运行会自动生成默认配置")
    }

    /// Intel Mac 需要系统装的 QEMU（App 内不含 x86_64 版 QEMU）
    static func systemQemu() -> CheckResult {
        let candidates = ["/usr/local/bin/qemu-system-x86_64",
                          "/opt/homebrew/bin/qemu-system-x86_64"]
        for c in candidates {
            if FileManager.default.isExecutableFile(atPath: c) {
                return CheckResult(name: "QEMU（系统）", ok: true, detail: c, fixCommand: nil)
            }
        }
        return CheckResult(
            name: "QEMU（系统）", ok: false,
            detail: "Intel Mac 需要系统安装 QEMU（App 内不自带 x86_64 版）",
            fixCommand: "brew install qemu")
    }

    /// 检查 wrapper-lite 服务是否在线、是否已登录（有店铺 = 登录态有效）
    static func liteServer(_ p: EnvPaths, completion: @escaping (CheckResult) -> Void) {
        guard let u = URL(string: p.liteServer + "/status") else {
            completion(CheckResult(name: "解密服务", ok: false,
                                   detail: "地址不合法", fixCommand: nil))
            return
        }
        var req = URLRequest(url: u)
        req.timeoutInterval = 6
        URLSession.shared.dataTask(with: req) { data, _, err in
            if let err {
                completion(CheckResult(
                    name: "解密服务", ok: false,
                    detail: "连接不上（\(err.localizedDescription)）—— ALAC 无损必须要它",
                    fixCommand: """
                    cd <wrapper-lite 目录>
                    ./wrapper-lite-qemu          # 启动服务（需先在后台跑）
                    """))
                return
            }
            guard let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let d = obj["data"] as? [String: Any] else {
                completion(CheckResult(name: "解密服务", ok: false,
                                       detail: "返回格式异常", fixCommand: nil))
                return
            }
            let regions = d["regions"] as? [String] ?? []
            if regions.isEmpty {
                completion(CheckResult(
                    name: "解密服务", ok: false,
                    detail: "服务在跑，但**没有登录态**（无法解密）",
                    fixCommand: """
                    cd <wrapper-lite 目录>
                    ./wrapper-lite-qemu --login "你的AppleID:密码" --code-from-file
                    # 之后把 2FA 验证码写到 <目录>/data/2fa.txt
                    """))
            } else {
                completion(CheckResult(
                    name: "解密服务", ok: true,
                    detail: "在线，店铺：\(regions.joined(separator: ", "))",
                    fixCommand: nil))
            }
        }.resume()
    }
}
