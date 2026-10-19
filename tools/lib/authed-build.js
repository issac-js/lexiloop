'use strict';
/* 共用：构造"绕过登录闸门 + 全程禁写云端"的测试构建，并本地伺服。
   被 tools/qa-ios-loggedin.js 与 tools/qa-study-logic.js 复用。

   ⚠ 三层防护缺一不可（2026-10-04 实测教训）：
     ① 移除 flushPending/syncPull —— 只换 session 会往生产云库写脏数据；
     ② 注入 /.cloud/ fetch 拦截器 —— 挡住 SDK 内部任何写入路径；
     ③ 构建后自检防护是否在位 —— 缺失就拒绝运行，绝不硬跑。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SRC = path.resolve(__dirname, '..', '..', 'lexiloop');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function buildAuthed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gll-authed-'));
  const copy = (rel) => {
    const from = path.join(SRC, rel);
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };
  copy('index.html'); copy('styles.css'); copy('sw.js'); copy('manifest.webmanifest');
  copy('icon.svg'); copy('icon-180.png'); copy('icon-192.png'); copy('icon-512.png');
  for (const f of fs.readdirSync(path.join(SRC, 'js'))) {
    if (f.endsWith('.js')) copy('js/' + f);
  }
  const vdir = path.join(SRC, 'vendor');
  if (fs.existsSync(vdir)) for (const f of fs.readdirSync(vdir)) copy('vendor/' + f);

  /* ① 换假 session + 摘掉会写库的同步调用。
     注意要把**所有**调用点都摘掉，不只第一处：app.js 里登录后、手动重试、
     回到前台、恢复联网各有一次 —— 漏一处，测试就会真的往生产库写东西。
     （2026-10-09 实测：新增 resync() 后正是自检拦住了这个漏洞。） */
  const appPath = path.join(dir, 'js', 'app.js');
  let src = fs.readFileSync(appPath, 'utf8');
  const needle = 'const session = await AUTH.getSession()';
  if (src.indexOf(needle) < 0) {
    console.error('!! 未找到注入点（app.js 结构已变）：' + needle);
    return null;
  }
  src = src.replace(needle,
    "const session = { user: { id: 'qa-layout-probe', email: 'qa@example.invalid' } } // QA: 布局/逻辑体检用假 session");

  const before = src;
  src = src
    .replace(/await S\.flushPending\(\)\s*\n\s*await S\.syncPull\(\)/g,
      '/* QA: 已移除 flushPending/syncPull，避免写生产云库 */')
    .replace(/await S\.flushPending\(\)/g, '/* QA: cloud blocked */')
    .replace(/await S\.syncPull\(\)/g, '/* QA: cloud blocked */')
    .replace(/\bS\.flushPending\(\)/g, 'Promise.resolve()')
    .replace(/\bS\.syncPull\(\)/g, 'Promise.resolve()')
  if (src === before) {
    console.error('!! 未找到 flushPending/syncPull 调用点（app.js 结构已变）——拒绝运行');
    return null;
  }
  fs.writeFileSync(appPath, src, 'utf8');

  /* ② 注入 /.cloud/ 拦截器 */
  const idxPath = path.join(dir, 'index.html');
  let html = fs.readFileSync(idxPath, 'utf8');
  const guard = '<script>/* QA：禁止任何云端数据面请求 */\n' +
    '(function(){var f=window.fetch;window.fetch=function(u,o){' +
    'var s=(typeof u==="string"?u:(u&&u.url)||"")||"";' +
    'if(s.indexOf("/.cloud/")>=0) return Promise.reject(new Error("QA: cloud blocked"));' +
    'return f.apply(this,arguments);};})();</' + 'script>';
  html = html.replace('</head>', guard + '\n</head>');
  fs.writeFileSync(idxPath, html, 'utf8');

  /* ③ 自检 */
  const chkApp = fs.readFileSync(appPath, 'utf8');
  const chkIdx = fs.readFileSync(idxPath, 'utf8');
  if (/S\.flushPending\(\)|S\.syncPull\(\)/.test(chkApp) || !/QA: cloud blocked/.test(chkIdx)) {
    console.error('!! 云端写入防护未生效，拒绝运行');
    return null;
  }
  return dir;
}

function serve(root, port) {
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
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

module.exports = { buildAuthed, serve, SRC };
