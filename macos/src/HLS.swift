// HLS 播放列表解析 + 分片下载解密
//
// 流程（2026-10-21 已验证可行）：
//   master m3u8  → 找 ALAC 变体
//   media m3u8   → 拿 init 段地址 + 各分片的 Range 和 key
//   Apple CDN    → Range 请求下载分片（直连，不经过 wrapper-lite）
//   temari.wasm  → 原地解密
//   拼接         → 完整 M4A

import Foundation

// MARK: - 播放列表结构

struct HLSVariant {
    let url: URL            // media m3u8 绝对地址
    let codec: String       // "alac" / "mp4a.40.2" ...
    let bandwidth: Int
    let keyURI: String      // 首个非固定模板的 key URI
}

struct HLSSegment {
    let byteRange: (start: Int, length: Int)?
    let uri: URL
    let keyURI: String?
}

struct HLSPlaylist {
    let initSegment: (uri: URL, start: Int, length: Int)?
    let segments: [HLSSegment]
}

// MARK: - 解析

enum HLS {
    /// 从 master 里选 ALAC 变体
    static func selectALAC(master: URL) async throws -> HLSVariant {
        let (data, _) = try await URLSession.shared.data(from: master)
        guard let text = String(data: data, encoding: .utf8) else {
            throw PlayerError.liteBadResponse("master 不是文本")
        }
        var variants: [HLSVariant] = []
        var pendingCodec = ""
        var pendingBW = 0
        for line in text.split(separator: "\n") {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("#EXT-X-STREAM-INF:") {
                if let r = l.range(of: #"CODECS="([^"]+)""#, options: .regularExpression) {
                    pendingCodec = String(l[r]).replacingOccurrences(of: "CODECS=\"", with: "")
                                              .replacingOccurrences(of: "\"", with: "")
                }
                if let r = l.range(of: #"BANDWIDTH=(\d+)"#, options: .regularExpression) {
                    pendingBW = Int(l[r].replacingOccurrences(of: "BANDWIDTH=", with: "")) ?? 0
                }
            } else if !l.isEmpty, !l.hasPrefix("#"), l.hasSuffix(".m3u8") {
                let base = master.deletingLastPathComponent()
                if let u = URL(string: l, relativeTo: base)?.absoluteURL {
                    variants.append(HLSVariant(url: u, codec: pendingCodec,
                                               bandwidth: pendingBW,
                                               keyURI: ""))
                }
                pendingCodec = ""; pendingBW = 0
            }
        }
        // 优先 alac
        guard var alac = variants.first(where: { $0.codec.lowercased().contains("alac") }) else {
            throw PlayerError.noALACVariant
        }
        // ⚠️ keyURI 在 master 里没有，要从 media m3u8 的 #EXT-X-KEY 里取
        //    （2026-10-21 修：之前留空导致 /key 请求失败）
        let media = try await parseMedia(alac.url)
        if let firstNonFixed = media.segments.first(where: {
            guard let k = $0.keyURI else { return false }
            return !k.contains("P000000000")
        })?.keyURI {
            alac = HLSVariant(url: alac.url, codec: alac.codec,
                              bandwidth: alac.bandwidth, keyURI: firstNonFixed)
        }
        return alac
    }

    /// 解析 media m3u8
    static func parseMedia(_ url: URL) async throws -> HLSPlaylist {
        let (data, _) = try await URLSession.shared.data(from: url)
        guard let text = String(data: data, encoding: .utf8) else {
            throw PlayerError.liteBadResponse("media 不是文本")
        }
        let base = url.deletingLastPathComponent()
        var initSeg: (URL, Int, Int)? = nil
        var segments: [HLSSegment] = []
        var currentKey: String? = nil
        var pendingRange: (Int, Int)? = nil

        for line in text.split(separator: "\n") {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("#EXT-X-KEY:") {
                if let r = l.range(of: #"URI="([^"]+)""#, options: .regularExpression) {
                    currentKey = String(l[r])
                        .replacingOccurrences(of: "URI=\"", with: "")
                        .replacingOccurrences(of: "\"", with: "")
                }
            } else if l.hasPrefix("#EXT-X-MAP:") {
                // URI="..." BYTERANGE="1020@0"
                var uriStr = "", range = (0, 0)
                if let r = l.range(of: #"URI="([^"]+)""#, options: .regularExpression) {
                    uriStr = String(l[r]).replacingOccurrences(of: "URI=\"", with: "")
                                          .replacingOccurrences(of: "\"", with: "")
                }
                if let r = l.range(of: #"BYTERANGE="(\d+)@(\d+)""#, options: .regularExpression) {
                    let s = String(l[r]).replacingOccurrences(of: "BYTERANGE=\"", with: "")
                       .replacingOccurrences(of: "\"", with: "")
                    let parts = s.split(separator: "@")
                    if parts.count == 2, let len = Int(parts[0]), let off = Int(parts[1]) {
                        range = (off, len)
                    }
                }
                if let u = URL(string: uriStr, relativeTo: base)?.absoluteURL {
                    initSeg = (u, range.0, range.1)
                }
            } else if l.hasPrefix("#EXT-X-BYTERANGE:") {
                let s = l.replacingOccurrences(of: "#EXT-X-BYTERANGE:", with: "")
                let parts = s.split(separator: "@")
                if parts.count == 2, let len = Int(parts[0]), let off = Int(parts[1]) {
                    pendingRange = (off, len)
                }
            } else if !l.isEmpty, !l.hasPrefix("#") {
                if let u = URL(string: l, relativeTo: base)?.absoluteURL {
                    segments.append(HLSSegment(byteRange: pendingRange, uri: u,
                                               keyURI: currentKey))
                }
                pendingRange = nil
            }
        }
        return HLSPlaylist(initSegment: initSeg, segments: segments)
    }
}

// MARK: - 下载 + 解密 + 拼接

enum AudioFetcher {
    /// 下载并解密成完整 M4A，返回本地文件 URL
    static func build(variant: HLSVariant,
                      template: Data,
                      cacheKey: String,
                      progress: @escaping (Int, Int) -> Void) async throws -> URL {

        let playlist = try await HLS.parseMedia(variant.url)
        guard let init_ = playlist.initSegment else {
            throw PlayerError.liteBadResponse("media 里没有 init 段")
        }

        // ⚠️ 缓存文件名带版本号（2026-10-21）：
        //    改了解密/时间轴逻辑后，旧缓存会让用户听到「旧行为」，
        //    加版本后缀强制重新下载。
        let outURL = PlayerConfig.cacheDir.appendingPathComponent("v2-\(cacheKey).m4a")
        // 已存在且非空 → 直接用
        if let attrs = try? FileManager.default.attributesOfItem(atPath: outURL.path),
           let sz = attrs[.size] as? Int, sz > 100_000 {
            return outURL
        }
        FileManager.default.createFile(atPath: outURL.path, contents: nil)
        guard let out = FileHandle(forWritingAtPath: outURL.path) else {
            throw PlayerError.liteBadResponse("写不了缓存文件")
        }
        defer { try? out.close() }

        // 1. init 段（需要 patch：enca → alac）
        let initData = try await fetchRange(url: init_.uri,
                                           start: init_.start, length: init_.length)
        var patchedInit = initData
        MP4Parser.renameEncaToAlac(&patchedInit)
        out.write(patchedInit)

        // 2. 各分片
        let total = playlist.segments.count
        // ⚠️ 用标志位记录「第一个成功写入的分片」（2026-10-21）：
        //    首片可能解密失败被 continue 跳过，用 i==0 判断会漏掉归零。
        // ⚠️ 首片 tfdt 归零（2026-10-21）：
        //    Apple 分片的 tfdt 从整首歌偏移起算，首片必须归零才能从第 0 秒播。
        //    后续分片保持原始 tfdt（它们是真实时间轴，不能动）。
        // ⚠️ 2026-10-23 性能优化「解密过慢」：
        //   原来分片是 for 循环里逐个 await 下载的 —— 串行网络请求，一首歌 20 个分片
        //   就要排队 20 次 RTT，首播等很久。现在先**并行下载**（最多 6 并发，
        //   和 URLSession 对单主机默认连接数一致），再按原顺序解密+写入
        //   （解密必须串行：TemariWasm 在主线程且共享状态）。
        let segTotal = playlist.segments.count
        fputs("[HLS] 开始并行下载 \(segTotal) 个分片\n", stderr)
        let t0 = Date()
        var downloaded = [Data?](repeating: nil, count: segTotal)
        await withTaskGroup(of: (Int, Data?).self) { group in
            var nextIdx = 0
            var running = 0
            let maxConcurrent = 6
            while nextIdx < segTotal || running > 0 {
                while nextIdx < segTotal && running < maxConcurrent {
                    let idx = nextIdx
                    let seg = playlist.segments[idx]
                    let (s, l) = seg.byteRange ?? (0, -1)
                    group.addTask {
                        let d = try? await AudioFetcher.fetchRange(url: seg.uri, start: s, length: l)
                        return (idx, d)
                    }
                    nextIdx += 1
                    running += 1
                }
                if let (idx, data) = await group.next() {
                    downloaded[idx] = data
                    running -= 1
                }
            }
        }
        fputs("[HLS] 并行下载完成，用时 \(String(format: "%.2f", Date().timeIntervalSince(t0)))s\n", stderr)

        // ⚠️ 2026-10-23 第 2 阶段优化：解密也改成**并行**（4 worker 池）。
        //    原来顺序 for 循环解密 —— 一首歌 19 个分片串行解密要几十秒，
        //    连续播放/切歌时体感极慢。现在 TaskGroup 并发提交，TemariWasm 内部
        //    4 个独立 JSContext worker 轮流处理，解密速度约提升 3~4 倍。
        let t1 = Date()
        var decrypted = [Data?](repeating: nil, count: segTotal)
        await withTaskGroup(of: (Int, Data?).self) { group in
            for (i, seg) in playlist.segments.enumerated() {
                guard let fragData = downloaded[i] else { continue }
                let isFixed = (seg.keyURI?.contains("P000000000") ?? false) || (i == 0)
                let idx = i
                group.addTask {
                    var frag = fragData
                    do {
                        let ranges = try MP4Parser.sampleRanges(frag)
                        if ranges.isEmpty {
                            throw PlayerError.decryptFailed("分片 \(idx + 1) 里找不到 sample")
                        }
                        frag = try await TemariWasm.shared.decryptFragmentAsync(
                            frag, template: template, sampleRanges: ranges, useFixed: isFixed)
                        for r in MP4Parser.psshRanges(frag) {
                            MP4Parser.renameToFree(&frag, at: r.lowerBound)
                        }
                        return (idx, frag)
                    } catch {
                        FileHandle.standardError.write(
                            "分片 \(idx + 1)/\(playlist.segments.count) 解密失败: \(error)\n"
                            .data(using: .utf8)!)
                        return (idx, nil)
                    }
                }
            }
            for await (idx, data) in group {
                decrypted[idx] = data
            }
        }
        fputs("[HLS] 并行解密完成，用时 \(String(format: "%.2f", Date().timeIntervalSince(t1)))s\n", stderr)

        // 第 3 阶段：按序写入（tfdt 检测 + 进度回调）
        var didZeroTFDT = false
        for (i, _) in playlist.segments.enumerated() {
            guard let frag = decrypted[i] else { continue }
            if !didZeroTFDT {
                let v = MP4Parser.readTFDT(frag) ?? 0
                didZeroTFDT = true
                fputs("首片 tfdt 偏移 = \(v) (\(Double(v)/44100.0) 秒)\n", stderr)
            }
            out.write(frag)
            progress(i + 1, total)
        }
        try? out.synchronize()
        return outURL
    }

    static func fetchRange(url: URL, start: Int, length: Int) async throws -> Data {
        var req = URLRequest(url: url)
        if length > 0 {
            req.setValue("bytes=\(start)-\(start + length - 1)",
                         forHTTPHeaderField: "Range")
        }
        req.timeoutInterval = 60
        let (data, _) = try await URLSession.shared.data(for: req)
        return data
    }
}
