import { buildPdfRasterCandidate } from '../../core/pdf-raster-candidate.js';
import { findPdfCompressionTarget, pdfCompressionError, pdfCompressionStatus } from '../../core/pdf-compression.js';

export async function encodePdfCompressionJob({ pages, cache, options, originalSize, check, onProgress = () => {} }) {
  const buildCandidate = async (settings, attempt) => buildPdfRasterCandidate({
    pages, settings, check,
    async encodePage(index, { width, height, quality }) {
      const blob = await cache.get(index);
      check();
      const bitmap = await createImageBitmap(blob);
      let canvas;
      try {
        canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw pdfCompressionError('worker-unavailable');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
        const jpeg = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
          : await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(pdfCompressionError('compression-failed')), 'image/jpeg', quality));
        check();
        return new Uint8Array(await jpeg.arrayBuffer());
      } finally {
        bitmap.close();
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      }
    },
    onPage: (current, total) => onProgress({ phase: 'encoding', current, total, ...attempt, ...settings })
  });
  let candidate;
  let attempts;
  let smallestSize;
  if (options.targetBytes != null) {
    const found = await findPdfCompressionTarget({
      targetBytes: options.targetBytes, clarity: options.clarity, buildCandidate, check,
      onAttempt: attempt => onProgress({ phase: 'attempt', ...attempt })
    });
    ({ candidate, attempts, smallestSize } = found);
  } else {
    const started = Date.now();
    candidate = await buildCandidate({ scale: options.scale, quality: options.quality }, { attempt: 1, totalAttempts: 1 });
    smallestSize = candidate.size;
    attempts = [{ attempt: 1, ...candidate.settings, bytes: candidate.size, elapsedMs: Date.now() - started }];
  }
  check();
  const status = candidate ? pdfCompressionStatus({ originalSize, compressedSize: candidate.size, targetBytes: options.targetBytes }) : 'target-not-reached';
  return {
    status, originalSize, compressedSize: Math.min(candidate?.size ?? smallestSize, originalSize),
    smallestSize, attempts, pages: pages.length, targetBytes: options.targetBytes,
    bytes: status === 'compressed' ? candidate.bytes : null,
    preview: status === 'compressed' ? candidate.preview : null,
    settings: candidate?.settings || null
  };
}
