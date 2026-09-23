import { createPdfExportJob } from '../../shared/pdf-export-job.js';

export function createPdfSplitExportJob({ documents, pages, mode, onProgress = () => {} }) {
  return createPdfExportJob({
    name: 'PDF split', onProgress,
    createWorker: () => new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' }),
    prepare() {
      const copies = documents.map(document => ({ ...document, fileData: document.fileData.slice() }));
      return { payload: { documents: copies, pages, mode }, transfers: copies.map(document => document.fileData.buffer) };
    }
  });
}
