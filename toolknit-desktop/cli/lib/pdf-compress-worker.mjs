import { parentPort, workerData } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { input, options, cacheDirectory, temporaryPath, coreDirectory } = workerData;
const core = await import(pathToFileURL(path.join(coreDirectory, 'pdf-compression.js')).href);
const { buildPdfRasterCandidate } = await import(pathToFileURL(path.join(coreDirectory, 'pdf-raster-candidate.js')).href);
const { PDF_COMPRESSION_POLICY: policy, pdfCompressionError } = core;
const started = Date.now();
const check = () => { if (Date.now() - started > policy.timeoutMs) throw pdfCompressionError('timeout'); };
let loadingTask;

try {
  const canvasModule = await import('@napi-rs/canvas');
  for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) {
    if (canvasModule[name]) globalThis[name] = canvasModule[name];
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const inputBytes = new Uint8Array(await readFile(input.path));
  if (inputBytes.byteLength !== input.size) throw pdfCompressionError('input-changed');
  loadingTask = pdfjs.getDocument({ data: inputBytes, verbosity: 0,
    standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts').replaceAll('\\', '/') + '/',
    cMapUrl: path.join(pdfjsRoot, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true,
    wasmUrl: path.join(pdfjsRoot, 'wasm').replaceAll('\\', '/') + '/' });
  const source = await loadingTask.promise;
  check();
  if (!source.numPages || source.numPages > 500) throw pdfCompressionError('too-many-pages');
  if (options.targetBytes != null && input.size <= options.targetBytes) {
    parentPort.postMessage({ status: 'already-within-target', originalSize: input.size,
      compressedSize: input.size, pages: source.numPages, attempts: [], targetBytes: options.targetBytes });
  } else {
    const pages = [];
    let cacheBytes = 0;
    for (let index = 0; index < source.numPages; index++) {
      check();
      const page = await source.getPage(index + 1);
      let canvas;
      try {
        const viewport = page.getViewport({ scale: 1 });
        const plan = core.createPdfCompressionPagePlan(viewport.width, viewport.height, options);
        canvas = canvasModule.createCanvas(plan.pixelWidth, plan.pixelHeight);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport: page.getViewport({ scale: plan.sourceScale }) }).promise;
        const jpeg = await canvas.encode('jpeg', Math.round(policy.sourceQuality * 100));
        cacheBytes += jpeg.byteLength;
        if (cacheBytes > policy.maxCacheBytes) throw pdfCompressionError('cache-limit');
        await writeFile(path.join(cacheDirectory, `${index}.jpg`), jpeg, { flag: 'wx' });
        pages.push(plan);
      } finally {
        if (canvas) { canvas.width = 1; canvas.height = 1; }
        page.cleanup();
      }
    }
    await loadingTask.destroy();
    loadingTask = null;
    const build = settings => buildPdfRasterCandidate({ pages, settings, check,
      async encodePage(index, { width, height, quality }) {
        const image = await canvasModule.loadImage(await readFile(path.join(cacheDirectory, `${index}.jpg`)));
        const canvas = canvasModule.createCanvas(width, height);
        try {
          const context = canvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, width, height);
          context.imageSmoothingQuality = 'high';
          context.drawImage(image, 0, 0, width, height);
          return new Uint8Array(await canvas.encode('jpeg', Math.round(quality * 100)));
        } finally { canvas.width = 1; canvas.height = 1; }
      }
    });
    let candidate;
    let attempts;
    let smallestSize;
    if (options.targetBytes != null) {
      ({ candidate, attempts, smallestSize } = await core.findPdfCompressionTarget({
        targetBytes: options.targetBytes, clarity: options.clarity, buildCandidate: build, check
      }));
    } else {
      const start = Date.now();
      candidate = await build({ scale: options.scale, quality: options.quality });
      smallestSize = candidate.size;
      attempts = [{ attempt: 1, ...candidate.settings, bytes: candidate.size, elapsedMs: Date.now() - start }];
    }
    check();
    const status = candidate ? core.pdfCompressionStatus({ originalSize: input.size,
      compressedSize: candidate.size, targetBytes: options.targetBytes }) : 'target-not-reached';
    if (status === 'compressed') await writeFile(temporaryPath, candidate.bytes, { flag: 'wx', mode: 0o600 });
    check();
    parentPort.postMessage({ status, originalSize: input.size, compressedSize: Math.min(candidate?.size ?? smallestSize, input.size),
      pages: pages.length, targetBytes: options.targetBytes, attempts, smallestSize, cacheBytes, sourceRenders: pages.length,
      settings: candidate?.settings || null });
  }
} catch (error) {
  const code = /pdf-compress:([a-z-]+)/.exec(String(error?.message))?.[1]
    || (/PasswordException/.test(error?.name) ? 'password-protected' : 'compression-failed');
  parentPort.postMessage({ error: code });
} finally {
  try { await loadingTask?.destroy(); } catch {}
  parentPort.close();
}
