import assert from 'node:assert/strict';
import {
  PDF_COMPRESSION_POLICY as policy, normalizePdfCompressionOptions, createPdfCompressionPagePlan,
  findPdfCompressionTarget, structureCompressionArguments, pdfCompressionStatus
} from '../src/core/pdf-compression.js';

for (const target of [0, -1, NaN, Infinity, 50 * 1024 - 1, 50 * 1024 * 1024 + 1, 51200.5]) {
  assert.throws(() => normalizePdfCompressionOptions({ targetBytes: target }), /invalid-target-size/);
}
for (const field of ['mode', 'level', 'clarity']) {
  assert.throws(() => normalizePdfCompressionOptions({ [field]: '__proto__' }));
}
assert.deepEqual(['low', 'medium', 'high'].map(level => structureCompressionArguments(level).at(-1)),
  ['--compression-level=6', '--compression-level=8', '--compression-level=9']);
const plan = createPdfCompressionPagePlan(612, 792, normalizePdfCompressionOptions());
assert.equal(plan.sourceScale, 2);
assert.ok(plan.pixelWidth * plan.pixelHeight <= policy.maxPagePixels);
assert.throws(() => createPdfCompressionPagePlan(100000, 100000, normalizePdfCompressionOptions()), /page-too-large/);
assert.equal(pdfCompressionStatus({ originalSize: 100, compressedSize: 200, targetBytes: 500 }), 'already-within-target');
assert.equal(pdfCompressionStatus({ originalSize: 1000, compressedSize: 700, targetBytes: 500 }), 'target-not-reached');
assert.equal(pdfCompressionStatus({ originalSize: 1000, compressedSize: 1001 }), 'no-reduction');

let builds = 0;
const firstFits = await findPdfCompressionTarget({ targetBytes: 200000, buildCandidate: async () => ({ size: 150000, id: ++builds }) });
assert.equal(firstFits.attempts.length, 1);
assert.equal(firstFits.targetReached, true);

const released = [];
const searched = await findPdfCompressionTarget({ targetBytes: 200000, clarity: 'compact',
  buildCandidate: async settings => ({ size: Math.round(800000 * settings.scale ** 2 * settings.quality + 5000), id: ++builds }),
  release: async candidate => released.push(candidate.id)
});
assert.ok(searched.candidate.size <= 200000);
assert.ok(searched.attempts.length <= 6 && searched.attempts.length > 1);
assert.ok(!released.includes(searched.candidate.id));
assert.ok(searched.attempts.every(item => item.scale >= 0.35 && item.quality >= 0.25));

const compactCannotFit = await findPdfCompressionTarget({ targetBytes: 51200, clarity: 'compact',
  buildCandidate: async () => ({ size: 2000000 })
});
assert.ok(compactCannotFit.attempts.some(item => item.scale === 0.35 && item.quality === 0.25),
  'compact failure requires an actual approximately 25 DPI minimum-parameter attempt');

const cannotFit = await findPdfCompressionTarget({ targetBytes: 51200, buildCandidate: async () => ({ size: 2000000 }) });
assert.equal(cannotFit.targetReached, false);
assert.equal(cannotFit.candidate, null);
assert.equal(cannotFit.smallestSize, 2000000);
assert.ok(cannotFit.attempts.some(item => item.scale === 1 && item.quality === 0.4), 'failure requires an actual minimum-parameter attempt');

let aborted = false;
let disposed = 0;
await assert.rejects(findPdfCompressionTarget({ targetBytes: 51200,
  check: () => { if (aborted) throw new Error('pdf-compress:cancelled'); },
  buildCandidate: async () => { aborted = true; return { size: 50000 }; },
  release: async () => { disposed++; }
}), /cancelled/);
assert.equal(disposed, 1);
await assert.rejects(findPdfCompressionTarget({ targetBytes: 51200,
  buildCandidate: async () => ({ size: 50000 }), onAttempt: () => { throw new Error('callback-failed'); },
  release: async () => { disposed++; }
}), /callback-failed/);
assert.equal(disposed, 2, 'callback errors release the current candidate');
await assert.rejects(findPdfCompressionTarget({ targetBytes: 51200, buildCandidate: async () => ({ size: 0 }) }), /output-invalid/);

console.log('PDF target search boundary, simulated-size search, minimum attempt, cancellation and cleanup checks passed.');
