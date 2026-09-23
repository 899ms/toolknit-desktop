import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const PptxGenJS = require('pptxgenjs');
const output = path.resolve('tmp/ppt-file-layout');
await mkdir(output, { recursive: true });
const deck = new PptxGenJS();
const slide = deck.addSlide();
slide.addText('PPT layout regression', { x: 1, y: 1, w: 6, h: 1 });
slide.addImage({ data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', x: 1, y: 3, w: 1, h: 1 });
const fixture = { name: 'layout.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: await deck.write({ outputType: 'nodebuffer' }) };
const toolCases = [['ppt-to-pdf', 'pptToPdf'], ['ppt-to-image', 'pptToImage'], ['ppt-text', 'pptText'], ['ppt-compress', 'pptCompress'], ['ppt-images', 'pptImages']];
const profiles = [{ width: 1401, height: 920 }, { width: 1100, height: 480 }, { width: 720, height: 480 }];
const server = await preview({ configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, open: false } });
const browser = await chromium.launch({ headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
const report = [];
try {
  for (const theme of ['light', 'dark']) {
    for (const language of ['zh', 'en']) {
      for (const viewport of profiles) {
        const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.text().includes('Blocked aria-hidden')) errors.push(message.text()); });
        await page.addInitScript(({ theme, language }) => {
          localStorage.setItem('toolknit.theme.v3', theme);
          localStorage.setItem('toolknit-lang', language);
        }, { theme, language });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
        for (const [id, prefix] of toolCases) {
          const label = `${id}-${theme}-${language}-${viewport.width}x${viewport.height}`;
          await page.locator(`.audio-list-item[data-tool="${id}"]`).evaluate(node => node.click());
          await page.waitForSelector(`#${prefix}Overlay.visible`);
          await page.waitForFunction(prefix => document.querySelector(`#${prefix}Empty > svg`), prefix);
          await page.waitForFunction(prefix => getComputedStyle(document.getElementById(`${prefix}Overlay`)).opacity === '1', prefix);
          await page.evaluate(() => document.fonts.ready);
          const layout = await page.locator(`#${prefix}Overlay`).evaluate(overlay => {
            const work = overlay.querySelector('.ppt-file-workspace');
            const panel = work.querySelector('.ppt-file-panel');
            const empty = panel.querySelector('.ppt-images-empty');
            const cta = work.querySelector('.ppt-file-cta');
            const icon = empty.querySelector(':scope > svg');
            const note = overlay.querySelector('.pdf-merge-v2-poster-note');
            const steps = overlay.querySelector('.pdf-merge-v2-steps');
            const copy = work.querySelector('.pdf-merge-v2-upload-copy');
            const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
            return { empty: rect(empty), panel: rect(panel), cta: rect(cta), copy: rect(copy),
              emptyBg: getComputedStyle(empty).backgroundColor, iconBg: getComputedStyle(icon).backgroundColor,
              iconColor: getComputedStyle(icon).color, iconRadius: getComputedStyle(icon).borderRadius,
              buttonBg: getComputedStyle(cta).backgroundColor, labelColor: getComputedStyle(cta.querySelector('span')).color,
              headingColor: getComputedStyle(copy.querySelector('h2')).color,
              uploadTitle: copy.querySelector('h2').textContent,
              noteBottom: rect(note).bottom, stepsTop: rect(steps).y,
              overflow: work.scrollWidth - work.clientWidth,
              align: getComputedStyle(empty).alignContent,
              duplicateUploads: empty.querySelectorAll('button').length };
          });
          report.push({ label, layout });
          assert.equal(layout.duplicateUploads, 0, `${label}: no duplicate upload control`);
          assert.equal(layout.align, 'center', `${label}: vertically centered contents`);
          assert.ok(Math.abs(layout.empty.width - layout.panel.width) <= 2, `${label}: filling width`);
          assert.ok(Math.abs(layout.empty.height - (layout.panel.height - 12)) <= 2, `${label}: filling remaining height`);
          assert.ok(layout.noteBottom <= layout.stepsTop, `${label}: note and steps do not overlap`);
          assert.ok(layout.overflow <= 2, `${label}: no horizontal clipping`);
          assert.ok(layout.cta.x >= layout.copy.right - 1 || layout.cta.y >= layout.copy.bottom - 1, `${label}: upload text and button do not overlap`);
          if (theme === 'light') {
            assert.equal(layout.emptyBg, 'rgb(255, 255, 255)', `${label}: white empty surface`);
            assert.equal(layout.iconBg, 'rgb(23, 23, 23)');
            assert.equal(layout.iconColor, 'rgb(255, 255, 255)');
            assert.equal(layout.iconRadius, '50%');
            assert.equal(layout.buttonBg, layout.iconBg);
            assert.equal(layout.labelColor, layout.iconColor);
            assert.equal(layout.headingColor, 'rgb(23, 24, 27)');
          }
          if (language === 'en' && id !== 'ppt-images') assert.doesNotMatch(layout.uploadTitle, /[\u4e00-\u9fff]/);
          await page.screenshot({ path: path.join(output, `${label}.png`) });
          if (language === 'zh') {
            const chooserPromise = page.waitForEvent('filechooser');
            await page.locator(`#${prefix}Cta`).click();
            await (await chooserPromise).setFiles(fixture);
            await page.waitForSelector(`#${prefix}Results:not([hidden])`);
            await page.waitForSelector(`#${prefix}ProcessMask.visible`, { state: 'hidden' });
            if (theme === 'light') {
              const labels = await page.locator(`#${prefix}Results .ppt-images-filter > span`).evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
              for (const color of labels) assert.equal(color, 'rgb(101, 106, 115)', `${label}: readable field labels`);
            }
            const resultOverflow = await page.locator('.visible .ppt-file-workspace').evaluate(node => node.scrollWidth - node.clientWidth);
            assert.ok(resultOverflow <= 2, `${label}: uploaded results must not clip horizontally (${resultOverflow}px)`);
            await page.locator(`#${prefix}Results`).scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(output, `${label}-uploaded.png`) });
          }
          await page.locator(`#${prefix}Back`).click();
          await page.waitForSelector(`#${prefix}Overlay.visible`, { state: 'hidden' });
          console.log(`PASS ${label}`);
        }
        assert.deepEqual(errors, [], `${theme}/${language}: runtime and focus errors`);
        await page.close();
      }
    }
  }
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.httpServer.close();
}
