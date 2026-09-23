import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { pdfjsDocumentOptions } from '../../shared/pdfjs-options.js';
import { assertActive, conversionError, PDF_AI_MARKDOWN_LIMITS } from './core.js';

export async function loadAiPdf(bytes, signal) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  assertActive(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const task = pdfjs.getDocument(pdfjsDocumentOptions({ data: bytes.slice() }));
  const destroy = () => { void task.destroy().catch(() => {}); };
  const abort = () => destroy();
  signal.addEventListener('abort', abort, { once: true });
  let passwordProtected = false;
  task.onPassword = () => { passwordProtected = true; destroy(); };
  try {
    const pdfDocument = await task.promise;
    assertActive(signal);
    return { document: pdfDocument, destroy };
  } catch (error) {
    destroy();
    if (passwordProtected) throw conversionError('password-protected');
    throw error;
  } finally { signal.removeEventListener('abort', abort); }
}

export async function renderPageAsDataUrl(pdfDocument, pageNumber, signal, { maxWidth = 1600, maxPixels = 4_500_000 } = {}) {
  assertActive(signal);
  const page = await pdfDocument.getPage(pageNumber);
  const canvas = globalThis.document.createElement('canvas');
  let renderTask;
  const abort = () => renderTask?.cancel();
  try {
    assertActive(signal);
    const base = page.getViewport({ scale: 1 });
    if (!(base.width > 0 && base.height > 0)) throw conversionError('invalid-pdf');
    const scale = Math.min(2, maxWidth / base.width, Math.sqrt(maxPixels / (base.width * base.height)));
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw conversionError('canvas-unavailable');
    renderTask = page.render({ canvasContext: context, viewport, background: '#ffffff' });
    signal.addEventListener('abort', abort, { once: true });
    await renderTask.promise;
    assertActive(signal);
    const dataUrl = canvas.toDataURL('image/jpeg', .85);
    if (dataUrl.length > PDF_AI_MARKDOWN_LIMITS.maxImageBytes) throw conversionError('image-too-large');
    return dataUrl;
  } finally {
    signal.removeEventListener('abort', abort);
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}
