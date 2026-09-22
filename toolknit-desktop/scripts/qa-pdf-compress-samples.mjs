import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { compressPdfFile } from '../cli/lib/pdf-runtime.mjs';

const execFileAsync = promisify(execFile);
const qpdfPath = path.resolve('src-tauri/resources/qpdf/qpdf.exe');
const runId = `${Date.now()}-${process.pid}`;
const root = path.join(tmpdir(), `toolknit-pdf-compress-samples-${runId}`);
const inputDir = path.join(root, 'inputs');
const outputDir = path.join(root, 'outputs');
const renderDir = path.resolve('tmp', 'v3-overnight', 'pdf-compress-samples', runId);
const reportPath = path.resolve('tmp', 'pdf-compress-samples-report.json');

const defaultPopplerBin = path.join(
  process.env.USERPROFILE || '',
  '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native',
  'poppler', 'Library', 'bin'
);
const pdftoppmPath = process.env.TOOLKNIT_PDFTOPPM
  || path.join(process.env.TOOLKNIT_POPPLER_BIN || defaultPopplerBin, process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm');

async function qpdf(args) {
  try {
    const result = await execFileAsync(qpdfPath, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || error.message || '' };
  }
}

async function renderPdfPage(filePath, pageNumber, label) {
  const prefix = path.join(renderDir, `${label}-page-${pageNumber}`);
  const result = await execFileAsync(pdftoppmPath, [
    '-png', '-r', '96', '-f', String(pageNumber), '-l', String(pageNumber), '-singlefile',
    filePath, prefix
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  void result;
  const imagePath = `${prefix}.png`;
  const imageStat = await stat(imagePath);
  assert.ok(imageStat.isFile() && imageStat.size > 0, `rendered page must be non-empty: ${imagePath}`);
  const image = await loadImage(imagePath);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let samples = 0;
  let nonWhite = 0;
  let mean = 0;
  let m2 = 0;
  const step = 4;
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const offset = (y * image.width + x) * 4;
      const alpha = pixels[offset + 3];
      const luminance = (0.2126 * pixels[offset]) + (0.7152 * pixels[offset + 1]) + (0.0722 * pixels[offset + 2]);
      samples += 1;
      if (alpha > 8 && luminance < 248) nonWhite += 1;
      const delta = luminance - mean;
      mean += delta / samples;
      m2 += delta * (luminance - mean);
    }
  }
  const variance = samples > 1 ? m2 / (samples - 1) : 0;
  const nonWhiteRatio = samples ? nonWhite / samples : 0;
  assert.ok(nonWhite > 8, `rendered page appears blank: ${imagePath}`);
  assert.ok(variance > 0.25, `rendered page lacks visible content variation: ${imagePath}`);
  return {
    page: pageNumber,
    file: path.relative(process.cwd(), imagePath),
    bytes: imageStat.size,
    width: image.width,
    height: image.height,
    nonWhiteRatio: Number(nonWhiteRatio.toFixed(6)),
    luminanceVariance: Number(variance.toFixed(3))
  };
}

async function extractFirstPageText(filePath) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    disableWorker: true,
    useSystemFonts: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS
  });
  const document = await loadingTask.promise;
  try {
    const page = await document.getPage(1);
    const text = (await page.getTextContent()).items.map(item => item.str || '').join(' ').trim();
    page.cleanup?.();
    return text;
  } finally {
    await loadingTask.destroy();
  }
}

async function inspectRenderedPdf(filePath, label, { expectedText = '' } = {}) {
  const metadata = await inspectPdf(filePath);
  const pages = [...new Set([1, metadata.pages])];
  const renders = [];
  for (const pageNumber of pages) {
    renders.push(await renderPdfPage(filePath, pageNumber, label));
  }
  let text = null;
  if (expectedText) {
    text = await extractFirstPageText(filePath);
    assert.match(text, new RegExp(expectedText), `expected readable text missing from ${filePath}`);
  }
  return { bytes: metadata.bytes, pages: metadata.pages, renders, text };
}

function expectedTextFor(sampleName) {
  if (sampleName === 'already-optimized') return 'Already optimized PDF baseline';
  if (sampleName === 'text' || sampleName === 'large-text') return 'Compression sample text';
  return '';
}

function imageBytes(width, height) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const value = (x * 17 + y * 31 + (x ^ y)) % 255;
      context.fillStyle = `rgb(${value}, ${(value * 3) % 255}, ${(value * 7) % 255})`;
      context.fillRect(x, y, 8, 8);
    }
  }
  context.fillStyle = '#ffffff';
  context.font = '24px sans-serif';
  context.fillText('ToolKnit compression QA', 24, 42);
  return canvas.toBuffer('image/jpeg', 95);
}

function highEntropyImageBytes(width, height) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const image = context.createImageData(width, height);
  let state = 0x12345678;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    state = Math.imul(1664525, state) + 1013904223 | 0;
    image.data[offset] = state & 0xff;
    image.data[offset + 1] = (state >>> 8) & 0xff;
    image.data[offset + 2] = (state >>> 16) & 0xff;
    image.data[offset + 3] = 0xff;
  }
  context.putImageData(image, 0, 0);
  return canvas.toBuffer('image/jpeg', 98);
}

async function createTextPdf(filePath, pageCount, lineCount) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = document.addPage([612, 792]);
    for (let line = 0; line < lineCount; line += 1) {
      page.drawText(`Compression sample text ${pageIndex + 1}-${line} ` + 'lossless stream baseline '.repeat(3), {
        x: 36, y: 756 - (line % 100) * 7, size: 7, font
      });
    }
  }
  await writeFile(filePath, await document.save({ useObjectStreams: false }));
}

async function createAlreadyOptimizedPdf(filePath) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText('Already optimized PDF baseline', { x: 36, y: 740, size: 12, font });
  await writeFile(filePath, await document.save({ useObjectStreams: true }));
}

async function createImagePdf(filePath, pageCount, width, height) {
  const document = await PDFDocument.create();
  const image = await document.embedJpg(imageBytes(width, height));
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = document.addPage([612, 792]);
    page.drawImage(image, { x: 36, y: 126, width: 540, height: 540 });
  }
  await writeFile(filePath, await document.save({ useObjectStreams: false }));
}

async function createHighEntropyImagePdf(filePath) {
  const document = await PDFDocument.create();
  const image = await document.embedJpg(highEntropyImageBytes(3000, 2200));
  const page = document.addPage([612, 792]);
  page.drawImage(image, { x: 36, y: 126, width: 540, height: 540 });
  await writeFile(filePath, await document.save({ useObjectStreams: false }));
}

async function inspectPdf(filePath) {
  const metadata = await stat(filePath);
  assert.ok(metadata.isFile() && metadata.size > 0, `PDF must be a non-empty regular file: ${filePath}`);
  const pageResult = await qpdf(['--show-npages', '--', filePath]);
  assert.equal(pageResult.code, 0, `qpdf page inspection failed: ${pageResult.stderr}`);
  const checkResult = await qpdf(['--check', '--', filePath]);
  assert.equal(checkResult.code, 0, `qpdf validity check failed: ${checkResult.stderr}`);
  const document = await PDFDocument.load(await readFile(filePath));
  return { bytes: metadata.size, pages: document.getPageCount() };
}

async function compressEquivalent(inputPath, outputPath, level, targetSizeMb = null) {
  const original = await inspectPdf(inputPath);
  const result = await compressPdfFile({ input_path: inputPath, output_path: outputPath, level,
    mode: 'structure', target_bytes: targetSizeMb == null ? undefined : targetSizeMb * 1024 * 1024 });
  const output = result.outputs.length ? await inspectPdf(outputPath) : null;
  const targetReached = targetSizeMb === null ? null : ['compressed', 'already-within-target'].includes(result.status);
  return {
    level,
    targetSizeMb,
    original,
    output,
    savedBytes: output ? original.bytes - output.bytes : 0,
    autoWouldPublish: Boolean(output),
    status: result.status,
    targetReached,
    valid: true
  };
}

async function main() {
  assert.equal(await stat(qpdfPath).then(metadata => metadata.isFile()), true, 'bundled qpdf.exe must exist');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(renderDir, { recursive: true });
  await createTextPdf(path.join(inputDir, 'text.pdf'), 3, 260);
  await createImagePdf(path.join(inputDir, 'scan-like.pdf'), 3, 1400, 1000);
  await createImagePdf(path.join(inputDir, 'image-heavy.pdf'), 2, 2200, 1600);
  await createHighEntropyImagePdf(path.join(inputDir, 'unreachable-target.pdf'));
  await createTextPdf(path.join(inputDir, 'large-text.pdf'), 80, 1800);
  await createAlreadyOptimizedPdf(path.join(inputDir, 'already-optimized.pdf'));

  const cases = [
    { name: 'text', levels: ['low', 'medium', 'high'], targets: [5, 10, 15, 20, 50] },
    { name: 'scan-like', levels: ['medium'], targets: [5, 50] },
    { name: 'image-heavy', levels: ['medium'], targets: [5, 50] },
    { name: 'unreachable-target', levels: ['medium'], targets: [5] },
    { name: 'large-text', levels: ['medium', 'high'], targets: [5, 10, 50] },
    { name: 'already-optimized', levels: ['low', 'medium', 'high'], targets: [5] }
  ];
  const report = {
    runId,
    qpdfPath: 'src-tauri/resources/qpdf/qpdf.exe',
    renderer: path.relative(process.cwd(), pdftoppmPath),
    renderedEvidenceDir: path.relative(process.cwd(), renderDir),
    generatedAt: new Date().toISOString(),
    cases: []
  };
  for (const sample of cases) {
    const inputPath = path.join(inputDir, `${sample.name}.pdf`);
    const input = await inspectPdf(inputPath);
    const inputVisual = await inspectRenderedPdf(inputPath, `${sample.name}-input`, {
      expectedText: expectedTextFor(sample.name)
    });
    const results = [];
    for (const level of sample.levels) {
      const autoPath = path.join(outputDir, `${sample.name}-${level}-auto.pdf`);
      const auto = await compressEquivalent(inputPath, autoPath, level);
      const published = auto.autoWouldPublish;
      if (published) {
        auto.visual = await inspectRenderedPdf(autoPath, `${sample.name}-${level}-auto`, {
          expectedText: expectedTextFor(sample.name)
        });
      }
      results.push({ mode: 'auto', published, ...auto });
      if (!published) await rm(autoPath, { force: true });
    }
    for (const target of sample.targets) {
      const outputPath = path.join(outputDir, `${sample.name}-target-${target}.pdf`);
      const targetResult = await compressEquivalent(inputPath, outputPath, 'high', target);
      if (targetResult.output) {
        assert.ok(targetResult.output.bytes <= target * 1024 * 1024);
        targetResult.visual = await inspectRenderedPdf(outputPath, `${sample.name}-target-${target}`, {
          expectedText: expectedTextFor(sample.name)
        });
      } else {
        await assert.rejects(stat(outputPath), { code: 'ENOENT' });
      }
      results.push({ mode: 'target', published: Boolean(targetResult.output), ...targetResult });
    }
    report.cases.push({ name: sample.name, input, inputVisual, results });
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PDF compression sample matrix passed: ${path.relative(process.cwd(), reportPath)}`);
  for (const sample of report.cases) {
    const auto = sample.results.filter(result => result.mode === 'auto');
    const targets = sample.results.filter(result => result.mode === 'target');
    console.log(`${sample.name}: input=${sample.input.bytes} bytes/${sample.input.pages} pages; auto=${auto.map(result => result.savedBytes).join(',')}; targets=${targets.map(result => `${result.targetSizeMb}:${result.targetReached}`).join(',')}`);
  }
  await rm(root, { recursive: true, force: true });
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
