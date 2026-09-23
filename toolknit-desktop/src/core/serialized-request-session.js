export function createSerializedRequestSession({
  timeoutMs = 90_000,
  createController = () => new AbortController(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer)
} = {}) {
  let revision = 0;
  let active = null;

  function isCurrent(id) {
    return Boolean(active && active.id === id && revision === id);
  }

  function begin() {
    if (active) return null;
    const controller = createController();
    const id = ++revision;
    let timedOut = false;
    const timer = setTimer(() => {
      if (!isCurrent(id) || controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    active = { controller, id, timer };
    return {
      controller,
      id,
      signal: controller.signal,
      timedOut: () => timedOut
    };
  }

  function cancel(id) {
    if (id !== undefined && !isCurrent(id)) return false;
    revision += 1;
    const request = active;
    active = null;
    if (!request) return false;
    clearTimer(request.timer);
    request.controller.abort();
    return true;
  }

  function finish(id) {
    if (!isCurrent(id)) return false;
    const request = active;
    active = null;
    clearTimer(request.timer);
    return true;
  }

  return {
    begin,
    cancel,
    finish,
    isCurrent,
    get busy() { return Boolean(active); }
  };
}
