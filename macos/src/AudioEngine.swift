// 音频引擎 —— 用 AVPlayer 替代原来的 AnnieEngine
//
// 他们的 UI 通过 window.mine.engine({cmd: '...', ...}) 控制播放。
// 这里把这些命令翻译成 AVPlayer 操作。
//
// 命令格式（从他们的代码推断）：
//   engine({cmd: 'play', path: '...'})
//   engine({cmd: 'pause'})
//   engine({cmd: 'stop'})
//   engine({cmd: 'seek', position: 12.5})
//   engine({cmd: 'volume', volume: 0.8})

import Foundation
import AppKit
import AVFoundation
import MediaPlayer

@MainActor
final class AudioEngine: ObservableObject {
    static let shared = AudioEngine()

    private var player: AVPlayer?
    private var timeObserver: Any?
    @Published var isPlaying = false
    @Published var currentTime: Double = 0
    @Published var duration: Double = 0
    @Published var currentPath: String = ""

    private init() {
        setupRemoteCommands()
    }

    // MARK: - 处理 UI 命令

    func handle(args: [Any]) async -> Any? {
        // ⚠️ 他们的调用格式是 engine(method, params, timeout)（2026-10-21）：
        //    第一个参数是**方法名字符串**，第二个是参数对象。
        //    例如：engine('play', {path: '...'}, 30000)
        let cmd = (args.first as? String) ?? ""
        let d = (args.count > 1 ? args[1] as? [String: Any] : nil) ?? [:]
        fputs("AudioEngine.handle: cmd=\(cmd) args=\(String(describing: args).prefix(200))\n", stderr)

        switch cmd {
        case "play", "load", "play.crossfade":
            // ⚠️ 他们还会用 play.crossfade（2026-10-21）：
            //    有交叉淡入设置时走这个方法，参数和 play 一样。
            let path = (d["path"] as? String) ?? (d["url"] as? String) ?? ""
            fputs("AudioEngine play: path=\(path.prefix(80))\n", stderr)
            if !path.isEmpty { play(path: path) }
            return ["ok": true]

        case "pause":
            player?.pause(); isPlaying = false
            emit("state", ["state": "paused"])
            return ["ok": true]

        case "resume":
            player?.play(); isPlaying = true
            emit("state", ["state": "playing"])
            return ["ok": true]

        case "stop":
            stop()
            emit("state", ["state": "stopped"])
            return ["ok": true]

        case "seek":
            // 真实电平表跟随 seek 重新定位解码器
            let sk = (d["position"] as? Double) ?? (d["seconds"] as? Double) ?? 0
            LRMeter.shared.seek(to: sk)
            // ⚠️ 参数名是 seconds（2026-10-21）：
            //    之前读 position/pos，全是 nil → seek 到 0 → 表现为「点进度条重新播放」。
            var pos = (d["seconds"] as? Double)
                   ?? (d["position"] as? Double) ?? (d["pos"] as? Double) ?? 0
            if pos < 0 { pos = 0 }
            fputs("AudioEngine seek → \(pos)s\n", stderr)
            await player?.seek(to: CMTime(seconds: pos, preferredTimescale: 600),
                               toleranceBefore: .zero, toleranceAfter: .zero)
            // seek 后立即推一次位置，让歌词/进度条同步
            self.currentTime = pos
            emit("position", ["seconds": pos, "duration": self.duration])
            return ["ok": true]

        case "volume":
            let v = (d["volume"] as? Double) ?? 1.0
            player?.volume = Float(v)
            return ["ok": true]

        case "devices.list", "devices":
            // mac 上不区分设备，返回默认输出
            return [["id": "default", "name": "系统默认输出", "default": true]]

        case "state", "status":
            fputs("AudioEngine state → playing=\(isPlaying) pos=\(currentTime)\n", stderr)
            return ["ok": true, "playing": isPlaying, "position": currentTime,
                    "duration": duration, "path": currentPath]
        case "loud.set", "loud.get":
            return ["ok": true]
        case "devices.select":
            return ["ok": true]
        case "output.list", "devices.list":
            return [["id": "default", "name": "系统默认输出", "default": true]]

        default:
            return ["ok": true]
        }
    }

    // MARK: - 播放控制

    func play(path: String) {
        let url: URL
        if path.hasPrefix("file://") {
            url = URL(string: path) ?? URL(fileURLWithPath: path)
        } else if path.hasPrefix("/") {
            url = URL(fileURLWithPath: path)
        } else if path.hasPrefix("http") {
            url = URL(string: path) ?? URL(fileURLWithPath: path)
        } else {
            return
        }

        stop()
        currentPath = path

        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        player = p

        // ⚠️ 2026-10-23：启动真实 L/R 声道电平表（并行解码 PCM，不影响播放）
        LRMeter.shared.start(path: path, at: 0)

        // ⚠️ 关键（2026-10-21）：必须推送 position 和 state 事件给 UI，
        //    否则播放器页面没有进度条、没有时长、没有歌词滚动。
        //    ⚠️ 0.1 秒（不是 0.25）——推送太慢歌词滚动会一顿一顿的；
        //       他们的 UI 有 rAF 插值，但起点太稀也会显得不自然。
        let interval = CMTime(seconds: 0.1, preferredTimescale: 600)
        timeObserver = p.addPeriodicTimeObserver(forInterval: interval,
                                                 queue: .main) { [weak self] t in
            guard let self else { return }
            self.currentTime = t.seconds
            if let d = p.currentItem?.duration.seconds, d.isFinite, d > 0 {
                self.duration = d
            }
            // 每 5 秒刷新一次控制中心的进度（太频繁会浪费 CPU）
            self._npTick = (self._npTick ?? 0) + 1
            if self._npTick ?? 0 >= 50 {
                self._npTick = 0
                self.updateNowPlaying()
            }
            self.emit("position", [
                "seconds": self.currentTime,
                "duration": self.duration,
            ])
            // 真实左右声道电平（每 100ms 随位置事件一起推）
            let lr = LRMeter.shared.tick()
            self._lrTickCount = (self._lrTickCount ?? 0) + 1
            if self._lrTickCount ?? 0 % 20 == 1 {
                fputs("[LR] tick L=\(String(format: "%.3f", lr.l)) R=\(String(format: "%.3f", lr.r))\n", stderr)
            }
            self.emit("lrlevel", ["l": lr.l, "r": lr.r])
            self.pushProgress()
        }

        // 监听播放状态变化
        NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item, queue: .main) { [weak self] _ in
                self?.emit("state", ["state": "ended"])
        }

        p.play()
        isPlaying = true

        // ⚠️ 自动跳过 Apple HLS 的时间轴偏移（2026-10-21）：
        //    Apple 的 ALAC 文件整体时间轴从「首片 tfdt」开始（通常是 14.95 秒），
        //    音频内容本身从那之后才有声音，但 AVPlayer 会先把这 15 秒静音播出来，
        //    表现为「AM 的歌从第 15 秒开始」+ 歌词整体错位。
        //    修法：加载后检测起始时间（item 的 start/首个可播位置），自动 seek 过去。
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let item = self.player?.currentItem else { return }
            let d = item.duration.seconds
            let cur = item.currentTime().seconds
            // 从文件元数据读 startOffset（写入时记录在 XMP 里太复杂，
            // 这里用「时长和实际音频轨道时长对比」推断）
            var offset: Double = 0
            if let asset = item.asset as? AVURLAsset {
                // 读第一个音频轨的 timeRange
                do {
                    let tracks = try await asset.loadTracks(withMediaType: .audio)
                    if let t = tracks.first {
                        let range = try await t.load(.timeRange)
                        offset = range.start.seconds
                    }
                } catch {}
            }
            fputs("播放起点: duration=\(d) current=\(cur) trackStart=\(offset)\n", stderr)
            if offset > 1, cur < offset - 0.3 {
                await self.player?.seek(to: CMTime(seconds: offset, preferredTimescale: 600),
                                        toleranceBefore: .zero, toleranceAfter: .zero)
                fputs("已自动跳转到 \(offset) 秒（跳过时间轴偏移）\n", stderr)
            }
        }
        emit("state", ["state": "playing"])
        // ⚠️ 2026-10-23 修复「资料库显示 FLAC 但播放器显示 MP3」：
        //   原来这里硬编码 codec: "mp3" —— 播放 FLAC/ALAC 也显示 MP3。
        //   现在从文件真实格式读（AVAssetTrack.formatDescriptions），
        //   并补上 requestedRate（前端 refreshBadge 用它显示 kHz）。
        emitRealFormat(path: path)
        emit("backend", ["kind": "coreaudio", "name": "CoreAudio"])
        updateNowPlaying()
    }

    func stop() {
        LRMeter.shared.stop()
        if let o = timeObserver, let p = player {
            p.removeTimeObserver(o)
        }
        timeObserver = nil
        player?.pause()
        player = nil
        isPlaying = false
        currentTime = 0
        duration = 0
    }

    func retry() {
        if !currentPath.isEmpty { play(path: currentPath) }
    }

    // MARK: - 状态推送

    var statusDict: [String: Any] {
        [
            "ok": true,
            "playing": isPlaying,
            "position": currentTime,
            "duration": duration,
            "path": currentPath,
        ]
    }

    var progressDict: [String: Any] {
        ["position": currentTime, "duration": duration, "playing": isPlaying]
    }

    /// 推送引擎事件给 UI
    func emit(_ event: String, _ data: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: data),
              let s = String(data: d, encoding: .utf8) else { return }
        let js = "window.__engineEmit && window.__engineEmit(\"\(event)\", \(s));"
        Bridge.shared.webView?.evaluateJavaScript(js) { _, _ in }
    }

    /// 把进度推给 UI
    private func pushProgress() {
        let js = "window.__mineEmit && window.__mineEmit('playerProgress', " +
                 "\(jsonString(progressDict)));"
        Bridge.shared.webView?.evaluateJavaScript(js)
    }

    private func jsonString(_ d: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: d),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }

    // MARK: - 系统媒体控制

    var _npTick: Int?
    var _lrTickCount: Int?

    /// 读取文件真实音频格式并推给前端（编码/位深/采样率/声道/码率）
    private func emitRealFormat(path: String) {
        var payload: [String: Any] = [
            "codec": "unknown", "sampleRate": 44100, "requestedRate": 44100,
            "bitDepth": 16, "channels": 2,
        ]
        // 快速路径：已知扩展名先给个兜底
        let ext = (path as NSString).pathExtension.lowercased()
        let extCodec: String? = ["flac": "FLAC", "m4a": "ALAC", "mp3": "MP3",
                                 "aac": "AAC", "wav": "PCM", "aiff": "PCM",
                                 "dsf": "DSD", "dff": "DSD"][ext]
        if let c = extCodec { payload["codec"] = c }
        // 精确读取（后台，避免阻塞播放）
        let p = path
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let full = AudioMetaService.shared.metaFullBatch([p])
            var out = payload
            if let info = full[p] {
                if let c = info["codec"] as? String, !c.isEmpty {
                    out["codec"] = Self.friendlyCodec(c, fallbackExt: ext)
                }
                if let r = info["sampleRate"] as? Double, r > 0 {
                    out["sampleRate"] = r
                    out["requestedRate"] = r
                }
                if let b = info["bitDepth"] as? Int, b > 0 { out["bitDepth"] = b }
                if let ch = info["channels"] as? Int, ch > 0 { out["channels"] = ch }
                if let br = info["bitrate"] as? Double, br > 0 { out["bitrate"] = br }
            }
            DispatchQueue.main.async {
                self.emit("format", out)
            }
        }
    }

    /// AVFoundation 的 FourCC → 友好显示名
    private static func friendlyCodec(_ raw: String, fallbackExt: String) -> String {
        let c = raw.lowercased().trimmingCharacters(in: .whitespaces)
        switch c {
        case "alac": return "ALAC"
        case "flac", "flac": return "FLAC"
        case "mp3", ".mp3", "mp3 ": return "MP3"
        case "aac", "mp4a", "aac ": return "AAC"
        case "lpcm", "pcm": return "PCM"
        case "dsd", "dsf", "dff": return "DSD"
        case "opus": return "OPUS"
        case "vorbis", "ogg": return "VORBIS"
        default:
            // 兜底用扩展名推断
            let e = fallbackExt.lowercased()
            let m: [String: String] = ["flac": "FLAC", "m4a": "ALAC", "mp3": "MP3",
                                       "aac": "AAC", "wav": "PCM", "aiff": "PCM",
                                       "dsf": "DSD", "dff": "DSD"]
            return m[e] ?? raw.uppercased()
        }
    }

    private func setupRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in
            self?.player?.play()
            self?.isPlaying = true
            self?.updateNowPlaying()
            return .success
        }
        c.pauseCommand.addTarget { [weak self] _ in
            self?.player?.pause()
            self?.isPlaying = false
            self?.updateNowPlaying()
            return .success
        }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.isPlaying { self.player?.pause(); self.isPlaying = false }
            else { self.player?.play(); self.isPlaying = true }
            self.updateNowPlaying()
            return .success
        }
        // ⚠️ 2026-10-23：切歌命令改为**转发事件给前端**执行（前端才有播放队列）
        c.nextTrackCommand.addTarget { [weak self] _ in
            self?.emit("native", ["action": "next"])
            return .success
        }
        c.previousTrackCommand.addTarget { [weak self] _ in
            self?.emit("native", ["action": "prev"])
            return .success
        }
        // 跳转命令（控制中心拖进度条）
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self, let e = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self.player?.seek(to: CMTime(seconds: e.positionTime, preferredTimescale: 600))
            self.currentTime = e.positionTime
            self.updateNowPlaying()
            return .success
        }
    }

    /// 更新 macOS 控制中心 / 媒体键的「正在播放」信息
    ///
    /// ⚠️ 2026-10-23 修复「macOS 不把本 App 识别为播放器」：
    ///   · 必须设置 `MPNowPlayingInfoCenter.default().playbackState`（macOS 10.12.2+），
    ///     否则控制中心/媒体键不会把这个 App 当成「正在播放的媒体」。
    ///   · 元数据要完整：标题/艺人/专辑/封面/时长/进度。
    ///   · 每次播放/暂停/切歌/进度变化都要刷新。
    private func updateNowPlaying() {
        var info: [String: Any] = [:]
        if let p = player {
            info[MPMediaItemPropertyPlaybackDuration] = duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
            info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
            _ = p
        }
        // 元数据：从文件标签读（AudioMetaService 有缓存，很快）
        let path = currentPath
        if !path.isEmpty {
            let m = AudioMetaService.shared.meta(path: path)
            var title = (m["title"] as? String) ?? ""
            if title.isEmpty {
                title = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
            }
            if !title.isEmpty { info[MPMediaItemPropertyTitle] = title }
            if let v = m["artist"] as? String, !v.isEmpty { info[MPMediaItemPropertyArtist] = v }
            if let v = m["album"] as? String, !v.isEmpty { info[MPMediaItemPropertyAlbumTitle] = v }
            if let d = m["duration"] as? Double, d > 0 { info[MPMediaItemPropertyPlaybackDuration] = d }
            // 封面：data URI → NSImage → MPMediaItemArtwork
            if let uri = m["cover"] as? String, uri.hasPrefix("data:image"),
               let comma = uri.firstIndex(of: ",") {
                let b64 = String(uri[uri.index(after: comma)...])
                if let data = Data(base64Encoded: b64), let img = NSImage(data: data) {
                    info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                }
            }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        // ⚠️ 关键：macOS 必须显式声明播放状态，控制中心才会显示本 App
        if #available(macOS 10.12.2, *) {
            MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
        }
    }
}
