// Apple Music 搜索服务（用公开 WebPlay developer token 调官方 amp-api）
//
// ⚠️ 为什么需要（2026-10-23）：
//   原来 AM 板块的搜索走 `streamSearch(provider:'alac')` → SourceAPI，
//   而那个第三方聚合后端（yy.zddyr.top）早就 403 了 → AM 搜索永远没结果。
//
//   现在改成直接调 Apple 官方 amp-api：
//     1. 从 music.apple.com 的 JS bundle 里抓公开的 WebPlay developer token
//        （网页播放器公开使用，不需要用户账号，30 分钟缓存）
//     2. GET https://amp-api.music.apple.com/v1/catalog/{storefront}/search?term=...
//     3. 把结果转成 App 内部统一的 song 对象（含 adamId，供 LiteAPI 拿 m3u8/key）
//
//   播放链路：本服务只负责「搜到歌」；拿流地址和解密密钥走 LiteAPI（wrapper-lite
//   的 /m3u8 和 /key），已经在 App 里实现好了。

import Foundation

/// Apple Music 搜索（公开 developer token + amp-api）
final class AMSearchService {
    static let shared = AMSearchService()

    /// 公开 WebPlay developer token（从 music.apple.com 页面抓取）
    private var devToken: String = ""
    private var devTokenAt: Date = .distantPast
    /// 缓存 30 分钟
    private let tokenTTL: TimeInterval = 1800

    /// storefront（地区），默认从 lite 的 /status regions 推断，兜底 cn
    private var storefront: String = "cn"

    private let lock = NSLock()

    private init() {}

    // MARK: - Developer Token

    /// 抓取公开的 WebPlay developer token（失败时返回空）
    private func fetchDevToken() async -> String {
        lock.lock()
        if !devToken.isEmpty, Date().timeIntervalSince(devTokenAt) < tokenTTL {
            let t = devToken
            lock.unlock()
            return t
        }
        lock.unlock()

        let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"

        // 1. 首页，找 JS bundle 路径
        guard let homeData = await Self.get("https://music.apple.com/",
                                           ua: ua, timeout: 20),
              let html = String(data: homeData, encoding: .utf8) else { return "" }
        guard let jsRange = html.range(of: #"src="(/assets/[^"]+\.js)""#, options: .regularExpression) else {
            return ""
        }
        let jsPath = String(html[jsRange])
            .replacingOccurrences(of: "src=\"", with: "")
            .replacingOccurrences(of: "\"", with: "")
        guard jsPath.hasPrefix("/") else { return "" }

        // 2. 抓 JS bundle，找 eyJ 开头的 JWT
        guard let jsData = await Self.get("https://music.apple.com" + jsPath,
                                          ua: ua, timeout: 30),
              let js = String(data: jsData, encoding: .utf8) else { return "" }
        guard let m = js.range(of: #"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}"#,
                               options: .regularExpression) else { return "" }
        let token = String(js[m])
        if !token.isEmpty {
            lock.lock()
            devToken = token
            devTokenAt = Date()
            lock.unlock()
            fputs("AM 搜索: developer token 已获取 (\(token.count) 字符)\n", stderr)
        }
        return token
    }

    /// 从 lite 服务的 /status 推断 storefront（失败用 cn）
    private func refreshStorefront() async {
        let (ok, regions) = await LiteAPI.status()
        if ok, let r = regions.first, !r.isEmpty {
            lock.lock()
            storefront = r.lowercased()
            lock.unlock()
        }
    }

    // MARK: - 搜索

    /// 搜索歌曲
    /// - Returns: `{songs: [...], page, allPage, total}`（和 streamSearch 兼容）
    func search(keyword: String, page: Int = 1, limit: Int = 30) async -> [String: Any] {
        let kw = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !kw.isEmpty else {
            return ["songs": [Any](), "page": page, "allPage": 1, "total": 0]
        }
        let token = await fetchDevToken()
        guard !token.isEmpty else {
            return ["songs": [Any](), "page": page, "allPage": 1, "total": 0,
                    "error": "拿不到 Apple Music developer token（网络问题？）"]
        }
        await refreshStorefront()
        lock.lock()
        let sf = storefront
        lock.unlock()

        var comps = URLComponents(string: "https://amp-api.music.apple.com/v1/catalog/\(sf)/search")!
        comps.queryItems = [
            .init(name: "term", value: kw),
            .init(name: "types", value: "songs"),
            .init(name: "limit", value: String(limit)),
            .init(name: "offset", value: String(max(0, (page - 1) * limit))),
        ]
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = 25
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("https://music.apple.com", forHTTPHeaderField: "Origin")
        req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                     + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
                     forHTTPHeaderField: "User-Agent")

        var songs: [[String: Any]] = []
        var total = 0
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if code == 401 || code == 403 {
                // token 失效，清缓存让下次重抓
                lock.lock(); devToken = ""; devTokenAt = .distantPast; lock.unlock()
            }
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return ["songs": [Any](), "page": page, "allPage": 1, "total": 0,
                        "error": "Apple Music 返回非 JSON（HTTP \(code)）"]
            }
            let results = obj["results"] as? [String: Any] ?? [:]
            let songBlock = results["songs"] as? [String: Any] ?? [:]
            let dataArr = songBlock["data"] as? [[String: Any]] ?? []
            total = songBlock["total"] as? Int ?? dataArr.count
            for d in dataArr {
                if let s = Self.toSong(d) { songs.append(s) }
            }
        } catch {
            return ["songs": [Any](), "page": page, "allPage": 1, "total": 0,
                    "error": "搜索请求失败：\(error.localizedDescription)"]
        }

        let allPage = max(1, Int(ceil(Double(total) / Double(max(1, limit)))))
        return ["songs": songs, "page": page, "allPage": allPage, "total": total, "storefront": sf]
    }

    /// amp-api 的 song 对象 → App 内部 song 格式
    private static func toSong(_ d: [String: Any]) -> [String: Any]? {
        let a = d["attributes"] as? [String: Any] ?? [:]
        guard let name = a["name"] as? String, !name.isEmpty else { return nil }
        let id = (d["id"] as? String) ?? ""
        var out: [String: Any] = [
            "name": name,
            "songname": name,
            "title": name,
            "artist": (a["artistName"] as? String) ?? "",
            "singer": (a["artistName"] as? String) ?? "",
            "album": (a["albumName"] as? String) ?? "",
            "albumName": (a["albumName"] as? String) ?? "",
            "adamId": id,
            "songmid": id,
            "provider": "alac",
            "source": "alac",
        ]
        if let durMs = a["durationInMillis"] as? Int {
            out["duration"] = Double(durMs) / 1000.0
            out["interval"] = String(format: "%.2f", Double(durMs) / 1000.0)
        }
        // 封面：artwork.url 里 {w}x{h} 占位
        if let art = a["artwork"] as? [String: Any],
           let urlTpl = art["url"] as? String {
            let cover = urlTpl
                .replacingOccurrences(of: "{w}", with: "300")
                .replacingOccurrences(of: "{h}", with: "300")
            out["cover"] = cover
            out["img"] = cover
            out["pic"] = cover
        }
        if let isrc = a["isrc"] as? String { out["isrc"] = isrc }
        if let tn = a["trackNumber"] as? Int { out["track"] = tn }
        if let hasLy = a["hasLyrics"] as? Bool { out["hasLyrics"] = hasLy }
        return out
    }

    // MARK: - HTTP

    private static func get(_ urlStr: String, ua: String,
                            timeout: TimeInterval) async -> Data? {
        guard let url = URL(string: urlStr) else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        return try? await URLSession.shared.data(for: req).0
    }
}
