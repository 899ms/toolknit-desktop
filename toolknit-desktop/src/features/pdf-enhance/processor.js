import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import {
  PDF_ENHANCE_LIMITS,
  assertPdfEnhancePagePlan,
  assertPdfEnhanceSelection,
  assertPdfEnhanceStrength,
  createPdfEnhanceFileName,
  createPdfEnhanceRenderPlan
} from '../../pdf-enhance-core.js';
import { enhanceRgbaImage } from '../../pdf-enhance-engine.js';

const BASE_RENDER_SCALE = 2.5;
const WRITE_CHUNK_BYTES = 5_000_000;

export class PdfEnhanceCancelledError extends Error {
  constructor() {
    super('pdf-enhance:cancelled');
    this.name = 'PdfEnhanceCancelledError';
  }
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('pdf-enhance:invalid-pdf');
}

function sourceName(file) {
  return String(file?.name || file?.fileName || file?.path?.split(/[\\/]/).pop() || 'document.pdf');
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function isRenderingCancellation(error) {
  return error?.name === 'RenderingCancelledException'
    || /cancelled|canceled/i.test(String(error?.message || error || ''));
}

function destroyLoadingTask(task) {
  if (!task) return;
  try {
    const pending = task.destroy();
    if (pending?.catch) void pending.catch(() => {});
  } catch (_) {}
}

function canvasJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('pdf-enhance:enhancement-failed')),
      'image/jpeg',
      0.85
    );
  });
}

export function createPdfEnhanceProcessor({
  isTauri = false,
  getOutputDir,
  onLargeDocument = () => {}
} = {}) {
  if (typeof getOutputDir !== 'function') throw new Error('pdf-enhance:missing-output-directory');
  let disposed = false;

  const getInvoke = async () => (await tauriCorePromise).invoke;
  const assertOperation = operation => {
    if (disposed || !operation || operation.cancelled || !operation.isCurrent()) {
      throw new PdfEnhanceCancelledError();
    }
  };

  async function fileWithSize(file) {
    if (!isTauri || !file?.path) return file;
    const invoke = await getInvoke();
    return { ...file, size: Number(await invoke('get_file_size', { path: file.path })) };
  }

  async function readFile(file) {
    if (isTauri && file?.path) {
      const invoke = await getInvoke();
      return asUint8Array(await invoke('read_file_bytes', { path: file.path }));
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  function cancel(operation) {
    if (!operation || operation.cancelled) return;
    operation.cancelled = true;
    try { operation.renderTask?.cancel(); } catch (_) {}
    destroyLoadingTask(operation.loadingTask);
  }

  async function writeNative(bytes, fileName, pageCount, operation) {
    const invoke = await getInvoke();
    const outputDir = await getOutputDir('Enhance');
    assertOperation(operation);
    operation.writeSessionId = await invoke('begin_pdf_enhance_write', {
      directory: outputDir,
      fileName,
      expectedPages: pageCount
    });
    assertOperation(operation);
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
      const end = Math.min(offset + WRITE_CHUNK_BYTES, bytes.length);
      await invoke('append_pdf_enhance_chunk', {
        sessionId: operation.writeSessionId,
        bytes: Array.from(bytes.subarray(offset, end))
      });
      assertOperation(operation);
    }
    const path = await invoke('finalize_pdf_enhance_write', {
      sessionId: operation.writeSessionId
    });
    operation.writeSessionId = null;
    assertOperation(operation);
    return path;
  }

  async function discardWrite(operation) {
    const sessionId = operation?.writeSessionId;
    operation.writeSessionId = null;
    if (!isTauri || sessionId === null || sessionId === undefined) return;
    try {
      const invoke = await getInvoke();
      await invoke('discard_pdf_enhance_write', { sessionId });
    } catch (_) {}
  }

  async function run({ file, strength, operation, onProgress = () => {} } = {}) {
    if (disposed) throw new PdfEnhanceCancelledError();
    let documentHandle = null;
    try {
      const sizedFile = await fileWithSize(file);
      assertOperation(operation);
      assertPdfEnhanceSelection([sizedFile]);
      assertPdfEnhanceStrength(strength);
      const bytes = await readFile(sizedFile);
      assertOperation(operation);
      if (!bytes.length) throw new Error('pdf-enhance:invalid-pdf');

      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      assertOperation(operation);
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const wasmUrl = new URL('assets/', document.baseURI).href;
      operation.loadingTask = pdfjs.getDocument({ data: bytes, wasmUrl, useWasm: true });
      documentHandle = await operation.loadingTask.promise;
      operation.loadingTask = null;
      assertOperation(operation);

      const pageCount = documentHandle.numPages;
      const pageSizes = [];
      for (let index = 1; index <= pageCount; index++) {
        assertOperation(operation);
        const page = await documentHandle.getPage(index);
        try {
          const viewport = page.getViewport({ scale: 1 });
          pageSizes.push({ outputWidth: viewport.width, outputHeight: viewport.height });
        } finally {
          try { page.cleanup(); } catch (_) {}
        }
      }

      const pagePlan = createPdfEnhanceRenderPlan(pageSizes, {
        baseRenderScale: BASE_RENDER_SCALE
      });
      assertPdfEnhancePagePlan(pagePlan);
      if (pagePlan[0]?.renderScale < BASE_RENDER_SCALE) onLargeDocument();
      onProgress(5, 'processing', { current: 0, total: pageCount });

      const { PDFDocument } = await import('pdf-lib');
      assertOperation(operation);
      const outputDocument = await PDFDocument.create();
      for (let index = 1; index <= pageCount; index++) {
        assertOperation(operation);
        let page = null;
        let canvas = null;
        try {
          page = await documentHandle.getPage(index);
          assertOperation(operation);
          const plan = pagePlan[index - 1];
          const viewport = page.getViewport({ scale: plan.renderScale });
          canvas = document.createElement('canvas');
          canvas.width = Math.ceil(plan.renderWidth);
          canvas.height = Math.ceil(plan.renderHeight);
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('pdf-enhance:enhancement-failed');
          operation.renderTask = page.render({ canvasContext: context, viewport });
          await operation.renderTask.promise;
          operation.renderTask = null;
          assertOperation(operation);

          const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
          enhanceRgbaImage(imageData.data, canvas.width, canvas.height, strength);
          context.putImageData(imageData, 0, 0);
          const jpeg = await canvasJpeg(canvas);
          assertOperation(operation);
          const image = await outputDocument.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
          assertOperation(operation);
          const outputPage = outputDocument.addPage([plan.outputWidth, plan.outputHeight]);
          outputPage.drawImage(image, {
            x: 0,
            y: 0,
            width: plan.outputWidth,
            height: plan.outputHeight
          });
        } finally {
          try { operation.renderTask?.cancel(); } catch (_) {}
          operation.renderTask = null;
          releaseCanvas(canvas);
          try { page?.cleanup(); } catch (_) {}
        }
        const progress = Math.round((index / pageCount) * 85) + 5;
        onProgress(progress, 'processing', { current: index, total: pageCount });
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      assertOperation(operation);
      onProgress(95, 'generating', { current: pageCount, total: pageCount });
      const outputBytes = await outputDocument.save();
      assertOperation(operation);
      if (outputBytes.length > PDF_ENHANCE_LIMITS.maxOutputBytes) {
        throw new Error('pdf-enhance:output-too-large');
      }
      const fileName = createPdfEnhanceFileName(sourceName(sizedFile));
      if (isTauri) {
        const path = await writeNative(outputBytes, fileName, pageCount, operation);
        return { path, fileName, pageCount };
      }
      return { bytes: outputBytes, path: `~/Downloads/${fileName}`, fileName, pageCount };
    } catch (error) {
      if (operation?.cancelled || isRenderingCancellation(error)) {
        throw new PdfEnhanceCancelledError();
      }
      throw error;
    } finally {
      try { operation?.renderTask?.cancel(); } catch (_) {}
      destroyLoadingTask(operation?.loadingTask);
      if (operation) {
        operation.renderTask = null;
        operation.loadingTask = null;
      }
      if (documentHandle) {
        try { await documentHandle.destroy(); } catch (_) {}
      }
      await discardWrite(operation);
    }
  }

  function dispose() {
    disposed = true;
  }

  return { cancel, dispose, run };
}
