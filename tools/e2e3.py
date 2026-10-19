"""验证 Markdown 导入 + 自定义 API 连通性（线上真环境）。"""
import os
import time
from playwright.sync_api import sync_playwright

URL = "https://lexiloop-16105.app.workbuddy.host/"
EMAIL = os.environ.get('LEXILOOP_TEST_EMAIL', '')
PASSWORD = os.environ.get('LEXILOOP_TEST_PASSWORD', '')
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, "e2e3.log"), "w", encoding="utf-8")

MD = """---
title: 校园安全英语
tags: [safety, english]
---

# 门禁与出入 Access Control

- **commit** /kəˈmɪt/ vt. 承诺；犯罪
- evacuate the building
- [premises](https://example.com) 建筑及用地

## 常用表达

| 单词 | 释义 |
| --- | --- |
| perimeter | 外围边界 |
| access control | 门禁控制 |

> never share your access card

`deterrent`

1. follow-up
2. 这里是一句中文说明
"""

EXPECT = ["commit", "evacuate the building", "premises", "perimeter",
          "access control", "deterrent", "follow-up"]


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

        log("== 1. Markdown 导入 ==")
        page.click('[data-tab="library"]')
        page.wait_for_timeout(1200)
        page.click("#lib-import")
        page.wait_for_selector("#im-text", timeout=10000)
        page.fill("#im-deck", "MD 验证")
        page.fill("#im-text", MD)
        page.wait_for_timeout(900)
        preview = page.inner_text("#im-preview")
        log("  实时预览：%s" % preview)
        if "7 个词条" not in preview:
            raise RuntimeError("实时预览数目不对：%s" % preview)
        page.screenshot(path=os.path.join(HERE, "e2e3-01-md-import.png"), full_page=True)

        page.click("#im-go")
        page.wait_for_selector("#modal-wrap[hidden]", state="attached", timeout=60000)
        page.wait_for_timeout(2500)
        rows = page.eval_on_selector_all(".list-item .t", "els => els.map(e => e.textContent)")
        log("  导入后词库：%s" % rows)
        bad = [r for r in rows if any(c in r for c in ['#', '*', '|', '`', '[', ']'])]
        if bad:
            raise RuntimeError("词条里残留了 Markdown 符号：%s" % bad)
        for want in EXPECT:
            if want not in rows:
                raise RuntimeError("缺少词条 %r，实际：%s" % (want, rows))
        log("  ✓ 7 个词条全部正确，无 Markdown 残留")
        page.screenshot(path=os.path.join(HERE, "e2e3-02-library.png"), full_page=True)

        log("== 2. 自定义 API 界面 ==")
        page.click('[data-tab="me"]')
        page.wait_for_timeout(2000)
        page.click('[data-api="custom"]')
        page.wait_for_timeout(600)
        if not page.is_visible("#api-base"):
            raise RuntimeError("切到自定义 API 后表单没有出现")
        page.select_option("#api-preset", "0")
        page.wait_for_timeout(500)
        base = page.input_value("#api-base")
        model = page.input_value("#api-model")
        log("  预设回填：base=%s model=%s" % (base, model))
        if base != "https://api.deepseek.com/v1" or model != "deepseek-chat":
            raise RuntimeError("预设回填不正确")
        page.screenshot(path=os.path.join(HERE, "e2e3-03-api-form.png"), full_page=True)

        log("== 3. 用无效 key 测连通性（验证请求真的到达了 DeepSeek 而非被 CORS 拦下） ==")
        page.fill("#api-key", "sk-test-key-not-real")
        page.click("#api-test")
        # toast 只停留几秒，必须边等边收
        seen = []
        for _ in range(50):
            page.wait_for_timeout(400)
            now = page.eval_on_selector_all("#toast-wrap .toast", "els => els.map(e => e.textContent)")
            for t in now:
                if t not in seen:
                    seen.append(t)
            if seen:
                page.wait_for_timeout(1200)
                now = page.eval_on_selector_all("#toast-wrap .toast", "els => els.map(e => e.textContent)")
                for t in now:
                    if t not in seen:
                        seen.append(t)
                break
        log("  测试结果提示：%s" % seen)
        joined = " ".join(seen)
        if "连不上自定义 API" in joined or "跨域" in joined:
            raise RuntimeError("请求被网络/CORS 拦下，说明前端直连不可用：%s" % joined)
        if "401" not in joined:
            raise RuntimeError("没有拿到 401，无法确认请求到达服务端：%s" % joined)
        log("  ✓ 拿到 401 —— 请求确实到达 DeepSeek，CORS 放行，错误提示可读")
        page.screenshot(path=os.path.join(HERE, "e2e3-04-api-test.png"), full_page=True)

        log("== 4. 清除后恢复云端通道 ==")
        page.click("#api-clear")
        page.wait_for_timeout(700)
        page.click(".modal-actions .btn.danger, .modal-actions [data-x='yes']")
        page.wait_for_timeout(2500)
        back = page.eval_on_selector_all("#toast-wrap .toast", "els => els.map(e => e.textContent)")
        log("  清除提示：%s" % back)
        if page.is_visible("#api-base"):
            log("  注意：界面仍在自定义页签（预期，用户没切回）")
        page.screenshot(path=os.path.join(HERE, "e2e3-05-cleared.png"), full_page=True)

        log("=== 全部通过 ===")
    except Exception as e:
        log("!!! 失败：%s" % str(e)[:400])
        try:
            page.screenshot(path=os.path.join(HERE, "e2e3-99-failure.png"), full_page=True)
        except Exception:
            pass
    finally:
        log("--- 控制台错误 %d 条 ---" % len(errs))
        for e in errs[:12]:
            log("  " + e)
        ctx.close()
        b.close()

LOG.close()
print("done")
