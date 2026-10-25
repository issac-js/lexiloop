/** ui.js — 通用界面工具：转义、提示、弹层、图标 */

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const $ = (sel, root) => (root || document).querySelector(sel)
export const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel))

/* ─────────────────────────── 提示 ─────────────────────────── */

export function toast(msg, kind) {
  const wrap = $('#toast-wrap')
  if (!wrap) return
  const node = document.createElement('div')
  node.className = 'toast' + (kind ? ' ' + kind : '')
  node.textContent = msg
  wrap.appendChild(node)
  setTimeout(() => {
    node.style.transition = 'opacity .25s'
    node.style.opacity = '0'
    setTimeout(() => node.remove(), 260)
  }, kind === 'err' ? 4200 : 2200)
}

export const ok = (m) => toast(m, 'ok')
export const fail = (m) => toast(m, 'err')

/* ─────────────────────────── 弹层 ─────────────────────────── */

let closer = null

export function openModal(html) {
  const wrap = $('#modal-wrap')
  wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>'
  wrap.hidden = false
  document.body.style.overflow = 'hidden'
  closer = () => {
    wrap.hidden = true
    wrap.innerHTML = ''
    document.body.style.overflow = ''
    closer = null
  }
  wrap.onclick = (e) => {
    if (e.target === wrap) closeModal()
  }
  return wrap.firstElementChild
}

// Esc 关闭弹层（只在注册一次，避免每次 open 都叠一个监听）
if (typeof window !== 'undefined' && !window.__lexiloopEscBound) {
  window.__lexiloopEscBound = true
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closer) closeModal()
  })
}

export function closeModal() {
  if (closer) closer()
}

export function confirmDialog(opts) {
  const o = opts || {}
  return new Promise((resolve) => {
    const m = openModal(
      '<h3>' + esc(o.title || '请确认') + '</h3>' +
      (o.sub ? '<p class="sub">' + esc(o.sub) + '</p>' : '') +
      (o.body ? '<div style="font-size:14px;color:var(--ink-2);">' + o.body + '</div>' : '') +
      '<div class="modal-actions">' +
      '<button class="btn" data-x="no">' + esc(o.cancelText || '取消') + '</button>' +
      '<button class="btn ' + (o.danger ? 'danger' : 'primary') + '" data-x="yes">' + esc(o.okText || '确定') + '</button>' +
      '</div>'
    )
    m.querySelector('[data-x="no"]').onclick = () => { closeModal(); resolve(false) }
    m.querySelector('[data-x="yes"]').onclick = () => { closeModal(); resolve(true) }
  })
}

/* ─────────────────────────── 图标 ─────────────────────────── */

const ICONS = {
  today: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"/><path d="M4 9.5h16M8.5 3v3M15.5 3v3"/><circle cx="12" cy="14.5" r="1.4" fill="currentColor" stroke="none"/>',
  study: '<rect x="3.5" y="5" width="13" height="15" rx="2.5"/><path d="M7.5 5V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-1 1.73"/>',
  library: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19"/>',
  stats: '<path d="M4 20h16"/><rect x="5.5" y="12" width="3.2" height="6" rx="1"/><rect x="10.4" y="8" width="3.2" height="10" rx="1"/><rect x="15.3" y="4.5" width="3.2" height="13.5" rx="1"/>',
  me: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.2a7.4 7.4 0 0 1 14.4 0"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sync: '<path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6"/><path d="M20 6v5h-5M4 18v-5h5"/>',
  sound: '<path d="M11 5 6.5 9H4v6h2.5L11 19z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/>',
  warn: '<path d="M10.3 3.9 2.7 17.2A2 2 0 0 0 4.4 20.2h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.2v4.2"/><circle cx="12" cy="16.9" r="1.05" fill="currentColor" stroke="none"/>',
  save: '<path d="M12 3.5v11"/><path d="M8 10.8 12 14.8l4-4"/><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
}

export function icon(name, size) {
  const s = size || 24
  return (
    '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>'
  )
}

export const LOGO_SVG =
  '<svg viewBox="0 0 48 48" width="48" height="48" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="48" height="48" rx="13" fill="#57068C"/>' +
  '<rect x="10" y="15" width="24" height="17" rx="4" fill="#ffffff" opacity="0.32"/>' +
  '<rect x="13" y="11" width="25" height="18" rx="4" fill="#ffffff" opacity="0.62"/>' +
  '<rect x="16" y="7" width="26" height="19" rx="4.5" fill="#ffffff"/>' +
  '<rect x="21" y="13" width="14" height="2.6" rx="1.3" fill="#57068C"/>' +
  '<rect x="21" y="18" width="9" height="2.6" rx="1.3" fill="#57068C" opacity="0.55"/>' +
  '</svg>'

/* ─────────────────────────── 其它 ─────────────────────────── */

export function fmtDateCN(ts) {
  const d = ts instanceof Date ? ts : new Date(ts)
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export function relTime(ts) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.round(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.round(m / 60)
  if (h < 24) return h + ' 小时前'
  const d = Math.round(h / 24)
  if (d < 30) return d + ' 天前'
  return fmtDateCN(ts)
}

/* ─────────────────────────── 朗读（标准美音） ─────────────────────────── */

const VOICE_KEY = 'lexiloop.voice.v1'
let voiceCache = []

/** 优先顺序：Windows/Edge 自然美音 → Google 美音 → 系统经典美音 */
const US_VOICE_PREF = [
  'microsoft aria online (natural)',
  'microsoft jenny online (natural)',
  'microsoft michelle online (natural)',
  'microsoft ana online (natural)',
  'google us english',
  'microsoft zira',
  'samantha',
  'allison',
  'ava',
  'alex',
]

function refreshVoices() {
  try {
    voiceCache = window.speechSynthesis.getVoices() || []
  } catch (e) {
    voiceCache = []
  }
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  refreshVoices()                                   // 立即取一次
  window.speechSynthesis.onvoiceschanged = refreshVoices   // 语音列表是异步加载的
}

/** 所有英语语音（美音排在前面，便于选择） */
export function listEnVoices() {
  if (!voiceCache.length) refreshVoices()
  const en = voiceCache.filter((v) => /^en([-_]|$)/i.test(v.lang || ''))
  const isUS = (v) => /^en[-_]us$/i.test(v.lang || '')
  return en.sort((a, b) => (isUS(b) ? 1 : 0) - (isUS(a) ? 1 : 0) || a.name.localeCompare(b.name))
}

export function getVoicePref() {
  try { return localStorage.getItem(VOICE_KEY) || '' } catch (e) { return '' }
}

export function setVoicePref(uri) {
  try { uri ? localStorage.setItem(VOICE_KEY, uri) : localStorage.removeItem(VOICE_KEY) } catch (e) { /* ignore */ }
}

/** 挑一个"标准美音、清晰"的语音：用户选定的 > 预置优先级 > 任意 en-US > 任意英语 */
function pickVoice() {
  const voices = listEnVoices()
  if (!voices.length) return null
  const pref = getVoicePref()
  if (pref) {
    const hit = voices.find((v) => v.voiceURI === pref || v.name === pref)
    if (hit) return hit
  }
  for (const want of US_VOICE_PREF) {
    const hit = voices.find((v) => String(v.name).toLowerCase().indexOf(want) >= 0)
    if (hit) return hit
  }
  return voices.find((v) => /^en[-_]us$/i.test(v.lang || '')) || voices[0]
}

/**
 * 朗读英文。默认标准美音、语速 0.95（比默认稍慢，更清楚）。
 * @param {string} text
 * @param {{slow?:boolean, voiceURI?:string}} [opts] slow=0.8 倍速（跟读示范用）
 */
export function speak(text, opts) {
  if (!('speechSynthesis' in window)) return false
  try {
    const o = opts || {}
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(String(text == null ? '' : text))
    const v = o.voiceURI ? listEnVoices().find((x) => x.voiceURI === o.voiceURI) || pickVoice() : pickVoice()
    if (v) u.voice = v
    u.lang = (v && v.lang) || 'en-US'
    u.rate = o.slow ? 0.8 : 0.95
    u.pitch = 1
    window.speechSynthesis.speak(u)
    return true
  } catch (e) {
    return false
  }
}

// iOS/触屏：软键盘弹起时固定底栏会浮在键盘上方挡住输入框。
// 输入期间给 body 挂 kbd 类，用 CSS 把底栏收起来；只在触屏设备启用（桌面不受影响）。
if (typeof document !== 'undefined' && !window.__lexiloopKbdBound &&
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
  window.__lexiloopKbdBound = true
  let blurTimer = null
  const needsKeyboard = (el) => el &&
    ((el.tagName === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|file|color|hidden)$/i.test(el.type || '')) ||
      /^(TEXTAREA|SELECT)$/.test(el.tagName))
  const finishBlur = () => {
    clearTimeout(blurTimer)
    if (!needsKeyboard(document.activeElement)) document.body.classList.remove('kbd')
  }
  document.addEventListener('focusin', (e) => {
    const el = e.target
    if (needsKeyboard(el)) {
      clearTimeout(blurTimer)
      document.body.classList.add('kbd')
    }
  })
  // Safari 先 blur 再 click。等按钮自身的 click 读完表单后再恢复底栏，
  // 避免第一次点保存只收起键盘，底栏在点按中重新出现并截走点击。
  document.addEventListener('focusout', () => {
    clearTimeout(blurTimer)
    blurTimer = setTimeout(finishBlur, 300)
  })
  document.addEventListener('click', finishBlur)
}

// 例句点读：任何带 data-say 的元素点击即朗读（各页面渲染的例句共用一套委托）
if (typeof document !== 'undefined' && !window.__lexiloopSayBound) {
  window.__lexiloopSayBound = true
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-say]') : null
    if (!el) return
    e.preventDefault()
    e.stopPropagation()
    speak(el.getAttribute('data-say'), { slow: el.getAttribute('data-say-slow') === '1' })
  })
}

/* ─────────────────────────── 主题 ─────────────────────────── */

const THEME_KEY = 'lexiloop.theme.v1'
const THEME_COLOR = { green: '#14875a', violet: '#57068C' }

export function getTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'violet' ? 'violet' : 'green'
  } catch (e) {
    return 'green'
  }
}

/** 应用主题（写本地 + 更新浏览器地址栏配色），返回实际生效的主题名 */
export function applyTheme(name) {
  const t = name === 'violet' ? 'violet' : 'green'
  try { localStorage.setItem(THEME_KEY, t) } catch (e) { /* ignore */ }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', t)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', THEME_COLOR[t])
  }
  return t
}

export const STRENGTH_ZH = { strong: '强搭配', medium: '中等', weak: '弱搭配' }
export const REGISTER_ZH = { formal: '正式', neutral: '中性', spoken: '口语', informal: '非正式' }
