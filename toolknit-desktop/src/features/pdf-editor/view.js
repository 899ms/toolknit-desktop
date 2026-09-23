/**
 * Owns the PDF Editor's visible session shell. The editor orchestrator keeps
 * document and operation state; this controller only coordinates the overlay,
 * success surface, drag hint and small file/zoom labels.
 */
export function createPdfEditorView({
  overlay,
  plasmaBg,
  dropZone,
  fileNameEl,
  fileStatsEl,
  emptyState,
  successOverlay,
  successMeta,
  successPath,
  successOpenFolder,
  successOk,
  zoomValueBtn,
  fileInput = null,
  appendInput = null,
  t = key => key,
  isTauri = false,
  isDisposed = () => false,
  initStandardToolPlasma = () => null,
  disposeStandardToolPlasma = value => value,
  displayFilesystemPath = value => value,
  getSources = () => [],
  getPages = () => [],
  getMainSourceName = () => 'document.pdf',
  formatSize = value => String(value),
  getCanvasWrap = () => null,
  getOpenFocusTarget = () => null,
  getZoomState = () => ({ viewMode: 'fit', zoomPercent: 1 }),
  getActiveOperation = () => null,
  hasDocument = () => false,
  confirmDiscardChanges = () => true,
  resetDocument = async () => {},
  focusedElement = () => null,
  restoreFocus = () => {},
  canReceiveFocus = () => true,
  syncInteractiveLayers = () => {},
  showToast = () => {}
} = {}) {
  let plasmaInstance = null;
  let overlayReturnFocus = null;
  let successReturnFocus = null;
  let lastOutputFolder = '';
  let lastSuccess = null;

  function updateFileCard() {
    if (!fileNameEl || !fileStatsEl) return;
    if (!hasDocument()) {
      fileNameEl.textContent = t('home.pdfEditor.fileNameEmpty');
      fileStatsEl.textContent = '';
      return;
    }
    const sources = getSources() || [];
    const pages = getPages() || [];
    const totalSize = sources.reduce((sum, source) => sum + (Number(source.size) || 0), 0);
    fileNameEl.textContent = getMainSourceName();
    fileStatsEl.textContent = t('home.pdfEditor.pageCount', { count: pages.length })
      + ' · ' + formatSize(totalSize);
  }

  function syncStageVisibility() {
    const has = hasDocument();
    if (emptyState) emptyState.style.display = has ? 'none' : '';
    const canvasWrap = getCanvasWrap();
    if (canvasWrap) canvasWrap.style.display = has ? '' : 'none';
  }

  function updateZoomLabel() {
    if (!zoomValueBtn) return;
    const zoomState = getZoomState() || {};
    zoomValueBtn.textContent = zoomState.viewMode === 'fit'
      ? t('home.pdfEditor.fitShort')
      : `${Math.round(Number(zoomState.zoomPercent || 0) * 100)}%`;
  }

  function openOverlay() {
    if (isDisposed() || !overlay) return;
    if (!overlay.classList.contains('visible')) overlayReturnFocus = focusedElement();
    overlay.classList.add('visible');
    if (plasmaBg && !plasmaInstance) plasmaInstance = initStandardToolPlasma(plasmaBg);
    syncInteractiveLayers();
    syncStageVisibility();
    restoreFocus(getOpenFocusTarget());
  }

  function closeSuccess(restore = true) {
    if (!successOverlay?.classList.contains('visible')) return;
    successOverlay.classList.remove('visible');
    syncInteractiveLayers();
    const returnFocus = successReturnFocus;
    successReturnFocus = null;
    if (restore) restoreFocus(returnFocus);
  }

  function renderSuccess() {
    if (!lastSuccess) return;
    const { outputDir, mode, count } = lastSuccess;
    if (successMeta) {
      successMeta.textContent = mode === 'extract'
        ? t('home.pdfEditor.successExtractMeta', { count })
        : t('home.pdfEditor.successExportMeta');
    }
    if (successPath) successPath.textContent = displayFilesystemPath(outputDir || '~/Downloads');
    if (successOpenFolder) successOpenFolder.style.display = isTauri ? '' : 'none';
  }

  function showSuccess(result, returnFocus) {
    lastOutputFolder = result?.outputDir || '';
    lastSuccess = result || null;
    successReturnFocus = returnFocus || focusedElement();
    renderSuccess();
    successOverlay?.classList.add('visible');
    syncInteractiveLayers();
    restoreFocus(successOk || successOpenFolder);
  }

  function showDropZone() {
    if (getActiveOperation() || !overlay) return;
    overlay.classList.add('drag-over');
    dropZone?.classList.add('visible');
  }

  function hideDropZone() {
    overlay?.classList.remove('drag-over');
    dropZone?.classList.remove('visible');
  }

  function closeOverlay() {
    if (isDisposed() || !overlay) return;
    if (getActiveOperation()) {
      showToast(t('home.pdfEditor.busy'));
      return false;
    }
    if (!confirmDiscardChanges('close')) return false;
    closeSuccess(false);
    overlay.classList.remove('visible', 'drag-over');
    dropZone?.classList.remove('visible');
    plasmaInstance = disposeStandardToolPlasma(plasmaInstance);
    if (fileInput) fileInput.value = '';
    if (appendInput) appendInput.value = '';
    void resetDocument();
    syncInteractiveLayers();
    const returnFocus = overlayReturnFocus;
    overlayReturnFocus = null;
    restoreFocus(returnFocus);
    return true;
  }

  function dispose() {
    plasmaInstance = disposeStandardToolPlasma(plasmaInstance);
    successOverlay?.classList.remove('visible');
    overlay?.classList.remove('visible', 'drag-over');
    dropZone?.classList.remove('visible');
    successReturnFocus = null;
    overlayReturnFocus = null;
    lastSuccess = null;
    lastOutputFolder = '';
    syncInteractiveLayers();
  }

  return {
    openOverlay,
    closeOverlay,
    closeSuccess,
    renderSuccess,
    showSuccess,
    showDropZone,
    hideDropZone,
    updateFileCard,
    syncStageVisibility,
    updateZoomLabel,
    getLastOutputFolder: () => lastOutputFolder,
    getLastSuccess: () => lastSuccess,
    dispose
  };
}
