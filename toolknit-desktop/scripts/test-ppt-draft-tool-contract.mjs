import { readAppMarkup } from './lib/app-markup.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { pptDraftPageTemplate, pptDraftPortalTemplate } from '../src/features/ppt-draft/template.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, tool, controller, preview, template, featureStyles, workbenchStyles] = await Promise.all([
  read('src/main.js'),
  readAppMarkup(import.meta.url),
  read('src/features/ppt-draft/tool.js'),
  read('src/features/ppt-draft/controller.js'),
  read('src/features/ppt-draft/preview.js'),
  read('src/features/ppt-draft/template.js'),
  read('src/features/ppt-draft/ppt-draft.css'),
  read('src/styles/components/ppt-workbench.css')
]);

assert.equal(LAZY_TOOL_SPECS['ppt-draft']?.overlayId, 'pptDraftOverlay');
assert.equal(LAZY_TOOL_SPECS['ppt-draft']?.init, 'initPptDraftTool');
assert.match(LAZY_TOOL_SPECS['ppt-draft'].load.toString(), /ppt-draft\/tool\.js/);
assert.match(html, /id="pptDraftOverlay"[^>]*aria-hidden="true"[^>]*><\/div>/);
assert.doesNotMatch(html, /id="pptDraft(?:ProcessMask|SuccessOverlay|EditorOverlay|Prompt|EditorStrip)"/);
assert.doesNotMatch(main, /pptDraft(?:Overlay|ProcessMask|SuccessOverlay|EditorOverlay|Prompt|EditorStrip)/);
assert.match(tool, /pptDraftPageTemplate/);
assert.match(tool, /pptDraftPortalTemplate/);
assert.match(tool, /createPptDraftController/);
assert.match(tool, /importOutline/);
assert.match(controller, /await import\('jszip'\)/);
assert.match(tool, /import ['"]\.\/ppt-draft\.css['"]/);
assert.match(controller, /createLifecycleScope\(/);
assert.match(controller, /AbortController/);
assert.match(controller, /sessionRevision/);
assert.match(controller, /isCurrentOperation/);
assert.match(controller, /getAiApiKey/);
assert.match(controller, /normalizePptOutlineResult/);
assert.match(controller, /extractPptOutlineJson[\s\S]*normalizePptOutlineResult/);
assert.match(controller, /displayFilesystemPath/);
assert.match(controller, /featureScope\.use\(subscribeLang/);
assert.match(controller, /disposeStandardToolPlasma/);
assert.match(controller, /setInteractiveLayer\(pptDraftProcessMask, visible\)/);
assert.match(controller, /setPptDraftProgress\(0, pptDraftText\('processing'\), false\)/);
assert.match(controller, /importOutline: importOutlineIntoPptDraft/);
assert.doesNotMatch(controller, /from ['"]@tauri-apps\//);
assert.match(preview, /escapeHtml/);
assert.match(template, /id="pptDraftPrompt"/);
assert.match(template, /id="pptDraftEditorOverlay"/);
assert.match(featureStyles, /\.ppt-draft-v2/);
assert.match(featureStyles, /#pptDraftSuccessOverlay/);
assert.match(workbenchStyles, /\.ppt-draft-portal[\s\S]*z-index:\s*40000/);
assert.match(workbenchStyles, /\.ppt-draft-portal[\s\S]*audio-clip-success-overlay[\s\S]*z-index:\s*40010/);

const pageIds = [...pptDraftPageTemplate().matchAll(/id="([^"]+)"/g)].map(match => match[1]);
const portalIds = [...pptDraftPortalTemplate().matchAll(/id="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(pageIds).size, pageIds.length, 'PPT Draft page template contains duplicate IDs');
assert.equal(new Set(portalIds).size, portalIds.length, 'PPT Draft portal template contains duplicate IDs');
assert.ok(pageIds.includes('pptDraftPrompt'));
assert.ok(portalIds.includes('pptDraftProcessMask'));
assert.ok(portalIds.includes('pptDraftSuccessOverlay'));
assert.ok(portalIds.includes('pptDraftEditorOverlay'));

console.log('PPT Draft lazy tool, template and lifecycle contract checks passed');
