// 酷狗音乐官方接口
//
// ⚠️ 背景（2026-10-22）：
//   第三方聚合后端 yy.zddyr.top 已 403，酷狗需要改走官方接口。
//
// 用到的接口（来自 LxSDK 的 kg 实现，已验证可用）：
//   1. 搜索   http://mobilecdn.kugou.com/api/v3/search/song
//            ?format=json&keyword=<kw>&page=1&pagesize=30&showtype=1
//            → data.info[{hash, sqhash, 320hash, songname, singername, album_name, duration}]
//   2. 音频信息 POST http://gateway.kugou.com/v3/album_audio/audio
//            特殊头：KG-THash/KG-RC/KG-Fake/KG-RF + x-router
//            → data[0][0].audio_info.{hash, hash_320, hash_flac, ...}
//   3. 播放地址 http://trackercdn.kugou.com/i/v2/?hash=<hash>&key=<md5(hash+"kgcloudv2")>
//            → status=1 时返回 urls[]
//
// 说明：酷狗对部分歌曲需要付费/会员，此时各接口都返回空地址，属于正常现象。

import Foundation
import CommonCrypto

final class KugouService {
    static let shared = KugouService()
    private init() {}

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 15
        // ⚠️ ATS：Info.plist 的 NSAllowsArbitraryLoads 只影响 WKWebView，
        //    URLSession 仍然拒绝 http://（错误 -1022）。
        //    URLSessionConfiguration 没有直接绕过开关，但用 ephemeral + 允许代理
        //    仍然受限 —— 因此这里把 URL 统一升级到 https（gateway/trackercdn 支持），
        //    搜索域名 mobilecdn 只支持 http，改走 URLSession 的「仅此一次」豁免：
        //    URLRequest 上设 allowsCellularAccess 没用，真正管用的是
        //    Info.plist 的 NSExceptionDomains（见下方注释）。
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg, delegate: ATSBypassDelegate.shared, delegateQueue: nil)
    }()

    // MARK: - 搜索

    func search(keyword: String, page: Int = 1, limit: Int = 30) async -> [[String: Any]] {
        var comp = URLComponents(string: "http://mobilecdn.kugou.com/api/v3/search/song")
        comp?.queryItems = [
            .init(name: "format", value: "json"),
            .init(name: "keyword", value: keyword),
            .init(name: "page", value: String(page)),
            .init(name: "pagesize", value: String(limit)),
            .init(name: "showtype", value: "1"),
        ]
        guard let url = comp?.url else { return [] }
        var req = URLRequest(url: url)
        // ⚠️ 2026-10-22：完整 UA —— 简写的 Mozilla/5.0 会被酷狗 CDN 返回 502
        req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
                     forHTTPHeaderField: "User-Agent")
        req.setValue("https://www.kugou.com/", forHTTPHeaderField: "Referer")
        do {
            let (data, resp) = try await session.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            fputs("Kugou 搜索 HTTP \(code) 字节 \(data.count)\n", stderr)
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let d = obj["data"] as? [String: Any],
                  let info = d["info"] as? [[String: Any]] else {
                fputs("Kugou 搜索解析失败: \(String(data: data.prefix(200), encoding: .utf8) ?? "")\n", stderr)
                return []
            }
            return Self.mapList(info)
        } catch {
            fputs("Kugou 搜索异常: \(error)\n", stderr)
            return []
        }
    }

    private static func mapList(_ info: [[String: Any]]) -> [[String: Any]] {
        return info.compactMap { it -> [String: Any]? in
            let hash = (it["hash"] as? String) ?? ""
            guard !hash.isEmpty else { return nil }
            let name = (it["songname"] as? String) ?? ""
            let artist = (it["singername"] as? String) ?? ""
            let album = (it["album_name"] as? String) ?? ""
            let albumId = Self.str(it["album_id"])
            var dur = 0.0
            if let v = it["duration"] as? Int { dur = Double(v) }
            else if let v = it["duration"] as? Double { dur = v }
            else if let v = it["duration"] as? String, let x = Double(v) { dur = x }
            // 各档位 hash（取播放地址时按音质挑）
            var extra: [String: Any] = [:]
            if let h = it["320hash"] as? String, !h.isEmpty { extra["hash_320"] = h }
            if let h = it["sqhash"] as? String, !h.isEmpty { extra["hash_flac"] = h }
            // ⚠️ 2026-10-22 修正：之前用 album_id 拼 /stdmusic/240/<album_id>.jpg，
            //    结果**所有歌都返回同一张占位图**（酷狗对无效路径返回固定 17853 字节图片）。
            //    真正的封面在 trans_param.union_cover，格式：
            //      http://imge.kugou.com/stdmusic/{size}/20230920/xxx.jpg
            //    把 {size} 替换成 240/480 即可。
            var cover = ""
            if let trans = it["trans_param"] as? [String: Any],
               let uc = trans["union_cover"] as? String, !uc.isEmpty {
                cover = uc.replacingOccurrences(of: "{size}", with: "240")
                if cover.hasPrefix("http://") {
                    cover = "https://" + cover.dropFirst(7)
                }
            }
            return [
                "provider": "kg",
                "hash": hash,
                "songmid": hash,     // UI 统一用 songmid 匹配
                "name": name, "title": name,
                "artist": artist, "singer": artist,
                "album": album, "albumName": album,
                "albumId": albumId,
                "cover": cover, "img": cover,
                "duration": dur, "interval": String(Int(dur)),
                "_kg": extra,
            ]
        }
    }

    // MARK: - 取各音质 hash（v3 album_audio/audio）

    /// 返回 ["320k": hash, "flac": hash, ...]
    private func audioHashes(_ hash: String) async -> [String: String] {
        guard let url = URL(string: "http://gateway.kugou.com/v3/album_audio/audio") else { return [:] }
        let body: [String: Any] = [
            "area_code": "1", "show_privilege": 1, "show_album_info": "1", "is_publish": "",
            "appid": 1005, "clientver": 11451, "mid": "1", "dfid": "-",
            "clienttime": Int(Date().timeIntervalSince1970 * 1000),
            "key": "OIlwieks28dk2k092lksi2UIkp",
            "fields": "album_info,author_name,audio_info,ori_audio_name,base,songname,classification",
            "data": [["hash": hash, "audio_id": 0, "album_id": "0"]],
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: body) else { return [:] }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = d
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("13a3164", forHTTPHeaderField: "KG-THash")
        req.setValue("1", forHTTPHeaderField: "KG-RC")
        req.setValue("0", forHTTPHeaderField: "KG-Fake")
        req.setValue("00869891", forHTTPHeaderField: "KG-RF")
        req.setValue("kmr.service.kugou.com", forHTTPHeaderField: "x-router")
        req.setValue("Android712-AndroidPhone-11451-376-0-FeeCacheUpdate-wifi",
                     forHTTPHeaderField: "User-Agent")
        guard let (raw, _) = try? await session.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let arr = obj["data"] as? [[[String: Any]]],
              let first = arr.first?.first,
              let ai = first["audio_info"] as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (k, v) in [("128k", "hash"), ("320k", "hash_320"), ("flac", "hash_flac")] {
            if let h = ai[v] as? String, !h.isEmpty { out[k] = h }
        }
        return out
    }

    // MARK: - 播放地址

    func songURL(hash: String, quality: String, extra: [String: Any] = [:]) async -> [String: Any] {
        // 1. 先挑该音质对应的 hash（搜索里可能已有）
        var candidates: [String] = []
        let q = quality.lowercased()
        if q.contains("flac") || q.contains("sq") || q.contains("hires") {
            if let h = extra["hash_flac"] as? String { candidates.append(h) }
        } else if q.contains("320") {
            if let h = extra["hash_320"] as? String { candidates.append(h) }
        }
        candidates.append(hash)   // 原 hash 兜底

        // 2. 若搜索没带档位 hash，去 gateway 查
        if candidates.count == 1 {
            let hs = await audioHashes(hash)
            if q.contains("flac") || q.contains("sq") || q.contains("hires"),
               let h = hs["flac"] { candidates.insert(h, at: 0) }
            else if q.contains("320"), let h = hs["320k"] { candidates.insert(h, at: 0) }
            if let h = hs["320k"] { candidates.append(h) }
            if let h = hs["128k"] { candidates.append(h) }
        } else {
            // 补全兜底档位
            if let h = extra["hash_320"] as? String, h != hash { candidates.append(h) }
        }

        var seen = Set<String>()
        for h in candidates {
            if seen.contains(h) { continue }
            seen.insert(h)
            if let (url, br) = await trackerURLInfo(h) {
                let https = url.replacingOccurrences(of: "http://", with: "https://")
                let isFlac = url.lowercased().contains(".flac")
                let ext = isFlac ? "FLAC" : "MP3"
                // 实际音质标签：flac 用 FLAC，mp3 用码率
                let realQuality = isFlac ? "FLAC" : (br > 0 ? "\(br)k" : "MP3")
                return ["url": https, "playable": true,
                        "type": ext, "format": ext.lowercased(),
                        "bitrate": br, "quality": realQuality,
                        "lossless": isFlac, "expire": 3600]
            }
        }
        // ⚠️ 2026-10-22：trackercdn 对热门版权歌返回 status=0（需会员）。
        //    最后兜底试移动端旧接口 —— 它常能给出 128k mp3，让「完全不能播」变成「能播但音质低」。
        if let m = await mobileSongInfo(hash) {
            return m
        }
        return ["url": "", "error": "酷狗：该曲目需要会员或已下架"]
    }

    /// 移动端旧接口兜底（https://m.kugou.com/app/i/getSongInfo.php）
    /// 只给 128k mp3，但覆盖面比 trackercdn 广得多。
    private func mobileSongInfo(_ hash: String) async -> [String: Any]? {
        var comp = URLComponents(string: "https://m.kugou.com/app/i/getSongInfo.php")
        comp?.queryItems = [
            .init(name: "cmd", value: "playInfo"),
            .init(name: "hash", value: hash),
        ]
        guard let url = comp?.url else { return nil }
        var req = URLRequest(url: url)
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15",
                     forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await session.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let u = obj["url"] as? String, !u.isEmpty, !u.hasPrefix("None") else { return nil }
        let https = u.hasPrefix("http://") ? "https://" + u.dropFirst(7) : u
        var br = 0
        if let b = obj["bitRate"] as? Int { br = b }
        else if let b = obj["bitRate"] as? String, let v = Int(b) { br = v }
        let ext = (obj["extName"] as? String)?.lowercased() ?? "mp3"
        fputs("Kugou 移动端兜底命中 hash=\(hash.prefix(10)) \(br)k \(ext)\n", stderr)
        return ["url": https, "playable": true,
                "type": ext.uppercased(), "format": ext,
                "bitrate": br, "quality": br > 0 ? "\(br)k" : "MP3",
                "lossless": false, "expire": 3600]
    }

    /// 返回 (url, bitrate)。bitrate 来自酷狗响应，用于判定实际音质。
    private func trackerURLInfo(_ hash: String) async -> (String, Int)? {
        let key = Self.md5(hash.lowercased() + "kgcloudv2")
        var comp = URLComponents(string: "http://trackercdn.kugou.com/i/v2/")
        comp?.queryItems = [
            .init(name: "hash", value: hash),
            .init(name: "key", value: key),
            .init(name: "pid", value: "3"),
            .init(name: "behavior", value: "play"),
            .init(name: "cmd", value: "25"),
            .init(name: "appid", value: "1005"),
            .init(name: "version", value: "9108"),
        ]
        guard let url = comp?.url else { return nil }
        var req = URLRequest(url: url)
        req.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await session.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            fputs("Kugou tracker 请求失败 hash=\(hash.prefix(10))\n", stderr)
            return nil
        }
        // 酷狗返回 {"status":1,"url":["http://..."],"bitrate":320,...}
        if let status = obj["status"] as? Int, status == 1 {
            var found: String?
            if let urls = obj["url"] as? [String], let u = urls.first, !u.isEmpty { found = u }
            if found == nil, let u = obj["url"] as? String, !u.isEmpty { found = u }
            if let f = found {
                var br = 0
                if let b = obj["bitrate"] as? Int { br = b }
                else if let b = obj["bitrate"] as? String, let v = Int(b) { br = v }
                return (f, br)
            }
        }
        let err = (obj["error"] as? String) ?? (obj["status"] as? Int == 2 ? "无版权/需会员" : "未知")
        fputs("Kugou tracker 无地址 hash=\(hash.prefix(10)) status=\(obj["status"] ?? "?") err=\(err)\n", stderr)
        return nil
    }

    // MARK: - 工具

    static func md5(_ s: String) -> String {
        guard let data = s.data(using: .utf8) else { return "" }
        var digest = [UInt8](repeating: 0, count: Int(CC_MD5_DIGEST_LENGTH))
        data.withUnsafeBytes { ptr in
            _ = CC_MD5(ptr.baseAddress, CC_LONG(data.count), &digest)
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func str(_ v: Any?) -> String {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return ""
    }
}
