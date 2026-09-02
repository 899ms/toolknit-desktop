import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { imageCropSuccessTemplate, imageCropTemplate } from '../src/features/image-crop/template.js';

const root = resolve(import.meta.dirname, '..');
const read = relativePath => readFileSync(resolve(root, relativePath), 'utf8');
const main = read('src/main.js');
const globalStyles = read('src/styles.css');
const html = read('index.html');
const controller = read('src/features/image-crop/controller.js');
const tool = read('src/features/image-crop/tool.js');
const compatibilityCore = read('src/image-crop-core.js').trim();

assert.equal(compatibilityCore, "export * from './features/image-crop/core.js';");
assert.equal(LAZY_TOOL_SPECS['image-crop']?.overlayId, 'imageCropOverlay');
assert.match(LAZY_TOOL_SPECS['image-crop'].load.toString(), /\.\/image-crop\/tool\.js/);
assert.doesNotMatch(main, /imageCrop|image-crop-core/);
assert.doesNotMatch(globalStyles, /\.image-crop-|#imageCrop|image-crop-spin/);
assert.match(html, /id="imageCropOverlay"[^>]*aria-hidden="true"/);
assert.doesNotMatch(html, /id="imageCropCanvas"|id="imageCropSuccessOverlay"/);

const markup = `${imageCropTemplate()}${imageCropSuccessTemplate()}`;
const requiredIds = [
  'imageCropBack', 'imageCropDropZone', 'imageCropCanvas', 'imageCropPick',
  'imageCropRatioGrid', 'imageCropGuide', 'imageCropFormat', 'imageCropExport',
  'imageCropSuccessOverlay', 'imageCropOpenFolder', 'imageCropSuccessOk'
];
for (const id of requiredIds) {
  assert.equal((markup.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} must remain unique`);
}

assert.match(tool, /import ['"]\.\/image-crop\.css['"]/);
assert.match(tool, /createImageCropController/);
assert.match(controller, /createLifecycleScope/);
assert.match(controller, /loadTauriWebview/);
assert.match(controller, /owner\.use\(unlisten\)/);
assert.match(controller, /isCurrentLoad\(owner, requestId\)/);
assert.match(controller, /isCurrentOperation\(operation\)/);
assert.match(controller, /operationSequence \+= 1/);
assert.match(controller, /URL\.revokeObjectURL\(objectUrl\)/);
assert.match(controller, /cancelAnimationFrame\(frame\)/);
assert.match(controller, /observer\.disconnect\(\)/);
assert.match(controller, /api\.close\(\{ force: true \}\)/);
assert.doesNotMatch(controller, /\.innerHTML\s*=/);
assert.doesNotMatch(controller, /from ['"]@tauri-apps\//);
assert.match(
  read('src/features/image-crop/image-crop.css'),
  /@media \(max-width: 780px\)[\s\S]*\.image-crop-controls \{[^}]*overflow-y: visible/,
  'compact Image Crop must let its outer workspace own vertical scrolling'
);

console.log('Image crop lazy tool and lifecycle contract checks passed.');
