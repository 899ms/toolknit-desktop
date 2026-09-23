import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [runner, devtoolsModule, shortcut, cargo, releaseConfigText, testConfigText] = await Promise.all([
  readFile(new URL('../src-tauri/src/native_runtime/runner.rs', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/platform/qa_devtools.rs', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/src/platform/qa-devtools.js', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/tauri.test.conf.json', import.meta.url), 'utf8')
]);

const releaseConfig = JSON.parse(releaseConfigText);
const testConfig = JSON.parse(testConfigText);
const releaseWindow = releaseConfig.app.windows.find(window => window.label === 'main');
const testWindow = testConfig.app.windows.find(window => window.label === 'main');

assert.equal(releaseWindow.devtools, false, 'production package must keep DevTools disabled');
assert.equal(testWindow.devtools, true, 'F12 test package must enable DevTools');
assert.match(cargo, /qa-devtools\s*=\s*\["tauri\/devtools"\]/, 'QA feature must enable the Tauri DevTools dependency');
assert.match(runner, /cfg\(feature = "qa-devtools"\)[\s\S]*qa_devtools::install/, 'QA shortcut must only install in the QA build');
assert.match(devtoolsModule, /include_str!\("qa-devtools\.js"\)/, 'QA installer must inject the shortcut script');
assert.match(shortcut, /event\.code !== 'F12'/, 'QA shortcut must listen for F12');
assert.match(shortcut, /plugin:webview\|internal_toggle_devtools/, 'QA shortcut must use the internal DevTools command');
const capabilityIds = testConfig.app.security.capabilities.map(capability => (
  typeof capability === 'string' ? capability : capability.identifier
));
assert.ok(capabilityIds.includes('default'), 'QA config must retain default capabilities');
assert.ok(capabilityIds.includes('qa-devtools'), 'QA config must include the QA capability');

console.log('QA DevTools contract passed');
