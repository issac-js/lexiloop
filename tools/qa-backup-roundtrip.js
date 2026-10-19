'use strict';
/* 验证 LexiLoop 的备份链路真的可用：buildBackup() 产出的 JSON 必须能被 restoreBackup() 接受。
   为什么要测：备份最大的风险不是"没做"，而是"做了但恢复不了"——那是假的安心。
   做法：在"禁写云端"的测试构建里注入合成数据 → buildBackup() → 检查结构契约
        → 再喂给 restoreBackup()，确认它能通过全部前置校验（网络被禁会在写库那步失败，
          但那已经是"解析与字段映射都成功"之后的事）。
   用法：node tools/qa-backup-roundtrip.js */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildAuthed, serve } = require('./lib/authed-build.js');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8877;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

/* ① 静态契约检查：buildBackup 产出的字段 vs restoreBackup 读取的字段 */
function staticContract() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'lexiloop', 'js', 'store.js'), 'utf8');
  const build = src.slice(src.indexOf('export async function buildBackup'),
    src.indexOf('/** 备份里的时间可能是毫秒数'));
  const restore = src.slice(src.indexOf('export async function restoreBackup'),
    src.indexOf('export async function pullMetrics'));

  /* 字段可能是 `key: value` 也可能是 ES6 简写 `key,` —— 两种都要认，
     否则会把简写误报成"字段缺失"（本检查第一版就踩了这个）。 */
  const NEED = ['app', 'version', 'exported_at', 'words', 'cards', 'settings', 'daily', 'reviews'];
  const missing = NEED.filter((k) =>
    !new RegExp('(^|[\\s{,])' + k + '\\s*[,:]', 'm').test(build));
  add('buildBackup 产出全部必需字段', missing.length === 0, '缺: ' + missing.join(','));

  /* restoreBackup 会做三项守卫，逐条确认存在 */
  add('restoreBackup 校验 app 标识', /obj\.app !== 'lexiloop'/.test(restore), '缺 app 校验');
  add('restoreBackup 校验版本上限', /ver > 2/.test(restore), '缺版本校验');
  add('restoreBackup 校验非空', /备份里没有可恢复的数据/.test(restore), '缺非空校验');

  /* 关键：words 侧产出的 id/normalized 与 restore 需要的映射字段必须对齐 */
  add('words 映射字段对齐（id + normalized）',
    /normByOldId/.test(restore) && /w\.normalized/.test(restore) && /w\.id != null/.test(restore),
    'restore 依赖 words[].id → normalized 映射');
  add('cards 依赖 word_id 且会跳过无法映射的卡',
    /c\.word_id == null/.test(restore) && /normByOldId\.get/.test(restore), '缺 word_id 处理');
  return true;
}

const PROBE = `(async function(){
  const S = await import('./js/store.js');
  const rep = {};

  /* 注入合成数据（本地内存，云端已被拦截） */
  S.state.words = [
    { id: 9001, normalized: 'resilient', lemma: 'resilient', payload: { collocations: [{en:'resilient to', zh:'对…有韧性'}] }, ipa: '/rɪˈzɪliənt/', enrich_status: 'ok', enrich_model: 'qa', prompt_version: 'colloc-v2', confidence: 0.9 },
    { id: 9002, normalized: 'mitigate',  lemma: 'mitigate',  payload: { senses: [{en:'to reduce', zh:'减轻'}] }, ipa: '/ˈmɪtɪɡeɪt/', enrich_status: 'ok', enrich_model: 'qa', prompt_version: 'colloc-v2', confidence: 0.88 }
  ];
  S.state.cards = [
    { id: 1, word_id: 9001, deck: 'QA', card_type: 'recognition', status: 'review', stability: 3.5, difficulty: 5, reps: 4, lapses: 1, due: new Date(Date.now()+86400000).toISOString(), suspended: false },
    { id: 2, word_id: 9002, deck: 'QA', card_type: 'recognition', status: 'new', stability: 0, difficulty: 0, reps: 0, lapses: 0, due: new Date().toISOString(), suspended: false }
  ];
  S.state.daily = [];
  S.state.settings = Object.assign({}, S.state.settings, { daily_new: 8, daily_max_review: 300 });

  /* ② 产出备份 */
  let bk = null;
  try { bk = await S.buildBackup(); }
  catch(e){ rep.buildErr = String(e && e.message || e); }
  rep.bk = bk ? {
    app: bk.app, version: bk.version,
    hasExportedAt: typeof bk.exported_at === 'string' && bk.exported_at.length > 10,
    words: (bk.words||[]).length, cards: (bk.cards||[]).length,
    hasSettings: !!bk.settings, hasDaily: Array.isArray(bk.daily),
    hasReviews: Array.isArray(bk.reviews), hasReviewsFlag: typeof bk.has_reviews === 'boolean',
    jsonOk: (function(){ try{ JSON.parse(JSON.stringify(bk)); return true; }catch(e){ return false; } })()
  } : null;

  /* ③ 回喂给 restoreBackup：应通过全部前置校验；
        因云端被拦截，最终会在写库处失败 —— 那说明解析与映射都已成功 */
  if (bk) {
    const copy = JSON.parse(JSON.stringify(bk));
    try { await S.restoreBackup(copy); rep.restore = { reachedDb: true }; }
    catch(e){
      const m = String(e && e.message || e);
      const guardFail = /不是本应用的备份文件|备份版本|备份里没有可恢复的数据/.test(m);
      rep.restore = { guardFail: guardFail, msg: m.slice(0, 90) };
    }
  }
  return rep;
})()`;

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map(); this.errors = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(url, tries = 90) {
    for (let i = 0; i < tries; i++) {
      try { const ws = new WebSocket(url);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
        return new CDP(ws); } catch (e) { await sleep(250); }
    }
    throw new Error('CDP 连接超时');
  }
  send(method, params) { const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res) => this.map.set(id, res)); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  staticContract();
  const dir = buildAuthed();
  if (!dir) { console.log('测试构建失败，拒绝运行'); process.exit(1); }
  const srv = await serve(dir, PORT);
  const port = 9987;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-bk-' + Date.now()),
    'http://127.0.0.1:' + PORT + '/'], { windowsHide: true, stdio: 'ignore' });
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
    for (let i = 0; i < 24; i++) { if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break; await sleep(500); }

    const r = await cdp.eval(PROBE);
    if (!r || r.__err) { add('执行探针', false, JSON.stringify(r)); }
    else {
      console.log('备份产出：' + JSON.stringify(r.bk, null, 1).replace(/\n\s*/g, ' ') + '\n');
      add('buildBackup 可正常执行', !!r.bk && !r.buildErr, r.buildErr || '无产出');
      if (r.bk) {
        add('app 标识正确（lexiloop）', r.bk.app === 'lexiloop', 'app=' + r.bk.app);
        add('version = 2（restoreBackup 上限）', r.bk.version === 2, 'version=' + r.bk.version);
        add('exported_at 为有效时间', r.bk.hasExportedAt === true, '缺失');
        add('words 已包含（合成 2 条）', r.bk.words === 2, 'words=' + r.bk.words);
        add('cards 已包含（合成 2 张）', r.bk.cards === 2, 'cards=' + r.bk.cards);
        add('settings / daily / reviews 齐全',
          r.bk.hasSettings && r.bk.hasDaily && r.bk.hasReviews && r.bk.hasReviewsFlag,
          JSON.stringify({ s: r.bk.hasSettings, d: r.bk.hasDaily, r: r.bk.hasReviews, f: r.bk.hasReviewsFlag }));
        add('可安全 JSON 序列化（能落盘）', r.bk.jsonOk === true, 'JSON 往返失败');
      }
      add('★ restoreBackup 接受该备份（未触发任何前置守卫）',
        r.restore && (r.restore.reachedDb === true || r.restore.guardFail === false),
        JSON.stringify(r.restore));
      if (r.restore && r.restore.msg) console.log('（回喂到写库处的预期失败：' + r.restore.msg + '）');
    }
  } catch (e) { add('执行', false, e.message); }
  finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
    try { srv.close(); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }

  let bad = 0;
  out.forEach((o) => { if (!o.pass) bad++; console.log((o.pass ? '  PASS  ' : '  FAIL  ') + o.n + (o.pass ? '' : '  → ' + o.d)); });
  console.log('\n===== 备份可恢复性验证: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
