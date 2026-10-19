'use strict';
// Live QA: guarded database reads; existing-account login and one model request are opt-in.
const { run } = require('./lib/live-checks.js');

function validateState(state) {
  const arrays = !!state && state.phase === 'ready' && Array.isArray(state.cards) && Array.isArray(state.words);
  return { arrays, hydrated: arrays && (state.cards.length === 0 || state.words.length > 0) };
}

async function task({ cfg, cdp, add, skip, permitModelOnce }) {
  const result = await cdp.eval(`(async()=>{
    const S=await import(${JSON.stringify('./js/store.js?v=' + cfg.ver)});
    const C=await import(${JSON.stringify('./js/cloud.js?v=' + cfg.ver)});
    const settings=await C.db().from('settings').select('daily_new').limit(1);
    let goalsOk=false;try{const g=await S.fetchGoalDays();goalsOk=g!==null&&typeof g==='object';}catch{}
    let queueOk=false;try{queueOk=Array.isArray(S.buildQueue());}catch{}
    const registration=await navigator.serviceWorker.getRegistration();
    return {phase:S.state.load.phase,cards:Array.isArray(S.state.cards)?S.state.cards.map(()=>1):null,
      words:Array.isArray(S.state.words)?S.state.words.map(()=>1):null,
      settingsOk:Number.isFinite(S.state.settings.daily_new),settingsReadOk:!settings.error&&Array.isArray(settings.data),goalsOk,queueOk,
      sw:!!(registration&&(registration.active||registration.installing||registration.waiting))};
  })()`);
  const state = validateState(result);
  add('Synchronized card/word collections are valid (empty QA account allowed)', state.arrays);
  add('Card-referenced hydration is nonempty when cards exist', state.hydrated);
  add('Settings contain a finite daily_new', !!result?.settingsOk);
  add('Settings SELECT completed (an absent row is allowed)', !!result?.settingsReadOk);
  add('goal_days read completed', !!result?.goalsOk);
  add('buildQueue returns an array', !!result?.queueOk);
  add('Service Worker registration observed', !!result?.sw);
  if (cfg.allowModel) {
    permitModelOnce();
    const model = await cdp.eval(`(async()=>{
      const C=await import(${JSON.stringify('./js/cloud.js?v=' + cfg.ver)});
      try{const raw=await C.chatText({system:'Return only JSON.',user:'Return {"ok":true}.',json:true,temperature:0,maxTokens:30});
        return JSON.parse(raw)?.ok===true;}catch{return false;}
    })()`, 120000);
    add('Opt-in minimal model invocation returned expected JSON', model === true);
  } else skip('Model invocation', 'Not requested; set LEXILOOP_RUN_MODEL=1 to permit one billable POST');
  skip('Multi-page cards, answer writes and FSRS persistence', 'Not exercised by this read-focused tool');
  skip('Service Worker handoff, cache propagation and atomic deployment', 'Registration and final resources do not prove transition behavior');
}

if (require.main === module) run('qa-release-live', task).catch(() => { process.exitCode = 1; });
module.exports = { validateState, task };
