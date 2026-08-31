const NOOP = () => {};

function reportDisposalError(onError, error) {
  try {
    onError?.(error);
  } catch {
    // Disposal must continue even when an error reporter fails.
  }
}

export function createLifecycleScope({ onError } = {}) {
  const disposers = [];
  let disposed = false;
  let revision = 0;

  function use(disposer) {
    if (typeof disposer !== 'function') return NOOP;
    if (disposed) {
      try { disposer(); } catch (error) { reportDisposalError(onError, error); }
      return NOOP;
    }
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      try { disposer(); } catch (error) { reportDisposalError(onError, error); }
    };
    disposers.push(release);
    return release;
  }

  function event(target, type, listener, options) {
    if (!target?.addEventListener || !target?.removeEventListener) {
      throw new TypeError('Lifecycle event target must implement EventTarget');
    }
    target.addEventListener(type, listener, options);
    return use(() => target.removeEventListener(type, listener, options));
  }

  function timeout(callback, delay) {
    const id = setTimeout(callback, delay);
    use(() => clearTimeout(id));
    return id;
  }

  function interval(callback, delay) {
    const id = setInterval(callback, delay);
    use(() => clearInterval(id));
    return id;
  }

  function abortController() {
    const controller = new AbortController();
    use(() => controller.abort());
    return controller;
  }

  function invalidate() {
    revision += 1;
    return revision;
  }

  function token() {
    return revision;
  }

  function isCurrent(candidate) {
    return !disposed && candidate === revision;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    revision += 1;
    for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]();
    disposers.length = 0;
  }

  return {
    abortController,
    dispose,
    event,
    interval,
    invalidate,
    isCurrent,
    timeout,
    token,
    use,
    get disposed() { return disposed; }
  };
}

export function normalizeToolInstance(instance, toolId = 'unknown-tool') {
  if (!instance || typeof instance !== 'object') {
    throw new TypeError(`Tool ${toolId} initializer must return an object`);
  }
  if (typeof instance.open !== 'function') {
    throw new TypeError(`Tool ${toolId} must implement open()`);
  }

  let disposed = false;
  return {
    open(...args) {
      if (disposed) throw new Error(`Tool ${toolId} is disposed`);
      return instance.open(...args);
    },
    close(...args) {
      if (disposed) return undefined;
      return instance.close?.(...args);
    },
    dispose(...args) {
      if (disposed) return undefined;
      disposed = true;
      if (typeof instance.dispose === 'function') return instance.dispose(...args);
      if (typeof instance.destroy === 'function') return instance.destroy(...args);
      return instance.close?.(...args);
    },
    get disposed() { return disposed; },
    raw: instance
  };
}
