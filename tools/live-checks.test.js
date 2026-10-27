'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CDP, requestPolicy, startupAction, requestGuard, prepareProfile, prepare, summaryStatus } = require('./lib/live-checks.js');
const { validateState } = require('./qa-release-live.js');
const { validateRead } = require('./qa-words-read-live.js');

test('empty QA account is valid; nonempty unhydrated or malformed state fails', () => {
  assert.deepEqual(validateState({ phase: 'ready', cards: [], words: [] }), { arrays: true, hydrated: true });
  assert.equal(validateState({ phase: 'ready', cards: [1], words: [] }).hydrated, false);
  assert.equal(validateState({ phase: 'error', cards: [], words: [] }).arrays, false);
  assert.equal(validateState({ phase: 'ready', cards: null, words: [] }).arrays, false);
});

test('read validation rejects errors, null counts and wrong hydrated IDs', () => {
  const valid = { rows: 2, count: 10, asked: 2, idsMatch: true };
  assert.ok(Object.values(validateRead(valid)).every(Boolean));
  assert.equal(validateRead({ ...valid, count: null }).counted, false);
  assert.equal(validateRead({ ...valid, limitError: true }).limited, false);
  assert.equal(validateRead({ ...valid, idsMatch: false }).hydrated, false);
  assert.equal(validateRead({ rows: 0, count: 0, asked: 0 }).consistent, true);
  assert.equal(validateRead({ rows: 0, count: 2, asked: 0 }).consistent, false);
});

test('network guard blocks writes/RPC, registration, OTP, cross-origin login and unrequested model calls', () => {
  const cfg = { site: 'https://example.invalid/', allowLogin: true, allowModel: true };
  const policy = requestPolicy(cfg);
  const request = (method, endpoint) => policy({ method, url: 'https://example.invalid' + endpoint });
  assert.equal(request('GET', '/.cloud/database/rest/words'), true);
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) assert.equal(request(method, '/.cloud/database/rest/cards'), false);
  assert.equal(request('POST', '/.cloud/database/rest/rpc/record_review'), false);
  assert.equal(request('GET', '/.cloud/database/rest/rpc/record_review'), false);
  assert.equal(request('POST', '/.cloud/auth/v1/signup'), false);
  assert.equal(request('POST', '/.cloud/auth/v1/verification'), false);
  assert.equal(policy({ method: 'POST', url: 'https://other.invalid/.cloud/auth/v1/signin' }), false);
  assert.equal(request('POST', '/.cloud/auth/v1/signin'), true);
  assert.equal(request('POST', '/.cloud/llm/chat/completions'), false);
  policy.permitModelOnce();
  assert.equal(request('POST', '/.cloud/llm/chat/completions'), true);
  assert.equal(request('POST', '/.cloud/llm/chat/completions'), false);
  assert.equal(requestPolicy({ ...cfg, allowLogin: false })({ method: 'POST', url: cfg.site + '.cloud/auth/v1/signin' }), false);
});

test('only exact no-argument study_stats is rewritten; settings writes get an error, never success', async () => {
  const cfg = { site: 'https://example.invalid/' };
  const allowed = requestPolicy(cfg);
  const stats = { method: 'POST', url: cfg.site + '.cloud/database/rest/rpc/study_stats', postData: '{}',
    headers: { Authorization: 'fixture', 'Content-Type': 'application/json', 'Content-Length': '2' } };
  assert.equal(startupAction(cfg, stats, allowed), 'read-rpc');
  for (const postData of ['[]', 'null', '{"owner_id":"other"}', '{bad']) {
    assert.equal(startupAction(cfg, { ...stats, postData }, allowed), 'block');
  }
  assert.equal(startupAction(cfg, { ...stats, hasPostData: true, postData: undefined }, allowed), 'block');
  assert.equal(startupAction(cfg, { ...stats, url: stats.url + '?owner_id=other' }, allowed), 'block');
  assert.equal(startupAction(cfg, { ...stats, url: stats.url.replace('example.invalid', 'other.invalid') }, allowed), 'block');
  assert.equal(startupAction(cfg, { ...stats, url: stats.url.replace('study_stats', 'record_review') }, allowed), 'block');
  assert.equal(allowed({ ...stats, method: 'GET' }), true);
  const settings = { method: 'POST', url: cfg.site + '.cloud/database/rest/settings?on_conflict=owner_id',
    postData: JSON.stringify({ daily_new: 8, daily_max_review: 300, target_retention: 0.9,
      extra: { day_plan: { date: '2026-10-20', due: 0, newGoal: 0 } } }) };
  assert.equal(startupAction(cfg, settings, allowed), 'suppress-settings');
  assert.equal(startupAction(cfg, { ...settings, postData: '{"extra":{}}' }, allowed), 'block');
  assert.equal(startupAction(cfg, { ...settings, method: 'PATCH' }, allowed), 'block');
  const calls = [], audit = { blocked: 0, guardErrors: 0, readRpc: 0, suppressedSettings: 0 };
  const guard = requestGuard(cfg, { send: async (method, params) => calls.push({ method, params }) }, audit);
  guard.handle({ method: 'Fetch.requestPaused', params: { requestId: 'stats', request: stats } });
  guard.handle({ method: 'Fetch.requestPaused', params: { requestId: 'settings', request: settings } });
  await guard.drain();
  assert.equal(calls[0].method, 'Fetch.continueRequest');
  assert.equal(calls[0].params.method, 'GET');
  assert.equal(calls[0].params.postData, '');
  assert.deepEqual(calls[0].params.headers, [{ name: 'Authorization', value: 'fixture' }]);
  assert.equal(calls[1].method, 'Fetch.fulfillRequest');
  assert.equal(calls[1].params.responseCode, 403);
  assert.equal(JSON.parse(Buffer.from(calls[1].params.body, 'base64')).code, 'QA_WRITE_SUPPRESSED');
  assert.deepEqual(audit, { blocked: 0, guardErrors: 0, readRpc: 1, suppressedSettings: 1 });
  guard.handle({ method: 'Network.responseReceived', params: { response: { url: stats.url, status: 405, headers: { private: 'not exported' } } } });
  assert.deepEqual(audit.statsHttpStatuses, [405]);
  assert.ok(!JSON.stringify(audit).includes('not exported'));
});

test('actual v108 syncPull handles rollover without a settings POST and reads statistics via GET', async () => {
  const { pathToFileURL } = require('node:url');
  for (const rejectGet of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiloop-startup-test-'));
    const previousFixture = globalThis.__lexiloopStartup;
    const previousStorage = globalThis.localStorage;
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
      for (const name of ['store.js', 'config.js', 'fsrs.js', 'goal-metrics.js']) {
        fs.copyFileSync(path.join(__dirname, '../lexiloop/js', name), path.join(dir, name));
      }
      fs.writeFileSync(path.join(dir, 'cloud.js'), 'export function db(){return globalThis.__lexiloopStartup.db;} export async function getSession(){return null;}');
      globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
      const cfg = { site: 'https://example.invalid/' };
      const audit = { blocked: 0, guardErrors: 0, readRpc: 0, suppressedSettings: 0 };
      const requests = new Map(), forwarded = [];
      const guard = requestGuard(cfg, { send: async (method, params) => {
        const pending = requests.get(params.requestId);
        if (method === 'Fetch.fulfillRequest') {
          pending.resolve({ data: null, error: JSON.parse(Buffer.from(params.body, 'base64')) });
        } else if (method === 'Fetch.failRequest') pending.resolve({ data: null, error: Error('blocked') });
        else {
          const request = { ...pending.request, method: params.method || pending.request.method };
          forwarded.push(request);
          assert.equal(request.method, 'GET', 'no non-read startup request reaches the fixture server');
          pending.resolve(rejectGet ? { data: null, error: Error('GET RPC unsupported') } : { data: [], error: null });
        }
      } }, audit);
      const transport = (request) => new Promise((resolve) => {
        const id = String(requests.size + 1); requests.set(id, { request, resolve });
        guard.handle({ method: 'Fetch.requestPaused', params: { requestId: id, request } });
      });
      const settings = { daily_new: 8, daily_max_review: 300, target_retention: 0.9,
        extra: { day_plan: { date: '2000-01-01', due: 0, newGoal: 0 } } };
      const db = {
        rpc: (name) => transport({ method: 'POST', url: cfg.site + '.cloud/database/rest/rpc/' + name, postData: '{}' }),
        from: (table) => {
          let row, operation = 'read';
          const builder = {
            select() { return this; }, range() { return this; }, order() { return this; }, limit() { return this; },
            upsert(value) { row = value; operation = 'write'; return this; },
            maybeSingle: async () => ({ data: table === 'settings' ? settings : null, error: null }),
            then(resolve, reject) {
              const result = operation === 'write'
                ? transport({ method: 'POST', url: cfg.site + '.cloud/database/rest/' + table + '?on_conflict=owner_id', postData: JSON.stringify(row) })
                : Promise.resolve({ data: [], error: null });
              return result.then(resolve, reject);
            },
          };
          return builder;
        },
      };
      globalThis.__lexiloopStartup = { db };
      const S = await import(pathToFileURL(path.join(dir, 'store.js')).href);
      S.state.user = { id: 'qa-fixture' };
      if (rejectGet) {
        await assert.rejects(S.syncPull(), /GET RPC unsupported/);
        assert.equal(S.state.load.phase, 'error');
      } else {
        await S.syncPull();
        assert.equal(S.state.load.phase, 'ready');
        assert.notEqual(S.state.settings.day_plan.date, '2000-01-01');
      }
      await guard.drain();
      assert.equal(audit.suppressedSettings, 1);
      assert.equal(audit.readRpc, 1);
      assert.equal(audit.blocked, 0);
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0].method, 'GET'); // No fallback even when the GET was rejected.
    } finally {
      globalThis.__lexiloopStartup = previousFixture; globalThis.localStorage = previousStorage;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a normal profile, different identity, and concurrent QA run are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiloop-qa-test-'));
  const cfg = { profile: dir, site: 'https://example.invalid/', email: 'qa@example.invalid' };
  try {
    fs.writeFileSync(path.join(dir, 'existing-user-data'), 'fixture');
    assert.throws(() => prepareProfile(cfg), /unmarked/);
    fs.unlinkSync(path.join(dir, 'existing-user-data'));
    const unlock = prepareProfile(cfg);
    assert.throws(() => prepareProfile(cfg));
    unlock();
    assert.throws(() => prepareProfile({ ...cfg, email: 'other@example.invalid' }), /different/);
    prepareProfile(cfg)();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CDP rejects protocol errors, evaluation exceptions, disconnects and missing responses', async () => {
  const ws = { send(value) { this.sent = JSON.parse(value); }, close() {} };
  const cdp = new CDP(ws, 15);
  const error = cdp.send('Test');
  ws.onmessage({ data: JSON.stringify({ id: ws.sent.id, error: { message: 'fixture' } }) });
  await assert.rejects(error, /protocol/);
  const evaluation = cdp.eval('fixture', 20);
  ws.onmessage({ data: JSON.stringify({ id: ws.sent.id, result: { exceptionDetails: { text: 'fixture' } } }) });
  await assert.rejects(evaluation, /evaluation/);
  const disconnected = cdp.send('Test'); ws.onclose(); await assert.rejects(disconnected, /disconnected/);
  await assert.rejects(cdp.send('Test'), /timed out/);
});

test('fail and skip remain distinct; an empty suite cannot pass', () => {
  assert.equal(summaryStatus([]), 'fail');
  assert.equal(summaryStatus([{ status: 'pass' }]), 'pass');
  assert.equal(summaryStatus([{ status: 'skip' }]), 'partial');
  assert.equal(summaryStatus([{ status: 'fail' }, { status: 'skip' }]), 'fail');
});

test('all live CLI tools fail closed without configuration and do not launch a browser', () => {
  for (const tool of ['qa-release-live.js', 'qa-words-read-live.js', 'qa-release-shot.js']) {
    const child = spawnSync(process.execPath, [path.join(__dirname, tool)], {
      env: { ...process.env, LEXILOOP_TEST_EMAIL: '' }, encoding: 'utf8', timeout: 3000,
    });
    assert.equal(child.status, 2, tool);
    const output = JSON.parse(child.stdout.trim().replace(/^RESULT_JSON=/, ''));
    assert.equal(output.status, 'fail');
    assert.equal(output.results[0].pass, false);
  }
});

test('prepare rejects wrong source and wrong server identity before running any task', async () => {
  const cfg = { sha: 'a'.repeat(40), ver: '108', email: 'qa@example.invalid' };
  let responses = [true, { sha: 'b'.repeat(40), ver: '108' }];
  await assert.rejects(prepare({ eval: async () => responses.shift() }, cfg, () => {}), /mismatch/);
  responses = [true, { sha: cfg.sha, ver: cfg.ver }, { ok: true, match: false }];
  await assert.rejects(prepare({ eval: async () => responses.shift() }, cfg, () => {}), /account/);
});

test('actual runner exits 1 for failed assertions, interrupted tasks and blocked requests', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lexiloop-qa-result-test-'));
  try {
    for (const scenario of ['assertion', 'exception', 'blocked', 'pass', 'skip', 'suppressed']) {
      const program = `
        const {run}=require(${JSON.stringify(path.join(__dirname, 'lib/live-checks.js'))});
        const cfg={sha:'a'.repeat(40),ver:'108',email:'qa@example.invalid',out:${JSON.stringify(out)}};
        const responses=[true,{sha:cfg.sha,ver:cfg.ver},{ok:true,match:true},true,true,true];
        run('fixture',async({add,skip})=>{
          if(${JSON.stringify(scenario)}==='exception')throw Error('private fixture content');
          if(${JSON.stringify(scenario)}==='skip')skip('fixture','not exercised');
          else add('fixture',${JSON.stringify(scenario)}!=='assertion');
        },{loadConfig:()=>cfg,launch:async()=>({cdp:{eval:async()=>responses.shift()},
          audit:{blocked:${scenario === 'blocked' ? 1 : 0},guardErrors:0,suppressedSettings:${scenario === 'suppressed' ? 1 : 0}},close:async()=>{}})});
      `;
      const child = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 3000 });
      assert.equal(child.status, ['pass', 'skip', 'suppressed'].includes(scenario) ? 0 : 1, scenario);
      const result = JSON.parse(child.stdout.trim().replace(/^RESULT_JSON=/, ''));
      assert.equal(result.status, ['skip', 'suppressed'].includes(scenario) ? 'partial' : scenario === 'pass' ? 'pass' : 'fail');
      assert.ok(!child.stdout.includes('private fixture content'));
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
