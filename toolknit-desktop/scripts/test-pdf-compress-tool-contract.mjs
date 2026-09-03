import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, styles, specs, tool, processor, featureCss] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/legacy.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-compress/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-compress/processor.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/pdf-compress/pdf-compress.css', import.meta.url), 'utf8')
]);

for (const id of [
  'pdfCompressOverlay', 'pdfCompressPlasmaBg', 'pdfCompressBack',
  'pdfCompressDropZone', 'pdfCompressCta', 'pdfCompressLevelOptions',
  'pdfCompressFiles', 'pdfCompressProcessBtn', 'pdfCompressProcessMask',
  'pdfCompressProcessText', 'pdfCompressProcessBarFill',
  'pdfCompressSuccessOverlay', 'pdfCompressSuccessMeta',
  'pdfCompressSuccessFileName', 'pdfCompressSuccessOriginalSize',
  'pdfCompressSuccessCompressedSize', 'pdfCompressSuccessCount',
  'pdfCompressSuccessPath', 'pdfCompressSuccessOpenFolder', 'pdfCompressSuccessOk'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing PDF Compress DOM contract: ${id}`);
}

assert.match(specs, /'pdf-compress':\s*Object\.freeze\(\{[\s\S]*?import\('\.\/pdf-compress\/tool\.js'\)/);
assert.doesNotMatch(main, /pdfCompressOverlay|selectedPdfCompressFiles|renderCompressResults|pdfCompressDrawer/);
assert.doesNotMatch(styles, /\.pdf-compress-result-/);
assert.doesNotMatch(html, /pdfCompressDrawer/);
assert.doesNotMatch(html, /结果抽屉|底部抽屉/);

assert.match(tool, /createLifecycleScope/);
assert.match(tool, /bindPointerSortableFileList/);
assert.match(tool, /owner\.use\(unlisten\)/);
assert.match(tool, /if \(!isOpenSession\(owner\)\) \{\s*unlisten\(\)/);
assert.match(tool, /isCurrent:\s*\(\) => activeOperation === operation && isOpenSession\(owner\)/);
assert.match(tool, /cancelOperation\(\{ silent: true, detach: true \}\)/);
assert.match(tool, /operation\.isCurrent\(\)/);
assert.match(tool, /import\.meta\.env\.DEV[\s\S]{0,160}pdf-compress-demo/);
assert.match(tool, /fileList\.replaceChildren\(\)/);
assert.match(tool, /name\.textContent = String\(file\?\.name/);
assert.match(tool, /successPath\.textContent = path/);
assert.match(tool, /invoke\('open_path', \{ path: target \}\)/);
assert.match(tool, /import ['"]\.\/pdf-compress\.css['"]/);
assert.doesNotMatch(tool, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(processor, /compress_pdf/);
assert.match(processor, /assertPdfCompressSelection/);
assert.match(processor, /assertPdfCompressLevel/);
assert.match(processor, /operation\.isCurrent\(\)/);
assert.match(processor, /PdfCompressCancelledError/);
assert.doesNotMatch(processor, /\.addEventListener\(|\.innerHTML\s*=/);

assert.match(featureCss, /#pdfCompressSuccessOverlay/);
assert.match(featureCss, /max-height: calc\(100vh - 24px\)/);
assert.match(featureCss, /max-width: 980px\) and \(max-height: 420px\)/);

for (const [name, source] of [['tool', tool], ['processor', processor]]) {
  assert.ok(source.split(/\r?\n/).length <= 800, `PDF Compress ${name} module exceeds the oversized-module limit`);
}

console.log('PDF Compress lazy loading, lifecycle, queue, output and safety contracts passed');
