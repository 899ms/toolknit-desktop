import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createLiveAudioWindow } from '../src/features/teleprompter/audio-window.js';
import { createSpeechFollower, segmentTeleprompterScript, normalizeSpeechText } from '../src/teleprompter-core.js';

// Opt-in synthetic speech only. No microphone, downloads or cloud requests.
const script = '生活处处藏着温柔与美好，平凡的日常里，总有细碎的温暖治愈人心。';
const [mode, input, output] = process.argv.slice(2);
if (mode === 'prepare') {
  const bytes = await readFile(input);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  let samples;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (name === 'fmt ') {
      assert.equal(bytes.readUInt16LE(offset + 8), 1);
      assert.equal(bytes.readUInt16LE(offset + 10), 1);
      assert.equal(bytes.readUInt32LE(offset + 12), 16000);
      assert.equal(bytes.readUInt16LE(offset + 22), 16);
    }
    if (name === 'data') samples = Array.from({ length: size / 2 }, (_, index) => bytes.readInt16LE(offset + 8 + index * 2));
    offset += 8 + size + size % 2;
  }
  assert.ok(samples?.length);
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  const cases = [];
  for (const targetRms of [20, 60]) {
    const ring = createLiveAudioWindow();
    const windows = [];
    let seed = 42;
    const noise = () => { seed = (1664525 * seed + 1013904223) >>> 0; return ((seed / 2 ** 32) * 2 - 1) * Math.sqrt(3) * 4; };
    const pcm = Int16Array.from({ length: 16000 + samples.length + 16000 }, (_, index) =>
      Math.round((samples[index - 16000] || 0) * targetRms / rms + noise()));
    let nextDecode = 0;
    let oldGateBlocks = 0;
    for (let offset = 0; offset < pcm.length; offset += 341) {
      const block = pcm.subarray(offset, offset + 341);
      if (Math.sqrt(block.reduce((sum, value) => sum + value * value, 0) / block.length) >= 100) oldGateBlocks += 1;
      ring.append(block);
      if (offset < nextDecode) continue;
      const window = ring.take();
      if (window) {
        windows.push(window);
        // CPU cadence fixture, not a claim about actual end-to-end latency.
        nextDecode = offset + 14400;
      }
    }
    assert.ok(windows.length >= 5);
    if (targetRms === 20) assert.equal(oldGateBlocks, 0, 'old gate should reject the weak fixture');
    cases.push({ name: `rms-${targetRms}-noise-4`, oldGateBlocks, windows });
  }
  await writeFile(output, JSON.stringify({ script, cases }));
  console.log(cases.map(item => ({ name: item.name, windows: item.windows.length, oldGateBlocks: item.oldGateBlocks })));
} else if (mode === 'verify') {
  const cases = JSON.parse(await readFile(input, 'utf8'));
  const sentences = segmentTeleprompterScript(script).sentences;
  for (const item of cases) {
    const follower = createSpeechFollower(sentences);
    const positions = [];
    let last;
    for (const record of item.records) {
      if (record.confidence < 0.35) continue;
      const result = follower.push(record.text, { rolling: true, windowStart: record.start, windowEnd: record.end, utterance: record.utterance });
      if (result && !result.pending) { last = result; positions.push({ endMs: Math.round(record.end / 16), index: result.index, progress: result.progress }); }
    }
    console.log(JSON.stringify({ name: item.name, positions, texts: item.records.map(record => record.text), meanDecodeMs: Math.round(item.records.reduce((sum, record) => sum + record.ms, 0) / item.records.length) }));
    assert.ok(positions.length >= 3, 'multiple native results should advance reading');
    assert.equal(follower.index, sentences.length - 1, 'reading must reach the final phrase');
    assert.ok(last?.progress >= 0.8, 'reading must reach the end of the reported passage');
    assert.ok(item.records.some(record => normalizeSpeechText(record.text).includes('生活')), 'first word must survive capture');
  }
} else {
  throw new Error('Use prepare <synthetic.wav> <windows.json> or verify <native-results.json>');
}
