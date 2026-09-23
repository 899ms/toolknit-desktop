export const PDF_COMPRESS_LIMITS = Object.freeze({
  maxFiles: 10,
  maxInputBytes: 150 * 1024 * 1024,
  maxPages: 500
});

export const PDF_COMPRESS_LEVELS = new Set(['low', 'medium', 'high']);
export const PDF_COMPRESS_TARGETS_MB = Object.freeze([5, 10, 15, 20, 50]);
export {
  PDF_COMPRESSION_POLICY, normalizePdfCompressionOptions, createPdfCompressionPagePlan,
  pdfCompressionStatus, structureCompressionArguments, findPdfCompressionTarget
} from './core/pdf-compression.js';

export function normalizePdfCompressTarget(value) {
  if (value == null || value === '' || value === 'auto') return null;
  const target = Number(value);
  if (!Number.isSafeInteger(target) || !PDF_COMPRESS_TARGETS_MB.includes(target)) {
    throw new Error('Invalid PDF compression target size');
  }
  return target;
}

export function assertPdfCompressSelection(files, limits = PDF_COMPRESS_LIMITS) {
  if (!Array.isArray(files) || files.length < 1) {
    throw new Error('At least one PDF file is required');
  }
  if (files.length > limits.maxFiles) {
    throw new Error(`PDF compression accepts at most ${limits.maxFiles} files at a time`);
  }
  for (const file of files) {
    if (!/\.pdf$/i.test(String(file?.name || ''))) {
      throw new Error('A PDF file is required');
    }
    const size = Number(file?.size);
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error('Invalid PDF file size');
    }
    if (size > limits.maxInputBytes) {
      throw new Error(`PDF input exceeds the ${Math.floor(limits.maxInputBytes / 1024 / 1024)}MB compression limit`);
    }
  }
}

export function assertPdfCompressLevel(level) {
  if (!PDF_COMPRESS_LEVELS.has(level)) {
    throw new Error('Invalid PDF compression level');
  }
}

export function getPdfCompressErrorCode(error) {
  const match = String(error?.message || error || '').match(/pdf-compress:([a-z-]+)/i);
  return match ? match[1].toLowerCase() : 'compression-failed';
}

export function summarizePdfCompressResults(results) {
  const processedResults = Array.isArray(results) ? results : [];
  const savedResults = processedResults.filter(result => typeof result?.outputPath === 'string' && result.outputPath.trim().length > 0);
  const noOutputResults = processedResults.filter(result => !savedResults.includes(result));
  const counts = { compressed: 0, 'already-within-target': 0, 'target-not-reached': 0, 'no-reduction': 0, error: 0 };
  for (const result of processedResults) {
    const status = result.status || (result.outputPath ? 'compressed' : 'no-reduction');
    if (Object.hasOwn(counts, status)) counts[status]++;
  }
  return {
    processedCount: processedResults.length,
    savedCount: savedResults.length,
    noOutputCount: noOutputResults.length,
    savedResults,
    noOutputResults,
    counts
  };
}
