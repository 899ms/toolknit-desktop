import assert from 'node:assert/strict';
import { createTeleprompterRecognitionController } from '../src/features/teleprompter/recognition.js';
import { createTeleprompterDiagnostics } from '../src/features/teleprompter/diagnostics.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const media = () => {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { track, getTracks: () => [track] };
};
function harness({ getMedia = async () => media(), startNative, debug = false } = {}) {
  const contexts = [];
  const requests = [];
  const stopped = [];
  const transcripts = [];
  const states = [];
  const errors = [];
  const logs = [];
  const timers = new Map();
  let sequence = 0;
  class AudioContext {
    constructor() { this.sampleRate = 16000; this.state = 'running'; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource(stream) { this.stream = stream; return { connect() {}, disconnect() {} }; }
    createScriptProcessor(size) {
      assert.equal(size, 1024);
      return this.processor = { connect() {}, disconnect() {} };
    }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    feed(seconds, amplitude = 0.15) {
      this.processor.onaudioprocess?.({ inputBuffer: {
        getChannelData: () => new Float32Array(Math.round(seconds * 16000)).fill(amplitude)
      } });
    }
  }
  const windowRef = {
    AudioContext, clearTimeout() {},
    [Symbol.for('toolknit.qa-devtools')]: debug,
    setInterval(callback) { const id = Symbol(); timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); }
  };
  const diagnostics = createTeleprompterDiagnostics({ windowRef, consoleRef: { info: line => logs.push(line) } });
  const controller = createTeleprompterRecognitionController({
    isTauri: true, windowRef, diagnostics,
    navigatorRef: { mediaDevices: { getUserMedia: getMedia } },
    isPlaying: () => true, getVoiceFollow: () => true,
    getEngine: () => 'offline', requestOfflineModel: async () => true,
    applyTranscript: (...args) => transcripts.push(args),
    setRuntime: state => states.push(state), logError: (...args) => errors.push(args),
    invoke: async (command, args) => {
      if (command === 'start_teleprompter_recognition') return startNative ? startNative() : `session-${++sequence}`;
      if (command === 'stop_teleprompter_recognition') { stopped.push(args.sessionId); return; }
      assert.equal(command, 'transcribe_teleprompter_audio');
      const pending = deferred();
      requests.push({ ...args, ...pending });
      return pending.promise;
    }
  });
  const records = stage => logs.filter(line => line.startsWith(`[Teleprompter][${stage}] `))
    .map(line => JSON.parse(line.slice(`[Teleprompter][${stage}] `.length)));
  return { controller, contexts, requests, transcripts, stopped, states, errors, records, logs, timers };
}

const live = harness();
await live.controller.start();
const firstContext = live.contexts[0];
firstContext.feed(2, 0);
assert.equal(live.requests.length, 0, 'quiet input never enters Whisper');
firstContext.feed(0.9);
assert.equal(live.requests.length, 1);
firstContext.feed(8, 0.25);
assert.equal(live.requests.length, 1, 'only one inference may own a native session');
live.requests[0].resolve({ text: '欢迎使用', confidence: 0.9 });
await settle();
assert.equal(live.requests.length, 2, 'completion immediately picks newest buffered audio');
assert.equal(live.requests[1].samples.length, 51200);
assert.ok(live.requests[1].samples.every(sample => sample === 8192));
assert.equal(live.transcripts[0][1], false, 'overlapping windows are not independent final sentences');
assert.equal(live.transcripts[0][2].rolling, true);
assert.ok(live.transcripts[0][2].recognitionSession > 0);
await live.controller.stop();
live.requests[1].resolve({ text: '过期结果', confidence: 1 });
await settle();
assert.equal(live.transcripts.length, 1, 'stopped inference must not move the cursor');
assert.equal(firstContext.state, 'closed');
assert.equal(firstContext.stream.track.stopped, true);
assert.equal(firstContext.processor.onaudioprocess, null);
await live.controller.start();
live.contexts[1].feed(0.9);
live.requests[2].resolve({ text: '低置信度结果', confidence: 0.1 });
await settle();
assert.equal(live.transcripts.length, 1);
live.contexts[1].feed(0.5);
live.requests[3].reject(new Error('synthetic inference failure'));
await settle();
assert.equal(live.states.at(-1), 'fallback');
assert.equal(live.contexts[1].state, 'closed');
assert.equal(live.errors.length, 1);
await live.controller.dispose();

const lateMicrophone = deferred();
let mediaCalls = 0;
const race = harness({ getMedia: () => ++mediaCalls === 1 ? lateMicrophone.promise : Promise.resolve(media()) });
const staleStart = race.controller.start();
await settle();
await race.controller.stop();
await race.controller.start();
const active = race.contexts.at(-1);
const lateStream = media();
lateMicrophone.resolve(lateStream);
await staleStart;
assert.equal(lateStream.track.stopped, true, 'late microphone belongs to the old session');
assert.equal(active.state, 'running', 'old cleanup cannot close the newer AudioContext');
assert.equal(active.stream.track.stopped, false);
assert.equal(race.states.at(-1), 'active');
assert.deepEqual(race.stopped, ['session-1']);
await race.controller.dispose();

const lateNative = deferred();
let starts = 0;
const nativeRace = harness({ startNative: () => ++starts === 1 ? lateNative.promise : Promise.resolve('new') });
const old = nativeRace.controller.start();
await settle();
await nativeRace.controller.start();
lateNative.resolve('old');
await old;
assert.deepEqual(nativeRace.stopped, ['old'], 'late native start stops only its own session id');
assert.equal(nativeRace.contexts[0].state, 'running');
await nativeRace.controller.dispose();

const concurrent = harness();
await Promise.all([concurrent.controller.start(), concurrent.controller.start()]);
assert.equal(concurrent.contexts.length, 1, 'rapid repeated starts cannot create two microphones');
await concurrent.controller.dispose();
assert.equal(concurrent.logs.length, 0, 'normal runtime must not log speech');
assert.equal(concurrent.timers.size, 0);

const debug = harness({ debug: true });
await debug.controller.start();
assert.equal(debug.records('model-gate')[0].ready, true);
assert.equal(debug.records('microphone-ready')[0].sourceSampleRate, 16000);
assert.equal(debug.timers.size, 1);
[...debug.timers.values()][0]();
assert.equal(debug.records('audio')[0].signal, 'no-audio-callbacks');
debug.contexts[0].feed(0.9);
debug.requests[0].resolve({ text: '', confidence: 0 });
await settle();
assert.equal(debug.records('transcript')[0].skipped, 'empty-transcript');
debug.contexts[0].feed(0.5);
debug.requests[1].resolve({ text: 'synthetic weak speech', confidence: 0.1 });
await settle();
assert.equal(debug.records('transcript')[1].text, 'synthetic weak speech', 'log text before confidence filtering');
assert.equal(debug.records('transcript')[1].skipped, 'low-speech-confidence');
assert.equal(debug.transcripts.length, 0);
debug.contexts[0].feed(0.5);
debug.requests[2].resolve({ text: '總有細碎的溫暖 English', confidence: 0.9, model_id: 'small' });
await settle();
assert.equal(debug.records('transcript')[2].skipped, null);
assert.equal(debug.records('transcript')[2].text, '总有细碎的温暖 English');
assert.equal(debug.transcripts[0][0], '总有细碎的温暖 English');
assert.equal(debug.records('transcript')[2].requestId, debug.transcripts[0][2].requestId);
debug.contexts[0].feed(0.5);
await debug.controller.stop();
assert.equal(debug.timers.size, 0);
debug.requests[3].resolve({ text: 'synthetic stale speech', confidence: 1 });
await settle();
assert.equal(debug.records('transcript')[3].skipped, 'stale-session');
assert.equal(debug.transcripts.length, 1);
await debug.controller.dispose();

const weak = harness({ debug: true });
await weak.controller.start();
weak.contexts[0].feed(1, 4 / 32767);
assert.equal(weak.requests.length, 0);
weak.contexts[0].feed(0.9, 20 / 32767);
assert.equal(weak.requests.length, 1, 'weak PCM must reach the native request after resampling');
assert.ok(weak.records('recognize')[0].inputRms < 100);
assert.ok(weak.records('recognize')[0].gain > 1);
assert.ok(weak.requests[0].samples.some(sample => sample > 500), 'native receives gain-normalized PCM');
weak.requests[0].resolve({ text: '生活處處藏著溫柔與美好', confidence: 0.9 });
await settle();
assert.equal(weak.transcripts[0][0], '生活处处藏着温柔与美好');
await weak.controller.dispose();
assert.equal(weak.timers.size, 0);
console.log('teleprompter offline runtime passed: live capture, silence, backlog, stale results, failure, start/stop races');
