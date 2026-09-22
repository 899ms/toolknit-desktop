import { readAppMarkup } from './lib/app-markup.mjs';
import { readGlobalStyles } from './lib/global-styles.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { pptTextPageTemplate, pptTextPortalTemplate, pptCompressPageTemplate, pptCompressPortalTemplate, pptOutlinePageTemplate, pptOutlinePortalTemplate } from '../src/features/ppt-workflows/template.js';
import { createOperationGuard } from '../src/features/ppt-workflows/shared.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, styles, tool, textController, compressController, outlineController, shared, featureStyles, workbenchStyles, applicationRuntime] = await Promise.all([
  read('src/main.js'), readAppMarkup(import.meta.url), readGlobalStyles(import.meta.url), read('src/features/ppt-workflows/tool.js'),
  read('src/features/ppt-workflows/text-controller.js'), read('src/features/ppt-workflows/compress-controller.js'),
  read('src/features/ppt-workflows/outline-controller.js'), read('src/features/ppt-workflows/shared.js'), read('src/features/ppt-workflows/ppt-workflows.css'),
  read('src/styles/components/ppt-workbench.css'), read('src/application-runtime.js')
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
assert.match(compressController, /enhanceToolSelect\(level\)/);
assert.match(compressController, /levelSelect\?\.dispose\(\)/);
assert.match(pptCompressPageTemplate(), /id="pptCompressLevel"/);
assert.match(textController, /if \(isOpen\(owner\) && !busy\) setProgress\(0, text\('processing'\), false\)/);
assert.match(compressController, /if \(isOpen\(owner\) && !busy\) setProgress\(0, text\('processing'\), false\)/);
assert.match(shared, /if \(!isCurrent\(\) \|\| owner\.disposed\) \{\s*unlisten\(\);\s*return;/);
assert.match(shared, /owner\.use\(unlisten\)/);
assert.match(featureStyles, /ppt-text-v2/);
assert.match(featureStyles, /@media \(min-width: 981px\) and \(max-height: 520px\)/);
assert.doesNotMatch(featureStyles, /@media \(max-height: 520px\)/, 'short-window shrinking must not collapse stacked workspaces');
assert.match(workbenchStyles, /\[data-ppt-text-portal\][\s\S]*z-index:\s*40000/);
assert.match(workbenchStyles, /\[data-ppt-compress-portal\][\s\S]*z-index:\s*40010/);
assert.match(workbenchStyles, /\[data-ppt-outline-portal\][\s\S]*z-index:\s*40010/);
assert.match(outlineController, /await continueToDraft\(lastResult/);
assert.match(applicationRuntime, /continueToDraft: async \(outline, sourceLabel\)/);
assert.match(applicationRuntime, /instance\?\.raw\?\.importOutline/);

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
