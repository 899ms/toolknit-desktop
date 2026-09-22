import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

if (process.env.TOOLKNIT_TEST_ISOLATED_NATIVE !== '1') throw new Error('Use an isolated native QA window.');
const require = createRequire(path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json'));
const { chromium } = require('playwright');
const root = path.resolve('tmp/excel-diagnosis/native');
await mkdir(root, { recursive: true });
const source = process.env.TOOLKNIT_EXCEL_QA_FILE;
const bytes = await readFile(source);
const hash = value => createHash('sha256').update(value).digest('hex');
const input = path.join(root, `sample-${randomUUID()}.xls`);
await copyFile(source, input);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9247');
const page = browser.contexts().flatMap(context => context.pages()).find(page => /tauri\.localhost/.test(page.url()));
assert.ok(page);
page.setDefaultTimeout(60000);
const report = { cases: [], errors: [] };
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => {
  if (/Blocked aria-hidden|Ensure that the cMapUrl|\[Excel/.test(message.text())) report.errors.push(message.text());
});
const settle = () => page.waitForFunction(() => {
  const veil = document.querySelector('[data-tk-page-transition-veil]');
  return !veil || getComputedStyle(veil).visibility === 'hidden';
});
try {
  await page.evaluate(() => localStorage.setItem('toolknit.theme.v3', 'light'));
  await page.reload();
  await page.waitForSelector('#homeToolGrid .tool-result-card');
  await page.evaluate(() => document.querySelector('.audio-list-item[data-tool="excel-to-pdf"]').click());
  await page.waitForSelector('#excelToPdfOverlay.visible');
  await settle();
  await page.evaluate(input => window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
    target: { kind: 'Webview', label: 'main' }, event: 'tauri://drag-drop',
    payload: { paths: [input], position: { x: 500, y: 300 } }
  }), input);
  await page.waitForSelector('.excel-pdf-file');
  const button = page.locator('[data-excel-action="convert"]');
  report.button = await button.evaluate(node => ({ color: getComputedStyle(node).color,
    label: getComputedStyle(node.querySelector('span')).color, background: getComputedStyle(node).backgroundColor }));
  assert.equal(report.button.label, 'rgb(255, 255, 255)');
  assert.notEqual(report.button.label, report.button.background);
  await page.screenshot({ path: path.join(root, 'ready.png') });
  const started = performance.now();
  await button.click();
  await page.waitForSelector('[data-excel-process].visible');
  report.feedbackMs = Math.round(performance.now() - started);
  await page.waitForSelector('[data-excel-success].visible', { timeout: 180000 });
  report.elapsedMs = Math.round(performance.now() - started);
  const outputDir = await page.locator('[data-excel-success-path]').innerText();
  const manifest = JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.options, { sheetRange: 'all', orientation: 'source', paper: 'auto', scale: 'fit' });
  const output = manifest.outputs[0];
  assert.equal(output.sourceName, path.basename(input));
  assert.equal(output.pageCount, 3);
  assert.equal(output.warnings.length, 0, 'the XLS sample should avoid compatibility normalization');
  const pdfBytes = await readFile(output.outputPath);
  const pdf = await PDFDocument.load(pdfBytes);
  assert.equal(pdf.getPageCount(), 3);
  report.pages = pdf.getPageCount();
  report.outputBytes = pdfBytes.length;
  await writeFile(path.join(root, 'verified.pdf'), pdfBytes);
  await page.locator('[data-excel-action="success-ok"]').click();
  assert.equal(await page.locator('[data-excel-success]').evaluate(node => node.inert && !node.contains(document.activeElement)), true);
  await page.locator('[data-excel-action="back"]').click();
  await settle();
  assert.equal(hash(await readFile(source)), hash(bytes));
  report.cases.push('native-ui-default-fit-direct-import', 'complete-pdf-reopen', 'success-focus-and-back', 'original-unchanged');
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
