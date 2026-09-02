import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { pptTextPageTemplate, pptTextPortalTemplate, pptCompressPageTemplate, pptCompressPortalTemplate, pptOutlinePageTemplate, pptOutlinePortalTemplate } from '../src/features/ppt-workflows/template.js';
import { createOperationGuard } from '../src/features/ppt-workflows/shared.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, styles, tool, textController, compressController, outlineController, shared, featureStyles] = await Promise.all([
  read('src/main.js'), read('index.html'), read('src/styles.css'), read('src/features/ppt-workflows/tool.js'),
  read('src/features/ppt-workflows/text-controller.js'), read('src/features/ppt-workflows/compress-controller.js'),
  read('src/features/ppt-workflows/outline-controller.js'), read('src/features/ppt-workflows/shared.js'), read('src/features/ppt-workflows/ppt-workflows.css')
]);

for (const [id, overlayId, initializer] of [['ppt-text', 'pptTextOverlay', 'initPptTextTool'], ['ppt-compress', 'pptCompressOverlay', 'initPptCompressTool'], ['ppt-outline', 'pptOutlineOverlay', 'initPptOutlineTool']]) {
  assert.equal(LAZY_TOOL_SPECS[id]?.overlayId, overlayId);
  assert.equal(LAZY_TOOL_SPECS[id]?.init, initializer);
  assert.match(LAZY_TOOL_SPECS[id].load.toString(), /ppt-workflows\/tool\.js/);
  assert.match(html, new RegExp(`id="${overlayId}"[^>]*aria-hidden="true"[^>]*><\\/div>`));
}
assert.doesNotMatch(main, /PPT AI Text Extractor|PPT Compress|PPT AI Outline/);
assert.doesNotMatch(main, /pptText(?:Overlay|ProcessMask|SuccessOverlay)/);
assert.doesNotMatch(main, /pptCompress(?:Overlay|ProcessMask|SuccessOverlay)/);
assert.doesNotMatch(main, /pptOutline(?:Overlay|ProcessMask|SuccessOverlay)/);
assert.doesNotMatch(html, /id="ppt(?:Text|Compress|Outline)(?:ProcessMask|SuccessOverlay)"/);
assert.match(tool, /pptTextPageTemplate/);
assert.match(tool, /pptCompressPageTemplate/);
assert.match(tool, /pptOutlinePageTemplate/);
for (const source of [textController, compressController, outlineController]) {
  assert.match(source, /createLifecycleScope\(\)/);
  assert.match(source, /guard\.isCurrent/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
}
for (const source of [textController, compressController]) {
  assert.match(source, /registerNativePptxDrop/);
}
assert.doesNotMatch(outlineController, /registerNativePptxDrop/);
assert.match(textController, /AbortController|abortController/);
assert.match(compressController, /canvas\.width = 0/);
assert.match(shared, /if \(!isCurrent\(\) \|\| owner\.disposed\) \{\s*unlisten\(\);\s*return;/);
assert.match(shared, /owner\.use\(unlisten\)/);
assert.match(featureStyles, /ppt-text-v2/);

let currentSession = { disposed: false };
const guard = createOperationGuard(() => currentSession);
const first = guard.begin();
assert.equal(guard.isCurrent(first), true);
const second = guard.begin();
assert.equal(guard.isCurrent(first), false);
assert.equal(guard.isCurrent(second), true);
currentSession.disposed = true;
assert.equal(guard.isCurrent(second), false);

for (const markup of [pptTextPortalTemplate(), pptCompressPortalTemplate(), pptOutlinePortalTemplate()]) {
  assert.match(markup, /ppt(?:Text|Compress|Outline)ProcessMask/);
  assert.match(markup, /ppt(?:Text|Compress|Outline)SuccessOverlay/);
}
assert.doesNotMatch(pptOutlinePageTemplate(), /id="pptOutlineStyle"/);

console.log('PPT workflow lazy tool and lifecycle contract checks passed');
