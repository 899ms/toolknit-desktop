import { createLifecycleScope } from './tool-lifecycle.js';

export const THEME_STORAGE_KEY = 'toolknit.theme.v3';
export const normalizeTheme = value => value === 'dark' ? 'dark' : 'light';

export function readThemePreference(windowRef = globalThis.window) {
  try { return normalizeTheme(windowRef?.localStorage?.getItem(THEME_STORAGE_KEY)); }
  catch { return 'light'; }
}

/** Owns the saved theme and settings controls, not page or wallpaper rendering. */
export function createThemeRuntime({
  root = globalThis.document,
  windowRef = globalThis.window,
  enabled = true,
  pageTransition = null
} = {}) {
  const scope = createLifecycleScope();
  const listeners = new Set();
  const buttons = [...root?.querySelectorAll?.('[data-theme-choice]') || []];
  let theme = enabled ? readThemePreference(windowRef) : 'dark';
  let revision = 0;

  function render() {
    if (!enabled) return;
    root?.documentElement?.setAttribute('data-theme', theme);
    buttons.forEach(button => {
      const selected = button.dataset.themeChoice === theme;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }

  function set(value, { persist = true, transition = true } = {}) {
    if (!enabled || scope.disposed || !['dark', 'light'].includes(value)) return theme;
    const request = ++revision;
    const apply = () => {
      if (scope.disposed || request !== revision) return theme;
      if (persist) {
        try { windowRef?.localStorage?.setItem(THEME_STORAGE_KEY, value); } catch {}
      }
      const changed = value !== theme;
      theme = value;
      render();
      if (changed) listeners.forEach(listener => listener(theme));
      return theme;
    };
    if (value === theme) return apply();
    if (transition && pageTransition?.run) {
      void pageTransition.run(apply, { replaceable: false, mode: 'theme' }).catch(error => {
        console.error('[Theme] transition failed:', error);
      });
    } else {
      apply();
    }
    return theme;
  }

  function subscribe(listener) {
    if (scope.disposed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    scope.dispose();
    listeners.clear();
  }

  if (enabled) {
    buttons.forEach((button, index) => {
      scope.event(button, 'click', () => set(button.dataset.themeChoice));
      scope.event(button, 'keydown', event => {
        let next;
        if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % buttons.length;
        else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index + buttons.length - 1) % buttons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault();
        buttons[next].focus();
        set(buttons[next].dataset.themeChoice);
      });
    });
    if (windowRef?.addEventListener) {
      scope.event(windowRef, 'storage', event => {
        if (event.key === THEME_STORAGE_KEY || event.key === null) set(readThemePreference(windowRef), { persist: false });
      });
      scope.event(windowRef, 'pagehide', event => { if (!event.persisted) dispose(); });
    }
    render();
  }

  return Object.freeze({ get: () => theme, set, subscribe, dispose, allowsCustomBackground: () => theme === 'dark' });
}
