import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LIGHT_VIEWPORTS = [
  [1400, 887],
  [1024, 480],
  [720, 480],
  [390, 740]
];

const RELEASE_COPY = Object.freeze({
  zh: {
    summary: '本次版本集中完善白天模式、工具稳定性与本地处理流程，并保持更新决定始终由用户掌控。',
    notes: [
      { title: '更完整的白天模式', body: '工具页、帮助页和设置弹窗使用一致且清晰的视觉层级。' },
      { title: '更可靠的本地处理', body: '文件处理、失败恢复和输出路径反馈更加明确。' },
      { title: '更稳妥的更新流程', body: '下载、验证与安装阶段保持分离，当前版本不受失败影响。' }
    ]
  },
  en: {
    summary: 'This release completes the light theme, improves tool reliability, and keeps every update decision under your control.',
    notes: [
      { title: 'A complete light theme', body: 'Tools, help pages, settings, and dialogs now share a clear visual hierarchy.' },
      { title: 'More reliable local work', body: 'File processing, recovery, and output location feedback are easier to follow.' },
      { title: 'A safer update flow', body: 'Download, verification, and installation stay separate so the current version remains usable.' }
    ]
  }
});

export async function checkUpdatePreviewTheme(browser, url, output) {
  await mkdir(output, { recursive: true });
  const report = { layouts: [], errors: [] };
  const origin = new URL(url).origin;
  const scenarios = [
    { language: 'zh', theme: 'light', viewports: LIGHT_VIEWPORTS },
    { language: 'en', theme: 'light', viewports: LIGHT_VIEWPORTS },
    { language: 'zh', theme: 'dark', viewports: [[1400, 887]] }
  ];

  for (const { language, theme, viewports } of scenarios) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 887 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      if (message.text().includes('Blocked aria-hidden')) report.errors.push(message.text());
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin
      ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await context.addInitScript(({ selectedLanguage, selectedTheme }) => {
      localStorage.setItem('toolknit.theme.v3', selectedTheme);
      localStorage.setItem('toolknit-lang', selectedLanguage);
    }, { selectedLanguage: language, selectedTheme: theme });

    const capture = name => page.screenshot({
      path: path.join(output, `${language}-${theme}-${name}.png`),
      animations: 'disabled',
      fullPage: false
    });

    try {
      await page.goto(url);
      await page.waitForSelector('#homeToolGrid .tool-result-card');
      await page.locator('#homeV2Settings').focus();
      await page.evaluate(release => window.openToolKnitUpdatePreview?.({
        version: '3.0.1',
        currentVersion: '3.0.0',
        ...release
      }), RELEASE_COPY[language]);
      await page.waitForSelector('#updatePreviewOverlay.visible');
      await page.waitForFunction(() => document.activeElement?.matches('[data-update-now]'));
      assert.equal(await page.locator('#updatePreviewOverlay').getAttribute('aria-hidden'), 'false');
      assert.equal(await page.locator('.app').evaluate(node => node.inert), true);

      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height });
        await page.locator('#updatePreviewOverlay').evaluate(node => { node.scrollTop = 0; });
        await page.evaluate(() => document.fonts.ready);
        const metrics = await page.locator('#updatePreviewOverlay').evaluate(overlay => {
          const rect = node => {
            const value = node.getBoundingClientRect();
            return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
          };
          const left = overlay.querySelector('.update-preview-left');
          const right = overlay.querySelector('.update-preview-right');
          const main = overlay.querySelector('.update-preview-left-main');
          const release = overlay.querySelector('.update-preview-release');
          const footer = overlay.querySelector('.update-preview-stage-footer');
          const controls = overlay.querySelector('.update-preview-window-controls');
          const failures = [];
          for (const node of overlay.querySelectorAll('button, a, h1, h2, p, strong')) {
            if (node.closest('.update-preview-marquee') || node.hidden) continue;
            const value = node.getBoundingClientRect();
            if (!value.width || !value.height || getComputedStyle(node).visibility === 'hidden') continue;
            if (value.left < -1 || value.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 2) {
              failures.push(node.id || node.className || node.tagName);
            }
          }
          return {
            viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            overlay: { clientHeight: overlay.clientHeight, scrollHeight: overlay.scrollHeight },
            columns: getComputedStyle(overlay.querySelector('.update-preview-shell')).gridTemplateColumns,
            left: rect(left),
            right: rect(right),
            main: { ...rect(main), clientHeight: main.clientHeight, scrollHeight: main.scrollHeight },
            release: { ...rect(release), clientHeight: release.clientHeight, scrollHeight: release.scrollHeight },
            footer: rect(footer),
            controls: rect(controls),
            failures,
            palette: {
              shell: getComputedStyle(overlay.querySelector('.update-preview-shell')).backgroundColor,
              left: getComputedStyle(left).backgroundColor,
              stage: getComputedStyle(overlay.querySelector('.update-preview-stage')).backgroundColor
            }
          };
        });

        assert.ok(metrics.documentWidth <= width + 1, `${language} ${width}x${height}: no root horizontal overflow`);
        assert.deepEqual(metrics.failures, [], `${language} ${width}x${height}: update text and controls fit`);
        assert.deepEqual(metrics.palette, {
          shell: 'rgb(255, 255, 255)',
          left: 'rgb(255, 255, 255)',
          stage: 'rgb(22, 24, 29)'
        }, `${language} ${theme}: intentional split palette is stable`);
        assert.ok(metrics.controls.left >= 0 && metrics.controls.right <= width + 1, `${language} ${width}: window controls remain reachable`);
        assert.ok(metrics.release.bottom <= metrics.footer.top + 1, `${language} ${width}x${height}: release content does not cover footer`);

        if (width <= 900) {
          assert.ok(metrics.left.bottom <= metrics.right.top + 1, `${language} ${width}: sections stack without overlap`);
          assert.ok(metrics.overlay.scrollHeight > metrics.overlay.clientHeight, `${language} ${width}: stacked page has a vertical scroll owner`);
          await page.locator('#updatePreviewOverlay').evaluate(node => { node.scrollTop = node.scrollHeight; });
          assert.ok(await page.locator('#updatePreviewOverlay').evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 1));
        } else {
          assert.ok(metrics.left.right <= metrics.right.left + 1, `${language} ${width}: desktop sections stay side by side`);
          for (const selector of ['.update-preview-left-main', '.update-preview-release']) {
            await page.locator(selector).evaluate(node => { node.scrollTop = node.scrollHeight; });
            assert.ok(await page.locator(selector).evaluate(node => node.scrollTop + node.clientHeight >= node.scrollHeight - 1), `${language} ${width}x${height}: ${selector} content is reachable`);
          }
        }

        await capture(`${width}x${height}`);
        report.layouts.push({ language, theme, ...metrics });
      }

      await page.setViewportSize({ width: 1400, height: 887 });
      await page.locator('#updatePreviewOverlay').evaluate(node => { node.scrollTop = 0; });
      await page.locator('[data-update-now]').focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.locator('[data-update-link="feedback"]').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('[data-update-now]').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#updatePreviewOverlay').classList.contains('visible'));
      assert.equal(await page.locator('#updatePreviewOverlay').getAttribute('aria-hidden'), 'true');
      assert.equal(await page.locator('.app').evaluate(node => node.inert), false);
      assert.equal(await page.locator('#homeV2Settings').evaluate(node => node === document.activeElement), true);
    } catch (error) {
      await capture('failure').catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }

  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(report.errors, []);
  return `${report.layouts.length} update preview layouts, focus lifecycle and theme isolation`;
}
