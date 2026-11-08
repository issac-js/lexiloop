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
 const chat=async o=>{calls++;return JSON.stringify({reference:'valid',reference_reason:'',verdict:o.user.includes('yesterday')?'wrong':'alt'});};
 const neutral={...base,sentence:'She ________ him on his skills.'};const past={...base,sentence:'She ________ him yesterday.'};
 assert.equal((await J.reviewSemantics({...neutral,chat})).verdict,'alt');
 assert.equal(J.cachedVerdict(base.expected,base.given,past),null);
 assert.equal((await J.reviewSemantics({...past,chat})).verdict,'wrong');assert.equal(calls,2);
 assert.equal((await J.reviewSemantics({...neutral,chat})).cached,true);assert.equal(calls,2);
 await J.reviewSemantics({...neutral,model:'fixture-b',chat});await J.reviewSemantics({...neutral,zh:'另一含义',chat});assert.equal(calls,4);
}));
test('offline, malformed, explicit unsure and context-free semantic replies cannot become wrong or enter cache',()=>fixture(async J=>{
 const base={expected:'deal with',given:'address',sentence:'Please ________ the complaint.'};
 for(const chat of [async()=>{throw Error('offline')},async()=>'{"reference":"valid","reference_reason":"","verdict":"wrong"} ignore this',async()=>'{"reference":"valid","reference_reason":"","verdict":"unsure"}',async()=>'{}']){
  const r=await J.reviewSemantics({...base,chat});assert.equal(r.verdict,null);assert.equal(J.cachedVerdict(base.expected,base.given,base),null);
 }
 let called=false;assert.equal((await J.reviewSemantics({expected:'help',given:'assist',chat:async()=>{called=true;return '{"reference":"valid","reference_reason":"","verdict":"wrong"}'}})).verdict,null);assert.equal(called,false);
}));
test('old context-free v3 caches cannot bypass the current context',()=>fixture(J=>{global.localStorage.setItem('lexiloop.judgecache.v3',JSON.stringify({'complimented||compliments':{v:'alt',t:Date.now()}}));assert.equal(J.cachedVerdict('complimented','compliments',{sentence:'She ____ him yesterday.'}),null);}));
test('semantic timeout aborts the request and returns unresolved',()=>fixture(async J=>{const native=global.setTimeout;let aborted=false;
 try{global.setTimeout=(fn,ms,...args)=>native(fn,ms===J.SEMANTIC_TIMEOUT_MS?5:ms,...args);const r=await J.reviewSemantics({expected:'help',given:'assist',zh:'帮助',chat:opts=>new Promise(()=>opts.signal.addEventListener('abort',()=>{aborted=true}))});assert.equal(r.verdict,null);assert.equal(aborted,true);}
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
  let request;await J.reviewSemantics({...row,chat:async o=>{request=o;return '{"reference":"valid","reference_reason":"","verdict":"wrong"}'}});
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
 assert.equal((await J.reviewSemantics({...o,chat:async()=>'{"reference":"valid","reference_reason":"","verdict":"wrong"}'})).verdict,null);
 assert.equal(J.cachedVerdict(o.expected,o.given,o),null);
 assert.equal((await J.reviewSemantics({...o,chat:async()=>'{"reference":"valid","reference_reason":"","verdict":"alt"}'})).verdict,'alt');
}));


test('reviewed cloze alternatives work offline in their original sentences only',()=>fixture(J=>{
 const rows=[
  ['resolve','work through','She managed to ________ the technical problem.'],
  ['shut down','shutter','The owner was forced to ________ his business after the lease expired.'],
 ];
 for(const [given,expected,sentence] of rows){
  assert.equal(J.judgeTyped(given,expected,{sentence}).verdict,'alt');
  assert.equal(J.judgeTyped(given,expected).verdict,'unsure');
  assert.equal(J.judgeTyped(given,expected,{sentence,locked:true}).verdict,'unsure');
  assert.equal(J.judgeTyped('not '+given,expected,{sentence}).verdict,'unsure');
 }
}));


test('semantic response budget admits a slow fixture and records exact unresolved reasons',()=>fixture(async J=>{
 const o={expected:'handle',given:'address',sentence:'Please ________ the complaint.'};
 const native=global.setTimeout;
 try {
  global.setTimeout=(fn,ms,...args)=>native(fn,ms===J.SEMANTIC_TIMEOUT_MS?30:ms,...args);
  const reviewed=await J.reviewSemantics({...o,chat:async opts=>{
   assert.equal(opts.maxTokens,512);await new Promise(resolve=>native(resolve,15));return '{"reference":"valid","reference_reason":"","verdict":"alt"}';
  }});
  assert.equal(reviewed.verdict,'alt');assert.equal(reviewed.reason,'reviewed');
 } finally {global.setTimeout=native;}
 J.clearJudgeCache();
 for(const [chat,reason] of [
  [async()=>'', 'empty'], [async()=>'{"reference":"valid","reference_reason":"","verdict":"unsure"}', 'ambiguous'],
  [async()=>'{"reference":"valid","reference_reason":"","verdict":"hit"}', 'invalid'],[async()=>'{"reference":"valid","reference_reason":"","verdict":"alt"} trailing', 'invalid'],
  [async()=>{throw Object.assign(Error('synthetic-only'),{code:'LLM_TRUNCATED'})},'truncated'],
  [async()=>{throw Error('synthetic-only')},'unavailable'],
 ]) {
  const r=await J.reviewSemantics({...o,chat});assert.equal(r.reason,reason);assert.equal(r.verdict,null);
  assert.equal(J.cachedVerdict(o.expected,o.given,o),null);
 }
 assert.equal((await J.reviewSemantics({...o,sentence:'',chat:async()=>''})).reason,'context');
}));

test('structured feedback handles alternative-word inflection and survives contextual cache replay',()=>fixture(async J=>{
 const o={expected:'warrants',given:'deserve',sentence:'The new evidence ________ further investigation.',zh:'新证据值得进一步调查。'};
 const feedback={grammar:'incorrect',meaning:'fits',issue:'inflection',correction:'deserves',explanation:'evidence 作单数，当前一般现在时使用 deserves。'};
 const r=await J.reviewSemantics({...o,chat:async()=>JSON.stringify({reference:'valid',reference_reason:'',verdict:'wrong',...feedback})});
 assert.equal(r.verdict,'wrong');assert.deepEqual(r.feedback,feedback);
 assert.equal(J.coachingFeedback({...o,verdict:'wrong',feedback:r.feedback}).issue,'inflection');
 const cached=await J.reviewSemantics({...o,chat:async()=>{throw Error('must use cache')}});
 assert.equal(cached.cached,true);assert.deepEqual(cached.feedback,feedback);
 const renewed=await J.reviewSemantics({...o,force:true,chat:async()=>'{"reference":"valid","reference_reason":"","verdict":"unsure"}'});
 assert.equal(renewed.verdict,null);assert.equal(renewed.reason,'ambiguous');
 assert.equal(J.cachedVerdict(o.expected,o.given,o),null);
 // A forced unresolved result must not leave an old confident rejection behind.
}));
test('contradictory, unsafe or invented coaching is rejected and never cached',()=>fixture(async J=>{
 const o={expected:'warrants',given:'deserve',sentence:'The new evidence ________ further investigation.'};
 const valid={reference:'valid',reference_reason:'',verdict:'wrong',grammar:'incorrect',meaning:'fits',issue:'inflection',correction:'deserves',explanation:'主谓一致'};
 for(const change of [{reference:'valid',reference_reason:'',verdict:'alt'},{grammar:'correct'},{correction:'warrants'},{correction:'does not deserve'},
  {correction:'deserve something'},{explanation:''},{meaning:'unknown'},{issue:'nonsense'}]){
  const r=await J.reviewSemantics({...o,chat:async()=>JSON.stringify({...valid,...change})});
  assert.equal(r.verdict,null);assert.equal(r.reason,'invalid');assert.equal(J.cachedVerdict(o.expected,o.given,o),null);
 }
}));
test('grammar-correct meaning distinctions remain separate from acceptable alternatives',()=>fixture(async J=>{
 const o={expected:'refer',given:'introduce',sentence:'I can ________ you to the support team.'};
 const feedback={grammar:'correct',meaning:'different',issue:'meaning',correction:'',explanation:'introduce 是介绍认识；refer 强调转介求助。'};
 const r=await J.reviewSemantics({...o,chat:async()=>JSON.stringify({reference:'valid',reference_reason:'',verdict:'wrong',...feedback})});
 assert.equal(r.verdict,'wrong');assert.equal(r.feedback.grammar,'correct');
 assert.equal(J.parseCoaching({reference:'valid',reference_reason:'',verdict:'alt',...feedback},o),null);
}));


test('invalid or unverified references cannot reject users, be cached, or supply correction practice',()=>fixture(async J=>{
 const o={expected:'liver',given:'live',sentence:'The knight would ________ with his lord.'};
 for(const reference of ['invalid','unknown']){
  const r=await J.reviewSemantics({...o,chat:async()=>JSON.stringify({reference,reference_reason:'Reference requires lexical verification.',verdict:'wrong'})});
  assert.equal(r.verdict,null);assert.equal(r.reason,'reference_'+reference);assert.equal(J.cachedVerdict(o.expected,o.given,o),null);assert.equal(r.feedback,undefined);
 }
 const legacy=await J.reviewSemantics({...o,chat:async()=>JSON.stringify({verdict:'wrong'})});
 assert.equal(legacy.verdict,null);assert.equal(legacy.reason,'reference_unknown');
}));
test('reference validity is mandatory but does not by itself prove user correctness',()=>fixture(async J=>{
 const o={expected:'lives',given:'live',sentence:'She ________ here.'};
 const wrong=await J.reviewSemantics({...o,chat:async()=>JSON.stringify({reference:'valid',reference_reason:'',verdict:'wrong',grammar:'incorrect',meaning:'fits',issue:'inflection',correction:'lives',explanation:'She 是第三人称单数，这里需要 lives。'})});
 assert.equal(wrong.verdict,'wrong');assert.equal(wrong.feedback.correction,'lives');
}));

test('quantity-free meaning production accepts a reviewed countable singular with guidance',()=>fixture(J=>{
 const r=J.judgeTyped('hotel amenity','hotel amenities',{zh:'酒店设施'});
 assert.equal(r.verdict,'alt');assert.equal(r.target,false);assert.match(r.note,/没有限定/);
 for(const o of [{zh:'所有酒店设施'},{zh:'两项酒店设施'},{zh:'酒店设施',spelling:true},{zh:'酒店设施',locked:true},{zh:'酒店设施',sentence:'Several hotel ________ are available.'}])
  assert.notEqual(J.judgeTyped('hotel amenity','hotel amenities',o).verdict,'alt');
 for(const [g,e] of [['good','goods'],['custom','customs'],['new','news'],['glass','glasses'],['operation','operations']])
  assert.notEqual(J.judgeTyped(g,e,{zh:'设施'}).verdict,'alt');
}));
test('campus role-name number gets conventional-usage guidance only in the reviewed complete sentence',()=>fixture(J=>{
 const sentence='The ________ team coordinates maintenance and events across all buildings.';
 const r=J.judgeTyped('campus operation','campus operations',{sentence});assert.equal(r.verdict,'alt');assert.match(r.note,/惯用搭配/);
 assert.notEqual(J.judgeTyped('campus operation','campus operations',{sentence:'They planned one ________.'}).verdict,'alt');
 assert.notEqual(J.judgeTyped('campus operation','campus operations',{sentence,spelling:true}).verdict,'alt');
}));
test('unknown noun number without a quantity cannot become an unexplained model rejection',()=>fixture(async J=>{
 const r=await J.reviewSemantics({expected:'student requests',given:'student request',zh:'学生请求',chat:async()=>JSON.stringify({reference:'valid',reference_reason:'',verdict:'wrong'})});
 assert.equal(r.verdict,null);assert.equal(r.reason,'number_context');
}));
test('form review includes both independent user and reference sentences',()=>fixture(async J=>{
 let request;await J.reviewSemantics({given:'deserve',expected:'deserves',sentence:'This idea ________ attention.',chat:async x=>{request=x;return JSON.stringify({verdict:'unsure'})}});
 assert.match(request.user,/This idea deserve attention/);assert.match(request.user,/This idea deserves attention/);
}));
