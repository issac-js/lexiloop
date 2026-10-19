"""验证 leech 改写（真实 LLM）与 docx 导入。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "e2e10.log"), "w", encoding="utf-8")
fails = []


def log(m):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), m)
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()


def step(name, cond, extra=""):
    log("  %s %s%s" % ("✓" if cond else "✗", name, ("　" + extra) if extra else ""))
    if not cond:
        fails.append(name)


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    ctx = b.new_context(viewport={"width": 390, "height": 900}, device_scale_factor=2)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.set_default_timeout(300000)

    log("== 登录 ==")
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1800)
    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    page.wait_for_timeout(2200)

    log("== A) leech 改写（真实 LLM 调用） ==")
    r = page.evaluate("""async () => {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const mv = /js\\/app\\.js\\?v=(\\d+)/.exec(html);
      const q = mv ? '?v=' + mv[1] : '';
      const EN = await import('/js/enrich.js' + q);
      const S = await import('/js/store.js' + q);
      // 用一个语料库里确实存在的词，只跑改写、不落库
      const before = S.state.words.find(w => w.normalized === 'commit');
      const t0 = performance.now();
      const res = await EN.enrichTerm('commit', { mode: 'leech', timeoutMs: 240000 });
      return {
        ms: Math.round(performance.now() - t0),
        n: res.data.collocations.length,
        patterns: res.data.collocations.map(c => c.pattern),
        maxExampleWords: Math.max.apply(null, res.data.collocations.map(c =>
          (((c.examples||[])[0]||{}).en || '').split(/\\s+/).filter(Boolean).length)),
        senses: (res.data.senses || []).length,
        beforeN: ((before && before.payload && before.payload.collocations) || []).length,
      };
    }""")
    log("  耗时 %dms　改写后 %d 条：%s" % (r["ms"], r["n"], r["patterns"]))
    step("leech 模式返回 2 条搭配", r["n"] == 2, "实际 %d 条" % r["n"])
    step("例句更短（≤12 词）", r["maxExampleWords"] <= 12, "最长 %d 词" % r["maxExampleWords"])
    step("释义收敛为 1 条", r["senses"] <= 1, "实际 %d" % r["senses"])

    log("== B) docx 导入 ==")
    page.click('[data-tab="library"]')
    page.wait_for_timeout(1500)
    # 确保在列表视图（地图视图没有导入框以外的差异，但按钮都在）
    if page.is_visible('[data-libview="list"]'):
        page.click('[data-libview="list"]')
        page.wait_for_timeout(800)
    page.click("#lib-import")
    page.wait_for_selector("#im-text", timeout=10000)
    page.set_input_files("#im-file", os.path.join(HERE, "test-import.docx"))
    log("  等待 Word 解析（含 CDN 组件加载）…")
    for _ in range(40):
        page.wait_for_timeout(1000)
        v = page.input_value("#im-text")
        if v and len(v) > 5:
            break
    text = page.input_value("#im-text")
    log("  解析出的文本：%s" % text.replace("\n", " ｜ ")[:160])
    step("docx 成功提取文本", "keep sb. posted" in text)
    step("中文行也在", "随时向某人" in text)
    page.screenshot(path=os.path.join(HERE, "e2e10-01-docx.png"), full_page=True)
    page.keyboard.press("Escape")
    page.wait_for_timeout(600)

    log("")
    log("=== 结果：%d 项失败 ===" % len(fails))
    for f in fails:
        log("  ✗ " + f)
    log("页面错误 %d 条" % len(errs))
    if errs:
        log("  " + str(errs[:3]))
    ctx.close()
    b.close()

LOG.close()
print("done")
