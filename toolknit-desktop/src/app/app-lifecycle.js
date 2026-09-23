import { createLifecycleScope } from './tool-lifecycle.js';

/** Owns app-level listeners and guarantees idempotent teardown. */
export function createAppLifecycle({ root = window } = {}) {
  const scope = createLifecycleScope();
  const on = (target, type, listener, options) => scope.event(target, type, listener, options);
  return Object.freeze({ on, use: cleanup => scope.use(cleanup), token: () => scope.token(), dispose: () => scope.dispose() });
}
