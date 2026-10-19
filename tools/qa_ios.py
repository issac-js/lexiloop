# -*- coding: utf-8 -*-
"""
qa_ios.py — iOS / 触屏适配检查

覆盖 iOS Safari 上最容易踩的坑（这些在桌面浏览器里全都看不出来）：
  1. 输入框字号 <16px → 聚焦时 iOS 自动放大整页
  2. 100vh 含地址栏 → 内容被底栏压住 / 多出一截滚动（应使用 dvh）
  3. 刘海屏安全区：顶部、底部、横屏左右
  4. 软键盘弹起时固定底栏挡住输入框
  5. 触控热区不足（Apple 建议 ≥44pt）
  6. 横向溢出、模态框超出可视高度
  7. PWA/主屏图标与状态栏配色

用法：
  python tools/qa_ios.py --url https://lexiloop-82703.app.workbuddy.host/
  python tools/qa_ios.py --root lexiloop
"""
import argparse
import pathlib
import re
import socket
import subprocess
import sys
import time

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('缺少 playwright，请用本机 venv 运行')
    sys.exit(2)

# 机型：(名称, 宽, 高, dpr)
DEVICES = [
    ('iPhone SE', 320, 568, 2),
    ('iPhone 13/14', 390, 844, 3),
    ('iPhone 15 Pro Max', 430, 932, 3),
]

PROBE = r"""
async ([ver]) => {
  const V = await import('/js/views.js?v=' + ver);
  const S = await import('/js/store.js?v=' + ver);
  const out = { pages: {}, notes: [] };
  document.body.innerHTML = '<main class="main" id="main"></main><nav class="tabbar"></nav>' +
    '<div id="modal-wrap" hidden></div><div id="toast-wrap"></div>';
  const main = document.getElementById('main');
  const mk = (id, lemma, zh) => ({ id, normalized: lemma, lemma, payload: { senses: [{ def_zh: zh }],
    collocations: [{ pattern: 'care for', zh: '照顾', examples: [{ en: 'She cares for them daily.', zh: '她每天照顾他们。' }] }] } });
  S.state.words = [mk(1, 'echo', '回响'), mk(2, 'stair', '楼梯'), mk(3, 'alarm', '警报器'), mk(4, 'corridor', '走廊'), mk(5, 'lobby', '大堂')];
  S.state.cards = [1, 2, 3, 4, 5].map((i) => ({ id: i, word_id: i, deck: 'd',
    card_type: i === 1 ? 'cloze' : 'recognition', status: 'new',
    due: new Date().toISOString(), stability: 0, reps: 0, lapses: 0, suspended: false }));
  S.state.settings = { daily_new: 8, daily_max_review: 300, target_retention: 0.9 };
  S.state.daily = []; S.state.reviewRows = [];

  const docOverflow = () => Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
  const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
  const fs = (el) => el ? parseFloat(getComputedStyle(el).fontSize) : null;

  // ── 学习页（例句填空，有输入框）──
  S.state.cards = [{ id: 1, word_id: 1, deck: 'd', card_type: 'cloze', status: 'new',
    due: new Date().toISOString(), stability: 0, reps: 0, lapses: 0, suspended: false }];
  V.resetSession();
  main.innerHTML = V.renderStudy();
  const inp = main.querySelector('#ans-in');
  out.inputFont = fs(inp);
  out.inputHeight = h(inp);
  out.submitHeight = h(main.querySelector('#ans-go'));
  out.sayHeight = h(main.querySelector('#say-word'));
  out.overflowStudy = docOverflow();
  out.kbdClass = document.body.classList.contains('kbd');
  out.inputFontAtLeast16 = out.inputFont >= 16;

  // 输入框是否被固定底栏压住（底栏 top 与输入框 bottom 比较）
  const tab = document.querySelector('.tabbar');
  if (inp && tab) {
    const ib = inp.getBoundingClientRect();
    const tb = tab.getBoundingClientRect();
    out.inputUnderTabbar = ib.bottom > tb.top && ib.top < tb.bottom;
  }

  // ── 认读卡（选择题热区）──
  S.state.cards = [1, 2, 3, 4, 5].map((i) => ({ id: i, word_id: i, deck: 'd',
    card_type: 'recognition', status: 'new', due: new Date().toISOString(),
    stability: 0, reps: 0, lapses: 0, suspended: false }));
  V.resetSession();
  main.innerHTML = V.renderStudy();
  const ch = main.querySelector('.choice');
  out.choiceHeight = h(ch);
  out.choiceCount = main.querySelectorAll('.choice').length;
  out.mainPadBottom = Math.round(parseFloat(getComputedStyle(main).paddingBottom) || 0);
  out.mainPadTop = Math.round(parseFloat(getComputedStyle(main).paddingTop) || 0);
  out.tabbarHeight = Math.round(document.querySelector('.tabbar').getBoundingClientRect().height);

  // ── 各页面横向溢出 ──
  for (const [name, html] of [['今日', V.renderToday()], ['词库', V.renderLibrary()],
                              ['统计', V.renderStats()], ['我的', V.renderMe()]]) {
    main.innerHTML = html;
    out.pages[name] = docOverflow();
  }

  // ── 模态框高度 vs 可视高度 ──
  document.getElementById('modal-wrap').innerHTML =
    '<div class="modal" style="max-height:88dvh;overflow-y:auto;">' + '<p>x</p>'.repeat(200) + '</div>';
  document.getElementById('modal-wrap').hidden = false;
  const m = document.querySelector('.modal');
  const mr = m.getBoundingClientRect();
  out.modalHeight = Math.round(mr.height);
  out.modalFitsViewport = mr.height <= window.innerHeight + 1;
  out.modalScrollable = m.scrollHeight > m.clientHeight + 2;
  document.getElementById('modal-wrap').hidden = true;

  // ── CSS 层面的安全区 / 键盘态是否声明（env() 在无刘海环境算不出值，只能查声明）──
  const css = [...document.styleSheets].map((s) => {
    try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch (e) { return ''; }
  }).join('\n');
  out.hasSafeTop = /safe-area-inset-top/.test(css);
  out.hasSafeBottom = /safe-area-inset-bottom/.test(css);
  out.hasSafeSides = /safe-area-inset-left/.test(css) && /safe-area-inset-right/.test(css);
  out.hasDvh = /dvh/.test(css);
  out.hasKbdRule = /body\.kbd/.test(css);
  out.hasTapHighlight = /-webkit-tap-highlight-color/.test(css);
  out.hasTextSizeAdjust = /-webkit-text-size-adjust/.test(css);
  out.hasTouchAction = /touch-action/.test(css);

  // ── 页面级元信息 ──
  const metas = [...document.querySelectorAll('meta[name]')].map((m2) => m2.name + '=' + m2.getAttribute('content'));
  out.metas = metas.filter((x) => /viewport|apple|format-detection|theme-color/.test(x));
  const vp = document.querySelector('meta[name="viewport"]');
  out.viewportFitCover = !!vp && /viewport-fit=cover/.test(vp.getAttribute('content'));
  out.icons = [...document.querySelectorAll('link[rel="apple-touch-icon"]')].map((l) => l.getAttribute('href') + ':' + (l.getAttribute('sizes') || ''));
  out.coarse = window.matchMedia('(pointer: coarse)').matches;
  return out;
}
"""


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=None)
    ap.add_argument('--url', default=None)
    ap.add_argument('--ver', default=None)
    args = ap.parse_args()
    if not args.root and not args.url:
        args.root = 'lexiloop'

    proc = None
    if args.url:
        base = args.url
        ver = args.ver or '1'
    else:
        root = pathlib.Path(args.root).resolve()
        t = (root / 'index.html').read_text(encoding='utf-8')
        m = re.search(r'app\.js\?v=(\d+)', t)
        ver = args.ver or (m.group(1) if m else '1')
        port = free_port()
        base = 'http://127.0.0.1:%d/' % port
        import os
        e = os.environ.copy()
        e['PORT'] = str(port)
        proc = subprocess.Popen([sys.executable, 'server.py'], cwd=str(root), env=e,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2.5)

    problems = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel='msedge', headless=True)
            for name, w, hh, dpr in DEVICES:
                ctx = b.new_context(viewport={'width': w, 'height': hh}, device_scale_factor=dpr,
                                    is_mobile=True, has_touch=True)
                pg = ctx.new_page()
                errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)[:160]))
                pg.goto(base + '?qa=ios', wait_until='networkidle', timeout=45000)
                o = pg.evaluate(PROBE, [ver])
                print('=' * 74)
                print('%s  %d×%d @%dx   coarse=%s' % (name, w, hh, dpr, o['coarse']))
                print('=' * 74)
                print('  输入框  字号=%s px（≥16 才不会自动放大：%s） 高=%s' %
                      (o['inputFont'], '✅' if o['inputFontAtLeast16'] else '❌', o['inputHeight']))
                print('  触控热区 提交=%s 朗读=%s 选项=%s 选项数=%s' %
                      (o['submitHeight'], o['sayHeight'], o['choiceHeight'], o['choiceCount']))
                print('  固定底栏  遮住输入框=%s  底栏高=%s 主区底留白=%s 顶留白=%s' %
                      (o.get('inputUnderTabbar'), o.get('tabbarHeight'), o.get('mainPadBottom'), o.get('mainPadTop')))
                print('  横向溢出  学习=%s 各页=%s' % (o['overflowStudy'], o['pages']))
                print('  模态框  高=%s 适配视口=%s 可滚动=%s' % (o['modalHeight'], o['modalFitsViewport'], o['modalScrollable']))
                print('  CSS 声明  安全区 顶/底/左右=%s/%s/%s dvh=%s 键盘态=%s 点按高亮=%s 文字缩放=%s touch-action=%s' %
                      (o['hasSafeTop'], o['hasSafeBottom'], o['hasSafeSides'], o['hasDvh'],
                       o['hasKbdRule'], o['hasTapHighlight'], o['hasTextSizeAdjust'], o['hasTouchAction']))
                print('  PWA     viewport-fit=cover=%s  图标=%s' % (o['viewportFitCover'], o['icons']))
                if errs:
                    print('  JS 错误:', errs)

                def bad(cond, msg):
                    if cond:
                        problems.append('%s: %s' % (name, msg))

                bad(not o['inputFontAtLeast16'], '输入框字号 %s < 16px，iOS 聚焦会缩放整页' % o['inputFont'])
                bad(o.get('inputUnderTabbar') is True, '输入框被固定底栏遮住')
                bad((o.get('mainPadBottom') or 0) < (o.get('tabbarHeight') or 0) + 8,
                    '主区底部留白 %s < 底栏高 %s+8，内容会被压住' % (o.get('mainPadBottom'), o.get('tabbarHeight')))
                bad(o['overflowStudy'] > 0, '学习页横向溢出 %spx' % o['overflowStudy'])
                bad(any(v > 0 for v in o['pages'].values()), '页面横向溢出 %s' % o['pages'])
                bad(not o['modalFitsViewport'], '模态框高于可视区')
                bad(not o['hasSafeSides'], '缺少横屏左右安全区')
                bad(not o['hasKbdRule'], '缺少键盘态规则（底栏会挡住输入框）')
                if o['coarse']:
                    bad((o['choiceHeight'] or 0) < 48, '选项热区仅 %spx（<48）' % o['choiceHeight'])
                    bad((o['submitHeight'] or 0) < 40, '提交按钮热区仅 %spx（<40）' % o['submitHeight'])
                ctx.close()
            b.close()
    finally:
        if proc:
            proc.terminate()

    print('=' * 74)
    if problems:
        print('发现 %d 个 iOS 适配问题：' % len(problems))
        for x in problems:
            print('  ❌', x)
        sys.exit(1)
    print('iOS 适配检查全部通过 ✅')
    sys.exit(0)


if __name__ == '__main__':
    main()
