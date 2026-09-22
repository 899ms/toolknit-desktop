import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
const output = path.resolve('tmp/calculator-light');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {})
});

const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

async function createPage() {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('toolknit.theme.v3', 'light'));
  await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto(url);
  await page.waitForSelector('html[data-theme="light"]');
  return { page, errors };
}

async function openTool(page, toolId, overlayId) {
  const card = page.locator(`.audio-list-item[data-tool="${toolId}"]`);
  await card.waitFor({ state: 'attached' });
  await card.evaluate(node => node.click());
  await page.waitForSelector(`${overlayId}.visible`);
  await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).opacity === '1', overlayId);
}

async function color(page, selector, property = 'backgroundColor') {
  return page.locator(selector).first().evaluate((node, key) => getComputedStyle(node)[key], property);
}

async function verifyBase(page, {
  overlay,
  workspace,
  panel,
  active,
  inactive,
  input,
  controls
}) {
  assert.equal(await color(page, overlay), 'rgb(255, 255, 255)');
  assert.equal(await color(page, `${overlay} .pdf-merge-v2-bg`, 'display'), 'none');
  assert.equal(await color(page, overlay, 'opacity'), '1');
  assert.equal(await color(page, workspace), 'rgb(255, 255, 255)');
  assert.equal(await color(page, panel), 'rgb(255, 255, 255)');
  assert.equal(await color(page, active), 'rgb(23, 23, 23)');
  assert.equal(await color(page, active, 'color'), 'rgb(255, 255, 255)');
  assert.equal(await color(page, inactive), 'rgb(245, 246, 247)');
  assert.equal(await color(page, inactive, 'color'), 'rgb(23, 23, 23)');
  assert.equal(await color(page, input), 'rgb(245, 246, 247)');
  assert.equal(await color(page, input, 'color'), 'rgb(23, 23, 23)');
  assert.equal(await page.locator(controls).evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true);
  assert.equal(await page.locator(overlay).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
}

async function verifyViewport(page, overlay, controls, width, height) {
  await page.setViewportSize({ width, height });
  assert.equal(await page.locator(controls).evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true);
  assert.equal(await page.locator(overlay).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
}

async function verifySingleLine(page, selector) {
  assert.equal(await page.locator(selector).first().evaluate(node => {
    const style = getComputedStyle(node);
    return node.scrollWidth <= node.clientWidth + 1
      && node.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 1.2;
  }), true);
}

async function verifySchedulePeriods(page, selector) {
  const periods = await page.locator(`${selector} .mortgage-calc-schedule-row > span:first-child`).evaluateAll(nodes => nodes.map(node => ({
    text: node.textContent,
    color: getComputedStyle(node).color,
    rowColor: getComputedStyle(node.parentElement).color
  })));
  assert.ok(periods.length > 0, `${selector} has schedule periods`);
  for (const [index, period] of periods.entries()) {
    assert.equal(period.text, String(index + 1), `${selector} period numbering`);
    assert.equal(period.color, period.rowColor, `${selector} period ${index + 1} must use the readable row text color`);
  }
}

try {
  {
    const { page, errors } = await createPage();
    await openTool(page, 'bmi-calc', '#bmiCalcOverlay');
    await verifyBase(page, {
      overlay: '#bmiCalcOverlay',
      workspace: '.bmi-calc-v2-workspace',
      panel: '.bmi-calc-input-panel',
      active: '#bmiCalcModeTabs .active',
      inactive: '#bmiCalcModeTabs .bmi-calc-mode-tab:not(.active)',
      input: '#bmiCalcAge',
      controls: '.bmi-calc-mode-tab, .bmi-calc-gender-tab'
    });
    assert.equal(await page.locator('#bmiCalcResultContent').isVisible(), true);
    assert.equal(await color(page, '#bmiCard'), 'rgb(245, 246, 247)');
    assert.notEqual(await color(page, '#bmiTag', 'color'), await color(page, '#bmiTag', 'backgroundColor'));
    await page.locator('#bmiCalcModeTabs [data-mode="advanced"]').click();
    await page.locator('#bmiCalcGenderTabs [data-gender="female"]').click();
    assert.equal(await color(page, '#bmiCalcModeTabs [data-mode="advanced"]'), 'rgb(23, 23, 23)');
    assert.equal(await color(page, '#bmiCalcGenderTabs [data-gender="female"]'), 'rgb(23, 23, 23)');
    await verifySingleLine(page, '.bmi-calc-v2 .pdf-merge-v2-title');
    await verifySingleLine(page, '.bmi-calc-v2 .bmi-calc-panel-head h2');
    await page.screenshot({ path: path.join(output, 'bmi-1366.png') });
    await verifyViewport(page, '#bmiCalcOverlay', '.bmi-calc-mode-tab, .bmi-calc-gender-tab', 900, 700);
    await page.screenshot({ path: path.join(output, 'bmi-900.png') });
    assert.deepEqual(errors, []);
    await page.close();
  }

  {
    const { page, errors } = await createPage();
    await openTool(page, 'timestamp-calc', '#tsCalcOverlay');
    await verifyBase(page, {
      overlay: '#tsCalcOverlay',
      workspace: '.timestamp-calc-v2-workspace',
      panel: '.ts-calc-input-panel',
      active: '#tsCalcModeTabs .active',
      inactive: '#tsCalcModeTabs .ts-calc-mode-tab:not(.active)',
      input: '#tsCalcInput',
      controls: '.ts-calc-mode-tab, .ts-calc-format-tab, .ts-calc-copy-btn'
    });
    assert.equal(await page.locator('#tsCalcResultEmpty').isVisible(), true);
    assert.equal(await color(page, '#tsCalcNowSec'), 'rgba(0, 0, 0, 0)');
    assert.equal(await color(page, '#tsCalcNowSec', 'color'), 'rgb(23, 23, 23)');
    await page.locator('#tsCalcInput').fill('1700000000');
    assert.equal(await page.locator('#tsCalcResultContent').isVisible(), true);
    assert.equal(await color(page, '#tsCalcResultCard'), 'rgb(245, 246, 247)');
    await page.locator('#tsCalcFormatTabs [data-fmt="iso"]').click();
    assert.equal(await color(page, '#tsCalcFormatTabs [data-fmt="iso"]'), 'rgb(23, 23, 23)');
    await verifySingleLine(page, '.timestamp-calc-v2 .pdf-merge-v2-title');
    await verifySingleLine(page, '.timestamp-calc-v2 .ts-calc-panel-head h2');
    await page.screenshot({ path: path.join(output, 'timestamp-1366.png') });
    await verifyViewport(page, '#tsCalcOverlay', '.ts-calc-mode-tab, .ts-calc-format-tab, .ts-calc-copy-btn', 900, 700);
    await page.screenshot({ path: path.join(output, 'timestamp-900.png') });
    assert.deepEqual(errors, []);
    await page.close();
  }

  {
    const { page, errors } = await createPage();
    await openTool(page, 'mortgage-calc', '#mortgageCalcOverlay');
    await verifyBase(page, {
      overlay: '#mortgageCalcOverlay',
      workspace: '.mortgage-calc-v2-workspace',
      panel: '.mortgage-calc-input-panel',
      active: '#mortgageCalcMethodTabs .active',
      inactive: '#mortgageCalcMethodTabs .mortgage-calc-method-tab:not(.active)',
      input: '#mortgageCalcAmount',
      controls: '.mortgage-calc-method-tab, .mortgage-calc-calc-btn'
    });
    assert.equal(await page.locator('#mortgageCalcResultEmpty').isVisible(), true);
    assert.equal(await color(page, '#mortgageCalcBtn'), 'rgb(23, 23, 23)');
    await page.locator('#mortgageCalcBtn').click();
    await verifySchedulePeriods(page, '#mortgageCalcScheduleBody');
    await page.locator('#mortgageCalcMethodTabs [data-method="equalPrincipal"]').click();
    await page.locator('#mortgageCalcBtn').click();
    assert.equal(await page.locator('#mortgageCalcResultContent').isVisible(), true);
    assert.ok(await page.locator('#mortgageCalcScheduleBody .mortgage-calc-schedule-row').count() > 0);
    await verifySchedulePeriods(page, '#mortgageCalcScheduleBody');
    assert.equal(await color(page, '.mortgage-calc-card'), 'rgb(245, 246, 247)');
    await verifySingleLine(page, '.mortgage-calc-v2 .pdf-merge-v2-title');
    await verifySingleLine(page, '.mortgage-calc-v2 .mortgage-calc-panel-head h2');
    assert.equal(await page.locator('#mortgageCalcOverlay .mortgage-calc-card').evaluateAll(nodes => nodes.every(node => node.clientWidth >= 200)), true);
    await page.screenshot({ path: path.join(output, 'mortgage-1366.png') });
    await verifyViewport(page, '#mortgageCalcOverlay', '.mortgage-calc-method-tab, .mortgage-calc-calc-btn', 900, 700);
    await verifySchedulePeriods(page, '#mortgageCalcScheduleBody');
    await page.screenshot({ path: path.join(output, 'mortgage-900.png') });
    assert.deepEqual(errors, []);
    await page.close();
  }

  {
    const { page, errors } = await createPage();
    await openTool(page, 'interest-calc', '#interestCalcOverlay');
    await verifyBase(page, {
      overlay: '#interestCalcOverlay',
      workspace: '.interest-calc-v2-workspace',
      panel: '.mortgage-calc-input-panel',
      active: '#interestCalcModeTabs .active',
      inactive: '#interestCalcModeTabs .mortgage-calc-method-tab:not(.active)',
      input: '#interestCalcPrincipal',
      controls: '.mortgage-calc-method-tab, .mortgage-calc-calc-btn'
    });
    assert.equal(await page.locator('#interestCalcResultEmpty').isVisible(), true);
    await page.locator('#interestCalcBtn').click();
    await verifySchedulePeriods(page, '#interestCalcScheduleBody');
    await page.locator('#interestCalcModeTabs [data-mode="compound"]').click();
    assert.equal(await page.locator('#interestCalcFreqField').isVisible(), true);
    await page.locator('#interestCalcFreqTabs [data-freq="monthly"]').click();
    assert.equal(await color(page, '#interestCalcFreqTabs [data-freq="monthly"]'), 'rgb(23, 23, 23)');
    await page.locator('#interestCalcBtn').click();
    assert.equal(await page.locator('#interestCalcResultContent').isVisible(), true);
    assert.ok(await page.locator('#interestCalcScheduleBody .mortgage-calc-schedule-row').count() > 0);
    await verifySchedulePeriods(page, '#interestCalcScheduleBody');
    assert.equal(await color(page, '.interest-calc-v2 .mortgage-calc-card'), 'rgb(245, 246, 247)');
    await verifySingleLine(page, '.interest-calc-v2 .pdf-merge-v2-title');
    await verifySingleLine(page, '.interest-calc-v2 .mortgage-calc-panel-head h2');
    await page.screenshot({ path: path.join(output, 'interest-1366.png') });
    await verifyViewport(page, '#interestCalcOverlay', '.mortgage-calc-method-tab, .mortgage-calc-calc-btn', 900, 700);
    await page.locator('#interestCalcModeTabs [data-mode="recurring"]').click();
    await page.locator('#interestCalcBtn').click();
    await verifySchedulePeriods(page, '#interestCalcScheduleBody');
    await page.screenshot({ path: path.join(output, 'interest-900.png') });
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log('Calculator light browser regression passed: BMI, timestamp, mortgage and interest');
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
