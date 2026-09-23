import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { calculateBmi } from '../src/features/bmi-calculator/core.js';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;
const output = path.resolve('tmp/bmi-calculator');
await mkdir(output, { recursive: true });
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const card = page.locator('.audio-list-item[data-tool="bmi-calc"]');
  await card.waitFor({ state: 'attached' });
  await card.evaluate(node => node.click());
  await page.waitForSelector('#bmiCalcOverlay.visible');
  await page.locator('#bmiCalcModeTabs [data-mode="advanced"]').click();
  await page.locator('#bmiCalcGenderTabs [data-gender="female"]').click();
  for (const field of ['Waist', 'Neck', 'Hip']) {
    assert.match(await page.locator(`label[for="bmiCalc${field}"]`).innerText(), /\(cm\)/);
  }
  assert.equal(await page.locator('#bodyFatValue').innerText(), '--');
  const fill = async values => {
    for (const [field, value] of Object.entries(values)) {
      await page.locator(`#bmiCalc${field[0].toUpperCase()}${field.slice(1)}`).fill(String(value));
    }
  };
  const values = { waist: 80, neck: 34, hip: 95 };
  await fill(values);
  const inputs = { age: 25, height: 170, weight: 65, gender: 'female', mode: 'advanced', ...values };
  assert.equal(await page.locator('#bodyFatValue').innerText(), `${calculateBmi(inputs).bodyFat.toFixed(1)}%`);
  const stable = await page.locator('#bmiValue, #bmrValue, #idealWeightValue').allTextContents();
  for (const field of ['waist', 'neck', 'hip']) {
    const before = await page.locator('#bodyFatValue, #fatMassValue, #leanMassValue').allTextContents();
    await fill({ [field]: values[field] + 5 });
    const after = await page.locator('#bodyFatValue, #fatMassValue, #leanMassValue').allTextContents();
    after.forEach((value, index) => assert.notEqual(value, before[index], `${field} must update all body-fat-derived values`));
    assert.deepEqual(await page.locator('#bmiValue, #bmrValue, #idealWeightValue').allTextContents(), stable);
    await fill({ [field]: values[field] });
  }
  await fill({ waist: 35, neck: 40, hip: 32 });
  for (const id of ['bodyFatValue', 'fatMassValue', 'leanMassValue']) assert.equal(await page.locator(`#${id}`).innerText(), '--');
  assert.equal(await page.locator('#bmiCalcBarMarker').isHidden(), true);
  assert.equal(await page.locator('#bodyFatTag').getAttribute('class'), 'bmi-calc-card-tag', 'invalid values must not retain a health classification');
  await page.screenshot({ path: path.join(output, 'invalid-measurements.png') });
  await page.locator('#bmiCalcModeTabs [data-mode="simple"]').click();
  assert.equal(await page.locator('#bodyFatValue').innerText(), '27.3%');
  await page.locator('#bmiCalcModeTabs [data-mode="advanced"]').click();
  assert.equal(await page.locator('#bodyFatValue').innerText(), '--', 'advanced mode must never reuse the simple result');
  await fill(values);
  assert.equal(await page.locator('#bmiCalcBarMarker').isVisible(), true);
  await page.locator('#bmiCalcHip').fill('');
  assert.equal(await page.locator('#bodyFatValue').innerText(), '--');
  await page.locator('#bmiCalcGenderTabs [data-gender="male"]').click();
  assert.equal(await page.locator('#bmiCalcHipField').isHidden(), true);
  assert.notEqual(await page.locator('#bodyFatValue').innerText(), '--', 'male formula must ignore missing hips');
  await page.locator('#bmiCalcGenderTabs [data-gender="female"]').click();
  assert.equal(await page.locator('#bodyFatValue').innerText(), '--');
  await fill(values);
  await page.screenshot({ path: path.join(output, 'valid-measurements.png') });
  await page.locator('#bmiCalcBack').click();
  await card.evaluate(node => node.click());
  await page.waitForSelector('#bmiCalcOverlay.visible');
  await fill({ waist: 85 });
  assert.equal(await page.locator('#bodyFatValue').innerText(), `${calculateBmi({ ...inputs, waist: 85 }).bodyFat.toFixed(1)}%`);
  assert.deepEqual(errors, []);
  console.log('BMI browser regression passed: live measurements, invalid/empty values, mode/gender switching and reopen');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
