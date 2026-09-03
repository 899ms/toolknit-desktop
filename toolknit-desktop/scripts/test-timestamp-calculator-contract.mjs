import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, lazyTools, tool, styles, featureStyles] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/timestamp-calculator/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/legacy.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/timestamp-calculator/timestamp-calculator.css', import.meta.url), 'utf8')
]);

for (const id of [
  'tsCalcOverlay',
  'tsCalcBack',
  'tsCalcModeTabs',
  'tsCalcInput',
  'tsCalcDateInput',
  'tsCalcResultValue',
  'tsCalcCopyResult'
]) assert.match(html, new RegExp(`id="${id}"`));

assert.match(lazyTools, /'timestamp-calc':[\s\S]*import\('\.\/timestamp-calculator\/tool\.js'\)/);
assert.doesNotMatch(main, /tsCalcOverlay|openTsCalcOverlay|tsCalcNowTimer/);
assert.match(tool, /createLifecycleScope/);
assert.match(tool, /lifecycle\.event\(back, 'click'/);
assert.match(tool, /lifecycle\.use\(onLangChange/);
assert.match(tool, /stopClock\(\)/);
assert.match(tool, /clearCopyTimers\(\)/);
assert.match(tool, /lifecycle\.isCurrent\(token\)/);
assert.match(tool, /dispose\(\)[\s\S]*lifecycle\.dispose\(\)/);
assert.match(tool, /import '\.\/timestamp-calculator\.css'/);
assert.doesNotMatch(tool, /localStorage|sessionStorage/);
assert.doesNotMatch(styles, /\.ts-calc|\.timestamp-calc/);
assert.match(featureStyles, /\.timestamp-calc-v2-workspace/);
assert.match(featureStyles, /\.ts-calc-result-card/);

console.log('Timestamp calculator feature contract passed');
