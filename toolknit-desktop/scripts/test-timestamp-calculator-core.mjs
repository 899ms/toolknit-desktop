import assert from 'node:assert/strict';
import { formatLocalDate, formatUtcDate, getRelativeTime, pad2, parseTimestamp } from '../src/features/timestamp-calculator/core.js';

assert.equal(pad2(7), '07');
assert.equal(pad2(12), '12');
assert.equal(formatLocalDate(new Date(2024, 0, 2, 3, 4, 5)), '2024-01-02 03:04:05');
assert.equal(formatUtcDate(new Date(Date.UTC(2024, 0, 2, 3, 4, 5))), '2024-01-02 03:04:05');
assert.deepEqual(parseTimestamp('1700000000'), { ts: 1700000000, isMs: false });
assert.deepEqual(parseTimestamp('1700000000000'), { ts: 1700000000, isMs: true });
assert.equal(parseTimestamp(''), null);
assert.equal(parseTimestamp('-1'), null);
assert.equal(parseTimestamp('100000000000001'), null);

const relativeLabels = {
  now: '此刻',
  secondAgo: '秒前',
  secondLater: '秒后',
  minuteAgo: '分钟前',
  minuteLater: '分钟后',
  hourAgo: '小时前',
  hourLater: '小时后',
  dayAgo: '天前',
  dayLater: '天后'
};
assert.equal(getRelativeTime(100, 100, relativeLabels), '此刻');
assert.equal(getRelativeTime(70, 100, relativeLabels), '30秒前');
assert.equal(getRelativeTime(220, 100, relativeLabels), '2分钟后');
assert.equal(getRelativeTime(7300, 100, relativeLabels), '2小时后');
assert.equal(getRelativeTime(100 - 172800, 100, relativeLabels), '2天前');

console.log('Timestamp calculator core regression checks passed');
