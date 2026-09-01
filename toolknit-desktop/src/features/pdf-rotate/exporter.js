import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { createPdfRotateFileName, rotatePdfPages } from '../../pdf-rotate-core.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { t } from '../../i18n.js';

function outputParent(path) {
  return String(path || '').replace(/[/\\][^/\\]+$/, '').replace(/\//g, '\\');
}

export function createPdfRotateExporter({
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
  formatError = error => String(error?.message || error),
  showError = message => window.alert(message)
} = {}) {
  const lifecycle = createLifecycleScope();
  const objectUrls = new Map();
  let session = null;
  let revision = 0;
  let activeId = 0;
  let saving = false;
  let lastSavedPath = '';

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
    if (!current(owner, id)) throw new Error('PDF rotate export cancelled');
  }

  function setSaving(value, owner = session) {
    saving = value;
    if (owner === session && !owner?.disposed) preview.setSaving(value);
  }

  async function saveBytes(bytes, fileName, owner, id) {
    assertCurrent(owner, id);
    if (isTauri) {
      const { invoke } = await tauriCorePromise;
      const directory = await getOutputDir('PDF_Rotate');
      assertCurrent(owner, id);
      return invoke('write_unique_file_bytes', {
        directory,
        fileName,
        bytes: Array.from(bytes)
      });
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
    return `~/Downloads/${fileName}`;
  }

  function showSuccess(path, type, count, owner, id) {
    if (!current(owner, id)) return;
    lastSavedPath = path;
    if (successCount) successCount.textContent = String(count);
    if (successPath) successPath.textContent = displayFilesystemPath(path);
    if (successMeta) {
      successMeta.textContent = t(type === 'all'
        ? 'home.pdfRotate.successAllMeta'
        : 'home.pdfRotate.successSingleMeta');
    }
    successOverlay?.classList.add('visible');
  }

  function report(error, owner, id) {
    if (!current(owner, id) || /cancelled/i.test(String(error?.message || error))) return;
    console.error('[PDF Rotate] export error:', error);
    showError(t('common.errorOccurred', { error: formatError(error) }));
  }

  async function runExport(work) {
    if (saving || !session || session.disposed) return;
    const owner = session;
    const id = ++revision;
    activeId = id;
    setSaving(true, owner);
    processMask?.classList.add('visible');
    try {
      await work(owner, id);
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

  async function downloadSingle(index) {
    const state = preview.getExportState();
    const page = state?.pages[index];
    if (!state?.fileData || !page) return;
    await runExport(async (owner, id) => {
      setProgress(15, t('home.pdfRotate.saving'));
      const bytes = await rotatePdfPages({
        fileData: state.fileData,
        pages: [{ pageIndex: page.pageIndex, rotation: page.rotation }],
        onProgress: () => {
          assertCurrent(owner, id);
          setProgress(85, t('home.pdfRotate.saving'));
        }
      });
      const fileName = createPdfRotateFileName(page.fileName, page.pageIndex);
      const path = await saveBytes(bytes, fileName, owner, id);
      showSuccess(path, 'single', 1, owner, id);
    });
  }

  async function downloadAll() {
    const state = preview.getExportState();
    if (!state?.fileData || !state.pages.length) return;
    await runExport(async (owner, id) => {
      setProgress(5, t('home.pdfRotate.saving'));
      const bytes = await rotatePdfPages({
        fileData: state.fileData,
        pages: state.pages.map(({ pageIndex, rotation }) => ({ pageIndex, rotation })),
        onProgress: ({ completed, total }) => {
          assertCurrent(owner, id);
          setProgress(10 + Math.round((completed / total) * 80), t('home.pdfRotate.saving'));
        }
      });
      const fileName = createPdfRotateFileName(state.fileName);
      const path = await saveBytes(bytes, fileName, owner, id);
      showSuccess(path, 'all', state.pages.length, owner, id);
    });
  }

  lifecycle.event(successOk, 'click', () => successOverlay?.classList.remove('visible'));
  lifecycle.event(successOpenFolder, 'click', async () => {
    if (!isTauri || !lastSavedPath) return;
    try {
      const { invoke } = await tauriCorePromise;
      await invoke('open_path', { path: outputParent(lastSavedPath) });
    } catch (error) {
      console.error('[PDF Rotate] Open folder error:', error);
    }
  });

  function close() {
    revision += 1;
    session?.dispose();
    session = null;
    successOverlay?.classList.remove('visible');
    processMask?.classList.remove('visible');
    setProgress(0);
    lastSavedPath = '';
  }

  return {
    close,
    dispose() {
      close();
      lifecycle.dispose();
    },
    downloadAll,
    downloadSingle,
    open() {
      session?.dispose();
      session = createLifecycleScope();
      successOverlay?.classList.remove('visible');
      lastSavedPath = '';
      if (!saving) preview.setSaving(false);
    },
    get busy() { return saving; }
  };
}
