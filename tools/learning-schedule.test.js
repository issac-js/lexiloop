'use strict';
// Offline only: real application modules, fixed fixtures, no credentials or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const DAY = 86400000, MIN = 60000;

async function withApp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiloop-learning-'));
  const previous = { localStorage: globalThis.localStorage, window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const storage = new Map(), requests = [];
  const js = path.join(__dirname, '../lexiloop/js');
  const version = fs.readFileSync(path.join(js, 'store.js'), 'utf8').match(/config\.js\?v=(\d+)/)[1];
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    for (const file of fs.readdirSync(js)) if (file.endsWith('.js')) fs.copyFileSync(path.join(js, file), path.join(dir, file));
    globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
    globalThis.fetch = () => { throw Error('Network forbidden in offline regression'); };
    const database = {
      rpc: async (name, args) => { requests.push({ name, args }); return { data: name === 'study_stats' ? [] : { ok: true }, error: null }; },
      from: () => {
        const builder = { upsert() { return this; }, select() { return this; }, order() { return this; }, limit() { return this; },
          then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); } };
        return builder;
      },
    };
    globalThis.window = { addEventListener() {}, WorkBuddyCloud: { createWorkBuddyCloud: () => ({ database }) } };
    const load = (name, query = '?v=' + version) => import(pathToFileURL(path.join(dir, name)).href + query);
    const [S, F, C, V] = await Promise.all(['store.js', 'fsrs.js', 'config.js', 'views.js'].map((name) => load(name)));
    S.state.user = { id: 'isolated-fixture' };
    S.state.settings = { ...C.DEFAULT_SETTINGS, rest_weekday: '', goal_include_test: false, day_plan: { date: S.todayKey(), due: 0, newGoal: 8 } };
    S.state.load.phase = 'ready'; S.state.load.hydrated = true;
    const card = (id, status = 'review', due = Date.now() - MIN) => ({
      id, word_id: id, status, due, deck: '默认词单', card_type: 'recognition',
      stability: status === 'new' ? 0 : 5, difficulty: 5, reps: status === 'new' ? 0 : 5, lapses: 0, last_review_at: Date.now() - DAY,
    });
    const seed = (cards) => {
      S.state.cards = cards;
      S.state.words = cards.map((c) => ({ id: c.word_id, normalized: 'word' + c.word_id, payload: { senses: [{ def_zh: '测试词' }] } }));
      S.reindex();
    };
    await run({ S, F, C, V, seed, card, load, storage, requests, database });
  } finally {
    // Let the application's debounced local save complete before restoring globals.
    await new Promise((resolve) => setTimeout(resolve, 270));
    Object.assign(globalThis, previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('new installs and one-click recommendation share the 1-day default; explicit custom values remain available', () => withApp(({ C, V, S }) => {
  assert.equal(C.DEFAULT_SETTINGS.learn_step_days, 1);
  assert.equal(C.RECOMMENDED_SETTINGS.learn_step_days, 1);
  for (const key of Object.keys(C.RECOMMENDED_SETTINGS)) assert.equal(C.DEFAULT_SETTINGS[key], C.RECOMMENDED_SETTINGS[key]);
  S.state.settings.learn_step_days = 7;
  assert.match(V.renderMe(), /id="st-stepdays" value="7"/);
  assert.match(V.renderMe(), /跨日 1 天/);
  Object.assign(S.state.settings, C.RECOMMENDED_SETTINGS);
  assert.match(V.renderMe(), /id="st-stepdays" value="1"/);
}));

test('repeated failures cannot skip the first successful 10-minute consolidation', () => withApp(({ F }) => {
  for (let failures = 1; failures <= 12; failures++) {
    let card = null, now = Date.UTC(2026, 9, 26, 9);
    for (let i = 0; i < failures; i++) { card = F.review(card, 1, now).card; now = card.due; }
    const firstSuccess = F.review(card, 3, now);
    assert.equal(firstSuccess.card.due - now, 10 * MIN);
    assert.equal(firstSuccess.card.status, 'learning');
    const secondSuccess = F.review(firstSuccess.card, 3, firstSuccess.card.due);
    assert.equal(secondSuccess.intervalDays, 1);
    assert.equal(secondSuccess.card.status, 'review');
    assert.equal(secondSuccess.card.reps, failures + 2);
  }
}));

test('Hard holds the learning stage; Again resets it, including after legacy learning cards', () => withApp(({ F }) => {
  const now = Date.UTC(2026, 9, 26, 9);
  let c = F.review(null, 2, now).card;
  c = F.review(c, 3, c.due).card;
  assert.equal(c.status, 'learning');
  const hard = F.review(c, 2, c.due);
  assert.equal(hard.card.status, 'learning');
  assert.equal(hard.intervalDays * DAY, 10 * MIN);
  const again = F.review({ ...c, reps: 99 }, 1, c.due);
  const recovered = F.review(again.card, 4, again.card.due);
  assert.equal(recovered.intervalDays * DAY, 10 * MIN);
  assert.equal(F.review(recovered.card, 3, recovered.card.due).intervalDays, 1);
}));

test('mature cards retain FSRS scheduling; relearning and JSON round trips preserve stages without new columns', () => withApp(({ F, card }) => {
  const now = Date.now(), mature = card(1);
  const before = JSON.stringify(mature);
  const preview = F.preview(mature, 3, now);
  const result = F.review(mature, 3, now);
  assert.equal(JSON.stringify(mature), before);
  assert.equal(preview.due, result.card.due);
  assert.equal(result.intervalDays, Math.max(1, Math.round(F.intervalForRetention(result.card.stability, .9))));
  const failed = F.review(mature, 1, now).card;
  const recovered = F.review(JSON.parse(JSON.stringify(failed)), 3, failed.due).card;
  assert.equal(recovered.status, 'learning');
  assert.equal(recovered.due - failed.due, 10 * MIN);
  assert.equal(F.review(JSON.parse(JSON.stringify(recovered)), 3, recovered.due).intervalDays, 1);
}));

test('custom intervals still work after successful consolidation', () => withApp(({ F }) => {
  const steps = { minutes: 30, days: 3 }, now = Date.now();
  const first = F.review(null, 3, now, .9, undefined, steps);
  assert.equal(first.card.due - now, 30 * MIN);
  assert.equal(F.review(first.card, 3, first.card.due, .9, undefined, steps).intervalDays, 3);
}));

test('daily limit persists across queue rebuilds, module reload, stale statistics and account changes', () => withApp(async ({ S, card, seed, load }) => {
  S.state.settings.daily_max_review = 3;
  seed([1, 2, 3, 4, 5].map((id) => card(id)));
  assert.equal(S.buildQueue().length, 3);
  S.applyGrade(S.state.cards[0], 3);
  assert.equal(S.buildQueue().length, 2);
  await S.pullStats(); // fixture intentionally returns stale empty statistics
  assert.equal(S.dailyReviewAllowance(), 2);
  const reloaded = await load('store.js', '?reload=quota');
  reloaded.state.user = S.state.user;
  reloaded.state.settings.daily_max_review = 3;
  assert.equal(reloaded.dailyReviewAllowance(), 2);
  S.applyGrade(S.state.cards[1], 3); S.applyGrade(S.state.cards[2], 3);
  assert.equal(S.buildQueue().length, 0);
  assert.equal(S.buildWeakQueue().length, 0);
  assert.throws(() => S.applyGrade(S.state.cards[3], 3), /今日正式作答上限/);
  S.state.user = { id: 'other-isolated-fixture' };
  assert.equal(S.dailyReviewAllowance(), 3);
}));

test('0 means no formal answers; all streams share the last remaining slot', () => withApp(({ S, card, seed }) => {
  seed([card(1), card(2, 'new'), { ...card(3, 'new'), word_id: 1 }]);
  S.state.settings.daily_max_review = 0;
  assert.equal(S.dailyReviewAllowance(), 0); assert.deepEqual(S.buildQueue(), []);
  assert.equal(S.newAllowance(), 0);
  S.state.settings.daily_max_review = 1;
  assert.equal(S.buildQueue().length, 1);
  S.applyGrade(S.state.cards[0], 1);
  assert.deepEqual(S.buildQueue(), []);
  assert.match(S.state.cards[0].status, /relearning/);
}));

test('server counts constrain the cap and a new local day restores the budget', () => withApp(({ S }) => {
  S.state.settings.daily_max_review = 10;
  const now = Date.now();
  S.state.daily = [{ reviewed_on: S.todayKey(), total: 8, new_words: 3 }];
  assert.equal(S.dailyReviewAllowance(now), 2);
  assert.equal(S.newAllowance(now), 2);
  assert.equal(S.dailyReviewAllowance(now + DAY), 10);
}));

test('test answers do not consume quota or mutate cards, including explicit practice test flags', () => withApp(async ({ S, card, seed, requests }) => {
  seed([card(1)]); S.state.settings.daily_max_review = 0;
  const before = JSON.stringify(S.state.cards);
  S.state.testSession = true;
  S.applyGrade(S.state.cards[0], 1);
  S.state.testSession = false;
  assert.equal(await S.creditGrades([{ id: 1, ok: true }], { isTest: true }), 1);
  assert.equal(JSON.stringify(S.state.cards), before);
  assert.equal(S.dailyReviewed(), 0);
  assert.equal(requests.find((r) => r.name === 'record_review').args.p_is_test, true);
}));

test('practice automatic credit stops at the same cap', () => withApp(async ({ S, card, seed, requests }) => {
  seed([card(1), card(2), card(3)]); S.state.settings.daily_max_review = 2;
  assert.equal(await S.creditGrades([1, 2, 3].map((id) => ({ id, ok: true }))), 2);
  assert.equal(requests.filter((r) => r.name === 'record_review').length, 2);
  assert.equal(S.dailyReviewAllowance(), 0);
}));

test('showing an answer without recalling is Again, not a successful Hard review', () => withApp(({ S, card, seed }) => {
  seed([card(1)]);
  const res = S.applyGrade(S.state.cards[0], 4, { hinted: 'hard' });
  assert.equal(res.log.grade, 1);
  assert.equal(res.card.status, 'relearning');
  assert.equal(res.intervalDays * DAY, 10 * MIN);
}));

test('real study click handlers preserve retry event IDs, apply the displayed grade and do not immediately repeat failed cards', () => withApp(async ({ S, V, card, seed, database, requests }) => {
  seed([card(1), card(2), card(3)]);
  S.state.settings.daily_max_review = 3;
  const reveal = {}, button = { dataset: { g: '4' } };
  globalThis.document = { querySelector: (selector) => selector === '#reveal' ? reveal : null,
    querySelectorAll: (selector) => selector === '[data-g]' ? [button] : [] };
  V.resetSession();
  const firstId = V.sessionQueueIds()[0];
  V.bindStudy(() => {}, () => {});
  reveal.onclick();
  assert.match(V.renderStudy(), /10 分钟/);
  database.rpc = async (name, args) => { requests.push({ name, args }); return { error: Error('fixture offline') }; };
  await button.onclick();
  assert.equal(S.dailyReviewed(), 1);
  assert.equal(requests[0].args.p_grade, 1);
  assert.ok(!V.sessionQueueIds().includes(firstId));
  assert.equal(S.pendingCount(), 1);
  const originalEvent = requests[0].args.p_event_id;
  V.resetSession();
  database.rpc = async (name, args) => { requests.push({ name, args }); return { data: { ok: true }, error: null }; };
  await S.flushPending();
  assert.equal(requests[1].args.p_event_id, originalEvent);
  assert.equal(S.dailyReviewed(), 1, 'retrying persistence must not consume another answer');
  assert.equal(S.pendingCount(), 0);
}));

test('single-word fallback can confirm attempted recall without being forced to Again', () => withApp(async ({ S, V, card, seed, requests }) => {
  seed([card(1, 'new')]);
  const check = {}, button = { dataset: { g: '3' } };
  globalThis.document = { querySelector: (selector) => selector === '#ans-check' ? check : null,
    querySelectorAll: (selector) => selector === '[data-g]' ? [button] : [] };
  V.resetSession();
  assert.match(V.renderStudy(), /id="ans-check"/);
  V.bindStudy(() => {}, () => {}); check.onclick();
  await button.onclick();
  assert.equal(requests.find((r) => r.name === 'record_review').args.p_grade, 3);
  assert.equal(S.state.cards[0].status, 'learning');
}));

test('starting a new session clears the prior session click cooldown after a clock correction', () => withApp(async ({ S, V, card, seed, requests }) => {
  const originalNow = Date.now;
  let now = Date.UTC(2026, 9, 26, 9);
  try {
    Date.now = () => now;
    seed([card(1, 'review', now - 2 * DAY), card(2, 'review', now - 2 * DAY)]);
    const reveal = {}, button = { dataset: { g: '1' } };
    globalThis.document = { querySelector: (selector) => selector === '#reveal' ? reveal : null,
      querySelectorAll: (selector) => selector === '[data-g]' ? [button] : [] };
    V.resetSession(); V.bindStudy(() => {}, () => {}); reveal.onclick(); await button.onclick();
    now -= MIN;
    V.resetSession(); V.bindStudy(() => {}, () => {}); reveal.onclick(); await button.onclick();
    assert.equal(requests.filter((r) => r.name === 'record_review').length, 2);
  } finally { Date.now = originalNow; }
}));

test('touch checkbox focus does not activate the virtual-keyboard layout', async () => {
  const previous = { window: globalThis.window, document: globalThis.document };
  const listeners = {}, classes = new Set();
  try {
    globalThis.window = { matchMedia: () => ({ matches: true }), addEventListener() {} };
    globalThis.document = { addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
      body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } } };
    const source = fs.readFileSync(path.join(__dirname, '../lexiloop/js/ui.js'), 'utf8');
    await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    for (const type of ['checkbox', 'radio', 'range']) {
      listeners.focusin[0]({ target: { tagName: 'INPUT', type } });
      assert.equal(classes.has('kbd'), false, type + ' must not hide navigation');
    }
    listeners.focusin[0]({ target: { tagName: 'INPUT', type: 'number' } });
    assert.equal(classes.has('kbd'), true);
    listeners.focusout[0](); assert.equal(classes.has('kbd'), true, 'blur must not move navigation before the save click');
    listeners.click[0](); assert.equal(classes.has('kbd'), false);
  } finally { Object.assign(globalThis, previous); }
});

test('overdue cards pause fresh words; same-day due cards, filters and suspended cards are handled correctly', () => withApp(({ S, card, seed }) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  seed([card(1, 'review', start.getTime() - MIN), card(2, 'new')]);
  assert.equal(S.newAllowance(), 0);
  assert.ok(S.buildQueue().every((c) => c.status !== 'new'));
  S.state.cards[0].due = Date.now() + DAY;
  assert.equal(S.newAllowance(), 8);
  S.state.cards[0].due = start.getTime();
  assert.equal(S.newWordsPaused(), false);
  S.state.cards[0].due = start.getTime() - MIN;
  S.state.cards[0].suspended = true;
  assert.equal(S.newWordsPaused(), false);
  S.state.cards[0].suspended = false;
  S.state.cards[0].deck = 'other'; S.state.settings.deck_filter = '默认词单';
  assert.equal(S.newWordsPaused(), false);
  S.state.settings.deck_filter = ''; S.state.settings.pause_new_when_overdue = false;
  assert.equal(S.newAllowance(), 8);
}));

test('recorded achievement survives 39 newly due cards while the current task stays at 88%', () => withApp(({ S, V, card, seed }) => {
  const now = Date.now(), today = S.todayKey();
  seed(Array.from({ length: 106 }, (_, i) => ({ ...card(i + 1, 'review', now + DAY),
    last_review_at: i < 67 ? now : now - DAY })));
  S.state.daily = [{ reviewed_on: today, total: 67, new_words: 8 }];
  Object.assign(S.state.settings, { goal_include_test: true, last_test_at: now });
  assert.equal(S.markGoalIfMet(), true);
  assert.equal(S.goalStats(30).hit, 1);
  for (const c of S.state.cards.slice(67)) c.due = now - 1;
  const gp = S.goalProgress(), html = V.renderToday();
  assert.equal(gp.met, true);
  assert.equal(gp.recorded, true);
  assert.equal(gp.currentMet, false);
  assert.equal(gp.dueNow, 39);
  assert.match(html, /复习 67 \/ 106/);
  assert.match(html, /当前任务完成度 88%/);
  assert.match(html, /今日已达标，当前仍有 39 张到期卡片/);
  assert.match(html, /开始学习（39 张）/);
  assert.equal(S.markGoalIfMet(), false);
  assert.equal(S.goalStats(30).hit, 1);
  assert.equal(S.goalStats(30).streak, 1);
  for (const c of S.state.cards.slice(67)) c.due = now + DAY;
  const cleared = V.renderToday();
  assert.match(cleared, /当前任务完成度 100%/);
  assert.doesNotMatch(cleared, /id="goal-status-note"/);
}));

test('unrecorded pending tasks remain unmet; recorded due cards respect the exhausted daily cap', () => withApp(({ S, V, card, seed }) => {
  const today = S.todayKey();
  seed([card(1)]);
  S.state.daily = [{ reviewed_on: today, total: 0, new_words: 8 }];
  assert.equal(S.goalProgress().met, false);
  assert.match(V.renderToday(), /今日还差 1 张复习/);
  assert.doesNotMatch(V.renderToday(), /今日已达标/);
  S.state.settings.goal_days = { [today]: true };
  S.state.settings.daily_max_review = 1;
  S.state.daily[0].total = 1;
  const html = V.renderToday();
  assert.match(html, /当前仍有 1 张到期卡片/);
  assert.match(html, /今日作答额度已用完，明天继续/);
  assert.doesNotMatch(html, /可按今日剩余额度继续复习/);
  assert.equal(S.buildQueue().length, 0);
}));

test('goals and rendered pages explain paused new words and an exhausted cap without false completion', () => withApp(({ S, V, card, seed }) => {
  seed([card(1, 'review', Date.now() - 2 * DAY), card(2, 'new')]);
  S.state.settings.daily_max_review = 1;
  S.state.settings.day_plan.due = 8;
  assert.equal(S.goalProgress().plan.due, 1);
  assert.equal(S.goalProgress().plan.newGoal, 0);
  assert.match(V.renderToday(), /跨日逾期卡/);
  S.applyGrade(S.state.cards[0], 1);
  const html = V.renderToday();
  assert.match(html, /已达到今日作答上限/);
  assert.doesNotMatch(html, /今天的任务完成了/);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.equal(S.goalProgress().met, true);
  V.resetSession();
  assert.match(V.renderStudy(), /已达到今日作答上限/);
}));
