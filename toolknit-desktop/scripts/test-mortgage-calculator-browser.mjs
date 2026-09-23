import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { calculateMortgage } from '../src/features/mortgage-calculator/core.js';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const card = page.locator('.audio-list-item[data-tool="mortgage-calc"]');
  await card.waitFor({ state: 'attached' });
  await card.evaluate(node => node.click());
  await page.waitForSelector('#mortgageCalcOverlay.visible');
  const group = page.locator('#mortgageCalcMethodTabs');
  const selection = async method => {
    const active = group.locator('.active');
    assert.equal(await active.count(), 1);
    assert.equal(await active.getAttribute('data-method'), method, 'highlight must match the selected repayment method');
    assert.equal(await active.getAttribute('aria-pressed'), 'true');
    assert.equal(await group.locator('[aria-pressed="true"]').count(), 1);
    assert.equal(await group.locator(':not(.active)[data-method]').getAttribute('aria-pressed'), 'false');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#mortgageCalcMethodTabs .active')).backgroundColor === 'rgb(255, 255, 255)');
    const colors = await group.locator('[data-method]').evaluateAll(nodes => nodes.map(node => ({
      active: node.classList.contains('active'), background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color
    })));
    assert.equal(colors.find(item => item.active).color, 'rgb(5, 5, 6)');
    assert.notEqual(colors.find(item => !item.active).background, 'rgb(255, 255, 255)');
  };
  const result = async method => {
    await page.locator('#mortgageCalcBtn').click();
    const expected = calculateMortgage({ amountWan: 100, termYears: 30, annualRate: 4.2, method });
    assert.equal(await page.locator('#mortgageCalcMonthlyValue').innerText(), expected.monthlyDisplay);
    assert.equal(await page.locator('#mortgageCalcScheduleBody').locator('.mortgage-calc-schedule-row').count(), expected.schedule.length);
  };
  assert.equal(await group.locator('.active').getAttribute('data-method'), 'equalPayment');
  for (const method of ['equalPrincipal', 'equalPayment', 'equalPrincipal', 'equalPrincipal']) {
    await group.locator(`[data-method="${method}"]`).click();
    await selection(method);
    await result(method);
  }
  await group.locator('[data-method="equalPayment"]').focus();
  await page.keyboard.press('Space');
  await selection('equalPayment');
  await result('equalPayment');
  await group.locator('[data-method="equalPrincipal"]').focus();
  await page.keyboard.press('Enter');
  await selection('equalPrincipal');
  await result('equalPrincipal');
  for (const [width, height] of [[1366, 900], [720, 480]]) {
    await page.setViewportSize({ width, height });
    await group.scrollIntoViewIfNeeded();
    await selection('equalPrincipal');
    const bounds = await group.locator('button').evaluateAll(nodes => nodes.map(node => ({
      client: node.clientWidth, scroll: node.scrollWidth, height: node.getBoundingClientRect().height
    })));
    assert.ok(bounds.every(item => item.client > 0 && item.scroll <= item.client + 1 && item.height >= 42));
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await group.scrollIntoViewIfNeeded();
  await mkdir('tmp/mortgage-calculator', { recursive: true });
  await page.screenshot({ path: 'tmp/mortgage-calculator/selected-equal-principal.png' });
  await page.locator('#mortgageCalcBack').click();
  await page.waitForSelector('#mortgageCalcOverlay:not(.visible)');
  await card.evaluate(node => node.click());
  await page.waitForSelector('#mortgageCalcOverlay.visible');
  await selection('equalPayment');
  await result('equalPayment');
  assert.deepEqual(errors, []);
  console.log('Mortgage browser regression passed: highlight, calculation, keyboard, viewport fit and reopen');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
