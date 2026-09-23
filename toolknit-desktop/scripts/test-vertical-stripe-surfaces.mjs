import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  shared: 'src/styles/components/vertical-stripe-surface.css',
  index: 'src/styles/index.css',
  textStats: 'src/features/text-stats/text-stats.css',
  imageCropCss: 'src/features/image-crop/image-crop.css',
  imageCropTemplate: 'src/features/image-crop/template.js',
  colorReplaceCss: 'src/features/image-color-replace/image-color-replace.css',
  colorReplaceTemplate: 'src/features/image-color-replace/template.js',
  imageStitchCss: 'src/features/image-stitch/image-stitch.css',
  imageStitchTemplate: 'src/features/image-stitch/template.js',
  audioCss: 'src/features/audio-tools/audio-clip.css',
  audioTemplate: 'src/features/audio-tools/template.html',
  teleprompterCss: 'src/features/teleprompter/teleprompter.css',
  teleprompterTemplate: 'src/features/teleprompter/template.js'
};
const source = Object.fromEntries(await Promise.all(
  Object.entries(files).map(async ([key, file]) => [key, await readFile(file, 'utf8')])
));

assert.match(source.index, /@import url\('\.\/components\/vertical-stripe-surface\.css'\)/);
assert.match(source.shared, /--tk-vertical-stripe-surface-image:\s*linear-gradient\(90deg/);
assert.match(source.shared, /--tk-vertical-stripe-surface-size:\s*38px 100%/);
assert.match(source.shared, /background-repeat:\s*repeat/);
assert.match(source.textStats, /\.text-stats-v2-textarea[\s\S]*?linear-gradient\(90deg/);

const bindings = [
  ['imageCropTemplate', 'image-crop-stage-shell tk-vertical-stripe-surface'],
  ['colorReplaceTemplate', 'color-replace-stage tk-vertical-stripe-surface'],
  ['imageStitchTemplate', 'image-stitch-preview-viewport tk-vertical-stripe-surface'],
  ['audioTemplate', 'audio-clip-v2-wave-panel tk-vertical-stripe-surface'],
  ['teleprompterTemplate', 'teleprompter-input tk-vertical-stripe-surface']
];
for (const [key, className] of bindings) assert.match(source[key], new RegExp(className));

for (const [key, selector] of [
  ['imageCropCss', 'image-crop-stage-shell\\.tk-vertical-stripe-surface'],
  ['colorReplaceCss', 'color-replace-stage\\.tk-vertical-stripe-surface'],
  ['imageStitchCss', 'image-stitch-preview-viewport\\.tk-vertical-stripe-surface'],
  ['audioCss', 'audio-clip-v2-wave-panel\\.tk-vertical-stripe-surface'],
  ['teleprompterCss', 'teleprompter-input\\.tk-vertical-stripe-surface']
]) {
  assert.match(source[key], new RegExp(`${selector}[\\s\\S]*?background-image:\\s*var\\(--tk-vertical-stripe-surface-image\\)`));
}

console.log('Vertical stripe surface ownership and template bindings passed');
