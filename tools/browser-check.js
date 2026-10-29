'use strict';
// Actual browser engines against a loopback SDK fixture. This is not production gateway QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit, devices } = require('playwright');
const { serveFixture } = require('./lib/browser-fixture-server.js');
const OUT = path.resolve(process.env.LEXILOOP_BROWSER_OUT_DIR || path.join(os.tmpdir(), 'lexiloop-browser-results'));
const results = [];
const VERSION = fs.readFileSync(path.join(__dirname, '../lexiloop/index.html'), 'utf8').match(/app\.js\?v=(\d+)/)[1];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const fixture = await serveFixture();
  const variants = [
    { name: 'chromium-desktop', engine: chromium, options: { viewport: { width: 1440, height: 1000 } }, full: true },
    { name: 'webkit-iphone-se', engine: webkit, options: { ...devices['iPhone SE'] }, full: true },
    { name: 'webkit-iphone-large', engine: webkit, options: { ...devices['iPhone 14 Pro Max'] } },
    { name: 'webkit-iphone-landscape', engine: webkit, options: { ...devices['iPhone SE landscape'] } },
    { name: 'webkit-ipad', engine: webkit, options: { ...devices['iPad Mini'] } },
  ];
  try {
    for (const variant of variants) {
      let browser, context;
      const errors = [], external = [];
      const check = async (name, run) => {
        try { const detail = await run(); results.push({ device: variant.name, name, pass: true, detail }); console.log('PASS ' + variant.name + ': ' + name); }
        catch (error) { results.push({ device: variant.name, name, pass: false, error: error.stack }); console.error('FAIL ' + variant.name + ': ' + name + ': ' + error.message); }
      };
      try {
        browser = await variant.engine.launch({ headless: true });
        context = await browser.newContext({ ...variant.options, serviceWorkers: 'block', locale: 'zh-CN' });
        await context.route('**/*', (route) => {
          if (new URL(route.request().url()).origin !== fixture.url) { external.push(route.request().url()); return route.abort(); }
          return route.continue();
        });
        let page;
        const open = async (scenario = 'normal') => {
          if (page) await page.close();
          page = await context.newPage(); page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(fixture.url + '/?nosw=1&fixture=' + scenario);
          await page.waitForFunction(async (v) => (await import('./js/store.js?v=' + v)).state.load.phase === 'ready', VERSION);
          await page.locator('.tabbar button[data-tab=me]').waitFor();
        };
        const tab = async (name) => { await page.locator('.tabbar button[data-tab=' + name + ']').click(); };
        const layout = async () => {
          const measure = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - innerWidth,
            inputs: [...document.querySelectorAll('input:not([type=checkbox]):not([type=range]),select,textarea')].filter((e) => e.getBoundingClientRect().width).map((e) => ({ id: e.id, font: parseFloat(getComputedStyle(e).fontSize) })),
            labels: [...document.querySelectorAll('label.row')].filter((e) => e.querySelector('input[type=checkbox]')).map((e) => ({ id: e.querySelector('input').id, height: e.getBoundingClientRect().height })),
            coarse: matchMedia('(pointer: coarse)').matches,
          }));
          assert.ok(measure.overflow <= 1, JSON.stringify(measure));
          for (const input of measure.inputs) assert.ok(input.font >= 16, 'input zoom risk: ' + JSON.stringify(input));
          if (measure.coarse) for (const label of measure.labels) assert.ok(label.height >= 44, 'small touch target: ' + JSON.stringify(label));
          return measure;
        };
        await check('six-page layout, controls and screenshots', async () => {
          await open();
          for (const name of ['today', 'study', 'games', 'library', 'stats', 'me']) {
            await tab(name);
            await page.screenshot({ path: path.join(OUT, variant.name + '-' + name + '.png'), fullPage: true });
            await layout();
          }
        });
        await check('recorded achievement explains 39 due cards separately from 88% current progress', async () => {
          await open('goal-recorded'); await tab('today');
          assert.match(await page.locator('#goal-status-note').innerText(), /今日已达标，当前仍有 39 张到期卡片/);
          await page.getByRole('img', { name: '当前任务完成度 88%', exact: true }).waitFor();
          assert.match(await page.locator('#main').innerText(), /复习 67 \/ 106/);
          assert.match(await page.locator('#start-study').innerText(), /39 张/);
          assert.equal(await page.locator('#start-study').isEnabled(), true);
          await layout();
          await page.screenshot({ path: path.join(OUT, variant.name + '-goal-recorded.png'), fullPage: true });
        });
        await check('settings recommendation, saved value and refresh', async () => {
          await open(); await tab('me');
          assert.equal(await page.locator('#st-stepdays').inputValue(), '7');
          await page.locator('#st-recommend').click();
          await page.waitForFunction(() => document.querySelector('#st-stepdays')?.value === '1');
          await page.locator('#st-stepdays').fill('1'); await page.locator('#st-pause-new').uncheck();
          await page.locator('#st-save').click(); await page.reload();
          await page.waitForFunction(async (v) => (await import('./js/store.js?v=' + v)).state.load.phase === 'ready', VERSION);
          await tab('me'); assert.equal(await page.locator('#st-stepdays').inputValue(), '1');
          assert.equal(await page.locator('#st-pause-new').isChecked(), false,
            JSON.stringify(await page.evaluate(() => ({ saved: window.__QA.snapshot().settings, active: document.activeElement?.id, keyboard: document.body.classList.contains('kbd') }))));
          // Blur number input before returning to fixed navigation (the mobile keyboard hides it).
          await page.locator('#st-stepdays').focus();
          if (variant.options.hasTouch) assert.equal(await page.locator('.tabbar').isVisible(), false);
          await page.locator('#st-stepdays').blur();
          await page.locator('.tabbar').waitFor({ state: 'visible' });
          assert.equal(await page.locator('.tabbar').isVisible(), true);
        });
        await check('review UI updates live, preserves settings, pauses safely and retries failed word', async () => {
          await open('review'); await tab('me');
          await page.locator('#st-new').fill('9'); await page.locator('#st-new').blur();
          await page.locator('#me-review-all').click();
          await page.waitForFunction(() => window.__reviewMock.calls === 1);
          assert.match(await page.locator('#review-panel').innerText(), /复核中/);
          assert.equal(await page.locator('#me-review-all').isDisabled(), true);
          assert.equal(await page.locator('#st-new').inputValue(), '9');
          await page.locator('#me-review-pause').click();
          assert.match(await page.locator('#review-panel').innerText(), /正在暂停/);
          assert.equal(await page.locator('#me-review-all').isDisabled(), true);
          await page.evaluate(() => window.__reviewMock.releases.shift()());
          await page.waitForFunction(() => document.querySelector('#review-panel').textContent.includes('已暂停'));
          assert.match(await page.locator('#review-panel').innerText(), /1 \/ 12 个词条/);
          await page.evaluate(() => { window.__reviewMock.mode = 'error'; });
          await page.locator('#me-review-all').click();
          await page.waitForFunction(() => document.querySelector('#review-panel').textContent.includes('模型请求失败'));
          assert.match(await page.locator('#review-panel').innerText(), /1 \/ 12 个词条/);
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lexiloop.reviewJob')).cursor), 1);
          await page.evaluate(() => { window.__reviewMock.mode = 'success'; });
          await page.locator('#me-review-all').click();
          await page.waitForFunction(() => document.querySelector('#review-hint').textContent === '已完成');
          assert.match(await page.locator('#review-panel').innerText(), /12 \/ 12 个词条/);
          assert.equal(await page.locator('#st-new').inputValue(), '9');
          assert.equal(await page.locator('#me-review-pause').count(), 0);
          await layout();
        });
        if (variant.full) {
          await check('daily focus runs end-to-end without changing FSRS or daily reviews', async () => {
            await open(); await tab('games');
            const before = await page.evaluate(() => window.__QA.snapshot());
            await page.locator('#g-focus').click();
            assert.ok(await page.locator('#focus-reveal').count(), 'focus recall did not open');
            for (let n = 0; n < 4 && await page.locator('#focus-reveal').count(); n++) {
              if (n === 0) {
                await page.locator('#focus-hint').click();
                await page.locator('#focus-reveal').click();
                assert.equal(await page.locator('[data-focus-recall=independent]').isDisabled(), true);
                await page.locator('[data-focus-recall=hinted]').click();
              } else {
                await page.locator('#focus-reveal').click();
                await page.locator('[data-focus-recall=independent]').click();
              }
            }
            assert.ok(await page.locator('[data-focus-choice]').count(), 'choice stage not reached');
            for (let n = 0; n < 8 && await page.locator('[data-focus-choice]').count(); n++) {
              await page.locator('[data-focus-choice]').first().click();
              await page.locator('#focus-next').click();
            }
            await page.locator('#focus-memory-hide').click();
            for (let n = 0; n < 3; n++) {
              await page.locator('[data-focus-memory]').first().click();
              await page.locator('#focus-memory-next').click();
            }
            await page.locator('#focus-response').fill('Thank you for contacting us. I will check the details and explain the next steps.');
            await page.locator('#focus-scenario-done').click();
            await page.getByText('本次训练完成').waitFor();
            const after = await page.evaluate(() => window.__QA.snapshot());
            assert.deepEqual(after.cards, before.cards);
            assert.deepEqual(after.reviews, before.reviews);
            assert.deepEqual(after.stats, before.stats);
            assert.deepEqual(after.events, before.events);
            const report = await page.evaluate(() =>
              Object.keys(localStorage).filter((k) => k.startsWith('lexiloop.focus.history.v1.')).map((k) => JSON.parse(localStorage.getItem(k))));
            assert.equal(report.length, 1);
            assert.equal(report[0].length, 1);
            assert.equal(report[0][0].memoryTotal, 3);
            await page.locator('#focus-home').click();
            await page.getByText(/本机近 7 天：1 次/).waitFor();
            await layout();
          });
          await check('daily cap survives repeated entry and browser reload', async () => {
            await open('quota'); await tab('study');
            for (let i = 0; i < 2; i++) { await page.locator('#ans-reveal,#reveal').first().click(); await page.locator('[data-g="1"]').click(); await pause(400); }
            await page.getByText('已达到今日作答上限', { exact: true }).waitFor();
            const count = await page.evaluate(() => window.__QA.snapshot().reviews.length);
            assert.equal(count, 2);
            await page.reload();
            await page.locator('#start-study:disabled').waitFor();
            await tab('study'); await page.getByText('已达到今日作答上限', { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => window.__QA.snapshot().reviews.length), 2);
          });
          await check('failed new card requires successful short consolidation before one day', async () => {
            await open('learning');
            const answer = async (grade, reveal) => {
              await tab('today'); await page.locator('#start-study').click();
              if (reveal) await page.locator('#ans-reveal,#reveal').first().click();
              else await page.locator('#ans-check').click();
              const buttons = page.locator('[data-g]');
              if (!await buttons.count()) throw Error('No grade controls');
              await page.locator('[data-g="' + grade + '"]').click(); await pause(400);
            };
            await answer(1, true);
            const next = async () => {
              await page.evaluate(async (v) => {
                const S = await import('./js/store.js?v=' + v);
                const due = Math.min(...S.state.cards.map((c) => c.due)); window.__QA.advance(Math.max(0, due - Date.now()) + 1000);
              }, VERSION);
            };
            await next(); await answer(1, true);
            await next();
            await answer(3, false);
            let card = await page.evaluate(() => window.__QA.snapshot().cards[0]);
            assert.equal(card.status, 'learning');
            assert.ok(Math.abs(new Date(card.due) - new Date(card.last_review_at) - 600000) < 1500);
            await next(); await answer(3, false);
            card = await page.evaluate(() => window.__QA.snapshot().cards[0]);
            assert.equal(card.status, 'review');
            assert.ok(Math.abs(new Date(card.due) - new Date(card.last_review_at) - 86400000) < 1500);
            await page.reload();
            await page.waitForFunction(async (v) => (await import('./js/store.js?v=' + v)).state.load.phase === 'ready', VERSION);
            assert.equal(await page.evaluate(async (v) => (await import('./js/store.js?v=' + v)).state.cards[0].status, VERSION), 'review');
          });
          await check('overdue pause, settings opt-out and automatic recovery', async () => {
            await open('overdue');
            await page.getByText(/跨日逾期卡/).waitFor();
            assert.equal(await page.evaluate(async (v) => (await import('./js/store.js?v=' + v)).newAllowance(), VERSION), 0);
            await tab('me'); await page.locator('#st-pause-new').uncheck(); await page.locator('#st-save').click();
            assert.ok(await page.evaluate(async (v) => (await import('./js/store.js?v=' + v)).newAllowance(), VERSION) > 0);
          });
          await check('1205 cards are hydrated through three SDK pages', async () => {
            await open('large');
            const snapshot = await page.evaluate(async (v) => {
              const S = await import('./js/store.js?v=' + v); return { cards: S.state.cards.length, words: S.state.words.length, ranges: window.__QA.snapshot().ranges };
            }, VERSION);
            assert.equal(snapshot.cards, 1205); assert.equal(snapshot.words, 1205);
            assert.deepEqual(snapshot.ranges.filter((r) => r.table === 'cards').map((r) => r.from), [0, 500, 1000]);
          });
        }
        await check('no uncaught page errors, external requests or cloud calls', async () => {
          assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(fixture.audit.cloudRequests, []);
        });
      } catch (error) { results.push({ device: variant.name, name: 'browser setup', pass: false, error: error.stack }); }
      finally { if (context) await context.close(); if (browser) await browser.close(); }
    }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    const summary = { version: VERSION, scope: 'actual Chromium/WebKit, synthetic SDK and loopback only; iOS profiles are emulation, not physical devices',
      pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length, results };
    fs.writeFileSync(path.join(OUT, 'browser-results.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, out: OUT }));
    if (summary.fail) process.exitCode = 1;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
