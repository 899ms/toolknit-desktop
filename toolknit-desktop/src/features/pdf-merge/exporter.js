import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { mergePdfPages } from '../../pdf-merge-core.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { t } from '../../i18n.js';

function outputParent(path) {
  return String(path || '').replace(/[/\\][^/\\]+$/, '').replace(/\//g, '\\');
}

function waitForOwner(owner, delay) {
  return new Promise(resolve => {
    let settled = false;
    let release = () => {};
    const finish = value => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      release();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(true), delay);
    release = owner.use(() => finish(false));
  });
}

export function createPdfMergeExporter({
  isTauri = false,
  preview,
  processMask,
  progressFill,
  processText,
  successOverlay,
  successPath,
  successMeta,
  successCount,
  successOpenFolder,
  successOk,
  getOutputDir,
  displayFilesystemPath,
  getInputCount = () => 0,
  onSuccess = () => {},
  onFailure = () => {},
  onAcknowledge = () => {},
  showError = message => window.alert(message)
} = {}) {
  const lifecycle = createLifecycleScope();
  const objectUrls = new Map();
  let session = null;
  let revision = 0;
  let activeId = 0;
  let committing = false;
  let lastOutputPath = '';

  function revokeObjectUrl(url) {
    const timer = objectUrls.get(url);
    if (timer) window.clearTimeout(timer);
    objectUrls.delete(url);
    URL.revokeObjectURL(url);
  }

  lifecycle.use(() => {
    for (const url of objectUrls.keys()) revokeObjectUrl(url);
  });

  function current(owner, id) {
    return owner && owner === session && !owner.disposed && id === activeId && id === revision;
  }

  function assertCurrent(owner, id) {
    if (!current(owner, id)) throw new Error('PDF merge export cancelled');
  }

  function setProgress(percent, message) {
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (message && processText) processText.textContent = message;
  }

  async function saveBytes(bytes, owner, id) {
    assertCurrent(owner, id);
    if (isTauri) {
      const { invoke } = await tauriCorePromise;
      const directory = await getOutputDir('PDF_Merge');
      assertCurrent(owner, id);
      const path = await invoke('write_unique_file_bytes', {
        directory,
        fileName: 'merged.pdf',
        bytes: Array.from(bytes)
      });
      assertCurrent(owner, id);
      return path;
    }

    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'merged.pdf';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    const timer = window.setTimeout(() => revokeObjectUrl(url), 1000);
    objectUrls.set(url, timer);
    return '~/Downloads/merged.pdf';
  }

  function showSuccess(path, owner, id) {
    if (!current(owner, id)) return;
    const count = getInputCount();
    lastOutputPath = path;
    if (successMeta) successMeta.textContent = t('home.pdfMerge.successSummary', { count });
    if (successCount) successCount.textContent = `${count} ${t('home.pdfMerge.successCountUnit')}`;
    if (successPath) successPath.textContent = displayFilesystemPath(path);
    successOverlay?.classList.add('visible');
  }

  async function commit() {
    if (committing || !session || session.disposed) return;
    const state = preview.getExportState();
    if (!state.documents.length || !state.pages.length) return;
    const owner = session;
    const id = ++revision;
    activeId = id;
    committing = true;
    preview.hideForCommit();
    processMask?.classList.add('visible');
    setProgress(30, t('home.pdfMerge.processing'));
    const startTime = Date.now();

    try {
      const bytes = await mergePdfPages(state);
      assertCurrent(owner, id);
      const path = await saveBytes(bytes, owner, id);
      setProgress(100, t('home.pdfMerge.processing'));
      if (!await waitForOwner(owner, Math.max(0, 1500 - (Date.now() - startTime)))) return;
      assertCurrent(owner, id);
      preview.releaseResources();
      onSuccess();
      showSuccess(path, owner, id);
    } catch (error) {
      if (!current(owner, id) || /cancelled/i.test(String(error?.message || error))) return;
      if (!await waitForOwner(owner, Math.max(0, 1500 - (Date.now() - startTime)))) return;
      if (!current(owner, id)) return;
      console.error('[PDF Merge] export error:', error);
      const restored = preview.restoreAfterError();
      onFailure({ restored });
      showError(t('common.errorOccurred', { error: String(error?.message || error) }));
    } finally {
      const ownsUi = current(owner, id);
      if (id === activeId) {
        committing = false;
        activeId = 0;
      }
      if (ownsUi) {
        processMask?.classList.remove('visible');
        setProgress(0);
      }
    }
  }

  lifecycle.event(successOk, 'click', () => {
    successOverlay?.classList.remove('visible');
    onAcknowledge();
  });
  lifecycle.event(successOpenFolder, 'click', async () => {
    if (!isTauri || !lastOutputPath) return;
    try {
      const { invoke } = await tauriCorePromise;
      await invoke('open_path', { path: outputParent(lastOutputPath) });
    } catch (error) {
      console.error('[PDF Merge] Open folder error:', error);
    }
  });

  function close() {
    revision += 1;
    session?.dispose();
    session = null;
    successOverlay?.classList.remove('visible');
    processMask?.classList.remove('visible');
    setProgress(0);
    lastOutputPath = '';
  }

  return {
    close,
    commit,
    dispose() {
      close();
      lifecycle.dispose();
    },
    open() {
      session?.dispose();
      session = createLifecycleScope();
      successOverlay?.classList.remove('visible');
      lastOutputPath = '';
    },
    get busy() { return committing; }
  };
}
