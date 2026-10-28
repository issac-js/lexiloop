/** labs.js — P2 玩法：搭配对战 / 拖拽组句 / 语音跟读
 *
 * 与 game.js 的关系：labs 自己不持有 mode 状态，由 game.js 用 hasLab/renderLab/bindLab
 * 三个入口调用，避免两个模块互相 import 成环。
 */
import * as S from './store.js?v=114'
import { $, $$, esc, icon, toast, fail, ok, speak } from './ui.js?v=114'
import { normalizeAns, judgeTyped, buildChoices, whyNote } from './views.js?v=114'

/** 答错时的辨析提示；没有可用信息就不渲染 */
function whyBlock(word) {
  const note = whyNote(word)
  if (!note) return ''
  return '<p class="tiny" style="margin:8px 0 0;color:var(--ink-2);">💡 ' + esc(note) + '</p>'
}

export const LAB_MODES = ['battle', 'sentence', 'speech']

const L = { battle: null, sentence: null, speech: null, size: 0 }

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

/** 带释义的词条池 */
function pool(needColloc) {
  const seen = new Set()
  const out = []
  S.state.cards.forEach((c) => {
    const w = S.wordOf(c)
    if (!w || seen.has(w.id) || S.isBlockedWord(w)) return
    const p = w.payload || {}
    const zh = ((p.senses || [])[0] || {}).def_zh
    if (!zh) return
    if (needColloc && !(p.collocations || []).length) return
    seen.add(w.id)
    out.push({ id: w.id, term: w.lemma || w.normalized, zh, payload: p })
  })
  return out
}

/* ═════════════════════════ 搭配对战 ═════════════════════════ */

export function startBattle(count) {
  // 题量：调用方传入手动/自适应值；「再来一局」复用上一次
  const n = Math.min(30, Math.max(3, Number(count) || Number(L.size) || 6))
  L.size = n
  const words = shuffle(pool(true)).slice(0, n)
  if (words.length < 3) { fail('带搭配的词条太少，先去词库补几个'); return false }
  const rounds = words.map((w) => {
    const correct = (w.payload.collocations || [])[0]
    const others = shuffle(pool(true).filter((x) => x.id !== w.id)).slice(0, 2)
    const cards = shuffle([
      { text: correct.pattern, ok: true, zh: correct.zh },
      ...others.map((o) => {
        const c = (o.payload.collocations || [])[0]
        return { text: c.pattern, ok: false, zh: c.zh }
      }),
    ])
    return { w, cards }
  })
  L.battle = { rounds, i: 0, meHp: 100, aiHp: 100, answered: null, done: false, log: [], results: [], credited: false }
  return true
}

function renderBattle() {
  const b = L.battle
  const hp = (v) => '<div class="hp"><i style="width:' + Math.max(0, v) + '%;"></i></div>'

  if (b.done) {
    const win = b.aiHp <= 0 || b.meHp > b.aiHp
    return '<h1 class="page">搭配对战<span class="sub">结束</span></h1>' +
      '<div class="empty"><div class="big">' + (win ? '你赢了 🏆' : '惜败') + '</div>' +
      '<p class="tiny">你的血量 ' + Math.max(0, b.meHp) + '　｜　对手 ' + Math.max(0, b.aiHp) + '</p>' +
      '<div class="btn-group" style="justify-content:center;margin-top:16px;">' +
      (b.credited || !b.results.length
        ? ''
        : '<button class="btn primary" id="lab-battle-credit">把这次表现记进复习计划</button>') +
      '<button class="btn primary" id="lab-battle-again">再来一局</button>' +
      '<button class="btn ghost" id="lab-battle-back">返回</button></div></div>'
  }

  const r = b.rounds[b.i]
  const a = b.answered
  return '<h1 class="page">搭配对战<span class="sub">第 ' + (b.i + 1) + ' / ' + b.rounds.length + ' 回合</span></h1>' +
    '<div class="card tight">' +
    '<div class="row between"><div class="grow"><div class="tiny">你</div>' + hp(b.meHp) + '</div>' +
    '<div class="grow" style="text-align:right;"><div class="tiny">对手</div>' + hp(b.aiHp) + '</div></div>' +
    '</div>' +
    '<div class="card">' +
    '<div class="ask">用哪个搭配守住这一回合？</div>' +
    '<div class="term small" style="margin:8px 0;">' + esc(r.w.zh) + '</div>' +
    '<div class="battle-cards">' + r.cards.map((c, i) =>
      '<button class="bcard' + (a ? (c.ok ? ' good' : '') : '') + '" data-bc="' + i + '"' +
      (a ? ' disabled' : '') + '>' + esc(c.text) + '</button>').join('') + '</div>' +
    (a ? '<div class="verdict ' + (a.ok ? 'good' : 'bad') + '">' +
      (a.ok ? '正确！造成 18 点伤害' : '不对 —— 被反击 12 点。正确搭配：<b>' + esc(a.correct) + '</b>') +
      '</div>' + (!a.ok ? whyBlock(b.rounds[b.i].w) : '') +
      '<div class="row" style="justify-content:center;margin-top:10px;">' +
      '<button class="btn primary" id="lab-battle-next">' +
      (b.i + 1 >= b.rounds.length ? '看结果' : '下一回合') + '</button>' +
      '<button class="btn sm ghost" id="lab-battle-back">退出</button></div>'
      : '<div class="row" style="justify-content:center;margin-top:12px;">' +
        '<button class="btn sm ghost" id="lab-battle-back">退出对战</button></div>') +
    '</div>'
}

function bindBattle(cb) {
  const b = L.battle
  $$('.bcard').forEach((btn) => {
    btn.onclick = () => {
      if (b.answered) return
      const c = b.rounds[b.i].cards[Number(btn.dataset.bc)]
      if (!c) return
      b.answered = { ok: !!c.ok, correct: (b.rounds[b.i].w.payload.collocations[0] || {}).pattern || '' }
      if (c.ok) b.aiHp -= 18
      else b.meHp -= 12
      b.results.push({ id: b.rounds[b.i].w.id, ok: !!c.ok })
      cb()
    }
  })
  const next = $('#lab-battle-next')
  if (next) next.onclick = () => {
    b.i++
    b.answered = null
    if (b.i >= b.rounds.length || b.meHp <= 0 || b.aiHp <= 0) b.done = true
    cb()
  }
  const again = $('#lab-battle-again')
  if (again) again.onclick = () => { startBattle(L.size); cb() }
  const credit = $('#lab-battle-credit')
  if (credit) credit.onclick = async () => {
    credit.disabled = true
    credit.textContent = '写入中…'
    const n = await S.creditGrades(b.results)
    b.credited = true
    ok('已写入 ' + n + ' 个词（对→记得，错→忘了）')
    cb()
  }
  const back = $('#lab-battle-back')
  if (back) back.onclick = () => { L.battle = null; cb(true) }
}

/* ═════════════════════════ 拖拽组句 ═════════════════════════ */

export function startSentence(count) {
  const n = Math.min(30, Math.max(2, Number(count) || Number(L.size) || 6))
  L.size = n
  const cands = []
  pool(true).forEach((w) => {
    (w.payload.collocations || []).forEach((c) => {
      const ex = (c.examples || [])[0]
      if (!ex || !ex.en) return
      const n = ex.en.split(/\s+/).filter(Boolean).length
      if (n < 5 || n > 14) return
      cands.push({ w, c, ex })
    })
  })
  const picked = shuffle(cands).slice(0, n)
  if (picked.length < 2) { fail('可用来组句的例句太少，先在词库生成搭配'); return false }
  L.sentence = {
    qs: picked.map((x) => ({
      ...x,
      tokens: shuffle(x.ex.en.replace(/\s+/g, ' ').trim().split(' ').map((t, i) => ({ t, i }))),
    })),
    i: 0, placed: [], ok: 0, answered: null, done: false, results: [], credited: false,
  }
  return true
}

function renderSentence() {
  const s = L.sentence
  if (s.done) {
    const pct = Math.round((s.ok / s.qs.length) * 100)
    return '<h1 class="page">组句练习<span class="sub">完成</span></h1>' +
      '<div class="empty"><div class="big">' + s.ok + ' / ' + s.qs.length + '</div>' +
      '<div class="progress" style="margin:12px 0;"><i style="width:' + pct + '%"></i></div>' +
      '<p class="tiny">' + (pct >= 80 ? '语序很稳。' : pct >= 50 ? '大致对了，注意冠词和介词的位置。' : '再来一轮会好很多。') + '</p>' +
      '<div class="btn-group" style="justify-content:center;margin-top:16px;">' +
      (s.credited || !s.results.length
        ? ''
        : '<button class="btn primary" id="lab-sent-credit">把这次表现记进复习计划</button>') +
      '<button class="btn primary" id="lab-sent-again">再来一轮</button>' +
      '<button class="btn ghost" id="lab-sent-back">返回</button></div></div>'
  }
  const q = s.qs[s.i]
  const used = new Set(s.placed)
  const a = s.answered
  return '<h1 class="page">组句练习<span class="sub">' + (s.i + 1) + ' / ' + s.qs.length +
    '　｜　对 ' + s.ok + '</span></h1>' +
    '<div class="card">' +
    '<div class="ask">把词块排成正确的句子</div>' +
    (q.ex.zh ? '<div class="ipa" style="margin-top:6px;">' + esc(q.ex.zh) + '</div>' : '') +
    '<div class="built' + (a ? (a.ok ? ' good' : ' bad') : '') + '">' +
    (s.placed.length
      ? s.placed.map((i, k) => '<button class="tk" data-rm="' + k + '"' + (a ? ' disabled' : '') + '>' +
          esc(q.tokens[i].t) + '</button>').join('')
      : '<span class="tiny">点下面的词块，按顺序排进来</span>') +
    '</div>' +
    '<div class="tokens">' + q.tokens.map((tk, i) =>
      '<button class="tk' + (used.has(i) ? ' off' : '') + '" data-add="' + i + '"' +
      (used.has(i) || a ? ' disabled' : '') + '>' + esc(tk.t) + '</button>').join('') + '</div>' +
    (a ? '<div class="verdict ' + (a.ok ? 'good' : 'bad') + '">' +
      (a.ok ? '排对了' : '不太对。正确句子：<b>' + esc(q.ex.en) + '</b>') + '</div>' : '') +
    '<div class="row" style="justify-content:center;gap:8px;margin-top:12px;">' +
    (a ? '' : '<button class="btn primary" id="lab-sent-check">提交</button>' +
      '<button class="btn sm ghost" id="lab-sent-undo">撤销</button>' +
      '<button class="btn sm ghost" id="lab-sent-back">退出</button>') +
    (a ? '<button class="btn primary" id="lab-sent-next">' +
      (s.i + 1 >= s.qs.length ? '看结果' : '下一句') + '</button>' +
      '<button class="btn sm ghost" id="lab-sent-back">退出</button>' : '') +
    '</div></div>'
}

function bindSentence(cb) {
  const s = L.sentence
  const q = s.qs[s.i]
  $$('[data-add]').forEach((b) => {
    b.onclick = () => {
      if (s.answered) return
      s.placed.push(Number(b.dataset.add))
      cb()
    }
  })
  $$('[data-rm]').forEach((b) => {
    b.onclick = () => {
      if (s.answered) return
      s.placed.splice(Number(b.dataset.rm), 1)
      cb()
    }
  })
  const undo = $('#lab-sent-undo')
  if (undo) undo.onclick = () => { s.placed.pop(); cb() }
  const check = $('#lab-sent-check')
  if (check) check.onclick = () => {
    const built = s.placed.map((i) => q.tokens[i].t).join(' ')
    const r = judgeTyped(built, q.ex.en)
    s.answered = { ok: r.ok, built }
    if (r.ok) s.ok++
    s.results.push({ id: q.w.id, ok: !!r.ok })
    cb()
  }
  const next = $('#lab-sent-next')
  if (next) next.onclick = () => {
    s.i++
    s.placed = []
    s.answered = null
    if (s.i >= s.qs.length) s.done = true
    cb()
  }
  const again = $('#lab-sent-again')
  if (again) again.onclick = () => { startSentence(L.size); cb() }
  const credit = $('#lab-sent-credit')
  if (credit) credit.onclick = async () => {
    credit.disabled = true
    credit.textContent = '写入中…'
    const n = await S.creditGrades(s.results)
    s.credited = true
    ok('已写入 ' + n + ' 个词（对→记得，错→忘了）')
    cb()
  }
  const back = $('#lab-sent-back')
  if (back) back.onclick = () => { L.sentence = null; cb(true) }
}

/* ═════════════════════════ 语音跟读 ═════════════════════════ */

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null

/** 跟读目标：词条本身，或它的第一条搭配 */
function speechTarget(w, mode) {
  if (!w) return ''
  if (mode && mode !== 'term') {
    const c = ((w.payload || {}).collocations || [])[0]
    if (c && c.pattern) return String(c.pattern)
  }
  return w.term || ''
}

export function startSpeech(count) {
  const n = Math.min(30, Math.max(3, Number(count) || Number(L.size) || 8))
  L.size = n
  const words = shuffle(pool(false)).slice(0, n)
  if (!words.length) { fail('词库是空的'); return false }
  L.speech = { words, i: 0, results: [], listening: false, error: '', done: false, targetMode: 'term', last: null, best: 0, credited: false }
  return true
}

function renderSpeech() {
  const s = L.speech
  if (!SR) {
    return '<h1 class="page">语音跟读<span class="sub">不可用</span></h1>' +
      '<div class="card"><p class="muted" style="margin:0;">当前浏览器不支持语音识别。' +
      '请用 <b>Edge 或 Chrome</b> 打开本应用（需联网）。</p>' +
      '<div class="row" style="justify-content:center;margin-top:14px;">' +
      '<button class="btn ghost" id="lab-speech-back">返回</button></div></div>'
  }
  if (s.done) {
    const avg = s.results.length
      ? Math.round(s.results.reduce((a, r) => a + r.score, 0) / s.results.length) : 0
    return '<h1 class="page">语音跟读<span class="sub">完成</span></h1>' +
      '<div class="empty"><div class="big">' + avg + '%</div>' +
      '<p class="tiny">平均得分（按识别出的文本与目标表达比对）</p>' +
      '<div style="text-align:left;">' + s.results.map((r) =>
        '<div class="tiny" style="margin:5px 0;">' + (r.score >= 80 ? '✓' : '·') + '　<b>' + esc(r.term) +
        '</b>　<span style="color:var(--ink-3);">' + r.score + '%　听到：' + esc(r.heard || '（没听清）') + '</span></div>'
      ).join('') + '</div>' +
      '<div class="btn-group" style="justify-content:center;margin-top:16px;">' +
      (s.credited || !s.results.length
        ? ''
        : '<button class="btn primary" id="lab-speech-credit">把这次表现记进复习计划</button>') +
      '<button class="btn primary" id="lab-speech-again">再来一轮</button>' +
      '<button class="btn ghost" id="lab-speech-back">返回</button></div></div>'
  }
  const w = s.words[s.i]
  const target = speechTarget(w, s.targetMode)
  const a = s.last
  const lastOne = s.i + 1 >= s.words.length
  const hasColl = !!(((w.payload || {}).collocations || []).length)
  return '<h1 class="page">语音跟读<span class="sub">' + (s.i + 1) + ' / ' + s.words.length + '</span></h1>' +
    '<div class="card">' +
    '<div class="ask">读出下面这句话</div>' +
    // 跟读对象切换：单词 / 搭配（当前词有搭配时才出现）
    (hasColl
      ? '<div class="seg" style="width:100%;display:flex;margin-bottom:10px;">' +
        '<button type="button" id="sp-mode-term" class="' + (s.targetMode === 'term' ? 'on' : '') + '" style="flex:1;">读单词</button>' +
        '<button type="button" id="sp-mode-coll" class="' + (s.targetMode !== 'term' ? 'on' : '') + '" style="flex:1;">读搭配</button>' +
        '</div>'
      : '') +
    '<div class="term small" style="margin:10px 0;">' + esc(target) + '</div>' +
    '<div class="tiny" style="color:var(--ink-3);">' + esc(w.zh) + '</div>' +
    // 单题反馈：读完立刻看到得分与识别到的内容，可以当场重读
    (a
      ? '<div class="verdict ' + (a.err ? 'bad' : a.score >= 80 ? 'good' : 'bad') + '" style="margin-top:12px;">' +
        (a.err
          ? '没听清（' + esc(a.err) + '）—— 再读一次，或跳过这个词'
          : '得分 <b>' + a.score + '%</b>　听到：' + esc(a.heard || '（没听清）') +
            (a.score < 100 ? '<br>目标：<b>' + esc(target) + '</b>' : '')) +
        '</div>'
      : '') +
    '<div class="row" style="justify-content:center;gap:8px;margin-top:14px;">' +
    '<button class="btn sm ghost" id="lab-speech-play">' + icon('sound', 16) + ' 听示范</button>' +
    '<button class="btn primary" id="lab-speech-rec">' +
    (s.listening ? '聆听中…' : a ? '再读一次' : '开始朗读') + '</button>' +
    (a
      ? '<button class="btn" id="lab-speech-next">' + (lastOne ? '看结果' : '下一个') + '</button>'
      : '<button class="btn sm ghost" id="lab-speech-skip">跳过</button>') +
    '<button class="btn sm ghost" id="lab-speech-back">退出</button>' +
    '</div>' +
    (s.error ? '<p class="tiny" style="color:var(--bad);margin-top:10px;">' + esc(s.error) + '</p>' : '') +
    '</div>'
}

/** 用识别文本与目标比对，返回 0-100 */
function scoreSpeech(heard, target) {
  const h = normalizeAns(heard)
  const t = normalizeAns(target)
  if (!h) return 0
  if (h === t) return 100
  if (h.indexOf(t) >= 0 || t.indexOf(h) >= 0) return 85
  const tw = t.split(' ').filter((x) => x.length >= 3)
  if (!tw.length) return h.length ? 50 : 0
  const hit = tw.filter((x) => h.indexOf(x) >= 0).length
  return Math.round((hit / tw.length) * 80)
}

function bindSpeech(cb) {
  const s = L.speech
  const w = s.words[s.i]
  const target = speechTarget(w, s.targetMode)

  const play = $('#lab-speech-play')
  // 修：原来三目两侧都读 w.term，选搭配模式时示范读的是单词而不是搭配
  if (play) play.onclick = () => { if (!speak(target)) fail('当前环境不支持朗读') }

  // 跟读对象切换：重置当前题的尝试记录（成绩按切换后的目标重新计）
  const modeTerm = $('#sp-mode-term')
  if (modeTerm) modeTerm.onclick = () => {
    if (s.targetMode === 'term') return
    s.targetMode = 'term'; s.last = null; s.best = 0; cb()
  }
  const modeColl = $('#sp-mode-coll')
  if (modeColl) modeColl.onclick = () => {
    if (s.targetMode !== 'term') return
    s.targetMode = 'coll'; s.last = null; s.best = 0; cb()
  }

  const start = () => {
    if (s.listening) return
    s.error = ''
    s.listening = true
    cb()
    let r
    try { r = new SR() } catch (e) {
      s.listening = false; s.error = '语音识别初始化失败'; cb(); return
    }
    r.lang = 'en-US'
    r.interimResults = false
    r.maxAlternatives = 3   // 多取几个候选，边缘发音不至于一次判 0
    // 识别结束只"出结果"，不推进 —— 由用户看完反馈后自己点下一个
    const done = (heard, err, forced) => {
      s.listening = false
      const score = err ? 0 : (typeof forced === 'number' ? forced : scoreSpeech(heard, target))
      s.last = { score, heard: heard || '', err: err || '' }
      s.best = Math.max(Number(s.best) || 0, err ? 0 : score)
      cb()
    }
    r.onresult = (e) => {
      // 在多个候选里挑得分最高的那个作为本次成绩
      const res = e.results && e.results[0]
      let best = { heard: '', score: -1 }
      if (res) {
        for (let i = 0; i < res.length; i++) {
          const h = (res[i] && res[i].transcript) || ''
          const sc = scoreSpeech(h, target)
          if (sc > best.score) best = { heard: h, score: sc }
        }
      }
      if (best.score < 0) best = { heard: '', score: 0 }
      done(best.heard, null, best.score)
    }
    r.onerror = (e) => done('', (e && e.error) || 'error')
    r.onend = () => { if (s.listening) done('', 'no-speech') }
    try { r.start() } catch (e) { done('', 'start-failed') }
  }

  const rec = $('#lab-speech-rec')
  if (rec) rec.onclick = start

  // 推进：record=true 记入本轮成绩（取多次尝试的最好一次），false 为跳过不记
  const advance = (record) => {
    if (record) {
      s.results.push({ id: w.id, term: target, heard: (s.last && s.last.heard) || '', score: Number(s.best) || 0 })
    }
    s.i++
    s.last = null
    s.best = 0
    if (s.i >= s.words.length) s.done = true
    cb()
  }

  const next = $('#lab-speech-next')
  if (next) next.onclick = () => advance(true)
  const skip = $('#lab-speech-skip')
  if (skip) skip.onclick = () => advance(false)
  const again = $('#lab-speech-again')
  if (again) again.onclick = () => { startSpeech(L.size); cb() }
  const credit = $('#lab-speech-credit')
  if (credit) credit.onclick = async () => {
    credit.disabled = true
    credit.textContent = '写入中…'
    // 跟读按得分判定：80 分以上算记得，以下算吃力偏下（记"忘了"太狠，取中间偏保守）
    const list = s.results.map((r) => ({ id: r.id, ok: Number(r.score) >= 80 }))
    const n = await S.creditGrades(list)
    s.credited = true
    ok('已写入 ' + n + ' 个词（≥80 分→记得，其余→忘了）')
    cb()
  }
  const back = $('#lab-speech-back')
  if (back) back.onclick = () => { L.speech = null; cb(true) }
}

/* ═════════════════════════ 对外入口 ═════════════════════════ */

export function hasLab(mode) { return LAB_MODES.indexOf(mode) >= 0 }

export function renderLab(mode) {
  if (mode === 'battle') return renderBattle()
  if (mode === 'sentence') return renderSentence()
  if (mode === 'speech') return renderSpeech()
  return ''
}

export function bindLab(mode, cb) {
  // labs 内部把"返回"实现为 cb(true)（整页重绘回练习场首页）
  if (mode === 'battle') return bindBattle(cb)
  if (mode === 'sentence') return bindSentence(cb)
  if (mode === 'speech') return bindSpeech(cb)
}
