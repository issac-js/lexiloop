'use strict';
/* 全库复核 · 并发版（结果写本地文件，由管理员 SQL 写回）
 * 背景：anon 无 words UPDATE 权限，脚本直写库会静默失败 —— 结论落文件是已验证的链路。
 * 只复核 verification_status 为空的词条（跳过已标记），结果含全部判定细节。
 * 用法：node tools/run-review-tofile.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = path.resolve(__dirname, '..', 'lexiloop');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SITE = 'https://lexiloop-82703.app.workbuddy.host/';
const CONCURRENCY = 3;
const OUT = path.resolve(__dirname, '..', 'backup', 'review-round2.json');
const LOG = path.resolve(__dirname, '..', 'backup', 'review-round2.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const files = ['index.html'].concat(fs.readdirSync(path.join(APP, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
const vs = new Set();
files.forEach((f) => { for (const m of read(f).matchAll(/\?v=(\d+)/g)) vs.add(m[1]); });
const VER = [...vs][0];
const log = (s) => { const line = new Date().toTimeString().slice(0, 8) + ' ' + s; console.log(line); fs.appendFileSync(LOG, line + '\n'); };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(u, t = 100) { for (let i = 0; i < t; i++) { try { const ws = new WebSocket(u); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(0); }); return new CDP(ws); } catch (e) { await sleep(250); } } throw new Error('t'); }
  send(m, p) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method: m, params: p || {} })); return new Promise((r) => this.map.set(id, r)); }
  async eval(e, t) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true, timeout: t || 240000 }); if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; } return r.result && r.result.result ? r.result.result.value : undefined; }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-round2-'));
  const port = 10039;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + tmp, SITE], { windowsHide: true, stdio: 'ignore' });
  let cdp = null; const out = [];
  try {
    let pg = null;
    for (let i = 0; i < 100; i++) { await sleep(300); try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); pg = (l || []).find((x) => x.type === 'page'); if (pg) break; } catch (e) {} }
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 40; i++) { await sleep(400); if ((await cdp.eval('!!(window.WorkBuddyCloud)')) === true) break; }

    const list = await cdp.eval(`(async function(){
      const C = await import('./js/cloud.js?v=${VER}');
      let all = [], from = 0;
      for (;;) {
        const res = await C.db().from('words').select('normalized,lemma,payload,verification_status').range(from, from + 499);
        if (res.error) return { err: String(res.error.message || res.error) };
        all = all.concat(res.data || []);
        if (!res.data || res.data.length < 500) break;
        from += 500;
      }
      return { data: all.filter(w => !w.verification_status &&
        w.payload && (w.payload.collocations || []).length > 0).map(w => ({
        t: w.normalized, lem: w.lemma,
        s: w.payload.senses || [],
        c: w.payload.collocations.map(x => ({ p: x.pattern, zh: x.zh, ex: ((x.examples || [])[0] || {}).en })),
      })) };
    })()`, 240000);
    if (!list || list.err) throw new Error('取清单失败：' + ((list && list.err) || ''));
    const queue = list.data;
    log('待复核 ' + queue.length + ' 条（并发 ' + CONCURRENCY + '）');
    let idx = 0, blocking = 0, advisory = 0, none = 0, errors = 0;
    const t0 = Date.now();
    async function worker() {
      for (;;) {
        const i = idx++;
        if (i >= queue.length) return;
        const e = queue[i];
        try {
          const r = await cdp.eval(`(async function(){ const E = await import('./js/enrich.js?v=${VER}');
            const res = await E.reviewTerm(${JSON.stringify({ term: e.lem || e.t, senses: e.s, collocations: e.c })}, {});
            return { ok: res.ok, sev: res.ok ? res.severity : 'ERR', issues: (res.issues || []).slice(0, 4),
              missing: (res.missing || []).slice(0, 4), reason: res.reason || '', raw: (res.raw || '').slice(0, 50) }; })()`, 240000);
          const rec = { term: e.t, sev: (r && r.sev) || 'ERR', issues: (r && r.issues) || [],
            missing: (r && r.missing) || [], reason: (r && r.reason) || '', raw: (r && r.raw) || '' };
          out.push(rec);
          if (rec.sev === 'blocking') { blocking++; log('[' + (i + 1) + '/' + queue.length + '] ⛔ ' + e.t + ' — ' + (rec.issues[0] || rec.reason || '').slice(0, 90)); }
          else if (rec.sev === 'advisory') advisory++;
          else if (rec.sev === 'none') none++;
          else { errors++; log('[' + (i + 1) + '/' + queue.length + '] ERR ' + e.t); }
        } catch (ex) { errors++; out.push({ term: e.t, sev: 'EXC', issues: [], missing: [], reason: String(ex.message || ex).slice(0, 80) }); }
        if (i % 25 === 24) {
          const done = Math.min(idx, queue.length);
          const rate = done / ((Date.now() - t0) / 60000);
          log('── 进度 ' + done + '/' + queue.length + '　⛔' + blocking + '　建议 ' + advisory + '　通过 ' + none +
            '　错 ' + errors + '　' + rate.toFixed(1) + ' 条/分　剩余约 ' + Math.round((queue.length - done) / rate) + ' 分钟');
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    fs.writeFileSync(OUT, JSON.stringify({ ran_at: new Date().toISOString(), total: out.length, results: out }, null, 1));
    log('════ 完成 ════ ' + out.length + ' 条　⛔' + blocking + '　建议 ' + advisory + '　通过 ' + none + '　错 ' + errors + '　结果已写入 ' + OUT);
  } catch (e) { log('FATAL ' + e.message); }
  finally { if (cdp) cdp.close(); try { proc.kill(); } catch (e) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
})();
