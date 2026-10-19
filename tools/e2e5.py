"""用 Kevin 的真实语料库验证结构化导入 + 按批次删除。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
SRC = r"C:\Users\cs198\Desktop\英语表达语料库.md"
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "e2e5.log"), "w", encoding="utf-8")

doc = open(SRC, encoding="utf-8").read()


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
        log("  登录成功（文件 %d 字符）" % len(doc))

        log("== 1. 导入真实语料库 ==")
        page.click('[data-tab="library"]')
        page.wait_for_timeout(1200)
        page.click("#lib-import")
        page.wait_for_selector("#im-text", timeout=10000)
        page.fill("#im-deck", "语料库-结构化")
        # 84KB 文本用 fill 会超时，直接赋值再手动触发 input 事件
        page.evaluate("""(t) => {
          const ta = document.getElementById('im-text');
          ta.value = t;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }""", doc)
        page.wait_for_timeout(2500)
        preview = page.inner_text("#im-preview")
        log("  预览：%s" % preview)
        if "识别为结构化文档" not in preview:
            raise RuntimeError("没有被识别为结构化文档：%s" % preview)
        page.uncheck("#im-enrich")          # 先不生成，验证结构与批次
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(HERE, "e2e5-01-preview.png"), full_page=True)

        t0 = time.time()
        page.click("#im-go")
        page.wait_for_selector("#modal-wrap[hidden]", state="attached", timeout=300000)
        log("  导入完成，耗时 %.1f 秒" % (time.time() - t0))
        page.wait_for_timeout(4000)
        page.screenshot(path=os.path.join(HERE, "e2e5-02-imported.png"), full_page=True)

        log("== 2. 词条与释义是否带进来 ==")
        page.click('[data-deck="语料库-结构化"]')
        page.wait_for_timeout(2500)
        header = page.inner_text("h1.page .sub")
        log("  表头：%s" % header.replace("\n", " "))
        names = page.eval_on_selector_all(".list-item .t", "els => els.map(e => e.textContent)")
        log("  词条数：%d" % len(names))
        log("  前 12 个：%s" % names[:12])
        dupes = [n for n in set(names) if names.count(n) > 1]
        if dupes:
            raise RuntimeError("有重复：%s" % dupes)
        bad = [n for n in names if any(c in n for c in ['#', '*', '|', '`', '\\'])]
        if bad:
            raise RuntimeError("词条里有 Markdown 残留：%s" % bad[:8])
        log("  ✓ 无重复、无符号残留")

        # 找一个带释义的词，验证 ✅ 文档释义已经带上
        detail = page.evaluate("""() => {
          const items = Array.prototype.slice.call(document.querySelectorAll('.list-item'));
          const hit = items.find(el => el.querySelector('.d') && el.querySelector('.d').textContent.trim());
          if (!hit) return null;
          const t = hit.querySelector('.t').textContent;
          const d = hit.querySelector('.d').textContent;
          return { term: t, desc: d };
        }""")
        log("  抽查带释义的词：%s -> %s" % (detail["term"], detail["desc"]))
        if not detail["desc"]:
            raise RuntimeError("文档里的中文释义没有被带进来")

        log("== 3. 导入记录（按批次删除） ==")
        batches = page.eval_on_selector_all(".card .row [data-batch]", "els => els.length")
        log("  可删除的批次数：%s" % batches)
        if not batches or int(batches) < 2:
            raise RuntimeError("导入记录没有列出多个批次：%s" % batches)
        info = page.eval_on_selector_all(
            ".card .row", "els => els.map(e => e.innerText.replace(/\\n/g, ' ')).slice(0, 6)")
        for i in info:
            log("     %s" % i[:110])
        page.screenshot(path=os.path.join(HERE, "e2e5-03-batches.png"), full_page=True)

        log("== 4. 删掉本次导入的批次 ==")
        before = len(names)
        # 定位「语料库-结构化」那一批
        target = page.evaluate("""() => {
          const rows = Array.prototype.slice.call(document.querySelectorAll('.card .row'));
          const hit = rows.find(r => r.textContent.indexOf('语料库-结构化') >= 0);
          if (!hit) return null;
          const b = hit.querySelector('[data-batch]');
          const label = hit.innerText.replace(/\\n/g,' ');
          if (b) b.click();
          return label;
        }""")
        log("  目标批次：%s" % target)
        if not target:
            raise RuntimeError("找不到刚导入的那个批次")
        page.wait_for_timeout(600)
        page.click(".modal-actions [data-x='yes']")
        page.wait_for_timeout(6000)
        left = page.eval_on_selector_all(".list-item .t", "els => els.map(e => e.textContent)")
        log("  删除后同词单剩余：%d（删除前 %d）" % (len(left), before))
        if left:
            raise RuntimeError("该批次的词条还有残留：%s" % left[:8])
        # 回到「全部」再数，确认其它批次没被误删
        page.click('[data-deck=""]')
        page.wait_for_timeout(2500)
        allnames = page.eval_on_selector_all(".list-item .t", "els => els.map(e => e.textContent)")
        log("  全部词库仍保留 %d 个词条（其它批次未受影响）" % len(allnames))
        if len(allnames) == 0:
            raise RuntimeError("误删了其它批次")
        page.screenshot(path=os.path.join(HERE, "e2e5-04-after-delete.png"), full_page=True)

        log("=== 全部通过 ===")
    except Exception as e:
        log("!!! 失败：%s" % str(e)[:400])
        try:
            page.screenshot(path=os.path.join(HERE, "e2e5-99-failure.png"), full_page=True)
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
