import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import {
  PDF_CROP_FULL_RECT,
  createPdfCropFileName,
  createPdfCropPageFileName,
  displayRectToPdfBox,
  exportCroppedPdf,
  exportCroppedPdfPage,
  normalizePdfCropRect,
  pdfCropMarginsToRect,
  pdfCropRectToMargins,
  splitCroppedPdfPages
} from '../src/features/pdf-crop/core.js';
import {
  calculatePdfCropInteractionRect,
  createLatestFrameScheduler,
  normalizePdfCropPointer
} from '../src/features/pdf-crop/interaction.js';
import { createPausableRenderQueue } from '../src/features/pdf-crop/thumbnail-queue.js';

const closeTo = (actual, expected, epsilon = 0.001) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const assertBox = (actual, expected) => Object.keys(expected).forEach(key => closeTo(actual[key], expected[key]));

assert.deepEqual(normalizePdfCropRect({ x: -1, y: 0.2, width: 2, height: 0.5 }), { x: 0, y: 0.2, width: 1, height: 0.5 });
const marginsRect = pdfCropMarginsToRect({ top: 10, right: 20, bottom: 30, left: 40 }, { width: 200, height: 100 });
assertBox(marginsRect, { x: 0.2, y: 0.1, width: 0.7, height: 0.6 });
assertBox(pdfCropRectToMargins(marginsRect, { width: 200, height: 100 }), { top: 10, right: 20, bottom: 30, left: 40 });

const base = { x: 10, y: 20, width: 200, height: 100 };
const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 };
assertBox(displayRectToPdfBox(rect, base, 0), { x: 30, y: 40, width: 100, height: 60 });
assertBox(displayRectToPdfBox(rect, base, 90), { x: 50, y: 30, width: 120, height: 50 });
assertBox(displayRectToPdfBox(rect, base, 180), { x: 90, y: 40, width: 100, height: 60 });
assertBox(displayRectToPdfBox(rect, base, 270), { x: 50, y: 60, width: 120, height: 50 });

assert.equal(createPdfCropFileName('draft.pdf'), 'draft_cropped.pdf');
assert.equal(createPdfCropFileName('draft.pdf', 'zip'), 'draft_cropped_pages.zip');
assert.equal(createPdfCropPageFileName('draft.pdf', 2, 12), 'draft_page_002.pdf');

assertBox(normalizePdfCropPointer({ clientX: 150, clientY: 90 }, {
  left: 50,
  top: 40,
  width: 200,
  height: 100
}), { x: 0.5, y: 0.5 });
assertBox(calculatePdfCropInteractionRect({
  mode: 'draw',
  start: { x: 0.7, y: 0.75 },
  point: { x: 0.2, y: 0.25 },
  rect: PDF_CROP_FULL_RECT,
  minWidth: 0.01,
  minHeight: 0.01
}), { x: 0.2, y: 0.25, width: 0.5, height: 0.5 });
assertBox(calculatePdfCropInteractionRect({
  mode: 'move',
  start: { x: 0.2, y: 0.2 },
  point: { x: 0.9, y: 0.9 },
  rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 }
}), { x: 0.6, y: 0.6, width: 0.4, height: 0.4 });
assertBox(calculatePdfCropInteractionRect({
  mode: 'resize',
  handle: 'nw',
  start: { x: 0.2, y: 0.2 },
  point: { x: 0.05, y: 0.08 },
  rect: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }
}), { x: 0.05, y: 0.08, width: 0.65, height: 0.62 });

const frames = new Map();
const frameWrites = [];
let frameSequence = 0;
const scheduler = createLatestFrameScheduler(value => frameWrites.push(value), {
  requestFrame(callback) {
    const id = ++frameSequence;
    frames.set(id, callback);
    return id;
  },
  cancelFrame(id) {
    frames.delete(id);
  }
});
scheduler.schedule('first');
scheduler.schedule('second');
scheduler.schedule('latest');
assert.equal(frames.size, 1, 'pointer updates must share one animation frame');
frames.values().next().value();
frames.clear();
assert.deepEqual(frameWrites, ['latest']);
scheduler.schedule('flush-old');
scheduler.schedule('flush-latest');
assert.equal(scheduler.flush(), 'flush-latest');
assert.deepEqual(frameWrites, ['latest', 'flush-latest']);
scheduler.schedule('cancelled');
scheduler.cancel();
assert.equal(frames.size, 0);
assert.deepEqual(frameWrites, ['latest', 'flush-latest']);

const queueRuns = [];
const queueCancels = [];
const queueResolvers = new Map();
let renderQueue;
renderQueue = createPausableRenderQueue({
  concurrency: 2,
  run(key) {
    queueRuns.push(key);
    let release = () => {};
    const promise = new Promise(resolve => {
      release = renderQueue.track(key, {
        cancel() {
          queueCancels.push(key);
          resolve();
        }
      });
      queueResolvers.set(key, resolve);
    });
    return promise.finally(release);
  }
});
renderQueue.enqueue('first');
renderQueue.enqueue('second');
renderQueue.enqueue('third');
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(queueRuns, ['first', 'second']);
renderQueue.pause();
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(queueCancels, ['first', 'second']);
assert.deepEqual(queueRuns, ['first', 'second']);
renderQueue.requeue('first');
renderQueue.resume();
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(queueRuns, ['first', 'second', 'first', 'third']);
queueResolvers.get('first')?.();
queueResolvers.get('third')?.();
await new Promise(resolve => setTimeout(resolve, 0));
renderQueue.dispose();

const fixture = await PDFDocument.create();
for (const rotation of [0, 90, 180, 270]) {
  const page = fixture.addPage([200, 100]);
  page.setRotation(degrees(rotation));
}
const fixtureBytes = new Uint8Array(await fixture.save());
const cropStates = [0, 90, 180, 270].map(() => ({ rect, explicit: true }));
const croppedBytes = await exportCroppedPdf({ bytes: fixtureBytes, crops: cropStates });
const cropped = await PDFDocument.load(croppedBytes);
const expectedBoxes = [
  { x: 20, y: 20, width: 100, height: 60 },
  { x: 40, y: 10, width: 120, height: 50 },
  { x: 80, y: 20, width: 100, height: 60 },
  { x: 40, y: 40, width: 120, height: 50 }
];
cropped.getPages().forEach((page, index) => {
  assertBox(page.getMediaBox(), expectedBoxes[index]);
  assertBox(page.getCropBox(), expectedBoxes[index]);
});

let currentProgress = null;
const currentPageBytes = await exportCroppedPdfPage({
  bytes: fixtureBytes,
  crop: cropStates[2],
  pageIndex: 2,
  onProgress: update => { currentProgress = update; }
});
const currentPageDocument = await PDFDocument.load(currentPageBytes);
assert.equal(currentPageDocument.getPageCount(), 1);
assertBox(currentPageDocument.getPage(0).getMediaBox(), expectedBoxes[2]);
assert.deepEqual(currentProgress, { completed: 1, total: 1, page: 3 });

const split = await splitCroppedPdfPages({
  bytes: fixtureBytes,
  crops: [
    { rect: PDF_CROP_FULL_RECT, explicit: false },
    ...cropStates.slice(1)
  ],
  baseName: 'fixture'
});
assert.equal(split.length, 4);
for (const [index, file] of split.entries()) {
  assert.equal(file.fileName, `fixture_page_${String(index + 1).padStart(3, '0')}.pdf`);
  assert.equal((await PDFDocument.load(file.bytes)).getPageCount(), 1);
}

console.log('PDF crop core regression checks passed');
