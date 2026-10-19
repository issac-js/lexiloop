"""探测云端大模型的限流规则：不同并发/间隔下的成功率。"""
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = __import__('os').environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = __import__('os').environ.get('LEXILOOP_TEST_PASSWORD', '')
MODEL = "deepseek-v4.1-flash"

LOG = open("ratelimit.log", "w", encoding="utf-8")


def say(m):
    print(m, flush=True)
    LOG.write(m + "\n")
    LOG.flush()


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    page = b.new_page(viewport={"width": 520, "height": 900})
    page.set_default_timeout(300000)
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
      const q = mv ? '?v=' + mv[1] : '';
      window.__L = { en: await import('/js/enrich.js' + q) };
    }""")

    say("先单发一次，看是否仍被限流（等待 20 秒让限流窗口过去）")
    page.wait_for_timeout(20000)

    def one(label, n):
        r = page.evaluate(
            """async ([n, model]) => {
              const { en } = window.__L;
              const t0 = performance.now();
              const run = async (i) => {
                try {
                  const res = await en.enrichTerm('rate probe ' + i, { model, timeoutMs: 120000 });
                  return { ok: true, n: res.data.collocations.length };
                } catch (e) {
                  return { ok: false, why: String((e && e.message) || e).slice(0, 70) };
                }
              };
              const out = await Promise.all(Array.from({ length: n }, (_, i) => run(i)));
              return { ms: Math.round(performance.now() - t0), out };
            }""",
            [n, MODEL],
        )
        okc = sum(1 for x in r["out"] if x["ok"])
        why = next((x["why"] for x in r["out"] if not x["ok"]), "")
        say("  %-28s 并发 %d → 成功 %d/%d  %dms  %s" % (label, n, okc, n, r["ms"], why))

    # 注意：用不存在的词，模型可能返回空搭配；这里只看「是否被限流」
    say("")
    say("== 并发探测 ==")
    one("单发", 1)
    page.wait_for_timeout(8000)
    one("并发 2", 2)
    page.wait_for_timeout(8000)
    one("并发 3", 3)

    say("")
    say("== 间隔探测：并发 1，每次间隔 12 秒，连做 5 次 ==")
    okc = 0
    for i in range(5):
        r = page.evaluate(
            """async ([model, i]) => {
              const { en } = window.__L;
              try { const res = await en.enrichTerm('probe word ' + i, { model, timeoutMs: 120000 });
                    return { ok: true }; }
              catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 70) }; }
            }""",
            [MODEL, i],
        )
        if r["ok"]:
            okc += 1
        say("  第 %d 次：%s %s" % (i + 1, "成功" if r["ok"] else "失败", r.get("why", "")))
        page.wait_for_timeout(12000)
    say("  串行成功率 %d/5" % okc)

    b.close()
say("done")
