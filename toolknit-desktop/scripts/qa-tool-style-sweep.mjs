import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';

const require = createRequire(process.env.TOOLKNIT_TEST_MODULES
  ? path.join(process.env.TOOLKNIT_TEST_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.TOOLKNIT_TEST_BROWSER ? { executablePath: process.env.TOOLKNIT_TEST_BROWSER } : {}) });
const results = [];
const reportPath = path.resolve('tmp/tool-style-sweep.json');
await mkdir(path.dirname(reportPath), { recursive: true });
try {
  for (const [tool, spec] of Object.entries(LAZY_TOOL_SPECS)) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
    // Synthetic configuration unlocks empty AI pages; no generation or upload
    // is performed, and nonlocal HTTP requests cannot leave this QA context.
    await page.addInitScript(() => localStorage.setItem('ai_api_key', 'local-style-qa-not-a-key'));
    await page.route('https://**/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    try {
      await page.goto(process.env.TOOLKNIT_TEST_URL || 'http://localhost:1420/');
      const card = page.locator(`.audio-list-item[data-tool="${tool}"]`);
      await card.waitFor({ state: 'attached' });
      await card.evaluate(node => node.click());
      if (tool === 'transcription') {
        // This tool intentionally refuses browser operation. Inspect only its
        // mounted empty template; this is not a transcription behavior test.
        await page.waitForSelector(`#${spec.overlayId} .pdf-merge-v2-topbar`, { state: 'attached' });
        await page.locator(`#${spec.overlayId}`).evaluate(node => {
          node.classList.add('visible'); node.removeAttribute('inert'); node.setAttribute('aria-hidden', 'false');
        });
      }
      await page.waitForFunction(id => document.getElementById(id)?.classList.contains('visible'), spec.overlayId, { timeout: 8000 });
      await page.waitForTimeout(500);
      const result = await page.locator(`#${spec.overlayId}`).evaluate(root => {
        const rgb = value => value.match(/[\d.]+/g)?.map(Number) || [];
        const luminance = values => values.slice(0, 3).map(v => v / 255)
          .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const issues = [];
        let checked = 0;
        for (const button of root.querySelectorAll('button, input, select')) {
          const s = getComputedStyle(button), box = button.getBoundingClientRect();
          if (button.disabled || button.closest('[inert]') || s.visibility !== 'visible'
            || box.width < 5 || box.height < 5 || s.opacity < 0.8) continue;
          const bg = rgb(s.backgroundColor), fg = rgb(s.color);
          if (bg.length < 3 || (bg[3] ?? 1) < 0.9 || luminance(bg) < 0.6) continue;
          checked++;
          const ratio = (Math.max(luminance(bg), luminance(fg)) + 0.05) / (Math.min(luminance(bg), luminance(fg)) + 0.05);
          if (ratio < 3) issues.push({ id: button.id, classes: button.className, text: button.textContent.trim().slice(0, 60), color: s.color, background: s.backgroundColor, ratio });
        }
        const back = root.querySelector('.pdf-merge-v2-back, .tool-page-v2-back');
        const support = root.querySelector('.home-v2-support-top, .tool-page-v2-support');
        for (const [name, button] of [['back', back], ['support', support]]) {
          if (!button || getComputedStyle(button).borderRadius !== '999px') issues.push({ nav: name, reason: 'navigation pill radius missing' });
        }
        const website = root.querySelector('.home-v2-nav-link');
        return { checked, issues, nav: { backFont: back && getComputedStyle(back).fontSize,
          backRadius: back && getComputedStyle(back).borderRadius, supportRadius: support && getComputedStyle(support).borderRadius,
          websiteFont: website && getComputedStyle(website).fontSize, websiteColor: website && getComputedStyle(website).color } };
      });
      results.push({ tool, templateOnly: tool === 'transcription', ...result });
      console.log(`${tool}: ${result.checked} light controls, ${result.issues.length} low-contrast`);
    } catch (error) {
      results.push({ tool, error: String(error.message) });
      console.log(`${tool}: unable to inspect`);
    } finally { await page.close(); }
  }
  await writeFile(reportPath, JSON.stringify(results, null, 2));
  const problems = results.filter(r => r.error || r.issues.length);
  assert.deepEqual(problems, [], JSON.stringify(problems));
  console.log(`Style sweep passed: ${results.length} tools`);
} finally { await browser.close(); }
