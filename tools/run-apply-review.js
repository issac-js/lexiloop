'use strict';
/* LexiLoop · reviewed 词条改进建议回填（最小增量补丁）
 *
 * 背景：全库复核后 847 条标为 reviewed，verify_note 里记录了模型建议（缺义项 / 搭配瑕疵）。
 *      本脚本把这些建议"回填"成结构化补丁——只输出最小增量，不重写整条：
 *        · add_senses  追加缺失义项（纯新增，低风险）
 *        · fix_collocs 按索引替换某条搭配（最小改动）
 *      由 SQL 函数 apply_content_patch(ops) 合并写回，原文有备份，可回滚。
 *
 * 模型只"执行已记录的判断"，不重新评判 —— 复核结论已由人筛过一轮。
 *
 * 用法：
 *   node tools/run-apply-review.js --limit 40          # 试跑前 40 条
 *   node tools/run-apply-review.js                     # 全部（断点续跑）
 *   node tools/run-apply-review.js --only sense        # 只处理缺义项类
 *
 * 输出：backup/review-patch-<日期>.json（含每个词条的 ops + 合并后的最终 payload）
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
const VER = [...vs][0] || '101';

const ARGS = process.argv.slice(2);
const getArg = (k, d) => { const i = ARGS.indexOf(k); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };
const LIMIT = parseInt(getArg('--limit', '0'), 10) || 0;
const ONLY = getArg('--only', 'all'); // all | sense | colloc

const OUT = path.resolve(__dirname, '..', 'backup', `review-patch-${new Date().toISOString().slice(0, 10)}.json`);

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(u, t = 120) { for (let i = 0; i < t; i++) { try { const ws = new WebSocket(u); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(0); }); return new CDP(ws); } catch (e) { await sleep(250); } } throw new Error('cannot connect CDP'); }
  send(m, p) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method: m, params: p || {} })); return new Promise((r) => this.map.set(id, r)); }
  async eval(e, t) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true, timeout: t || 240000 }); if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; } return r.result && r.result.result ? r.result.result.value : undefined; }
  close() { try { this.ws.close(); } catch (e) {} }
}

const SYS = [
  'You are a lexicographer fixing an English vocabulary card for a Chinese university campus-safety officer (CEFR B1-B2).',
  'You are given the CURRENT card and a REVIEWER NOTE listing required improvements.',
  'Convert the reviewer note into a MINIMAL patch. Output JSON only, no prose.',
  'Rules:',
  '· add_senses: senses from the note that are genuinely missing. Proper dict-style def_en + short def_zh + pos (noun|verb|adjective|adverb|preposition|conjunction|fixed phrase). If none, [].',
  '· fix_collocs: for "第 N 条搭配" issues, output {"index":N,"pattern":"...","type":"...","zh":"...","example_en":"...","example_zh":"..."} that FIXES it. Only include entries the note actually criticizes. If none, [].',
  '· Never delete existing senses. Never rewrite collocations that are NOT criticized.',
  '· If the note reports a FALSE ALARM (the criticized usage is actually standard), set fix_collocs=[] and explain in reason.',
  'Schema: {"add_senses":[{"def_en":"","def_zh":"","pos":""}],"fix_collocs":[{"index":1,"pattern":"","type":"","zh":"","example_en":"","example_zh":""}],"reason":""}',
  'type 参考值: verb+noun | verb+prep | adj+noun | noun+noun | fixed phrase | prep+noun | compound | noun+of | verb+adj | adv+verb',
].join('\n');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'applyrev-'));
  const port = 10027;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + tmp, SITE], { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  try {
    let pg = null;
    for (let i = 0; i < 120; i++) { await sleep(300); try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); pg = (l || []).find((x) => x.type === 'page'); if (pg) break; } catch (e) {} }
    if (!pg) throw new Error('no page');
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 50; i++) { await sleep(400); if ((await cdp.eval('!!(window.WorkBuddyCloud)')) === true) break; }

    // 取 reviewed 词条（匿名可读 words 表），分页拉全
    const rows = await cdp.eval(`(async function(){
      const C = await import('./js/cloud.js?v=${VER}');
      let all = [], from = 0;
      for (;;) {
        const res = await C.db().from('words').select('id,lemma,normalized,payload,verify_note')
          .eq('verification_status','reviewed').order('id').range(from, from + 499);
        if (res.error) return { err: String(res.error.message || res.error) };
        const d = res.data || []; all = all.concat(d); if (d.length < 500) break; from += 500;
      }
      return { n: all.length, data: all };
    })()`, 120000);
    if (!rows || rows.err) throw new Error('取词条失败：' + ((rows && rows.err) || 'no result'));

    let list = rows.data.filter((w) => w.verify_note && String(w.verify_note).trim());
    if (ONLY === 'sense') list = list.filter((w) => w.verify_note.includes('缺义项') && !w.verify_note.includes('搭配'));
    if (ONLY === 'colloc') list = list.filter((w) => w.verify_note.includes('搭配') && !w.verify_note.includes('缺义项'));
    if (LIMIT) list = list.slice(0, LIMIT);

    // 断点续跑：读旧文件，跳过已完成的 id
    let done = {};
    if (fs.existsSync(OUT)) { try { const old = JSON.parse(fs.readFileSync(OUT, 'utf8')); (old.results || []).forEach((r) => { done[r.id] = r; }); } catch (e) {} }
    console.log(`待处理 ${list.length} 条（已完成 ${Object.keys(done).length}）  version=${VER}\n`);

    const results = Object.values(done);
    let ok = 0, err = 0;
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (done[w.id]) continue;
      const entry = {
        t: w.lemma || w.normalized,
        pos: (w.payload && w.payload.pos) || [],
        senses: ((w.payload && w.payload.senses) || []).map((s) => ({ def_en: s.def_en, def_zh: s.def_zh, pos: s.pos })),
        collocations: ((w.payload && w.payload.collocations) || []).map((c, idx) => ({ index: idx + 1, pattern: c.pattern, type: c.type, zh: c.zh, ex: ((c.examples || [])[0] || {}).en })),
      };
      let r = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        r = await cdp.eval(`(async function(){
          const C = await import('./js/cloud.js?v=${VER}');
          const t0 = Date.now(); let out = '', e2 = null;
          try { out = await C.chatText({ system: ${JSON.stringify(SYS)}, user: 'CURRENT CARD: ' + JSON.stringify(${JSON.stringify(entry)}) + '\\nREVIEWER NOTE: ' + ${JSON.stringify(String(w.verify_note))}, json: true, temperature: 0, maxTokens: 900 }); }
          catch (ex) { e2 = String((ex && ex.message) || ex).slice(0, 100); }
          return { ms: Date.now() - t0, out: out, err: e2 };
        })()`, 90000);
        const limited = r && r.err && /限流|rate|429|稍后|busy|繁忙/i.test(r.err);
        if (!limited) break;
        const wait = 3000 * Math.pow(2, attempt);
        process.stdout.write(`    ↻ 限流，等待 ${Math.round(wait / 1000)}s 重试(${attempt + 1}/6)\n`);
        await sleep(wait);
      }
      await sleep(400); // 基础节流，避免触发限流

      let j = null; if (r && !r.err) { try { j = JSON.parse(r.out); } catch (e) { j = null; } }
      const rec = { id: w.id, lemma: entry.t, note: String(w.verify_note).slice(0, 200),
        add_senses: (j && j.add_senses) || [], fix_collocs: (j && j.fix_collocs) || [],
        reason: j ? (j.reason || '') : ((r && r.err) || 'parse_fail'), ms: (r && r.ms) || 0,
        // 合并后的最终 payload（供写回）
        final_payload: null };
      // 合并（在 Node 侧做，供 SQL 直接落库）
      if (j) {
        const p = JSON.parse(JSON.stringify(w.payload || {}));
        if (!Array.isArray(p.senses)) p.senses = [];
        (j.add_senses || []).forEach((s) => { if (s && s.def_en) p.senses.push({ def_en: s.def_en, def_zh: s.def_zh || '', pos: s.pos || 'noun' }); });
        if (!Array.isArray(p.collocations)) p.collocations = [];
        (j.fix_collocs || []).forEach((f) => {
          const idx = (f.index | 0) - 1;
          if (idx >= 0 && idx < p.collocations.length) {
            const old = p.collocations[idx] || {};
            p.collocations[idx] = { confidence: old.confidence != null ? old.confidence : null,
              examples: [{ en: f.example_en || '', zh: f.example_zh || '' }],
              pattern: f.pattern || old.pattern, register: old.register || 'neutral',
              strength: old.strength || 'medium', type: f.type || old.type, zh: f.zh || old.zh };
          }
        });
        rec.final_payload = p;
        if (rec.add_senses.length || rec.fix_collocs.length) ok++; else err++;
      } else { err++; }
      results.push(rec);
      if (i % 10 === 0 || i === list.length - 1) {
        fs.writeFileSync(OUT, JSON.stringify({ meta: { ran_at: new Date().toISOString(), version: VER, only: ONLY, total: results.length }, results }, null, 0));
      }
      process.stdout.write(`[${i + 1}/${list.length}] ${entry.t} → +义项${rec.add_senses.length} 修搭配${rec.fix_collocs.length}${j ? '' : ' ERR'} (${rec.ms}ms)\n`);
    }
    fs.writeFileSync(OUT, JSON.stringify({ meta: { ran_at: new Date().toISOString(), version: VER, only: ONLY, total: results.length }, results }, null, 0));
    console.log(`\n══════ 完成 ══════\n有效补丁 ${ok} 条，无改动/失败 ${err} 条`);
    console.log('输出：' + OUT);
  } catch (e) { console.log('ERR', e.message); }
  finally { if (cdp) cdp.close(); try { proc.kill(); } catch (e) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
})();
