import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPdfEditorThumbnails } from '../src/features/pdf-editor/thumbnails.js';

assert.throws(() => createPdfEditorThumbnails(), /page state accessors/);

const [uiSource, thumbnailSource] = await Promise.all([
  readFile(new URL('../src/features/pdf-editor/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-editor/thumbnails.js', import.meta.url), 'utf8')
]);

assert.match(thumbnailSource, /export function createPdfEditorThumbnails/);
assert.match(thumbnailSource, /releasePreview,\s*\n\s*refresh,/);
assert.match(uiSource, /import \{ createPdfEditorThumbnails \} from ['"]\.\/thumbnails\.js['"]/);
assert.match(uiSource, /function releasePreview\(pageState, markReleased = true\)/);
assert.match(uiSource, /releasePreview,\s*\n\s*buildTiles,/);
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

const thumbnailCss = await readFile(new URL('../src/styles/pages/pdf-editor-legacy.css', import.meta.url), 'utf8');
assert.match(thumbnailCss, /\.pdf-editor-tile-frame\.is-ready \.pdf-editor-tile-skeleton\s*\{\s*display: none;/);
assert.match(thumbnailCss, /\.pdf-editor-tile-index,\s*\.pdf-editor-tile-select,\s*\.pdf-editor-tile-drag\s*\{\s*z-index: 1;/);

console.log('PDF editor thumbnail ownership contract passed');
