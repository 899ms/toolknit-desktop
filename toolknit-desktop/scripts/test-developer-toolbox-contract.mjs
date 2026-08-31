import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, main, lazyTools, lazyRegistry, ui, core, styles, finalStyles] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/lazy-tool-registry.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/developer-toolbox-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/developer-toolbox-core.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/tool-page-v2-final.css', import.meta.url), 'utf8')
]);

for (const id of ['json-tools', 'base64', 'url-codec', 'uuid', 'jwt']) assert.match(html, new RegExp(`data-tool="${id}"`));
assert.match(html, /id="developerToolboxOverlay"/);
assert.match(lazyTools, /instanceKey: 'developer-toolbox'/);
assert.match(lazyRegistry, /await instance\.open\(toolId\)/);
assert.match(main, /createLazyToolRegistry\([\s\S]*specs:\s*LAZY_TOOL_SPECS/);
assert.match(ui, /clearTimeout\(timer\)/);
assert.doesNotMatch(ui, /localStorage|sessionStorage/);
assert.doesNotMatch(ui, /data-dev-run/);
assert.match(ui, /data-json-indent-trigger/);
assert.match(ui, /data-json-indent-option/);
assert.match(core, /DEVELOPER_TOOL_MAX_TEXT/);
assert.match(core, /describeDeveloperToolError/);
assert.match(styles, /\.developer-toolbox-overlay/);
assert.match(finalStyles, /\.developer-toolbox-status\.is-error/);
assert.match(finalStyles, /grid-template-rows: 28px minmax\(0,1fr\)/);
assert.match(finalStyles, /\.developer-toolbox-select-menu/);
assert.match(finalStyles, /background: #e9eaec/);
console.log('developer toolbox contract passed');
