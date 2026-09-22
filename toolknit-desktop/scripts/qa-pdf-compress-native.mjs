import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

const DEBUG_ENDPOINT = process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const root = path.join(tmpdir(), `toolknit-pdf-compress-native-qa-${Date.now()}`);
const inputDir = path.join(root, 'inputs');
const outputDir = path.join(root, 'outputs');
const reportPath = path.resolve('tmp', 'pdf-compress-native-report.json');

function inside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect() {
    const targets = await fetch(`${DEBUG_ENDPOINT}/json/list`).then(response => response.json());
    const target = targets.find(item => item.type === 'page' && /localhost:1420|tauri\.localhost/.test(item.url))
      || targets.find(item => item.type === 'page');
    assert.ok(target?.webSocketDebuggerUrl, 'Tauri WebView CDP target must exist');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot connect to Tauri WebView CDP')), { once: true });
    });
    const client = new CdpClient(socket);
    await client.send('Runtime.enable');
    return client;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }

  async invoke(command, args) {
    const result = await this.evaluate(`(async () => {
      try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}) }; }
      catch (error) { return { ok: false, error: String(error) }; }
    })()`);
    if (!result?.ok) throw new Error(result?.error || `${command} failed`);
    return result.value;
  }

  close() { this.socket.close(); }
}

async function createTextPdf(filePath, pageCount, linesPerPage) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = document.addPage([612, 792]);
    for (let line = 0; line < linesPerPage; line += 1) {
      page.drawText(`Native compression sample ${pageIndex + 1}-${line} ` + 'repeated text stream '.repeat(4), {
        x: 30, y: 770 - (line % 105) * 7, size: 7, font
      });
    }
  }
  await writeFile(filePath, await document.save({ useObjectStreams: false }));
}

async function createAlreadyOptimizedPdf(filePath) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText('Already optimized native PDF baseline', { x: 36, y: 740, size: 12, font });
  await writeFile(filePath, await document.save({ useObjectStreams: true }));
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

async function createUnreachableTargetPdf(filePath) {
  const document = await PDFDocument.create();
  const image = await document.embedJpg(highEntropyImageBytes(3000, 2200));
  const page = document.addPage([612, 792]);
  page.drawImage(image, { x: 36, y: 126, width: 540, height: 540 });
  await writeFile(filePath, await document.save({ useObjectStreams: false }));
}

async function directoryEntries(directory) {
  return (await readdir(directory)).sort();
}

async function inspect(filePath) {
  const metadata = await stat(filePath);
  assert.ok(metadata.isFile() && metadata.size > 0, `output must be non-empty: ${filePath}`);
  const document = await PDFDocument.load(await readFile(filePath));
  return { bytes: metadata.size, pages: document.getPageCount() };
}

async function run() {
  await rm(root, { recursive: true, force: true });
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const inputPath = path.join(inputDir, 'native-text.pdf');
  await createTextPdf(inputPath, 3, 260);
  const noGainPath = path.join(inputDir, 'already-optimized.pdf');
  await createAlreadyOptimizedPdf(noGainPath);
  const unreachablePath = path.join(inputDir, 'unreachable-target.pdf');
  await createUnreachableTargetPdf(unreachablePath);
  const original = await inspect(inputPath);
  const client = await CdpClient.connect();
  const report = {
    endpoint: DEBUG_ENDPOINT,
    generatedAt: new Date().toISOString(),
    input: original,
    results: [],
    outputDir: 'TEMP/native-output',
    noGain: null,
    cancellation: null
  };
  try {
    for (const targetSizeMb of [5, 10, 15, 20, 50]) {
      const result = await client.invoke('compress_pdf', {
        inputPath, level: 'medium', targetSizeMb, outputDir
      });
      const outputPath = String(result?.output_path || result?.outputPath || '');
      if (original.bytes <= targetSizeMb * 1024 * 1024) {
        assert.equal(outputPath, '');
        assert.equal(result.status, 'already-within-target');
        assert.equal(result.target_reached, true);
        report.results.push({ mode: 'target', targetSizeMb, output: null, targetReached: true, status: result.status });
        continue;
      }
      assert.ok(outputPath && inside(outputDir, outputPath), `native output must stay inside outputDir: ${outputPath}`);
      const output = await inspect(outputPath);
      assert.equal(output.pages, original.pages);
      assert.equal(Number(result.original_size || result.originalSize), original.bytes);
      assert.equal(Number(result.compressed_size || result.compressedSize), output.bytes);
      assert.equal(Boolean(result.target_reached ?? result.targetReached), output.bytes <= targetSizeMb * 1024 * 1024);
      report.results.push({ mode: 'target', targetSizeMb, output, targetReached: output.bytes <= targetSizeMb * 1024 * 1024, fileName: path.basename(outputPath) });
    }
    const noGainOriginal = await inspect(noGainPath);
    const noGain = await client.invoke('compress_pdf', {
      inputPath: noGainPath, level: 'medium', outputDir
    });
    assert.equal(noGain.output_path ?? noGain.outputPath ?? null, null, 'auto mode must not publish an inflated/no-gain PDF');
    assert.equal(Number(noGain.original_size || noGain.originalSize), noGainOriginal.bytes);
    assert.ok(Number(noGain.compressed_size || noGain.compressedSize) >= noGainOriginal.bytes);
    const noGainEntries = await directoryEntries(outputDir);
    assert.ok(!noGainEntries.some(name => name.startsWith('already-optimized_compressed')), 'no-gain auto mode must leave no published output');
    report.noGain = {
      input: noGainOriginal,
      engineBytes: Number(noGain.compressed_size || noGain.compressedSize),
      outputPath: null,
      published: false,
      targetMode: false
    };

    const unreachableOriginal = await inspect(unreachablePath);
    assert.ok(unreachableOriginal.bytes > 5 * 1024 * 1024, 'unreachable target fixture must exceed 5 MB');
    const unreachable = await client.invoke('compress_pdf', {
      inputPath: unreachablePath,
      level: 'medium',
      targetSizeMb: 5,
      outputDir
    });
    const unreachablePathOutput = String(unreachable.output_path || unreachable.outputPath || '');
    assert.equal(unreachablePathOutput, '', 'unreachable target must not publish an oversized output');
    assert.equal(unreachable.status, 'target-not-reached');
    assert.equal(Boolean(unreachable.target_reached ?? unreachable.targetReached), false);
    report.unreachableTarget = {
      targetSizeMb: 5,
      input: unreachableOriginal,
      output: null,
      smallestAttemptBytes: unreachable.candidate_size,
      targetReached: false,
      published: false
    };
    assert.deepEqual(
      (await directoryEntries(outputDir)).filter(name => name.startsWith('.toolknit-compress-')),
      [],
      'unreachable target must leave no temporary compression file'
    );

    const first = await client.invoke('compress_pdf', { inputPath, level: 'medium', outputDir });
    const second = await client.invoke('compress_pdf', { inputPath, level: 'medium', outputDir });
    const firstPath = String(first.output_path || first.outputPath);
    const secondPath = String(second.output_path || second.outputPath);
    assert.notEqual(firstPath, secondPath, 'native compression must publish unique repeated outputs');
    await access(firstPath);
    await access(secondPath);
    report.collision = { first: path.basename(firstPath), second: path.basename(secondPath), unique: true };

    const cancelInput = path.join(inputDir, 'cancel-large.pdf');
    await createTextPdf(cancelInput, 180, 4000);
    const cancelOutput = path.join(root, 'cancel-output');
    await mkdir(cancelOutput, { recursive: true });
    const cancelPromise = client.evaluate(`(async () => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke('compress_pdf', ${JSON.stringify({
          inputPath: cancelInput, level: 'high', targetSizeMb: 5, outputDir: cancelOutput
        })}) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    })()`);
    let cancelTimer;
    let settled = false;
    cancelTimer = setInterval(() => {
      if (!settled) void client.invoke('cancel_convert').catch(() => {});
    }, 25);
    const cancelResult = await cancelPromise.finally(() => {
      settled = true;
      clearInterval(cancelTimer);
    });
    assert.equal(cancelResult?.ok, false, 'native compression cancellation must reject the active operation');
    assert.match(cancelResult?.error || '', /cancelled/i);
    assert.deepEqual(await directoryEntries(cancelOutput), [], 'cancelled compression must publish no output or temp file');
    report.cancellation = { rejected: true, outputEntries: [] };
  } finally {
    client.close();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  await rm(root, { recursive: true, force: true });
  console.log(`Native PDF compression QA passed: ${path.relative(process.cwd(), reportPath)}`);
}

run().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
