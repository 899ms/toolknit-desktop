import assert from 'node:assert/strict';
import {
  ICON_GEN_LIMITS,
  IconGenerationError,
  assertIconArchiveSize,
  assertIconSource,
  assertIconSourceDimensions,
  createEmbeddedIconSvg,
  encodeIco,
  isSupportedIconSource
} from '../src/icon-gen-core.js';

assert.equal(isSupportedIconSource('logo.PNG'), true);
assert.equal(isSupportedIconSource('logo.jpg'), true);
assert.equal(isSupportedIconSource('logo.JPEG'), true);
assert.equal(isSupportedIconSource('logo.gif'), false);
assertIconSource({ name: 'logo.jpg', size: 1024 });
assertIconSource({ name: 'logo.jpeg', size: 1024 });
assertIconSource({ name: 'logo.webp', size: 1024 });
assert.throws(
  () => assertIconSource({ name: 'logo.gif', size: 1024 }),
  (error) => error instanceof IconGenerationError && error.code === 'unsupported_input'
);
assert.throws(
  () => assertIconSource({ name: 'logo.png', size: ICON_GEN_LIMITS.maxInputBytes + 1 }),
  (error) => error instanceof IconGenerationError && error.code === 'input_too_large'
);
assert.throws(
  () => assertIconSource({ name: 'empty.png', size: 0 }),
  (error) => error instanceof IconGenerationError && error.code === 'invalid_input_size'
);
assertIconSourceDimensions(1024, 1024);
assert.throws(
  () => assertIconSourceDimensions(5_000, 5_000),
  (error) => error instanceof IconGenerationError && error.code === 'too_many_pixels'
);
assertIconArchiveSize(1024);
assert.throws(
  () => assertIconArchiveSize(ICON_GEN_LIMITS.maxOutputBytes + 1),
  (error) => error instanceof IconGenerationError && error.code === 'archive_too_large'
);

const firstPng = Uint8Array.from([1, 2, 3]);
const secondPng = Uint8Array.from([4, 5]);
const ico = encodeIco([{ size: 16, data: firstPng }, { size: 256, data: secondPng }]);
const icoView = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
assert.equal(icoView.getUint16(0, true), 0);
assert.equal(icoView.getUint16(2, true), 1);
assert.equal(icoView.getUint16(4, true), 2);
assert.equal(icoView.getUint8(6), 16);
assert.equal(icoView.getUint8(22), 0, '256px ICO entries must encode their dimensions as zero');
assert.equal(icoView.getUint32(18, true), 38);
assert.equal(icoView.getUint32(34, true), 41);
assert.deepEqual([...ico.slice(38)], [...firstPng, ...secondPng]);
assert.throws(() => encodeIco([]), error => error instanceof IconGenerationError && error.code === 'invalid_icon_set');

const svg = createEmbeddedIconSvg('AQID');
assert.match(svg, /^<svg /);
assert.match(svg, /data:image\/png;base64,AQID/);
assert.throws(
  () => createEmbeddedIconSvg('</image>'),
  error => error instanceof IconGenerationError && error.code === 'invalid_svg_source'
);

console.log('Icon generator core regression checks passed');
