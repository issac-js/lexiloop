"""验证：词库按词聚合（不再一词多行）+ 导入按词数挡句子 + 详情页多卡展示。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "e2e4.log"), "w", encoding="utf-8")

DOC = """# 校园安全词汇

- custody
- access control
- take (someone) into custody
- chain of custody
- campus police took the suspect into custody after the fight
- please let me know if there is anything else i can help with
- perimeter
"""


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
    page.on("console", lambda m: errs.append("[console] %s" % m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errs.append("[pageerror] %s" % e))

    try:
        log("== 登录 ==")
        page.goto(URL, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(1800)
        page.click('[data-mode="pwd"]')
        page.fill("#pwd-email", EMAIL)
        page.fill("#pwd-password", PASSWORD)
        page.click('#pwd-form button[type="submit"]')
        page.wait_for_selector("#start-study", timeout=45000)
        page.wait_for_timeout(2000)
        log("  登录成功")

        log("== 1. 导入：句子里被挡、词组保留 ==")
        page.click('[data-tab="library"]')
        page.wait_for_timeout(1200)
        page.click("#lib-import")
        page.wait_for_selector("#im-text", timeout=10000)
        page.fill("#im-deck", "聚合验证")
        page.fill("#im-text", DOC)
        page.wait_for_timeout(900)
        preview = page.inner_text("#im-preview")
        log("  预览：%s" % preview)
        # 两个超长句子应被挡掉，剩 5 条
        if "识别到 5 个词条" not in preview:
            raise RuntimeError("句子没有被挡住：%s" % preview)
        if "疑似句子" not in preview:
            raise RuntimeError("预览没有说明跳过原因：%s" % preview)

        # 勾上「例句填空」，制造一个词多张卡
        page.check('input[data-ct="cloze"]')
        page.uncheck("#im-enrich")   # 这次不生成，先把结构验完
        page.wait_for_timeout(300)
        page.click("#im-go")
        page.wait_for_selector("#modal-wrap[hidden]", state="attached", timeout=60000)
        page.wait_for_timeout(2500)
        log("  导入完成")

        log("== 2. 词库必须一个词一行 ==")
        page.click('[data-tab="library"]')
        page.wait_for_timeout(1500)
        # 只看「聚合验证」词单
        page.click('[data-deck="聚合验证"]')
        page.wait_for_timeout(1800)
        names = page.eval_on_selector_all(".list-item .t", "els => els.map(e => e.textContent)")
        log("  列表：%s" % names)
        dupes = [n for n in set(names) if names.count(n) > 1]
        if dupes:
            raise RuntimeError("仍然重复：%s" % dupes)
        header = page.inner_text("h1.page .sub")
        log("  表头：%s" % header.replace("\n", " "))
        if "张卡" not in header:
            raise RuntimeError("表头没有区分词条数与卡片数：%s" % header)
        log("  ✓ 每个词只占一行")

        log("== 3. 卡片类型角标 + 详情页多卡 ==")
        chips = page.eval_on_selector_all(".list-item .chip", "els => els.map(e => e.textContent)")
        log("  角标：%s" % chips)
        if not any("2 种卡片" in c for c in chips):
            raise RuntimeError("没有显示「2 种卡片」角标：%s" % chips)
        page.screenshot(path=os.path.join(HERE, "e2e4-01-library.png"), full_page=True)

        # 点开一个确实有 2 张卡的词
        target = page.evaluate("""() => {
          const items = Array.prototype.slice.call(document.querySelectorAll('.list-item'));
          const hit = items.find(el => el.textContent.indexOf('2 种卡片') >= 0);
          if (hit) hit.click();
          return hit ? hit.querySelector('.t').textContent : null;
        }""")
        log("  点开：%s" % target)
        if not target:
            raise RuntimeError("找不到带 2 张卡的词条")
        page.wait_for_selector("#wd-del", timeout=10000)
        page.wait_for_timeout(600)
        modal = page.inner_text(".modal")
        log("  详情页片段：%s" % modal.replace("\n", " | ")[:240])
        if "2 张卡" not in modal:
            raise RuntimeError("详情页没有标明卡片数量：%s" % modal[:220])
        if "英→中" not in modal or "例句填空" not in modal:
            raise RuntimeError("详情页没有逐张列出卡片类型")
        page.screenshot(path=os.path.join(HERE, "e2e4-02-detail.png"), full_page=True)
        log("  ✓ 详情页列出每张卡的状态")
        page.click(".modal-wrap", position={"x": 5, "y": 5})
        page.wait_for_timeout(600)

        log("== 4. 删除词单入口 ==")
        visible = page.is_visible("#lib-deldeck")
        log("  「删除词单」按钮可见：%s" % visible)
        if not visible:
            raise RuntimeError("选中词单后没有出现删除入口")
        page.screenshot(path=os.path.join(HERE, "e2e4-03-deck-actions.png"), full_page=True)

        log("== 5. 清理测试词单 ==")
        before_txt = page.inner_text("h1.page .sub")
        import re as _re
        before_cards = int(_re.search(r"（(\d+) 张卡）", before_txt).group(1))
        page.click("#lib-deldeck")
        page.wait_for_timeout(600)
        page.click(".modal-actions [data-x='yes']")
        page.wait_for_timeout(4500)
        page.click('[data-deck=""]')          # 回到「全部」，看总数变化
        page.wait_for_timeout(2000)
        after_txt = page.inner_text("h1.page .sub")
        after_cards = int(_re.search(r"（(\d+) 张卡）", after_txt).group(1))
        log("  卡片总数 %d -> %d（该词单原有 8 张）" % (before_cards, after_cards))
        if before_cards - after_cards != 8:
            raise RuntimeError("删除的张数不对：%d -> %d" % (before_cards, after_cards))
        left_chips = page.eval_on_selector_all(".list-item .chip", "els => els.map(e => e.textContent)")
        if any("2 种卡片" in c for c in left_chips):
            raise RuntimeError("该词单的两种卡片还有残留：%s" % left_chips)
        log("  ✓ 词单已清理干净，其它词单未受影响")

        log("=== 全部通过 ===")
    except Exception as e:
        log("!!! 失败：%s" % str(e)[:400])
        try:
            page.screenshot(path=os.path.join(HERE, "e2e4-99-failure.png"), full_page=True)
        except Exception:
            pass
    finally:
        log("--- 控制台错误 %d 条 ---" % len(errs))
        for e in errs[:10]:
            log("  " + e)
        ctx.close()
        b.close()

LOG.close()
print("done")
