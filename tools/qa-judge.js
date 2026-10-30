'use strict';
/* LexiLoop · 判分公平性 + 题量计数 专项回归
   对应用户截图里的两个 P0：

   ① address 被判错（截图 1）：判分只有"对/错"两态，没有任何语义层。
      新内核拆成四态 hit / alt / wrong / unsure，且未命中目标**不等于**错。
      本文件覆盖：归一化、漏空格、词形变化、英美拼写、相似度、
      以及旧实现那条"去掉尾字母看前缀"规则造成的 great/greasy 误判。
   ② 29/26（截图 3）：分子分母单位不同（重试也加分子），且没有终止条件。
      本文件用真浏览器走一遍"连续答错同一张卡"，断言分子永不超过分母。

   用法：node tools/qa-judge.js */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8885;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

const APP = path.resolve(__dirname, '..', 'lexiloop');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

/* ═══════════ 第一部分：判分内核（纯逻辑，Node 里直接跑） ═══════════ */

async function unitJudge() {
  // judge.js 是 ES module 且无相对依赖，复制成 .mjs 就能直接在 Node 里 import
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gll-judge-'));
  const dst = path.join(dir, 'judge.mjs');
  fs.copyFileSync(path.join(APP, 'js', 'judge.js'), dst);
  const J = await import(pathToFileURL(dst).href);
  fs.rmSync(dir, { recursive: true, force: true });

  const v = (g, e, o) => J.judgeTyped(g, e, o).verdict;

  // ── 目标命中 ──
  add('精确命中 → hit', v('deal with', 'deal with') === 'hit');
  add('大小写不敏感 → hit', v('Deal With', 'deal with') === 'hit');
  add('漏空格（手机手误）→ hit', v('dealwith', 'deal with') === 'hit');
  add('多空格 → hit', v('deal   with', 'deal with') === 'hit');
  add('标点差异 → hit', v('deal with.', 'deal with') === 'hit');
  add('冠词差异 → hit', v('deal with the issue', 'deal with issue') === 'hit');

  // ── 词形变化 / 英美拼写（严格等价才放行）──
  add('词形变化 dealt → hit', v('dealt with', 'deal with') === 'hit');
  add('词形变化 -ing → hit', v('dealing with', 'deal with') === 'hit');
  add('英美拼写 colour → hit', v('colour', 'color') === 'hit');
  add('英美拼写 organize → hit', v('organize', 'organise') === 'hit');

  // ── ★ 回归：旧实现"去掉尾字母看前缀"造成的语义无关误判 ★ ──
  // 旧规则：expected 的词 ≥5 字母时，去掉最后一个字母后若是作答的前缀就通过。
  // 'great'.slice(0,-1) = 'grea'，'greasy'.indexOf('grea') === 0 → 旧版会判 great = greasy。
  const oldRule = (g, e) => {
    const ew = e.split(' '); const gw = g.split(' ');
    return ew.length >= 2 && ew.every((w) => gw.some((x) =>
      x === w || (w.length >= 5 && x.indexOf(w.slice(0, w.length - 1)) === 0)));
  };
  add('前置：旧规则确实会误判（证明这个回归用例有意义）',
    oldRule('greasy time good', 'great time good') === true);
  add('★ great time ≠ greasy time（旧误判已修）', v('greasy time good', 'great time good') !== 'hit');

  // ── 相似度：拼写错误算过，但要用错词就是错 ──
  add('轻度拼写错误 → hit + typo', J.judgeTyped('deal wiht', 'deal with').typo === true);
  add('空作答 → empty', J.judgeTyped('', 'deal with').empty === true);
  add('完全不同的词 → 未命中', v('zebra', 'deal with') !== 'hit');
  add('错误介词（deal in）未命中目标', v('deal in', 'deal with') !== 'hit');

  // ── 可接受替代表达集合（经审核的答案）──
  add('可接受集合命中 → alt', v('address', 'deal with', { accept: ['address', 'handle'] }) === 'alt');
  add('alt 的 ok=true（英语是对的）', J.judgeTyped('address', 'deal with', { accept: ['address'] }).ok === true);
  add('alt 的 target=false（目标没提取出来）',
    J.judgeTyped('address', 'deal with', { accept: ['address'] }).target === false);
  add('不在集合里的词仍不通过', v('zebra', 'deal with', { accept: ['address'] }) !== 'alt');

  /* ── ★ 词形变体的问法选择（2026-10-14）──
     触发条件必须**同时**满足：句子是挖空版 + 作答与目标同词干不同词形。
     条件放宽会把"语义替代表达"（address / deal with）也误当成词形问题 ——
     那类必须留在通用问法里（它要判的是"意思对不对"，不是"语法成不成立"）。 */
  const fm = J.__prompts().formMode;
  add('★ 词形变体：compliments / complimented + 挖空句 → 专用问法',
    fm({ expected: 'complimented', given: 'compliments', sentence: 'She ________ him on his skills.' }) === true,
    '应走专用问法');
  add('词形变体：句子含 yesterday 也走专用问法（语法成立与否交给模型判，规则不拦）',
    fm({ expected: 'complimented', given: 'compliments', sentence: 'She ______ him yesterday.' }) === true);
  add('★ 不同词干（address vs deal with）→ 回通用问法',
    fm({ expected: 'deal with', given: 'address', sentence: 'The manager had to ___ complaints.' }) === false,
    '不能误判成词形变体');
  add('词形变体：句子没有空缺（中→英）→ 回通用问法',
    fm({ expected: 'complimented', given: 'compliments', sentence: '' }) === false);
  add('词形变体：作答与目标同形 → 不需要问法切换',
    fm({ expected: 'complimented', given: 'complimented', sentence: 'She ________ him.' }) === false);
  add('★ 词形变体：不规则屈折（deal / dealt）不硬判',
    fm({ expected: 'deal', given: 'dealt', sentence: 'They ___ with it.' }) === false);
  add('★ 词形变体：短语仅一个词形变化时走整句复核，不直接判对',
    fm({ expected: 'deal with', given: 'deals with', sentence: 'She ___ it.' }) === true);

  // ── 语义复核（stub 掉 LLM，只验协议与降级）──
  add('looksLikeEnglishPhrase：address 值得复核', J.looksLikeEnglishPhrase('address') === true);
  add('looksLikeEnglishPhrase：多词短语可以', J.looksLikeEnglishPhrase('if you have a moment') === true);
  add('looksLikeEnglishPhrase：乱码不送复核', J.looksLikeEnglishPhrase('asdkj@#$%') === false);
  add('looksLikeEnglishPhrase：单字母不送复核', J.looksLikeEnglishPhrase('a') === false);
  add('looksLikeEnglishPhrase：超长串不送复核', J.looksLikeEnglishPhrase('x'.repeat(60)) === false);

  const r1 = await J.reviewSemantics({
    expected: 'deal with', given: 'address', zh: '处理',
    chat: async () => '{"verdict":"alt"}',
  });
  add('复核返回 alt 被正确解析', r1.verdict === 'alt', JSON.stringify(r1));

  const r2 = await J.reviewSemantics({
    expected: 'deal with', given: 'address', zh: '处理',
    chat: async () => '{"verdict":"alt"}',
  });
  add('复核结果走缓存（第二次不再请求）', r2.cached === true, JSON.stringify(r2));

  const r3 = await J.reviewSemantics({
    expected: 'alpha', given: 'beta', chat: async () => '```json\n{"verdict":"wrong"}\n```',
  });
  add('模型裹 ```json 也能解析', r3.verdict === 'wrong', JSON.stringify(r3));

  const r4 = await J.reviewSemantics({
    expected: 'gamma', given: 'delta', chat: async () => { throw new Error('网络炸了'); },
  });
  add('★ 复核请求失败 → null（绝不返回 wrong）', r4.verdict === null, JSON.stringify(r4));

  const r5 = await J.reviewSemantics({
    expected: 'epsilon', given: 'zeta', chat: async () => '抱歉我不确定',
  });
  add('★ 复核返回无法解析 → null（不判错）', r5.verdict === null, JSON.stringify(r5));

  const r6 = await J.reviewSemantics({
    expected: 'eta', given: 'theta', chat: async () => new Promise((r) => setTimeout(() => r('{"verdict":"alt"}'), 30000)),
  });
  add('★ 复核超时 → null（不判错）', r6.verdict === null, '6 秒超时未生效？');

  add('无 chat 函数时安全返回 null',
    (await J.reviewSemantics({ expected: 'a b', given: 'c d' })).verdict === null);
}

/* ═══════════ 第二部分：真浏览器（判分 UI + 题量计数） ═══════════ */

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
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __err: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

/* 注入合成卡并进入学习页：n 张卡，方便精确控制计数 */
const seed = (ver, n, cardType) => `(async function(){
  const S = await import('./js/store.js?v=${ver}');
  const V = await import('./js/views.js?v=${ver}');
  S.state.words = Array.from({length: ${n}}, (_, i) => ({
    id: 'jw' + i, normalized: 'term' + i, lemma: 'term' + i,
    payload: { senses: [{ pos: 'verb', def_zh: '意思' + i }],
               collocations: [{ pattern: 'term' + i + ' with', zh: '处理；应对',
                 examples: [{ en: 'He had to term' + i + ' with it.', zh: '他得处理。' }] }] }
  }));
  S.state.cards = Array.from({length: ${n}}, (_, i) => ({
    id: 'jc' + i, word_id: 'jw' + i, card_type: '${cardType || 'recognition'}', status: 'new',
    suspended: false, lapses: 0, reps: 0, deck: '', due: null, stability: 0, difficulty: 5
  }));
  S.state.settings.daily_new = ${n}; S.state.settings.daily_max_review = 0;
  S.state.settings.rest_weekday = null;   // 保证不是休息日
  S.state.settings.card_types = ['${cardType || 'recognition'}'];
  S.state.daily = [];
  S.reindex();
  V.resetSession();            // 显式重置，保证队列 = 刚注入的这批卡
  window.__lexiloopRender();
  await new Promise(r => setTimeout(r, 100));
  document.querySelector('[data-tab="study"]').click();
  await new Promise(r => setTimeout(r, 250));
  return {
    onStudy: !!document.querySelector('.study-bar'),
    bar: (document.querySelector('.study-bar .tiny') || {}).textContent || '',
    ask: (document.querySelector('.qcard .ask') || {}).textContent || '',
    hasInput: !!document.querySelector('#ans-in'),
  };
})()`;

/** 读进度条文字 + 副行 + 百分比宽度 */
const readBar = `(function(){
  const t = document.querySelector('.study-bar .tiny');
  const i = document.querySelector('.study-bar .progress i');
  const p = Array.from(document.querySelectorAll('.study p.tiny'))
    .map(x => x.textContent).find(x => x.indexOf('共作答') >= 0) || '';
  return { count: t ? t.textContent.trim() : '',
           width: i ? i.style.width : '',
           sub: p.trim(),
           grading: !!document.querySelector('[data-g]') };
})()`;

/** 学习页一次完整动作：揭晓答案 → 点评分。评分按钮只在揭晓后才出现。 */
async function answerOnce(cdp, grade) {
  await cdp.eval(`(function(){
    const rev = document.getElementById('ans-reveal') || document.getElementById('reveal');
    if (rev) rev.click();
    return !!rev;
  })()`);
  await sleep(260);
  const r = await cdp.eval(`(function(){
    const b = document.querySelector('[data-g="${grade}"]');
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(420);
  return r;
}

(async () => {
  await unitJudge();
  console.log('判分内核：' + out.filter((o) => o.pass).length + '/' + out.length + ' 通过\n');

  /* 版本号动态取，避免硬编码漂移 */
  const files = ['index.html', 'sw.js'].concat(
    fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
  const versions = new Set();
  files.forEach((f) => { for (const m of read(f).matchAll(/\?v=(\d+)/g)) versions.add(m[1]); });
  const VER = versions.size === 1 ? [...versions][0] : [...versions][0];
  add('版本号唯一（判分/计数的补丁必须整包上线）', versions.size === 1, JSON.stringify([...versions]));

  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，已拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const url = 'http://127.0.0.1:' + PORT + '/';
  const port = 9989;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-judge2-' + Date.now()), url],
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

    /* ── A. 计数：单张卡连答错三次，分子必须始终 ≤ 分母 ── */
    let r = await cdp.eval(seed(VER, 1));
    add('前置：单张卡队列显示 0 / 1', r && r.onStudy === true && r.bar === '0 / 1', JSON.stringify(r));

    /* ★ 2026-10-17 修复后的语义：**单张轮次答错即收尾**。
       旧实现把卡排回队尾 → 进度早已 1 / 1，却继续原地问同一题
       （用户实测："答完后只要是错了就会无限要求答下去"）。 */
    await answerOnce(cdp, 1);
    const a1 = await cdp.eval(`(function(){
      return { finished: !document.querySelector('.study-bar'),
               text: (document.querySelector('.study .empty') || document.body).textContent.slice(0, 100) };
    })()`);
    add('★ 单张轮次答错即收尾（不再原地反复问同一题）', a1 && a1.finished === true, JSON.stringify(a1));
    const a2 = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      const c = S.state.cards.find((x) => x.id === 'jc0');
      return { status: c && c.status, due: c ? !!c.due : false, lapses: c ? c.lapses : null };
    })()`);
    add('★ 单张轮次答错后，卡已按"忘了"排进复习计划（不是被吞掉）',
      a2 && a2.status && a2.status !== 'new' && a2.due === true, JSON.stringify(a2));

    /* ── A2. 多张轮次：答错仍要排回队尾重试（旧行为必须保留），
       同时守住"分子 ≤ 分母"（29/26）与"两个数字各有单位"。
       用 3 张卡：只有到第 2 次作答同一张卡才会计入"答错重做"，
       所以要留一张还在队里，副行才渲染得出来。 ── */
    let rThree = await cdp.eval(seed(VER, 3));
    add('前置：三张卡队列显示 0 / 3', rThree && rThree.onStudy === true && rThree.bar === '0 / 3', JSON.stringify(rThree));
    await answerOnce(cdp, 1);          // 第 1 张答错 → 排回队尾
    const b2 = await cdp.eval(readBar);
    add('★ 多张轮次答错仍重排：完成 1 / 3（不是 1 / 1）', b2 && b2.count === '1 / 3', JSON.stringify(b2));
    add('★ 宽度不是 100%（不虚报满格）', b2 && b2.width !== '100%', b2 && b2.width);
    add('第 1 次答错还没有重试副行（"答错重做"从第 2 次作答起算）', b2 && b2.sub === '', b2 && b2.sub);

    // 再答两张（1 错 1 对）→ 回到排回队尾的第 1 张做第 2 次 → 计入"答错重做"
    await answerOnce(cdp, 1);
    await answerOnce(cdp, 3);
    await answerOnce(cdp, 3);
    const b3 = await cdp.eval(readBar);
    /* ★ 两个数字必须各自带单位：张数（计划 N 张）vs 作答次数（共作答 M 次）。
       旧文案"本轮卡片 20 / 20 · 累计作答 22 次"被用户读成"上限 20 怎么会有 22"（2026-10-14）。 */
    add('★ "本轮计划 3 张 / 共作答 4 次 / 答错重做 1 次"说明行（单位分开说）',
      /本轮计划 3 张/.test(b3.sub) && /共作答 4 次/.test(b3.sub) && /答错重做 1 次/.test(b3.sub), b3.sub);
    add('★ 分子不超过分母（完成 3 / 3）', b3 && b3.count === '3 / 3', JSON.stringify(b3));

    /* ★ 新文案比旧文案长，必须在最窄的 iPhone SE（375px）上实测不溢出：
       只在 393 看会漏掉 SE 这一档，而它正是学生手里最常见的小屏。 */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
    const sub375 = await cdp.eval(`(function(){
      const el = Array.from(document.querySelectorAll('.study p.tiny'))
        .find(x => x.textContent.indexOf('共作答') >= 0);
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      return { found: true, over: Math.round(r.right - window.innerWidth),
               sw: el.scrollWidth, cw: el.clientWidth, winW: window.innerWidth,
               docW: document.documentElement.scrollWidth };
    })()`);
    add('★ 副行在 375px（iPhone SE）下不横向溢出、文字不被裁切',
      sub375 && sub375.found === true && sub375.over <= 1 &&
      sub375.sw <= sub375.cw + 1 && sub375.docW <= sub375.winW + 1,
      JSON.stringify(sub375));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });

    // 收尾：队里还排回着第 2 张 → 答完即进入完成页，不出现 4 / 3
    await answerOnce(cdp, 3);
    const b4 = await cdp.eval(`(function(){
      return { finished: !document.querySelector('.study-bar') };
    })()`);
    add('★ 收尾后进入完成页（不出现 4 / 3 这种越界显示）', b4 && b4.finished === true, JSON.stringify(b4));

    /* ── C. 轻松卡（bonus）不能每次都是同一张（2026-10-19 用户实测）──
       旧实现 `state.cards.find(...)` —— 数组顺序稳定，命中永远是最先那张已掌握卡；
       'stemming from' 的例句卡 5 天被抽 12 次、reps 37。现在要求：
       3 天冷却 + 取"最久没见"的那张（自然轮换）。 */
    const bonusSeed = await cdp.eval(`(async function(){
      const S = await import('./js/store.js?v=${VER}');
      const V = await import('./js/views.js?v=${VER}');
      const now = Date.now();
      S.state.words = [0,1,2,3,4].map((i) => ({ id: 'bw' + i, normalized: 'term' + i, lemma: 'term' + i,
        payload: { senses: [{ def_zh: '意思' + i }],
          collocations: [{ pattern: 'term' + i + ' up', examples: [{ en: 'We term' + i + ' up.', zh: '例句' }] }] } }));
      const mk = (id, wi, o) => Object.assign({ id: id, word_id: 'bw' + wi, card_type: 'recognition',
        status: 'review', suspended: false, lapses: 0, reps: 3, deck: '', stability: 3, difficulty: 5,
        due: new Date(now - 3600e3).toISOString(), last_grade: 2, last_review_at: now - 4 * 864e5 }, o || {});
      S.state.cards = [
        /* 已掌握但"昨天刚复习过"，且排在数组最前 —— 旧实现必然抽它 */
        mk('be1', 4, { stability: 36500, difficulty: 1, last_grade: 4,
          due: new Date(now + 3650 * 864e5).toISOString(), last_review_at: now - 1 * 864e5 }),
        mk('bd1', 0), mk('bd2', 1), mk('bd4', 2),
        /* 已掌握且 5 天没见 —— 冷却后应当选它 */
        mk('bd3', 3, { stability: 60, difficulty: 4, last_grade: 4,
          due: new Date(now + 365 * 864e5).toISOString(), last_review_at: now - 5 * 864e5 }),
      ];
      S.state.settings.daily_new = 0; S.state.settings.daily_max_review = 50;
      S.state.settings.rest_weekday = null; S.state.settings.card_types = ['recognition'];
      S.state.daily = []; S.reindex(); V.resetSession(); window.__lexiloopRender();
      await new Promise((r) => setTimeout(r, 150));
      document.querySelector('[data-tab="study"]').click();
      await new Promise((r) => setTimeout(r, 280));
      return { bar: (document.querySelector('.study-bar .tiny') || {}).textContent || '' };
    })()`);
    add('前置：三张到期卡 + 两张已掌握卡', bonusSeed && bonusSeed.bar === '0 / 3', JSON.stringify(bonusSeed));
    await answerOnce(cdp, 2);      // 吃力
    await answerOnce(cdp, 2);      // 再吃力 → 触发"轻松卡"
    const bonusIds = await cdp.eval(`(async function(){
      const V = await import('./js/views.js?v=${VER}');
      return V.sessionQueueIds();
    })()`);
    add('★ 轻松卡跳过"刚复习过"的已掌握卡（3 天冷却）',
      Array.isArray(bonusIds) && bonusIds.indexOf('be1') < 0, JSON.stringify(bonusIds));
    add('★ 轻松卡改抽"最久没见"的那张（不再永远是同一张）',
      Array.isArray(bonusIds) && bonusIds.indexOf('bd3') >= 0, JSON.stringify(bonusIds));
    add('计划内卡片不受影响（bd4 仍在队列里）',
      Array.isArray(bonusIds) && bonusIds.indexOf('bd4') >= 0, JSON.stringify(bonusIds));

    /* ── B. 计数：4 张卡走完全程，分子追平分母且从不超出 ── */
    let r4 = await cdp.eval(seed(VER, 4));
    add('前置：四张卡队列显示 0 / 4', r4 && r4.bar === '0 / 4', JSON.stringify(r4));
    let maxSeen = 0;
    let overflow = false;
    let steps = 0;
    let lastCount = '';
    for (let i = 0; i < 16; i++) {
      const clicked = await answerOnce(cdp, 4);
      if (!clicked) break;
      steps++;
      const st = await cdp.eval(readBar);
      if (st && st.count) lastCount = st.count;
      const m = /^(\d+)\s*\/\s*(\d+)$/.exec((st && st.count) || '');
      if (m) {
        maxSeen = Math.max(maxSeen, Number(m[1]));
        if (Number(m[1]) > Number(m[2])) overflow = true;
      }
    }
    const fin = await cdp.eval(`(function(){
      return { finished: !document.querySelector('.study-bar'),
               hasEmpty: !!document.querySelector('#study-again'),
               heading: (document.querySelector('.empty .big') || {}).textContent || '' };
    })()`);
    add('★ 全程 16 次操作中分子从未超过分母（29/26 不再出现）', overflow === false,
      '出现过 x > N');
    add('★ 四张卡全部答完后进入完成页', fin && fin.finished === true && fin.hasEmpty === true,
      JSON.stringify(fin) + ' steps=' + steps);
    add('★ 最后可见进度是 3 / 4，第 4 张答完即结束（不存在 5 / 4）',
      lastCount === '3 / 4', 'lastCount=' + lastCount);
    add('★ 答对不会触发重排（4 步就走完，没有多余轮次）', steps === 4, 'steps=' + steps);

    /* ── C. 集成：答错 → 语义复核 → 不判错（真实 UI 路径） ── */
    const submitGiven = (val) => `(async function(){
      const i = document.getElementById('ans-in');
      if (!i) return { no: 'input' };
      i.value = ${JSON.stringify(val)};
      document.getElementById('ans-go').click();
      await new Promise(r => setTimeout(r, 400));
      return { fb: (document.querySelector('.verdict') || {}).textContent || '',
               cls: (document.querySelector('.verdict') || {}).className || '',
               cardOk: !!document.querySelector('.verdict.good') };
    })()`;

    // ① 缓存里已经有结论（这台设备以前判过）→ 应当立刻给出"你的表达也对"
    await cdp.eval(`(async function(){
      const J = await import('./js/judge.js?v=${VER}');
      J.clearJudgeCache();
      J.__seedJudgeCache('term0 with', 'address', 'alt');   // 走模块钩子，不硬编码缓存键
      return true;
    })()`);
    let s = await cdp.eval(seed(VER, 1, 'cloze'));
    add('前置：例句填空题已渲染出输入框', s && s.hasInput === true, JSON.stringify(s));
    let r1 = await cdp.eval(submitGiven('address'));
    add('★ 提交 address（缓存已判为合理表达）→ 显示"你的表达也对"',
      /你的表达也对/.test(r1.fb), JSON.stringify(r1));
    add('★ 该反馈用绿色判定条，不是红条', /verdict good/.test(r1.cls), r1.cls);
    add('★ 反馈里绝不含"不对"两个字', r1.fb.indexOf('不对') < 0, r1.fb);
    add('反馈同时点明本题目标搭配 term0 with', /term0 with/.test(r1.fb), r1.fb);

    // ② 缓存判为真错 → 红条 + 正确答案
    await cdp.eval(`(async function(){
      const J = await import('./js/judge.js?v=${VER}');
      J.clearJudgeCache();
      J.__seedJudgeCache('term0 with', 'zebra', 'wrong');   // 走模块钩子，不硬编码缓存键
      return true;
    })()`);
    await cdp.eval(seed(VER, 1, 'cloze'));
    let r2 = await cdp.eval(submitGiven('zebra'));
    add('★ 真错时仍给出红条 + 正确答案',
      /verdict bad/.test(r2.cls) && /不对/.test(r2.fb) && /term0 with/.test(r2.fb), JSON.stringify(r2));

    // ③ 无缓存 + 云端不可达（测试构建拦截了云请求）→ 必须降级为"不算你错"
    await cdp.eval(`(async function(){
      const J = await import('./js/judge.js?v=${VER}'); J.clearJudgeCache(); return true;
    })()`);
    await cdp.eval(seed(VER, 1, 'cloze'));
    let r3 = await cdp.eval(submitGiven('handle the problem'));
    add('★ 送复核时先显示"正在核对"，不提前判错',
      /正在核对/.test(r3.fb) || /不算你错/.test(r3.fb), JSON.stringify(r3));
    add('★ 复核请求发不出去时，不是红条', !/verdict bad/.test(r3.cls), r3.cls);
    // reviewSemantics 内部超时 6 秒，等足够久再取最终态
    await sleep(7500);
    let rf = await cdp.eval(`(function(){
      return { fb: (document.querySelector('.verdict') || {}).textContent || '',
               cls: (document.querySelector('.verdict') || {}).className || '' };
    })()`);
    add('★ 云端不可达 → 最终降级为"不算你错"（unsure）',
      /不算你错/.test(rf.fb) && /verdict unsure/.test(rf.cls), JSON.stringify(rf));
    add('★ 全程没有把 handle the problem 判成"不对"', rf.fb.indexOf('不对') < 0, rf.fb);

    // ④ 不在学习页也要保证：真错但像英文短语时，先 unsure 而不是直接红条
    add('静态：学习页提交后调用复核流程',
      /reviewIfNeeded\(\)/.test(read('js/views.js')) &&
      /looksLikeEnglishPhrase\(a\.given\)/.test(read('js/views.js')));

    // 清掉测试写进 localStorage 的判分缓存
    await cdp.eval(`(async function(){
      const J = await import('./js/judge.js?v=${VER}'); J.clearJudgeCache(); return true;
    })()`);

    /* ── D. 判分 UI：四态文案 ── */
    const ui = await cdp.eval(`(async function(){
      const V = await import('./js/views.js?v=${VER}');
      const hit = V.verdictHTML({ ok:true, verdict:'hit',  typo:false, given:'deal with', expected:'deal with' });
      const alt = V.verdictHTML({ ok:true, verdict:'alt',  typo:false, given:'address',   expected:'deal with' });
      const bad = V.verdictHTML({ ok:false, verdict:'wrong',typo:false, given:'zebra',     expected:'deal with' });
      const uns = V.verdictHTML({ ok:false, verdict:'unsure',typo:false,given:'gibber',    expected:'deal with' });
      const rev = V.verdictHTML({ ok:false, verdict:'wrong',typo:false, given:'address',   expected:'deal with', reviewing:true });
      const typ = V.verdictHTML({ ok:true, verdict:'hit',  typo:true,  given:'dealwith',  expected:'deal with' });
      return { hit:hit, alt:alt, bad:bad, uns:uns, rev:rev, typ:typ };
    })()`);
    add('hit 文案：答对了 + 显示正确答案',
      /答对了/.test(ui.hit) && /deal with/.test(ui.hit), ui.hit);
    add('★ alt 文案：明确说"你的表达也对"，不用"不对"',
      /你的表达也对/.test(ui.alt) && ui.alt.indexOf('不对') < 0, ui.alt);
    add('★ alt 文案：用的是"好"的样式（不会红条打击）', /verdict good/.test(ui.alt), ui.alt);
    add('alt 文案：同时点明本题目标是 deal with', /deal with/.test(ui.alt), ui.alt);
    add('★ wrong 文案仍要给出正确答案',
      /不对/.test(ui.bad) && /deal with/.test(ui.bad), ui.bad);
    add('★ unsure 文案：明说"不算你错"', /不算你错/.test(ui.uns), ui.uns);
    add('★ unsure 用中性色（不是红条）', /verdict unsure/.test(ui.uns), ui.uns);
    add('复核中用中性文案，不提前判错', /正在核对/.test(ui.rev) && /verdict unsure/.test(ui.rev), ui.rev);
    add('typo 文案：点出拼写有误并给出正确拼写',
      /拼写错误/.test(ui.typ) && /deal with/.test(ui.typ), ui.typ);

    /* ── C. 静态契约 ── */
    const game = read('js/game.js');
    add('★ 抽测答对时不再出现空白的"正确："',
      game.indexOf("'正确：'") < 0, 'game.js 仍有裸的「正确：」文案');
    add('抽测接入 verdictHTML', /verdictHTML\(a, \{ taskLabel: '目标表达' \}\)/.test(game));
    add('抽测接语义复核，且听写题豁免复核', /!meta\.spell && looksLikeEnglishPhrase/.test(game));
    add('抽测提交有防重复锁', /if \(d\.answered\) return/.test(game));
    add('学习页评分有防误触门槛', /session\.answerReadyAt/.test(read('js/views.js')));
    add('同一张卡有重试上限常量', /MAX_CARD_RETRIES\s*=\s*2/.test(read('js/views.js')));
    add('judge.js 已独立成模块', fs.existsSync(path.join(APP, 'js', 'judge.js')));
    add('views.js 不再自带判分实现（只 re-export）',
      read('js/views.js').indexOf('function judgeTyped') < 0);

    // 顺带一眼：新文案在真实 iPhone 宽度下不溢出
    const layout = await cdp.eval(`(async function(){
      const V = await import('./js/views.js?v=${VER}');
      const d = document.createElement('div');
      d.style.cssText = 'width:345px;';
      d.innerHTML = V.verdictHTML({ ok:true, verdict:'alt', typo:false, given:'address', expected:'deal with' });
      document.body.appendChild(d);
      const r = { overflow: d.scrollWidth - d.clientWidth };
      d.remove();
      return r;
    })()`);
    add('alt 文案在 393px 宽度下不横向溢出', layout && layout.overflow <= 1, JSON.stringify(layout));

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
  console.log('\n===== 判分公平性 + 题量计数质检: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
