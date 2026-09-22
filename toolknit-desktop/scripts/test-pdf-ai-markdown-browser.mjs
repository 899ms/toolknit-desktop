import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/pdf-ai-markdown');
await mkdir(output, { recursive: true });
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([600, 800]).drawText('Synthetic visual PDF page 1', { x: 40, y: 700, size: 24, font });
const scan = createCanvas(600, 800), ctx = scan.getContext('2d');
ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 600, 800);
ctx.fillStyle = 'black'; ctx.font = '28px Arial'; ctx.fillText('SCANNED PAGE 2', 40, 120);
ctx.fillRect(60, 180, 140, 100);
const embedded = await doc.embedPng(scan.toBuffer('image/png'));
const scanPage = doc.addPage([600, 800]);
scanPage.drawImage(embedded, { x: 0, y: 0, width: 600, height: 800 });
scanPage.setRotation(degrees(90));
const sample = Buffer.from(await doc.save());
await writeFile(path.join(output, 'source.pdf'), sample);
execFileSync(path.resolve('src-tauri/resources/qpdf/qpdf.exe'), ['--encrypt', 'QA-user-pass', 'QA-owner-pass', '256', '--', path.join(output, 'source.pdf'), path.join(output, 'protected.pdf')]);
const protectedPdf = await readFile(path.join(output, 'protected.pdf'));
const longDoc = await PDFDocument.create();
for (let i = 0; i < 121; i++) longDoc.addPage([100, 100]);
const tooMany = Buffer.from(await longDoc.save());
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ headless: true, channel: process.env.TOOLKNIT_TEST_CHANNEL || 'msedge' });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const api = 'https://vision.example.test/v1/chat/completions';
const root = '#pdfAiMarkdownOverlay';
async function state(page, value) { await page.waitForSelector(`${root}[data-state="${value}"]`); }
async function open(page) { await page.locator('[data-tool="pdf-ai-markdown"]').first().evaluate(node => node.click()); await page.waitForSelector(`${root}.visible`); await state(page, 'empty'); }
async function upload(page, buffer = sample) { await page.locator('#pdfAiMarkdownFileInput').setInputFiles({ name: 'QA document.pdf', mimeType: 'application/pdf', buffer }); }
async function snapshot(page, name) {
  assert.equal(await page.locator(`${root} header`).evaluate(node => node.getBoundingClientRect().top), 0);
  assert.ok(await page.locator(`${root} main`).evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  assert.ok(await page.locator('#pdfAiMarkdownTitle').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'poster title must fit');
  const buttonColors = await page.locator('#pdfAiMarkdownCta').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
  assert.notEqual(buttonColors.color, buttonColors.background);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
}
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1401, height: 920 }, reducedMotion: 'reduce' });
    const errors = [], imageCalls = [];
    let mode = 'success', releaseHeld;
    await page.addInitScript(({ api, theme }) => {
      localStorage.setItem('ai_platform', 'custom'); localStorage.setItem('ai_custom_url', api);
      localStorage.setItem('ai_custom_model', 'synthetic-vision-model'); localStorage.setItem('ai_api_key', 'synthetic-browser-test-key');
      localStorage.setItem('toolknit-lang', theme === 'dark' ? 'en' : 'zh');
    }, { api, theme });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://api.github.com/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route(api, async route => {
      const body = route.request().postDataJSON();
      const parts = body.messages[1].content;
      let content;
      if (Array.isArray(parts)) {
        const number = Number(parts[0].text.match(/page (\d+)/)[1]); imageCalls.push(number);
        const image = await loadImage(parts[1].image_url.url);
        assert.ok(image.width > 0 && image.height > 0 && image.width * image.height <= 4500000);
        const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        assert.ok(context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 !== 3 && value < 100), 'page screenshot must contain source pixels');
        if (mode === 'held') await new Promise(resolve => { releaseHeld = resolve; });
        content = mode === 'partial' && number === 2 ? '{}' : JSON.stringify({ blocks: [
          { type: 'heading', level: 2, text: `Recognized page ${number}` },
          { type: 'paragraph', text: '中文 English <script>untrusted</script>' },
          { type: 'table', columns: ['A', 'B'], rows: [[0, 123]] },
          { type: 'formula', latex: 'a^2+b^2=c^2' }
        ], warnings: [] });
      } else content = JSON.stringify({ title: 'Synthetic document', summary: 'Reading guide includes both pages.', outline: ['Page 1', 'Page 2'] });
      try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }) }); } catch { /* cancelled request */ }
    });
    await page.goto(url); await open(page);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await snapshot(page, `${theme}-empty`);
    await upload(page); await state(page, 'selected');
    assert.equal(imageCalls.length, 0, 'upload must not contact AI');
    assert.ok((await page.locator('#pdfAiMarkdownProvider').textContent()).includes('vision.example.test'));
    await snapshot(page, `${theme}-selected`);
    mode = 'partial'; await page.locator('#pdfAiMarkdownProcess').click(); await state(page, 'partial');
    assert.deepEqual(imageCalls, [1, 2]);
    assert.equal(await page.locator('#pdfAiMarkdownRetry').isVisible(), true);
    await page.locator(`${root} [data-preview-page="1"]`).click();
    await snapshot(page, `${theme}-partial`);
    mode = 'success'; imageCalls.length = 0;
    await page.locator('#pdfAiMarkdownRetry').click(); await state(page, 'success');
    assert.deepEqual(imageCalls, [2]);
    assert.equal(await page.locator('#pdfAiMarkdownBlockCount').textContent(), '8');
    await snapshot(page, `${theme}-success`);
    for (const viewport of [{ width: 1280, height: 520 }, { width: 720, height: 820 }]) {
      await page.setViewportSize(viewport); await page.locator('#pdfAiMarkdownImport').scrollIntoViewIfNeeded();
      await snapshot(page, `${theme}-${viewport.width}-${viewport.height}`);
    }
    await page.locator('#pdfAiMarkdownImport').click(); await page.waitForSelector('#markdownEditorOverlay.visible');
    const editorText = await page.locator('#markdownEditorOverlay .cm-content').innerText();
    assert.match(editorText, /source-page: 1/); assert.match(editorText, /source-page: 2/); assert.match(editorText, /Reading guide includes both pages/);
    assert.equal(await page.locator('#markdownEditorOverlay script').count(), 0);
    await page.reload(); await open(page);
    await upload(page, protectedPdf); await state(page, 'error');
    assert.match(await page.locator('#pdfAiMarkdownStatusMessage').textContent(), /密码保护|password protected/);
    await upload(page, tooMany); await state(page, 'error');
    assert.equal(await page.locator('#pdfAiMarkdownProcess').isEnabled(), false);
    await upload(page, Buffer.from('%PDF-1.7\ncorrupt')); await state(page, 'error');
    await upload(page); await state(page, 'selected'); mode = 'held'; imageCalls.length = 0;
    await page.locator('#pdfAiMarkdownProcess').click(); await page.waitForFunction(() => document.querySelector('#pdfAiMarkdownProgressDetail').textContent.match(/识别|Analyzing/));
    for (let attempts = 0; !releaseHeld && attempts < 500; attempts++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(releaseHeld, 'request should start');
    await page.keyboard.press('Escape'); await state(page, 'selected');
    mode = 'success'; releaseHeld(); releaseHeld = null;
    await page.locator('#pdfAiMarkdownProcess').click(); await state(page, 'success');
    await page.locator('#pdfAiMarkdownReset').click(); await state(page, 'empty');
    await upload(page); await state(page, 'selected'); mode = 'held';
    await page.locator('#pdfAiMarkdownProcess').click();
    for (let attempts = 0; !releaseHeld && attempts < 500; attempts++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(releaseHeld, 'request should start');
    await page.locator('#pdfAiMarkdownBack').click(); await page.waitForSelector(`${root}.visible`, { state: 'hidden' });
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#pdfAiMarkdownOverlay'))), false);
    await open(page); mode = 'success'; releaseHeld();
    await page.waitForTimeout(250); await state(page, 'empty');
    assert.equal(await page.locator('#pdfAiMarkdownResult').isVisible(), false);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${theme}: real PDF rendering, empty/selected/partial/success, retry, import, limits, cancel, close/reopen and layout`);
  }
  const noKey = await browser.newPage();
  let unexpectedRequests = 0;
  await noKey.route(api, route => { unexpectedRequests++; return route.abort(); });
  await noKey.goto(url); await open(noKey); await upload(noKey); await state(noKey, 'selected');
  await noKey.locator('#pdfAiMarkdownProcess').click();
  await noKey.waitForFunction(() => !document.querySelector('#pdfAiMarkdownWarning').hidden);
  await state(noKey, 'selected');
  assert.equal(unexpectedRequests, 0);
  await noKey.close();
  console.log('PASS missing API key remains recoverable and sends no document');
} finally { await browser.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
