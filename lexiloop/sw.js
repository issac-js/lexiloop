/**
 * sw.js — 离线壳（Service Worker）
 *
 * 目标：断网/弱网时应用仍能打开并复习（数据同步延后），与「本地优先」的架构对齐。
 * 策略：
 *   - 页面导航：网络优先，失败回落到缓存的 index.html
 *   - 同源静态资源（js/css/图标/字体）：缓存优先 + 后台更新（stale-while-revalidate）
 *   - 云服务（/.cloud/**）与 CDN 一律不缓存，直接走网络
 * 发版时改 CACHE 名即可清掉旧缓存。
 *
 * 2026-10-04：云 SDK 已从 CDN 改为同源内置（vendor/workbuddy-cloud-sdk.js），
 * 因此把它加进离线壳 —— 断网时连云客户端初始化都能起来（数据同步延后）。
 * 同时把跨域豁免从「CDN 一律不碰」收窄为「非同源一律不碰」，语义更准确。
 */
const CACHE = 'lexiloop-shell-v130'
const SHELL = [
  './',
  './index.html',
  './styles.css?v=130',
  './manifest.webmanifest',
  './icon.svg',
  './vendor/workbuddy-cloud-sdk.js',
  './js/focus.js?v=130',
  './js/focus-core.js?v=130',
  './js/transfer.js?v=130',
]

// 安装时**不**自动 skipWaiting：旧壳还在给当前页面供资源时被新壳顶替，
// 会把正在加载的模块请求打断，表现就是"一直卡在正在启动"。
// 由页面在用户点「检查更新」时发 SKIP_WAITING 消息，我们再接管。
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}))
})

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch (err) {
    return
  }
  // 跨域（模型直连等）与云服务数据面都不插手；同源静态资源走下面的缓存策略
  if (url.origin !== self.location.origin) return
  if (url.pathname.indexOf('/.cloud/') === 0) return

  // 导航请求：断网时给缓存的首页，而不是浏览器的离线页
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() =>
        caches.match('./index.html').then((hit) => hit || caches.match('./'))
      )
    )
    return
  }

  // 静态资源：命中缓存先返回，同时后台拉新版写回缓存
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
          }
          return res
        })
        .catch(() => hit)
      return hit || fresh
    })
  )
})
