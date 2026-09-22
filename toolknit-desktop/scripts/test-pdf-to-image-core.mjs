import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { convertPdfToImages } from '../cli/lib/pdf-to-image-runtime.mjs';
import { ToolKnitError } from '../cli/lib/errors.mjs';
import {
  PDF_TO_IMAGE_CLARITY_PRESETS,
  PDF_TO_IMAGE_LIMITS,
  PdfToImageError,
  assertPdfToImageInput,
  assertPdfToImagePageCount,
  calculatePdfToImageRenderSize,
  createPdfToImageLongFileName,
  createPdfToImageHorizontalFileName,
  createPdfToImageGridFileName,
  createPdfToImagePageFileName,
  getPdfToImageClarityPreset,
  getPdfToImageFormatConfig,
  normalizePdfToImageFormat,
  normalizePdfToImagePageSelection,
  normalizePdfToImageRequest,
  planPdfToImageExport,
  planPdfToImageLongGroups,
  planPdfToImageGrid,
  sanitizePdfToImageBaseName
} from '../src/pdf-to-image-core.js';

function expectCode(code) {
  return error => error instanceof PdfToImageError && error.code === code;
}

assert.equal(PDF_TO_IMAGE_CLARITY_PRESETS.standard.dpi, 144);
assert.equal(PDF_TO_IMAGE_CLARITY_PRESETS.high.dpi, 200);
assert.equal(PDF_TO_IMAGE_CLARITY_PRESETS.print.dpi, 300);
assert.equal(PDF_TO_IMAGE_LIMITS.maxInputBytes, 150 * 1024 * 1024);
assert.equal(getPdfToImageClarityPreset('print').scale, 300 / 72);
assert.equal(normalizePdfToImageFormat(' JPEG '), 'jpg');
assert.deepEqual(getPdfToImageFormatConfig('png', 'standard'), {
  format: 'png', extension: 'png', mimeType: 'image/png', quality: null, dpi: 144, scale: 144 / 72
});
assert.equal(getPdfToImageFormatConfig('jpg', 'high').quality, 0.94);
assert.equal(getPdfToImageFormatConfig('webp', 'print').mimeType, 'image/webp');
assert.throws(() => normalizePdfToImageFormat('bmp'), expectCode('invalid_format'));
assert.throws(() => getPdfToImageClarityPreset('ultra'), expectCode('invalid_clarity'));

const a4Print = calculatePdfToImageRenderSize({ pageNumber: 1, width: 595.28, height: 841.89 }, 'print');
assert.equal(a4Print.width, 2480);
assert.equal(a4Print.height, 3508);
assert.equal(a4Print.wasLimited, false);
assert.equal(a4Print.requestedDpi, 300);
assert.equal(a4Print.effectiveDpi, 300);

const pixelLimited = calculatePdfToImageRenderSize(
  { pageNumber: 1, width: 1000, height: 1000 },
  'print',
  { maxRenderPixels: 1_000_000, maxRenderSide: 16_384 }
);
assert.equal(pixelLimited.width, 1000);
assert.equal(pixelLimited.height, 1000);
assert.equal(pixelLimited.pixels, 1_000_000);
assert.equal(pixelLimited.wasLimited, true);
assert.ok(pixelLimited.limitRatio > 0.23 && pixelLimited.limitRatio < 0.25);
assert.ok(pixelLimited.effectiveDpi < 75);

const sideLimited = calculatePdfToImageRenderSize(
  { pageNumber: 2, width: 10_000, height: 100 },
  'high',
  { maxRenderPixels: 40_000_000, maxRenderSide: 4_000 }
);
assert.equal(sideLimited.width, 4_000);
assert.ok(sideLimited.height >= 39 && sideLimited.height <= 40);
assert.ok(sideLimited.pixels <= 40_000_000);

assert.equal(assertPdfToImageInput([{ name: 'document.PDF' }], 1).name, 'document.PDF');
assert.equal(assertPdfToImagePageCount(PDF_TO_IMAGE_LIMITS.maxPages), PDF_TO_IMAGE_LIMITS.maxPages);
assert.throws(() => assertPdfToImageInput([], 0), expectCode('single_file_required'));
assert.throws(() => assertPdfToImageInput([{ name: 'one.pdf' }, { name: 'two.pdf' }], 2), expectCode('single_file_required'));
assert.throws(() => assertPdfToImageInput([{ name: 'image.png' }], 1), expectCode('invalid_pdf'));
assert.throws(() => assertPdfToImageInput([{ name: 'empty.pdf' }], 0), expectCode('invalid_pdf'));
assert.throws(
  () => assertPdfToImageInput([{ name: 'large.pdf' }], PDF_TO_IMAGE_LIMITS.maxInputBytes + 1),
  expectCode('input_too_large')
);
assert.throws(() => assertPdfToImagePageCount(0), expectCode('empty_pdf'));
assert.throws(() => assertPdfToImagePageCount(PDF_TO_IMAGE_LIMITS.maxPages + 1), expectCode('too_many_pages'));

assert.deepEqual(normalizePdfToImagePageSelection([3, { pageNumber: 1 }, { pageIndex: 2 }], 3), [1, 2, 3]);
assert.throws(() => normalizePdfToImagePageSelection([], 3), expectCode('invalid_selection'));
assert.throws(() => normalizePdfToImagePageSelection([1, 1], 3), expectCode('invalid_selection'));
assert.throws(() => normalizePdfToImagePageSelection([4], 3), expectCode('invalid_selection'));
assert.throws(
  () => normalizePdfToImagePageSelection(Array.from({ length: 21 }, (_, index) => index + 1), 21, 'long'),
  expectCode('too_many_long_pages')
);

assert.equal(sanitizePdfToImageBaseName('..\\unsafe/name.pdf'), 'name');
assert.equal(sanitizePdfToImageBaseName('CON.pdf'), 'document');
assert.equal(sanitizePdfToImageBaseName('COM1.notes.pdf'), 'document');
assert.equal(sanitizePdfToImageBaseName(`${'a'.repeat(63)}.tail.pdf`), 'a'.repeat(63));
assert.equal(sanitizePdfToImageBaseName('  Project: Alpha .pdf'), 'Project_ Alpha');
assert.equal(createPdfToImagePageFileName('report.pdf', 3, 12, 'png'), 'report_page_03.png');
assert.equal(createPdfToImagePageFileName('report.pdf', 100, 100, 'jpeg'), 'report_page_100.jpg');
assert.equal(
  createPdfToImageLongFileName('report.pdf', 2, [6, 8, 10], 16, 'webp'),
  'report_long_02_pages_06_08_10.webp'
);
assert.equal(createPdfToImageHorizontalFileName('report.pdf', 1, [1, 2, 3], 3, 'png'), 'report_horizontal_01_pages_01_02_03.png');
assert.equal(createPdfToImageGridFileName('report.pdf', [1, 2, 3, 4], 4, 'jpg'), 'report_grid_pages_01_02_03_04.jpg');
assert.throws(() => createPdfToImagePageFileName('report.pdf', 0, 12, 'png'), expectCode('invalid_selection'));
assert.throws(() => createPdfToImageLongFileName('report.pdf', 1, [1, 2, 3, 4, 5, 6], 6, 'png'), expectCode('invalid_selection'));

const fivePages = Array.from({ length: 5 }, (_, index) => ({
  pageNumber: index + 1,
  width: 100,
  height: 200,
  pixels: 20_000
}));
const oneGroup = planPdfToImageLongGroups(fivePages);
assert.equal(oneGroup.length, 1);
assert.deepEqual(oneGroup[0].items.map(item => item.pageNumber), [1, 2, 3, 4, 5]);

const mixedGroup = planPdfToImageLongGroups([
  { pageNumber: 1, width: 100, height: 200, pixels: 20_000 },
  { pageNumber: 2, width: 200, height: 100, pixels: 20_000 },
  { pageNumber: 3, width: 120, height: 80, pixels: 9_600 }
])[0];
assert.equal(mixedGroup.width, 200);
assert.equal(mixedGroup.height, 380);
assert.deepEqual(mixedGroup.items.map(item => [item.x, item.y]), [[50, 0], [0, 200], [40, 300]]);
const horizontal = planPdfToImageLongGroups([
  { pageNumber: 1, width: 100, height: 200, pixels: 20_000 },
  { pageNumber: 2, width: 200, height: 100, pixels: 20_000 },
  { pageNumber: 3, width: 120, height: 80, pixels: 9_600 }
], undefined, 'horizontal')[0];
assert.equal(horizontal.width, 420);
assert.equal(horizontal.height, 200);
assert.deepEqual(horizontal.items.map(item => [item.x, item.y]), [[0, 0], [100, 50], [300, 60]]);
const grid = planPdfToImageGrid([
  { pageNumber: 1, width: 100, height: 200, pixels: 20_000 },
  { pageNumber: 2, width: 200, height: 100, pixels: 20_000 },
  { pageNumber: 3, width: 120, height: 80, pixels: 9_600 },
  { pageNumber: 4, width: 90, height: 180, pixels: 16_200 }
]);
assert.deepEqual([grid.columns, grid.rows, grid.items.length], [2, 2, 4]);
assert.ok(grid.items.every(item => item.x >= 0 && item.y >= 0));
assert.throws(() => planPdfToImageGrid(fivePages.slice(0, 3)), expectCode('invalid_grid_count'));

const dynamicallySplit = planPdfToImageLongGroups(
  Array.from({ length: 6 }, (_, index) => ({ pageNumber: index + 1, width: 100, height: 100, pixels: 10_000 })),
  {
    maxLongImageSide: 10_000,
    maxLongImagePixels: 35_000,
    maxEstimatedWorkingBytes: 10_000_000
  }
);
assert.deepEqual(dynamicallySplit.map(group => group.items.length), [3, 3]);
assert.ok(dynamicallySplit.every(group => group.items.length <= 5));
assert.throws(
  () => planPdfToImageLongGroups(
    [{ pageNumber: 1, width: 500, height: 500, pixels: 250_000 }],
    { maxLongImagePixels: 100_000, maxEstimatedWorkingBytes: 10_000_000 }
  ),
  expectCode('output_too_large')
);

const individualPlan = planPdfToImageExport({
  sourceName: 'demo.pdf',
  pageCount: 3,
  selectedPages: [3, 1],
  pages: [3, 1],
  pageMetrics: [
    { pageNumber: 1, width: 100, height: 200 },
    { pageNumber: 3, width: 200, height: 100 }
  ],
  mode: 'images',
  format: 'jpg',
  clarity: 'standard'
});
assert.deepEqual(individualPlan.pages, [1, 3]);
assert.equal(individualPlan.outputCount, 2);
assert.deepEqual(individualPlan.outputs.map(output => output.fileName), ['demo_page_01.jpg', 'demo_page_03.jpg']);
assert.equal(individualPlan.formatConfig.dpi, 144);
assert.equal(individualPlan.formatConfig.quality, 0.9);

const longPlan = planPdfToImageExport({
  sourceName: 'demo.pdf',
  pageCount: 5,
  pages: Array.from({ length: 5 }, (_, index) => index + 1),
  pageMetrics: Array.from({ length: 5 }, (_, index) => ({ pageNumber: index + 1, width: 100, height: 200 })),
  mode: 'long',
  format: 'png',
  clarity: 'standard'
});
assert.equal(longPlan.outputCount, 1);
assert.equal(longPlan.outputs[0].fileName, 'demo_long_01_pages_01_02_03_04_05.png');
const gridPlan = planPdfToImageExport({
  sourceName: 'demo.pdf', pageCount: 4, pages: [1, 2, 3, 4],
  pageMetrics: Array.from({ length: 4 }, (_, index) => ({ pageNumber: index + 1, width: 100 + index, height: 200 - index })),
  mode: 'grid', format: 'png', clarity: 'standard'
});
assert.equal(gridPlan.outputCount, 1);
assert.equal(gridPlan.outputs[0].kind, 'grid');
assert.equal(gridPlan.outputs[0].fileName, 'demo_grid_pages_01_02_03_04.png');
assert.throws(() => planPdfToImageExport({
  sourceName: 'demo.pdf', pageCount: 6, pages: [1, 2, 3, 4, 5, 6],
  pageMetrics: Array.from({ length: 6 }, (_, index) => ({ pageNumber: index + 1, width: 100, height: 200 })),
  mode: 'grid', format: 'png', clarity: 'standard'
}), expectCode('invalid_grid_count'));

assert.deepEqual(normalizePdfToImageRequest({
  page_count: 2,
  pages: [2, 1],
  mode: 'images',
  format: 'PNG',
  clarity: 'HIGH'
}), { mode: 'images', format: 'png', clarity: 'high', pageCount: 2, pages: [1, 2] });
assert.throws(() => normalizePdfToImageRequest(null), expectCode('invalid_request'));
assert.throws(() => normalizePdfToImageRequest({ pageCount: 1, pages: [1], mode: 'zip' }), expectCode('invalid_mode'));
assert.throws(
  () => planPdfToImageExport({
    sourceName: 'demo.pdf', pageCount: 2, pages: [1, 2], pageMetrics: [{ pageNumber: 1, width: 100, height: 100 }]
  }),
  expectCode('invalid_page_metrics')
);
assert.throws(
  () => planPdfToImageExport({
    sourceName: 'demo.pdf', pageCount: 1, pages: [1], pageMetrics: [{ pageNumber: 1, width: 0, height: 100 }]
  }),
  expectCode('invalid_page_metrics')
);

const pdfToImageUiSource = [
  readFileSync(new URL('../src/features/pdf-to-image/tool.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/features/pdf-to-image/exporter.js', import.meta.url), 'utf8')
].join('\n');
assert.match(pdfToImageUiSource, /invoke\('cancel_pdf_to_image', \{ jobId: operation\.jobId \}\)/);
assert.doesNotMatch(pdfToImageUiSource, /invoke\('cancel_convert'\)/);
assert.match(pdfToImageUiSource, /isTauri && operation\.type === 'export'/);
assert.match(pdfToImageUiSource, /invoke\('write_pdf_to_image_page_json', \{/);
assert.doesNotMatch(pdfToImageUiSource, /invoke\('write_pdf_to_image_page', bytes/);

const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'toolknit-pdf-to-image-validation-'));
try {
  const sourceDocument = await PDFDocument.create();
  sourceDocument.addPage([612, 792]);
  const inputPath = path.join(runtimeDirectory, 'one-page.pdf');
  await writeFile(inputPath, await sourceDocument.save());
  for (const pages of [[2], [1, 1]]) {
    await assert.rejects(
      () => convertPdfToImages({
        input_path: inputPath,
        output_dir: runtimeDirectory,
        pages,
        format: 'png',
        clarity: 'standard'
      }),
      error => error instanceof ToolKnitError && error.code === 'INVALID_ARGUMENT'
    );
  }
} finally {
  await rm(runtimeDirectory, { recursive: true, force: true });
}

console.log('PDF to image core regression checks passed');
