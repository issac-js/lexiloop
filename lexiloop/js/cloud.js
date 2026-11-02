/**
 * cloud.js — 云服务接入层
 *
 * 统一收口三件事：初始化 SDK、邮箱认证、数据库读写、模型调用。
 * 其他模块一律通过本文件访问云端，不得自行 fetch '/.cloud/**'，也不得引入第二个客户端。
 */
import { CLOUD_CONFIG } from './config.js?v=124'

let cloud = null

export function getCloud() {
  if (cloud) return cloud
  const factory = window.WorkBuddyCloud && window.WorkBuddyCloud.createWorkBuddyCloud
  if (typeof factory !== 'function') {
    throw new Error('云 SDK 未能加载，请检查网络后刷新页面')
  }
  cloud = factory({
    endpoint: CLOUD_CONFIG.endpoint,
    publishableKey: CLOUD_CONFIG.publishableKey,
  })
  return cloud
}

export function db() {
  return getCloud().database
}

/* ────────────────────────────── 认证 ────────────────────────────── */

let pendingEmailOtp = null
let lastAccountEmail = null

/** 最近一次登录使用的邮箱（用于「我的」页显示当前账号） */
export function lastEmail() {
  return lastAccountEmail
}

export function clearLastEmail() {
  lastAccountEmail = null
}

/** 发送邮箱验证码（绑定到「获取验证码」按钮） */
export async function sendEmailCode(email) {
  const res = await getCloud().auth.sendOtp({ email })
  if (res.error) throw res.error
  pendingEmailOtp = {
    email,
    verificationId: res.data.verificationId,
    isExistingUser: res.data.isExistingUser,
  }
  return pendingEmailOtp
}

/**
 * 提交验证码登录 / 注册（绑定到「登录」按钮，绝不在此重新发送验证码）
 * 新账号必须提供密码。
 */
export async function submitEmailOtp(email, token, password) {
  const pending = pendingEmailOtp
  if (!pending || pending.email !== email) {
    throw new Error('请先为当前邮箱获取验证码')
  }
  const res = await getCloud().auth.verifyOtp({
    email: pending.email,
    verificationId: pending.verificationId,
    isExistingUser: pending.isExistingUser,
    token,
    password: pending.isExistingUser ? undefined : password,
  })
  if (res.error) throw res.error
  pendingEmailOtp = null
  lastAccountEmail = email
  return res.data
}

/** 该邮箱是否已注册（仅用于决定是否展示密码输入框，不得直接提示用户） */
export function pendingNeedsPassword() {
  return pendingEmailOtp ? !pendingEmailOtp.isExistingUser : false
}

export function hasPendingOtp(email) {
  return !!pendingEmailOtp && pendingEmailOtp.email === email
}

export async function signInWithPassword(email, password) {
  const res = await getCloud().auth.signInWithPassword({ email, password })
  if (res.error) throw res.error
  lastAccountEmail = email
  return res.data
}

export async function resetPasswordForEmail(email) {
  const res = await getCloud().auth.resetPasswordForEmail(email)
  if (res.error) throw res.error
  return res.data
}

export async function signOut() {
  pendingEmailOtp = null
  await getCloud().auth.signOut()
}

export async function getSession() {
  const res = await getCloud().auth.getSession()
  if (res.error) throw res.error
  return res.data
}

export function onAuthChange(cb) {
  return getCloud().auth.onAuthStateChange(cb)
}

/** 把认证错误翻译成人话，按稳定 code 分支，不依赖文案 */
export function authErrorMessage(err) {
  const kind = err && err.kind
  if (kind === 'network' || kind === 'backend-unavailable') return '网络异常，请稍后重试'
  const code = (err && (err.code || err.error_code)) || ''
  if (code === 'invalid_grant' || kind === 'unauthenticated') return '验证码或账号密码不正确'
  return (err && err.message) || '操作失败，请重试'
}

/* ─────────────────────── 自定义 API（自带密钥） ───────────────────────
   密钥只存在这台设备的 localStorage 里，永远不会写进我们的数据库。
   注意：浏览器里没有绝对安全的地方放长期密钥，请用一把可随时吊销的专用 key。
   已实测 DeepSeek 开放 CORS（OPTIONS 返回 allow-origin / allow-methods / allow-headers），
   因此可以从前端直连，无需任何中转服务器。 */

const CUSTOM_KEY = 'lexiloop.customapi.v1'

export function getCustomApi() {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw)
    if (!cfg || !cfg.baseUrl || !cfg.apiKey) return null
    return cfg
  } catch (e) {
    return null
  }
}

export function setCustomApi(cfg) {
  try {
    if (!cfg || !cfg.baseUrl || !cfg.apiKey) localStorage.removeItem(CUSTOM_KEY)
    else localStorage.setItem(CUSTOM_KEY, JSON.stringify(cfg))
  } catch (e) {
    /* 隐私模式下可能写不进去，忽略 */
  }
}

export function customApiConfigured() {
  return !!getCustomApi()
}

/** 把用户填的 Base URL 规范成可请求的地址（顺手修掉最常见的几种写法错误） */
export function normalizeBaseUrl(input) {
  let s = String(input || '').trim()
  if (!s) return ''
  s = s.replace(/\s+/g, '')
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s      // 忘了写协议
  s = s.replace(/\/+$/, '')
  // 只填了域名根（如 https://api.deepseek.com）也能用，补上 /v1
  if (/^https:\/\/api\.deepseek\.com$/i.test(s)) s += '/v1'
  if (/^https:\/\/api\.openai\.com$/i.test(s)) s += '/v1'
  return s
}

function endpointOf(baseUrl) {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return ''
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions'
}

/** 收集 SSE 流，拼出完整回复 */
async function streamOpenAICompatible(url, headers, body, o) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: o.signal,
    })
  } catch (e) {
    throw new Error('连不上自定义 API（网络或跨域受限）：' + ((e && e.message) || ''))
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 300)
    } catch (e) {
      /* ignore */
    }
    throw new Error('自定义 API 返回 ' + res.status + (detail ? '：' + detail : ''))
  }
  if (!res.body || !res.body.getReader) {
    const text = await res.text()
    return text
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let out = ''

  for (;;) {
    const step = await reader.read()
    if (step.done) break
    buffer += decoder.decode(step.value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line || line.charAt(0) === ':') continue
      if (line.indexOf('data:') !== 0) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const chunk = JSON.parse(payload)
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta
        if (delta && delta.content) {
          out += delta.content
          if (o.onDelta) o.onDelta(delta.content)
        }
      } catch (e) {
        /* 半包或非 JSON 帧，跳过 */
      }
    }
  }
  if (!out) throw new Error('自定义 API 没有返回内容，请检查模型名是否正确')
  return out
}

async function chatViaCustom(cfg, o) {
  const body = {
    model: cfg.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: o.user },
    ],
    stream: true,
  }
  if (o.json) body.response_format = { type: 'json_object' }
  if (typeof o.temperature === 'number') body.temperature = o.temperature
  if (typeof o.maxTokens === 'number') body.max_tokens = o.maxTokens

  return streamOpenAICompatible(
    endpointOf(cfg.baseUrl),
    { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body,
    o
  )
}

/** 测试连通性：发一句最短的请求，返回 { text, endpoint } */
export async function testCustomApi(cfg) {
  const c = cfg || getCustomApi()
  if (!c) throw new Error('请先填写 Base URL 和 API Key')
  const endpoint = endpointOf(c.baseUrl)
  if (!endpoint) throw new Error('Base URL 不能为空')
  let text = ''
  try {
    text = await streamOpenAICompatible(
      endpoint,
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
      {
        model: c.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a concise assistant.' },
          { role: 'user', content: 'Reply with exactly: OK' },
        ],
        stream: true,
        max_tokens: 20,
      },
      {}
    )
  } catch (e) {
    // 把实际请求的地址带出来，用户一眼就能看出 Base URL 填没填对
    const msg = (e && e.message) || ''
    throw new Error('实际请求：' + endpoint + '　｜　' + msg)
  }
  return { text: text.trim(), endpoint }
}

/* ────────────────────────────── 模型 ────────────────────────────── */

let cachedModel = null

/**
 * 用户没显式指定模型时的挑选顺序。
 * 实测（同一提示词、同一个词）：
 *   deepseek-v4.1-flash  4.0s   662 输出 token，5 条搭配  ← 最快，但**容易被限流**
 *   hunyuan-chat        20.6s   610 输出 token，5 条搭配
 *   hy3 / glm-5.3-flash 11-13s  1400 token 全是推理，正文为空 → 直接失败
 * 2026-09-27 实测：一批 265 个词打过去之后，deepseek-v4.1-flash 单独被限流，
 * 而 deepseek-v4-flash / v4-pro / hunyuan-chat / hy3 / glm-5.3 全部正常。
 * 所以默认选**稳定**的 v4-flash（与 v4.1 同族），把 v4.1 放在备选位。
 */
export const PREFERRED_MODELS = [
  'deepseek-v4-flash',
  'hunyuan-chat',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
]

/** 换一个还没试过的推荐模型（用于被限流时自动兜底） */
export async function pickModelAfter(excludeIds) {
  const skip = new Set(excludeIds || [])
  const all = await listModels()
  for (const id of PREFERRED_MODELS) {
    if (skip.has(id)) continue
    const hit = all.find((m) => m.id === id)
    if (hit && hit.disabled !== true && hit.enabled !== false) return hit
  }
  return null
}

/** 全部可选模型（已过滤掉被禁用的） */
export async function listModels() {
  const list = await getCloud().llm.models.list()
  if (!Array.isArray(list)) return []
  return list.filter((m) => m.disabled !== true && m.enabled !== false)
}

/** 「自动」实际会落到哪个模型 */
export async function resolveAutoModel() {
  const all = await listModels()
  for (const id of PREFERRED_MODELS) {
    const hit = all.find((m) => m.id === id)
    if (hit) return hit
  }
  return all[0] || null
}

/** 默认模型：优先用户指定，否则按推荐顺序挑 */
export async function pickModel(preferredId) {
  if (preferredId) {
    const all = await listModels()
    const hit = all.find((m) => m.id === preferredId)
    if (hit) return hit
  }
  if (cachedModel) return cachedModel
  const auto = await resolveAutoModel()
  if (!auto) throw new Error('当前没有可用的大模型')
  cachedModel = auto
  return cachedModel
}

/**
 * 调用大模型并收集完整回复（接口只支持流式，非流式会被拒）。
 * @param {{system:string, user:string, json?:boolean, temperature?:number, model?:string,
 *          maxTokens?:number, signal?:AbortSignal, onDelta?:Function}} o
 * @returns {Promise<string>}
 */
export async function chatText(o) {
  // 配了自带密钥就走自带通道，否则用云端免密钥通道
  const custom = o.forceCloud ? null : getCustomApi()
  if (custom) return chatViaCustom(custom, o)

  const model = await pickModel(o.model)
  const params = {
    model: model.id,
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: o.user },
    ],
    stream: true,
  }
  if (o.json) params.response_format = { type: 'json_object' }
  if (typeof o.temperature === 'number') params.temperature = o.temperature
  if (typeof o.maxTokens === 'number') params.max_tokens = o.maxTokens
  if (o.signal) params.signal = o.signal

  let out = ''
  for await (const chunk of getCloud().llm.chat.completions.create(params)) {
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta
    if (delta && delta.content) {
      out += delta.content
      if (o.onDelta) o.onDelta(delta.content)
    }
  }
  return out
}

export function llmErrorMessage(err) {
  const code = (err && err.error && err.error.code) || ''
  const msg = (err && err.error && err.error.message) || (err && err.message) || ''
  if (code.indexOf('auth_') === 0) return '云服务凭证校验失败，请刷新页面后重试'
  if (code.indexOf('quota_') === 0) return '模型额度不足或触发限流，请稍后重试'
  if (code.indexOf('request_') === 0) return '请求参数有误：' + msg
  if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return '模型服务暂时不可用，请稍后重试'
  return msg || '模型调用失败'
}
