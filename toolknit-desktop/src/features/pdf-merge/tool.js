import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { PDF_MERGE_LIMITS, assertPdfMergeSelection } from '../../pdf-merge-core.js';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import { bindPointerSortableFileList } from '../../shared/sortable-file-list.js';
import { onLangChange, t } from '../../i18n.js';
import { createPdfMergeExporter } from './exporter.js';
import { createPdfMergePreview } from './preview.js';
import './pdf-merge.css';

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

export function initPdfMergeTool({
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
  if (!overlay) throw new Error('pdf-merge:missing-overlay');
  if (typeof displayFilesystemPath !== 'function') throw new Error('pdf-merge:missing-path-display');
  if (typeof getOutputDir !== 'function') throw new Error('pdf-merge:missing-output-directory');

  const lifecycle = createLifecycleScope();
  const byId = id => document.getElementById(id);
  const background = byId('pdfMergePlasmaBg');
  const back = byId('pdfMergeBack');
  const dropZone = byId('pdfMergeDropZone');
  const fileList = byId('pdfMergeFiles');
  const cta = byId('pdfMergeCta');
  const processButton = byId('pdfMergeProcessBtn');
  const processMask = byId('pdfMergeProcessMask');
  const progressFill = byId('pdfMergeProcessBarFill');
  const progressText = byId('pdfMergeProcessText');
  let session = null;
  let fileScope = null;
  let pickerScope = null;
  let pickerOwnerRelease = null;
  let plasma = null;
  let files = [];
  let processing = false;
  let runRevision = 0;
  let activeRunId = 0;
  let nativeDropGuardUntil = 0;
  let exporter = null;
  const isDemo = import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('pdf-merge-demo') === '1';

  const isOpenSession = owner => owner && owner === session && !owner.disposed
    && overlay.classList.contains('visible');
  const isCurrentRun = (owner, runId) => isOpenSession(owner) && runId === runRevision;

  function setProgress(percent, message) {
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (message && progressText) progressText.textContent = message;
  }

  const preview = createPdfMergePreview({
    overlay,
    selection: byId('pdfMergeSelection'),
    selectionEyebrow: byId('pdfMergeSelectionEyebrow'),
    choosePagesButton: byId('pdfMergeChoosePagesBtn'),
    useAllPagesButton: byId('pdfMergeUseAllPagesBtn'),
    pickerProgress: byId('pdfMergePickerProgress'),
    pickerFileName: byId('pdfMergePickerFileName'),
    pickerSelectedCount: byId('pdfMergePickerSelectedCount'),
    pickerInputStatus: byId('pdfMergePickerInputStatus'),
    pageStrip: byId('pdfMergePageStrip'),
    selectAllPagesButton: byId('pdfMergeSelectAllPagesBtn'),
    selectionNextButton: byId('pdfMergeSelectionNextBtn'),
    getFileName: index => files[index]?.name || '',
    onCommit: () => exporter?.commit(),
    notify,
    refreshIcons
  });

  exporter = createPdfMergeExporter({
    isTauri,
    preview,
    processMask,
    progressFill,
    processText: progressText,
    successOverlay: byId('pdfMergeSuccessOverlay'),
    successPath: byId('pdfMergeSuccessPath'),
    successMeta: byId('pdfMergeSuccessMeta'),
    successCount: byId('pdfMergeSuccessCount'),
    successOpenFolder: byId('pdfMergeSuccessOpenFolder'),
    successOk: byId('pdfMergeSuccessOk'),
    getOutputDir,
    displayFilesystemPath,
    getInputCount: () => files.length,
    onSuccess: () => { processing = false; },
    onFailure: ({ restored }) => { if (!restored) processing = false; },
    onAcknowledge: () => {
      files = [];
      renderFiles();
    },
    showError
  });

  function toggleProcessButton() {
    if (!processButton) return;
    if (files.length >= 2) {
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
      item.title = t('home.pdfMerge.info2');
      const grip = document.createElement('span');
      grip.className = 'pdf-merge-file-grip';
      grip.setAttribute('aria-hidden', 'true');
      const gripIcon = document.createElement('i');
      gripIcon.dataset.lucide = 'grip-vertical';
      grip.appendChild(gripIcon);
      const number = document.createElement('span');
      number.className = 'audio-convert-file-index';
      const numberText = document.createElement('span');
      numberText.textContent = String(index + 1);
      number.appendChild(numberText);
      const name = document.createElement('span');
      name.className = 'audio-convert-file-name';
      name.textContent = file.name;
      const remove = document.createElement('button');
      remove.className = 'audio-convert-file-remove';
      remove.type = 'button';
      remove.setAttribute('aria-label', 'remove');
      const removeIcon = document.createElement('i');
      removeIcon.dataset.lucide = 'x';
      remove.appendChild(removeIcon);
      fileScope.event(remove, 'click', event => {
        event.stopPropagation();
        if (processing || exporter.busy) return;
        files.splice(index, 1);
        renderFiles();
      });
      item.append(grip, number, name, remove);
      fileList.appendChild(item);
    });

    bindPointerSortableFileList({
      scope: fileScope,
      container: fileList,
      items: files,
      render: renderFiles,
      isLocked: () => processing || exporter.busy,
      guardNativeDrop: duration => {
        nativeDropGuardUntil = performance.now() + duration;
      }
    });
    toggleProcessButton();
    refreshIcons();
  }

  function addFiles(selected) {
    if (!selected || processing || exporter.busy) return;
    for (const file of Array.from(selected)) {
      const duplicate = file.path
        ? files.some(candidate => candidate.path === file.path)
        : files.some(candidate => candidate === file);
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
        if (fileList?.classList.contains('is-reordering') || performance.now() < nativeDropGuardUntil) {
          hideDropZone();
          return;
        }
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
      if (isOpenSession(owner)) console.error('[PDF Merge] native drop registration failed:', error);
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
        console.error('[PDF Merge] file selection failed:', error);
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
    const releaseOwner = owner.use(() => scope.dispose());
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
        name: 'toolknit-pdf-merge-demo-a.pdf',
        size: firstBytes.length,
        arrayBuffer: async () => firstBytes.slice().buffer
      },
      {
        name: 'toolknit-pdf-merge-demo-b.pdf',
        size: secondBytes.length,
        arrayBuffer: async () => secondBytes.slice().buffer
      }
    ]);
  }

  function assertCurrent(owner, runId) {
    if (!isCurrentRun(owner, runId)) throw new Error('PDF merge operation cancelled');
  }

  async function getFileSize(file, owner, runId) {
    assertCurrent(owner, runId);
    if (isTauri && file.path) {
      const { invoke } = await tauriCorePromise;
      const size = Number(await invoke('get_file_size', { path: file.path }));
      assertCurrent(owner, runId);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid file size for ${file.name}`);
      file.size = size;
      return size;
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`Invalid file size for ${file.name}`);
    }
    return file.size;
  }

  async function preflight(owner, runId, snapshot) {
    const sizes = await Promise.all(snapshot.map(file => getFileSize(file, owner, runId)));
    const totalBytes = sizes.reduce((total, size) => total + size, 0);
    if (!Number.isSafeInteger(totalBytes)) throw new Error('PDF inputs are too large to merge safely');
    assertPdfMergeSelection(snapshot, totalBytes, PDF_MERGE_LIMITS);
  }

  async function readFileData(file) {
    if (isTauri && file.path) {
      const { invoke } = await tauriCorePromise;
      return normalizeBytes(await invoke('read_file_bytes', { path: file.path }), file.name);
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  async function processSelection() {
    if (files.length < 2 || processing || exporter.busy) return;
    const owner = session;
    if (!isOpenSession(owner)) return;
    const runId = ++runRevision;
    activeRunId = runId;
    processing = true;
    processMask?.classList.add('visible');
    setProgress(30, t('home.pdfMerge.loadingPreview'));
    const snapshot = [...files];

    try {
      const multiPageFiles = await preview.loadSources({
        files: snapshot,
        readFileData,
        preflight: () => preflight(owner, runId, snapshot),
        isCurrent: () => isCurrentRun(owner, runId),
        onProgress: () => setProgress(30, t('home.pdfMerge.loadingPreview'))
      });
      assertCurrent(owner, runId);
      if (multiPageFiles.length) {
        processMask?.classList.remove('visible');
        setProgress(0);
        preview.openNotice(multiPageFiles);
      } else {
        await exporter.commit();
      }
    } catch (error) {
      if (isCurrentRun(owner, runId)) {
        preview.close();
        processing = false;
        processMask?.classList.remove('visible');
        setProgress(0);
        if (!/cancelled/i.test(String(error?.message || error))) {
          console.error('[PDF Merge] source load error:', error);
          showError(t('common.errorOccurred', { error: String(error?.message || error) }));
        }
      }
    } finally {
      if (activeRunId === runId) activeRunId = 0;
    }
  }

  function returnToEditor() {
    if (exporter.busy) return;
    runRevision += 1;
    processing = false;
    preview.returnToEditor();
    processMask?.classList.remove('visible');
    setProgress(0);
    renderFiles();
  }

  function close() {
    runRevision += 1;
    activeRunId = 0;
    processing = false;
    session?.dispose();
    session = null;
    pickerOwnerRelease?.();
    pickerOwnerRelease = null;
    pickerScope?.dispose();
    pickerScope = null;
    preview.close();
    exporter.close();
    files = [];
    fileScope?.dispose();
    fileScope = null;
    fileList?.replaceChildren();
    fileList?.classList.remove('has-files', 'is-reordering');
    toggleProcessButton();
    hideDropZone();
    processMask?.classList.remove('visible');
    setProgress(0);
    overlay.classList.remove('visible', 'is-selection-flow');
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
      notify(t('home.pdfMerge.processing'));
      return;
    }
    if (preview.visible) {
      returnToEditor();
      return;
    }
    api.close();
  });
  lifecycle.event(cta, 'click', () => { void chooseFiles(); });
  lifecycle.event(processButton, 'click', () => { void processSelection(); });
  lifecycle.event(processButton, 'transitionend', event => {
    if (event.propertyName === 'opacity' && !processButton.classList.contains('visible')) {
      processButton.style.display = 'none';
    }
  });
  lifecycle.use(onLangChange(() => {
    if (overlay.classList.contains('visible') && !processing) renderFiles();
  }));

  return api;
}
