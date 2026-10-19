'use strict';
/* 验证 words 表收紧后：匿名访客「读得到、写不进」。
   攻击性测试，所有写入都带 QA 前缀，若意外成功会被立即清理。
   用法：node tools/qa-words-perm.js */
const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PAGE = 'https://lexiloop-82703.app.workbuddy.host/';
const MARK = 'QA_PERMISSION_PROBE_DO_NOT_KEEP';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

(async () => {
  const port = 9991;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'gll-perm-' + Date.now()), PAGE],
    { windowsHide: true, stdio: 'ignore' });
  try {
    let pg = null;
    for (let i = 0; i < 90; i++) {
      await sleep(300);
      try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (pg) break; } catch (e) {}
    }
    const ws = new WebSocket(pg.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && map.has(m.id)) { map.get(m.id)(m); map.delete(m.id); } };
    const send = (m2, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m2, params: p || {} })); return new Promise((r) => map.set(i, r)); };
    await send('Runtime.enable');
    const ev = async (x) => {
      const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    await sleep(7000);

    const r = await ev(`(async function(){
      var cl = await import('./js/cloud.js');
      var c = cl.getCloud();
      var rep = {};
      var MARK = ${JSON.stringify(MARK)};

      /* 1) 读：必须仍然可用（应用靠它加载词表） */
      try{ var s = await c.database.from('words').select('id,normalized').limit(3);
        rep.read = { rows:(s.data||[]).length, err:s.error? String(s.error.code||s.error.message||s.error):null }; }
      catch(e){ rep.read = { thrown:String(e&&e.message||e) }; }

      /* 2) 插：应被拒绝。用一个显眼标记，万一成功便于清理 */
      try{ var i = await c.database.from('words').insert([{ normalized: MARK, lemma: MARK, payload:{} }]);
        rep.insert = { allowed:!i.error, err:i.error? String(i.error.code||i.error.message||i.error):null }; }
      catch(e){ rep.insert = { allowed:false, thrown:String(e&&e.message||e) }; }

      /* 3) 改：应被拒绝。改成它原本的值（no-op），即便成功也不改坏数据 */
      try{
        var pick = await c.database.from('words').select('id,lemma').limit(1);
        var row = (pick.data||[])[0];
        if(!row){ rep.update = { skipped:'无行可测' }; }
        else{
          var u = await c.database.from('words').update({ lemma: row.lemma }).eq('id', row.id);
          rep.update = { allowed:!u.error, err:u.error? String(u.error.code||u.error.message||u.error):null, id:row.id };
        }
      }catch(e){ rep.update = { allowed:false, thrown:String(e&&e.message||e) }; }

      /* 4) 删：应被拒绝（无 DELETE 策略） */
      try{ var d = await c.database.from('words').delete().eq('normalized', MARK);
        rep.del = { allowed:!d.error, err:d.error? String(d.error.code||d.error.message||d.error):null }; }
      catch(e){ rep.del = { allowed:false, thrown:String(e&&e.message||e) }; }

      return rep;
    })()`);

    if (!r || r.__err) add('执行探针', false, JSON.stringify(r));
    else {
      console.log('真实匿名客户端攻击测试：\n');
      for (const k of ['read', 'insert', 'update', 'del']) {
        console.log('  ' + k.padEnd(8) + JSON.stringify(r[k]));
      }
      console.log('');

      add('读词表仍然可用（应用功能不受影响）',
        r.read && r.read.rows > 0, JSON.stringify(r.read));
      add('★ 匿名 INSERT 被拒绝',
        r.insert && r.insert.allowed === false, JSON.stringify(r.insert));
      add('★ 匿名 UPDATE 被拒绝',
        r.update && (r.update.allowed === false || r.update.skipped), JSON.stringify(r.update));
      add('★ 匿名 DELETE 被拒绝',
        r.del && r.del.allowed === false, JSON.stringify(r.del));
      if (r.insert && r.insert.allowed === true) {
        add('!! INSERT 竟然成功 —— 权限已回退，需清理脏数据', false,
          '清理：mode:"migrate" 执行 ' +
          "DELETE FROM public.words WHERE normalized = '" + MARK + "'");
      }
    }
    ws.close();
  } catch (e) { add('执行', false, e.message); }
  finally { try { proc.kill(); } catch (e) {} }

  let bad = 0;
  out.forEach((o) => { if (!o.pass) bad++; console.log((o.pass ? '  PASS  ' : '  FAIL  ') + o.n + (o.pass ? '' : '  → ' + o.d)); });
  console.log('\n===== words 权限收敛验证: ' + (out.length - bad) + '/' + out.length + ' 通过' +
    (bad ? ('，' + bad + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad ? 1 : 0);
})();
