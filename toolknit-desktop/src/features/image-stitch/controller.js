import { createLifecycleScope } from '../../app/tool-lifecycle.js';
import { tauriCorePromise, tauriEventPromise } from '../../platform/tauri-runtime.js';
import { calculateImageStitchLayout, normalizeImageStitchRequest } from '../../image-stitch-core.js';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { createIcons, icons } from 'lucide';

function escapeHtml(value) {
  const text = String(value ?? '');
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

export function createImageStitchController({
  overlay,
  isTauri = false,
  t = key => key,
  onLangChange = () => () => {},
  formatFileSize = value => String(value || 0),
  displayFilesystemPath = value => String(value || ''),
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = instance => instance,
  getOutputDir = async () => '',
  openOutputFolder = async () => false,
  openHelpOverlay = () => {},
  tauriCore = tauriCorePromise,
  tauriEvents = tauriEventPromise,
  refreshIcons = () => {},
  documentRef = globalThis.document
} = {}) {
  if (!overlay || !documentRef) throw new Error('image-stitch:missing-root');
  const byId = id => overlay.querySelector('#' + id);
  const listen = (target, type, handler, options) => target
    ? lifecycle.event(target, type, handler, options)
    : () => {};
  const lifecycle = createLifecycleScope({ onError: error => console.error('[Image Stitch] dispose error:', error) });
  let disposed = false;
  let nativeDropCleanup = null;
  let nativeDropRegistration = null;
  const isOpen = () => !disposed && overlay.classList.contains('visible');

  // ===== Image Stitch Tool =====
  const imageStitchOverlay = overlay;
  const imageStitchPlasmaBg = byId('imageStitchPlasmaBg');
  const imageStitchQueue = byId('imageStitchQueue');
  const imageStitchQueueEmpty = byId('imageStitchQueueEmpty');
  const imageStitchPreview = byId('imageStitchPreview');
  const imageStitchPreviewViewport = byId('imageStitchPreviewViewport');
  const imageStitchPreviewEmpty = byId('imageStitchPreviewEmpty');
  const imageStitchCount = byId('imageStitchCount');
  const imageStitchEstimate = byId('imageStitchEstimate');
  const imageStitchExport = byId('imageStitchExport');
  const imageStitchClear = byId('imageStitchClear');
  const imageStitchPdfPick = byId('imageStitchPdfPick');
  const imageStitchProcessing = byId('imageStitchProcessing');
  const imageStitchProgressFill = byId('imageStitchProgressFill');
  const imageStitchProgressValue = byId('imageStitchProgressValue');
  const imageStitchProgressText = byId('imageStitchProgressText');
  const imageStitchQualityWrap = byId('imageStitchQualityWrap');
  const imageStitchDropZone = byId('imageStitchDropZone');
  let imageStitchFiles = [];
  let imageStitchMode = 'vertical';
  let imageStitchReference = 'first';
  let imageStitchFormat = 'png';
  let imageStitchBusy = false;
  let imageStitchDragIndex = -1;
  let imageStitchJobId = '';
  let imageStitchProgressUnlisten = null;
  let lastImageStitchOutputPath = '';
  let imageStitchPdfSessions = [];
  let imageStitchImportingPdf = false;
  let imageStitchPdfImportCancelled = false;
  let imageStitchPdfLoadingTask = null;
  let imageStitchCancelRequested = false;
  let imageStitchPlasmaInstance = null;
  let imageStitchSessionRevision = 0;
  let imageStitchOperation = null;

  const isCurrentSession = revision => isOpen() && revision === imageStitchSessionRevision;
  const isCurrentOperation = operation => operation
    && imageStitchOperation === operation
    && !disposed
    && operation.revision === imageStitchSessionRevision
    && isOpen();
  const ownsOperation = operation => imageStitchOperation === operation && !disposed;
  
  function openImageStitchOverlay() {
    if (!isOpen()) imageStitchSessionRevision += 1;
    imageStitchOverlay?.classList.add('visible');
    imageStitchOverlay?.setAttribute('aria-hidden', 'false');
    if (imageStitchPlasmaBg && !imageStitchPlasmaInstance) {
      imageStitchPlasmaInstance = initStandardToolPlasma(imageStitchPlasmaBg);
    }
  }
  
  function closeImageStitchOverlay() {
    imageStitchSessionRevision += 1;
    imageStitchCancelRequested = true;
    imageStitchPdfImportCancelled = true;
    const activeJobId = imageStitchJobId;
    imageStitchJobId = '';
    if (imageStitchProgressUnlisten) {
      imageStitchProgressUnlisten();
      imageStitchProgressUnlisten = null;
    }
    if (imageStitchBusy && isTauri && activeJobId) {
      tauriCore.then(({ invoke }) => invoke('cancel_convert')).catch(() => {});
    }
    if (imageStitchPdfLoadingTask) {
      try {
        const destroy = imageStitchPdfLoadingTask.destroy?.();
        destroy?.catch?.(() => {});
      } catch {}
    }
    imageStitchOverlay?.classList.remove('visible');
    imageStitchOverlay?.setAttribute('aria-hidden', 'true');
    imageStitchDropZone?.classList.remove('visible');
    imageStitchProcessing?.classList.remove('visible');
    byId('imageStitchSuccessOverlay')?.classList.remove('visible');
    imageStitchPlasmaInstance = disposeStandardToolPlasma(imageStitchPlasmaInstance);
    void cleanupAllImageStitchPdfSessions(true, imageStitchSessionRevision);
  }
  
  function imageStitchSettings() {
    return normalizeImageStitchRequest({
      mode: imageStitchMode,
      reference: imageStitchReference,
      spacing_px: Number(byId('imageStitchSpacing')?.value),
      scale_percent: Number(byId('imageStitchScale')?.value),
      format: imageStitchFormat,
      jpeg_quality: Number(byId('imageStitchQuality')?.value || 92),
      background_rgba: '#FFFFFFFF'
    });
  }
  
  function imageStitchOutputName() {
    const value = byId('imageStitchOutputName')?.value.trim() || '';
    if (!value) return null;
    const reserved = value.split('.')[0].trimEnd().toUpperCase();
    const isReserved = ['CON', 'PRN', 'AUX', 'NUL'].includes(reserved)
      || /^(?:COM|LPT)[1-9]$/.test(reserved);
    if (value.length > 96 || value === '.' || value === '..'
      || /[\\/:*?"<>|\u0000-\u001f]/.test(value) || /[ .]$/.test(value) || isReserved) {
      throw new Error('image-stitch:invalid-output-name');
    }
    return value;
  }
  
  function imageStitchErrorMessage(error) {
    const message = String(error?.message || error || '');
    if (message.includes('animated')) return t('home.imageStitch.animatedError');
    if (message.includes('Duplicate')) return t('home.imageStitch.duplicateError');
    if (message.includes('output-too-large-for-memory')) return t('home.imageStitch.memoryError');
    if (message.includes('output-too-large')) return t('home.imageStitch.sizeError');
    if (message.includes('invalid-settings') || message.includes('Invalid stitch settings')) return t('home.imageStitch.settingsError');
    if (message.includes('invalid-output-name')) return t('home.imageStitch.outputNameError');
    if (message.includes('pdf-') || message.includes('InvalidPDF')) return t('home.imageStitch.pdfError');
    if (message.includes('invalid-input') || message.includes('Cannot read')) return t('home.imageStitch.inputError');
    return message || t('home.imageStitch.error');
  }
  
  function currentImageStitchLayout() {
    if (imageStitchFiles.length < 2) return null;
    try {
      return calculateImageStitchLayout(imageStitchFiles, imageStitchSettings());
    } catch (error) {
      imageStitchEstimate.textContent = imageStitchErrorMessage(error);
      return null;
    }
  }
  
  function fitImageStitchScaleToSafeLayout(notify = false) {
    if (imageStitchFiles.length < 2) return true;
    const scaleInput = byId('imageStitchScale');
    const startingScale = Math.min(100, Math.max(10, Number(scaleInput?.value) || 100));
    for (let scale = startingScale; scale >= 10; scale -= 1) {
      try {
        calculateImageStitchLayout(imageStitchFiles, { ...imageStitchSettings(), scale_percent: scale });
        if (scale !== startingScale && scaleInput) {
          scaleInput.value = String(scale);
          if (notify) window.showToast?.(t('home.imageStitch.autoScaled').replace('{scale}', scale));
        }
        return true;
      } catch (error) {
        if (!String(error?.code || error).includes('output_too_large')) return false;
      }
    }
    return false;
  }
  
  async function discardImageStitchPdfSession(sessionId) {
    imageStitchPdfSessions = imageStitchPdfSessions.filter(session => session.id !== sessionId);
    try {
      const { invoke } = await tauriCore;
      await invoke('discard_image_stitch_pdf_session', { sessionId });
    } catch (error) {
      console.warn('Cannot clean image stitch PDF session:', error);
    }
  }
  
  async function releaseUnusedImageStitchPdfSessions() {
    const active = new Set(imageStitchFiles.map(file => file.path.toLowerCase()));
    const unused = imageStitchPdfSessions.filter(session => !session.paths.some(path => active.has(path.toLowerCase())));
    await Promise.all(unused.map(session => discardImageStitchPdfSession(session.id)));
  }
  
  async function cleanupAllImageStitchPdfSessions(removeQueuedPages = false, revision = imageStitchSessionRevision) {
    const sessions = [...imageStitchPdfSessions];
    imageStitchPdfSessions = [];
    if (removeQueuedPages && sessions.length) {
      const temporaryPaths = new Set(sessions.flatMap(session => session.paths.map(path => path.toLowerCase())));
      imageStitchFiles = imageStitchFiles.filter(file => !temporaryPaths.has(file.path.toLowerCase()));
    }
    await Promise.all(sessions.map(async (session) => {
      try {
        const { invoke } = await tauriCore;
        await invoke('discard_image_stitch_pdf_session', { sessionId: session.id });
      } catch (error) {
        console.warn('Cannot clean image stitch PDF session:', error);
      }
    }));
    if (removeQueuedPages && (revision === imageStitchSessionRevision || !isOpen())) renderImageStitchQueue();
  }
  
  function renderImageStitchPreview() {
    if (!imageStitchPreview || !imageStitchPreviewEmpty) return;
    const layout = currentImageStitchLayout();
    imageStitchPreview.hidden = !layout;
    imageStitchPreviewEmpty.hidden = Boolean(layout);
    if (!layout) {
      imageStitchPreview.innerHTML = '';
      imageStitchPreviewViewport?.classList.remove('is-horizontal');
      if (imageStitchFiles.length < 2) imageStitchEstimate.textContent = '-- × --';
      return;
    }
    imageStitchEstimate.textContent = `${layout.width.toLocaleString()} × ${layout.height.toLocaleString()} px`;
    imageStitchPreview.className = `image-stitch-preview-composition ${layout.mode}`;
    imageStitchPreviewViewport?.classList.toggle('is-horizontal', layout.mode === 'horizontal');
    imageStitchPreview.style.background = layout.background_rgba;
    const previewAxis = layout.mode === 'vertical' ? 440 : 320;
    const fixedAxis = layout.mode === 'vertical' ? layout.width : layout.height;
    imageStitchPreview.style.gap = `${Math.max(0, layout.spacing_px * previewAxis / fixedAxis)}px`;
    imageStitchPreview.innerHTML = layout.items.map((item, index) => {
      const ratio = `${item.target_width} / ${item.target_height}`;
      const previewUrl = item.preview_data_url || item.previewDataUrl || item.thumbnail_data_url || item.thumbnailDataUrl || '';
      return `<div class="image-stitch-preview-item" style="aspect-ratio:${ratio}" title="${escapeHtml(item.name)}"><img src="${previewUrl}" alt=""></div>`;
    }).join('');
  }
  
  function moveImageStitchFile(from, to) {
    if (imageStitchBusy || from === to || from < 0 || to < 0 || from >= imageStitchFiles.length || to >= imageStitchFiles.length) return;
    const [file] = imageStitchFiles.splice(from, 1);
    imageStitchFiles.splice(to, 0, file);
  
  }
  
  function renderImageStitchQueue() {
    if (!imageStitchQueue) return;
    imageStitchCount.textContent = `${imageStitchFiles.length} / 100`;
    imageStitchQueueEmpty.hidden = imageStitchFiles.length > 0;
    imageStitchQueue.hidden = imageStitchFiles.length === 0;
    imageStitchClear.disabled = imageStitchBusy || imageStitchFiles.length === 0;
    imageStitchExport.disabled = imageStitchBusy || imageStitchFiles.length < 2 || !currentImageStitchLayout();
    imageStitchQueue.innerHTML = imageStitchFiles.map((file, index) => `
      <div class="image-stitch-row" draggable="${!imageStitchBusy}" data-index="${index}">
        <span class="image-stitch-row-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="image-stitch-row-thumb"><img src="${file.thumbnail_data_url}" alt=""></span>
        <span class="image-stitch-row-info"><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><span>${file.width} × ${file.height}</span></span>
        <span class="image-stitch-row-actions">
          <button type="button" data-action="up" title="${t('home.imageStitch.moveUp')}" ${index === 0 || imageStitchBusy ? 'disabled' : ''}><i data-lucide="chevron-up"></i></button>
          <button type="button" data-action="down" title="${t('home.imageStitch.moveDown')}" ${index === imageStitchFiles.length - 1 || imageStitchBusy ? 'disabled' : ''}><i data-lucide="chevron-down"></i></button>
          <button type="button" data-action="remove" title="${t('home.imageStitch.remove')}" ${imageStitchBusy ? 'disabled' : ''}><i data-lucide="x"></i></button>
        </span>
      </div>`).join('');
    imageStitchQueue.querySelectorAll('.image-stitch-row').forEach((row) => {
      const index = Number(row.dataset.index);
      row.querySelector('[data-action="up"]')?.addEventListener('click', () => moveImageStitchFile(index, index - 1));
      row.querySelector('[data-action="down"]')?.addEventListener('click', () => moveImageStitchFile(index, index + 1));
      row.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
        imageStitchFiles.splice(index, 1);
        renderImageStitchQueue();
        void releaseUnusedImageStitchPdfSessions();
      });
      row.addEventListener('dragstart', (event) => {
        imageStitchDragIndex = index;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        imageStitchDragIndex = -1;
        imageStitchQueue.querySelectorAll('.image-stitch-row').forEach(item => item.classList.remove('dragging', 'drag-target'));
      });
      row.addEventListener('dragover', (event) => {
        event.preventDefault();
        imageStitchQueue.querySelectorAll('.image-stitch-row').forEach(item => item.classList.remove('drag-target'));
        if (imageStitchDragIndex !== index) row.classList.add('drag-target');
      });
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        moveImageStitchFile(imageStitchDragIndex, index);
      });
    });
    renderImageStitchPreview();
    if (typeof createIcons === 'function') createIcons({ icons });
  }
  
  async function addImageStitchPaths(rawPaths, revision = imageStitchSessionRevision) {
    if (!isCurrentSession(revision)) return false;
    const paths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths])
      .filter(path => typeof path === 'string' && /\.(?:jpe?g|png|webp|bmp|gif)$/i.test(path))
      .filter(path => !imageStitchFiles.some(file => file.path.toLowerCase() === path.toLowerCase()));
    if (!paths.length) return false;
    if (imageStitchFiles.length + paths.length > 100) {
      window.showToast?.(t('home.imageStitch.limitError'));
      return false;
    }
    try {
      const { invoke } = await tauriCore;
      const inspected = await invoke('inspect_image_stitch_inputs', { inputPaths: paths });
      if (!isCurrentSession(revision)) return false;
      imageStitchFiles.push(...inspected.map(item => ({
        path: item.path,
        name: item.name,
        width: item.width,
        height: item.height,
        thumbnail_data_url: item.thumbnail_data_url || item.thumbnailDataUrl,
        preview_data_url: item.preview_data_url || item.previewDataUrl || item.thumbnail_data_url || item.thumbnailDataUrl
      })));
      if (!isCurrentSession(revision)) return false;
      if (!fitImageStitchScaleToSafeLayout(true)) {
        imageStitchFiles.splice(imageStitchFiles.length - inspected.length, inspected.length);
        window.showToast?.(t('home.imageStitch.sizeError'));
        renderImageStitchQueue();
        return false;
      }
      if (!isCurrentSession(revision)) return false;
      renderImageStitchQueue();
      return true;
    } catch (error) {
      window.showToast?.(imageStitchErrorMessage(error));
      return false;
    }
  }
  
  async function openImageStitcher({ source = 'images', paths = [], sessionId = null } = {}) {
    openImageStitchOverlay();
    const revision = imageStitchSessionRevision;
    const added = await addImageStitchPaths(paths, revision);
    if (isCurrentSession(revision) && added && sessionId && !imageStitchPdfSessions.some(session => session.id === sessionId)) {
      imageStitchPdfSessions.push({ id: sessionId, source, paths: [...paths] });
    }
    if (isCurrentSession(revision)) renderImageStitchQueue();
    return added;
  }
  window.openImageStitcher = openImageStitcher;
  
  async function renderPdfPageForImageStitch(pdfPage) {
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const maxPixels = 40_000_000;
    let scale = Math.min(2, Math.sqrt(maxPixels / Math.max(1, baseViewport.width * baseViewport.height)));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (imageStitchPdfImportCancelled) throw new Error('image-stitch:pdf-import-cancelled');
      const viewport = pdfPage.getViewport({ scale });
      const canvas = documentRef.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
      const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('image-stitch:pdf-page-encode-failed')), 'image/png'));
      if (blob.size <= 19 * 1024 * 1024) return new Uint8Array(await blob.arrayBuffer());
      scale *= Math.max(0.55, Math.sqrt((18 * 1024 * 1024) / blob.size) * 0.95);
    }
    throw new Error('image-stitch:invalid-pdf-page');
  }
  
  async function importPdfToImageStitcher(inputPath) {
    if (imageStitchBusy || !isTauri || typeof inputPath !== 'string' || !inputPath) return false;
    const operation = { id: `pdf-${Date.now()}-${Math.random()}`, revision: imageStitchSessionRevision };
    let session = null;
    let keepSession = false;
    try {
      if (!isCurrentSession(operation.revision)) return false;
      const { invoke } = await tauriCore;
      if (!isCurrentSession(operation.revision)) return false;
      imageStitchImportingPdf = true;
      imageStitchPdfImportCancelled = false;
      imageStitchProgressFill.style.width = '2%';
      imageStitchProgressValue.textContent = '2%';
      imageStitchProgressText.textContent = t('home.imageStitch.pdfReading');
      setImageStitchBusy(true);
      imageStitchOperation = operation;
      session = await invoke('create_image_stitch_pdf_session');
      if (!isCurrentOperation(operation)) throw new Error('image-stitch:pdf-import-cancelled');
      const rawBytes = await invoke('read_file_bytes_limited', { path: inputPath, maxBytes: 250 * 1024 * 1024 });
      if (!isCurrentOperation(operation) || imageStitchPdfImportCancelled) throw new Error('image-stitch:pdf-import-cancelled');
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (!isCurrentOperation(operation)) throw new Error('image-stitch:pdf-import-cancelled');
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const wasmUrl = new URL('assets/', documentRef.baseURI).href;
      const bytes = Array.isArray(rawBytes) ? Uint8Array.from(rawBytes) : new Uint8Array(rawBytes);
      imageStitchPdfLoadingTask = pdfjsLib.getDocument({ data: bytes, wasmUrl, useWasm: true });
      const documentProxy = await imageStitchPdfLoadingTask.promise;
      if (!isCurrentOperation(operation)) throw new Error('image-stitch:pdf-import-cancelled');
      if (documentProxy.numPages < 1 || imageStitchFiles.length + documentProxy.numPages > 100) {
        throw new Error('image-stitch:pdf-too-many');
      }
      const pagePaths = [];
      for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
        if (!isCurrentOperation(operation) || imageStitchPdfImportCancelled) throw new Error('image-stitch:pdf-import-cancelled');
        const page = await documentProxy.getPage(pageNumber);
        try {
          const pageBytes = await renderPdfPageForImageStitch(page);
          if (!isCurrentOperation(operation)) throw new Error('image-stitch:pdf-import-cancelled');
          const pagePath = await invoke('write_image_stitch_pdf_page', {
            sessionId: session.session_id || session.sessionId,
            pageNumber,
            bytes: Array.from(pageBytes)
          });
          if (!isCurrentOperation(operation)) throw new Error('image-stitch:pdf-import-cancelled');
          pagePaths.push(pagePath);
        } finally {
          try { page.cleanup(); } catch {}
        }
        const percent = Math.round(5 + pageNumber / documentProxy.numPages * 90);
        if (isCurrentOperation(operation)) {
          imageStitchProgressFill.style.width = `${percent}%`;
          imageStitchProgressValue.textContent = `${percent}%`;
          imageStitchProgressText.textContent = t('home.imageStitch.pdfRendering')
            .replace('{current}', pageNumber).replace('{total}', documentProxy.numPages);
        }
      }
      const sessionId = session.session_id || session.sessionId;
      if (!isCurrentOperation(operation)) throw new Error('image-stitch:pdf-import-cancelled');
      keepSession = await openImageStitcher({ source: 'pdf-to-image', paths: pagePaths, sessionId });
      if (!isCurrentOperation(operation)) throw new Error('image-stitch:pdf-import-cancelled');
      if (!keepSession) throw new Error('image-stitch:pdf-import-failed');
      window.showToast?.(t('home.imageStitch.pdfImported').replace('{count}', pagePaths.length));
      return true;
    } catch (error) {
      const message = String(error?.message || error || '');
      if (isCurrentOperation(operation) && !message.includes('cancelled')) {
        window.showToast?.(message.includes('pdf-too-many') ? t('home.imageStitch.pdfTooMany') : imageStitchErrorMessage(error));
      }
      return false;
    } finally {
      if (imageStitchPdfLoadingTask) {
        try { await imageStitchPdfLoadingTask.destroy(); } catch {}
      }
      imageStitchPdfLoadingTask = null;
      if (session && !keepSession) {
        await discardImageStitchPdfSession(session.session_id || session.sessionId);
      }
      if (ownsOperation(operation)) {
        imageStitchImportingPdf = false;
        imageStitchPdfImportCancelled = false;
        imageStitchOperation = null;
        setImageStitchBusy(false);
      }
    }
  }
  window.importPdfToImageStitcher = importPdfToImageStitcher;
  
  listen(imageStitchPdfPick, 'click', async () => {
    if (imageStitchBusy || !isTauri) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const inputPath = await open({ multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (typeof inputPath === 'string' && isOpen()) await importPdfToImageStitcher(inputPath);
    } catch (error) {
      window.showToast?.(imageStitchErrorMessage(error));
    }
  });
  
  listen(byId('imageStitchPick'), 'click', async () => {
    if (imageStitchBusy) return;
    const revision = imageStitchSessionRevision;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const paths = await open({ multiple: true, filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }] });
      if (paths && isCurrentSession(revision)) await addImageStitchPaths(paths, revision);
    } catch (error) {
      window.showToast?.(imageStitchErrorMessage(error));
    }
  });
  listen(byId('imageStitchHelp'), 'click', () => openHelpOverlay('image-stitch'));
  listen(imageStitchClear, 'click', () => {
    if (imageStitchBusy) return;
    imageStitchFiles = [];
    renderImageStitchQueue();
    void cleanupAllImageStitchPdfSessions();
  });
  listen(byId('imageStitchMode'), 'click', event => {
    const button = event.target.closest('[data-mode]');
    if (!button || imageStitchBusy) return;
    imageStitchMode = button.dataset.mode;
    overlay.querySelectorAll('#imageStitchMode [data-mode]').forEach(item => item.classList.toggle('active', item === button));
    fitImageStitchScaleToSafeLayout(true);
    renderImageStitchQueue();
  });
  listen(byId('imageStitchReference'), 'click', event => {
    const button = event.target.closest('[data-reference]');
    if (!button || imageStitchBusy) return;
    imageStitchReference = button.dataset.reference;
    overlay.querySelectorAll('#imageStitchReference [data-reference]').forEach(item => item.classList.toggle('active', item === button));
    fitImageStitchScaleToSafeLayout(true);
    renderImageStitchQueue();
  });
  listen(byId('imageStitchFormat'), 'click', event => {
    const button = event.target.closest('[data-format]');
    if (!button || imageStitchBusy) return;
    imageStitchFormat = button.dataset.format;
    overlay.querySelectorAll('#imageStitchFormat [data-format]').forEach(item => item.classList.toggle('active', item === button));
    imageStitchQualityWrap.hidden = imageStitchFormat !== 'jpg';
    renderImageStitchQueue();
  });
  ['imageStitchSpacing', 'imageStitchScale', 'imageStitchQuality', 'imageStitchOutputName'].forEach((id) => {
    listen(byId(id), 'input', () => {
      renderImageStitchQueue();
    });
    listen(byId(id), 'change', (event) => {
      const input = event.currentTarget;
      if (input.type === 'number') input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value))));
      if (id === 'imageStitchSpacing') fitImageStitchScaleToSafeLayout(true);
      renderImageStitchQueue();
    });
  });
  
  async function ensureImageStitchProgressListener(operation) {
    if (imageStitchProgressUnlisten) return true;
    const { listen } = await tauriEvents;
    const unlisten = await listen('image-stitch-progress', (event) => {
      if (!isCurrentOperation(operation)) return;
      const payload = event.payload || {};
      if (payload.jobId && imageStitchJobId && payload.jobId !== imageStitchJobId) return;
      const percent = Math.max(0, Math.min(100, Number(payload.percent) || 0));
      imageStitchProgressFill.style.width = `${percent}%`;
      imageStitchProgressValue.textContent = `${Math.round(percent)}%`;
      const labels = {
        prepare: 'home.imageStitch.preparing', inspect: 'home.imageStitch.inspecting',
        compose: 'home.imageStitch.composing', encode: 'home.imageStitch.encoding', complete: 'home.imageStitch.completing'
      };
      imageStitchProgressText.textContent = t(labels[payload.phase] || 'home.imageStitch.preparing')
        .replace('{current}', payload.current ?? 0).replace('{total}', payload.total ?? imageStitchFiles.length);
    });
    if (!isCurrentOperation(operation)) {
      unlisten?.();
      return false;
    }
    imageStitchProgressUnlisten = unlisten;
    return true;
  }
  
  function setImageStitchBusy(busy) {
    imageStitchBusy = busy;
    imageStitchProcessing.classList.toggle('visible', busy);
    imageStitchOverlay.querySelectorAll('button, input').forEach(control => { control.disabled = busy; });
    byId('imageStitchCancel').disabled = !busy;
    if (!busy) renderImageStitchQueue();
  }
  
  listen(imageStitchExport, 'click', async () => {
    const layout = currentImageStitchLayout();
    if (!layout || imageStitchBusy) return window.showToast?.(t('home.imageStitch.minimumError'));
    let outputName;
    try { outputName = imageStitchOutputName(); } catch (error) { return window.showToast?.(imageStitchErrorMessage(error)); }
    const operation = {
      id: globalThis.crypto?.randomUUID?.() || `stitch-${Date.now()}`,
      revision: imageStitchSessionRevision
    };
    imageStitchJobId = operation.id;
    imageStitchOperation = operation;
    imageStitchCancelRequested = false;
    imageStitchProgressFill.style.width = '0%';
    imageStitchProgressValue.textContent = '0%';
    imageStitchProgressText.textContent = t('home.imageStitch.preparing');
    setImageStitchBusy(true);
    try {
      if (!isCurrentOperation(operation)) return;
      if (!await ensureImageStitchProgressListener(operation)) return;
      const { invoke } = await tauriCore;
      if (!isCurrentOperation(operation)) return;
      const settings = imageStitchSettings();
      const result = await invoke('stitch_images', {
        inputPaths: imageStitchFiles.map(file => file.path),
         outputDir: await getOutputDir('Images/Image Stitch'),
        outputName,
        mode: settings.mode,
        reference: settings.reference,
        spacingPx: settings.spacing_px,
        scalePercent: settings.scale_percent,
        format: settings.format,
        jpegQuality: settings.jpeg_quality,
        backgroundRgba: settings.background_rgba,
        jobId: imageStitchJobId
      });
      if (!isCurrentOperation(operation)) return;
      await cleanupAllImageStitchPdfSessions(true, operation.revision);
      if (!isCurrentOperation(operation)) return;
      lastImageStitchOutputPath = result.output_path || result.outputPath || '';
      byId('imageStitchSuccessMeta').textContent = t('home.imageStitch.successMeta').replace('{count}', result.count).replace('{format}', result.format);
      byId('imageStitchSuccessSize').textContent = `${result.width} × ${result.height} px`;
      byId('imageStitchSuccessPath').textContent = displayFilesystemPath(lastImageStitchOutputPath);
      byId('imageStitchSuccessOverlay').classList.add('visible');
    } catch (error) {
      if (isCurrentOperation(operation) && !String(error).includes('cancelled')) window.showToast?.(imageStitchErrorMessage(error));
    } finally {
      if (ownsOperation(operation)) {
        if (imageStitchCancelRequested) await cleanupAllImageStitchPdfSessions(true, operation.revision);
        if (imageStitchProgressUnlisten) {
          imageStitchProgressUnlisten();
          imageStitchProgressUnlisten = null;
        }
        imageStitchOperation = null;
        imageStitchBusy = false;
        if (isOpen()) setImageStitchBusy(false);
      }
    }
  });
  listen(byId('imageStitchCancel'), 'click', () => {
    imageStitchProgressText.textContent = t('home.imageStitch.cancelling');
    if (imageStitchImportingPdf) {
      imageStitchPdfImportCancelled = true;
      imageStitchPdfLoadingTask?.destroy?.().catch(() => {});
      return;
    }
    imageStitchCancelRequested = true;
    tauriCore.then(({ invoke }) => invoke('cancel_convert')).catch(() => {});
  });
  listen(byId('imageStitchSuccessOk'), 'click', () => byId('imageStitchSuccessOverlay')?.classList.remove('visible'));
  listen(byId('imageStitchOpenFolder'), 'click', () => { if (lastImageStitchOutputPath) openOutputFolder(lastImageStitchOutputPath).catch(() => {}); byId('imageStitchSuccessOverlay')?.classList.remove('visible'); });
  listen(byId('imageStitchBack'), 'click', closeImageStitchOverlay);
  listen(imageStitchOverlay, 'dragover', event => { event.preventDefault(); if (!imageStitchBusy) imageStitchDropZone?.classList.add('visible'); });
  listen(imageStitchOverlay, 'dragleave', event => { if (!imageStitchOverlay.contains(event.relatedTarget)) imageStitchDropZone?.classList.remove('visible'); });
  listen(imageStitchOverlay, 'drop', event => { event.preventDefault(); imageStitchDropZone?.classList.remove('visible'); });
  renderImageStitchQueue();

  async function registerNativeDrop() {
    if (!isTauri || nativeDropCleanup || nativeDropRegistration || disposed) return;
    nativeDropRegistration = (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const unlisten = await getCurrentWebview().onDragDropEvent(async event => {
          if (!isOpen() || imageStitchBusy) return;
          const payload = event.payload || {};
          if (payload.type === 'over' || payload.type === 'enter') imageStitchDropZone?.classList.add('visible');
          else if (payload.type === 'leave') imageStitchDropZone?.classList.remove('visible');
          else if (payload.type === 'drop') {
            imageStitchDropZone?.classList.remove('visible');
            await addImageStitchPaths(payload.paths || [], imageStitchSessionRevision);
          }
        });
        if (disposed || !isOpen()) unlisten?.();
        else nativeDropCleanup = unlisten;
      } catch (error) {
        if (!disposed) console.error('[Image Stitch] drag registration failed:', error);
      } finally {
        nativeDropRegistration = null;
      }
    })();
    await nativeDropRegistration;
  }

  const releaseLanguage = onLangChange(() => {
    if (!disposed && isOpen()) renderImageStitchQueue();
  });
  lifecycle.use(typeof releaseLanguage === 'function' ? releaseLanguage : () => {});

  function open() {
    if (disposed) return;
    openImageStitchOverlay();
    renderImageStitchQueue();
    refreshIcons();
    void registerNativeDrop();
  }

  function close() {
    if (disposed) return;
    closeImageStitchOverlay();
    nativeDropCleanup?.();
    nativeDropCleanup = null;
  }

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    nativeDropCleanup?.();
    nativeDropCleanup = null;
    lifecycle.dispose();
    imageStitchOverlay?.replaceChildren();
  }

  return {
    open,
    close,
    dispose,
    get busy() { return imageStitchBusy; },
    openWithFile: openImageStitcher
  };
}
