"""重试可 enrichment 的失败词条（对比类/整句类不重试）。"""
import io
import json
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = "hunyuan-chat"

RETRY = ["confirm with sb"]

LOG = open(os.path.join(HERE, "retry.log"), "w", encoding="utf-8")


def log(m):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), m)
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    ctx = b.new_context(viewport={"width": 520, "height": 900})
    page = ctx.new_page()
    page.set_default_timeout(600000)
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
      window.__L = { en: await import('/js/enrich.js' + q), st: await import('/js/store.js' + q) };
    }""")
    log("待重试 %d 个，模型 %s" % (len(RETRY), MODEL))

    out = page.evaluate(
        """async ([list, model]) => {
          const { en, st } = window.__L;
          const out = { ok: [], fail: [] };
          for (const term of list) {
            try {
              const res = await en.enrichTerm(term, { model: model, timeoutMs: 120000 });
              await st.putWord(term, res.data.lemma || term, res.data);
              out.ok.push({ term: term, n: res.data.collocations.length,
                            sample: res.data.collocations.slice(0, 2).map(c => c.pattern) });
            } catch (e) {
              out.fail.push({ term: term, why: String((e && e.message) || e).slice(0, 70) });
            }
          }
          return out;
        }""",
        [RETRY, MODEL],
    )

    log("成功 %d / 失败 %d" % (len(out["ok"]), len(out["fail"])))
    for s in out["ok"]:
        log("  ✓ %-34s %d 条：%s" % (s["term"][:32], s["n"], " / ".join(s["sample"])[:70]))
    for f in out["fail"]:
        log("  ✗ %-34s %s" % (f["term"][:32], f["why"]))

    ctx.close()
    b.close()

LOG.close()
print("done")
