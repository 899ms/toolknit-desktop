import { PdfEditorCancelledError } from './errors.js';

export function createPdfEditorDocumentStore({ pdfWorkerUrl, getSources, isDisposed }) {
  const documents = new Map();
  const pending = new Map();
  const loadingTasks = new Set();
  let generation = 0;
  let disposed = false;

  async function createLoadingTask(bytes) {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (disposed) throw new PdfEditorCancelledError();
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const wasmUrl = new URL('assets/', document.baseURI).href;
    const loadingTask = pdfjsLib.getDocument({
      data: bytes.slice(),
      wasmUrl,
      useWasm: true
    });
    loadingTasks.add(loadingTask);
    return loadingTask;
  }

  async function loadBytes(bytes, { onLoadingTask } = {}) {
    const requestGeneration = generation;
    const loadingTask = await createLoadingTask(bytes);
    onLoadingTask?.(loadingTask);
    try {
      const pdfDocument = await loadingTask.promise;
      if (disposed || requestGeneration !== generation || isDisposed?.()) {
        try { await pdfDocument.destroy(); } catch (_) {}
        throw new PdfEditorCancelledError();
      }
      return { document: pdfDocument, loadingTask };
    } finally {
      loadingTasks.delete(loadingTask);
    }
  }

  async function get(sourceId) {
    if (documents.has(sourceId)) return documents.get(sourceId);
    if (pending.has(sourceId)) return pending.get(sourceId);
    const source = getSources().find(item => item.id === sourceId);
    if (!source) throw new Error('Missing PDF source');
    const requestGeneration = generation;
    const request = (async () => {
      const { document: pdfDocument } = await loadBytes(source.bytes);
      if (requestGeneration !== generation || disposed) {
        try { await pdfDocument.destroy(); } catch (_) {}
        throw new PdfEditorCancelledError();
      }
      documents.set(sourceId, pdfDocument);
      return pdfDocument;
    })();
    pending.set(sourceId, request);
    try {
      return await request;
    } finally {
      if (pending.get(sourceId) === request) pending.delete(sourceId);
    }
  }

  function set(sourceId, pdfDocument) {
    if (disposed || !pdfDocument) return;
    documents.set(sourceId, pdfDocument);
  }

  async function destroyAll() {
    generation += 1;
    const tasks = Array.from(loadingTasks);
    await Promise.allSettled(tasks.map(async task => {
      try { await task.destroy(); } catch (_) {}
    }));
    loadingTasks.clear();
    const values = Array.from(documents.values());
    documents.clear();
    await Promise.allSettled(values.map(async pdfDocument => {
      try { await pdfDocument.destroy(); } catch (_) {}
    }));
  }

  return {
    get,
    loadBytes,
    set,
    destroyAll,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await destroyAll();
    }
  };
}
