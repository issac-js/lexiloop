'use strict';
// Guarded SELECT-only word-read checks, with explicit treatment of an empty database.
const { run } = require('./lib/live-checks.js');

function validateRead(result) {
  const limited = !!result && !result.limitError && Number.isInteger(result.rows) && result.rows >= 0 && result.rows <= 3;
  const counted = !!result && !result.countError && Number.isInteger(result.count) && result.count >= 0;
  return { limited, counted, consistent: limited && counted && result.rows <= result.count && (result.count === 0 || result.rows > 0),
    hydrated: result?.asked > 0 && !result.inError && result.idsMatch === true };
}

async function task({ cfg, cdp, add, skip }) {
  const result = await cdp.eval(`(async()=>{
    const C=await import(${JSON.stringify('./js/cloud.js?v=' + cfg.ver)});
    const a=await C.db().from('words').select('id').limit(3);
    const b=await C.db().from('words').select('id',{count:'exact',head:true});
    const result={limitError:!!a.error,rows:Array.isArray(a.data)?a.data.length:-1,countError:!!b.error,count:b.count,asked:0};
    if(!a.error&&Array.isArray(a.data)&&a.data.length){
      const ids=a.data.slice(0,2).map(w=>String(w.id));
      const c=await C.db().from('words').select('id').in('id',ids);
      const got=Array.isArray(c.data)?c.data.map(w=>String(w.id)):[];
      result.asked=ids.length;result.inError=!!c.error;
      result.idsMatch=got.length===ids.length&&new Set(got).size===new Set(ids).size&&ids.every(id=>got.includes(id));
    }
    return result;
  })()`, 120000);
  const checks = validateRead(result);
  add('Limited words SELECT succeeded', checks.limited);
  add('Exact count returned a nonnegative integer', checks.counted);
  add('Limited result is consistent with count', checks.consistent);
  if (checks.limited && result.rows === 0) skip('ID hydration', 'No rows available; this path remains untested');
  else add('ID hydration returned the exact requested IDs', checks.hydrated);
}

if (require.main === module) run('qa-words-read-live', task).catch(() => { process.exitCode = 1; });
module.exports = { validateRead, task };
