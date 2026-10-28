/**
 * store.js — 应用状态、本地缓存与云端同步
 *
 * 策略：本地优先。所有卡片与词条先落到本地（localStorage）立即可用，
 * 再异步推到云端；换设备登录时从云端整体拉回。单用户跨设备不会并发改同一张卡，
 * 因此采用「以云端为权威 + 本地乐观更新」的简单模型。
 */
import { db, getSession } from './cloud.js?v=114'
import { LS_KEYS, DEFAULT_SETTINGS } from './config.js?v=114'
import * as FSRS from './fsrs.js?v=114'
/* 目标完成度的纯算术单独成模块，方便离线单测（工具页与今日页共用同一口径）。 */
export { goalCompletion } from './goal-metrics.js?v=114'

export const state = {
  booted: false,
  user: null,
  accountEmail: '',
  settings: Object.assign({}, DEFAULT_SETTINGS),
  words: [],          // [{ id, normalized, lemma, payload, ... }]
  cards: [],          // [{ id, word_id, deck, card_type, status, due, stability, ... }]
  daily: [],          // [{ reviewed_on, total, correct, new_words, minutes }]
  syncAt: 0,
  syncing: false,
  lastError: null,
  /* 测试模式（**会话级，不持久化**）：开启后所有作答写入都带 is_test=true，
     服务端据此跳过调度更新。刷新页面即失效 —— 测试状态不该被意外留存，
     否则用户某天会发现自己"看着一切正常"但进度不再前进。 */
  testSession: false,
  /* ── 加载状态 ──
     为什么单独立一块：词条/卡片/日志都是数组，而"数组是空的"有两种完全不同的含义 ——
     ① 还没拉回来 ② 云端真的没有。旧代码把两者当同一件事，于是冷启动时会显示
     "词库还是空的，去导入词单"。用户看到这句话的第一反应是去重新导入，
     那才是真正会造成数据破坏的误导（任务书 01 LOAD）。
     所以每类数据必须有独立状态，渲染层先问状态再决定说什么。 */
  load: {
    phase: 'idle',      // idle | loading | ready | error
    error: '',
    at: 0,              // 上次成功同步的时间
    hydrated: false,    // 本地是否有过一次完整数据（含本次会话之前缓存的）
    fromCache: false,   // 当前展示的是本地缓存，还没和云端对齐
  },
}

const wordIndex = new Map()   // normalized -> word row
const cardIndex = new Map()   // `${word_id}:${card_type}` -> card row
/* id -> word row。wordOf() 是**每次渲染、每张卡**都会走的热路径，
   用 Array.find 线性查找的话，3000 张卡 × 2700 个词 = 每次 800 万次比较：
   2026-10-17 实测 buildQueue 单次 392ms，首页和角标各调一次就卡到秒级。
   这里做 O(1) 索引，并用 (数组引用 + 长度) 做失效判定 —— 只要 state.words
   被整体替换或增删，索引就会自动重建，不需要调用方记得手动刷新。 */
let wordById = new Map()
let wordByIdSrc = null
let wordByIdLen = -1

function ensureWordIndex() {
  if (wordByIdSrc === state.words && wordByIdLen === state.words.length) return
  wordByIdSrc = state.words
  wordByIdLen = state.words.length
  wordById = new Map()
  for (const w of state.words) wordById.set(w.id, w)
}

export function reindex() {
  wordIndex.clear()
  cardIndex.clear()
  state.words.forEach((w) => wordIndex.set(w.normalized, w))
  state.cards.forEach((c) => cardIndex.set(c.word_id + ':' + c.card_type, c))
  wordByIdSrc = null        // 强制下次 wordOf() 重建 id 索引
}

export function wordOf(card) {
  if (!card) return null
  ensureWordIndex()
  return wordById.get(card.word_id) || null
}

/* ───────────────────────── 本地持久化 ───────────────────────── */

export function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEYS.state)
    if (!raw) return false
    const saved = JSON.parse(raw)
    if (saved && typeof saved === 'object') {
      state.words = Array.isArray(saved.words) ? saved.words : []
      state.cards = Array.isArray(saved.cards) ? saved.cards : []
      state.settings = Object.assign({}, DEFAULT_SETTINGS, saved.settings || {})
      state.daily = Array.isArray(saved.daily) ? saved.daily : []
      state.accountEmail = typeof saved.accountEmail === 'string' ? saved.accountEmail : ''
      state.syncAt = saved.syncAt || 0
      reindex()
      // 本地有缓存 ≠ 数据已就绪：它可能已经是三天前的了。
      // 标成 fromCache，渲染层据此显示"上次更新于 X，正在同步最新"。
      if (state.words.length || state.cards.length) {
        state.load.hydrated = true
        state.load.fromCache = true
        state.load.at = state.syncAt || 0
      }
      return true
    }
  } catch (e) {
    /* 缓存损坏时静默重建，不影响使用 */
  }
  return false
}

let saveTimer = null
export function saveLocal() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        LS_KEYS.state,
        JSON.stringify({
          words: state.words,
          cards: state.cards,
          settings: state.settings,
          daily: state.daily,
          accountEmail: state.accountEmail,
          syncAt: state.syncAt,
        })
      )
    } catch (e) {
      /* 超出配额时忽略，云端仍保有数据 */
    }
  }, 250)
}

export function clearLocal() {
  try {
    localStorage.removeItem(LS_KEYS.state)
    localStorage.removeItem(LS_KEYS.lastSync)
  } catch (e) {
    /* ignore */
  }
}

/* ───────────────────────── 云端拉取 ───────────────────────── */

/**
 * 时间字段统一在「内存里用毫秒数、落库时转 ISO 字符串」。
 * 否则 PostgREST 会因为把数字塞进 timestamptz 列而返回 400，
 * 而 ISO 字符串参与算术又会得到 NaN —— 两边都必须归一化。
 */
function normalizeCardRow(row) {
  return Object.assign({}, row, {
    due: row.due != null ? new Date(row.due).getTime() : Date.now(),
    last_review_at: row.last_review_at != null ? new Date(row.last_review_at).getTime() : null,
  })
}

export async function syncPull() {
  if (!state.user) return
  state.syncing = true
  state.lastError = null
  // 已有本地数据时不把 phase 打成 loading：那样整页会从"有内容"闪成"正在同步…"，
  // 用户会以为数据没了。只有真的一份都没有时才需要占位提示。
  if (!state.load.hydrated) {
    state.load.phase = 'loading'
    state.load.error = ''
    notifySync()
  }
  try {
    // 数据面单次最多返回 1000 行 —— 不分页的话，卡片超过 1000 张的用户只会看到一部分
    // （数据没丢，只是没加载），表现为词库/统计少一大截。这里按 500 一页翻到底。
    const PAGE = 500
    const allCards = []
    const probe = db().from('cards').select('*')
    if (typeof probe.range === 'function') {
      // 必须按唯一列 id 排序：按 due 排序时，同一时刻到期的成百上千张卡会并列，
      // 翻页（OFFSET）在并列值上不稳定，会重复取到同几行、漏掉另几行
      for (let from = 0; from < 50000; from += PAGE) {
        const res = await db().from('cards').select('*')
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (res.error) throw res.error
        const batch = Array.isArray(res.data) ? res.data : []
        allCards.push.apply(allCards, batch)
        if (batch.length < PAGE) break
      }
    } else {
      // 极端兜底：客户端不支持 range 时，尽量一次多要（受服务端上限约束）
      const res = await probe.order('id', { ascending: true }).limit(5000)
      if (res.error) throw res.error
      allCards.push.apply(allCards, Array.isArray(res.data) ? res.data : [])
    }
    state.cards = allCards.map(normalizeCardRow)

    /* ⚠ 顺序：**先拉设置、再锁今日目标**。
       ensureDayPlan 会写库（pushSettings），如果它先跑，会把本会话还没拉回来的旧设置
       （新设备/清过缓存时是空对象）原样推回去、整行覆盖 —— 达标历史就是这样被清掉过的
       （2026-10-14 实测定位，settings 的 upsert 是整列替换，不是字段合并）。 */
    const setRes = await db().from('settings').select('*').maybeSingle()
    if (!setRes.error && setRes.data) {
      state.settings = Object.assign({}, DEFAULT_SETTINGS, setRes.data.extra || {}, {
        daily_new: setRes.data.daily_new,
        daily_max_review: setRes.data.daily_max_review,
        target_retention: Number(setRes.data.target_retention),
      })
      /* goal_days 双保险：服务端独立表 ∪ 本地（还没推上去的标记）。
         权威来源是 goal_days 表（追加式，顶不掉）；本地并集保证离线标记不丢。 */
      try {
        const serverDays = await fetchGoalDays()
        state.settings.goal_days = trimGoalDays(Object.assign({}, serverDays, goalDays()))
      } catch (e) { /* 表暂时不可用：保留本地标记，绝不反向清空 */ }
    }

    ensureDayPlan()   // 当天第一次同步时锁定"今日目标"，用于达标判定

    const wordIds = Array.from(new Set(state.cards.map((c) => c.word_id))).filter(Boolean)
    const words = []
    for (let i = 0; i < wordIds.length; i += 100) {
      const slice = wordIds.slice(i, i + 100)
      const res = await db().from('words').select('*').in('id', slice)
      if (res.error) throw res.error
      if (Array.isArray(res.data)) words.push.apply(words, res.data)
    }
    state.words = words

    reindex()
    await pullStats()
    pushGoalDays().catch(() => {})   // 本地有、服务端还没有的达标标记补推（追加式、幂等）
    state.syncAt = Date.now()
    state.load.phase = 'ready'
    state.load.error = ''
    state.load.at = state.syncAt
    state.load.hydrated = true
    state.load.fromCache = false
    saveLocal()
  } catch (e) {
    state.lastError = e && e.message ? e.message : String(e)
    state.load.phase = 'error'
    state.load.error = state.lastError
    throw e
  } finally {
    state.syncing = false
    notifySync()
  }
}

/* ───────────────────── 加载状态查询（供渲染层判断"说什么"） ───────────────────── */

/** 数据是不是还没准备好。**只有一次都没成功拉过、且本地也没缓存时才算** ——
 *  有缓存就照常渲染，只在顶部挂一条"正在同步"的细条。 */
export function dataPending() {
  if (!state.user) return false
  if (state.load.hydrated) return false
  return state.load.phase === 'idle' || state.load.phase === 'loading'
}

/** 数据这次没拉到，且本地也没缓存可用 —— 必须显示错误 + 重试，而不是"空库" */
export function dataFailed() {
  return state.load.phase === 'error' && !state.load.hydrated
}

/** 是否正在后台同步（已有缓存时才有意义） */
export function dataSyncing() {
  return state.syncing && state.load.hydrated
}

export function hasLocalData() {
  return state.words.length > 0 || state.cards.length > 0
}

export function loadState() {
  return {
    phase: state.load.phase,
    error: state.load.error,
    at: state.load.at,
    hydrated: state.load.hydrated,
    fromCache: state.load.fromCache,
    pending: dataPending(),
    failed: dataFailed(),
    syncing: state.syncing,
  }
}

/** 登出 / 换账号时重置加载状态。
 *  不重置的后果很具体：hydrated 还留着 true，新账号登录后会先拿上一个账号
 *  的缓存去渲染，而 dataPending() 又说"已就绪" —— 用户会短暂看到别人的数据。 */
export function resetLoad() {
  state.load.phase = 'idle'
  state.load.error = ''
  state.load.at = 0
  state.load.hydrated = false
  state.load.fromCache = false
}

/* ───────────────────── 测试模式 ───────────────────── */

/** 当前是否处于测试模式。测试作答会完整运行界面与判分，
 *  但服务端不会更新调度、打卡、每日目标与薄弱词。 */
export function isTestSession() {
  return state.testSession === true
}

export function setTestSession(v) {
  state.testSession = v === true
}

/* 同步完成的通知：加载中/失败时用户可能已经切到别的页，
   必须由数据层主动叫一次重绘，而不是要求用户来回切页或强刷。 */
const syncListeners = []
export function onSyncDone(cb) { syncListeners.push(cb) }
function notifySync() {
  syncListeners.forEach((f) => { try { f(loadState()) } catch (e) { /* 单个监听器出错不影响其它 */ } })
}

export async function pullStats() {
  const res = await db().rpc('study_stats')
  if (res.error) throw res.error
  state.daily = Array.isArray(res.data) ? res.data : []
  /* 统计到位后补一次达标记账：评分时的检查发生在写库**之前**，永远慢一拍 ——
     最后一张卡刚好把条件凑齐时，那次达标就永远记不上（2026-10-14 定位的第三个漏点）。
     放在这里一处覆盖所有流（学习页 / 练习场 / 抽测）。 */
  try { markGoalIfMet() } catch (e) { /* 记账失败不影响统计展示 */ }
}

/* ───────────────────────── 云端写入 ───────────────────────── */

export async function pushSettings() {
  if (!state.user) return
  const row = {
    daily_new: state.settings.daily_new,
    daily_max_review: state.settings.daily_max_review,
    target_retention: state.settings.target_retention,
    extra: Object.assign({}, state.settings.extra || {}, {
      card_types: state.settings.card_types,
      deck: state.settings.deck,
      llm_model: state.settings.llm_model || null,
      quiz_stars: state.settings.quiz_stars || {},
      last_backup_at: state.settings.last_backup_at || null,
      backup_snooze_until: Number(state.settings.backup_snooze_until) || 0,
      test_mode: state.settings.test_mode || 'mixed',
      theme: state.settings.theme || 'green',
      auto_credit: String(state.settings.auto_credit) === 'true',
      rest_weekday: String(state.settings.rest_weekday) === '0' ? 0 : null,
      topic_filter: state.settings.topic_filter || '',
      goal_include_test: String(state.settings.goal_include_test) === 'true',
      last_test_at: Number(state.settings.last_test_at) || null,
      // goal_days 不在这里推：upsert 是**整列替换**，任何一次带旧 map 的整行推送
      // 都会把服务端那份历史顶掉（实测已发生过）。改为 goal_days 独立表的追加式
      // 写入，见 pushGoalDays()；读侧走 fetchGoalDays() 并集合并。
      day_plan: state.settings.day_plan || null,
      deck_filter: state.settings.deck_filter || '',
      stories: Array.isArray(state.settings.stories) ? state.settings.stories.slice(0, 20) : [],
      learn_step_minutes: Number(state.settings.learn_step_minutes) || 10,
      learn_step_days: Number(state.settings.learn_step_days) || 1,
      queue_interleave: Number(state.settings.queue_interleave) || 4,
      pause_new_when_overdue: String(state.settings.pause_new_when_overdue) !== 'false',
    }),
  }
  const res = await db().from('settings').upsert(row, { onConflict: 'owner_id' })
  if (res.error) throw res.error
}

export async function persistCard(card) {
  const res = await db()
    .from('cards')
    .update({
      status: card.status,
      due: new Date(card.due).toISOString(),
      stability: card.stability,
      difficulty: card.difficulty,
      reps: card.reps,
      lapses: card.lapses,
      suspended: card.suspended,
      last_review_at: card.last_review_at ? new Date(card.last_review_at).toISOString() : null,
      last_grade: card.last_grade,
      deck: card.deck,
    })
    .eq('id', card.id)
    .select()
  if (res.error) throw res.error
  if (!Array.isArray(res.data) || res.data.length === 0) {
    throw new Error('云端未更新这张卡片（可能已被其他设备改动或不属于当前账号）')
  }
}

export async function persistReview(log, card) {
  const row = {
    card_id: card.id,
    word_id: card.word_id,
    grade: log.grade,
    elapsed_ms: log.elapsed_ms || null,
    prev_state: log.prev_state,
    next_state: log.next_state,
    source: log.source || 'study',   // study=学习页 / game=练习场 / test=抽测，便于分开统计
    // 判分维度（2026-10-09 增量加列）：留空表示"这次没有作答判定"（如自评卡）
    verdict: log.verdict || null,     // hit / alt / wrong / unsure
    hinted: log.hinted === true,      // 用了"听答案"之类提示
    assisted: log.assisted === true,  // 靠选项辅助选出来的
  }
  const res = await db().from('reviews').insert(row)
  if (res.error) throw res.error
}

/** 一次作答的事件 ID：服务端幂等键。
 *  同一次作答在重试/补写时必须复用同一个 ID，否则会被当成两次复习。 */
export function newEventId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/**
 * 写入一次复习 —— **走服务端函数，在同一个事务里完成"记日志 + 更新调度"**。
 *
 * 为什么不再用两次客户端调用（persistCard + persistReview）：
 * ① **测试/审计事件在函数内部就不会更新 cards**。前端那层开关可以被绕过
 *    （任何人都能直接调 REST API），但函数里的这条判断绕不过去 ——
 *    这才是方案要求的"写入控制放服务端"。
 * ② **幂等**：client_event_id 上有唯一索引，重复点击、网络重试、刷新重放
 *    都只会产生一条日志、一次调度更新。
 * ③ **事务一致**：不会出现"日志写了、卡片没更新"的半截状态。
 *
 * @param {object} log    applyGrade 产出的日志（含 prev_state / next_state）
 * @param {object} card   对应卡片
 * @param {{eventId?:string, isTest?:boolean}} opts
 * @returns {Promise<{ok:boolean, dedup:boolean, scheduler_applied:boolean}>}
 */
export async function recordReview(log, card, opts) {
  const o = opts || {}
  const res = await db().rpc('record_review', {
    p_card_id: card.id,
    p_word_id: card.word_id,
    p_grade: log.grade,
    p_elapsed_ms: log.elapsed_ms || null,
    p_prev_state: log.prev_state,
    p_next_state: log.next_state,
    p_source: log.source || 'study',
    p_verdict: log.verdict || null,
    p_hinted: log.hinted === true,
    p_assisted: log.assisted === true,
    p_is_test: o.isTest === true,
    p_event_id: o.eventId || newEventId(),
  })
  if (res.error) throw res.error
  return res.data || null
}

/** 删除整个词单的卡片（复习记录保留为历史）。返回实际删除的张数。 */
export async function deleteCardsByDeck(deck) {
  const res = await db().from('cards').delete().eq('deck', deck).select()
  if (res.error) throw res.error
  const removed = Array.isArray(res.data) ? res.data : []
  if (removed.length === 0) throw new Error('云端没有删除任何卡片，请确认是否已登录')
  const gone = new Set(removed.map((c) => c.id))
  state.cards = state.cards.filter((c) => !gone.has(c.id))
  reindex()
  return removed.length
}

/* ───────────────────────── 导入批次 ─────────────────────────
   一次导入打一个批次号，这样「删掉上次那份文件」不用连累别的导入。 */

export function newBatchId(d) {
  const t = d || new Date()
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return String(t.getFullYear()) + p(t.getMonth() + 1) + p(t.getDate()) +
    '-' + p(t.getHours()) + p(t.getMinutes())
}

/** 把批次号渲染成人话 */
export function batchLabel(batch) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(batch || ''))
  if (!m) return '早期导入（无批次号）'
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]
}

/** 列出导入批次（从本地卡片聚合，不需要额外表） */
export function listBatches() {
  const map = new Map()
  state.cards.forEach((c) => {
    const key = c.batch || ''
    if (!map.has(key)) map.set(key, { batch: key, decks: new Set(), words: new Set(), cards: 0 })
    const g = map.get(key)
    if (c.deck) g.decks.add(c.deck)
    g.words.add(c.word_id)
    g.cards++
  })
  return Array.from(map.values())
    .map((g) => ({
      batch: g.batch,
      label: batchLabel(g.batch),
      decks: Array.from(g.decks).join('、'),
      words: g.words.size,
      cards: g.cards,
    }))
    .sort((a, b) => String(b.batch).localeCompare(String(a.batch)))
}

/** 删除某一次导入的全部卡片 */
export async function deleteCardsByBatch(batch) {
  let q = db().from('cards').delete()
  q = batch ? q.eq('batch', batch) : q.is('batch', null)
  const res = await q.select()
  if (res.error) throw res.error
  const removed = Array.isArray(res.data) ? res.data : []
  if (removed.length === 0) throw new Error('云端没有删除任何卡片，请确认是否已登录')
  const gone = new Set(removed.map((c) => c.id))
  state.cards = state.cards.filter((c) => !gone.has(c.id))
  reindex()
  saveLocal()
  return removed.length
}

/* ───────────────────────── 备份 / 恢复 ─────────────────────────
   words + cards + 设置 打成一个 JSON。学习记录（reviews）不在本地，
   恢复时不覆盖已有进度（卡片按唯一键忽略重复）。 */

/**
 * 备份：词条 + 卡片 + 设置 + 日程 + 最近复习日志。
 * 复习日志原本不导出，换机后遗忘曲线与热力图全断；这里补上（默认最近 5000 条）。
 * 注意：恢复时日志不回写（备份里的 card_id 在新环境已失效），仅作存档与自分析。
 */
export async function buildBackup(opts) {
  const limit = (opts && opts.reviewLimit) || 5000
  let reviews = []
  /* 复习日志在云端。网络"挂起"（不是报错、是一直不返回）时不能把整份备份拖死：
     词条 / 卡片 / 设置才是备份主体，日志只是锦上添花。
     8 秒拉不到就当没有——否则用户点「导出备份」会永远停在「正在打包…」，
     还会误以为导出失败。 */
  let timer = null
  try {
    reviews = await Promise.race([
      fetchReviews(limit),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('复习日志拉取超时')), 8000)
      }),
    ])
  } catch (e) {
    reviews = []   // 拉不到日志不阻断备份
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!Array.isArray(reviews)) reviews = []
  return {
    app: 'lexiloop',
    version: 2,
    exported_at: new Date().toISOString(),
    words: state.words,
    cards: state.cards,
    settings: state.settings,
    daily: state.daily,
    reviews,
    has_reviews: reviews.length > 0,
  }
}

/** 备份里的时间可能是毫秒数（内存态）也可能是 ISO 串，落库前统一成 ISO，否则 timestamptz 拒收 */
function toIsoTime(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return new Date(v).toISOString()
  const t = new Date(v)
  return isNaN(t.getTime()) ? null : t.toISOString()
}

/** 恢复：只补缺，不覆盖 —— 已存在的词/卡保持原样（进度不受影响） */
export async function restoreBackup(obj) {
  if (!obj || obj.app !== 'lexiloop') throw new Error('不是本应用的备份文件')
  // 版本校验：比当前应用还新的备份，结构可能已经变了，硬恢复会写坏数据
  const ver = Number(obj.version) || 1
  if (ver > 2) throw new Error('备份版本（v' + ver + '）比当前应用新，请先更新应用再恢复')
  const words = Array.isArray(obj.words) ? obj.words : []
  const cards = Array.isArray(obj.cards) ? obj.cards : []
  if (!words.length && !cards.length) throw new Error('备份里没有可恢复的数据')

  // 跨环境恢复时 word id 对不上：先记「旧 id → normalized」，词条写入后建「normalized → 新 id」
  const normByOldId = new Map()
  words.forEach((w) => { if (w && w.normalized && w.id != null) normByOldId.set(String(w.id), w.normalized) })
  const idByNorm = new Map()

  let nWords = 0
  const wordRows = words
    .filter((w) => w && w.normalized)
    .map((w) => ({
      normalized: w.normalized, lemma: w.lemma || w.normalized,
      payload: w.payload || {}, ipa: w.ipa || null,
      enrich_status: w.enrich_status || 'ok', enrich_model: w.enrich_model || null,
      prompt_version: w.prompt_version || null, confidence: w.confidence || null,
    }))
  for (let i = 0; i < wordRows.length; i += 100) {
    const slice = wordRows.slice(i, i + 100)
    const res = await db().from('words').upsert(slice, { onConflict: 'normalized', ignoreDuplicates: false }).select()
    if (res.error) throw res.error
    nWords += Array.isArray(res.data) ? res.data.length : 0
    ;(Array.isArray(res.data) ? res.data : []).forEach((w) => {
      if (w && w.normalized) idByNorm.set(w.normalized, w.id)
    })
  }

  let nCards = 0
  const cardRows = cards
    .filter((c) => {
      if (!c || c.word_id == null) return false
      const norm = normByOldId.get(String(c.word_id))
      return !!(norm && idByNorm.has(norm))   // 词条没恢复成功的卡只能跳过，否则指向空词
    })
    .map((c) => ({
      word_id: idByNorm.get(normByOldId.get(String(c.word_id))),
      deck: c.deck || '恢复', card_type: c.card_type || 'recognition',
      batch: c.batch || null, status: c.status || 'new',
      stability: c.stability || 0, difficulty: c.difficulty || 0,
      reps: c.reps || 0, lapses: c.lapses || 0,
      due: toIsoTime(c.due) || new Date().toISOString(),
      last_review_at: toIsoTime(c.last_review_at), last_grade: c.last_grade || null,
      suspended: !!c.suspended,
    }))
  for (let i = 0; i < cardRows.length; i += 100) {
    const slice = cardRows.slice(i, i + 100)
    const res = await db().from('cards').upsert(slice, { onConflict: 'owner_id,word_id,card_type', ignoreDuplicates: true }).select()
    if (res.error) throw res.error
    nCards += Array.isArray(res.data) ? res.data.length : 0
  }

  // ── 设置：无则写入；已有则保留现有（与"只补缺"同一原则，不覆盖用户已调好的值）──
  let settingsRestored = 0
  if (obj.settings && typeof obj.settings === 'object') {
    const cur = await db().from('settings').select('owner_id').maybeSingle()
    if (cur.error) throw cur.error
    if (!cur.data) {
      const s = obj.settings
      const res = await db().from('settings').upsert({
        daily_new: Number(s.daily_new) || 20,
        daily_max_review: Number(s.daily_max_review) || 200,
        target_retention: Number(s.target_retention) || 0.9,
        extra: Object.assign({}, s.extra || {}, {
          learn_step_minutes: Number(s.learn_step_minutes) || 10,
          learn_step_days: Number(s.learn_step_days) || 1,
          queue_interleave: Number(s.queue_interleave) || 4,
        }),
      }, { onConflict: 'owner_id' })
      if (res.error) throw res.error
      settingsRestored = 1
    }
  }

  // ── 复习日志回写：跨库里 card_id 已失效，按「词条 + 卡型」重建映射后补插 ──
  let nReviews = 0
  let reviewSkipped = 0
  const revs = Array.isArray(obj.reviews) ? obj.reviews : []
  if (revs.length) {
    const cardsRes = await db().from('cards').select('id, word_id, card_type')
    if (cardsRes.error) throw cardsRes.error
    const cardKey = new Map()
    ;(Array.isArray(cardsRes.data) ? cardsRes.data : []).forEach((c) => {
      cardKey.set(c.word_id + ':' + c.card_type, c.id)
    })
    // 备份日志里的 word 字段可能是 lemma 或 normalized，两条路都建索引
    const nameToWordId = new Map()
    idByNorm.forEach((wid, norm) => nameToWordId.set(String(norm).toLowerCase(), wid))
    words.forEach((w) => {
      if (!w || !w.normalized) return
      const wid = idByNorm.get(w.normalized)
      if (wid && w.lemma) nameToWordId.set(String(w.lemma).toLowerCase(), wid)
    })
    const rows = []
    revs.forEach((r) => {
      const wid = nameToWordId.get(String(r.word || '').toLowerCase())
      if (!wid) { reviewSkipped++; return }
      const cid = cardKey.get(wid + ':' + (r.card_type || 'recognition'))
      if (!cid) { reviewSkipped++; return }
      const row = {
        card_id: cid, word_id: wid,
        grade: Math.min(4, Math.max(1, Number(r.grade) || 3)),
        elapsed_ms: r.elapsed_ms == null ? null : Math.max(0, Number(r.elapsed_ms) || 0),
      }
      const at = toIsoTime(r.created_at)
      if (at) row.created_at = at
      rows.push(row)
    })
    // 分块插入；单块失败时去掉 created_at 再试该块（个别环境不允许客户端写时间戳）
    for (let i = 0; i < rows.length; i += 200) {
      const slice = rows.slice(i, i + 200)
      let res = await db().from('reviews').insert(slice)
      if (res.error) {
        const bare = slice.map((r) => { const { created_at, ...rest } = r; return rest })
        res = await db().from('reviews').insert(bare)
        if (res.error) { reviewSkipped += slice.length; continue }
      }
      nReviews += slice.length
    }
  }

  await syncPull()
  return {
    words: nWords, cards: nCards,
    skippedCards: cards.length - cardRows.length,
    settingsRestored, reviews: nReviews, reviewSkipped,
  }
}

/** 把复习日志拉进内存（不写 localStorage：1000 行约 150KB，太大），
 *  统计页展示后再算指标，避免每次进页面都请求。 */
export async function pullMetrics(limit, force) {
  if (state.reviewRows && !force) return state.reviewRows
  if (state.reviewRowsLoading) return null
  state.reviewRowsLoading = true
  try {
    state.reviewRows = await fetchReviewRows(limit || 1000)
    state.reviewRowsAt = Date.now()
  } finally {
    state.reviewRowsLoading = false
  }
  return state.reviewRows
}

/* ───────────────────────── 记忆指标 ─────────────────────────
   这些数字回答的是"我到底记住了没有"，而不是"我学了多少"。 */

/** 拉最近的复习原始行（含 source / 前后状态，用于算保持率） */
export async function fetchReviewRows(limit) {
  const res = await db().from('reviews')
    .select('card_id, grade, source, elapsed_ms, prev_state, created_at')
    // 与 fetchReviews / 服务端 study_stats() 保持同一口径：
    // 只排除 is_test（测试模式/审计事件），**保留 source='test'（每周抽测）** ——
    // 抽测是真实练习，统计页要靠它算出"认出 vs 说出"的差距。
    // 少了这个过滤，一次外部审计就会混进用户的记忆指标里（2026-10-10 外部复测指出）。
    .eq('is_test', false)
    .order('id', { ascending: false })
    .limit(limit || 1000)
  if (res.error) throw res.error
  return Array.isArray(res.data) ? res.data : []
}

/**
 * 把复习日志算成指标：
 *  - passRate：一次通过率（grade ≥ 3）
 *  - predicted：FSRS 预测保持率（用上一次复习后的 stability + 实际间隔算 R）
 *  - avgMs：平均反应时间（学习 = 认真回忆，游戏/抽测 = 快速识别）
 *  - bySource：按来源拆分（study / game / test），看得出"认出"和"说出"的差距
 */
export function memoryMetrics(rows) {
  const list = (rows || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const byCard = new Map()
  list.forEach((r) => {
    const k = String(r.card_id)
    if (!byCard.has(k)) byCard.set(k, [])
    byCard.get(k).push(r)
  })

  let n = 0, pass = 0, msSum = 0, msN = 0, predSum = 0, predN = 0
  let firstN = 0, firstPass = 0, repeatN = 0, repeatPass = 0
  // 判分维度：这三项在 2026-10-09 之前没有记录，只有新日志会带上，
  // 所以要把"有记录的总数"一起返回，界面上才能说清覆盖率而不是拿旧数据糊弄
  let judgedN = 0, unsureN = 0, altN = 0, hintedN = 0, assistedN = 0
  const bySource = {}
  const bump = (src) => {
    if (!bySource[src]) bySource[src] = { n: 0, pass: 0, msSum: 0, msN: 0, firstN: 0, firstPass: 0 }
    return bySource[src]
  }

  byCard.forEach((arr) => {
    arr.forEach((r, i) => {
      const src = r.source || 'study'
      const b = bump(src)
      n++
      b.n++
      const ok = Number(r.grade) >= 3
      if (ok) { pass++; b.pass++ }
      /* 「一次通过率」只认每张卡的**第一次**复习。
         把同一张卡的所有复习混在一起算，越熟练越拉高这个数，
         它就不再是"第一次见面能不能想起来"的意思了 —— 指标名和算法必须对得上。
         同时单独留一份"非首次"的通过率：FSRS 的预测保持率算的是**复习前**的
         回忆概率，只有和它同口径的一组数据才能拿来比较。 */
      if (i === 0) {
        firstN++; b.firstN++
        if (ok) firstPass++; if (ok) b.firstPass++
      } else {
        repeatN++; if (ok) repeatPass++
      }
      const ms = Number(r.elapsed_ms) || 0
      if (ms > 0) { msSum += ms; msN++; b.msSum += ms; b.msN++ }
      if (r.verdict) {
        judgedN++
        if (r.verdict === 'unsure') unsureN++
        if (r.verdict === 'alt') altN++
      }
      if (r.hinted === true) hintedN++
      if (r.assisted === true) assistedN++
      // 预测保持率：用"本次复习前的 stability"与实际间隔配对
      if (i > 0) {
        const st = Number((r.prev_state || {}).stability) || 0
        const gapDays = (new Date(r.created_at) - new Date(arr[i - 1].created_at)) / 86400000
        if (st > 0 && gapDays > 0) { predSum += FSRS.retrievability(gapDays, st); predN++ }
      }
    })
  })

  const stamps = list.map((r) => r.created_at).filter(Boolean)

  return {
    n,
    passRate: n ? Math.round((pass / n) * 100) : 0,
    firstN,
    firstPassRate: firstN ? Math.round((firstPass / firstN) * 100) : null,
    repeatN,
    repeatPassRate: repeatN ? Math.round((repeatPass / repeatN) * 100) : null,
    judgedN,
    unsureN,
    altN,
    hintedN,
    assistedN,
    predicted: predN ? Math.round((predSum / predN) * 100) : null,
    predN,
    avgMs: msN ? Math.round(msSum / msN) : null,
    // 统计覆盖的日期范围：没有它，"通过率 33%" 到底是哪几天的数据就成了谜
    range: stamps.length ? { from: String(stamps[0]).slice(0, 10), to: String(stamps[stamps.length - 1]).slice(0, 10) } : null,
    bySource: Object.keys(bySource).map((k) => {
      const b = bySource[k]
      return {
        source: k, n: b.n,
        passRate: b.n ? Math.round((b.pass / b.n) * 100) : 0,
        firstN: b.firstN,
        firstPassRate: b.firstN ? Math.round((b.firstPass / b.firstN) * 100) : null,
        avgMs: b.msN ? Math.round(b.msSum / b.msN) : null,
      }
    }).sort((a, b) => b.n - a.n),
  }
}

/** 卡片侧的健康度：复习债 / 成熟卡占比 / 覆盖率 */
export function memoryHealth() {
  const cards = state.cards.filter((c) => !c.suspended)
  const total = cards.length || 1
  const due = dueCards().length
  const mature = cards.filter((c) => Number(c.stability) >= 21).length
  const fresh = cards.filter((c) => c.status === 'new').length
  const started = cards.length - fresh
  return {
    total: cards.length,
    due,
    mature,
    maturePct: Math.round((mature / total) * 100),
    fresh,
    startedPct: Math.round((started / total) * 100),
  }
}

/** 拉最近的复习记录（供导出自分析） */
export async function fetchReviews(limit) {
  const res = await db().from('reviews')
    .select('created_at, grade, elapsed_ms, card_id, word_id, source, verdict, hinted, assisted')
    // 测试/审计事件永远不进正式统计（is_test 由服务端与写入端共同维护）。
    // 少了这个过滤，一次外部审计就会冒充成用户的真实记忆表现。
    .eq('is_test', false)
    .order('created_at', { ascending: false })
    .limit(limit || 1000)
  if (res.error) throw res.error
  const rows = Array.isArray(res.data) ? res.data : []
  // 补上词条与卡型，便于人读
  return rows.map((r) => {
    const card = state.cards.find((c) => c.id === r.card_id)
    const w = card ? wordOf(card) : null
    return {
      created_at: r.created_at, grade: r.grade, elapsed_ms: r.elapsed_ms,
      word: w ? (w.lemma || w.normalized) : '', card_type: card ? card.card_type : '',
    }
  })
}

/* ───────────────────────── 词条与卡片创建 ───────────────────────── */
/* 文本解析（含 Markdown）统一在 importer.js，此处不再重复实现 —— 同一逻辑两处维护
   一定会漂移，时间戳格式那个 bug 就是这么来的。 */

export async function findWords(normalizedList) {
  const found = new Map()
  for (let i = 0; i < normalizedList.length; i += 100) {
    const slice = normalizedList.slice(i, i + 100)
    const res = await db().from('words').select('*').in('normalized', slice)
    if (res.error) throw res.error
    if (Array.isArray(res.data)) res.data.forEach((w) => found.set(w.normalized, w))
  }
  return found
}

/** 写入复核结论。
 *  **只动这三个字段，不碰 payload** —— 复核不改内容，改动由人确认后另行处理。
 *  这样即使复核结论有误，也不会损坏词条本身。 */
export async function putWordVerification(normalized, status, note) {
  const row = { verification_status: status, verify_note: note || null, verified_at: new Date().toISOString() }
  const res = await db().from('words').update(row).eq('normalized', normalized)
  if (res.error) throw res.error
  const w = state.words.find((x) => x.normalized === normalized)
  if (w) {
    w.verification_status = status
    w.verify_note = row.verify_note
  }
  saveLocal()
}

export async function putWord(normalized, lemma, payload) {
  const row = {
    normalized,
    lemma,
    payload,
    enrich_status: 'ok',
    enrich_model: payload && payload.prompt_version ? 'cloud-llm' : null,
    prompt_version: payload ? payload.prompt_version : null,
    confidence: payload && typeof payload.confidence === 'number' ? payload.confidence : null,
    updated_at: new Date().toISOString(),
  }
  /* 生成时的形态校验结果（enrich.js 写在 payload 里）同步到独立列 ——
     否则它只藏在 JSON 里，既查不动也统计不了。
     **只在有值时带上这两个键**：upsert 不更新未提供的列，
     所以重新生成一个已修正的词条不会把 corrected 冲成 null。 */
  if (payload && payload.verification_status) {
    row.verification_status = payload.verification_status
    row.verify_note = payload.verify_note || null
  }
  const res = await db().from('words').upsert(row, { onConflict: 'normalized' }).select()
  if (res.error) throw res.error
  const saved = Array.isArray(res.data) && res.data[0] ? res.data[0] : null
  if (!saved) throw new Error('词条写入云端失败')
  const at = state.words.findIndex((w) => w.normalized === normalized)
  if (at >= 0) state.words[at] = saved
  else state.words.push(saved)
  reindex()
  saveLocal()
  return saved
}

/** 词条是否"能出产出型卡"：cloze 需要搭配 + 至少一条例句，否则挖不出空 */
export function canCloze(word) {
  const p = (word && word.payload) || {}
  const colls = p.collocations || []
  return colls.some((c) => c && (c.examples || []).some((e) => e && e.en))
}

export async function createCards(rows) {
  if (rows.length === 0) return []
  // 内容守卫：没有搭配/例句的词不建 cloze 卡，避免出现"空卡"进学习队列
  const kept = (rows || []).filter((r) => {
    if (!r || r.card_type !== 'cloze') return true
    return canCloze(wordOf({ word_id: r.word_id }))
  })
  if (kept.length === 0) return []
  const res = await db()
    .from('cards')
    .upsert(kept, { onConflict: 'owner_id,word_id,card_type', ignoreDuplicates: true })
    .select()
  if (res.error) throw res.error
  return (Array.isArray(res.data) ? res.data : []).map(normalizeCardRow)
}

/**
 * 补建产出型卡：给"已有搭配/例句但还没有 cloze 卡"的词补上。
 * 生成搭配往往是导入之后才发生的，所以需要这个补建入口。
 * @returns {number} 实际新建的张数
 */
export async function ensureClozeCards(deck) {
  if (!state.user) throw new Error('需要先登录')
  const ids = []
  const seen = new Set()
  state.cards.forEach((c) => { if (c.card_type === 'cloze') seen.add(c.word_id) })
  state.cards.forEach((c) => {
    if (c.card_type !== 'recognition') return
    if (seen.has(c.word_id)) return
    if (deck && c.deck !== deck) return
    if (!canCloze(wordOf(c))) return
    if (ids.indexOf(c.word_id) >= 0) return
    ids.push(c.word_id)
  })
  if (!ids.length) return 0
  const owner = state.cards[0] && state.cards[0].owner_id
  let n = 0
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const rows = slice.map((wid) => {
      const c = state.cards.find((x) => x.word_id === wid && x.card_type === 'recognition')
      return {
        owner_id: owner,
        word_id: wid,
        deck: (c && c.deck) || '恢复',
        card_type: 'cloze',
        batch: 'cloze-backfill',
        status: 'new',
        due: new Date().toISOString(),
      }
    })
    const res = await db().from('cards').upsert(rows, { onConflict: 'owner_id,word_id,card_type', ignoreDuplicates: true }).select()
    if (res.error) throw res.error
    n += Array.isArray(res.data) ? res.data.length : 0
  }
  await syncPull()
  return n
}

/* ───────────────────────── 失败重试队列 ───────────────────────── */
/* 网络抖动时不阻塞学习：本地先行，失败的写入留在队列里等下次同步重放。 */

const pendingCards = new Map()   // card.id -> card
const pendingReviews = []        // { log, card, eventId, isTest }

export function queueCard(card) {
  pendingCards.set(card.id, card)
}

/** 排队等重放。**必须带上 eventId 与 isTest**：
 *  丢了 eventId 会在重放时被当成一次新的复习（重复计分），
 *  丢了 isTest 会把测试作答写进正式调度。 */
export function queueReview(log, card, opts) {
  const o = opts || {}
  pendingReviews.push({
    log, card,
    eventId: o.eventId || newEventId(),
    isTest: o.isTest === true,
  })
}

export function pendingCount() {
  return pendingCards.size + pendingReviews.length
}

/** 退出登录时必须清空：否则换账号后会把上一账号的写入推到新身份下 */
export function clearPending() {
  pendingCards.clear()
  pendingReviews.length = 0
}

/** 重放未同步成功的写入。返回 { cards, reviews, failed } */
export async function flushPending() {
  let cards = 0
  let reviews = 0

  for (const [id, card] of Array.from(pendingCards.entries())) {
    try {
      await persistCard(card)
      pendingCards.delete(id)
      cards++
    } catch (e) {
      /* 留待下次重试 */
    }
  }

  while (pendingReviews.length) {
    const item = pendingReviews[0]
    try {
      // 重放走同一套服务端函数，并复用原来的 eventId ——
      // 服务端的唯一索引会挡住重复，重放永远不会变成"又复习了一次"
      await recordReview(item.log, item.card, { eventId: item.eventId, isTest: item.isTest })
      pendingReviews.shift()
      reviews++
    } catch (e) {
      break
    }
  }

  return { cards, reviews, failed: pendingCards.size + pendingReviews.length }
}

/* ───────────────────────── 学习队列 ───────────────────────── */

export function todayKey(d) {
  const t = d || new Date()
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
}

/* ───────────────────────── 每日达标 ─────────────────────────
   达标 = 当日到期复习清空 + 当日新词达到目标。
   目标在当天第一次同步时锁定，避免"学到一半目标跟着变"。 */

export function goalDays() {
  const m = state.settings.goal_days
  return (m && typeof m === 'object') ? m : {}
}

/** 只保留最近 120 天（本地状态别无限膨胀；服务端 goal_days 表里是全量） */
function trimGoalDays(days) {
  const keep = {}
  Object.keys(days || {}).sort().slice(-120).forEach((k) => { keep[k] = true })
  return keep
}

/** 拉取云端达标表。为什么用独立表而不是 settings.extra：
 *  settings 的写入是**整行 upsert、整列替换** —— 任何一个会话在拉取之前先写设置
 *  （新设备、清过缓存、旧会话晚到），服务端那份 goal_days 就会被一份空/过期的 map
 *  顶掉。2026-10-14 实测：用户 10-07~10-13 逐日满足达标条件，服务端却只剩当天一条。
 *  独立表（owner_id+day 主键）追加式写入，天然只增不减。 */
export async function fetchGoalDays() {
  const res = await db().from('goal_days').select('day').order('day', { ascending: false }).limit(366)
  if (res.error) throw res.error
  const map = {}
  ;(res.data || []).forEach((r) => { if (r && r.day) map[String(r.day).slice(0, 10)] = true })
  return map
}

/** 达标标记上云：追加式写入（重复天忽略），**永远不会覆盖/清空历史**。
 *  owner_id 由列默认值 auth.uid() 填充，无需（也不该）在客户端猜用户 id 的字段结构。 */
export async function pushGoalDays() {
  if (!state.user) return
  const days = Object.keys(goalDays())
  if (!days.length) return
  const rows = days.map((day) => ({ day: day }))
  const res = await db().from('goal_days').upsert(rows, { onConflict: 'owner_id,day', ignoreDuplicates: true })
  if (res.error) throw res.error
}

export function ensureDayPlan() {
  const today = todayKey()
  const p = state.settings.day_plan
  if (p && p.date === today) return p
  /* 休息日的"新学"目标必须是 0（今天根本不引新词），否则 newMet 永远为 false ——
     达标在休息日永远达不到、达标连胜每周日被打断。这是"休息日"这条规则的**第三处**出现
     （前两处 newAllowance / goalCard 均已修过）：同一规则只允许有一个算法。 */
  const plan = {
    date: today,
    due: dueCards().length,
    /* ⚠ 分母必须与分子同单位：doneNew 来自 study_stats.new_words = **不同词数**，
       所以这里也只能用 newWordCount()（按词），不能用 newCards().length（按卡）。
       2026-10-17 的"新学 7/8 还差 1 永远学不满"就是这两处单位不一致造成的。 */
    newGoal: isRestDay() ? 0 : Math.min(Number(state.settings.daily_new) || 0, newWordCount()),
  }
  state.settings.day_plan = plan
  saveLocal()
  pushSettings().catch(() => {})
  return plan
}

export function goalProgress() {
  const today = todayKey()
  const basePlan = ensureDayPlan()
  const st = statsFor(today)
  const doneReview = dailyReviewed()        // 作答次数：额度语义，保持不变
  const doneCards = dailyReviewedCards()    // 今日复习过的不同卡片数：目标语义
  const dueNow = dueCards().length          // 此刻仍到期、能马上做的卡片数
  const doneNew = Number(st.new_words) || 0
  const plan = Object.assign({}, basePlan, {
    due: Math.min(basePlan.due, dailyReviewLimit()),
    newGoal: newWordsPaused() ? doneNew : Math.min(basePlan.newGoal, doneNew + dailyReviewAllowance()),
  })
  /* 复习目标必须按"卡片"算，且分母要能自然收敛。
     旧实现拿当日快照 plan.due（卡片数）减作答次数（次数），两个单位相减；
     卡片被 FSRS 推到明天后快照不回缩 → 界面永远"还差几十张"、待复习却是 0，
     当天再也不可能达标，达标连胜被无端打断（2026-10-27 真机实测）。
     现在分母 = 今天已复习的卡 + 此刻仍到期的卡：做完最后一张就闭合，不留死账。 */
  const dueToday = doneCards + dueNow
  const reviewMet = dueNow === 0
  const newMet = plan.newGoal === 0 || doneNew >= plan.newGoal
  // 可选：把"本周做过一次抽测"也纳入达标条件
  const needTest = String(state.settings.goal_include_test) === 'true'
  const lastTest = Number(state.settings.last_test_at) || 0
  const testMet = !needTest || (Date.now() - lastTest) < 7 * 86400000
  /* 已记账的达标当天不回退：中途有新卡到期时不把今天的达标翻回未达标。 */
  const recorded = !!goalDays()[today]
  return {
    plan, doneReview, doneCards, dueNow, dueToday, doneNew, reviewMet, newMet, testMet, needTest,
    met: recorded || (reviewMet && newMet && testMet), today,
  }
}

/** 达标即刻记账（幂等，只写一次） */
export function markGoalIfMet() {
  const g = goalProgress()
  if (!g.met) return false
  const days = Object.assign({}, goalDays())
  if (days[g.today]) return false
  days[g.today] = true
  state.settings.goal_days = trimGoalDays(days)
  saveLocal()
  // 追加式写入独立表；网络失败也不丢 —— 本地已记，下次同步并集补推
  pushGoalDays().catch(() => {})
  return true
}

export function goalStats(n) {
  const span = Number(n) || 30
  const map = goalDays()
  let hit = 0
  for (let i = 0; i < span; i++) {
    if (map[todayKey(new Date(Date.now() - i * 86400000))]) hit++
  }
  let streak = 0
  for (let i = 0; i < 400; i++) {
    const k = todayKey(new Date(Date.now() - i * 86400000))
    if (map[k]) streak++
    else if (i > 0) break      // 今天还没达标不打断连胜
  }
  return { hit, span, rate: Math.round((hit / span) * 100), streak }
}

export function statsFor(dateKey) {
  const row = state.daily.find((d) => String(d.reviewed_on).slice(0, 10) === dateKey)
  return row || { reviewed_on: dateKey, total: 0, correct: 0, new_words: 0, minutes: 0 }
}

export function newIntroducedToday(now = Date.now()) {
  return Number(statsFor(todayKey(new Date(now))).new_words) || 0
}

/** 正式作答按次累计，含新学、重试、练习计入；审计/测试作答不占额度。
 * 本地高水位防止 RPC 统计延迟、重进队列或刷新重置额度；同步后取云端与本地较大值。
 * 跨设备同时作答仍需服务端原子限额才能严格约束，这里不声称提供该保证。 */
const reviewUsage = new Map()
function usageKey(now) {
  const owner = String((state.user && state.user.id) || state.accountEmail || 'local')
  return 'lexiloop.review-usage.v1.' + encodeURIComponent(owner) + '.' + todayKey(new Date(now))
}

export function dailyReviewLimit() {
  const value = Number(state.settings.daily_max_review)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_SETTINGS.daily_max_review
}

export function dailyReviewed(now = Date.now()) {
  const key = usageKey(now)
  let saved = 0
  try { saved = Number(localStorage.getItem(key)) || 0 } catch (e) { /* 内存兜底 */ }
  const total = Math.max(0, Number(statsFor(todayKey(new Date(now))).total) || 0, saved, reviewUsage.get(key) || 0)
  reviewUsage.set(key, total)
  return total
}

/**
 * 今日已复习过的**不同卡片数**（目标口径）。
 * 与 dailyReviewed() 的区别：后者是作答**次数**，一张卡连续巩固会记多次（忘了→10 分钟后重学）。
 * 目标进度必须按卡片算，否则"已做"会跑得比"还剩"快，界面上留下永远补不齐的缺口。
 */
export function dailyReviewedCards(now = Date.now()) {
  const key = todayKey(new Date(now))
  return state.cards.filter((c) =>
    c.last_review_at && todayKey(new Date(c.last_review_at)) === key).length
}

export function dailyReviewAllowance(now = Date.now()) {
  return Math.max(0, dailyReviewLimit() - dailyReviewed(now))
}

function countReview(now) {
  const key = usageKey(now)
  const total = dailyReviewed(now) + 1
  reviewUsage.set(key, total)
  try { localStorage.setItem(key, String(total)) } catch (e) { /* 内存兜底 */ }
}

/** 跨日积压：今天零点以前已到期的可学卡；今天刚到期的卡不触发暂停。 */
export function overdueCards(now = Date.now()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return dueCards(now).filter((c) => new Date(c.due).getTime() < start.getTime())
}

export function newWordsPaused(now = Date.now()) {
  return String(state.settings.pause_new_when_overdue) !== 'false' && overdueCards(now).length > 0
}

/** 休息日（默认周日 = 0）：只复习、不引新词，留一天做整合与抽测。
 *  设置里取消勾选，内存里存 ''、落库存 null。
 *  ⚠ 判空**不能**用 `Number(x)`：Number(null) 与 Number('') 都等于 0，
 *    那样"关掉休息日"在周日仍会被判为休息日（等于功能关不掉）。
 *    所以这里显式排除 null / '' / undefined，并只接受 0–6 的整数。 */
export function isRestDay(now) {
  const t = now || Date.now()
  const raw = state.settings.rest_weekday
  if (raw === null || raw === undefined || raw === '') return false
  const d = Number(raw)
  if (!Number.isInteger(d) || d < 0 || d > 6) return false
  return new Date(t).getDay() === d
}

/** 今天还能引多少新词。
 *  ⚠ 必须统一走这里，不要在各处重新判断休息日。
 *  历史 bug（2026-10-04）：buildQueue 里判了休息日（额度 0），
 *  而 tab 徽章与「今日」页调的是本函数、没判 → 周日明明不出新词，
 *  界面却提示「还有 8 个单词待学习」。同一规则两套算法，UI 与行为必然对不上。 */
export function newAllowance(now) {
  if (isRestDay(now) || newWordsPaused(now)) return 0
  return Math.min(dailyReviewAllowance(now), Math.max(0, (Number(state.settings.daily_new) || 0) - newIntroducedToday(now)))
}

/** 当前学习范围（词单过滤）：空串 = 全部词单 */
export function deckFilter() {
  return String(state.settings.deck_filter || '')
}

export function topicFilter() {
  return String(state.settings.topic_filter || '')
}

/** 词条为什么不该进学习队列。返回空串 = 可以学。
 *
 *  ① 'review'：flagged / suspect —— 内容有问题（虚构动词、词性错、待人工裁决）
 *  ② 'empty'：**一个可学的东西都没有** —— 生成流程尝试过（payload.enrich_attempted）
 *     但既没产出释义、也没产出搭配。典型来源是导入时把原词单的"分组标题/主题名"
 *     当成词条收进来（如 warm professional english / chain 2 campus safety / call log vocabulary），
 *     或对比类、整句类天生生成不出搭配。
 *     2026-10-15 用户实测：这类空壳真的会排进队列，卡片上写着"回想它的搭配与例句"，
 *     可它一条搭配都没有 —— 用户只能干瞪眼。**没有内容的条目从源头就不该进队列。** */
export function blockReason(w) {
  /* 词条还没加载（或卡片的词条缺失）时**不在这里判**：那是数据加载/数据完整性问题的表现，
     在这里挡掉会让卡片无声消失、把真正的问题藏起来。fail-open。 */
  if (!w) return ''
  const st = w.verification_status
  if (st === 'flagged' || st === 'suspect') return 'review'
  const p = (w && w.payload) || {}
  const senses = Array.isArray(p.senses) ? p.senses.filter((x) => x && (x.def_zh || x.def_en)) : []
  const colls = Array.isArray(p.collocations) ? p.collocations.filter((x) => x && x.pattern) : []
  if (!senses.length && !colls.length) return 'empty'
  return ''
}

/** 内容被标记为待审核（或压根没内容）的词条 —— 不进学习队列。
 *
 *  用户明确要求："待审核的词根本不该进入学习队列"。否则"标记"就只是个装饰：
 *  用户照样会学到错误内容，只能自己撞上才发现。
 *
 *  flagged / suspect / 内容缺失 三种都挡。**corrected（已修正）、verified、以及 null（未核验）
 *  且内容齐全的都正常参与学习** —— 未核验是绝大多数，挡掉它等于把整个词库关掉。 */
export function isBlockedWord(w) {
  return blockReason(w) !== ''
}

/** 当前被挡在队列外的词条（用于界面告知"为什么少了一些词"） */
export function blockedWords() {
  return state.words.filter(isBlockedWord)
}

export function inScope(card) {
  const d = deckFilter()
  if (d && card.deck !== d) return false
  const t = topicFilter()
  if (t) {
    const w = wordOf(card)
    const tp = String((w && w.payload && w.payload.topic) || '').trim() || '未分类'
    if (tp !== t) return false
  }
  // 待审核内容不进队列（放在最后：上面两个是按用户筛选，这条是内容安全闸门）
  if (isBlockedWord(wordOf(card))) return false
  return true
}

export function dueCards(now) {
  const t = now || Date.now()
  return state.cards
    .filter((c) => !c.suspended && c.status !== 'new' && new Date(c.due).getTime() <= t && inScope(c))
    .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime())
}

/** 薄弱词：忘记次数最多的那批卡（用于"只练薄弱词"） */
export function weakCards(minLapses) {
  const min = minLapses == null ? 2 : minLapses
  return state.cards
    .filter((c) => !c.suspended && Number(c.lapses) >= min && inScope(c))
    .sort((a, b) => (Number(b.lapses) - Number(a.lapses)) ||
                    (new Date(a.due || 0).getTime() - new Date(b.due || 0).getTime()))
}

/** 薄弱词专练队列：薄弱卡 + 已到期的其余卡补足到 20 张 */
/** 薄弱词专练队列：薄弱卡 + 已到期的其余卡补足到 20 张
 *
 *  阈值必须和「统计 → 薄弱词」列表一致（都是 ≥2 次）。
 *  旧实现这里用 1：列表说"薄弱词 N 张"、点进专练却抽了另一批卡（忘记 ≥1 次的），
 *  用户看到的两个数字对不上，只会怀疑统计坏了。 */
export function buildWeakQueue(now) {
  const t = now || Date.now()
  const weak = weakCards(2).slice(0, 20)
  if (weak.length >= 20) return weak.slice(0, dailyReviewAllowance(t))
  const seen = new Set(weak.map((c) => c.id))
  const rest = dueCards(t).filter((c) => !seen.has(c.id))
  return weak.concat(rest.slice(0, 20 - weak.length)).slice(0, dailyReviewAllowance(t))
}

/** status 还是 'new' 的**卡片**（按张计）。底层口径，不要直接拿它当"还有几个新词"。 */
export function newCards() {
  return state.cards.filter((c) => !c.suspended && c.status === 'new' && inScope(c))
}

/**
 * 已经"开始学过"的词：该词名下只要有一张卡不再是 new，就算开始过。
 *
 * 为什么必须单独算：每日新词配额是按**词**计的
 * （服务端 study_stats 用 COUNT(DISTINCT word_id) FILTER (WHERE prev_state->>'status'='new')），
 * 而库里的 "new" 是按**张**计的。一个词通常有两张卡（认读 + 例句填空），
 * 第一张学完、第二张还是 new —— 如果把它也当成"新词"发出去，配额就永远学不满：
 * 用户以为在学新词，其实学的是已经算过数的那个词的剩余卡型，计数一动不动。
 *
 * 2026-10-17 线上实测：当天 16 条 prev='new' 的复习记录只对应 8 个不同词，
 * 9 个词停在"一张卡做完、另一张还是 new"，首页「新学 7/8 还差 1」＋
 * 「待学新词 1+」反复出现，用户描述为"学了十几遍提示还在重复"。
 */
export function startedWordIds() {
  const s = new Set()
  for (const c of state.cards) if (c.status !== 'new') s.add(c.word_id)
  return s
}

/**
 * 真正"一个词都还没开始"的新词数（单位 = **词**，与 newAllowance() 同口径）。
 * 所有"按词"的指标（配额、目标进度、待学新词）都必须走这个函数，
 * 绝不能拿 newCards().length 顶替 —— 那正是本次 bug 的根源。
 */
export function newWordCount() {
  const started = startedWordIds()
  const fresh = new Set()
  for (const c of state.cards) {
    if (c.suspended || c.status !== 'new' || !inScope(c)) continue
    if (!started.has(c.word_id)) fresh.add(c.word_id)
  }
  return fresh.size
}

/**
 * 已开始学的词的"剩余卡型"（status 还是 new，但它的词已经学过了）。
 * 这批卡是今天那批新词没做完的部分，必须能继续学，但**不再占用新词配额**。
 * 不把它们单独分出来，就会出现"配额只剩 1，发下来的却是已经算过数的词"的死循环。
 */
export function leftoverNewCards() {
  const started = startedWordIds()
  return state.cards.filter((c) =>
    !c.suspended && c.status === 'new' && inScope(c) && started.has(c.word_id))
}

/** 一轮里最多带多少张"补课"卡（已开始词的剩余卡型）。
 *  与复习卡共用同一个每日工作量上限：正常情况只剩个位数，
 *  但用户长期中途退出时这批卡会越攒越多，不设上限队列就没有终点。 */
export function leftoverQuota() {
  return dailyReviewAllowance()
}

/** 稳定哈希打散：同一个 id 每次得到的顺序一致，刷新页面不会换来换去 */
function hashId(v) {
  const s = String(v == null ? '' : v)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/**
 * 组装今天的学习队列。
 * 两处刻意的安排：
 *   1. 新词按 id 哈希打散 —— 否则永远是"最早导入的那批先学"，后面的词几年轮不到。
 *   2. 新词与复习交错（每 4 张复习插 1 张新词）—— 交替出现比分段刷更利于长期记忆。
 */
/** 同一词的两张卡不要紧挨着：第二张被第一张"热身"过就不算真检索了 */
function separateSameWord(list) {
  const out = list.slice()
  for (let i = 1; i < out.length; i++) {
    if (out[i].word_id !== out[i - 1].word_id) continue
    for (let j = i + 1; j < out.length; j++) {
      const okBefore = out[j].word_id !== out[i - 1].word_id
      const okAfter = j + 1 >= out.length || out[j + 1].word_id !== out[i - 1].word_id
      if (okBefore && okAfter) {
        const t = out[i]
        out[i] = out[j]
        out[j] = t
        break
      }
    }
  }
  return out
}

export function buildQueue(now) {
  const t = now || Date.now()
  const quota = dailyReviewAllowance(t)
  if (!quota) return []
  const review = dueCards(t).slice(0, quota)
  // 休息日（默认周日）：只复习，不引新词 —— 留一天做整合与抽测。
  // 额度统一由 newAllowance() 给出（它内部已判休息日），此处不要再单独判断，
  // 否则又会出现"队列不出新词、界面却提示待学习"的错位。
  const allow = newAllowance(t)
  const ready = (c) => {
    const w = wordOf(c)
    const p = (w && w.payload) || {}
    return ((p.collocations || []).length || (p.senses || []).length) ? 1 : 0
  }
  // 排序：词频优先级（core→common→extended）→ 内容就绪 → 稳定打散
  // 优先级：邮件语料高频（你真实工作里最常用的）> 场景领域词 > core > common > 其余
  const prio = (c) => {
    const w = wordOf(c)
    const p = (w && w.payload) || {}
    if (Number(p.mail_freq) >= 10) return 0
    if (p.domain) return 1
    const v = p.priority
    return v === 'core' ? 2 : v === 'common' ? 3 : 4
  }
  const freshAll = newCards().slice().sort((a, b) =>
    (prio(a) - prio(b)) ||
    (ready(b) - ready(a)) ||
    (hashId(a.word_id) - hashId(b.word_id)) || (hashId(a.id) - hashId(b.id)))

  /* ── 新词配额只认"词"，不认"卡" ──
     服务端 new_words = COUNT(DISTINCT word_id) FILTER (prev='new')，
     所以能占用配额的只能是"这个词名下所有卡都还是 new"的真·新词。
     已开始词的剩余卡型（leftover）**不占配额**，另排一条流 ——
     否则配额会发给已经算过数的词，用户学一张、计数不动，首页就一直提示
     "还差 1 个新词"（2026-10-17 线上实测的"学了十几遍还在重复"）。 */
  const started = startedWordIds()
  const fresh = freshAll.filter((c) => !started.has(c.word_id))
  const leftover = freshAll.filter((c) => started.has(c.word_id))
    .sort((a, b) => new Date(a.due || 0).getTime() - new Date(b.due || 0).getTime())
    .slice(0, leftoverQuota())

  // 同一个词的其它卡型（如 cloze）跟着一起进队列，但不再额外占用名额。
  const pickWords = new Set()
  const firstCards = []   // 每个词的"第一张卡"
  const extraCards = []   // 同一个词的其它卡型（如 cloze）—— 排到后面，避免背靠背
  for (const c of fresh) {
    if (pickWords.size >= allow && !pickWords.has(c.word_id)) break
    if (pickWords.has(c.word_id)) {
      extraCards.push(c)
      continue
    }
    if (pickWords.size >= allow) continue
    pickWords.add(c.word_id)
    firstCards.push(c)
  }
  // 先把所有词的"第一张"排完，再排同词的其它卡型：
  // 否则 recognition 与 cloze 会紧挨着出现，等于当场重复，考的是短期回声而非记忆。
  // leftover 排最后：它们是补课，不是今天的配额。
  const newPick = firstCards.concat(extraCards).concat(leftover)

  if (!newPick.length) return separateSameWord(review).slice(0, quota)
  if (!review.length) return separateSameWord(newPick).slice(0, quota)

  const out = []
  let ri = 0
  let ni = 0
  // 交错比例可在设置里调（每 N 张复习插 1 张新词），默认 4
  const STEP = Math.min(20, Math.max(1, Number(state.settings.queue_interleave) || 4))
  while (ri < review.length || ni < newPick.length) {
    for (let k = 0; k < STEP && ri < review.length; k++) out.push(review[ri++])
    if (ni < newPick.length) out.push(newPick[ni++])
    else if (ri < review.length) out.push(review[ri++])
  }
  return separateSameWord(out).slice(0, quota)
}

/* ───────────────────────── 复习 ───────────────────────── */

/**
 * 评分。
 * @param {object} card
 * @param {number} grade 1..4
 * @param {{hinted?:'hard'|'soft'}} [opts] hinted=先看了答案：
 *   'hard' 表示没尝试作答就揭晓 —— 这不算成功提取，按 1（忘了）处理；
 *   'soft' 表示作答后再看答案核对 —— 只记录，不降级。
 */
export function applyGrade(card, grade, opts) {
  const now = Date.now()
  const o = opts || {}
  const isTest = o.isTest === true || state.testSession === true
  if (!isTest && !dailyReviewAllowance(now)) throw new Error('已达到今日正式作答上限；到期卡片保留，明天继续。')
  let g = grade
  if (o.hinted === 'hard') g = 1
  const retention = Number(state.settings.target_retention) || 0.9
  const steps = {
    minutes: Number(state.settings.learn_step_minutes) || 10,
    days: Number(state.settings.learn_step_days) || 1,
  }
  const result = FSRS.review(card, g, now, retention, undefined, steps)
  if (o.hinted) result.log.prev_state.hinted = o.hinted

  /* 测试模式：算完立刻把卡片恢复原样，只把 log 交回调用方。
     两个调用点（学习页 views.js / 练习场 store.creditGrades）都在**真实的
     state.cards 对象**上调本函数 —— 若不恢复，测试作答会在本地把卡片状态推进
     （到期日改变、待办任务数变少），直到刷新才被服务端覆盖，
     与横幅承诺的「不影响学习进度」直接矛盾（2026-10-10 外部复测指出）。
     log 里的 prev/next_state 仍完整，服务端凭它决定是否落库。 */
  if (isTest) {
    const before = Object.assign({}, card)
    Object.assign(card, result.card)
    Object.keys(card).forEach((k) => { if (!(k in before)) delete card[k] })
    Object.assign(card, before)
    return result
  }

  Object.assign(card, result.card)
  countReview(now)
  saveLocal()
  try { markGoalIfMet() } catch (e) { /* 达标记账失败不影响评分 */ }
  return result
}

/**
 * 把游戏表现写进 FSRS。
 * 设计：游戏本身不计分，结束时由用户自己决定要不要写入，避免游戏手感污染记忆曲线。
 * 对 → 记得(3)，错 → 忘了(1)。
 */
/** 练习表现 → FSRS 评分。只看对错太粗（"蒙对"和"脱口而出"不该同分），
 *  这里用答题耗时区分：快=4、正常=3、慢=2、错=1。 */
export function gradeFromPerformance(ok, ms) {
  if (!ok) return 1
  const t = Number(ms) || 0
  if (!t) return 3                 // 没有耗时信息时按"正常"处理
  if (t <= 3500) return 4          // 3.5 秒内答对 → 脱口而出
  if (t <= 9000) return 3          // 正常回忆
  return 2                          // 想很久才对 → 基础不牢，别给高分
}

/**
 * 把练习/抽测的表现写进复习计划。
 * @param {Array<{id:number, ok:boolean, ms?:number}>} list
 * @param {{source?:string}} [opts] source: game（练习场）| test（抽测）
 */
export async function creditGrades(list, opts) {
  const o = opts || {}
  const source = o.source || 'game'
  /* 测试标记**默认继承当前会话状态**，而不是要求每个调用点自己记得传。
     调用点有五处（练习场各模式 + 实验室），漏掉任何一处都会让测试作答
     悄悄写进正式调度 —— 默认安全的写法比逐个补参数可靠。 */
  const isTest = o.isTest !== undefined ? o.isTest === true : state.testSession === true
  let n = 0
  let asked = 0
  for (const it of list || []) {
    if (!isTest && !dailyReviewAllowance()) break
    const card = state.cards.find((c) => c.word_id === it.id)
    if (!card) continue
    asked++
    const grade = typeof it.grade === 'number' ? it.grade : gradeFromPerformance(it.ok, it.ms)
    const res = applyGrade(card, grade, { isTest })
    // 三个新维度跟着日志一起落库：判分结论（命中/替代/待复核）、是否用了提示、
    // 是否靠选项辅助。没有它们，"待复核有多少"和"多少分是提示帮忙拿的"永远算不出来。
    const log = Object.assign({}, res.log, {
      elapsed_ms: Number(it.ms) || 0,
      source: source,
      verdict: it.verdict || null,
      hinted: it.hinted === true,
      assisted: it.assisted === true,
    })
    const evt = newEventId()
    try {
      // 一次 RPC 完成"记日志 + 更新调度"，测试事件由服务端判断不碰 cards
      await recordReview(log, card, { eventId: evt, isTest: isTest })
      n++
    } catch (e) {
      // 失败入队重放（复用同一个 eventId，重放不会变成第二次复习）
      queueReview(log, card, { eventId: evt, isTest: isTest })
    }
  }
  // 只有**真的写成了**才算"这周做过抽测"。
  // 旧写法不管写入成功与否都盖时间戳 —— 网络失败时会虚报达标，用户看到"7 天内做过"却是空的。
  // 测试模式同样不能盖：达标状态也是"学习进度"的一部分，测试作答不该让它变成已完成。
  if (source === 'test' && n > 0 && !isTest) {
    state.settings.last_test_at = Date.now()
    pushSettings().catch(() => {})
  }
  saveLocal()
  pullStats().catch(() => {})
  return n
}

/** 兼容"整批同一个结果"的调用（对/错 → 记得/忘了） */
export async function creditWords(words, okAll, opts) {
  return creditGrades((words || []).map((p) => ({ id: p.id, ok: !!okAll, ms: p.ms })), opts)
}

export function promptOf(word) {
  const p = (word && word.payload) || {}
  return p
}
