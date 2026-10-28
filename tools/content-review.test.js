'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
async function fixture(run, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
  const names = ['window', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout'];
  const old = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  const storage = new Map(saved ? [['lexiloop.reviewJob', JSON.stringify(saved)]] : []);
  let timeout;
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const src = path.join(__dirname, '../lexiloop/js');
    const v = fs.readFileSync(path.join(src, 'store.js'), 'utf8').match(/config\.js\?v=(\d+)/)[1];
    for (const n of fs.readdirSync(src)) if (n.endsWith('.js')) fs.copyFileSync(path.join(src, n), path.join(dir, n));
    fs.writeFileSync(path.join(dir, 'enrich.js'), `export const requests=[]; export function reviewTerm(entry,opts){return new Promise((resolve,reject)=>requests.push({entry,opts,resolve,reject}))}`);
    const db = { error: null, writes: 0, from() { const self = this; return { update() { self.writes++; return this; }, eq() { return Promise.resolve({error:self.error}); } }; } };
    globalThis.window = { addEventListener() {}, WorkBuddyCloud: { createWorkBuddyCloud: () => ({database:db}) } };
    globalThis.localStorage = { getItem:k=>storage.get(k)||null, setItem:(k,x)=>storage.set(k,x), removeItem:k=>storage.delete(k) };
    globalThis.fetch = () => { throw Error('Network forbidden'); };
    globalThis.setTimeout = (fn, ms, ...args) => ms === 120000 ? (timeout=fn, -999) : old.setTimeout(fn,ms,...args);
    globalThis.clearTimeout = id => { if (id !== -999) old.clearTimeout(id); };
    const load = n => import(pathToFileURL(path.join(dir,n)).href+'?v='+v);
    const [S,V,E] = await Promise.all(['store.js','views.js','enrich.js'].map(load));
    S.state.words = [1,2,3].map(id=>({id,normalized:'word'+id,lemma:'word'+id,payload:{collocations:[{pattern:'word'+id}],senses:[]}}));
    S.state.cards = [1,1,2,3].map((word_id,id)=>({id,word_id,reps:1}));
    const good = {ok:true,severity:'none',issues:[],missing:[]};
    const tick = () => new Promise(resolve=>old.setTimeout(resolve,0));
    await run({S,V,E,db,storage,good,tick,expire:()=>timeout()});
  } finally {
    await new Promise(resolve=>old.setTimeout(resolve,270));
    Object.assign(globalThis,old); fs.rmSync(dir,{recursive:true,force:true});
  }
}
test('pause waits for in-flight review; resume cannot start a duplicate loop; unique word counts and skipped corrected entries',()=>fixture(async({S,V,E,storage,good,tick})=>{
  S.state.words[2].verification_status='corrected';
  const events=[]; const task=V.startReview('all',kind=>events.push(kind));
  assert.equal(V.reviewStatus().total,3); assert.equal(V.reviewStatus().done,0);
  V.pauseReview(kind=>events.push(kind));
  await V.startReview('all'); assert.equal(E.requests.length,1);
  assert.equal(V.reviewStatus().pauseRequested,true);
  E.requests[0].resolve(good); await task;
  assert.equal(V.reviewStatus().done,1); assert.equal(V.reviewStatus().running,false);
  assert.equal(JSON.parse(storage.get('lexiloop.reviewJob')).cursor,1);
  const next=V.startReview('all'); assert.equal(E.requests[1].entry.term,'word2');
  E.requests[1].resolve(good); await next; await tick();
  assert.equal(V.reviewStatus().done,3); assert.equal(V.reviewStatus().reviewed,2); assert.equal(V.reviewStatus().skipped,1);
  assert.equal(storage.has('lexiloop.reviewJob'),false); assert.ok(events.every(e=>e==='review'));
}));
test('model rejection, malformed result and write failure remain at same checkpoint until explicit retry succeeds',()=>fixture(async({S,V,E,db,storage,good})=>{
  S.state.cards=[{word_id:1,reps:1}];
  let task=V.startReview('all'); E.requests.at(-1).reject(Error('synthetic')); await task;
  assert.match(V.reviewStatus().lastError,/模型请求失败/); assert.equal(V.reviewStatus().done,0);
  task=V.startReview('all'); E.requests.at(-1).resolve({ok:false}); await task;
  assert.match(V.reviewStatus().lastError,/无法解析/);
  db.error=Error('synthetic write'); task=V.startReview('all'); E.requests.at(-1).resolve({...good,severity:'blocking'}); await task;
  assert.match(V.reviewStatus().lastError,/保存失败/); assert.equal(JSON.parse(storage.get('lexiloop.reviewJob')).cursor,0);
  assert.equal(V.reviewStatus().failed,3); assert.equal(V.reviewStatus().blocking,0);
  db.error=null; task=V.startReview('all'); E.requests.at(-1).resolve({...good,severity:'blocking'}); await task;
  assert.equal(V.reviewStatus().done,1); assert.equal(V.reviewStatus().blocking,1); assert.equal(V.reviewStatus().lastError,'');
}));
test('hung model times out and late completion cannot advance or write the timed-out word',()=>fixture(async({S,V,E,good,expire,tick,db})=>{
  S.state.cards=[{word_id:1,reps:1}];
  const task=V.startReview('all'); expire(); await task;
  assert.equal(E.requests[0].opts.signal.aborted,true); assert.match(V.reviewStatus().lastError,/2 分钟/);
  E.requests[0].resolve({...good,severity:'blocking'}); await tick();
  assert.equal(V.reviewStatus().done,0); assert.equal(db.writes,0); assert.equal(V.reviewStatus().running,false);
}));
test('legacy checkpoint is visible before restart and resumes without claiming historical successful counts',()=>fixture(async({V,E,good})=>{
  assert.equal(V.reviewStatus().done,2); assert.equal(V.reviewStatus().previousDone,2); assert.equal(V.reviewStatus().reviewed,0);
  const task=V.startReview('all'); assert.equal(E.requests[0].entry.term,'word3'); E.requests[0].resolve(good); await task;
  assert.equal(V.reviewStatus().done,3); assert.equal(V.reviewStatus().reviewed,1);
},{scope:'all',ids:[1,2,3],cursor:2,blocking:1,advisory:1}));
