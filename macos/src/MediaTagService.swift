// 媒体标签编辑服务（编辑标签 / 选择封面 / 在 Finder 中显示 / BPM）
//
// ⚠️ 为什么需要（2026-10-23）：
//   歌曲右键菜单（「歌曲操作」）里的多项功能都调了 Bridge 方法，但这些方法
//   只在前端存在调用、后端 dispatch 里**完全没有实现**，点击后落到 default 返回空：
//     · 编辑标签…          → tagEdit / tagEditBatch / tagPickCover
//     · 打开文件位置        → showItemInFolder（连 allMethods 都没注册）
//     · 在线匹配歌词/封面…  → matchSearch / matchApply / matchBatchStart
//   用 ffmpeg 写标签（支持 mp3 / m4a / flac / wav 等，-c copy 不重新编码，无损）。

import Foundation
import AppKit

/// 媒体标签编辑
final class MediaTagService {
    static let shared = MediaTagService()

    private init() {}

    // MARK: - ffmpeg 路径

    /// 找 ffmpeg（Homebrew / 常见路径）
    private var ffmpegPath: String? {
        if let cached = Self._ffmpegPath { return cached.isEmpty ? nil : cached }
        var candidates = [
            "/opt/homebrew/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
            "/usr/bin/ffmpeg",
        ]
        // 也查 PATH 里的
        if let pathEnv = ProcessInfo.processInfo.environment["PATH"] {
            for dir in pathEnv.split(separator: ":") {
                candidates.append("\(dir)/ffmpeg")
            }
        }
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            Self._ffmpegPath = c
            return c
        }
        Self._ffmpegPath = ""
        fputs("[TAG] 未找到 ffmpeg（标签写入功能不可用）\n", stderr)
        return nil
    }
    private static var _ffmpegPath: String?

    // MARK: - 在 Finder 中显示

    func showItemInFolder(path: String) -> [String: Any] {
        guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else {
            return ["ok": false, "reason": "文件不存在"]
        }
        let url = URL(fileURLWithPath: path)
        DispatchQueue.main.async {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
        return ["ok": true]
    }

    // MARK: - 选择封面文件

    /// 打开文件选择框，返回选中图片的路径（取消返回空字符串）
    func pickCover() -> String {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "选择封面图片（jpg / png / webp）"
        if #available(macOS 11.0, *) {
            panel.allowedContentTypes = [.image]
        } else {
            panel.allowedFileTypes = ["jpg", "jpeg", "png", "webp"]
        }
        let r = panel.runModal()
        guard r == .OK, let url = panel.url else { return "" }
        return url.path
    }

    // MARK: - 编辑标签

    /// 单个文件写标签
    /// payload: {path, title, artist, album, albumArtist, genre, date,
    ///           track, disc, composer, publisher, comment, coverFile}
    func tagEdit(_ payload: [String: Any]) -> [String: Any] {
        guard let path = payload["path"] as? String, !path.isEmpty else {
            return ["ok": false, "reason": "缺少文件路径"]
        }
        guard FileManager.default.fileExists(atPath: path) else {
            return ["ok": false, "reason": "文件不存在：\(path)"]
        }
        guard let ff = ffmpegPath else {
            return ["ok": false, "reason": "缺少 ffmpeg，无法写入标签（可 brew install ffmpeg）"]
        }
        let result = writeTags(path: path, fields: payload, coverFile: payload["coverFile"] as? String, ffmpeg: ff)
        return result
    }

    /// 批量写标签
    /// payload: {paths:[...], fields:{...}, coverFile}
    func tagEditBatch(_ payload: [String: Any]) -> [String: Any] {
        let paths = (payload["paths"] as? [String]) ?? []
        let fields = (payload["fields"] as? [String: Any]) ?? [:]
        let coverFile = payload["coverFile"] as? String
        guard !paths.isEmpty else { return ["ok": false, "reason": "没有选中文件", "results": []] }
        guard let ff = ffmpegPath else {
            return ["ok": false, "reason": "缺少 ffmpeg，无法写入标签（可 brew install ffmpeg）",
                    "results": paths.map { ["path": $0, "ok": false, "reason": "缺少 ffmpeg"] }]
        }
        var results: [[String: Any]] = []
        var okCount = 0
        for p in paths {
            guard FileManager.default.fileExists(atPath: p) else {
                results.append(["path": p, "ok": false, "reason": "文件不存在"])
                continue
            }
            let r = writeTags(path: p, fields: fields, coverFile: coverFile, ffmpeg: ff)
            var item: [String: Any] = ["path": p, "ok": (r["ok"] as? Bool) ?? false]
            if let reason = r["reason"] as? String { item["reason"] = reason }
            if item["ok"] as? Bool == true { okCount += 1 }
            results.append(item)
        }
        return ["ok": okCount > 0, "results": results, "okCount": okCount]
    }

    /// 用 ffmpeg 写标签（-c copy 不重新编码）
    private func writeTags(path: String, fields: [String: Any],
                           coverFile: String?, ffmpeg: String) -> [String: Any] {
        let fm = FileManager.default
        let ext = (path as NSString).pathExtension.lowercased()
        let hasCover = (coverFile?.isEmpty == false) && fm.fileExists(atPath: coverFile ?? "")

        var args: [String] = ["-hide_banner", "-loglevel", "error", "-y", "-i", path]
        if hasCover, let cover = coverFile {
            args += ["-i", cover]
        }
        // 映射：音频流 +（可选）封面图
        args += ["-map", "0:a"]
        if hasCover { args += ["-map", "1:v"] }
        args += ["-c", "copy"]

        // 元数据字段映射（UI 字段 → ffmpeg metadata key）
        let fieldMap: [(String, String)] = [
            ("title", "title"),
            ("artist", "artist"),
            ("album", "album"),
            ("albumArtist", "album_artist"),
            ("genre", "genre"),
            ("date", "date"),
            ("track", "track"),
            ("disc", "disc"),
            ("composer", "composer"),
            ("publisher", "publisher"),
            ("comment", "comment"),
        ]
        var wroteAny = false
        for (ui, ffKey) in fieldMap {
            guard let v = fields[ui] as? String, !v.isEmpty else { continue }
            args += ["-metadata", "\(ffKey)=\(v)"]
            wroteAny = true
        }
        if hasCover {
            args += ["-metadata:s:v", "title=Album cover",
                     "-metadata:s:v", "comment=Cover (front)"]
            if ext == "mp3" {
                args += ["-id3v2_version", "3"]
            } else {
                args += ["-disposition:v", "attached_pic"]
            }
            wroteAny = true
        }
        guard wroteAny else {
            return ["ok": false, "reason": "没有要写入的字段"]
        }

        // 输出到同目录临时文件（ffmpeg 不能原地覆盖）
        let dir = (path as NSString).deletingLastPathComponent
        let base = (path as NSString).deletingPathExtension
        let tmp = (dir as NSString).appendingPathComponent(".tagtmp-\(UUID().uuidString).\(ext)")
        args += [tmp]

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: ffmpeg)
        proc.arguments = args
        let errPipe = Pipe()
        proc.standardError = errPipe
        proc.standardOutput = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return ["ok": false, "reason": "ffmpeg 启动失败：\(error.localizedDescription)"]
        }
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        let errText = String(data: errData, encoding: .utf8) ?? ""
        guard proc.terminationStatus == 0, fm.fileExists(atPath: tmp) else {
            try? fm.removeItem(atPath: tmp)
            let reason = errText.isEmpty ? "ffmpeg 退出码 \(proc.terminationStatus)" : errText
            return ["ok": false, "reason": String(reason.prefix(300))]
        }
        // 替换原文件
        do {
            _ = try fm.replaceItemAt(URL(fileURLWithPath: path),
                                     withItemAt: URL(fileURLWithPath: tmp),
                                     backupItemName: nil,
                                     options: [])
            return ["ok": true, "path": path]
        } catch {
            // replaceItemAt 对某些文件系统会失败 → 退回删+移
            do {
                try fm.removeItem(atPath: path)
                try fm.moveItem(atPath: tmp, toPath: path)
                return ["ok": true, "path": path]
            } catch {
                try? fm.removeItem(atPath: tmp)
                return ["ok": false, "reason": "写入失败：\(error.localizedDescription)"]
            }
        }
    }

    // MARK: - BPM

    private var bpmStore: [String: Double] = [:]
    private let bpmLock = NSLock()

    func bpmSet(_ map: [String: Double]) {
        bpmLock.lock(); defer { bpmLock.unlock() }
        for (k, v) in map { bpmStore[k] = v }
    }

    func bpmGet(_ path: String) -> Double {
        bpmLock.lock(); defer { bpmLock.unlock() }
        return bpmStore[path] ?? 0
    }
}
