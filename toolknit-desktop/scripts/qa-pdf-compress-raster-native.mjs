import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { compressionFixtures } from './lib/pdf-compress-fixtures.mjs';

if (process.env.TOOLKNIT_TEST_ISOLATED_NATIVE !== '1') throw new Error('An isolated native verification instance is required.');
const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve('tmp/pdf-compress-redesign/native');
await mkdir(root, { recursive: true });
const fixture = await compressionFixtures();
const prefix = `toolknit-compress-qa-${randomUUID()}`;
const input = path.join(root, `${prefix}.pdf`);
await writeFile(input, fixture.image);
const originalHash = createHash('sha256').update(fixture.image).digest('hex');
const browser = await chromium.connectOverCDP(process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9247');
const page = browser.contexts().flatMap(context => context.pages()).find(page => /\/\/tauri\.localhost\//.test(page.url()));
assert.ok(page);
page.setDefaultTimeout(60000);
const report = { cases: [], errors: [], outputBytes: null, originalBytes: fixture.image.length };
const ownedOutputs = new Set();
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => { if (message.text().includes('Blocked aria-hidden')) report.errors.push(message.text()); });
const settle = () => page.waitForFunction(() => {
  const veil = document.querySelector('[data-tk-page-transition-veil]');
  return !veil || getComputedStyle(veil).visibility === 'hidden';
});
const select = (id, value) => page.locator(`#${id}`).evaluate((select, value) => {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
const result = async status => {
  await page.waitForSelector('#pdfCompressSuccessOverlay.visible');
  assert.equal(await page.locator('.pdf-compress-result-status').getAttribute('data-status'), status);
  report.cases.push(status);
};
try {
  await page.evaluate(() => localStorage.setItem('toolknit.theme.v3', 'light'));
  await page.reload();
  await page.waitForSelector('#homeToolGrid .tool-result-card');
  await page.evaluate(() => document.querySelector('.audio-list-item[data-tool="pdf-compress"]').click());
  await page.waitForSelector('#pdfCompressOverlay.visible');
  await settle();
  await page.evaluate(input => window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
    target: { kind: 'Webview', label: 'main' }, event: 'tauri://drag-drop', payload: { paths: [input], position: { x: 500, y: 300 } }
  }), input);
  await page.waitForSelector('#pdfCompressFiles .audio-convert-file-name');
  await page.locator('#pdfCompressWorkflowOptions [data-workflow="target"]').click();
  await select('pdfCompressTargetSize', 'custom');
  assert.equal(await page.locator('#pdfCompressWorkflowOptions [data-workflow="target"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#pdfCompressModeOptions [data-mode="structure"]').isDisabled(), true);
  await page.locator('#pdfCompressTargetValue').fill('500');
  await page.locator('#pdfCompressProcessBtn').click();
  await result('compressed');
  const output = await page.locator('#pdfCompressSuccessPath').getAttribute('title');
  assert.ok(path.basename(output).startsWith(prefix + '_compressed') && path.extname(output) === '.pdf', 'only a uniquely named QA output may be inspected and removed');
  ownedOutputs.add(output);
  const bytes = await readFile(output);
  report.outputBytes = bytes.length;
  assert.ok(bytes.length > 0 && bytes.length <= 500 * 1024);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 3);
  assert.equal(pdf.getForm().getFields().length, 0);
  pdf.getPages().forEach((page, index) => {
    assert.equal(page.getWidth(), fixture.expectedSizes[index][0]);
    assert.equal(page.getHeight(), fixture.expectedSizes[index][1]);
  });
  await writeFile(path.join(root, 'verified-output.pdf'), bytes);
  await page.locator('.pdf-compress-result-row summary').click();
  await page.waitForFunction(() => document.querySelector('.pdf-compress-preview img')?.naturalWidth > 0);
  await page.locator('#pdfCompressResults').screenshot({ path: path.join(root, 'verified-result.png') });
  await page.locator('#pdfCompressSuccessOk').click();
  await page.locator('#pdfCompressTargetValue').fill('50');
  await page.locator('#pdfCompressProcessBtn').click();
  await result('target-not-reached');
  assert.equal(await page.locator('#pdfCompressSuccessOpenFolder').isDisabled(), true);
  await page.locator('#pdfCompressSuccessOk').click();
  await select('pdfCompressTargetSize', '50');
  await page.locator('#pdfCompressProcessBtn').click();
  await result('already-within-target');
  await page.locator('#pdfCompressSuccessOk').click();
  await select('pdfCompressTargetSize', 'custom');
  await page.locator('#pdfCompressTargetValue').fill('500');
  await page.locator('#pdfCompressProcessBtn').click();
  await page.waitForFunction(async () => (await indexedDB.databases()).some(db => db.name.startsWith('toolknit-pdf-compress-')));
  await page.locator('#pdfCompressCancel').click();
  await page.waitForFunction(() => !document.querySelector('#pdfCompressProcessMask').classList.contains('visible'));
  await page.waitForFunction(async () => !(await indexedDB.databases()).some(db => db.name.startsWith('toolknit-pdf-compress-')));
  report.cases.push('cancelled-and-cache-cleaned');
  assert.equal(await page.locator('#pdfCompressModeOptions [data-mode="structure"]').isDisabled(), true,
    'structure mode remains unavailable while a target is selected');
  await page.locator('#pdfCompressWorkflowOptions [data-workflow="regular"]').click();
  assert.equal(await page.locator('#pdfCompressModeOptions [data-mode="structure"]').isEnabled(), true);
  await page.locator('#pdfCompressModeOptions [data-mode="structure"]').click();
  assert.equal(await page.locator('#pdfCompressModeOptions [data-mode="structure"]').getAttribute('aria-pressed'), 'true');
  const files = await readdir(path.dirname(output));
  assert.equal(files.filter(name => name.startsWith(prefix + '_compressed')).length, 1);
  if (process.env.TOOLKNIT_NATIVE_QA_PID) {
    assert.equal(files.filter(name => name.startsWith(`.toolknit-compress-${process.env.TOOLKNIT_NATIVE_QA_PID}-`)).length, 0);
  }
  assert.equal(createHash('sha256').update(await readFile(input)).digest('hex'), originalHash);
  await page.locator('#pdfCompressBack').click();
  await settle();
  assert.deepEqual(report.errors, []);
  console.log(`Native PDF compression UI passed: ${report.originalBytes} -> ${report.outputBytes} bytes; strict cap, no-export, cancellation and cleanup verified.`);
} catch (error) {
  report.failure = String(error.message || error);
  for (const output of ownedOutputs) report.failure = report.failure.replaceAll(output, '[QA output]');
  throw new Error(report.failure);
} finally {
  // These paths came from this job's unique output prefix; no existing user
  // file or output-directory preference is changed by the verification.
  for (const output of ownedOutputs) {
    try {
      if (path.basename(output).startsWith(prefix + '_compressed') && (await stat(output)).isFile()) await unlink(output);
    } catch (error) {
      if (error.code !== 'ENOENT') report.cleanupError = String(error.code || 'cleanup-failed');
    }
  }
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
