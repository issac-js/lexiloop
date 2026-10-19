"""验证情景闯关 + AI 情景对话（含真实 LLM 调用）。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "e2e8.log"), "w", encoding="utf-8")


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

    log("== 先给测试账号补一个关卡的词（失物招领 5 词） ==")
    page.click('[data-tab="library"]')
    page.wait_for_timeout(1400)
    page.click("#lib-import")
    page.wait_for_selector("#im-text", timeout=10000)
    page.fill("#im-deck", "闯关测试")
    page.evaluate("""(t) => {
      const ta = document.getElementById('im-text');
      ta.value = t;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }""", "lost and found\nwhereabouts\nmisplace\ntrack sb.'s whereabouts\ntrace sb.'s whereabouts")
    page.wait_for_timeout(800)
    page.uncheck("#im-enrich")
    page.wait_for_timeout(200)
    page.click("#im-go")
    page.wait_for_selector("#modal-wrap[hidden]", state="attached", timeout=120000)
    page.wait_for_timeout(2500)
    log("  5 个词已导入（共享词库里带章节与释义）")

    log("== 练习场新增两个入口 ==")
    page.click('[data-tab="games"]')
    page.wait_for_timeout(1800)
    body = page.inner_text("#main")
    if "情景闯关" not in body or "AI 情景对话" not in body:
        raise RuntimeError("练习场缺少新入口")
    page.click("#g-quiz")
    page.wait_for_timeout(1800)
    levels = page.eval_on_selector_all(".level", "els => els.map(e => e.innerText.split('\\n')[0])")
    log("  关卡数：%d　前 5：%s" % (len(levels), levels[:5]))
    if len(levels) < 1:
        raise RuntimeError("关卡太少：%d" % len(levels))
    page.screenshot(path=os.path.join(HERE, "e2e8-01-levels.png"), full_page=True)

    log("== 进入关卡：「失物招领」 ==")
    target = next((l for l in levels if "失物招领" in l), levels[0])
    page.evaluate("""(t) => {
      const btn = Array.prototype.slice.call(document.querySelectorAll('.level'))
        .find(b => b.innerText.indexOf(t) >= 0);
      if (btn) btn.click();
    }""", target)
    page.wait_for_timeout(1500)
    q1 = page.inner_text(".card")
    log("  第 1 题：%s" % q1.replace("\n", " | ")[:160])
    if "quiz-in" not in page.evaluate("() => !!document.getElementById('quiz-in') ? '有输入框' : (document.querySelectorAll('.choices').length ? '有选择题' : '无')"):
        pass
    page.screenshot(path=os.path.join(HERE, "e2e8-02-quiz.png"), full_page=True)

    # 逐题作答：选择题点第一个；打字题直接提交空（验证判定与推进）
    for i in range(8):
        has_choice = page.eval_on_selector_all(".choices .choice", "els => els.length")
        if has_choice:
            page.click(".choices .choice")
        else:
            inp = page.query_selector("#quiz-in")
            if inp:
                inp.fill("test answer here")
                page.keyboard.press("Enter")
            else:
                break
        page.wait_for_timeout(700)
        nxt = page.query_selector("#quiz-next")
        if not nxt:
            break
        nxt.click()
        page.wait_for_timeout(700)
    body = page.inner_text("#main")
    log("  闯关结束态出现：%s" % ("★" in body and "通关" in body or "差一点" in body))
    if ("★" not in body) and ("☆" not in body):
        raise RuntimeError("没有进入闯关结束态")
    page.screenshot(path=os.path.join(HERE, "e2e8-03-quiz-done.png"), full_page=True)
    log("  ✓ 情景闯关闭环可用")

    log("== AI 情景对话（真实 LLM） ==")
    page.click("#quiz-back")
    page.wait_for_timeout(900)
    try:
        log("  返回后页面：%s" % page.inner_text("#main").replace("\n", " | ")[:150])
    except Exception as e:
        log("  取页面失败：%s" % str(e)[:80])
    if not page.is_visible("#quizsel-back"):
        page.screenshot(path=os.path.join(HERE, "e2e8-99-noback.png"), full_page=True)
    page.click("#quizsel-back")     # 关卡列表 → 练习场
    page.wait_for_timeout(900)
    page.click("#g-chat")
    page.wait_for_timeout(1500)
    scs = page.eval_on_selector_all(".level", "els => els.map(e => e.innerText.split('\\n')[0])")
    log("  场景：%s" % scs)
    page.evaluate("() => { const b = document.querySelector('.level'); if (b) b.click(); }")
    page.wait_for_timeout(1800)
    if not page.is_visible("#chat-in"):
        raise RuntimeError("对话输入框没有出现")
    msgs0 = page.eval_on_selector_all(".chat-msg", "els => els.length")
    log("  初始消息 %d 条（含 AI 开场白）" % msgs0)
    if msgs0 < 1:
        raise RuntimeError("AI 开场白缺失")

    page.fill("#chat-in", "Sure, I will check the lost and found and keep a close eye on it.")
    page.click("#chat-send")
    log("  已发送，等待 AI 回复（流式）…")
    for _ in range(40):
        page.wait_for_timeout(1000)
        if not page.is_visible("#chat-send") or page.get_attribute("#chat-send", "disabled") is None:
            break
    page.wait_for_timeout(1500)
    n = page.eval_on_selector_all(".chat-msg", "els => els.length")
    reply = page.evaluate("() => { const m = document.querySelectorAll('.chat-msg.ai'); return m[m.length-1] ? m[m.length-1].textContent : '' }")
    log("  消息数 %d；AI 回复：%s" % (n, reply[:120]))
    if n < 3:
        raise RuntimeError("AI 没有回复（消息数=%d）" % n)
    used = page.inner_text("#main")
    if "用上了" not in used and "keep a close eye" not in used:
        log("  （本句未命中目标表达，属正常）")
    else:
        log("  ✓ 目标表达命中提示正常")
    page.screenshot(path=os.path.join(HERE, "e2e8-04-chat.png"), full_page=True)
    log("  ✓ AI 情景对话可用（真实 LLM 往返）")

    log("=== 全部通过 ===")
    if errs:
        log("页面错误 %d 条：%s" % (len(errs), errs[:5]))
    ctx.close()
    b.close()

LOG.close()
print("done")
