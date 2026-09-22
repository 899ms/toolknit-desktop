import { loadTauriDialog, loadTauriWebview, tauriCorePromise } from '../../platform/tauri-runtime.js';
import { setModalInteractivity } from '../../app/modal-runtime.js';

export const PPTX_ACCEPT = '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function fileNameFromPath(path) {
  return String(path || '').split(/[/\\]/).pop() || String(path || '');
}

export function isPptxFile(file) {
  return String(file?.name || file?.path || '').toLowerCase().endsWith('.pptx');
}

export function dragHasExternalFiles(event) {
  const transfer = event?.dataTransfer;
  if (!transfer) return false;
  const types = Array.from(transfer.types || []);
  return types.includes('Files') || transfer.files?.length > 0;
}

export function normalizeDesktopBytes(rawBytes) {
  if (rawBytes instanceof Uint8Array) return rawBytes;
  if (rawBytes instanceof ArrayBuffer) return new Uint8Array(rawBytes);
  if (ArrayBuffer.isView(rawBytes)) {
    return new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  }
  if (Array.isArray(rawBytes)) return Uint8Array.from(rawBytes);
  if (rawBytes && typeof rawBytes.length === 'number') return Uint8Array.from(rawBytes);
  return new Uint8Array();
}

export function joinPath(directory, fileName) {
  const root = String(directory || '').replace(/[\\/]+$/, '');
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root}${separator}${fileName}`;
}

export function setInteractiveLayer(element, visible) {
  if (!element) return;
  element.classList.toggle('visible', visible);
  setModalInteractivity(element, visible);
}

export function waitForScope(scope, delay) {
  return new Promise(resolve => {
    let settled = false;
    let release = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      resolve(true);
    };
    const timer = setTimeout(finish, delay);
    release = scope.use(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function retainBrowserObjectUrl(scope, url, delay = 1000) {
  if (!scope || !url || typeof globalThis.URL?.revokeObjectURL !== 'function') return () => {};
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    globalThis.URL.revokeObjectURL(url);
  };
  scope.use(release);
  scope.timeout(release, delay);
  return release;
}

export function createOperationGuard(getSession) {
  let revision = 0;
  let active = null;

  function begin() {
    active?.scope?.dispose();
    const session = getSession();
    if (!session || session.disposed) return null;
    const id = ++revision;
    const operation = { id, session, scope: null };
    active = operation;
    return operation;
  }

  function attachScope(operation, scope) {
    if (operation) operation.scope = scope;
    return operation;
  }

  function isCurrent(operation) {
    return Boolean(operation && active === operation && operation.id === revision
      && operation.session === getSession() && !operation.session.disposed);
  }

  function assertCurrent(operation, message = 'ppt-workflow:cancelled') {
    if (!isCurrent(operation)) throw new Error(message);
  }

  function finish(operation) {
    if (active !== operation) return;
    active = null;
    operation.scope?.dispose();
  }

  function cancel() {
    revision += 1;
    const operation = active;
    active = null;
    operation?.scope?.dispose();
  }

  return { assertCurrent, attachScope, begin, cancel, finish, isCurrent, get active() { return active; } };
}

export async function choosePptxFile({ isTauri, input, onSelected, onError }) {
  if (!isTauri) {
    input?.click();
    return;
  }
  try {
    const { open } = await loadTauriDialog();
    const selected = await open({
      multiple: false,
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }]
    });
    if (typeof selected === 'string') {
      await onSelected({ name: fileNameFromPath(selected), path: selected, size: 0 });
    }
  } catch (error) {
    onError(error);
  }
}

export async function readPptxFile(file, { isTauri, maxBytes, errorPrefix }) {
  if (!isPptxFile(file)) throw new Error(`${errorPrefix}:invalid_extension`);
  if (isTauri && file.path) {
    const { invoke } = await tauriCorePromise;
    return normalizeDesktopBytes(await invoke('read_file_bytes_limited', {
      path: file.path,
      maxBytes
    }));
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`${errorPrefix}:input_too_large`);
  return bytes;
}

export async function uniqueOutputDirectory({ getOutputDir, isTauri, category, baseName }) {
  const root = await getOutputDir(category);
  if (!isTauri) return joinPath(root, baseName);
  const { invoke } = await tauriCorePromise;
  for (let counter = 0; counter < 1000; counter += 1) {
    const candidate = joinPath(root, counter ? `${baseName}_${counter}` : baseName);
    const exists = await invoke('exists_path', { path: candidate }).catch(() => false);
    if (!exists) return candidate;
  }
  return joinPath(root, `${baseName}_${Date.now()}`);
}

export async function writeUniqueFile(invoke, directory, fileName, bytes) {
  return invoke('write_unique_file_bytes', {
    directory,
    fileName,
    bytes: Array.from(bytes)
  });
}

export async function registerNativePptxDrop({ owner, isCurrent, onDrop, onVisibility, onUnsupported }) {
  const { getCurrentWebview } = await loadTauriWebview();
  if (!isCurrent()) return;
  const unlisten = await getCurrentWebview().onDragDropEvent(event => {
    if (!isCurrent()) return;
    const payload = event.payload;
    if (payload.type === 'enter' || payload.type === 'over') {
      const paths = payload.paths || [];
      onVisibility(paths.length < 1 || paths.some(path => /\.pptx$/i.test(path)));
      return;
    }
    if (payload.type === 'leave') {
      onVisibility(false);
      return;
    }
    if (payload.type !== 'drop') return;
    onVisibility(false);
    const path = (payload.paths || []).find(candidate => /\.pptx$/i.test(candidate));
    if (!path) {
      onUnsupported();
      return;
    }
    void onDrop({ name: fileNameFromPath(path), path, size: 0 });
  });
  if (!isCurrent() || owner.disposed) {
    unlisten();
    return;
  }
  owner.use(unlisten);
}

export function bindPptChrome(scope, overlay, {
  onClose,
  openSettings = () => {},
  openSupport = () => {},
  openExternalUrl = () => {},
  handleWindowAction = () => {}
} = {}) {
  scope.event(overlay, 'click', event => {
    const hostTarget = event.target.closest('[data-ppt-host-action], [data-home-link], [data-open-support]');
    const hostAction = hostTarget?.dataset.pptHostAction
      || hostTarget?.dataset.homeLink
      || (hostTarget?.hasAttribute('data-open-support') ? 'support' : '');
    if (hostAction === 'settings') openSettings();
    else if (hostAction === 'support') openSupport();
    else if (hostAction === 'website') openExternalUrl('https://toolknit.com');
    const windowTarget = event.target.closest('[data-ppt-window-action], [data-action]');
    const windowAction = windowTarget?.dataset.pptWindowAction || windowTarget?.dataset.action;
    if (windowAction) handleWindowAction(windowAction);
  });
  const back = overlay.querySelector('[id$="Back"]');
  if (back) scope.event(back, 'click', () => onClose?.());
  const settings = overlay.querySelector('[id$="V2Settings"]');
  if (settings) scope.event(settings, 'click', () => openSettings());
}
