import { readGlobalStyles } from './lib/global-styles.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAZY_TOOL_SPECS } from '../src/features/lazy-tools.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, html, lazyTools, shared, convert, frame, gif, featureStyles, appStyles] = await Promise.all([
  read('src/main.js'),
  read('index.html'),
  read('src/features/lazy-tools.js'),
  read('src/features/video-tools/shared.js'),
  read('src/features/video-tools/convert-controller.js'),
  read('src/features/video-tools/frame-controller.js'),
  read('src/features/video-tools/gif-controller.js'),
  read('src/features/video-tools/video-tools.css'),
  readGlobalStyles(import.meta.url)
]);

for (const [toolId, overlayId, initializer] of [
  ['video-convert', 'videoConvertOverlay', 'initVideoConvertTool'],
  ['video-frame', 'videoFrameOverlay', 'initVideoFrameTool'],
  ['video-gif', 'videoGifOverlay', 'initVideoGifTool']
]) {
  const spec = LAZY_TOOL_SPECS[toolId];
  assert.equal(spec?.overlayId, overlayId);
  assert.equal(spec?.init, initializer);
  assert.match(spec.load.toString(), /video-tools\/tool\.js/);
  assert.match(lazyTools, new RegExp(`['"]${toolId}['"]?:\\s*Object\\.freeze\\(`));
  assert.match(html, new RegExp(`id="${overlayId}"`));
}

assert.doesNotMatch(main, /from ['"]\.\/video-(?:convert|frame|gif)-core\.js['"]/);
assert.doesNotMatch(main, /enableSortableFileList/);
assert.doesNotMatch(main, /Video Convert Tool|Video Frame Capture Tool|Video GIF Tool/);
assert.doesNotMatch(appStyles, /\.video-(?:convert|frame|gif)-v2|\.video-media-v2-/);
assert.match(featureStyles, /\.video-frame-body/);
assert.match(featureStyles, /\.video-convert-v2/);
assert.match(featureStyles, /\.video-media-v2-body/);

assert.match(shared, /scope\?\.use \? scope\.use\(unlisten\) : unlisten/);
for (const [source, eventName, command] of [
  [convert, 'convert-progress', 'convert_video_batch'],
  [frame, 'video-frame-progress', 'extract_video_frame'],
  [gif, 'video-gif-progress', 'extract_video_gif']
]) {
  assert.match(source, /createLifecycleScope\(/);
  assert.match(source, /open\(\)/);
  assert.match(source, /close\(\)/);
  assert.match(source, /dispose\(\)/);
  assert.match(source, new RegExp(eventName));
  assert.match(source, new RegExp(command));
  assert.match(source, /operation(?:Id|ation)|runId/);
  assert.match(source, /current\(owner\)/);
  assert.match(source, /session\?\.use \? session\.use\(rawUnlisten\) : rawUnlisten/);
  assert.doesNotMatch(source, /innerHTML/);
}

assert.match(frame, /previewVideo, 'timeupdate'/);
assert.match(frame, /previewVideo, 'seeked'/);
assert.match(gif, /stepMs/);
assert.match(gif, /frame_rate/);
assert.match(convert, /disposed/);
assert.match(convert, /completionTimer/);

console.log('Video tools lazy, lifecycle, CSS ownership and compatibility contract checks passed');
