import { readAppMarkup } from './lib/app-markup.mjs';
import { readGlobalStyles } from './lib/global-styles.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, runtime, styles, specs, tool, preview, exporter, view, errors, exportModes, featureCss, workbench] = await Promise.all([
  readAppMarkup(import.meta.url),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/application-runtime.js', import.meta.url), 'utf8'),
  readGlobalStyles(import.meta.url),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/preview.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/exporter.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/view.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/errors.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/export-modes.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/pdf-to-image.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/pdf-workbench.js', import.meta.url), 'utf8')
]);

for (const id of [
  'pdfToImageOverlay', 'pdfToImageBack', 'pdfToImageDropZone', 'pdfToImageFileInput',
  'pdfToImageCta', 'pdfToImageWorkspace', 'pdfToImageWorkspaceClose',
  'pdfToImagePageStage', 'pdfToImagePageStrip', 'pdfToImageSelectAllBtn',
  'pdfToImageExportImagesBtn', 'pdfToImageExportLongBtn', 'pdfToImageProcessMask',
  'pdfToImageExportHorizontalBtn', 'pdfToImageExportGridBtn',
  'pdfToImageCancel', 'pdfToImageSuccessOverlay', 'pdfToImageSuccessOpenFolder',
  'pdfToImageSuccessOk'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing PDF To Image DOM contract: ${id}`);
}

assert.match(specs, /'pdf-to-image':\s*Object\.freeze\(\{[\s\S]*?import\('\.\/pdf-to-image\/tool\.js'\)/);
assert.doesNotMatch(main, /from ['"].*pdf-to-image-ui\.js['"]|initPdfToImageTool/);
const toastInitIndex = runtime.indexOf('const toastManager = createToastManager');
const customBackgroundRuntimeIndex = runtime.indexOf('customBackgroundSettingsRuntime = createCustomBackgroundSettingsRuntime');
const screenPickerRuntimeIndex = runtime.indexOf('const screenPickerSettingsRuntime = createScreenPickerSettingsRuntime');
assert.ok(toastInitIndex >= 0, 'startup must initialize Toast');
assert.ok(customBackgroundRuntimeIndex > toastInitIndex, 'Toast must initialize before custom background settings');
assert.ok(screenPickerRuntimeIndex > toastInitIndex, 'Toast must initialize before screen picker settings');
// Homepage cards use the shared lazy launcher so migrated tools do not need
// individual hard-coded call sites in the monolithic entry.
assert.match(main, /lazyFeatureRegistry\.open\(toolId\)/);
assert.match(main, /LAZY_TOOL_SPECS\[toolId\]/);

assert.match(tool, /createLifecycleScope/);
assert.match(tool, /createPdfToImagePreview/);
assert.match(tool, /createPdfToImageExporter/);
assert.match(tool, /createPdfToImageView/);
assert.match(tool, /refreshIcons = \(\) => \{\}/);
assert.match(tool, /if \(disposed\) return;\s+refreshIcons\(\);\s+setLongExportAllowed/);
assert.match(tool, /owner\.use\(unlisten\)/);
assert.match(tool, /invoke\('cancel_pdf_to_image', \{ jobId: operation\.jobId \}\)/);
assert.doesNotMatch(tool, /invoke\('cancel_convert'/);
assert.match(tool, /isTauri && operation\.type === 'export'/);
assert.match(tool, /operation\.silent = true/);
assert.match(tool, /import\.meta\.env\.DEV[\s\S]{0,120}pdf-to-image-demo/);
assert.match(tool, /async openWithFile\(file, \{[\s\S]*?allowLongExport = true,[\s\S]*?cleanupTemporaryPreview = null[\s\S]*?\} = \{\}\)/);
assert.match(tool, /cleanupTemporaryPreview/);
assert.match(tool, /await releasePreviewResources\(\)/);
assert.match(tool, /return accepted;/);
assert.doesNotMatch(tool, /audio-list-item\[data-tool=["']pdf-to-image/);
assert.doesNotMatch(tool, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(preview, /import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/);
assert.match(preview, /pdf\.worker\.mjs\?url/);
assert.match(preview, /createPdfWorkbench/);
assert.match(preview, /view\.setPages/);
assert.match(preview, /view\.getPages/);
assert.match(preview, /view\.clear/);
assert.match(preview, /workspace\.classList\.add\('pdf-to-image-v2'\)/);
assert.match(preview, /loadingTask\?\.destroy/);
assert.match(preview, /selectedPageStates/);
assert.doesNotMatch(preview, /new IntersectionObserver|pageScope\.event\(/);
assert.doesNotMatch(preview, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(html, /data-to-image-actions/);
assert.match(html, /class="pdf-workbench pdf-editor-v2 pdf-to-image-workspace"/);

assert.match(exporter, /write_pdf_to_image_page_json/);
assert.match(exporter, /export_pdf_to_images/);
assert.match(exporter, /listen\('pdf-to-image-progress'/);
assert.match(exporter, /discard_pdf_to_image_session/);
assert.match(exporter, /URL\.revokeObjectURL/);
assert.match(exporter, /assertOperation\(operation\)/);
assert.match(view, /\.inert\s*=/);
assert.match(view, /trapFocus/);
assert.match(view, /lastOutputFolder/);
assert.match(view, /successOpenFolder\.style\.display = ''/);
assert.doesNotMatch(view, /successOpenFolder\.style\.display = isTauri \? '' : 'none'/);
assert.match(errors, /PdfToImageCancelledError/);
assert.match(tool, /if \(activeOperation === operation\) \{\s+currentFile = null;\s+await releasePreviewResources\(\)/);
assert.match(tool, /const wasCurrent = activeOperation === operation;\s+endOperation\(operation\)/);

assert.match(featureCss, /\.pdf-to-image-preview-frame/);
assert.match(tool, /pdfToImageExportHorizontalBtn/);
assert.match(tool, /pdfToImageExportGridBtn/);
assert.match(tool, /long-horizontal/);
assert.match(tool, /exportSelection\('grid'\)/);
assert.match(exportModes, /PDF_TO_IMAGE_WORKSPACE_LIMITS/);
assert.match(exportModes, /gridPageCounts/);
assert.match(exportModes, /is-available/);
assert.match(exportModes, /validatePdfToImageExportMode/);
assert.match(exportModes, /invalid-grid-count/);
assert.match(featureCss, /pdf-to-image-conditional-export/);
assert.match(featureCss, /\.pdf-to-image-selection-button/);
assert.match(featureCss, /\.pdf-to-image-export-actions/);
assert.match(featureCss, /\.pdf-workbench \.pdf-to-image-workspace-footer\s*\{[\s\S]*?display:\s*flex/);
assert.match(featureCss, /\.pdf-workbench \.pdf-to-image-footer-actions-row\s*\{[\s\S]*?display:\s*grid/);
assert.doesNotMatch(featureCss, /\.pdf-workbench \.pdf-to-image-conditional-export:not\(\.is-available\)\s*\{[\s\S]*?display:\s*none/);
assert.match(featureCss, /@import.*styles\/components\/pdf-page-selection\.css/);
assert.match(featureCss, /\.pdf-to-image-v2 \.pdf-merge-v2-poster::after/);
assert.doesNotMatch(styles, /\.pdf-to-image-preview-frame|\.pdf-to-image-v2 \.pdf-merge-v2-poster::after/);
assert.match(workbench, /const actionHost = actions\?\.classList\?\.contains\('pdf-workbench-actions'\)/);
assert.match(workbench, /actionHost\.className = 'pdf-workbench-actions'/);

for (const [name, source] of [
  ['tool', tool],
  ['preview', preview],
  ['exporter', exporter],
  ['view', view],
  ['errors', errors]
]) {
  assert.ok(source.split(/\r?\n/).length <= 900, `PDF To Image ${name} module exceeds the oversized-module limit`);
}

console.log('PDF To Image lazy-loading, preview, export and lifecycle contracts passed');
