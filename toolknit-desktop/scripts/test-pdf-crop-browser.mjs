import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/pdf-crop-browser');
await mkdir(output, { recursive: true });

async function createFixture() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageIndex = 0; pageIndex < 24; pageIndex += 1) {
    const page = document.addPage([612, 792]);
    page.drawText(`ToolKnit PDF Crop performance page ${pageIndex + 1}`, {
      x: 48,
      y: 720,
      size: 18,
      font,
      color: rgb(0.1, 0.1, 0.1)
    });
    for (let line = 0; line < 18; line += 1) {
      page.drawText(`Local regression fixture line ${line + 1}`, {
        x: 48,
        y: 680 - line * 30,
        size: 11,
        font,
        color: rgb(0.2, 0.2, 0.2)
      });
    }
  }
  return {
    name: 'pdf-crop-24-page-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await document.save())
  };
}

const fixture = await createFixture();
const server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {})
});
const report = { layouts: [], thumbnailPause: null, performance: null, exports: [], errors: [] };

function frameStats(timestamps) {
  const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]);
  const averageMs = intervals.reduce((sum, value) => sum + value, 0) / Math.max(1, intervals.length);
  const sorted = [...intervals].sort((left, right) => left - right);
  const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
  return { frames: timestamps.length, averageMs, p95Ms, fps: 1000 / Math.max(0.001, averageMs) };
}

try {
  const url = server.resolvedUrls.local[0];
  const qcmsResponse = await fetch(`${url}assets/pdfjs/wasm/qcms_bg.wasm`);
  assert.equal(qcmsResponse.status, 200);
  assert.match(qcmsResponse.headers.get('content-type') || '', /application\/wasm/);
  assert.equal((await qcmsResponse.arrayBuffer()).byteLength, 96589);

  const context = await browser.newContext({ viewport: { width: 1400, height: 887 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin
    ? route.continue() : route.fulfill({ status: 200, body: '{}', contentType: 'application/json' }));
  await context.addInitScript(() => {
    localStorage.setItem('toolknit-lang', 'zh');
    localStorage.setItem('toolknit.theme.v3', 'dark');
  });
  const monitorPage = page => {
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const detail = message.text();
      if (message.type() === 'error' || /ICCBased color space|qcms|#instantiateWasm/i.test(detail)) {
        report.errors.push(detail);
      }
    });
  };
  const openCropFixture = async page => {
    await page.goto(url);
    await page.waitForSelector('#homeToolGrid .tool-result-card');
    await page.evaluate(() => document.querySelector('.audio-list-item[data-tool="pdf-crop"]')?.click());
    await page.waitForSelector('#pdfCropOverlay.visible');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-tk-page-transition-veil]')).visibility === 'hidden');
    await page.locator('#pdfCropFileInput').setInputFiles(fixture);
    await page.waitForFunction(() => document.querySelectorAll('#pdfCropFilmstrip [data-page-index]').length === 24
      && !document.querySelector('#pdfCropCanvasWrap').hidden
      && !document.querySelector('#pdfCropProcessMask').classList.contains('visible'));
  };

  const stressPage = await context.newPage();
  monitorPage(stressPage);
  const cdp = await context.newCDPSession(stressPage);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await openCropFixture(stressPage);
  await stressPage.evaluate(() => {
    const layer = document.querySelector('#pdfCropInteractionLayer');
    const filmstrip = document.querySelector('#pdfCropFilmstrip');
    const data = { mutations: 0 };
    const observer = new MutationObserver(records => {
      if (layer.classList.contains('is-interacting')) data.mutations += records.length;
    });
    observer.observe(filmstrip, { attributes: true, childList: true, subtree: true });
    window.__finishPdfCropThumbnailPause = () => {
      observer.disconnect();
      return { ...data };
    };
  });
  const earlyInteractionBox = await stressPage.locator('#pdfCropInteractionLayer').boundingBox();
  assert.ok(earlyInteractionBox?.width > 200 && earlyInteractionBox?.height > 200);
  await stressPage.mouse.move(earlyInteractionBox.x + earlyInteractionBox.width * 0.14, earlyInteractionBox.y + earlyInteractionBox.height * 0.14);
  await stressPage.mouse.down();
  await stressPage.waitForFunction(() => document.querySelector('#pdfCropInteractionLayer').classList.contains('is-interacting'));
  const pendingDuringDrag = await stressPage.locator('#pdfCropFilmstrip').evaluate(strip => (
    [...strip.querySelectorAll('[data-page-index]')].filter(item => item.dataset.thumbState !== 'ready').length
  ));
  assert.ok(pendingDuringDrag > 0, 'the stress drag must overlap unfinished thumbnail work');
  await stressPage.waitForTimeout(180);
  await stressPage.mouse.move(earlyInteractionBox.x + earlyInteractionBox.width * 0.82, earlyInteractionBox.y + earlyInteractionBox.height * 0.82, { steps: 8 });
  await stressPage.waitForTimeout(120);
  await stressPage.mouse.up();
  const thumbnailPause = await stressPage.evaluate(() => window.__finishPdfCropThumbnailPause());
  report.thumbnailPause = { pendingDuringDrag, ...thumbnailPause };
  assert.equal(thumbnailPause.mutations, 0, 'active thumbnail renders must not mutate the filmstrip while cropping');
  await stressPage.close();

  const page = await context.newPage();
  monitorPage(page);
  await openCropFixture(page);

  async function setTheme(theme) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForTimeout(60);
  }

  async function checkLayout(theme, width, height) {
    await setTheme(theme);
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(80);
    const metrics = await page.locator('#pdfCropOverlay').evaluate(overlay => {
      const thumbs = [...overlay.querySelectorAll('.pdf-crop-page-thumb')];
      const actionButtons = [...overlay.querySelectorAll('.pdf-crop-export-actions .pdf-crop-export')];
      const rect = node => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
      const inside = (child, parent) => child.left >= parent.left - 0.5 && child.right <= parent.right + 0.5
        && child.top >= parent.top - 0.5 && child.bottom <= parent.bottom + 0.5;
      return {
        thumbs: thumbs.map(node => {
          const box = rect(node);
          const copy = rect(node.querySelector('.pdf-crop-page-thumb-copy'));
          const title = rect(node.querySelector('b'));
          const status = rect(node.querySelector('small'));
          return {
            width: box.width,
            overflow: getComputedStyle(node).overflowX,
            contained: inside(copy, box) && inside(title, box) && inside(status, box)
          };
        }),
        actions: actionButtons.map(node => {
          const box = rect(node);
          const label = rect(node.querySelector('span'));
          return { width: box.width, height: box.height, contained: inside(label, box) };
        })
      };
    });
    const expectedWidth = height <= 520 ? 110 : 132;
    assert.equal(metrics.thumbs.length, 24);
    assert.ok(metrics.thumbs.every(item => Math.abs(item.width - expectedWidth) <= 0.5));
    assert.ok(metrics.thumbs.every(item => item.overflow === 'hidden' && item.contained));
    assert.ok(metrics.actions.every(item => item.width > 0 && item.height >= 48 && item.contained));
    report.layouts.push({ theme, width, height, expectedWidth, actionWidths: metrics.actions.map(item => item.width) });
  }

  for (const theme of ['dark', 'light']) {
    await checkLayout(theme, 1400, 887);
    await checkLayout(theme, 720, 480);
    const disabled = await page.locator('.pdf-crop-export-actions').evaluate(actions => [...actions.querySelectorAll('button')].map(node => {
      const style = getComputedStyle(node);
      return { disabled: node.disabled, background: style.backgroundColor, color: style.color };
    }));
    assert.ok(disabled.every(item => item.disabled));
    assert.equal(disabled[0].background, disabled[1].background);
  }

  await page.setViewportSize({ width: 1400, height: 887 });
  await setTheme('dark');
  await page.locator('#pdfCropFilmstrip').evaluate(async strip => {
    for (let left = 0; left <= strip.scrollWidth; left += Math.max(120, strip.clientWidth - 80)) {
      strip.scrollLeft = left;
      await new Promise(resolve => setTimeout(resolve, 90));
    }
    strip.scrollLeft = 0;
  });
  await page.waitForFunction(() => [...document.querySelectorAll('#pdfCropFilmstrip [data-page-index]')]
    .every(node => node.dataset.thumbState === 'ready'));

  async function drag(box, from, to, steps = 16, delay = 0) {
    await page.mouse.move(box.x + from.x * box.width, box.y + from.y * box.height);
    await page.mouse.down();
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      await page.mouse.move(
        box.x + (from.x + (to.x - from.x) * ratio) * box.width,
        box.y + (from.y + (to.y - from.y) * ratio) * box.height
      );
      if (delay) await page.waitForTimeout(delay);
    }
    await page.mouse.up();
    await page.waitForTimeout(80);
  }

  const interactionBox = await page.locator('#pdfCropInteractionLayer').boundingBox();
  assert.ok(interactionBox?.width > 200 && interactionBox?.height > 200);
  await drag(interactionBox, { x: 0.12, y: 0.12 }, { x: 0.82, y: 0.82 });
  await page.waitForFunction(() => document.querySelectorAll('#pdfCropFilmstrip .has-crop').length === 24);
  assert.equal(await page.locator('#pdfCropExportCurrent').isEnabled(), true);
  assert.equal(await page.locator('#pdfCropExport').isEnabled(), true);

  await page.locator('#pdfCropFilmstrip [data-page-index="1"]').click();
  await page.waitForFunction(() => document.querySelector('#pdfCropPageIndicator')?.textContent.includes('2 / 24'));
  await page.locator('#pdfCropResetPage').click();
  assert.equal(await page.locator('#pdfCropExportCurrent').isDisabled(), true);
  assert.equal(await page.locator('#pdfCropExport').isEnabled(), true);
  await page.locator('[data-crop-scope="current"]').click();
  await drag(await page.locator('#pdfCropInteractionLayer').boundingBox(), { x: 0.18, y: 0.16 }, { x: 0.78, y: 0.78 });
  assert.equal(await page.locator('#pdfCropExportCurrent').isEnabled(), true);
  await page.locator('[data-crop-scope="all"]').click();

  await page.evaluate(() => {
    const layer = document.querySelector('#pdfCropInteractionLayer');
    const selection = document.querySelector('#pdfCropSelection');
    const filmstrip = document.querySelector('#pdfCropFilmstrip');
    const data = { pointerMoves: 0, styleBatches: 0, styleRecords: 0, thumbMutations: 0, timestamps: [], done: false };
    const styleObserver = new MutationObserver(records => {
      if (!layer.classList.contains('is-interacting')) return;
      data.styleBatches += 1;
      data.styleRecords += records.length;
    });
    const thumbObserver = new MutationObserver(records => {
      if (layer.classList.contains('is-interacting')) data.thumbMutations += records.length;
    });
    const onPointerMove = () => {
      if (layer.classList.contains('is-interacting')) data.pointerMoves += 1;
    };
    styleObserver.observe(selection, { attributes: true, attributeFilter: ['style'] });
    thumbObserver.observe(filmstrip, { attributes: true, childList: true, subtree: true });
    document.addEventListener('pointermove', onPointerMove, true);
    const sample = timestamp => {
      if (data.done) return;
      if (layer.classList.contains('is-interacting')) data.timestamps.push(timestamp);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.__finishPdfCropPerformance = () => {
      data.done = true;
      styleObserver.disconnect();
      thumbObserver.disconnect();
      document.removeEventListener('pointermove', onPointerMove, true);
      return { ...data };
    };
  });

  const selectionBox = await page.locator('#pdfCropSelection').boundingBox();
  assert.ok(selectionBox?.width > 120 && selectionBox?.height > 120);
  await drag(selectionBox, { x: 0.5, y: 0.5 }, { x: 0.62, y: 0.58 }, 96, 6);
  const sampling = await page.evaluate(() => window.__finishPdfCropPerformance());
  const timing = frameStats(sampling.timestamps);
  report.performance = { ...sampling, ...timing };
  assert.ok(sampling.pointerMoves >= 90, `expected dense pointer input, received ${sampling.pointerMoves}`);
  assert.ok(sampling.styleBatches > 10 && sampling.styleBatches <= timing.frames + 2,
    `visual writes must be frame-coalesced: ${JSON.stringify(report.performance)}`);
  assert.equal(sampling.thumbMutations, 0, 'thumbnail state must not update during pointer movement');
  assert.ok(timing.frames >= 20 && timing.fps >= 48 && timing.p95Ms <= 28,
    `crop dragging should stay near a 60 Hz frame budget: ${JSON.stringify(report.performance)}`);
  assert.equal(await page.locator('#pdfCropFilmstrip .has-crop').count(), 24);

  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    const styles = await page.locator('.pdf-crop-export-actions').evaluate(actions => [...actions.querySelectorAll('button')].map(node => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, color: style.color, border: style.borderColor };
    }));
    assert.notEqual(styles[0].background, styles[1].background);
    assert.notEqual(styles[0].color, styles[1].color);
    await page.screenshot({ path: path.join(output, `${theme}-24-pages.png`) });
  }

  await setTheme('light');
  const currentDownloadPromise = page.waitForEvent('download');
  await page.locator('#pdfCropExportCurrent').click();
  const currentDownload = await currentDownloadPromise;
  const currentPath = await currentDownload.path();
  const currentPdf = await PDFDocument.load(await readFile(currentPath));
  assert.equal(currentPdf.getPageCount(), 1);
  assert.ok(currentPdf.getPage(0).getWidth() < 612 && currentPdf.getPage(0).getHeight() < 792);
  assert.match(currentDownload.suggestedFilename(), /_page_002\.pdf$/);
  await page.waitForSelector('#pdfCropSuccessOverlay.visible');
  assert.match(await page.locator('#pdfCropSuccessMeta').innerText(), /第 2 页/);
  report.exports.push({ target: 'current', pages: 1, fileName: currentDownload.suggestedFilename() });
  await page.locator('#pdfCropSuccessOk').click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'pdfCropExportCurrent');

  const allDownloadPromise = page.waitForEvent('download');
  await page.locator('#pdfCropExport').click();
  const allDownload = await allDownloadPromise;
  const allPath = await allDownload.path();
  const allPdf = await PDFDocument.load(await readFile(allPath));
  assert.equal(allPdf.getPageCount(), 24);
  assert.match(allDownload.suggestedFilename(), /_cropped\.pdf$/);
  await page.waitForSelector('#pdfCropSuccessOverlay.visible');
  assert.match(await page.locator('#pdfCropSuccessMeta').innerText(), /24 页/);
  report.exports.push({ target: 'all', pages: 24, fileName: allDownload.suggestedFilename() });
  await page.locator('#pdfCropSuccessOk').click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'pdfCropExport');

  assert.deepEqual(report.errors, []);
  await context.close();
  console.log(`PDF Crop browser regression passed: ${timing.fps.toFixed(1)} FPS, p95 ${timing.p95Ms.toFixed(1)}ms`);
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
}
