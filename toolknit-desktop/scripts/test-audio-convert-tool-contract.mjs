import { readGlobalStyles } from './lib/global-styles.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';
import { audioConvertTemplate } from '../src/features/audio-convert/template.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, lazyTools, tool, controller, template, featureStyles, appStyles] = await Promise.all([
  read('src/main.js'),
  read('index.html'),
  read('src/features/lazy-tools.js'),
  read('src/features/audio-convert/tool.js'),
  read('src/features/audio-convert/controller.js'),
  read('src/features/audio-convert/template.js'),
  read('src/features/audio-convert/audio-convert.css'),
  readGlobalStyles(import.meta.url)
]);

const spec = LAZY_TOOL_SPECS.convert;
assert.equal(spec?.overlayId, 'audioConvertFeatureOverlay');
assert.equal(spec?.init, 'initAudioConvertTool');
assert.match(spec.load.toString(), /audio-convert\/tool\.js/);
assert.match(lazyTools, /convert:\s*Object\.freeze\(/);
assert.match(html, /<div class="[^"]*feature-tool-overlay[^"]*audio-convert-feature-host[^"]*" id="audioConvertFeatureOverlay"[^>]*><\/div>/);
assert.doesNotMatch(html, /audioConvertOverlay|audioConvertProcessMask|audioConvertSuccessOverlay/);
assert.doesNotMatch(main, /audioConvert(?:Overlay|ProcessMask|SuccessOverlay|Cta|ProcessBtn|Files|FormatOptions)/);
assert.doesNotMatch(main, /from ['"]\.\/audio-convert-core\.js['"]/);
assert.match(tool, /from ['"]\.\/template\.js['"]/);
assert.match(tool, /from ['"]\.\/controller\.js['"]/);
assert.match(tool, /import ['"]\.\/audio-convert\.css['"]/);
assert.match(controller, /createLifecycleScope\(/);
assert.match(controller, /queueLifecycle\.dispose\(\)/);
assert.match(controller, /convert_audio_batch/);
assert.match(controller, /cancel_convert/);
assert.match(controller, /convert-progress/);
assert.match(controller, /tauriEvents/);
assert.match(controller, /data-audio-convert-files/);
assert.match(controller, /querySelectorAll\('\[data-audio-convert-action\]'\)/);
assert.match(controller, /website:.*openExternalUrl/s);
assert.match(controller, /support:.*openSupport/s);
assert.doesNotMatch(controller, /document\./);
assert.match(template, /data-audio-convert-action="back"/);
assert.match(template, /data-audio-convert-action="start"/);
assert.match(template, /data-audio-convert-success-path/);
assert.match(featureStyles, /\.audio-convert-feature\.audio-convert-v2/);
assert.doesNotMatch(appStyles, /\.audio-convert-v2 \.pdf-merge-v2-poster::after/);

const ids = [...audioConvertTemplate().matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, 0, 'audio convert template must use scoped data hooks instead of global IDs');
assert.match(audioConvertTemplate(), /data-audio-convert-action="choose"/);
assert.match(audioConvertTemplate(), /data-audio-convert-action="open-folder"/);

console.log('Audio conversion lazy tool, template and lifecycle contract checks passed');
