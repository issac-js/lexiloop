"""测量安全速率：串行 + 固定间隔，看多少次开始被限流。"""
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = __import__('os').environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = __import__('os').environ.get('LEXILOOP_TEST_PASSWORD', '')

LOG = open("rate2.log", "w", encoding="utf-8")


def say(m):
    print(m, flush=True)
    LOG.write(m + "\n")
    LOG.flush()


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    page = b.new_page(viewport={"width": 520, "height": 900})
    page.set_default_timeout(120000)
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1800)
    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    page.wait_for_timeout(2500)

    for gap in [3, 1]:
        say("== 串行，每次间隔 %d 秒，连做 10 次 ==" % gap)
        ok = 0
        fails = 0
        for i in range(10):
            r = page.evaluate("""async (i) => {
              const html = await (await fetch('/', { cache: 'no-store' })).text();
              const mv = /js\\/app\\.js\\?v=(\\d+)/.exec(html);
              const q = mv ? '?v=' + mv[1] : '';
              const c = await import('/js/cloud.js' + q);
              const t0 = performance.now();
              try {
                let txt = '';
                for await (const ch of c.getCloud().llm.chat.completions.create({
                  model: 'deepseek-v4.1-flash',
                  messages: [{ role: 'user', content: 'Reply with: OK' }],
                  stream: true, max_tokens: 8
                })) {
                  const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
                  if (d && d.content) txt += d.content;
                }
                return { ok: true, ms: Math.round(performance.now() - t0) };
              } catch (e) {
                return { ok: false, ms: Math.round(performance.now() - t0),
                         why: String((e && e.error && e.error.message) || (e && e.message) || e).slice(0, 60) };
              }
            }""", i)
            if r["ok"]:
                ok += 1
            else:
                fails += 1
            say("  #%2d %5dms %s %s" % (i + 1, r["ms"], "OK" if r["ok"] else "FAIL", r.get("why", "")))
            if i < 9:
                page.wait_for_timeout(gap * 1000)
        say("  → 成功 %d/10，失败 %d" % (ok, fails))
        say("")

    b.close()
say("done")
