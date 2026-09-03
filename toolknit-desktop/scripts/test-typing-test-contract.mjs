import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, lazy, tool, styles, featureStyles] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/typing-test/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/legacy.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/typing-test/typing-test.css', import.meta.url), 'utf8')
]);

for (const id of [
  'typingTestOverlay',
  'typingTestBack',
  'typingTestSettings',
  'typingTestArea',
  'typingTestResult',
  'typingTestInput',
  'typingTestStartBtn'
]) assert.match(html, new RegExp(`id="${id}"`));

assert.match(lazy, /'typing-test':[\s\S]*import\('\.\/typing-test\/tool\.js'\)/);
assert.doesNotMatch(main, /typingWordsData|typingTestOverlay|openTypingTestOverlay|typingAudioCtx|disposeTypingAudioContext/);
assert.match(tool, /createLifecycleScope/);
assert.match(tool, /clearTimer\(\)/);
assert.match(tool, /clearDeferredTasks\(\)/);
assert.match(tool, /disposeAudioContext\(\)/);
assert.match(tool, /oscillator\.disconnect\(\)/);
assert.match(tool, /lifecycle\.isCurrent\(token\)/);
assert.match(tool, /lifecycle\.use\(onLangChange/);
assert.match(tool, /async dispose\(\)[\s\S]*lifecycle\.dispose\(\)/);
assert.match(tool, /import '\.\/typing-test\.css'/);
assert.doesNotMatch(styles, /\.typing-test|#typingTestOverlay/);
assert.match(featureStyles, /\.typing-test-v2/);
assert.match(featureStyles, /\.typing-test-char\.current/);
console.log('Typing test feature contract passed');
