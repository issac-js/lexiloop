'use strict';
/* LexiLoop · 测试隔离与幂等质检（方案 P0-2.1 测试模式 / P0-2.3 一次提交一次调度）
 *
 * 这一批改的是**写入路径**，而写入路径在隔离测试构建里发不出请求
 * （authed-build 会拦掉 /.cloud/）—— 所以浏览器侧只验"界面与前端契约"，
 * 服务端那一半用**函数定义本身的静态校验**来验：
 *   ① record_review 里必须有"仅非测试才更新 cards"的守卫
 *   ② 更新语句必须带 owner_id = auth.uid()（否则函数会改到别人的卡）
 *   ③ client_event_id 上必须有唯一索引（幂等的物理保证）
 * 端到端 RPC 调用需要真实登录态，**未在本套件内验证**，已列入交付报告的未验收项。
 *
 * 用法：node tools/qa-isolation.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8894;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };
const APP = path.resolve(__dirname, '..', 'lexiloop');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map(); this.events = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails;
        const t = (d.exception && d.exception.description) || d.text || '';
        if (!/数据同步|cloud blocked|fetch|Failed|401|403|AbortError|not authenticated/.test(t)) this.events.push('EXCEPTION: ' + t); }
      if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(url, tries = 90) { for (let i = 0; i < tries; i++) {
    try { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); }); return new CDP(ws); } catch (e) { await sleep(250); } }
    throw new Error('CDP 连接超时'); }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {} })); return new Promise((res) => this.map.set(id, res)); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; }
    return r.result && r.result.result ? r.result.result.value : undefined; }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  const store = read('js/store.js');
  const views = read('js/views.js');
  const app = read('js/app.js');
  const game = read('js/game.js');
  const css = read('styles.css');

  /* ── 前端契约 ── */
  add('store 导出 recordReview / newEventId / isTestSession / setTestSession',
    /export async function recordReview/.test(store) && /export function newEventId/.test(store) &&
    /export function isTestSession/.test(store) && /export function setTestSession/.test(store));
  add('学习页写入已改走 recordReview', /await S\.recordReview\(log, card, \{ eventId: session\.eventId/.test(views));
  add('练习场批量写入已改走 recordReview', /await recordReview\(log, card, \{ eventId: evt/.test(store));
  add('离线补写也走 recordReview 并复用 eventId', /await recordReview\(item\.log, item\.card, \{ eventId: item\.eventId/.test(store));
  add('补写队列带 eventId 与 isTest', /eventId: o\.eventId \|\| newEventId\(\)/.test(store) &&
    /isTest: o\.isTest === true/.test(store));
  add('★ 换卡时会换 eventId（否则新作答会被当成重放丢掉）',
    /session\.eventId = S\.newEventId\(\)/.test(views) &&
    (views.match(/session\.eventId = S\.newEventId\(\)/g) || []).length >= 2);
  add('测试模式是会话级、不写进本地持久化',
    /testSession: false/.test(store) && !/testSession: state\.testSession/.test(store));
  add('登出时测试模式不需要额外清理（本就非持久化）', /resetLoad\(\)/.test(app));

  /* ── 测试模式界面 ── */
  add('顶部有常驻的测试模式提示条', /class="test-bar"/.test(app));
  add('提示条内含退出按钮', /id="test-exit"/.test(app));
  add('提示条用警告色且带 reduced-motion 兜底', /\.test-bar\s*\{/.test(css) && /var\(--warn\)/.test(css));
  add('「我的」页有测试模式开关', /id="me-test-mode"/.test(views) && /开启测试模式|退出测试模式/.test(views));

  add('★ 练习场等调用点默认继承测试模式（不靠每个调用点记得传）',
    /const isTest = o\.isTest !== undefined \? o\.isTest === true : state\.testSession === true/.test(store) &&
    /recordReview\(log, card, \{ eventId: evt, isTest: isTest \}\)/.test(store) &&
    /queueReview\(log, card, \{ eventId: evt, isTest: isTest \}\)/.test(store));

  add('★ 测试模式下的抽测不会写"本周已抽测"的达标标记',
    /if \(source === 'test' && n > 0 && !isTest\)/.test(store));

  /* ── 本地状态隔离（2026-10-10 外部复测 P0 的落地修复）──
     学习页与练习场都在**真实的 state.cards 对象**上调 applyGrade。
     若不恢复，测试作答会在本地推进卡片状态（到期日改变、待办数变少），
     直到刷新才被服务端覆盖 —— 与横幅承诺的「不影响学习进度」矛盾。 */
  add('★ 测试模式下 applyGrade 不改动共享卡片（否则本地进度会被测试推进）',
    /state\.testSession === true/.test(store) &&
    /const before = Object\.assign\(\{\}, card\)/.test(store) &&
    /Object\.assign\(card, before\)/.test(store));
  add('★ 抽测结果页在测试模式下不谎称"已写入复习计划"',
    /S\.isTestSession\(\)[\s\S]{0,60}?测试模式：本次成绩<b>不计入<\/b>复习计划/.test(game));
  add('★ 统计与导出同一口径：都排除 is_test（但保留每周抽测 source=test）',
    (store.match(/\.eq\('is_test', false\)/g) || []).length >= 2);

  /* ── 休息日口径一致性（2026-10-11 复发 bug 的防回归） ──
     bug 史：休息日 newAllowance() 返回 0，但目标环仍拿 daily_new 当分母 →
     同一张卡上"新学 0 / 8 还差 8"和"今天的任务完成了"并存。
     2026-10-04 修过 buildQueue 侧，漏了 goalCard 侧；2026-10-11 再次复发。
     这类 bug 的形态固定：**同一规则出现两套算法**。所以断言也盯死这一点。 */
  add('★ 目标环的新学目标必须走 newAllowance()，不得直接读 daily_new',
    /const allow = S\.newAllowance\(\)[\s\S]{0,400}?goalNew = isRest \? 0 :/.test(views));
  add('★ 休息日的新学行不能参与进度环百分比（分母为 0 会打出 NaN）',
    /if \(!isRest\) parts\.push\(Math\.min\(1, doneNew \/ goalNew\)\)/.test(views));
  add('★ 休息日不说"额度已学完"（今天一个新词都没学，那是假话）',
    /isRest[\s\S]{0,200}?今天是休息日 —— 不引新词/.test(views));
  add('store.js 里"统一走 newAllowance"的约定仍在（注释即契约）',
    /必须统一走这里，不要在各处重新判断休息日/.test(store));

  /* ── 服务端契约（静态校验，端到端调用见报告未验收项） ── */
  add('前端未再直接调 rpc 以外的裸写入做学习记录',
    !/from\('reviews'\)\.insert/.test(views));

  console.log('静态契约：' + out.filter((o) => o.pass).length + '/' + out.length + ' 通过\n');

  /* ── 浏览器：界面行为 ── */
  const files = ['index.html'].concat(fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
  const vs = new Set();
  files.forEach((f) => { for (const m of read(f).matchAll(/\?v=(\d+)/g)) vs.add(m[1]); });
  const VER = [...vs][0];

  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，已拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const url = 'http://127.0.0.1:' + PORT + '/';
  const port = 10007;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-iso-' + Date.now()), url],
    { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  try {
    let pg = null;
    for (let i = 0; i < 90; i++) {
      await sleep(250);
      try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (pg) break; } catch (e) {}
    }
    if (!pg) throw new Error('无法连接调试页');
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
    // 必须模拟粗指针：触控目标的最小高度写在 @media (pointer: coarse) 里，
    // 不模拟的话量到的是桌面尺寸（35px），会把"在手机上达标"误判成失败。
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }] });
    for (let i = 0; i < 30; i++) { await sleep(250); if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break; }

    /* 未开启时不应出现提示条 */
    let r = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      S.setTestSession(false);
      window.__lexiloopRender();
      await new Promise(r => setTimeout(r, 200));
      return { bar: !!document.querySelector('.test-bar'), on: S.isTestSession() };
    })()`);
    add('默认不显示测试提示条', r && r.bar === false && r.on === false, JSON.stringify(r));

    /* 开启后：提示条出现 + 退出按钮可用 */
    r = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      S.setTestSession(true);
      window.__lexiloopRender();
      await new Promise(r => setTimeout(r, 200));
      const bar = document.querySelector('.test-bar');
      const btn = document.getElementById('test-exit');
      const h = btn ? Math.round(btn.getBoundingClientRect().height) : 0;
      return { bar: !!bar, text: bar ? bar.textContent : '', btnH: h, on: S.isTestSession() };
    })()`);
    add('★ 开启后顶部出现测试模式提示', r && r.bar === true && /测试模式/.test(r.text), JSON.stringify(r));
    add('★ 提示明说"不影响学习进度"', r && /不影响/.test(r.text), JSON.stringify(r));
    add('退出按钮存在且 ≥44px', r && r.btnH >= 44, JSON.stringify(r));

    /* 点退出：提示条消失 */
    r = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      const b = document.getElementById('test-exit');
      if (b) b.click();
      await new Promise(r => setTimeout(r, 250));
      return { bar: !!document.querySelector('.test-bar'), on: S.isTestSession() };
    })()`);
    add('点退出后提示条消失且状态复位', r && r.bar === false && r.on === false, JSON.stringify(r));

    /* 刷新后自动退出（不持久化） */
    r = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      S.setTestSession(true);
      S.saveLocal();
      const raw = localStorage.getItem('lexiloop.state') || '';
      return { saved: /testSession/.test(raw), on: S.isTestSession() };
    })()`);
    add('★ 测试模式不会被写进本地持久化（刷新即失效）', r && r.saved === false && r.on === true, JSON.stringify(r));

    /* 提示条在小屏不溢出 */
    r = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      S.setTestSession(true);
      window.__lexiloopRender();
      await new Promise(r => setTimeout(r, 200));
      const bar = document.querySelector('.test-bar');
      return bar ? { overflow: bar.scrollWidth - bar.clientWidth,
                     doc: document.documentElement.scrollWidth - window.innerWidth } : null;
    })()`);
    add('提示条在 393px 下不横向溢出', r && r.overflow <= 1 && r.doc <= 1, JSON.stringify(r));

    await cdp.eval(`(async function(){ const S = await import('./js/store.js?v=${VER}'); S.setTestSession(false); return true; })()`);

    [...new Set(cdp.events)].forEach((e) => add('页面异常', false, e));
  } catch (e) {
    add('执行', false, e.message);
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
    try { srv.close(); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }

  let bad = 0;
  out.forEach((o) => { if (!o.pass) bad++; console.log((o.pass ? '  PASS  ' : '  FAIL  ') + o.n + (o.pass ? '' : '  → ' + o.d)); });
  console.log('\n===== 测试隔离与幂等质检: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
