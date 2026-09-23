let sequence = 0;

// Each request owns its cancellation, including cancellation before IPC starts.
export function createPreviewRequest(command, args, getInvoke) {
  const requestId = `preview-${Date.now()}-${++sequence}`;
  let cancelled = false;
  let settled = false;
  let dispatched = false;
  let invoke;
  const promise = Promise.resolve().then(getInvoke).then(api => {
    invoke = api;
    if (cancelled) throw new Error('video-preview:cancelled');
    dispatched = true;
    return invoke(command, { ...args, requestId });
  }).finally(() => { settled = true; });
  return {
    promise,
    cancel() {
      cancelled = true;
      if (dispatched && !settled) {
        void Promise.resolve().then(() => invoke('cancel_video_preview', { requestId })).catch(() => {});
      }
    }
  };
}
