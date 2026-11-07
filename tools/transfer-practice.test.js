'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
async function fixture(run){
 const previous=global.localStorage, storage=new Map();const nodes={};
 const state={user:{id:'transfer-fixture'}};
 global.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 global.__transferFixture={state,query:s=>nodes[s]||null};
 let src=fs.readFileSync(path.join(__dirname,'../lexiloop/js/transfer.js'),'utf8')
  .replace(/import \* as S from [^\n]+/, "const S={state:globalThis.__transferFixture.state,todayKey:()=> '2026-11-07'}")
  .replace(/import \{ \$, esc \} from [^\n]+/, 'const $=globalThis.__transferFixture.query;const esc=s=>String(s).replace(/</g,"&lt;")')
  .replace(/import \{ normalizeAns \} from [^\n]+/, "const normalizeAns=s=>String(s).toLowerCase().replace(/[^a-z '-]/g,' ').replace(/\\s+/g,' ').trim()");
 src+='\n// fixture '+Math.random();
 try{const T=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));await run(T,storage,state,nodes);}
 finally{global.localStorage=previous;delete global.__transferFixture;}
}
test('ten curated groups accept context-scoped alternatives and refuse to call other answers wrong',()=>fixture(T=>{
 assert.equal(T.GROUPS.length,10);assert.equal(new Set(T.GROUPS.map(g=>g.id)).size,10);
 for(const g of T.GROUPS){
  assert.match(g.sentence,/________/);assert.ok(g.structure.includes('→'));assert.ok(g.transfer&&g.reference&&g.source);
  assert.equal(T.checkTransfer(g,g.target),'hit');
  for(const alt of g.accept)assert.equal(T.checkTransfer(g,alt),'alt');
  assert.equal(T.checkTransfer(g,'not '+g.target),'unreviewed');assert.equal(T.checkTransfer(g,''),'empty');
 }
 const first=T.transferPlan('2026-11-07');assert.equal(first.length,3);assert.equal(new Set(first.map(g=>g.id)).size,3);
 const covered=new Set();for(let i=0;i<10;i++)T.transferPlan('2026-11-'+String(7+i).padStart(2,'0')).forEach(g=>covered.add(g.id));
 assert.equal(covered.size,10);assert.deepEqual(first,T.transferPlan('2026-11-07'));
}));
test('first attempt, revealed and hinted results stay distinct; finish saves aggregate metadata only',()=>fixture((T,storage,state,nodes)=>{
 T.startTransfer();
 const click=id=>{nodes[id].onclick();};
 for(const id of ['#transfer-home','#transfer-answer','#transfer-check','#transfer-hint','#transfer-reveal','#transfer-next'])nodes[id]={value:''};
 const cb=()=>{};T.bindTransfer(cb,cb);
 nodes['#transfer-answer'].value=T.transferPlan()[0].target;nodes['#transfer-answer'].oninput();click('#transfer-check');click('#transfer-next');click('#transfer-next'); // Stale duplicate click cannot skip the next exercise.
 T.bindTransfer(cb,cb);click('#transfer-hint');nodes['#transfer-answer'].value=T.transferPlan()[1].accept[0];nodes['#transfer-answer'].oninput();click('#transfer-check');click('#transfer-next');
 T.bindTransfer(cb,cb);click('#transfer-reveal');click('#transfer-next');
 const data=JSON.parse([...storage.values()][0]);assert.equal(data.length,1);assert.equal(data[0].results.length,3);
 assert.deepEqual(data[0].results.map(r=>r.hinted),[false,true,true]);
 assert.equal(data[0].results[2].verdict,'revealed');assert.ok(!JSON.stringify(data).includes('given'));
 assert.match(T.renderTransfer(),/独立写出已收录表达 1/);
 state.user={id:'other'};assert.match(T.renderTransfer(),/训练已结束/);
}));
test('pilot cannot call cloud model, review or settings persistence',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../lexiloop/js/transfer.js'),'utf8');
 assert.doesNotMatch(src,/S\.(?:recordReview|applyGrade|persistReview|pushSettings|persistCard)\s*\(/);
 assert.doesNotMatch(src,/CLOUD|chatText|fetch\s*\(/);
});
