'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../lexiloop/js/content-quality.js'),'utf8');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const good={pos:'noun',def_zh:'肝脏'};
const bad={pos:'verb',def_zh:'居住（古体或方言形式）'};
const noun={pattern:'liver function',examples:[{en:'This blood test checks your liver function.'}]};
const fiction={pattern:'liver with someone',examples:[{en:'The knight would liver with his lord.'}]};
const word=(senses=[bad],collocations=[fiction])=>({id:1,normalized:'liver',lemma:'liver',payload:{senses,collocations}});
test('reported liver verb is removed before question creation, independent of verified/corrected labels',async()=>{
 const Q=await modulePromise;for(const verification_status of [null,'verified','reviewed','corrected']){
  const w={...word(),verification_status},before=JSON.stringify(w),r=Q.assessContent(w);
  assert.equal(r.blocked,true);assert.deepEqual(r.payload.collocations,[]);assert.equal(JSON.stringify(w),before);
 }
});
test('valid liver noun survives alongside false verb and examples',async()=>{
 const Q=await modulePromise,r=Q.assessContent(word([good,bad],[fiction,noun]));
 assert.equal(r.blocked,false);assert.deepEqual(r.payload.senses,[good]);assert.deepEqual(r.payload.collocations,[noun]);
});
test('ordinary old-text context and lawful modern conversion are not a rare-usage blacklist',async()=>{
 const Q=await modulePromise;
 for(const normalized of ['live','email','bottle','vinegar']){
  const w={normalized,payload:{senses:[{pos:'noun',def_zh:'普通名词'},{pos:'verb',def_zh:'普通动词'}],collocations:[{pattern:normalized+' something',examples:[{en:'In old texts they would '+normalized+' something.'}]}]}};
  assert.equal(Q.assessContent(w).issues.length,0);
 }
});
test('rare usage is isolated for modern practice without declaring historical usage false',async()=>{
 const Q=await modulePromise,w={normalized:'thou',payload:{senses:[{pos:'pronoun',def_zh:'你（古语）'}],collocations:[{pattern:'thou art'}]}};
 const r=Q.assessContent(w);assert.equal(r.blocked,true);assert.match(r.issues[0],/暂不用于现代英语练习/);
});
test('a questionable confusion-box historical claim cannot be shown as an instructional fact',async()=>{
 const Q=await modulePromise,w=word([good],[noun]);w.payload.confusables=[{word:'live',note:'liver 是其古体形式。'}];
 assert.deepEqual(Q.learningWord(w).payload.confusables,[]);assert.equal(Q.assessContent(w).blocked,false);
});
test('model review isolates only indexed collocations, tied to exact content snapshot',async()=>{
 const Q=await modulePromise,w=word([good],[noun,{pattern:'bad material'}]);
 w.verify_note=JSON.stringify({kind:'lexiloop-content-report',version:Q.REPORT_VERSION,contentKey:Q.contentKey(w),quarantinedCollocations:[1,-1,9,'0']});
 assert.deepEqual(Q.assessContent(w).payload.collocations,[noun]);
 w.payload.collocations[1].pattern='updated material';assert.equal(Q.assessContent(w).payload.collocations.length,2);
});
test('malformed and unrelated review reports cannot quarantine content',async()=>{
 const Q=await modulePromise;for(const verify_note of ['{','null',JSON.stringify({version:Q.REPORT_VERSION,quarantinedCollocations:[0]})]){
  assert.equal(Q.assessContent({...word([good],[noun]),verify_note}).payload.collocations.length,1);
 }
});
test('known repair is a sourced draft, keeps original object and unrelated metadata unchanged',async()=>{
 const Q=await modulePromise,w=word();w.payload.topic='medical';const before=JSON.stringify(w),draft=Q.repairDraft(w);
 assert.match(draft.source,/oxfordlearnersdictionaries/);assert.equal(draft.payload.topic,'medical');assert.equal(JSON.stringify(w),before);
 assert.equal(Q.assessContent({...w,payload:draft.payload}).issues.length,0);assert.equal(draft.payload.senses[0].pos,'noun');
 assert.equal(Q.repairDraft({normalized:'other',payload:w.payload}),null);
});

test('ordinary meanings mentioning archaic, obsolete or dialect are not usage labels',async()=>{
 const Q=await modulePromise;
 for(const [normalized,def_en,def_zh] of [['archaic','very old or old-fashioned','古老的；过时的'],['dialect','a regional dialect or language variety','方言'],['obsolete','dated or no longer in use','废弃的；过时的']]){
  const r=Q.assessContent({normalized,payload:{senses:[{pos:'noun',def_en,def_zh}],collocations:[{pattern:'ordinary '+normalized,zh:def_zh}]}});
  assert.equal(r.blocked,false);assert.equal(r.issues.length,0,normalized);
 }
});

test('liver food phrases, prepositional nouns and noun-subject questions remain learnable',async()=>{
 const Q=await modulePromise;
 for(const c of [
  {pattern:'liver with onions',examples:[{en:'We cooked liver with onions for dinner.'}]},
  {pattern:'damage to liver cells',examples:[{en:'The infection causes damage to liver cells.'}]},
  {pattern:'liver function',examples:[{en:'Can liver function improve after treatment?'}]},
 ]) assert.equal(Q.assessContent(word([good],[c])).issues.length,0,c.pattern);
});


test('actual corrected-noun record cannot retain any of four invented verb collocations',async()=>{
 const Q=await modulePromise;
 const collocations=[
  ['liver (up) with (someone)','与…同住','In old texts, the knight would liver with his lord in the castle.'],
  ['liver in (a place)','居住在…','They did liver in the countryside for many years.'],
  ['liver upon (something)','靠…为生','The hermits would liver upon berries and roots.'],
  ['liver by (doing something)','靠…过活','He used to liver by fishing in the river.'],
 ].map(([pattern,zh,en])=>({pattern,zh,type:'verb+prep',examples:[{en}]}));
 const w={...word([good],collocations),verification_status:'corrected'};
 const r=Q.assessContent(w);assert.equal(r.blocked,false);assert.deepEqual(r.badCollocations,[0,1,2,3]);assert.deepEqual(r.payload.collocations,[]);assert.deepEqual(r.payload.senses,[good]);
});

test('false liver verb claims and live-family forms are removed even after noun examples were repaired',async()=>{
 const Q=await modulePromise,w=word([good],[noun]);w.payload.confusables=[{word:'live',note:'liver 为其古体或方言形式。'},{word:'liver (noun)',note:'作名词指肝脏，与动词 liver 拼写相同。'}];w.payload.word_family=['lives','living','lived'];
 const clean=Q.learningWord(w);assert.deepEqual(clean.payload.confusables,[]);assert.deepEqual(clean.payload.word_family,[]);
 const draft=Q.repairDraft(w);assert.deepEqual(draft.payload.collocations,[noun]);assert.equal(draft.payload.confusables.length,1);
});
