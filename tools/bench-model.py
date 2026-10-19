"""对比候选模型在真实富化任务上的耗时与质量，用于选默认模型。"""
import json
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = __import__('os').environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = __import__('os').environ.get('LEXILOOP_TEST_PASSWORD', '')
CANDIDATES = ["hunyuan-chat", "hy3", "deepseek-v4.1-flash"]
WORD = "custody"
LIMIT_MS = 120000

LOG = open("bench.log", "w", encoding="utf-8")


def say(m):
    print(m, flush=True)
    LOG.write(m + "\n")
    LOG.flush()


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    page = b.new_page(viewport={"width": 390, "height": 844})
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1500)
    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    say("已登录；测试词 = %s；上限 %ds\n" % (WORD, LIMIT_MS // 1000))

    for mid in CANDIDATES:
        t0 = time.time()
        try:
            r = page.evaluate("""async ([modelId, word, limitMs]) => {
              const e = await import('/js/enrich.js');
              const res = await e.enrichTerm(word, { model: modelId, timeoutMs: limitMs });
              const pl = res.data;
              return {
                colls: pl.collocations.length,
                dropped: res.dropped,
                conf: pl.confidence,
                patterns: pl.collocations.map(c => c.pattern),
                first: (pl.collocations[0] && pl.collocations[0].examples[0] || {}).en || ''
              };
            }""", [mid, WORD, LIMIT_MS])
            dt = time.time() - t0
            say("== %-22s %5.1fs  搭配 %d 条 置信 %.2f" % (mid, dt, r["colls"], r["conf"] or 0))
            say("     " + " / ".join(r["patterns"]))
            if r["first"]:
                say("     ex: " + r["first"][:110])
        except Exception as e:
            dt = time.time() - t0
            say("== %-22s %5.1fs  失败：%s" % (mid, dt, str(e).replace("\n", " ")[:150]))
        say("")

    b.close()
say("done")
