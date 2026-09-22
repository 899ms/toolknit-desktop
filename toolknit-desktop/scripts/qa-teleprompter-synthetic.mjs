import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSpeechFollower, segmentTeleprompterScript } from '../src/teleprompter-core.js';

// Input is the opt-in native benchmark's synthetic fixture output, not user audio.
const [currentPath, baselinePath] = process.argv.slice(2);
assert.ok(currentPath, 'provide the rolling_synthetic_speech_benchmark JSON output');
const records = JSON.parse(await readFile(currentPath, 'utf8'));
const script = segmentTeleprompterScript('欢迎使用本地语音跟随功能。我们使用模型识别语音。今天测试提词器，让文字跟随朗读。').sentences;
const follower = createSpeechFollower(script);
const expectedIndices = [0, 0, 0, 1, 1, 2, 2, 2, 2];
assert.equal(records.length, expectedIndices.length);
let finalProgress = 0;
records.forEach((record, index) => {
  const result = follower.push(record.text, { rolling: true, windowStart: record.start, windowEnd: record.end });
  assert.equal(follower.index, expectedIndices[index], `incorrect position at fixture window ${index}`);
  if (index === 0) assert.ok(result?.progress >= 0.25, 'first short utterance must move the character cursor');
  if (index === 4) assert.equal(result, null, 'ambiguous repeated partial audio must not cause a jump');
  if (result) finalProgress = result.progress;
});
assert.equal(finalProgress, 1, 'fixture reaches the end of the last sentence');
const mean = items => items.reduce((sum, item) => sum + item.ms, 0) / items.length;
console.log(`Synthetic native-to-follower: ${records.length} position checks passed; mean decode ${mean(records).toFixed(0)} ms`);
if (baselinePath) {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  console.log(`Same fixture baseline: ${mean(baseline).toFixed(0)} ms; decode reduction ${((1 - mean(records) / mean(baseline)) * 100).toFixed(1)}%`);
}
