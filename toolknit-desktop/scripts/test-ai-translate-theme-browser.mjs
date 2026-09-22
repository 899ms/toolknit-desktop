import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/ai-translate-theme');
const apiUrl = 'https://ai-translate-theme.test/v1/chat/completions';
const pairs = [
  { original: 'Clear writing helps teams decide.', translated: '\u6e05\u6670\u7684\u8868\u8fbe\u6709\u52a9\u4e8e\u56e2\u961f\u505a\u51fa\u51b3\u5b9a\u3002' },
  { original: 'Context keeps the meaning accurate.', translated: '\u8bed\u5883\u80fd\u786e\u4fdd\u542b\u4e49\u51c6\u786e\u3002' },
  { original: 'Each sentence remains aligned.', translated: '\u6bcf\u4e2a\u53e5\u5b50\u90fd\u4fdd\u6301\u5bf9\u5e94\u3002' },
  { original: 'Short labels improve scanning.', translated: '\u7b80\u77ed\u6807\u7b7e\u6709\u52a9\u4e8e\u5feb\u901f\u6d4f\u89c8\u3002' },
  { original: 'Consistent spacing supports focus.', translated: '\u4e00\u81f4\u7684\u95f4\u8ddd\u6709\u52a9\u4e8e\u4e13\u6ce8\u3002' },
  { original: 'Useful feedback confirms actions.', translated: '\u6709\u6548\u53cd\u9988\u53ef\u4ee5\u786e\u8ba4\u64cd\u4f5c\u3002' },
  { original: 'Local tools protect private files.', translated: '\u672c\u5730\u5de5\u5177\u53ef\u4ee5\u4fdd\u62a4\u79c1\u6709\u6587\u4ef6\u3002' },
  { original: 'Reliable output builds trust.', translated: '\u53ef\u9760\u7684\u8f93\u51fa\u80fd\u591f\u5efa\u7acb\u4fe1\u4efb\u3002' }
];
const sourceText = pairs.map(pair => pair.original).join(' ');
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
  await page.locator('.audio-list-item[data-tool="ai-translate"]').evaluate(node => node.click());
  await page.locator('#aiTranslateOverlay.visible').waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#aiTranslateOverlay')).opacity === '1');
}

async function assertReadable(page) {
  const failures = await page.locator(`#aiTranslateOverlay :is(
    .pdf-merge-v2-title,
    .pdf-merge-v2-subtitle,
    .pdf-merge-v2-poster-note strong,
    .pdf-merge-v2-step strong,
    .pdf-merge-v2-step p,
    .ai-translate-v2-card-head h2,
    .ai-translate-v2-card-head p,
    .ai-translate-v2-source strong,
    .ai-translate-v2-source span,
    .ai-translate-v2-drop-card span,
    .ai-translate-v2-drop-card p,
    .ai-translate-v2-select-btn span,
    .ai-translate-v2-start-btn span,
    .ai-polish-right-empty p,
    .ai-polish-directions-title,
    .ai-polish-direction-btn-name,
    .ai-polish-direction-btn-desc,
    .ai-polish-direction-cancel,
    .ai-translate-sentence
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
  const layout = await page.locator('#aiTranslateDrawer').evaluate(drawer => {
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
  const controls = await page.locator('#aiTranslateOverlay :is(button, .ai-translate-v2-source, .ai-translate-v2-drop-card)')
    .evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width && node.scrollWidth > node.clientWidth + 1)
      .map(node => node.id || node.className));
  assert.deepEqual(controls, [], 'AI translate controls must fit horizontally');
  const uploadGeometry = await page.locator('#aiTranslateDropCard').evaluate(dropCard => {
    const card = dropCard.getBoundingClientRect();
    const button = dropCard.querySelector('#aiTranslateSelectFileBtn').getBoundingClientRect();
    const input = document.querySelector('#aiTranslateInput');
    const preview = document.querySelector('#aiTranslateOriginalPreview');
    const editor = getComputedStyle(input).display === 'none' ? preview : input;
    const editorBounds = editor.getBoundingClientRect();
    return {
      card: { top: card.top, right: card.right, bottom: card.bottom, left: card.left },
      button: { top: button.top, right: button.right, bottom: button.bottom, left: button.left },
      editorTop: editorBounds.top
    };
  });
  assert.ok(uploadGeometry.button.top >= uploadGeometry.card.top - 1
    && uploadGeometry.button.right <= uploadGeometry.card.right + 1
    && uploadGeometry.button.bottom <= uploadGeometry.card.bottom + 1
    && uploadGeometry.button.left >= uploadGeometry.card.left - 1,
  'select button must remain inside the document drop surface');
  assert.ok(uploadGeometry.button.bottom <= uploadGeometry.editorTop + 1,
    'select button must not overlap the visible editor');
}

async function assertLightSurface(page) {
  const colors = await page.locator('#aiTranslateOverlay').evaluate(overlay => {
    const style = selector => getComputedStyle(overlay.querySelector(selector));
    return {
      card: style('.ai-translate-v2-input-card').backgroundColor,
      heading: style('.ai-translate-v2-card-head h2').color,
      source: style('.ai-translate-v2-source').backgroundColor,
      meta: style('#aiTranslateFileMeta').color,
      textarea: style('#aiTranslateInput').backgroundColor,
      selectBackground: style('#aiTranslateSelectFileBtn').backgroundColor,
      selectColor: style('#aiTranslateSelectFileBtn').color,
      emptyIcon: style('.ai-polish-empty-icon').color
    };
  });
  assert.equal(colors.card, 'rgb(255, 255, 255)');
  assert.equal(colors.heading, 'rgb(23, 23, 23)');
  assert.equal(colors.source, 'rgb(245, 246, 247)');
  assert.equal(colors.meta, 'rgb(96, 99, 106)');
  assert.equal(colors.textarea, 'rgb(255, 255, 255)');
  assert.equal(colors.selectBackground, 'rgb(23, 23, 23)');
  assert.equal(colors.selectColor, 'rgb(255, 255, 255)');
  assert.equal(colors.emptyIcon, 'rgb(23, 23, 23)');
}

async function assertPairPalette(page) {
  const palette = await page.locator('#aiTranslateComparison').evaluate(comparison => {
    const colors = selector => [...comparison.ownerDocument.querySelectorAll(selector)]
      .map(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
    return {
      originals: colors('#aiTranslateOriginalPreview .ai-translate-sentence'),
      translations: colors('#aiTranslateResult .ai-translate-sentence')
    };
  });
  assert.equal(palette.originals.length, pairs.length);
  assert.equal(palette.translations.length, pairs.length);
  assert.deepEqual(palette.originals.map(item => item.background), palette.translations.map(item => item.background),
    'matching source and translated sentences must share a color');
  assert.equal(new Set(palette.translations.map(item => item.background)).size, pairs.length,
    'the first eight translated sentences must use distinct colors');
  assert.ok(palette.translations.every(item => item.color === 'rgb(23, 23, 23)'),
    'light result text must use the primary ink color');
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
      localStorage.setItem('ai_custom_model', 'translate-theme-test-model');
      localStorage.setItem('ai_api_key', 'local-translate-theme-test-not-a-real-key');
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async text => { window.__aiTranslateClipboard = text; } }
      });
    }, { theme, apiUrl });
    await page.route('https://api.github.com/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]'
    }));
    await page.route(apiUrl, async route => {
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
            message: { content: JSON.stringify({ pairs }) }
          }]
        })
      }).catch(() => {});
    });
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
      await openTool(page);
      assert.equal(await page.locator('#aiTranslateRightEmpty').isVisible(), true);
      if (theme === 'light') {
        await assertLightSurface(page);
        await assertReadable(page);
      }
      await assertFits(page);
      await page.screenshot({ path: path.join(output, `${theme}-empty.png`) });

      const importedName = 'quarterly-translation-source-with-a-long-file-name.txt';
      await page.locator('#aiTranslateFileInput').setInputFiles({
        name: importedName,
        mimeType: 'text/plain',
        buffer: Buffer.from(sourceText)
      });
      await page.waitForFunction(expected => document.querySelector('#aiTranslateInput')?.value === expected, sourceText);
      await page.waitForFunction(() => !document.querySelector('#aiTranslateOverlay')?.classList.contains('is-reading-file'));
      assert.equal(await page.locator('#aiTranslateFileName').textContent(), importedName);
      if (theme === 'light') {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#aiTranslateStartBtn')).backgroundColor === 'rgb(23, 23, 23)');
        await assertReadable(page);
      }
      await assertFits(page);
      await page.screenshot({ path: path.join(output, `${theme}-imported.png`) });

      await page.locator('#aiTranslateStartBtn').click();
      await page.locator('#aiTranslateLangList button').first().waitFor();
      assert.equal(await page.locator('#aiTranslateLangList button').count(), 10);
      if (theme === 'light') {
        const languageButton = await page.locator('#aiTranslateLangList button').first().evaluate(button => ({
          background: getComputedStyle(button).backgroundColor,
          color: getComputedStyle(button.querySelector('.ai-polish-direction-btn-name')).color
        }));
        assert.equal(languageButton.background, 'rgb(245, 246, 247)');
        assert.equal(languageButton.color, 'rgb(23, 23, 23)');
        await assertReadable(page);
      }
      await assertFits(page);
      await page.screenshot({ path: path.join(output, `${theme}-languages.png`) });

      holdNextResponse = true;
      await page.locator('#aiTranslateLangList button').filter({ hasText: 'French' }).click();
      await page.locator('#aiTranslateMask.visible').waitFor();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#aiTranslateMask')).opacity === '1');
      for (let attempt = 0; !releaseResponse && attempt < 100; attempt += 1) {
        await page.waitForTimeout(10);
      }
      assert.ok(releaseResponse, 'AI fixture request must reach the processing state');
      const processStyle = await page.locator('#aiTranslateMask').evaluate(mask => ({
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
      await page.locator('#aiTranslateResult .ai-translate-sentence').nth(pairs.length - 1).waitFor();
      await page.locator('#aiTranslateMask').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#aiTranslateInput').isHidden(), true);
      assert.equal(await page.locator('#aiTranslateOriginalPreview').isVisible(), true);
      if (theme === 'light') {
        await assertPairPalette(page);
        await assertReadable(page);
      }
      await assertFits(page);

      const translatedSentences = page.locator('#aiTranslateResult .ai-translate-sentence');
      await translatedSentences.first().click();
      assert.equal(await page.evaluate(() => window.__aiTranslateClipboard), pairs[0].translated);
      assert.equal(await translatedSentences.first().evaluate(node => node.classList.contains('copied-flash')), true);
      const completeTranslation = await page.locator('#aiTranslateResult').textContent();
      await page.locator('#aiTranslateCopyBtn').click();
      assert.equal(await page.evaluate(() => window.__aiTranslateClipboard), completeTranslation);
      assert.equal(await page.locator('#aiTranslateCopyBtn').evaluate(node => node.classList.contains('copied')), true);
      await page.screenshot({ path: path.join(output, `${theme}-result.png`) });

      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await assertFits(page);
        if (theme === 'light') await assertReadable(page);
        await page.screenshot({ path: path.join(output, `${theme}-result-${viewport.width}.png`) });
      }

      await page.locator('#aiTranslateStartBtn').click();
      assert.equal(await page.locator('#aiTranslateInput').isVisible(), true);
      assert.equal(await page.locator('#aiTranslateInput').inputValue(), sourceText);
      assert.equal(await page.locator('#aiTranslateRightEmpty').isVisible(), true);
      assert.equal(await page.locator('#aiTranslateComparison').isHidden(), true);

      await page.keyboard.press('Escape');
      await page.locator('#aiTranslateOverlay').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#aiTranslateOverlay').evaluate(node => node.contains(document.activeElement)), false);
      await page.setViewportSize(viewports[0]);
      await openTool(page);
      assert.equal(await page.locator('#aiTranslateInput').inputValue(), '');
      assert.equal(await page.locator('#aiTranslateRightEmpty').isVisible(), true);

      await page.locator('#aiTranslateBack').click();
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
  console.log('AI translate theme browser regression passed: light/dark, empty, languages, processing, paired colors, copy, compact layouts and reopen');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
