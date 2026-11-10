/** Learning eligibility is separate from raw cloud content. No network, writes or FSRS. */
export const QUALITY_VERSION = 'reference-v1'
export const REPORT_VERSION = 'content-v3'
const list = x => Array.isArray(x) ? x : []
const text = x => String(x || '')
const verb = x => /^(?:v\.?|verb)$/i.test(text(x).trim())
const rare = x => /\b(?:archaic|obsolete|dialect(?:al)?|dated)\b|古体|古语|古用法|废弃用法|方言用法|方言形式/i.test(text(x))
// Usage labels differ from ordinary meanings: archaic/obsolete/dialect are modern words too.
const rareAnnotation = x => /[[(（【]\s*(?:archaic|obsolete|dialect(?:al)?|dated|古体|古语|古用法|方言)[\])）】]|\b(?:archaic|obsolete|dialect(?:al)?|dated)\s+(?:form|usage|spelling|sense)\b|(?:古体|古语|方言|废弃)(?:或方言)?(?:用法|形式)/i.test(text(x))
export const contentKey = w => JSON.stringify([w.normalized, w.lemma, w.payload || {}])

/** Narrow, sourced exception for the reported false verb. Not a noun-to-verb blacklist. */
function falseLiverVerb(w, value) {
  return text(w.normalized || w.lemma).toLowerCase().trim() === 'liver' &&
    ((/^verb\+/.test(text(value.type)) && /^liver\b/i.test(text(value.pattern))) ||
     /居住|同住|住在/.test(text(value.zh)) ||
     /\b(?:he|she|they|we|i|you|knight|man|woman)\s+(?:would|will|should|can|could)\s+liver\b/i.test(list(value.examples).map(e => e.en).join(' ')))
}

const featVerbForm = value => /\bfeat(?:ed|ing)\b/i.test(text(value))
const falseFeatExample = example => featVerbForm(example?.en) ||
  /\b(?:he|she|they|we|i|you)\s+feats?\s+(?:a|an|the)\s+(?:[\w-]+\s+){0,3}goal\b/i.test(text(example?.en))

// Cambridge lists feat as a countable noun in contemporary English.
function falseFeatCollocation(c) {
  const pattern = text(c?.pattern).trim()
  return featVerbForm(pattern) ||
    (/^verb(?:\+|$)/i.test(text(c?.type).trim()) && /^feats?\b/i.test(pattern)) ||
    /^feats?\s+(?:a|an|the)\s/i.test(pattern) ||
    list(c?.examples).some(falseFeatExample)
}

const wordKey = w => text(w?.normalized || w?.lemma).trim().toLowerCase()
const dictionary = term => 'https://dictionary.cambridge.org/dictionary/english/' + term
const collocation = (pattern, zh, en, translation) => ({
  pattern, type:'fixed phrase', strength:'strong', register:'neutral', zh, examples:[{ en, zh:translation }],
})

/** Old imports used the derivative as a key and the related verb as the displayed headword. */
const legacyHeadwords = {
  approval:['approve','noun','official permission or a favorable opinion','批准；认可'],
  clarification:['clarify','noun','an explanation that makes something clearer','澄清；说明'],
  devaluation:['devalue','noun','a reduction in the value of something, especially a currency','贬值；（尤指货币）贬值'],
  diagnosis:['diagnose','noun','identification of an illness or problem','诊断；诊断结果'],
  dispersal:['disperse','noun','the process of spreading or scattering','散布；扩散；疏散'],
  exemption:['exempt','noun','permission to be free from an obligation, payment or rule','豁免；免除'],
  gatekeeper:['gatekeep','noun','someone who controls access to a place, organization or information','守门人；控制准入的人'],
  insemination:['inseminate','noun','the introduction of sperm for fertilization','授精'],
  joneses:['jones','noun','used in the idiom keep up with the Joneses, meaning to match other people’s possessions or lifestyle','the Joneses 用于“与邻居或周围人攀比”这一习语'],
  palpitation:['palpitate','noun','a noticeably fast, hard or irregular heartbeat, often used in the plural','心悸；心跳异常感（常用复数）'],
  rebellious:['rebel','adjective','resisting control, rules or authority','叛逆的；反抗的'],
  respiration:['respire','noun','breathing or the process by which cells release energy','呼吸；细胞呼吸'],
  sanitizer:['sanitize','noun','a substance used to reduce germs, especially on the hands','消毒剂；手部消毒剂'],
  scalper:['scalp','noun','a person who resells tickets at a higher price','票贩子；黄牛'],
  squinty:['squint','adjective','with the eyes partly closed or narrowed','眯着眼的'],
  vexation:['vex','noun','annoyance, frustration, or something that causes it','烦恼；令人恼火的事'],
}
const reviewedWords = {
  bib:{
    pos:'noun', wrongForm:/\bbibb(?:ed|ing)\b/i,
    collocations:[
      collocation('a baby bib','婴儿围嘴','Put a bib on the baby before lunch.','午饭前给宝宝戴上围嘴。'),
      collocation('a race bib','比赛号码布','Runners must wear their race bib on the front of their shirt.','参赛跑者必须把号码布佩戴在衣服正面。'),
    ],
    sense:['a cloth worn to protect clothes or display a competitor’s number','围嘴；比赛号码布'],
    confusables:[{word:'put a bib on someone',note:'表示“给某人戴上围嘴”。'}],
  },
  feat:{
    pos:'noun', wrongForm:/\bfeat(?:ed|ing)\b/i,
    collocations:[
      collocation('a remarkable feat','了不起的壮举','Scoring a goal in the final minutes of the match was a remarkable feat.','在比赛最后几分钟进球是一项了不起的壮举。'),
      collocation('a feat of engineering','工程壮举','Building the bridge across that valley was a feat of engineering.','在那条山谷上建桥是一项工程壮举。'),
      collocation('no mean feat','很不容易的成就','Finishing the project in a week was no mean feat.','一周内完成这个项目很不容易。'),
    ],
    sense:['an impressive achievement that takes skill, effort or courage','壮举；了不起的成就'],
    confusables:[
      {word:'score a goal',note:'体育中表示“进球”。He scored a remarkable goal in the final minutes of the match.'},
      {word:'achieve a goal',note:'表示“实现目标”，例如达成项目目标。'},
    ],
  },
  corpus:{
    pos:'noun', wrongForm:/\bcorpused\b|\bcorpusing\b/i,
    collocations:[
      collocation('a corpus of texts','语料库；一批文本','The researchers built a corpus of news articles.','研究人员建立了一个新闻报道语料库。'),
      collocation('build a corpus','建立语料库','We built a corpus of interviews for the study.','我们为这项研究建立了一个访谈语料库。'),
    ],
    sense:['a collection of texts or other material used for study','语料库；文献或作品汇编'],
  },
  solid:{
    pos:'adjective', wrongForm:/\bsolidif(?:y|ies|ied|ying)\b/i,
    collocations:[
      collocation('solid evidence','可靠的证据','We need solid evidence before drawing a conclusion.','下结论之前需要可靠的证据。'),
      collocation('solid rock','坚硬的岩石','The tunnel was cut through solid rock.','隧道是从坚硬的岩石中开凿出来的。'),
    ],
    sense:['firm, or reliable and well supported','坚固的；可靠的'],
  },
  subsidy:{
    pos:'noun', oldLemma:'subsidize', wrongForm:/\bsubsidi[sz](?:e[ds]?|ing)\b/i,
    collocations:[
      collocation('a government subsidy','政府补贴','The company received a government subsidy to train new employees.','公司获得了用于培训新员工的政府补贴。'),
      collocation('a housing subsidy','住房补贴','Eligible families can apply for a housing subsidy.','符合条件的家庭可以申请住房补贴。'),
    ],
    sense:['money paid by a government or organization to support an activity or reduce costs','补贴；津贴'],
  },
  congee:{pos:'noun',wrongForm:/\bcongee(?:d|ing)\b/i,sense:['rice cooked in plenty of water to make a soft porridge','米粥；稀饭']},
}

function staleHeadword(w, key, oldLemma) {
  return [w?.lemma, w?.payload?.lemma].some(value => text(value).trim().toLowerCase() === oldLemma && oldLemma !== key)
}

function reviewedCollocationIssue(key, c) {
  const pattern = text(c?.pattern).trim()
  if (key === 'feat') return falseFeatCollocation(c)
  if (key === 'bib') return /^bib\s*\(/i.test(pattern) && /^verb(?:\+|$)/i.test(text(c?.type))
  if (key === 'corpus') return /^(?:be\s+corpus\b|corpus\s+together\b)/i.test(pattern) ||
    (/^verb(?:\+|$)/i.test(text(c?.type)) && /^corpus\b/i.test(pattern))
  if (key === 'dumb') return /^dumb\s+\(someone\)\s+(?:with|into|by)\s+\(something\)$/i.test(pattern)
  if (key === 'solid' || key === 'subsidy') return reviewedWords[key].wrongForm.test(pattern) &&
    !new RegExp('\\b' + key + 's?\\b','i').test(pattern)
  return key === 'congee' && reviewedWords.congee.wrongForm.test(pattern)
}

export function assessContent(w) {
  const p = w?.payload || {}, senses = list(p.senses), colls = list(p.collocations)
  const issues = [], badSenses = new Set(), badCollocations = new Set()
  const key = wordKey(w)
  const liver = key === 'liver'
  const feat = key === 'feat'
  const reviewed = Object.hasOwn(reviewedWords, key) ? reviewedWords[key] : null
  const legacy = Object.hasOwn(legacyHeadwords, key) ? legacyHeadwords[key] : null
  const stale = (legacy || reviewed?.oldLemma) && staleHeadword(w, key, legacy?.[0] || reviewed.oldLemma)
  if (stale) issues.push('词头与原词条不一致，已核对目标词。')
  if (reviewed && list(p.pos).some(verb)) issues.push('词性标记混入了动词。')
  senses.forEach((s, i) => {
    if ((rare([s?.register, s?.usage].join(' ')) || rareAnnotation([s?.def_en, s?.def_zh].join(' '))) || ((liver || reviewed || stale) && verb(s?.pos))) {
      badSenses.add(i)
      issues.push('释义 ' + (i + 1) + '：罕见用法或词性依据待核实，暂不用于现代英语练习。')
    }
  })
  const allSensesUnsafe = !stale && senses.length > 0 && badSenses.size === senses.length
  colls.forEach((c, i) => {
    if (allSensesUnsafe || (rare([c?.register, c?.usage].join(' ')) || rareAnnotation(c?.zh)) ||
        falseLiverVerb(w || {}, c || {}) || reviewedCollocationIssue(key, c)) {
      badCollocations.add(i)
      issues.push('搭配 ' + (i + 1) + '：参考用法待核实，暂不出题。')
    }
  })
  // The exact snapshot binds indices to content. Old reports cannot quarantine edited entries.
  try {
    const r = JSON.parse(w?.verify_note || 'null')
    if (r?.kind === 'lexiloop-content-report' && r.version === REPORT_VERSION && r.contentKey === contentKey(w)) {
      for (const i of list(r.quarantinedCollocations)) if (Number.isInteger(i) && i >= 0 && i < colls.length) {
        badCollocations.add(i)
        issues.push('搭配 ' + (i + 1) + '：复核发现具体问题，暂不出题。')
      }
    }
  } catch (_) { /* A malformed report is never a source of authority. */ }
  const badConfusable = c => (key === 'obsolete' ? rareAnnotation(c?.note) : rare(c?.note)) || (liver && /动词\s*liver\b|verb\s+liver\b/i.test(text(c?.note))) ||
    (key === 'joneses' && /第三人称单数/i.test(text(c?.note)))
  list(p.confusables).forEach(c => { if (badConfusable(c)) issues.push('辨析：用法依据待核实，暂不作为学习依据。') })
  const unsafeExamples = new Set([...badCollocations].flatMap(i => list(colls[i]?.examples).map(e => text(e?.en).trim())))
  const sourceExamples = list(p.source_examples).filter(e => !unsafeExamples.has(text(e?.en).trim()) &&
    !(liver && falseLiverVerb(w, { examples:[e] })) && !(feat && falseFeatExample(e)) &&
    !(key === 'bib' && reviewed.wrongForm.test(text(e?.en))))
  const wordFamily = list(p.word_family).filter(x => !(liver && /^(?:live|lives|living|lived)$/i.test(text(x))) &&
    !(reviewed && ['bib','feat','corpus','congee'].includes(key) && reviewed.wrongForm.test(text(x))))
  if (feat && list(p.source_examples).some(falseFeatExample)) issues.push('原始例句：feat 被误用为动词，暂不用于学习。')
  if (wordFamily.length !== list(p.word_family).length && reviewed) issues.push('同族词中有不适用的动词形式。')
  const payload = { ...p,
    senses: senses.filter((_, i) => !badSenses.has(i)),
    collocations: colls.filter((_, i) => !badCollocations.has(i)),
    source_examples: allSensesUnsafe ? [] : sourceExamples,
    // Unverified historical claims are not instructional facts, including in the confusion box.
    confusables: list(p.confusables).filter(c => !badConfusable(c)),
    word_family:wordFamily,
  }
  const usable = payload.senses.some(s => s && (s.def_zh || s.def_en)) ||
    payload.collocations.some(c => c?.pattern) || payload.source_examples.some(e => e?.en)
  return { payload, issues, blocked:!usable, badSenses:[...badSenses], badCollocations:[...badCollocations] }
}

export function learningWord(w, quality) {
  if (!w) return null
  /* 只有真正算好的质量结果才复用；传进来别的值（例如 map 的索引）一律重算。 */
  const q = quality && Array.isArray(quality.issues) ? quality : assessContent(w)
  const draft = repairDraft(w, q)
  return draft ? { ...w, lemma:draft.payload.lemma, payload:draft.payload } : { ...w, payload:q.payload }
}

/** A reviewed draft, never an automatic cloud overwrite. Existing metadata is preserved. */
export function repairDraft(w, quality = assessContent(w)) {
  if (!quality.issues.length) return null
  const key = wordKey(w)
  const eligible = quality.payload
  if (Object.hasOwn(legacyHeadwords, key)) {
    const [oldLemma, pos, def_en, def_zh] = legacyHeadwords[key]
    if (!staleHeadword(w, key, oldLemma) && key !== 'joneses') return null
    const lemma = key === 'joneses' ? 'Joneses' : key
    const source = key === 'joneses' ? dictionary('keep-up-with-the-joneses') :
      key === 'squinty' ? 'https://www.collinsdictionary.com/us/dictionary/english/squinty' : dictionary(key)
    const payload = { ...eligible, lemma, pos:[pos], senses:[{pos,def_en,def_zh}] }
    if (key === 'joneses') {
      payload.confusables = [{word:'the Joneses',note:'这里是姓氏 Jones 的复数，在习语中代指用来攀比的人。'}]
      payload.word_family = []
    }
    return { source, payload }
  }
  if (Object.hasOwn(reviewedWords, key)) {
    const row = reviewedWords[key]
    const [def_en, def_zh] = row.sense
    const senses = eligible.senses.length ? eligible.senses : [{pos:row.pos,def_en,def_zh}]
    const pos = [...new Set(senses.map(s => s?.pos).filter(Boolean))]
    const collocations = eligible.collocations.length ? eligible.collocations : row.collocations || []
    return { source:dictionary(key),
      payload:{ ...eligible, lemma:key, pos, senses, collocations, confusables:row.confusables || eligible.confusables } }
  }
  if (key === 'dumb' && list(w?.payload?.collocations).some(c => reviewedCollocationIssue(key, c))) {
    return { source:'https://www.oxfordlearnersdictionaries.com/definition/american_english/dumb-down',
      payload:{ ...eligible, lemma:key, pos:['adjective'],
        collocations:eligible.collocations.filter(c => !/^dumb\s+\(someone\)\s+down$/i.test(text(c?.pattern)) ||
          !eligible.collocations.some(other => /^dumb\s+\(something\)\s+down$/i.test(text(other?.pattern)))),
        confusables:[{word:'dumb down',note:'动词短语，指把内容过度简化。'}],
      } }
  }
  if (key !== 'liver') return null
  return { source:'https://www.oxfordlearnersdictionaries.com/us/definition/english/liver',
    payload:{ ...(w.payload || {}), lemma:'liver', pos:['noun'],
      senses:[{pos:'noun',def_en:'a large organ in the body that processes substances in the blood',def_zh:'肝脏；（食用的）动物肝脏'}],
      collocations:eligible.collocations.length ? eligible.collocations : [
        {pattern:'liver disease',type:'fixed phrase',strength:'strong',register:'neutral',zh:'肝病',examples:[{en:'The doctor is treating a patient with liver disease.',zh:'医生正在治疗一名肝病患者。'}]},
        {pattern:'liver function',type:'fixed phrase',strength:'strong',register:'neutral',zh:'肝功能',examples:[{en:'This blood test checks your liver function.',zh:'这项血液检查用于检查肝功能。'}]},
      ], source_examples:eligible.source_examples, confusables:[{word:'live',note:'live 是“居住”的动词；liver 在这里学习现代英语名词“肝脏”。'}],
      word_family:eligible.word_family, mnemonic:null,
    } }
}

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const irregularClozeForms = {
  be:['am','is','are','was','were','been','being'],
  do:['does','did','done','doing'], go:['goes','went','gone','going'], have:['has','had'],
  build:['built'], buy:['bought'], catch:['caught'], come:['came'], deal:['dealt'],
  fall:['fell','fallen'], find:['found'], get:['got','gotten'], give:['gave','given'],
  hear:['heard'], keep:['kept'], lead:['led'], leap:['leapt'], learn:['learnt'],
  leave:['left'], lose:['lost'], make:['made'], mean:['meant'], pay:['paid'],
  run:['ran'], say:['said'], see:['saw','seen'], seek:['sought'],
  send:['sent'], sit:['sat'], speak:['spoke','spoken'], stand:['stood'],
  take:['took','taken'], teach:['taught'], tell:['told'], think:['thought'],
  wear:['wore','worn'], win:['won'], write:['wrote','written'],
  arise:['arose','arisen'], bind:['bound'], hold:['held'], lie:['lay','lain'],
  rise:['rose','risen'], strike:['struck','stricken'],
  child:['children'], person:['people'], man:['men'], woman:['women'],
  foot:['feet'], tooth:['teeth'], mouse:['mice'], corpus:['corpora'],
}

function clozeTokenPattern(token) {
  const word = token.toLowerCase()
  if (!/^[a-z]+$/.test(word)) return escapePattern(word)
  const forms = new Set([word, ...(Object.hasOwn(irregularClozeForms, word) ? irregularClozeForms[word] : [])])
  if (word.length < 3) return '(?:' + [...forms].join('|') + ')'
  const consonantY = /[^aeiou]y$/.test(word)
  forms.add(consonantY ? word.slice(0,-1) + 'ies' : word + (/(?:s|x|z|ch|sh|o)$/.test(word) ? 'es' : 's'))
  if (consonantY) forms.add(word.slice(0,-1) + 'ied')
  else forms.add(word + (word.endsWith('e') ? 'd' : 'ed'))
  const ingBase = /e$/.test(word) && !/(?:ee|oe|ye)$/.test(word) ? word.slice(0,-1) : word
  forms.add(word.endsWith('ie') ? word.slice(0,-2) + 'ying' : ingBase + 'ing')
  if (/[^aeiou][aeiou][b-df-hj-np-tv-z]$/.test(word) && !/[wxy]$/.test(word)) {
    const doubled = word + word.at(-1)
    forms.add(doubled + 'ed')
    forms.add(doubled + 'ing')
  }
  return '(?:' + [...forms].join('|') + ')'
}

function clozePattern(phrase) {
  if (!phrase) return null
  return new RegExp('\\b' + phrase.split(/\s+/).map(clozeTokenPattern).join('\\s+') + '(?![a-z0-9])', 'i')
}

export function containsClozeTarget(term, example) {
  return clozePattern(text(term).trim())?.test(text(example)) || false
}

/** The answer is a complete token or phrase from the example. Related words stay out of the blank. */
export function clozeOf(word) {
  const term = text(word?.lemma || word?.normalized).trim()
  const target = clozePattern(term)
  const find = (example, pattern) => {
    const raw = text(example?.en)
    const answer = pattern && raw.match(pattern)?.[0]
    return answer ? { sentence:raw.replace(pattern, '________'), zh:example.zh, answer, raw } : null
  }
  const phrase = /\s/.test(term)
  for (const c of list(word?.payload?.collocations)) {
    const examples = list(c?.examples)
    for (const example of examples) {
      const hit = find(example, target)
      if (hit) return hit
    }
    // Single-word cards use the separate Chinese-to-collocation prompt if no example fits.
    if (!phrase) continue
    const core = text(c?.pattern).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
    const pattern = clozePattern(core)
    for (const example of examples) {
      const hit = find(example, pattern)
      if (hit) return hit
    }
  }
  return null
}
