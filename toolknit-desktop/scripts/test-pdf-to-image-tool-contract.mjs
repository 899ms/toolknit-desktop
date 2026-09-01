import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, styles, specs, tool, preview, exporter, view, errors, featureCss] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/preview.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/exporter.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/view.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/errors.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-to-image/pdf-to-image.css', import.meta.url), 'utf8')
]);

for (const id of [
  'pdfToImageOverlay', 'pdfToImageBack', 'pdfToImageDropZone', 'pdfToImageFileInput',
  'pdfToImageCta', 'pdfToImageWorkspace', 'pdfToImageWorkspaceClose',
  'pdfToImagePageStage', 'pdfToImagePageStrip', 'pdfToImageSelectAllBtn',
  'pdfToImageExportImagesBtn', 'pdfToImageExportLongBtn', 'pdfToImageProcessMask',
  'pdfToImageCancel', 'pdfToImageSuccessOverlay', 'pdfToImageSuccessOpenFolder',
  'pdfToImageSuccessOk'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing PDF To Image DOM contract: ${id}`);
}

assert.match(specs, /'pdf-to-image':\s*Object\.freeze\(\{[\s\S]*?import\('\.\/pdf-to-image\/tool\.js'\)/);
assert.doesNotMatch(main, /from ['"].*pdf-to-image-ui\.js['"]|initPdfToImageTool/);
assert.match(main, /lazyFeatureRegistry\.open\('pdf-to-image'\)/);
assert.match(main, /openWithFile\(pdfFile, \{ allowLongExport: false \}\)/);

assert.match(tool, /createLifecycleScope/);
assert.match(tool, /createPdfToImagePreview/);
assert.match(tool, /createPdfToImageExporter/);
assert.match(tool, /createPdfToImageView/);
assert.match(tool, /owner\.use\(unlisten\)/);
assert.match(tool, /invoke\('cancel_pdf_to_image', \{ jobId: operation\.jobId \}\)/);
assert.doesNotMatch(tool, /invoke\('cancel_convert'/);
assert.match(tool, /isTauri && operation\.type === 'export'/);
assert.match(tool, /operation\.silent = true/);
assert.match(tool, /import\.meta\.env\.DEV[\s\S]{0,120}pdf-to-image-demo/);
assert.match(tool, /async openWithFile\(file, \{ allowLongExport = true \} = \{\}\)/);
assert.doesNotMatch(tool, /audio-list-item\[data-tool=["']pdf-to-image/);
assert.doesNotMatch(tool, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(preview, /import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/);
assert.match(preview, /pdf\.worker\.mjs\?url/);
assert.match(preview, /renderTask\.cancel\(\)/);
assert.match(preview, /loadingToDestroy\?\.destroy\(\)/);
assert.match(preview, /documentToDestroy\?\.destroy\(\)/);
assert.match(preview, /const revision = \+\+documentRevision/);
assert.match(preview, /revision !== documentRevision \|\| lifecycle\.disposed/);
assert.match(preview, /documentRevision \+= 1;\s+stop\(true\)/);
assert.match(preview, /new IntersectionObserver/);
assert.match(preview, /pageScope\.event\(selectButton/);
assert.doesNotMatch(preview, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(exporter, /write_pdf_to_image_page_json/);
assert.match(exporter, /export_pdf_to_images/);
assert.match(exporter, /listen\('pdf-to-image-progress'/);
assert.match(exporter, /discard_pdf_to_image_session/);
assert.match(exporter, /URL\.revokeObjectURL/);
assert.match(exporter, /assertOperation\(operation\)/);
assert.match(view, /\.inert\s*=/);
assert.match(view, /trapFocus/);
assert.match(view, /lastOutputFolder/);
assert.match(errors, /PdfToImageCancelledError/);
assert.match(tool, /if \(activeOperation === operation\) \{\s+currentFile = null;\s+await preview\.releaseDocument\(\)/);
assert.match(tool, /const wasCurrent = activeOperation === operation;\s+endOperation\(operation\)/);

assert.match(featureCss, /\.pdf-to-image-preview-frame/);
assert.match(featureCss, /\.pdf-to-image-v2 \.pdf-merge-v2-poster::after/);
assert.doesNotMatch(styles, /\.pdf-to-image-preview-frame|\.pdf-to-image-v2 \.pdf-merge-v2-poster::after/);

for (const [name, source] of [
  ['tool', tool],
  ['preview', preview],
  ['exporter', exporter],
  ['view', view],
  ['errors', errors]
]) {
  assert.ok(source.split(/\r?\n/).length <= 800, `PDF To Image ${name} module exceeds the oversized-module limit`);
}

console.log('PDF To Image lazy-loading, preview, export and lifecycle contracts passed');
