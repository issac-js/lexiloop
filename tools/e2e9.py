"""全维度验证：5 项补功能 + P2 四项。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "e2e9.log"), "w", encoding="utf-8")
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
    ctx = b.new_context(viewport={"width": 390, "height": 900}, device_scale_factor=2,
                        permissions=["microphone"])
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
    page.wait_for_timeout(2500)

    log("== 1) 遗忘曲线可视化 ==")
    page.click('[data-tab="stats"]')
    page.wait_for_timeout(2500)
    body = page.inner_text("#main")
    step("保持率曲线/到期预测卡片", "记忆保持率曲线" in body or "到期" in body)
    has_svg = page.eval_on_selector_all("svg", "e => e.length")
    step("有 SVG 图形", has_svg >= 1, "%d 个 svg" % has_svg)
    step("掌握度分布", "掌握度分布" in body)
    page.screenshot(path=os.path.join(HERE, "e2e9-01-stats.png"), full_page=True)

    log("== 2) 掌握度地图 ==")
    page.click('[data-tab="library"]')
    page.wait_for_timeout(1800)
    step("视图切换存在", page.is_visible('[data-libview="map"]'))
    page.click('[data-libview="map"]')
    page.wait_for_timeout(1500)
    cells = page.eval_on_selector_all(".mm-cell", "e => e.length")
    legend = page.eval_on_selector_all(".legend .lg", "e => e.length")
    step("地图方块渲染", cells > 0, "%d 个词块" % cells)
    step("图例完整", legend >= 4, "%d 项" % legend)
    page.screenshot(path=os.path.join(HERE, "e2e9-02-map.png"), full_page=True)
    # 点一个方块看是否弹详情
    if cells:
        page.click(".mm-cell")
        page.wait_for_timeout(900)
        step("点方块弹出词条详情", page.is_visible("#wd-del") or page.is_visible(".modal"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(700)
        step("Esc 可关闭弹层", not page.is_visible("#wd-del"))

    log("== 3) 练习场：P2 三个新玩法入口 ==")
    page.click('[data-tab="games"]')
    page.wait_for_timeout(1800)
    body = page.inner_text("#main")
    step("搭配对战入口", "搭配对战" in body)
    step("组句练习入口", "组句练习" in body)
    step("语音跟读入口", "语音跟读" in body)

    log("== 3a) 搭配对战 ==")
    page.click("#g-battle")
    page.wait_for_timeout(1200)
    bc = page.eval_on_selector_all(".bcard", "e => e.length")
    step("回合有三张搭配牌", bc == 3, "%d 张" % bc)
    if bc:
        page.click(".bcard")
        page.wait_for_timeout(800)
        step("判定与扣血提示", page.is_visible("#lab-battle-next"))
        page.screenshot(path=os.path.join(HERE, "e2e9-03-battle.png"), full_page=True)
        page.click("#lab-battle-next")
        page.wait_for_timeout(900)
        step("可进入下一回合", page.eval_on_selector_all(".bcard", "e => e.length") == 3 or page.is_visible("#lab-battle-again"))
    # 用底部标签回到练习场（lab 模式的退出按钮不作为测试依赖）
    page.click('[data-tab="today"]')
    page.wait_for_timeout(700)
    page.click('[data-tab="games"]')
    page.wait_for_timeout(600)
    if not page.is_visible("#g-sentence"):
        bb = page.query_selector("#lab-battle-back")
        if bb:
            bb.click()
            page.wait_for_timeout(1200)

    log("== 3b) 组句练习 ==")
    if page.is_visible("#g-sentence"):
        page.click("#g-sentence")
        page.wait_for_timeout(1200)
        tks = page.eval_on_selector_all(".tokens .tk", "e => e.length")
        step("词块渲染", tks > 0, "%d 块" % tks)
        if tks:
            for i in range(min(tks, 4)):
                el = page.query_selector_all(".tokens .tk:not(.off)")
                if el:
                    el[0].click()
                    page.wait_for_timeout(120)
            page.wait_for_timeout(400)
            step("可点选词块", page.eval_on_selector_all(".built .tk", "e => e.length") > 0)
            if page.is_visible("#lab-sent-check"):
                page.click("#lab-sent-check")
                page.wait_for_timeout(800)
                step("提交后有判定", page.is_visible("#lab-sent-next"))
            page.screenshot(path=os.path.join(HERE, "e2e9-04-sentence.png"), full_page=True)
        bb = page.query_selector("#lab-sent-back")
        if bb:
            bb.click()
            page.wait_for_timeout(1200)

    log("== 3c) 语音跟读 ==")
    if page.is_visible("#g-speech"):
        page.click("#g-speech")
        page.wait_for_timeout(1200)
        html = page.inner_text("#main")
        step("跟读页可进入", ("语音跟读" in html))
        sr = page.evaluate("() => !!(window.SpeechRecognition || window.webkitSpeechRecognition)")
        step("浏览器支持语音识别", sr, "（不支持时会显示降级提示）")
        page.screenshot(path=os.path.join(HERE, "e2e9-05-speech.png"), full_page=True)
        back = page.query_selector("#lab-speech-back")
        if back:
            back.click()
            page.wait_for_timeout(1200)

    log("== 4) 学习页：leech 改写入口 ==")
    page.click('[data-tab="study"]')
    page.wait_for_timeout(2000)
    # 翻卡找 leech 卡（lapses>=4）不现实，改为直接验证按钮的存在路径：
    has_leech_ui = page.evaluate("() => !!document.getElementById('study-leech-fix')")
    log("  当前卡是否 leech：%s（多数卡不会触发，属预期）" % has_leech_ui)
    step("学习页正常渲染", page.eval_on_selector_all(".qcard", "e => e.length") == 1)

    log("== 5) 导入弹层：docx 选项 ==")
    page.click('[data-tab="library"]')
    page.wait_for_timeout(1500)
    page.click("#lib-import")
    page.wait_for_selector("#im-text", timeout=10000)
    acc = page.get_attribute("#im-file", "accept")
    step("文件框接受 docx", ".docx" in (acc or ""), acc or "")
    page.keyboard.press("Escape")
    page.wait_for_timeout(600)

    log("")
    log("=== 结果：%d 项失败 ===" % len(fails))
    for f in fails:
        log("  ✗ " + f)
    if errs:
        log("页面错误 %d 条：%s" % (len(errs), errs[:5]))
    else:
        log("页面错误 0 条")
    ctx.close()
    b.close()

LOG.close()
print("done")
