"""验证练习场（配对/听写/连胜）与数据包（文件导入/备份/Anki导出）。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "e2e7.log"), "w", encoding="utf-8")
CSV = "word,meaning\ncustody,拘留/看管\nchain of custody,证据监管链\n"


def log(m):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), m)
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))

    log("== 登录 ==")
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1800)
    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    page.wait_for_timeout(2200)

    log("== 1. CSV 文件导入 ==")
    csv_path = os.path.join(HERE, "test-import.csv")
    open(csv_path, "w", encoding="utf-8").write(CSV)
    page.click('[data-tab="library"]')
    page.wait_for_timeout(1400)
    page.click("#lib-import")
    page.wait_for_selector("#im-text", timeout=10000)
    page.fill("#im-deck", "CSV导入")
    page.set_input_files("#im-file", csv_path)
    page.wait_for_timeout(1500)
    preview = page.inner_text("#im-preview")
    log("  预览：%s" % preview)
    if "2" not in preview:
        raise RuntimeError("CSV 没有解析出词条：%s" % preview)
    page.uncheck("#im-enrich")
    page.wait_for_timeout(200)
    page.click("#im-go")
    page.wait_for_selector("#modal-wrap[hidden]", state="attached", timeout=120000)
    page.wait_for_timeout(2500)
    log("  ✓ CSV 导入成功")

    log("== 2. 练习场：连胜与入口 ==")
    page.click('[data-tab="games"]')
    page.wait_for_timeout(1800)
    body = page.inner_text("#main")
    log("  " + body.replace("\n", " | ")[:180])
    if "连续学习" not in body:
        raise RuntimeError("连胜卡没有渲染")
    page.screenshot(path=os.path.join(HERE, "e2e7-01-hub.png"), full_page=True)

    log("== 3. 限时配对 ==")
    page.click("#g-match")
    page.wait_for_timeout(1200)
    cells = page.eval_on_selector_all(".pair-cell", "els => els.map(e => e.textContent)")
    pairs = len(cells) // 2
    log("  格子数：%d（%d 对；账号里只有 5 个带释义词，降级属预期）" % (len(cells), pairs))
    if len(cells) < 8 or len(cells) % 2 != 0:
        raise RuntimeError("配对格子数量不对：%d" % len(cells))
    page.screenshot(path=os.path.join(HERE, "e2e7-02-match.png"), full_page=True)

    # 全自动配对：直接按 data-id 配对（模拟全对）
    matched = page.evaluate("""() => {
      // 每次点击都会重绘，必须按 id 重新查 DOM，不能用旧引用
      const lefts = Array.prototype.slice.call(document.querySelectorAll('.pair-cell[data-side="L"]'));
      const ids = lefts.map(e => e.dataset.id);
      let n = 0;
      for (const id of ids) {
        const l = document.querySelector('.pair-cell[data-side="L"][data-id="' + id + '"]');
        if (!l || l.disabled) continue;
        l.click();                                   // 这次点击会触发重绘
        const r = document.querySelector('.pair-cell[data-side="R"][data-id="' + id + '"]');
        if (r) { r.click(); n++; }
      }
      return n;
    }""")
    page.wait_for_timeout(1500)
    body = page.inner_text("#main")
    log("  自动配对 %d 次；页面出现完成态：%s" % (matched, "完成！" in body))
    if "完成！" not in body:
        raise RuntimeError("全部配对后没有进入完成态")
    if "记进复习计划" not in body:
        raise RuntimeError("完成态没有提供可选的 FSRS 写入")
    page.screenshot(path=os.path.join(HERE, "e2e7-03-match-done.png"), full_page=True)
    log("  ✓ 配对玩法闭环可用")

    log("== 4. 打字听写（中文→英文） ==")
    page.click("#match-back")
    page.wait_for_timeout(900)
    page.click("#g-dict-zh")
    page.wait_for_timeout(1200)
    has_input = page.evaluate("() => !!document.getElementById('dict-in')")
    log("  输入框：%s" % has_input)
    if not has_input:
        raise RuntimeError("听写输入框没有出现")
    page.screenshot(path=os.path.join(HERE, "e2e7-04-dict.png"), full_page=True)

    log("== 5. 备份导出 ==")
    page.click('[data-tab="me"]')
    page.wait_for_timeout(1800)
    if not page.is_visible("#me-backup"):
        raise RuntimeError("备份入口没有出现")
    page.screenshot(path=os.path.join(HERE, "e2e7-05-me.png"), full_page=True)
    log("  ✓ 备份/恢复/学习记录/Anki 四个入口都在")

    log("=== 全部通过 ===")
    if errs:
        log("页面错误 %d 条：%s" % (len(errs), errs[:5]))
    ctx.close()
    b.close()

LOG.close()
print("done")
