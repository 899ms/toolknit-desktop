import assert from 'node:assert/strict';
import { syncPdfToImageExportModes, validatePdfToImageExportMode } from '../src/features/pdf-to-image/export-modes.js';

function button() {
  const values = new Set();
  return { disabled: false, attrs: {}, classList: {
    toggle(name, force) { if (force) values.add(name); else values.delete(name); },
    contains: name => values.has(name)
  }, setAttribute(name, value) { this.attrs[name] = value; } };
}

function assertButtonState(buttonElement, available, disabled) {
  assert.equal(buttonElement.classList.contains('is-available'), available);
  assert.equal(buttonElement.attrs['aria-hidden'], 'false');
  assert.equal(buttonElement.attrs['aria-disabled'], String(disabled));
  assert.equal(buttonElement.disabled, disabled);
}

const modeCases = [
  [1, false, false],
  [2, true, false],
  [3, true, false],
  [4, true, true],
  [5, true, false],
  [6, false, false],
  [7, false, false],
  [8, false, false],
  [9, false, true],
  [10, false, false],
  [20, false, false],
  [21, false, false]
];

for (const [selectedCount, horizontalAvailable, gridAvailable] of modeCases) {
  const long = button();
  const horizontal = button();
  const grid = button();
  const result = syncPdfToImageExportModes({
    longButton: long,
    horizontalButton: horizontal,
    gridButton: grid,
    longExportAllowed: true,
    selectedCount,
    busy: false
  });
  assert.deepEqual(result, { longAvailable: horizontalAvailable, horizontalAvailable, gridAvailable });
  assertButtonState(long, horizontalAvailable, !horizontalAvailable);
  assertButtonState(horizontal, horizontalAvailable, !horizontalAvailable);
  assertButtonState(grid, gridAvailable, !gridAvailable);
}

const busyHorizontal = button();
const busyGrid = button();
syncPdfToImageExportModes({
  horizontalButton: busyHorizontal,
  gridButton: busyGrid,
  longExportAllowed: true,
  selectedCount: 4,
  busy: true
});
assertButtonState(busyHorizontal, true, true);
assertButtonState(busyGrid, true, true);

const unavailableHorizontal = button();
const unavailableGrid = button();
const unavailableLong = button();
syncPdfToImageExportModes({
  longButton: unavailableLong,
  horizontalButton: unavailableHorizontal,
  gridButton: unavailableGrid,
  longExportAllowed: false,
  selectedCount: 9,
  busy: false
});
assert.equal(unavailableLong.attrs['aria-hidden'], 'true');
assertButtonState(unavailableHorizontal, false, true);
assertButtonState(unavailableGrid, false, true);

for (const selectedCount of [1, 2, 3, 5, 6, 7, 8, 10, 20, 21]) {
  assert.equal(validatePdfToImageExportMode('grid', selectedCount, true), 'invalid-grid-count');
}
assert.equal(validatePdfToImageExportMode('long', 1, true), 'too-few-long-pages');
assert.equal(validatePdfToImageExportMode('long-horizontal', 1, true), 'too-few-long-pages');
for (const selectedCount of [4, 9]) {
  assert.equal(validatePdfToImageExportMode('grid', selectedCount, true), '');
}
assert.equal(validatePdfToImageExportMode('long-horizontal', 2, true), '');
assert.equal(validatePdfToImageExportMode('long-horizontal', 5, true), '');
assert.equal(validatePdfToImageExportMode('long-horizontal', 6, true), 'too-many-long-pages');
assert.equal(validatePdfToImageExportMode('long-horizontal', 21, true), 'too-many-long-pages');
assert.equal(validatePdfToImageExportMode('grid', 6, false), 'unavailable');
assert.equal(validatePdfToImageExportMode('long', 2, false), 'unavailable');
console.log('PDF image export mode visibility and validation checks passed');
