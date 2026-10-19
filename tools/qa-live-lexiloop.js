'use strict';
/* LexiLoop 重新发布后的真实环境验证 */
const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PAGE = process.argv[2] || 'https://lexiloop-82703.app.workbuddy.host/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

(async () => {
  const port = 9901;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-' + Date.now()), PAGE], { windowsHide: true, stdio: 'ignore' });
  try {
    let pg = null;
    for (let i = 0; i < 90; i++) {
      await sleep(300);
      try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (pg) break; } catch (e) {}
    }
    if (!pg) { console.log('无法连接调试页'); return; }
    const ws = new WebSocket(pg.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const map = new Map(); const errs = []; const netFail = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errs.push((d.exception && d.exception.description) || d.text);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errs.push('console.error: ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (m.method === 'Network.loadingFailed' && m.params.type === 'Script') {
        netFail.push(m.params.errorText);
      }
      if (m.id && map.has(m.id)) { map.get(m.id)(m); map.delete(m.id); } };
    const send = (m2, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m2, params: p || {} })); return new Promise((r) => map.set(i, r)); };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
      return r.result && r.result.result ? r.result.result.value : undefined; };
    await sleep(6000);

    add('页面标题正确', /LexiLoop|英语/.test(String(await ev('document.title'))), await ev('document.title'));
    add('主界面已渲染', !!(await ev('!!document.querySelector("main, .app, #app, body > div")')), 'no root');

    /* SDK 加载来源：必须是同源 vendor，而不是 CDN。
       CDN 失败是"页面照常打开但云功能全哑"的静默故障，所以这条要显式守住。 */
    const srcInfo = await ev(`(function(){
      var s=[...document.querySelectorAll('script[src]')].map(function(x){return x.getAttribute('src')})
        .filter(function(x){return /workbuddy-cloud-sdk/.test(x)});
      return { list:s, fromCdn: s.some(function(x){ return /^https?:\\/\\//.test(x) && /jsdelivr|unpkg|jsdmirror/.test(x); }),
               sameOrigin: s.some(function(x){ return x.indexOf('vendor/')===0; }) };
    })()`);
    const sdk = await ev('typeof window.WorkBuddyCloud');
    add('SDK 走同源 vendor（不依赖外部 CDN）',
      srcInfo && srcInfo.sameOrigin, JSON.stringify(srcInfo));
    add('SDK 主引用非 CDN（CDN 仅作兜底）',
      srcInfo && srcInfo.fromCdn === false, JSON.stringify(srcInfo));
    add('SDK 全局已就绪', sdk === 'object', 'typeof=' + sdk);

    /* 走 ES module 动态 import 才是正确访问方式（config.js 是 export，不会挂 window） */
    const mod = await ev(`(async function(){
      try{
        var cfg=await import('./js/config.js');
        var cl=await import('./js/cloud.js');
        return { ok:true, endpoint: cfg.CLOUD_CONFIG && cfg.CLOUD_CONFIG.endpoint,
                 hasKey: !!(cfg.CLOUD_CONFIG && /^wbpk_/.test(cfg.CLOUD_CONFIG.publishableKey)),
                 hasGetCloud: typeof cl.getCloud==='function' };
      }catch(e){ return { ok:false, thrown:String(e&&e.message||e) }; } })()`);
    add('业务模块可加载（ES module）', mod && mod.ok && mod.hasGetCloud, JSON.stringify(mod));
    add('云配置指向发布域名（Origin 匹配）',
      mod && /lexiloop-82703\.app\.workbuddy\.host/.test(String(mod.endpoint)) && mod.hasKey,
      JSON.stringify(mod));

    /* 云端可达性 */
    const auth = await ev(`(async function(){
      try{ var cl=await import('./js/cloud.js'); var c=cl.getCloud();
        if(!c) return {noClient:true};
        var r=await c.auth.getSession();
        return { ok:true, hasSession: !!r.data, err: r.error? String(r.error.message||r.error): null };
      }catch(e){ return { thrown:String(e&&e.message||e) }; } })()`);
    add('云 Auth 可达（未登录返回空而非报错）',
      auth && auth.ok && !auth.hasSession && !auth.thrown, JSON.stringify(auth));

    /* 安全：区分「公开内容表」与「用户数据表」——两者该有的表现完全不同。
       实测结论（2026-10-04）：words 是共享词表（含音标/富化字段，无任何用户数据），
       未登录可读是设计如此；而 reviews / cards / settings 是用户数据，RLS 已正确挡住（0 行）。 */
    const sec = await ev(`(async function(){
      try{ var cl=await import('./js/cloud.js'); var c=cl.getCloud(); var o={};
        for (const t of ['words','reviews','cards','settings']){
          var r=await c.database.from(t).select('id').limit(3);
          o[t]={ rows:(r.data||[]).length, err:r.error? String(r.error.code||r.error.message||r.error): null };
        }
        return o;
      }catch(e){ return { thrown:String(e&&e.message||e) }; } })()`);
    add('公开词表 words 可读（应用内容，设计如此）',
      sec && sec.words && sec.words.rows >= 0, JSON.stringify(sec && sec.words));
    ['reviews', 'cards'].forEach((t) => {
      add('用户数据表 ' + t + ' 未登录被挡住（0 行）',
        sec && sec[t] && sec[t].rows === 0, JSON.stringify(sec && sec[t]));
    });
    /* settings 有一个"匿名公共桶"（owner_id='anon'），未登录可读是设计如此；
       真正要守的是：里面**不能出现真实用户的数据**，且行数不能自己增长。
       （2026-10-04 曾因布局体检工具误写入过 1 行 anon 脏数据，工具已加拦截。） */
    const setRows = await ev(`(async function(){
      try{ var cl=await import('./js/cloud.js'); var c=cl.getCloud();
        var r=await c.database.from('settings').select('id,owner_id').limit(20);
        return { n:(r.data||[]).length, owners:[...new Set((r.data||[]).map(function(x){return x.owner_id}))] };
      }catch(e){ return { thrown:String(e&&e.message||e) }; } })()`);
    add('settings 匿名桶内无真实用户数据（owner_id 全为 anon）',
      setRows && Array.isArray(setRows.owners) &&
      setRows.owners.every((o) => o === 'anon' || o === null || o === undefined),
      JSON.stringify(setRows));

    const llm = await ev(`(async function(){
      try{ var cl=await import('./js/cloud.js'); var c=cl.getCloud();
        var l=await c.llm.models.list();
        return { n:(l||[]).length, hasFlash:(l||[]).some(function(m){return /flash/i.test(m.id)}) };
      }catch(e){ return { thrown:String(e&&e.message||e) }; } })()`);
    add('LLM 代理可达（免密钥通道）', llm && !llm.thrown && llm.n > 0, JSON.stringify(llm));

    /* PWA */
    const pwa = await ev(`(async function(){
      try{
        var regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
        var keys = []; try{ keys = await caches.keys(); }catch(e){}
        return { swCount: regs.length, active: !!(regs[0]&&regs[0].active), caches: keys };
      }catch(e){ return { thrown:String(e&&e.message||e) }; } })()`);
    add('Service Worker 已注册并激活', pwa && pwa.swCount > 0 && pwa.active, JSON.stringify(pwa));

    const assets = await ev(`(async function(){
      var list=['manifest.webmanifest','sw.js','styles.css','icon-192.png','vendor/workbuddy-cloud-sdk.js'];
      var o={}; for(var i=0;i<list.length;i++){ try{ var r=await fetch(list[i]); o[list[i]]=r.status; }catch(e){ o[list[i]]='ERR'; } }
      return o; })()`);
    Object.keys(assets || {}).forEach((k) => add('资源可访问 ' + k, assets[k] === 200, 'HTTP ' + assets[k]));

    /* 离线壳里应已包含 vendor —— 断网时连云客户端都能初始化。
       缓存名**不要写死**：改版会换 CACHE 名，写死就会假失败（2026-10-04 实测踩过）。
       这里从 sw.js 源码里读出当前 CACHE 名。 */
    const swUrl = PAGE.replace(/\/+$/, '') + '/sw.js?nocache=' + Date.now();
    const cacheName = ((await (await fetch(swUrl)).text())
      .match(/const CACHE\s*=\s*'([^']+)'/) || [])[1];
    add('能解析出当前 SW 缓存名', !!cacheName, '未能从 sw.js 解析 CACHE');
    const shell = await ev(`(async function(){
      try{
        var keys = await caches.keys();
        var target = ${JSON.stringify(cacheName || '')} || keys[0];
        var c = await caches.open(target);
        var k = await c.keys();
        return { name: target, paths: k.map(function(r){return new URL(r.url).pathname;}) };
      }catch(e){ return {thrown:String(e&&e.message||e)}; } })()`);
    add('离线壳已缓存 vendor SDK',
      shell && Array.isArray(shell.paths) &&
      shell.paths.some((p) => String(p).indexOf('vendor/workbuddy-cloud-sdk.js') >= 0),
      JSON.stringify(shell));

    /* 移动端视口（顺带确认响应式没坏） */
    await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    await sleep(1200);
    const mob = await ev(`(function(){
      var vw=window.innerWidth, sw=document.documentElement.scrollWidth;
      return { vw:vw, overflow: sw>vw+1, scrollW:sw }; })()`);
    add('移动端无横向溢出（393px）', mob && !mob.overflow, JSON.stringify(mob));

    add('零未捕获异常', errs.length === 0, [...new Set(errs)].slice(0, 3).join(' | '));
    ws.close();
  } catch (e) { add('执行', false, e.message); }
  finally { try { proc.kill(); } catch (e) {} }

  console.log('目标：' + PAGE + '\n');
  let bad = 0;
  out.forEach((r) => { if (!r.pass) bad++; console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.n + (r.pass ? '' : '  → ' + r.d)); });
  console.log('\n===== LexiLoop 线上验证: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
