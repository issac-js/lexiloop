/** app.js — 启动、路由与全局状态刷新
 *
 * ⚠️ 维护约定：本项目是无构建的静态站点，CDN 会按 URL 缓存 js 文件，
 * 且连 `cache: 'no-store'` 都绕不过边缘缓存。因此**每次发布前必须把所有
 * `from './xxx.js?v=N'` 的 N 加一**（含 index.html 里的 app.js），
 * 否则用户会拿到旧模块、出现「新代码调用旧导出」这类诡异报错。
 */
import * as S from './store.js?v=117'
import * as V from './views.js?v=117'
import * as AUTH from './cloud.js?v=117'
import * as FSRS from './fsrs.js?v=117'
import * as GAME from './game.js?v=117'
import { $, $$, esc, icon, LOGO_SVG, toast, fail, ok, applyTheme, getTheme } from './ui.js?v=117'

const TABS = [
  { k: 'today', label: '今日', icon: 'today' },
  { k: 'study', label: '学习', icon: 'study' },
  { k: 'games', label: '练习场', icon: 'stats' },
  { k: 'library', label: '词库', icon: 'library' },
  { k: 'stats', label: '统计', icon: 'stats' },
  { k: 'me', label: '我的', icon: 'me' },
]

let current = 'today'
let signedIn = false

// 主题：先用本地值（index.html 已提前设好 data-theme），同步后再按账号覆盖
applyTheme(getTheme())

const isLocal =
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  location.protocol === 'file:'

/* ─────────────────────────── 渲染 ─────────────────────────── */

function renderAuth() {
  $('#root').innerHTML =
    (isLocal
      ? '<div class="auth" style="padding-bottom:0;"><div class="card tight" style="background:var(--warn-soft);border-color:transparent;">' +
        '<div style="font-size:13px;color:var(--warn);">当前是本地预览地址，登录与云同步在此不可用。' +
        '请使用发布后的线上地址访问。</div></div></div>'
      : '') +
    V.renderAuth()
  V.bindAuth(onLoggedIn)
  markBooted()      // 登录页也算"起起来了"：界面已经交给用户，看门狗不该再插手
}

function shellHTML() {
  const badge = badgeCount()   // 只算一次：内部要遍历卡片表，别在 map 里连算三遍
  return (
    '<div class="shell">' +
    '<nav class="tabbar">' +
    '<div class="brand-mark">' + LOGO_SVG.replace('width="48" height="48"', 'width="26" height="26"') + '<span>搭配记忆</span></div>' +
    TABS.map((t) =>
      '<button data-tab="' + t.k + '" class="' + (current === t.k ? 'on' : '') + '">' +
      icon(t.icon, 22) + '<span>' + t.label + '</span>' +
      (t.k === 'today' && badge ? '<span class="badge">' + badge + '</span>' : '') +
      '</button>'
    ).join('') +
    '</nav>' +
    '<main class="main" id="main"></main>' +
    '</div>'
  )
}

/** 今日页角标的数字 = 「开始学习」那张卡上会出的张数。
 *  必须和首页按钮同源（都取 buildQueue 的真实长度）——
 *  角标说 1、按钮说 1、但实际出的卡不一样，是最典型的"应用坏了"观感。
 *  （旧实现把 min(卡数, 词配额) 拼在一起，两个单位不同的数相加，数字必然对不上。） */
function badgeCount() {
  const n = S.buildQueue().length
  return n > 0 ? (n > 99 ? '99+' : n) : ''
}

/** 手动重试：数据没拉回来时的唯一出口。
 *  用户不该为了一次网络抖动去"我的 → 检查更新"或强刷整页 —— 那两条路都会清掉未同步的本地改动。 */
async function resync(btn) {
  if (!signedIn) return
  if (btn) { btn.disabled = true; btn.textContent = '正在重试…' }
  try {
    await S.flushPending()
    await S.syncPull()
    render()
  } catch (e) {
    renderMain()
    fail('还是没能同步：' + ((e && e.message) || '请检查网络后重试'))
  }
}

function renderMain() {
  const main = $('#main')
  if (!main) return
  if (current === 'today') main.innerHTML = V.renderToday()
  else if (current === 'study') main.innerHTML = V.renderStudy()
  else if (current === 'games') main.innerHTML = GAME.renderGames()
  else if (current === 'library') main.innerHTML = V.renderLibrary()
  else if (current === 'stats') main.innerHTML = V.renderStats()
  else main.innerHTML = V.renderMe()
  main.insertAdjacentHTML('afterbegin', '<div id="job-banner-wrap">' + V.jobBannerHTML() + '</div>')
  // 测试模式必须**持续可见**：用户（或审计者）在测试里看到的进度、得分、达标状态
  // 都不是真实的，界面如果不反复说这件事，很容易把测试结果当成自己的学习表现。
  if (S.isTestSession()) {
    main.insertAdjacentHTML('afterbegin',
      '<div class="test-bar">测试模式：本次作答<b>不影响</b>学习进度（不计打卡、不出现在统计里）' +
      '<button class="btn sm ghost" id="test-exit">退出测试</button></div>')
  }
  // 有本地缓存、正在后台对齐云端时，挂一条细提示。
  // 没有它的话，用户看到的是"昨天的数字"，却不知道正在更新 —— 评完分发现统计没动会以为丢了。
  if (S.dataSyncing()) {
    main.insertAdjacentHTML('afterbegin',
      '<div class="sync-bar">' + '<span class="dot"></span>正在同步最新数据…</div>')
  }
  bindMain()
}

function bindMain() {
  const cb = viewCallback()
  V.bindJobBanner(cb)
  if (current === 'today') V.bindToday(go)
  else if (current === 'study') V.bindStudy(go, cb)
  else if (current === 'games') GAME.bindGames(cb, go)
  else if (current === 'library') V.bindLibrary(cb)
  else if (current === 'stats') V.bindStats(go)
  else V.bindMe(cb, go, onSignedOut)

  // 状态卡上的重试按钮：各页都可能出现，统一在这里绑一次
  const retry = $('#data-retry')
  if (retry) retry.onclick = () => resync(retry)

  // 退出测试模式
  const tExit = $('#test-exit')
  if (tExit) tExit.onclick = () => {
    S.setTestSession(false)
    toast('已退出测试模式，之后的作答会正常计入进度', 'ok')
    renderMain()
  }
}

/** 统一的视图刷新回调：'banner' 只刷进度条，true 整页重绘，其余只重绘当前页 */
function viewCallback() {
  return (kind) => {
    if (kind === 'review') V.refreshReviewPanel(viewCallback())
    else if (kind === 'banner') V.refreshJobBanner(viewCallback())
    else if (kind === true) render()
    else renderMain()
  }
}

// 供 views 里异步拿到数据后触发重绘（例如统计页的记忆指标）
function render() {
  markBooted()        // 能走到这里说明模块都加载成功了，index.html 的看门狗不用再兜底
  if (!signedIn) return renderAuth()
  window.__lexiloopRender = render
  $('#root').innerHTML = shellHTML()
  $$('[data-tab]').forEach((b) => {
    b.onclick = () => go(b.dataset.tab)
  })
  renderMain()
}

function go(tab) {
  if (tab === 'study' && current !== 'study') V.resetSession()
  // 已经在练习场时再点一次 = 回到模式选择（移动端惯例）。
  // 没有这条，用户进了某个子模式后想回首页只能找页面里的返回按钮 ——
  // 而空状态页面未必有（任务书 05 NAV）。
  if (tab === 'games' && current === 'games') GAME.exitMode()
  // 子模式是空的（词库没加载完/没数据）时不能停在空页面上
  if (tab === 'games' && GAME.modeIsEmpty()) GAME.exitMode()
  current = tab
  if (!signedIn) return
  $('#root').innerHTML = shellHTML()
  $$('[data-tab]').forEach((b) => {
    b.onclick = () => go(b.dataset.tab)
  })
  renderMain()
  window.scrollTo({ top: 0 })
  // 统计页进入时主动拉一次云端聚合，避免刚评完分看到旧数字
  if (tab === 'stats') {
    S.pullStats()
      .then(() => {
        if (current === 'stats') renderMain()
      })
      .catch(() => {})
  }
}

/* ─────────────────────────── 生命周期 ─────────────────────────── */

/** 启动成功标记：index.html 的看门狗靠它判断"是不是真的没起来" */
function markBooted() {
  try { window.__lexiloopBooted = true } catch (e) { /* 忽略 */ }
}

async function onLoggedIn(session) {
  GAME.exitMode() // 上一个账号的练习场状态不得流入新会话
  signedIn = true
  if (S.state.settings.theme) applyTheme(S.state.settings.theme)
  S.state.user = (session && session.user) || (await AUTH.getSession()).user
  // 会话载荷里的用户字段结构不做假设，登录用的邮箱由认证层记下来
  const mail = AUTH.lastEmail()
  if (mail) S.state.accountEmail = mail
  S.saveLocal()
  current = 'today'
  render()
  try {
    await S.flushPending()
    await S.syncPull()
    render()
  } catch (e) {
    // 拉不到数据也要重绘一次：否则页面停在"空库/任务完成"上，
    // 必须让用户看到"没能加载 + 重试"，而不是一个假完成（任务书 01 LOAD）
    render()
    fail('数据同步失败：' + ((e && e.message) || '请检查网络'))
  }
}

function onSignedOut() {
  GAME.exitMode() // 清理含有用户英文回应的会话内存
  signedIn = false
  current = 'today'
  S.clearPending()
  AUTH.clearLastEmail()
  S.state.user = null
  S.state.accountEmail = ''
  S.state.words = []
  S.state.cards = []
  S.state.daily = []
  S.reindex()
  S.resetLoad()      // 不清的话新账号会先看到上一个账号的缓存
  S.clearLocal()
  render()
}

function bootFail(msg) {
  $('#root').innerHTML =
    '<div class="boot"><div style="max-width:420px;text-align:center;">' +
    '<div style="font-size:16px;color:var(--ink);margin-bottom:8px;">启动失败</div>' +
    '<p style="font-size:13px;">' + esc(msg) + '</p>' +
    '<button class="btn soft" style="margin-top:14px;" onclick="location.reload()">重新加载</button>' +
    '</div></div>'
}

async function boot() {
  // 算法自检：不通过就暴露在控制台，绝不静默
  try {
    const t = FSRS.selfTest()
    if (!t.ok) console.error('[FSRS] 自检未通过：', t.problems)
    else console.info('[FSRS] 自检通过（8 项不变量）')
  } catch (e) {
    console.error('[FSRS] 自检异常', e)
  }

  S.loadLocal()
  V.loadJob()

  try {
    const session = await AUTH.getSession()
    if (session) {
      await onLoggedIn(session)
    } else {
      renderAuth()
    }
  } catch (e) {
    // 未登录（或本地预览无 Origin）时走登录页，而不是直接崩掉
    renderAuth()
  }

  AUTH.onAuthChange((event, session) => {
    if (event === 'SIGNED_OUT' && signedIn) onSignedOut()
    if (event === 'SIGNED_IN' && !signedIn && session) onLoggedIn(session)
  })

  /* 数据同步完成时主动重绘。为什么必须由数据层发起：
     同步是后台异步的，用户不会等在原地 —— 他可能已经切到统计页了。
     没有这个回调，他就得"来回切页或强刷"才能看到刚拉回来的数据（任务书 01 验收项）。
     唯一例外是学习页且已经开始作答：那时整页重绘会把当前题目状态冲掉。 */
  S.onSyncDone(() => {
    if (!signedIn) return
    if (current === 'study' && V.studyInProgress()) return
    renderMain()
  })

  // 回到前台时补一次同步，保证跨设备最新
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !signedIn) return
    if (S.state.settings.theme) applyTheme(S.state.settings.theme)
    if (!navigator.onLine) return
    S.flushPending()
      .then(() => S.syncPull())
      .then(() => render())
      .catch(() => {})
  })

  window.addEventListener('online', () => {
    if (!signedIn) return
    S.flushPending().then(() => S.syncPull()).then(() => render()).catch(() => {})
  })
}

// 注册离线壳：断网也能打开并复习（数据同步等联网自动补）
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) &&
    !/[?&]nosw=1/.test(location.search)) {
  // 带上版本号注册：CDN 会按 URL 缓存 sw.js，不带版本号会一直拿到旧脚本
  const SW_V = new URL(import.meta.url).searchParams.get('v') || '1'
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js?v=' + SW_V).then((reg) => {
      // 开着页面时后台装好了新版本 → 主动提示一次（否则用户会一直用旧版而不知道）
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing
        if (!sw) return
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('有新版本可用：我的 → 检查更新')
          }
        })
      })
    }).catch(() => { /* 离线壳失败不影响主流程 */ })
  })
}

window.addEventListener('error', (e) => {
  console.error('[app] 未捕获错误', e.message)
})

boot().catch((e) => {
  console.error(e)
  bootFail((e && e.message) || '未知错误')
})
