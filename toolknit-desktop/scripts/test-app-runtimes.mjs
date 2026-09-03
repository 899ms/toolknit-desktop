import assert from 'node:assert/strict';
import { createAiSettingsRuntime } from '../src/app/ai-settings-runtime.js';
import { createExternalLinksRuntime } from '../src/app/external-links-runtime.js';
import { createHomeExplorerRuntime } from '../src/app/home-explorer-runtime.js';
import { createFontSettingsRuntime } from '../src/app/font-settings-runtime.js';

class FakeElement extends EventTarget {
  constructor(id = '') {
    super();
    this.id = id;
    this.dataset = {};
    this.children = [];
    this.style = {};
    this.className = '';
    this.classList = {
      values: new Set(),
      add: (...names) => names.forEach(name => this.classList.values.add(name)),
      remove: (...names) => names.forEach(name => this.classList.values.delete(name)),
      toggle: (name, force) => {
        const next = force === undefined ? !this.classList.values.has(name) : Boolean(force);
        if (next) this.classList.values.add(name); else this.classList.values.delete(name);
        return next;
      },
      contains: name => this.classList.values.has(name)
    };
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focused = true; }
  closest(selector) {
    if (selector.includes('[data-remove-favorite]') && this.dataset.removeFavorite) return this;
    if (selector.includes('[data-home-tool]') && this.dataset.homeTool) return this;
    if (selector.includes('.favorite-item') && this.className.includes('favorite-item')) return this;
    if (selector.includes('.tool-result-card') && this.className.includes('tool-result-card')) return this;
    if (selector.includes('.audio-list-item') && this.className.includes('audio-list-item')) return this;
    return null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  scrollTo() {}
}

class FakeRoot extends FakeElement {
  constructor(elements = []) {
    super('root');
    this.elements = new Map(elements.filter(Boolean).map(element => [element.id, element]));
    this.baseURI = 'http://localhost/';
    this.defaultView = { requestAnimationFrame: callback => callback(), setTimeout, clearTimeout };
  }
  getElementById(id) { return this.elements.get(id) || null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const makeByIdRoot = ids => new FakeRoot(ids.map(id => new FakeElement(id)));

// Optional DOM nodes must not make a runtime fail during initialization.
const emptyRoot = new FakeRoot();
const emptyAi = createAiSettingsRuntime({ root: emptyRoot, storage: null, aiKeyStore: null });
emptyAi.dispose();
const emptyLinks = createExternalLinksRuntime({ root: emptyRoot, storage: null, windowRef: { open() {} } });
emptyLinks.dispose();
const emptyHome = createHomeExplorerRuntime({ root: emptyRoot, storage: null });
emptyHome.dispose();
const emptyFonts = createFontSettingsRuntime({ root: emptyRoot, windowRef: {}, normalizeDesktopBytes: value => value });
emptyFonts.dispose();

const blocked = [];
const opened = [];
const links = createExternalLinksRuntime({
  root: emptyRoot,
  windowRef: { open: (...args) => opened.push(args) },
  onError: error => blocked.push(error.message)
});
assert.equal(await links.openExternalUrl('file:///secret.txt'), false);
assert.equal(await links.openExternalUrl('javascript:alert(1)'), false);
assert.equal(await links.openExternalUrl('https://toolknit.com/docs'), true);
assert.equal(opened[0][0], 'https://toolknit.com/docs');
assert.equal(blocked.length, 2);
links.dispose();

const aiElements = [
  'settingsApiKey', 'apiKeyOverlay', 'apiKeyBack', 'apiKeyInput', 'apiKeyToggle',
  'apiKeySave', 'apiKeyClear', 'apiKeyStatus', 'apiKeyDropdown', 'apiKeyDropdownTrigger',
  'apiKeyDropdownMenu', 'apiKeyDropdownValue', 'apiKeyCustomWrap', 'apiKeyCustomUrl',
  'apiKeyCustomModel', 'apiKeyPrivateHttpSwitch', 'aiKeyRequiredOverlay',
  'aiKeyRequiredCancel', 'aiKeyRequiredGoSettings'
].map(id => new FakeElement(id));
const aiRoot = new FakeRoot(aiElements);
const aiStore = { hasKey: () => false, get: async () => '', set: async () => {}, remove: async () => {} };
const ai = createAiSettingsRuntime({ root: aiRoot, storage: null, aiKeyStore: aiStore });
assert.equal(await ai.openToolWithAiCheck(), false);
assert.equal(aiRoot.getElementById('aiKeyRequiredOverlay').classList.contains('visible'), true);
aiRoot.getElementById('aiKeyRequiredCancel').dispatchEvent(new Event('click'));
assert.equal(aiRoot.getElementById('aiKeyRequiredOverlay').classList.contains('visible'), false);
ai.dispose();

const home = createHomeExplorerRuntime({ root: emptyRoot, storage: null });
assert.doesNotThrow(() => home.renderFavorites());
assert.doesNotThrow(() => home.renderHomeTools({ resetPagination: true }));
home.dispose();

console.log('Application runtime module contracts passed');
