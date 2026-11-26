/** game.js — 趣味玩法：限时配对 / 打字听写 / 情景闯关 / AI 情景对话 / 连胜
 *
 * 设计约束：游戏是"主动回忆的另一张皮"，不是替代 FSRS。
 * 因此游戏本身不计分；结束时给一个**可选**的"把这次表现记进复习计划"，
 * 由用户自己决定是否写入调度（避免游戏手感污染记忆曲线）。
 */
import * as S from './store.js?v=134'
import * as CLOUD from './cloud.js?v=134'
import { $, $$, esc, icon, toast, fail, ok, speak, openModal, closeModal, confirmDialog } from './ui.js?v=134'
import {
  normalizeAns, judgeTyped, buildChoices, whyNote, whyBlockHTML, verdictHTML,
  reviewSemantics, looksLikeEnglishPhrase, cachedVerdict, cachedReview,
  dataStateCard,
  HIT, ALT, WRONG, UNSURE,
} from './views.js?v=134'
import * as LABS from './labs.js?v=134'
import * as FOCUS from './focus.js?v=134'
import * as TRANSFER from './transfer.js?v=134'

const G = { mode: null, match: null, dict: null, quiz: null, chat: null, timer: null, story: null, size: 0 }

/** 退出当前子模式，回到练习场首页（模式选择）。
 *  给了外部一个明确的"我不要再待在这个子页面里"的出口 ——
 *  否则用户进了某个模式后想回首页，只能靠页面里碰巧存在的返回按钮。 */
export function exitMode() {
  FOCUS.resetFocus()
  TRANSFER.resetTransfer()
  if (G.timer) { clearInterval(G.timer); G.timer = null }
  G.mode = null
  G.match = null
  G.dict = null
  G.quiz = null
  G.chat = null
  G.story = null
}

/** 当前子模式是不是"空的"（没数据可玩） */
export function modeIsEmpty() {
  if (G.mode === 'quiz-select') return topicsList().length === 0
  if (G.mode === 'dict') return !(G.dict && Array.isArray(G.dict.qs) && G.dict.qs.length)
  if (G.mode === 'match') return !(G.match && Array.isArray(G.match.pairs) && G.match.pairs.length)
  if (G.mode === 'quiz') return !(G.quiz && Array.isArray(G.quiz.qs) && G.quiz.qs.length)
  return false
}

/** 测试钩子：把内部状态暴露给自动化验证（目标去重、匹配跨度这类逻辑
 *  只有在真实 G 状态上验证过才算数，光读源码证明不了）。
 *  **产品代码不得调用** —— 它返回的是可变引用。 */
export function __testState() {
  return { mode: G.mode, chat: G.chat, dict: G.dict }
}

/** 测试钩子：直接调用目标匹配，用于逐条核对跨度判定 */
export function __matchTarget(text, term) {
  return __usesTerm(text, term)
}

/** 测试钩子：目标表达归一化 */
export function __normTarget(t) {
  return normTarget(t)
}

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

const dayKey = (d) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

/** 连胜：从今天（或昨天）往回数连续有学习的天数 */
export function streakStats() {
  const set = new Set((S.state.daily || [])
    .filter((d) => Number(d.total) > 0)
    .map((d) => String(d.reviewed_on).slice(0, 10)))
  let cur = 0
  const d = new Date()
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1)   // 今天还没学不算断
  while (set.has(dayKey(d))) { cur++; d.setDate(d.getDate() - 1) }
  let best = 0, run = 0, prev = null
  const days = Array.from(set).sort()
  for (const s of days) {
    if (prev && new Date(s).getTime() - new Date(prev).getTime() === 86400000) run++
    else run = 1
    if (run > best) best = run
    prev = s
  }
  return { cur, best: Math.max(best, cur), total: days.length }
}

/**
 * 难度自适应：按最近 7 天的正确率调整题量。
 * 老是全错还硬出 10 题，只会把人赶走；一直全对还出 8 题，又嫌不够过瘾。
 */
function recentAccuracy() {
  const days = (S.state.daily || []).slice(-7)
  const total = days.reduce((a, d) => a + (Number(d.total) || 0), 0)
  if (total < 10) return null      // 样本太少，不调
  const correct = days.reduce((a, d) => a + (Number(d.correct) || 0), 0)
  return correct / total
}

function adaptiveCount(base) {
  const a = recentAccuracy()
  if (a == null) return base
  if (a < 0.6) return Math.max(4, Math.round(base * 0.6))
  if (a > 0.92) return Math.min(14, Math.round(base * 1.3))
  return base
}

/** 场景既用内置的，也按你语料库的章节动态生成 —— 章节多了场景自动变多 */
function allScenarios() {
  const builtIn = SCENARIOS.slice()
  const dynamic = topicsList()
    .filter((t) => !builtIn.some((s) => s.topic === t.topic))
    .slice(0, 10)
    .map((t) => {
      const short = String(t.topic).replace(/[:：].*$/, '').trim() || t.topic
      return {
        id: 'tp:' + t.topic,
        title: short,
        topic: t.topic,
        opening: 'Hi, I need your help with something about ' + short + '. Could you walk me through it?',
      }
    })
  return builtIn.concat(dynamic)
}

function scenarioById(id) {
  return allScenarios().find((x) => x.id === id) || null
}

/* ── 练习模式与题量 ── */

const PRACTICE_MODES = [
  { key: 'match', label: '限时配对', hint: '英 ↔ 中，计时挑战' },
  { key: 'dict-listen', label: '听音拼写', hint: '听发音写单词' },
  { key: 'dict-zh', label: '中文→英文', hint: '看中文拼英文' },
  { key: 'quiz', label: '情景闯关', hint: '按语料章节三种题型' },
  { key: 'chat', label: 'AI 情景对话', hint: '最接近真实使用' },
  { key: 'battle', label: '搭配对战', hint: '回合制选搭配' },
  { key: 'sentence', label: '组句练习', hint: '练语序、冠词、介词' },
  { key: 'speech', label: '语音跟读', hint: '开口读，自动打分' },
]

const SIZE_OPTIONS = [0, 10, 20, 30]

/** 题量：手动指定优先，否则按近 7 天正确率自适应 */
function quizSize(base) {
  const n = Number(G.size) || 0
  return n > 0 ? n : adaptiveCount(base)
}

function sizeChips() {
  return '<div class="size-chips">' + SIZE_OPTIONS.map((n) =>
    '<button class="btn sm ' + ((Number(G.size) || 0) === n ? 'soft' : 'ghost') + '" data-size="' + n + '">' +
    (n ? n + ' 词' : '自动') + '</button>').join('') + '</div>'
}

function launchMode(k, cb) {
  if (k === 'match') { startMatch(); cb() }
  else if (k === 'dict-listen') { if (startDict('listen')) cb() }
  else if (k === 'dict-zh') { if (startDict('zh')) cb() }
  else if (k === 'quiz') { G.mode = 'quiz-select'; G.quiz = null; cb() }
  else if (k === 'chat') { G.mode = 'chat-select'; G.chat = null; cb() }
  else if (k === 'battle') { if (LABS.startBattle(quizSize(6))) { G.mode = 'battle'; cb() } }
  else if (k === 'sentence') { if (LABS.startSentence(quizSize(6))) { G.mode = 'sentence'; cb() } }
  else if (k === 'speech') { if (LABS.startSpeech(quizSize(8))) { G.mode = 'speech'; cb() } }
}

function openModePicker(cb) {
  openModal(
    '<h3>请选择练习模式</h3>' +
    '<p class="sub">巩固学过的词　｜　「练习模式」不影响学习进度</p>' +
    '<div class="grid2">' + PRACTICE_MODES.map((x) =>
      '<button class="mode-tile" data-mode="' + x.key + '">' +
      '<span class="t">' + esc(x.label) + '</span><span class="d">' + esc(x.hint) + '</span></button>').join('') +
    '</div>' +
    '<div class="modal-actions"><button class="btn" id="mode-cancel">取消</button></div>'
  )
  const cancel = $('#mode-cancel')
  if (cancel) cancel.onclick = closeModal
  $$('.mode-tile').forEach((b) => {
    b.onclick = () => { const k = b.dataset.mode; closeModal(); launchMode(k, cb) }
  })
}

/* ── AI 短文助记：选词 → 生成校园安全场景短文，把词全部用进去 ── */

const STORY_MAX = 10

const STORY_SYSTEM = 'You are an English writing coach for a university campus-safety officer in Shanghai. ' +
  'Write short, natural, professional work-scene English for campus security situations ' +
  '(lost and found, access control, complaints, work orders, patrol). Use clear and simple sentences, ' +
  'avoid rare words, and make every required expression sound natural rather than forced.'

function storyCandidates() {
  const seen = new Set()
  const out = []
  S.state.cards.forEach((c) => {
    const w = S.learningWordOf(c)
    if (!w || seen.has(w.id) || S.isBlockedWord(w)) return
    const p = w.payload || {}
    const zh = ((p.senses || [])[0] || {}).def_zh
    if (!zh) return
    seen.add(w.id)
    out.push({ id: w.id, term: w.lemma || w.normalized, zh, fresh: c.status === 'new' })
  })
  out.sort((a, b) => (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0))   // 新学的词优先
  return out.slice(0, 60)
}

export function startStory() {
  const cands = storyCandidates()
  if (cands.length < 3) { fail('带释义的词太少，先去词库导入或生成几个'); return false }
  G.story = {
    cands,
    sel: new Set(cands.slice(0, Math.min(STORY_MAX, cands.length)).map((x) => x.id)),
    title: '', body: '', used: [], missing: [], busy: false, error: '', credited: false,
    canReplace: false,   // 同一轮里「换一篇」替换；重新选词则是新的一篇
  }
  return true
}

/** 让目标词在正文里高亮（大小写不敏感，词组允许空白差异） */
function highlightTerms(text, picked) {
  let html = esc(text)
  picked.forEach((x) => {
    const t = String(x.term || '').trim()
    if (!t) return
    const core = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    try {
      html = html.replace(new RegExp('\\b' + core + '\\b', 'gi'), (m) => '<b class="hl">' + m + '</b>')
    } catch (e) { /* 正则异常就跳过这个词的高亮 */ }
  })
  return html
}

function renderStoryPick() {
  const s = G.story
  const picked = s.cands.filter((x) => s.sel.has(x.id))
  const over = picked.length > STORY_MAX
  return '<h1 class="page">AI 短文助记<span class="sub">选词 → 生成短文</span></h1>' +
    '<div class="card">' +
    '<p class="muted" style="margin:0 0 10px;">勾选想用的词（建议不超过 ' + STORY_MAX + ' 个），' +
    'AI 会写一篇校园安全场景的英文短文，把它们全部用进去。</p>' +
    '<div class="row between" style="margin-bottom:8px;">' +
    '<span class="tiny">已选 ' + picked.length + ' 个' +
    (over ? '　超过 ' + STORY_MAX + ' 个容易生硬' : '') + '</span>' +
    '<span><button class="btn sm ghost" id="story-all">全选前 ' + STORY_MAX + '</button>' +
    '<button class="btn sm ghost" id="story-none">清空</button></span>' +
    '</div>' +
    '<div class="pick-list">' + s.cands.slice(0, 40).map((x) =>
      '<label class="pick' + (s.sel.has(x.id) ? ' on' : '') + '">' +
      '<input type="checkbox" data-pick="' + x.id + '"' + (s.sel.has(x.id) ? ' checked' : '') + '>' +
      '<span><span class="t">' + esc(x.term) + '</span><span class="d">' + esc(x.zh) + '</span></span>' +
      '</label>').join('') + '</div>' +
    '<button class="btn primary block lg" id="story-gen" style="margin-top:12px;"' +
    (picked.length ? '' : ' disabled') + '>根据选中的 ' + picked.length + ' 个单词生成文章</button>' +
    '<div class="row" style="justify-content:center;margin-top:8px;">' +
    '<button class="btn sm ghost" id="story-back">返回练习场</button></div>' +
    '</div>'
}

export function renderStory() {
  const s = G.story
  const picked = s.cands.filter((x) => s.sel.has(x.id))
  if (s.busy) {
    return '<h1 class="page">AI 短文助记<span class="sub">生成中</span></h1>' +
      '<div class="card">' +
      '<p class="muted" style="margin:0 0 10px;">正在用 ' + picked.length + ' 个词写短文…（正文会边写边出现）</p>' +
      '<div class="progress"><i style="width:100%;animation:pulse 1.2s ease-in-out infinite;"></i></div>' +
      '<div id="story-live" class="story" style="margin-top:12px;color:var(--ink-2);"></div>' +
      '</div>'
  }
  if (s.error) {
    return '<h1 class="page">AI 短文助记<span class="sub">生成失败</span></h1>' +
      '<div class="card"><p class="muted" style="margin:0 0 12px;">' + esc(s.error) + '</p>' +
      '<div class="btn-group" style="justify-content:center;">' +
      '<button class="btn primary" id="story-again">重试</button>' +
      '<button class="btn ghost" id="story-back">返回</button></div></div>'
  }
  const paras = String(s.body || '').split(/\n{2,}/).filter((x) => x.trim())
  return '<h1 class="page">' + esc(s.title || '短文') +
    '<span class="sub">' + picked.length + ' 个目标词</span></h1>' +
    '<div class="card"><div class="story">' +
    paras.map((p) => '<p>' + highlightTerms(p, picked) + '</p>').join('') +
    '</div></div>' +
    (s.missing.length
      ? '<div class="card tight" style="background:var(--warn-soft);border-color:transparent;">' +
        '<div class="tiny">没用上的词：' + s.missing.map(esc).join('、') + '　可以「换一篇」再试。</div></div>'
      : '') +
    '<p class="tiny center" style="margin:12px 0 0;">✓ 已存进「我的短文」，练习场首页可回看</p>' +
    '<div class="btn-group" style="justify-content:center;margin-top:8px;">' +
    (s.credited
      ? ''
      : '<button class="btn primary" id="story-credit">把用上的词记进复习计划</button>') +
    '<button class="btn" id="story-again">换一篇</button>' +
    '<button class="btn ghost" id="story-del">删除这篇</button>' +
    '<button class="btn ghost" id="story-back">返回练习场</button></div>'
}

async function genStory(cb) {
  const s = G.story
  const picked = s.cands.filter((x) => s.sel.has(x.id))
  if (!picked.length) return fail('先选几个词')
  s.busy = true
  s.error = ''
  cb()
  try {
    let acc = ''
    const raw = await CLOUD.chatText({
      system: STORY_SYSTEM,
      user: 'Write one short scene (140-200 words). Use ALL of these expressions naturally:\n' +
        picked.map((x) => '- ' + x.term + (x.zh ? '（' + x.zh + '）' : '')).join('\n') +
        '\n\nReturn strict JSON only: {"title": "...", "body": "..."} — body is 2-3 paragraphs separated by \\n\\n.',
      json: true,
      temperature: 0.7,
      maxTokens: 900,
      // 流式：边生成边把 body 正文喂到页面上，避免十几秒只有一条不动的进度条
      onDelta: (d) => {
        acc += d
        const live = document.getElementById('story-live')
        if (!live) return
        const partial = partialStory(acc)
        if (!partial) return
        live.innerHTML = partial.split(/\n{2,}/).map((p) => '<p>' + esc(p) + '</p>').join('')
      },
    })
    let data = null
    try {
      data = JSON.parse(raw)
    } catch (e) {
      const m = String(raw || '').match(/\{[\s\S]*\}/)
      if (m) data = JSON.parse(m[0])
    }
    if (!data || !data.body) throw new Error('模型没有返回可用的短文，请重试')
    s.title = String(data.title || '短文')
    s.body = String(data.body)
    s.used = picked.filter((x) => __usesTerm(s.body, x.term))
    s.missing = picked.filter((x) => !__usesTerm(s.body, x.term)).map((x) => x.term)
    saveStory({ title: s.title, body: s.body, terms: picked.map((x) => x.term) }, !!s.canReplace)
    s.canReplace = true      // 之后按「换一篇」= 替换这一轮的那篇，不再往列表里堆重复
    s.savedIdx = 0
    ok('短文已生成，存进「我的短文」了')
  } catch (e) {
    s.error = (CLOUD.llmErrorMessage && CLOUD.llmErrorMessage(e)) || String((e && e.message) || e)
  }
  s.busy = false
  cb()
}

/** 流式期间从半截 JSON 里尽量抠出 body 正文（拿不到就返回空串） */
function partialStory(raw) {
  const m = String(raw || '').match(/"body"\s*:\s*"([\s\S]*)$/)
  if (!m) return ''
  return m[1]
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\ntitle[\s\S]*$/, '')
}

/** 短文收藏：存进 settings.extra.stories（最多 20 篇），随账号同步。
 *  replace=true 时替换列表第一篇（「换一篇」不该往列表里堆重复稿）。 */
function saveStory(item, replace) {
  try {
    const list = Array.isArray(S.state.settings.stories) ? S.state.settings.stories.slice() : []
    if (replace && list.length) list.shift()
    list.unshift(Object.assign({ at: Date.now() }, item))
    S.state.settings.stories = list.slice(0, 20)
    S.saveLocal()
    S.pushSettings().catch(() => {})
  } catch (e) { /* 收藏失败不影响阅读 */ }
}

/** 删除一篇短文（下标基于 stories 列表），本地 + 云端一起删 */
function deleteStory(idx) {
  const list = Array.isArray(S.state.settings.stories) ? S.state.settings.stories.slice() : []
  if (!(idx >= 0 && idx < list.length)) return false
  list.splice(idx, 1)
  S.state.settings.stories = list
  S.saveLocal()
  S.pushSettings().catch(() => {})
  return true
}

/** 我的短文：回看最近生成的短文 */
export function openStoryArchive() {
  const list = Array.isArray(S.state.settings.stories) ? S.state.settings.stories : []
  if (!list.length) return ok('还没有收藏的短文')
  openModal(
    '<h3>我的短文<span class="tiny">（' + list.length + ' 篇）</span></h3>' +
    '<p class="sub">点一篇展开阅读，目标词会高亮</p>' +
    '<div class="story-arch">' + list.map((x, i) =>
      '<div class="arch-row">' +
      '<button class="arch-item" data-arch="' + i + '">' +
      '<span class="t">' + esc(x.title || '短文') + '</span>' +
      '<span class="d">' + new Date(Number(x.at) || Date.now()).toLocaleDateString('zh-CN') +
      '　' + (x.terms || []).length + ' 词</span></button>' +
      '<button class="arch-del" data-del="' + i + '" title="删除这篇" aria-label="删除《' +
      esc(x.title || '短文') + '》"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/>' +
      '<path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/><path d="M10 11v6M14 11v6"/></svg>' +
      '</button></div>').join('') + '</div>' +
    '<div id="arch-body" class="story" style="margin-top:12px;"></div>' +
    '<div class="modal-actions"><button class="btn" id="arch-close">关闭</button></div>'
  )
  const close = $('#arch-close')
  if (close) close.onclick = closeModal
  $$('[data-del]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation()
      const i = Number(b.dataset.del)
      const it = list[i] || {}
      const yes = await confirmDialog({
        title: '删除这篇短文？',
        sub: String(it.title || '短文'),
        okText: '删除', danger: true,
      })
      if (yes) {
        deleteStory(i)
        ok('已删除')
      }
      openStoryArchive()      // 无论确认还是取消，都把列表重新打开（confirmDialog 会占掉弹层）
    }
  })
  $$('[data-arch]').forEach((b) => {
    b.onclick = () => {
      const it = list[Number(b.dataset.arch)] || {}
      const terms = (it.terms || []).map((t) => ({ term: t }))
      const body = document.getElementById('arch-body')
      if (body) {
        body.innerHTML = String(it.body || '').split(/\n{2,}/)
          .map((p) => '<p>' + highlightTerms(p, terms) + '</p>').join('')
      }
    }
  })
}

function bindStoryPick(cb) {
  $$('[data-pick]').forEach((box) => {
    box.onchange = () => {
      const id = box.getAttribute('data-pick')
      if (box.checked) G.story.sel.add(id)
      else G.story.sel.delete(id)
      cb()
    }
  })
  const all = $('#story-all')
  if (all) all.onclick = () => {
    G.story.sel = new Set(G.story.cands.slice(0, STORY_MAX).map((x) => x.id))
    cb()
  }
  const none = $('#story-none')
  if (none) none.onclick = () => { G.story.sel = new Set(); cb() }
  const gen = $('#story-gen')
  if (gen) gen.onclick = () => { genStory(cb) }
  const back = $('#story-back')
  if (back) back.onclick = () => { G.mode = null; G.story = null; cb() }
}

function bindStory(cb) {
  const again = $('#story-again')
  if (again) again.onclick = () => { genStory(cb) }
  const credit = $('#story-credit')
  if (credit) credit.onclick = async () => {
    credit.disabled = true
    credit.textContent = '写入中…'
    const list = G.story.used.map((x) => ({ id: x.id, ok: true }))
    const n = await S.creditGrades(list)
    G.story.credited = true
    ok('已写入 ' + n + ' 个词（用上了 → 记得）')
    cb()
  }
  const del = $('#story-del')
  if (del) del.onclick = async () => {
    const yes = await confirmDialog({
      title: '删除这篇短文？',
      sub: String((G.story && G.story.title) || '短文'),
      okText: '删除', danger: true,
    })
    if (!yes) { cb(); return }
    deleteStory(0)          // 刚生成的这篇永远在列表首位
    ok('已删除')
    G.mode = null; G.story = null; cb()
  }
  // 返回回到练习场首页：那里能看到「我的短文（N 篇）」，比回选词页更让人确认"已经生成了"
  const back = $('#story-back')
  if (back) back.onclick = () => { G.mode = null; G.story = null; cb() }
}

/** 从词库里挑一批带释义的词（供两个游戏共用） */
function pickPool(max) {
  const seen = new Set()
  const pool = []
  S.state.cards.forEach((c) => {
    const w = S.learningWordOf(c)
    if (!w || seen.has(w.id) || S.isBlockedWord(w)) return
    const p = w.payload || {}
    const zh = ((p.senses || [])[0] || {}).def_zh
    if (!zh) return
    seen.add(w.id)
    pool.push({ id: w.id, term: w.lemma || w.normalized, zh })
  })
  return shuffle(pool).slice(0, max)
}

/* ═════════════════════════ 限时配对 ═════════════════════════ */

export function startMatch() {
  const pairs = pickPool(quizSize(8))
  if (pairs.length < 4) return fail('带释义的词条太少，先去词库导入几个')
  G.mode = 'match'
  G.match = {
    pairs,
    left: shuffle(pairs.slice()),
    right: shuffle(pairs.slice()),
    selL: null, selR: null,
    matched: new Set(),
    misses: 0,
    t0: Date.now(),
    done: false,
    credited: false,
  }
  clearInterval(G.timer)
  G.timer = setInterval(() => {
    const el = $('#match-timer')
    if (el && G.match && !G.match.done) {
      el.textContent = Math.round((Date.now() - G.match.t0) / 1000) + 's'
    }
  }, 500)
}

function renderMatch() {
  const m = G.match
  const elapsed = Math.round((Date.now() - m.t0) / 1000)
  const cell = (item, side) => {
    const done = m.matched.has(item.id)
    const sel = (side === 'L' && m.selL && m.selL.id === item.id) || (side === 'R' && m.selR && m.selR.id === item.id)
    return '<button class="pair-cell' + (done ? ' hit' : '') + (sel ? ' sel' : '') + '" data-side="' + side +
      '" data-id="' + item.id + '"' + (done ? ' disabled' : '') + '>' + esc(side === 'L' ? item.term : item.zh) + '</button>'
  }

  const body = m.done
    ? '<div class="empty"><div class="big">完成！</div>' +
      '<p class="tiny">用时 ' + elapsed + ' 秒　｜　配对 ' + m.pairs.length + ' 组　｜　失误 ' + m.misses + ' 次</p>' +
      '<p class="tiny" style="margin-top:6px;">' +
      (m.misses === 0 ? '一次没错，很扎实。' : '失误的这几对建议在学习里再过一遍。') + '</p>' +
      '<div class="btn-group" style="justify-content:center;margin-top:16px;">' +
      (m.credited ? '' : '<button class="btn primary" id="match-credit">把这次表现记进复习计划</button>') +
      '<button class="btn" id="match-again">再来一局</button>' +
      '<button class="btn ghost" id="match-back">返回</button></div></div>'
    : '<div class="match-grid">' +
      '<div class="col">' + m.left.map((x) => cell(x, 'L')).join('') + '</div>' +
      '<div class="col">' + m.right.map((x) => cell(x, 'R')).join('') + '</div>' +
      '</div>'

  return (
    '<h1 class="page">限时配对<span class="sub">' +
    (m.done ? '已完成' : '配对 ' + m.matched.size + ' / ' + m.pairs.length + '　失误 ' + m.misses) + '</span></h1>' +
    '<div class="card tight"><div class="row between">' +
    '<span class="tiny">点击左边英文，再点右边释义</span>' +
    '<span class="tiny" id="match-timer">' + elapsed + 's</span></div></div>' +
    body
  )
}

function bindMatch(cb) {
  $$('.pair-cell').forEach((b) => {
    b.onclick = () => {
      const m = G.match
      if (m.done) return
      const side = b.dataset.side
      // dataset 里的 id 一定是字符串，pairs 里的 id 是数字 —— 必须统一成字符串再比
      const item = m.pairs.find((x) => String(x.id) === String(b.dataset.id))
      if (!item) return
      if (side === 'L') m.selL = (m.selL && m.selL.id === item.id) ? null : item
      else m.selR = (m.selR && m.selR.id === item.id) ? null : item

      if (m.selL && m.selR) {
        if (m.selL.id === m.selR.id) {
          m.matched.add(item.id)
          m.selL = m.selR = null
          if (m.matched.size === m.pairs.length) {
            m.done = true
            clearInterval(G.timer)
          }
        } else {
          m.misses++
          const l = m.selL, r = m.selR
          m.selL = m.selR = null
          m.wrong = { l: l.id, r: r.id }
          setTimeout(() => { if (G.match) { G.match.wrong = null; cb() } }, 450)
        }
      }
      cb()
    }
  })
  const credit = $('#match-credit')
  if (credit) credit.onclick = async () => {
    credit.disabled = true
    credit.textContent = '写入中…'
    const n = await moduleCredit(G.match.pairs, true)
    G.match.credited = true
    ok('已把 ' + n + ' 个词按「记得」记入复习计划')
    cb()
  }
  const again = $('#match-again')
  if (again) again.onclick = () => { startMatch(); cb() }
  const back = $('#match-back')
  if (back) back.onclick = () => { G.mode = null; G.match = null; clearInterval(G.timer); cb() }
}

/* ═════════════════════════ 打字听写 ═════════════════════════ */

/** 抽测池：优先抽"学过但最久没见到"的词，用于跨日检索检验 */
function weeklyPool(limit) {
  const seen = new Set()
  const out = []
  const add = (c) => {
    const w = S.learningWordOf(c)
    if (!w || seen.has(w.id) || S.isBlockedWord(w)) return
    const zh = (((w.payload || {}).senses || [])[0] || {}).def_zh
    if (!zh) return
    seen.add(w.id)
    out.push({
      id: w.id, term: w.lemma || w.normalized, zh,
      last: c.last_review_at ? new Date(c.last_review_at).getTime() : 0,
    })
  }
  S.state.cards.forEach((c) => { if (!c.suspended && Number(c.reps) >= 1) add(c) })
  out.sort((a, b) => (a.last || 0) - (b.last || 0))
  if (out.length < 10) {    // 学过的词太少，退回全部有释义的词
    S.state.cards.forEach((c) => { if (!c.suspended) add(c) })
  }
  return out.slice(0, limit || 10)
}

/** 抽测题型。混合 = 6 选择 + 4 产出：先选后写，既能入门又保留真正的检索提取。
 *  这是任务书建议的试点配比，不宣称它是最优 —— 用户可随时改。 */
const TEST_MODES = [
  { k: 'mixed', label: '混合', hint: '6 选择 + 4 产出' },
  { k: 'choice', label: '全选择', hint: '10 题选词，快' },
  { k: 'write', label: '全产出', hint: '10 题自己写，最难' },
]

export function testMode() {
  const m = String(S.state.settings.test_mode || 'mixed')
  return TEST_MODES.some((x) => x.k === m) ? m : 'mixed'
}

/** 抽测选择题的干扰项：只从**同一批题**里抽，且意思不能重复。
 *  不能用 buildChoices —— 那个池子抽的是"搭配"，和题目要选的"词"不是一类东西，
 *  一眼就能靠"哪个看起来像搭配"排除，题目就失效了。 */
function termChoices(q, pool) {
  const seen = {}
  seen[String(q.term).toLowerCase()] = 1
  const cands = []
  pool.forEach((x) => {
    if (x.id === q.id) return
    if (String(x.zh) === String(q.zh)) return          // 意思一样 → 会出现两个正确答案
    const k = String(x.term).toLowerCase()
    if (seen[k]) return
    seen[k] = 1
    cands.push(x.term)
  })
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = cands[i]; cands[i] = cands[j]; cands[j] = t }
  const opts = cands.slice(0, 3).map((t) => ({ text: t, ok: false }))
  opts.push({ text: q.term, ok: true })
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = opts[i]; opts[i] = opts[j]; opts[j] = t }
  return opts
}

/** 每周抽测：跨日检索。成绩单独记为 source='test'（这个字段只在数据层用，不展示给用户） */
export function startWeekly() {
  const pool = weeklyPool(10)
  if (pool.length < 5) return fail('词库里有释义的词太少，先去词库导入或生成')
  const mode = testMode()
  // 选项在这里一次性生成并挂到题目上：渲染会跑很多次，
  // 每次重算会打乱选项顺序（用户会看到选项在跳）甚至换掉正确答案。
  const qs = pool.map((q, i) => {
    const pick = mode === 'choice' ? 'choice'
      : mode === 'write' ? 'write'
        : (i < 6 ? 'choice' : 'write')
    const opts = pick === 'choice' ? termChoices(q, pool) : null
    // 干扰项凑不满 3 个时退回打字：只有 2 个选项的选择题等于送分
    const useChoice = !!opts && opts.length >= 3
    return Object.assign({}, q, {
      mode: useChoice ? 'choice' : 'write',
      opts: useChoice ? opts : null,
    })
  })
  G.mode = 'dict'
  G.dict = {
    kind: 'weekly', qs, i: 0, ok: 0, wrong: [],
    answered: null, done: false, credited: false, qStart: Date.now(), results: [],
  }
}

export function startDict(kind) {
  const qs = pickPool(quizSize(10))
  if (qs.length < 4) return fail('带释义的词条太少，先去词库导入几个')
  G.mode = 'dict'
  G.dict = {
    kind: kind || 'listen', qs, i: 0, ok: 0, wrong: [],
    answered: null, done: false, credited: false, qStart: Date.now(), results: [],
  }
}

function dictQuestion(d) {
  const q = d.qs[d.i]
  if (d.kind === 'listen') {
    return {
      prompt: '<div class="ask">听发音，把这个词拼出来</div>' +
        '<div style="text-align:center;margin:14px 0;"><button class="btn soft" id="dict-play">' +
        icon('sound', 18) + ' 再听一遍</button></div>',
      expected: q.term,
      hint: q.zh,
      zh: q.zh,
      // 听写考的是"这个词怎么拼"，没有替换空间 —— 别拿语义复核去松动拼写要求
      spell: true,
    }
  }
  // 抽测的选择题模式：题目问"这个意思对应哪个英语表达"。
  // 选项在 startWeekly 时已经定好并挂在题目上，这里只负责渲染。
  if (q.mode === 'choice' && q.opts && q.opts.length >= 3) {
    return {
      prompt: '<div class="ask">抽测：选出对应的英语表达</div>' +
        '<div class="term small" style="margin:10px 0;">' + esc(q.zh) + '</div>' +
        '<div class="choices">' +
        q.opts.map((o, i) =>
          '<button class="choice' + (d.answered && o.ok ? ' good' : '') + '" data-dc="' + i + '"' +
          (d.answered ? ' disabled' : '') + '>' + esc(o.text) + '</button>').join('') +
        '</div>',
      expected: q.term,
      hint: '',
      zh: q.zh,
      choice: true,
    }
  }
  return {
    prompt: '<div class="ask">' + (d.kind === 'weekly' ? '抽测：用英语说出这个意思' : '用英语说出这个意思') + '</div>' +
      '<div class="term small" style="margin:10px 0;">' + esc(q.zh) + '</div>',
    expected: q.term,
    hint: '',
    // 中文→英文表达题：同一个意思往往有多种地道说法，判分必须留出替代空间
    zh: q.zh,
  }
}

function renderDict() {
  const d = G.dict
  if (d.done) {
    const total = d.qs.length
    const pct = Math.round((d.ok / total) * 100)
    const weekly = d.kind === 'weekly'
    const auto = String(S.state.settings.auto_credit) === 'true'
    const guessed = (d.results || []).filter((r) => r.verdict === 'hit' && r.hinted && !r.choice).length
    const unsure = (d.results || []).filter((r) => r.verdict === 'unsure').length
    const choiceN = (d.results || []).filter((r) => r.choice).length

    /* 写入状态必须显式说出来。
       旧代码只在"没写入"时显示按钮，已经写入就什么都不显示 ——
       用户看不出这次表现到底进没进复习计划，下次复习时间会不会变。 */
    const creditLine = S.isTestSession()
      ? '<p class="tiny" style="margin:0;">测试模式：本次成绩<b>不计入</b>复习计划，下次复习时间不变。</p>'
      : (d.credited
        ? '<p class="tiny" style="margin:0;">✓ 已处理本次成绩：写入 ' + (d.creditedCount || 0) + ' 个词；无法判定的题目不改复习调度。</p>'
        : (auto && d.crediting
          ? '<p class="tiny" style="margin:0;">正在写入复习计划…</p>'
          : '<p class="tiny" style="margin:0;">' +
            (auto ? '这次表现正在写入复习计划。' : '你的设置里<b>没有</b>开启练习自动写入，所以这次'
              + '只记成绩、<b>不影响</b>下次复习时间。想写入就点下面按钮。') + '</p>'))

    return '<h1 class="page">' + (weekly ? '每周抽测' : '打字听写') +
      '<span class="sub">' + (weekly ? '10 题跨日检索' : '完成') + '</span></h1>' +
      '<div class="empty"><div class="big">' + d.ok + ' / ' + total + '</div>' +
      '<div class="progress" style="margin:12px 0;"><i style="width:' + pct + '%"></i></div>' +
      '<p class="tiny">' + (pct >= 80 ? '很扎实。' : pct >= 50 ? '过半了，错的那几个值得单独过一遍。' : '这批还比较生，建议明天再来一次。') + '</p>' +
      // 成绩按维度分开：目标命中 / 别的正确表达 / 判定不了，混成一个百分比看不出问题在哪
      '<p class="tiny" style="text-align:left;">命中目标表达 <b>' + d.ok + '</b> 题' +
      (choiceN ? '（其中选择题 <b>' + choiceN + '</b> 题，算<b>识别</b>成绩）' : '') +
      (d.alts ? '　｜　用了其他正确表达 <b>' + d.alts + '</b> 题（英语没问题，只是不是本题目标）' : '') +
      (guessed ? '　｜　用了提示 <b>' + guessed + '</b> 题（不计入无提示产出）' : '') +
      (unsure ? '　｜　<b>' + unsure + '</b> 题无法自动判定（未计错）' : '') +
      '</p>' +
      // 把"能认"和"能写"分开说：这两件事的差距正是最该被看见的东西，
      // 合并成一个百分比会把它藏起来。
      (choiceN && choiceN < total
        ? '<p class="tiny" style="text-align:left;">产出题 ' + (total - choiceN) + ' 题中对了 ' +
          Math.max(0, d.ok - (d.results || []).filter((r) => r.choice && r.ok).length) +
          ' 题 —— 能认出来不等于能自己想出来，产出题才是真正的检索提取。</p>'
        : '') +
      (d.wrong.length ? '<p class="tiny" style="text-align:left;">答错的：' +
        d.wrong.map((w) => '<b>' + esc(w) + '</b>').join('、') + '</p>' : '') +
      '<div style="text-align:center;margin-top:10px;">' + creditLine + '</div>' +
      '<div class="btn-group" style="justify-content:center;margin-top:14px;">' +
      (d.credited ? '' : '<button class="btn primary" id="dict-credit">' +
        (auto ? '重新写入' : '把这次表现记进复习计划') + '</button>') +
      '<button class="btn" id="dict-again">再来一轮</button>' +
      '<button class="btn ghost" id="dict-back">返回</button></div></div>'
  }

  const q = d.qs[d.i]
  const meta = dictQuestion(d)
  const a = d.answered
  return (
    '<h1 class="page">' + (d.kind === 'weekly' ? '每周抽测' : '打字听写') +
    '<span class="sub">' + (d.i + 1) + ' / ' + d.qs.length +
    '　｜　对 ' + d.ok + (d.alts ? '（另有 ' + d.alts + ' 个对的替代表达）' : '') +
    '</span></h1>' +
    '<div class="card">' +
    meta.prompt +
    (a
      ? verdictHTML(a, { taskLabel: '目标表达' }) +
        // 答错时补一句"为什么"，避免同一个坑反复踩
        (a.verdict === WRONG ? whyBlockHTML(S.learningWordOf({ word_id: q.id })) : '')
      : '') +
    // 选择题模式下不需要输入框和"提交"—— 选项本身就是作答区
    (meta.choice ? '' :
      '<input class="input ans-in" id="dict-in" placeholder="在这里拼写，回车提交" autocomplete="off" ' +
      'autocapitalize="off" spellcheck="false" value="' + esc((a && a.given) || '') + '"' + (a ? ' disabled' : '') + '>' +
      (meta.hint && !a ? '<p class="tiny" style="margin-top:8px;">提示：' + esc(meta.hint) + '</p>' : '')) +
    '<div class="row" style="gap:8px;margin-top:12px;justify-content:center;">' +
    (a
      ? '<button class="btn primary" id="dict-next">' + (d.i + 1 >= d.qs.length ? '看结果' : '下一个') + '</button>'
      : (meta.choice ? '' : '<button class="btn primary" id="dict-go">提交</button>')) +
    '</div>' +
    '</div>'
  )
}

function bindDict(cb) {
  const d = G.dict

  // 完成态必须提前分流：此时 d.i === d.qs.length，q 是 undefined，
  // 原来照常执行 dictQuestion(d) 会同步抛错，把下面所有按钮（返回/再来一轮/写入）的绑定全部中断
  if (!d.done) {
    const q = d.qs[d.i]
    const meta = d.answered ? null : dictQuestion(d)

    const play = $('#dict-play')
    if (play) play.onclick = () => { if (!speak(q.term)) fail('当前环境不支持朗读') }
    if (d.kind === 'listen' && !d.answered) setTimeout(() => { try { speak(q.term) } catch (e) {} }, 300)

    const submit = () => {
      const inp = $('#dict-in')
      if (d.answered) return                    // 双击/回车连发只算一次
      const given = inp ? inp.value : ''
      const r = judgeTyped(given, meta.expected, { spelling: !!meta.spell, sentence:meta.sentence, zh:meta.zh })
      const ms = Math.max(0, Date.now() - (d.qStart || Date.now()))
      d.answered = {
        ok: r.ok, verdict: r.verdict, typo: r.typo, loose: r.loose,
        empty: r.empty, given: given, expected: meta.expected, kind: 'type', sentence:meta.sentence || '', note:r.note || '',
      }
      d.results = (d.results || []).concat([{
        id: q.id, ok: r.ok, verdict: r.verdict, ms: ms,
        // 题目自带提示（如听写给了中文意思）时答对，不能算无提示产出
        hinted: !!meta.hint,
        assisted: false,
      }])
      // 命中目标表达才计入"对"；合理替代表达（alt）单独记，不混进目标命中率
      if (r.verdict === HIT) d.ok++
      else if (r.verdict === ALT) d.alts = (d.alts || 0) + 1
      else if (r.verdict === WRONG && !d.wrong.includes(q.term)) d.wrong.push(q.term)
      cb()
      // 本地只能比字符串：address 是不是 deal with 的合理替代，得问一次语义复核。
      // 复核期间先不判错（详见 views.js 里同样的说明）。
      if ([WRONG, UNSURE].includes(r.verdict) && !meta.spell && looksLikeEnglishPhrase(given)) {
        // 复核有时间上限，用户可能已经点「下一个」走了。用题号认领回自己那一题：
        // 对不上就只当缓存已写（verdict 已经在 judge 层落盘），不动当前界面。
        const qi = d.i
        const owner = d.answered
        const cached = cachedReview(meta.expected, given, { sentence: meta.sentence || '', zh: meta.zh || '', model: S.state.settings.llm_model || undefined })
        if (cached) { owner.feedback = cached.feedback; applyVerbal(cached.verdict, qi, owner, q) }
        else {
          d.answered.reviewing = true
          cb()
          reviewSemantics({
            sentence: meta.sentence || '',
            zh: meta.zh || '',
            expected: meta.expected,
            given: given,
            chat: CLOUD.chatText,
            model: S.state.settings.llm_model || undefined,
          }).then((res) => {
            owner.feedback = res.feedback || null
            owner.reviewReason = res.reason
            owner.referenceInvalid = ['reference_invalid','reference_unknown'].includes(res.reason)
            applyVerbal(res.verdict, qi, owner, q)
            if (d.i === qi) cb()
          })
        }
      }
    }

    /** 复核结论落到本题及答案池上（qi/owner/q 由提交那一刻捕获，防止串题） */
    const applyVerbal = (verdict, qi, owner, qq) => {
      const a = owner
      if (!a) return
      a.reviewing = false
      const before = a.verdict
      if (verdict === 'alt') {
        a.verdict = ALT
        a.ok = true
        if (before !== ALT) {
          // 从"错"扳回来：错词表要撤掉，计数要搬
          d.alts = (d.alts || 0) + 1
          const i = d.wrong.indexOf(qq.term)
          if (i >= 0) d.wrong.splice(i, 1)
          const r0 = (d.results || []).find((x) => x.id === qq.id)
          if (r0) { r0.ok = true; r0.verdict = ALT }
        }
      } else if (verdict === 'wrong') {
        a.verdict = WRONG
        a.ok = false
        if (!d.wrong.includes(qq.term)) d.wrong.push(qq.term)
        const row = (d.results || []).find((x) => x.id === qq.id)
        if (row) { row.verdict = WRONG; row.ok = false }
      } else {
        // 判定不了就不算错：不写错词表、不污染后面的统计
        a.verdict = UNSURE
        a.ok = false
        const i = d.wrong.indexOf(qq.term)
        if (i >= 0) d.wrong.splice(i, 1)
        const r0 = (d.results || []).find((x) => x.id === qq.id)
        if (r0) r0.verdict = UNSURE
      }
    }
    const go = $('#dict-go')
    if (go) go.onclick = submit
    // 选择题模式的选项：点一下就判，记为**识别**成绩（不是无提示产出）
    $$('[data-dc]').forEach((btn) => {
      btn.onclick = () => {
        if (d.answered) return
        const idx = Number(btn.dataset.dc)
        const opt = q.opts && q.opts[idx]
        if (!opt) return
        const ms = Math.max(0, Date.now() - (d.qStart || Date.now()))
        d.answered = {
          ok: !!opt.ok, verdict: opt.ok ? HIT : WRONG, typo: false, loose: false,
          empty: false, choiceMode: true, given: opt.text, expected: q.term, kind: 'type',
        }
        d.results = (d.results || []).concat([{
          id: q.id, ok: !!opt.ok, verdict: d.answered.verdict, ms: ms,
          // 选择题本身就不是无提示产出：记 assisted，不记 hinted ——
          // 用户没有"求助"，是题型决定的；混在一起会让"提示依赖"这个指标失真。
          hinted: false, assisted: true, choice: true,
        }])
        if (opt.ok) d.ok++
        else if (!d.wrong.includes(q.term)) d.wrong.push(q.term)
        cb()
      }
    })
    const inp = $('#dict-in')
    if (inp) {
      inp.onkeydown = (e) => { if (e.key === 'Enter' && !d.answered) submit() }
      if (!d.answered) setTimeout(() => { try { inp.focus() } catch (e) {} }, 80)
    }
    const next = $('#dict-next')
    if (next) next.onclick = () => {
      d.i++
      d.answered = null
      d.qStart = Date.now()
      if (d.i >= d.qs.length) d.done = true
      cb()
    }
  }

  const doCredit = async (btn) => {
    // 自动写入是"渲染时触发"的：写入还没回来只要界面重绘一次，就会再触发一遍，
    // 同一批词被写第二遍（复习次数翻倍、FSRS 间隔被污染）。用 in-flight 标记挡住。
    if (d.crediting || d.credited) return
    d.crediting = true
    if (btn) { btn.disabled = true; btn.textContent = '写入中…' }
    const src = d.kind === 'weekly' ? 'test' : 'game'
    const rs = (d.results && d.results.length)
      ? d.results
      : d.qs.map((x) => ({ id: x.id, ok: !d.wrong.includes(x.term) }))
    let n = 0
    try {
      n = await S.creditGrades(rs, { source: src })
    } catch (e) {
      d.crediting = false
      fail('写入失败，下次进入会自动重试')
      return          // 故意不重绘：失败立刻重绘会变成"失败→重绘→再试"的死循环
    }
    d.credited = true
    d.creditedCount = n
    d.crediting = false
    ok('已写入 ' + n + ' 个词（按用时自动分档：快→轻松，慢/错→需要加强）')
    cb()
  }
  const credit = $('#dict-credit')
  if (credit) credit.onclick = () => doCredit(credit)
  // 开启"自动写入"时，做完即写，不用再点一次
  if (d.done && !d.credited && String(S.state.settings.auto_credit) === 'true') {
    doCredit(null)
  }
  const again = $('#dict-again')
  if (again) again.onclick = () => {
    // 抽测要重抽"最久没见过"的池子，不能退回随机池
    if (d.kind === 'weekly') startWeekly()
    else startDict(d.kind)
    cb()
  }
  const back = $('#dict-back')
  if (back) back.onclick = async () => {
    // 中途退出要说清楚"成绩不会保存"—— 默默丢掉用户刚做的 8 道题是最没道理的失礼
    if (!d.done && d.i > 0) {
      const leave = await confirmDialog({
        title: '退出这次' + (d.kind === 'weekly' ? '抽测' : '听写') + '？',
        sub: '已答 ' + d.i + ' / ' + d.qs.length + ' 题，成绩不会保存',
        body: '<p class="muted">下次进入会重新抽题。已经写进复习计划的记录不受影响。</p>',
        okText: '退出', cancelText: '继续做', danger: true,
      })
      if (!leave) return
    }
    exitMode()
    cb()
  }
}

/* ═════════════════════════ 情景闯关 ═════════════════════════ */
/* 关卡 = 语料库文档的章节（words.payload.topic），题目三种题型混出 */

const QUIZ_KEY = (t) => 'lexiloop.quiz.' + encodeURIComponent(String(t || ''))

/** 星级读本地缓存（启动时会用云端 settings 补齐） */
function getStars(topic) {
  return Number(localStorage.getItem(QUIZ_KEY(topic)) || 0)
}

/** 星级写本地 + 上云（settings.extra.quiz_stars），双向保持一致 */
function setStars(topic, stars) {
  localStorage.setItem(QUIZ_KEY(topic), String(stars))
  const cur = (S.state.settings.quiz_stars || {})
  if (Number(cur[topic]) >= stars) return   // 只升不降
  S.state.settings.quiz_stars = Object.assign({}, cur, { [topic]: stars })
  S.saveLocal()
  S.pushSettings().catch(() => {})
}

/** 登录/同步后用云端星级补本地缓存（只升不降，避免旧设备把新成绩拉低） */
function hydrateStars() {
  const cloud = (S.state.settings.quiz_stars || {})
  Object.keys(cloud).forEach((t) => {
    if (Number(cloud[t]) > getStars(t)) localStorage.setItem(QUIZ_KEY(t), String(Number(cloud[t]) || 0))
  })
}

function topicsList() {
  const byTopic = new Map()
  S.state.cards.forEach((c) => {
    const w = S.learningWordOf(c)
    if (!w || S.isBlockedWord(w)) return
    const p = w.payload || {}
    const zh = ((p.senses || [])[0] || {}).def_zh
    const topic = String(p.topic || '').trim()
    if (!zh || !topic) return
    if (!byTopic.has(topic)) byTopic.set(topic, [])
    byTopic.get(topic).push({ id: w.id, term: w.lemma || w.normalized, zh, payload: p })
  })
  return Array.from(byTopic.entries())
    .map(([topic, list]) => ({ topic, n: list.length, list }))
    .filter((x) => x.n >= 4)
    .sort((a, b) => b.n - a.n)
}

function startQuiz(topic, list) {
  const qs = []
  const pool = shuffle(list.slice()).slice(0, quizSize(8))
  pool.forEach((item) => {
    const colls = (item.payload.collocations || []).filter((c) => c.pattern && (c.examples || []).length)
    const kinds = ['choice-zh', 'type-en']
    if (colls.length) kinds.push('cloze')
    const kind = kinds[Math.floor(Math.random() * kinds.length)]
    if (kind === 'cloze') {
      const c = colls[Math.floor(Math.random() * colls.length)]
      const core = String(c.pattern).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
      const ex = c.examples[0]
      const re = new RegExp(core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      if (core && re.test(ex.en)) {
        qs.push({ kind, item, sentence: ex.en.replace(re, '________'), zh: ex.zh || '', expected: core })
        return
      }
      qs.push({ kind: 'type-en', item, expected: item.term })
      return
    }
    if (kind === 'type-en') qs.push({ kind, item, expected: item.term })
    else qs.push({ kind, item, expected: item.zh })
  })
  G.mode = 'quiz'
  G.quiz = { topic, qs, i: 0, ok: 0, wrong: [], answered: null, done: false, credited: false }
}

function quizStars(okN, total) {
  const pct = total ? okN / total : 0
  if (pct >= 1) return 3
  if (pct >= 0.85) return 2
  if (pct >= 0.7) return 1
  return 0
}

function renderQuiz() {
  const q = G.quiz
  if (q.done) {
    const stars = quizStars(q.ok, q.qs.length)
    const key = QUIZ_KEY(q.topic)
    if (stars > getStars(q.topic)) setStars(q.topic, stars)
    const total = q.qs.length
    return '<h1 class="page">情景闯关<span class="sub">结束</span></h1>' +
      '<div class="empty"><div class="big">' + '★'.repeat(stars) + '☆'.repeat(3 - stars) + '</div>' +
      '<p class="tiny">' + q.topic + '</p>' +
      '<p class="tiny">答对 ' + q.ok + ' / ' + total +
      (stars > 0 ? '　｜　<b>通关！</b>' : '　｜　差一点，再来一次') + '</p>' +
      (q.wrong.length ? '<p class="tiny" style="text-align:left;">错的：' +
        q.wrong.map((w) => '<b>' + esc(w) + '</b>').join('、') + '</p>' : '') +
      '<div class="btn-group" style="justify-content:center;margin-top:16px;">' +
      (q.credited ? '' : '<button class="btn primary" id="quiz-credit">把这次表现记进复习计划</button>') +
      '<button class="btn" id="quiz-again">再闯一次</button>' +
      '<button class="btn ghost" id="quiz-back">返回</button></div></div>'
  }

  const cur = q.qs[q.i]
  const a = q.answered
  let prompt = ''
  let choicesHTML = ''
  if (cur.kind === 'choice-zh') {
    prompt = '<div class="term">' + esc(cur.item.term) + '</div><div class="ask">选出它的中文意思</div>'
    if (!a && !sessionOpts()) {
      G.quiz.options = buildChoices(cur.item, 'zh', cur.expected)
    }
    const opts = q.options || []
    choicesHTML = '<div class="choices">' + opts.map((o, i) =>
      '<button class="choice' + (a ? (o.ok ? ' good' : '') : '') + '" data-opt="' + i + '"' +
      (a ? ' disabled' : '') + '>' + esc(o.text) + '</button>').join('') + '</div>'
  } else if (cur.kind === 'cloze') {
    prompt = '<div class="ask">把空缺处的英文打出来</div>' +
      '<div style="font-size:19px;line-height:1.7;margin-top:10px;">' + esc(cur.sentence) + '</div>' +
      (cur.zh ? '<div class="ipa" style="margin-top:8px;">' + esc(cur.zh) + '</div>' : '')
  } else {
    prompt = '<div class="ask">用英语说出这个意思</div>' +
      '<div class="term small" style="margin:10px 0;">' + esc(cur.item.zh) + '</div>'
  }

  return '<h1 class="page">' + esc(q.topic) + '<span class="sub">' + (q.i + 1) + ' / ' + q.qs.length +
    '　｜　对 ' + q.ok + '</span></h1>' +
    '<div class="card">' + prompt +
    (a ? '<div class="verdict ' + (a.ok ? 'good' : 'bad') + '">' +
      (a.ok ? '答对了' : '不对，答案是 <b>' + esc(a.expected) + '</b>') +
      (a.given ? '　你写的：' + esc(a.given) : '') + '</div>' +
      (!a.ok ? whyBlockHTML(cur.item) : '') : '') +
    (cur.kind !== 'choice-zh' && !a
      ? '<input class="input ans-in" id="quiz-in" placeholder="打出来，回车提交" autocomplete="off" spellcheck="false">'
      : '') +
    (cur.kind === 'choice-zh' ? choicesHTML : '') +
    (a ? '<div class="row" style="justify-content:center;margin-top:12px;">' +
      '<button class="btn primary" id="quiz-next">' + (q.i + 1 >= q.qs.length ? '看结果' : '下一题') + '</button></div>' : '') +
    '</div>'
}

function sessionOpts() { return G.quiz && G.quiz.options }

function bindQuiz(cb) {
  const q = G.quiz
  // 结束态时 q.i === q.qs.length，cur 为 undefined —— 必须守卫，
  // 否则这里抛错会中断 bindQuiz 后面所有按钮的绑定（包括返回按钮）
  const cur = q.done ? null : q.qs[q.i]

  const submit = () => {
    const inp = $('#quiz-in')
    const given = inp ? inp.value : ''
    const r = judgeTyped(given, cur.expected)
    q.answered = { ok: r.ok, given, expected: cur.expected }
    if (r.ok) q.ok++
    else if (!q.wrong.includes(cur.item.term)) q.wrong.push(cur.item.term)
    cb()
  }
  if (cur && cur.kind !== 'choice-zh' && !q.answered) {
    const go = $('#quiz-in')
    if (go) go.onkeydown = (e) => { if (e.key === 'Enter') submit() }
  }
  if (cur) $$('.choice').forEach((btn) => {
    btn.onclick = () => {
      if (q.answered) return
      const opt = (q.options || [])[Number(btn.dataset.opt)]
      if (!opt) return
      q.answered = { ok: !!opt.ok, given: opt.text, expected: cur.expected }
      if (opt.ok) q.ok++
      else if (!q.wrong.includes(cur.item.term)) q.wrong.push(cur.item.term)
      cb()
    }
  })
  const next = $('#quiz-next')
  if (next) next.onclick = () => {
    q.i++
    q.answered = null
    q.options = null
    if (q.i >= q.qs.length) q.done = true
    cb()
  }
  const credit = $('#quiz-credit')
  if (credit) credit.onclick = async () => {
    credit.disabled = true
    credit.textContent = '写入中…'
    const okList = q.qs.filter((x) => !q.wrong.includes(x.item.term)).map((x) => x.item)
    const badList = q.qs.filter((x) => q.wrong.includes(x.item.term)).map((x) => x.item)
    const n = await moduleCredit(okList, true) + await moduleCredit(badList, false)
    q.credited = true
    ok('已写入 ' + n + ' 个词')
    cb()
  }
  const again = $('#quiz-again')
  if (again) again.onclick = () => {
    const t = topicsList().find((x) => x.topic === q.topic)
    if (t) { startQuiz(q.topic, t.list); cb() }
  }
  const back = $('#quiz-back')
  if (back) back.onclick = () => { G.mode = 'quiz-select'; G.quiz = null; cb() }
}

function renderQuizSelect() {
  const levels = topicsList()
  if (!levels.length) {
    // 空关卡必须带出口：用户在加载阶段点进来，看到的如果是一个
    // 既没内容也没返回按钮的页面，就只能靠切 tab 自救。
    const ph = dataStateCard({ loadingText: '正在取回你的语料与关卡…' })
    return '<h1 class="page">情景闯关</h1>' + (ph ||
      ('<div class="empty"><div class="big">还没有可用关卡</div>' +
        '<p class="tiny">关卡来自导入文档时的章节（如「失物招领」「卡片 / 门禁」）。' +
        '重新导入一次带章节的语料即可生成。</p>' +
        '<div class="btn-group" style="justify-content:center;margin-top:16px;">' +
        '<button class="btn ghost" id="quizsel-back">返回练习场</button></div></div>'))
  }
  const cards = levels.slice(0, 24).map((lv) => {
    const stars = getStars(lv.topic)
    return '<button class="card tight level" data-topic="' + esc(lv.topic) + '">' +
      '<div class="row between"><div class="grow">' +
      '<div style="font-size:14.5px;font-weight:600;">' + esc(lv.topic) + '</div>' +
      '<div class="tiny">' + lv.n + ' 个词</div></div>' +
      '<div style="color:var(--warn);font-size:15px;letter-spacing:1px;">' +
      '★'.repeat(stars) + '☆'.repeat(3 - stars) + '</div></div></button>'
  }).join('')
  return '<h1 class="page">情景闯关<span class="sub">' + levels.length + ' 个关卡</span></h1>' +
    '<p class="tiny" style="margin-bottom:10px;">关卡就是你语料库的章节。每个关卡 8 题、' +
    '三种题型混出，正确率 ≥70% 通关。</p>' + cards +
    '<div class="row" style="justify-content:center;margin-top:12px;">' +
    '<button class="btn sm ghost" id="quizsel-back">返回练习场</button></div>'
}

function bindQuizSelect(cb) {
  $$('.level').forEach((b) => {
    b.onclick = () => {
      const lv = topicsList().find((x) => x.topic === b.dataset.topic)
      if (!lv) return
      startQuiz(lv.topic, lv.list)
      cb()
    }
  })
  const back = $('#quizsel-back')
  if (back) back.onclick = () => { G.mode = null; cb() }
}

/* ═════════════════════════ AI 情景对话 ═════════════════════════ */

const SCENARIOS = [
  { id: 'lost', title: '学生报失', topic: '失物招领',
    opening: 'Hi, I think I lost my student ID card somewhere on campus. Can you help me look for it?' },
  { id: 'card', title: '门禁卡消磁', topic: '卡片 / 门禁',
    opening: 'Excuse me, my card stopped working at the gate this morning. Is it demagnetized?' },
  { id: 'workorder', title: '工单跟进', topic: 'Campus Operations：最值得先背的工作英语',
    opening: 'Hi, I submitted a work order last week about the heating in my room. Any update on that?' },
  { id: 'complaint', title: '处理投诉', topic: 'Complaint / Dispute / Claim',
    opening: "Hello, I'd like to lodge a complaint about the constant noise in my dorm at night." },
]

/** 目标表达的归一化（只用于**去重与重叠判断**，不参与判分）。
 *  代词槽位 sb.'s / sth 只是模板占位符，比较时必须抹掉 ——
 *  否则 "trace sb.'s whereabouts" 和 "trace whereabouts" 会被当成两个不同目标。 */
function normTarget(t) {
  return String(t || '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s*&\s*/g, ' and ')     // & 是 and 的常见写法：lost & found 必须等价于 lost and found
    .replace(/\bsb\.?'?s\b|\bsb\b|\bsth\b|\bsomeone\b|\bsomething\b|\bone's\b/g, ' ')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 本场景的目标表达。
 *
 *  两个必须做的去重（对应方案 2.2 / 观察 O07、O09）：
 *  ① **按词条去重**：一个词有 recognition/cloze/production 多种卡型，
 *     旧实现每张卡各 push 一个目标 → 目标区出现三个一模一样的 "lost and found"，
 *     一句话命中就显示"命中 lost and found、lost and found"。
 *  ② **按最长跨度去重**：一个目标的词块完整包含另一个时只保留长的 ——
 *     "trace sb.'s whereabouts" 与 "whereabouts" 同时点亮，等于一句话拿两份奖励。
 */
function chatTargets(sc) {
  const byWord = new Map()
  S.state.cards.forEach((c) => {
    const w = S.learningWordOf(c)
    // 待审核词条不进对话目标 —— 与学习队列同一把闸门，否则练习场会绕过它
    if (!w || byWord.has(w.id) || S.isBlockedWord(w)) return          // 同一个词只留一个目标
    const p = w.payload || {}
    const zh = ((p.senses || [])[0] || {}).def_zh
    if (!zh) return
    byWord.set(w.id, { id: w.id, term: w.lemma || w.normalized, zh, topic: String(p.topic || '') })
  })

  const kept = []
  Array.from(byWord.values())
    .sort((a, b) => normTarget(b.term).length - normTarget(a.term).length)
    .forEach((x) => {
      const xn = normTarget(x.term)
      if (!xn) return
      const covered = kept.some((k) => normTarget(k.term).indexOf(xn) >= 0)
      if (!covered) kept.push(x)
    })

  const inTopic = kept.filter((x) => x.topic === sc.topic)
  const rest = kept.filter((x) => x.topic !== sc.topic)
  return inTopic.concat(shuffle(rest)).slice(0, 8)
}

export function startChat(scId) {
  const sc = scenarioById(scId)
  if (!sc) return fail('没有这个场景')
  const targets = chatTargets(sc)
  /* 目标抽不出来时**不要**照常开"用上一个亮一个"的任务。
     那样用户面对的是一个永远亮不起来的目标区：不知道自己该做什么，
     也没有任何东西能让他判断"我这次做得对不对"。要么明说是自由聊天，
     要么让他先去把相关词加进来 —— 最不能做的就是假装任务正常。 */
  G.mode = 'chat'
  G.chat = {
    sc, targets: targets,
    msgs: [{ role: 'ai', text: sc.opening }],
    input: '', busy: false, error: '',
    freeMode: targets.length === 0,
  }
}

function chatSystemPrompt(sc, targets) {
  return [
    'You are role-playing with a Chinese university campus-safety officer who practices workplace English.',
    'Scenario: ' + sc.title + '. The learner is the staff member; you play the other party (student, colleague, or caller).',
    'The learner is expected to naturally use these expressions: ' +
      targets.map((t) => t.term).join(', ') + '.',
    'Rules:',
    '- English only, natural and simple (around CEFR B1).',
    '- Stay in the scenario; ask short questions that invite the learner to use those expressions.',
    '- Reply in 1-2 sentences, under 40 words. No lists, no explanations, no translations.',
    '- If the learner writes Chinese, gently ask them to try again in English.',
    '- Only output your dialogue line.',
  ].join('\n')
}

function renderChat() {
  const c = G.chat
  const usedLast = c.lastUsed || []
  const msgs = c.msgs.map((m, i) =>
    '<div class="chat-msg ' + (m.role === 'ai' ? 'ai' : 'me') + '">' + esc(m.text) + '</div>'
  ).join('')

  const targets = c.targets.length
    ? c.targets.map((t) =>
      '<span class="chip' + (c.usedTerms && c.usedTerms.has(t.term) ? ' strong' : '') + '">' + esc(t.term) + '</span>'
    ).join('')
    : ''

  return '<h1 class="page">' + esc(c.sc.title) + '<span class="sub">AI 情景对话</span></h1>' +
    (c.freeMode
      ? '<div class="card tight"><div class="tiny" style="margin-bottom:6px;">自由聊天</div>' +
        '<span class="tiny">这个场景暂时抽不出目标表达（相关词还没学过、或还没有中文释义），' +
        '所以这次<b>不计目标命中</b>，随便聊就好。想练特定表达的话，先去词库把相关词补上。</span></div>'
      : '<div class="card tight"><div class="tiny" style="margin-bottom:6px;">本场景目标表达（用上一个亮一个）</div>' +
        '<div class="chips">' + targets + '</div></div>') +
    '<div class="card" id="chat-log">' + msgs + '</div>' +
    (c.error ? '<div class="verdict bad">' + esc(c.error) + '</div>' : '') +
    '<div class="row" style="gap:8px;margin-top:10px;">' +
    '<input class="input" id="chat-in" placeholder="用英文回复…" autocomplete="off" value="' + esc(c.input) + '"' +
    (c.busy ? ' disabled' : '') + '>' +
    '<button class="btn primary" id="chat-send"' + (c.busy ? ' disabled' : '') + '>' +
    (c.busy ? '…' : '发送') + '</button></div>' +
    (usedLast.length ? '<p class="tiny" style="margin-top:6px;">这句用上了：' +
      usedLast.map((t) => '<b>' + esc(t) + '</b>').join('、') + '</p>' : '') +
    (c.stuffWarn ? '<p class="tiny" style="margin-top:6px;color:var(--warn);">' +
      '这一句把好几个目标表达堆在一起了 —— 一次自然用上 1～2 个更像真实对话，' +
      '所以这句没有点亮目标。</p>' : '') +
    // AI 出错后要有明确的再试入口：只把错误显示出来、让用户自己去猜怎么继续，是最差的收尾
    (c.error ? '<div class="row" style="justify-content:center;margin-top:8px;">' +
      '<button class="btn sm" id="chat-retry">重发这一句</button></div>' : '') +
    '<div class="row" style="justify-content:center;margin-top:12px;">' +
    '<button class="btn sm ghost" id="chat-back">结束对话</button></div>'
}

async function sendChat(cb) {
  const c = G.chat
  const inp = $('#chat-in')
  const text = String(inp.value || '').trim()
  if (!text || c.busy) return
  c.msgs.push({ role: 'me', text })
  c.input = ''
  c.busy = true

  // 本句用上了哪些目标表达：**按目标计，不按出现次数计**。
  // targets 已按词条 + 最长跨度去重，所以 used 天然不会出现同一个表达两次（O09）。
  const hits = c.targets
    .map((t) => { try { return __usesTerm(text, t.term) ? t : null } catch (e) { return null } })
    .filter(Boolean)
  // 同一跨度只奖励一次：长表达与它的子串同时命中时，只算长的那个
  const spans = []
  hits.forEach((h) => {
    const n = normTarget(h.term)
    if (!spans.some((s) => s.indexOf(n) >= 0 && s !== n)) spans.push(n)
  })
  const used = hits
    .filter((h) => !spans.some((s) => s.indexOf(normTarget(h.term)) > 0 && s !== normTarget(h.term)))
    .map((t) => t.term)

  /* 堆词检测：一句话里塞进 3 个以上**不同**目标、而句子本身又很短 ——
     那不是"自然用出来"，是把手边的词一股脑倒进去。
     判据必须基于去重后的目标数：旧实现用未去重的命中数，同一句里
     一句 `lost and found` 就能被算成两次，于是正常句子也被判成堆砌（观察 O08）。 */
  const words = text.split(/\s+/).filter(Boolean).length
  const stuffed = used.length >= 3 && words < used.length * 5
  c.stuffWarn = stuffed

  c.usedTerms = c.usedTerms || new Set()
  if (!stuffed) {
    used.forEach((t) => c.usedTerms.add(t))
    c.lastUsed = used
  } else {
    // 堆词的那一句不点亮任何目标 —— 灯只奖励"用得像人话"的句子
    c.lastUsed = []
  }

  cb()

  const sc = c.sc
  const transcript = c.msgs.map((m) => (m.role === 'ai' ? 'AI: ' : 'Learner: ') + m.text).join('\n')
  const placeholder = { role: 'ai', text: '' }
  c.msgs.push(placeholder)

  try {
    await CLOUD.chatText({
      system: chatSystemPrompt(sc, c.targets),
      user: 'Conversation so far:\n' + transcript + '\n\nContinue as the AI. Reply with only your dialogue line.',
      temperature: 0.6,
      maxTokens: 300,
      onDelta: (delta) => {
        placeholder.text += delta
        const log = $('#chat-log')
        if (log) log.innerHTML = c.msgs.map((m) =>
          '<div class="chat-msg ' + (m.role === 'ai' ? 'ai' : 'me') + '">' + esc(m.text) + '</div>').join('')
      },
    })
    if (!placeholder.text) placeholder.text = '(AI 没有返回内容，可重发)'
  } catch (e) {
    c.msgs.pop()
    const msg = String((e && e.message) || e).slice(0, 120)
    // 离线降级：模型连不上时不让对话直接死掉，转成自测模式继续练。
    // 关键是**不能把这次失败算作"学不会"** —— 它是基础设施问题，跟记忆无关。
    const targets = (c.targets || []).map((t) => t.term).filter(Boolean).slice(0, 6)
    c.msgs.push({
      role: 'ai',
      text: '（AI 暂时连不上：' + msg + '）\n进入自测模式 —— 请继续用英文推进对话，' +
        '试着自然地用上下列表达：\n· ' + (targets.join('\n· ') || '（本场景暂无目标词）'),
    })
    c.error = 'AI 没能回复（不影响已记录的内容）'
    c.lastInput = text   // 留着让用户能一键重发，而不是重新打一遍
  }
  c.busy = false
  cb()
}

/** 目标词是否被用上：词组整体或其核心词都出现即算 */
/** 极简词干：只处理最常见的规则屈折后缀。
 *  不追求语言学正确 —— 目的是让 "dealt with" / "dealing with" 也能匹配 "deal with"，
 *  不让用户因为换了形态就被判"没用上"。不规则变化（dealt、went）不覆盖，
 *  那种情况会走到"没命中"，但不会误判成命中。 */
function stemWord(w) {
  const s = String(w || '')
  if (s.length <= 3) return s
  return s
    .replace(/(ies|ied)$/, 'y')
    .replace(/(ing|ed|es|s)$/, '')
    .replace(/e$/, '')
}

/** 目标表达是否被用上。容忍大小写、标点、规则屈折与代词槽位。
 *  返回命中的归一化跨度（没命中返回空串）—— 上层用它做"同一跨度不重复奖励"。 */
function __usesTerm(text, term) {
  const tn = normTarget(term)
  if (!tn) return ''
  const tt = normTarget(text)
  if (!tt) return ''
  // 词边界匹配，不用裸 indexOf：目标 "do" 不能因为 "doctor" 里有 do 就算用上了。
  // 短目标词尤其容易踩这个，而短目标恰恰是词库里最普遍的一类。
  if (new RegExp('\\b' + escapeRe(tn) + '\\b').test(tt)) return tn
  const stems = tn.split(' ').map(stemWord).filter((x) => x && x.length >= 3)
  if (!stems.length) return ''
  const all = stems.every((s) => new RegExp('\\b' + escapeRe(s) + '\\w*').test(tt))
  return all ? tn : ''
}

function bindChat(cb) {
  const send = $('#chat-send')
  if (send) send.onclick = () => { sendChat(cb) }
  const inp = $('#chat-in')
  if (inp) {
    inp.onkeydown = (e) => { if (e.key === 'Enter' && !G.chat.busy) sendChat(cb) }
    inp.oninput = () => { G.chat.input = inp.value }
    setTimeout(() => { try { inp.focus() } catch (e) {} }, 60)
  }
  const back = $('#chat-back')
  if (back) back.onclick = () => { G.mode = 'chat-select'; G.chat = null; cb() }
  // 重发：把上一句填回输入框并清掉错误提示，用户点发送即可 ——
  // 不自动重发是因为他自己可能也想改一改再说一次
  const retry = $('#chat-retry')
  if (retry) retry.onclick = () => {
    const i = $('#chat-in')
    if (i && G.chat.lastInput) i.value = G.chat.lastInput
    G.chat.error = ''
    cb()
  }
  // 让新消息可见
  const log = $('#chat-log')
  if (log) log.scrollTop = log.scrollHeight
}

function renderChatSelect() {
  const cards = allScenarios().map((sc) =>
    '<button class="card tight level" data-sc="' + sc.id + '">' +
    '<div class="row between"><div class="grow">' +
    '<div style="font-size:14.5px;font-weight:600;">' + esc(sc.title) + '</div>' +
    '<div class="tiny">' + esc(sc.topic) + '</div></div>' +
    '<span class="tiny">' + icon('study', 18) + '</span></div></button>'
  ).join('')
  return '<h1 class="page">AI 情景对话<span class="sub">真刀真枪用出来</span></h1>' +
    '<p class="tiny" style="margin-bottom:10px;">AI 扮演学生/同事，把场景推进下去；' +
    '你要用英文接住，并把目标表达自然地用出来。用上一个亮一个。</p>' + cards +
    '<div class="row" style="justify-content:center;margin-top:12px;">' +
    '<button class="btn sm ghost" id="chatsel-back">返回练习场</button></div>'
}

function bindChatSelect(cb) {
  $$('.level').forEach((b) => {
    b.onclick = () => { startChat(b.dataset.sc); cb() }
  })
  const back = $('#chatsel-back')
  if (back) back.onclick = () => { G.mode = null; cb() }
}

export function renderGames() {
  if (G.mode === 'transfer') return TRANSFER.renderTransfer()
  if (G.mode === 'focus') return FOCUS.renderFocus()
  if (G.mode === 'match') return renderMatch()
  if (G.mode === 'dict') return renderDict()
  if (G.mode === 'quiz') return renderQuiz()
  if (G.mode === 'quiz-select') return renderQuizSelect()
  if (G.mode === 'chat') return renderChat()
  if (G.mode === 'chat-select') return renderChatSelect()
  if (G.mode === 'story-select') return renderStoryPick()
  if (G.mode === 'story') return renderStory()
  if (LABS.hasLab(G.mode)) return LABS.renderLab(G.mode)

  hydrateStars()   // 进入练习场时用云端星级补齐本地缓存
  const st = streakStats()
  const focusStats = FOCUS.focusStats()
  return (
    '<h1 class="page">练习场<span class="sub">换种方式过一遍</span></h1>' +

    // 数据没到位时明说：练习场首页是静态的（模式选择不需要数据），
    // 不提示的话用户会点进某个模式，然后莫名其妙地失败。
    (S.dataPending() || S.dataFailed()
      ? '<div class="sync-bar"><span class="dot"></span>' +
        (S.dataFailed() ? '词库没加载成功，练习模式暂时用不了 —— 去「今日」页点重试' : '正在同步词库，部分模式暂时不可用…') +
        '</div>'
      : '') +

    '<div class="card tight" style="background:var(--brand-soft);border-color:transparent;">' +
    '<div class="row between"><div>' +
    '<div style="font-size:15px;font-weight:600;">🔥 连续学习 ' + st.cur + ' 天</div>' +
    '<div class="tiny">最长 ' + st.best + ' 天　｜　累计 ' + st.total + ' 天　｜　今天' +
    ((S.state.daily || []).some((x) => String(x.reviewed_on).slice(0, 10) === dayKey(new Date()) && Number(x.total) > 0)
      ? '已打卡' : '还没打卡') + '</div></div></div></div>' +

    '<div class="card"><h2>表达联系与新情境</h2><p class="muted">10 组精修表达，联系辨析 → 新句回忆 → 换情境使用。每次 3 题，可替代一次其他练习。</p>' +
    '<button class="btn primary block" id="g-transfer">开始小批试练</button></div>' +

    // 独立于 FSRS 的每日综合训练
    '<div class="card" style="border-color:var(--brand);">' +
    '<div class="card-head"><h2>每日综合训练</h2><span class="hint">推荐 · 约 15–20 分钟</span></div>' +
    '<p class="muted" style="margin:0 0 10px;">已学词主动回忆 → 选择辨析 → 校园安全英文情景回应。' +
    '可选 AI 反馈；不改变 FSRS、不占复习上限。</p>' +
    '<p class="tiny" style="margin-bottom:12px;">本机近 7 天：' + focusStats.sessions +
    ' 次 · 独立提取率（自评）' + (focusStats.independentRate === null ? '暂无' : Math.round(focusStats.independentRate * 100) + '%') +
    '</p>' +
    '<button class="btn primary block" id="g-focus">开始每日综合训练</button></div>' +

    // AI 短文助记（旗舰）：把词真正用出来
    '<div class="card">' +
    '<div class="card-head"><h2>AI 短文助记</h2><span class="hint">把词用出来</span></div>' +
    '<p class="muted" style="margin:0 0 12px;">勾选几个词，AI 写一篇校园安全场景的英文短文，' +
    '把它们<b>全部用进去</b> —— 读一遍就知道这些词在真实工作里长什么样。</p>' +
    '<button class="btn primary block" id="g-story">选词生成短文</button>' +
    (Array.isArray(S.state.settings.stories) && S.state.settings.stories.length
      ? '<button class="btn soft block" id="g-stories" style="margin-top:8px;">我的短文（' +
        S.state.settings.stories.length + ' 篇）</button>'
      : '') +
    '</div>' +

    // 每周抽测：跨日检索，检验"是不是真的记住了"
    (function () {
      const last = Number(S.state.settings.last_test_at) || 0
      const days = last ? Math.floor((Date.now() - last) / 86400000) : -1
      const dueTest = days < 0 || days >= 7
      const ring = dueTest ? ' style="border-color:var(--brand);box-shadow:0 0 0 2px var(--brand-soft);"' : ''
      const note = days < 0 ? '还没抽测过' : (days >= 7 ? '距上次抽测 ' + days + ' 天' : '上次抽测 ' + days + ' 天前')
      return '<div class="card"' + ring + '>' +
        '<div class="card-head"><h2>每周抽测</h2><span class="hint">' + (dueTest ? '该做了' : note) + '</span></div>' +
        // 不写 source=test 这类内部字段名 —— 用户看不懂，也不该看到实现细节
        '<p class="muted" style="margin:0 0 10px;">从<b>最久没见过</b>的学过的词里抽 10 个，' +
        '用英语把它们说出来。成绩和正式复习<b>分开统计</b>，做完可以选择写进复习计划。</p>' +
        // 题型可选：全产出最难，但一直只有它会让很多人直接放弃抽测
        '<div class="seg" style="margin-bottom:6px;">' +
        TEST_MODES.map((m) =>
          '<button data-testmode="' + m.k + '" class="' + (testMode() === m.k ? 'on' : '') + '">' +
          esc(m.label) + '</button>').join('') +
        '</div>' +
        '<p class="tiny" style="margin:0 0 12px;">' +
        esc((TEST_MODES.find((m) => m.k === testMode()) || {}).hint || '') +
        (testMode() === 'mixed' ? '　选择题记为<b>识别</b>成绩，产出题才是真正的检索提取。' : '') +
        '</p>' +
        '<button class="btn primary block" id="g-weekly">开始抽测（10 题）</button>' +
        '</div>'
    })() +

    '<div class="card">' +
    '<div class="card-head"><h2>开始练习</h2></div>' +
    '<p class="muted" style="margin:0 0 10px;">8 种模式：配对、听写、中译英、闯关、AI 对话、对战、组句、跟读（都有结束小结，' +
    '可选择性写进复习计划）。</p>' +
    '<div class="field" style="margin:0;"><label>每组练习词数</label></div>' +
    sizeChips() +
    '<button class="btn primary block lg" id="g-pick" style="margin-top:12px;">选择练习模式</button>' +
    '<p class="tiny center" style="margin:10px 0 0;">练习模式不计入遗忘曲线。</p>' +
    '</div>' +

    '<p class="tiny center" style="margin-top:6px;">想要随机换着练？进任何模式后都可以「再来一轮」，题目会重新抽。</p>'
  )
}

export function bindGames(cb, go) {
  // 练习场首页：题量选择 + 打开模式弹层 + AI 短文
  $$('[data-size]').forEach((b) => {
    b.onclick = () => { G.size = Number(b.dataset.size) || 0; cb() }
  })
  const transfer = $('#g-transfer')
  if (transfer) transfer.onclick = () => { TRANSFER.startTransfer(); G.mode = 'transfer'; cb() }
  if (G.mode === 'transfer') TRANSFER.bindTransfer(cb, () => { G.mode = null; cb() })
  const focus = $('#g-focus')
  if (focus) focus.onclick = () => { if (FOCUS.startFocus()) { G.mode = 'focus'; cb() } }
  const pick = $('#g-pick')
  if (pick) pick.onclick = () => openModePicker(cb)
  const story = $('#g-story')
  if (story) story.onclick = () => { if (startStory()) { G.mode = 'story-select'; cb() } }
  const weekly = $('#g-weekly')
  if (weekly) weekly.onclick = () => { startWeekly(); cb() }
  // 抽测题型：选完立刻存下（本地 + 云端），下次进来还是这个选择
  $$('[data-testmode]').forEach((b) => {
    b.onclick = () => {
      S.state.settings.test_mode = b.dataset.testmode
      S.saveLocal()
      S.pushSettings().catch(() => {})
      cb()
    }
  })
  const stories = $('#g-stories')
  if (stories) stories.onclick = () => openStoryArchive()

  if (G.mode === 'focus') FOCUS.bindFocus(cb, () => { G.mode = null; cb() })
  if (G.mode === 'match') bindMatch(cb)
  if (G.mode === 'dict') bindDict(cb)
  if (G.mode === 'quiz') bindQuiz(cb)
  if (G.mode === 'quiz-select') bindQuizSelect(cb)
  if (G.mode === 'chat') bindChat(cb)
  if (G.mode === 'chat-select') bindChatSelect(cb)
  if (G.mode === 'story-select') bindStoryPick(cb)
  if (G.mode === 'story') bindStory(cb)
  if (LABS.hasLab(G.mode)) LABS.bindLab(G.mode, (full) => {
    if (full === true) { G.mode = null }
    cb()
  })
}

/** credit 统一走 store，labs 的三个玩法也要用，放这里避免 labs → game 反向依赖 */
const moduleCredit = S.creditWords
