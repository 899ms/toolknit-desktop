import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { PDF_ROTATE_LIMITS, assertPdfRotateSelection } from '../../pdf-rotate-core.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { t } from '../../i18n.js';
import { createPdfRotateExporter } from './exporter.js';
import { createPdfRotatePreview } from './preview.js';
import './pdf-rotate.css';

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

function fileNameFromPath(path) {
  return String(path || '').split(/[/\\]/).pop() || String(path || '');
}

export function initPdfRotateTool({
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
  if (!overlay) throw new Error('pdf-rotate:missing-overlay');
  if (typeof displayFilesystemPath !== 'function') throw new Error('pdf-rotate:missing-path-display');
  if (typeof getOutputDir !== 'function') throw new Error('pdf-rotate:missing-output-directory');

  const lifecycle = createLifecycleScope();
  const byId = id => document.getElementById(id);
  const background = byId('pdfRotatePlasmaBg');
  const back = byId('pdfRotateBack');
  const dropZone = byId('pdfRotateDropZone');
  const fileList = byId('pdfRotateFiles');
  const cta = byId('pdfRotateCta');
  const input = byId('pdfRotateInput');
  const processButton = byId('pdfRotateProcessBtn');
  const processMask = byId('pdfRotateProcessMask');
  const progressFill = byId('pdfRotateProcessBarFill');
  const progressText = byId('pdfRotateProcessText');
  let session = null;
  let fileScope = null;
  let plasma = null;
  let selectedFiles = [];
  let processing = false;
  let runRevision = 0;
  let activeRunId = 0;
  let exporter = null;
  const isDemo = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('pdf-rotate-demo') === '1';

  const isOpenSession = owner => owner && owner === session && !owner.disposed
    && overlay.classList.contains('visible');
  const isCurrentRun = (owner, runId) => isOpenSession(owner) && runId === runRevision;

  function setProgress(percent, message) {
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (message && progressText) progressText.textContent = message;
  }

  const preview = createPdfRotatePreview({
    workspace: byId('pdfRotateWorkspace'),
    workspaceClose: byId('pdfRotateWorkspaceClose'),
    workspaceStatus: byId('pdfRotateWorkspaceStatus'),
    workspaceFileName: byId('pdfRotateWorkspaceFileName'),
    pageCount: byId('pdfRotatePageCount'),
    pageStrip: byId('pdfRotatePageStrip'),
    workspaceFooterStatus: byId('pdfRotateWorkspaceFooterStatus'),
    rotateAllButton: byId('pdfRotateRotateAllBtn'),
    downloadAllButton: byId('pdfRotateDownloadAllBtn'),
    isSaving: () => Boolean(exporter?.busy),
    onDownloadPage: index => exporter?.downloadSingle(index),
    onDownloadAll: () => exporter?.downloadAll(),
    refreshIcons
  });

  exporter = createPdfRotateExporter({
    isTauri,
    preview,
    processMask,
    setProgress,
    successOverlay: byId('pdfRotateSuccessOverlay'),
    successPath: byId('pdfRotateSuccessPath'),
    successMeta: byId('pdfRotateSuccessMeta'),
    successCount: byId('pdfRotateSuccessCount'),
    successOpenFolder: byId('pdfRotateSuccessOpenFolder'),
    successOk: byId('pdfRotateSuccessOk'),
    getOutputDir,
    displayFilesystemPath,
    formatError,
    showError
  });

  function formatError(error) {
    const message = String(error?.message || error);
    if (error?.name === 'PasswordException' || /password|encrypted/i.test(message)) {
      return t('home.pdfRotate.passwordProtected');
    }
    if (/rotation limit/.test(message) && /MB/.test(message)) return t('home.pdfRotate.fileTooLarge');
    if (/rotation limit/.test(message) && /page/.test(message)) return t('home.pdfRotate.tooManyPages');
    return message;
  }

  function assertCurrentRun(owner, runId) {
    if (!isCurrentRun(owner, runId)) throw new Error('PDF rotate operation cancelled');
  }

  async function preflight(file) {
    const totalBytes = isTauri && file.path
      ? Number(await (await tauriCorePromise).invoke('get_file_size', { path: file.path }))
      : Number(file.size || 0);
    assertPdfRotateSelection(selectedFiles, totalBytes, PDF_ROTATE_LIMITS);
  }

  async function readFileData(file) {
    if (isTauri && file.path) {
      const bytes = await (await tauriCorePromise).invoke('read_file_bytes', { path: file.path });
      if (Array.isArray(bytes)) return Uint8Array.from(bytes);
      if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
      if (bytes instanceof Uint8Array) return bytes;
      if (bytes && typeof bytes.length === 'number') return Uint8Array.from(bytes);
      throw new Error(`Invalid file data for ${file.name}`);
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  function toggleProcessButton() {
    if (!processButton) return;
    if (selectedFiles.length) {
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
    fileList.classList.toggle('has-files', selectedFiles.length > 0);
    selectedFiles.forEach((file, index) => {
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
        selectedFiles = [];
        renderFiles();
      });
      item.append(number, name, remove);
      fileList.appendChild(item);
    });
    toggleProcessButton();
    refreshIcons();
  }

  function addFiles(files) {
    const entries = Array.from(files || []);
    if (!entries.length || processing || exporter.busy) return;
    if (entries.length > 1) {
      showError(t('home.pdfRotate.singleFileOnly'));
      return;
    }
    selectedFiles = [entries[0]];
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
          const files = (payload.paths || [])
            .filter(path => path.toLowerCase().endsWith('.pdf'))
            .map(path => ({ name: fileNameFromPath(path), path, size: 0 }));
          addFiles(files);
        }
      });
      owner.use(unlisten);
    } catch (error) {
      if (isOpenSession(owner)) console.error('[PDF Rotate] native drop registration failed:', error);
    }
  }

  async function chooseFile() {
    if (processing || exporter.busy) return;
    if (!isTauri) {
      input?.click();
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
      });
      if (typeof selected === 'string') {
        addFiles([{ name: fileNameFromPath(selected), path: selected, size: 0 }]);
      }
    } catch (error) {
      console.error('[PDF Rotate] file selection failed:', error);
    }
  }

  async function loadDemoFile(owner) {
    const { PDFDocument } = await import('pdf-lib');
    const documentHandle = await PDFDocument.create();
    documentHandle.addPage([612, 792]);
    documentHandle.addPage([420, 595]);
    documentHandle.addPage([842, 595]);
    const bytes = await documentHandle.save();
    if (!isOpenSession(owner)) return;
    addFiles([{
      name: 'toolknit-pdf-rotate-demo.pdf',
      size: bytes.length,
      arrayBuffer: async () => bytes.slice().buffer
    }]);
  }

  async function processSelection() {
    if (!selectedFiles.length || processing || exporter.busy) return;
    const owner = session;
    if (!isOpenSession(owner)) return;
    const runId = ++runRevision;
    activeRunId = runId;
    processing = true;
    processMask?.classList.add('visible');
    setProgress(5, t('home.pdfRotate.processing'));

    try {
      preview.releaseResources();
      const file = selectedFiles[0];
      await preflight(file);
      assertCurrentRun(owner, runId);
      const fileData = await readFileData(file);
      if (!fileData.length) throw new Error(`File ${file.name} is empty`);
      assertCurrentRun(owner, runId);
      await preview.load({
        file,
        fileData,
        limits: PDF_ROTATE_LIMITS,
        isCurrent: () => isCurrentRun(owner, runId),
        onProgress: (completed, total) => {
          setProgress(10 + Math.round((completed / total) * 90), t('home.pdfRotate.processing'));
        }
      });
      assertCurrentRun(owner, runId);
      setProgress(100, t('home.pdfRotate.processing'));
      if (!await waitForOwner(owner, 300)) return;
      assertCurrentRun(owner, runId);
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
        processing = false;
        activeRunId = 0;
      }
      if (isOpenSession(owner)) {
        processMask?.classList.remove('visible');
        setProgress(0);
      }
    }
  }

  function close() {
    runRevision += 1;
    activeRunId = 0;
    processing = false;
    session?.dispose();
    session = null;
    preview.close();
    exporter.close();
    selectedFiles = [];
    fileScope?.dispose();
    fileScope = null;
    fileList?.replaceChildren();
    fileList?.classList.remove('has-files');
    if (input) input.value = '';
    toggleProcessButton();
    hideDropZone();
    processMask?.classList.remove('visible');
    setProgress(0);
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    plasma = disposeStandardToolPlasma(plasma);
  }

  const api = {
    open() {
      close();
      session = createLifecycleScope();
      exporter.open();
      overlay.classList.add('visible');
      overlay.setAttribute('aria-hidden', 'false');
      plasma = initStandardToolPlasma(background);
      void registerNativeDrop(session);
      if (isDemo) void loadDemoFile(session);
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
      notify(t('home.pdfRotate.saving'));
      return;
    }
    api.close();
  });
  lifecycle.event(cta, 'click', () => { void chooseFile(); });
  lifecycle.event(input, 'change', () => {
    addFiles(input.files);
    input.value = '';
  });
  lifecycle.event(processButton, 'click', () => { void processSelection(); });
  lifecycle.event(processButton, 'transitionend', event => {
    if (event.propertyName === 'opacity' && !processButton.classList.contains('visible')) {
      processButton.style.display = 'none';
    }
  });

  return api;
}
