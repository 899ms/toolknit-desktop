import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { createPdfSplitExportJob } from './export-runtime.js';
import { createModalSession, setModalInteractivity } from '../../app/modal-runtime.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { t } from '../../i18n.js';

export function createPdfSplitExporter({
  isTauri = false,
  preview,
  workspace,
  processMask,
  setProgress,
  successOverlay,
  successPath,
  successMeta,
  successCount,
  successOpenFolder,
  successOk,
  getOutputDir,
  displayFilesystemPath,
  onBeforeSuccess = () => {},
  onAcknowledge = () => {},
  showError = message => window.alert(message)
} = {}) {
  const lifecycle = createLifecycleScope();
  const objectUrls = new Map();
  let session = null;
  let revision = 0;
  let activeId = 0;
  let saving = false;
  let lastSavedFolder = '';
  let activeJob = null;
  const successModal = createModalSession({ root: successOverlay, background: workspace,
    initialFocus: successOk, onClose: () => successModal.close() });
  const processModal = createModalSession({ root: processMask, background: workspace,
    initialFocus: processMask?.querySelector('#pdfSplitProcessCancel'), onClose: () => cancel() });

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
    if (!current(owner, id)) throw new Error('PDF split export cancelled');
  }

  function setSaving(value, owner = session) {
    saving = value;
    if (owner === session && !owner?.disposed) preview.setSaving(value);
  }

  async function saveBytes({ bytes, fileName }, directory, owner, id) {
    assertCurrent(owner, id);
    if (isTauri) {
      const { invoke } = await tauriCorePromise;
      const outputPath = await invoke('write_unique_file_bytes', {
        directory,
        fileName,
        bytes: Array.from(bytes)
      });
      assertCurrent(owner, id);
      return outputPath;
    }

    const blob = new Blob([bytes], { type: fileName.endsWith('.zip') ? 'application/zip' : 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    const timer = window.setTimeout(() => revokeObjectUrl(url), 1000);
    objectUrls.set(url, timer);
    return `${directory}/${fileName}`;
  }

  function showSuccess(folder, type, pageCount, owner, id) {
    if (!current(owner, id)) return;
    lastSavedFolder = folder;
    if (successCount) successCount.textContent = String(type === 'zip' ? pageCount : 1);
    if (successPath) successPath.textContent = displayFilesystemPath(folder);
    if (successMeta) {
      successMeta.textContent = t(type === 'zip' ? 'home.pdfSplit.exportZipMeta' : 'home.pdfSplit.exportPdfMeta', { count: pageCount });
    }
    successModal.open();
  }

  function report(error, owner, id) {
    if (!current(owner, id) || /cancelled/i.test(String(error?.message || error))) return;
    console.error('[PDF Split] export error:', error);
    showError(t('common.errorOccurred', { error: String(error?.message || error) }));
  }

  async function runExport({ index = null, selectedOnly = false, type }) {
    if (saving || !session || session.disposed) return;
    const state = preview.getExportState({ index, selectedOnly });
    if (!state.documents.length || !state.pages.length) return;
    const owner = session;
    const id = ++revision;
    activeId = id;
    setSaving(true, owner);
    processModal.open();
    setProgress(type === 'single' ? 10 : 0, t('home.pdfSplit.saving'));

    try {
      const directory = isTauri ? await getOutputDir('PDF_Split') : '~/Downloads';
      assertCurrent(owner, id);
      const job = createPdfSplitExportJob({
        documents: state.documents,
        pages: state.pages,
        mode: type,
        onProgress: percent => { if (current(owner, id)) setProgress(Math.round(percent), t('home.pdfSplit.saving')); }
      });
      activeJob = job;
      const release = owner.use(() => job.cancel());
      let output;
      try { output = await job.promise; }
      finally { release(); if (activeJob === job) activeJob = null; }
      assertCurrent(owner, id);
      await saveBytes(output, directory, owner, id);
      assertCurrent(owner, id);
      processModal.close();
      onBeforeSuccess(type);
      showSuccess(directory, type, output.pageCount, owner, id);
    } catch (error) {
      report(error, owner, id);
    } finally {
      const ownsUi = current(owner, id);
      if (id === activeId) {
        saving = false;
        activeId = 0;
      }
      if (ownsUi) {
        processModal.close();
        setProgress(0);
        preview.setSaving(false);
      }
    }
  }

  lifecycle.event(successOk, 'click', () => {
    successModal.close();
    onAcknowledge();
  });
  lifecycle.event(successOpenFolder, 'click', async () => {
    if (!isTauri || !lastSavedFolder) return;
    try {
      const { invoke } = await tauriCorePromise;
      await invoke('open_path', { path: lastSavedFolder });
    } catch (error) {
      console.error('[PDF Split] Open folder error:', error);
    }
  });

  function cancel() {
    revision += 1;
    activeJob?.cancel();
    activeJob = null;
    activeId = 0;
    saving = false;
    preview.setSaving(false);
    processModal.close();
    setProgress(0);
  }

  function close() {
    cancel();
    session?.dispose();
    session = null;
    successModal.close({ restore: false });
    setModalInteractivity(successOverlay, false);
    for (const url of objectUrls.keys()) revokeObjectUrl(url);
    lastSavedFolder = '';
  }

  return {
    cancel,
    close,
    dispose() {
      close();
      lifecycle.dispose();
    },
    downloadAll: () => runExport({ selectedOnly: true, type: 'all' }),
    downloadZip: () => runExport({ selectedOnly: true, type: 'zip' }),
    downloadSingle: index => runExport({ index, type: 'single' }),
    open() {
      session?.dispose();
      session = createLifecycleScope();
      successOverlay?.classList.remove('visible');
      lastSavedFolder = '';
      if (!saving) preview.setSaving(false);
    },
    get busy() { return saving; }
  };
}
