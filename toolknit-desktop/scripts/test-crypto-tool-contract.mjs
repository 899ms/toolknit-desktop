import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [controller, tool, compatibility, lazySpecs, featureStyles, index] = await Promise.all([
  readFile(new URL('../src/features/crypto/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crypto/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/crypto-tool-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/lazy-tools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crypto/crypto.css', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8')
]);

assert.match(tool, /from ['"]\.\/controller\.js['"]/, 'crypto entry must delegate behavior to its controller');
assert.match(tool, /import ['"]\.\/crypto\.css['"]/, 'crypto entry must own its lazy stylesheet');
assert.match(controller, /createLifecycleScope\(\)/, 'crypto controller must own listener lifecycle');
assert.match(controller, /lifecycle\.event\(overlay,\s*['"]click['"]/, 'crypto events must be scoped');
assert.match(controller, /dispose\(\)\{[^}]*api\.close\(\)/, 'crypto dispose must close the active session');
assert.match(controller, /worker\?\.terminate\(\)/, 'crypto close must terminate worker resources');
assert.match(controller, /tauriCorePromise/, 'crypto controller must use the platform Tauri boundary');
assert.doesNotMatch(controller, /from ['"]@tauri-apps\//, 'crypto controller must not bypass the platform boundary');
assert.match(compatibility, /from ['"]\.\/features\/crypto\/tool\.js['"]/, 'legacy crypto UI path must forward to the feature entry');
assert.match(lazySpecs, /'hash-crypto'[\s\S]*?\.\/crypto\/tool\.js/, 'hash crypto must load from the feature entry');
assert.match(featureStyles, /data-crypto-panel/, 'feature styles must own crypto panel state');
assert.match(index, /id="cryptoToolOverlay"/, 'crypto overlay DOM contract must remain present');

console.log('crypto tool contract passed');
