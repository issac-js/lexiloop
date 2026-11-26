const assert = require('node:assert/strict')
const test = require('node:test')

test('four bilingual topics have usable lines, complete reports, and valid expression references', async () => {
  const { workplaceTopics } = await import('../lexiloop/js/topic-content.js')
  assert.deepEqual(workplaceTopics.map(topic => topic.id), ['traffic', 'payment', 'drone', 'missing'])
  for (const topic of workplaceTopics) {
    assert.ok(topic.intake.length >= 2 && topic.handover.length >= 2)
    for (const [zh, en] of [...topic.intake, ...topic.handover]) {
      assert.match(zh, /\p{Script=Han}/u)
      assert.match(en, /[a-z][.?]$/i)
    }
    assert.equal(topic.report.length, topic.translation.length)
    assert.ok(topic.report.join(' ').split(/\s+/).length >= 75)
    const markers = [...topic.report.join(' ').matchAll(/\[\[([^\]]+)\]\]/g)]
    const keys = new Set(markers.map(([, marker]) => {
      const [text, key = text] = marker.split('|')
      assert.ok(text && Object.hasOwn(topic.expressions, key), topic.id + ': ' + marker)
      return key
    }))
    assert.deepEqual([...keys].sort(), Object.keys(topic.expressions).sort())
    for (const [term, meaning, note] of Object.values(topic.expressions)) {
      assert.ok(term && meaning && note)
    }
    assert.match(topic.exercise.cue, /\p{Script=Han}/u)
    assert.match(topic.exercise.answer, /[a-z]\.$/i)
  }
  const traffic = workplaceTopics[0]
  assert.equal(traffic.intake[0][1], 'Is anyone injured?')
  assert.ok(traffic.handover.some(([, en]) => en === 'Liability has not yet been determined.'))
})
