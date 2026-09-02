import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { pptRenderPageTemplate, pptRenderPortalTemplate } from '../src/features/ppt-render/template.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, tool, controller, template, featureStyles, shared] = await Promise.all([
  read('src/main.js'),
  read('index.html'),
  read('src/features/ppt-render/tool.js'),
  read('src/features/ppt-render/controller.js'),
  read('src/features/ppt-render/template.js'),
  read('src/features/ppt-render/ppt-render.css'),
  read('src/features/ppt-workflows/shared.js')
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
assert.match(controller, /openLazyTool\('pdf-to-image'\)/);
assert.match(controller, /requestLibreOfficeRuntime/);
assert.match(shared, /data-home-link|data-open-support/);
assert.match(featureStyles, /contain:\s*layout paint/);
for (const mode of ['pdf', 'image']) {
  assert.match(pptRenderPageTemplate(mode), new RegExp(`id="pptTo${mode === 'pdf' ? 'Pdf' : 'Image'}Cta"`));
  assert.match(pptRenderPortalTemplate(mode), new RegExp(`id="pptTo${mode === 'pdf' ? 'Pdf' : 'Image'}ProcessMask"`));
}
assert.match(pptRenderPortalTemplate('pdf'), /pptToPdfSuccessOverlay/);
assert.doesNotMatch(pptRenderPortalTemplate('image'), /SuccessOverlay/);

console.log('PPT render lazy tool and lifecycle contract checks passed');
