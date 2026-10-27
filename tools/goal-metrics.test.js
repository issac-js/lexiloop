'use strict';
/* 目标完成度的口径回归：锁死"卡片数分母 + 自然闭合"这条规则。
 * 背景（2026-10-27 真机）：复习 64/107、还差 43、待复习 0 —— 次数与卡数相减，
 * 且当日快照不回缩，导致永远达不成。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function load() {
  const src = path.join(__dirname, '..', 'lexiloop', 'js', 'goal-metrics.js');
  const tmp = path.join(os.tmpdir(), 'goal-metrics-test-' + process.pid + '-' + Date.now() + '.mjs');
  fs.copyFileSync(src, tmp);
  try { return await import(pathToFileURL(tmp).href); } finally { fs.rmSync(tmp, { force: true }); }
}

const base = {
  doneCards: 0, dueNow: 0, doneNew: 0, newGoal: 0,
  needTest: false, testDone: true, isRest: false, pausedNew: false, dailyMax: 300,
};

test('截图场景：59 卡已完成、11 张仍到期 → 分母 70，未达标，剩 11 张', async () => {
  const { goalCompletion } = await load();
  const r = goalCompletion(Object.assign({}, base, {
    doneCards: 59, dueNow: 11, doneNew: 8, newGoal: 8, needTest: true, testDone: true,
  }));
  assert.equal(r.dueToday, 70);
  assert.equal(r.reviewMet, false);
  assert.equal(r.goalReviews, 70);
  assert.ok(Math.abs(r.pct - 95) <= 1, 'pct=' + r.pct);
});

test('卡片被推到明天：dueNow=0 → 当日闭合且达标', async () => {
  const { goalCompletion } = await load();
  const r = goalCompletion(Object.assign({}, base, {
    doneCards: 59, dueNow: 0, doneNew: 8, newGoal: 8, needTest: true, testDone: true,
  }));
  assert.equal(r.reviewMet, true);
  assert.equal(r.dueToday, 59);
  assert.equal(r.pct, 100);
});

test('待复习 0 必然等于复习达标（不再出现"还差 N 张"）', async () => {
  const { goalCompletion } = await load();
  for (const doneCards of [0, 1, 37, 120]) {
    const r = goalCompletion(Object.assign({}, base, { doneCards: doneCards, dueNow: 0 }));
    assert.equal(r.reviewMet, true, 'doneCards=' + doneCards);
    assert.equal(r.pct, 100);
  }
});

test('抽测未做时环不到 100%，但仍可复习达标', async () => {
  const { goalCompletion } = await load();
  const r = goalCompletion(Object.assign({}, base, {
    doneCards: 20, dueNow: 0, needTest: true, testDone: false,
  }));
  assert.equal(r.reviewMet, true);
  assert.ok(r.pct < 100);
  assert.ok(r.pct >= 0);
});

test('休息日不纳入新学项，不产生 NaN', async () => {
  const { goalCompletion } = await load();
  const r = goalCompletion(Object.assign({}, base, {
    doneCards: 10, dueNow: 0, isRest: true, doneNew: 0, newGoal: 0,
  }));
  assert.equal(r.parts.length, 1);
  assert.ok(Number.isFinite(r.pct));
  assert.equal(r.pct, 100);
});

test('每日额度封顶分母，已完成超过额度时不超过 100%', async () => {
  const { goalCompletion } = await load();
  const r = goalCompletion(Object.assign({}, base, {
    doneCards: 12, dueNow: 5, dailyMax: 10,
  }));
  assert.equal(r.goalReviews, 10);
  assert.equal(r.pct, 100);
});

test('任意输入下 pct 落在 0..100 且为整数', async () => {
  const { goalCompletion } = await load();
  const cases = [
    { doneCards: 0, dueNow: 0 }, { doneCards: 0, dueNow: 5 },
    { doneCards: 5, dueNow: 0 }, { doneCards: 3, dueNow: 2, doneNew: 1, newGoal: 8 },
    { doneCards: 999, dueNow: 1, dailyMax: 300 },
  ];
  for (const c of cases) {
    const r = goalCompletion(Object.assign({}, base, c));
    assert.ok(Number.isInteger(r.pct) && r.pct >= 0 && r.pct <= 100, JSON.stringify({ c: c, pct: r.pct }));
  }
});
