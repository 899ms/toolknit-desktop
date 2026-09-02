import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { createHardwareSnapshotController } from '../src/features/hardware-inspector/controller.js';
import { createHardwareRenderHelpers, escapeHardwareHtml } from '../src/features/hardware-inspector/core.js';
import {
  hardwareMainboardTemplate,
  hardwareNetworkDevicesTemplate,
  hardwareOverviewTemplate,
  hardwareStorageTemplate
} from '../src/features/hardware-inspector/templates.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const main = read('src/main.js');
const html = read('index.html');
const controller = read('src/features/hardware-inspector/controller.js');
const tool = read('src/features/hardware-inspector/tool.js');
const renderers = [
  read('src/features/hardware-inspector/overview.js'),
  read('src/features/hardware-inspector/mainboard.js'),
  read('src/features/hardware-inspector/storage.js'),
  read('src/features/hardware-inspector/network-devices.js')
].join('\n');

const specs = {
  'hardware-overview': ['hardwareOverviewOverlay', 'initHardwareOverviewTool'],
  'hardware-mainboard': ['hardwareMainboardOverlay', 'initHardwareMainboardTool'],
  'hardware-storage': ['hardwareStorageOverlay', 'initHardwareStorageTool'],
  'hardware-network-devices': ['hardwareNetworkDevicesOverlay', 'initHardwareNetworkDevicesTool']
};
for (const [toolId, [overlayId, initializer]] of Object.entries(specs)) {
  const spec = LAZY_TOOL_SPECS[toolId];
  assert.equal(spec?.overlayId, overlayId);
  assert.equal(spec?.init, initializer);
  assert.match(spec.load.toString(), /\.\/hardware-inspector\/tool\.js/);
  assert.match(html, new RegExp(`id="${overlayId}"[^>]*aria-hidden="true"[^>]*><\\/div>`));
}

for (const stale of [
  'get_hardware_overview', 'get_mainboard_firmware_info',
  'get_storage_health_info', 'get_network_devices_info',
  'hardwareOverviewContent', 'hardwareMainboardContent',
  'hardwareStorageContent', 'hardwareNetworkDevicesContent'
]) assert.doesNotMatch(main, new RegExp(stale));

const markup = [hardwareOverviewTemplate(), hardwareMainboardTemplate(), hardwareStorageTemplate(), hardwareNetworkDevicesTemplate()].join('');
for (const id of [
  'hardwareOverviewRefresh', 'hardwareOverviewContent',
  'hardwareMainboardRefresh', 'hardwareMainboardContent',
  'hardwareStorageRefresh', 'hardwareStorageContent',
  'hardwareNetworkDevicesRefresh', 'hardwareNetworkDevicesContent'
]) assert.match(markup, new RegExp(`id="${id}"`));

assert.match(controller, /isCurrent\(operation\)/);
assert.match(controller, /revision \+= 1/);
assert.match(controller, /lifecycle\.use\(onLangChange/);
assert.match(controller, /viewState = 'desktop-only'/);
assert.match(controller, /viewState = 'error'/);
assert.match(controller, /renderCurrentState\(\)/);
assert.match(controller, /content\.replaceChildren\(wrapper\)/);
assert.doesNotMatch(controller, /from ['"]@tauri-apps\//);
assert.match(tool, /controller\.close\(\)/);
assert.match(tool, /controller\.dispose\(\)/);
assert.match(tool, /disposeStandardToolPlasma\(plasma\)/);
assert.match(renderers, /escapeHtml/);

assert.equal(escapeHardwareHtml('<img src=x onerror="bad">'), '&lt;img src=x onerror=&quot;bad&quot;&gt;');
const helpers = createHardwareRenderHelpers({
  t: key => key.endsWith('unavailable') ? 'N/A' : key,
  getLang: () => 'en'
});
assert.equal(helpers.hardwareReadableText('System Manufacturer', 'N/A'), 'N/A');
assert.equal(helpers.hardwareReadableText('  Real   Device  ', 'N/A'), 'Real Device');
assert.match(helpers.hardwareOverviewSection('<title>', ['<field>']), /&lt;title&gt;/);

class FakeNode extends EventTarget {
  constructor() {
    super();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.classList = {
      add: () => {},
      remove: () => {}
    };
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

const originalDocument = globalThis.document;
globalThis.document = { createElement: () => new FakeNode() };
try {
  const refresh = new FakeNode();
  const updatedAt = new FakeNode();
  const content = new FakeNode();
  const nodes = new Map([
    ['#hardwareTestRefresh', refresh],
    ['#hardwareTestUpdatedAt', updatedAt],
    ['#hardwareTestContent', content]
  ]);
  const overlay = { querySelector: selector => nodes.get(selector) || null };
  let lang = 'zh';
  let languageListener = null;
  const labels = {
    zh: { scanning: '扫描中', desktopOnlyTitle: '仅支持桌面端', desktopOnlyDesc: '请使用桌面版' },
    en: { scanning: 'Scanning', desktopOnlyTitle: 'Desktop only', desktopOnlyDesc: 'Use the desktop app' }
  };
  const snapshot = createHardwareSnapshotController({
    overlay,
    definition: {
      prefix: 'hardwareTest',
      command: 'unused_in_browser_test',
      text: key => labels[lang][key] || key,
      render: () => {},
      updatedAt: () => ''
    },
    isTauri: false,
    onLangChange: callback => {
      languageListener = callback;
      return () => { languageListener = null; };
    }
  });
  snapshot.open();
  await Promise.resolve();
  assert.equal(content.children[0].children[0].textContent, '仅支持桌面端');
  assert.equal(content.children[0].children[1].textContent, '请使用桌面版');
  lang = 'en';
  languageListener();
  assert.equal(content.children[0].children[0].textContent, 'Desktop only');
  assert.equal(content.children[0].children[1].textContent, 'Use the desktop app');
  snapshot.dispose();
  assert.equal(languageListener, null);
} finally {
  globalThis.document = originalDocument;
}

console.log('Hardware inspector lazy family and lifecycle contract checks passed.');
