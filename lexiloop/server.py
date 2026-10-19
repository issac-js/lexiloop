"""lexiloop 静态站点服务器。

存在的唯一理由：托管平台的 CDN 会按 URL 缓存静态资源，连 `cache: 'no-store'`
的客户端请求都绕不过边缘缓存 —— 结果发布后用户仍拿到旧版 index.html / js 模块。
这里显式对所有响应声明不缓存，让边缘每次回源。

监听 $PORT，绑定 0.0.0.0。
"""
import functools
import http.server
import os
import posixpath
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def translate_path(self, path):
        # 忽略查询串，只按路径取文件
        path = path.split("?", 1)[0].split("#", 1)[0]
        path = posixpath.normpath(path)
        parts = [p for p in path.split("/") if p and p not in (".", "..")]
        return os.path.join(ROOT, *parts)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    port = int(os.environ.get("PORT", "3000"))
    handler = functools.partial(Handler, directory=ROOT)
    with Server(("0.0.0.0", port), handler) as httpd:
        sys.stderr.write("lexiloop serving %s on 0.0.0.0:%d\n" % (ROOT, port))
        httpd.serve_forever()


if __name__ == "__main__":
    main()
