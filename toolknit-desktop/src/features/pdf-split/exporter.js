import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { splitPdfPages } from '../../pdf-split-core.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { t } from '../../i18n.js';

export function createPdfSplitExporter({
  isTauri = false,
  preview,
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

    const blob = new Blob([bytes], { type: 'application/pdf' });
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

  function showSuccess(folder, type, savedCount, failedCount, owner, id) {
    if (!current(owner, id)) return;
    lastSavedFolder = folder;
    if (successCount) successCount.textContent = String(savedCount);
    if (successPath) successPath.textContent = displayFilesystemPath(folder);
    if (successMeta) {
      successMeta.textContent = failedCount > 0
        ? t('home.pdfSplit.partialSave', { saved: savedCount, failed: failedCount })
        : t(type === 'all'
          ? 'home.pdfSplit.successAllMeta'
          : 'home.pdfSplit.successSingleMeta', { count: savedCount });
    }
    successOverlay?.classList.add('visible');
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
    processMask?.classList.add('visible');
    setProgress(type === 'single' ? 10 : 0, t('home.pdfSplit.saving'));

    try {
      const directory = isTauri ? await getOutputDir('PDF_Split') : '~/Downloads';
      assertCurrent(owner, id);
      const savedPaths = [];
      const failures = [];
      await splitPdfPages({
        documents: state.documents,
        pages: state.pages,
        onProgress: async ({ completed, total, output }) => {
          assertCurrent(owner, id);
          setProgress(Math.round((completed / total) * 100), t('home.pdfSplit.saving'));
          try {
            savedPaths.push(await saveBytes(output, directory, owner, id));
          } catch (error) {
            if (!current(owner, id)) throw error;
            console.error('[PDF Split] Output write error:', error);
            failures.push(error);
          }
        }
      });
      assertCurrent(owner, id);
      if (!savedPaths.length) throw failures[0] || new Error('No PDF pages were saved');
      onBeforeSuccess(type);
      showSuccess(directory, type, savedPaths.length, failures.length, owner, id);
    } catch (error) {
      report(error, owner, id);
    } finally {
      const ownsUi = current(owner, id);
      if (id === activeId) {
        saving = false;
        activeId = 0;
      }
      if (ownsUi) {
        processMask?.classList.remove('visible');
        setProgress(0);
        preview.setSaving(false);
      }
    }
  }

  lifecycle.event(successOk, 'click', () => {
    successOverlay?.classList.remove('visible');
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

  function close() {
    revision += 1;
    session?.dispose();
    session = null;
    successOverlay?.classList.remove('visible');
    processMask?.classList.remove('visible');
    setProgress(0);
    lastSavedFolder = '';
  }

  return {
    close,
    dispose() {
      close();
      lifecycle.dispose();
    },
    downloadAll: () => runExport({ selectedOnly: true, type: 'all' }),
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
