// 酷我音乐官方接口（不依赖第三方聚合后端）
//
// ⚠️ 为什么需要（2026-10-22）：
//   原来 kw/kg/mg/tx 全部走第三方聚合后端 yy.zddyr.top，
//   该后端已返回 403 Access denied（备用域名 zrcdy.dpdns.org 返回 410 已废弃），
//   导致除 Apple Music 与网易云外的所有平台都无法播放。
//   这里改为直接对接酷我官方接口，稳定可控。
//
// 接口说明：
//   搜索  http://search.kuwo.cn/r.s?all=<kw>&ft=music&itemset=web_2013&client=kt&pn=0&rn=30&rformat=json&encoding=utf8
//         → 返回 Python-dict 风格（单引号），需要自己解析
//   地址  http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_<rid>
//         → 纯文本 URL
//   歌词  http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=<rid>

import Foundation

final class KuwoService {
    static let shared = KuwoService()
    private init() {}

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 15
        cfg.httpAdditionalHeaders = [
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        ]
        return URLSession(configuration: cfg, delegate: ATSBypassDelegate.shared, delegateQueue: nil)
    }()

    // MARK: - 搜索

    /// 返回与其它 provider 一致的歌曲结构：
    /// {rid, songmid, name, artist, album, albumId, duration, cover, provider}
    func search(keyword: String, page: Int = 1, limit: Int = 30) async -> [[String: Any]] {
        let pn = max(0, page - 1)
        var comp = URLComponents(string: "https://search.kuwo.cn/r.s")
        comp?.queryItems = [
            .init(name: "all", value: keyword),
            .init(name: "ft", value: "music"),
            .init(name: "itemset", value: "web_2013"),
            .init(name: "client", value: "kt"),
            .init(name: "pn", value: String(pn)),
            .init(name: "rn", value: String(limit)),
            .init(name: "rformat", value: "json"),
            .init(name: "encoding", value: "utf8"),
        ]
        guard let url = comp?.url else { return [] }
        guard let (data, resp) = try? await session.data(from: url) else {
            fputs("Kuwo 搜索请求失败\n", stderr); return []
        }
        fputs("Kuwo 搜索 HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1) 字节 \(data.count)\n", stderr)
        let raw = String(data: data, encoding: .utf8) ?? ""
        let obj = Self.parseLooseDict(raw)
        let list = (obj["abslist"] as? [[String: Any]]) ?? []
        fputs("Kuwo 解析: keys=\(obj.count) abslist=\(list.count)\n", stderr)
        return list.compactMap { item -> [String: Any]? in
            let rid = Self.str(item["DC_TARGETID"] ?? item["MUSICRID"] ?? item["rid"])
            guard !rid.isEmpty else { return nil }
            var name = Self.str(item["SONGNAME"] ?? item["NAME"])
            var artist = Self.str(item["ARTIST"] ?? item["AARTIST"])
            // 酷我返回的字符串里带 HTML 实体（如 &nbsp;），统一解码
            name = Self.unescape(name)
            artist = Self.unescape(artist)
            let album = Self.unescape(Self.str(item["ALBUM"] ?? item["ALBUM_NAME"]))
            var dur = 0.0
            if let d = item["DURATION"] as? String, let v = Double(d) { dur = v }
            else if let d = item["DURATION"] as? Double { dur = d }
            else if let d = item["DURATION"] as? Int { dur = Double(d) }
            let albumId = Self.str(item["ALBUMID"] ?? item["ALBUM_ID"])
            // ⚠️ 2026-10-22：酷我搜索接口的专辑字段已废弃（ALBUMID=0、web_albumpic_short 全空），
            //    但 web_artistpic_short 有值 → 用它拼艺人头像当封面（总比没有强）。
            //    格式：120/s4s56/58/291211030.jpg → https://img1.kuwo.cn/star/starheads/120/<path>
            var cover = ""
            let artistPic = Self.str(item["web_artistpic_short"])
            if !artistPic.isEmpty {
                cover = "https://img1.kuwo.cn/star/starheads/\(artistPic)"
            } else if let rid2 = Int(rid) {
                // 兜底：官方艺人图接口（会重定向到真实图片）
                cover = "https://artistpicserver.kuwo.cn/pic.web?type=rid_pic&pictype=500&size=500&rid=\(rid2)"
            }
            return [
                "provider": "kw",
                "rid": rid,
                "songmid": rid,        // 统一用 songmid 承载平台 ID（UI 按它匹配封面/收藏）
                "hash": rid,
                "name": name,
                "title": name,
                "artist": artist,
                "singer": artist,
                "album": album,
                "albumId": albumId,
                "cover": cover, "img": cover,   // ⚠️ 必须带上，否则列表无封面
                "duration": dur,       // 秒
                "interval": String(Int(dur)),
            ]
        }
    }

    // MARK: - 播放地址

    /// 音质 → (br 参数, format 参数)
    /// ⚠️ 2026-10-22：酷我 mobi.s 的 br 参数是「码率+格式」的形式（如 2000kflac），
    ///   不是简单的 "flac"。传错会被降级成 48k aac 试听片段。
    ///   参考星海音乐源 v3.2.15 的 KW_BR_CHAIN。
    private static func brCandidates(_ quality: String) -> [(String, String)] {
        let q = quality.lowercased()
        var list: [(String, String)] = []
        if q.contains("master") || q.contains(" hires") || q.contains("hires") || q.contains("hifi") {
            list.append(("4000kflac", "flac"))      // Hi-Res
        }
        if q.contains("flac") || q.contains("hires") || q.contains("master") || q.contains("hifi") {
            list.append(("2000kflac", "flac"))      // 标准无损
        }
        if q.contains("320") || q.contains("flac") || q.contains("hires") {
            list.append(("320kmp3", "mp3"))
        }
        list.append(("320kmp3", "mp3"))
        list.append(("128kmp3", "mp3"))
        return list
    }

    func songURL(rid: String, quality: String = "flac") async -> [String: Any] {
        for (br, fmt) in Self.brCandidates(quality) {
            if let info = await mobiFetch(rid: rid, br: br, format: fmt),
               let u = info["url"] as? String, !u.isEmpty {
                let https = u.hasPrefix("http://") ? "https://" + u.dropFirst(7) : u
                let realFmt = (info["format"] as? String) ?? fmt
                // 只有真正拿到 flac 才标 FLAC
                let isLossless = realFmt.lowercased().contains("flac")
                let bitrate = (info["bitrate"] as? Int) ?? 0
                return ["url": https, "playable": true,
                        "type": realFmt.uppercased(),
                        "format": realFmt.lowercased(),
                        "quality": isLossless ? "FLAC" : "\(bitrate)k",
                        "bitrate": bitrate,
                        "lossless": isLossless,
                        "expire": 3600]
            }
        }
        return ["url": "", "error": "酷我：无版权或需要会员"]
    }

    /// 调用酷我 mobi.s 的 convert_url_with_sign（当前可用通道）
    private func mobiFetch(rid: String, br: String, format: String) async -> [String: Any]? {
        // 逐通道尝试（参考星海源的 KW_CHANNELS 优先顺序）
        let channels: [(String, String)] = [
            ("https://mobi.kuwo.cn/mobi.s", "kwplayer_ar_8.5.5.0_apk_keluze.apk"),
            ("http://nmobi.kuwo.cn/mobi.s", "kwplayercar_ar_6.1.0.0_B_jiakong_vh.apk"),
            ("http://nmobi.kuwo.cn/mobi.s", "kwplayercar_ar_6.0.0.5_B_jiakong_vh.apk"),
        ]
        for (base, source) in channels {
            var comp = URLComponents(string: base)
            comp?.queryItems = [
                .init(name: "user", value: "0"),
                .init(name: "source", value: source),
                .init(name: "type", value: "convert_url_with_sign"),
                .init(name: "br", value: br),
                .init(name: "format", value: format),
                .init(name: "sig", value: "0"),
                // ⚠️ mobi.s 的 rid **不能**带 MUSIC_ 前缀（带前缀返回 4011）
                .init(name: "rid", value: rid.replacingOccurrences(of: "MUSIC_", with: "")),
                .init(name: "network", value: "WIFI"),
                .init(name: "f", value: "web"),
            ]
            guard let url = comp?.url else { continue }
            var req = URLRequest(url: url)
            // 酷我 APP 的 UA —— 用 Safari UA 会被拒
            req.setValue("Mozilla/5.0 (Linux; Android 12) KuwoMusic/8.5.5.0 \(source)",
                         forHTTPHeaderField: "User-Agent")
            guard let (data, _) = try? await session.data(for: req) else { continue }
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            guard (obj["code"] as? Int) == 200,
                  let dd = obj["data"] as? [String: Any],
                  let u = dd["url"] as? String, !u.isEmpty, !u.hasPrefix("None") else { continue }
            return [
                "url": u,
                "format": (dd["format"] as? String) ?? format,
                "bitrate": (dd["bitrate"] as? Int) ?? 0,
            ]
        }
        return nil
    }

    /// 兼容旧接口：antiserver 只保底用（已被 mobi 取代）
    private func tryFormat(rid: String, fmt: String) async -> String? {
        return nil
    }

    // MARK: - 歌词

    func lyric(rid: String) async -> String {
        var comp = URLComponents(string: "https://m.kuwo.cn/newh5/singles/songinfoandlrc")
        comp?.queryItems = [.init(name: "musicId", value: rid)]
        guard let url = comp?.url,
              let (data, _) = try? await session.data(from: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dataObj = obj["data"] as? [String: Any],
              let list = dataObj["lrclist"] as? [[String: Any]] else { return "" }
        var out: [String] = []
        for it in list {
            let timeStr = Self.str(it["time"])
            guard !timeStr.isEmpty, let t = Double(timeStr),
                  let text = it["lineLyric"] as? String else { continue }
            let m = Int(t) / 60
            let s = t - Double(m * 60)
            out.append(String(format: "[%02d:%05.2f]%@", m, s, text))
        }
        return out.joined(separator: "\n")
    }

    // MARK: - 工具

    /// 酷我返回的是 Python dict 字符串（单引号 + True/False/None），
    /// 先转成合法 JSON 再交给 JSONSerialization。
    static func parseLooseDict(_ raw: String) -> [String: Any] {
        var s = raw
        // 单引号 → 双引号（内容里的单引号极少见，酷我接口不用）
        s = s.replacingOccurrences(of: "'", with: "\"")
        s = s.replacingOccurrences(of: ": True", with: ": true")
        s = s.replacingOccurrences(of: ": False", with: ": false")
        s = s.replacingOccurrences(of: ": None", with: ": null")
        if let d = s.data(using: .utf8),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            return o
        }
        return [:]
    }

    static func str(_ v: Any?) -> String {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        if let i = v as? Int { return String(i) }
        return ""
    }

    static func unescape(_ s: String) -> String {
        s.replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
