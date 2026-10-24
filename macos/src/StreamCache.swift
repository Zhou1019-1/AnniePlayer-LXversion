// 流媒体播放缓存 —— 边播边存 + LRU 淘汰
//
// UI 调用链（player.js:1328）：
//   播放前 → streamCacheLookup({provider, songId, quality, title, artist})
//           命中 → 用本地文件路径播放（免去重新请求）
//   未命中 → streamCacheFill({...同上, url, headers})  → 后台下载存起来
//
// 其他接口（设置页用）：
//   streamCacheStats      缓存统计（大小/数量/目录）
//   streamCacheClear      清空缓存
//   streamCacheSetCfg     设置缓存目录/上限
//   streamCachePickDir    选择缓存目录
//   streamCacheGroups     按平台/歌手分组

import Foundation

final class StreamCache {
    static let shared = StreamCache()

    /// ⚠️ 2026-10-22：不再固定用 "m4a" 后缀（这是播放失败的直接原因）。
    ///    之前不管实际是 FLAC/MP3/ALAC 一律存成 .m4a，
    ///    AVPlayer 按扩展名解析 → FLAC 内容 + .m4a 后缀 → duration 恒为 0。
    ///    现在按 URL/quality 推断正确后缀。 */
    /// 正在下载的任务（避免重复下载同一首）
    private var downloading = Set<String>()
    private let lock = NSLock()

    private init() {
        try? FileManager.default.createDirectory(at: cfgDir, withIntermediateDirectories: true)
    }

    // MARK: - 配置

    private var cfgFile: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("AnnieMac")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("stream-cache.json")
    }

    private var cfgDir: URL {
        if let s = readCfg()["dir"] as? String, !s.isEmpty {
            return URL(fileURLWithPath: s)
        }
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AnnieMac/stream-cache")
    }

    /// 缓存上限（字节），默认 2GB
    private var maxBytes: Int64 {
        if let n = readCfg()["maxBytes"] as? Int64, n > 0 { return n }
        return 2 * 1024 * 1024 * 1024
    }

    private func readCfg() -> [String: Any] {
        guard let d = try? Data(contentsOf: cfgFile),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
            return [:]
        }
        return o
    }

    private func writeCfg(_ o: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: o) {
            try? d.write(to: cfgFile)
        }
    }

    // MARK: - 缓存键

    /// 由 provider + songId + quality 生成安全文件名
    private func cacheKey(_ d: [String: Any]) -> String {
        let provider = (d["provider"] as? String) ?? "unknown"
        let songId = (d["songId"] as? String) ?? ""
        let quality = (d["quality"] as? String) ?? ""
        let raw = "\(provider)_\(songId)_\(quality)"
        // 只保留安全字符
        let safe = raw.map { c -> Character in
            if c.isLetter || c.isNumber || c == "_" || c == "-" { return c }
            return "_"
        }
        var s = String(safe)
        if s.count > 120 { s = String(s.prefix(120)) }
        return s
    }

    private func fileURL(_ d: [String: Any]) -> URL {
        let name = cacheKey(d)
        let fmt = detectExt(d)
        return cfgDir.appendingPathComponent("\(name).\(fmt)")
    }

    /// 从 URL / quality / 已有文件推断真实扩展名
    private func detectExt(_ d: [String: Any]) -> String {
        let url = ((d["url"] as? String) ?? "").lowercased()
        let q = ((d["quality"] as? String) ?? "").lowercased()
        if url.contains(".flac") || q == "flac" || q == "lossless" || q == "hires" { return "flac" }
        if url.contains(".m4a") || url.contains(".mp4") || q == "alac" { return "m4a" }
        if url.contains(".ape") { return "ape" }
        if url.contains(".wav") { return "wav" }
        if url.contains(".ogg") { return "ogg" }
        if url.contains(".aac") { return "aac" }
        if url.contains(".mp3") { return "mp3" }
        // 兜底：看队列里已有同名文件
        let base = cacheKey(d)
        for cand in ["flac", "m4a", "mp3", "ape", "wav", "ogg", "aac"] {
            let f = cfgDir.appendingPathComponent("\(base).\(cand)")
            if FileManager.default.fileExists(atPath: f.path) { return cand }
        }
        return "mp3"
    }

    // MARK: - 查缓存

    /// streamCacheLookup → {path} 或 null
    func lookup(args: [Any]) -> Any? {
        let d = args.first as? [String: Any] ?? [:]
        var f = fileURL(d)
        // 兼容旧缓存（一律 .m4a 后缀）：如果推断的路径不存在，
        // 再按其它常见后缀找一遍，找到就把内容是真 FLAC 的改正名。
        if !FileManager.default.fileExists(atPath: f.path) {
            let base = cacheKey(d)
            for cand in ["m4a", "mp3", "flac", "ape", "wav"] {
                let candURL = cfgDir.appendingPathComponent("\(base).\(cand)")
                if FileManager.default.fileExists(atPath: candURL.path) {
                    f = candURL
                    break
                }
            }
        }
        guard FileManager.default.fileExists(atPath: f.path),
              let attrs = try? FileManager.default.attributesOfItem(atPath: f.path),
              let size = attrs[.size] as? Int64, size > 10_000 else {
            return NSNull()
        }
        // 更新访问时间（LRU）
        try? FileManager.default.setAttributes([.modificationDate: Date()],
                                               ofItemAtPath: f.path)
        return ["path": f.path, "size": size]
    }

    // MARK: - 填缓存（后台下载）

    /// streamCacheFill({provider, songId, quality, url, headers}) → {ok}
    func fill(args: [Any]) -> Any? {
        let d = args.first as? [String: Any] ?? [:]
        guard let urlStr = d["url"] as? String, !urlStr.isEmpty else {
            return ["ok": false, "error": "缺少 url"]
        }
        let key = cacheKey(d)
        lock.lock()
        if downloading.contains(key) {
            lock.unlock()
            return ["ok": false, "reason": "已在下载"]
        }
        downloading.insert(key)
        lock.unlock()

        let dest = fileURL(d)
        let headers = (d["headers"] as? [String: String]) ?? [:]
        // 本地 http 文件（AM 的 m4a 已经在 cacheDir 里了）——直接跳过
        if urlStr.hasPrefix("/") || urlStr.hasPrefix("file://") {
            lock.lock(); downloading.remove(key); lock.unlock()
            return ["ok": false, "reason": "本地文件"]
        }

        Task.detached { [weak self] in
            guard let self else { return }
            defer {
                self.lock.lock(); self.downloading.remove(key); self.lock.unlock()
            }
            do {
                var fixed = urlStr
                // ATS：http → https
                if fixed.hasPrefix("http://") {
                    fixed = "https://" + fixed.dropFirst(7)
                }
                guard let u = URL(string: fixed) else { return }
                var req = URLRequest(url: u)
                req.timeoutInterval = 60
                for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
                if req.value(forHTTPHeaderField: "User-Agent") == nil {
                    req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
                                 forHTTPHeaderField: "User-Agent")
                }
                let (tmp, resp) = try await URLSession.shared.download(for: req)
                guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return }
                let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? Int64) ?? 0
                guard size > 10_000 else { return }
                try? FileManager.default.createDirectory(at: self.cfgDir,
                                                         withIntermediateDirectories: true)
                if FileManager.default.fileExists(atPath: dest.path) {
                    try? FileManager.default.removeItem(at: dest)
                }
                try FileManager.default.moveItem(at: tmp, to: dest)
                fputs("StreamCache 已缓存: \(dest.lastPathComponent) (\(size / 1024)KB)\n", stderr)
                self.evictIfNeeded()
            } catch {
                fputs("StreamCache 下载失败: \(error.localizedDescription)\n", stderr)
            }
        }
        return ["ok": true]
    }

    // MARK: - LRU 淘汰

    private func evictIfNeeded() {
        let dir = cfgDir
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]) else { return }
        var entries: [(URL, Date, Int64)] = []
        var total: Int64 = 0
        for f in files where ["flac","m4a","mp3","ape","wav","ogg","aac"].contains(f.pathExtension) {
            guard let attrs = try? f.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]),
                  let date = attrs.contentModificationDate,
                  let size = attrs.fileSize else { continue }
            entries.append((f, date, Int64(size)))
            total += Int64(size)
        }
        guard total > maxBytes else { return }
        // 按访问时间升序删
        entries.sort { $0.1 < $1.1 }
        for (f, _, size) in entries {
            if total <= maxBytes { break }
            try? FileManager.default.removeItem(at: f)
            total -= size
        }
        fputs("StreamCache LRU 淘汰后: \(total / 1024 / 1024)MB\n", stderr)
    }

    // MARK: - 统计 / 清理 / 配置

    /// streamCacheStats → {dir, count, bytes, maxBytes}
    func stats() -> Any {
        let dir = cfgDir
        var count = 0
        var bytes: Int64 = 0
        if let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]) {
            for f in files where ["flac","m4a","mp3","ape","wav","ogg","aac"].contains(f.pathExtension) {
                count += 1
                if let s = try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                    bytes += Int64(s)
                }
            }
        }
        return ["dir": dir.path, "count": count, "bytes": bytes, "maxBytes": maxBytes]
    }

    /// streamCacheClear → {ok, removed}
    func clear() -> Any {
        let dir = cfgDir
        var removed = 0
        if let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
            for f in files where ["flac","m4a","mp3","ape","wav","ogg","aac"].contains(f.pathExtension) {
                if (try? FileManager.default.removeItem(at: f)) != nil { removed += 1 }
            }
        }
        return ["ok": true, "removed": removed]
    }

    /// streamCacheSetCfg({dir?, maxBytes?})
    func setCfg(args: [Any]) -> Any {
        let d = args.first as? [String: Any] ?? [:]
        var o = readCfg()
        if let dir = d["dir"] as? String, !dir.isEmpty { o["dir"] = dir }
        if let mb = d["maxMB"] as? Int { o["maxBytes"] = Int64(mb) * 1024 * 1024 }
        else if let b = d["maxBytes"] as? Int64 { o["maxBytes"] = b }
        writeCfg(o)
        return ["ok": true]
    }

    /// streamCacheGroups → 按平台分组
    func groups() -> Any {
        let dir = cfgDir
        var map: [String: [String: Any]] = [:]
        if let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]) {
            for f in files where ["flac","m4a","mp3","ape","wav","ogg","aac"].contains(f.pathExtension) {
                let name = f.deletingPathExtension().lastPathComponent
                let provider = name.split(separator: "_").first.map(String.init) ?? "other"
                let size = (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                var g = map[provider] ?? ["provider": provider, "count": 0, "bytes": 0]
                g["count"] = ((g["count"] as? Int) ?? 0) + 1
                g["bytes"] = ((g["bytes"] as? Int) ?? 0) + size
                map[provider] = g
            }
        }
        return Array(map.values)
    }
}
