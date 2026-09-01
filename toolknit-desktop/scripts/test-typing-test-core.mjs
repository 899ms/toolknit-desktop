import assert from 'node:assert/strict';
import {
  calculateTypingStats,
  compareTypingInput,
  createTypingWordPools,
  generateTypingText,
  getTypingRating,
  normalizeTypingValue,
  sampleTypingWords
} from '../src/features/typing-test/core.js';

assert.equal(normalizeTypingValue('你好， world!'), '你好world');
assert.deepEqual(sampleTypingWords(['a', 'b', 'a'], 4, () => 0), ['a', 'b', 'a', 'b']);
const pools = createTypingWordPools({ en: { easy: ['base'] }, zh: { easy: ['基础'] } }, { en: { easy: ['extra'] }, zh: { easy: ['补充'] } });
assert.equal(generateTypingText(pools, 'en', 'easy', () => 0).split(' ').length, 24);
assert.deepEqual(compareTypingInput('abc', 'abx'), {
  normalizedTarget: 'abc', normalizedInput: 'abx', correctCount: 2, wrongCount: 1, totalCharCount: 3, complete: false
});
assert.equal(compareTypingInput('abc', 'abc').complete, true);
assert.deepEqual(calculateTypingStats({ correctCount: 300, totalCharCount: 360, startTime: 0, now: 60_000 }), { cpm: 0, wpm: 0, accuracy: 83 });
assert.deepEqual(calculateTypingStats({ correctCount: 300, totalCharCount: 360, startTime: 1_000, now: 61_000 }), { cpm: 300, wpm: 60, accuracy: 83 });
assert.equal(getTypingRating(80, 'en'), 'S');
assert.equal(getTypingRating(80, 'zh'), 'B');
console.log('Typing test core regression checks passed');
