const DEFAULT_LOW_POWER_FPS = 30;

function prefersReducedMotion(windowRef) {
  try {
    return Boolean(windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}
/**
 * Background effects are decorative work. Keep them in sync with the display
 * on capable devices, but reduce their render rate on constrained systems so
 * foreground controls and previews keep the frame budget.
 */
export function isConstrainedAnimationDevice({
  windowRef = globalThis.window,
  navigatorRef = globalThis.navigator
} = {}) {
  const cores = Number(navigatorRef?.hardwareConcurrency);
  const memory = Number(navigatorRef?.deviceMemory);
  const saveData = Boolean(navigatorRef?.connection?.saveData);
  return saveData
    || prefersReducedMotion(windowRef)
    || (Number.isFinite(cores) && cores > 0 && cores <= 4)
    || (Number.isFinite(memory) && memory > 0 && memory <= 4);
}

export function createBackgroundFrameLimiter({
  windowRef = globalThis.window,
  navigatorRef = globalThis.navigator,
  lowPowerFps = DEFAULT_LOW_POWER_FPS
} = {}) {
  const fps = Math.max(1, Number(lowPowerFps) || DEFAULT_LOW_POWER_FPS);
  const interval = isConstrainedAnimationDevice({ windowRef, navigatorRef })
    ? 1000 / fps
    : 0;
  let lastRenderAt = -Infinity;

  return Object.freeze({
    interval,
    shouldRender(now) {
      const time = Number(now);
      if (!Number.isFinite(time)) return true;
      if (interval > 0 && time - lastRenderAt < interval) return false;
      lastRenderAt = time;
      return true;
    },
    reset() {
      lastRenderAt = -Infinity;
    }
  });
}
