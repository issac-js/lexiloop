"""逐个模型测限流情况：每个模型连发 3 次，看哪些可用。"""
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = __import__('os').environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = __import__('os').environ.get('LEXILOOP_TEST_PASSWORD', '')
MODELS = ["deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-pro",
          "hunyuan-chat", "hy3", "glm-5.3", "auto", "default"]

LOG = open("permodel.log", "w", encoding="utf-8")


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
    page.evaluate("""async () => {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const mv = /js\\/app\\.js\\?v=(\\d+)/.exec(html);
      window.__C = await import('/js/cloud.js' + (mv ? '?v=' + mv[1] : ''));
    }""")

    say("%-24s %s" % ("模型", "3 次结果"))
    say("-" * 74)
    for mid in MODELS:
        r = page.evaluate("""async (mid) => {
          const c = window.__C;
          const res = [];
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            try {
              let t = '';
              for await (const ch of c.getCloud().llm.chat.completions.create({
                model: mid,
                messages: [{ role: 'user', content: 'Reply with: OK' }],
                stream: true, max_tokens: 8
              })) {
                const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
                if (d && d.content) t += d.content;
              }
              res.push({ ok: true, ms: Math.round(performance.now() - t0) });
            } catch (e) {
              res.push({ ok: false, ms: Math.round(performance.now() - t0),
                         why: String((e && e.error && e.error.message) || (e && e.message) || e).slice(0, 40) });
            }
          }
          return res;
        }""", mid)
        summary = "  ".join(("✓%dms" % x["ms"]) if x["ok"] else "✗" for x in r)
        first_fail = next((x["why"] for x in r if not x["ok"]), "")
        say("%-24s %s   %s" % (mid, summary, first_fail))
        time.sleep(1)

    b.close()
say("done")
