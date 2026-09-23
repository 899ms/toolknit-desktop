import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import JSZip from 'jszip';
import { buildPdfRotateOutput } from '../src/features/pdf-rotate/workbench-export.js';
import { createPdfRotateExportJob } from '../src/features/pdf-rotate/export-runtime.js';

const source = await PDFDocument.create();
for (const angle of [0, 90, 180, 270]) {
  const page = source.addPage([300 + angle, 500]);
  page.setRotation(degrees(angle));
  page.drawText('Original rotation ' + angle, { x: 20, y: 200 });
}
const fileData = await source.save(), fileName = 'rotation.pdf';
const pages = [0, 90, 180, 270].map((rotation, i) => ({ pageIndex: i + 1, rotation }));
for (const mode of ['single', 'all', 'zip']) {
  const chosen = mode === 'single' ? [pages[1]] : pages;
  const result = await buildPdfRotateOutput({ fileData, fileName, pages: chosen, mode });
  assert.equal(result.pageCount, chosen.length);
  const files = mode === 'zip' ? Object.values((await JSZip.loadAsync(result.bytes)).files) : [null];
  assert.equal(files.length, mode === 'zip' ? 4 : 1);
  for (const [index, entry] of files.entries()) {
    const pdf = await PDFDocument.load(entry ? await entry.async('uint8array') : result.bytes);
    const expected = mode === 'zip' ? [pages[index]] : chosen;
    assert.equal(pdf.getPageCount(), expected.length);
    pdf.getPages().forEach((page, n) => {
      assert.equal(page.getRotation().angle, ((expected[n].pageIndex - 1) * 90 + expected[n].rotation) % 360);
      assert.equal(page.getWidth(), 300 + (expected[n].pageIndex - 1) * 90);
    });
  }
}
const subset = await buildPdfRotateOutput({ fileData, fileName, pages: [pages[3], pages[0]], mode: 'all' });
assert.deepEqual((await PDFDocument.load(subset.bytes)).getPages().map(p => p.getWidth()), [570, 300]);
assert.deepEqual((await PDFDocument.load(fileData)).getPages().map(p => p.getRotation().angle), [0, 90, 180, 270]);
await assert.rejects(buildPdfRotateOutput({ fileData, fileName, pages: [], mode: 'zip' }));
await assert.rejects(buildPdfRotateOutput({ fileData, fileName, pages: [{ pageIndex: 99 }], mode: 'all' }));
const workers = [], original = globalThis.Worker;
globalThis.Worker = class {
  constructor() { workers.push(this); }
  postMessage(payload) { this.payload = payload; }
  terminate() { this.stopped = true; }
};
try {
  const cancelled = createPdfRotateExportJob({ fileData, fileName, pages, mode: 'zip' });
  assert.notEqual(workers[0].payload.fileData.buffer, fileData.buffer);
  cancelled.cancel(); await assert.rejects(cancelled.promise, /cancelled/);
  assert.equal(workers[0].stopped, true);
  const failed = createPdfRotateExportJob({ fileData, fileName, pages, mode: 'all' });
  workers[1].onerror(); await assert.rejects(failed.promise, /worker failed/);
  assert.equal(workers[1].stopped, true);
} finally { globalThis.Worker = original; }
console.log('Rotation current/subset/all/ZIP, original orientations, geometry and worker cancellation passed');
