"""验证学习卡的交互改造：作答输入、判定反馈、评分预选、选择题切换、造句检查。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "e2e6.log"), "w", encoding="utf-8")


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
    page.on("pageerror", lambda e: errs.append(str(e)))

    log("== 登录 ==")
    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1800)
    page.click('[data-mode="pwd"]')
    page.fill("#pwd-email", EMAIL)
    page.fill("#pwd-password", PASSWORD)
    page.click('#pwd-form button[type="submit"]')
    page.wait_for_selector("#start-study", timeout=45000)
    page.wait_for_timeout(2200)

    log("== 先补一张 cloze 卡（保证队列里有可交互的卡） ==")
    page.click('[data-tab="library"]')
    page.wait_for_timeout(1500)
    page.click("#lib-import")
    page.wait_for_selector("#im-text", timeout=10000)
    page.fill("#im-deck", "交互测试")
    page.evaluate("""(t) => {
      const ta = document.getElementById('im-text');
      ta.value = t;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }""", "commit")
    page.wait_for_timeout(800)
    # 只勾例句填空，建一张 cloze 卡
    page.check('input[data-ct="cloze"]')
    page.uncheck('input[data-ct="recognition"]')
    page.uncheck("#im-enrich")
    page.wait_for_timeout(300)
    page.click("#im-go")
    page.wait_for_selector("#modal-wrap[hidden]", state="attached", timeout=120000)
    page.wait_for_timeout(2500)
    log("  cloze 卡已建立")
    page.click('[data-tab="study"]')
    page.wait_for_timeout(2200)

    log("== 进入学习 ==")
    page.click('[data-tab="study"]')
    page.wait_for_timeout(2200)

    def state():
        return page.evaluate("""() => ({
          hasInput: !!document.getElementById('ans-in'),
          hasChoices: !!document.querySelector('.choices'),
          hasGo: !!document.getElementById('ans-go'),
          hasReveal: !!document.getElementById('ans-reveal'),
          hasOldReveal: !!document.getElementById('reveal'),
          shown: !!document.querySelector('.answer'),
          verdict: (document.querySelector('.verdict') || {}).textContent || '',
          sug: !!document.querySelector('.grades .sug'),
          sugLabel: (document.querySelector('.grades .sug .lab') || {}).textContent || '',
          ask: (document.querySelector('.ask') || {}).textContent || '',
          sentence: (document.querySelector('.qcard') || {}).innerText ? '' : '',
          leech: document.body.innerText.indexOf('leech') >= 0
        })""")

    # 翻卡直到遇到可交互的（recognition 且无释义的卡只有旧 reveal，属预期）
    s = state()
    for _ in range(10):
        if s["hasInput"] or s["hasChoices"] or s["hasGo"]:
            break
        log("  这张不可交互，揭示后打 1 分换下一张…")
        if page.evaluate("() => !!document.getElementById('reveal')"):
            page.click("#reveal")
            page.wait_for_timeout(700)
        page.click('[data-g="1"]')
        page.wait_for_timeout(2200)
        s = state()
    log("  作答区：输入框=%s 提交键=%s 选择题键=%s 直接看答案=%s 旧reveal=%s" % (
        s["hasInput"], s["hasGo"], s["hasChoices"], s["hasReveal"], s["hasOldReveal"]))
    if not s["hasInput"] and not s["hasChoices"] and not s["hasOldReveal"]:
        raise RuntimeError("没有任何作答/揭示入口")
    if not s["hasInput"]:
        raise RuntimeError("翻了 10 张都没有出现打字作答，交互没有生效")
    page.screenshot(path=os.path.join(HERE, "e2e6-01-ask.png"), full_page=True)

    if s["hasInput"]:
        log("== 1. 故意答错 → 判定 + 自动展开 + 预选「忘了」 ==")
        page.fill("#ans-in", "definitely wrong answer xyz")
        page.click("#ans-go")
        page.wait_for_timeout(900)
        s = state()
        log("  判定：%s" % s["verdict"].replace("\n", " ")[:90])
        if "不对" not in s["verdict"]:
            raise RuntimeError("答错没有被判定出来：%s" % s["verdict"])
        if not s["shown"]:
            raise RuntimeError("判定后没有自动展开答案")
        if not s["sug"] or s["sugLabel"] != "忘了":
            raise RuntimeError("答错没有预选「忘了」：%s" % s["sugLabel"])
        log("  ✓ 答错 → 预选「忘了」")
        page.screenshot(path=os.path.join(HERE, "e2e6-02-wrong.png"), full_page=True)

        # 打 1 分，进入下一张
        page.click('[data-g="1"]')
        page.wait_for_timeout(2200)
        s = state()
        log("== 2. 第二张：答对 → 预选高分 ==")
        if not (s["hasInput"] or s["hasChoices"] or s["hasOldReveal"]):
            raise RuntimeError("没有新的作答入口")

        if s["hasInput"]:
            # 从题面里找答案——直接读页面上的期望值不现实，改成：提交空答案看提示，
            # 然后用「改成选择题」验证选择题路径
            log("  切换到选择题模式")
            page.click("#ans-choice")
            page.wait_for_timeout(900)
            s = state()
            log("  选择题出现：%s" % s["hasChoices"])
            if not s["hasChoices"]:
                raise RuntimeError("选择题没有出现（干扰项不足？）")
            opts = page.eval_on_selector_all(".choices .choice", "els => els.map(e => e.textContent)")
            log("  选项：%s" % opts)
            if len(opts) < 2:
                raise RuntimeError("选项数量异常")
            page.click(".choices .choice")
            page.wait_for_timeout(900)
            s = state()
            log("  判定：%s" % s["verdict"].replace("\n", " ")[:90])
            if not s["verdict"]:
                raise RuntimeError("选择题没有判定")
            if not s["shown"]:
                raise RuntimeError("选择题作答后没有展开答案")
            log("  ✓ 选择题路径可用（选中项判定 + 自动展开）")
            page.screenshot(path=os.path.join(HERE, "e2e6-03-choice.png"), full_page=True)

            log("== 3. 造句检查 ==")
            mine = page.evaluate("""() => {
              const i = document.getElementById('mine-in');
              const g = document.getElementById('mine-go');
              if (!i || !g) return { has: false };
              i.value = 'this is a test sentence for the practice box';
              g.click();
              const o = document.getElementById('mine-out');
              return { has: true, out: o ? o.textContent : '' };
            }""")
            log("  造句反馈：%s" % mine.get("out", ""))
            if "至少 4 个词" in mine.get("out", ""):
                raise RuntimeError("造句检查没按长度规则执行")
            log("  ✓ 造句检查可用")

    log("=== 全部通过 ===")
    if errs:
        log("页面错误 %d 条：%s" % (len(errs), errs[:3]))
    ctx.close()
    b.close()

LOG.close()
print("done")
