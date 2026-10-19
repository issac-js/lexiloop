'use strict';
/* LexiLoop · 本轮新增 UI 的 iOS 适配专项
 *
 * 为什么要单开一个：qa-ios.js / qa-ios-loggedin.js 覆盖的是"原有页面"，
 * 而 2026-10-09 这批改动引入了 6 类**新元素**——同步提示条、数据状态卡、
 * 三项达标卡、判分维度卡、抽测题型分段器、对话自由聊天提示。
 * 新元素最常犯的 iOS 问题就三类：横向溢出、点击区太小、输入框字号 <16px（会自动放大页面）。
 *
 * 每个元素都在 4 种真实尺寸下过一遍（含 iPhone SE 的 375px —— 那是最挤的一档）。
 *
 * 用法：node tools/qa-ios-newui.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8897;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };
const APP = path.resolve(__dirname, '..', 'lexiloop');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

const DEVICES = [
  { name: 'iPhone SE 375', w: 375, h: 667, dsf: 2 },
  { name: 'iPhone 15 393', w: 393, h: 852, dsf: 3 },
  { name: 'iPhone 15PM 430', w: 430, h: 932, dsf: 3 },
  { name: 'iPad mini 744', w: 744, h: 1133, dsf: 2 },
];

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

/** 统一的量测：对给定选择器，量溢出、按钮高度、输入框字号、文字裁切 */
const measure = (sel) => `(function(){
  const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
  if (!els.length) return { found: 0 };
  let overflow = 0, minBtn = 999, minInputFont = 99, clipped = 0, minTextFont = 99;
  els.forEach((el) => {
    overflow = Math.max(overflow, el.scrollWidth - el.clientWidth);
    if (el.scrollHeight - el.clientHeight > 2 && getComputedStyle(el).overflow === 'hidden') clipped++;
    el.querySelectorAll('button, a, [role="button"]').forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.height > 0) minBtn = Math.min(minBtn, r.height);
    });
    el.querySelectorAll('input, select, textarea').forEach((i) => {
      const fs2 = parseFloat(getComputedStyle(i).fontSize) || 0;
      if (fs2 > 0) minInputFont = Math.min(minInputFont, fs2);
    });
    const fs3 = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (fs3 > 0) minTextFont = Math.min(minTextFont, fs3);
  });
  return {
    found: els.length,
    overflow: overflow,
    docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    minBtn: minBtn === 999 ? null : Math.round(minBtn),
    minInputFont: minInputFont === 99 ? null : minInputFont,
    minTextFont: minTextFont === 99 ? null : minTextFont,
    clipped: clipped,
  };
})()`;

const seed = (ver, mode) => `(async function(){
  const S = await import('./js/store.js?v=${ver}');
  const V = await import('./js/views.js?v=${ver}');
  const d = new Date();
  const dk = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  S.state.user = { id: 'ios-probe' };
  S.state.settings.goal_include_test = true;
  S.state.settings.rest_weekday = null;
  S.state.settings.daily_new = 8;
  S.state.settings.last_test_at = null;
  S.state.words = Array.from({length: 40}, (_, i) => ({
    id: 'iw' + i, normalized: 'word ' + i, lemma: 'word' + i,
    payload: { senses: [{ pos: 'verb', def_zh: '释义' + i }],
      collocations: [{ pattern: 'collocation number ' + i, zh: '搭配', examples: [{ en: 'A sentence with word ' + i + '.', zh: '例句' }] }],
      confidence: 0.95 } }));
  S.state.cards = Array.from({length: 40}, (_, i) => ({
    id: 'ic' + i, word_id: 'iw' + i, card_type: 'recognition',
    status: i < 28 ? 'review' : 'new', suspended: false, lapses: i % 7 === 0 ? 2 : 0,
    reps: i < 28 ? 4 : 0, deck: '默认词单', due: null, stability: i < 28 ? 30 : 0,
    difficulty: 5, last_grade: 3, last_review_at: Date.now() - 86400000 }));
  S.state.daily = [{ reviewed_on: dk, total: 28, correct: 26, new_words: 8, minutes: 20 }];
  S.reindex();

  ${mode === 'syncing'
    ? "S.state.load.phase='ready'; S.state.load.hydrated=true; S.state.syncing=true;"
    : mode === 'error'
      ? "S.state.load.phase='error'; S.state.load.error='Failed to fetch'; S.state.load.hydrated=false; S.state.syncing=false; S.state.words=[]; S.state.cards=[];"
      : "S.state.load.phase='ready'; S.state.load.hydrated=true; S.state.syncing=false;"}

  window.__lexiloopRender();
  await new Promise(r => setTimeout(r, 200));
  return { ok: true };
})()`;

/* v107 新元素：今日页「补课卡」说明行（已开始词的剩余卡型）。
   种一组"词已开始、还剩一张 cloze new"的数据，让那行真的渲染出来。 */
const leftoverSeed = (ver) => `(async function(){
  const S = await import('./js/store.js?v=${ver}');
  const V = await import('./js/views.js?v=${ver}');
  const d = new Date();
  const dk = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const now = Date.now();
  S.state.user = { id: 'ios-probe' };
  S.state.settings.goal_include_test = true;
  S.state.settings.rest_weekday = null;
  S.state.settings.daily_new = 8;
  S.state.settings.last_test_at = null;
  const mk = (id, wi, o) => Object.assign({ id: id, word_id: 'lw' + wi, card_type: 'recognition',
    status: 'review', suspended: false, lapses: 0, reps: 3, deck: '默认词单', stability: 3, difficulty: 5,
    due: new Date(now - 3600e3).toISOString(), last_grade: 2, last_review_at: now - 864e5 }, o || {});
  S.state.words = [0, 1, 2].map((i) => ({ id: 'lw' + i, normalized: 'leftover' + i, lemma: 'leftover' + i,
    payload: { senses: [{ pos: 'verb', def_zh: '释义' + i }],
      collocations: [{ pattern: 'leftover' + i + ' (sth)', zh: '搭配', examples: [{ en: 'We leftover' + i + ' it.', zh: '例句' }] }] } }));
  S.state.cards = [
    mk('ld1', 0), mk('ld2', 1), mk('ld3', 2),
    /* 已开始词的剩余卡型（cloze 还是 new）→ 应触发「补课卡」说明行 */
    mk('lu1', 0, { card_type: 'cloze', status: 'new', reps: 0, stability: 0, last_grade: 0, last_review_at: null, due: null }),
    mk('lu2', 1, { card_type: 'cloze', status: 'new', reps: 0, stability: 0, last_grade: 0, last_review_at: null, due: null }),
    mk('lu3', 2, { card_type: 'cloze', status: 'new', reps: 0, stability: 0, last_grade: 0, last_review_at: null, due: null }),
  ];
  S.state.daily = [{ reviewed_on: dk, total: 3, correct: 3, new_words: 8, minutes: 5 }];
  S.state.load.phase = 'ready'; S.state.load.hydrated = true; S.state.syncing = false;
  S.reindex();
  window.__lexiloopRender();
  await new Promise(r => setTimeout(r, 200));
  return { ok: true };
})()`;

(async () => {
  const views = read('js/views.js');
  const css = read('styles.css');

  /* 静态契约：新元素都必须有样式定义，且不写死像素宽度 */
  add('.sync-bar 样式已定义（含 reduced-motion 兜底）',
    /\.sync-bar\s*\{/.test(css) && /prefers-reduced-motion[\s\S]{0,80}sync-bar/.test(css));
  add('.alert-card / .verdict.unsure 等新样式在位',
    /\.alert-card\s*\{/.test(css) && /\.verdict\.unsure/.test(css));
  add('新元素未使用固定像素宽度（会撑破窄屏）',
    !/\.sync-bar\s*\{[^}]*width:\s*\d+px/.test(css) &&
    !/\.alert-card\s*\{[^}]*width:\s*\d+px/.test(css));
  add('粗指针下按钮最小高度有统一兜底', /@media \(pointer: coarse\)[\s\S]{0,400}\.btn\s*\{\s*min-height/.test(css));
  add('目标卡的抽测行不做成三列硬挤（避免 375px 换行错位）',
    /抽测[\s\S]{0,200}row between/.test(views));

  console.log('静态契约：' + out.filter((o) => o.pass).length + '/' + out.length + ' 通过\n');

  const files = ['index.html'].concat(fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
  const vs = new Set();
  files.forEach((f) => { for (const m of read(f).matchAll(/\?v=(\d+)/g)) vs.add(m[1]); });
  const VER = [...vs][0];

  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，已拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const url = 'http://127.0.0.1:' + PORT + '/';
  const port = 9999;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-iosnew-' + Date.now()), url],
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

    for (const d of DEVICES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dsf, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }] });
      await cdp.send('Page.navigate', { url: url });
      for (let i = 0; i < 30; i++) { await sleep(250); if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break; }

      /* ① 目标卡（三项达标 + 抽测行 + 按钮） */
      await cdp.eval(seed(VER, 'ready'));
      await cdp.eval(`(async function(){ document.querySelector('[data-tab="today"]').click(); await new Promise(r=>setTimeout(r,200)); return true; })()`);
      let r = await cdp.eval(measure('.card.tight'));
      add(d.name + '｜目标卡无横向溢出', r && r.overflow <= 1, JSON.stringify(r));
      add(d.name + '｜目标卡内按钮 ≥44px', r && (r.minBtn == null || r.minBtn >= 44), JSON.stringify(r));
      const btnInfo = await cdp.eval(`(function(){
        const b = document.getElementById('go-weekly-test');
        const main = document.getElementById('main');
        return {
          exists: !!b,
          h: b ? Math.round(b.getBoundingClientRect().height) : null,
          inHtml: main ? main.innerHTML.indexOf('go-weekly-test') >= 0 : null,
          tail: main ? main.textContent.slice(-24) : ''
        };
      })()`);
      add(d.name + '｜抽测直达按钮存在且 ≥44px',
        btnInfo && btnInfo.exists === true && btnInfo.h >= 44, JSON.stringify(btnInfo));

      /* ② 同步提示条 */
      await cdp.eval(seed(VER, 'syncing'));
      await cdp.eval(`(async function(){ document.querySelector('[data-tab="today"]').click(); await new Promise(r=>setTimeout(r,200)); return true; })()`);
      r = await cdp.eval(measure('.sync-bar'));
      add(d.name + '｜同步提示条已渲染', r && r.found === 1, JSON.stringify(r));
      add(d.name + '｜同步提示条无横向溢出', r && r.overflow <= 1, JSON.stringify(r));

      /* ③ 数据状态卡（错误态） */
      await cdp.eval(seed(VER, 'error'));
      await cdp.eval(`(async function(){ document.querySelector('[data-tab="today"]').click(); await new Promise(r=>setTimeout(r,200)); return true; })()`);
      r = await cdp.eval(measure('.empty'));
      add(d.name + '｜错误状态卡无横向溢出', r && r.overflow <= 1, JSON.stringify(r));
      add(d.name + '｜重试按钮 ≥44px', r && (r.minBtn == null || r.minBtn >= 44), JSON.stringify(r));

      /* ④ 抽测题型分段器（三选项，375px 最挤） */
      await cdp.eval(seed(VER, 'ready'));
      await cdp.eval(`(async function(){ document.querySelector('[data-tab="games"]').click(); await new Promise(r=>setTimeout(r,250)); return true; })()`);
      r = await cdp.eval(measure('[data-testmode]'));
      add(d.name + '｜抽测题型按钮无横向溢出', r && r.overflow <= 1, JSON.stringify(r));
      add(d.name + '｜抽测题型按钮 ≥40px', r && (r.minBtn == null || r.minBtn >= 40), JSON.stringify(r));
      const segFit = await cdp.eval(`(function(){
        const seg = document.querySelector('.seg');
        if (!seg) return null;
        const btns = Array.from(seg.querySelectorAll('button'));
        const rows = new Set(btns.map(b => Math.round(b.getBoundingClientRect().top)));
        return { rows: rows.size, count: btns.length, segOverflow: seg.scrollWidth - seg.clientWidth };
      })()`);
      add(d.name + '｜三个题型按钮同排不换行', segFit && segFit.rows === 1 && segFit.count === 3, JSON.stringify(segFit));

      /* ⑤ v107 新元素：「补课卡」说明行 —— 今日页最长的动态文案之一，必须过窄屏 */
      await cdp.eval(leftoverSeed(VER));
      await cdp.eval(`(async function(){ document.querySelector('[data-tab="today"]').click(); await new Promise(r=>setTimeout(r,250)); return true; })()`);
      const leftInfo = await cdp.eval(`(function(){
        const main = document.getElementById('main');
        if (!main) return { found: false };
        const el = Array.from(main.querySelectorAll('p.tiny, .tiny'))
          .find(x => x.textContent.indexOf('已开始学习的词剩下的卡片') >= 0);
        if (!el) return { found: false, tail: main.textContent.slice(-60) };
        const r = el.getBoundingClientRect();
        return { found: true, over: Math.round(r.right - window.innerWidth),
                 sw: el.scrollWidth, cw: el.clientWidth, winW: window.innerWidth,
                 docW: document.documentElement.scrollWidth };
      })()`);
      add(d.name + '｜「补课卡」说明行已渲染（v107 新文案）',
        leftInfo && leftInfo.found === true, JSON.stringify(leftInfo));
      add(d.name + '｜「补课卡」说明行无横向溢出、文字不被裁切',
        leftInfo && leftInfo.found === true && leftInfo.over <= 1 &&
        leftInfo.sw <= leftInfo.cw + 1 && leftInfo.docW <= leftInfo.winW + 1, JSON.stringify(leftInfo));

      /* ⑥ v108 新元素：轻松卡 toast（插入真实节点量窄屏，不做纯静态断言） */
      const toastInfo = await cdp.eval(`(function(){
        const w = document.getElementById('toast-wrap');
        if (!w) return { found: false };
        const el = document.createElement('div');
        el.className = 'toast';
        el.textContent = '插一张轻松的，缓一缓';
        w.appendChild(el);
        const r = el.getBoundingClientRect();
        const res = { found: true, over: Math.round(r.right - window.innerWidth), winW: window.innerWidth };
        w.removeChild(el);
        return res;
      })()`);
      add(d.name + '｜轻松卡 toast 不溢出窄屏（v108）',
        toastInfo && toastInfo.found === true && toastInfo.over <= 1, JSON.stringify(toastInfo));

      /* ⑦ 统计页判分维度卡 */
      await cdp.eval(seed(VER, 'ready'));
      await cdp.eval(`(async function(){ document.querySelector('[data-tab="stats"]').click(); for(let i=0;i<12;i++){ await new Promise(r=>setTimeout(r,200)); if(document.getElementById('main').textContent.indexOf('记忆指标')>=0) break; } return true; })()`);
      r = await cdp.eval(measure('.card'));
      add(d.name + '｜统计页无横向溢出', r && r.docOverflow <= 1 && r.overflow <= 1, JSON.stringify(r));
      add(d.name + '｜统计页正文字号 ≥11px（不会小到读不清）',
        r && (r.minTextFont == null || r.minTextFont >= 11), JSON.stringify(r));

      /* ⑧ 输入控件字号（iOS 会自动放大 <16px 的输入框） */
      await cdp.eval(seed(VER, 'ready'));
      await cdp.eval(`(async function(){ document.querySelector('[data-tab="me"]').click(); await new Promise(r=>setTimeout(r,250)); return true; })()`);
      r = await cdp.eval(measure('.main'));
      add(d.name + '｜输入框字号 ≥16px（iOS 不会自动放大）',
        r && (r.minInputFont == null || r.minInputFont >= 16), JSON.stringify(r));

      /* ⑨ 全局：任何页面都不该出现横向滚动 */
      const globalOverflow = await cdp.eval(`(async function(){
        const tabs = ['today','study','games','library','stats','me'];
        const bad = [];
        for (const t of tabs) {
          const b = document.querySelector('[data-tab="' + t + '"]');
          if (b) b.click();
          await new Promise(r => setTimeout(r, 180));
          const o = document.documentElement.scrollWidth - window.innerWidth;
          if (o > 1) bad.push(t + ':' + o);
        }
        return bad;
      })()`);
      add(d.name + '｜六个页面全部无横向滚动', Array.isArray(globalOverflow) && globalOverflow.length === 0,
        JSON.stringify(globalOverflow));
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
  console.log('\n===== 新增 UI 的 iOS 适配: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
