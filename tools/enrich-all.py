"""批量生成语料库词条的搭配，写入共享词库（Kevin 的账号直接可见）。

走应用自己的 enrichTerm + putWord，所以提示词、防幻觉校验、缓存策略全部与 UI 一致。
"""
import io
import json
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
CONCURRENCY = 2
MODEL = "hunyuan-chat"

LOG = open(os.path.join(HERE, "enrich-all.log"), "w", encoding="utf-8")
terms = [t.strip() for t in open(os.path.join(HERE, "seed-terms.txt"), encoding="utf-8").read().split("\n") if t.strip()]
terms = sorted(set(terms))
done = set(t.strip() for t in io.open(os.path.join(HERE, "done-terms.txt"), encoding="utf-8").read().split("\n") if t.strip())
terms = [t for t in terms if t not in done]


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
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))

    log("== 登录 ==")
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1800)
    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    page.wait_for_timeout(2500)
    log("  已登录；待处理 %d 个词；模型 %s；并发 %d" % (len(terms), MODEL, CONCURRENCY))

    page.evaluate("""async () => {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const mv = /js\\/app\\.js\\?v=(\\d+)/.exec(html);
      const q = mv ? '?v=' + mv[1] : '';
      window.__L = {
        en: await import('/js/enrich.js' + q),
        st: await import('/js/store.js' + q)
      };
    }""")
    log("  模块已加载")

    t0 = time.time()
    # 把词表交给页面，在页面内并发跑
    result = page.evaluate(
        """async ([list, model, conc]) => {
          const { en, st } = window.__L;
          const out = { ok: [], fail: [], skip: [], firstColls: [] };
          let cursor = 0;
          const worker = async () => {
            for (;;) {
              const i = cursor++;
              if (i >= list.length) return;
              const term = list[i];
              // 已有搭配就跳过（可重复运行 / 断点续跑）
              const existing = st.state.words.find(w => w.normalized === term);
              if (existing && existing.payload && (existing.payload.collocations || []).length) {
                out.skip.push(term);
                self.__prog = out.ok.length + out.fail.length + out.skip.length;
                continue;
              }
              try {
                const res = await en.enrichTerm(term, { model: model, timeoutMs: 120000 });
                await st.putWord(term, res.data.lemma || term, res.data);
                out.ok.push(term);
                if (out.firstColls.length < 8) {
                  out.firstColls.push({ term: term, n: res.data.collocations.length,
                                        sample: res.data.collocations.slice(0, 3).map(c => c.pattern) });
                }
              } catch (e) {
                out.fail.push({ term: term, why: String((e && e.message) || e).slice(0, 90) });
              }
              self.__prog = out.ok.length + out.fail.length + out.skip.length;
            }
          };
          await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
          return out;
        }""",
        [terms, MODEL, CONCURRENCY],
    )

    dt = time.time() - t0
    log("")
    log("== 完成，用时 %.1f 分钟 ==" % (dt / 60))
    log("  成功 %d ／ 失败 %d ／ 跳过（已有） %d" % (
        len(result["ok"]), len(result["fail"]), len(result["skip"])))
    log("")
    log("  样例（前 8 个）：")
    for s in result["firstColls"]:
        log("    %-44s %d 条：%s" % (s["term"][:42], s["n"], " / ".join(s["sample"])[:90]))
    if result["fail"]:
        log("")
        log("  失败明细（前 15 个）：")
        for f in result["fail"][:15]:
            log("    %-44s %s" % (f["term"][:42], f["why"]))

    with open(os.path.join(HERE, "enrich-result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    log("页面错误 %d 条" % len(errs))
    ctx.close()
    b.close()

LOG.close()
print("done")
