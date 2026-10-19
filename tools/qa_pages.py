# -*- coding: utf-8 -*-
"""
qa_pages.py — LexiLoop 发版前质检（页面级回归）

用途：一条命令跑完「渲染 + 事件绑定 + 重复 DOM id + 可访问性 + 交互链路」，
不依赖登录态（直接给 store.state 塞假数据后调用各页面的 render/bind）。

用法：
  # 自动起本地服务（推荐）
  python tools/qa_pages.py --root lexiloop

  # 检查线上
  python tools/qa_pages.py --url https://lexiloop-82703.app.workbuddy.host/

  # 指定版本号（模块 ?v=N，默认从 index.html 自动读取）
  python tools/qa_pages.py --root lexiloop --ver 60

退出码：0 = 全部通过；1 = 有失败项（适合挂到发版流程里）
依赖：playwright（本机 venv：.workbuddy/binaries/python/envs/default）
"""
import argparse
import re
import socket
import subprocess
import sys
import time
import pathlib

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('缺少 playwright，请用本机 venv 运行：')
    print('  C:/Users/Flynn Lee/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/qa_pages.py')
    sys.exit(2)

STATES = ['empty', 'large', 'harsh']

CHECK_JS = r"""
(async () => {
  const VER = '__VER__';
  const V = await import('/js/views.js?v=' + VER);
  const S = await import('/js/store.js?v=' + VER);
  const G = await import('/js/game.js?v=' + VER);
  const F = await import('/js/fsrs.js?v=' + VER);
  const today = S.todayKey();
  const topics = ['医疗与急救', '治安与事件处置', '设施与工单', '日常综合词汇'];

  function fixture(kind) {
    if (kind === 'empty') {
      S.state.words = []; S.state.cards = []; S.state.daily = [];
      S.state.settings = {}; S.state.reviewRows = null; S.state.accountEmail = 'x@y.edu';
      return;
    }
    const n = kind === 'large' ? 1534 : 40;
    const words = [], cards = [];
    for (let i = 1; i <= n; i++) {
      const hasColl = i % 3 !== 0;
      const payload = (kind === 'harsh' && i % 7 === 0) ? null : {
        topic: topics[i % topics.length],
        priority: i % 9 === 0 ? 'core' : (i % 5 === 0 ? 'common' : undefined),
        domain: i % 4 === 0,
        mail_freq: i % 11 === 0 ? 12 : undefined,
        senses: i % 5 === 0 ? [] : [{ pos: 'n.', def_zh: '释义' + i }],
        collocations: hasColl ? [{ pattern: 'p' + i, type: 'verb+noun', strength: 'strong', register: 'neutral', zh: '中', confidence: 0.9, examples: [{ en: 'Example sentence number ' + i + ' here.', zh: '例' }] }] : [],
        source_examples: i % 13 === 0 ? [{ en: 'Self corpus sentence ' + i + '.', note: '来自你的邮件语料' }] : [],
        confusables: i % 6 === 0 ? [{ word: 'w' + i, note: 'n' }] : [],
      };
      words.push({ id: i, normalized: 'word' + i, lemma: 'word' + i, payload, enrich_status: 'ok' });
      const st = ['new', 'learning', 'review'][i % 3];
      cards.push({ id: i, word_id: i, deck: i % 2 ? '欧路生词本' : '英语表达语料库', card_type: 'recognition', batch: 'b1', status: st, due: i % 4 === 0 ? null : new Date(Date.now() + (i % 30 - 15) * 86400000).toISOString(), stability: st === 'new' ? 0 : (i % 40), difficulty: 5, reps: st === 'new' ? 0 : i % 6, lapses: i % 4, last_review_at: st === 'new' ? null : new Date(Date.now() - (i % 20) * 86400000).toISOString(), last_grade: 3, suspended: i % 97 === 0 });
      if (hasColl && i % 2 === 0) cards.push({ id: 100000 + i, word_id: i, deck: '欧路生词本', card_type: 'cloze', batch: 'b1', status: 'new', due: new Date().toISOString(), stability: 0, difficulty: 5, reps: 0, lapses: 0, suspended: false });
    }
    const daily = [];
    for (let d = 0; d < 120; d++) daily.push({ reviewed_on: S.todayKey(new Date(Date.now() - d * 86400000)), total: (d * 7) % 40, correct: (d * 5) % 30, new_words: d % 9, minutes: d % 25 });
    S.state.words = words; S.state.cards = cards; S.state.daily = daily;
    S.state.settings = { daily_new: 8, daily_max_review: 200, target_retention: 0.9, card_types: ['recognition', 'cloze'], learn_step_minutes: 10, learn_step_days: 1, queue_interleave: 4, goal_days: {}, day_plan: { date: today, due: 12, newGoal: 3 }, theme: 'green', rest_weekday: 0, goal_include_test: false };
    S.state.reviewRows = kind === 'harsh' ? null : Array.from({ length: 200 }, (_, k) => ({ card_id: (k % 50) + 1, grade: (k % 4) + 1, source: ['study', 'game', 'test'][k % 3], elapsed_ms: 2000 + (k % 9) * 900, prev_state: { stability: 3 + (k % 12) }, created_at: new Date(Date.now() - (k % 40) * 86400000).toISOString() }));
    S.state.accountEmail = 'test-account@example.com';
  }

  const pageFns = {
    今日: () => V.renderToday(),
    学习: () => V.renderStudy(),
    练习场: () => G.renderGames(),
    词库: () => V.renderLibrary(),
    统计: () => V.renderStats(),
    我的: () => V.renderMe(),
    任务横幅: () => V.jobBannerHTML(),
  };
  const results = [];
  document.body.innerHTML = '<div id="main"></div><div id="modal-wrap" hidden></div><div id="toast-wrap"></div>';
  const main = document.getElementById('main');
  const host = document.createElement('div');
  document.body.appendChild(host);

  for (const kind of ['empty', 'large', 'harsh']) {
    fixture(kind);
    for (const [name, fn] of Object.entries(pageFns)) {
      const rec = { kind, page: name, ms: 0, len: 0, err: '', dup: [], unlabeled: 0, noTextBtn: 0, h1: 0 };
      const t0 = performance.now();
      try {
        const html = fn();
        rec.ms = Math.round(performance.now() - t0);
        rec.len = (html || '').length;
        host.innerHTML = html || '';
        const ids = [...(html || '').matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
        const seen = new Set();
        ids.forEach((i) => { if (seen.has(i)) rec.dup.push(i); seen.add(i); });
        rec.unlabeled = [...host.querySelectorAll('input,select,textarea')].filter((el) => {
          if (el.style && el.style.display === 'none') return false;   // 隐藏控件（文件选择框等）朗读不到，不算缺陷
          if (el.getAttribute('aria-label') || el.getAttribute('placeholder')) return false;
          if (el.id && host.querySelector('label[for="' + el.id + '"]')) return false;
          return !el.closest('label');
        }).length;
        rec.noTextBtn = [...host.querySelectorAll('button')].filter((b) =>
          !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length;
        rec.h1 = host.querySelectorAll('h1').length;
      } catch (e) { rec.err = String(e).slice(0, 160); }
      results.push(rec);
    }
  }

  // 事件绑定
  const binds = [];
  function tryBind(name, html, fn) {
    try { main.innerHTML = html; fn(); binds.push([name, '']); }
    catch (e) { binds.push([name, String(e).slice(0, 140)]); }
  }
  fixture('large');
  tryBind('bindToday', V.renderToday(), () => V.bindToday(() => {}));
  tryBind('bindStudy', V.renderStudy(), () => V.bindStudy(() => {}, () => {}));
  tryBind('bindLibrary', V.renderLibrary(), () => V.bindLibrary(() => {}));
  tryBind('bindStats', V.renderStats(), () => V.bindStats(() => {}));
  tryBind('bindMe', V.renderMe(), () => V.bindMe(() => {}, () => {}, () => {}));
  tryBind('bindGames', G.renderGames(), () => G.bindGames(() => {}, () => {}));
  tryBind('jobBanner', V.jobBannerHTML(), () => V.bindJobBanner(() => {}));

  // 交互：每周抽测完整流程
  let weekly = { steps: [] };
  try {
    fixture('rewrite');
    main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {});
    const start = document.getElementById('g-weekly');
    weekly.start = !!start;
    if (start) {
      start.click();
      let html = G.renderGames();
      weekly.title = html.includes('每周抽测');
      weekly.homeVsQuestion = html.includes('id="dict-in"') ? 'question' : (html.includes('g-pick') ? 'home' : 'other');
      weekly.head = html.slice(0, 120).replace(/\s+/g, ' ');
      for (let k = 0; k < 14; k++) {
        main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {});
        const inp = document.getElementById('dict-in');
        if (!inp) break;
        inp.value = 'word' + (k + 1);
        const go = document.getElementById('dict-go');
        if (!go) break;
        go.click();
        // 真实应用里点击会触发重绘，测试也必须重绘后才能找到"下一题"
        main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {});
        const nx = document.getElementById('dict-next');
        if (!nx) break;
        weekly.steps.push(k + 1);
        nx.click();
        html = G.renderGames();
      }
      main.innerHTML = html;
      weekly.done = main.innerHTML.includes('记进复习计划') || html.includes('记进复习计划');
    }
  } catch (e) { weekly.err = String(e).slice(0, 160); }

  const st = F.selfTest();
  return { results, binds, weekly, fsrs: st.ok, fsrsProblems: st.problems };
})()
"""


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def read_ver(root):
    idx = pathlib.Path(root) / 'index.html'
    if not idx.exists():
        return '1'
    m = re.search(r'app\.js\?v=(\d+)', idx.read_text(encoding='utf-8'))
    return m.group(1) if m else '1'


def main():
    ap = argparse.ArgumentParser(description='LexiLoop 页面级质检')
    ap.add_argument('--root', default='lexiloop', help='应用目录（会自动起本地服务）')
    ap.add_argument('--url', help='直接检查这个地址（跳过本地服务）')
    ap.add_argument('--ver', help='模块版本号，默认从 index.html 读取')
    args = ap.parse_args()

    srv = None
    if args.url:
        base = args.url.rstrip('/') + '/'
        ver = args.ver or '1'
    else:
        root = pathlib.Path(args.root).resolve()
        port = free_port()
        base = 'http://127.0.0.1:%d/' % port
        ver = args.ver or read_ver(root)
        srv = subprocess.Popen([sys.executable, 'server.py'], cwd=str(root),
                               env=dict(**__import__('os').environ, PORT=str(port)),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.5)

    js = CHECK_JS.replace('__VER__', ver)
    failures = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel='msedge', headless=True)
            pg = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            page_errors = []
            pg.on('pageerror', lambda e: page_errors.append(str(e)))
            pg.goto(base + '?qa=1', wait_until='networkidle', timeout=45000)
            out = pg.evaluate(js)
            b.close()
    finally:
        if srv:
            srv.terminate()

    print('=' * 74)
    print('LexiLoop 页面级质检 ｜ 目标: %s ｜ 模块版本: v%s' % (base, ver))
    print('=' * 74)
    print('\n【渲染 / DOM / 可访问性】')
    print('%-6s %-8s %-8s %-8s %-6s %-6s %-6s %s' % ('状态', '页面', '毫秒', '长度', 'id重复', '未关联', '无字按钮', '问题'))
    for r in out['results']:
        probs = []
        if r['err']:
            probs.append('异常: ' + r['err'][:60])
        if r['dup']:
            probs.append('重复id: ' + ','.join(r['dup'][:3]))
        if r['unlabeled']:
            probs.append('未关联输入 %d' % r['unlabeled'])
        if r['noTextBtn']:
            probs.append('无文字按钮 %d' % r['noTextBtn'])
        if r['kind'] != 'empty' and r['page'] != '任务横幅' and r['h1'] == 0:
            probs.append('缺 h1')
        if probs:
            failures.append('%s/%s: %s' % (r['kind'], r['page'], '；'.join(probs)))
        print('%-6s %-8s %-8s %-8s %-6s %-6s %-6s %s' % (
            r['kind'], r['page'], r['ms'], r['len'], len(r['dup']), r['unlabeled'], r['noTextBtn'],
            '；'.join(probs) if probs else 'OK'))

    print('\n【事件绑定】')
    for name, err in out['binds']:
        print('  %-12s %s' % (name, 'OK' if not err else 'ERR ' + err[:80]))
        if err:
            failures.append('绑定 %s: %s' % (name, err[:80]))

    print('\n【交互：每周抽测】')
    w = out['weekly']
    print('  入口=%s 标题=%s 完成题数=%s 结束页有写回按钮=%s %s' % (
        w.get('start'), w.get('title'), len(w.get('steps', [])), w.get('done'), w.get('err', '')))
    if not w.get('start') or not w.get('title') or not w.get('done'):
        failures.append('抽测流程异常: %s' % w)

    print('\n【FSRS 自检】%s %s' % ('ok' if out['fsrs'] else 'FAIL', out.get('fsrsProblems')))
    if not out['fsrs']:
        failures.append('FSRS 自检失败: %s' % out.get('fsrsProblems'))
    if page_errors:
        print('\n【页面级 JS 错误】')
        for e in page_errors[:5]:
            print('  ' + e[:140])
        failures.append('页面级 JS 错误 %d 个' % len(page_errors))

    print('\n' + '=' * 74)
    if failures:
        print('结果：发现 %d 个问题' % len(failures))
        for f in failures:
            print('  ✗ ' + f)
        print('=' * 74)
        return 1
    print('结果：全部通过 ✅')
    print('=' * 74)
    return 0


if __name__ == '__main__':
    sys.exit(main())
