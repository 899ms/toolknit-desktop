import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveFfmpeg, runFfmpeg } from '../cli/lib/ffmpeg-runtime.mjs';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const root = await mkdtemp(path.join(os.tmpdir(), 'toolknit-audio-pages-'));
const output = path.join(root, 'out');
await mkdir(output);
const evidence = path.resolve('tmp/audio-pages');
await mkdir(evidence, { recursive: true });
const ffmpeg = await resolveFfmpeg();
const audio = path.join(root, 'tone.wav');
const video = path.join(root, 'tracks.mp4');
const empty = path.join(root, 'empty.wav');
await writeFile(empty, '');
for (const args of [
  ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-c:a', 'pcm_s16le', audio],
  ['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.5', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', video]
]) {
  const result = await runFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args]);
  assert.equal(result.code, 0, 'synthetic media generation');
}
const browser = await chromium.connectOverCDP(process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find(p => /localhost/.test(p.url()));
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.setDefaultTimeout(20000);
const report = { status: 'running', errors };

async function settle() {
  await page.waitForFunction(() => {
    const n = document.querySelector('[data-tk-page-transition-veil]');
    return !n || getComputedStyle(n).visibility === 'hidden';
  });
}
async function open(tool, overlay) {
  await page.evaluate(tool => window.audioQa.tools[tool].open(), tool);
  await page.waitForSelector(`${overlay}.visible`);
  await settle();
}
async function darkControl(selector) {
  const result = await page.locator(selector).evaluate(node => {
    const s = getComputedStyle(node);
    const channels = s.color.match(/[\d.]+/g).slice(0, 3).map(Number);
    return { color: s.color, dark: channels.every(n => n < 70), opacity: s.opacity, transform: s.transform };
  });
  assert.equal(result.dark, true, `${selector}: light buttons require dark foreground`);
  return result;
}
try {
  assert.match(page.url(), /^http:\/\/localhost:1420/, 'QA must use the live development page, not embedded dist');
  await page.reload();
  await page.waitForSelector('[data-home-tool]', { state: 'attached' });
  await page.evaluate(async ({ output }) => {
    const [{ tauriCorePromise }, { t, onLangChange }, convert, extract] = await Promise.all([
      import('/src/platform/tauri-runtime.js'), import('/src/i18n.js'),
      import('/src/features/audio-convert/tool.js'), import('/src/features/audio-extract/tool.js')
    ]);
    const { invoke: native } = await tauriCorePromise;
    window.audioQa = { nextFile: null, requests: [], folders: [], tools: {} };
    // Only the file picker and output destination are redirected. File size,
    // probing, conversion and extraction still execute the real Rust commands.
    const invoke = (command, args, options) => {
      if (['convert_audio_batch', 'extract_audio'].includes(command)) {
        args = { ...args, outputDir: output };
        window.audioQa.requests.push({ command, trackIndex: args.trackIndex });
      }
      return native(command, args, options);
    };
    const context = { isTauri: true, t, onLangChange, tauriCore: Promise.resolve({ invoke }),
      loadDialog: async () => ({ open: async () => window.audioQa.nextFile }),
      getOutputDir: async () => output, ensureFfmpegAvailable: async () => true,
      openOutputFolder: async value => { window.audioQa.folders.push(value); },
      notify: (...args) => window.showToast(...args) };
    window.audioQa.tools.convert = convert.initAudioConvertTool({ ...context, overlay: document.getElementById('audioConvertFeatureOverlay') });
    window.audioQa.tools['audio-extract'] = extract.initAudioExtractTool({ ...context, overlay: document.getElementById('audioExtractFeatureOverlay') });
  }, { output });

  await open('convert', '#audioConvertFeatureOverlay');
  await page.evaluate(file => { window.audioQa.nextFile = [file]; }, audio);
  await page.locator('[data-audio-convert-action="choose"]').click();
  await page.waitForSelector('[data-audio-convert-files] .audio-convert-file-item');
  assert.match(await page.locator('.audio-convert-file-size').innerText(), /KB|B/);
  await page.waitForTimeout(1300);
  report.convertStart = await darkControl('[data-audio-convert-action="start"]');
  assert.equal(report.convertStart.opacity, '1');
  await page.locator('[data-audio-convert-action="start"]').click();
  await page.waitForSelector('[data-audio-convert-success].visible');
  await darkControl('[data-audio-convert-action="open-folder"]');
  await page.screenshot({ path: path.join(evidence, 'conversion-success.png') });
  await page.locator('[data-audio-convert-action="open-folder"]').click();
  await page.evaluate(file => { window.audioQa.nextFile = [file]; }, empty);
  await page.locator('[data-audio-convert-action="choose"]').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-audio-convert-files] .audio-convert-file-item').count(), 0);
  const invalidMessage = await page.evaluate(async () => (await import('/src/i18n.js')).t('home.audioConvert.invalidInput'));
  assert.ok((await page.locator('.app-toast').allTextContents()).some(text => text.includes(invalidMessage)));
  report.convert = { nativeOutput: true, actualFileSize: true, emptyRejected: true, localizedError: true };
  await page.locator('[data-audio-convert-action="back"]').click();
  await settle();

  await open('audio-extract', '#audioExtractFeatureOverlay');
  await darkControl('[data-audio-extract-action="choose"]');
  report.extractNav = await page.locator('[data-audio-extract-action="back"]').evaluate(n => getComputedStyle(n).fontSize);
  assert.equal(report.extractNav, '14px');
  await page.evaluate(file => { window.audioQa.nextFile = file; }, video);
  await page.locator('[data-audio-extract-action="choose"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-audio-extract-action="start"]').disabled);
  const tracks = await page.locator('[data-audio-extract-track] option').evaluateAll(nodes => nodes.map(n => n.value));
  assert.equal(tracks.length, 2);
  await page.locator('[data-audio-extract-track]').selectOption(tracks[1]);
  await page.waitForTimeout(1600);
  report.extractStart = await darkControl('[data-audio-extract-action="start"]');
  assert.equal(report.extractStart.opacity, '1');
  assert.equal(report.extractStart.transform, 'none');
  await page.screenshot({ path: path.join(evidence, 'extract-ready.png') });
  await page.locator('[data-audio-extract-action="start"]').click();
  await page.waitForSelector('[data-audio-extract-success].visible');
  await darkControl('[data-audio-extract-action="open-folder"]');
  assert.equal(await page.evaluate(() => window.audioQa.requests.at(-1).trackIndex), Number(tracks[1]));
  await page.screenshot({ path: path.join(evidence, 'extract-success.png') });
  await page.locator('[data-audio-extract-action="open-folder"]').click();
  assert.equal(await page.evaluate(() => window.audioQa.folders.length), 2);
  report.extract = { nativeOutput: true, startStaysVisible: true, selectedTrackPreserved: true, folderButton: true };
  const outputs = await readdir(output);
  assert.equal(outputs.filter(name => name.endsWith('.mp3')).length, 2);
  for (const name of outputs.filter(name => name.endsWith('.mp3'))) assert.ok((await stat(path.join(output, name))).size > 0);
  assert.deepEqual(errors, []);
  report.status = 'passed';
  console.log('Audio pages native QA passed: sizes, conversion, extraction, track choice and visible/dark controls');
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error);
  throw error;
} finally {
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  await page.reload().catch(() => {});
  await browser.close();
  await rm(root, { recursive: true, force: true });
}
