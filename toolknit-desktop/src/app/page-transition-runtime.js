import { createLifecycleScope } from './tool-lifecycle.js';

const DEFAULT_COVER_MS = 250;
export const DEFAULT_REVEAL_MS = 350;

function reducedMotion(windowRef) {
  try {
    return Boolean(windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

/** Owns one visual-only veil for app-level page changes. */
export function createPageTransitionRuntime({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  coverMs = DEFAULT_COVER_MS,
  revealMs = DEFAULT_REVEAL_MS
} = {}) {
  const scope = createLifecycleScope();
  const safeCoverMs = Math.max(0, Number(coverMs) || DEFAULT_COVER_MS);
  const safeRevealMs = Math.max(0, Number(revealMs) || DEFAULT_REVEAL_MS);
  let veil = null;
  let sequence = 0;
  let queue = Promise.resolve();
  let disposed = false;

  function ensureVeil() {
    if (disposed) return null;
    if (veil?.isConnected) return veil;
    veil = documentRef?.createElement?.('div') || null;
    if (!veil) return null;
    veil.className = 'tk-page-transition-veil';
    veil.setAttribute('aria-hidden', 'true');
    veil.setAttribute('inert', '');
    veil.dataset.tkPageTransitionVeil = 'true';
    documentRef.body?.append(veil);
    scope.use(() => veil?.remove());
    return veil;
  }

  function wait(milliseconds, { forceMotion = false } = {}) {
    if (disposed || milliseconds <= 0 || (!forceMotion && reducedMotion(windowRef))) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      let release = () => {};
      const finish = () => {
        if (settled) return;
        settled = true;
        release();
        resolve();
      };
      scope.timeout(finish, milliseconds);
      release = scope.use(() => resolve());
    });
  }

  function waitForAnimations(animations) {
    if (disposed || !animations.length) return Promise.resolve();
    return new Promise(resolve => {
      const release = scope.use(resolve);
      Promise.allSettled(animations.map(animation => animation.finished)).then(release);
    });
  }

  function nextFrame() {
    if (disposed || documentRef?.hidden || !windowRef?.requestAnimationFrame) return Promise.resolve();
    return new Promise(resolve => {
      const frame = windowRef.requestAnimationFrame(() => release());
      const fallback = setTimeout(() => release(), 100);
      const release = scope.use(() => {
        windowRef.cancelAnimationFrame(frame);
        clearTimeout(fallback);
        resolve();
      });
    });
  }

  async function settlePageLayers() {
    // open()/close() can return as soon as .visible changes. The page's own
    // CSS fade is still running then and would expose home through the veil.
    await nextFrame();
    if (disposed) return;
    const transitions = (documentRef?.getAnimations?.() || []).filter(animation => {
      const target = animation.effect?.target;
      return target !== veil && target?.matches?.('[id$="Overlay"]')
        && ['opacity', 'visibility', 'transform'].includes(animation.transitionProperty)
        && animation.playState !== 'paused';
    });
    await waitForAnimations(transitions);
    await nextFrame();
  }

  function clearInlineState(element) {
    const style = element?.style;
    style?.removeProperty?.('opacity');
    style?.removeProperty?.('visibility');
    style?.removeProperty?.('pointer-events');
  }

  function normalizeHiddenState(element) {
    const style = element?.style;
    if (!style) return;
    style.opacity = '0';
    style.visibility = 'hidden';
    style.pointerEvents = 'none';
  }

  function setThemeSwitching(active) {
    const root = documentRef?.documentElement;
    if (!root) return;
    root.classList.toggle('tk-theme-switching', Boolean(active));
  }

  async function setCovered(covered, milliseconds, { forceMotion = false } = {}) {
    const element = ensureVeil();
    if (!element) return;
    if (element.style) element.style.transitionDuration = `${milliseconds}ms`;
    if (covered) {
      // Keep the veil visible while a prior reveal is still fading out. This
      // makes rapid navigation deterministic instead of relying on a delayed
      // visibility transition to switch state at exactly the right moment.
      clearInlineState(element);
      element.classList.toggle('is-revealing', false);
      // Establish the transparent start style even on the first navigation.
      void windowRef?.getComputedStyle?.(element)?.opacity;
      element.classList.toggle('is-active', true);
      await wait(milliseconds, { forceMotion });
      await waitForAnimations(element.getAnimations?.() || []);
      return;
    }

    element.classList.toggle('is-active', false);
    if (milliseconds > 0 && (forceMotion || !reducedMotion(windowRef))) {
      element.classList.toggle('is-revealing', true);
      await wait(milliseconds, { forceMotion });
      await waitForAnimations(element.getAnimations?.() || []);
      element.classList.toggle('is-revealing', false);
      // CSS transitions can settle on a tiny non-zero floating-point value
      // when a rapid navigation ends on a frame boundary. Normalize the
      // terminal state so hit testing and diagnostics agree with the runtime.
      normalizeHiddenState(element);
      return;
    }
    element.classList.toggle('is-revealing', false);
    normalizeHiddenState(element);
  }

  function run(action, { replaceable = true, mode = 'page' } = {}) {
    if (typeof action !== 'function') return Promise.reject(new TypeError('Page transition action must be a function'));
    // Theme changes must execute even when navigation is queued alongside them.
    // They also must not supersede a navigation request.
    const request = replaceable ? ++sequence : sequence;
    const current = () => !replaceable || request === sequence;
    const themeChange = mode === 'theme';
    const execute = async () => {
      if (disposed) return undefined;
      if (!current()) return undefined;
      const motionReduced = reducedMotion(windowRef);
      // Theme changes are deliberately covered even when Windows/WebView
      // reports reduced motion. Without this exception the palette can flash
      // between frames and the requested theme transition disappears entirely.
      const animate = !motionReduced || themeChange;
      if (themeChange) setThemeSwitching(true);
      try {
        if (animate) await setCovered(true, safeCoverMs, { forceMotion: themeChange });
        if (disposed || !current()) return undefined;
        return await (async () => {
          try {
            return await action();
          } finally {
            if (animate && !disposed && current()) {
              await settlePageLayers();
              if (!disposed && current()) await setCovered(false, safeRevealMs, { forceMotion: themeChange });
            }
          }
        })();
      } finally {
        if (themeChange) setThemeSwitching(false);
      }
    };
    const task = queue.then(execute, execute);
    queue = task.catch(() => {});
    return task;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    sequence += 1;
    veil?.classList.toggle('is-active', false);
    veil?.classList.toggle('is-revealing', false);
    setThemeSwitching(false);
    scope.dispose();
    veil = null;
  }

  if (windowRef?.addEventListener) scope.event(windowRef, 'pagehide', dispose, { once: true });

  return Object.freeze({ dispose, run });
}
