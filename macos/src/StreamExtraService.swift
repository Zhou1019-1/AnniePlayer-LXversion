// 在线音乐扩展服务（排行榜 / 歌单广场 / 专辑 / 热门评论）
//
// ⚠️ 为什么需要（2026-10-23）：
//   在线音乐页顶部有「排行榜 / 歌单广场 / 专辑」三个标签，待播清单还有「评论」页，
//   前端全部调用了对应 Bridge 方法，但这些方法在 dispatch 里**没有实现** →
//   点了永远是空的。这里用网易云公开 API（不需要登录）实现：
//     · 排行榜      = 网易云榜单歌单（热歌榜/新歌榜/飙升榜/原创榜）
//     · 歌单广场    = 网易云「推荐歌单」API
//     · 歌单搜索    = 网易云搜索 type=1000
//     · 歌单详情    = 网易云歌单详情 API
//     · 专辑搜索    = 网易云搜索 type=10
//     · 专辑歌曲    = 网易云专辑详情 API
//     · 热门评论    = 网易云评论 API（先按歌名+歌手搜到 songmid）
//   返回格式严格按前端 am-stream.js / am-render.js 的期望组装。

import Foundation

final class StreamExtraService {
    static let shared = StreamExtraService()

    private let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    private init() {}

    // MARK: - HTTP 基础

    private func getJSON(_ urlStr: String, timeout: TimeInterval = 20) async -> [String: Any]? {
        guard let url = URL(string: urlStr) else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.setValue(ua, forHTTPHeaderField: "User-Agent")
        req.setValue("https://music.163.com/", forHTTPHeaderField: "Referer")
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return obj
    }

    /// 网易云 track → App 内部 song 对象（provider=wy，播放走 lx SDK）
    private func toSong(_ t: [String: Any]) -> [String: Any]? {
        let id = (t["id"] as? Int).map(String.init)
            ?? (t["id"] as? NSNumber)?.stringValue
            ?? (t["id"] as? String) ?? ""
        guard !id.isEmpty else { return nil }
        let name = (t["name"] as? String) ?? ""
        // 歌手：ar 数组（新格式）或 artists（旧格式）
        var artist = ""
        if let ar = t["ar"] as? [[String: Any]], let first = ar.first {
            artist = ar.compactMap { $0["name"] as? String }.joined(separator: " / ")
            _ = first
        } else if let arts = t["artists"] as? [[String: Any]] {
            artist = arts.compactMap { $0["name"] as? String }.joined(separator: " / ")
        }
        // 专辑
        var album = ""
        var cover = ""
        if let al = t["al"] as? [String: Any] {
            album = (al["name"] as? String) ?? ""
            cover = (al["picUrl"] as? String) ?? ""
        } else if let al = t["album"] as? [String: Any] {
            album = (al["name"] as? String) ?? ""
            cover = (al["picUrl"] as? String) ?? (al["blurPicUrl"] as? String) ?? ""
        }
        // 时长（ms）
        var dur: Double = 0
        if let dt = t["dt"] as? Int { dur = Double(dt) / 1000.0 }
        else if let dt = t["duration"] as? Int { dur = Double(dt) / 1000.0 }
        else if let dt = t["dt"] as? Double { dur = dt / 1000.0 }
        return [
            "provider": "wy", "source": "wy",
            "songmid": id, "id": id,
            "name": name, "songname": name, "title": name,
            "artist": artist, "singer": artist,
            "album": album, "albumName": album,
            "cover": cover, "img": cover, "pic": cover,
            "duration": dur,
            "interval": String(Int(dur)),
        ]
    }

    // MARK: - 排行榜

    /// 内置榜单（网易云榜单 id → 名称）
    private let boards: [[String: Any]] = [
        ["bangid": "3778678", "id": "3778678", "name": "热歌榜"],
        ["bangid": "3779629", "id": "3779629", "name": "新歌榜"],
        ["bangid": "19723756", "id": "19723756", "name": "飙升榜"],
        ["bangid": "2884035", "id": "2884035", "name": "原创榜"],
        ["bangid": "3778678", "id": "3778678", "name": "本周热播"],
    ]

    func leaderboards(provider: String) -> [String: Any] {
        let list: [[String: Any]] = boards.enumerated().map { (i, b) in
            var d = b
            d["name"] = i == 4 ? "本周热播" : (b["name"] as? String ?? "")
            return d
        }
        return ["list": Array(list.prefix(4)), "provider": provider]
    }

    func leaderboardSongs(bangid: String, page: Int) async -> [String: Any] {
        guard let obj = await getJSON("https://music.163.com/api/playlist/detail?id=\(bangid)"),
              let pl = obj["result"] as? [String: Any] else {
            return ["songs": [Any](), "page": page, "allPage": 1, "total": 0]
        }
        let tracks = (pl["tracks"] as? [[String: Any]]) ?? []
        let songs = tracks.compactMap { toSong($0) }
        let limit = 200
        let start = max(0, (page - 1) * limit)
        let pageSongs = Array(songs.dropFirst(start).prefix(limit))
        return ["songs": pageSongs, "page": page,
                "allPage": max(1, Int(ceil(Double(songs.count) / Double(limit)))),
                "total": songs.count]
    }

    // MARK: - 歌单广场

    func songLists(page: Int) async -> [String: Any] {
        let limit = 30
        let offset = max(0, (page - 1) * limit)
        guard let obj = await getJSON("https://music.163.com/api/personalized/playlist?limit=\(limit)&offset=\(offset)"),
              let arr = obj["result"] as? [[String: Any]] else {
            return ["list": [Any](), "page": page, "limit": limit, "total": 0]
        }
        let list: [[String: Any]] = arr.map { p in
            [
                "id": (p["id"] as? Int).map(String.init) ?? "",
                "name": (p["name"] as? String) ?? "",
                "img": (p["picUrl"] as? String) ?? "",
                "pic": (p["picUrl"] as? String) ?? "",
                "count": (p["trackCount"] as? Int) ?? 0,
                "provider": "wy",
            ]
        }
        return ["list": list, "page": page, "limit": limit,
                "total": offset + list.count + (list.count >= limit ? limit : 0)]
    }

    func songListSearch(text: String, page: Int) async -> [String: Any] {
        let limit = 20
        let offset = max(0, (page - 1) * limit)
        let kw = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? text
        guard let obj = await getJSON(
            "https://music.163.com/api/search/get/web?s=\(kw)&type=1000&limit=\(limit)&offset=\(offset)"),
              let result = obj["result"] as? [String: Any],
              let arr = result["playlists"] as? [[String: Any]] else {
            return ["list": [Any](), "page": page, "limit": limit, "total": 0]
        }
        let list: [[String: Any]] = arr.map { p in
            [
                "id": (p["id"] as? Int).map(String.init) ?? "",
                "name": (p["name"] as? String) ?? "",
                "img": (p["coverImgUrl"] as? String) ?? "",
                "pic": (p["coverImgUrl"] as? String) ?? "",
                "count": (p["trackCount"] as? Int) ?? 0,
                "provider": "wy",
            ]
        }
        return ["list": list, "page": page, "limit": limit,
                "total": (result["playlistCount"] as? Int) ?? list.count]
    }

    func songListDetail(id: String, page: Int) async -> [String: Any] {
        guard let obj = await getJSON("https://music.163.com/api/playlist/detail?id=\(id)"),
              let pl = obj["result"] as? [String: Any] else {
            return ["songs": [Any](), "info": [String: Any](), "page": page, "total": 0]
        }
        let tracks = (pl["tracks"] as? [[String: Any]]) ?? []
        let songs = tracks.compactMap { toSong($0) }
        let info: [String: Any] = [
            "name": (pl["name"] as? String) ?? "",
            "img": (pl["coverImgUrl"] as? String) ?? "",
            "pic": (pl["coverImgUrl"] as? String) ?? "",
            "count": songs.count,
            "creator": ((pl["creator"] as? [String: Any])?["nickname"] as? String) ?? "",
        ]
        return ["songs": songs, "info": info, "page": page,
                "limit": 1000, "total": songs.count]
    }

    // MARK: - 专辑

    func albumSearch(keyword: String, page: Int, limit: Int = 20) async -> [String: Any] {
        let offset = max(0, (page - 1) * limit)
        let kw = keyword.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? keyword
        guard let obj = await getJSON(
            "https://music.163.com/api/search/get/web?s=\(kw)&type=10&limit=\(limit)&offset=\(offset)"),
              let result = obj["result"] as? [String: Any] else {
            return ["albums": [Any](), "page": page, "allPage": 1, "total": 0]
        }
        let arr = (result["albums"] as? [[String: Any]]) ?? []
        let albums: [[String: Any]] = arr.map { a in
            [
                "id": (a["id"] as? Int).map(String.init) ?? "",
                "name": (a["name"] as? String) ?? "",
                "artist": ((a["artist"] as? [String: Any])?["name"] as? String) ?? "",
                "img": (a["picUrl"] as? String) ?? "",
                "pic": (a["picUrl"] as? String) ?? "",
                "count": (a["size"] as? Int) ?? 0,
                "provider": "wy",
            ]
        }
        let total = (result["albumCount"] as? Int) ?? albums.count
        return ["albums": albums, "page": page,
                "allPage": max(1, Int(ceil(Double(total) / Double(limit)))),
                "total": total]
    }

    func albumSongs(id: String, page: Int) async -> [String: Any] {
        guard let obj = await getJSON("https://music.163.com/api/album/\(id)"),
              let album = obj["album"] as? [String: Any] else {
            return ["songs": [Any](), "info": [String: Any](), "page": page, "total": 0]
        }
        let tracks = (album["songs"] as? [[String: Any]]) ?? []
        let songs = tracks.compactMap { toSong($0) }
        let info: [String: Any] = [
            "name": (album["name"] as? String) ?? "",
            "artist": ((album["artist"] as? [String: Any])?["name"] as? String) ?? "",
            "img": (album["picUrl"] as? String) ?? "",
            "pic": (album["picUrl"] as? String) ?? "",
            "count": songs.count,
        ]
        return ["songs": songs, "info": info, "page": page, "total": songs.count]
    }

    // MARK: - 热门评论

    /// 前端参数：{songmid?, name, artist} → {ok, comments:[{text,userName,likedCount,timeStr}], total}
    func hotComments(songmid: String, name: String, artist: String) async -> [String: Any] {
        var nid = songmid
        // 没给网易云 id（比如从酷我/AM 的曲目点进来）→ 先用「歌名 + 歌手」搜一个
        if nid.isEmpty || !nid.allSatisfy({ $0.isNumber }) {
            nid = await searchNeteaseId(name: name, artist: artist)
        }
        guard !nid.isEmpty else {
            return ["ok": false, "error": "网易云没有找到这首歌", "comments": [Any](), "total": 0]
        }
        guard let obj = await getJSON(
            "https://music.163.com/api/v1/resource/comments/R_SO_4_\(nid)?limit=30&offset=0") else {
            return ["ok": false, "error": "评论接口请求失败", "comments": [Any](), "total": 0]
        }
        let hot = (obj["hotComments"] as? [[String: Any]]) ?? []
        let normal = (obj["comments"] as? [[String: Any]]) ?? []
        let merged = hot.isEmpty ? normal : hot
        let comments: [[String: Any]] = merged.prefix(30).map { c in
            var timeStr = ""
            if let t = c["time"] as? Int {
                let df = DateFormatter()
                df.dateFormat = "yyyy-MM-dd"
                timeStr = df.string(from: Date(timeIntervalSince1970: Double(t) / 1000.0))
            }
            return [
                "text": (c["content"] as? String) ?? "",
                "userName": ((c["user"] as? [String: Any])?["nickname"] as? String) ?? "匿名",
                "likedCount": (c["likedCount"] as? Int) ?? 0,
                "timeStr": timeStr,
            ]
        }
        return ["ok": true, "comments": comments,
                "total": (obj["total"] as? Int) ?? comments.count]
    }

    /// 按歌名+歌手搜网易云歌曲 id
    private func searchNeteaseId(name: String, artist: String) async -> String {
        var kw = [name, artist].filter { !$0.isEmpty }.joined(separator: " ")
        if kw.isEmpty { return "" }
        kw = kw.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? kw
        guard let obj = await getJSON(
            "https://music.163.com/api/search/get/web?s=\(kw)&type=1&limit=5&offset=0"),
              let result = obj["result"] as? [String: Any],
              let songs = result["songs"] as? [[String: Any]],
              let first = songs.first else {
            return ""
        }
        // 优先找名字精确匹配的
        let lowerName = name.lowercased()
        for s in songs {
            if let n = s["name"] as? String, n.lowercased() == lowerName {
                if let id = s["id"] as? Int { return String(id) }
                if let id = s["id"] as? NSNumber { return id.stringValue }
            }
        }
        if let id = first["id"] as? Int { return String(id) }
        if let id = first["id"] as? NSNumber { return id.stringValue }
        return ""
    }
}
