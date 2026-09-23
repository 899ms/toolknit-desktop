import { THEME_STORAGE_KEY } from './theme-runtime.js';

export const CUSTOM_BACKGROUND_STORAGE_KEY = 'toolknit.customBackground.v1';
export const BACKGROUND_DEFAULT_INITIALIZED_KEY = 'toolknit.customBackground.defaultInitialized.v1';
export const DEFAULT_DARK_BACKGROUND_SRC = '/assets/backgrounds/default-dark-mountain.jpg';
export const DEFAULT_DARK_BACKGROUND = Object.freeze({
  type: 'image',
  src: DEFAULT_DARK_BACKGROUND_SRC,
  name: 'default-dark-mountain.jpg'
});

/** Seed once, before any theme switch. Existing preferences and cleared
 * wallpapers must never be replaced by a newly introduced default. */
export function initializeDefaultBackground(windowRef = globalThis.window) {
  try {
    const storage = windowRef?.localStorage;
    if (!storage || storage.getItem(BACKGROUND_DEFAULT_INITIALIZED_KEY) !== null) return;
    if (storage.getItem(CUSTOM_BACKGROUND_STORAGE_KEY) === null
      && storage.getItem(THEME_STORAGE_KEY) === null) {
      storage.setItem(CUSTOM_BACKGROUND_STORAGE_KEY, JSON.stringify(DEFAULT_DARK_BACKGROUND));
    }
    storage.setItem(BACKGROUND_DEFAULT_INITIALIZED_KEY, '1');
  } catch {
    // Restricted storage keeps the existing plain-background fallback.
  }
}
