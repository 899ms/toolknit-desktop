import * as tauriCore from '@tauri-apps/api/core';
import * as tauriEvent from '@tauri-apps/api/event';

// Keep the current promise-shaped contract while centralizing platform imports.
export const tauriCorePromise = Promise.resolve(tauriCore);
export const tauriEventPromise = Promise.resolve(tauriEvent);

export function loadTauriDialog() {
  return import('@tauri-apps/plugin-dialog');
}

export function loadTauriWebview() {
  return import('@tauri-apps/api/webview');
}

export function loadTauriApp() {
  return import('@tauri-apps/api/app');
}
