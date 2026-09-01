import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { t } from '../../i18n.js';

const PREVIEW_CSS_WIDTH = 232;
const PREVIEW_CSS_HEIGHT = 300;
const PREVIEW_CONCURRENCY = 2;
const PREVIEW_RELEASE_DELAY = 1800;

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

export function isPdfRenderCancellation(error) {
  return error?.name === 'RenderingCancelledException'
    || /cancelled|canceled/i.test(String(error?.message || error || ''));
}

export function createPdfToImagePreview({
  pageStage,
  pageStrip,
  workspace,
  isLocked = () => false,
  onSelectionChange = () => {}
} = {}) {
  const lifecycle = createLifecycleScope();
  let pageScope = null;
  let pdfDocument = null;
  let pdfLoadingTask = null;
  let pageStates = [];
  let previewObserver = null;
  let previewQueue = [];
  let previewActive = 0;
  let previewEpoch = 0;
  let documentRevision = 0;

  function releasePreview(pageState, markReleased = true) {
    if (!pageState) return;
    clearTimeout(pageState.releaseTimer);
    pageState.releaseTimer = null;
    if (pageState.renderTask) {
      try { pageState.renderTask.cancel(); } catch (_) {}
    }
    if (pageState.canvas) {
      releaseCanvas(pageState.canvas);
      pageState.canvas = null;
    }
    pageState.queued = false;
    pageState.frame?.classList.remove('is-ready');
    pageState.frame?.classList.toggle('is-released', markReleased);
  }

  function stop(releaseAll = false) {
    previewObserver?.disconnect();
    previewObserver = null;
    previewQueue = [];
    previewEpoch += 1;
    for (const pageState of pageStates) {
      clearTimeout(pageState.releaseTimer);
      pageState.releaseTimer = null;
      pageState.nearby = false;
      if (pageState.renderTask) {
        try { pageState.renderTask.cancel(); } catch (_) {}
      }
      if (releaseAll) releasePreview(pageState, false);
    }
  }

  function queuePreview(pageState) {
    if (!pageState || pageState.error || pageState.canvas || pageState.renderTask || pageState.queued) return;
    pageState.queued = true;
    pageState.frame?.classList.remove('is-released');
    previewQueue.push(pageState);
    drainPreviewQueue();
  }

  async function renderPreview(pageState, epoch) {
    let page = null;
    let canvas = null;
    try {
      if (!pdfDocument || epoch !== previewEpoch || !pageState.nearby) return;
      page = await pdfDocument.getPage(pageState.pageNumber);
      if (!pdfDocument || epoch !== previewEpoch || !pageState.nearby) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const cssScale = Math.min(
        PREVIEW_CSS_WIDTH / baseViewport.width,
        PREVIEW_CSS_HEIGHT / baseViewport.height
      );
      const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const viewport = page.getViewport({ scale: cssScale * outputScale });
      canvas = document.createElement('canvas');
      canvas.className = 'pdf-to-image-preview-canvas';
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      canvas.style.width = Math.max(1, Math.round(viewport.width / outputScale)) + 'px';
      canvas.style.height = Math.max(1, Math.round(viewport.height / outputScale)) + 'px';
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Cannot create PDF preview canvas');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const renderTask = page.render({
        canvasContext: context,
        viewport,
        background: '#ffffff'
      });
      pageState.renderTask = renderTask;
      await renderTask.promise;
      pageState.renderTask = null;
      if (!pdfDocument || epoch !== previewEpoch || !pageState.nearby) {
        releaseCanvas(canvas);
        canvas = null;
        return;
      }
      pageState.canvas = canvas;
      pageState.frame?.prepend(canvas);
      pageState.frame?.classList.remove('is-released', 'has-error');
      pageState.frame?.classList.add('is-ready');
      canvas = null;
    } catch (error) {
      pageState.renderTask = null;
      if (!isPdfRenderCancellation(error) && epoch === previewEpoch) {
        pageState.error = true;
        pageState.frame?.classList.add('has-error');
        pageState.errorEl.textContent = t('home.pdfToImageTool.thumbnailError');
      }
    } finally {
      pageState.renderTask = null;
      if (canvas) releaseCanvas(canvas);
      try { page?.cleanup(); } catch (_) {}
      if (pdfDocument
        && epoch === previewEpoch
        && pageState.nearby
        && !pageState.canvas
        && !pageState.error) {
        queueMicrotask(() => {
          if (!lifecycle.disposed
            && pdfDocument
            && epoch === previewEpoch
            && pageState.nearby) {
            queuePreview(pageState);
          }
        });
      }
    }
  }

  function drainPreviewQueue() {
    while (previewActive < PREVIEW_CONCURRENCY && previewQueue.length) {
      const pageState = previewQueue.shift();
      if (!pageState) continue;
      pageState.queued = false;
      if (!pageState.nearby || pageState.canvas || pageState.renderTask || pageState.error) continue;
      const epoch = previewEpoch;
      previewActive += 1;
      renderPreview(pageState, epoch).finally(() => {
        previewActive = Math.max(0, previewActive - 1);
        drainPreviewQueue();
      });
    }
  }

  function start() {
    if (!pdfDocument || !pageStates.length || !workspace?.classList.contains('visible')) return;
    stop(false);
    const epoch = previewEpoch;
    if (typeof IntersectionObserver !== 'function') {
      pageStates.slice(0, 12).forEach(pageState => {
        pageState.nearby = true;
        queuePreview(pageState);
      });
      return;
    }
    previewObserver = new IntersectionObserver(entries => {
      if (epoch !== previewEpoch) return;
      for (const entry of entries) {
        const pageState = pageStates[Number(entry.target.dataset.index)];
        if (!pageState) continue;
        if (entry.isIntersecting) {
          clearTimeout(pageState.releaseTimer);
          pageState.releaseTimer = null;
          pageState.nearby = true;
          queuePreview(pageState);
        } else {
          pageState.nearby = false;
          clearTimeout(pageState.releaseTimer);
          pageState.releaseTimer = setTimeout(() => {
            if (!pageState.nearby) releasePreview(pageState);
          }, PREVIEW_RELEASE_DELAY);
        }
      }
    }, {
      root: pageStage,
      rootMargin: '120px 600px',
      threshold: 0.01
    });
    pageStates.forEach(pageState => previewObserver.observe(pageState.tile));
  }

  function createSkeleton() {
    const skeleton = document.createElement('span');
    skeleton.className = 'pdf-to-image-preview-skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 5; index += 1) {
      skeleton.appendChild(document.createElement('span'));
    }
    return skeleton;
  }

  function createCheckIcon() {
    const check = document.createElement('span');
    check.className = 'pdf-page-workspace-check';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm5 12 4.2 4.2L19 6.8');
    svg.appendChild(path);
    check.appendChild(svg);
    return check;
  }

  function updatePageSelection(pageState, selected) {
    pageState.selected = selected;
    pageState.tile.classList.toggle('is-selected', selected);
    pageState.selectButton.setAttribute('aria-pressed', String(selected));
    onSelectionChange();
  }

  function buildPageTiles(pageCount) {
    pageScope?.dispose();
    pageScope = createLifecycleScope();
    const fragment = document.createDocumentFragment();
    pageStates = Array.from({ length: pageCount }, (_, index) => {
      const pageNumber = index + 1;
      const tile = document.createElement('article');
      tile.className = 'pdf-page-workspace-tile pdf-split-workspace-tile is-selected';
      tile.dataset.index = String(index);

      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.className = 'pdf-page-workspace-page-select';
      selectButton.setAttribute('aria-pressed', 'true');
      selectButton.setAttribute('aria-label', t('home.pdfToImageTool.pageLabel', { page: pageNumber }));

      const frame = document.createElement('span');
      frame.className = 'pdf-page-workspace-frame pdf-to-image-preview-frame';
      const errorElement = document.createElement('span');
      errorElement.className = 'pdf-to-image-preview-error';
      errorElement.textContent = t('home.pdfToImageTool.thumbnailError');
      const pageIndex = document.createElement('span');
      pageIndex.className = 'pdf-page-workspace-index';
      pageIndex.textContent = String(pageNumber);
      frame.append(createSkeleton(), errorElement, pageIndex);
      selectButton.append(frame, createCheckIcon());
      tile.appendChild(selectButton);
      fragment.appendChild(tile);

      const pageState = {
        pageNumber,
        selected: true,
        tile,
        selectButton,
        frame,
        errorEl: errorElement,
        canvas: null,
        renderTask: null,
        releaseTimer: null,
        nearby: false,
        queued: false,
        error: false
      };
      pageScope.event(selectButton, 'click', () => {
        if (!isLocked()) updatePageSelection(pageState, !pageState.selected);
      });
      return pageState;
    });
    pageStrip?.replaceChildren(fragment);
    onSelectionChange();
  }

  function setAllSelected(selected) {
    pageStates.forEach(pageState => {
      pageState.selected = selected;
      pageState.tile.classList.toggle('is-selected', selected);
      pageState.selectButton.setAttribute('aria-pressed', String(selected));
    });
    onSelectionChange();
  }

  function refreshTranslations() {
    pageStates.forEach(pageState => {
      pageState.selectButton.setAttribute(
        'aria-label',
        t('home.pdfToImageTool.pageLabel', { page: pageState.pageNumber })
      );
      pageState.errorEl.textContent = t('home.pdfToImageTool.thumbnailError');
    });
  }

  async function loadDocument(bytes, assertCurrent = () => {}) {
    const revision = ++documentRevision;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    assertCurrent();
    if (revision !== documentRevision || lifecycle.disposed) {
      throw new Error('pdf-to-image:cancelled');
    }
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const wasmUrl = new URL('assets/', document.baseURI).href;
    const loadingTask = pdfjs.getDocument({ data: bytes, wasmUrl, useWasm: true });
    pdfLoadingTask = loadingTask;
    let loadedDocument = null;
    try {
      loadedDocument = await loadingTask.promise;
    } finally {
      if (pdfLoadingTask === loadingTask) pdfLoadingTask = null;
    }
    try {
      assertCurrent();
      if (revision !== documentRevision || lifecycle.disposed) {
        throw new Error('pdf-to-image:cancelled');
      }
      pdfDocument = loadedDocument;
      return loadedDocument;
    } catch (error) {
      try { await loadedDocument?.destroy(); } catch (_) {}
      throw error;
    }
  }

  async function cancelLoading() {
    const task = pdfLoadingTask;
    if (!task) return;
    try { await task.destroy(); } catch (_) {}
  }

  async function releaseDocument() {
    documentRevision += 1;
    stop(true);
    pageScope?.dispose();
    pageScope = null;
    const documentToDestroy = pdfDocument;
    const loadingToDestroy = pdfLoadingTask;
    pdfDocument = null;
    pdfLoadingTask = null;
    pageStates = [];
    pageStrip?.replaceChildren();
    try { await documentToDestroy?.destroy(); } catch (_) {}
    if (!documentToDestroy) {
      try { await loadingToDestroy?.destroy(); } catch (_) {}
    }
  }

  function dispose() {
    if (lifecycle.disposed) return;
    lifecycle.dispose();
    void releaseDocument();
  }

  return {
    buildPageTiles,
    cancelLoading,
    dispose,
    getDocument: () => pdfDocument,
    getPageStates: () => pageStates,
    loadDocument,
    refreshTranslations,
    releaseDocument,
    selectedPageStates: () => pageStates.filter(pageState => pageState.selected),
    setAllSelected,
    start,
    stop
  };
}
