/** Learning eligibility is separate from raw cloud content. No network, writes or FSRS. */
export const QUALITY_VERSION = 'reference-v1'
export const REPORT_VERSION = 'content-v3'
const list = x => Array.isArray(x) ? x : []
const text = x => String(x || '')
const verb = x => /^(?:v\.?|verb)$/i.test(text(x).trim())
const rare = x => /\b(?:archaic|obsolete|dialect(?:al)?|dated)\b|古体|古语|古用法|废弃用法|方言用法|方言形式/i.test(text(x))
export const contentKey = w => JSON.stringify([w.normalized, w.lemma, w.payload || {}])

/** Narrow, sourced exception for the reported false verb. Not a noun-to-verb blacklist. */
function falseLiverVerb(w, value) {
  return text(w.normalized || w.lemma).toLowerCase().trim() === 'liver' &&
    (/^liver(?:s|ed|ing)?\s+(?:with|in|at|on|together|under)\b/i.test(text(value.pattern)) ||
     /\b(?:would|will|to|can)\s+liver\b/i.test(list(value.examples).map(e => e.en).join(' ')))
}

export function assessContent(w) {
  const p = w?.payload || {}, senses = list(p.senses), colls = list(p.collocations)
  const issues = [], badSenses = new Set(), badCollocations = new Set()
  const liver = text(w?.normalized || w?.lemma).toLowerCase().trim() === 'liver'
  senses.forEach((s, i) => {
    if (rare([s?.register, s?.usage, s?.def_en, s?.def_zh].join(' ')) || (liver && verb(s?.pos))) {
      badSenses.add(i)
      issues.push('释义 ' + (i + 1) + '：罕见用法或词性依据待核实，暂不用于现代英语练习。')
    }
  })
  const allSensesUnsafe = senses.length > 0 && badSenses.size === senses.length
  colls.forEach((c, i) => {
    if (allSensesUnsafe || rare([c?.register, c?.usage, c?.zh].join(' ')) || falseLiverVerb(w || {}, c || {})) {
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
  list(p.confusables).forEach(c => { if (rare(c?.note)) issues.push('辨析：罕见用法说明待核实，暂不作为学习依据。') })
  const payload = { ...p,
    senses: senses.filter((_, i) => !badSenses.has(i)),
    collocations: colls.filter((_, i) => !badCollocations.has(i)),
    source_examples: allSensesUnsafe ? [] : list(p.source_examples).filter(e => !(liver && falseLiverVerb(w, { examples:[e] }))),
    // Unverified historical claims are not instructional facts, including in the confusion box.
    confusables: list(p.confusables).filter(c => !rare(c?.note)),
  }
  const usable = payload.senses.some(s => s && (s.def_zh || s.def_en)) ||
    payload.collocations.some(c => c?.pattern) || payload.source_examples.some(e => e?.en)
  return { payload, issues, blocked:!usable, badSenses:[...badSenses], badCollocations:[...badCollocations] }
}

export function learningWord(w) {
  return w ? { ...w, payload:assessContent(w).payload } : null
}

/** A reviewed draft, never an automatic cloud overwrite. Existing metadata is preserved. */
export function repairDraft(w) {
  if (text(w?.normalized || w?.lemma).toLowerCase().trim() !== 'liver' || !assessContent(w).issues.length) return null
  return { source:'https://www.oxfordlearnersdictionaries.com/us/definition/english/liver',
    payload:{ ...(w.payload || {}), lemma:'liver', pos:['noun'],
      senses:[{pos:'noun',def_en:'a large organ in the body that processes substances in the blood',def_zh:'肝脏；（食用的）动物肝脏'}],
      collocations:[
        {pattern:'liver disease',type:'fixed phrase',strength:'strong',register:'neutral',zh:'肝病',examples:[{en:'The doctor is treating a patient with liver disease.',zh:'医生正在治疗一名肝病患者。'}]},
        {pattern:'liver function',type:'fixed phrase',strength:'strong',register:'neutral',zh:'肝功能',examples:[{en:'This blood test checks your liver function.',zh:'这项血液检查用于检查肝功能。'}]},
      ], source_examples:[], confusables:[{word:'live',note:'live 是“居住”的动词；liver 在这里学习现代英语名词“肝脏”。'}],
      word_family:[], mnemonic:null,
    } }
}
