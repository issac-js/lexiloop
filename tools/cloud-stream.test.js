'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function fixture(run) {
  const previous = { window:global.window,localStorage:global.localStorage,fetch:global.fetch };
  const storage = new Map(); let chunks = [];
  global.localStorage = {getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  global.window = {WorkBuddyCloud:{createWorkBuddyCloud:()=>({llm:{models:{list:async()=>[{id:'deepseek-v4.1-flash'}]},chat:{completions:{create:async function*(){ for(const x of chunks)yield x; }}}}})}};
  let src = fs.readFileSync(path.join(__dirname,'../lexiloop/js/cloud.js'),'utf8').replace(/import \{ CLOUD_CONFIG \} from [^\n]+/, 'const CLOUD_CONFIG = {}');
  src += '\n// fixture '+ Math.random();
  try { const C=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64')); await run(C, xs=>{chunks=xs;}); }
  finally {Object.assign(global,previous);}
}
test('cloud completion detects truncation even when partial JSON appears valid',()=>fixture(async(C,set)=>{
  set([{choices:[{delta:{content:'{"verdict":"alt"}'},finish_reason:'length'}]}]);
  await assert.rejects(C.chatText({system:'test',user:'test'}),e=>e.code==='LLM_TRUNCATED');
  set([{choices:[{delta:{reasoning_content:'reasoning only'}}]},{choices:[{delta:{content:'OK'},finish_reason:'stop'}]}]);
  assert.equal(await C.chatText({system:'test',user:'test'}),'OK');
}));
test('aborted review cannot start completion after model resolution',()=>fixture(async(C,set)=>{
  set([{choices:[{delta:{content:'OK'}}]}]);const controller=new AbortController();controller.abort();
  await assert.rejects(C.chatText({system:'test',user:'test',signal:controller.signal}),/取消/);
}));
test('custom stream preserves split UTF-8 and an unterminated final SSE frame; length finish fails',()=>fixture(async C=>{
  C.setCustomApi({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic-only',model:'test'});
  const payload='data: '+JSON.stringify({choices:[{delta:{content:'核对'}}]})+'\r\n'+'data: '+JSON.stringify({choices:[{delta:{content:'成功'},finish_reason:'stop'}]});
  let bytes=new TextEncoder().encode(payload);
  global.fetch=async()=>({ok:true,body:new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}})});
  assert.equal(await C.chatText({system:'test',user:'test'}),'核对成功');
  bytes=new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'{"verdict":"wrong"}'},finish_reason:'length'}]}));
  await assert.rejects(C.chatText({system:'test',user:'test'}),e=>e.code==='LLM_TRUNCATED');
}));
