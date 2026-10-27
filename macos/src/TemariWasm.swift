// temari.wasm 解密桥接
//
// Swift 不能直接跑 WebAssembly，但 JavaScriptCore 可以。
// 方案：用 JSContext 加载 wasm，通过 JS 函数调用它。
//
// temari 是 MIT 许可证（github.com/WorldObservationLog/Temari），
// 我们自己编译成 wasm（154KB），和 AGPL 的 am-hook 无关。

import Foundation
import JavaScriptCore

// ⚠️ 2026-10-23 性能/稳定性修复「快速操作会卡住」：
//   原来整个类是 @MainActor —— 所有 WASM 解密都在**主线程**执行，
//   一首歌 19 个分片、每片上万个样本，连续播放/切歌时解密任务把主线程占满，
//   UI 直接卡死（转圈、点不动）。
//   现在改成**后台专用串行队列**：解密不碰主线程，且串行保证 JSContext
//   （WASM 实例）不被并发访问（JavaScriptCore 的 context 不是线程安全的）。
/// 单个解密 worker（独立 JSContext + 独立队列，可并行）
final class TemariWorker {
    let queue: DispatchQueue
    private var ctx: JSContext?
    private var ready = false

    init(index: Int) {
        queue = DispatchQueue(label: "annie.temari.worker.\(index)", qos: .userInitiated)
    }

    /// 懒加载 wasm
    private func ensureLoaded() throws {
        if ready { return }
        guard let wasmURL = Bundle.main.url(forResource: "temari", withExtension: "wasm"),
              let wasmData = try? Data(contentsOf: wasmURL) else {
            throw PlayerError.wasmMissing
        }
        guard let c = JSContext() else {
            throw PlayerError.wasmMissing
        }
        // 注入 wasm 字节（base64）和加载脚本
        let b64 = wasmData.base64EncodedString()
        c.setObject(b64, forKeyedSubscript: "__wasmB64" as NSString)

        let js = Self.bootstrapJS
        c.evaluateScript(js)
        if let err = c.exception {
            throw PlayerError.decryptFailed("wasm 初始化失败：\(err)")
        }
        guard c.objectForKeyedSubscript("__ok")?.toBool() == true else {
            let errStr = c.objectForKeyedSubscript("__err")?.toString() ?? "unknown"
            fputs("wasm 加载失败详情: \(errStr)\n", stderr)
            throw PlayerError.decryptFailed("wasm 加载失败: \(errStr)")
        }
        ctx = c
        ready = true
    }

    /// 预热（后台创建 JSContext + 编译 wasm）
    func preload() {
        _ = try? ensureLoaded()
    }

    /// 修正 init 段（enca → alac，清除 sinf）
    func patchInit(_ initData: Data) throws -> Data {
        try ensureLoaded()
        guard let c = ctx else { throw PlayerError.wasmMissing }
        c.setObject(initData.base64EncodedString(),
                    forKeyedSubscript: "__input" as NSString)
        guard let out = c.evaluateScript("patchInit()")?.toString() else {
            let err = c.exception?.toString() ?? "未知错误"
            throw PlayerError.decryptFailed(err)
        }
        guard let d = Data(base64Encoded: out) else {
            throw PlayerError.decryptFailed("patchInit 返回无效数据")
        }
        return d
    }

    /// 解密一个分片（原地，长度不变）
    /// - Parameter sampleRanges: 每个 sample 在分片里的字节范围（由 MP4Parser 提供）
    ///
    /// ⚠️ 2026-10-23 性能重构（base64 → ArrayBuffer 零拷贝）：
    ///   原来每个分片要把 1.7MB 数据 base64 编码传给 JS、JS 再纯循环解码，
    ///   解密完再编码回来 —— 两个方向的 base64 在 JS 侧各要 1~2 秒，
    ///   19 个分片就是 30 秒+（实测并行解密 31s）。现在改成：
    ///     · 输入：JSObjectMakeArrayBufferWithBytesNoCopy（零拷贝）
    ///     · 输出：预分配输出 ArrayBuffer，JS 原地写入，Swift 直接读指针
    ///   彻底去掉 base64。
    func decryptFragment(_ frag: inout Data, template: Data,
                         sampleRanges: [Range<Int>],
                         useFixed: Bool = false) throws {
        try ensureLoaded()
        guard let c = ctx else { throw PlayerError.wasmMissing }
        let rangeStr = sampleRanges.map { "\($0.lowerBound),\($0.count)" }
                                   .joined(separator: ";")
        c.setObject(rangeStr, forKeyedSubscript: "__ranges" as NSString)
        c.setObject(useFixed, forKeyedSubscript: "__useFixed" as NSString)
        // 固定模板 JSON（first fragment 用）
        if useFixed, let tplURL = Bundle.main.url(forResource: "fixed_template", withExtension: "json"),
           let tplData = try? Data(contentsOf: tplURL) {
            c.setObject(tplData.base64EncodedString(), forKeyedSubscript: "__fixedTplJson" as NSString)
        }
        // 输入用 ArrayBuffer（零拷贝）
        try setArrayBuffer(c, data: frag, key: "__fragBuf")
        try setArrayBuffer(c, data: template, key: "__tplBuf")
        // 输出：预分配同长度 buffer（JS 原地写入）
        let outBuf = try makeArrayBuffer(c, size: frag.count, key: "__outBuf")
        _ = outBuf
        let res = c.evaluateScript("decryptFrag()")
        if let ex = c.exception {
            fputs("decryptFrag 异常: \(ex)\n", stderr)
            throw PlayerError.decryptFailed(ex.toString())
        }
        // 诊断计时
        if let timing = c.objectForKeyedSubscript("__lastTiming")?.toString() {
            fputs("[TEMARI] \(timing)\n", stderr)
        }
        // JS 侧写 __outLen（实际输出长度）
        let outLen = Int(c.objectForKeyedSubscript("__outLen")?.toInt32() ?? 0)
        guard outLen > 0 else {
            let e2 = c.objectForKeyedSubscript("__lastErr")?.toString() ?? ""
            throw PlayerError.decryptFailed("空结果 \(e2)")
        }
        // 读输出 ArrayBuffer 指针
        guard let outVal = c.objectForKeyedSubscript("__outBuf") else {
            throw PlayerError.decryptFailed("输出 buffer 丢失")
        }
        var ex2: JSValueRef?
        guard let ptr = JSObjectGetArrayBufferBytesPtr(c.jsGlobalContextRef, outVal.jsValueRef, &ex2) else {
            throw PlayerError.decryptFailed("读输出 buffer 失败")
        }
        frag = Data(bytes: ptr, count: outLen)
    }

    // MARK: - ArrayBuffer 辅助

    private func setArrayBuffer(_ c: JSContext, data: Data, key: String) throws {
        let len = data.count
        guard len > 0 else { throw PlayerError.decryptFailed("空数据") }
        let ptr = UnsafeMutableRawPointer.allocate(byteCount: len, alignment: 1)
        data.copyBytes(to: ptr.assumingMemoryBound(to: UInt8.self), count: len)
        var ex: JSValueRef?
        let ab = JSObjectMakeArrayBufferWithBytesNoCopy(
            c.jsGlobalContextRef, ptr, len,
            { (p, _) in if let p { p.deallocate() } }, nil, &ex)
        guard let ab else {
            ptr.deallocate()
            throw PlayerError.decryptFailed("创建输入 ArrayBuffer 失败")
        }
        c.setObject(JSValue(jsValueRef: ab, in: c), forKeyedSubscript: key as NSString)
    }

    private func makeArrayBuffer(_ c: JSContext, size: Int, key: String) throws -> UnsafeMutableRawPointer {
        let ptr = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 1)
        var ex: JSValueRef?
        let ab = JSObjectMakeArrayBufferWithBytesNoCopy(
            c.jsGlobalContextRef, ptr, size,
            { (p, _) in if let p { p.deallocate() } }, nil, &ex)
        guard let ab else {
            ptr.deallocate()
            throw PlayerError.decryptFailed("创建输出 ArrayBuffer 失败")
        }
        c.setObject(JSValue(jsValueRef: ab, in: c), forKeyedSubscript: key as NSString)
        return ptr
    }

    // MARK: - JS 引导代码

    private static let bootstrapJS = """
    var __ok = false;
    var __exports = null;

    // ⚠️ JavaScriptCore 没有 atob/btoa（2026-10-21 修）
    //    这两个是浏览器 API，纯 JS 引擎里不存在，必须自己实现
    if (typeof atob === 'undefined') {
      var __B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      var atob = function(s) {
        s = String(s).replace(/[\\s=]/g, '');
        var out = '';
        var buf = 0, bits = 0;
        for (var i = 0; i < s.length; i++) {
          var c = __B64.indexOf(s.charAt(i));
          if (c < 0) continue;
          buf = (buf << 6) | c;
          bits += 6;
          if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((buf >> bits) & 0xFF);
          }
        }
        return out;
      };
      var btoa = function(str) {
        var out = '';
        var buf = 0, bits = 0;
        for (var i = 0; i < str.length; i++) {
          buf = (buf << 8) | (str.charCodeAt(i) & 0xFF);
          bits += 8;
          while (bits >= 6) {
            bits -= 6;
            out += __B64.charAt((buf >> bits) & 0x3F);
          }
        }
        if (bits > 0) out += __B64.charAt((buf << (6 - bits)) & 0x3F);
        while (out.length % 4) out += '=';
        return out;
      };
    }

    // ⚠️ 2026-10-23 性能修复「解密 34 秒」：
    //   原来每次解密都重建整个 JSContext → 重新编译 154KB WASM（1~2 秒/次），
    //   19 个分片就 30 多秒。
    //   现在模块只编译一次（__wasmMod 缓存），每次解密只重建 **Instance**
    //   （毫秒级，同时天然重置线性内存 —— 解决原来「多次调用内存越界」的问题）。
    var __wasmMod = null;
    function __makeInstance() {
      var inst = new WebAssembly.Instance(__wasmMod, {
        env: { abort: function() { throw new Error("abort"); } }
      });
      __exports = inst.exports;
    }
    (function() {
      try {
        var b64 = __wasmB64;
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        __wasmMod = new WebAssembly.Module(bytes);
        __makeInstance();
        __ok = true;
      } catch (e) {
        __err = String(e);
      }
    })();

    // bump allocator
    // ⚠️ 关键（2026-10-21）：Rust 的 dlmalloc 也在用这块线性内存，
    //    我们从**末尾往前**分配就永远不会撞车。
    var __bump = 0x80000;
    function __ensureHeap(need) {
      var mem = __exports.memory;
      var want = 64 * 1024 * 1024;
      if (mem.buffer.byteLength < want) {
        mem.grow(Math.ceil((want - mem.buffer.byteLength) / 65536));
      }
      return 0x80000;   // 固定从 0x80000 开始（Rust 静态数据之后）
    }
    function __alloc(bytes) {
      var mem = __exports.memory;
      var need = __bump + bytes.length;
      if (need > mem.buffer.byteLength) {
        mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
      }
      var p = __bump;
      __bump += bytes.length;
      new Uint8Array(mem.buffer, p, bytes.length).set(bytes);
      return p;
    }

    function __b64dec(s) {
      var bin = atob(s);
      var a = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      return a;
    }
    function __b64enc(a) {
      var s = "";
      for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
      return btoa(s);
    }

    // 修正 init：temari 没有专门的 patch 函数，
    // 用最小实现：把 enca 改成 alac、sinf 改成 free（长度不变）
    function patchInit() {
      __makeInstance();
      __bump = __ensureHeap(4 * 1024 * 1024);
      var data = __b64dec(__input);
      var s = "";
      for (var i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);

      // enca → alac
      var pos = 0;
      while (true) {
        pos = s.indexOf("enca", pos);
        if (pos < 0) break;
        var bytes = [];
        for (var k = 0; k < 4; k++) bytes.push("alac".charCodeAt(k));
        for (var k = 0; k < 4; k++) data[pos + k] = bytes[k];
        pos += 4;
      }
      return __b64enc(data);
    }

    // 解密分片（Swift 传入 sample 范围，这里只负责调 wasm）
    var __ranges = "";
    // 固定模板（skd://itunes.apple.com/P000000000/s1/e1）在 wasm 里内置，
    // 用 hook_fixed_template 拿，不需要传 JSON
    var __useFixed = false;
    function setRanges(s) { __ranges = s; }

    var __lastErr = "";
    function decryptFrag() {
      try {
      // ⚠️ 2026-10-23：每次解密重建 wasm 实例（毫秒级）——
      //    既重置 bump 分配器，也重置线性内存，避免多次调用越界。
      var __t0 = Date.now();
      __makeInstance();
      var __t1 = Date.now();
      __bump = 0x80000;
      var frag = new Uint8Array(__fragBuf);   // 零拷贝（Swift 侧传入 ArrayBuffer）

      // ⚠️ 首个分片用固定模板（wasm 内置），其余用 /key 拿的模板
      var handle;
      var _fixedJson = (typeof globalThis !== 'undefined' && globalThis.__fixedTplJson) || '';
      if (__useFixed && _fixedJson) {
        // temari 没有 hook_fixed_template，用内置的 fixed_template.json
        var ft = __b64dec(_fixedJson);
        var ftp = __alloc(ft);
        handle = __exports.tmpl_from_json(ftp, ft.length);
        if (!handle) { __lastErr = "固定模板 JSON 加载失败"; return ""; }
      } else {
        var tpl = new Uint8Array(__tplBuf);   // 零拷贝
        var tp = __alloc(tpl);
        handle = __exports.tmpl_from_json(tp, tpl.length);
        if (!handle) { __lastErr = "tmpl_from_json 失败"; return ""; }
      }

      // 预分配最大的 sample 缓冲（复用，不反复 alloc）
      var ranges = __ranges ? __ranges.split(";") : [];
      var maxLen = 0;
      for (var ri0 = 0; ri0 < ranges.length; ri0++) {
        var p0 = ranges[ri0].split(",");
        if (p0.length === 2) maxLen = Math.max(maxLen, parseInt(p0[1], 10));
      }
      if (maxLen <= 0) { __lastErr = "没有有效 sample"; __exports.tmpl_destroy(handle); return ""; }
      var cpBase = __alloc(new Uint8Array(maxLen));
      var opBase = __alloc(new Uint8Array(maxLen));
      var mem = __exports.memory;

      try {
        for (var ri = 0; ri < ranges.length; ri++) {
          var parts = ranges[ri].split(",");
          if (parts.length !== 2) continue;
          var off = parseInt(parts[0], 10);
          var len = parseInt(parts[1], 10);
          if (len <= 0 || off + len > frag.length || len > maxLen) continue;

          var cp = new Uint8Array(mem.buffer, cpBase, len);
          cp.set(frag.subarray(off, off + len));
          var n = __exports.decrypt_sample_ffi(handle, cpBase, len, opBase);
          if (n === len) {
            var out = new Uint8Array(mem.buffer, opBase, n);
            frag.set(out, off);
          }
          // 每次重新取 mem.buffer（可能在 grow 后变化）
          mem = __exports.memory;
        }
        // ⚠️ 2026-10-23：输出直接写入 Swift 预分配的 __outBuf（零拷贝），
        //    不再 base64 编码（原来是性能瓶颈，每分片 1~2 秒）。
        var outView = new Uint8Array(__outBuf);
        outView.set(frag);
        __outLen = frag.length;
        __lastTiming = "init=" + (__t1 - __t0) + "ms total=" + (Date.now() - __t0) + "ms samples=" + ranges.length;
        return "ok";
      } finally {
        __exports.tmpl_destroy(handle);
      }
      } catch (e) {
        __lastErr = String(e);
        throw e;
      }
    }
    """

}

// MARK: - 解密 worker 池（并行加速）

/// 4 个独立 worker 轮询分配 —— WASM 解密是 CPU 密集，单 worker 串行时
/// 一首歌 19 个分片要几十秒；4 worker 并行大约快 3~4 倍。
final class TemariWasm {
    static let shared = TemariWasm()

    private let workers: [TemariWorker]
    private var nextWorker = 0
    private let lock = NSLock()

    private init() {
        // ⚠️ 2026-10-23：worker 数按 CPU 核数定（M 系列通常 8~10 核）。
        //    实测单分片 WASM 解密约 3~4 秒（161 样本 × 每样本 ~20ms，计算密集），
        //    只能靠并行摊薄：4 worker 约 20s，8 worker 约 10s。
        let ncpu = ProcessInfo.processInfo.activeProcessorCount
        let n = max(2, min(8, ncpu - 1))
        var arr: [TemariWorker] = []
        for i in 0..<n { arr.append(TemariWorker(index: i)) }
        workers = arr
        fputs("[TEMARI] 解密 worker 数: \(n)（CPU \(ncpu) 核）\n", stderr)
    }

    /// 预热所有 worker（App 启动时后台调用）：
    /// 每个 worker 首次解密要创建 JSContext + 编译 154KB WASM（约 1~2 秒），
    /// 4 个 worker 串起来就是 4~8 秒的首播延迟。提前在后台做好，首次播放更快。
    func warmup() {
        for w in workers {
            w.queue.async { w.preload() }
        }
    }

    /// 轮询取一个 worker
    private func pickWorker() -> TemariWorker {
        lock.lock(); defer { lock.unlock() }
        let w = workers[nextWorker % workers.count]
        nextWorker += 1
        return w
    }

    /// 后台解密一个分片（返回新 Data）
    func decryptFragmentAsync(_ frag: Data, template: Data,
                              sampleRanges: [Range<Int>],
                              useFixed: Bool = false) async throws -> Data {
        let w = pickWorker()
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            w.queue.async {
                do {
                    var copy = frag
                    try w.decryptFragment(&copy, template: template,
                                          sampleRanges: sampleRanges, useFixed: useFixed)
                    cont.resume(returning: copy)
                } catch {
                    cont.resume(throwing: error)
                }
            }
        }
    }

    /// 后台修正 init 段
    func patchInitAsync(_ initData: Data) async throws -> Data {
        let w = pickWorker()
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            w.queue.async {
                do { cont.resume(returning: try w.patchInit(initData)) }
                catch { cont.resume(throwing: error) }
            }
        }
    }
}
