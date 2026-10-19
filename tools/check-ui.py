"""确认界面能显示文档带来的释义与例句。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "check-ui.log"), "w", encoding="utf-8")


def log(m):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), m)
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1800)
    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    page.wait_for_timeout(2500)

    log("== 学习页：打开一张卡看答案 ==")
    page.click('[data-tab="study"]')
    page.wait_for_timeout(2500)
    if page.is_visible("#reveal"):
        page.click("#reveal")
        page.wait_for_timeout(1200)
    body = page.inner_text("#main")
    log("  卡片内容片段：%s" % body.replace("\n", " | ")[:400])
    has_src = "来自你的文档" in body or "例句（来自你的文档）" in body
    log("  是否显示文档例句：%s" % has_src)
    page.screenshot(path=os.path.join(HERE, "checkui-01-study.png"), full_page=True)

    log("== 词库：抽查几个词的释义 ==")
    page.click('[data-tab="library"]')
    page.wait_for_timeout(2000)
    page.click('[data-deck="语料库-种子"]')
    page.wait_for_timeout(2200)
    picked = page.evaluate("""() => {
      const items = Array.prototype.slice.call(document.querySelectorAll('.list-item'));
      const withDef = items.filter(el => {
        const d = el.querySelector('.d');
        return d && d.textContent.trim().length > 2;
      });
      return { total: items.length, withDef: withDef.length,
               sample: withDef.slice(0, 6).map(el => el.querySelector('.t').textContent + ' → ' + el.querySelector('.d').textContent) };
    }""")
    log("  词条 %d 个，其中带释义 %d 个" % (picked["total"], picked["withDef"]))
    for s in picked["sample"]:
        log("     %s" % s)
    page.screenshot(path=os.path.join(HERE, "checkui-02-library.png"), full_page=True)

    ctx.close()
    b.close()

LOG.close()
print("done")
