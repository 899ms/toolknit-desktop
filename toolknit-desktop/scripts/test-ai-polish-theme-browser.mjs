import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/ai-polish-theme');
const apiUrl = 'https://ai-polish.test/v1/chat/completions';
const sourceText = 'Clear writing helps teams make decisions without unnecessary delay.';
const polishedText = 'Clear writing helps teams make timely, confident decisions.';
const directions = { directions: [
  { name: 'Professional', desc: 'Use a precise and confident tone.' },
  { name: 'Concise', desc: 'Remove repetition and shorten the message.' },
  { name: 'Friendly', desc: 'Use an approachable and natural voice.' }
] };
const viewports = [
  { width: 1440, height: 900 },
  { width: 1100, height: 760 },
  { width: 900, height: 700 },
  { width: 720, height: 640 }
];

await mkdir(output, { recursive: true });
const server = await preview({
  configFile: false,
  logLevel: 'error',
  preview: { host: '127.0.0.1', port: 0, open: false }
});
let browser;

async function openTool(page) {
  await page.locator('.audio-list-item[data-tool="ai-polish"]').evaluate(node => node.click());
  await page.locator('#aiPolishOverlay.visible').waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#aiPolishOverlay')).opacity === '1');
}

async function assertReadable(page) {
  const failures = await page.locator(`#aiPolishOverlay :is(
    .pdf-merge-v2-title,
    .pdf-merge-v2-subtitle,
    .pdf-merge-v2-poster-note strong,
    .pdf-merge-v2-step strong,
    .pdf-merge-v2-step p,
    .ai-polish-v2-card-head h2,
    .ai-polish-v2-card-head p,
    .ai-polish-v2-source strong,
    .ai-polish-v2-source span,
    .ai-polish-v2-drop-card span,
    .ai-polish-v2-drop-card p,
    .ai-polish-v2-select-btn span,
    .ai-polish-v2-start-btn span,
    .ai-polish-right-empty p,
    .ai-polish-directions-title,
    .ai-polish-direction-btn-name,
    .ai-polish-direction-btn-desc,
    .ai-polish-direction-cancel,
    .ai-polish-polished
  )`).evaluateAll(nodes => {
    const rgba = value => (value.match(/[\d.]+/g) || ['0', '0', '0', '0']).map(Number);
    const composite = (front, back) => front.slice(0, 3)
      .map((value, index) => value * (front[3] ?? 1) + back[index] * (1 - (front[3] ?? 1)));
    const luminance = channels => channels.reduce((sum, value, index) => {
      const channel = value / 255;
      const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index];
    }, 0);
    return nodes.filter(node => node.getBoundingClientRect().width && node.textContent.trim()).flatMap(node => {
      const chain = [];
      for (let parent = node; parent; parent = parent.parentElement) chain.unshift(parent);
      const background = chain.reduce((current, element) => {
        const style = getComputedStyle(element);
        return composite(rgba(style.backgroundColor), current);
      }, [255, 255, 255]);
      const nodeStyle = getComputedStyle(node);
      const foreground = rgba(nodeStyle.color);
      foreground[3] = (foreground[3] ?? 1) * Number(nodeStyle.opacity);
      const ink = composite(foreground, background);
      const values = [luminance(ink), luminance(background)].sort((a, b) => b - a);
      const contrast = (values[0] + 0.05) / (values[1] + 0.05);
      return contrast >= 4.5 ? [] : [{
        element: node.id || node.getAttribute('data-i18n') || node.className,
        contrast,
        color: nodeStyle.color,
        background: nodeStyle.backgroundColor,
        opacity: nodeStyle.opacity,
        parent: node.parentElement?.className || ''
      }];
    });
  });
  assert.deepEqual(failures, [], 'light theme text must remain readable');
}

async function assertFits(page) {
  const layout = await page.locator('#aiPolishDrawer').evaluate(drawer => {
    const bounds = drawer.getBoundingClientRect();
    const cards = [...drawer.querySelectorAll(':scope > section')].filter(node => node.getBoundingClientRect().width);
    return {
      clientWidth: drawer.clientWidth,
      scrollWidth: drawer.scrollWidth,
      cards: cards.map(node => {
        const rect = node.getBoundingClientRect();
        return { name: node.className, left: rect.left, right: rect.right };
      }),
      left: bounds.left,
      right: bounds.right
    };
  });
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1,
    `workspace must not overflow horizontally: ${layout.scrollWidth}/${layout.clientWidth}`);
  for (const card of layout.cards) {
    assert.ok(card.left >= layout.left - 1 && card.right <= layout.right + 1,
      `${card.name} must remain inside the workspace`);
  }
  const controls = await page.locator('#aiPolishOverlay :is(button, .ai-polish-v2-source, .ai-polish-v2-drop-card)')
    .evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width && node.scrollWidth > node.clientWidth + 1)
      .map(node => node.id || node.className));
  assert.deepEqual(controls, [], 'AI polish controls must fit horizontally');
  const uploadGeometry = await page.locator('#aiPolishDropCard').evaluate(dropCard => {
    const card = dropCard.getBoundingClientRect();
    const button = dropCard.querySelector('#aiPolishSelectFileBtn').getBoundingClientRect();
    const input = document.querySelector('#aiPolishInput').getBoundingClientRect();
    return {
      card: { top: card.top, right: card.right, bottom: card.bottom, left: card.left },
      button: { top: button.top, right: button.right, bottom: button.bottom, left: button.left },
      inputTop: input.top
    };
  });
  assert.ok(uploadGeometry.button.top >= uploadGeometry.card.top - 1
    && uploadGeometry.button.right <= uploadGeometry.card.right + 1
    && uploadGeometry.button.bottom <= uploadGeometry.card.bottom + 1
    && uploadGeometry.button.left >= uploadGeometry.card.left - 1,
  'select button must remain inside the document drop surface');
  assert.ok(uploadGeometry.button.bottom <= uploadGeometry.inputTop + 1,
    'select button must not overlap the text editor');
}

async function assertLightSurface(page) {
  const colors = await page.locator('#aiPolishOverlay').evaluate(overlay => {
    const style = selector => getComputedStyle(overlay.querySelector(selector));
    return {
      card: style('.ai-polish-v2-input-card').backgroundColor,
      heading: style('.ai-polish-v2-card-head h2').color,
      meta: style('#aiPolishFileMeta').color,
      textarea: style('#aiPolishInput').backgroundColor,
      selectBackground: style('#aiPolishSelectFileBtn').backgroundColor,
      selectColor: style('#aiPolishSelectFileBtn').color,
      emptyIcon: style('.ai-polish-empty-icon').color
    };
  });
  assert.equal(colors.card, 'rgb(255, 255, 255)');
  assert.equal(colors.heading, 'rgb(23, 23, 23)');
  assert.equal(colors.meta, 'rgb(96, 99, 106)');
  assert.equal(colors.textarea, 'rgb(255, 255, 255)');
  assert.equal(colors.selectBackground, 'rgb(23, 23, 23)');
  assert.equal(colors.selectColor, 'rgb(255, 255, 255)');
  assert.equal(colors.emptyIcon, 'rgb(23, 23, 23)');
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {})
  });
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: viewports[0], reducedMotion: 'reduce' });
    const errors = [];
    let holdNextResponse = false;
    let releaseResponse = null;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ theme, apiUrl }) => {
      localStorage.setItem('toolknit.theme.v3', theme);
      localStorage.setItem('ai_platform', 'custom');
      localStorage.setItem('ai_custom_url', apiUrl);
      localStorage.setItem('ai_custom_model', 'theme-test-model');
      localStorage.setItem('ai_api_key', 'local-theme-test-not-a-real-key');
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async text => { window.__aiPolishClipboard = text; } }
      });
    }, { theme, apiUrl });
    await page.route('https://api.github.com/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]'
    }));
    await page.route(apiUrl, async route => {
      const body = route.request().postDataJSON();
      const analyzing = body.messages[1].content.startsWith('\u8bf7\u5206\u6790');
      if (holdNextResponse) {
        holdNextResponse = false;
        await new Promise(resolve => { releaseResponse = resolve; });
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: { content: analyzing ? JSON.stringify(directions) : polishedText }
          }]
        })
      });
    });
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
      await openTool(page);
      assert.equal(await page.locator('#aiPolishRightEmpty').isVisible(), true);
      if (theme === 'light') {
        await assertLightSurface(page);
        await assertReadable(page);
      }
      await assertFits(page);
      await page.screenshot({ path: path.join(output, `${theme}-empty.png`) });

      const importedName = 'quarterly-planning-notes-with-a-long-file-name.txt';
      await page.locator('#aiPolishFileInput').setInputFiles({
        name: importedName,
        mimeType: 'text/plain',
        buffer: Buffer.from(sourceText)
      });
      await page.waitForFunction(expected => document.querySelector('#aiPolishInput')?.value === expected, sourceText);
      await page.waitForFunction(() => !document.querySelector('#aiPolishOverlay')?.classList.contains('is-reading-file'));
      assert.equal(await page.locator('#aiPolishFileName').textContent(), importedName);
      if (theme === 'light') {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#aiPolishStartBtn')).backgroundColor === 'rgb(23, 23, 23)');
        await assertReadable(page);
      }
      await assertFits(page);
      await page.screenshot({ path: path.join(output, `${theme}-imported.png`) });

      holdNextResponse = true;
      await page.locator('#aiPolishStartBtn').click();
      await page.locator('#aiPolishMask.visible').waitFor();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#aiPolishMask')).opacity === '1');
      for (let attempt = 0; !releaseResponse && attempt < 100; attempt += 1) {
        await page.waitForTimeout(10);
      }
      assert.ok(releaseResponse, 'AI fixture request must reach the processing state');
      const processStyle = await page.locator('#aiPolishMask').evaluate(mask => ({
        background: getComputedStyle(mask).backgroundColor,
        text: getComputedStyle(mask.querySelector('.audio-convert-process-text')).color
      }));
      if (theme === 'light') {
        assert.equal(processStyle.background, 'rgba(255, 255, 255, 0.96)');
        assert.equal(processStyle.text, 'rgb(96, 99, 106)');
      }
      await page.screenshot({ path: path.join(output, `${theme}-processing.png`) });
      releaseResponse();
      releaseResponse = null;
      await page.locator('#aiPolishDirectionList button').first().waitFor();
      await page.locator('#aiPolishMask').waitFor({ state: 'hidden' });
      if (theme === 'light') await assertReadable(page);
      await assertFits(page);
      await page.screenshot({ path: path.join(output, `${theme}-directions.png`) });

      await page.locator('#aiPolishDirectionList button').first().click();
      await page.waitForFunction(expected => document.querySelector('#aiPolishPolishedText')?.textContent === expected, polishedText);
      await page.locator('#aiPolishMask').waitFor({ state: 'hidden' });
      if (theme === 'light') await assertReadable(page);
      await page.locator('#aiPolishCopyBtn').click();
      assert.equal(await page.evaluate(() => window.__aiPolishClipboard), polishedText);
      assert.equal(await page.locator('#aiPolishCopyBtn').evaluate(node => node.classList.contains('copied')), true);
      await page.screenshot({ path: path.join(output, `${theme}-result.png`) });

      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await assertFits(page);
        if (theme === 'light') await assertReadable(page);
        await page.screenshot({ path: path.join(output, `${theme}-result-${viewport.width}.png`) });
      }

      await page.keyboard.press('Escape');
      await page.locator('#aiPolishOverlay').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#aiPolishOverlay').evaluate(node => node.contains(document.activeElement)), false);
      await openTool(page);
      assert.equal(await page.locator('#aiPolishInput').inputValue(), '');
      assert.equal(await page.locator('#aiPolishRightEmpty').isVisible(), true);

      await page.locator('#aiPolishBack').click();
      await page.evaluate(() => localStorage.setItem('toolknit-lang', 'en'));
      await page.reload();
      await page.setViewportSize({ width: 1100, height: 760 });
      await openTool(page);
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
      if (theme === 'light') await assertReadable(page);
      await assertFits(page);
      await page.screenshot({ path: path.join(output, `${theme}-english.png`) });
      assert.deepEqual(errors, []);
    } finally {
      releaseResponse?.();
      await page.close();
    }
  }
  console.log('AI polish theme browser regression passed: light/dark, empty, processing, directions, result, copy, compact layouts and reopen');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
