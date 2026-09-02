import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';

function replaceStatus(content, className, title, description = '') {
  const wrapper = document.createElement('div');
  wrapper.className = className;
  if (description) {
    const strong = document.createElement('strong');
    strong.textContent = title;
    const detail = document.createElement('span');
    detail.textContent = description;
    wrapper.append(strong, detail);
  } else {
    const copy = document.createElement('span');
    copy.className = 'hardware-overview-loading-copy';
    copy.textContent = title;
    wrapper.append(copy);
  }
  content.replaceChildren(wrapper);
}

export function createHardwareSnapshotController({
  overlay,
  definition,
  isTauri,
  onLangChange,
  notify = message => window.showToast?.(message),
  tauri = tauriCorePromise
}) {
  const lifecycle = createLifecycleScope();
  const prefix = definition.prefix;
  const refresh = overlay.querySelector(`#${prefix}Refresh`);
  const updatedAt = overlay.querySelector(`#${prefix}UpdatedAt`);
  const content = overlay.querySelector(`#${prefix}Content`);
  if (!refresh || !updatedAt || !content) throw new Error(`${definition.toolId}:missing-runtime-dom`);

  let active = false;
  let disposed = false;
  let loading = false;
  let revision = 0;
  let data = null;
  let scannedAt = null;
  let viewState = 'idle';
  let errorDetail = '';
  let liveTimer = null;
  let liveLoading = false;

  function isCurrent(operation) {
    return active && !disposed && operation === revision;
  }

  function renderLoading() {
    replaceStatus(content, 'hardware-overview-loading', definition.text('scanning'));
  }

  function renderError(title, description) {
    replaceStatus(content, 'hardware-overview-error', title, description);
  }

  function renderData() {
    definition.render(content, data);
    if (scannedAt) updatedAt.textContent = definition.updatedAt(scannedAt);
  }

  function renderCurrentState() {
    if (viewState === 'data' && data) {
      renderData();
      return;
    }
    if (viewState === 'desktop-only') {
      renderError(definition.text('desktopOnlyTitle'), definition.text('desktopOnlyDesc'));
      return;
    }
    if (viewState === 'error') {
      renderError(definition.text('readFailedTitle'), errorDetail || definition.text('readFailedDesc'));
      return;
    }
    renderLoading();
  }

  function stopLiveUpdates() {
    if (liveTimer !== null) clearInterval(liveTimer);
    liveTimer = null;
    liveLoading = false;
  }

  async function refreshLiveData() {
    if (!definition.live || !active || disposed || !isTauri || !data || liveLoading) return;
    const operation = revision;
    liveLoading = true;
    try {
      const { invoke } = await tauri;
      if (!isCurrent(operation)) return;
      const result = await invoke(definition.live.command);
      if (!isCurrent(operation)) return;
      data = definition.live.merge(data, result);
      scannedAt = new Date();
      viewState = 'data';
      renderCurrentState();
    } catch {
      // Live metrics are best-effort; the last complete snapshot stays visible.
    } finally {
      if (isCurrent(operation)) liveLoading = false;
    }
  }

  function startLiveUpdates() {
    stopLiveUpdates();
    if (!definition.live || !active || disposed || !isTauri || !data) return;
    liveTimer = setInterval(() => { void refreshLiveData(); }, definition.live.intervalMs);
  }

  async function load() {
    if (!active || loading || disposed) return;
    const operation = ++revision;
    loading = true;
    stopLiveUpdates();
    viewState = 'loading';
    errorDetail = '';
    renderCurrentState();
    refresh.classList.add('is-loading');
    refresh.disabled = true;
    updatedAt.textContent = '';
    try {
      if (!isTauri) {
        if (isCurrent(operation)) {
          viewState = 'desktop-only';
          renderCurrentState();
        }
        return;
      }
      const { invoke } = await tauri;
      if (!isCurrent(operation)) return;
      const result = await invoke(definition.command);
      if (!isCurrent(operation)) return;
      data = result;
      scannedAt = new Date();
      viewState = 'data';
      renderCurrentState();
      startLiveUpdates();
    } catch (error) {
      if (!isCurrent(operation)) return;
      const detail = String((typeof error === 'string' ? error : error?.message) || '').trim();
      errorDetail = detail;
      viewState = 'error';
      renderCurrentState();
      notify(errorDetail || definition.text('readFailedDesc'));
    } finally {
      if (!isCurrent(operation)) return;
      loading = false;
      refresh.classList.remove('is-loading');
      refresh.disabled = false;
    }
  }

  lifecycle.event(refresh, 'click', () => { void load(); });
  lifecycle.use(onLangChange(() => {
    if (!active) return;
    renderCurrentState();
  }));

  return {
    open() {
      if (disposed || active) return;
      active = true;
      void load();
    },
    close() {
      if (!active) return;
      active = false;
      revision += 1;
      loading = false;
      stopLiveUpdates();
      refresh.classList.remove('is-loading');
      refresh.disabled = false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      revision += 1;
      stopLiveUpdates();
      lifecycle.dispose();
      data = null;
      scannedAt = null;
      viewState = 'idle';
      errorDetail = '';
    },
    refresh() { return load(); },
    refreshLive() { return refreshLiveData(); }
  };
}
