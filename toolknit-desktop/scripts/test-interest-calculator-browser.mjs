import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { calculateInterest, formatInterestMoney } from '../src/features/interest-calculator/core.js';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const card = page.locator('.audio-list-item[data-tool="interest-calc"]');
  await card.waitFor({ state: 'attached' });
  await card.evaluate(node => node.click());
  await page.waitForSelector('#interestCalcOverlay.visible');
  const selection = async (group, key, value) => {
    const active = page.locator(`${group} .active`);
    assert.equal(await active.count(), 1);
    assert.equal(await active.getAttribute(`data-${key}`), value);
    assert.equal(await page.locator(`${group} [aria-pressed="true"]`).count(), 1);
    assert.equal(await active.getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(group => getComputedStyle(document.querySelector(`${group} .active`)).backgroundColor === 'rgb(255, 255, 255)', group);
    const color = await active.evaluate(node => ({ bg: getComputedStyle(node).backgroundColor, fg: getComputedStyle(node).color }));
    assert.equal(color.bg, 'rgb(255, 255, 255)');
    assert.notEqual(color.fg, color.bg);
  };
  const result = async (mode, frequency = 'yearly') => {
    await page.locator('#interestCalcBtn').click();
    const expected = calculateInterest({ principal: 10000, regularAmount: 1000, annualRate: 5, termYears: 10, mode, frequency });
    assert.equal(await page.locator('#interestCalcTotalValue').innerText(), formatInterestMoney(expected.totalAmount));
  };
  await selection('#interestCalcModeTabs', 'mode', 'simple');
  for (const mode of ['compound', 'recurring', 'simple', 'compound']) {
    await page.locator(`#interestCalcModeTabs [data-mode="${mode}"]`).click();
    await selection('#interestCalcModeTabs', 'mode', mode);
    assert.equal(await page.locator('#interestCalcPrincipalField').isVisible(), mode !== 'recurring');
    assert.equal(await page.locator('#interestCalcRegularField').isVisible(), mode === 'recurring');
    assert.equal(await page.locator('#interestCalcFreqField').isVisible(), mode === 'compound');
    await result(mode);
  }
  for (const frequency of ['monthly', 'daily', 'yearly']) {
    await page.locator(`#interestCalcFreqTabs [data-freq="${frequency}"]`).click();
    await selection('#interestCalcFreqTabs', 'freq', frequency);
    await result('compound', frequency);
  }
  await page.locator('#interestCalcFreqTabs [data-freq="monthly"]').focus();
  await page.keyboard.press('Space');
  await selection('#interestCalcFreqTabs', 'freq', 'monthly');
  await result('compound', 'monthly');
  for (const [width, height] of [[1366, 900], [1100, 700], [900, 700], [720, 480]]) {
    await page.setViewportSize({ width, height });
    const bounds = await page.locator('#interestCalcFreqTabs button').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect();
      return { top: r.top, width: r.width, client: node.clientWidth, scroll: node.scrollWidth };
    }));
    assert.equal(bounds.length, 3);
    assert.ok(Math.max(...bounds.map(r => r.top)) - Math.min(...bounds.map(r => r.top)) < 2, 'three frequency buttons share one row');
    assert.ok(bounds.every(r => r.width > 0 && r.scroll <= r.client + 1), 'frequency labels fit their buttons');
    assert.equal(await page.locator('#interestCalcModeTabs').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 2,
      'mode selection retains its two-column layout');
    const workspace = await page.locator('#interestCalcMain').evaluate(node => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      columns: getComputedStyle(node).gridTemplateColumns.split(' ').length,
      grid: getComputedStyle(node).gridTemplateColumns,
      children: [...node.children].map(child => ({
        className: child.className,
        clientWidth: child.clientWidth,
        scrollWidth: child.scrollWidth
      }))
    }));
    assert.ok(workspace.scrollWidth <= workspace.clientWidth + 1,
      `calculator workspace must not be clipped horizontally at ${width}px (${JSON.stringify(workspace)})`);
    if (width <= 1260) assert.equal(workspace.columns, 1, 'compact calculator workspace uses one column');
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await mkdir('tmp/interest-calculator', { recursive: true });
  await page.screenshot({ path: 'tmp/interest-calculator/selected-monthly.png' });
  await page.locator('#interestCalcBack').click();
  await card.evaluate(node => node.click());
  await page.waitForSelector('#interestCalcOverlay.visible');
  await selection('#interestCalcModeTabs', 'mode', 'simple');
  await page.locator('#interestCalcModeTabs [data-mode="compound"]').click();
  await selection('#interestCalcFreqTabs', 'freq', 'yearly');
  assert.deepEqual(errors, []);
  console.log('Interest browser regression passed: selected states, correct results, keyboard, single-row frequency and reopen');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
