// 音频元数据读取服务（资料库的标题/艺术家/专辑/封面）
//
// ⚠️ 为什么需要（2026-10-23）：
//   前端资料库（歌曲/专辑/文件夹视图）依赖 `window.mine.meta` / `metaBatch` /
//   `metaFullBatch` 三个接口来显示「标题 / 艺术家 / 专辑 / 封面 / 位深 / 采样率」，
//   但这三个方法只在 Bridge.allMethods 里注册了名字，dispatch 里**没有实现** →
//   落到 default 返回空值 → 资料库永远显示文件名、没有封面、没有歌手。
//
//   这里用 AVFoundation 读音频文件的元数据（Mac 原生，支持 m4a/flac/mp3/wav 等），
//   封面转成小尺寸 JPEG 的 data URI（WKWebView 里直接能当 <img src> 用，
//   不用再给本地 HTTP 服务器加封面路由）。
//
// 缓存策略：
//   · 主进程内存缓存（path + mtime 作为 key），避免重复读盘
//   · metaBatch 一次最多 200 个，分块处理

import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// 音频元数据读取
final class AudioMetaService {
    static let shared = AudioMetaService()

    /// 简单内存缓存：path → (mtime, meta)
    private var cache: [String: (mtime: TimeInterval, meta: [String: Any])] = [:]
    private let lock = NSLock()
    /// 封面缓存：path → data URI（避免重复压缩）
    private var coverCache: [String: String] = [:]

    private init() {}

    // MARK: - 公共接口

    /// 单个文件元数据（前端 `mine.meta(path)`）
    func meta(path: String) -> [String: Any] {
        guard !path.isEmpty else { return [:] }
        if let m = cachedMeta(path) { return m }
        let m = readMeta(path, deep: false)
        storeMeta(path, m)
        return m
    }

    /// 批量元数据（前端 `mine.metaBatch([path...])`）→ {path: meta}
    func metaBatch(_ paths: [String]) -> [String: [String: Any]] {
        var out: [String: [String: Any]] = [:]
        for p in paths.prefix(200) {
            let m = meta(path: p)
            if !m.isEmpty { out[p] = m }
        }
        return out
    }

    /// 深度元数据（前端 `mine.metaFullBatch([path...])`）：额外带位深/采样率/码率/声道
    func metaFullBatch(_ paths: [String]) -> [String: [String: Any]] {
        var out: [String: [String: Any]] = [:]
        for p in paths.prefix(50) {
            var m = meta(path: p)
            if m.isEmpty { continue }
            if m["_full"] == nil, let deep = readDeepAudioInfo(p) {
                m.merge(deep) { _, new in new }
                m["_full"] = 1
                storeMeta(p, m)
            }
            out[p] = m
        }
        return out
    }

    // MARK: - 缓存

    private func fileMtime(_ path: String) -> TimeInterval {
        (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate]
            .flatMap { ($0 as? Date)?.timeIntervalSince1970 } ?? 0
    }

    private func cachedMeta(_ path: String) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard let e = cache[path] else { return nil }
        return e.mtime == fileMtime(path) ? e.meta : nil
    }

    private func storeMeta(_ path: String, _ m: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        cache[path] = (fileMtime(path), m)
    }

    // MARK: - 读取

    private func readMeta(_ path: String, deep: Bool) -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { return ["fail": true] }
        let asset = AVURLAsset(url: url, options: [
            AVURLAssetPreferPreciseDurationAndTimingKey: false,
        ])

        var out: [String: Any] = [:]
        // 文件名兜底
        let baseName = (path as NSString).lastPathComponent
        let noExt = (baseName as NSString).deletingPathExtension
        out["file"] = baseName
        out["title"] = noExt
        out["name"] = baseName

        // 时长
        let dur = CMTimeGetSeconds(asset.duration)
        if dur.isFinite, dur > 0 {
            out["duration"] = dur
        }

        // 元数据：commonMetadata + iTunes metadata 一起扫，按 identifier 匹配
        // （commonKey* 只有 title/artist/album 等少数几个；albumArtist/track/disc
        //   在 iTunes metadata 里，得用 identifier 判断）
        // ⚠️ 2026-10-23 修复「MP3/FLAC 文件的标签读不到」：
        //   AVFoundation 对 MP3 的 metadata item，identifier.rawValue 是 **ID3 帧 ID**
        //   （id3/tit2、id3/tpe1、id3/talb…），不是 "title"/"artist"/"album" 这种词，
        //   之前用 `id.contains("title")` 的字符串匹配根本命中不了 → 所有 MP3 的
        //   标题/歌手/专辑全部读不到（资料库显示文件名 + 专辑空）。
        //   现在改成两路匹配：
        //     ① commonMetadata 的 commonKey（AVFoundation 已解析的通用字段）
        //     ② asset.metadata 的 ID3 帧 / iTunes 字段（albumArtist、track、disc 等）
        for item in asset.commonMetadata {
            guard let key = item.commonKey else { continue }
            switch key {
            case .commonKeyTitle:
                if let v = item.stringValue, !v.isEmpty { out["title"] = v }
            case .commonKeyArtist:
                if let v = item.stringValue, !v.isEmpty { out["artist"] = v }
            case .commonKeyAlbumName:
                if let v = item.stringValue, !v.isEmpty { out["album"] = v }
            case .commonKeyCreationDate:
                if let v = item.stringValue, !v.isEmpty { out["year"] = v }
            case .commonKeyType:
                if let v = item.stringValue, !v.isEmpty { out["genre"] = v }
            case .commonKeyArtwork:
                if let data = item.dataValue, let uri = Self.makeCoverDataURI(data) {
                    out["cover"] = uri
                }
            default:
                break
            }
        }
        // ② ID3 帧 / iTunes 专有字段（commonMetadata 里没有的）
        for item in asset.metadata {
            let id = (item.identifier?.rawValue ?? "").lowercased()
            // 常见 ID3v2 帧：tit2=标题 tpe1=艺术家 talb=专辑 tpe2=专辑艺术家
            //               tcon=流派 trck=音轨 tpos=碟号 tyer/tdrc=年份 apic=封面
            if id.contains("tit2") || id.contains("tabl") {
                if let v = item.stringValue, !v.isEmpty, out["title"] == nil { out["title"] = v }
            } else if id.contains("tpe1") || id.contains("tpe2") || id.contains("aartist") {
                if let v = item.stringValue, !v.isEmpty {
                    if out["artist"] == nil { out["artist"] = v }
                    if id.contains("tpe2") { out["albumArtist"] = v }
                }
            } else if id.contains("talb") || (id.contains("album") && !id.contains("artist")) {
                if let v = item.stringValue, !v.isEmpty, out["album"] == nil { out["album"] = v }
            } else if id.contains("tcon") || id.contains("genre") {
                if let v = item.stringValue, !v.isEmpty, out["genre"] == nil { out["genre"] = v }
            } else if id.contains("trck") || (id.contains("track") && id.contains("number")) {
                if let n = item.numberValue?.intValue { out["track"] = n }
            } else if id.contains("tpos") || (id.contains("disc") && id.contains("number")) {
                if let n = item.numberValue?.intValue { out["disc"] = n }
            } else if id.contains("tyer") || id.contains("tdrc") || id.contains("creationdate") {
                if let v = item.stringValue, !v.isEmpty, out["year"] == nil { out["year"] = v }
            } else if id.contains("apic") || id.contains("artwork") || id.contains("cover") {
                if out["cover"] == nil, let data = item.dataValue,
                   let uri = Self.makeCoverDataURI(data) {
                    out["cover"] = uri
                }
            }
        }
        out.removeValue(forKey: "_titleSet")

        // 时长也从 format 兜底
        if out["duration"] == nil,
           let track = asset.tracks(withMediaType: .audio).first {
            let d = CMTimeGetSeconds(track.timeRange.duration)
            if d.isFinite, d > 0 { out["duration"] = d }
        }

        // ⚠️ 2026-10-23 兜底 1：文件没内嵌封面时，找同目录同名图片
        //   （下载器把封面单独存成「艺术家 - 标题.jpg」，不写进音频标签）
        if out["cover"] == nil {
            let dir = (path as NSString).deletingLastPathComponent
            let stem = (baseName as NSString).deletingPathExtension
            for ext in ["jpg", "jpeg", "png", "webp"] {
                let cp = (dir as NSString).appendingPathComponent("\(stem).\(ext)")
                if let data = try? Data(contentsOf: URL(fileURLWithPath: cp)),
                   let uri = Self.makeCoverDataURI(data) {
                    out["cover"] = uri
                    break
                }
            }
        }

        // ⚠️ 2026-10-23 兜底 2：文件没有 artist 标签时，解析文件名
        //   下载器保存为「艺术家 - 标题.mp3」格式
        if out["artist"] == nil || (out["artist"] as? String)?.isEmpty == true {
            if let r = noExt.range(of: " - ") {
                let artist = String(noExt[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
                let title = String(noExt[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                if !artist.isEmpty { out["artist"] = artist }
                if !title.isEmpty { out["title"] = title }
            }
        }

        // 深读：位深/采样率/码率/声道
        if deep, let d = readDeepAudioInfo(path) {
            out.merge(d) { _, new in new }
            out["_full"] = 1
        }
        return out
    }

    /// 音频格式详情（前端 am-render.js 显示「位深 / 采样率 / 码率 / 声道」用）
    private func readDeepAudioInfo(_ path: String) -> [String: Any]? {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let asset = AVURLAsset(url: url, options: nil)
        guard let track = asset.tracks(withMediaType: .audio).first else { return nil }
        var out: [String: Any] = [:]
        if let fd = track.formatDescriptions.first {
            let desc = fd as! CMFormatDescription
            let sub = CMFormatDescriptionGetMediaSubType(desc)
            // FourCC 转字符串（alac / mp4a / fLaC ...）
            let chars: [UInt8] = [
                UInt8((sub >> 24) & 0xff), UInt8((sub >> 16) & 0xff),
                UInt8((sub >> 8) & 0xff), UInt8(sub & 0xff),
            ]
            let codec = String(bytes: chars, encoding: .ascii)?
                .trimmingCharacters(in: .whitespaces) ?? ""
            if !codec.isEmpty { out["codec"] = codec }

            if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee {
                out["sampleRate"] = asbd.mSampleRate
                out["channels"] = Int(asbd.mChannelsPerFrame)
                // 位深：mBitsPerChannel 有时为 0，用 bytesPerFrame/channels 推算
                var bits = Int(asbd.mBitsPerChannel)
                if bits == 0, asbd.mBytesPerFrame > 0, asbd.mChannelsPerFrame > 0 {
                    bits = Int(asbd.mBytesPerFrame / asbd.mChannelsPerFrame * 8)
                }
                if bits > 0 { out["bitDepth"] = bits }
            }
        }
        let est = track.estimatedDataRate
        if est.isFinite, est > 0 {
            out["bitrate"] = Double(est) / 1000.0   // kbps
        }
        return out.isEmpty ? nil : out
    }

    // MARK: - 封面

    /// 把封面原始数据压成小尺寸 JPEG data URI（WKWebView 可直接用）
    /// - 失败（数据不是图片）返回 nil
    static func makeCoverDataURI(_ data: Data, maxSide: CGFloat = 320) -> String? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxSide,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
        else { return nil }

        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        let jopts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.72]
        CGImageDestinationAddImage(dest, thumb, jopts as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        let b64 = (out as Data).base64EncodedString()
        return "data:image/jpeg;base64," + b64
    }

    /// 供「专辑网格」用：从音频文件提取封面 URL（data URI）
    func coverURI(path: String) -> String? {
        lock.lock()
        if let c = coverCache[path] { lock.unlock(); return c }
        lock.unlock()
        let m = meta(path: path)
        if let c = m["cover"] as? String {
            lock.lock(); coverCache[path] = c; lock.unlock()
            return c
        }
        return nil
    }
}
