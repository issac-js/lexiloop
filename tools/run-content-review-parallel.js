'use strict';
/* 全库内容复核 · 后台并发版
 *
 * 背景：浏览器内逐条复核实测 55 秒/条（模型服务高峰期响应慢），剩余 1326 条要 21 小时，不可接受。
 * 改进：① 3 路并发（互不等待）② 跳过已有核验标记的词条 ③ 每条复核后**直接写库**
 *       （站点 SDK 在未登录态即可更新 words 表，RLS 允许）④ 全程日志落文件。
 *
 * 仍然只写核验标记、不碰 payload —— 复核不改内容。
 * 用法：node tools/run-content-review-parallel.js   （可反复运行，自动续跑）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = path.resolve(__dirname, '..', 'lexiloop');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SITE = 'https://lexiloop-82703.app.workbuddy.host/';
const CONCURRENCY = 3;
const LOG = path.resolve(__dirname, '..', 'backup', 'content-review-parallel.log');
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
  async eval(e, t) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true, timeout: t || 240000 }); if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; } return r.result && r.result.result ? r.result.result.value : undefined; }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-par-'));
  const port = 10023;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + tmp, SITE], { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  const log = (s) => { const line = new Date().toTimeString().slice(0, 8) + ' ' + s; console.log(line); fs.appendFileSync(LOG, line + '\n'); };
  try {
    let pg = null;
    for (let i = 0; i < 100; i++) { await sleep(300); try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); pg = (l || []).find((x) => x.type === 'page'); if (pg) break; } catch (e) {} }
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 40; i++) { await sleep(400); if ((await cdp.eval('!!(window.WorkBuddyCloud)')) === true) break; }

    // 取待复核清单（只取没有任何核验标记、且有搭配的词条）
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
    if (!list || list.err) throw new Error('取清单失败：' + ((list && list.err) || 'no result'));
    const queue = list.data;
    log('待复核 ' + queue.length + ' 条（并发 ' + CONCURRENCY + '）');

    // 3 路并发消费队列
    let idx = 0, blocking = 0, advisory = 0, errors = 0, none = 0;
    const t0 = Date.now();
    async function worker(wid) {
      for (;;) {
        const i = idx++;
        if (i >= queue.length) return;
        const e = queue[i];
        try {
          const r = await cdp.eval(`(async function(){
            const E = await import('./js/enrich.js?v=${VER}');
            const C = await import('./js/cloud.js?v=${VER}');
            const res = await E.reviewTerm(${JSON.stringify({ term: e.lem || e.t, senses: e.s, collocations: e.c })}, {});
            if (res.ok && res.severity === 'blocking') {
              await C.db().from('words').update({ verification_status: 'flagged',
                verify_note: (res.issues.join('；') || res.reason || '复核判定为 blocking').slice(0, 500),
                verified_at: new Date().toISOString() }).eq('normalized', ${JSON.stringify(e.t)});
            } else if (res.ok && (res.severity === 'advisory' || res.missing.length)) {
              const note = res.issues.concat(res.missing.map(m => '缺义项：' + m)).join('；').slice(0, 500);
              await C.db().from('words').update({ verification_status: 'reviewed',
                verify_note: note, verified_at: new Date().toISOString() }).eq('normalized', ${JSON.stringify(e.t)});
            }
            return { ok: res.ok, sev: res.ok ? res.severity : 'ERR',
              n: (res.issues || []).length, m: (res.missing || []).length, err: res.raw ? res.raw.slice(0, 60) : null };
          })()`, 240000);
          if (!r || r.err || !r.ok) { errors++; log('[' + (i + 1) + '/' + queue.length + '] ERR ' + e.t + ' ' + ((r && r.err) || '').slice(0, 60)); continue; }
          if (r.sev === 'blocking') { blocking++; log('[' + (i + 1) + '/' + queue.length + '] ⛔ ' + e.t); }
          else if (r.sev === 'advisory') { advisory++; }
          else { none++; }
        } catch (ex) { errors++; log('[' + (i + 1) + '/' + queue.length + '] EXC ' + e.t + ' ' + String(ex.message || ex).slice(0, 60)); }
        if (i % 20 === 19) {
          const done = Math.min(idx, queue.length);
          const rate = done / ((Date.now() - t0) / 60000);
          log('── 进度 ' + done + '/' + queue.length + '　阻断 ' + blocking + '　建议 ' + advisory +
            '　通过 ' + none + '　错误 ' + errors + '　速率 ' + rate.toFixed(1) + ' 条/分　剩余约 ' +
            Math.round((queue.length - done) / rate) + ' 分钟');
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, k) => worker(k)));

    const mins = Math.round((Date.now() - t0) / 60000);
    log('════ 完成 ════ ' + queue.length + ' 条 / ' + mins + ' 分钟　⛔阻断 ' + blocking + '　建议 ' +
      advisory + '　通过 ' + none + '　错误 ' + errors);
  } catch (e) { log('FATAL ' + e.message); }
  finally { if (cdp) cdp.close(); try { proc.kill(); } catch (e) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
})();
