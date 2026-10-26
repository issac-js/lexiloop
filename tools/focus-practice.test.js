'use strict';
// Read-only offline tests; no credentials, network, database writes or model calls.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../lexiloop/js/focus-core.js'), 'utf8')
const corePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

function fixture(n = 12) {
  const words = [], cards = []
  for (let i = 0; i < n; i++) {
    words.push({ id: i + 1, lemma: 'expression ' + i,
      payload: { senses: [{ def_zh: '不同释义' + i }], topic: i % 2 ? '楼宇出入' : '校园求助' } })
    cards.push({ id: 100 + i, word_id: i + 1, reps: 3, suspended: false,
      last_review_at: new Date(Date.UTC(2026, 8, i + 1)).toISOString() })
  }
  return { words, cards }
}

test('pool excludes unlearned, suspended, blocked and duplicate multi-type cards', async () => {
  const C = await corePromise, { words, cards } = fixture()
  cards[0].reps = 0
  cards[1].suspended = true
  cards.push({ ...cards[2], id: 300, card_type: 'cloze' })
  const pool = C.buildFocusPool(cards, words, (w) => w.id === 4)
  assert.equal(pool.length, 9)
  assert.equal(new Set(pool.map((x) => x.id)).size, pool.length)
  assert.ok(pool.every((x) => ![1, 2, 4].includes(Number(x.id))))
})

test('requires sufficient valid pool; plan and options remain stable for a given day', async () => {
  const C = await corePromise
  assert.equal(C.buildPlan([]), null)
  const { words, cards } = fixture(12)
  const pool = C.buildFocusPool(cards, words)
  assert.equal(C.buildPlan(pool.slice(0, 4)), null)
  const a = C.buildPlan(pool, '2026-10-26')
  assert.deepEqual(a, C.buildPlan(pool, '2026-10-26'))
  assert.ok(a.recall.length >= 2)
  assert.ok(a.choices.length >= 1)
  assert.equal(new Set(a.picked.map((x) => x.id)).size, a.picked.length)
})

test('one correct answer and distinct distractors; fixed option order', async () => {
  const C = await corePromise
  const { words, cards } = fixture()
  const pool = C.buildFocusPool(cards, words)
  const options = C.choiceOptions(pool[0], pool)
  assert.equal(options.length, 4)
  assert.equal(options.filter((x) => x.ok).length, 1)
  assert.equal(new Set(options.map((x) => C.normText(x.text))).size, 4)
  assert.deepEqual(options, C.choiceOptions(pool[0], pool))
})

test('identical or overlapping meanings must not be offered as distractors', async () => {
  const C = await corePromise
  const w = { id: '1', term: 'target', zh: '提供紧急帮助', meanings: ['提供紧急帮助'] }
  const pool = [w,
    { id: '2', term: 'term2', zh: '紧急帮助', meanings: ['紧急帮助'] },
    { id: '3', term: 'term3', zh: '提供紧急帮助', meanings: ['提供紧急帮助'] },
    { id: '4', term: 'term4', zh: '无关任务四', meanings: ['无关任务四'] },
    { id: '5', term: 'term5', zh: '无关任务五', meanings: ['无关任务五'] },
    { id: '6', term: 'term6', zh: '无关任务六', meanings: ['无关任务六'] }]
  const options = C.choiceOptions(w, pool)
  assert.ok(options)
  assert.ok(options.every((x) => x.ok || !x.text.includes('紧急帮助')))
})

test('offline information retention varies across dates and every answer is grounded', async () => {
  const C = await corePromise
  const passages = new Set()
  for (let i = 0; i < 45; i++) {
    const date = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10)
    const task = C.memoryTask(date)
    passages.add(task.passage)
    assert.match(task.passage, /[A-Za-z]/)
    assert.equal(task.questions.length, 3)
    for (const q of task.questions) {
      assert.ok(q.correct >= 0 && q.correct < q.options.length)
      assert.equal(new Set(q.options).size, q.options.length)
      assert.ok(task.passage.toLowerCase().includes(q.options[q.correct].toLowerCase()),
        'correct answer should appear in the source passage: ' + q.prompt)
    }
    assert.deepEqual(task, C.memoryTask(date))
  }
  assert.ok(passages.size >= 25, 'too few distinct daily scenarios: ' + passages.size)
})

test('session summary excludes ambiguous MCQ and preserves self-rated recall distinctions', async () => {
  const C = await corePromise
  const x = C.summarizeSession({
    date: '2026-10-26', at: 100,
    recallResults: ['independent', 'hinted', 'alternative', 'missed'],
    choiceResults: ['correct', 'wrong', 'ambiguous'],
    memoryTotal: 3, memoryCorrect: 2,
    scenarioCompleted: true, feedbackUsed: true,
  })
  assert.equal(x.recallTotal, 4)
  assert.equal(x.independent, 1)
  assert.equal(x.hinted, 1)
  assert.equal(x.alternative, 1)
  assert.equal(x.missed, 1)
  assert.equal(x.choiceTotal, 2)
  assert.equal(x.choiceCorrect, 1)
  assert.equal(x.ambiguous, 1)
  assert.equal(x.memoryTotal, 3)
  assert.equal(x.memoryCorrect, 2)
  assert.equal(x.scenarioCompleted, true)
})

test('history rejects malformed entries, retains only 60, calculates rates correctly', async () => {
  const C = await corePromise
  const items = Array.from({ length: 65 }, (_, i) => ({
    date: '2026-10-26', at: i + 1, recallTotal: 4, independent: 2,
    choiceTotal: 3, choiceCorrect: 2,
  }))
  const out = C.sanitizeHistory([null, { date: 'bad', at: 1 }, ...items])
  assert.equal(out.length, 60)
  assert.equal(out[0].at, 6)
  const h = C.recentStats(out, 7, 100)
  assert.equal(h.sessions, 60)
  assert.equal(h.independentRate, 0.5)
  assert.equal(h.choiceRate, 2 / 3)
})

test('integration guard: focus cannot call grade/review/daily write methods', () => {
  const app = fs.readFileSync(path.join(__dirname, '../lexiloop/js/focus.js'), 'utf8')
  const game = fs.readFileSync(path.join(__dirname, '../lexiloop/js/game.js'), 'utf8')
  const entry = fs.readFileSync(path.join(__dirname, '../lexiloop/js/app.js'), 'utf8')
  assert.doesNotMatch(app, /S\.(?:recordReview|applyGrade|creditGrades|creditWords|persistReview|queueReview|pushSettings|persistCard)\s*\(/)
  assert.match(game, /G\.mode === 'focus'/)
  assert.match(game, /FOCUS\.bindFocus/)
  assert.match(entry, /function onSignedOut\(\) \{\s*GAME\.exitMode\(\)/)
  assert.match(entry, /async function onLoggedIn\(session\) \{\s*GAME\.exitMode\(\)/)
  assert.match(game, /id="g-focus"/)
  assert.match(app, /lexiloop\.focus\.history\.v1/)
  assert.ok(app.includes("    " + '$'.repeat(2) + "('[data-focus-memory]').forEach"), 'memory answer buttons must use multi-element selector')
  assert.match(app, /if \(s\.hintSeen && value === 'independent'\) value = 'hinted'/)
})
