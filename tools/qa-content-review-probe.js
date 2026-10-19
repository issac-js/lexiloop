'use strict';
/* 一次性探测：模型能否胜任"地道性 / 语域 / 义项全面性"的复核？
 *
 * 这是闸门覆盖不到的三类问题。判断它值不值得做成常规功能，必须先回答两个问题：
 *   ① 命中率：能不能发现真问题？（用"已知缺义项"的样本测）
 *   ② 误报率：会不会把正常内容判出毛病？（用两个正常样本测）
 * 误报率比命中率更关键 —— 误报多的功能最终会被忽略。
 *
 * 用法：node tools/_probe-review.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = path.resolve(__dirname, '..', 'lexiloop');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SITE = 'https://lexiloop-82703.app.workbuddy.host/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const files = ['index.html'].concat(fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
const vs = new Set();
files.forEach((f) => { for (const m of read(f).matchAll(/\?v=(\d+)/g)) vs.add(m[1]); });
const VER = [...vs][0];

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(u, t = 100) { for (let i = 0; i < t; i++) { try { const ws = new WebSocket(u); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(0); }); return new CDP(ws); } catch (e) { await sleep(250); } } throw new Error('t'); }
  send(m, p) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method: m, params: p || {} })); return new Promise((r) => this.map.set(id, r)); }
  async eval(e, t) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true, timeout: t || 120000 }); if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; } return r.result && r.result.result ? r.result.result.value : undefined; }
  close() { try { this.ws.close(); } catch (e) {} }
}

const SYS = [
  'You are a lexicographer reviewing an English vocabulary card for a Chinese university campus-safety officer (CEFR B1-B2).',
  'Judge strictly and honestly. Output JSON only, no prose.',
  'Schema:',
  '{"collocations":[{"index":1,"idiomatic":true|false,"register":"formal|neutral|informal|technical|literary|dated","issue":"具体问题，没问题就空字符串"}],',
  ' "missing_senses":["对这个学习者常用但词条里没有的义项，没有就空数组"],',
  ' "verdict":"ok|needs_fix","reason":"一句话"}',
  '注意：idiomatic=false 只在搭配本身不地道或语法有问题时才用；风格偏好不算问题。register 要逐条给。',
].join('\n');

const CASES = [
  {
    name: 'lost and found（正常样本）',
    expect: 'ok',
    entry: {
      term: 'lost and found',
      senses: [{ pos: 'noun', def_zh: '失物招领处' }],
      collocations: [
        { p: 'the lost and found', zh: '失物招领处', ex: 'I left my umbrella at the lost and found.' },
        { p: 'lost and found office', zh: '失物招领办公室', ex: 'Go to the lost and found office to claim your bag.' },
        { p: 'lost and found box', zh: '失物招领箱', ex: 'Check the lost and found box for your keys.' },
        { p: 'lost and found department', zh: '失物招领部门', ex: 'Contact the lost and found department for assistance.' },
        { p: 'at the lost and found', zh: '在失物招领处', ex: 'She found her wallet at the lost and found.' },
      ],
    },
  },
  {
    name: 'deal with（正常样本）',
    expect: 'ok',
    entry: {
      term: 'deal with',
      senses: [{ pos: 'verb', def_zh: '处理，应对' }, { pos: 'verb', def_zh: '交易，经营' }],
      collocations: [
        { p: 'deal with (something)', zh: '处理；应对', ex: 'The manager had to deal with several complaints from customers.' },
        { p: 'deal with (someone)', zh: '与…打交道', ex: 'She is very patient when she deals with difficult clients.' },
        { p: 'deal with (an issue/problem)', zh: '处理问题', ex: 'The government must deal with the issue of climate change.' },
        { p: 'deal in (something)', zh: '经营；买卖', ex: 'The shop deals in antique furniture and rare books.' },
        { p: 'deal with (a situation)', zh: '应对局面', ex: 'He stayed calm and dealt with the situation professionally.' },
      ],
    },
  },
  {
    name: 'pedestrian（已知缺义项的样本）',
    expect: 'needs_fix',
    entry: {
      term: 'pedestrian',
      senses: [{ pos: 'adjective', def_zh: '乏味无趣的，缺乏想象力的' }],
      collocations: [
        { p: 'pedestrian prose', zh: '乏味的散文', ex: "The novel's pedestrian prose failed to capture the critics' imagination." },
        { p: 'pedestrian performance', zh: '平淡的表演', ex: 'The team gave a pedestrian performance and lost the match.' },
      ],
    },
  },
];

const probe = (c) => `(async function(){
  const C = await import('./js/cloud.js?v=${VER}');
  const t0 = Date.now();
  let out = '', err = null;
  try {
    out = await C.chatText({
      system: ${JSON.stringify(SYS)},
      user: 'Entry: ' + ${JSON.stringify(JSON.stringify(c.entry))},
      json: true, temperature: 0, maxTokens: 700,
    });
  } catch (e) { err = String((e && e.message) || e).slice(0, 100); }
  return { ms: Date.now() - t0, out: out, err: err };
})()`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-rev-'));
  const port = 10011;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + tmp, SITE], { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  try {
    let pg = null;
    for (let i = 0; i < 100; i++) { await sleep(300); try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); pg = (l || []).find((x) => x.type === 'page'); if (pg) break; } catch (e) {} }
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 40; i++) { await sleep(400); if ((await cdp.eval('!!(window.WorkBuddyCloud)')) === true) break; }

    let totalMs = 0;
    for (const c of CASES) {
      const r = await cdp.eval(probe(c), 90000);
      totalMs += (r && r.ms) || 0;
      console.log('\n───── ' + c.name + ' （期望：' + c.expect + '）');
      if (!r || r.err) { console.log('  ERR ' + ((r && r.err) || 'no result')); continue; }
      console.log('  用时 ' + r.ms + 'ms');
      let j = null;
      try { j = JSON.parse(r.out) } catch (e) { j = null }
      if (!j) { console.log('  原始输出：' + String(r.out).slice(0, 400)); continue; }
      console.log('  verdict: ' + j.verdict + '　|　' + (j.reason || ''));
      (j.collocations || []).forEach((x) => {
        console.log('   ' + x.index + '. idiomatic=' + x.idiomatic + ' register=' + x.register +
          (x.issue ? '  ⚠ ' + x.issue : ''));
      });
      console.log('  missing_senses: ' + JSON.stringify(j.missing_senses || []));
    }
    console.log('\n平均 ' + Math.round(totalMs / CASES.length) + 'ms／词条');
    console.log('推算：232 条已学词条约 ' + Math.round(totalMs / CASES.length * 232 / 60000) + ' 分钟；1578 条全库约 ' +
      Math.round(totalMs / CASES.length * 1578 / 60000) + ' 分钟');
  } catch (e) { console.log('ERR', e.message); }
  finally { if (cdp) cdp.close(); try { proc.kill(); } catch (e) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
})();
