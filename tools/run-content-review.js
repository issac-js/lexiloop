'use strict';
/* LexiLoop · 已学词条的内容复核（地道性 / 语域 / 义项全面性）
 *
 * 这三类问题闸门覆盖不到（需要"懂英语"才能判断），本脚本用模型逐条复核。
 * 依据 2026-10-10 的对照实测：模型能命中已知缺义项、未误报正常样本，平均 1.96s/词条。
 *
 * 做法：未登录状态下 words 表可读（RLS: words_read_all），所以脚本自身取数据，
 * 不需要先导出再搬运；模型调用走站点已加载的云端通道。
 *
 * 输出：backup/content-review-<日期>.json（供人工审阅后再决定写回哪些标记）
 * **不自动写库** —— 模型也会错，标记由人确认。
 *
 * 用法：node tools/run-content-review.js
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

/* 有学习记录的词条（由 SQL 查出，124 条） */
const TERMS = 'access permission|address|ai agent|an elaborate plan|apparently|appropriate|approval|as a quick reminder|at one\'s discretion|attorney|based on|be a bit different from our records|building|campus operations|card / access control|cashmere|complaint number|concession|consent|consulate|courtesy|cursor|custody|deal with|defer to|demagnetized|detention|diabetes|diagnosis|dietary fibre|distress|division|electrical room|given|handle|hear back from sb|hereby|hesitate|if you ever situation please action|if you happen to|if you have a moment|incident|infrastructure|inhalation|injury assessment|intimidation|invoice|irregular heartbeat|keep a close eye on sth|keep sb. posted|kidney|kiosk|laminate|lane|lawmaker|lawsuit|layout|let me know how i can be of further assistance|look into sth|lost and found|low blood sugar|make a decision|make a request|make a statement|malware|mediate|mediation|menses|menstrual|migraine|mud|normally|out of my purview|overflow|pacify|pedestrian|pension|persuade|petition|phishing|pillow|plain clothes|proceed accordingly|process|quota|quotation|quotation mark|radiologist|rally|ramp|rear-end collision|reassurance|rebuke|receive an update|reference|related to|residential life|semester|send an email to sb. after|shareholder|spasm|stairwell|stakeholder|statement|stemming from|storefront|stray|subject to approval|take a stand against|tenure|the details are as follows|thigh|tier 2|urine|vaccination|vigilante|vomit|walk sb. through sth|welfare check|work order|wrist'.split('|');

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(u, t = 100) { for (let i = 0; i < t; i++) { try { const ws = new WebSocket(u); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(0); }); return new CDP(ws); } catch (e) { await sleep(250); } } throw new Error('t'); }
  send(m, p) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method: m, params: p || {} })); return new Promise((r) => this.map.set(id, r)); }
  async eval(e, t) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true, timeout: t || 240000 }); if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; } return r.result && r.result.result ? r.result.result.value : undefined; }
  close() { try { this.ws.close(); } catch (e) {} }
}

const SYS = [
  'You are a lexicographer reviewing an English vocabulary card for a Chinese university campus-safety officer (CEFR B1-B2).',
  'Judge strictly and honestly. Output JSON only, no prose.',
  'Schema:',
  '{"collocations":[{"index":1,"idiomatic":true|false,"register":"formal|neutral|informal|technical|literary|dated","issue":"具体问题，没问题就空字符串"}],',
  ' "missing_senses":["对这个学习者常用但词条里没有的义项，没有就空数组"],',
  ' "verdict":"ok|needs_fix","reason":"一句话"}',
  '注意：idiomatic=false 只在搭配本身不地道或语法有问题时才用；风格偏好不算问题。',
].join('\n');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const port = 10013;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + tmp, SITE], { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  const results = [];
  try {
    let pg = null;
    for (let i = 0; i < 100; i++) { await sleep(300); try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); pg = (l || []).find((x) => x.type === 'page'); if (pg) break; } catch (e) {} }
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 40; i++) { await sleep(400); if ((await cdp.eval('!!(window.WorkBuddyCloud)')) === true) break; }

    // 取词条（未登录可读 words 表）
    const rows = await cdp.eval(`(async function(){
      const C = await import('./js/cloud.js?v=${VER}');
      const res = await C.db().from('words').select('normalized,payload').in('normalized', ${JSON.stringify(TERMS)});
      if (res.error) return { err: String(res.error.message || res.error) };
      return { n: (res.data || []).length, data: (res.data || []).map((w) => ({
        t: w.normalized,
        s: (w.payload && w.payload.senses) || [],
        c: ((w.payload && w.payload.collocations) || []).map((x) => ({ p: x.pattern, zh: x.zh, ex: ((x.examples || [])[0] || {}).en })),
      })) };
    })()`, 120000);

    if (!rows || rows.err) throw new Error('取词条失败：' + ((rows && rows.err) || 'no result'));
    console.log('取到 ' + rows.n + ' 条词条，开始复核（约 ' + (rows.n * 2) + ' 秒）…\n');

    for (let i = 0; i < rows.data.length; i++) {
      const e = rows.data[i];
      const r = await cdp.eval(`(async function(){
        const C = await import('./js/cloud.js?v=${VER}');
        const t0 = Date.now();
        let out = '', err = null;
        try {
          out = await C.chatText({ system: ${JSON.stringify(SYS)},
            user: 'Entry: ' + JSON.stringify(${JSON.stringify(e)}),
            json: true, temperature: 0, maxTokens: 700 });
        } catch (ex) { err = String((ex && ex.message) || ex).slice(0, 80); }
        return { ms: Date.now() - t0, out: out, err: err };
      })()`, 90000);

      let j = null;
      if (r && !r.err) { try { j = JSON.parse(r.out) } catch (ex) { j = null } }
      const rec = { term: e.t, verdict: j ? j.verdict : 'ERROR', reason: j ? j.reason : ((r && r.err) || '解析失败'),
        bad: j ? (j.collocations || []).filter((x) => x.idiomatic === false).map((x) => x.index + ':' + x.issue) : [],
        missing: j ? (j.missing_senses || []) : [], ms: (r && r.ms) || 0 };
      results.push(rec);
      const flag = (rec.bad.length || rec.missing.length) ? ' ⚠' : '';
      process.stdout.write('[' + (i + 1) + '/' + rows.data.length + '] ' + e.t + ' → ' + rec.verdict + flag +
        (rec.bad.length ? '  不地道:' + rec.bad.length : '') + (rec.missing.length ? '  缺义项:' + rec.missing.length : '') + '\n');
    }

    const needFix = results.filter((x) => x.verdict === 'needs_fix');
    const withBad = results.filter((x) => x.bad.length);
    const withMissing = results.filter((x) => x.missing.length);
    const outFile = path.resolve(__dirname, '..', 'backup', 'content-review-2026-10-10.json');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ meta: { ran_at: new Date().toISOString(), total: results.length,
      terms_source: 'words with reps>0', model_prompt: SYS }, results: results }, null, 1));

    console.log('\n══════ 复核完成 ══════');
    console.log('总计 ' + results.length + ' 条　|　needs_fix ' + needFix.length +
      '　|　检出搭配问题 ' + withBad.length + ' 条　|　缺义项建议 ' + withMissing.length + ' 条');
    console.log('结果已写入 ' + outFile);
    if (needFix.length) {
      console.log('\n需要关注（前 20 条）：');
      needFix.slice(0, 20).forEach((x) => {
        console.log('  · ' + x.term + ' — ' + x.reason);
        x.bad.forEach((b) => console.log('      不地道: ' + b));
        x.missing.forEach((m) => console.log('      缺义项: ' + m));
      });
    }
  } catch (e) { console.log('ERR', e.message); }
  finally { if (cdp) cdp.close(); try { proc.kill(); } catch (e) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
})();
