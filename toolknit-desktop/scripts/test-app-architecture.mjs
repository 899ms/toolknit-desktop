import { readGlobalStyles } from './lib/global-styles.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLazyToolRegistry, validateLazyToolSpecs } from '../src/app/lazy-tool-registry.js';
import { createLifecycleScope, normalizeToolInstance } from '../src/app/tool-lifecycle.js';
import { readResponseTextLimited as readCoreResponse } from '../src/core/bounded-response.js';
import { readResponseTextLimited as readCompatibleResponse } from '../src/bounded-response.js';
import { formatJsonText as formatFeatureJson } from '../src/features/developer-toolbox/core.js';
import { formatJsonText as formatCompatibleJson } from '../src/developer-toolbox-core.js';
import { rgbToHex as featureRgbToHex } from '../src/features/color-space-compare/core.js';
import { rgbToHex as compatibleRgbToHex } from '../src/color-space-compare-core.js';
import { preserveColorSpaceValues as featurePreserveColorSpaceValues } from '../src/features/color-space-compare/controls.js';
import { preserveColorSpaceValues as compatiblePreserveColorSpaceValues } from '../src/color-space-compare-controls.js';
import { selectInstalledModels as featureSelectInstalledModels } from '../src/features/bg-removal/core.js';
import { selectInstalledModels as compatibleSelectInstalledModels } from '../src/bg-removal-core.js';
import { rgbToHex as featureImageColorRgbToHex } from '../src/features/image-color-replace/core.js';
import { rgbToHex as compatibleImageColorRgbToHex } from '../src/image-color-replace-core.js';
import { applyMarkdownAction as featureMarkdownAction } from '../src/features/markdown-editor/core.js';
import { applyMarkdownAction as compatibleMarkdownAction } from '../src/markdown-editor-core.js';
import { encodeIco as featureEncodeIco } from '../src/features/icon-generator/core.js';
import { encodeIco as compatibleEncodeIco } from '../src/icon-gen-core.js';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { toolTopbarMarkup as sharedToolTopbarMarkup } from '../src/shared/tool-page-shell.js';
import { toolTopbarMarkup as compatibleToolTopbarMarkup } from '../src/tool-page-shell.js';

const [
  mainSource,
  platformSource,
  indexSource,
  selectCompatibilityStyles,
  selectComponentStyles,
  markdownCompatibilitySource,
  markdownToolSource,
  markdownControllerSource,
  markdownTemplateSource,
  markdownPreviewSecuritySource,
  markdownFeatureStyles,
  developerToolboxSource,
  colorSpaceToolSource,
  bgRemovalToolSource,
  bgRemovalTemplateSource,
  colorSpaceCompatibilitySource,
  colorSpaceCompatibilityStyles,
  bgRemovalCompatibilitySource,
  bgRemovalCompatibilityStyles,
  imageColorReplaceToolSource,
  imageColorReplaceControllerSource,
  imageColorReplaceTemplateSource,
  imageColorReplaceWorkerSource,
  imageColorReplaceCompatibilitySource,
  imageColorReplaceFeatureStyles,
  imageBatchToolSource,
  imageBatchControllerSource,
  imageBatchTemplateSource,
  imageBatchFeatureStyles,
  iconGeneratorToolSource,
  iconGeneratorControllerSource,
  iconGeneratorTemplateSource,
  iconGeneratorGeneratorSource,
  iconGeneratorPublisherSource,
  iconGeneratorFeatureStyles,
  excelToPdfToolSource,
  excelToPdfControllerSource,
  excelToPdfTemplateSource,
  excelToPdfCompatibilitySource,
  excelToPdfCompatibilityStyles,
  excelToPdfFeatureStyles,
  cryptoControllerSource,
  cryptoToolSource,
  cryptoFeatureStyles,
  cryptoCompatibilitySource,
  appStyles,
  finalToolStyles,
  ...sharedShellConsumers
] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/platform/tauri-runtime.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/tool-custom-select.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/components/tool-custom-select.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/markdown-editor-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/markdown-editor/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/markdown-editor/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/markdown-editor/template.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/markdown-editor/preview-security.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/markdown-editor/markdown-editor.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/developer-toolbox/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/color-space-compare/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/bg-removal/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/bg-removal/template.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/color-space-compare-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/color-space-compare.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/bg-removal-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/bg-removal.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/image-color-replace/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/image-color-replace/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/image-color-replace/template.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/image-color-replace/worker.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/image-color-replace-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/image-color-replace/image-color-replace.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/image-batch/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/image-batch/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/image-batch/template.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/image-batch/image-batch.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/icon-generator/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/icon-generator/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/icon-generator/template.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/icon-generator/generator.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/icon-generator/publisher.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/icon-generator/icon-generator.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/excel-to-pdf/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/excel-to-pdf/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/excel-to-pdf/template.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/excel-to-pdf-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/excel-to-pdf.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/excel-to-pdf/excel-to-pdf.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crypto/controller.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crypto/tool.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crypto/crypto.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/crypto-tool-ui.js', import.meta.url), 'utf8'),
  readGlobalStyles(import.meta.url),
  readFile(new URL('../src/tool-page-v2-final.css', import.meta.url), 'utf8'),
  ...[]
]);

assert.equal(readCompatibleResponse, readCoreResponse, 'the legacy bounded-response path must re-export the core implementation');
assert.equal(formatCompatibleJson, formatFeatureJson, 'the legacy developer toolbox core path must re-export the feature implementation');
assert.equal(compatibleRgbToHex, featureRgbToHex, 'the legacy color-space core path must re-export the feature implementation');
assert.equal(compatiblePreserveColorSpaceValues, featurePreserveColorSpaceValues, 'the legacy color-space controls path must re-export the feature implementation');
assert.equal(compatibleSelectInstalledModels, featureSelectInstalledModels, 'the legacy background-removal core path must re-export the feature implementation');
assert.equal(compatibleImageColorRgbToHex, featureImageColorRgbToHex, 'the legacy image-color-replace core path must re-export the feature implementation');
assert.equal(compatibleMarkdownAction, featureMarkdownAction, 'the legacy Markdown core path must re-export the feature implementation');
assert.equal(compatibleEncodeIco, featureEncodeIco, 'the legacy icon generator core path must re-export the feature implementation');
assert.equal(compatibleToolTopbarMarkup, sharedToolTopbarMarkup, 'the legacy tool shell path must re-export the shared implementation');
assert.match(cryptoControllerSource, /from ['"]\.\.\/\.\.\/shared\/tool-page-shell\.js['"]/, 'crypto must consume the shared tool shell');
assert.match(cryptoControllerSource, /from ['"]\.\.\/\.\.\/platform\/tauri-runtime\.js['"]/, 'crypto must consume the platform boundary');
assert.doesNotMatch(cryptoControllerSource, /from ['"]@tauri-apps\//, 'crypto must not bypass the platform boundary');
assert.match(cryptoToolSource, /from ['"]\.\/controller\.js['"]/, 'crypto tool must delegate behavior to its controller');
assert.match(cryptoToolSource, /import ['"]\.\/crypto\.css['"]/, 'crypto tool must own its lazy stylesheet');
assert.match(cryptoCompatibilitySource, /from ['"]\.\/features\/crypto\/tool\.js['"]/, 'legacy crypto UI path must forward to the feature entry');
assert.match(cryptoFeatureStyles, /data-crypto-panel/, 'crypto feature stylesheet must own dynamic panel state');
assert.doesNotMatch(mainSource, /from ['"]@tauri-apps\/api\/(?:core|event)['"]/, 'main.js must use the platform boundary');
assert.match(mainSource, /from ['"]\.\/platform\/tauri-runtime\.js['"]/, 'main.js must import the Tauri platform boundary');
assert.match(platformSource, /from ['"]@tauri-apps\/api\/core['"]/, 'the platform boundary must own the Tauri core import');
assert.match(platformSource, /from ['"]@tauri-apps\/api\/event['"]/, 'the platform boundary must own the Tauri event import');
assert.ok(sharedShellConsumers.every(source => source.includes("from './shared/tool-page-shell.js'")), 'migrated feature tools must consume the shared tool shell');
assert.match(developerToolboxSource, /from ['"]\.\.\/\.\.\/shared\/tool-page-shell\.js['"]/, 'the developer toolbox feature must consume the shared tool shell');
assert.match(colorSpaceToolSource, /from ['"]\.\.\/\.\.\/shared\/tool-page-shell\.js['"]/, 'the color space compare feature must consume the shared tool shell');
assert.match(colorSpaceCompatibilitySource, /from ['"]\.\/features\/color-space-compare\/tool\.js['"]/, 'the legacy color space tool path must forward to the feature entry');
assert.equal(colorSpaceCompatibilityStyles.trim(), "@import url('./features/color-space-compare/color-space-compare.css');", 'the legacy color space stylesheet must forward to the feature stylesheet');
assert.match(bgRemovalToolSource, /from ['"]\.\/template\.js['"]/, 'the background-removal tool must delegate markup to its feature template');
assert.match(bgRemovalTemplateSource, /data-bgr-action="process"/, 'the background-removal template must retain the process action contract');
assert.match(bgRemovalCompatibilitySource, /from ['"]\.\/features\/bg-removal\/tool\.js['"]/, 'the legacy background-removal tool path must forward to the feature entry');
assert.equal(bgRemovalCompatibilityStyles.trim(), "@import url('./features/bg-removal/bg-removal.css');", 'the legacy background-removal stylesheet must forward to the feature stylesheet');
assert.match(imageColorReplaceToolSource, /from ['"]\.\.\/\.\.\/shared\/tool-page-shell\.js['"]/, 'the image color replacement feature must consume the shared tool shell');
assert.match(imageColorReplaceToolSource, /from ['"]\.\/template\.js['"]/, 'the image color replacement tool must delegate markup to its feature template');
assert.match(imageColorReplaceToolSource, /from ['"]\.\/controller\.js['"]/, 'the image color replacement tool must delegate runtime behavior to its controller');
assert.match(imageColorReplaceToolSource, /import ['"]\.\/image-color-replace\.css['"]/, 'the image color replacement feature must own its lazy stylesheet');
assert.match(imageColorReplaceControllerSource, /createLifecycleScope\(\)/, 'the image color replacement controller must own permanent listener cleanup');
assert.match(imageColorReplaceControllerSource, /from ['"]\.\.\/\.\.\/platform\/tauri-runtime\.js['"]/, 'the image color replacement controller must use the platform boundary');
assert.doesNotMatch(imageColorReplaceControllerSource, /from ['"]@tauri-apps\/api\/core['"]/, 'the image color replacement controller must not bypass the platform boundary');
assert.match(imageColorReplaceTemplateSource, /data-cr-export/, 'the image color replacement template must retain the export action contract');
assert.match(imageColorReplaceWorkerSource, /from ['"]\.\/core\.js['"]/, 'the image color replacement Worker must consume the feature core');
assert.match(imageColorReplaceCompatibilitySource, /from ['"]\.\/features\/image-color-replace\/tool\.js['"]/, 'the legacy image color replacement UI path must forward to the feature entry');
assert.match(imageColorReplaceFeatureStyles, /\.color-replace-stage-section\s*\{/, 'the feature stylesheet must own image color replacement layout');
assert.doesNotMatch(appStyles + finalToolStyles, /(?:\.color-replace|\.color-pair|\.color-swatch|\.color-target-picker)/, 'shared stylesheets must not retain image color replacement selectors');
assert.match(imageBatchToolSource, /from ['"]\.\/template\.js['"]/, 'the image batch tools must delegate markup to their feature template');
assert.match(imageBatchToolSource, /from ['"]\.\/controller\.js['"]/, 'the image batch tools must delegate runtime behavior to their controller');
assert.match(imageBatchToolSource, /import ['"]\.\/image-batch\.css['"]/, 'the image batch tools must own their lazy stylesheet');
assert.match(imageBatchControllerSource, /createLifecycleScope\(\)/, 'the image batch controller must own permanent and open-session cleanup');
assert.match(imageBatchControllerSource, /owner\.use\(unlisten\)/, 'the image batch controller must release native drag listeners with the owning session');
assert.match(imageBatchControllerSource, /isCurrentOperation\(operation\)/, 'image batch operations must reject stale results');
assert.match(imageBatchControllerSource, /name\.textContent =/, 'image batch runtime filenames must use safe text nodes');
assert.doesNotMatch(imageBatchControllerSource, /\.innerHTML\s*=/, 'image batch runtime values must not be written through innerHTML');
assert.match(imageBatchTemplateSource, /imageBatchPortalTemplate/, 'image batch modal markup must load with the feature');
assert.match(imageBatchFeatureStyles, /\.image-convert-v2/, 'the feature stylesheet must own image conversion layout');
assert.doesNotMatch(appStyles + finalToolStyles, /\.image-(?:convert|compress)-v2|#image(?:Convert|Compress)SuccessOverlay/, 'shared stylesheets must not retain migrated image batch selectors');
assert.match(iconGeneratorToolSource, /from ['"]\.\/template\.js['"]/, 'the icon generator must delegate markup to its feature template');
assert.match(iconGeneratorToolSource, /from ['"]\.\/controller\.js['"]/, 'the icon generator must delegate runtime behavior to its controller');
assert.match(iconGeneratorToolSource, /import ['"]\.\/icon-generator\.css['"]/, 'the icon generator must own its lazy stylesheet');
assert.match(iconGeneratorControllerSource, /createLifecycleScope\(\)/, 'the icon generator must own permanent and open-session cleanup');
assert.match(iconGeneratorControllerSource, /owner\.use\(unlisten\)/, 'the icon generator must release native drag listeners with the owning session');
assert.match(iconGeneratorControllerSource, /isCurrentSourceRequest\(request\)/, 'icon source decoding must reject stale sessions');
assert.match(iconGeneratorControllerSource, /isCurrentOperation\(operation\)/, 'icon generation must reject stale operations');
assert.match(iconGeneratorControllerSource, /name\.textContent =/, 'icon generator filenames must use safe text nodes');
assert.doesNotMatch(iconGeneratorControllerSource, /\.innerHTML\s*=/, 'icon generator runtime values must not be written through innerHTML');
assert.match(iconGeneratorTemplateSource, /iconGeneratorPortalTemplate/, 'icon generator modal markup must load with the feature');
assert.match(iconGeneratorGeneratorSource, /releaseCanvas\(canvas\)/, 'icon generator canvases must release their pixel memory');
assert.match(iconGeneratorPublisherSource, /discard_icon_archive_write/, 'icon generator native failures must discard partial archive sessions');
assert.match(iconGeneratorFeatureStyles, /\.icon-gen-v2/, 'the feature stylesheet must own icon generator layout');
assert.doesNotMatch(appStyles + finalToolStyles, /\.icon-gen-v2|#iconGen(?:ProcessMask|SuccessOverlay)/, 'shared stylesheets must not retain icon generator selectors');
assert.match(excelToPdfToolSource, /from ['"]\.\/template\.js['"]/, 'the Excel to PDF tool must delegate markup to its feature template');
assert.match(excelToPdfToolSource, /from ['"]\.\/controller\.js['"]/, 'the Excel to PDF tool must delegate runtime behavior to its controller');
assert.match(excelToPdfToolSource, /import ['"]\.\/excel-to-pdf\.css['"]/, 'the Excel to PDF feature must own its lazy stylesheet');
assert.match(excelToPdfControllerSource, /createLifecycleScope\(\)/, 'the Excel to PDF controller must own permanent and open-session lifecycle cleanup');
assert.match(excelToPdfControllerSource, /owner\.use\(unlisten\)/, 'the Excel to PDF controller must release native and progress listeners with the owning session');
assert.match(excelToPdfControllerSource, /from ['"]\.\.\/\.\.\/platform\/tauri-runtime\.js['"]/, 'the Excel to PDF controller must use the platform boundary');
assert.doesNotMatch(excelToPdfControllerSource, /from ['"]@tauri-apps\//, 'the Excel to PDF controller must not bypass the platform boundary');
assert.match(excelToPdfTemplateSource, /data-excel-action="convert"/, 'the Excel to PDF template must retain the conversion action contract');
assert.match(excelToPdfCompatibilitySource, /from ['"]\.\/features\/excel-to-pdf\/tool\.js['"]/, 'the legacy Excel to PDF UI path must forward to the feature entry');
assert.equal(excelToPdfCompatibilityStyles.trim(), "@import url('./features/excel-to-pdf/excel-to-pdf.css');", 'the legacy Excel to PDF stylesheet must forward to the feature stylesheet');
assert.match(excelToPdfFeatureStyles, /\.excel-to-pdf-overlay\s*\{/, 'the feature stylesheet must own the Excel to PDF overlay');
assert.match(indexSource, /href="\.\/src\/tool-custom-select\.css"/, 'the existing stylesheet position must remain stable');
assert.equal(selectCompatibilityStyles.trim(), "@import url('./styles/components/tool-custom-select.css');", 'the legacy stylesheet must forward to the component stylesheet');
assert.match(selectComponentStyles, /\.tool-custom-select-trigger\s*\{/, 'the component stylesheet must own custom select visuals');
assert.match(markdownCompatibilitySource, /from ['"]\.\/features\/markdown-editor\/tool\.js['"]/, 'the legacy Markdown UI path must forward to the feature entry');
assert.match(markdownToolSource, /from ['"]\.\/template\.js['"]/, 'the Markdown tool must delegate markup to its feature template');
assert.match(markdownToolSource, /from ['"]\.\/controller\.js['"]/, 'the Markdown tool must delegate behavior to its feature controller');
assert.match(markdownToolSource, /import ['"]\.\/markdown-editor\.css['"]/, 'the Markdown feature must own its lazy stylesheet');
assert.match(markdownControllerSource, /createLifecycleScope\(\)/, 'the Markdown controller must own permanent and open-session lifecycle cleanup');
assert.match(markdownControllerSource, /lifecycle\.use\(bindToolPageChrome\(shell, close\)\)/, 'the Markdown controller must release shared page chrome listeners');
assert.match(markdownControllerSource, /from ['"]\.\.\/\.\.\/platform\/tauri-runtime\.js['"]/, 'the Markdown controller must use the platform boundary');
assert.doesNotMatch(markdownControllerSource, /from ['"]@tauri-apps\//, 'the Markdown controller must not bypass the platform boundary');
assert.match(markdownControllerSource, /return \{ open, close, dispose \}/, 'the Markdown controller must implement the complete lifecycle contract');
assert.match(markdownTemplateSource, /data-lucide="save"/, 'the Markdown draft state must use a registered Lucide icon');
assert.doesNotMatch(markdownTemplateSource, /data-lucide="cloud-check"/, 'the removed Lucide cloud-check icon must not emit runtime warnings');
assert.match(markdownPreviewSecuritySource, /template\.content\.querySelectorAll\(['"]img['"]\)/, 'the Markdown preview must inspect every image');
assert.match(markdownFeatureStyles, /\.md-workbench\s*\{/, 'the Markdown feature stylesheet must own the workbench');
assert.doesNotMatch(appStyles + finalToolStyles, /\.md-|\.markdown-body|\.markdown-editor-overlay/, 'shared stylesheets must not retain Markdown selectors');

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
assert.equal(LAZY_TOOL_SPECS['pdf-editor']?.overlayId, 'pdfEditorOverlay', 'PDF Editor must be lazy-registered');
assert.equal(LAZY_TOOL_SPECS['image-color-replace']?.overlayId, 'imageColorReplaceOverlay', 'Image Color Replace must be lazy-registered');
assert.match(LAZY_TOOL_SPECS['image-color-replace'].load.toString(), /\.\/image-color-replace\/tool\.js/, 'Image Color Replace must load its feature entry directly');
assert.equal(LAZY_TOOL_SPECS['excel-to-pdf']?.overlayId, 'excelToPdfOverlay', 'Excel to PDF must be lazy-registered');
assert.match(LAZY_TOOL_SPECS['excel-to-pdf'].load.toString(), /\.\/excel-to-pdf\/tool\.js/, 'Excel to PDF must load its feature entry directly');
assert.equal(LAZY_TOOL_SPECS['markdown-editor']?.overlayId, 'markdownEditorOverlay', 'Markdown Editor must be lazy-registered');
assert.match(LAZY_TOOL_SPECS['markdown-editor'].load.toString(), /\.\/markdown-editor\/tool\.js/, 'Markdown Editor must load its feature entry directly');
assert.equal(LAZY_TOOL_SPECS['image-crop']?.overlayId, 'imageCropOverlay', 'Image Crop must be lazy-registered');
assert.match(LAZY_TOOL_SPECS['image-crop'].load.toString(), /\.\/image-crop\/tool\.js/, 'Image Crop must load its feature entry directly');
assert.equal(LAZY_TOOL_SPECS['icon-gen']?.overlayId, 'iconGenOverlay', 'Icon Generator must be lazy-registered');
assert.match(LAZY_TOOL_SPECS['icon-gen'].load.toString(), /\.\/icon-generator\/tool\.js/, 'Icon Generator must load its feature entry directly');
for (const [toolId, overlayId] of Object.entries({
  'image-convert': 'imageConvertOverlay',
  'image-compress': 'imageCompressOverlay'
})) {
  assert.equal(LAZY_TOOL_SPECS[toolId]?.overlayId, overlayId, `${toolId} must be lazy-registered`);
  assert.match(LAZY_TOOL_SPECS[toolId].load.toString(), /\.\/image-batch\/tool\.js/, `${toolId} must load the image batch feature entry`);
}
for (const [toolId, overlayId] of Object.entries({
  'hardware-overview': 'hardwareOverviewOverlay',
  'hardware-cpu-memory': 'hardwareCpuMemoryOverlay',
  'hardware-gpu-display': 'hardwareGpuDisplayOverlay',
  'hardware-mainboard': 'hardwareMainboardOverlay',
  'hardware-storage': 'hardwareStorageOverlay',
  'hardware-network-devices': 'hardwareNetworkDevicesOverlay',
  'hardware-power-sensors': 'hardwarePowerSensorsOverlay'
})) {
  assert.equal(LAZY_TOOL_SPECS[toolId]?.overlayId, overlayId, `${toolId} must be lazy-registered`);
  assert.match(LAZY_TOOL_SPECS[toolId].load.toString(), /\.\/hardware-inspector\/tool\.js/, `${toolId} must load the hardware feature entry`);
}
assert.match(mainSource, /LAZY_TOOL_SPECS/, 'main must use the shared lazy registry');
assert.doesNotMatch(mainSource, /from ['"]\.\/pdf-editor-ui\.js['"]/, 'PDF Editor must not be statically imported by main');
assert.match(mainSource, /pdfWorkerUrl,/, 'lazy features must receive the PDF worker URL through context');
assert.throws(() => validateLazyToolSpecs({ broken: { overlayId: 'x', init: 'init' } }), /load/);
assert.throws(() => validateLazyToolSpecs({
  brokenMarkup: { overlayId: 'x', init: 'init', load() {}, markup: '<div></div>' }
}), /markup must be a loader/);
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

function createTemplateRoot() {
  const templateRoot = new FakeTarget();
  const elements = new Map();
  templateRoot.defaultView = new FakeTarget();
  templateRoot.body = {
    append(fragment) {
      for (const child of fragment.children || []) elements.set(child.id, child);
    }
  };
  templateRoot.getElementById = id => elements.get(id) || null;
  templateRoot.querySelectorAll = () => [];
  templateRoot.createElement = name => {
    assert.equal(name, 'template');
    let markup = '';
    return {
      set innerHTML(value) { markup = value; },
      get content() {
        const id = markup.match(/\bid="([^"]+)"/)?.[1] || '';
        const children = id ? [{ id }] : [];
        return {
          children,
          cloneNode() { return { children: children.map(child => ({ ...child })) }; }
        };
      }
    };
  };
  return { elements, root: templateRoot };
}

const mountedTemplate = createTemplateRoot();
let sharedMarkupLoads = 0;
let mountedInitializerOverlay = null;
const templateRegistry = createLazyToolRegistry({
  specs: {
    templateOne: {
      instanceKey: 'template-shared',
      overlayId: 'template-overlay',
      init: 'initTool',
      markup: async () => {
        sharedMarkupLoads += 1;
        return { default: '<section id="template-overlay"></section>' };
      },
      load: async () => ({
        initTool({ overlay }) {
          mountedInitializerOverlay = overlay;
          return { open() {} };
        }
      })
    },
    templateTwo: {
      instanceKey: 'template-shared',
      overlayId: 'template-overlay',
      init: 'initTool',
      markup: async () => {
        sharedMarkupLoads += 1;
        return '<section id="template-overlay"></section>';
      },
      load: async () => ({ initTool() { return { open() {} }; } })
    }
  },
  root: mountedTemplate.root,
  onError: error => errors.push(error)
});
assert.ok(await templateRegistry.open('templateOne'), 'a missing lazy overlay must mount before initialization');
assert.equal(mountedInitializerOverlay, mountedTemplate.elements.get('template-overlay'), 'initialization must receive the mounted overlay');
assert.ok(await templateRegistry.open('templateTwo'));
assert.equal(sharedMarkupLoads, 1, 'tools sharing one instance must not mount their shared template twice');
assert.equal(mountedTemplate.elements.size, 1, 'shared markup must produce one overlay');
await templateRegistry.dispose();

const pendingMarkup = deferred();
const pendingMarkupStarted = deferred();
const abandonedTemplateRoot = createTemplateRoot();
let abandonedTemplateModuleLoads = 0;
let abandonedTemplateInitializerCalls = 0;
const abandonedTemplateRegistry = createLazyToolRegistry({
  specs: {
    abandonedTemplate: {
      overlayId: 'abandoned-template-overlay',
      init: 'initTool',
      markup() {
        pendingMarkupStarted.resolve();
        return pendingMarkup.promise;
      },
      async load() {
        abandonedTemplateModuleLoads += 1;
        return {
          initTool() {
            abandonedTemplateInitializerCalls += 1;
            return { open() {} };
          }
        };
      }
    }
  },
  root: abandonedTemplateRoot.root,
  onError: error => errors.push(error)
});
const abandonedTemplateOpen = abandonedTemplateRegistry.open('abandonedTemplate');
await pendingMarkupStarted.promise;
await abandonedTemplateRegistry.dispose();
pendingMarkup.resolve('<section id="abandoned-template-overlay"></section>');
assert.equal(await abandonedTemplateOpen, null);
assert.equal(abandonedTemplateRoot.elements.size, 0, 'a disposed registry must not mount a pending template');
assert.equal(abandonedTemplateModuleLoads, 0, 'a disposed registry must not load the feature after a pending template');
assert.equal(abandonedTemplateInitializerCalls, 0, 'a disposed registry must not initialize after a pending template');

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
