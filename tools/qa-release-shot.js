'use strict';
/* LexiLoop · 发布验收补充：用户视角截图 + 今日页渲染（只读） */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* 可配置项见 tools/README-live-checks.md；不写死本机绝对路径 */
const SITE = process.env.LEXILOOP_SITE || 'https://lexiloop-82703.app.workbuddy.host/';
const EDGE = process.env.LEXILOOP_EDGE_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = process.env.LEXILOOP_QA_PROFILE || path.join(os.tmpdir(), 'gll-gd-profile');
const SHOT = (process.env.LEXILOOP_QA_OUT_DIR
  ? path.join(process.env.LEXILOOP_QA_OUT_DIR, 'release-acceptance-' + new Date().toISOString().slice(0, 10) + '.png')
  : path.resolve(__dirname, '..', '.workbuddy', 'release-acceptance-' + new Date().toISOString().slice(0, 10) + '.png'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.map = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.map.has(m.id)) { this.map.get(m.id)(m); this.map.delete(m.id); } }; }
  static async connect(url, tries = 100) { for (let i = 0; i < tries; i++) {
    try { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); }); return new CDP(ws); } catch (e) { await sleep(250); } }
    throw new Error('CDP 连接超时'); }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); return new Promise((res) => this.map.set(id, res)); }
  async eval(expr, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs || 120000 });
    if (r.result && r.result.exceptionDetails) { const d = r.result.exceptionDetails; return { __err: (d.exception && d.exception.description) || d.text }; }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  const port = 10054;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--mute-audio', '--remote-debugging-port=' + port,
    '--user-data-dir=' + PROFILE, '--window-size=430,932', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let cdp = null;
  try {
    let pg = null;
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      try { const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        pg = (l || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (pg) break; } catch (e) {}
    }
    if (!pg) throw new Error('无法连接调试页');
    cdp = await CDP.connect(pg.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: SITE });
    for (let i = 0; i < 60; i++) { await sleep(500); if ((await cdp.eval('!!window.WorkBuddyCloud')) === true) break; }
    for (let i = 0; i < 80; i++) { await sleep(250); if ((await cdp.eval("!!document.querySelector('.tabbar')")) === true) break; }
    await sleep(2500);
    const info = await cdp.eval(`(function(){
      var t = (document.body.innerText || '').replace(/\\n{2,}/g, '\\n').slice(0, 600);
      return { text: t, sw: !!document.querySelector('.tabbar') };
    })()`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log('RESULT_JSON=' + JSON.stringify({ text: info && info.text, shot: SHOT }));
  } catch (e) {
    console.log('RESULT_JSON=' + JSON.stringify({ __err: String(e && e.stack || e) }));
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
  }
  process.exit(0);
})();
