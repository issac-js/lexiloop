'use strict';
/* LexiLoop · 发布验收补充：全局词库读取链路直测（只读）
 *
 * 背景：qa-release-live.js 里 words=0 是**正确行为** —— store.js 的 syncPull 只按
 * 卡片引用的 word_id 按需水合词条，测试账号 0 卡 → 0 词。但这条链路
 * （authenticated 角色 → words 表 RLS → PostgREST .in('id', ...)）本身没被走到。
 * 本脚本用同一登录会话直接读 words 表，补上这一环。纯 SELECT，不写任何数据。
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

/* 可配置项见 tools/README-live-checks.md；不写死本机绝对路径 */
const SITE = process.env.LEXILOOP_SITE || 'https://lexiloop-82703.app.workbuddy.host/';
const EDGE = process.env.LEXILOOP_EDGE_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = process.env.LEXILOOP_QA_PROFILE || path.join(os.tmpdir(), 'gll-gd-profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(url, tries = 100) { for (let i = 0; i < tries; i++) {
    try { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); }); return new CDP(ws); } catch (e) { await sleep(250); } }
    throw new Error('CDP 连接超时'); }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); return new Promise((res) => this.map.set(id, res)); }
  async eval(expr, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs || 120000 });
    if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  const port = 10053;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + PROFILE, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  try {
    let pg = null;
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (pg) break; } catch (e) {}
    }
    if (!pg) throw new Error('无法连接调试页');
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: SITE });
    for (let i = 0; i < 60; i++) { await sleep(500); if ((await cdp.eval('!!window.WorkBuddyCloud')) === true) break; }
    for (let i = 0; i < 80; i++) { await sleep(250); if ((await cdp.eval("!!document.querySelector('.tabbar')")) === true) break; }
    const r = await cdp.eval(`(async function(){
      var s = (document.querySelector('script[type="module"]') || {}).src || '';
      var m = s.match(/[?&]v=(\\d+)/); var VER = m ? m[1] : '';
      var S = await import('./js/store.js?v=' + VER);
      var C = await import('./js/cloud.js?v=' + VER);
      var out = { ver: VER, loggedIn: !!S.state.user };
      // ① 直接限量读（与 syncPull 同表同角色）
      var r1 = await C.db().from('words').select('*').limit(3);
      out.readLimit = { rows: Array.isArray(r1.data) ? r1.data.length : -1, err: r1.error ? String(r1.error.message || r1.error) : '' };
      // ② 精确计数（PostgREST count）
      var r2 = await C.db().from('words').select('*', { count: 'exact', head: true });
      out.readCount = { count: r2.count, err: r2.error ? String(r2.error.message || r2.error) : '' };
      // ③ 模拟按卡片 id 水合的 .in('id', ...) 路径：取前两个真实 id 再读回
      if (Array.isArray(r1.data) && r1.data.length) {
        var ids = r1.data.slice(0, 2).map(function (w) { return w.id; });
        var r3 = await C.db().from('words').select('*').in('id', ids);
        out.readInIds = { asked: ids.length, got: Array.isArray(r3.data) ? r3.data.length : -1, err: r3.error ? String(r3.error.message || r3.error) : '' };
      }
      return out;
    })()`, 120000);
    console.log('RESULT_JSON=' + JSON.stringify(r));
  } catch (e) {
    console.log('RESULT_JSON=' + JSON.stringify({ __err: String(e && e.stack || e) }));
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
  }
  process.exit(0);
})();
