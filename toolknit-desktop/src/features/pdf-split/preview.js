import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { assertPdfSplitPageCount } from '../../pdf-split-core.js';
import { onLangChange, t } from '../../i18n.js';

function cancelledError() {
  return new Error('PDF split operation cancelled');
}

function makeIconButton(iconName, label) {
  const button = document.createElement('button');
  button.className = 'pdf-page-workspace-icon-button';
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  const icon = document.createElement('i');
  icon.dataset.lucide = iconName;
  button.appendChild(icon);
  return button;
}

export function createPdfSplitPreview({
  workspace,
  workspaceClose,
  workspaceStatus,
  workspaceHint,
  pageStrip,
  selectedCount,
  selectionMeta,
  selectAllButton,
  downloadAllButton,
  isSaving = () => false,
  onDownloadPage = () => {},
  onDownloadAll = () => {},
  refreshIcons = () => {}
} = {}) {
  const lifecycle = createLifecycleScope();
  let renderScope = null;
  let loadingTask = null;
  let renderTask = null;
  let documents = [];
  let pages = [];
  let inputFileCount = 0;

  function releaseResources() {
    renderScope?.dispose();
    renderScope = null;
    if (renderTask) {
      try { renderTask.cancel(); } catch {}
      renderTask = null;
    }
    if (loadingTask) {
      try { loadingTask.destroy(); } catch {}
      loadingTask = null;
    }
    for (const { doc } of documents) {
      try { doc.destroy(); } catch {}
    }
    documents = [];
    for (const { canvas } of pages) {
      if (!canvas) continue;
      canvas.width = 0;
      canvas.height = 0;
    }
    pages = [];
    inputFileCount = 0;
    pageStrip?.replaceChildren();
  }

  function updateControls() {
    const chosen = pages.filter(page => page.selected).length;
    const allSelected = chosen > 0 && chosen === pages.length;
    if (workspaceStatus) {
      workspaceStatus.textContent = t('home.pdfSplit.inputStatus', { count: inputFileCount });
    }
    if (workspaceHint) workspaceHint.textContent = t('home.pdfSplit.drawerHint');
    if (selectedCount) selectedCount.textContent = t('home.pdfSplit.selectedCount', { count: chosen });
    if (selectionMeta) {
      selectionMeta.textContent = t('home.pdfSplit.selectionStatus', {
        selected: chosen,
        total: pages.length
      });
    }
    if (selectAllButton) {
      selectAllButton.textContent = t(allSelected
        ? 'home.pdfSplit.clearSelection'
        : 'home.pdfSplit.selectAll');
      selectAllButton.disabled = isSaving() || pages.length === 0;
    }
    if (downloadAllButton) {
      downloadAllButton.textContent = t('home.pdfSplit.downloadSelected');
      downloadAllButton.disabled = isSaving() || chosen === 0;
    }
  }

  function render() {
    if (!pageStrip) return;
    renderScope?.dispose();
    renderScope = createLifecycleScope();
    const fragment = document.createDocumentFragment();

    pages.forEach((page, index) => {
      const article = document.createElement('article');
      article.className = 'pdf-page-workspace-tile pdf-split-workspace-tile';
      article.dataset.index = String(index);
      article.classList.toggle('is-selected', page.selected);

      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.className = 'pdf-page-workspace-page-select';
      selectButton.setAttribute('aria-label', `${t('home.pdfSplit.pageLabel')} ${index + 1}`);
      selectButton.setAttribute('aria-pressed', String(page.selected));

      const frame = document.createElement('span');
      frame.className = 'pdf-page-workspace-frame';
      frame.appendChild(page.canvas);
      const indexLabel = document.createElement('span');
      indexLabel.className = 'pdf-page-workspace-index';
      indexLabel.textContent = String(index + 1);
      frame.appendChild(indexLabel);

      const check = document.createElement('span');
      check.className = 'pdf-page-workspace-check';
      const checkIcon = document.createElement('i');
      checkIcon.dataset.lucide = 'check';
      check.appendChild(checkIcon);
      selectButton.append(frame, check);

      renderScope.event(selectButton, 'click', () => {
        page.selected = !page.selected;
        article.classList.toggle('is-selected', page.selected);
        selectButton.setAttribute('aria-pressed', String(page.selected));
        updateControls();
      });

      const actions = document.createElement('div');
      actions.className = 'pdf-page-workspace-tile-actions';
      const downloadButton = makeIconButton('download', t('home.pdfSplit.downloadPage'));
      renderScope.event(downloadButton, 'click', event => {
        event.stopPropagation();
        void onDownloadPage(index);
      });
      actions.appendChild(downloadButton);
      article.append(selectButton, actions);
      fragment.appendChild(article);
    });

    pageStrip.replaceChildren(fragment);
    updateControls();
    setSaving(isSaving());
    refreshIcons();
  }

  async function load({ files, readFileData, limits, isCurrent, onProgress }) {
    releaseResources();
    inputFileCount = files.length;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    if (!isCurrent()) throw cancelledError();

    let totalPages = 0;
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      if (!isCurrent()) throw cancelledError();
      const file = files[fileIndex];
      onProgress?.({ fileIndex, fileCount: files.length, phase: 'read' });
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

      totalPages += documentHandle.numPages;
      try {
        assertPdfSplitPageCount(totalPages, limits);
      } catch (error) {
        try { documentHandle.destroy(); } catch {}
        throw error;
      }
      documents.push({ doc: documentHandle, fileData, fileName: file.name });

      for (let pageIndex = 1; pageIndex <= documentHandle.numPages; pageIndex += 1) {
        if (!isCurrent()) throw cancelledError();
        onProgress?.({ fileIndex, fileCount: files.length, pageIndex, phase: 'render' });
        const page = await documentHandle.getPage(pageIndex);
        const viewport = page.getViewport({ scale: 1 });
        const scaledViewport = page.getViewport({ scale: 240 / viewport.width });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error(`Cannot create a preview for ${file.name}`);
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const task = page.render({ canvasContext: context, viewport: scaledViewport });
        renderTask = task;
        try {
          await task.promise;
        } finally {
          if (renderTask === task) renderTask = null;
          page.cleanup();
        }
        if (!isCurrent()) {
          canvas.width = 0;
          canvas.height = 0;
          throw cancelledError();
        }
        pages.push({ fileIndex, pageIndex, canvas, selected: true });
      }
    }
  }

  function openWorkspace() {
    render();
    workspace?.classList.add('visible');
    workspace?.setAttribute('aria-hidden', 'false');
  }

  function closeWorkspace({ force = false } = {}) {
    if (!force && isSaving()) return false;
    workspace?.classList.remove('visible');
    workspace?.setAttribute('aria-hidden', 'true');
    releaseResources();
    return true;
  }

  function toggleAll() {
    if (isSaving() || !pages.length) return;
    const selected = pages.some(page => !page.selected);
    for (const page of pages) page.selected = selected;
    render();
  }

  function setSaving(saving) {
    for (const button of [selectAllButton, downloadAllButton, workspaceClose]) {
      if (button) button.disabled = saving;
    }
    pageStrip?.querySelectorAll('button').forEach(button => { button.disabled = saving; });
  }

  lifecycle.event(workspaceClose, 'click', () => { closeWorkspace(); });
  lifecycle.event(selectAllButton, 'click', toggleAll);
  lifecycle.event(downloadAllButton, 'click', () => { void onDownloadAll(); });
  lifecycle.use(onLangChange(() => {
    if (workspace?.classList.contains('visible')) render();
  }));

  return {
    close: () => closeWorkspace({ force: true }),
    closeWorkspace,
    dispose() {
      closeWorkspace({ force: true });
      lifecycle.dispose();
    },
    getExportState({ index = null, selectedOnly = false } = {}) {
      const chosenPages = Number.isInteger(index)
        ? pages.slice(index, index + 1)
        : selectedOnly ? pages.filter(page => page.selected) : pages;
      return {
        documents: documents.map(({ fileData, fileName }) => ({ fileData, fileName })),
        pages: chosenPages.map(({ fileIndex, pageIndex }) => ({ fileIndex, pageIndex }))
      };
    },
    load,
    openWorkspace,
    releaseResources,
    setSaving
  };
}
