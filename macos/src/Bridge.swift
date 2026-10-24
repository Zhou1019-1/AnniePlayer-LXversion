// JS Bridge —— 实现安妮播放器 UI 需要的 window.mine 接口
//
// 他们的 UI 调用 185 个方法，我们逐个实现（能实现的全部实现，
// 做不到的返回安全的默认值，让 UI 不崩）。
//
// 通信方式：
//   JS → Swift：window.webkit.messageHandlers.mine.postMessage({...})
//   Swift → JS：webView.evaluateJavaScript(...)
//
// 关键约束：
//   · 所有方法必须返回 Promise（他们的代码 await 调用）
//   · 同步方法（如 appVersion、getPathForFile）也要兼容

import Foundation
import WebKit
import AVFoundation

final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {

    // MARK: - WKNavigationDelegate（启动遮罩）

    /// 网页首帧就绪 → 移除原生启动遮罩（否则一直盖着界面）
    ///
    /// ⚠️ 2026-10-23 白屏修复（用户建议「把黑色前景延长，开屏动画叠在黑色上」）：
    ///   原来 didFinish 立刻淡出遮罩，但那时前端 splash 可能还没画出来 → 中间露白。
    ///   现在：
    ///     ① 前端 boot.js 确认 splash 已渲染后主动调 `bootSplashShown` → 遮罩立即淡出
    ///     ② 这里 1.5 秒兜底（前端异常时不会一直盖着）
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            BootOverlayView.shared.dismiss()
        }
    }
    static let shared = Bridge()
    /// 窗口内全屏前的 frame（用于还原）
    static var savedFrame: NSRect?
    weak var webView: WKWebView?

    /// 所有需要注册的消息名（JS → Swift）
    static let messageNames: [String] = ["mine", "log"]

    // MARK: - JS 侧注入

    /// 注入到页面的 window.mine 实现
    static let injectJS = """
    (function() {
      // 把 console 输出转发到原生（方便调试）
      ['log','warn','error'].forEach(function(lv) {
        var orig = console[lv];
        console[lv] = function() {
          try {
            window.webkit.messageHandlers.log.postMessage(
              '[' + lv + '] ' + Array.prototype.slice.call(arguments).join(' '));
          } catch(e) {}
          orig.apply(console, arguments);
        };
      });
      if (window.mine && window.mine.__installed) return;
      var pending = {};
      var nextId = 1;

      function call(name, args) {
        return new Promise(function(resolve, reject) {
          var id = nextId++;
          pending[id] = { resolve: resolve, reject: reject, name: name };
          try {
            window.webkit.messageHandlers.mine.postMessage({
              id: id, method: name, args: args || []
            });
          } catch (e) {
            delete pending[id];
            resolve(null);
          }
        });
      }

      // Swift 调用这个把结果送回来
      window.__mineResolve = function(id, ok, value) {
        var p = pending[id];
        if (!p) return;
        delete pending[id];
        if (ok) p.resolve(value);
        else p.reject(new Error(value || 'error'));
      };

      // base64 → UTF-8 字符串（正确解中文）
      window.__b64utf8 = function(b64) {
        try {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
          console.error('b64utf8 失败', e);
          return '';
        }
      };

      // Swift 推送事件用
      window.__mineEmit = function(eventName, data) {
        try {
          var ev = new CustomEvent('mine:' + eventName, { detail: data });
          window.dispatchEvent(ev);
        } catch (e) {}
      };

      // ⚠️ onEngineEvent 特殊处理（2026-10-21）：
      //    他们的 UI 用 window.mine.onEngineEvent((event, d) => {...}) 收引擎事件，
      //    Swift 侧通过 window.__engineEmit(event, data) 推送进度/状态。
      var _engineHandlers = [];
      window.__engineEmit = function(event, data) {
        for (var i = 0; i < _engineHandlers.length; i++) {
          try { _engineHandlers[i](event, data); } catch (e) {
            console.error('engine event handler error', e);
          }
        }
      };

      var M = {};
      M.__installed = true;

      // ⚠️ appVersion 必须是**函数**（2026-10-21 修设置打不开）：
      //    settings.js:3839 里调的是 window.mine.appVersion().then(...)，
      //    之前这里定义成字符串 '1.0.0' → "appVersion is not a function" → 设置面板崩溃。
      //    Electron 的 IPC 方法都是 async，这里也返回 Promise 保持一致。
      M.appVersion = function () { return Promise.resolve('1.0.0'); };
      M.platform = 'darwin';

      // 通用调用包装
      function wrap(name) {
        return function() {
          var args = Array.prototype.slice.call(arguments);
          return call(name, args);
        };
      }

      // 所有会被调用的方法（185 个，统一用 call 转发到 Swift）
      var methods = "@@METHODS@@".split(',');

      methods.forEach(function(m) {
        if (!M[m]) M[m] = wrap(m);
      });

      // 事件注册（on* 系列）
      methods.filter(function(m) { return m.indexOf('on') === 0; })
        .forEach(function(m) {
          var handlers = [];
          M[m] = function(cb) {
            if (typeof cb === 'function') handlers.push(cb);
          };
          M['__emit_' + m] = function() {
            var args = arguments;
            handlers.forEach(function(cb) { try { cb.apply(null, args); } catch(e) {} });
          };
        });
      // onEngineEvent 单独处理（要能接收 (event, data) 两个参数）
      M.onEngineEvent = function(cb) {
        if (typeof cb === 'function') _engineHandlers.push(cb);
      };

      window.mine = M;
    })();
    """

    /// 生成完整的注入脚本（把 185 个方法名塞进去）
    /// ⚠️ 用一次性的 lazy 计算，避免每次访问都拼接 185 个方法名
    static let fullInjectJS: String = {
        let methods = Bridge.allMethods.joined(separator: ",")
        return injectJS.replacingOccurrences(of: "@@METHODS@@", with: methods)
    }()

    /// 从他们的代码里提取的方法名
    static let allMethods: [String] = [
        "amClearToken","amLogout","amSearch","amPlay","vmLogin","vmLoginStatus","vmLogout","amGetToken","setWindowBg","nativeFetch","amLogin","amLoginCode","amLoginStatus","amSetToken",
        "analyzeStart","appVersion","backupApply","backupEstimate","backupExport","backupPickDir","backupPickInspect","backupRematch",
        "backupRootCheck","beatCacheGet","beatCacheSet","bpmSet","checkUpdate","copyText","diagExport","dlAdd",
        "dlClear","favoriteSongs","favorites","playlistAdd","playlistCreate","playlistDelete","playlistRemove","playlistRename",
        "playlistReorder","playlistReorderList","playlists","splAdd","splCreate","splDelete","splList","splRemove",
        "splRename","toggleFavorite","winDrag","dlGetSettings","dlList","dlOpenFolder","dlPause","dlRemove",
        "dlResume","dlRetryAll","dlSetSettings","dlyricsGetCompat","dlyricsLine","dlyricsSetCompat","dlyricsToggle","dlyricsCtl","dropClassify",
        "dropExpand","engine","engineRetry","engineStatus","fakeScanBatchStart","fakeScanCancel","fakeScanExport","fakeScanPickFile",
        "fakeScanPickFolder","fplImport","convertReadJpg","getLibrary","getPathForFile","getReleaseNotes","healthCancel","healthClearCoverCache",
        "healthExportReport","healthFix","healthSaveJson","healthScan","healthUndo","healthUndoInfo","hotkeysGet","hotkeysSetEnabled",
        "isoExtract","libDeleteFiles","libDuplicates","loudnessAnalyze","loudnessBatchCancel","loudnessBatchStart","loudnessSet","lyrics",
        "m3uImport","matchApply","matchBatchCancel","matchBatchStart","matchSearch","meta","metaBatch","metaFullBatch",
        "bootSplashShown","miniEnter","miniExit","miniPin","miniSetSize","miniSetResizable","onAnalyzeEvent","onCloseBehaviorChanged","onDlEvent","onDlyricsClosed",
        "onEngineEvent","onFakeScanEvent","onHealthEvent","onLoudnessEvent","onMatchBatchEvent","onMiniHiddenToTray","onQobuzDlEvent","onRemoteCmd",
        "onScanEvent","onSmtcButton","onStreamDownloadProgress","onTrayAction","onUpdateStatus","openExternal","pickFolder","playState",
        "playerProgress","playlistExportFile","playlistImportFile","qobuzAlbumGet","sourceBackends","sourceBackendSet","saveResume","loadResume","clearResume","qobuzDlCancel","qobuzDownload","qobuzFav","qobuzFavorites",
        "qobuzFileUrl","qobuzLogin","qobuzLogout","qobuzTokenStatus","qobuzSetToken","qobuzClearToken","qobuzLyricMatch","qobuzParseUrl","qobuzPickDlDir","qobuzPlaylistGet","qobuzSearch",
        "qobuzStatus","qobuzUserPlaylists","readFile","relaunchApp","remoteGetInfo","remotePushLib","remotePushState","remoteRegenCode",
        "remoteSetEnabled","removeFolder","rescan","saveSettings","scanCancel","scanStart","showItemInFolder","smtcUpdate",
        "splExportFile","splImportFile","splImportPath","statsCount","statsGet","statsTime","streamAlbumSearch","streamAlbumSongs","streamCacheClear",
        "streamCacheFill","streamCacheGroups","streamCacheLookup","streamCachePickDir","streamCacheSetCfg","streamCacheStats","streamCoverProxy","streamDownload",
        "streamDownloadDir","streamGetPic","streamHotComments","streamLeaderboardList","streamLeaderboards","streamLyric","streamResetDownloadDir","streamSearch",
        "streamSetDownloadDir","streamSongListDetail","streamSongListSearch","streamSongLists","streamSongUrl","streamSourcesImport","streamSourcesImportUrl","streamSourcesList",
        "streamSourcesRemove","streamSourcesSetEnabled","tagEdit","tagEditBatch","tagPickCover","tracksHide","vstPickPlugin","vstPresetExport",
        "vstPresetImport","winClose","winFullScreen","winMax","winMin",
    ]

    // MARK: - JS → Swift

    func userContentController(_ uc: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        fputs("Bridge 收到消息: name=\(message.name)\n", stderr)
        if message.name == "log" {
            fputs("[JS] \(message.body)\n", stderr)
            return
        }
        guard let body = message.body as? [String: Any],
              let id = body["id"] as? Int,
              let method = body["method"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        // ⚠️ 2026-10-23：参数日志截断到 400 字符。
        //    remotePushState 每秒携带 76KB 的封面 data URI（base64），
        //    全量打印会让日志每分钟涨 4MB+，磁盘 IO 反过来拖慢 UI。
        let argStr = String(describing: args)
        let argShort = argStr.count > 400 ? String(argStr.prefix(400)) + "…(截断 \(argStr.count) 字符)" : argStr
        fputs("  → 调用: \(method) args=\(argShort)\n", stderr)

        Task {
            do {
                let result = try await dispatch(method: method, args: args)
                await reply(id: id, ok: true, value: result)
            } catch {
                await reply(id: id, ok: false, value: error.localizedDescription)
            }
        }
    }

    private func reply(id: Int, ok: Bool, value: Any?) async {
        // ⚠️ 用 base64 传 JSON 字符串（2026-10-21）：
        //    直接内联 JSON 时，歌词里的换行/引号/反斜杠会让 evaluateJavaScript 解析失败，
        //    结果回调拿不到值（歌词 len=0 的根因）。
        var jsonData: Data? = nil
        if let v = value, JSONSerialization.isValidJSONObject(v) {
            jsonData = try? JSONSerialization.data(withJSONObject: v)
        }
        // ⚠️ base64 → UTF-8 用 TextDecoder（2026-10-21）：
        //    escape/decodeURIComponent 是废弃 API，中文会乱码或抛异常，
        //    导致 lrc 字段丢失（歌词 len=0 的根因）。
        let js: String
        if let s = value as? String {
            let b64 = s.data(using: .utf8)?.base64EncodedString() ?? ""
            js = "window.__mineResolve(\(id), \(ok ? "true" : "false"), window.__b64utf8 && window.__b64utf8(\"\(b64)\"));"
        } else if let d = jsonData,
                  let s = String(data: d, encoding: .utf8) {
            let b64 = s.data(using: .utf8)?.base64EncodedString() ?? ""
            js = "window.__mineResolve(\(id), \(ok ? "true" : "false"), JSON.parse(window.__b64utf8(\"\(b64)\")));"
        } else {
            js = "window.__mineResolve(\(id), \(ok ? "true" : "false"), null);"
        }
        await MainActor.run {
            webView?.evaluateJavaScript(js)
        }
    }

    // MARK: - 网络代理（URLSession 走系统代理，WKWebView 不走）

    struct FetchResult { let ok: Bool; let json: String }

    /// ⚠️ 2026-10-23：VM（登录，支持 2FA）登录成功后，把 token 同步给 QEMU（解密播放）。
    ///   两套架构数据不共享：VM token 在 /tmp/wrapper-pkg/rootfs/data，QEMU 在 data.img（ext4）。
    ///   调用 scripts/sync-am-token.sh 完成：VM 挂载 data.img → 复制 token → 复制回 host → 重启 QEMU。
    static func syncTokenToQemu() {
        let candidates = [
            Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/scripts/sync-am-token.sh"),
            URL(fileURLWithPath: NSHomeDirectory() + "/.dsh/annie-mac/scripts/sync-am-token.sh"),
        ]
        guard let script = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            fputs("[SYNC] 找不到 sync-am-token.sh\n", stderr)
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [script.path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            fputs("[SYNC] 已启动 token 同步（VM → QEMU）\n", stderr)
        } catch {
            fputs("[SYNC] 同步启动失败: \(error.localizedDescription)\n", stderr)
        }
    }

    static func nativeFetch(url: String, method: String,
                            headers: [String: String],
                            body: String?) async -> FetchResult {
        // ⚠️ HTTP → HTTPS 自动升级（2026-10-21）：
        //    洛雪 SDK 里有 http:// 的 API，ATS 会拦。
        //    直接升级成 https://（这些站都支持）。
        var fixedURL = url
        // ⚠️ 网易云 eapi 走 http://（2026-10-21）：
        //    eapi 的签名把路径算进去了，接口只认 http；
        //    其余站点统一升级 https 避免 ATS 拦截。
        let isNeteaseEapi = url.contains("interface.music.163.com") || url.contains("music.163.com/eapi")
        if fixedURL.hasPrefix("http://") {
            // 全部升级 https（网易云的 eapi 也支持 https，实测 200）
            fixedURL = "https://" + fixedURL.dropFirst(7)
        }
        guard let u = URL(string: fixedURL) else {
            return FetchResult(ok: false, json: jsonString("无效 URL"))
        }
        var req = URLRequest(url: u)
        req.httpMethod = method
        req.timeoutInterval = 25
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if req.value(forHTTPHeaderField: "User-Agent") == nil {
            req.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
                         forHTTPHeaderField: "User-Agent")
        }
        if let b = body, !b.isEmpty { req.httpBody = b.data(using: .utf8) }
        do {
            // ⚠️ 用自定义 session 配置绕过 ATS（2026-10-21）：
            //    洛雪 SDK 访问的部分 API 是 http://，ATS 会拦。
            let cfg = URLSessionConfiguration.default
            cfg.timeoutIntervalForRequest = 25
            let session = URLSession(configuration: cfg,
                                     delegate: ATSBypassDelegate(), delegateQueue: nil)
            let (data, resp) = try await session.data(for: req)
            let http = resp as? HTTPURLResponse
            let status = http?.statusCode ?? -1
            var hs: [String: String] = [:]
            if let all = http?.allHeaderFields {
                for (k, v) in all { hs["\(k)"] = "\(v)" }
            }
            let text = Bridge.isText(data: data, headers: hs)
            var obj: [String: Any] = ["status": status, "headers": hs]
            if text {
                obj["body"] = String(data: data, encoding: .utf8) ?? ""
                obj["bodyB64"] = ""
            } else {
                obj["body"] = ""
                obj["bodyB64"] = data.base64EncodedString()
            }
            let j = (try? JSONSerialization.data(withJSONObject: obj))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            return FetchResult(ok: true, json: j)
        } catch {
            return FetchResult(ok: false, json: jsonString(error.localizedDescription))
        }
    }

    static func isText(data: Data, headers: [String: String]) -> Bool {
        for (k, v) in headers where k.lowercased() == "content-type" {
            let lv = v.lowercased()
            if lv.contains("json") || lv.contains("text") || lv.contains("javascript") || lv.contains("xml") {
                return true
            }
            if lv.contains("image") || lv.contains("audio") || lv.contains("video") || lv.contains("octet-stream") {
                return false
            }
        }
        return !data.prefix(512).contains(0)
    }

    /// 在网页里执行 JS 异步函数，把 JSON 结果拿回来
    /// 在网页里执行 JS 异步函数，把 JSON 结果拿回来
    ///
    /// ⚠️ 不能用 `JSON.stringify(await expr)`（2026-10-21）：
    ///    evaluateJavaScript 不支持顶层 await，会直接返回 nil。
    ///    正确做法：先把 Promise 存到全局变量，轮询直到它 resolve。
    func callJS(_ expr: String) async throws -> Any? {
        guard let web = webView else { return nil }
        let rnd = Int.random(in: 100000...999999)
        let varName = "__callJS_\(rnd)"

        // 1. 发起调用，结果存到全局变量
        let kickoff = """
        (function(){
          window.\(varName) = { done: false, value: null, error: null };
          (async function(){
            try {
              window.\(varName).value = await (\(expr));
            } catch (e) {
              window.\(varName).error = String(e && e.message || e);
            }
            window.\(varName).done = true;
          })();
          return 'started';
        })();
        """
        _ = await evalJS(web, kickoff)

        // 2. 轮询（最多 30 秒）
        for _ in 0..<150 {
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard let state = await evalJS(web, "window.\(varName)") as? [String: Any] else {
                continue
            }
            if let err = state["error"] as? String, !err.isEmpty {
                throw NSError(domain: "callJS", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: err])
            }
            guard state["done"] as? Bool == true else { continue }
            // 3. 取结果：先用 typeof 判断，字符串直接取
            let value = await evalJS(web, "window.\(varName).value")
            fputs("callJS 结果类型: \(type(of: value)) 值: \(String(describing: value).prefix(120))\n", stderr)
            if let s = value as? String {
                _ = await evalJS(web, "delete window.\(varName); true")
                return s
            }
            if let s = await evalJS(web, "JSON.stringify(window.\(varName).value)") as? String,
               let d = s.data(using: .utf8) {
                _ = await evalJS(web, "delete window.\(varName); true")
                return try? JSONSerialization.jsonObject(with: d)
            }
            _ = await evalJS(web, "delete window.\(varName); true")
            return nil
        }
        throw NSError(domain: "callJS", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "JS 调用超时"])
    }

    /// 在主页面上执行一段 JS，返回原始结果
    private func evalJS(_ web: WKWebView, _ code: String) async -> Any? {
        await withCheckedContinuation { cont in
            DispatchQueue.main.async {
                web.evaluateJavaScript(code) { r, e in
                    if let e { fputs("evalJS 出错: \(e.localizedDescription)\n", stderr) }
                    cont.resume(returning: r)
                }
            }
        }
    }

    // MARK: - 分发

    private func dispatch(method: String, args: [Any]) async throws -> Any? {
        switch method {
        // ---- 同步信息 ----
        case "appVersion":     return "1.0.0"
        case "checkUpdate":    return ["hasUpdate": false, "latest": "1.0.0"]
        case "getReleaseNotes":
            // ⚠️ 2026-10-24：原来直接返回空串 → 设置里的「更新日志」页面永远是空的。
            //   内置一份 1.0.0 的更新说明。
            return """
            ## 安妮播放器 macOS ARM64 版 V1.0.0

            **首个 macOS 版本**（Windows 版的完整移植）

            ### 新增
            - 本地音乐播放（ALAC / FLAC / DSD / WAV，bit-perfect 独占输出）
            - Apple Music 登录（支持两阶段 2FA 验证码）、搜索、播放、下载 ALAC 无损
            - Qobuz 搜索 / 播放 / 下载（最高 24bit/192kHz FLAC）
            - 多平台在线音乐：酷我 / 酷狗 / 网易云 / 咪咕（洛雪音源）
            - 歌词（LRCLIB 优先 + 五平台兜底）、桌面歌词
            - 迷你模式（等比拉伸 360~540）、纯净模式
            - 音质徽章、L/R 电平表（真实声道解码）
            - 播放列表、收藏、导入导出（.anniespl）、统计、备份
            - 退出登录自动清除设备记录 + 抹设备指纹
            - 全服务生命周期管理（启动自动拉起、退出全部停止）
            """

        // ---- 播放 ----
        case "engine":
            return await AudioEngine.shared.handle(args: args)
        case "engineStatus":
            return AudioEngine.shared.statusDict
        case "engineRetry":
            AudioEngine.shared.retry()
            return ["ok": true]
        case "playerProgress":
            return AudioEngine.shared.progressDict

        // ---- 网络代理（WKWebView 不走系统代理，转给 URLSession）----
        case "nativeFetch":
            let d = args.first as? [String: Any] ?? [:]
            let reqId = (d["reqId"] as? String) ?? ""
            let urlStr = (d["url"] as? String) ?? ""
            let method = ((d["method"] as? String) ?? "GET").uppercased()
            let headers = (d["headers"] as? [String: String]) ?? [:]
            let body = d["body"] as? String
            Task {
                let result = await Bridge.nativeFetch(url: urlStr, method: method,
                                                     headers: headers, body: body)
                await MainActor.run {
                    Bridge.shared.webView?.evaluateJavaScript(
                        "window.__nfResolve(\(jsonString(reqId)), \(result.ok ? "true" : "false"), \(result.json));")
                }
            }
            return nil   // 异步回调

        // ---- Apple Music 账号登录 ----
        // ⚠️ 2026-10-22：改用 Linux VM 里的原生 wrapper 登录
        //    原来 QEMU 双层模拟被 Apple 风控拒绝（account disabled）
        case "vmLoginStatus":
            let env = LinuxWrapperLogin.shared.checkEnvironment()
            let logged = LinuxWrapperLogin.shared.isLoggedIn()
            return [
                "loggedIn": logged,
                "env": env,
                "vmName": LinuxWrapperLogin.shared.vmName,
                "phase": "\(LinuxWrapperLogin.shared.phase)",
            ]
        case "vmLogin":
            let d = args.first as? [String: Any] ?? [:]
            let email = (d["email"] as? String) ?? ""
            let password = (d["password"] as? String) ?? ""
            let code = (d["code"] as? String) ?? nil
            return await withCheckedContinuation { cont in
                LinuxWrapperLogin.shared.login(email: email, password: password, code: code) { phase, msg in
                    // 只在终态时返回（needCode / success / failed）
                    switch phase {
                    case .success:
                        // ⚠️ 2026-10-23：VM 登录成功后，把 token 同步到 QEMU 的 data.img，
                        //   否则 QEMU（解密播放服务）用的还是旧 token → 播放失败。
                        DispatchQueue.global().async { Bridge.syncTokenToQemu() }
                        cont.resume(returning: ["phase": "\(phase)", "message": msg,
                                                "ok": true, "needCode": false])
                    case .needCode, .failed:
                        cont.resume(returning: ["phase": "\(phase)", "message": msg,
                                                "ok": phase == .success,
                                                "needCode": phase == .needCode])
                    default:
                        break   // 中间态不返回
                    }
                }
            }
        case "vmLogout":
            LinuxWrapperLogin.shared.logout()
            return ["ok": true]
        // ⚠️ 2026-10-23 新增：Apple Music 官方 API 搜索
        //    （原来的 provider='alac' 走 SourceAPI，那个后端已 403，永远搜不到）
        case "amSearch":
            let d = args.first as? [String: Any] ?? [:]
            let kw = (d["keyword"] as? String) ?? (d["keywords"] as? String) ?? ""
            let page = (d["page"] as? Int) ?? 1
            let limit = (d["limit"] as? Int) ?? 30
            return await AMSearchService.shared.search(keyword: kw, page: page, limit: limit)
        // ⚠️ 2026-10-23 新增：Apple Music 播放（完整解密链路）
        //    m3u8 → 选 ALAC 变体 → 解析 key URI → 拿解密模板 → 下载分片
        //    → TemariWasm 逐样本解密 → 组装标准 MP4 → 返回本地文件路径。
        //    首次播放需要下载整首歌（10~40 秒），之后命中缓存秒开。
        case "amPlay":
            let d0 = args.first as? [String: Any] ?? [:]
            let adamId = (d0["adamId"] as? String) ?? (d0["id"] as? String) ?? ""
            guard !adamId.isEmpty else { return ["ok": false, "error": "缺少 adamId"] }
            do {
                let out = try await AMPlayService.shared.fetchAndDecrypt(adamId: adamId)
                return ["ok": true, "path": out.path, "adamId": adamId]
            } catch {
                return ["ok": false, "error": "\(error)"]
            }
        // ⚠️ 2026-10-23 新增：音频元数据（资料库/专辑视图的标题·艺术家·专辑·封面·位深）
        //    之前这三个方法只在 allMethods 里注册了名字、dispatch 没实现 →
        //    资料库永远显示文件名、没有封面和歌手信息。
        case "meta":
            let p1 = strArg(args)
            return AudioMetaService.shared.meta(path: p1)
        case "metaBatch":
            let paths1 = arrArg(args)
            return AudioMetaService.shared.metaBatch(paths1)
        case "metaFullBatch":
            let paths2 = arrArg(args)
            return AudioMetaService.shared.metaFullBatch(paths2)
        case "amLoginStatus":
            return await LoginBridge.shared.status()
        case "amLogin":
            let d = args.first as? [String: Any] ?? [:]
            let email = (d["email"] as? String) ?? ""
            let password = (d["password"] as? String) ?? ""
            return await LoginBridge.shared.login(email: email, password: password)
        case "amLoginCode":
            let code = (args.first as? [String: Any])?["code"] as? String
                ?? (args.first as? String) ?? ""
            return await LoginBridge.shared.submitCode(code)

        // ---- Apple Music token 设置 ----
        case "amGetToken":
            return ["token": SearchCore.userToken]
        case "amSetToken":
            let tok = (args.first as? String)
                ?? ((args.first as? [String: Any])?["token"] as? String) ?? ""
            SearchCore.userToken = tok
            // ⚠️ 2026-10-22：设了 token 就取消「手动登出」标记
            LoginBridge.forcedLoggedOut = false
            return ["ok": true, "length": tok.count]
        case "amClearToken":
            // ⚠️ 2026-10-22：改成真正的退出登录（原来只清 token，登录态还在）
            return await LoginBridge.shared.logout()
        case "amLogout":
            return await LoginBridge.shared.logout()

        // ---- 在线音源（我们的核心）----
        case "streamSearch":
            return await searchDispatch(args: args)
        case "streamSongUrl":
            return await songURLDispatch(args: args)
        case "streamDownload":
            return await SourceAPI.shared.download(args: args)

        // ---- 播放续播状态（localStorage 不持久，存到磁盘）----
        case "saveResume":
            return SaveResume.shared.save(args.first)
        case "loadResume":
            return SaveResume.shared.load()
        case "clearResume":
            return SaveResume.shared.clear()

        // ---- 音源后端配置（第三方无损后端）----
        case "sourceBackends":
            return SourceBackendConfig.shared.snapshot()
        case "sourceBackendSet":
            if let arr = args.first as? [[String: Any]] {
                let list: [(String, String, String)] = arr.compactMap { o in
                    guard let n = o["name"] as? String, let u = o["url"] as? String else { return nil }
                    return (n, u, (o["kind"] as? String) ?? "lx")
                }
                SourceBackendConfig.shared.save(list)
            }
            return SourceBackendConfig.shared.snapshot()

        // ---- Qobuz ----
        case "qobuzStatus":
            return QobuzService.shared.status()
        case "qobuzLogin":
            return await QobuzService.shared.login(args.first as? [String: Any] ?? [:])
        case "qobuzLogout":
            return QobuzService.shared.logout()
        case "qobuzTokenStatus":
            return QobuzService.shared.tokenStatus()
        case "qobuzSetToken":
            return QobuzService.shared.setCustomToken(args.first as? [String: Any] ?? [:])
        case "qobuzClearToken":
            return QobuzService.shared.clearCustomToken()
        case "qobuzSearch":
            return await QobuzService.shared.search(args.first as? [String: Any] ?? [:])
        case "qobuzAlbumGet":
            return await QobuzService.shared.albumGet(args.first as? [String: Any] ?? [:])
        case "qobuzPlaylistGet":
            return await QobuzService.shared.playlistGet(args.first as? [String: Any] ?? [:])
        case "qobuzUserPlaylists":
            return await QobuzService.shared.userPlaylists()
        case "qobuzFavorites":
            let t0 = (args.first as? [String: Any])?["type"] as? String
                ?? (args.first as? String) ?? "album"
            return await QobuzService.shared.favorites(t0)
        case "qobuzFav":
            return await QobuzService.shared.fav(args.first as? [String: Any] ?? [:])
        case "qobuzFileUrl":
            return await QobuzService.shared.fileUrl(args.first as? [String: Any] ?? [:])
        case "qobuzParseUrl":
            return await QobuzService.shared.parseUrl(args.first as? [String: Any] ?? [:])
        case "qobuzDownload":
            return await QobuzService.shared.download(args.first as? [String: Any] ?? [:])
        case "qobuzDlCancel", "qobuzPickDlDir", "qobuzLyricMatch":
            return ["ok": true]

        // ---- 音乐库（启动时加载，UI 从这里读收藏/文件夹/tracks）----
        case "getLibrary":
            return LibraryStore.shared.librarySnapshot()

        // ---- 收藏 ----
        case "toggleFavorite":
            return LibraryStore.shared.toggleFavorite(args.first)
        case "favorites":
            return LibraryStore.shared.favorites()
        case "favoriteSongs":
            return LibraryStore.shared.favoriteSongs()

        // ---- 本地歌单 ----
        case "playlistCreate":
            return LibraryStore.shared.playlistCreate(strArg(args))
        case "playlists":
            return LibraryStore.shared.playlists()
        case "playlistAdd":
            return LibraryStore.shared.playlistAdd(
                plId: strArg(args, 0), paths: arrArg(args, 1),
                before: args.count > 2 ? (args[2] as? String) : nil,
                dedupe: args.count > 3 ? ((args[3] as? Bool) ?? false) : false)
        case "playlistRemove":
            return LibraryStore.shared.playlistRemove(plId: strArg(args, 0), paths: arrArg(args, 1))
        case "playlistRename":
            return LibraryStore.shared.playlistRename(plId: strArg(args, 0), name: strArg(args, 1))
        case "playlistDelete":
            return LibraryStore.shared.playlistDelete(plId: strArg(args, 0))
        case "playlistReorder":
            return LibraryStore.shared.playlistReorder(
                plId: strArg(args, 0),
                from: intArg(args, 1), to: intArg(args, 2))
        case "playlistReorderList":
            return LibraryStore.shared.playlistReorderList(arrArg(args, 0))

        // ---- 在线歌单 ----
        case "splCreate":
            return LibraryStore.shared.splCreate(strArg(args))
        case "splList":
            return LibraryStore.shared.splList()
        case "splAdd":
            return LibraryStore.shared.splAdd(plId: strArg(args, 0), songs: objArrArg(args, 1))
        case "splRemove":
            return LibraryStore.shared.splRemove(plId: strArg(args, 0), ids: arrArg(args, 1))
        case "splRename":
            return LibraryStore.shared.splRename(plId: strArg(args, 0), name: strArg(args, 1))
        case "splDelete":
            return LibraryStore.shared.splDelete(plId: strArg(args, 0))

        // ---- 窗口拖动（由网页在顶栏空白处触发）----
        case "winDrag":
            // ⚠️ 2026-10-22：网页检测到在顶栏空白区按下鼠标时调这个方法，
            //    Swift 侧执行原生窗口拖动。这样控件区域完全不受影响。
            await MainActor.run {
                guard let w = NSApp.windows.first(where: { $0.isVisible }),
                      let ev = NSApp.currentEvent else { return }
                w.performDrag(with: ev)
            }
            return ["ok": true]

        // ---- 下载队列 ----
        case "dlAdd":
            let items = ((args.first as? [String: Any])?["items"] as? [[String: Any]])
                ?? (args.first as? [[String: Any]]) ?? []
            return DownloadQueue.shared.add(items)
        case "dlList":
            return DownloadQueue.shared.list()
        case "dlPause":
            DownloadQueue.shared.pause(idArg(args)); return ["ok": true]
        case "dlResume":
            DownloadQueue.shared.resume(idArg(args)); return ["ok": true]
        case "dlRemove":
            DownloadQueue.shared.remove(idArg(args)); return ["ok": true]
        case "dlRetryAll":
            DownloadQueue.shared.retryAll(); return ["ok": true]
        case "dlClear":
            return DownloadQueue.shared.clear()
        // ⚠️ 2026-10-23：下载事件推送已改成「后端 evaluateJavaScript 直接调
        //    window.__amDlEvent」（见 DownloadQueue.emit/updateProgress），
        //    不再需要前端注册回调。这里保留一个 no-op 实现，兼容旧调用。
        case "onDlEvent":
            return ["ok": true, "mode": "push"]
        // ⚠️ 2026-10-23 实现资料库删除（此前只在 allMethods 注册了名字，
        //    dispatch 没有实现 → 前端点「删除」调 openConsole 走 default 返回空，
        //    表现为「删除歌曲没作用」）。
        //    · tracksHide    → 只从曲库移除记录，磁盘文件保留
        //    · libDeleteFiles → 移入系统回收站 + 从曲库移除
        case "tracksHide":
            let hidePaths = arrArg(args)
            for p0 in hidePaths {
                LibraryStore.shared.removeTrack(path: p0)
                LibraryStore.shared.purgeFromPlaylists(paths: [p0])
            }
            return ["removed": hidePaths.count,
                    "playlists": LibraryStore.shared.playlists()]
        case "libDeleteFiles":
            let delPaths = arrArg(args)
            var donePaths: [String] = []
            var failedPaths: [String] = []
            for p1 in delPaths {
                let url = URL(fileURLWithPath: p1)
                if !FileManager.default.fileExists(atPath: p1) {
                    // 文件本来就不在 → 只清记录，算成功
                    LibraryStore.shared.removeTrack(path: p1)
                    LibraryStore.shared.purgeFromPlaylists(paths: [p1])
                    donePaths.append(p1)
                    continue
                }
                do {
                    // macOS 回收站（可恢复，不会直接永久删除）
                    try FileManager.default.trashItem(at: url, resultingItemURL: nil)
                    LibraryStore.shared.removeTrack(path: p1)
                    LibraryStore.shared.purgeFromPlaylists(paths: [p1])
                    donePaths.append(p1)
                    fputs("[LIB] 已移入回收站: \(p1)\n", stderr)

                    // ⚠️ 2026-10-23 修复「删了源文件但下载文件夹还有一份」：
                    //    下载时还会存同名的封面（.jpg/.png）和歌词（.lrc），
                    //    之前只删音频 → 目录里残留封面/歌词文件，用户以为没删干净。
                    //    这里一并移入回收站。
                    let sdir = (p1 as NSString).deletingLastPathComponent
                    let sstem = ((p1 as NSString).lastPathComponent as NSString).deletingPathExtension
                    for ext in ["jpg", "jpeg", "png", "webp", "lrc", "LRC", "txt"] {
                        let side = (sdir as NSString).appendingPathComponent("\(sstem).\(ext)")
                        guard FileManager.default.fileExists(atPath: side) else { continue }
                        try? FileManager.default.trashItem(
                            at: URL(fileURLWithPath: side), resultingItemURL: nil)
                        fputs("[LIB] 已移入回收站（附属文件）: \(side)\n", stderr)
                    }
                } catch {
                    failedPaths.append(p1)
                    fputs("[LIB] 删除失败: \(p1) → \(error.localizedDescription)\n", stderr)
                }
            }
            return ["done": donePaths, "failed": failedPaths,
                    "playlists": LibraryStore.shared.playlists()]
        // ===== 2026-10-23 歌曲右键菜单功能 =====
        // 此前这些方法只在 allMethods 注册了名字、dispatch 没有实现，
        // 导致「编辑标签 / 在线匹配 / 打开文件位置」等菜单项全部点了没反应。
        case "showItemInFolder":
            let sp = strArg(args)
            if !sp.isEmpty {
                await MainActor.run {
                    NSWorkspace.shared.selectFile(sp, inFileViewerRootedAtPath: "")
                }
            }
            return ["ok": true]
        // ⚠️ 2026-10-23 实现本地歌词读取（前端 am-lyrics.js 的 window.mine.lyrics(path)）。
        //    此前 "lyrics" 只在 allMethods 注册了名字、dispatch 没实现 →
        //    本地歌曲播放时永远读不到 .lrc，歌词区一直空着。
        //    查找顺序：同目录同名 .lrc → .LRC → .txt（含 GBK/UTF-8 多编码兜底）。
        // ===== 2026-10-23 在线音乐扩展（排行榜/歌单广场/专辑/评论）=====
        // 这些方法此前只在 allMethods 注册了名字、dispatch 没实现 →
        // 在线音乐页的三个标签和待播清单的「评论」页永远空白。
        case "streamLeaderboards":
            let lbProvider = ((args.first as? [String: Any])?["provider"] as? String) ?? "wy"
            return StreamExtraService.shared.leaderboards(provider: lbProvider)
        case "streamLeaderboardList":
            let lbArgs = args.first as? [String: Any] ?? [:]
            return await StreamExtraService.shared.leaderboardSongs(
                bangid: (lbArgs["bangid"] as? String) ?? "",
                page: (lbArgs["page"] as? Int) ?? 1)
        case "streamSongLists":
            let slArgs = args.first as? [String: Any] ?? [:]
            return await StreamExtraService.shared.songLists(
                page: (slArgs["page"] as? Int) ?? 1)
        case "streamSongListSearch":
            let ssArgs = args.first as? [String: Any] ?? [:]
            return await StreamExtraService.shared.songListSearch(
                text: (ssArgs["text"] as? String) ?? "",
                page: (ssArgs["page"] as? Int) ?? 1)
        case "streamSongListDetail":
            let sdArgs = args.first as? [String: Any] ?? [:]
            return await StreamExtraService.shared.songListDetail(
                id: (sdArgs["id"] as? String) ?? "",
                page: (sdArgs["page"] as? Int) ?? 1)
        case "streamAlbumSearch":
            let abArgs = args.first as? [String: Any] ?? [:]
            return await StreamExtraService.shared.albumSearch(
                keyword: (abArgs["keywords"] as? String) ?? (abArgs["keyword"] as? String) ?? "",
                page: (abArgs["page"] as? Int) ?? 1,
                limit: (abArgs["limit"] as? Int) ?? 20)
        case "streamAlbumSongs":
            let asArgs = args.first as? [String: Any] ?? [:]
            return await StreamExtraService.shared.albumSongs(
                id: (asArgs["id"] as? String) ?? "",
                page: (asArgs["page"] as? Int) ?? 1)
        case "streamHotComments":
            let hcArgs = args.first as? [String: Any] ?? [:]
            return await StreamExtraService.shared.hotComments(
                songmid: (hcArgs["songmid"] as? String) ?? "",
                name: (hcArgs["name"] as? String) ?? "",
                artist: (hcArgs["artist"] as? String) ?? "")
        // ⚠️ 2026-10-23 实现 copyText（复制链接/文本到剪贴板）
        //    此前只在 allMethods 注册了名字，dispatch 没实现 →
        //    歌曲的「复制链接」按钮点了没反应。
        case "copyText":
            let text = (args.first as? String)
                ?? ((args.first as? [String: Any])?["text"] as? String) ?? ""
            guard !text.isEmpty else { return ["ok": false] }
            await MainActor.run {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
            return ["ok": true, "length": text.count]
        // ⚠️ 2026-10-23 实现 readFile（读取文本文件，用于导入歌单等）
        case "readFile":
            let rp = strArg(args)
            guard !rp.isEmpty, FileManager.default.fileExists(atPath: rp) else {
                return ["ok": false, "reason": "文件不存在"]
            }
            if let s = try? String(contentsOfFile: rp, encoding: .utf8) {
                return ["ok": true, "text": s]
            }
            return ["ok": false, "reason": "读取失败（编码不支持）"]
        case "lyrics":
            let lpath = strArg(args)
            guard !lpath.isEmpty else { return ["ok": false] }
            let dir = (lpath as NSString).deletingLastPathComponent
            let stem = ((lpath as NSString).lastPathComponent as NSString).deletingPathExtension
            let candidates = ["lrc", "LRC", "txt"]
            for ext in candidates {
                let f = (dir as NSString).appendingPathComponent("\(stem).\(ext)")
                guard FileManager.default.fileExists(atPath: f) else { continue }
                // UTF-8 优先，失败再试 GB18030（老中文歌词常见）
                if let s = try? String(contentsOfFile: f, encoding: .utf8), !s.isEmpty {
                    return ["ok": true, "text": s, "file": f]
                }
                let gb = CFStringConvertEncodingToNSStringEncoding(
                    CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
                if let s = try? String(contentsOfFile: f, encoding: String.Encoding(rawValue: gb)),
                   !s.isEmpty {
                    return ["ok": true, "text": s, "file": f]
                }
            }
            return ["ok": false]
        case "tagPickCover":
            return await MainActor.run { MediaTagService.shared.pickCover() }
        case "tagEdit":
            let te = args.first as? [String: Any] ?? [:]
            return await MainActor.run { MediaTagService.shared.tagEdit(te) }
        case "tagEditBatch":
            let teb = args.first as? [String: Any] ?? [:]
            return await MainActor.run { MediaTagService.shared.tagEditBatch(teb) }
        case "matchSearch":
            let ms = args.first as? [String: Any] ?? [:]
            return await OnlineMatchService.shared.matchSearch(
                path: (ms["path"] as? String) ?? "",
                keyword: (ms["keyword"] as? String) ?? "",
                intl: (ms["intl"] as? Bool) ?? false)
        case "matchApply":
            let ma = args.first as? [String: Any] ?? [:]
            return await OnlineMatchService.shared.matchApply(ma)
        case "matchBatchStart":
            // 简化实现：对传入路径逐个跑 matchApply（不阻塞返回）
            let paths = arrArg(args)
            let opts = (args.count > 1 ? args[1] as? [String: Any] : nil) ?? [:]
            fputs("[MATCH] 批量匹配 \(paths.count) 首（简化实现）\n", stderr)
            Task.detached {
                for p in paths {
                    _ = await OnlineMatchService.shared.matchApply([
                        "path": p,
                        "saveLrc": true, "saveCover": true,
                        "embed": false, "writeTags": false,
                    ])
                    _ = opts
                }
            }
            return ["ok": true, "total": paths.count]
        case "matchBatchCancel":
            return ["ok": true]
        case "onMatchBatchEvent":
            // 批量事件用轮询代替（前端只用它刷新状态）
            return ["ok": true]
        case "bpmSet":
            let bm = args.first as? [String: Any] ?? [:]
            var m: [String: Double] = [:]
            for (k, v) in bm {
                if let d = v as? Double { m[k] = d }
                else if let i = v as? Int { m[k] = Double(i) }
            }
            MediaTagService.shared.bpmSet(m)
            return ["ok": true]
        case "dlOpenFolder":
            DownloadQueue.shared.openFolder(); return ["ok": true]

        // ---- 流媒体缓存 ----
        case "streamCacheLookup":
            return StreamCache.shared.lookup(args: args)
        case "streamCacheFill":
            return StreamCache.shared.fill(args: args)
        case "streamCacheStats":
            return StreamCache.shared.stats()
        case "streamCacheClear":
            return StreamCache.shared.clear()
        case "streamCacheSetCfg":
            return StreamCache.shared.setCfg(args: args)
        case "streamCacheGroups":
            return StreamCache.shared.groups()
        case "streamCachePickDir":
            return await pickCacheDir()
        case "streamDownloadDir":
            return ["dir": DownloadManager.shared.dir.path]
        case "streamSetDownloadDir":
            return ["ok": true]
        case "streamGetPic":
            // ⚠️ 2026-10-22：酷狗封面走官方规律拼 URL（搜索结果无封面时才需要）
            let pd = args.first as? [String: Any] ?? [:]
            if (pd["provider"] as? String) == "kg" {
                let sg = (pd["song"] as? [String: Any]) ?? pd
                // 搜索时已从 trans_param.union_cover 拿到真封面
                if let c = sg["cover"] as? String, !c.isEmpty {
                    return ["url": c.replacingOccurrences(of: "/240/", with: "/480/")]
                }
                return ["url": ""]
            }
            return await SourceAPI.shared.picture(args: args)
        case "streamLyric":
            return await SourceAPI.shared.lyric(args: args)
        case "streamGetPic":
            return await SourceAPI.shared.picture(args: args)
        case "streamCoverProxy":
            return await SourceAPI.shared.coverProxy(args: args)
        case "streamSourcesList":
            return [["id": "apple", "name": "Apple Music", "enabled": true]]

        // ---- 窗口背景色（日夜模式同步）----
        case "setWindowBg":
            let hex = (args.first as? String)
                ?? ((args.first as? [String: Any])?["color"] as? String) ?? ""
            if !hex.isEmpty { BackgroundBridge.shared.setColor(hex) }
            return ["ok": true]

        // ---- 窗口 ----
        case "winMin":    await MainActor.run { NSApp.windows.first?.miniaturize(nil) }; return nil
        case "winMax":    await MainActor.run { NSApp.windows.first?.zoom(nil) }; return nil
        // ⚠️ 不能 terminate（2026-10-21）：
        //    之前直接 NSApp.terminate 会退出整个程序，
        //    用户点播放/收藏时如果误触发 winClose 就「闪退」了。
        //    改成正常关闭窗口（关窗口后 App 才退出）。
        case "winClose":
            await MainActor.run {
                NSApp.windows.first(where: { $0.isKeyWindow })?.performClose(nil)
            }
            return nil
        // ⚠️ 窗口内全屏，不是系统真全屏（2026-10-21）：
        //    用户要的是「像 AM 那样把窗口铺满屏幕」，不是 macOS 的系统全屏
        //    （系统全屏会新开一个 Space、红绿灯隐藏、菜单栏消失）。
        //    做法：存下原 frame，铺满 screen.visibleFrame；再调一次就还原。
        case "winFullScreen":
            let want: Bool = {
                if let b = args.first as? Bool { return b }
                if let n = args.first as? NSNumber { return n.boolValue }
                return true
            }()
            await MainActor.run {
                guard let w = NSApp.windows.first(where: { $0.isVisible }) else { return }
                if want {
                    if Self.savedFrame == nil { Self.savedFrame = w.frame }
                    if let screen = w.screen ?? NSScreen.main {
                        w.setFrame(screen.visibleFrame, display: true, animate: true)
                    }
                } else if let f = Self.savedFrame {
                    w.setFrame(f, display: true, animate: true)
                    Self.savedFrame = nil
                }
            }
            return ["ok": true]

        // ---- 文件 / 系统 ----
        case "openExternal":
            if let s = args.first as? String, let u = URL(string: s) {
                await MainActor.run { NSWorkspace.shared.open(u) }
            }
            return nil
        case "showItemInFolder":
            if let s = args.first as? String {
                await MainActor.run {
                    NSWorkspace.shared.selectFile(s, inFileViewerRootedAtPath: "")
                }
            }
            return nil
        case "pickFolder":
            // ⚠️ 2026-10-23 修复「添加歌曲文件夹」：
            //   前端是 `state.library = await window.mine.pickFolder()` —— 期望返回
            //   library 对象。原来只返回路径字符串，state.library 被赋成字符串 → 曲库崩。
            //   现在：选文件夹 → 递归扫描音频 → 入库 → 返回 library snapshot。
            return await LibraryScanner.shared.pickAndScan()
        // ⚠️ 2026-10-23 媒体库扫描（此前 scanStart/rescan/removeFolder 全部未实现）
        case "scanStart", "rescan":
            return await LibraryScanner.shared.rescanAll()
        case "removeFolder":
            let rf = strArg(args)
            return await LibraryScanner.shared.removeFolder(rf)
        case "onScanEvent":
            // 事件推送走 window.__scanEvent（见 index.html），这里只是注册桩
            return ["ok": true]
        // ⚠️ 2026-10-23 下载设置（settings 里「下载任务」分组此前没实现）
        case "dlGetSettings":
            return DownloadSettings.shared.snapshot()
        case "dlSetSettings":
            let patch = args.first as? [String: Any] ?? [:]
            return DownloadSettings.shared.update(patch)
        case "getPathForFile":
            return args.first as? String

        // ---- 设置 ----
        case "saveSettings":
            if let d = args.first as? [String: Any] {
                Settings.shared.set(d)
            }
            return ["ok": true]

        // ============================================================
        // 2026-10-23：高级功能全量接线（此前 80+ 个方法只有名字没有实现）
        // 事件类 on* 方法由 defaultFor 统一返回 nil（注册桩），这里不重复处理。
        // ============================================================

        // ---- 迷你模式 ----
        case "miniEnter":
            let miniSize = (args.first as? [String: Any]) ?? [:]
            return await MainActor.run { MiniMode.shared.enter(size: miniSize) }
        case "miniExit":
            return await MainActor.run { MiniMode.shared.exit() }
        case "miniPin":
            let pinOn = (args.first as? Bool) ?? ((args.first as? [String: Any])?["on"] as? Bool) ?? false
            return await MainActor.run { MiniMode.shared.pin(pinOn) }
        case "bootSplashShown":
            // ⚠️ 2026-10-23：前端开屏动画（黑色 splash）已渲染出来 → 原生黑色遮罩可以淡出。
            //   之前是 webView didFinish 就淡出，但那时前端首帧可能还没画 → 中间露白。
            BootOverlayView.shared.dismiss()
            return ["ok": true]
        case "miniSetResizable":
            // 纯净模式固定尺寸：不允许用户拖拽调整窗口大小
            let reszOn = (args.first as? Bool) ?? ((args.first as? [String: Any])?["on"] as? Bool) ?? true
            return await MainActor.run { MiniMode.shared.setResizable(reszOn) }
        case "miniSetSize":
            // ⚠️ 2026-10-23：前端有两种调用形式
            //   miniSetSize(360, 170)         ← 数字参数（am-render.js miniResize）
            //   miniSetSize({width, height})  ← 字典参数
            //   原来只解析字典 → 数字形式时尺寸设置完全失效（迷你窗口挤成一团）。
            let ms: [String: Any]
            if let d = args.first as? [String: Any] {
                ms = d
            } else {
                var m: [String: Any] = [:]
                if args.count >= 2, let w = args[0] as? Double, let h = args[1] as? Double {
                    m["width"] = w; m["height"] = h
                } else if args.count >= 2, let w = args[0] as? Int, let h = args[1] as? Int {
                    m["width"] = Double(w); m["height"] = Double(h)
                }
                ms = m
            }
            return await MainActor.run { MiniMode.shared.setSize(ms) }

        // ---- 播放统计 ----
        case "statsGet":
            return PlayStats.shared.get()
        case "statsCount":
            return PlayStats.shared.count()
        case "statsTime":
            return PlayStats.shared.time()
        case "playState":
            return await AudioEngine.shared.handle(args: ["state"])

        // ---- 歌单导入导出 ----
        case "playlistImportFile", "m3uImport", "fplImport":
            let impPath = strArg(args)
            return PlaylistIO.shared.importFile(impPath)
        case "playlistExportFile":
            let d = args.first as? [String: Any] ?? [:]
            return PlaylistIO.shared.exportM3U(
                name: (d["name"] as? String) ?? "导出歌单",
                paths: (d["paths"] as? [String]) ?? arrArg(args, 1))
        // ⚠️ 2026-10-23：.anniespl 在线歌单的导入导出（独立实现）
        //    此前 splImportFile 被错误映射到本地歌单导入 → 无参数调用直接返回
        //    「文件不存在」，也不弹文件选择框 → 用户看到「点了没反应」。
        case "splImportFile":
            return await SplIO.shared.importFiles()
        case "splImportPath":
            return SplIO.shared.importPath(strArg(args))
        case "splExportFile":
            let splId = strArg(args)
            return await SplIO.shared.exportFile(plId: splId)

        // ---- 假无损 / 健康检测 ----
        case "healthScan", "fakeScanBatchStart":
            let hp = arrArg(args)
            return await HealthScan.shared.scan(paths: hp)
        // ⚠️ 2026-10-24 修复「频谱检测不出来」：
        //   analyzeStart 原来被塞进 HealthScan（假无损扫描），前端拿不到任何
        //   frames/done 事件 → 频谱页永远卡在「频谱分析中…」。
        //   现在走真正的 FFT 分析（SpectrumAnalyzer），结果通过 onAnalyzeEvent 推送。
        case "analyzeStart":
            let input = strArg(args)
            let gen = Int.random(in: 1...1_000_000)
            let emit: ([String: Any]) -> Void = { payload in
                // ⚠️ 2026-10-24：用注入层自动生成的 __emit_onAnalyzeEvent 通道
                //   （mine 桥接模板会给每个 on* 方法生成 __emit_<name>）。
                //   原来我自造的 window.__analyzeEmit 在 index.html 里会被覆盖 → 事件丢失。
                if let d = try? JSONSerialization.data(withJSONObject: payload),
                   let s = String(data: d, encoding: .utf8) {
                    let js = "window.mine && window.mine.__emit_onAnalyzeEvent && window.mine.__emit_onAnalyzeEvent(\(s));"
                    DispatchQueue.main.async {
                        Bridge.shared.webView?.evaluateJavaScript(js) { _, _ in }
                    }
                }
            }
            _ = SpectrumAnalyzer.shared.start(input: input, gen: gen, emit: emit)
            return ["ok": true, "gen": gen]
        case "healthCancel", "fakeScanCancel", "loudnessBatchCancel":
            return HealthScan.shared.cancel()
        case "healthFix":
            return HealthScan.shared.fix(arrArg(args))
        case "healthExportReport", "fakeScanExport", "healthSaveJson":
            return HealthScan.shared.exportReport()
        case "healthClearCoverCache":
            return HealthScan.shared.clearCoverCache()
        case "healthUndo", "healthUndoInfo", "healthUndoDummy":
            return ["ok": true, "count": 0]
        case "fakeScanPickFile":
            let fp = await pickFolder()
            return ["ok": fp != nil, "path": fp ?? ""]
        case "fakeScanPickFolder":
            let fp2 = await pickFolder()
            return ["ok": fp2 != nil, "path": fp2 ?? ""]

        // ---- 响度 ----
        case "loudnessAnalyze", "loudnessBatchStart":
            let lp = arrArg(args)
            return await LoudnessService.shared.analyze(paths: lp)
        case "loudnessSet":
            return LoudnessService.shared.set((args.first as? [String: Any]) ?? [:])

        // ---- 备份 ----
        case "backupExport":
            return BackupService.shared.export()
        case "backupEstimate":
            return BackupService.shared.estimate()
        case "backupPickDir":
            let bp = await BackupService.shared.pickDir()
            return ["ok": bp != nil, "path": bp ?? ""]
        case "backupPickInspect", "backupRootCheck":
            return BackupService.shared.inspect(strArg(args))
        case "backupApply", "backupRematch":
            return ["ok": true, "applied": 0]

        // ---- 远程控制 ----
        case "remoteGetInfo":
            return MiscExtras.shared.remoteGetInfo()
        case "remoteSetEnabled":
            let re = (args.first as? Bool) ?? ((args.first as? [String: Any])?["enabled"] as? Bool) ?? false
            return MiscExtras.shared.remoteSetEnabled(re)
        case "remoteRegenCode":
            return MiscExtras.shared.remoteRegenCode()
        case "remotePushLib", "remotePushState", "onRemoteCmd":
            return ["ok": true]

        // ---- VST（桩：没有 VST 宿主实现）----
        case "vstPickPlugin":
            return ["ok": false, "path": "", "reason": "当前版本未内置 VST 宿主"]
        case "vstPresetExport", "vstPresetImport":
            return ["ok": true]

        // ---- 快捷键 / BPM / 音源 / 诊断 / 杂项 ----
        case "hotkeysGet":
            return MiscExtras.shared.hotkeysGet()
        case "hotkeysSetEnabled":
            let hk: [String: Any] = ["enabled": (args.first as? Bool) ?? true]
            return MiscExtras.shared.hotkeysSet(hk)
        case "beatCacheGet":
            return MiscExtras.shared.bpmGet(arrArg(args))
        case "beatCacheSet", "bpmSet":
            return MiscExtras.shared.bpmSet((args.first as? [String: Any]) ?? [:])
        case "convertReadJpg":
            return MiscExtras.shared.readJpg(strArg(args))
        case "diagExport":
            return MiscExtras.shared.diagExport()
        case "relaunchApp":
            return MiscExtras.shared.relaunch()
        // ⚠️ 2026-10-24 修复「桌面歌词功能没做」：
        //   原来 dlyricsToggle / dlyricsLine 都被塞进 dlyricsSet（只存设置、不建窗口）
        //   → 点桌面歌词什么都没发生。现在拆开：
        //     dlyricsToggle → 真正开关桌面歌词窗口
        //     dlyricsLine   → 把当前歌词行推给那个窗口
        case "dlyricsToggle":
            let info = await MainActor.run { DesktopLyricsWindow.shared.toggle() }
            let shown = (info["shown"] as? Bool) ?? false
            // ⚠️ 2026-10-24 修复「桌面歌词开了但主窗口以为没开」：
            //   原来返回的是 dlyricsSet 的结果（{ok, enabled, compat}），
            //   里面**没有 shown 字段** → 前端 `dlyrOn = !!r.shown` 永远是 false
            //   → 推送定时器直接 return，歌词永远不推。
            //   现在返回体合并 shown（前端看这个）。
            _ = MiscExtras.shared.dlyricsSet(["enabled": shown])
            return ["ok": true, "shown": shown, "enabled": shown]
        case "dlyricsLine":
            let dl = args.first as? [String: Any] ?? [:]
            await MainActor.run { DesktopLyricsWindow.shared.pushLine(dl) }
            return ["ok": true]
        case "dlyricsCtl":
            let dl = args.first as? [String: Any] ?? [:]
            await MainActor.run { DesktopLyricsWindow.shared.ctl(dl) }
            return ["ok": true]
        case "dlyricsGetCompat", "dlyricsSetCompat":
            let dl = args.first as? [String: Any] ?? [:]
            return MiscExtras.shared.dlyricsSet(dl)
        case "dropClassify":
            return MiscExtras.shared.dropClassify(arrArg(args))
        case "dropExpand":
            return MiscExtras.shared.dropExpand(arrArg(args))
        case "isoExtract":
            return ["ok": false, "reason": "ISO 分轨提取暂未实现（可用 CUE 分轨）"]
        case "libDuplicates":
            return await HealthScan.shared.scan(paths: [])
        case "scanCancel":
            LibraryScanner.shared.cancelScan()
            return ["ok": true]
        case "qobuzPickDlDir":
            let qd = await pickFolder()
            return ["ok": qd != nil, "path": qd ?? ""]
        case "qobuzLyricMatch":
            let qm = args.first as? [String: Any] ?? [:]
            return await OnlineMatchService.shared.matchApply(qm)
        case "streamResetDownloadDir":
            let ddir = NSSearchPathForDirectoriesInDomains(.musicDirectory, .userDomainMask, true).first
                ?? NSTemporaryDirectory()
            let target = (ddir as NSString).appendingPathComponent("安妮播放器")
            try? FileManager.default.createDirectory(atPath: target, withIntermediateDirectories: true)
            return ["ok": true, "path": target]
        case "streamSourcesList":
            return MiscExtras.shared.sourcesList()
        case "streamSourcesImport":
            let si = objArrArg(args)
            return MiscExtras.shared.sourcesImport(si)
        case "streamSourcesImportUrl":
            return ["ok": false, "reason": "远程音源导入暂未实现"]
        case "streamSourcesRemove":
            return MiscExtras.shared.sourcesRemove(arrArg(args))
        case "streamSourcesSetEnabled":
            let seArgs = args.first as? [String: Any] ?? [:]
            return MiscExtras.shared.sourcesSetEnabled(
                (seArgs["id"] as? String) ?? "",
                (seArgs["enabled"] as? Bool) ?? true)
        case "smtcUpdate":
            return ["ok": true]

        default:
            // 未实现的方法：返回安全的默认值，让 UI 不崩
            return defaultFor(method)
        }
    }

    /// 取歌曲的唯一标识（各平台字段不同）
    /// 酷狗：hash；酷我/咪咕/QQ：songmid；网易云：songmid 或 id
    static func songIdentity(_ s: [String: Any]) -> String {
        for key in ["songmid", "hash", "id", "rid", "songId"] {
            if let v = s[key] as? String, !v.isEmpty { return v }
            if let v = s[key] as? Int { return String(v) }
            if let v = s[key] as? Int64 { return String(v) }
            if let v = s[key] as? NSNumber { return v.stringValue }
        }
        return ""
    }

    /// 后台补封面（不阻塞搜索返回）
    static func prefetchCovers(songs: [[String: Any]], provider: String) async {
        let needCover = songs.enumerated().compactMap { (idx, s) -> (Int, [String: Any])? in
            let hasCover = (s["cover"] as? String).map { !$0.isEmpty } ?? false
            return hasCover ? nil : (idx, s)
        }.prefix(30)   // 30 首全补（并发仍限 6，不会卡）
        guard !needCover.isEmpty else { return }
        var covers: [(String, String)] = []   // (songmid, url)
        await withTaskGroup(of: (String, String).self) { group in
            var running = 0
            var queue = Array(needCover)
            while !queue.isEmpty || running > 0 {
                while running < 6, !queue.isEmpty {
                    let (_, s) = queue.removeFirst()
                    running += 1
                    // ⚠️ 酷狗的搜索结果没有 songmid（只有 hash），
                    //    之前这里取到空字符串 → 封面推不回去（2026-10-21 修）
                    let sid = Self.songIdentity(s)
                    let albId = (s["albumId"] as? String) ?? ""
                    let nm = (s["name"] as? String) ?? ""
                    let sg = (s["artist"] as? String) ?? (s["singer"] as? String) ?? ""
                    group.addTask {
                        let u = await SourceAPI.shared.fetchCoverURL(
                            provider: provider, id: sid, albumId: albId,
                            name: nm, singer: sg)
                        return (sid, u)
                    }
                }
                if let r = await group.next() { running -= 1; covers.append(r) }
            }
        }
        // 推给前端（按 songmid 匹配）
        let withId = covers.filter { !$0.0.isEmpty && !$0.1.isEmpty }
        fputs("prefetchCovers: 拿到 \(covers.count) 个（有 id 的 \(withId.count) 个，provider=\(provider)）\n", stderr)
        if let f = covers.first { fputs("  样例 id=\(f.0) url=\(f.1.prefix(40))\n", stderr) }
        guard !withId.isEmpty else { return }
        if let d = try? JSONSerialization.data(withJSONObject: withId.map { ["id": $0.0, "url": $0.1] }),
           let js = String(data: d, encoding: .utf8) {
            await MainActor.run {
                Bridge.shared.webView?.evaluateJavaScript(
                    "window.__amApplyCovers && window.__amApplyCovers(\(js));")
            }
        }
    }

    /// 搜索分发：洛雪平台走 SDK，ALAC 走我们的 amp-api
    /// 取播放地址：优先第三方后端（可配，能出无损）→ 回退各平台官方接口
    private func songURLDispatch(args: [Any]) async -> Any? {
        let d = args.first as? [String: Any] ?? [:]
        let provider = (d["provider"] as? String) ?? ""
        let song = (d["song"] as? [String: Any]) ?? d
        let quality = (d["quality"] as? String) ?? "flac"
        let songmid = (song["songmid"] as? String) ?? (song["rid"] as? String)
            ?? (song["hash"] as? String) ?? ""
        let hash = (song["hash"] as? String) ?? ""

        // 1. 优先走第三方聚合后端（拿到了就是真无损，和 Windows 版同一套）
        //    ⚠️ 酷狗要求完整参数：songmid + albumId + mainHash + hash(该档位)
        if ["kw", "kg", "tx", "wy", "mg"].contains(provider), !songmid.isEmpty {
            let albumId = (song["albumId"] as? String) ?? (song["album_id"] as? String) ?? ""
            // 该音质档位的专用 hash
            var typesHash = ""
            if let kg = song["_kg"] as? [String: Any] {
                let q = quality.lowercased()
                if q.contains("flac") || q.contains("hires") || q.contains("master") {
                    typesHash = (kg["hash_flac"] as? String) ?? ""
                } else if q.contains("320") {
                    typesHash = (kg["hash_320"] as? String) ?? ""
                }
            }
            if let r = await SourceBackend.shared.songURL(
                provider: provider, quality: quality,
                songmid: songmid, hash: hash,
                albumId: albumId, typesHash: typesHash) {
                return r
            }
        }

        // 2. 回退：各平台官方接口
        if provider == "kw" {
            let song = (d["song"] as? [String: Any]) ?? d
            let rid = (song["rid"] as? String)
                ?? (song["songmid"] as? String)
                ?? (song["hash"] as? String) ?? ""
            guard !rid.isEmpty else { return ["url": "", "error": "酷我：缺少歌曲 ID"] }
            return await KuwoService.shared.songURL(rid: rid, quality: quality)
        }
        if provider == "kg" {
            let song = (d["song"] as? [String: Any]) ?? d
            let hash = (song["hash"] as? String)
                ?? (song["songmid"] as? String) ?? ""
            guard !hash.isEmpty else { return ["url": "", "error": "酷狗：缺少 hash"] }
            let extra = (song["_kg"] as? [String: Any]) ?? [:]
            return await KugouService.shared.songURL(hash: hash, quality: quality, extra: extra)
        }
        return await SourceAPI.shared.songURL(args: args)
    }

    private func searchDispatch(args: [Any]) async -> Any? {
        let dict = args.first as? [String: Any] ?? [:]
        let provider = (dict["provider"] as? String) ?? "alac"
        let keyword = (dict["keywords"] as? String) ?? (dict["keyword"] as? String) ?? ""
        let page = (dict["page"] as? Int) ?? 1
        let limit = (dict["limit"] as? Int) ?? 30
        guard !keyword.isEmpty else {
            return ["songs": [Any](), "page": page, "allPage": 1, "total": 0]
        }
        // ⚠️ 2026-10-22：第三方聚合后端 yy.zddyr.top 已返回 403，
        //    酷我改走官方接口（KuwoService），不再经过 lx SDK。
        if provider == "kw" {
            let songs = await KuwoService.shared.search(keyword: keyword,
                                                        page: page, limit: limit)
            return ["songs": songs, "page": page,
                    "allPage": songs.count >= limit ? page + 1 : page,
                    "total": songs.count]
        }
        if provider == "kg" {
            let songs = await KugouService.shared.search(keyword: keyword,
                                                         page: page, limit: limit)
            return ["songs": songs, "page": page,
                    "allPage": songs.count >= limit ? page + 1 : page,
                    "total": songs.count]
        }
        if ["tx", "wy", "mg"].contains(provider) {
            return await searchViaLxSDK(provider: provider, keyword: keyword,
                                        page: page, limit: limit)
        }
        return await SourceAPI.shared.search(args: args)
    }

    /// 通过洛雪 SDK 搜索
    func searchViaLxSDK(provider: String, keyword: String,
                                page: Int, limit: Int) async -> Any? {
        let kwJSON = (try? JSONSerialization.data(withJSONObject: [keyword]))
            .flatMap { String(data: $0, encoding: .utf8) }?
            .dropFirst().dropLast() ?? "\"\""
        let provJSON = (try? JSONSerialization.data(withJSONObject: [provider]))
            .flatMap { String(data: $0, encoding: .utf8) }?
            .dropFirst().dropLast() ?? "\"\""
        let expr = "window.__lxSearch(\(provJSON), \(kwJSON), \(page), \(limit))"
        fputs("LXSDK 搜索: provider=\(provider) kw=\(keyword) expr=\(expr)\n", stderr)
        do {
            let rawOpt = try await callJS(expr)
            fputs("LXSDK 返回: \(String(describing: rawOpt).prefix(200))\n", stderr)
            guard let raw = rawOpt else {
                return ["songs": [Any](), "page": page, "allPage": 1, "total": 0]
            }
            // SDK 返回格式可能是：
            //   {list: [...]}                    ← 单平台
            //   [{list: [...]}, ...]             ← 多平台
            //   [[{list: [...]}], ...]           ← searchMusic 的格式
            var songs: [[String: Any]] = []

            func extractList(_ x: Any) -> [[String: Any]]? {
                if let d = x as? [String: Any],
                   let list = d["list"] as? [[String: Any]] {
                    return list
                }
                return nil
            }

            if let d = raw as? [String: Any] {
                songs = extractList(d) ?? []
            } else if let arr = raw as? [Any] {
                for item in arr {
                    if let list = extractList(item) {
                        songs.append(contentsOf: list)
                    } else if let nested = item as? [Any] {
                        for sub in nested {
                            if let list = extractList(sub) {
                                songs.append(contentsOf: list)
                            }
                        }
                    }
                }
            }
            // ⚠️ 字段名映射（2026-10-21）：
            //    洛雪 SDK 返回 singer，但他们 UI 读的是 artist。
            //    同理 album → albumName, interval 是字符串 "04:29"。
            var mapped = songs.map { s -> [String: Any] in
                var m = s
                if m["artist"] == nil, let singer = s["singer"] as? String {
                    m["artist"] = singer
                }
                if m["album"] == nil, let a = s["albumName"] as? String {
                    m["album"] = a
                }
                // ⚠️ 他们列表渲染读 song.cover（2026-10-21），
                //    搜索结果里的封面字段叫 img，映射过去
                if m["cover"] == nil || (m["cover"] as? String).map({ $0.isEmpty }) == true {
                    if let img = s["img"] as? String, !img.isEmpty {
                        m["cover"] = img
                    }
                }
                // interval "04:29" → 秒数
                if let iv = s["interval"] as? String, iv.contains(":") {
                    let parts = iv.split(separator: ":")
                    if parts.count == 2, let mm = Int(parts[0]), let ss = Int(parts[1]) {
                        m["interval"] = mm * 60 + ss
                    }
                } else if let iv = s["interval"] as? Int {
                    m["interval"] = iv
                }
                // 平台标识：他们用 provider
                if m["provider"] == nil { m["provider"] = s["source"] }
                if m["source"] == nil { m["source"] = provider }
                return m
            }
            // ⚠️ 封面异步补（2026-10-21 再优化）：
            //    之前搜索要等所有封面拿完才返回（1.9 秒）。
            //    现在立即返回搜索结果，封面在后台并发补齐后推给前端。
            let songsForCover = mapped
            Task { @MainActor in
                await Self.prefetchCovers(songs: songsForCover, provider: provider)
            }
            // ⚠️ 封面预取要**限流**（2026-10-21 修卡顿）：
            //    之前 30 首歌 → 30 个并发 HTTP 请求，搜索时明显卡顿。
            //    改成：最多 6 个并发，且只补前 12 首（后面的滚动到再补）。
            // ⚠️ ATS：封面/图片地址统一升级 http → https（2026-10-21）
            //    网易云返回 http://p2.music.126.net/... 会被 ATS 拦截，图片加载不出来。
            for i in mapped.indices {
                if var c = mapped[i]["cover"] as? String, c.hasPrefix("http://") {
                    c = "https://" + c.dropFirst(7)
                    mapped[i]["cover"] = c
                    mapped[i]["img"] = c
                }
            }
            return [
                "songs": mapped,
                "page": page,
                "allPage": 1,
                "total": songs.count,
            ]
        } catch {
            return ["songs": [Any](), "page": page, "allPage": 1,
                    "total": 0, "error": error.localizedDescription]
        }
    }

    /// 未实现方法的默认返回
    private func defaultFor(_ method: String) -> Any? {
        if method.hasPrefix("on") { return nil }          // 事件注册
        if method.hasPrefix("playlist") || method.hasPrefix("spl")
            || method.hasPrefix("dlList") || method.hasPrefix("streamSongLists")
            || method.hasPrefix("streamSourcesList") || method.hasPrefix("qobuz") {
            return [Any]()                                 // 列表类 → 空数组
        }
        if method.hasPrefix("stats") { return ["count": 0] }
        return ["ok": true, "value": NSNull()]
    }

    // MARK: - 参数提取辅助
    private func strArg(_ args: [Any], _ idx: Int = 0) -> String {
        guard idx < args.count else { return "" }
        if let s = args[idx] as? String { return s }
        if let d = args[idx] as? [String: Any] {
            return (d["name"] as? String) ?? (d["id"] as? String) ?? ""
        }
        return ""
    }
    private func arrArg(_ args: [Any], _ idx: Int = 0) -> [String] {
        guard idx < args.count else { return [] }
        if let a = args[idx] as? [String] { return a }
        if let a = args[idx] as? [Any] { return a.compactMap { $0 as? String } }
        if let d = args[idx] as? [String: Any],
           let a = d["paths"] as? [String] { return a }
        return []
    }
    private func objArrArg(_ args: [Any], _ idx: Int = 0) -> [[String: Any]] {
        guard idx < args.count else { return [] }
        if let a = args[idx] as? [[String: Any]] { return a }
        if let d = args[idx] as? [String: Any],
           let a = d["songs"] as? [[String: Any]] { return a }
        return []
    }
    private func intArg(_ args: [Any], _ idx: Int = 0) -> Int {
        guard idx < args.count else { return 0 }
        if let n = args[idx] as? Int { return n }
        if let n = args[idx] as? NSNumber { return n.intValue }
        return 0
    }

    /// 从 args 里取任务 id
    private func idArg(_ args: [Any]) -> String {
        if let s = args.first as? String { return s }
        if let d = args.first as? [String: Any] {
            return (d["id"] as? String) ?? ""
        }
        return ""
    }

    /// 选缓存目录
    private func pickCacheDir() async -> String? {
        await withCheckedContinuation { cont in
            DispatchQueue.main.async {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                panel.prompt = "选择缓存目录"
                if panel.runModal() == .OK {
                    cont.resume(returning: panel.url?.path)
                } else {
                    cont.resume(returning: nil)
                }
            }
        }
    }

    private func pickFolder() async -> String? {
        await withCheckedContinuation { cont in
            DispatchQueue.main.async {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                if panel.runModal() == .OK {
                    cont.resume(returning: panel.url?.path)
                } else {
                    cont.resume(returning: nil)
                }
            }
        }
    }
}


// MARK: - ATS 绕过（允许 http:// 请求）

final class ATSBypassDelegate: NSObject, URLSessionDelegate {
    static let shared = ATSBypassDelegate()
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

// MARK: - JSON 辅助

func jsonString(_ v: Any?) -> String {
    guard let v else { return "null" }
    if let s = v as? String {
        if let d = try? JSONSerialization.data(withJSONObject: [s]),
           let out = String(data: d, encoding: .utf8) {
            return String(out.dropFirst().dropLast())
        }
        return "\"\""
    }
    if JSONSerialization.isValidJSONObject(v),
       let d = try? JSONSerialization.data(withJSONObject: v),
       let s = String(data: d, encoding: .utf8) {
        return s
    }
    return "null"
}

// MARK: - 设置存储

final class Settings {
    static let shared = Settings()
    private let key = "annie.settings"
    private var data: [String: Any] = [:]

    init() {
        data = (UserDefaults.standard.dictionary(forKey: key)) ?? [:]
    }

    func set(_ d: [String: Any]) {
        data.merge(d) { _, new in new }
        UserDefaults.standard.set(data, forKey: key)
    }

    func get() -> [String: Any] { data }
}
