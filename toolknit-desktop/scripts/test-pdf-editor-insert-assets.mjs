import assert from 'node:assert/strict';
import {
  assertImagePixelLimit,
  readEncodedImageDimensions,
  readImageDimensions
} from '../src/features/pdf-editor/insert-assets.js';

const png = new Uint8Array(24);
const pngView = new DataView(png.buffer);
pngView.setUint32(0, 0x89504e47);
pngView.setUint32(4, 0x0d0a1a0a);
pngView.setUint32(12, 0x49484452);
pngView.setUint32(16, 1920);
pngView.setUint32(20, 1080);
assert.deepEqual(readEncodedImageDimensions(png, 'image/png'), { width: 1920, height: 1080 });

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x09, 0x08, 0x02, 0x58, 0x03, 0x20, 0x00, 0x00]);
assert.deepEqual(readEncodedImageDimensions(jpeg, 'image/jpeg'), { width: 800, height: 600 });
assert.equal(readEncodedImageDimensions(new Uint8Array([1, 2, 3]), 'image/png'), null);
assert.deepEqual(assertImagePixelLimit({ width: 100, height: 200 }, { maxPixelsPerFile: 20000 }), { width: 100, height: 200 });
assert.throws(
  () => assertImagePixelLimit({ width: 101, height: 200 }, { maxPixelsPerFile: 20000 }),
  /图像分辨率超过/
);
assert.throws(
  () => assertImagePixelLimit({ width: 0, height: 20 }, { maxPixelsPerFile: 20000 }),
  /图像分辨率超过/
);

let revokedUrl = null;
const urlRef = {
  createObjectURL: () => 'blob:insert-assets-test',
  revokeObjectURL: url => { revokedUrl = url; }
};
class FakeBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.options = options;
  }
}
class FakeImage {
  constructor() {
    this.naturalWidth = 640;
    this.naturalHeight = 480;
  }
  set src(value) {
    this.source = value;
    queueMicrotask(() => this.onload?.());
  }
}
assert.deepEqual(
  await readImageDimensions(new Uint8Array([1]), 'image/png', {
    urlRef,
    blobConstructor: FakeBlob,
    imageConstructor: FakeImage
  }),
  { width: 640, height: 480 }
);
assert.equal(revokedUrl, 'blob:insert-assets-test');

console.log('PDF editor insert asset boundary checks passed');
