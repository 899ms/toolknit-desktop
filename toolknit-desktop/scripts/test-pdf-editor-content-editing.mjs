import assert from 'node:assert/strict';
import { createPdfEditorContentEditing } from '../src/features/pdf-editor/content-editing.js';

function makeClassList() {
  const values = new Set();
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    toggle: (value, force) => {
      const enabled = force === undefined ? !values.has(value) : Boolean(force);
      if (enabled) values.add(value); else values.delete(value);
      return enabled;
    },
    contains: value => values.has(value)
  };
}

function makeElement() {
  return {
    classList: makeClassList(),
    style: {},
    hidden: false,
    inert: true,
    value: '',
    textContent: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 400 }),
    focus() {},
    select() {}
  };
}

const canvasWrap = makeElement();
canvasWrap.getBoundingClientRect = () => ({ left: 10, top: 20, width: 500, height: 400 });
const editModal = makeElement();
const editModalInput = makeElement();
const editTextBtn = makeElement();
const selectComponentBtn = makeElement();
const page = { id: 'page-1' };
const cache = {
  scale: 1,
  lines: [{ segments: [{ text: 'original text' }] }],
  cssViewport: { width: 600, convertToPdfPoint: (x, y) => [x, y] }
};

const documentRef = {
  listeners: new Map(),
  addEventListener(name, handler) { this.listeners.set(name, handler); },
  removeEventListener(name) { this.listeners.delete(name); }
};
const windowRef = { requestAnimationFrame: callback => { callback(); return 1; } };
let editMode = false;
let componentMode = false;
let insertMode = null;
let pendingInsert = null;
let editingLineKey = null;
let modalMode = null;
let selectedComponent = null;
let insertedTexts = [];
let insertedImages = [];
let insertedShapes = [];
const textEdits = new Map();
const storedImages = new Map();
let clearPendingCalls = 0;
let refreshCalls = 0;
let renderCalls = 0;
let commits = 0;
const notifications = [];

const editing = createPdfEditorContentEditing({
  documentRef,
  windowRef,
  getCanvasWrap: () => canvasWrap,
  imageInput: makeElement(),
  editTextBtn,
  selectComponentBtn,
  editModal,
  editModalInput,
  t: key => key,
  getEditMode: () => editMode,
  setEditModeState: value => { editMode = Boolean(value); },
  getComponentMode: () => componentMode,
  setComponentModeState: value => { componentMode = Boolean(value); },
  getInsertMode: () => insertMode,
  setInsertMode: value => { insertMode = value; },
  getPendingInsert: () => pendingInsert,
  setPendingInsert: value => { pendingInsert = value; },
  getEditingLineKey: () => editingLineKey,
  setEditingLineKey: value => { editingLineKey = value; },
  getModalMode: () => modalMode,
  setModalMode: value => { modalMode = value; },
  getSelectedComponent: () => selectedComponent,
  setSelectedComponent: value => { selectedComponent = value; },
  getTextEdits: () => textEdits,
  getTextLinesCache: () => new Map([['page-1', cache]]),
  getInsertedTexts: () => insertedTexts,
  setInsertedTexts: value => { insertedTexts = value; },
  getInsertedImages: () => insertedImages,
  setInsertedImages: value => { insertedImages = value; },
  getInsertedShapes: () => insertedShapes,
  setInsertedShapes: value => { insertedShapes = value; },
  hasDocument: () => true,
  getCurrentPage: () => page,
  getCurrentTextLayerCache: () => cache,
  pageSupportsContentEditing: () => true,
  getActiveOperation: () => null,
  nextId: type => `${type}-${insertedTexts.length + insertedImages.length + insertedShapes.length + 1}`,
  storeInsertedImage: (id, value) => { storedImages.set(id, value); },
  clearPendingInsert: () => { clearPendingCalls += 1; pendingInsert = null; },
  closeSelectedComponent: () => { selectedComponent = null; },
  syncEditModeClass() {},
  syncComponentModeClass() {},
  syncInteractiveLayers() {},
  updateControls() {},
  renderMainPreview: () => { renderCalls += 1; },
  refreshCurrentTextLayer: () => { refreshCalls += 1; },
  renderTextLayer: () => { renderCalls += 1; },
  cloneState: value => structuredClone(value),
  compactComponent: value => ({ type: value.type, pageId: value.pageId, key: value.key }),
  sameTextSegmentLayout: () => true,
  commitEditorHistory: () => { commits += 1; },
  showToast: (message) => { notifications.push(message); }
});

editing.openInsertTextModal();
assert.equal(insertMode, 'text');
assert.equal(modalMode, 'insert-text');
editModalInput.value = '  placed text  ';
editing.saveEditModal();
assert.deepEqual(pendingInsert, {
  type: 'text', text: 'placed text', fontSize: 16, bold: false, color: [0, 0, 0]
});
assert.equal(modalMode, null);
editing.handleCanvasPlacement({
  clientX: 110,
  clientY: 120,
  preventDefault() {},
  stopPropagation() {}
});
assert.equal(insertedTexts.length, 1);
assert.equal(insertedTexts[0].text, 'placed text');
assert.equal(insertMode, null);
assert.equal(pendingInsert, null);
assert.equal(commits, 1);

editing.insertShape('rect');
assert.equal(insertMode, 'shape-rect');
editing.handleCanvasPlacement({
  clientX: 250,
  clientY: 220,
  preventDefault() {},
  stopPropagation() {}
});
assert.equal(insertedShapes.length, 1, 'shape placement must write back to editor state');
assert.equal(insertedShapes[0].shapeType, 'rect');
assert.equal(commits, 2);

const imageBytes = new Uint8Array([1, 2, 3]);
pendingInsert = {
  type: 'image',
  bytes: imageBytes,
  mimeType: 'image/png',
  width: 120,
  height: 80,
  previewUrl: 'blob:pending-image'
};
insertMode = 'image';
editing.handleCanvasPlacement({
  clientX: 300,
  clientY: 240,
  preventDefault() {},
  stopPropagation() {}
});
assert.equal(insertedImages.length, 1);
assert.equal(insertedImages[0].previewUrl, 'blob:pending-image');
assert.deepEqual(storedImages.get(insertedImages[0].id), { bytes: imageBytes, mimeType: 'image/png' });
assert.equal(commits, 3);

const insertedText = insertedTexts[0];
selectedComponent = { type: 'inserted-text', pageId: page.id, key: insertedText.id, object: insertedText };
editing.openEditModal(insertedText.id, insertedText, insertedText, 'edit-inserted-text');
assert.equal(modalMode, 'edit-inserted-text');
editModalInput.value = 'edited text';
editing.saveEditModal();
assert.equal(insertedText.text, 'edited text');
assert.equal(refreshCalls, 1);
assert.equal(commits, 4);

editing.openEditModal('page-1:0:0', cache.lines[0].segments[0], cache.lines[0].segments[0]);
editModalInput.value = 'changed source';
editing.saveEditModal();
assert.equal(textEdits.get('page-1:0:0').newText, 'changed source');
assert.equal(commits, 5);

editing.openInsertTextModal();
const clearPendingBeforeCancel = clearPendingCalls;
editing.handleEditModalCancel();
assert.equal(insertMode, null);
assert.equal(clearPendingCalls, clearPendingBeforeCancel + 1);
assert.equal(editModal.attributes['aria-hidden'], 'true');
assert.ok(renderCalls > 0);
assert.equal(documentRef.listeners.size, 0);

console.log('PDF editor content editing lifecycle checks passed');
