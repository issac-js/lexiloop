'use strict';
// Screenshot only after the expected release, server-confirmed QA identity and sync are checked.
const fs = require('node:fs');
const path = require('node:path');
const { run, fail } = require('./lib/live-checks.js');

async function task({ cfg, cdp, add, skip }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
  const rendered = await cdp.eval(`!!document.querySelector('.tabbar')&&!!document.querySelector('#main')`);
  if (!rendered) fail('Authenticated application shell did not render');
  add('Authenticated application shell rendered', true);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const bytes = Buffer.from(shot.data || '', 'base64');
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('Browser returned an invalid PNG');
  fs.mkdirSync(cfg.out, { recursive: true, mode: 0o700 });
  const file = path.join(cfg.out, 'qa-release-shot-' + Date.now() + '-' + process.pid + '.png');
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  add('PNG screenshot saved locally', true);
  skip('Visual layout and content correctness', 'Screenshot capture is not a visual review; inspect the local PNG separately');
}

if (require.main === module) run('qa-release-shot', task).catch(() => { process.exitCode = 1; });
module.exports = { task };
