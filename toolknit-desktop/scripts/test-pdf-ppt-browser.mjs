import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';

// Optional external test runtime; it is never bundled with the application.
const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const PptxGen = require('pptxgenjs');
const output = path.resolve('tmp/pdf-ppt-regression');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {})
});
const pdf = await PDFDocument.create();
for (let index = 1; index <= 6; index++) {
  const page = pdf.addPage([595, 842]);
  page.drawText(`ToolKnit regression ${index}`, { x: 45, y: 740, size: 18 });
}
const pdfFile = { name: 'regression.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
const rotatedPdf = await PDFDocument.create();
const rotatedPage = rotatedPdf.addPage([595, 842]);
rotatedPage.setRotation(degrees(90));
rotatedPage.drawText('ToolKnit rotated insertion regression', { x: 45, y: 740, size: 18 });
const rotatedPdfFile = { name: 'rotated-regression.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await rotatedPdf.save()) };
const ppt = new PptxGen();
for (let index = 1; index <= 6; index++) {
  const slide = ppt.addSlide();
  slide.addText(`ToolKnit regression ${index}`, { x: 1, y: 1, w: 7, h: 1 });
  slide.addImage({ data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', x: 1, y: 3, w: 1, h: 1 });
}
const pptFile = { name: 'regression.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from(await ppt.write({ outputType: 'nodebuffer' })) };
const report = [];

async function openTool(name, category = 'PDF', height = 768) {
  const page = await browser.newPage({ viewport: { width: 1366, height } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.text().includes('Blocked aria-hidden')) errors.push(message.text());
  });
  await page.goto(process.env.TOOLKNIT_TEST_URL || 'http://127.0.0.1:1420/');
  await page.getByRole('button', { name: '打开工具库', exact: true }).click();
  await page.getByRole('button', { name: category, exact: true }).click();
  await page.locator('.tool-result-name').getByText(name, { exact: true }).click();
  await page.waitForFunction(() => Boolean(document.querySelector('.pdf-merge-overlay.visible')));
  return { page, errors };
}

async function finish(page, errors, item) {
  assert.deepEqual(errors, [], 'no runtime exceptions or focus warnings');
  await page.screenshot({ path: path.join(output, `${item}.png`) });
  report.push({ item, status: 'passed' });
  console.log(`PASS ${item}`);
  await page.close();
}

try {
  {
    const { page, errors } = await openTool('PDF 编辑器');
    await page.locator('#pdfEditorFileInput').setInputFiles(pdfFile);
    await page.waitForFunction(() => document.querySelector('#pdfEditorInsertRect')?.disabled === false);
    for (const [button, selector] of [['#pdfEditorInsertRect', '.pdf-editor-inserted-shape'], ['#pdfEditorInsertEllipse', '.pdf-editor-inserted-shape']]) {
      await page.locator(button).click();
      const canvas = page.locator('.pdf-editor-canvas-wrap');
      await canvas.click({ position: { x: 80, y: 100 } });
      assert.ok(await page.locator(selector).count() >= 1, `${button} must place a shape`);
    }
    await page.locator('#pdfEditorInsertText').click();
    await page.locator('#pdfEditorEditInput').fill('Inserted text');
    await page.locator('#pdfEditorEditSave').click();
    await page.locator('.pdf-editor-canvas-wrap').click({ position: { x: 180, y: 160 } });
    assert.ok(await page.locator('.pdf-editor-inserted-text').count() >= 1, 'insert text must place a component');
    await page.locator('#pdfEditorUndo').click();
    await page.waitForTimeout(240);
    assert.equal(await page.locator('.pdf-editor-inserted-text').count(), 0, 'undo must remove inserted text');
    await page.locator('#pdfEditorRedo').click();
    await page.waitForTimeout(240);
    assert.ok(await page.locator('.pdf-editor-inserted-text').count() >= 1, 'redo must restore inserted text');
    const download = page.waitForEvent('download');
    await page.locator('#pdfEditorExport').click();
    await (await download).path();
    await finish(page, errors, 'pdf-editor-insert-components');
  }
  {
    const { page, errors } = await openTool('PDF 编辑器');
    await page.locator('#pdfEditorFileInput').setInputFiles(rotatedPdfFile);
    await page.waitForFunction(() => document.querySelector('#pdfEditorInsertRect')?.disabled === false);
    await page.locator('#pdfEditorInsertRect').click();
    await page.locator('.pdf-editor-canvas-wrap').click({ position: { x: 80, y: 100 } });
    assert.ok(await page.locator('.pdf-editor-inserted-shape').count() >= 1, 'rotated PDF must accept shape insertion');
    await finish(page, errors, 'pdf-editor-rotated-insert');
  }
  for (const [mode, name, input, process] of [
    ['Split', 'PDF 文件拆分', null, 'pdfSplitProcessBtn'],
    ['Rotate', 'PDF 页面旋转', 'pdfRotateInput', 'pdfRotateProcessBtn'],
    ['ToImage', 'PDF 转图像', 'pdfToImageFileInput', null]
  ]) {
    const { page, errors } = await openTool(name);
    if (input) await page.locator(`#${input}`).setInputFiles(pdfFile);
    else {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#pdfSplitCta').click();
      await (await chooser).setFiles(pdfFile);
    }
    if (process) await page.locator(`#${process}`).click();
    const workspace = page.locator(`#pdf${mode}Workspace`);
    await page.waitForFunction(id => {
      const root = document.getElementById(id);
      return root?.classList.contains('visible') && !root.inert;
    }, `pdf${mode}Workspace`);
    const stage = workspace.locator('[data-wb-scroll]');
    assert.equal((await workspace.boundingBox()).y, 0, 'workspace covers the topbar');
    assert.equal(await workspace.evaluate(node => node.contains(document.elementFromPoint(12, 12))), true, 'workspace receives input above the home-return button');
    assert.equal(await page.locator(`#pdf${mode}Overlay`).evaluate(node => node.inert), true);
    await page.waitForFunction(id => document.querySelector(`#${id} [data-wb-canvas]`).width > 10, `pdf${mode}Workspace`);
    const beforeZoom = await workspace.locator('[data-wb-zoom="fit"]').textContent();
    await stage.hover(); await page.mouse.wheel(0, 400);
    await page.waitForFunction(({ id, beforeZoom }) => document.querySelector(`#${id} [data-wb-zoom="fit"]`).textContent !== beforeZoom, { id: `pdf${mode}Workspace`, beforeZoom });
    await page.waitForFunction(id => document.querySelector(`#${id} .pdf-editor-tile.is-selected .pdf-editor-tile-select`)?.getAttribute('aria-pressed') === 'true', `pdf${mode}Workspace`);
    if (mode === 'ToImage') {
      const pageToggles = workspace.locator('.pdf-editor-tile-select');
      await pageToggles.nth(5).click();
      await pageToggles.nth(4).click();
      await page.waitForFunction(() => document.querySelectorAll('#pdfToImageWorkspace .pdf-editor-tile.is-selected').length === 4);
      assert.equal(await page.locator('#pdfToImageExportHorizontalBtn').evaluate(node => node.classList.contains('is-available')), true);
      assert.equal(await page.locator('#pdfToImageExportGridBtn').evaluate(node => node.classList.contains('is-available')), true);
      const gridDownload = page.waitForEvent('download');
      await page.locator('#pdfToImageExportGridBtn').click();
      await (await gridDownload).path();
      await page.waitForSelector('#pdfToImageSuccessOverlay.visible');
      assert.equal(await page.locator('#pdfToImageSuccessCount').textContent(), '1');
      assert.equal(await page.locator('#pdfToImageSuccessOpenFolder').isVisible(), true, 'PDF To Image success dialog must show Open Folder');
      assert.equal(await page.locator('#pdfToImageSuccessOpenFolder').isEnabled(), true, 'PDF To Image Open Folder action must remain enabled in the result dialog');
      await page.locator('#pdfToImageSuccessOk').click();
    }
    await page.screenshot({ path: path.join(output, `pdf-${mode.toLowerCase()}-selection.png`) });
    await workspace.locator('button').first().focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(id => !document.getElementById(id).classList.contains('visible'), `pdf${mode}Workspace`);
    assert.equal(await page.locator(`#pdf${mode}Overlay`).evaluate(node => node.inert), false);
    assert.equal(await workspace.evaluate(node => node.contains(document.activeElement)), false);
    await finish(page, errors, `pdf-${mode.toLowerCase()}-workspace`);
  }

  for (const [mode, name, button] of [
    ['Pdf', 'PPT 转 PDF', 'pptToPdfExportBtn'],
    ['Image', 'PPT 转图片', 'pptToImageOpenWorkspaceBtn']
  ]) {
    const { page, errors } = await openTool(name, 'PPT', 620);
    await page.locator(`#pptTo${mode}FileInput`).setInputFiles(pptFile);
    await page.waitForFunction(id => !document.getElementById(id).disabled, button);
    assert.equal(await page.locator(`#pptTo${mode}Empty`).evaluate(node => getComputedStyle(node).display), 'none');
    const action = page.locator(`#${button}`);
    await action.scrollIntoViewIfNeeded();
    const box = await action.boundingBox();
    assert.ok(box.y >= 68 && box.y + box.height <= 620, 'export is reachable inside the viewport');
    assert.equal(await action.evaluate(node => getComputedStyle(node).color), 'rgb(5, 5, 6)');
    assert.equal(await action.evaluate(node => getComputedStyle(node).opacity), '1', 'export must be painted, not merely hit-testable');
    assert.equal(await action.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, 'export must not be covered by another layer');
    assert.doesNotMatch(await page.locator('body').innerText(), /\{images\}/);
    const summary = page.locator('.ppt-render-v2-summary');
    assert.equal(await summary.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    await finish(page, errors, `ppt-${mode.toLowerCase()}-loaded`);
  }

  for (const [prefix, name] of [
    ['pptImages', 'PPT 图片提取'], ['pptText', 'PPT AI 文本提取'], ['pptCompress', 'PPT 压缩']
  ]) {
    const { page, errors } = await openTool(name, 'PPT', 620);
    await page.locator(`#${prefix}FileInput`).setInputFiles(pptFile);
    await page.waitForFunction(id => !document.getElementById(id).disabled, `${prefix}ExportBtn`);
    assert.equal(await page.locator(`#${prefix}Empty`).evaluate(node => getComputedStyle(node).display), 'none');
    const action = page.locator(`#${prefix}ExportBtn`);
    await action.scrollIntoViewIfNeeded();
    assert.equal(await action.evaluate(node => getComputedStyle(node).opacity), '1');
    assert.equal(await page.locator(`#${prefix}Overlay`).evaluate(node => getComputedStyle(node).display), 'grid');
    await finish(page, errors, `${prefix}-loaded`);
  }

  {
    const { page, errors } = await openTool('PDF 文件压缩', 'PDF', 620);
    assert.equal(await page.locator('#pdfCompressRegularOptions').isVisible(), true);
    assert.equal(await page.locator('#pdfCompressTargetOptions').isVisible(), false);
    assert.deepEqual(await page.locator('#pdfCompressTargetSize option').evaluateAll(options => options.map(option => option.value)), ['5', '10', '15', '20', '50', 'custom']);
    await page.locator('#pdfCompressWorkflowOptions [data-workflow="target"]').click();
    await page.locator('#pdfCompressTargetSize').selectOption('10');
    assert.equal(await page.locator('#pdfCompressTargetSize').inputValue(), '10');
    assert.equal(await page.locator('#pdfCompressRegularOptions').isVisible(), false);
    assert.equal(await page.locator('#pdfCompressTargetOptions').isVisible(), true);
    await finish(page, errors, 'pdf-compress-target-options');
  }

  for (const name of ['AI 生成 PPT 大纲', 'AI 生成 PPT 草稿 / PPTX']) {
    const { page, errors } = await openTool(name, 'PPT', 620);
    const root = page.locator('.pdf-merge-overlay.visible').first();
    assert.equal(await root.evaluate(node => getComputedStyle(node).display), 'grid');
    assert.equal((await root.boundingBox()).height, 620);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(30);
    await finish(page, errors, `ppt-${name.includes('大纲') ? 'outline' : 'draft'}-empty`);
  }
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
