"""诊断：这几个词到底被模型拒绝了，还是被我的校验器误杀了？"""
import json
import os
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))

TERMS = ["concession", "on a case-by-case basis", "at one's discretion",
         "please write legibly", "sub-district", "low-latency"]

with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    page = b.new_page(viewport={"width": 520, "height": 900})
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
      window.__L = { en: await import('/js/enrich.js' + q), c: await import('/js/cloud.js' + q) };
    }""")

    out = page.evaluate(
        """async (terms) => {
          const { en, c } = window.__L;
          const out = [];
          for (const term of terms) {
            const pr = en.debugPrompt(term);
            let raw = '';
            try {
              for await (const ch of c.getCloud().llm.chat.completions.create({
                model: 'hunyuan-chat',
                messages: [{ role: 'system', content: pr.system }, { role: 'user', content: pr.user }],
                stream: true, response_format: { type: 'json_object' },
                temperature: 0.4, max_tokens: 1400
              })) {
                const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
                if (d && d.content) raw += d.content;
              }
            } catch (e) {
              out.push({ term, error: String((e && e.message) || e).slice(0, 120) });
              continue;
            }
            const v = en.validateEntry(raw, term);
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (e) {}
            out.push({
              term,
              modelReturned: parsed && parsed.collocations ? parsed.collocations.map(x => x.pattern) : '(解析失败)',
              kept: v.data ? v.data.collocations.map(x => x.pattern) : [],
              notes: v.notes,
              rawLen: raw.length
            });
          }
          return out;
        }""",
        TERMS,
    )

    for o in out:
        print("=" * 78)
        print("词条:", o["term"])
        if "error" in o:
            print("  请求失败:", o["error"])
            continue
        print("  模型给出 %d 条搭配:" % len(o["modelReturned"]))
        for m in o["modelReturned"]:
            print("     ·", m)
        print("  校验后保留 %d 条:" % len(o["kept"]), o["kept"])
        if o.get("notes"):
            print("  备注:", o["notes"])

    with open(os.path.join(HERE, "diag.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    b.close()
print("done")
