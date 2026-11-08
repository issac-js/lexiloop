'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {pathToFileURL}=require('node:url');
async function fixture(run,saved){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-quality-'));const names=['window','localStorage','fetch','setTimeout','clearTimeout'];
 const old=Object.fromEntries(names.map(n=>[n,globalThis[n]]));const storage=new Map(saved?[['lexiloop.reviewJob',JSON.stringify(saved)]]:[]);const timers=new Map();let timerId=-1,rows=[];
 try{
  fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');const src=path.join(__dirname,'../lexiloop/js');const v=fs.readFileSync(path.join(src,'store.js'),'utf8').match(/config\.js\?v=(\d+)/)[1];
  for(const n of fs.readdirSync(src))if(n.endsWith('.js'))fs.copyFileSync(path.join(src,n),path.join(dir,n));
  fs.writeFileSync(path.join(dir,'enrich.js'),'export const requests=[];export function reviewTerm(entry,opts){return new Promise((resolve,reject)=>requests.push({entry,opts,resolve,reject}))}');
  const db={error:null,writes:0,from(table){let patch,filters=[];return{update(row){patch=row;return this},eq(k,val){filters.push([k,val]);return this},async select(){db.writes++;if(db.error)return{error:db.error};const matches=rows.filter(w=>filters.every(([k,v])=>w[k]===v));for(const w of matches)Object.assign(w,JSON.parse(JSON.stringify(patch)));return{data:matches.map(w=>JSON.parse(JSON.stringify(w))),error:null}}}}};
  globalThis.window={addEventListener(){},WorkBuddyCloud:{createWorkBuddyCloud:()=>({database:db})}};
  globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,x)=>storage.set(k,x),removeItem:k=>storage.delete(k)};
  globalThis.fetch=()=>{throw Error('Network forbidden')};
  globalThis.setTimeout=(fn,ms,...args)=>{if(ms===120000){const id=timerId--;timers.set(id,fn);return id}return old.setTimeout(fn,ms,...args)};
  globalThis.clearTimeout=id=>{if(timers.has(id))timers.delete(id);else old.clearTimeout(id)};
  const load=n=>import(pathToFileURL(path.join(dir,n)).href+'?v='+v);const[S,V,E,C]=await Promise.all(['store.js','views.js','enrich.js','content-review.js'].map(load));
  S.state.words=[1,2,3].map(id=>({id,normalized:'word'+id,lemma:'word'+id,updated_at:'2026-10-01T00:00:00.000Z',payload:{senses:[{pos:'verb',def_zh:'测试词'}],collocations:[{pattern:'word'+id,zh:'测试',examples:[{en:'Please use word'+id+'.',zh:'测试'}]}]}}));
  rows=JSON.parse(JSON.stringify(S.state.words));S.state.cards=[1,1,2,3].map((word_id,id)=>({id,word_id,reps:1}));
  const good={ok:true,severity:'none',issues:[],missing:[],suggestions:[],reason:'No issues found in synthetic fixture'};
  const tick=()=>new Promise(r=>old.setTimeout(r,5));const until=async fn=>{for(let i=0;i<100&&!fn();i++)await tick();assert.ok(fn(),'Timed out waiting for fixture event')};
  const key=()=> 'lexiloop.reviewJob.'+encodeURIComponent(S.state.user?.id||S.state.accountEmail||'offline');
  await run({S,V,E,C,db,storage,good,tick,until,key,rows,expire:()=>{for(const fn of [...timers.values()])fn()}});
 }finally{await new Promise(r=>old.setTimeout(r,270));Object.assign(globalThis,old);fs.rmSync(dir,{recursive:true,force:true})}
}
test('two workers pause safely; unique words, model reports and protected corrections are preserved',()=>fixture(async({S,V,E,good,until,storage,key,C})=>{
 S.state.words[2].verification_status='corrected';const payloads=JSON.stringify(S.state.words.map(w=>w.payload)),cards=JSON.stringify(S.state.cards);
 const task=V.startReview('all');await until(()=>E.requests.length===2);assert.equal(V.reviewStatus().total,3);V.pauseReview();await V.startReview('all');assert.equal(E.requests.length,2);
 E.requests.find(r=>r.entry.term==='word2').resolve(good);await until(()=>V.reviewStatus().done===1);assert.equal(JSON.parse(storage.get(key())).cursor,0);
 E.requests.find(r=>r.entry.term==='word1').resolve(good);await task;assert.equal(V.reviewStatus().done,2);assert.equal(V.reviewStatus().running,false);assert.match(V.renderMe(),/2 \/ 3 个词条/);assert.doesNotMatch(V.renderMe(),/NaN 分钟|undefined 个词条/);
 await V.startReview('all');assert.equal(V.reviewStatus().done,3);assert.equal(V.reviewStatus().protected,1);assert.equal(V.reviewStatus().reviewed,2);
 assert.equal(JSON.stringify(S.state.words.map(w=>w.payload)),payloads);assert.equal(JSON.stringify(S.state.cards),cards);
 assert.equal(C.parseReviewReport(S.state.words[0].verify_note).severity,'none');
 await V.startReview('all');assert.equal(E.requests.length,2);assert.equal(V.reviewStatus().cached,2);
}));
test('out-of-order successes survive failure and reload without being requested twice',()=>fixture(async({V,E,good,until,storage,key})=>{
 let task=V.startReview('all');await until(()=>E.requests.length===2);V.pauseReview();E.requests.find(r=>r.entry.term==='word2').resolve(good);await until(()=>V.reviewStatus().done===1);E.requests.find(r=>r.entry.term==='word1').reject(Error('offline'));await task;
 const saved=JSON.parse(storage.get(key()));assert.equal(saved.cursor,0);assert.deepEqual(saved.completed,[2]);assert.equal(saved.done,1);
 task=V.startReview('all');await until(()=>E.requests.length===4);assert.deepEqual(E.requests.slice(2).map(r=>r.entry.term).sort(),['word1','word3']);E.requests.slice(2).forEach(r=>r.resolve(good));await task;
 assert.equal(V.reviewStatus().done,3);assert.equal(V.reviewStatus().failed,1);
}));
test('malformed results and failed writes never count as completed',()=>fixture(async({S,V,E,good,until,db,storage,key})=>{
 S.state.cards=[{word_id:1,reps:1}];let task=V.startReview('all');await until(()=>E.requests.length===1);E.requests.at(-1).resolve({ok:false});await task;assert.equal(V.reviewStatus().done,0);
 db.error=Error('write rejected');task=V.startReview('all');await until(()=>E.requests.length===2);E.requests.at(-1).resolve({...good,severity:'blocking'});await task;
 assert.match(V.reviewStatus().lastError,/保存失败/);assert.equal(JSON.parse(storage.get(key())).done,0);assert.equal(V.reviewStatus().blocking,0);
 db.error=null;task=V.startReview('all');await until(()=>E.requests.length===3);E.requests.at(-1).resolve({...good,severity:'blocking',issues:['wrong POS'],suggestions:['Check the noun sense']});await task;
 assert.equal(V.reviewStatus().done,1);assert.equal(V.reviewStatus().blocking,1);assert.match(V.reviewReportHTML(S.state.words[0]),/Check the noun sense/);
}));
test('timeouts abort requests and late model replies cannot write or advance progress',()=>fixture(async({S,V,E,good,until,expire,tick,db})=>{
 S.state.cards=[{word_id:1,reps:1}];const task=V.startReview('all');await until(()=>E.requests.length===1);expire();await task;
 assert.ok(E.requests[0].opts.signal.aborted);assert.match(V.reviewStatus().lastError,/2 分钟/);E.requests[0].resolve({...good,severity:'blocking'});await tick();assert.equal(db.writes,0);assert.equal(V.reviewStatus().done,0);
}));
test('legacy cursor migrates to account scope without inventing successful review counts',()=>fixture(async({V,E,good,until,storage,key})=>{
 assert.equal(V.reviewStatus().done,2);assert.equal(V.reviewStatus().previousDone,2);const task=V.startReview('all');await until(()=>E.requests.length===1);assert.equal(E.requests[0].entry.term,'word3');E.requests[0].resolve(good);await task;
 assert.equal(V.reviewStatus().reviewed,1);assert.ok(storage.has(key()));assert.equal(storage.has('lexiloop.reviewJob'),false);
},{scope:'all',ids:[1,2,3],cursor:2,blocking:1,advisory:1}));
test('content changes invalidate the report; user corrections arriving during review are protected',()=>fixture(async({S,V,E,good,until})=>{
 S.state.cards=[{word_id:1,reps:1}];let task=V.startReview('all');await until(()=>E.requests.length===1);E.requests[0].resolve(good);await task;
 S.state.words[0].payload.senses[0].def_zh='changed';task=V.startReview('all');await until(()=>E.requests.length===2);S.state.words[0].verification_status='corrected';E.requests[1].resolve({...good,severity:'blocking'});await task;
 assert.equal(S.state.words[0].verification_status,'corrected');assert.equal(V.reviewStatus().protected,1);
}));
test('rate limiting reduces concurrency and stops fresh requests while in-flight work settles',()=>fixture(async({V,E,good,until})=>{
 const task=V.startReview('all');await until(()=>E.requests.length===2);E.requests[0].reject(Object.assign(Error('rate limit'),{status:429}));await until(()=>V.reviewStatus().failed===1);E.requests[1].resolve(good);await task;
 assert.equal(V.reviewStatus().concurrency,1);assert.equal(E.requests.length,2);assert.match(V.reviewStatus().lastError,/限流/);
}));
test('empty content is checked locally and reports are rendered as escaped text',()=>fixture(async({S,V,E})=>{
 S.state.cards=[{word_id:1,reps:1}];S.state.words[0].payload={};await V.startReview('all');assert.equal(E.requests.length,0);assert.equal(V.reviewStatus().rules,1);
 assert.equal(S.state.words[0].verification_status,'flagged');assert.match(V.reviewReportHTML({verify_note:'<script>bad</script>'}),/&lt;script&gt;/);
}));
test('correction saves a before-version and source, preserves all cards, and rejects a stale overwrite',()=>fixture(async({S,rows})=>{
 const before=JSON.parse(JSON.stringify(S.state.words[0])),cards=JSON.stringify(S.state.cards);const payload=JSON.parse(JSON.stringify(before.payload));payload.senses[0].def_zh='核实后的释义';
 const saved=await S.correctWord(before,payload,'Original source fixture');assert.equal(saved.verification_status,'corrected');assert.equal(saved.payload.correction_history[0].payload.senses[0].def_zh,'测试词');assert.equal(JSON.stringify(S.state.cards),cards);
 await assert.rejects(S.correctWord(before,payload,'Other source'),/已被更新/);assert.equal(rows[0].payload.senses[0].def_zh,'核实后的释义');
}));
test('account switch prevents an in-flight result from writing to the next account',()=>fixture(async({S,V,E,good,until,db,storage})=>{
 S.state.cards=[{word_id:1,reps:1}];const task=V.startReview('all');await until(()=>E.requests.length===1);S.state.user={id:'other-account'};E.requests[0].resolve(good);await task;
 assert.equal(db.writes,0);assert.equal(storage.has('lexiloop.reviewJob.other-account'),false);
}));

test('new model review can replace a previous quarantine without treating its own report as a local rule',()=>fixture(async({S,V,E,good,until,C})=>{
 S.state.cards=[{word_id:1,reps:1}];const w=S.state.words[0];
 const fingerprint=await C.contentFingerprint(w);
 const report=C.makeReport(w,fingerprint,'auto',{severity:'advisory',issues:['Bad example'],quarantinedCollocations:[0]},[]);
 w.verification_status='reviewed';w.verify_note=JSON.stringify(report);
 assert.equal(C.auditEntry(w).length,0);
 report.at=0;w.verify_note=JSON.stringify(report);
 const task=V.startReview('all');await until(()=>E.requests.length===1);E.requests[0].resolve(good);await task;
 assert.deepEqual(C.parseReviewReport(S.state.words[0].verify_note).quarantinedCollocations,[]);
}));
