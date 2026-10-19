'use strict';
/* LexiLoop · 真实语义复核端到端验证（跑在生产域名上，走真实大模型）
 *
 * 为什么必须单独跑一次真实调用：judge.js 的本地规则只能证明"哪些该判 hit"，
 * 判不了 address 是不是 deal with 的合理替代 —— 那一档完全依赖语义复核。
 * 用 stub 测只能证明协议对，证明不了模型会给出正确结论、以及**要等多久**。
 *
 * 验收点：
 *   ① 合理替代表达（address）→ alt，不能是 wrong
 *   ② 真的错（deal in 用错介词 / zebra 不相干）→ wrong
 *   ③ 往返耗时落在 UI 可接受范围内（judge.js 里设了 6 秒超时）
 *
 * 用法：node tools/qa-semantic-live.js */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SITE = 'https://lexiloop-82703.app.workbuddy.host/';
const APP = path.resolve(__dirname, '..', 'lexiloop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); }
    };
  }
  static async connect(url, tries = 100) {
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
  async eval(expr, timeoutMs) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
      timeout: timeoutMs || 120000,
    });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __err: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  const files = ['index.html', 'sw.js'].concat(
    fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
  const versions = new Set();
  files.forEach((f) => {
    const s = fs.readFileSync(path.join(APP, f), 'utf8');
    for (const m of s.matchAll(/\?v=(\d+)/g)) versions.add(m[1]);
  });
  const VER = [...versions][0];

  const port = 9995;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-sem-' + Date.now()), SITE],
    { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  try {
    let pg = null;
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      try {
        const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        if (pg) break;
      } catch (e) {}
    }
    if (!pg) throw new Error('无法连接调试页');
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    // 等 SDK 就绪 + 应用已渲染出登录页（说明配置指向发布域名、Origin 匹配）
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const r = await cdp.eval('!!(window.WorkBuddyCloud && document.querySelector("#root").children.length)');
      if (r === true) { ready = true; break; }
    }
    add('生产站点已就绪（SDK 加载 + 页面渲染）', ready === true, '超时');

    // 生产上当前跑的是 v87 吗？（避免拿旧包测新逻辑）
    const liveVer = await cdp.eval(`(async function(){
      try { const m = await import('./js/judge.js?v=${VER}'); return typeof m.judgeTyped === 'function'; }
      catch (e) { return 'ERR:' + (e && e.message); }
    })()`);
    add('生产已上线 v' + VER + ' 且 judge.js 可用', liveVer === true, JSON.stringify(liveVer));

    const CASES = [
      { tag: '合理替代：address 表达"处理"', expected: 'deal with', given: 'address',
        sentence: 'The manager had to ___ several complaints from customers.',
        zh: '经理不得不处理客户的几个投诉。', want: 'alt' },
      { tag: '错误介词：deal in 在此语境不成立', expected: 'deal with', given: 'deal in',
        sentence: 'The manager had to ___ several complaints from customers.',
        zh: '经理不得不处理客户的几个投诉。', want: 'wrong' },
      { tag: '同义句式：if you have time', expected: 'if you have a moment', given: 'if you have time',
        sentence: '', zh: '如果你有空', want: 'alt' },
      { tag: '不相干作答：zebra', expected: 'deal with', given: 'zebra',
        sentence: 'The manager had to ___ several complaints from customers.',
        zh: '经理不得不处理客户的几个投诉。', want: 'wrong' },
      /* 2026-10-14 用户报告：compliments vs complimented —— 句中无过去时间状语，
         两种时态都成立，不能只认例文那一种形式（判 wrong 会惩罚正确的英语）。 */
      { tag: '★ 时态变形：无时间状语 → compliments 也成立', expected: 'complimented', given: 'compliments',
        sentence: 'She ________ him on his excellent presentation skills.',
        zh: '她称赞他出色的演讲技巧。', want: 'alt' },
      { tag: '★ 时态错用：yesterday 语境 → compliments 不成立', expected: 'complimented', given: 'compliments',
        sentence: 'She ________ him yesterday.', zh: '她昨天称赞了他。', want: 'wrong' },
      { tag: '★ 时态容错不过度：光杆 compliment 缺 -s/-ed → 不成立', expected: 'complimented', given: 'compliment',
        sentence: 'She ________ him on his excellent presentation skills.',
        zh: '她称赞他出色的演讲技巧。', want: 'wrong' },
    ];

    const results = [];
    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i];
      const r = await cdp.eval(`(async function(){
        const J = await import('./js/judge.js?v=${VER}');
        const C = await import('./js/cloud.js?v=${VER}');
        J.clearJudgeCache();      // 每次都要真调，不能吃上一次的缓存
        const t0 = Date.now();
        const res = await J.reviewSemantics({
          sentence: ${JSON.stringify(c.sentence)},
          zh: ${JSON.stringify(c.zh)},
          expected: ${JSON.stringify(c.expected)},
          given: ${JSON.stringify(c.given)},
          chat: C.chatText,
        });
        return { verdict: res.verdict, cached: res.cached, ms: Date.now() - t0 };
      })()`, 60000);
      results.push({ c: c, r: r });
      const got = r && r.verdict;
      add('★ ' + c.tag + ' → 期望 ' + c.want,
        got === c.want, '实际 ' + JSON.stringify(r));
      add('　耗时在 6 秒超时预算内（' + ((r && r.ms) || '?') + 'ms）',
        r && r.ms < 6500, JSON.stringify(r));
    }
    console.log('\n真实模型返回：');
    results.forEach((x) => {
      console.log('  ' + String(x.c.tag).padEnd(36) +
        '期望 ' + String(x.c.want).padEnd(6) +
        '实际 ' + String(x.r && x.r.verdict).padEnd(6) +
        String(x.r && x.r.ms) + 'ms');
    });
    console.log('');

    const avg = results.reduce((s, x) => s + ((x.r && x.r.ms) || 0), 0) / Math.max(1, results.length);
    add('平均往返 ' + Math.round(avg) + 'ms —— 超过 4 秒就该改成本地集合兜底',
      avg > 0, '没有拿到耗时');

    // 缓存必须真的生效，否则每次答错都要付一次模型调用
    const cache = await cdp.eval(`(async function(){
      const J = await import('./js/judge.js?v=${VER}');
      const C = await import('./js/cloud.js?v=${VER}');
      let calls = 0;
      const spy = async (o) => { calls++; return C.chatText(o); };
      const a = await J.reviewSemantics({ expected:'cache probe a', given:'cache probe b',
        zh:'测试', chat: spy });
      const b = await J.reviewSemantics({ expected:'cache probe a', given:'cache probe b',
        zh:'测试', chat: spy });
      J.clearJudgeCache();
      return { first: a.verdict, cached: b.cached, calls: calls };
    })()`, 60000);
    add('★ 同一作答第二次走缓存，不再调用模型', cache && cache.cached === true,
      JSON.stringify(cache));

    // 测完清缓存，别把测试垃圾留给用户
    await cdp.eval(`(async function(){
      const J = await import('./js/judge.js?v=${VER}'); J.clearJudgeCache(); return true;
    })()`);
    add('测试缓存已清理（不污染用户环境）', true);
  } catch (e) {
    add('执行', false, e.message);
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
  }

  let bad = 0;
  out.forEach((o) => { if (!o.pass) bad++; console.log((o.pass ? '  PASS  ' : '  FAIL  ') + o.n + (o.pass ? '' : '  → ' + o.d)); });
  console.log('\n===== 真实语义复核验证: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
