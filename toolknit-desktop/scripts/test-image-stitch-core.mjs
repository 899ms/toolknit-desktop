import assert from 'node:assert/strict';
import { calculateStitchLayout, normalizeStitchSettings, IMAGE_STITCH_GRIDS } from '../src/features/image-stitch/core.js';
import {
  calculateImageStitchLayout,
  ImageStitchError,
  normalizeImageStitchRequest
} from '../src/image-stitch-core.js';

const images = [{ width: 100, height: 200 }, { width: 400, height: 100 }];
const vertical = calculateImageStitchLayout(images, { mode: 'vertical', reference: 'first' });
assert.deepEqual(vertical.items.map(item => [item.target_width, item.target_height]), [[100, 200], [100, 25]]);
assert.equal(vertical.width, 100);
assert.equal(vertical.height, 225);

const horizontal = calculateImageStitchLayout(images, {
  mode: 'horizontal',
  reference: 'largest',
  spacing_px: 8,
  scale_percent: 50,
  format: 'jpg',
  jpeg_quality: 92
});
assert.equal(horizontal.height, 100);
assert.equal(horizontal.width, 458);
assert.equal(horizontal.items[0].target_height, horizontal.items[1].target_height);
assert.equal(horizontal.pixels, horizontal.width * horizontal.height);

const rounded = calculateImageStitchLayout([{ width: 101, height: 10 }, { width: 5, height: 7 }], {
  mode: 'vertical', reference: 'first', scale_percent: 50
});
assert.equal(rounded.width, 51, 'reference scaling must round instead of truncate');

assert.deepEqual(normalizeImageStitchRequest(), {
  mode: 'vertical', reference: 'first', spacing_px: 0, scale_percent: 100,
  format: 'png', jpeg_quality: 92, background_rgba: '#FFFFFFFF', output_name: null
});
assert.equal(normalizeImageStitchRequest({ output_name: '发布 长图' }).output_name, '发布 长图');
assert.throws(() => normalizeImageStitchRequest({ output_name: '../escape' }), ImageStitchError);
assert.throws(() => normalizeImageStitchRequest({ output_name: 'CON' }), ImageStitchError);
assert.throws(() => normalizeImageStitchRequest({ background_rgba: '#fff' }), ImageStitchError);
assert.throws(() => calculateImageStitchLayout([images[0]], {}), /2 to 100/);
assert.throws(() => calculateImageStitchLayout(images, { spacing_px: 501 }), /Invalid stitch settings/);
assert.throws(() => calculateImageStitchLayout([{ width: 70_000, height: 1 }, images[0]], {}), /safe export limit/);

console.log('Image stitch core checks passed');

assert.deepEqual(calculateStitchLayout(images), vertical, 'linear layout stays compatible');
for (const [mode, side] of Object.entries(IMAGE_STITCH_GRIDS)) {
  const inputs = Array.from({ length: side * side }, (_, index) => ({ width: 100, height: index % 2 ? 50 : 100 }));
  const grid = calculateStitchLayout(inputs, { mode, spacing_px: 4, scale_percent: 50 });
  assert.equal(grid.width, side * 50 + (side - 1) * 4);
  assert.equal(grid.height, grid.width);
  assert.deepEqual(grid.items.slice(0, 2).map(i => [i.x, i.y, i.target_width, i.target_height]), [[0, 0, 50, 50], [54, 12, 50, 25]]);
  assert.equal(grid.items[side].y, 54 + (side % 2 ? 12 : 0));
  for (const count of [side * side - 1, side * side + 1]) {
    assert.throws(() => calculateStitchLayout(Array.from({ length: count }, () => inputs[0]), { mode }), /invalid-grid-count/);
  }
  assert.throws(() => calculateStitchLayout(inputs.map(() => ({ width: 65535, height: 65535 })), { mode }), /output-too-large/);
}
assert.throws(() => normalizeStitchSettings({ mode: 'grid-6' }), /Invalid stitch settings/);
assert.throws(() => calculateStitchLayout(Array(4).fill({ width: 0, height: 10 }), { mode: 'grid-2' }), /invalid-input/);
console.log('Desktop stitch grids, count gates, padding and limits passed');
