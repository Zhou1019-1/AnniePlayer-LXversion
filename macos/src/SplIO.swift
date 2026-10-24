// 在线歌单（.anniespl）导入导出
//
// ⚠️ 为什么需要（2026-10-23）：
//   侧栏「导入在线歌单…」调用 `window.mine.splImportFile()`（无参数），
//   期望弹出文件选择框 → 解析 .anniespl → 建歌单 → 返回结果。
//   但 Bridge 里此前把它错误地映射到本地歌单导入（PlaylistIO.importFile("")），
//   无参数 → 直接返回「文件不存在」→ 用户看到「点了没反应」。
//   导出 `splExportFile(plId)` 同样缺失。
//
// .anniespl 格式（JSON，流媒体曲目只存 provider + 平台 id，跨机联网即播）：
//   {
//     "format": "anniespl",
//     "version": 1,
//     "exportedAt": 1234567890,
//     "playlists": [
//       { "id": "spl-...", "name": "歌单名", "songs": [ {provider, songmid, name, artist, ...} ] }
//     ]
//   }

import Foundation
import AppKit
import UniformTypeIdentifiers

final class SplIO {
    static let shared = SplIO()

    private init() {}

    // MARK: - 导出

    /// splExportFile(plId) → {ok, path, count} / {reason: "canceled"}
    func exportFile(plId: String) async -> [String: Any] {
        guard !plId.isEmpty else { return ["ok": false, "reason": "缺少歌单 id"] }
        let list = LibraryStore.shared.splList()
        guard let pl = list.first(where: { ($0["id"] as? String) == plId }) else {
            return ["ok": false, "reason": "歌单不存在"]
        }
        let name = (pl["name"] as? String) ?? "在线歌单"
        let songs = (pl["songs"] as? [[String: Any]]) ?? []
        let payload: [String: Any] = [
            "format": "anniespl",
            "version": 1,
            "exportedAt": Int(Date().timeIntervalSince1970),
            "playlists": [pl],
        ]
        guard let data = try? JSONSerialization.data(
            withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) else {
            return ["ok": false, "reason": "序列化失败"]
        }
        // 保存对话框
        let dest: String? = await withCheckedContinuation { cont in
            DispatchQueue.main.async {
                let panel = NSSavePanel()
                panel.nameFieldStringValue = name.replacingOccurrences(of: "/", with: "_") + ".anniespl"
                panel.canCreateDirectories = true
                panel.message = "导出在线歌单（流媒体曲目只存平台 ID，联网即可播放）"
                if panel.runModal() == .OK {
                    cont.resume(returning: panel.url?.path)
                } else {
                    cont.resume(returning: nil)
                }
            }
        }
        guard let path = dest else { return ["ok": false, "reason": "canceled"] }
        do {
            try data.write(to: URL(fileURLWithPath: path))
            fputs("[SPL] 已导出在线歌单: \(name) (\(songs.count) 首) → \(path)\n", stderr)
            return ["ok": true, "path": path, "count": songs.count]
        } catch {
            return ["ok": false, "reason": error.localizedDescription]
        }
    }

    // MARK: - 导入

    /// splImportFile() → {canceled?, playlists, results:[{file, ok, imported, total, id, error}]}
    func importFiles() async -> [String: Any] {
        // 文件选择（多选）
        let picked: [String] = await withCheckedContinuation { cont in
            DispatchQueue.main.async {
                let panel = NSOpenPanel()
                panel.canChooseFiles = true
                panel.canChooseDirectories = false
                panel.allowsMultipleSelection = true
                panel.message = "选择 .anniespl 在线歌单文件（可多选）"
                if #available(macOS 11.0, *) {
                    // 同时允许 .anniespl 和 json
                    if let t = UTType(filenameExtension: "anniespl") {
                        panel.allowedContentTypes = [t, .json]
                    }
                } else {
                    panel.allowedFileTypes = ["anniespl", "json"]
                }
                if panel.runModal() == .OK {
                    cont.resume(returning: panel.urls.map { $0.path })
                } else {
                    cont.resume(returning: [])
                }
            }
        }
        guard !picked.isEmpty else {
            return ["canceled": true, "playlists": LibraryStore.shared.splList(), "results": [Any]()]
        }

        var results: [[String: Any]] = []
        for path in picked {
            results.append(importOne(path))
        }
        fputs("[SPL] 导入完成: \(results.count) 个文件\n", stderr)
        return ["playlists": LibraryStore.shared.splList(), "results": results]
    }

    /// 直接导入指定路径（无文件选择框，供拖拽/自动化/测试用）
    func importPath(_ path: String) -> [String: Any] {
        var r = importOne(path)
        r["playlists"] = LibraryStore.shared.splList()
        return r
    }

    /// 导入单个 .anniespl 文件
    private func importOne(_ path: String) -> [String: Any] {
        let fileName = (path as NSString).lastPathComponent
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            return ["file": fileName, "ok": false, "error": "读取失败",
                    "imported": 0, "total": 0]
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pls = obj["playlists"] as? [[String: Any]] else {
            return ["file": fileName, "ok": false, "error": "不是有效的 .anniespl 文件",
                    "imported": 0, "total": 0]
        }
        var importedTotal = 0
        var totalTotal = 0
        var lastId = ""
        for pl in pls {
            let name = (pl["name"] as? String) ?? "导入歌单"
            let songs = (pl["songs"] as? [[String: Any]]) ?? []
            totalTotal += songs.count
            // 创建歌单
            let created = LibraryStore.shared.splCreate(name)
            guard let newPl = (created as [[String: Any]]).last,
                  let newId = newPl["id"] as? String else { continue }
            // 批量加歌（保留平台 id，播放时联网取流）
            if !songs.isEmpty {
                _ = LibraryStore.shared.splAdd(plId: newId, songs: songs)
                importedTotal += songs.count
            }
            lastId = newId
            fputs("[SPL] 导入歌单「\(name)」\(songs.count) 首\n", stderr)
        }
        return ["file": fileName, "ok": true, "id": lastId,
                "imported": importedTotal, "total": totalTotal]
    }
}
