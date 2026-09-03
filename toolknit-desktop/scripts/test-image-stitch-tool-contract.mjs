import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { imageStitchPageTemplate } from '../src/features/image-stitch/template.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, lazyTools, tool, controller, template, featureStyles, appStyles] = await Promise.all([
  read('src/main.js'),
  read('index.html'),
  read('src/features/lazy-tools.js'),
  read('src/features/image-stitch/tool.js'),
  read('src/features/image-stitch/controller.js'),
  read('src/features/image-stitch/template.js'),
  read('src/features/image-stitch/image-stitch.css'),
  read('src/styles/legacy.css')
]);

assert.equal(LAZY_TOOL_SPECS['image-stitch']?.overlayId, 'imageStitchOverlay');
assert.equal(LAZY_TOOL_SPECS['image-stitch']?.init, 'initImageStitchTool');
assert.match(LAZY_TOOL_SPECS['image-stitch'].load.toString(), /image-stitch\/tool\.js/);
assert.match(lazyTools, /'image-stitch':\s*Object\.freeze\(/);
assert.match(html, /<div class="[^"]*feature-tool-overlay[^"]*image-stitch-v2[^"]*" id="imageStitchOverlay"[^>]*><\/div>/);
assert.doesNotMatch(main, /imageStitch(?:Overlay|Queue|Preview|Export|Processing)/);
assert.match(tool, /from ['"]\.\/template\.js['"]/);
assert.match(tool, /from ['"]\.\/controller\.js['"]/);
assert.match(tool, /import ['"]\.\/image-stitch\.css['"]/);
assert.match(controller, /createLifecycleScope\(/);
assert.match(controller, /isCurrentSession/);
assert.match(controller, /isCurrentOperation/);
assert.match(controller, /documentRef\.createElement\('canvas'\)/);
assert.match(controller, /from ['"]\.\.\/\.\.\/platform\/tauri-runtime\.js['"]/);
assert.doesNotMatch(controller, /from ['"]@tauri-apps\//);
assert.match(template, /id="imageStitchBack"/);
assert.match(template, /id="imageStitchSuccessOverlay"/);
assert.match(featureStyles, /\.image-stitch-v2/);
assert.doesNotMatch(appStyles, /\.image-stitch-v2\s+\.image-stitch-body/);

const ids = [...imageStitchPageTemplate().matchAll(/id="([^\"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'image stitch template contains duplicate IDs');
assert.ok(ids.includes('imageStitchQueue'));
assert.ok(ids.includes('imageStitchProcessing'));

console.log('Image Stitch lazy tool, template and lifecycle contract checks passed');
