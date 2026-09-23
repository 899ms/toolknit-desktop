import artwork from './assets/home-weaving.svg?raw';
import { mountTrustedTemplate } from './trusted-template-runtime.js';
import { createLifecycleScope } from './tool-lifecycle.js';
import { isConstrainedAnimationDevice } from '../shared/animation-policy.js';

/** Owns the decorative home animation; links use the existing home-link handler. */
export function createHomeWeaving({ root = globalThis.document } = {}) {
  const scope = createLifecycleScope();
  const stage = root?.querySelector?.('.home-weaving');
  const host = stage?.querySelector('.home-weaving-art');
  const view = root?.defaultView;
  if (!host || !view) return { dispose: scope.dispose };

  // Only this bundled, script-free SVG is mounted as trusted markup.
  const nodes = mountTrustedTemplate(artwork, { root, host });
  let inView = false;
  const motion = view.matchMedia('(prefers-reduced-motion: reduce)');
  const sync = () => {
    const constrained = isConstrainedAnimationDevice({ windowRef: view, navigatorRef: view.navigator });
    stage.classList.toggle('is-static', constrained);
    stage.classList.toggle('is-playing', inView && !root.hidden && !constrained);
  };
  const observer = new view.IntersectionObserver(entries => {
    inView = entries.some(entry => entry.isIntersecting);
    sync();
  }, { threshold: 0 });
  observer.observe(stage);
  scope.use(() => observer.disconnect());
  scope.event(root, 'visibilitychange', sync);
  scope.event(motion, 'change', sync);
  scope.use(() => {
    stage.classList.remove('is-playing', 'is-static');
    nodes.forEach(node => node.remove());
  });
  sync();
  return { dispose: scope.dispose };
}
