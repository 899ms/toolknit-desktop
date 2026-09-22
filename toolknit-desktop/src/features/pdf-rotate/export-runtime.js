import { createPdfExportJob } from '../../shared/pdf-export-job.js';

export function createPdfRotateExportJob({ fileData, fileName, pages, mode, onProgress }) {
  return createPdfExportJob({
    name: 'PDF rotate', onProgress,
    createWorker: () => new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' }),
    prepare() {
      const copy = fileData.slice();
      return { payload: { fileData: copy, fileName, pages, mode }, transfers: [copy.buffer] };
    }
  });
}
