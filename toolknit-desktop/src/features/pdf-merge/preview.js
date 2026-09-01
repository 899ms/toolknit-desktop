import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { PDF_MERGE_LIMITS } from '../../pdf-merge-core.js';
import { onLangChange, t } from '../../i18n.js';

function cancelledError() {
  return new Error('PDF merge operation cancelled');
}

export function createPdfMergePreview({
  overlay,
  selection,
  selectionEyebrow,
  choosePagesButton,
  useAllPagesButton,
  pickerProgress,
  pickerFileName,
  pickerSelectedCount,
  pickerInputStatus,
  pageStrip,
  selectAllPagesButton,
  selectionNextButton,
  getFileName = () => '',
  onCommit = () => {},
  notify = () => {},
  refreshIcons = () => {}
} = {}) {
  const lifecycle = createLifecycleScope();
  let renderScope = null;
  let loadingTask = null;
  const renderTasks = new Set();
  const previewCanvases = new Set();
  let documents = [];
  let pages = [];
  let selectionFiles = [];
  let currentSelectionIndex = 0;
  let renderRevision = 0;

  function releaseRenderedPreviews() {
    renderRevision += 1;
    renderScope?.dispose();
    renderScope = null;
    for (const task of renderTasks) {
      try { task.cancel(); } catch {}
    }
    renderTasks.clear();
    for (const canvas of previewCanvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
    previewCanvases.clear();
    pageStrip?.replaceChildren();
  }

  function releaseResources() {
    releaseRenderedPreviews();
    if (loadingTask) {
      try { loadingTask.destroy(); } catch {}
      loadingTask = null;
    }
    for (const { doc } of documents) {
      try { doc.destroy(); } catch {}
    }
    documents = [];
    pages = [];
  }

  function hideFlow({ reset = false } = {}) {
    releaseRenderedPreviews();
    selection?.classList.remove('visible');
    selection?.setAttribute('aria-hidden', 'true');
    overlay?.classList.remove('is-selection-flow');
    if (reset) {
      selectionFiles = [];
      currentSelectionIndex = 0;
      if (selection) selection.dataset.phase = '';
    }
  }

  function close() {
    hideFlow({ reset: true });
    releaseResources();
  }

  async function loadSources({ files, readFileData, preflight, isCurrent, onProgress }) {
    close();
    await preflight();
    if (!isCurrent()) throw cancelledError();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

    try {
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        if (!isCurrent()) throw cancelledError();
        const file = files[fileIndex];
        onProgress?.(fileIndex, files.length);
        const fileData = await readFileData(file);
        if (!fileData.length) throw new Error(`File ${file.name} is empty`);
        if (!isCurrent()) throw cancelledError();
        const wasmUrl = new URL('assets/', document.baseURI).href;
        const task = pdfjs.getDocument({ data: fileData.slice(), wasmUrl, useWasm: true });
        loadingTask = task;
        let documentHandle;
        try {
          documentHandle = await task.promise;
        } finally {
          if (loadingTask === task) loadingTask = null;
        }
        if (!isCurrent()) {
          try { documentHandle.destroy(); } catch {}
          throw cancelledError();
        }
        if (pages.length + documentHandle.numPages > PDF_MERGE_LIMITS.maxPreviewPages) {
          try { documentHandle.destroy(); } catch {}
          throw new Error(`PDF inputs exceed the ${PDF_MERGE_LIMITS.maxPreviewPages}-page preview limit`);
        }
        documents.push({ doc: documentHandle, fileData });
        for (let pageIndex = 1; pageIndex <= documentHandle.numPages; pageIndex += 1) {
          pages.push({ fileIndex, pageIndex, rotation: 0, selected: true });
        }
      }
    } catch (error) {
      releaseResources();
      throw error;
    }

    return documents
      .map(({ doc }, fileIndex) => ({ fileIndex, pageCount: doc.numPages }))
      .filter(({ pageCount }) => pageCount > 1);
  }

  function pagesForFile(fileIndex) {
    return pages.filter(page => page.fileIndex === fileIndex);
  }

  function selectedPages() {
    return pages.filter(page => page.selected);
  }

  function updateControls() {
    const currentFile = selectionFiles[currentSelectionIndex];
    if (!currentFile) return;
    const currentPages = pagesForFile(currentFile.fileIndex);
    const selectedCount = currentPages.filter(page => page.selected).length;
    const allSelected = currentPages.length > 0 && selectedCount === currentPages.length;
    if (pickerProgress) {
      pickerProgress.textContent = t('home.pdfMerge.pickerProgress', {
        current: currentSelectionIndex + 1,
        total: selectionFiles.length
      });
    }
    if (pickerFileName) {
      pickerFileName.textContent = t('home.pdfMerge.pickerFile', {
        name: getFileName(currentFile.fileIndex)
      });
    }
    if (pickerInputStatus) {
      pickerInputStatus.textContent = t('home.pdfMerge.pickerInputStatus', {
        count: documents.length
      });
    }
    if (pickerSelectedCount) {
      pickerSelectedCount.textContent = t('home.pdfMerge.pickerSelected', {
        selected: selectedCount,
        total: currentPages.length
      });
    }
    if (selectAllPagesButton) {
      selectAllPagesButton.textContent = t(allSelected
        ? 'home.pdfMerge.deselectAllPages'
        : 'home.pdfMerge.selectAllPages');
    }
    if (selectionNextButton) {
      selectionNextButton.textContent = t(currentSelectionIndex === selectionFiles.length - 1
        ? 'home.pdfMerge.selectionComplete'
        : 'home.pdfMerge.nextFile');
      selectionNextButton.disabled = selectedCount === 0;
    }
  }

  function setTileSelected(tile, selected) {
    tile.classList.toggle('is-selected', selected);
    tile.setAttribute('aria-pressed', String(selected));
  }

  async function renderPagePreviews(fileIndex, entries, revision) {
    const source = documents[fileIndex]?.doc;
    if (!source) return;
    let nextIndex = 0;

    const renderOne = async () => {
      while (nextIndex < entries.length) {
        const entry = entries[nextIndex++];
        let canvas = null;
        try {
          const page = await source.getPage(entry.page.pageIndex);
          const baseViewport = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: 232 / baseViewport.width });
          canvas = document.createElement('canvas');
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('Unable to create PDF preview canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          previewCanvases.add(canvas);
          const task = page.render({ canvasContext: context, viewport });
          renderTasks.add(task);
          try {
            await task.promise;
          } finally {
            renderTasks.delete(task);
            try { page.cleanup(); } catch {}
          }
          if (revision !== renderRevision || !entry.frame.isConnected) {
            previewCanvases.delete(canvas);
            canvas.width = 0;
            canvas.height = 0;
            return;
          }
          entry.frame.replaceChildren(canvas);
          entry.frame.classList.remove('is-loading');
        } catch (error) {
          if (canvas && revision !== renderRevision) {
            previewCanvases.delete(canvas);
            canvas.width = 0;
            canvas.height = 0;
          }
          if (revision !== renderRevision || /cancel/i.test(String(error?.message || error))) return;
          console.warn('Unable to render PDF page preview:', error);
          if (entry.frame.isConnected) {
            entry.frame.classList.remove('is-loading');
            entry.frame.classList.add('has-error');
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(3, entries.length) }, renderOne));
  }

  function renderPicker() {
    const currentFile = selectionFiles[currentSelectionIndex];
    if (!currentFile || !pageStrip) return;
    releaseRenderedPreviews();
    renderScope = createLifecycleScope();
    const entries = [];
    const fragment = document.createDocumentFragment();

    for (const page of pagesForFile(currentFile.fileIndex)) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pdf-merge-page-tile';
      tile.setAttribute('aria-label', `Page ${page.pageIndex}`);
      setTileSelected(tile, page.selected);
      const frame = document.createElement('span');
      frame.className = 'pdf-merge-page-frame is-loading';
      const loading = document.createElement('span');
      loading.className = 'pdf-merge-page-loading';
      frame.appendChild(loading);
      const index = document.createElement('span');
      index.className = 'pdf-merge-page-index';
      index.textContent = String(page.pageIndex);
      const check = document.createElement('span');
      check.className = 'pdf-merge-page-check';
      const icon = document.createElement('i');
      icon.dataset.lucide = 'check';
      check.appendChild(icon);
      tile.append(frame, index, check);
      renderScope.event(tile, 'click', () => {
        page.selected = !page.selected;
        setTileSelected(tile, page.selected);
        updateControls();
      });
      fragment.appendChild(tile);
      entries.push({ page, frame });
    }

    pageStrip.replaceChildren(fragment);
    updateControls();
    refreshIcons();
    const revision = renderRevision;
    void renderPagePreviews(currentFile.fileIndex, entries, revision);
  }

  function openNotice(files) {
    selectionFiles = files;
    currentSelectionIndex = 0;
    if (selectionEyebrow) {
      selectionEyebrow.textContent = t('home.pdfMerge.multiPageDetected', { count: files.length });
    }
    if (selection) {
      selection.dataset.phase = 'notice';
      selection.classList.add('visible');
      selection.setAttribute('aria-hidden', 'false');
    }
    overlay?.classList.add('is-selection-flow');
  }

  function showPicker() {
    if (!selectionFiles.length) return;
    if (selection) {
      selection.dataset.phase = 'pages';
      selection.classList.add('visible');
      selection.setAttribute('aria-hidden', 'false');
    }
    overlay?.classList.add('is-selection-flow');
    renderPicker();
  }

  function restoreAfterError() {
    if (!selectionFiles.length) return false;
    if (selection) {
      selection.classList.add('visible');
      selection.setAttribute('aria-hidden', 'false');
    }
    overlay?.classList.add('is-selection-flow');
    if (selection?.dataset.phase === 'pages') renderPicker();
    return true;
  }

  lifecycle.event(choosePagesButton, 'click', showPicker);
  lifecycle.event(useAllPagesButton, 'click', () => {
    for (const page of pages) page.selected = true;
    void onCommit();
  });
  lifecycle.event(selectAllPagesButton, 'click', () => {
    const currentFile = selectionFiles[currentSelectionIndex];
    if (!currentFile) return;
    const currentPages = pagesForFile(currentFile.fileIndex);
    const shouldSelect = currentPages.some(page => !page.selected);
    for (const page of currentPages) page.selected = shouldSelect;
    pageStrip?.querySelectorAll('.pdf-merge-page-tile').forEach(tile => {
      setTileSelected(tile, shouldSelect);
    });
    updateControls();
  });
  lifecycle.event(selectionNextButton, 'click', () => {
    const currentFile = selectionFiles[currentSelectionIndex];
    if (!currentFile) return;
    if (!pagesForFile(currentFile.fileIndex).some(page => page.selected)) {
      notify(t('home.pdfMerge.selectAtLeastOne'));
      return;
    }
    if (currentSelectionIndex < selectionFiles.length - 1) {
      currentSelectionIndex += 1;
      renderPicker();
      return;
    }
    void onCommit();
  });
  lifecycle.use(onLangChange(() => {
    if (!selection?.classList.contains('visible')) return;
    if (selection.dataset.phase === 'notice') {
      if (selectionEyebrow) {
        selectionEyebrow.textContent = t('home.pdfMerge.multiPageDetected', {
          count: selectionFiles.length
        });
      }
      return;
    }
    updateControls();
  }));

  return {
    close,
    dispose() {
      close();
      lifecycle.dispose();
    },
    getExportState() {
      return {
        documents: documents.map(({ fileData }) => ({ fileData })),
        pages: selectedPages().map(({ fileIndex, pageIndex, rotation }) => ({
          fileIndex,
          pageIndex,
          rotation
        }))
      };
    },
    hideForCommit: () => hideFlow(),
    loadSources,
    openNotice,
    releaseResources,
    restoreAfterError,
    returnToEditor() {
      hideFlow({ reset: true });
      releaseResources();
    },
    get hasSelectionFlow() { return selectionFiles.length > 0; },
    get visible() { return Boolean(selection?.classList.contains('visible')); }
  };
}
