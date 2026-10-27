// 下载管理 —— 把歌曲下载到本地
//
// 支持两种来源：
//   1. Apple Music：走 /m3u8 + wasm 解密，输出 ALAC（由 SourceAPI 处理）
//   2. 其他平台：走音源脚本拿直接下载地址，HTTP 下载
//
// 功能：
//   · 进度回调（推给 UI）
//   · 歌词保存（.lrc 同名文件）
//   · 封面保存（.jpg 同名文件）

import Foundation

/// 下载进度
struct DownloadProgress {
    let received: Int64
    let total: Int64
    let percent: Int
}

final class DownloadManager {
    static let shared = DownloadManager()

    /// 下载目录
    var dir: URL {
        if let s = UserDefaults.standard.string(forKey: "dl.dir"), !s.isEmpty {
            return URL(fileURLWithPath: s)
        }
        let u = FileManager.default.urls(for: .musicDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("安妮播放器")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    private init() {}

    /// 设下载目录
    func setDir(_ path: String) {
        UserDefaults.standard.set(path, forKey: "dl.dir")
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    /// 计算下载目录里的唯一目标路径（供 AM 等「已经拿到文件」的流程复用命名规则）
    func uniqueTarget(name: String, singer: String, ext: String) -> URL {
        let safeName = sanitize(name)
        let safeArtist = sanitize(singer)
        var baseName = safeArtist.isEmpty ? safeName : "\(safeArtist) - \(safeName)"
        if baseName.isEmpty { baseName = "未命名" }
        return uniqueURL(baseName: baseName, ext: ext)
    }

    /// 下载一首歌
    func download(url: String, name: String, singer: String, album: String = "",
                  ext: String = "mp3", headers: [String: String] = [:],
                  lrc: String? = nil, coverURL: String? = nil,
                  progress: ((DownloadProgress) -> Void)? = nil) async throws -> URL {
        // ATS：http → https
        var fixed = url
        if fixed.hasPrefix("http://") { fixed = "https://" + fixed.dropFirst(7) }
        guard let u = URL(string: fixed) else {
            throw NSError(domain: "Download", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "无效地址"])
        }

        // 文件名
        let safeName = sanitize(name)
        let safeArtist = sanitize(singer)
        var baseName = safeArtist.isEmpty ? safeName : "\(safeArtist) - \(safeName)"
        if baseName.isEmpty { baseName = "未命名" }
        let target = uniqueURL(baseName: baseName, ext: ext)

        // 下载（带进度）
        let data = try await fetchWithProgress(url: u, headers: headers, progress: progress)
        guard data.count > 10_000 else {
            throw NSError(domain: "Download", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "文件太小（\(data.count) 字节）"])
        }
        try data.write(to: target)

        // 歌词（同名 .lrc）
        if let lrc, !lrc.isEmpty {
            let lrcURL = target.deletingPathExtension().appendingPathExtension("lrc")
            try? lrc.write(to: lrcURL, atomically: true, encoding: .utf8)
        }
        // 封面（同名 .jpg）
        if let coverURL, !coverURL.isEmpty, let cu = URL(string: coverURL) {
            if let (cd, resp) = try? await URLSession.shared.data(from: cu),
               let http = resp as? HTTPURLResponse, http.statusCode == 200, cd.count > 1000 {
                let ext2 = coverURL.contains(".png") ? "png" : "jpg"
                let coverFile = target.deletingPathExtension().appendingPathExtension(ext2)
                try? cd.write(to: coverFile)
            }
        }
        return target
    }

    // MARK: - 带进度的下载

    private func fetchWithProgress(url: URL, headers: [String: String],
                                   progress: ((DownloadProgress) -> Void)?) async throws -> Data {
        var req = URLRequest(url: url)
        req.timeoutInterval = 120
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if req.value(forHTTPHeaderField: "User-Agent") == nil {
            req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
                         forHTTPHeaderField: "User-Agent")
        }
        // ⚠️ 用 downloadTask（2026-10-21）：
        //    bytes(for:) 在酷我/网易云 CDN 上会挂起不返回。
        return try await withCheckedThrowingContinuation { cont in
            let task = URLSession.shared.downloadTask(with: req) { tmp, resp, err in
                if let err { cont.resume(throwing: err); return }
                guard let http = resp as? HTTPURLResponse else {
                    cont.resume(throwing: NSError(domain: "Download", code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "无响应"])); return
                }
                guard http.statusCode == 200 else {
                    cont.resume(throwing: NSError(domain: "Download", code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"])); return
                }
                guard let tmp, let d = try? Data(contentsOf: tmp) else {
                    cont.resume(throwing: NSError(domain: "Download", code: 4,
                        userInfo: [NSLocalizedDescriptionKey: "读取临时文件失败"])); return
                }
                progress?(DownloadProgress(received: Int64(d.count),
                                           total: Int64(d.count), percent: 100))
                cont.resume(returning: d)
            }
            var lastReport = Date.distantPast
            let obs = task.progress.observe(\.fractionCompleted) { pr, _ in
                guard Date().timeIntervalSince(lastReport) > 0.2 else { return }
                lastReport = Date()
                progress?(DownloadProgress(
                    received: task.countOfBytesReceived,
                    total: task.countOfBytesExpectedToReceive,
                    percent: Int(pr.fractionCompleted * 100)))
            }
            _ = obs
            task.resume()
        }
    }

    // MARK: - 工具

    private func uniqueURL(baseName: String, ext: String) -> URL {
        let target = dir.appendingPathComponent("\(baseName).\(ext)")
        if !FileManager.default.fileExists(atPath: target.path) { return target }
        var n = 1
        while true {
            let f = dir.appendingPathComponent("\(baseName) (\(n)).\(ext)")
            if !FileManager.default.fileExists(atPath: f.path) { return f }
            n += 1
        }
    }

    private func sanitize(_ s: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|\n\r\t")
        return s.components(separatedBy: bad).joined()
                .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
