import assert from 'node:assert/strict';
import { FAVICON_SIZES, ICON_SIZES, ICO_SIZES, generateIconArchive } from '../src/features/icon-generator/generator.js';
import { discardIconArchiveOperation, publishIconArchive } from '../src/features/icon-generator/publisher.js';

const canvases = [];
function createCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    draws: [],
    getContext(type) {
      assert.equal(type, '2d');
      return { drawImage: (...args) => canvas.draws.push(args) };
    },
    toBlob(callback, type) {
      assert.equal(type, 'image/png');
      callback(new Blob([Uint8Array.from([137, 80, 78, 71, canvas.width & 0xff])], { type }));
    },
    toDataURL(type) {
      assert.equal(type, 'image/png');
      return 'data:image/png;base64,AQID';
    }
  };
  canvases.push(canvas);
  return canvas;
}

const archiveEntries = new Map();
const progress = [];
const result = await generateIconArchive({
  image: { naturalWidth: 1200, naturalHeight: 800 },
  createCanvas,
  createZip: () => ({
    folder(name) {
      assert.equal(name, 'icons');
      return { file: (path, value) => archiveEntries.set(path, value) };
    },
    async generateAsync(options, onProgress) {
      assert.equal(options.compression, 'DEFLATE');
      onProgress({ percent: 50 });
      onProgress({ percent: 100 });
      return new Blob(['deterministic-icon-archive']);
    }
  }),
  onProgress: update => progress.push(update)
});

assert.equal(result.count, ICON_SIZES.length + 3);
assert.equal(archiveEntries.size, ICON_SIZES.length + 3);
assert.ok(archiveEntries.has('icon-16x16.png'));
assert.ok(archiveEntries.has('icon-1024x1024.png'));
assert.ok(archiveEntries.has('icon.ico'));
assert.ok(archiveEntries.has('icon.svg'));
assert.ok(archiveEntries.has('favicon.ico'));
assert.equal(canvases.length, ICON_SIZES.length + ICO_SIZES.length + FAVICON_SIZES.length + 1);
assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'all icon canvases must release their backing pixels');
assert.equal(progress.at(-1).percent, 100);

let cancelledChecks = 0;
await assert.rejects(
  generateIconArchive({
    image: { width: 256, height: 256 },
    createCanvas,
    createZip: () => ({ folder: () => ({ file() {} }), generateAsync: async () => new Blob(['unused']) }),
    assertActive() {
      cancelledChecks += 1;
      if (cancelledChecks > 2) throw new Error('cancelled');
    }
  }),
  /cancelled/
);
assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'cancellation must release the active canvas');

const nativeCalls = [];
let nextSession = 81;
const nativeCore = Promise.resolve({
  async invoke(command, args) {
    nativeCalls.push({ command, args });
    if (command === 'begin_icon_archive_write') return nextSession++;
    if (command === 'finalize_icon_archive_write') return 'C:\\Output\\Icons\\icons_123.zip';
    return null;
  }
});
const operation = { archiveSessionId: null };
const largeBlob = new Blob([new Uint8Array(5_000_003)]);
const published = await publishIconArchive({
  blob: largeBlob,
  operation,
  isTauri: true,
  tauriCore: nativeCore,
  getOutputDir: async kind => {
    assert.equal(kind, 'Icons');
    return 'C:\\Output\\Icons';
  },
  now: () => 123
});
assert.equal(published.savedPath, 'C:\\Output\\Icons\\icons_123.zip');
assert.equal(operation.archiveSessionId, null);
assert.deepEqual(nativeCalls.map(call => call.command), [
  'begin_icon_archive_write',
  'append_icon_archive_chunk',
  'append_icon_archive_chunk',
  'finalize_icon_archive_write'
]);
assert.equal(nativeCalls[1].args.bytes.length, 5_000_000);
assert.equal(nativeCalls[2].args.bytes.length, 3);

const failedCalls = [];
const failedOperation = { archiveSessionId: null };
const failedCore = Promise.resolve({
  async invoke(command) {
    failedCalls.push(command);
    if (command === 'begin_icon_archive_write') return 99;
    if (command === 'append_icon_archive_chunk') throw new Error('write failed');
    return null;
  }
});
await assert.rejects(
  publishIconArchive({
    blob: new Blob(['archive']),
    operation: failedOperation,
    isTauri: true,
    tauriCore: failedCore,
    getOutputDir: async () => 'C:\\Output\\Icons'
  }),
  /write failed/
);
assert.deepEqual(failedCalls, [
  'begin_icon_archive_write',
  'append_icon_archive_chunk',
  'discard_icon_archive_write'
]);
assert.equal(failedOperation.archiveSessionId, null);

const discardCalls = [];
const cancelledOperation = { archiveSessionId: 101 };
assert.equal(await discardIconArchiveOperation(cancelledOperation, Promise.resolve({
  invoke: async (command, args) => discardCalls.push({ command, args })
})), true);
assert.equal(cancelledOperation.archiveSessionId, null);
assert.deepEqual(discardCalls, [{ command: 'discard_icon_archive_write', args: { sessionId: 101 } }]);

console.log('Icon generator runtime lifecycle checks passed');
