"""无障碍与规范检查。"""
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = __import__('os').environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = __import__('os').environ.get('LEXILOOP_TEST_PASSWORD', '')

with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    page = b.new_page(viewport={"width": 390, "height": 900})
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1800)
    r = page.evaluate("""() => ({
      lang: document.documentElement.lang || '(未设置)',
      viewport: !!document.querySelector('meta[name=viewport]'),
      title: document.title || '(空)',
      themeColor: !!document.querySelector('meta[name=theme-color]'),
      manifest: !!document.querySelector('link[rel=manifest]'),
      appleTouch: !!document.querySelector('link[rel=apple-touch-icon]')
    })""")
    print("文档基础:", r)

    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    page.wait_for_timeout(2200)

    a = page.evaluate("""() => {
      const btns = Array.prototype.slice.call(document.querySelectorAll('button'));
      const iconOnly = btns.filter(x => !x.textContent.trim() && !x.getAttribute('aria-label') && !x.title);
      const inputs = Array.prototype.slice.call(document.querySelectorAll('input:not([type=hidden]):not([type=file])'));
      const unlabeled = inputs.filter(i => !i.getAttribute('aria-label') && !i.placeholder);
      return {
        buttons: btns.length,
        iconOnlyNoLabel: iconOnly.length,
        inputs: inputs.length,
        unlabeledInputs: unlabeled.length,
        tabbar: document.querySelectorAll('[data-tab]').length,
        main: !!document.getElementById('main')
      };
    }""")
    print("无障碍:", a)

    page.keyboard.press("Tab")
    page.keyboard.press("Tab")
    focused = page.evaluate("""() => {
      const el = document.activeElement;
      if (!el) return 'none';
      const tag = el.tagName;
      const tab = (el.dataset && el.dataset.tab) ? ('(tab:' + el.dataset.tab + ')') : '';
      return tag + tab;
    }""")
    print("Tab 焦点:", focused)

    # 学习页键盘提交
    page.click('[data-tab="study"]')
    page.wait_for_timeout(2000)
    kb = page.evaluate("""() => {
      const i = document.getElementById('ans-in');
      return { hasAnswerInput: !!i, autofocus: i ? (document.activeElement === i) : false };
    }""")
    print("学习页作答:", kb)
    b.close()
print("done")
