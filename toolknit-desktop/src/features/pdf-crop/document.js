import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { pdfjsDocumentOptions, destroyPdfDocument } from '../../shared/pdfjs-options.js';
import {
  PDF_CROP_FULL_RECT,
  assertPdfCropPageCount
} from './core.js';

export async function releasePdfCropSource(source) {
  if (!source) return;
  try {
    if (source.pdfDoc) await destroyPdfDocument(source.pdfDoc);
    else await source.loadingTask?.destroy?.();
  } catch (_) {}
  source.pdfDoc = null;
  source.loadingTask = null;
  source.bytes = null;
}

export async function stagePdfCropDocument({
  name,
  size,
  bytes,
  active,
  assertOperation,
  setProgress,
  text
}) {
  const source = { name, size, bytes, pdfDoc: null, loadingTask: null };
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    assertOperation(active);
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    source.loadingTask = pdfjs.getDocument(pdfjsDocumentOptions({ data: bytes.slice() }));
    active.loadingTasks.add(source.loadingTask);
    try { source.pdfDoc = await source.loadingTask.promise; }
    finally { active.loadingTasks.delete(source.loadingTask); }
    assertOperation(active);
    assertPdfCropPageCount(source.pdfDoc.numPages);
    const pages = [];
    for (let index = 0; index < source.pdfDoc.numPages; index += 1) {
      assertOperation(active);
      const proxy = await source.pdfDoc.getPage(index + 1);
      try {
        const viewport = proxy.getViewport({ scale: 1 });
        pages.push({
          id: `pdf-crop-page-${index + 1}`,
          index,
          rotation: proxy.rotate || 0,
          displayWidth: viewport.width,
          displayHeight: viewport.height,
          rect: { ...PDF_CROP_FULL_RECT },
          explicit: false
        });
      } finally {
        proxy.cleanup?.();
      }
      setProgress(
        18 + Math.round(((index + 1) / source.pdfDoc.numPages) * 48),
        text('home.pdfCrop.preparingPage', { current: index + 1, total: source.pdfDoc.numPages })
      );
    }
    return { source, pages };
  } catch (error) {
    await releasePdfCropSource(source);
    throw error;
  }
}
