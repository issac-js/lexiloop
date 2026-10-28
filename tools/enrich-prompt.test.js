'use strict';
/* enrich 提示词回归：必须要求覆盖该词的全部常用词性。
 * 背景（2026-10-28）：线上抽样 20 条「缺义项」中，10 条为真缺，其中 6 条是
 * layer / detour / veto / sanction / fare / doodle 这类「另一种词性整条没写」。
 * 根因在生成阶段的提示词只限制了条数、没要求覆盖词性。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lexiloop', 'js', 'enrich.js'), 'utf8');

test('提示词要求覆盖该词的全部常用词性', () => {
  assert.ok(/cover every part of speech/i.test(SRC), '缺少「覆盖全部词性」的要求');
  assert.ok(/at least one sense per part of speech/i.test(SRC), '缺少「每个词性至少一条义项」的要求');
});

test('提示词要求 pos 与 senses 一致', () => {
  assert.match(SRC, /"pos" must list every part of speech that appears in "senses"/);
});

test('仍保留条数上限，避免提示词失控', () => {
  assert.match(SRC, /senses: at most 2/);
  assert.match(SRC, /collocations: 4 to 5 items/);
});

test('提示词要求搭配的 type/pattern 与词性一致', () => {
  assert.match(SRC, /MUST match the TARGET part of speech/, '缺少「搭配须与词性一致」的要求');
  assert.match(SRC, /never output a verb inflection or verb pattern/, '缺少「名词不得产出动词变形」的禁令');
});

test('提示词覆盖名词/动词两种目标的搭配形态', () => {
  assert.match(SRC, /noun collocations are noun phrases/, '缺少名词搭配形态说明');
  assert.match(SRC, /for a verb target, patterns must be verb patterns/, '缺少动词搭配形态说明');
});
