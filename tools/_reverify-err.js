'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const APP = path.resolve(__dirname, '..', 'lexiloop');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SITE = 'https://lexiloop-82703.app.workbuddy.host/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rd = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const files = ['index.html'].concat(fs.readdirSync(path.join(APP, 'js')).filter(f=>f.endsWith('.js')).map(f=>'js/'+f));
const vs = new Set(); files.forEach(f=>{for(const m of rd(f).matchAll(/\?v=(\d+)/g)) vs.add(m[1])});
const VER = [...vs][0];
const TERMS = fs.readFileSync(path.resolve(__dirname, '..', 'backup', 'err-terms.txt'), 'utf8').split('\n').map(s=>s.trim()).filter(Boolean);
class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.map=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&this.map.has(m.id)){this.map.get(m.id)(m);this.map.delete(m.id)}}}
  static async connect(u,t=100){for(let i=0;i<t;i++){try{const ws=new WebSocket(u);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=()=>j(0)});return new CDP(ws)}catch(e){await sleep(250)}}throw new Error('t')}
  send(m,p){const id=++this.id;this.ws.send(JSON.stringify({id,method:m,params:p||{}}));return new Promise((r)=>this.map.set(id,r))}
  async eval(e,t){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true,userGesture:true,timeout:t||180000});if(r.result&&r.result.exceptionDetails){const d=r.result.exceptionDetails;return{__err:(d.exception&&d.exception.description)||d.text}}return r.result&&r.result.result?r.result.result.value:undefined}
  close(){try{this.ws.close()}catch(e){}}
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'rv2-')); const port = 10033;
  const proc = spawn(EDGE, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--remote-debugging-port='+port,'--user-data-dir='+tmp,SITE],{windowsHide:true,stdio:'ignore'});
  let cdp=null; const out=[];
  try {
    let pg=null; for(let i=0;i<100;i++){await sleep(300);try{const l=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();pg=(l||[]).find(x=>x.type==='page');if(pg)break}catch(e){}}
    cdp = await CDP.connect(pg.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    for(let i=0;i<40;i++){await sleep(400);if((await cdp.eval('!!(window.WorkBuddyCloud)'))===true)break}
    const rows = await cdp.eval(`(async function(){
      const C = await import('./js/cloud.js?v=${VER}');
      const res = await C.db().from('words').select('normalized,lemma,payload').in('normalized', ${JSON.stringify(TERMS)});
      if (res.error) return { err: String(res.error.message||res.error) };
      return { data: (res.data||[]).map(w => ({ t: w.normalized, lem: w.lemma,
        s: w.payload.senses || [], c: (w.payload.collocations||[]).map(x=>({p:x.pattern,zh:x.zh,ex:((x.examples||[0]||{})[0]||{}).en||((x.examples||[])[0]||{}).en})) })) };
    })()`, 120000);
    if (!rows || rows.err) throw new Error('read fail');
    const queue = rows.data;
    console.log('复核 ' + queue.length + '/' + TERMS.length + ' 条');
    let i = 0;
    async function worker() {
      for (;;) {
        const k = i++; if (k >= queue.length) return;
        const e = queue[k];
        try {
          const r = await cdp.eval(`(async function(){ const E = await import('./js/enrich.js?v=${VER}');
            const res = await E.reviewTerm(${JSON.stringify({ term: e.lem || e.t, senses: e.s, collocations: e.c })}, {});
            return { ok: res.ok, sev: res.ok ? res.severity : 'ERR', issues: (res.issues||[]).slice(0,4),
              missing: (res.missing||[]).slice(0,4), reason: res.reason || '', raw: (res.raw||'').slice(0,50) }; })()`, 120000);
          const rec = { term: e.t, sev: (r && r.sev) || 'ERR', issues: (r && r.issues) || [],
            missing: (r && r.missing) || [], reason: (r && r.reason) || '', raw: (r && r.raw) || '' };
          out.push(rec);
          console.log('[' + (k+1) + '/' + queue.length + '] ' + rec.sev.toUpperCase() + ' ' + e.t +
            (rec.issues.length ? ' — ' + rec.issues[0].slice(0,80) : ''));
        } catch (ex) { out.push({ term: e.t, sev: 'EXC', issues: [], missing: [], reason: String(ex.message||ex).slice(0,80) }); }
      }
    }
    await Promise.all(Array.from({length:3},()=>worker()));
    fs.writeFileSync(path.resolve(__dirname,'..','backup','reverify-err.json'), JSON.stringify({ ran: new Date().toISOString(), results: out }, null, 1));
    const cnt = {}; out.forEach(x=>cnt[x.sev]=(cnt[x.sev]||0)+1);
    console.log('完成：' + JSON.stringify(cnt));
  } catch(e){ console.log('ERR', e.message); }
  finally { if(cdp)cdp.close(); try{proc.kill()}catch(e){} try{fs.rmSync(tmp,{recursive:true,force:true})}catch(e){} }
})();
