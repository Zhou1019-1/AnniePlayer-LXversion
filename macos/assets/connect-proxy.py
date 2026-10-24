#!/usr/bin/env python3
"""HTTP CONNECT 代理（给 Lima VM 用）

为什么需要：
  Lima VM 无法直接访问 gsa.apple.com（TLS 被阻断），但 Mac 可以。
  wrapper 原生支持 `-P proxy` 参数（libcurl），所以这里在 Mac 上跑一个
  标准 HTTP CONNECT 代理，VM 里的 wrapper 用
      -P http://192.168.5.2:8443
  就能通过 Mac 的网络访问 gsa.apple.com —— TLS 是端到端的，完全透明。

支持任意 HTTPS 目标（不只 gsa），这样其它被墙的 Apple 服务也能走。
"""
import socket
import threading
import select

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 8443
BUF = 65536


def relay(a, b):
    """双向转发两个 socket 直到任一关闭"""
    socks = [a, b]
    try:
        while True:
            r, _, x = select.select(socks, [], socks, 60)
            if x:
                break
            if not r:
                continue
            done = False
            for s in r:
                other = b if s is a else a
                try:
                    data = s.recv(BUF)
                except Exception:
                    done = True
                    break
                if not data:
                    done = True
                    break
                try:
                    other.sendall(data)
                except Exception:
                    done = True
                    break
            if done:
                break
    finally:
        for s in (a, b):
            try:
                s.close()
            except Exception:
                pass


def handle(client):
    try:
        client.settimeout(20)
        # 读 CONNECT 请求头（直到 \r\n\r\n）
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = client.recv(4096)
            if not chunk:
                client.close()
                return
            data += chunk
            if len(data) > 16384:
                break

        header = data.split(b"\r\n")
        first = header[0].decode("ascii", "ignore")
        parts = first.split()
        if len(parts) < 2 or parts[0].upper() != "CONNECT":
            client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            client.close()
            return

        hostport = parts[1]
        if ":" in hostport:
            host, port = hostport.rsplit(":", 1)
            port = int(port)
        else:
            host, port = hostport, 443

        try:
            upstream = socket.create_connection((host, port), timeout=20)
        except Exception as e:
            print(f"connect {host}:{port} failed: {e}", flush=True)
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            client.close()
            return

        client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
        client.settimeout(None)
        relay(client, upstream)
    except Exception as e:
        print(f"handle error: {e}", flush=True)
        try:
            client.close()
        except Exception:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(128)
    print(f"CONNECT proxy listening on {LISTEN_HOST}:{LISTEN_PORT}", flush=True)
    while True:
        c, addr = srv.accept()
        threading.Thread(target=handle, args=(c,), daemon=True).start()


if __name__ == "__main__":
    main()
