'use strict';
/* LexiLoop · 登录后界面在移动端/iOS 上的适配质检
   为什么需要这个：线上未登录只能看到登录页，登录后的 6 个视图（今日/学习/练习场/
   词库/统计/我的）才是日常使用界面，但它们受云端 session 闸门保护，无法直接访问。

   做法：复制一份源码到临时目录，**只把 boot() 里的 session 取值换成一个假 session**
   （视图代码、样式表、渲染逻辑与线上**完全一致**，唯一区别是跳过了登录闸门）。
   数据同步会失败并走已有的 fail() 降级提示 —— 这不影响布局，正是我们要测的部分。

   用法：node tools/qa-ios-loggedin.js */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SRC = path.resolve(__dirname, '..', 'lexiloop');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8873;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEVICES = [
  { name: 'iPhone SE (375×667)', w: 375, h: 667, dpr: 2 },
  { name: 'iPhone 15 (393×852)', w: 393, h: 852, dpr: 3 },
  { name: 'iPhone 15 Pro Max (430×932)', w: 430, h: 932, dpr: 3 },
  { name: 'iPad mini (744×1133)', w: 744, h: 1133, dpr: 2 },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* 构建逻辑统一走 lib/authed-build.js。
   这里原本有一份自己的副本；app.js 新增 resync() 之后副本没跟上，
   自检的「防护未生效」立刻就响了 —— 两份实现必然漂移，所以只留一份。 */
const { buildAuthed } = require('./lib/authed-build.js');
const buildPatched = buildAuthed;

function serve(root) {
  const srv = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const fp = path.join(root, rel);
    if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise((r) => srv.listen(PORT, '127.0.0.1', () => r(srv)));
}

const VIEW_CHECKS = `(function(){
  const out=[];
  const T=(n,fn)=>{ let v; try{ v=fn(); }catch(e){ v='ERR '+e.message; }
    out.push({name:n, pass:v===true, detail:(v===true?'':String(v))}); };
  const vw=window.innerWidth, vh=window.innerHeight;

  T('视图有实际内容（未渲染空壳）', ()=>{
    const m=document.getElementById('main');
    if(!m) return 'no #main';
    return (m.textContent||'').trim().length>10? true : ('#main 文本长度='+(m.textContent||'').trim().length);
  });
  T('视图内无横向溢出', ()=>{
    const m=document.getElementById('main');
    if(!m) return 'no #main';
    const bad=[];
    m.querySelectorAll('*').forEach(el=>{
      const r=el.getBoundingClientRect();
      if(!r.width||!r.height) return;
      const cs=getComputedStyle(el);
      if(cs.position==='fixed'||cs.display==='none'||cs.visibility==='hidden') return;
      if(r.right<=vw+2) return;
      let p=el.parentElement, scrollable=false;
      while(p&&p!==document.body){ const pcs=getComputedStyle(p);
        if(pcs.overflowX==='auto'||pcs.overflowX==='scroll'){ scrollable=true; break; } p=p.parentElement; }
      if(scrollable) return;
      bad.push((el.id?('#'+el.id):(String(el.className)||el.tagName))+'@'+Math.round(r.right));
    });
    return bad.length? (bad.slice(0,4).join(' | ')+' （共'+bad.length+'个）') : true;
  });
  T('视图内输入控件字号 ≥16px', ()=>{
    const m=document.getElementById('main');
    if(!m) return 'no #main';
    const bad=[];
    m.querySelectorAll('input:not([type=hidden]):not([type=range]),select,textarea').forEach(el=>{
      const r=el.getBoundingClientRect(); if(!r.width||!r.height) return;
      const fs=parseFloat(getComputedStyle(el).fontSize);
      if(fs<16) bad.push((String(el.className)||el.tagName)+'='+fs);
    });
    return bad.length? (bad.slice(0,4).join(',')+' （共'+bad.length+'个）') : true;
  });
  T('视图内可点元素触控高度 ≥40px', ()=>{
    const m=document.getElementById('main');
    if(!m) return 'no #main';
    const bad=[]; let n=0;
    m.querySelectorAll('button, .btn, .choice, a').forEach(el=>{
      const r=el.getBoundingClientRect();
      if(!r.width||!r.height) return;
      n++; if(r.height<40) bad.push((String(el.className)||el.tagName)+'='+Math.round(r.height));
    });
    if(!n) return true;
    return bad.length? (bad.slice(0,4).join(',')+' （共'+bad.length+'/'+n+'个偏小）') : true;
  });
  /* ★ 无障碍：只有图标、没有可见文字的按钮必须有可访问名（aria-label / title /
     svg <title> / aria-labelledby）。屏幕阅读器（VoiceOver）读不出名字的按钮 = 死按钮。
     2026-10-14 补：此前套件只断言"热区够大"，从没系统查过"读不读得出来"。 */
  T('★ 无可见文字的按钮都有可访问名（VoiceOver 能读出来）', ()=>{
    const m=document.getElementById('main');
    if(!m) return 'no #main';
    const bad=[];
    m.querySelectorAll('button, a, [role=button]').forEach(el=>{
      const cs=getComputedStyle(el);
      if(cs.display==='none'||cs.visibility==='hidden') return;
      const txt=(el.textContent||'').trim();
      const aria=(el.getAttribute('aria-label')||'').trim();
      const title=(el.getAttribute('title')||'').trim();
      const byId=!!el.getAttribute('aria-labelledby');
      const svgTitle=!!el.querySelector('svg > title');
      if(!txt && !aria && !title && !byId && !svgTitle){
        bad.push('<'+el.tagName.toLowerCase()+(el.id?(' id='+el.id):'')+' class="'+(String(el.className)||'')+'">');
      }
    });
    return bad.length? (bad.slice(0,4).join(' | ')+' （共'+bad.length+'个）') : true;
  });
  T('底部固定导航栏未被内容遮挡', ()=>{
    const tb=document.querySelector('.tabbar');
    if(!tb) return 'no .tabbar';
    const r=tb.getBoundingClientRect();
    if(r.bottom>vh+2) return ('tabbar 底部超出视口 bottom='+Math.round(r.bottom)+' vh='+vh);
    return true;
  });
  return out;
})()`;

const SHELL_CHECKS = `(function(){
  const out=[];
  const T=(n,fn)=>{ let v; try{ v=fn(); }catch(e){ v='ERR '+e.message; }
    out.push({name:n, pass:v===true, detail:(v===true?'':String(v))}); };
  const vw=window.innerWidth;
  T('外壳：底部 tab 栏 6 项全部可见可点', ()=>{
    const bs=[...document.querySelectorAll('.tabbar button[data-tab]')];
    if(!bs.length) return '没有 tab 按钮';
    const bad=[];
    bs.forEach(b=>{
      const r=b.getBoundingClientRect();
      if(r.width<1||r.height<1) return bad.push((b.dataset.tab||'?')+'尺寸0');
      if(r.height<40) bad.push((b.dataset.tab||'?')+'高'+Math.round(r.height));
      if(r.right>vw+2||r.left<-2) bad.push((b.dataset.tab||'?')+'越界');
      const name=(b.textContent||'').trim()||b.getAttribute('aria-label')||'';
      if(!name) bad.push((b.dataset.tab||'?')+'无名称');
    });
    return bad.length? bad.join(', ') : true;
  });
  T('外壳：.main 顶部留出安全区', ()=>{
    const m=document.getElementById('main');
    if(!m) return 'no #main';
    const pt=parseFloat(getComputedStyle(m).paddingTop)||0;
    return pt>=12? true : ('padding-top='+pt+'px');
  });
  T('外壳：.main 底部为 tab 栏+安全区留空间', ()=>{
    const m=document.getElementById('main');
    if(!m) return 'no #main';
    const pb=parseFloat(getComputedStyle(m).paddingBottom)||0;
    return pb>=60? true : ('padding-bottom='+pb+'px');
  });
  T('外壳：页面级无横向溢出', ()=>{
    const sw=document.documentElement.scrollWidth;
    return sw<=vw+1? true : ('scrollWidth='+sw+' > '+vw);
  });
  return out;
})()`;

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.map = new Map(); this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        /* 数据同步失败是预期内的（无真实 session），不算异常 */
        const t = (d.exception && d.exception.description) || d.text || '';
        if (!/数据同步|fetch|Failed|401|403/.test(t)) this.events.push('EXCEPTION: ' + t);
      }
      if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); }
    };
  }
  static async connect(url, tries = 90) {
    for (let i = 0; i < tries; i++) {
      try {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
        return new CDP(ws);
      } catch (e) { await sleep(250); }
    }
    throw new Error('CDP 连接超时');
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res) => this.map.set(id, res));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function runDevice(dev, url) {
  const port = 9960 + Math.floor(Math.random() * 30);
  const udd = path.join(os.tmpdir(), 'gll-li-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--user-data-dir=' + udd, url],
    { windowsHide: true, stdio: 'ignore' });
  const res = { dev: dev.name, checks: [] };
  try {
    let pg = null;
    for (let i = 0; i < 90; i++) {
      await sleep(250);
      try {
        const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        if (pg) break;
      } catch (e) {}
    }
    if (!pg) throw new Error('无法连接调试页');
    const cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr, mobile: true,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sleep(800);
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(6000);
    for (let i = 0; i < 16; i++) {
      if ((await cdp.eval('!!document.querySelector(".tabbar")')) === true) break;
      await sleep(500);
    }

    const hasShell = (await cdp.eval('!!document.querySelector(".tabbar")')) === true;
    if (!hasShell) {
      res.checks.push({ name: '已进入登录后外壳', pass: false, detail: '未能绕过登录闸门，检查构建是否失效' });
      cdp.close();
      return res;
    }
    res.checks.push({ name: '已进入登录后外壳（tabbar 已渲染）', pass: true, detail: '' });

    const sh = await cdp.eval(SHELL_CHECKS);
    if (Array.isArray(sh)) res.checks.push(...sh);

    const tabs = await cdp.eval(`[...document.querySelectorAll('.tabbar button[data-tab]')].map(function(b){return b.dataset.tab})`);
    for (const t of (tabs || [])) {
      await cdp.eval(`(function(){ var b=document.querySelector('.tabbar button[data-tab=' + ${JSON.stringify(JSON.stringify(t))} + ']'); if(b) b.click(); })()`);
      await sleep(900);
      const vc = await cdp.eval(VIEW_CHECKS);
      if (Array.isArray(vc)) vc.forEach((c) => res.checks.push(Object.assign({}, c, { name: '［' + t + '］' + c.name })));
    }
    res.exceptions = [...new Set(cdp.events)];
    cdp.close();
  } catch (e) {
    res.error = e.message;
  } finally {
    try { proc.kill(); } catch (e) {}
  }
  return res;
}

(async () => {
  const dir = buildPatched();
  if (!dir) { console.log('构建失败'); process.exit(1); }
  const srv = await serve(dir);
  const url = 'http://127.0.0.1:' + PORT + '/';
  console.log('登录后布局质检（本地构建：仅绕过登录闸门，视图与样式与线上一致）');
  console.log('地址：' + url + '\n');

  let total = 0, failed = 0;
  try {
    for (const dev of DEVICES) {
      const r = await runDevice(dev, url);
      console.log('=== ' + r.dev + ' ===');
      if (r.error) { console.log('  运行失败: ' + r.error); failed++; continue; }
      r.checks.forEach((c) => {
        total++;
        if (!c.pass) failed++;
        console.log((c.pass ? '  PASS  ' : '  FAIL  ') + c.name + (c.pass ? '' : '  → ' + c.detail));
      });
      (r.exceptions || []).forEach((e) => { failed++; console.log('  FAIL  页面异常 → ' + e); });
      console.log('');
    }
  } finally {
    try { srv.close(); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('===== 登录后移动端质检: ' + (total - failed) + '/' + total + ' 通过' +
    (failed ? ('，' + failed + ' 项失败') : '，全部通过') + ' =====');
  process.exit(failed ? 1 : 0);
})();
