"""本地目视检查：截图登录页，并捕获控制台错误。"""
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8899/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "shot.png"
WIDTH = int(sys.argv[3]) if len(sys.argv) > 3 else 390
HEIGHT = int(sys.argv[4]) if len(sys.argv) > 4 else 844

with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    page = b.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=2)
    logs = []
    page.on("console", lambda m: logs.append("[%s] %s" % (m.type, m.text)))
    page.on("pageerror", lambda e: logs.append("[pageerror] %s" % e))
    page.goto(URL, wait_until="networkidle", timeout=45000)
    page.wait_for_timeout(2500)
    page.screenshot(path=OUT, full_page=True)
    print("saved", OUT)
    print("--- console ---")
    for l in logs:
        print(l)
    b.close()
