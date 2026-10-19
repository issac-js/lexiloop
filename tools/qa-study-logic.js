'use strict';
/* LexiLoop · 学习计划逻辑回归（休息日 / 额度 / 版本一致性）
   跑在"绕过登录闸门 + 禁写云端"的测试构建上，验证：

   ① 休息日规则只有一个来源：isRestDay / newAllowance / buildQueue / tab 徽章 /
      「今日」页 todo 必须给出**一致**的答案。
      历史 bug（2026-10-04）：buildQueue 判了休息日、徽章没判 → 周日界面仍提示
      "还有 8 个单词待学习"，而实际队列里一个新词都没有。
   ② 版本号一致性：所有模块 ?v= 与 SW 缓存名必须是同一个数字，
      否则「我的 → 版本」显示的号与实际加载的脚本对不上。

   用法：node tools/qa-study-logic.js */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8875;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

/* ---------- 静态检查：版本号一致性（无需浏览器） ---------- */
function checkVersionCoherence() {
  const APP = path.resolve(__dirname, '..', 'lexiloop');
  const files = ['index.html', 'sw.js']
    .concat(fs.readdirSync(path.join(APP, 'js'))
      .filter((f) => f.endsWith('.js')).map((f) => path.join('js', f)));
  const versions = new Set();
  const cacheNames = new Set();
  for (const f of files) {
    const s = fs.readFileSync(path.join(APP, f), 'utf8');
    for (const m of s.matchAll(/\?v=(\d+)/g)) versions.add(m[1]);
    for (const m of s.matchAll(/shell-v(\d+)/g)) cacheNames.add(m[1]);
  }
  add('所有模块使用同一个版本号', versions.size === 1,
    '发现 ' + versions.size + ' 个: ' + JSON.stringify([...versions]));
  add('SW 缓存名与模块版本号一致', cacheNames.size === 1 && [...cacheNames][0] === [...versions][0],
    '缓存名 ' + JSON.stringify([...cacheNames]) + ' vs 模块 ' + JSON.stringify([...versions]));
  return versions.size === 1 ? [...versions][0] : null;
}

/* ---------- 浏览器内：休息日逻辑 ---------- */
const LOGIC = `(async function(){
  const S = await import('./js/store.js');
  const today = new Date().getDay();
  const rep = {};

  /* 注入合成数据，让场景真实成立（本地内存，cloud 已被拦截，不会写生产库）：
       8 张未学新卡（status='new'）+ 3 张已到期复习卡。
     ⚠ 字段名必须写 word_id：历史上这里写成了 wid，旧逻辑（按卡计）不在乎，
       而 2026-10-17 起配额按「词」统计（newWordCount / leftoverNewCards 都读 word_id），
       写错字段会让 8 张新卡全被当成"同一个词"的补课卡，场景直接失真。 */
  const bakCards = S.state.cards;
  const now = Date.now();
  S.state.cards = [
    ...Array.from({length: 8}, (_, i) => ({ id: 'qa-new-' + i, word_id: 'w' + i, status: 'new',
      suspended: false, lapses: 0, deck: '', due: null })),
    ...Array.from({length: 3}, (_, i) => ({ id: 'qa-rev-' + i, word_id: 'v' + i, status: 'review',
      suspended: false, lapses: 1, deck: '', due: new Date(now - 86400000).toISOString() }))
  ];

  const snap = (label) => {
    const allow = S.newAllowance();
    const q = S.buildQueue();
    const due = S.dueCards().length;
    const fresh = S.newCards().length;
    const freshWords = S.newWordCount();
    /* 与 app.js badgeCount() 完全同式：角标 = 真实队列张数（2026-10-17 起） */
    const badge = S.buildQueue().length;
    return { label: label, isRest: S.isRestDay(), allow: allow,
             queueNew: q.filter(c => c.status === 'new').length,
             queueTotal: q.length, due: due, fresh: fresh, freshWords: freshWords,
             leftover: S.leftoverNewCards().length, badge: badge };
  };

  const bak = S.state.settings.rest_weekday;

  /* 场景 A：把今天设为休息日 */
  S.state.settings.rest_weekday = today;
  rep.restDay = snap('休息日');

  /* 场景 B：把明天设为休息日（即今天是工作日） */
  S.state.settings.rest_weekday = (today + 1) % 7;
  rep.workDay = snap('工作日');

  /* 场景 C：关闭休息日（内存里存 ''，落库存 null） */
  S.state.settings.rest_weekday = '';
  rep.noRest = snap('关闭休息日');

  /* 场景 D：落库形态的 null（真实持久化值） */
  S.state.settings.rest_weekday = null;
  rep.nullRest = snap('存为null');

  S.state.settings.rest_weekday = bak;
  S.state.cards = bakCards;
  return rep;
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

(async () => {
  const ver = checkVersionCoherence();
  console.log('版本一致性检查：' + (ver ? 'v' + ver : '异常'));
  console.log('（' + out.map((o) => (o.pass ? 'PASS' : 'FAIL')).join(' / ') + '）\n');

  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，已拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const url = 'http://127.0.0.1:' + PORT + '/';
  const port = 9985;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-logic-' + Date.now()), url],
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
    for (let i = 0; i < 24; i++) {
      if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break;
      await sleep(500);
    }
    add('测试构建可进入登录后外壳', (await cdp.eval('!!document.querySelector(".tabbar")')) === true, 'tabbar 未渲染');

    const r = await cdp.eval(LOGIC);
    if (!r || r.__err) {
      add('学习计划逻辑探针执行', false, JSON.stringify(r));
    } else {
      console.log('三种场景实测：');
      console.log('  场景          休息日?  额度  队列新词  到期  未学新词  徽章提示');
      for (const k of ['restDay', 'workDay', 'noRest', 'nullRest']) {
        const s = r[k];
        console.log('  ' + String(s.label).padEnd(12) +
          String(s.isRest).padEnd(8) + String(s.allow).padEnd(6) +
          String(s.queueNew).padEnd(9) + String(s.due).padEnd(6) +
          String(s.fresh).padEnd(9) + String(s.badge));
      }
      console.log('');

      /* 前置：确认合成数据确实造出来了（否则下面的断言是空转） */
      add('前置：合成数据已就位（8 新卡 + 3 到期卡）',
        r.restDay && r.restDay.fresh === 8 && r.restDay.due === 3,
        JSON.stringify(r.restDay));

      /* 休息日：额度必须 0、徽章不得把新词算进去 */
      add('休息日：新词额度为 0', r.restDay && r.restDay.allow === 0, JSON.stringify(r.restDay));
      add('休息日：队列里没有新词', r.restDay && r.restDay.queueNew === 0, JSON.stringify(r.restDay));
      add('休息日：徽章只算到期复习卡（=3），不含 8 个新词',
        r.restDay && r.restDay.badge === 3, 'badge=' + (r.restDay && r.restDay.badge));
      add('休息日：isRestDay 正确识别', r.restDay && r.restDay.isRest === true, 'isRest=' + (r.restDay && r.restDay.isRest));

      /* 工作日：额度恢复，且新词真的进队列 */
      add('工作日：额度恢复为 daily_new(=8)', r.workDay && r.workDay.allow === 8, JSON.stringify(r.workDay));
      add('工作日：8 个新词进入队列', r.workDay && r.workDay.queueNew === 8, JSON.stringify(r.workDay));
      add('工作日：徽章 = 到期 3 + 新词 8 = 11', r.workDay && r.workDay.badge === 11,
        'badge=' + (r.workDay && r.workDay.badge));
      add('工作日：isRestDay 正确识别为 false', r.workDay && r.workDay.isRest === false, 'isRest=' + (r.workDay && r.workDay.isRest));

      /* 关闭休息日的两种形态都要真的关掉 */
      add('关闭休息日（内存空串）：今天不再是休息日', r.noRest && r.noRest.isRest === false, JSON.stringify(r.noRest));
      add('关闭休息日（落库 null）：今天不再是休息日', r.nullRest && r.nullRest.isRest === false,
        JSON.stringify(r.nullRest));
      add('关闭休息日（null）：额度应恢复为 8', r.nullRest && r.nullRest.allow === 8, JSON.stringify(r.nullRest));

      /* ★ 历史 bug 的原始场景：周日有 8 个未学新词时，界面不得提示"待学习" ★ */
      add('★历史bug场景：休息日徽章绝不把新词计入',
        r.restDay && r.restDay.fresh > 0 && r.restDay.badge === r.restDay.due,
        'fresh=' + (r.restDay && r.restDay.fresh) + ' due=' + (r.restDay && r.restDay.due) +
        ' 但 badge=' + (r.restDay && r.restDay.badge));

      /* ── 新词额度的"词 / 卡"单位口径（2026-10-17 修复）──
         服务端 new_words 按**词**计、队列供给按**卡**计；两处混用就会让
         "新学 7/8 还差 1"永远学不满（用户描述为"学了十几遍提示还在重复"）。 */
      const units = await cdp.eval(`(async function(){
        const S = await import('./js/store.js');
        const bakCards = S.state.cards;
        const now = Date.now();
        S.state.cards = [
          { id: 'pa1', word_id: 'wA', status: 'review', suspended: false, lapses: 0, deck: '', due: new Date(now - 3600000).toISOString() },
          { id: 'pa2', word_id: 'wA', status: 'new', suspended: false, lapses: 0, deck: '', due: null },
          { id: 'pb1', word_id: 'wB', status: 'new', suspended: false, lapses: 0, deck: '', due: null },
          { id: 'pb2', word_id: 'wB', status: 'new', suspended: false, lapses: 0, deck: '', due: null },
        ];
        S.state.words = []; S.reindex();
        const q = S.buildQueue();
        const rep = { newCards: S.newCards().length, freshWords: S.newWordCount(),
                      leftover: S.leftoverNewCards().length, inQueue: q.map(c => c.id), badge: q.length };
        S.state.cards = bakCards; S.reindex();
        return rep;
      })()`);
      add('★ 单位口径：3 张 new 卡只对应 1 个真新词（配额按词计）',
        units && units.newCards === 3 && units.freshWords === 1, JSON.stringify(units));
      add('★ 单位口径：已开始词的剩余卡单独归类（补课，不占配额）',
        units && units.leftover === 1, JSON.stringify(units));
      add('★ 补课卡能学：出现在队列里（既不当配额卡，也不被丢弃）',
        units && units.inQueue.indexOf('pa2') >= 0, JSON.stringify(units));
      add('角标 = 真实队列张数（与「开始学习」按钮同源）',
        units && units.badge === units.inQueue.length, JSON.stringify(units));
    }
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
  console.log('\n===== 学习计划逻辑质检: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
