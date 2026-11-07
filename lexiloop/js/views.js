/**
 * views.js — 全部页面
 * 每个页面导出 render()（返回 HTML）与 bind()（挂载事件），由 app.js 调度。
 */
import * as S from './store.js?v=129'
import * as FSRS from './fsrs.js?v=129'
import { CARD_TYPES, ENRICH_CONCURRENCY, RECOMMENDED_SETTINGS } from './config.js?v=129'
import {
  esc, $, $$, toast, fail, ok, openModal, closeModal, confirmDialog,
  icon, LOGO_SVG, speak, fmtDateCN, relTime, STRENGTH_ZH, REGISTER_ZH,
  listEnVoices, getVoicePref, setVoicePref, getTheme, applyTheme,
} from './ui.js?v=129'
import * as AUTH from './cloud.js?v=129'
import * as ENRICH from './enrich.js?v=129'
import * as EXP from './exporter.js?v=129'
import { createReviewRunner, parseReviewReport, auditEntry, REVIEW_TIMEOUT_MS } from './content-review.js?v=129'
export { REVIEW_TIMEOUT_MS } from './content-review.js?v=129'
import { parseImport, skippedLines, DEFAULT_MAX_WORDS } from './importer.js?v=129'

import {
  judgeTyped, reviewSemantics, looksLikeEnglishPhrase, cachedVerdict, inflectionFeedback, articleDifference, reviewStatusText,
  HIT, ALT, WRONG, UNSURE,
} from './judge.js?v=129'

/* ═════════════════════════ 通用片段 ═════════════════════════ */

/**
 * 数据状态占位卡：把「正在加载 / 加载失败 / 真的没数据」三种情况分开说。
 *
 * 为什么必须是独立函数而不是各页各写：词条和卡片都是数组，渲染层只看
 * `length === 0` 的话，三种情况会说出同一句话 ——「词库还是空的，去导入词单」。
 * 冷启动那一瞬看到这句，用户的第一反应是**重新导入**，那才是真正会把数据搞乱的操作。
 * 判断依据只能是加载状态，不能是数组长度。
 * @param {{loadingText?:string, retryId?:string, extra?:string}} opts
 * @returns {string} 需要占位时返回 HTML；确认真的没数据时返回空串（交给调用方原空态）
 */
export function dataStateCard(opts) {
  const o = opts || {}
  const st = S.loadState()
  if (st.failed) {
    return '<div class="empty">' +
      '<div class="big">数据没能加载</div>' +
      '<p class="tiny">' + esc(st.error || '网络异常') + '</p>' +
      '<p class="tiny">你的词条和学习记录都在云端，<b>没有丢</b>。点重试即可。</p>' +
      '<div class="btn-group" style="justify-content:center;margin-top:16px;">' +
      '<button class="btn primary" id="' + (o.retryId || 'data-retry') + '">重试</button>' +
      (o.extra || '') +
      '</div></div>'
  }
  if (st.pending) {
    return '<div class="empty">' +
      '<div class="big">正在同步…</div>' +
      '<p class="tiny">' + esc(o.loadingText || '正在从云端取回你的词条、卡片与学习记录') + '</p>' +
      '</div>'
  }
  return ''
}

function metric(k, v, unit) {
  return '<div class="metric"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
    (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div></div>'
}

export function collocationBlock(c, opts) {
  const o = opts || {}
  const meta = [
    '<span class="chip">' + esc(c.type || '') + '</span>',
    '<span class="chip ' + (c.strength === 'strong' ? 'strong' : c.strength === 'weak' ? 'weak' : '') + '">' +
      esc(STRENGTH_ZH[c.strength] || c.strength || '') + '</span>',
    '<span class="chip">' + esc(REGISTER_ZH[c.register] || c.register || '') + '</span>',
  ].join('')
  // 例句可点读（标准美音），来源标注区分「AI 生成」与「你的文档」
  const examples = (c.examples || []).map((e) =>
    '<div class="ex say" data-say="' + esc(e.en) + '" title="点击朗读">' +
    esc(e.en) +
    (e.zh ? '<div class="zh">' + esc(e.zh) + '</div>' : '') +
    '</div>'
  ).join('')
  return (
    '<div class="coll">' +
    '<div class="p">' + esc(c.pattern) + '</div>' +
    '<div class="meta">' + meta + '</div>' +
    (c.zh ? '<div class="zh">' + esc(c.zh) + '</div>' : '') +
    examples +
    '</div>'
  )
}

/**
 * 是否还需要生成搭配。
 * 对比类（X vs. Y）和整句类本来就生成不出搭配，失败后会打上 enrich_attempted 标记，
 * 不再计入「待生成」—— 否则横幅会永远挂着一条永远完不成的提示。
 */
/**
 * 每日目标进度环：把"今天还剩多少"变成"今天完成了多少"。
 * 只显示完成度，不做打卡惩罚 —— 漏一天不该有负罪感（研究里也说这会让人放弃）。
 */
function goalCard() {
  const today = S.statsFor(S.todayKey())
  const doneNew = Number(today.new_words) || 0
  const dailyMax = S.dailyReviewLimit()
  const isRest = S.isRestDay()
  // 进度环与达标判断共用预算、休息日和积压规则。
  const gp = S.goalProgress()
  const goalNew = gp.plan.newGoal
  /* 复习一律按**卡片**算：doneCards 是今天复习过的不同卡，dueNow 是仍到期待做。
     分母取两者之和（受每日额度封顶），做完最后一张自然闭合 —— 不会出现
     "还差 43 张"却"待复习 0"这种补不齐的账。算术收在 goal-metrics.js，由单测锁住。 */
  const doneCards = gp.doneCards
  const dueNow = gp.dueNow
  const needTest = String(S.state.settings.goal_include_test) === 'true'
  const lastTest = Number(S.state.settings.last_test_at) || 0
  const testDays = lastTest ? Math.floor((Date.now() - lastTest) / 86400000) : null
  const testDone = !needTest || (testDays !== null && testDays < 7)

  /* 进度环显示当前任务（三项等权；休息日不纳入新学）。
     达标徽章另表示当天已取得的记录：后来有卡到期时保留记录，并明确解释差异。 */
  const gm = S.goalCompletion({
    doneCards: doneCards, dueNow: dueNow, doneNew: doneNew, newGoal: goalNew,
    needTest: needTest, testDone: testDone, isRest: isRest,
    pausedNew: S.newWordsPaused(), dailyMax: dailyMax,
  })
  const goalReviews = gm.goalReviews
  const pct = gm.pct

  // 新学一项在休息日改说"今日休息"，不参与百分比：分母 0 会算出 NaN/Infinity，
  // 也会让"还差 8"这种根本做不到的指标继续挂在脸上。
  const rows = [
    { label: '复习', done: doneCards, goal: goalReviews },
    isRest || S.newWordsPaused()
      ? { label: '新学', done: doneNew, goal: 0, rest: true, note: isRest ? '今日休息' : '先清理逾期复习' }
      : { label: '新学', done: doneNew, goal: goalNew },
  ]
  const R = 26, C = 2 * Math.PI * R
  const gs = S.goalStats(30)
  const quotaExhausted = S.dailyReviewAllowance() === 0

  const badge = gp.met
    ? '<span class="chip strong">今日已达标 ✓</span>'
    : '<span class="chip">今日还差 ' +
      (!gp.reviewMet ? dueNow + ' 张复习'
        : (!gp.newMet && !isRest) ? (gp.plan.newGoal - gp.doneNew) + ' 个新词'
          : '一次抽测') + '</span>'
  const goalNote = gp.met && dueNow > 0
    ? '今日已达标，当前仍有 ' + dueNow + ' 张到期卡片。' +
      (quotaExhausted ? '今日作答额度已用完，明天继续。' : '可按今日剩余额度继续复习。') +
      '已取得的达标记录会保留，当前任务进度随到期卡片更新。'
    : gp.recorded && !gp.currentMet
      ? '今日达标记录已保留；当前任务进度随新学目标和抽测有效期更新。'
      : ''

  return '<div class="card tight">' +
    '<div class="row" style="gap:14px;align-items:center;">' +
    '<svg width="66" height="66" viewBox="0 0 66 66" role="img" aria-label="当前任务完成度 ' + pct + '%">' +
    '<circle cx="33" cy="33" r="' + R + '" fill="none" stroke="var(--line)" stroke-width="7"/>' +
    '<circle cx="33" cy="33" r="' + R + '" fill="none" stroke="var(--brand)" stroke-width="7" ' +
    'stroke-linecap="round" stroke-dasharray="' + C.toFixed(1) + '" ' +
    'stroke-dashoffset="' + (C * (1 - pct / 100)).toFixed(1) + '" transform="rotate(-90 33 33)"/>' +
    '<text x="33" y="37" text-anchor="middle" font-size="14" font-weight="600" fill="var(--ink)">' + pct + '%</text>' +
    '</svg>' +
    '<div class="grow">' +
    rows.map((r) => '<div class="row between" style="margin-bottom:5px;">' +
      '<span class="tiny">' + r.label + ' ' +
      (r.rest ? '（' + r.note + '）' : r.done + ' / ' + r.goal) + '</span>' +
      '<span class="tiny" style="color:' + ((r.rest || r.done >= r.goal) ? 'var(--ok)' : 'var(--ink-3)') + ';">' +
      (r.rest ? r.note : (r.done >= r.goal ? '达成' : '还差 ' + (r.goal - r.done))) + '</span></div>').join('') +
    // 抽测单列一行：它是达标条件之一，不能藏在"还差一次抽测"六个字里 ——
    // 用户不知道它什么时候做、做了多久有效
    (needTest
      ? '<div class="row between" style="margin-bottom:5px;">' +
        '<span class="tiny">抽测</span>' +
        '<span class="tiny" style="color:' + (testDone ? 'var(--ok)' : 'var(--ink-3)') + ';">' +
        (testDone
          ? (testDays === null ? '已做' : testDays === 0 ? '今天做过了（7 天内有效）' : testDays + ' 天前做过（7 天内有效）')
          : '还没做 —— 7 天内做一次就算达标') +
        '</span></div>'
      : '') +
    // 口径写出来：环是三项平均，不是记忆强度 —— 否则 87% 容易被读成"记住了 87%"
    '<p class="tiny" style="margin:8px 0 0;">当前任务完成度 = 复习 / 新学 / 抽测 三项平均' +
    (needTest ? '' : '（未启用抽测要求）') + '，不等于记忆保持率</p>' +
    '<div class="row between" style="margin-top:6px;align-items:center;">' + badge +
    '<span class="tiny" title="达标连胜：三项全部达成的连续天数（和上面的连续学习天数不是一回事）">' +
    '达标连胜 ' + gs.streak + ' 天　｜　近 30 天达标 ' + gs.hit + '/' + gs.span +
    '（' + gs.rate + '%）</span></div>' +
    '</div></div>' +
    (goalNote ? '<p class="tiny" id="goal-status-note" style="margin:10px 0 0;">' + goalNote + '</p>' : '') +
    // 休息日只说清楚规则，不制造焦虑：今天本来就该少做
    (isRest
      ? '<p class="tiny" style="margin:10px 0 0;">今天是休息日：只复习、不引新词，' +
        '正好把这一周的抽测做掉。</p>'
      : '') +
    (!testDone && needTest
      ? '<button class="btn soft block" id="go-weekly-test" style="margin-top:10px;">去做一次每周抽测</button>'
      : '') +
    '</div>'
}

/** 评分分布条（会话小结用） */
function summaryBar(g) {
  const total = (g[1] || 0) + (g[2] || 0) + (g[3] || 0) + (g[4] || 0) || 1
  const parts = [
    { k: 1, c: 'var(--bad)', l: '忘了' },
    { k: 2, c: 'var(--warn)', l: '吃力' },
    { k: 3, c: 'var(--ok)', l: '记得' },
    { k: 4, c: 'var(--brand)', l: '很简单' },
  ]
  return '<div class="mg-bar" style="display:flex;">' + parts.map((p) =>
    '<i style="width:' + Math.round(((g[p.k] || 0) / total) * 100) + '%;background:' + p.c +
    ';" title="' + p.l + ' ' + (g[p.k] || 0) + '"></i>').join('') + '</div>' +
    '<div class="legend" style="margin:6px 0 0;">' + parts.map((p) =>
    '<span class="lg"><i style="background:' + p.c + ';"></i>' + p.l + ' ' + (g[p.k] || 0) + '</span>').join('') + '</div>'
}

function needsEnrich(w) {
  if (!w) return false
  if (w.payload && w.payload.enrich_attempted) return false
  return !(w.payload && w.payload.collocations && w.payload.collocations.length)
}

function wordAnswerHTML(word) {
  const p = word.payload || {}
  const senses = (p.senses || []).map((s) =>
    '<li>' + (s.pos ? '<span class="tiny">' + esc(s.pos) + '.</span> ' : '') + esc(s.def_zh || s.def_en) + '</li>'
  ).join('')
  const colls = (p.collocations || []).map((c) => collocationBlock(c)).join('')

  // 文档自带的例句：AI 还没补搭配时，这就是最实在的学习材料，别浪费
  const src = (p.source_examples || []).filter((e) => e && e.en)
  const srcBlock = src.length
    ? '<h3 class="sec">' + (colls ? '来自你的文档的例句' : '例句（来自你的文档）') + '</h3>' +
      src.slice(0, 3).map((e) =>
        '<div class="src-ex">' +
        '<div class="en say" data-say="' + esc(e.en) + '" title="点击朗读">' + esc(e.en) + '</div>' +
        (e.zh ? '<div class="zh">' + esc(e.zh) + '</div>' : '') +
        '<div class="tiny" style="color:var(--ink-3);">来源：你导入的文档</div>' +
        '</div>'
      ).join('')
    : ''

  // AI 还没生成时，给一句明确的提示，而不是让卡片看起来是空的
  const pending = !colls && !src.length
    ? '<div class="tiny" style="margin-top:10px;color:var(--ink-3);">' +
      '这个词还没有搭配释义，去词库点「补充释义」即可生成。</div>'
    : ''

  const conf = (p.confusables || []).length
    ? '<h3 class="sec">易混词</h3>' + p.confusables.map((c) =>
        '<div style="font-size:13px;margin-bottom:4px;"><b>' + esc(c.word) + '</b>：' + esc(c.note) + '</div>'
      ).join('')
    : ''
  const fam = (p.word_family || []).length
    ? '<div class="tiny" style="margin-top:10px;">同族词：' + esc(p.word_family.join(' · ')) + '</div>'
    : ''
  const mne = p.mnemonic
    ? '<div class="tiny" style="margin-top:8px;">助记：' + esc(p.mnemonic) + '</div>'
    : ''
  // "置信度"是**模型自己报的把握**，不是校准过的准确率 ——
  // 直接写"置信度 95%"会被读成"95% 的内容是对的"，那是两回事。
  const lowConf = p.confidence != null && p.confidence < 0.7
    ? '<div class="tiny" style="margin-top:10px;color:var(--warn);">' +
      'AI 对部分搭配的自评把握偏低，建议对照词典核实一下</div>'
    : ''

  return (
    (senses ? '<ul class="senses">' + senses + '</ul>' : '') +
    colls + srcBlock + pending + conf + fam + mne + lowConf
  )
}

/** 从词条里挑一个可挖空的例句。
 *  关键点：AI 例句常用变形（搭配是 approve of，句子里写 approved / approving），
 *  后缀硬拼会漏掉 drop-e 形式（approv+ing），所以用**词干**匹配：
 *  approve / approved / approving / approves 都归到词干 approv。
 *  且空缺处的答案取句子里真实的那串字，否则用户填对了反而被判错。 */
function stemEn(w) {
  return String(w).toLowerCase()
    .replace(/(ies|ied)$/, 'y')
    .replace(/(ing|ed|es|s)$/, '')
    .replace(/e$/, '')          // approve→approv：否则 approv+ing（丢了 e）匹配不上
}

function clozeOf(word) {
  const colls = (word.payload && word.payload.collocations) || []
  const term = String(word.lemma || word.normalized || '').trim()

  const buildRe = (tokens) => {
    const stems = tokens.map(stemEn).filter(Boolean)
    if (!stems.length) return null
    return new RegExp('\\b' + stems.map((st) => st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*').join('\\s+') + '\\b', 'i')
  }
  const shoot = (en, re) => {
    const m = String(en).match(re)
    if (!m) return null
    return { sentence: String(en).replace(re, '________'), answer: m[0] }
  }

  for (const c of colls) {
    const ex = (c.examples || [])[0]
    if (!ex || !ex.en) continue
    const core = String(c.pattern || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()

    /* ① 先挖「目标词本身」：答案是这个词条，学什么就填什么，判分口径唯一。
       为什么把它放在整条搭配之前 —— 旧顺序先用整条 pattern 挖空，答案可达 2–6 词
       （"overflowed with water"、"could be handled with discretion"），
       用户只填核心词就被判错。实测（2862 次复习）：3 词以上词条错误率 7.8%，
       是 1–2 词档（4.3%）的近两倍，而 phrase 类词条（in the order they were
       received）本来就该填整条，不受此改动影响。 */
    if (term) {
      const re = buildRe(term.split(' '))
      const hit = re ? shoot(ex.en, re) : null
      if (hit) return { sentence: hit.sentence, zh: ex.zh, answer: hit.answer, raw: String(ex.en) }
    }
    /* ② 这个词条没有原样出现在这句里（例句只用到了搭配的一部分），
       才退化为挖整条搭配 —— 保证仍能出题，不至于变成「无题可出」。 */
    if (core) {
      const re2 = buildRe(core.split(' '))
      const hit2 = re2 ? shoot(ex.en, re2) : null
      if (hit2) return { sentence: hit2.sentence, zh: ex.zh, answer: hit2.answer, raw: String(ex.en) }
    }
  }
  return null
}

/** 例句里实在挖不出空时，退化成"看中文说搭配"，也比干看一个单词强。
 *  注意：有的搭配本身没有中文（zh 在例句上），要往下找一层。 */
function clozeFallback(word) {
  const colls = (word.payload && word.payload.collocations) || []
  const c = colls.find((x) => {
    if (!x || !x.pattern) return false
    if (x.zh) return true
    return (x.examples || []).some((e) => e && e.zh)
  })
  if (!c) return null
  const prompt = c.zh || ((c.examples || []).find((e) => e && e.zh) || {}).zh || ''
  if (!prompt) return null
  return {
    ask: '根据中文，把英文搭配打出来',
    prompt: prompt,
    expected: String(c.pattern).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(),
  }
}

/* ═════════════════════════ 后台生成任务 ═════════════════════════
   云端模型生成一个词条需要几十秒到几分钟，绝不能让界面干等。
   导入只负责建卡（秒级完成），搭配生成作为可暂停、可跨页、可续跑的后台任务。 */

const JOB_KEY = 'lexiloop.enrichjob.v1'

const job = {
  terms: [],      // 待生成搭配的词条（normalized）
  cursor: 0,
  ok: 0,
  failed: [],
  running: false,
  lastError: '',
}

function saveJob() {
  try {
    if (!job.terms.length) {
      localStorage.removeItem(JOB_KEY)
      return
    }
    localStorage.setItem(JOB_KEY, JSON.stringify({
      terms: job.terms.slice(job.cursor),
      ok: job.ok,
      failed: job.failed,
      lastError: job.lastError,
    }))
  } catch (e) {
    /* 配额满时忽略，任务仍会在本次会话内完成 */
  }
}

export function loadJob() {
  try {
    const raw = localStorage.getItem(JOB_KEY)
    if (!raw) return
    const saved = JSON.parse(raw)
    if (saved && Array.isArray(saved.terms) && saved.terms.length) {
      job.terms = saved.terms
      job.cursor = 0
      job.ok = saved.ok || 0
      job.failed = Array.isArray(saved.failed) ? saved.failed : []
      job.lastError = saved.lastError || ''
    }
  } catch (e) {
    /* 损坏的任务直接丢弃 */
  }
}

/** 清理任务队列：只保留"确实还缺搭配"的词。
 *  不清理的话，已经生成成功或已被标记放弃的词会一直留在队列里，
 *  横幅就会一直显示"上一批有 N 个没生成成功"，与实际状态自相矛盾。 */
function pruneJob() {
  if (!S.state.words.length) return false   // 数据还没加载完，先不动队列
  const alive = (t) => {
    const w = S.state.words.find((x) => x.normalized === t)
    return !!w && needsEnrich(w)
  }
  const before = job.terms.length + job.failed.length
  job.terms = job.terms.filter(alive)
  job.failed = job.failed.filter(alive)
  if (job.cursor > job.terms.length) job.cursor = job.terms.length
  const changed = before !== job.terms.length + job.failed.length
  if (changed) {
    if (!job.terms.length && !job.running) {
      job.ok = 0
      job.lastError = ''
      job.failed = []
    }
    saveJob()
  }
  return changed
}

export function jobRemaining() {
  return Math.max(0, job.terms.length - job.cursor)
}

export function jobIsRunning() {
  return job.running
}

export function queueGeneration(terms) {
  const set = new Set(job.terms.slice(job.cursor))
  terms.forEach((t) => {
    if (!set.has(t)) {
      job.terms.push(t)
      set.add(t)
    }
  })
  saveJob()
}

/* ───────────────────── 内容复核任务 ─────────────────────
   与导入任务**分开**：它只改"核验标记"，不碰内容，两者同时跑不会互相干扰。
   为什么必须有这个功能（而不是只靠规则）：2026-10-10 实测证明"词性标注错误"
   这类问题"以词条开头"等规则判据的召回率是 0，只有模型能看出来；
   而这类错误会把词性认知教错，属于必须挡住的 blocking 级。 */

const REVIEW_KEY = 'lexiloop.reviewJob'
const reviewOwner = () => String(S.state.user && S.state.user.id || S.state.accountEmail || 'offline')
const reviewKey = owner => REVIEW_KEY + '.' + encodeURIComponent(owner)
let reviewChanged = null
const reviewer = createReviewRunner({
  owner: reviewOwner,
  word: id => S.state.words.find(w => w.id === id),
  owns: id => S.state.cards.some(c => c.word_id === id),
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(reviewKey(reviewOwner())) || 'null')
      if (saved) return saved
      const legacy = JSON.parse(localStorage.getItem(REVIEW_KEY) || 'null')
      const own = new Set(S.state.cards.map(c => c.word_id))
      if (legacy && !legacy.owner && Array.isArray(legacy.ids) && legacy.ids.every(id => own.has(id))) {
        const migrated = { ...legacy, owner: reviewOwner(), model: 'auto' }
        localStorage.setItem(reviewKey(reviewOwner()), JSON.stringify(migrated))
        localStorage.removeItem(REVIEW_KEY)
        return migrated
      }
    } catch (_) { /* corrupt checkpoints never establish successful reviews */ }
    return null
  },
  save(job) {
    if (!job) return
    try { localStorage.setItem(reviewKey(job.owner), JSON.stringify({ ...job, running: false, active: [], current: '' })) }
    catch (_) { return false }
  },
  changed() { if (reviewChanged) reviewChanged('review') },
  review(word, opts) {
    const p = word.payload || {}
    return ENRICH.reviewTerm({ term: word.lemma || word.normalized, senses: p.senses || [],
      collocations: p.collocations || [], source_examples: p.source_examples || [] }, opts)
  },
  persist: (word, report) => S.putReviewReport(word, report),
})

export function reviewStatus() { return reviewer.status() }
export function pauseReview(onChanged) { reviewChanged = onChanged || reviewChanged; reviewer.pause() }
export async function startReview(scope, onChanged) {
  if (!['all', 'learned'].includes(scope)) throw Error('未知复核范围')
  if (S.dataPending() || S.dataFailed()) throw Error('请先完成词库同步，再复核。')
  reviewChanged = onChanged || reviewChanged
  if (reviewer.status() && reviewer.status().running) return
  const ids = S.state.cards.filter(c => scope === 'all' || Number(c.reps) > 0).map(c => c.word_id).filter(Boolean)
  const start = () => reviewer.start(scope, ids, S.state.settings.llm_model || 'auto')
  // Web Locks prevent two tabs of this origin/account from running the same queue.
  if (typeof window !== 'undefined' && window.navigator && window.navigator.locks) {
    return window.navigator.locks.request('lexiloop-review:' + reviewOwner(), { ifAvailable: true }, lock => {
      if (!lock) throw Error('这个账号已在另一标签页复核，请在那里查看或暂停。')
      return start()
    })
  }
  return start()
}

export function pauseJob(onChanged) {
  job.running = false
  saveJob()
  if (onChanged) onChanged('banner')
}

export function startJob(onChanged) {
  if (job.running) return
  if (!jobRemaining()) {
    job.terms = []
    job.cursor = 0
    return
  }
  job.running = true
  const startedAt = Date.now()
  if (onChanged) onChanged('banner')

  const worker = async () => {
    for (;;) {
      if (!job.running) return
      const idx = job.cursor
      job.cursor = idx + 1
      const term = job.terms[idx]
      if (!term) return
      try {
        const res = await ENRICH.enrichTerm(term, { model: S.state.settings.llm_model || undefined })
        // 合并而非覆盖：AI 结果里没有 topic / source_examples，整体替换会把章节和原文例句抹掉
        const prevW = S.state.words.find((x) => x.normalized === term)
        const merged = Object.assign({}, (prevW && prevW.payload) || {}, res.data)
        await S.putWord(term, res.data.lemma || term, merged)
        job.ok++
      } catch (e) {
        job.failed.push(term)
        job.lastError = (e && e.message) || '生成失败'
      }
      saveJob()
      // 只刷新顶部进度条，避免打断用户当前正在做的事
      if (onChanged) onChanged('banner')
    }
  }

  const n = Math.min(ENRICH_CONCURRENCY, jobRemaining())
  Promise.all(Array.from({ length: n }, () => worker())).then(() => {
    const wasRunning = job.running
    job.running = false
    const okCount = job.ok
    const failed = job.failed.slice()

    if (wasRunning && !jobRemaining()) {
      if (failed.length) {
        // 失败的留在队列里，横幅上给一键重试；不自动重试，免得在死路上无限打转
        job.terms = failed
        job.cursor = 0
        job.ok = 0
        job.failed = []
      } else {
        job.terms = []
        job.cursor = 0
        job.ok = 0
        job.failed = []
        job.lastError = ''
      }
    }
    saveJob()
    if (onChanged) onChanged(true)
    if (wasRunning) {
      const mins = Math.round((Date.now() - startedAt) / 60000)
      if (failed.length) {
        toast('成功 ' + okCount + ' 个，失败 ' + failed.length + ' 个' +
          (job.lastError ? '：' + job.lastError : ''), 'err')
      } else {
        ok('搭配生成完成：成功 ' + okCount + ' 个' + (mins >= 1 ? '（用时约 ' + mins + ' 分钟）' : ''))
      }
    }
  })
}

/** 放弃当前队列（失败的词条不再重试） */
export async function dismissJob(onChanged) {
  const giveUp = job.failed.slice().concat(job.terms.slice(job.cursor))
  job.running = false
  job.terms = []
  job.cursor = 0
  job.ok = 0
  job.failed = []
  job.lastError = ''
  saveJob()
  // 打标记：这些词不再计入"待补充搭配"，也不会被再次自动排队
  // （needsEnrich 会跳过带该标记的词；想单独重试可在词条页点「重新生成」）
  for (const term of giveUp) {
    const w = S.state.words.find((x) => x.normalized === term)
    if (!w || (w.payload && w.payload.enrich_attempted)) continue
    try {
      const merged = Object.assign({}, w.payload || {}, { enrich_attempted: true })
      await S.putWord(w.normalized, w.lemma, merged)
    } catch (e) { /* 标记失败不影响放弃动作 */ }
  }
  if (onChanged) onChanged(true)
}

/** 顶部进度条：任何页面都会显示，用户可随时离开或暂停 */
export function jobBannerHTML() {
  pruneJob()
  const remain = jobRemaining()
  if (!remain && !job.running) return ''
  const pendingAll = S.state.words.filter(needsEnrich).length
  const doneN = job.cursor
  const pct = job.terms.length ? Math.round((doneN / job.terms.length) * 100) : 0
  const isRetry = !job.running && job.failed.length === 0 && job.lastError

  return (
    '<div class="card tight" id="job-banner" style="background:var(--brand-soft);border-color:transparent;">' +
    '<div class="row between" style="gap:10px;">' +
    '<div class="grow">' +
    '<div style="font-size:14px;font-weight:500;">' +
    (job.running ? '正在生成搭配…' : (isRetry ? '上一批有 ' + remain + ' 个没生成成功' : '有 ' + remain + ' 个词条待生成搭配')) +
    '</div>' +
    '<div class="tiny">本批成功 ' + job.ok + ' 个' + (job.failed.length ? '　失败 ' + job.failed.length + ' 个' : '') +
    '　可离开本页，任务会继续</div>' +
    '<div class="tiny" style="margin-top:2px;">全库共 ' + pendingAll + ' 个词条待生成搭配</div>' +
    (job.lastError
      ? '<div class="tiny" style="color:var(--warn);margin-top:2px;word-break:break-all;">最近一次失败原因：' +
        esc(String(job.lastError).slice(0, 120)) + '</div>'
      : '') +
    // 失败的是哪些词，直接列出来 —— 多半是「整句 / 对比类」本身就不该按搭配背
    (job.failed.length
      ? '<div class="tiny" style="margin-top:4px;">没成功的词：' +
        job.failed.slice(0, 12).map(esc).join('、') +
        (job.failed.length > 12 ? ' 等 ' + job.failed.length + ' 个' : '') + '</div>'
      : '') +
    '</div>' +
    (job.running
      ? '<button class="btn sm" id="job-pause">暂停</button>'
      : '<button class="btn sm primary" id="job-start">' + (isRetry ? '重试' : '继续生成') + '</button>') +
    '</div>' +
    '<div class="progress" style="margin-top:8px;"><i style="width:' + pct + '%"></i></div>' +
    '<div class="row" style="justify-content:flex-end;margin-top:6px;">' +
    '<button class="btn sm ghost" id="job-dismiss">放弃这些</button>' +
    '</div>' +
    '</div>'
  )
}

export function bindJobBanner(onChanged) {
  const pause = $('#job-pause')
  if (pause) pause.onclick = () => pauseJob(onChanged)
  const start = $('#job-start')
  if (start) start.onclick = () => startJob(onChanged)
  const dis = $('#job-dismiss')
  if (dis) {
    dis.onclick = async () => {
      if (!(await confirmDialog({
        title: '放弃这 ' + jobRemaining() + ' 个词条的搭配生成？',
        sub: '它们仍留在词库里，只是不再自动排队生成；想单独重试，可在词条页点「重新生成」',
        okText: '放弃', danger: true,
      }))) return
      dismissJob(onChanged)
    }
  }
}

/** 只重绘顶部进度条，不触碰页面其余部分 */
export function refreshJobBanner(onChanged) {
  const wrap = $('#job-banner-wrap')
  if (!wrap) return
  wrap.innerHTML = jobBannerHTML()
  bindJobBanner(onChanged)
}

/* ═════════════════════════ 登录 ═════════════════════════ */

export function renderAuth() {
  return (
    '<div class="auth">' +
    '<div class="logo">' + LOGO_SVG + '</div>' +
    '<h1>英语搭配记忆</h1>' +
    '<p class="tagline">AI 生成地道固定搭配与例句<br>按记忆规律安排复习 · 手机与电脑进度同步</p>' +
    '<div class="seg" style="width:100%;display:flex;margin-bottom:16px;">' +
    '<button data-mode="otp" class="on" style="flex:1;">验证码登录</button>' +
    '<button data-mode="pwd" style="flex:1;">密码登录</button>' +
    '</div>' +

    '<form id="otp-form">' +
    '<div class="field"><label>邮箱</label>' +
    '<div class="input-group">' +
    '<input class="input" type="email" id="otp-email" placeholder="you@example.com" autocomplete="email" required>' +
    '<button class="btn" type="button" id="otp-send">获取验证码</button>' +
    '</div></div>' +
    '<div class="field"><label>验证码</label>' +
    '<input class="input" type="text" id="otp-token" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位数字"></div>' +
    '<div class="field hidden" id="otp-pwd-field"><label>设置密码（新账号必填，用于以后免验证码登录）</label>' +
    '<input class="input" type="password" id="otp-pwd" autocomplete="new-password" placeholder="至少 6 位"></div>' +
    '<button class="btn primary block lg" type="submit" id="otp-submit">登录 / 注册</button>' +
    '</form>' +

    '<form id="pwd-form" class="hidden">' +
    '<div class="field"><label>邮箱</label>' +
    '<input class="input" type="email" id="pwd-email" placeholder="you@example.com" autocomplete="email" required></div>' +
    '<div class="field"><label>密码</label>' +
    '<input class="input" type="password" id="pwd-password" autocomplete="current-password" required></div>' +
    '<button class="btn primary block lg" type="submit">登录</button>' +
    '<div class="center" style="margin-top:12px;"><a href="#" id="forgot" class="tiny">忘记密码</a></div>' +
    '</form>' +

    '<p class="note">本应用是网页版，仅支持邮箱登录。登录后学习进度会保存在云端，' +
    '在手机和电脑上用同一邮箱登录即可同步。<br>首次使用请用「验证码登录」，输入邮箱获取验证码后设定密码。</p>' +
    '</div>'
  )
}

export function bindAuth(onLoggedIn) {
  let mode = 'otp'

  $$('[data-mode]').forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.mode
      $$('[data-mode]').forEach((x) => x.classList.toggle('on', x === b))
      $('#otp-form').classList.toggle('hidden', mode !== 'otp')
      $('#pwd-form').classList.toggle('hidden', mode !== 'pwd')
    }
  })

  // 「获取验证码」——只发码，不校验
  $('#otp-send').onclick = async () => {
    const email = $('#otp-email').value.trim()
    if (!email || email.indexOf('@') < 0) return fail('请填写正确的邮箱地址')
    const btn = $('#otp-send')
    btn.disabled = true
    try {
      await AUTH.sendEmailCode(email)
      ok('验证码已发送，请查收邮件')
      let left = 60
      const timer = setInterval(() => {
        left--
        btn.textContent = left + ' 秒后重发'
        if (left <= 0) {
          clearInterval(timer)
          btn.disabled = false
          btn.textContent = '获取验证码'
        }
      }, 1000)
      // 新账号才显示密码框（不向用户透露该邮箱是否已注册）
      $('#otp-pwd-field').classList.toggle('hidden', !AUTH.pendingNeedsPassword())
    } catch (e) {
      btn.disabled = false
      fail(AUTH.authErrorMessage(e))
    }
  }

  // 「登录 / 注册」——只用已保存的 challenge 校验，绝不再发码
  $('#otp-form').onsubmit = async (ev) => {
    ev.preventDefault()
    const email = $('#otp-email').value.trim()
    const token = $('#otp-token').value.trim()
    const pwd = $('#otp-pwd').value
    if (!token) return fail('请输入验证码')
    if (!AUTH.hasPendingOtp(email)) return fail('请先为当前邮箱获取验证码')
    const btn = $('#otp-submit')
    btn.disabled = true
    try {
      const session = await AUTH.submitEmailOtp(email, token, pwd)
      ok('已登录')
      onLoggedIn(session)
    } catch (e) {
      fail(AUTH.authErrorMessage(e))
      btn.disabled = false
    }
  }

  $('#pwd-form').onsubmit = async (ev) => {
    ev.preventDefault()
    const email = $('#pwd-email').value.trim()
    const password = $('#pwd-password').value
    const btn = ev.target.querySelector('button[type="submit"]')
    btn.disabled = true
    try {
      const session = await AUTH.signInWithPassword(email, password)
      ok('已登录')
      onLoggedIn(session)
    } catch (e) {
      // 只说"账号或密码不正确"会把"这个邮箱在本应用还没注册"的情况也盖住，
      // 让人以为是密码记错了，反复重试。分两种说法：密码错 vs 账号不存在。
      const code = String((e && e.code) || (e && e.error && e.error.code) || '')
      const msg = String((e && e.message) || '')
      const looksMissing = /user_not_found|user_not_exist|not_found/i.test(code + ' ' + msg)
      fail(looksMissing
        ? '这个邮箱还没有账号　——　请切到「验证码登录」，用邮箱收码登录并设置密码'
        : '账号或密码不正确。若你还没在这个应用注册过，请先切到「验证码登录」')
      btn.disabled = false
    }
  }

  $('#forgot').onclick = (ev) => {
    ev.preventDefault()
    openModal(
      '<h3>重置密码</h3><p class="sub">验证码会发送到你的邮箱</p>' +
      '<div class="field"><label>邮箱</label><input class="input" id="rs-email" type="email" placeholder="you@example.com"></div>' +
      '<div class="field"><label>验证码</label><input class="input" id="rs-code" inputmode="numeric"></div>' +
      '<div class="field"><label>新密码</label><input class="input" id="rs-pwd" type="password" autocomplete="new-password"></div>' +
      '<div class="modal-actions"><button class="btn" id="rs-cancel">取消</button>' +
      '<button class="btn" id="rs-send">发送验证码</button>' +
      '<button class="btn primary" id="rs-do">重置并登录</button></div>'
    )
    let challenge = null
    $('#rs-cancel').onclick = closeModal
    $('#rs-send').onclick = async () => {
      const email = $('#rs-email').value.trim()
      if (!email) return fail('请填写邮箱')
      try {
        challenge = await AUTH.resetPasswordForEmail(email)
        ok('验证码已发送')
      } catch (e) {
        fail(AUTH.authErrorMessage(e))
      }
    }
    $('#rs-do').onclick = async () => {
      if (!challenge) return fail('请先发送验证码')
      const code = $('#rs-code').value.trim()
      const pwd = $('#rs-pwd').value
      if (!code || pwd.length < 6) return fail('请填写验证码和至少 6 位的新密码')
      try {
        const r = await challenge.data.updateUser({ nonce: code, password: pwd })
        if (r.error) throw r.error
        importedFromFile = null
      closeModal()
        ok('密码已重置')
        onLoggedIn(await AUTH.getSession())
      } catch (e) {
        fail(AUTH.authErrorMessage(e))
      }
    }
  }
}

/* ═════════════════════════ 今日 ═════════════════════════ */

function computeStreak() {
  const set = new Set(S.state.daily.filter((d) => Number(d.total) > 0).map((d) => String(d.reviewed_on).slice(0, 10)))
  let streak = 0
  const d = new Date()
  if (!set.has(S.todayKey(d))) d.setDate(d.getDate() - 1)
  for (;;) {
    const k = S.todayKey(d)
    if (!set.has(k)) break
    streak++
    d.setDate(d.getDate() - 1)
  }
  return streak
}

export function renderToday() {
  // 数据还没到位时，这里必须整体让位给状态卡：
  // 否则 due/fresh 全是 0 → 显示"今天的任务完成了"，冷启动看到的是**假的完成**。
  const ph = dataStateCard({ loadingText: '正在取回你的词条与学习计划…' })
  if (ph) return '<h1 class="page">今日</h1>' + ph

  const due = S.dueCards().length
  // ⚠ 三个数单位不同，绝不能混着用（本轮 bug 的根源）：
  //   freshWords —— 一个词都还没开始的**词**数，和 newAllowance() 同口径
  //   leftover   —— 已开始词的剩余卡型（**张**），能学但不占配额
  //   queueLen   —— 下一次「开始学习」真的会出几张（**张**），由 buildQueue 定
  const freshWords = S.newWordCount()
  const leftover = Math.min(S.leftoverNewCards().length, S.leftoverQuota())
  const allow = S.newAllowance()
  const isRest = S.isRestDay()      // 额度提示要分清"学完了"与"今天不发"，两种都让 allow=0
  const total = S.state.cards.length
  const mastered = S.state.cards.filter(FSRS.isMastered).length
  const today = S.statsFor(S.todayKey())
  const streak = computeStreak()
  // 按钮上的数字是"张"：直接用真实队列长度，不再拿 min(卡, 词配额) 拼一个近似值。
  const queueLen = S.buildQueue().length

  const hour = new Date().getHours()
  const greet = hour < 6 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'

  return (
    '<h1 class="page">' + greet + '<span class="sub">' + esc(fmtDateCN(Date.now())) +
    '　｜　已完成 ' + today.total + ' 次复习' + (today.new_words ? '，新学 ' + today.new_words + ' 个词' : '') + '</span></h1>' +

    goalCard() +

    '<div class="card">' +
    '<div class="metrics">' +
    metric('待复习', due) +
    // 额度用完时不再显示 "0+"：那个加号本意是"库里还有更多"，
    // 但和 0 摆在一起只会让人读成"0 个以上"，含义反而更糊。下面那行说明已经讲清楚了。
    metric('待学新词', (allow === 0 && freshWords > 0) ? 0 : Math.min(freshWords, allow) + (freshWords > allow ? '+' : '')) +
    metric('记忆稳定', mastered, '/' + total) +
    '</div>' +
    // 额度学完时不能只显示一个 0：那读起来像"库里没有新词了"，
    // 而实际上只是今天的量做完了 —— 两件事完全不同，后者不该让人以为词库空了。
    // 休息日又是第三种情况：额度不是被"用完"的，是今天根本不发。
    // 说成"已学完"是假话（今天一个新词都没学），必须分开讲。
    (allow === 0 && freshWords > 0
      ? (isRest
        ? '<p class="tiny center" style="margin:10px 0 0;">今天是休息日 —— 不引新词。' +
          '库里还有 <b>' + freshWords + '</b> 个没学的词，明天继续。</p>'
        : S.newWordsPaused()
          ? '<p class="tiny center" style="margin:10px 0 0;">还有 ' + S.overdueCards().length + ' 张跨日逾期卡，先复习；清理后自动恢复新词。</p>'
        : !S.dailyReviewAllowance()
          ? '<p class="tiny center" style="margin:10px 0 0;">已达到今日正式作答上限，新词留待明天。</p>'
        : '<p class="tiny center" style="margin:10px 0 0;">今日新词额度已学完 —— ' +
          '库里还有 <b>' + freshWords + '</b> 个没学的词，明天继续。</p>')
      : '') +
    // 已开始词的"剩余卡型"：今天学过的新词还有卡没做完。它们能学、要学，
    // 但不占今日新词额度 —— 不说清楚，用户会以为"新词没学满还让我学别的"。
    (leftover > 0
      ? '<p class="tiny center" style="margin:10px 0 0;">另有 <b>' + leftover + '</b> 张' +
        '已开始学习的词剩下的卡片待完成（不占今日新词额度）。</p>'
      : '') +
    '<button class="btn primary block lg" id="start-study" style="margin-top:14px;"' + (queueLen ? '' : ' disabled') + '>' +
    (queueLen ? '开始学习（' + queueLen + ' 张）' : !S.dailyReviewAllowance() ? '已达到今日作答上限' : '当前没有到期任务') +
    '</button>' +
    (queueLen ? '' : '<p class="tiny center" style="margin:10px 0 0;">' + (due ? '仍有 ' + due + ' 张到期卡保留在计划中，明天继续或在设置中调整上限。' : '短期巩固卡到期后会重新出现。') + '</p>') +
    '</div>' +

    '<div class="card tight">' +
    '<div class="row between">' +
    '<div><div class="tiny">连续打卡</div><div style="font-size:20px;font-weight:600;">' + streak + ' 天</div></div>' +
    '<div class="center"><div class="tiny">今日复习</div><div style="font-size:20px;font-weight:600;">' + today.total + '</div></div>' +
    '<div style="text-align:right;"><div class="tiny">同步状态</div><div style="font-size:13px;font-weight:500;color:var(--ink-2);">' +
    (S.state.syncAt ? relTime(S.state.syncAt) : '尚未同步') + '</div></div>' +
    '</div></div>' +

    renderMiniHeat() +

    '<div class="card">' +
    '<div class="card-head"><h2>学习说明</h2></div>' +
    '<p class="muted" style="margin:0 0 8px;">复习时间由记忆规律自动计算：想得起来的词间隔拉长，' +
    '忘掉的词很快重新出现。你只需要如实点四个按钮——<b>忘了 / 吃力 / 记得 / 很简单</b>。</p>' +
    '<p class="tiny" style="margin:0;">目标留存率 ' + Math.round(Number(S.state.settings.target_retention) * 100) +
    '%，可在「我的」里调整。</p>' +
    '</div>'
  )
}

function renderMiniHeat() {
  const days = []
  const d = new Date()
  d.setDate(d.getDate() - 27)
  for (let i = 0; i < 28; i++) {
    const key = S.todayKey(d)
    const row = S.statsFor(key)
    days.push({ key, n: Number(row.total) || 0 })
    d.setDate(d.getDate() + 1)
  }
  const lvl = (n) => (n === 0 ? 0 : n < 10 ? 1 : n < 30 ? 2 : n < 60 ? 3 : 4)

  return (
    '<div class="card"><div class="card-head"><h2>最近 28 天</h2>' +
    '<span class="hint">共 ' + days.reduce((a, b) => a + b.n, 0) + ' 次复习</span></div>' +
    '<div class="heat" style="grid-template-rows:repeat(7,12px);">' +
    days.map((x) => '<i data-l="' + lvl(x.n) + '" title="' + esc(x.key + '：' + x.n + ' 次') + '"></i>').join('') +
    '</div>' +
    '<div class="heat-legend"><span>少</span>' +
    [0, 1, 2, 3, 4].map((l) => '<i data-l="' + l + '"></i>').join('') +
    '<span>多</span></div></div>'
  )
}

export function bindToday(go) {
  const b = $('#start-study')
  if (b) b.onclick = () => go('study')
  // 抽测入口：直接切到练习场 —— 那里有高亮的「每周抽测」卡片。
  // 达标条件里写着"还差一次抽测"，就必须在原地给一条能走的路，
  // 否则用户知道差什么却不知道去哪儿做。
  const t = $('#go-weekly-test')
  if (t) t.onclick = () => go('games')
}

/* ═════════════════════════ 学习 ═════════════════════════ */

const session = {
  queue: [],
  index: 0,
  // ── 计数：三个数**单位不同**，绝不能混用（混用就是 29/26 那个 bug）──
  //   total     本轮计划内的不同卡片数（分母，会话开始时定下，之后只增不减地不参与）
  //   uniqueDone 已完成的不同卡片数（分子，恒 ≤ total）
  //   attempts  累计作答次数（含错题重试；答错重做一次就是 2 次）
  //   retries   重试作答次数（attempts - uniqueDone 的部分）
  done: 0,              // = attempts，保留旧名以免其它调用点全改
  attempts: 0,
  uniqueDone: 0,
  retries: 0,
  tries: null,          // Map<card.id, 已作答次数>
  bonusIds: null,       // 穿插进来的"轻松卡"：不属于本轮 N，不计入分子分母
  shown: false,
  startedAt: 0,
  cardShownAt: 0,
  total: 0,
  mode: 'normal',     // normal | weak
  stumble: 0,         // 连续不顺的次数（用于穿插轻松卡）
  weak: [],           // 本次打得不好的词（用于会话小结）
  graded: 0,          // 本次评过分的卡数
  byGrade: { 1: 0, 2: 0, 3: 0, 4: 0 },
  answered: null,     // 本次卡的作答结果 {ok, verdict, typo, given, expected, kind}
  eventId: null,      // 本次作答的服务端幂等键（换卡时更新）
  choiceMode: false,  // 是否切到选择题
  options: null,      // 选择题选项
  assistShown: false, // 打字题是否展开了"显示选项"（用了就是辅助作答）
}

/** 当前这台设备**实际加载**的版本号：直接读模块 URL 上的 ?v=。
 *  故意不去查云端"最新版本"，因为用户要判断的是"我这台机器现在跑的是哪版"——
 *  万一浏览器吃了旧缓存，这里显示的旧号才是有效信号。 */
export function appVersion() {
  try {
    const v = new URL(import.meta.url).searchParams.get('v')
    if (v) return String(v)
  } catch (e) { /* 读不到就兜底 */ }
  return '?'
}

export function resetSession(mode) {
  session.answerReadyAt = 0
  session.hinted = null
  session.cloze = null      // 本卡的例句填空信息（朗读要用）
  session.clozeFb = null
  session.say = null        // 本卡朗读计划 {text, hint}
  session.mode = mode === 'weak' ? 'weak' : 'normal'
  session.queue = session.mode === 'weak' ? S.buildWeakQueue() : S.buildQueue()
  session.index = 0
  session.done = 0
  session.attempts = 0
  session.uniqueDone = 0
  session.retries = 0
  session.tries = new Map()
  session.bonusIds = new Set()
  session.shown = false
  session.startedAt = Date.now()
  session.cardShownAt = Date.now()
  session.responseStartedAt = Date.now()
  session.responseEndedAt = null
  session.eventId = S.newEventId()   // 本次作答的服务端幂等键
  session.total = session.queue.length
  session.answered = null
  session.choiceMode = false
  session.options = null
  session.assistShown = false
  session.weak = []
  session.graded = 0
  session.byGrade = { 1: 0, 2: 0, 3: 0, 4: 0 }
}

/** Freeze the first answer/reveal time across feedback rerenders. */
function revealStudyAnswer() {
  if (session.responseEndedAt == null) session.responseEndedAt = Date.now()
  session.shown = true
  session.cardShownAt = Date.now()
}

/** 本轮学习是否已经开始作答。同步重绘据此保护当前学习进度。 */
export function studyInProgress() {
  return (session.attempts || 0) > 0
}

/** 本轮队列里剩余卡片的 id（只读快照）。给自动化测试与排障用，不参与业务逻辑。 */
export function sessionQueueIds() {
  return session.queue.map((c) => c.id)
}

/** 本轮的进度快照。分子分母都只认"计划内"的卡，所以 x 永远不会大于 N。 */
export function sessionProgress() {
  const total = session.total || 0
  const done = Math.min(session.uniqueDone || 0, total)
  return {
    done: done,
    total: total,
    attempts: session.attempts || 0,
    retries: session.retries || 0,
    percent: total ? Math.min(100, Math.round((done / total) * 100)) : 0,
  }
}

/* ─────────────── 作答判定 ───────────────
   判定规则已抽到 judge.js：view / game / labs 三处共用同一份规则，
   且"未命中目标表达"不再等同于"错"（四态 hit / alt / wrong / unsure）。
   这里只做 re-export，保持既有 import 路径不变。 */
export {
  normalizeAns, judgeTyped, looksLikeEnglishPhrase, reviewSemantics, cachedVerdict,
  clearJudgeCache, HIT, ALT, WRONG, UNSURE,
} from './judge.js?v=129'

const REG_ZH = { formal: '正式', neutral: '中性', spoken: '口语', informal: '非正式' }

/**
 * 判定结果 → 反馈条 HTML。四态共用一份文案，避免各页面各写一套说法。
 *
 * 最关键的一条：**alt（合理替代表达）必须走"好"的样式**。
 * 用户写 address 而目标是 deal with 时，他写的是地道英语；用红条写"不对"
 * 会在心里留下"我又错了"的印象，而事实上他答对了。文案要把两件事分开说：
 * "你的英语没问题" + "本题要练的搭配是这个"。
 * @param {object} a session.answered / d.answered 形状的判定结果
 * @param {{taskLabel?:string}} [opts] taskLabel 默认"目标搭配"
 */
export function verdictHTML(a, opts) {
  if (!a) return ''
  const o = opts || {}
  const word = o.taskLabel || '目标搭配'
  const exp = esc(a.expected || '')
  if (a.empty) {
    return '<div class="verdict bad">这次没想起来也没关系。先看一遍表达，再选择适合的复习间隔。</div>'
  }
  if (a.reviewing) {
    return '<div class="verdict unsure">正在核对你的表达…（这道题的目标是 <b>' + exp + '</b>）</div>'
  }
  if (a.verdict === ALT) {
    return '<div class="verdict good">你的表达也对：<b>' + esc(a.given) + '</b> —— 英语没问题。' +
      '本题的' + esc(word) + '是 <b>' + exp + '</b>，顺手把这条搭配记一下就行。</div>'
  }
  if (a.verdict === UNSURE) {
    return '<div class="verdict unsure">' +
      (a.reviewReason ? esc(reviewStatusText(a.reviewReason)) + '，<b>不算你错</b>。' :
        articleDifference(a.expected, a.given) ? '这处冠词需要结合语境判断，暂<b>不算你错</b>。' : '这道题没法自动判定，<b>不算你错</b>。') +
      '参考' + esc(word) + '：<b>' + exp + '</b>' +
      (a.given ? '　你写的：' + esc(a.given) : '') +
      (o.retry && a.reviewReason && a.reviewReason !== 'context' ? '<button class="btn sm" id="ans-review-retry" style="display:block;margin-top:10px;min-height:44px;">重新核对表达</button>' : '') + '</div>'
  }
  if (a.ok) {
    // 本就是选择题的（抽测全选择/混合模式），和"打字题临时看选项"要分开说：
    // 前者是题型设计，后者是临场求助，两者都不是无提示产出。
    if (a.choiceMode) {
      return '<div class="verdict good">答对了：<b>' + exp + '</b>（选择题，记为识别成绩）</div>'
    }
    // 用选项辅助选对的，必须当场说清楚它和无提示产出不是一回事，
    // 否则用户会以为"这词我已经会了"，而那正是选择题最容易造成的错觉。
    if (a.assist) {
      return '<div class="verdict good">认出来了：<b>' + exp + '</b>（用了选项，' +
        '算识别成功，不算无提示产出）</div>'
    }
    return '<div class="verdict good">' +
      (a.typo ? '基本正确，但有拼写错误：' : '答对了：') + '<b>' + exp + '</b>' +
      (a.typo ? '　你写的：' + esc(a.given) : '') + '</div>'
  }
  const form = inflectionFeedback(a)
  if (form) {
    return '<div class="verdict coach">已想起目标表达，再调整一下词形：<b>' + esc(form.given) + '</b> → 例句使用 <b>' + esc(form.expected) + '</b>' +
      (form.kind ? '（' + esc(form.kind) + '）' : '') + '。' +
      '<details class="feedback-detail"><summary>查看整句对照</summary><div>你的句子：' + esc(form.givenSentence) + '</div>' +
      '<div>参考填法：' + esc(form.referenceSentence) + '</div></details></div>'
  }
  return '<div class="verdict bad">' + (a.sentence ? '这次先记住这个用法，参考填法是 ' : '可以这样表达： ') + '<b>' + exp + '</b>　你写的：' + esc(a.given) + '</div>'
}

/**
 * 答错时补一句"为什么"：优先给易混词辨析，其次给语域提示。
 * 只说对错不说原因，同一个错误会反复犯 —— 错的那一下才是最好的纠错时机。
 * @returns {string} 没有可用信息时返回空串（调用方据此决定是否渲染）
 */
export function whyNote(word) {
  const p = (word && word.payload) || {}
  const confs = (p.confusables || []).filter((c) => c && c.word)
  if (confs.length) {
    return '别弄混：' + confs.map((c) => c.word + '（' + (c.note || '见词条页') + '）').join('；')
  }
  const c = (p.collocations || [])[0]
  if (c && c.register && REG_ZH[c.register]) return '这条是' + REG_ZH[c.register] + '语域的表达，注意别用错场合'
  return ''
}

/** 答错时的辨析提示块；没有可用信息返回空串。
 *  为什么提到这里统一：原来 game.js 和 labs.js 各写了一份一模一样的 whyBlock，
 *  而**主学习流程（study）压根没调用** —— 96.2% 的词条都有 confusables，
 *  但用户在最主要的答题场景里从来看不到，等于白存。三处共用这一个实现即可。 */
export function whyBlockHTML(word) {
  const note = whyNote(word)
  if (!note) return ''
  return '<p class="tiny" style="margin:8px 0 0;color:var(--ink-2);">💡 ' + esc(note) + '</p>'
}

/** 从同词库其它词条里抽干扰项，组选择题 */
export function buildChoices(word, kind, correct) {
  const pool = []
  S.state.cards.forEach((c) => {
    if (c.word_id === word.id) return
    const w = S.wordOf(c)
    if (!w) return
    if (kind === 'zh') {
      const sn = (w.payload && w.payload.senses) || []
      // 取该词的全部释义（不只第一条）：中文释义重复率高，只取第一条很容易凑不满选项
      sn.slice(0, 3).forEach((x) => {
        const d = x && x.def_zh
        if (d && String(d).length > 1) pool.push(String(d))
      })
    } else {
      const colls = (w.payload && w.payload.collocations) || []
      if (colls.length && colls[0].pattern) {
        const t = String(colls[0].pattern).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
        if (t) pool.push(t)
      } else if (w.lemma) pool.push(w.lemma)
    }
  })
  // 判重必须用"保留中日韩"的归一化：normalizeAns 是给英文判分用的，
  // 它会把中文字符全部剥掉 → 纯中文释义两侧都变成空串 → 所有中文干扰项都会被当成
  // "和正确答案一样"而过滤掉 → 认读卡选项池为空、每张卡都变成"只有看答案"的死路。
  const key = (x) => String(x == null ? '' : x).toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？,.;:!?（）()\[\]【】"'`·]/g, '')
  const uniq = Array.from(new Set(pool.filter((x) => x && key(x) !== key(correct))))
  for (let i = uniq.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = uniq[i]; uniq[i] = uniq[j]; uniq[j] = t
  }
  const opts = uniq.slice(0, 3).map((t) => ({ text: t, ok: false }))
  opts.push({ text: correct, ok: true })
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = opts[i]; opts[i] = opts[j]; opts[j] = t
  }
  return opts
}

/** 依据作答结果给出建议评分：错→忘了；拼写错→吃力；对且快→很简单；对且慢→记得 */
function suggestGrade() {
  if (session.hinted === 'hard') return 1
  const a = session.answered
  if (!a) return null
  // 合理替代表达（alt）：英语是对的，不能给 1（那等于说用户答错了）。
  // 但目标搭配没提取出来，也不该给 4 —— 给 3，让 FSRS 按正常节奏再安排一次。
  if (a.verdict === ALT) return 3
  // 待复核（unsure）：判定不了就不参与评分，交给用户自己如实打分
  if (a.verdict === UNSURE) return null
  // 用"显示选项"选对的：识别成功，但不是无提示产出。封顶到"吃力"，
  // 让这张卡更快回来做一次真正自己想出来的 —— 选择题答对≠能自然用出来。
  if (a.assist && a.ok) return 2
  if (inflectionFeedback(a)) return 2
  if (!a.ok) return 1
  if (a.typo) return 2
  const secs = (Date.now() - (session.cardShownAt || Date.now())) / 1000
  const base = secs <= 8 ? 4 : 3
  return base
}

export function renderStudy() {
  if (!session.total && !session.queue.length) resetSession()
  if (!S.isTestSession() && !S.dailyReviewAllowance()) session.queue = []

  if (!session.queue.length) {
    const today = S.statsFor(S.todayKey())
    const g = session.byGrade
    const good = (g[3] || 0) + (g[4] || 0)
    const bad = (g[1] || 0) + (g[2] || 0)
    const mins = session.startedAt ? Math.max(1, Math.round((Date.now() - session.startedAt) / 60000)) : 0
    const rate = session.graded ? Math.round((good / session.graded) * 100) : 0

    // 会话小结：只在真的评过分时显示明细，纯进入就退出不显示
    const summary = session.graded
      ? '<div class="card">' +
        '<div class="card-head"><h2>本次小结</h2></div>' +
        '<div class="metrics">' +
        metric('评过卡数', session.graded) +
        metric('记住', good) +
        metric('忘了/吃力', bad) +
        metric('一次通过率', rate + '%') +
        '</div>' +
        '<div class="mg-row" style="margin-top:10px;">' +
        summaryBar(g) +
        '</div>' +
        '<p class="tiny" style="margin:10px 0 0;">' +
        (rate >= 80 ? '状态很好，按这个节奏走。'
          : rate >= 50 ? '中规中矩 —— 标了"忘了/吃力"的词明天会优先回来。'
          : '这次偏吃力。别硬扛：把标了"忘了"的词交给「只练薄弱词」再过一遍，比继续加新词有效。') +
        (mins ? '　本次用时约 ' + mins + ' 分钟。' : '') +
        (session.hintedCount ? '　其中 ' + session.hintedCount + ' 张是没想起来、直接看答案的（已按"需要加强"记分）。' : '') +
        '</p>' +
        '</div>' +
        (session.weak.length
          ? '<div class="card">' +
            '<div class="card-head"><h2>本次薄弱的 ' + session.weak.length + ' 个词</h2></div>' +
            '<div class="chips">' + session.weak.slice(0, 20).map((x) =>
              '<span class="chip">' + esc(x.term) + '</span>').join('') + '</div>' +
            '<button class="btn primary block" id="study-weak" style="margin-top:12px;">' +
            '只练这些薄弱词</button></div>'
          : '')
      : ''

    // 词库真的是空的：不能说"今天的复习任务完成了"——那会让人以为已经学完了。
    // 新设备/数据丢失后最容易撞上这一屏，必须明确告诉他去哪儿加词。
    const noPlan = !session.graded && !today.total && !S.state.words.length
    if (noPlan) {
      // 先分清"还没加载"和"真的没有"：前者说"词库还是空的"，用户会去重新导入
      const ph = dataStateCard({ loadingText: '正在取回词库与学习计划…' })
      if (ph) return '<h1 class="page">学习</h1>' + ph
      return (
        '<h1 class="page">学习</h1>' +
        '<div class="empty"><div class="big">词库还是空的</div>' +
        '<p class="tiny">还没有可以学的词 —— 先去「词库」添加单词，或导入一份词单。</p>' +
        '<div class="btn-group" style="justify-content:center;margin-top:18px;">' +
        '<button class="btn primary" id="study-empty-lib">去词库添加</button>' +
        '<button class="btn ghost" id="study-done-back">返回今日</button>' +
        '</div></div>'
      )
    }

    return (
      '<h1 class="page">学习</h1>' +
      '<div class="empty"><div class="big">' +
      (!S.dailyReviewAllowance() ? '已达到今日作答上限' : session.graded ? '本次学习完成' : '当前没有到期任务') + '</div>' +
      '<p class="tiny">今日已正式作答 ' + S.dailyReviewed() + ' 次' +
      (today.new_words ? '，新学 ' + today.new_words + ' 个词' : '') + '</p>' +
      '<div class="btn-group" style="justify-content:center;margin-top:18px;">' +
      '<button class="btn soft" id="study-again">重新检查一遍</button>' +
      '<button class="btn ghost" id="study-weak-all">只练薄弱词</button>' +
      '<button class="btn ghost" id="study-done-back">返回今日</button>' +
      '</div></div>' +
      summary
    )
  }

  const card = session.queue[0]
  const word = S.wordOf(card)
  if (!word) {
    session.queue.shift()
    return renderStudy()
  }

  const p = word.payload || {}
  const ipa = p.ipa && (p.ipa.uk || p.ipa.us)
  const type = card.card_type || 'recognition'
  const prog = sessionProgress()
  const progress = prog.percent

  let front = ''
  let revealLabel = '看答案'
  let interactive = null   // { kind:'type'|'choice', expected, choices, prompt }

  // 每张卡的朗读/挖空信息都要先清空：换卡时队列是 shift 走的，不会走 resetSession，
  // 不清就会把上一张卡的例句当成这一张的（朗读内容会串卡）
  session.cloze = null
  session.clozeFb = null
  session.say = null

  if (type === 'production') {
    const senses = (p.senses || []).map((s) => s.def_zh).filter(Boolean).join('；')
    const patterns = (p.collocations || []).slice(0, 3).map((c) => c.zh).filter(Boolean).join('　/　')
    front =
      '<div class="ask">用英语说出来 / 打出来</div>' +
      '<div class="term small">' + esc(senses || word.lemma) + '</div>' +
      (patterns ? '<div class="ipa">搭配提示：' + esc(patterns) + '</div>' : '')
    revealLabel = '看英文'
    const target = (p.collocations && p.collocations.length && p.collocations[0].pattern) || word.lemma
    interactive = { kind: 'type', expected: String(target).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(), zh: senses || patterns }
  } else if (type === 'cloze') {
    const cz = clozeOf(word)
    session.cloze = cz || null
    if (cz) {
      front = '<div class="ask">按句意填写空缺，注意词形（单复数、时态、语态）</div>' +
        '<div style="font-size:19px;line-height:1.7;margin-top:10px;">' + esc(cz.sentence) + '</div>' +
        (cz.zh ? '<div class="ipa" style="margin-top:8px;">' + esc(cz.zh) + '</div>' : '')
      // 送判分/复核的必须是**挖空后**的句子（cz.sentence），不是原文：
      // 原文里答案还在（"She complimented him…"），复核模型会看到答案已填入，
      // 判断必然受干扰 —— 2026-10-13 "compliments vs complimented" 就栽在这里。
      interactive = { kind: 'type', expected: cz.answer, sentence: cz.sentence || cz.raw, zh: cz.zh,
        pos: (p.senses || []).map((s) => s && s.pos).filter(Boolean) }
      revealLabel = '看答案'
    } else {
      // 例句里挖不出空：退化成"看中文说搭配"，也比干看一个单词强
      const fb = clozeFallback(word)
      session.clozeFb = fb || null
      if (fb) {
        front = '<div class="ask">' + esc(fb.ask) + '</div>' +
          '<div class="term small">' + esc(fb.prompt) + '</div>'
        // fb.prompt 是"要表达的中文"，fb.ask 才是题目指令 —— 原来是反的：
        // 复核模型会收到"sentence = 中文"这种自相矛盾的输入。按语义归位。
        interactive = { kind: 'type', expected: fb.expected, sentence: '', zh: fb.prompt }
      } else {
        front = '<div class="ask">回忆这个词的用法</div>' +
          '<div class="term small">' + esc(word.lemma) + '</div>'
      }
    }
  } else {
    front = '<div class="term">' + esc(word.lemma) + '</div>' +
      (ipa ? '<div class="ipa">/' + esc(String(ipa).replace(/\//g, '')) + '/</div>' : '') +
      '<div class="ask">在脑中回想它的搭配与例句</div>'
    const sn = (p.senses || []).map((s) => s.def_zh).filter(Boolean)[0]
    if (sn) interactive = { kind: 'choice-zh', expected: String(sn) }
  }

  // 认读卡（英→中）默认走选择题：打中文要切输入法，而且中文释义写法太多，
  // 精确匹配必然误判"对答成错"。选项不够时退化为"看答案"。
  if (interactive && interactive.kind === 'choice-zh') session.choiceMode = true

  // 选择题选项（进入选择题模式时才生成，避免每次渲染都重排）
  if (interactive && session.choiceMode && !session.options) {
    const kind = interactive.kind === 'choice-zh' ? 'zh' : 'en'
    session.options = buildChoices(word, kind, interactive.expected)
  }
  if (session.options && session.options.length < 4 && interactive.kind !== 'choice-zh') {
    session.choiceMode = false
  }
  // 认读卡只要凑够 2 项就照常作答（见上面兜底说明）
  // 认读卡即使选项不足也不回退到打字：保持选择题/看答案两条路

  const hasContent = (p.collocations || []).length > 0 || (p.senses || []).length > 0
  const answerBody = hasContent
    ? wordAnswerHTML(word)
    : '<p class="muted" style="margin:0 0 10px;">这个词条还没有搭配释义，生成后就有地道搭配和例句了。</p>' +
      '<button class="btn soft sm" id="study-gen">用 AI 生成释义</button>'

  const suggest = suggestGrade()

  // 作答反馈条 + 答错时的辨析（易混词 / 语域），与练习场、labs 共用同一实现
  const feedback = verdictHTML(session.answered, { retry: true }) +
    (session.answered && !session.answered.ok ? whyBlockHTML(word) : '')

  // 作答区（还没揭晓答案时）
  let answerArea = ''
  if (!session.shown && interactive) {
    if (interactive.kind === 'choice-zh') {
      // 认读卡：选择题是唯一主路径（不打中文 —— 释义写法太多，精确匹配必误判）
      // 选项够 2 个就让答：词库里同义释义一多会凑不满 4 项，卡死在这儿比选项少更糟
      const opts = (session.options && session.options.length >= 2) ? session.options : []
      answerArea = opts.length
        ? '<div class="tiny" style="margin:12px 0 6px;">哪个才是它的意思？</div>' +
          '<div class="choices">' +
          opts.map((o, i) =>
            '<button class="choice' + (session.answered ? (o.ok ? ' good' : '') : '') + '" data-opt="' + i + '"' +
            (session.answered ? ' disabled' : '') + '>' + esc(o.text) + '</button>'
          ).join('') +
          '</div>' +
          '<div class="row" style="gap:10px;margin-top:8px;justify-content:center;">' +
          '<button class="btn sm ghost" id="ans-reveal">不会，看答案</button>' +
          '</div>'
        : // 没有干扰项时保留主动回忆路径，不能让所有自评都被当成直接看答案。
          '<div class="btn-group" style="margin-top:8px;justify-content:center;">' +
          '<button class="btn soft" id="ans-check">已尝试回忆，核对答案</button>' +
          '<button class="btn sm ghost" id="ans-reveal">不会，看答案</button></div>'
    } else {
      // 打字卡（production / cloze / 抽测）：主路径（提交）→ 降级（不会，看答案）
      // 「显示选项」是**可选辅助**，不是主路径：卡住时才用，用了就记为辅助作答
      // （评分封顶到"吃力"），未来再安排一次无提示的新例句 —— 否则选择题答对
      // 会被当成"能自然产出"，那是两件不同的事。
      const assistOpts = session.assistShown && session.options && session.options.length >= 2
        ? '<div class="choices" style="margin-top:10px;">' +
          session.options.map((o, i) =>
            '<button class="choice" data-opt="' + i + '"' + (session.answered ? ' disabled' : '') + '>' +
            esc(o.text) + '</button>').join('') + '</div>'
        : ''
      answerArea =
        '<input class="input ans-in" id="ans-in" placeholder="在这里打出来，回车提交" autocomplete="off" ' +
        'autocapitalize="off" spellcheck="false" value="' + esc((session.answered && session.answered.given) || '') + '"' +
        (session.answered ? ' disabled' : '') + '>' +
        (session.answered
          ? ''
          : '<button class="btn primary block" id="ans-go" style="margin-top:10px;">提交</button>' +
            assistOpts +
            '<div class="row" style="gap:10px;margin-top:8px;justify-content:center;">' +
            (session.assistShown
              ? '<span class="tiny">选一个（记为辅助作答，不算无提示产出）</span>'
              : '<button class="btn sm ghost" id="ans-assist">显示选项</button>') +
            '<button class="btn sm ghost" id="ans-reveal">不会，看答案</button>' +
            '</div>')
    }
  }

  // 本张卡的交互定义，绑定事件时要用
  session.interactive = interactive

  // 朗读内容：必须读"这次考核的东西"，不能永远读那个单词（例句填空考的是搭配/短语）
  //   认读（英→中）：题面就是词 → 读词，不算提示
  //   例句填空：没揭晓 → 读空缺答案（算提示）；已揭晓 → 读整句（巩固）
  //   中→英 / 抽测：读英文答案（未揭晓算提示）
  session.say = (() => {
    if (session.cloze && session.cloze.raw) {
      return session.shown
        ? { text: session.cloze.raw, hint: false, label: '朗读整句' }
        : { text: session.cloze.answer, hint: true, label: '听答案（算提示）' }
    }
    if (session.clozeFb) {
      return { text: session.clozeFb.expected, hint: !session.shown, label: session.shown ? '朗读' : '听答案（算提示）' }
    }
    if (interactive && interactive.kind === 'type' && interactive.expected) {
      return { text: String(interactive.expected), hint: !session.shown, label: session.shown ? '朗读' : '听答案（算提示）' }
    }
    return { text: word.lemma || word.normalized || '', hint: false, label: '朗读' }
  })()

  const leech = card.lapses >= 4
    ? '<div class="leech-box">' +
      '<div class="tiny" style="color:var(--warn);">⚠️ 这张卡已经忘了 ' + card.lapses + ' 次。' +
      '研究里把这类反复失败的卡叫 leech，但<b>原因不止一个</b>：可能是卡片太长太抽象，' +
      '也可能是题意有歧义、答案被误判，或者两个近义表达混在一起练。</div>' +
      '<p class="tiny" style="margin:6px 0 0;">先看看下面这条搭配本身是不是太长？如果觉得判分有问题，' +
      '在「统计 → 判分维度」里能看到有多少次是"无法自动判定"或"用了别的正确表达"。</p>' +
      '<button class="btn sm" id="study-leech-fix" style="margin-top:6px;">AI 帮我改短、改具体</button>' +
      '</div>'
    : ''

  const gradeButtons = FSRS.GRADES.map((g) => {
    const pv = FSRS.preview(card, session.hinted === 'hard' ? 1 : g.grade, Date.now(), Number(S.state.settings.target_retention) || 0.9, undefined, {
      minutes: Number(S.state.settings.learn_step_minutes) || 10,
      days: Number(S.state.settings.learn_step_days) || 1,
    })
    const sug = suggest === g.grade ? ' sug' : ''
    return '<button data-g="' + g.grade + '" class="' + sug.trim() + '"><span class="lab">' + esc(g.label) + '</span>' +
      '<span class="iv">' + esc(FSRS.humanInterval(pv.intervalDays)) + '</span></button>'
  }).join('')

  return (
    '<h1 class="sr-only">学习</h1>' +
    '<div class="study' + (session.shown ? ' study-revealed' : '') + '">' +
    '<div class="study-bar">' +
    '<button class="btn sm ghost" id="study-exit" title="退出本次学习">' + icon('back', 18) + '</button>' +
    '<div class="progress"><i style="width:' + progress + '%"></i></div>' +
    '<span class="tiny" title="已完成卡数 / 本轮计划卡数（同一张卡答错会重做）">' + prog.done + ' / ' + prog.total + '</span>' +
    '</div>' +
    /* 两个数字单位不同，必须各自把单位说出来：
       左边是**张数**（计划 20 张），右边是**作答次数**（20 张卡共作答 22 次 = 其中 2 张答错重做过）。
       旧文案"本轮卡片 20 / 20 · 累计作答 22 次"会被读成"上限 20，怎么会出现 22"（用户实测提问）。
       另外"累计"二字暗示跨会话累计，也是误读来源 —— 它只是本次会话的作答次数。 */
    (prog.retries
      ? '<p class="tiny" style="margin:6px 0 0;text-align:right;">本轮计划 ' + prog.total + ' 张' +
        '　·　共作答 ' + prog.attempts + ' 次（答错重做 ' + prog.retries + ' 次）</p>'
      : '') +

    '<div class="qcard">' +
    leech +
    (type !== 'recognition' ? '<div class="tiny" style="margin-bottom:10px;">' +
      esc((CARD_TYPES[type] || {}).label || '') + '</div>' : '') +
    front +
    // 朗读是辅助动作，跟在题干旁边；原来挤在作答按钮里会与"提交"抢注意力
    // 揭晓后也保留（这时听整句含答案，用于巩固，不算提示）
    (session.say && session.say.text
      ? '<div class="row" style="justify-content:center;margin-top:6px;">' +
        '<button class="btn sm ghost" id="say-word">' + icon('sound', 16) + ' ' +
        esc(session.say.label || '朗读') + '</button></div>'
      : '') +
    feedback +
    answerArea +
    (session.shown ? '' : (interactive ? '' : '<div class="btn-group" style="justify-content:center;margin-top:12px;">' +
      '<button class="btn soft" id="ans-check">已尝试回忆，核对答案</button>' +
      '<button class="btn ghost" id="reveal">' + esc(revealLabel) + '</button></div>')) +
    (session.shown
      ? '<div class="study-grade-bar"><div class="grades' + (suggest ? ' has-sug' : '') + '">' + gradeButtons + '</div>' +
        '<p class="tiny center" style="margin-top:10px;">' +
        (suggest != null ? '已根据作答提供建议，你可以自行选择。' : '按这次回忆的轻松程度选择。') +
        '用于安排下次复习。' +
        '</p></div>'
      : '') +
    (session.shown ? '<details class="answer study-details" id="study-details"><summary>查看释义、搭配与例句</summary>' + answerBody + '</details>' : '') +
    '</div>' +
    (session.shown
      ? '<div class="card"><div class="card-head"><h2>造个句（可选）</h2></div>' +
        '<p class="tiny" style="margin:0 0 8px;">试着用 <b>' + esc(word.lemma) + '</b> 写一句你工作里真的会说的话，' +
        '我检查有没有用上这个表达。不计分。</p>' +
        '<input class="input" id="mine-in" placeholder="My sentence…" autocomplete="off">' +
        '<div class="row" style="gap:8px;margin-top:8px;"><button class="btn sm" id="mine-go">检查</button>' +
        '<span id="mine-out" class="tiny"></span></div>' +
        '</div>'
      : '') +
    '</div>'
  )
}

export function bindStudy(go, onChanged) {
  const exit = $('#study-exit')
  if (exit) exit.onclick = async () => {
    if (session.uniqueDone > 0 && !(await confirmDialog({
      title: '结束本次学习？',
      sub: '本轮已完成 ' + session.uniqueDone + ' 张' +
        (session.retries ? '（含重试共作答 ' + session.attempts + ' 次）' : ''),
      body: '<p class="muted">已评分的卡会保留，未做的卡留在队列里，下次继续。</p>',
      okText: '结束',
    }))) return
    resetSession()
    go('today')
  }

  const emptyLib = $('#study-empty-lib')
  if (emptyLib) emptyLib.onclick = () => { if (go) go('library'); else onChanged() }
  const again = $('#study-again')
  if (again) again.onclick = () => { resetSession(); onChanged() }

  // 完成态也要有出口：原来这里只有"重新检查/只练薄弱词"，用户被困在完成页
  const doneBack = $('#study-done-back')
  if (doneBack) doneBack.onclick = () => { resetSession(); go('today') }
  const weakFromSummary = $('#study-weak')
  const weakAll = $('#study-weak-all')
  const goWeak = () => {
    const n = S.buildWeakQueue().length
    if (!n) return fail('还没有薄弱词 —— 薄弱 = 忘记次数 ≥ 2 次的卡，先在正式学习里多评几张')
    resetSession('weak')
    ok('薄弱词专练：' + n + ' 张')
    onChanged()
  }
  if (weakFromSummary) weakFromSummary.onclick = goWeak
  if (weakAll) weakAll.onclick = goWeak

  // 键盘快捷键：1-4 评分、空格揭晓、Enter 提交（桌面端效率）
  if (!window.__lexiloopStudyKeys) {
    window.__lexiloopStudyKeys = true
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || ''
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.key === ' ' && !typing) {
        const rv = $('#reveal')
        if (rv) { e.preventDefault(); rv.click() }
        return
      }
      if (/^[1-4]$/.test(e.key) && !typing) {
        const btn = document.querySelector('.grades [data-g="' + e.key + '"]')
        if (btn && !btn.disabled) { e.preventDefault(); btn.click() }
      }
    })
  }

  const say = $('#say-word')
  if (say) say.onclick = () => {
    const card = session.queue[0]
    const w = card && S.wordOf(card)
    const plan = session.say
    const text = (plan && plan.text) || (w && (w.lemma || w.normalized)) || ''
    if (!text) return
    if (!speak(text)) { fail('当前环境不支持朗读'); return }
    if (plan && plan.hint && !session.shown) {
      const first = !session.hinted
      session.hinted = 'hard'   // 听了答案就等于没自己想起来：评分封顶，避免虚高
      if (first) toast('听到了答案，这次按「需要加强」记分')
    }
  }

  const reveal = $('#reveal')
  if (reveal) reveal.onclick = () => {
    // 没尝试作答就揭晓 = 硬提示：这次不算成功提取，按忘了处理
    session.hinted = 'hard'
    revealStudyAnswer()
    onChanged()
  }
  const recallCheck = $('#ans-check')
  if (recallCheck) recallCheck.onclick = () => {
    // 已听过答案仍算硬提示，不能通过核对按钮抹掉。
    if (session.hinted !== 'hard') session.hinted = 'soft'
    revealStudyAnswer()
    onChanged()
  }

  // ── 作答交互 ──
  const commitTyped = () => {
    const it = session.interactive
    if (!it || session.answered) return          // 防重复提交：双击/回车连发只算一次
    const inp = $('#ans-in')
    const given = inp ? inp.value : ''
    const r = judgeTyped(given, it.expected, { accept: it.accept, sentence: it.sentence })
    session.answered = {
      ok: r.ok, verdict: r.verdict, typo: r.typo, loose: r.loose,
      empty: r.empty, given: given, expected: it.expected, kind: it.kind, sentence: it.sentence || '',
      pos: it.pos || [],
    }
    revealStudyAnswer()
    onChanged()
    reviewIfNeeded()
  }

  /**
   * 未命中目标、但作答"像一条有意写出的英文短语"时，把判定交给语义复核。
   *
   * 为什么要异步：本地只能比字符串，判断不了 address 是不是 deal with 的合理替代。
   * 为什么复核期间不先显示"不对"：先亮红再改口更伤人 —— 用户已经记住了那一下否定。
   * 为什么要有界超时 + 失败即 unsure：**宁可漏判，不可错判**。
   */
  const reviewIfNeeded = async () => {
    const a = session.answered
    const it = session.interactive
    if (!a || !it || a.reviewing || ![WRONG, UNSURE].includes(a.verdict)) return
    if (it.kind !== 'type' || !looksLikeEnglishPhrase(a.given)) return

    // 上次已经判过同样的组合：直接用缓存，不再等
    const hit = cachedVerdict(it.expected, a.given, { sentence: it.sentence || '', zh: it.zh || '', model: S.state.settings.llm_model || undefined })
    if (!hit) {
      a.reviewing = true
      a.reviewReason = 'pending'
      const ownerId = S.state.user && S.state.user.id
      onChanged()
      const res = await reviewSemantics({
        sentence: it.sentence || '',
        zh: it.zh || '',
        expected: it.expected,
        given: a.given,
        chat: AUTH.chatText,
        model: S.state.settings.llm_model || undefined,
      })
      if (session.answered !== a || (S.state.user && S.state.user.id) !== ownerId) return
      a.reviewing = false
      a.reviewReason = res.reason
      applyVerbal(a, res.verdict)
      onChanged()
      return
    }
    a.reviewReason = 'cached'
    applyVerbal(a, hit)
    onChanged()
  }

  /** 复核结论落到 answered 上。null = 判定不了 → unsure（不算错，也不封顶评分） */
  function applyVerbal(a, verdict) {
    if (verdict === 'alt') {
      a.verdict = ALT
      a.ok = true          // 英语是对的
      a.target = false     // 但目标搭配没提取出来，不计命中
    } else if (verdict === 'wrong') {
      a.verdict = WRONG
      a.ok = false
      a.target = false
    } else {
      a.verdict = UNSURE
      a.ok = false
      a.target = false
    }
  }

  const retryReview = $('#ans-review-retry')
  if (retryReview) retryReview.onclick = reviewIfNeeded

  const it0 = session.interactive
  if (it0) {
    const go = $('#ans-go')
    if (go) go.onclick = commitTyped
    const inp = $('#ans-in')
    if (inp) {
      inp.onkeydown = (e) => { if (e.key === 'Enter' && !session.answered) commitTyped() }
      // 只在作答阶段自动聚焦，评分阶段不抢焦点
      if (!session.answered && !session.choiceMode) setTimeout(() => { try { inp.focus() } catch (e) {} }, 60)
    }
    // 「显示选项」：惰性生成，只在真点了才计算 —— 打字题是主路径，
    // 每次渲染都预生成选项会白算四选一的干扰项，还可能打乱选项顺序。
    const assist = $('#ans-assist')
    if (assist) assist.onclick = () => {
      const card = session.queue[0]
      const w = card && S.wordOf(card)
      if (!w) return
      if (!session.options) session.options = buildChoices(w, 'en', it0.expected)
      // 词库小的时候凑不出干扰项。必须当场说明 ——
      // 旧行为是按钮消失、什么都不发生，用户只会以为自己点坏了。
      if (!session.options || session.options.length < 2) {
        fail('词库还太小，凑不出干扰选项 —— 多学几个词就有了')
        return
      }
      session.assistShown = true
      onChanged()
    }
    const rv = $('#ans-reveal')
    if (rv) rv.onclick = () => {
      session.hinted = session.answered ? 'soft' : 'hard'
      session.answered = null
      revealStudyAnswer()
      onChanged()
    }
    $$('.choice').forEach((btn) => {
      btn.onclick = () => {
        if (session.answered) return
        const i = Number(btn.dataset.opt)
        const opt = session.options[i]
        // assist：打字题用了"显示选项"才选出来的 —— 算识别成功，不算无提示产出
        const assist = session.assistShown && it0.kind === 'type'
        session.answered = {
          ok: !!opt.ok, verdict: opt.ok ? HIT : WRONG, typo: false, loose: false, empty: false,
          assist: assist, given: opt.text, expected: it0.expected, kind: it0.kind,
        }
        if (assist) session.hinted = 'soft'   // 用辅助 = 软提示，评分会被封顶
        revealStudyAnswer()
        onChanged()
      }
    })
  }

  // ── 造句练习（不计分） ──
  const mineGo = $('#mine-go')
  if (mineGo) {
    mineGo.onclick = () => {
      const card = session.queue[0]
      const w = card && S.wordOf(card)
      const inp = $('#mine-in')
      const out = $('#mine-out')
      if (!w || !inp || !out) return
      const s = String(inp.value || '').trim()
      const n = s.split(/\s+/).filter(Boolean).length
      if (n < 4) { out.textContent = '写长一点（至少 4 个词）才能看出用法'; out.style.color = 'var(--warn)'; return }
      const used = ENRICH.mentionsTarget(w.normalized, s)
      out.innerHTML = used
        ? '<span style="color:var(--ok);">✓ 用上了这个表达</span>'
        : '<span style="color:var(--warn);">没检测到目标词——换个说法试试，或直接用上面的搭配</span>'
    }
  }

  const leechFix = $('#study-leech-fix')
  if (leechFix) leechFix.onclick = async () => {
    const card = session.queue[0]
    const w = card && S.wordOf(card)
    if (!w) return
    leechFix.disabled = true
    leechFix.textContent = '正在改短…'
    try {
      const res = await ENRICH.enrichTerm(w.normalized, {
        model: S.state.settings.llm_model || undefined,
        mode: 'leech',
      })
      const merged = Object.assign({}, w.payload || {}, res.data, { leech_rewritten: true })
      await S.putWord(w.normalized, merged.lemma || w.lemma, merged)
      ok('已改短：' + res.data.collocations.length + ' 条核心搭配')
      onChanged()
    } catch (e) {
      leechFix.disabled = false
      leechFix.textContent = 'AI 帮我改短、改具体'
      fail((e && e.message) || '改写失败')
    }
  }

  const gen = $('#study-gen')
  if (gen) gen.onclick = async () => {
    const card = session.queue[0]
    const w = card && S.wordOf(card)
    if (!w) return
    gen.disabled = true
    gen.textContent = '生成中，请稍候…'
    try {
      const res = await ENRICH.enrichTerm(w.normalized, { model: S.state.settings.llm_model || undefined })
      const merged = Object.assign({}, w.payload || {}, res.data)
      await S.putWord(w.normalized, res.data.lemma || w.lemma, merged)
      ok('释义已生成')
      onChanged()
    } catch (e) {
      gen.disabled = false
      gen.textContent = '用 AI 生成释义'
      fail((e && e.message) || '生成失败')
    }
  }

  $$('[data-g]').forEach((btn) => {
    btn.onclick = async () => {
      const card = session.queue[0]
      let grade = Number(btn.dataset.g)
      if (!card) return
      if (!S.isTestSession() && !S.dailyReviewAllowance()) { onChanged(); return }
      // 防误触：评分后页面会整块重绘，新按钮就位时用户的双击/连击可能正好落在
      // 下一张卡上 —— 新卡还没看就被评了分，还会被写进 FSRS。
      if (Date.now() < (session.answerReadyAt || 0)) return
      btn.disabled = true

      const before = {
        stability: card.stability, difficulty: card.difficulty,
        status: card.status, due: card.due,
      }
      const res = S.applyGrade(card, grade, { hinted: session.hinted })
      grade = res.log.grade
      const eventId = session.eventId || S.newEventId()
      if (session.hinted) session.hintedCount = (session.hintedCount || 0) + 1
      // 判分维度跟着日志一起落库，否则"待复核有多少""多少分靠提示拿到"永远算不出来
      const ans = session.answered
      const gradedAt = Date.now()
      const startedAt = session.responseStartedAt
      const answeredAt = session.responseEndedAt
      const validTiming = Number.isFinite(startedAt) && Number.isFinite(answeredAt) &&
        startedAt <= answeredAt && answeredAt <= gradedAt
      const observation = {
        version: 1,
        review_reason: ans && ans.reviewReason || null,
        card_type: card.card_type || 'recognition',
        response_ms: validTiming ? answeredAt - startedAt : null,
        feedback_ms: validTiming ? gradedAt - answeredAt : null,
        total_ms: validTiming ? gradedAt - startedAt : null,
      }
      const log = Object.assign({}, res.log, {
        prev_state: { ...res.log.prev_state, learning_observation: observation },
        elapsed_ms: observation.total_ms,
        verdict: (ans && ans.verdict) || null,
        hinted: !!session.hinted,
        assisted: !!(ans && (ans.assist || ans.choiceMode)),
      })

      session.queue.shift()
      // ── 计数：分子分母必须同单位，否则又会出现"29 / 26" ──
      //   tries 记录这张卡本次会话被作答了几次：第 1 次算"完成一张卡"，
      //   第 2 次起算"重试"（不改分子）；穿插进来的轻松卡（bonus）两个都不算。
      const n = (session.tries.get(card.id) || 0) + 1
      session.tries.set(card.id, n)
      session.attempts++
      if (n === 1) {
        if (!session.bonusIds.has(card.id)) session.uniqueDone++
      } else {
        session.retries++
      }
      session.done = session.attempts      // 兼容仍读 done 的老代码
      session.graded++
      session.hinted = null
      session.byGrade[grade] = (session.byGrade[grade] || 0) + 1
      if (grade <= 2) {
        const w = S.wordOf(card)
        if (w && !session.weak.some((x) => x.id === w.id)) {
          session.weak.push({ id: w.id, term: w.lemma || w.normalized })
        }
      }
      /* 本轮是否还有"没做过的计划内卡片"。
         进度条的分子 uniqueDone 在**第一次作答**就把这张卡算进去了，
         所以「计划 1 张」的轮次从第一题起进度就是 1 / 1（100%）。
         这时如果还把错题重排回队列、还往里插轻松卡，用户看到的就是
         "进度明明已经满了，却还在没完没了地出题"—— 2026-10-17 线上实测：
         本轮计划 1 张，同一张卡被问了 3 次，中间还插了 1 张，共作答 4 次，
         用户描述为"答完后只要是错了就会无限要求答下去"。
         规则：只有后面还有别的计划内卡片时，重排错题/插卡才有意义。 */
      const morePlanned = session.uniqueDone < session.total

      // rubber-banding：连着两张打得吃力/忘了，就插一张已掌握的词维持节奏
      // （只在还有计划内卡片时插 —— 否则 1 张的轮次会被撑成 2 张）
      if (grade <= 2) session.stumble = (session.stumble || 0) + 1
      else session.stumble = 0
      if (session.stumble >= 2 && morePlanned) {
        /* 挑哪张"轻松卡"：**必须避开最近刚复习过的**，且不要每次都抽同一张。
           旧实现是 `state.cards.find(...)` —— 数组顺序稳定，命中永远是最先那张，
           结果同一条"已掌握"卡被反复抽出来当缓冲。2026-10-19 用户实测：
           'stemming from' 的例句卡 5 天内被抽到 12 次（reps 已 37），
           到期日被推到 2030 年 —— 越抽越远，却永远排在第一顺位。
           现在：3 天冷却 + 取"最久没见"的那张（自然轮换）。 */
        const COOLDOWN = 3 * 86400000
        const nowMs = Date.now()
        const cands = S.state.cards.filter((c) =>
          !c.suspended && FSRS.isMastered(c) && c.due &&
          session.queue.indexOf(c) < 0 && c.id !== card.id &&
          !(Number(c.last_review_at) > nowMs - COOLDOWN))
        const easy = cands.length
          ? cands.reduce((a, b) =>
              (Number(a.last_review_at) || 0) <= (Number(b.last_review_at) || 0) ? a : b)
          : null
        if (easy) {
          session.queue.splice(1, 0, easy)
          session.bonusIds.add(easy.id)   // 不属于本轮计划，不占分子分母
          session.stumble = 0
          toast('插一张轻松的，缓一缓', 'ok')
        }
      }
      session.shown = false
      session.cardShownAt = Date.now()
      session.responseStartedAt = Date.now()
      session.responseEndedAt = null
      // 换了一张卡 = 一次全新的作答：必须换事件 ID，
      // 否则上一张卡的 eventId 会在这里被复用，服务端会把新作答当成重放而丢弃
      session.eventId = S.newEventId()
      session.answerReadyAt = Date.now() + 350
      session.answered = null
      session.choiceMode = false
      session.options = null
      session.assistShown = false
      session.interactive = null

      // 尊重调度器的 10 分钟重学间隔，不把尚未到期的错卡立即塞回当前队列。
      if (grade === 1) toast('这张卡已安排 10 分钟后重学，本轮不提前重复', 'ok')

      onChanged()

      try {
        // 写库统一走 store 层，避免时间字段格式在多个地方各写一遍。
        // 走服务端函数：日志与调度在同一个事务里落地，且测试模式不会改调度。
        await S.recordReview(log, card, { eventId, isTest: S.isTestSession() })
        S.pullStats().then(() => S.saveLocal()).catch(() => {})
      } catch (e) {
        // 补写也要带上同一个 eventId 与测试标记，否则重放会重复计分或污染调度
        S.queueReview(log, card, { eventId, isTest: S.isTestSession() })
        toast('网络异常，已存在本地，稍后自动同步', 'err')
      }
    }
  })
}

/* ═════════════════════════ 词库 ═════════════════════════ */

let libFilter = { q: '', deck: '', view: 'list', limit: 200 }
const LAST_IMPORT_KEY = 'lexiloop.lastimport.v1'

/** 上次导入的跳过明细（24 小时内才提示，避免一直挂在页面上） */
function lastImport() {
  try {
    const raw = localStorage.getItem(LAST_IMPORT_KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o || !o.lines || !o.lines.length) return null
    if (Date.now() - Number(o.at || 0) > 24 * 3600 * 1000) return null
    return o
  } catch (e) {
    return null
  }
}

function lastImportCard() {
  const r = lastImport()
  if (!r) return ''
  return '<div class="card tight" style="margin-bottom:12px;">' +
    '<div class="row between" style="gap:10px;">' +
    '<div class="grow"><div style="font-size:14px;font-weight:500;">上次导入跳过了 ' +
    r.lines.length + ' 行</div>' +
    '<div class="tiny">导入 ' + (r.kept || 0) + ' 个词条　｜　看看哪些行没被收进来</div></div>' +
    '<button class="btn sm" id="lib-skips-dl">下载明细</button>' +
    '<button class="btn sm ghost" id="lib-skips-hide">忽略</button>' +
    '</div></div>'
}
let importedFromFile = null   // 文件导入（csv/tsv）解析出的词条，优先于文本框解析

/** 导入示例：结构化 md 与 csv 各一份，覆盖最常见的两种用法 */
const SAMPLE_WORD_MD = [
  '# 07. 邮件表达',
  '',
  '## copy sb. on an email',
  '**抄送某人**',
  '> We have copied the security office on this email.',
  '> 我们已在这封邮件里抄送保卫处。',
  '',
  '## escalate the issue',
  '**把问题升级上报**',
  '> I will escalate the issue to the duty manager.',
  '> 我会把问题升级上报给值班经理。',
].join('\n')

const SAMPLE_WORD_CSV = [
  'word,释义',
  'access control,门禁管制',
  'lost and found,失物招领',
  'campus patrol,校园巡逻',
  'work order,工单',
].join('\n')

/**
 * 按「词」聚合，而不是按「卡」。
 * 同一个词可能有 recognition / cloze / production 多张卡，按卡列会看起来像重复了。
 */
function libraryGroups() {
  const q = libFilter.q.toLowerCase()
  const byWord = new Map()

  S.state.cards.forEach((c) => {
    if (libFilter.deck && c.deck !== libFilter.deck) return
    const w = S.wordOf(c)
    if (!w) return
    if (q && String(w.normalized).indexOf(q) < 0 && String(w.lemma || '').toLowerCase().indexOf(q) < 0) return
    if (!byWord.has(c.word_id)) byWord.set(c.word_id, { word: w, cards: [] })
    byWord.get(c.word_id).cards.push(c)
  })

  return Array.from(byWord.values()).sort((a, b) =>
    String(a.word.lemma || a.word.normalized).localeCompare(String(b.word.lemma || b.word.normalized))
  )
}

function statusChip(cards) {
  if (cards.every((c) => c.suspended)) return '<span class="chip weak">已暂停</span>'
  const mastered = cards.filter(FSRS.isMastered).length
  if (mastered === cards.length) return '<span class="chip strong">记忆稳定</span>'
  if (cards.every((c) => c.status === 'new')) return '<span class="chip">未学</span>'
  return '<span class="chip">学习中 ' + mastered + '/' + cards.length + '</span>'
}

/** 只渲染列表部分，便于搜索时局部更新（避免输入框失焦） */
function libraryListHTML() {
  const groups = libraryGroups()

  if (!groups.length) {
    // 加载中/失败时不能显示"词库还是空的"—— 那句话会把人推去重新导入
    const ph = dataStateCard({ loadingText: '正在取回你的词表…' })
    if (ph) return ph
    return '<div class="empty"><div class="big">' + (S.state.cards.length ? '没有匹配的词条' : '词库还是空的') + '</div>' +
      '<p class="tiny">' + (S.state.cards.length ? '换个关键词试试' : '点上面的「导入词条」开始') + '</p></div>'
  }

  const total = groups.length
  const limit = Math.max(50, Number(libFilter.limit) || 200)
  const shown = groups.slice(0, limit)
  const rows = '<div class="list">' + shown.map((g) => {
    const p = g.word.payload || {}
    const first = (p.senses && p.senses[0] && p.senses[0].def_zh) || ''
    const typeNote = g.cards.length > 1 ? '<span class="chip">' + g.cards.length + ' 种卡片</span>' : ''
    return '<div class="list-item" data-word="' + g.word.id + '" style="cursor:pointer;">' +
      '<div class="grow"><div class="t">' + esc(g.word.lemma || g.word.normalized) + '</div>' +
      '<div class="d">' + esc(first.slice(0, 34)) + (first.length > 34 ? '…' : '') + '</div></div>' +
      typeNote + statusChip(g.cards) + '</div>'
  }).join('') + '</div>'
  // 词库上千条时一次性渲染会明显卡顿，这里分批显示
  const info = total > 200
    ? '<p class="tiny" style="margin:0 0 8px;">共 ' + total + ' 个词条　｜　已显示 ' + shown.length + ' 个</p>'
    : ''
  const more = total > shown.length
    ? '<div class="row" style="justify-content:center;margin-top:10px;">' +
      '<button class="btn sm soft" id="lib-more">显示更多（还有 ' + (total - shown.length) + ' 个）</button></div>'
    : ''
  return info + rows + more
}

function bindLibItems(onChanged) {
  $$('[data-word]').forEach((el) => {
    el.onclick = () => {
      const wid = Number(el.dataset.word)
      const g = libraryGroups().find((x) => x.word.id === wid)
      if (g) openWordDetail(g, onChanged)
    }
  })
}

function renderBatches() {
  const batches = S.listBatches()
  if (!batches.length) return ''
  return (
    '<div class="card">' +
    '<div class="card-head"><h2>导入记录</h2><span class="hint">可以只删掉某一次导入</span></div>' +
    batches.map((b) =>
      '<div class="row between" style="padding:9px 0;border-bottom:1px dashed var(--line);gap:10px;">' +
      '<div class="grow"><div style="font-size:13.5px;font-weight:500;">' + esc(b.label) + '</div>' +
      '<div class="tiny">' + esc(b.decks || '—') + '　' + b.words + ' 个词条　' + b.cards + ' 张卡</div></div>' +
      '<button class="btn sm danger" data-batch="' + esc(b.batch) + '">删除</button>' +
      '</div>'
    ).join('') +
    '</div>'
  )
}

/** 掌握度分级：给词库地图着色用 */
export function masteryLevel(card) {
  if (!card) return 'unknown'
  if (card.suspended) return 'suspended'
  if (Number(card.lapses) >= 4) return 'leech'
  if (Number(card.stability) > 0 && FSRS.isMastered(card)) return 'mature'
  if (card.status !== 'new') return 'learning'
  return 'new'
}

const groupsCache = new Map()

const MASTERY_META = {
  new: { label: '未学', color: 'var(--line)' },
  learning: { label: '学习中', color: 'var(--warn)' },
  mature: { label: '记忆稳定', color: 'var(--ok)' },
  leech: { label: '易忘', color: 'var(--bad)' },
  suspended: { label: '已暂停', color: 'var(--ink-3)' },
  unknown: { label: '无卡', color: 'var(--surface-2)' },
}

/** 掌握度地图：按场景（文档章节）分组，每个词一个小方块 */
function renderMasteryMap() {
  // 一词一条卡类型，取"最好的那张"代表掌握度
  const byWord = new Map()
  S.state.cards.forEach((c) => {
    const prev = byWord.get(c.word_id)
    const order = ['mature', 'learning', 'new', 'leech', 'suspended', 'unknown']
    if (!prev || order.indexOf(masteryLevel(c)) < order.indexOf(masteryLevel(prev))) byWord.set(c.word_id, c)
  })
  const groups = new Map()
  S.state.cards.forEach((c) => {
    const w = S.wordOf(c)
    if (!w) return
    if (byWord.get(c.word_id) !== c && groups.has(String((w.payload || {}).topic || ''))) {
      // 已经被更好的那张代表过，但分组信息照记
    }
    const topic = String((w.payload || {}).topic || '').trim() || (c.deck ? String(c.deck) : '未分类')
    if (!groups.has(topic)) groups.set(topic, new Map())
    if (!groups.get(topic).has(w.id)) groups.get(topic).set(w.id, { w, card: byWord.get(w.id) || c })
  })

  groupsCache.clear()
  groups.forEach((map) => { map.forEach((x, wid) => groupsCache.set(String(wid), { word: x.w, cards: [x.card] })) })

  const order = ['new', 'learning', 'mature', 'leech', 'suspended', 'unknown']
  const legend = order.map((k) =>
    '<span class="lg"><i style="background:' + MASTERY_META[k].color + ';"></i>' + MASTERY_META[k].label + '</span>'
  ).join('')

  const CAP = 240
  const sections = Array.from(groups.entries()).sort((a, b) => b[1].size - a[1].size).slice(0, 20).map(([topic, map]) => {
    const items = Array.from(map.values())
    const counts = {}
    items.forEach((x) => { const lv = masteryLevel(x.card); counts[lv] = (counts[lv] || 0) + 1 })
    const weak = (counts.leech || 0) + (counts.new || 0) + (counts.learning || 0)
    const cells = items.slice(0, CAP).map((x) => {
      const lv = masteryLevel(x.card)
      return '<button class="mm-cell" data-wid="' + x.card.word_id + '" title="' +
        esc(x.w.lemma || x.w.normalized) + '　' + MASTERY_META[lv].label + '"' +
        ' style="background:' + MASTERY_META[lv].color + ';"></button>'
    }).join('')
    // 方块太多也会拖慢渲染，超出部分折叠（用搜索/词单缩小范围即可看到）
    const folded = items.length > CAP
      ? '<p class="tiny" style="margin:6px 0 0;">还有 ' + (items.length - CAP) + ' 个词未显示</p>'
      : ''
    return '<div class="card">' +
      '<div class="row between" style="margin-bottom:8px;">' +
      '<div class="grow"><div style="font-size:14px;font-weight:600;">' + esc(topic) + '</div>' +
      '<div class="tiny">' + items.length + ' 个词　｜　待加强 ' + weak + '</div></div>' +
      '</div>' +
      '<div class="mm-grid">' + cells + '</div>' + folded + '</div>'
  }).join('')

  return '<div class="legend">' + legend + '</div>' +
    '<p class="tiny" style="margin:8px 0 12px;">每个方块是一个词，颜色越暖越薄弱。' +
    '点方块可直接查看该词。章节来自你导入文档的结构。</p>' + sections
}

export function renderLibrary() {
  const decks = Array.from(new Set(S.state.cards.map((c) => c.deck).filter(Boolean)))
  const pending = S.state.words.filter(needsEnrich).length
  const wordCount = new Set(S.state.cards.map((c) => c.word_id)).size

  if (libFilter.view === 'map') {
    return '<h1 class="page">词库<span class="sub">掌握度地图　｜　共 ' + wordCount +
      ' 个词条（' + S.state.cards.length + ' 张卡）</span></h1>' +
      '<div class="seg" style="margin-bottom:12px;">' +
      '<button data-libview="list" class="off">列表</button>' +
      '<button data-libview="map" class="on">掌握度地图</button></div>' +
      // 地图视图下同样要有导入/导出入口，否则切到地图就没法导了
      '<div class="btn-group" style="margin-bottom:12px;">' +
      '<button class="btn primary" id="lib-import">' + icon('plus', 18) + ' 导入词条</button>' +
      '<button class="btn" id="lib-enrich">补充释义</button>' +
      '</div>' +
      (pending
        ? '<div class="card tight" style="background:var(--warn-soft);border-color:transparent;">' +
          '<div class="tiny">' + pending + ' 个词条还没有搭配释义</div></div>'
        : '') +
      renderMasteryMap()
  }

  return (
    '<h1 class="page">词库<span class="sub">共 ' + wordCount + ' 个词条（' +
    S.state.cards.length + ' 张卡）　｜　' + decks.length + ' 个词单</span></h1>' +

    '<div class="seg" style="margin-bottom:12px;">' +
    '<button data-libview="list" class="on">列表</button>' +
    '<button data-libview="map">掌握度地图</button></div>' +

    (pending
      ? '<div class="card tight" style="background:var(--warn-soft);border-color:transparent;">' +
        '<div class="row between" style="gap:10px;">' +
        '<div class="grow"><div style="font-size:14px;font-weight:500;">' + pending + ' 个词条还没有搭配释义</div>' +
        '<div class="tiny">生成后学习时才有地道搭配和例句可看</div></div>' +
        '<button class="btn sm" id="lib-enrich-banner">生成</button>' +
        '</div></div>'
      : '') +

    lastImportCard() +

    '<div class="btn-group" style="margin-bottom:12px;">' +
    '<button class="btn primary" id="lib-import">' + icon('plus', 18) + ' 导入词条</button>' +
    '<button class="btn" id="lib-enrich">补充释义</button>' +
    '</div>' +

    '<div class="field"><input class="input" id="lib-q" placeholder="搜索单词或词组…" value="' + esc(libFilter.q) + '"></div>' +

    (decks.length > 1
      ? '<div class="btn-group" style="margin-bottom:12px;">' +
        '<button class="btn sm ' + (libFilter.deck ? '' : 'soft') + '" data-deck="">全部</button>' +
        decks.map((d) => '<button class="btn sm ' + (libFilter.deck === d ? 'soft' : '') + '" data-deck="' + esc(d) + '">' +
          esc(d) + '</button>').join('') +
        '</div>'
      : '') +

    (libFilter.deck
      ? '<div class="btn-group" style="margin-bottom:12px;">' +
        '<button class="btn sm danger" id="lib-deldeck">删除词单「' + esc(libFilter.deck) + '」</button>' +
        '</div>'
      : '') +
    '<div id="lib-list">' + libraryListHTML() + '</div>' +
    renderBatches()
  )
}

export function bindLibrary(onChanged) {
  const more = $('#lib-more')
  if (more) more.onclick = () => {
    libFilter.limit = (Number(libFilter.limit) || 200) + 200
    onChanged()
  }

  const skipsDl = $('#lib-skips-dl')
  if (skipsDl) skipsDl.onclick = () => {
    const r = lastImport()
    if (!r) return
    const lines = ['行内容\t跳过原因']
      .concat(r.lines.map((x) => String(x.line || '').replace(/\t/g, ' ') + '\t' + String(x.reason || '')))
    EXP.downloadText(lines.join('\n'), EXP.stampName('导入跳过明细', 'tsv'), 'text/tab-separated-values')
    ok('已下载跳过明细')
  }
  const skipsHide = $('#lib-skips-hide')
  if (skipsHide) skipsHide.onclick = () => {
    try { localStorage.removeItem(LAST_IMPORT_KEY) } catch (e) { /* ignore */ }
    onChanged()
  }
  $$('[data-libview]').forEach((b) => {
    b.onclick = () => { libFilter.view = b.dataset.libview; onChanged() }
  })
  $$('.mm-cell').forEach((b) => {
    b.onclick = () => {
      const wid = String(b.dataset.wid)
      const group = groupsCache.get(wid)
      if (group) openWordDetail(group, onChanged)
    }
  })

  const imp = $('#lib-import')
  if (imp) imp.onclick = () => openImport(onChanged)
  const enr = $('#lib-enrich')
  if (enr) enr.onclick = () => openEnrich(onChanged)
  const enrBanner = $('#lib-enrich-banner')
  if (enrBanner) enrBanner.onclick = () => openEnrich(onChanged)

  const q = $('#lib-q')
  if (q) {
    let t = null
    q.oninput = () => {
      clearTimeout(t)
      t = setTimeout(() => {
        libFilter.q = q.value.trim()
        libFilter.limit = 200
        const box = $('#lib-list')
        if (box) {
          box.innerHTML = libraryListHTML()
          bindLibItems(onChanged)
        }
      }, 180)
    }
  }

  $$('[data-deck]').forEach((b) => {
    b.onclick = () => { libFilter.deck = b.dataset.deck; libFilter.limit = 200; onChanged(true) }
  })

  const delDeck = $('#lib-deldeck')
  if (delDeck) {
    delDeck.onclick = async () => {
      const deck = libFilter.deck
      const inDeck = S.state.cards.filter((c) => c.deck === deck)
      const words = new Set(inDeck.map((c) => c.word_id)).size
      if (!(await confirmDialog({
        title: '删除词单「' + deck + '」？',
        sub: '会删除 ' + words + ' 个词条的 ' + inDeck.length + ' 张卡片，以及它们的学习进度和复习记录',
        body: '<p class="muted">不可撤销。但共享词库里的搭配释义不会被删除——' +
          '以后重新导入这些词，仍然可以直接复用，不会重新消耗生成时间。</p>',
        okText: '删除', danger: true,
      }))) return
      delDeck.disabled = true
      try {
        const n = await S.deleteCardsByDeck(deck)
        libFilter.deck = ''
        S.saveLocal()
        onChanged(true)
        ok('已删除 ' + n + ' 张卡片')
      } catch (e) {
        delDeck.disabled = false
        fail('删除失败：' + ((e && e.message) || ''))
      }
    }
  }

  $$('[data-batch]').forEach((b) => {
    b.onclick = async () => {
      const batch = b.dataset.batch
      const info = S.listBatches().find((x) => x.batch === batch)
      if (!(await confirmDialog({
        title: '删除这次导入？',
        sub: info ? info.label + '　' + info.words + ' 个词条 / ' + info.cards + ' 张卡' : '该批次的卡片',
        body: '<p class="muted">不可撤销。其它导入不受影响；共享词库里的释义也不会被删，' +
          '以后重新导入这些词仍可直接复用。</p>',
        okText: '删除', danger: true,
      }))) return
      b.disabled = true
      try {
        const removed = await S.deleteCardsByBatch(batch)
        onChanged(true)
        ok('已删除 ' + removed + ' 张卡片')
      } catch (e) {
        b.disabled = false
        fail('删除失败：' + ((e && e.message) || ''))
      }
    }
  })

  bindLibItems(onChanged)
}

/**
 * 文本解码：先按 UTF-8 严格解，解不了（或替换字符过多）再退 GBK / Big5。
 * 国内常见的词表文件多是 Excel 另存出来的 GBK，按 UTF-8 硬解会整篇乱码且无提示。
 * @param {ArrayBuffer} buf
 * @returns {{text:string, enc:string}}
 */
export function decodeText(buf) {
  const bytes = new Uint8Array(buf || new ArrayBuffer(0))
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), enc: 'utf-8' }
  }
  try {
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text: strict, enc: 'utf-8' }
  } catch (e) { /* 不是合法 UTF-8，走下面的中文编码 */ }

  for (const enc of ['gbk', 'gb18030', 'big5']) {
    try {
      const t = new TextDecoder(enc).decode(bytes)
      if (t && (t.match(/\uFFFD/g) || []).length < t.length * 0.01) return { text: t, enc }
    } catch (e) { /* 浏览器不支持该编码 */ }
  }
  return { text: new TextDecoder('utf-8').decode(bytes), enc: 'utf-8' }
}

/** 导入弹层：粘贴文本 → 富化 → 建卡 */
function openImport(onChanged) {
  const decks = Array.from(new Set(S.state.cards.map((c) => c.deck).filter(Boolean)))
  const m = openModal(
    '<h3>导入词条</h3>' +
    '<p class="sub">每行一个单词或词组。支持「word 释义」或「word, 释义」，会用第一个字段。</p>' +
    '<div class="field"><label for="im-deck">词单名称</label>' +
    '<input class="input" id="im-deck" list="deck-list" value="' + esc(decks[0] || '默认词单') + '" placeholder="例如：校园安全英语">' +
    '<datalist id="deck-list">' + decks.map((d) => '<option value="' + esc(d) + '">').join('') + '</datalist>' +
    '</div>' +
    '<div class="field"><label for="im-text">词条（每行一个，也支持直接粘贴 Markdown）</label>' +
    '<textarea class="input" id="im-text" placeholder="commit&#10;access control&#10;in case of emergency&#10;&#10;也可以直接粘贴 Markdown：&#10;## evacuate&#10;- **premises** /ˈpremɪsɪz/ n. 建筑及用地&#10;| perimeter | 外围边界 |"></textarea>' +
    '<div id="im-preview" class="tiny" style="margin-top:6px;min-height:18px;"></div></div>' +
    '<div class="field"><label for="im-file">或直接选文件</label>' +
    '<input type="file" id="im-file" class="input" accept=".md,.markdown,.txt,.csv,.tsv,.docx,text/plain">' +
    '<p class="tiny" style="margin:4px 0 0;">md / txt / <b>docx</b> 按上面的规则解析（docx 会先提取纯文本）；' +
    'csv / tsv 取<b>第一列单词、第二列释义</b>（首行是表头会自动跳过）。</p>' +
    '<button class="btn sm ghost" id="im-sample" type="button" style="margin-top:6px;">下载示例文件（md + csv）</button></div>' +
    '<div class="field"><label for="im-max">最多几个词（超过就当成句子，不导入）</label>' +
    '<input class="input" type="number" min="1" max="15" id="im-maxwords" value="' + DEFAULT_MAX_WORDS + '">' +
    '<p class="tiny" style="margin:4px 0 0;">整份学习文档里最容易被误收的是例句，用词数挡住它们。' +
    '如果你确实要导入长表达，把它调大。</p></div>' +
    '<div class="field"><label>生成哪些卡片</label></div>' +
    Object.keys(CARD_TYPES).map((k) => {
      const t = CARD_TYPES[k]
      const on = (S.state.settings.card_types || ['recognition']).indexOf(k) >= 0
      return '<label class="check"><input type="checkbox" data-ct="' + k + '"' + (on ? ' checked' : '') + '>' +
        '<span><span class="t">' + esc(t.label) + '</span><span class="d">' + esc(t.desc) +
        (k !== 'recognition' ? '（间隔会相应拉长）' : '') + '</span></span></label>'
    }).join('') +
    '<div class="field" style="margin-top:12px;">' +
    '<label class="check"><input type="checkbox" id="im-enrich" checked>' +
    '<span><span class="t">用 AI 生成地道搭配和例句</span>' +
    '<span class="d">不勾选则只建卡，稍后在词库里点「补充释义」</span></span></label></div>' +
    '<div class="progress" style="margin-top:6px;"><i id="im-bar" style="width:0%"></i></div>' +
    '<div id="im-progress" class="tiny" style="min-height:18px;margin-top:6px;"></div>' +
    '<div class="modal-actions"><button class="btn" id="im-cancel">取消</button>' +
    '<button class="btn primary" id="im-go">开始导入</button></div>'
  )

  $('#im-cancel').onclick = closeModal

  // 示例文件：新用户照着格式来，第一次导入就能成功
  const sampleBtn = $('#im-sample')
  if (sampleBtn) sampleBtn.onclick = () => {
    EXP.downloadText(SAMPLE_WORD_MD, EXP.stampName('LexiLoop示例词单', 'md'))
    setTimeout(() => {
      EXP.downloadText(SAMPLE_WORD_CSV, EXP.stampName('LexiLoop示例词单', 'csv'), 'text/csv')
      ok('已下载 md / csv 两个示例')
    }, 600)
  }

  // 边粘贴边告诉你识别到了什么，避免导入后才发现解析错了
  const ta = $('#im-text')
  const prev = $('#im-preview')
  const maxInput = $('#im-maxwords')
  const readLimit = () => {
    const v = maxInput ? Number(maxInput.value) : DEFAULT_MAX_WORDS
    return v >= 1 && v <= 15 ? v : DEFAULT_MAX_WORDS
  }
  let prevTimer = null
  const refreshPreview = () => {
    const r = parseImport(ta.value, { maxWords: readLimit() })
    if (!ta.value.trim()) {
      prev.innerHTML = '<span style="color:var(--ink-3);">还没有内容 —— 粘贴词条，或点上面的「选文件」' +
        '（支持 md / txt / csv / tsv / docx）</span>'
      return
    }
    const bits = []
    if (r.mode === 'structured') {
      bits.push('识别为结构化文档')
      bits.push('词条 ' + r.terms.length + ' 个')
      if (r.stats.withMeaning) bits.push('自带中文释义 ' + r.stats.withMeaning + ' 个')
      if (r.stats.duplicates) bits.push('去重 ' + r.stats.duplicates + ' 个')
      if (r.stats.skipped) bits.push('跳过 ' + r.stats.skipped + ' 条')
      const enrichOn = $('#im-enrich') && $('#im-enrich').checked
      if (enrichOn && r.terms.length) {
        // 实测 DeepSeek-V4.1-Flash 约 4 秒/词，这里按 8 秒保守估
        bits.push('AI 补搭配约需 ' + Math.max(1, Math.round((r.terms.length * 8) / ENRICH_CONCURRENCY / 60)) + ' 分钟')
      }
    } else {
      bits.push('识别到 ' + r.terms.length + ' 个词条')
      if (r.stats.duplicates) bits.push('去重 ' + r.stats.duplicates + ' 个')
      if (r.stats.tooLong) bits.push('跳过 ' + r.stats.tooLong + ' 行（超过 ' + readLimit() + ' 个词，疑似句子）')
      const other = r.stats.skipped - r.stats.tooLong
      if (other) bits.push('跳过 ' + other + ' 行（非词条内容）')
    }
    if (r.terms.length) bits.push('前几个：' + r.terms.slice(0, 5).join('、'))
    prev.innerHTML = esc(bits.join('　｜　'))
    prev.style.color = r.terms.length ? 'var(--ink-2)' : 'var(--warn)'
  }
  ta.oninput = () => {
    clearTimeout(prevTimer)
    prevTimer = setTimeout(refreshPreview, 200)
  }
  ta.onpaste = () => setTimeout(refreshPreview, 0)
  if (maxInput) maxInput.oninput = () => {
    clearTimeout(prevTimer)
    prevTimer = setTimeout(refreshPreview, 200)
  }
  const enrichBox = $('#im-enrich')
  if (enrichBox) enrichBox.onchange = refreshPreview

  // ── 文件导入：md/txt 直接进文本框；csv/tsv 解析成「词条+释义」 ──
  const parseDelimited = (text, sep) => {
    const rows = []
    let row = [], cell = '', inQ = false
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++ } else inQ = false
        } else cell += ch
      } else if (ch === '"') inQ = true
      else if (ch === sep) { row.push(cell); cell = '' }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
      else if (ch !== '\r') cell += ch
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
    return rows
      .map((r) => ({ term: stripCsvCell(r[0]), meaning: stripCsvCell(r[1] || '') }))
      .filter((r) => r.term)
  }
  const stripCsvCell = (s) => String(s || '').replace(/^\s*#/, '').trim()

  const fileInput = $('#im-file')
  if (fileInput) {
    const loadMammoth = () => {
      if (window.mammoth) return Promise.resolve(window.mammoth)
      return new Promise((resolve, reject) => {
        const sc = document.createElement('script')
        sc.src = MAMMOTH_CDN
        sc.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error('组件加载异常')))
        sc.onerror = () => reject(new Error('无法加载 Word 解析组件（请检查网络）'))
        document.head.appendChild(sc)
      })
    }

    const useText = (text, label) => {
      importedFromFile = null
      ta.value = text
      refreshPreview()
      ok(label)
    }

    const useCsv = (text, name) => {
      const sep = /\.tsv$/.test(name) ? '\t' : ','
      let rows = parseDelimited(text, sep)
      if (rows.length && /^(word|term|词条|单词|expression|phrase)$/i.test(rows[0].term)) rows = rows.slice(1)
      const entries = rows
        .map((r) => ({ term: r.term.toLowerCase(), meaning: r.meaning, examples: [], section: '' }))
        .filter((e) => e.term)
      if (!entries.length) return fail('文件里没有解析到词条（第一列应为英文）')
      importedFromFile = entries
      ta.value = entries.map((e) => e.term + (e.meaning ? '　' + e.meaning : '')).join('\n')
      refreshPreview()
      ok('已解析 ' + entries.length + ' 行，释义会一并导入')
    }

    const handleDocx = (ab, name) => {
      loadMammoth()
        .then((m) => m.extractRawText({ arrayBuffer: ab }))
        .then((res) => useText(String((res && res.value) || ''), '已从 Word 提取文本（' + String((res && res.value) || '').length + ' 字符）'))
        .catch((e) => fail('Word 解析失败：' + ((e && e.message) || '需要联网加载解析组件')))
    }

    fileInput.onchange = () => {
      const f = fileInput.files && fileInput.files[0]
      if (!f) return
      const name = (f.name || '').toLowerCase()
      if (/\.docx$/.test(name)) {
        const br = new FileReader()
        br.onerror = () => fail('文件读取失败')
        br.onload = () => handleDocx(br.result, name)
        br.readAsArrayBuffer(f)
        return
      }
      const reader = new FileReader()
      reader.onerror = () => fail('文件读取失败')
      reader.onload = () => {
        const d = decodeText(reader.result)
        const text = d.text
        if (/\.csv$/.test(name) || /\.tsv$/.test(name)) useCsv(text, name)
        else useText(text, '已载入 ' + f.name + (d.enc === 'utf-8' ? '' : '（按 ' + d.enc.toUpperCase() + ' 解码）'))
      }
      reader.readAsArrayBuffer(f)
    }
  }

  $('#im-go').onclick = async () => {
    const parsed = importedFromFile
      ? {
          terms: importedFromFile.map((e) => e.term),
          entries: importedFromFile,
          mode: 'file',
          stats: { total: importedFromFile.length, kept: importedFromFile.length,
                   skipped: 0, duplicates: 0, tooLong: 0,
                   withMeaning: importedFromFile.filter((e) => e.meaning).length },
        }
      : parseImport($('#im-text').value, { maxWords: readLimit() })
    const terms = parsed.terms
    if (!terms.length) {
      return fail('没有识别到有效词条，请检查内容是否为英文单词或词组')
    }
    const deck = $('#im-deck').value.trim() || '默认词单'
    const types = $$('[data-ct]').filter((x) => x.checked).map((x) => x.dataset.ct)
    if (!types.length) return fail('至少选择一种卡片类型')
    const doEnrich = $('#im-enrich').checked

    S.state.settings.deck = deck
    S.state.settings.card_types = types
    S.saveLocal()
    S.pushSettings().catch(() => {})

    const btn = $('#im-go')
    const prog = $('#im-progress')
    const bar = $('#im-bar')
    btn.disabled = true
    btn.textContent = '导入中…'

    try {
      // 导入只做三件快事：查重、建词条、建卡片。搭配生成交给后台任务。
      const known = await S.findWords(terms)
      const todo = terms.filter((t) => !known.has(t))
      const reused = terms.length - todo.length
      const entryByTerm = new Map()
      parsed.entries.forEach((e) => { if (e.term) entryByTerm.set(e.term, e) })

      const batch = S.newBatchId()
      const wordIds = new Map()
      known.forEach((row, term) => wordIds.set(term, row.id))

      let wi = 0
      let seeded = 0
      for (const term of todo) {
        wi++
        if (bar) bar.style.width = Math.round((wi / Math.max(1, todo.length)) * 100) + '%'
        prog.textContent = '建立词条 ' + wi + '/' + todo.length + '：' + term
        const e = entryByTerm.get(term)
        const seed = { lemma: term, prompt_version: null }
        if (e && e.meaning) {
          seed.senses = [{ pos: '', def_en: '', def_zh: e.meaning }]
          seed.prompt_version = 'doc-v1'
          seeded++
        }
        if (e && e.examples && e.examples.length) seed.source_examples = e.examples
        if (e && e.section) seed.topic = e.section
        const row = await S.putWord(term, term, seed)
        wordIds.set(term, row.id)
      }

      // 词条若已在共享缓存里但还没有释义，把你文档里的释义补进去（不覆盖已有的）
      // 「**背诵逻辑：**」这类版式标签曾误存为释义，这里也一并视为「没有释义」以便自愈
      // 注意：已存在的词条要走 known（findWords 的结果），state.words 里不一定有它们
      const wordOf = (t) => S.state.words.find((x) => x.normalized === t) || known.get(t)
      const hasRealSense = (w) => {
        const senses = (w.payload || {}).senses || []
        if (!senses.length) return false
        return !/[：:]$/.test(String(senses[0].def_zh || ''))
      }
      const fillers = terms.filter((t) => {
        const e = entryByTerm.get(t)
        if (!e || !e.meaning) return false
        const w = wordOf(t)
        return w && !hasRealSense(w)
      })
      if (fillers.length) {
        let fi = 0
        for (const term of fillers) {
          fi++
          prog.textContent = '补充释义 ' + fi + '/' + fillers.length + '：' + term
          const w = wordOf(term)
          const e = entryByTerm.get(term)
          const merged = Object.assign({}, w.payload || {}, {
            senses: [{ pos: '', def_en: '', def_zh: e.meaning }],
            source_examples: e.examples || [],
            topic: e.section || (w.payload || {}).topic || '',
            prompt_version: 'doc-v1',
          })
          const saved = await S.putWord(term, w.lemma || term, merged)
          wordIds.set(term, saved.id)
          seeded++
        }
      }

      prog.textContent = '建立卡片…'
      const rows = []
      terms.forEach((term) => {
        const wid = wordIds.get(term)
        if (!wid) return
        types.forEach((t) => {
          rows.push({
            word_id: wid, deck, card_type: t, batch,
            status: 'new', due: new Date().toISOString(),
          })
        })
      })
      const created = await S.createCards(rows)

      closeModal()
      await S.syncPull()
      onChanged(true)

      let msg = '已导入 ' + terms.length + ' 个词条，新建 ' + created.length + ' 张卡片'
      if (reused) msg += '，复用已有词条 ' + reused + ' 个'
      if (seeded) msg += '，从文档带入释义 ' + seeded + ' 个'
      if (parsed.stats.skipped) msg += '，跳过 ' + parsed.stats.skipped + ' 条'
      ok(msg)

      // 跳过明细存下来：只报"跳过 N 条"用户没法自查，词库页提供下载
      if (parsed.stats.skipped) {
        try {
          localStorage.setItem(LAST_IMPORT_KEY, JSON.stringify({
            at: Date.now(),
            deck,
            kept: terms.length,
            mode: parsed.mode || 'flat',
            lines: skippedLines($('#im-text') ? $('#im-text').value : '', { maxWords: readLimit() })
              .slice(0, 500),
          }))
        } catch (e) { /* 配额满就算了，不影响导入结果 */ }
      }

      // 需要搭配的词条排入后台队列（已有释义的、以及本次不生成的，都不排队）
      const needGen = terms.filter((t) => {
        const w = wordOf(t)
        return needsEnrich(w)
      })
      if (needGen.length) {
        queueGeneration(needGen)
        if (doEnrich) {
          startJob(onChanged)
          toast('开始生成 ' + needGen.length + ' 个词条的搭配，可离开本页', 'ok')
        }
        onChanged(true)   // 立刻让顶部进度横幅出现
      }
    } catch (e) {
      fail((e && e.message) || '导入失败')
      btn.disabled = false
      btn.textContent = '开始导入'
    }
  }
}

/** 给缺释义的词条排队生成 */
function openEnrich(onChanged) {
  const missing = S.state.words.filter(needsEnrich)
  if (!missing.length) return ok('所有词条都已有搭配释义')
  confirmDialog({
    title: '生成搭配释义',
    sub: '有 ' + missing.length + ' 个词条还没有搭配释义',
    body: '<p class="muted">生成在后台进行，可随时离开本页继续学习，也可以暂停。' +
      '云端模型较慢，每个词条约需 1–3 分钟，已生成的词条会被永久缓存，不会重复消耗。</p>',
    okText: '开始生成',
  }).then((yes) => {
    if (!yes) return
    queueGeneration(missing.map((w) => w.normalized))
    startJob(onChanged)
    onChanged(true)
    ok('已加入后台队列，共 ' + missing.length + ' 个')
  })
}

export function reviewReportHTML(word) {
  const report = parseReviewReport(word.verify_note)
  if (!report) return word.verify_note ? '<p class="tiny">复核意见：' + esc(word.verify_note) + '</p>' : ''
  return '<section class="card tight content-review-report" id="word-review-report"><h3>内容复核报告</h3>' +
    '<p class="tiny">' + esc(report.source === 'rules' ? '结构规则检查' : '模型复核') + ' · ' + esc(fmtDateCN(report.at)) +
    ' · ' + esc(report.severity === 'blocking' ? '需要修正' : report.severity === 'advisory' ? '有改进建议' : '未发现问题') + '</p>' +
    '<p>' + esc(report.reason || '') + '</p>' +
    (report.issues.length ? '<ul>' + report.issues.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    (report.suggestions.length ? '<h4>建议（确认前不改原文）</h4><ul>' + report.suggestions.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    '<p class="tiny">' + esc(report.reference || '模型复核不能代替权威词典核验。') + '</p></section>'
}

function openWordCorrection(word, onChanged, draft, draftSource) {
  const baseline = JSON.parse(JSON.stringify(word))
  const payload = JSON.parse(JSON.stringify(draft || word.payload || {}))
  if (!Array.isArray(payload.senses) || !payload.senses.length) payload.senses = [{ pos: '', def_zh: '', def_en: '' }]
  const fields = []
  const add = (path, label) => fields.push({ path, label, before: path.reduce((o, key) => o && o[key], baseline.payload || {}) || '', value: path.reduce((o, key) => o && o[key], payload) || '' })
  payload.senses.forEach((s, i) => { add(['senses', i, 'pos'], '释义 ' + (i + 1) + ' · 词性'); add(['senses', i, 'def_zh'], '释义 ' + (i + 1) + ' · 中文'); add(['senses', i, 'def_en'], '释义 ' + (i + 1) + ' · 英文') })
  ;(payload.collocations || []).forEach((c, i) => {
    add(['collocations', i, 'pattern'], '搭配 ' + (i + 1)); add(['collocations', i, 'zh'], '搭配 ' + (i + 1) + ' · 中文'); add(['collocations', i, 'type'], '搭配 ' + (i + 1) + ' · 类型')
    ;(c.examples || []).forEach((e, j) => { add(['collocations', i, 'examples', j, 'en'], '搭配 ' + (i + 1) + ' · 例句 ' + (j + 1)); add(['collocations', i, 'examples', j, 'zh'], '搭配 ' + (i + 1) + ' · 译文 ' + (j + 1)) })
  })
  ;(payload.source_examples || []).forEach((e, i) => { add(['source_examples', i, 'en'], '原始例句 ' + (i + 1)); add(['source_examples', i, 'zh'], '原始译文 ' + (i + 1)) })
  openModal('<h3>核对并修正：' + esc(word.lemma || word.normalized) + '</h3>' +
    '<p class="tiny">先对照词典或原始语料核实。修改的是共享词条内容；保存前展示差异，卡片学习进度保留。</p>' + reviewReportHTML(word) +
    fields.map((f, i) => '<div class="field"><label for="word-fix-' + i + '">' + esc(f.label) + '</label><textarea class="input" id="word-fix-' + i + '">' + esc(f.value) + '</textarea></div>').join('') +
    '<div class="field"><label for="word-fix-source">核实来源（词典链接或原始语料说明）</label><input class="input" id="word-fix-source" value="' + esc(draftSource || payload.correction_source || '') + '"></div>' +
    '<div class="modal-actions"><button class="btn primary" id="word-fix-preview">查看差异并保存</button></div>')
  $('#word-fix-preview').onclick = async () => {
    const source = String($('#word-fix-source').value || '').trim()
    if (!source) return fail('请填写核实来源')
    const changes = []
    fields.forEach((f, i) => {
      const value = String($('#word-fix-' + i).value || '').trim()
      if (value !== String(f.before)) changes.push({ ...f, after: value })
      const target = f.path.slice(0, -1).reduce((o, key) => o[key], payload)
      target[f.path.at(-1)] = value
    })
    if (!changes.length) return fail('还没有修改内容')
    if (auditEntry({ ...word, payload }).some(x => x.severity === 'blocking')) return fail('修正后仍没有可学习的释义或例句')
    if (!(await confirmDialog({ title: '确认保存这些修正？', sub: '会保留原内容版本和学习进度。',
      body: changes.map(c => '<p><b>' + esc(c.label) + '</b><br>原文：' + esc(c.before || '（空）') + '<br>修改：' + esc(c.after || '（空）') + '</p>').join(''), okText: '确认保存修正' }))) { openWordCorrection(word, onChanged, payload, source); return }
    try {
      await S.correctWord(baseline, payload, source)
      closeModal(); onChanged(true); ok('修正已保存，学习进度保留')
    } catch (e) { openWordCorrection(word, onChanged, payload, source); fail(e.message || '保存失败，请同步后重试') }
  }
}

/** 词条详情：以「词」为单位，一个词的多张卡在这里一并展示 */
function openWordDetail(group, onChanged) {
  const word = group.word
  const cards = group.cards
  if (!word || !cards.length) return
  const p = word.payload || {}
  const ipa = p.ipa && (p.ipa.uk || p.ipa.us)
  const allSuspended = cards.every((c) => c.suspended)

  const typeRows = cards.map((c) => {
    const meta = CARD_TYPES[c.card_type] || { label: c.card_type }
    const st = c.suspended ? '已暂停'
      : c.status === 'new' ? '未学'
      : FSRS.isMastered(c) ? '记忆稳定'
      : '学习中'
    const due = c.status === 'new' ? '—' : fmtDateCN(c.due)
    return '<div class="row between" style="padding:7px 0;border-bottom:1px dashed var(--line);font-size:13px;">' +
      '<span>' + esc(meta.label) + '　<span class="tiny">' + esc(st) + '</span></span>' +
      '<span class="tiny">下次 ' + esc(due) + '　记住 ' + c.reps + ' 次</span></div>'
  }).join('')

  openModal(
    '<h3>' + esc(word.lemma || word.normalized) +
    (ipa ? ' <span class="tiny">/' + esc(String(ipa).replace(/\//g, '')) + '/</span>' : '') + '</h3>' +
    '<p class="sub">' + esc(cards[0].deck) + '　｜　' + cards.length + ' 张卡' +
    '　｜　' + esc(verifyLabel(word)) + '</p>' +
    wordAnswerHTML(word) + reviewReportHTML(word) +
    ((p.correction_history || []).length ? '<details><summary>查看修正前的内容版本</summary>' + p.correction_history.map(h => '<h4>' + esc(fmtDateCN(h.at)) + '</h4>' + wordAnswerHTML({ payload: h.payload || {} })).join('') + '</details>' : '') +
    '<h3 class="sec">各张卡片</h3>' +
    typeRows +
    '<div class="modal-actions word-detail-actions">' +
    '<button class="btn" id="wd-speak">朗读</button>' +
    '<button class="btn" id="wd-regen">重新生成</button>' +
    '<button class="btn" id="wd-edit">核对并修正内容</button>' +
    '<button class="btn ' + (allSuspended ? 'soft' : '') + '" id="wd-susp">' + (allSuspended ? '恢复' : '暂停') + '</button>' +
    '<button class="btn primary" id="wd-reset">重学</button>' +
    '</div>' +
    '<div class="modal-actions" style="margin-top:8px;">' +
    '<button class="btn danger" id="wd-del">从词库删除这个词</button>' +
    '</div>'
  )

  $('#wd-edit').onclick = () => openWordCorrection(word, onChanged)
  $('#wd-speak').onclick = () => { if (!speak(word.lemma)) fail('当前环境不支持朗读') }

  $('#wd-regen').onclick = async () => {
    if (word.verification_status === 'corrected' && !(await confirmDialog({ title: '重新生成会覆盖人工修正的内容', sub: '请先保留已核实的内容，确认仍要重新生成。', okText: '重新生成' }))) return
    closeModal()
    toast('正在重新生成…')
    try {
      const res = await ENRICH.enrichTerm(word.normalized, { model: S.state.settings.llm_model || undefined })
      const merged = Object.assign({}, word.payload || {}, res.data)
      await S.putWord(word.normalized, res.data.lemma || word.lemma, merged)
      onChanged(true)
      ok('已更新释义')
    } catch (e) {
      fail((e && e.message) || '生成失败')
    }
  }

  $('#wd-susp').onclick = async () => {
    const next = !allSuspended
    cards.forEach((c) => { c.suspended = next })
    try {
      for (const c of cards) await S.persistCard(c)
      S.saveLocal()
      closeModal()
      onChanged(true)
      ok(next ? '已暂停，不再出现在复习队列' : '已恢复')
    } catch (e) {
      fail('操作失败：' + ((e && e.message) || ''))
    }
  }

  $('#wd-reset').onclick = async () => {
    if (!(await confirmDialog({
      title: '把这个词当作新词重学？',
      sub: cards.length + ' 张卡的学习进度都会归零（复习记录保留）',
      okText: '重学', danger: true,
    }))) return
    cards.forEach((c) => Object.assign(c, {
      status: 'new', stability: 0, difficulty: 0, reps: 0, lapses: 0,
      due: Date.now(), last_review_at: null, last_grade: null,
    }))
    try {
      for (const c of cards) await S.persistCard(c)
      S.saveLocal()
      closeModal()
      onChanged(true)
      ok('已重置')
    } catch (e) {
      fail('操作失败：' + ((e && e.message) || ''))
    }
  }

  $('#wd-del').onclick = async () => {
    if (!(await confirmDialog({
      title: '从词库删除「' + (word.lemma || word.normalized) + '」？',
      sub: '会删除这个词的 ' + cards.length + ' 张卡和它的复习记录',
      okText: '删除', danger: true,
    }))) return
    try {
      const db = AUTH.db()
      await db.from('reviews').delete().eq('word_id', word.id)
      const r = await db.from('cards').delete().eq('word_id', word.id).select()
      if (r.error) throw r.error
      if (!Array.isArray(r.data) || r.data.length === 0) throw new Error('云端未确认删除')
      const gone = new Set(cards.map((c) => c.id))
      S.state.cards = S.state.cards.filter((c) => !gone.has(c.id))
      S.reindex()
      S.saveLocal()
      S.pullStats().catch(() => {})
      closeModal()
      onChanged(true)
      ok('已删除')
    } catch (e) {
      fail('删除失败：' + ((e && e.message) || ''))
    }
  }
}

/* ═════════════════════════ 统计 ═════════════════════════ */


/** 记忆指标卡：回答"到底记住了没有"，而不是"学了多少" */
function memoryMetricsCard() {
  const h = S.memoryHealth()
  const gs = S.goalStats(30)
  const rows = S.state.reviewRows
  if (!rows) {
    return '<div class="card"><div class="card-head"><h2>记忆指标</h2></div>' +
      '<p class="muted" style="margin:0;">正在加载复习日志…</p></div>'
  }
  const m = S.memoryMetrics(rows)
  // 和预测保持率对比必须用**同口径**的数：FSRS 预测的是"复习前的回忆概率"，
  // 对应的是非首次复习，而不是把首次复习也混进来的总体通过率。
  const gap = (m.predicted == null || m.repeatPassRate == null) ? null : m.repeatPassRate - m.predicted
  const srcZh = { study: '学习页', game: '练习场', test: '抽测' }
  const srcRows = m.bySource.map((b) =>
    '<div class="row between" style="margin-bottom:4px;">' +
    '<span class="tiny">' + esc(srcZh[b.source] || b.source) + '　' + b.n + ' 次' +
    (b.firstN ? '（首次 ' + b.firstN + '）' : '') + '</span>' +
    '<span class="tiny">通过 ' + b.passRate + '%' +
    (b.firstPassRate != null ? '　首次 ' + b.firstPassRate + '%' : '') +
    (b.avgMs ? '　均 ' + (b.avgMs / 1000).toFixed(1) + 's' : '') + '</span></div>').join('')

  const advice = []
  if (h.due > 50) advice.push('复习债 ' + h.due + ' 张 —— 优先清到期复习，暂缓新词')
  /* 样本不足就别下结论。日志只有几十条时，几个百分点的差距完全可能是随机波动，
     照着它去改留存率，等于拿噪声调算法参数。
     措辞也必须是"可能原因"而不是"就是间隔太长" —— 差距还有别的解释。 */
  if (gap != null && gap <= -5 && (m.predN || 0) >= 100) {
    advice.push('实际保持率比模型预测低约 ' + Math.abs(gap) + ' 个百分点（对比样本 ' + m.predN +
      ' 次）。可能的原因不止一个：间隔偏长、这批词本身偏难、或者评分偏严。' +
      '如果连续两周都是这样，再把目标留存率上调 2-3% 试试。')
  }
  if (gap != null && gap >= 8 && (m.predN || 0) >= 100) {
    advice.push('实际保持率比预测高约 ' + gap + ' 个百分点（对比样本 ' + m.predN +
      ' 次），可以下调目标留存率，用更少时间换同样效果。')
  }
  if (gap != null && (m.predN || 0) < 100) {
    advice.push('目前只有 ' + m.predN + ' 次可用于校准的复习，还看不出"实际 vs 预测"的可靠差距 —— ' +
      '攒到 100 次以上再调留存率更稳。')
  }
  const testRow = m.bySource.find((b) => b.source === 'test')
  if (testRow && testRow.passRate < 70 && testRow.n >= 20) {
    // 旧文案直接断言"说明你会认不会写"—— 但这个差距至少还有两种解释，
    // 而其中一种（判分口径）恰恰是用户没法自己发现的。
    advice.push('抽测通过率 ' + testRow.passRate + '%（' + testRow.n + ' 次），低于学习页。' +
      '可能是产出提取本来就难，也可能是拼写或判分口径的问题 —— ' +
      '先看下面的来源分项，别急着下结论。')
  }

  return '<div class="card">' +
    '<div class="card-head"><h2>记忆指标</h2><span class="hint">' +
    (m.range ? m.range.from + ' 至 ' + m.range.to + '　·　' : '') + m.n + ' 次复习</span></div>' +
    '<div class="metrics">' +
    metric('一次通过率', m.firstPassRate == null ? '—' : m.firstPassRate + '%') +
    metric('总体通过率', m.passRate + '%') +
    metric('预测保持率', m.predicted == null ? '—' : m.predicted + '%') +
    metric('平均记录用时', m.avgMs ? (m.avgMs / 1000).toFixed(1) + 's' : '—') +
    '</div>' +
    '<div class="row between" style="margin:10px 0 6px;">' +
    '<span class="tiny">成熟卡 ' + h.maturePct + '%　｜　复习债 ' + h.due + ' 张　｜　已开始 ' + h.startedPct +
    '%　｜　达标率 ' + gs.rate + '%（近 30 天）</span>' +
    '<span class="tiny">达标连胜 ' + gs.streak + ' 天</span></div>' +
    (srcRows ? '<div style="border-top:1px solid var(--line);padding-top:8px;margin-top:6px;">' + srcRows + '</div>' : '') +
    // 判分维度：这三项从 2026-10-09 起才有记录，所以必须先说覆盖了多少条 ——
    // 拿旧日志算出来的"0 次待复核"是假象，不是"系统从没误判过"。
    '<div class="card tight" style="margin-top:10px;">' +
    '<div class="tiny" style="font-weight:600;margin-bottom:6px;">判分维度（有记录的 ' + m.judgedN + ' / ' + m.n + ' 次）</div>' +
    (m.judgedN
      ? '<div class="row between" style="margin-bottom:3px;"><span class="tiny">用了提示后答对</span><span class="tiny">' +
        m.hintedN + ' 次</span></div>' +
        '<div class="row between" style="margin-bottom:3px;"><span class="tiny">靠选项辅助答对</span><span class="tiny">' +
        m.assistedN + ' 次</span></div>' +
        '<div class="row between" style="margin-bottom:3px;"><span class="tiny">用了别的正确表达</span><span class="tiny">' +
        m.altN + ' 次</span></div>' +
        '<div class="row between"><span class="tiny">无法自动判定（未计错）</span><span class="tiny">' +
        m.unsureN + ' 次</span></div>'
      : '<p class="tiny" style="margin:0;">还没有带判分记录的复习。这三项从 2026-10-09 起开始记录，' +
        '老日志里没有，所以现在显示为空是正常的 —— 不是"从没误判过"。</p>') +
    (m.judgedN && m.judgedN < m.n
      ? '<p class="tiny" style="margin:6px 0 0;">更早的 ' + (m.n - m.judgedN) +
        ' 次复习没有判分记录（当时还没开始记），所以上表的比例只按有记录的部分算。</p>'
      : '') +
    '</div>' +
    (advice.length
      ? '<div class="card tight" style="background:var(--brand-soft);border-color:transparent;margin-top:10px;">' +
        advice.map((a) => '<div class="tiny">· ' + esc(a) + '</div>').join('') + '</div>'
      : '') +
    '<p class="tiny" style="margin:10px 0 0;">' +
    '<b>一次通过率</b>只算每张卡的第一次复习（' + (m.firstN || 0) + ' 次）；' +
    '<b>总体通过率</b>含全部复习（' + m.n + ' 次），越熟练越高。' +
    '<b>预测保持率</b>来自 FSRS 对"复习前回忆概率"的推算，和它对比要用同口径。' +
    '</p>' +
    '</div>'
}

export function renderStats() {
  // 统计依赖的是**复习日志**，它和词条/卡片是两条独立的加载链路。
  // 日志还没回来时全页都是 0，看起来"我从没学过" —— 必须整体让位给状态卡。
  const ph = dataStateCard({ loadingText: '正在取回你的学习记录…' })
  if (ph) return '<h1 class="page">统计</h1>' + ph

  const daily = S.state.daily.slice().sort((a, b) => String(a.reviewed_on).localeCompare(String(b.reviewed_on)))
  const byDate = new Map(daily.map((d) => [String(d.reviewed_on).slice(0, 10), d]))

  const totalReviews = daily.reduce((a, d) => a + Number(d.total), 0)
  const totalCorrect = daily.reduce((a, d) => a + Number(d.correct), 0)
  const totalMinutes = daily.reduce((a, b) => a + Number(b.minutes || 0), 0)
  const activeDays = daily.filter((d) => Number(d.total) > 0).length

  const cards = S.state.cards
  const nNew = cards.filter((c) => c.status === 'new').length
  const nLearning = cards.filter((c) => c.status !== 'new' && !FSRS.isMastered(c)).length
  const nMature = cards.filter(FSRS.isMastered).length
  const nSusp = cards.filter((c) => c.suspended).length
  const total = cards.length || 1

  // 近 180 天热力图
  const cells = []
  const start = new Date()
  start.setDate(start.getDate() - 181)
  while (start.getDay() !== 0) start.setDate(start.getDate() - 1)
  const cur = new Date(start)
  while (cur <= new Date()) {
    const key = S.todayKey(cur)
    const n = Number((byDate.get(key) || {}).total || 0)
    cells.push({ key, n })
    cur.setDate(cur.getDate() + 1)
  }
  const lvl = (n) => (n === 0 ? 0 : n < 10 ? 1 : n < 30 ? 2 : n < 60 ? 3 : 4)

  // 记忆指标：首次进入时异步拉复习日志（1000 行，只放内存），拿到后重绘本页
  if (!S.state.reviewRows && !S.state.reviewRowsLoading) {
    S.pullMetrics().then(() => {
      const r = window.__lexiloopRender
      if (r) r()
    }).catch(() => {})
  }
  const metricsCard = memoryMetricsCard()

  // 近 30 天正确率
  const last30 = daily.slice(-30).filter((d) => Number(d.total) > 0)
  const acc = last30.length
    ? Math.round((last30.reduce((a, d) => a + Number(d.correct), 0) / last30.reduce((a, d) => a + Number(d.total), 0)) * 100)
    : 0

  const bars = last30.slice(-14)
  const maxBar = Math.max.apply(null, [1].concat(bars.map((d) => Number(d.total))))

  /* ── 遗忘曲线与到期预测（用来代替"只看连胜数字"） ── */
  const now = Date.now()
  // 未来 14 天每天到期的卡片数
  const forecast = []
  for (let i = 0; i < 14; i++) {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); dayStart.setDate(dayStart.getDate() + i)
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1)
    const n = cards.filter((c) => {
      if (c.suspended) return false
      const t = c.due ? new Date(c.due).getTime() : 0
      return t >= dayStart.getTime() && t < dayEnd.getTime()
    }).length
    forecast.push({ label: i === 0 ? '今天' : '+' + i, n })
  }
  const forecastMax = Math.max.apply(null, [1].concat(forecast.map((f) => f.n)))

  // 记忆保持率曲线：取已学卡片的 stability 中位数，按 FSRS 的 R(t) 画 30 天
  const studied = cards.filter((c) => c.status !== 'new' && Number(c.stability) > 0)
  const stabilities = studied.map((c) => Number(c.stability)).sort((a, b) => a - b)
  const medianS = stabilities.length ? stabilities[Math.floor(stabilities.length / 2)] : 0
  const retentionTarget = Number(S.state.settings.target_retention) || 0.9
  const curve = []
  for (let d = 0; d <= 30; d++) {
    curve.push({ d, r: medianS > 0 ? FSRS.retrievability(d, medianS) : null })
  }

  const curveHTML = (() => {
    if (!medianS) {
      return '<p class="tiny" style="margin:0;">还没有复习数据 —— 学过几张卡之后这里会画出你的记忆衰减曲线。</p>'
    }
    const W = 320, H = 120, PAD = 22
    const px = (d) => PAD + (d / 30) * (W - PAD - 6)
    const py = (r) => H - PAD - r * (H - PAD - 10)
    const pts = curve.map((p) => px(p.d) + ',' + py(p.r).toFixed(1)).join(' ')
    const targetY = py(retentionTarget).toFixed(1)
    // 中位 stability 对应的"到期"位置：R 降到目标留存率所需天数
    const dueDay = Math.min(30, Math.round(FSRS.intervalForRetention(medianS, retentionTarget)))
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="记忆保持率衰减曲线">' +
      '<line x1="' + PAD + '" y1="' + py(1) + '" x2="' + (W - 6) + '" y2="' + py(1) + '" stroke="var(--line)" stroke-width="1"/>' +
      '<line x1="' + PAD + '" y1="' + py(0) + '" x2="' + (W - 6) + '" y2="' + py(0) + '" stroke="var(--line)" stroke-width="1"/>' +
      '<line x1="' + PAD + '" y1="' + targetY + '" x2="' + (W - 6) + '" y2="' + targetY + '" stroke="var(--warn)" stroke-width="1" stroke-dasharray="4 3"/>' +
      '<line x1="' + px(dueDay) + '" y1="' + py(1) + '" x2="' + px(dueDay) + '" y2="' + py(0) + '" stroke="var(--brand)" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--brand)" stroke-width="2.2" stroke-linejoin="round"/>' +
      '<circle cx="' + px(dueDay) + '" cy="' + targetY + '" r="3.2" fill="var(--brand)"/>' +
      '<text x="' + PAD + '" y="' + (H - 5) + '" font-size="9" fill="var(--ink-3)">今天</text>' +
      '<text x="' + (W - 34) + '" y="' + (H - 5) + '" font-size="9" fill="var(--ink-3)">+30 天</text>' +
      '<text x="' + (W - 62) + '" y="' + (Number(targetY) - 4) + '" font-size="9" fill="var(--warn)">目标 ' + Math.round(retentionTarget * 100) + '%</text>' +
      '<text x="' + (PAD + 4) + '" y="' + (py(1) + 11) + '" font-size="9" fill="var(--ink-3)">100%</text>' +
      '</svg>' +
      '<p class="tiny" style="margin:6px 0 0;">按你已学卡片的中位记忆强度（S ≈ ' + medianS.toFixed(1) + ' 天）' +
      '<b>模型估算</b>：大约 ' + dueDay + ' 天后留存率接近目标值。' +
      '这只是算法的推算，不是"必须等到那天"的硬规定 —— 提前复习不会有害，只是效率略低。</p>'
  })()

  const forecastHTML = forecast.map((f) => {
    const h = Math.round((f.n / forecastMax) * 46)
    return '<div class="fc-col" title="' + f.label + '：' + f.n + ' 张">' +
      '<i style="height:' + Math.max(2, h) + 'px;"></i>' +
      '<span>' + f.label + '</span></div>'
  }).join('')

  const mastery = [
    { k: '未学', n: cards.filter((c) => c.status === 'new').length, c: 'var(--line)' },
    { k: '学习中', n: nLearning, c: 'var(--warn)' },
    { k: '记忆稳定', n: nMature, c: 'var(--ok)' },
    { k: '易忘', n: cards.filter((c) => Number(c.lapses) >= 4).length, c: 'var(--bad)' },
  ]
  const masteryHTML = mastery.map((m) =>
    '<div class="mg-row"><span class="tiny" style="width:52px;">' + m.k + '</span>' +
    '<div class="mg-bar"><i style="width:' + Math.round((m.n / (cards.length || 1)) * 100) + '%;background:' + m.c + ';"></i></div>' +
    '<span class="tiny" style="width:44px;text-align:right;">' + m.n + '</span></div>'
  ).join('')

  return (
    '<h1 class="page">统计<span class="sub">数据来自云端复习日志，跨设备一致</span></h1>' +

    '<div class="card">' +
    '<div class="card-head"><h2>记忆保持率曲线</h2></div>' +
    curveHTML +
    '<div class="row between" style="margin-top:14px;align-items:flex-end;gap:3px;">' + forecastHTML + '</div>' +
    '<p class="tiny" style="margin:8px 0 0;">未来 14 天每天到期的卡片数 —— 柱子堆得越高，那天越要留时间。</p>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2>掌握度分布</h2></div>' +
    masteryHTML +
    '</div>' +

    (() => {
      // 待审核内容：必须让用户知道"有词被挡住了、为什么" ——
      // 否则他看到词库数目对不上，只会以为数据丢了。
      // 两种原因要分开说：① 内容待核验（有内容但存疑）② 内容缺失（压根没产出）——
      // 后者是 2026-10-15 实测到的空壳卡来源（导入词单的分组标题被当成词条）。
      const blocked = S.blockedWords()
      if (!blocked.length) return ''
      const empties = blocked.filter((w) => S.blockReason(w) === 'empty')
      const reviewN = blocked.length - empties.length
      return '<div class="card">' +
        '<div class="card-head"><h2>待审核内容</h2><span class="hint">' + blocked.length + ' 条</span></div>' +
        '<p class="muted" style="margin:0 0 8px;">这些词条<b>已从学习与练习队列中排除</b> —— 在内容确认之前不会让你学到：</p>' +
        '<p class="tiny" style="margin:0 0 8px;">' +
        (reviewN ? '· 内容待核验 <b>' + reviewN + '</b> 条（词性/用法存疑）<br>' : '') +
        (empties.length ? '· 内容缺失 <b>' + empties.length + '</b> 条（生成流程没产出释义与搭配，' +
          '多是导入词单里的分组标题/主题名，或对比类、整句类）—— 可在词条页点「重新生成」补内容' : '') +
        '</p>' +
        '<div class="chips">' +
        blocked.slice(0, 12).map((w) => '<span class="chip">' + esc(w.lemma || w.normalized) + '</span>').join('') +
        (blocked.length > 12 ? '<span class="chip">…还有 ' + (blocked.length - 12) + ' 个</span>' : '') +
        '</div></div>'
    })() +

    (() => {
      const weak = S.weakCards(2)
      if (!weak.length) return ''
      const terms = weak.slice(0, 12).map((c) => {
        const w = S.wordOf(c)
        return w ? (w.lemma || w.normalized) : ''
      }).filter(Boolean)
      // 选样规则必须写清楚：用户看到"薄弱词 10 张"和"专练 20 张"两个数字时，
      // 第一反应是"到底按哪个算"。不给规则，这两个数就永远像 bug。
      return '<div class="card">' +
        '<div class="card-head"><h2>薄弱词</h2><span class="hint">共 ' + weak.length + ' 张</span></div>' +
        '<p class="muted" style="margin:0 0 10px;">选样规则：<b>忘记次数 ≥ 2 次</b>的卡片，' +
        '按忘记次数从多到少排。这里列的是全部符合的卡（最多显示 12 个）。</p>' +
        '<p class="tiny" style="margin:0 0 10px;">点下面的专练会抽 <b>最多 20 张</b>：优先用上面这些薄弱卡' +
        (weak.length < 20 ? '，不够 20 张时用今天到期的复习卡补足' : '') +
        '，所以两个数字不一样是正常的。原因不止"卡片太难"：也可能是题意有歧义或判分口径 —— ' +
        '建议同时看看「判分维度」里那两项。</p>' +
        '<div class="chips">' + terms.map((t) => '<span class="chip">' + esc(t) + '</span>').join('') +
        (weak.length > 12 ? '<span class="chip">…还有 ' + (weak.length - 12) + ' 个</span>' : '') + '</div>' +
        '<button class="btn primary block" id="stats-weak" style="margin-top:12px;">开始薄弱词专练</button>' +
        '</div>'
    })() +

    '<div class="card"><div class="metrics">' +
    metric('累计复习', totalReviews, '次') +
    metric('学习天数', activeDays, '天') +
    metric('近 30 天正确率', acc, '%') +
    '</div></div>' +

    metricsCard +

    '<div class="card">' +
    '<div class="card-head"><h2>打卡热力图</h2><span class="hint">近 26 周</span></div>' +
    '<div class="heat">' + cells.map((c) =>
      '<i data-l="' + lvl(c.n) + '" title="' + esc(c.key + '：' + c.n + ' 次') + '"></i>').join('') + '</div>' +
    '<div class="heat-legend"><span>少</span>' +
    [0, 1, 2, 3, 4].map((l) => '<i data-l="' + l + '"></i>').join('') +
    '<span>多</span></div>' +
    '</div>' +

    (bars.length
      ? '<div class="card"><div class="card-head"><h2>近期每日复习量</h2><span class="hint">最近 ' + bars.length + ' 个学习日</span></div>' +
        bars.map((d) => {
          const n = Number(d.total)
          const correct = Number(d.correct)
          const w = Math.max(2, Math.round((n / maxBar) * 100))
          const pct = n ? Math.round((correct / n) * 100) : 0
          return '<div style="margin-bottom:9px;">' +
            '<div class="row between tiny" style="margin-bottom:3px;"><span>' +
            esc(String(d.reviewed_on).slice(5, 10)) + '</span><span>' + n + ' 次　正确率 ' + pct + '%</span></div>' +
            '<div class="bar"><i style="width:' + w + '%;background:var(--brand);"></i></div>' +
            '</div>'
        }).join('') + '</div>'
      : '') +

    '<div class="card">' +
    '<div class="card-head"><h2>掌握度分布</h2><span class="hint">共 ' + cards.length + ' 张卡</span></div>' +
    '<div class="bar">' +
    '<i style="width:' + (nNew / total * 100) + '%;background:var(--ink-3);"></i>' +
    '<i style="width:' + (nLearning / total * 100) + '%;background:var(--brand);"></i>' +
    '<i style="width:' + (nMature / total * 100) + '%;background:var(--ok);"></i>' +
    '<i style="width:' + (nSusp / total * 100) + '%;background:var(--warn);"></i>' +
    '</div>' +
    '<div class="legend">' +
    '<span><b style="background:var(--ink-3)"></b>未学 ' + nNew + '</span>' +
    '<span><b style="background:var(--brand)"></b>学习中 ' + nLearning + '</span>' +
    '<span><b style="background:var(--ok)"></b>记忆稳定 ' + nMature + '</span>' +
    (nSusp ? '<span><b style="background:var(--warn)"></b>已暂停 ' + nSusp + '</span>' : '') +
    '</div>' +
    '<p class="tiny" style="margin:14px 0 0;">累计学习时长约 ' + totalMinutes.toFixed(0) + ' 分钟。' +
    '「记忆稳定」＝ 最近一次评分 ≥ 记得，且记忆稳定度 ≥ 21 天 —— ' +
    '它说明<b>记得住</b>，不等于<b>能主动用出来</b>。产出能力要看「判分维度」里没有用提示的那部分。</p>' +
    '</div>'
  )
}

export function bindStats(go) {
  const sw = $('#stats-weak')
  if (sw) sw.onclick = () => {
    if (!S.buildWeakQueue().length) return fail('还没有薄弱词 —— 薄弱 = 忘记次数 ≥ 2 次的卡，先在正式学习里多评几张')
    resetSession('weak')
    if (go) go('study')
  }
}

/* ═════════════════════════ 我的 ═════════════════════════ */

const MAMMOTH_CDN = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js'

const API_PRESETS = [
  { label: 'DeepSeek（推荐，便宜且英文好）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'DeepSeek 推理版', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: '自己填（任何 OpenAI 兼容接口）', baseUrl: '', model: '' },
]
function renderApiCard() {
  const custom = AUTH.getCustomApi()
  const useCustom = !!custom

  return (
    '<div class="card">' +
    '<div class="card-head"><h2>AI 接口</h2></div>' +
    '<div class="seg" style="width:100%;display:flex;margin-bottom:14px;">' +
    '<button type="button" data-api="cloud" class="' + (useCustom ? '' : 'on') + '" style="flex:1;">云端免密钥</button>' +
    '<button type="button" data-api="custom" class="' + (useCustom ? 'on' : '') + '" style="flex:1;">我自己的 API</button>' +
    '</div>' +

    '<div id="api-cloud" class="' + (useCustom ? 'hidden' : '') + '">' +
    '<div class="field"><label for="st-model">使用哪个云端模型</label>' +
    '<select class="input" id="st-model"><option value="">正在读取可用模型…</option></select>' +
    '<p class="tiny" style="margin:6px 0 0;">云端模型均为推理型，速度与成本差异较大，' +
    '括号内是相对成本（越小越快越省）。生成慢时换一个试试。</p></div>' +
    '</div>' +

    '<div id="api-custom" class="' + (useCustom ? '' : 'hidden') + '">' +
    '<div class="field"><label for="api-preset">服务商预设</label>' +
    '<select class="input" id="api-preset">' +
    API_PRESETS.map((p, i) => '<option value="' + i + '">' + esc(p.label) + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>Base URL</label>' +
    '<input class="input" id="api-base" placeholder="https://api.deepseek.com/v1" value="' +
    esc((custom && custom.baseUrl) || '') + '">' +
    '<p class="tiny" style="margin:6px 0 0;">填到 /v1 为止即可，会自动补上 /chat/completions。</p></div>' +
    '<div class="field"><label>API Key</label>' +
    '<input class="input" id="api-key" type="password" autocomplete="off" placeholder="sk-..." value="' +
    esc((custom && custom.apiKey) || '') + '"></div>' +
    '<div class="field"><label>模型名</label>' +
    '<input class="input" id="api-model" placeholder="deepseek-chat" value="' +
    esc((custom && custom.model) || '') + '">' +
    '<p class="tiny" style="margin:6px 0 0;">必须全小写。DeepSeek 官方名是 ' +
    '<b>deepseek-chat</b>（通用）和 <b>deepseek-reasoner</b>（推理），' +
    '不要写 deepseek-V4-Flash 这种带大写的名字。</p></div>' +
    '<div class="btn-group">' +
    '<button class="btn" id="api-test">测试连接</button>' +
    '<button class="btn primary" id="api-save">保存并启用</button>' +
    '<button class="btn danger" id="api-clear">清除</button>' +
    '</div>' +
    '<p class="tiny" style="margin:12px 0 0;color:var(--warn);">密钥只保存在这台设备的浏览器里，' +
    '不会写进你的云端数据。但浏览器没有绝对安全的存储位置，建议用一把可随时吊销的专用 key。</p>' +
    '</div>' +
    '</div>'
  )
}

/** 词条来源标注。
 *  实测（2026-10-10，1580 条）：**78% 的词条自评 confidence = 1.0**，
 *  这个字段早就失去区分度了。继续显示"95%"只会被读成"95% 正确"。
 *  所以只在明显偏低时才给数字，其余一律标"未经验证"。 */
function confidenceLabel(c) {
  if (c == null) return 'AI 生成，待审核'
  if (c >= 0.95) return 'AI 生成，未经验证'
  return 'AI 生成（模型自评把握 ' + Math.round(c * 100) + '%，未经验证）'
}

/** 内容核验状态标注。
 *  抽样实测 50 条已学词条，发现 6 条问题（含 1 条不存在的英语动词 statemented），
 *  所以"AI 生成"后面必须跟上核验到了什么程度 —— 只说"AI 生成"等于把
 *  已修正、待审核、从未核验三种状态混成一句。 */
function verifyLabel(w) {
  const st = w && w.verification_status
  if (st === 'corrected') return 'AI 生成 · 已修正'
  if (st === 'flagged') return 'AI 生成 · 待审核（内容可能有问题）'
  if (st === 'suspect') return 'AI 生成 · 待审核（生成校验未通过）'
  if (st === 'reviewed') return 'AI 生成 · 已复核（有改进建议）'
  if (st === 'verified') return '模型复核未发现问题（非权威核验）'
  return confidenceLabel(((w && w.payload) || {}).confidence)
}

/** 复核任务的进度与按钮状态 */
function reviewHint() {
  const st = reviewStatus()
  if (!st) return '未开始'
  if (st.running) return st.pauseRequested ? '正在暂停' : '进行中'
  if (st.lastError) return '需重试'
  return st.done >= st.total ? '已完成' : '可继续'
}

function reviewProgressHTML() {
  const st = reviewStatus()
  if (!st) return ''
  const pct = st.total ? Math.round(st.done / st.total * 100) : 0
  const label = st.running ? (st.pauseRequested ? '正在暂停 ' : '复核中 ') :
    st.lastError ? '复核中断 ' : st.done >= st.total ? '已完成 ' : '已暂停 '
  return '<div class="tiny" role="status" aria-live="polite" style="margin:0 0 10px;line-height:1.7;">' +
    label + st.done + ' / ' + st.total + ' 个词条（' + pct + '%，已处理）' +
    (st.current ? '　·　' + esc(st.current) : '') + '<br>' +
    '模型复核 ' + st.reviewed + ' 条，规则检查完成 ' + st.rules + ' 条<br>' +
    '有效缓存跳过 ' + st.cached + ' 条，保护人工修正 ' + st.protected + ' 条，已移除 ' + st.removed + ' 条' +
    (st.previousDone ? '<br>继承旧版已处理进度 ' + st.previousDone + ' 条；历史成功/跳过明细未记录。' : '') + '<br>' +
    '本轮报告：会教错 ' + st.blocking + ' 条　｜　有改进建议 ' + st.advisory + ' 条' +
    (st.failed ? '　｜　失败尝试 ' + st.failed + ' 次（不计完成）' : '') +
    '<br>并发 ' + st.concurrency + '，正在处理 ' + st.active.length + ' 条' +
    (st.requestCount && st.requestsMs > 0 ? '；单条平均 ' + Math.round(st.requestsMs / st.requestCount / 1000) + ' 秒，剩余参考约 ' + Math.ceil((st.total - st.done) * st.requestsMs / st.requestCount / st.concurrency / 60000) + ' 分钟（随缓存和限流变化）' : '；正在测量速度，暂不估算剩余时间') +
    (st.pauseRequested ? '<br>等待正在处理的词条结束后暂停，请勿刷新页面。' : '') +
    (st.persistenceError ? '<br>本机无法保存断点，关闭页面后可能需要重新处理；已保存的云端报告仍保留。' : '') +
    (st.lastError ? '<br><span style="color:var(--bad);">' + esc(st.lastError) + '</span>' : '') + '</div>'
}

function reviewJobRunning() {
  const st = reviewStatus()
  return !!(st && st.running)
}

function reviewPanelHTML() {
  const st = reviewStatus()
  const running = !!(st && st.running)
  const resume = st && !running && st.done < st.total
  return reviewProgressHTML() + '<div class="btn-group">' +
    '<button class="btn' + (running ? '' : ' primary') + '" id="me-review-learned"' +
    (running ? ' disabled' : '') + '>' + (resume && st.scope === 'learned' ? '继续复核已学词条' : '复核已学词条') + '</button>' +
    '<button class="btn" id="me-review-all"' + (running ? ' disabled' : '') + '>' +
    (resume && st.scope === 'all' ? '继续复核我的全部词条' : '复核我的全部词条') + '</button>' +
    (running ? '<button class="btn sm" id="me-review-pause"' + (st.pauseRequested ? ' disabled' : '') + '>' +
      (st.pauseRequested ? '正在暂停…' : '暂停') + '</button>' : '') + '</div>'
}

function bindReviewControls(onChanged) {
  for (const scope of ['learned', 'all']) {
    const btn = $('#me-review-' + scope)
    if (btn) btn.onclick = () => {
      startReview(scope, onChanged).catch(e => fail(e.message || '复核中断，请稍后继续'))
    }
  }
  const pause = $('#me-review-pause')
  if (pause) pause.onclick = () => pauseReview(onChanged)
}

export function refreshReviewPanel(onChanged) {
  const panel = $('#review-panel')
  if (!panel) return
  panel.innerHTML = reviewPanelHTML()
  const hint = $('#review-hint')
  if (hint) hint.textContent = reviewHint()
  bindReviewControls(onChanged)
}

export function renderMe() {
  const s = S.state.settings
  const email = S.state.accountEmail || (S.state.user && S.state.user.email) || '已登录'
  const pend = S.pendingCount()

  /** 备份告警卡：只在「从未备份」或「距上次备份 ≥14 天」时出声，平时不打扰。
   *  为什么不能只是一行灰色小字：云端只保证"服务还在"时不丢，账号异常、误删、
   *  平台调整都不在它的承诺范围内——本机那份 JSON 才是唯一真正属于你的副本。
   *  3069 张卡从未备份却一直没被提醒动过手，说明提醒强度不够，所以升级成告警卡。 */
  function backupAlert() {
    const snooze = Number(s.backup_snooze_until) || 0
    if (snooze && Date.now() < snooze) return ''
    const last = Number(s.last_backup_at) || 0
    const nCards = S.state.cards.length
    let title = ''
    let body = ''
    if (!last) {
      if (nCards < 20) return ''      // 没多少进度，不值得打扰
      title = '还没导出过备份'
      body = '现在有 <b>' + nCards + '</b> 张卡片 / <b>' + S.state.words.length +
        '</b> 个词条，全部只存在云端。导出一份 JSON 存到本机，10 秒的事，' +
        '是唯一不依赖别人的副本。'
    } else {
      const days = Math.floor((Date.now() - last) / 86400000)
      if (days < 14) return ''
      title = '距上次备份已 ' + days + ' 天'
      body = '这段时间新增的学习进度还没进过任何一份本机存档。' +
        '补一份 JSON，后面的积累才有兜底。'
    }
    return (
      '<div class="alert-card" role="alert">' +
      '<div class="ac-icon">' + icon('warn', 20) + '</div>' +
      '<div class="ac-body">' +
      '<div class="ac-title">' + esc(title) + '</div>' +
      '<p class="ac-text">' + body + '</p>' +
      '<div class="ac-actions">' +
      '<button class="btn primary" id="bk-now">' + icon('save', 15) + ' 现在导出</button>' +
      '<button class="btn ghost" id="bk-later">7 天后再提醒</button>' +
      '</div>' +
      '</div>' +
      '</div>'
    )
  }

  /** 备份卡里的固定状态行：告警卡消失后仍然要能看到上次备份是什么时候 */
  function backupStatusLine() {
    const last = Number(s.last_backup_at) || 0
    if (!last) {
      return '<p class="tiny" style="margin:0 0 12px;">上次备份：' +
        '<b style="color:var(--warn);">从未</b></p>'
    }
    const days = Math.floor((Date.now() - last) / 86400000)
    const col = days >= 14 ? 'var(--warn)' : 'var(--ok)'
    return '<p class="tiny" style="margin:0 0 12px;">上次备份：' +
      '<b style="color:' + col + ';">' + esc(relTime(last)) + '</b>（' + days + ' 天前）</p>'
  }

  return (
    '<h1 class="page">我的</h1>' +
    backupAlert() +

    '<div class="card"><div class="row between">' +
    '<div><div class="tiny">当前账号</div><div style="font-size:15px;font-weight:500;word-break:break-all;">' + esc(email) + '</div></div>' +
    '<button class="btn sm" id="me-sync">' + icon('sync', 16) + ' 同步</button>' +
    '</div>' +
    '<p class="tiny" style="margin:10px 0 0;">' +
    (S.state.syncAt ? '上次同步 ' + relTime(S.state.syncAt) : '尚未同步') +
    (pend ? '　｜　有 ' + pend + ' 条待同步' : '') + '</p>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2>学习节奏</h2></div>' +
    '<div class="field"><label for="st-new">每日新学词数（个）</label>' +
    '<input class="input" type="number" min="0" max="200" id="st-new" value="' + esc(s.daily_new) + '"></div>' +
    '<div class="field"><label for="st-max">每日正式作答上限（次，含新学、重试和练习计入）</label>' +
    '<input class="input" type="number" min="0" max="2000" id="st-max" value="' + esc(s.daily_max_review) + '"></div>' +
    '<div class="field"><label for="st-ret">目标留存率 <span id="ret-val" class="tiny">' +
    Math.round(Number(s.target_retention) * 100) + '%</span></label>' +
    '<input type="range" min="80" max="97" step="1" id="st-ret" value="' + Math.round(Number(s.target_retention) * 100) + '" style="width:100%;">' +
    '<div class="row between tiny"><span>80% · 省时间</span><span>97% · 记得牢</span></div>' +
    '<p class="tiny" id="ret-hint" style="margin:6px 0 0;"></p></div>' +
    '<div class="field"><label for="st-stepmin">新卡巩固间隔（分钟，第一次想起来后隔多久再见）</label>' +
    '<input class="input" type="number" min="1" max="120" id="st-stepmin" value="' + esc(Number(s.learn_step_minutes) || 10) + '"></div>' +
    '<div class="field"><label for="st-stepdays">新卡跨日复习间隔（天，推荐 1 天）</label>' +
    '<input class="input" type="text" inputmode="numeric" pattern="[1-7]" maxlength="1" id="st-stepdays" value="' + esc(Number(s.learn_step_days) || 1) + '"></div>' +
    '<p class="tiny">新卡先成功回忆，再于巩固间隔后成功回忆，之后安排跨日复习。忘了重新巩固；吃力不推进阶段。修改设置只影响后续评分，不重排已有到期日。</p>' +
    '<label class="row" style="gap:8px;align-items:center;margin:4px 0 8px;">' +
    '<input type="checkbox" id="st-pause-new"' + (String(s.pause_new_when_overdue) !== 'false' ? ' checked' : '') + '>' +
    '<span class="tiny">有跨日逾期复习时暂停新词，清理后自动恢复（推荐）</span></label>' +
    (function () {
      const decks = Array.from(new Set(S.state.cards.map((c) => c.deck).filter(Boolean)))
      if (decks.length < 2) return ''
      return '<div class="field"><label for="st-deck">学习范围（只影响学习与薄弱专练）</label>' +
        '<select class="input" id="st-deck"><option value="">全部词单</option>' +
        decks.map((d) => '<option value="' + esc(d) + '"' +
          (String(s.deck_filter || '') === d ? ' selected' : '') + '>' + esc(d) + '</option>').join('') +
        '</select></div>' +
        (function () {
          const topics = Array.from(new Set(S.state.words.map((w) => String((w.payload || {}).topic || '').trim()).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, 'zh'))
          if (topics.length < 2) return ''
          return '<div class="field"><label for="st-topic">按场景学（可选，钉住某个场景就只出这一组的词）</label>' +
            '<select class="input" id="st-topic"><option value="">不限定</option>' +
            topics.map((t) => '<option value="' + esc(t) + '"' +
              (String(s.topic_filter || '') === t ? ' selected' : '') + '>' + esc(t) + '</option>').join('') +
            '</select></div>'
        })()
    })() +
    '<label class="row" style="gap:8px;align-items:center;margin:4px 0 8px;">' +
    '<input type="checkbox" id="st-goaltest"' + (String(s.goal_include_test) === 'true' ? ' checked' : '') + '>' +
    '<span class="tiny">达标需含每周抽测（7 天内做过一次抽测才算达标日）</span></label>' +
    '<label class="row" style="gap:8px;align-items:center;margin:4px 0 8px;">' +
    '<input type="checkbox" id="st-rest"' + (String(s.rest_weekday) === '0' ? ' checked' : '') + '>' +
    '<span class="tiny">周日休息日：只复习、不引新词（留一天做整合与抽测）</span></label>' +
    '<label class="row" style="gap:8px;align-items:center;margin:4px 0 12px;">' +
    '<input type="checkbox" id="st-autocredit"' + (String(s.auto_credit) === 'true' ? ' checked' : '') + '>' +
    '<span class="tiny">练习/抽测结束后自动写入复习计划（默认关；开启后按用时自动分档 4/3/2/1）</span></label>' +
    '<div class="field"><label for="st-interleave">交错比例（每 N 张复习卡插 1 张新词）</label>' +
    '<input class="input" type="number" min="1" max="20" id="st-interleave" value="' + esc(Number(s.queue_interleave) || 4) + '"></div>' +
    '<button class="btn primary block" id="st-save">保存设置</button>' +
    '<button class="btn soft block" id="st-recommend" style="margin-top:8px;">用推荐设置（一键还原）</button>' +
    '<p class="tiny" style="margin:8px 0 0;">推荐值：' +
    RECOMMENDED_SETTINGS.daily_new + ' 新词 / ' + RECOMMENDED_SETTINGS.daily_max_review + ' 次正式作答上限 / 留存 ' +
    Math.round(RECOMMENDED_SETTINGS.target_retention * 100) + '% / 巩固 ' + RECOMMENDED_SETTINGS.learn_step_minutes +
    ' 分 / 跨日 ' + RECOMMENDED_SETTINGS.learn_step_days + ' 天 · 积压时暂停新词 · 达标含抽测 · 周日休息 · 练习自动写入。跨设备同步，电脑手机一致。</p>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2>外观</h2></div>' +
    '<p class="muted" style="margin:0 0 10px;">默认绿色（护眼、白天夜里都清爽）；紫色是 NYU 品牌色版本。</p>' +
    '<div class="seg" style="width:100%;display:flex;">' +
    '<button type="button" data-theme-pick="green" class="' + (getTheme() === 'green' ? 'on' : '') + '" style="flex:1;">绿色（默认）</button>' +
    '<button type="button" data-theme-pick="violet" class="' + (getTheme() === 'violet' ? 'on' : '') + '" style="flex:1;">NYU 紫</button>' +
    '</div>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2>朗读音色</h2></div>' +
    '<p class="muted" style="margin:0 0 10px;">默认自动挑选本机最清晰的标准美音（如 Microsoft Aria / Google US English）。' +
    '不满意可以指定一个。</p>' +
    '<div class="field"><label for="voice-sel">英语语音</label>' +
    '<select class="input" id="voice-sel"><option value="">自动（推荐）</option></select></div>' +
    '<div class="btn-group">' +
    '<button class="btn" id="voice-test">试听</button>' +
    '<button class="btn soft" id="voice-slow">慢速试听</button>' +
    '</div>' +
    '<p class="tiny" style="margin:10px 0 0;">试听句：The nightingale resumed its song.　' +
    '语音由浏览器提供，不同设备可选音色不同。</p>' +
    '</div>' +

    renderApiCard() +

    '<div class="card">' +
    '<div class="card-head"><h2>导出背诵手册</h2></div>' +
    '<p class="muted" style="margin:0 0 12px;">把词条导出成 Markdown 或 Word，方便打印和离线背。</p>' +
    '<button class="btn soft block" id="me-export">选择范围并导出</button>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2>版本</h2><span class="hint">v' + esc(appVersion()) + '</span></div>' +
    '<p class="muted" style="margin:0 0 10px;">显示的是这台设备<b>实际加载</b>的版本。' +
    '看不到刚上线的功能时，说明浏览器还在用缓存版，点下面按钮强制拉取。</p>' +
    '<button class="btn soft block" id="me-version-check">检查更新</button>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2>备份与迁移</h2></div>' +
    '<p class="muted" style="margin:0 0 12px;">把词条、卡片和设置打包成 JSON；恢复时<b>只补缺不覆盖</b>，' +
    '不会动你已有的学习进度。</p>' +
    backupStatusLine() +
    '<div class="btn-group">' +
    '<button class="btn" id="me-backup">导出备份</button>' +
    '<button class="btn" id="me-restore">从备份恢复</button>' +
    '<button class="btn" id="me-reviews">导出学习记录</button>' +
    '<button class="btn" id="me-anki">导出 Anki</button>' +
    '</div>' +
    '<input type="file" id="restore-file" accept=".json" aria-label="选择备份文件" style="display:none;">' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2>内容复核</h2><span class="hint" id="review-hint">' + esc(reviewHint()) + '</span></div>' +
    '<p class="muted" style="margin:0 0 10px;">让模型逐条检查搭配是否地道、语域是否合适、义项是否齐全，' +
    '并找出<b>词性标错</b>这类会教错的内容。</p>' +
    '<p class="tiny" style="margin:0 0 12px;">分两档处理：<b>会教错</b>的（词性错、虚构用法）会被挡在队列外；' +
    '<b>内容可用但不完美</b>的（个别搭配欠佳、义项不全）只记录，照常学习 —— ' +
    '不因为一条搭配欠佳就挡住整条词条。</p>' +
    '<div id="review-panel">' + reviewPanelHTML() + '</div>' +
    '<p class="tiny" style="margin:10px 0 0;">范围按本账号卡片关联的词条去重，一个词条可有多张卡；不扩展到共享词库的其他词条。耗时取决于模型和词条数量，进度会实时更新。' +
    '本轮按启动时的唯一词条快照处理，新增词条下轮纳入。最多两条并发，限流后降为单并发；相同内容的有效复核报告保留 30 天，可跳过重复调用。暂停会等待正在处理的词条结束。关闭页面会停止，下次继续；未接入云端常驻任务。复核保存报告与建议，修改内容需要你确认。</p>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2>测试模式</h2><span class="hint">' +
    (S.isTestSession() ? '已开启' : '未开启') + '</span></div>' +
    '<p class="muted" style="margin:0 0 12px;">开启后可以完整地答题、看判分、看结果页，' +
    '但这些作答<b>不会</b>进入你的复习计划、打卡、每日目标或统计 —— ' +
    '写入由服务端按标记排除，不只是界面上的开关。</p>' +
    '<p class="tiny" style="margin:0 0 12px;">用途：试用新题型、演示、或外部审计。' +
    '<b>刷新页面自动退出</b>，避免忘了关。</p>' +
    '<button class="btn ' + (S.isTestSession() ? 'soft' : '') + ' block" id="me-test-mode">' +
    (S.isTestSession() ? '退出测试模式' : '开启测试模式') + '</button>' +
    '</div>' +

    '<div class="card">' +
    '<div class="card-head"><h2>数据与账号</h2></div>' +
    '<div class="btn-group">' +
    '<button class="btn sm" id="me-about">算法与说明</button>' +
    '<button class="btn sm" id="me-cloze">补建产出卡（cloze）</button>' +
    '<button class="btn sm" id="me-clearcache">清理本地缓存</button>' +
    '<button class="btn sm danger" id="me-signout">退出登录</button>' +
    '</div>' +
    '<p class="tiny" style="margin:12px 0 0;">清理本地缓存只影响这台设备，云端进度不受影响，下次登录会重新拉取。</p>' +
    '</div>'
  )
}

export function bindMe(onChanged, go, onSignOut) {
  bindReviewControls(onChanged)

  // 测试模式开关：切换后立即重绘，顶部提示条会同步出现/消失
  const tm = $('#me-test-mode')
  if (tm) tm.onclick = () => {
    const on = !S.isTestSession()
    S.setTestSession(on)
    toast(on ? '已开启测试模式：之后的作答不计入学习进度' : '已退出测试模式', on ? 'err' : 'ok')
    onChanged()
  }
  const sel = $('#st-model')
  if (sel) {
    const cur = S.state.settings.llm_model || ''
    Promise.all([AUTH.listModels(), AUTH.resolveAutoModel().catch(() => null)])
      .then((pair) => {
        const list = pair[0]
        const auto = pair[1]
        const autoLabel = auto
          ? '自动（当前会用 ' + (auto.name || auto.id) + '）'
          : '自动（跟随云端默认）'
        sel.innerHTML =
          '<option value=""' + (cur ? '' : ' selected') + '>' + esc(autoLabel) + '</option>' +
          list.map((m) => {
            const cost = m.credits ? '（' + m.credits + '）' : ''
            return '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' +
              esc(m.name || m.id) + cost + '　' + esc(m.id) + '</option>'
          }).join('')
      })
      .catch(() => {
        sel.innerHTML = '<option value="">自动（跟随云端默认）</option>'
      })
  }

  // ── 备份 / 恢复 / 记录导出 ──
  // 导出逻辑只写一份：「我的 → 备份与迁移 → 导出备份」和告警卡的「现在导出」共用，
  // 避免两条路径行为分叉（比如一个记 last_backup_at、另一个不记）。
  async function doBackup(btn, idleLabel) {
    if (btn) { btn.disabled = true; btn.textContent = '正在打包…' }
    let done = false
    try {
      const obj = await S.buildBackup()
      const text = JSON.stringify(obj, null, 1)
      EXP.downloadText(text, EXP.stampName('搭配记忆备份', 'json'), 'application/json')
      S.state.settings.last_backup_at = Date.now()
      S.state.settings.backup_snooze_until = 0
      S.saveLocal()
      S.pushSettings().catch(() => {})
      ok('已导出 ' + obj.words.length + ' 个词条 / ' + obj.cards.length + ' 张卡' +
        (obj.reviews && obj.reviews.length ? ' / ' + obj.reviews.length + ' 条复习日志' : ''))
      done = true
    } catch (e) {
      fail('备份失败：' + ((e && e.message) || ''))
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = idleLabel || '导出备份' }
    }
    return done
  }

  const bk = $('#me-backup')
  if (bk) bk.onclick = async () => { if (await doBackup(bk, '导出备份')) onChanged(false) }

  // 告警卡上的快捷入口：导完立刻重绘，卡片自己消失，不用手动刷新
  const bkNow = $('#bk-now')
  if (bkNow) bkNow.onclick = async () => { if (await doBackup(bkNow, '现在导出')) onChanged(false) }

  const bkLater = $('#bk-later')
  if (bkLater) bkLater.onclick = () => {
    S.state.settings.backup_snooze_until = Date.now() + 7 * 86400000
    S.saveLocal()
    S.pushSettings().catch(() => {})
    onChanged(false)
  }

  const rf = $('#restore-file')
  if (rf) rf.onchange = () => {
    const f = rf.files && rf.files[0]
    if (!f) return
    const reader = new FileReader()
    reader.onerror = () => fail('文件读取失败')
    reader.onload = async () => {
      let obj = null
      try { obj = JSON.parse(decodeText(reader.result).text) } catch (e) { return fail('不是合法的 JSON 备份') }
      if (!(await confirmDialog({
        title: '从备份恢复？',
        sub: '词条 ' + (obj.words || []).length + ' 个　卡片 ' + (obj.cards || []).length + ' 张',
        body: '<p class="muted">只补缺、不覆盖：已存在的词和卡保持原样，学习进度不受影响。</p>',
        okText: '恢复', danger: false,
      }))) return
      rf.disabled = true
      try {
        const r = await S.restoreBackup(obj)
        ok('已恢复 ' + r.words + ' 个词条 / ' + r.cards + ' 张卡' +
          (r.skippedCards ? '（跳过 ' + r.skippedCards + ' 张对不上词条的卡）' : '') +
          (r.settingsRestored ? '，学习设置已写入' : '（已有设置保持原样）') +
          (r.reviews ? '，回写复习日志 ' + r.reviews + ' 条' : '') +
          (r.reviewSkipped ? '（日志跳过 ' + r.reviewSkipped + ' 条）' : ''))
        onChanged(true)
      } catch (e) {
        rf.disabled = false
        fail('恢复失败：' + ((e && e.message) || ''))
      }
    }
    reader.readAsArrayBuffer(f)
  }
  const rs = $('#me-restore')
  if (rs) rs.onclick = () => { const f = $('#restore-file'); if (f) f.click() }

  const rv = $('#me-reviews')
  if (rv) rv.onclick = async () => {
    rv.disabled = true
    rv.textContent = '拉取中…'
    try {
      const rows = await S.fetchReviews(20000)
      if (!rows.length) return fail('还没有复习记录')
      EXP.downloadText(EXP.buildReviewsCsv(rows), EXP.stampName('学习记录', 'csv'), 'text/csv')
      ok('已导出最近 ' + rows.length + ' 条复习记录' + (rows.length === 20000 ? '（达到本次上限）' : ''))
    } catch (e) {
      fail('导出失败：' + ((e && e.message) || ''))
    } finally {
      rv.disabled = false
      rv.textContent = '导出学习记录'
    }
  }

  const anki = $('#me-anki')
  if (anki) anki.onclick = () => {
    const items = S.state.cards.map((c) => ({ card: c, word: S.wordOf(c) })).filter((x) => x.word)
    if (!items.length) return fail('词库是空的')
    EXP.downloadText(EXP.buildAnkiCsv(items), EXP.stampName('Anki导入', 'tsv'), 'text/tab-separated-values')
    ok('已导出 ' + items.length + ' 行，可在 Anki 里「文件→导入」')
  }

  // ── AI 接口：云端免密钥 / 自带密钥 ──
  const apiSegs = $$('[data-api]')
  apiSegs.forEach((b) => {
    b.onclick = () => {
      const useCustom = b.dataset.api === 'custom'
      apiSegs.forEach((x) => x.classList.toggle('on', x === b))
      const cBox = $('#api-cloud')
      const uBox = $('#api-custom')
      if (cBox) cBox.classList.toggle('hidden', useCustom)
      if (uBox) uBox.classList.toggle('hidden', !useCustom)
    }
  })

  const preset = $('#api-preset')
  if (preset) {
    const cur = AUTH.getCustomApi()
    if (cur) {
      const i = API_PRESETS.findIndex((p) => p.baseUrl === cur.baseUrl && p.model === cur.model)
      if (i >= 0) preset.value = String(i)
    }
    preset.onchange = () => {
      const p = API_PRESETS[Number(preset.value)]
      if (!p || !p.baseUrl) return
      $('#api-base').value = p.baseUrl
      $('#api-model').value = p.model
    }
  }

  const readApiForm = () => ({
    baseUrl: $('#api-base') ? $('#api-base').value.trim() : '',
    apiKey: $('#api-key') ? $('#api-key').value.trim() : '',
    model: ($('#api-model') ? $('#api-model').value.trim() : '') || 'deepseek-chat',
  })

  const apiTest = $('#api-test')
  if (apiTest) {
    apiTest.onclick = async () => {
      const cfg = readApiForm()
      if (!cfg.baseUrl || !cfg.apiKey) return fail('请先填写 Base URL 和 API Key')
      apiTest.disabled = true
      apiTest.textContent = '测试中…'
      try {
        const r = await AUTH.testCustomApi(cfg)
        ok('连接成功（' + r.endpoint + '），模型回复：' + r.text.slice(0, 24))
      } catch (e) {
        fail((e && e.message) || '测试失败')
      } finally {
        apiTest.disabled = false
        apiTest.textContent = '测试连接'
      }
    }
  }

  const apiSave = $('#api-save')
  if (apiSave) {
    apiSave.onclick = () => {
      const cfg = readApiForm()
      if (!cfg.baseUrl || !cfg.apiKey) return fail('请先填写 Base URL 和 API Key')
      AUTH.setCustomApi(cfg)
      ok('已启用你自己的 API')
      onChanged(true)
    }
  }

  const apiClear = $('#api-clear')
  if (apiClear) {
    apiClear.onclick = async () => {
      if (!(await confirmDialog({
        title: '清除自定义 API？',
        sub: '会从本机浏览器删除已保存的密钥',
        okText: '清除', danger: true,
      }))) return
      AUTH.setCustomApi(null)
      ok('已清除，恢复使用云端免密钥通道')
      onChanged(true)
    }
  }

  const ret = $('#st-ret')
  if (ret) {
    const upd = () => {
      const v = Number(ret.value) / 100
      $('#ret-val').textContent = Math.round(v * 100) + '%'
      const mult = FSRS.intervalForRetention(10, v) / 10
      $('#ret-hint').textContent =
        '同样稳定度的词，间隔会变为 ×' + mult.toFixed(2) +
        (v < 0.88 ? '，复习次数更少，适合时间紧的时候' :
         v > 0.92 ? '，复习更频繁，适合必须张口就来的表达' :
         '（推荐：复习量与记忆牢固度的平衡点）')
    }
    ret.oninput = upd
    upd()
  }

  const stepDays = $('#st-stepdays')
  if (stepDays) stepDays.onfocus = () => stepDays.select()

  $('#st-save').onclick = async () => {
    S.state.settings.daily_new = Math.max(0, Number($('#st-new').value) || 0)
    S.state.settings.daily_max_review = Math.max(0, Number($('#st-max').value) || 0)
    S.state.settings.target_retention = Number($('#st-ret').value) / 100
    S.state.settings.learn_step_minutes = Math.min(120, Math.max(1, Number($('#st-stepmin').value) || 10))
    S.state.settings.learn_step_days = Math.min(7, Math.max(1, Number($('#st-stepdays').value) || 1))
    S.state.settings.pause_new_when_overdue = !!$('#st-pause-new').checked
    S.state.settings.queue_interleave = Math.min(20, Math.max(1, Number($('#st-interleave').value) || 4))
    S.state.settings.deck_filter = ($('#st-deck') && $('#st-deck').value) || ''
    S.state.settings.auto_credit = !!($('#st-autocredit') && $('#st-autocredit').checked)
    S.state.settings.rest_weekday = ($('#st-rest') && $('#st-rest').checked) ? 0 : ''
    S.state.settings.topic_filter = ($('#st-topic') && $('#st-topic').value) || ''
    S.state.settings.goal_include_test = !!($('#st-goaltest') && $('#st-goaltest').checked)
    S.state.settings.llm_model = ($('#st-model') && $('#st-model').value) || null
    S.saveLocal()
    try {
      await S.pushSettings()
      ok('已保存并同步')
    } catch (e) {
      fail('已保存在本地，云端同步稍后重试')
    }
    onChanged(true)
  }

  // ── 一键还原推荐设置（跨设备同步，电脑/手机一致）──
  const recBtn = $('#st-recommend')
  if (recBtn) {
    recBtn.onclick = async () => {
      Object.assign(S.state.settings, RECOMMENDED_SETTINGS)
      S.saveLocal()
      try {
        await S.pushSettings()
        ok('已还原推荐设置并同步到云端')
      } catch (e) {
        fail('已还原到本地，云端同步稍后重试')
      }
      onChanged(true)
    }
  }

  // ── 外观：绿色（默认）/ NYU 紫，随账号同步 ──
  $$('[data-theme-pick]').forEach((b) => {
    b.onclick = () => {
      const t = applyTheme(b.dataset.themePick)
      S.state.settings.theme = t
      S.saveLocal()
      S.pushSettings().catch(() => {})
      ok(t === 'violet' ? '已切换到 NYU 紫' : '已切换到绿色')
      onChanged(true)
    }
  })

  // ── 朗读音色：默认自动挑标准美音，允许指定 ──
  const voiceSel = $('#voice-sel')
  if (voiceSel) {
    const fillVoices = () => {
      const cur = getVoicePref()
      const voices = listEnVoices()
      const isUS = (v) => /^en[-_]us$/i.test(v.lang || '')
      voiceSel.innerHTML = '<option value="">自动（推荐）</option>' +
        voices.map((v) => '<option value="' + esc(v.voiceURI) + '"' +
          (cur === v.voiceURI ? ' selected' : '') + '>' +
          esc(v.name + (isUS(v) ? '（美音）' : '（' + (v.lang || '') + '）')) + '</option>').join('')
    }
    fillVoices()
    // 语音列表是异步加载的，稍后再补一次
    setTimeout(fillVoices, 700)
    voiceSel.onchange = () => {
      setVoicePref(voiceSel.value)
      if (voiceSel.value) ok('已切换音色')
    }
  }
  const voiceTest = $('#voice-test')
  if (voiceTest) voiceTest.onclick = () => {
    if (!speak('The nightingale resumed its song.', { voiceURI: (voiceSel && voiceSel.value) || '' })) {
      fail('当前环境不支持朗读')
    }
  }
  const voiceSlow = $('#voice-slow')
  if (voiceSlow) voiceSlow.onclick = () => {
    if (!speak('The nightingale resumed its song.', { slow: true, voiceURI: (voiceSel && voiceSel.value) || '' })) {
      fail('当前环境不支持朗读')
    }
  }

  $('#me-sync').onclick = async () => {
    const btn = $('#me-sync')
    btn.disabled = true
    try {
      const f = await S.flushPending()
      await S.syncPull()
      onChanged(true)
      ok('同步完成' + (f.cards || f.reviews ? '（补传 ' + (f.cards + f.reviews) + ' 条）' : ''))
    } catch (e) {
      fail('同步失败：' + ((e && e.message) || ''))
    } finally {
      btn.disabled = false
    }
  }

  $('#me-export').onclick = () => openExport()

  const vchk = $('#me-version-check')
  if (vchk) vchk.onclick = async () => {
    vchk.disabled = true
    const old = vchk.textContent
    vchk.textContent = '正在检查…'
    try {
      // 先催 Service Worker 自己更新（它会 skipWaiting 接管），再带时间戳重载页面，
      // 绕开 HTTP 缓存拿到新的 index.html（里面的 ?v= 全是新的，模块自然也是新的）
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration()
        if (reg) {
          await reg.update()
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' })
        }
      }
      ok('正在拉取最新版本…')
      setTimeout(() => {
        location.replace(location.pathname + '?f=' + Date.now() + location.hash)
      }, 500)
    } catch (e) {
      fail('检查更新失败：' + ((e && e.message) || e))
      vchk.disabled = false
      vchk.textContent = old
    }
  }

  $('#me-about').onclick = () => {
    openModal(
      '<h3>算法与说明</h3>' +
      '<p class="sub">关于这个工具怎么安排你的复习</p>' +
      '<p class="muted" style="font-size:13.5px;">复习间隔由 <b>FSRS</b>（Free Spaced Repetition Scheduler）计算，' +
      '它维护三个量：<b>难度 D</b>（1–10）、<b>稳定度 S</b>（天，记忆保持率降到 90% 所需天数）、' +
      '<b>可提取性 R</b>（此刻能想起的概率）。</p>' +
      '<p class="muted" style="font-size:13.5px;">记忆衰减模型：<span class="mono">R(t,S) = (1 + 0.2346·t/S)^(-0.5)</span>；' +
      '给定目标留存率 r 时，下次间隔 <span class="mono">I = S/0.2346 × (r⁻² − 1)</span>。' +
      'r = 90% 时 I 恰好等于 S，与你设定的目标一致。</p>' +
      '<p class="muted" style="font-size:13.5px;">释义与固定搭配由大模型生成，经过本地规则校验' +
      '（搭配必须包含原词、例句必须包含该搭配、长度达标），不合格的条目会被丢弃。' +
      '<b>仍请以权威词典为准</b>。</p>' +
      '<p class="tiny">学习数据保存在你的账号下，只有你自己能读写；' +
      '在手机和电脑用同一邮箱登录即可同步。</p>' +
      '<div class="modal-actions"><button class="btn primary" id="ab-ok">知道了</button></div>'
    )
    $('#ab-ok').onclick = closeModal
  }

  const clozeBtn = $('#me-cloze')
  if (clozeBtn) clozeBtn.onclick = async () => {
    clozeBtn.disabled = true
    try {
      const n = await S.ensureClozeCards()
      ok(n ? '补建了 ' + n + ' 张产出卡（cloze）' : '没有需要补建的词（都已有 cloze 卡或还没有搭配）')
      onChanged(true)
    } catch (e) {
      fail((e && e.message) || '补建失败')
    }
    clozeBtn.disabled = false
  }

  $('#me-clearcache').onclick = async () => {
    if (!(await confirmDialog({
      title: '清理本地缓存？',
      sub: '只影响这台设备，云端进度不受影响',
      okText: '清理',
    }))) return
    S.clearLocal()
    ok('已清理，正在重新拉取')
    try {
      await S.syncPull()
      onChanged(true)
    } catch (e) {
      fail('重新拉取失败，请检查网络')
    }
  }

  $('#me-signout').onclick = async () => {
    if (!(await confirmDialog({ title: '退出登录？', sub: '本地缓存会一并清除，云端数据保留', okText: '退出', danger: true }))) return
    await AUTH.signOut()
    onSignOut()
  }
}

/* ───────────────── 导出弹层 ───────────────── */

function openExport() {
  const decks = Array.from(new Set(S.state.cards.map((c) => c.deck).filter(Boolean)))
  const recentCut = Date.now() - 7 * 86400000

  const scopes = [
    { k: 'all', label: '全部词条', n: S.state.cards.length },
    { k: 'due', label: '待复习', n: S.dueCards().length },
    { k: 'recent', label: '最近 7 天学过', n: S.state.cards.filter((c) => c.last_review_at && new Date(c.last_review_at).getTime() > recentCut).length },
    { k: 'mastered', label: '记忆稳定', n: S.state.cards.filter(FSRS.isMastered).length },
  ]

  openModal(
    '<h3>导出背诵手册</h3><p class="sub">选择范围和格式，文件会直接下载到本机</p>' +
    '<div class="field"><label>范围</label></div>' +
    scopes.map((s) =>
      '<label class="check"><input type="radio" name="ex-scope" value="' + s.k + '"' + (s.k === 'all' ? ' checked' : '') + '>' +
      '<span><span class="t">' + esc(s.label) + '</span><span class="d">' + s.n + ' 个词条</span></span></label>'
    ).join('') +
    (decks.length
      ? '<div class="field" style="margin-top:6px;"><label>或按词单</label><select class="input" id="ex-deck">' +
        '<option value="">不按词单</option>' +
        decks.map((d) => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('') +
        '</select></div>'
      : '') +
    '<div class="field"><label>格式</label></div>' +
    '<label class="check"><input type="radio" name="ex-fmt" value="md" checked>' +
    '<span><span class="t">Markdown (.md)</span><span class="d">纯文本，方便放进笔记软件</span></span></label>' +
    '<label class="check"><input type="radio" name="ex-fmt" value="docx">' +
    '<span><span class="t">Word (.docx)</span><span class="d">带表格排版，适合打印</span></span></label>' +
    '<label class="check"><input type="radio" name="ex-fmt" value="copy">' +
    '<span><span class="t">复制到剪贴板</span><span class="d">手机端下载不便时用它</span></span></label>' +
    '<div id="ex-progress" class="tiny" style="min-height:18px;"></div>' +
    '<div class="modal-actions"><button class="btn" id="ex-cancel">取消</button>' +
    '<button class="btn primary" id="ex-go">生成</button></div>'
  )

  $('#ex-cancel').onclick = closeModal

  $('#ex-go').onclick = async () => {
    const scope = ($('input[name="ex-scope"]:checked') || {}).value || 'all'
    const fmt = ($('input[name="ex-fmt"]:checked') || {}).value || 'md'
    const deck = ($('#ex-deck') || {}).value || ''

    let list = S.state.cards.slice()
    if (scope === 'due') list = S.dueCards()
    if (scope === 'recent') list = list.filter((c) => c.last_review_at && new Date(c.last_review_at).getTime() > recentCut)
    if (scope === 'mastered') list = list.filter(FSRS.isMastered)
    if (deck) list = list.filter((c) => c.deck === deck)

    const items = list
      .map((c) => ({ card: c, word: S.wordOf(c) }))
      .filter((x) => x.word)

    if (!items.length) return fail('该范围内没有词条')

    const prog = $('#ex-progress')
    const btn = $('#ex-go')
    btn.disabled = true
    prog.textContent = '正在生成 ' + items.length + ' 个词条…'

    const opts = {
      title: '英语搭配背诵手册',
      date: Date.now(),
      retention: Number(S.state.settings.target_retention) || 0.9,
    }

    try {
      if (fmt === 'copy' || fmt === 'md') {
        const md = EXP.buildMarkdown(items, opts)
        if (fmt === 'copy') {
          const okc = await EXP.copyText(md)
          closeModal()
          okc ? ok('已复制到剪贴板') : fail('复制失败，请改用 .md 下载')
        } else {
          EXP.downloadText(md, EXP.stampName('背诵手册', 'md'))
          closeModal()
          ok('已导出 ' + items.length + ' 个词条')
        }
      } else {
        prog.textContent = '正在排版 Word 文档…'
        const r = await EXP.exportDocx(items, opts)
        EXP.downloadBlob(r.blob, EXP.stampName('背诵手册', r.ext))
        closeModal()
        ok(r.degraded
          ? '已导出 ' + items.length + ' 个词条（Word 组件未加载，已降级为 .doc，Word 可直接打开）'
          : '已导出 ' + items.length + ' 个词条')
      }
    } catch (e) {
      btn.disabled = false
      prog.textContent = ''
      fail((e && e.message) || '导出失败')
    }
  }
}
