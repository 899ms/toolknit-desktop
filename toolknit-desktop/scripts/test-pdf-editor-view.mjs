import assert from 'node:assert/strict';
import { createPdfEditorView } from '../src/features/pdf-editor/view.js';

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
    toggle: (name, force) => {
      const next = force === undefined ? !values.has(name) : Boolean(force);
      if (next) values.add(name); else values.delete(name);
      return next;
    }
  };
}

function element() {
  return { classList: classList(), style: {}, textContent: '', value: '' };
}

const overlay = element();
const dropZone = element();
const emptyState = element();
const canvasWrap = element();
const fileNameEl = element();
const fileStatsEl = element();
const successOverlay = element();
const successMeta = element();
const successPath = element();
const successOpenFolder = element();
const successOk = element();
const zoomValueBtn = element();
const fileInput = element();
const appendInput = element();
const cta = element();
const exportBtn = element();
const back = element();

let disposed = false;
let busy = null;
let hasDocument = false;
let confirmAction = null;
let resetCount = 0;
let plasmaInitCount = 0;
let plasmaDisposeCount = 0;
let focusTarget = null;
let restoredFocus = null;
const toasts = [];
const source = { name: 'report.pdf', size: 2048 };
const pages = [{ id: 'page-1' }, { id: 'page-2' }];
let zoomState = { viewMode: 'fit', zoomPercent: 1 };

const view = createPdfEditorView({
  overlay,
  plasmaBg: element(),
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
  fileInput,
  appendInput,
  t: (key, params) => params?.count ? `${key}:${params.count}` : key,
  isTauri: true,
  isDisposed: () => disposed,
  initStandardToolPlasma: () => { plasmaInitCount += 1; return { id: 'plasma' }; },
  disposeStandardToolPlasma: value => { if (value) plasmaDisposeCount += 1; return null; },
  displayFilesystemPath: value => `display:${value}`,
  getSources: () => [source],
  getPages: () => pages,
  getMainSourceName: () => source.name,
  formatSize: value => `${value} bytes`,
  getCanvasWrap: () => canvasWrap,
  getOpenFocusTarget: () => focusTarget,
  getZoomState: () => zoomState,
  getActiveOperation: () => busy,
  hasDocument: () => hasDocument,
  confirmDiscardChanges: action => { confirmAction = action; return true; },
  resetDocument: async () => { resetCount += 1; },
  focusedElement: () => back,
  restoreFocus: value => { restoredFocus = value; },
  syncInteractiveLayers: () => {},
  showToast: message => toasts.push(message)
});

focusTarget = cta;
view.openOverlay();
assert.equal(overlay.classList.contains('visible'), true);
assert.equal(plasmaInitCount, 1);
assert.equal(restoredFocus, cta);

view.showDropZone();
assert.equal(overlay.classList.contains('drag-over'), true);
assert.equal(dropZone.classList.contains('visible'), true);
view.hideDropZone();
assert.equal(dropZone.classList.contains('visible'), false);

hasDocument = true;
view.updateFileCard();
assert.equal(fileNameEl.textContent, 'report.pdf');
assert.equal(fileStatsEl.textContent, 'home.pdfEditor.pageCount:2 · 2048 bytes');
view.syncStageVisibility();
assert.equal(emptyState.style.display, 'none');
assert.equal(canvasWrap.style.display, '');

view.updateZoomLabel();
assert.equal(zoomValueBtn.textContent, 'home.pdfEditor.fitShort');
zoomState = { viewMode: 'zoom', zoomPercent: 1.25 };
view.updateZoomLabel();
assert.equal(zoomValueBtn.textContent, '125%');

view.showSuccess({ outputDir: 'C:/out', mode: 'export' }, exportBtn);
assert.equal(successOverlay.classList.contains('visible'), true);
assert.equal(successMeta.textContent, 'home.pdfEditor.successExportMeta');
assert.equal(successPath.textContent, 'display:C:/out');
assert.equal(successOpenFolder.style.display, '');
assert.equal(view.getLastOutputFolder(), 'C:/out');
view.closeSuccess();
assert.equal(successOverlay.classList.contains('visible'), false);
assert.equal(restoredFocus, exportBtn);

busy = { type: 'export' };
assert.equal(view.closeOverlay(), false);
assert.equal(confirmAction, null);
assert.equal(toasts.at(-1), 'home.pdfEditor.busy');
busy = null;
assert.equal(view.closeOverlay(), true);
assert.equal(confirmAction, 'close');
assert.equal(resetCount, 1);
assert.equal(fileInput.value, '');
assert.equal(appendInput.value, '');
assert.equal(plasmaDisposeCount, 1);

view.dispose();
assert.equal(view.getLastOutputFolder(), '');
console.log('PDF editor view lifecycle checks passed');
