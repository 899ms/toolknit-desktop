import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import {
  PDF_CROP_FULL_RECT,
  PDF_CROP_LIMITS,
  normalizePdfCropRect,
  pdfCropMarginsToRect,
  pdfCropRectToMargins,
  pdfCropRectsEqual
} from './core.js';
import { releasePdfCropSource, stagePdfCropDocument } from './document.js';

const THUMB_WIDTH = 96;
const THUMB_HEIGHT = 68;
const THUMB_CONCURRENCY = 2;
const PREVIEW_MIN_ZOOM = 0.45;
const PREVIEW_MAX_ZOOM = 3.2;
const HISTORY_LIMIT = 60;
const POINTS_PER_MM = 72 / 25.4;

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function snapshotPages(pages) {
  return pages.map(page => ({ rect: { ...page.rect }, explicit: Boolean(page.explicit) }));
}

function snapshotsEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((entry, index) => Boolean(entry.explicit) === Boolean(right[index]?.explicit)
      && pdfCropRectsEqual(entry.rect, right[index]?.rect));
}

export function createPdfCropWorkspace({
  overlay,
  text,
  refreshIcons,
  customSelectControls,
  isBusy,
  isOpen,
  onStateChange
}) {
  const byId = id => document.getElementById(id);
  const prevButton = byId('pdfCropPrev');
  const nextButton = byId('pdfCropNext');
  const pageIndicator = byId('pdfCropPageIndicator');
  const zoomOutButton = byId('pdfCropZoomOut');
  const zoomInButton = byId('pdfCropZoomIn');
  const fitButton = byId('pdfCropFit');
  const zoomValue = byId('pdfCropZoomValue');
  const canvasScroll = byId('pdfCropCanvasScroll');
  const canvasWrap = byId('pdfCropCanvasWrap');
  const previewCanvas = byId('pdfCropPreviewCanvas');
  const emptyState = byId('pdfCropEmpty');
  const interactionLayer = byId('pdfCropInteractionLayer');
  const selection = byId('pdfCropSelection');
  const sizeBadge = byId('pdfCropSizeBadge');
  const previewStatus = byId('pdfCropPreviewStatus');
  const resetPageButton = byId('pdfCropResetPage');
  const filmstrip = byId('pdfCropFilmstrip');
  const pageCount = byId('pdfCropPageCount');
  const fileName = byId('pdfCropFileName');
  const fileMeta = byId('pdfCropFileMeta');
  const scopeNote = byId('pdfCropScopeNote');
  const unitSelect = byId('pdfCropUnit');
  const linkMarginsButton = byId('pdfCropLinkMargins');
  const marginInputs = Array.from(overlay.querySelectorAll('[data-margin-side]'));
  const dimension = byId('pdfCropDimension');
  const undoButton = byId('pdfCropUndo');
  const redoButton = byId('pdfCropRedo');
  const reframeButton = byId('pdfCropReframe');
  const resetAllButton = byId('pdfCropResetAll');
  const lifecycle = createLifecycleScope();
  const listen = (target, type, handler, options) => target
    ? lifecycle.event(target, type, handler, options)
    : () => {};
  let disposed = false;
  let source = null;
  let pages = [];
  let currentIndex = 0;
  let scope = 'all';
  let marginsLinked = false;
  let reframeMode = false;
  let history = [];
  let future = [];
  let marginEditBefore = null;
  let pointerState = null;
  let previewTask = null;
  let previewRequest = 0;
  let previewZoom = 1;
  let previewScale = 1;
  let thumbBatch = null;

  const currentPage = () => pages[currentIndex] || null;
  const hasDocument = () => Boolean(source && pages.length);
  const emitChange = () => onStateChange?.();

  const releaseSource = releasePdfCropSource;
  const stageDocument = options => stagePdfCropDocument({ ...options, text });

  function cancelPreview() {
    previewRequest += 1;
    try { previewTask?.cancel(); } catch (_) {}
    previewTask = null;
    releaseCanvas(previewCanvas);
    if (canvasWrap) canvasWrap.hidden = true;
    if (interactionLayer) interactionLayer.hidden = true;
  }

  function releaseThumbs() {
    const batch = thumbBatch;
    thumbBatch = null;
    batch?.owner.dispose();
    filmstrip.querySelectorAll('canvas').forEach(releaseCanvas);
  }

  function createPageThumb(page, owner) {
    const button = document.createElement('button');
    button.className = 'pdf-crop-page-thumb';
    button.type = 'button';
    button.dataset.pageIndex = String(page.index);
    const visual = document.createElement('span');
    visual.className = 'pdf-crop-page-thumb-visual';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    const box = document.createElement('i');
    box.className = 'pdf-crop-page-thumb-box';
    visual.append(canvas, box);
    const copy = document.createElement('span');
    copy.className = 'pdf-crop-page-thumb-copy';
    const title = document.createElement('b');
    title.textContent = text('home.pdfCrop.pageLabel', { page: page.index + 1 });
    const status = document.createElement('small');
    copy.append(title, status);
    button.append(visual, copy);
    owner.event(button, 'click', () => selectPage(page.index));
    return button;
  }

  function updateThumbState(page) {
    if (!page) return;
    const item = filmstrip.querySelector(`[data-page-index="${page.index}"]`);
    if (!item) return;
    item.classList.toggle('is-current', page.index === currentIndex);
    item.classList.toggle('has-crop', page.explicit);
    const status = item.querySelector('small');
    if (status) status.textContent = text(page.explicit ? 'home.pdfCrop.cropped' : 'home.pdfCrop.uncropped');
    const box = item.querySelector('.pdf-crop-page-thumb-box');
    const canvas = item.querySelector('canvas');
    const visual = item.querySelector('.pdf-crop-page-thumb-visual');
    if (!box || !canvas || !visual || !canvas.style.width) return;
    const width = parseFloat(canvas.style.width) || 0;
    const height = parseFloat(canvas.style.height) || 0;
    box.style.left = `${(visual.clientWidth - width) / 2 + page.rect.x * width}px`;
    box.style.top = `${(visual.clientHeight - height) / 2 + page.rect.y * height}px`;
    box.style.width = `${page.rect.width * width}px`;
    box.style.height = `${page.rect.height * height}px`;
  }

  function updateThumbStates() {
    pages.forEach(updateThumbState);
  }

  async function renderThumbnail(batch, pageIndex) {
    const item = filmstrip.querySelector(`[data-page-index="${pageIndex}"]`);
    const canvas = item?.querySelector('canvas');
    const documentHandle = source?.pdfDoc;
    if (!documentHandle || !item || !canvas || batch !== thumbBatch || batch.owner.disposed) return;
    let proxy = null;
    let renderTask = null;
    let releaseTask = () => {};
    try {
      proxy = await documentHandle.getPage(pageIndex + 1);
      if (batch !== thumbBatch || source?.pdfDoc !== documentHandle || batch.owner.disposed) return;
      const base = proxy.getViewport({ scale: 1 });
      const scale = Math.min(THUMB_WIDTH / base.width, THUMB_HEIGHT / base.height);
      const viewport = proxy.getViewport({ scale });
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(viewport.width * dpr));
      canvas.height = Math.max(1, Math.round(viewport.height * dpr));
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;
      renderTask = proxy.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0]
      });
      releaseTask = batch.owner.use(() => { try { renderTask.cancel(); } catch (_) {} });
      await renderTask.promise;
      if (batch !== thumbBatch || source?.pdfDoc !== documentHandle || batch.owner.disposed) return;
      item.dataset.thumbState = 'ready';
      updateThumbState(pages[pageIndex]);
    } catch (error) {
      if (batch === thumbBatch && error?.name !== 'RenderingCancelledException') item.dataset.thumbState = 'error';
    } finally {
      releaseTask();
      proxy?.cleanup?.();
    }
  }

  function pumpThumbnails(batch) {
    if (batch !== thumbBatch || batch.owner.disposed) return;
    while (batch.active < THUMB_CONCURRENCY && batch.queue.length) {
      const pageIndex = batch.queue.shift();
      batch.active += 1;
      void renderThumbnail(batch, pageIndex).finally(() => {
        batch.active -= 1;
        pumpThumbnails(batch);
      });
    }
  }

  function enqueueThumbnail(batch, pageIndex) {
    const item = filmstrip.querySelector(`[data-page-index="${pageIndex}"]`);
    if (batch !== thumbBatch || !item || item.dataset.thumbState) return;
    item.dataset.thumbState = 'queued';
    batch.queue.push(pageIndex);
    pumpThumbnails(batch);
  }

  function renderFilmstrip() {
    releaseThumbs();
    const fragment = document.createDocumentFragment();
    if (!pages.length) {
      filmstrip.replaceChildren(fragment);
      filmstrip.classList.add('is-empty');
      refreshIcons();
      return;
    }
    const owner = createLifecycleScope();
    const batch = { owner, queue: [], active: 0 };
    thumbBatch = batch;
    pages.forEach(page => fragment.appendChild(createPageThumb(page, owner)));
    filmstrip.replaceChildren(fragment);
    filmstrip.classList.remove('is-empty');
    updateThumbStates();
    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          enqueueThumbnail(batch, Number(entry.target.dataset.pageIndex));
        });
      }, { root: filmstrip, rootMargin: '0px 260px' });
      owner.use(() => observer.disconnect());
      filmstrip.querySelectorAll('[data-page-index]').forEach(item => observer.observe(item));
    } else {
      pages.forEach(page => enqueueThumbnail(batch, page.index));
    }
    refreshIcons();
  }

  function isPreviewCurrent(request, documentHandle) {
    return !disposed && request === previewRequest && source?.pdfDoc === documentHandle && isOpen();
  }

  async function renderPreview() {
    const request = ++previewRequest;
    try { previewTask?.cancel(); } catch (_) {}
    previewTask = null;
    const page = currentPage();
    const documentHandle = source?.pdfDoc;
    if (!page || !documentHandle) {
      cancelPreview();
      renderCropOverlay();
      return;
    }
    let proxy = null;
    try {
      proxy = await documentHandle.getPage(page.index + 1);
      if (!isPreviewCurrent(request, documentHandle)) return;
      const base = proxy.getViewport({ scale: 1 });
      page.displayWidth = base.width;
      page.displayHeight = base.height;
      page.rotation = proxy.rotate || 0;
      const availableWidth = Math.max(260, canvasScroll.clientWidth - 64);
      const availableHeight = Math.max(230, canvasScroll.clientHeight - 64);
      const fitScale = Math.min(availableWidth / base.width, availableHeight / base.height, 1.6);
      previewScale = Math.max(0.08, fitScale * previewZoom);
      const cssViewport = proxy.getViewport({ scale: previewScale });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const renderViewport = proxy.getViewport({ scale: previewScale * dpr });
      previewCanvas.width = Math.max(1, Math.round(renderViewport.width));
      previewCanvas.height = Math.max(1, Math.round(renderViewport.height));
      previewCanvas.style.width = `${Math.round(cssViewport.width)}px`;
      previewCanvas.style.height = `${Math.round(cssViewport.height)}px`;
      canvasWrap.style.width = `${Math.round(cssViewport.width)}px`;
      canvasWrap.style.height = `${Math.round(cssViewport.height)}px`;
      canvasWrap.hidden = false;
      previewTask = proxy.render({ canvasContext: previewCanvas.getContext('2d'), viewport: renderViewport });
      await previewTask.promise;
      if (!isPreviewCurrent(request, documentHandle)) return;
      previewTask = null;
      renderCropOverlay();
      if (previewStatus) previewStatus.textContent = text('home.pdfCrop.previewReady', { page: page.index + 1 });
    } catch (error) {
      if (!isPreviewCurrent(request, documentHandle) || error?.name === 'RenderingCancelledException') return;
      console.error('[PDF Crop] preview failed:', error);
      if (previewStatus) previewStatus.textContent = text('home.pdfCrop.previewFailed');
    } finally {
      proxy?.cleanup?.();
    }
  }

  function replaceDocument(staged) {
    const previous = source;
    cancelPreview();
    releaseThumbs();
    source = staged.source;
    pages = staged.pages;
    currentIndex = 0;
    scope = 'all';
    marginsLinked = false;
    reframeMode = false;
    history = [];
    future = [];
    previewZoom = 1;
    renderLinkButton();
    renderFilmstrip();
    refreshControls();
    return previous;
  }

  async function resetDocument() {
    cancelPointer();
    marginEditBefore = null;
    cancelPreview();
    releaseThumbs();
    const previous = source;
    source = null;
    pages = [];
    currentIndex = 0;
    scope = 'all';
    marginsLinked = false;
    reframeMode = false;
    history = [];
    future = [];
    previewZoom = 1;
    filmstrip.replaceChildren();
    renderFilmstrip();
    renderLinkButton();
    refreshControls();
    await releaseSource(previous);
  }

  function unitFactor() {
    return unitSelect?.value === 'pt' ? 1 : POINTS_PER_MM;
  }

  function formatUnitValue(points) {
    const converted = points / unitFactor();
    return Math.abs(converted) >= 100 ? converted.toFixed(0) : converted.toFixed(1).replace(/\.0$/, '');
  }

  function updateMarginFields() {
    const page = currentPage();
    if (!page) {
      marginInputs.forEach(input => { input.value = '0'; });
      return;
    }
    const margins = pdfCropRectToMargins(page.rect, { width: page.displayWidth, height: page.displayHeight });
    marginInputs.forEach(input => {
      if (document.activeElement === input && marginEditBefore) return;
      input.value = formatUnitValue(margins[input.dataset.marginSide]);
    });
  }

  function updateDimension() {
    const page = currentPage();
    if (!page || !dimension) {
      if (dimension) dimension.textContent = '-';
      return;
    }
    const width = page.rect.width * page.displayWidth;
    const height = page.rect.height * page.displayHeight;
    dimension.textContent = unitSelect?.value === 'pt'
      ? `${width.toFixed(1)} × ${height.toFixed(1)} pt`
      : `${(width / POINTS_PER_MM).toFixed(1)} × ${(height / POINTS_PER_MM).toFixed(1)} mm`;
  }

  function renderCropOverlay() {
    const page = currentPage();
    if (!page || canvasWrap.hidden) {
      interactionLayer.hidden = true;
      return;
    }
    interactionLayer.hidden = false;
    const rect = normalizePdfCropRect(page.rect);
    selection.style.left = `${rect.x * 100}%`;
    selection.style.top = `${rect.y * 100}%`;
    selection.style.width = `${rect.width * 100}%`;
    selection.style.height = `${rect.height * 100}%`;
    interactionLayer.classList.toggle('is-unset', !page.explicit);
    interactionLayer.classList.toggle('is-reframing', reframeMode);
    if (sizeBadge) {
      const width = rect.width * page.displayWidth;
      const height = rect.height * page.displayHeight;
      sizeBadge.textContent = unitSelect?.value === 'pt'
        ? `${Math.round(width)} × ${Math.round(height)} pt`
        : `${(width / POINTS_PER_MM).toFixed(1)} × ${(height / POINTS_PER_MM).toFixed(1)} mm`;
    }
    updateMarginFields();
    updateDimension();
  }

  function refreshControls() {
    const busy = isBusy();
    const page = currentPage();
    const hasCrop = pages.some(item => item.explicit);
    const scopedCount = scope === 'all' ? pages.length : (page ? 1 : 0);
    if (pageIndicator) pageIndicator.textContent = page
      ? text('home.pdfCrop.pageIndicator', { current: currentIndex + 1, total: pages.length })
      : text('home.pdfCrop.noDocument');
    if (pageCount) pageCount.textContent = text('home.pdfCrop.totalPages', { count: pages.length });
    if (fileName) fileName.textContent = source?.name || text('home.pdfCrop.noFile');
    if (fileMeta) fileMeta.textContent = source
      ? text('home.pdfCrop.fileMeta', { pages: pages.length, size: formatBytes(source.size) })
      : text('home.pdfCrop.localOnly');
    if (scopeNote) scopeNote.textContent = hasDocument()
      ? text(scope === 'all' ? 'home.pdfCrop.scopeAllStatus' : 'home.pdfCrop.scopeCurrentStatus', { count: scopedCount, page: currentIndex + 1 })
      : text('home.pdfCrop.scopeEmpty');
    overlay.querySelectorAll('[data-crop-scope]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.cropScope === scope);
      button.disabled = busy || !hasDocument();
    });
    if (prevButton) prevButton.disabled = busy || currentIndex <= 0;
    if (nextButton) nextButton.disabled = busy || currentIndex >= pages.length - 1;
    if (zoomOutButton) zoomOutButton.disabled = !hasDocument() || previewZoom <= PREVIEW_MIN_ZOOM;
    if (zoomInButton) zoomInButton.disabled = !hasDocument() || previewZoom >= PREVIEW_MAX_ZOOM;
    if (fitButton) fitButton.disabled = !hasDocument();
    if (zoomValue) zoomValue.textContent = `${Math.round(previewZoom * 100)}%`;
    if (resetPageButton) resetPageButton.disabled = busy || !page?.explicit;
    if (resetAllButton) resetAllButton.disabled = busy || !hasCrop;
    if (undoButton) undoButton.disabled = busy || !history.length;
    if (redoButton) redoButton.disabled = busy || !future.length;
    if (reframeButton) {
      reframeButton.disabled = busy || !hasDocument();
      reframeButton.setAttribute('aria-pressed', String(reframeMode));
    }
    if (linkMarginsButton) linkMarginsButton.disabled = busy || !hasDocument();
    if (unitSelect) unitSelect.disabled = busy || !hasDocument();
    customSelectControls.forEach(control => control.refresh());
    marginInputs.forEach(input => { input.disabled = busy || !hasDocument(); });
    if (emptyState) emptyState.hidden = hasDocument();
    if (!hasDocument()) canvasWrap.hidden = true;
    if (previewStatus && !hasDocument()) previewStatus.textContent = text('home.pdfCrop.previewEmpty');
    linkMarginsButton?.setAttribute('aria-pressed', String(marginsLinked));
    renderCropOverlay();
  }

  function refreshCropState(syncInputs = true) {
    updateThumbStates();
    renderCropOverlay();
    if (syncInputs) updateMarginFields();
    emitChange();
  }

  function applySnapshot(snapshot) {
    if (!Array.isArray(snapshot) || snapshot.length !== pages.length) return;
    pages.forEach((page, index) => {
      page.rect = normalizePdfCropRect(snapshot[index].rect);
      page.explicit = Boolean(snapshot[index].explicit);
    });
    refreshCropState();
  }

  function commitHistory(before) {
    const after = snapshotPages(pages);
    if (!before || snapshotsEqual(before, after)) return false;
    history.push(before);
    if (history.length > HISTORY_LIMIT) history.shift();
    future = [];
    emitChange();
    return true;
  }

  function undo() {
    if (!history.length || isBusy()) return;
    future.push(snapshotPages(pages));
    applySnapshot(history.pop());
  }

  function redo() {
    if (!future.length || isBusy()) return;
    history.push(snapshotPages(pages));
    applySnapshot(future.pop());
  }

  function applyRectToScope(rect, explicit = true, selectedScope = scope) {
    const normalized = normalizePdfCropRect(rect);
    if (selectedScope === 'all') {
      pages.forEach(page => { page.rect = { ...normalized }; page.explicit = explicit; });
    } else {
      const page = currentPage();
      if (page) { page.rect = { ...normalized }; page.explicit = explicit; }
    }
    refreshCropState();
  }

  function applyMarginsToScope() {
    const factor = unitFactor();
    const margins = Object.fromEntries(marginInputs.map(input => [
      input.dataset.marginSide,
      Math.max(0, Number(input.value) || 0) * factor
    ]));
    const targets = scope === 'all' ? pages : [currentPage()].filter(Boolean);
    targets.forEach(page => {
      page.rect = pdfCropMarginsToRect(margins, { width: page.displayWidth, height: page.displayHeight });
      page.explicit = true;
    });
    refreshCropState(false);
  }

  function selectPage(index) {
    if (!Number.isInteger(index) || index < 0 || index >= pages.length || index === currentIndex) return;
    currentIndex = index;
    reframeMode = false;
    emitChange();
    updateThumbStates();
    filmstrip.querySelector(`[data-page-index="${index}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    void renderPreview();
  }

  function changeZoom(factor) {
    previewZoom = Math.min(PREVIEW_MAX_ZOOM, Math.max(PREVIEW_MIN_ZOOM, previewZoom * factor));
    emitChange();
    void renderPreview();
  }

  function resetCurrentPage() {
    const page = currentPage();
    if (!page?.explicit) return;
    const before = snapshotPages(pages);
    page.rect = { ...PDF_CROP_FULL_RECT };
    page.explicit = false;
    commitHistory(before);
    refreshCropState();
  }

  function resetAllPages() {
    if (!pages.some(page => page.explicit)) return;
    const before = snapshotPages(pages);
    pages.forEach(page => { page.rect = { ...PDF_CROP_FULL_RECT }; page.explicit = false; });
    commitHistory(before);
    reframeMode = false;
    refreshCropState();
  }

  function normalizedPointer(event) {
    const rect = interactionLayer.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    };
  }

  function beginCropPointer(event) {
    if (!hasDocument() || isBusy() || event.button !== 0) return;
    const page = currentPage();
    const handle = event.target.closest('[data-handle]')?.dataset.handle || '';
    const insideSelection = Boolean(event.target.closest('#pdfCropSelection'));
    let mode = '';
    if (handle && page.explicit && !reframeMode) mode = 'resize';
    else if (insideSelection && page.explicit && !reframeMode) mode = 'move';
    else if (!page.explicit || reframeMode) mode = 'draw';
    if (!mode) return;
    event.preventDefault();
    const point = normalizedPointer(event);
    pointerState = {
      pointerId: event.pointerId,
      mode,
      handle,
      start: point,
      startClientX: event.clientX,
      startClientY: event.clientY,
      rect: { ...page.rect },
      before: snapshotPages(pages),
      moved: false
    };
    interactionLayer.classList.add('is-drawing');
    try { interactionLayer.setPointerCapture(event.pointerId); } catch (_) {}
    if (mode === 'draw') applyRectToScope({ x: point.x, y: point.y, width: 0.002, height: 0.002 }, true);
  }

  function handleCropPointerMove(event) {
    const state = pointerState;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = normalizedPointer(event);
    const dx = point.x - state.start.x;
    const dy = point.y - state.start.y;
    state.moved ||= Math.hypot(event.clientX - state.startClientX, event.clientY - state.startClientY) >= 4;
    let rect = { ...state.rect };
    const minWidth = Math.min(0.5, PDF_CROP_LIMITS.minCropPoints / Math.max(1, currentPage()?.displayWidth || 1));
    const minHeight = Math.min(0.5, PDF_CROP_LIMITS.minCropPoints / Math.max(1, currentPage()?.displayHeight || 1));
    if (state.mode === 'draw') {
      rect = {
        x: Math.min(state.start.x, point.x),
        y: Math.min(state.start.y, point.y),
        width: Math.max(minWidth, Math.abs(point.x - state.start.x)),
        height: Math.max(minHeight, Math.abs(point.y - state.start.y))
      };
    } else if (state.mode === 'move') {
      rect.x = Math.max(0, Math.min(1 - rect.width, rect.x + dx));
      rect.y = Math.max(0, Math.min(1 - rect.height, rect.y + dy));
    } else {
      let left = rect.x;
      let right = rect.x + rect.width;
      let top = rect.y;
      let bottom = rect.y + rect.height;
      if (state.handle.includes('w')) left = Math.max(0, Math.min(right - minWidth, state.start.x + dx));
      if (state.handle.includes('e')) right = Math.min(1, Math.max(left + minWidth, state.start.x + dx));
      if (state.handle.includes('n')) top = Math.max(0, Math.min(bottom - minHeight, state.start.y + dy));
      if (state.handle.includes('s')) bottom = Math.min(1, Math.max(top + minHeight, state.start.y + dy));
      rect = { x: left, y: top, width: right - left, height: bottom - top };
    }
    applyRectToScope(rect, true);
  }

  function cancelPointer() {
    const state = pointerState;
    pointerState = null;
    interactionLayer.classList.remove('is-drawing');
    if (state) {
      try { interactionLayer.releasePointerCapture(state.pointerId); } catch (_) {}
    }
  }

  function endCropPointer(event) {
    const state = pointerState;
    if (!state || state.pointerId !== event.pointerId) return;
    cancelPointer();
    if (state.mode === 'draw' && !state.moved) applySnapshot(state.before);
    else commitHistory(state.before);
    reframeMode = false;
    emitChange();
    renderCropOverlay();
  }

  function renderLinkButton() {
    if (!linkMarginsButton) return;
    const icon = document.createElement('i');
    icon.dataset.lucide = marginsLinked ? 'link-2' : 'unlink';
    const label = document.createElement('span');
    label.textContent = text(marginsLinked ? 'home.pdfCrop.linkedMargins' : 'home.pdfCrop.linkMargins');
    linkMarginsButton.replaceChildren(icon, label);
    refreshIcons();
  }

  function cancelReframe() {
    if (!reframeMode) return false;
    reframeMode = false;
    emitChange();
    return true;
  }

  function handleShortcut(event) {
    const tag = event.target?.tagName?.toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      selectPage(currentIndex - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      selectPage(currentIndex + 1);
    }
  }

  function startSession(owner) {
    let renderTimer = 0;
    const observer = new ResizeObserver(() => {
      if (!isOpen() || !hasDocument() || isBusy()) return;
      window.clearTimeout(renderTimer);
      renderTimer = window.setTimeout(() => { void renderPreview(); }, 120);
    });
    observer.observe(canvasScroll);
    owner.use(() => {
      window.clearTimeout(renderTimer);
      observer.disconnect();
      cancelPointer();
    });
  }

  function refresh() {
    renderFilmstrip();
    renderLinkButton();
    refreshControls();
  }

  listen(prevButton, 'click', () => selectPage(currentIndex - 1));
  listen(nextButton, 'click', () => selectPage(currentIndex + 1));
  listen(zoomOutButton, 'click', () => changeZoom(0.86));
  listen(zoomInButton, 'click', () => changeZoom(1.16));
  listen(fitButton, 'click', () => { previewZoom = 1; emitChange(); void renderPreview(); });
  listen(resetPageButton, 'click', resetCurrentPage);
  listen(undoButton, 'click', undo);
  listen(redoButton, 'click', redo);
  listen(resetAllButton, 'click', resetAllPages);
  listen(reframeButton, 'click', () => { reframeMode = !reframeMode; emitChange(); });
  listen(interactionLayer, 'pointerdown', beginCropPointer);
  listen(document, 'pointermove', handleCropPointerMove, { passive: false });
  listen(document, 'pointerup', endCropPointer);
  listen(document, 'pointercancel', endCropPointer);
  overlay.querySelectorAll('[data-crop-scope]').forEach(button => {
    listen(button, 'click', () => {
      scope = button.dataset.cropScope === 'current' ? 'current' : 'all';
      emitChange();
    });
  });
  listen(linkMarginsButton, 'click', () => {
    marginsLinked = !marginsLinked;
    renderLinkButton();
    emitChange();
  });
  listen(unitSelect, 'change', () => {
    updateMarginFields();
    updateDimension();
    renderCropOverlay();
  });
  marginInputs.forEach(input => {
    listen(input, 'focus', () => { marginEditBefore ||= snapshotPages(pages); });
    listen(input, 'input', () => {
      if (marginsLinked) marginInputs.forEach(candidate => { if (candidate !== input) candidate.value = input.value; });
      applyMarginsToScope();
    });
    listen(input, 'change', () => {
      commitHistory(marginEditBefore);
      marginEditBefore = null;
      refreshCropState();
    });
    listen(input, 'blur', () => {
      if (!marginEditBefore) return;
      commitHistory(marginEditBefore);
      marginEditBefore = null;
    });
  });

  renderLinkButton();
  refreshControls();

  async function dispose() {
    if (disposed) return;
    await resetDocument();
    disposed = true;
    lifecycle.dispose();
  }

  return {
    cancelReframe,
    dispose,
    getExportState: () => ({
      bytes: source?.bytes,
      crops: pages.map(page => ({ rect: { ...page.rect }, explicit: page.explicit, rotation: page.rotation })),
      pageCount: pages.length,
      sourceName: source?.name || 'document.pdf'
    }),
    hasCrop: () => pages.some(page => page.explicit),
    hasDocument,
    handleShortcut,
    refresh,
    refreshControls,
    releaseSource,
    renderPreview,
    replaceDocument,
    resetDocument,
    stageDocument,
    startSession
  };
}
