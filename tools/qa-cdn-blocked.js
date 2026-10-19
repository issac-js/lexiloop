'use strict';
/* 关键回归测试：把 CDN 域名整片封掉，验证云 SDK 仍能加载、云服务仍可用。
   这正是 2026-10-02 在更了么上踩到的故障（jsdelivr 间歇性重置 →
   页面照常打开但云功能全哑）。有了同源 vendor 副本后，本测试应始终通过。

   用法：node tools/qa-cdn-blocked.js [url] */
const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PAGE = process.argv[2] || 'https://lexiloop-82703.app.workbuddy.host/';
const BLOCK = ['*cdn.jsdelivr.net*', '*unpkg.com*', '*jsdmirror*', '*elemecdn*', '*staticfile*'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

(async () => {
  const port = 9921;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-blk-' + Date.now()), 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
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
    let id = 0; const map = new Map(); const errs = []; const blocked = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.method === 'Network.loadingFailed') blocked.push(m.params.errorText);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errs.push((d.exception && d.exception.description) || d.text);
      }
      if (m.id && map.has(m.id)) { map.get(m.id)(m); map.delete(m.id); } };
    const send = (m2, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m2, params: p || {} })); return new Promise((r) => map.set(i, r)); };
    const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
      return r.result && r.result.result ? r.result.result.value : undefined; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');

    /* 先封掉所有常见 CDN，再导航 —— 复现"CDN 被墙" */
    await send('Network.setBlockedURLs', { urls: BLOCK });
    await send('Page.navigate', { url: PAGE });
    await sleep(9000);

    /* 确认封锁真的生效了（CDN 请求应当失败） */
    const cdnDead = await ev(`(async function(){
      try{ var r=await fetch('https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js');
        return { blocked:false, status:r.status }; }
      catch(e){ return { blocked:true, err:String(e&&e.message||e).slice(0,60) }; } })()`);
    add('前置条件：CDN 确实已被封锁', cdnDead && cdnDead.blocked, JSON.stringify(cdnDead));

    const sdk = await ev('typeof window.WorkBuddyCloud');
    add('CDN 被封时 SDK 仍加载成功（来自同源 vendor）', sdk === 'object', 'typeof=' + sdk);

    add('应用在 CDN 被封时正常启动', (await ev('!!window.__lexiloopBooted')) === true, '__lexiloopBooted 未置位');
    add('主界面已渲染', !!(await ev('!!document.querySelector("#root, .app, main")')), 'no root');

    const auth = await ev(`(async function(){
      try{ var cl=await import('./js/cloud.js'); var c=cl.getCloud();
        if(!c) return {noClient:true};
        var r=await c.auth.getSession();
        return { ok:true, hasSession:!!r.data, err:r.error? String(r.error.message||r.error): null };
      }catch(e){ return { thrown:String(e&&e.message||e) }; } })()`);
    add('CDN 被封时云 Auth 仍可达', auth && auth.ok && !auth.thrown, JSON.stringify(auth));

    const llm = await ev(`(async function(){
      try{ var cl=await import('./js/cloud.js'); var c=cl.getCloud();
        var l=await c.llm.models.list(); return { n:(l||[]).length }; }
      catch(e){ return { thrown:String(e&&e.message||e) }; } })()`);
    add('CDN 被封时 LLM 代理仍可达', llm && !llm.thrown && llm.n > 0, JSON.stringify(llm));

    add('CDN 被封时零未捕获异常', errs.length === 0, [...new Set(errs)].slice(0, 3).join(' | '));
    ws.close();
  } catch (e) { add('执行', false, e.message); }
  finally { try { proc.kill(); } catch (e) {} }

  console.log('封锁 ' + BLOCK.join(' / ') + ' 后访问 ' + PAGE + '\n');
  let bad = 0;
  out.forEach((r) => { if (!r.pass) bad++; console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.n + (r.pass ? '' : '  → ' + r.d)); });
  console.log('\n===== CDN 封锁韧性: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
