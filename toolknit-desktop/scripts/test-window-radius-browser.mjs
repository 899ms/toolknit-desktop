import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const endpoint = process.env.TOOLKNIT_CDP_ENDPOINT;
if (endpoint && process.env.TOOLKNIT_TEST_ISOLATED_NATIVE !== '1') {
  throw new Error('Native checks change local test preferences. Use only an isolated diagnostic application and set TOOLKNIT_TEST_ISOLATED_NATIVE=1.');
}
const output = path.resolve('tmp/window-radius-fix', endpoint ? 'native' : 'browser');
await mkdir(output, { recursive: true });
const report = { native: Boolean(endpoint), samples: [], errors: [], frameCheck: 'CSS maximized state; native frame queue has separate contract coverage' };
let server;
let browser;
let page;
let cdp;
let originalPreferences;
const keys = ['toolknit.theme.v3', 'toolknit.window-radius.v3'];

async function settled() {
  await page.waitForFunction(() => {
    const veil = document.querySelector('[data-tk-page-transition-veil]');
    return !veil || getComputedStyle(veil).visibility === 'hidden';
  });
}

async function capture(label, radius, maximized = false) {
  const state = await page.evaluate(() => ({
    radius: getComputedStyle(document.body).getPropertyValue('--toolknit-window-radius').trim(),
    clip: getComputedStyle(document.body).clipPath,
    background: getComputedStyle(document.body).backgroundColor,
    width: innerWidth, height: innerHeight,
    scrollTop: document.querySelector('.app .main-content').scrollTop
  }));
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const png = Buffer.from(data, 'base64');
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data];
  const corners = [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]
    .map(([x, y]) => pixel(x, y));
  const opaque = radius === 0 || maximized;
  const sample = { label, ...state, corners, opaque };
  report.samples.push(sample);
  await writeFile(path.join(output, `${label}.png`), png);
  assert.equal(state.radius, `${radius}px`, `${label}: saved radius remains applied`);
  assert.ok(corners.every(color => opaque ? color[3] >= 254 : color[3] <= 1),
    `${label}: ${opaque ? 'rectangular surface stays opaque' : 'all four corners stay transparent'}, ${JSON.stringify(corners)}`);
  if (!opaque) {
    assert.equal(state.background, 'rgba(0, 0, 0, 0)', `${label}: body cannot fill the clipping exterior`);
    assert.equal(state.clip, `inset(0px round ${radius}px)`);
  }
  assert.ok(pixel(Math.floor(image.width / 2), 0)[3] >= 254, `${label}: the actual page is not made transparent`);
  return sample;
}

async function reload(theme, radius) {
  await page.evaluate(({ theme, radius }) => {
    localStorage.setItem('toolknit.theme.v3', theme);
    localStorage.setItem('toolknit.window-radius.v3', JSON.stringify({ mode: 'custom', custom: radius }));
  }, { theme, radius });
  await page.reload();
  await page.waitForFunction(({ theme, radius }) =>
    document.documentElement.dataset.theme === theme
      && getComputedStyle(document.body).getPropertyValue('--toolknit-window-radius').trim() === `${radius}px`
      && document.querySelector('#homeToolGrid .tool-result-card'), { theme, radius });
  await settled();
}

try {
  if (endpoint) {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => /\/\/tauri\.localhost\//.test(candidate.url()));
    assert.ok(page, 'isolated native application page exists');
  } else {
    server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0, open: false } });
    browser = await chromium.launch({ headless: true,
      ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
    page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const url = server.resolvedUrls.local[0];
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin
      ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.goto(url);
  }
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForSelector('#homeToolGrid .tool-result-card', { state: 'attached' });
  originalPreferences = await page.evaluate(keys => keys.map(key => [key, localStorage.getItem(key)]), keys);
  cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  if (!endpoint) await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  report.engine = browser.version();

  for (const theme of ['light', 'dark']) {
    for (const radius of [0, 10, 18, 32]) {
      await reload(theme, radius);
      await capture(`${theme}-reload-${radius}`, radius);
    }
    const radius = 32;
    await page.mouse.move(500, 350);
    for (let index = 0; index < 18; index += 1) {
      await page.mouse.wheel(0, index < 9 ? 150 : -150);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await capture(`${theme}-scroll-${index}`, radius);
    }
    assert.ok(report.samples.some(sample => sample.label.startsWith(`${theme}-scroll-`) && sample.scrollTop > 300), 'wheel checks must really scroll the home content');
    for (const [tool, overlay, back] of [
      ['pdf-compress', 'pdfCompressOverlay', 'pdfCompressBack'],
      ['pdf-merge', 'pdfMergeOverlay', 'pdfMergeBack']
    ]) {
      await page.evaluate(tool => document.querySelector(`[data-home-tool="${tool}"],.audio-list-item[data-tool="${tool}"]`).click(), tool);
      await page.waitForSelector(`#${overlay}.visible`);
      await settled();
      await capture(`${theme}-${tool}`, radius);
      await page.locator(`#${back}`).click();
      await settled();
      await capture(`${theme}-${tool}-return`, radius);
    }
    await page.locator('#homeV2Settings').click();
    await settled();
    await capture(`${theme}-settings`, radius);
    await page.locator('#settingsBack').click();
    await settled();
    await capture(`${theme}-settings-return`, radius);
    // Validate CSS state without maximizing an offscreen test window over the
    // user's application. Native lifecycle/state sequencing is tested separately.
    await page.evaluate(() => {
      document.documentElement.classList.add('window-is-maximized');
      document.body.classList.add('window-is-maximized');
      document.documentElement.style.removeProperty('clip-path');
      document.documentElement.style.removeProperty('-webkit-clip-path');
    });
    await capture(`${theme}-maximized-css`, radius, true);
    await page.evaluate(() => {
      document.documentElement.classList.remove('window-is-maximized');
      document.body.classList.remove('window-is-maximized');
    });
    await capture(`${theme}-restored-css`, radius);
    await reload(theme, radius);
    await capture(`${theme}-final-reload`, radius);
  }
  assert.deepEqual(report.errors, []);
  console.log(`Window corner pixel checks passed: ${report.samples.length} samples (${report.native ? 'native WebView2' : 'browser'}).`);
} catch (error) {
  report.failure = String(error.stack || error);
  throw error;
} finally {
  if (originalPreferences && page && !page.isClosed()) {
    await page.evaluate(entries => entries.forEach(([key, value]) => value === null
      ? localStorage.removeItem(key) : localStorage.setItem(key, value)), originalPreferences).catch(() => {});
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await cdp?.detach().catch(() => {});
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
