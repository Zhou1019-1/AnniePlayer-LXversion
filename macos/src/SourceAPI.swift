// Apple Music 音源 —— 搜索 / 播放地址 / 歌词 / 封面
//
// 这是我们的核心竞争力：用 amp-api + wrapper-lite 提供 Apple Music 音源。
// 其他四个平台（网易云/QQ/酷狗/酷我/咪咕）后续接入。

import Foundation

final class SourceAPI {
    static let shared = SourceAPI()
    private init() {}

    // MARK: - 搜索

    /// streamSearch({provider, keywords, page, limit})
    /// → {songs: [...], page, allPage, total}
    ///
    /// ⚠️ 返回格式必须和 am-stream.js 对齐（2026-10-21 修）：
    ///    他们读的是 r.songs / r.page / r.allPage / r.total，不是 r.list
    func search(args: [Any]) async -> Any? {
        let dict = args.first as? [String: Any] ?? [:]
        let provider = (dict["provider"] as? String) ?? "alac"
        let keyword = (dict["keywords"] as? String)
            ?? (dict["keyword"] as? String) ?? ""
        let page = (dict["page"] as? Int) ?? 1
        let limit = (dict["limit"] as? Int) ?? 30

        guard !keyword.isEmpty else {
            return ["songs": [Any](), "page": page, "allPage": 1, "total": 0]
        }

        // ⚠️ 2026-10-24：接上洛雪五平台（酷我/酷狗/QQ/网易云/咪咕）。
        //   之前这里只放行 alac，其余平台直接返回空 —— 但 Bridge 里早就写好了
        //   searchViaLxSDK（实测五平台全部能搜到歌），只是一直没被调用。
        //   播放链路 songURL 早就支持这五个平台（各自平台自己的音源解析，
        //   不做跨平台匹配），所以打开搜索即可完整可用。
        if ["kw", "kg", "tx", "wy", "mg", "bd"].contains(provider) {
            fputs("search 走洛雪 SDK: provider=\(provider) kw=\(keyword)\n", stderr)
            if let r = await Bridge.shared.searchViaLxSDK(
                provider: provider, keyword: keyword, page: page, limit: limit) {
                return r
            }
            return ["songs": [Any](), "page": page, "allPage": 1, "total": 0]
        }

        // Apple Music（ALAC）
        guard provider == "alac" || provider == "apple" else {
            return ["songs": [Any](), "page": page, "allPage": 1, "total": 0]
        }

        do {
            let token = try await SearchCore.developerToken()
            let songs = try await SearchCore.search(keyword, token: token)

            // 简化分页：一次拿全部（他们的 UI 支持 allPage）
            let start = (page - 1) * limit
            let sliced = Array(songs.dropFirst(start).prefix(limit))
            let allPage = max(1, Int(ceil(Double(songs.count) / Double(limit))))

            return [
                "songs": sliced.map { s -> [String: Any] in
                    [
                        "id": s.id,
                        "songmid": s.id,
                        "name": s.title,
                        // ⚠️ 他们 UI 读 artist/album（2026-10-21）：
                        //    只给 singer/albumName 会导致「未知艺人」和专辑空白。
                        "singer": s.artist,
                        "artist": s.artist,
                        "albumName": s.album,
                        "album": s.album,
                        "interval": (s.durationMs ?? 0) / 1000,
                        "source": "alac",
                        "provider": "alac",
                        "sourceName": "Apple Music",
                        "img": s.artworkURL?.absoluteString ?? "",
                        "cover": s.artworkURL?.absoluteString ?? "",
                        // 音质：ALAC 无损
                        "types": [["type": "alac", "size": "origin", "label": "ALAC"]],
                        "type": "alac",
                    ]
                },
                "page": page,
                "allPage": allPage,
                "total": songs.count,
            ]
        } catch {
            return ["songs": [Any](), "page": page, "allPage": 1,
                    "total": 0, "error": error.localizedDescription]
        }
    }

    /// streamSongUrl({source, songmid, quality}) → {url, type, quality}
    func songURL(args: [Any]) async -> Any? {
        let dict0 = args.first as? [String: Any] ?? [:]
        // ⚠️ 他们的 UI 传的是 {provider, quality, song}（2026-10-21）：
        //    song 里才有 songmid/hash 等完整信息，展开到顶层兼容两种传法。
        var dict = dict0
        if let inner = dict0["song"] as? [String: Any] {
            for (k, v) in inner { dict[k] = v }
        }
        let source = (dict["source"] as? String) ?? (dict0["provider"] as? String) ?? "alac"
        // ⚠️ songmid 可能是数字也可能是字符串（2026-10-21）：
        //    酷狗/网易云返回的是 Number，酷我/咪咕返回 String。
        var adamId = (dict["songmid"] as? String) ?? (dict["id"] as? String) ?? ""
        if adamId.isEmpty {
            if let n = dict["songmid"] as? Int { adamId = String(n) }
            else if let n = dict["songmid"] as? NSNumber { adamId = n.stringValue }
        }
        let quality = (dict["quality"] as? String) ?? "320k"
        guard !adamId.isEmpty else { return ["url": ""] }

        // ⚠️ 非 Apple 平台（2026-10-21）：
        //    洛雪 SDK 的播放地址依赖 __svlxApis（用户自定义音源脚本运行时），
        //    那是 Node child_process 沙箱，浏览器里没有。
        //    ⚠️ 用户明确要求：**不能跨平台匹配**（不能用 AM 播酷我的歌），
        //    所以这里必须用各平台自己的音源解析。
        if ["kw", "kg", "tx", "wy", "mg"].contains(source) {
            let name = (dict["name"] as? String) ?? ""
            fputs("songURL 走音源脚本: source=\(source) keys=\(dict.keys.sorted().joined(separator: ","))\n", stderr)
            return await songURLViaLxSDK(source: source, songInfo: dict, quality: quality)
        }

        do {
            let master = try await LiteAPI.masterURL(adamId: adamId)
            let variant = try await HLS.selectALAC(master: master)
            let template = try await LiteAPI.key(adamId: adamId, uri: variant.keyURI)
            let file = try await AudioFetcher.build(
                variant: variant, template: template, cacheKey: adamId
            ) { _, _ in }
            return ["url": file.absoluteString, "playable": true, "type": "local",
                    "quality": "alac", "format": "alac"]
        } catch {
            return ["url": "", "playable": false, "message": error.localizedDescription]
        }
    }

    /// 跨平台兜底：用歌名+歌手去 Apple Music 搜，找到后按 ALAC 播放
    private func playViaAppleMusic(name: String, singer: String,
                                   quality: String, origin: String) async -> Any? {
        do {
            let token = try await SearchCore.developerToken()
            let query = singer.isEmpty ? name : "\(name) \(singer)"
            let hits = try await SearchCore.search(query, token: token)

            // 打分选最像的：歌名相同优先，歌手包含也加分
            let norm: (String) -> String = { s in
                s.lowercased()
                 .replacingOccurrences(of: "（", with: "(")
                 .replacingOccurrences(of: "）", with: ")")
                 .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            let target = norm(name)
            var best: SearchCore.Item?
            var bestScore = -1
            for h in hits {
                var score = 0
                let hn = norm(h.title)
                if hn == target { score += 100 }
                else if hn.contains(target) || target.contains(hn) { score += 50 }
                let hs = norm(h.artist)
                let ts = norm(singer)
                if !ts.isEmpty {
                    if hs == ts { score += 40 }
                    else if hs.contains(ts) || ts.contains(hs) { score += 20 }
                }
                if score > bestScore { bestScore = score; best = h }
            }
            guard let song = best, bestScore >= 50 else {
                return ["url": "", "error": "Apple Music 里没找到《\(name)》"]
            }

            let master = try await LiteAPI.masterURL(adamId: song.id)
            let variant = try await HLS.selectALAC(master: master)
            let template = try await LiteAPI.key(adamId: song.id, uri: variant.keyURI)
            let file = try await AudioFetcher.build(
                variant: variant, template: template, cacheKey: song.id
            ) { _, _ in }
            return [
                "url": file.absoluteString,
                "type": "local",
                "quality": "alac",
                "matched": ["name": song.title, "singer": song.artist,
                            "album": song.album, "id": song.id],
                "from": origin,
            ]
        } catch {
            return ["url": "", "error": error.localizedDescription]
        }
    }

    /// 通过音源脚本拿播放地址（各平台用自己的音源解析）
    ///
    /// ⚠️ 用户明确要求「不能跨平台匹配」，所以这里必须走各平台自己的音源。
    ///    音源脚本（洛雪格式）在网页里跑，通过 window.__sourceUrl 调用。
    private func songURLViaLxSDK(source: String, songInfo: [String: Any],
                                 quality: String) async -> Any? {
        // ⚠️ 酷狗需要 `hash` 字段（2026-10-21），SDK 返回里已经有，原样传
        guard JSONSerialization.isValidJSONObject(songInfo),
              let d = try? JSONSerialization.data(withJSONObject: songInfo),
              let jsonStr = String(data: d, encoding: .utf8) else {
            return ["url": "", "error": "参数错误"]
        }
        fputs("songURLViaLxSDK: source=\(source) hash=\(songInfo["hash"] ?? "nil") mid=\(songInfo["songmid"] ?? "nil")\n", stderr)
        do {
            // ⚠️ 传 JSON.parse(...) 而不是直接插对象字面量（2026-10-21）：
            //    直接插会遇到转义/引号问题，JSON.parse 最稳。
            // ⚠️ 音源服务会间歇 503（2026-10-22 实测酷狗）：
            //    失败后自动重试 3 次（指数退避），仍失败才报错。
            var raw: Any?
            var lastErr: Error?
            for attempt in 0..<3 {
                do {
                    let expr = "window.__sourceUrl(\(jsonString(source)), JSON.parse(\(jsonString(jsonStr))), \(jsonString(quality)))"
                    raw = try await Bridge.shared.callJS(expr)
                    lastErr = nil
                    break
                } catch {
                    lastErr = error
                    let msg = error.localizedDescription
                    fputs("songURL 第 \(attempt + 1) 次失败: \(msg)\n", stderr)
                    // 503 / 超时 才重试
                    if msg.contains("503") || msg.contains("超时") || msg.contains("timeout") {
                        try? await Task.sleep(nanoseconds: UInt64(600_000_000 * (attempt + 1)))
                        continue
                    }
                    break
                }
            }
            if let e = lastErr { throw e }
            var url = ""
            if let s = raw as? String {
                url = s
            } else if let dd = raw as? [String: Any] {
                url = (dd["url"] as? String) ?? (dd["result"] as? String) ?? ""
            }
            // 去掉可能带的首尾引号
            url = url.trimmingCharacters(in: CharacterSet(charactersIn: "\"\n\r "))
            fputs("songURL raw=\(String(describing: raw).prefix(80)) url=\(url.prefix(60))\n", stderr)
            guard !url.isEmpty else {
                return ["url": "", "playable": false, "message": "音源没返回地址"]
            }
            return ["url": url, "playable": true, "type": "remote",
                    "quality": quality, "format": quality,
                    "from": source]
        } catch {
            fputs("songURLViaLxSDK 出错: \(error)\n", stderr)
            return ["url": "", "error": error.localizedDescription]
        }
    }

    // MARK: - 下载

    /// streamDownload({provider, quality, song, _dlKey}) → {ok, path, quality}
    func download(args: [Any]) async -> Any? {
        let dict0 = args.first as? [String: Any] ?? [:]
        var dict = dict0
        if let inner = dict0["song"] as? [String: Any] {
            for (k, v) in inner { dict[k] = v }
        }
        let source = (dict["provider"] as? String) ?? (dict0["provider"] as? String) ?? "alac"
        let quality = (dict["quality"] as? String) ?? "320k"
        let name = (dict["name"] as? String) ?? "未命名"
        let singer = (dict["singer"] as? String) ?? ""

        do {
            // 1. 先拿播放地址
            let u = await songURL(args: args)
            guard let ur = u as? [String: Any],
                  let urlStr = ur["url"] as? String, !urlStr.isEmpty else {
                let err = (u as? [String: Any])?["error"] as? String ?? "拿不到下载地址"
                return ["ok": false, "error": err]
            }

            // 2. 判断扩展名
            var ext = "mp3"
            if urlStr.contains(".m4a") || urlStr.contains(".mp4") { ext = "m4a" }
            else if urlStr.contains(".flac") { ext = "flac" }
            else if urlStr.contains(".m4a") { ext = "m4a" }
            if (ur["quality"] as? String) == "alac" { ext = "m4a" }

            // 3. 取歌词和封面（可选）
            let saveLrc = (dict0["saveLrc"] as? Bool) ?? true
            let saveCover = (dict0["saveCover"] as? Bool) ?? true
            var lrcText: String? = nil
            var coverURL: String? = nil
            if saveLrc {
                if let ly = await lyric(args: args) as? [String: Any],
                   let s = ly["lrc"] as? String, !s.isEmpty {
                    lrcText = s
                }
            }
            if saveCover {
                if let pc = await picture(args: args) as? [String: Any],
                   let u2 = pc["url"] as? String, !u2.isEmpty {
                    coverURL = u2
                }
            }

            // 4. 下载（带进度）
            let dlKey = (dict0["_dlKey"] as? String) ?? ""
            let album = (dict["albumName"] as? String) ?? (dict["album"] as? String) ?? ""
            let onProgress: (DownloadProgress) -> Void = { prog in
                let js = "window.__amDownloadProgress && window.__amDownloadProgress(\(jsonString(dlKey)), \(prog.percent), \(prog.received), \(prog.total));"
                Bridge.shared.webView?.evaluateJavaScript(js) { _, _ in }
            }

            // ⚠️ 地址可能过期（2026-10-21）：酷我的播放地址有效期很短（几分钟），
            //    下载时如果 403 就重新取一次地址再试（最多 2 次）。
            var file: URL
            do {
                file = try await DownloadManager.shared.download(
                    url: urlStr, name: name, singer: singer, album: album, ext: ext,
                    lrc: lrcText, coverURL: coverURL, progress: onProgress)
            } catch {
                fputs("下载失败，重新取地址重试: \(error.localizedDescription)\n", stderr)
                let u2 = await songURL(args: args)
                guard let ur2 = u2 as? [String: Any],
                      let urlStr2 = ur2["url"] as? String, !urlStr2.isEmpty else {
                    throw error
                }
                file = try await DownloadManager.shared.download(
                    url: urlStr2, name: name, singer: singer, album: album, ext: ext,
                    lrc: lrcText, coverURL: coverURL, progress: onProgress)
            }

            return ["ok": true, "path": file.path, "quality": quality,
                    "size": (try? FileManager.default.attributesOfItem(atPath: file.path)[.size]) ?? 0,
                    "hasLrc": lrcText != nil, "hasCover": coverURL != nil]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    // MARK: - 歌词

    /// streamLyric({songmid}) → {lyric, tlyric}
    // MARK: - 歌词缓存（酷我接口有频率限制，同一首歌只请求一次）
    private static var lyricCache: [String: [String: String]] = [:]
    private static var lastLyricRequest: Date = .distantPast
    private static let lyricLock = NSLock()

    /// streamLyric({provider, song}) → {lrc, tlyric}

    /// streamLyric({provider, song}) → {lrc, tlyric}
    ///
    /// ⚠️ 各平台用**自己的**歌词接口（2026-10-21，用户要求不跨平台）：
    ///    酷我: m.kuwo.cn/newh5/singles/songinfoandlrc
    ///    酷狗: lyrics.kugou.com/search → /download
    ///    网易云: music.163.com/api/song/lyric
    ///    Apple Music: wrapper-lite /lyrics (TTML)
    func lyric(args: [Any]) async -> Any? {
        let dict0 = args.first as? [String: Any] ?? [:]
        var dict = dict0
        if let inner = dict0["song"] as? [String: Any] {
            for (k, v) in inner { dict[k] = v }
        }
        // ⚠️ provider 优先级（2026-10-21）：顶层 provider 是当前选的平台，
        //    但 song.provider 才是这首歌真正来自哪（可能不同）。
        let source = (dict0["provider"] as? String) ?? (dict["provider"] as? String)
            ?? (dict["source"] as? String) ?? (dict["source"] as? String) ?? "alac"
        // ⚠️ 取歌曲唯一 id（2026-10-21 修歌词丢失）：
        //    各平台字段不同——酷狗用 hash，酷我用 songmid(数字)，
        //    网易云用 songmid/id。之前只查 songmid+id，酷狗直接取到空串 → 歌词拿不到。
        var songid = Bridge.songIdentity(dict)
        if songid.isEmpty {
            if let n = dict["songmid"] as? Int { songid = String(n) }
            else if let n = dict["songmid"] as? NSNumber { songid = n.stringValue }
        }
        let name = (dict["name"] as? String) ?? ""
        let singer = (dict["singer"] as? String) ?? ""
        fputs("lyric: source=\(source) songid=\(songid) name=\(name) interval=\(String(describing: dict["interval"]))\n", stderr)
        fputs("lyric dict keys=\(dict.keys.sorted().joined(separator: ",")) interval=\(dict["interval"] ?? "nil") types=\(dict["types"] != nil)\n", stderr)

        // 缓存命中直接返回（避免触发限流）
        let cacheKey = "\(source):\(songid):\(name)"
        if !songid.isEmpty || !name.isEmpty,
           let hit = Self.cachedLyric(cacheKey) {
            return hit
        }

        // ⚠️ 繁简统一（2026-10-22）：各平台歌词源繁简不定（用户反馈「变成香港繁体」），
        //   接口没有语言参数，只能本地转。这里把 lyric() 的返回值统一过一遍。
        let result = await lyricDispatch(source: source, songid: songid, name: name,
                                         singer: singer, dict: dict)
        if var r = result as? [String: Any] {
            if let lrc = r["lrc"] as? String, ZhSimplify.hasTraditional(lrc) {
                r["lrc"] = ZhSimplify.simplify(lrc)
            }
            if let tl = r["tlyric"] as? String, ZhSimplify.hasTraditional(tl) {
                r["tlyric"] = ZhSimplify.simplify(tl)
            }
        }
        return result
    }

    /// 各平台歌词分发（原 lyric() 的主体）
    private func lyricDispatch(source: String, songid: String, name: String,
                               singer: String, dict: [String: Any]) async -> Any? {
        switch source {
        case "alac", "apple":
            guard !songid.isEmpty else { return ["lrc": "", "tlyric": ""] }
            do {
                let ttml = try await LiteAPI.lyrics(adamId: songid)
                let (lrc, tlrc) = TTMLParser.toLRC(ttml)
                return ["lrc": lrc, "tlyric": tlrc]
            } catch { return ["lrc": "", "tlyric": ""] }

        case "kw":
            return await lyricKuwo(id: songid)

        case "kg":
            return await lyricKugou(name: name, singer: singer,
                                    duration: (dict["interval"] as? Int) ?? 0)

        case "mg":
            // ⚠️ 咪咕歌词（2026-10-22）：
            //    咪咕的 v3 API 全部 404/405（被拦），但**搜索结果里带 lrcUrl**，
            //    直接下载那个 URL 即可（必须带 Referer: https://music.migu.cn/，
            //    否则返回 0 字节）。
            let lrcURL = (dict["lrcUrl"] as? String) ?? ""
            if lrcURL.isEmpty { return ["lrc": "", "tlyric": ""] }
            return await lyricMigu(urlStr: lrcURL)

        case "wy":
            // ⚠️ 网易云歌词时间轴整体偏后（2026-10-21 实测）：
            //    同一句「故事的小黄花」三个平台的时间戳：
            //      酷狗 [00:28.98] · 酷我 [00:29.26] · 网易云 [00:30.542]
            //    网易云比酷狗晚 1.56 秒，用户听感就是「歌词慢一两秒」。
            //    这里统一把网易云歌词的时间戳提前 1.5 秒（只动时间戳，不动文本）。
            if let r = await lyricNetease(id: songid) as? [String: Any] {
                let raw = (r["lrc"] as? String) ?? ""
                let tlRaw = (r["tlyric"] as? String) ?? ""
                if !raw.isEmpty {
                    var fixed = shiftLRCTimestamps(raw, by: -1.5)
                    var tl = tlRaw
                    if !tl.isEmpty { tl = shiftLRCTimestamps(tl, by: -1.5) }
                    return ["lrc": fixed, "tlyric": tl]
                }
                // ⚠️ 2026-10-23 修复「网易云的歌下载后没有歌词」：
                //   部分歌曲（尤其日文歌）网易云 API 的 lrc.lyric 返回空字符串，
                //   只有 tlyric（中文翻译）有内容。此前直接返回空 → 下载时判定
                //   「没拿到歌词」→ 不写 .lrc 文件。
                //   这里兜底：原歌词为空时，用翻译歌词作为主歌词。
                if !tlRaw.isEmpty {
                    return ["lrc": shiftLRCTimestamps(tlRaw, by: -1.5), "tlyric": ""]
                }
            }
            return ["lrc": "", "tlyric": ""]

        default:
            return ["lrc": "", "tlyric": ""]
        }
    }

    /// 读缓存
    private static func cachedLyric(_ key: String) -> [String: String]? {
        lyricLock.lock(); defer { lyricLock.unlock() }
        return lyricCache[key]
    }

    /// 写缓存
    private static func storeLyric(_ key: String, _ val: [String: String]) {
        lyricLock.lock(); defer { lyricLock.unlock() }
        if lyricCache.count > 200 { lyricCache.removeAll() }  // 简单上限
        lyricCache[key] = val
    }

    /// 限速：两次请求之间至少 800ms
    private static func throttleLyric() async {
        lyricLock.lock()
        let now = Date()
        let wait = max(0, 0.8 - now.timeIntervalSince(lastLyricRequest))
        lastLyricRequest = now
        lyricLock.unlock()
        if wait > 0 {
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
        }
    }

    /// 酷我歌词
    private func lyricKuwo(id: String) async -> Any? {
        await Self.throttleLyric()
        guard let u = URL(string:
            "https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=\(id)&httpsStatus=1") else {
            fputs("lyricKuwo: URL 无效\n", stderr)
            return ["lrc": "", "tlyric": ""]
        }
        var req = URLRequest(url: u)
        // ⚠️ 酷我接口需要 Referer（2026-10-21）：不带会返回 {"data":null}
        req.setValue("https://m.kuwo.cn/", forHTTPHeaderField: "Referer")
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
                     forHTTPHeaderField: "User-Agent")
        req.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 15
        // ⚠️ 酷我接口有频率限制（2026-10-21）：
        //    短时间内多次请求会返回 data:null，需要重试 + 退避。
        var list: [[String: Any]]? = nil
        for attempt in 0..<3 {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: UInt64(Double(attempt) * 1_500_000_000))
            }
            let (data, resp) = (try? await URLSession.shared.data(for: req)) ?? (Data(), nil)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let d = obj["data"] as? [String: Any],
               let l = d["lrclist"] as? [[String: Any]], !l.isEmpty {
                list = l
                break
            }
            fputs("lyricKuwo 第 \(attempt+1) 次失败: status=\(status) len=\(data.count)\n", stderr)
        }
        guard let list = list else {
            fputs("lyricKuwo 全部重试失败\n", stderr)
            return ["lrc": "", "tlyric": ""]
        }
        fputs("lyricKuwo OK: \(list.count) 行\n", stderr)
        var out = ""
        for it in list {
            guard let text = it["lineLyric"] as? String,
                  let t = Double((it["time"] as? String) ?? "0") else { continue }
            let m = Int(t) / 60
            let s = t - Double(m * 60)
            out += String(format: "[%02d:%05.2f]%@\n", m, s, text)
        }
        // ⚠️ 过滤开头的「歌曲信息行」（2026-10-21）：
        //    酷我歌词前几行是「晴天 - 周杰伦」「词：周杰伦」「曲：周杰伦」这类，
        //    它们占用了 0~15 秒的时间轴，但音频开头直接是前奏，
        //    导致后面的歌词看起来「快了」。
        //    做法：把开头连续的信息行（词/曲/编曲/制作人/...）剔除。
        let infoPrefixes = ["词：", "曲：", "编曲", "制作人", "合声", "和声", "吉他",
                            "贝斯", "鼓", "录音", "混音", "母带", "监制", "发行",
                            "出品", "OP", "SP", "Arranger", "Producer", "Composer",
                            "Lyricist", "Mixing", "Mastering", "Record"]
        let raw = out.split(separator: "\n").map(String.init)
        var filtered: [String] = []
        var skipping = true
        for line in raw {
            if skipping {
                // 提取时间戳后的正文
                if let r = line.range(of: "]", options: [], range: nil) {
                    let text = String(line[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                    if text.isEmpty { continue }
                    // 歌名行：包含 " - " 或者和歌名一致
                    let isTitle = text.contains(" - ")
                    let isInfo = infoPrefixes.contains { text.hasPrefix($0) }
                    if isTitle || isInfo { continue }
                    skipping = false
                }
            }
            filtered.append(line)
        }
        let cleaned = filtered.isEmpty ? out : filtered.joined(separator: "\n")
        Self.storeLyric("kw:\(id)", ["lrc": cleaned, "tlyric": ""])
        return ["lrc": cleaned, "tlyric": ""]
    }

    /// 平移 LRC 时间戳（只改时间，不动文本）
    /// - Parameter seconds: 正数=延后，负数=提前
    private func shiftLRCTimestamps(_ lrc: String, by seconds: Double) -> String {
        let normalized = lrc.replacingOccurrences(of: "\r\n", with: "\n")
                            .replacingOccurrences(of: "\r", with: "\n")
        let pattern = #"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return lrc }
        var out: [String] = []
        for line in normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let ns = line as NSString
            let matches = regex.matches(in: line, range: NSRange(location: 0, length: ns.length))
            if matches.isEmpty { out.append(line); continue }
            var rebuilt = ""
            var lastEnd = 0
            for m in matches {
                rebuilt += ns.substring(with: NSRange(location: lastEnd, length: m.range.location - lastEnd))
                let mm = Int(ns.substring(with: m.range(at: 1))) ?? 0
                let ss = Int(ns.substring(with: m.range(at: 2))) ?? 0
                var frac = 0.0
                if m.range(at: 3).location != NSNotFound {
                    let fs = ns.substring(with: m.range(at: 3))
                    // .5 / .54 / .542 都按毫秒/百分秒归一
                    let v = Double(fs) ?? 0
                    frac = v / pow(10, Double(fs.count))
                }
                var total = Double(mm * 60 + ss) + frac + seconds
                if total < 0 { total = 0 }
                let nMin = Int(total) / 60
                let nSec = total - Double(nMin * 60)
                rebuilt += String(format: "[%02d:%05.2f]", nMin, nSec)
                lastEnd = m.range.location + m.range.length
            }
            rebuilt += ns.substring(from: lastEnd)
            out.append(rebuilt)
        }
        return out.joined(separator: "\n")
    }

    /// 咪咕歌词（下载 lrcUrl 指向的 .lrc 文件）
    /// 咪咕专用 URLSession：
    /// ⚠️ 咪咕的 CDN 证书链在某些网络下握手失败（TLS error），
    ///    这里用一个放宽证书校验的 delegate（只用于音源 API，不涉及支付/账号）。
    private static let miguSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        return URLSession(configuration: cfg, delegate: ATSBypassDelegate.shared,
                          delegateQueue: nil)
    }()

    private func lyricMigu(urlStr: String) async -> Any? {
        var fixed = urlStr
        if fixed.hasPrefix("http://") { fixed = "https://" + fixed.dropFirst(7) }
        guard let u = URL(string: fixed) else { return ["lrc": "", "tlyric": ""] }
        var req = URLRequest(url: u)
        req.timeoutInterval = 15
        // ⚠️ 必须带 Referer，否则返回 0 字节（2026-10-22 实测）
        req.setValue("https://music.migu.cn/", forHTTPHeaderField: "Referer")
        req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
                     forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await Self.miguSession.data(for: req),
              let raw = String(data: data, encoding: .utf8), !raw.isEmpty else {
            // 退化：再试一次默认 session
            guard let (d2, _) = try? await URLSession.shared.data(for: req),
                  let r2 = String(data: d2, encoding: .utf8), !r2.isEmpty else {
                fputs("lyricMigu: 下载失败\n", stderr)
                return ["lrc": "", "tlyric": ""]
            }
            fputs("lyricMigu OK(退路): \(r2.count) 字符\n", stderr)
            return self.cleanMiguLRC(r2)
        }
        return self.cleanMiguLRC(raw)
    }

    /// 清洗咪咕歌词（CRLF + 去掉开头的歌曲信息行）
    private func cleanMiguLRC(_ raw: String) -> Any? {
        // CRLF → LF + 过滤开头的歌曲信息行（歌名/作词/作曲/编曲…）
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
                           .replacingOccurrences(of: "\r", with: "\n")
        let infoPrefixes = ["作词", "作曲", "编曲", "制作人", "合声", "和声", "吉他",
                            "贝斯", "鼓", "录音", "混音", "母带", "监制", "发行",
                            "出品", "OP", "SP", "Lyricist", "Composer"]
        var out: [String] = []
        var skipping = true
        for line in normalized.split(separator: "\n").map(String.init) {
            let trim = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trim.isEmpty { continue }
            if skipping, let r = trim.range(of: "]") {
                let body = String(trim[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                if body.isEmpty { continue }
                let isTitle = body.contains(" - ")
                let isInfo = infoPrefixes.contains { body.hasPrefix($0) }
                if isTitle || isInfo { continue }
                skipping = false
            }
            out.append(trim)
        }
        let final = out.isEmpty ? normalized : out.joined(separator: "\n")
        fputs("lyricMigu OK: \(raw.count) → \(final.count) 字符 (\(out.count) 行)\n", stderr)
        return ["lrc": final, "tlyric": ""]
    }

    /// 酷狗歌词（先搜索 candidate，再下载）
    private func lyricKugou(name: String, singer: String, duration: Int) async -> Any? {
        guard !name.isEmpty else { return ["lrc": "", "tlyric": ""] }
        let kwWithSinger = "\(name) \(singer)".trimmingCharacters(in: .whitespaces)

        // ⚠️ 酷狗歌词搜索关键词（2026-10-21）：加歌手名会 0 结果，
        //    所以依次尝试「歌名 歌手」→「歌名」，命中即用。
        var chosen: (id: String, key: String)? = nil
        for tryKw in [kwWithSinger, name] where !tryKw.isEmpty {
            guard var c = URLComponents(string: "https://lyrics.kugou.com/search") else { continue }
            c.queryItems = [
                .init(name: "ver", value: "1"), .init(name: "man", value: "yes"),
                .init(name: "client", value: "pc"), .init(name: "keyword", value: tryKw),
                .init(name: "duration", value: String(duration * 1000)),
            ]
            var r = URLRequest(url: c.url!)
            r.timeoutInterval = 15
            r.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
                       forHTTPHeaderField: "User-Agent")
            r.setValue("https://www.kugou.com/", forHTTPHeaderField: "Referer")
            guard let (d, _) = try? await URLSession.shared.data(for: r),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let cs = o["candidates"] as? [[String: Any]],
                  let first = cs.first,
                  let cid = (first["id"] as? String) ?? (first["id"] as? Int).map(String.init),
                  let key = first["accesskey"] as? String else { continue }
            chosen = (cid, key)
            fputs("lyricKugou: 关键词「\(tryKw)」命中 id=\(cid)\n", stderr)
            break
        }
        guard let picked = chosen else {
            fputs("lyricKugou: 所有关键词都没候选\n", stderr)
            return ["lrc": "", "tlyric": ""]
        }

        // 下载歌词
        guard var c2 = URLComponents(string: "https://lyrics.kugou.com/download") else {
            return ["lrc": "", "tlyric": ""]
        }
        c2.queryItems = [
            .init(name: "ver", value: "1"), .init(name: "client", value: "pc"),
            .init(name: "id", value: picked.id), .init(name: "accesskey", value: picked.key),
            .init(name: "fmt", value: "lrc"), .init(name: "charset", value: "utf8"),
        ]
        var req2 = URLRequest(url: c2.url!)
        req2.timeoutInterval = 15
        req2.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
                      forHTTPHeaderField: "User-Agent")
        req2.setValue("https://www.kugou.com/", forHTTPHeaderField: "Referer")
        guard let (d2, _) = try? await URLSession.shared.data(for: req2),
              let o2 = try? JSONSerialization.jsonObject(with: d2) as? [String: Any],
              let b64 = o2["content"] as? String,
              let raw = Data(base64Encoded: b64),
              let lrc = String(data: raw, encoding: .utf8), !lrc.isEmpty else {
            fputs("lyricKugou: 下载失败\n", stderr)
            return ["lrc": "", "tlyric": ""]
        }
        // ⚠️ 清洗酷狗歌词（2026-10-21）：
        //   1. 去掉 [id:] [ti:] [ar:] [al:] [by:] [offset:] 等元数据标签行
        //      ——不认识的标签会让解析器把整行当歌词文本，时间轴错乱
        //   2. 去掉开头的「歌手-歌名」信息行（如 [00:01.61]周杰伦-晴天）
        let metaTags = ["[id:", "[ti:", "[ar:", "[al:", "[by:", "[offset:",
                        "[length:", "[re:", "[ve:", "[kana:"]
        var cleaned: [String] = []
        var skippingInfo = true
        // ⚠️ 酷狗歌词是 CRLF（\r\n）换行（2026-10-21 实测 hex: ...5d 0d 0a 5b...），
        //    按 \n 分割后每行末尾残留 \r，导致 hasPrefix/[..] 匹配全部失败。
        //    先统一换行符再分割。
        let normalized = lrc.replacingOccurrences(of: "\r\n", with: "\n")
                            .replacingOccurrences(of: "\r", with: "\n")
        for line in normalized.split(separator: "\n").map(String.init) {
            let trim = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trim.isEmpty { continue }
            if metaTags.contains(where: { trim.hasPrefix($0) }) { continue }
            // 提取时间戳后的正文
            if skippingInfo, let r = trim.range(of: "]") {
                let body = String(trim[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                if body.isEmpty { continue }
                // 「歌手-歌名」形式的信息行：包含 "-" 且和歌名相关
                let isInfoLine = body.contains("-") && (body.contains(name) || body.contains(singer))
                let isCredit = ["词", "曲", "编曲", "作词", "作曲", "制作", "混音", "母带"]
                    .contains { body.hasPrefix($0) }
                if isInfoLine || isCredit { continue }
                skippingInfo = false
            }
            cleaned.append(trim)
        }
        var final = cleaned.isEmpty ? lrc : cleaned.joined(separator: "\n")
        // ⚠️ 酷狗歌词整体提前 3 秒（2026-10-22 用户实测「快了 3 秒」）：
        //    酷狗的音源常比其他平台版本靠前（前奏被裁剪），
        //    歌词时间轴按完整版算就显得晚，听起来是「歌词快了」。
        final = shiftLRCTimestamps(final, by: -3.0)
        fputs("lyricKugou 清洗: 原文 \(lrc.count) 字符 → \(final.count) 字符, \(cleaned.count) 行 (name=\(name) singer=\(singer))，已提前 3 秒\n", stderr)
        if cleaned.isEmpty, let f = lrc.split(separator: "\n").prefix(3).first {
            fputs("  ★首行hex: \(String(f).prefix(30).unicodeScalars.map{ String(format:"%02x", $0.value) }.joined(separator:" "))\n", stderr)
        }
        return ["lrc": final, "tlyric": ""]
    }


    private func lyricNetease(id: String) async -> Any? {
        guard let u = URL(string:
            "https://music.163.com/api/song/lyric?id=\(id)&lv=1&kv=1&tv=-1") else {
            return ["lrc": "", "tlyric": ""]
        }
        var req = URLRequest(url: u)
        req.setValue("https://music.163.com/", forHTTPHeaderField: "Referer")
        req.timeoutInterval = 15
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["lrc": "", "tlyric": ""]
        }
        var lrc = (obj["lrc"] as? [String: Any])?["lyric"] as? String ?? ""
        let tl = (obj["tlyric"] as? [String: Any])?["lyric"] as? String ?? ""
        // ⚠️ 过滤开头信息行（2026-10-21）：
        //    网易云格式是「作词 : xxx」「作曲 : xxx」（半角冒号+空格），
        //    占了 0~30 秒时间轴，导致歌词看起来提前。
        let infoPrefixes = ["作词", "作曲", "编曲", "制作人", "合声", "和声", "吉他",
                            "贝斯", "鼓", "录音", "混音", "母带", "监制", "发行",
                            "出品", "Lyricist", "Composer", "Arranger", "Producer"]
        let raw = lrc.split(separator: "\n").map(String.init)
        var filtered: [String] = []
        var skipping = true
        for line in raw {
            if skipping {
                if let r = line.range(of: "]") {
                    let body = String(line[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                    if body.isEmpty { continue }
                    let isInfo = infoPrefixes.contains { body.hasPrefix($0) }
                    if isInfo { continue }
                    skipping = false
                }
            }
            filtered.append(line)
        }
        if !filtered.isEmpty { lrc = filtered.joined(separator: "\n") }
        return ["lrc": lrc, "tlyric": tl]
    }

    // MARK: - 封面

    /// streamGetPic({songmid}) → {url}
    /// streamGetPic({provider, song}) → {url}
    ///
    /// ⚠️ 各平台用自己的封面接口（2026-10-21，不跨平台）
    func picture(args: [Any]) async -> Any? {
        let dict0 = args.first as? [String: Any] ?? [:]
        var dict = dict0
        if let inner = dict0["song"] as? [String: Any] {
            for (k, v) in inner { dict[k] = v }
        }
        // 1. 搜索结果里带封面直接用
        if let img = dict["img"] as? String, !img.isEmpty, img.hasPrefix("http") {
            return ["url": img]
        }
        let source = (dict0["provider"] as? String) ?? (dict["provider"] as? String)
            ?? (dict["source"] as? String) ?? ""
        // ⚠️ 取歌曲唯一 id（2026-10-21 修歌词丢失）：
        //    各平台字段不同——酷狗用 hash，酷我用 songmid(数字)，
        //    网易云用 songmid/id。之前只查 songmid+id，酷狗直接取到空串 → 歌词拿不到。
        var songid = Bridge.songIdentity(dict)
        if songid.isEmpty {
            if let n = dict["songmid"] as? Int { songid = String(n) }
            else if let n = dict["songmid"] as? NSNumber { songid = n.stringValue }
        }
        let albumId = (dict["albumId"] as? String) ?? ""

        // 2. 各平台封面接口
        var url = ""
        switch source {
        case "wy":
            url = await coverNetease(id: songid)
        case "kw":
            url = await coverKuwo(albumId: albumId, id: songid)
        case "kg":
            url = await coverKugou(albumId: albumId)
        case "mg":
            url = await coverMigu(id: songid)
        case "alac", "apple":
            url = ""   // Apple Music 的封面在搜索结果里
        default:
            break
        }
        return ["url": url]
    }

    /// streamCoverProxy(httpUrl) → {url: dataURL}
    ///
    /// ⚠️ 他们的 UI 只对 https 封面直接设 img.src（2026-10-21）：
    ///    http:// 的封面要走这个代理，否则 ATS 拦掉显示不出来。
    ///    我们把图片下载下来转成 data: URL 返回。
    func coverProxy(args: [Any]) async -> Any? {
        var urlStr = ""
        if let s = args.first as? String { urlStr = s }
        else if let d = args.first as? [String: Any] {
            urlStr = (d["url"] as? String) ?? (d["src"] as? String) ?? ""
        }
        // ⚠️ HTTP → HTTPS（2026-10-21）：ATS 会拦 http://
        if urlStr.hasPrefix("http://") {
            urlStr = "https://" + urlStr.dropFirst(7)
        }
        guard !urlStr.isEmpty, let u = URL(string: urlStr) else {
            fputs("coverProxy URL 无效: \(urlStr)\n", stderr)
            return ["url": ""]
        }
        var req = URLRequest(url: u)
        req.timeoutInterval = 15
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              !data.isEmpty else {
            fputs("coverProxy 失败: \(urlStr)\n", stderr)
            return ["url": ""]
        }
        // 判断 MIME
        var mime = "image/jpeg"
        if let ct = http.value(forHTTPHeaderField: "Content-Type"), !ct.isEmpty {
            mime = ct
        } else if urlStr.hasSuffix(".png") { mime = "image/png" }
        else if urlStr.hasSuffix(".webp") { mime = "image/webp" }
        else if urlStr.hasSuffix(".gif") { mime = "image/gif" }
        let dataURL = "data:\(mime);base64,\(data.base64EncodedString())"
        return ["url": dataURL]
    }

    /// 统一取封面 URL（给搜索结果补封面用）
    ///
    /// 策略（2026-10-21 换方案）：
    ///   1. 先试各平台自己的封面接口
    ///   2. 拿不到 → 用 iTunes 公开 API 按「歌名+歌手」查专辑封面
    ///      （iTunes API 不限流、不需要 token，只是查专辑图，不涉及音源解析）
    func fetchCoverURL(provider: String, id: String, albumId: String,
                       name: String = "", singer: String = "") async -> String {
        // ⚠️ 优先 iTunes（2026-10-21 修卡顿）：
        //    各平台自己的封面接口经常限流/超时（酷我最慢，单次要 1-2 秒），
        //    iTunes 公开 API 快且不限流，所以优先用它；
        //    拿不到再试平台自己的接口。
        if !name.isEmpty {
            let it = await coverITunes(name: name, singer: singer)
            if !it.isEmpty { return it }
        }
        var url = ""
        switch provider {
        case "wy": url = await coverNetease(id: id)
        case "kw": url = await coverKuwo(albumId: albumId, id: id)
        case "kg": url = await coverKugou(albumId: albumId)
        case "mg": url = await coverMigu(id: id)
        default: break
        }
        return url
    }

    /// iTunes 公开 API 查封面（不限流，不需要 token）
    ///
    /// ⚠️ 店铺（2026-10-21）：iTunes 的 cn 店铺搜不到中文歌（0 条），
    ///    hk/tw/us/jp 都能搜到，所以按这个顺序试。
    private func coverITunes(name: String, singer: String) async -> String {
        let term = singer.isEmpty ? name : "\(name) \(singer)"
        for country in ["hk", "us"] {
            guard var c = URLComponents(string: "https://itunes.apple.com/search") else { continue }
            c.queryItems = [
                .init(name: "term", value: term),
                .init(name: "entity", value: "song"),
                .init(name: "limit", value: "1"),
                .init(name: "country", value: country),
            ]
            var req = URLRequest(url: c.url!)
            req.timeoutInterval = 10
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let results = obj["results"] as? [[String: Any]],
               let first = results.first,
               let art = first["artworkUrl100"] as? String, !art.isEmpty {
                fputs("coverITunes 命中(\(country)): \(name)\n", stderr)
                return art.replacingOccurrences(of: "100x100bb", with: "600x600bb")
            }
        }
        fputs("coverITunes 未命中: \(term)\n", stderr)
        return ""
    }

    /// 统一取封面 URL（旧签名，保留兼容）
    func fetchCoverURL(provider: String, id: String, albumId: String) async -> String {
        return await fetchCoverURL(provider: provider, id: id, albumId: albumId,
                                   name: "", singer: "")
    }

    /// 网易云封面
    private func coverNetease(id: String) async -> String {
        guard !id.isEmpty, let u = URL(string:
            "https://music.163.com/api/song/detail/?id=\(id)&ids=[\(id)]") else { return "" }
        var req = URLRequest(url: u)
        req.setValue("https://music.163.com/", forHTTPHeaderField: "Referer")
        req.timeoutInterval = 12
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let songs = obj["songs"] as? [[String: Any]],
              let first = songs.first,
              let album = first["album"] as? [String: Any],
              let pic = album["picUrl"] as? String else {
            fputs("coverNetease 失败 id=\(id)\n", stderr)
            return ""
        }
        return pic
    }

    /// 酷我封面：albumId → 图片 URL
    private func coverKuwo(albumId: String, id: String) async -> String {
        guard !albumId.isEmpty else { return "" }
        // 酷我图片规律：https://img1.kuwo.cn/star/albumcover/500/<倒序albumId>.jpg
        // 例如 albumId=1293 → 0.jpg；用官方接口更稳
        guard let u = URL(string:
            "https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=\(id)&httpsStatus=1") else { return "" }
        var req = URLRequest(url: u)
        req.setValue("https://m.kuwo.cn/", forHTTPHeaderField: "Referer")
        req.timeoutInterval = 12
        if let (data, _) = try? await URLSession.shared.data(for: req),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let d = obj["data"] as? [String: Any],
           let info = d["songinfo"] as? [String: Any],
           let pic = info["pic"] as? String, !pic.isEmpty {
            return pic
        }
        return ""
    }

    /// 酷狗封面
    private func coverKugou(albumId: String) async -> String {
        guard !albumId.isEmpty else { return "" }
        // 酷狗专辑封面：https://imge.kugou.com/stdmusic/240/<albumid>.jpg
        return "https://imge.kugou.com/stdmusic/240/\(albumId).jpg"
    }

    /// 咪咕封面
    private func coverMigu(id: String) async -> String {
        guard !id.isEmpty else { return "" }
        guard let u = URL(string:
            "https://music.migu.cn/v3/api/music/audioPlayer/getSongInfo?copyrightId=\(id)") else { return "" }
        var req = URLRequest(url: u)
        req.timeoutInterval = 12
        if let (data, _) = try? await URLSession.shared.data(for: req),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let d = obj["data"] as? [String: Any],
           let pic = (d["albumPic"] as? String) ?? (d["pic"] as? String) {
            return pic
        }
        return ""
    }
}

// MARK: - 搜索核心（从 bot 移植）

enum SearchCore {
    private static var tokenCache: (token: String, ts: Date)?

    /// 用户自己填的 token（存 UserDefaults）
    /// 用户 2026-10-21：「让他们自己找 token 或者用自己带订阅的账号」
    static var userToken: String {
        get { UserDefaults.standard.string(forKey: "am.developerToken") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "am.developerToken") }
    }

    static func developerToken(force: Bool = false) async throws -> String {
        // 1) 用户自己填的优先（永久生效，直到用户改）
        let mine = userToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if !mine.isEmpty && !force { return mine }

        // 2) 自动抓（6 小时缓存）
        if !force, let c = tokenCache, Date().timeIntervalSince(c.ts) < 6 * 3600 {
            return c.token
        }
        let (homeData, _) = try await URLSession.shared.data(
            from: URL(string: "https://music.apple.com/")!)
        guard let html = String(data: homeData, encoding: .utf8),
              let range = html.range(of: #"/assets/index~[0-9a-f]+\.js"#,
                                      options: .regularExpression) else {
            throw SearchError.noBundle
        }
        let jsURL = URL(string: "https://music.apple.com" + html[range])!
        let (jsData, _) = try await URLSession.shared.data(from: jsURL)
        guard let js = String(data: jsData, encoding: .utf8) else {
            throw SearchError.noBundle
        }
        let pat = #"eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}"#
        guard let m = js.range(of: pat, options: .regularExpression) else {
            throw SearchError.noToken
        }
        let tok = String(js[m])
        tokenCache = (tok, Date())
        return tok
    }

    struct Item {
        let id: String, title: String, artist: String, album: String
        let artworkURL: URL?
        let durationMs: Int?
    }

    static func search(_ kw: String, token: String) async throws -> [Item] {
        var comps = URLComponents(string:
            "https://amp-api.music.apple.com/v1/catalog/cn/search")!
        comps.queryItems = [
            .init(name: "term", value: kw),
            .init(name: "types", value: "songs"),
            .init(name: "limit", value: "30"),
            .init(name: "l", value: "zh-Hans-CN"),
        ]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("https://music.apple.com", forHTTPHeaderField: "Origin")
        req.setValue(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
            "(KHTML, like Gecko) Version/18.0 Safari/605.1.15",
            forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 20

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw SearchError.http((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let r = obj["results"] as? [String: Any],
              let s = r["songs"] as? [String: Any],
              let items = s["data"] as? [[String: Any]] else {
            throw SearchError.parse
        }
        return items.compactMap { d in
            guard let id = d["id"] as? String else { return nil }
            let a = d["attributes"] as? [String: Any] ?? [:]
            var art: URL? = nil
            if let arts = a["artwork"] as? [String: Any],
               var u = arts["url"] as? String {
                u = u.replacingOccurrences(of: "{w}", with: "300")
                     .replacingOccurrences(of: "{h}", with: "300")
                art = URL(string: u)
            }
            return Item(id: id,
                        title: a["name"] as? String ?? "未知",
                        artist: a["artistName"] as? String ?? "",
                        album: a["albumName"] as? String ?? "",
                        artworkURL: art,
                        durationMs: a["durationInMillis"] as? Int)
        }
    }
}
