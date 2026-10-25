/**
 * fsrs.js — 间隔重复调度器
 *
 * 本文件是 FSRS（Free Spaced Repetition Scheduler）公开算法的独立实现，
 * 使用其公开的默认参数组。核心三变量：
 *   D (Difficulty 1..10)  —— 该词对你有多难
 *   S (Stability, 天)     —— 记忆保持率衰减到 90% 所需天数
 *   R (Retrievability)    —— 此刻能回忆起的概率，R(t,S) = (1 + FACTOR·t/S)^DECAY
 *
 * 记忆曲线与间隔反解：
 *   R(t, S) = (1 + FACTOR·t/S)^DECAY         DECAY = -0.5, FACTOR = 19/81
 *   I(r, S) = (S / FACTOR)·(r^(1/DECAY) − 1)  给定目标留存率 r 时的下次间隔
 *   自洽性：r = 0.90 时 I = S（与 S 的定义一致）
 *
 * 评级 grade：1 = Again（忘了）2 = Hard（很吃力）3 = Good（想起来了）4 = Easy（秒答）
 *
 * 已知简化（明示，不隐藏）：
 *   学习步骤只有两段（默认 10 分钟 / 1 天），按状态推进，不用总作答次数代替成功巩固。
 *   同日重复复习用 FSRS-5 的短期项（w17/w18）单独处理，不做短期与长期的加权融合；
 *   影响只落在"同一天内的第二次及以后复习"上（2026-10-09 修正：此前这一档会退化成
 *   稳定度完全不增长，因为长期公式在 R≈1 时增长因子恒为 0）。
 */

export const DECAY = -0.5
export const FACTOR = 19 / 81

/** FSRS 公开默认参数组（19 项） */
export const DEFAULT_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
  1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
  2.9898, 0.51655, 0.6621,
]

export const S_MIN = 0.01
export const S_MAX = 36500
export const D_MIN = 1
export const D_MAX = 10

/** 重学步骤（分钟） */
export const RELEARN_MINUTES = 10
export const MS_PER_DAY = 86400000

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export const GRADES = [
  { grade: 1, key: 'again', label: '忘了', hint: '完全想不起来' },
  { grade: 2, key: 'hard', label: '吃力', hint: '想很久才想起' },
  { grade: 3, key: 'good', label: '记得', hint: '正常想起来了' },
  { grade: 4, key: 'easy', label: '很简单', hint: '脱口而出' },
]

/** 当前可提取性 R */
export function retrievability(elapsedDays, stability) {
  if (!(stability > 0)) return 0
  const t = Math.max(0, elapsedDays)
  return Math.pow(1 + FACTOR * t / stability, DECAY)
}

/** 给定目标留存率反解间隔（天） */
export function intervalForRetention(stability, retention) {
  const r = clamp(retention, 0.5, 0.99)
  const s = clamp(stability, S_MIN, S_MAX)
  return (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1)
}

/** 首次评分后的初始稳定度 S0(G) = w[G-1] */
export function initStability(grade, w = DEFAULT_W) {
  return clamp(w[grade - 1], S_MIN, S_MAX)
}

/** 首次评分后的初始难度 D0(G) = w[4] − (G−3)·w[5] */
export function initDifficulty(grade, w = DEFAULT_W) {
  return clamp(w[4] - (grade - 3) * w[5], D_MIN, D_MAX)
}

/** 难度更新：线性阻尼 + 向 D0(Easy) 均值回归 */
export function nextDifficulty(d, grade, w = DEFAULT_W) {
  const damped = d + (-w[6] * (grade - 3)) * (10 - d) / 9
  const reverted = w[7] * initDifficulty(4, w) + (1 - w[7]) * damped
  return clamp(reverted, D_MIN, D_MAX)
}

/** 成功回忆后的稳定度增长（grade ≥ 2） */
export function nextRecallStability(d, s, r, grade, w = DEFAULT_W) {
  const hardPenalty = grade === 2 ? w[15] : 1
  const easyBonus = grade === 4 ? w[16] : 1
  const gain =
    Math.exp(w[8]) *
    (11 - d) *
    Math.pow(s, -w[9]) *
    (Math.exp((1 - r) * w[10]) - 1) *
    hardPenalty *
    easyBonus
  return clamp(s * (1 + gain), S_MIN, S_MAX)
}

/** 遗忘后的稳定度（grade = 1） */
export function nextForgetStability(d, s, r, w = DEFAULT_W) {
  const v =
    w[11] *
    Math.pow(d, -w[12]) *
    (Math.pow(s + 1, w[13]) - 1) *
    Math.exp(w[14] * (1 - r))
  return clamp(v, S_MIN, S_MAX)
}

/** 同日（或缺失上次复习时间）重复复习的短期稳定度（FSRS-5 的短期项，w[17] / w[18]）。
 *
 *  为什么必须单独处理这一档：长期公式里的增长因子含 (exp((1−R)·w[10]) − 1)，
 *  而同日复习时 R ≈ 1，这一项恒等于 0 —— S 原封不动地返回，等于"又复习了一遍
 *  对记忆强度毫无影响"。这不是算法保守，是把长期公式用在了它不适用的时间尺度上。
 *  缺失 last_review_at 的旧数据也走这条：宁可按"刚复习过"保守估计，
 *  也不能让 S 卡死不动（那会让这张卡永远按同一个间隔出现）。 */
export function nextShortTermStability(s, grade, w = DEFAULT_W) {
  return clamp(s * Math.exp(w[17] * (grade - 3 + w[18])), S_MIN, S_MAX)
}

/** 同日重做的判定阈值（天）。跨过一天才交给长期公式。 */
export const SAME_DAY_DAYS = 1

/** 新卡的学习步骤：前两次成功复习给短间隔，当天多巩固一轮（间隔可在设置里调） */
export const STEP_MINUTES = 10
export const STEP_DAY = 1

/** 归一化步骤配置：缺省回退到内置值，异常值兜底 */
function normalizeSteps(s) {
  return {
    minutes: Math.min(120, Math.max(1, Math.round(Number(s && s.minutes) || STEP_MINUTES))),
    days: Math.min(7, Math.max(1, Math.round(Number(s && s.days) || STEP_DAY))),
  }
}

/**
 * 计算下一次到期时间戳。
 * 学习步骤：新卡前几次"想起来了"给短间隔（默认 10 分钟与 1 天），之后交给 FSRS 按天排期。
 * 理由：新词第一次接触就丢到几天后，第二次见面基本已经忘了，等于白学一次。
 */
function learningSchedule(card, isNew, grade, now, retention, stability, steps) {
  const st = normalizeSteps(steps)
  if (grade === 1) return { status: 'relearning', due: now + RELEARN_MINUTES * 60000 }
  const status = isNew ? 'new' : card.status
  if (status !== 'review') {
    // 吃力不推进学习阶段；忘了由上面的分支重置。reps 仍只记录总作答次数。
    if (grade === 2) return {
      status: status === 'learning' ? 'learning' : 'relearning',
      due: now + st.minutes * 60000,
    }
    if (status === 'learning') return { status: 'review', due: now + st.days * MS_PER_DAY }
    return { status: 'learning', due: now + st.minutes * 60000 }
  }
  const days = Math.max(1, Math.round(intervalForRetention(stability, retention)))
  return { status: 'review', due: now + days * MS_PER_DAY }
}

/**
 * 用同一张卡片的当前状态推演某个评级的下一步（不落库，用于按钮上的间隔预览）
 * @returns {{stability:number, difficulty:number, status:string, due:number, intervalDays:number}}
 */
export function preview(card, grade, now = Date.now(), retention = 0.9, w = DEFAULT_W, steps) {
  const isNew = !card || card.status === 'new' || !(card.stability > 0) || !card.reps
  let stability
  let difficulty

  if (isNew) {
    stability = initStability(grade, w)
    difficulty = initDifficulty(grade, w)
  } else {
    const hasLast = card.last_review_at != null
    const elapsedDays = hasLast ? Math.max(0, (now - card.last_review_at) / MS_PER_DAY) : 0
    const r = retrievability(elapsedDays, card.stability)
    difficulty = nextDifficulty(card.difficulty, grade, w)
    if (grade === 1) {
      stability = nextForgetStability(card.difficulty, card.stability, r, w)
    } else if (!hasLast || elapsedDays < SAME_DAY_DAYS) {
      // 同日重复：长期公式在这里会退化成"不增长"，必须走短期项（见上面说明）
      stability = nextShortTermStability(card.stability, grade, w)
    } else {
      stability = nextRecallStability(card.difficulty, card.stability, r, grade, w)
    }
  }

  const next = {
    stability,
    difficulty,
    ...learningSchedule(card, isNew, grade, now, retention, stability, steps),
  }
  return {
    ...next,
    intervalDays: Math.max(0, (next.due - now) / MS_PER_DAY),
  }
}

/**
 * 处理一次复习，返回新的卡片状态与可回放的日志
 * @param {object} card   现有卡片行（可为 null 表示新卡）
 * @param {number} grade  1..4
 */
export function review(card, grade, now = Date.now(), retention = 0.9, w = DEFAULT_W, steps) {
  if (![1, 2, 3, 4].includes(grade)) throw new Error('grade must be 1..4')

  const p = preview(card, grade, now, retention, w, steps)
  const base = card || {
    stability: 0,
    difficulty: initDifficulty(3, w),
    reps: 0,
    lapses: 0,
    status: 'new',
  }

  const next = {
    ...base,
    stability: p.stability,
    difficulty: p.difficulty,
    status: p.status,
    due: p.due,
    reps: (base.reps || 0) + 1,
    lapses: (base.lapses || 0) + (grade === 1 ? 1 : 0),
    last_review_at: now,
    last_grade: grade,
  }

  const log = {
    grade,
    prev_state: {
      stability: base.stability || 0,
      difficulty: base.difficulty || 0,
      status: base.status || 'new',
      due: base.due || null,
    },
    next_state: {
      stability: p.stability,
      difficulty: p.difficulty,
      status: p.status,
      due: p.due,
    },
  }

  return { card: next, log, intervalDays: p.intervalDays }
}

/** 把间隔天数渲染成人话 */
export function humanInterval(days) {
  if (!(days > 0)) return '现在'
  const minutes = days * 24 * 60
  if (minutes < 60) return `${Math.round(minutes)} 分钟`
  if (days < 1) return `${Math.round(days * 24)} 小时`
  if (days < 30) return `${Math.round(days)} 天`
  if (days < 365) return `${(days / 30.44).toFixed(1)} 个月`
  return `${(days / 365.25).toFixed(1)} 年`
}

/** 掌握判定：最近一次为 Good/Easy 且稳定度 ≥ 21 天 */
export function isMastered(card) {
  return !!card && card.stability >= 21 && card.last_grade >= 3 && card.status === 'review'
}

/**
 * 自检：验证算法的不变量。任何一条不通过即说明实现有问题。
 * 在启动时调用一次，结果写到控制台（不影响使用）。
 */
export function selfTest() {
  const problems = []
  const now = Date.UTC(2026, 0, 1)

  // 1) R = 90% 时间隔应等于 S（S 的定义）
  for (const s of [1, 5, 20, 100, 400]) {
    const i = intervalForRetention(s, 0.9)
    if (Math.abs(i - s) > 1e-6) problems.push(`intervalForRetention(S=${s}, .9) = ${i} ≠ S`)
  }

  // 2) 目标留存率越高，间隔越短（严格单调递减）
  let prev = Infinity
  for (let r = 0.80; r <= 0.97; r += 0.01) {
    const i = intervalForRetention(30, r)
    if (!(i < prev)) problems.push(`intervalForRetention 在 r=${r.toFixed(2)} 处非单调`)
    prev = i
  }

  // 3) 首次评分：Easy 的初始稳定度必须大于 Good，Good 大于 Hard，Hard 大于 Again
  const s0 = [1, 2, 3, 4].map((g) => initStability(g))
  for (let i = 1; i < 4; i++) {
    if (!(s0[i] > s0[i - 1])) problems.push(`initStability 非单调：${s0.join(' < ')}`)
  }

  // 4) 初次难度：Again 应最难
  if (!(initDifficulty(1) > initDifficulty(4))) problems.push('initDifficulty 方向错误')

  // 5) 同一张卡，评分越高下次间隔越长
  const base = { stability: 10, difficulty: 5, reps: 5, lapses: 0, status: 'review', last_review_at: now - 10 * MS_PER_DAY }
  const iv = [1, 2, 3, 4].map((g) => preview(base, g, now).due - now)
  for (let i = 1; i < 4; i++) {
    if (!(iv[i] >= iv[i - 1])) problems.push(`间隔随评分非单调：${iv.join(' , ')}`)
  }

  // 6) 长期复习后间隔应持续增长（不会倒退）
  let c = null
  let last = 0
  for (let i = 0; i < 8; i++) {
    const t = now + i * 30 * MS_PER_DAY
    const res = review(c, 3, t, 0.9)
    c = res.card
    if (res.intervalDays < last) problems.push(`第 ${i + 1} 轮间隔倒退：${res.intervalDays} < ${last}`)
    last = res.intervalDays
  }

  // 7) 遗忘会显著缩短间隔，但不为负
  const forgot = preview(base, 1, now)
  if (forgot.due - now < 0) problems.push('遗忘后间隔为负')
  // 8) 可提取性：R(0)=1，R(t=S) 恰好为 0.90（S 的定义），且随时间严格递减
  if (Math.abs(retrievability(0, 10) - 1) > 1e-9) problems.push('R(0,S) 应为 1')
  if (Math.abs(retrievability(10, 10) - 0.9) > 1e-9) problems.push('R(t=S,S) 应为 0.9')
  for (let t = 0; t < 5000; t += 100) {
    if (!(retrievability(t + 100, 10) < retrievability(t, 10))) problems.push(`R 在 t=${t} 处非递减`)
  }
  if (!(retrievability(10000, 10) < 0.1)) problems.push('R 长时衰减过慢')

  // 8) 无 NaN / 越界
  const probe = preview({ stability: 1, difficulty: 9.9, reps: 1, last_review_at: now - 400 * MS_PER_DAY }, 4, now)
  if (!Number.isFinite(probe.stability) || !Number.isFinite(probe.difficulty)) problems.push('产生 NaN')
  if (probe.difficulty > D_MAX || probe.difficulty < D_MIN) problems.push('难度越界')
  if (probe.stability > S_MAX || probe.stability < S_MIN) problems.push('稳定度越界')

  // 9) 同日重复复习必须真的让稳定度变化 —— 旧实现在这里会原样返回（增长因子恒为 0），
  //    表现是"同一张卡一天内复习几次，间隔一点没变"，等于白复习。
  const sameDay = preview(
    { stability: 10, difficulty: 5, reps: 5, lapses: 0, status: 'review', last_review_at: now },
    3, now + 10 * 60000)
  if (!(sameDay.stability > 10)) problems.push('同日重复复习（记得）后稳定度没有增长')
  const sameDayHard = preview(
    { stability: 10, difficulty: 5, reps: 5, lapses: 0, status: 'review', last_review_at: now },
    2, now + 10 * 60000)
  if (!(sameDayHard.stability < sameDay.stability)) problems.push('同日复习：吃力 的稳定度不低于 记得')

  // 10) 缺失 last_review_at 的老数据不能把稳定度卡死
  const noLast = preview({ stability: 10, difficulty: 5, reps: 5, lapses: 0, status: 'review' }, 3, now)
  if (!(noLast.stability > 10)) problems.push('last_review_at 缺失时稳定度不增长')

  return { ok: problems.length === 0, problems }
}
