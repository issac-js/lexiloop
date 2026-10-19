"""桌面端布局检查：登录后在大屏视口下截图各页面。"""
import os
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))

with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    ctx = b.new_context(viewport={"width": 1366, "height": 900}, device_scale_factor=1.5)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append("[console] %s" % m.text) if m.type == "error" else None)

    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)
    page.screenshot(path=os.path.join(HERE, "desk-00-login.png"))

    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    page.wait_for_timeout(2500)
    page.screenshot(path=os.path.join(HERE, "desk-01-today.png"))

    for tab, name in [("study", "02-study"), ("library", "03-library"), ("stats", "04-stats"), ("me", "05-me")]:
        page.click('[data-tab="%s"]' % tab)
        page.wait_for_timeout(2200)
        page.screenshot(path=os.path.join(HERE, "desk-%s.png" % name))

    # 侧栏是否真的变成横向排布
    nav = page.evaluate("""() => {
      const n = document.querySelector('.tabbar');
      const cs = getComputedStyle(n);
      return { flexDirection: cs.flexDirection, width: cs.width, position: cs.position };
    }""")
    print("侧栏样式：", nav)
    print("控制台错误 %d 条" % len(errs))
    for e in errs[:8]:
        print("  ", e)
    ctx.close()
    b.close()
print("done")
