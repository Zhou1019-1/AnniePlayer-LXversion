// 音乐库数据层 —— 收藏 + 歌单（本地 / 在线）
//
// UI 契约（从 am-dom.js / am-stream.js 反推）：
//   收藏
//     toggleFavorite(path)        → [String]  返回**收藏路径数组**（UI 直接 new Set(...)）
//     favorites()                 → [String]
//   本地歌单（路径列表）
//     playlistCreate(name)        → [Playlist]  名字重复时返回已有
//     playlists()                 → [Playlist]
//     playlistAdd(plId, paths, before?, dedupe?)  → [Playlist]
//     playlistRemove(plId, paths) → [Playlist]
//     playlistRename(plId, name)  → [Playlist]
//     playlistDelete(plId)        → [Playlist]
//     playlistReorder(plId, from, to)        → [Playlist]
//     playlistReorderList(ids)    → [Playlist]
//   Playlist = { id, name, paths: [String], count }
//   在线歌单（歌曲对象列表）
//     splCreate(name) / splAdd(plId, songs) / splRemove / splRename / splDelete / splList
//
// 持久化：Application Support/AnnieMac/library.json

import Foundation

/// 歌单（本地：存路径；在线：存歌曲对象）
struct LibraryPlaylist {
    let id: String
    var name: String
    var paths: [String]        // 本地歌单
    var songs: [[String: Any]] // 在线歌单

    func toJSON() -> [String: Any] {
        ["id": id, "name": name, "paths": paths,
         "songs": songs, "count": paths.count + songs.count]
    }
    /// 给本地歌单 UI 用（只有 paths）
    func toLocalJSON() -> [String: Any] {
        ["id": id, "name": name, "paths": paths, "count": paths.count]
    }
    /// ⚠️ 2026-10-22：在线歌单 UI 期望 items = [{song: {...}, provider: "..."}]
    ///   （am-stream.js 里到处是 pl.items[i].song / pl.items.map(x => x.song)）
    ///   之前只返回 songs，导致 openSplPicker 里 pl.items.length 抛异常 → 收藏弹窗打不开。
    func toSplJSON() -> [String: Any] {
        let items: [[String: Any]] = songs.map { s in
            ["song": s, "provider": (s["provider"] as? String) ?? ""]
        }
        return ["id": id, "name": name, "items": items,
                "songs": songs, "count": items.count]
    }
}

final class LibraryStore {
    static let shared = LibraryStore()

    private var favPaths: [String] = []          // 收藏的本地路径
    private var favSongs: [[String: Any]] = []    // 收藏的在线歌曲
    private var tracks: [[String: Any]] = []       // 已下载的曲目（资料库）
    private var localPLs: [LibraryPlaylist] = []  // 本地歌单
    private var onlinePLs: [LibraryPlaylist] = [] // 在线歌单
    private let lock = NSLock()
    private var seq = 0

    private init() { load() }

    // MARK: - 持久化

    private var fileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory,
                                            in: .userDomainMask)[0]
            .appendingPathComponent("AnnieMac")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("library.json")
    }

    private func load() {
        guard let d = try? Data(contentsOf: fileURL),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
        favPaths = (o["favorites"] as? [String]) ?? []
        favSongs = (o["favSongs"] as? [[String: Any]]) ?? []
        tracks = (o["tracks"] as? [[String: Any]]) ?? []
        localPLs = decodePLs(o["localPlaylists"])
        onlinePLs = decodePLs(o["onlinePlaylists"])
        seq = (o["seq"] as? Int) ?? 0
    }

    private func decodePLs(_ v: Any?) -> [LibraryPlaylist] {
        guard let arr = v as? [[String: Any]] else { return [] }
        return arr.compactMap { d in
            guard let id = d["id"] as? String, let name = d["name"] as? String else { return nil }
            return LibraryPlaylist(id: id, name: name,
                                   paths: (d["paths"] as? [String]) ?? [],
                                   songs: (d["songs"] as? [[String: Any]]) ?? [])
        }
    }

    private func save() {
        let o: [String: Any] = [
            "favorites": favPaths,
            "favSongs": favSongs,
            "tracks": tracks,
            "localPlaylists": localPLs.map { $0.toJSON() },
            "onlinePlaylists": onlinePLs.map { $0.toJSON() },
            "seq": seq,
        ]
        if let d = try? JSONSerialization.data(withJSONObject: o) {
            try? d.write(to: fileURL)
        }
    }

    private func nextId(_ prefix: String) -> String {
        seq += 1
        return "\(prefix)-\(Int(Date().timeIntervalSince1970))-\(seq)"
    }

    // MARK: - 音乐库快照（getLibrary）
    //
    // UI（player.js:57）启动时调 getLibrary() 拿到整个库对象，从中读：
    //   favorites / tracks / folders / metaCache / volume / backend / ui ...
    // 我们目前只支持「在线音乐」，不扫描本地文件夹，所以 tracks/folders 为空，
    // 但 favorites 必须返回，否则「喜爱歌曲」界面永远是空的。
    func librarySnapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        // ⚠️ 2026-10-24：旧版本入库的曲目没有 dir 字段（前端会崩），
        //   返回快照时统一补齐（只改返回值，不改磁盘数据）。
        let fixedTracks: [[String: Any]] = tracks.map { tr in
            var m = tr
            if (m["dir"] as? String) == nil, let p = m["path"] as? String {
                m["dir"] = (p as NSString).deletingLastPathComponent
            }
            return m
        }
        return [
            "favorites": favPaths,
            "tracks": fixedTracks,
            "folders": [] as [Any],
            "metaCache": [:] as [String: Any],
            "volume": 0.8,
            "backend": "avplayer",
            "ui": [:],
            "_pendingMigration": false,
            "_pendingRescan": false,
        ]
    }

    // MARK: - 资料库曲目（下载完成后入库）

    /// 把下载好的文件加入资料库。已存在同 path 则更新。
    /// track 结构（与 UI 期望一致）：
    ///   {path, name, title, artist, album, dur, size, addedAt}
    func addTrack(_ d: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        guard let path = d["path"] as? String, !path.isEmpty else { return }
        // ⚠️ 2026-10-24 修复「FB2K 曲目列表空白」：
        //   前端 tagOf() 用 t.dir 推导艺术家/专辑，缺 dir 会抛 TypeError
        //   → 整个列表渲染中断。必须在入库时就带上 dir（文件所在目录）。
        let dir = (path as NSString).deletingLastPathComponent
        var info: [String: Any] = [
            "path": path,
            "name": d["name"] ?? "",
            "title": d["title"] ?? d["name"] ?? "",
            "artist": d["artist"] ?? "",
            "album": d["album"] ?? "",
            "dur": d["dur"] ?? 0,
            "size": d["size"] ?? 0,
            "addedAt": Int(Date().timeIntervalSince1970),
            "provider": d["provider"] ?? "",
            "dir": dir,
        ]
        if let i = tracks.firstIndex(where: { ($0["path"] as? String) == path }) {
            tracks[i] = info
        } else {
            tracks.append(info)
        }
        save()
    }

    /// 移除资料库曲目（不删文件）
    func removeTrack(path: String) {
        lock.lock(); defer { lock.unlock() }
        tracks.removeAll { ($0["path"] as? String) == path }
        save()
    }

    /// 更新曲目元信息（在线匹配后回填专辑/歌手/标题）
    func updateTrackMeta(path: String, title: String?, artist: String?, album: String?) {
        lock.lock(); defer { lock.unlock() }
        guard let i = tracks.firstIndex(where: { ($0["path"] as? String) == path }) else { return }
        if let v = title, !v.isEmpty { tracks[i]["title"] = v; tracks[i]["name"] = v }
        if let v = artist, !v.isEmpty { tracks[i]["artist"] = v }
        if let v = album, !v.isEmpty { tracks[i]["album"] = v }
        save()
    }

    /// 从所有歌单中移除指定路径（删除/隐藏歌曲时调用，避免歌单里留下死引用）
    func purgeFromPlaylists(paths: [String]) {
        lock.lock(); defer { lock.unlock() }
        guard !paths.isEmpty else { return }
        var changed = false
        for i in localPLs.indices {
            let before = localPLs[i].paths.count
            localPLs[i].paths.removeAll { paths.contains($0) }
            if localPLs[i].paths.count != before { changed = true }
        }
        if changed { save() }
    }

    func trackCount() -> Int {
        lock.lock(); defer { lock.unlock() }
        return tracks.count
    }

    // MARK: - 收藏

    /// toggleFavorite(path) → [String] 收藏路径数组
    /// 也支持传入在线歌曲对象 {song: {...}} 或 {path, name, artist...}
    func toggleFavorite(_ arg: Any?) -> [String] {
        lock.lock(); defer { lock.unlock() }
        if let s = arg as? String, !s.isEmpty {
            if let i = favPaths.firstIndex(of: s) {
                favPaths.remove(at: i)
            } else {
                favPaths.append(s)
            }
        } else if let d = arg as? [String: Any] {
            let path = (d["path"] as? String) ?? ""
            let song = (d["song"] as? [String: Any]) ?? d
            let sid = Bridge.songIdentity(song)
            if !path.isEmpty {
                if let i = favPaths.firstIndex(of: path) { favPaths.remove(at: i) }
                else { favPaths.append(path) }
            } else if !sid.isEmpty {
                if let i = favSongs.firstIndex(where: { Bridge.songIdentity($0) == sid }) {
                    favSongs.remove(at: i)
                } else {
                    favSongs.append(song)
                }
            }
        }
        save()
        return favPaths
    }

    func favorites() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return favPaths
    }

    func favoriteSongs() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return favSongs
    }

    // MARK: - 本地歌单

    func playlistCreate(_ name: String) -> [[String: Any]] {
        lock.lock()
        let trim = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalName = trim.isEmpty ? "新建歌单" : trim
        // 同名已存在 → 直接返回（UI 期望这样）
        if !localPLs.contains(where: { $0.name == finalName }) {
            localPLs.append(LibraryPlaylist(id: nextId("pl"), name: finalName,
                                            paths: [], songs: []))
            save()
        }
        let snap = localPLs.map { $0.toLocalJSON() }
        lock.unlock()
        return snap
    }

    func playlists() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return localPLs.map { $0.toLocalJSON() }
    }

    /// playlistAdd(plId, paths, beforePath?, dedupe?)
    func playlistAdd(plId: String, paths: [String], before: String? = nil,
                     dedupe: Bool = false) -> [[String: Any]] {
        lock.lock()
        if let i = localPLs.firstIndex(where: { $0.id == plId }) {
            var cur = localPLs[i].paths
            var toAdd = paths
            if dedupe { toAdd = toAdd.filter { !cur.contains($0) } }
            if let b = before, let bi = cur.firstIndex(of: b) {
                cur.insert(contentsOf: toAdd, at: bi)
            } else {
                cur.append(contentsOf: toAdd)
            }
            localPLs[i].paths = cur
            save()
        }
        let snap = localPLs.map { $0.toLocalJSON() }
        lock.unlock()
        return snap
    }

    func playlistRemove(plId: String, paths: [String]) -> [[String: Any]] {
        lock.lock()
        if let i = localPLs.firstIndex(where: { $0.id == plId }) {
            localPLs[i].paths.removeAll { paths.contains($0) }
            save()
        }
        let snap = localPLs.map { $0.toLocalJSON() }
        lock.unlock()
        return snap
    }

    func playlistRename(plId: String, name: String) -> [[String: Any]] {
        lock.lock()
        let trim = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trim.isEmpty, let i = localPLs.firstIndex(where: { $0.id == plId }) {
            localPLs[i].name = trim
            save()
        }
        let snap = localPLs.map { $0.toLocalJSON() }
        lock.unlock()
        return snap
    }

    func playlistDelete(plId: String) -> [[String: Any]] {
        lock.lock()
        localPLs.removeAll { $0.id == plId }
        save()
        let snap = localPLs.map { $0.toLocalJSON() }
        lock.unlock()
        return snap
    }

    func playlistReorder(plId: String, from: Int, to: Int) -> [[String: Any]] {
        lock.lock()
        if let i = localPLs.firstIndex(where: { $0.id == plId }) {
            var p = localPLs[i].paths
            if from >= 0, from < p.count, to >= 0, to <= p.count {
                let item = p.remove(at: from)
                p.insert(item, at: min(to, p.count))
                localPLs[i].paths = p
                save()
            }
        }
        let snap = localPLs.map { $0.toLocalJSON() }
        lock.unlock()
        return snap
    }

    func playlistReorderList(_ ids: [String]) -> [[String: Any]] {
        lock.lock()
        var map: [String: LibraryPlaylist] = [:]
        for p in localPLs { map[p.id] = p }
        var ordered: [LibraryPlaylist] = ids.compactMap { map[$0] }
        for p in localPLs where !ids.contains(p.id) { ordered.append(p) }
        localPLs = ordered
        save()
        let snap = localPLs.map { $0.toLocalJSON() }
        lock.unlock()
        return snap
    }

    // MARK: - 在线歌单

    func splCreate(_ name: String) -> [[String: Any]] {
        lock.lock()
        let trim = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalName = trim.isEmpty ? "新建在线歌单" : trim
        if !onlinePLs.contains(where: { $0.name == finalName }) {
            onlinePLs.append(LibraryPlaylist(id: nextId("spl"), name: finalName,
                                             paths: [], songs: []))
            save()
        }
        let snap = onlinePLs.map { $0.toSplJSON() }
        lock.unlock()
        return snap
    }

    func splList() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return onlinePLs.map { $0.toSplJSON() }
    }

    func splAdd(plId: String, songs: [[String: Any]]) -> [String: Any] {
        lock.lock()
        guard let i = onlinePLs.firstIndex(where: { $0.id == plId }) else {
            lock.unlock()
            return ["ok": false, "added": 0]
        }
        var cur = onlinePLs[i].songs
        var added = 0, skipped = 0
        for s in songs {
            let id = Bridge.songIdentity(s)
            if !id.isEmpty, cur.contains(where: { Bridge.songIdentity($0) == id }) {
                skipped += 1
            } else {
                cur.append(s); added += 1
            }
        }
        onlinePLs[i].songs = cur
        save()
        let pl = onlinePLs[i]
        lock.unlock()
        return ["ok": true, "added": added, "skipped": skipped,
                "id": pl.id, "name": pl.name,
                "playlists": onlinePLs.map { $0.toSplJSON() }]
    }

    func splRemove(plId: String, ids: [String]) -> [[String: Any]] {
        lock.lock()
        if let i = onlinePLs.firstIndex(where: { $0.id == plId }) {
            onlinePLs[i].songs.removeAll { Bridge.songIdentity($0).isEmpty ? false : ids.contains(Bridge.songIdentity($0)) }
            save()
        }
        let snap = onlinePLs.map { $0.toSplJSON() }
        lock.unlock()
        return snap
    }

    func splRename(plId: String, name: String) -> [[String: Any]] {
        lock.lock()
        let trim = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trim.isEmpty, let i = onlinePLs.firstIndex(where: { $0.id == plId }) {
            onlinePLs[i].name = trim
            save()
        }
        let snap = onlinePLs.map { $0.toSplJSON() }
        lock.unlock()
        return snap
    }

    func splDelete(plId: String) -> [[String: Any]] {
        lock.lock()
        onlinePLs.removeAll { $0.id == plId }
        save()
        let snap = onlinePLs.map { $0.toSplJSON() }
        lock.unlock()
        return snap
    }
}
