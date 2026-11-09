/** Content reports and a resumable, two-worker foreground queue. No credentials or DOM. */
import { assessContent, contentKey, REPORT_VERSION } from './content-quality.js?v=132'
export const REVIEW_VERSION = REPORT_VERSION
export const REVIEW_TIMEOUT_MS = 120000
export const REVIEW_CACHE_DAYS = 30

export async function contentFingerprint(word) {
  const text = JSON.stringify([word.normalized, word.lemma, word.payload || {}])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
}

export function parseReviewReport(note) {
  try {
    const r = JSON.parse(note)
    return r && r.kind === 'lexiloop-content-report' && r.version === REVIEW_VERSION &&
      typeof r.fingerprint === 'string' && Array.isArray(r.issues) && Array.isArray(r.suggestions) &&
      ['none', 'advisory', 'blocking'].includes(r.severity) && Number.isFinite(r.at) ? r : null
  } catch (_) { return null }
}

export function auditEntry(word) {
  const p = word.payload || {}, issues = []
  const senses = Array.isArray(p.senses) ? p.senses : []
  const colls = Array.isArray(p.collocations) ? p.collocations : []
  const examples = Array.isArray(p.source_examples) ? p.source_examples : []
  const usable = senses.some(s => s && (s.def_zh || s.def_en)) ||
    colls.some(c => c && c.pattern && (c.zh || (c.examples || []).some(e => e && e.en))) || examples.some(e => e && e.en)
  if (!usable) issues.push({ severity: 'blocking', field: 'content', message: '没有可学习的释义或例句，需要补充内容。' })
  const seen = new Set()
  colls.forEach((c, i) => {
    const pattern = String(c && c.pattern || '').trim().toLowerCase()
    if (!pattern) issues.push({ severity: 'advisory', field: 'collocations.' + i, message: '第 ' + (i + 1) + ' 条搭配缺少表达。' })
    else if (seen.has(pattern)) issues.push({ severity: 'advisory', field: 'collocations.' + i, message: '第 ' + (i + 1) + ' 条搭配重复。' })
    seen.add(pattern)
    if (!c || !(c.examples || []).some(e => e && e.en)) issues.push({ severity: 'advisory', field: 'collocations.' + i, message: '第 ' + (i + 1) + ' 条搭配缺少英文例句。' })
  })
  const quality = assessContent({ ...word, verify_note:'' })
  quality.issues.forEach(message => issues.push({ severity:quality.blocked ? 'blocking' : 'advisory', field:'reference', message }))
  return issues
}

export function makeReport(word, fingerprint, model, result, localIssues, now = Date.now()) {
  const issues = localIssues.map(x => x.message).concat(result.issues || [], (result.missing || []).map(x => '缺义项：' + x))
  const severity = localIssues.some(x => x.severity === 'blocking') || result.severity === 'blocking' ? 'blocking' :
    issues.length || result.severity === 'advisory' ? 'advisory' : 'none'
  return { kind: 'lexiloop-content-report', version: REVIEW_VERSION, fingerprint, model, at: now,
    severity, contentKey:contentKey(word),
    quarantinedCollocations: [...new Set((result.quarantinedCollocations || []).filter(i => Number.isInteger(i) && i >= 0 && i < (word.payload?.collocations || []).length))],
    issues: issues.slice(0, 30).map(x => String(x).slice(0, 500)),
    suggestions: (result.suggestions || []).slice(0, 20).map(x => String(x).slice(0, 500)),
    reason: String(result.reason || '').slice(0, 500), source: result.source || 'model',
    reference: '模型建议未经权威来源核实；修正前请核对词典或原始语料。' }
}

/** Dependencies are injected so CI exercises concurrency, failures and restoration offline. */
export function createReviewRunner(deps) {
  let job = null
  const notify = () => { job.persistenceError = deps.save(job) === false; if (deps.changed) deps.changed() }
  const doneIds = () => new Set(job.completed)
  const normalize = saved => {
    const j = { reviewed: 0, skipped: 0, cached: 0, protected: 0, removed: 0, rules: 0, failed: 0,
      blocking: 0, advisory: 0, previousDone: 0, elapsedMs: 0, requestsMs: 0, requestCount: 0,
      concurrency: 2, lastError: '', ...saved, running: false, pauseRequested: false, active: [], current: '' }
    j.completed = [...new Set(Array.isArray(saved.completed) ? saved.completed : saved.ids.slice(0, saved.cursor || 0))]
      .filter(id => j.ids.includes(id))
    j.total = j.ids.length
    j.done = j.completed.length
    j.cursor = j.ids.findIndex(id => !j.completed.includes(id))
    if (j.cursor < 0) j.cursor = j.ids.length
    if (!Array.isArray(saved.completed)) j.previousDone = saved.cursor || 0
    return j
  }
  const ensure = () => {
    const saved = deps.load()
    const owner = deps.owner()
    if (job && job.owner !== owner && !job.running) job = null
    if (!job && saved && saved.owner === owner && Array.isArray(saved.ids)) job = normalize(saved)
  }
  const status = () => { ensure(); if (job && job.owner !== deps.owner()) return null; return job && { ...job, ids: undefined, completed: undefined } }
  const pause = () => { if (job && job.running) { job.pauseRequested = true; notify() } }
  const timedReview = async entry => {
    const controller = new AbortController()
    let timer
    try {
      return await Promise.race([deps.review(entry, { model: job.model || undefined, signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('REVIEW_TIMEOUT')) }, REVIEW_TIMEOUT_MS) })])
    } finally { clearTimeout(timer) }
  }
  const start = async (scope, ids, model) => {
    ensure()
    if (job && job.running) { if (job.owner !== deps.owner()) throw Error('原账号的任务正在停止，请稍后重试。'); return }
    const owner = deps.owner()
    model = model || 'auto'
    if (!job || job.scope !== scope || job.done >= job.ids.length || job.model !== model || job.ruleVersion !== REVIEW_VERSION) {
      job = normalize({ owner, scope, ids: [...new Set(ids)], completed: [], model, ruleVersion:REVIEW_VERSION })
    }
    const j = job, completed = doneIds(), claimed = new Set()
    j.running = true; j.pauseRequested = false; j.lastError = ''
    const started = Date.now()
    notify()
    const process = async id => {
      const w = deps.word(id)
      if (!w) {
        if (deps.owns && !deps.owns(id)) { j.skipped++; j.removed++; return }
        throw Error('词条尚未加载，请同步后继续。')
      }
      if (w.verification_status === 'corrected') { j.skipped++; j.protected++; return }
      const fingerprint = await contentFingerprint(w)
      const existing = parseReviewReport(w.verify_note)
      if (existing && existing.fingerprint === fingerprint && existing.model === model &&
          Date.now() - existing.at >= 0 && Date.now() - existing.at < REVIEW_CACHE_DAYS * 86400000 &&
          w.verification_status === (existing.severity === 'blocking' ? 'flagged' : existing.severity === 'advisory' ? 'reviewed' : 'verified')) {
        j.skipped++; j.cached++;
        if (existing.severity === 'blocking') j.blocking++;
        if (existing.severity === 'advisory') j.advisory++;
        return
      }
      const local = auditEntry(w)
      let result
      if (local.some(x => x.severity === 'blocking')) {
        result = { ok: true, severity: 'blocking', source: 'rules' }
      } else {
        const begin = Date.now()
        try { result = await timedReview(w) }
        catch (e) {
          if (e.status === 429 || /429|rate.?limit|限流/i.test(String(e.message))) {
            j.concurrency = 1
            throw Error('模型限流，已降为单并发；请稍后继续。')
          }
          throw Error(e.message === 'REVIEW_TIMEOUT' ? '模型等待超过 2 分钟，请稍后继续。' : '模型请求失败，请检查网络或额度后继续。')
        }
        j.requestsMs += Date.now() - begin; j.requestCount++
        if (!result || !result.ok || !['none', 'advisory', 'blocking'].includes(result.severity)) throw Error('模型复核结果无法解析，请稍后继续。')
      }
      if (deps.owner() !== owner) throw Error('账号已切换，原账号的任务已停止。')
      const current = deps.word(id)
      if (!current || (deps.owns && !deps.owns(id))) {
        if (deps.owns && !deps.owns(id)) { j.skipped++; j.removed++; return }
        throw Error('词条尚未加载，请同步后继续。')
      }
      if (current.verification_status === 'corrected') { j.skipped++; j.protected++; return }
      if (await contentFingerprint(current) !== fingerprint) throw Error('词条内容已变化，请继续以复核新版本。')
      const report = makeReport(w, fingerprint, model, result, local)
      try { await deps.persist(current, report) }
      catch (_) { throw Error('复核报告保存失败或内容已变化，当前词条未计为完成；请同步后继续。') }
      if (report.source === 'rules') j.rules++; else j.reviewed++
      if (report.severity === 'blocking') j.blocking++
      if (report.severity === 'advisory') j.advisory++
    }
    const worker = async index => {
      while (!j.pauseRequested && !j.lastError && index < j.concurrency && deps.owner() === owner) {
        const id = j.ids.find(id => !completed.has(id) && !claimed.has(id))
        if (id === undefined) return
        claimed.add(id); j.active.push(id)
        j.current = j.active.map(id => { const w = deps.word(id); return w && (w.lemma || w.normalized) || String(id) }).join(' / ')
        notify()
        try {
          await process(id)
          completed.add(id); j.completed = [...completed]; j.done = completed.size
          j.cursor = j.ids.findIndex(id => !completed.has(id)); if (j.cursor < 0) j.cursor = j.ids.length
        } catch (e) { j.failed++; j.lastError = String(e.message || e) }
        finally { j.active = j.active.filter(x => x !== id); notify() }
      }
    }
    try { await Promise.all([worker(0), worker(1)]) }
    finally {
      if (deps.owner() !== owner && !j.lastError) j.lastError = '账号已切换，任务已停止。'
      j.elapsedMs += Date.now() - started; j.running = false; j.pauseRequested = false; j.active = []; j.current = ''
      notify()
    }
  }
  return { start, pause, status }
}
