import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/toast-layers');
const report = [];
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  for (const viewport of [{ width: 1100, height: 700 }, { width: 720, height: 480 }]) {
    const page = await browser.newPage({ viewport, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.text().includes('Blocked aria-hidden')) errors.push(message.text()); });
    await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    page.setDefaultTimeout(10000);
    try {
      for (const [tool, overlayId] of [['settings', 'settingsOverlay'], ['teleprompter', 'teleprompterOverlay'], ['bg-removal', 'bgRemovalOverlay']]) {
        await page.goto(url);
        if (tool === 'settings') await page.locator('#homeV2Settings').click();
        else {
          const card = page.locator(`.audio-list-item[data-tool="${tool}"]`);
          await card.waitFor({ state: 'attached' });
          await card.evaluate(node => node.click());
        }
        await page.waitForFunction(id => {
          const node = document.getElementById(id);
          return node?.classList.contains('visible') && getComputedStyle(node).opacity === '1';
        }, overlayId);
        await page.waitForFunction(() => {
          const veil = document.querySelector('[data-tk-page-transition-veil]');
          return veil && getComputedStyle(veil).visibility === 'hidden';
        });
        if (tool === 'settings') await page.locator('#screenPickerShortcutBtn').click();
        else await page.evaluate(() => window.showToast('Layer regression: operation failed', { kind: 'error' }));
        const toast = page.locator('#toastContainer .app-toast').last();
        await toast.waitFor({ state: 'visible' });
        await page.waitForTimeout(400);
        const state = await toast.evaluate((node, id) => {
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { hit: node.contains(hit), coveringOverlay: hit?.closest('[id$="Overlay"]')?.id,
            clearsNavigation: box.top >= document.getElementById(id).querySelector('header, .settings-v2-topbar').getBoundingClientRect().bottom,
            toastLayer: Number(getComputedStyle(node.parentElement).zIndex),
            pageLayer: Number(getComputedStyle(document.getElementById(id)).zIndex),
            curtainLayer: Number(getComputedStyle(document.querySelector('[data-tk-page-transition-veil]')).zIndex),
            containerPointerEvents: getComputedStyle(node.parentElement).pointerEvents,
            withinViewport: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight };
        }, overlayId);
        report.push({ tool, viewport, ...state });
        await page.screenshot({ path: path.join(output, `${tool}-${viewport.width}.png`) });
        assert.equal(state.hit, true, `${tool}: toast must be painted above the page and receive pointer input`);
        assert.ok(state.toastLayer > state.pageLayer && state.toastLayer < state.curtainLayer, `${tool}: notification is above pages but below the navigation curtain`);
        assert.equal(state.containerPointerEvents, 'none', 'empty notification area must not block the page');
        assert.equal(state.withinViewport, true);
        assert.equal(state.clearsNavigation, true, 'notifications must not cover wrapped navigation controls');
        await toast.locator('.app-toast-close').click();
        await toast.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[inert], [aria-hidden="true"]'))), false);
        console.log(`PASS ${tool} notification ${viewport.width}x${viewport.height}`);
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
