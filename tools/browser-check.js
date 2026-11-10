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
        await check('screenshot noun-number answers receive positive guidance without AI or an Again suggestion', async () => {
          for (const [scenario,given] of [['noun-number','hotel amenity'],['campus-number','campus operation']]) {
            await open(scenario); await tab('today'); await page.locator('#start-study').click();
            await page.locator('#ans-in').fill(given); await page.locator('#ans-go').click();
            assert.match(await page.locator('.verdict.good').innerText(),/表达思路成立/);
            assert.equal(await page.locator('[data-g="1"].sug').count(),0);
            assert.equal(await page.locator('[data-g="3"].sug').count(),1);
            assert.equal(await page.evaluate(() => window.__reviewMock.calls),0);
            await pause(400); await page.locator('[data-g="3"]').click();
            await page.waitForFunction(() => window.__QA.snapshot().reviews.length === 1);
            const review=await page.evaluate(() => window.__QA.snapshot().reviews[0]);
            assert.equal(review.grade,3);assert.equal(review.verdict,'alt');await layout();
          }
        });
        await check('existing feat card starts with a repaired noun example and accepts feat', async () => {
          await open('feat-reference'); await tab('today'); await page.locator('#start-study').click();
          assert.match(await page.locator('body').innerText(), /was a remarkable ________/);
          assert.doesNotMatch(await page.locator('body').innerText(), /He ________ a remarkable goal/);
          await page.locator('#ans-in').fill('feat'); await page.locator('#ans-go').click();
          await page.locator('.verdict.good').waitFor();
          assert.equal(await page.evaluate(() => window.__reviewMock.calls), 0);
          assert.equal(await page.evaluate(() => window.__QA.snapshot().reviews.length), 0);
        });
        await check('unsafe reference skips without FSRS, review or quota writes', async () => {
          await open('coaching'); await page.evaluate(() => { window.__reviewMock.mode = 'reference-invalid'; });
          const before = await page.evaluate(() => JSON.stringify(window.__QA.snapshot().cards));
          await tab('today'); await page.locator('#start-study').click();
          await page.locator('#ans-in').fill('deserve'); await page.locator('#ans-go').click();
          await page.locator('#study-skip-reference').waitFor();
          assert.equal(await page.locator('[data-g]').count(),0);
          assert.equal(await page.locator('#study-details').count(),0);
          await page.locator('#study-skip-reference').click();
          assert.equal(await page.evaluate(() => window.__QA.snapshot().reviews.length),0);
          assert.equal(await page.evaluate(() => JSON.stringify(window.__QA.snapshot().cards)),before);
          const reviewed=await page.evaluate(async v => (await import('./js/store.js?v='+v)).dailyReviewed(), VERSION);
          assert.equal(reviewed,0); await layout();
        });
        await check('quality scan offers sourced liver repair with complete preview and preserves scheduling', async () => {
          await open('quality'); await tab('me');
          const before = await page.evaluate(() => JSON.stringify(window.__QA.snapshot().cards));
          const scan=page.locator('.content-quality-scan'); await scan.locator('summary').click();
          await page.locator('[data-quality-word="1"]').click();
          assert.match(await page.locator('#word-fix-source').inputValue(),/oxfordlearnersdictionaries/);
          await page.locator('#word-fix-preview').click();
          assert.match(await page.locator('.modal').innerText(),/完整原内容与修正内容/);
          await page.locator('[data-x=yes]').click();
          await page.waitForFunction(() => window.__QA.snapshot().words[0].verification_status === 'corrected');
          const row=await page.evaluate(() => window.__QA.snapshot().words[0]);
          assert.equal(row.payload.senses[0].pos,'noun'); assert.equal(row.payload.correction_history.length,1);
          assert.equal(await page.evaluate(() => JSON.stringify(window.__QA.snapshot().cards)),before);
          assert.equal(await page.evaluate(() => window.__QA.snapshot().reviews.length),0);
          await layout();
        });
        await check('cloze inflection feedback preserves verdict and shows safe full-sentence evidence', async () => {
          await open();
          const result = await page.evaluate(async v => {
            const V = await import('./js/views.js?v=' + v);
            const J = await import('./js/judge.js?v=' + v);
            const sentence = 'The bank ________ my account without notice.';
            const a = {given:'deduct money from',expected:'deducted money from',sentence,verdict:'wrong',ok:false};
            const element = document.createElement('div'); element.innerHTML = V.verdictHTML(a);
            const html = V.verdictHTML({...a,sentence:'<img src=x onerror=alert(1)> ________'});
            return {text:element.textContent,verdict:a.verdict,local:J.judgeTyped(a.given,a.expected).verdict,
              safe:!/<img src=x/.test(html),alt:V.verdictHTML({...a,given:'deducts money from',verdict:'alt',ok:true}),
              unsure:V.verdictHTML({...a,verdict:'unsure'}),
              article:V.verdictHTML({expected:'have jurisdiction over',given:'have the jurisdiction over',verdict:'unsure'})};
          }, VERSION);
          assert.match(result.text, /已想起目标表达/);
          assert.match(result.text, /The bank deduct money from my account without notice/);
          assert.match(result.text, /The bank deducted money from my account without notice/);
          assert.equal(result.verdict, 'wrong'); assert.equal(result.local, 'unsure'); assert.equal(result.safe, true);
          assert.match(result.alt, /你的表达也对/); assert.match(result.unsure, /不算你错/); assert.match(result.article, /冠词需要结合语境判断/);
        });
        await check('study details start collapsed and grading stays reachable while details expand', async () => {
          await open('learning'); await tab('today'); await page.locator('#start-study').click();
          await page.locator('#ans-reveal,#reveal').first().click();
          const details = page.locator('#study-details');
          assert.equal(await details.getAttribute('open'), null);
          const bar = page.locator('.study-grade-bar');
          await details.locator('summary').first().click(); assert.notEqual(await details.getAttribute('open'), null);
          const box = await bar.boundingBox();
          assert.ok(box && box.y >= 0 && box.y + box.height <= variant.options.viewport.height, JSON.stringify(box));
          const nav = await page.locator('.tabbar').boundingBox();
          if (variant.options.viewport.width < 760) assert.ok(box.y + box.height <= nav.y + 1, JSON.stringify({box,nav}));
          await details.locator('summary').first().click();
          // The lowest optional control must be reachable above the fixed bar, even with details closed.
          const reachable = async () => {
            // Native scrollIntoView ignores fixed overlays. Exercise the user's scroll-to-end path.
            await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
            await pause(100);
            return page.evaluate(() => {
              const e = document.querySelector('#mine-go'), b = document.querySelector('.study-grade-bar');
              const r = e.getBoundingClientRect(), bar = b.getBoundingClientRect();
              return { bottom:r.bottom, top:bar.top, fixed:getComputedStyle(b).position === 'fixed',
                exposed:e.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)),
                reserve:parseFloat(getComputedStyle(document.querySelector('#main')).paddingBottom),
                need:innerHeight - bar.top };
            });
          };
          for (const expanded of [false, true]) {
            if (expanded) await details.locator('summary').first().click();
            const r = await reachable();
            assert.ok(r.exposed, JSON.stringify(r));
            if (r.fixed) { assert.ok(r.bottom <= r.top, JSON.stringify(r)); assert.ok(r.reserve >= r.need, JSON.stringify(r)); }
          }
          await tab('today');
          assert.equal(await page.locator('#main').evaluate(e => e.style.getPropertyValue('--study-grade-clearance')), '');
          await tab('study');
          await page.locator('#ans-reveal,#reveal').first().click();
          await page.locator('[data-g="1"]').click(); await pause(400);
          assert.equal(await page.evaluate(() => window.__QA.snapshot().reviews.length), 1);
          const review = await page.evaluate(() => window.__QA.snapshot().reviews[0]);
          const observation = review.prev_state.learning_observation;
          assert.equal(observation.version, 1);
          assert.equal(review.elapsed_ms, observation.response_ms + observation.feedback_ms);
          await tab('me');
          const downloaded = page.waitForEvent('download');
          await page.locator('#me-reviews').click();
          const download = await downloaded;
          const csv = fs.readFileSync(await download.path(), 'utf8');
          assert.match(csv, /source,verdict,hinted,assisted/);
          assert.match(csv, /study_wall_v1/);

          // This interaction consumes the one-card learning fixture. Leave later tests a fresh fixture.
          await page.evaluate(() => localStorage.removeItem('__lexiloop_fixture_learning'));
        });
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
          await page.waitForFunction(() => window.__reviewMock.calls === 2);
          assert.match(await page.locator('#review-panel').innerText(), /复核中/);
          assert.equal(await page.locator('#me-review-all').isDisabled(), true);
          assert.equal(await page.locator('#st-new').inputValue(), '9');
          await page.locator('#me-review-pause').click();
          assert.match(await page.locator('#review-panel').innerText(), /正在暂停/);
          assert.equal(await page.locator('#me-review-all').isDisabled(), true);
          await page.evaluate(() => window.__reviewMock.releases.splice(0).forEach(release => release()));
          await page.waitForFunction(() => document.querySelector('#review-panel').textContent.includes('已暂停'));
          assert.match(await page.locator('#review-panel').innerText(), /2 \/ 12 个词条/);
          await page.evaluate(() => { window.__reviewMock.mode = 'error'; });
          await page.locator('#me-review-all').click();
          await page.waitForFunction(() => document.querySelector('#review-panel').textContent.includes('模型请求失败'));
          assert.match(await page.locator('#review-panel').innerText(), /2 \/ 12 个词条/);
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('lexiloop.reviewJob.')))).cursor), 2);
          await page.evaluate(() => { window.__reviewMock.mode = 'success'; });
          await page.locator('#me-review-all').click();
          await page.waitForFunction(() => document.querySelector('#review-hint').textContent === '已完成');
          assert.match(await page.locator('#review-panel').innerText(), /12 \/ 12 个词条/);
          assert.equal(await page.locator('#st-new').inputValue(), '9');
          assert.equal(await page.locator('#me-review-pause').count(), 0);
          const calls = await page.evaluate(() => window.__reviewMock.calls);
          await page.locator('#me-review-all').click();
          await page.waitForFunction(() => document.querySelector('#review-hint').textContent === '已完成');
          await page.waitForFunction(() => document.querySelector('#review-panel').textContent.includes('有效缓存跳过 12 条'));
          assert.equal(await page.evaluate(() => window.__reviewMock.calls), calls, 'unchanged entries were reviewed again');
          assert.match(await page.locator('#review-panel').innerText(), /有效缓存跳过 12 条/);
          await layout();
        });
        await check('review report and human correction preserve cards, persist a before-version and survive refresh', async () => {
          await open('review'); await tab('library');
          const before = await page.evaluate(() => window.__QA.snapshot().cards);
          await page.locator('[data-word]').first().click();
          await page.locator('#word-review-report').waitFor();
          await page.locator('#wd-edit').click();
          await page.locator('#word-fix-1').fill('安排后续预约（合成核对）');
          await page.locator('#word-fix-source').fill('Isolated synthetic reference');
          await page.locator('#word-fix-preview').click();
          await page.getByRole('button', { name: '确认保存修正', exact: true }).click();
          await page.waitForFunction(() => window.__QA.snapshot().words.some(w => w.verification_status === 'corrected'));
          const after = await page.evaluate(() => window.__QA.snapshot());
          assert.deepEqual(after.cards, before);
          const corrected = after.words.find(w => w.verification_status === 'corrected');
          assert.equal(corrected.payload.correction_history.length, 1);
          assert.equal(corrected.payload.correction_source, 'Isolated synthetic reference');
          await page.reload();
          await page.waitForFunction(async v => (await import('./js/store.js?v=' + v)).state.load.phase === 'ready', VERSION);
          await tab('library'); await page.locator('[data-word]').first().click();
          assert.match(await page.locator('#modal-wrap').innerText(), /安排后续预约（合成核对）/);
          await layout();
        });
        await check('study service failure offers retry and accepts a semantic alternative without a duplicate review', async () => {
          await open('semantic');
          await page.evaluate(() => { window.__reviewMock.mode = 'invalid'; });
          await tab('today'); await page.locator('#start-study').click();
          await page.locator('#ans-in').fill('arrange a follow-up visit'); await page.locator('#ans-go').click();
          await page.locator('#ans-review-retry').waitFor();
          assert.match(await page.locator('.verdict').innerText(), /回复格式异常/);
          assert.equal(await page.evaluate(() => window.__QA.snapshot().reviews.length),0);
          await page.evaluate(() => { window.__reviewMock.mode = 'semantic-alt'; });
          await page.locator('#ans-review-retry').click();
          await page.getByText(/你的表达也对/).waitFor();
          assert.equal(await page.evaluate(() => window.__reviewMock.calls),2);
          await page.locator('[data-g="3"]').click(); await pause(400);
          const rows = await page.evaluate(() => window.__QA.snapshot().reviews);
          assert.equal(rows.length,1); assert.equal(rows[0].verdict,'alt');
          assert.equal(rows[0].prev_state.learning_observation.review_reason,'reviewed');
          await layout();
        });
        await check('alternative-word inflection gets specific coaching, guided correction and one original review', async () => {
          await open('coaching');
          await page.evaluate(() => { window.__reviewMock.mode = 'coaching'; });
          await tab('today'); await page.locator('#start-study').click();
          await page.locator('#ans-in').fill('deserve'); await page.locator('#ans-go').click();
          await page.getByText(/选词思路成立/).waitFor();
          assert.match(await page.locator('.verdict').innerText(), /evidence/);
          assert.equal(await page.locator('[data-g="2"]').getAttribute('class'),'sug');
          assert.notEqual(await page.locator('[data-g="1"]').getAttribute('class'),'sug');
          await page.getByText('试着修正一次（可选）', {exact:true}).click();
          await page.locator('#ans-practice').fill('deserves'); await page.locator('#ans-practice-check').click();
          await page.getByText(/已按反馈完成修正/).waitFor();
          assert.equal(await page.evaluate(() => window.__QA.snapshot().reviews.length),0);
          await page.locator('[data-g="2"]').click(); await pause(400);
          const rows = await page.evaluate(() => window.__QA.snapshot().reviews);
          assert.equal(rows.length,1);assert.equal(rows[0].verdict,'wrong');assert.equal(rows[0].grade,2);
          assert.equal(rows[0].prev_state.learning_observation.corrected_with_feedback,true);
          await layout();
        });
        await check('transfer pilot completes through practice hub; hints and alternatives do not mutate learning', async () => {
          await open(); await tab('games');
          const before = await page.evaluate(() => window.__QA.snapshot());
          await page.locator('#g-transfer').click();
          const targets = await page.evaluate(async v => {
            const T = await import('./js/transfer.js?v=' + v); return T.transferPlan().map(g => ({target:g.target,alt:g.accept[0]}));
          }, VERSION);
          await page.locator('#transfer-answer').fill(targets[0].alt);
          await page.locator('#transfer-check').click();
          assert.match(await page.locator('.verdict').innerText(), /你的表达也成立/);
          await page.locator('#transfer-next').click();
          await page.locator('#transfer-hint').click();
          await page.locator('#transfer-answer').fill(targets[1].target);
          await page.locator('#transfer-check').click(); await page.locator('#transfer-next').click();
          await page.locator('#transfer-reveal').click();
          await page.locator('#transfer-next').click();
          await page.getByText('本轮练习完成', {exact:true}).waitFor();
          const after = await page.evaluate(() => window.__QA.snapshot());
          assert.deepEqual(after, before);
          const rows = await page.evaluate(() => Object.keys(localStorage).filter(k=>k.startsWith('lexiloop.transfer.v1.')).map(k=>JSON.parse(localStorage.getItem(k))));
          assert.equal(rows.length,1);assert.equal(rows[0].length,1);
          assert.deepEqual(rows[0][0].results.map(r=>r.hinted),[false,true,true]);
          await layout(); await page.locator('#transfer-home').click(); await page.locator('#g-transfer').waitFor();
        });
        if (variant.full) {
          await check('daily focus has one entry and runs end-to-end without changing FSRS or daily reviews', async () => {
            await open(); await tab('games');
            const before = await page.evaluate(() => window.__QA.snapshot());
            await page.locator('#g-pick').click();
            assert.equal(await page.locator('.mode-tile').count(), 8);
            assert.equal(await page.locator('.mode-tile').filter({ hasText: '每日综合训练' }).count(), 0);
            await page.locator('#mode-cancel').click();
            assert.equal(await page.locator('#g-focus').count(), 1);
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
