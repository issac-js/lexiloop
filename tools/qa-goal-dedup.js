'use strict';
/* LexiLoop · P0-2.2 情景目标去重与匹配质检
 *
 * 对应方案 §6 的 T02 / T03，以及观察 O07 / O08 / O09：
 *   O07 目标区同时出现 lost and found、trace sb.'s whereabouts、whereabouts、track（重复）
 *   O08 一句自然的话被判成"堆砌"（重复计数把 2 个目标算成 3 个）
 *   O09 一句话显示"命中 lost and found、lost and found"（单次使用重复计数）
 *
 * 这三条是**同一个根因**：目标按卡片抽（一个词 3 种卡型 → 3 个同名目标），
 * 匹配按出现次数算。所以修复也必须一起验：只测其中一条会漏掉另外两条。
 *
 * 用法：node tools/qa-goal-dedup.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8895;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

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

/* 构造"学生报失"场景的词库：故意把 O07 里那批重叠/重复的表达式原样搬进来 ──
   lost and found 给 3 种卡型（这正是重复的三个来源），
   trace sb.'s whereabouts 与 whereabouts 构成包含关系。 */
const seed = (ver) => `(async function(){
  const S = await import('./js/store.js?v=${ver}');
  const V = await import('./js/views.js?v=${ver}');
  const G = await import('./js/game.js?v=${ver}');
  const mk = (id, term, zh, types) => ({
    w: { id: 'gw-' + id, normalized: term, lemma: term,
         payload: { topic: '失物招领', senses: [{ def_zh: zh }],
                    collocations: [{ pattern: term, examples: [{ en: 'Use ' + term + '.', zh: zh }] }] } },
    c: types.map((t, i) => ({ id: 'gc-' + id + '-' + i, word_id: 'gw-' + id, card_type: t,
         status: 'review', suspended: false, lapses: 0, reps: 3, deck: '', due: null,
         stability: 30, difficulty: 5, last_grade: 3, last_review_at: Date.now() - 86400000 })),
  });
  const defs = [
    mk('laf',   'lost and found', '失物招领', ['recognition', 'cloze', 'production']),
    mk('trace', "trace sb.'s whereabouts", '追踪某人的行踪', ['recognition', 'production']),
    mk('where', 'whereabouts', '行踪；下落', ['recognition']),
    mk('track', 'track', '追踪', ['recognition', 'cloze']),
    mk('idcard', 'student ID card', '学生证', ['recognition']),
    mk('campus', 'campus', '校园', ['recognition']),
  ];
  S.state.user = { id: 'dedup-probe' };
  S.state.words = defs.map((d) => d.w);
  S.state.cards = defs.reduce((a, d) => a.concat(d.c), []);
  S.state.settings.daily_new = 8; S.state.settings.daily_max_review = 0;
  S.state.settings.rest_weekday = null;
  S.state.load.phase = 'ready'; S.state.load.hydrated = true; S.state.syncing = false;
  S.state.daily = [];
  S.reindex();
  window.__lexiloopRender();
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('[data-tab="games"]').click();
  await new Promise(r => setTimeout(r, 200));
  G.startChat('lost');
  window.__lexiloopRender();
  await new Promise(r => setTimeout(r, 250));
  const st = G.__testState();
  return {
    targets: (st.chat ? st.chat.targets : []).map((t) => t.term),
    freeMode: st.chat ? !!st.chat.freeMode : null,
    cardsTotal: S.state.cards.length,
    wordsTotal: S.state.words.length,
  };
})()`;

/** 走真实输入框提交，读页面上"这句用上了"的显示 */
const submit = (txt) => `(async function(){
  const i = document.getElementById('chat-in');
  if (!i) return { no: 'input' };
  i.value = ${JSON.stringify(txt)};
  const b = document.getElementById('chat-send');
  if (b) b.click();
  await new Promise(r => setTimeout(r, 500));
  const main = document.getElementById('main');
  const txt2 = main ? main.textContent : '';
  const m = /这句用上了：(.*?)(?:这一句|$)/.exec(txt2);
  return {
    used: m ? m[1].trim() : '',
    stuffed: /堆在一起了/.test(txt2),
    text: txt2.slice(-160),
  };
})()`;

(async () => {
  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，已拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const url = 'http://127.0.0.1:' + PORT + '/';
  const port = 10005;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-dedup-' + Date.now()), url],
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
    for (let i = 0; i < 30; i++) { await sleep(250); if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break; }

    const VER = await cdp.eval(`(async function(){
      const files = ['/js/store.js', '/js/game.js'];
      for (const f of files) { const t = await (await fetch(f)).text(); const m = /\\?v=(\\d+)/.exec(t); if (m) return m[1]; }
      return null;
    })()`);

    /* ── T02：目标去重 ── */
    const seeded = await cdp.eval(seed(VER));
    const targets = (seeded && seeded.targets) || [];
    add('前置：词库共 6 个词条、10 张卡（lost and found 占 3 张）',
      seeded && seeded.wordsTotal === 6 && seeded.cardsTotal === 10, JSON.stringify(seeded));
    add('目标区不出现重复表达（O07）',
      new Set(targets).size === targets.length, JSON.stringify(targets));
    add('★ lost and found 只出现一次（3 张卡型不再变成 3 个目标）',
      targets.filter((t) => t === 'lost and found').length === 1, JSON.stringify(targets));
    add('★ whereabouts 被更长的 trace sb.\'s whereabouts 覆盖，不单独出现',
      !targets.includes('whereabouts') && targets.includes("trace sb.'s whereabouts"), JSON.stringify(targets));
    add('目标数量合理（不超过 8 个）', targets.length <= 8, JSON.stringify(targets));

    /* ── T03 / O09：同一跨度不重复得分 ── */
    const r9 = await cdp.eval(submit('We can check lost and found again. Please tell me when you last saw your card.'));
    const used9 = (r9.used || '').split('、').map((s) => s.trim()).filter(Boolean);
    add('★ O09：一句话里 lost and found 只计一次',
      used9.filter((t) => t === 'lost and found').length <= 1, JSON.stringify(r9));
    add('★ O09：命中列表无重复项',
      new Set(used9).size === used9.length, JSON.stringify(used9));

    /* ── T03 / O08：正常句子不得被判成堆砌 ── */
    const r8 = await cdp.eval(submit('Please check lost and found. To track your card, could you tell me where you last used it?'));
    const used8 = (r8.used || '').split('、').map((s) => s.trim()).filter(Boolean);
    add('★ O08：正常长度的句子不被判成堆砌', r8.stuffed === false, JSON.stringify(r8));
    add('★ O08：识别到的不同目标数 ≤ 2（旧实现重复计数成 3）',
      used8.length <= 2, JSON.stringify({ used: used8 }));
    add('★ O08：命中的目标不重复', new Set(used8).size === used8.length, JSON.stringify(used8));

    /* ── 词汇形态与槽位容忍（方案 2.2 的"不得要求原样输入"） ── */
    const m = await cdp.eval(`(async function(){
      const G = await import('./js/game.js?v=${VER}');
      const n = G.__normTarget, x = G.__matchTarget;
      return {
        slotA: n("trace sb.'s whereabouts"),
        slotB: n('trace whereabouts'),
        slotC: n('trace sth'),
        hitExact: !!x('I will trace his whereabouts now.', "trace sb.'s whereabouts"),
        hitInflect: !!x('He traced the whereabouts yesterday.', "trace sb.'s whereabouts"),
        hitCase: !!x('Check LOST AND FOUND please.', 'lost and found'),
        hitPunct: !!x('Go to lost & found.', 'lost and found'),
        noHit: !!x('I have no idea about that.', "trace sb.'s whereabouts"),
        ampWord: !!x('Go to lost & found.', 'lost and found'),
        ampBack: !!x('Go to lost and found.', 'lost & found'),
        // 词边界：'do' 不能因为 'doctor' 里含 do 就算用上（短目标词最容易踩）
        boundary: !!x('I am a doctor.', 'do'),
        boundaryOk: !!x('I do not know.', 'do'),
      };
    })()`);
    add('代词槽位被抹掉（sb.\'s 与裸表达同骨架）', m && m.slotA === 'trace whereabouts', JSON.stringify(m));
    add('★ 槽位不要求原样输入：trace his whereabouts 命中',
      m && m.hitExact === true, JSON.stringify(m));
    add('★ 大小写、标点、&/and 等价都容忍',
      m && m.hitCase === true && m.ampWord === true && m.ampBack === true, JSON.stringify(m));
    add('没用到就是没用到（不误报）', m && m.noHit === false, JSON.stringify(m));
    add('★ 词边界匹配：doctor 不算用到 do', m && m.boundary === false, JSON.stringify(m));
    add('词边界匹配：真正的 do 仍能命中', m && m.boundaryOk === true, JSON.stringify(m));

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
  console.log('\n===== 目标去重与匹配质检: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
