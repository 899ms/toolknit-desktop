import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPdfEditorThumbnails } from '../src/features/pdf-editor/thumbnails.js';

assert.throws(() => createPdfEditorThumbnails(), /page state accessors/);

const [uiSource, thumbnailSource] = await Promise.all([
  readFile(new URL('../src/pdf-editor-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-editor/thumbnails.js', import.meta.url), 'utf8')
]);

assert.match(thumbnailSource, /export function createPdfEditorThumbnails/);
assert.match(thumbnailSource, /IntersectionObserver/);
assert.match(thumbnailSource, /renderTask/);
assert.match(thumbnailSource, /releasePdfEditorCanvas/);
assert.match(thumbnailSource, /commitEditorHistory/);
assert.match(thumbnailSource, /setPages\(nextPages\)/);
assert.doesNotMatch(uiSource, /let tileObserver/);
assert.doesNotMatch(uiSource, /let tileQueue/);
assert.doesNotMatch(uiSource, /async function renderPreview/);
assert.match(uiSource, /thumbnails\.getPageStates\(\)/);
assert.match(uiSource, /thumbnails\.clear\(\)/);

console.log('PDF editor thumbnail ownership contract passed');
