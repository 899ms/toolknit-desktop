import { readAppMarkup } from './lib/app-markup.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { pptRenderPageTemplate, pptRenderPortalTemplate } from '../src/features/ppt-render/template.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, tool, controller, template, featureStyles, shared, nativePpt, nativeRunner] = await Promise.all([
  read('src/main.js'),
  readAppMarkup(import.meta.url),
  read('src/features/ppt-render/tool.js'),
  read('src/features/ppt-render/controller.js'),
  read('src/features/ppt-render/template.js'),
  read('src/features/ppt-render/ppt-render.css'),
  read('src/features/ppt-workflows/shared.js'),
  read('src-tauri/src/native_runtime/office/ppt.rs'),
  read('src-tauri/src/native_runtime/runner.rs')
]);

for (const [id, overlayId, initializer] of [
  ['ppt-to-pdf', 'pptToPdfOverlay', 'initPptToPdfTool'],
  ['ppt-to-image', 'pptToImageOverlay', 'initPptToImageTool']
]) {
  assert.equal(LAZY_TOOL_SPECS[id]?.overlayId, overlayId);
  assert.equal(LAZY_TOOL_SPECS[id]?.init, initializer);
  assert.match(LAZY_TOOL_SPECS[id].load.toString(), /ppt-render\/tool\.js/);
  assert.match(html, new RegExp(`id="${overlayId}"[^>]*aria-hidden="true"[^>]*><\\/div>`));
}

assert.doesNotMatch(main, /createPptRenderTool/);
assert.doesNotMatch(main, /pptToPdf(?:ProcessMask|SuccessOverlay|ExportBtn)/);
assert.doesNotMatch(main, /pptToImage(?:ProcessMask|OpenWorkspaceBtn)/);
assert.doesNotMatch(html, /id="pptTo(?:Pdf|Image)(?:ProcessMask|SuccessOverlay)"/);
assert.match(tool, /from ['"]\.\/template\.js['"]/);
assert.match(tool, /from ['"]\.\/controller\.js['"]/);
assert.match(tool, /import ['"]\.\/ppt-render\.css['"]/);
assert.match(controller, /createLifecycleScope\(\)/);
assert.match(controller, /createOperationGuard/);
assert.match(controller, /registerNativePptxDrop/);
assert.match(controller, /guard\.isCurrent/);
assert.match(controller, /stats\.replaceChildren/);
assert.doesNotMatch(controller, /stats\.innerHTML|summary\.innerHTML/);
assert.match(controller, /convert_ppt_to_pdf/);
assert.match(controller, /temporary: mode === 'image'/);
assert.match(controller, /discard_ppt_to_image_preview/);
assert.match(controller, /cleanupTemporaryPreview/);
assert.match(controller, /openLazyTool\('pdf-to-image'\)/);
assert.doesNotMatch(controller, /allowLongExport:\s*false/, 'PPT images must inherit all PDF image export modes');
assert.match(controller, /requestLibreOfficeRuntime/);
assert.match(controller, /if \(isOpen\(owner\) && !busy\) setProgress\(0, text\('processing'\), false\)/);
assert.match(shared, /data-home-link|data-open-support/);
assert.match(nativePpt, /temporary: Option<bool>/);
assert.match(nativePpt, /artifactKind.*ppt-to-image-preview/);
assert.match(nativePpt, /pub\(crate\) fn discard_ppt_to_image_preview/);
assert.match(nativeRunner, /office::discard_ppt_to_image_preview/);
assert.match(featureStyles, /contain:\s*layout paint/);
assert.match(featureStyles, /\.ppt-render-v2 \[hidden\]\s*\{\s*display: none/);
assert.match(featureStyles, /\.ppt-render-v2 \.ppt-render-v2-export\s*\{[^}]*opacity: 1;[^}]*transform: none;/);
assert.match(featureStyles, /\.ppt-render-v2 \.ppt-render-v2-workspace\s*\{[^}]*overflow-y: auto;/);
for (const language of ['zh', 'en']) {
  const locale = JSON.parse(await read(`src/locales/${language}.json`)).home;
  assert.match(locale.pptToPdfPage.scanDone, /\{slides\}.*\{size\}/);
  assert.doesNotMatch(locale.pptToPdfPage.scanDone, /\{images\}/);
  assert.match(locale.pptImagesPage.scanDone, /\{slides\}.*\{images\}/);
  for (const key of ['invalidPptx', 'fileTooLarge', 'tooManySlides', 'tooManyImages', 'cancelled', 'exportFailed']) {
    assert.ok(locale.pptImagesPage[key], `image extraction must own ${key} in ${language}`);
  }
}
for (const mode of ['pdf', 'image']) {
  assert.doesNotMatch(pptRenderPageTemplate(mode), /ppt-empty-select/);
  assert.match(pptRenderPageTemplate(mode), /class="ppt-file-upload"/);
  assert.match(pptRenderPageTemplate(mode), /class="ppt-images-panel ppt-file-panel"/);
  assert.match(pptRenderPageTemplate(mode), new RegExp(`id="pptTo${mode === 'pdf' ? 'Pdf' : 'Image'}Cta"`));
  assert.match(pptRenderPortalTemplate(mode), new RegExp(`id="pptTo${mode === 'pdf' ? 'Pdf' : 'Image'}ProcessMask"`));
}
assert.match(pptRenderPortalTemplate('pdf'), /pptToPdfSuccessOverlay/);
assert.doesNotMatch(pptRenderPortalTemplate('image'), /SuccessOverlay/);

console.log('PPT render lazy tool and lifecycle contract checks passed');
