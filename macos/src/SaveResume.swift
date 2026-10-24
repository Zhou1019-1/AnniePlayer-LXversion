// 播放续播状态持久化
//
// ⚠️ 为什么需要（2026-10-22）：
//   本 App 的 WKWebView 在重启时**会清空 localStorage**
//   （index.html 里早就注释过这个现象，所以引导页标记要每次重写）。
//   于是「记住上次播放的歌」没法靠 localStorage 实现。
//   这里改用文件持久化，和 library.json / downloads.json 同目录。
//
// UI 契约：
//   saveResume({kind, idx, pos, playing, quality, title, artist, songs, path})
//   loadResume() → 同上 或 null
//   clearResume()

import Foundation

final class SaveResume {
    static let shared = SaveResume()
    private init() {}

    private var fileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("AnnieMac")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("resume.json")
    }

    func save(_ d: Any?) -> [String: Any] {
        guard let dict = d as? [String: Any],
              JSONSerialization.isValidJSONObject(dict) else {
            return ["ok": false]
        }
        if let data = try? JSONSerialization.data(withJSONObject: dict) {
            try? data.write(to: fileURL)
            return ["ok": true]
        }
        return ["ok": false]
    }

    func load() -> Any? {
        guard let data = try? Data(contentsOf: fileURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return NSNull()
        }
        return obj
    }

    func clear() -> [String: Any] {
        try? FileManager.default.removeItem(at: fileURL)
        return ["ok": true]
    }
}
