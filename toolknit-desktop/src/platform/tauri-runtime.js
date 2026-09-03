import * as tauriCore from '@tauri-apps/api/core';
import * as tauriEvent from '@tauri-apps/api/event';
import * as tauriWindow from '@tauri-apps/api/window';

// Keep the current promise-shaped contract while centralizing platform imports.
export const tauriCorePromise = Promise.resolve(tauriCore);
export const tauriEventPromise = Promise.resolve(tauriEvent);
// Window APIs are exposed only through this platform boundary. Feature and
// application modules must not import @tauri-apps/api/window directly.
export const { LogicalSize, currentMonitor, getCurrentWindow } = tauriWindow;

export function loadTauriDialog() {
  return import('@tauri-apps/plugin-dialog');
}

export function loadTauriWebview() {
  return import('@tauri-apps/api/webview');
}

export function loadTauriApp() {
  return import('@tauri-apps/api/app');
}
