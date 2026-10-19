'use strict';
/* LexiLoop · 休息日口径一致性（真实渲染验证）
 *
 * 复现 2026-10-11 用户报告：休息日显示"还有 8 个单词没学"，但学习按钮是灰的
 * "今天的任务完成了"。（场景用"今天真实的星期几"当 rest_weekday，任何一天跑都有效，
 * 不依赖跑的那天刚好是周日 —— 写死 0 会让测试只在周日成立。）
 *
 * 做法：在 localStorage 里预置一份状态 —— 今天是周日、有到期复习、有未学词、
 * 今日新学 0 —— 然后加载真实应用、读取真实 DOM 文案，断言：
 *   ① 目标环不再出现"新学 0 / 8　还差 8"这种休息日根本做不到的指标
 *   ② 不能说"今日新词额度已学完"（今天一个新词都没学，那是假话）
 *   ③ 目标环与按钮不能互相矛盾
 *
 * 用法：node tools/qa-restday.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8896;
const DBPORT = 10031;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => out.push({ n, pass: !!p, d: p ? '' : String(d == null ? '' : d) });

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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，已拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const port = DBPORT;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-rest-' + Date.now()), 'about:blank'],
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
    await cdp.send('Page.enable');

    // 先落到应用域名下，才能写同源 localStorage
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
    await sleep(1500);

    /* 隔离构建下云端不可达（authed-build 会拦 /.cloud/），页面会停在"正在同步…"。
       这不是被测代码的问题，所以这里**直接驱动真实模块**：
       在同一个页面里，先注入休息日状态渲染一次，再切到非休息日渲染一次 ——
       两次都必须成立，才说明修复真的区分了两种场景（单向断言会被"什么都渲染不出"
       和"两种情况碰巧一样"同时骗过）。 */
    const driven = await cdp.eval(`(async function(){
      try {
        // ★ 必须带上 ?v=NNN：页面内模块是按 './js/store.js?v=102' 加载的，
        //   不带版本号的 import 会拿到**另一个模块实例**（独立的 state 对象），
        //   于是改了状态但渲染出来的还是原来那份 —— 第一版脚本就是这么被骗的。
        var ver = (document.querySelector('script[type=module]') || {}).src || '';
        var q = (ver.match(/\\?v=\\d+/) || [''])[0];
        var S = await import('./js/store.js' + q);
        var V = await import('./js/views.js' + q);
        function mk(restRaw) {
          var now = Date.now();
          var past = new Date(now - 3600*1000).toISOString();
          var words = [], cards = [];
          /* ⚠ 夹具必须用**生产形状**：senses 是对象数组（def_zh/def_en），
             collocations 必须带 pattern —— 用简写形状（senses: ['释义'] / { en, zh }）
             会让"内容缺失"规则把这些合成词条判成空壳挡掉，测出来的队列全是 0。
             （2026-10-15 实测：生产库 1573 条里没有一条旧形状。） */
          for (var i = 1; i <= 6; i++) {
            words.push({ id: i, normalized: 'word'+i, lemma: 'word'+i, deck: 'core',
              payload: { pos: 'noun', senses: [{ def_zh: '释义'+i, def_en: 'sense '+i, pos: 'noun' }],
                collocations: [{ pattern: 'word'+i+' (sth)', type: 'verb+prep', register: 'neutral',
                  zh: '搭配'+i, examples: [{ en: 'We word'+i+' it.', zh: '搭配例句'+i }] }] } });
            cards.push({ id: 'c'+i, word_id: i, card_type: 'recognition', status: 'review',
              stability: 5, difficulty: 5, due: past, reps: 3, lapses: 0 });
          }
          for (var j = 101; j <= 140; j++) {
            words.push({ id: j, normalized: 'new'+j, lemma: 'new'+j, deck: 'core',
              payload: { pos: 'noun', senses: [{ def_zh: '新释义'+j, def_en: 'new sense '+j, pos: 'noun' }],
                collocations: [{ pattern: 'new'+j+' (sth)', type: 'verb+prep', register: 'neutral',
                  zh: '新搭配'+j, examples: [{ en: 'We new'+j+' it.', zh: '新例句'+j }] }] } });
            cards.push({ id: 'n'+j, word_id: j, card_type: 'recognition', status: 'new',
              stability: 0, difficulty: 0, due: null, reps: 0, lapses: 0 });
          }
          S.state.user = { id: 'qa', email: 'qa@example.com' };
          S.state.load.hydrated = true; S.state.load.phase = 'ready';
          S.state.words = words; S.state.cards = cards;
          S.state.settings = Object.assign({}, S.state.settings, {
            daily_new: 8, daily_max_review: 300, rest_weekday: restRaw,
            goal_include_test: true, last_test_at: now - 2*86400000,
            /* 清掉锁定的今日目标：两个场景要各按自己的休息日设置重新锁定。
               不清的话第二组会复用第一组锁下的 plan（day_plan 按日期缓存，
               这正是"目标当天锁定"的设计），断言就测不到 ensureDayPlan 本身。 */
            day_plan: null,
          });
          S.state.daily = [{ reviewed_on: new Date(now).toISOString().slice(0,10),
            total: 6, correct: 5, new_words: 0, minutes: 4 }];
          S.reindex();
          var d = document.createElement('div');
          d.innerHTML = V.renderToday();
          var gp = S.goalProgress();
          return { txt: d.innerText, isRest: !!S.isRestDay(),
            goalNew: gp.plan.newGoal, met: gp.met };
        }
        /* 休息日场景必须用**今天真实的星期几**当 rest_weekday ——
           写死 0（周日）的话，只有在周日跑这个套件才成立，其他日子
           isRestDay() 判定为 false，整个休息日分支静默失效（2026-10-14 踩到）。 */
        return { ok: true, rest: mk(String(new Date().getDay())), work: mk('') };
      } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
    })()`);
    if (!driven || driven.ok !== true) {
      add('驱动真实模块 renderToday()（两种场景）', false, JSON.stringify(driven));
    }
    const tR = (driven && driven.rest && driven.rest.txt) || '';
    const tW = (driven && driven.work && driven.work.txt) || '';

    add('今日页已渲染（非加载态/非空白）',
      driven && driven.ok === true && tR.length > 40 && tR.indexOf('待复习') >= 0,
      JSON.stringify(tR.slice(0, 200)));
    add('场景开关生效：休息日判定为真、对照组判定为假',
      driven && driven.rest.isRest === true && driven.work.isRest === false,
      JSON.stringify({ rest: driven && driven.rest.isRest, work: driven && driven.work.isRest }));

    /* ── 休息日：不得出现"新学 0 / 8"这类做不到的指标 ── */
    add('★ [休息日] 目标环不再显示"新学 0 / 8"', /新学\s*0\s*\/\s*8/.test(tR) === false,
      '实际：' + (tR.match(/新学[^\n]*/) || ['(无)'])[0]);
    add('★ [休息日] 不再出现"还差 8"这种做不到的缺口', /还差\s*8/.test(tR) === false,
      '实际：' + (tR.match(/还差[^\n]*/g) || ['(无)']).join(' | '));
    add('★ [休息日] 不说"今日新词额度已学完"（今天一个新词都没学）', tR.indexOf('额度已学完') < 0,
      (tR.match(/[^\n]*额度已学完[^\n]*/) || ['(无)'])[0]);
    add('★ [休息日] 明确告知今天是休息日', /休息日/.test(tR), JSON.stringify(tR.slice(0, 160)));
    add('[休息日] 新学行显示"今日休息/休息日不安排"',
      /今日休息/.test(tR) || /休息日不安排/.test(tR), JSON.stringify(tR.slice(0, 240)));

    /* ── 达标记账：休息日不得挡住"今日达标"（2026-10-14 新增的第三个休息日漏点） ──
       ensureDayPlan 曾把休息日的 newGoal 也锁成 8，而休息日不引新词 → doneNew 恒为 0
       → newMet 永远 false → 每周日达标连胜必断、近 30 天达标率被压低。 */
    add('★ [休息日] 今日锁定的新学目标为 0（达标不被休息日挡住）',
      driven && driven.rest && driven.rest.goalNew === 0,
      'plan.newGoal=' + (driven && driven.rest && driven.rest.goalNew));
    add('★ [休息日] 三项条件都满足时 goalProgress().met 为 true',
      driven && driven.rest && driven.rest.met === true,
      'met=' + (driven && driven.rest && driven.rest.met));
    add('★ [非休息日] 新学目标仍按 daily_new 锁为 8（修复没波及正常日）',
      driven && driven.work && driven.work.goalNew === 8,
      'plan.newGoal=' + (driven && driven.work && driven.work.goalNew));

    /* ── 对照组（非休息日）：原来的正常行为必须保留 ──
       这是防"修一个坏一个"的反向断言。没有它，上面那些"不得出现"的断言
       只要页面渲染成空白就全部通过。 */
    add('★ [非休息日] 新学目标仍按 daily_new 显示（0 / 8）',
      /新学\s*0\s*\/\s*8/.test(tW) === true,
      '实际：' + (tW.match(/新学[^\n]*/) || ['(无)'])[0]);
    add('★ [非休息日] 仍提示还差 8 个新词（这条在休息日才是错的）',
      /还差\s*8/.test(tW) === true,
      '实际：' + (tW.match(/还差[^\n]*/g) || ['(无)']).join(' | '));
    add('★ [非休息日] 不出现"休息日"字样', !/休息日/.test(tW),
      JSON.stringify(tW.slice(0, 160)));
    add('★ [非休息日] 学习入口可用（按钮显示张数，非"任务完成"）',
      /开始学习（\d+ 张）/.test(tW) && tW.indexOf('今天的任务完成了') < 0,
      JSON.stringify(tW.slice(0, 200)));

    /* ── 两场景共性：目标环与按钮不得互相矛盾 ── */
    [[tR, '休息日'], [tW, '非休息日']].forEach((pair) => {
      const tx = pair[0], nm = pair[1];
      const btnDone = tx.indexOf('今天的任务完成了') >= 0;
      const ringShort = /还差/.test(tx);
      add('★ [' + nm + '] 目标环与按钮不互相矛盾', !(btnDone && ringShort),
        '按钮完成=' + btnDone + ' 环说还差=' + ringShort);
    });

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
  console.log('\n===== 休息日口径一致性: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
