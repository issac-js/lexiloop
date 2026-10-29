/* Test-only SDK, served exclusively by the loopback fixture server. No real accounts or network. */
(() => {
  const NativeDate = Date;
  const params = new URLSearchParams(location.search);
  let scenario = params.get('fixture') || 'normal';
  const fixed = NativeDate.UTC(2026, 9, 26, 9);
  let offset = fixed - NativeDate.now();
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [NativeDate.now() + offset])); }
    static now() { return NativeDate.now() + offset; }
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const key = () => '__lexiloop_fixture_' + scenario;
  let data;
  function fresh(name) {
    const cards = [], words = [];
    const count = name === 'large' ? 1205 : name === 'learning' ? 1 : name === 'goal-recorded' ? 106 : 12;
    for (let i = 1; i <= count; i++) {
      const term = i === 1 ? 'make arrangements for a follow-up appointment' : 'follow up ' + i;
      words.push({ id: i, normalized: term, lemma: term, verification_status: 'verified', payload: {
        senses: [{ pos: 'phrase', def_zh: '安排后续预约' + i, def_en: 'arrange a follow-up appointment' }],
        collocations: [{ pattern: term, zh: '安排后续预约', examples: [{ en: 'Please ' + term + ' tomorrow.', zh: '请安排后续预约。' }] }],
      } });
      const isNew = name === 'learning' || (!['large', 'goal-recorded'].includes(name) && i > 6);
      cards.push({ id: i, word_id: i, card_type: 'recognition', deck: '默认词单', status: isNew ? 'new' : 'review',
        due: new Date(Date.now() - (name === 'overdue' && i === 1 ? 2 * 86400000 : 60000)).toISOString(),
        stability: isNew ? 0 : 5, difficulty: 5, reps: isNew ? 0 : 5, lapses: 0, last_review_at: new Date(Date.now() - 3 * 86400000).toISOString() });
    }
    const recorded = name === 'goal-recorded';
    if (recorded) for (const c of cards.slice(0, 67)) {
      c.due = new Date(Date.now() + 86400000).toISOString(); c.last_review_at = new Date().toISOString();
    }
    return { cards, words, reviews: [], goals: recorded ? [{ day: today() }] : [], events: [],
      stats: recorded ? [{ reviewed_on: today(), total: 67, new_words: 8 }] : [], ranges: [],
      settings: { daily_new: 8, daily_max_review: name === 'quota' ? 2 : 300, target_retention: .9,
        extra: { learn_step_minutes: 10, learn_step_days: name === 'normal' ? 7 : 1,
          rest_weekday: '', goal_include_test: recorded, last_test_at: recorded ? Date.now() : null,
          day_plan: recorded ? { date: today(), due: 106, newGoal: 8 } : null,
          pause_new_when_overdue: true, auto_credit: true } } };
  }
  try { data = JSON.parse(localStorage.getItem(key())); } catch (_) { /* new fixture */ }
  if (!data) data = fresh(scenario);
  function save() { localStorage.setItem(key(), JSON.stringify(data)); }
  function query(table) {
    let filters = [], from = 0, end = Infinity, maximum = Infinity, count = false, head = false, write;
    const q = {
      select(_columns, opts = {}) { count = opts.count === 'exact'; head = !!opts.head; return q; },
      order() { return q; }, limit(n) { maximum = n; return q; },
      range(a, b) { data.ranges.push({ table, from: a, to: b }); from = a; end = b; return q; },
      in(field, values) { filters.push((row) => values.includes(row[field])); return q; },
      eq(field, value) { filters.push((row) => row[field] === value); return q; },
      gte(field, value) { filters.push((row) => row[field] >= value); return q; },
      upsert(row) { write = row; return q; },
      maybeSingle: async () => ({ data: table === 'settings' ? clone(data.settings) : null, error: null }),
      then(resolve, reject) {
        try {
          if (write) {
            if (table === 'settings') data.settings = clone(write);
            else if (table === 'goal_days') {
              for (const row of Array.isArray(write) ? write : [write]) if (!data.goals.some((g) => g.day === row.day)) data.goals.push(clone(row));
            }
            else throw Error('Unsupported fixture write: ' + table);
            save();
          }
          let rows = table === 'goal_days' ? data.goals : table === 'settings' ? [data.settings] : data[table] || [];
          for (const filter of filters) rows = rows.filter(filter);
          const total = rows.length; rows = rows.slice(from, Math.min(end + 1, from + maximum));
          return Promise.resolve({ data: head ? null : clone(rows), count: count ? total : null, error: null }).then(resolve, reject);
        } catch (error) { return Promise.reject(error).then(resolve, reject); }
      },
    };
    return q;
  }
  const database = { from: query, rpc: async (name, args) => {
    if (name === 'study_stats') return { data: clone(data.stats), error: null };
    if (name !== 'record_review') throw Error('Unsupported fixture RPC: ' + name);
    if (data.events.includes(args.p_event_id)) return { data: { ok: true, dedup: true }, error: null };
    data.events.push(args.p_event_id);
    if (!args.p_is_test) {
      const card = data.cards.find((c) => c.id === args.p_card_id);
      if (!card) throw Error('Unknown fixture card');
      const wasNew = card.status === 'new';
      Object.assign(card, clone(args.p_next_state), { due: new Date(args.p_next_state.due).toISOString(),
        reps: card.reps + 1, lapses: card.lapses + (args.p_grade === 1 ? 1 : 0), last_grade: args.p_grade, last_review_at: new Date().toISOString() });
      let stat = data.stats.find((r) => r.reviewed_on === today());
      if (!stat) { stat = { reviewed_on: today(), total: 0, correct: 0, new_words: 0, minutes: 0 }; data.stats.push(stat); }
      stat.total++; stat.correct += args.p_grade >= 3 ? 1 : 0; stat.new_words += wasNew ? 1 : 0;
      data.reviews.push({ card_id: card.id, word_id: card.word_id, grade: args.p_grade, created_at: new Date().toISOString(),
        prev_state: clone(args.p_prev_state), next_state: clone(args.p_next_state), source: args.p_source });
    }
    save(); return { data: { ok: true, scheduler_applied: !args.p_is_test }, error: null };
  } };
  const auth = { getSession: async () => ({ data: { user: { id: 'browser-fixture-' + scenario, email: 'qa@example.invalid' } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  // Explicit synthetic responses: never contact a billable model.
  const reviewMock = { mode: 'hold', calls: 0, releases: [] };
  const llm = { models: { list: async () => [{ id: 'qa-synthetic-model', name: 'QA synthetic model' }] }, chat: { completions: {
    create: async function* () {
      reviewMock.calls++;
      if (reviewMock.mode === 'hold') await new Promise((resolve) => reviewMock.releases.push(resolve));
      if (reviewMock.mode === 'error') throw Error('Synthetic model failure');
      const content = reviewMock.mode === 'invalid' ? 'not json' :
        JSON.stringify({ pos_ok: true, severity: 'none', collocations: [], missing_senses: [] });
      yield { choices: [{ delta: { content } }] };
    },
  } } };
  window.WorkBuddyCloud = { createWorkBuddyCloud: () => ({ database, auth, llm }) };
  window.__reviewMock = reviewMock;
  window.__QA = { snapshot: () => clone(data), advance: (ms) => { offset += ms; }, reset(name) {
    scenario = name; offset = fixed - NativeDate.now();
    for (const k of Object.keys(localStorage)) if (k.startsWith('lexiloop.')) localStorage.removeItem(k);
    data = fresh(name); save();
  } };
})();
