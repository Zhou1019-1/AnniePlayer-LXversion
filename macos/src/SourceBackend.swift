// 音源后端配置 —— 多后端优先级 + 自动回退
//
// ⚠️ 2026-10-22 现状：
//   · 原第三方聚合后端 yy.zddyr.top / zrcdy.dpdns.org 已失效（403 / 410）
//   · 各平台官方接口拿不到 FLAC（免费额度只有 mp3，平台付费墙）
//   · Apple Music ALAC 是当前唯一的无损路径
//
// 设计目标：拿到新后端地址后，**只改这里就能全平台恢复无损**，不用动业务代码。
//
// 用法：
//   1. 用户在「设置 → 音源后端」里填地址（存 UserDefaults + 文件），或
//   2. 直接改下面的 lxBackends 默认值。
//
// 后端协议（兼容原洛雪 lx api）：
//   GET {base}/lx/api/?source=<kw|kg|tx|wy|mg>&quality=<128k|320k|flac|hires>&songmid=<id>&hash=<hash>&mainHash=<hash>
//   返回 JSON：
//     { "url": "https://...", "quality": "flac", "headers": {...} }
//   或纯文本 URL
//
// 也支持 GD Studio 风格：
//   GET {base}/api.php?types=url&source=<kw|kg|...>&id=<id>&br=<999|320|128>

import Foundation

final class SourceBackendConfig {
    static let shared = SourceBackendConfig()
    private init() { load() }

    /// 内置默认后端列表（用户拿到新地址后自动生效）
    /// 格式：(名称, baseURL, 协议)
    /// 协议："lx" = 洛雪 lx/api；"gd" = gdstudio api.php
    static let lxBackends: [(String, String, String)] = [
        // ⚠️ 2026-10-22 修正：这个后端**一直可用**！
        //    之前我传了假 songmid=test 测试，被后端当恶意请求返回 403，误判为「已封」。
        //    实际上必须带**完整参数**（songmid + albumId + mainHash + hash）才会正常响应。
        ("zddyr 聚合", "https://yy.zddyr.top", "lx"),
        ("zrcdy 备用", "https://zrcdy.dpdns.org", "lx"),
    ]

    /// 用户自定义后端（设置里填的）
    private(set) var custom: [(String, String, String)] = []

    private var cfgURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("AnnieMac")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("source-backends.json")
    }

    private func load() {
        guard let d = try? Data(contentsOf: cfgURL),
              let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return }
        custom = arr.compactMap { o in
            guard let name = o["name"] as? String,
                  let url = o["url"] as? String else { return nil }
            return (name, url, (o["kind"] as? String) ?? "lx")
        }
    }

    func save(_ list: [(String, String, String)]) {
        custom = list
        let arr: [[String: Any]] = list.map { ["name": $0.0, "url": $0.1, "kind": $0.2] }
        if let d = try? JSONSerialization.data(withJSONObject: arr) { try? d.write(to: cfgURL) }
    }

    /// 全部后端（自定义优先，然后内置）
    var all: [(String, String, String)] { custom + Self.lxBackends }

    func snapshot() -> [[String: Any]] {
        all.map { ["name": $0.0, "url": $0.1, "kind": $0.2] }
    }
}

// MARK: - 通过第三方后端取播放地址

final class SourceBackend {
    static let shared = SourceBackend()
    private init() {}

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 12
        cfg.httpAdditionalHeaders = [
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        ]
        return URLSession(configuration: cfg, delegate: ATSBypassDelegate.shared, delegateQueue: nil)
    }()

    /// 依次尝试所有后端，返回第一个成功的地址
    /// - Parameters:
    ///   - provider: kw / kg / tx / wy / mg
    ///   - quality: 128k / 320k / flac / hires / atmos / master
    ///   - songmid: 平台 ID
    ///   - hash: 酷狗等平台的 hash
    /// - Returns: ["url":..., "quality":..., "headers":...] 或 nil
    func songURL(provider: String, quality: String,
                 songmid: String, hash: String = "",
                 albumId: String = "", typesHash: String = "") async -> [String: Any]? {
        let backends = SourceBackendConfig.shared.all
        guard !backends.isEmpty else { return nil }
        for (name, base, kind) in backends {
            let r: [String: Any]?
            if kind == "gd" {
                r = await gdQuery(base: base, provider: provider,
                                  songmid: songmid, quality: quality)
            } else {
                r = await lxQuery(base: base, provider: provider, quality: quality,
                                  songmid: songmid, hash: hash,
                                  albumId: albumId, typesHash: typesHash)
            }
            if let r = r, let u = r["url"] as? String, !u.isEmpty {
                fputs("[Backend] \(name) 命中 \(provider)/\(quality)\n", stderr)
                return r
            }
            fputs("[Backend] \(name) 未命中 \(provider)/\(quality)\n", stderr)
        }
        return nil
    }

    // MARK: 洛雪协议

    private func lxQuery(base: String, provider: String, quality: String,
                         songmid: String, hash: String,
                         albumId: String = "", typesHash: String = "") async -> [String: Any]? {
        var b = base.hasSuffix("/") ? String(base.dropLast()) : base
        if !b.contains("/lx/api") { b += "/lx/api/" }
        var comp = URLComponents(string: b)
        var items: [URLQueryItem] = [
            .init(name: "source", value: provider),
            .init(name: "quality", value: quality),
            .init(name: "songmid", value: songmid),
        ]
        // ⚠️ 酷狗后端要求完整参数，缺任何一个都可能被判为非授权请求
        if !albumId.isEmpty { items.append(.init(name: "albumId", value: albumId)) }
        if !hash.isEmpty {
            items.append(.init(name: "mainHash", value: hash))
            // 该音质档位的 hash（酷狗各档 hash 不同，优先用它）
            items.append(.init(name: "hash", value: typesHash.isEmpty ? hash : typesHash))
        }
        comp?.queryItems = items
        guard let url = comp?.url else { return nil }
        return await parseResponse(url: url, wantQuality: quality)
    }

    // MARK: GD Studio 协议

    private func gdQuery(base: String, provider: String,
                         songmid: String, quality: String) async -> [String: Any]? {
        var b = base.hasSuffix("/") ? String(base.dropLast()) : base
        if !b.contains("/api.php") { b += "/api.php" }
        // 音质映射：999=flac, 320, 128
        let br: String
        let q = quality.lowercased()
        if q.contains("flac") || q.contains("hires") || q.contains("master") { br = "999" }
        else if q.contains("320") { br = "320" }
        else { br = "128" }
        let srcMap = ["kw": "kuwo", "kg": "kugou", "tx": "tencent",
                      "wy": "netease", "mg": "migu"]
        var comp = URLComponents(string: b)
        comp?.queryItems = [
            .init(name: "types", value: "url"),
            .init(name: "source", value: srcMap[provider] ?? provider),
            .init(name: "id", value: songmid),
            .init(name: "br", value: br),
        ]
        guard let url = comp?.url else { return nil }
        return await parseResponse(url: url, wantQuality: quality)
    }

    // MARK: 响应解析

    private func parseResponse(url: URL, wantQuality: String) async -> [String: Any]? {
        guard let (data, resp) = try? await session.data(from: url) else { return nil }
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        let text = (String(data: data, encoding: .utf8) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }

        // 1. 纯文本 URL
        if text.hasPrefix("http") {
            return ["url": normalize(text), "playable": true,
                    "quality": wantQuality, "format": guessFormat(text)]
        }
        // 2. JSON
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        var urlStr = ""
        if let u = obj["url"] as? String { urlStr = u }
        else if let arr = obj["url"] as? [String], let u = arr.first { urlStr = u }
        else if let d = obj["data"] as? [String: Any], let u = d["url"] as? String { urlStr = u }
        guard !urlStr.isEmpty else { return nil }

        // ⚠️ 后端会明确返回真实格式/音质，以及是否降级（quality_fallback）
        var out: [String: Any] = ["url": normalize(urlStr), "playable": true]
        // 优先用后端给的 format（比猜 URL 扩展名可靠）
        if let f = obj["format"] as? String, !f.isEmpty {
            out["format"] = f.lowercased()
        } else if let t = obj["type"] as? String, !t.isEmpty {
            out["format"] = t.lowercased()
        } else {
            out["format"] = guessFormat(urlStr)
        }
        // quality 用后端实际返回的档位
        if let q = obj["quality"] as? String, !q.isEmpty { out["quality"] = q }
        else { out["quality"] = wantQuality }
        // 是否降级（后端明确字段）
        if let fb = obj["quality_fallback"] as? Int { out["quality_fallback"] = fb }
        if let qr = obj["quality_requested"] as? String { out["quality_requested"] = qr }
        if let h = obj["headers"] as? [String: Any] { out["headers"] = h }
        // 是否有无损（供前端判定）
        let fmt = (out["format"] as? String) ?? ""
        out["lossless"] = fmt.contains("flac") || fmt.contains("alac")
        return out
    }

    private func normalize(_ u: String) -> String {
        // 统一升级 https（ATS + 稳定性）
        u.hasPrefix("http://") ? "https://" + u.dropFirst(7) : u
    }

    private func guessFormat(_ u: String) -> String {
        let l = u.lowercased()
        if l.contains(".flac") { return "flac" }
        if l.contains(".m4a") || l.contains(".mp4") { return "m4a" }
        if l.contains(".aac") { return "aac" }
        return "mp3"
    }
}
