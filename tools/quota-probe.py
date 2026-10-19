"""判断限流是全模型还是单模型；并读取模型列表里的额度信息。"""
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = __import__('os').environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = __import__('os').environ.get('LEXILOOP_TEST_PASSWORD', '')

LOG = open("quota.log", "w", encoding="utf-8")


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

    info = page.evaluate("""async () => {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const mv = /js\\/app\\.js\\?v=(\\d+)/.exec(html);
      const q = mv ? '?v=' + mv[1] : '';
      const c = await import('/js/cloud.js' + q);
      const list = await c.listModels();
      const auto = await c.resolveAutoModel();
      return {
        count: list.length,
        auto: auto && auto.id,
        first: list.slice(0, 3).map(m => ({ id: m.id, name: m.name, credits: m.credits, keys: Object.keys(m) })),
        sample: JSON.stringify(list[0])
      };
    }""")
    say("模型数：%d　自动选中：%s" % (info["count"], info["auto"]))
    say("首项字段：%s" % info["first"][0]["keys"])
    say("首项完整：%s" % info["sample"][:500])

    # 逐个模型试一次最小调用
    say("")
    say("== 每个模型发一次最小请求 ==")
    trial = page.evaluate("""async () => {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const mv = /js\\/app\\.js\\?v=(\\d+)/.exec(html);
      const q = mv ? '?v=' + mv[1] : '';
      const c = await import('/js/cloud.js' + q);
      const list = await c.listModels();
      const out = [];
      for (const m of list.slice(0, 8)) {
        const t0 = performance.now();
        try {
          let txt = '';
          for await (const ch of c.getCloud().llm.chat.completions.create({
            model: m.id,
            messages: [{ role: 'user', content: 'say OK' }],
            stream: true, max_tokens: 10
          })) {
            const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
            if (d && d.content) txt += d.content;
          }
          out.push({ id: m.id, ms: Math.round(performance.now() - t0), ok: true, txt: txt.slice(0, 12) });
        } catch (e) {
          out.push({ id: m.id, ms: Math.round(performance.now() - t0), ok: false,
                     why: String((e && e.error && e.error.message) || (e && e.message) || e).slice(0, 90) });
        }
      }
      return out;
    }""")
    for r in trial:
        say("  %-26s %6dms  %s %s" % (r["id"], r["ms"], "OK" if r["ok"] else "FAIL", r.get("txt") or r.get("why", "")))

    b.close()
say("done")
