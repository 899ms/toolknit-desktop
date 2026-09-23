import assert from 'node:assert/strict';
import { createPdfEditorPageSelection } from '../src/features/pdf-editor/page-selection.js';

const pages = [{ id: 'page-1' }, { id: 'page-2' }, { id: 'page-3' }, { id: 'page-4' }];
let currentId = 'page-2';
let selectedIds = new Set(['page-2']);
let selectionAnchorId = 'page-2';
let selectedComponent = { type: 'inserted-text', pageId: 'page-2', key: 'text-1' };
let updateCount = 0;
let renderCount = 0;
let clearCount = 0;
const pageStates = new Map(pages.map(page => [page.id, { id: page.id }]));

const selection = createPdfEditorPageSelection({
  getPages: () => pages,
  getCurrentId: () => currentId,
  setCurrentId: value => { currentId = value; },
  getSelectedIds: () => selectedIds,
  setSelectedIds: value => { selectedIds = value; },
  getSelectionAnchorId: () => selectionAnchorId,
  setSelectionAnchorId: value => { selectionAnchorId = value; },
  getPageState: id => pageStates.get(id),
  getActiveOperation: () => null,
  hasDocument: () => true,
  getSelectedComponent: () => selectedComponent,
  clearSelectedComponent: () => { clearCount += 1; selectedComponent = null; },
  updateControls: () => { updateCount += 1; },
  renderMainPreview: () => { renderCount += 1; }
});

assert.equal(selection.currentPage().id, 'page-2');
assert.deepEqual(selection.targetIds(), ['page-2']);

selection.selectOnly({ id: 'page-1' });
assert.deepEqual([...selectedIds], ['page-1']);
assert.equal(selection.targetIds()[0], 'page-1');

selection.toggleSelect({ id: 'page-3' });
assert.deepEqual(selection.targetIds(), ['page-1', 'page-3']);
assert.equal(selectionAnchorId, 'page-3');

selection.selectRange({ id: 'page-4' });
assert.deepEqual(selection.targetIds(), ['page-3', 'page-4']);

selection.selectAllPages();
assert.deepEqual(selection.targetIds(), ['page-1', 'page-2', 'page-3', 'page-4']);
assert.equal(selectionAnchorId, 'page-1');

selection.invertPageSelection();
assert.deepEqual(selection.targetIds(), ['page-2']);
assert.equal(selectionAnchorId, currentId);

selection.setCurrent({ id: 'page-3' });
assert.equal(currentId, 'page-3');
assert.equal(clearCount, 1);
assert.equal(renderCount, 1);
assert.ok(updateCount >= 6);

selection.selectRange({ id: 'page-1' });
assert.deepEqual(selection.targetIds(), ['page-1', 'page-2']);

console.log('PDF editor page selection state checks passed');
