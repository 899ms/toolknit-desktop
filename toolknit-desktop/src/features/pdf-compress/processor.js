import { tauriCorePromise } from '../../platform/tauri-runtime.js';
import {
  PDF_COMPRESS_LIMITS,
  assertPdfCompressLevel,
  assertPdfCompressSelection
} from '../../pdf-compress-core.js';

export class PdfCompressCancelledError extends Error {
  constructor() {
    super('pdf-compress:cancelled');
    this.name = 'PdfCompressCancelledError';
  }
}

function normalizeSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error('pdf-compress:invalid-pdf');
  }
  return size;
}

function normalizeNativeResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('pdf-compress:compression-failed');
  }
  const originalSize = normalizeSize(result.original_size);
  const compressedSize = normalizeSize(result.compressed_size);
  const outputPath = typeof result.output_path === 'string' ? result.output_path : '';
  const outputDir = typeof result.output_dir === 'string' ? result.output_dir : '';
  return { originalSize, compressedSize, outputPath, outputDir };
}

export function createPdfCompressProcessor({
  isTauri = false,
  getOutputDir
} = {}) {
  if (typeof getOutputDir !== 'function') throw new Error('pdf-compress:missing-output-directory');
  let disposed = false;

  const getInvoke = async () => (await tauriCorePromise).invoke;
  const assertCurrent = operation => {
    if (disposed || !operation || operation.cancelled || !operation.isCurrent()) {
      throw new PdfCompressCancelledError();
    }
  };

  async function sizeFile(file, operation) {
    assertCurrent(operation);
    if (!isTauri || !file?.path) return { ...file, size: normalizeSize(file?.size) };
    const invoke = await getInvoke();
    const size = await invoke('get_file_size', { path: file.path });
    assertCurrent(operation);
    return { ...file, size: normalizeSize(size) };
  }

  function cancel(operation) {
    if (operation) operation.cancelled = true;
  }

  async function run({ files = [], level = 'medium', operation, onProgress = () => {} } = {}) {
    if (disposed) throw new PdfCompressCancelledError();
    assertCurrent(operation);
    if (!isTauri) throw new Error('pdf-compress:desktop-only');

    const snapshot = Array.from(files);
    const sizedFiles = [];
    for (const file of snapshot) {
      sizedFiles.push(await sizeFile(file, operation));
    }
    assertCurrent(operation);
    assertPdfCompressSelection(sizedFiles, PDF_COMPRESS_LIMITS);
    assertPdfCompressLevel(level);

    const results = [];
    const errors = [];
    let outputDir = '';
    for (let index = 0; index < sizedFiles.length; index += 1) {
      assertCurrent(operation);
      const file = sizedFiles[index];
      onProgress(Math.round(((index + 0.3) / sizedFiles.length) * 100), {
        current: index + 1,
        total: sizedFiles.length
      });
      try {
        const invoke = await getInvoke();
        const directory = await getOutputDir('PDF_Compress');
        assertCurrent(operation);
        if (!file?.path) throw new Error('pdf-compress:desktop-only');
        const nativeResult = await invoke('compress_pdf', {
          inputPath: file.path,
          level,
          outputDir: directory
        });
        assertCurrent(operation);
        const normalized = normalizeNativeResult(nativeResult);
        outputDir = normalized.outputDir || outputDir;
        results.push({
          name: String(file.name || file.path || 'document.pdf'),
          originalSize: normalized.originalSize,
          compressedSize: normalized.compressedSize,
          outputPath: normalized.outputPath
        });
      } catch (error) {
        if (error instanceof PdfCompressCancelledError || operation.cancelled || !operation.isCurrent()) {
          throw new PdfCompressCancelledError();
        }
        errors.push({
          name: String(file.name || file.path || 'document.pdf'),
          error
        });
      }
    }
    assertCurrent(operation);
    onProgress(100, { current: sizedFiles.length, total: sizedFiles.length });
    return { results, errors, outputDir };
  }

  function dispose() {
    disposed = true;
  }

  return { cancel, dispose, run };
}
