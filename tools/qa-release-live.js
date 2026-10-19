'use strict';
/* LexiLoop · 正式发布验收（真实线上环境，v108 / 0bfc0f0）
 *
 * 背景：docs/DEPLOYMENT.md 要求"页面打开和资源一致不代表云端权限、AI 或学习流程
 * 已通过"，所以本脚本在 verify_deployed.py（静态资源哈希）之外补三项真链路：
 *   ① 登录（持久会话优先，失败走验证码；OTP 由外部收码后写入 OTP_FILE）
 *   ② 云端读链路（用户鉴权 / 词卡拉取 / settings / goal_days 新表 / buildQueue）
 *   ③ 模型通道一次最小调用（json 模式，30 token，失败即报错不猜）
 *
 * 数据纪律：**只读**。不写词卡、不写复习日志、不清任何数据；唯一的"写"是登录
 * 会话本身。必须只用隔离测试账号（LEXILOOP_TEST_EMAIL），与真实用户数据无关。
 *
 * 用法：LEXILOOP_TEST_EMAIL=隔离账号@example.com node tools/qa-release-live.js
 *   OTP 交接：脚本点「获取验证码」后轮询 OTP_FILE；外部（收码方）把 6 位码写进去。
 *   固定 user-data-dir：SDK 的 OTP challenge 在 localStorage，换目录会丢。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ─── 可配置项：全部走环境变量，不写死凭据、用户数据或本机私密路径 ───
 * 必填：LEXILOOP_TEST_EMAIL（隔离测试账号邮箱，不填直接退出）
 * 可选：LEXILOOP_TEST_PASSWORD（仅"新账号首次注册"时设密码用）
 *       LEXILOOP_SITE / LEXILOOP_EDGE_PATH / LEXILOOP_QA_PROFILE /
 *       LEXILOOP_EXPECT_VER / LEXILOOP_EXPECT_SHA
 * 详见 tools/README-live-checks.md */
const SITE = process.env.LEXILOOP_SITE || 'https://lexiloop-82703.app.workbuddy.host/';
const EDGE = process.env.LEXILOOP_EDGE_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = process.env.LEXILOOP_QA_PROFILE || path.join(os.tmpdir(), 'gll-gd-profile');
const EMAIL = process.env.LEXILOOP_TEST_EMAIL || '';
const TEST_PASSWORD = process.env.LEXILOOP_TEST_PASSWORD || '';
const OTP_FILE = process.env.LEXILOOP_OTP_FILE || path.join(os.tmpdir(), 'lexiloop-otp.txt');
const EXPECT_VER = process.env.LEXILOOP_EXPECT_VER || '108';
const EXPECT_SHA = process.env.LEXILOOP_EXPECT_SHA || '';
const RESULT_FILE = path.resolve(__dirname, '..', '.workbuddy',
  'release-acceptance-' + new Date().toISOString().slice(0, 10) + '.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };
const log = (s) => console.log('[qa-release] ' + s);

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(url, tries = 100) { for (let i = 0; i < tries; i++) {
    try { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); }); return new CDP(ws); } catch (e) { await sleep(250); } }
    throw new Error('CDP 连接超时'); }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); return new Promise((res) => this.map.set(id, res)); }
  async eval(expr, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs || 120000 });
    if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function waitForCode(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fs.existsSync(OTP_FILE)) {
        const m = /(\d{6})/.exec(fs.readFileSync(OTP_FILE, 'utf8'));
        if (m) return m[1];
      }
    } catch (e) { /* 文件正在写，重试 */ }
    await sleep(1500);
  }
  return null;
}

(async () => {
  /* 凭据只从环境变量来：缺邮箱就明确退出，不猜、不内置。 */
  if (!EMAIL) {
    console.error('缺少 LEXILOOP_TEST_EMAIL：请设置隔离测试账号邮箱后再运行。\n' +
      '  例：LEXILOOP_TEST_EMAIL=隔离账号@example.com node tools/qa-release-live.js\n' +
      '  说明见 tools/README-live-checks.md');
    process.exit(2);
  }
  try { fs.rmSync(OTP_FILE, { force: true }); } catch (e) {}

  const port = 10052;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + PROFILE, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  try {
    let pg = null;
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (pg) break; } catch (e) {}
    }
    if (!pg) throw new Error('无法连接调试页');
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 导航前注入错误收集器：window.onerror / unhandledrejection 都算启动失败证据
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source:
      'window.__errs=[];' +
      'window.addEventListener("error",function(e){window.__errs.push("error: "+(e.message||"")+" @ "+((e.filename||"").split("/").pop())+":"+(e.lineno||0));});' +
      'window.addEventListener("unhandledrejection",function(e){var r=e.reason;window.__errs.push("unhandledrejection: "+String(r&&r.message||r));});' });
    await cdp.send('Page.navigate', { url: SITE });
    log('navigated to ' + SITE);

    for (let i = 0; i < 60; i++) { await sleep(500); if ((await cdp.eval('!!window.WorkBuddyCloud')) === true) break; }
    add('云端 SDK 就绪（window.WorkBuddyCloud）', (await cdp.eval('!!window.WorkBuddyCloud')) === true, 'SDK 未出现');

    /* ── 1. 启动无错 + 版本 + release.json + SW ── */
    const boot = await cdp.eval(`(async function(){
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 80 && !document.querySelector('.tabbar') && !document.querySelector('#otp-email') && !document.querySelector('[data-mode="pwd"]'); i++) await sleep(250);
      var s = (document.querySelector('script[type="module"]') || {}).src || '';
      var m = s.match(/[?&]v=(\\d+)/);
      var rel = null, relErr = '';
      try {
        var r = await fetch('release.json?boot=' + Date.now(), { cache: 'no-store' });
        rel = r.ok ? await r.json() : null;
        if (!r.ok) relErr = 'HTTP ' + r.status;
      } catch (e) { relErr = String(e && e.message || e); }
      var swState = 'none';
      try {
        var reg = await navigator.serviceWorker.getRegistration();
        if (reg && (reg.active || reg.installing || reg.waiting)) swState = reg.active ? 'active' : 'pending';
      } catch (e) { swState = 'err:' + (e && e.message); }
      return { ver: m ? m[1] : '', errs: window.__errs || [], rel: rel, relErr: relErr, sw: swState,
               inApp: !!document.querySelector('.tabbar') };
    })()`, 60000);
    add('页面加载无未捕获错误', boot && (!boot.errs || boot.errs.length === 0), JSON.stringify(boot && boot.errs));
    add('页内模块版本 = ' + EXPECT_VER, boot && boot.ver === EXPECT_VER, 'ver=' + (boot && boot.ver));
    const shaOk = EXPECT_SHA
      ? !!(boot && boot.rel && boot.rel.source_sha === EXPECT_SHA)
      : !!(boot && boot.rel && boot.rel.source_sha);
    add('release.json 线上可读' + (EXPECT_SHA ? '且 source_sha 匹配 ' + EXPECT_SHA : '（未设 LEXILOOP_EXPECT_SHA，只验可读有值）'),
      shaOk, boot && (boot.relErr || JSON.stringify(boot.rel && boot.rel.source_sha)));
    add('Service Worker 已注册', !!(boot && boot.sw && boot.sw !== 'none' && boot.sw.indexOf('err') !== 0), 'sw=' + (boot && boot.sw));

    const VER = (boot && boot.ver) || EXPECT_VER;

    /* ── 2. 登录：持久会话优先，否则验证码 ── */
    let loginState = boot && boot.inApp ? 'ok' : null;
    if (loginState !== 'ok') {
      const sent = await cdp.eval(`(async function(){
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 40 && !document.getElementById('otp-email'); i++) await sleep(250);
        var e = document.getElementById('otp-email'), s = document.getElementById('otp-send');
        if (!e || !s) return 'no-otp-form';
        e.value = ${JSON.stringify(EMAIL)};
        s.click(); await sleep(2500);
        return 'sent';
      })()`, 60000);
      if (sent !== 'sent') { add('登录：请求验证码', false, JSON.stringify(sent)); throw new Error('无法发起验证码'); }
      log('OTP requested, waiting for code file...');
      const code = await waitForCode(240000);
      if (!code) { add('登录：收到验证码（外部写入 ' + OTP_FILE + '）', false, '等待 240s 超时'); throw new Error('未收到验证码'); }
      log('OTP code received');

      /* 新账号首次注册才需要设密码。密码只从环境变量取，绝不内置到源码里；
         没给就不猜，直接停下来告诉使用者去设置。 */
      const pwdNeeded = await cdp.eval(`(function(){
        var pwf = document.getElementById('otp-pwd-field');
        return !!(pwf && !pwf.classList.contains('hidden'));
      })()`, 30000);
      if (pwdNeeded && !TEST_PASSWORD) {
        add('登录：新账号注册需要设密码', false, '该邮箱尚未注册，且未设置 LEXILOOP_TEST_PASSWORD');
        throw new Error('该邮箱尚未注册：请设置 LEXILOOP_TEST_PASSWORD 后重跑（密码只从环境变量读取，不写进源码）');
      }

      loginState = await cdp.eval(`(async function(){
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        var t = document.getElementById('otp-token');
        if (!t) return 'no-otp-inputs';
        t.value = __CODE_JSON__;
        var pw = document.getElementById('otp-pwd');
        var pwf = document.getElementById('otp-pwd-field');
        if (pw && pwf && !pwf.classList.contains('hidden')) pw.value = __PWD_JSON__;
        document.getElementById('otp-submit').click();
        for (let i = 0; i < 40 && !document.querySelector('.tabbar'); i++) await sleep(400);
        return document.querySelector('.tabbar') ? 'ok' : 'otp-failed';
      })()`.replace('__CODE_JSON__', () => JSON.stringify(code))
        .replace('__PWD_JSON__', () => JSON.stringify(TEST_PASSWORD)), 90000);
    }
    add('登录成功（持久会话或验证码）', loginState === 'ok', JSON.stringify(loginState));
    if (loginState !== 'ok') throw new Error('登录未完成，后续断言不成立');

    /* ── 3. 云端读链路（只读） ── */
    for (let i = 0; i < 60; i++) {
      const ph = await cdp.eval(`(async function(){ const S = await import('./js/store.js?v=${VER}'); return S.state.load.phase; })()`);
      if (ph === 'ready' || ph === 'error') break;
      await sleep(1000);
    }
    const r = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      var o = {};
      o.user = S.state.user ? { id: String(S.state.user.id).slice(0, 8) + '…', email: S.state.accountEmail } : null;
      o.load = { phase: S.state.load.phase, error: S.state.load.error, hydrated: S.state.load.hydrated };
      o.words = S.state.words.length;
      o.cards = S.state.cards.length;
      o.daily = S.state.daily.length;
      o.settings = { daily_new: S.state.settings.daily_new, rest_weekday: S.state.settings.rest_weekday, llm_model: S.state.settings.llm_model || null };
      try { var g = await S.fetchGoalDays(); o.goalDays = Object.keys(g || {}).length; } catch (e) { o.goalDaysErr = String(e && e.message || e); }
      try { o.queue = S.buildQueue().length; } catch (e) { o.queueErr = String(e && e.message || e); }
      return o;
    })()`, 120000);
    if (r && r.__err) throw new Error('读链路评估异常: ' + r.__err);
    add('云端鉴权生效（state.user 非空）', !!(r && r.user), JSON.stringify(r && r.user));
    add('数据同步完成（load.phase = ready）', !!(r && r.load && r.load.phase === 'ready'), JSON.stringify(r && r.load));
    add('词条已拉取（> 0）', !!(r && r.words > 0), 'words=' + (r && r.words));
    add('卡片已拉取（> 0）', !!(r && r.cards > 0), 'cards=' + (r && r.cards));
    add('settings 可读（daily_new 为数字）', !!(r && r.settings && typeof r.settings.daily_new === 'number'), JSON.stringify(r && r.settings));
    add('goal_days 表可读', !!(r && typeof r.goalDays === 'number' && !r.goalDaysErr), 'goalDaysErr=' + (r && r.goalDaysErr));
    add('buildQueue 可用（学习页数据链）', !!(r && typeof r.queue === 'number' && !r.queueErr), 'queueErr=' + (r && r.queueErr));

    /* ── 4. 模型通道：一次最小调用 ── */
    log('model channel: one minimal call...');
    const m = await cdp.eval(`(async function(){
      const C = await import('./js/cloud.js?v=${VER}');
      var t0 = Date.now();
      try {
        var raw = await C.chatText({ system: '你是严格的 JSON 输出器，只输出 JSON。', user: '请只返回 {"ok":true} 这个 JSON 对象。', json: true, temperature: 0, maxTokens: 30 });
        var parsed = null; try { parsed = JSON.parse(raw); } catch (e) {}
        return { ok: true, ms: Date.now() - t0, raw: String(raw).slice(0, 120), parsedOk: !!(parsed && parsed.ok === true) };
      } catch (e) { return { ok: false, ms: Date.now() - t0, err: String(e && e.message || e) }; }
    })()`, 120000);
    if (m && m.__err) m = { ok: false, err: m.__err };
    add('模型通道一次最小调用成功且返回合法 JSON', !!(m && m.ok && m.parsedOk), JSON.stringify(m));

    log('ALL DONE');
  } catch (e) {
    add('脚本执行未中断', false, String(e && e.stack || e));
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
    const summary = { site: SITE, expect: { ver: EXPECT_VER, sha: EXPECT_SHA }, at: new Date().toISOString(), results: out };
    try { fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true }); fs.writeFileSync(RESULT_FILE, JSON.stringify(summary, null, 1) + '\n'); } catch (e) {}
    console.log('RESULT_JSON=' + JSON.stringify(summary));
  }
  process.exit(0);
})();
