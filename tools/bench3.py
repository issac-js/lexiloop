"""确认 DeepSeek-V4.1-Flash 的速度与 token 消耗（多个词，避免单点偶然）。"""
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = __import__('os').environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = __import__('os').environ.get('LEXILOOP_TEST_PASSWORD', '')
MODEL = "deepseek-v4.1-flash"
WORDS = ["work order", "follow up on sth", "in the order they were received",
         "walk sb. through sth", "abide by", "prompt attention"]

LOG = open("bench3.log", "w", encoding="utf-8")


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
    say("模型 = %s，共 %d 个词\n" % (MODEL, len(WORDS)))
    say("%-38s %8s %8s %8s %6s" % ("词条", "耗时", "输入tok", "输出tok", "搭配"))
    say("-" * 76)

    total_in = 0
    total_out = 0
    times = []

    for w in WORDS:
        t0 = time.time()
        try:
            r = page.evaluate("""async ([modelId, word]) => {
              // 跟随首页里的版本号，否则无版本号 URL 可能命中 CDN 的旧副本
              const html = await (await fetch('/', { cache: 'no-store' })).text();
              const mv = /js\\/app\\.js\\?v=(\\d+)/.exec(html);
              const q = mv ? '?v=' + mv[1] : '';
              const en = await import('/js/enrich.js' + q);
              const c  = await import('/js/cloud.js' + q);
              const pr = en.debugPrompt(word);
              let content = '', usage = null;
              for await (const ch of c.getCloud().llm.chat.completions.create({
                model: modelId,
                messages: [{ role: 'system', content: pr.system }, { role: 'user', content: pr.user }],
                stream: true,
                response_format: { type: 'json_object' },
                temperature: 0.4,
                max_tokens: 1400,
                stream_options: { include_usage: true }
              })) {
                const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
                if (d && d.content) content += d.content;
                if (ch.usage) usage = ch.usage;
              }
              const v = en.validateEntry(content, word);
              return {
                usage,
                colls: v.data ? v.data.collocations.length : -1,
                dropped: v.dropped,
                pats: v.data ? v.data.collocations.map(x => x.pattern) : []
              };
            }""", [MODEL, w])
            dt = time.time() - t0
            u = r["usage"] or {}
            pi = u.get("prompt_tokens", 0) or 0
            po = u.get("completion_tokens", 0) or 0
            total_in += pi
            total_out += po
            times.append(dt)
            say("%-38s %7.1fs %8s %8s %6s" % (w[:36], dt, pi, po, r["colls"]))
            if r["pats"]:
                say("     " + " / ".join(r["pats"]))
        except Exception as e:
            say("%-38s %7.1fs  失败：%s" % (w[:36], time.time() - t0, str(e).replace("\n", " ")[:110]))

    if times:
        say("")
        say("平均耗时 %.1fs（最快 %.1fs / 最慢 %.1fs）" % (
            sum(times) / len(times), min(times), max(times)))
        say("平均 token：输入 %.0f / 输出 %.0f / 合计 %.0f" % (
            total_in / len(times), total_out / len(times), (total_in + total_out) / len(times)))
        say("本次 %d 个词共消耗：输入 %d + 输出 %d = %d token" % (
            len(times), total_in, total_out, total_in + total_out))

    b.close()
say("done")
