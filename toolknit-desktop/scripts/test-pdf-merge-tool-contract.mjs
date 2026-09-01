import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, specs, tool, preview, exporter, featureCss, sortable] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-merge/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-merge/preview.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-merge/exporter.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-merge/pdf-merge.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/sortable-file-list.js', import.meta.url), 'utf8')
]);

for (const id of [
  'pdfMergeOverlay', 'pdfMergeBack', 'pdfMergeDropZone', 'pdfMergeFiles',
  'pdfMergeCta', 'pdfMergeProcessBtn', 'pdfMergeProcessMask',
  'pdfMergeSelection', 'pdfMergeChoosePagesBtn', 'pdfMergeUseAllPagesBtn',
  'pdfMergePageStrip', 'pdfMergeSelectAllPagesBtn', 'pdfMergeSelectionNextBtn',
  'pdfMergeSuccessOverlay', 'pdfMergeSuccessOpenFolder', 'pdfMergeSuccessOk'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing PDF Merge DOM contract: ${id}`);
}

assert.match(specs, /'pdf-merge':\s*Object\.freeze\(\{[\s\S]*?import\('\.\/pdf-merge\/tool\.js'\)/);
assert.doesNotMatch(main, /PDF Merger|pdfMergeOverlay|selectedPdfMergeFiles|pdfMergeSelectionFiles/);

assert.match(tool, /createLifecycleScope/);
assert.match(tool, /createPdfMergePreview/);
assert.match(tool, /createPdfMergeExporter/);
assert.match(tool, /bindPointerSortableFileList/);
assert.match(tool, /owner\.use\(unlisten\)/);
assert.match(tool, /isCurrentRun\(owner, runId\)/);
assert.match(tool, /import\.meta\.env\.DEV[\s\S]{0,120}pdf-merge-demo/);
assert.doesNotMatch(tool, /\.innerHTML\s*=|\.addEventListener\(/);

assert.match(preview, /import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/);
assert.match(preview, /pdf\.worker\.mjs\?url/);
assert.match(preview, /task\.cancel\(\)/);
assert.match(preview, /loadingTask\.destroy\(\)/);
assert.match(preview, /doc\.destroy\(\)/);
assert.match(preview, /renderScope\.event\(tile/);
assert.doesNotMatch(preview, /\.innerHTML\s*=|\.addEventListener\(/);

assert.match(exporter, /write_unique_file_bytes/);
assert.match(exporter, /URL\.revokeObjectURL/);
assert.match(exporter, /assertCurrent\(owner, id\)/);
assert.match(exporter, /outputParent\(lastOutputPath\)/);
assert.match(exporter, /waitForOwner/);
assert.match(sortable, /bindPointerSortableFileList/);
assert.match(sortable, /scope\.event\(row, 'pointerdown'/);
assert.match(featureCss, /pdf-merge-v2/);

for (const [name, source] of [['tool', tool], ['preview', preview], ['exporter', exporter]]) {
  assert.ok(source.split(/\r?\n/).length <= 800, `PDF Merge ${name} module exceeds the oversized-module limit`);
}

console.log('PDF Merge lazy-loading, page selection, export and lifecycle contracts passed');
