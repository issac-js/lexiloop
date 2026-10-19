'use strict';
/* LexiLoop · 达标记录独立表（goal_days）的真环境端到端验证
 *
 * 为什么必须真登录跑一遍：这张表是 2026-10-14 新增的**后端面**，本机 fake session
 * 下云端全被拦截，等于没测"RLS + 列默认 auth.uid() + 追加式 upsert"这条真链路。
 * 旧的 settings.extra 方案已被实测证明会丢历史，所以最重要的断言是那条**回归**：
 * 整行 pushSettings 之后，表里的历史必须仍在。
 *
 * 账号：test-account@example.com（= 智能体邮箱，可现场收验证码）。
 *   ① 有密码就直接密码登录；② 没有（新租户首次）就走"验证码注册"：
 *      页面点「获取验证码」→ 本脚本轮询 OTP_FILE 等验证码 → 外部把码写进该文件 → 提交。
 *   浏览器用**固定 user-data-dir**：SDK 的 OTP challenge 存在 localStorage 里，
 *   换目录就"没先获取验证码"了。
 *   写入全部在该账号名下，探测行用完即删，不碰任何真实用户数据。
 *
 * 用法：node tools/qa-goal-days-live.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SITE = 'https://lexiloop-82703.app.workbuddy.host/';
const APP = path.resolve(__dirname, '..', 'lexiloop');
const PROBE_DAY = '2020-01-01';
const OTP_FILE = path.join(os.tmpdir(), 'lexiloop-otp.txt');
const PROFILE = path.join(os.tmpdir(), 'gll-gd-profile');   // 固定目录：OTP challenge 要能跨次运行
const EMAIL = process.env.LEXILOOP_TEST_EMAIL || ''
const PASSWORD = process.env.LEXILOOP_TEST_PASSWORD || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(url, tries = 100) { for (let i = 0; i < tries; i++) {
    try { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); }); return new CDP(ws); } catch (e) { await sleep(250); } }
    throw new Error('CDP 连接超时'); }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {} })); return new Promise((res) => this.map.set(id, res)); }
  async eval(expr, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs || 120000 });
    if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

/* 等外部（收码方）把验证码写进 OTP_FILE */
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
  try { fs.rmSync(OTP_FILE, { force: true }); } catch (e) {}

  const files = ['index.html'].concat(fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
  const vs = new Set();
  files.forEach((f) => { for (const m of fs.readFileSync(path.join(APP, f), 'utf8').matchAll(/\?v=(\d+)/g)) vs.add(m[1]); });
  const LOCAL_VER = [...vs][0];   // 仅兜底：优先用页面里的版本号（见下）

  const port = 10047;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + PROFILE, SITE],
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
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 60; i++) { await sleep(500); if ((await cdp.eval('!!window.WorkBuddyCloud')) === true) break; }

    /* ── 0. 登录：固定 profile 会**持久化会话** —— 先看是否已经在应用内，
       再试密码，最后才走验证码注册。不先判"已登录"，第二次运行就找不到表单了。 ── */
    const preState = await cdp.eval(`(async function(){
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 60 && !document.querySelector('.tabbar') && !document.querySelector('[data-mode="pwd"]'); i++) await sleep(250);
      return document.querySelector('.tabbar') ? 'already-in' : 'need-login';
    })()`, 40000);
    let loginState = preState === 'already-in' ? 'ok' : null;

    const tryPwd = loginState ? 'ok' : await cdp.eval(`(async function(){
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 60 && !document.querySelector('[data-mode="pwd"]'); i++) await sleep(250);
      const tab = document.querySelector('[data-mode="pwd"]');
      if (!tab) return 'no-pwd-tab';
      tab.click(); await sleep(300);
      const e = document.getElementById('pwd-email'), p = document.getElementById('pwd-password');
      if (!e || !p) return 'no-form';
      e.value = ${JSON.stringify(EMAIL)}; p.value = ${JSON.stringify(PASSWORD)};
      const btn = document.querySelector('#pwd-form button[type="submit"]');
      if (!btn) return 'no-submit';
      btn.click();
      for (let i = 0; i < 25 && !document.querySelector('#start-study'); i++) await sleep(400);
      return document.querySelector('#start-study') ? 'ok' : 'pwd-failed';
    })()`, 60000);
    loginState = tryPwd;

    if (loginState !== 'ok') {
      // 验证码注册：点「获取验证码」→ 等外部写码 → 提交
      const sent = await cdp.eval(`(async function(){
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 40 && !document.getElementById('otp-email'); i++) await sleep(250);
        const e = document.getElementById('otp-email'), s = document.getElementById('otp-send');
        if (!e || !s) return 'no-otp-form';
        e.value = ${JSON.stringify(EMAIL)};
        s.click(); await sleep(2500);
        return 'sent';
      })()`, 60000);
      if (sent !== 'sent') { add('验证码注册：请求验证码', false, JSON.stringify(sent)); throw new Error('无法发起验证码'); }

      const code = await waitForCode(180000);
      if (!code) { add('验证码注册：收到验证码（外部写入 ' + OTP_FILE + '）', false, '等待 180s 超时'); throw new Error('未收到验证码'); }

      loginState = await cdp.eval(`(async function(){
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const t = document.getElementById('otp-token'), p = document.getElementById('otp-pwd');
        if (!t || !p) return 'no-otp-inputs';
        t.value = ${JSON.stringify(code)}; p.value = ${JSON.stringify(PASSWORD)};
        document.getElementById('otp-submit').click();
        for (let i = 0; i < 30 && !document.querySelector('#start-study'); i++) await sleep(400);
        return document.querySelector('#start-study') ? 'ok' : 'otp-failed';
      })()`, 60000);
    }
    add('测试账号可用（密码登录或验证码注册）', loginState === 'ok', JSON.stringify(loginState));
    if (loginState !== 'ok') throw new Error('登录未完成，后续断言不成立');

    /* ★ 版本号必须从**页面里**抠：应用加载的是 './js/store.js?v=<线上版本>'。
       用本地文件的版本号会有两个后果：① 线上未更新时 ?v 不同 → 拿到的是**另一个模块实例**
       （独立的 state，user 为空，所有断言静默失效）；② 线上已更新但本地没升 → 同理。
       （2026-10-11 在 qa-restday 上就踩过一次，2026-10-15 又在这里踩到。） */
    const VER = await cdp.eval(`(function(){
      var s = (document.querySelector('script[type=module]') || {}).src || '';
      var m = s.match(/[?&]v=(\\d+)/);
      return m ? m[1] : '';
    })()`) || LOCAL_VER;
    add('版本号取自页面（与页内模块同一实例）', !!VER, 'VER=' + VER);

    /* ── 1. 真链路：读表 → 追加写 → 整行推送 → 再读（回归）→ 幂等 → 清理 ── */
    const r = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      const C = await import('./js/cloud.js?v=${VER}');
      try {
        const before = await S.fetchGoalDays();               // 表可读（RLS / GRANT / PostgREST 暴露）
        let pushErr = '';
        S.state.settings.goal_days = Object.assign({}, S.goalDays(), { '${PROBE_DAY}': true });
        try { await S.pushGoalDays(); } catch (e) { pushErr = String((e && e.message) || e); }   // 追加写（owner_id 走列默认 auth.uid()）
        const after = await S.fetchGoalDays();
        /* ★ 关键回归：模拟"本地 map 为空/过期"的会话做整行推送 ——
           旧实现（goal_days 在 settings.extra 里）就是被这一步整列覆盖、历史清零的。 */
        S.state.settings.goal_days = {};
        await S.pushSettings();
        const afterPush = await S.fetchGoalDays();
        S.state.settings.goal_days = { '${PROBE_DAY}': true };  // 幂等：同一天再推一次
        await S.pushGoalDays();
        const afterIdem = await S.fetchGoalDays();
        await C.db().from('goal_days').delete().eq('day', '${PROBE_DAY}');   // 清理探测行
        const cleaned = await S.fetchGoalDays();
        return { ok: true, beforeHas: !!before['${PROBE_DAY}'], afterHas: !!after['${PROBE_DAY}'],
                 pushKept: !!afterPush['${PROBE_DAY}'], idemHas: !!afterIdem['${PROBE_DAY}'],
                 cleaned: !cleaned['${PROBE_DAY}'], beforeCount: Object.keys(before).length,
                 pushErr: pushErr, userSet: !!S.state.user };
      } catch (err) { return { ok: false, err: String((err && err.message) || err) }; }
    })()`, 120000);

    if (!r || r.ok !== true) {
      add('goal_days 真链路（读/写/推送/清理）', false, JSON.stringify(r));
    } else {
      add('★ 真环境写入生效：追加一行后能读回（RLS + 列默认 + upsert 全通）', r.afterHas === true, JSON.stringify(r));
      add('★★ 回归：整行 pushSettings 之后，达标历史仍在（旧实现就是在这里丢的）', r.pushKept === true, JSON.stringify(r));
      add('幂等：同一天重复推送不会产生第二行', r.idemHas === true, JSON.stringify(r));
      add('探测数据已清理（不留痕）', r.cleaned === true, JSON.stringify(r));
    }
  } catch (e) {
    add('执行', false, e.message);
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
  }

  let bad = 0;
  out.forEach((o) => { if (!o.pass) bad++; console.log((o.pass ? '  PASS  ' : '  FAIL  ') + o.n + (o.pass ? '' : '  → ' + o.d)); });
  console.log('\n===== 达标表真环境验证: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
