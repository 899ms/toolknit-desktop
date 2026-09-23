import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { pdfjsDocumentOptions } from '../../shared/pdfjs-options.js';
import { PDF_COMPRESSION_POLICY, createPdfCompressionPagePlan, pdfCompressionError } from '../../core/pdf-compression.js';
import { createPdfPageCache } from './page-cache.js';

export async function rasterizePdfForCompression({ bytes, originalSize, options, signal, onProgress = () => {} }) {
  let loadingTask;
  let source;
  let renderTask;
  let worker;
  let rejectWorker;
  let cache;
  let stopped = '';
  const stop = code => {
    stopped ||= code;
    try { renderTask?.cancel(); } catch {}
    try { loadingTask?.destroy()?.catch(() => {}); } catch {}
    worker?.terminate();
    worker = null;
    rejectWorker?.(pdfCompressionError(stopped));
  };
  const aborted = () => stop('cancelled');
  const timer = setTimeout(() => stop('timeout'), PDF_COMPRESSION_POLICY.timeoutMs);
  signal?.addEventListener('abort', aborted, { once: true });
  const check = () => {
    if (signal?.aborted && !stopped) stopped = 'cancelled';
    if (stopped) throw pdfCompressionError(stopped);
  };
  try {
    check();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    check();
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    loadingTask = pdfjs.getDocument(pdfjsDocumentOptions({ data: bytes }));
    source = await loadingTask.promise;
    check();
    if (!source.numPages || source.numPages > 500) throw pdfCompressionError('too-many-pages');
    if (options.targetBytes != null && originalSize <= options.targetBytes) {
      return { status: 'already-within-target', originalSize, compressedSize: originalSize,
        pages: source.numPages, targetBytes: options.targetBytes, attempts: [] };
    }
    cache = await createPdfPageCache();
    check();
    const pages = [];
    for (let index = 0; index < source.numPages; index++) {
      check();
      const page = await source.getPage(index + 1);
      let canvas;
      try {
        const viewport = page.getViewport({ scale: 1 });
        const plan = createPdfCompressionPagePlan(viewport.width, viewport.height, options);
        canvas = document.createElement('canvas');
        canvas.width = plan.pixelWidth;
        canvas.height = plan.pixelHeight;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw pdfCompressionError('compression-failed');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({ canvasContext: context, viewport: page.getViewport({ scale: plan.sourceScale }) });
        renderTask.onContinue = continuation => setTimeout(() => { if (!stopped) continuation(); }, 0);
        await renderTask.promise;
        renderTask = null;
        check();
        const blob = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob)
          : reject(pdfCompressionError('compression-failed')), 'image/jpeg', PDF_COMPRESSION_POLICY.sourceQuality));
        check();
        await cache.put(index, blob);
        pages.push(plan);
      } finally {
        try { renderTask?.cancel(); } catch {}
        renderTask = null;
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        page.cleanup();
      }
      onProgress({ phase: 'preparing', current: index + 1, total: source.numPages, cacheBytes: cache.bytes });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    // The encoded source cache is now independent of the PDF.js document.
    await loadingTask.destroy();
    loadingTask = null;
    source = null;
    check();
    const job = { pages, options, originalSize, cache: cache.descriptor() };
    let result;
    try {
      if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') throw pdfCompressionError('worker-unavailable');
      result = await new Promise((resolve, reject) => {
        rejectWorker = reject;
        try { worker = new Worker(new URL('./raster-worker.js', import.meta.url), { type: 'module' }); }
        catch { reject(pdfCompressionError('worker-unavailable')); return; }
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') onProgress(data.progress);
          else if (data.type === 'result') resolve(data.result);
          else if (data.type === 'error') reject(pdfCompressionError(data.code));
        };
        worker.onerror = event => { event.preventDefault(); reject(pdfCompressionError('worker-unavailable')); };
        worker.onmessageerror = () => reject(pdfCompressionError('worker-unavailable'));
        worker.postMessage(job);
      });
    } catch (error) {
      check();
      if (error.message !== 'pdf-compress:worker-unavailable') throw error;
      worker?.terminate();
      worker = null;
      const { encodePdfCompressionJob } = await import('./raster-encode.js');
      check();
      result = await encodePdfCompressionJob({ ...job, cache, check, onProgress });
      result.compatibilityFallback = true;
    }
    check();
    return { ...result, cacheBytes: cache.bytes, sourceRenders: pages.length };
  } catch (error) {
    check();
    if (/PasswordException/.test(error?.name || '')) throw pdfCompressionError('password-protected');
    if (/InvalidPDFException|MissingPDFException/.test(error?.name || '')) throw pdfCompressionError('invalid-pdf');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
    rejectWorker = null;
    worker?.terminate();
    try { await loadingTask?.destroy(); } catch {}
    await cache?.dispose();
  }
}
