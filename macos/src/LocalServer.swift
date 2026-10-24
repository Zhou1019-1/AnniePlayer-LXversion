// 本地 HTTP 服务器 —— 给 WKWebView 提供 http:// 协议
//
// 为什么需要（2026-10-21）：
//   WKWebView 用 loadFileURL 加载本地文件时，file:// 协议下
//   ES module 的 import 会被 CORS 拦截（"Importing a module script failed"），
//   而洛雪 SDK 是纯 ESM 模块。
//   解法：起一个本地 HTTP 服务，让页面通过 http://127.0.0.1:PORT 访问，
//       ES module 就能正常加载了。

import Foundation
import Network

final class LocalServer {
    static let shared = LocalServer()
    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    private var rootDir: URL!

    private init() {}

    /// 启动服务器，返回端口号
    func start(rootDir: URL) throws -> UInt16 {
        self.rootDir = rootDir
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params, on: .any)
        listener = l

        let sem = DispatchSemaphore(value: 0)
        var assigned: UInt16 = 0

        l.stateUpdateHandler = { state in
            if case .ready = state {
                if let p = l.port { assigned = p.rawValue }
                sem.signal()
            }
        }
        l.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }
        l.start(queue: .global())
        _ = sem.wait(timeout: .now() + 5)
        guard assigned > 0 else { throw NSError(domain: "LocalServer", code: 1) }
        port = assigned
        return assigned
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: .global())
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
            guard let self, let data, !data.isEmpty else { conn.cancel(); return }
            let req = String(data: data, encoding: .utf8) ?? ""
            // 解析第一行：GET /path HTTP/1.1
            let first = req.split(separator: "\r\n").first.map(String.init) ?? ""
            let parts = first.split(separator: " ")
            guard parts.count >= 2 else { conn.cancel(); return }
            var path = String(parts[1])
            if path == "/" { path = "/index.html" }
            let fileURL = self.rootDir.appendingPathComponent(String(path.dropFirst()))
            self.sendFile(fileURL, on: conn)
        }
    }

    private func sendFile(_ url: URL, on conn: NWConnection) {
        guard let body = try? Data(contentsOf: url) else {
            let msg = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found"
            conn.send(content: Data(msg.utf8), completion: .contentProcessed { _ in conn.cancel() })
            return
        }
        let mime = Self.mimeType(for: url.pathExtension)
        var head = "HTTP/1.1 200 OK\r\n"
        head += "Content-Type: \(mime)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Access-Control-Allow-Origin: *\r\n"
        head += "Cache-Control: no-store, no-cache, must-revalidate\r\n"
        head += "Pragma: no-cache\r\n"
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "text/javascript; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "json":        return "application/json; charset=utf-8"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg":         return "image/svg+xml"
        case "woff", "woff2": return "font/woff2"
        case "wasm":        return "application/wasm"
        case "bin", "dat":  return "application/octet-stream"
        case "mp3":         return "audio/mpeg"
        case "m4a":         return "audio/mp4"
        default:            return "application/octet-stream"
        }
    }
}
