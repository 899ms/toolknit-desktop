import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PDF_ENHANCE_LIMITS,
  assertPdfEnhancePagePlan,
  assertPdfEnhanceSelection,
  assertPdfEnhanceStrength,
  createPdfEnhanceFileName,
  createPdfEnhanceRenderPlan,
  getPdfEnhanceErrorCode
} from '../src/pdf-enhance-core.js';
import { enhanceRgbaImage, sharpenRgbaImage } from '../src/pdf-enhance-engine.js';

assert.doesNotThrow(() => assertPdfEnhanceSelection([{ name: 'scan.pdf', size: 1024 }]));
assert.throws(() => assertPdfEnhanceSelection([]), /single-file-required/);
assert.throws(() => assertPdfEnhanceSelection([{ name: 'scan.png', size: 1024 }]), /invalid-pdf/);
assert.throws(() => assertPdfEnhanceSelection([{ name: 'scan.pdf', size: PDF_ENHANCE_LIMITS.maxInputBytes + 1 }]), /input-too-large/);

assert.doesNotThrow(() => assertPdfEnhanceStrength('medium'));
assert.throws(() => assertPdfEnhanceStrength('maximum'), /invalid-strength/);
assert.equal(createPdfEnhanceFileName('scan.pdf'), 'scan_enhanced.pdf');
assert.equal(createPdfEnhanceFileName('..\\unsafe/name?.PDF'), 'name__enhanced.pdf');
assert.equal(createPdfEnhanceFileName('...pdf'), 'document_enhanced.pdf');
assert.ok(createPdfEnhanceFileName(`${'x'.repeat(255)}.pdf`).length <= 213);

const validPlan = [{ outputWidth: 612, outputHeight: 792, renderWidth: 1530, renderHeight: 1980 }];
assert.equal(assertPdfEnhancePagePlan(validPlan).totalPixels, 3_029_400);
assert.equal(assertPdfEnhancePagePlan(validPlan).softBudgetExceeded, false);
assert.throws(() => assertPdfEnhancePagePlan([]), /invalid-pdf/);
assert.throws(() => assertPdfEnhancePagePlan([{ outputWidth: 612, outputHeight: 792, renderWidth: 9000, renderHeight: 10 }]), /page-too-large/);
assert.equal(assertPdfEnhancePagePlan(Array.from({ length: 100 }, () => ({ outputWidth: 612, outputHeight: 792, renderWidth: 1530, renderHeight: 1980 }))).softBudgetExceeded, true);

const [letterPlan] = createPdfEnhanceRenderPlan([{ outputWidth: 612, outputHeight: 792 }]);
assert.equal(letterPlan.renderScale, 2.5);

const [a0Plan] = createPdfEnhanceRenderPlan([{ outputWidth: 2383.94, outputHeight: 3370.39 }]);
const a0Pixels = Math.ceil(a0Plan.renderWidth) * Math.ceil(a0Plan.renderHeight);
assert.ok(a0Plan.renderScale < 2.5);
assert.ok(a0Pixels <= PDF_ENHANCE_LIMITS.maxRenderPixelsPerPage);
assert.doesNotThrow(() => assertPdfEnhancePagePlan([a0Plan]));

const documentPlan = createPdfEnhanceRenderPlan(
  Array.from({ length: 100 }, () => ({ outputWidth: 612, outputHeight: 792 }))
);
assert.equal(new Set(documentPlan.map(page => page.renderScale)).size, 1);
assert.ok(assertPdfEnhancePagePlan(documentPlan).totalPixels <= PDF_ENHANCE_LIMITS.maxTotalRenderPixels);

const [longPagePlan] = createPdfEnhanceRenderPlan([{ outputWidth: 1, outputHeight: 10_000 }]);
assert.ok(Math.ceil(longPagePlan.renderHeight) <= PDF_ENHANCE_LIMITS.maxRenderDimension);

const roundingLimits = {
  ...PDF_ENHANCE_LIMITS,
  maxRenderPixelsPerPage: 6,
  maxTotalRenderPixels: 100
};
const [roundingPlan] = createPdfEnhanceRenderPlan(
  [{ outputWidth: 2, outputHeight: 2 }],
  { baseRenderScale: 1.5 },
  roundingLimits
);
assert.ok(Math.ceil(roundingPlan.renderWidth) * Math.ceil(roundingPlan.renderHeight) <= 6);

const grayCard = new Uint8ClampedArray(9 * 9 * 4);
for (let index = 0; index < grayCard.length; index += 4) {
  grayCard[index] = 127;
  grayCard[index + 1] = 127;
  grayCard[index + 2] = 127;
  grayCard[index + 3] = 255;
}
const originalGrayCard = grayCard.slice();
sharpenRgbaImage(grayCard, 9, 9, 0.5, 2);
assert.deepEqual(grayCard, originalGrayCard);
assert.doesNotThrow(() => enhanceRgbaImage(grayCard.slice(), 9, 9, 'light'));

const engineSource = readFileSync(new URL('../src/pdf-enhance-engine.js', import.meta.url), 'utf8');
assert.match(
  engineSource,
  /const center = radius === 1 \? 1 \+ 4 \* amount : 1 \+ 6 \* amount;/,
  'the shared enhancement engine must keep the 5x5 sharpening kernel at unit DC gain'
);
assert.doesNotMatch(engineSource, /const center = 1 \+ 8 \* amount;/);
const processorSource = readFileSync(new URL('../src/features/pdf-enhance/processor.js', import.meta.url), 'utf8');
assert.match(processorSource, /enhanceRgbaImage/);
assert.match(processorSource, /begin_pdf_enhance_write/);
assert.match(processorSource, /append_pdf_enhance_chunk/);
assert.match(processorSource, /finalize_pdf_enhance_write/);
assert.match(processorSource, /discard_pdf_enhance_write/);
assert.doesNotMatch(
  processorSource,
  /\[PDF Enhance\][\s\S]{0,12000}invoke\('write_file_chunk'/,
  'PDF enhance must not stream directly into the final output path'
);

const cliRuntimeSource = readFileSync(new URL('../cli/lib/pdf-runtime.mjs', import.meta.url), 'utf8');
assert.match(cliRuntimeSource, /createPdfEnhanceRenderPlan\(pageSizes, \{ baseRenderScale: 2\.5 \}\)/);
assert.match(cliRuntimeSource, /page\.getViewport\(\{ scale: plan\.renderScale \}\)/);

assert.equal(getPdfEnhanceErrorCode('pdf-enhance:input-too-large'), 'input-too-large');
assert.equal(getPdfEnhanceErrorCode(new Error('PasswordException: No password given')), 'password-protected');

console.log('PDF enhance core contract checks passed');
