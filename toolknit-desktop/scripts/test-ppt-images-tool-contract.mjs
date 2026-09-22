import { readAppMarkup } from './lib/app-markup.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { pptImagesPageTemplate, pptImagesPortalTemplate } from '../src/features/ppt-images/template.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, tool, controller, featureStyles, shared] = await Promise.all([
  read('src/main.js'),
  readAppMarkup(import.meta.url),
  read('src/features/ppt-images/tool.js'),
  read('src/features/ppt-images/controller.js'),
  read('src/features/ppt-images/ppt-images.css'),
  read('src/features/ppt-workflows/shared.js')
]);
const workbenchStyles = await read('src/styles/components/ppt-workbench.css');

assert.doesNotMatch(featureStyles, /\.ppt-images-scroll-top/,
  'shared scroll controls must not depend on opening PPT image extraction first');
assert.match(workbenchStyles, /\.ppt-images-scroll-top\s*\{[^}]*position:\s*absolute;[^}]*width:\s*52px;[^}]*height:\s*52px;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/);
assert.match(workbenchStyles, /\.ppt-images-scroll-top\.visible\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/);
assert.match(workbenchStyles, /\.ppt-images-scroll-top-icon\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/);
for (const feature of ['ppt-images', 'ppt-workflows', 'ppt-draft', 'ppt-render']) {
  assert.match(await read(`src/features/${feature}/tool.js`), /import ['"]\.\.\/\.\.\/styles\/components\/ppt-workbench\.css['"]/,
    `${feature} must load shared PPT controls without another feature's stylesheet`);
}

assert.equal(LAZY_TOOL_SPECS['ppt-images']?.overlayId, 'pptImagesOverlay');
assert.equal(LAZY_TOOL_SPECS['ppt-images']?.init, 'initPptImagesTool');
assert.match(LAZY_TOOL_SPECS['ppt-images'].load.toString(), /ppt-images\/tool\.js/);
assert.match(html, /id="pptImagesOverlay"[^>]*aria-hidden="true"[^>]*><\/div>/);
assert.doesNotMatch(main, /pptImages(?:Overlay|ProcessMask|SuccessOverlay|ExportBtn)/);
assert.doesNotMatch(main, /ppt-image-extract-core/);
assert.doesNotMatch(html, /id="pptImages(?:ProcessMask|SuccessOverlay|FileInput|ExportBtn)"/);
assert.match(tool, /pptImagesPageTemplate/);
assert.match(tool, /pptImagesPortalTemplate/);
assert.match(tool, /import ['"]\.\/ppt-images\.css['"]/);
assert.match(controller, /createLifecycleScope\(\)/);
assert.match(controller, /createOperationGuard/);
assert.match(controller, /guard\.assertCurrent/);
assert.match(controller, /registerNativePptxDrop/);
assert.match(controller, /session\.use\(releasePreviewUrls\)/);
assert.match(controller, /uniqueOutputDirectory/);
assert.match(controller, /writeUniqueFile/);
assert.match(controller, /import\('jszip'\)/);
assert.match(controller, /if \(isOpen\(owner\) && !busy\) setProgress\(0, text\('processing'\), false\)/);
assert.doesNotMatch(controller, /\.innerHTML\s*=/);
assert.doesNotMatch(controller, /@tauri-apps\/api\/webview/);
assert.match(featureStyles, /contain:\s*layout paint/);
assert.match(workbenchStyles, /\.pdf-merge-v2 \.ppt-file-cta\s*\{[^}]*color:\s*#000;/,
  'the white upload button must override inherited page text color');
assert.match(shared, /owner\.use\(unlisten\)/);
for (const markup of [pptImagesPageTemplate(), pptImagesPortalTemplate()]) {
  assert.match(markup, /pptImages/);
}
assert.match(pptImagesPageTemplate(), /id="pptImagesCta"/);
assert.match(pptImagesPortalTemplate(), /id="pptImagesProcessMask"/);
assert.match(pptImagesPortalTemplate(), /id="pptImagesSuccessOverlay"/);
for (const suffix of ['Overlay', 'Image', 'Title', 'Meta', 'Close']) {
  assert.match(pptImagesPortalTemplate(), new RegExp(`id="pptImagesPreview${suffix}"`));
}
assert.match(pptImagesPortalTemplate(), /aria-labelledby="pptImagesPreviewTitle"/);
assert.match(controller, /createModalSession/);
assert.match(controller, /thumbnailScope\?\.dispose\(\)/);
assert.match(controller, /previewImage\?\.removeAttribute\('src'\)/);
assert.match(controller, /checkbox\.className = 'ppt-images-check'/);

console.log('PPT images lazy tool and lifecycle contract checks passed');
