const WINDOW_RADIUS_KEY = 'toolknit.window-radius.v1';
const WINDOW_RADIUS_PRESETS = Object.freeze({ none: 0, small: 10, large: 18 });
const WINDOW_RADIUS_CUSTOM_DEFAULT = 10;
const WINDOW_RADIUS_MAX = 32;

function clampRadius(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return WINDOW_RADIUS_CUSTOM_DEFAULT;
  return Math.max(0, Math.min(WINDOW_RADIUS_MAX, Math.round(numeric)));
}

/**
 * Owns native window chrome state and its CSS fallback. The application only
 * supplies platform primitives and receives a small, stable controller API.
 */
export function createWindowRuntime({
  appWindow = null,
  isTauri = false,
  isScreenPickerWindow = false,
  tauriCorePromise,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  storage = globalThis.localStorage,
  translate = key => key,
  refreshIcons = () => {}
} = {}) {
  let radiusQueue = Promise.resolve();
  let chromeQueue = Promise.resolve();
  let chromeTimer = 0;
  let radiusTimer = null;
  let frameTimer = 0;
  let maximizeQueue = Promise.resolve();

  const clearLegacyRadiusStyles = () => {
    documentRef?.querySelectorAll?.('html, body, .app, .settings-overlay, .global-window-controls, .transition-mask')
      .forEach(layer => {
        layer.style.removeProperty('border-radius');
        layer.style.removeProperty('clip-path');
        layer.style.removeProperty('-webkit-clip-path');
        layer.style.removeProperty('overflow');
      });
  };

  const read = () => {
    try {
      const parsed = JSON.parse(storage?.getItem(WINDOW_RADIUS_KEY) || 'null');
      const mode = ['none', 'small', 'large', 'custom'].includes(parsed?.mode) ? parsed.mode : 'none';
      return { mode, custom: clampRadius(parsed?.custom ?? WINDOW_RADIUS_CUSTOM_DEFAULT) };
    } catch {
      return { mode: 'none', custom: WINDOW_RADIUS_CUSTOM_DEFAULT };
    }
  };

  const pixels = (setting = read()) => setting.mode === 'custom'
    ? clampRadius(setting.custom)
    : WINDOW_RADIUS_PRESETS[setting.mode] ?? 0;

  const applyNativeRadius = radius => {
    if (!isTauri) return;
    radiusQueue = radiusQueue
      .catch(() => undefined)
      .then(async () => {
        const { invoke } = await tauriCorePromise;
        await invoke('set_window_corner_radius', { radius });
      })
      .catch(error => console.warn('Native window corner radius is unavailable:', error));
  };

  const repairChrome = () => {
    if (!isTauri || !appWindow || isScreenPickerWindow) return Promise.resolve();
    chromeQueue = chromeQueue
      .catch(() => undefined)
      .then(async () => {
        const decorated = typeof appWindow.isDecorated === 'function'
          ? await appWindow.isDecorated()
          : true;
        if (decorated && typeof appWindow.setDecorations === 'function') {
          await appWindow.setDecorations(false);
        }
      })
      .catch(error => console.warn('Native frameless chrome repair failed:', error));
    return chromeQueue;
  };

  const apply = (setting = read()) => {
    if (isScreenPickerWindow) return 0;
    const radius = pixels(setting);
    const value = `${radius}px`;
    const root = documentRef?.documentElement;
    const body = documentRef?.body;
    root?.style.setProperty('--toolknit-window-radius', value);
    if (root) root.dataset.windowRadius = setting.mode;
    body?.classList.remove('use-native-window-radius');
    body?.classList.toggle('use-css-window-radius', radius > 0);
    body?.style.setProperty('--toolknit-window-radius', value);
    body?.setAttribute('data-window-radius', setting.mode);
    documentRef?.querySelectorAll?.('.app, .settings-overlay, .global-window-controls, .transition-mask')
      .forEach(layer => layer.style.setProperty('--toolknit-window-radius', value));
    clearLegacyRadiusStyles();
    if (isTauri) {
      applyNativeRadius(radius);
    } else if (body) {
      root?.style.setProperty('border-radius', value, 'important');
      root?.style.setProperty('overflow', 'hidden', 'important');
      root?.style.setProperty('clip-path', `inset(0 round ${value})`, 'important');
      root?.style.setProperty('-webkit-clip-path', `inset(0 round ${value})`, 'important');
    }
    return radius;
  };

  const setMaximizedState = enabled => {
    const maximized = Boolean(enabled);
    documentRef?.documentElement?.classList.toggle('window-is-maximized', maximized);
    documentRef?.body?.classList.toggle('window-is-maximized', maximized);
    const iconName = maximized ? 'copy' : 'square';
    const labelKey = maximized ? 'common.restore' : 'common.maximize';
    const label = translate(labelKey);
    let iconChanged = false;
    documentRef?.querySelectorAll?.('.ctrl-btn[data-action="maximize"]').forEach(button => {
      const icon = button.querySelector('[data-lucide]');
      if (icon && icon.getAttribute('data-lucide') !== iconName) {
        icon.setAttribute('data-lucide', iconName);
        iconChanged = true;
      }
      button.dataset.i18nTitle = labelKey;
      button.dataset.i18nAriaLabel = labelKey;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', maximized ? 'true' : 'false');
    });
    if (iconChanged) {
      try { refreshIcons(); } catch (error) { console.warn('Window control icon refresh failed:', error); }
    }
  };

  const readMaximized = async () => {
    if (!isTauri || !appWindow || isScreenPickerWindow) return false;
    try {
      const maximized = await appWindow.isMaximized();
      const fullscreen = typeof appWindow.isFullscreen === 'function'
        ? await appWindow.isFullscreen().catch(() => false)
        : false;
      return Boolean(maximized || fullscreen);
    } catch { return false; }
  };

  const syncFrame = async () => {
    if (!isTauri || !appWindow || isScreenPickerWindow || !documentRef?.body) return;
    setMaximizedState(await readMaximized());
  };

  const syncAfterLayout = () => {
    if (!isTauri || !appWindow || isScreenPickerWindow) return;
    [0, 180].forEach(delay => windowRef?.setTimeout?.(async () => {
      await syncFrame();
      apply(read());
    }, delay));
  };

  const scheduleChromeRepair = ({ reapplyRadius = true } = {}) => {
    if (!isTauri || !appWindow || isScreenPickerWindow) return;
    windowRef?.clearTimeout?.(chromeTimer);
    chromeTimer = windowRef?.setTimeout?.(() => {
      chromeTimer = 0;
      repairChrome().finally(() => { if (reapplyRadius) apply(read()); });
    }, 140) || 0;
  };

  const scheduleFrameSync = () => {
    if (!isTauri || !appWindow || isScreenPickerWindow) return;
    windowRef?.clearTimeout?.(frameTimer);
    frameTimer = windowRef?.setTimeout?.(async () => {
      frameTimer = 0;
      await syncFrame();
      apply(read());
    }, 120) || 0;
  };

  const observeFrame = () => {
    if (!isTauri || !appWindow || isScreenPickerWindow) return;
    ['onResized', 'onScaleChanged'].forEach(method => {
      if (typeof appWindow[method] !== 'function') return;
      appWindow[method](scheduleFrameSync).catch(error => console.warn(`Native window ${method} listener failed:`, error));
    });
  };

  const syncRadiusAfterLayout = () => {
    if (!isTauri || !appWindow || isScreenPickerWindow) return;
    windowRef?.clearTimeout?.(radiusTimer);
    radiusTimer = windowRef?.setTimeout?.(() => apply(read()), 80) || null;
  };

  const toggleMaximize = () => {
    if (!isTauri || !appWindow || isScreenPickerWindow) return Promise.resolve();
    maximizeQueue = maximizeQueue
      .catch(() => undefined)
      .then(async () => {
        await appWindow.toggleMaximize();
        await syncFrame();
        scheduleChromeRepair();
        syncAfterLayout();
      });
    return maximizeQueue;
  };

  const handleControl = async action => {
    if (!isTauri || !appWindow || isScreenPickerWindow || !action) return;
    try {
      if (action === 'minimize') await appWindow.minimize();
      else if (action === 'maximize') await toggleMaximize();
      else if (action === 'close') await appWindow.hide();
    } catch (error) { console.error('Window control failed:', error); }
  };

  const save = setting => {
    const normalized = {
      mode: ['none', 'small', 'large', 'custom'].includes(setting?.mode) ? setting.mode : 'none',
      custom: clampRadius(setting?.custom ?? WINDOW_RADIUS_CUSTOM_DEFAULT)
    };
    try { storage?.setItem(WINDOW_RADIUS_KEY, JSON.stringify(normalized)); } catch {}
    apply(normalized);
    return normalized;
  };

  const dispose = () => {
    windowRef?.clearTimeout?.(chromeTimer);
    windowRef?.clearTimeout?.(frameTimer);
    windowRef?.clearTimeout?.(radiusTimer);
    chromeTimer = 0;
    frameTimer = 0;
    radiusTimer = null;
  };

  return Object.freeze({
    apply,
    clampRadius,
    dispose,
    handleControl,
    observeFrame,
    pixels,
    read,
    repairChrome,
    save,
    scheduleChromeRepair,
    setMaximizedState,
    syncAfterLayout,
    syncFrame,
    syncRadiusAfterLayout,
    toggleMaximize
  });
}

export { WINDOW_RADIUS_KEY };
