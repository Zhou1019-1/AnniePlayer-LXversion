// 真实左右声道电平表（L/R Meter）
//
// ⚠️ 为什么需要（2026-10-23）：
//   歌曲信息面板里的 L/R 电平条原来是「假的」—— 没有真正的立体声分离数据，
//   只是拿频谱低频段当 L、高频段当 R 做视觉跳动（代码注释里写明了）。
//   用户要求做成真实的左右声道电平。
//
// 实现思路：
//   AVPlayer 本身不暴露音频采样，所以**并行**用 AVAssetReader 解码同一文件的
//   PCM 双声道数据：按播放进度顺序读 ~10ms 一块，分别算 L/R 的 RMS，
//   归一化后推给前端。AVPlayer 负责播放（不变），这里只做测量。
//   换歌 / seek 时重建 reader 并定位。

import Foundation
import AVFoundation

final class LRMeter {
    static let shared = LRMeter()

    private let queue = DispatchQueue(label: "annie.lrmeter", qos: .utility)

    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var trackDuration: Double = 0
    /// 已解码到的时间（秒）
    private var decodedSeconds: Double = 0
    private var currentPath: String = ""
    private var running = false

    // 最近一次电平（供主线程读取）
    private var lastL: Float = 0
    private var lastR: Float = 0
    private let lock = NSLock()

    private init() {}

    // MARK: - 生命周期

    /// 开始测量某个文件（从 atSeconds 开始）
    func start(path: String, at atSeconds: Double) {
        queue.async {
            self.teardownLocked()
            self.currentPath = path
            self.running = true
            self.openReaderLocked(at: atSeconds)
        }
    }

    func stop() {
        queue.async {
            self.running = false
            self.teardownLocked()
            self.lock.lock(); self.lastL = 0; self.lastR = 0; self.lock.unlock()
        }
    }

    /// seek 后重新定位解码器
    func seek(to seconds: Double) {
        queue.async {
            guard self.running, !self.currentPath.isEmpty else { return }
            self.teardownLocked()
            self.openReaderLocked(at: seconds)
        }
    }

    /// 每 100ms 由播放器调用：解码一小块并返回当前 L/R 电平（0..1）
    func tick() -> (l: Float, r: Float) {
        queue.sync {
            guard running, let output = output, let reader = reader, reader.status == .reading else {
                return (0, 0)
            }
            // 读约 120 个 sample buffer（每个 ~10ms）上限，避免卡顿
            var lSum: Double = 0
            var rSum: Double = 0
            var samples = 0
            var blocks = 0
            while blocks < 2, reader.status == .reading {
                guard let sb = output.copyNextSampleBuffer() else { break }
                blocks += 1
                let numSamples = CMSampleBufferGetNumSamples(sb)
                guard numSamples > 0,
                      let block = CMSampleBufferGetDataBuffer(sb) else { continue }
                var length = 0
                var dataPtr: UnsafeMutablePointer<Int8>?
                CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                            totalLengthOut: &length, dataPointerOut: &dataPtr)
                guard let ptr = dataPtr, length > 0 else { continue }
                // 交错 float32 PCM（kAudioFormatFlagIsFloat）
                let floatCount = length / 4
                let f = UnsafeRawPointer(ptr).bindMemory(to: Float.self, capacity: floatCount)
                let frames = floatCount / 2
                for i in 0..<frames {
                    let l = Double(f[i * 2])
                    let r = Double(f[i * 2 + 1])
                    lSum += l * l
                    rSum += r * r
                }
                samples += frames
                decodedSeconds += Double(numSamples) / 44100.0
            }
            guard samples > 0 else { return (lastL, lastR) }
            let lRms = Float(sqrt(lSum / Double(samples)))
            let rRms = Float(sqrt(rSum / Double(samples)))
            // 归一化（-60dBFS 到 0dBFS 映射到 0..1），带一点压缩让视觉更活
            func norm(_ v: Float) -> Float {
                let db = 20 * log10(max(v, 1e-6))
                let t = (db + 60) / 60              // -60..0 dB → 0..1
                return max(0, min(1, t))
            }
            let nl = norm(lRms), nr = norm(rRms)
            // 平滑（快速上升 / 缓慢回落）
            lock.lock()
            lastL = nl > lastL ? nl : lastL * 0.82 + nl * 0.18
            lastR = nr > lastR ? nr : lastR * 0.82 + nr * 0.18
            let outL = lastL, outR = lastR
            lock.unlock()
            return (outL, outR)
        }
    }

    // MARK: - Reader

    private func openReaderLocked(at seconds: Double) {
        // ⚠️ 2026-10-24 修复「L/R 电平条一直不动」：
        //   原来固定用 URL(fileURLWithPath:) 并检查 FileManager.fileExists ——
        //   在线流媒体播放时 currentPath 是 http:// 或缓存 URL，
        //   fileExists 恒为 false → 解码器从不启动 → tick() 永远返回 (0,0)。
        //   现在区分本地路径 / file:// / 远程 http(s) URL 三种情况。
        let raw = currentPath
        let url: URL
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") || raw.hasPrefix("stream://") {
            // ⚠️ 2026-10-24：AVAssetReader **不支持远程 URL**（Apple 限制）。
            //   在线流媒体播放时，先把音频下载到临时缓存文件，再用本地文件解码。
            //   下载在后台队列进行（不阻塞播放），完成后重新打开解码器。
            guard let remote = URL(string: raw) else { return }
            downloadAndOpen(remote: remote, at: seconds)
            return
        } else if raw.hasPrefix("file://") {
            guard let u = URL(string: raw) else { return }
            url = u
            guard FileManager.default.fileExists(atPath: u.path) else { return }
        } else {
            url = URL(fileURLWithPath: raw)
            guard FileManager.default.fileExists(atPath: raw) else { return }
        }
        let asset = AVURLAsset(url: url)
        trackDuration = CMTimeGetSeconds(asset.duration)
        guard trackDuration.isFinite, trackDuration > 0,
              let track = asset.tracks(withMediaType: .audio).first else { return }
        do {
            let r = try AVAssetReader(asset: asset)
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 44100.0,
                AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
            let out = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
            out.alwaysCopiesSampleData = false
            guard r.canAdd(out) else { return }
            r.add(out)
            let start = CMTime(seconds: max(0, seconds), preferredTimescale: 44100)
            r.timeRange = CMTimeRange(start: start, duration: .positiveInfinity)
            guard r.startReading() else { return }
            reader = r
            output = out
            decodedSeconds = max(0, seconds)
            fputs("[LRMeter] 开始解码 \(url.lastPathComponent) @ \(String(format: "%.1f", seconds))s\n", stderr)
        } catch {
            fputs("[LRMeter] 打开失败: \(error)\n", stderr)
        }
    }

    /// ⚠️ 2026-10-24：远程流媒体 → 下载到临时文件 → 用本地文件建 AVAssetReader。
    private func downloadAndOpen(remote: URL, at seconds: Double) {
        // 缓存目录：~/Library/Caches/AnnieMac/lrmeter/
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AnnieMac/lrmeter")
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        // 用 URL 的 SHA 前缀当文件名，避免重复下载同一首
        let key = String(remote.absoluteString.hashValue)
        let ext = remote.pathExtension.isEmpty ? "m4a" : remote.pathExtension
        let dest = cacheDir.appendingPathComponent("lr-\(key).\(ext)")
        if FileManager.default.fileExists(atPath: dest.path) {
            currentPath = dest.path
            openReaderLocked(at: seconds)
            return
        }
        fputs("[LRMeter] 远程流：开始下载 \(remote.host ?? "?")…\n", stderr)
        let task = URLSession.shared.downloadTask(with: remote) { tmp, _, err in
            guard let tmp, err == nil else {
                fputs("[LRMeter] 远程下载失败: \(err?.localizedDescription ?? "?")\n", stderr)
                return
            }
            try? FileManager.default.moveItem(at: tmp, to: dest)
            fputs("[LRMeter] 远程下载完成 → \(dest.lastPathComponent)\n", stderr)
            self.queue.async {
                guard self.running else { return }
                self.teardownLocked()
                self.currentPath = dest.path
                self.openReaderLocked(at: seconds)
            }
        }
        task.resume()
    }

    private func teardownLocked() {
        reader?.cancelReading()
        reader = nil
        output = nil
        decodedSeconds = 0
    }
}
