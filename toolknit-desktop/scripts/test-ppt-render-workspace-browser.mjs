import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createServer } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const PptxGen = require('pptxgenjs');
const output = path.resolve('tmp/ppt-render-workspace');
await mkdir(output, { recursive: true });
const deck = new PptxGen();
const pdf = await PDFDocument.create();
for (let index = 1; index <= 9; index += 1) {
  deck.addSlide().addText(`Slide ${index}`, { x: 1, y: 1, w: 6, h: 1 });
  pdf.addPage([320, 240]).drawText(`Slide ${index}`, { x: 30, y: 170, size: 24 });
}
const pptBytes = [...new Uint8Array(await deck.write({ outputType: 'nodebuffer' }))];
const pdfBytes = [...await pdf.save()];
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
const errors = [];
try {
  const page = await browser.newPage({ acceptDownloads: true, reducedMotion: 'reduce', viewport: { width: 1400, height: 887 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('Blocked aria-hidden')) errors.push(message.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('toolknit.theme.v3', 'light');
    localStorage.setItem('toolknit-lang', 'zh');
  });
  await page.goto(url);
  await page.waitForSelector('#homeToolGrid .tool-result-card');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    for (const [id, prefix] of [['ppt-to-pdf', 'pptToPdf'], ['ppt-to-image', 'pptToImage']]) {
      await page.locator(`.audio-list-item[data-tool="${id}"]`).evaluate(node => node.click());
      await page.waitForSelector(`#${prefix}Overlay.visible`);
      const colors = await page.locator(`#${prefix}Empty`).evaluate(node => {
        const icon = getComputedStyle(node.querySelector(':scope > svg'));
        const cta = node.closest('.ppt-file-workspace').querySelector('.ppt-file-cta');
        const button = getComputedStyle(cta);
        const glyph = getComputedStyle(cta.querySelector('svg'));
        const label = getComputedStyle(cta.querySelector('span'));
        return { iconBg: icon.backgroundColor, iconColor: icon.color, radius: icon.borderRadius,
          buttonBg: button.backgroundColor, buttonColor: button.color, glyphSize: glyph.width, labelColor: label.color };
      });
      if (theme === 'light') {
        assert.equal(colors.iconBg, 'rgb(23, 23, 23)');
        assert.equal(colors.iconColor, 'rgb(255, 255, 255)');
        assert.equal(colors.radius, '50%');
        assert.equal(colors.buttonBg, colors.iconBg);
        assert.equal(colors.buttonColor, colors.iconColor);
      }
      assert.ok(parseFloat(colors.glyphSize) >= 16);
      assert.equal(colors.labelColor, colors.buttonColor);
      await page.screenshot({ path: path.join(output, `${id}-${theme}.png`) });
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator(`#${prefix}Cta`).click();
      const chooser = await chooserPromise;
      await chooser.setFiles({ name: 'slides.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from(pptBytes) });
      await page.waitForSelector(`#${prefix}Empty`, { state: 'hidden' });
      await page.waitForSelector(`#${prefix}ProcessMask.visible`, { state: 'hidden' });
      await page.locator(`#${prefix}Back`).click();
      console.log(`PASS ${id} ${theme}: empty appearance and file selection`);
    }
  }

  // Stub only the native Office conversion. The PPT controller, handoff,
  // PDF selection, canvas composition and browser downloads remain real.
  await page.reload();
  await page.waitForSelector('#homeToolGrid .tool-result-card');
  await page.evaluate(async ({ pptBytes, pdfBytes }) => {
    const { mockIPC, mockWindows } = await import('/node_modules/@tauri-apps/api/mocks.js');
    const { initPptToImageTool } = await import('/src/features/ppt-render/tool.js');
    const { initPdfToImageTool } = await import('/src/features/pdf-to-image/tool.js');
    const { default: markup } = await import('/src/features/pdf-to-image/template.html?raw');
    const { t, onLangChange, applyTranslations } = await import('/src/i18n.js');
    const { createIcons, icons } = await import('/node_modules/lucide/dist/esm/lucide.js');
    const refreshIcons = () => createIcons({ icons });
    window.pptWorkspaceChecks = { cleanup: 0, transferred: false, notices: [] };
    mockWindows('main');
    mockIPC((command, args) => {
      if (command === 'plugin:dialog|open') return 'C:\\qa\\slides.pptx';
      if (command === 'read_file_bytes_limited') return pptBytes;
      if (command === 'convert_ppt_to_pdf') {
        if (!args.temporary) throw new Error('Preview must remain temporary');
        return { temporary: true, pageCount: 9, outputBytes: pdfBytes.length,
          outputFile: 'slides.pdf', outputPath: 'C:\\qa\\preview\\slides.pdf',
          outputDir: 'C:\\qa\\preview', manifestPath: 'C:\\qa\\preview\\manifest.json' };
      }
      if (command === 'discard_ppt_to_image_preview') { window.pptWorkspaceChecks.cleanup += 1; return; }
      throw new Error(`Unexpected test IPC: ${command}`);
    }, { shouldMockEvents: true });
    const template = document.createElement('template');
    template.innerHTML = markup;
    const pdfOverlay = template.content.firstElementChild;
    document.body.append(template.content);
    const pdfTool = initPdfToImageTool({ overlay: pdfOverlay, refreshIcons,
      getOutputDir: async () => '', displayFilesystemPath: value => value });
    const pptTool = initPptToImageTool({ overlay: document.getElementById('pptToImageOverlay'),
      isTauri: true, t, onLangChange, refreshIcons, getOutputDir: async () => 'C:\\qa',
      notify: message => window.pptWorkspaceChecks.notices.push(message),
      openLazyTool: async id => {
        if (id !== 'pdf-to-image') throw new Error('Must reuse the PDF workbench');
        return { raw: { openWithFile: async (file, options) => {
          const documentFile = new File([new Uint8Array(pdfBytes)], file.name, { type: 'application/pdf' });
          documentFile.outputCategory = file.outputCategory;
          window.pptWorkspaceChecks.category = file.outputCategory;
          window.pptWorkspaceChecks.transferred = await pdfTool.openWithFile(documentFile, options);
          return window.pptWorkspaceChecks.transferred;
        } } };
      } });
    window.pptWorkspaceTools = { pptTool, pdfTool };
    applyTranslations();
    await pptTool.open();
  }, { pptBytes, pdfBytes });
  await page.locator('#pptToImageCta').click();
  await page.waitForSelector('#pptToImageOpenWorkspaceBtn:not([hidden]):not([disabled])');
  await page.waitForSelector('#pptToImageProcessMask.visible', { state: 'hidden' });
  await page.locator('#pptToImageOpenWorkspaceBtn').click();
  await page.waitForFunction(() => window.pptWorkspaceChecks.transferred
    || window.pptWorkspaceChecks.notices.some(message => message.includes('Unexpected') || message.includes('失败')));
  assert.equal(await page.evaluate(() => window.pptWorkspaceChecks.transferred), true,
    JSON.stringify(await page.evaluate(() => window.pptWorkspaceChecks)));
  assert.equal(await page.evaluate(() => window.pptWorkspaceChecks.category), 'PPT_To_Image');
  const selections = page.locator('#pdfToImagePageStrip .pdf-editor-tile-select');
  assert.equal(await selections.count(), 9);
  async function selectCount(count) {
    for (let index = 0; index < 9; index += 1) {
      const tile = selections.nth(index);
      if ((await tile.getAttribute('aria-pressed') === 'true') !== (index < count)) await tile.click();
    }
  }
  for (const count of [1, 4, 5, 6, 9]) {
    await selectCount(count);
    assert.equal(await page.locator('#pdfToImageExportHorizontalBtn').isEnabled(), count >= 2 && count <= 5);
    assert.equal(await page.locator('#pdfToImageExportLongBtn').isEnabled(), count >= 2 && count <= 5);
    assert.equal(await page.locator('#pdfToImageExportGridBtn').isEnabled(), count === 4 || count === 9);
  }
  await selectCount(4);
  await page.screenshot({ path: path.join(output, 'ppt-shared-workbench.png') });
  for (const [suffix, ratio] of [['Long', 1 / 3], ['Horizontal', 16 / 3], ['Grid', 4 / 3]]) {
    const downloadPromise = page.waitForEvent('download');
    await page.locator(`#pdfToImageExport${suffix}Btn`).click();
    const download = await downloadPromise;
    const file = path.join(output, `${suffix}.png`);
    await download.saveAs(file);
    const bytes = await readFile(file);
    assert.ok(bytes.length > 100);
    assert.ok(Math.abs(bytes.readUInt32BE(16) / bytes.readUInt32BE(20) - ratio) < 0.03, `${suffix}: correct output aspect ratio`);
    await page.waitForSelector('#pdfToImageSuccessOverlay.visible');
    await page.locator('#pdfToImageSuccessOk').click();
    console.log(`PASS PPT handoff and actual ${suffix} PNG export`);
  }
  assert.equal(await page.evaluate(() => window.pptWorkspaceChecks.cleanup), 0);
  await page.evaluate(async () => {
    await window.pptWorkspaceTools.pdfTool.dispose();
    window.pptWorkspaceTools.pptTool.dispose();
  });
  assert.equal(await page.evaluate(() => window.pptWorkspaceChecks.cleanup), 1);
  assert.deepEqual(errors, []);
  console.log('PASS temporary PDF cleanup and no runtime/focus errors');
} finally { await browser.close(); await server.close(); }
