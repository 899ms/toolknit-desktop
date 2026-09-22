import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json')
  : import.meta.url);
const { chromium } = require('playwright');
const { createCanvas } = require('@napi-rs/canvas');
const JSZip = require('jszip');

const browserUrl = process.env.TOOLKNIT_TEST_URL || 'http://127.0.0.1:1420/';
const reportPath = path.resolve('tmp', 'ppt-content-matrix-report.json');
const evidenceDir = path.resolve('tmp', 'v3-overnight', 'ppt-content-matrix');

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function paragraph(text, { bullet = false } = {}) {
  const marker = bullet ? '<a:pPr><a:buChar char="•"/></a:pPr>' : '';
  return `<a:p>${marker}<a:r><a:t>${xmlEscape(text)}</a:t></a:r></a:p>`;
}

function shape(name, texts, { placeholder = '' } = {}) {
  const placeholderXml = placeholder ? `<p:ph type="${xmlEscape(placeholder)}"/>` : '';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${Math.max(2, name.length + 2)}" name="${xmlEscape(name)}"/><p:nvPr>${placeholderXml}</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/>${texts.map(value => paragraph(value, { bullet: placeholder === 'body' })).join('')}</p:txBody></p:sp>`;
}

function slideXml({ title = '', body = [], imageIds = [], empty = false } = {}) {
  const shapes = [];
  if (title) shapes.push(shape('Title', [title], { placeholder: 'title' }));
  for (const [index, value] of body.entries()) shapes.push(shape(`Body ${index + 1}`, [value], { placeholder: 'body' }));
  const pictures = imageIds.map(id => `<p:pic><p:nvPicPr><p:cNvPr id="${id.length + 200}" name="Picture ${id}"/><p:cNvPrPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${xmlEscape(id)}"/></p:blipFill></p:pic>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree>${empty ? '' : shapes.join('')}${pictures}</p:spTree></p:cSld></p:sld>`;
}

function notesXml(text) {
  return `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shape('Notes', [text], { placeholder: 'body' })}</p:spTree></p:cSld></p:notes>`;
}

function slideRels(relations) {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations.map(({ id, type, target }) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`;
}

function contentTypes(mediaExtensions = ['png', 'jpg']) {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...mediaExtensions.map(extension => `<Default Extension="${extension}" ContentType="image/${extension === 'jpg' ? 'jpeg' : extension}"/>`)
  ];
  return `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`;
}

function imageBytes(width, height, { transparent = false, entropy = false, format = 'png' } = {}) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (entropy) {
    const image = context.createImageData(width, height);
    let state = 0x12345678;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      state = Math.imul(1664525, state) + 1013904223 | 0;
      image.data[offset] = state & 0xff;
      image.data[offset + 1] = (state >>> 8) & 0xff;
      image.data[offset + 2] = (state >>> 16) & 0xff;
      image.data[offset + 3] = transparent ? ((state >>> 24) & 0xff) : 0xff;
    }
    context.putImageData(image, 0, 0);
    return canvas.toBuffer(format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.94);
  }
  if (!transparent) {
    context.fillStyle = '#17324d';
    context.fillRect(0, 0, width, height);
  }
  context.fillStyle = transparent ? 'rgba(42, 135, 190, 0.72)' : '#f4c95d';
  context.fillRect(12, 12, Math.max(20, width - 24), Math.max(20, height - 24));
  context.fillStyle = transparent ? 'rgba(255, 255, 255, 0.85)' : '#0b1320';
  context.font = `${Math.max(16, Math.round(width / 18))}px sans-serif`;
  context.fillText('ToolKnit QA', 24, Math.max(36, Math.round(height / 2)));
  return canvas.toBuffer('image/png');
}

function packageXml(slideCount) {
  const slideIds = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('');
  const rels = Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('');
  return {
    presentation: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slideIds}</p:sldIdLst></p:presentation>`,
    rels: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
  };
}

async function createRichPptx() {
  const zip = new JSZip();
  const slideCount = 4;
  const packageParts = packageXml(slideCount);
  zip.file('[Content_Types].xml', contentTypes(['png', 'jpg']));
  zip.file('ppt/presentation.xml', packageParts.presentation);
  zip.file('ppt/_rels/presentation.xml.rels', packageParts.rels);

  const opaque = imageBytes(1280, 900, { entropy: true, format: 'png' });
  const transparent = imageBytes(420, 260, { transparent: true });
  const jpg = imageBytes(1500, 1000, { entropy: true, format: 'jpg' });
  zip.file('ppt/media/image1.png', opaque);
  zip.file('ppt/media/image2.png', opaque);
  zip.file('ppt/media/image3.png', transparent);
  zip.file('ppt/media/image4.jpg', jpg);
  zip.file('ppt/media/unreferenced.png', imageBytes(120, 80));

  const slides = [
    { title: '\u53d1\u5e03\u8ba1\u5212', body: ['\u7b2c\u4e00\u9636\u6bb5\u5b8c\u6210\u6587\u672c\u63d0\u53d6\u3002', 'Local-first \u5904\u7406\u4e0d\u4e0a\u4f20\u539f\u6587\u4ef6\u3002'], imageIds: ['rId1'] },
    { title: '\u89c6\u89c9\u8d44\u4ea7', body: ['\u900f\u660e\u56fe\u548c\u91cd\u590d\u56fe\u7247\u7528\u4e8e\u63d0\u53d6\u56de\u5f52\u3002'], imageIds: ['rId2', 'rId3'] },
    { title: '\u957f\u6587\u672c\u9875', body: ['Long text '.repeat(35), 'This slide checks wrapping, page filters, and export serialization.'], imageIds: ['rId4'] },
    { title: '', body: [], imageIds: ['rIdMissing'], empty: true }
  ];
  for (const [index, slide] of slides.entries()) {
    const slideNumber = index + 1;
    zip.file(`ppt/slides/slide${slideNumber}.xml`, slideXml(slide));
    const relations = [];
    for (const id of slide.imageIds) {
      const target = id === 'rId1' ? '../media/image1.png'
        : id === 'rId2' ? '../media/image2.png'
          : id === 'rId3' ? '../media/image3.png'
            : id === 'rId4' ? '../media/image4.jpg'
              : '../media/missing.png';
      relations.push({ id, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target });
    }
    if (slideNumber === 1) {
      relations.push({ id: 'rIdNotes', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide', target: '../notesSlides/notesSlide1.xml' });
      zip.file('ppt/notesSlides/notesSlide1.xml', notesXml('\u5907\u6ce8\uff1a\u6f14\u793a\u6587\u672c\u63d0\u53d6\u548c\u91cd\u65b0\u5bfc\u51fa\u3002'));
    }
    zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, slideRels(relations));
  }
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }));
}

async function createNoGainPptx() {
  const zip = new JSZip();
  const packageParts = packageXml(1);
  zip.file('[Content_Types].xml', contentTypes(['png']));
  zip.file('ppt/presentation.xml', packageParts.presentation);
  zip.file('ppt/_rels/presentation.xml.rels', packageParts.rels);
  zip.file('ppt/slides/slide1.xml', slideXml({ title: '\u5df2\u4f18\u5316\u6f14\u793a', body: ['\u6d4b\u8bd5\u65e0\u6536\u76ca\u538b\u7f29\u7684\u6709\u6548\u8f93\u5165\u3002'], empty: false }));
  zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels([]));
  const random = Buffer.alloc(240 * 1024);
  let state = 0x7f4a7c15;
  for (let index = 0; index < random.length; index += 1) {
    state = Math.imul(1103515245, state) + 12345 | 0;
    random[index] = state & 0xff;
  }
  zip.file('docProps/custom.bin', random);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
}

function outlinePayload(slides = 3) {
  return {
    ready: true,
    title: 'ToolKnit QA Outline',
    subtitle: 'Local content matrix',
    deck_type: 'product-launch',
    audience: 'QA users',
    purpose: 'Verify PPT outline and draft workflows.',
    fact_bank: {
      known_facts: ['The source remains local.'],
      evidence: ['Synthetic browser fixture.'],
      assumptions: [],
      missing_facts: [],
      no_invention: ['Do not claim unverified output.']
    },
    narrative: { central_takeaway: 'PPT output keeps a stable local contract.' },
    design: { style: 'minimal', visual_system: 'clear', color_hint: 'black and white', font_hint: 'sans-serif' },
    slides: Array.from({ length: slides }, (_, index) => ({
      page: index + 1,
      role: index === 0 ? 'cover' : index + 1 === slides ? 'closing' : 'content',
      type: index === 0 ? 'title' : 'content',
      title: `QA slide ${index + 1}`,
      claim: `Stable claim ${index + 1}`,
      body: [`Bullet ${index + 1}-1`, `Bullet ${index + 1}-2`],
      visual_suggestion: 'Synthetic visual placeholder',
      layout_intent: { kind: 'text-focus', density: 'medium', text_blocks: 2, media_slots: 0, chart: 'none', visual_focus: 'QA' },
      speaker_note: 'Synthetic fixture note',
      transition: 'Continue',
      data_needed: []
    })),
    quality_check: { self_check: { score: 94, passed: true, strengths: ['Stable'], issues: [] }, missing_info: [], risks: [], next_steps: [] }
  };
}

function filePayload(name, buffer, mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
  return { name, mimeType, buffer };
}

async function readDownload(download) {
  const filePath = await download.path();
  assert.ok(filePath, `download path must exist for ${download.suggestedFilename()}`);
  return readFile(filePath);
}

async function openTool(page, name, category = 'PPT') {
  await page.goto(browserUrl);
  await page.getByRole('button', { name: '\u6253\u5f00\u5de5\u5177\u5e93', exact: true }).click();
  await page.getByRole('button', { name: category, exact: true }).click();
  await page.locator('.tool-result-name').getByText(name, { exact: true }).click();
  await page.waitForFunction(() => Boolean(document.querySelector('.pdf-merge-overlay.visible')));
}

async function closeTool(page, selector, backSelector) {
  await page.locator(backSelector).click();
  await page.waitForFunction(value => !document.querySelector(value)?.classList.contains('visible'), selector);
}

async function waitForAlert(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.app-toast[role="alert"]')].some(node => {
    const style = getComputedStyle(node);
    return node.isConnected
      && !node.hidden
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Boolean(node.textContent?.trim());
  }), null, { timeout: 8_000 });
}

async function zipNames(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  return Object.keys(zip.files).sort();
}

function installAiRoute(page, state) {
  return page.route('**/chat/completions', async route => {
    if (state.mode === 'hang') {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      if (!route.request().isNavigationRequest()) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(outlinePayload()) } }] }) }).catch(() => {});
      }
      return;
    }
    if (state.mode === 'fail') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return;
    }
    const body = route.request().postDataJSON?.() || {};
    const messages = JSON.stringify(body.messages || []);
    const content = messages.includes('PPT') || messages.includes('ppt')
      ? JSON.stringify(outlinePayload(3))
      : '# QA AI result\n\n- Local mock response';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const richPptx = await createRichPptx();
  const noGainPptx = await createNoGainPptx();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {})
  });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1366, height: 768 } });
  await context.addInitScript(() => {
    localStorage.setItem('ai_api_key', 'toolknit-local-ppt-matrix-key');
    const nativeCreate = URL.createObjectURL.bind(URL);
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    window.__pptMatrixCreatedUrls = [];
    window.__pptMatrixRevokedUrls = [];
    URL.createObjectURL = blob => {
      const url = nativeCreate(blob);
      window.__pptMatrixCreatedUrls.push(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      window.__pptMatrixRevokedUrls.push(String(url));
      return nativeRevoke(url);
    };
  });
  const page = await context.newPage();
  const routeState = { mode: 'success' };
  await installAiRoute(page, routeState);
  const report = {
    generatedAt: new Date().toISOString(),
    fixture: { richBytes: richPptx.byteLength, noGainBytes: noGainPptx.byteLength },
    images: null,
    text: null,
    compress: null,
    outline: null,
    draft: null,
    console: [],
    status: 'running'
  };
  const consoleMessages = [];
  page.on('pageerror', error => consoleMessages.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) consoleMessages.push(`${message.type()}: ${message.text()}`);
  });

  try {
    await openTool(page, 'PPT \u56fe\u7247\u63d0\u53d6');
    await page.locator('#pptImagesFileInput').setInputFiles(filePayload('matrix-rich.pptx', richPptx));
    await page.waitForFunction(() => document.querySelector('#pptImagesResults')?.hidden === false && document.querySelectorAll('#pptImagesList .ppt-images-item').length === 5, null, { timeout: 30_000 });
    const imageCount = await page.locator('#pptImagesList .ppt-images-item').count();
    const duplicateCount = await page.locator('#pptImagesList .ppt-images-item.is-duplicate').count();
    assert.equal(imageCount, 5);
    assert.equal(duplicateCount, 1);
    assert.match(await page.locator('#pptImagesSummary').innerText(), /5/);
    await page.locator('#pptImagesSkipDuplicates').check();
    assert.equal(await page.locator('#pptImagesList .ppt-images-item.is-duplicate .ppt-images-check').isDisabled(), true);
    await page.locator('#pptImagesClearSelection').click();
    assert.equal(await page.locator('#pptImagesExportBtn').isHidden(), true);
    await page.locator('#pptImagesSelectAll').click();
    assert.equal(await page.locator('#pptImagesExportBtn').isDisabled(), false);
    await page.locator('#pptImagesPageFilter').fill('99');
    assert.equal(await page.locator('#pptImagesExportBtn').isHidden(), true);
    await page.locator('#pptImagesPageFilter').fill('1,2-3');
    await page.locator('#pptImagesSkipDuplicates').uncheck();
    await page.locator('#pptImagesSelectAll').click();
    const imageDownload = page.waitForEvent('download');
    await page.locator('#pptImagesExportBtn').click();
    const imageZip = await readDownload(await imageDownload);
    const imageNames = await zipNames(imageZip);
    assert.ok(imageNames.includes('manifest.json'));
    assert.ok(imageNames.includes('manifest.md'));
    assert.ok(imageNames.some(name => /\.(png|jpg)$/.test(name)));
    await page.waitForSelector('#pptImagesSuccessOverlay.visible');
    await page.locator('#pptImagesSuccessOk').click();
    const createdBeforeClose = await page.evaluate(() => window.__pptMatrixCreatedUrls.length);
    await closeTool(page, '#pptImagesOverlay', '#pptImagesBack');
    await page.waitForTimeout(1_100);
    const imageUrls = await page.evaluate(() => ({ created: window.__pptMatrixCreatedUrls, revoked: window.__pptMatrixRevokedUrls }));
    assert.ok(imageUrls.created.length >= createdBeforeClose);
    assert.ok(imageUrls.created.every(url => imageUrls.revoked.includes(url)), 'PPT image preview/export URLs must be revoked after close');
    report.images = { imageCount, duplicateCount, zipEntries: imageNames.length, objectUrlsRevoked: true };

    await openTool(page, 'PPT \u56fe\u7247\u63d0\u53d6');
    await page.locator('#pptImagesFileInput').setInputFiles(filePayload('broken.pptx', Buffer.from('not-a-pptx')));
    await waitForAlert(page);
    assert.equal(await page.locator('#pptImagesEmpty').isHidden(), false);
    await closeTool(page, '#pptImagesOverlay', '#pptImagesBack');

    await openTool(page, 'PPT AI \u6587\u672c\u63d0\u53d6');
    await page.locator('#pptTextFileInput').setInputFiles(filePayload('matrix-rich.pptx', richPptx));
    await page.waitForFunction(() => document.querySelector('#pptTextResults')?.hidden === false && document.querySelectorAll('#pptTextList .ppt-text-item').length === 4, null, { timeout: 30_000 });
    assert.equal(await page.locator('#pptTextList .ppt-text-item').count(), 4);
    assert.equal(await page.locator('#pptTextList .ppt-text-item.is-filtered-out').count(), 0);
    await page.locator('#pptTextPageFilter').fill('1,3');
    await page.waitForFunction(() => document.querySelectorAll('#pptTextList .ppt-text-item.is-filtered-out').length === 2);
    await page.locator('#pptTextFormat').selectOption('all');
    const textDownload = page.waitForEvent('download');
    await page.locator('#pptTextExportBtn').click();
    const textZip = await readDownload(await textDownload);
    const textNames = await zipNames(textZip);
    assert.ok(textNames.includes('slides.md') && textNames.includes('slides.txt') && textNames.includes('slides.json'));
    await page.waitForSelector('#pptTextSuccessOverlay.visible');
    await page.locator('#pptTextSuccessOk').click();
    await page.locator('#pptTextPageFilter').fill('2');
    await page.locator('#pptTextAiMode').selectOption('outline');
    const aiTextDownload = page.waitForEvent('download');
    await page.locator('#pptTextExportBtn').click();
    const aiTextZip = await readDownload(await aiTextDownload);
    const aiTextNames = await zipNames(aiTextZip);
    assert.ok(aiTextNames.includes('ai-outline.md'));
    await page.waitForSelector('#pptTextSuccessOverlay.visible');
    await page.locator('#pptTextSuccessOk').click();
    await closeTool(page, '#pptTextOverlay', '#pptTextBack');

    await openTool(page, 'PPT AI \u6587\u672c\u63d0\u53d6');
    routeState.mode = 'hang';
    await page.locator('#pptTextFileInput').setInputFiles(filePayload('matrix-rich.pptx', richPptx));
    await page.waitForFunction(() => document.querySelector('#pptTextResults')?.hidden === false, null, { timeout: 30_000 });
    await page.locator('#pptTextPageFilter').fill('1');
    await page.locator('#pptTextAiMode').selectOption('outline');
    await page.locator('#pptTextExportBtn').click();
    await page.waitForSelector('#pptTextProcessMask.visible');
    await page.locator('#pptTextBack').click();
    await page.waitForFunction(() => !document.querySelector('#pptTextOverlay')?.classList.contains('visible'));
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#pptTextSuccessOverlay').evaluate(node => node.classList.contains('visible')), false);
    assert.equal(await page.locator('#pptTextSuccessOverlay').getAttribute('aria-hidden'), 'true');
    routeState.mode = 'success';
    report.text = { filteredPages: [1, 3], allFormats: true, aiOutput: true, cancellationOnClose: true, zipEntries: textNames.length + aiTextNames.length };

    await openTool(page, 'PPT AI \u6587\u672c\u63d0\u53d6');
    await page.locator('#pptTextFileInput').setInputFiles(filePayload('broken.pptx', Buffer.from('invalid')));
    await waitForAlert(page);
    assert.equal(await page.locator('#pptTextEmpty').isHidden(), false);
    await closeTool(page, '#pptTextOverlay', '#pptTextBack');

    await openTool(page, 'PPT \u538b\u7f29');
    await page.locator('#pptCompressFileInput').setInputFiles(filePayload('matrix-rich.pptx', richPptx));
    await page.waitForFunction(() => document.querySelector('#pptCompressResults')?.hidden === false && !document.querySelector('#pptCompressExportBtn')?.disabled, null, { timeout: 30_000 });
    const levelStats = {};
    for (const level of ['low', 'medium', 'high']) {
      const previousStats = await page.locator('#pptCompressStats').innerText();
      await page.locator('#pptCompressLevel').selectOption(level);
      await page.waitForFunction(({ value, previous }) => {
        const select = document.querySelector('#pptCompressLevel');
        const stats = document.querySelector('#pptCompressStats');
        const selectedLabel = select?.selectedOptions?.[0]?.textContent?.trim();
        const currentText = stats?.innerText || '';
        return select?.value === value
          && Boolean(selectedLabel)
          && currentText.includes(selectedLabel)
          && currentText !== previous
          && document.querySelectorAll('#pptCompressStats .ppt-compress-stat').length >= 4;
      }, { value: level, previous: previousStats });
      levelStats[level] = await page.locator('#pptCompressStats').innerText();
    }
    assert.notEqual(levelStats.low, levelStats.high);
    const compressDownload = page.waitForEvent('download');
    await page.locator('#pptCompressExportBtn').click();
    const compressZip = await readDownload(await compressDownload);
    const compressNames = await zipNames(compressZip);
    assert.ok(compressNames.includes('manifest.json'));
    assert.ok(compressNames.some(name => name.endsWith('.pptx')));
    await page.waitForSelector('#pptCompressSuccessOverlay.visible');
    await page.locator('#pptCompressSuccessOk').click();
    await closeTool(page, '#pptCompressOverlay', '#pptCompressBack');

    await openTool(page, 'PPT \u538b\u7f29');
    await page.locator('#pptCompressFileInput').setInputFiles(filePayload('no-gain.pptx', noGainPptx));
    await page.waitForFunction(() => document.querySelector('#pptCompressResults')?.hidden === false && !document.querySelector('#pptCompressExportBtn')?.disabled, null, { timeout: 30_000 });
    const noGainDownload = page.waitForEvent('download');
    await page.locator('#pptCompressExportBtn').click();
    const noGainZip = await readDownload(await noGainDownload);
    const noGainNames = await zipNames(noGainZip);
    assert.ok(noGainNames.some(name => name.endsWith('.pptx')));
    await page.waitForSelector('#pptCompressSuccessOverlay.visible');
    await page.locator('#pptCompressSuccessOk').click();
    await closeTool(page, '#pptCompressOverlay', '#pptCompressBack');

    await openTool(page, 'PPT \u538b\u7f29');
    await page.locator('#pptCompressFileInput').setInputFiles(filePayload('broken.pptx', Buffer.from('invalid')));
    await waitForAlert(page);
    assert.equal(await page.locator('#pptCompressEmpty').isHidden(), false);
    await closeTool(page, '#pptCompressOverlay', '#pptCompressBack');
    report.compress = { levels: Object.keys(levelStats), exported: true, noGainExported: true, invalidInput: true, zipEntries: compressNames.length + noGainNames.length };

    await page.evaluate(() => localStorage.removeItem('ai_api_key'));
    await page.reload();
    await openTool(page, 'AI \u751f\u6210 PPT \u5927\u7eb2');
    await page.locator('#pptOutlinePrompt').fill('Create a QA outline.');
    await page.locator('#pptOutlineGenerateBtn').click();
    await waitForAlert(page);
    assert.equal(await page.locator('#pptOutlineResult').isHidden(), true);
    await closeTool(page, '#pptOutlineOverlay', '#pptOutlineBack');

    await page.evaluate(() => localStorage.setItem('ai_api_key', 'toolknit-local-ppt-matrix-key'));
    await page.reload();
    routeState.mode = 'fail';
    await openTool(page, 'AI \u751f\u6210 PPT \u5927\u7eb2');
    await page.locator('#pptOutlinePrompt').fill('Create a failing QA outline.');
    await page.locator('#pptOutlineGenerateBtn').click();
    await waitForAlert(page);
    assert.equal(await page.locator('#pptOutlineResult').isHidden(), true);
    await closeTool(page, '#pptOutlineOverlay', '#pptOutlineBack');
    routeState.mode = 'success';

    await openTool(page, 'AI \u751f\u6210 PPT \u5927\u7eb2');
    await page.locator('#pptOutlinePrompt').fill('Create a successful QA outline.');
    await page.locator('#pptOutlineSlideCount').fill('3');
    const outlineDownload = page.waitForEvent('download');
    await page.locator('#pptOutlineGenerateBtn').click();
    const outlineZip = await readDownload(await outlineDownload);
    const outlineNames = await zipNames(outlineZip);
    assert.ok(outlineNames.includes('outline.md') && outlineNames.includes('outline.json') && outlineNames.includes('manifest.json'));
    await page.waitForSelector('#pptOutlineSuccessOverlay.visible');
    await page.locator('#pptOutlineSuccessToDraft').click();
    await page.waitForFunction(() => document.querySelector('#pptDraftOverlay')?.classList.contains('visible')
      && document.querySelector('#pptDraftOutlineStatus')?.dataset.ready === 'true', null, { timeout: 30_000 });
    assert.equal(await page.locator('#pptOutlineOverlay').evaluate(node => node.classList.contains('visible')), false);
    assert.equal(await page.locator('#pptDraftOutlineStatus').getAttribute('data-ready'), 'true');
    report.outline = { noKey: true, providerFailure: true, exported: true, zipEntries: outlineNames.length, continuedToDraft: true };

    const draftDownload = page.waitForEvent('download');
    await page.locator('#pptDraftGenerateBtn').click();
    const draftZip = await readDownload(await draftDownload);
    const draftNames = await zipNames(draftZip);
    assert.ok(draftNames.some(name => name.endsWith('.pptx')));
    assert.ok(draftNames.includes('outline.json') && draftNames.includes('outline.md') && draftNames.includes('manifest.json'));
    await page.waitForSelector('#pptDraftSuccessOverlay.visible');
    await page.locator('#pptDraftSuccessOk').click();
    await page.locator('#pptDraftSlideList .ppt-draft-slide-card').first().click();
    await page.waitForSelector('#pptDraftEditorOverlay.visible');
    await page.locator('#pptDraftEditorSlideTitle').fill('Edited QA title');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#pptDraftEditorOverlay')?.classList.contains('visible'));
    await page.locator('#pptDraftSlideList .ppt-draft-slide-card').first().click();
    await page.waitForSelector('#pptDraftEditorOverlay.visible');
    await page.locator('#pptDraftEditorSlideTitle').fill('Edited QA title 2');
    const editorDownload = page.waitForEvent('download');
    await page.locator('#pptDraftEditorExportBtn').click();
    const editorZip = await readDownload(await editorDownload);
    const editorNames = await zipNames(editorZip);
    assert.ok(editorNames.some(name => name.endsWith('.pptx')));
    await page.waitForSelector('#pptDraftSuccessOverlay.visible');
    await page.locator('#pptDraftSuccessOk').click();
    await closeTool(page, '#pptDraftOverlay', '#pptDraftBack');
    report.draft = { importedOutline: true, exported: true, editorEscape: true, editedExported: true, zipEntries: draftNames.length + editorNames.length };

    await page.evaluate(() => localStorage.removeItem('ai_api_key'));
    await page.reload();
    routeState.mode = 'fail';
    await openTool(page, 'AI \u751f\u6210 PPT \u8349\u7a3f / PPTX');
    await page.locator('#pptDraftPrompt').fill('Create a failing QA draft.');
    await page.locator('#pptDraftGenerateBtn').click();
    await waitForAlert(page);
    assert.equal(await page.locator('#pptDraftResult').isHidden(), true);
    await closeTool(page, '#pptDraftOverlay', '#pptDraftBack');

    report.console = consoleMessages.filter(message => !/event\.listen not allowed|app\.version not allowed|native .*registration .*failed/i.test(message));
    assert.deepEqual(report.console, [], `PPT content matrix emitted unexpected console output: ${JSON.stringify(report.console)}`);
    report.status = 'passed';
    await page.screenshot({ path: path.join(evidenceDir, 'final.png') });
    console.log(`PPT content matrix passed: ${path.relative(process.cwd(), reportPath)}`);
  } catch (error) {
    report.status = 'failed';
    report.error = String(error?.stack || error);
    report.console = consoleMessages;
    throw error;
  } finally {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
