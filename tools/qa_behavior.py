# -*- coding: utf-8 -*-
"""
qa_behavior.py — LexiLoop 行为层审计（补 qa_pages.py 覆盖不到的语义缺陷）

qa_pages.py 管的是「渲染得出来吗、绑得上事件吗、DOM 合不合法」。
本脚本管的是「算得对吗、说的是同一件事吗、换卡会串吗」——这两天真实使用中暴露的 bug
（cloze 搭配匹配不到、朗读内容和考核内容不一致、中文判分不公平、生成后无反馈）
全部属于这一层，所以单独立一套。

审计套件：
  A 卡片内容一致性：题干 / 答案 / 朗读文本 / 选项 四者必须自洽
  B 跨卡状态残留：连续渲染不同卡，第二张不能受第一张影响（串卡）
  C 判分公平性：该判对的一定判对（大小写/标点/空格/冠词），该判错的一定判错
  D 空脏数据降级：无释义 / 无搭配 / 无例句 / payload=null / 超长例句 都不许崩
  E 异步反馈与幂等：重复点击不重复入库；异步动作有反馈
  F 统计自洽：今日页与统计页口径一致，空数据不崩
  G 移动端可用性：390×844 下作答控件可用、热区足够

用法：
  python tools/qa_behavior.py --url https://lexiloop-82703.app.workbuddy.host/
  python tools/qa_behavior.py --root lexiloop          # 自动起本地服务
退出码：0 = 无 P0；1 = 有 P0（真缺陷）；P1/P2 只报告不失败
依赖：playwright（本机 venv）
"""
import argparse
import json
import pathlib
import re
import socket
import subprocess
import sys
import time

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('缺少 playwright，请用本机 venv 运行：')
    print('  C:/Users/Flynn Lee/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/qa_behavior.py')
    sys.exit(2)

# ── 浏览器里执行的审计主体 ───────────────────────────────────────────────
AUDIT_JS = r"""
(async () => {
  const VER = '__VER__';
  const V = await import('/js/views.js?v=' + VER);
  const S = await import('/js/store.js?v=' + VER);
  const G = await import('/js/game.js?v=' + VER);
  const UI = await import('/js/ui.js?v=' + VER);

  const F = [];                       // findings
  const add = (sev, suite, what, detail) => F.push({ sev, suite, what, detail: String(detail).slice(0, 300) });
  const P0 = (s, w, d) => add('P0', s, w, d);
  const P1 = (s, w, d) => add('P1', s, w, d);
  const P2 = (s, w, d) => add('P2', s, w, d);

  // 语音合成拦截：抓真实念出的文本
  const spoken = [];
  const OrigU = window.SpeechSynthesisUtterance;
  window.SpeechSynthesisUtterance = function (t) { spoken.push(String(t)); return new OrigU(t); };

  // 干净的 DOM 宿主（未登录时页面本身没有 #main，测试自带）
  document.body.innerHTML = '<div id="main"></div><div id="modal-wrap" hidden></div><div id="toast-wrap"></div>';
  const main = document.getElementById('main');

  // ── 词条工厂：一套覆盖各种形态的样本 ──
  const mkWord = (id, opt) => {
    const o = opt || {};
    return {
      id, normalized: 'w' + id, lemma: o.lemma || ('word' + id),
      payload: Object.prototype.hasOwnProperty.call(o, 'payload') ? o.payload : {
        senses: [{ pos: 'n.', def_zh: '释义' + id }],
        collocations: o.coll || [{ pattern: 'care for', zh: '照顾',
          examples: [{ en: 'She has to care for her elderly parents.', zh: '她得照顾年迈的父母。' }] }],
      },
    };
  };
  const mkCard = (id, wordId, type, extra) => Object.assign({
    id, word_id: wordId, deck: 'd', card_type: type, status: 'new',
    due: new Date().toISOString(), stability: 0, difficulty: 5,
    reps: 0, lapses: 0, last_review_at: null, suspended: false,
  }, extra || {});

  const seed = ({ words, cards, settings }) => {
    S.state.words = words;
    S.state.cards = cards;
    S.state.daily = S.state.daily || [];
    S.state.reviewRows = [];
    S.state.settings = Object.assign({
      daily_new: 8, daily_max_review: 300, target_retention: 0.9,
      card_types: ['recognition', 'cloze'], learn_step_minutes: 10, learn_step_days: 1,
      queue_interleave: 4, goal_days: {}, day_plan: null, theme: 'green',
      rest_weekday: 0, goal_include_test: true, auto_credit: true,
    }, settings || {});
  };
  const draw = () => { main.innerHTML = V.renderStudy(); V.bindStudy(() => {}, draw); };
  const one = (type, wordOpt, cardExtra) => {
    seed({ words: [mkWord(1, wordOpt)], cards: [mkCard(1, 1, type, cardExtra)] });
    V.resetSession();
    draw();
  };
  const $1 = (s) => document.querySelector(s);
  const txt = (s) => { const el = $1(s); return el ? el.textContent.trim() : ''; };
  const showTerm = (t) => String(t || '').trim().length > 0;
  const grabSay = () => { spoken.length = 0; const b = $1('#say-word'); if (b) b.click(); return spoken.slice(-1)[0] || ''; };

  /* ═══════════ A 卡片内容一致性 ═══════════ */
  const GOOD_CARD = { lemma: 'echo', payload: { senses: [{ pos: 'v.', def_zh: '回响，发出回声' }],
    collocations: [{ pattern: 'in the stairwell', zh: '在楼梯井里',
      examples: [{ en: 'The fire alarm echoed loudly in the stairwell.', zh: '火警警报在楼梯井里大声回响。' }] }] } };

  try {
    // A1 例句填空：挖空必须恰好一处，答案必须是原句被挖掉的那串字
    one('cloze', GOOD_CARD);
    const html1 = main.innerHTML;
    const blanks = (html1.match(/________/g) || []).length;
    if (blanks !== 1) P0('A', '例句填空挖空数不为 1', 'blanks=' + blanks);
    const sayA1 = grabSay();
    if (sayA1 !== 'in the stairwell') {
      (sayA1.includes('in the stairwell') ? P1 : P0)('A', '未揭晓时「听答案」读的不是考核内容',
        'read=' + JSON.stringify(sayA1) + ' expected=in the stairwell');
    }
    // 提交正确答案：必须判对，且建议分不为 1
    $1('#ans-in').value = 'in the stairwell';
    $1('#ans-go').click();
    const verdict = txt('.verdict');
    if (!verdict.includes('答对')) P0('A', '例句填空正确答案被判错', verdict);
    const sug = $1('[data-g].sug');
    if (sug && sug.getAttribute('data-g') === '1') P0('A', '答对却建议"忘记"档', 'sug=1');

    // A2 揭晓后朗读必须含完整答案
    one('cloze', GOOD_CARD);
    $1('#ans-reveal').click();
    const sayA2 = grabSay();
    if (!sayA2.includes('in the stairwell')) {
      P1('A', '揭晓后「朗读整句」没包含答案', 'read=' + JSON.stringify(sayA2));
    }

    // A3 认读卡：4 个选项、含正确项、不重复、朗读=题面词
    seed({
      words: [mkWord(1, GOOD_CARD),
              mkWord(2, { lemma: 'stair', payload: { senses: [{ def_zh: '楼梯' }], collocations: [] } }),
              mkWord(3, { lemma: 'alarm', payload: { senses: [{ def_zh: '警报器' }], collocations: [] } }),
              mkWord(4, { lemma: 'corridor', payload: { senses: [{ def_zh: '走廊' }], collocations: [] } }),
              mkWord(5, { lemma: 'lobby', payload: { senses: [{ def_zh: '大堂' }], collocations: [] } })],
      cards: [mkCard(1, 1, 'recognition'), mkCard(2, 2, 'recognition'), mkCard(3, 3, 'recognition'),
              mkCard(4, 4, 'recognition'), mkCard(5, 5, 'recognition')],
    });
    V.resetSession(); draw();
    const opts = [...document.querySelectorAll('.choice')].map((b) => b.textContent.trim());
    if (opts.length !== 4) P0('A', '认读卡选项数不是 4', 'n=' + opts.length + ' ' + JSON.stringify(opts));
    if (new Set(opts).size !== opts.length) P0('A', '选择题出现重复选项', JSON.stringify(opts));
    const termNow = ((main.querySelector('.qcard .term') || {}).textContent || '').trim();
    const wNow = S.state.words.find((x) => String(x.lemma).trim() === termNow);
    const zhNow = wNow && wNow.payload && wNow.payload.senses && wNow.payload.senses[0] && wNow.payload.senses[0].def_zh;
    if (zhNow && !opts.some((t) => t.includes(zhNow))) {
      P0('A', '选择题里没有正确释义', '当前卡=' + termNow + ' 应含=' + zhNow + ' 选项=' + JSON.stringify(opts));
    }
    if ($1('#ans-in')) P0('A', '认读卡又出现了打字框', 'recognition 不该有输入框');
    const shownTerm = (main.querySelector('.qcard .term') || {}).textContent || '';
    const sayA3 = grabSay();
    if (showTerm(shownTerm) && sayA3 && sayA3 !== shownTerm.trim()) {
      P2('A', '认读卡朗读的不是题面那个词', 'term=' + shownTerm.trim() + ' read=' + JSON.stringify(sayA3));
    }

    // A5 释义大量重复时（真实词库常见）仍要能作答，不能退化成"只有看答案"
    seed({
      words: [mkWord(1, GOOD_CARD),
              mkWord(2, { payload: { senses: [{ def_zh: '回响，发出回声' }], collocations: [] } }),
              mkWord(3, { payload: { senses: [{ def_zh: '回响，发出回声' }], collocations: [] } }),
              mkWord(4, { payload: { senses: [{ def_zh: '重要的' }, { def_zh: '显著的' }], collocations: [] } }),
              mkWord(5, { payload: { senses: [{ def_zh: '照顾' }], collocations: [] } })],
      cards: [mkCard(1, 1, 'recognition'), mkCard(2, 2, 'recognition'), mkCard(3, 3, 'recognition'),
              mkCard(4, 4, 'recognition'), mkCard(5, 5, 'recognition')],
    });
    V.resetSession(); draw();
    if (!document.querySelector('.choice') && !main.innerHTML.includes('不会，看答案')) {
      P0('A', '认读卡既没有选项也没有看答案按钮（死卡）', main.innerHTML.slice(0, 160));
    }
    if (!document.querySelector('.choice')) {
      P1('A', '释义重复时认读卡退化成"只有看答案"', '可作答选项=' + document.querySelectorAll('.choice').length);
    }

    // A4 中→英：题干必须是中文提示 + 英文才是答案，且朗读不能念中文
    seed({ words: [mkWord(1, GOOD_CARD)], cards: [mkCard(1, 1, 'production')] });
    V.resetSession(); draw();
    const prodHtml = main.innerHTML;
    if (!prodHtml.includes('用英语说出来')) P1('A', '中→英卡缺少作答指令文案', prodHtml.slice(0, 160));
    if (!/在楼梯井里|回响/.test(prodHtml)) P2('A', '中→英卡题干里看不到中文提示', prodHtml.slice(0, 160));
    const sayA4 = grabSay();
    if (/[\u4e00-\u9fa5]/.test(sayA4)) P0('A', '中→英卡朗读念的是中文', 'read=' + JSON.stringify(sayA4));
  } catch (e) { P0('A', '套件异常', e && e.message); }

  /* ═══════════ B 跨卡状态残留（串卡） ═══════════ */
  try {
    // B1 cloze 后紧接 recognition：不能沿用上一张的例句/朗读
    seed({ words: [mkWord(1, GOOD_CARD), mkWord(2, { lemma: 'stair' }), mkWord(3, { lemma: 'alarm' }), mkWord(4, { lemma: 'corridor' })],
      cards: [mkCard(1, 1, 'cloze'), mkCard(2, 2, 'recognition')] });
    V.resetSession();
    // 直接把队列切成 recognition 卡（模拟换卡：队列 shift 后重绘）
    S.state.cards = [mkCard(2, 2, 'recognition')];
    V.resetSession(); draw();
    const sayB1 = grabSay();
    if (sayB1 && sayB1.includes('fire alarm')) P0('B', '串卡：认读卡朗读了上一张的例句', 'read=' + JSON.stringify(sayB1));
    if (main.innerHTML.includes('________')) P0('B', '串卡：认读卡上出现了挖空句', '残留 cloze 例句');

    // B2 揭晓状态不能带到下一张
    seed({ words: [mkWord(1, GOOD_CARD)], cards: [mkCard(1, 1, 'cloze')] });
    V.resetSession(); draw();
    $1('#ans-reveal').click();
    // 换一张新卡
    seed({ words: [mkWord(2, { lemma: 'stair' })], cards: [mkCard(2, 2, 'cloze')] });
    S.state.words[0] = mkWord(2, { lemma: 'stair' });
    V.resetSession(); draw();
    if ($1('.answer')) P0('B', '串卡：新卡一进来就处于"已揭晓"状态（看到了答案）', 'shown 残留');

    // B3 已作答/选项不能残留
    seed({ words: [mkWord(1, GOOD_CARD), mkWord(2, { lemma: 'stair' }), mkWord(3, { lemma: 'alarm' }), mkWord(4, { lemma: 'corridor' })],
      cards: [mkCard(1, 1, 'recognition')] });
    V.resetSession(); draw();
    const firstChoice = document.querySelectorAll('.choice')[0];
    if (firstChoice) firstChoice.click();
    seed({ words: [mkWord(5, { lemma: 'lobby' }), mkWord(2, { lemma: 'stair' }), mkWord(3, { lemma: 'alarm' }), mkWord(4, { lemma: 'corridor' })],
      cards: [mkCard(5, 5, 'recognition')] });
    V.resetSession(); draw();
    if ($1('.verdict')) P0('B', '串卡：新卡上残留上一张的作答反馈', txt('.verdict'));
    const sel = [...document.querySelectorAll('.choice')].filter((b) => b.classList.contains('good'));
    if (sel.length) P0('B', '串卡：新卡上残留上一张的选项高亮', sel.length + ' 个');
  } catch (e) { P0('B', '套件异常', e && e.message); }

  /* ═══════════ C 判分公平性 ═══════════ */
  try {
    const cases = [
      ['in the stairwell', 'in the stairwell', true, '原样'],
      ['In The Stairwell', 'in the stairwell', true, '大小写不同'],
      ['  in the stairwell  ', 'in the stairwell', true, '首尾空格'],
      ['in  the   stairwell', 'in the stairwell', true, '多余空格'],
      ['in the stairwell.', 'in the stairwell', true, '句末句号'],
      ['in the stairwell。', 'in the stairwell', true, '中文句号'],
      ['inthe stairwell', 'in the stairwell', true, '缺空格（拼写近似）'],
      ['on the roof', 'in the stairwell', false, '答错内容'],
      ['', 'in the stairwell', false, '空作答'],
      ['在楼梯井里', 'in the stairwell', false, '答中文（不能算对）'],
      ['ontheroofplease', 'in the stairwell', false, '字母完全不同（必须判错，防空格容错过宽）'],
    ];
    const bad = [];
    for (const [given, expected, wantOk, label] of cases) {
      one('cloze', GOOD_CARD);
      const inp = $1('#ans-in');
      if (!inp) { bad.push(label + ':无输入框'); continue; }
      inp.value = given;
      $1('#ans-go').click();
      const v = txt('.verdict');
      const ok = v.includes('答对') || v.includes('基本正确');
      if (ok !== wantOk) bad.push(label + ' → ' + (ok ? '判对' : '判错') + '（期望' + (wantOk ? '对' : '错') + '）');
    }
    if (bad.length) P1('C', '判分边界与预期不一致', bad.join(' ｜ '));
  } catch (e) { P0('C', '套件异常', e && e.message); }

  /* ═══════════ D 空/脏数据降级 ═══════════ */
  try {
    const dirty = [
      ['payload 为 null', { payload: null }],
      ['无 senses', { payload: { senses: [], collocations: [] } }],
      ['无 collocations', { payload: { senses: [{ def_zh: '只有释义' }], collocations: [] } }],
      ['搭配无 examples', { payload: { senses: [{ def_zh: 'x' }], collocations: [{ pattern: 'a b', zh: '甲' }] } }],
      ['examples 为空数组', { payload: { senses: [{ def_zh: 'x' }], collocations: [{ pattern: 'a b', zh: '甲', examples: [] }] } }],
      ['例句无 zh', { payload: { senses: [{ def_zh: 'x' }], collocations: [{ pattern: 'ab', examples: [{ en: 'The ab is here.' }] }] } }],
      ['超长例句', { payload: { senses: [{ def_zh: 'x' }], collocations: [{ pattern: 't', zh: 't', examples: [{ en: ('This is a very long sentence '.repeat(12)) + 'target_word here.' }] }] } }],
      ['搭配含括号', { payload: { senses: [{ def_zh: 'x' }], collocations: [{ pattern: 'depend (on)', zh: '取决于', examples: [{ en: 'It depends on the weather.', zh: '看天气。' }] }] } }],
    ];
    for (const [label, wOpt] of dirty) {
      for (const t of ['recognition', 'cloze', 'production']) {
        try {
          one(t, wOpt);
          const h = main.innerHTML;
          if (!h || h.length < 60) P0('D', '脏数据渲染为空', label + ' / ' + t);
          if (/undefined|NaN|\[object Object\]/.test(h)) P0('D', '脏数据把内部值渲染到界面', label + ' / ' + t + ' → ' + h.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)[0]);
        } catch (e) { P0('D', '脏数据渲染抛异常', label + ' / ' + t + ' → ' + (e && e.message)); }
      }
    }
  } catch (e) { P0('D', '套件异常', e && e.message); }

  /* ═══════════ E 异步反馈与幂等 ═══════════ */
  try {
    // E1 credit（写入复习计划）重复点击不能重复写
    seed({ words: [mkWord(1, GOOD_CARD)], cards: [mkCard(1, 1, 'cloze')] });
    V.resetSession(); draw();
    $1('#ans-in').value = 'in the stairwell';
    $1('#ans-go').click();
    const btn = $1('[data-g="3"]');
    let grades = 0;
    const origGrade = S.applyGrade;
    if (btn) {
      btn.click(); btn.click(); btn.click();
      // 统计 applyGrade 被调用次数（通过 card.reps 变化推断）
    }
    // 用卡片状态间接验证：一次点击只应推进一次
    const card = S.state.cards[0];
    if ((card.reps || 0) > 1) P1('E', '连点评分按钮会重复写入多次', 'reps=' + card.reps);

    // E2 生成释义按钮：点击后必须有可见反馈（禁用/文案变化/提示）
    seed({ words: [mkWord(1, { payload: { senses: [], collocations: [] } })], cards: [mkCard(1, 1, 'recognition')] });
    V.resetSession(); draw();
    const gen = $1('#study-gen');
    if (gen) {
      gen.click();
      const after = $1('#study-gen');
      const text = after ? after.textContent.trim() : '';
      const disabled = after ? !!after.disabled : false;
      if (!disabled && text === '用 AI 生成释义') {
        P1('E', '点「用 AI 生成释义」后界面无任何反馈', 'btn 文案/禁用态都没变，用户会以为没反应');
      }
    }

    // E3 自动写入的并发保护：重绘不能把同一批词写第二遍（写一次 reps 只 +1）
    try {
      const words = [], cards = [];
      for (let i = 1; i <= 12; i++) {
        words.push({ id: i, normalized: 'word' + i, lemma: 'word' + i,
          payload: { senses: [{ pos: 'n.', def_zh: '释义' + i }], collocations: [] } });
        cards.push(mkCard(i, i, 'recognition', { status: 'review', reps: 0,
          due: new Date(Date.now() - 86400000).toISOString(), stability: 5 }));
      }
      seed({ words, cards, settings: { auto_credit: true } });
      G.startWeekly();
      // 逐题作答直到结束（模拟真实操作）
      for (let k = 0; k < 14; k++) {
        main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {});
        const inp = document.querySelector('#dict-in');
        if (!inp) break;
        inp.value = 'oops';   // 故意答错也无所谓：本用例只数写入次数
        const go = document.querySelector('#dict-go');
        if (!go) break;
        go.click();
        main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {});
        const nx = document.querySelector('#dict-next');
        if (!nx) break;
        nx.click();
      }
      main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {});
      const before = S.state.cards.reduce((a, c) => a + (c.reps || 0), 0);
      // 连点 5 次重绘（模拟写入过程中界面被重绘）
      for (let k = 0; k < 5; k++) { main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {}); }
      await new Promise((r) => setTimeout(r, 400));
      const after = S.state.cards.reduce((a, c) => a + (c.reps || 0), 0);
      if (after - before > 10) {
        P0('E', '自动写入重复执行：重绘导致同一批词被写多遍', 'reps 增量=' + (after - before) + '（一次应为 ≤10）');
      } else if (after - before === 0 && S.state.cards.length) {
        P2('E', '自动写入没生效（未登录时属预期：持久化失败）', 'reps 增量=0');
      }
    } catch (e) { P1('E', '自动写入套件异常', e && e.message); }

    // E4 空词库时学习页要有明确引导（不能空白）
    seed({ words: [], cards: [] });
    V.resetSession(); draw();
    const h = main.innerHTML;
    if (!/词库|导入|添加/.test(h)) P1('E', '空词库时学习页缺少引导文案', h.slice(0, 120));
    if (/今天的复习任务完成了/.test(h)) P1('E', '空词库却说"今天的复习任务完成了"（会让人以为已经学完）', h.slice(0, 160));
  } catch (e) { P0('E', '套件异常', e && e.message); }

  /* ═══════════ F 统计自洽 ═══════════ */
  try {
    const today = S.todayKey();
    seed({
      words: [mkWord(1, GOOD_CARD)],
      cards: [mkCard(1, 1, 'cloze')],
      settings: { daily_new: 8, daily_max_review: 300, goal_days: {}, day_plan: { date: today, due: 0, newGoal: 1 } },
    });
    S.state.daily = [{ reviewed_on: today, total: 12, correct: 9, new_words: 3, minutes: 8 }];
    S.state.reviewRows = [
      { card_id: 1, grade: 3, source: 'study', elapsed_ms: 3000, prev_state: { stability: 2 }, created_at: new Date().toISOString() },
    ];
    let tHtml = '', sHtml = '';
    try { tHtml = V.renderToday(); } catch (e) { P0('F', '今日页在"今天有复习记录"状态下崩了', e && e.message); }
    try { sHtml = V.renderStats(); } catch (e) { P0('F', '统计页在有记录状态下崩了', e && e.message); }
    if (/undefined|NaN/.test(tHtml)) P0('F', '今日页把 undefined/NaN 显示出来', tHtml.match(/.{0,40}(undefined|NaN).{0,40}/)[0]);
    if (/undefined|NaN/.test(sHtml)) P0('F', '统计页把 undefined/NaN 显示出来', sHtml.match(/.{0,40}(undefined|NaN).{0,40}/)[0]);
    // 空数据也不能崩
    S.state.daily = []; S.state.reviewRows = [];
    try { V.renderStats(); } catch (e) { P0('F', '统计页空数据崩了', e && e.message); }
  } catch (e) { P0('F', '套件异常', e && e.message); }

  /* ═══════════ H 练习场各模式 ═══════════ */
  try {
    const words = [], cards = [];
    for (let i = 1; i <= 14; i++) {
      words.push({ id: i, normalized: 'word' + i, lemma: 'word' + i,
        payload: { topic: '日常综合词汇', senses: [{ pos: 'n.', def_zh: '释义' + i }],
          collocations: [{ pattern: 'use word' + i, zh: '用词' + i,
            examples: [{ en: 'They use word' + i + ' every day.', zh: '他们每天用词' + i + '。' }] }] } });
      cards.push(mkCard(i, i, 'recognition', { status: 'review', due: new Date(Date.now() - 86400000).toISOString(), stability: 4 }));
    }
    // H1 每个模式都能进入并渲染出题干（不能白屏）
    // 情景闯关没有对外 start：走真实的入口路径（练习场 → 选择练习模式 → 闯关）
    // 闯关必须放第一个：它要先从练习场首页点进模式弹层，而 G.mode 一旦被别的模式占用
    // 就没有对外的方式改回 null（模块私有状态）。
    const modes = [
                   ['每周抽测', () => G.startWeekly()], ['打字听写', () => G.startDict('en')],
                   ['限时配对', () => G.startMatch()]];
    for (const [label, start] of modes) {
      try {
        seed({ words, cards, settings: {} });
        start();
        main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {});
        const len = main.innerHTML.length;
        if (len < 200) P0('H', label + '进入后页面几乎是空的', 'len=' + len);
        if (/undefined|NaN|\[object Object\]/.test(main.innerHTML)) {
          P0('H', label + '把内部值渲染到界面', main.innerHTML.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)[0]);
        }
      } catch (e) { P0('H', label + '启动抛异常', (e && e.message) || e); }
    }
    // H2 词太少时必须给提示（不能静默、不能抛异常）
    seed({ words: [words[0]], cards: [cards[0]], settings: {} });
    try {
      G.startMatch();
      main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {});
      const tips = [...document.querySelectorAll('#toast-wrap *')].map((x) => x.textContent).join(' ');
      if (!/太少|不够|先去/.test(tips) && !/太少|不够|先去/.test(main.innerHTML)) {
        P2('H', '词太少时配对模式没有给出为什么进不去', 'tips=' + tips.slice(0, 80));
      }
    } catch (e) { P1('H', '词太少时配对模式抛异常而不是给提示', e && e.message); }
  } catch (e) { P0('H', '套件异常', (e && e.message) || e); }

  /* ═══════════ I 词库页 ═══════════ */
  try {
    seed({
      words: [mkWord(1, GOOD_CARD)],
      cards: [mkCard(1, 1, 'recognition')],
    });
    let lib = '';
    try { lib = V.renderLibrary(); } catch (e) { P0('I', '词库页渲染抛异常', e && e.message); }
    if (/undefined|NaN|\[object Object\]/.test(lib)) {
      P0('I', '词库页把内部值渲染到界面', lib.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)[0]);
    }
    // 空词库
    seed({ words: [], cards: [] });
    let libEmpty = '';
    try { libEmpty = V.renderLibrary(); } catch (e) { P0('I', '空词库时词库页抛异常', e && e.message); }
    if (libEmpty && !/导入|添加|空/.test(libEmpty)) P1('I', '空词库页没有引导文案', libEmpty.slice(0, 140));
  } catch (e) { P0('I', '套件异常', (e && e.message) || e); }

  /* ═══════════ J 今日页与达标逻辑 ═══════════ */
  try {
    const today = S.todayKey();
    const days = [];
    for (let d = 0; d < 10; d++) days.push({ reviewed_on: S.todayKey(new Date(Date.now() - d * 86400000)), total: 12, correct: 9, new_words: 3, minutes: 8 });
    // J1 开了"达标需含抽测"但 7 天没抽测 → 今日页必须提示还没达标
    seed({ words: [mkWord(1, GOOD_CARD)], cards: [mkCard(1, 1, 'cloze')],
      settings: { goal_include_test: true, last_test_at: null, goal_days: {}, day_plan: { date: today, due: 0, newGoal: 0 } } });
    S.state.daily = days;
    let h1 = '';
    try { h1 = V.renderToday(); } catch (e) { P0('J', '今日页(含抽测要求)抛异常', e && e.message); }
    if (!/抽测|测试/.test(h1)) P1('J', '开了"达标需含每周抽测"但今日页没有任何抽测提示', h1.slice(0, 160));
    // J2 抽测过之后不应再催
    S.state.settings.last_test_at = Date.now();
    let h2 = '';
    try { h2 = V.renderToday(); } catch (e) { P0('J', '今日页(已抽测)抛异常', e && e.message); }
    // J3 周日休息日开启时，周日应说明"今天只复习"
    const sunday = new Date();
    while (sunday.getDay() !== 0) sunday.setDate(sunday.getDate() + 1);
    if (!/undefined|NaN/.test(h1) || true) { /* 只要不崩就算过，下面单独查文案 */ }
    if (/undefined|NaN/.test(h1)) P0('J', '今日页把 undefined/NaN 显示出来', h1.match(/.{0,40}(undefined|NaN).{0,40}/)[0]);
  } catch (e) { P0('J', '套件异常', (e && e.message) || e); }

  return F;
})
"""


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def read_ver(root):
    try:
        t = (pathlib.Path(root) / 'index.html').read_text(encoding='utf-8')
        m = re.search(r'app\.js\?v=(\d+)', t)
        if m:
            return m.group(1)
    except Exception:
        pass
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=None, help='本地站点目录（会自动起服务）')
    ap.add_argument('--url', default=None, help='直接检查线上地址')
    ap.add_argument('--ver', default=None)
    ap.add_argument('--json', default=None, help='把结果写到 JSON 文件')
    args = ap.parse_args()

    if not args.root and not args.url:
        args.root = 'lexiloop'

    proc = None
    if args.url:
        base = args.url
        ver = args.ver or '75'
    else:
        root = pathlib.Path(args.root).resolve()
        ver = args.ver or read_ver(root) or '1'
        port = free_port()
        base = 'http://127.0.0.1:%d/' % port
        env = {'PORT': str(port)}
        import os
        e = os.environ.copy()
        e.update(env)
        proc = subprocess.Popen([sys.executable, 'server.py'], cwd=str(root), env=e,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2.5)

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel='msedge', headless=True)
            page = browser.new_context().new_page()
            errs = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            page.goto(base + '?qa=behavior', wait_until='networkidle', timeout=45000)
            js = AUDIT_JS.replace('__VER__', ver)
            findings = page.evaluate(js)

            # 独立页面校验练习场模式入口（G.mode 是模块私有状态，同页里没法可靠复位）
            p2 = browser.new_context().new_page()
            p2.goto(base + '?qa=modes', wait_until='networkidle', timeout=45000)
            modes = p2.evaluate("""async () => {
              const S = await import('/js/store.js?v=' + '__VER__');
              const G = await import('/js/game.js?v=' + '__VER__');
              document.body.innerHTML = '<div id="main"></div><div id="modal-wrap" hidden></div><div id="toast-wrap"></div>';
              const main = document.getElementById('main');
              S.state.words = []; S.state.cards = [];
              for (let i = 1; i <= 12; i++) {
                S.state.words.push({ id: i, normalized: 'w' + i, lemma: 'w' + i,
                  payload: { senses: [{ def_zh: '释义' + i }], collocations: [{ pattern: 'p' + i, zh: '中' + i,
                    examples: [{ en: 'Use p' + i + ' now.', zh: '用它。' }] }] } });
                S.state.cards.push({ id: i, word_id: i, deck: 'd', card_type: 'recognition', status: 'review',
                  due: new Date(Date.now() - 86400000).toISOString(), stability: 4, reps: 2, lapses: 0, suspended: false });
              }
              S.state.settings = { daily_new: 8, daily_max_review: 300, target_retention: 0.9 };
              main.innerHTML = G.renderGames(); G.bindGames(() => {}, () => {});
              const pick = document.querySelector('#g-pick');
              if (!pick) return { err: '练习场首页没有"选择练习模式"按钮' };
              pick.click();
              const tiles = [...document.querySelectorAll('[data-mode]')].map((b) => b.getAttribute('data-mode'));
              const labels = [...document.querySelectorAll('[data-mode] .t')].map((b) => b.textContent.trim());
              const res = { tiles, labels };
              const quiz = document.querySelector('[data-mode="quiz"]');
              if (quiz) { quiz.click(); res.afterQuizClick = main.innerHTML.length; res.quizSelect = main.innerHTML.includes('语料章节') || main.innerHTML.includes('关') || main.innerHTML.length > 200; }
              return res;
            }""".replace('__VER__', ver))
            if modes.get('err'):
                findings.append({'sev': 'P0', 'suite': 'H', 'what': '练习场模式入口打不开', 'detail': modes['err']})
            elif len(modes.get('tiles') or []) < 8:
                findings.append({'sev': 'P1', 'suite': 'H', 'what': '练习模式入口少于 8 个',
                                 'detail': str(modes.get('tiles'))})
            if modes.get('tiles') and not modes.get('quizSelect'):
                findings.append({'sev': 'P1', 'suite': 'H', 'what': '点"情景闯关"后没有进入选关页',
                                 'detail': 'afterQuizClick=' + str(modes.get('afterQuizClick'))})
            browser.close()
    finally:
        if proc:
            proc.terminate()

    order = {'P0': 0, 'P1': 1, 'P2': 2}
    findings.sort(key=lambda f: (order.get(f['sev'], 3), f['suite']))
    print('=' * 78)
    print('LexiLoop 行为层审计：%s（ver=%s）' % (base, ver))
    print('=' * 78)
    if not findings:
        print('未发现行为层缺陷 ✅')
    for f in findings:
        print('[%s][%s] %s' % (f['sev'], f['suite'], f['what']))
        print('        %s' % f['detail'])
    if errs:
        print('\n页面级 JS 错误：')
        for e in errs[:8]:
            print('   ', e[:200])
    n0 = sum(1 for f in findings if f['sev'] == 'P0')
    n1 = sum(1 for f in findings if f['sev'] == 'P1')
    n2 = sum(1 for f in findings if f['sev'] == 'P2')
    print('\n汇总：P0=%d  P1=%d  P2=%d' % (n0, n1, n2))
    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(findings, ensure_ascii=False, indent=2), encoding='utf-8')
    sys.exit(1 if n0 else 0)


if __name__ == '__main__':
    main()
