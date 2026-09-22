const WINDOW_MS = 30_000;
const abortError = () => new Error('video-preview:cancelled');

function waitForMedia(media, events, ready, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer);
      events.forEach(event => media.removeEventListener(event, check));
      media.removeEventListener('error', failed);
      signal.removeEventListener('abort', cancelled);
      if (error) reject(error); else resolve();
    };
    const check = () => { if (ready()) finish(); };
    const failed = () => finish(new Error('video-preview:decode-failed'));
    const cancelled = () => finish(abortError());
    events.forEach(event => media.addEventListener(event, check));
    media.addEventListener('error', failed);
    signal.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(() => finish(new Error('video-preview:ready-timeout')), timeoutMs);
    if (signal.aborted) cancelled(); else check();
  });
}

/** One active clip and one upcoming clip; file changes invalidate both. */
export function createPreviewPlayback({ media, requestClip, onState = () => {}, onTime = () => {},
  onError = () => {}, readyTimeoutMs = 15_000 }) {
  let source = '';
  let duration = 0;
  let position = 0;
  let clip = null;
  let next = null;
  let operation = null;
  let wanted = false;
  let loading = false;
  let disposed = false;
  const state = () => ({ loading, active: wanted, playing: wanted && !media.paused, position });
  const publish = () => onState(state());
  const valid = owner => !disposed && operation === owner && !owner.signal.aborted;
  const rangeAt = at => {
    const startMs = Math.floor(Math.min(at, Math.max(0, duration - 1)) / WINDOW_MS) * WINDOW_MS;
    return { startMs, endMs: Math.min(duration, startMs + WINDOW_MS) };
  };
  const contains = (range, at) => range && at >= range.startMs && at < range.endMs;

  function discardNext() { next?.job.cancel(); next = null; }
  function pause() {
    wanted = false;
    operation?.abort();
    operation = null;
    discardNext();
    loading = false;
    media.pause();
    publish();
  }
  function request(range) {
    const job = requestClip({ inputPath: source, ...range });
    // Prefetch may fail before it is consumed; always retain a handled outcome.
    return { range, job, outcome: job.promise.then(result => ({ result }), error => ({ error })) };
  }
  function prefetch() {
    if (!wanted || !clip || clip.endMs >= duration || next) return;
    next = request(rangeAt(clip.endMs));
  }
  function reset(path = '', totalMs = 0) {
    pause();
    source = path;
    duration = Math.max(0, totalMs);
    position = 0;
    clip = null;
    media.removeAttribute('src');
    media.load();
    media.hidden = true;
  }
  function seek(at) {
    pause();
    position = Math.max(0, Math.min(duration, at));
    const reusable = contains(clip, position) && media.readyState >= 1;
    if (reusable) media.currentTime = (position - clip.startMs) / 1000;
    media.hidden = !reusable;
    return Boolean(reusable);
  }
  async function play(at = position) {
    if (disposed || !source || !duration) return false;
    operation?.abort();
    media.pause();
    const owner = new AbortController();
    operation = owner;
    wanted = true;
    loading = true;
    position = at >= duration ? 0 : Math.max(0, at);
    const target = position;
    publish();
    try {
      if (!contains(clip, target) || media.readyState < 1) {
        const range = rangeAt(target);
        let pending = next?.range.startMs === range.startMs ? next : null;
        if (pending) next = null;
        else { discardNext(); pending = request(range); }
        const cancel = () => pending.job.cancel();
        owner.signal.addEventListener('abort', cancel, { once: true });
        const outcome = await pending.outcome;
        owner.signal.removeEventListener('abort', cancel);
        if (!valid(owner)) return false;
        if (outcome.error) throw outcome.error;
        const url = outcome.result?.media_data_url || outcome.result?.mediaDataUrl;
        if (!url) throw new Error('video-preview:empty-result');
        clip = range;
        media.src = url;
        media.load();
      }
      await waitForMedia(media, ['loadedmetadata'], () => media.readyState >= 1, owner.signal, readyTimeoutMs);
      if (!valid(owner)) return false;
      const offset = (target - clip.startMs) / 1000;
      if (Math.abs(media.currentTime - offset) > 0.001) media.currentTime = offset;
      await waitForMedia(media, ['seeked', 'canplay'], () => !media.seeking && media.readyState >= 3,
        owner.signal, readyTimeoutMs);
      if (!valid(owner)) return false;
      media.hidden = false;
      await media.play();
      if (!valid(owner)) return false;
      loading = false;
      publish();
      prefetch();
      return true;
    } catch (error) {
      if (valid(owner)) {
        pause();
        clip = null;
        media.hidden = true;
        onError(error);
      }
      return false;
    }
  }
  const time = () => {
    if (!clip || loading || media.seeking || media.hidden) return;
    position = Math.min(clip.endMs, clip.startMs + Math.round(media.currentTime * 1000));
    onTime(position);
  };
  const ended = () => {
    if (!wanted || loading || !clip) return;
    position = clip.endMs;
    onTime(position);
    if (position < duration) void play(position);
    else { pause(); publish(); }
  };
  const failed = () => {
    if (!wanted || loading) return; // A pending waiter reports loading errors.
    pause();
    clip = null;
    media.hidden = true;
    onError(new Error('video-preview:decode-failed'));
  };
  media.addEventListener('timeupdate', time);
  media.addEventListener('seeked', time);
  media.addEventListener('ended', ended);
  media.addEventListener('error', failed);
  return { state, reset, seek, play, pause, dispose() {
    if (disposed) return;
    reset();
    disposed = true;
    media.removeEventListener('timeupdate', time);
    media.removeEventListener('seeked', time);
    media.removeEventListener('ended', ended);
    media.removeEventListener('error', failed);
  } };
}
