/**
 * focus-core.js — 每日综合训练的纯逻辑模块。
 *
 * 隔离于 FSRS / reviews / daily：这里不导入 store，也不调用任何写入 API。
 * “认知挑战”仅指训练任务，不声称具有跨领域认知迁移效果。
 */
export const FOCUS_HISTORY_LIMIT = 60
export const FOCUS_MIN_POOL = 5

export function dayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0')
}

export function normText(value) {
  return String(value == null ? '' : value).toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？；：,.!?;:()（）\[\]【】'"“”‘’]/g, '')
    .trim()
}

function meanings(p) {
  return ((p && p.senses) || []).map((s) => String((s && s.def_zh) || '').trim())
    .filter(Boolean)
}

export function buildFocusPool(cards, words, isBlocked = () => false) {
  const byId = new Map((words || []).map((w) => [String(w.id), w]))
  const seen = new Set()
  const out = []
  for (const card of (cards || [])) {
    if (!card || card.suspended || Number(card.reps || 0) < 1) continue
    const w = byId.get(String(card.word_id))
    if (!w || isBlocked(w)) continue
    const term = String(w.lemma || w.normalized || '').trim()
    const defs = meanings(w.payload)
    const zh = defs[0]
    const key = normText(term)
    if (!key || !zh || seen.has(key)) continue
    seen.add(key)
    const last = Date.parse(card.last_review_at || '') || 0
    out.push({
      id: String(w.id), term, zh, meanings: defs, topic: String((w.payload || {}).topic || ''),
      last,
    })
  }
  // 优先从久未见的已学词抽取，保持稳定顺序；避免让新卡绕过正式排程。
  return out.sort((a, b) => a.last - b.last || a.term.localeCompare(b.term))
}

export function meaningOverlap(a, b) {
  const x = (a.meanings || [a.zh]).map(normText).filter(Boolean)
  const y = (b.meanings || [b.zh]).map(normText).filter(Boolean)
  return x.some((u) => y.some((v) => u === v || (u.length >= 4 && v.includes(u)) || (v.length >= 4 && u.includes(v))))
}

export function choiceOptions(target, pool) {
  const candidates = []
  const texts = new Set([normText(target.zh)])
  for (const w of pool) {
    if (w.id === target.id || normText(w.term) === normText(target.term) || meaningOverlap(target, w)) continue
    const key = normText(w.zh)
    if (!key || texts.has(key)) continue
    texts.add(key)
    candidates.push({ text: w.zh, ok: false })
  }
  if (candidates.length < 3) return null
  const options = [{ text: target.zh, ok: true }, ...candidates.slice(0, 3)]
  // Deterministic per target: stable across renders; no “correct option shifted” bug.
  const rotate = (hash(target.id + '|' + target.term) % options.length)
  return options.slice(rotate).concat(options.slice(0, rotate))
}

function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export function buildPlan(pool, onDate = dayKey()) {
  if (!Array.isArray(pool) || pool.length < FOCUS_MIN_POOL) return null
  // 老词优先；按天轮换起点，避免连续多天总抽到相同的头几张。
  const n = Math.min(8, pool.length)
  const offset = hash(String(onDate)) % pool.length
  const picked = pool.slice(offset).concat(pool.slice(0, offset)).slice(0, n)
  const recall = picked.slice(0, Math.min(4, Math.ceil(n / 2)))
  const choices = picked.slice(recall.length)
    .map((word) => ({ word, options: choiceOptions(word, pool) }))
    .filter((q) => q.options)
  return { recall, choices, topic: picked.find((w) => w.topic)?.topic || '', picked }
}

/** Deterministic, offline workplace information retention; not a clinical cognition score.
 * Date-specific combinations vary people, places, times and tasks to limit rote recall.
 * Each choice is unambiguous and its correct answer appears verbatim in the passage. */
export function memoryTask(date = dayKey()) {
  const stamp = String(date)
  const parsed = Date.parse(stamp + 'T00:00:00Z')
  const day = Number.isFinite(parsed) ? Math.floor(parsed / 86400000) : 0
  const times = ['9:40 AM', '11:25 AM', '3:10 PM', '6:15 PM', '8:35 PM']
  const locations = ['campus south gate', 'east gate', 'main reception desk', 'security office', 'campus visitor centre']
  const lostItems = ['a blue umbrella', 'a black backpack', 'a silver water bottle', 'a pair of glasses', 'a green notebook']
  const buildings = ['Administration Building', 'Science Building', 'Student Centre', 'Library', 'Sports Centre']
  const forgottenItems = ['student ID', 'access card', 'visitor badge', 'appointment confirmation', 'registration email']
  const pick = (pool, label) => pool[hash(stamp + '|' + label) % pool.length]
  const time = pick(times, 'time')
  const location = pick(locations, 'location')
  const choice = (correct, pool, label) => {
    const others = pool.filter((v) => v !== correct)
    const start = hash(stamp + '|' + label + '|distractors') % others.length
    const all = [correct, others[start], others[(start + 1) % others.length]]
    const rotation = hash(stamp + '|' + label + '|position') % all.length
    const options = all.slice(rotation).concat(all.slice(0, rotation))
    return { options, correct: options.indexOf(correct) }
  }
  const where = {
    prompt: 'Where is the caller?',
    ...choice(location, locations, 'where'),
  }
  const when = {
    prompt: 'When did the call happen?',
    ...choice(time, times, 'when'),
  }

  if ((day % 3 + 3) % 3 === 0) {
    const item = pick(lostItems, 'lost-item')
    return {
      passage: 'A student calls from the ' + location + ' at ' + time +
        '. She lost ' + item + ' and asks how to report it. The officer advises contacting the campus lost-and-found desk.',
      questions: [
        { prompt: 'What did the student lose?', ...choice(item, lostItems, 'lost-item') },
        where, when,
      ],
    }
  }
  if ((day % 3 + 3) % 3 === 1) {
    const building = pick(buildings, 'building')
    return {
      passage: 'A visitor calls from the ' + location + ' at ' + time +
        '. He has an appointment in the ' + building + ' and asks which entrance to use. The officer explains the visitor registration process.',
      questions: [
        where,
        { prompt: 'Which building does the visitor need?', ...choice(building, buildings, 'building') },
        when,
      ],
    }
  }
  const item = pick(forgottenItems, 'forgotten-item')
  return {
    passage: 'A student calls from the ' + location + ' at ' + time +
      '. She forgot her ' + item + ' and needs help accessing a restricted campus area. The officer directs her to the authorised access support desk.',
    questions: [
      { prompt: 'What did the student forget?', ...choice(item, forgottenItems, 'forgotten-item') },
      where, when,
    ],
  }
}

export function summarizeSession(session) {
  const recall = Array.isArray(session.recallResults) ? session.recallResults : []
  const choice = Array.isArray(session.choiceResults) ? session.choiceResults : []
  const count = (arr, label) => arr.filter((v) => v === label).length
  const answered = choice.filter((r) => r !== 'ambiguous')
  return {
    date: String(session.date || dayKey()), at: Number(session.at || Date.now()),
    recallTotal: recall.length,
    independent: count(recall, 'independent'),
    hinted: count(recall, 'hinted'),
    alternative: count(recall, 'alternative'),
    missed: count(recall, 'missed'),
    choiceTotal: answered.length,
    choiceCorrect: count(answered, 'correct'),
    ambiguous: count(choice, 'ambiguous'),
    memoryTotal: Math.max(0, Number(session.memoryTotal) || 0),
    memoryCorrect: Math.max(0, Number(session.memoryCorrect) || 0),
    scenarioCompleted: !!session.scenarioCompleted,
    feedbackUsed: !!session.feedbackUsed,
  }
}

export function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((x) => x && typeof x === 'object' &&
    typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) &&
    Number.isFinite(Number(x.at)))
    .slice(-FOCUS_HISTORY_LIMIT).map((x) => ({
      date: x.date, at: Number(x.at),
      recallTotal: Math.max(0, Number(x.recallTotal) || 0),
      independent: Math.max(0, Number(x.independent) || 0),
      hinted: Math.max(0, Number(x.hinted) || 0),
      alternative: Math.max(0, Number(x.alternative) || 0),
      missed: Math.max(0, Number(x.missed) || 0),
      choiceTotal: Math.max(0, Number(x.choiceTotal) || 0),
      choiceCorrect: Math.max(0, Number(x.choiceCorrect) || 0),
      ambiguous: Math.max(0, Number(x.ambiguous) || 0),
      memoryTotal: Math.max(0, Number(x.memoryTotal) || 0),
      memoryCorrect: Math.max(0, Number(x.memoryCorrect) || 0),
      scenarioCompleted: !!x.scenarioCompleted, feedbackUsed: !!x.feedbackUsed,
    }))
}

export function recentStats(history, days = 7, now = Date.now()) {
  const since = now - days * 86400000
  const rows = sanitizeHistory(history).filter((x) => x.at >= since && x.at <= now + 86400000)
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0)
  const recalls = total('recallTotal'), choices = total('choiceTotal')
  return {
    sessions: rows.length, recalls, choices,
    independent: total('independent'), hinted: total('hinted'),
    memoryTotal: total('memoryTotal'), memoryCorrect: total('memoryCorrect'),
    alternative: total('alternative'), missed: total('missed'),
    choiceCorrect: total('choiceCorrect'), ambiguous: total('ambiguous'),
    scenarios: rows.filter((x) => x.scenarioCompleted).length,
    independentRate: recalls ? total('independent') / recalls : null,
    choiceRate: choices ? total('choiceCorrect') / choices : null,
  }
}
