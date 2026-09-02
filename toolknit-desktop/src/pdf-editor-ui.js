import { PDFDocument } from 'pdf-lib';
import * as tauriCore from '@tauri-apps/api/core';
import * as tauriEvent from '@tauri-apps/api/event';

const tauriCorePromise = Promise.resolve(tauriCore);
const tauriEventPromise = Promise.resolve(tauriEvent);
import {
  PDF_EDITOR_LIMITS,
  assertPdfEditorFile,
  assertPdfEditorMergeSelection,
  assertPdfEditorPageCount,
  normalizePageRotation,
  resolvePdfPageRotation
} from './pdf-editor-core.js';
import { resizePdfBoxFromHandle, rotatePdfDeltaToLocal } from './pdf-editor-geometry.js';
import {
  compactPdfEditorComponent,
  pdfEditorPageIdsInDocumentOrder,
  pdfEditorSnapshotsEqual
} from './pdf-editor-state.js';
import { createPdfEditorHistory } from './features/pdf-editor/history.js';
import { createPdfEditorFocusManager } from './features/pdf-editor/focus.js';
import {
  isPdfEditorRenderCancellation as isRenderCancellation,
  releasePdfEditorCanvas as releaseCanvas
} from './features/pdf-editor/render-utils.js';
import {
  createPdfEditorExporter,
  PdfEditorCancelledError
} from './features/pdf-editor/exporter.js';
import { createPdfEditorDocumentStore } from './features/pdf-editor/documents.js';
import { createPdfEditorZoomController } from './features/pdf-editor/zoom.js';
import { createPdfEditorComponentRenderer } from './features/pdf-editor/component-renderer.js';
import { createPdfEditorComponentModel } from './features/pdf-editor/component-model.js';
import { createPdfEditorPreview } from './features/pdf-editor/preview.js';
import {
  buildTextLine,
  editedTextVisualBox,
  groupTextItemsIntoLines,
  insertedTextVisualBox,
  rectToViewport,
  sourceTextBox
} from './features/pdf-editor/text-layout.js';
import { IMAGE_BATCH_LIMITS } from './image-batch-core.js';

const ZOOM_MIN = 0.08;
const ZOOM_MAX = 8;

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value.length === 'number') return Uint8Array.from(value);
  throw new Error('Invalid binary response');
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function hexToRgb01(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
  if (!match) return [0, 0, 0];
  return [
    parseInt(match[1], 16) / 255,
    parseInt(match[2], 16) / 255,
    parseInt(match[3], 16) / 255
  ];
}

function rgb01ToHex(color) {
  const values = Array.isArray(color) ? color : [];
  const toHex = value => Math.round(clamp01(value) * 255).toString(16).padStart(2, '0');
  return `#${toHex(values[0] ?? 0)}${toHex(values[1] ?? 0)}${toHex(values[2] ?? 0)}`;
}

function rgb01ToCss(color, fallback = '#111111') {
  if (!Array.isArray(color) || color.length < 3) return fallback;
  return rgb01ToHex(color);
}

function isPasswordError(error) {
  return error?.name === 'PasswordException'
    || /password|encrypted/i.test(String(error?.message || error || ''));
}

export function initPdfEditorTool({
  isTauri,
  t,
  onLangChange,
  pdfWorkerUrl,
  getOutputDir,
  displayFilesystemPath,
  initStandardToolPlasma,
  disposeStandardToolPlasma
}) {
  const overlay = document.getElementById('pdfEditorOverlay');
  const plasmaBg = document.getElementById('pdfEditorPlasmaBg');
  const back = document.getElementById('pdfEditorBack');
  const cta = document.getElementById('pdfEditorCta');
  const fileInput = document.getElementById('pdfEditorFileInput');
  const appendInput = document.getElementById('pdfEditorAppendInput');
  const imageInput = document.getElementById('pdfEditorImageInput');
  const dropZone = document.getElementById('pdfEditorDropZone');
  const fileNameEl = document.getElementById('pdfEditorFileName');
  const fileStatsEl = document.getElementById('pdfEditorFileStats');
  const appendBtn = document.getElementById('pdfEditorAppend');
  const rotateCcwBtn = document.getElementById('pdfEditorRotateCcw');
  const rotateCwBtn = document.getElementById('pdfEditorRotateCw');
  const moveUpBtn = document.getElementById('pdfEditorMoveUp');
  const moveDownBtn = document.getElementById('pdfEditorMoveDown');
  const duplicateBtn = document.getElementById('pdfEditorDuplicate');
  const blankPageBtn = document.getElementById('pdfEditorBlankPage');
  const deleteBtn = document.getElementById('pdfEditorDelete');
  const extractBtn = document.getElementById('pdfEditorExtract');
  const selectComponentBtn = document.getElementById('pdfEditorSelectComponent');
  const resetBtn = document.getElementById('pdfEditorReset');
  const undoBtn = document.getElementById('pdfEditorUndo');
  const redoBtn = document.getElementById('pdfEditorRedo');
  const pageStrip = document.getElementById('pdfEditorPageStrip');
  const selectedCountEl = document.getElementById('pdfEditorSelectedCount');
  const selectAllBtn = document.getElementById('pdfEditorSelectAll');
  const invertSelectionBtn = document.getElementById('pdfEditorInvertSelection');
  const pageIndicator = document.getElementById('pdfEditorPageIndicator');
  const zoomOutBtn = document.getElementById('pdfEditorZoomOut');
  const zoomValueBtn = document.getElementById('pdfEditorZoomValue');
  const zoomInBtn = document.getElementById('pdfEditorZoomIn');
  const fitWidthBtn = document.getElementById('pdfEditorFitWidth');
  const canvasScroll = document.getElementById('pdfEditorCanvasScroll');
  const canvasStage = document.getElementById('pdfEditorCanvasStage');
  const emptyState = document.getElementById('pdfEditorEmpty');
  const footerHint = document.getElementById('pdfEditorFooterHint');
  const replaceBtn = document.getElementById('pdfEditorReplace');
  const exportBtn = document.getElementById('pdfEditorExport');
  const processMask = document.getElementById('pdfEditorProcessMask');
  const processBarFill = document.getElementById('pdfEditorProcessBarFill');
  const processValue = document.getElementById('pdfEditorProcessValue');
  const processText = document.getElementById('pdfEditorProcessText');
  const processCancel = document.getElementById('pdfEditorCancel');
  const successOverlay = document.getElementById('pdfEditorSuccessOverlay');
  const successMeta = document.getElementById('pdfEditorSuccessMeta');
  const successPath = document.getElementById('pdfEditorSuccessPath');
  const successOpenFolder = document.getElementById('pdfEditorSuccessOpenFolder');
  const successOk = document.getElementById('pdfEditorSuccessOk');
  const editTextBtn = document.getElementById('pdfEditorEditText');
  const editModal = document.getElementById('pdfEditorEditModal');
  const editModalOriginal = document.getElementById('pdfEditorEditOriginal');
  const editModalInput = document.getElementById('pdfEditorEditInput');
  const editSecurityNote = document.getElementById('pdfEditorEditSecurityNote');
  const editModalSave = document.getElementById('pdfEditorEditSave');
  const editModalCancel = document.getElementById('pdfEditorEditCancel');
  const editModalClose = document.getElementById('pdfEditorEditClose');
  const editModalTitle = document.getElementById('pdfEditorEditTitle');
  const editModalOriginalLabel = document.getElementById('pdfEditorEditOriginalLabel');
  const editModalNewLabel = document.getElementById('pdfEditorEditNewLabel');
  const editTextSidebarBtn = document.getElementById('pdfEditorEditTextSidebar');
  const insertTextBtn = document.getElementById('pdfEditorInsertText');
  const insertImageBtn = document.getElementById('pdfEditorInsertImage');
  const insertRectBtn = document.getElementById('pdfEditorInsertRect');
  const insertEllipseBtn = document.getElementById('pdfEditorInsertEllipse');
  const insertLineBtn = document.getElementById('pdfEditorInsertLine');
  const componentMenu = document.getElementById('pdfEditorComponentMenu');
  const componentScaleDownBtn = document.getElementById('pdfEditorComponentScaleDown');
  const componentScaleUpBtn = document.getElementById('pdfEditorComponentScaleUp');
  const componentEditBtn = document.getElementById('pdfEditorComponentEdit');
  const componentRotateBtn = document.getElementById('pdfEditorComponentRotate');
  const componentDeleteBtn = document.getElementById('pdfEditorComponentDelete');
  const shapePanel = document.getElementById('pdfEditorShapePanel');
  const shapeFillField = document.getElementById('pdfEditorShapeFillField');
  const shapeFillInput = document.getElementById('pdfEditorShapeFill');
  const shapeStrokeInput = document.getElementById('pdfEditorShapeStroke');
  const shapeStrokeWidth = document.getElementById('pdfEditorShapeStrokeWidth');

  if (!overlay || !pageStrip || !canvasStage) return { dispose() {} };

  const listenerController = new AbortController();
  const listenerOptions = { signal: listenerController.signal };
  let plasmaInstance = null;
  let sources = [];
  // Keep immutable source objects available while undo/redo switches the
  // active page list. History stores only ids, so large PDF byte arrays are
  // not cloned into every snapshot.
  let sourceStore = new Map();
  let pages = [];
  let selectedIds = new Set();
  let currentId = null;
  let selectionAnchorId = null;
  let mainCanvas = null;
  let mainRenderTask = null;
  let mainEpoch = 0;
  let lastRenderScale = 1;
  let activeOperation = null;
  let operationSequence = 0;
  let idCounter = 0;
  let lastOutputFolder = '';
  let lastSuccess = null;
  let nativeDragUnlisten = null;
  let disposed = false;
  let overlayReturnFocus = null;
  let successReturnFocus = null;
  let unsubscribeLangChange = () => {};
  let canvasWrap = null;
  let textLayerEl = null;
  let editMode = false;
  let componentMode = false;
  let insertMode = null;
  let pendingInsert = null;
  let textLinesCache = new Map();
  let textEdits = new Map();
  let insertedTexts = [];
  let insertedImages = [];
  // Image bytes are immutable while an editor session is open. Keep one
  // backing copy and let history snapshots retain only layout metadata.
  let insertedImageStore = new Map();
  let insertedShapes = [];
  let selectedComponent = null;
  let componentDragState = null;
  let componentPointerCleanup = null;
  let componentRotateTimer = null;
  let componentRotateState = null;
  let componentRenderFrame = 0;
  let preview = null;
  let fitResizeObserver = null;
  let fitResizeFrame = 0;
  let editingLineKey = null;
  let modalMode = null;
  let baselineSnapshot = null;
  let savedSnapshot = null;
  const showToast = (message, duration = 7000) => {
    if (!disposed) window.showToast?.(message, { duration, dismissible: true });
  };

  const {
    activeFocusRoots,
    canReceiveFocus,
    focusedElement,
    restoreFocus,
    trapFocus
  } = createPdfEditorFocusManager({
    overlay,
    processMask,
    successOverlay,
    editModal,
    isDisposed: () => disposed
  });

  const getInvoke = async () => {
    const { invoke } = await tauriCorePromise;
    return invoke;
  };

  function cloneState(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function normalizeEditSnapshot(edit) {
    if (!edit) return null;
    return {
      newText: String(edit.newText ?? ''),
      segment: edit.segment ? cloneState(edit.segment) : null,
      baseSegment: edit.baseSegment ? cloneState(edit.baseSegment) : null
    };
  }

  function normalizeInsertedImageSnapshot(object) {
    if (!object) return null;
    return {
      id: object.id,
      pageId: object.pageId,
      x: Number(object.x) || 0,
      y: Number(object.y) || 0,
      width: Number(object.width) || 0,
      height: Number(object.height) || 0,
      rotation: Number(object.rotation) || 0,
      mimeType: object.mimeType || '',
      previewUrl: ''
    };
  }

  function clearPendingInsert() {
    if (pendingInsert?.previewUrl) URL.revokeObjectURL(pendingInsert.previewUrl);
    pendingInsert = null;
  }

  function normalizeInsertedShapeSnapshot(object) {
    if (!object) return null;
    return {
      id: object.id,
      pageId: object.pageId,
      shapeType: ['rect', 'ellipse', 'line'].includes(object.shapeType) ? object.shapeType : 'rect',
      x: Number(object.x) || 0,
      y: Number(object.y) || 0,
      width: Number(object.width) || 0,
      height: Number(object.height) || 0,
      rotation: Number(object.rotation) || 0,
      fill: Array.isArray(object.fill) ? object.fill.map(clamp01) : null,
      stroke: Array.isArray(object.stroke) ? object.stroke.map(clamp01) : [0, 0, 0],
      strokeWidth: Math.max(0, Number(object.strokeWidth) || 0)
    };
  }

  function restoreSelectedComponent(component) {
    const locator = compactPdfEditorComponent(component);
    if (!locator || !pages.some(page => page.id === locator.pageId)) return null;
    if (locator.type === 'text') {
      const editSegment = textEdits.get(locator.key)?.segment;
      const line = textLinesCache.get(locator.pageId)?.lines?.[locator.lineIndex];
      const cachedSegment = Array.isArray(line?.segments) && line.segments.length
        ? line.segments[locator.segmentIndex] || null
        : locator.segmentIndex === 0
          ? line
          : null;
      const segment = editSegment || cachedSegment;
      return segment ? { ...locator, segment: cloneState(segment) } : null;
    }

    const collection = locator.type === 'inserted-text'
      ? insertedTexts
      : locator.type === 'inserted-image'
        ? insertedImages
        : insertedShapes;
    return collection.some(item => item.id === locator.key) ? locator : null;
  }

  function captureEditorSnapshot() {
    const zoomState = zoom.getState();
    return cloneState({
      sourceIds: sources.map(source => source.id),
      pages: pages.map(({ sourceRotation: _sourceRotation, ...page }) => page),
      selectedIds: Array.from(selectedIds),
      currentId,
      selectionAnchorId,
      editMode,
      componentMode,
      selectedComponent: compactPdfEditorComponent(selectedComponent),
      viewMode: zoomState.viewMode,
      zoomPercent: zoomState.zoomPercent,
      idCounter,
      textEdits: Array.from(textEdits.entries()).map(([key, value]) => [key, normalizeEditSnapshot(value)]),
      insertedTexts,
      insertedImages: insertedImages.map(normalizeInsertedImageSnapshot),
      insertedShapes: insertedShapes.map(normalizeInsertedShapeSnapshot)
    });
  }

  function applyEditorSnapshot(snapshot) {
    if (!snapshot) return;
    editorHistory.withLock(() => {
      if (Array.isArray(snapshot.sourceIds)) {
        sources = snapshot.sourceIds
          .map(id => sourceStore.get(id))
          .filter(Boolean);
      }
      pages = cloneState(snapshot.pages || []);
      selectedIds = new Set(Array.isArray(snapshot.selectedIds) ? snapshot.selectedIds : []);
      currentId = snapshot.currentId || null;
      selectionAnchorId = snapshot.selectionAnchorId || null;
      editMode = Boolean(snapshot.editMode);
      componentMode = Boolean(snapshot.componentMode);
      selectedComponent = null;
      zoom.setState(snapshot);
      idCounter = Number.isFinite(Number(snapshot.idCounter)) ? Number(snapshot.idCounter) : idCounter;
      textEdits = new Map((Array.isArray(snapshot.textEdits) ? snapshot.textEdits : []).map(([key, value]) => [key, normalizeEditSnapshot(value)]));
      insertedTexts = cloneState(snapshot.insertedTexts || []);
      for (const image of insertedImages) {
        if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
      }
      insertedImages = (Array.isArray(snapshot.insertedImages) ? snapshot.insertedImages : []).map(item => {
        const stored = insertedImageStore.get(item?.id);
        const bytes = stored?.bytes || item?.bytes;
        return {
          ...cloneState(item),
          bytes,
          previewUrl: bytes?.length ? URL.createObjectURL(new Blob([bytes], { type: item.mimeType || 'image/png' })) : ''
        };
      });
      insertedShapes = (Array.isArray(snapshot.insertedShapes) ? snapshot.insertedShapes : []).map(item => normalizeInsertedShapeSnapshot(item));
      selectedComponent = restoreSelectedComponent(snapshot.selectedComponent);
      stopComponentPointerSession();
      componentDragState = null;
      componentRotateState = null;
      editingLineKey = null;
      modalMode = null;
      insertMode = null;
      clearPendingInsert();
      closeEditModal();
      if (editTextBtn) {
        editTextBtn.classList.toggle('is-active', editMode);
        editTextBtn.setAttribute('aria-pressed', String(editMode));
      }
      if (selectComponentBtn) {
        selectComponentBtn.classList.toggle('is-active', componentMode);
        selectComponentBtn.setAttribute('aria-pressed', String(componentMode));
      }
      syncEditModeClass();
      syncComponentModeClass();
      buildTiles();
      updateFileCard();
      updateZoomLabel();
      updateControls();
    });
  }

  const editorHistory = createPdfEditorHistory({
    capture: captureEditorSnapshot,
    apply: applyEditorSnapshot,
    equals: pdfEditorSnapshotsEqual,
    hasDocument,
    onChange: () => updateControls()
  });

  function resetEditorHistory() {
    return editorHistory.reset();
  }

  function commitEditorHistory() {
    return editorHistory.commit();
  }

  function hasUnsavedChanges() {
    return editorHistory.hasUnsavedChanges(savedSnapshot);
  }

  function confirmDiscardChanges(action) {
    if (!hasUnsavedChanges()) return true;
    const messageKey = action === 'reset' ? 'confirmReset' : 'confirmDiscard';
    return window.confirm(t(`home.pdfEditor.${messageKey}`));
  }

  function canUndo() {
    return editorHistory.canUndo();
  }

  function canRedo() {
    return editorHistory.canRedo();
  }

  function undoEditorChange() {
    editorHistory.undo();
  }

  function redoEditorChange() {
    editorHistory.redo();
  }

  function handleDocumentKeydown(event) {
    if (disposed) return;
    // Settings and its nested dialogs sit above the PDF editor. Keep editor
    // shortcuts from mutating the document while that higher-level surface is
    // active (for example, Delete or Ctrl+Z in a settings field).
    if (document.getElementById('settingsOverlay')?.classList.contains('visible')) return;
    const roots = activeFocusRoots();
    if (!roots.length) return;
    const active = focusedElement();
    const isTypingField = Boolean(active
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable));
    if (event.key === 'Tab') {
      trapFocus(event, roots);
      return;
    }
    if (!isTypingField && (event.ctrlKey || event.metaKey)) {
      const key = String(event.key || '').toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) redoEditorChange(); else undoEditorChange();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        event.stopPropagation();
        redoEditorChange();
        return;
      }
    }
    if (!isTypingField && (event.key === 'Delete' || event.key === 'Backspace')) {
      if (selectedComponent || selectedIds.size) {
        event.preventDefault();
        event.stopPropagation();
        deleteSelected();
        return;
      }
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (successOverlay?.classList.contains('visible')) {
      closeSuccess();
    } else if (processMask?.classList.contains('visible')) {
      if (!processCancel?.disabled) void cancelActiveOperation();
    } else if (editModal?.classList.contains('visible')) {
      handleEditModalCancel();
    } else if (selectedComponent) {
      clearSelectedComponent();
    } else if (componentMode) {
      setComponentMode(false);
    } else {
      closeOverlay();
    }
  }

  function scheduleComponentVisualRefresh() {
    if (disposed || componentRenderFrame) return;
    componentRenderFrame = requestAnimationFrame(() => {
      componentRenderFrame = 0;
      if (disposed) return;
      syncComponentModeClass();
      updateControls();
      refreshCurrentTextLayer();
    });
  }

  function flushComponentVisualRefresh() {
    if (componentRenderFrame) {
      cancelAnimationFrame(componentRenderFrame);
      componentRenderFrame = 0;
    }
    if (disposed) return;
    syncComponentModeClass();
    updateControls();
    refreshCurrentTextLayer();
  }

  function scheduleFitPreview() {
    if (disposed || !overlay.classList.contains('visible') || zoom.getState().viewMode !== 'fit' || !hasDocument()) return;
    if (fitResizeFrame) return;
    fitResizeFrame = requestAnimationFrame(() => {
      fitResizeFrame = 0;
      if (!disposed && overlay.classList.contains('visible') && zoom.getState().viewMode === 'fit' && hasDocument()) {
        renderMainPreview();
      }
    });
  }

  function stopFitPreviewObserver() {
    fitResizeObserver?.disconnect();
    fitResizeObserver = null;
    if (fitResizeFrame) {
      cancelAnimationFrame(fitResizeFrame);
      fitResizeFrame = 0;
    }
  }

  function syncInteractiveLayers() {
    const overlayVisible = overlay.classList.contains('visible');
    const processVisible = processMask?.classList.contains('visible') || false;
    const successVisible = successOverlay?.classList.contains('visible') || false;
    const editVisible = editModal?.classList.contains('visible') || false;
    const processInteractive = overlayVisible && processVisible && !successVisible;
    const successInteractive = overlayVisible && successVisible;
    const overlayInteractive = overlayVisible && !processVisible && !successVisible;
    overlay.inert = overlayVisible ? !overlayInteractive : false;
    overlay.setAttribute('aria-hidden', String(!overlayVisible));
    if (processMask) {
      processMask.inert = !processInteractive;
      processMask.setAttribute('aria-hidden', String(!processVisible));
    }
    if (successOverlay) {
      successOverlay.inert = !successInteractive;
      successOverlay.setAttribute('aria-hidden', String(!successVisible));
    }
    if (editModal) {
      editModal.inert = !editVisible;
      editModal.setAttribute('aria-hidden', String(!editVisible));
    }
  }

  function hasDocument() {
    return sources.length > 0 && pages.length > 0;
  }

  function currentPage() {
    return pages.find(page => page.id === currentId) || pages[0] || null;
  }

  function cacheSourceRotation(model, pdfPage) {
    if (!model || !pdfPage) return;
    model.sourceRotation = normalizePageRotation(pdfPage.rotate);
  }

  function effectivePageRotation(model) {
    if (!model || !Number.isFinite(Number(model.sourceRotation))) return null;
    return resolvePdfPageRotation(model.sourceRotation, model.rotation);
  }

  function pageSupportsContentEditing(model) {
    return effectivePageRotation(model) === 0;
  }

  function pageStateFor(id) {
    return thumbnails.getPageState(id);
  }

  function targetIds() {
    return pdfEditorPageIdsInDocumentOrder(pages, selectedIds, currentId);
  }

  function mainSourceName() {
    return sources[0]?.name || 'document.pdf';
  }

  function formatSize(size) {
    const bytes = Number(size) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function setProgress(percent, message) {
    const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    if (processBarFill) processBarFill.style.width = safePercent + '%';
    if (processValue) processValue.textContent = safePercent + '%';
    if (processText && message) processText.textContent = message;
  }

  function setLocalizedProgress(percent, key, params = {}) {
    if (activeOperation) {
      activeOperation.progressKey = key;
      activeOperation.progressParams = params;
    }
    setProgress(percent, t(`home.pdfEditor.${key}`, params));
  }

  function showProcess(key, percent = 0, params = {}) {
    setLocalizedProgress(percent, key, params);
    processMask?.classList.add('visible');
    if (processCancel) {
      processCancel.disabled = false;
      processCancel.style.display = '';
    }
    syncInteractiveLayers();
    restoreFocus(processCancel);
  }

  function hideProcess() {
    processMask?.classList.remove('visible');
    if (processCancel) processCancel.disabled = false;
    setProgress(0, t('home.pdfEditor.loadingDocument'));
    syncInteractiveLayers();
  }

  function beginOperation(type) {
    if (activeOperation) throw new Error('pdf-editor:busy');
    const operation = {
      id: ++operationSequence,
      type,
      cancelled: false,
      returnFocus: focusedElement(),
      progressKey: '',
      progressParams: {}
    };
    activeOperation = operation;
    return operation;
  }

  function assertOperation(operation) {
    if (!operation || operation.cancelled || activeOperation !== operation) {
      throw new PdfEditorCancelledError();
    }
  }

  function endOperation(operation) {
    if (activeOperation !== operation) return;
    activeOperation = null;
    hideProcess();
    updateControls();
    if (!successOverlay?.classList.contains('visible')) {
      restoreFocus(canReceiveFocus(operation.returnFocus) ? operation.returnFocus : exportBtn || back);
    }
  }

  async function cancelActiveOperation() {
    const operation = activeOperation;
    if (!operation || operation.cancelled) return;
    operation.cancelled = true;
    if (processCancel) processCancel.disabled = true;
    setLocalizedProgress(
      0,
      'cancelling'
    );
    if (operation.type === 'load') {
      try { await operation.loadingTask?.destroy(); } catch (_) {}
    }
  }

  function messageForError(error, phase) {
    if (error instanceof PdfEditorCancelledError || isRenderCancellation(error)) {
      return t(phase === 'load' ? 'home.pdfEditor.loadCancelled' : 'home.pdfEditor.cancelled');
    }
    if (isPasswordError(error)) return t('home.pdfEditor.passwordProtected');
    const detail = String(error?.message || error || '');
    if (/another (task|operation) is already in progress/i.test(detail)) {
      return t('home.pdfEditor.busy');
    }
    if (/exceeds/.test(detail)) {
      return /page/i.test(detail) ? t('home.pdfEditor.tooManyPages') : t('home.pdfEditor.fileTooLarge');
    }
    if (/required|\.pdf/i.test(detail)) return t('home.pdfEditor.pdfOnly');
    const map = {
      load: 'loadFailed',
      export: 'exportFailed',
      extract: 'extractFailed',
      append: 'appendFailed'
    };
    return t(`home.pdfEditor.${map[phase] || 'exportFailed'}`, { error: detail });
  }

  async function fileSizeFor(file) {
    if (isTauri && file.path) {
      const invoke = await getInvoke();
      return Number(await invoke('get_file_size', { path: file.path }));
    }
    return Number(file.size || 0);
  }

  async function readBytes(file) {
    if (isTauri && file.path) {
      const invoke = await getInvoke();
      return asUint8Array(await invoke('read_file_bytes', { path: file.path }));
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  function openOverlay() {
    if (disposed) return;
    if (!overlay.classList.contains('visible')) overlayReturnFocus = focusedElement();
    overlay.classList.add('visible');
    if (plasmaBg && !plasmaInstance) plasmaInstance = initStandardToolPlasma(plasmaBg);
    syncInteractiveLayers();
    syncStageVisibility();
    restoreFocus(hasDocument() ? exportBtn : cta || back);
  }

  function closeOverlay() {
    if (disposed) return;
    if (activeOperation) {
      showToast(t('home.pdfEditor.busy'));
      return;
    }
    if (!confirmDiscardChanges('close')) return;
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
  }

  function showDropZone() {
    if (activeOperation) return;
    overlay.classList.add('drag-over');
    dropZone?.classList.add('visible');
  }

  function hideDropZone() {
    overlay.classList.remove('drag-over');
    dropZone?.classList.remove('visible');
  }

  function closeSuccess(restore = true) {
    if (!successOverlay?.classList.contains('visible')) return;
    successOverlay?.classList.remove('visible');
    syncInteractiveLayers();
    const returnFocus = successReturnFocus;
    successReturnFocus = null;
    if (restore) restoreFocus(returnFocus);
  }

  function renderSuccess() {
    if (!lastSuccess) return;
    const { outputDir, mode, count } = lastSuccess;
    successMeta.textContent = mode === 'extract'
      ? t('home.pdfEditor.successExtractMeta', { count })
      : t('home.pdfEditor.successExportMeta');
    successPath.textContent = displayFilesystemPath(outputDir || '~/Downloads');
    if (successOpenFolder) successOpenFolder.style.display = isTauri ? '' : 'none';
  }

  function showSuccess(result, returnFocus) {
    lastOutputFolder = result.outputDir || '';
    lastSuccess = result;
    successReturnFocus = returnFocus || focusedElement();
    renderSuccess();
    successOverlay?.classList.add('visible');
    syncInteractiveLayers();
    restoreFocus(successOk || successOpenFolder);
  }

  async function resetDocument() {
    stopTileObserver(true);
    cancelMainRender();
    zoom.reset();
    if (componentRenderFrame) {
      cancelAnimationFrame(componentRenderFrame);
      componentRenderFrame = 0;
    }
    stopComponentPointerSession();
    stopComponentRotate();
    closeEditModal();
    editMode = false;
    componentMode = false;
    if (editTextBtn) {
      editTextBtn.classList.remove('is-active');
      editTextBtn.setAttribute('aria-pressed', 'false');
    }
    if (selectComponentBtn) {
      selectComponentBtn.classList.remove('is-active');
      selectComponentBtn.setAttribute('aria-pressed', 'false');
    }
    syncEditModeClass();
    syncComponentModeClass();
    insertMode = null;
    clearPendingInsert();
    editingLineKey = null;
    textEdits = new Map();
    insertedTexts = [];
    for (const image of insertedImages) {
      if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    }
    insertedImages = [];
    insertedImageStore.clear();
    insertedShapes = [];
    textLinesCache = new Map();
    if (editTextBtn) {
      editTextBtn.classList.remove('is-active');
      editTextBtn.setAttribute('aria-pressed', 'false');
    }
    syncEditModeClass();
    await documents.destroyAll();
    if (mainCanvas) {
      releaseCanvas(mainCanvas);
      mainCanvas = null;
    }
    if (canvasWrap) {
      canvasWrap.style.width = '';
      canvasWrap.style.height = '';
    }
    sources = [];
    sourceStore.clear();
    pages = [];
    selectedIds = new Set();
    currentId = null;
    selectionAnchorId = null;
    thumbnails.clear();
    selectedComponent = null;
    componentDragState = null;
    componentRotateState = null;
    editorHistory.clear();
    baselineSnapshot = null;
    savedSnapshot = null;
    updateFileCard();
    updateControls();
    syncStageVisibility();
  }

  function updateFileCard() {
    if (!fileNameEl || !fileStatsEl) return;
    if (!hasDocument()) {
      fileNameEl.textContent = t('home.pdfEditor.fileNameEmpty');
      fileStatsEl.textContent = '';
      return;
    }
    const totalSize = sources.reduce((sum, source) => sum + (Number(source.size) || 0), 0);
    fileNameEl.textContent = mainSourceName();
    fileStatsEl.textContent = t('home.pdfEditor.pageCount', { count: pages.length })
      + ' · ' + formatSize(totalSize);
  }

  function syncStageVisibility() {
    const has = hasDocument();
    if (emptyState) {
      emptyState.style.display = has ? 'none' : '';
    }
    if (canvasWrap) canvasWrap.style.display = has ? '' : 'none';
  }

  function updateZoomLabel() {
    if (!zoomValueBtn) return;
    const zoomState = zoom.getState();
    zoomValueBtn.textContent = zoomState.viewMode === 'fit'
      ? t('home.pdfEditor.fitShort')
      : `${Math.round(zoomState.zoomPercent * 100)}%`;
  }

  function updateControls() {
    const busy = Boolean(activeOperation);
    const has = hasDocument();
    const selectedCount = selectedIds.size;
    const page = currentPage();
    const currentIndex = page ? pages.indexOf(page) : -1;
    const hasSelectedComponent = Boolean(selectedComponent);

    if (appendBtn) appendBtn.disabled = busy || !has;
    if (rotateCcwBtn) rotateCcwBtn.disabled = busy || !has;
    if (rotateCwBtn) rotateCwBtn.disabled = busy || !has;
    if (moveUpBtn) moveUpBtn.disabled = busy || !has || currentIndex <= 0;
    if (moveDownBtn) moveDownBtn.disabled = busy || !has || currentIndex < 0 || currentIndex >= pages.length - 1;
    if (duplicateBtn) duplicateBtn.disabled = busy || !has || pages.length + Math.max(1, selectedCount) > PDF_EDITOR_LIMITS.maxPages;
    if (blankPageBtn) blankPageBtn.disabled = busy || !has || pages.length >= PDF_EDITOR_LIMITS.maxPages;
    if (selectAllBtn) selectAllBtn.disabled = busy || !has || selectedCount === pages.length;
    if (invertSelectionBtn) invertSelectionBtn.disabled = busy || !has;
    if (deleteBtn) deleteBtn.disabled = busy || !has || (!hasSelectedComponent && pages.length <= 1);
    if (extractBtn) extractBtn.disabled = busy || !has;
    if (replaceBtn) replaceBtn.disabled = busy;
    if (exportBtn) exportBtn.disabled = busy || !has;
    const sourceRotationKnown = !page || Number.isFinite(Number(page.sourceRotation));
    const contentEditingAllowed = has && sourceRotationKnown && pageSupportsContentEditing(page);
    if (editTextBtn) editTextBtn.disabled = busy || !contentEditingAllowed;
    if (editTextSidebarBtn) editTextSidebarBtn.disabled = busy || !contentEditingAllowed;
    if (insertTextBtn) insertTextBtn.disabled = busy || !contentEditingAllowed;
    if (insertImageBtn) insertImageBtn.disabled = busy || !contentEditingAllowed;
    for (const button of [insertRectBtn, insertEllipseBtn, insertLineBtn]) {
      if (button) button.disabled = busy || !contentEditingAllowed;
    }
    if (selectComponentBtn) {
      selectComponentBtn.disabled = busy || !has;
      selectComponentBtn.classList.toggle('is-active', componentMode);
      selectComponentBtn.setAttribute('aria-pressed', String(componentMode));
    }
    if (resetBtn) resetBtn.disabled = busy || !has || !baselineSnapshot;
    if (undoBtn) undoBtn.disabled = busy || !has || !canUndo();
    if (redoBtn) redoBtn.disabled = busy || !has || !canRedo();

    if (selectedCountEl) {
      selectedCountEl.textContent = selectedCount > 0
        ? t('home.pdfEditor.selectedCount', { count: selectedCount })
        : '';
    }
    if (pageIndicator) {
      pageIndicator.textContent = has
        ? t('home.pdfEditor.pageIndicator', { current: currentIndex + 1, total: pages.length })
        : '';
    }
    if (footerHint) {
      footerHint.textContent = has
        ? t('home.pdfEditor.footerHint', { name: mainSourceName() })
        : t('home.pdfEditor.footerEmptyHint');
    }
    for (const pageState of thumbnails.getPageStates().values()) {
      pageState.tile.classList.toggle('is-selected', selectedIds.has(pageState.id));
      pageState.selectButton.setAttribute('aria-pressed', String(selectedIds.has(pageState.id)));
    }
    updateZoomLabel();
    const inserting = Boolean(insertMode);
    for (const button of [insertTextBtn, insertImageBtn, insertRectBtn, insertEllipseBtn, insertLineBtn]) {
      if (button) button.classList.toggle('is-active', inserting && button.dataset.insertMode === insertMode);
    }
    if (editTextSidebarBtn) editTextSidebarBtn.classList.toggle('is-active', editMode);
  }

  function selectOnly(pageState) {
    selectedIds = new Set([pageState.id]);
    selectionAnchorId = pageState.id;
    updateControls();
  }

  function toggleSelect(pageState) {
    if (selectedIds.has(pageState.id)) {
      selectedIds.delete(pageState.id);
      if (selectionAnchorId === pageState.id) selectionAnchorId = null;
    } else {
      selectedIds.add(pageState.id);
      selectionAnchorId = pageState.id;
    }
    updateControls();
  }

  function selectRange(pageState) {
    if (!selectionAnchorId || !pageStateFor(selectionAnchorId)) {
      selectOnly(pageState);
      return;
    }
    const anchorIndex = pages.findIndex(page => page.id === selectionAnchorId);
    const targetIndex = pages.findIndex(page => page.id === pageState.id);
    if (anchorIndex < 0 || targetIndex < 0) return;
    const [start, end] = anchorIndex <= targetIndex
      ? [anchorIndex, targetIndex]
      : [targetIndex, anchorIndex];
    selectedIds = new Set(pages.slice(start, end + 1).map(page => page.id));
    updateControls();
  }

  function selectAllPages() {
    if (activeOperation || !hasDocument()) return;
    selectedIds = new Set(pages.map(page => page.id));
    selectionAnchorId = pages[0]?.id || null;
    updateControls();
  }

  function invertPageSelection() {
    if (activeOperation || !hasDocument()) return;
    selectedIds = new Set(pages
      .filter(page => !selectedIds.has(page.id))
      .map(page => page.id));
    selectionAnchorId = currentId;
    updateControls();
  }

  function setCurrent(pageState) {
    currentId = pageState.id;
    if (selectedComponent && selectedComponent.pageId !== pageState.id) {
      clearSelectedComponent();
    }
    updateControls();
    renderMainPreview();
  }

  const documents = createPdfEditorDocumentStore({
    pdfWorkerUrl,
    getSources: () => sources,
    isDisposed: () => disposed
  });

  // ----- Thumbnail rendering -----
  function getSourceDoc(sourceId) {
    return documents.get(sourceId);
  }

  const thumbnails = createPdfEditorThumbnails({
    pageStrip,
    t,
    listenerOptions,
    getPages: () => pages,
    setPages: nextPages => { pages = nextPages; },
    getSelectedIds: () => selectedIds,
    getCurrentId: () => currentId,
    setCurrentId: nextId => { currentId = nextId; },
    getActiveOperation: () => activeOperation,
    isDisposed: () => disposed,
    hasDocument,
    cacheSourceRotation,
    effectivePageRotation,
    getSourceDoc,
    toggleSelect,
    selectRange,
    selectOnly,
    setCurrent,
    updateControls,
    renderMainPreview,
    commitEditorHistory
  });

  function buildTiles(shouldRender = true) {
    return thumbnails.build(shouldRender);
  }

  function stopTileObserver(releaseAll = false) {
    return thumbnails.stop(releaseAll);
  }

  function refreshTile(pageState) {
    return thumbnails.refresh(pageState);
  }
  // ----- Main preview -----
  function cancelMainRender() {
    return preview?.cancel();
  }

  function syncTextLayerAccessibility() {
    return componentRenderer.syncTextLayerAccessibility();
  }

  function applyRelativeViewportRect(element, rect, parentRect) {
    return componentRenderer.applyRelativeViewportRect(element, rect, parentRect);
  }

  function ensureTextMask(lineElement, key, sourceBox, lineBox, cssViewport, rotation = 0, rotationBox = sourceBox) {
    return componentRenderer.ensureTextMask(lineElement, key, sourceBox, lineBox, cssViewport, rotation, rotationBox);
  }

  function renderTextLayer(lines, cssViewport, scale, pageId) {
    return componentRenderer.render(lines, cssViewport, scale, pageId);
  }

  function handleCanvasBackgroundClick(event) {
    if (!componentMode || insertMode) return;
    if (event.target === mainCanvas || event.target === canvasWrap || event.target === textLayerEl) {
      clearSelectedComponent();
    }
  }

  function currentTextLayerCache() {
    const page = currentPage();
    return page ? textLinesCache.get(page.id) : null;
  }

  function handleCanvasPlacement(event) {
    if (!insertMode || !pendingInsert || !canvasWrap) return;
    const page = currentPage();
    const cache = currentTextLayerCache();
    if (!page || !cache || !pageSupportsContentEditing(page)) return;
    const bounds = canvasWrap.getBoundingClientRect();
    const cssX = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    const cssY = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    const [pdfX, pdfY] = cache.cssViewport.convertToPdfPoint(cssX, cssY);
    if (pendingInsert.type === 'text') {
      const fontSize = pendingInsert.fontSize;
      insertedTexts.push({
        id: `text-${++idCounter}`,
        pageId: page.id,
        x: pdfX,
        y: pdfY - fontSize * 0.24,
        text: pendingInsert.text,
        fontSize,
        bold: pendingInsert.bold,
        rotation: 0,
        color: pendingInsert.color
      });
    } else if (pendingInsert.type === 'image') {
      const imageId = `image-${++idCounter}`;
      insertedImageStore.set(imageId, {
        bytes: pendingInsert.bytes,
        mimeType: pendingInsert.mimeType
      });
      insertedImages.push({
        id: imageId,
        pageId: page.id,
        x: pdfX,
        y: pdfY - pendingInsert.height,
        width: pendingInsert.width,
        height: pendingInsert.height,
        rotation: 0,
        bytes: pendingInsert.bytes,
        mimeType: pendingInsert.mimeType,
        previewUrl: pendingInsert.previewUrl
      });
    } else if (pendingInsert.type === 'shape') {
      insertedShapes.push({
        id: `shape-${++idCounter}`,
        pageId: page.id,
        shapeType: pendingInsert.shapeType,
        x: pdfX - pendingInsert.width / 2,
        y: pdfY - pendingInsert.height / 2,
        width: pendingInsert.width,
        height: pendingInsert.height,
        rotation: 0,
        fill: pendingInsert.fill,
        stroke: pendingInsert.stroke,
        strokeWidth: pendingInsert.strokeWidth
      });
    }
    pendingInsert = null;
    insertMode = null;
    updateControls();
    renderMainPreview();
    commitEditorHistory();
    showToast(t('home.pdfEditor.insertPlaced'), 3500);
    event.preventDefault();
    event.stopPropagation();
  }

  function syncEditModeClass() {
    if (textLayerEl) {
      textLayerEl.classList.toggle('is-edit-mode', editMode);
      textLayerEl.classList.toggle('is-insert-mode', Boolean(insertMode));
    }
    syncTextLayerAccessibility();
  }

  function syncComponentModeClass() {
    if (textLayerEl) textLayerEl.classList.toggle('is-object-mode', componentMode);
    syncTextLayerAccessibility();
    syncComponentMenu();
  }

  function refreshCurrentTextLayer() {
    const page = currentPage();
    const cache = page ? textLinesCache.get(page.id) : null;
    if (page && cache) {
      renderTextLayer(cache.lines, cache.cssViewport, cache.scale, page.id);
    } else if (hasDocument()) {
      renderMainPreview();
    }
  }

  function componentElementKey(component) {
    return componentModel.componentElementKey(component);
  }

  function sameComponent(left, right) {
    return componentModel.sameComponent(left, right);
  }

  function componentElement(component) {
    if (!textLayerEl || !component) return null;
    const key = componentElementKey(component);
    const candidates = textLayerEl.querySelectorAll('[data-segment-key]');
    for (const candidate of candidates) {
      if (candidate.dataset.segmentKey === key) return candidate;
    }
    return null;
  }

  function selectedComponentElement() {
    return componentElement(selectedComponent);
  }

  function resolveComponentObject(component) {
    return componentModel.resolveComponentObject(component);
  }

  function getComponentRotation(component) {
    return componentModel.getComponentRotation(component);
  }

  function snapRotationToAxis(rotationDeg, threshold = 6) {
    return componentModel.snapRotationToAxis(rotationDeg, threshold);
  }

  function setComponentRotation(component, rotationDeg) {
    return componentModel.setComponentRotation(component, rotationDeg);
  }

  function positionComponentMenu() {
    if (!componentMenu || componentMenu.hidden || !selectedComponent || !canvasStage) return;
    const target = selectedComponentElement();
    if (!target) {
      componentMenu.hidden = true;
      return;
    }
    const stageRect = canvasStage.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const menuWidth = componentMenu.offsetWidth || 180;
    const menuHeight = componentMenu.offsetHeight || 38;
    const gap = 8;
    const maxLeft = Math.max(8, canvasStage.clientWidth - menuWidth - 8);
    const maxTop = Math.max(8, canvasStage.clientHeight - menuHeight - 8);
    let left = targetRect.right - stageRect.left + gap;
    let top = targetRect.top - stageRect.top - menuHeight - gap;
    if (left > maxLeft) left = targetRect.left - stageRect.left - menuWidth - gap;
    if (top < 8) top = targetRect.bottom - stageRect.top + gap;
    componentMenu.style.left = `${Math.round(Math.max(8, Math.min(maxLeft, left)))}px`;
    componentMenu.style.top = `${Math.round(Math.max(8, Math.min(maxTop, top)))}px`;
  }

  function syncComponentMenu() {
    if (!componentMenu) return;
    const visible = Boolean(componentMode && selectedComponent && hasDocument());
    componentMenu.hidden = !visible;
    if (componentEditBtn) {
      componentEditBtn.hidden = visible
        && !['text', 'inserted-text'].includes(selectedComponent?.type);
    }
    if (visible) requestAnimationFrame(positionComponentMenu);
    syncShapePanel();
  }

  function positionShapePanel() {
    if (!shapePanel || shapePanel.hidden || !canvasStage) return;
    const stageRect = canvasStage.getBoundingClientRect();
    const menuRect = componentMenu?.hidden ? null : componentMenu?.getBoundingClientRect();
    const panelWidth = shapePanel.offsetWidth || 200;
    const panelHeight = shapePanel.offsetHeight || 46;
    const maxLeft = Math.max(8, canvasStage.clientWidth - panelWidth - 8);
    const maxTop = Math.max(8, canvasStage.clientHeight - panelHeight - 8);
    let left = menuRect ? menuRect.left - stageRect.left : 8;
    let top = menuRect ? menuRect.bottom - stageRect.top + 8 : 8;
    left = Math.max(8, Math.min(maxLeft, left));
    top = Math.max(8, Math.min(maxTop, top));
    shapePanel.style.left = `${Math.round(left)}px`;
    shapePanel.style.top = `${Math.round(top)}px`;
  }

  function syncShapePanel() {
    if (!shapePanel) return;
    const visible = Boolean(componentMode && selectedComponent?.type === 'inserted-shape' && hasDocument());
    shapePanel.hidden = !visible;
    if (!visible) return;
    const object = insertedShapes.find(item => item.id === selectedComponent.key);
    if (!object) return;
    if (shapeFillField) shapeFillField.hidden = object.shapeType === 'line';
    if (shapeFillInput) shapeFillInput.value = rgb01ToHex(Array.isArray(object.fill) ? object.fill : [1, 1, 1]);
    if (shapeStrokeInput) shapeStrokeInput.value = rgb01ToHex(object.stroke);
    if (shapeStrokeWidth) shapeStrokeWidth.value = String(Number(object.strokeWidth) || 0);
    requestAnimationFrame(positionShapePanel);
  }

  function updateSelectedShapeProperty(property, value) {
    if (!selectedComponent || selectedComponent.type !== 'inserted-shape') return;
    const object = insertedShapes.find(item => item.id === selectedComponent.key);
    if (!object) return;
    if (property === 'strokeWidth') {
      object.strokeWidth = Math.max(0, Math.min(80, Number(value) || 0));
    } else {
      object[property] = Array.isArray(value) ? value.map(clamp01) : value;
    }
    selectedComponent.object = cloneState(object);
    updateControls();
    refreshCurrentTextLayer();
  }

  function stopComponentRotate() {
    if (componentRotateTimer) {
      clearInterval(componentRotateTimer);
      componentRotateTimer = null;
    }
    componentRotateState = null;
  }

  function stopComponentPointerSession() {
    if (componentPointerCleanup) {
      componentPointerCleanup();
      componentPointerCleanup = null;
    }
  }

  function bindComponentPointerSession(onMove, onUp) {
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      if (componentPointerCleanup === cleanup) componentPointerCleanup = null;
    };
    stopComponentPointerSession();
    componentPointerCleanup = cleanup;
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    return cleanup;
  }

  function scaleSelectedComponent(factor) {
    if (!selectedComponent || !componentMode || activeOperation) return;
    updateComponentFromDelta(0, 0, factor, selectedComponent);
    commitEditorHistory();
  }

  function beginComponentRotate(event) {
    if (!componentMode || !selectedComponent || activeOperation) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stopComponentRotate();
    const target = selectedComponentElement();
    const targetRect = target?.getBoundingClientRect();
    let centerX = event.clientX;
    let centerY = event.clientY;
    if (targetRect) {
      centerX = targetRect.left + targetRect.width / 2;
      centerY = targetRect.top + targetRect.height / 2;
    }
    const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI;
    componentRotateState = {
      component: cloneState(selectedComponent),
      pointerId: event.pointerId,
      centerX,
      centerY,
      startAngle,
      baseRotation: getComponentRotation(selectedComponent)
    };
    const onMove = moveEvent => {
      if (!componentRotateState || moveEvent.pointerId !== componentRotateState.pointerId) return;
      moveEvent.preventDefault();
      const angle = Math.atan2(
        moveEvent.clientY - componentRotateState.centerY,
        moveEvent.clientX - componentRotateState.centerX
      ) * 180 / Math.PI;
      const rotation = snapRotationToAxis(componentRotateState.baseRotation + (angle - componentRotateState.startAngle));
      setComponentRotation(selectedComponent, rotation);
      updateControls();
      applyComponentDomVisual(selectedComponent);
    };
    const onUp = upEvent => {
      if (!componentRotateState || upEvent.pointerId !== componentRotateState.pointerId) return;
      componentPointerCleanup?.();
      stopComponentRotate();
      flushComponentVisualRefresh();
      commitEditorHistory();
    };
    bindComponentPointerSession(onMove, onUp);
  }

  function editSelectedComponent() {
    if (!selectedComponent || activeOperation) return;
    if (selectedComponent.type === 'inserted-text') {
      const object = insertedTexts.find(item => item.id === selectedComponent.key);
      if (!object) {
        clearSelectedComponent();
        return;
      }
      openEditModal(object.id, object, object, 'edit-inserted-text');
      return;
    }
    if (selectedComponent.type !== 'text') return;
    const edit = textEdits.get(selectedComponent.key);
    const segment = edit?.segment || selectedComponent.segment;
    if (!segment) {
      clearSelectedComponent();
      return;
    }
    openEditModal(selectedComponent.key, segment, segment);
  }

  function setComponentMode(enabled) {
    const next = Boolean(enabled);
    if (next === componentMode) return;
    componentMode = next;
    if (componentMode) {
      editMode = false;
      insertMode = null;
      clearPendingInsert();
      closeEditModal();
    } else {
      selectedComponent = null;
      componentDragState = null;
      stopComponentPointerSession();
      stopComponentRotate();
    }
    if (editTextBtn) {
      editTextBtn.classList.toggle('is-active', editMode);
      editTextBtn.setAttribute('aria-pressed', String(editMode));
    }
    if (selectComponentBtn) {
      selectComponentBtn.classList.toggle('is-active', componentMode);
      selectComponentBtn.setAttribute('aria-pressed', String(componentMode));
    }
    syncEditModeClass();
    syncComponentModeClass();
    updateControls();
    refreshCurrentTextLayer();
  }

  function selectComponent(component) {
    if (!component) return;
    const alreadySelected = sameComponent(selectedComponent, component);
    selectedComponent = cloneState(component);
    if (!componentMode) {
      setComponentMode(true);
      return;
    }
    if (alreadySelected) return;
    syncComponentModeClass();
    updateControls();
    refreshCurrentTextLayer();
  }

  function clearSelectedComponent() {
    if (!selectedComponent) return;
    selectedComponent = null;
    stopComponentRotate();
    syncComponentModeClass();
    updateControls();
    refreshCurrentTextLayer();
  }

  function editableComponentKey(component) {
    return componentModel.editableComponentKey(component);
  }

  function ensureTextEditEntry(component, segment) {
    return componentModel.ensureTextEditEntry(component, segment);
  }

  function sameTextSegmentLayout(a, b) {
    return componentModel.sameTextSegmentLayout(a, b);
  }

  function updateComponentFromDelta(
    deltaX,
    deltaY,
    deltaScale = 1,
    baseComponent = componentDragState?.component || selectedComponent,
    { deferRender = false } = {}
  ) {
    return componentModel.updateComponentFromDelta(
      deltaX,
      deltaY,
      deltaScale,
      baseComponent,
      { deferRender }
    );
  }

  function componentBox(component, object) {
    return componentModel.componentBox(component, object);
  }

  function collectSnapTargets(pageId, excludeType, excludeKey) {
    return componentModel.collectSnapTargets(pageId, excludeType, excludeKey);
  }

  function snapAxisDelta(mine, targets, threshold) {
    return componentModel.snapAxisDelta(mine, targets, threshold);
  }

  function snapComponentDrag(component, dx, dy, snapTargets = null) {
    return componentModel.snapComponentDrag(component, dx, dy, snapTargets);
  }

  function shapeStrokeCss(strokeWidth, scale) {
    return Math.max(1, (Number(strokeWidth) || 0) * (scale || 1));
  }

  function buildShapeSvg(object, cssWidth, cssHeight, scale) {
    const xmlns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(xmlns, 'svg');
    const width = Math.max(1, cssWidth);
    const height = Math.max(1, cssHeight);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('overflow', 'visible');
    svg.style.display = 'block';
    const fill = Array.isArray(object.fill) ? rgb01ToCss(object.fill) : 'none';
    const stroke = Array.isArray(object.stroke) ? rgb01ToCss(object.stroke) : '#111111';
    const strokeWidth = shapeStrokeCss(object.strokeWidth, scale);
    let node;
    if (object.shapeType === 'ellipse') {
      node = document.createElementNS(xmlns, 'ellipse');
      node.setAttribute('cx', (width / 2).toFixed(2));
      node.setAttribute('cy', (height / 2).toFixed(2));
      node.setAttribute('rx', Math.max(0.5, width / 2 - strokeWidth / 2).toFixed(2));
      node.setAttribute('ry', Math.max(0.5, height / 2 - strokeWidth / 2).toFixed(2));
      node.setAttribute('fill', fill);
      node.setAttribute('stroke', stroke);
      node.setAttribute('stroke-width', strokeWidth);
    } else if (object.shapeType === 'line') {
      node = document.createElementNS(xmlns, 'line');
      node.setAttribute('x1', '0');
      node.setAttribute('y1', '0');
      node.setAttribute('x2', width.toFixed(2));
      node.setAttribute('y2', height.toFixed(2));
      node.setAttribute('stroke', stroke);
      node.setAttribute('stroke-width', strokeWidth);
    } else {
      node = document.createElementNS(xmlns, 'rect');
      const inset = strokeWidth / 2;
      node.setAttribute('x', inset.toFixed(2));
      node.setAttribute('y', inset.toFixed(2));
      node.setAttribute('width', Math.max(0.5, width - strokeWidth).toFixed(2));
      node.setAttribute('height', Math.max(0.5, height - strokeWidth).toFixed(2));
      node.setAttribute('fill', fill);
      node.setAttribute('stroke', stroke);
      node.setAttribute('stroke-width', strokeWidth);
    }
    svg.appendChild(node);
    return svg;
  }

  function appendResizeHandles(container, component, pageId, object) {
    if (!container) return;
    const isLine = component.type === 'inserted-shape' && object?.shapeType === 'line';
    const handles = isLine ? ['nw', 'se'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const handle of handles) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pdf-editor-component-handle';
      button.dataset.handle = handle;
      button.setAttribute('aria-label', t('home.pdfEditor.resizeComponent'));
      button.addEventListener('pointerdown', event => {
        event.stopPropagation();
        beginComponentResize(event, { type: component.type, pageId, key: object.id, object }, handle);
      }, listenerOptions);
      container.appendChild(button);
    }
  }

  function applyComponentResize(component, baseObject, handle, localDx, localDy) {
    if (!component || !baseObject) return;

    if (component.type === 'text') {
      // The text control is the south-east handle. In PDF space a screen
      // drag downward produces a negative y delta, so subtract localDy.
      const factor = Math.max(0.5, 1 + ((localDx - localDy) / 80));
      updateComponentFromDelta(0, 0, factor, component);
      return;
    }

    const object = resolveComponentObject(component);
    if (!object) return;

    const isLine = component.type === 'inserted-shape' && baseObject.shapeType === 'line';
    const resized = resizePdfBoxFromHandle(
      baseObject,
      handle,
      localDx,
      localDy,
      { minWidth: isLine ? 2 : 10, minHeight: isLine ? 0.5 : 10 }
    );
    object.x = resized.x;
    object.y = resized.y;
    object.width = resized.width;
    object.height = resized.height;
    if (selectedComponent?.type === component.type && selectedComponent.key === component.key) {
      selectedComponent.object = cloneState(object);
    }
  }

  function applyComponentDomVisual(component) {
    if (!textLayerEl || !component) return;
    const page = currentPage();
    const cache = page ? textLinesCache.get(page.id) : null;
    if (!page || !cache) return;
    if (component.type === 'text') {
      if (component.pageId !== page.id) return;
      const line = cache.lines?.[component.lineIndex];
      const sourceSegment = line?.segments?.[component.segmentIndex] || component.segment;
      const edit = textEdits.get(component.key);
      const segment = edit?.segment || component.segment || sourceSegment;
      const el = componentElement(component);
      if (!line || !segment || !el) return;
      const lineRect = rectToViewport(cache.cssViewport, line.box);
      const visualBox = edit
        ? (editedTextVisualBox(edit, segment) || segment.box || line.box)
        : (segment.box || line.box);
      const segmentRect = rectToViewport(cache.cssViewport, visualBox);
      applyRelativeViewportRect(el, segmentRect, lineRect);
      el.style.fontSize = Math.max(1, (segment.fontSize || line.fontSize) * cache.scale) + 'px';
      el.style.lineHeight = Math.max(1, segmentRect.height) + 'px';
      el.style.transformOrigin = '50% 50%';
      el.style.transform = `rotate(${Number(segment.rotation) || 0}deg)`;
      if (edit) {
        el.classList.add('is-edited');
        el.textContent = edit.newText || '';
        el.style.width = Math.max(1, segmentRect.width) + 'px';
        ensureTextMask(
          el.parentElement,
          component.key,
          sourceTextBox(edit, sourceSegment),
          line.box,
          cache.cssViewport,
          Number(segment.rotation) || 0,
          visualBox
        );
      }
      positionComponentMenu();
      return;
    }
    const object = resolveComponentObject(component);
    if (!object) return;
    const el = componentElement(component);
    if (!el) return;
    let box;
    if (component.type === 'inserted-text') {
      box = insertedTextVisualBox(object);
    } else {
      box = { x: Number(object.x) || 0, y: Number(object.y) || 0, width: Math.max(1, Number(object.width) || 1), height: Math.max(1, Number(object.height) || 1) };
    }
    const rect = rectToViewport(cache.cssViewport, box);
    el.style.left = rect.left + 'px';
    el.style.top = rect.top + 'px';
    el.style.width = Math.max(1, rect.width) + 'px';
    el.style.height = Math.max(1, rect.height) + 'px';
    el.style.transform = `rotate(${Number(object.rotation) || 0}deg)`;
    if (component.type === 'inserted-text') {
      el.style.fontSize = Math.max(1, (Number(object.fontSize) || 16) * cache.scale) + 'px';
      el.style.lineHeight = Math.max(1, rect.height) + 'px';
    } else if (component.type === 'inserted-shape') {
      const existing = el.querySelector('svg');
      if (existing) existing.remove();
      el.appendChild(buildShapeSvg(object, rect.width, rect.height, cache.scale));
    }
    positionComponentMenu();
  }

  function beginComponentDrag(event, component) {
    if (!componentMode || editMode || insertMode || !hasDocument() || activeOperation) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectComponent(component);
    const cache = currentTextLayerCache();
    if (!cache) return;
    componentDragState = {
      mode: 'drag',
      component: cloneState(component),
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      cache,
      snapTargets: collectSnapTargets(component.pageId, component.type, component.key),
      started: false
    };
    const onMove = moveEvent => {
      if (!componentDragState || moveEvent.pointerId !== componentDragState.pointerId) return;
      moveEvent.preventDefault();
      if (!componentDragState.started) {
        const distance = Math.hypot(
          moveEvent.clientX - componentDragState.startClientX,
          moveEvent.clientY - componentDragState.startClientY
        );
        if (distance < 4) return;
        componentDragState.started = true;
      }
      const bounds = canvasWrap?.getBoundingClientRect();
      const startCss = componentDragState.cache.cssViewport.convertToPdfPoint(
        componentDragState.startClientX - (bounds?.left || 0),
        componentDragState.startClientY - (bounds?.top || 0)
      );
      const nextCss = componentDragState.cache.cssViewport.convertToPdfPoint(
        moveEvent.clientX - (bounds?.left || 0),
        moveEvent.clientY - (bounds?.top || 0)
      );
      let dx = nextCss[0] - startCss[0];
      let dy = nextCss[1] - startCss[1];
      const snapped = snapComponentDrag(
        componentDragState.component,
        dx,
        dy,
        componentDragState.snapTargets
      );
      updateComponentFromDelta(snapped.dx, snapped.dy, 1, componentDragState.component, { deferRender: true });
    };
    const onUp = upEvent => {
      if (!componentDragState || upEvent.pointerId !== componentDragState.pointerId) return;
      const moved = Boolean(componentDragState.started);
      componentPointerCleanup?.();
      flushComponentVisualRefresh();
      componentDragState = null;
      if (moved) commitEditorHistory();
    };
    bindComponentPointerSession(onMove, onUp);
  }

  function beginComponentResize(event, component, handle = 'se') {
    if (!componentMode || editMode || insertMode || !hasDocument() || activeOperation) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectComponent(component);
    const cache = currentTextLayerCache();
    if (!cache) return;
    const liveObject = resolveComponentObject(component);
    const baseObject = component.type === 'text'
      ? cloneState(component.segment || {})
      : cloneState(liveObject || {});
    componentDragState = {
      mode: 'resize',
      component: cloneState(component),
      baseObject,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      handle,
      rotation: Number(liveObject?.rotation) || getComponentRotation(component),
      cache
    };
    const onMove = moveEvent => {
      if (!componentDragState || moveEvent.pointerId !== componentDragState.pointerId) return;
      moveEvent.preventDefault();
      const bounds = canvasWrap?.getBoundingClientRect();
      const startPdf = componentDragState.cache.cssViewport.convertToPdfPoint(
        componentDragState.startClientX - (bounds?.left || 0),
        componentDragState.startClientY - (bounds?.top || 0)
      );
      const currentPdf = componentDragState.cache.cssViewport.convertToPdfPoint(
        moveEvent.clientX - (bounds?.left || 0),
        moveEvent.clientY - (bounds?.top || 0)
      );
      const dx = currentPdf[0] - startPdf[0];
      const dy = currentPdf[1] - startPdf[1];
      const localDelta = rotatePdfDeltaToLocal(dx, dy, componentDragState.rotation);
      applyComponentResize(
        componentDragState.component,
        componentDragState.baseObject,
        componentDragState.handle,
        localDelta.x,
        localDelta.y
      );
      applyComponentDomVisual(componentDragState.component);
    };
    const onUp = upEvent => {
      if (!componentDragState || upEvent.pointerId !== componentDragState.pointerId) return;
      componentPointerCleanup?.();
      flushComponentVisualRefresh();
      componentDragState = null;
      commitEditorHistory();
    };
    bindComponentPointerSession(onMove, onUp);
  }

  function setEditMode(enabled) {
    const page = currentPage();
    if (enabled) {
      if (!hasDocument()) {
        showToast(t('home.pdfEditor.appendNeedsFile'));
        return;
      }
      if (!page || !pageSupportsContentEditing(page)) {
        showToast(t('home.pdfEditor.editTextRotated'));
        return;
      }
      const cache = page ? textLinesCache.get(page.id) : null;
      if (!cache || cache.lines.length === 0) {
        showToast(t('home.pdfEditor.editTextNoText'));
        return;
      }
      if (!componentMode) setComponentMode(true);
      editMode = true;
      selectedComponent = null;
      closeEditModal();
    } else {
      editMode = false;
      closeEditModal();
      insertMode = null;
      clearPendingInsert();
    }
    if (editTextBtn) {
      editTextBtn.classList.toggle('is-active', editMode);
      editTextBtn.setAttribute('aria-pressed', String(editMode));
    }
    if (selectComponentBtn) {
      selectComponentBtn.classList.toggle('is-active', componentMode);
      selectComponentBtn.setAttribute('aria-pressed', String(componentMode));
    }
    syncEditModeClass();
    syncComponentModeClass();
    updateControls();
    renderMainPreview();
  }

  function openEditModal(key, segment, fallbackSegment, mode = 'edit') {
    if (!editModal || !editModalInput) return;
    editingLineKey = key;
    modalMode = mode;
    const source = segment || fallbackSegment || { text: '' };
    const original = source.text || '';
    const edit = mode === 'edit' ? textEdits.get(key) : null;
    editModalInput.value = edit ? edit.newText : original;
    if (editModalOriginal) editModalOriginal.textContent = original;
    if (editModalTitle) editModalTitle.textContent = t('home.pdfEditor.editText');
    if (editSecurityNote) editSecurityNote.hidden = mode !== 'edit';
    if (editModalOriginalLabel) editModalOriginalLabel.style.display = '';
    if (editModalOriginal) editModalOriginal.style.display = '';
    if (editModalNewLabel) editModalNewLabel.textContent = t('home.pdfEditor.editTextNew');
    editModal.classList.add('visible');
    editModal.inert = false;
    editModal.setAttribute('aria-hidden', 'false');
    syncInteractiveLayers();
    requestAnimationFrame(() => {
      editModalInput.focus();
      editModalInput.select();
    });
  }

  function closeEditModal() {
    if (!editModal) return;
    editModal.classList.remove('visible');
    editModal.inert = true;
    editModal.setAttribute('aria-hidden', 'true');
    editingLineKey = null;
    modalMode = null;
    syncInteractiveLayers();
  }

  function cancelInsertMode() {
    clearPendingInsert();
    insertMode = null;
    closeEditModal();
    updateControls();
    refreshCurrentTextLayer();
  }

  function openInsertTextModal() {
    if (!hasDocument() || activeOperation) return;
    const page = currentPage();
    if (!page || !pageSupportsContentEditing(page)) {
      showToast(t('home.pdfEditor.editTextRotated'));
      return;
    }
    editMode = false;
    componentMode = false;
    selectedComponent = null;
    insertMode = 'text';
    clearPendingInsert();
    modalMode = 'insert-text';
    if (editModalTitle) editModalTitle.textContent = t('home.pdfEditor.insertText');
    if (editModalOriginalLabel) editModalOriginalLabel.style.display = 'none';
    if (editModalOriginal) editModalOriginal.style.display = 'none';
    if (editModalNewLabel) editModalNewLabel.textContent = t('home.pdfEditor.insertTextValue');
    if (editSecurityNote) editSecurityNote.hidden = true;
    if (editModalInput) editModalInput.value = '';
    editModal?.classList.add('visible');
    if (editModal) {
      editModal.inert = false;
      editModal.setAttribute('aria-hidden', 'false');
    }
    syncEditModeClass();
    syncComponentModeClass();
    syncInteractiveLayers();
    requestAnimationFrame(() => editModalInput?.focus());
    updateControls();
    renderMainPreview();
  }

  function readEncodedImageDimensions(bytes, mimeType) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 10) return null;
    const type = String(mimeType || '').toLowerCase();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (type === 'image/png') {
      if (bytes.length < 24
        || view.getUint32(0) !== 0x89504e47
        || view.getUint32(4) !== 0x0d0a1a0a
        || view.getUint32(12) !== 0x49484452) return null;
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type !== 'image/jpeg' && type !== 'image/jpg') return null;
    if (view.getUint16(0) !== 0xffd8) return null;
    const frameMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
    ]);
    let offset = 2;
    while (offset + 3 < view.byteLength) {
      while (offset < view.byteLength && view.getUint8(offset) !== 0xff) offset += 1;
      while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset += 1;
      if (offset >= view.byteLength) break;
      const marker = view.getUint8(offset++);
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      if (offset + 1 >= view.byteLength) break;
      const segmentLength = view.getUint16(offset);
      if (segmentLength < 2 || offset + segmentLength > view.byteLength) break;
      if (frameMarkers.has(marker)) {
        if (segmentLength < 7 || offset + 6 >= view.byteLength) return null;
        return {
          height: view.getUint16(offset + 3),
          width: view.getUint16(offset + 5)
        };
      }
      offset += segmentLength;
    }
    return null;
  }

  function assertImagePixelLimit(dimensions) {
    const width = Number(dimensions?.width);
    const height = Number(dimensions?.height);
    const pixelCount = width * height;
    if (!Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width < 1
      || height < 1
      || !Number.isSafeInteger(pixelCount)
      || pixelCount > IMAGE_BATCH_LIMITS.maxPixelsPerFile) {
      throw new Error(`图像分辨率超过 ${IMAGE_BATCH_LIMITS.maxPixelsPerFile.toLocaleString()} 像素限制`);
    }
    return { width, height };
  }

  async function readImageDimensions(bytes, mimeType) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'image/png' }));
    try {
      const dimensions = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
        image.onerror = () => reject(new Error('image decode failed'));
        image.src = url;
      });
      return dimensions;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function chooseInsertImage() {
    if (!hasDocument() || activeOperation) return;
    const page = currentPage();
    if (!page || !pageSupportsContentEditing(page)) {
      showToast(t('home.pdfEditor.editTextRotated'));
      return;
    }
    insertMode = 'image';
    clearPendingInsert();
    editMode = false;
    componentMode = false;
    selectedComponent = null;
    if (editTextBtn) {
      editTextBtn.classList.remove('is-active');
      editTextBtn.setAttribute('aria-pressed', 'false');
    }
    syncEditModeClass();
    syncComponentModeClass();
    if (imageInput) {
      imageInput.value = '';
      imageInput.click();
    }
    updateControls();
    renderMainPreview();
  }

  function insertShape(shapeType) {
    if (!hasDocument() || activeOperation) return;
    const page = currentPage();
    if (!page || !pageSupportsContentEditing(page)) {
      showToast(t('home.pdfEditor.editTextRotated'));
      return;
    }
    editMode = false;
    componentMode = false;
    selectedComponent = null;
    closeEditModal();
    clearPendingInsert();
    if (editTextBtn) {
      editTextBtn.classList.remove('is-active');
      editTextBtn.setAttribute('aria-pressed', 'false');
    }
    const cache = currentTextLayerCache();
    const pageWidth = cache?.cssViewport?.width ? cache.cssViewport.width / (cache.scale || 1) : 612;
    const isLine = shapeType === 'line';
    const width = isLine ? Math.min(220, pageWidth * 0.36) : Math.min(200, pageWidth * 0.32);
    const height = isLine ? 0 : Math.max(80, width * 0.58);
    pendingInsert = {
      type: 'shape',
      shapeType,
      width,
      height,
      fill: isLine ? null : [1, 1, 1],
      stroke: [0, 0, 0],
      strokeWidth: 2
    };
    insertMode = isLine ? 'shape-line' : `shape-${shapeType}`;
    syncEditModeClass();
    syncComponentModeClass();
    syncInteractiveLayers();
    updateControls();
    renderMainPreview();
    showToast(t('home.pdfEditor.insertShapeHint'), 6000);
  }

  async function prepareInsertImage(file) {
    if (!file) return;
    try {
      const fileSize = await fileSizeFor(file);
      if (!Number.isSafeInteger(fileSize) || fileSize < 1) {
        throw new Error('图像文件大小无效');
      }
      if (fileSize > IMAGE_BATCH_LIMITS.maxBytesPerFile) {
        throw new Error(`图像文件超过 ${Math.floor(IMAGE_BATCH_LIMITS.maxBytesPerFile / 1024 / 1024)}MB 限制`);
      }
      const bytes = await readBytes(file);
      const declaredMime = String(file.type || '').toLowerCase();
      const mimeType = declaredMime || (/\.jpe?g$/i.test(String(file.name || '')) ? 'image/jpeg' : 'image/png');
      if (!['image/png', 'image/jpeg', 'image/jpg'].includes(mimeType)) {
        throw new Error('仅支持 PNG 或 JPEG 图像');
      }
      const encodedDimensions = readEncodedImageDimensions(bytes, mimeType);
      if (encodedDimensions) assertImagePixelLimit(encodedDimensions);
      const dimensions = await readImageDimensions(bytes, mimeType);
      const safeDimensions = assertImagePixelLimit(dimensions);
      const cache = currentTextLayerCache();
      const pageWidth = cache?.cssViewport?.width ? cache.cssViewport.width / (cache.scale || 1) : 612;
      const width = Math.min(240, Math.max(64, pageWidth * 0.4));
      const height = Math.max(40, width * (safeDimensions.height / Math.max(1, safeDimensions.width)));
      const previewUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      pendingInsert = { type: 'image', bytes, mimeType, width, height, previewUrl };
      insertMode = 'image';
      showToast(t('home.pdfEditor.insertImageHint'), 6000);
      updateControls();
    } catch (error) {
      insertMode = null;
      clearPendingInsert();
      showToast(t('home.pdfEditor.insertImageFailed', { error: String(error?.message || error) }));
      updateControls();
    }
  }

  function saveEditModal() {
    if (modalMode === 'insert-text') {
      const text = String(editModalInput?.value || '').trim();
      if (!text) {
        showToast(t('home.pdfEditor.insertTextEmpty'));
        return;
      }
      pendingInsert = {
        type: 'text',
        text,
        fontSize: 16,
        bold: false,
        color: [0, 0, 0]
      };
      closeEditModal();
      showToast(t('home.pdfEditor.insertTextHint'), 6000);
      updateControls();
      return;
    }
    if (modalMode === 'edit-inserted-text') {
      const objectId = editingLineKey;
      const object = insertedTexts.find(item => item.id === objectId);
      if (!object) {
        closeEditModal();
        clearSelectedComponent();
        return;
      }
      const newText = String(editModalInput?.value ?? '').trim();
      if (!newText) {
        showToast(t('home.pdfEditor.insertTextEmpty'));
        return;
      }
      if (newText === object.text) {
        closeEditModal();
        return;
      }
      object.text = newText;
      if (selectedComponent?.type === 'inserted-text' && selectedComponent.key === object.id) {
        selectedComponent = compactPdfEditorComponent(selectedComponent);
      }
      closeEditModal();
      refreshCurrentTextLayer();
      commitEditorHistory();
      return;
    }
    if (editingLineKey == null) return;
    const key = editingLineKey;
    const parts = String(key).split(':');
    const pageId = parts[0];
    const lineIndex = Number(parts[1]);
    const segmentIndex = Number(parts[2]);
    const cache = textLinesCache.get(pageId);
    const line = cache?.lines?.[lineIndex];
    const segment = line?.segments?.[segmentIndex] || line;
    if (!segment) {
      closeEditModal();
      return;
    }
    const newText = editModalInput?.value ?? '';
    const existingEdit = textEdits.get(key);
    const baseSegment = existingEdit?.baseSegment || segment;
    if (newText === segment.text && (!existingEdit || sameTextSegmentLayout(existingEdit.segment, baseSegment))) {
      textEdits.delete(key);
    } else {
      const currentEdit = existingEdit || { newText: segment.text || '', segment: cloneState(segment) };
      currentEdit.newText = newText;
      currentEdit.segment = cloneState(currentEdit.segment || segment);
      if (!currentEdit.baseSegment) currentEdit.baseSegment = cloneState(baseSegment);
      textEdits.set(key, currentEdit);
    }
    closeEditModal();
    const current = currentPage();
    if (current && current.id === pageId && cache) {
      renderTextLayer(cache.lines, cache.cssViewport, cache.scale, pageId);
    }
    commitEditorHistory();
  }

  function handleEditModalCancel() {
    if (modalMode === 'insert-text') {
      cancelInsertMode();
      return;
    }
    closeEditModal();
  }

  function renderMainPreview(zoomToken = zoom.getPreviewToken(), zoomRequest = null) {
    return preview?.render(zoomToken, zoomRequest);
  }

  const zoom = createPdfEditorZoomController({
    getCanvasWrap: () => canvasWrap,
    getCanvasScroll: () => canvasScroll,
    getSelectedComponent: () => selectedComponent,
    getLastRenderScale: () => lastRenderScale,
    setLastRenderScale: scale => { lastRenderScale = scale; },
    isDisposed: () => disposed,
    hasDocument,
    hasActiveOperation: () => Boolean(activeOperation),
    updateZoomLabel,
    positionComponentMenu,
    renderMainPreview,
    listenerOptions
  });

  preview = createPdfEditorPreview({
    canvasStage,
    canvasScroll,
    getCanvasWrap: () => canvasWrap,
    setCanvasWrap: value => { canvasWrap = value; },
    getTextLayer: () => textLayerEl,
    setTextLayer: value => { textLayerEl = value; },
    getMainCanvas: () => mainCanvas,
    setMainCanvas: value => { mainCanvas = value; },
    getMainRenderTask: () => mainRenderTask,
    setMainRenderTask: value => { mainRenderTask = value; },
    getMainEpoch: () => mainEpoch,
    setMainEpoch: value => { mainEpoch = value; },
    getLastRenderScale: () => lastRenderScale,
    setLastRenderScale: value => { lastRenderScale = value; },
    getZoom: () => zoom,
    getCurrentPage: currentPage,
    hasDocument,
    getSourceDoc,
    cacheSourceRotation,
    effectivePageRotation,
    pageSupportsContentEditing,
    getTextLinesCache: () => textLinesCache,
    setTextLinesCache: value => { textLinesCache = value; },
    getEditMode: () => editMode,
    setEditMode: value => setEditMode(value),
    isDisposed: () => disposed,
    renderTextLayer,
    handleCanvasPlacement,
    handleCanvasBackgroundClick,
    syncStageVisibility,
    updateControls,
    updateZoomLabel,
    groupTextItemsIntoLines,
    buildTextLine,
    listenerOptions,
    documentRef: document,
    windowRef: window,
    zoomMin: ZOOM_MIN,
    zoomMax: ZOOM_MAX
  });

  const componentModel = createPdfEditorComponentModel({
    getTextEdits: () => textEdits,
    getInsertedTexts: () => insertedTexts,
    getInsertedImages: () => insertedImages,
    getInsertedShapes: () => insertedShapes,
    getTextLinesCache: () => textLinesCache,
    getSelectedComponent: () => selectedComponent,
    setSelectedComponent: value => { selectedComponent = value; },
    cloneState,
    onChanged: ({ deferRender, component }) => {
      if (deferRender) {
        applyComponentDomVisual(component);
      } else {
        syncComponentModeClass();
        updateControls();
        refreshCurrentTextLayer();
      }
    }
  });

  const componentRenderer = createPdfEditorComponentRenderer({
    getTextLayer: () => textLayerEl,
    getEditMode: () => editMode,
    getComponentMode: () => componentMode,
    getInsertMode: () => insertMode,
    getSelectedComponent: () => selectedComponent,
    getTextEdits: () => textEdits,
    getInsertedTexts: () => insertedTexts,
    getInsertedImages: () => insertedImages,
    getInsertedShapes: () => insertedShapes,
    t,
    listenerOptions,
    selectComponent,
    handleCanvasPlacement,
    sameComponent,
    beginComponentDrag,
    beginComponentResize,
    appendResizeHandles,
    buildShapeSvg,
    syncComponentMenu
  });

  // ----- Load / append -----
  async function loadMainFile(file) {
    if (disposed || !file || activeOperation) {
      if (activeOperation) showToast(t('home.pdfEditor.busy'));
      return;
    }
    const name = String(file.name || '');
    if (!/\.pdf$/i.test(name)) {
      showToast(t('home.pdfEditor.pdfOnly'));
      return;
    }
    if (!confirmDiscardChanges('replace')) return;
    const operation = beginOperation('load');
    showProcess('loadingDocument', 3);
    let stagedDocument = null;
    let documentCommitted = false;
    try {
      const size = await fileSizeFor(file);
      assertOperation(operation);
      assertPdfEditorFile(name, size);
      setLocalizedProgress(12, 'loadingDocument');
      const bytes = await readBytes(file);
      assertOperation(operation);
      const loaded = await documents.loadBytes(bytes, {
        onLoadingTask: loadingTask => {
          operation.loadingTask = loadingTask;
        }
      });
      stagedDocument = loaded.document;
      assertOperation(operation);
      assertPdfEditorPageCount(stagedDocument.numPages);
      setLocalizedProgress(70, 'preparingPages');

      let stagedIdCounter = idCounter;
      const source = { id: `src-${++stagedIdCounter}`, name, bytes, size, pageCount: stagedDocument.numPages };
      const stagedPages = Array.from({ length: stagedDocument.numPages }, (_, index) => ({
        id: `page-${++stagedIdCounter}`,
        sourceId: source.id,
        pageIndex: index,
        rotation: 0
      }));

      await resetDocument();
      assertOperation(operation);
      idCounter = stagedIdCounter;
      sources = [source];
      sourceStore = new Map([[source.id, source]]);
      documents.set(source.id, stagedDocument);
      pages = stagedPages;
      documentCommitted = true;
      stagedDocument = null;
      selectedIds = new Set(pages.length ? [pages[0].id] : []);
      currentId = pages[0]?.id || null;
      selectionAnchorId = pages[0]?.id || null;
      setLocalizedProgress(90, 'preparingPages');
      buildTiles(false);
      updateFileCard();
      syncStageVisibility();
      // `buildTiles(false)` intentionally avoids a duplicate render while the
      // thumbnail observer is being installed. Start the selected page's main
      // canvas explicitly after the document state is committed.
      renderMainPreview();
      resetEditorHistory();
      baselineSnapshot = cloneState(editorHistory.firstSnapshot());
      savedSnapshot = cloneState(editorHistory.firstSnapshot());
      setLocalizedProgress(100, 'loadingDocument');
    } catch (error) {
      const cancelled = operation.cancelled || error instanceof PdfEditorCancelledError;
      if (stagedDocument) {
        try { await stagedDocument.destroy(); } catch (_) {}
      }
      if (documentCommitted) await resetDocument();
      if (!disposed) {
        showToast(
          cancelled ? t('home.pdfEditor.loadCancelled') : messageForError(error, 'load'),
          cancelled ? 4500 : 9000
        );
      }
    } finally {
      delete operation.loadingTask;
      endOperation(operation);
    }
  }

  async function appendPdfBytes(bytes, name, size) {
    if (activeOperation) {
      showToast(t('home.pdfEditor.busy'));
      return;
    }
    const operation = beginOperation('append');
    showProcess('appending', 8);
    try {
      assertPdfEditorFile(name, size);
      const appendSources = [...sources, { name, size }];
      const totalBytes = appendSources.reduce((sum, source) => sum + Number(source.size || 0), 0);
      assertPdfEditorMergeSelection(appendSources, totalBytes);
      setLocalizedProgress(30, 'appending');
      const pdfDoc = await PDFDocument.load(bytes.slice());
      assertOperation(operation);
      const pageCount = pdfDoc.getPageCount();
      assertPdfEditorPageCount(pageCount);
      if (pages.length + pageCount > PDF_EDITOR_LIMITS.maxPages) {
        throw new Error('PDF exceeds the maximum page count');
      }
      const source = { id: `src-${++idCounter}`, name, bytes, size, pageCount };
      sources.push(source);
      sourceStore.set(source.id, source);
      const newPages = Array.from({ length: pageCount }, (_, index) => ({
        id: `page-${++idCounter}`,
        sourceId: source.id,
        pageIndex: index,
        rotation: 0
      }));
      pages.push(...newPages);
      setLocalizedProgress(80, 'preparingPages');
      buildTiles();
      updateFileCard();
      if (newPages.length) {
        currentId = newPages[newPages.length - 1].id;
        selectedIds = new Set([currentId]);
      }
      updateControls();
      renderMainPreview();
      requestAnimationFrame(() => {
        pageStrip?.scrollTo({ top: pageStrip.scrollHeight, behavior: 'smooth' });
      });
      commitEditorHistory();
      setLocalizedProgress(100, 'appending');
    } catch (error) {
      const cancelled = operation.cancelled || error instanceof PdfEditorCancelledError;
      showToast(
        cancelled ? t('home.pdfEditor.cancelled') : messageForError(error, 'append'),
        cancelled ? 4500 : 9000
      );
    } finally {
      endOperation(operation);
    }
  }

  function chooseMainFile() {
    if (activeOperation) {
      showToast(t('home.pdfEditor.busy'));
      return;
    }
    if (isTauri) {
      void (async () => {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({
            multiple: false,
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
          });
          if (!disposed && typeof selected === 'string') {
            await loadMainFile({
              name: selected.split(/[\\/]/).pop() || selected,
              path: selected,
              size: 0
            });
          }
        } catch (error) {
          showToast(messageForError(error, 'load'));
        }
      })();
      return;
    }
    if (fileInput) {
      fileInput.value = '';
      fileInput.click();
    }
  }

  function chooseAppendFile() {
    if (activeOperation) {
      showToast(t('home.pdfEditor.busy'));
      return;
    }
    if (!hasDocument()) {
      showToast(t('home.pdfEditor.appendNeedsFile'));
      return;
    }
    if (isTauri) {
      void (async () => {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const selected = await open({
            multiple: false,
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
          });
          if (!disposed && typeof selected === 'string') {
            const name = selected.split(/[\\/]/).pop() || selected;
            const size = await fileSizeFor({ path: selected, name });
            const bytes = await readBytes({ path: selected, name });
            await appendPdfBytes(bytes, name, size);
          }
        } catch (error) {
          showToast(messageForError(error, 'append'));
        }
      })();
      return;
    }
    if (appendInput) {
      appendInput.value = '';
      appendInput.click();
    }
  }

  // ----- Page operations -----
  function rotateSelected(delta) {
    if (activeOperation || !hasDocument()) return;
    const ids = targetIds();
    for (const id of ids) {
      const page = pages.find(item => item.id === id);
      if (!page) continue;
      page.rotation = normalizePageRotation(page.rotation + delta);
      const pageState = pageStateFor(id);
      if (pageState) refreshTile(pageState);
    }
    renderMainPreview();
    updateControls();
    commitEditorHistory();
  }

  function moveCurrent(direction) {
    if (activeOperation || !hasDocument()) return;
    const page = currentPage();
    if (!page) return;
    const index = pages.indexOf(page);
    const targetIndex = direction === -1 ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= pages.length) return;
    const [moved] = pages.splice(index, 1);
    pages.splice(targetIndex, 0, moved);
    // Reorder the DOM tiles in lockstep without discarding rendered canvases.
    const targetTile = pageStateFor(page.id)?.tile;
    if (targetTile) {
      const ordered = Array.from(pageStrip.children);
      const domIndex = ordered.indexOf(targetTile);
      if (domIndex !== -1) {
        ordered.splice(domIndex, 1);
        ordered.splice(targetIndex, 0, targetTile);
        const fragment = document.createDocumentFragment();
        ordered.forEach(node => fragment.appendChild(node));
        pageStrip.appendChild(fragment);
      }
    }
    for (let i = 0; i < pages.length; i++) {
      const pageState = pageStateFor(pages[i].id);
      if (pageState) pageState.indexEl.textContent = String(i + 1);
    }
    updateControls();
    commitEditorHistory();
  }

  function duplicateSelectedPages() {
    if (activeOperation || !hasDocument()) return;
    const ids = targetIds();
    if (!ids.length) return;
    if (pages.length + ids.length > PDF_EDITOR_LIMITS.maxPages) {
      showToast(t('home.pdfEditor.tooManyPages'));
      return;
    }

    const idsToDuplicate = new Set(ids);
    const duplicateIds = [];
    const nextPages = [];
    const pageCopies = new Map();
    for (const page of pages) {
      nextPages.push(page);
      if (!idsToDuplicate.has(page.id)) continue;
      const duplicate = {
        ...page,
        id: `page-${++idCounter}`
      };
      nextPages.push(duplicate);
      duplicateIds.push(duplicate.id);
      pageCopies.set(page.id, duplicate.id);
    }

    const copiedTextEdits = [];
    for (const [key, edit] of textEdits.entries()) {
      const sourcePageId = String(key).split(':')[0];
      const targetPageId = pageCopies.get(sourcePageId);
      if (!targetPageId) continue;
      copiedTextEdits.push([
        `${targetPageId}${String(key).slice(sourcePageId.length)}`,
        normalizeEditSnapshot(edit)
      ]);
    }
    for (const [key, edit] of copiedTextEdits) textEdits.set(key, edit);

    for (const object of [...insertedTexts]) {
      const pageId = pageCopies.get(object.pageId);
      if (!pageId) continue;
      insertedTexts.push({
        ...cloneState(object),
        id: `text-${++idCounter}`,
        pageId
      });
    }
    for (const object of [...insertedImages]) {
      const pageId = pageCopies.get(object.pageId);
      if (!pageId) continue;
      const imageId = `image-${++idCounter}`;
      const stored = insertedImageStore.get(object.id);
      const bytes = stored?.bytes || object.bytes;
      insertedImageStore.set(imageId, { bytes, mimeType: object.mimeType });
      insertedImages.push({
        ...normalizeInsertedImageSnapshot(object),
        id: imageId,
        pageId,
        bytes,
        previewUrl: bytes?.length
          ? URL.createObjectURL(new Blob([bytes], { type: object.mimeType || 'image/png' }))
          : ''
      });
    }
    for (const object of [...insertedShapes]) {
      const pageId = pageCopies.get(object.pageId);
      if (!pageId) continue;
      insertedShapes.push({
        ...normalizeInsertedShapeSnapshot(object),
        id: `shape-${++idCounter}`,
        pageId
      });
    }

    pages = nextPages;
    currentId = duplicateIds.at(-1) || currentId;
    selectedIds = new Set(duplicateIds);
    selectionAnchorId = duplicateIds[0] || currentId;
    clearSelectedComponent();
    buildTiles();
    updateFileCard();
    commitEditorHistory();
  }

  async function insertBlankPage() {
    if (activeOperation || !hasDocument()) return;
    if (pages.length >= PDF_EDITOR_LIMITS.maxPages) {
      showToast(t('home.pdfEditor.tooManyPages'));
      return;
    }

    const operation = beginOperation('append');
    showProcess('preparingPages', 10);
    try {
      const current = currentPage();
      let width = 612;
      let height = 792;
      if (current) {
        const sourceDoc = await getSourceDoc(current.sourceId);
        assertOperation(operation);
        const sourcePage = await sourceDoc.getPage(current.pageIndex + 1);
        cacheSourceRotation(current, sourcePage);
        const viewport = sourcePage.getViewport({
          scale: 1,
          rotation: effectivePageRotation(current)
        });
        width = Math.max(72, Number(viewport.width) || width);
        height = Math.max(72, Number(viewport.height) || height);
        try { sourcePage.cleanup(); } catch (_) {}
      }

      const blankDocument = await PDFDocument.create();
      blankDocument.addPage([width, height]);
      const bytes = await blankDocument.save({ useObjectStreams: true });
      assertOperation(operation);
      const totalBytes = sources.reduce((sum, source) => sum + Number(source.size || 0), 0) + bytes.length;
      if (totalBytes > PDF_EDITOR_LIMITS.maxMergeTotalBytes) {
        throw new Error('PDF inputs exceed the merge size limit');
      }

      const source = {
        id: `src-${++idCounter}`,
        name: 'blank-page.pdf',
        bytes,
        size: bytes.length,
        pageCount: 1
      };
      const blankPage = {
        id: `page-${++idCounter}`,
        sourceId: source.id,
        pageIndex: 0,
        rotation: 0,
        sourceRotation: 0
      };
      sources.push(source);
      sourceStore.set(source.id, source);
      const insertAt = Math.max(0, pages.findIndex(page => page.id === currentId) + 1);
      pages.splice(insertAt, 0, blankPage);
      currentId = blankPage.id;
      selectedIds = new Set([blankPage.id]);
      selectionAnchorId = blankPage.id;
      clearSelectedComponent();
      buildTiles();
      updateFileCard();
      commitEditorHistory();
      setLocalizedProgress(100, 'preparingPages');
    } catch (error) {
      const cancelled = operation.cancelled || error instanceof PdfEditorCancelledError;
      showToast(
        cancelled ? t('home.pdfEditor.cancelled') : messageForError(error, 'append'),
        cancelled ? 4500 : 9000
      );
    } finally {
      endOperation(operation);
    }
  }

  function deleteSelected() {
    if (activeOperation || !hasDocument()) return;
    if (selectedComponent) {
      if (selectedComponent.type === 'text') {
        const edit = ensureTextEditEntry(selectedComponent, selectedComponent.segment);
        if (edit?.segment) {
          edit.newText = '';
          textEdits.set(selectedComponent.key, edit);
        }
      } else if (selectedComponent.type === 'inserted-text') {
        insertedTexts = insertedTexts.filter(item => item.id !== selectedComponent.key);
      } else if (selectedComponent.type === 'inserted-image') {
        const object = insertedImages.find(item => item.id === selectedComponent.key);
        if (object?.previewUrl) URL.revokeObjectURL(object.previewUrl);
        insertedImages = insertedImages.filter(item => item.id !== selectedComponent.key);
      } else if (selectedComponent.type === 'inserted-shape') {
        insertedShapes = insertedShapes.filter(item => item.id !== selectedComponent.key);
      }
      clearSelectedComponent();
      commitEditorHistory();
      return;
    }
    const ids = targetIds();
    if (ids.length >= pages.length) {
      showToast(t('home.pdfEditor.cannotDeleteAll'));
      return;
    }
    const remaining = pages.filter(page => !ids.includes(page.id));
    if (remaining.length === 0) {
      showToast(t('home.pdfEditor.cannotDeleteAll'));
      return;
    }
    pages = remaining;
    for (const id of ids) {
      const pageState = pageStateFor(id);
      if (pageState) releasePreview(pageState, false);
      textLinesCache.delete(id);
      for (const key of Array.from(textEdits.keys())) {
        if (String(key).split(':')[0] === id) textEdits.delete(key);
      }
      insertedTexts = insertedTexts.filter(item => item.pageId !== id);
      for (const image of insertedImages.filter(item => item.pageId === id)) {
        if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
      }
      insertedImages = insertedImages.filter(item => item.pageId !== id);
      insertedShapes = insertedShapes.filter(item => item.pageId !== id);
    }
    selectedIds = new Set([...selectedIds].filter(id => !ids.includes(id)));
    if (currentId && ids.includes(currentId)) currentId = null;
    if (!currentId) currentId = pages[0]?.id || null;
    if (currentId && !selectedIds.size) selectedIds = new Set([currentId]);
    buildTiles();
    updateFileCard();
    commitEditorHistory();
  }

  function resetEditorState() {
    if (activeOperation || !hasDocument() || !baselineSnapshot) return;
    if (!confirmDiscardChanges('reset')) return;
    applyEditorSnapshot(baselineSnapshot);
    resetEditorHistory();
    baselineSnapshot = cloneState(editorHistory.firstSnapshot());
    savedSnapshot = cloneState(editorHistory.firstSnapshot());
  }

  const exporter = createPdfEditorExporter({
    isTauri,
    getInvoke,
    getOutputDir,
    t,
    isDisposed: () => disposed,
    hasDocument,
    getActiveOperation: () => activeOperation,
    getSources: () => sources,
    getPages: () => pages,
    getTextEdits: () => textEdits,
    getInsertedTexts: () => insertedTexts,
    getInsertedImages: () => insertedImages,
    getInsertedShapes: () => insertedShapes,
    getEditedTextVisualBox: editedTextVisualBox,
    getInsertedTextVisualBox: insertedTextVisualBox,
    getMainSourceName: mainSourceName,
    beginOperation,
    assertOperation,
    endOperation,
    showProcess,
    setLocalizedProgress,
    showToast,
    messageForError,
    showSuccess,
    captureEditorSnapshot,
    setSavedSnapshot: () => {
      savedSnapshot = captureEditorSnapshot();
    }
  });

  // ----- Event wiring -----
  back?.addEventListener('click', closeOverlay, listenerOptions);
  cta?.addEventListener('click', chooseMainFile, listenerOptions);
  appendBtn?.addEventListener('click', chooseAppendFile, listenerOptions);
  replaceBtn?.addEventListener('click', chooseMainFile, listenerOptions);
  editTextBtn?.addEventListener('click', () => setEditMode(!editMode), listenerOptions);
  editTextSidebarBtn?.addEventListener('click', () => setEditMode(!editMode), listenerOptions);
  insertTextBtn?.addEventListener('click', openInsertTextModal, listenerOptions);
  insertImageBtn?.addEventListener('click', () => { void chooseInsertImage(); }, listenerOptions);
  insertRectBtn?.addEventListener('click', () => insertShape('rect'), listenerOptions);
  insertEllipseBtn?.addEventListener('click', () => insertShape('ellipse'), listenerOptions);
  insertLineBtn?.addEventListener('click', () => insertShape('line'), listenerOptions);
  selectComponentBtn?.addEventListener('click', () => setComponentMode(!componentMode), listenerOptions);
  componentScaleDownBtn?.addEventListener('click', () => scaleSelectedComponent(0.9), listenerOptions);
  componentScaleUpBtn?.addEventListener('click', () => scaleSelectedComponent(1.1), listenerOptions);
  componentEditBtn?.addEventListener('click', editSelectedComponent, listenerOptions);
  componentRotateBtn?.addEventListener('pointerdown', beginComponentRotate, listenerOptions);
  componentDeleteBtn?.addEventListener('click', deleteSelected, listenerOptions);
  shapeFillInput?.addEventListener('input', event => updateSelectedShapeProperty('fill', hexToRgb01(event.target.value)), listenerOptions);
  shapeStrokeInput?.addEventListener('input', event => updateSelectedShapeProperty('stroke', hexToRgb01(event.target.value)), listenerOptions);
  shapeStrokeWidth?.addEventListener('input', event => updateSelectedShapeProperty('strokeWidth', Number(event.target.value) || 0), listenerOptions);
  shapeFillInput?.addEventListener('change', commitEditorHistory, listenerOptions);
  shapeStrokeInput?.addEventListener('change', commitEditorHistory, listenerOptions);
  shapeStrokeWidth?.addEventListener('change', commitEditorHistory, listenerOptions);
  resetBtn?.addEventListener('click', resetEditorState, listenerOptions);
  undoBtn?.addEventListener('click', () => undoEditorChange(), listenerOptions);
  redoBtn?.addEventListener('click', () => redoEditorChange(), listenerOptions);
  editModalSave?.addEventListener('click', saveEditModal, listenerOptions);
  editModalCancel?.addEventListener('click', handleEditModalCancel, listenerOptions);
  editModalClose?.addEventListener('click', handleEditModalCancel, listenerOptions);
  editModalInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveEditModal();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      handleEditModalCancel();
    }
  }, listenerOptions);
  rotateCcwBtn?.addEventListener('click', () => rotateSelected(-90), listenerOptions);
  rotateCwBtn?.addEventListener('click', () => rotateSelected(90), listenerOptions);
  moveUpBtn?.addEventListener('click', () => moveCurrent(-1), listenerOptions);
  moveDownBtn?.addEventListener('click', () => moveCurrent(1), listenerOptions);
  duplicateBtn?.addEventListener('click', duplicateSelectedPages, listenerOptions);
  blankPageBtn?.addEventListener('click', () => { void insertBlankPage(); }, listenerOptions);
  selectAllBtn?.addEventListener('click', selectAllPages, listenerOptions);
  invertSelectionBtn?.addEventListener('click', invertPageSelection, listenerOptions);
  deleteBtn?.addEventListener('click', deleteSelected, listenerOptions);
  extractBtn?.addEventListener('click', () => { void exporter.extractSelected(targetIds()); }, listenerOptions);
  exportBtn?.addEventListener('click', () => { void exporter.exportPdf(); }, listenerOptions);
  processCancel?.addEventListener('click', () => { void cancelActiveOperation(); }, listenerOptions);
  successOk?.addEventListener('click', () => closeSuccess(), listenerOptions);
  successOpenFolder?.addEventListener('click', async () => {
    if (!isTauri || !lastOutputFolder) return;
    try {
      const invoke = await getInvoke();
      await invoke('open_path', { path: lastOutputFolder });
    } catch (_) {
      showToast(t('home.pdfEditor.openFolderFailed'));
    }
  }, listenerOptions);

  zoom.bindButton(zoomOutBtn, 1 / 1.25);
  zoom.bindButton(zoomInBtn, 1.25);
  fitWidthBtn?.addEventListener('click', () => zoom.setZoom('fit', zoom.getState().zoomPercent), listenerOptions);
  zoomValueBtn?.addEventListener('click', () => zoom.setZoom('fit', zoom.getState().zoomPercent), listenerOptions);
  canvasScroll?.addEventListener('wheel', zoom.handleWheel, { ...listenerOptions, passive: false });
  canvasScroll?.addEventListener('scroll', () => {
    if (selectedComponent) requestAnimationFrame(positionComponentMenu);
  }, listenerOptions);
  window.addEventListener('resize', scheduleFitPreview, listenerOptions);
  if (typeof ResizeObserver === 'function' && canvasScroll) {
    fitResizeObserver = new ResizeObserver(scheduleFitPreview);
    fitResizeObserver.observe(canvasScroll);
  }

  fileInput?.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    if (files.length > 1) {
      showToast(t('home.pdfEditor.singlePdfOnly'));
      return;
    }
    void loadMainFile(files[0]);
  }, listenerOptions);

  appendInput?.addEventListener('change', () => {
    const files = Array.from(appendInput.files || []);
    if (files.length > 1) {
      showToast(t('home.pdfEditor.singlePdfOnly'));
      return;
    }
    const file = files[0];
    if (!file) return;
    void file.arrayBuffer().then(buffer => {
      return appendPdfBytes(new Uint8Array(buffer), file.name, file.size);
    });
  }, listenerOptions);

  imageInput?.addEventListener('change', () => {
    const file = Array.from(imageInput.files || [])[0];
    void prepareInsertImage(file);
  }, listenerOptions);
  imageInput?.addEventListener('cancel', cancelInsertMode, listenerOptions);

  overlay.addEventListener('dragover', event => {
    if (!overlay.classList.contains('visible') || isTauri) return;
    event.preventDefault();
    showDropZone();
  }, listenerOptions);
  overlay.addEventListener('dragleave', event => {
    if (event.relatedTarget && overlay.contains(event.relatedTarget)) return;
    hideDropZone();
  }, listenerOptions);
  overlay.addEventListener('drop', event => {
    if (isTauri) return;
    event.preventDefault();
    hideDropZone();
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length !== 1) {
      showToast(t('home.pdfEditor.singlePdfOnly'));
      return;
    }
    void loadMainFile(files[0]);
  }, listenerOptions);

  if (isTauri) {
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const unlisten = await getCurrentWebview().onDragDropEvent(event => {
          if (disposed || !overlay.classList.contains('visible') || activeOperation) return;
          const payload = event.payload || {};
          if (payload.type === 'enter' || payload.type === 'over') {
            showDropZone();
          } else if (payload.type === 'leave') {
            hideDropZone();
          } else if (payload.type === 'drop') {
            hideDropZone();
            const paths = Array.from(payload.paths || []);
            if (paths.length !== 1) {
              showToast(t('home.pdfEditor.singlePdfOnly'));
              return;
            }
            const path = paths[0];
            void loadMainFile({
              name: path.split(/[\\/]/).pop() || path,
              path,
              size: 0
            });
          }
        });
        if (disposed) {
          try { unlisten(); } catch (_) {}
          return;
        }
        nativeDragUnlisten = unlisten;
      } catch (error) {
        if (!disposed) console.error('[PDF Editor] Native drag-drop setup failed:', error);
      }
    })();
  }

  document.querySelectorAll('.audio-list-item[data-tool="pdf-editor"]').forEach(item => {
    item.addEventListener('click', openOverlay, listenerOptions);
    item.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openOverlay();
    }, listenerOptions);
  });

  document.addEventListener('keydown', handleDocumentKeydown, listenerOptions);

  unsubscribeLangChange = onLangChange(() => {
    updateControls();
    updateFileCard();
    if (activeOperation?.progressKey && processMask?.classList.contains('visible')) {
      setLocalizedProgress(Number(processValue?.textContent?.replace('%', '') || 0), activeOperation.progressKey, activeOperation.progressParams);
    }
    if (lastSuccess && successOverlay?.classList.contains('visible')) renderSuccess();
  }) || (() => {});

  updateControls();
  updateFileCard();
  updateZoomLabel();
  syncInteractiveLayers();
  syncStageVisibility();

  return {
    async openWithFile(file) {
      if (disposed) return;
      openOverlay();
      await loadMainFile(file);
    },
    dispose() {
      if (disposed) return;
      const operation = activeOperation;
      if (operation && !operation.cancelled) void cancelActiveOperation();
      activeOperation = null;
      disposed = true;
      exporter.dispose();
      listenerController.abort();
      try { unsubscribeLangChange(); } catch (_) {}
      unsubscribeLangChange = () => {};
      try { nativeDragUnlisten?.(); } catch (_) {}
      nativeDragUnlisten = null;
      plasmaInstance = disposeStandardToolPlasma(plasmaInstance);
      successOverlay?.classList.remove('visible');
      processMask?.classList.remove('visible');
      overlay.classList.remove('visible', 'drag-over');
      dropZone?.classList.remove('visible');
      if (fileInput) fileInput.value = '';
      if (appendInput) appendInput.value = '';
      successReturnFocus = null;
      overlayReturnFocus = null;
      lastSuccess = null;
      lastOutputFolder = '';
      stopFitPreviewObserver();
      zoom.dispose();
      stopComponentRotate();
      if (componentRenderFrame) {
        cancelAnimationFrame(componentRenderFrame);
        componentRenderFrame = 0;
      }
      syncInteractiveLayers();
      preview?.dispose();
      stopTileObserver(true);
      void resetDocument().finally(() => documents.dispose());
    }
  };
}
