import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, specs, tool, workspace, documentOwner, exporter, view, core, featureCss] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-crop/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-crop/workspace.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-crop/document.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-crop/exporter.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-crop/view.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-crop/core.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-crop/pdf-crop.css', import.meta.url), 'utf8')
]);

for (const id of [
  'pdfCropOverlay', 'pdfCropBack', 'pdfCropDropZone', 'pdfCropFileInput',
  'pdfCropEmptyAdd', 'pdfCropFilmstrip', 'pdfCropPreviewCanvas',
  'pdfCropInteractionLayer', 'pdfCropExport', 'pdfCropProcessMask',
  'pdfCropProcessCancel', 'pdfCropSuccessOverlay',
  'pdfCropSuccessOpenFolder', 'pdfCropSuccessOk'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing PDF Crop DOM contract: ${id}`);
}

assert.match(specs, /'pdf-crop':\s*Object\.freeze\(\{[\s\S]*?import\('\.\/pdf-crop\/tool\.js'\)/);
assert.doesNotMatch(main, /pdf-crop-ui\.js|initPdfCropTool|openPdfCropTool/);
assert.doesNotMatch(html, /<link[^>]+pdf-crop\.css/);

assert.match(tool, /createLifecycleScope/);
assert.match(tool, /createPdfCropWorkspace/);
assert.match(tool, /createPdfCropExporter/);
assert.match(tool, /createPdfCropView/);
assert.match(tool, /import ['"]\.\/pdf-crop\.css['"]/);
assert.match(tool, /owner\.use\(unlisten\)/);
assert.match(tool, /isCurrent:\s*\(\) => activeOperation === operation && isOpenSession\(owner\)/);
assert.match(tool, /cancelOperation\(\{ silent: true, detach: true \}\)/);
assert.match(tool, /import\.meta\.env\.DEV[\s\S]{0,140}pdf-crop-demo/);
assert.match(tool, /return \{ open: openTool, close: closeTool, dispose \}/);
assert.doesNotMatch(tool, /audio-list-item\[data-tool=["']pdf-crop/);
assert.doesNotMatch(tool, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(workspace, /new IntersectionObserver/);
assert.match(workspace, /new ResizeObserver/);
assert.match(workspace, /previewTask\?\.cancel\(\)/);
assert.match(workspace, /renderTask\.cancel\(\)/);
assert.match(workspace, /title\.textContent = text\('home\.pdfCrop\.pageLabel'/);
assert.match(workspace, /owner\.event\(button, 'click'/);
assert.match(workspace, /lifecycle\.event\(target, type, handler, options\)/);
assert.doesNotMatch(workspace, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(documentOwner, /import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/);
assert.match(documentOwner, /pdf\.worker\.mjs\?url/);
assert.match(documentOwner, /await source\.pdfDoc\.destroy\(\)/);
assert.match(documentOwner, /source\.bytes = null/);
assert.match(documentOwner, /active\.loadingTasks\.add\(source\.loadingTask\)/);

assert.match(exporter, /URL\.createObjectURL/);
assert.match(exporter, /URL\.revokeObjectURL/);
assert.match(exporter, /assertOperation\(active\)/);
assert.match(exporter, /shouldCancel:\s*\(\) => active\.cancelled \|\| !active\.isCurrent\(\)/);
assert.match(exporter, /write_unique_file_bytes/);
assert.match(view, /element\.inert = !visible/);
assert.match(core, /export async function exportCroppedPdf/);
assert.match(featureCss, /\.pdf-crop-layout/);
assert.match(featureCss, /@media \(max-height: 520px\)[\s\S]*?grid-template-rows: 48px minmax\(64px, 1fr\) 36px 86px/);

for (const [name, source] of [
  ['tool', tool],
  ['workspace', workspace],
  ['document', documentOwner],
  ['exporter', exporter],
  ['view', view]
]) {
  assert.ok(source.split(/\r?\n/).length <= 800, `PDF Crop ${name} module exceeds the oversized-module limit`);
}

console.log('PDF Crop lazy-loading, lifecycle, preview, interaction and export contracts passed');
