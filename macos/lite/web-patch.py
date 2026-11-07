#!/usr/bin/env python3
# ============================================================================
# 安妮播放器 Lite · 前端补丁
#
# 为什么不是复制一份 web？
#   完整版和 Lite 共用同一套前端（macos/web，12MB / 10 万行），
#   如果 Lite 再存一份，两份会随着主线更新漂移，review 也看不出差异。
#   这里在**构建时**从完整版 web 生成 Lite 版：
#     · 删掉 Apple Music 独立板块 am-apple.js
#     · 删掉 index.html 里的登录/Token 弹窗与对应脚本
#     · 删掉 Apple Music 主题侧栏入口（am-dom.js 的 🍎 一行 + 渲染分支）
#     · 帮助文案里的「Apple Music / Qobuz 无损」→「Qobuz 无损」
#   改前端结构时记得同步更新本脚本里的锚点字符串（脚本对锚点做强校验，
#   匹配不到会直接失败，不会静默产出坏包）。
#
# 用法: python3 web-patch.py <完整版 web 目录> <输出目录>
# ============================================================================
import os
import shutil
import sys


def fail(msg):
    print(f"  ❌ {msg}")
    sys.exit(1)


def replace_once(text, old, new, label):
    if old not in text:
        fail(f"锚点丢失：{label}（前端结构变了？请更新 web-patch.py）")
    return text.replace(old, new, 1)


def cut_between(text, start, end, repl, label):
    """删除 [start, end) 之间的内容（保留 end），用 repl 替换。"""
    i = text.find(start)
    if i < 0:
        fail(f"锚点丢失（起点）：{label}")
    j = text.find(end, i + len(start))
    if j < 0:
        fail(f"锚点丢失（终点）：{label}")
    return text[:i] + repl + text[j:]


def main():
    if len(sys.argv) != 3:
        fail("用法: web-patch.py <src web> <dst dir>")
    src, dst = sys.argv[1], sys.argv[2]

    if not os.path.isdir(src):
        fail(f"源目录不存在: {src}")
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)

    # 1) 删 Apple Music 独立板块
    am_page = os.path.join(dst, "js", "local", "am-apple.js")
    if not os.path.exists(am_page):
        fail("找不到 js/local/am-apple.js")
    os.remove(am_page)

    # 2) index.html：script 引用 + 登录/Token 弹窗 + 弹窗脚本
    p = os.path.join(dst, "index.html")
    t = open(p, encoding="utf-8").read()
    t = replace_once(
        t,
        '<script src="js/local/am-apple.js"></script><!-- 2026-10-22：Apple Music 独立板块（登录 + 搜索 + ALAC 播放） -->\n',
        "", "index.html script 标签")
    t = cut_between(
        t,
        '<div id="am-login-panel"',
        '<script>\n// Buffer polyfill',
        "", "index.html 登录/Token 弹窗")
    t = cut_between(
        t,
        "<script>\n(function(){\n  var panel = document.getElementById('am-token-panel');",
        "</script>\n</body>",
        "", "index.html AM 弹窗脚本")
    open(p, "w", encoding="utf-8").write(t)

    # 3) am-dom.js：侧栏 🍎 入口 + 渲染分支
    p = os.path.join(dst, "js", "local", "am-dom.js")
    t = open(p, encoding="utf-8").read()
    lines = t.split("\n")
    out = [l for l in lines
           if "nav('🍎', 'Apple Music', 'apple')" not in l
           and "S.view === 'apple'" not in l]
    if len(lines) - len(out) != 2:
        fail(f"am-dom.js 应删 2 行（🍎 入口 + 渲染分支），实际 {len(lines) - len(out)} 行")
    open(p, "w", encoding="utf-8").write("\n".join(out))

    # 4) 帮助文案
    p = os.path.join(dst, "js", "local", "helpContent.js")
    t = open(p, encoding="utf-8").read()
    t = replace_once(t, "+ 洛雪音乐在线生态 + Apple Music / Qobuz 无损",
                     "+ 洛雪音乐在线生态 + Qobuz 无损", "helpContent 文案")
    open(p, "w", encoding="utf-8").write(t)

    print(f"  ✅ 前端补丁完成: {dst}")


if __name__ == "__main__":
    main()
