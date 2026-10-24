// Apple Music 播放/下载核心（HLS → ALAC → 解密 → 缓存 mp4）
//
// ⚠️ 为什么需要（2026-10-23）：
//   · Bridge.amPlay 里的解密流程是一段内联代码，DownloadQueue 想复用只能复制
//   · 更关键的是：DownloadQueue 的 provider 分支只有 kw/kg/else，
//     AM 歌曲（provider=alac）走 else → 旧的失效后端 → 下载永远失败（无响应）
//   把流程抽到这里，播放和下载共用同一套逻辑和缓存。

import Foundation

final class AMPlayService {
    static let shared = AMPlayService()

    private init() {}

    /// 下载并解密一首 AM 歌曲，返回本地缓存 mp4 路径
    /// - Parameters:
    ///   - adamId: Apple Music 歌曲 id
    ///   - progress: (已完成, 总数) 进度回调（可选）
    func fetchAndDecrypt(adamId: String,
                         progress: ((Int, Int) -> Void)? = nil) async throws -> URL {
        guard !adamId.isEmpty else {
            throw PlayerError.liteBadResponse("缺少 adamId")
        }
        let master = try await LiteAPI.masterURL(adamId: adamId)
        let variant = try await HLS.selectALAC(master: master)
        let playlist = try await HLS.parseMedia(variant.url)
        // 首个分片固定模板，其余用 m3u8 里声明的 key URI
        let keyURI = playlist.segments.compactMap { $0.keyURI }
            .first { !$0.contains("P000000000") } ?? ""
        let template = try await LiteAPI.key(adamId: adamId, uri: keyURI)
        return try await AudioFetcher.build(
            variant: variant, template: template,
            cacheKey: adamId, progress: progress ?? { _, _ in })
    }

    /// AM 歌词（TTML → LRC + 译文）
    func lyrics(adamId: String) async -> (lrc: String, tlyric: String) {
        guard !adamId.isEmpty else { return ("", "") }
        guard let ttml = try? await LiteAPI.lyrics(adamId: adamId), !ttml.isEmpty else {
            return ("", "")
        }
        let (lrc, tl) = TTMLParser.toLRC(ttml)
        return (lrc, tl)
    }

    /// AM 歌曲封面 URL（从歌曲对象里取）
    static func coverURL(_ song: [String: Any]) -> String {
        if let c = song["cover"] as? String, !c.isEmpty { return c }
        if let c = song["img"] as? String, !c.isEmpty { return c }
        if let c = song["pic"] as? String, !c.isEmpty { return c }
        if let art = song["artwork"] as? [String: Any],
           let u = art["url"] as? String { return u }
        return ""
    }
}
