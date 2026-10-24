// 媒体库文件夹扫描
//
// ⚠️ 为什么需要（2026-10-23）：
//   「添加歌曲文件夹」功能此前是坏的 —— Bridge.pickFolder 只返回一个路径**字符串**，
//   而前端期望 `state.library = await window.mine.pickFolder()` 得到一个 library 对象
//   （含 tracks），于是 state.library 被赋成字符串 → 曲库直接空掉。
//   而且没有任何「把文件夹里的音频入库」的逻辑：
//     · scanStart / rescan / removeFolder 全部没实现
//     · onScanEvent 进度事件也没有
//
// 本文件实现：
//   · 选择文件夹 → 递归扫描音频文件 → 写入曲库 → 返回 library snapshot
//   · 记住已添加的文件夹（UserDefaults），重启后 rescan / 启动自动补扫
//   · 扫描进度通过 onScanEvent 推给前端

import Foundation
import AppKit

final class LibraryScanner {
    static let shared = LibraryScanner()

    /// 已添加的媒体库文件夹（UserDefaults 持久化）
    private let foldersKey = "annie.library.folders"
    private let lock = NSLock()
    private var scanning = false
    private var cancelling = false

    /// 支持的音频扩展名
    static let audioExts: Set<String> = [
        "mp3", "m4a", "m4b", "aac", "flac", "wav", "aif", "aiff",
        "ogg", "opus", "ape", "wv", "dsf", "dff", "wma", "mp4",
    ]

    private init() {}

    // MARK: - 文件夹列表

    var folders: [String] {
        get {
            lock.lock(); defer { lock.unlock() }
            return (UserDefaults.standard.stringArray(forKey: foldersKey) ?? [])
                .filter { FileManager.default.fileExists(atPath: $0) }
        }
        set {
            lock.lock(); defer { lock.unlock() }
            UserDefaults.standard.set(newValue, forKey: foldersKey)
        }
    }

    // MARK: - 选择文件夹 + 扫描入库

    /// 打开选择框选文件夹，扫描并入库，返回最新 library snapshot
    /// 前端用法：`state.library = await window.mine.pickFolder()`
    func pickAndScan() async -> [String: Any] {
        let path: String? = await withCheckedContinuation { cont in
            DispatchQueue.main.async {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                panel.allowsMultipleSelection = false
                panel.message = "选择音乐文件夹（会递归扫描其中的音频文件）"
                if panel.runModal() == .OK {
                    cont.resume(returning: panel.url?.path)
                } else {
                    cont.resume(returning: nil)
                }
            }
        }
        guard let dir = path else {
            // 用户取消 → 返回当前曲库，不动
            return LibraryStore.shared.librarySnapshot()
        }
        // 记住这个文件夹
        var fs = folders
        if !fs.contains(dir) { fs.append(dir); folders = fs }
        // 扫描（入库 + 推送进度）
        await scan(folders: [dir], replaceAll: false)
        return LibraryStore.shared.librarySnapshot()
    }

    /// 扫描全部已添加的文件夹（rescan / 启动补扫）
    func rescanAll() async -> [String: Any] {
        await scan(folders: folders, replaceAll: false)
        return LibraryStore.shared.librarySnapshot()
    }

    /// 移除某个媒体库文件夹（不删文件，只把该目录下曲目移出曲库）
    func removeFolder(_ dir: String) async -> [String: Any] {
        var fs = folders
        fs.removeAll { $0 == dir }
        folders = fs
        // 从曲库里移除该目录下的曲目
        let snapshot = LibraryStore.shared.librarySnapshot()
        let tracks = (snapshot["tracks"] as? [[String: Any]]) ?? []
        let prefix = dir.hasSuffix("/") ? dir : dir + "/"
        var removed = 0
        for t in tracks {
            guard let p = t["path"] as? String else { continue }
            if p.hasPrefix(prefix) {
                LibraryStore.shared.removeTrack(path: p)
                removed += 1
            }
        }
        fputs("[SCAN] 移除文件夹: \(dir)（移除 \(removed) 首）\n", stderr)
        return LibraryStore.shared.librarySnapshot()
    }

    /// 扫描（只负责扫，返回新发现的曲目数）
    /// - replaceAll: 是否先清空曲库再扫（当前不用，保留参数）
    @discardableResult
    func scan(folders: [String], replaceAll: Bool) async -> Int {
        lock.lock()
        if scanning { lock.unlock(); return 0 }
        scanning = true
        cancelling = false
        lock.unlock()
        defer {
            lock.lock(); scanning = false; lock.unlock()
            pushScanEvent(["type": "done", "found": 0])
        }

        var found = 0
        for dir in folders {
            guard FileManager.default.fileExists(atPath: dir) else { continue }
            fputs("[SCAN] 扫描: \(dir)\n", stderr)
            let files = collectAudioFiles(dir)
            fputs("[SCAN] 发现 \(files.count) 个音频文件\n", stderr)
            // 分批入库 + 推送进度（每 30 首一批）
            var batch: [[String: Any]] = []
            for f in files {
                let url = URL(fileURLWithPath: f)
                let base = url.lastPathComponent
                let noExt = (base as NSString).deletingPathExtension
                // 简单解析「艺术家 - 标题」
                var title = noExt
                var artist = ""
                if let r = noExt.range(of: " - ") {
                    artist = String(noExt[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
                    title = String(noExt[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                }
                let size = (try? FileManager.default.attributesOfItem(atPath: f))?[.size] as? Int64 ?? 0
                let info: [String: Any] = [
                    "path": f, "name": base, "title": title,
                    "artist": artist, "album": "",
                    "dur": 0, "size": size,
                    "addedAt": Int(Date().timeIntervalSince1970),
                    "provider": "local",
                ]
                LibraryStore.shared.addTrack(info)
                batch.append(info)
                found += 1
                if batch.count >= 40 {
                    pushScanEvent(["type": "batch", "tracks": batch, "found": found])
                    batch.removeAll()
                    // 让出事件循环，避免卡 UI
                    await Task.yield()
                }
            }
            if !batch.isEmpty {
                pushScanEvent(["type": "batch", "tracks": batch, "found": found])
            }
        }
        fputs("[SCAN] 扫描完成，共 \(found) 首\n", stderr)
        return found
    }

    /// 取消扫描（下一次循环检查时退出）
    func cancelScan() {
        lock.lock(); cancelling = true; lock.unlock()
    }

    /// 公开入口（给拖拽展开等外部模块用）
    func collectAudioPaths(_ dir: String) -> [String] { collectAudioFiles(dir) }

    /// 递归收集音频文件（跳过隐藏目录/资源分支）
    private func collectAudioFiles(_ dir: String) -> [String] {
        var out: [String] = []
        let fm = FileManager.default
        guard let en = fm.enumerator(atPath: dir) else { return out }
        while let rel = en.nextObject() as? String {
            let name = (rel as NSString).lastPathComponent
            if name.hasPrefix(".") { continue }
            let full = (dir as NSString).appendingPathComponent(rel)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: full, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                // 跳过资源分支 / 包目录
                if name.hasSuffix(".app") || name == "Library" { en.skipDescendants() }
                continue
            }
            let ext = (name as NSString).pathExtension.lowercased()
            if LibraryScanner.audioExts.contains(ext) {
                out.append(full)
            }
        }
        return out
    }

    /// 推送扫描进度事件给前端（onScanEvent）
    private func pushScanEvent(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj),
              let js = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            Bridge.shared.webView?.evaluateJavaScript(
                "try{window.mine.__emit_onScanEvent(\(js));}catch(e){}") { _, _ in }
        }
    }
}
