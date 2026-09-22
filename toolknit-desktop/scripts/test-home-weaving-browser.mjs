import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { DEFAULT_DARK_BACKGROUND_SRC, CUSTOM_BACKGROUND_STORAGE_KEY } from '../src/app/custom-background-default.js';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/home-weaving');
await mkdir(output, { recursive: true });
const server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1920, height: 919 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const settled = () => page.waitForFunction(() => {
  const veil = document.querySelector('[data-tk-page-transition-veil]');
  return !veil || getComputedStyle(veil).visibility === 'hidden';
});
const playing = expected => page.waitForFunction(value =>
  getComputedStyle(document.querySelector('.home-weaving-spider')).animationPlayState === value, expected);
const stage = page.locator('.home-weaving');
const oldPreview = page.locator('.web-preview-stage');
const button = page.locator('.home-weaving-link');
const spiderColor = () => page.locator('.home-weaving-abdomen').evaluate(node => getComputedStyle(node).fill);
async function settings() { await page.locator('#homeV2Settings').click(); await settled(); }
async function home() { await page.locator('#settingsBack').click(); await settled(); }

async function checkButtonAlignment() {
  await button.evaluate(async node => {
    const label = node.querySelector('span');
    const style = getComputedStyle(label);
    await document.fonts.load(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, label.textContent);
  });
  await page.evaluate(() => document.fonts.ready);
  const metrics = await button.evaluate(node => {
    const label = node.querySelector('span');
    const style = getComputedStyle(label);
    const context = document.createElement('canvas').getContext('2d');
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const ink = context.measureText(label.textContent);
    // A zero-height inline marker exposes the actual fallback-font baseline.
    const marker = document.createElement('i');
    marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    label.append(marker);
    const baseline = marker.getBoundingClientRect().top;
    marker.remove();
    const box = node.getBoundingClientRect();
    const text = label.getBoundingClientRect();
    const center = box.top + box.height / 2;
    return {
      language: document.documentElement.lang,
      width: innerWidth,
      inkOffset: baseline + (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2 - center,
      horizontalOffset: text.left + text.width / 2 - (box.left + box.width / 2),
      iconOffsets: [...node.querySelectorAll('svg')].map(icon => {
        const rect = icon.getBoundingClientRect();
        return rect.top + rect.height / 2 - center;
      }),
      height: box.height
    };
  });
  // Browser/font rasterization can round optical bounds by one CSS pixel.
  assert.ok(Math.abs(metrics.inkOffset) <= 1, `painted glyphs centered: ${JSON.stringify(metrics)}`);
  assert.ok(Math.abs(metrics.horizontalOffset) <= .1, 'label centered between equal-width icons');
  assert.ok(metrics.iconOffsets.every(offset => Math.abs(offset) <= .1), 'icons remain centered');
  assert.equal(metrics.height, 44, 'label metrics do not resize the capsule');
  console.log('Button alignment', metrics);
}

try {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8 });
    Object.defineProperty(navigator, 'deviceMemory', { value: 8 });
    window.__homeLinks = [];
    window.open = (...args) => { window.__homeLinks.push(args); return null; };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('.home-weaving-svg').waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await oldPreview.count(), 0, 'legacy preview is removed, not hidden');
  assert.equal(await stage.isVisible(), true);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'fresh install still starts light');
  assert.equal(await page.locator('.home-v2-custom-background-host img').count(), 0);
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).src, CUSTOM_BACKGROUND_STORAGE_KEY), DEFAULT_DARK_BACKGROUND_SRC);
  await settings();
  await page.locator('[data-theme-choice="dark"]').click();
  await settled();
  await page.waitForFunction(src => {
    const img = document.querySelector('#settingsBackgroundPreview img');
    return img?.getAttribute('src') === src && img.complete && img.naturalWidth === 2560;
  }, DEFAULT_DARK_BACKGROUND_SRC);
  await home();
  await playing('running');
  assert.equal(await spiderColor(), 'rgb(41, 47, 53)', 'dark spider keeps a graphite body');
  await page.waitForFunction(() => document.querySelector('.app').classList.contains('has-custom-background'));
  await checkButtonAlignment();
  await page.screenshot({ path: path.join(output, 'dark-default-wallpaper.png') });
  await stage.screenshot({ path: path.join(output, 'dark-artwork.png') });
  await settings();
  await page.locator('[data-theme-choice="light"]').click();
  await home();
  await playing('running');
  assert.equal(await spiderColor(), 'rgb(41, 47, 53)');
  assert.equal(await button.isVisible(), true);
  assert.equal(await page.locator('.home-v2-topbar [data-home-link="website"]').first().isVisible(), true);
  await checkButtonAlignment();
  await button.hover();
  await checkButtonAlignment();
  await button.screenshot({ path: path.join(output, 'button-zh.png') });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(output, 'light-desktop.png') });
  await stage.screenshot({ path: path.join(output, 'light-artwork.png') });
  const first = await page.locator('.home-weaving-spider').evaluate(node => getComputedStyle(node).transform);
  await page.waitForTimeout(300);
  assert.notEqual(await page.locator('.home-weaving-spider').evaluate(node => getComputedStyle(node).transform), first);
  await page.locator('.home-weaving-art').click({ force: true });
  assert.equal(await page.evaluate(() => window.__homeLinks.length), 0);
  await button.click();
  assert.deepEqual(await page.evaluate(() => window.__homeLinks), [['https://toolknit.com/', '_blank', 'noopener,noreferrer']]);
  await button.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__homeLinks.length), 2);

  await settings();
  await playing('paused');
  await page.locator('[data-lang="en"]').click();
  await home();
  await playing('running');
  assert.equal(await button.innerText(), 'Open the web app');
  await checkButtonAlignment();
  await button.screenshot({ path: path.join(output, 'button-en.png') });
  await page.locator('[data-home-tool="pdf-compress"]').click();
  await page.locator('#pdfCompressOverlay.visible').waitFor();
  await settled();
  await playing('paused');
  await page.keyboard.press('Escape');
  await page.locator('#pdfCompressOverlay.visible').waitFor({ state: 'hidden' });
  await settled();
  await stage.scrollIntoViewIfNeeded();
  await playing('running');

  await page.locator('.main-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => !document.querySelector('.home-weaving').classList.contains('is-playing'));
  await page.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
  await playing('running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.home-weaving-spider').evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await playing('running');

  for (const [width, height] of [[1366, 768], [900, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await stage.scrollIntoViewIfNeeded();
    const boxes = await stage.evaluate(node => {
      const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return { stage: box(node), art: box(node.querySelector('.home-weaving-art')), button: box(node.querySelector('button')) };
    });
    assert.ok(boxes.stage.left >= 0 && boxes.stage.right <= width + 1, 'art stays inside viewport');
    assert.ok(boxes.art.bottom <= boxes.button.top, 'button and artwork do not overlap');
    assert.ok(boxes.button.left >= boxes.stage.left && boxes.button.right <= boxes.stage.right);
    assert.equal(await button.evaluate(node => node.scrollWidth > node.clientWidth), false);
    await checkButtonAlignment();
    await page.screenshot({ path: path.join(output, `light-${width}.png`) });
  }
  await page.setViewportSize({ width: 1920, height: 919 });
  await settings();
  await page.locator('[data-lang="zh"]').click();
  await page.locator('[data-theme-choice="dark"]').click();
  await home();
  assert.equal(await stage.isVisible(), true);
  assert.equal(await spiderColor(), 'rgb(41, 47, 53)');
  await playing('running');
  await button.click();
  assert.equal(await page.evaluate(() => window.__homeLinks.length), 3);
  await page.screenshot({ path: path.join(output, 'dark-desktop.png') });
  for (const [width, height] of [[1366, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await stage.scrollIntoViewIfNeeded();
    const bounds = await stage.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    await checkButtonAlignment();
    await page.screenshot({ path: path.join(output, `dark-${width}.png`) });
  }
  await page.setViewportSize({ width: 1920, height: 919 });
  assert.equal(await page.locator('.home-weaving-svg').count(), 1, 'theme and page switches do not duplicate artwork');
  assert.equal(await page.locator('#homeWeavingTypeClearance').count(), 1, 'inline SVG mask IDs remain unique across theme and page switches');
  assert.equal(await page.locator('#homeWeavingTypeFade').count(), 1);
  await settings();
  await page.locator('#clearCustomBackground').click();
  assert.equal(await page.locator('#settingsBackgroundPreview img').count(), 0);
  await home();
  await page.reload();
  await button.waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), CUSTOM_BACKGROUND_STORAGE_KEY), null, 'cleared wallpaper stays cleared after reload');
  assert.equal(await page.locator('.home-v2-custom-background-host img').count(), 0);
  await page.screenshot({ path: path.join(output, 'dark-cleared-wallpaper.png') });
  assert.deepEqual(errors, []);
  console.log('PASS home artwork: themes, both links, keyboard, animation, overlays, scroll, reduced motion, language, responsive bounds and console');
} catch (error) {
  console.log(await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    stage: document.querySelector('.home-weaving')?.className,
    style: document.querySelector('.home-weaving-spider') && getComputedStyle(document.querySelector('.home-weaving-spider')).animation,
    play: document.querySelector('.home-weaving') && getComputedStyle(document.querySelector('.home-weaving')).getPropertyValue('--weaving-play-state'),
    overlays: [...document.querySelectorAll(':is([id$="Overlay"], [id$="Workspace"], [id$="Dialog"]).visible')].map(node => node.id)
  })));
  await page.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
