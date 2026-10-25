'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'lexiloop');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

async function serveFixture(port = 0, outDir) {
  const audit = { cloudRequests: [], reports: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
    if (url.pathname.startsWith('/.cloud/')) {
      audit.cloudRequests.push({ method: req.method, path: url.pathname });
      res.writeHead(403); return res.end('QA: cloud forbidden');
    }
    if (url.pathname === '/__qa/report' && req.method === 'POST') {
      let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 1000000) req.destroy(); });
      req.on('end', () => {
        try {
          const report = JSON.parse(body); audit.reports.push(report);
          if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'ios-safari-results.json'), JSON.stringify(report, null, 2)); }
          res.writeHead(200); res.end('saved');
        } catch (_) { res.writeHead(400); res.end('bad report'); }
      }); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    let file;
    try {
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/vendor/workbuddy-cloud-sdk.js') file = path.join(ROOT, 'tools/browser/fixture-sdk.js');
      else if (pathname === '/__qa/ios-runner.js') file = path.join(ROOT, 'tools/browser/ios-runner.js');
      else file = path.resolve(APP, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!(file.startsWith(APP + path.sep) || file.startsWith(path.join(ROOT, 'tools/browser') + path.sep)) || !fs.statSync(file).isFile()) throw Error('path');
    } catch (_) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    if (file.endsWith('index.html') && url.searchParams.get('ios') === '1') {
      return res.end(fs.readFileSync(file, 'utf8').replace('</body>', '<script type="module" src="/__qa/ios-runner.js"></script></body>'));
    }
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, audit, url: 'http://127.0.0.1:' + server.address().port };
}

module.exports = { serveFixture };
if (require.main === module) serveFixture(Number(process.env.LEXILOOP_FIXTURE_PORT) || 8765, process.env.LEXILOOP_BROWSER_OUT_DIR).then(({ url }) => console.log('Fixture server: ' + url));
