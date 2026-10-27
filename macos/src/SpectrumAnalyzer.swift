import Foundation
import AVFoundation
import Accelerate

/// ⚠️ 2026-10-24（用户反馈「频谱检测不出来」）：
///   排查发现前端的 `analyzeStart` 被 Bridge **错路由到 HealthScan**（假无损扫描），
///   所以频谱页一直卡在「频谱分析中…」，收不到任何 frames/done 事件。
///   这里实现真正的频谱分析：
///     · AVAssetReader 解码 → 单声道 float32 PCM
///     · vDSP FFT（1024 点，Hann 窗）→ 按秒聚合为 8 个频段 × N 秒
///     · 通过 onAnalyzeEvent 分批推送 {type:'frames', gen, frames:Uint8Array, count}
///     · 结束时推送 {type:'done', gen, waveform:Float32Array, durationSec}
///   前端 viz.js 已经按这个协议实现好了接收逻辑，无需改前端。
final class SpectrumAnalyzer {
    static let shared = SpectrumAnalyzer()

    private var cancelFlag = false
    private let queue = DispatchQueue(label: "annie.spectrum", qos: .utility)

    /// 每批推送的帧数（每帧 192 字节 = 前端 SPEC_BANDS）
    private let framesPerBatch = 160        // 160 帧 ≈ 20 秒，约 30KB/批

    func cancel() { cancelFlag = true }

    /// 开始分析（异步，结果通过 Bridge.emit 推送）
    @discardableResult
    func start(input: String, gen: Int, emit: @escaping ([String: Any]) -> Void) -> Bool {
        cancelFlag = false
        guard let url = resolveURL(input) else {
            emit(["type": "error", "gen": gen, "message": "无法解析音频源"])
            return false
        }
        queue.async { [weak self] in
            self?.analyze(url: url, gen: gen, emit: emit)
        }
        return true
    }

    private func resolveURL(_ input: String) -> URL? {
        if input.hasPrefix("http://") || input.hasPrefix("https://"),
           let u = URL(string: input) { return u }
        if input.hasPrefix("file://"), let u = URL(string: input) { return u }
        if FileManager.default.fileExists(atPath: input) { return URL(fileURLWithPath: input) }
        return nil
    }

    // MARK: - 分析主流程

    private func analyze(url: URL, gen: Int, emit: @escaping ([String: Any]) -> Void) {
        // ⚠️ AVAssetReader 不支持远程 URL → 先下载到临时文件
        var localURL = url
        if url.scheme == "http" || url.scheme == "https" {
            let sem = DispatchSemaphore(value: 0)
            var downloaded: URL?
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("spec-\(abs(url.absoluteString.hashValue)).\(url.pathExtension.isEmpty ? "m4a" : url.pathExtension)")
            if FileManager.default.fileExists(atPath: tmp.path) {
                downloaded = tmp
            } else {
                URLSession.shared.downloadTask(with: url) { t, _, _ in
                    if let t { try? FileManager.default.moveItem(at: t, to: tmp); downloaded = tmp }
                    sem.signal()
                }.resume()
                _ = sem.wait(timeout: .now() + 120)
            }
            guard let d = downloaded else {
                emit(["type": "error", "gen": gen, "message": "音频下载失败"])
                return
            }
            localURL = d
        }

        let asset = AVURLAsset(url: localURL)
        let duration = CMTimeGetSeconds(asset.duration)
        guard duration.isFinite, duration > 0,
              let track = asset.tracks(withMediaType: .audio).first else {
            emit(["type": "error", "gen": gen, "message": "无法读取音频轨道"])
            return
        }

        let sampleRate: Double = 44100
        let fftSize = 1024
        // ⚠️ 2026-10-24 修复「频谱不太对」：
        //   前端 viz.js 的 SPEC_BANDS = 192（每帧 192 个频段），
        //   且时间轴按「每秒 8 帧」换算（vizState.specFrames / 8 = 秒）。
        //   原来这里 bandCount=8、hopSec=0.1 → 数据布局完全错位，频谱图必然不对。
        let bandCount = 192
        let hopSec = 0.125                    // 每秒 8 帧 = 前端假设的帧率
        let totalFrames = max(1, Int(duration / hopSec))

        do {
            let reader = try AVAssetReader(asset: asset)
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsNonInterleaved: false,
            ]
            let out = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
            out.alwaysCopiesSampleData = false
            reader.add(out)
            guard reader.startReading() else {
                emit(["type": "error", "gen": gen, "message": "解码器启动失败"])
                return
            }

            // Hann 窗
            var window = [Float](repeating: 0, count: fftSize)
            vDSP_hann_window(&window, vDSP_Length(fftSize), Int32(vDSP_HANN_NORM))
            let log2n = vDSP_Length(log2(Double(fftSize)))
            guard let fftSetup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else {
                emit(["type": "error", "gen": gen, "message": "FFT 初始化失败"])
                return
            }
            defer { vDSP_destroy_fftsetup(fftSetup) }

            // 每个 bin 对应的频段索引（192 段对数分布，20Hz~20kHz）
            var bandOfBin = [Int](repeating: 0, count: fftSize / 2)
            let nyquist = sampleRate / 2
            for bin in 0..<(fftSize / 2) {
                let freq = Double(bin) * nyquist / Double(fftSize / 2)
                if freq < 1 { bandOfBin[bin] = 0; continue }
                let logF = log2(max(20, freq) / 20) / log2(20000.0 / 20)   // 0..1
                bandOfBin[bin] = min(bandCount - 1, max(0, Int(logF * Double(bandCount))))
            }
            fputs("[SPECTRUM] 频段映射: \(bandCount) 段, FFT \(fftSize) 点, 每帧 \(hopSec)s\n", stderr)

            var frames = [UInt8]()
            var pending: [UInt8] = []
            var frameIndex = 0
            var sampleAcc = [Float]()          // 累积到 fftSize*2 就处理一帧
            let samplesPerFrame = Int(hopSec * sampleRate)   // 4410
            var maxAmp: Float = 0
            // ⚠️ 2026-10-24 修复「波形看不出变化」：
            //   原实现只在分析结束时取 sampleAcc 残留（<0.1 秒），波形图等于空。
            //   正确做法：每个 chunk（0.1s）累积一个峰值，最后重采样成整曲包络。
            var wavePeaks: [Float] = []
            wavePeaks.reserveCapacity(Int(duration / hopSec) + 8)

            while reader.status == .reading {
                if cancelFlag { reader.cancelReading(); return }
                guard let sb = out.copyNextSampleBuffer() else { break }
                let n = CMSampleBufferGetNumSamples(sb)
                guard n > 0, let block = CMSampleBufferGetDataBuffer(sb) else { continue }
                var len = 0
                var ptr: UnsafeMutablePointer<Int8>?
                CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                            totalLengthOut: &len, dataPointerOut: &ptr)
                guard let p = ptr, len > 0 else { continue }
                let fCount = len / 4
                let f = UnsafeRawPointer(p).bindMemory(to: Float.self, capacity: fCount)
                // 取左声道（交错：L,R,L,R...）
                for i in stride(from: 0, to: fCount, by: 2) { sampleAcc.append(f[i]) }

                while sampleAcc.count >= samplesPerFrame {
                    let chunk = Array(sampleAcc.prefix(samplesPerFrame))
                    sampleAcc.removeFirst(samplesPerFrame)
                    let bands = fftBands(chunk, fftSize: fftSize, window: window,
                                         setup: fftSetup, log2n: log2n,
                                         bandOfBin: bandOfBin, bandCount: bandCount)
                    for v in bands { pending.append(v) }
                    // 该 chunk 的峰值 → 波形包络（对称所需的绝对幅度）
                    var chunkMax: Float = 0
                    for v in chunk { let a = abs(v); if a > chunkMax { chunkMax = a } }
                    wavePeaks.append(chunkMax)
                    if chunkMax > maxAmp { maxAmp = chunkMax }
                    frameIndex += 1
                    if pending.count >= framesPerBatch * bandCount {
                        let batch = pending
                        pending.removeAll(keepingCapacity: true)
                        emit(["type": "frames", "gen": gen,
                              "frames": batch, "count": batch.count / bandCount])
                    }
                }
            }
            // 收尾：推剩余的
            if !pending.isEmpty {
                emit(["type": "frames", "gen": gen,
                      "frames": pending, "count": pending.count / bandCount])
            }
            reader.cancelReading()

            // ⚠️ 2026-10-24 修复：波形 = 整曲峰值包络重采样到 1600 点，归一化 0..1
            //   前端 renderWaveFull 用 wf[i] * (H-6) 作为柱高（对称绘制），
            //   所以必须是正数且归一化，否则画出来全是 1px 或负值。
            let targetPoints = 1600
            var waveform = [Float](repeating: 0, count: targetPoints)
            if !wavePeaks.isEmpty {
                let globalMax = max(0.0001, wavePeaks.max() ?? 1)
                for i in 0..<targetPoints {
                    // 区间取最大值（包络特征比取平均更明显）
                    let lo = Int(Double(i) / Double(targetPoints) * Double(wavePeaks.count))
                    let hi = min(wavePeaks.count, Int(Double(i + 1) / Double(targetPoints) * Double(wavePeaks.count)) + 1)
                    var m: Float = 0
                    if lo < hi { for j in lo..<hi where wavePeaks[j] > m { m = wavePeaks[j] } }
                    else if lo < wavePeaks.count { m = wavePeaks[lo] }
                    let norm = m / globalMax
                    // 轻微压缩动态范围（纯线性时小音量段几乎看不见）
                    waveform[i] = pow(norm, 0.6)
                }
            }
            emit(["type": "done", "gen": gen,
                  "waveform": waveform, "durationSec": duration,
                  "framesTotal": frameIndex])
            fputs("[SPECTRUM] 波形包络: \(waveform.count) 点, 峰值=\(maxAmp)\n", stderr)
            fputs("[SPECTRUM] 分析完成: \(frameIndex) 帧 / \(String(format: "%.1f", duration))s\n", stderr)
        } catch {
            emit(["type": "error", "gen": gen, "message": error.localizedDescription])
        }
    }

    /// 对一段 PCM 做 FFT，归入 8 个频段，返回 0..255
    private func fftBands(_ pcm: [Float], fftSize: Int, window: [Float],
                          setup: FFTSetup, log2n: vDSP_Length,
                          bandOfBin: [Int], bandCount: Int) -> [UInt8] {
        let n = min(fftSize, pcm.count)
        var samples = [Float](repeating: 0, count: fftSize)
        for i in 0..<n { samples[i] = pcm[i] }
        vDSP_vmul(samples, 1, window, 1, &samples, 1, vDSP_Length(fftSize))

        var real = [Float](repeating: 0, count: fftSize / 2)
        var imag = [Float](repeating: 0, count: fftSize / 2)
        var split = DSPSplitComplex(realp: &real, imagp: &imag)
        samples.withUnsafeBufferPointer { buf in
            buf.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: fftSize / 2) { cp in
                vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(fftSize / 2))
            }
        }
        vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
        var mags = [Float](repeating: 0, count: fftSize / 2)
        vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(fftSize / 2))

        var bandSum = [Float](repeating: 0, count: bandCount)
        var bandCnt = [Float](repeating: 0, count: bandCount)
        for bin in 0..<(fftSize / 2) {
            let b = bandOfBin[bin]
            bandSum[b] += mags[bin]
            bandCnt[b] += 1
        }
        var out = [UInt8](repeating: 0, count: bandCount)
        for b in 0..<bandCount {
            let avg = bandCnt[b] > 0 ? bandSum[b] / bandCnt[b] : 0
            // dB 归一化：-80dB..0dB → 0..255
            let db = avg > 1e-7 ? 20 * log10(avg / Float(fftSize)) : -80
            let norm = max(0, min(1, (db + 80) / 80))
            out[b] = UInt8(norm * 255)
        }
        return out
    }
}
