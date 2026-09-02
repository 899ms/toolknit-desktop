import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [uiSource, documentsSource] = await Promise.all([
  readFile(new URL('../src/pdf-editor-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-editor/documents.js', import.meta.url), 'utf8')
]);

assert.match(documentsSource, /export function createPdfEditorDocumentStore/);
assert.match(documentsSource, /const pending = new Map\(\)/);
assert.match(documentsSource, /const loadingTasks = new Set\(\)/);
assert.match(documentsSource, /requestGeneration !== generation/);
assert.match(documentsSource, /await (?:loadingTask|task)\.destroy\(\)/);
assert.match(documentsSource, /await pdfDocument\.destroy\(\)/);
assert.match(documentsSource, /async function destroyAll\(\)/);
assert.match(uiSource, /await documents\.destroyAll\(\)/);
assert.match(uiSource, /documents\.set\(source\.id, stagedDocument\)/);
assert.doesNotMatch(uiSource, /let pdfDocs = new Map\(\)/);
assert.doesNotMatch(uiSource, /pdfjsLib\.getDocument\(\{ data: bytes\.slice\(\)/);

console.log('PDF editor document ownership contract passed');
