#!/usr/bin/env python3
"""Apple Music 登录管理服务（VM 内常驻）

⚠️ 为什么需要（2026-10-22）：
   原来 App 每次登录都用 `limactl shell` 起进程 + 轮询日志，
   每次调用光 SSH 开销就 2~3 秒，轮询一次要 4~5 秒，非常慢。
   改成 VM 内常驻 HTTP 服务后：
     · 登录请求延迟从"秒级 SSH 开销"降到毫秒级
     · 状态查询、日志拉取都是本地 HTTP
     · wrapper 登录成功后继续跑服务模式（不用重启）

接口（HTTP，127.0.0.1:12341）：
   GET  /ping                        → {"ok":true}
   GET  /status                      → {phase,message,loggedIn,elapsed,device,logTail}
   POST /login  {email,password,code}→ {"ok":true,"phase":"starting"}
   POST /logout                      → {"ok":true}
   POST /device {info}               → 设置设备指纹
   GET  /device                      → {"info":"..."}
   GET  /log                         → 原始日志（已过滤 linker 噪音）

状态机：idle → starting → logging_in → (need_code | success | failed)

约定（与 Apple 的 2FA 一致）：
   第 1 次 login 不给 code      → Apple 返回 response type 4 → need_code
   第 2 次 login 带 code        → wrapper 用「密码+验证码」重新认证 → success
"""

import json
import os
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ⚠️ 2026-10-22 路径策略（踩过的坑都记在这）：
#
#   1. wrapper 包必须**运行在 /tmp 下**：
#      /tmp 是 tmpfs，实测 wrapper 在 /tmp/wrapper-pkg 能正常 chroot+mount 起来；
#      放到 /opt（ext4 根分区）会卡在 init 阶段（只打印 "[+] starting..." 就退出）。
#
#   2. 但 /tmp 是 tmpfs，VM 重启就清空 → 所以把包**持久化**在 /opt/am-login/wrapper-pkg，
#      服务启动/登录前自动复制到 /tmp 运行。
#
#   3. 日志放 /opt/am-login/run.log：
#      之前放 /tmp/login.log 时服务写不进去（PrivateTmp / 属主问题报 PermissionError）。
WRAPPER_SRC = "/opt/am-login/wrapper-pkg"   # 持久化模板（VM 重启不丢）
WRAPPER_DIR = "/tmp/wrapper-pkg"            # 实际运行位置（tmpfs，chroot+mount 正常）
DATA_DIR = "/tmp/wrapper-pkg/rootfs/data"
LOG = "/opt/am-login/run.log"
# ⚠️ 2026-10-22：不用官方 wrapper 启动器（它只挂 /dev/urandom + /proc），
#    Apple Anisette 认证需要完整 /dev + /sys，否则返回 response type 4 +
#    "AMD-Action::SP"，且不会发 2FA 验证码。改用 shell 启动器。
LAUNCHER = "/opt/am-login/run-main.sh"

# ⚠️ 2026-10-23：Lima VM 无法直接访问 gsa.apple.com（Apple 全局认证服务器，
#   Anisette 设备认证必需），TLS 被阻断；但 Mac 可以。所以在 Mac 上跑一个
#   HTTP CONNECT 代理（connect-proxy.py，监听 8443），VM 里的 wrapper 用
#   `-P http://<Lima网关>:8443` 走它。Mac 网关通常是 192.168.5.2。
PROXY_URL = "http://192.168.5.2:8443"


def proxy_available():
    """检查 Mac 侧的 CONNECT 代理是否可用（TCP 端口探测）"""
    try:
        import socket
        host = PROXY_URL.split("//")[1].split(":")[0]
        port = int(PROXY_URL.rsplit(":", 1)[1])
        s = socket.create_connection((host, port), timeout=2)
        s.close()
        return True
    except Exception:
        return False
PORT = 12341
# ⚠️ 2026-10-22：设备指纹要**每台机器独立且持久**。
#    放 /tmp 会在 VM 重启后丢失 → 又变成默认共享 ID → 被 Apple 风控。
DEVICE_FILE = "/opt/am-login/device.txt"

# 兜底设备（正常情况下 App 会通过 POST /device 下发每机独立指纹，
# 走到这个兜底说明客户端没同步，DEVICE_FILE 不存在时才用）
DEFAULT_DEVICE = ("Music/4.9/Android/13/Google Pixel 6/"
                  "TQ3A.230805.001/zh-CN/zh-CN/a1b2c3d4e5f60708")

S = {
    "phase": "idle",
    "message": "",
    "email": "",
    "started": 0.0,
    "log": "",
    "has_code": False,     # 本次登录是否已带验证码（用于区分「首次要码」和「验证码错误」）
    "log_offset": 0,       # 监控读取日志的起始字节偏移（提交验证码后推进，只看新日志）
}
LOCK = threading.Lock()
PROC = None
MONITOR = None


# ----------------------------- 工具 -----------------------------

def read_log():
    try:
        with open(LOG, "r", errors="ignore") as f:
            return f.read()
    except Exception:
        return ""


def read_log_from(offset):
    """从指定字节偏移读取日志（用于只看「提交验证码之后」的新增输出）

    ⚠️ 2026-10-23：提交验证码后，如果仍从日志开头判断，会读到历史残留的
       "2fa: true"，监控立刻又把状态改回 need_code → App 显示「验证码未通过」，
       而实际上 wrapper 已经认证成功并拿到了 token。
    """
    try:
        if not os.path.exists(LOG):
            return ""
        with open(LOG, "r", errors="ignore") as f:
            f.seek(offset)
            return f.read()
    except Exception:
        return ""


def log_filtered(txt):
    """去掉 linker 噪音和时区警告，只留业务日志"""
    out = []
    for ln in txt.splitlines():
        if ln.startswith("WARNING: linker"):
            continue
        if "tzdata" in ln:
            continue
        out.append(ln)
    return "\n".join(out)


def device_info():
    try:
        with open(DEVICE_FILE) as f:
            d = f.read().strip()
            if d:
                return d
    except Exception:
        pass
    return DEFAULT_DEVICE


def ensure_wrapper():
    """确保 /tmp 下有可用的 wrapper 包。

    /tmp 是 tmpfs，VM 重启后清空；/opt/am-login/wrapper-pkg 是持久模板，
    这里在需要时把它复制到 /tmp（跳过挂载点和登录数据）。
    """
    marker = os.path.join(WRAPPER_DIR, "wrapper")
    if os.path.isfile(marker):
        return True
    if not os.path.isdir(WRAPPER_SRC):
        return False
    try:
        # 先清理可能残留的半截目录
        for m in ("rootfs/proc", "rootfs/dev/urandom"):
            subprocess.run(["umount", "-l", os.path.join(WRAPPER_DIR, m)],
                           capture_output=True)
        shutil.rmtree(WRAPPER_DIR, ignore_errors=True)
        shutil.copytree(
            WRAPPER_SRC, WRAPPER_DIR, symlinks=True,
            ignore=shutil.ignore_patterns("proc", "urandom"),
        )
    except Exception as e:
        print(f"ensure_wrapper failed: {e}", flush=True)
        return False
    os.makedirs(os.path.join(WRAPPER_DIR, "rootfs", "data"), exist_ok=True)
    return os.path.isfile(marker)


def kill_wrapper():
    """杀掉 main 进程，清理残留挂载"""
    global PROC
    subprocess.run(["pkill", "-9", "-f", "/system/bin/main"],
                   capture_output=True)
    subprocess.run(["pkill", "-9", "-f", "wrapper-pkg/wrapper"],
                   capture_output=True)
    for sub in ("proc", "dev", "sys"):
        subprocess.run(["umount", "-l", os.path.join(WRAPPER_DIR, "rootfs", sub)],
                       capture_output=True)
    if PROC is not None:
        try:
            PROC.kill()
        except Exception:
            pass
        PROC = None
    time.sleep(0.6)


def check_logged_in():
    """通过 data 目录里是否写了 MUSIC_TOKEN / STOREFRONT_ID 判断"""
    for name in ("MUSIC_TOKEN", "STOREFRONT_ID"):
        p = os.path.join(DATA_DIR, name)
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return True
    return False


# ----------------------------- 登录 -----------------------------

def has_saved_login():
    """data 目录里是否有登录态（MUSIC_TOKEN + STOREFRONT_ID）"""
    mt = os.path.join(DATA_DIR, "MUSIC_TOKEN")
    sf = os.path.join(DATA_DIR, "STOREFRONT_ID")
    return (os.path.isfile(mt) and os.path.getsize(mt) > 0
            and os.path.isfile(sf) and os.path.getsize(sf) > 0)


def start_service_mode():
    """用已保存的登录态启动 wrapper 服务模式（不带 -L，不重新登录）

    登录成功后 MUSIC_TOKEN / STOREFRONT_ID 会写在 data 目录，
    wrapper 不带 -L 启动时会直接进入服务模式，监听
      10020 解密 / 20020 m3u8 / 30020 账号信息
    这样 App 每次启动不用重新登录。
    """
    global PROC
    kill_wrapper()
    if not ensure_wrapper():
        print("start_service_mode: wrapper missing", flush=True)
        return False
    if not has_saved_login():
        print("start_service_mode: no saved login", flush=True)
        return False
    cmd = [
        LAUNCHER,
        "-I", device_info(),
        "-H", "127.0.0.1",
        "-B", "/data",
    ]
    if proxy_available():
        cmd += ["-P", PROXY_URL]
    logf = open(LOG, "w")
    PROC = subprocess.Popen(cmd, cwd=WRAPPER_DIR,
                            stdout=logf, stderr=logf,
                            start_new_session=True)
    with LOCK:
        S["phase"] = "success"
        S["message"] = "登录成功（使用已保存的登录态）"
        S["started"] = time.time()
        S["has_code"] = False
    print("start_service_mode: launched", flush=True)
    return True


def write_2fa_code(code):
    """把验证码写到 wrapper 等待的文件（chroot 内 /data/2fa.txt）"""
    path = os.path.join(DATA_DIR, "2fa.txt")
    with open(path, "w") as f:
        f.write(code.strip())
    # 推进日志偏移：之后只看「验证码提交之后」的新日志，
    # 避免历史 "2FA: true" 把状态又打回 need_code
    with LOCK:
        S["log_offset"] = os.path.getsize(LOG) if os.path.exists(LOG) else 0
    print(f"2fa code written to {path} (log offset -> {S['log_offset']})", flush=True)
    return path


def start_login(email, password, code=None):
    global PROC
    ensure_wrapper()
    kill_wrapper()
    shutil.rmtree(DATA_DIR, ignore_errors=True)
    os.makedirs(DATA_DIR, exist_ok=True)
    open(LOG, "w").close()

    # Apple 的 2FA 约定：第二次提交时把验证码拼在密码后面
    eff = password + (code or "")
    # 用 shell 启动器（完整 /dev + /sys 挂载，Anisette 认证必需）
    launcher = LAUNCHER if os.path.isfile(LAUNCHER) else os.path.join(WRAPPER_DIR, "wrapper")
    cmd = [
        launcher,
        "-L", f"{email}:{eff}",
        "-I", device_info(),
        "-H", "127.0.0.1",
        "-B", "/data",
    ]
    # gsa.apple.com 从 VM 直连不通，走 Mac 的 CONNECT 代理
    # ⚠️ 2026-10-23：-F 让 credentialHandler 在需要 2FA 时从 <base_dir>/2fa.txt
    #    读验证码（官方 main.c 里已有这个逻辑）。App 提交验证码时我们只写文件，
    #    不重启进程 —— 因为 2FA 验证码绑定在**同一个认证会话**里。
    cmd += ["-F"]
    if proxy_available():
        cmd += ["-P", PROXY_URL]
        print(f"using proxy {PROXY_URL}", flush=True)
    else:
        print("proxy NOT available, using direct connection", flush=True)
    logf = open(LOG, "a")
    PROC = subprocess.Popen(cmd, cwd=WRAPPER_DIR,
                            stdout=logf, stderr=logf,
                            start_new_session=True)
    with LOCK:
        S["phase"] = "starting"
        S["message"] = "正在启动 Apple Music 认证环境…"
        S["email"] = email
        S["started"] = time.time()
        S["log"] = ""
        S["has_code"] = bool(code)
        S["log_offset"] = 0
    start_monitor()


def start_monitor():
    global MONITOR
    if MONITOR is not None and MONITOR.is_alive():
        return
    MONITOR = threading.Thread(target=_monitor, daemon=True)
    MONITOR.start()


def _monitor():
    global S
    while True:
        time.sleep(0.4)
        with LOCK:
            ph = S["phase"]
        if ph not in ("starting", "logging_in", "need_code"):
            return

        # ⚠️ 2026-10-23：need_code 状态下也要继续监控 ——
        #   wrapper 等验证码最多 120 秒，超时会自己退出；如果用户没来得及输入，
        #   状态必须变成 failed，否则界面会一直停在「请输入验证码」。
        if ph == "need_code":
            # ⚠️ 2026-10-23：need_code 状态下也必须检查日志！
            #   用户提交验证码后，wrapper 会原地继续认证，
            #   成功时日志出现 "response type 6" / "account info cached successfully"。
            #   原来这里只检查进程存活、直接 continue，导致明明登录成功了
            #   却一直显示「请输入验证码」。
            with LOCK:
                off2 = S.get("log_offset", 0)
            clean = log_filtered(read_log_from(off2))
            low = clean.lower()
            with LOCK:
                S["log"] = clean[-8000:]
                if "response type 6" in clean or "account info cached successfully" in clean:
                    S["phase"] = "success"
                    S["message"] = "登录成功"
                    return

            if PROC is not None and PROC.poll() is not None:
                with LOCK:
                    S["phase"] = "failed"
                    S["message"] = (
                        "验证码等待超时（120 秒）或认证进程已退出。\n\n"
                        "请重新点一次「登录」获取新的验证码。"
                    )
                return
            continue

        with LOCK:
            off = S.get("log_offset", 0)
        clean = log_filtered(read_log_from(off))
        low = clean.lower()      # ⚠️ 2026-10-23 修复：状态机里用了 low 但没定义，
                                 # 导致 _monitor 抛 NameError 崩溃 → 状态永远停在 starting
        with LOCK:
            S["log"] = clean[-8000:]

            # 0) ⚠️ 2026-10-23：**最高优先级** —— response type 6 就是认证成功！
            #    main.c 里 `return respType == 6;`，6 = 成功。
            #    这个判断必须放在 2fa/type4 之前，否则日志里残留的 "2fa: true"
            #    会把已经成功的结果误判成 need_code。
            if "response type 6" in clean or "account info cached successfully" in clean:
                if S["phase"] != "success":
                    S["phase"] = "success"
                    S["message"] = "登录成功"
                continue

            # 0.5) Apple 真正要求 2FA 时的信号
            #    credentialHandler 打印 "2FA: true"，此时 main 里的 credentialHandler
            #    会阻塞等待 <base_dir>/2fa.txt（120 秒），所以进程还活着。
            #    这里必须立刻切到 need_code，让 App 弹验证码输入框。
            if "2fa: true" in low:
                if S["phase"] != "need_code":
                    S["phase"] = "need_code"
                    S["message"] = ("Apple 要求验证码：请输入账号主人收到的 6 位验证码"
                                    "（120 秒内有效）")
                continue

            # 1) response type 4 有**两种**含义，必须区分（2026-10-22 踩坑）：
            #    a) credentialHandler 报了 2FA: true  → 真的需要验证码
            #    b) 2FA: false + customerMessage 是 "AMD-Action::SP" 之类空消息
            #       → Apple 的 Anisette 认证没完成 / 请求被限流
            #         （短时间内登录太频繁就会被限流，等 2~3 分钟自动恢复）
            if "response type 4" in clean:
                real_2fa = ("2fa: true" in low) or ("requires 2fa" in low)
                if real_2fa:
                    S["phase"] = "need_code"
                    if S.get("has_code"):
                        S["message"] = "验证码不正确或已过期，请让账号主人重新获取验证码"
                    else:
                        S["message"] = "Apple 要求验证码：请输入手机收到的 6 位验证码"
                else:
                    S["phase"] = "failed"
                    S["message"] = (
                        "【Apple 拒绝了这次登录】\n\n"
                        "可能原因（按可能性排序）：\n"
                        "  1. 该账号的「媒体与购买项目」被 Apple 限制\n"
                        "     → 请在 iPhone 打开 App Store → 点头像，看有无「需要验证 / 继续」提示\n"
                        "  2. 短时间内登录太频繁被临时限流（等 3 分钟再试）\n"
                        "  3. 账号或密码不正确\n"
                        "  4. 设备认证未完成\n\n"
                        "如果 iPhone 上 Apple Music 能正常播放，但这里始终失败，\n"
                        "基本可以确定是第 1 种情况（Apple 限制了该账号的商店权限）。"
                    )
                continue

            # 2) 登录成功（main.c 在启动服务前打印这一行）
            if "account info cached successfully" in clean:
                S["phase"] = "success"
                S["message"] = "登录成功"
                continue

            # 3) 明确失败
            if "login failed" in clean:
                S["phase"] = "failed"
                S["message"] = "登录失败：账号或密码不正确"
                continue
            if "response type 0" in clean:
                S["phase"] = "failed"
                S["message"] = "登录失败：账号或密码不正确"
                continue

            # 4) 进程退出
            if PROC is not None and PROC.poll() is not None:
                if check_logged_in():
                    S["phase"] = "success"
                    S["message"] = "登录成功"
                elif S["phase"] == "starting":
                    S["phase"] = "failed"
                    S["message"] = "认证进程提前退出，未取得登录态"
                else:
                    S["phase"] = "failed"
                    S["message"] = "认证失败"
                continue

            # 5) 进入认证阶段
            if "logging in..." in clean and S["phase"] == "starting":
                S["phase"] = "logging_in"
                S["message"] = "正在向 Apple 提交登录…"


# ----------------------------- HTTP -----------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # 静默，不打访问日志

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _text(self, txt, code=200):
        body = txt.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/ping":
            return self._json({"ok": True, "phase": S["phase"]})
        if self.path == "/status":
            with LOCK:
                d = dict(S)
                started = d.get("started") or 0
                d["elapsed"] = round(time.time() - started, 1) if started else 0
                d["loggedIn"] = (d["phase"] == "success") or has_saved_login()
                d["device"] = device_info()
                d["logTail"] = d.get("log", "")[-1200:]
            return self._json(d)
        if self.path == "/log":
            return self._text(log_filtered(read_log()))
        if self.path == "/device":
            return self._json({"info": device_info()})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        ln = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(ln) if ln else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except Exception:
            data = {}

        if self.path == "/login":
            email = (data.get("email") or "").strip()
            password = data.get("password") or ""
            code = (data.get("code") or "").strip() or None
            if not email or not password:
                return self._json({"ok": False, "error": "缺少账号或密码"}, 400)

            # ⚠️ 关键：2FA 验证码必须提交到**同一个认证会话**。
            #   如果进程正在等验证码（phase == need_code 且进程还活着），
            #   只写 2fa.txt，不重启进程。
            with LOCK:
                waiting = (S["phase"] == "need_code")
                still_running = (PROC is not None and PROC.poll() is None)
            if code and waiting and still_running:
                write_2fa_code(code)
                with LOCK:
                    S["phase"] = "logging_in"
                    S["message"] = "正在验证验证码…"
                start_monitor()
                return self._json({"ok": True, "phase": "submitting"})

            start_login(email, password, code)
            return self._json({"ok": True, "phase": "starting"})

        if self.path == "/logout":
            kill_wrapper()
            shutil.rmtree(DATA_DIR, ignore_errors=True)
            os.makedirs(DATA_DIR, exist_ok=True)
            for f in ("2fa.txt", "MUSIC_TOKEN", "STOREFRONT_ID"):
                try:
                    os.remove(os.path.join(DATA_DIR, f))
                except Exception:
                    pass
            with LOCK:
                S.update({"phase": "idle", "message": "", "email": "",
                          "log": "", "started": 0.0})
            return self._json({"ok": True})

        if self.path == "/device":
            info = (data.get("info") or "").strip()
            if not info:
                return self._json({"ok": False, "error": "缺少 info"}, 400)
            with open(DEVICE_FILE, "w") as f:
                f.write(info)
            print(f"device set: {info}", flush=True)
            return self._json({"ok": True, "info": info})

        return self._json({"error": "not found"}, 404)


def main():
    ensure_wrapper()
    os.makedirs(DATA_DIR, exist_ok=True)
    # 有已保存的登录态 → 直接以服务模式启动（不用重新登录）
    if has_saved_login():
        try:
            start_service_mode()
        except Exception as e:
            print(f"start_service_mode failed: {e}", flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"AM login server listening on 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
