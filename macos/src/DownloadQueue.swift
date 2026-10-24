// 下载队列 —— 洛雪式任务管理
//
// UI（am-download.js）需要的接口：
//   dlAdd([{provider, quality, song, saveLrc, saveCover}])  → {added, skipped}
//   dlList()                                                → {items: [...]}
//   dlPause(id) / dlResume(id) / dlRemove(id) / dlRetryAll()
//   dlClear()                                               → 清空已完成
//   dlOpenFolder()                                          → 在 Finder 打开
//   onDlEvent(cb)                                           → 任务状态变化推送
//
// 任务状态：pending → downloading → done | error | paused

import Foundation
import AppKit

/// 下载任务
struct DlTask {
    let id: String
    var provider: String
    var quality: String
    var name: String
    var artist: String
    var album: String
    var cover: String        // 封面 URL / data URI（列表里显示用）
    var songJSON: [String: Any]
    var saveLrc: Bool
    var saveCover: Bool
    var status: String      // pending / downloading / done / error / paused
    var received: Int64
    var total: Int64
    var path: String
    var error: String

    var percent: Int {
        total > 0 ? Int(Double(received) / Double(total) * 100) : 0
    }

    func toJSON() -> [String: Any] {
        var d: [String: Any] = [
            "id": id, "provider": provider, "quality": quality,
            "name": name, "artist": artist, "album": album, "cover": cover,
            "status": status, "received": received, "total": total,
            "percent": percent,
        ]
        if !path.isEmpty { d["path"] = path }
        if !error.isEmpty { d["error"] = error }
        return d
    }
}

final class DownloadQueue {
    static let shared = DownloadQueue()

    private var tasks: [DlTask] = []
    private var order: [String] = []
    private let lock = NSLock()
    private var running = 0
    // ⚠️ 2026-10-23：并发数改为可配置（设置页「同时下载任务数」，默认 3）
    private var maxConcurrent = 3
    private var seq = 0

    private init() {
        loadPersisted()
    }

    // MARK: - 持久化
    //
    // ⚠️ 2026-10-22：队列存盘（用户要求「重启后不丢失」）。
    //    已完成的任务保留记录（显示 ✓ + 路径），未完成的重新排队。
    private var persistURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("AnnieMac")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("downloads.json")
    }

    private func persist() {
        lock.lock()
        let arr: [[String: Any]] = order.compactMap { id in
            guard let t = tasks.first(where: { $0.id == id }) else { return nil }
            var d = t.toJSON()
            d["song"] = t.songJSON      // 恢复时需要完整歌曲信息
            d["saveLrc"] = t.saveLrc
            d["saveCover"] = t.saveCover
            return d
        }
        lock.unlock()
        if let data = try? JSONSerialization.data(withJSONObject: arr) {
            try? data.write(to: persistURL)
        }
    }

    private func loadPersisted() {
        guard let data = try? Data(contentsOf: persistURL),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        lock.lock()
        for d in arr {
            guard let id = d["id"] as? String else { continue }
            let st = (d["status"] as? String) ?? "pending"
            // 上次没跑完的 → 重新排队
            let status = (st == "done" || st == "error") ? st : "pending"
            let task = DlTask(
                id: id,
                provider: (d["provider"] as? String) ?? "",
                quality: (d["quality"] as? String) ?? "",
                name: (d["name"] as? String) ?? "",
                artist: (d["artist"] as? String) ?? "",
                album: (d["album"] as? String) ?? "",
                cover: (d["cover"] as? String) ?? Self.coverFromSong((d["song"] as? [String: Any]) ?? [:]),
                songJSON: (d["song"] as? [String: Any]) ?? [:],
                saveLrc: (d["saveLrc"] as? Bool) ?? true,
                saveCover: (d["saveCover"] as? Bool) ?? true,
                status: status,
                received: (d["received"] as? Int64) ?? 0,
                total: (d["total"] as? Int64) ?? 0,
                path: (d["path"] as? String) ?? "",
                error: (d["error"] as? String) ?? "")
            tasks.append(task)
            order.append(id)
        }
        // 已完成的任务如果文件已不存在，标成 error
        for i in tasks.indices where tasks[i].status == "done" {
            if !tasks[i].path.isEmpty, !FileManager.default.fileExists(atPath: tasks[i].path) {
                tasks[i].status = "pending"
                tasks[i].path = ""
            }
        }
        lock.unlock()
        if !tasks.isEmpty {
            fputs("DownloadQueue: 从磁盘恢复了 \(tasks.count) 个任务\n", stderr)
            pump()
        }
    }

    // MARK: - 对外接口

    /// 从 song 对象里提取封面地址（各平台字段名不同）
    static func coverFromSong(_ song: [String: Any]) -> String {
        if let c = song["cover"] as? String, !c.isEmpty { return c }
        if let c = song["img"] as? String, !c.isEmpty { return c }
        if let c = song["pic"] as? String, !c.isEmpty { return c }
        if let art = song["artwork"] as? [String: Any],
           let c = art["url"] as? String { return c }
        return ""
    }

    /// 设置并发数（设置页修改后即时生效）
    func setConcurrency(_ n: Int) {
        let v = max(1, min(10, n))
        lock.lock()
        maxConcurrent = v
        lock.unlock()
        emit()
        pump()
    }

    func add(_ items: [[String: Any]]) -> [String: Any] {
        var added = 0, skipped = 0
        lock.lock()
        for it in items {
            let provider = (it["provider"] as? String) ?? ""
            let quality = (it["quality"] as? String) ?? ""
            let song = (it["song"] as? [String: Any]) ?? [:]
            let name = (song["name"] as? String) ?? (it["name"] as? String) ?? ""
            let artist = (song["artist"] as? String)
                ?? (song["singer"] as? String) ?? (it["artist"] as? String) ?? ""
            let album = (song["album"] as? String)
                ?? (song["albumName"] as? String) ?? ""
            // 封面：各平台字段名不同（cover / img / pic / artwork）
            var cover = (song["cover"] as? String)
                ?? (song["img"] as? String) ?? (song["pic"] as? String) ?? ""
            if cover.isEmpty, let art = song["artwork"] as? [String: Any] {
                cover = (art["url"] as? String) ?? ""
            }
            let sid = Bridge.songIdentity(song)
            // 去重：同 provider + 同一个 song id + 同音质 且在队列里未完成
            let dup = tasks.contains {
                $0.provider == provider && $0.quality == quality
                && Bridge.songIdentity($0.songJSON) == sid
                && ($0.status == "pending" || $0.status == "downloading" || $0.status == "done")
            }
            if dup { skipped += 1; continue }
            seq += 1
            let id = "dl-\(Int(Date().timeIntervalSince1970))-\(seq)"
            tasks.append(DlTask(
                id: id, provider: provider, quality: quality,
                name: name, artist: artist, album: album, cover: cover,
                songJSON: song,
                saveLrc: (it["saveLrc"] as? Bool) ?? true,
                saveCover: (it["saveCover"] as? Bool) ?? true,
                status: "pending", received: 0, total: 0, path: "", error: ""))
            order.append(id)
            added += 1
        }
        lock.unlock()
        if added > 0 {
            emit()
            persist()
            pump()
        }
        return ["added": added, "skipped": skipped]
    }

    // ⚠️ 返回**裸数组**（2026-10-21）：UI 里 `dlTasks = l || []` 直接当数组用，
    //    之前返回 {items:[...]} 导致下载页永远是空的。
    func list() -> [[String: Any]] {
        lock.lock()
        let snap = order.compactMap { id in tasks.first { $0.id == id } }.map { $0.toJSON() }
        lock.unlock()
        return snap
    }

    func pause(_ id: String) {
        lock.lock()
        if let i = tasks.firstIndex(where: { $0.id == id }), tasks[i].status == "pending" {
            tasks[i].status = "paused"
        }
        lock.unlock()
        emit()
    }

    /// 恢复/重试任务
    ///
    /// ⚠️ 2026-10-23 修复「重试按钮没反应」：
    ///   原来这里只处理 `paused` 状态，但下载页「重试」按钮（出错任务）调用的是
    ///   同一个 dlResume → 状态是 `error` 不满足条件 → 什么都不做 → 按钮点了没反应。
    ///   现在 error 也允许重试：状态回 pending、清空错误和进度、重新调度。
    ///   注意 run() 的 catch 分支已经把 running 减回 1，pump() 能正常调度。
    func resume(_ id: String) {
        lock.lock()
        if let i = tasks.firstIndex(where: { $0.id == id }),
           tasks[i].status == "paused" || tasks[i].status == "error" {
            tasks[i].status = "pending"
            tasks[i].error = ""
            tasks[i].received = 0
            tasks[i].total = 0
        }
        lock.unlock()
        emit(); persist(); pump()
    }

    func remove(_ id: String) {
        lock.lock()
        tasks.removeAll { $0.id == id && $0.status != "downloading" }
        order.removeAll { $0 == id }
        lock.unlock()
        emit()
        persist()
    }

    func retryAll() {
        lock.lock()
        for i in tasks.indices where tasks[i].status == "error" {
            tasks[i].status = "pending"
            tasks[i].error = ""
            tasks[i].received = 0
            tasks[i].total = 0
        }
        lock.unlock()
        emit(); persist(); pump()
    }

    func clear() -> [String: Any] {
        lock.lock()
        let before = tasks.count
        let doneIds = Set(tasks.filter { $0.status == "done" || $0.status == "error" }.map { $0.id })
        tasks.removeAll { doneIds.contains($0.id) }
        order.removeAll { doneIds.contains($0) }
        let removed = before - tasks.count
        lock.unlock()
        emit()
        persist()
        return ["ok": true, "removed": removed]
    }

    func openFolder() {
        let dir = DownloadManager.shared.dir
        NSWorkspace.shared.open(dir)
    }

    // MARK: - 执行

    private func pump() {
        lock.lock()
        var toStart: [DlTask] = []
        while running < maxConcurrent {
            guard let idx = tasks.firstIndex(where: { $0.status == "pending" }) else { break }
            tasks[idx].status = "downloading"
            running += 1
            toStart.append(tasks[idx])
        }
        lock.unlock()
        if toStart.isEmpty { return }
        emit()
        for t in toStart {
            Task.detached { [weak self] in
                await self?.run(t)
            }
        }
    }

    private func run(_ t: DlTask) async {
        do {
            // ============================================================
            // ⚠️ 2026-10-23：Apple Music（provider=alac）下载
            //   此前 DownloadQueue 只有 kw/kg/else 分支 —— AM 歌曲走 else →
            //   旧的失效后端 → 永远失败（表现「下载无响应」）。
            //   AM 的音频要走 HLS 分片下载 + FairPlay 解密（和播放同一套），
            //   得到缓存 mp4 后复制到下载目录，再补歌词/封面。
            // ============================================================
            if t.provider == "alac" || t.provider == "apple" {
                let adamId = Bridge.songIdentity(t.songJSON)
                guard !adamId.isEmpty else {
                    throw NSError(domain: "DL", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "AM：缺少 adamId"])
                }
                fputs("[DL] AM 下载开始: \(t.name) (adamId=\(adamId))\n", stderr)
                // 1. HLS 下载 + 解密（缓存）
                let cached = try await AMPlayService.shared.fetchAndDecrypt(adamId: adamId) { done, total in
                    self.updateProgress(t.id, DownloadProgress(
                        received: Int64(done), total: Int64(total),
                        percent: total > 0 ? Int(Double(done)/Double(total)*100) : 0))
                }
                // 2. 复制到下载目录
                let target = DownloadManager.shared.uniqueTarget(
                    name: t.name, singer: t.artist, ext: "m4a")
                try? FileManager.default.removeItem(at: target)
                try FileManager.default.copyItem(at: cached, to: target)
                // 3. 歌词（AM TTML → LRC）
                if t.saveLrc {
                    let (lrc, _) = await AMPlayService.shared.lyrics(adamId: adamId)
                    if !lrc.isEmpty {
                        let lrcURL = target.deletingPathExtension().appendingPathExtension("lrc")
                        try? lrc.write(to: lrcURL, atomically: true, encoding: .utf8)
                    }
                }
                // 4. 封面
                if t.saveCover {
                    let cu = AMPlayService.coverURL(t.songJSON)
                    if !cu.isEmpty, let u = URL(string: cu),
                       let (cd, resp) = try? await URLSession.shared.data(from: u),
                       (resp as? HTTPURLResponse)?.statusCode == 200,
                       cd.count > 1000 {
                        let coverFile = target.deletingPathExtension().appendingPathExtension("jpg")
                        try? cd.write(to: coverFile)
                    }
                }
                fputs("[DL] AM 下载完成: \(t.name) → \(target.path)\n", stderr)
                // 5. 收尾（入库 + 写标签），复用下方通用逻辑
                lock.lock()
                if let i = tasks.firstIndex(where: { $0.id == t.id }) {
                    tasks[i].status = "done"
                    tasks[i].path = target.path
                    if tasks[i].total <= 0 { tasks[i].total = 1 }
                    tasks[i].received = tasks[i].total
                }
                running -= 1
                lock.unlock()
                var aFileSize: Int64 = 0
                if let attrs = try? FileManager.default.attributesOfItem(atPath: target.path),
                   let sz = attrs[.size] as? Int64 { aFileSize = sz }
                var aDur: Double = 0
                if let iv = t.songJSON["interval"] as? String, let v = Double(iv) { aDur = v }
                else if let iv = t.songJSON["duration"] as? Double { aDur = iv }
                LibraryStore.shared.addTrack([
                    "path": target.path, "name": t.name, "title": t.name,
                    "artist": t.artist, "album": t.album,
                    "dur": aDur, "size": aFileSize, "provider": t.provider,
                ])
                // 写标签
                do {
                    var fields: [String: Any] = ["path": target.path, "title": t.name]
                    if !t.artist.isEmpty { fields["artist"] = t.artist }
                    if !t.album.isEmpty { fields["album"] = t.album }
                    let dir = (target.path as NSString).deletingLastPathComponent
                    let stem = ((target.path as NSString).lastPathComponent as NSString).deletingPathExtension
                    for ext2 in ["jpg", "jpeg", "png"] {
                        let cp = (dir as NSString).appendingPathComponent("\(stem).\(ext2)")
                        if FileManager.default.fileExists(atPath: cp) { fields["coverFile"] = cp; break }
                    }
                    _ = MediaTagService.shared.tagEdit(fields)
                }
                emit(); persist(); pump()
                return
            }

            // 1. 拿播放地址
            // ⚠️ 2026-10-22：下载必须和**播放**走同一套接口。
            //    原来这里直接调 SourceAPI.shared.songURL（旧链路 → 第三方后端 403），
            //    而播放已经改成酷我/酷狗官方接口 → 结果就是「能播不能下」。
            //    现在统一走 Bridge 的 songURLDispatch（内部按 provider 分派）。
            let urlArgs: [String: Any] = [
                "provider": t.provider, "source": t.provider,
                "song": t.songJSON, "quality": t.quality,
            ]
            let ur: [String: Any]
            if t.provider == "kw" {
                let rid = (t.songJSON["rid"] as? String)
                    ?? (t.songJSON["songmid"] as? String)
                    ?? (t.songJSON["hash"] as? String) ?? ""
                guard !rid.isEmpty else {
                    throw NSError(domain: "DL", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "酷我：缺少 rid"])
                }
                ur = await KuwoService.shared.songURL(rid: rid, quality: t.quality)
            } else if t.provider == "kg" {
                let hash = (t.songJSON["hash"] as? String)
                    ?? (t.songJSON["songmid"] as? String) ?? ""
                guard !hash.isEmpty else {
                    throw NSError(domain: "DL", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "酷狗：缺少 hash"])
                }
                let extra = (t.songJSON["_kg"] as? [String: Any]) ?? [:]
                ur = await KugouService.shared.songURL(hash: hash, quality: t.quality, extra: extra)
            } else {
                let u = await SourceAPI.shared.songURL(args: [urlArgs])
                ur = (u as? [String: Any]) ?? [:]
            }
            guard let urlStr = ur["url"] as? String, !urlStr.isEmpty else {
                throw NSError(domain: "DL", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: (ur["error"] as? String) ?? "拿不到地址"])
            }
            // 2. 扩展名：优先按服务端返回的真实格式，别一律用 .mp3
            //    （酷我很多「.mp3」实际是 AAC 数据，落成 .mp3 后 ffmpeg 读不出来，
            //      导致标签编辑功能对该文件永远失败）
            var ext = "mp3"
            let fmt = ((ur["format"] as? String) ?? "").lowercased()
            if fmt == "flac" || urlStr.lowercased().contains(".flac") { ext = "flac" }
            else if fmt == "aac" || fmt == "m4a" || fmt == "mp4"
                 || urlStr.contains(".m4a") || urlStr.contains(".mp4") { ext = "m4a" }
            if (ur["quality"] as? String) == "alac" { ext = "m4a" }

            // 3. 歌词 / 封面
            var lrc: String? = nil
            if t.saveLrc {
                if let ly = await SourceAPI.shared.lyric(args: [urlArgs]) as? [String: Any],
                   let s = ly["lrc"] as? String, !s.isEmpty { lrc = s }
            }
            var cover: String? = nil
            if t.saveCover {
                if let pc = await SourceAPI.shared.picture(args: [urlArgs]) as? [String: Any],
                   let cu = pc["url"] as? String, !cu.isEmpty { cover = cu }
            }

            // 4. 下载（带进度 → 推给 UI）
            let file = try await DownloadManager.shared.download(
                url: urlStr, name: t.name, singer: t.artist, album: t.album,
                ext: ext, lrc: lrc, coverURL: cover) { prog in
                self.updateProgress(t.id, prog)
            }
            // 5. 完成
            lock.lock()
            if let i = tasks.firstIndex(where: { $0.id == t.id }) {
                tasks[i].status = "done"
                tasks[i].path = file.path
                if tasks[i].total <= 0 { tasks[i].total = 1 }
                tasks[i].received = tasks[i].total
            }
            running -= 1
            lock.unlock()

            // ⚠️ 2026-10-22：下载完成后**自动加入资料库**（用户要求：
            //    「下载完成之后我要在已完成界面看见下载完的歌曲，还要在资料库中能直接播放」）。
            //    资料库 UI 读 getLibrary().tracks，这里写入后重开 App 也在。
            var fileSize: Int64 = 0
            if let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
               let sz = attrs[.size] as? Int64 { fileSize = sz }
            var _dur: Double = 0
            if let iv = t.songJSON["interval"] as? String, let v = Double(iv) { _dur = v }
            else if let iv = t.songJSON["duration"] as? Double { _dur = iv }
            else if let iv = t.songJSON["duration"] as? Int { _dur = Double(iv) }
            LibraryStore.shared.addTrack([
                "path": file.path,
                "name": t.name,
                "title": t.name,
                "artist": t.artist,
                "album": t.album,
                "dur": _dur,
                "size": fileSize,
                "provider": t.provider,
            ])
            fputs("\n[DL] 已入库: \(t.name) → \(file.path) (\(fileSize) 字节)\n", stderr)

            // ⚠️ 2026-10-23 新增：下载完成后把 标题/歌手/专辑/封面 写入**文件标签**。
            //    用户要求「专辑信息应当下载下来用于离线播放」——
            //    之前只写 library.json（App 内部记录），文件本身没有任何标签，
            //    一旦资料库记录丢失 / 在别的播放器打开，就看不到专辑信息。
            //    用 MediaTagService（ffmpeg -c copy，不重新编码）写进文件。
            do {
                var fields: [String: Any] = [
                    "path": file.path,
                    "title": t.name,
                ]
                if !t.artist.isEmpty { fields["artist"] = t.artist }
                if !t.album.isEmpty { fields["album"] = t.album }
                // 封面：下载时存成了同目录同名 .jpg/.png
                let dir = (file.path as NSString).deletingLastPathComponent
                let stem = ((file.path as NSString).lastPathComponent as NSString).deletingPathExtension
                for ext in ["jpg", "jpeg", "png"] {
                    let cp = (dir as NSString).appendingPathComponent("\(stem).\(ext)")
                    if FileManager.default.fileExists(atPath: cp) {
                        fields["coverFile"] = cp
                        break
                    }
                }
                let tagRes = MediaTagService.shared.tagEdit(fields)
                if tagRes["ok"] as? Bool == true {
                    fputs("[DL] 已写入文件标签: \(t.name)\n", stderr)
                } else {
                    fputs("[DL] 写标签失败: \(t.name) → \(tagRes["reason"] ?? "未知")\n", stderr)
                }
            }

            emit()
            persist()
            pump()
        } catch {
            lock.lock()
            if let i = tasks.firstIndex(where: { $0.id == t.id }) {
                tasks[i].status = "error"
                tasks[i].error = error.localizedDescription
            }
            running -= 1
            lock.unlock()
            emit()
            persist()
            pump()
        }
    }

    /// 节流时间戳：每个任务最多 10 次/秒的 progress 推送
    private var lastProgressAt: [String: TimeInterval] = [:]

    private func updateProgress(_ id: String, _ p: DownloadProgress) {
        lock.lock()
        if let i = tasks.firstIndex(where: { $0.id == id }) {
            tasks[i].received = p.received
            tasks[i].total = p.total
        }
        lock.unlock()

        // ⚠️ 2026-10-23 修复「下载中没有实时进度条和百分比」：
        //    原来这里每次收到下载块都调 emit() —— 发的是**全量 tasks 快照**
        //    （序列化所有任务 + 前端 renderView 全量重绘），
        //    频次高达每秒几十次 → IPC 堆积、表格闪烁、进度条根本追不上。
        //    现在改成发轻量 progress 事件（只含 id/received/total），
        //    前端 updateProgress() 原地改进度条宽度和百分比，不重绘表格。
        //    并且做 10 次/秒 节流，避免高频 IPC。
        let now = Date().timeIntervalSince1970
        lock.lock()
        // ⚠️ 2026-10-23：节流放宽到 0.25 秒（4 次/秒）。
        //    用户反馈「如果占用资源比较多就分段显示进度条也可以，至少让人知道」——
        //    4 次/秒足够看出进度在动，IPC 压力也比 10 次/秒小很多。
        if let last = lastProgressAt[id], now - last < 0.25 {
            lock.unlock()
            return
        }
        lastProgressAt[id] = now
        lock.unlock()

        let payload: [String: Any] = [
            "type": "progress", "id": id,
            "received": p.received, "total": p.total,
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: payload),
              let js = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            // 主下载页事件 + 单曲下载按钮进度事件（am-stream.js 用后者更新 ⬇ 按钮百分比）
            let extra = "var d=" + js + ";"
                + "if(window.mine&&window.mine.__emit_onStreamDownloadProgress){"
                + "window.mine.__emit_onStreamDownloadProgress({key:d.id,received:d.received,total:d.total});}"
            Bridge.shared.webView?.evaluateJavaScript(
                "window.__amDlEvent && window.__amDlEvent(\(js));" + extra) { _, _ in }
        }
    }

    // MARK: - 推送给 UI

    private func emit() {
        let snapshot = list()
        guard let d = try? JSONSerialization.data(withJSONObject: snapshot),
              let js = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            // ⚠️ UI 期望 {type:'tasks', tasks:[...]}（2026-10-21）
            Bridge.shared.webView?.evaluateJavaScript(
                "window.__amDlEvent && window.__amDlEvent({type:'tasks', tasks:\(js)});") { _, _ in }
        }
    }
}

private extension DlTask {
    mutating func percentDone() {
        if total > 0 { received = total }
    }
}
