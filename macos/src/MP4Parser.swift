// MP4 (fMP4) 解析 —— 找出每个音频 sample 的字节范围
//
// 为什么要这个：
//   FairPlay 加密是「逐 sample」的（SAMPLE-AES），
//   解密时必须知道每个 sample 在文件里的确切位置和长度。
//
// 结构（fMP4 分片）：
//   moof
//     └─ traf
//          ├─ tfhd   （可能给 default_sample_size）
//          └─ trun   （sample 数量 + 每个 sample 的大小）
//   mdat   ← 实际的音频数据
//
// 算法参考了 am-hook 的 parse_traf（只看思路，代码自己写）。

import Foundation

// MARK: - Box 结构

struct Box {
    let type: String        // 4 字符
    let start: Int          // box 起始偏移
    let body: Int           // body 起始
    let end: Int            // box 结束

    var size: Int { end - start }
}

// MARK: - 解析器

enum MP4Parser {

    /// 遍历某个范围内的所有子 box
    static func children(_ data: Data, from: Int, to: Int) -> [Box] {
        var out: [Box] = []
        var i = from
        while i + 8 <= to {
            let size = Int(readU32(data, i))
            guard size >= 8 else { break }
            let end = i + size
            guard end <= to else { break }
            let t = String(bytes: data[i+4..<i+8], encoding: .ascii) ?? "????"
            out.append(Box(type: t, start: i, body: i + 8, end: end))
            i = end
        }
        return out
    }

    /// 在范围内找第一个指定类型的 box
    static func find(_ data: Data, from: Int, to: Int, _ type: String) -> Box? {
        children(data, from: from, to: to).first { $0.type == type }
    }

    /// 递进查找：a 里找 b，b 里找 c……
    static func findPath(_ data: Data, _ types: [String], from: Int, to: Int) -> Box? {
        var cur: Box? = nil
        var lo = from, hi = to
        for t in types {
            guard let b = find(data, from: lo, to: hi, t) else { return nil }
            cur = b
            lo = b.body
            hi = b.end
        }
        return cur
    }

    // MARK: - 找 sample 范围

    /// 返回分片里所有音频 sample 的字节范围（相对分片起点）
    static func sampleRanges(_ frag: Data) throws -> [Range<Int>] {
        let top = children(frag, from: 0, to: frag.count)
        guard let moof = top.first(where: { $0.type == "moof" }) else {
            throw PlayerError.decryptFailed("分片里没有 moof")
        }

        var ranges: [Range<Int>] = []
        // moof 下的 traf
        for traf in children(frag, from: moof.body, to: moof.end)
            where traf.type == "traf" {

            var defaultSize: Int? = nil
            var nextData = moof.start          // 默认从 moof 开头算

            // 先读 tfhd
            if let tfhd = find(frag, from: traf.body, to: traf.end, "tfhd") {
                let flags = readU32(frag, tfhd.body) & 0x00FF_FFFF
                var p = tfhd.body + 4           // 跳过 fullbox 版本+flags
                p += 4                          // track_ID
                if flags & 0x01 != 0 {          // base-data-offset
                    p += 8
                }
                if flags & 0x02 != 0 {          // sample-description-index
                    p += 4
                }
                if flags & 0x08 != 0 {          // default-sample-duration
                    p += 4
                }
                if flags & 0x10 != 0 {          // default-sample-size
                    defaultSize = Int(readU32(frag, p))
                }
            }

            // 再处理所有 trun
            for trun in children(frag, from: traf.body, to: traf.end)
                where trun.type == "trun" {

                let flags = readU32(frag, trun.body) & 0x00FF_FFFF
                var p = trun.body + 4
                let count = Int(readU32(frag, p)); p += 4

                var sampleSize = defaultSize
                var pos = nextData

                if flags & 0x01 != 0 {          // data-offset
                    let off = Int32(bitPattern: readU32(frag, p))
                    pos = moof.start + Int(off)
                    p += 4
                }
                if flags & 0x04 != 0 {          // first-sample-flags
                    p += 4
                }

                for _ in 0..<count {
                    var thisSize = sampleSize ?? 0
                    if flags & 0x100 != 0 {     // sample-duration
                        p += 4
                    }
                    if flags & 0x200 != 0 {     // sample-size
                        thisSize = Int(readU32(frag, p))
                        p += 4
                    }
                    if flags & 0x400 != 0 {     // sample-flags
                        p += 4
                    }
                    if flags & 0x800 != 0 {     // sample-composition-offset
                        p += 4
                    }
                    guard thisSize > 0, pos + thisSize <= frag.count else {
                        return ranges     // 数据不全，返回已解析的
                    }
                    ranges.append(pos..<(pos + thisSize))
                    pos += thisSize
                }
                nextData = pos
            }
        }
        return ranges
    }

    /// 找 moof 下需要改成 free 的 pssh box
    static func psshRanges(_ frag: Data) -> [Range<Int>] {
        guard let moof = children(frag, from: 0, to: frag.count)
            .first(where: { $0.type == "moof" }) else { return [] }
        return children(frag, from: moof.body, to: moof.end)
            .filter { $0.type == "pssh" }
            .map { $0.start..<($0.start + 4) }     // 只改 type 那 4 字节
    }

    // MARK: - 工具

    static func readU32(_ d: Data, _ off: Int) -> UInt32 {
        guard off + 4 <= d.count else { return 0 }
        return (UInt32(d[off]) << 24) | (UInt32(d[off+1]) << 16) |
               (UInt32(d[off+2]) << 8) | UInt32(d[off+3])
    }

    static func writeU32(_ d: inout Data, _ off: Int, _ v: UInt32) {
        guard off + 4 <= d.count else { return }
        d[off] = UInt8((v >> 24) & 0xFF)
        d[off+1] = UInt8((v >> 16) & 0xFF)
        d[off+2] = UInt8((v >> 8) & 0xFF)
        d[off+3] = UInt8(v & 0xFF)
    }

    /// 把首个分片的 tfdt（解码时间基准）归零
    ///
    /// ⚠️ 为什么需要（2026-10-21）：
    ///    Apple 的 HLS 分片里 tfdt 是从「首个分片在整首歌里的开始时刻」算的
    ///    （例如 14.95 秒），拼成完整文件后 AVPlayer 会认为音频从 14.95 秒开始，
    ///    表现为「AM 的歌不是从第一秒播放」，歌词/进度条全错位。
    ///    修法：只把**第一个**分片的 tfdt 基准清零，后续分片保持相对关系。
    /// 读取分片里第一个 tfdt 的值（用于计算全局基准）
    static func readTFDT(_ frag: Data) -> Int64? {
        let marker: [UInt8] = [0x74, 0x66, 0x64, 0x74]   // "tfdt"
        var idx = 0
        while idx + 12 < frag.count {
            if frag[idx] == marker[0], frag[idx+1] == marker[1],
               frag[idx+2] == marker[2], frag[idx+3] == marker[3] {
                let body = idx + 4
                guard body + 12 <= frag.count else { return nil }
                if frag[body] == 1 {
                    var v: Int64 = 0
                    for k in 4..<12 { v = (v << 8) | Int64(frag[body + k]) }
                    return v
                } else {
                    var v: Int64 = 0
                    for k in 4..<8 { v = (v << 8) | Int64(frag[body + k]) }
                    return v
                }
            }
            idx += 1
        }
        return nil
    }

    /// 把分片里所有 tfdt 减去 offset（保持分片间相对关系）
    static func shiftTFDT(_ frag: inout Data, by offset: Int64) -> Bool {
        let marker: [UInt8] = [0x74, 0x66, 0x64, 0x74]
        var idx = 0
        var changed = false
        while idx + 12 < frag.count {
            if frag[idx] == marker[0], frag[idx+1] == marker[1],
               frag[idx+2] == marker[2], frag[idx+3] == marker[3] {
                let body = idx + 4
                guard body + 12 <= frag.count else { break }
                if frag[body] == 1 {
                    var v: Int64 = 0
                    for k in 4..<12 { v = (v << 8) | Int64(frag[body + k]) }
                    v = max(0, v - offset)
                    for k in 0..<8 {
                        frag[body + 11 - k] = UInt8((v >> (k * 8)) & 0xFF)
                    }
                } else {
                    var v: Int64 = 0
                    for k in 4..<8 { v = (v << 8) | Int64(frag[body + k]) }
                    v = max(0, v - offset)
                    for k in 0..<4 {
                        frag[body + 7 - k] = UInt8((v >> (k * 8)) & 0xFF)
                    }
                }
                changed = true
                idx = body + 12
            } else {
                idx += 1
            }
        }
        return changed
    }

    static func zeroFirstTFDT(_ frag: inout Data) -> Bool {
        // ⚠️ 用字节模式直接搜 'tfdt'（2026-10-21）：
        //    之前走 children/traf 递归，某些分片结构下找不到，
        //    这里直接搜 4 字节标记，最简单可靠。
        let marker: [UInt8] = [0x74, 0x66, 0x64, 0x74]   // "tfdt"
        var idx = 0
        var changed = false
        while idx + 12 < frag.count {
            if frag[idx] == marker[0], frag[idx+1] == marker[1],
               frag[idx+2] == marker[2], frag[idx+3] == marker[3] {
                // idx 是 type 的起始；body = idx + 4
                let body = idx + 4
                guard body + 12 <= frag.count else { break }
                let version = frag[body]
                if version == 1 {
                    // 64 位：version(1)+flags(3)+baseMediaDecodeTime(8)
                    for k in 4..<12 { frag[body + k] = 0 }
                } else {
                    // 32 位：version(1)+flags(3)+baseMediaDecodeTime(4)
                    for k in 4..<8 { frag[body + k] = 0 }
                }
                changed = true
                idx = body + 12
            } else {
                idx += 1
            }
        }
        return changed
    }

    /// 把某个 box 的 type 改成 "free"（长度不变）
    static func renameToFree(_ d: inout Data, at start: Int) {
        guard start + 8 <= d.count else { return }
        d[start+4] = 0x66     // f
        d[start+5] = 0x72     // r
        d[start+6] = 0x65     // e
        d[start+7] = 0x65     // e
    }

    /// 把 init 段里的加密相关 box 全部改成 free（长度不变）
    ///
    /// ⚠️ 递归必须进入 enca/alac 里面（2026-10-21 修）：
    ///    sinf → schm 这套加密信息是嵌在 enca 内部的子 box，
    ///    只改 enca 的 type 不改内部，ffmpeg 读头时会报
    ///    "schm boxes are only supported in first sample descriptor"。
    static func renameEncaToAlac(_ d: inout Data) {
        scanAll(&d, from: 0, to: d.count)
    }

    private static func scanAll(_ d: inout Data, from: Int, to: Int) {
        var i = from
        while i + 8 <= to {
            let size = Int(readU32(d, i))
            guard size >= 8, i + size <= to else { break }
            let t = String(bytes: d[i+4..<i+8], encoding: .ascii) ?? ""
            let end = i + size

            switch t {
            case "enca", "alac":
                // 统一改名成 alac
                d[i+4] = 0x61; d[i+5] = 0x6c; d[i+6] = 0x61; d[i+7] = 0x63
                // ⚠️ sample entry 的 body 前 28 字节是音频参数（不是子 box）：
                //    6 保留 + 2 数据引用 + 8(version/revision/vendor) + 12(channels/rate/...)
                //    必须跳过 28 才开始找子 box，否则会把参数误当 box 解析。
                let childStart = i + 8 + 28
                if childStart < end {
                    scanAll(&d, from: childStart, to: end)
                }

            case "sinf", "pssh":
                // ⚠️ 关键修法（2026-10-21）：
                //    sinf 整个 box 改名为 free，长度不变。
                //    ffmpeg 看到 free 会整块跳过，不会再解析里面的 schm，
                //    所以不需要逐个改子 box（那样反而可能破坏结构）。
                renameToFree(&d, at: i)
                // 不动内部，整块被跳过即可

            case "moov", "trak", "mdia", "minf", "stbl":
                scanAll(&d, from: i + 8, to: end)

            case "stsd":
                // stsd body: version+flags(4) + entry_count(4) + 多个 entry
                // ⚠️ 必须遍历**所有** entry（2026-10-21）：
                //    Apple 的 stsd 里有 2 个 entry，第二个也带 sinf，
                //    只处理第一个会漏掉加密信息。
                if i + 16 <= end {
                    let entryCount = Int(readU32(d, i + 12))
                    var ep = i + 16
                    for _ in 0..<entryCount {
                        guard ep + 8 <= end else { break }
                        let esz = Int(readU32(d, ep))
                        guard esz >= 8, ep + esz <= end else { break }
                        scanAll(&d, from: ep, to: ep + esz)
                        ep += esz
                    }
                }

            default:
                break
            }
            i = end
        }
    }
}
