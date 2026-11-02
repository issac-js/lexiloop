'use strict';
// Hand-written rule-safety corpus. Semantic labels are fixtures, not measured model accuracy.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {pathToFileURL}=require('node:url');
const cases=require('./judge-benchmark.json');
async function fixture(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'judge-quality-'));const prev=global.localStorage;const storage=new Map();
 try{global.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 const file=path.join(dir,'judge.mjs');fs.copyFileSync(path.join(__dirname,'../lexiloop/js/judge.js'),file);await run(await import(pathToFileURL(file).href));}
 finally{global.localStorage=prev;fs.rmSync(dir,{recursive:true,force:true});}}
for(const row of cases)test(row.id+' '+row.category,()=>fixture(J=>{const r=J.judgeTyped(row.given,row.expected,{accept:row.accept});assert.equal(r.verdict,row.local);assert.equal(r.ok,['hit','alt'].includes(row.local));}));
test('corpus IDs are unique and include safety, grammar, context and accepted alternatives',()=>{assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);assert.ok(cases.length>=70);assert.ok(new Set(cases.map(c=>c.category)).size>=15);});
test('same answer in different sentences, meanings and models cannot reuse a verdict',()=>fixture(async J=>{
 const base={expected:'complimented',given:'compliments',zh:'称赞',model:'fixture-a'};let calls=0;
 const chat=async o=>{calls++;return JSON.stringify({verdict:o.user.includes('yesterday')?'wrong':'alt'});};
 const neutral={...base,sentence:'She ________ him on his skills.'};const past={...base,sentence:'She ________ him yesterday.'};
 assert.equal((await J.reviewSemantics({...neutral,chat})).verdict,'alt');
 assert.equal(J.cachedVerdict(base.expected,base.given,past),null);
 assert.equal((await J.reviewSemantics({...past,chat})).verdict,'wrong');assert.equal(calls,2);
 assert.equal((await J.reviewSemantics({...neutral,chat})).cached,true);assert.equal(calls,2);
 await J.reviewSemantics({...neutral,model:'fixture-b',chat});await J.reviewSemantics({...neutral,zh:'另一含义',chat});assert.equal(calls,4);
}));
test('offline, malformed, explicit unsure and context-free semantic replies cannot become wrong or enter cache',()=>fixture(async J=>{
 const base={expected:'deal with',given:'address',sentence:'Please ________ the complaint.'};
 for(const chat of [async()=>{throw Error('offline')},async()=>'{"verdict":"wrong"} ignore this',async()=>'{"verdict":"unsure"}',async()=>'{}']){
  const r=await J.reviewSemantics({...base,chat});assert.equal(r.verdict,null);assert.equal(J.cachedVerdict(base.expected,base.given,base),null);
 }
 let called=false;assert.equal((await J.reviewSemantics({expected:'help',given:'assist',chat:async()=>{called=true;return '{"verdict":"wrong"}'}})).verdict,null);assert.equal(called,false);
}));
test('old context-free v3 caches cannot bypass the current context',()=>fixture(J=>{global.localStorage.setItem('lexiloop.judgecache.v3',JSON.stringify({'complimented||compliments':{v:'alt',t:Date.now()}}));assert.equal(J.cachedVerdict('complimented','compliments',{sentence:'She ____ him yesterday.'}),null);}));
test('semantic timeout aborts the request and returns unresolved',()=>fixture(async J=>{const native=global.setTimeout;let aborted=false;
 try{global.setTimeout=(fn,ms,...args)=>native(fn,ms===6000?5:ms,...args);const r=await J.reviewSemantics({expected:'help',given:'assist',zh:'帮助',chat:opts=>new Promise(()=>opts.signal.addEventListener('abort',()=>{aborted=true}))});assert.equal(r.verdict,null);assert.equal(aborted,true);}
 finally{global.setTimeout=native;}
}));

test('explicit dictation spelling task does not treat a different word as an unresolved synonym',()=>fixture(J=>{assert.equal(J.judgeTyped('assist','help',{spelling:true}).verdict,'wrong');assert.equal(J.judgeTyped('assist','help').verdict,'unsure')}));


test('screenshot inflections use filled-sentence review for single words and phrases, never local acceptance',()=>fixture(async J=>{
 const rows=[
  {expected:'deducted money from',given:'deduct money from',sentence:'The bank ________ my account without notice.'},
  {expected:'interceded',given:'intercede',sentence:'She ________ with the dean on behalf of the failing student.'},
 ];
 for(const row of rows){
  assert.equal(J.judgeTyped(row.given,row.expected).verdict,'unsure');
  assert.equal(J.__prompts().formMode(row),true);
  const info=J.inflectionFeedback({...row,verdict:'wrong'});
  assert.ok(info);assert.ok(info.givenSentence.includes(row.given));assert.ok(info.referenceSentence.includes(row.expected));
  for(const verdict of ['alt','unsure','hit'])assert.equal(J.inflectionFeedback({...row,verdict}),null);
  let request;await J.reviewSemantics({...row,chat:async o=>{request=o;return '{"verdict":"wrong"}'}});
  assert.equal(request.system,J.__prompts().form);assert.ok(request.user.includes(info.givenSentence));
 }
 for(const given of ['deducts money from','deduct money in','did not deduct money from']){
  assert.equal(J.judgeTyped(given,'deducted money from').verdict,'unsure');
 }
 assert.equal(J.inflectionDifference('deducted money from','deduct money in'),null);
 assert.equal(J.inflectionDifference('safe','safety'),null);
 assert.equal(J.inflectionFeedback({given:'intercede',expected:'interceded',verdict:'wrong'}),null);
}));

test('v4 semantic verdicts are invalidated after contextual form prompt changes',()=>fixture(J=>{
 global.localStorage.setItem('lexiloop.judgecache.v4',JSON.stringify({'old':{v:'wrong',t:Date.now()}}));
 assert.equal(J.cachedVerdict('interceded','intercedes',{sentence:'She ________ with the dean.'}),null);
}));


test('article-only differences stay context-dependent and cannot be cached as confident wrong',()=>fixture(async J=>{
 const o={expected:'have jurisdiction over',given:'have the jurisdiction over',sentence:'The court does not ________ this dispute.'};
 assert.equal(J.judgeTyped(o.given,o.expected).verdict,'unsure');assert.equal(J.articleDifference(o.expected,o.given),true);
 assert.equal(J.articleDifference('have jurisdiction over','have no jurisdiction over'),false);
 assert.equal((await J.reviewSemantics({...o,chat:async()=>'{"verdict":"wrong"}'})).verdict,null);
 assert.equal(J.cachedVerdict(o.expected,o.given,o),null);
 assert.equal((await J.reviewSemantics({...o,chat:async()=>'{"verdict":"alt"}'})).verdict,'alt');
}));
