import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkHelpTheme(browser, url, output) {
  await mkdir(output, { recursive: true });
  const report = { layouts: [], sections: [], errors: [] };
  const origin = new URL(url).origin;
  for (const language of ['zh', 'en']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 887 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      if (message.text().includes('Blocked aria-hidden')) report.errors.push(message.text());
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin
      ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await context.addInitScript(lang => {
      localStorage.setItem('toolknit.theme.v3', 'light');
      localStorage.setItem('toolknit-lang', lang);
    }, language);
    const settle = () => page.waitForFunction(() => {
      const veil = document.querySelector('[data-tk-page-transition-veil]');
      return !veil || getComputedStyle(veil).visibility === 'hidden';
    });
    const click = async selector => { await page.locator(selector).click(); await settle(); };
    const style = (selector, property) => page.locator(selector).first().evaluate((n, key) => getComputedStyle(n)[key], property);
    const capture = name => page.screenshot({ path: path.join(output, `${language}-${name}.png`), animations: 'disabled' });
    async function layout(root, name) {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(selector => getComputedStyle(document.querySelector(`${selector} .help-nav-item.active`)).backgroundColor === 'rgb(17, 17, 17)', root);
      const metrics = await page.locator(root).evaluate(overlay => {
        const sidebar = overlay.querySelector('.help-sidebar');
        const body = overlay.querySelector('.help-content-body');
        const header = overlay.querySelector('.help-v2-topbar, .help-content-header');
        const rect = n => {
          const r = n.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const failures = [];
        for (const n of overlay.querySelectorAll('button, input, .help-sidebar, .help-content-body, .help-content-title, .help-v2-topbar')) {
          const r = n.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          if (r.left < -1 || r.right > innerWidth + 1 || n.scrollWidth > n.clientWidth + 2) failures.push(n.id || n.className);
        }
        return { sidebar: rect(sidebar), body: rect(body), header: rect(header), failures, radius: getComputedStyle(sidebar).borderRadius };
      });
      assert.deepEqual(metrics.failures, [], `${language} ${name}: controls fit the viewport`);
      assert.equal(metrics.radius, '32px');
      assert.ok(metrics.body.width > 250 && metrics.body.height > 80, `${name}: readable content area`);
      if (page.viewportSize().width > 820) assert.ok(metrics.sidebar.right <= metrics.body.left, `${name}: separate columns`);
      else assert.ok(metrics.sidebar.bottom <= metrics.body.top + 1, `${name}: stacked without overlap`);
      assert.equal(await style(`${root} .help-sidebar`, 'backgroundColor'), 'rgb(231, 232, 234)');
      assert.equal(await style(`${root} .help-nav-item.active`, 'backgroundColor'), 'rgb(17, 17, 17)');
      assert.equal(await style(`${root} .help-nav-item.active`, 'color'), 'rgb(255, 255, 255)');
      assert.equal(await style(root, 'backgroundColor'), 'rgb(255, 255, 255)');
      report.layouts.push({ language, name, viewport: page.viewportSize(), ...metrics });
      await capture(name);
    }
    async function checkText(root) {
      const failures = await page.locator(`${root} .help-doc`).evaluate(doc => {
        const results = [];
        for (const n of doc.querySelectorAll('h2, h3, h4, p, li, strong, code, .help-faq-q, .help-faq-a, .help-tool-card-name, .help-tool-card-desc')) {
          const c = getComputedStyle(n).color;
          if (!/^rgb\((17, 17, 17|25, 25, 25|85, 85, 85)\)$/.test(c)) results.push({ tag: n.tagName, class: n.className, color: c });
        }
        return results;
      });
      assert.deepEqual(failures, [], `${root}: document text uses the light palette`);
    }
    try {
      await page.goto(url);
      await page.waitForSelector('#homeToolGrid .tool-result-card');
      await click('#homeV2Settings');
      await click('#helpLink');
      assert.equal(await style('#helpOverlay .home-v2-support-top', 'backgroundColor'), 'rgb(17, 17, 17)');
      assert.equal(await style('#helpOverlay .home-v2-support-top', 'color'), 'rgb(255, 255, 255)');
      const sections = await page.locator('#helpNav [data-help-section]').evaluateAll(nodes => nodes.map(n => n.dataset.helpSection));
      for (const section of sections) {
        await click(`#helpNav [data-help-section="${section}"]`);
        await checkText('#helpOverlay');
        report.sections.push({ language, section });
      }
      await click('#helpNav [data-help-section="cli-guide"]');
      assert.equal(await style('#helpContentBody .help-steps li', 'display'), 'block', 'inline code stays inside the step sentence');
      await capture('help-cli');
      await click('#helpNav [data-help-section="agent-guide"]');
      const copy = page.locator('#helpContentBody .help-prompt-copy').first();
      await copy.scrollIntoViewIfNeeded();
      await page.keyboard.press('Tab');
      await copy.focus();
      assert.equal(await copy.evaluate(n => getComputedStyle(n).outlineColor), 'rgb(17, 17, 17)');
      await copy.click();
      await page.waitForSelector('#helpContentBody .help-prompt-copy.is-copied');
      await capture('help-agent');
      await page.locator('#helpSearchInput').fill('zzzz-no-help-match-98765');
      await page.waitForSelector('#helpContentBody .help-search-empty');
      assert.equal(await style('#helpContentBody .help-search-empty', 'color'), 'rgb(85, 85, 85)');
      await capture('help-empty');
      await page.locator('#helpSearchInput').fill('PDF');
      assert.ok(await page.locator('#helpNav .help-nav-item:visible').count() > 0);
      await page.locator('#helpSearchInput').fill('');
      await click('#helpNav [data-help-section="overview"]');
      await page.locator('#helpNav').evaluate(n => { n.scrollTop = 0; });
      for (const [width, height] of [[1400, 887], [1024, 480], [820, 600], [720, 480], [390, 740]]) {
        await page.setViewportSize({ width, height });
        await page.locator('#helpOverlay .help-v2-layout').evaluate(n => { n.scrollTop = 0; });
        await layout('#helpOverlay', `help-${width}`);
        const scrollOwner = width <= 820 ? '#helpOverlay .help-v2-layout' : '#helpContentBody';
        await page.locator(scrollOwner).evaluate(n => { n.scrollTop = n.scrollHeight; });
        assert.ok(await page.locator(scrollOwner).evaluate(n => n.scrollTop + n.clientHeight >= n.scrollHeight - 1), 'help text remains reachable');
        await capture(`help-${width}-bottom`);
        await page.locator(scrollOwner).evaluate(n => { n.scrollTop = 0; });
      }
      await page.setViewportSize({ width: 1400, height: 887 });
      await page.locator('#helpBackBtn').hover();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#helpBackBtn')).borderTopColor === 'rgb(0, 0, 0)');
      assert.equal(await style('#helpBackBtn', 'transform'), 'none');
      await capture('help-back-hover');
      await page.keyboard.press('Escape');
      await settle();
      await page.waitForFunction(() => !document.querySelector('#helpOverlay').classList.contains('visible'));
      await click('#homeV2Settings');
      for (const [entry, section] of [['#declarationLink', 'declaration'], ['#usagePolicyLink', 'usage-policy']]) {
        await click(entry);
        assert.equal(await page.locator('#legalNav .active').getAttribute('data-legal-section'), section);
        await checkText('#legalOverlay');
        for (const [width, height] of [[1400, 887], [1024, 480], [720, 480], [390, 740]]) {
          await page.setViewportSize({ width, height });
          await layout('#legalOverlay', `${section}-${width}`);
          await page.locator('#legalContentBody').evaluate(n => { n.scrollTop = n.scrollHeight; });
          assert.ok(await page.locator('#legalContentBody').evaluate(n => n.scrollTop + n.clientHeight >= n.scrollHeight - 1));
          await capture(`${section}-${width}-bottom`);
          await page.locator('#legalContentBody').evaluate(n => { n.scrollTop = 0; });
        }
        await click(`#legalNav [data-legal-section="${section === 'declaration' ? 'usage-policy' : 'declaration'}"]`);
        await checkText('#legalOverlay');
        await page.locator('#legalBackBtn').hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#legalBackBtn')).borderTopColor === 'rgb(0, 0, 0)');
        await click('#legalBackBtn');
        await page.waitForFunction(() => !document.querySelector('#legalOverlay').classList.contains('visible'));
        assert.equal(await page.locator('#legalOverlay').evaluate(n => n.contains(document.activeElement)), false);
        await page.setViewportSize({ width: 1400, height: 887 });
      }
      await click('[data-theme-choice="dark"]');
      await click('#declarationLink');
      assert.equal(await style('#legalOverlay', 'display'), 'flex');
      assert.equal(await style('#legalOverlay', 'backgroundColor'), 'rgb(0, 0, 0)');
      await capture('dark-legal');
      await click('#legalBackBtn');
      await click('#helpLink');
      assert.equal(await style('#helpOverlay', 'backgroundColor'), 'rgb(5, 5, 6)');
      await capture('dark-help');
      await click('#helpV2Settings');
      await click('[data-theme-choice="light"]');
      await click('#helpLink');
      assert.equal(await style('#helpOverlay', 'backgroundColor'), 'rgb(255, 255, 255)');
      await click('#helpBackBtn');
      await click('#homeV2Settings');
      await click('#helpLink');
      assert.equal(await page.locator('#helpSearchInput').inputValue(), '');
      await page.reload();
      await page.waitForSelector('#homeToolGrid .tool-result-card');
      await click('#homeV2Settings');
      await click('#helpLink');
      assert.equal(await style('#helpOverlay', 'backgroundColor'), 'rgb(255, 255, 255)');
    } catch (error) {
      await capture('failure').catch(() => {});
      throw error;
    } finally {
      await context.close();
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    }
  }
  assert.deepEqual(report.errors, []);
  return `${report.layouts.length} help/legal layouts and ${report.sections.length} localized help sections`;
}
