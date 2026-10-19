'use strict';
/* LexiLoop · 判分提示词线上采样（真实模型 + 线上真实提示词）
 *
 * 为什么要采样而不是跑一遍：
 *   2026-10-14 实测同一个提示词在"词形变体"用例上会**波动**（8 次里 7 对 1 错）——
 *   单次通过等于没通过。这个脚本对每个用例重复 N 次，全对才算过。
 *
 * 为什么提示词从线上 judge.js 的 __prompts() 读：
 *   探针自己复制一份提示词就会与产品漂移，出现"探针全绿、线上照旧"的假信心。
 *
 * 为什么必须跑在线上域（而不是本地）：
 *   云通道按 Origin 校验，只有应用自己的域名能调真模型；所以这是**发布后**的门禁。
 *
 * 用法：node tools/probe-judge-prompt.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SITE = 'https://lexiloop-82703.app.workbuddy.host/';
const APP = path.resolve(__dirname, '..', 'lexiloop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(url, tries = 100) { for (let i = 0; i < tries; i++) {
    try { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); }); return new CDP(ws); } catch (e) { await sleep(250); } }
    throw new Error('CDP 连接超时'); }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {} })); return new Promise((res) => this.map.set(id, res)); }
  async eval(expr, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs || 120000 });
    if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

/* N = 采样次数；want = 期望判定 */
const CASES = [
  { k: '★ 词形变体：无时间状语（compliments）', n: 5, want: 'alt',
    o: { expected: 'complimented', given: 'compliments',
         sentence: 'She ________ him on his excellent presentation skills.', zh: '她称赞他出色的演讲技巧。' } },
  { k: '★ 词形变体反例：yesterday（compliments）', n: 3, want: 'wrong',
    o: { expected: 'complimented', given: 'compliments',
         sentence: 'She ________ him yesterday.', zh: '她昨天称赞了他。' } },
  { k: '★ 词形变体反例：光杆 compliment（缺 -s/-ed）', n: 3, want: 'wrong',
    o: { expected: 'complimented', given: 'compliment',
         sentence: 'She ________ him on his excellent presentation skills.', zh: '她称赞他出色的演讲技巧。' } },
  { k: '通用路径回归：address 替代表达', n: 2, want: 'alt',
    o: { expected: 'deal with', given: 'address',
         sentence: 'The manager had to ___ several complaints from customers.', zh: '经理不得不处理客户的几个投诉。' } },
  { k: '通用路径回归：deal in 介词错', n: 2, want: 'wrong',
    o: { expected: 'deal with', given: 'deal in',
         sentence: 'The manager had to ___ several complaints from customers.', zh: '经理不得不处理客户的几个投诉。' } },
  { k: '通用路径回归：同义句式（无句子）', n: 1, want: 'alt',
    o: { expected: 'if you have a moment', given: 'if you have time', sentence: '', zh: '如果你有空' } },
];

(async () => {
  const port = 10046;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-p5-' + Date.now()), SITE],
    { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  let bad = 0;
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
    for (let i = 0; i < 60; i++) { await sleep(500); if ((await cdp.eval('!!window.WorkBuddyCloud')) === true) break; }

    const files = ['index.html'].concat(fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
    const vs = new Set();
    files.forEach((f) => { for (const m of fs.readFileSync(path.join(APP, f), 'utf8').matchAll(/\?v=(\d+)/g)) vs.add(m[1]); });
    const VER = [...vs][0];

    const has = await cdp.eval(`(async function(){
      const J = await import('./js/judge.js?v=${VER}');
      return typeof J.__prompts === 'function' && typeof J.reviewSemantics === 'function';
    })()`);
    if (has !== true) { console.log('  FAIL  线上 judge.js?v=' + VER + ' 缺少 __prompts 钩子（版本不对？）'); process.exit(1); }

    for (const c of CASES) {
      const got = [];
      for (let i = 0; i < c.n; i++) {
        const v = await cdp.eval(`(async function(){
          const J = await import('./js/judge.js?v=${VER}');
          const C = await import('./js/cloud.js?v=${VER}');
          const P = J.__prompts();
          const o = ${JSON.stringify(c.o)};
          J.clearJudgeCache();
          const form = P.formMode(o);
          const raw = await C.chatText({
            system: form ? P.form : P.general,
            user: form ? P.formPrompt(o) : P.generalPrompt(o),
            json: true, temperature: 0, maxTokens: 60,
          });
          let out = '';
          try { out = String(JSON.parse(raw).verdict || '').toLowerCase(); } catch (e) {
            const mm = String(raw || '').match(/"verdict"\\s*:\\s*"(alt|wrong)"/i); out = mm ? mm[1].toLowerCase() : '';
          }
          return { v: out, form: form };
        })()`, 60000);
        got.push(v && v.v);
      }
      const okN = got.filter((x) => x === c.want).length;
      if (okN !== c.n) bad++;
      console.log((okN === c.n ? '  PASS  ' : '  FAIL  ') + c.k.padEnd(42) +
        ' ' + got.join(' ') + '  ' + okN + '/' + c.n + '（期望 ' + c.want + '）');
    }
  } catch (e) {
    bad++;
    console.log('  FAIL  执行：' + e.message);
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
  }
  console.log('\n===== 判分提示词线上采样: ' + (bad ? bad + ' 组未达标' : '全部组通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
