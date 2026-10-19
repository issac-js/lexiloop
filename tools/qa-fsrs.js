'use strict';
/* LexiLoop · SRS 隔离时钟验证（任务书 13）
 *
 * 目的不是"换个新算法"，而是**核对现有实现到底对不对**。
 * 做法：所有调度函数都接受 now 参数，所以可以完全脱离真实时间，
 * 把"首次学习 → 10 分钟巩固 → 次日复习 → 四评级 → 遗忘重学 → 跨日重试"
 * 在几毫秒里跑完，逐项核对 due / S / D 与 FSRS 公开公式。
 *
 * 用法：node tools/qa-fsrs.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = path.resolve(__dirname, '..', 'lexiloop');
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

const DAY = 86400000;
const MIN = 60000;

async function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gll-fsrs-'));
  for (const f of ['fsrs.js', 'config.js', 'judge.js']) {
    fs.copyFileSync(path.join(APP, 'js', f), path.join(dir, f.replace('.js', '.mjs')));
  }
  // fsrs.js 无相对导入，可直接加载
  const F = await import(pathToFileURL(path.join(dir, 'fsrs.mjs')).href);
  fs.rmSync(dir, { recursive: true, force: true });
  return F;
}

(async () => {
  const F = await load();
  const W = F.DEFAULT_W;
  const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);   // 固定起点，绝不依赖真实时钟

  /* ── 0. 算法自检（内置 10 项不变量）── */
  const st = F.selfTest();
  add('内置自检通过（' + 10 + ' 项不变量）', st.ok, JSON.stringify(st.problems));

  /* ── 1. 常量与公式来源 ── */
  add('FSRS 参数组为公开默认 19 项', W.length === 19, 'len=' + W.length);
  add('DECAY / FACTOR 与官方一致',
    F.DECAY === -0.5 && Math.abs(F.FACTOR - 19 / 81) < 1e-12, F.DECAY + ' / ' + F.FACTOR);

  // R(t,S) 的定义自洽：R(0)=1、R(S,S)=0.9
  add('R(0,S) = 1', Math.abs(F.retrievability(0, 20) - 1) < 1e-12);
  add('R(S,S) = 0.90（S 的定义）', Math.abs(F.retrievability(20, 20) - 0.9) < 1e-9,
    String(F.retrievability(20, 20)));
  add('I(0.9,S) = S（与定义互为反函数）',
    [1, 5, 30, 365].every((s) => Math.abs(F.intervalForRetention(s, 0.9) - s) < 1e-6));

  /* ── 2. 首次学习：四个评级的 S0 / D0 / due ── */
  const firsts = [1, 2, 3, 4].map((g) => F.review(null, g, T0, 0.9));
  firsts.forEach((r, i) => {
    const g = i + 1;
    add('首次评分 ' + g + '：S0 = w[' + i + '] = ' + W[i].toFixed(5),
      Math.abs(r.card.stability - W[i]) < 1e-9, String(r.card.stability));
  });
  const d0 = (g) => Math.min(10, Math.max(1, W[4] - (g - 3) * W[5]));
  firsts.forEach((r, i) => {
    const g = i + 1;
    add('首次评分 ' + g + '：D0 = w[4] − (G−3)·w[5]',
      Math.abs(r.card.difficulty - d0(g)) < 1e-9, String(r.card.difficulty));
  });
  add('首次评分：S 随评分单调递增（Again<Hard<Good<Easy）',
    firsts.every((r, i) => i === 0 || r.card.stability > firsts[i - 1].card.stability),
    firsts.map((r) => r.card.stability.toFixed(2)).join(' < '));
  add('首次评分：难度随评分单调递减（Again 最难）',
    firsts.every((r, i) => i === 0 || r.card.difficulty < firsts[i - 1].card.difficulty),
    firsts.map((r) => r.card.difficulty.toFixed(2)).join(' > '));

  /* ── 3. 学习步骤：10 分钟 → 1 天 → 交给 FSRS ── */
  const l1 = F.review(null, 3, T0, 0.9);
  add('新卡第 1 次「记得」→ 10 分钟后（学习步骤）',
    Math.round((l1.card.due - T0) / MIN) === 10, String((l1.card.due - T0) / MIN) + ' 分钟');
  add('第 1 次后状态为 learning、reps=1',
    l1.card.status === 'learning' && l1.card.reps === 1, l1.card.status + '/' + l1.card.reps);

  const T1 = T0 + 10 * MIN;
  const l2 = F.review(l1.card, 3, T1, 0.9);
  add('第 2 次「记得」→ 1 天后（学习步骤）',
    Math.round((l2.card.due - T1) / DAY) === 1, String((l2.card.due - T1) / DAY) + ' 天');
  add('第 2 次后状态转为 review', l2.card.status === 'review', l2.card.status);

  const T2 = T1 + DAY;
  const l3 = F.review(l2.card, 3, T2, 0.9);
  const gap3 = Math.round((l3.card.due - T2) / DAY);
  add('第 3 次起交给 FSRS 按稳定度排期（间隔 > 1 天）', gap3 > 1, gap3 + ' 天');
  add('第 3 次间隔 ≈ I(0.9, S)，不依赖手写常数',
    Math.abs(gap3 - Math.round(F.intervalForRetention(l3.card.stability, 0.9))) <= 1,
    gap3 + ' vs ' + Math.round(F.intervalForRetention(l3.card.stability, 0.9)));
  add('第 1→3 次稳定度持续增长',
    l1.card.stability < l2.card.stability && l2.card.stability < l3.card.stability,
    [l1, l2, l3].map((x) => x.card.stability.toFixed(2)).join(' → '));

  /* ── 4. ★ 同日复习必须真的改变稳定度（本次修正的核心） ── */
  const mature = { stability: 10, difficulty: 5, reps: 5, lapses: 0, status: 'review', last_review_at: T0 };
  const sameGood = F.preview(mature, 3, T0 + 10 * MIN, 0.9);
  const sameHard = F.preview(mature, 2, T0 + 10 * MIN, 0.9);
  const sameEasy = F.preview(mature, 4, T0 + 10 * MIN, 0.9);
  add('★ 同日复习（记得）稳定度上升', sameGood.stability > 10, String(sameGood.stability));
  add('★ 同日复习：Easy > Good > Hard',
    sameEasy.stability > sameGood.stability && sameGood.stability > sameHard.stability,
    [sameHard, sameGood, sameEasy].map((x) => x.stability.toFixed(2)).join(' < '));
  add('同日复习 Formula = S·exp(w17·(G−3+w18))',
    Math.abs(sameGood.stability - 10 * Math.exp(W[17] * (3 - 3 + W[18]))) < 1e-9,
    String(sameGood.stability));
  add('★ 缺失 last_review_at 的旧数据也不会卡死稳定度',
    F.preview({ stability: 10, difficulty: 5, reps: 5, status: 'review' }, 3, T0, 0.9).stability > 10);

  /* ── 5. 跨日复习：长期公式 ── */
  const crossDay = F.preview(mature, 3, T0 + 5 * DAY, 0.9);
  const rAt5 = F.retrievability(5, 10);
  const expectLong = 10 * (1 + Math.exp(W[8]) * (11 - 5) * Math.pow(10, -W[9]) * (Math.exp((1 - rAt5) * W[10]) - 1));
  add('跨日复习走长期公式 S\' = S·(1 + gain)',
    Math.abs(crossDay.stability - expectLong) < 1e-6,
    crossDay.stability.toFixed(4) + ' vs ' + expectLong.toFixed(4));
  add('间隔越长（R 越低）增长越大',
    F.preview(mature, 3, T0 + 20 * DAY, 0.9).stability > F.preview(mature, 3, T0 + 2 * DAY, 0.9).stability);

  /* ── 6. 遗忘 ── */
  const forgot = F.review(mature, 1, T0 + 10 * DAY, 0.9);
  add('遗忘 → 10 分钟后重学', Math.round((forgot.card.due - (T0 + 10 * DAY)) / MIN) === 10);
  add('遗忘 → lapses +1', forgot.card.lapses === 1, String(forgot.card.lapses));
  add('遗忘 → 状态 relearning', forgot.card.status === 'relearning', forgot.card.status);
  add('遗忘后稳定度下降', forgot.card.stability < 10, String(forgot.card.stability));
  const expectForget = W[11] * Math.pow(5, -W[12]) *
    (Math.pow(10 + 1, W[13]) - 1) * Math.exp(W[14] * (1 - F.retrievability(10, 10)));
  add('遗忘公式与 w11..w14 一致', Math.abs(forgot.card.stability - expectForget) < 1e-9,
    forgot.card.stability.toFixed(4) + ' vs ' + expectForget.toFixed(4));

  /* ── 7. 跨日重试（重学后第二天再复习） ── */
  const T3 = T0 + 10 * DAY + 10 * MIN;
  const relearned = F.review(forgot.card, 3, T3, 0.9);
  add('重学后再次「记得」→ 稳定度回升', relearned.card.stability > forgot.card.stability,
    forgot.card.stability.toFixed(3) + ' → ' + relearned.card.stability.toFixed(3));
  add('重学后 due 仍在未来', relearned.card.due > T3);

  /* ── 8. 日志可回放 ── */
  const lg = F.review(mature, 3, T0 + 3 * DAY, 0.9).log;
  add('日志含 prev_state / next_state',
    !!lg.prev_state && !!lg.next_state && lg.grade === 3, JSON.stringify(lg).slice(0, 90));
  add('日志 prev 记录复习前状态', lg.prev_state.stability === 10 && lg.prev_state.status === 'review');
  add('日志 next 与卡片结果一致', lg.next_state.stability > 10);

  /* ── 9. 与用户设置联动 ── */
  const low = F.review(mature, 3, T0 + 5 * DAY, 0.8).intervalDays;
  const high = F.review(mature, 3, T0 + 5 * DAY, 0.95).intervalDays;
  add('目标留存率越高 → 间隔越短（0.95 < 0.80）', high < low,
    high.toFixed(2) + ' < ' + low.toFixed(2));
  const steps = { minutes: 30, days: 3 };
  const s1 = F.review(null, 3, T0, 0.9, W, steps);
  add('学习步骤可配置（30 分钟 / 3 天）',
    Math.round((s1.card.due - T0) / MIN) === 30, String((s1.card.due - T0) / MIN));
  const s2 = F.review(s1.card, 3, s1.card.due, 0.9, W, steps);
  add('学习步骤第 2 段按配置的 3 天', Math.round((s2.card.due - s1.card.due) / DAY) === 3);
  add('异常步骤配置被兜底（不产生 0 或负间隔）',
    Math.round((F.review(null, 3, T0, 0.9, W, { minutes: -5, days: 0 }).card.due - T0) / MIN) >= 1);

  /* ── 10. 长期稳定性：多轮复习不倒退、不溢出 ── */
  let c = null, last = 0, bad = null;
  for (let i = 0; i < 14; i++) {
    const t = T0 + i * 45 * DAY;
    const r = F.review(c, 3, t, 0.9);
    c = r.card;
    if (r.intervalDays < last) bad = '第 ' + (i + 1) + ' 轮倒退：' + r.intervalDays.toFixed(1) + ' < ' + last.toFixed(1);
    last = r.intervalDays;
  }
  add('14 轮连续复习间隔不倒退', bad === null, bad);
  add('长期稳定度不超过上限 S_MAX', c.stability <= F.S_MAX, String(c.stability));
  add('长期难度保持在 [1,10]', c.difficulty >= 1 && c.difficulty <= 10, String(c.difficulty));

  /* ── 11. 极端输入不产生 NaN ── */
  const extremes = [
    { stability: 0.01, difficulty: 1, reps: 1, status: 'review', last_review_at: T0 },
    { stability: 36500, difficulty: 10, reps: 999, status: 'review', last_review_at: T0 - 3650 * DAY },
    { stability: 1, difficulty: 5, reps: 2, status: 'learning', last_review_at: 0 },
  ];
  let nan = null;
  extremes.forEach((card, i) => {
    [1, 2, 3, 4].forEach((g) => {
      const p = F.preview(card, g, T0, 0.9);
      if (!Number.isFinite(p.stability) || !Number.isFinite(p.difficulty) || !Number.isFinite(p.due)) {
        nan = 'case' + i + ' grade' + g;
      }
    });
  });
  add('极端输入不产生 NaN/Infinity', nan === null, nan);
  let threw = null;
  try { F.review(null, 5, T0) } catch (e) { threw = 'ok' }
  add('非法评级会抛错而不是静默算错', threw === 'ok');

  /* ── 12. 掌握判定 ── */
  add('掌握 = S≥21 且最近评分≥3 且处于 review',
    F.isMastered({ stability: 21, last_grade: 3, status: 'review' }) === true &&
    F.isMastered({ stability: 20.9, last_grade: 3, status: 'review' }) === false &&
    F.isMastered({ stability: 30, last_grade: 2, status: 'review' }) === false &&
    F.isMastered({ stability: 30, last_grade: 3, status: 'learning' }) === false);

  /* ── 13. 人话间隔 ── */
  add('间隔渲染为人话', F.humanInterval(0.007) === '10 分钟' && F.humanInterval(1) === '1 天' &&
    F.humanInterval(45).indexOf('个月') > 0 && F.humanInterval(800).indexOf('年') > 0,
    [F.humanInterval(0.007), F.humanInterval(1), F.humanInterval(45), F.humanInterval(800)].join(' / '));

  /* ── 统计 ── */
  let bad2 = 0;
  out.forEach((o) => { if (!o.pass) bad2++; console.log((o.pass ? '  PASS  ' : '  FAIL  ') + o.n + (o.pass ? '' : '  → ' + o.d)); });
  console.log('\n===== SRS 隔离时钟验证: ' + (out.length - bad2) + '/' + out.length + ' 通过' +
    (bad2 ? ('，' + bad2 + ' 项失败') : '，全部通过') + ' =====');

  /* 模拟一条完整学习轨迹，打印出来便于人工核对 */
  console.log('\n完整轨迹（虚拟时钟）：');
  let card = null;
  let t = T0;
  const plan = [
    ['新卡 · 记得', 3, 0], ['10 分钟后 · 记得', 3, 10 * MIN], ['次日 · 记得', 3, DAY],
    ['+4 天 · 吃力', 2, 4 * DAY], ['+9 天 · 记得', 3, 9 * DAY],
    ['+30 天 · 忘了', 1, 30 * DAY], ['+10 分钟 · 记得', 3, 10 * MIN], ['+1 天 · 很简单', 4, DAY],
  ];
  plan.forEach((p) => {
    t += p[2];
    const r = F.review(card, p[1], t, 0.9);
    card = r.card;
    console.log('  ' + p[0].padEnd(18) + ' S=' + card.stability.toFixed(2).padStart(8) +
      '  D=' + card.difficulty.toFixed(2).padStart(5) +
      '  下次 ' + F.humanInterval(r.intervalDays).padStart(8) +
      '  ' + card.status);
  });

  process.exit(bad2 ? 1 : 0);
})();
