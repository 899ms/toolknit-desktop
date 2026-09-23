import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { AI_TABLE_DEMO_DATA } from '../src/features/ai-table/prompts.js';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const testModel = process.env.TOOLKNIT_TEST_AI_MODEL || 'glm-5.3-flash';
const testUrl = process.env.TOOLKNIT_TEST_AI_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ model, url }) => {
    localStorage.setItem('ai_platform', 'custom');
    localStorage.setItem('ai_custom_url', url);
    localStorage.setItem('ai_custom_model', model);
    localStorage.setItem('ai_api_key', 'local-browser-test-not-a-key');
  }, { model: testModel, url: testUrl });
  await page.route('https://api.github.com/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  let mode = 'truncated', releaseDelayed;
  await page.route(testUrl, async route => {
    const request = route.request().postDataJSON();
    assert.equal(request.model, testModel);
    requests.push({ maxTokens: request.max_tokens, effort: request.reasoning_effort, thinking: request.thinking });
    const choice = mode === 'truncated'
      ? { finish_reason: 'length', message: { content: '', reasoning_content: 'synthetic reasoning' } }
      : mode === 'empty' ? { finish_reason: 'stop', message: { content: '' } }
      : { finish_reason: 'stop', message: { content: JSON.stringify(AI_TABLE_DEMO_DATA) } };
    const response = { status: mode === 'http' ? 429 : 200, contentType: 'application/json', body: JSON.stringify({ choices: [choice] }) };
    if (mode === 'delayed') await new Promise(resolve => { releaseDelayed = resolve; });
    await route.fulfill(response).catch(() => {});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const card = page.locator('.audio-list-item[data-tool="ai-table"]');
  await card.waitFor({ state: 'attached' });
  await card.evaluate(node => node.click());
  await page.waitForSelector('#aiTableOverlay.visible');
  const send = async () => {
    await page.locator('#aiTableChatInput').fill('Create a synthetic three-row progress table with one chart.');
    await page.locator('#aiTableChatSend').click();
  };
  for (const [nextMode, expected] of [['truncated', '输出长度上限'], ['empty', '未返回正文'], ['http', '429']]) {
    mode = nextMode;
    await send();
    await page.waitForFunction(expected => [...document.querySelectorAll('#aiTableChatMessages .ai-doc-chat-msg-ai .ai-doc-chat-bubble')]
      .some(node => node.textContent.includes(expected)), expected);
    console.log(`PASS AI table feedback: ${nextMode}`);
  }
  mode = 'success';
  await send();
  await page.waitForSelector('#aiTablePreviewScroll tbody tr');
  assert.equal(await page.locator('#aiTablePreviewScroll tbody tr').count(), AI_TABLE_DEMO_DATA.rows.length);
  await page.waitForFunction(() => [...document.querySelectorAll('#aiTablePreviewScroll canvas')].some(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 16) if (pixels[i + 3] > 0 && pixels[i] < 220) ink++;
    return ink > 100;
  }));
  const cell = page.locator('#aiTablePreviewScroll tbody tr').first().locator('td[data-col-idx="1"]');
  await cell.click();
  await cell.fill('123');
  await cell.press('Escape');
  assert.equal(await page.locator('#aiTableOverlay').evaluate(node => node.classList.contains('visible')), true,
    'finishing a cell edit must not close the table page');
  assert.equal(await cell.innerText(), '123');
  for (const format of ['csv', 'xlsx', 'pdf']) {
    const download = page.waitForEvent('download');
    await page.locator(`#aiTableCanvasToolbar [data-fmt="${format}"]`).click();
    const file = await download;
    const bytes = await readFile(await file.path());
    assert.ok(bytes.length > 30);
    if (format === 'csv') assert.match(bytes.toString('utf8'), /123/);
    if (format === 'xlsx') assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    if (format === 'pdf') assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    console.log(`PASS AI table export: ${format}`);
  }
  await mkdir('tmp/ai-table-provider', { recursive: true });
  await page.screenshot({ path: 'tmp/ai-table-provider/table-after-retry.png' });
  mode = 'delayed';
  await send();
  for (let i = 0; !releaseDelayed && i < 100; i++) await page.waitForTimeout(20);
  assert.equal(typeof releaseDelayed, 'function');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#aiTableOverlay').classList.contains('visible'));
  await card.evaluate(node => node.click());
  await page.waitForSelector('#aiTableOverlay.visible');
  releaseDelayed();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#aiTablePreviewScroll tbody tr').count(), 0, 'late response cannot repopulate a reopened session');
  mode = 'success';
  await send();
  await page.waitForSelector('#aiTablePreviewScroll tbody tr');
  for (const request of requests) {
    assert.equal(request.maxTokens, 8192);
    assert.equal(request.effort, 'low');
    assert.equal(request.thinking, undefined);
  }
  assert.deepEqual(errors, []);
  console.log('AI table browser regression passed: provider options, errors, retry, edit, charts, exports and stale-session isolation');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
