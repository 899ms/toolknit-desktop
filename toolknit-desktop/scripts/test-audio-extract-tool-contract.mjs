import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { audioExtractTemplate } from '../src/features/audio-extract/template.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, lazyTools, tool, controller, template, featureStyles, appStyles] = await Promise.all([
  read('src/main.js'),
  read('index.html'),
  read('src/features/lazy-tools.js'),
  read('src/features/audio-extract/tool.js'),
  read('src/features/audio-extract/controller.js'),
  read('src/features/audio-extract/template.js'),
  read('src/features/audio-extract/audio-extract.css'),
  read('src/styles.css')
]);

assert.equal(LAZY_TOOL_SPECS['audio-extract']?.overlayId, 'audioExtractFeatureOverlay');
assert.equal(LAZY_TOOL_SPECS['audio-extract']?.init, 'initAudioExtractTool');
assert.match(LAZY_TOOL_SPECS['audio-extract'].load.toString(), /audio-extract\/tool\.js/);
assert.match(lazyTools, /'audio-extract':\s*Object\.freeze\(/);
assert.match(html, /<div class="[^\"]*feature-tool-overlay[^\"]*audio-extract-feature-host[^\"]*" id="audioExtractFeatureOverlay"[^>]*><\/div>/);
assert.doesNotMatch(html, /audioExtractOverlay|audioExtractProcessMask|audioExtractSuccessOverlay/);
assert.doesNotMatch(main, /audioExtract(?:Overlay|ProcessMask|SuccessOverlay|Cta|Start|TrackSelect)/);
assert.doesNotMatch(main, /from ['"]\.\/audio-extract-core\.js['"]/);
assert.match(main, /from ['"]\.\/shared\/file-size\.js['"]/);
assert.match(tool, /from ['"]\.\/template\.js['"]/);
assert.match(tool, /from ['"]\.\/controller\.js['"]/);
assert.match(tool, /import ['"]\.\/audio-extract\.css['"]/);
assert.match(controller, /createLifecycleScope\(/);
assert.match(controller, /isCurrent\(/);
assert.match(controller, /cancel_convert/);
assert.match(controller, /audio-extract-progress/);
assert.match(controller, /outputParent\(state\.outputPath\)/);
assert.doesNotMatch(controller, /copy\(\{\s*probe:/);
assert.match(template, /data-audio-extract-action="back"/);
assert.match(template, /data-audio-extract-action="success-ok"/);
assert.match(featureStyles, /\.audio-extract-feature/);
assert.doesNotMatch(appStyles, /\.audio-extract-v2\s+\.audio-extract-body/);
assert.doesNotMatch(appStyles, /\.audio-extract-overlay/);

const ids = [...audioExtractTemplate().matchAll(/\sid="([^\"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, 0, 'audio extract template must use scoped data hooks instead of global IDs');
assert.match(audioExtractTemplate(), /data-audio-extract-action="choose"/);
assert.match(audioExtractTemplate(), /data-audio-extract-success-path/);

console.log('Audio extraction lazy tool, template and lifecycle contract checks passed');
