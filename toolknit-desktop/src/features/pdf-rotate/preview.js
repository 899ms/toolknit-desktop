import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { assertPdfRotatePageCount } from '../../pdf-rotate-core.js';
import { onLangChange, t } from '../../i18n.js';

function cancelledError() {
  return new Error('PDF rotate operation cancelled');
}

export function createPdfRotatePreview({
  workspace,
  workspaceClose,
  workspaceStatus,
  workspaceFileName,
  pageCount,
  pageStrip,
  workspaceFooterStatus,
  rotateAllButton,
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
  let loadedDocument = null;
  let pages = [];

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
    if (loadedDocument) {
      try { loadedDocument.doc.destroy(); } catch {}
      loadedDocument = null;
    }
    for (const { canvas } of pages) {
      if (!canvas) continue;
      canvas.width = 0;
      canvas.height = 0;
    }
    pages = [];
    pageStrip?.replaceChildren();
  }

  function updateRotation(page) {
    const { canvas, previewStage, rotation } = page;
    if (!canvas || !previewStage || !canvas.width || !canvas.height) return;
    const quarterTurn = rotation % 180 !== 0;
    previewStage.style.aspectRatio = quarterTurn
      ? `${canvas.height} / ${canvas.width}`
      : `${canvas.width} / ${canvas.height}`;
    canvas.style.setProperty(
      'width',
      quarterTurn ? `${(canvas.width / canvas.height) * 100}%` : '100%',
      'important'
    );
    canvas.style.setProperty('max-width', 'none', 'important');
    canvas.style.transform = `rotate(${rotation}deg)`;
  }

  function updateControls() {
    const count = pages.length;
    if (workspaceStatus) workspaceStatus.textContent = t('home.pdfRotate.pageCount', { count });
    if (workspaceFileName) workspaceFileName.textContent = loadedDocument?.fileName || '';
    if (pageCount) pageCount.textContent = t('home.pdfRotate.pageCount', { count });
    if (workspaceFooterStatus) workspaceFooterStatus.textContent = t('home.pdfRotate.workspaceHint');
    if (downloadAllButton) downloadAllButton.textContent = t('home.pdfRotate.downloadAll');
    if (rotateAllButton) rotateAllButton.textContent = t('home.pdfRotate.rotateAll');
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

  function render() {
    if (!pageStrip) return;
    renderScope?.dispose();
    renderScope = createLifecycleScope();
    const fragment = document.createDocumentFragment();

    pages.forEach((page, index) => {
      const article = document.createElement('article');
      article.className = 'pdf-page-workspace-tile pdf-rotate-workspace-tile';
      article.dataset.index = String(index);

      const frame = document.createElement('div');
      frame.className = 'pdf-page-workspace-frame';
      const stage = document.createElement('div');
      stage.className = 'pdf-page-workspace-rotate-stage';
      page.previewStage = stage;
      page.canvas.style.transition = 'transform 0.2s ease';
      stage.appendChild(page.canvas);
      frame.appendChild(stage);
      updateRotation(page);

      const indexLabel = document.createElement('span');
      indexLabel.className = 'pdf-page-workspace-index';
      indexLabel.textContent = String(index + 1);
      frame.appendChild(indexLabel);

      const actions = document.createElement('div');
      actions.className = 'pdf-page-workspace-tile-actions';
      const rotateButton = makeIconButton('rotate-cw', t('home.pdfRotate.rotatePage'));
      const downloadButton = makeIconButton('download', t('home.pdfRotate.downloadPage'));
      renderScope.event(rotateButton, 'click', () => {
        page.rotation = (page.rotation + 90) % 360;
        updateRotation(page);
      });
      renderScope.event(downloadButton, 'click', () => { void onDownloadPage(index); });
      actions.append(rotateButton, downloadButton);
      article.append(frame, actions);
      fragment.appendChild(article);
    });

    pageStrip.replaceChildren(fragment);
    updateControls();
    setSaving(isSaving());
    refreshIcons();
  }

  async function load({ file, fileData, limits, isCurrent, onProgress }) {
    releaseResources();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
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

    try {
      assertPdfRotatePageCount(documentHandle.numPages, limits);
    } catch (error) {
      try { documentHandle.destroy(); } catch {}
      throw error;
    }
    loadedDocument = { doc: documentHandle, fileData, fileName: file.name };

    for (let pageIndex = 1; pageIndex <= documentHandle.numPages; pageIndex += 1) {
      if (!isCurrent()) throw cancelledError();
      onProgress?.(pageIndex, documentHandle.numPages);
      const page = await documentHandle.getPage(pageIndex);
      const viewport = page.getViewport({ scale: 1 });
      const scaledViewport = page.getViewport({ scale: 240 / viewport.width });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error(`Cannot create a preview for ${file.name}`);
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;
      const currentRender = page.render({ canvasContext: context, viewport: scaledViewport });
      renderTask = currentRender;
      try {
        await currentRender.promise;
      } finally {
        if (renderTask === currentRender) renderTask = null;
        page.cleanup();
      }
      if (!isCurrent()) {
        canvas.width = 0;
        canvas.height = 0;
        throw cancelledError();
      }
      pages.push({ pageIndex, fileName: file.name, canvas, rotation: 0, previewStage: null });
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

  function rotateAll() {
    if (isSaving()) return;
    for (const page of pages) {
      page.rotation = (page.rotation + 90) % 360;
      updateRotation(page);
    }
  }

  function setSaving(saving) {
    for (const button of [downloadAllButton, rotateAllButton, workspaceClose]) {
      if (button) button.disabled = saving;
    }
    pageStrip?.querySelectorAll('.pdf-page-workspace-icon-button').forEach(button => {
      button.disabled = saving;
    });
  }

  lifecycle.event(workspaceClose, 'click', () => { closeWorkspace(); });
  lifecycle.event(rotateAllButton, 'click', rotateAll);
  lifecycle.event(downloadAllButton, 'click', () => { void onDownloadAll(); });
  lifecycle.use(onLangChange(() => {
    if (workspace?.classList.contains('visible')) render();
  }));

  return {
    close: () => closeWorkspace({ force: true }),
    dispose() {
      closeWorkspace({ force: true });
      lifecycle.dispose();
    },
    getExportState() {
      return loadedDocument ? {
        fileData: loadedDocument.fileData,
        fileName: loadedDocument.fileName,
        pages: pages.map(({ pageIndex, fileName, rotation }) => ({ pageIndex, fileName, rotation }))
      } : null;
    },
    load,
    openWorkspace,
    releaseResources,
    setSaving
  };
}
