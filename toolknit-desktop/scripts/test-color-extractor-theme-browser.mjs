import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/color-extractor-theme');
await mkdir(output, { recursive: true });
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;

async function fixture(colors) {
  const canvas = createCanvas(180, 120);
  const context = canvas.getContext('2d');
  colors.forEach((color, index) => {
    if (!color) return;
    context.fillStyle = color;
    context.fillRect(index * 180 / colors.length, 0, 180 / colors.length, 120);
  });
  return { name: 'theme-palette.png', mimeType: 'image/png', buffer: await canvas.encode('png') };
}

async function openTool(page) {
  await page.locator('.audio-list-item[data-tool="color-extractor"]').evaluate(node => node.click());
  await page.waitForSelector('#colorExtractorOverlay.visible');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#colorExtractorOverlay')).opacity === '1');
}

async function readable(page) {
  const failures = await page.locator('#colorExtractorOverlay :is(button span, button small, button strong, p, h2, .color-extractor-v2-status, .color-extractor-v2-result-caption, .color-extractor-v2-detail-hint, .color-extractor-v2-palette-empty strong, .tk-empty-hero-description, .color-extractor-palette-copy strong, .color-extractor-palette-copy small, .color-extractor-palette-share, .color-extractor-image-preview-copy strong, .color-extractor-image-preview-copy span, .color-extractor-screen-intro strong, .color-extractor-screen-result-copy strong, .color-extractor-screen-result-copy span)').evaluateAll(nodes => {
    const rgba = value => value.match(/[\d.]+/g).map(Number);
    const composite = (front, back) => front.slice(0, 3).map((value, i) => value * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)));
    const luminance = channels => channels.reduce((sum, value, i) => {
      const c = value / 255;
      return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
    }, 0);
    return nodes.filter(node => node.getBoundingClientRect().width && node.textContent.trim()).flatMap(node => {
      const chain = [];
      for (let parent = node; parent; parent = parent.parentElement) chain.unshift(parent);
      const background = chain.reduce((current, element) => composite(rgba(getComputedStyle(element).backgroundColor), current), [255, 255, 255]);
      const foreground = rgba(getComputedStyle(node).color);
      foreground[3] = (foreground[3] ?? 1) * Number(getComputedStyle(node).opacity);
      const ink = composite(foreground, background);
      const [light, dark] = [luminance(ink), luminance(background)].sort((a, b) => b - a);
      const contrast = (light + 0.05) / (dark + 0.05);
      return contrast >= 4.5 ? [] : [{ element: node.id || node.getAttribute('data-i18n') || node.className, contrast }];
    });
  });
  assert.deepEqual(failures, [], 'light theme text must be readable');
}

async function fits(page) {
  const overflow = await page.locator('#colorExtractorOverlay button, .color-extractor-v2-workspace, .color-extractor-v2-detail, .color-extractor-palette-card').evaluateAll(nodes => nodes
    .filter(node => node.getBoundingClientRect().width && node.scrollWidth > node.clientWidth + 1)
    .map(node => node.id || node.className));
  assert.deepEqual(overflow, [], 'controls and values must fit horizontally');
  const clipped = await page.locator('.color-extractor-v2-panel, .color-extractor-v2-palette-panel').evaluateAll(panels => panels.flatMap(panel => {
    const bounds = panel.getBoundingClientRect();
    return [...panel.querySelectorAll('.color-extractor-screen-result:not([hidden]), .color-extractor-image-preview-meta, .color-extractor-v2-detail, .color-extractor-upload:not([hidden])')]
      .filter(node => node.getBoundingClientRect().width && node.getBoundingClientRect().bottom > bounds.bottom + 1)
      .map(node => ({ element: node.id || node.className, bottom: node.getBoundingClientRect().bottom, panelBottom: bounds.bottom }));
  }));
  assert.deepEqual(clipped, [], 'editor controls must remain inside their panel');
}

async function verifySwatches(page) {
  const values = await page.locator('.color-extractor-palette-card').evaluateAll(nodes => nodes.map(node => {
    const swatch = node.querySelector('.color-extractor-palette-swatch');
    const hex = node.querySelector('strong').textContent;
    const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
    return { actual: getComputedStyle(swatch).backgroundColor, expected: `rgb(${channels.join(', ')})` };
  }));
  assert.ok(values.length);
  values.forEach(value => assert.equal(value.actual, value.expected, 'theme must preserve sampled colors'));
  const detail = await page.locator('#colorExtractorDetailSwatch').evaluate(node => ({ actual: getComputedStyle(node).backgroundColor, expected: node.style.backgroundColor }));
  assert.equal(detail.actual, detail.expected, 'detail swatch must show the selected color immediately');
}

async function dismissToasts(page) {
  await page.locator('.app-toast:not(.hiding) .app-toast-close').evaluateAll(nodes => nodes.forEach(node => node.click()));
  await page.waitForFunction(() => document.querySelectorAll('.app-toast').length === 0);
}

try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => {
      localStorage.setItem('toolknit.theme.v3', theme);
      // Isolate clipboard and OS screen capture while exercising result UI.
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
        if (window.__failColorCopy) throw new Error('clipboard-denied');
        window.__colorClipboard = text;
      } } });
      window.EyeDropper = class {
        async open() {
          if (window.__cancelColorPicker) throw new DOMException('Cancelled', 'AbortError');
          return { sRGBHex: '#FFFFFF' };
        }
      };
    }, theme);
    await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await openTool(page);
    assert.equal(await page.locator('#colorExtractorPaletteEmpty').isVisible(), true);
    assert.equal(await page.locator('#colorExtractorDetailSwatch').evaluate(node => node.style.backgroundColor), '');
    await page.locator('.color-extractor-v2-detail-code[data-code="hex"]').click();
    assert.equal(await page.evaluate(() => window.__colorClipboard), undefined, 'empty details must not copy placeholders');
    if (theme === 'light') await readable(page);
    await page.locator('#colorExtractorScreenModeBtn').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'colorExtractorUploadZone');
    assert.equal(await page.locator('#colorExtractorUploadZone').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    await page.screenshot({ path: path.join(output, `${theme}-empty.png`) });
    await page.locator('#colorExtractorUploadZone').dispatchEvent('dragenter');
    assert.equal(await page.locator('#colorExtractorUploadZone').evaluate(node => node.classList.contains('dragover')), true);
    await page.locator('#colorExtractorUploadZone').dispatchEvent('dragleave');
    for (const colors of [['#FFFFFF'], ['#000000'], [null, '#14826A'], ['#FFFFFF', '#000000', '#14826A', '#D84F62']]) {
      await page.locator('#colorExtractorFileInput').setInputFiles(await fixture(colors));
      await page.waitForFunction(() => !document.querySelector('#colorExtractorPaletteGrid').hidden);
      await verifySwatches(page);
      if (theme === 'light') await readable(page);
      if (colors.length === 1) assert.equal(await page.locator('.color-extractor-palette-copy strong').first().textContent(), colors[0]);
      if (colors[0] === null) assert.equal(await page.locator('.color-extractor-palette-copy strong').first().textContent(), '#14826A');
    }
    await page.locator('.color-extractor-palette-card').last().press('Enter');
    assert.equal(await page.locator('#colorExtractorDetailHex').textContent(), await page.locator('.color-extractor-palette-card').last().locator('strong').textContent());
    for (const code of ['hex', 'rgb', 'hsl']) {
      const button = page.locator(`.color-extractor-v2-detail-code[data-code="${code}"]`);
      const expected = await button.locator('strong').textContent();
      await button.click();
      assert.equal(await page.evaluate(() => window.__colorClipboard), expected);
    }
    await page.evaluate(() => { window.__failColorCopy = true; });
    await page.locator('.color-extractor-v2-detail-code[data-code="hex"]').click();
    await page.evaluate(() => { window.__failColorCopy = false; });
    await page.locator('.color-extractor-v2-detail-code[data-code="hex"]').press('Enter');
    assert.equal(await page.evaluate(() => window.__colorClipboard), await page.locator('#colorExtractorDetailHex').textContent());
    await dismissToasts(page);
    await page.screenshot({ path: path.join(output, `${theme}-image.png`) });
    for (const [width, height] of [[1400, 900], [1100, 700], [900, 650], [720, 480]]) {
      await page.setViewportSize({ width, height });
      await fits(page);
      await page.locator('#colorExtractorDetail').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${theme}-image-${width}.png`) });
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator('#colorExtractorScreenModeBtn').click();
    if (theme === 'light') await readable(page);
    await page.locator('#colorExtractorScreenStartBtn').click();
    await page.locator('#colorExtractorScreenResult').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#colorExtractorScreenSwatch').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    await page.locator('#colorExtractorScreenCopyBtn').click();
    assert.equal(await page.evaluate(() => window.__colorClipboard), '#FFFFFF');
    if (theme === 'light') await readable(page);
    await dismissToasts(page);
    await page.screenshot({ path: path.join(output, `${theme}-screen.png`) });
    await fits(page);
    await page.evaluate(() => { window.__cancelColorPicker = true; });
    await page.locator('#colorExtractorScreenStartBtn').click();
    assert.equal(await page.locator('#colorExtractorScreenStartBtn').isEnabled(), true);
    await page.setViewportSize({ width: 900, height: 650 });
    await fits(page);
    await page.keyboard.press('Escape');
    await page.locator('#colorExtractorOverlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#colorExtractorOverlay').evaluate(node => node.contains(document.activeElement)), false);
    await openTool(page);
    assert.equal(await page.locator('#colorExtractorPaletteEmpty').isVisible(), true);
    assert.equal(await page.locator('#colorExtractorDetailSwatch').evaluate(node => node.style.backgroundColor), '');
    await page.locator('#colorExtractorBack').click();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator('#homeV2Settings').click();
    await page.locator('#settingsOverlay [data-lang="en"]').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en' && !document.body.matches('.fade-in, .fade-out'));
    await page.locator('#settingsBack').click();
    await openTool(page);
    if (theme === 'light') await readable(page);
    await fits(page);
    await page.screenshot({ path: path.join(output, `${theme}-english.png`) });
    await page.locator('#colorExtractorBack').click();
    await page.locator('.audio-list-item[data-tool="password-gen"]').evaluate(node => node.click());
    await page.locator('#passwordGenOverlay.visible').waitFor();
    await page.locator('#passwordGenBack').click();
    await openTool(page);
    await fits(page);
    if (theme === 'light') await readable(page);
    await page.locator('#colorExtractorFileInput').setInputFiles(await fixture(['#FFFFFF', '#000000', '#14826A', '#D84F62']));
    await page.waitForFunction(() => !document.querySelector('#colorExtractorPaletteGrid').hidden);
    await verifySwatches(page);
    // Exercise the live CSS theme boundary without replacing the current results.
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme === 'light' ? 'dark' : 'light'; }, theme);
    await verifySwatches(page);
    // Sample text contrast after the shared navigation's background transition.
    await page.locator('#colorExtractorOverlay').evaluate(async node => {
      await Promise.all(node.getAnimations({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {})));
    });
    if (theme === 'dark') await readable(page);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Color extractor theme browser regression passed: light/dark, image upload, true swatches, copy, picker result/cancel UI, compact layouts, language and reopen');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
