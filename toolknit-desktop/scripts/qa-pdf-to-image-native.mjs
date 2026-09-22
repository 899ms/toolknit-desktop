import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const DEBUG_ENDPOINT = process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const QA_ROOT = path.join(tmpdir(), 'toolknit-pdf-to-image-native-qa');
const OUTPUT_ROOT = path.join(QA_ROOT, 'output-root');
const OUTPUT_DIR = path.join(OUTPUT_ROOT, 'PDF_To_Image');
const CANCEL_OUTPUT_DIR = path.join(QA_ROOT, 'cancel-output');
const REPORT_PATH = path.resolve('tmp', 'pdf-to-image-native-report.json');
const PAGE_WIDTH = 120;
const PAGE_HEIGHT = 80;
const GRID_GAP = 24;

function solidPng(width, height, color) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})`;
  context.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

function pageColor(pageNumber) {
  return [
    (pageNumber * 47) % 255,
    (pageNumber * 83) % 255,
    (pageNumber * 131) % 255,
    255
  ];
}

function outputPathOf(item) {
  return String(item?.outputPath || item?.output_path || '');
}

function pageNumbersOf(item) {
  return item?.pageNumbers || item?.page_numbers || [];
}

function isPathInside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function directoryEntries(directory) {
  return readdir(directory).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
}

async function assertSessionRemoved(directory) {
  await assert.rejects(
    () => readdir(directory),
    error => error?.code === 'ENOENT',
    `PDF page session must be removed: ${directory}`
  );
}

async function assertNoTemporaryFiles(directory) {
  const entries = await directoryEntries(directory);
  const temporary = entries.filter(name => name.startsWith('.toolknit-pdf-image-'));
  assert.deepEqual(temporary, [], `temporary PDF image files remain in ${directory}`);
  return entries;
}

function assertSignature(filePath, format, bytes) {
  if (format === 'png') {
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      `PNG signature mismatch: ${filePath}`
    );
  } else if (format === 'jpg') {
    assert.equal(bytes[0], 0xff, `JPG signature mismatch: ${filePath}`);
    assert.equal(bytes[1], 0xd8, `JPG signature mismatch: ${filePath}`);
  } else {
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', `WebP RIFF signature mismatch: ${filePath}`);
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP', `WebP signature mismatch: ${filePath}`);
  }
}

async function inspectOutput(item, format, expectedDimensions) {
  const outputPath = outputPathOf(item);
  assert.ok(outputPath, 'native output must contain outputPath');
  assert.ok(isPathInside(OUTPUT_DIR, outputPath), `output escaped the configured directory: ${outputPath}`);
  const metadata = await stat(outputPath);
  assert.ok(metadata.isFile(), `native output is not a regular file: ${outputPath}`);
  assert.ok(metadata.size > 0, `native output is empty: ${outputPath}`);
  const bytes = await readFile(outputPath);
  assertSignature(outputPath, format, bytes);
  const decoded = await loadImage(outputPath);
  assert.deepEqual(
    [decoded.width, decoded.height],
    expectedDimensions,
    `native output dimensions mismatch: ${outputPath}`
  );
  return {
    fileName: path.basename(outputPath),
    bytes: metadata.size,
    width: decoded.width,
    height: decoded.height,
    pageNumbers: pageNumbersOf(item)
  };
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
    const targets = await fetch(`${DEBUG_ENDPOINT}/json/list`).then(response => {
      if (!response.ok) throw new Error(`WebView2 debug endpoint returned HTTP ${response.status}`);
      return response.json();
    });
    const target = targets.find(item => item.type === 'page' && /tauri\.localhost|localhost:1420/.test(item.url))
      || targets.find(item => item.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw new Error('ToolKnit Tauri WebView target was not found.');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot connect to the ToolKnit WebView.')), { once: true });
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
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  async invoke(command, args = {}) {
    const result = await this.evaluate(`(async () => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    })()`);
    if (!result?.ok) throw new Error(result?.error || `${command} failed`);
    return result.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(client, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function installProgressListener(client) {
  const result = await client.evaluate(`(async () => {
    const token = String(Date.now()) + '-' + String(Math.random());
    window.__qaPdfToImageProgressToken = token;
    window.__qaPdfToImageProgress = [];
    window.__qaPdfToImageProgressHandler = window.__TAURI_INTERNALS__.transformCallback(event => {
      if (window.__qaPdfToImageProgressToken === token) {
        window.__qaPdfToImageProgress.push(event.payload || event);
      }
    });
    window.__qaPdfToImageProgressEventId = await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
      event: 'pdf-to-image-progress',
      target: { kind: 'Any' },
      handler: window.__qaPdfToImageProgressHandler
    });
    return { eventId: window.__qaPdfToImageProgressEventId };
  })()`);
  assert.ok(Number.isInteger(result?.eventId), 'native PDF progress listener must register');
  return result.eventId;
}

async function uninstallProgressListener(client, eventId) {
  if (!Number.isInteger(eventId)) return;
  await client.evaluate(`(async () => {
    window.__qaPdfToImageProgressToken = null;
    try { window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener('pdf-to-image-progress', ${eventId}); } catch (_) {}
    try { window.__TAURI_INTERNALS__.unregisterCallback(window.__qaPdfToImageProgressHandler); } catch (_) {}
    try {
      await window.__TAURI_INTERNALS__.invoke('plugin:event|unlisten', {
        event: 'pdf-to-image-progress',
        eventId: ${eventId}
      });
    } catch (_) {}
    return true;
  })()`);
}

async function progressFor(client, jobId) {
  return client.evaluate(`window.__qaPdfToImageProgress.filter(event => event.jobId === ${JSON.stringify(jobId)})`);
}

async function assertCompletedProgress(client, jobId) {
  const events = await progressFor(client, jobId);
  assert.ok(events.length > 0, `no native progress events for ${jobId}`);
  const phases = new Set(events.map(event => event.phase));
  for (const phase of ['prepare', 'inspect', 'compose', 'encode', 'publish', 'complete']) {
    assert.ok(phases.has(phase), `missing ${phase} progress event for ${jobId}`);
  }
  const monotonic = events.every(
    (event, index) => index === 0 || Number(event.percent) >= Number(events[index - 1].percent)
  );
  assert.ok(monotonic, `native progress must be monotonic for ${jobId}: ${JSON.stringify(events)}`);
  assert.equal(Number(events.at(-1)?.percent), 100, `native progress must finish at 100 for ${jobId}`);
  return events;
}

function pageNumbers(count) {
  return Array.from({ length: count }, (_, index) => index + 1);
}

async function createPageSession(client, count, { width = PAGE_WIDTH, height = PAGE_HEIGHT, reuseBytes = false } = {}) {
  const session = await client.invoke('create_pdf_to_image_session');
  const sessionId = session?.sessionId || session?.session_id;
  const sessionDirectory = session?.directory;
  assert.ok(sessionId, 'native PDF page session must return sessionId');
  assert.ok(sessionDirectory, 'native PDF page session must return directory');
  const sharedBytes = reuseBytes ? solidPng(width, height, [64, 96, 128, 255]) : null;
  try {
    for (const pageNumber of pageNumbers(count)) {
      const bytes = sharedBytes || solidPng(width, height, pageColor(pageNumber));
      const written = await client.invoke('write_pdf_to_image_page_json', {
        sessionId,
        fileName: `page_${String(pageNumber).padStart(5, '0')}.png`,
        bytes: Array.from(bytes)
      });
      assert.deepEqual([written.width, written.height], [width, height]);
      assert.ok(Number(written.byteLength || written.byte_length) > 0);
    }
    return { sessionId, sessionDirectory };
  } catch (error) {
    try { await client.invoke('discard_pdf_to_image_session', { sessionId }); } catch (_) {}
    throw error;
  }
}

async function runNativeExport(client, {
  count,
  mode,
  format,
  outputName,
  jobId,
  width = PAGE_WIDTH,
  height = PAGE_HEIGHT,
  reuseBytes = false
}) {
  const session = await createPageSession(client, count, { width, height, reuseBytes });
  let completed = false;
  try {
    const result = await client.invoke('export_pdf_to_images', {
      request: {
        sessionId: session.sessionId,
        pages: pageNumbers(count),
        pageCount: count,
        outputDir: OUTPUT_DIR,
        outputName,
        format,
        mode,
        pagesPerLongImage: 5,
        jpegQuality: 92,
        backgroundRgba: '#FFFFFFFF',
        jobId
      }
    });
    completed = true;
    await assertSessionRemoved(session.sessionDirectory);
    await assertNoTemporaryFiles(OUTPUT_DIR);
    return result;
  } finally {
    if (!completed && await pathExists(session.sessionDirectory)) {
      try { await client.invoke('discard_pdf_to_image_session', { sessionId: session.sessionId }); } catch (_) {}
    }
  }
}

async function runCancellation(client) {
  const session = await createPageSession(client, 5, {
    width: 4_000,
    height: 2_500,
    reuseBytes: true
  });
  const jobId = `qa-pdf-cancel-${Date.now()}`;
  const request = {
    sessionId: session.sessionId,
    pages: pageNumbers(5),
    pageCount: 5,
    outputDir: CANCEL_OUTPUT_DIR,
    outputName: 'cancelled-horizontal',
    format: 'png',
    mode: 'long-horizontal',
    pagesPerLongImage: 5,
    jpegQuality: 92,
    backgroundRgba: '#FFFFFFFF',
    jobId
  };
  const started = await client.evaluate(`(() => {
    window.__qaPdfToImageCancelDone = false;
    window.__qaPdfToImageCancelResult = null;
    window.__TAURI_INTERNALS__.invoke('export_pdf_to_images', ${JSON.stringify({ request })}).then(
      value => { window.__qaPdfToImageCancelResult = { ok: true, value }; },
      error => { window.__qaPdfToImageCancelResult = { ok: false, error: String(error) }; }
    ).finally(() => { window.__qaPdfToImageCancelDone = true; });
    return true;
  })()`);
  assert.equal(started, true);
  try {
    await waitFor(
      client,
      `window.__qaPdfToImageProgress.some(event => event.jobId === ${JSON.stringify(jobId)} && event.phase === 'compose')`,
      30_000
    );
    await client.invoke('cancel_pdf_to_image', { jobId });
    await waitFor(client, 'window.__qaPdfToImageCancelDone === true', 30_000);
    const result = await client.evaluate('window.__qaPdfToImageCancelResult');
    assert.equal(result?.ok, false, 'active native cancellation must reject the export');
    assert.match(result?.error || '', /cancelled/i);
    await assertSessionRemoved(session.sessionDirectory);
    const entries = await directoryEntries(CANCEL_OUTPUT_DIR);
    assert.deepEqual(entries, [], 'cancelled export must publish no output or temporary file');
    return {
      jobId,
      progressPhases: [...new Set((await progressFor(client, jobId)).map(event => event.phase))],
      sessionRemoved: true,
      outputEntries: entries
    };
  } finally {
    if (await pathExists(session.sessionDirectory)) {
      try { await client.invoke('discard_pdf_to_image_session', { sessionId: session.sessionId }); } catch (_) {}
    }
  }
}

async function main() {
  await rm(QA_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(CANCEL_OUTPUT_DIR, { recursive: true });
  const client = await CdpClient.connect();
  const report = {
    endpoint: DEBUG_ENDPOINT,
    platform: process.platform,
    node: process.version,
    generatedAt: new Date().toISOString(),
    horizontal: [],
    grid: [],
    collision: null,
    cancellation: null
  };
  let progressEventId = null;
  try {
    assert.equal(await client.evaluate("typeof window.__TAURI_INTERNALS__ === 'object'"), true);
    progressEventId = await installProgressListener(client);

    for (const format of ['png', 'jpg', 'webp']) {
      const jobId = `qa-pdf-horizontal-${format}-${Date.now()}`;
      const result = await runNativeExport(client, {
        count: 6,
        mode: 'long-horizontal',
        format,
        outputName: `qa-horizontal-${format}`,
        jobId
      });
      assert.equal(result.outputCount, 2);
      assert.deepEqual(result.outputs.map(pageNumbersOf), [[1, 2, 3, 4, 5], [6]]);
      const expectedDimensions = [[PAGE_WIDTH * 5, PAGE_HEIGHT], [PAGE_WIDTH, PAGE_HEIGHT]];
      const outputs = [];
      for (let index = 0; index < result.outputs.length; index += 1) {
        outputs.push(await inspectOutput(result.outputs[index], format, expectedDimensions[index]));
      }
      await assertCompletedProgress(client, jobId);
      report.horizontal.push({ format, outputs });
      console.log(`PASS native horizontal ${format.toUpperCase()}`);
    }

    const gridCases = [
      { count: 4, rows: 2, columns: 2, format: 'png' },
      { count: 5, rows: 2, columns: 3, format: 'jpg' },
      { count: 6, rows: 2, columns: 3, format: 'webp' },
      { count: 7, rows: 3, columns: 3, format: 'png' },
      { count: 8, rows: 3, columns: 3, format: 'jpg' },
      { count: 9, rows: 3, columns: 3, format: 'webp' }
    ];
    for (const gridCase of gridCases) {
      const jobId = `qa-pdf-grid-${gridCase.count}-${gridCase.format}-${Date.now()}`;
      const result = await runNativeExport(client, {
        count: gridCase.count,
        mode: 'grid',
        format: gridCase.format,
        outputName: `qa-grid-${gridCase.count}-${gridCase.format}`,
        jobId
      });
      assert.equal(result.outputCount, 1);
      assert.deepEqual(result.outputs[0].pageNumbers || result.outputs[0].page_numbers, pageNumbers(gridCase.count));
      const expectedDimensions = [
        gridCase.columns * PAGE_WIDTH + GRID_GAP * (gridCase.columns - 1),
        gridCase.rows * PAGE_HEIGHT + GRID_GAP * (gridCase.rows - 1)
      ];
      const output = await inspectOutput(result.outputs[0], gridCase.format, expectedDimensions);
      await assertCompletedProgress(client, jobId);
      report.grid.push({
        count: gridCase.count,
        layout: `${gridCase.rows}x${gridCase.columns}`,
        format: gridCase.format,
        output
      });
      console.log(`PASS native grid ${gridCase.count} pages (${gridCase.rows}x${gridCase.columns}) ${gridCase.format.toUpperCase()}`);
    }

    const firstCollision = await runNativeExport(client, {
      count: 6,
      mode: 'long-horizontal',
      format: 'png',
      outputName: 'qa-collision-horizontal',
      jobId: `qa-pdf-collision-first-${Date.now()}`
    });
    const secondCollision = await runNativeExport(client, {
      count: 6,
      mode: 'long-horizontal',
      format: 'png',
      outputName: 'qa-collision-horizontal',
      jobId: `qa-pdf-collision-second-${Date.now()}`
    });
    const firstNames = firstCollision.outputs.map(item => path.basename(outputPathOf(item)));
    const secondNames = secondCollision.outputs.map(item => path.basename(outputPathOf(item)));
    assert.ok(firstNames.every(name => !name.includes('_1.')));
    assert.ok(secondNames.every(name => name.includes('_1.')));
    assert.equal(new Set([...firstNames, ...secondNames]).size, 4, 'collision outputs must be unique');
    for (const item of firstCollision.outputs) await inspectOutput(item, 'png', [PAGE_WIDTH * (pageNumbersOf(item).length), PAGE_HEIGHT]);
    for (const item of secondCollision.outputs) await inspectOutput(item, 'png', [PAGE_WIDTH * (pageNumbersOf(item).length), PAGE_HEIGHT]);
    report.collision = { firstNames, secondNames, noTemporaryFiles: (await assertNoTemporaryFiles(OUTPUT_DIR)).filter(name => name.startsWith('.toolknit')).length === 0 };
    console.log('PASS native collision-safe batch publication and unique naming');

    report.cancellation = await runCancellation(client);
    console.log('PASS native active cancellation and temporary/session cleanup');
  } finally {
    try { await uninstallProgressListener(client, progressEventId); } catch (_) {}
    client.close();
    await mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`Native PDF-to-image QA passed: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
