import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

if (process.env.TOOLKNIT_TEST_ISOLATED_NATIVE !== '1') {
  throw new Error('Run only against an isolated native verification instance, never the user application.');
}
const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const artifacts = path.resolve('tmp/pdf-security-navigation/native');
// The native allowlist accepts the executable's directory. Keep synthetic
// output there instead of changing the user's configured output root.
const output = path.resolve('src-tauri/target/debug/qa-pdf-security-navigation');
await mkdir(artifacts, { recursive: true });
await mkdir(output, { recursive: true });
const fixture = path.join(output, 'input.pdf');
const doc = await PDFDocument.create();
doc.addPage([420, 595]).drawText('ToolKnit native navigation fixture');
await writeFile(fixture, await doc.save());
const browser = await chromium.connectOverCDP(process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9247');
const page = browser.contexts().flatMap(context => context.pages()).find(page => /\/\/tauri\.localhost\//.test(page.url()));
assert.ok(page, 'isolated Tauri page exists');
page.setDefaultTimeout(15000);
const report = { checks: [], errors: [], scope: 'Native UI selection/navigation via the supported drag-drop event; separate real native command round trip with explicit test output. Window action dispatch has contract coverage, not actual desktop minimize/maximize/close.' };
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => {
  if (message.text().includes('Blocked aria-hidden')) report.errors.push(message.text());
});
const settle = () => page.waitForFunction(() => {
  const veil = document.querySelector('[data-tk-page-transition-veil]');
  return !veil || getComputedStyle(veil).visibility === 'hidden';
});
try {
  await page.evaluate(() => { localStorage.setItem('toolknit.theme.v3', 'light'); });
  await page.reload();
  await page.waitForSelector('#homeToolGrid .tool-result-card');
  const encrypted = await page.evaluate(({ fixture, output }) => window.__TAURI_INTERNALS__.invoke('encrypt_pdf', {
    inputPath: fixture, outputDir: output, password: 'ToolKnit-test-42', permissions: {
      printing: 'highResolution', modifying: true, copying: true, annotating: true,
      fillingForms: true, contentAccessibility: true, documentAssembly: true
    }
  }), { fixture, output });
  const rejected = await page.evaluate(async ({ encrypted, output }) => {
    try {
      await window.__TAURI_INTERNALS__.invoke('decrypt_pdf', { inputPath: encrypted, outputDir: output, password: 'wrong-test-password' });
      return false;
    } catch (error) { return String(error).includes('invalid-password'); }
  }, { encrypted, output });
  assert.equal(rejected, true);
  const decrypted = await page.evaluate(({ encrypted, output }) => window.__TAURI_INTERNALS__.invoke('decrypt_pdf', {
    inputPath: encrypted, outputDir: output, password: 'ToolKnit-test-42'
  }), { encrypted, output });
  for (const filename of [encrypted, decrypted]) {
    assert.equal(path.dirname(path.resolve(filename)).toLowerCase(), output.toLowerCase());
    assert.ok((await readFile(filename)).length > 200);
  }
  assert.equal((await PDFDocument.load(await readFile(decrypted))).getPageCount(), 1);
  report.checks.push('real native encryption, wrong-password rejection and successful decryption into the test workspace');

  for (const kind of ['encrypt', 'decrypt']) {
    const prefix = kind === 'encrypt' ? 'pdfEncrypt' : 'pdfDecrypt';
    await page.evaluate(kind => document.querySelector(`.audio-list-item[data-tool="pdf-${kind}"]`).click(), kind);
    await page.waitForSelector(`#${prefix}Overlay.visible`);
    await settle();
    await page.evaluate(file => window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
      target: { kind: 'Webview', label: 'main' }, event: 'tauri://drag-drop',
      payload: { paths: [file], position: { x: 400, y: 300 } }
    }), kind === 'encrypt' ? fixture : encrypted);
    await page.waitForSelector(`#${prefix}Files .audio-convert-file-name`);
    await page.locator(`#${prefix}ProcessBtn`).click();
    const root = `#${prefix}PasswordDialog`;
    await page.waitForFunction(selector => document.querySelector(selector)?.classList.contains('visible')
      && getComputedStyle(document.querySelector(selector)).opacity === '1', root);
    assert.equal(await page.locator(`${root} > .pdf-merge-v2-topbar button`).count(), 7);
    await page.locator(`#${prefix}PasswordInput`).fill('ToolKnit-test-42');
    await page.locator(`#${prefix}V2Settings`).click();
    await settle();
    await page.locator('#settingsBack').click();
    await settle();
    assert.equal(await page.locator(`#${prefix}PasswordInput`).inputValue(), 'ToolKnit-test-42');
    await page.screenshot({ path: path.join(artifacts, `${kind}-password.png`) });
    await page.locator(`#${prefix}Back`).click();
    assert.equal(await page.locator(`#${prefix}Files .audio-convert-file-name`).count(), 1);
    assert.equal(await page.locator(`#${prefix}PasswordInput`).inputValue(), '');
    assert.equal(await page.locator(`#${prefix}Overlay > .pdf-merge-v2-topbar`).count(), 1);
    await page.locator(`#${prefix}ProcessBtn`).click();
    await page.waitForSelector(`${root}.visible`);
    await page.locator(`#${prefix}PasswordInput`).focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(root).evaluate(node => node.inert && !node.classList.contains('visible')), true);
    await page.locator(`#${prefix}Back`).click();
    await settle();
    report.checks.push(`${kind}: native drag-drop selection, complete navigation, settings return, local Back, Escape and password clearing`);
  }
  assert.deepEqual(report.errors, []);
  console.log('Native PDF password navigation and separate real encryption/decryption command round trip passed.');
} catch (error) {
  report.failure = String(error.stack || error);
  await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
