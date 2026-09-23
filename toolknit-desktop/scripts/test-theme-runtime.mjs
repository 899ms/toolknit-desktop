import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createThemeRuntime, normalizeTheme, readThemePreference, THEME_STORAGE_KEY } from '../src/app/theme-runtime.js';
import { createBackgroundRuntime } from '../src/app/background-runtime.js';
import { createCustomBackgroundSettingsRuntime } from '../src/app/custom-background-settings-runtime.js';
import { initializeDefaultBackground, DEFAULT_DARK_BACKGROUND, DEFAULT_DARK_BACKGROUND_SRC, BACKGROUND_DEFAULT_INITIALIZED_KEY } from '../src/app/custom-background-default.js';

class Element extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map();
    this.dataset = {};
    this.classes = new Set();
    this.classList = {
      contains: name => this.classes.has(name),
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name)
    };
    this.children = [];
    this.isConnected = true;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.children.push(child); child.parentElement = this; }
  insertBefore(child) { this.appendChild(child); }
  remove() {
    this.isConnected = false;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
  }
  focus() { this.focused = true; }
}

function fixture(preference, pageTransition = null) {
  const values = new Map(preference === undefined ? [] : [[THEME_STORAGE_KEY, preference]]);
  const windowRef = new EventTarget();
  windowRef.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const buttons = ['dark', 'light'].map(theme => Object.assign(new Element(), { dataset: { themeChoice: theme } }));
  const root = { documentElement: new Element(), querySelectorAll: () => buttons };
  const theme = createThemeRuntime({ root, windowRef, pageTransition });
  return { theme, root, windowRef, values, buttons };
}

for (const input of [undefined, null, '', 'system', '<script>', 'LIGHT']) assert.equal(normalizeTheme(input), 'light');
assert.equal(normalizeTheme('light'), 'light');
assert.equal(normalizeTheme('dark'), 'dark');
assert.equal(readThemePreference({ get localStorage() { throw new Error('unavailable'); } }), 'light');
const firstLaunch = fixture();
assert.equal(firstLaunch.theme.get(), 'light');
assert.equal(firstLaunch.buttons[1].attributes.get('aria-checked'), 'true');
firstLaunch.theme.dispose();
const state = fixture('dark');
assert.equal(state.theme.get(), 'dark');
assert.equal(state.buttons[0].attributes.get('aria-checked'), 'true');
const changes = [];
const unsubscribe = state.theme.subscribe(value => changes.push(value));
state.buttons[1].dispatchEvent(new Event('click'));
assert.equal(state.values.get(THEME_STORAGE_KEY), 'light');
assert.equal(state.theme.allowsCustomBackground(), false);
assert.equal(state.root.documentElement.attributes.get('data-theme'), 'light');
assert.equal(state.buttons[1].tabIndex, 0);
assert.equal(state.buttons[0].tabIndex, -1);
assert.deepEqual(changes, ['light']);
state.theme.set('light');
state.theme.set('invalid');
assert.deepEqual(changes, ['light']);
const arrow = new Event('keydown', { cancelable: true });
Object.defineProperty(arrow, 'key', { value: 'ArrowUp' });
state.buttons[1].dispatchEvent(arrow);
assert.equal(arrow.defaultPrevented, true);
assert.equal(state.theme.get(), 'dark');
assert.equal(state.buttons[0].focused, true);
state.values.set(THEME_STORAGE_KEY, 'light');
state.windowRef.dispatchEvent(Object.assign(new Event('storage'), { key: THEME_STORAGE_KEY }));
assert.equal(state.theme.get(), 'light');
unsubscribe();
const count = changes.length;
state.theme.set('dark');
assert.equal(changes.length, count);
state.theme.dispose();
state.theme.dispose();
state.buttons[1].dispatchEvent(new Event('click'));
assert.equal(state.theme.get(), 'dark');
const unavailable = fixture();
Object.defineProperty(unavailable.windowRef, 'localStorage', { get() { throw new Error('unavailable'); } });
unavailable.theme.set('light');
assert.equal(unavailable.theme.get(), 'light', 'storage failure must not break this session');
unavailable.theme.dispose();

let transitionRuns = 0;
const transitioned = fixture('dark', {
  run(action) {
    transitionRuns += 1;
    return Promise.resolve().then(action);
  }
});
transitioned.theme.set('light');
assert.equal(transitioned.root.documentElement.attributes.get('data-theme'), 'dark', 'theme paint waits for the shared transition veil');
await Promise.resolve();
assert.equal(transitioned.root.documentElement.attributes.get('data-theme'), 'light');
assert.equal(transitionRuns, 1);
transitioned.theme.dispose();

const queued = [];
const rapid = fixture('light', { run(action, options) {
  assert.equal(options.replaceable, false);
  return new Promise(resolve => queued.push(() => resolve(action())));
} });
rapid.theme.set('dark');
rapid.theme.set('light');
queued.shift()(); await Promise.resolve();
assert.equal(rapid.theme.get(), 'light', 'returning to the current theme invalidates the queued change');
assert.equal(rapid.values.get(THEME_STORAGE_KEY), 'light');
rapid.theme.set('dark');
rapid.theme.dispose();
queued.shift()(); await Promise.resolve();
assert.equal(rapid.theme.get(), 'light', 'disposal blocks pending paint and persistence');
assert.equal(rapid.values.get(THEME_STORAGE_KEY), 'light');

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const bootstrap = html.match(/<script data-tk-theme-bootstrap>([\s\S]*?)<\/script>/)[1];
assert.ok(html.indexOf('data-tk-theme-bootstrap') < html.indexOf('rel="stylesheet"'));
assert.ok(bootstrap.includes(THEME_STORAGE_KEY));
for (const [saved, expected, search] of [['light', 'light', ''], ['dark', 'dark', ''], ['bad', 'light', ''], ['light', undefined, '?screen-picker=1']]) {
  const document = { documentElement: { dataset: {} } };
  vm.runInNewContext(bootstrap, { document, window: { location: { search }, setTimeout: () => 1 }, localStorage: { getItem: () => saved }, URLSearchParams });
  assert.equal(document.documentElement.dataset.theme, expected);
}
const template = await readFile(new URL('../src/app/templates/settings.html', import.meta.url), 'utf8');
const themeIndex = await readFile(new URL('../src/styles/themes/index.css', import.meta.url), 'utf8');
const secondaryTheme = await readFile(new URL('../src/styles/themes/secondary-pages-light.css', import.meta.url), 'utf8');
assert.match(themeIndex, /@import url\('\.\/secondary-pages-light\.css'\)/);
assert.match(secondaryTheme, /html\[data-theme="light"\] :is\(\.feedback-overlay, \.donation-overlay, \.api-key-overlay\)/);
assert.doesNotMatch(secondaryTheme, /!important|z-index\s*:/, 'secondary page colors do not override modal ownership');
assert.doesNotMatch(secondaryTheme, /aiKeyRequiredOverlay|transcription-model-overlay|update-preview-overlay/, 'stage three and update dialogs keep their own palette');
const dependencyTheme = await readFile(new URL('../src/styles/themes/dependency-dialogs-light.css', import.meta.url), 'utf8');
assert.match(themeIndex, /@import url\('\.\/dependency-dialogs-light\.css'\)/);
for (const id of ['transcriptionModelOverlay', 'mattingModelOverlay', 'ffmpegRuntimeOverlay', 'libreOfficeRuntimeOverlay', 'dependencyGateOverlay', 'aiKeyRequiredOverlay']) assert.ok(dependencyTheme.includes(`#${id}`));
assert.doesNotMatch(dependencyTheme, /!important|z-index\s*:|force-update|cleanup-drive|update-preview/, 'light dependency dialogs preserve stack and unrelated surfaces');
assert.match(dependencyTheme, /button:focus-visible/);
assert.match(dependencyTheme, /button:disabled/);
assert.match(dependencyTheme, /-webkit-backdrop-filter: blur\(12px\);\s*backdrop-filter: blur\(12px\);/, 'standard backdrop declaration must follow the prefix so CSS minification preserves it');
assert.match(dependencyTheme, /#mattingModelOverlay[\s\S]*transition: none[\s\S]*background: rgba\(17, 17, 17, 0\.22\)/, 'matting light overlay skips the legacy dark transition');
assert.doesNotMatch(dependencyTheme, /html\[data-theme="light"\] #mattingModelOverlay\s*\{[^}]*opacity:\s*1/, 'hidden light matting overlay must not be forced visible');
assert.match(secondaryTheme, /\.api-key-overlay \.api-key-content[\s\S]*justify-content: center/, 'light AI key content is centered');
const applicationRuntime = await readFile(new URL('../src/application-runtime.js', import.meta.url), 'utf8');
assert.match(applicationRuntime, /mattingManagerOpenRequest/, 'matting manager invalidates delayed opens');
assert.match(applicationRuntime, /nested dialog[\s\S]*close\/reopen race/, 'matting manager avoids a nested page-transition race');
assert.equal((template.match(/data-theme-choice=/g) || []).length, 2);
assert.match(template, /data-background-controls/);
assert.doesNotMatch(template, /settings\.(posterNote|customBackgroundHint)|ADVANCED DARK/);
for (const language of ['zh', 'en']) {
  const locale = JSON.parse(await readFile(new URL(`../src/locales/${language}.json`, import.meta.url)));
  for (const key of ['languageAndTheme', 'theme', 'themeDark', 'themeLight', 'themeWallpaperHint']) assert.ok(locale.settings[key]);
}

// Resolve an old native wallpaper request after two theme switches. It must
// neither mount media nor poison the current request's source cache.
const bgState = fixture('dark');
const wallpaperKey = 'toolknit.customBackground.v1';
const metadata = JSON.stringify({ type: 'image', path: 'fixture.png' });
bgState.values.set(wallpaperKey, metadata);
const documentRef = new EventTarget();
const home = new Element();
home.classList.add('is-v2-home');
documentRef.querySelector = () => home;
documentRef.createElement = () => new Element();
const pending = [];
const background = createBackgroundRuntime({
  documentRef, windowRef: bgState.windowRef, isTauri: true,
  tauriCorePromise: Promise.resolve({ invoke: () => new Promise(resolve => pending.push(resolve)) }),
  allowCustomBackground: bgState.theme.allowsCustomBackground,
  onThemeChange: bgState.theme.subscribe
});
const tick = () => new Promise(resolve => setImmediate(resolve));
background.syncHome();
await tick();
assert.equal(pending.length, 1);
bgState.theme.set('light');
assert.equal(background.getConfig().path, 'fixture.png', 'saved wallpaper is not deleted or rewritten');
bgState.theme.set('dark');
await tick();
assert.equal(pending.length, 2);
pending[0]('data:image/png;base64,old');
await tick();
assert.equal(home.children[0].children.length, 0, 'outdated native result is discarded');
pending[1]('data:image/png;base64,current');
await tick();
assert.equal(home.children[0].children.length, 1);
let homeReady = false;
const homeReadiness = background.whenHomeReady().then(() => { homeReady = true; });
await tick();
assert.equal(homeReady, false, 'startup must await the wallpaper media, not just its native URL');
home.children[0].children[0].dispatchEvent(new Event('load'));
await homeReadiness;
assert.equal(homeReady, true);
bgState.theme.set('light');
assert.equal(home.children[0].children.length, 0, 'switching white releases the live wallpaper');
assert.equal(bgState.values.get(wallpaperKey), metadata);
background.refresh();
background.resume();
await tick();
assert.equal(pending.length, 2, 'white mode cannot resolve more wallpaper URLs');
const toolHost = new Element();
const closeTool = background.mountTool(toolHost);
await tick();
assert.equal(pending.length, 2, 'opening a dark tool in white mode cannot load custom wallpaper');
bgState.theme.set('dark');
await tick();
assert.equal(pending.length, 3);
pending[2]('data:image/png;base64,tool');
await tick();
assert.equal(toolHost.children.length, 1);
toolHost.children[0].dispatchEvent(new Event('load'));
await tick();
assert.equal(toolHost.classList.contains('has-custom-background'), true);
bgState.theme.set('light');
assert.equal(toolHost.children.length, 0, 'white mode releases wallpaper from an open tool too');
assert.equal(toolHost.classList.contains('has-custom-background'), false);
closeTool();
closeTool();
background.dispose();
background.dispose();
bgState.theme.dispose();

// Settings preview uses the same policy, including native replies arriving late.
const settingsState = fixture('dark');
settingsState.values.set(wallpaperKey, metadata);
const nodes = new Map(['settingsBackgroundPreview', 'settingsBackgroundSummary',
  'chooseBackgroundImage', 'chooseBackgroundVideo', 'clearCustomBackground',
  'customBackgroundImageInput', 'customBackgroundVideoInput'].map(id => [id, new Element()]));
const preview = nodes.get('settingsBackgroundPreview');
const card = new Element();
const controls = new Element();
controls.contains = () => false;
card.querySelector = () => controls;
preview.closest = () => card;
preview.querySelectorAll = () => [...preview.children];
preview.querySelector = () => null;
const settingsRoot = new EventTarget();
settingsRoot.getElementById = id => nodes.get(id);
settingsRoot.createElement = () => new Element();
settingsRoot.querySelector = () => settingsState.buttons[1];
const requests = [];
const commands = [];
const settingsRuntime = createCustomBackgroundSettingsRuntime({
  root: settingsRoot, windowRef: settingsState.windowRef, isTauri: true,
  tauriCorePromise: Promise.resolve({ invoke: command => {
    commands.push(command);
    return new Promise(resolve => requests.push(resolve));
  } }),
  allowCustomBackground: settingsState.theme.allowsCustomBackground,
  onThemeChange: settingsState.theme.subscribe
});
await tick();
assert.equal(requests.length, 1);
settingsState.theme.set('light');
assert.equal(controls.inert, true);
assert.equal(nodes.get('chooseBackgroundImage').disabled, true);
requests[0]('data:image/png;base64,stale-preview');
await tick();
assert.equal(preview.children.length, 0);
await settingsRuntime.clear();
nodes.get('chooseBackgroundImage').dispatchEvent(new Event('click'));
await settingsRuntime.refresh();
assert.deepEqual(commands, ['get_custom_background_media_url'], 'white mode blocks preview, picker and clear operations');
assert.equal(settingsState.values.get(wallpaperKey), metadata);
settingsState.theme.set('dark');
await tick();
assert.equal(requests.length, 2);
requests[1]('data:image/png;base64,current-preview');
await tick();
assert.equal(preview.children.length, 1);
assert.equal(controls.inert, false);
settingsRuntime.dispose();
settingsRuntime.dispose();
assert.equal(preview.children.length, 0);
settingsState.theme.set('light');
settingsState.theme.set('dark');
await tick();
assert.equal(requests.length, 2, 'disposal removes the theme subscription');
settingsState.theme.dispose();

// A new profile stays light, but its first dark session has the bundled image.
const fresh = fixture();
const freshHome = new Element();
freshHome.classList.add('is-v2-home');
const freshDocument = new EventTarget();
freshDocument.querySelector = () => freshHome;
freshDocument.createElement = () => new Element();
const freshBackground = createBackgroundRuntime({
  windowRef: fresh.windowRef, documentRef: freshDocument, isTauri: true,
  tauriCorePromise: Promise.resolve({ invoke: () => assert.fail('bundled image must not need a native media server') }),
  allowCustomBackground: fresh.theme.allowsCustomBackground,
  onThemeChange: fresh.theme.subscribe
});
assert.deepEqual(JSON.parse(fresh.values.get(wallpaperKey)), DEFAULT_DARK_BACKGROUND);
assert.equal(fresh.theme.get(), 'light');
freshBackground.syncHome();
await tick();
assert.equal(freshHome.children.length, 0);
fresh.theme.set('dark');
await tick();
assert.equal(freshHome.children[0].children[0].src, DEFAULT_DARK_BACKGROUND_SRC);
freshHome.children[0].children[0].dispatchEvent(new Event('load'));
await tick();
assert.equal(freshHome.classList.contains('has-custom-background'), true);
fresh.theme.set('light');
assert.equal(freshHome.children[0].children.length, 0);
freshBackground.dispose();
fresh.theme.dispose();

for (const preference of ['dark', 'light']) {
  const existing = fixture(preference);
  initializeDefaultBackground(existing.windowRef);
  assert.equal(existing.values.has(wallpaperKey), false, 'existing plain backgrounds stay unchanged');
  assert.equal(existing.values.get(BACKGROUND_DEFAULT_INITIALIZED_KEY), '1');
  existing.theme.dispose();
}
for (const saved of [metadata, JSON.stringify({ type: 'video', src: 'data:video/mp4;base64,fixture' }), 'null', 'invalid']) {
  const existing = fixture();
  existing.values.set(wallpaperKey, saved);
  initializeDefaultBackground(existing.windowRef);
  assert.equal(existing.values.get(wallpaperKey), saved, 'never rewrite existing wallpaper preferences');
  existing.theme.dispose();
}
fresh.values.delete(wallpaperKey);
fresh.values.delete(THEME_STORAGE_KEY);
initializeDefaultBackground(fresh.windowRef);
assert.equal(fresh.values.has(wallpaperKey), false, 'clearing persists even without a saved theme');
assert.doesNotThrow(() => initializeDefaultBackground({ get localStorage() { throw new Error('blocked'); } }));

// Permit only the bundled relative asset, not arbitrary paths or remote images.
for (const src of ['/assets/backgrounds/other.jpg', '//example.com/image.jpg', 'https://example.com/image.jpg', 'file:///C:/image.jpg']) {
  const rejected = fixture('dark');
  rejected.values.set(wallpaperKey, JSON.stringify({ type: 'image', src }));
  const rejectedHome = new Element();
  rejectedHome.classList.add('is-v2-home');
  const rejectedDocument = new EventTarget();
  rejectedDocument.querySelector = () => rejectedHome;
  rejectedDocument.createElement = () => new Element();
  const runtime = createBackgroundRuntime({ documentRef: rejectedDocument, windowRef: rejected.windowRef });
  runtime.syncHome();
  await tick();
  assert.equal(rejectedHome.children[0].children.length, 0, `blocked source: ${src}`);
  runtime.dispose();
  rejected.theme.dispose();
}
console.log('Theme state, keyboard, persistence, bootstrap, i18n, tool wallpaper and stale settings preview checks passed');
