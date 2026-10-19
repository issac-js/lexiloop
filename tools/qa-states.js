'use strict';
/* LexiLoop · 加载状态 / 达标口径 / 统计口径 / 练习出口 专项回归
   对应用户任务书的 01 LOAD、04 CREDIT、05 NAV、06 CHOICE、07 METRIC、08 GOAL。

   为什么每一条都要用真浏览器：这六项的失败模式**全都是"说了假话"**——
   空数组被当成空库、100% 和"还差抽测"同时出现、一次通过率算成了总体通过率。
   静态读代码看不出这类问题，必须在真 DOM 上把文案取出来比对。

   用法：node tools/qa-states.js */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8891;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };
const APP = path.resolve(__dirname, '..', 'lexiloop');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.map = new Map(); this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        const t = (d.exception && d.exception.description) || d.text || '';
        if (!/数据同步|cloud blocked|fetch|Failed|401|403|AbortError/.test(t)) this.events.push('EXCEPTION: ' + t);
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
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __err: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

/* 让 store 进入指定的加载状态，再看各页说什么 */
const forceLoad = (ver, phase, opts) => `(async function(){
  const S = await import('./js/store.js?v=${ver}');
  const V = await import('./js/views.js?v=${ver}');
  const o = ${JSON.stringify(opts || {})};
  S.state.user = { id: 'qa-probe' };
  if (o.hydrated) {
    S.state.words = [{ id: 'pw', normalized: 'probe', lemma: 'probe', payload: { senses: [{ def_zh: '探测' }] } }];
    S.state.cards = [{ id: 'pc', word_id: 'pw', card_type: 'recognition', status: 'new',
      suspended: false, lapses: 0, reps: 0, deck: '', due: null, stability: 0, difficulty: 5 }];
  } else {
    S.state.words = []; S.state.cards = []; S.state.daily = [];
  }
  S.state.load.phase = ${JSON.stringify(phase)};
  S.state.load.error = ${JSON.stringify((opts && opts.error) || '')};
  S.state.load.hydrated = ${opts && opts.hydrated ? 'true' : 'false'};
  S.state.load.fromCache = ${opts && opts.hydrated ? 'true' : 'false'};
  S.reindex();
  window.__lexiloopRender();
  await new Promise(r => setTimeout(r, 150));
  return { ok: true };
})()`;

/** 读四个 tab 的空态/首屏文案 */
const readTabs = `(async function(){
  const res = {};
  for (const t of ['today','study','library','stats','games']) {
    const btn = document.querySelector('[data-tab="' + t + '"]');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 120));
    const main = document.getElementById('main');
    res[t] = {
      text: (main || {}).textContent || '',
      hasRetry: !!document.querySelector('#data-retry'),
      emptyBig: (document.querySelector('.empty .big') || {}).textContent || '',
    };
  }
  return res;
})()`;

/** 注入数据并进「今日」页，读目标卡的完整文案 */
const seedToday = (ver, daily) => `(async function(){
  const S = await import('./js/store.js?v=${ver}');
  const V = await import('./js/views.js?v=${ver}');
  S.state.user = { id: 'qa-probe' };
  S.state.settings.goal_include_test = true;
  S.state.settings.rest_weekday = null;
  S.state.settings.daily_new = 8;
  S.state.settings.last_test_at = null;
  const now = Date.now();
  S.state.words = [{ id: 'gw', normalized: 'gt', lemma: 'gt', payload: { senses: [{ def_zh: '目标' }] } }];
  S.state.cards = [{
    id: 'gc', word_id: 'gw', card_type: 'recognition', status: 'new',
    suspended: false, lapses: 0, reps: 0, deck: '', due: null, stability: 0, difficulty: 5,
  }];
  S.state.daily = [${JSON.stringify(daily || null)}].filter(Boolean);
  S.state.load.phase = 'ready';
  S.state.load.hydrated = true;
  S.reindex();
  window.__lexiloopRender();
  await new Promise(r => setTimeout(r, 120));
  document.querySelector('[data-tab="today"]').click();
  await new Promise(r => setTimeout(r, 200));
  const card = document.querySelector('.card.tight');
  return { text: card ? card.textContent : '', hasTestBtn: !!document.querySelector('#go-weekly-test') };
})()`;

(async () => {
  /* ── 静态契约 ── */
  const views = read('js/views.js');
  const store = read('js/store.js');
  const game = read('js/game.js');
  const app = read('js/app.js');

  add('store 有独立的加载状态对象', /load:\s*\{[\s\S]{0,400}phase:/.test(store));
  add('store 导出 dataPending / dataFailed / loadState / resetLoad',
    /export function dataPending/.test(store) && /export function dataFailed/.test(store) &&
    /export function loadState/.test(store) && /export function resetLoad/.test(store));
  add('store 有同步完成通知（就绪后自动刷新）', /export function onSyncDone/.test(store));
  add('同步开始/结束/失败都会改 phase',
    /state\.load\.phase = 'loading'/.test(store) && /state\.load\.phase = 'ready'/.test(store) &&
    /state\.load\.phase = 'error'/.test(store));
  add('登出时重置加载状态（避免看到上个账号的缓存）', /S\.resetLoad\(\)/.test(app));
  add('views 有统一的数据状态卡', /export function dataStateCard/.test(views));
  for (const fn of ['renderToday', 'renderStats']) {
    add(fn + ' 先判断数据状态再渲染', new RegExp(fn + '[\\s\\S]{0,220}dataStateCard').test(views));
  }
  add('词库空态区分"加载中"与"真的空"', /dataStateCard\(\{ loadingText: '正在取回你的词表/.test(views));
  add('学习页空态区分"加载中"与"真的空"', /dataStateCard\(\{ loadingText: '正在取回词库与学习计划/.test(views));
  add('app 有后台同步提示条', /class="sync-bar"/.test(app) && /\.sync-bar/.test(read('styles.css')));
  add('app 有手动重试入口', /async function resync/.test(app) && /#data-retry/.test(app));

  add('goalCard 的进度环与徽章同口径（三项等权）', /const parts = \[/.test(views) && /parts\.push\(testDone \? 1 : 0\)/.test(views));
  add('抽测单列一行并解释 7 天有效期', /7 天内做一次就算达标/.test(views));
  add('未做抽测时给出去练习场的按钮', /id="go-weekly-test"/.test(views) && /go\('games'\)/.test(views));
  add('休息日规则有说明', /今天是休息日：只复习、不引新词/.test(views));
  add('新词额度用完时说清"还有多少没学"', /今日新词额度已学完/.test(views));

  add('memoryMetrics 区分首次/非首次', /firstPassRate/.test(store) && /repeatPassRate/.test(store));
  add('memoryMetrics 返回统计日期范围', /range: stamps\.length/.test(store));
  add('统计页用同口径的 repeatPassRate 对比预测', /const gap = \(m\.predicted == null \|\| m\.repeatPassRate == null\)/.test(views));
  // 判据用旧实现的**特征句**而不是关键词：改动说明会写在注释里提到旧文案，
  // 直接搜关键词会把注释也算成"没改干净"。
  add('★ 删掉了"会认不会写"的武断归因', views.indexOf('抽测通过率偏低：说明') < 0);
  add('归因改成"可能原因"并要求样本量', /可能的原因不止一个/.test(views) && /m\.predN \|\| 0\) >= 100/.test(views));
  add('样本不足时明说"还看不出可靠差距"', /攒到 100 次以上再调留存率/.test(views));
  add('"最划算"改成模型估算', /模型估算/.test(views) && views.indexOf('届时复习最划算') < 0);
  // （原「提示/待复核暂无法统计」的断言已过时：2026-10-09 起这两项已经能统计，
  //   改由上面的「统计页展示判分维度」+「标注覆盖率」两条覆盖）

  add('抽测支持三种题型', /TEST_MODES/.test(game) && /test_mode/.test(read('js/config.js')));
  add('抽测选择题干扰项来自同批题（来源一致）', /function termChoices/.test(game));
  add('抽测选项一次性生成并挂到题目上（不随渲染乱跳）', /opts: useChoice \? opts : null/.test(game));
  add('抽测选择题作答记为"识别"', /choiceMode: true/.test(game) && /记为识别成绩/.test(views));
  add('例句填空提供"显示选项"辅助', /id="ans-assist"/.test(views) && /aux|assistShown/.test(views));
  add('★ 辅助作答不封顶到高分', /if \(a\.assist && a\.ok\) return 2/.test(views));
  add('答错时中途退出会提示成绩不保存', /成绩不会保存/.test(game));
  add('练习场有明确的 exitMode 出口', /export function exitMode/.test(game));
  add('再点练习场 tab 回模式选择', /tab === 'games' && current === 'games'/.test(app));
  add('空子模式不能困住用户', /modeIsEmpty/.test(game) && /GAME\.modeIsEmpty\(\)/.test(app));
  add('空关卡页有返回按钮', /id="quizsel-back"/.test(game));
  add('抽测写入状态显式展示',
    /已写入复习计划/.test(game) && /没有<\/b>开启练习自动写入/.test(game));
  add('不再把 source=test 塞给用户', game.indexOf('成绩单独记录（source=test）') < 0);

  /* 版本一致 */
  const files = ['index.html', 'sw.js'].concat(
    fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
  const versions = new Set();
  files.forEach((f) => { for (const m of read(f).matchAll(/\?v=(\d+)/g)) versions.add(m[1]); });
  const VER = [...versions][0];
  add('版本号唯一（v' + VER + '）', versions.size === 1, JSON.stringify([...versions]));

  console.log('静态契约：' + out.filter((o) => o.pass).length + '/' + out.length + ' 通过\n');

  /* ── 真浏览器 ── */
  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，已拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const url = 'http://127.0.0.1:' + PORT + '/';
  const port = 9993;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-states-' + Date.now()), url],
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] });
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break;
    }

    /* ── 01 LOAD：三个状态的文案必须不同 ── */
    await cdp.eval(forceLoad(VER, 'loading', {}));
    let r = await cdp.eval(readTabs);
    add('★ 加载中：今日页说"正在同步"，不说"任务完成"',
      /正在同步/.test(r.today.text) && r.today.text.indexOf('今天的任务完成了') < 0, JSON.stringify(r.today));
    add('★ 加载中：学习页不说"词库还是空的"',
      r.study.text.indexOf('词库还是空的') < 0 && /正在同步/.test(r.study.text), JSON.stringify(r.study));
    add('★ 加载中：词库页不说"词库还是空的"',
      r.library.text.indexOf('词库还是空的') < 0, JSON.stringify(r.library));
    add('★ 加载中：统计页不说"还没有复习数据"',
      r.stats.text.indexOf('还没有复习数据') < 0 && /正在同步/.test(r.stats.text), JSON.stringify(r.stats));

    await cdp.eval(forceLoad(VER, 'error', { error: 'QA 模拟断网' }));
    r = await cdp.eval(readTabs);
    add('★ 加载失败：今日页显示"数据没能加载"', /数据没能加载/.test(r.today.text), JSON.stringify(r.today));
    add('★ 加载失败：明确说数据没丢', /没有丢/.test(r.today.text), JSON.stringify(r.today));
    add('★ 加载失败：有重试按钮', r.today.hasRetry === true, JSON.stringify(r.today));
    add('★ 加载失败：错误原因被展示', /QA 模拟断网/.test(r.today.text), JSON.stringify(r.today));
    add('加载失败：学习页同样给重试', r.study.hasRetry === true, JSON.stringify(r.study));
    add('加载失败：词库页同样给重试', r.library.hasRetry === true, JSON.stringify(r.library));
    add('加载失败：统计页同样给重试', r.stats.hasRetry === true, JSON.stringify(r.stats));
    add('加载失败：练习场给出明确提示（不假装一切正常）',
      /没加载成功|暂时用不了/.test(r.games.text) || r.games.hasRetry === true,
      JSON.stringify(r.games.text.slice(0, 80)));

    console.log('三种状态下的"今日"页文案：');
    await cdp.eval(forceLoad(VER, 'ready', { hydrated: true }));
    r = await cdp.eval(readTabs);
    const readyToday = r.today.text.slice(0, 60).replace(/\s+/g, ' ');
    console.log('  ready   → ' + readyToday);
    add('★ 真正就绪且有数据：显示真实内容，不是状态卡',
      r.today.hasRetry === false && /待复习/.test(r.today.text), JSON.stringify(r.today));

    /* 真的没数据（加载完成 + 空）也要说"空" */
    await cdp.eval(forceLoad(VER, 'ready', { hydrated: false }));
    r = await cdp.eval(readTabs);
    add('加载完成但真的没数据：才允许说"词库还是空的"',
      /词库还是空的/.test(r.library.text) || /词库还是空的/.test(r.study.text),
      JSON.stringify({ lib: r.library.emptyBig, study: r.study.emptyBig }));

    /* ── 08 GOAL：进度环与徽章不再自相矛盾 ── */
    const today = new Date();
    const dk = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    let g = await cdp.eval(seedToday(VER, { reviewed_on: dk, total: 20, correct: 18, new_words: 8, minutes: 15 }));
    add('★ 目标卡出现抽测行', /抽测/.test(g.text), JSON.stringify(g.text.slice(0, 120)));
    add('★ 未做抽测时给出"7 天内做一次"的解释', /7 天内做一次就算达标/.test(g.text), JSON.stringify(g.text));
    add('★ 未做抽测时提供直达按钮', g.hasTestBtn === true);
    const pm = g.text.match(/(\d+)%/);
    add('★ 复习与新学都达成、但缺抽测时，进度环不得显示 100%',
      !pm || Number(pm[1]) < 100, '环上显示 ' + (pm && pm[1]) + '%');
    add('★ 徽章与环一致（提示还差抽测）', /还差/.test(g.text) && /抽测/.test(g.text), JSON.stringify(g.text));

    /* ── 07 METRIC：同口径 + 无武断归因 ── */
    const metricCopy = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      const V = await import('./js/views.js?v=${VER}');
      // 合成日志：同一张卡 4 次复习，首次错、后面全对 → 首次通过率必须低、总体通过率高
      const mk = (id, grade, src, day) => ({
        card_id: 'mc' + id, grade: grade, source: src, elapsed_ms: 3000,
        prev_state: { stability: 5 }, created_at: new Date(Date.now() - day * 86400000).toISOString(),
      });
      const rows = [mk(1, 1, 'study', 40), mk(1, 4, 'study', 30), mk(1, 4, 'study', 20), mk(1, 4, 'study', 10)];
      const m = S.memoryMetrics(rows);
      S.state.load.phase = 'ready'; S.state.load.hydrated = true;
      window.__lexiloopRender();
      return { first: m.firstPassRate, overall: m.passRate, firstN: m.firstN, n: m.n, range: m.range, predN: m.predN };
    })()`);
    add('★ 一次通过率只算首次（本例首次错 → 0%）',
      metricCopy && metricCopy.first === 0, JSON.stringify(metricCopy));
    add('★ 总体通过率含全部（本例 3/4 → 75%）',
      metricCopy && metricCopy.overall === 75, JSON.stringify(metricCopy));
    add('★ 两者不再混为一谈（first ≠ overall）',
      metricCopy && metricCopy.first !== metricCopy.overall, JSON.stringify(metricCopy));
    add('统计覆盖范围带明确日期', metricCopy && metricCopy.range && !!metricCopy.range.from, JSON.stringify(metricCopy));

    /* 统计页的记忆指标是异步拉日志后渲染的，这里等它出来再断言 */
    const statTxt = await cdp.eval(`(async function(){
      document.querySelector('[data-tab="stats"]').click();
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (document.getElementById('main').textContent.indexOf('记忆指标') >= 0 &&
            document.getElementById('main').textContent.indexOf('正在加载复习日志') < 0) break;
      }
      return document.getElementById('main').textContent;
    })()`);
    add('★ 归因不说"会认不会写"', String(statTxt).indexOf('会认不会写') < 0, String(statTxt).slice(0, 60));
    // 文案说明放在源码里断言：统计卡是异步渲染的，等不到时就测不到文案
    add('统计页说明两个通过率的区别',
      /一次通过率<\/b>只算每张卡的第一次复习/.test(views) && /总体通过率<\/b>含全部复习/.test(views) &&
      /和它对比要用同口径/.test(views), '源码里没有口径说明');
    add('统计页展示判分维度（提示/辅助/替代表达/待复核）',
      /判分维度（有记录的/.test(views) && /无法自动判定（未计错）/.test(views));
    add('★ 判分维度标注覆盖率，不拿旧日志假装"0 次误判"',
      /老日志里没有，所以现在显示为空是正常的/.test(views));
    add('reviews 表写入判分维度', /verdict: log\.verdict \|\| null/.test(store) &&
      /hinted: log\.hinted === true/.test(store) && /assisted: log\.assisted === true/.test(store));
    add('拉取日志时带上新字段', /verdict, hinted, assisted/.test(store));
    add('★ 抽测没写成功就不记"这周做过抽测"', /source === 'test' && n > 0/.test(store));

  /* 11 MASTERY / 12 ERROR / 09 CONTENT / 10 DIALOGUE / 13 SRS */
  add('★ 掌握状态改称"记忆稳定"并解释它≠会用', /记忆稳定/.test(views) &&
    /它说明<b>记得住<\/b>，不等于<b>能主动用出来<\/b>/.test(views));
  add('能力标签不再用"已掌握"这种断言式说法',
    views.indexOf("'已掌握'") < 0 && views.indexOf('>已掌握 ') < 0);
  add('★ leech 文案改成可能原因清单，不再断言"问题在卡片"',
    /原因不止一个/.test(views) && views.indexOf('问题多半在卡片本身') < 0);
  add('★ 薄弱词与专练用同一阈值（忘记 ≥2 次）',
    /weakCards\(2\)/.test(store) && /weakCards\(1\)/.test(store) === false);
  add('薄弱词卡片写明选样规则', /选样规则：<b>忘记次数 ≥ 2 次<\/b>/.test(views));
  add('专练抽 20 张的补足规则写明', /不够 20 张时用今天到期的复习卡补足/.test(views));
  add('★ 模型置信度不写成"准确率"', views.indexOf('模型置信度') < 0 &&
    /模型自评把握/.test(views) && /未经验证/.test(views));
  add('低把握时提示核实而不是吓人', /自评把握偏低，建议对照词典核实/.test(views));
  add('★ 对话目标为空时转为"自由聊天"并说明不计命中',
    /freeMode: targets\.length === 0/.test(game) && /不计目标命中/.test(game));
  add('★ 堆词不点亮目标', /stuffed/.test(game) && /没有点亮目标/.test(game));
  add('AI 失败后可重发这一句', /id="chat-retry"/.test(game) && /lastInput/.test(game));
  add('AI 失败不算"学不会"（文案已说明）', /不影响已记录的内容/.test(game));
  add('FSRS 同日复习有短期项', /export function nextShortTermStability/.test(read('js/fsrs.js')) &&
    /SAME_DAY_DAYS/.test(read('js/fsrs.js')));
  add('FSRS 自检覆盖同日与缺失 last_review_at',
    /同日重复复习（记得）后稳定度没有增长/.test(read('js/fsrs.js')) &&
    /last_review_at 缺失时稳定度不增长/.test(read('js/fsrs.js')));

    /* ── 06 CHOICE：例句填空的"显示选项" ── */
    const assist = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      const V = await import('./js/views.js?v=${VER}');
      S.state.user = { id: 'qa-probe' };
      // 必须给够词条：选项池是从**别的词条**里抽的，只有一个词时凑不出干扰项
      S.state.words = ['deal with','handle','cope with','address','tackle'].map((t, i) => ({
        id: 'aw' + i, normalized: t, lemma: t,
        payload: { senses: [{ pos: 'verb', def_zh: '处理' + i }],
          collocations: [{ pattern: t, examples: [{ en: 'He had to ' + t + ' it.', zh: '他得处理。' }] }] } }));
      // 干扰项池来自**全部** state.cards，队列来自 buildQueue。
      // 所以把后 4 个词条标成 suspended：它们只当选项池，不进今天的队列 ——
      // 这样当前卡就唯一确定是 deal with，断言才有确定的对象。
      S.state.cards = [0,1,2,3,4].map((i) => ({
        id: 'ac' + i, word_id: 'aw' + i, card_type: 'cloze', status: 'new',
        suspended: i > 0, lapses: 0, reps: 0, deck: '', due: null, stability: 0, difficulty: 5 }));
      S.state.settings.daily_new = 1; S.state.settings.daily_max_review = 0;
      S.state.settings.rest_weekday = null; S.state.settings.card_types = ['cloze'];
      S.state.load.phase = 'ready'; S.state.load.hydrated = true; S.state.daily = [];
      S.reindex(); V.resetSession();
      window.__lexiloopRender();
      await new Promise(r => setTimeout(r, 150));
      document.querySelector('[data-tab="study"]').click();
      await new Promise(r => setTimeout(r, 250));
      // ★ 输入框要在**作答之前**检查：答完之后输入框本来就会消失，
      //   在答完后断言"还有输入框"是把正常行为当成了缺陷。
      const hasInput = !!document.getElementById('ans-in');
      const hintBefore = (document.querySelector('.qcard') || {}).textContent || '';
      const btn = document.getElementById('ans-assist');
      const hasBtn = !!btn;
      if (btn) { btn.click(); await new Promise(r => setTimeout(r, 200)); }
      const choices = document.querySelectorAll('.choice').length;
      let fb = '';
      let picked = '';
      if (choices) {
        const all = Array.from(document.querySelectorAll('.choice'));
        // 选"正确"那一项：队列首张是 deal with（daily_new=1）
        let target = all[0];
        for (const c of all) { if (c.textContent.indexOf('deal with') >= 0) target = c; }
        picked = target.textContent;
        target.click();
        await new Promise(r => setTimeout(r, 250));
        fb = (document.querySelector('.verdict') || {}).textContent || '';
      }
      return { hasBtn: hasBtn, choices: choices, fb: fb, picked: picked,
               hasInput: hasInput, hintBefore: hintBefore.slice(0, 60),
               inputGoneAfter: !document.getElementById('ans-in') };
    })()`);
    add('★ 例句填空题保留输入框（主路径不变）', assist && assist.hasInput === true, JSON.stringify(assist));
    add('★ 题干是例句填空（不是选择题）', assist && /打出来|空缺/.test(assist.hintBefore), JSON.stringify(assist.hintBefore));
    add('★ 提供"显示选项"按钮', assist && assist.hasBtn === true, JSON.stringify(assist));
    add('★ 点开后出现 4 个选项', assist && assist.choices >= 4, JSON.stringify(assist));
    add('★ 选对后明说"不算无提示产出"',
      /不算无提示产出/.test(assist.fb), JSON.stringify({ fb: assist.fb, picked: assist.picked }));

    /* ── 05 NAV：空关卡能退出 ── */
    const nav = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      S.state.words = []; S.state.cards = []; S.reindex();
      S.state.load.phase = 'ready'; S.state.load.hydrated = false;
      const G = await import('./js/game.js?v=${VER}');
      G.exitMode();
      window.__lexiloopRender();
      await new Promise(r => setTimeout(r, 120));
      // 直接进"情景闯关"的子模式（关卡来自语料章节，此处为空）
      const gm = await import('./js/game.js?v=${VER}');
      const before = document.getElementById('main').textContent;
      // 再点一次练习场 tab：应当回到模式选择而不是留在空关卡
      document.querySelector('[data-tab="games"]').click();
      await new Promise(r => setTimeout(r, 150));
      return { ok: true, after: document.getElementById('main').textContent.slice(0, 60) };
    })()`);
    add('练习场能回到首页（不会困在子页）', nav && nav.ok === true, JSON.stringify(nav));

    /* ── 06 内容缺失的空壳词条不进队列（2026-10-15 用户实测）──
       场景：导入词单时把"分组标题/主题名"当成词条收进来（warm professional english /
       chain 2 campus safety …），生成流程尝试过（enrich_attempted）但产出为空 →
       卡片照样排队，界面要求"回想它的搭配与例句"，可它一条搭配都没有。 */
    const empty = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      S.state.load.phase = 'ready'; S.state.load.hydrated = true;
      S.state.words = [
        { id: 1, normalized: 'deal with', lemma: 'deal with',
          payload: { senses: [{ def_zh: '处理' }],
            collocations: [{ pattern: 'deal with (sth)', examples: [{ en: 'We dealt with it.', zh: '我们处理了它。' }] }] } },
        { id: 2, normalized: 'chain 2 campus safety', lemma: 'chain 2 campus safety',
          payload: { enrich_attempted: true } },
      ];
      S.state.cards = [
        { id: 'g1', word_id: 1, card_type: 'recognition', status: 'new', suspended: false,
          lapses: 0, reps: 0, deck: '', due: null, stability: 0, difficulty: 5 },
        { id: 'e1', word_id: 2, card_type: 'recognition', status: 'new', suspended: false,
          lapses: 0, reps: 0, deck: '', due: null, stability: 0, difficulty: 5 },
        /* 卡片引用的词条**缺失**（数据完整性问题）：不能因为"读不到词条"就静默消失，
           那会把真正的问题藏起来 —— fail-open，照常进队列，由数据状态层负责报错。 */
        { id: 'm1', word_id: 999, card_type: 'recognition', status: 'new', suspended: false,
          lapses: 0, reps: 0, deck: '', due: null, stability: 0, difficulty: 5 },
      ];
      S.reindex();
      const news = S.newCards().map((c) => c.id);
      const reasons = S.blockedWords().map((w) => S.blockReason(w));
      document.querySelector('[data-tab="stats"]').click();
      await new Promise((r) => setTimeout(r, 300));
      const stats = document.getElementById('main').textContent || '';
      return { news: news, reasons: reasons,
               hasCard: /待审核内容/.test(stats), hasEmpty: /内容缺失/.test(stats),
               names: S.blockedWords().map((w) => w.normalized) };
    })()`);
    add('★ 内容缺失的空壳词条不进新卡队列（有内容的照常进）',
      empty && empty.news.indexOf('e1') < 0 && empty.news.indexOf('g1') >= 0, JSON.stringify(empty));
    add('★ 词条读不到时 fail-open：卡片不因数据缺失而静默消失',
      empty && empty.news.indexOf('m1') >= 0, JSON.stringify(empty));
    add('★ 空壳词条被判为 empty（与 flagged/suspect 分开）',
      empty && (empty.reasons || []).indexOf('empty') >= 0, JSON.stringify(empty));
    add('★ 统计页「待审核内容」把"内容缺失"单列说明（不是笼统一句）',
      empty && empty.hasCard === true && empty.hasEmpty === true, JSON.stringify(empty));

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
  console.log('\n===== 状态/口径/出口质检: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
