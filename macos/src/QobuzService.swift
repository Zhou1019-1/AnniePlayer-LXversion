// Qobuz 音源服务
//
// UI（am-qobuz.js）需要的接口：
//   qobuzStatus()          → {loggedIn, hasSavedCreds, userName, subscription}
//   qobuzLogin(params)     → 同上（params: {email, password, appId?, appSecret?}）
//   qobuzLogout()          → {ok}
//   qobuzSearch({query, type, limit, offset}) → {albums:[], tracks:[], artists:[]}
//   qobuzAlbumGet({albumId})      → 专辑详情（含 tracks）
//   qobuzPlaylistGet({playlistId})→ 歌单详情
//   qobuzUserPlaylists()          → 用户歌单
//   qobuzFavorites(type)          → 收藏列表
//   qobuzFav({type, id, add})     → 加/取消收藏
//   qobuzFileUrl({trackId, formatId}) → {url}
//   qobuzParseUrl({url})          → 解析 qobuz 链接
//   qobuzDownload({items, quality}) → 下载
//   qobuzDlCancel / qobuzPickDlDir / qobuzLyricMatch / onQobuzDlEvent
//
// ⚠️ 网络：Qobuz 域名直连超时，必须走系统代理（127.0.0.1:65532）。
//    WKWebView/URLSession 默认不走系统代理，这里显式配代理。

import Foundation
import CommonCrypto

final class QobuzService {
    static let shared = QobuzService()

    // ⚠️ 2026-10-22：app_id 选择
    //   · 798273057（用户提供的）→ 匿名访问被拦（401），且其 token 已被封
    //   · 312369995 → 匿名可访问，但只能搜到艺术家（账号无订阅权限）
    //   目前所有公开 token 都被 Qobuz 封禁（USER_BLOCKED），
    //   只能搜艺术家名。等有真实订阅账号登录后会自动走 user/login 拿全权限。
    private let appId = "312369995"
    private let appSecret = "e79f8b9be485692b0e5f9dd895826368"
    /// 代理（用户本机）
    private let proxyHost = "127.0.0.1"
    private let proxyPort = 65532

    private var session: URLSession!
    /// 内置公开 token（写死在代码里，会过期）
    /// ⚠️ 2026-10-22：这些 token 来自公开渠道，过期后需要换新的。
    ///    · 用户在界面里填的自定义 token 优先于内置的
    ///    · 全部 token 失效时，界面引导用户去填新的
    private let builtinTokens: [(String, String)] = [
        ("GB", "F91dfdLCgxXMZ0ek_Ri30z9YvesibrJ5mwJmdVm9ngX7qexs9zsrF36CHLlfLd_Nq037d6HKEz1mGGF7OxTDrA"),
        ("JP", "T95KIRxy0rD_Iu3Hgd5ZdmiGhXwgd1EPlFyX9JV9yo7w1HosDl9vfQTGRQEo2zkkcwP9ADc3L20nYNaI0l7E4g"),
        ("NZ", "SJ8dMfchx6HkHV0H3atBtwXrboe_UJqk0uzTbJ1JceA3woXpIX8_5LtVOMV_LYBbj0UsqCBmMJoKSskndawI5w"),
    ]

    /// 用户自定义 token（界面填写，存盘，优先使用）
    private var customToken = ""
    private var customTokenRegion = ""
    /// 记录各 token 的失效状态（避免反复重试已失效的）
    private var failedTokens: Set<String> = []
    /// 最近一次 token 校验结果
    private(set) var tokenValid: Bool? = nil
    private(set) var tokenError = ""
    private var userToken = ""
    private var userName = ""
    private var subscription = ""
    private var savedEmail = ""
    private var savedPassword = ""

    private var cfgURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("AnnieMac")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("qobuz.json")
    }

    private init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        cfg.connectionProxyDictionary = [
            kCFNetworkProxiesHTTPEnable as String: 1,
            kCFNetworkProxiesHTTPProxy as String: proxyHost,
            kCFNetworkProxiesHTTPPort as String: proxyPort,
            "HTTPSEnable": 1,
            "HTTPSProxy": proxyHost,
            "HTTPSPort": proxyPort,
        ]
        session = URLSession(configuration: cfg, delegate: ATSBypassDelegate.shared,
                             delegateQueue: nil)
        loadCreds()
    }

    // MARK: - 凭据持久化

    private func loadCreds() {
        guard let d = try? Data(contentsOf: cfgURL),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
        savedEmail = (o["email"] as? String) ?? ""
        savedPassword = (o["password"] as? String) ?? ""
        userToken = (o["token"] as? String) ?? ""
        userName = (o["userName"] as? String) ?? ""
        subscription = (o["subscription"] as? String) ?? ""
        customToken = (o["customToken"] as? String) ?? ""
        customTokenRegion = (o["customTokenRegion"] as? String) ?? ""
    }

    private func saveCreds() {
        let o: [String: Any] = [
            "email": savedEmail, "password": savedPassword,
            "token": userToken, "userName": userName, "subscription": subscription,
        ]
        if let d = try? JSONSerialization.data(withJSONObject: o) { try? d.write(to: cfgURL) }
    }

    // MARK: - 请求

    /// 当前生效的 token 优先级：
    ///   1. 用户登录的 token（邮箱密码登录）
    ///   2. 用户手动填写的自定义 token
    ///   3. 内置公开 token 中第一个未失效的
    private var activeToken: String {
        if !userToken.isEmpty { return userToken }
        if !customToken.isEmpty { return customToken }
        return builtinTokens.first(where: { !failedTokens.contains($0.1) })?.1 ?? ""
    }

    /// 全部 token（供遍历重试）
    private var allTokens: [(String, String)] {
        var list: [(String, String)] = []
        if !userToken.isEmpty { list.append(("登录账号", userToken)) }
        if !customToken.isEmpty { list.append((customTokenRegion.isEmpty ? "自定义" : customTokenRegion, customToken)) }
        list.append(contentsOf: builtinTokens)
        return list
    }

    private func request(_ path: String, _ query: [String: String] = [:]) async -> [String: Any]? {
        var comp = URLComponents(string: "https://www.qobuz.com/api.json/0.2/\(path)")
        var items = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        items.append(URLQueryItem(name: "app_id", value: appId))
        comp?.queryItems = items
        guard let url = comp?.url else { return nil }
        var req = URLRequest(url: url)
        req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
                     forHTTPHeaderField: "User-Agent")
        // ⚠️ 2026-10-22：token 失效自动切换
        //    401/403 时把当前 token 标记失效，换下一个重试（最多试完所有 token）
        for candidate in allTokens where !failedTokens.contains(candidate.1) {
            req.setValue(candidate.1, forHTTPHeaderField: "X-User-Auth-Token")
            guard let (data, resp) = try? await session.data(for: req),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            let httpCode = (resp as? HTTPURLResponse)?.statusCode ?? 200
            let apiCode = (obj["code"] as? Int) ?? httpCode
            let errMsg = (obj["message"] as? String) ?? ""
            // token 失效判定
            let isAuthFail = (httpCode == 401 || httpCode == 403 || apiCode == 401
                              || errMsg.contains("authentication")
                              || errMsg.contains("Invalid")
                              || errMsg.contains("BLOCKED"))
            if isAuthFail {
                failedTokens.insert(candidate.1)
                tokenValid = false
                tokenError = "Token 已失效（\(candidate.0)）"
                fputs("Qobuz token 失效 [\(candidate.0)]: \(errMsg)\n", stderr)
                continue   // 换下一个 token
            }
            if apiCode >= 400 {
                fputs("Qobuz \(path) 错误: \(errMsg)\n", stderr)
                return nil
            }
            tokenValid = true
            tokenError = ""
            return obj
        }
        // 所有 token 都失败
        tokenValid = false
        if tokenError.isEmpty { tokenError = "所有 Qobuz Token 均已失效" }
        return nil
    }

    static func md5(_ s: String) -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_MD5_DIGEST_LENGTH))
        if let data = s.data(using: .utf8) {
            data.withUnsafeBytes { ptr in
                _ = CC_MD5(ptr.baseAddress, CC_LONG(data.count), &digest)
            }
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - 状态 / 登录

    func status() -> [String: Any] {
        // ⚠️ 2026-10-22：loggedIn 反映「当前是否有可用 token」。
        //    · 有登录账号 / 自定义 token / 未失效的内置 token → true
        //    · 全部失效 → false，界面会退回登录页让用户填新 token
        let hasUsable = !activeToken.isEmpty
        let userNameShown: String
        if !userName.isEmpty { userNameShown = userName }
        else if !customToken.isEmpty { userNameShown = "自定义 Token（\(customTokenRegion.isEmpty ? "未知" : customTokenRegion)）" }
        else if !userToken.isEmpty { userNameShown = "登录账号" }
        else if hasUsable { userNameShown = "内置 Token（\(builtinTokens.first(where: { !failedTokens.contains($0.1) })?.0 ?? "")）" }
        else { userNameShown = "" }
        return [
            "loggedIn": hasUsable,
            "hasSavedCreds": !savedEmail.isEmpty || !customToken.isEmpty,
            "userName": userNameShown,
            "subscription": subscription.isEmpty ? (hasUsable ? "Studio" : "") : subscription,
            "appId": appId,
            "tokenValid": tokenValid.map { $0 ? 1 : 0 } ?? -1,
            "tokenError": tokenError,
            "needToken": !hasUsable,
        ]
    }

    func login(_ p: [String: Any]) async -> [String: Any] {
        let email = (p["email"] as? String) ?? ""
        let password = (p["password"] as? String) ?? ""
        guard !email.isEmpty, !password.isEmpty else {
            return ["ok": false, "error": "请输入邮箱和密码"]
        }
        var comp = URLComponents(string: "https://www.qobuz.com/api.json/0.2/user/login")
        comp?.queryItems = [
            URLQueryItem(name: "email", value: email),
            URLQueryItem(name: "password", value: password),
            URLQueryItem(name: "app_id", value: appId),
        ]
        guard let url = comp?.url else { return ["ok": false, "error": "URL 构造失败"] }
        var req = URLRequest(url: url)
        req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await session.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["ok": false, "error": "网络失败（需代理）"]
        }
        if let tok = obj["user_auth_token"] as? String {
            userToken = tok
            savedEmail = email
            savedPassword = password
            if let u = obj["user"] as? [String: Any] {
                userName = (u["display_name"] as? String) ?? (u["email"] as? String) ?? email
            } else { userName = email }
            if let sub = obj["user"] as? [String: Any],
               let cred = sub["credential"] as? [String: Any],
               let label = cred["label"] as? String {
                subscription = label
            }
            saveCreds()
            return status()
        }
        return ["ok": false, "error": (obj["message"] as? String) ?? "登录失败"]
    }

    /// 退出登录：清掉登录 token 和自定义 token。
    /// ⚠️ 2026-10-22：同时把**所有内置 token 标记失效**，
    ///    这样界面会退回登录页（用户要求「token 失效时退回登录页」）。
    func logout() -> [String: Any] {
        userToken = ""; userName = ""; subscription = ""
        customToken = ""; customTokenRegion = ""
        // 让 status() 返回 loggedIn=false
        for (_, tk) in builtinTokens { failedTokens.insert(tk) }
        tokenValid = false
        tokenError = "已退出登录，请填入 Token 或重新登录"
        saveCreds()
        // 清自定义 token 存盘
        var cfg: [String: Any] = [:]
        if let d = try? Data(contentsOf: cfgURL),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { cfg = o }
        cfg["customToken"] = ""
        cfg["customTokenRegion"] = ""
        if let d = try? JSONSerialization.data(withJSONObject: cfg) { try? d.write(to: cfgURL) }
        return ["ok": true]
    }

    // MARK: - Token 管理

    /// 设置自定义 token（界面填写）
    func setCustomToken(_ p: [String: Any]) -> [String: Any] {
        let tk = ((p["token"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let region = (p["region"] as? String) ?? ""
        customToken = tk
        customTokenRegion = region
        failedTokens.removeAll()          // 重置失效标记，重新尝试
        tokenValid = nil
        tokenError = ""
        // 存盘
        var cfg: [String: Any] = [:]
        if let d = try? Data(contentsOf: cfgURL),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { cfg = o }
        cfg["customToken"] = customToken
        cfg["customTokenRegion"] = customTokenRegion
        if let d = try? JSONSerialization.data(withJSONObject: cfg) { try? d.write(to: cfgURL) }
        // 立即验证
        Task { _ = await request("catalog/search", ["query": "test", "limit": "1"]) }
        return ["ok": true, "hasCustomToken": !customToken.isEmpty]
    }

    /// 清除自定义 token（回到内置 token）
    func clearCustomToken() -> [String: Any] {
        customToken = ""
        customTokenRegion = ""
        failedTokens.removeAll()
        tokenValid = nil
        tokenError = ""
        var cfg: [String: Any] = [:]
        if let d = try? Data(contentsOf: cfgURL),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { cfg = o }
        cfg["customToken"] = ""
        cfg["customTokenRegion"] = ""
        if let d = try? JSONSerialization.data(withJSONObject: cfg) { try? d.write(to: cfgURL) }
        return ["ok": true]
    }

    /// token 状态详情（给界面显示）
    func tokenStatus() -> [String: Any] {
        let list: [[String: Any]] = allTokens.map {
            ["region": $0.0, "preview": String($0.1.prefix(12)) + "...",
             "failed": failedTokens.contains($0.1)]
        }
        return [
            "hasCustomToken": !customToken.isEmpty,
            "customRegion": customTokenRegion,
            "tokenValid": tokenValid.map { $0 ? 1 : 0 } ?? -1,
            "error": tokenError,
            "tokens": list,
            "activeIsCustom": !customToken.isEmpty || !userToken.isEmpty,
            "frontendUrl": "https://www.qobuz.com/us-en/shop",
        ]
    }

    // MARK: - 搜索

    func search(_ p: [String: Any]) async -> [String: Any] {
        let query = (p["query"] as? String) ?? ""
        let limit = (p["limit"] as? Int) ?? 20
        guard !query.isEmpty else { return ["albums": [], "tracks": [], "artists": []] }
        guard let obj = await request("catalog/search", [
            "query": query, "limit": String(limit),
        ]) else {
            return ["albums": [], "tracks": [], "artists": [], "error": "请求失败"]
        }
        func items(_ key: String) -> [[String: Any]] {
            ((obj[key] as? [String: Any])?["items"] as? [[String: Any]]) ?? []
        }
        return ["albums": items("albums"), "tracks": items("tracks"), "artists": items("artists")]
    }

    // MARK: - 专辑 / 歌单

    func albumGet(_ p: [String: Any]) async -> [String: Any] {
        let id = (p["albumId"] as? String) ?? (p["id"] as? String) ?? ""
        guard !id.isEmpty else { return ["ok": false] }
        guard let obj = await request("album/get", ["album_id": id]) else { return ["ok": false] }
        return obj
    }

    func playlistGet(_ p: [String: Any]) async -> [String: Any] {
        let id = (p["playlistId"] as? String) ?? ""
        guard !id.isEmpty else { return ["ok": false] }
        return await request("playlist/get", ["playlist_id": id,
                                              "extra": "tracks", "limit": "500"]) ?? ["ok": false]
    }

    func userPlaylists() async -> [[String: Any]] {
        guard !userToken.isEmpty else { return [] }
        guard let obj = await request("playlist/getUserPlaylists", ["limit": "100"]) else { return [] }
        return (obj["playlists"] as? [String: Any])?["items"] as? [[String: Any]] ?? []
    }

    // MARK: - 收藏

    func favorites(_ type: String) async -> [[String: Any]] {
        guard !userToken.isEmpty else { return [] }
        guard let obj = await request("favorite/getUserFavorites", [
            "type": type, "limit": "100",
        ]) else { return [] }
        let key = type + "s"
        return (obj[key] as? [String: Any])?["items"] as? [[String: Any]] ?? []
    }

    func fav(_ p: [String: Any]) async -> [String: Any] {
        guard !userToken.isEmpty else { return ["ok": false, "error": "未登录"] }
        let type = (p["type"] as? String) ?? "album"
        let id = (p["id"] as? String) ?? ""
        let add = (p["add"] as? Bool) ?? true
        let path = add ? "favorite/create" : "favorite/delete"
        _ = await request(path, ["\(type)_ids": id])
        return ["ok": true]
    }

    // MARK: - 播放地址

    /// qobuzFileUrl({trackId, formatId}) → {url}
    /// formatId: 5=MP3 320, 6=FLAC CD, 7=FLAC 24/96, 27=FLAC 24/192
    ///
    /// ⚠️ 2026-10-22：签名算法（来自 streamrip 实现）
    ///   r_sig = "trackgetFileUrlformat_id{fmt}intentstreamtrack_id{trackId}{ts}{secret}"
    ///   request_sig = md5(r_sig)
    ///   拼接格式是「endpoint + key1value1 + key2value2 ... + ts + secret」，
    ///   不是简单的 path+appid+ts+secret。
    func fileUrl(_ p: [String: Any]) async -> [String: Any] {
        let trackId = (p["trackId"] as? String) ?? (p["id"] as? String) ?? ""
        var fmt = (p["formatId"] as? String) ?? "6"
        guard !trackId.isEmpty else { return ["url": "", "error": "缺少 trackId"] }

        let tk = activeToken
        guard !tk.isEmpty else { return ["url": "", "error": "无可用 Qobuz token"] }

        // 按音质挑 format_id，失败则降级
        var attempts: [String] = []
        let requested = fmt
        attempts.append(requested)
        if requested == "27" { attempts.append("7") }
        if requested == "7" { attempts.append("6") }
        if requested == "6" { attempts.append("5") }
        if attempts.last != "5" { attempts.append("5") }

        var lastErr = ""
        for f in attempts {
            let ts = Int(Date().timeIntervalSince1970)
            let raw = "trackgetFileUrlformat_id\(f)intentstreamtrack_id\(trackId)\(ts)\(appSecret)"
            let sig = Self.md5(raw)
            var comp = URLComponents(string: "https://www.qobuz.com/api.json/0.2/track/getFileUrl")
            comp?.queryItems = [
                .init(name: "request_ts", value: String(ts)),
                .init(name: "request_sig", value: sig),
                .init(name: "track_id", value: trackId),
                .init(name: "format_id", value: f),
                .init(name: "intent", value: "stream"),
                .init(name: "app_id", value: appId),
            ]
            guard let url = comp?.url else { continue }
            var req = URLRequest(url: url)
            req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", forHTTPHeaderField: "User-Agent")
            req.setValue(tk, forHTTPHeaderField: "X-User-Auth-Token")
            guard let (data, resp) = try? await session.data(for: req) else {
                lastErr = "网络失败"; continue
            }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            guard code == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let u = obj["url"] as? String, !u.isEmpty else {
                let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
                lastErr = msg ?? "HTTP \(code)"
                continue
            }
            let mime = (obj["mime_type"] as? String) ?? ""
            let bitDepth = (obj["bit_depth"] as? Int) ?? 0
            let rate = (obj["sampling_rate"] as? Double) ?? 0
            let isFlac = mime.contains("flac")
            let qLabel: String
            if isFlac && bitDepth > 16 { qLabel = "\(bitDepth)bit/\(Int(rate/1000))kHz" }
            else if isFlac { qLabel = "FLAC" }
            else { qLabel = "MP3 320k" }
            return ["url": u, "playable": true,
                    "format": isFlac ? "flac" : "mp3",
                    "type": isFlac ? "FLAC" : "MP3",
                    "quality": qLabel,
                    "bit_depth": bitDepth,
                    "sampling_rate": rate,
                    "lossless": isFlac,
                    "expire": 3600]
        }
        return ["url": "", "error": "Qobuz：\(lastErr.isEmpty ? "获取地址失败" : lastErr)"]
    }

    // MARK: - 链接解析

    func parseUrl(_ p: [String: Any]) async -> [String: Any] {
        let url = (p["url"] as? String) ?? ""
        // https://www.qobuz.com/gb-en/album/xxx/12345678
        if let r = url.range(of: #"/(album|track|playlist|artist)/([^/]+)/([a-z0-9]+)"#,
                             options: .regularExpression) {
            let seg = String(url[r])
            let parts = seg.split(separator: "/")
            if parts.count >= 3 {
                let type = String(parts[1])
                let id = String(parts[3])
                return ["ok": true, "type": type, "id": id]
            }
        }
        return ["ok": false]
    }

    // MARK: - 下载

    func download(_ p: [String: Any]) async -> [String: Any] {
        let items = (p["items"] as? [[String: Any]]) ?? []
        guard !items.isEmpty else { return ["ok": false, "error": "没有可下载的曲目"] }
        var ok = 0, fail = 0
        for it in items {
            let trackId = (it["id"] as? String) ?? ""
            let title = (it["title"] as? String) ?? (it["name"] as? String) ?? "未知"
            guard !trackId.isEmpty else { fail += 1; continue }
            let u = await fileUrl(["trackId": trackId, "formatId": "2"])
            guard let urlStr = u["url"] as? String, !urlStr.isEmpty else { fail += 1; continue }
            do {
                _ = try await DownloadManager.shared.download(
                    url: urlStr, name: title, singer: (it["artist"] as? String) ?? "",
                    ext: "flac")
                ok += 1
            } catch { fail += 1 }
        }
        return ["ok": true, "done": ok, "failed": fail]
    }
}
