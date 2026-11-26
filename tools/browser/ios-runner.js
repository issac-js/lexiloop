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
    catch (error) { results.push({ name, pass: false, error: String(error.message || error) + '\n' + String(error.stack || '') }); }
  };
  const tap = async (selector) => {
    const element = document.querySelector(selector); assert(element, 'Missing ' + selector + '; budget=' + S.dailyReviewAllowance() + '; page=' + document.querySelector('#main')?.textContent.slice(0, 180)); element.click(); await wait(150);
  };
  const reset = async (name) => {
    window.__QA.reset(name); S.state.user = { id: 'ios-fixture-' + name }; S.state.settings.day_plan = null;
    await S.syncPull(); window.__lexiloopRender(); await tap('[data-tab=today]');
  };
  await check('native Safari settings edit persisted as one day', () => {
    const actual = window.__QA.snapshot().settings.extra.learn_step_days;
    assert(actual === 1, 'Native edit did not save: ' + actual);
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
  await check('workplace phone phrases, report and original card open on Safari', async () => {
    await reset('workplace-topics');
    const before = window.__QA.snapshot();
    await tap('[data-tab=library]'); await tap('[data-libview=topics]');
    await tap('[data-topic-open=traffic]');
    const copy = document.querySelector('[data-topic-copy="0"]');
    assert(document.querySelector('.topic-phrase p').textContent === 'Is anyone injured?', 'Injury question missing');
    assert(copy.getBoundingClientRect().height >= 44, 'Copy target too small');
    const report = document.querySelector('[data-topic-section=report]');
    assert(!report.open, 'Report expanded by default');
    await tap('[data-topic-section=report] > summary');
    assert(report.open, 'Report did not expand');
    assert(document.documentElement.scrollWidth <= innerWidth + 1, 'Workplace topic overflows');
    await tap('[data-topic-section=report] [data-topic-expression=collision]');
    await tap('#topic-open-word');
    assert(document.querySelector('.modal h3')?.textContent === 'collision', 'Original entry did not open');
    document.querySelector('#modal-wrap').click(); await tap('[data-libview=list]');
    const after = window.__QA.snapshot();
    assert(JSON.stringify([after.cards, after.reviews, after.words]) === JSON.stringify([before.cards, before.reviews, before.words]), 'Viewing changed learning data');
    await reset('normal');
  });
  await check('recorded achievement and 39 due cards are explained separately at 88% current progress', async () => {
    await reset('goal-recorded');
    const note = document.querySelector('#goal-status-note');
    assert(note && note.textContent.includes('今日已达标，当前仍有 39 张到期卡片'), 'Missing due-card explanation');
    assert(document.querySelector('svg[aria-label="当前任务完成度 88%"]'), 'Wrong current progress');
    assert(document.querySelector('#start-study').textContent.includes('39 张'), 'Due queue count differs');
    assert(document.documentElement.scrollWidth <= innerWidth + 1, 'Goal card overflows');
    await reset('normal');
  });
  await check('review panel updates without navigation, preserves settings and pauses safely', async () => {
    await tap('[data-tab=me]');
    const setting = document.querySelector('#st-new'); setting.value = '9';
    window.__reviewMock.mode = 'hold';
    await tap('#me-review-all');
    assert(document.querySelector('#review-panel').textContent.includes('复核中'), 'No live review progress');
    assert(document.querySelector('#me-review-all').disabled, 'Duplicate review allowed');
    assert(setting === document.querySelector('#st-new') && setting.value === '9', 'Settings were replaced');
    await tap('#me-review-pause');
    assert(document.querySelector('#review-panel').textContent.includes('正在暂停'), 'No pause feedback');
    window.__reviewMock.releases.splice(0).forEach(release => release()); await wait(150);
    assert(document.querySelector('#review-panel').textContent.includes('已暂停'), 'Pause did not finish');
    window.__reviewMock.mode = 'error'; await tap('#me-review-all');
    assert(document.querySelector('#review-panel').textContent.includes('模型请求失败'), 'Failure was hidden');
    window.__reviewMock.mode = 'success'; await tap('#me-review-all');
    for (let n = 0; n < 50 && document.querySelector('#review-hint').textContent !== '已完成'; n++) await wait(100);
    assert(document.querySelector('#review-hint').textContent === '已完成', 'Completion did not refresh');
  });
  await check('human correction shows a diff and preserves card scheduling', async () => {
    await tap('[data-tab=library]');
    const before = JSON.stringify(window.__QA.snapshot().cards);
    await tap('[data-word]');
    assert(document.querySelector('#word-review-report'), 'Missing persisted report');
    await tap('#wd-edit');
    document.querySelector('#word-fix-1').value = '安排后续预约（合成核对）';
    document.querySelector('#word-fix-source').value = 'Isolated Safari reference';
    await tap('#word-fix-preview'); await tap('[data-x=yes]');
    const snapshot = window.__QA.snapshot(), corrected = snapshot.words.find(w => w.verification_status === 'corrected');
    assert(corrected && corrected.payload.correction_history.length === 1, 'Correction history missing');
    assert(JSON.stringify(snapshot.cards) === before, 'Correction changed scheduling');
  });
  await check('transfer pilot has reachable controls and keeps scheduling unchanged', async () => {
    await reset('normal'); await tap('[data-tab=games]');
    const before = JSON.stringify(window.__QA.snapshot());
    await tap('#g-transfer');
    for (let n = 0; n < 3; n++) {
      await tap('#transfer-reveal');
      assert(document.documentElement.scrollWidth <= innerWidth + 1, 'Transfer overflow');
      const next = document.querySelector('#transfer-next');
      assert(next.getBoundingClientRect().height >= 44, 'Small transfer control');
      next.scrollIntoView({block:'center'}); await wait(100);
      const r = next.getBoundingClientRect();
      assert(next.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)), 'Transfer next covered');
      await tap('#transfer-next');
    }
    assert(document.querySelector('#main').textContent.includes('本轮练习完成'), 'No transfer completion');
    assert(JSON.stringify(window.__QA.snapshot()) === before, 'Pilot modified learning');
    await tap('#transfer-home');
  });
  await check('both screenshot number variations get positive local feedback and preserve self-grading', async () => {
    for (const [scenario,given] of [['noun-number','hotel amenity'],['campus-number','campus operation']]) {
      await reset(scenario); const calls=window.__reviewMock.calls;
      await tap('#start-study');document.querySelector('#ans-in').value=given;await tap('#ans-go');
      assert(document.querySelector('.verdict.good')?.textContent.includes('表达思路成立'),'Missing positive number guidance');
      assert(!document.querySelector('[data-g="1"].sug'),'Incorrect Again recommendation');
      assert(window.__reviewMock.calls===calls,'Unnecessary model call');await wait(400);await tap('[data-g="3"]');
      assert(window.__QA.snapshot().reviews[0]?.verdict==='alt','Accepted number variation stored as wrong');
    }
    await reset('normal');
  });
  await check('question reference rejection skips without writing review or scheduling', async () => {
    await reset('coaching'); window.__reviewMock.mode = 'reference-invalid';
    const before=JSON.stringify(window.__QA.snapshot().cards);
    await tap('#start-study'); document.querySelector('#ans-in').value='deserve'; await tap('#ans-go');
    for(let i=0;i<50&&!document.querySelector('#study-skip-reference');i++) await wait(100);
    assert(document.querySelector('#study-skip-reference'),'Missing ungraded skip');
    assert(!document.querySelector('[data-g]'),'Unsafe reference still has grading buttons');
    await tap('#study-skip-reference');
    assert(JSON.stringify(window.__QA.snapshot().cards)===before,'Scheduling changed on skip');
    assert(window.__QA.snapshot().reviews.length===0 && S.dailyReviewed()===0,'Skip consumed a review');
    await reset('normal');
  });
  await check('specific inflection coaching and correction stay reachable without duplicate review', async () => {
    await reset('coaching'); window.__reviewMock.mode = 'coaching';
    await tap('#start-study');
    document.querySelector('#ans-in').value = 'deserve'; await tap('#ans-go');
    for(let n=0;n<50 && !document.querySelector('#ans-practice');n++) await wait(100);
    assert(document.querySelector('.verdict').textContent.includes('选词思路成立'), 'Missing specific coach');
    assert(document.querySelector('[data-g="2"]').classList.contains('sug'), 'Wrong grade suggestion');
    const details = document.querySelector('#ans-practice').closest('details'); details.open = true;
    document.querySelector('#ans-practice').value = 'deserves';
    document.querySelector('#ans-practice').dispatchEvent(new Event('input')); await tap('#ans-practice-check');
    assert(document.querySelector('.verdict').textContent.includes('已按反馈完成修正'), 'Correction not retained');
    assert(window.__QA.snapshot().reviews.length===0, 'Practice created review');
    assert(document.documentElement.scrollWidth<=innerWidth+1, 'Coach overflows');
    await tap('[data-g="2"]'); await wait(400);
    const rows=window.__QA.snapshot().reviews;
    assert(rows.length===1 && rows[0].verdict==='wrong' && rows[0].prev_state.learning_observation.corrected_with_feedback===true, 'Original attempt lost');
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
    await tap('[data-tab=study]');
    for (let i = 0; i < 2; i++) {
      await tap('#ans-reveal'); await tap('[data-g="1"]'); await wait(400);
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
