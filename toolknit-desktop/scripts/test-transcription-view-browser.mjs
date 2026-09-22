import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {})
});
const outputDir = path.resolve('tmp/transcription-view-browser');
await mkdir(outputDir, { recursive: true });

async function mountTranscription(page, theme) {
  await page.goto(process.env.TOOLKNIT_TEST_URL || 'http://127.0.0.1:1420/');
  const card = page.locator('.audio-list-item[data-tool="transcription"]');
  await card.waitFor({ state: 'attached' });
  await card.evaluate(node => node.click());
  await page.waitForSelector('#transcriptionOverlay .transcription-v2-workspace', { state: 'attached' });
  await page.locator('#transcriptionOverlay').evaluate((root, nextTheme) => {
    document.documentElement.dataset.theme = nextTheme;
    root.classList.add('visible');
    root.removeAttribute('inert');
    root.setAttribute('aria-hidden', 'false');
  }, theme);
}

async function inspectInitialState(page) {
  return page.locator('#transcriptionOverlay').evaluate(root => {
    const operation = root.querySelector('#transcriptionOperationView');
    const result = root.querySelector('#transcriptionResultView');
    const workspace = root.querySelector('.transcription-v2-workspace');
    const operationRect = operation.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    return {
      operationVisible: !operation.hidden && getComputedStyle(operation).display !== 'none',
      resultHidden: result.hidden && getComputedStyle(result).display === 'none',
      emptyStateVisible: !root.querySelector('#transcriptionEmptyState').hidden
        && getComputedStyle(root.querySelector('#transcriptionEmptyState')).display !== 'none',
      previewVisible: root.querySelector('#transcriptionPreview').getClientRects().length > 0,
      operationFitsWorkspace: operationRect.bottom <= workspaceRect.bottom + 1
    };
  });
}

async function showSyntheticResult(page) {
  await page.locator('#transcriptionOverlay').evaluate(root => {
    const operation = root.querySelector('#transcriptionOperationView');
    const result = root.querySelector('#transcriptionResultView');
    operation.hidden = true;
    operation.setAttribute('aria-hidden', 'true');
    operation.setAttribute('inert', '');
    result.hidden = false;
    result.setAttribute('aria-hidden', 'false');
    result.removeAttribute('inert');
    root.classList.add('has-result');
    root.querySelector('#transcriptionResultFileName').textContent = 'sample-interview.mp4';

    const preview = root.querySelector('#transcriptionPreview');
    preview.replaceChildren();
    for (let index = 0; index < 36; index += 1) {
      const row = document.createElement('div');
      row.className = 'transcription-v2-segment';
      const time = document.createElement('span');
      time.className = 'transcription-v2-segment-time';
      time.textContent = `00:00:${String(index).padStart(2, '0')},000 -> 00:00:${String(index + 1).padStart(2, '0')},000`;
      const text = document.createElement('p');
      text.textContent = `第 ${index + 1} 条字幕内容，用于验证长字幕列表的滚动布局。`;
      row.append(time, text);
      preview.append(row);
    }

  });
}

async function inspectResultState(page) {
  return page.locator('#transcriptionOverlay').evaluate(root => {
    const workspaceRect = root.querySelector('.transcription-v2-workspace').getBoundingClientRect();
    const result = root.querySelector('#transcriptionResultView');
    const resultRect = result.getBoundingClientRect();
    const preview = root.querySelector('#transcriptionPreview');
    const previewRect = preview.getBoundingClientRect();
    return {
      operationHidden: root.querySelector('#transcriptionOperationView').hidden,
      resultVisible: !result.hidden && getComputedStyle(result).display !== 'none',
      resultFitsWorkspace: resultRect.bottom <= workspaceRect.bottom + 1,
      resultHasNoHorizontalOverflow: result.scrollWidth <= result.clientWidth + 1,
      emptyStateNotVisible: root.querySelector('#transcriptionEmptyState').getClientRects().length === 0,
      outputFilesAbsent: !root.querySelector('#transcriptionFiles')
        && !root.querySelector('.transcription-v2-result-files'),
      previewHeight: Math.round(previewRect.height),
      previewScrolls: preview.scrollHeight > preview.clientHeight,
      actionButtonsVisible: [...root.querySelectorAll('.transcription-v2-result-actions button')]
        .every(button => getComputedStyle(button).display !== 'none' && button.getBoundingClientRect().width > 0)
    };
  });
}

try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
    try {
      await mountTranscription(page, theme);
      const initial = await inspectInitialState(page);
      assert.deepEqual(initial, {
        operationVisible: true,
        resultHidden: true,
        emptyStateVisible: true,
        previewVisible: false,
        operationFitsWorkspace: true
      });

      await page.locator('#transcriptionInput').setInputFiles({
        name: 'sample-interview.mp3',
        mimeType: 'audio/mpeg',
        buffer: Buffer.from('test audio placeholder')
      });
      const selected = await page.locator('#transcriptionOverlay').evaluate(root => ({
        emptyStateHidden: root.querySelector('#transcriptionEmptyState').hidden,
        selectedFileVisible: !root.querySelector('#transcriptionSelectedFile').hidden,
        selectedFileName: root.querySelector('#transcriptionSelectedFileName').textContent
      }));
      assert.deepEqual(selected, {
        emptyStateHidden: true,
        selectedFileVisible: true,
        selectedFileName: 'sample-interview.mp3'
      });
      await page.locator('#transcriptionRemoveFileBtn').click();
      const cleared = await page.locator('#transcriptionOverlay').evaluate(root => ({
        emptyStateVisible: !root.querySelector('#transcriptionEmptyState').hidden,
        selectedFileHidden: root.querySelector('#transcriptionSelectedFile').hidden
      }));
      assert.deepEqual(cleared, { emptyStateVisible: true, selectedFileHidden: true });
      await page.screenshot({ path: path.join(outputDir, `${theme}-operation.png`) });

      await showSyntheticResult(page);
      await page.waitForTimeout(100);
      const result = await inspectResultState(page);
      console.log(`${theme} result layout`, result);
      assert.equal(result.operationHidden, true);
      assert.equal(result.resultVisible, true);
      assert.equal(result.resultFitsWorkspace, true);
      assert.equal(result.resultHasNoHorizontalOverflow, true);
      assert.equal(result.emptyStateNotVisible, true);
      assert.equal(result.outputFilesAbsent, true);
      assert.ok(result.previewHeight >= 180, `preview is too short: ${result.previewHeight}px`);
      assert.equal(result.previewScrolls, true);
      assert.equal(result.actionButtonsVisible, true);
      await page.screenshot({ path: path.join(outputDir, `${theme}-result.png`) });

      await page.locator('#transcriptionResetBtn').click();
      const reset = await page.locator('#transcriptionOverlay').evaluate(root => ({
        operationVisible: !root.querySelector('#transcriptionOperationView').hidden,
        resultHidden: root.querySelector('#transcriptionResultView').hidden,
        emptyStateVisible: !root.querySelector('#transcriptionEmptyState').hidden,
        previewChildCount: root.querySelector('#transcriptionPreview').childElementCount,
        activeElementId: document.activeElement?.id || ''
      }));
      assert.deepEqual(reset, {
        operationVisible: true,
        resultHidden: true,
        emptyStateVisible: true,
        previewChildCount: 0,
        activeElementId: 'transcriptionCta'
      });
    } finally {
      await page.close();
    }
  }
  console.log(`Transcription operation/result/reset browser states passed; screenshots: ${outputDir}`);
} finally {
  await browser.close();
}
