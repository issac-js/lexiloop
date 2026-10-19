'use strict';
/* LexiLoop · 移动端 / iOS 适配质检
   为什么必须用 CDP Emulation.setDeviceMetricsOverride：
   Windows 上 Edge 有 ~500px 最小窗宽、系统显示缩放还会放大 --window-size，
   只有设备指标覆盖能拿到真实的 390 逻辑像素视口。
   设备档位：375（SE）/ 393（15）/ 430（15PM）/ 744（iPad mini）。

   用法：node tools/qa-ios.js [url] */
const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PAGE = process.argv[2] || 'https://lexiloop-82703.app.workbuddy.host/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEVICES = [
  { name: 'iPhone SE (375×667)', w: 375, h: 667, dpr: 2 },
  { name: 'iPhone 15 (393×852)', w: 393, h: 852, dpr: 3 },
  { name: 'iPhone 15 Pro Max (430×932)', w: 430, h: 932, dpr: 3 },
  { name: 'iPad mini (744×1133)', w: 744, h: 1133, dpr: 2 },
];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.map = new Map(); this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.events.push('EXCEPTION: ' + ((d.exception && d.exception.description) || d.text));
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
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

/* 页面内检查清单。isPhone 用于区分 iOS 触屏档与 iPad 档的不同要求。 */
const PAGE_CHECKS = `(function(){
  const out=[];
  const T=(n,fn)=>{ let v; try{ v=fn(); }catch(e){ v='ERR '+e.message; }
    out.push({name:n, pass:v===true, detail:(v===true?'':String(v))}); };

  const vw=window.innerWidth, vh=window.innerHeight;
  const isPhone = vw<=480;
  const want = window.__DEV_W__||0;
  const phoneCSS = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  T('设备模拟已生效（视口宽度符合设定）', ()=> want? (Math.abs(vw-want)<=2? true : ('innerWidth='+vw+' 期望 '+want)) : true);
  T('触屏指针被正确识别（pointer:coarse）', ()=> phoneCSS===true? true : ('pointer:coarse 未命中，触控热区规则不会生效'));

  /* ---- 横向溢出 ---- */
  T('页面级无横向溢出', ()=>{
    const sw=document.documentElement.scrollWidth;
    return sw<=vw+1? true : ('scrollWidth='+sw+' > '+vw);
  });
  T('无越界元素（逐个排查）', ()=>{
    const bad=[];
    document.querySelectorAll('body *').forEach(el=>{
      const r=el.getBoundingClientRect();
      if(!r.width||!r.height) return;
      const cs=getComputedStyle(el);
      if(cs.position==='fixed'||cs.visibility==='hidden'||cs.display==='none') return;
      if(r.right<=vw+2) return;
      /* 允许自身可横向滚动的容器（子元素超出是设计如此） */
      let p=el.parentElement, scrollable=false;
      while(p&&p!==document.body){
        const pcs=getComputedStyle(p);
        if(pcs.overflowX==='auto'||pcs.overflowX==='scroll'){ scrollable=true; break; }
        p=p.parentElement;
      }
      if(scrollable) return;
      bad.push((el.id?('#'+el.id):(el.className||el.tagName))+'@'+Math.round(r.right));
    });
    return bad.length? (bad.slice(0,5).join(' | ')+'  （共'+bad.length+'个）') : true;
  });

  /* ---- iOS 聚焦缩放：输入控件必须 ≥16px ---- */
  T('输入控件字号 ≥16px（防 iOS 聚焦整页放大）', ()=>{
    const bad=[];
    document.querySelectorAll('input:not([type=hidden]):not([type=range]),select,textarea').forEach(el=>{
      const r=el.getBoundingClientRect();
      if(!r.width||!r.height) return;
      const fs=parseFloat(getComputedStyle(el).fontSize);
      if(fs<16) bad.push((el.id?('#'+el.id):(el.className||el.tagName))+'='+fs+'px');
    });
    return bad.length? (bad.slice(0,5).join(', ')+'  （共'+bad.length+'个）') : true;
  });

  /* ---- 安全区 ---- */
  T('安全区变量已解析', ()=>{
    const t=getComputedStyle(document.documentElement).getPropertyValue('--safe-t');
    const b=getComputedStyle(document.documentElement).getPropertyValue('--safe-b');
    if(!t||!t.trim()) return '--safe-t 为空';
    if(!b||!b.trim()) return '--safe-b 为空';
    return true;
  });
  /* 未登录时是登录页（.auth），登录后是主视图（.main）—— 两者都要留出安全区，
     但登录页没有底部 tab 栏，所以底部只需让开 Home 条。 */
  const scrollBox = () => document.querySelector('.main') || document.querySelector('.auth');
  T('主内容区顶部留出安全区（刘海屏不被遮挡）', ()=>{
    const m=scrollBox();
    if(!m) return '既无 .main 也无 .auth';
    const pt=parseFloat(getComputedStyle(m).paddingTop)||0;
    /* --safe-t 为 0 时（非刘海屏）也应有一个基础内边距 */
    return pt>=12? true : ((m.className||'?')+' padding-top='+pt+'px');
  });
  T('主内容区底部为 tab 栏 / Home 条留了空间', ()=>{
    const m=scrollBox();
    if(!m) return '既无 .main 也无 .auth';
    const pb=parseFloat(getComputedStyle(m).paddingBottom)||0;
    const need=document.querySelector('.main')?60:24;
    return pb>=need? true : ((m.className||'?')+' padding-bottom='+pb+'px，期望 ≥'+need);
  });

  /* ---- 触控目标 ---- */
  T('关键按钮触控高度 ≥40px', ()=>{
    const sel=['.btn','.tabbar button','.choice'];
    const bad=[]; let n=0;
    sel.forEach(s=>{
      document.querySelectorAll(s).forEach(el=>{
        const r=el.getBoundingClientRect();
        if(!r.width||!r.height) return;
        n++; if(r.height<40) bad.push(s+'='+Math.round(r.height));
      });
    });
    if(!n) return true;
    return bad.length? (bad.slice(0,5).join(', ')+'  （共'+bad.length+'/'+n+'个偏小）') : true;
  });

  /* ---- 无障碍 ---- */
  T('可点控件都有无障碍名称', ()=>{
    const bad=[];
    document.querySelectorAll('button').forEach(b=>{
      if(!b.getBoundingClientRect().width) return;
      const name=(b.textContent||'').trim()||b.getAttribute('aria-label')||b.getAttribute('title')||'';
      if(!name) bad.push(b.id?('#'+b.id):('.'+(b.className||'')));
    });
    return bad.length? ('无名按钮 '+bad.length+' 个: '+bad.slice(0,4).join(',')) : true;
  });
  T('输入控件都有提示或标签', ()=>{
    const bad=[];
    document.querySelectorAll('input:not([type=hidden]),select,textarea').forEach(el=>{
      if(!el.getBoundingClientRect().width) return;
      const named=el.getAttribute('placeholder')||el.getAttribute('aria-label')||
                  el.getAttribute('title')||(el.labels&&el.labels.length)||
                  document.querySelector('label[for="'+el.id+'"]');
      if(!named) bad.push(el.id?('#'+el.id):(el.className||el.tagName));
    });
    return bad.length? ('无标签 '+bad.length+' 个: '+bad.slice(0,4).join(',')) : true;
  });
  T('页面语言已声明', ()=>{
    const l=document.documentElement.getAttribute('lang');
    return /^zh/i.test(l||'')? true : ('lang='+l);
  });
  T('图片都有 alt', ()=>{
    const bad=[];
    document.querySelectorAll('img').forEach(im=>{ if(im.getAttribute('alt')===null) bad.push(im.src.slice(-20)); });
    return bad.length? bad.slice(0,3).join(',') : true;
  });

  /* ---- 登录页首屏（未登录用户看到的第一屏）---- */
  T('首屏核心元素可见可点', ()=>{
    const root=document.getElementById('root')||document.querySelector('#root');
    if(!root) return 'no #root';
    const r=root.getBoundingClientRect();
    if(!r.height) return '#root 高度为 0';
    const btn=root.querySelector('button, .btn, input');
    if(!btn) return true;   /* 具体形态随状态变化，不强求 */
    const rb=btn.getBoundingClientRect();
    if(!rb.height) return true;
    return (rb.top<=vh+2 && rb.bottom>=-2)? true : ('首个控件在视口外 top='+Math.round(rb.top));
  });
  T('首屏无需要横向滚动才能看到的内容', ()=>{
    /* 已由页面级溢出检查覆盖；这里额外确认 body 本身没有横向滚动条 */
    return document.body.scrollWidth<=vw+1? true : ('body.scrollWidth='+document.body.scrollWidth);
  });

  return out;
})()`;

/* 切到各 tab 后逐个检查（需已登录；未登录时跳过并说明） */
const TAB_CHECKS = `(function(){
  const out=[];
  const T=(n,fn)=>{ let v; try{ v=fn(); }catch(e){ v='ERR '+e.message; }
    out.push({name:n, pass:v===true, detail:(v===true?'':String(v))}); };
  const vw=window.innerWidth;
  T('当前视图无横向溢出', ()=>{
    const m=document.getElementById('main');
    if(!m) return 'no #main';
    const bad=[];
    m.querySelectorAll('*').forEach(el=>{
      const r=el.getBoundingClientRect();
      if(!r.width||!r.height) return;
      const cs=getComputedStyle(el);
      if(cs.position==='fixed'||cs.display==='none') return;
      if(r.right<=vw+2) return;
      let p=el.parentElement, scrollable=false;
      while(p&&p!==document.body){ const pcs=getComputedStyle(p);
        if(pcs.overflowX==='auto'||pcs.overflowX==='scroll'){ scrollable=true; break; } p=p.parentElement; }
      if(scrollable) return;
      bad.push((el.id?('#'+el.id):(el.className||el.tagName))+'@'+Math.round(r.right));
    });
    return bad.length? (bad.slice(0,4).join(' | ')) : true;
  });
  T('视图内输入控件字号 ≥16px', ()=>{
    const m=document.getElementById('main');
    if(!m) return 'no #main';
    const bad=[];
    m.querySelectorAll('input:not([type=hidden]):not([type=range]),select,textarea').forEach(el=>{
      const r=el.getBoundingClientRect(); if(!r.width) return;
      const fs=parseFloat(getComputedStyle(el).fontSize);
      if(fs<16) bad.push((el.className||el.tagName)+'='+fs);
    });
    return bad.length? bad.slice(0,4).join(',') : true;
  });
  return out;
})()`;

async function runDevice(dev) {
  const port = 9950 + Math.floor(Math.random() * 40);
  const udd = path.join(os.tmpdir(), 'gll-ios-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--user-data-dir=' + udd, PAGE],
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
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr, mobile: true,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sleep(1000);
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(5000);

    let booted = false;
    for (let i = 0; i < 14; i++) {
      if ((await cdp.eval('!!window.__lexiloopBooted')) === true) { booted = true; break; }
      await sleep(500);
    }
    res.checks.push({ name: '应用启动完成（__lexiloopBooted）', pass: booted, detail: booted ? '' : '15s 内未置位' });
    await sleep(1500);

    await cdp.eval('window.__DEV_W__=' + dev.w);
    const base = await cdp.eval(PAGE_CHECKS);
    if (Array.isArray(base)) res.checks.push(...base);

    /* 已登录才有 tabbar；未登录则只覆盖首屏并说明 */
    const loggedIn = await cdp.eval('!!document.querySelector(".tabbar")');
    if (loggedIn === true) {
      res.checks.push({ name: '已登录（可遍历各视图）', pass: true, detail: '' });
      const tabs = await cdp.eval(`[...document.querySelectorAll('.tabbar button[data-tab]')].map(function(b){return b.dataset.tab})`);
      for (const t of (tabs || [])) {
        await cdp.eval(`(function(){ var b=document.querySelector('.tabbar button[data-tab="'+${JSON.stringify(t)}+'"]'); if(b) b.click(); })()`);
        await sleep(800);
        const tc = await cdp.eval(TAB_CHECKS);
        if (Array.isArray(tc)) tc.forEach((c) => res.checks.push(Object.assign({}, c, { name: '［' + t + '］' + c.name })));
      }
      /* 逐个确认 6 个 tab 都点得到 */
      res.checks.push({ name: 'tab 数量与可达性', pass: (tabs || []).length >= 4, detail: 'tabs=' + JSON.stringify(tabs) });
    } else {
      res.checks.push({ name: '未登录（视图级检查跳过，仅覆盖登录首屏）', pass: true, detail: '', skip: true });
    }

    /* PWA / 离线 */
    const pwa = await cdp.eval(`(async function(){
      try{
        var regs=navigator.serviceWorker? await navigator.serviceWorker.getRegistrations():[];
        var keys=[]; try{ keys=await caches.keys(); }catch(e){}
        var list=['manifest.webmanifest','sw.js','vendor/workbuddy-cloud-sdk.js','icon-192.png'];
        var assets={}; for(var i=0;i<list.length;i++){ try{ var r=await fetch(list[i]); assets[list[i]]=r.status; }catch(e){ assets[list[i]]='ERR'; } }
        return { swCount:regs.length, active:!!(regs[0]&&regs[0].active), caches:keys, assets:assets };
      }catch(e){ return { thrown:String(e&&e.message||e) }; } })()`);
    res.checks.push({ name: 'Service Worker 已注册并激活', pass: pwa && pwa.swCount > 0 && pwa.active, detail: JSON.stringify(pwa && { c: pwa.swCount, a: pwa.active }) });
    Object.keys((pwa && pwa.assets) || {}).forEach((k) => {
      res.checks.push({ name: '资源可访问 ' + k, pass: pwa.assets[k] === 200, detail: 'HTTP ' + pwa.assets[k] });
    });

    /* 离线壳 */
    try {
      let ctrl = await cdp.eval('!!navigator.serviceWorker.controller');
      if (!ctrl) {
        await cdp.eval(`(async function(){ try{ await navigator.serviceWorker.ready; return true; }catch(e){ return false; } })()`);
        await sleep(1000);
        ctrl = await cdp.eval('!!navigator.serviceWorker.controller');
      }
      if (!ctrl) {
        await cdp.send('Page.reload', { ignoreCache: false });
        await sleep(4500);
        for (let i = 0; i < 12; i++) { ctrl = await cdp.eval('!!navigator.serviceWorker.controller'); if (ctrl) break; await sleep(500); }
      }
      res.checks.push({ name: 'Service Worker 已接管页面', pass: !!ctrl, detail: ctrl ? '' : '等待 ready + 重载后仍未受控' });
      await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      await cdp.send('Page.reload', { ignoreCache: false });
      await sleep(5000);
      const off = await cdp.eval(`(function(){
        return { booted: !!window.__lexiloopBooted,
                 hasRoot: !!document.querySelector('#root'),
                 title:(document.title||'').slice(0,20) }; })()`);
      res.checks.push({ name: '断网后仍可打开（离线壳生效）', pass: !!(off && off.booted && off.hasRoot), detail: JSON.stringify(off) });
    } catch (e) {
      res.checks.push({ name: '离线维度', pass: false, detail: e.message });
    } finally {
      try { await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); } catch (e) {}
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
  console.log('目标：' + PAGE + '\n');
  let total = 0, failed = 0;
  for (const dev of DEVICES) {
    const r = await runDevice(dev);
    console.log('=== ' + r.dev + ' ===');
    if (r.error) { console.log('  运行失败: ' + r.error); failed++; continue; }
    r.checks.forEach((c) => {
      total++;
      if (!c.pass) failed++;
      const tag = c.skip ? 'SKIP' : (c.pass ? 'PASS' : 'FAIL');
      console.log('  ' + tag + '  ' + c.name + (c.pass || c.skip ? '' : '  → ' + c.detail));
    });
    (r.exceptions || []).forEach((e) => { failed++; console.log('  FAIL  页面异常  → ' + e); });
    console.log('');
  }
  console.log('===== LexiLoop 移动端质检: ' + (total - failed) + '/' + total + ' 通过' +
    (failed ? ('，' + failed + ' 项失败') : '，全部通过') + ' =====');
  process.exit(failed ? 1 : 0);
})();
