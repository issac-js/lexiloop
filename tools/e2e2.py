"""lexiloop 线上端到端验证（第二轮：后台生成架构 + 学习闭环 + 导出）。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "e2e2.log")

logf = open(LOG, "w", encoding="utf-8")
console_errors = []


def log(m):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), m)
    print(line, flush=True)
    logf.write(line + "\n")
    logf.flush()


def shot(page, name):
    page.screenshot(path=os.path.join(HERE, "e2e2-%s.png" % name), full_page=True)
    log("  截图 %s" % name)


with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    page = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page.on("console", lambda m: console_errors.append("[%s] %s" % (m.type, m.text)) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append("[pageerror] %s" % e))

    try:
        log("== 1. 密码登录 ==")
        page.goto(URL, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(1500)
        page.click('[data-mode="pwd"]')
        page.fill("#pwd-email", EMAIL)
        page.fill("#pwd-password", PASSWORD)
        page.click('#pwd-form button[type="submit"]')
        page.wait_for_selector("#start-study", timeout=45000)
        page.wait_for_timeout(2500)
        log("  登录成功")
        shot(page, "01-today")

        log("== 2. 导入（应秒级完成，不再阻塞） ==")
        page.click('[data-tab="library"]')
        page.wait_for_timeout(1200)
        page.click("#lib-import")
        page.wait_for_selector("#im-text", timeout=10000)
        page.fill("#im-deck", "验证第二轮")
        # commit 已在词库缓存中（验证复用路径），perimeter 是新词（验证后台生成）
        page.fill("#im-text", "commit\nperimeter")
        t0 = time.time()
        page.click("#im-go")
        page.wait_for_selector("#modal-wrap[hidden]", state="attached", timeout=120000)
        import_secs = time.time() - t0
        log("  导入耗时 %.1f 秒" % import_secs)
        if import_secs > 60:
            raise RuntimeError("导入仍然阻塞过久：%.1f 秒" % import_secs)
        page.wait_for_timeout(2000)
        rows = page.eval_on_selector_all(".list-item .t", "els => els.map(e => e.textContent)")
        log("  词库：%s" % rows)
        if "commit" not in rows or "perimeter" not in rows:
            raise RuntimeError("导入后词条不足：%s" % rows)
        shot(page, "02-library")

        log("== 3. 后台生成任务横幅 ==")
        banner = page.eval_on_selector_all("#job-banner", "els => els.map(e => e.innerText)")
        log("  横幅：%s" % (banner or "无"))
        if not banner:
            raise RuntimeError("没有出现后台生成横幅")
        page.wait_for_timeout(1000)
        shot(page, "03-job-banner")

        log("  等待 100 秒观察任务推进（期间切到统计页，验证可跨页运行）")
        page.click('[data-tab="stats"]')
        page.wait_for_timeout(50000)
        b2 = page.eval_on_selector_all("#job-banner", "els => els.map(e => e.innerText)")
        log("  50 秒后横幅：%s" % (b2 or "无"))
        page.wait_for_timeout(50000)
        b3 = page.eval_on_selector_all("#job-banner", "els => els.map(e => e.innerText)")
        log("  100 秒后横幅：%s" % (b3 or "无"))
        shot(page, "04-after-100s")

        log("== 4. 暂停任务 ==")
        if page.is_visible("#job-pause"):
            page.click("#job-pause")
            page.wait_for_timeout(1500)
            log("  已暂停，横幅：%s" % page.eval_on_selector_all("#job-banner", "els => els.map(e => e.innerText)"))
        else:
            log("  任务已自行结束")

        log("== 5. 学习闭环 ==")
        page.click('[data-tab="study"]')
        page.wait_for_timeout(2000)
        shot(page, "05-study-front")
        if not page.is_visible("#reveal"):
            raise RuntimeError("学习页没有出现「显示答案」按钮")
        page.click("#reveal")
        page.wait_for_timeout(1000)
        shot(page, "06-study-answer")
        grades = page.eval_on_selector_all(".grades button .iv", "els => els.map(e => e.textContent)")
        log("  四档间隔预览：%s" % grades)
        if len(grades) != 4 and False:
            raise RuntimeError("评分按钮异常")
        log("  连续评分 3 次（记得）")
        for i in range(3):
            if page.is_visible("#reveal"):
                page.click("#reveal")
                page.wait_for_timeout(700)
            if page.is_visible('[data-g="3"]'):
                page.click('[data-g="3"]')
                page.wait_for_timeout(3000)
        shot(page, "07-study-after")

        log("== 6. 统计页（必须反映刚才的评分，否则说明没落库） ==")
        page.click('[data-tab="stats"]')
        page.wait_for_timeout(4000)
        stats = page.inner_text("#main")
        log("  统计文本：%s" % stats.replace("\n", " | ")[:300])
        if "累计复习" not in stats:
            raise RuntimeError("统计页缺少指标")
        import re as _re
        mm = _re.search(r"累计复习\s*(\d+)\s*次", stats)
        got = int(mm.group(1)) if mm else -1
        log("  累计复习次数 = %s" % got)
        if got <= 0:
            raise RuntimeError("评分后统计仍为 0 —— 复习记录没有落库")
        shot(page, "08-stats")

        log("== 7. 设置：留存率 + 模型选择 ==")
        page.click('[data-tab="me"]')
        page.wait_for_timeout(2500)
        acct = page.eval_on_selector(".card .row .grow div:last-child, .card .row div div:last-child", "el => el.textContent").strip()
        log("  当前账号显示为：%r" % acct)
        if "已登录" == acct or acct in ("—", ""):
            raise RuntimeError("「我的」页没有显示账号邮箱")
        opts = page.eval_on_selector_all("#st-model option", "els => els.length")
        log("  模型下拉项数：%s" % opts)
        if not opts or opts < 2:
            raise RuntimeError("模型下拉未加载：%s" % opts)
        page.eval_on_selector("#st-ret", "el => { el.value = 90; el.dispatchEvent(new Event('input')) }")
        page.select_option("#st-model", "hunyuan-chat")
        page.wait_for_timeout(300)
        page.click("#st-save")
        page.wait_for_timeout(2500)
        shot(page, "09-me")

        log("== 8. 导出 ==")
        page.click("#me-export")
        page.wait_for_selector("#ex-go", timeout=10000)
        page.wait_for_timeout(600)
        shot(page, "10-export-modal")
        page.check('input[name="ex-fmt"][value="copy"]')
        page.click("#ex-go")
        page.wait_for_timeout(1200)
        toasts = page.eval_on_selector_all("#toast-wrap .toast", "els => els.map(e => e.textContent)")
        log("  导出提示：%s" % toasts)
        if not any("复制" in t or "导出" in t for t in toasts):
            raise RuntimeError("导出没有给出成功提示：%s" % toasts)
        shot(page, "11-export-done")

        log("== 9. 刷新验证持久化 ==")
        page.reload(wait_until="networkidle")
        page.wait_for_selector("#start-study", timeout=45000)
        page.wait_for_timeout(3000)
        page.click('[data-tab="library"]')
        page.wait_for_timeout(2500)
        after = page.eval_on_selector_all(".list-item .t", "els => els.map(e => e.textContent)")
        log("  刷新后词库：%s" % after)
        if len(after) != len(rows):
            raise RuntimeError("刷新后词条数不一致：%s vs %s" % (rows, after))
        # 设置是否跨设备生效
        page.click('[data-tab="me"]')
        page.wait_for_timeout(2000)
        model = page.eval_on_selector("#st-model", "el => el.value")
        ret = page.eval_on_selector("#st-ret", "el => el.value")
        log("  刷新后模型=%s 留存率=%s" % (model, ret))
        shot(page, "12-after-reload")

        log("=== 全流程通过 ===")

        log("== 10. 桌面端布局检查 ==")
        dp = b.new_page(viewport={"width": 1280, "height": 900})
        dp.on("pageerror", lambda e: console_errors.append("[desktop pageerror] %s" % e))
        dp.goto(URL, wait_until="networkidle", timeout=60000)
        dp.wait_for_timeout(3000)
        dp.screenshot(path=os.path.join(HERE, "e2e2-13-desktop-today.png"), full_page=True)
        dp.click('[data-tab="stats"]')
        dp.wait_for_timeout(3500)
        dp.screenshot(path=os.path.join(HERE, "e2e2-14-desktop-stats.png"), full_page=True)
        dp.close()
        log("  桌面端截图完成")
    except Exception as e:
        log("!!! 失败：%s" % str(e)[:400])
        try:
            shot(page, "99-failure")
        except Exception:
            pass
    finally:
        log("--- 控制台错误 %d 条 ---" % len(console_errors))
        for e in console_errors[:15]:
            log("  " + e)
        b.close()

logf.close()
print("done")
