import { readPdfPageCache } from './page-cache.js';
import { encodePdfCompressionJob } from './raster-encode.js';
import { PDF_COMPRESSION_POLICY, pdfCompressionError } from '../../core/pdf-compression.js';

self.onmessage = async ({ data }) => {
  let cache;
  const started = Date.now();
  try {
    if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') throw pdfCompressionError('worker-unavailable');
    cache = await readPdfPageCache(data.cache);
    const result = await encodePdfCompressionJob({ ...data, cache,
      check: () => { if (Date.now() - started > PDF_COMPRESSION_POLICY.timeoutMs) throw pdfCompressionError('timeout'); },
      onProgress: progress => self.postMessage({ type: 'progress', progress })
    });
    const transfer = [result.bytes?.buffer, result.preview?.buffer].filter(Boolean);
    self.postMessage({ type: 'result', result }, transfer);
  } catch (error) {
    const code = /pdf-compress:([a-z-]+)/.exec(String(error?.message))?.[1] || 'worker-unavailable';
    self.postMessage({ type: 'error', code });
  } finally { cache?.dispose(); }
};
