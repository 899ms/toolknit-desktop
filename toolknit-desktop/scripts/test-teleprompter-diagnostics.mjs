import assert from 'node:assert/strict';
import { createTeleprompterDiagnostics } from '../src/features/teleprompter/diagnostics.js';

const timers = new Map();
let timerId = 0;
const output = [];
const windowRef = {
  setInterval(callback, interval) {
    assert.equal(interval, 1000, 'meter diagnostics are limited to once a second');
    timers.set(++timerId, callback);
    return timerId;
  },
  clearInterval(id) { timers.delete(id); }
};
const consoleRef = { info: line => output.push(line) };
const diagnostics = createTeleprompterDiagnostics({ windowRef, consoleRef });
diagnostics.event('transcript', () => { throw new Error('production must not inspect spoken text'); });
assert.equal(diagnostics.capture(() => ({})), null);
assert.equal(output.length, 0, 'normal releases do not print diagnostic text');
assert.equal(timers.size, 0, 'normal releases do not start meter timers');

windowRef[Symbol.for('toolknit.qa-devtools')] = true;
diagnostics.event('transcript', { text: 'synthetic speech', confidence: 0.9 });
assert.equal(output.length, 1);
assert.ok(output[0].startsWith('[Teleprompter][transcript] '));
const probe = diagnostics.capture(() => ({ session: 7, contextState: 'running' }));
const tick = () => [...timers.values()].forEach(callback => callback());
const latest = () => JSON.parse(output.at(-1).slice('[Teleprompter][audio] '.length));
tick();
assert.equal(latest().signal, 'no-audio-callbacks', 'dead capture must be visible without an audio callback');
probe.accept(new Int16Array(16000));
tick();
assert.equal(latest().signal, 'below-gate');
assert.equal(latest().receivedMs, 1000);
assert.equal(latest().rms, 0);
probe.accept(new Int16Array(8000).fill(500));
probe.accept(new Int16Array(8000).fill(-500));
tick();
assert.equal(latest().signal, 'above-gate');
assert.equal(latest().rms, 500);
assert.equal(latest().peak, 500);
assert.equal(latest().signalBlocks, 2);
assert.equal(latest().session, 7);
assert.equal(latest().gateRms, 12);
probe.accept(new Int16Array(160).fill(20), { gateRms: 15, noiseRms: 6, signal: true });
tick();
assert.equal(latest().gateRms, 15, 'meter reports the actual adaptive gate');
assert.equal(latest().noiseRms, 6);
assert.equal(latest().signalBlocks, 1);
probe.stop();
assert.equal(timers.size, 0, 'stopping recognition releases its meter');
const count = output.length;
probe.accept(new Int16Array(16000).fill(500));
tick();
assert.equal(output.length, count, 'stopped probes cannot write more audio logs');
windowRef[Symbol.for('toolknit.qa-devtools')] = false;
diagnostics.event('transcript', { text: 'must remain private' });
assert.equal(output.length, count);
windowRef[Symbol.for('toolknit.qa-devtools')] = true;
createTeleprompterDiagnostics({ windowRef, consoleRef: { info() { throw new Error('console failure'); } } })
  .event('transcript', { text: 'synthetic' });
console.log('Teleprompter diagnostics passed: QA-only text, audio heartbeat, silence, signal, rate limit and cleanup');
