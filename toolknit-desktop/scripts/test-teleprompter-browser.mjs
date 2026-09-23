import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const server = await createServer({
  logLevel: 'error',
  cacheDir: 'node_modules/.vite-teleprompter-browser',
  server: { host: '127.0.0.1', port: 0, open: false, hmr: false }
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  const diagnosticLogs = [];
  page.on('console', message => {
    if (message.text().startsWith('[Teleprompter][')) diagnosticLogs.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.addInitScript(() => {
    window[Symbol.for('toolknit.qa-devtools')] = true;
    localStorage.setItem('toolknit.theme.v3', 'light');
    localStorage.setItem('toolknit.teleprompter.preferences.v2', JSON.stringify({ engine: 'system', voiceFollow: true }));
    window.SpeechRecognition = class {
      constructor() { window.syntheticRecognition = this; }
      start() { queueMicrotask(() => this.onstart?.()); }
      abort() { this.aborted = true; }
    };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const card = page.locator('.audio-list-item[data-tool="teleprompter"]');
  await card.waitFor({ state: 'attached' });
  await card.evaluate(node => node.click());
  const overlay = page.locator('#teleprompterOverlay');
  await page.waitForSelector('#teleprompterOverlay.visible');
  const input = overlay.locator('[data-tele-input]');
  assert.equal((await page.locator('#teleprompterOverlay .teleprompter-play-button').evaluate(node => getComputedStyle(node).backgroundColor)),
    'rgb(240, 241, 243)', 'an empty script must keep the play button visibly disabled');
  await input.fill('欢迎使用本地语音跟随功能。我们使用模型识别语音。今天测试提词器，让文字跟随朗读。');
  await page.waitForFunction(() => document.querySelectorAll('.teleprompter-sentence').length === 3);
  const computed = selector => page.locator(selector).first().evaluate(node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: style.borderColor, color: style.color };
  });
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  assert.deepEqual(await computed('#teleprompterOverlay'), {
    background: 'rgb(255, 255, 255)', border: 'rgb(23, 23, 23)', color: 'rgb(23, 23, 23)'
  });
  assert.equal((await computed('#teleprompterOverlay .teleprompter-editor')).background, 'rgb(255, 255, 255)');
  assert.equal((await computed('#teleprompterOverlay .teleprompter-input')).color, 'rgb(23, 23, 23)');
  assert.equal((await computed('#teleprompterOverlay .teleprompter-stage')).background, 'rgb(255, 255, 255)');
  assert.equal((await computed('#teleprompterOverlay .teleprompter-screen')).background, 'rgb(3, 3, 4)');
  assert.equal((await computed('#teleprompterOverlay .teleprompter-controls')).background, 'rgb(245, 246, 247)');
  assert.equal((await computed('#teleprompterOverlay .teleprompter-play-button')).background, 'rgb(23, 23, 23)');
  assert.equal(await overlay.evaluate(node => node.scrollWidth <= node.clientWidth), true,
    'desktop light mode must not introduce horizontal overflow');

  const engineTrigger = overlay.locator('.tool-custom-select-trigger');
  await engineTrigger.click();
  const engineMenu = page.locator('.tool-custom-select-menu:not([hidden])');
  await engineMenu.waitFor({ state: 'visible' });
  assert.equal((await computed('.tool-custom-select-menu:not([hidden])')).background, 'rgb(255, 255, 255)');
  assert.equal((await computed('.tool-custom-select-menu:not([hidden]) button')).color, 'rgb(51, 53, 58)');
  assert.equal((await computed('.tool-custom-select-menu:not([hidden]) button.is-selected')).background, 'rgb(240, 241, 243)');
  await engineTrigger.click();

  await overlay.locator('[data-tele-action="focus"]').click();
  await page.waitForFunction(() => document.querySelector('#teleprompterOverlay')?.classList.contains('is-focus'));
  assert.equal((await computed('#teleprompterOverlay')).background, 'rgb(3, 3, 4)');
  assert.equal((await computed('#teleprompterOverlay .teleprompter-stage')).background, 'rgb(3, 3, 4)');
  assert.equal((await computed('#teleprompterOverlay .teleprompter-controls')).background, 'rgba(6, 6, 7, 0.96)');
  assert.equal((await computed('#teleprompterOverlay .teleprompter-control-button')).color, 'rgba(255, 255, 255, 0.84)');
  await overlay.locator('[data-tele-action="exit-focus"]').click();
  await page.waitForFunction(() => !document.querySelector('#teleprompterOverlay')?.classList.contains('is-focus'));

  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  assert.equal((await computed('#teleprompterOverlay')).background, 'rgb(6, 6, 7)');
  assert.equal((await computed('#teleprompterOverlay .teleprompter-screen')).background, 'rgb(3, 3, 4)');
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  const play = overlay.locator('[data-tele-action="play"]');
  await play.click();
  await page.waitForFunction(() => !!window.syntheticRecognition?.onresult);
  const speak = (text, final = false) => page.evaluate(({ text, final }) => {
    window.syntheticRecognition.onresult({ resultIndex: 0, results: [{ isFinal: final, 0: { transcript: text } }] });
  }, { text, final });
  const current = () => overlay.locator('.teleprompter-sentence.is-current').innerText();
  await speak('歡迎使用');
  assert.equal(await current(), '欢迎使用本地语音跟随功能。');
  const logs = stage => diagnosticLogs.filter(line => line.startsWith(`[Teleprompter][${stage}] `))
    .map(line => JSON.parse(line.slice(`[Teleprompter][${stage}] `.length)));
  assert.equal(logs('transcript').at(-1).text, '欢迎使用');
  assert.equal(logs('follow').at(-1).decision, 'matched');
  assert.ok(logs('follow').at(-1).progress > 0);
  assert.equal(logs('follow').at(-1).requestId, logs('transcript').at(-1).requestId);
  const before = await overlay.locator('.teleprompter-reading-line').getAttribute('style');
  await speak('欢迎使用本地语音');
  assert.notEqual(await overlay.locator('.teleprompter-reading-line').getAttribute('style'), before,
    'partial speech must update the visible reading cursor');
  await speak('欢迎使用本地语音跟随功能我们使用模型');
  assert.equal(await current(), '我们使用模型识别语音。');
  const matched = await overlay.locator('.teleprompter-reading-line').getAttribute('style');
  await speak('明天午餐吃什么苹果香蕉');
  assert.equal(logs('follow').at(-1).decision, 'no-match-or-duplicate');
  assert.equal(await current(), '我们使用模型识别语音。');
  assert.equal(await overlay.locator('.teleprompter-reading-line').getAttribute('style'), matched);
  await speak('我们使用模型识别语音', true);
  assert.equal(await current(), '今天测试提词器，让文字跟随朗读。');
  await play.click();
  assert.equal(await page.evaluate(() => window.syntheticRecognition.aborted), true);
  await play.click();
  await page.waitForFunction(() => !!window.syntheticRecognition?.onresult);
  await speak('今天测试提词器');
  assert.equal(await current(), '今天测试提词器，让文字跟随朗读。');
  await mkdir('tmp/teleprompter', { recursive: true });
  await page.screenshot({ path: 'tmp/teleprompter/voice-follow-desktop.png' });
  await page.setViewportSize({ width: 800, height: 600 });
  assert.equal(await overlay.evaluate(node => node.scrollWidth <= node.clientWidth), true,
    'the supported compact viewport must not introduce horizontal overflow');
  assert.equal(await overlay.locator('.teleprompter-workspace').evaluate(node => node.scrollWidth <= node.clientWidth), true,
    'the compact workspace must keep its controls inside the visible tool surface');
  await overlay.locator('[data-tele-action="reset"]').click();
  await play.click();
  await page.waitForFunction(() => !!window.syntheticRecognition?.onresult);
  await speak('欢迎使用本地语音跟随功能我们使用模型');
  assert.equal(await current(), '我们使用模型识别语音。');
  await overlay.locator('.teleprompter-sentence.is-current').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'tmp/teleprompter/voice-follow-compact.png' });
  await overlay.locator('[data-tele-action="back"]').click();
  await page.waitForSelector('#teleprompterOverlay:not(.visible)', { state: 'attached' });
  assert.equal(await page.evaluate(() => window.syntheticRecognition.aborted), true);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('#teleprompterOverlay') !== null), false);
  await card.evaluate(node => node.click());
  await page.waitForSelector('#teleprompterOverlay.visible');
  assert.equal(await overlay.locator('[data-tele-action="play"]').getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#teleprompterOverlay:not(.visible)', { state: 'attached' });
  assert.deepEqual(errors, []);
  console.log('Teleprompter browser passed: light/dark theme, focus mode, select menu, responsive layout, voice follow, back, reopen, Escape');
} finally {
  await browser?.close();
  await server.close();
}
