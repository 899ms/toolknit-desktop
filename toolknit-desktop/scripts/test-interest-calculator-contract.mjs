import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, lazy, tool, styles] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/interest-calculator/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/legacy.css', import.meta.url), 'utf8')
]);

for (const id of ['interestCalcOverlay', 'interestCalcBack', 'interestCalcModeTabs', 'interestCalcFreqTabs', 'interestCalcBtn', 'interestCalcScheduleBody']) {
  assert.match(html, new RegExp(`id="${id}"`));
}
assert.match(lazy, /'interest-calc':[\s\S]*import\('\.\/interest-calculator\/tool\.js'\)/);
assert.doesNotMatch(main, /interestCalcOverlay|openInterestCalcOverlay|calcInterest/);
assert.match(tool, /createLifecycleScope/);
assert.match(tool, /lifecycle\.event\(back, 'click'/);
assert.match(tool, /updateModeFields\(\)/);
assert.match(tool, /lifecycle\.use\(onLangChange/);
assert.match(tool, /dispose\(\)[\s\S]*lifecycle\.dispose\(\)/);
assert.doesNotMatch(styles, /#interestCalcOverlay|\.interest-calc-v2/);
console.log('Interest calculator feature contract passed');
