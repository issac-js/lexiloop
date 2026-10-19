'use strict';
/* LexiLoop · 备份告警卡回归质检
   跑在「绕过登录闸门 + 禁写云端」的测试构建上（tools/lib/authed-build.js），验证：

   ① 静态契约：旧的灰色小字 backupHint 已彻底消失；告警卡 / 图标 / 样式 / 两个新
      设置字段 / 云端同步字段都在位。
   ② 行为：从未备份 → 出卡；7 天后再提醒 → 消失且写 snooze；现在导出 → 真的触发
      下载、写入 last_backup_at、卡片自动消失；<14 天不打扰；<20 张卡不打扰。
   ③ 版式：4 种 iOS 尺寸下卡片无横向溢出、按钮触摸高度 ≥44px、位置在「我的」
      页顶部（第一张普通卡片之前）。

   用法：node tools/qa-backup-alert.js */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8879;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

const APP = path.resolve(__dirname, '..', 'lexiloop');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

/* ---------- 静态检查 ---------- */
let VER = null;
function checkStatic() {
  const views = read('js/views.js');
  const css = read('styles.css');
  const ui = read('js/ui.js');
  const store = read('js/store.js');
  const cfg = read('js/config.js');

  const files = ['index.html', 'sw.js']
    .concat(fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join('js', f)));
  const versions = new Set();
  const caches = new Set();
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/\?v=(\d+)/g)) versions.add(m[1]);
    for (const m of s.matchAll(/shell-v(\d+)/g)) caches.add(m[1]);
  }
  VER = versions.size === 1 ? [...versions][0] : '86';
  add('所有模块使用同一个版本号', versions.size === 1, '发现 ' + JSON.stringify([...versions]));
  add('SW 缓存名与模块版本号一致', caches.size === 1 && [...caches][0] === [...versions][0],
    '缓存 ' + JSON.stringify([...caches]) + ' vs 模块 ' + JSON.stringify([...versions]));

  add('旧的一行小字提示 backupHint 已移除', views.indexOf('backupHint') < 0, 'views.js 仍有 backupHint');
  add('新的 backupAlert 已实现', /function backupAlert\(\)/.test(views));
  add('告警卡带 role="alert"（读屏器能播报）', /class="alert-card" role="alert"/.test(views));
  add('告警卡有「现在导出」按钮 #bk-now', /id="bk-now"/.test(views) && /现在导出/.test(views));
  add('告警卡有「7 天后再提醒」按钮 #bk-later', /id="bk-later"/.test(views));
  add('备份状态行 backupStatusLine 已实现', /function backupStatusLine\(\)/.test(views));
  add('导出逻辑只有一份（doBackup 被两个入口共用）',
    /async function doBackup\(/.test(views) && (views.match(/buildBackup\(\)/g) || []).length === 1,
    'buildBackup 调用点应为 1 个，实际 ' + ((views.match(/buildBackup\(\)/g) || []).length));
  add('图标 warn / save 已加入 ICONS', /warn:\s*'</.test(ui) && /save:\s*'</.test(ui));
  add('.alert-card 样式已定义（黄底 + 左侧色条）',
    /\.alert-card\s*\{[^}]*background:\s*var\(--warn-soft\)/.test(css) &&
    /\.alert-card\s*\{[^}]*border-left:\s*4px solid var\(--warn\)/.test(css));
  add('粗指针下告警卡按钮 ≥44px', /@media \(pointer: coarse\)\s*\{\s*\.alert-card \.ac-actions \.btn \{ min-height: 44px/.test(css));
  add('DEFAULT_SETTINGS 含 last_backup_at / backup_snooze_until',
    /last_backup_at:\s*null/.test(cfg) && /backup_snooze_until:\s*0/.test(cfg));
  add('pushSettings 会把 backup_snooze_until 同步到云端',
    /backup_snooze_until:\s*Number\(state\.settings\.backup_snooze_until\)/.test(store));
}

/* ---------- 浏览器探针 ---------- */
const probe = (nCards, lastBackupMs, snoozeMs) => `(async function(){
  const S = await import('./js/store.js?v=${VER}');
  const now = Date.now();
  S.state.words = Array.from({length: ${nCards}}, (_, i) => ({
    id: 'qw' + i, normalized: 'w' + i, lemma: 'word' + i, payload: { senses: [{ def_zh: '测试' }] }
  }));
  S.state.cards = Array.from({length: ${nCards}}, (_, i) => ({
    id: 'qc' + i, word_id: 'qw' + i, card_type: 'recognition', status: 'new',
    suspended: false, lapses: 0, reps: 0, deck: '', due: null, stability: 0, difficulty: 5
  }));
  S.state.settings.last_backup_at = ${lastBackupMs};
  S.state.settings.backup_snooze_until = ${snoozeMs};
  window.__lexiloopRender();
  await new Promise(r => setTimeout(r, 60));
  const me = document.querySelector('[data-tab="me"]');
  if (me) me.click();
  await new Promise(r => setTimeout(r, 120));
  const main = document.querySelector('.main') || document.body;
  const card = document.querySelector('.alert-card');
  const firstCard = main.querySelector('.card');
  const b1 = document.getElementById('bk-now');
  const b2 = document.getElementById('bk-later');
  const status = Array.from(main.querySelectorAll('p.tiny')).map(p => p.textContent).find(t => t.indexOf('上次备份') === 0) || '';
  let order = 'none';
  if (card && firstCard) {
    order = (card.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'alert-first' : 'card-first';
  }
  return {
    hasCard: !!card,
    title: card ? (card.querySelector('.ac-title') || {}).textContent : '',
    text: card ? (card.querySelector('.ac-text') || {}).textContent : '',
    iconSvg: card ? !!card.querySelector('.ac-icon svg') : false,
    btnNow: b1 ? b1.textContent.trim() : '',
    btnLater: b2 ? b2.textContent.trim() : '',
    hNow: b1 ? Math.round(b1.getBoundingClientRect().height) : 0,
    hLater: b2 ? Math.round(b2.getBoundingClientRect().height) : 0,
    order: order,
    docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    cardOverflow: card ? (card.scrollWidth - card.clientWidth) : 0,
    status: status.slice(0, 40),
    snooze: Number(S.state.settings.backup_snooze_until) || 0,
    last: Number(S.state.settings.last_backup_at) || 0,
  };
})()`;

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.map = new Map(); this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        const t = (d.exception && d.exception.description) || d.text || '';
        if (!/数据同步|cloud blocked|fetch|Failed|401|403/.test(t)) this.events.push('EXCEPTION: ' + t);
      }
      if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); }
    };
  }
  static async connect(url, tries = 90) {
    for (let i = 0; i < tries; i++) {
      try {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
        return new CDP(ws);
      } catch (e) { await sleep(250); }
    }
    throw new Error('CDP 连接超时');
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res) => this.map.set(id, res));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const DEVICES = [
  { name: 'iPhone SE 375', w: 375, h: 667, dsf: 2 },
  { name: 'iPhone 15 393', w: 393, h: 852, dsf: 3 },
  { name: 'iPhone 15PM 430', w: 430, h: 932, dsf: 3 },
  { name: 'iPad mini 744', w: 744, h: 1133, dsf: 2 },
];

(async () => {
  checkStatic();
  console.log('静态契约：' + out.filter((o) => o.pass).length + '/' + out.length + ' 通过\n');

  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，已拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const url = 'http://127.0.0.1:' + PORT + '/';
  const port = 9987;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-alert-' + Date.now()), url],
    { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  try {
    let pg = null;
    for (let i = 0; i < 90; i++) {
      await sleep(250);
      try {
        const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        if (pg) break;
      } catch (e) {}
    }
    if (!pg) throw new Error('无法连接调试页');
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    /* ---------- 版式：4 种 iOS 尺寸 ---------- */
    for (const d of DEVICES) {
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: d.w, height: d.h, deviceScaleFactor: d.dsf, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setEmulatedMedia',
        { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }] });
      await cdp.send('Page.navigate', { url: url });
      for (let i = 0; i < 30; i++) {
        await sleep(250);
        if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break;
      }
      const r = await cdp.eval(probe(3069, 0, 0));
      if (!r || r.__err) { add(d.name + ' 探针', false, JSON.stringify(r)); continue; }
      add(d.name + '：从未备份时出现告警卡', r.hasCard === true, JSON.stringify(r));
      add(d.name + '：标题为「还没导出过备份」', /还没导出过备份/.test(r.title), r.title);
      add(d.name + '：正文点出了卡片/词条数量', /3069/.test(r.text), r.text.slice(0, 60));
      add(d.name + '：有警告图标', r.iconSvg === true);
      add(d.name + '：按钮文案为「现在导出」', /现在导出/.test(r.btnNow), r.btnNow);
      add(d.name + '：页面无横向溢出', r.docOverflow <= 1, 'overflow=' + r.docOverflow);
      add(d.name + '：卡片自身无横向溢出', r.cardOverflow <= 1, 'overflow=' + r.cardOverflow);
      add(d.name + '：主按钮触摸高度 ≥44px', r.hNow >= 44, 'h=' + r.hNow);
      add(d.name + '：次级按钮触摸高度 ≥44px', r.hLater >= 44, 'h=' + r.hLater);
      add(d.name + '：告警卡排在普通卡片之前（够醒目）', r.order === 'alert-first', 'order=' + r.order);
    }

    /* ---------- 行为：回到 375 做交互 ---------- */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: url });
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break;
    }

    /* 装下载探针：统计 createObjectURL 调用次数 */
    await cdp.eval(`(function(){
      window.__dl = 0;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function(b){ window.__dl++; return orig(b); };
    })()`);

    /* A. 从未备份 → 出卡（前置） */
    let r = await cdp.eval(probe(3069, 0, 0));
    add('行为：从未备份 → 出卡', r && r.hasCard === true, JSON.stringify(r && r.title));
    add('行为：备份卡状态行显示「从未」', /从未/.test(r.status), r.status);

    /* B. 7 天后再提醒 → 消失 + 写 snooze */
    r = await cdp.eval(`(async function(){
      document.getElementById('bk-later').click();
      await new Promise(x => setTimeout(x, 200));
      const S = await import('./js/store.js?v=${VER}');
      return { hasCard: !!document.querySelector('.alert-card'),
               snooze: Number(S.state.settings.backup_snooze_until) || 0, now: Date.now() };
    })()`);
    add('行为：点「7 天后再提醒」后卡片消失', r && r.hasCard === false, JSON.stringify(r));
    add('行为：snooze 写到约 7 天后', r && r.snooze > r.now + 6 * 86400000, JSON.stringify(r));

    /* C. snooze 期间即使从未备份也不打扰 */
    r = await cdp.eval(probe(3069, 0, 'Date.now() + 3 * 86400000'));
    add('行为：snooze 未到期 → 不打扰', r && r.hasCard === false, JSON.stringify(r && r.title));

    /* D. 点「现在导出」→ 真的下载 + 写 last_backup_at + 卡片自动消失
          （先重设为"从未备份且无 snooze"，把卡片叫回来，再点） */
    await cdp.eval(probe(3069, 0, 0));
    r = await cdp.eval(`(async function(){
      window.__dl = 0;
      document.getElementById('bk-now').click();
      /* 测试构建里云端被拦截，复习日志请求会一直挂起；buildBackup 有 8 秒超时保护，
         这里等 9.5 秒确保它已经走完（生产环境云通，这里是慢路径）。 */
      await new Promise(x => setTimeout(x, 9500));
      const S = await import('./js/store.js?v=${VER}');
      const main = document.querySelector('.main') || document.body;
      const status = Array.from(main.querySelectorAll('p.tiny')).map(p => p.textContent)
        .find(t => t.indexOf('上次备份') === 0) || '';
      return { dl: window.__dl,
               hasCard: !!document.querySelector('.alert-card'),
               last: Number(S.state.settings.last_backup_at) || 0,
               snooze: Number(S.state.settings.backup_snooze_until) || 0,
               now: Date.now(), status: status.slice(0, 40) };
    })()`);
    add('行为：点「现在导出」真的触发了一次下载', r && r.dl === 1, 'createObjectURL 调用 ' + (r && r.dl) + ' 次');
    add('行为：导出后写入 last_backup_at', r && r.last > 0 && r.now - r.last < 60000, JSON.stringify(r));
    add('行为：导出后自动清掉 snooze', r && r.snooze === 0, 'snooze=' + (r && r.snooze));
    add('行为：导出后告警卡自动消失（不用手动刷新）', r && r.hasCard === false, JSON.stringify(r));
    add('行为：备份卡状态行更新为「刚刚」', /刚刚/.test(r.status), r.status);

    /* E. 3 天前刚备份 → 不打扰 */
    r = await cdp.eval(probe(3069, 'Date.now() - 3 * 86400000', 0));
    add('行为：3 天前刚备份 → 不打扰', r && r.hasCard === false, JSON.stringify(r && r.title));

    /* F. 20 天前备份 → 出卡并写明天数 */
    r = await cdp.eval(probe(3069, 'Date.now() - 20 * 86400000', 0));
    add('行为：20 天前备份 → 出卡', r && r.hasCard === true, JSON.stringify(r && r.title));
    add('行为：文案点出「20 天」', /20 天/.test(r.title), r.title);

    /* G. 新手（<20 张卡、从未备份）→ 不打扰 */
    r = await cdp.eval(probe(5, 0, 0));
    add('行为：新用户 5 张卡、从未备份 → 不打扰', r && r.hasCard === false, JSON.stringify(r && r.title));

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
  console.log('\n===== 备份告警卡质检: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
