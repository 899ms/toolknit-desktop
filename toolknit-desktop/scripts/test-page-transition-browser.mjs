import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const endpoint = process.env.TOOLKNIT_TRANSITION_CDP;
const theme = process.env.TOOLKNIT_TEST_THEME || 'light';
assert.ok(['light', 'dark'].includes(theme));
let previewServer;
const output = path.resolve('tmp/page-transition-frames', endpoint ? 'webview' : 'browser', theme);
await mkdir(output, { recursive: true });
const browser = endpoint ? await chromium.connectOverCDP(endpoint) : await chromium.launch({
  headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {})
});
const page = endpoint ? browser.contexts()[0].pages().find(p => !p.url().includes('screen-picker'))
  : await browser.newPage({ viewport: { width: 1366, height: 768 } });
const originalUrl = page.url();
const errors = [];
const report = { scenarios: [], navigation: [], errors, status: 'running' };
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.text().includes('Blocked aria-hidden')) errors.push(message.text()); });
page.setDefaultTimeout(15000);

async function trace(clickSelector, source, target, label, { opening = true, reduced = false } = {}) {
  await page.evaluate(({ source, target }) => {
    const frames = [];
    const started = performance.now();
    const styleOf = selector => {
      const node = document.querySelector(selector);
      if (!node) return { opacity: 0, visible: false };
      const style = getComputedStyle(node);
      return { opacity: Number(style.opacity), visible: style.visibility === 'visible' && style.display !== 'none' };
    };
    const trace = { frames, done: false, started: false };
    window.__transitionTrace = trace;
    const sample = () => {
      if (trace.done) return;
      const veil = document.querySelector('[data-tk-page-transition-veil]');
      const style = veil && getComputedStyle(veil);
      const phase = veil?.classList.contains('is-active') ? 'cover'
        : veil?.classList.contains('is-revealing') ? 'reveal' : 'idle';
      const frame = {
        ms: performance.now() - started, phase, veil: Number(style?.opacity || 0),
        background: style?.backgroundColor, duration: style?.transitionDuration,
        source: styleOf(source), target: styleOf(target)
      };
      frames.push(frame);
      if (phase !== 'idle') trace.started = true;
      if ((trace.started && phase === 'idle' && frame.veil === 0)
        || performance.now() - started > 5000) trace.done = true;
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { source, target });
  await page.locator(clickSelector).first().click();
  if (reduced) {
    await page.waitForTimeout(450);
  } else {
    await page.waitForFunction(() => window.__transitionTrace.done);
  }
  const frames = await page.evaluate(() => {
    window.__transitionTrace.done = true;
    return window.__transitionTrace.frames;
  });
  report.scenarios.push({ label, frames });
  if (!reduced) {
    const cover = frames.filter(f => f.phase === 'cover');
    const reveal = frames.filter(f => f.phase === 'reveal');
    assert.ok(cover.some(f => f.veil > 0.01 && f.veil < 0.95), `${label}: gradual cover, including first use`);
    assert.ok(cover.some(f => f.veil === 1 && f.background === 'rgb(0, 0, 0)'), `${label}: fully black before reveal`);
    assert.ok(reveal.length > 2, `${label}: reveal must be sampled`);
    assert.ok(cover.every(f => f.duration === '0.25s'), `${label}: cover uses 250ms`);
    assert.ok(reveal.every(f => f.duration === '0.35s'), `${label}: reveal uses 350ms`);
    assert.ok(reveal.every(f => f.target.visible && f.target.opacity === 1), `${label}: destination must already be opaque throughout reveal`);
    if (opening) {
      assert.ok(cover.filter(f => f.veil < 0.99).every(f => !f.target.visible || f.target.opacity === 0),
        `${label}: destination must not appear before full cover`);
    } else {
      assert.ok(cover.filter(f => f.veil < 0.99).every(f => f.source.visible && f.source.opacity === 1),
        `${label}: return must not hide source before full cover`);
      assert.ok(reveal.every(f => !f.source.visible || f.source.opacity === 0), `${label}: source must finish fading before reveal`);
    }
  } else {
    assert.ok(frames.every(f => f.veil === 0), `${label}: reduced motion skips the curtain`);
  }
  const final = await page.evaluate(() => {
    const v = document.querySelector('[data-tk-page-transition-veil]');
    const s = v && getComputedStyle(v);
    return { opacity: s?.opacity || '0', visibility: s?.visibility || 'hidden', hiddenFocus: Boolean(document.activeElement?.closest('[inert], [aria-hidden="true"]')) };
  });
  assert.equal(final.opacity, '0');
  assert.equal(final.visibility, 'hidden');
  assert.equal(final.hiddenFocus, false, `${label}: no focus in hidden page`);
  console.log(`PASS ${label}`);
}

async function checkSettingsNavigation(label) {
  await page.locator('#settingsOverlay .settings-v2-layout').evaluate(node => { node.scrollTop = 0; });
  const metrics = await page.evaluate(() => {
    const measure = node => {
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      return {
        top: box.top, bottom: box.bottom, left: box.left, right: box.right,
        height: box.height, width: box.width, fontSize: style.fontSize,
        radius: style.borderRadius, color: style.color, background: style.backgroundColor,
        paddingLeft: style.paddingLeft, paddingRight: style.paddingRight
      };
    };
    const settings = document.querySelector('#settingsOverlay');
    const tool = document.querySelector('#pdfEditorOverlay');
    const nav = (root, header, back) => ({
      header: measure(root.querySelector(header)),
      back: back && measure(root.querySelector(back)),
      website: measure(root.querySelector('.home-v2-nav-link')),
      support: measure(root.querySelector('.home-v2-support-top')),
      icon: measure(root.querySelector('.home-v2-icon-button'))
    });
    const layout = settings.querySelector('.settings-v2-layout');
    const header = settings.querySelector('.settings-v2-topbar');
    const headerBox = header.getBoundingClientRect();
    return {
      width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme,
      settings: nav(settings, '.settings-v2-topbar', '#settingsBack'),
      tool: nav(tool, '.pdf-merge-v2-topbar', '#pdfEditorBack'),
      home: nav(document.querySelector('.app'), '.home-v2-topbar'),
      content: measure(layout), scrollable: layout.scrollHeight > layout.clientHeight,
      poster: measure(settings.querySelector('.settings-v2-poster')),
      options: measure(settings.querySelector('.settings-v2-grid')),
      clippedButtons: [...header.querySelectorAll('button')].filter(button => {
        const box = button.getBoundingClientRect();
        return box.left < headerBox.left || box.right > headerBox.right
          || box.top < headerBox.top || box.bottom > headerBox.bottom;
      }).map(button => button.id || button.className)
    };
  });
  report.navigation.push({ label, ...metrics });
  // The light PDF header adds a 1px separator when its mobile rows wrap.
  assert.ok(Math.abs(metrics.settings.header.height - metrics.tool.header.height) <= 1,
    `${label}: shared header height, allowing the PDF separator`);
  assert.equal(metrics.settings.header.top, metrics.home.header.top, `${label}: header starts at window top`);
  for (const part of ['back', 'website', 'support', 'icon']) {
    for (const property of ['height', 'fontSize', 'radius', 'paddingLeft', 'paddingRight']) {
      assert.equal(metrics.settings[part][property], metrics.tool[part][property], `${label}: ${part} ${property}`);
    }
  }
  for (const part of ['website', 'support']) {
    const palette = metrics.theme === 'light' ? metrics.home : metrics.tool;
    assert.equal(metrics.settings[part].color, palette[part].color, `${label}: ${part} contrast`);
  }
  assert.equal(metrics.settings.icon.background, metrics.theme === 'light' ? 'rgb(238, 238, 238)' : 'rgb(23, 23, 23)', `${label}: settings remains selected`);
  if (metrics.width > 780) {
    assert.equal(metrics.settings.header.height, 68, `${label}: desktop height is 68px`);
    assert.equal(metrics.settings.header.height, metrics.home.header.height);
    assert.equal(metrics.settings.icon.top, metrics.home.icon.top, `${label}: home and settings controls align`);
  }
  assert.ok(Math.min(metrics.poster.top, metrics.options.top) >= metrics.settings.header.bottom + 24,
    `${label}: content clears navigation`);
  assert.ok(metrics.content.height > 0 && metrics.scrollable, `${label}: settings content remains scrollable`);
  if (metrics.width <= (metrics.theme === 'light' ? 980 : 1120)) {
    assert.ok(metrics.options.top >= metrics.poster.bottom, `${label}: stacked settings sections must not overlap`);
  }
  assert.deepEqual(metrics.clippedButtons, [], `${label}: navigation buttons fit`);
  await page.screenshot({ path: path.join(output, `${label}.png`) });
  console.log(`PASS ${label}`);
}

try {
  if (!endpoint) await page.addInitScript(value => localStorage.setItem('toolknit.theme.v3', value), theme);
  let url = process.env.TOOLKNIT_TEST_URL;
  if (!url && !endpoint) {
    previewServer = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0, open: false } });
    url = previewServer.resolvedUrls.local[0];
  }
  await page.goto(url || 'http://localhost:1420/');
  await page.waitForSelector('[data-home-tool="pdf-editor"]', { state: 'attached' });
  await page.getByRole('button', { name: '打开工具库', exact: true }).click();
  for (const [tool, overlay, back] of [
    ['pdf-editor', '#pdfEditorOverlay', '#pdfEditorBack'],
    ['pdf-split', '#pdfSplitOverlay', '#pdfSplitBack'],
    ['image-crop', '#imageCropOverlay', '#imageCropBack']
  ]) {
    if (tool === 'image-crop') await page.getByRole('button', { name: '图像', exact: true }).click();
    await trace(`[data-home-tool="${tool}"]`, '.app', overlay, `${tool}-first`);
    await trace(back, overlay, '.app', `${tool}-return`, { opening: false });
    if (tool === 'image-crop') await page.getByRole('button', { name: 'PDF', exact: true }).click();
  }
  await trace('[data-home-tool="pdf-editor"]', '.app', '#pdfEditorOverlay', 'editor-reopen');
  await trace('#pdfEditorV2Settings', '#pdfEditorOverlay', '#settingsOverlay', 'tool-to-settings');
  await checkSettingsNavigation('settings-desktop');
  await page.locator('#settingsOverlay [data-lang="en"]').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en'
    && !document.body.matches('.fade-in, .fade-out')
    && !document.querySelector('#transitionMask').classList.contains('visible'));
  await checkSettingsNavigation('settings-english');
  await page.locator('#settingsOverlay [data-lang="zh"]').click();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN'
    && !document.body.matches('.fade-in, .fade-out')
    && !document.querySelector('#transitionMask').classList.contains('visible'));
  await trace('#settingsBack', '#settingsOverlay', '#pdfEditorOverlay', 'settings-to-tool', { opening: false });
  await trace('#pdfEditorBack', '#pdfEditorOverlay', '.app', 'editor-return', { opening: false });
  await trace('#homeV2Settings', '.app', '#settingsOverlay', 'home-to-settings');
  await trace('#helpLink', '#settingsOverlay', '#helpOverlay', 'settings-to-help');
  await trace('#helpBackBtn', '#helpOverlay', '.app', 'help-to-home', { opening: false });

  await page.evaluate(() => {
    setTimeout(() => document.querySelector('[data-home-tool="pdf-split"]').click(), 150);
    setTimeout(() => document.querySelector('[data-home-tool="pdf-editor"]').click(), 210);
    setTimeout(() => document.querySelector('[data-home-tool="pdf-split"]').click(), 270);
  });
  await trace('[data-home-tool="pdf-editor"]', '.app', '#pdfSplitOverlay', 'rapid-switch-latest-wins');
  await trace('#pdfSplitBack', '#pdfSplitOverlay', '.app', 'rapid-switch-return', { opening: false });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await trace('[data-home-tool="pdf-editor"]', '.app', '#pdfEditorOverlay', 'slow-cpu-open');
  await trace('#pdfEditorBack', '#pdfEditorOverlay', '.app', 'slow-cpu-return', { opening: false });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  await page.setViewportSize({ width: 1024, height: 480 });
  await trace('[data-home-tool="pdf-editor"]', '.app', '#pdfEditorOverlay', 'compact-open');
  await trace('#pdfEditorV2Settings', '#pdfEditorOverlay', '#settingsOverlay', 'compact-settings');
  await checkSettingsNavigation('settings-low-height');
  for (const width of [820, 780, 640]) {
    await page.setViewportSize({ width, height: 600 });
    await checkSettingsNavigation(`settings-width-${width}`);
  }
  await page.setViewportSize({ width: 1024, height: 480 });
  await trace('#settingsBack', '#settingsOverlay', '#pdfEditorOverlay', 'compact-settings-return', { opening: false });
  await trace('#pdfEditorBack', '#pdfEditorOverlay', '.app', 'compact-return', { opening: false });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trace('[data-home-tool="pdf-editor"]', '.app', '#pdfEditorOverlay', 'reduced-open', { reduced: true });
  await trace('#pdfEditorBack', '#pdfEditorOverlay', '.app', 'reduced-return', { opening: false, reduced: true });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1366, height: 768 });

  // Pause only the curtain during reveal for an inspectable intermediate
  // screenshot. The page fade must have finished before this point.
  await page.evaluate(() => {
    const capture = () => {
      const v = document.querySelector('[data-tk-page-transition-veil]');
      const opacity = Number(v && getComputedStyle(v).opacity);
      if (v?.classList.contains('is-revealing') && opacity > 0.3 && opacity < 0.7) {
        v.getAnimations().forEach(animation => animation.pause());
        window.__transitionScreenshotReady = true;
      } else requestAnimationFrame(capture);
    };
    requestAnimationFrame(capture);
  });
  await page.locator('[data-home-tool="pdf-editor"]').first().click();
  await page.waitForFunction(() => window.__transitionScreenshotReady);
  assert.equal(await page.locator('#pdfEditorOverlay').evaluate(node => getComputedStyle(node).opacity), '1');
  await page.screenshot({ path: path.join(output, 'editor-reveal.png') });
  await page.evaluate(() => document.querySelector('[data-tk-page-transition-veil]').getAnimations().forEach(a => a.play()));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-tk-page-transition-veil]')).visibility === 'hidden');
  await page.screenshot({ path: path.join(output, 'editor-ready.png') });
  await trace('#pdfEditorBack', '#pdfEditorOverlay', '.app', 'screenshot-return', { opening: false });
  assert.deepEqual(errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack || error);
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (endpoint) {
    const cleanup = await page.context().newCDPSession(page);
    await cleanup.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cleanup.send('Emulation.clearDeviceMetricsOverride');
    await cleanup.detach();
    await page.emulateMedia({ reducedMotion: null });
    await page.goto(originalUrl).catch(() => {});
  }
  await browser.close();
  if (previewServer) await new Promise(resolve => previewServer.httpServer.close(resolve));
}
