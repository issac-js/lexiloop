/**
 * enrich.js — 词条富化：让大模型给出「地道固定搭配 + 例句」
 *
 * 这是整个工具里最需要把关的一环。LLM 生成搭配最大的风险是「中式英语」和
 * 「生僻但语法正确」的组合，因此这里做了三层约束：
 *   1. 提示词层面：母语者词典编纂者视角、English-first、明令禁止编造、允许低置信度
 *   2. 结构层面：强制 JSON 输出，字段枚举固定
 *   3. 校验层面：本地规则闸门，不通过的一律丢弃（宁可少，不可假）
 */
import { chatText, pickModelAfter } from './cloud.js?v=108'

export const PROMPT_VERSION = 'colloc-v2'

/** 单个词条最多保留多少条搭配（模型常超发，这里硬截断） */
export const MAX_COLLOCATIONS = 6

const TYPES = ['verb+noun', 'adj+noun', 'adv+verb', 'noun+prep', 'verb+prep', 'fixed phrase']
const REGISTERS = ['formal', 'neutral', 'spoken', 'informal']
const STRENGTHS = ['strong', 'medium', 'weak']

const SYSTEM_PROMPT = [
  'You are a lexicographer writing collocation entries for an advanced Chinese-speaking learner',
  'who needs natural professional English.',
  '',
  'Rules:',
  '1. Output ONLY one valid JSON object. No prose, no markdown fences.',
  '2. Collocations must be high-frequency natural chunks a native speaker produces without',
  '   thinking. NEVER invent rare, awkward or literal-translation collocations — omit instead.',
  '3. Be terse. Chinese glosses stay short (under 12 characters). No explanatory sentences.',
  '4. The example sentence must actually contain its collocation, and stay 6-20 words.',
].join('\n')

/** 紧凑字段说明：直接把这份骨架填满即可，避免长篇 schema 拖长生成时间 */
const SHAPE = [
  '{',
  '  "lemma": "base form",',
  '  "pos": ["verb"],',
  '  "ipa": { "uk": "/.../", "us": "/.../" },',
  '  "senses": [{ "pos": "verb", "def_en": "short English definition", "def_zh": "中文释义" }],',
  '  "collocations": [{',
  '    "pattern": "collocation, placeholders in parentheses",',
  '    "type": "verb+noun|adj+noun|adv+verb|noun+prep|verb+prep|fixed phrase",',
  '    "strength": "strong|medium|weak",',
  '    "register": "formal|neutral|spoken|informal",',
  '    "zh": "中文意思",',
  '    "examples": [{ "en": "one sentence containing the pattern", "zh": "中文翻译" }]',
  '  }],',
  '  "confusables": [{ "word": "...", "note": "一句话辨析" }],',
  '  "word_family": ["derived forms"],',
  '  "mnemonic": "only if etymologically accurate, else null",',
  '  "confidence": 0.0',
  '}',
].join('\n')

function buildUserPrompt(term) {
  return [
    'TARGET: "' + term + '"',
    '',
    'Fill in this JSON shape exactly (keep the key names):',
    SHAPE,
    '',
    'Limits — respect them strictly, this keeps the answer short:',
    '- collocations: 4 to 5 items, ordered by usefulness',
    '- examples: exactly 1 per collocation',
    '- senses: at most 2',
    '- confusables: at most 2',
    '- word_family: at most 4',
    '- strength "strong" only when native speakers treat it as a fixed chunk',
    '- confidence: your honest 0-1 estimate that every collocation is natural native usage',
  ].join('\n')
}

/* ───────────────────────── 本地规则闸门 ───────────────────────── */

const words = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'at', 'by', 'with', 'and', 'or'])

/** 礼貌标记：不是搭配的组成部分，不该要求出现在搭配里 */
const POLITENESS = new Set(['please', 'kindly'])

/**
 * 词典里的占位符，不算实词。
 * 关键：`follow up on sth` 的真实搭配是「follow up on a request」——
 * 要求搭配里出现 sth 本身就永远不可能匹配，会把整条词都判成脱靶。
 */
const PLACEHOLDERS = new Set([
  'sb', 'sbs', 'sth', 'sths', 'someone', 'somebody', 'something', 'somethings',
  'oneself', 'one', 'ones', 'people', 'person', 'someplace', 'somewhere',
])

/** 归一化：去所有格 's、去非字母（保留连字符），供两侧统一比对 */
const normToken = (t) => String(t || '').replace(/'s$/, '').replace(/[^a-z0-9-]/g, '')

/** 单个词的词形变体（含常见屈折的截断形式） */
function stemsFor(part) {
  const out = new Set([part])
  if (part.length > 4 && part.endsWith('e')) out.add(part.slice(0, -1))
  if (part.length > 4 && part.endsWith('y')) out.add(part.slice(0, -1) + 'i')
  return Array.from(out).filter((v) => v.length >= 3)
}

/**
 * 搭配串里必须出现目标词，否则判为脱靶。
 * 多词词组要求**每个实词都命中** —— 否则「access control」会误收只含 access 的搭配。
 * 两侧必须用**同一套分词与归一化**：
 *   · 连字符保留 —— `case-by-case` / `sub-district` / `low-latency` 若一侧删连字符、
 *     另一侧保留，就永远匹配不上（这个 bug 曾让模型给出的正确搭配全部被拒）。
 *   · 占位符（sb/sth/one's…）与礼貌标记（please/kindly）不算实词。
 */
export function mentionsTarget(term, text) {
  const tokens = words(text)
  const parts = words(term)
    .map(normToken)
    .filter((p) => p && p.length >= 3 && !STOPWORDS.has(p) && !PLACEHOLDERS.has(p) && !POLITENESS.has(p))
  // 整个词条都是占位符/虚词时，退化为「只要文本里还有实词就算命中」
  if (!parts.length) return tokens.some((t) => t.length >= 3)
  return parts.every((part) => {
    const st = stemsFor(part)
    return tokens.some((t) => {
      const tn = normToken(t)
      return st.some((s) => tn === s || tn.indexOf(s) === 0)
    })
  })
}

const oneOf = (v, list, fallback) => (list.indexOf(v) >= 0 ? v : fallback)
const str = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * 解析并校验模型输出。返回 { data, dropped, notes }。
 * 任何一条搭配只要触发闸门就被丢弃 —— 宁缺勿假。
 */
export function validateEntry(raw, term) {
  const notes = []
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (e) {
    return { data: null, dropped: 0, notes: ['模型输出不是合法 JSON'] }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { data: null, dropped: 0, notes: ['模型输出不是对象'] }
  }

  const dropped = []
  const collocations = []

  ;(Array.isArray(parsed.collocations) ? parsed.collocations : []).forEach((c, i) => {
    if (!c || typeof c !== 'object') return
    const pattern = str(c.pattern)
    if (!pattern) {
      dropped.push('#' + (i + 1) + ' 缺少 pattern')
      return
    }
    if (!mentionsTarget(term, pattern)) {
      dropped.push('"' + pattern + '" 未包含目标词')
      return
    }
    const examples = (Array.isArray(c.examples) ? c.examples : [])
      .map((e) => ({ en: str(e && e.en), zh: str(e && e.zh) }))
      .filter((e) => {
        if (!e.en) return false
        const n = words(e.en).length
        if (n < 5 || n > 30) return false
        return mentionsTarget(term, e.en) || containsChunk(e.en, pattern)
      })

    if (examples.length === 0) {
      dropped.push('"' + pattern + '" 无合格例句（要求 5-30 词且含该搭配）')
      return
    }

    collocations.push({
      pattern,
      type: oneOf(c.type, TYPES, 'fixed phrase'),
      strength: oneOf(c.strength, STRENGTHS, 'medium'),
      register: oneOf(c.register, REGISTERS, 'neutral'),
      zh: str(c.zh),
      confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : null,
      examples: examples.slice(0, 2),
    })
  })

  if (collocations.length === 0) notes.push('没有任何搭配通过校验')

  // 模型常无视条数上限，这里硬性截断：既保证界面整洁，也控制生成与存储成本
  const capped = collocations.slice(0, MAX_COLLOCATIONS)
  if (collocations.length > capped.length) {
    notes.push('超出上限，已截断 ' + (collocations.length - capped.length) + ' 条')
  }

  const overallRaw = typeof parsed.confidence === 'number' ? parsed.confidence : null
  const avg = collocations.length
    ? collocations.reduce((a, c) => a + (c.confidence == null ? 0.6 : c.confidence), 0) / collocations.length
    : 0

  const data = {
    lemma: str(parsed.lemma) || term,
    pos: (Array.isArray(parsed.pos) ? parsed.pos : []).map(str).filter(Boolean),
    ipa: {
      uk: str(parsed.ipa && parsed.ipa.uk),
      us: str(parsed.ipa && parsed.ipa.us),
    },
    senses: (Array.isArray(parsed.senses) ? parsed.senses : [])
      .map((s) => ({
        pos: str(s && s.pos),
        def_en: str(s && s.def_en),
        def_zh: str(s && s.def_zh),
      }))
      .filter((s) => s.def_zh || s.def_en)
      .slice(0, 4),
    collocations: capped,
    confusables: (Array.isArray(parsed.confusables) ? parsed.confusables : [])
      .map((c) => ({ word: str(c && c.word), note: str(c && c.note) }))
      .filter((c) => c.word && c.note)
      .slice(0, 3),
    word_family: (Array.isArray(parsed.word_family) ? parsed.word_family : []).map(str).filter(Boolean).slice(0, 8),
    mnemonic: str(parsed.mnemonic) || null,
    tags: (Array.isArray(parsed.tags) ? parsed.tags : []).map(str).filter(Boolean).slice(0, 4),
    confidence: overallRaw == null ? avg : Math.max(0, Math.min(1, overallRaw)),
    prompt_version: PROMPT_VERSION,
  }

  // 形态校验：命中就在写入前标出来（不是丢弃 —— 罕见但真实的用法也会命中，交给人判断）。
  // 这是"新导入的词不再产生错误搭配"的第一道闸门。
  const check = validatePayload(data, term)
  if (!check.ok) {
    data.verification_status = 'suspect'
    data.verify_note = check.problems.join('；').slice(0, 500)
  }

  return {
    data,
    dropped: dropped.length,
    notes: notes.concat(dropped).concat(check.problems.map((x) => '形态校验：' + x)),
    valid: check.ok,
  }
}

/** 生成结果的**形态校验**（在写入词库前跑）。
 *
 *  规则来自 2026-10-10 的全库实测：AI 为了凑出"搭配"，会给名词硬造动词用法 ——
 *  statement→statemented、screwdriver→screwdrivered、vinegar→vinegared、
 *  sentinel→sentineled，甚至整词虚构（deplenish）。这类问题**在生成时就能用规则拦下**，
 *  不必等到用户学了几十次才发现。
 *
 *  注意它是**筛查**不是判决：命中的内容并非全都错（罕见但真实存在的动词用法也会命中），
 *  所以命中一律标记待审核，而不是直接丢弃。
 *
 *  @returns {{ok:boolean, problems:string[]}}
 */
export function validatePayload(data, term) {
  const problems = []
  const t = String(term || (data && data.lemma) || '').toLowerCase().trim()
  const senses = (data && data.senses) || []
  const colls = (data && data.collocations) || []
  const pos = String((senses[0] || {}).pos || '').toLowerCase()

  if (!t) problems.push('缺少词条本身')
  if (!senses.length) problems.push('缺少义项')
  if (!colls.length) problems.push('缺少搭配')

  const isVerb = pos === 'v' || pos === 'verb' || pos === 'v.'
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  colls.forEach((c, i) => {
    const ex = String((((c.examples || [])[0]) || {}).en || '')
    if (!ex || !t) return
    const low = ex.toLowerCase()
    if (!isVerb && !/\s/.test(t)) {
      // ★ 核心规则：词性不是动词，例句却出现它的动词形式 —— 虚构动词的典型特征
      if (new RegExp('\\b' + esc(t) + '(ed|ing|es|s)\\b', 'i').test(low)) {
        problems.push('第 ' + (i + 1) + ' 条：词性标注为「' + (pos || '未知') + '」，例句却把该词当动词用 —— ' + ex.slice(0, 70))
      }
    }
    // 例句里完全没有词条词干 —— 搭配与例句脱节。
    // **只对单词词条生效**：短语的不规则屈折规则判不了（deal with → dealt with），
    // 硬判会把正常内容误报成问题，而误报会让这道闸门很快失去信任。
    const stem = t.replace(/(ed|ing|es|s)$/, '')
    if (!/\s/.test(t) && stem.length >= 4 && !low.includes(stem)) {
      problems.push('第 ' + (i + 1) + ' 条：例句里找不到「' + stem + '」 —— ' + ex.slice(0, 70))
    }
  })

  return { ok: problems.length === 0, problems: problems }
}

/* ───────────────────── 内容复核 ───────────────────── */

/** 复核用的系统提示。**与生成用的提示刻意分开**：
 *  生成要"产出内容"，复核要"挑毛病"—— 同一个提示做不到两者，
 *  而且生成时用过的提示会带偏向（倾向于认为自己做的是对的）。
 *
 *  severity 的两档划分对应两种完全不同的处置：
 *    blocking = 会教错（词性标错、虚构用法）→ 挡住，不进学习队列
 *    advisory = 内容可用但不完美（个别搭配欠佳、义项不全）→ 记录，照常学
 *  把它们合成一个"有问题"会导致因一条搭配欠佳就挡住整条词条。 */
export const REVIEW_SYSTEM_PROMPT = [
  'You are a lexicographer reviewing an English vocabulary card for a Chinese university campus-safety officer (CEFR B1-B2).',
  'Judge strictly and honestly. Output JSON only, no prose.',
  'Schema:',
  '{"pos_ok":true|false,"pos_issue":"词性标注错在哪，没错就空字符串",',
  ' "collocations":[{"index":1,"idiomatic":true|false,"register":"formal|neutral|informal|technical|literary|dated","issue":"具体问题，没问题就空字符串"}],',
  ' "missing_senses":["对这个学习者常用但词条里没有的义项，没有就空数组"],',
  ' "severity":"none|advisory|blocking","reason":"一句话"}',
  'severity 判定标准：',
  '- blocking：**词性的根本性错误**（名词、形容词被标成动词），或**整条词条的释义是虚构的**（英语中不存在该义项）。这类会建立错误的词感，必须挡住。',
  '- advisory：个别搭配不地道、单条例句有小语法错、义项不全 —— 词条主体可用，学习者从其他搭配仍能学到正确用法。记录即可，不必挡住。',
  '- none：没有问题。',
  '关键区分：**问题出在"词条本身"还是"某一条搭配"**。前者 blocking，后者 advisory。',
  '**以下情况不算错误，不要判 blocking**（词典常规做法）：',
  '- 动词短语（make a statement、take a stand against）标注为 verb。',
  '- 分词形式单独成条（given、stemming from、related to）标注为 verb 或 adjective。',
  '- 固定短语、句式模板标注为 fixed phrase。',
  '注意：idiomatic=false 只在搭配本身不地道或语法有问题时才用；风格偏好不算问题。',
].join('\n')

/** 复核一个词条（不写库，返回结构化结论）。
 *  @returns {{ok:boolean, severity:string, issues:string[], missing:string[], kinds:string, raw:string}}
 */
export async function reviewTerm(entry, opts) {
  const o = opts || {}
  const payload = {
    term: entry.term || entry.normalized,
    senses: (entry.senses || []).map((s) => ({ pos: s.pos, def_zh: s.def_zh })),
    collocations: (entry.collocations || []).map((c) => ({
      p: c.pattern, zh: c.zh,
      ex: (((c.examples || [])[0]) || {}).en,
    })),
  }
  const raw = await chatText({
    system: REVIEW_SYSTEM_PROMPT,
    user: 'Entry: ' + JSON.stringify(payload),
    json: true,
    temperature: 0,
    model: o.model,
    maxTokens: o.maxTokens || 700,
    signal: o.signal,
  })
  let j = null
  try { j = JSON.parse(raw) } catch (e) { j = null }
  if (!j) return { ok: false, severity: 'unknown', issues: [], missing: [], kinds: 'parse_error', raw: String(raw).slice(0, 300) }

  const issues = []
  if (j.pos_ok === false) issues.push('词性标注：' + (j.pos_issue || '与搭配用法不符'))
  ;(j.collocations || []).forEach((x) => {
    if (x.idiomatic === false && x.issue) issues.push('第 ' + x.index + ' 条搭配：' + x.issue)
  })
  const sev = ['none', 'advisory', 'blocking'].indexOf(j.severity) >= 0 ? j.severity : 'advisory'
  return {
    ok: true,
    severity: sev,
    issues: issues,
    missing: (j.missing_senses || []).filter(Boolean),
    kinds: (j.pos_ok === false ? 'pos ' : '') + (issues.length ? 'coll ' : '') + ((j.missing_senses || []).length ? 'sense' : ''),
    register: (j.collocations || []).map((x) => x.register).filter(Boolean),
    reason: j.reason || '',
    raw: '',
  }
}

/** 例句里是否原样包含搭配（忽略大小写） */
function containsChunk(sentence, pattern) {
  const norm = (s) => ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '
  const core = String(pattern).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  if (!core) return false
  const parts = norm(core).trim().split(' ')
  return parts.every((p) => norm(sentence).indexOf(p) >= 0)
}

/** 单次富化最长等待。实测云端一个词条要 4–180 秒，生成跑在后台任务里，
 *  宁可多等也别白失败一次（失败一次的代价是整轮的等待全丢掉）。 */
export const ENRICH_TIMEOUT_MS = 300000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 是不是被限流了 —— 这类错误值得退避重试，其它错误不值得 */
export function isRateLimited(err) {
  const code = (err && err.error && err.error.code) || ''
  const msg = String((err && err.error && err.error.message) || (err && err.message) || err || '')
  if (code.indexOf('quota_') === 0) return true
  return /限流|rate.?limit|too many requests|429/i.test(msg)
}

/** leech（反复遗忘）卡片的改写提示词：更短、更具体、更贴近日常场景 */
const LEECH_SYSTEM_PROMPT = [
  'You are a lexicographer fixing a flashcard that a Chinese learner keeps forgetting.',
  'The research is clear: when a card fails repeatedly, the CARD is the problem, not the learner.',
  '',
  'Rules:',
  '1. Output ONLY one valid JSON object. No prose, no markdown fences.',
  '2. Rewrite the entry to be SHORTER and more CONCRETE than a normal entry:',
  '   - exactly 2 collocations (never more), each the shortest useful chunk',
  '   - prefer the highest-frequency everyday sense over rare/literary ones',
  '   - each example under 12 words, about a concrete real-life situation',
  '3. Every collocation must literally contain the target word.',
  '4. Set "strength" honestly and "confidence" as your honest 0-1 probability that the',
  '   collocation is natural native usage.',
  '5. If the target is not a real English word or chunk, return {"collocations":[]}.',
].join('\n')

function buildLeechPrompt(term) {
  return [
    'TARGET: "' + term + '"',
    '',
    'Fill in this JSON shape exactly (keep the key names):',
    SHAPE,
    '',
    'Hard limits for this rewrite:',
    '- collocations: EXACTLY 2, shortest possible chunks, everyday register',
    '- examples: exactly 1 per collocation, under 12 words, concrete situation',
    '- senses: exactly 1, plain-language Chinese definition',
    '- confusables: at most 1',
    '- word_family: empty array',
    '- keep "zh" fields in Simplified Chinese',
  ].join('\n')
}

/** 供诊断使用：拿到实际发给模型的提示词 */
export function debugPrompt(term) {
  return { system: SYSTEM_PROMPT, user: buildUserPrompt(term) }
}

/**
 * 富化一个词条。失败时抛出带可读文案的错误，由调用方降级处理。
 */
export async function enrichTerm(term, opts) {
  const o = opts || {}
  const limit = o.timeoutMs || ENRICH_TIMEOUT_MS
  const own = new AbortController()
  const signal = o.signal || own.signal

  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // 双保险：既中断底层流，也保证调用方一定被释放
      try { own.abort() } catch (e) { /* ignore */ }
      reject(new Error('生成超时（' + Math.round(limit / 1000) + ' 秒），可稍后重试'))
    }, limit)
  })

  try {
    // 被限流就退避重试，连续被限流就换一个推荐模型再试 ——
    // 单模型被限流不该让整个词条生成失败（实测 v4.1-flash 会被单独限流）。
    const tried = []
    let model = o.model
    let raw = ''
    let lastErr = null

    for (let attempt = 0; attempt < 4; attempt++) {
      if (model) tried.push(model)
      const leechMode = o.mode === 'leech'
      try {
        raw = await Promise.race([
          chatText({
            system: leechMode ? LEECH_SYSTEM_PROMPT : SYSTEM_PROMPT,
            user: leechMode ? buildLeechPrompt(term) : buildUserPrompt(term),
            json: true,
            temperature: 0.4,
            model,
            maxTokens: o.maxTokens || 1400,
            signal,
            onDelta: o.onDelta,
          }),
          guard,
        ])
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        if (!isRateLimited(e) || attempt === 3) throw e
        await sleep(1500 * Math.pow(2, attempt))   // 1.5s → 3s → 6s
        if (attempt >= 1) {
          const alt = await pickModelAfter(tried).catch(() => null)
          if (alt) model = alt.id
        }
      }
    }
    if (lastErr) throw lastErr

    const result = validateEntry(raw, term)
    if (!result.data) {
      // 最常见的原因：模型把全部输出预算花在推理上，正文一个字都没吐出来
      if (!raw || !raw.trim()) {
        throw new Error('模型没有返回正文（输出预算被推理占满），换一个模型试试，推荐 DeepSeek-V4-Flash')
      }
      throw new Error('模型返回的不是合法 JSON，可重试')
    }
    if (result.data.collocations.length === 0) {
      throw new Error('模型未给出可用的地道搭配，可重试')
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}
