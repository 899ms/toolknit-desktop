import assert from 'node:assert/strict';
import {
  IMAGE_BATCH_LIMITS,
  ImageBatchError,
  getImageBatchFailureSummary,
  getImageCompressionOutcome,
  getImageExtension,
  isSupportedImageCompressionFileName,
  isSupportedImageFileName,
  normalizeImageCompressionQuality,
  normalizeImageTargetFormat,
  validateImageCompressionSelection,
  validateImageBatchSelection
} from '../src/image-batch-core.js';

assert.equal(IMAGE_BATCH_LIMITS.maxBytesPerFile, 100 * 1024 * 1024);
assert.equal(IMAGE_BATCH_LIMITS.maxPixelsPerFile, 160_000_000);

assert.equal(getImageExtension('photo.JPEG'), 'jpeg');
assert.equal(getImageExtension('no-extension'), '');
assert.equal(isSupportedImageFileName('sample.webp'), true);
assert.equal(isSupportedImageFileName('sample.svg'), false);
assert.equal(isSupportedImageCompressionFileName('sample.webp'), true);
assert.equal(isSupportedImageCompressionFileName('sample.gif'), false);
assert.equal(normalizeImageTargetFormat(' jpeg '), 'JPG');
assert.equal(normalizeImageTargetFormat('webp'), 'WEBP');
assert.equal(normalizeImageTargetFormat('svg'), 'SVG');
assert.throws(() => normalizeImageTargetFormat('tiff'), ImageBatchError);
assert.equal(normalizeImageCompressionQuality(' LOW '), 'low');
assert.throws(() => normalizeImageCompressionQuality('maximum'), ImageBatchError);

assert.deepEqual(
  getImageBatchFailureSummary({
    fail_count: 3,
    errors: ['broken.png: invalid data', 'missing.jpg: not found']
  }, 1),
  {
    failCount: 3,
    visibleErrors: ['broken.png: invalid data'],
    remainingCount: 2
  }
);
assert.deepEqual(getImageBatchFailureSummary({ fail_count: 0, errors: [] }), {
  failCount: 0,
  visibleErrors: [],
  remainingCount: 0
});

for (const [success, fail, total, unchanged] of [
  [3, 0, 3, 0], [1, 0, 3, 2], [0, 0, 3, 3], [1, 1, 3, 1], [0, 3, 3, 0], [0, 1, 3, 2]
]) {
  assert.deepEqual(getImageCompressionOutcome({ success_count: success, fail_count: fail, errors: [] }, total), {
    successCount: success, failCount: fail, unchangedCount: unchanged
  });
}

const selected = validateImageBatchSelection([
  { name: 'one.png', path: 'D:/input/one.png', size: 1024 },
  { name: 'two.JPG', path: 'D:/input/two.JPG', size: IMAGE_BATCH_LIMITS.maxBytesPerFile }
]);
assert.equal(selected.length, 2);
assert.throws(
  () => validateImageBatchSelection([{ name: 'bad.svg', path: 'D:/input/bad.svg', size: 1 }]),
  (error) => error instanceof ImageBatchError && error.code === 'unsupported_input'
);
assert.throws(
  () => validateImageBatchSelection([{ name: 'large.png', path: 'D:/input/large.png', size: IMAGE_BATCH_LIMITS.maxBytesPerFile + 1 }]),
  (error) => error instanceof ImageBatchError && error.code === 'file_too_large'
);
assert.throws(
  () => validateImageBatchSelection([{ name: 'unknown-size.png', path: 'D:/input/unknown-size.png' }]),
  (error) => error instanceof ImageBatchError && error.code === 'invalid_file_size'
);
assert.throws(
  () => validateImageBatchSelection([
    { name: 'copy.png', path: 'D:/input/copy.png', size: 1 },
    { name: 'copy.png', path: 'D:/input/copy.png', size: 1 }
  ]),
  (error) => error instanceof ImageBatchError && error.code === 'duplicate_input'
);
assert.throws(
  () => validateImageCompressionSelection([{ name: 'animated.gif', path: 'D:/input/animated.gif', size: 1 }]),
  (error) => error instanceof ImageBatchError && error.code === 'unsupported_compression_input'
);

console.log('Image batch core regression checks passed');
