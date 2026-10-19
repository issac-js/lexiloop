'use strict';
// Shared live QA harness. Never imported by the application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function config(env = process.env) {
  const site = new URL(env.LEXILOOP_SITE || 'https://lexiloop-82703.app.workbuddy.host/');
  if (site.protocol !== 'https:' || site.pathname !== '/' || site.search || site.hash || site.username || site.password) {
    throw new Error('LEXILOOP_SITE must be a clean HTTPS origin');
  }
  const email = (env.LEXILOOP_TEST_EMAIL || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('LEXILOOP_TEST_EMAIL is required for every live check');
  if (!/^[a-f0-9]{40}$/.test(env.LEXILOOP_EXPECT_SHA || '')) throw new Error('LEXILOOP_EXPECT_SHA must be a full commit SHA');
  if (!/^\d+$/.test(env.LEXILOOP_EXPECT_VER || '')) throw new Error('LEXILOOP_EXPECT_VER is required');
  if (!env.LEXILOOP_QA_PROFILE) throw new Error('Set a dedicated LEXILOOP_QA_PROFILE (never your normal browser profile)');
  if (!env.LEXILOOP_EDGE_PATH || !fs.existsSync(env.LEXILOOP_EDGE_PATH)) throw new Error('LEXILOOP_EDGE_PATH must point to an installed Chromium browser');
  if (typeof globalThis.WebSocket !== 'function') throw new Error('This tool requires Node 22 with global WebSocket');
  return { site: site.href, email, sha: env.LEXILOOP_EXPECT_SHA, ver: env.LEXILOOP_EXPECT_VER,
    edge: env.LEXILOOP_EDGE_PATH, profile: path.resolve(env.LEXILOOP_QA_PROFILE),
    out: path.resolve(env.LEXILOOP_QA_OUT_DIR || path.join(__dirname, '../../.workbuddy/qa')),
    allowLogin: env.LEXILOOP_ALLOW_LOGIN === '1', password: env.LEXILOOP_TEST_PASSWORD || '',
    allowModel: env.LEXILOOP_RUN_MODEL === '1' };
}

function safeError(error) {
  // Do not export browser errors, stacks, tokens, account IDs or response bodies.
  return error && error.qaSafe ? error.message : 'Operation failed; inspect locally without sharing credentials';
}
function fail(message) { const error = new Error(message); error.qaSafe = true; throw error; }

function prepareProfile(cfg) {
  fs.mkdirSync(cfg.profile, { recursive: true, mode: 0o700 });
  const marker = path.join(cfg.profile, '.lexiloop-qa-profile');
  const identity = crypto.createHash('sha256').update(cfg.site + '\n' + cfg.email).digest('hex');
  if (fs.existsSync(marker)) {
    if (fs.readFileSync(marker, 'utf8') !== identity) fail('QA profile belongs to a different site or test account');
  } else {
    if (fs.readdirSync(cfg.profile).length) fail('Refusing an existing unmarked browser profile; use a new empty QA directory');
    fs.writeFileSync(marker, identity, { mode: 0o600, flag: 'wx' });
  }
  const lock = path.join(cfg.profile, '.lexiloop-qa-lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  return () => { fs.closeSync(fd); fs.unlinkSync(lock); };
}

class CDP {
  constructor(ws, timeout = 30000) {
    this.ws = ws; this.timeout = timeout; this.id = 0; this.pending = new Map(); this.onEvent = null;
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { this.rejectAll(new Error('Malformed CDP response')); return; }
      const entry = this.pending.get(message.id);
      if (entry) {
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.error) entry.reject(new Error('CDP protocol error')); else entry.resolve(message.result);
      } else if (this.onEvent) this.onEvent(message);
    };
    ws.onclose = () => this.rejectAll(new Error('CDP disconnected'));
    ws.onerror = () => this.rejectAll(new Error('CDP transport failed'));
  }
  rejectAll(error) { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); } this.pending.clear(); }
  send(method, params = {}, timeout = this.timeout) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP command timed out')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async eval(expression, timeout = 30000) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout }, timeout + 2000);
    if (result.exceptionDetails) throw new Error('Browser evaluation failed');
    return result.result && result.result.value;
  }
  close() { this.rejectAll(new Error('CDP closed')); this.ws.close(); }
}

function requestPolicy(cfg) {
  let modelBudget = 0;
  const policy = (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/.cloud/database/rest/rpc/')) return false;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    if (url.origin !== new URL(cfg.site).origin || request.method !== 'POST') return false;
    if (url.pathname === '/.cloud/auth/v1/token') return true;
    if (cfg.allowLogin && url.pathname === '/.cloud/auth/v1/signin') return true;
    if (url.pathname === '/.cloud/llm/chat/completions' && modelBudget > 0) { modelBudget--; return true; }
    return false; // Includes all database writes/RPC, storage, registration and OTP requests.
  };
  policy.permitModelOnce = () => { if (!cfg.allowModel) fail('Model use was not enabled'); modelBudget = 1; };
  return policy;
}

async function start(cfg) {
  const unlock = prepareProfile(cfg);
  const portFile = path.join(cfg.profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const child = spawn(cfg.edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--mute-audio', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + cfg.profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let launchError = null, exited = false, cdp;
  child.on('error', (error) => { launchError = error; });
  child.on('exit', () => { exited = true; });
  const close = async () => {
    if (cdp) { try { await cdp.send('Browser.close', {}, 2000); } catch {} try { cdp.close(); } catch {} }
    if (!exited) { child.kill(); for (let i = 0; i < 20 && !exited; i++) await sleep(100); }
    // Retain the lock if shutdown is uncertain; never start a concurrent QA session.
    if (exited || launchError) unlock();
  };
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      if (launchError || exited) fail('QA browser could not start');
      if (fs.existsSync(portFile)) { port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); if (port > 0) break; }
      await sleep(200);
    }
    if (!port) fail('QA browser startup timed out');
    const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) });
    const page = (await response.json()).find((entry) => entry.type === 'page' && entry.url === 'about:blank');
    if (!page) fail('QA browser has no blank target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket connect timeout')); }, 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connect failed')); };
    });
    cdp = new CDP(ws);
    const audit = { blocked: 0, guardErrors: 0 };
    const allowed = requestPolicy(cfg);
    cdp.onEvent = (message) => {
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = message.params;
      let permit = false;
      try { permit = allowed(request); } catch { audit.guardErrors++; }
      if (!permit) audit.blocked++;
      cdp.send(permit ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        permit ? { requestId } : { requestId, errorReason: 'BlockedByClient' })
        .catch(() => { audit.guardErrors++; });
    };
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source:
      'window.__qaErrorCount=0;addEventListener("error",()=>window.__qaErrorCount++);addEventListener("unhandledrejection",()=>window.__qaErrorCount++);' });
    await cdp.send('Page.navigate', { url: cfg.site });
    return { cdp, audit, close, permitModelOnce: allowed.permitModelOnce };
  } catch (error) { await close(); throw error; }
}

async function waitFor(cdp, expression, message, limit = 30000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { if (await cdp.eval(expression)) return; await sleep(300); }
  fail(message);
}

async function prepare(cdp, cfg, add) {
  await waitFor(cdp, '!!window.WorkBuddyCloud', 'Cloud SDK did not become ready');
  const boot = await cdp.eval(`(async()=>{
    const response=await fetch('release.json?qa='+Date.now(),{cache:'no-store'});
    if(!response.ok) throw Error('release missing');
    const rel=await response.json();
    const src=document.querySelector('script[type="module"]')?.src||'';
    return {sha:rel.source_sha,ver:new URL(src).searchParams.get('v')};
  })()`);
  if (!boot || boot.sha !== cfg.sha || boot.ver !== cfg.ver) fail('Live source SHA/version mismatch');
  add('Release SHA and module version match', true);
  const modulePath = JSON.stringify('./js/cloud.js?v=' + cfg.ver);
  const checkUser = `(async()=>{const C=await import(${modulePath});const r=await C.getCloud().auth.getUser();
    return {ok:!r.error&&!!r.data,match:!r.error&&String(r.data?.email||'').trim().toLowerCase()===${JSON.stringify(cfg.email)}};})()`;
  let user = await cdp.eval(checkUser);
  if (!user?.ok && cfg.allowLogin) {
    if (!cfg.password) fail('Explicit login requires LEXILOOP_TEST_PASSWORD for an existing QA account');
    await cdp.eval(`(async()=>{const C=await import(${modulePath});await C.signInWithPassword(${JSON.stringify(cfg.email)},${JSON.stringify(cfg.password)});return true;})()`);
    user = await cdp.eval(checkUser);
  }
  if (!user?.ok || !user.match) fail('Authenticated account does not match the specified QA account');
  add('Server-confirmed QA account matches', true);
  await waitFor(cdp, `(async()=>{const S=await import(${JSON.stringify('./js/store.js?v=' + cfg.ver)});return S.state.load.phase==='ready'&&!!S.state.user;})()`, 'Application synchronization did not become ready', 60000);
  const sameUser = await cdp.eval(`(async()=>{const C=await import(${modulePath});
    const S=await import(${JSON.stringify('./js/store.js?v=' + cfg.ver)});const r=await C.getCloud().auth.getUser();
    return !r.error&&!!r.data?.id&&String(r.data.id)===String(S.state.user?.id);})()`);
  if (!sameUser) fail('Application user does not match the authenticated server user');
  add('Application synchronization ready', true);
}

function summaryStatus(results) {
  if (!results.length) return 'fail';
  return results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'skip') ? 'partial' : 'pass';
}

async function run(name, task, { loadConfig = config, launch = start } = {}) {
  let cfg, browser;
  const results = [];
  const add = (n, pass, d = '') => results.push({ n, pass: !!pass, status: pass ? 'pass' : 'fail', d });
  const skip = (n, d) => results.push({ n, pass: false, status: 'skip', d });
  let configError = false;
  try {
    try { cfg = loadConfig(); } catch (error) { configError = true; error.qaSafe = true; throw error; }
    if (name !== 'qa-release-live') cfg.allowModel = false;
    browser = await launch(cfg);
    await prepare(browser.cdp, cfg, add);
    await task({ cfg, cdp: browser.cdp, add, skip, permitModelOnce: browser.permitModelOnce });
    add('No uncaught page errors observed', await browser.cdp.eval('window.__qaErrorCount===0'));
  } catch (error) { add('Execution completed', false, safeError(error)); }
  finally {
    if (browser) {
      try { await browser.close(); } catch { add('QA browser closed', false); }
      add('No unexpected non-read requests or guard errors', browser.audit.blocked === 0 && browser.audit.guardErrors === 0,
        'blocked=' + browser.audit.blocked + '; guardErrors=' + browser.audit.guardErrors);
    }
  }
  const summary = { tool: name, at: new Date().toISOString(), expect: cfg ? { ver: cfg.ver, sha: cfg.sha } : null,
    status: summaryStatus(results), results };
  try {
    if (cfg) {
      fs.mkdirSync(cfg.out, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(cfg.out, name + '-' + Date.now() + '-' + process.pid + '.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    }
  } catch { add('Result file saved', false); summary.status = 'fail'; }
  console.log('RESULT_JSON=' + JSON.stringify(summary));
  process.exitCode = summary.status === 'fail' ? (configError ? 2 : 1) : 0;
}

module.exports = { config, CDP, requestPolicy, prepareProfile, prepare, summaryStatus, run, fail };
