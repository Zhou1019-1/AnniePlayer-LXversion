// 下载任务设置（settings.js「下载任务」分组用）
//
// ⚠️ 为什么需要（2026-10-23）：
//   设置页的「同时下载任务数 / 同名跳过 / 文件命名 / 嵌入封面歌词」等
//   调用 dlGetSettings / dlSetSettings，但 Bridge 里这两个方法没实现 →
//   设置项显示默认值、修改后不保存、并发数永远是硬编码的 2。

import Foundation

final class DownloadSettings {
    static let shared = DownloadSettings()
    private let key = "annie.dl.settings"

    private let defaults: [String: Any] = [
        "concurrency": 3,
        "skipExisting": true,
        "fileNameFmt": "artist-name",
        "embedCover": true,
        "embedLrc": true,
        "embedTLrc": true,
        "lrcTLrc": true,
        "lrcEncoding": "utf8",
    ]

    private var data: [String: Any] {
        var d = defaults
        if let saved = UserDefaults.standard.dictionary(forKey: key) {
            for (k, v) in saved { d[k] = v }
        }
        return d
    }

    private init() {}

    func snapshot() -> [String: Any] {
        data
    }

    func update(_ patch: [String: Any]) -> [String: Any] {
        var d = data
        for (k, v) in patch where !(v is NSNull) { d[k] = v }
        UserDefaults.standard.set(d, forKey: key)
        // 并发数即时应用到下载队列
        if let c = d["concurrency"] as? Int {
            DownloadQueue.shared.setConcurrency(c)
        } else if let c = d["concurrency"] as? NSNumber {
            DownloadQueue.shared.setConcurrency(c.intValue)
        }
        return d
    }

    /// 当前并发数（DownloadQueue 初始化时用）
    var concurrency: Int {
        max(1, min(10, (data["concurrency"] as? Int) ?? 3))
    }
}
