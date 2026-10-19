'use strict';
/* LexiLoop · 生成质量闸门质检
 *
 * 背景（2026-10-10 全库扫描实测）：AI 为了凑出"搭配"会给名词硬造动词用法 ——
 * statement→statemented、screwdriver→screwdrivered、vinegar→vinegared、
 * sentinel→sentineled，甚至整词虚构（deplenish）。
 * 本套件验证**新导入的词不会再产生这类内容**：
 *   ① validatePayload 能拦下虚构动词形
 *   ② 不误伤合法的动词屈折（tarnish→tarnished）
 *   ③ 校验结果能落到数据库列（而不只是躺在 JSON 里）
 *   ④ 界面能显示"待审核"
 *
 * 用法：node tools/qa-enrich.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = path.resolve(__dirname, '..', 'lexiloop');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const out = [];
const add = (n, p, d) => { out.push({ n: n, pass: !!p, d: p ? '' : String(d == null ? '' : d) }); };

function mk(term, pos, exEn, pat) {
  return {
    lemma: term,
    senses: [{ pos: pos, def_zh: '释义' }],
    collocations: [{
      pattern: pat || (term + ' something'),
      examples: [{ en: exEn, zh: '例句' }],
    }],
  };
}

(async () => {
  /* enrich.js 依赖 cloud.js 等模块，且 import 路径带 ?v=NN 缓存参数。
     复制整个 js 目录、去掉版本参数、声明为 ESM，才能在 Node 里直接加载被测函数。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gll-enrich-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of fs.readdirSync(path.join(APP, 'js'))) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(APP, 'js', f), 'utf8').replace(/\?v=\d+/g, '');
    fs.writeFileSync(path.join(dir, f), src);
  }
  const E = await import(pathToFileURL(path.join(dir, 'enrich.js')).href);
  fs.rmSync(dir, { recursive: true, force: true });

  const V = E.validatePayload;
  add('validatePayload 已导出', typeof V === 'function');

  /* ── ① 必须拦下的（实测发现过的真实案例） ── */
  const bad = [
    ['statement', 'noun', 'The witness statemented the facts to the jury.', 'statement (something) to (someone)'],
    ['screwdriver', 'noun', 'He screwdrivered the screw into the wall.', 'screwdriver (a) (screw)'],
    ['vinegar', 'noun', 'The chef vinegared the onions before adding them.', 'vinegar (something)'],
    ['sentinel', 'noun', 'The guardian sentineled the sacred temple for centuries.', 'sentinel (something)'],
    ['fleet', 'noun', 'He fleeted his time away on idle pursuits.', 'fleet (one\'s) time'],
    ['council', 'noun', 'The lawyer counciled her to remain silent.', 'council (someone) to (do something)'],
    ['socket', 'noun', 'The surgeon socketed the joint back into place.', 'socket a joint'],
  ];
  bad.forEach((c) => {
    const r = V(mk(c[0], c[1], c[2], c[3]), c[0]);
    add('拦下虚构动词：' + c[0], r.ok === false && r.problems.some((p) => /当动词用/.test(p)),
      JSON.stringify(r));
  });

  /* ── ② 不得误伤（真实存在的用法） ── */
  const good = [
    ['tarnish', 'verb', 'The scandal tarnished his reputation.', 'tarnish (one\'s) reputation'],
    ['abduct', 'verb', 'The rebels abducted two aid workers.', 'abduct (someone)'],
    ['council', 'noun', 'The student council approved the new budget.', 'the student council'],
    ['vinegar', 'noun', 'Add a splash of vinegar to the dressing.', 'a splash of vinegar'],
    ['grill', 'verb', 'The reporters grilled the CEO on the results.', 'grill (someone)'],
  ];
  good.forEach((c) => {
    const r = V(mk(c[0], c[1], c[2], c[3]), c[0]);
    add('不误伤正常内容：' + c[0], r.ok === true, JSON.stringify(r));
  });

  /* ── ③ 结构缺失与脱节 ── */
  add('缺搭配时报错', V({ lemma: 'x', senses: [{ pos: 'noun', def_zh: 'x' }], collocations: [] }, 'x').ok === false);
  add('缺义项时报错', V({ lemma: 'x', senses: [], collocations: [{ pattern: 'x', examples: [{ en: 'x' }] }] }, 'x').ok === false);
  const off = V(mk('council', 'noun', 'The committee approved the budget.', 'the student council'), 'council');
  add('例句与词条脱节时报错', off.ok === false && off.problems.some((p) => /找不到/.test(p)), JSON.stringify(off));
  add('短语词条不误报动词形（不适用该规则）',
    V(mk('deal with', 'verb', 'I dealt with it.', 'deal with (something)'), 'deal with').ok === true);

  /* ── ⑤ 待审核内容不进学习队列（用户明确要求） ── */
  const store = read('js/store.js');
  const views = read('js/views.js');
  add('isBlockedWord 已导出', /export function isBlockedWord/.test(store));
  add('★ 学习队列的公共入口 inScope 已过滤待审核',
    /if \(isBlockedWord\(wordOf\(card\)\)\) return false/.test(store));
  add('★ 练习场各模式都过滤（否则会绕过闸门）',
    (read('js/game.js').match(/S\.isBlockedWord\(w\)/g) || []).length >= 4,
    '命中 ' + (read('js/game.js').match(/S\.isBlockedWord\(w\)/g) || []).length + ' 处');
  add('实验室也过滤', /S\.isBlockedWord\(w\)/.test(read('js/labs.js')));
  add('界面会告知有哪些词被挡（含原因）',
    /待审核内容/.test(views) && /已从学习与练习队列中排除/.test(views));
  /* 2026-10-15 起：除了 flagged/suspect，**内容缺失（无释义且无搭配）也挡** ——
     用户实测遇到"回想它的搭配与例句"却一条搭配都没有的空壳卡
     （来源：导入词单的分组标题/主题名被当成词条）。 */
  add('★ blockReason 已导出（两种原因分开）', /export function blockReason/.test(store));
  add('★ 内容缺失也挡：无释义且无搭配 → empty',
    /if \(!senses\.length && !colls\.length\) return 'empty'/.test(store));
  add('★ 原因文案把"待核验 / 内容缺失"分开说',
    /内容待核验/.test(views) && /内容缺失/.test(views) && /重新生成/.test(views));
  add('非空内容的未核验 / 已修正仍可学（没把整库关掉）',
    /return ''/.test(store) && /corrected/.test(store));

  /* ── ⑥ 内容复核功能（可重复触发，替代不可行的规则） ── */
  const enrich = read('js/enrich.js');
  add('reviewTerm 已导出', /export async function reviewTerm/.test(enrich));
  add('复核提示与生成提示分开（挑毛病 vs 产出）', /export const REVIEW_SYSTEM_PROMPT/.test(enrich));
  add('★ severity 分三档 none/advisory/blocking',
    /severity":"none\|advisory\|blocking/.test(enrich) &&
    /'none', 'advisory', 'blocking'/.test(enrich));
  add('复核任务可启动 / 暂停 / 查状态',
    /export async function startReview/.test(views) && /export function pauseReview/.test(views) &&
    /export function reviewStatus/.test(views));
  add('★ 复核只写核验标记，不动 payload',
    /verification_status: status, verify_note: note \|\| null/.test(store));
  add('「我的」页有复核入口（两个范围 + 暂停）',
    /id="me-review-learned"/.test(views) && /id="me-review-all"/.test(views) && /id="me-review-pause"/.test(views));
  add('★ blocking 才挡学习，advisory 只记录',
    /r\.severity === 'blocking'/.test(views) && /r\.severity === 'advisory'/.test(views));
  add('复核不把"没发现问题"写成"已核验"',
    /severity=none 且无缺义项/.test(views));

  /* ── ④ 落库与显示（契约） ── */
  add('putWord 把校验结果同步到独立列', /row\.verification_status = payload\.verification_status/.test(store) &&
    /row\.verify_note = payload\.verify_note/.test(store));
  add('★ 无校验结论时不覆盖已有标记（重新生成不会冲掉 corrected）',
    /if \(payload && payload\.verification_status\) \{/.test(store));
  add('界面能显示 suspect 状态', /st === 'suspect'/.test(views) && /生成校验未通过/.test(views));
  add('生成流程已调用校验', /const check = validatePayload\(data, term\)/.test(read('js/enrich.js')));
  add('校验失败会写入 verification_status', /data\.verification_status = 'suspect'/.test(read('js/enrich.js')));
  add('校验结果同时进入 notes（用户能看到原因）', /形态校验：/.test(read('js/enrich.js')));

  let bad2 = 0;
  out.forEach((o) => { if (!o.pass) bad2++; console.log((o.pass ? '  PASS  ' : '  FAIL  ') + o.n + (o.pass ? '' : '  → ' + o.d)); });
  console.log('\n===== 生成质量闸门质检: ' + (out.length - bad2) + '/' + out.length + ' 通过' +
    (bad2 ? ('，' + bad2 + ' 项失败') : '，全部通过') + ' =====');
  process.exit(bad2 ? 1 : 0);
})();
