import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { COLOR_SPACE_SLIDER_CONFIG } from '../src/features/color-space-compare/core.js';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/color-space-compare-theme');
await mkdir(output, { recursive: true });
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;

async function settle(page) {
  await page.locator('.color-space-compare-shell').evaluate(async node => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(node.getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})));
  });
}

async function openTool(page) {
  await page.locator('.audio-list-item[data-tool="color-space-compare"]').evaluate(node => node.click());
  await page.locator('#colorSpaceCompareOverlay.visible').waitFor();
  await settle(page);
}

function row(page, space, channel) {
  return page.locator(`.color-space-compare-slider-row[data-space="${space}"][data-channel="${channel}"]`);
}

async function setChannel(page, space, channel, value) {
  const input = row(page, space, channel).locator('input');
  await input.fill(String(value));
  await input.press('Enter');
  await settle(page);
}

async function colorState(page) {
  return page.locator('.color-space-compare-shell').evaluate(root => ({
    hex: root.querySelector('[data-role="hex"]').textContent,
    preview: getComputedStyle(root.querySelector('[data-role="preview"]')).backgroundColor,
    values: [...root.querySelectorAll('input')].map(node => node.value),
    codes: [...root.querySelectorAll('.color-space-compare-code-value')].map(node => node.textContent),
    tracks: [...root.querySelectorAll('.color-space-compare-track canvas, .color-space-compare-wheel-canvas')].map(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      return { width: canvas.width, height: canvas.height, hash };
    }),
  }));
}

async function checkLayout(page) {
  const failures = await page.locator('.color-space-compare-shell').evaluate(root => {
    const selectors = '.color-space-compare-slider-row, .color-space-compare-value-group, .color-space-compare-code-card, .color-space-compare-preview-row, .color-space-compare-section, .color-space-compare-wheel, .color-space-compare-hex-row';
    const failed = [...root.querySelectorAll(selectors)].filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className);
    for (const group of root.querySelectorAll('.color-space-compare-value-group')) {
      const [input, unit, buttons] = ['input', '.color-space-compare-value-unit', '.color-space-compare-step-buttons'].map(selector => group.querySelector(selector).getBoundingClientRect());
      if (input.right > unit.left + 1 || unit.right > buttons.left + 1) failed.push('unit/stepper overlap');
    }
    if (root.scrollWidth > root.clientWidth + 1) failed.push('shell horizontal overflow');
    return failed;
  });
  assert.deepEqual(failures, [], 'controls must fit without overlap');
}

async function checkLight(page) {
  const failures = await page.locator('.color-space-compare-shell').evaluate(root => {
    const rgba = value => value.match(/[\d.]+/g).map(Number);
    const composite = (front, back) => front.slice(0, 3).map((value, i) => value * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)));
    const luminance = channels => channels.reduce((sum, value, i) => {
      const c = value / 255;
      return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
    }, 0);
    return [...root.querySelectorAll('h1, h2, p, strong, span, input, button')]
      .filter(node => node.getBoundingClientRect().width && !node.disabled
        && (node.matches('input') || (node.childElementCount === 0 && node.textContent.trim())))
      .flatMap(node => {
        const chain = [];
        for (let parent = node; parent; parent = parent.parentElement) chain.unshift(parent);
        const bg = chain.reduce((current, element) => composite(rgba(getComputedStyle(element).backgroundColor), current), [255, 255, 255]);
        const ink = composite(rgba(getComputedStyle(node).color), bg);
        const [light, dark] = [luminance(ink), luminance(bg)].sort((a, b) => b - a);
        const contrast = (light + 0.05) / (dark + 0.05);
        return contrast >= 4.5 ? [] : [{ element: node.className, contrast }];
      });
  });
  assert.deepEqual(failures, [], 'light text must remain readable');
  assert.equal(await page.locator('.color-space-compare-shell').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
}

async function checkWheelsAndHex(page) {
  const hex = page.locator('[data-role="hex-input"]');
  const hsv = page.locator('[data-wheel="hsv"] [data-role="wheel-hit"]');
  const hsl = page.locator('[data-wheel="hsl"] [data-role="wheel-hit"]');
  assert.equal(await page.locator('.color-space-compare-wheel-canvas').count(), 2);
  assert.ok(await page.locator('.color-space-compare-wheel-canvas').evaluateAll(nodes => nodes.every(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return canvas.width >= 100 && pixels.some((v, i) => i % 4 === 3 && v > 0)
      && pixels.some((v, i) => i % 4 === 0 && v > pixels[i + 1] + 30);
  })), 'Both wheels must render nonblank, colored canvases.');
  const samples = await page.locator('.color-space-compare-wheel-canvas').evaluateAll(nodes => nodes.map((canvas, i) => {
    const position = i === 0 ? (1 - .72 / Math.SQRT2 / 2) / 2 : .5;
    return [...canvas.getContext('2d').getImageData(Math.floor(position * canvas.width), Math.floor(position * canvas.height), 1, 1).data];
  }));
  for (const [index, expected] of [[0, [191, 143, 143, 255]], [1, [170, 85, 85, 255]]]) {
    samples[index].forEach((actual, channel) => assert.ok(Math.abs(actual - expected[channel]) < 5,
      `Wheel ${index} must rasterize the actual inner gradient at device scale.`));
  }

  for (const [value, normalized, preview] of [['#abc', 'AABBCC', 'rgb(170, 187, 204)'], ['ff0080', 'FF0080', 'rgb(255, 0, 128)']]) {
    await hex.fill(value);
    assert.equal(await hex.inputValue(), value, 'Live synchronization must preserve the draft.');
    await hex.press('Enter');
    assert.equal(await hex.inputValue(), normalized);
    assert.equal((await colorState(page)).preview, preview);
  }
  const valid = await colorState(page);
  for (const invalid of ['12345', '#GGGGGG', '12#3456', 'rgb(1,2,3)', '']) {
    await hex.fill(invalid);
    assert.equal(await hex.getAttribute('aria-invalid'), 'true');
    assert.equal((await colorState(page)).preview, valid.preview, 'Invalid input must not change the model.');
    await hex.press('Tab');
    assert.equal(await hex.inputValue(), 'FF0080');
    assert.equal(await hex.getAttribute('aria-invalid'), 'false');
  }
  await hex.fill('#00ff00');
  await hex.press('Escape');
  assert.equal(await hex.inputValue(), 'FF0080', 'Escape must restore the pre-edit color.');
  assert.ok(await page.locator('#colorSpaceCompareOverlay').evaluate(node => node.classList.contains('visible')));

  // Real browser focus sequence reproducing the PR's stale numeric draft bug.
  await row(page, 'hsv', 'h').locator('input').fill('12');
  await hsv.scrollIntoViewIfNeeded();
  let bounds = await hsv.boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height * .95);
  await hex.focus();
  assert.equal(Number(await row(page, 'hsv', 'h').locator('input').inputValue()), 270);
  await hex.fill('12345');
  await hsv.scrollIntoViewIfNeeded();
  bounds = await hsv.boundingBox();
  await page.mouse.click(bounds.x + bounds.width * .95, bounds.y + bounds.height / 2);
  assert.equal(await hex.getAttribute('aria-invalid'), 'false');
  assert.equal(await hex.inputValue(), (await page.locator('[data-role="hex"]').textContent()).slice(1));
  await hsv.press('ArrowLeft');
  assert.equal(Number(await row(page, 'hsv', 'h').locator('input').inputValue()), 355);
  await page.mouse.move(bounds.x + bounds.width * .95, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * .05, { steps: 30 });
  await page.mouse.up();
  await settle(page);
  assert.equal(Number(await row(page, 'hsv', 'h').locator('input').inputValue()), 90, 'Continuous drag must retain the last pick.');
  await hsl.press('ArrowRight');
  assert.ok(await hsl.getAttribute('aria-label'));

  // Saturation/value picks must be independent of the hue ring.
  await hsv.scrollIntoViewIfNeeded();
  bounds = await hsv.boundingBox();
  await page.mouse.click(bounds.x + bounds.width * .7, bounds.y + bounds.height * .3);
  assert.ok(Number(await row(page, 'hsv', 's').locator('input').inputValue()) > 80);
  assert.ok(Number(await row(page, 'hsv', 'v').locator('input').inputValue()) > 80);
  await hsl.scrollIntoViewIfNeeded();
  bounds = await hsl.boundingBox();
  await page.mouse.click(bounds.x + bounds.width * .86, bounds.y + bounds.height / 2);
  assert.ok(Number(await row(page, 'hsl', 's').locator('input').inputValue()) > 90);

  await hex.fill('808080');
  await hex.press('Enter');
  await hsv.scrollIntoViewIfNeeded();
  bounds = await hsv.boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height * .05);
  assert.equal((await colorState(page)).preview, 'rgb(128, 128, 128)');
  assert.equal(Number(await row(page, 'hsl', 'h').locator('input').inputValue()), 90, 'Gray colors retain the chosen hue across wheels.');
  await hex.fill('808080');
  await hex.press('Enter');
  await page.locator('.color-space-compare-controls').evaluate(node => { node.scrollTop = 0; });
  await settle(page);
}

try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce',
      deviceScaleFactor: Number(process.env.TOOLKNIT_TEST_DPR || 1) });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => {
      localStorage.setItem('toolknit.theme.v3', theme);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__cscClipboard = text; } } });
    }, theme);
    await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await openTool(page);
    assert.equal(await page.locator('.color-space-compare-section').count(), 8);
    assert.equal(await page.locator('.color-space-compare-value-input').count(), 25);
    await checkLayout(page);
    if (theme === 'light') await checkLight(page);
    await page.screenshot({ path: path.join(output, `${theme}-initial.png`) });
    await checkWheelsAndHex(page);

    // Every model retains live input, stepping, keyboard and pointer control.
    for (const [space, config] of Object.entries(COLOR_SPACE_SLIDER_CONFIG)) {
      const channel = config.channels[0];
      const value = Number(((channel.min + channel.max) / 2).toFixed(channel.decimals));
      await setChannel(page, space, channel.key, value);
      const control = row(page, space, channel.key);
      await control.locator('[data-direction="1"]').click();
      assert.ok(Math.abs(Number(await control.locator('input').inputValue()) - value - channel.step) < 1e-6, `${space} increase`);
      await control.locator('[role="slider"]').press('ArrowLeft');
      assert.ok(Math.abs(Number(await control.locator('input').inputValue()) - value) < 1e-6);
      await control.locator('[role="slider"]').click({ position: { x: 30, y: 16 } });
      assert.notEqual(Number(await control.locator('input').inputValue()), value);
    }
    for (const value of [0, 255, 128]) {
      for (const channel of ['r', 'g', 'b']) await setChannel(page, 'rgb', channel, value);
      const state = await colorState(page);
      assert.equal(state.preview, `rgb(${value}, ${value}, ${value})`);
      assert.equal(state.hex.toUpperCase(), `#${value.toString(16).padStart(2, '0').repeat(3)}`.toUpperCase());
      await checkLayout(page);
      if (theme === 'light') await checkLight(page);
    }
    await setChannel(page, 'oklab', 'L', 0.5);
    await setChannel(page, 'oklab', 'a', 0.4);
    await setChannel(page, 'oklab', 'b', 0.4);
    assert.ok(await row(page, 'oklch', 'C').evaluate(node => node.classList.contains('is-value-outside-range')));
    assert.equal(await row(page, 'oklch', 'C').locator('.color-space-compare-handle').evaluate(node => getComputedStyle(node).borderStyle), 'dashed');
    assert.ok(await page.locator('.color-space-compare-gamut-item.is-out').count());
    if (theme === 'light') await checkLight(page);
    for (const card of await page.locator('.color-space-compare-code-card').all()) {
      await card.click();
      assert.equal(await page.evaluate(() => window.__cscClipboard), await card.locator('.color-space-compare-code-value').textContent());
    }
    await page.locator('.app-toast:not(.hiding) .app-toast-close').evaluateAll(nodes => nodes.forEach(node => node.click()));
    await page.waitForFunction(() => !document.querySelector('.app-toast'));
    await page.locator('.color-space-compare-summary').evaluate(node => { node.scrollTop = 0; });
    await page.locator('.color-space-compare-controls').evaluate(node => { node.scrollTop = 0; });
    await settle(page);
    await page.screenshot({ path: path.join(output, `${theme}-out-of-gamut.png`) });

    const before = await colorState(page);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme === 'light' ? 'dark' : 'light'; }, theme);
    await settle(page);
    assert.deepEqual(await colorState(page), before, 'theme switch must preserve exact values and canvas pixels');
    if (theme === 'dark') await checkLight(page);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const [width, height] of [[1100, 700], [900, 650], [720, 600], [390, 700]]) {
      await page.setViewportSize({ width, height });
      await settle(page);
      await checkLayout(page);
      await page.screenshot({ path: path.join(output, `${theme}-${width}.png`) });
      if (width <= 760) {
        const control = row(page, 'cmyk', 'k').locator('[role="slider"]');
        await control.press('ArrowUp');
        await settle(page);
        await checkLayout(page);
        const bounds = await control.boundingBox();
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, 'last model remains reachable');
        assert.ok(await row(page, 'cmyk', 'k').locator('canvas').evaluate(canvas => {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          return pixels.some((value, index) => index % 4 === 3 && value > 0);
        }), 'scrolled model track must render');
        await page.screenshot({ path: path.join(output, `${theme}-${width}-controls.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.keyboard.press('Escape');
    await page.locator('#colorSpaceCompareOverlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#colorSpaceCompareOverlay').evaluate(node => node.contains(document.activeElement)), false);
    assert.equal(await page.locator('.color-space-compare-track canvas').evaluateAll(nodes => nodes.every(node => node.width === 1)), true);
    assert.equal(await page.locator('.color-space-compare-wheel-canvas').evaluateAll(nodes => nodes.every(node => node.width === 1)), true);
    await openTool(page);
    assert.equal(await page.locator('[data-role="hex"]').textContent(), '#808080');
    await page.locator('[data-csc-close]').click();
    await page.locator('.audio-list-item[data-tool="color-extractor"]').evaluate(node => node.click());
    await page.locator('#colorExtractorOverlay.visible').waitFor();
    await page.locator('#colorExtractorBack').click();
    await openTool(page);
    if (theme === 'light') await checkLight(page);
    await page.locator('[data-csc-close]').click();
    await page.locator('#homeV2Settings').click();
    await page.locator('#settingsOverlay [data-lang="en"]').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en' && !document.body.matches('.fade-in, .fade-out'));
    await page.locator('#settingsBack').click();
    await openTool(page);
    assert.equal(await page.locator('[data-wheel="hsv"] [data-role="wheel-hit"]').getAttribute('aria-label'), 'HSV color wheel');
    await checkLayout(page);
    if (theme === 'light') await checkLight(page);
    await page.screenshot({ path: path.join(output, `${theme}-english.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Color space theme browser regression passed: eight models, values, copy, gamut states, exact canvas colors, responsive layouts, language and lifecycle.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
