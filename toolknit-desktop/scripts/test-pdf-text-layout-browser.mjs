import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/pdf-text-layout');
await mkdir(output, { recursive: true });
const document = await PDFDocument.create();
const font = await document.embedFont(StandardFonts.Helvetica);
for (const [index, text] of ['First page: project notes', 'Second page: next steps'].entries()) {
  const page = document.addPage([600, 800]);
  page.drawText(text, { x: 50, y: 720, size: 22, font });
  page.drawText(`Source paragraph ${index + 1}. <script>example</script>`, { x: 50, y: 660, size: 12, font });
}
const sample = Buffer.from(await document.save());
document.addPage([600, 800]);
const mixed = Buffer.from(await document.save());
const empty = await PDFDocument.create();
empty.addPage([600, 800]);
const blank = Buffer.from(await empty.save());
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ headless: true, channel: process.env.TOOLKNIT_TEST_CHANNEL || 'msedge' });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const root = '#pdfTextExtractOverlay';

async function state(page, value) {
  await page.waitForSelector(`${root}[data-state="${value}"]`);
}
async function open(page) {
  await page.locator('[data-tool="pdf-text-markdown"]').first().evaluate(node => node.click());
  await page.waitForSelector(`${root}.visible`);
  await state(page, 'empty');
}
async function upload(page, buffer, name = 'Project notes.pdf') {
  await page.locator('#pdfTextExtractFileInput').setInputFiles({ name, mimeType: 'application/pdf', buffer });
}
async function snapshot(page, label) {
  await page.waitForTimeout(350);
  assert.equal(await page.locator(`${root} header`).evaluate(node => node.getBoundingClientRect().top), 0);
  assert.ok(await page.locator('.pdf-text-extract-v2-workspace').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: path.join(output, `${label}.png`) });
}
async function assertContainedAction(page, selector) {
  const bounds = await page.locator(selector).evaluate(node => {
    const action = node.getBoundingClientRect();
    const workspace = node.closest('.pdf-text-extract-v2-workspace').getBoundingClientRect();
    return { actionBottom: action.bottom, workspaceBottom: workspace.bottom };
  });
  assert.ok(bounds.actionBottom <= bounds.workspaceBottom - 12, JSON.stringify(bounds));
}

try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1401, height: 920 }, reducedMotion: 'reduce' });
    if (theme === 'dark') await page.addInitScript(() => localStorage.setItem('toolknit-lang', 'en'));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await open(page);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    assert.equal(await page.locator('#pdfTextExtractStats').isVisible(), false);
    assert.equal(await page.locator('#pdfTextExtractProcess').isVisible(), false);
    await snapshot(page, `${theme}-empty`);
    await upload(page, sample);
    await state(page, 'selected');
    assert.equal(await page.locator('.pdf-text-extract-upload').isVisible(), false);
    assert.equal(await page.locator('.pdf-text-extract-plan').isVisible(), true);
    assert.equal(await page.locator('#pdfTextExtractStats').isVisible(), false);
    assert.equal(await page.locator('#pdfTextExtractProcess').isEnabled(), true);
    await snapshot(page, `${theme}-selected`);
    await page.setViewportSize({ width: 720, height: 820 });
    await page.locator('#pdfTextExtractProcess').scrollIntoViewIfNeeded();
    await assertContainedAction(page, '#pdfTextExtractProcess');
    await snapshot(page, `${theme}-narrow-selected`);
    await page.setViewportSize({ width: 1401, height: 920 });
    await page.locator('#pdfTextExtractProcess').click();
    await state(page, 'success');
    assert.equal(await page.locator('#pdfTextExtractProcess').isVisible(), false);
    assert.equal(await page.locator('.pdf-text-extract-page-tabs button').count(), 2);
    assert.match(await page.locator('.pdf-text-extract-preview').textContent(), /First page/);
    assert.equal(await page.locator('.pdf-text-extract-preview script').count(), 0);
    await page.locator('[data-preview-page="1"]').click();
    assert.match(await page.locator('.pdf-text-extract-preview').textContent(), /Second page/);
    assert.equal(await page.locator('[data-preview-page="1"]').getAttribute('aria-pressed'), 'true');
    await snapshot(page, `${theme}-result`);
    await page.setViewportSize({ width: 720, height: 820 });
    await page.locator('#pdfTextExtractImport').scrollIntoViewIfNeeded();
    await assertContainedAction(page, '#pdfTextExtractImport');
    await snapshot(page, `${theme}-narrow-result`);
    await page.setViewportSize({ width: 1280, height: 520 });
    assert.ok(await page.locator('.pdf-text-extract-page-tabs').evaluate(node => node.getBoundingClientRect().height >= 38));
    await page.locator('#pdfTextExtractImport').scrollIntoViewIfNeeded();
    await snapshot(page, `${theme}-short-result`);
    await page.locator('#pdfTextExtractReset').click();
    await state(page, 'empty');
    assert.equal(await page.locator('.pdf-text-extract-preview').textContent(), '');
    assert.equal(await page.locator('.pdf-text-extract-page-tabs button').count(), 0);
    await page.setViewportSize({ width: 1401, height: 920 });
    await upload(page, mixed);
    await state(page, 'selected');
    await page.locator('#pdfTextExtractProcess').click();
    await state(page, 'partial');
    await page.locator('[data-preview-page="2"]').click();
    assert.ok(await page.locator('.pdf-text-extract-preview').textContent());
    assert.equal(await page.locator('#pdfTextExtractWarning').isVisible(), true);
    await page.locator('#pdfTextExtractImport').click();
    await page.waitForSelector('#markdownEditorOverlay.visible');
    await page.reload();
    await open(page);
    await upload(page, blank);
    await state(page, 'selected');
    await page.locator('#pdfTextExtractProcess').click();
    await state(page, 'noText');
    assert.equal(await page.locator('#pdfTextExtractImport').isVisible(), false);
    await page.locator('#pdfTextExtractRemove').click();
    await state(page, 'empty');
    await upload(page, Buffer.from('invalid PDF'));
    await state(page, 'error');
    assert.equal(await page.locator('#pdfTextExtractWarning').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.waitForSelector(`${root}.visible`, { state: 'hidden' });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${theme}: upload, result preview, page switching, reset, editor import, partial/empty/error, short viewport`);
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
