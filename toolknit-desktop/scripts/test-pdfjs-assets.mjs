import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pdfjsDocumentOptions, destroyPdfDocument } from '../src/shared/pdfjs-options.js';
import { pdfjsAssets } from './lib/pdfjs-assets.mjs';

const bytes = new Uint8Array([1, 2, 3]);
let destroyed = 0;
await destroyPdfDocument({ loadingTask: { destroy: async () => { destroyed++; } } });
await destroyPdfDocument({ destroy: async () => { destroyed++; } });
assert.equal(destroyed, 2);
for (const base of ['http://localhost:1420/', 'http://tauri.localhost/']) {
  const options = pdfjsDocumentOptions({ data: bytes }, base);
  assert.equal(options.data, bytes);
  assert.equal(options.cMapPacked, true);
  assert.equal(options.cMapUrl, `${base}assets/pdfjs/cmaps/`);
  assert.equal(options.standardFontDataUrl, `${base}assets/pdfjs/standard_fonts/`);
  assert.equal(options.wasmUrl, `${base}assets/pdfjs/wasm/`);
}
const assets = new Map();
const plugin = pdfjsAssets();
await plugin.generateBundle.call({ emitFile: asset => assets.set(asset.fileName, asset.source) });
assert.ok(assets.get('assets/pdfjs/cmaps/UniGB-UCS2-H.bcmap')?.length);
assert.ok(assets.get('assets/pdfjs/standard_fonts/LiberationSans-Regular.ttf')?.length);
const installedQcms = await readFile(new URL('../node_modules/pdfjs-dist/wasm/qcms_bg.wasm', import.meta.url));
assert.deepEqual(assets.get('assets/pdfjs/wasm/qcms_bg.wasm'), installedQcms);
assert.ok(assets.get('assets/pdfjs/wasm/openjpeg.wasm')?.length);
assert.ok(assets.get('assets/pdfjs/wasm/openjpeg_nowasm_fallback.js')?.length);
assert.ok([...assets.keys()].some(name => /LICENSE/.test(name)));
let middleware;
await plugin.configureServer({ middlewares: { use: callback => { middleware = callback; } } });
let response;
middleware({ url: '/assets/pdfjs/cmaps/UniGB-UCS2-H.bcmap' }, {
  setHeader() {}, end: value => { response = value; }
}, () => assert.fail('a bundled CMap must be served in development'));
assert.deepEqual(response, assets.get('assets/pdfjs/cmaps/UniGB-UCS2-H.bcmap'));
const responseHeaders = new Map();
middleware({ url: '/assets/pdfjs/wasm/qcms_bg.wasm' }, {
  setHeader: (name, value) => responseHeaders.set(name, value),
  end: value => { response = value; }
}, () => assert.fail('the version-matched QCMS WASM must be served in development'));
assert.equal(responseHeaders.get('Content-Type'), 'application/wasm');
assert.deepEqual(response, installedQcms);
let passedThrough = false;
middleware({ url: '/assets/pdfjs/../../package.json' }, {}, () => { passedThrough = true; });
assert.equal(passedThrough, true, 'the middleware must only expose its exact asset allowlist');

for (const file of [
  'pdf-compress/raster.js', 'pdf-merge/preview.js', 'pdf-split/preview.js',
  'pdf-to-image/preview.js', 'pdf-rotate/preview.js', 'pdf-enhance/processor.js',
  'pdf-editor/documents.js', 'pdf-crop/document.js', 'pdf-page-number/tool.js',
  'image-stitch/controller.js'
]) {
  const source = await readFile(new URL(`../src/features/${file}`, import.meta.url), 'utf8');
  assert.match(source, /getDocument\(pdfjsDocumentOptions\(/, file);
}
console.log(`PDF.js local resources passed: ${assets.size} assets, dev/build parity and shared loader coverage`);
