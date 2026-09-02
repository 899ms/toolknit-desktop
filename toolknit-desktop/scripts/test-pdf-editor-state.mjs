import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  compactPdfEditorComponent,
  pdfEditorPageIdsInDocumentOrder,
  pdfEditorSnapshotsEqual
} from '../src/pdf-editor-state.js';

const imageBytes = new Uint8Array([10, 20, 30, 40]);
const imageLocator = compactPdfEditorComponent({
  type: 'inserted-image',
  pageId: 'page-2',
  key: 'image-9',
  object: {
    bytes: imageBytes,
    previewUrl: 'blob:large-image',
    width: 320,
    height: 180
  }
});
assert.deepEqual(imageLocator, {
  type: 'inserted-image',
  pageId: 'page-2',
  key: 'image-9'
});
assert.equal('object' in imageLocator, false);
assert.equal('bytes' in imageLocator, false);

const textLocator = compactPdfEditorComponent({
  type: 'text',
  pageId: 'page-4',
  key: 'page-4:7:2',
  segment: { text: 'large source segment' }
});
assert.deepEqual(textLocator, {
  type: 'text',
  pageId: 'page-4',
  key: 'page-4:7:2',
  lineIndex: 7,
  segmentIndex: 2
});
assert.equal(compactPdfEditorComponent({ type: 'unknown', pageId: 'page-1', key: 'x' }), null);
assert.equal(compactPdfEditorComponent({ type: 'text', pageId: 'page-1', key: 'invalid' }), null);
assert.equal(compactPdfEditorComponent({
  type: 'text',
  pageId: 'page-1',
  key: 'page-1:2:3',
  lineIndex: 2,
  segmentIndex: 4
}), null);

const pages = [{ id: 'page-1' }, { id: 'page-2' }, { id: 'page-3' }];
assert.deepEqual(
  pdfEditorPageIdsInDocumentOrder(pages, new Set(['page-3', 'page-1']), 'page-2'),
  ['page-1', 'page-3']
);
assert.deepEqual(pdfEditorPageIdsInDocumentOrder(pages, new Set(), 'page-2'), ['page-2']);
assert.deepEqual(pdfEditorPageIdsInDocumentOrder(pages, new Set(['stale']), 'page-2'), ['page-2']);
assert.deepEqual(pdfEditorPageIdsInDocumentOrder(pages, new Set(), 'missing'), []);

const cleanSnapshot = { pages: [{ id: 'page-1', rotation: 0 }], edits: [] };
assert.equal(pdfEditorSnapshotsEqual(cleanSnapshot, structuredClone(cleanSnapshot)), true);
assert.equal(pdfEditorSnapshotsEqual(cleanSnapshot, {
  pages: [{ id: 'page-1', rotation: 90 }],
  edits: []
}), false);
assert.equal(pdfEditorSnapshotsEqual(null, cleanSnapshot), false);

const uiSource = await readFile(new URL('../src/pdf-editor-ui.js', import.meta.url), 'utf8');
const exporterSource = await readFile(new URL('../src/features/pdf-editor/exporter.js', import.meta.url), 'utf8');

const snapshotStart = uiSource.indexOf('function captureEditorSnapshot()');
const snapshotEnd = uiSource.indexOf('function applyEditorSnapshot(', snapshotStart);
const snapshotSource = uiSource.slice(snapshotStart, snapshotEnd);
assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
assert.match(snapshotSource, /selectedComponent:\s*compactPdfEditorComponent\(selectedComponent\)/);
assert.match(snapshotSource, /sourceRotation:\s*_sourceRotation/);

const applyStart = uiSource.indexOf('function applyEditorSnapshot(');
const applyEnd = uiSource.indexOf('function resetEditorHistory()', applyStart);
const applySource = uiSource.slice(applyStart, applyEnd);
assert.match(applySource, /selectedComponent = restoreSelectedComponent\(snapshot\.selectedComponent\)/);

const appendStart = uiSource.indexOf('async function appendPdfBytes(');
const appendEnd = uiSource.indexOf('function chooseMainFile()', appendStart);
const appendSource = uiSource.slice(appendStart, appendEnd);
const limitCheckIndex = appendSource.indexOf('assertPdfEditorMergeSelection(');
const sourceMutationIndex = appendSource.indexOf('sources.push(source)');
assert.ok(limitCheckIndex >= 0, 'append must enforce total PDF editor limits');
assert.ok(sourceMutationIndex > limitCheckIndex, 'append limits must be checked before editor state changes');

const loadStart = uiSource.indexOf('async function loadMainFile(');
const loadEnd = uiSource.indexOf('async function appendPdfBytes(', loadStart);
const loadSource = uiSource.slice(loadStart, loadEnd);
const stagedLoadIndex = loadSource.indexOf('stagedDocument = await loadingTask.promise');
const resetDocumentIndex = loadSource.indexOf('await resetDocument()');
assert.ok(stagedLoadIndex >= 0, 'replacement PDF must be opened before it is committed');
assert.ok(resetDocumentIndex > stagedLoadIndex, 'the current document must survive replacement validation failures');
assert.match(loadSource, /if \(documentCommitted\) await resetDocument\(\)/);
assert.match(uiSource, /confirmDiscardChanges\('close'\)/);
assert.match(uiSource, /confirmDiscardChanges\('replace'\)/);
assert.match(uiSource, /confirmDiscardChanges\('reset'\)/);
assert.match(uiSource, /savedSnapshot = captureEditorSnapshot\(\)/);

assert.match(uiSource, /\['text', 'inserted-text'\]\.includes\(selectedComponent\?\.type\)/);
assert.match(uiSource, /openEditModal\(object\.id, object, object, 'edit-inserted-text'\)/);
assert.match(uiSource, /modalMode === 'edit-inserted-text'/);
assert.match(exporterSource, /textBox: getEditedTextVisualBox\(edit, edit\.segment\)/);
assert.match(uiSource, /Number\(segmentData\.rotation\) \|\| 0/);
assert.match(uiSource, /dataset\?\.maskKey === `\$\{key\}:rotated`/);
assert.match(uiSource, /function editedTextVisualBox\(edit, segment\)/);
assert.match(uiSource, /function insertedTextVisualBox\(object\)/);
assert.match(uiSource, /estimateInsertedTextWidth\(object\?\.text, fontSize\)/);
assert.match(uiSource, /IMAGE_BATCH_LIMITS\.maxBytesPerFile/);
assert.match(uiSource, /IMAGE_BATCH_LIMITS\.maxPixelsPerFile/);
assert.match(uiSource, /function readEncodedImageDimensions\(bytes, mimeType\)/);
const imagePrepareStart = uiSource.indexOf('async function prepareInsertImage(');
const imagePrepareEnd = uiSource.indexOf('function saveEditModal(', imagePrepareStart);
const imagePrepareSource = uiSource.slice(imagePrepareStart, imagePrepareEnd);
assert.ok(imagePrepareStart >= 0 && imagePrepareEnd > imagePrepareStart);
assert.ok(
  imagePrepareSource.indexOf('readEncodedImageDimensions(bytes, mimeType)')
    < imagePrepareSource.indexOf('await readImageDimensions(bytes, mimeType)'),
  'encoded image dimensions must be checked before browser decoding'
);
assert.match(uiSource, /segmentEl\.style\.transformOrigin = '50% 50%'/);

const editModeStart = uiSource.indexOf('function setEditMode(');
const editModeEnd = uiSource.indexOf('function openEditModal(', editModeStart);
const editModeSource = uiSource.slice(editModeStart, editModeEnd);
assert.ok(editModeStart >= 0 && editModeEnd > editModeStart);
assert.match(editModeSource, /if \(!page \|\| !pageSupportsContentEditing\(page\)\)/);
assert.doesNotMatch(editModeSource, /page\?\.rotation/);

console.log('PDF editor state and source contract regression checks passed');
