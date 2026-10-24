// wrapper-lite 接口 + 配置 + 错误类型
//
// wrapper-lite 提供 4 个我们需要的能力：
//   /m3u8    → 播放列表地址
//   /key     → FairPlay 解密模板
//   /lyrics  → 歌词（TTML）
//   /status  → 登录状态

import Foundation

enum LiteAPI {
    static let server = "http://127.0.0.1:12340"

    /// /m3u8 → master 播放列表地址
    static func masterURL(adamId: String) async throws -> URL {
        var c = URLComponents(string: server + "/m3u8")!
        c.queryItems = [.init(name: "adamId", value: adamId)]
        var req = URLRequest(url: c.url!)
        req.timeoutInterval = 20
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let d = o["data"] as? [String: Any],
              let s = d["m3u8"] as? String,
              let u = URL(string: s) else {
            throw PlayerError.liteBadResponse("拿不到 m3u8")
        }
        return u
    }

    /// /key → 解密模板 JSON
    static func key(adamId: String, uri: String) async throws -> Data {
        var c = URLComponents(string: server + "/key")!
        c.queryItems = [.init(name: "adamId", value: adamId),
                        .init(name: "uri", value: uri)]
        var req = URLRequest(url: c.url!)
        req.timeoutInterval = 30
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let d = o["data"] as? [String: Any] else {
            throw PlayerError.liteBadResponse("拿不到解密模板")
        }
        return try JSONSerialization.data(withJSONObject: d)
    }

    /// /lyrics → TTML 文本
    static func lyrics(adamId: String, language: String = "zh-Hans-CN") async throws -> String {
        var c = URLComponents(string: server + "/lyrics")!
        c.queryItems = [
            .init(name: "adamId", value: adamId),
            .init(name: "language", value: language),
            .init(name: "syllable", value: "1"),
        ]
        var req = URLRequest(url: c.url!)
        req.timeoutInterval = 20
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let d = o["data"] as? [String: Any],
              let lyr = d["lyrics"] as? String else {
            throw PlayerError.liteBadResponse("拿不到歌词")
        }
        return lyr
    }

    /// 是否已有可用的登录凭证
    /// 判定：wrapper 报告的 regions 非空（说明已登录过并保存了凭证），
    /// 或 SearchCore.userToken 非空。
    static func hasCachedCreds() -> Bool {
        if !SearchCore.userToken.isEmpty { return true }
        // wrapper 的凭证存在它自己的目录里，这里用 regions 是否非空间接判断
        // （同步版：用一个带超时的同步请求，失败就当没有）
        let sem = DispatchSemaphore(value: 0)
        var result = false
        guard let u = URL(string: server + "/status") else { return false }
        var req = URLRequest(url: u)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            defer { sem.signal() }
            guard let data = data,
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let d = o["data"] as? [String: Any],
                  let regions = d["regions"] as? [String] else { return }
            result = !regions.isEmpty
        }.resume()
        _ = sem.wait(timeout: .now() + 2.5)
        return result
    }

    /// /status → 登录状态
    static func status() async -> (ok: Bool, regions: [String]) {
        guard let u = URL(string: server + "/status") else { return (false, []) }
        var req = URLRequest(url: u)
        req.timeoutInterval = 5
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let d = o["data"] as? [String: Any] else { return (false, []) }
            let regions = d["regions"] as? [String] ?? []
            return (!regions.isEmpty, regions)
        } catch {
            return (false, [])
        }
    }
}

// MARK: - 配置

enum PlayerConfig {
    static var cacheDir: URL {
        let u = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AnnieMac/audio")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
}

// MARK: - 错误

enum PlayerError: LocalizedError {
    case liteBadResponse(String)
    case noALACVariant
    case wasmMissing
    case decryptFailed(String)
    case searchFailed(String)
    case http(Int)
    case parse
    case noBundle
    case noToken

    var errorDescription: String? {
        switch self {
        case .liteBadResponse(let s): return "解密服务异常：\(s)"
        case .noALACVariant:          return "没有 ALAC 无损音质"
        case .wasmMissing:            return "缺少解密组件"
        case .decryptFailed(let s):   return "解密失败：\(s)"
        case .searchFailed(let s):    return "搜索失败：\(s)"
        case .http(let c):            return "HTTP \(c)"
        case .parse:                  return "数据解析失败"
        case .noBundle:               return "找不到 JS bundle"
        case .noToken:                return "提取不到 token"
        }
    }
}

typealias SearchError = PlayerError

// MARK: - TTML 歌词解析

enum TTMLParser {
    /// TTML → (LRC 原文, LRC 译文)
    static func toLRC(_ ttml: String) -> (String, String) {
        var lines: [(Double, String, String)] = []

        // 简单正则解析 <p begin="1.234" end="2.345">...</p>
        let pattern = #"<p[^>]*begin="([0-9:.]+)"[^>]*>(.*?)</p>"#
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else {
            return ("", "")
        }
        let ns = ttml as NSString
        let matches = re.matches(in: ttml, range: NSRange(location: 0, length: ns.length))

        for m in matches {
            guard m.numberOfRanges >= 3 else { continue }
            let timeStr = ns.substring(with: m.range(at: 1))
            let content = ns.substring(with: m.range(at: 2))
            let t = parseTime(timeStr)

            // 去掉标签，提取文本
            let text = stripTags(content).trimmingCharacters(in: .whitespacesAndNewlines)
            // 译文可能在 <span ttm:role="x-translation"> 里
            let trans = extractTranslation(content)
            if !text.isEmpty {
                lines.append((t, text, trans))
            }
        }

        lines.sort { $0.0 < $1.0 }
        let lrc = lines.map { "[\(formatTime($0.0))]\($0.1)" }.joined(separator: "\n")
        let tlrc = lines.filter { !$0.2.isEmpty }
                         .map { "[\(formatTime($0.0))]\($0.2)" }
                         .joined(separator: "\n")
        return (lrc, tlrc)
    }

    private static func parseTime(_ s: String) -> Double {
        // "00:01.234" 或 "1.234"
        let parts = s.split(separator: ":")
        if parts.count == 2 {
            let m = Double(parts[0]) ?? 0
            let sec = Double(parts[1]) ?? 0
            return m * 60 + sec
        }
        return Double(s) ?? 0
    }

    private static func formatTime(_ t: Double) -> String {
        let m = Int(t) / 60
        let s = t - Double(m * 60)
        return String(format: "%02d:%05.2f", m, s)
    }

    private static func stripTags(_ s: String) -> String {
        s.replacingOccurrences(of: #"<[^>]+>"#, with: "",
                               options: .regularExpression)
    }

    private static func extractTranslation(_ s: String) -> String {
        let pat = #"ttm:role="x-translation"[^>]*>(.*?)</span>"#
        guard let re = try? NSRegularExpression(pattern: pat, options: [.dotMatchesLineSeparators]) else {
            return ""
        }
        let ns = s as NSString
        if let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)),
           m.numberOfRanges >= 2 {
            return stripTags(ns.substring(with: m.range(at: 1)))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return ""
    }
}
