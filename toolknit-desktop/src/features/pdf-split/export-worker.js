import { buildPdfSplitOutput } from './workbench-export.js';

self.onmessage = async ({ data }) => {
  try {
    const output = await buildPdfSplitOutput({ ...data,
      onProgress: percent => self.postMessage({ type: 'progress', percent }) });
    self.postMessage({ type: 'result', output }, [output.bytes.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message || error) });
  }
};
