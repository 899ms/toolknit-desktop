import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { createModalSession, setModalInteractivity } from '../../app/modal-runtime.js';
import { PDF_SPLIT_LIMITS, assertPdfSplitSelection } from '../../pdf-split-core.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { bindSortableFileList } from '../../shared/sortable-file-list.js';
import { t } from '../../i18n.js';
import { createPdfSplitExporter } from './exporter.js';
import { createPdfSplitPreview } from './preview.js';
import './pdf-split.css';

function fileNameFromPath(path) {
  return String(path || '').split(/[/\\]/).pop() || String(path || '');
}

function normalizeBytes(bytes, fileName) {
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes && typeof bytes.length === 'number') return Uint8Array.from(bytes);
  throw new Error(`Invalid file data for ${fileName}`);
}

export function initPdfSplitTool({
  overlay,
  isTauri = false,
  displayFilesystemPath,
  getOutputDir,
  notify = () => {},
  refreshIcons = () => {},
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance,
  showError = message => window.alert(message)
} = {}) {
  if (!overlay) throw new Error('pdf-split:missing-overlay');
  if (typeof displayFilesystemPath !== 'function') throw new Error('pdf-split:missing-path-display');
  if (typeof getOutputDir !== 'function') throw new Error('pdf-split:missing-output-directory');

  const lifecycle = createLifecycleScope();
  const byId = id => document.getElementById(id);
  const background = byId('pdfSplitPlasmaBg');
  const back = byId('pdfSplitBack');
  const dropZone = byId('pdfSplitDropZone');
  const fileList = byId('pdfSplitFiles');
  const cta = byId('pdfSplitCta');
  const processButton = byId('pdfSplitProcessBtn');
  const processMask = byId('pdfSplitProcessMask');
  const progressFill = byId('pdfSplitProcessBarFill');
  const progressText = byId('pdfSplitProcessText');
  let session = null;
  let fileScope = null;
  let pickerScope = null;
  let pickerOwnerRelease = null;
  let plasma = null;
  let files = [];
  let processing = false;
  let runRevision = 0;
  let activeRunId = 0;
  let exporter = null;
  const processModal = createModalSession({ root: processMask, background: overlay,
    initialFocus: byId('pdfSplitProcessCancel'), onClose: () => cancelProcessing() });
  const isDemo = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('pdf-split-demo') === '1';

  const isOpenSession = owner => owner && owner === session && !owner.disposed
    && overlay.classList.contains('visible');
  const isCurrentRun = (owner, runId) => isOpenSession(owner) && runId === runRevision;

  function setProgress(percent, message) {
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (message && progressText) progressText.textContent = message;
  }

  const preview = createPdfSplitPreview({
    overlay,
    workspace: byId('pdfSplitWorkspace'),
    workspaceClose: byId('pdfSplitWorkspaceClose'),
    workspaceStatus: byId('pdfSplitWorkspaceStatus'),
    workspaceHint: byId('pdfSplitWorkspaceHint'),
    pageStrip: byId('pdfSplitPageStrip'),
    selectedCount: byId('pdfSplitSelectedCount'),
    selectionMeta: byId('pdfSplitSelectionMeta'),
    selectAllButton: byId('pdfSplitSelectAllBtn'),
    downloadAllButton: byId('pdfSplitDownloadAllBtn'),
    isSaving: () => Boolean(exporter?.busy),
    onDownloadPage: index => exporter?.downloadSingle(index),
    onDownloadAll: () => exporter?.downloadAll(),
    onDownloadZip: () => exporter?.downloadZip(),
    refreshIcons
  });

  exporter = createPdfSplitExporter({
    isTauri,
    preview,
    processMask,
    setProgress,
    successOverlay: byId('pdfSplitSuccessOverlay'),
    successPath: byId('pdfSplitSuccessPath'),
    successMeta: byId('pdfSplitSuccessMeta'),
    successCount: byId('pdfSplitSuccessCount'),
    successOpenFolder: byId('pdfSplitSuccessOpenFolder'),
    successOk: byId('pdfSplitSuccessOk'),
    getOutputDir,
    displayFilesystemPath,
    workspace: byId('pdfSplitWorkspace'),
    showError
  });

  function toggleProcessButton() {
    if (!processButton) return;
    if (files.length) {
      processButton.style.display = '';
      window.requestAnimationFrame(() => processButton.classList.add('visible'));
      return;
    }
    processButton.classList.remove('visible');
  }

  function renderFiles() {
    if (!fileList) return;
    fileScope?.dispose();
    fileScope = createLifecycleScope();
    fileList.replaceChildren();
    fileList.classList.toggle('has-files', files.length > 0);

    files.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'audio-convert-file-item';
      item.dataset.index = String(index);
      const number = document.createElement('span');
      number.className = 'audio-convert-file-index';
      number.textContent = String(index + 1);
      const name = document.createElement('span');
      name.className = 'audio-convert-file-name';
      name.textContent = file.name;
      const remove = document.createElement('button');
      remove.className = 'audio-convert-file-remove';
      remove.type = 'button';
      remove.setAttribute('aria-label', 'remove');
      const icon = document.createElement('i');
      icon.dataset.lucide = 'x';
      remove.appendChild(icon);
      fileScope.event(remove, 'click', event => {
        event.stopPropagation();
        if (processing || exporter.busy) return;
        files.splice(index, 1);
        renderFiles();
      });
      item.append(number, name, remove);
      fileList.appendChild(item);
    });

    bindSortableFileList({
      scope: fileScope,
      container: fileList,
      items: files,
      render: renderFiles,
      isLocked: () => processing || exporter.busy
    });
    toggleProcessButton();
    refreshIcons();
  }

  function addFiles(selected) {
    if (!selected || processing || exporter.busy) return;
    for (const file of Array.from(selected)) {
      const duplicate = file.path
        ? files.some(candidate => candidate.path === file.path)
        : files.some(candidate => candidate.name === file.name && candidate.size === file.size);
      if (!duplicate) files.push(file);
    }
    renderFiles();
  }

  function showDropZone() {
    dropZone?.classList.add('visible');
    overlay.classList.add('drag-over');
  }

  function hideDropZone() {
    dropZone?.classList.remove('visible');
    overlay.classList.remove('drag-over');
  }

  async function registerNativeDrop(owner) {
    if (!isTauri) return;
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      if (!isOpenSession(owner)) return;
      const unlisten = await getCurrentWebview().onDragDropEvent(event => {
        if (!isOpenSession(owner) || processing || exporter.busy) return;
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') showDropZone();
        else if (payload.type === 'leave') hideDropZone();
        else if (payload.type === 'drop') {
          hideDropZone();
          addFiles((payload.paths || [])
            .filter(path => path.toLowerCase().endsWith('.pdf'))
            .map(path => ({ name: fileNameFromPath(path), path, size: 0 })));
        }
      });
      owner.use(unlisten);
    } catch (error) {
      if (isOpenSession(owner)) console.error('[PDF Split] native drop registration failed:', error);
    }
  }

  async function chooseFiles() {
    if (processing || exporter.busy || !session) return;
    if (isTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          multiple: true,
          filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
        });
        if (Array.isArray(selected)) {
          addFiles(selected.map(path => ({ name: fileNameFromPath(path), path, size: 0 })));
        }
      } catch (error) {
        console.error('[PDF Split] file selection failed:', error);
      }
      return;
    }

    pickerOwnerRelease?.();
    pickerOwnerRelease = null;
    pickerScope?.dispose();
    const owner = session;
    const scope = createLifecycleScope();
    pickerScope = scope;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.pdf,application/pdf';
    input.style.display = 'none';
    document.body.appendChild(input);
    scope.use(() => input.remove());
    const releaseOwner = owner.use(() => {
      scope.dispose();
    });
    pickerOwnerRelease = releaseOwner;
    scope.event(input, 'change', () => {
      addFiles(input.files);
      releaseOwner();
      if (pickerScope === scope) {
        pickerScope = null;
        pickerOwnerRelease = null;
      }
    }, { once: true });
    input.click();
  }

  async function loadDemoFiles(owner) {
    const { PDFDocument } = await import('pdf-lib');
    const first = await PDFDocument.create();
    first.addPage([612, 792]);
    first.addPage([420, 595]);
    const second = await PDFDocument.create();
    second.addPage([842, 595]);
    const [firstBytes, secondBytes] = await Promise.all([first.save(), second.save()]);
    if (!isOpenSession(owner)) return;
    addFiles([
      {
        name: 'toolknit-pdf-split-demo-a.pdf',
        size: firstBytes.length,
        arrayBuffer: async () => firstBytes.slice().buffer
      },
      {
        name: 'toolknit-pdf-split-demo-b.pdf',
        size: secondBytes.length,
        arrayBuffer: async () => secondBytes.slice().buffer
      }
    ]);
  }

  function assertCurrent(owner, runId) {
    if (!isCurrentRun(owner, runId)) throw new Error('PDF split operation cancelled');
  }

  async function preflight(owner, runId) {
    let totalBytes = 0;
    if (isTauri) {
      const { invoke } = await tauriCorePromise;
      for (const file of files) {
        assertCurrent(owner, runId);
        if (!file.path) throw new Error(`Missing path for ${file.name}`);
        totalBytes += Number(await invoke('get_file_size', { path: file.path }));
      }
    } else {
      totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    }
    assertPdfSplitSelection(files, totalBytes, PDF_SPLIT_LIMITS);
  }

  async function readFileData(file) {
    if (isTauri && file.path) {
      const { invoke } = await tauriCorePromise;
      return normalizeBytes(await invoke('read_file_bytes', { path: file.path }), file.name);
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  function formatError(error) {
    const message = String(error?.message || error);
    if (error?.name === 'PasswordException' || /password|encrypted/i.test(message)) {
      return t('home.pdfSplit.passwordProtected');
    }
    if (/split limit/.test(message) && /MB/.test(message)) return message;
    if (/split limit/.test(message) && /page/.test(message)) return t('home.pdfSplit.tooManyPages');
    return message;
  }

  async function processSelection() {
    if (!files.length || processing || exporter.busy) return;
    const owner = session;
    if (!isOpenSession(owner)) return;
    const runId = ++runRevision;
    activeRunId = runId;
    processing = true;
    processModal.open();
    setProgress(5, t('home.pdfSplit.processing'));

    try {
      preview.releaseResources();
      await preflight(owner, runId);
      assertCurrent(owner, runId);
      await preview.load({
        files: [...files],
        readFileData,
        limits: PDF_SPLIT_LIMITS,
        isCurrent: () => isCurrentRun(owner, runId),
        onProgress: ({ fileIndex, fileCount }) => {
          setProgress(
            Math.round(((fileIndex + 0.2) / fileCount) * 100),
            `${t('home.pdfSplit.processing')} (${fileIndex + 1}/${fileCount})`
          );
        }
      });
      assertCurrent(owner, runId);
      setProgress(100, t('home.pdfSplit.processing'));
      processModal.close();
      preview.openWorkspace();
    } catch (error) {
      if (isCurrentRun(owner, runId)) {
        preview.releaseResources();
        if (!/cancelled/i.test(String(error?.message || error))) {
          showError(t('common.errorOccurred', { error: formatError(error) }));
        }
      }
    } finally {
      if (activeRunId === runId) {
        activeRunId = 0;
        processing = false;
      }
      if (isCurrentRun(owner, runId)) {
        processModal.close();
        setProgress(0);
      }
    }
  }

  function close() {
    runRevision += 1;
    activeRunId = 0;
    processing = false;
    processModal.close({ restore: false });
    session?.dispose();
    session = null;
    pickerOwnerRelease?.();
    pickerOwnerRelease = null;
    pickerScope?.dispose();
    pickerScope = null;
    exporter.close();
    preview.close();
    files = [];
    fileScope?.dispose();
    fileScope = null;
    fileList?.replaceChildren();
    fileList?.classList.remove('has-files');
    toggleProcessButton();
    hideDropZone();
    processMask?.classList.remove('visible');
    setProgress(0);
    setModalInteractivity(overlay, false);
    overlay.classList.remove('visible');
    plasma = disposeStandardToolPlasma(plasma);
  }

  const api = {
    open() {
      close();
      session = createLifecycleScope();
      exporter.open();
      overlay.classList.add('visible');
      setModalInteractivity(overlay, true);
      plasma = initStandardToolPlasma(background);
      void registerNativeDrop(session);
      if (isDemo) void loadDemoFiles(session);
    },
    close,
    dispose() {
      close();
      preview.dispose();
      exporter.dispose();
      lifecycle.dispose();
    }
  };

  lifecycle.event(back, 'click', () => {
    if (exporter.busy) {
      notify(t('home.pdfSplit.saving'));
      return;
    }
    api.close();
  });
  lifecycle.event(cta, 'click', () => { void chooseFiles(); });
  function cancelProcessing() {
    if (exporter.busy) { exporter.cancel(); return; }
    runRevision += 1;
    activeRunId = 0;
    processing = false;
    preview.releaseResources();
    processModal.close();
    processButton?.focus({ preventScroll: true });
  }
  lifecycle.event(byId('pdfSplitProcessCancel'), 'click', cancelProcessing);
  lifecycle.event(processButton, 'click', () => { void processSelection(); });
  lifecycle.event(processButton, 'transitionend', event => {
    if (event.propertyName === 'opacity' && !processButton.classList.contains('visible')) {
      processButton.style.display = 'none';
    }
  });

  return api;
}
