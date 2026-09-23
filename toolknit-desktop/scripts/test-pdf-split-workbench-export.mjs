import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import JSZip from 'jszip';
import { buildPdfSplitOutput } from '../src/features/pdf-split/workbench-export.js';
import { createPdfSplitExportJob } from '../src/features/pdf-split/export-runtime.js';

const a = await PDFDocument.create();
a.addPage([300, 400]);
a.addPage([600, 800]).setRotation(degrees(90));
const b = await PDFDocument.create();
b.addPage([500, 700]);
const documents = [{ fileData: await a.save(), fileName: 'same.pdf' }, { fileData: await b.save(), fileName: 'same.pdf' }];
const pages = [{ fileIndex: 0, pageIndex: 1 }, { fileIndex: 0, pageIndex: 2 }, { fileIndex: 1, pageIndex: 1 }];
for (const mode of ['single', 'all', 'zip']) {
  const chosen = mode === 'single' ? pages.slice(1, 2) : pages;
  const result = await buildPdfSplitOutput({ documents, pages: chosen, mode });
  assert.equal(result.pageCount, chosen.length);
  if (mode === 'zip') {
    const zip = await JSZip.loadAsync(result.bytes);
    const entries = Object.values(zip.files).filter(file => !file.dir);
    assert.equal(entries.length, 3);
    for (const [index, entry] of entries.entries()) {
      const pdf = await PDFDocument.load(await entry.async('uint8array'));
      assert.equal(pdf.getPageCount(), 1);
      assert.equal(pdf.getPage(0).getWidth(), [300, 600, 500][index]);
    }
  } else {
    const pdf = await PDFDocument.load(result.bytes);
    assert.equal(pdf.getPageCount(), chosen.length);
    assert.equal(pdf.getPage(mode === 'single' ? 0 : 1).getRotation().angle, 90);
  }
}
const subset = await buildPdfSplitOutput({ documents, pages: [pages[2], pages[0]], mode: 'all' });
assert.deepEqual((await PDFDocument.load(subset.bytes)).getPages().map(page => page.getWidth()), [500, 300]);
let checks = 0;
await assert.rejects(buildPdfSplitOutput({ documents, pages, mode: 'all', assertCurrent() {
  if (++checks > 2) throw new Error('cancelled');
} }), /cancelled/);
await assert.rejects(buildPdfSplitOutput({ documents, pages: [], mode: 'all' }));
const originalWorker = globalThis.Worker;
const workers = [];
globalThis.Worker = class {
  constructor() { this.terminated = false; workers.push(this); }
  postMessage(data, transfers) { this.data = data; this.transfers = transfers; }
  terminate() { this.terminated = true; }
};
try {
  const job = createPdfSplitExportJob({ documents, pages, mode: 'all' });
  assert.notEqual(workers[0].data.documents[0].fileData.buffer, documents[0].fileData.buffer);
  assert.equal(workers[0].transfers.length, documents.length);
  job.cancel();
  await assert.rejects(job.promise, /cancelled/);
  assert.equal(workers[0].terminated, true);
  const next = createPdfSplitExportJob({ documents, pages, mode: 'single' });
  workers[1].onmessage({ data: { type: 'result', output: { bytes: new Uint8Array([1]) } } });
  assert.equal((await next.promise).bytes.length, 1);
  assert.equal(workers[1].terminated, true);
  const failed = createPdfSplitExportJob({ documents, pages, mode: 'zip' });
  workers[2].onerror();
  await assert.rejects(failed.promise, /worker failed/);
  assert.equal(workers[2].terminated, true);
} finally { globalThis.Worker = originalWorker; }
console.log('Split workbench current/combined/ZIP, multisource geometry, selection and cancellation passed');
