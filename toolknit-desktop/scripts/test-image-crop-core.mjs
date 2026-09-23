import assert from 'node:assert/strict';
import {
  cropStatesEqual,
  constrainCropToRatio,
  displayPointToSource,
  exportCropRect,
  fitCropToRatio,
  flipCropRect,
  moveCropRect,
  resizeCropRect,
  rotateCropRect,
  snapCropToCenter,
  sourceRectToDisplay,
  transformedImageSize
} from '../src/features/image-crop/core.js';

const bounds = { width: 1200, height: 800 };
assert.deepEqual(fitCropToRatio(bounds, 1, 1), { x: 200, y: 0, width: 800, height: 800 });
assert.deepEqual(fitCropToRatio(bounds, 16 / 9, 1), { x: 0, y: 62.5, width: 1200, height: 675 });
const constrained = constrainCropToRatio({ x: 300, y: 200, width: 400, height: 400 }, bounds, 16 / 9);
assert.equal(Math.round(constrained.width / constrained.height * 1000), 1778);
assert.equal(constrained.x + constrained.width / 2, 500);
assert.equal(constrained.y + constrained.height / 2, 400);

assert.deepEqual(moveCropRect({ x: 900, y: 700, width: 400, height: 200 }, 100, 100, bounds), { x: 800, y: 600, width: 400, height: 200 });
assert.deepEqual(resizeCropRect({ x: 100, y: 100, width: 400, height: 300 }, 'se', 200, 0, bounds, 4 / 3), { x: 100, y: 100, width: 600, height: 450 });

const rotated = rotateCropRect({ x: 100, y: 200, width: 300, height: 250 }, bounds, 90);
assert.deepEqual(rotated, { rect: { x: 350, y: 100, width: 250, height: 300 }, size: { width: 800, height: 1200 } });
assert.deepEqual(flipCropRect({ x: 100, y: 50, width: 300, height: 200 }, bounds, 'horizontal'), { x: 800, y: 50, width: 300, height: 200 });
assert.deepEqual(transformedImageSize(1200, 800, 270), { width: 800, height: 1200 });

const display = { x: 20, y: 30, width: 600, height: 400 };
const mapped = sourceRectToDisplay({ x: 200, y: 100, width: 400, height: 200 }, display, bounds);
assert.deepEqual(mapped, { x: 120, y: 80, width: 200, height: 100 });
assert.deepEqual(displayPointToSource({ x: 120, y: 80 }, display, bounds), { x: 200, y: 100 });

let snap = snapCropToCenter({ x: 404, y: 302, width: 400, height: 200 }, bounds, 1, {});
assert.deepEqual(snap.snapped, { x: true, y: true });
assert.equal(snap.rect.x, 400);
assert.equal(snap.rect.y, 300);
snap = snapCropToCenter({ x: 411, y: 300, width: 400, height: 200 }, bounds, 1, snap.snapped);
assert.equal(snap.snapped.x, true, 'center snap uses release hysteresis');

assert.deepEqual(exportCropRect({ x: 0.4, y: 1.6, width: 1199.7, height: 798.8 }, bounds), { x: 0, y: 1, width: 1200, height: 799 });
assert.equal(cropStatesEqual({ rotation: 0, rect: { x: 1, y: 2, width: 3, height: 4 } }, { rotation: 0, rect: { x: 1.0001, y: 2, width: 3, height: 4 } }), true);

console.log('Image crop geometry tests passed.');
