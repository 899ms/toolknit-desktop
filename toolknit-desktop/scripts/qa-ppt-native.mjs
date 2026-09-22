import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { buildPptDraftPptx } from '../src/ppt-draft-core.js';

const execFileAsync = promisify(execFile);
const DEBUG_ENDPOINT = process.env.TOOLKNIT_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectRoot = path.resolve(import.meta.dirname, '..');
const qpdfPath = path.join(projectRoot, 'src-tauri', 'resources', 'qpdf', 'qpdf.exe');
const reportPath = path.resolve('tmp', 'ppt-native-report.json');

function inside(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function outlinePayload(slides = 4) {
  return {
    ready: true,
    title: 'ToolKnit native PPT regression',
    subtitle: 'LibreOffice output contract',
    audience: 'QA',
    purpose: 'Verify native conversion',
    narrative: { central_takeaway: 'Native PPT conversion preserves slide count.' },
    design: {},
    slides: Array.from({ length: slides }, (_, index) => ({
      page: index + 1,
      type: index === 0 ? 'title' : 'content',
      title: `Native slide ${index + 1}`,
      claim: `Regression slide ${index + 1}`,
      body: ['The source remains unchanged.', 'The output is published atomically.'],
      visual_suggestion: 'Text-only QA slide',
      speaker_note: 'Synthetic fixture',
      transition: 'Continue'
    }))
  };
}

async function createPptx(filePath, slides) {
  const draft = await buildPptDraftPptx(outlinePayload(slides), { theme: 'minimal-light' });
  await writeFile(filePath, draft.bytes);
}

async function inspectPdf(filePath) {
  const metadata = await stat(filePath);
  assert.ok(metadata.isFile() && metadata.size > 1000, `native PPT PDF must be non-empty: ${filePath}`);
  const bytes = await readFile(filePath);
  assert.ok(bytes.subarray(0, 5).toString('ascii') === '%PDF-', 'native output must be a PDF');
  const document = await PDFDocument.load(bytes);
  const check = await execFileAsync(qpdfPath, ['--check', '--', filePath], { windowsHide: true });
  assert.equal(check.stderr?.trim() || '', '', 'qpdf must not report PDF errors');
  return { bytes: metadata.size, pages: document.getPageCount() };
}

async function entries(directory) {
  return readdir(directory).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
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
    const target = targets.find(item => item.type === 'page' && /tauri\.localhost|localhost:1420/.test(item.url))
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
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
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

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'toolknit-ppt-native-qa-'));
  assert.ok(inside(tmpdir(), root));
  const inputPath = path.join(root, 'native-regression.pptx');
  const invalidPath = path.join(root, 'invalid.pptx');
  const outputRoot = path.join(root, 'outputs');
  await createPptx(inputPath, 4);
  await writeFile(invalidPath, Buffer.from('not a pptx fixture'));
  const client = await CdpClient.connect();
  const report = {
    endpoint: DEBUG_ENDPOINT,
    generatedAt: new Date().toISOString(),
    runtime: null,
    conversion: null,
    collision: null,
    invalidInput: null,
    cancellation: null,
    temporaryEntries: []
  };
  try {
    report.runtime = await client.invoke('get_libreoffice_runtime_status');
    assert.equal(await client.invoke('is_libreoffice_runtime_available'), true);

    const first = await client.invoke('convert_ppt_to_pdf', {
      inputPath,
      outputDir: outputRoot,
      outputName: 'native-regression'
    });
    const firstPath = String(first.outputPath || first.output_path || '');
    const firstDir = String(first.outputDir || first.output_dir || '');
    assert.ok(firstPath && firstDir && inside(outputRoot, firstDir) && inside(firstDir, firstPath));
    const firstPdf = await inspectPdf(firstPath);
    assert.equal(firstPdf.pages, 4);
    assert.equal(Number(first.pageCount || first.page_count), 4);
    const firstManifest = String(first.manifestPath || first.manifest_path || '');
    assert.ok(firstManifest && inside(firstDir, firstManifest));
    assert.ok((await stat(firstManifest)).size > 100);
    report.conversion = {
      renderer: first.renderer,
      output: firstPdf,
      outputDir: path.basename(firstDir),
      outputFile: path.basename(firstPath),
      manifest: path.basename(firstManifest),
      pageCountMatchesSlides: Boolean(first.pageCountMatchesSlides ?? first.page_count_matches_slides)
    };

    const second = await client.invoke('convert_ppt_to_pdf', {
      inputPath,
      outputDir: outputRoot,
      outputName: 'native-regression'
    });
    const secondPath = String(second.outputPath || second.output_path || '');
    const secondDir = String(second.outputDir || second.output_dir || '');
    assert.ok(inside(outputRoot, secondDir) && inside(secondDir, secondPath));
    assert.notEqual(firstDir, secondDir, 'repeated native PPT outputs must use unique directories');
    const secondPdf = await inspectPdf(secondPath);
    assert.equal(secondPdf.pages, 4);
    report.collision = {
      firstDir: path.basename(firstDir),
      secondDir: path.basename(secondDir),
      unique: true
    };

    const beforeInvalid = await entries(outputRoot);
    await assert.rejects(
      () => client.invoke('convert_ppt_to_pdf', {
        inputPath: invalidPath,
        outputDir: outputRoot,
        outputName: 'invalid'
      }),
      /ppt-render/i
    );
    const afterInvalid = await entries(outputRoot);
    assert.deepEqual(afterInvalid, beforeInvalid, 'invalid PPTX must not publish an output directory');
    report.invalidInput = { rejected: true, outputEntriesUnchanged: true };

    const cancelInput = path.join(root, 'cancel-regression.pptx');
    await createPptx(cancelInput, 30);
    const cancelState = await client.evaluate(`(() => {
      window.__qaPptCancelResult = null;
      window.__qaPptCancelDone = false;
      window.__TAURI_INTERNALS__.invoke('convert_ppt_to_pdf', ${JSON.stringify({
        inputPath: cancelInput,
        outputDir: path.join(root, 'cancel-output'),
        outputName: 'cancel-regression'
      })}).then(
        value => { window.__qaPptCancelResult = { ok: true, value }; },
        error => { window.__qaPptCancelResult = { ok: false, error: String(error) }; }
      ).finally(() => { window.__qaPptCancelDone = true; });
      return true;
    })()`);
    assert.equal(cancelState, true);
    let cancelTimer;
    cancelTimer = setInterval(() => {
      void client.invoke('cancel_convert').catch(() => {});
    }, 25);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await client.evaluate('window.__qaPptCancelDone === true')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    clearInterval(cancelTimer);
    const cancelResult = await client.evaluate('window.__qaPptCancelResult');
    assert.equal(cancelResult?.ok, false, 'active native PPT conversion must reject when cancelled');
    assert.match(cancelResult?.error || '', /cancelled/i);
    const cancelEntries = await entries(path.join(root, 'cancel-output'));
    assert.deepEqual(cancelEntries, [], 'cancelled PPT conversion must publish no output');
    report.cancellation = { rejected: true, outputEntries: cancelEntries };

    report.temporaryEntries = (await entries(outputRoot)).filter(name => name.startsWith('.toolknit-ppt-render-'));
    assert.deepEqual(report.temporaryEntries, []);
    console.log(`Native PPT conversion QA passed: ${path.relative(process.cwd(), reportPath)}`);
  } finally {
    client.close();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
