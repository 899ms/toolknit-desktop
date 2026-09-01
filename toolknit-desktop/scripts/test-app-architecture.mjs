import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLazyToolRegistry, validateLazyToolSpecs } from '../src/app/lazy-tool-registry.js';
import { createLifecycleScope, normalizeToolInstance } from '../src/app/tool-lifecycle.js';
import { readResponseTextLimited as readCoreResponse } from '../src/core/bounded-response.js';
import { readResponseTextLimited as readCompatibleResponse } from '../src/bounded-response.js';
import { formatJsonText as formatFeatureJson } from '../src/features/developer-toolbox/core.js';
import { formatJsonText as formatCompatibleJson } from '../src/developer-toolbox-core.js';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { toolTopbarMarkup as sharedToolTopbarMarkup } from '../src/shared/tool-page-shell.js';
import { toolTopbarMarkup as compatibleToolTopbarMarkup } from '../src/tool-page-shell.js';

const [
  mainSource,
  platformSource,
  indexSource,
  selectCompatibilityStyles,
  selectComponentStyles,
  markdownEditorSource,
  developerToolboxSource,
  ...sharedShellConsumers
] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/platform/tauri-runtime.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/tool-custom-select.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/components/tool-custom-select.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/markdown-editor-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/developer-toolbox/tool.js', import.meta.url), 'utf8'),
  ...[
    'color-space-compare-ui.js',
    'crypto-tool-ui.js',
    'image-color-replace-ui.js',
    'markdown-editor-ui.js'
  ].map(file => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'))
]);

assert.equal(readCompatibleResponse, readCoreResponse, 'the legacy bounded-response path must re-export the core implementation');
assert.equal(formatCompatibleJson, formatFeatureJson, 'the legacy developer toolbox core path must re-export the feature implementation');
assert.equal(compatibleToolTopbarMarkup, sharedToolTopbarMarkup, 'the legacy tool shell path must re-export the shared implementation');
assert.doesNotMatch(mainSource, /from ['"]@tauri-apps\/api\/(?:core|event)['"]/, 'main.js must use the platform boundary');
assert.match(mainSource, /from ['"]\.\/platform\/tauri-runtime\.js['"]/, 'main.js must import the Tauri platform boundary');
assert.match(platformSource, /from ['"]@tauri-apps\/api\/core['"]/, 'the platform boundary must own the Tauri core import');
assert.match(platformSource, /from ['"]@tauri-apps\/api\/event['"]/, 'the platform boundary must own the Tauri event import');
assert.ok(sharedShellConsumers.every(source => source.includes("from './shared/tool-page-shell.js'")), 'migrated feature tools must consume the shared tool shell');
assert.match(developerToolboxSource, /from ['"]\.\.\/\.\.\/shared\/tool-page-shell\.js['"]/, 'the developer toolbox feature must consume the shared tool shell');
assert.match(indexSource, /href="\.\/src\/tool-custom-select\.css"/, 'the existing stylesheet position must remain stable');
assert.equal(selectCompatibilityStyles.trim(), "@import url('./styles/components/tool-custom-select.css');", 'the legacy stylesheet must forward to the component stylesheet');
assert.match(selectComponentStyles, /\.tool-custom-select-trigger\s*\{/, 'the component stylesheet must own custom select visuals');
assert.match(markdownEditorSource, /data-lucide="save"/, 'the Markdown draft state must use a registered Lucide icon');
assert.doesNotMatch(markdownEditorSource, /data-lucide="cloud-check"/, 'the removed Lucide cloud-check icon must not emit runtime warnings');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, reject, resolve };
}

class FakeTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type, event = {}) {
    const dispatched = { type, defaultPrevented: false, ...event };
    const originalPreventDefault = dispatched.preventDefault;
    dispatched.preventDefault = () => {
      dispatched.defaultPrevented = true;
      originalPreventDefault?.();
    };
    for (const listener of this.listeners.get(type) || []) listener(dispatched);
  }
}

validateLazyToolSpecs(LAZY_TOOL_SPECS);
assert.ok(Object.keys(LAZY_TOOL_SPECS).length > 0, 'the application must register at least one lazy tool');
assert.throws(() => validateLazyToolSpecs({ broken: { overlayId: 'x', init: 'init' } }), /load/);
assert.throws(() => validateLazyToolSpecs({
  one: { instanceKey: 'shared', overlayId: 'one', init: 'init', load() {} },
  two: { instanceKey: 'shared', overlayId: 'two', init: 'init', load() {} }
}), /same overlay and initializer/);

const disposalOrder = [];
const target = new FakeTarget();
const scope = createLifecycleScope();
scope.use(() => disposalOrder.push('first'));
scope.event(target, 'ping', () => disposalOrder.push('event'));
scope.use(() => disposalOrder.push('last'));
const token = scope.token();
target.dispatch('ping');
assert.deepEqual(disposalOrder, ['event']);
assert.equal(scope.isCurrent(token), true);
scope.invalidate();
assert.equal(scope.isCurrent(token), false);
scope.dispose();
scope.dispose();
assert.deepEqual(disposalOrder, ['event', 'last', 'first']);
assert.equal(target.listeners.get('ping').size, 0);

const released = [];
const releaseScope = createLifecycleScope();
const releaseEarly = releaseScope.use(() => released.push('released'));
releaseEarly();
releaseEarly();
releaseScope.dispose();
assert.deepEqual(released, ['released'], 'manual lifecycle release must unregister itself');

let normalizedClosed = 0;
let normalizedDestroyed = 0;
const normalized = normalizeToolInstance({
  open(value) { return value; },
  close() { normalizedClosed += 1; },
  destroy() { normalizedDestroyed += 1; }
}, 'normalized');
assert.equal(normalized.open('ready'), 'ready');
normalized.close();
normalized.dispose();
normalized.dispose();
assert.equal(normalizedClosed, 1);
assert.equal(normalizedDestroyed, 1);
assert.throws(() => normalized.open(), /disposed/);

const root = new FakeTarget();
root.defaultView = new FakeTarget();
root.getElementById = id => ({ id });
root.querySelectorAll = () => [];
const slowLoad = deferred();
const slowStarted = deferred();
const opened = [];
const closed = [];
const disposed = [];
const errors = [];
const makeModule = name => ({
  initTool({ overlay }) {
    return {
      open(toolId) { opened.push(`${name}:${toolId}:${overlay.id}`); },
      close() { closed.push(name); },
      dispose() { disposed.push(name); }
    };
  }
});
const specs = {
  slow: { overlayId: 'slow-overlay', init: 'initTool', load: () => { slowStarted.resolve(); return slowLoad.promise; } },
  fast: { overlayId: 'fast-overlay', init: 'initTool', load: async () => makeModule('fast') },
  sharedOne: { instanceKey: 'shared', overlayId: 'shared-overlay', init: 'initTool', load: async () => makeModule('shared') },
  sharedTwo: { instanceKey: 'shared', overlayId: 'shared-overlay', init: 'initTool', load: async () => makeModule('shared') }
};
const registry = createLazyToolRegistry({ specs, root, onError: error => errors.push(error) });
const slowOpen = registry.open('slow');
await slowStarted.promise;
assert.ok(await registry.open('fast'));
slowLoad.resolve(makeModule('slow'));
await slowOpen;
assert.deepEqual(opened, ['fast:fast:fast-overlay'], 'a stale lazy import must not open after a newer request');
assert.equal(registry.activeToolId, 'fast');
assert.ok(await registry.open('sharedOne'));
assert.ok(await registry.open('sharedTwo'));
assert.equal(registry.loadedInstanceCount, 3, 'tools with one instanceKey must initialize once');
assert.deepEqual(opened.slice(-2), ['shared:sharedOne:shared-overlay', 'shared:sharedTwo:shared-overlay']);
assert.equal(closed.filter(name => name === 'shared').length, 0, 'switching modes in one shared instance must not close it');
registry.bind();
const preventToolEscape = event => event.preventDefault();
root.addEventListener('keydown', preventToolEscape);
root.dispatch('keydown', { key: 'Escape' });
await Promise.resolve();
assert.equal(registry.activeToolId, 'sharedTwo', 'a tool-owned Escape action must not close the active tool');
root.removeEventListener('keydown', preventToolEscape);
root.dispatch('keydown', { key: 'Escape' });
await Promise.resolve();
assert.equal(registry.activeToolId, '');
await registry.dispose();
await registry.dispose();
assert.deepEqual(disposed.sort(), ['fast', 'shared', 'slow']);
assert.equal(root.listeners.get('keydown').size, 0);
assert.equal(errors.length, 0);
assert.equal(await registry.open('fast'), null, 'disposed registries must reject future opens');

const abandonedLoad = deferred();
const abandonedStarted = deferred();
let abandonedInitializerCalls = 0;
const abandonedRegistry = createLazyToolRegistry({
  specs: {
    abandoned: {
      overlayId: 'abandoned-overlay',
      init: 'initTool',
      load() {
        abandonedStarted.resolve();
        return abandonedLoad.promise;
      }
    }
  },
  root,
  onError: error => errors.push(error)
});
const abandonedOpen = abandonedRegistry.open('abandoned');
await abandonedStarted.promise;
await abandonedRegistry.dispose();
abandonedLoad.resolve({
  initTool() {
    abandonedInitializerCalls += 1;
    return { open() {} };
  }
});
assert.equal(await abandonedOpen, null);
assert.equal(abandonedInitializerCalls, 0, 'a disposed registry must not initialize a pending dynamic import');
assert.equal(abandonedRegistry.loadedInstanceCount, 0, 'a pending import must not leak an instance after disposal');

const closeStarted = deferred();
const allowClose = deferred();
const transitionOrder = [];
const transitionRegistry = createLazyToolRegistry({
  specs: {
    first: { overlayId: 'first-overlay', init: 'initTool', load: async () => ({
      initTool() {
        return {
          open() { transitionOrder.push('first:open'); },
          async close() {
            transitionOrder.push('first:close:start');
            closeStarted.resolve();
            await allowClose.promise;
            transitionOrder.push('first:close:end');
          }
        };
      }
    }) },
    second: { overlayId: 'second-overlay', init: 'initTool', load: async () => ({
      initTool() {
        return { open() { transitionOrder.push('second:open'); } };
      }
    }) }
  },
  root,
  onError: error => errors.push(error)
});
await transitionRegistry.open('first');
const secondOpen = transitionRegistry.open('second');
await closeStarted.promise;
assert.deepEqual(transitionOrder, ['first:open', 'first:close:start'], 'the next tool must wait for asynchronous close cleanup');
allowClose.resolve();
await secondOpen;
assert.deepEqual(transitionOrder, ['first:open', 'first:close:start', 'first:close:end', 'second:open']);
await transitionRegistry.dispose();
assert.equal(errors.length, 0);

console.log('V3 app architecture lifecycle and lazy registry checks passed');
