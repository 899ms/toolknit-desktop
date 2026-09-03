import { loadTauriWebview, tauriCorePromise } from '../../platform/tauri-runtime.js';

export const VIDEO_EXTENSIONS = Object.freeze([
  'mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'wmv', 'ts', 'm4v'
]);

export function fileNameFromPath(filePath) {
  const value = String(filePath || '');
  return value.split(/[\\/]/).pop() || value;
}

export function localVideoFile(filePath, size = 0) {
  return {
    name: fileNameFromPath(filePath),
    path: String(filePath || ''),
    size: Number(size) || 0
  };
}

export function isSupportedVideoPath(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return VIDEO_EXTENSIONS.some(extension => lower.endsWith(`.${extension}`));
}

export function firstSupportedVideoPath(paths) {
  return (Array.isArray(paths) ? paths : []).find(isSupportedVideoPath) || '';
}

export function createPreviewQueue() {
  return { token: 0, timer: null, pending: null, inFlight: false, errorShown: false };
}

export function clearQueuedVideoPreview(state, image) {
  if (!state) return;
  state.token += 1;
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
  state.pending = null;
  state.errorShown = false;
  image?.removeAttribute('src');
  image?.classList.remove('is-loading', 'is-ready');
}

async function runQueuedVideoPreview(state, { notify = () => {}, invoke = null } = {}) {
  if (!state || state.inFlight || !state.pending) return;
  const request = state.pending;
  state.pending = null;
  state.inFlight = true;
  request.image?.classList.add('is-loading');
  try {
    const api = invoke ? { invoke } : await tauriCorePromise;
    const result = await api.invoke('render_video_preview_frame', {
      inputPath: request.inputPath,
      timestampMs: request.timestampMs
    });
    const dataUrl = result?.image_data_url || result?.imageDataUrl;
    if (!dataUrl) throw new Error('video-preview:empty-result');
    if (request.token !== state.token) return;
    request.image.src = dataUrl;
    request.image.classList.add('is-ready');
    state.errorShown = false;
  } catch (error) {
    if (request.token === state.token && !state.errorShown) {
      state.errorShown = true;
      notify('无法生成视频预览帧，仍可继续导出。');
      console.warn('Video preview frame failed:', error);
    }
  } finally {
    state.inFlight = false;
    if (request.token === state.token) request.image?.classList.remove('is-loading');
    if (state.pending) void runQueuedVideoPreview(state, { notify, invoke });
  }
}

export function scheduleVideoPreview(state, image, inputPath, timestampMs, {
  immediate = false,
  notify = () => {},
  invoke = null,
  delay = 100
} = {}) {
  if (!state || !image || !inputPath) return;
  const token = state.token + 1;
  state.token = token;
  state.pending = { token, image, inputPath, timestampMs };
  if (state.timer !== null) clearTimeout(state.timer);
  const start = () => {
    state.timer = null;
    void runQueuedVideoPreview(state, { notify, invoke });
  };
  if (immediate) start();
  else state.timer = setTimeout(start, delay);
}

export async function registerNativeVideoDrop({
  isTauri = false,
  overlay,
  isActive = () => false,
  isBusy = () => false,
  onVisibility = () => {},
  onDrop = () => {},
  onUnsupported = () => {},
  scope
} = {}) {
  if (!isTauri || !overlay) return () => {};
  const { getCurrentWebview } = await loadTauriWebview();
  const unlisten = await getCurrentWebview().onDragDropEvent(event => {
    if (!isActive() || isBusy()) return;
    const payload = event?.payload || {};
    if (payload.type === 'enter' || payload.type === 'over') onVisibility(true);
    else if (payload.type === 'leave') onVisibility(false);
    else if (payload.type === 'drop') {
      onVisibility(false);
      const selected = firstSupportedVideoPath(payload.paths || []);
      if (selected) onDrop(selected);
      else onUnsupported();
    }
  });
  // Register the native listener through the lifecycle and return the guarded
  // release function so callers can safely release it early without invoking
  // the underlying Tauri unlisten twice.
  return scope?.use ? scope.use(unlisten) : unlisten;
}

export function setDropVisible(overlay, dropZone, visible) {
  dropZone?.classList.toggle('visible', visible);
  overlay?.classList.toggle('drag-over', visible);
}
