import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json')
  : import.meta.url);
const { chromium } = require('playwright');
const { createCanvas } = require('@napi-rs/canvas');
const PptxGen = require('pptxgenjs');
const outputDir = path.resolve('tmp', 'ppt-browser-lifecycle');
const browserUrl = process.env.TOOLKNIT_TEST_URL || 'http://127.0.0.1:1420/';

function createPngDataUrl() {
  const canvas = createCanvas(80, 60);
  const context = canvas.getContext('2d');
  context.fillStyle = '#123456';
  context.fillRect(0, 0, 80, 60);
  context.fillStyle = '#ffffff';
  context.font = '12px sans-serif';
  context.fillText('QA', 30, 35);
  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}

async function createPptx() {
  const ppt = new PptxGen();
  for (const [index, title] of ['lifecycle text', 'lifecycle image'].entries()) {
    const slide = ppt.addSlide();
    slide.addText(`${title} ${index + 1}`, { x: 1, y: 0.8, w: 6, h: 0.5, fontSize: 20 });
    slide.addText('ToolKnit browser export lifecycle regression', { x: 1, y: 1.7, w: 7, h: 0.4, fontSize: 12 });
    slide.addImage({ data: createPngDataUrl(), x: 1, y: 2.5, w: 1.5, h: 1.1 });
  }
  return {
    name: 'lifecycle-regression.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: Buffer.from(await ppt.write({ outputType: 'nodebuffer' }))
  };
}

async function openTool(page, name) {
  await page.goto(browserUrl);
  await page.getByRole('button', { name: '打开工具库', exact: true }).click();
  await page.getByRole('button', { name: 'PPT', exact: true }).click();
  await page.locator('.tool-result-name').getByText(name, { exact: true }).click();
  await page.waitForFunction(() => Boolean(document.querySelector('.pdf-merge-overlay.visible')));
}

async function assertExportUrlReleased(page, { toolName, overlaySelector, inputSelector, exportSelector, backSelector, processSelector, successOkSelector }, pptxFile) {
  await openTool(page, toolName);
  await page.locator(inputSelector).setInputFiles(pptxFile);
  await page.waitForFunction(selector => {
    const node = document.querySelector(selector);
    return Boolean(node && !node.disabled && !node.hidden);
  }, exportSelector);
  await page.waitForFunction(selector => !document.querySelector(selector)?.classList.contains('visible'), processSelector);

  const createdBefore = await page.evaluate(() => window.__tkCreatedObjectUrls.length);
  const download = page.waitForEvent('download', { timeout: 3_000 }).catch(() => null);
  await page.locator(exportSelector).click();
  await page.waitForFunction(count => window.__tkCreatedObjectUrls.length > count, createdBefore);
  const downloadEvent = await download;
  if (downloadEvent) await downloadEvent.path();
  const exportUrl = await page.evaluate(count => window.__tkCreatedObjectUrls[count], createdBefore);
  assert.ok(exportUrl, `${toolName} must create a browser export URL`);

  const successOk = page.locator(successOkSelector);
  if (await successOk.isVisible().catch(() => false)) await successOk.click();
  await page.locator(backSelector).click();
  await page.waitForFunction(selector => !document.querySelector(selector)?.classList.contains('visible'), overlaySelector);
  await page.waitForFunction(url => window.__tkRevokedObjectUrls.includes(url), exportUrl, { timeout: 600 });
  assert.equal(
    await page.evaluate(url => window.__tkRevokedObjectUrls.includes(url), exportUrl),
    true,
    `${toolName} export URL must be revoked when the tool closes`
  );
}

await mkdir(outputDir, { recursive: true });
const pptxFile = await createPptx();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {})
});
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1366, height: 768 } });
page.on('pageerror', error => console.error(`[browser pageerror] ${error.message}`));
page.on('console', message => {
  if (['error', 'warning'].includes(message.type())) console.error(`[browser ${message.type()}] ${message.text()}`);
});
await page.addInitScript(() => {
  const nativeCreate = URL.createObjectURL.bind(URL);
  const nativeRevoke = URL.revokeObjectURL.bind(URL);
  window.__tkCreatedObjectUrls = [];
  window.__tkRevokedObjectUrls = [];
  URL.createObjectURL = blob => {
    const url = nativeCreate(blob);
    window.__tkCreatedObjectUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = url => {
    window.__tkRevokedObjectUrls.push(String(url));
    return nativeRevoke(url);
  };
});

try {
  await assertExportUrlReleased(page, {
    toolName: 'PPT 图片提取',
    overlaySelector: '#pptImagesOverlay',
    inputSelector: '#pptImagesFileInput',
    exportSelector: '#pptImagesExportBtn',
    backSelector: '#pptImagesBack',
    processSelector: '#pptImagesProcessMask',
    successOkSelector: '#pptImagesSuccessOk'
  }, pptxFile);
  await assertExportUrlReleased(page, {
    toolName: 'PPT AI 文本提取',
    overlaySelector: '#pptTextOverlay',
    inputSelector: '#pptTextFileInput',
    exportSelector: '#pptTextExportBtn',
    backSelector: '#pptTextBack',
    processSelector: '#pptTextProcessMask',
    successOkSelector: '#pptTextSuccessOk'
  }, pptxFile);
  await assertExportUrlReleased(page, {
    toolName: 'PPT 压缩',
    overlaySelector: '#pptCompressOverlay',
    inputSelector: '#pptCompressFileInput',
    exportSelector: '#pptCompressExportBtn',
    backSelector: '#pptCompressBack',
    processSelector: '#pptCompressProcessMask',
    successOkSelector: '#pptCompressSuccessOk'
  }, pptxFile);
  await page.screenshot({ path: path.join(outputDir, 'released-after-close.png') });
  console.log('PPT browser export lifecycle checks passed');
} finally {
  await page.close();
  await browser.close();
}
