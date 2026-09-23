import { createLifecycleScope } from './tool-lifecycle.js';
import { DEFAULT_REVEAL_MS } from './page-transition-runtime.js';

/** Releases the first-paint cover only after the home UI has settled. */
export function createStartupRuntime({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  fontsReady = Promise.resolve(),
  backgroundReady = Promise.resolve(),
  timeoutMs = 12000,
  revealMs = DEFAULT_REVEAL_MS,
  onTimeout = () => console.warn('[startup] Resource readiness timed out; showing the available interface.')
} = {}) {
  const scope = createLifecycleScope();
  const root = documentRef?.documentElement;
  const mask = documentRef?.getElementById?.('appStartupMask');
  const app = documentRef?.querySelector?.('.app');
  const wasInert = Boolean(app?.inert);

  function dispose() {
    if (scope.disposed) return;
    scope.dispose();
    mask?.remove();
    if (root) delete root.dataset.tkStartup;
    documentRef?.body?.removeAttribute('aria-busy');
    if (app) app.inert = wasInert;
    windowRef?.clearTimeout?.(windowRef.__toolknitStartupWatchdog);
    if (windowRef) delete windowRef.__toolknitStartupWatchdog;
  }

  if (!mask || root?.dataset.tkStartup !== 'loading') {
    return Object.freeze({ ready: Promise.resolve(), dispose });
  }

  windowRef.clearTimeout?.(windowRef.__toolknitStartupWatchdog);
  delete windowRef.__toolknitStartupWatchdog;
  if (app) app.inert = true;
  documentRef.body?.setAttribute('aria-busy', 'true');
  const cancelled = new Promise(resolve => { scope.use(resolve); });
  scope.event(windowRef, 'pagehide', dispose, { once: true });
  scope.event(documentRef, 'keydown', event => {
    // Prevent keyboard navigation into controls behind the startup cover.
    if (['Tab', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, { capture: true });

  function nextFrame() {
    if (scope.disposed || documentRef.hidden || !windowRef.requestAnimationFrame) return Promise.resolve();
    return new Promise(resolve => {
      let frame;
      const fallback = setTimeout(() => release(), 100);
      const release = scope.use(() => {
        clearTimeout(fallback);
        windowRef.cancelAnimationFrame(frame);
        resolve();
      });
      frame = windowRef.requestAnimationFrame(release);
    });
  }

  async function settleResources() {
    await Promise.allSettled([fontsReady, backgroundReady]);
    if (scope.disposed) return;
    // Layout starts any CSS font requests introduced by custom font selection.
    app?.getBoundingClientRect();
    await documentRef.fonts?.ready;
    if (scope.disposed) return;
    const images = [...(app?.querySelectorAll('img') || [])]
      .filter(image => image.getBoundingClientRect().width > 0 && image.getBoundingClientRect().height > 0);
    await Promise.allSettled(images.map(image => image.decode?.()));
    await nextFrame();
    await nextFrame();
  }

  const ready = (async () => {
    let cancelDeadline;
    const deadline = new Promise(resolve => {
      const timer = setTimeout(() => {
        onTimeout();
        resolve();
      }, timeoutMs);
      cancelDeadline = scope.use(() => clearTimeout(timer));
    });
    await Promise.race([settleResources().catch(() => {}), deadline, cancelled]);
    cancelDeadline();
    if (scope.disposed) return;
    // Keep the same fade even on Windows systems with animations disabled.
    mask.style.transitionDuration = `${revealMs}ms`;
    void windowRef.getComputedStyle?.(mask)?.opacity;
    root.dataset.tkStartup = 'revealing';
    await Promise.race([
      new Promise(resolve => scope.timeout(resolve, revealMs)),
      cancelled
    ]);
    dispose();
  })();

  return Object.freeze({ ready, dispose });
}
