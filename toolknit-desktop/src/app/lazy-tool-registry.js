import { createLifecycleScope, normalizeToolInstance } from './tool-lifecycle.js';
import { mountTrustedTemplate } from './trusted-template-runtime.js';

function validateSpec(toolId, spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError(`Missing lazy tool spec for ${toolId}`);
  if (typeof spec.load !== 'function') throw new TypeError(`Lazy tool ${toolId} must provide load()`);
  if (spec.markup && typeof spec.markup !== 'function') throw new TypeError(`Lazy tool ${toolId} markup must be a loader`);
  if (!spec.overlayId || typeof spec.overlayId !== 'string') throw new TypeError(`Lazy tool ${toolId} must provide overlayId`);
  if (!spec.init || typeof spec.init !== 'string') throw new TypeError(`Lazy tool ${toolId} must provide init`);
}

export function validateLazyToolSpecs(specs) {
  if (!specs || typeof specs !== 'object') throw new TypeError('Lazy tool specs must be an object');
  const entries = Object.entries(specs);
  const instanceContracts = new Map();
  for (const [toolId, spec] of entries) {
    validateSpec(toolId, spec);
    const instanceKey = spec.instanceKey || toolId;
    const contract = `${spec.overlayId}:${spec.init}`;
    const previous = instanceContracts.get(instanceKey);
    if (previous && previous !== contract) {
      throw new TypeError(`Lazy tools sharing ${instanceKey} must use the same overlay and initializer`);
    }
    instanceContracts.set(instanceKey, contract);
  }
  return entries;
}

export function createLazyToolRegistry({
  specs,
  root = globalThis.document,
  view = root?.defaultView,
  createContext = () => ({}),
  beforeOpen = () => true,
  onError = (error, toolId) => console.error(`Cannot open ${toolId}:`, error)
} = {}) {
  const specEntries = validateLazyToolSpecs(specs);
  const instances = new Map();
  const pendingLoads = new Map();
  const bindings = createLifecycleScope({ onError: error => onError(error, 'lazy-tool-registry') });
  let activeInstance = null;
  let activeToolId = '';
  let requestRevision = 0;
  let bound = false;
  let disposed = false;

  function report(error, toolId) {
    try { onError(error, toolId); } catch { /* error reporting is best effort */ }
  }

  async function closeActive({ invalidate = true } = {}) {
    if (invalidate) requestRevision += 1;
    const instance = activeInstance;
    const toolId = activeToolId;
    activeInstance = null;
    activeToolId = '';
    if (!instance) return;
    try { await instance.close(); } catch (error) { report(error, toolId); }
  }

  async function loadInstance(toolId, spec) {
    const instanceKey = spec.instanceKey || toolId;
    const existing = instances.get(instanceKey);
    if (existing) return existing;

    let pending = pendingLoads.get(instanceKey);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        let overlay = root?.getElementById?.(spec.overlayId) || null;
        if (!overlay && spec.markup) {
          const templateModule = await spec.markup();
          if (disposed) return null;
          const markup = templateModule?.default ?? templateModule;
          mountTrustedTemplate(markup, { root, host: root?.body });
          overlay = root?.getElementById?.(spec.overlayId) || null;
        }
        if (!overlay) throw new Error(`Missing overlay ${spec.overlayId}`);
        const module = await spec.load();
        if (disposed) return null;
        const initializer = module?.[spec.init];
        if (typeof initializer !== 'function') throw new Error(`Missing ${spec.init}`);
        const context = await createContext({ toolId, spec, overlay });
        if (disposed) return null;
        const created = normalizeToolInstance(initializer({ ...context, overlay }), toolId);
        instances.set(instanceKey, created);
        return created;
      }).finally(() => pendingLoads.delete(instanceKey));
      pendingLoads.set(instanceKey, pending);
    }
    return pending;
  }

  async function open(toolId) {
    if (disposed) return null;
    const spec = specs[toolId];
    if (!spec) return null;
    const requestId = ++requestRevision;
    try {
      const ready = await beforeOpen(toolId, () => open(toolId));
      if (!ready || disposed || requestId !== requestRevision) return null;
      const instance = await loadInstance(toolId, spec);
      if (!instance || disposed || requestId !== requestRevision) return null;
      if (activeInstance && activeInstance !== instance) await closeActive({ invalidate: false });
      if (disposed || requestId !== requestRevision) return null;
      activeInstance = instance;
      activeToolId = toolId;
      await instance.open(toolId);
      if (disposed || requestId !== requestRevision) {
        if (activeInstance === instance) await closeActive();
        return null;
      }
      return instance;
    } catch (error) {
      report(error, toolId);
      return null;
    }
  }

  function bind() {
    if (bound || disposed) return bindings.dispose;
    if (!root?.querySelectorAll || !root?.addEventListener) {
      throw new TypeError('Lazy tool registry requires a DOM-like root to bind launchers');
    }
    bound = true;
    for (const [toolId] of specEntries) {
      const cards = root.querySelectorAll(`.audio-list-item[data-tool="${toolId}"]`);
      for (const card of cards) {
        bindings.event(card, 'click', () => { void open(toolId); });
        bindings.event(card, 'keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          void open(toolId);
        });
      }
    }
    bindings.event(root, 'keydown', event => {
      if (event.key !== 'Escape' || !activeInstance) return;
      const instance = activeInstance;
      queueMicrotask(() => {
        if (event.defaultPrevented || disposed || activeInstance !== instance) return;
        void closeActive();
      });
    });
    if (view?.addEventListener && view?.removeEventListener) {
      bindings.event(view, 'pagehide', () => { void dispose(); }, { once: true });
    }
    return bindings.dispose;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    requestRevision += 1;
    await closeActive({ invalidate: false });
    bindings.dispose();
    const ownedInstances = [...instances.entries()];
    instances.clear();
    pendingLoads.clear();
    for (const [instanceKey, instance] of ownedInstances) {
      try { await instance.dispose(); } catch (error) { report(error, instanceKey); }
    }
  }

  return {
    bind,
    closeActive,
    dispose,
    open,
    get activeToolId() { return activeToolId; },
    get disposed() { return disposed; },
    get loadedInstanceCount() { return instances.size; }
  };
}
