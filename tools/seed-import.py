"""用测试账号把语料库写进共享词库（words 表是全局共享缓存）。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
SRC = r"C:\Users\cs198\Desktop\英语表达语料库.md"
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "seed.log"), "w", encoding="utf-8")

doc = open(SRC, encoding="utf-8").read()


def log(m):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), m)
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))

    log("== 登录测试账号 ==")
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1800)
    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    page.wait_for_timeout(2000)
    log("  已登录")

    log("== 导入语料库（只建词条+释义，不跑 AI） ==")
    page.click('[data-tab="library"]')
    page.wait_for_timeout(1200)
    page.click("#lib-import")
    page.wait_for_selector("#im-text", timeout=10000)
    page.fill("#im-deck", "语料库-种子")
    page.evaluate("""(t) => {
      const ta = document.getElementById('im-text');
      ta.value = t;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }""", doc)
    page.wait_for_timeout(2500)
    log("  预览：%s" % page.inner_text("#im-preview"))
    page.uncheck("#im-enrich")
    page.wait_for_timeout(300)

    t0 = time.time()
    page.click("#im-go")
    page.wait_for_selector("#modal-wrap[hidden]", state="attached", timeout=300000)
    log("  导入完成，耗时 %.1f 秒" % (time.time() - t0))
    page.wait_for_timeout(4000)

    # 记下词单里的词条数，供 SQL 侧核对
    page.click('[data-deck="语料库-种子"]')
    page.wait_for_timeout(2500)
    names = page.eval_on_selector_all(".list-item .t", "els => els.map(e => e.textContent)")
    log("  该词单词条数：%d" % len(names))
    with open(os.path.join(HERE, "seed-terms.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(names))
    page.screenshot(path=os.path.join(HERE, "seed-01.png"), full_page=True)
    log("  词条清单已写入 seed-terms.txt")
    log("页面错误 %d 条" % len(errs))
    ctx.close()
    b.close()

LOG.close()
print("done")
