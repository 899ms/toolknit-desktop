import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const script = await read('src-tauri/src/platform/qa-devtools.js');
const config = JSON.parse(await read('src-tauri/tauri.test.conf.json'));
const release = JSON.parse(await read('src-tauri/tauri.conf.json'));
const cargo = await read('src-tauri/Cargo.toml');
assert.match(cargo, /qa-devtools = \["tauri\/devtools"\]/);
assert.match(cargo, /default = \["custom-protocol"\]/);
assert.equal(config.app.windows[0].devtools, true);
assert.equal(release.app.windows[0].devtools, false);
assert.doesNotMatch(config.app.windows[0].additionalBrowserArgs, /remote-debugging|auto-open-devtools/);
const capability = config.app.security.capabilities.find(item => item.identifier === 'qa-devtools');
assert.deepEqual(capability.windows, ['main']);
assert.deepEqual(capability.permissions, ['core:webview:allow-internal-toggle-devtools']);

let listener, bindings = 0, calls = 0, finish, shouldFail = false, logged = 0;
const context = vm.createContext({
  window: { __TAURI_INTERNALS__: { invoke: command => {
    assert.equal(command, 'plugin:webview|internal_toggle_devtools');
    calls += 1;
    return shouldFail ? Promise.reject(new Error('expected')) : new Promise(resolve => { finish = resolve; });
  } } },
  document: { addEventListener(type, callback, capture) {
    assert.equal(type, 'keydown'); assert.equal(capture, true); listener = callback; bindings += 1;
  } },
  console: { error() { logged += 1; } }
});
vm.runInContext(script, context);
vm.runInContext(script, context);
assert.equal(bindings, 1, 'page-load injection is idempotent');
const key = (code, repeat = false) => {
  const event = { code, key: code, repeat, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  listener(event); return event;
};
assert.equal(key('Enter').prevented, false);
const f12 = key('F12');
assert.equal(f12.prevented, true); assert.equal(f12.stopped, true);
key('F12', true); key('F12'); assert.equal(calls, 1, 'one toggle while the key repeats or IPC is pending');
finish(); await new Promise(resolve => setImmediate(resolve));
shouldFail = true; key('F12'); await new Promise(resolve => setImmediate(resolve));
assert.equal(logged, 1, 'failed IPC is handled');
shouldFail = false; key('F12'); assert.equal(calls, 3, 'shortcut recovers after IPC failure');
finish(); await new Promise(resolve => setImmediate(resolve));
console.log('Test-package F12 shortcut, permissions and production isolation passed');
