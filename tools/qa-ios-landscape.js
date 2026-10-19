'use strict';
/* LexiLoop · iOS **横屏**适配专项
 *
 * 为什么单开：qa-ios / qa-ios-loggedin / qa-ios-newui 全都是 portraitPrimary ——
 * 横屏在 iPhone 上高度只剩 375~393px，固定底栏 + 长卡片最容易出问题
 * （底栏吃掉主内容、输入框被底栏压住、横向溢出），而这些在竖屏下永远不会暴露。
 *
 * 做法：与 qa-restday 同一套（buildAuthed：只绕过登录闸门，视图与样式和线上完全一致），
 * 在两种横屏尺寸下逐页检查：横向溢出 / 首屏标题可见 / 底栏热区 / 内容避让底栏 /
 * 学习屏输入框能否完整滚入视口。
 *
 * 用法：node tools/qa-ios-landscape.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8897;
const DBPORT = 10048;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => out.push({ n, pass: !!p, d: p ? '' : String(d == null ? '' : d) });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
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

const DEVICES = [
  { name: 'iPhone 15 横屏 (852×393)', w: 852, h: 393, dpr: 3 },
  { name: 'iPhone SE 横屏 (667×375)', w: 667, h: 375, dpr: 2 },
];
const TABS = ['today', 'study', 'games', 'library', 'stats', 'me'];

async function runDevice(dev, url) {
  const port = DBPORT;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-land-' + dev.w + '-' + Date.now()), url],
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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr, mobile: true,
      screenOrientation: { angle: 90, type: 'landscapePrimary' },   // ★ 与其它套件的唯一区别
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sleep(700);
    await cdp.send('Page.reload', { ignoreCache: false });
    for (let i = 0; i < 24; i++) { await sleep(500); if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break; }

    const hasShell = (await cdp.eval('!!document.querySelector(".tabbar")')) === true;
    add('[' + dev.name + '] 已进入登录后外壳', hasShell, '未进入');
    if (!hasShell) return;

    // 底栏热区 + 内容避让底栏（每个尺寸查一次）
    const shell = await cdp.eval(`(function(){
      var tb = document.querySelector('.tabbar');
      var btn = tb && tb.querySelector('button[data-tab]');
      var main = document.querySelector('.main');
      var cs = main ? getComputedStyle(main) : null;
      return { tabH: tb ? Math.round(tb.getBoundingClientRect().height) : 0,
               btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
               mainPadB: cs ? Math.round(parseFloat(cs.paddingBottom)) : 0 };
    })()`);
    add('[' + dev.name + '] 底栏按钮热区 ≥44px', shell && shell.btnH >= 44, JSON.stringify(shell));
    add('[' + dev.name + '] 主内容下方留白 ≥ 底栏高度（不被底栏永久压住）',
      shell && shell.mainPadB >= shell.tabH - 1, JSON.stringify(shell));

    // 逐页：无横向溢出 + 首屏标题可见
    for (const t of TABS) {
      await cdp.eval(`(function(){ var b = document.querySelector('.tabbar button[data-tab=' + ${JSON.stringify(JSON.stringify(t))} + ']'); if (b) b.click(); })()`);
      await sleep(800);
      const v = await cdp.eval(`(function(){
        var de = document.documentElement;
        var tb = document.querySelector('.tabbar');
        var tbH = tb ? tb.getBoundingClientRect().height : 0;
        var heads = document.querySelectorAll('h1.page, .card, .study-bar, .empty');
        var first = null, firstTop = null;
        for (var i = 0; i < heads.length; i++) {
          var r = heads[i].getBoundingClientRect();
          if (r.height > 4 && r.width > 40) { first = heads[i].className || heads[i].tagName; firstTop = Math.round(r.top); break; }
        }
        return { over: de.scrollWidth - window.innerWidth, winH: window.innerHeight,
                 tbH: Math.round(tbH), first: first, firstTop: firstTop };
      })()`);
      const tag = '[' + dev.name + '][' + t + ']';
      add(tag + ' 无横向溢出', v && v.over <= 1, JSON.stringify(v));
      add(tag + ' 首屏有内容且未被底栏挤出视口',
        v && v.firstTop != null && v.firstTop < v.winH - v.tbH + 1,
        JSON.stringify(v));
    }

    /* ── 学习屏（横屏最挤：题干 + 输入框 + 底栏）── */
    await cdp.eval(`(async function(){
      var ver = (document.querySelector('script[type=module]') || {}).src || '';
      var q = (ver.match(/\\?v=\\d+/) || [''])[0];
      var S = await import('./js/store.js' + q);
      S.state.user = { id: 'qa-landscape' };
      S.state.load.hydrated = true; S.state.load.phase = 'ready';
      S.state.words = [{ id: 1, normalized: 'term0 with', lemma: 'term0 with', deck: 'core',
        payload: { pos: 'verb', senses: [{ def_zh: '处理', def_en: 'handle', pos: 'verb' }],
          collocations: [{ pattern: 'term0 with', zh: '处理', type: 'verb+prep',
            examples: [{ en: 'We term0 with the plan every day.', zh: '我们每天处理这个计划。' }] }] } }];
      S.state.cards = [{ id: 'c1', word_id: 1, card_type: 'cloze', status: 'review',
        stability: 5, difficulty: 5, due: Date.now() - 3600 * 1000, reps: 3, lapses: 0 }];
      S.reindex();
      return true;
    })()`);
    await cdp.eval(`(function(){ var b = document.querySelector('.tabbar button[data-tab="study"]'); if (b) b.click(); })()`);
    await sleep(900);
    const st = await cdp.eval(`(async function(){
      var btn = document.getElementById('start-study');
      if (btn) { btn.click(); await new Promise(function(r){ setTimeout(r, 700); }); }
      var de = document.documentElement;
      var bar = document.querySelector('.study-bar');
      var inp = document.getElementById('ans-in');
      if (inp) { inp.scrollIntoView({ block: 'end' }); await new Promise(function(r){ setTimeout(r, 250); }); }
      var r = inp ? inp.getBoundingClientRect() : null;
      return { hasBar: !!bar, hasInput: !!inp, over: de.scrollWidth - window.innerWidth,
               top: r ? Math.round(r.top) : null, bottom: r ? Math.round(r.bottom) : null,
               winH: window.innerHeight, scrollable: de.scrollHeight > window.innerHeight };
    })()`);
    add('[' + dev.name + '][study] 学习屏渲染（题干栏 + 输入框存在）',
      st && st.hasBar === true && st.hasInput === true, JSON.stringify(st));
    add('[' + dev.name + '][study] 学习屏无横向溢出', st && st.over <= 1, JSON.stringify(st));
    add('[' + dev.name + '][study] 输入框可完整滚入视口（不被底栏压住）',
      st && st.top != null && st.top >= 0 && st.bottom <= st.winH + 1, JSON.stringify(st));
  } catch (e) {
    add('[' + dev.name + '] 执行', false, e.message);
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
  }
}

(async () => {
  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，已拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const url = 'http://127.0.0.1:' + PORT + '/';
  console.log('iOS 横屏适配专项（本地构建：仅绕过登录闸门，视图/样式与线上一致）\n');
  try {
    for (const dev of DEVICES) await runDevice(dev, url);
  } finally {
    try { srv.close(); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  let bad = 0;
  out.forEach((o) => { if (!o.pass) bad++; console.log((o.pass ? '  PASS  ' : '  FAIL  ') + o.n + (o.pass ? '' : '  → ' + o.d)); });
  console.log('\n===== iOS 横屏适配: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
