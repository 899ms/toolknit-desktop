import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { pptImagesPageTemplate, pptImagesPortalTemplate } from '../src/features/ppt-images/template.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, tool, controller, featureStyles, shared] = await Promise.all([
  read('src/main.js'),
  read('index.html'),
  read('src/features/ppt-images/tool.js'),
  read('src/features/ppt-images/controller.js'),
  read('src/features/ppt-images/ppt-images.css'),
  read('src/features/ppt-workflows/shared.js')
]);

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
assert.doesNotMatch(controller, /\.innerHTML\s*=/);
assert.doesNotMatch(controller, /@tauri-apps\/api\/webview/);
assert.match(featureStyles, /contain:\s*layout paint/);
assert.match(shared, /owner\.use\(unlisten\)/);
for (const markup of [pptImagesPageTemplate(), pptImagesPortalTemplate()]) {
  assert.match(markup, /pptImages/);
}
assert.match(pptImagesPageTemplate(), /id="pptImagesCta"/);
assert.match(pptImagesPortalTemplate(), /id="pptImagesProcessMask"/);
assert.match(pptImagesPortalTemplate(), /id="pptImagesSuccessOverlay"/);

console.log('PPT images lazy tool and lifecycle contract checks passed');
