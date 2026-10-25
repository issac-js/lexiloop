// Runs inside actual Simulator Safari, with the same test-only loopback SDK as desktop tests.
const version = document.querySelector('script[src*="js/app.js"]').src.match(/v=(\d+)/)[1];
const S = await import('/js/store.js?v=' + version);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 300 && S.state.load.phase !== 'ready'; i++) await wait(100);
const trigger = document.createElement('button');
trigger.id = 'qa-run'; trigger.textContent = '运行兼容性复测';
trigger.style.cssText = 'position:fixed;top:3px;left:3px;z-index:9999;min-height:44px;background:white;color:black;border:1px solid black;';
document.body.appendChild(trigger);
trigger.onclick = async () => {
  trigger.remove();
  const results = [];
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const check = async (name, run) => {
    try { const detail = await run(); results.push({ name, pass: true, detail }); }
    catch (error) { results.push({ name, pass: false, error: String(error.stack || error) }); }
  };
  const tap = async (selector) => {
    const element = document.querySelector(selector); assert(element, 'Missing ' + selector); element.click(); await wait(150);
  };
  const reset = async (name) => {
    window.__QA.reset(name); S.state.user = { id: 'ios-fixture-' + name }; S.state.settings.day_plan = null;
    await S.syncPull(); window.__lexiloopRender(); await tap('[data-tab=today]');
  };
  await check('native Safari settings edit persisted as one day', () => {
    assert(window.__QA.snapshot().settings.extra.learn_step_days === 1, 'Native edit did not save');
  });
  await check('six pages fit Safari viewport and touch targets', async () => {
    const measurements = [];
    for (const tab of ['today', 'study', 'games', 'library', 'stats', 'me']) {
      await tap('[data-tab=' + tab + ']');
      const overflow = document.documentElement.scrollWidth - innerWidth;
      assert(overflow <= 1, tab + ' horizontal overflow: ' + overflow);
      const controls = [...document.querySelectorAll('input.input,select.input,textarea.input')].filter((e) => e.getBoundingClientRect().width);
      for (const e of controls) assert(parseFloat(getComputedStyle(e).fontSize) >= 16, 'Small input font: ' + e.id);
      for (const e of document.querySelectorAll('label.row')) if (e.querySelector('input[type=checkbox]')) assert(e.getBoundingClientRect().height >= 44, 'Small checkbox target: ' + e.textContent);
      measurements.push({ tab, width: innerWidth, height: innerHeight, overflow });
    }
    return measurements;
  });
  await check('real Safari DOM new-card failure and consolidation flow persists across sync', async () => {
    await reset('learning');
    const answer = async (grade, independent) => {
      await tap('[data-tab=today]'); await tap('#start-study');
      await tap(independent ? '#ans-check' : '#ans-reveal'); await tap('[data-g="' + grade + '"]'); await wait(400);
    };
    const advance = () => window.__QA.advance(Math.max(0, S.state.cards[0].due - Date.now()) + 1000);
    await answer(1, false); advance(); await answer(1, false); advance();
    await answer(3, true);
    let c = window.__QA.snapshot().cards[0];
    assert(c.status === 'learning' && Math.abs(new Date(c.due) - new Date(c.last_review_at) - 600000) < 1500, 'First success skipped 10 minutes');
    advance(); await answer(3, true); c = window.__QA.snapshot().cards[0];
    assert(c.status === 'review' && Math.abs(new Date(c.due) - new Date(c.last_review_at) - 86400000) < 1500, 'Second success did not schedule one day');
    await S.syncPull(); assert(S.state.cards[0].status === 'review', 'State did not survive fixture persistence');
  });
  await check('daily limit blocks re-entry; tomorrow restores allowance', async () => {
    await reset('quota');
    for (let i = 0; i < 2; i++) {
      await tap('[data-tab=study]'); await tap('#ans-reveal'); await tap('[data-g="1"]'); await wait(400);
    }
    assert(S.dailyReviewAllowance() === 0, 'Daily cap not exhausted');
    await tap('[data-tab=today]'); assert(document.querySelector('#start-study').disabled, 'Cap bypass via re-entry');
    assert(window.__QA.snapshot().reviews.length === 2, 'Wrong persisted review count');
    window.__QA.advance(86400000); assert(S.dailyReviewAllowance() === 2, 'No next-day quota reset');
  });
  await check('overdue pause and touch settings opt-out', async () => {
    await reset('overdue'); assert(S.newAllowance() === 0, 'New words allowed while overdue');
    await tap('[data-tab=me]'); await tap('#st-pause-new'); await tap('#st-save');
    assert(S.newAllowance() > 0, 'Opt-out did not restore new words');
    await tap('#st-pause-new'); await tap('#st-save');
    const overdue = S.overdueCards()[0]; overdue.due = Date.now() + 86400000;
    assert(S.newAllowance() > 0, 'Cleared backlog did not resume new words');
  });
  await tap('[data-tab=me]');
  const report = { version, scope: 'actual iOS Simulator Safari with synthetic SDK; not a physical iPhone or production gateway',
    userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight }, pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length, results };
  await fetch('/__qa/report', { method: 'POST', body: JSON.stringify(report) });
  const marker = document.createElement('div'); marker.textContent = report.fail ? 'IOS_QA_FAIL' : 'IOS_QA_PASS';
  marker.id = 'qa-result'; marker.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:white;color:black;padding:10px';
  document.body.appendChild(marker);
};
