'use strict';
/* 实测：LexiLoop 依赖的 jsdelivr CDN 在本机的稳定性（更了么曾因此静默失效） */
const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PAGE = 'https://lexiloop-82703.app.workbuddy.host/';
const CDN = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
const N = parseInt(process.argv[2] || '5', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ok = 0, fail = 0;
  const detail = [];
  for (let i = 0; i < N; i++) {
    const port = 9910 + i;
    const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
      '--user-data-dir=' + path.join(os.tmpdir(), 'gll-cdn-' + i + '-' + Date.now()), PAGE],
      { windowsHide: true, stdio: 'ignore' });
    try {
      let pg = null;
      for (let k = 0; k < 60; k++) {
        await sleep(300);
        try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
          pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (pg) break; } catch (e) {}
      }
      if (!pg) { fail++; detail.push('#' + (i + 1) + ' 无法连接'); continue; }
      const ws = new WebSocket(pg.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      let id = 0; const map = new Map();
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && map.has(m.id)) { map.get(m.id)(m); map.delete(m.id); } };
      const send = (m2, p) => { const k2 = ++id; ws.send(JSON.stringify({ id: k2, method: m2, params: p || {} })); return new Promise((r) => map.set(k2, r)); };
      await send('Runtime.enable');
      const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
      await sleep(5500);
      const sdk = await ev('typeof window.WorkBuddyCloud');
      const fetchRes = await ev(`(async function(){ try{ var r=await fetch('${CDN}'); return 'HTTP '+r.status; }catch(e){ return 'ERR '+String(e&&e.message||e).slice(0,50); } })()`);
      if (sdk === 'object') { ok++; detail.push('#' + (i + 1) + ' SDK ✅  ' + fetchRes); }
      else { fail++; detail.push('#' + (i + 1) + ' SDK ❌ (typeof=' + sdk + ')  ' + fetchRes); }
      ws.close();
    } catch (e) { fail++; detail.push('#' + (i + 1) + ' 异常 ' + e.message); }
    finally { try { proc.kill(); } catch (e) {} }
  }
  console.log('连续 ' + N + ' 次冷启动，统计云 SDK 是否加载成功：\n');
  detail.forEach((d) => console.log('  ' + d));
  console.log('\n结果：成功 ' + ok + ' / ' + N + '，失败 ' + fail +
    (fail ? '  ← 存在间歇性失效风险（页面照常打开，但云功能静默失效）' : '  ← 本轮稳定'));
  process.exit(0);
})();
