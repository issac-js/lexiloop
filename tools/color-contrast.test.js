'use strict';
/* 对比度回归：styles.css 中的文字色令牌必须对各自背景 ≥ 4.5:1（WCAG 2.1 AA 正常文本）。
 * 背景（2026-10-28）：--ink-3 在浅色两套主题下只有 2.4–2.6:1，11px 底栏标签与说明文字都受影响。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'lexiloop', 'styles.css'), 'utf8');

function hex(value) {
  const m = String(value).trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function luminance(c) {
  const lin = [c.r, c.g, c.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(a, b) {
  const x = luminance(a), y = luminance(b);
  const hi = Math.max(x, y), lo = Math.min(x, y);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取某个块（:root 或 [data-theme="violet"] 或暗色媒体查询里）的令牌 */
function tokens(blockStart, blockEnd) {
  const slice = CSS.slice(blockStart, blockEnd);
  const out = {};
  for (const m of slice.matchAll(/--(ink(?:-\d)?|bg|bg-2|brand-soft)\s*:\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

const rootStart = CSS.indexOf(':root');
const violetStart = CSS.indexOf('[data-theme="violet"]');
const darkStart = CSS.indexOf('prefers-color-scheme: dark');
assert.ok(rootStart >= 0 && violetStart > rootStart && darkStart > violetStart, 'styles.css 结构变化，先更新本测试');

const THEMES = {
  'green (light)': tokens(rootStart, violetStart),
  'violet (light)': tokens(violetStart, darkStart),
  'dark': tokens(darkStart, CSS.length),
};

for (const [name, tk] of Object.entries(THEMES)) {
  test(name + '：文字令牌对比度 ≥ 4.5:1', () => {
    const bg = hex(tk.bg);
    assert.ok(bg, name + ' 缺少 --bg');
    const fails = [];
    /* 两种浅色底都要过：页面底色 --bg，以及品牌浅底（卡片/提示条）--brand-soft。 */
    const surfaces = [['bg', bg], ['brand-soft', hex(tk['brand-soft'])]].filter((x) => x[1]);
    for (const key of ['ink', 'ink-2', 'ink-3']) {
      const fg = hex(tk[key]);
      assert.ok(fg, name + ' 缺少 --' + key);
      for (const [label, surface] of surfaces) {
        const cr = Math.round(ratio(fg, surface) * 100) / 100;
        const need = key === 'ink' ? 7 : 4.5;
        if (!(cr >= need)) fails.push('--' + key + ' on ' + label + ' = ' + cr + ':1');
      }
    }
    assert.deepEqual(fails, [], name + ' 对比度不足: ' + fails.join('; '));
  });
}

test('两套浅色主题的 --ink-3 至少比 --ink-2 亮一档（保留层级）', () => {
  for (const name of ['green (light)', 'violet (light)']) {
    const tk = THEMES[name];
    const cr2 = ratio(hex(tk['ink-2']), hex(tk.bg));
    const cr3 = ratio(hex(tk['ink-3']), hex(tk.bg));
    assert.ok(cr3 < cr2, name + ': --ink-3 应比 --ink-2 更浅（' + cr3.toFixed(2) + ' vs ' + cr2.toFixed(2) + '）');
  }
});
