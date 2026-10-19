"""模型对比：真实富化提示词下，各模型的耗时与 token 消耗。"""
import json
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = __import__('os').environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = __import__('os').environ.get('LEXILOOP_TEST_PASSWORD', '')
CANDIDATES = ["deepseek-v4.1-flash", "hy3", "glm-5.3-flash", "hunyuan-chat"]
WORD = "custody"
CAP_MS = 300000

LOG = open("bench2.log", "w", encoding="utf-8")


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
    say("已登录；测试词 = %s\n" % WORD)
    say("%-22s %8s %10s %10s %8s  %s" % ("模型", "耗时", "输入tok", "输出tok", "搭配数", "评估"))
    say("-" * 84)

    for mid in CANDIDATES:
        t0 = time.time()
        try:
            r = page.evaluate("""async ([modelId, word, capMs]) => {
              const en = await import('/js/enrich.js');
              const c  = await import('/js/cloud.js');
              const pr = en.debugPrompt(word);
              const ctl = new AbortController();
              const timer = setTimeout(() => ctl.abort(), capMs);
              let content = '', usage = null;
              try {
                for await (const ch of c.getCloud().llm.chat.completions.create({
                  model: modelId,
                  messages: [
                    { role: 'system', content: pr.system },
                    { role: 'user', content: pr.user }
                  ],
                  stream: true,
                  response_format: { type: 'json_object' },
                  temperature: 0.4,
                  max_tokens: 1400,
                  stream_options: { include_usage: true },
                  signal: ctl.signal
                })) {
                  const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
                  if (d && d.content) content += d.content;
                  if (ch.usage) usage = ch.usage;
                }
              } finally { clearTimeout(timer); }

              let colls = -1, conf = null, pats = [];
              const v = en.validateEntry(content, word);
              if (v.data) {
                colls = v.data.collocations.length;
                conf = v.data.confidence;
                pats = v.data.collocations.map(x => x.pattern);
              }
              return { usage, colls, conf, pats, rawLen: content.length };
            }""", [mid, WORD, CAP_MS])
            dt = time.time() - t0
            u = r["usage"] or {}
            pt = u.get("prompt_tokens", "?")
            ct = u.get("completion_tokens", "?")
            rt = (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
            verdict = "可用于默认" if (dt < 120 and r["colls"] >= 3) else ("偏慢但可用" if r["colls"] >= 3 else "校验未通过")
            say("%-22s %7.1fs %10s %10s %8s  %s" % (mid, dt, pt, ct, r["colls"], verdict))
            if rt:
                say("    其中推理 token：%s" % rt)
            if r["pats"]:
                say("    " + " / ".join(r["pats"]))
        except Exception as e:
            say("%-22s %7.1fs  失败：%s" % (mid, time.time() - t0, str(e).replace("\n", " ")[:120]))
        say("")

    b.close()
say("done")
