import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancellationError, throwIfAborted, ToolKnitError } from './errors.mjs';

export async function runRasterPdfCompression({ input, options, temporaryPath, signal }) {
  throwIfAborted(signal);
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'toolknit-pdf-compress-'));
  let coreDirectory = fileURLToPath(new URL('./core/core/', import.meta.url));
  try { await access(path.join(coreDirectory, 'pdf-compression.js')); }
  catch { coreDirectory = fileURLToPath(new URL('../../src/core/', import.meta.url)); }
  let worker;
  let timer;
  let onAbort;
  try {
    throwIfAborted(signal);
    return await new Promise((resolve, reject) => {
      worker = new Worker(new URL('./pdf-compress-worker.mjs', import.meta.url), {
        workerData: { input, options, temporaryPath, cacheDirectory, coreDirectory }
      });
      onAbort = () => reject(cancellationError());
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timer = setTimeout(() => reject(new ToolKnitError('TIMEOUT', 'PDF compression exceeded its time limit.')), 15 * 60 * 1000);
      worker.once('message', result => result.error
        ? reject(new ToolKnitError('PROCESSING_FAILED', `pdf-compress:${result.error}`)) : resolve(result));
      worker.once('error', () => reject(new ToolKnitError('PROCESSING_FAILED', 'PDF compression worker failed.')));
      worker.once('exit', () => reject(new ToolKnitError('PROCESSING_FAILED', 'PDF compression worker exited without a result.')));
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await worker?.terminate();
    // Only the directory returned by this invocation's mkdtemp is removed.
    if (path.dirname(cacheDirectory) === path.resolve(tmpdir()) && path.basename(cacheDirectory).startsWith('toolknit-pdf-compress-')) {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  }
}
