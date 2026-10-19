"""确认文档例句真的渲染出来（打开一个明确带例句的词）。"""
import os
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))

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
    page.wait_for_timeout(2200)

    page.click('[data-tab="library"]')
    page.wait_for_timeout(2000)

    found = page.evaluate("""() => {
      const items = Array.prototype.slice.call(document.querySelectorAll('.list-item'));
      const hit = items.find(el => el.querySelector('.t').textContent.trim() === 'commit');
      if (hit) hit.click();
      return !!hit;
    }""")
    print("找到 keep sb. posted：", found)
    page.wait_for_selector("#wd-del", timeout=10000)
    page.wait_for_timeout(800)
    modal = page.inner_text(".modal")
    print("---- 详情页内容 ----")
    print(modal[:700])
    print("--------------------")
    has_src = "来自你的文档" in modal
    has_en = "I'll keep you posted" in modal or "keep you posted" in modal
    print("显示文档例句分区：", has_src)
    print("例句正文出现：", has_en)
    page.screenshot(path=os.path.join(HERE, "checkui-03-detail.png"), full_page=True)

    # 再抽查一个学习卡，强制选到带例句的词
    ctx.close()
    b.close()
print("done")
