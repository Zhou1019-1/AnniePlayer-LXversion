// 在线匹配歌词 / 封面服务
//
// ⚠️ 为什么需要（2026-10-23）：
//   歌曲右键菜单「🔎 在线匹配歌词 / 封面…」调用 matchSearch / matchApply，
//   但后端 dispatch 里没有实现 → 弹窗打开后搜索永远失败、应用无反应。
//
// 流程：
//   matchSearch({path, keyword, intl})
//     → 读本地文件标签（AudioMetaService）得到 title/artist
//     → 用关键词在酷我/网易搜索候选
//     → 按「标题/艺人/时长」相似度打分排序返回
//   matchApply({path, provider, song, saveLrc, saveCover, embed, writeTags})
//     → 从候选 song 里拿 rid，下载歌词 + 封面
//     → 写 .lrc / 封面文件
//     → 可选写入文件标签（MediaTagService）

import Foundation
import AppKit

final class OnlineMatchService {
    static let shared = OnlineMatchService()

    private init() {}

    // MARK: - 搜索候选

    /// 返回 {ok, local, keyword, candidates}
    func matchSearch(path: String, keyword: String, intl: Bool) async -> [String: Any] {
        // 1. 本地元数据
        let local = AudioMetaService.shared.meta(path: path)
        let localTitle = (local["title"] as? String) ?? ""
        let localArtist = (local["artist"] as? String) ?? ""
        let localDur = (local["duration"] as? Double) ?? 0

        // 2. 关键词（为空时用「标题 + 艺人」）
        var kw = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        if kw.isEmpty {
            kw = [localTitle, localArtist].filter { !$0.isEmpty }.joined(separator: " ")
        }
        guard !kw.isEmpty else {
            return ["ok": false, "reason": "文件名里没有可用的标题/艺人，请输入关键词", "local": local]
        }

        // 3. 搜索（酷我 —— 已验证可用的官方接口）
        var all: [[String: Any]] = []
        let kwSongs = await KuwoService.shared.search(keyword: kw, page: 1, limit: 20)
        for s in kwSongs {
            var c = convert(s, provider: "kw", label: "酷我")
            c["score"] = score(candidate: c, title: localTitle,
                               artist: localArtist, dur: localDur)
            all.append(c)
        }
        // 4. 按分数降序
        all.sort { (($0["score"] as? Int) ?? 0) > (($1["score"] as? Int) ?? 0) }
        // 5. 去重（同名同艺人只留最高分）
        var seen = Set<String>()
        var out: [[String: Any]] = []
        for c in all {
            let key = "\((c["name"] as? String) ?? "")|\((c["artist"] as? String) ?? "")"
            if seen.contains(key) { continue }
            seen.insert(key)
            out.append(c)
            if out.count >= 20 { break }
        }
        return ["ok": true, "local": local, "keyword": kw, "candidates": out]
    }

    /// 把各平台的 search 结果转成匹配候选
    private func convert(_ s: [String: Any], provider: String, label: String) -> [String: Any] {
        let name = (s["name"] as? String) ?? (s["songname"] as? String) ?? ""
        let artist = (s["artist"] as? String) ?? (s["singer"] as? String) ?? ""
        let album = (s["album"] as? String) ?? (s["albumName"] as? String) ?? ""
        let cover = (s["cover"] as? String) ?? (s["img"] as? String) ?? (s["pic"] as? String) ?? ""
        var dur: Double = 0
        if let d = s["duration"] as? Double { dur = d }
        else if let d = s["duration"] as? Int { dur = Double(d) }
        else if let iv = s["interval"] as? String, let d = Double(iv) { dur = d }
        var c: [String: Any] = [
            "name": name, "artist": artist, "album": album,
            "cover": cover, "duration": dur,
            "provider": provider, "providerLabel": label,
            "song": s, "score": 0,
        ]
        if let rid = s["rid"] as? String { c["rid"] = rid }
        return c
    }

    /// 相似度打分（0~100）
    private func score(candidate c: [String: Any],
                       title: String, artist: String, dur: Double) -> Int {
        var s = 0
        let cName = ((c["name"] as? String) ?? "").lowercased()
        let cArtist = ((c["artist"] as? String) ?? "").lowercased()
        let t = title.lowercased(), a = artist.lowercased()
        if !t.isEmpty && !cName.isEmpty {
            if cName == t { s += 45 }
            else if cName.contains(t) || t.contains(cName) { s += 28 }
        }
        if !a.isEmpty && !cArtist.isEmpty {
            if cArtist == a { s += 35 }
            else if cArtist.contains(a) || a.contains(cArtist) { s += 18 }
        }
        let cd = (c["duration"] as? Double) ?? 0
        if dur > 1 && cd > 1 && abs(dur - cd) < 5 { s += 20 }
        return min(100, s)
    }

    // MARK: - 应用匹配

    /// 返回 {ok, lrc, cover, embedded, tagged, notes}
    func matchApply(_ payload: [String: Any]) async -> [String: Any] {
        guard let path = payload["path"] as? String, !path.isEmpty else {
            return ["ok": false, "reason": "缺少文件路径"]
        }
        guard FileManager.default.fileExists(atPath: path) else {
            return ["ok": false, "reason": "文件不存在"]
        }
        let provider = (payload["provider"] as? String) ?? "kw"
        let song = (payload["song"] as? [String: Any]) ?? [:]
        let saveLrc = (payload["saveLrc"] as? Bool) ?? true
        let saveCover = (payload["saveCover"] as? Bool) ?? true
        let embed = (payload["embed"] as? Bool) ?? false
        let writeTags = (payload["writeTags"] as? Bool) ?? false

        let dir = (path as NSString).deletingLastPathComponent
        let stem = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        var notes: [String] = []
        var lrcText: String? = nil
        var coverPath: String? = nil

        // 1. 歌词
        //    ⚠️ 2026-10-23：改用 SourceAPI.shared.lyric（和播放页歌词走同一条已验证的链路）。
        //    原来用 KuwoService.shared.lyric(rid:) 的老接口 m.kuwo.cn/newh5/... 已失效，
        //    导致「在线匹配」里歌词永远拿不到。
        if saveLrc {
            let lyArgs: [String: Any] = ["provider": provider, "song": song]
            if let ly = await SourceAPI.shared.lyric(args: [lyArgs]) as? [String: Any],
               let lrc = ly["lrc"] as? String, !lrc.isEmpty {
                lrcText = lrc
                let lrcFile = (dir as NSString).appendingPathComponent("\(stem).lrc")
                try? lrc.write(toFile: lrcFile, atomically: true, encoding: .utf8)
                notes.append("歌词已存 .lrc")
            } else {
                notes.append("没能拿到歌词（该平台无版权或接口失败）")
            }
        }

        // 2. 封面（先用 SourceAPI.picture 拿官方大图，失败再退回 song.cover）
        if saveCover {
            var coverURL = ((song["cover"] as? String) ?? (song["img"] as? String)
                            ?? (song["pic"] as? String) ?? "")
            let picArgs: [String: Any] = ["provider": provider, "song": song]
            if let pc = await SourceAPI.shared.picture(args: [picArgs]) as? [String: Any],
               let cu = pc["url"] as? String, !cu.isEmpty {
                coverURL = cu
            }
            // ⚠️ 2026-10-23：酷我封面 CDN 需要 UA/Referer，裸 URLSession 会被拒。
            var coverData: Data? = nil
            if !coverURL.isEmpty, let url = URL(string: coverURL) {
                var creq = URLRequest(url: url)
                creq.timeoutInterval = 20
                creq.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                              + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
                              forHTTPHeaderField: "User-Agent")
                creq.setValue("https://www.kuwo.cn/", forHTTPHeaderField: "Referer")
                if let (d, resp) = try? await URLSession.shared.data(for: creq),
                   (resp as? HTTPURLResponse)?.statusCode == 200, d.count > 1000 {
                    coverData = d
                }
            }
            if let data = coverData, data.count > 1000 {
                // 用魔数判断 jpg / png
                let isPNG = data.count > 8 && data[0] == 0x89 && data[1] == 0x50
                let ext = isPNG ? "png" : "jpg"
                let cf = (dir as NSString).appendingPathComponent("\(stem).\(ext)")
                try? data.write(to: URL(fileURLWithPath: cf))
                coverPath = cf
                notes.append("封面已存 .\(ext)")
            } else {
                notes.append("没能拿到封面")
            }
        }

        // 3. 写标签（embed / writeTags 都走 ffmpeg 写文件标签）
        var tagged = false
        if writeTags || embed {
            var fields: [String: Any] = ["path": path]
            if let n = song["name"] as? String, !n.isEmpty { fields["title"] = n }
            if let ar = song["artist"] as? String, !ar.isEmpty { fields["artist"] = ar }
            if let al = song["album"] as? String, !al.isEmpty { fields["album"] = al }
            if let cover = coverPath { fields["coverFile"] = cover }
            let r = MediaTagService.shared.tagEdit(fields)
            tagged = (r["ok"] as? Bool) ?? false
            if !tagged, let reason = r["reason"] as? String {
                notes.append("标签写入失败：\(reason)")
            } else if tagged {
                notes.append("已写入曲目标签")
            }
        }

        // ⚠️ 2026-10-23：把匹配到的标题/歌手/专辑回填到资料库记录。
        //    下载的裸音频文件往往没有专辑标签（library.json 里 album 是空串），
        //    歌曲列表的「专辑」列就一直空着。这里借在线匹配顺手补上。
        LibraryStore.shared.updateTrackMeta(
            path: path,
            title: song["name"] as? String,
            artist: song["artist"] as? String,
            album: song["album"] as? String)

        return ["ok": true, "lrc": lrcText != nil, "cover": coverPath != nil,
                "tagged": tagged, "embedded": tagged, "notes": notes]
    }
}
