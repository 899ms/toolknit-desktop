import assert from 'node:assert/strict';
import { createPreviewPlayback } from '../src/features/video-tools/preview-playback.js';
import { createPreviewRequest } from '../src/features/video-tools/preview-request.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Media extends EventTarget {
  readyState = 0; paused = true; hidden = true; seeking = false; time = 0; playCalls = 0;
  get currentTime() { return this.time; }
  set currentTime(value) {
    assert.ok(this.readyState >= 1, 'seek must follow metadata');
    this.time = value;
    this.seeking = true;
    queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  load() { this.readyState = 0; this.time = 0; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  pause() { this.paused = true; }
  async play() {
    assert.ok(this.readyState >= 3 && !this.seeking, 'play requires decoded, seeked media');
    this.playCalls++; this.paused = false;
  }
  ready(level) { this.readyState = level; this.dispatchEvent(new Event(level === 1 ? 'loadedmetadata' : 'canplay')); }
}
function fixture() {
  const media = new Media(), jobs = [], errors = [], times = [];
  const playback = createPreviewPlayback({ media, readyTimeoutMs: 100,
    requestClip(args) { const d = deferred(); const job = { ...d, args, cancelled: false, cancel() { this.cancelled = true; } }; jobs.push(job); return job; },
    onError: error => errors.push(error.message), onTime: at => times.push(at)
  });
  playback.reset('sample.mp4', 65_000);
  return { media, jobs, errors, times, playback };
}
const f = fixture();
const first = f.playback.play(8000);
f.jobs[0].resolve({ media_data_url: 'first' });
await tick();
assert.equal(f.media.playCalls, 0);
f.media.ready(1); await tick();
assert.equal(f.media.currentTime, 8);
assert.equal(f.media.playCalls, 0);
f.media.ready(3); assert.equal(await first, true);
assert.equal(f.jobs.length, 2, 'only the upcoming clip is prefetched');
assert.deepEqual(f.jobs.map(job => [job.args.startMs, job.args.endMs]), [[0, 30000], [30000, 60000]]);
f.jobs[1].resolve({ media_data_url: 'second' }); await tick();
f.media.dispatchEvent(new Event('ended')); await tick();
assert.equal(f.media.src, 'second');
f.media.ready(1); await tick(); f.media.ready(3); await tick();
assert.equal(f.media.playCalls, 2, 'crosses 30 seconds without another click');
assert.deepEqual([f.jobs[2].args.startMs, f.jobs[2].args.endMs], [60000, 65000]);
f.jobs[2].resolve({ media_data_url: 'third' }); await tick();
f.media.dispatchEvent(new Event('ended')); await tick();
f.media.ready(1); await tick(); f.media.ready(3); await tick();
f.media.dispatchEvent(new Event('ended')); await tick();
assert.equal(f.times.at(-1), 65000);
assert.equal(f.playback.state().active, false);
assert.equal(f.jobs.length, 3, 'bounded prefetch stops at the real end');
const replay = f.playback.play(65000);
assert.equal(f.jobs[3].args.startMs, 0);
f.playback.reset(); f.jobs[3].resolve({ media_data_url: 'stale' });
assert.equal(await replay, false); assert.equal(f.media.src, '');
f.playback.dispose();

const g = fixture();
const stale = g.playback.play(0);
g.playback.seek(42000);
assert.equal(g.jobs[0].cancelled, true);
g.jobs[0].resolve({ media_data_url: 'stale' }); assert.equal(await stale, false);
assert.equal(g.media.src, '');
const pending = g.playback.play(42000);
g.jobs[1].resolve({ media_data_url: 'pending' }); await tick();
g.playback.pause();
assert.equal(await pending, false, 'pause releases metadata waiter');
g.playback.dispose(); assert.deepEqual(g.errors, []);

const h = fixture();
const timeout = h.playback.play(); h.jobs[0].resolve({ media_data_url: 'never-ready' });
assert.equal(await timeout, false); assert.deepEqual(h.errors, ['video-preview:ready-timeout']);
const retry = h.playback.play(); h.jobs[1].resolve({ media_data_url: 'retry' }); await tick();
h.media.ready(1); await tick(); h.media.ready(3); assert.equal(await retry, true);
h.jobs[2].reject(new Error('prefetch-failed')); await tick();
h.playback.dispose(); assert.equal(h.jobs[2].cancelled, true);

const calls = [];
const request = createPreviewRequest('render_video_preview_clip', {}, async () => (cmd, args) => { calls.push([cmd, args]); return Promise.resolve({}); });
request.cancel(); await assert.rejects(request.promise, /cancelled/); assert.deepEqual(calls, []);
const d = deferred();
const live = createPreviewRequest('render_video_preview_clip', {}, async () => (cmd, args) => {
  calls.push([cmd, args]); return cmd === 'cancel_video_preview' ? Promise.resolve() : d.promise;
});
await tick(); live.cancel();
await tick();
assert.equal(calls[1][0], 'cancel_video_preview');
assert.equal(calls[0][1].requestId, calls[1][1].requestId);
d.resolve({}); await live.promise;
console.log('Preview metadata ordering, 65-second continuation, prefetch bounds, replay, stale results, pause, timeout and request isolation passed');
