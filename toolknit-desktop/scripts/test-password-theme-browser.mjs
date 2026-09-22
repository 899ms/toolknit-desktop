import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/password-theme');
await mkdir(output, { recursive: true });
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;

async function openTool(page) {
  await page.locator('.audio-list-item[data-tool="password-gen"]').evaluate(node => node.click());
  await page.waitForSelector('#passwordGenOverlay.visible');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#passwordGenOverlay')).opacity === '1');
}

async function assertReadable(page, selectors) {
  const failures = await page.locator(selectors).evaluateAll(nodes => {
    const rgba = value => value.match(/[\d.]+/g).map(Number);
    const composite = (front, back) => front.slice(0, 3).map((value, i) => value * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)));
    const luminance = channels => channels.reduce((sum, value, i) => {
      const c = value / 255;
      return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
    }, 0);
    return nodes.flatMap(node => {
      const chain = [];
      for (let parent = node; parent; parent = parent.parentElement) chain.unshift(parent);
      const background = chain.reduce((current, element) => composite(rgba(getComputedStyle(element).backgroundColor), current), [255, 255, 255]);
      const ink = composite(rgba(getComputedStyle(node).color), background);
      const [light, dark] = [luminance(ink), luminance(background)].sort((a, b) => b - a);
      const contrast = (light + 0.05) / (dark + 0.05);
      return contrast >= 4.5 ? [] : [{ element: node.id || node.className, contrast }];
    });
  });
  assert.deepEqual(failures, [], 'password controls and results must have readable text contrast');
}

async function assertFits(page) {
  const failures = await page.locator('#passwordGenOverlay button, #passwordGenOverlay .pdf-merge-v2-title, #passwordGenOutput, .password-gen-composition-item, .password-gen-history-item').evaluateAll(nodes => nodes
    .filter(node => node.getBoundingClientRect().width > 0 && node.scrollWidth > node.clientWidth + 1)
    .map(node => node.id || node.className));
  assert.deepEqual(failures, [], 'password text and controls must not overflow');
  const overlaps = await page.locator('.password-gen-history-item').evaluateAll(nodes => nodes.some(node => {
    const [text, button] = node.children;
    return text.getBoundingClientRect().right > button.getBoundingClientRect().left;
  }));
  assert.equal(overlaps, false, 'history copy buttons must remain beside the password');
  assert.equal(await page.locator('#passwordGenMain').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'password workspace must fit horizontally');
  assert.equal(await page.locator('.password-gen-panel-head h2').evaluateAll(nodes => nodes.every(node =>
    node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1
  )), true, 'panel headings must not be squeezed into multiple lines');
}

const controls = '.password-gen-strength-tab, .password-gen-strength-desc, .password-gen-length-value, .password-gen-option span';
const results = '#passwordGenOutput, #passwordGenCopyBtn, .password-gen-strength-label span, .password-gen-composition-item span, .password-gen-composition-item strong, .password-gen-history-title, #passwordGenClearBtn, .password-gen-history-item > span, .password-gen-history-item-copy';

try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => {
      localStorage.setItem('toolknit.theme.v3', theme);
      // Exercise copy feedback without replacing the user's system clipboard.
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__passwordTestClipboard = text; } } });
    }, theme);
    await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await openTool(page);
    assert.equal(await page.locator('#passwordGenResultEmpty').isVisible(), true);
    assert.equal(await page.locator('#passwordGenResultContent').isVisible(), false);
    assert.equal(await page.locator('.password-gen-panel-head').first().evaluate(node => getComputedStyle(node).display), 'flex', 'cold open loads shared panel layout');
    assert.equal(await page.locator('#passwordGenBtn').evaluate(node => getComputedStyle(node).borderRadius), '13px', 'cold open loads shared button geometry');
    if (theme === 'light') {
      await assertReadable(page, `${controls}, #passwordGenResultEmpty p`);
      const slider = await page.locator('#passwordGenLengthSlider').evaluate(node => ({
        track: getComputedStyle(node).backgroundColor,
        thumb: getComputedStyle(node, '::-webkit-slider-thumb').backgroundColor,
        accent: getComputedStyle(document.querySelector('#passwordGenLowercase')).accentColor
      }));
      assert.notEqual(slider.track, 'rgba(255, 255, 255, 0.12)');
      assert.notEqual(slider.thumb, 'rgb(255, 255, 255)');
      assert.notEqual(slider.accent, 'rgb(255, 255, 255)');
    }
    await page.screenshot({ path: path.join(output, `${theme}-empty.png`) });
    for (const [preset, length] of [['simple', 8], ['medium', 16], ['ultimate', 24]]) {
      await page.locator(`[data-strength="${preset}"]`).click();
      assert.equal(await page.locator('#passwordGenLengthValue').textContent(), String(length));
      await page.locator('#passwordGenBtn').click();
      await page.waitForFunction(length => document.querySelector('#passwordGenOutput').textContent.length === length, length);
      assert.equal(await page.locator('#passwordGenStatTotal').textContent(), String(length));
      if (theme === 'light') await assertReadable(page, `${controls}, ${results}`);
    }
    await page.locator('#passwordGenLengthSlider').focus();
    await page.keyboard.press('End');
    assert.equal(await page.locator('#passwordGenLengthValue').textContent(), '64');
    if (theme === 'light') assert.equal(await page.locator('#passwordGenLengthSlider').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    await page.locator('#passwordGenBtn').click();
    await page.waitForFunction(() => document.querySelector('#passwordGenOutput').textContent.length === 64);
    await page.locator('#passwordGenCopyBtn').click();
    assert.equal(await page.evaluate(() => window.__passwordTestClipboard === document.querySelector('#passwordGenOutput').textContent), true);
    await page.waitForFunction(() => document.querySelector('#passwordGenCopyBtn').textContent.includes('已复制'));
    if (theme === 'light') await assertReadable(page, '#passwordGenCopyBtn');
    await page.locator('.password-gen-history-item-copy').last().click();
    assert.equal(await page.evaluate(() => window.__passwordTestClipboard === document.querySelector('.password-gen-history-item:last-child > span').textContent), true);
    await page.locator('.password-gen-form, .password-gen-history-list').evaluateAll(nodes => nodes.forEach(node => { node.scrollTop = 0; }));
    await assertFits(page);
    await page.screenshot({ path: path.join(output, `${theme}-result-1400.png`) });
    for (const [width, height] of [[1100, 700], [900, 700], [720, 480]]) {
      await page.setViewportSize({ width, height });
      await page.locator('#passwordGenResultContent').scrollIntoViewIfNeeded();
      await assertFits(page);
      if (theme === 'light') await assertReadable(page, results);
      await page.screenshot({ path: path.join(output, `${theme}-result-${width}.png`) });
    }
    await page.locator('#passwordGenClearBtn').click();
    assert.equal(await page.locator('#passwordGenResultEmpty').isVisible(), true);
    assert.equal(await page.locator('.password-gen-history-item').count(), 0);
    assert.equal(await page.locator('#passwordGenOutput').textContent(), '');
    await page.locator('#passwordGenBtn').click();
    await page.locator('#passwordGenResultContent').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#passwordGenOverlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#passwordGenOutput').textContent(), '');
    await openTool(page);
    assert.equal(await page.locator('#passwordGenResultEmpty').isVisible(), true);
    await page.locator('#passwordGenBack').click();
    await page.locator('#passwordGenOverlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#passwordGenOverlay').evaluate(node => node.contains(document.activeElement)), false);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator('#homeV2Settings').click();
    await page.locator('#settingsOverlay [data-lang="en"]').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en' && !document.body.matches('.fade-in, .fade-out'));
    await page.locator('#settingsBack').click();
    await openTool(page);
    await page.locator('[data-strength="ultimate"]').click();
    await page.locator('#passwordGenBtn').click();
    await page.locator('#passwordGenResultContent').waitFor({ state: 'visible' });
    await assertFits(page);
    if (theme === 'light') await assertReadable(page, `${controls}, ${results}`);
    await page.screenshot({ path: path.join(output, `${theme}-english.png`) });
    const layoutSnapshot = () => page.locator('#passwordGenMain, #passwordGenBg, #passwordGenBtn, .password-gen-form, .password-gen-result-content, .password-gen-v2-poster, .password-gen-settings-panel, .password-gen-result-panel').evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node);
      return {
        display: style.display, columns: style.gridTemplateColumns,
        padding: style.padding, gap: style.gap, minHeight: style.minHeight,
        filter: style.filter,
        marker: getComputedStyle(node, '::after').content
      };
    }));
    const initialLayout = await layoutSnapshot();
    await page.locator('#passwordGenBack').click();
    await page.locator('.audio-list-item[data-tool="mortgage-calc"]').evaluate(node => node.click());
    await page.locator('#mortgageCalcOverlay.visible').waitFor();
    await page.locator('#mortgageCalcBack').click();
    await openTool(page);
    await page.locator('#passwordGenBtn').click();
    await page.locator('#passwordGenResultContent').waitFor({ state: 'visible' });
    assert.deepEqual(await layoutSnapshot(), initialLayout, 'visiting the mortgage tool must not change password layout');
    if (theme === 'light') await assertReadable(page, `${controls}, ${results}`);
    await page.setViewportSize({ width: 1100, height: 700 });
    await assertFits(page);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Password theme browser regression passed: light/dark, contrast, presets, slider, long passwords, copy feedback, history, compact layouts, language and reopen');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
