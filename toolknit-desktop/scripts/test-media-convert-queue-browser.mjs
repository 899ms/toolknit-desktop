import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { pdfjsAssets } from './lib/pdfjs-assets.mjs';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const output = path.resolve('tmp/media-convert-queue-ui');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false, plugins: [pdfjsAssets()], cacheDir: 'tmp/media-convert-queue-ui/vite-cache',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  optimizeDeps: { entries: ['index.html'] }
});
let browser;
let page;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true,
    ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
  page = await browser.newPage({ viewport: { width: 1400, height: 887 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('toolknit.theme.v3', 'light'));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue() : route.abort();
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  for (const spec of [
    { tool: 'convert', overlay: '[data-audio-convert-page]', files: '[data-audio-convert-files]',
      choose: '[data-audio-convert-action="choose"]', back: '[data-audio-convert-action="back"]', extension: 'mp3', mime: 'audio/mpeg' },
    { tool: 'video-convert', overlay: '#videoConvertOverlay', files: '#videoConvertFiles',
      choose: '#videoConvertCta', back: '#videoConvertBack', extension: 'mp4', mime: 'video/mp4' }
  ]) {
    await page.setViewportSize({ width: 1400, height: 887 });
    await page.locator(`[data-tool="${spec.tool}"]`).evaluate(n => n.click());
    await page.waitForSelector(`${spec.overlay}.visible`);
    if (spec.tool === 'video-convert') {
      const format = page.locator('#videoConvertFormatOptions');
      const custom = page.locator('#videoConvertFormatOptions + .tool-custom-select');
      assert.equal(await format.inputValue(), 'MP4');
      assert.equal(await custom.locator('.tool-custom-select-label').textContent(), 'MP4');
      await custom.locator('.tool-custom-select-trigger').click();
      const menu = page.locator('.tool-custom-select-menu').filter({ visible: true });
      await menu.locator('[data-tool-select-value="AVI"]').click();
      assert.equal(await format.inputValue(), 'AVI');
      assert.equal(await custom.locator('.tool-custom-select-label').textContent(), 'AVI');
      await custom.locator('.tool-custom-select-trigger').focus();
      await custom.locator('.tool-custom-select-trigger').press('ArrowDown');
      assert.equal(await custom.locator('.tool-custom-select-trigger').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await custom.locator('.tool-custom-select-trigger').getAttribute('aria-expanded'), 'false');
    }
    const upload = async files => {
      const ready = page.waitForEvent('filechooser');
      await page.locator(spec.choose).click();
      await (await ready).setFiles(files);
    };
    const longName = `${'very-long-media-filename-'.repeat(12)}.${spec.extension}`;
    const files = [
      { name: longName, mimeType: spec.mime, buffer: Buffer.alloc(123456) },
      { name: `second.${spec.extension}`, mimeType: spec.mime, buffer: Buffer.alloc(2048) }
    ];
    await upload(files);
    const rows = page.locator(`${spec.files} .audio-convert-file-item`);
    await rows.first().waitFor();
    assert.equal(await rows.count(), 2);
    const checkGeometry = async (theme, count = 4) => {
      const geometry = await rows.first().evaluate(row => {
        const rect = n => { const r = n.getBoundingClientRect(); return {
          x: r.x, right: r.right, center: r.y + r.height / 2, width: r.width, height: r.height
        }; };
        const size = row.querySelector('.audio-convert-file-size');
        return { row: rect(row), children: [...row.children].map(rect),
          sizeColor: size && getComputedStyle(size).color,
          align: getComputedStyle(row.querySelector('.audio-convert-file-name')).textAlign };
      });
      assert.equal(geometry.children.length, count);
      for (let i = 0; i < count; i++) {
        const child = geometry.children[i];
        assert.ok(Math.abs(child.center - geometry.children[0].center) < 1, `${spec.tool}: every field must remain on one row`);
        assert.ok(child.x >= geometry.row.x && child.right <= geometry.row.right, `${spec.tool}: field must not overflow`);
        if (i) assert.ok(child.x >= geometry.children[i - 1].right, `${spec.tool}: fields must not overlap`);
      }
      assert.ok(geometry.row.right - geometry.children.at(-1).right <= 15, 'remove button stays at the right edge');
      if (theme === 'light') {
        assert.equal(geometry.children.at(-1).width, 30);
        assert.equal(geometry.align, 'center');
        if (count === 4) assert.equal(geometry.sizeColor, 'rgb(101, 104, 111)');
      } else assert.ok(geometry.children.at(-1).width >= 14, 'dark-mode remove icon remains visible');
    };
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of [1400, 1100, 390]) {
        await page.setViewportSize({ width, height: width < 1400 ? 1200 : 887 });
        await rows.first().scrollIntoViewIfNeeded();
        await checkGeometry(theme);
        await rows.first().screenshot({ path: path.join(output, `${spec.tool}-${theme}-${width}.png`) });
        // Native video selections can lack size metadata; verify the same three-field shape.
        await rows.first().evaluate(row => row.querySelector('.audio-convert-file-size').remove());
        await checkGeometry(theme, 3);
        await rows.first().evaluate(row => {
          const size = document.createElement('span');
          size.className = 'audio-convert-file-size';
          size.textContent = '120.6 KB';
          row.insertBefore(size, row.lastElementChild);
        });
      }
    }
    await page.setViewportSize({ width: 1400, height: 887 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    const remove = rows.first().locator('.audio-convert-file-remove');
    await remove.hover();
    await page.waitForFunction(n => getComputedStyle(n).color === 'rgb(23, 23, 23)', await remove.elementHandle());
    await checkGeometry('light');
    await rows.first().dragTo(rows.nth(1));
    assert.equal(await rows.first().locator('.audio-convert-file-name').textContent(), files[1].name);
    assert.deepEqual(await rows.locator('.audio-convert-file-index').allTextContents(), ['1', '2']);
    const deleteFirst = rows.first().locator('.audio-convert-file-remove');
    await deleteFirst.focus();
    await deleteFirst.press('Enter');
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.first().locator('.audio-convert-file-name').textContent(), longName);
    assert.equal(await rows.first().locator('.audio-convert-file-index').textContent(), '1');
    await rows.first().locator('.audio-convert-file-remove').click();
    assert.equal(await rows.count(), 0);
    await upload([files[1]]);
    assert.equal(await rows.count(), 1);
    await rows.first().hover();
    await page.mouse.move(10, 10);
    await page.screenshot({ path: path.join(output, `${spec.tool}-light-page.png`) });
    await page.locator(spec.back).click();
    await page.waitForFunction(selector => !document.querySelector(selector).classList.contains('visible'), spec.overlay);
    await page.locator(`[data-tool="${spec.tool}"]`).evaluate(n => n.click());
    await page.waitForSelector(`${spec.overlay}.visible`);
    assert.equal(await rows.count(), 0);
    await page.locator(spec.back).click();
    console.log(`PASS ${spec.tool}: two themes, three widths, optional file size, drag order, keyboard/mouse delete, reupload and reopen`);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
