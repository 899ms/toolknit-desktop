import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { pdfjsAssets } from './lib/pdfjs-assets.mjs';

const require = createRequire(path.join(process.env.TOOLKNIT_TEST_MODULES || process.cwd(), 'package.json'));
const { chromium } = require('playwright');
const output = path.resolve('tmp/video-preview-regression');
await mkdir(output, { recursive: true });
const ffmpeg = process.env.TOOLKNIT_FFMPEG_PATH || path.resolve('src-tauri/resources/ffmpeg/ffmpeg.exe');
const source = path.join(output, 'sample-65s.mp4');
const encode = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: 90000 });
encode(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12', '-t', '65', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
const clips = {};
for (const start of [0, 30, 60]) {
  const file = path.join(output, `clip-${start}.mp4`);
  encode(['-ss', String(start), '-i', source, '-t', String(Math.min(30, 65 - start)), '-an', '-c:v', 'libx264',
    '-profile:v', 'baseline', '-level:v', '3.1', '-preset', 'veryfast', '-crf', '27', '-maxrate', '900k', '-bufsize', '1800k',
    '-pix_fmt', 'yuv420p', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', file]);
  clips[start * 1000] = `data:video/mp4;base64,${(await readFile(file)).toString('base64')}`;
}
const frame = `data:image/jpeg;base64,${encode(['-i', source, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-']).toString('base64')}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1400, height: 920 } });
const errors = [];
const server = await createServer({ configFile: false, plugins: [pdfjsAssets()],
  cacheDir: 'tmp/video-preview-regression/vite-cache',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { entries: ['index.html'] } });
page.on('pageerror', error => errors.push(error.message));
try {
  await server.listen();
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.locator('#homeV2Settings').click();
  await page.waitForSelector('#settingsOverlay.visible');
  const veilHidden = () => page.waitForFunction(() => {
    const veil = document.querySelector('[data-tk-page-transition-veil]');
    return !veil || getComputedStyle(veil).visibility === 'hidden';
  });
  await veilHidden();
  for (const theme of ['dark', 'light']) {
    await page.locator(`[data-theme-choice="${theme}"]`).click();
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    const cover = await page.locator('[data-tk-page-transition-veil]').evaluate(node => ({ color: getComputedStyle(node).backgroundColor, opacity: Number(getComputedStyle(node).opacity) }));
    assert.equal(cover.color, 'rgb(0, 0, 0)');
    assert.ok(cover.opacity > 0.8, 'theme is painted under the black veil');
    await veilHidden();
  }
  await page.locator('#settingsBack').click(); await veilHidden();
  await page.evaluate(async ({ clips, frame, source }) => {
    // Exercise the real controller with a native IPC fixture and real decoded MP4s.
    window.previewCalls = []; window.previewMessages = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        window.previewCalls.push({ command, args });
        if (command === 'plugin:dialog|open') return source;
        if (command === 'probe_video') return { duration: 65, file_size: 10000, frame_rate: 12, width: 320, height: 180 };
        if (command === 'render_video_preview_frame') return { image_data_url: frame };
        if (command === 'render_video_preview_clip') {
          await new Promise(resolve => setTimeout(resolve, 150));
          return { media_data_url: clips[args.startMs] };
        }
        return 1;
      }
    };
    const markup = (await import('/src/features/video-tools/template.html?raw')).default;
    const template = document.createElement('template'); template.innerHTML = markup;
    const overlay = template.content.querySelector('#videoFrameOverlay'); document.body.append(overlay);
    const { initVideoFrameTool } = await import('/src/features/video-tools/tool.js');
    const { t } = await import('/src/i18n.js');
    const { createIcons, icons } = await import('/node_modules/lucide/dist/esm/lucide.js');
    window.previewController = initVideoFrameTool({ overlay, isTauri: true, t,
      refreshIcons: () => createIcons({ icons }), notify: message => window.previewMessages.push(message) });
    window.previewController.open();
  }, { clips, frame, source });
  await page.locator('#videoFrameEmpty [data-video-pick]').click();
  await page.waitForSelector('#videoFrameEditor:visible');
  await page.locator('#videoFramePreviewToggle').click();
  await page.waitForFunction(() => { const video = document.querySelector('#videoFramePreviewVideo'); return !video.paused && video.currentTime > 0.1; });
  assert.deepEqual(await page.evaluate(() => window.previewMessages), []);
  for (const boundary of [30, 60]) {
    await page.waitForFunction(ms => window.previewCalls.some(call => call.command === 'render_video_preview_clip' && call.args.startMs === ms), boundary * 1000);
    // Advance real media to just before each boundary; let the real ended event continue.
    await page.evaluate(() => { const video = document.querySelector('#videoFramePreviewVideo'); video.currentTime = video.duration - 0.2; });
    await page.waitForFunction(ms => Number(document.querySelector('#videoFrameTimestamp').value) > ms
      && !document.querySelector('#videoFramePreviewVideo').paused, boundary * 1000);
  }
  await page.locator('#videoFramePreviewToggle').click();
  assert.equal(await page.locator('#videoFramePreviewVideo').evaluate(video => video.paused), true);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const before = await page.locator('#videoFramePreviewVideo').boundingBox();
    await page.locator('#videoFrameExpandToggle').click();
    await page.waitForTimeout(280);
    const after = await page.locator('#videoFramePreviewVideo').boundingBox();
    assert.ok(after.width > before.width + 100, `${theme}: preview must expand`);
    assert.equal(await page.locator('#videoFrameOverlay .video-media-v2-sidebar').getAttribute('aria-hidden'), 'true');
    await page.screenshot({ path: path.join(output, `${theme}-expanded.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#videoFrameOverlay').evaluate(node => node.classList.contains('visible') && !node.classList.contains('is-expanded')), true);
  }
  for (const size of [{ width: 1100, height: 720 }, { width: 720, height: 480 }, { width: 390, height: 740 }]) {
    await page.setViewportSize(size);
    await page.locator('#videoFrameExpandToggle').click();
    await page.waitForTimeout(280);
    assert.equal(await page.locator('#videoFrameOverlay .video-media-v2-workspace').evaluate(node => node.scrollWidth <= node.clientWidth + 2), true);
    await page.locator('#videoFrameExport').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `expanded-${size.width}.png`) });
    await page.locator('#videoFrameExpandToggle').scrollIntoViewIfNeeded();
    await page.locator('#videoFrameExpandToggle').click();
  }
  await page.evaluate(() => { window.previewController.close(); window.previewController.open(); });
  assert.equal(await page.locator('#videoFrameEmpty').isVisible(), true);
  assert.equal(await page.locator('#videoFramePreviewVideo').getAttribute('src'), null);
  await page.evaluate(() => window.previewController.dispose());
  await page.waitForTimeout(100);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.previewMessages), []);
  console.log('Real Edge MP4 first play, 30/60-second continuation, pause, expand/Escape, dual themes, responsive layout and reopen passed');
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally { await browser.close(); await server.close(); }
